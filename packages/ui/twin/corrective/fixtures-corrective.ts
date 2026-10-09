// CORRECTIVE REDESIGN 2026-07-05——单一结构评审契约（§3.1）的 twin fixture，
// 以 src/hooks/useReview.ts 为类型基准，构成 tsc 漂移守卫。使用虚构的 acme/EX.2.0.0
// 系列。场景覆盖：一个 UI slice（计划 mockup + 精选证明 + 已验证/未验证/缺失 + extraProof +
// plan-locked/proof-pending）和一个非 UI slice（§5：无 plannedRef，不作为门禁）。
// 所有查找均降级处理（?? / 未命中 → 404），绝不在模块求值时抛错。

import type {
  ComposedSliceReview,
  ComposedMissionReview,
  ReviewMedia,
  NeedsYouBand,
  AgentsBand,
  VerifyLineage,
} from "../../src/hooks/useReview.js";
import type { SliceDetail, SliceListEntry, QueueItemDetail } from "../../src/hooks/useSlices.js";
import { walkthroughWebmDataUri } from "./media-webm.js";

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** 计划中的 mockup，即规划智能体锁定的内容。 */
const plannedMockup: ReviewMedia = {
  kind: "image",
  src: svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">
      <rect width="640" height="400" fill="#faf9f5"/>
      <text x="20" y="30" font-family="monospace" font-size="13" fill="#57534e">计划样机——390px 评审栈</text>
      <rect x="20" y="44" width="290" height="60" fill="#fff" stroke="#d6d3d1"/><text x="30" y="80" font-family="monospace" font-size="12" fill="#292524">意图</text>
      <rect x="20" y="112" width="290" height="90" fill="#fff" stroke="#d6d3d1"/><text x="30" y="148" font-family="monospace" font-size="12" fill="#292524">计划 + 样机</text>
      <rect x="20" y="210" width="290" height="150" fill="#fff" stroke="#d6d3d1"/><text x="30" y="246" font-family="monospace" font-size="12" fill="#292524">已交付（配对证明）</text>
    </svg>`,
  ),
  caption: "计划：390px 三段式结构（已锁定样机）",
};

/** 精选的已交付产物。 */
const deliveredShot: ReviewMedia = {
  kind: "image",
  src: svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">
      <rect width="640" height="400" fill="#faf9f5"/>
      <text x="20" y="30" font-family="monospace" font-size="13" fill="#166534">已交付——390px 评审栈（真实构建）</text>
      <rect x="20" y="44" width="290" height="60" fill="#fff" stroke="#a3a3a1"/><text x="30" y="80" font-family="monospace" font-size="12" fill="#292524">意图</text>
      <rect x="20" y="112" width="290" height="90" fill="#fff" stroke="#a3a3a1"/><text x="30" y="148" font-family="monospace" font-size="12" fill="#292524">计划 + 样机</text>
      <rect x="20" y="210" width="290" height="150" fill="#fff" stroke="#a3a3a1"/><text x="30" y="246" font-family="monospace" font-size="12" fill="#292524">已交付（配对证明）</text>
    </svg>`,
  ),
  caption: "已交付：390px 构建结果——QA 已与锁定样机对比",
};

const drawerShot: ReviewMedia = {
  kind: "image",
  src: svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">
      <rect width="640" height="360" fill="#faf9f5"/>
      <rect x="380" y="0" width="260" height="360" fill="#fff" stroke="#d6d3d1"/>
      <text x="392" y="28" font-family="monospace" font-size="12" fill="#292524">PROOF.md——阅读抽屉（右侧）</text>
      <text x="20" y="30" font-family="monospace" font-size="12" fill="#a8a29e">后方页面内容</text>
    </svg>`,
  ),
  caption: "证据在共享右侧抽屉中打开",
};

const videoPoster = svgDataUri(
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360">
    <rect width="640" height="360" fill="#292524"/>
    <circle cx="320" cy="180" r="36" fill="#faf9f5" opacity="0.9"/>
    <path d="M308 160 L344 180 L308 200 Z" fill="#292524"/>
    <text x="20" y="340" font-family="monospace" font-size="12" fill="#a8a29e">演练——6 秒，可见帧计数</text>
  </svg>`,
);

