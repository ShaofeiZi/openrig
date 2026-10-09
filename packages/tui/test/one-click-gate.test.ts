import { describe, it, expect } from "vitest";
import { restoreConfirmMessage } from "../src/crash-cart/one-click-gate.js";
import { evaluateOneClickGate } from "../src/crash-cart/one-click-gate.js";

// Crash-cart C3——一键规则（founder，⏎ 上绑定）：⏎ 为一键当且仅当 plan 是
// 零代际（每席 resume-original）。daemon 前对 C2 读的代理：当 resumableCount == seatCount 时 rig 完全
// 可恢复。若任一 rig 有不可恢复席，⏎ 必须导向
// 确认屏并指明这些差异——绝不为静默的 resume→fresh 降级。

const rig = (rigName: string, seatCount: number, resumableCount: number) => ({ rigName, seatCount, resumableCount });

describe("evaluateOneClickGate——基于 C2 discovery 的零代代理", () => {
  it("每个 rig 完全可恢复时为零代 TRUE（⏎ 一键）", () => {
    const g = evaluateOneClickGate({ foundOnHost: [rig("alpha", 3, 3), rig("kernel", 4, 4)] });
    expect(g.zeroGeneration).toBe(true);
    expect(g.deltas).toEqual([]);
  });

  it("任一席不可恢复时为 FALSE，并给出 rig + 其不可恢复席数的 delta", () => {
    const g = evaluateOneClickGate({ foundOnHost: [rig("alpha", 3, 3), rig("beta", 5, 2)] });
    expect(g.zeroGeneration).toBe(false);
    expect(g.deltas).toEqual([{ rigName: "beta", seatCount: 5, resumableCount: 2, nonResumable: 3 }]);
  });

  it("列出每个有不可恢复席的 rig", () => {
    const g = evaluateOneClickGate({ foundOnHost: [rig("a", 2, 0), rig("b", 2, 2), rig("c", 3, 1)] });
    expect(g.deltas.map((d) => d.rigName)).toEqual(["a", "c"]);
    expect(g.zeroGeneration).toBe(false);
  });

  it("空 host（无 rig）空真为零代（无 rig/引导路径由上游处理）", () => {
    const g = evaluateOneClickGate({ foundOnHost: [] });
    expect(g.zeroGeneration).toBe(true);
    expect(g.deltas).toEqual([]);
  });
});

describe("restoreConfirmMessage——诚实（r2 HIGH-2：无虚假 fresh-prime 承诺）", () => {
  it("命名 delta 并描述 awaiting-DECISION，绝不声称恢复会 fresh-prime", () => {
    const msg = restoreConfirmMessage([{ rigName: "openrig-pm", seatCount: 13, resumableCount: 7, nonResumable: 6 }]);
    expect(msg).toContain("openrig-pm (6/13)"); // names the delta (R7 — no silent downgrade)
    expect(msg).toContain("无法恢复");
    expect(msg).toContain("做出决策（全新初始化或跳过）"); // the decision the restore actually produces
    expect(msg).toContain("诊断列表");
    // 它绝不承诺 RESTORE 自身会 fresh-prime（r2 捕获的错误主张）
    expect(msg).not.toMatch(/will fresh-prime/i);
  });
});
