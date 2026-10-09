// M1 A4a——网关侧投递缓冲区：持久保存 OutboundDecision，直到连接器确认（契约 a305310d）。
// 正因如此，“连接器中断 -> 不丢失 -> 确认后排空”才可证明（proof-9）。它与连接器侧
// slice-11 投递台账（SeenStore/DeadLetterStore）是两个不同的存储，绝不能合并；
// 混为一谈会重新引入架构裁决指出的漂移类别。
//
// 持久性采用 slice-11 原子模式（写同级临时文件后重命名）：决定先持久化再投递，
// 仅在收到 Ack 后删除。decisionId 是幂等键——重新投递未确认决定会产生字节一致的副本。

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getOpenRigHome } from "../../openrig-compat.js";
import type { OutboundDecision } from "./protocol.js";

export function dispatchBufferPath(home: string = getOpenRigHome()): string {
  return join(home, "gateway", "dispatch-buffer.json");
}

interface BufferState {
  pending: OutboundDecision[];
}

function readState(path: string): BufferState {
  if (!existsSync(path)) return { pending: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BufferState>;
    return { pending: Array.isArray(raw.pending) ? raw.pending : [] };
  } catch {
    // 损坏的缓冲区以空集合失败关闭而不抛错——不可读缓冲区不能卡死网关；
    // 未确认决定只会在文件本身损坏（独立的持久性事故）时丢失，正常读取绝不静默丢弃。
    return { pending: [] };
  }
}

function writeState(path: string, state: BufferState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 0), { mode: 0o600 });
  renameSync(tmp, path);
}

/** 持久网关投递缓冲区。可跨重启：`pending()` 从磁盘读取。
 *  按 decisionId 幂等——同一 decisionId 入队两次仍只保留一条记录。 */
export class DispatchBuffer {
  private readonly path: string;
  constructor(home: string = getOpenRigHome()) {
    this.path = dispatchBufferPath(home);
  }

  /** 在投递前持久化决定（持久优先），按 decisionId 幂等。 */
  enqueue(decision: OutboundDecision): void {
    const state = readState(this.path);
    if (state.pending.some((d) => d.decisionId === decision.decisionId)) return; // 已持久化
    state.pending.push(decision);
    writeState(this.path, state);
  }

  /** Ack 门控排空：仅在连接器确认后移除决定。 */
  ack(decisionId: string): void {
    const state = readState(this.path);
    const next = state.pending.filter((d) => d.decisionId !== decisionId);
    if (next.length !== state.pending.length) writeState(this.path, { pending: next });
  }

  /** 尚未确认、可跨重启的决定——恢复时由重新投递重放。 */
  pending(): OutboundDecision[] {
    return readState(this.path).pending;
  }
}
