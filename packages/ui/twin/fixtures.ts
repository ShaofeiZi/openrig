// 带类型的哑 fixture = 漂移守卫。每个 fixture 都按真实导出的 @openrig/ui hook 接口
// 做类型标注，因此真实接口变化会使 twin 构建失败（编译期漂移检测）。数据是一组可信的
// 工作组家族（多 pod/席位、混合智能体状态），使 twin 读起来像真实产品。标识符是虚构演示
// 数据，非实时操作者状态。
//
// 要为某个 slice 创作特性版本：复制相关 fixture，改动该 slice 提议的那一个字段，重新构建。
// 本文件的 diff 即是所提改动的本质。

import type { RigSummary } from "../src/hooks/useRigSummary.js";
import type { PsEntry } from "../src/hooks/usePsEntries.js";
import type { LibraryRigReview, SpecLibraryEntry } from "../src/hooks/useSpecLibrary.js";
import type { NodeInventoryEntry } from "../src/hooks/useNodeInventory.js";
import type { SteeringPayload } from "../src/hooks/useSteering.js";
import type { NodeDetailData } from "../src/hooks/useNodeDetail.js";
import type { NodePreviewResponse } from "../src/hooks/useNodePreview.js";
import type { SliceListResponse } from "../src/hooks/useSlices.js";

export const rigSummary: RigSummary[] = [
  { id: "rig_alpha", name: "acme-build", nodeCount: 11, hasServices: true, latestSnapshotAt: "2025-09-01T01:40:00.000Z", latestSnapshotId: "snap_a_204" },
  { id: "rig_bravo", name: "acme-comms", nodeCount: 8, hasServices: true, latestSnapshotAt: "2025-09-01T00:55:00.000Z", latestSnapshotId: "snap_b_087" },
  { id: "rig_gamma", name: "acme-core", nodeCount: 4, hasServices: false, latestSnapshotAt: "2025-08-31T22:10:00.000Z", latestSnapshotId: "snap_g_031" },
];

export const psEntries: PsEntry[] = [
  { rigId: "rig_alpha", name: "acme-build", nodeCount: 11, runningCount: 11, activeCount: 6, hasWorkCount: 3, status: "running", uptime: "4h 12m", latestSnapshot: "2025-09-01T01:40:00.000Z" },
  { rigId: "rig_bravo", name: "acme-comms", nodeCount: 8, runningCount: 7, activeCount: 2, hasWorkCount: 1, status: "partial", uptime: "2h 03m", latestSnapshot: "2025-09-01T00:55:00.000Z" },
  { rigId: "rig_gamma", name: "acme-core", nodeCount: 4, runningCount: 4, activeCount: 1, hasWorkCount: 0, status: "running", uptime: "9h 47m", latestSnapshot: "2025-08-31T22:10:00.000Z" },
];

export const specLibrary: SpecLibraryEntry[] = [
  { id: "spec_build_rig", kind: "rig", name: "acme-build", version: "1.0.0", sourceType: "user_file", sourcePath: "/specs/rigs/build.yaml", relativePath: "rigs/build.yaml", updatedAt: "2025-08-31T18:00:00.000Z", summary: "多席位构建工作组", hasServices: true },
  { id: "spec_builder_agent", kind: "agent", name: "builder-agent", version: "1.0.0", sourceType: "builtin", sourcePath: "/specs/agents/builder.yaml", relativePath: "agents/builder.yaml", updatedAt: "2025-08-30T12:00:00.000Z", summary: "TDD 构建席位" },
  { id: "spec_review_flow", kind: "workflow", name: "review-changes", version: "1.0.0", sourceType: "builtin", sourcePath: "/specs/workflows/review.yaml", relativePath: "workflows/review.yaml", updatedAt: "2025-08-29T09:30:00.000Z", summary: "带校验的维度评审", stepsCount: 3, status: "valid" },
];

