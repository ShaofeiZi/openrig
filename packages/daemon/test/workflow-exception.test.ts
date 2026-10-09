// OPR.0.4.6.WF5 FR-1：taxonomy 测试——基于记录状态的确定性分类、逐类别负例、handler-role 拆分，
// 以及 occurrence-identity 语义（single-home JSDoc 契约）。

import { describe, expect, it } from "vitest";

import {
  WORKFLOW_EXCEPTION_CLASSES,
  classifyDeadlineVerdict,
  classifyFailedInstance,
  classifyGateTrip,
  occurrenceDedupKey,
  workflowExceptionTags,
  type FailedInstanceView,
  type GateTripView,
} from "../src/domain/workflow-exception.js";
import type { WorkflowDeadlineVerdict } from "../src/domain/workflow-deadline.js";

const failedView = (over: Partial<FailedInstanceView["instance"]> = {}): FailedInstanceView => ({
  instance: {
    instanceId: "01WFI",
    workflowName: "wf5-pipeline",
    status: "failed",
    currentStepId: null,
    lastContinuationDecision: { exit: "failed", resultNote: "boom" },
    ...over,
  },
  failedStepId: "review",
  failedPacketId: "qitem-000-failpacket",
  failureReason: "boom",
});

const overdueVerdict: WorkflowDeadlineVerdict = {
  state: "overdue-unclaimed",
  evidence: {
    instanceId: "01WFI",
    stepId: "review",
    packetId: "qitem-000-stuckpacket",
    ownerSession: "crew-reviewer@wf5-proof",
    packetState: "pending",
    anchor: "created_at",
    anchorAt: "2026-07-07T00:00:00.000Z",
    overdueBySeconds: 3600,
    ageSeconds: 18000,
    claimedAt: null,
  },
};

const gateTrip = (over: Partial<GateTripView> = {}): GateTripView => ({
  workflowName: "wf5-pipeline",
  instanceId: "01WFI",
  gatedStepId: "signoff",
  gateKind: "human",
  gatePacketId: "qitem-000-gatepacket",
  parkOn: "human@kernel",
  ...over,
});

describe("WF-5 FR-1 taxonomy", () => {
  it("class 集合封闭且恰有三种", () => {
    expect(WORKFLOW_EXCEPTION_CLASSES).toEqual([
      "unmapped_failed",
      "stuck_overdue",
      "human_gate_trip",
    ]);
  });

  it("class (a)：failed instance 分类为 unmapped_failed，N 次 replay 结果确定", () => {
    const results = Array.from({ length: 5 }, () => classifyFailedInstance(failedView()));
    for (const r of results) {
      expect(r?.identity.exceptionClass).toBe("unmapped_failed");
      expect(r?.identity.occurrenceKey).toBe("qitem-000-failpacket");
      expect(r?.identity.stepId).toBe("review");
      expect(r?.reason).toContain("没有补救分支");
      expect(r?.reason).toContain("boom");
    }
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it("class (a) 负例：非 failed instance 绝不分类（mapped-failed 保持 active，属于确定性修复而非 exception）", () => {
    for (const status of ["active", "waiting", "completed"] as const) {
      expect(classifyFailedInstance(failedView({ status }))).toBeNull();
    }
  });

  it("class (b)：非 healthy evaluator verdict 逐字提升，携带 evidence 且绝不重算", () => {
    const r = classifyDeadlineVerdict("wf5-pipeline", overdueVerdict);
    expect(r?.identity.exceptionClass).toBe("stuck_overdue");
    expect(r?.identity.occurrenceKey).toBe("qitem-000-stuckpacket");
    expect(r?.deadlineEvidence).toBe(overdueVerdict.evidence);
    expect(r?.reason).toContain("overdue-unclaimed");
    expect(r?.reason).toContain("created_at");
  });

  it("class (b) 负例：healthy verdict 返回 null（deadline 内的 step 不是 exception）", () => {
    expect(
      classifyDeadlineVerdict("wf5-pipeline", { state: "healthy", evidence: null }),
    ).toBeNull();
  });

  it("class (c)：到达 HUMAN gate 时按编译后的 gate packet 定键为 human_gate_trip", () => {
    const r = classifyGateTrip(gateTrip());
    expect(r?.identity.exceptionClass).toBe("human_gate_trip");
    expect(r?.identity.occurrenceKey).toBe("qitem-000-gatepacket");
    expect(r?.reason).toContain("human@kernel");
  });

  it("HANDLER-ROLE 拆分：handler-role gate 不是 exception", () => {
    expect(classifyGateTrip(gateTrip({ gateKind: "handler-role", parkOn: null }))).toBeNull();
  });

  it("occurrence 语义：同一 episode 使用同一 key；resume 后的新 packet 产生新 occurrence", () => {
    const first = classifyFailedInstance(failedView());
    const reDetected = classifyFailedInstance(failedView());
    expect(occurrenceDedupKey(first!.identity)).toBe(occurrenceDedupKey(reDetected!.identity));
    const afterResume = classifyFailedInstance({
      ...failedView(),
      failedPacketId: "qitem-001-secondfail",
    });
    expect(occurrenceDedupKey(afterResume!.identity)).not.toBe(
      occurrenceDedupKey(first!.identity),
    );
  });

  it("identity tag 扩展已发布 stamp，并携带每个 join 维度", () => {
    const r = classifyFailedInstance(failedView());
    expect(workflowExceptionTags(r!.identity)).toEqual([
      "workflow-exception",
      "workflow:wf5-pipeline",
      "instance:01WFI",
      "step:review",
      "exception:unmapped_failed",
      "occurrence:qitem-000-failpacket",
    ]);
  });

  it("step binding 为 null（pre-R2 行）时 identity tag 干净省略 step", () => {
    const r = classifyFailedInstance({ ...failedView(), failedStepId: null });
    const tags = workflowExceptionTags(r!.identity);
    expect(tags).not.toContainEqual(expect.stringMatching(/^step:/));
    expect(tags).toContain("exception:unmapped_failed");
  });
});
