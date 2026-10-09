// 任务控制 TUI 的核心类型。TUI 是后台服务现有投影上的渲染器 + 导航
// 壳（两个渲染器覆一个投影）；FleetSnapshot 是这些读取水合的
// 渲染侧形状——它不引入新数据模型。

export interface AgentRow {
  /** 规范席位范围记录使用的稳定后台服务节点身份。 */
  nodeId?: string;
  name: string;
  runtime: string;
  /** 已服务有效模型；独立于运行时，未服务时为 null */
  model?: string | null;
  spec: string;
  profile?: string | null;
  specVersion?: string | null;
  specHash?: string | null;
  /** null = 投影无值 → 渲染诚实未知，绝不伪造（PIN 2） */
  context: number | null;
  tokens: string | null;
  /** 来自同一已服务 contextUsage 对象的详细上下文核算。 */
  contextWindowSize?: number | null;
  totalInputTokens?: number | null;
  totalOutputTokens?: number | null;
  /** 来自节点清单的完整工作计数；下方队列列表读取有界。 */
  hasAssignedWork?: boolean;
  assignedWorkCount?: number;
  pendingWorkCount?: number;
  inProgressWorkCount?: number;
  blockedWorkCount?: number;
  /** 类型化活动决策加底层信号，保持独立。 */
  activity?: {
    activity: string | null;
    needsInput: { count: number; reason: string | null } | null;
    decidedBy: string | null;
    signalReason: string | null;
    signalSource: string | null;
    eventAt: string | null;
  };
  status: string;
  /** 生命周期真相，独立于显示的活动状态 */
  live: boolean;
  /** 生命周期恢复动作是否有效 */
  canRun?: boolean;
  /** 已服务 canonicalSessionName——联接需要你目标到拓扑 */
  session?: string | null;
  /** 已服务 tmuxAttachCommand，在详情视图逐字显示（web 对等） */
  attach?: string | null;
  /** 已服务工作目录（S19 MR4 §D9——完整绝对路径，逐字） */
  cwd?: string | null;
  /** 已服务 terminalActive 逐字（S19 round-5）：tmux #{window_activity}
   * 在后台服务静默窗口内——其 false→true
   * 转换意味着真实新窗格输出的基底；null = 无信号 */
  paneActive?: boolean | null;
}

export interface PodNode {
  name: string;
  agents: AgentRow[];
}

export interface RigNode {
  /** 从摘要观察到的运行/空闲智能体存在；null/缺失表示未知。 */
  hasLiveAgents?: boolean | null;
  inventoryNotLoaded?: boolean;
  inventoryUnavailable?: boolean;
  authoredSpecName?: string;
  /** 后台服务工作组 id；仅静态演示夹具中缺失 */
  id?: string;
  name: string;
  pods: PodNode[];
  /** 工作组的已服务图投影（§4.A 拓扑行 1——通过 daemon-client.rigGraph 的声明式
   * 现有读取；slice-17 视图消费它，R7-clean） */
  graph?: import("./topology/graph-types.js").RigGraph;
  /** 已服务工作组 lifecycleState 逐字（摘要读取）；非 "running" 状态浮现 */
  lifecycleState?: string;
}

export interface HostNode {
  /** 稳定传输键（此后台服务为 `local`）；独立于显示身份。 */
  id?: string;
  name: string;
  reachable: boolean;
  rigs: RigNode[];
}

export type SpecKind = "rig" | "agent" | "workflow";

export interface RigSpecMember {
  id: string;
  agentRef: string;
  runtime: string;
  profile?: string;
}

export interface RigSpecEdge {
  from: string;
  to: string;
  kind: string;
}

export interface RigSpecPod {
  id: string;
  namespace?: string;
  label?: string;
  members: RigSpecMember[];
  edges: RigSpecEdge[];
}

export interface AgentSpecResources {
  skills: string[];
  guidance: string[];
  plugins: string[];
  subagents: string[];
}

