import { describe, expect, it } from "vitest";
import { fieldLine, wrapDetailLines } from "../src/detail.js";
import { createViewState, emptySnapshot } from "../src/state.js";

describe("installed Specs reading regressions", () => {
  it("keeps multiline YAML summaries in explicit terminal rows at both widths", () => {
    for (const width of [54, 106]) {
      const lines = wrapDetailLines([fieldLine({ label: "purpose", value: "A useful purpose.\nA second paragraph.\n" })], width);
      expect(lines.every((line) => !/[\r\n]/.test(line.text))).toBe(true);
      expect(lines.map((line) => line.text).join(" ")).toContain("A second paragraph.");
    }
  });
  it("can enter a named spec from a view whose snapshot did not load Specs", () => {
    const view = createViewState({ instanceId: "reading", getSnapshot: emptySnapshot });
    view.dispatch({ type: "jump", section: "config" });
    view.dispatch({ type: "drill", resource: "spec", name: "first-project" });
    expect(view.get()).toMatchObject({ section: "specs", drill: [{ kind: "spec", name: "first-project" }], lastError: null });
  });
});
