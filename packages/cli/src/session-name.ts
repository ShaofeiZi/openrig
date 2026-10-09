// ============================================================================
// OPR.0.4.6.MH1 FR-8 —— 会话名解析契约（parity 锁定）。
//
// 规范正本：packages/daemon/src/domain/session-name.ts。CLI 与 UI 各自携带这份
// 代码块的相同副本（packages/cli/src/session-name.ts、
// packages/ui/src/lib/session-name.ts），因为各 workspace 不互相 import；
// 共享向量 parity 测试（packages/daemon/test/session-name-parity.test.ts）
// 对三份副本跑同一组向量——那里一旦出现分歧就意味着某份副本漂移了
// （hosts-registry twin 纪律；arch B2 裁决）。先改 daemon 副本，再逐字镜像。
//
// 语义（锁定在 queue-destination 门控这一原型站点）：
// - member = 第一个 "@" 之前的全部（非空）；rig = 其后的全部（非空，可再含 "@"）。
//   贪婪的 rig 是承重设计："member@rig@x" 解析为 rig "rig@x"，于是注册表查找未命中，
//   队列门控以与本契约存在之前相同的 unknown_destination_rig 错误拒绝——host
//   绝不内联在会话串里（BR-1）。
// - 人类席位引用（human@kernel / human-<x>@host）在任何解析之前先做分类；
//   凡需要区分之处，都像队列门控那样先调用 isHumanSeatSessionRef。
// - 旧版扁平 rig 名（r{NN}-后缀）仍是合法的非规范名；它们不带 rig 绑定。
// - 恰好一种结构化畸形形态（"malformed_session_name"）——任何站点都不另造。
// - parseSessionName 不做 trim，也不校验字符集（validateSessionName 负责字符）；
//   在本契约之前就先 trim 的调用方继续 trim——对每个被接受的字符串行为完全一致。
// ============================================================================

export type ParsedSessionName =
  | { kind: "canonical"; member: string; rig: string }
  | { kind: "legacy"; name: string }
  // A2 第四腿——虚拟域引用（<local>@external）。`local` 逐字取到域 "@" 为止
  //（scheme 腿 slack:U... 在词法上属于 `local`；注册态与 scheme 的切分是网关解析，
  // 绝不是分类器的事）。
  | { kind: "external"; local: string; domain: string }
  | { kind: "malformed"; error: "malformed_session_name"; input: string };

const HUMAN_SEAT_SESSION_REF_PATTERN = /^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/;
const LEGACY_FLAT_SESSION_PATTERN = /^r\d{2}-.+$/;
// A2 第四腿——封闭的虚拟域 token 集，作为命名常量放在模式旁（arch：不用内联枚举；
// 纯词法函数，无状态/IO）。未来的域词以显式枚举扩展此数组（例如 @a2a）。
// 准入（这个 @external 引用是否已注册？）不在这里——那是 A1/A4 网关的职责；
// 分类器只识别词法形态。
export const VIRTUAL_DOMAIN_TOKENS = ["external"] as const;
const VIRTUAL_DOMAIN_SESSION_REF_PATTERN = new RegExp(
  `^[A-Za-z0-9._:-]+@(${VIRTUAL_DOMAIN_TOKENS.join("|")})$`
);

/** Arch tooth 1：在需要区分人类/智能体的站点（queue-destination 门控 + 关注并集），
 *  先做人类-分类再解析。A2 拓宽了它：虚拟域引用（<local>@external）也属人类类
 *  （它们加入人类路由强制；绝不静默降级为智能体类）。准入仍在 A1/A4 网关。 */
export function isHumanSeatSessionRef(sessionRef: string): boolean {
  return HUMAN_SEAT_SESSION_REF_PATTERN.test(sessionRef) ||
    VIRTUAL_DOMAIN_SESSION_REF_PATTERN.test(sessionRef);
}

export function parseSessionName(raw: string): ParsedSessionName {
  // 优先级（arch）：human -> EXTERNAL -> canonical -> legacy -> malformed。
  // 虚拟域腿必须先于 canonical，否则 "mike@external" 会解析成 member=mike rig=external；
  // A1 的 rig 名预约使其保持无歧义。
  if (VIRTUAL_DOMAIN_SESSION_REF_PATTERN.test(raw)) {
    const domainAt = raw.lastIndexOf("@");
    return { kind: "external", local: raw.slice(0, domainAt), domain: raw.slice(domainAt + 1) };
  }
  const at = raw.indexOf("@");
  if (at > 0 && at < raw.length - 1) {
    return { kind: "canonical", member: raw.slice(0, at), rig: raw.slice(at + 1) };
  }
  if (at === -1 && LEGACY_FLAT_SESSION_PATTERN.test(raw)) {
    return { kind: "legacy", name: raw };
  }
  return { kind: "malformed", error: "malformed_session_name", input: raw };
}

/** 展示：member/local 腿——第一个 "@" 之前的文本；无 "@" 时为整串
 * （即已交付的 split("@")[0] 渲染，逐字："@rig" 得 ""）。 */
export function sessionMemberLabel(session: string): string {
  const at = session.indexOf("@");
  return at === -1 ? session : session.slice(0, at);
}

/** 路由/分组：规范名的 rig 腿，否则 undefined。 */
export function sessionRigOf(session: string): string | undefined {
  const parsed = parseSessionName(session);
  return parsed.kind === "canonical" ? parsed.rig : undefined;
}