export interface SpecGraphData {
  nodes: Array<{ id: string; label: string; pod?: string; runtime: string; kind: "agent" | "infrastructure" }>;
  edges: Array<{ source: string; target: string; kind: string }>;
}

export interface SpecEntry {
  sourceUnavailable?: string;
  /** 运行时观测，独立于库声明。 */
  consumers?: Array<{ rig: string; host: string; agent?: string; runtime?: string; model?: string | null; status?: string }>;
  name: string;
  kind: SpecKind;
  /** 工作组规范：成员智能体引用，每个可点击 → 该智能体规范 */
  agentRefs?: string[];
  runtime?: string;
  usedByRigs?: string[];
  /** 来自现有读取的结构化详情（库列表 + /:id/review），逐字 */
  version?: string;
  sourceState?: "draft" | "file_preview" | "library_item";
  sourceType?: "builtin" | "user_file";
  sourcePath?: string;
  resolvedSourcePath?: string | null;
  relativePath?: string;
  /** 智能体库文件夹分组，如 review/ 或 orchestration/。 */
  namespace?: string;
  description?: string;
  skills?: string[];
  hasGuidance?: boolean;
  startupFiles?: Array<{ path: string; required: boolean }>;
  profiles?: string[];
  resources?: AgentSpecResources;
  format?: "pod_aware" | "legacy";
  pods?: RigSpecPod[];
  edges?: RigSpecEdge[];
  graph?: SpecGraphData;
  raw?: string;
  legacyNodes?: Array<{ id: string; runtime: string; role?: string; model?: string }>;
  /** 工作流库条目（在库列表读取上服务） */
  rolesCount?: number;
  stepsCount?: number;
  workflowStatus?: string;
}

export interface NeedsItem {
  /** 保留后台服务的有序联合，同时保留呈现语义。 */
  source: "agent" | "derived";
  kind: string;
  target: string;
  detail: string;
  /** 组来源；必需以防止远程行打开本地孪生 */
  hostId?: string;
  /** composeNeedsYou 携带的动作身份/证明；绝不从散文重建。 */
  qitemId?: string | null;
  evidenceRef?: string | null;
  unblocks?: string | null;
}

/** 主机/工作组降级行——在渲染时与需要你条目并列组合，绝不
 * 投影到条目形状中（§4.A：composeNeedsYou 不提供主机行）。 */
export interface HostDown {
  hostId: string;
  status: string;
  error?: string;
}

/** PULSE 异常联接的 TUI 局部读取形状——
 * 两个实时联接消费的后台服务 QueueItem（queue-repository.ts）子集。逐字
 * 来自已交付队列列表读取（attention → 需要你；
 * state=blocked → 被智能体阻塞；客户端包装器拥有路由）。
 * 后台服务应用两个过滤器，因此 TUI 仅映射 + 呈现（无阈值，
 * 无合成）。`body` 存在用于需要你主体回退
 * （摘要 → 正文开头）。 */
export interface QueueRead {
  sourceSession?: string | null;
  qitemId: string;
  state: string;
  destinationSession: string;
  blockedOn: string | null;
  handedOffTo: string | null;
  tier: string | null;
  tags: string[] | null;
  summary: string | null;
  body: string;
  claimedAt: string | null;
  tsUpdated: string;
  /** 被智能体阻塞标签==所指：blockedOn 是智能体阻塞的 qitem id
   * （人类停驻仅为会话），因此阻塞智能体是该 qitem 的拥有者。
   * hydrate 通过已交付单 qitem 后台服务读取解析它（有界
   * 逐行查找）并在此戳记拥有者会话；未解析时为 null（门
   * 名 / 查找未命中）——渲染回退到原始 blockedOn，绝不伪造。 */
  blockerSession?: string | null;
}

