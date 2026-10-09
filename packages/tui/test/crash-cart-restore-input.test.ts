// B1 ROUND 4——CLASS 测试（r1 设计）：crash-cart restore 面绝不广告一个
// 状态无法履行的能力。测试列表由 render 广告的内容（footer
// 键 / 动作行）驱动，非由 handler——广告却未接线的键无 handler 可枚举，
// 这正是前四处缺口隐藏的方式。对每个 phase × render-state，提取
// 屏提供的 affordance，断言每个都经纯 restoreKeyAction reducer 动作；
// 并断言反向——已丢弃 affordance 的状态不再履行它。
import { describe, it, expect } from "vitest";
import { createViewState, emptySnapshot } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { demoCrashCartModel } from "../src/crash-cart/crash-cart-model.js";
import { buildRestoreLifecycleVM, type RestoreFrame } from "../src/crash-cart/restore-lifecycle.js";
import { restoreKeyAction, type RestoreInputEvent, type RestoreAction } from "../src/crash-cart/restore-input.js";

const snap = emptySnapshot();
const view = createViewState({ instanceId: "t", getSnapshot: () => snap });

function frame(over: Partial<RestoreFrame> & { rows?: number }): RestoreFrame {
  const rows = over.rows ?? 1;
  return {
    attemptId: "fleet-1",
    phase: over.phase ?? "running",
    done: over.done ?? false,
    cancelled: over.cancelled ?? false,
    verdict: over.verdict ?? "none_attempted",
    rollup: over.rollup ?? {
      counts: { fully_restored: rows, partially_restored: 0, failed: 0, not_attempted: 0 },
      sequence: Array.from({ length: rows }, (_, i) => ({ rigId: `rig${i}`, outcome: "fully_restored" })),
      attention_required: [],
    },
  };
}

// render 广告的 affordance → 必履行它的键。派生自渲染文本。
function advertised(bodyText: string): Array<{ label: string; ev: RestoreInputEvent; acts: (a: RestoreAction) => boolean }> {
  const out: Array<{ label: string; ev: RestoreInputEvent; acts: (a: RestoreAction) => boolean }> = [];
  if (/\bc 取消/.test(bodyText)) out.push({ label: "c 取消", ev: { type: "char", ch: "c" }, acts: (a) => a.kind === "cancel" || a.kind === "cancel-reattach" });
  if (/\br 重新附着/.test(bodyText)) out.push({ label: "r 重新附着", ev: { type: "char", ch: "r" }, acts: (a) => a.kind === "reattach" });
  if (/滚动/.test(bodyText)) out.push({ label: "scroll", ev: { type: "key", key: "down" }, acts: (a) => a.kind === "scroll" });
  if (/任意键关闭/.test(bodyText)) out.push({ label: "dismiss", ev: { type: "char", ch: "x" }, acts: (a) => a.kind === "dismiss" });
  return out;
}

function renderState(vm: ReturnType<typeof buildRestoreLifecycleVM>, rows = 32) {
  const screen = renderScreen(view.get(), snap, { cols: 120, rows, daemonState: "down", crashCart: demoCrashCartModel(), restore: vm, restoreScroll: 0 });
  return { screen, body: screen.lines.join("\n"), maxOffset: screen.contentMaxOffset };
}

const STATES: Array<{ name: string; vm: () => ReturnType<typeof buildRestoreLifecycleVM>; rows?: number }> = [
  { name: "running / normal", vm: () => buildRestoreLifecycleVM(frame({ phase: "running" })) },
  { name: "running / cancelled", vm: () => buildRestoreLifecycleVM(frame({ phase: "running", cancelled: true })) },
  { name: "detached / normal", vm: () => buildRestoreLifecycleVM(frame({ phase: "detached", done: false })) },
  { name: "detached / cancelled", vm: () => buildRestoreLifecycleVM(frame({ phase: "detached", done: false, cancelled: true })) },
  { name: "完成", vm: () => buildRestoreLifecycleVM(frame({ phase: "done", done: true, verdict: "all_fully_restored" })) },
  // 溢出变体——28 行，故 footer 广告滚动，动作行在折线下
  { name: "running / overflow", vm: () => buildRestoreLifecycleVM(frame({ phase: "running", rows: 28 })) },
  { name: "detached / overflow", vm: () => buildRestoreLifecycleVM(frame({ phase: "detached", done: false, rows: 28 })) },
  { name: "done / overflow", vm: () => buildRestoreLifecycleVM(frame({ phase: "done", done: true, verdict: "mixed", rows: 28 })) },
];

