// B1 ROUND 4（HIGH-2）——恢复视图的滚动输入逻辑，纯逻辑且与阶段无关。故障诊断
// shell 在恢复内容溢出视口时，在每个阶段都宣传"↑↓ 滚动"；这是使该可用性
// 变为现实的逻辑（宣传但未接线的可用性正是缺陷类别 5.2 所指）。main.ts 在
// 阶段特定按键之前调用它，因此运行中/已分离/已完成都可滚动——在大规模舰队上
// 到达折叠线下方的生命周期动作行（取消/重新附着）。

/** 已解析的滚动意图，或当事件不是滚动键时为 null。 */
export type ScrollKey = "up" | "down" | null;

/** 将输入事件映射到滚动意图：↑/↓ 箭头和 k/j（vim）。其他 → null。 */
export function scrollKeyOf(ev: { type: string; key?: string; ch?: string }): ScrollKey {
  if (ev.type === "key" && (ev.key === "up" || ev.key === "down")) return ev.key === "up" ? "up" : "down";
  if (ev.type === "char" && ev.ch === "k") return "up";
  if (ev.type === "char" && ev.ch === "j") return "down";
  return null;
}

export function clampScroll(offset: number, maxOffset: number): number {
  return Math.max(0, Math.min(Math.max(0, maxOffset), offset));
}

/** 滚动键的下一个滚动偏移，钳制在 [0, maxOffset]；当 `key` 不是滚动键时为 null
 * （因此调用方落入阶段特定按键）。设计上与阶段无关——相同的滚动在运行中、已分离和已完成状态下工作。 */
export function nextScrollOffset(key: ScrollKey, offset: number, maxOffset: number): number | null {
  if (key === null) return null;
  return clampScroll(offset + (key === "down" ? 1 : -1), maxOffset);
}