/** 一个席位的 ps/活动摘要——PULSE ◌ 停驻待接力联接的右
 * 侧，逐字来自已交付节点读取（attachTerminalActivityAndWork）。
 * `terminalActive`：已交付空闲布尔（false = 窗口后静默 =
 * "空闲拥有者"门；null = 无信号 → 诚实未知，绝不视为空闲）。
 * `lastActivityAt`：原始 window_activity 事实（arch 3a947fb1）——拥有者空闲年龄
 * 是渲染器从此 + 读取器时钟派生的视图，绝不在此。 */
export interface SeatActivitySummary {
  session: string;
  /** 席位的紧凑规范 id（podNamespace.memberId，如 "dev50.driver"）
   * ——在同一节点读取上逐字服务为 node.logicalId（它是表
   * 视图已渲染的智能体名称，hydrate.ts toAgentRow）。PULSE 泳道
   * 形式（r1 mock 权威裁决）显示此短 id；完整 `session` 在
   * 钻入时恢复。携带，绝不从会话字符串重建
   * （命名空间/成员可能含连字符 → 分割会有损）。 */
  logicalId: string;
  terminalActive: boolean | null;
  lastActivityAt: string | null;
}

import type { MissionScopesSnap } from "./scopes/scopes-model.js";
import type { ExecutionViewSnap } from "./execution/execution-model.js";

export interface SliceDetailSnap {
  name: string;
  status: string;
  rawStatus: string | null;
  qitemIds: string[];
  commitRefs: string[];
  lastActivityAt: string | null;
  story: {
    events: Array<{
      ts: string;
      phase: string | null;
      kind: string;
      actorSession: string | null;
      qitemId: string | null;
      summary: string;
    }>;
  };
  decisions: {
    rows: Array<{
      actionId: string;
      ts: string;
      actor: string;
      verb: string;
      qitemId: string;
      reason: string | null;
    }>;
  };
}

export interface RecentTransitionSnap {
  transitionId: number;
  qitemId: string;
  ts: string;
  actorSession: string;
  change: string;
  /** 撰写的队列摘要仅供显示；绝不用于派生变更。 */
  summary?: string | null;
  /** 拥有的本地工作组，在实例范围读取上显式。 */
  rig?: string | null;
  targetKind: "qitem" | "slice" | "mission";
  target: string;
}

export type HealthScope =
  | { type: "instance"; instanceId: string }
  | { type: "rig"; rigId: string }
  | { type: "seat"; rigId: string; seatId: string }
  | { type: "mission"; projectId: string; missionId: string }
  | { type: "slice"; projectId: string; missionId: string; sliceId: string };

export interface HealthEvidenceReference {
  type: "queue-transition" | "watchdog-history" | "work-graph" | "topology-activity" | "context-usage" | "occupant-model" | "lifecycle-receipt";
  sourceOrder: number;
  observedAt: string | null;
  [key: string]: unknown;
}

export interface HealthRecord {
  operatingPosture?: import("@openrig/daemon/health-projection").OperatingPosture;
  /** 从后台服务透传；TUI 绝不派生确认。 */
  ceremony?: {
    stage: "needs-diagnosis" | "confirmed" | "cleared" | "indeterminate";
    basis: string;
    context: Array<{ path: string; state: "available" | "unavailable"; sha256?: string; role: string }>;
  };
  policyVersion?: string;
  schema: "openrig.health/v0alpha1";
  id: string;
  detector: string;
  category: "behavioral" | "process" | "governance" | "epistemic" | "context";
  scope: HealthScope;
  severity: "info" | "warning" | "critical";
  confidence: "high" | "medium";
  status: "active" | "cleared" | "indeterminate";
  startedAt: string | null;
  lastObservedAt: string | null;
  window: { source: HealthEvidenceReference["type"] | "mixed"; startedAt: string; endedAt: string; limit: number; retentionSeconds: number };
  freshness: {
    state: "fresh" | "stale" | "unavailable" | "contradictory";
    evaluatedAt: string;
    newestSourceAt: string | null;
    maxAgeSeconds: number;
    ageSeconds: number | null;
  };
  summary: string;
  evidence: HealthEvidenceReference[];
  threshold: string;
  explanation: string;
  suggestedInspection: string;
  indeterminateReason: string | null;
}

