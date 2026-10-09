import { describe, it, expect } from "vitest";
import { runEvals } from "./helpers/eval-runner.js";
import { FakeProvider } from "./helpers/eval-provider.js";
import type { EvalCase } from "./helpers/eval-grader.js";

// slice-07 R6——runner 统计的红灯优先固定测试。面对“什么都没运行”的 stub 时这些测试失败；
// 当 runEvals 真正驱动 provider 和 grader 并统计结果后转绿。

const CASES: EvalCase[] = [
  {
    id: "s1", name: "pulls the right ref", category: "selection", prompt: "P1",
    expectedPatterns: ["rig context get\\s+core/rig-lifecycle"],
  },
  {
    id: "s2", name: "pulls the wrong ref", category: "selection", prompt: "P2",
    expectedPatterns: ["rig context get\\s+core/rig-lifecycle"],
  },
  {
    id: "l1", name: "loads before acting", category: "loading", prompt: "P3",
    expectedPatterns: ["rig context get\\s+core/watchdog"],
    order: { getPattern: "rig context get\\s+core/watchdog", actionPattern: "rig watchdog register" },
  },
];

describe("eval-runner", () => {
  it("通过 provider 和 grader 驱动每个用例，并按类别统计通过与失败", async () => {
    const provider = new FakeProvider({
      P1: "rig context get core/rig-lifecycle\nrig start",
      P2: "rig context get core/attention-queue\nrig start",
      P3: "rig context get core/watchdog\nrig watchdog register",
    });
    const s = await runEvals(CASES, provider);
    expect(s.total).toBe(3);
    expect(s.passed).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.errored).toBe(0);
    expect(s.byCategory.selection).toEqual({ total: 2, passed: 1 });
    expect(s.byCategory.loading).toEqual({ total: 1, passed: 1 });
    expect(s.outcomes).toHaveLength(3);
  });

  it("provider 无法执行时记录 error 结果，而非 graded 失败", async () => {
    const s = await runEvals(CASES, new FakeProvider({}));
    expect(s.errored).toBe(3);
    expect(s.passed).toBe(0);
    expect(s.failed).toBe(0);
  });
});
