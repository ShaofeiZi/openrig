// SPIKE 夹具——镜像真实 `/api/rigs/:id/graph` 输出（相同字段集
// 和 id 纪律如 spike/real-graph-v-openrig-build.json），同时练习
// 实时工作组今天恰好不显示的完整 spike 词汇：
//   · 所有 3 种边类型（delegates_to / collaborates_with / escalates_to）
//   · 所有 4 种状态字形，包括真正的 ○ 诚实未知（无会话，
//     无活动——投影无值）和带 ctx% 叠加的 ◐
// 门控如 demo-data：仅由 spike shell/测试导入，绝不由
// 实时渲染路径导入（--demo 门规则不变适用）。
import type { RigGraph } from "./graph-types.js";

export const FIXTURE_RIG_NAME = "openrig-build";

export function spikeFixtureGraph(): RigGraph {
  return {
    nodes: [
      { id: "pod-01SPIKEORCH000000000000000", type: "podGroup", data: { logicalId: "orch", podNamespace: "orch", podLabel: "orch", runtime: null, model: null, status: null, nodeKind: "agent", startupStatus: null, contextUsedPercentage: null } },
      { id: "pod-01SPIKEDEV0000000000000000", type: "podGroup", data: { logicalId: "dev", podNamespace: "dev", podLabel: "dev", runtime: null, model: null, status: null, nodeKind: "agent", startupStatus: null, contextUsedPercentage: null } },
      { id: "pod-01SPIKEREVIEW00000000000000", type: "podGroup", data: { logicalId: "review", podNamespace: "review", podLabel: "review", runtime: null, model: null, status: null, nodeKind: "agent", startupStatus: null, contextUsedPercentage: null } },
      {
        id: "01SPIKENODELEAD00000000000",
        type: "rigNode",
        parentId: "pod-01SPIKEORCH000000000000000",
        data: {
          logicalId: "orch.lead", podNamespace: "orch", runtime: "claude-code", model: "claude",
          status: "running", nodeKind: "agent", startupStatus: "ready", contextUsedPercentage: 18,
          agentActivity: { state: "running" }, terminalActive: true, canonicalSessionName: "orch-lead@openrig-build",
        },
      },
      {
        id: "01SPIKENODEDRIVER000000000",
        type: "rigNode",
        parentId: "pod-01SPIKEDEV0000000000000000",
        data: {
          logicalId: "dev.driver", podNamespace: "dev", runtime: "claude-code", model: "claude",
          status: "running", nodeKind: "agent", startupStatus: "ready", contextUsedPercentage: 24,
          agentActivity: { state: "running" }, terminalActive: true, canonicalSessionName: "dev-driver@openrig-build",
        },
      },
      {
        id: "01SPIKENODEQA0000000000000",
        type: "rigNode",
        parentId: "pod-01SPIKEDEV0000000000000000",
        data: {
          // ◐ 部分/%——已存在的琥珀待关注状态，带服务 ctx%
          logicalId: "dev.qa", podNamespace: "dev", runtime: "codex", model: "gpt",
          status: "running", nodeKind: "agent", startupStatus: "attention_required", contextUsedPercentage: 63,
          agentActivity: { state: "needs_input" }, terminalActive: false, canonicalSessionName: "dev-qa@openrig-build",
        },
      },
      {
        id: "01SPIKENODER1000000000000Z",
        type: "rigNode",
        parentId: "pod-01SPIKEREVIEW00000000000000",
        data: {
          // ○ 诚实未知——无会话，无活动，无 ctx：投影
          // 无值，因此渲染必须说明（绝不伪造 ●）
          logicalId: "review.r1", podNamespace: "review", runtime: "codex", model: null,
          status: null, nodeKind: "agent", startupStatus: null, contextUsedPercentage: null,
          agentActivity: null, terminalActive: null, canonicalSessionName: null,
        },
      },
      {
        id: "01SPIKENODEVALID0000000000",
        type: "rigNode",
        parentId: "pod-01SPIKEREVIEW00000000000000",
        data: {
          // ✕ 失败
          logicalId: "review.validator", podNamespace: "review", runtime: "codex", model: "gpt",
          status: "running", nodeKind: "agent", startupStatus: "failed", contextUsedPercentage: null,
          agentActivity: null, terminalActive: false, canonicalSessionName: "review-validator@openrig-build",
        },
      },
    ],
    edges: [
      { id: "01SPIKEEDGE1", source: "01SPIKENODELEAD00000000000", target: "01SPIKENODEDRIVER000000000", label: "delegates_to" },
      { id: "01SPIKEEDGE2", source: "01SPIKENODELEAD00000000000", target: "01SPIKENODER1000000000000Z", label: "delegates_to" },
      { id: "01SPIKEEDGE3", source: "01SPIKENODEDRIVER000000000", target: "01SPIKENODEQA0000000000000", label: "collaborates_with" },
      { id: "01SPIKEEDGE4", source: "01SPIKENODER1000000000000Z", target: "01SPIKENODELEAD00000000000", label: "escalates_to" },
    ],
  };
}
