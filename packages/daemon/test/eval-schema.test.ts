import { describe, it, expect } from "vitest";
import { validateEvalCase } from "./helpers/eval-schema.js";

// slice-07 R6——eval-case 校验器的 RED-first 固定测试。面对全量接受的 stub，拒绝用例会失败，
// 这正是预期 RED；validateEvalCase 能正确区分后进入 GREEN。

const VALID_SELECTION = {
  id: "sel-01",
  name: "selects core/rig-lifecycle for a fleet bring-back",
  category: "selection",
  prompt: "the box rebooted and everything's gone — bring the whole fleet back",
  expectedPatterns: ["rig context get\\s+core/rig-lifecycle"],
};

const VALID_LOADING = {
  id: "load-01",
  name: "pulls core/rig-lifecycle before any bring-back action",
  category: "loading",
  prompt: "the box rebooted and everything's gone — bring the whole fleet back",
  expectedPatterns: ["rig context get\\s+core/rig-lifecycle"],
  order: {
    getPattern: "rig context get\\s+core/rig-lifecycle",
    actionPattern: "rig (up|start|restore)",
  },
};

function codes(doc: unknown): string[] {
  const r = validateEvalCase(doc);
  return r.ok ? [] : r.errors.map((e) => e.code);
}

describe("eval-schema——用例校验器", () => {
  it("接受格式正确的 selection 用例", () => {
    expect(validateEvalCase(VALID_SELECTION).ok).toBe(true);
  });

  it("接受格式正确的 loading 用例", () => {
    expect(validateEvalCase(VALID_LOADING).ok).toBe(true);
  });

  it("拒绝未知 category", () => {
    expect(codes({ ...VALID_SELECTION, category: "sideways" })).toContain("UNKNOWN_CATEGORY");
  });

  it("拒绝无法编译的 expected pattern", () => {
    expect(codes({ ...VALID_SELECTION, expectedPatterns: ["rig context get ("] })).toContain(
      "PATTERN_NOT_REGEX",
    );
  });

  it("拒绝缺少 order 块的 loading 用例", () => {
    const { order: _omit, ...noOrder } = VALID_LOADING;
    expect(codes(noOrder)).toContain("ORDER_MISSING_FOR_LOADING");
  });

  it("拒绝携带 order 块的 selection 用例", () => {
    expect(codes({ ...VALID_SELECTION, order: VALID_LOADING.order })).toContain("ORDER_ON_SELECTION");
  });

  it("拒绝缺少 prompt 的用例", () => {
    const { prompt: _omit, ...noPrompt } = VALID_SELECTION;
    expect(codes(noPrompt)).toContain("PROMPT_MISSING");
  });
});
