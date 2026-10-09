// OPR.0.4.6.WF5 FR-3：感知 workflow 的 ▲ band + AWARENESS CHANNEL——基于已记录 view 的纯组合
// 测试（gatherer 组装，本模块派生）。跨 channel 单次计数：路由到 human 的 ● item 在此为零行；路由
// 到 orchestrator 的 ● item 恰有一条 awareness 行；无 item exception 产生点名 missing-item anomaly
// 的 ▲ backstop；非 open frontier ref 产生 anomaly 行；healthy 产生零行。

import { describe, expect, it } from "vitest";

import {
  composeNeedsYou,
  deriveWorkflowExceptions,
  type AttentionInput,
  type WorkflowExceptionInput,
} from "../src/domain/review/compose.js";

const NOW = "2026-07-07T06:00:00.000Z";

const wf = (over: Partial<WorkflowExceptionInput> = {}): WorkflowExceptionInput => ({
  instanceId: "01WFX",
  workflowName: "wf5-pipeline",
  status: "failed",
  currentStepId: null,
  deadlineState: "healthy",
  deadlineEvidence: null,
  frontierRefsNonOpenPacket: false,
  openItem: null,
  ...over,
});

const orchItem = {
  qitemId: "qitem-exc-1",
  destinationSession: "orch-lead@rig",
  humanRouted: false,
  createdAtIso: "2026-07-07T05:30:00.000Z",
  summary: "workflow step failed with no remediation branch",
};

describe("WF-5 FR-3: deriveWorkflowExceptions", () => {
  it("healthy instance 渲染零行（band 的零噪声负例）", () => {
    expect(
      deriveWorkflowExceptions([wf({ status: "active" })], "rig", NOW),
    ).toHaveLength(0);
  });

  it("路由到 ORCHESTRATOR 的 exception 恰好产生一条 awareness 行：holder + age + evidence，与待办不同", () => {
    const rows = deriveWorkflowExceptions([wf({ openItem: orchItem })], "rig", NOW);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.derived?.kind).toBe("awareness");
    expect(r.summary).toContain("由 orch-lead@rig 持有");
    expect(r.derived?.evidence).toContain("qitem-exc-1");
    expect(r.derived?.evidence).toContain("30m");
    expect(r.derived?.threshold).toContain("感知");
    expect(r.evidenceRef).toContain("rig workflow trace 01WFX");
  });

  it("路由到 HUMAN 的 exception 不产生行（● item 就是 human 的行，不重复渲染）", () => {
    const rows = deriveWorkflowExceptions(
      [wf({ openItem: { ...orchItem, destinationSession: "human@host", humanRouted: true } })],
      "rig",
      NOW,
    );
    expect(rows).toHaveLength(0);
  });

  it("failed 且无 item 时产生同时点名 exception 和 missing-item anomaly 的 ▲ backstop", () => {
    const rows = deriveWorkflowExceptions([wf()], "rig", NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.derived?.kind).toBe("workflow-failed");
    expect(rows[0]!.derived?.evidence).toContain("缺项异常");
  });

  it("stuck（in-flight 超过阈值）且无 item 时产生携带 evaluator evidence + threshold 的 ▲ 行", () => {
    const rows = deriveWorkflowExceptions(
      [
        wf({
          status: "active",
          deadlineState: "overdue-unclaimed",
          deadlineEvidence: "step review packet qitem-9 held by reviewer@rig — 3600s past the created_at anchor",
        }),
      ],
      "rig",
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.derived?.kind).toBe("stuck");
    expect(rows[0]!.derived?.evidence).toContain("3600s past the created_at anchor");
  });

  it("frontier-references-non-open-packet 产生 ANOMALY 行（检测位于 WF-3 FR-6 预防守卫之后）", () => {
    const rows = deriveWorkflowExceptions(
      [wf({ status: "active", frontierRefsNonOpenPacket: true })],
      "rig",
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.derived?.kind).toBe("anomaly");
    expect(rows[0]!.derived?.evidence).toContain("关闭路径守卫");
  });

  it("重新组合会清除：同一 instance 在解决后重新组合不渲染内容（状态退出，绝不手工清除）", () => {
    const before = deriveWorkflowExceptions([wf({ openItem: orchItem })], "rig", NOW);
    expect(before).toHaveLength(1);
    const after = deriveWorkflowExceptions([wf({ status: "active", openItem: null })], "rig", NOW);
    expect(after).toHaveLength(0);
  });

  it("跨 band 单次计数：awareness 行经 composeNeedsYou 去重后恰好保留一次", () => {
    const derived = deriveWorkflowExceptions(
      [wf({ openItem: orchItem }), wf({ openItem: orchItem })],
      "rig",
      NOW,
    );
    const band = composeNeedsYou([], derived, [], "test", NOW);
    expect(band.items.filter((i) => i.derived?.kind === "awareness")).toHaveLength(1);
  });
});