/** 托管应用详情，用于验证“复制安装提示词”这一真实交互链路。 */
export const serviceRigReview: LibraryRigReview = {
  sourceState: "library_item",
  kind: "rig",
  name: "acme-build",
  version: "1.0.0",
  summary: "带专用构建席位与健康检查的示例托管应用",
  format: "pod_aware",
  pods: [{
    id: "builders",
    label: "构建组",
    members: [{ id: "specialist", agentRef: "local:agents/builder", runtime: "claude-code" }],
    edges: [],
  }],
  edges: [],
  graph: { nodes: [], edges: [] },
  raw: "name: acme-build\nversion: 1.0.0\n",
  libraryEntryId: "spec_build_rig",
  sourcePath: "/specs/rigs/build.yaml",
  services: {
    kind: "compose",
    composeFile: "acme-build.compose.yaml",
    projectName: "zrig-acme-build",
    downPolicy: "down",
    waitFor: [{ url: "http://127.0.0.1:8080/health" }],
    surfaces: {
      urls: [{ name: "构建控制台", url: "http://127.0.0.1:8080" }],
      commands: [{ name: "检查状态", command: "curl -fsS http://127.0.0.1:8080/health" }],
    },
    composePreview: { services: [{ name: "builder", image: "example/builder:1.0" }] },
  },
};

// 每个工作组的节点清单（为 twin 界面导航进某工作组拓扑时预置）。
const buildNodes: NodeInventoryEntry[] = [
  { rigId: "rig_alpha", rigName: "acme-build", logicalId: "lead.coordinator", podId: "pod_lead", podNamespace: "lead", canonicalSessionName: "coordinator@acme-build", nodeKind: "agent", runtime: "claude-code", sessionStatus: "running", startupStatus: "ready", restoreOutcome: "clean", tmuxAttachCommand: "tmux attach -t coordinator", resumeCommand: null, latestError: null, contextUsage: { usedPercentage: 58, remainingPercentage: 42, contextWindowSize: 1000000, availability: "ok", sampledAt: "2025-09-01T01:39:00.000Z", fresh: true }, agentActivity: { state: "running", reason: "tool_use", evidenceSource: "tmux", sampledAt: "2025-09-01T01:39:00.000Z" }, terminalActive: true, hasAssignedWork: true, pendingWorkCount: 2 },
  { rigId: "rig_alpha", rigName: "acme-build", logicalId: "builders.builder2", podId: "pod_builders", podNamespace: "builders", canonicalSessionName: "builder2@acme-build", nodeKind: "agent", runtime: "claude-code", sessionStatus: "running", startupStatus: "ready", restoreOutcome: "clean", tmuxAttachCommand: "tmux attach -t builder2", resumeCommand: null, latestError: null, contextUsage: { usedPercentage: 81, remainingPercentage: 19, contextWindowSize: 1000000, availability: "ok", sampledAt: "2025-09-01T01:39:00.000Z", fresh: true }, agentActivity: { state: "running", reason: "building", evidenceSource: "tmux", sampledAt: "2025-09-01T01:39:00.000Z" }, terminalActive: true, hasAssignedWork: true, pendingWorkCount: 1 },
  { rigId: "rig_alpha", rigName: "acme-build", logicalId: "builders.reviewer1", podId: "pod_builders", podNamespace: "builders", canonicalSessionName: "reviewer1@acme-build", nodeKind: "agent", runtime: "codex", sessionStatus: "running", startupStatus: "ready", restoreOutcome: "clean", tmuxAttachCommand: "tmux attach -t reviewer1", resumeCommand: null, latestError: null, agentActivity: { state: "idle", reason: "awaiting_review", evidenceSource: "queue", sampledAt: "2025-09-01T01:38:00.000Z" }, terminalActive: false, hasAssignedWork: false, pendingWorkCount: 0 },
];

export const nodeInventoryByRig: Record<string, NodeInventoryEntry[]> = {
  rig_alpha: buildNodes,
  rig_bravo: [],
  rig_gamma: [],
};

