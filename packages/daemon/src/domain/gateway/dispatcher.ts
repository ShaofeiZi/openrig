// M1 A4a——gateway MODULE 的核心逻辑（操作系统进程的大脑）。传输层通过注入提供，因此无需
// 真实 socket 也能单测。轻量 spawn 包装器和 unix-socket transport 将其接到 connector；这里
// 实现契约 a305310d 裁定的行为：
//   - handshake：收到 CapabilityDescriptor 之前拒绝 dispatch。
//   - dispatch：op 必须已声明（proof-9：未声明就拒绝，绝不尝试）；durable-FIRST，即先进入
//     dispatch buffer，再发送。
//   - ack：收到确认后才从 buffer 移除 decision。
//   - replayPending：连接或重连时重发每个未 Ack 的 decision；connector 中断也不丢失。
//     decisionId 保证重发内容逐字节相同，不会生成第二条记录。

import { randomUUID } from "node:crypto";
import type { DispatchBuffer } from "./dispatch-buffer.js";
import { isAdvertisedOp, type CapabilityDescriptor, type OutboundDecision } from "./protocol.js";

export interface DispatcherDeps {
  buffer: DispatchBuffer;
  /** 传输写入：生产中为带帧的 unix-socket send，测试中为内存 sink。 */
  send: (decision: OutboundDecision) => void;
  /** 可注入的 id 来源：测试固定 decisionId，生产使用 UUID。 */
  newDecisionId?: () => string;
}

export type DispatchResult =
  | { ok: true; decisionId: string }
  | { ok: false; error: string };

export class GatewayDispatcher {
  private descriptor: CapabilityDescriptor | undefined;
  constructor(private readonly deps: DispatcherDeps) {}

  /** Handshake——记录 connector 声明的能力。 */
  onCapability(descriptor: CapabilityDescriptor): void {
    this.descriptor = descriptor;
  }

  get connectorId(): string | undefined {
    return this.descriptor?.connectorId;
  }

  /** 派发 outbound decision。proof-9：handshake 前或 op 未声明时必须拒绝，绝不尝试。
   *  Durable-first：传输发送前先持久化到 buffer。 */
  dispatch(op: string, entityBindingRef: string, payload: unknown, opts?: { decisionId?: string }): DispatchResult {
    if (!this.descriptor) {
      return { ok: false, error: "拒绝分派：尚无能力描述符（握手未完成）" };
    }
    if (!isAdvertisedOp(this.descriptor, op)) {
      return { ok: false, error: `拒绝分派：连接器 ${this.descriptor.connectorId} 未声明操作 "${op}"（未声明操作会被拒绝，不会尝试）` };
    }
    // OPR.0.5.6.1（dual-rebind 修复）：调用方提供的 DURABLE EPISODE-STABLE decision id
    // 让 redrive 端到端幂等。重放 pending decision 与重新 dispatch 会收敛到同一 identity：
    // buffer 只接受一次，delivery 层的 delivered-store 只重新 ack，不会重新 post。
    const decisionId = opts?.decisionId ?? (this.deps.newDecisionId ?? randomUUID)();
    if (opts?.decisionId && this.deps.buffer.pending().some((d) => d.decisionId === decisionId)) {
      return { ok: true, decisionId }; // 幂等接受：已持久入队，由 replay 负责 redrive。
    }
    const decision: OutboundDecision = { kind: "outbound_decision", decisionId, op, entityBindingRef, payload };
    this.deps.buffer.enqueue(decision); // dispatch 前先持久化。
    this.deps.send(decision);
    return { ok: true, decisionId };
  }

  /** connector Ack decision 后，将其从持久 buffer 移除。 */
  onAck(decisionId: string): void {
    this.deps.buffer.ack(decisionId);
  }

  /** 连接或重连时重发每个未 Ack 的 decision，确保 connector 中断期间不丢失。 */
  replayPending(): void {
    for (const decision of this.deps.buffer.pending()) this.deps.send(decision);
  }
}