/** §7.3 表面环节——真实可播放媒体（内联 VP8 字节）。 */
export const walkthroughVideo: ReviewMedia = {
  kind: "video",
  src: walkthroughWebmDataUri,
  poster: videoPoster,
  caption: "演练（6 秒）——批准 + 对话流程；帧计数证明视频正在播放",
};

const PROV = "根据队列、ps、证明产物和 git 计算 · 截至 9 月 1 日 03:12";

const needsYou07: NeedsYouBand = {
  provenance: PROV,
  items: [
    {
      source: "agent",
      identity: "qitem-ex2-07-gate",
      summary: "为合并队列签核评审界面重建",
      leg: "attention",
      where: "EX.2.0.0.07",
      ageIso: "2025-09-01T01:12:00.000Z",
      priority: "urgent",
      tier: "human-gate",
      evidenceRef: "PROOF.md",
      unblocks: "进入合并队列",
      qitemId: "qitem-ex2-07-gate",
      destinationSession: "human-mike@host",
      derived: null,
    },
    {
      source: "derived",
      identity: "derived:capture-2:stuck",
      summary: "capture-2 似乎卡在深色模式对等截图（缺失的交付项）",
      leg: "exception",
      where: "EX.2.0.0.07",
      ageIso: "2025-09-01T02:40:00.000Z",
      priority: null,
      tier: null,
      evidenceRef: null,
      unblocks: null,
      qitemId: null,
      destinationSession: null,
      derived: { kind: "stuck", evidence: "持有 1 个已分配事项时空闲 47 分钟", threshold: "有工作时空闲 ≥ 30 分钟" },
    },
  ],
};

const agents07: AgentsBand = {
  scope: "slice:EX.2.0.0.07",
  provenance: PROV,
  coordinationHealth: "今天 4 次移交 · 0 项逾期",
  rows: [
    { agentName: "builder2", runtime: "claude-code", stateGlyph: "active", doing: "打磨评审栈的 Vellum 视觉", holdsCount: 1, lastTransitionIso: "2025-09-01T02:58:00.000Z", exception: null, sessionName: "builder2@acme-build", slices: ["EX.2.0.0.07"] },
    { agentName: "qa-1", runtime: "codex", stateGlyph: "parked", doing: "保管样机与交付结果的对比记录", holdsCount: 1, lastTransitionIso: "2025-09-01T02:10:00.000Z", exception: null, sessionName: "qa-1@acme-build", slices: ["EX.2.0.0.07"] },
    { agentName: "capture-2", runtime: "claude-code", stateGlyph: "unknown", doing: "深色模式对等截图（已分配）", holdsCount: 1, lastTransitionIso: "2025-09-01T02:13:00.000Z", exception: { kind: "stuck", evidence: "持有已分配工作时空闲 47 分钟", threshold: "≥ 30 分钟" }, sessionName: "capture-2@acme-build", slices: ["EX.2.0.0.07"] },
  ],
};

const lineage07: VerifyLineage = {
  candidateSha: "4e91ab77",
  mergeSha: null,
  mainTip: "c27f2aff",
  freshness: "fresh",
  staleBehind: null,
  gateCells: [
    { role: "guard", recordedToken: "CLEAR", tone: "pass", state: "passing", source: "proof/guard-verdict.md" },
    { role: "qa", recordedToken: "PASS", tone: "pass", state: "passing", source: "proof/qa-verdict.md" },
    { role: "rev1-r1", recordedToken: "CLEAR", tone: "pass", state: "passing", source: "proof/rev1-r1.md" },
    { role: "rev1-r2", recordedToken: null, tone: "unknown", state: "missing", source: null },
  ],
};

