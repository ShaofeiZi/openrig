// PL-004 阶段 D：Workflow Runtime 共享类型。
//
// 根据 POC `workflow-runtime-v0/lib/workflow-runtime.rb` 与 POC fixture YAML
//（`workflow-runtime-v0/tests/fixtures/*.yaml`）逆向整理。
//
// 阶段 D 范围是 v1 最小集：spec 解析、实例创建、步骤投影与仅追加步骤轨迹。
// 多 hop 链接、gate-return-sweep 与复杂路由表属于后续演进
//（见 PRD § Risks “Workflow runtime over-engineered”）。

export type WorkflowExitKind = "handoff" | "waiting" | "done" | "failed";

/** OPR.0.4.6.WF2 FR-1：闭合的 v1 分支 key 集，严格等于已记录 exit 枚举。
 * 只能通过步骤声明结果枚举通道扩展（PRD §6 指定延期项）；绝不能使用自由文本、身份或不透明证据 JSON。 */
export const WORKFLOW_EXIT_KINDS = ["handoff", "waiting", "done", "failed"] as const;

/** OPR.0.4.6.WF2 FR-2：可固定的 harness 值空间，仅含智能体 harness。
 * 刻意排除 `terminal`（终端节点不是智能体 harness）；Pi Agent 在 0.4.7 作为值空间扩展加入。 */
export const WORKFLOW_AGENT_HARNESSES = ["claude-code", "codex"] as const;
export type WorkflowAgentHarness = (typeof WORKFLOW_AGENT_HARNESSES)[number];

/** OPR.0.4.6.WF2 FR-5：结构化步骤级 gate 声明（每个步骤一个；架构裁定结构，取代已移除的
 * `gates[]` 字符串列表）。WF-2 负责字段、校验与编译到已交付的 0.4.4 gate 原语；
 * WF-5 负责 gate 语义（触发条件、升级策略）。目标可以是人员席位会话
 *（编译到带 summary + evidence_ref 的人员路由写入路径），或已声明角色名称
 *（编译为路由到该角色席位的普通智能体队列项）。 */
export interface WorkflowGateSpec {
  /** 人员席位会话（`human@kernel` 形式）或已声明角色名称。 */
  target: string;
  /** gate 队列项携带的自然语言摘要。人员目标必须提供，已交付的人员路由写入路径会强制要求。 */
  summary?: string;
  /** 持久证据指针（位于 queue_items.evidence_ref，迁移 048）。人员目标必须提供。 */
  evidence_ref?: string;
}

/** 专用 gate packet 必须携带全部三个事实才能推进。 */
export interface WorkflowAcceptanceSpec {
  candidate: string;
  verdicts: string[];
  evidence_ref: string;
}

export interface WorkflowRoleSpec {
  /** 此角色中的智能体实现的 skill 标识符。DISPOSITION（WF-1 FR-9）：明确属于 v2，
   * 仅用于文档；owner 解析使用 preferred_targets。使用时 validator 提示
   * `declared_not_enforced_v1`。 */
  skill_refs?: string[];
  /** 操作员为此角色提供的首选会话目标。会被 resolveDefaultOwner / entry-owner 解析消费。 */
  preferred_targets?: string[];
}

export interface WorkflowStepSpec {
  /** 工作流内稳定的步骤标识符（例如 "produce"）。 */
  id: string;
  /** 角色名称；依据 `roles` 映射解析。 */
  actor_role: string;
  /** 步骤意图的人类可读说明。 */
  objective?: string;
  /** 此步骤允许的 exit 类型，为 WorkflowExitKind 值的子集。 */
  allowed_exits?: WorkflowExitKind[];
  /** 对有意且未映射的 `waiting` exit，可选的一次性重新呈现截止时间。
   * 编译到队列现有的原子 park 计时器；智能体仍负责解释证据并选择下一个已编写 exit。 */
  re_present_after_seconds?: number;
  /** 选择启用事件优先、指数退避的重复提醒。 */
  re_present_max_seconds?: number;
  /** 下一 hop 提示结构（供投影使用）。OPR.0.4.6.WF2 FR-4：`mode: prefer` 已从值空间移除
   *（它从未有独立行为，与省略 mode 完全相同）；解析器以包含问题/原因/修复方式的迁移错误拒绝它。 */
  next_hop?: {
    mode?: "require" | "forbid";
    suggested_roles?: string[];
    /** OPR.0.4.6.WF2 FR-1：按结果条件分支，即已记录 exit → 后继步骤 id。key 只能来自闭合 exit
     * 枚举（BR-1 分支纯度）。已映射 exit 在同一 scribe 事务内路由到目标（实例保持 ACTIVE）；
     * 未映射 exit 完全保留当前终结/park 行为。 */
    on?: Partial<Record<WorkflowExitKind, string>>;
  };
  /** OPR.0.4.6.WF2 FR-2：把此步骤固定到智能体 harness。owner 解析选择节点运行时匹配的
   * 第一个 preferred_target；无匹配时返回结构化路由失败，绝不静默误路由。
   * 缺失时严格等于当前的 preferred_targets[0]。 */
  harness?: WorkflowAgentHarness;
  /** OPR.0.4.6.WF2 FR-3：把此步骤固定到主机，可为 "local"（或省略，等同当前完整执行），
   * 也可为已注册的 hosts.yaml id。REMOTE 固定值在语法上通过校验，但实例化时以 MH-3 边界错误
   * 明确失败（跨主机队列路由尚不存在），绝不静默回退本地。 */
  host?: string;
  /** OPR.0.4.6.WF2 FR-5：单个结构化 gate 声明，见 WorkflowGateSpec；
   * 取代已移除的 `gates?: string[]`。 */
  gate?: WorkflowGateSpec;
  /** 静态前置条件。存在时，spec 选择使用 packet 寻址的图执行。 */
  depends_on?: string[];
  /** 类型化验收契约；普通投递/存活输入无法满足。 */
  acceptance?: WorkflowAcceptanceSpec;
}