// --- 硬界面 1：拓扑图（xyflow） ------------------------------------------
// 后台服务 /api/rigs/<id>/graph 负载。useRigGraph 把 nodes/edges 标注为 unknown[]，
// 因此这里按本地接口标注，精确镜像 RigGraph + applyTreeLayout 读取的内容：
// node {id, type, parentId, position, data}；edge {id, source, target, data.kind}。
// pod 归属按 node.parentId（xyflow 父分组），而非边；applyTreeLayout 指派最终位置
// （这里的 {x:0,y:0} 只是它会覆盖的占位）。
export interface TwinGraphNode {
  id: string;
  type: "rigNode" | "podGroup";
  parentId?: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}
export interface TwinGraphEdge {
  id: string;
  source: string;
  target: string;
  data?: { kind?: string };
}
export interface TwinGraph {
  nodes: TwinGraphNode[];
  edges: TwinGraphEdge[];
}

const ZERO = { x: 0, y: 0 };
const act = (state: string, reason: string, source = "tmux") => ({ state, reason, evidenceSource: source, sampledAt: "2025-09-01T01:39:00.000Z" });

export const rigGraphByRig: Record<string, TwinGraph> = {
  rig_alpha: {
    nodes: [
      { id: "pod_lead", type: "podGroup", position: ZERO, data: { podId: "pod_lead", podNamespace: "lead", podLabel: "lead" } },
      { id: "n_lead_coordinator", type: "rigNode", parentId: "pod_lead", position: ZERO, data: { logicalId: "lead.coordinator", canonicalSessionName: "coordinator@acme-build", podId: "pod_lead", podNamespace: "lead", startupStatus: "ready", agentActivity: act("running", "coordinating"), terminalActive: true, hasAssignedWork: true, pendingWorkCount: 2, currentQitems: [] } },
      { id: "pod_builders", type: "podGroup", position: ZERO, data: { podId: "pod_builders", podNamespace: "builders", podLabel: "builders" } },
      { id: "n_builders_builder2", type: "rigNode", parentId: "pod_builders", position: ZERO, data: { logicalId: "builders.builder2", canonicalSessionName: "builder2@acme-build", podId: "pod_builders", podNamespace: "builders", startupStatus: "ready", agentActivity: act("running", "building"), terminalActive: true, hasAssignedWork: true, pendingWorkCount: 1, currentQitems: [] } },
      { id: "n_builders_reviewer1", type: "rigNode", parentId: "pod_builders", position: ZERO, data: { logicalId: "builders.reviewer1", canonicalSessionName: "reviewer1@acme-build", podId: "pod_builders", podNamespace: "builders", startupStatus: "ready", agentActivity: act("idle", "awaiting_review", "queue"), terminalActive: false, hasAssignedWork: false, pendingWorkCount: 0, currentQitems: [] } },
    ],
    edges: [
      { id: "e_lead_builder2", source: "n_lead_coordinator", target: "n_builders_builder2", data: { kind: "delegates_to" } },
      { id: "e_lead_reviewer1", source: "n_lead_coordinator", target: "n_builders_reviewer1", data: { kind: "delegates_to" } },
      { id: "e_builder2_reviewer1", source: "n_builders_builder2", target: "n_builders_reviewer1", data: { kind: "collaborates_with" } },
    ],
  },
  rig_bravo: { nodes: [], edges: [] },
  rig_gamma: { nodes: [], edges: [] },
};

