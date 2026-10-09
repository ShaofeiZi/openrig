import { describe, it, expect } from "vitest";
import { grade, type EvalCase } from "./helpers/eval-grader.js";
import { failReason, recordedGrade } from "./helpers/eval-report.js";
import type { CaseOutcome } from "./helpers/eval-runner.js";

// slice-07 R6 F1——RED-first 固定项：记录的评分必须解释其裁决。面对有损 stub 时这些测试会失败；
// reporter 携带 patternResults、order 和 FAIL 理由后转为 GREEN。

const LOAD: EvalCase = {
  id: "load-01", name: "loads before acting", category: "loading", prompt: "P",
  expectedPatterns: ["rig context get\\s+core/watchdog"],
  order: { getPattern: "rig context get\\s+core/watchdog", actionPattern: "rig watchdog register" },
};
const SEL: EvalCase = {
  id: "sel-01", name: "selects rig-lifecycle", category: "selection", prompt: "P",
  expectedPatterns: ["rig context get\\s+core/rig-lifecycle"],
};

function outcome(c: EvalCase, transcript: string): CaseOutcome {
  return { case: c, transcript, grade: grade(c, transcript) };
}

describe("eval-report——产物解释自身裁决", () => {
  it("failReason 指明 action-before-get 的顺序违规", () => {
    const g = grade(LOAD, "rig watchdog register\nthen rig context get core/watchdog");
    expect(g.pass).toBe(false);
    expect(failReason(g)).toMatch(/早于/i);
  });

  it("failReason 指明 action-with-no-get 的顺序违规", () => {
    const g = grade(LOAD, "rig watchdog register   # no load first");
    expect(failReason(g)).toMatch(/前未运行/i);
  });

  it("选择错误时 failReason 指明未匹配的预期模式", () => {
    const g = grade(SEL, "rig context get core/attention-queue");
    expect(failReason(g)).toMatch(/未匹配 expected/i);
  });

  it("加载失败时 recordedGrade 携带 patternResults 和顺序诊断", () => {
    const rec = recordedGrade(outcome(LOAD, "rig watchdog register\nthen rig context get core/watchdog"));
    expect(rec.pass).toBe(false);
    expect(rec.patternResults.length).toBeGreaterThan(0);
    expect(rec.order).not.toBeNull();
    expect(rec.order!.ok).toBe(false);
    expect(rec.reason).toMatch(/早于/i);
  });

  it("通过时 recordedGrade 将 reason 保持为 null，选择类结果的 order 也为 null", () => {
    const rec = recordedGrade(outcome(SEL, "rig context get core/rig-lifecycle"));
    expect(rec.pass).toBe(true);
    expect(rec.reason).toBeNull();
    expect(rec.order).toBeNull();
    expect(rec.patternResults.length).toBeGreaterThan(0);
  });
});
