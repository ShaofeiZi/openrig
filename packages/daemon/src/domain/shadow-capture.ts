import type Database from "better-sqlite3";
import type { NodeInventoryEntry } from "./types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { CaptureObserver, type Observation } from "./capture-observer.js";

export interface ShadowConfig { destination: string; maxRecords: number; maxBytes: number; capacity: number; maxQueuedBytes: number; maxObservationBytes: number }
export interface ShadowWriter { append(bytes: string): Promise<void>; close(): Promise<void> }
// 独占创建，且 parent 必须私有、规范：绝不追加到或覆盖已保留 evidence。
async function privateWriter(destination: string): Promise<ShadowWriter> {
  const parent = path.dirname(destination), actual = await fs.realpath(parent), stat = await fs.stat(parent);
  if (actual !== parent || !stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw Error("shadow parent 必须是规范路径、仅 owner 可访问，并由当前进程拥有");
  const file = await fs.open(destination, "wx", 0o600);
  return {append: async text => { await file.writeFile(text); }, close: () => file.close()};
}

export class ShadowCapture {
  readonly observer: CaptureObserver;
  private writer?: ShadowWriter;
  private written = 0;
  private bytes = 0;
  private completedRecords = 0;
  private completedBytes = 0;
  private dropped = 0;
  private sinkErrors = 0;
  private error: string | null = null;
  private stopped = false;
  private collecting = true;
  private activeDrain?: Promise<number>;
  private stopping?: Promise<ReturnType<ShadowCapture["status"]>>;
  constructor(readonly config: ShadowConfig, private readonly open: (destination: string) => Promise<ShadowWriter> = privateWriter) {
    this.observer = new CaptureObserver(config);
  }
  async drain() {
    if (this.activeDrain) return this.status();
    this.activeDrain = this.observer.drain(async batch => {
      for (let i = 0; i < batch.length; i++) {
        const row: Observation = batch[i]!;
        const text = JSON.stringify(row) + "\n", size = Buffer.byteLength(text);
        if (this.stopped || this.written >= this.config.maxRecords || this.bytes + size > this.config.maxBytes) {
          this.stopped = true; this.dropped++;
          continue;
        }
        try {
          this.writer ??= await this.open(this.config.destination);
          // I/O 前预留：部分/失败写入绝不允许 replay 或复用预算。
          this.written++; this.bytes += size;
          await this.writer.append(text);
          this.completedRecords++; this.completedBytes += size;
        } catch (error) {
          this.sinkErrors++; this.error = error instanceof Error ? error.message : "sink 写入失败";
          this.stopped = true; this.dropped += batch.length - i;
          try { await this.writer?.close(); } catch { /* 保留原始 sink 错误。 */ }
          this.writer = undefined;
          throw error;
        }
      }
      if (this.stopped || this.written >= this.config.maxRecords || this.bytes >= this.config.maxBytes) {
        this.stopped = true;
        try { await this.writer?.close(); }
        catch (error) { this.sinkErrors++; this.error = error instanceof Error ? error.message : "sink 关闭失败"; }
        this.writer = undefined;
      }
    }, 64);
    try { await this.activeDrain; } finally { this.activeDrain = undefined; }
    return this.status();
  }
  /** 立即禁用，随后在关闭前处理完有限的 retained queue。 */
  stop() {
    this.collecting = false;
    this.observer.stopRecording();
    return this.stopping ??= (async () => {
      await this.activeDrain;
      while (this.observer.stats().queued > 0) await this.drain();
      this.stopped = true;
      try { await this.writer?.close(); }
      catch { this.sinkErrors++; this.error = "sink 关闭失败"; }
      this.writer = undefined;
      return this.status();
    })();
  }
  status() {
    return {enabled: this.collecting && !this.stopped, config: this.config, observer: this.observer.stats(),
      sink: {reservedRecords: this.written, reservedBytes: this.bytes, completedRecords: this.completedRecords, completedBytes: this.completedBytes, dropped: this.dropped, errors: this.sinkErrors, stopped: this.stopped, error: this.error}};
  }
}

/** 仅 source opt-in。配置缺失/无效时绝不创建 sink 或收集 byte。 */
export function configureShadowCapture(raw: string | undefined): {capture?: ShadowCapture; error?: string} {
  if (!raw) return {};
  try {
    const c = JSON.parse(raw) as ShadowConfig;
    if (typeof c.destination !== "string" || !path.isAbsolute(c.destination) || path.normalize(c.destination) !== c.destination) throw Error("必须显式提供绝对且私有的 destination");
    for (const [key, max] of [["maxRecords",100000],["maxBytes",1024*1024*1024],["capacity",1000],["maxQueuedBytes",8*1024*1024],["maxObservationBytes",1024*1024]] as const) {
      if (!Number.isSafeInteger(c[key]) || c[key] < 1 || c[key] > max) throw Error(`无效的有限值 ${key}`);
    }
    return {capture: new ShadowCapture(Object.freeze({...c}))};
  } catch (error) { return {error: error instanceof Error ? error.message : "shadow 配置无效"}; }
}

/** Inventory 有自己的 probe 路径。在该 probe await 前同步解析 label。 */
export function inventoryCaptureOptions(db: Database.Database, capture?: ShadowCapture) {
  if (!capture) return {};
  return { captureObserver: capture.observer, observationBinding: (entry: NodeInventoryEntry) => {
    try {
      const row = db.prepare(`SELECT b.tmux_pane AS pane, o.generation_uuid AS occupant
        FROM bindings b LEFT JOIN occupant_tenures o ON o.node_id=b.node_id
        AND o.generation_ordinal=(SELECT MAX(generation_ordinal) FROM occupant_tenures WHERE node_id=b.node_id)
        WHERE b.node_id=? AND b.tmux_session=? LIMIT 2`).all(entry.nodeId, entry.canonicalSessionName) as {pane: string | null; occupant: string | null}[];
      return {nodeId: entry.nodeId, pane: row.length === 1 ? row[0]!.pane : null, occupant: row.length === 1 ? row[0]!.occupant : null};
    } catch { return {nodeId: entry.nodeId, pane: null, occupant: null}; }
  }};
}