// --- 硬界面 2：实时节点详情 ------------------------------------------------
// useNodeDetail 键 ["rig", rigId, "nodes", logicalId] -> 导出的 NodeDetailData
// （强类型 = 漂移守卫）。键为 "<rigId>::<logicalId>"。
export const nodeDetailByKey: Record<string, NodeDetailData> = {
  "rig_alpha::lead.coordinator": {
    rigId: "rig_alpha",
    rigName: "acme-build",
    logicalId: "lead.coordinator",
    podId: "pod_lead",
    podNamespace: "lead",
    canonicalSessionName: "coordinator@acme-build",
    nodeKind: "agent",
    runtime: "claude-code",
    sessionStatus: "running",
    startupStatus: "ready",
    restoreOutcome: "clean",
    tmuxAttachCommand: "tmux attach -t coordinator",
    resumeCommand: null,
    recoveryGuidance: { summary: "健康——无需恢复动作。", commands: [], notes: ["最近快照 2025-09-01T01:40Z"] },
    latestError: null,
    model: "claude-opus-4-8",
    agentRef: "agents/coordinator.yaml",
    profile: "orchestrator",
    resolvedSpecName: "coordinator",
    resolvedSpecVersion: "1.0.0",
    cwd: "/Users/x/code/projects/example-workspace",
    startupFiles: [
      { path: "CLAUDE.md", deliveryHint: "context", required: true },
      { path: "MISSION_NOTES.md", deliveryHint: "context", required: false },
    ],
    startupActions: [{ type: "skill", value: "openrig-user" }],
    recentEvents: [
      { type: "node.ready", createdAt: "2025-08-31T21:28:00.000Z" },
      { type: "queue.handoff", createdAt: "2025-09-01T01:22:00.000Z" },
    ],
    infrastructureStartupCommand: null,
    peers: [
      { logicalId: "builders.builder2", canonicalSessionName: "builder2@acme-build", runtime: "claude-code" },
      { logicalId: "builders.reviewer1", canonicalSessionName: "reviewer1@acme-build", runtime: "codex" },
    ],
    edges: {
      outgoing: [{ kind: "delegates_to", to: { logicalId: "builders.builder2", sessionName: "builder2@acme-build" } }],
      incoming: [{ kind: "collaborates_with", from: { logicalId: "builders.builder1", sessionName: "builder1@acme-build" } }],
    },
    transcript: { enabled: true, path: "/Users/x/.openrig/transcripts/acme-build/coordinator@acme-build.log", tailCommand: "rig transcript coordinator@acme-build --tail 100" },
    compactSpec: { name: "coordinator", version: "1.0.0", profile: "orchestrator", skillCount: 6, guidanceCount: 3 },
    agentActivity: act("running", "coordinating") as NodeDetailData["agentActivity"],
    currentQitems: [{ qitemId: "wf-demo-002", bodyExcerpt: "Example fold-in: hook-path follow-up on the next iteration…", tier: "build" }],
    terminalActive: true,
    hasAssignedWork: true,
    pendingWorkCount: 2,
    contextUsage: { availability: "ok", usedPercentage: 58, remainingPercentage: 42, contextWindowSize: 1000000, sampledAt: "2025-09-01T01:39:00.000Z", fresh: true },
  },
};

// 内嵌实时终端预览。仅按 sessionName 建键（轮询的 `lines` 数随界面/设置变化——
// 节点详情上是 100——因此 fetch 桩按名匹配并回显所请求的行数；哑内容始终相同）。
export const sessionPreviewByName: Record<string, NodePreviewResponse> = {
  "coordinator@acme-build": {
    sessionName: "coordinator@acme-build",
    lines: 100,
    capturedAt: "2025-09-01T01:40:12.000Z",
    content: [
      "coordinator@acme-build $ rig queue list --destination builder2 --state pending",
      "  wf-demo-002  Example queue item (follow-up build)  pending",
      "coordinator@acme-build $ # routing the follow-up to builder2",
      "Sent to builder2@acme-build",
      "  Verified: yes  Delivery: rendered",
      "coordinator@acme-build $ rig ps --nodes --rig acme-build",
      "  acme-build   11 nodes   6 active   3 has-work",
      "  lead.coordinator  running   builders.builder2  building   builders.reviewer1  idle",
      "coordinator@acme-build $ _",
    ].join("\n"),
  },
};

