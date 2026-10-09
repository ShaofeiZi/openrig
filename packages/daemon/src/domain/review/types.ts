// Living Notes —— 组合评审读取契约（OPR.0.4.4.20，依据 2026-07-05 的纠偏重设计重建）。
//
// 所有消费者共用一份契约：切片评审标签页、任务目标面板的 U5 行展开以及“为你推荐”
// 展开都读取这些结构；智能体投影在同一契约上按 scope 参数化
//（slice:<id> | mission:<id> | rig），绝不另设第二个端点。
//
// 纠偏 §3.1 —— 切片评审是由三个区段组成的单一纵向堆栈：
// INTENT → PLAN → DELIVERED。原实现携带的四套并行可渲染结构
//（sections / acceptance / join / compare）已删除，而非降级保留；独立的双制度
// `green` 字段也已移除（§11），其已记录判定的严谨性转化为每项交付物的 `verified` 信号。
//
// 填充这些结构的组合器是纯函数：相同输入（包括调用方提供的 `nowIso`、`mainTip` 等
// 查看时事实）会产生字节完全相同的输出。每个区段都指明自己的 SSOT，并在缺失时降级为
// 已声明的值，绝不编造内容。

// --- C1 标头（已批准的封闭集合——Packet 1 FR-8；扩展它们属于约定变更，而非代码决策）---

export const C1_ARTIFACT_TYPES = ["guard", "qa", "rev1-r1", "rev1-r2", "adjudication"] as const;
export type C1ArtifactType = (typeof C1_ARTIFACT_TYPES)[number];

export const C1_VERDICTS = ["CLEAR", "BLOCKING", "CONCERNING", "PASS", "NOT-CLEAR"] as const;
export type C1Verdict = (typeof C1_VERDICTS)[number];

export interface ProofArtifact {
  /** 相对于切片目录的路径（proof/<file>.md）。 */
  relPath: string;
  slice: string | null;
  candidateSha: string | null;
  artifactType: C1ArtifactType | null;
  /** 按原样记录的 token。null 表示缺失或不在集合内（计为 MISSING）。 */
  verdict: C1Verdict | null;
  moneyEvidence: string | null;
  /** D2 证明（可选 C1 字段）。 */
  evidences: string[];
  selfCheck: string | null;
  /** 在制品正文中发现的媒体引用（保持原写法，相对于 proof 目录）；
   *  组合器将其筛选整理到 `delivered.items[].proof`（§3.4）。 */
  mediaRefs: string[];
  /** 文件 mtime 的 ISO 值，用于在 (slice, candidate_sha, artifact_type) 内按最新者胜出打破平局。 */
  droppedAt: string;
}

// --- FR-2：已记录判定 + 验证谱系（保留；门禁标签按原样渲染已记录 token，
// 独立 green 读数已移除，见 §11）---

/** 派生 TONE 仅用于着色；标签文本始终按原样显示已记录 token（G1）。 */
export type VerdictTone = "pass" | "fail" | "unknown";

export type GateRole = "guard" | "qa" | "rev1-r1" | "rev1-r2";
export const GATE_ROLES: GateRole[] = ["guard", "qa", "rev1-r1", "rev1-r2"];

export interface VerdictCell {
  role: GateRole;
  /** 按原样记录的 token；在制品缺失或没有有效判定时为 null。 */
  recordedToken: C1Verdict | null;
  tone: VerdictTone;
  /** 按固定映射取 "passing"；"missing" 同时涵盖制品缺失以及制品存在但没有判定。 */
  state: "passing" | "non-passing" | "missing";
  /** 胜出（最新）制品的 proof/<file> 相对路径，或 null。 */
  source: string | null;
}

export interface VerifyLineage {
  /** N1：三个查看时事实始终全部渲染，标签由它们推导。 */
  candidateSha: string | null;
  /** null = UNMERGED（明确的谱系事实，绝不是切片层级的前置条件）。 */
  mergeSha: string | null;
  mainTip: string;
  /** 按 N1 规则从三个事实推导；绝不会脱离它们单独渲染。 */
  freshness: "fresh" | "stale" | "unknown";
  /** 合并前状态过期时落后 tip 的提交数，其他情况为 null。 */
  staleBehind: number | null;
  gateCells: VerdictCell[];
}

