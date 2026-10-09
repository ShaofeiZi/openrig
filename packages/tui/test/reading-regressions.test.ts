import { describe, expect, it } from "vitest";
import { fieldLine, wrapDetailLines } from "../src/detail.js";
import { createViewState, emptySnapshot } from "../src/state.js";

describe("已安装 Specs 阅读回归", () => {
  it("两种宽度下把多行 YAML 摘要保持在显式终端行", () => {
    for (const width of [54, 106]) {
      const lines = wrapDetailLines([fieldLine({ label: "purpose", value: "A useful purpose.\nA second paragraph.\n" })], width);
      expect(lines.every((line) => !/[\r\n]/.test(line.text))).toBe(true);
      expect(lines.map((line) => line.text).join(" ")).toContain("A second paragraph.");
    }
  });
  it("可从快照未加载 Specs 的视图进入具名 spec", () => {
    const view = createViewState({ instanceId: "reading", getSnapshot: emptySnapshot });
    view.dispatch({ type: "jump", section: "config" });
    view.dispatch({ type: "drill", resource: "spec", name: "first-project" });
    expect(view.get()).toMatchObject({ section: "specs", drill: [{ kind: "spec", name: "first-project" }], lastError: null });
  });
});