// --- 简易界面：工作区（/project） -----------------------------------------------
// useSlices -> /api/slices -> SliceListResponse（导出 = 漂移守卫）。项目任务由这些 slice
// 派生（partitionProjectMissions），因此这一个 fixture 同时填充 slice 列表与任务分组。
export const sliceList: SliceListResponse = {
  filter: "all",
  totalCount: 4,
  slices: [
    { name: "EX.1.0.0.01", missionId: "release-1.0.0", displayName: "席位级压缩后恢复（示例）", railItem: "01", status: "done", rawStatus: "merged", qitemCount: 6, hasProofPacket: true, lastActivityAt: "2025-09-01T01:55:00.000Z" },
    { name: "EX.1.0.0.02", missionId: "release-1.0.0", displayName: "UI 数字孪生测试架（示例）", railItem: "02", status: "active", rawStatus: "building", qitemCount: 4, hasProofPacket: false, lastActivityAt: "2025-09-01T02:05:00.000Z" },
    { name: "EX.1.0.0.03", missionId: "release-1.0.0", displayName: "表格视图崩溃修复（示例）", railItem: "03", status: "done", rawStatus: "merged", qitemCount: 2, hasProofPacket: true, lastActivityAt: "2025-08-31T23:40:00.000Z" },
    { name: "EX.1.0.0.04", missionId: "release-1.0.0", displayName: "安全姿态一致性（示例）", railItem: "04", status: "draft", rawStatus: "scoped", qitemCount: 0, hasProofPacket: false, lastActivityAt: null },
  ],
};

// --- 简易界面：FOR-YOU（/for-you）——SSE 活动事件 -> feed 卡片 --------------
// feed 由 SSE 驱动（useActivityFeed 订阅 /api/events），而非缓存种子，因此 EventSource
// 桩发出这些事件。addEvent 构造 ActivityEvent{type,seq,payload:<整个对象>,createdAt}；
// classifyEvent 按 `state` 把 queue.* 映射为 action-required / approval / shipped / progress。
// 松散类型（SSE 负载是动态的；分类器防御性读取）。
export interface TwinFeedEvent { type: string; seq: number; createdAt: string; [key: string]: unknown; }
export const feedEvents: TwinFeedEvent[] = [
  { type: "queue.updated", seq: 104, createdAt: "2025-09-01T02:05:00.000Z", summary: "示例事项：最难优先检查点已交付", sourceSession: "builder2@acme-build", destinationSession: "coordinator@acme-build", rigId: "rig_alpha", qitemId: "wf-demo-002", state: "in_progress", priority: "routine" },
  { type: "queue.delivery.closed", seq: 103, createdAt: "2025-09-01T01:55:00.000Z", summary: "示例合并：席位级压缩后恢复", sourceSession: "coordinator@acme-build", rigId: "rig_alpha", qitemId: "wf-demo-001", state: "closed", closureReason: "handed_off_to" },
  { type: "queue.updated", seq: 102, createdAt: "2025-09-01T01:30:00.000Z", summary: "审批请求：数字孪生易用性证明", sourceSession: "coord@acme-pm", rigId: "rig_alpha", qitemId: "wf-demo-ratify", state: "closeout-pending-ratify", priority: "routine" },
  { type: "queue.updated", seq: 101, createdAt: "2025-09-01T01:10:00.000Z", summary: "需要签核：示例发布简报", sourceSession: "coordinator@acme-build", rigId: "rig_alpha", qitemId: "wf-demo-signoff", state: "human-gate", priority: "urgent" },
];