/** UI slice——dogfood 场景（§9）：由重建后的表面评审自身。 */
const review07: ComposedSliceReview = {
  slice: "EX.2.0.0.07",
  sliceId: "07",
  title: "评审界面重建：单一结构栈（示例）",
  missionId: "release-2.0.0",
  phase: "review",
  laneLabel: "REVIEW",
  composedAt: "2025-09-01T03:12:00.000Z",
  intent: {
    text: "打开切片时，我希望按单列从上到下查看：最初意图、形成的计划，以及已构建内容的证明。截图应与其证明对象配对，无需四处查找。",
    media: [],
    ssotPath: "README.md",
    degrade: null,
  },
  plan: {
    concise: {
      text: [
        "**最小需求**",
        "1. 只保留一个纵向结构：意图 → 计划 → 已交付；优先适配 390px 手机宽度。",
        "2. 每个计划交付项与精选证明配对；逐项显示 QA 对比结论。",
        "3. 各处都提供快速操作：批准 + 对话；媒体可实际播放；点阵网格上使用 Vellum 卡片。",
      ].join("\n"),
      media: [plannedMockup],
    },
    lockedArtifacts: [
      { name: "IMPLEMENTATION-PRD.md", path: "IMPLEMENTATION-PRD.md", kind: "prd" },
      { name: "stack-mockup.png", path: "mockups/stack-390.png", kind: "mockup" },
    ],
    lock: { by: "human-mike@host", at: "Aug 30", auditVerified: true },
    ssotPath: "IMPLEMENTATION-PRD.md",
  },
  delivered: {
    items: [
      {
        promised: { text: "评审标签页以 390px 单列呈现意图 → 计划 → 已交付结构", plannedRef: plannedMockup },
        proof: [deliveredShot],
        verified: "verified",
        note: "已与锁定样机对比——结构一致；间距偏差小于 2px（对比记录位于 proof/）",
      },
      {
        promised: { text: "演练视频：批准 + 对话端到端流程" },
        proof: [walkthroughVideo],
        verified: "verified",
        note: "已完整观看 6 秒视频——两个操作均生效，终端前导文本正确",
      },
      {
        promised: { text: "证据在共享右侧抽屉中打开", plannedRef: drawerShot },
        proof: [drawerShot],
        verified: "unverified",
      },
      {
        promised: { text: "完整评审栈的深色模式对等截图" },
        proof: [],
        verified: "missing",
        note: "已退回——该事项由 capture-2 持有",
      },
    ],
    extraProof: [
      { kind: "image", src: videoPoster, caption: "视频静帧——演练主画面（未绑定到单个交付项）" },
    ],
    lock: null,
    proofDirPath: "proof/",
  },
  needsYou: needsYou07,
  agents: agents07,
  lineage: lineage07,
  defects: [],
};

