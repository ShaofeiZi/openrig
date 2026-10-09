// OPR.0.4.4.15 —— P4 内部唯一共享的扇出载荷契约。
//
// 整个 P4 包只使用这一份契约（2026-07-05 架构裁定，跨 PRD 接口单元）：
// slice 15 的聚合“为你推荐”待关注信息流和 slice 21 的 `rig ps --all-hosts` 汇总
// 都使用 AggregatedPayload，即条目加按主机组织的结构化状态数组。slice 15 按两份
// PRD 约定的“先实现者定义”规则建立本模块，slice 21 直接导入。这里的任何变化都是
// 跨 PRD 契约变更，必须重新审查两个 slice，不能由实现者自行决定。

/** 每个 P3/P4 载荷中的本地主机 ID 字面量（架构钉死：只在这里定义一次，
 * 各处导入，绝不重复手写）。与 slice 11 的拓扑聚合字面量一致。 */
export const LOCAL_HOST_ID = "local";

// 51-09 增量 2 —— 后台服务持久的自身主机 ID（增量 1 的 self_host_identity），
// 与 LOCAL_HOST_ID 哨兵一起发布，并在启动时只填充一次（startup 在
// reconcileSelfHostIdentity 后调用 setSelfHostId）。这是加法变更，不触碰下方
// AggregatedPayload / PerHostStatus 跨 PRD 契约；它只暴露来源主机自己稳定且对
// 操作员有意义的身份，并与位置哨兵 "local"（“无论谁在本地”）明确区分：二者都
// 路由到本机，但令牌不同，self-id 永远不会变成 'local'。启动解析前为 null。
// 通过本共享主机契约模块的访问器，使直读路径和队列目标校验器（增量 4）都从同一
// 来源解析 self-id，无需穿透 server.ts/context。
let selfHostId: string | null = null;

/** 发布启动时解析出的自身主机 ID（startup 只调用一次）；null 用于测试重置。 */
export function setSelfHostId(id: string | null): void {
  selfHostId = id;
}

/** 启动时解析出的自身主机 ID；启动完成对账前为 null。 */
export function getSelfHostId(): string | null {
  return selfHostId;
}

// Slice 14 §2c —— ID 的来源信息，与 ID 本身一起在启动时解析一次。
//
// 刻意不按请求临时派生：它需要操作员配置的 `host.name`，而在 /healthz 处理器中
// 读取设置会把文件 I/O 放到后台服务最热路径，突破 ps+summary 突发延迟预算
// （由 ps-summary-stall-red 捕获）。其生命周期与 ID 相同：启动时设置一次，之后零成本读取。
let selfHostIdSource: string | null = null;

/** 发布启动时派生的自身主机 ID 来源（startup 只调用一次）；null 用于测试重置。 */
export function setSelfHostIdSource(source: string | null): void {
  selfHostIdSource = source;
}

/** 启动时派生的自身主机 ID 来源；启动完成对账前为 null。 */
export function getSelfHostIdSource(): string | null {
  return selfHostIdSource;
}

/**
 * 共享的自身解析约定：主机令牌是否路由到本机？令牌缺失或为空、等于
 * `LOCAL_HOST_ID` 位置哨兵、或等于后台服务解析出的自身 ID 时返回 true。
 * self-id 比较区分大小写，与增量 1 的候选值/存储值检查约定相同，使两层身份判断
 * 的大小写语义一致（仅大小写不同也视为不同令牌）。显式传入 `selfId`（默认使用
 * 启动时解析的 ID），从而保持谓词纯净且可单元测试。
 */
export function resolvesToLocalHost(
  hostToken: string | undefined | null,
  selfId: string | null = selfHostId,
): boolean {
  if (hostToken === undefined || hostToken === null || hostToken === "") return true;
  if (hostToken === LOCAL_HOST_ID) return true;
  return selfId !== null && hostToken === selfId;
}

/** 闭集枚举（架构钉 A）。`unsupported-transport` 是 R15-2 的显式类别
 * （通过 SSH 声明的主机绝不能静默变成字段更少的载荷）；`auth-failed` 与
 * `unreachable` 分离，因为操作员的修复方式不同（轮换/设置 bearer 与检查主机）。
 * 扩展此集合即构成跨 PRD 契约变更，必须重新审查 slice 15 和 21。 */
export type PerHostStatusKind = "ok" | "unreachable" | "unsupported-transport" | "auth-failed";

export interface PerHostStatus {
  hostId: string;
  status: PerHostStatusKind;
  /** 如实的失败详情，以弱化样式显示在主机标签/行旁。 */
  error?: string;
  /** 可选的加法详情（架构裁定）：传输层步骤对失败分类时使用已发布 CLI 的
   * FailedStep 词汇。该字段绝不承载关键逻辑，契约字段仍是 `status`。 */
  failedStep?: string;
}

/** 条目加逐主机状态：每个载荷的 `hosts` 都必须包含每个已订阅主机，状态为
 * ok、unreachable、auth-failed 或 unsupported-transport。缺失即违反契约；
 * 该结构可证明无遗漏，绝不全有或全无，也不静默削减。 */
export interface AggregatedPayload<T> {
  items: T[];
  hosts: PerHostStatus[];
}

/** 契约级完整性谓词（架构钉 B，测试尽可能贴近契约断言）：仅当每个预期主机 ID
 * 在载荷的 hosts 数组中恰好出现一次时为 true。 */
export function hostsCovered(payload: AggregatedPayload<unknown>, expectedHostIds: string[]): boolean {
  const seen = new Map<string, number>();
  for (const h of payload.hosts) seen.set(h.hostId, (seen.get(h.hostId) ?? 0) + 1);
  return expectedHostIds.every((id) => seen.get(id) === 1) && payload.hosts.length === expectedHostIds.length;
}