export interface HealthSnapshot {
  /** loaded 表示规范有界列表读取已应答，包括 [] */
  availability: "loaded" | "unavailable";
  evaluatedAt: string | null;
  total: number;
  truncated: boolean;
  records: HealthRecord[];
}

export interface ProjectSelection { id: string; root: string }
export interface ProjectEntry extends ProjectSelection { name: string; sourcePath: string | null; missionsRoot: string; error?: string }
export interface FleetSnapshot {
  attentionRead?: import("@openrig/daemon/attention").AttentionRead | null;
  projects?: { catalogPath: string; projects: ProjectEntry[] } | null;
  projectRead?: ProjectSelection | null;
  projectSources?: Record<string, string>;

  terminals?: import("./terminals/terminal-model.js").TerminalRead;
  fileRead?: { target: import("./reading.js").FileTarget; result: import("./reading.js").FileReadResult; readAt: string };
  fileRoots?: import("./reading.js").FileRoot[];
  specsLoaded?: boolean;
  config?: import("./config/config-model.js").ConfigRead | null;
  configError?: string;
  connections?: import("./connections/connections-model.js").ConnectionsRead | null;
  controlPlane?: import("./connections/connections-model.js").ControlPlaneRead | null;
  /** OPR.0.6.0.5——已交付 Slack 应用清单（与 `rig slack manifest` 同对象）；不可用时为 null。 */
  slackManifest?: import("./connections/connections-model.js").SlackManifestRead | null;
  daemonTarget?: string;
  launchingCli?: string;
  /** 规范后台服务健康记录。旧/演示快照上缺失。 */
  health?: HealthSnapshot;
  /** 范围视图（d64d2f5c）：直接存储任务目标/切片投影；旧后台服务上缺失（诚实空）。 */
  scopes?: MissionScopesSnap[];
  /** 执行视图：后台服务现有派生六问投影。 */
  execution?: ExecutionViewSnap | null;
  /** 此执行读取请求的任务目标。独立于行存在，使
   * 所选任务目标挂起、已决空和失败保持可区分。 */
  executionMission?: string | null;
  /** 仅当前打开切片的丰富现有切片详情读取。 */
  sliceDetail?: SliceDetailSnap | null;
  sliceDetailName?: string | null;
  /** 一个显式命名工作组的有界类型化转换尾部。未定义
   * 表示未加载；[] 表示已服务窗口被证明为空。 */
  recentTransitions?: RecentTransitionSnap[];
  recentTransitionsScope?: { kind: "instance" } | { kind: "rig"; rig: string };
  /** S11 夹具的兼容坐标；新代码偏好 recentTransitionsScope。 */
  recentTransitionsRig?: string | null;
  hosts: HostNode[];
  specs: SpecEntry[];
  /** 以后台服务优先级顺序落地的 composeNeedsYou 联合，逐字（PIN 3） */
  needs: NeedsItem[];
  /** 人类队列读取应答前为 false——诚实未知 vs 已证空 */
  humanQueueProbed: boolean;
  /** PULSE ▲ 需要你源——已交付 attention 读取（已是确切
   * 人类面向集合）；空数组 = 联接运行并产生零（静默）。 */
  attention: QueueRead[];
  /** PULSE ⧗ 被智能体阻塞源——已交付 state=blocked 读取（所有
   * 阻塞 qitem）；渲染过滤为非人类 blockedOn。 */
  blocked: QueueRead[];
  /** PULSE ◌ 停驻待接力源——已交付 state=in-progress 读取（所有
   * 进行中 qitem）；渲染将每个联接至其拥有者的 seatActivity 并
   * 仅保留空闲（terminalActive===false）、未交接拥有者。 */
  inProgress: QueueRead[];
  /** 每席位 ps/活动（停驻联接的右侧），每个运行中
   * 智能体席位一条带规范会话，来自已交付节点读取。 */
  seatActivity: SeatActivitySummary[];
  /** PULSE 下一个源（增量 3）——已交付 state=pending 读取
   * （未认领积压）。以后台服务已服务顺序携带（ts_created 降序）；
   * 渲染仅保留未认领（claimedAt null）并上限显示。 */
  pending: QueueRead[];
  /** PULSE 刚完成源（增量 3）——已交付
   * state=done,handed-off 读取（有界近期窗口；无全组
   * 完成时间排序转换端点存在——已服务顺序是
   * ts_created，因此渲染按 tsUpdated 降序重排以最新完成在前）。 */
  recentlyFinished: QueueRead[];
  /** 此快照完成水合时（TUI 渲染时事实，非后台服务
   * 读取）——PULSE 页脚 "已更新 N 秒前" 新鲜度。首次
   * 水合前缺失（emptySnapshot）→ 页脚渲染诚实 "—"，绝不伪造年龄。 */
  hydratedAt?: string;
  hostsDown: HostDown[];
  /** 页脚滚动条的最新环境流项（FR-10），最新在后 */
  stream: Array<{ tsEmitted: string; sourceSession: string; body: string }>;
  /** 命名逐读失败（诚实部分水合，绝不静默） */
  readErrors: string[];
}