/** 非 UI slice（§5）——没有 mockup、没有 plannedRef，以自身方式提供证明。 */
const review08: ComposedSliceReview = {
  slice: "EX.2.0.0.08",
  sliceId: "08",
  title: "证明投递 CLI 扩展：交付项与校验参数（示例）",
  missionId: "release-2.0.0",
  phase: "building",
  laneLabel: "BUILD",
  composedAt: "2025-09-01T03:12:00.000Z",
  intent: {
    text: "QA 投递证明时应说明它对应哪个承诺交付项，以及是否实际完成了对比，这样界面即可可靠配对和标记，无需猜测。",
    media: [],
    ssotPath: "README.md",
    degrade: null,
  },
  plan: {
    concise: {
      text: "**最小需求**\n1. `zrig proof <slice>` 增加 `--deliverable`、`--verified` 和 `--note` 参数（扩展现有动词，不新增动词）。\n2. 没有对比结论的投递必须让交付项明确显示为未校验。",
      media: [],
    },
    lockedArtifacts: [{ name: "IMPLEMENTATION-PRD.md", path: "IMPLEMENTATION-PRD.md", kind: "prd" }],
    lock: { by: "lead@acme-build", at: "Aug 31", auditVerified: true },
    ssotPath: "IMPLEMENTATION-PRD.md",
  },
  delivered: {
    items: [
      {
        promised: { text: "CLI 接受 --deliverable，并将其记录到 C1 头部" },
        proof: [{ kind: "image", src: drawerShot.src, caption: "终端记录——扩展后的投递（文本证明；非 UI 切片）" }],
        verified: "verified",
        note: "已针对 fixture 切片执行投递；头部包含交付项引用",
      },
      {
        promised: { text: "没有对比结论的投递会组合为未校验状态" },
        proof: [],
        verified: "missing",
      },
    ],
    extraProof: [],
    lock: null,
    proofDirPath: "proof/",
  },
  needsYou: { provenance: PROV, items: [] },
  agents: {
    scope: "slice:EX.2.0.0.08",
    provenance: PROV,
    coordinationHealth: null,
    rows: [
      { agentName: "cli-dev1", runtime: "codex", stateGlyph: "active", doing: "扩展证明动词参数", holdsCount: 1, lastTransitionIso: "2025-09-01T02:50:00.000Z", exception: null, sessionName: "cli-dev1@acme-build", slices: ["EX.2.0.0.08"] },
    ],
  },
  lineage: {
    candidateSha: null,
    mergeSha: null,
    mainTip: "c27f2aff",
    freshness: "unknown",
    staleBehind: null,
    gateCells: [
      { role: "guard", recordedToken: null, tone: "unknown", state: "missing", source: null },
      { role: "qa", recordedToken: null, tone: "unknown", state: "missing", source: null },
      { role: "rev1-r1", recordedToken: null, tone: "unknown", state: "missing", source: null },
      { role: "rev1-r2", recordedToken: null, tone: "unknown", state: "missing", source: null },
    ],
  },
  defects: [],
};

export const correctiveReviewBySlice: Record<string, ComposedSliceReview> = {
  "EX.2.0.0.07": review07,
  "EX.2.0.0.08": review08,
};

export const correctiveMissionReview: Record<string, ComposedMissionReview> = {
  "release-2.0.0": {
    mission: "release-2.0.0",
    missionId: "release-2.0.0",
    title: "版本 2.0.0（示例）",
    intent: "交付修正后的评审界面——单一结构、配对证明、如实校验。",
    briefSpine: {
      building: "1 个切片正在构建（CLI 扩展）。",
      progress: "1 个评审中 · 1 个构建中。",
      proven: "重建候选版本已记录 guard、qa 和 rev1-r1。",
      needsYou: "1 项签核待处理 + 1 项派生异常。",
    },
    board: [
      { slice: "EX.2.0.0.07", title: "评审界面重建（示例）", phase: "review", laneLabel: "REVIEW", agentsCount: 3, stageCell: "4 项证明中 2 项已验证", changedSinceStamp: false, attentionWorthy: true },
      { slice: "EX.2.0.0.08", title: "证明投递 CLI 扩展（示例）", phase: "building", laneLabel: "BUILD", agentsCount: 1, stageCell: "按计划进行", changedSinceStamp: false, attentionWorthy: false },
    ],
    ledger: [
      { slice: "EX.2.0.0.07", candidateSha: "4e91ab77", gateCells: lineage07.gateCells, mergeSha: null, needsHumanCount: 1, green: false },
    ],
    cutComplete: false,
    cutCompleteBasis: "EX.2.0.0.07 尚未合并，rev1-r2 尚未完成",
    needsYou: needsYou07,
    agents: { ...agents07, scope: "mission:release-2.0.0" },
    composedAt: "2025-09-01T03:12:00.000Z",
  },
};

// --- Slice 页面前置数据（/api/slices + /api/slices/:id）---

export const correctiveSlices: SliceListEntry[] = [
  {
    name: "EX.2.0.0.07",
    missionId: "release-2.0.0",
    displayName: "评审界面重建：单一结构栈（示例）",
    railItem: "07",
    status: "active",
    rawStatus: "review",
    qitemCount: 1,
    hasProofPacket: true,
    lastActivityAt: "2025-09-01T03:10:00.000Z",
    slicePath: "/Users/x/code/workspace/missions/release-2.0.0/slices/07-review-stack",
  },
];

