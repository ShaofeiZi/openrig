// PL-004 Phase C R1：edge-artifact-required 策略（POC
// `lib/policies/edge-artifact-required.mjs` 的 TypeScript 移植版）。
//
// R1 修复（守卫阻断项 2）：保留 POC 契约。
//   - Spec 使用单数的 `context.source` 与 `context.target` pool spec；两者都可带 `path` 或 `paths`。
//   - 边满足条件：仅当下游 target.raw 包含 source key 时，目标 artifact 才满足来源。
//     这里不匹配 frontmatter，正文引用即可。
//   - 目标扫描把 include_statuses 覆盖为空数组，因此任意下游状态都算“存在”。
//   - 投递目标是顶层 `job.target.session`。
//   - 标签 key 是 `context.edge_label`，与 POC 一致。

import type { Policy, PolicyEvaluation, PolicyJob } from "./types.js";
import {
  type ArtifactPoolSpec,
  type ScannedArtifact,
  scanArtifactPools,
  sourceKeyFor,
} from "./artifact-pool-helpers.js";

interface EdgeArtifactRequiredContext {
  source?: ArtifactPoolSpec & { paths?: string[] };
  target?: ArtifactPoolSpec & { paths?: string[] };
  edge_label?: string;
  max_items?: number;
}

function targetContainsKey(targets: ScannedArtifact[], key: string): boolean {
  return targets.some((t) => t.raw.includes(key));
}

function expandPoolSides(
  spec: (ArtifactPoolSpec & { paths?: string[] }) | undefined,
): ArtifactPoolSpec[] {
  if (!spec) return [];
  if (Array.isArray(spec.paths)) {
    return spec.paths.map((p) => ({ ...spec, path: p, paths: undefined }));
  }
  return [spec];
}

export const edgeArtifactRequiredPolicy: Policy = {
  name: "edge-artifact-required",
  async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
    if (!job.target?.session) {
      throw Object.assign(new Error("edge-artifact-required：target.session 为必填项"), {
        code: "policy_spec_invalid",
        policy: "edge-artifact-required",
        field: "target.session",
      });
    }
    const context = job.context as EdgeArtifactRequiredContext;
    const source = context.source;
    const target = context.target;
    if (!source?.path && !Array.isArray(source?.paths)) {
      throw Object.assign(
        new Error("edge-artifact-required：context.source.path 为必填项"),
        {
          code: "policy_spec_invalid",
          policy: "edge-artifact-required",
          field: "context.source.path",
        },
      );
    }
    if (!target?.path && !Array.isArray(target?.paths)) {
      throw Object.assign(
        new Error("edge-artifact-required：context.target.path 为必填项"),
        {
          code: "policy_spec_invalid",
          policy: "edge-artifact-required",
          field: "context.target.path",
        },
      );
    }
    const sourcePools = expandPoolSides(source);
    const targetPools = expandPoolSides(target).map((p) => ({
      ...p,
      include_statuses: [] as string[],
    }));
    const keyField = source?.key_field ?? "entry";

    const sources = await scanArtifactPools(sourcePools);
    const targets = await scanArtifactPools(targetPools);
    const missing: ScannedArtifact[] = [];
    for (const s of sources) {
      const key = sourceKeyFor(s, keyField);
      if (!targetContainsKey(targets, key)) missing.push(s);
    }
    if (missing.length === 0) {
      return { action: "skip", reason: "no_missing_edge_artifacts" };
    }
    const label = context.edge_label ?? "artifact 边";
    const maxItems = Number(context.max_items ?? 5);
    const list = missing
      .slice(0, maxItems)
      .map((a) => `- ${sourceKeyFor(a, keyField)} (${a.path})`)
      .join("\n");
    const hiddenCount = Math.max(0, missing.length - maxItems);
    const suffix = hiddenCount > 0 ? `\n- ……另有 ${hiddenCount} 项` : "";
    const message =
      job.message ??
      `需要修复 artifact 边：${label} 有 ${missing.length} 个上游 artifact 没有匹配的下游 artifact。\n${list}${suffix}\n\n` +
        "Producer 循环负责创建缺失的下游 artifact。" +
        "不要等待 orch 手工桥接；请修复该边，或记录带证据的阻塞项。";
    return {
      action: "send",
      target: job.target,
      message,
      notes: { missing_count: missing.length, label },
    };
  },
};