// --- 纠偏 §3.1 —— 唯一结构的构建块 ---

/** 内联媒体（筛选后的证明、规划的模型图）。在后台服务契约中，`src` 是相对于切片的
 *  路径（UI 负责构建资源 URL）；twin 的 fixture 在相同结构中内联 data: URI。 */
export interface ReviewMedia {
  kind: "image" | "video";
  src: string;
  poster?: string;
  caption: string;
}

/** 两种明确印章之一（§4）：plan-lock 是已发布的 `--scope spec` 分阶段审批印章；
 *  proof-lock 是 `--scope delivery` 印章（scope.ts 分阶段审批：frontmatter 印章 +
 *  审计行）。`auditVerified: false` 会醒目渲染 UNVERIFIED 印章状态。 */
export interface LockState {
  by: string;
  at: string;
  auditVerified: boolean;
}

/** 一项固定的计划制品（“将构建这组内容”）：读取切片 README 的 frontmatter
 *  `locked-artifacts:`，绝不引入新的写入机制。 */
export interface LockedArtifact {
  name: string;
  path: string;
  kind: string;
}

/** §3.1 delivered.items[] —— 重设计后的关联：每项计划交付物与其筛选后的证明及 QA
 *  已记录的比较信号配对。`verified` 绑定到已发布的 C1 字段（artifact_type 为
 *  qa|adjudication，加上 evidences/self_check 以及通过的已记录判定），绝不只看制品
 *  是否存在。采用开放失败：unverified/missing 会明显显示为不完整，但绝不阻塞。 */
export interface DeliveredItem {
  promised: { text: string; plannedRef?: ReviewMedia };
  proof: ReviewMedia[];
  verified: "verified" | "unverified" | "missing";
  note?: string;
}

// --- FR-3：派生阶段（五种状态，自上而下确定优先级——保留）---

export const REVIEW_PHASES = ["locked", "review", "building", "spec", "intent"] as const;
export type ReviewPhase = (typeof REVIEW_PHASES)[number];

/** BR-10 渲染词汇（SS14）。派生名称一一映射，只有展示标签不同。 */
export const PHASE_LANE_LABELS: Record<ReviewPhase, string> = {
  intent: "INTENT",
  spec: "PLAN",
  building: "BUILD",
  review: "REVIEW",
  locked: "LOCKED",
};

// --- FR-4：需要你处理 + 智能体（保留；两者正交且已验证可靠）---

export interface DerivedException {
  /** OPR.0.4.6.WF5 FR-3 增加工作流来源的类型："workflow-failed"（失败实例没有
   *  条目时的 ▲ 兜底，本身也能证明存在缺陷）；"awareness"（由 ORCHESTRATOR 路由的
   *  异常所对应的人类已知行：持有者 + 时长，与待办不同，绝不凭空派生）；"anomaly"
   *  （frontier 引用了非开放 packet，是 WF-3 FR-6 预防保护之后的检测兜底）。 */
  kind: "stuck" | "overdue" | "insufficient-proof" | "stale-after-change" | "workflow-failed" | "awareness" | "anomaly";
  /** 内联证据，绝不只给结论（例如“空闲 47 分钟 >= 默认 30 分钟 · 持有 2 项”）。 */
  evidence: string;
  /** 被越过且用户可见的 v1 阈值。 */
  threshold: string;
}

/** OPR.0.4.6.WF4 Q6（架构裁定）—— 所有属于工作流实例的关注行只使用这一种结构化
 *  工作流身份关联。后台服务端只盖章一次；UI 路由工作流时只读取该指针，绝不从
 *  identity/evidenceRef/summary 的自然语言中推断。该结构只包含三个身份键，不包含
 *  status/deadline/class（这些字段位于实例载荷）。行并非来自工作流时省略该字段，
 *  通过省略保证字节一致性。 */
