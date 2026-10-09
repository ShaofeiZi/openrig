// OPR.0.4.3.16——集中式队列 gate predicate。
//
// 约定见 conventions/queue-gate-predicate/README.md（由 pm-lead 于 2026-07-03 冻结）。
// 这是判断队列 qitem 是否属于“gate work”的唯一配置点：特定角色必须处理并解除的审查/审批步骤，
// 也可能因此停滞。消费者（idle-gate watchdog policy）从这里读取 predicate，绝不分散执行 tag 检查，
// 也不解析 qitem body（slice-16 PRD Business Rule 4）。
//
// Predicate：qitem 携带任意 `gate:<role>` tag。次级 fallback：tier === `human-gate` 会映射到
// `gate:human` 角色，从而让 predicate 包含旧版 human-gate tier；但仅靠它不足以捕获 guard /
// 规格评审目标。

/** 标记 gate work 的 tag namespace。 */
export const GATE_TAG_PREFIX = "gate:";

/**
 * 已知 gate 角色，仅用于说明和文档。predicate 接受任意 `gate:<role>`，
 * 因此新增 gate holder 角色无需修改代码。
 */
export const GATE_ROLES = [
  "guard",
  "spec-review",
  "pm-lead",
  "review-r1",
  "review-r2",
  "qa",
  "human",
] as const;
export type GateRole = (typeof GATE_ROLES)[number];

/** 映射到 `gate:human` 角色的人工审批 tier（fallback）。 */
export const HUMAN_GATE_TIER = "human-gate";

/** `tag` 是格式正确的 `gate:<role>` tag 时返回 true。 */
export function isGateTag(tag: string): boolean {
  return tag.startsWith(GATE_TAG_PREFIX) && tag.length > GATE_TAG_PREFIX.length;
}

/** qitem tag 声明的 gate 角色；保持原顺序并去重。 */
export function gateRolesOf(tags: readonly string[] | null | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const roles: string[] = [];
  for (const t of tags) {
    if (isGateTag(t)) {
      const role = t.slice(GATE_TAG_PREFIX.length);
      if (!seen.has(role)) {
        seen.add(role);
        roles.push(role);
      }
    }
  }
  return roles;
}

export interface GatePredicateInput {
  tags: readonly string[] | null | undefined;
  tier?: string | null;
}

/**
 * 判断此 qitem 是否属于 gate work 的唯一 predicate。
 * 主判据：存在任意 `gate:<role>` tag。次级 fallback：tier === `human-gate`。
 */
export function qitemIsGated(input: GatePredicateInput): boolean {
  if (gateRolesOf(input.tags).length > 0) return true;
  if (input.tier === HUMAN_GATE_TIER) return true; // → gate:human
  return false;
}

/**
 * qitem 的有效 gate 角色；其中 human-gate tier fallback 以 `human` 角色呈现。
 * 当且仅当 qitem 不属于 gate work 时返回空数组。
 */
export function effectiveGateRoles(input: GatePredicateInput): string[] {
  const roles = gateRolesOf(input.tags);
  if (input.tier === HUMAN_GATE_TIER && !roles.includes("human")) roles.push("human");
  return roles;
}
