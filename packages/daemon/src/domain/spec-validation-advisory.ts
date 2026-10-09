// OPR.0.5.3.3——spec-validation advisory：alias 形式的 model pin。
//
// 下方 CANONICAL_MODEL_PINS 是唯一 alias mapping 所在地（f7dfca0c）：此 advisory 在
// `rig spec validate` 时提示 spec author 使用 canonical id；model-divergence detector 比较前通过
// 同一 map 规范化已 pin 字符串（modelsMatch），因此运行准确 canonical model 的已知 alias pin 不再
// 错报 divergence。不要在其他位置增加第二份 mapping。
//
// 它是 advisory，绝不是 error（FAIL-OPEN）：human 已编写的 alias pin 仍可通过校验，同时保留提示——
// canonical pin 让 spec 从源头保持精确。（此模块文件名曾触发的 migration-bridge 删除契约已完成：
// bridge 已从 model-divergence-monitor.ts 删除。）

/** 经测量的 alias -> canonical model-id map（key 小写，value 为 canonical id）。它是 spec validation
 *  与 runtime detector 共用的唯一 mapping 所在地；只在测得更多 alias 形式时扩展。
 *
 *  有意使用 NULL-PROTOTYPE（r2 BLOCKING-1，f7dfca0c 第 2 轮）：pin 是任意用户字符串，普通 object
 *  上执行 map["constructor"] 或 map["__proto__"] 之类查询会返回继承的 Object.prototype member，
 *  而非 undefined——detector 会在处理中途抛错，advisory 则会伪造 canonical id。无 prototype 时，
 *  每个未测量 key 都读为 undefined，两个 consumer 的 `??`/null fallback 正常工作。扩展 map 时保留
 *  此表示；suite 已锁定 prototype 与行为。 */
export const CANONICAL_MODEL_PINS: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  { fable: "claude-fable-5" },
);

/**
 * 若 `pin` 是已知 alias 形式，返回点名 canonical id 的 advisory；否则返回 null。
 * `where` 指出 pin 在 spec 中的位置（例如 "pods.dev.members.driver"）。
 */
export function aliasModelPinAdvisory(pin: unknown, where: string): string | null {
  if (typeof pin !== "string" || pin.trim() === "") return null;
  const canonical = CANONICAL_MODEL_PINS[pin.trim().toLowerCase()];
  if (!canonical) return null;
  return `${where}：model pin "${pin}" 是 alias 形式——请 pin canonical id "${canonical}"；` +
    `5.3 建议在 source 中使用 canonical pin。runtime detector 会通过同一 map 规范化已知 alias，` +
    `但未测量的 alias 仍会报告 divergence。`;
}