export type GetSnapshot = () => FleetSnapshot;

export type ResourceKind = "host" | "rig" | "pod" | "agent" | "spec";

export interface ResourceTarget {
  host: string;
  rig?: string;
  pod?: string;
}

export interface DrillSegment {
  kind: ResourceKind;
  name: string;
}

export type ViewTab = "table" | "recent" | "overview" | "graph" | "health" | "topology" | "configuration" | "yaml" | "pulse";

export type Action =
  | { type: "terminal-result"; view: string; message: string }
  | { type: "terminal-preview"; view: string }
  | { type: "terminal-page"; page: number }
  | { type: "attention-category"; category: "action" | "update" }
  | { type: "attention-open"; id: string }
  | { type: "attention-source"; path: string }
  | { type: "file-open"; target: import("./reading.js").FileTarget }
  | { type: "external-open"; url: string }
  /** 短暂离开 TUI 并将 `value` 打印为一行不间断文本以供精确复制；回车返回。 */
  | { type: "print-for-copy"; label: string; value: string }
  | { type: "startup"; key: string }
  | { type: "time-setting"; timeZone: string; timeZoneWarning: string | null }
  | { type: "timezone" }
  | { type: "recent-open"; transitionId: number }
  | { type: "back" }
  | { type: "config-category"; category: string }
  | { type: "config-setting"; key: string }
  | { type: "noop" }
  | { type: "error"; message: string }
  | { type: "jump"; section: string }
  | { type: "filter"; text: string }
  | { type: "select"; delta?: number; index?: number; rowCount?: number }
  | { type: "activate" }
  | { type: "drill"; resource: ResourceKind; name: string; target?: ResourceTarget }
  | { type: "cross"; kind: "spec-of" | "running"; name: string; target?: ResourceTarget }
  | { type: "tab"; tab: ViewTab }
  | { type: "content-scroll"; delta: number }
  | { type: "focus"; pane: "explorer" | "content" }
  | { type: "content-select"; delta?: number; index?: number }
  /** 终端原生文本选择：激活时鼠标报告关闭 */
  | { type: "copy-mode"; on?: boolean }
  | { type: "layout"; contentMaxOffset: number; contentTargetCount: number }
  | { type: "footer"; on?: boolean }
  | { type: "toggle-expand"; key: string }
  /** slice-17：图渲染样式维度乘命令栏 */
  | { type: "style"; name: string }
  /** REGISTRY I3——命令面板（打开/查询/移动/关闭乘派发，如所有状态）。 */
  /** 范围视图：m 折叠 + n 叙事切换（乘派发）。 */
  | { type: "project-select"; id: string }
  | { type: "project-source" }
  | { type: "scopes-mission-open"; mission: string }
  | { type: "scopes-open"; mission: string; slice: string }
  | { type: "scopes-reqs" }
  | { type: "scopes-narrative" }
  /** 执行视图：打开一个派生行的详情页（key = slice:/lane:/park:/basis:/sources）；关闭返回概览。 */
  | { type: "execution-open"; key: string }
  | { type: "execution-close" }
  | { type: "health-open"; findingId: string }
  | { type: "health-close" }
  | { type: "palette-open" }
  | { type: "palette-close" }
  | { type: "palette-query"; query: string }
  | { type: "palette-move"; delta: number }
  /** drive-structure 后台服务写入（BR-8/BR-9）：由驱动循环
   * 针对现有写入契约执行；绝非视图状态变更 */
  | { type: "act"; act: "open-terminal"; view: string; expectedPlan?: string }
  | { type: "act"; act: "run"; rigId: string; agent: string }
  | { type: "notice"; message: string };

