// OPR.0.6.0.8——rig 详情提供一个动作，把整个 rig 作为 terminal 窗格打开，且
// command bar 有 `terminal <view>`。两者都产出既有的 open-terminal 动作。
import { describe, expect, it } from "vitest";
import { createViewState, computeExplorerRows } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { decodeInput, resolveKeyAction } from "../src/input.js";
import { demoSnapshot } from "../src/demo-data.js";
import { COMMAND_REGISTRY } from "../src/commands/registry.js";
import type { Action } from "../src/types.js";
import { strWidth } from "../src/text-width.js";

const snap = demoSnapshot();
const RIG = "openrig-build";
const RIG_ACT: Action = { type: "act", act: "open-terminal", view: `rig:${RIG}` };
const KEYS = { right: "\x1b[C", down: "\x1b[B", up: "\x1b[A", enter: "\r" } as const;

function drilled() {
  const v = createViewState({ instanceId: "t", getSnapshot: () => snap });
  v.dispatch(parseCommand(`rig ${RIG}`));
  return v;
}

describe("rig 详情——term ▸ rig 链接", () => {
  for (const size of [{ cols: 140, rows: 32 }, { cols: 60, rows: 20 }]) {
    it(`${size.cols}x${size.rows}: shown on the default tab, reachable by keys, and Enter opens the rig view`, () => {
      const v = drilled();
      expect(v.get().viewTab).toBe("table");
      const draw = () => { const sc = renderScreen(v.get(), snap, size); v.dispatch({ type: "layout", contentMaxOffset: sc.contentMaxOffset, contentTargetCount: sc.contentTargets.length }); return sc; };
      const resolve = (k: keyof typeof KEYS) => { const sc = draw(); return resolveKeyAction(decodeInput(KEYS[k])[0]!, v.get(), sc, computeExplorerRows(v.get(), snap).length); };
      const key = (k: keyof typeof KEYS) => { const a = resolve(k); if (a) v.dispatch(a); };
      const first = draw();
      // 窄窗格用 "…" 截断行而非换行；链接本身仍是目标。
      expect(first.lines.some((l) => l.includes(size.cols >= 100 ? `终端 ▸ 工作组 ${RIG}` : "终端 ▸ 工作组"))).toBe(true);
      for (const row of first.lines) expect(strWidth(row)).toBeLessThanOrEqual(size.cols);
      key("right");
      let enter: Action | null = null;
      for (let i = 0; i < 60 && !enter; i++) {
        const sc = draw();
        const ix = sc.contentTargets.findIndex((t) => t.action?.type === "act" && (t.action as { view?: string }).view === `rig:${RIG}`);
        if (ix >= 0) {
          for (let z = 0; z < 12 && v.get().contentSelection !== ix; z++) key(v.get().contentSelection > ix ? "up" : "down");
          if (v.get().contentSelection === ix) enter = resolve("enter");
          break;
        }
        key("down");
      }
      expect(enter).toEqual(RIG_ACT);
    });
  }

  it("点链接给出相同 act；pod term ▸ 链接仍开其 pod", () => {
    const v = drilled();
    const sc = renderScreen(v.get(), snap, { cols: 140, rows: 32 });
    const y = sc.lines.findIndex((l) => l.includes(`终端 ▸ 工作组 ${RIG}`)) + 1;
    const rigHits = sc.hitMap.filter((h) => h.y === y && h.action?.type === "act");
    expect(rigHits.map((h) => h.action)).toContainEqual(RIG_ACT);
    const podActs = sc.hitMap.filter((h) => h.action?.type === "act" && (h.action as { view?: string }).view?.startsWith(`pod:${RIG}/`));
    expect(podActs.length).toBeGreaterThan(0);
  });
});

describe("命令栏——terminal <view>", () => {
  it("为 typed 视图构建 open-terminal act", () => {
    expect(parseCommand(`terminal rig:${RIG}`)).toEqual(RIG_ACT);
    expect(parseCommand("terminal saved:watch")).toEqual({ type: "act", act: "open-terminal", view: "saved:watch" });
  });

  it("无视图时拒绝，并从快照补全 rig 视图", () => {
    expect(parseCommand("terminal")).toMatchObject({ type: "error" });
    const entry = COMMAND_REGISTRY.find((c) => c.name === "terminal")!;
    expect(entry.complete!({ snapshot: snap } as never)).toContain(`rig:${RIG}`);
  });

  it("不替换被动 terminal-preview 动词", () => {
    expect(parseCommand(`terminal-preview rig:${RIG}`)).toEqual({ type: "terminal-preview", view: `rig:${RIG}` });
  });
});
