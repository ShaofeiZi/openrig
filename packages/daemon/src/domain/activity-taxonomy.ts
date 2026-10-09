// OPR.0.5.5.19——正式 activity taxonomy：所有 surface（TUI、`zrig ps`、node-inventory）
// 共同渲染的已声明 state language。三个正交 axis 加派生 diagnosis，经
// product/from-openrig.dev/taxonomy-agent-state-ADDENDUM-2026-08-26.md 批准
//（founder ruling 22:00Z）；与 herdr/omnigent 的对齐记录在 docs/reference/agent-state-taxonomy.md——
// 文档引用 addendum，绝不派生分叉。
//
// BINDING EXCLUSION（SPEC mini-req 1，经 adversarial 验证——verdict 1229a4b7）：
//  - attention 与 needs-input 绝不是 activity enum 值。needs-input 以 count + 短 reason phrase
//    （omnigent pending_elicitations_count + blocked_on shape）承载；attention 留在自身机制
//    （attentionCount）中。
//  - UNKNOWN 是一等且诚实的 value——oracle 表示“无法判断”，不是 error，也不是猜测。
//    unknown 胜过自信的错误答案。
//  - 派生 diagnosis（PARKED、HELD-is-not-parked、DONE-UNSEEN）在读取时根据 axis + queue
//    obligation face 计算；绝不存为 state。
//
// addendum 的人类可见 activity list 显示四个值（working / idle / needs-input / unknown）。
// typed enum 只携带三个：needs-input 通过唯一 bridge `deriveDisplayActivity` 从 count+reason
// 字段派生用于显示，因此 store 或 transition 从不将 "needs-input" 保存为 state。
// 此对齐已记录在 reference doc 的 addendum-mapping section。

/** Activity axis——当前存在的 agent 正在做什么。 */
export type ActivityValue = "working" | "idle-at-prompt" | "unknown";
export const ACTIVITY_VALUES: ReadonlySet<string> = new Set<ActivityValue>([
  "working",
  "idle-at-prompt",
  "unknown",
]);

/** Session axis——process 是否存在。 */
export type SessionPresenceValue = "present" | "detached" | "exited" | "absent";
export const SESSION_PRESENCE_VALUES: ReadonlySet<string> = new Set<SessionPresenceValue>([
  "present",
  "detached",
  "exited",
  "absent",
]);

/** Resumability axis——与前两者正交：revival optimism 绝不混入 reachability
 *  （omnigent 严格存活性拆分）。 */
export type ResumabilityValue = "live" | "resumable" | "context-walled";
export const RESUMABILITY_VALUES: ReadonlySet<string> = new Set<ResumabilityValue>([
  "live",
  "resumable",
  "context-walled",
]);

/** needs-input 表示为 count + 短 reason phrase——绝不是 status value。count=0 表示无；
 *  reason 是说明为何没有进展的简短人类语言（"permission prompt"、"usage limit"、
 *  “分类器暂停”）。 */
export interface NeedsInput {
  count: number;
  reason: string | null;
}

/** addendum 的人类可见 display value：human surface 显示的四值列表。 */
export type DisplayActivityValue = "working" | "idle" | "needs-input" | "unknown";

/** 从 typed axis 到 addendum 人类可见 value 的唯一 bridge。count 为正时即渲染 needs-input——
 *  对此 signal，可见 needs-input evidence 优先于 working self-report（herdr arbitration cut）——
 *  同时 "needs-input" 从不作为已存 state 存在。非 taxonomy activity value 会被明确拒绝：
 *  此 slice 淘汰的 surface-local vocabulary 不得通过 display 再次泄漏。 */
export function deriveDisplayActivity(activity: string, needsInput: NeedsInput): DisplayActivityValue {
  if (!ACTIVITY_VALUES.has(activity)) {
    throw new Error(
      `"${activity}" 不是 taxonomy activity value（working | idle-at-prompt | unknown）——` +
      `surface 本地词汇必须在其 adapter 中映射，绝不直接渲染`,
    );
  }
  if (needsInput.count > 0) return "needs-input";
  if (activity === "idle-at-prompt") return "idle";
  return activity as "working" | "unknown";
}

// ── 证据阶梯 + 适配器契约（SPEC 微型需求 2、5、7；AM-1/AM-2）──

/** 具名 rung，按 working/idle 决策的 arbitration rank 排序（最高优先）。needs-input-chrome
 *  特殊处理：只对 needs-input signal 优先于 self-report，不影响 working/idle。window-sampling
 *  是 fallback floor。 */
export type EvidenceRungId = "self-report" | "lifecycle-hooks" | "needs-input-chrome" | "window-sampling";
export const EVIDENCE_RUNG_RANK: readonly EvidenceRungId[] = [
  "self-report",
  "lifecycle-hooks",
  "window-sampling",
];

/** AM-2 对称准入：rung 逐步获得 authority，正如较低 rung 会退役。authoritative——用于确定
 *  state；trial——通过 fixture 后准入，衡量一致性但不用于决策；identity-only——仅用于
 *  identity/resume ref（partial-coverage honesty 与 AM-1 degradation target）；absent——未配置。 */
export type RungTrust = "authoritative" | "trial" | "identity-only" | "absent";

