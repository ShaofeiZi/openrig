// OPR.0.4.6.WF4 Q6——●（智能体阶段）工作流身份标记从条目自身的结构化标签派生
//（WF-5 批准的可查询身份），绝不从 summary/identity/evidenceRef 文本派生。此处固定
// 派生规则：两个必需键齐全 → 指针；缺少任一键或不是工作流行 → undefined
//（因此 AttentionInput 字节完全一致，缺失时省略）。

import { describe, expect, it } from "vitest";

import { workflowRefFromTags } from "../src/domain/review/gather.js";

const tags = (...t: string[]) => JSON.stringify(t);

describe("WF-4 Q6：workflowRefFromTags", () => {
  it("从 workflow: + instance: + step: 标签派生完整指针", () => {
    expect(
      workflowRefFromTags(
        tags("workflow-exception", "workflow:branched-remediation", "instance:01WFX", "step:verify", "exception:failed"),
      ),
    ).toEqual({ instanceId: "01WFX", workflowName: "branched-remediation", stepId: "verify" });
  });

  it("没有 step: 标签时省略 stepId", () => {
    const ref = workflowRefFromTags(tags("workflow-exception", "workflow:conveyor", "instance:01WFY"));
    expect(ref).toEqual({ instanceId: "01WFY", workflowName: "conveyor" });
    expect("stepId" in ref!).toBe(false);
  });

  it("仅含指针——严格只保留身份键，不泄漏 exception/occurrence", () => {
    const ref = workflowRefFromTags(
      tags("workflow:gated-release", "instance:01WFZ", "step:gate", "exception:blocked", "occurrence:qitem-9"),
    );
    expect(Object.keys(ref!).sort()).toEqual(["instanceId", "stepId", "workflowName"]);
  });

  it("缺少 instance: 键时返回 undefined（指针不完整，绝不返回部分结果）", () => {
    expect(workflowRefFromTags(tags("workflow:conveyor", "step:build"))).toBeUndefined();
  });

  it("缺少 workflow: 键时返回 undefined", () => {
    expect(workflowRefFromTags(tags("instance:01WFX", "step:build"))).toBeUndefined();
  });

  it("非工作流行返回 undefined（通过省略保持字节一致）", () => {
    expect(workflowRefFromTags(tags("slice:mh-2", "mission:release-0.4.6"))).toBeUndefined();
  });

  it("标签为 null、空值或格式错误时返回 undefined", () => {
    expect(workflowRefFromTags(null)).toBeUndefined();
    expect(workflowRefFromTags("[]")).toBeUndefined();
    expect(workflowRefFromTags("not json")).toBeUndefined();
  });
});