export interface WorkflowInvariants {
  /** DISPOSITION（WF-1 FR-9）：明确属于 v2，当前不门控任何内容。
   * 使用时 validator 提示 `declared_not_enforced_v1`。 */
  continuation_required?: boolean;
  /** 已消费：projector 强制 allowed_exits；validator 据此对子集检查步骤 allowed_exits。 */
  allowed_exits?: WorkflowExitKind[];
  /** DISPOSITION（WF-1 FR-9）：明确属于 v2。无论如何都会通过 chain_of_record 保留 lineage；
   * 该标志不门控任何内容，使用时发出提示。 */
  preserve_lineage?: boolean;
  /** DISPOSITION（WF-1 FR-9）：明确属于 v2。hot-potato 契约始终要求 closure；
   * 该标志不门控任何内容，使用时发出提示。 */
  closure_required?: boolean;
}

/** DISPOSITION（WF-1 FR-9）：明确属于 v2，仅作展示消息；尚无消费方渲染，使用时发出提示。 */
export interface WorkflowClosureMessages {
  success?: string;
  degraded?: string;
  failed?: string;
}

export interface WorkflowLoopGuards {
  /** 实例可执行的步骤转换总数上限。已强制（WF-1 FR-6）：投影时与有效基线比较
   *（v1 baseline = 0）；超限会如实使实例失败并指出守卫。校验时也允许 cycle（FR-7）。 */
  max_hops?: number;
  /** 动态生成子实例的最大数量。DISPOSITION（WF-1 FR-9，架构裁定）：明确属于 v2；
   * 单 frontier 模型中没有 spawn/fan-out 接缝，强制执行是 WF-2/WF-6 并行 frontier
   * 扇出工作的具名验收项。使用时发出提示。 */
  spawn_budget?: number;
}

/** OPR.0.4.6.WF5 FR-2：成熟度拨盘位置的闭合值空间。
 * `orchestrator` 表示队列项路由到声明的 orchestrator 角色所解析的席位（v1.3 创始人默认）；
 * `human_only` 表示队列项先路由到人员席位并在那里门控，orchestrator 绝不自动操作。 */
export const WORKFLOW_EXCEPTION_DIAL_POSITIONS = ["orchestrator", "human_only"] as const;
export type WorkflowExceptionDialPosition = (typeof WORKFLOW_EXCEPTION_DIAL_POSITIONS)[number];

/** OPR.0.4.6.WF5 FR-2：spec 声明的异常路由，即拨盘的逐工作流/逐类别配置表面；
 * 此前延期的 spec 声明目标由 v1.3 反转取消延期。这里只配置路由，任何值都不改变 FR-1 检测类别。
 * 完全缺失时使用 host-default → orchestrator-first 链。 */
export interface WorkflowExceptionRoutingSpec {
  /** 逐工作流拨盘位置（链路 2）。 */
  default?: WorkflowExceptionDialPosition;
  /** 已声明的 orchestrator 角色（链路 3 输入）；通过步骤 owner 使用的同一套已交付
   * role→preferred_targets 机制解析。必须指定已声明角色（validator 图检查）。 */
  orchestrator_role?: string;
  /** 逐异常类别覆盖（链路 1）。key 是闭合的 FR-1 类别集；`human_gate_trip` 本质上只能由人处理，
   * 不可配置，解析时会被拒绝。 */
  classes?: Record<string, WorkflowExceptionDialPosition>;
}