export interface WorkflowRowRef {
  instanceId: string;
  workflowName: string;
  stepId?: string;
}

export interface NeedsYouItem {
  /** "agent" = ●（智能体发起的环节）；"derived" = ▲（组合器异常）。两者等级相同。 */
  source: "agent" | "derived";
  /** OPR.0.4.6.WF4 Q6 —— 仅工作流来源的行包含此字段，不存在时省略。 */
  workflow?: WorkflowRowRef;
  /** 单次计数身份：qitem ID，或 ▲ 元组键 "seat-or-slice|kind|since"。 */
  identity: string;
  summary: string;
  leg: string;
  where: string;
  ageIso: string | null;
  priority: string | null;
  tier: string | null;
  evidenceRef: string | null;
  /** 计算得到它会解除阻塞的对象（park 关系），或 null。 */
  unblocks: string | null;
  /** #6 读取契约成员：可操作 qitem 的真实目标/操作者身份。 */
  qitemId: string | null;
  destinationSession: string | null;
  derived: DerivedException | null;
}

export interface NeedsYouBand {
  items: NeedsYouItem[];
  /** U4：证明为空/计算来源的溯源行，始终存在。 */
  provenance: string;
}

// --- FR-4 SSOT：共享智能体行结构（两个 scope 均严格按此渲染）---

export type AgentsScope = `slice:${string}` | `mission:${string}` | "rig";

export interface AgentRow {
  agentName: string;
  runtime: "claude-code" | "codex" | "terminal" | "unknown";
  /** 遥测不可用时如实标为 unknown，绝不猜测；parked 必须由队列证实。 */
  stateGlyph: "active" | "parked" | "idle" | "unknown";
  /** C6 自然语言 "doing" 行。 */
  doing: string | null;
  holdsCount: number;
  lastTransitionIso: string | null;
  /** 派生异常指向该智能体时，使用带内联证据的 ▲ 标记。 */
  exception: DerivedException | null;
  sessionName: string;
  /** 在任务目标 scope 下用于归组该行的切片 ID。 */
  slices: string[];
}

export interface AgentsBand {
  scope: AgentsScope;
  rows: AgentRow[];
  /** BR-11 溯源信息（证明为空时也携带，区域绝不留空）。 */
  provenance: string;
  coordinationHealth: string | null;
}

// --- OPR.0.4.4.22（slice 22）：工作组 scope 的独立层级根（保留）---
// 与 ComposedSliceReview / ComposedMissionReview 属于同一契约族；这里是 slice-22 PRD
// 新增的智能体 scope 查询成员，绝不另建第二个契约族。

/** 一次已完成交接（记录区）：当天关闭的交接每项一行，使用 C6 摘要
 *  （BR-10，优先自然语言）。 */
export interface SettledRow {
  fromSession: string;
  toSession: string;
  /** qitem 的 C6 摘要；为 null 时渲染降级为 qitem ID。 */
  summary: string | null;
  closedAtIso: string;
  qitemId: string;
}

/** 组合后的工作组智能体读取根（slice 22 FR-1..FR-4）：工作组 scope 下的需要你处理 +
 *  智能体（含协调健康状态）+ 已完成。它是队列与 ps 的纯投影，智能体不为其编写内容。 */
export interface ComposedRigAgents {
  scope: "rig";
  needsYou: NeedsYouBand;
  agents: AgentsBand;
  settled: SettledRow[];
  /** BR-11：证明为空时也携带溯源信息，区域绝不留空。 */
  settledProvenance: string;
  composedAt: string;
}

// --- OPR.0.4.6.MH5：FLEET 聚合契约（架构 Q2：位于逐主机层级之上的同级聚合界面，
// 绝不是第四种 AgentsScope 值；AgentsScope 始终严格为三种）。契约归属位置在此，紧邻
// ComposedRigAgents（计划 D-3：twin 的 fixture 模块曾充当模拟替身）。fleet 根只对各主机
// 自己的组合集合执行 UNION + 主机维度 + 计数（架构 Q1：每台主机对自己按时间派生的 ▲
// 具有权威性，fleet 绝不重新计算异常事实）。---