describe("类：屏幕在该状态宣称的每个可操作项都真的可动作", () => {
  const seen = new Set<string>();
  for (const s of STATES) {
    it(`${s.name}: each advertised affordance is honoured by the reducer`, () => {
      const vm = s.vm();
      const { body, maxOffset } = renderState(vm);
      for (const ad of advertised(body)) {
        seen.add(ad.label);
        const action = restoreKeyAction(ad.ev, { phase: vm.phase, cancelled: vm.cancelled, offset: 0, maxOffset });
        expect(ad.acts(action), `${s.name} advertises "${ad.label}" but the reducer returned ${action.kind}`).toBe(true);
      }
    });
  }
  it("矩阵非空——每种可操作类型都被某状态宣称（且兑现）", () => {
    expect([...seen].sort()).toEqual(["c 取消", "dismiss", "r 重新附着", "scroll"]);
  });
});

describe("反面：丢弃了某可操作项的状态不再兑现它 (HIGH-1)", () => {
  it("running / cancelled does NOT advertise 'c 取消' AND c does not fire a second cancel", () => {
    const vm = buildRestoreLifecycleVM(frame({ phase: "running", cancelled: true }));
    const { body } = renderState(vm);
    expect(/\bc 取消/.test(body)).toBe(false); // the render dropped it
    expect(body).toContain("已请求取消"); // and SAYS cancellation is in flight (r2 HIGH-1)
    const action = restoreKeyAction({ type: "char", ch: "c" }, { phase: "running", cancelled: true, offset: 0, maxOffset: 0 });
    expect(action.kind).toBe("none"); // c is swallowed, not a fresh cancel
  });

  it("detached / cancelled does NOT advertise 'c 取消'; c reattaches to confirm, not re-cancels", () => {
    const vm = buildRestoreLifecycleVM(frame({ phase: "detached", done: false, cancelled: true }));
    const { body } = renderState(vm);
    expect(/\bc 取消/.test(body)).toBe(false);
    expect(body).toContain("已请求取消");
    const action = restoreKeyAction({ type: "char", ch: "c" }, { phase: "detached", cancelled: true, offset: 0, maxOffset: 0 });
    expect(action.kind).toBe("reattach"); // confirm, not a second cancel-reattach
  });
});

describe("HIGH-2：宣称的滚动在 running + detached 下可达动作行", () => {
  for (const phase of ["running", "detached"] as const) {
    it(`${phase} / overflow: footer advertises scroll, the reducer scrolls, and the action row is reachable at max`, () => {
      const vm = buildRestoreLifecycleVM(frame({ phase, done: false, rows: 28 }));
      const { body, maxOffset } = renderState(vm);
      expect(/滚动/.test(body)).toBe(true); // footer advertises it
      expect(maxOffset).toBeGreaterThan(0);
      // reducer 履行广告的滚动键（input 分支，非 renderScreen(restoreScroll:max)）
      const scrolled = restoreKeyAction({ type: "key", key: "down" }, { phase, cancelled: false, offset: 0, maxOffset });
      expect(scrolled).toEqual({ kind: "scroll", offset: 1 });
      // 经 reducer 开到 max，动作行在屏上
      const atMax = renderScreen(view.get(), snap, { cols: 120, rows: 32, daemonState: "down", crashCart: demoCrashCartModel(), restore: vm, restoreScroll: maxOffset });
      const maxBody = atMax.lines.join("\n");
      if (phase === "running") expect(maxBody).toContain("c 取消");
      else expect(maxBody).toContain("r 重新附着");
    });
  }
});
