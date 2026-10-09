import { describe, it, expect } from "vitest";
import { grade, type EvalCase } from "./helpers/eval-grader.js";

// slice-07 R6——deterministic DOOR grader 的 RED-first pin。对 RED-first stub（无条件通过）而言，
// 下方 FAIL case 会失败，这正是预期 RED。grade() 真正具备区分能力时进入 GREEN。

const SEL: EvalCase = {
  id: "sel-01",
  name: "selects core/rig-lifecycle for a fleet bring-back",
  category: "selection",
  prompt: "the box rebooted and everything's gone — bring the whole fleet back",
  expectedPatterns: ["zrig context get\\s+core/rig-lifecycle"],
};

const LOAD: EvalCase = {
  id: "load-01",
  name: "pulls core/rig-lifecycle before any bring-back action",
  category: "loading",
  prompt: "the box rebooted and everything's gone — bring the whole fleet back",
  expectedPatterns: ["zrig context get\\s+core/rig-lifecycle"],
  order: {
    getPattern: "zrig context get\\s+core/rig-lifecycle",
    actionPattern: "zrig (up|start|restore)",
  },
};

describe("eval-grader——deterministic door", () => {
  it("拉取正确 ref 时 selection 通过", () => {
    expect(grade(SEL, "…思考中… zrig context get core/rig-lifecycle\nzrig start").pass).toBe(true);
  });

  it("拉取错误 ref 时 selection 失败", () => {
    expect(grade(SEL, "zrig context get core/attention-queue\nzrig start").pass).toBe(false);
  });

  it("出现禁止 pattern 时 selection 失败", () => {
    const c: EvalCase = { ...SEL, forbiddenPatterns: ["zrig destroy"] };
    expect(grade(c, "zrig context get core/rig-lifecycle\nzrig destroy").pass).toBe(false);
  });

  it("get 先于 action 时 loading 通过", () => {
    expect(grade(LOAD, "zrig context get core/rig-lifecycle\n…\nzrig start").pass).toBe(true);
  });

  it("action 运行前没有 get 时 loading 失败", () => {
    expect(grade(LOAD, "zrig start   # 未先加载就执行").pass).toBe(false);
  });

  it("action 先于 get 时 loading 失败", () => {
    expect(grade(LOAD, "zrig start\n随后 zrig context get core/rig-lifecycle").pass).toBe(false);
  });
});