import type { PerHostStatus } from "../hosts/fanout-contract.js";

/** 一条 fleet 需要你处理行：逐主机行按原样携带，不区分 kind；主机组合出的任何
 *  DerivedException 都会透传，WF-4 Q6 `workflow` 指针保持不变且缺失时省略；另外添加
 *  主机维度和单次计数溯源。 */
export interface FleetNeedsYouItem extends NeedsYouItem {
  hostId: string;
  /** Q4 单次计数键 `${hostId}|${identity}`，即 fleet Set 的键；在展开抽屉中按原样
   *  渲染，作为可检查身份。 */
  fleetKey: string;
  /** FR-3 溯源：该身份在所属主机上可见的层级 scope。根据 fan-out 实际读取的内容记录
   *  （v1 读取每台主机的工作组根，D-1），因此单次计数可检查，而非仅靠断言。 */
  seenFrom: string[];
}

/** HOSTS 区的逐主机汇总。只有读取到该主机的组合集合（status.status === "ok"）时
 *  才包含计数字段；不可达主机的条目在概览中是缺失，而不是零，这是专门防范的
 *  k9s stale-header 反模式。`status` 是已发布且封闭的逐主机可达性契约，保持不变；
 *  逐项异常属于独立的 DerivedException 轴，绝不混为一谈。 */
export interface FleetHostRollup {
  hostId: string;
  kind: "local" | "remote";
  status: PerHostStatus;
  /** 从该主机去重后的 fleet 行计算计数，只执行集合并运算。 */
  needsYouCount?: number;
  /** 按行自身 kind 字符串分组的 ▲ 计数，对 kind 不作预设。 */
  exceptionsByKind?: Array<{ kind: string; count: number }>;
  /** 来自该主机自身组合后的智能体区。 */
  seatCount?: number;
  /** 该主机智能体行中不同工作组名称的数量；依据 BR-1 member@rig 会话语法进行结构化
   *  解析，绝不从自然语言中推断。 */
  rigCount?: number;
  /** 最严重的一行，即口头描述该工厂时会说的内容；从主机去重后的行确定性推导，
   *  计数为零时为 "quiet"。 */
  topLine?: string;
}

/** 标头汇总算法，从去重后的 fleet 行计算，满足 twin 的“标头算法可与各区核对”属性。 */
export interface ComposedFleetRollup {
  /** 去重后 fleet 并集中 source 为 "agent" 的 ● 行。 */
  needsYouCount: number;
  /** 去重后 fleet 并集中 source 为 "derived" 的 ▲ 行。 */
  exceptionCount: number;
  exceptionsByKind: Array<{ kind: string; count: number }>;
  /** 载荷中的所有 fleet 成员，包括本机和所有已注册主机。 */
  hostCount: number;
  /** 状态不为 "ok" 的主机数量；其条目为缺失，而不是零。 */
  unreachableCount: number;
}

/** fleet 层级的已完成行：按 placement-lock 的 ride-item 默认值（D-5）保持最小结构，
 *  并带主机标签。 */
export interface FleetSettledRow extends SettledRow {
  hostId: string;
}

/** 组合后的 fleet 读取根（`GET /api/review/fleet`）：唯一的聚合对象，两个由创始人锁定
 *  的界面（/fleet 路由页面和 FLEET 区）都渲染它。这里只负责读取与展示（FR-5），
 *  操作能力沿用 MH-3/MH-4。 */
export interface ComposedFleet {
  rollup: ComposedFleetRollup;
  needsYou: { items: FleetNeedsYouItem[]; provenance: string };
  /** 每个 fleet 成员一项，本机优先，其后按注册表顺序排列。每个成员及其状态都必须出现
   *  （防遗漏，遵循 AggregatedPayload 约定）；只有 "ok" 行带计数，缺失不等同于零。 */
  hosts: FleetHostRollup[];
  settled: FleetSettledRow[];
  settledProvenance: string;
  /** 仅在主机注册表存在但加载/解析失败时出现，并如实显示；绝不静默退化为只有本机的
   *  fleet。注册表不存在（单主机操作员）或成功加载时省略。 */
  registryError?: string;
  composedAt: string;
}