export interface RungDeclaration {
  rung: EvidenceRungId;
  /** herdr 的边界：只有完整 lifecycle coverage 才可能成为 authoritative。 */
  lifecycleCoverage: "full" | "partial" | "none";
  /** rung 在此 adapter 上的初始 trust（promotion 可提升 trial）。 */
  initialTrust: RungTrust;
}

/** adapter 对自身的声明——arbitration 根据各 source 实际可观察内容排名。每次 occupant swap
 *  都重新声明（AM-1 推论）：successor 绝不继承 predecessor 的 rung authority。 */
export interface AdapterRungInventory {
  adapterId: string;
  runtime: "claude-code" | "codex" | "tmux-generic";
  rungs: RungDeclaration[];
}

/** adapter 报告给 oracle 的一条 evidence。除历史 hook rung 外，每个 rung evidence 都自带时间——
 *  这正是 hook authority 受时间限制的原因（AM-1）：此处 observedAt 是 hook 的 ingest clock。 */
export interface ActivityEvidence {
  seatNodeId: string;
  sessionName: string;
  rung: EvidenceRungId;
  /** 稳定 source id，例如 "claude:pid-json"、"codex:hooks"、"tmux:window-activity"。 */
  sourceId: string;
  /** 各 source 内单调递增——丢弃 stale 或乱序 report。 */
  seq: number;
  observedAt: string;
  activity?: ActivityValue;
  needsInput?: NeedsInput;
}

/** 可见的 rung-health transition（AM-1）：arbitration 绝不能让静默失效的 source 成为
 *  authoritative，degradation 本身也必须可观察。 */
export interface RungHealthEvent {
  seatNodeId: string;
  rung: EvidenceRungId;
  sourceId: string;
  from: RungTrust;
  to: RungTrust;
  reason: string;
  at: string;
}

/** 经 arbitration、以 seat 为 key 的结果；所有 surface 都从它渲染。 */
export interface ArbitratedSeatState {
  seatNodeId: string;
  activity: ActivityValue;
  needsInput: NeedsInput;
  /** 哪个 rung 决定 `activity`——显式呈现 confidence。 */
  decidedBy: EvidenceRungId | null;
  /** 单调递增的 arbitrated-state sequence（由 wait-after-seq 消费）。 */
  seq: number;
  changedAt: string;
  rungs: Array<{ rung: EvidenceRungId; sourceId: string; trust: RungTrust; lastEvidenceAt: string | null }>;
  /** occupant swap 是独立可见 event，绝不是 activity transition。 */
  lastSwap: { generation: string; at: string } | null;
}

// ── 逐运行时阶梯清单（SPEC 微型需求 4、5、7）——唯一数据来源；适配器与
// ingest auto-declaration 都读取它们，绝不重新定义。──

/** Claude Code：对 working/idle 而言，pid.json self-report 高于 hook（r3 standing）；另有
 * Stop/StopFailure hook 对（r2 现状）、可见外观（r4 现状）、采样基线（r1）。
 * 全部覆盖完整 lifecycle → authoritative（具名 current rung）。 */
export const CLAUDE_ACTIVITY_RUNG_INVENTORY: AdapterRungInventory = {
  adapterId: "claude-code-adapter",
  runtime: "claude-code",
  rungs: [
    { rung: "self-report", lifecycleCoverage: "full", initialTrust: "authoritative" },
    { rung: "lifecycle-hooks", lifecycleCoverage: "full", initialTrust: "authoritative" },
    { rung: "needs-input-chrome", lifecycleCoverage: "full", initialTrust: "authoritative" },
    { rung: "window-sampling", lifecycleCoverage: "full", initialTrust: "authoritative" },
  ],
};

/** Codex 0.147：四 event hook rung 覆盖 turn lifecycle——真实 authority candidate
 *  （AM-2：以 trial 身份进入；production agreement 后提升）。没有 pid.json analog（已在机器上
 *  验证）——其 ladder 顶层是 hook，sampling 保持为 floor。 */
export const CODEX_ACTIVITY_RUNG_INVENTORY: AdapterRungInventory = {
  adapterId: "codex-runtime-adapter",
  runtime: "codex",
  rungs: [
    { rung: "lifecycle-hooks", lifecycleCoverage: "full", initialTrust: "trial" },
    { rung: "window-sampling", lifecycleCoverage: "full", initialTrust: "authoritative" },
  ],
};

/** 通用 tmux floor：仅 sampling——正是未声明 seat 获得的能力。 */
export const TMUX_GENERIC_RUNG_INVENTORY: AdapterRungInventory = {
  adapterId: "tmux-generic",
  runtime: "tmux-generic",
  rungs: [{ rung: "window-sampling", lifecycleCoverage: "full", initialTrust: "authoritative" }],
};

/** 将 runtime string 解析为其 rung inventory（ingest auto-declaration 路径）。未知 runtime
 *  使用通用 floor——默认遵循 partial-coverage honesty。 */
export function runtimeRungInventory(runtime: string | null): AdapterRungInventory {
  if (runtime === "claude-code") return CLAUDE_ACTIVITY_RUNG_INVENTORY;
  if (runtime === "codex") return CODEX_ACTIVITY_RUNG_INVENTORY;
  return TMUX_GENERIC_RUNG_INVENTORY;
}
