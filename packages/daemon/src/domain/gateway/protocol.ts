// M1 A4a——gateway<->connector WIRE：通过本地 UNIX-domain socket 传输的封闭、最小 framed-JSON
// union（架构 a8343a38 / 契约 a305310d）。这不是新的互操作协议，而是内部 IPC 接缝。gateway
// 主动拨号 connector 监听的 socket；wire 只携带 OUTBOUND decision、ack 和 capability descriptor
//（M1 的 inbound 仍使用 connector 现有 platform socket）。
//
// 边界：未知 message kind 会明确拒绝；protocolVersion 只可增量扩展；OutboundDecision.op 必须在
// connector 的 CapabilityDescriptor 中声明（未声明 op 会被拒绝且绝不尝试——proof-9）；decisionId
// 是端到端幂等 key（gateway 重试会在 connector 端产生逐字节相同的重复项）。

export const GATEWAY_PROTOCOL_VERSION = 1;

export const GATEWAY_MESSAGE_KINDS = ["capability", "outbound_decision", "ack"] as const;
export type GatewayMessageKind = (typeof GATEWAY_MESSAGE_KINDS)[number];

/** connector 连接时发给 gateway：该 connector 的能力。`ops` 是封闭集合；gateway 只分派已声明 op。 */
export interface CapabilityDescriptor {
  kind: "capability";
  connectorId: string;
  platform: string;
  protocolVersion: number;
  ops: string[];
  limits?: Record<string, unknown>;
}

/** gateway 发给 connector：一条 outbound decision。`op` 必须已声明；`decisionId` 是幂等 key。 */
export interface OutboundDecision {
  kind: "outbound_decision";
  decisionId: string;
  op: string;
  entityBindingRef: string;
  payload: unknown;
}

/** connector 发给 gateway：某个 decisionId 的终态 ack（驱动 dispatch buffer 的 ack-gated 排空）。 */
export type Ack =
  | { kind: "ack"; decisionId: string; ok: true }
  | { kind: "ack"; decisionId: string; ok: false; failed: { class: string; detail?: string } };

export type GatewayMessage = CapabilityDescriptor | OutboundDecision | Ack;

export type DecodeResult =
  | { ok: true; message: GatewayMessage }
  | { ok: false; error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function nonEmptyStr(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** 解码并验证一条 framed JSON 消息。未知 kind 明确拒绝（proof-9）；对每种 kind 的必填字段做
 * 结构验证（封闭 union，不接受部分数据）。 */
export function decodeGatewayMessage(raw: string): DecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `gateway frame 不是有效 JSON：${(err as Error).message}` };
  }
  if (!isObj(parsed)) return { ok: false, error: "gateway frame 必须是 JSON 对象" };
  const kind = parsed.kind;
  if (typeof kind !== "string" || !(GATEWAY_MESSAGE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `未知 gateway message kind "${String(kind)}"——已拒绝（允许：${GATEWAY_MESSAGE_KINDS.join(", ")}）` };
  }

  if (kind === "capability") {
    if (!nonEmptyStr(parsed.connectorId)) return { ok: false, error: "capability.connectorId 必须是非空字符串" };
    if (!nonEmptyStr(parsed.platform)) return { ok: false, error: "capability.platform 必须是非空字符串" };
    if (typeof parsed.protocolVersion !== "number") return { ok: false, error: "capability.protocolVersion 必须是数字" };
    if (!Array.isArray(parsed.ops) || !parsed.ops.every((o) => nonEmptyStr(o))) return { ok: false, error: "capability.ops 必须是非空字符串数组" };
    const d: CapabilityDescriptor = { kind, connectorId: parsed.connectorId, platform: parsed.platform, protocolVersion: parsed.protocolVersion, ops: parsed.ops as string[] };
    if (parsed.limits !== undefined) { if (!isObj(parsed.limits)) return { ok: false, error: "capability.limits 存在时必须是对象" }; d.limits = parsed.limits; }
    return { ok: true, message: d };
  }
  if (kind === "outbound_decision") {
    if (!nonEmptyStr(parsed.decisionId)) return { ok: false, error: "outbound_decision.decisionId 必须是非空字符串" };
    if (!nonEmptyStr(parsed.op)) return { ok: false, error: "outbound_decision.op 必须是非空字符串" };
    if (!nonEmptyStr(parsed.entityBindingRef)) return { ok: false, error: "outbound_decision.entityBindingRef 必须是非空字符串" };
    return { ok: true, message: { kind, decisionId: parsed.decisionId, op: parsed.op, entityBindingRef: parsed.entityBindingRef, payload: parsed.payload } };
  }
  // ack。
  if (!nonEmptyStr(parsed.decisionId)) return { ok: false, error: "ack.decisionId 必须是非空字符串" };
  if (parsed.ok === true) return { ok: true, message: { kind: "ack", decisionId: parsed.decisionId, ok: true } };
  if (parsed.ok === false) {
    const failed = parsed.failed;
    if (!isObj(failed) || !nonEmptyStr(failed.class)) return { ok: false, error: "ok 为 false 时 ack.failed 必须是 { class, detail? }" };
    return { ok: true, message: { kind: "ack", decisionId: parsed.decisionId, ok: false, failed: { class: failed.class, detail: typeof failed.detail === "string" ? failed.detail : undefined } } };
  }
  return { ok: false, error: "ack.ok 必须是 boolean" };
}

/** 将消息编码为 framed JSON 行（以换行分隔）。 */
export function encodeGatewayMessage(msg: GatewayMessage): string {
  return JSON.stringify(msg) + "\n";
}

/** proof-9 守卫：OutboundDecision op 必须由 connector descriptor 声明；未声明 op 会被拒绝且绝不尝试。 */
export function isAdvertisedOp(descriptor: CapabilityDescriptor, op: string): boolean {
  return descriptor.ops.includes(op);
}