/** FR-12：分区集是一个代码内注册——添加分区是对
 * 此数据结构的局部编辑，绝非分散的 switch。 */
export interface SectionDef {
  name: string;
  /** 来源说明：哪个现有后台服务读取馈送它（R7 无新数据轨迹） */
  sourceRead: string;
  drillShape: string;
}

export interface ViewState {
  terminalResult?: { view: string; message: string };
  terminalView?: string | null;
  terminalPage?: number;
  attentionOpen?: string | null;
  attentionCategory?: "action" | "update" | null;
  file?: import("./reading.js").FileTarget | null;
  externalUrl?: string | null;
  timeZone: string;
  timeZoneWarning: string | null;
  timeZoneHelp: boolean;
  recentOpen: RecentTransitionSnap | null;
  history?: NavigationFrame[];
  configCategory?: string | null;
  configKey?: string | null;
  /** 从任何实例/工作组/席位表面打开的规范健康发现。 */
  healthOpen: string | null;
  /** 范围视图：执行故事打开的任务目标（null = 仅选择器）。 */
  project?: ProjectSelection | null;
  scopesMission: string | null;
  /** 范围视图：打开的切片（null = 仅树）。 */
  scopesSelected: { mission: string; slice: string } | null;
  /** 范围视图标志：小需求已折叠 · 叙事面板打开。 */
  scopesCollapseReqs: boolean;
  scopesNarrative: boolean;
  /** 执行钻取：打开的行键（null = 四组概览）。 */
  executionOpen: string | null;
  /** REGISTRY I3——打开命令面板（null = 关闭）。 */
  palette: { query: string; selection: number } | null;
  instanceId: string;
  sections: SectionDef[];
  section: string;
  drill: DrillSegment[];
  filter: string;
  selection: number;
  runningOf: string | null;
  viewTab: ViewTab;
  contentOffset: number;
  contentMaxOffset: number;
  contentTargetCount: number;
  contentSelection: number;
  focusedPane: "explorer" | "content";
  /** 终端原生拖拽选择/复制拥有指针时为 true */
  copyMode: boolean;
  /** slice-17 图视图渲染样式（按创建者裁决的 hatchet 主线） */
  graphStyle: string;
  /** 工作组流页脚是环境的：可切换，绝非可导航视图（FR-10） */
  footerOn: boolean;
  /** 资源管理器展开键（pod:…, folder:…）——默认折叠层级按需打开 */
  expanded: string[];
  /** 已执行 act 的瞬态结果行（后台服务回复，逐字） */
  notice: string | null;
  lastError: string | null;
}