export interface WorkflowSpec {
  id: string;
  version: string;
  objective?: string;
  /** 给智能体的寻址上下文；只携带引用，绝不解释。 */
  context_refs?: string[];
  /**
   * OPR.0.4.6.FAC1：`target.rig` 是默认值，而非硬编码；实例化时的 `targetRig` 参数会覆盖它，
   * 有效绑定持久化到实例（`WorkflowInstance.boundRig`）。运行时没有路由路径读取此字段，
   * 它只用于展示/标签表面；此处保留，绝不移除或弃用。
   */
  target?: { rig?: string };
  entry?: { role?: string };
  roles: Record<string, WorkflowRoleSpec>;
  steps: WorkflowStepSpec[];
  invariants?: WorkflowInvariants;
  closure?: WorkflowClosureMessages;
  loop_guards?: WorkflowLoopGuards;
  /** OPR.0.4.6.WF5 FR-2：成熟度拨盘，见 WorkflowExceptionRoutingSpec。 */
  exception_routing?: WorkflowExceptionRoutingSpec;
  /** 协作终结 turn 规则；默认为 "hot_potato"。 */
  coordination_terminal_turn_rule?: string;
}

export type WorkflowInstanceStatus = "active" | "waiting" | "completed" | "failed" | "aborted";

export interface WorkflowInstance {
  instanceId: string;
  workflowName: string;
  workflowVersion: string;
  createdBySession: string;
  createdAt: string;
  status: WorkflowInstanceStatus;
  /** 当前活跃步骤 packet 的 qitem_id。 */
  currentFrontier: string[];
  /**
   * R2 修复：持久的当前步骤绑定（活跃 frontier packet 所代表的步骤）。实例化时设置为入口步骤，
   * handoff 时设置为下一步骤，终结关闭时清除。WorkflowProjector 直接读取，而不是从 trail 顺序推断，
   * 修复 waiting-resume“跳过一个步骤”的 bug。v1 支持单个活跃 frontier packet。
   */
  currentStepId: string | null;
  hopCount: number;
  /** DISPOSITION（WF-1 FR-9）：明确属于 v2；没有代码路径写入的实例列（始终为 null），
   * 为 POC 的 fallback-synthesis 演进保留。它不是 spec key，无法解析，因此 validator
   * 不提示；本 JSDoc 即其处置说明。 */
  fallbackSynthesis: string | null;
  lastContinuationDecision: Record<string, unknown> | null;
  completedAt: string | null;
  /**
   * OPR.0.4.6.WF1 FR-5：乐观并发版本（迁移 049）。每次受守卫的推进都会递增；
   * 陈旧写入方的 UPDATE 匹配零行并抛出 `instance_version_conflict`（整个事务回滚）。
   * 被吸收的 waiting replay 不递增任何内容（零写入）。
   */
  version: number;
  /**
   * OPR.0.4.6.WF5 FR-4（迁移 051）：已记录的 redrive 计数，是一等事实
   *（Step Functions redriveCount 结构），绝不从 trail 推断。
   */
  resumeCount: number;
  /**
   * OPR.0.4.6.WF5 FR-4（迁移 051）：LIVELOCK 护栏。max_hops 限制每次 DRIVE：
   * 投影守卫比较从最近一次 instantiate（0）或 resume（resume 时的 hopCount）起累计的 hop。
   */
  hopsBaseline: number;
  /**
   * OPR.0.4.6.FAC1（迁移 052）：实例绑定的工作组名称；实例化时记录
   * `targetRig ?? spec.target.rig ?? null`。角色能力解析（tier 3）依据该工作组清单执行；
   * 每个解析位置都会重新解析 name→id。null 表示未绑定，与 FAC-1 前行为逐字节一致。
   */
  boundRig: string | null;
  lifecycleOperationKey: string | null;
  compiledInputDigest: string | null;
  lifecycleBinding: Record<string, unknown> | null;
}

export interface WorkflowFrontierBinding {
  instanceId: string;
  packetId: string;
  stepId: string;
  branchDrive: number;
  hopCount: number;
  hopsBaseline: number;
  createdAt: string;
}

export interface WorkflowFailureOccurrence {
  occurrenceId: string;
  instanceId: string;
  failedPacketId: string;
  stepId: string;
  branchDrive: number;
  hopCount: number;
  hopsBaseline: number;
  failureReason: string | null;
  status: "unresolved" | "resolved";
  redrivePacketId: string | null;
  resumeDecision: string | null;
  failedAt: string;
  resolvedAt: string | null;
}

export interface WorkflowStepTrailEntry {
  trailId: string;
  instanceId: string;
  stepId: string;
  stepRole: string;
  closedAt: string;
  closureReason: WorkflowExitKind;
  closureEvidence: Record<string, unknown> | null;
  actorSession: string;
  nextQitemId: string | null;
  priorQitemId: string;
}

export interface WorkflowSpecRow {
  specId: string;
  name: string;
  version: string;
  purpose: string | null;
  targetRig: string | null;
  spec: WorkflowSpec;
  coordinationTerminalTurnRule: string;
  sourcePath: string;
  sourceHash: string;
  cachedAt: string;
}
