// B1 ROUND 4——恢复视图的按键处理，作为纯 reducer，使屏幕宣传的操作者可用性
// 可以被驱动和断言（r1：从 UI 宣传的内容驱动测试矩阵，而非从处理器——
// 宣传但未接线的键没有处理器可枚举）。main.ts 是此 reducer 上的薄执行器。
// 此关闭的规则：屏幕在某状态下提供的每个可用性必须在该状态下起作用，
// 且屏幕绝不能提供状态无法兑现的可用性。
import { scrollKeyOf, nextScrollOffset } from "./restore-scroll.js";

export interface RestoreInputEvent {
  type: string;
  ch?: string;
  key?: string;
}

export interface RestoreInputContext {
  phase: "running" | "detached" | "done";
  cancelled: boolean;
  offset: number;
  maxOffset: number;
}

export type RestoreAction =
  | { kind: "quit" }
  | { kind: "scroll"; offset: number }
  | { kind: "cancel" }
  | { kind: "reattach" }
  | { kind: "cancel-reattach" }
  | { kind: "dismiss" }
  | { kind: "none" }; // 吞掉（运行中在舰队恢复时忽略杂散键）

/** 在恢复阶段将一个键解析为动作。顺序：退出，然后滚动（内容溢出时在每个阶段宣传——
 *  因此必须在每个阶段起作用），然后阶段特定的生命周期键。
 *  已请求的取消不再提供（一旦 `cancelled`，渲染丢弃 `c cancel`）。 */
export function restoreKeyAction(ev: RestoreInputEvent, ctx: RestoreInputContext): RestoreAction {
  if (ev.type === "char" && ev.ch === "q") return { kind: "quit" };

  const sk = scrollKeyOf(ev);
  if (sk) {
    const next = nextScrollOffset(sk, ctx.offset, ctx.maxOffset);
    return next === null ? { kind: "none" } : { kind: "scroll", offset: next };
  }

  if (ctx.phase === "running") {
    // c 仅在实际可提供时取消（尚未请求）；其他键被吞掉
    // （舰队正在恢复——避免意外关闭）。
    if (ev.type === "char" && ev.ch === "c" && !ctx.cancelled) return { kind: "cancel" };
    return { kind: "none" };
  }

  if (ctx.phase === "detached") {
    if (ev.type === "char" && ev.ch === "r") return { kind: "reattach" };
    // c：如果尚未请求，取消 + 重新附着（可观察）；如果已请求，渲染不再提供
    // `c cancel`，因此 c 仅重新附着以确认。
    if (ev.type === "char" && ev.ch === "c") return ctx.cancelled ? { kind: "reattach" } : { kind: "cancel-reattach" };
    return { kind: "dismiss" };
  }

  // done：诊断列表可滚动（上面已处理）；其他任何键关闭。
  return { kind: "dismiss" };
}