export type NavigationFrame = Pick<ViewState, "attentionCategory" | "attentionOpen" | "project" | "terminalView" | "terminalPage" | "file" | "externalUrl" | "section" | "drill" | "filter" | "selection" | "runningOf" | "viewTab" | "contentOffset" | "contentMaxOffset" | "contentTargetCount" | "contentSelection" | "focusedPane" | "scopesMission" | "scopesSelected" | "scopesCollapseReqs" | "scopesNarrative" | "executionOpen" | "expanded" | "timeZoneHelp" | "recentOpen" | "configCategory" | "configKey">;

export interface ViewStateStore {
  instanceId: string;
  get(): ViewState;
  dispatch(action: Action): ViewState;
  subscribe(fn: (state: ViewState) => void): () => void;
}

export interface ExplorerRow {
  label: string;
  action: Action;
  /** 单格披露命中。与行的打开/钻取动作分开。 */
  disclosureAction?: Action;
  /** 稳定身份——选择同步为当前位置查找行 */
  key?: string;
}

export interface HitTarget {
  y: number;
  x1: number;
  x2: number;
  action: Action;
}

/** S19 round-5（守卫）：刷新拥有者的诚实加载生命周期——加载
 * 旋转器可乘的唯一状态（数据缺失非生命周期事实） */
export interface LoadState {
  lastSuccessAt?: number;
  /** 因最新读取失败而保留的最旧成功源。 */
  retainedAt?: number;
  /** 已知变更或失去权威联系；仅安静经过时间绝不设置此值。 */
  stale?: boolean;
  connection?: "connected" | "dropped" | "reconnecting" | "unavailable";
  /** 水合刷新正在运行 */
  inFlight: boolean;
  /** 至少一次刷新已完成（成功或失败） */
  settled: boolean;
}

/** S19 round-5（守卫）：一个席位的新窗格输出事件——键匹配
 * 智能体的稳定资源管理器行键；at = 观察时拥有者时钟毫秒 */
export interface RowFlash {
  key: string;
  at: number;
}

export interface Screen {
  lines: string[];
  /** 实际 L2 窗格边界；输入和样式消费此确切值 */
  explorerWidth: number;
  hitMap: HitTarget[];
  contentTargets: HitTarget[];
  contentMaxOffset: number;
  explorerRows: Array<ExplorerRow & { y: number }>;
  /** slice-17：画布渲染内容行的标记段（以
   * 1 基终端行为键）——绘制层用自身 Style 渲染它们；
   * plain(segs) === 行内容文本，由构造保证（去标记不变） */
  segRows?: Record<number, Array<{ text: string; token?: import("./theme.js").Token; bold?: boolean; bg?: import("./theme.js").Token; inverse?: boolean }>>;
  /** S19：资源管理器标记运行通道——行的绘制运行（round-4：状态
   * 徽章 + 右侧元数据）通过样式携带自身标记（以
   * 1 基行为键；start = 选择
   * 标记槽后左单元格内的列；运行按升序 start） */
  explorerMeta?: Record<number, Array<{ start: number; segs: Array<{ text: string; token?: import("./theme.js").Token; bold?: boolean; bg?: import("./theme.js").Token; inverse?: boolean }> }>>;
  /** S19 round-5（守卫）：智能体在一次性闪烁窗口内产生新
   * 窗格输出的 1 基终端行——stylize 反显恰好
   * 这些行（tmux 式活动行闪烁） */
  flashRows?: number[];
  /** 此帧包含时间驱动动作时为 true（旋转器帧或
   * 未过期闪烁）——条目循环在设置时保持重绘 */
  motionActive?: boolean;
  /** 命令就绪脉冲独立于内容加载/进度。 */
  commandMotionActive?: boolean;
}

export type InputEvent =
  | { type: "paste"; text: string }
  | { type: "char"; ch: string }
  | { type: "key"; key: "up" | "down" | "left" | "right" | "pageup" | "pagedown"; action: Action }
  | { type: "key"; key: "enter"; action: Action }
  | { type: "key"; key: "backspace" | "escape" | "tab" }
  | { type: "mouse"; button: number; x: number; y: number };