export const correctiveDetailByName: Record<string, SliceDetail> = {
  "EX.2.0.0.07": {
    name: "EX.2.0.0.07",
    missionId: "release-2.0.0",
    slicePath: "/Users/x/code/workspace/missions/release-2.0.0/slices/07-review-stack",
    displayName: "评审界面重建：单一结构栈（示例）",
    railItem: "07",
    status: "active",
    rawStatus: "review",
    qitemIds: ["qitem-ex2-07-gate"],
    commitRefs: ["4e91ab77"],
    lastActivityAt: "2025-09-01T03:10:00.000Z",
    workflowBinding: null,
    story: { events: [], phaseDefinitions: null },
    acceptance: { totalItems: 4, doneItems: 2, percentage: 50, items: [], closureCallout: null, currentStep: null },
    decisions: { rows: [] },
    docs: { tree: [
      { name: "README.md", type: "file", size: 900, mtime: "2025-08-30T10:00:00.000Z", relPath: "README.md" },
      { name: "IMPLEMENTATION-PRD.md", type: "file", size: 4100, mtime: "2025-08-30T12:00:00.000Z", relPath: "IMPLEMENTATION-PRD.md" },
      { name: "PROOF.md", type: "file", size: 1600, mtime: "2025-09-01T02:40:00.000Z", relPath: "PROOF.md" },
    ] },
    tests: { proofPackets: [], aggregate: { passCount: 2, failCount: 0 } },
    topology: { affectedRigs: [{ rigId: "rig_alpha", rigName: "acme-build", sessionNames: ["builder2@acme-build", "qa-1@acme-build"] }], totalSeats: 2, specGraph: null },
  },
};

export const correctiveQitemById: Record<string, QueueItemDetail> = {
  "qitem-ex2-07-gate": {
    qitemId: "qitem-ex2-07-gate",
    tsCreated: "2025-09-01T01:12:00.000Z",
    tsUpdated: "2025-09-01T01:12:00.000Z",
    sourceSession: "qa-1@acme-build",
    destinationSession: "human-mike@host",
    state: "pending",
    priority: "urgent",
    tier: "human-gate",
    tags: ["mission:release-2.0.0", "slice:EX.2.0.0.07", "sign-off"],
    body: "评审界面重建仍在等待门控：4 个交付项中 2 个已由 QA 校验，演练视频已完整观看。rev1-r2 完成后请为合并队列签核。",
    summary: "为合并队列签核评审界面重建",
    chainOfRecord: null,
    blockedOn: null,
  },
};

// --- 右侧抽屉的证据 Markdown（/api/files/read）---

export const correctiveMdByPath: Record<string, string> = {
  "missions/release-2.0.0/slices/07-review-stack/PROOF.md": [
    "# 证明——EX.2.0.0.07 评审界面重建",
    "",
    "精选集合（规范的“当前呈现效果”）：",
    "- 390px 评审栈：`proof/stack-390-delivered.png`——已由 QA 对照锁定样机校验",
    "- 演练：`proof/walkthrough.webm`——已由 QA 校验（完整观看）",
    "- 抽屉截图：`proof/drawer-right.png`——未校验（尚未记录对比）",
    "- 深色模式对等截图：**缺失**（已退回 capture-2）",
  ].join("\n"),
  "missions/release-2.0.0/slices/07-review-stack/IMPLEMENTATION-PRD.md": [
    "# IMPLEMENTATION-PRD — EX.2.0.0.07",
    "",
    "## 最小需求",
    "1. 只保留一个纵向结构：意图 → 计划 → 已交付；优先适配 390px 手机宽度。",
    "2. 交付项与证明配对，并逐项记录 QA 校验。",
    "",
    "## 校验契约",
    "- 评审标签页以 390px 呈现结构（样机：`mockups/stack-390.png`）",
    "- 演练视频：批准 + 对话端到端流程",
    "- 证据在共享右侧抽屉中打开",
    "- 深色模式对等截图",
  ].join("\n"),
};