// --- 任务 Steering 标签页界面 -----------------------------------------------------
// 面板 1：GET /api/steering -> SteeringPayload（带类型 = 漂移守卫）。
export const steeringPayload: SteeringPayload = {
  priorityStack: {
    content: [
      "# Steering — release-1.0.0 (example)",
      "",
      "**Mode:** example-mode · **Workflow:** example-flow",
      "",
      "**What agents are told to do right now:**",
      "- Example directive A.",
      "- Example directive B — visual intent before build.",
      "- Example directive C — human-readable summary on every queue item.",
      "- 引导页是任务目标的落地页——源指令保存在这里。",
    ].join("\n"),
    absolutePath: "/Users/x/code/workspace/STEERING.md",
    mtime: "2025-09-01T08:00:00.000Z",
    byteCount: 360,
  },
  roadmapRail: null,
  laneRails: [],
  unavailableSources: [],
};

// 面板 2：MISSION_BRIEF.md 内容（固定 schema——字节精确的标题与顺序）。
export const missionBriefMd = [
  "# release-1.0.0 — Brief (example)",
  "_An example workspace observability brief._",
  "",
  "## What & why",
  "用于演示已锁定七节文档类型的示例任务简报。",
  "",
  "## Building",
  "Example tabs and surfaces in flight.",
  "",
  "## Progress",
  "Example wave A shipped; example wave B in flight.",
  "",
  "## Proven",
  "Example proof items rendered through the twin.",
  "",
  "## Needs you",
  "Review the example design mockups — approval unblocks the next wave.",
  "",
  "## Pointers",
  "→ MISSION_NOTES.md · → PROGRESS.md · → the Proof tab.",
].join("\n");

// --- 产物高度 文件导航器 -------------------------------------------------------------
// GET /api/files/list?root=&path= -> 每个文件夹的条目（目录优先，与后台服务一致）。
// 按 TWIN_WORKSPACE_ROOT 下的 relPath 建键，使导航器的逐文件夹惰性列举经 twin fetch
// 桩解析。mtime/size 直接来自这里。
import type { FileEntry } from "../src/hooks/useFiles.js";
export const artifactsTreeByPath: Record<string, FileEntry[]> = {
  "missions/release-1.0.0": [
    { name: "slices", type: "dir", size: null, mtime: "2025-09-01T22:52:00.000Z" },
    { name: "digital-twin", type: "dir", size: null, mtime: "2025-09-01T01:34:00.000Z" },
    { name: "README.md", type: "file", size: 4096, mtime: "2025-09-01T22:01:00.000Z" },
    { name: "PROGRESS.md", type: "file", size: 3170, mtime: "2025-09-01T05:00:00.000Z" },
    { name: "MISSION_BRIEF.md", type: "file", size: 1284, mtime: "2025-09-01T08:30:00.000Z" },
  ],
  "missions/release-1.0.0/slices": [
    { name: "01-seat-restore", type: "dir", size: null, mtime: "2025-09-01T01:55:00.000Z" },
    { name: "02-twin-harness", type: "dir", size: null, mtime: "2025-09-01T02:05:00.000Z" },
    { name: "05-workspace-ux", type: "dir", size: null, mtime: "2025-09-01T22:52:00.000Z" },
    { name: "07-mission-steering-tab", type: "dir", size: null, mtime: "2025-09-01T08:35:00.000Z" },
  ],
  "missions/release-1.0.0/slices/05-workspace-ux": [
    { name: "README.md", type: "file", size: 4096, mtime: "2025-09-01T22:01:00.000Z" },
    { name: "rescope-2025-09-01.md", type: "file", size: 3174, mtime: "2025-09-01T05:00:00.000Z" },
    { name: "batch-1.change.diff", type: "file", size: 12288, mtime: "2025-09-01T22:52:00.000Z" },
    { name: "03-story-dag.intent.png", type: "file", size: 129024, mtime: "2025-09-01T22:53:00.000Z" },
    { name: "01-02-altitude-steering.intent.png", type: "file", size: 142336, mtime: "2025-09-01T22:52:00.000Z" },
  ],
  "missions/release-1.0.0/digital-twin": [
    { name: "example-mockup-01", type: "dir", size: null, mtime: "2025-09-01T01:34:00.000Z" },
  ],
};
