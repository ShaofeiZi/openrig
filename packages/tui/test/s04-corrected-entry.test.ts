import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../src/demo-data.js";
import { createInputDecoder, resolveEscapeAction } from "../src/input.js";
import { createViewState, defaultSections } from "../src/state.js";
import { scopesExplorerRows } from "../src/scopes/scopes-model.js";

describe("founder 修正的 Slice 4 入口", () => {
  it("无独立执行区段，从 scopes 任务行打开执行", () => {
    expect(defaultSections().map((section) => section.name)).not.toContain("execution");
    const mission = demoSnapshot().scopes![0]!.mission;
    const row = scopesExplorerRows(demoSnapshot().scopes, new Set(), "").find((item) => item.key === `scopes-mission:${mission}`)!;
    expect(row.action).toEqual({ type: "scopes-mission-open", mission });
  });

  it("裸 Escape 从富 slice 详情返回所选任务概览", () => {
    const snap = demoSnapshot();
    const mission = snap.scopes![0]!.mission;
    const slice = snap.scopes![0]!.slices[0]!.dirName;
    const view = createViewState({ instanceId: "s04-escape", getSnapshot: () => snap });
    view.dispatch({ type: "scopes-mission-open", mission });
    view.dispatch({ type: "scopes-open", mission, slice });

    const decoder = createInputDecoder();
    expect(decoder.write("\x1b")).toEqual([]);
    const [escape] = decoder.flush();
    expect(escape).toEqual({ type: "key", key: "escape" });

    const action = resolveEscapeAction(escape!, view.get());
    expect(action).toEqual({ type: "back" });
    view.dispatch(action!);
    expect(view.get().scopesSelected).toBeNull();
    expect(view.get().scopesMission).toBe(mission);
  });
});