// --- 组合后的切片评审（读取契约根——纠偏 §3.1）---

/** §3.1 —— 唯一结构，即磁盘制品的投影。每个区段始终参与组合；来源缺失时降级为弱化的
 *  "—" 行，绝不编造，也绝不阻塞。 */
export interface ComposedSliceReview {
  readiness?: import("../proof/judgments.js").ScopeReadiness;
  slice: string;
  sliceId: string | null;
  title: string;
  missionId: string | null;
  phase: ReviewPhase;
  laneLabel: string;
  /** §1 —— 按原样记录的意图，通常为文本。 */
  intent: {
    text: string | null;
    media: ReviewMedia[];
    ssotPath: string | null;
    degrade: string | null;
  };
  /** §2 —— 小型需求 + 计划模型图；已固定的锁定集合；plan-lock。 */
  plan: {
    concise: { text: string | null; media: ReviewMedia[] };
    lockedArtifacts: LockedArtifact[];
    lock: LockState | null;
    ssotPath: string | null;
  };
  /** §3 —— 重设计后的关联：计划项 ↔ 筛选后的证明 ↔ QA 验证。 */
  delivered: {
    items: DeliveredItem[];
    /** 未绑定到单一交付物的有用制品；渲染时限制数量（§6）。 */
    extraProof: ReviewMedia[];
    lock: LockState | null;
    /** “查看全部证明”的下钻目标，即完整修复循环历史。 */
    proofDirPath: string | null;
  };
  // 保留（相互正交且已验证可靠）：关注事项 + 协调 + 新鲜度。
  needsYou: NeedsYouBand;
  agents: AgentsBand;
  lineage: VerifyLineage;
  /** 绝对路径、越界媒体路径等发现；必须展示，绝不静默丢弃（FR-5）。 */
  defects: string[];
  /** 原样回传查看时输入；它是纯组合器的输入，因此仍保持幂等。 */
  composedAt: string;
}

// --- FR-7：任务目标层级（保留；完成台账中基于已记录判定的 green 是任务目标台账事实，
// 而非切片评审结构）---

export interface BoardSlot {
  slice: string;
  title: string;
  phase: ReviewPhase;
  laneLabel: string;
  agentsCount: number;
  /** 阶段专用单元格（spec 印章状态 / n-of-m / green+merged 对 / 印章）。 */
  stageCell: string;
  changedSinceStamp: boolean;
  /** 确定性的关注价值：needs-you ∪ ▲ ∪ 当天阶段发生变化。 */
  attentionWorthy: boolean;
}

export interface LedgerRow {
  slice: string;
  candidateSha: string | null;
  gateCells: VerdictCell[];
  mergeSha: string | null;
  needsHumanCount: number;
  green: boolean;
}

export interface ComposedMissionReview {
  readiness?: import("../proof/judgments.js").MissionReadiness;
  mission: string;
  missionId: string | null;
  title: string;
  /** brief 的 "What & why"，按原样投影为任务目标意图开篇（FR-8）。 */
  intent: string | null;
  /** FR-8：生成的状态主干正文只走一条计算路径；标签页始终渲染最新内容，只有在 freeze
   *  时刻才把完全相同的字符串写入 MISSION_BRIEF.md。 */
  briefSpine: { building: string; progress: string; proven: string; needsYou: string };
  board: BoardSlot[];
  /** 已完成：完成台账是对任务目标切片集合的查询结果，绝不是手工编写的列表。 */
  ledger: LedgerRow[];
  /** 仅当范围内每个切片均为 green、已合并且没有待处理 needs-human 项时才为 true。 */
  cutComplete: boolean;
  cutCompleteBasis: string;
  needsYou: NeedsYouBand;
  agents: AgentsBand;
  composedAt: string;
}
