// OPR.0.4.6.WF4（C4）——支配每个实例层级（/workflows 分组、A-lite 条带、分组排序）的
// 待关注优先顺序：异常排在健康项之前，实时项排在已结束项之前，即 NEEDS-YOU 优先阅读。
// 此处测试纯逻辑；渲染表面由 VM 租约中的视觉证明覆盖。

import { describe, it, expect } from "vitest";
import { instanceAttentionRank, selectSpecInstances } from "../src/components/workflow/WorkflowInstancesBand.js";
import type { WorkflowInstanceWithDeadline } from "../src/hooks/useWorkflow.js";

const inst = (over: Partial<WorkflowInstanceWithDeadline>): WorkflowInstanceWithDeadline => ({
  instanceId: "01WFX",
  workflowName: "wf",
  workflowVersion: "1",
  createdBySession: "lead@acme-rig",
  createdAt: "2026-07-07T00:00:00.000Z",
  status: "active",
  currentFrontier: [],
  currentStepId: null,
  hopCount: 0,
  fallbackSynthesis: null,
  lastContinuationDecision: null,
  completedAt: null,
  version: 1,
  resumeCount: 0,
  hopsBaseline: 0,
  deadline: { state: "healthy", evidence: null },
  ...over,
});

describe("WF-4 C4: instanceAttentionRank", () => {
  it("ranks failed < overdue < waiting < active < completed (lower = hotter, sorts first)", () => {
    const failed = inst({ status: "failed" });
    const overdue = inst({ status: "active", deadline: { state: "overdue-unclaimed", evidence: null } });
    const waiting = inst({ status: "waiting" });
    const active = inst({ status: "active" });
    const completed = inst({ status: "completed" });
    expect(instanceAttentionRank(failed)).toBe(0);
    expect(instanceAttentionRank(overdue)).toBe(1);
    expect(instanceAttentionRank(waiting)).toBe(2);
    expect(instanceAttentionRank(active)).toBe(3);
    expect(instanceAttentionRank(completed)).toBe(4);
  });

  it("a failed instance outranks a healthy one regardless of status enum order", () => {
    const rows = [inst({ status: "completed" }), inst({ status: "failed" }), inst({ status: "active" })];
    rows.sort((a, b) => instanceAttentionRank(a) - instanceAttentionRank(b));
    expect(rows.map((r) => r.status)).toEqual(["failed", "active", "completed"]);
  });

  it("an overdue-but-active instance outranks a healthy active one (deadline verdict beats status)", () => {
    const healthy = inst({ status: "active" });
    const overdue = inst({ status: "active", deadline: { state: "overdue-claimed", evidence: null } });
    expect(instanceAttentionRank(overdue)).toBeLessThan(instanceAttentionRank(healthy));
  });
});

describe("WF-4 guard blocker 2: spec-band version discrimination", () => {
  // 资源库规范页表达“此规范的运行”；两个缓存规范可能跨版本共用 workflowName，因此仅按名称
  // 筛选会显示错误版本的运行。selectSpecInstances 必须同时区分名称和版本。
  const v1 = inst({ instanceId: "01V1", workflowName: "acme", workflowVersion: "1" });
  const v2 = inst({ instanceId: "01V2", workflowName: "acme", workflowVersion: "2" });

  it("with a version pinned, selects ONLY the matching workflowVersion (not the same-name other version)", () => {
    expect(selectSpecInstances([v1, v2], "acme", "1").map((i) => i.instanceId)).toEqual(["01V1"]);
    expect(selectSpecInstances([v1, v2], "acme", "2").map((i) => i.instanceId)).toEqual(["01V2"]);
  });

  it("name-only (no version) keeps both — the /workflows altitude behavior, unchanged", () => {
    expect(selectSpecInstances([v1, v2], "acme").length).toBe(2);
  });
});