// OPR.0.4.6.WF4 Q6——row.workflow identity stamp：一个结构化 pointer，在后台服务侧派生一次；
// 仅含 pointer（三个 identity key，绝不含 status/deadline/class）；非 workflow 行省略（字节一致）。
const att = (over: Partial<AttentionInput> = {}): AttentionInput => ({
  qitemId: "qitem-1",
  summary: "a plain non-workflow attention row",
  leg: "human-routed",
  where: "human@host",
  createdAtIso: NOW,
  priority: null,
  tier: "human-gate",
  evidenceRef: null,
  unblocks: null,
  destinationSession: "human@host",
  closureRequiredAtIso: null,
  ...over,
});

describe("WF-4 Q6：row.workflow identity stamp", () => {
  it("P2 仅 pointer——派生行的 workflow 恰好只有 identity key（无 status/deadline/class）", () => {
    const rows = deriveWorkflowExceptions([wf({ openItem: orchItem })], "rig", NOW);
    // currentStepId 为 null 时省略 stepId（绝不盖 null stamp）。
    expect(rows[0]!.workflow).toEqual({ instanceId: "01WFX", workflowName: "wf5-pipeline" });
    expect(Object.keys(rows[0]!.workflow!).sort()).toEqual(["instanceId", "workflowName"]);
  });

  it("P2——instance 携带当前 step 时 stepId 随 pointer 传递", () => {
    const rows = deriveWorkflowExceptions(
      [wf({ status: "active", currentStepId: "verify", frontierRefsNonOpenPacket: true })],
      "rig",
      NOW,
    );
    expect(rows[0]!.workflow).toEqual({ instanceId: "01WFX", workflowName: "wf5-pipeline", stepId: "verify" });
  });

  it("统一 stamp——三种派生 kind（anomaly / awareness / backstop）都携带 pointer", () => {
    const anomaly = deriveWorkflowExceptions([wf({ status: "active", frontierRefsNonOpenPacket: true })], "rig", NOW);
    const awareness = deriveWorkflowExceptions([wf({ openItem: orchItem })], "rig", NOW);
    const backstop = deriveWorkflowExceptions([wf()], "rig", NOW);
    expect(anomaly[0]!.derived?.kind).toBe("anomaly");
    expect(awareness[0]!.derived?.kind).toBe("awareness");
    expect(backstop[0]!.derived?.kind).toBe("workflow-failed");
    for (const rows of [anomaly, awareness, backstop]) {
      expect(rows[0]!.workflow?.instanceId).toBe("01WFX");
    }
  });

  it("● agent 分支通过 composeNeedsYou 逐字携带 gatherer 的 pointer", () => {
    const workflow = { instanceId: "01WFX", workflowName: "wf5-pipeline", stepId: "verify" };
    const band = composeNeedsYou([att({ workflow })], [], [], "test", NOW);
    const row = band.items.find((i) => i.source === "agent")!;
    expect(row.workflow).toEqual(workflow);
  });

  it("P1 缺失时省略——非 workflow ● 行没有 workflow key（字节一致）", () => {
    const band = composeNeedsYou([att()], [], [], "test", NOW);
    const row = band.items.find((i) => i.source === "agent")!;
    expect("workflow" in row).toBe(false);
  });

  it("P1 缺失时省略——无 workflow 的组合序列化后 workflow key 为零", () => {
    const band = composeNeedsYou([att(), att({ qitemId: "qitem-2" })], [], [], "test", NOW);
    expect(JSON.stringify(band).includes('"workflow"')).toBe(false);
  });
});
