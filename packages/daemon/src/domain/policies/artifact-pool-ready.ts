// PL-004 阶段 C R1：artifact-pool-ready 策略（从 POC
// `lib/policies/artifact-pool-ready.mjs` 移植到 TypeScript）。
//
// POC 契约：必须提供 target.session（顶层 `target:`）。
// 扫描 context.pools（数组）；为空时返回 skip(no_actionable_artifacts)。
// 否则发送格式化消息，并以标准 POC 产物池就绪指令结尾。

import type { Policy, PolicyEvaluation, PolicyJob } from "./types.js";
import {
  type ArtifactPoolSpec,
  formatArtifactList,
  scanArtifactPools,
} from "./artifact-pool-helpers.js";

interface ArtifactPoolReadyContext {
  pools?: ArtifactPoolSpec | ArtifactPoolSpec[];
  label?: string;
  max_items?: number;
}

const POC_POOL_READY_TRAILER =
  "请认领并处理下一个产物，或提供证据并将其归入终态。" +
  "这是产物池就绪唤醒，不是审批门禁，不应要求 orch 代为衔接。";

export const artifactPoolReadyPolicy: Policy = {
  name: "artifact-pool-ready",
  async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
    if (!job.target?.session) {
      throw Object.assign(new Error("artifact-pool-ready：必须提供 target.session"), {
        code: "policy_spec_invalid",
        policy: "artifact-pool-ready",
        field: "target.session",
      });
    }
    const context = job.context as ArtifactPoolReadyContext;
    const artifacts = await scanArtifactPools(context.pools);
    if (artifacts.length === 0) {
      return { action: "skip", reason: "no_actionable_artifacts" };
    }
    const label = context.label ?? "产物池";
    const maxItems = Number(context.max_items ?? 5);
    const list = formatArtifactList(artifacts, maxItems);
    const hiddenCount = Math.max(0, artifacts.length - maxItems);
    const suffix = hiddenCount > 0 ? `\n- ... 另有 ${hiddenCount} 项` : "";
    const message =
      job.message ??
      `产物池已就绪：${label} 有 ${artifacts.length} 个可处理产物。\n${list}${suffix}\n\n${POC_POOL_READY_TRAILER}`;
    return {
      action: "send",
      target: job.target,
      message,
      notes: { artifact_count: artifacts.length, label },
    };
  },
};
