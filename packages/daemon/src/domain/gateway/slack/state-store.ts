// Slice-11 slack-connector——可跨重启保留的持久状态。
//
// 三个仅追加的 JSONL store 会写入磁盘，因此可同时跨 connector 重启和 queue daemon 重启保留
//（锁定项 2 + 项 8）：
//   - SeenStore：按 id 做投递去重；仅在副作用成功后追加一行（outbound：Slack 返回 200 后；
//                inbound：持久 qitem 存在后）。至少一次——若在成功与追加之间崩溃，下次运行会重新
//                投递字节完全一致的副本，但绝不丢失。
//   - DeadLetterStore：inbound 永不丢失的安全网。无法进入 queue 的事件会在失败路径返回前追加
//                （含尝试次数）；drain() 截断并将行交回调用方，使其重新追加再次失败的项
//                （"零丢失就是零，而不是直到第二次失败前为零"）。
//   - InboundReceiptStore：无凭据的 ingress/lifecycle 观测，在过滤前记录 received，并记录最终处置。
//
// 注入 FS 和时钟，使整体无需真实磁盘即可单元测试。
import fs from "node:fs";
import path from "node:path";

export interface StateFsOps {
  readFileSync(p: string): string; // 缺失时抛出 ENOENT，调用方按空内容处理。
  appendFileSync(p: string, data: string): void;
  writeFileSync(p: string, data: string): void;
  rename(from: string, to: string): void; // 同目录原子替换。
  mkdirp(dir: string): void;
}

export const nodeStateFs: StateFsOps = {
  readFileSync: (p) => fs.readFileSync(p, "utf8"),
  appendFileSync: (p, d) => fs.appendFileSync(p, d),
  writeFileSync: (p, d) => fs.writeFileSync(p, d),
  rename: (from, to) => fs.renameSync(from, to),
  mkdirp: (dir) => {
    fs.mkdirSync(dir, { recursive: true });
  },
};

function parseLines(raw: string): unknown[] {
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null; // 容忍追加中途崩溃造成的不完整末行。
      }
    })
    .filter((x): x is unknown => x !== null);
}

export interface SeenRecord {
  id: string;
  ts: string;
  status: string;
}

/**
 * 投递去重日志。`load()` 从磁盘读取持久集合；`mark()` 在受保护的副作用之后追加。对 id 幂等：
 * 重复 id 会在 `load()` 的 Set 中合并，调用方以 `!seen.has(id)` 控制副作用，因此同一次运行中
 * 不会重复投递。
 */
export class SeenStore {
  constructor(
    private readonly file: string,
    private readonly fsops: StateFsOps = nodeStateFs,
    private readonly now: () => Date = () => new Date(),
  ) {}

  load(): Set<string> {
    let raw: string;
    try {
      raw = this.fsops.readFileSync(this.file);
    } catch {
      return new Set();
    }
    return new Set(parseLines(raw).map((r) => (r as SeenRecord).id).filter((id) => typeof id === "string"));
  }

  /** 追加 seen 记录。必须只在受保护的副作用成功后调用。 */
  mark(id: string, status: string): void {
    this.fsops.mkdirp(path.dirname(this.file));
    this.fsops.appendFileSync(this.file, JSON.stringify({ id, ts: this.now().toISOString(), status }) + "\n");
  }

  /**
   * 将现有 id 初始化为已见，但不触发副作用
   *（锁定项 9：启用时把 backlog 初始化为历史，避免 replay 风暴）。
   */
  seed(ids: string[], status = "seeded"): number {
    if (ids.length === 0) return 0;
    this.fsops.mkdirp(path.dirname(this.file));
    const at = this.now().toISOString();
    const chunk = ids.map((id) => JSON.stringify({ id, ts: at, status })).join("\n") + "\n";
    this.fsops.appendFileSync(this.file, chunk);
    return ids.length;
  }
}

export interface DeadLetterEntry<T = unknown> {
  ev: T;
  at: string;
  attempts: number;
}

/**
 * Inbound 永不丢失安全网。每个无法落地的事件都会在错误路径返回前追加，并记录尝试次数。
 *
 * 可安全中断的重试（B2 修复）：重试不会先截断。调用方以 `readAll()` 无损读取，逐项尝试，再通过
 * 临时写入 + 原子 rename，用仍失败的项 `replaceAll()` 文件。因此持久文件始终反映未恢复集合：
 * rename 前任一点崩溃都会让原文件完整保留（至少一次；其间已落地事件重读时会被 seen-set 跳过，
 * 甚至不会重复）。不存在成功前先截断的窗口。
 */
export class DeadLetterStore<T = unknown> {
  constructor(
    private readonly file: string,
    private readonly fsops: StateFsOps = nodeStateFs,
    private readonly now: () => Date = () => new Date(),
  ) {}

  append(ev: T, attempts: number): void {
    this.fsops.mkdirp(path.dirname(this.file));
    this.fsops.appendFileSync(
      this.file,
      JSON.stringify({ ev, at: this.now().toISOString(), attempts } satisfies DeadLetterEntry<T>) + "\n",
    );
  }

  /** 无损读取全部持久项。 */
  readAll(): DeadLetterEntry<T>[] {
    let raw: string;
    try {
      raw = this.fsops.readFileSync(this.file);
    } catch {
      return [];
    }
    return parseLines(raw) as DeadLetterEntry<T>[];
  }

  /** 原子替换持久集合（临时写入 + rename），在一轮重试后使用。 */
  replaceAll(entries: DeadLetterEntry<T>[]): void {
    this.fsops.mkdirp(path.dirname(this.file));
    const body = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
    const tmp = `${this.file}.tmp`;
    this.fsops.writeFileSync(tmp, body);
    this.fsops.rename(tmp, this.file); // 原子操作：在此刻之前原文件保持完整。
  }
}

export type InboundReceiptStatus =
  | "connect-attempt"
  | "connected"
  | "disconnected"
  | "connect-failed"
  | "received"
  | "accepted"
  | "ignored"
  | "refused"
  | "dead-lettered"
  | "handler-failed";

export interface InboundReceipt {
  at: string;
  generation: number;
  status: InboundReceiptStatus;
  envelopeId?: string;
  eventTs?: string;
  channel?: string;
  reason?: string;
}

/** 无凭据的 ingress/lifecycle 台账。在 handler 过滤前追加 received receipt，随后追加最终的类型化处置。
 * 刻意不含消息 body、sender、token 或 secret 字段。 */
export class InboundReceiptStore {
  constructor(
    private readonly file: string,
    private readonly fsops: StateFsOps = nodeStateFs,
    private readonly now: () => Date = () => new Date(),
  ) {}

  append(receipt: Omit<InboundReceipt, "at">): void {
    this.fsops.mkdirp(path.dirname(this.file));
    this.fsops.appendFileSync(this.file, JSON.stringify({ at: this.now().toISOString(), ...receipt } satisfies InboundReceipt) + "\n");
  }

  readAll(): InboundReceipt[] {
    try {
      return parseLines(this.fsops.readFileSync(this.file)) as InboundReceipt[];
    } catch {
      return [];
    }
  }
}
