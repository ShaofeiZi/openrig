// M1 A4b——@external 实体准入。已封存的契约 2a57d099：根据人员注册表（A3）解析
// <local>@external 目标。归属位置为后台服务 gateway-path（topologyValidateRig / 4b，队列侧）
// 与 A4 gateway（连接器侧），见架构裁定 8cd30094。本模块是解析器；后台服务侧注册表读取器
//（加载投影实体）与 gateway 接线使用它。
//
// 四种裁定结果（绝不静默，也绝不降级为 agent 类别）：
//   registered   mike@external            -> 找到实体（偏好在下游应用）
//   scheme        slack:U012AB3CD@external -> 一次性地址（绝不是注册表条目；
//                                            由连接器 #1 直接投递）
//   unregistered  stranger@external        -> 明确的结构化引导拒绝
//   （未解析且无目标的入站消息）             -> 默认人员席位 human-operator@kernel
//
// proof-2 同时捕获两种拒绝文本：域级回退（不在闭集中的 token 从 A1/A2 落入
// unknown_destination_rig），以及这里的实体级引导拒绝（@external 域有效但实体不存在）。

// 默认人员操作员身份从 human-registry 的规范归属位置重新导出（单一来源，不重复定义）。
// concept-1/concept-2 的说明见该处。
export { OPERATOR_HUMAN_DEFAULT_SLOT } from "./human-registry.js";

/** 注册人员为准入提供的身份（A3 片段的投影；解析器准入时只需要 key 与 address）。 */
export interface RegisteredEntity {
  entityId: string;
  address: string; // <entityId>@external
}

export type ExternalResolution =
  | { kind: "registered"; entityId: string }
  | { kind: "scheme"; scheme: string; handle: string }
  | { kind: "unregistered"; local: string; error: string };


/** 根据注册实体解析 `<local>@external` 引用中的 `local` 部分。
 * scheme 形式（`local` 包含 ':'）是字面 scheme 模式，即一次性地址，绝不查询注册表。
 * 否则进入注册模式，`local` 即 entityId。实体缺失时返回明确的结构化引导拒绝，
 * 绝不静默或降级为 agent 类别。 */
export function resolveExternal(local: string, entities: readonly RegisteredEntity[]): ExternalResolution {
  const colon = local.indexOf(":");
  if (colon > 0 && colon < local.length - 1) {
    return { kind: "scheme", scheme: local.slice(0, colon), handle: local.slice(colon + 1) };
  }
  const found = entities.find((e) => e.entityId === local);
  if (found) return { kind: "registered", entityId: found.entityId };
  return {
    kind: "unregistered",
    local,
    error:
      `'${local}@external' names no registered human (no gateway/humans/${local}.yaml fragment). ` +
      `Register the human first: rig gateway human add ${local} --display-name … --binding … --delivery-class …; ` +
      `or address a human that is already registered. ` +
      `(This is a virtual-domain reference — it was NOT downgraded to an agent seat.)`,
  };
}
