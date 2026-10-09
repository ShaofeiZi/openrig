import { composeHumanUpdates, type DeliveredHumanUpdates } from "./attention/attention-model.js";
import { readTerminals } from "./terminals/terminal-model.js";
import { fileTargetForPath } from "./reading.js";
// 快照水合器：将 §4.A 后台服务读取（通过 DaemonClient，唯一 HTTP
// 模块）映射为渲染器的 FleetSnapshot。映射纪律
// （PIN 2/PIN 3，规划器 Phase-2 提醒）：
//   - 状态和需要你内容逐字来自已服务
//     投影——无合成，无过时"改进"，无客户端
//     阈值。带工作空闲阈值已序列化到达
//     在已服务证据/阈值字符串内，因此此模块完全不需要
//     阈值常量（无重算——
//     "不要重新硬编码 IDLE_WITH_WORK_THRESHOLD_MIN" 的诚实形式）。
//   - 两个 `卡住` 腿（带工作空闲 vs 状态过久）保持独立
//     由构造：身份/摘要/证据/阈值逐字渲染。
//   - 主机/工作组降级在条目旁组合（hostsDown），绝不进入它们。
//   - 失败读取使其部分诚实空并记录命名错误。
import { emptySnapshot } from "./state.js";
import type { ConfigRead } from "./config/config-model.js";
import type { ConnectionsRead, ControlPlaneRead, SlackManifestRead } from "./connections/connections-model.js";
import { DaemonClient } from "./daemon-client.js";
import { parse as parseYaml } from "yaml";
import type { AgentRow, FleetSnapshot, HealthRecord, HostNode, NeedsItem, PodNode, QueueRead, RecentTransitionSnap, SeatActivitySummary, SliceDetailSnap, SpecEntry, ViewState } from "./types.js";
import { isHumanSeatSession } from "./pulse/pulse-model.js";

// 窄读取形状：仅此模块消费的已服务字段（名称匹配
// 后台服务序列化输出——见 Phase-2 端点形状调查）。
interface RigSummaryRead {
  id: string;
  name: string;
  lifecycleState?: string;
  hasLiveAgents?: boolean | null;
}
interface RigStatusRead {
  status?: string;
  seatsTotal?: number;
  seatsRunning?: number;
}
interface InstanceHealthRead extends ControlPlaneRead {
  selfHostId?: string | null;
}
interface HealthProjectionRead {
  schema: "openrig.health-list/v0alpha1";
  evaluatedAt: string | null;
  total: number;
  limit: number;
  truncated: boolean;
  records: HealthRecord[];
}
interface NodeInventoryRead {
  nodeId?: string;
  logicalId: string;
  podNamespace?: string | null;
  nodeKind: "agent" | "infrastructure";
  runtime: string | null;
  model?: string | null;
  lifecycleState: string;
  sessionStatus?: string | null;
  startupStatus?: string | null;
  terminalActive?: boolean | null;
  /** arch 3a947fb1：原始 window_activity ISO（拥有者空闲年龄在
   * 渲染器派生）。席位无观测时缺失/null。 */
  lastActivityAt?: string | null;
  agentActivity?: {
    state?: string;
    reason?: string | null;
    evidenceSource?: string | null;
    eventAt?: string | null;
  } | null;
  /** S19——已服务分类状态；显示来自后台服务的唯一桥。 */
  activityState?: {
    activity?: string | null;
    display?: string;
    needsInput?: { count?: number; reason?: string | null } | null;
    decidedBy?: string | null;
  } | null;
  identityVerdict?: { verdict?: string } | null;
  canonicalSessionName: string | null;
  tmuxAttachCommand?: string | null;
  cwd?: string | null;
  resolvedSpecName: string | null;
  profile?: string | null;
  resolvedSpecVersion?: string | null;
  resolvedSpecHash?: string | null;
  contextUsage?: {
    availability: "known" | "unknown";
    usedPercentage: number | null;
    contextWindowSize: number | null;
    totalInputTokens: number | null;
    totalOutputTokens: number | null;
  };
  hasAssignedWork?: boolean;
  assignedWorkCount?: number;
  pendingWorkCount?: number;
  inProgressWorkCount?: number;
  blockedWorkCount?: number;
}
interface SpecLibraryRead {
  id: string;
  kind: "rig" | "agent" | "workflow";
  name: string;
  version?: string;
  sourcePath?: string;
  resolvedSourcePath?: string | null;
  sourceType?: "builtin" | "user_file";
  relativePath?: string;
  updatedAt?: string;
  /** 仅工作流条目（在列表读取上服务） */
  rolesCount?: number;
  stepsCount?: number;
  status?: string;
}
interface AgentSpecReviewRead {
  sourceState?: "draft" | "file_preview" | "library_item";
  kind: "agent";
  description?: string;
  profiles?: Array<{ name: string }>;
  resources?: { skills?: string[]; guidance?: string[]; plugins?: string[]; subagents?: string[] };
  startup?: { files?: Array<{ path: string; required: boolean }> };
  raw?: string;
}
interface RigSpecReviewRead {
  sourceState?: "draft" | "file_preview" | "library_item";
  kind: "rig";
  format?: "pod_aware" | "legacy";
  pods?: Array<{
    id: string;
    namespace?: string;
    label?: string;
    members: Array<{ id: string; agentRef: string; runtime: string; profile?: string }>;
    edges: Array<{ from: string; to: string; kind: string }>;
  }>;
  nodes?: Array<{ id: string; runtime: string; role?: string; model?: string }>;
  edges?: Array<{ from: string; to: string; kind: string }>;
  graph?: {
    nodes: Array<{ id: string; label: string; pod?: string; runtime: string; kind: "agent" | "infrastructure" }>;
    edges: Array<{ source: string; target: string; kind: string }>;
  };
  raw?: string;
}
type SpecLibraryReviewRead = AgentSpecReviewRead | RigSpecReviewRead;
interface RigSpecJsonRead {
  name?: string;
  pods?: Array<{ members?: Array<{ agentRef?: string }> }>;
}
interface NeedsYouItemRead {
  hostId?: string;
  source: "agent" | "derived";
  identity: string;
  summary: string;
  leg: string;
  where: string;
  destinationSession: string | null;
  derived: { kind: string; evidence: string; threshold: string } | null;
  qitemId: string | null;
  evidenceRef: string | null;
  unblocks: string | null;
}
interface ReviewFleetRead {
  needsYou?: { items?: NeedsYouItemRead[] };
  hosts?: Array<{ hostId: string; status: { status: string } }>;
  registryError?: string | null;
}
interface AttentionAggregateRead {
  hosts?: Array<{ hostId: string; status: string; error?: string }>;
}
interface StreamItemRead {
  tsEmitted: string;
  sourceSession: string;
  body: string;
  streamSortKey: string;
}
// PULSE 联接消费的已服务队列条目字段（camelCase QueueItem，
// queue-repository.ts）。两个读取返回此形状；TUI 映射 + 呈现。
interface QueueItemRead {
  sourceSession?: string | null;
  qitemId: string;
  state: string;
  destinationSession: string;
  blockedOn: string | null;
  handedOffTo: string | null;
  tier: string | null;
  tags: string[] | null;
  summary: string | null;
  body?: string;
  claimedAt: string | null;
  tsUpdated: string;
}

function toQueueRead(item: QueueItemRead): QueueRead {
  return {
    qitemId: item.qitemId,
    sourceSession: item.sourceSession,
    state: item.state,
    destinationSession: item.destinationSession,
    blockedOn: item.blockedOn,
    handedOffTo: item.handedOffTo,
    tier: item.tier,
    tags: item.tags,
    summary: item.summary,
    body: item.body ?? "",
    claimedAt: item.claimedAt,
    tsUpdated: item.tsUpdated,
  };
}

function fmtTokens(input: number | null, output: number | null): string | null {
  if (input == null && output == null) return null;
  const total = (input ?? 0) + (output ?? 0);
  return total >= 1000 ? `${Math.round(total / 1000)}k` : String(total);
}

function toAgentRow(node: NodeInventoryRead): AgentRow {
  const ctx = node.contextUsage;
  const known = ctx?.availability === "known";
  const identityDownranked = node.identityVerdict?.verdict === "mismatch"
    || node.identityVerdict?.verdict === "pane_missing";
  return {
    nodeId: node.nodeId,
    name: node.logicalId,
    runtime: node.runtime ?? "未知",
    model: node.model ?? null,
    spec: node.resolvedSpecName ?? "",
    profile: node.profile ?? null,
    specVersion: node.resolvedSpecVersion ?? null,
    specHash: node.resolvedSpecHash ?? null,
    // 诚实未知：投影中无值 → null → 渲染 "—"
    context: known && ctx.usedPercentage != null ? Math.round(ctx.usedPercentage) : null,
    tokens: known ? fmtTokens(ctx.totalInputTokens, ctx.totalOutputTokens) : null,
    contextWindowSize: known ? ctx.contextWindowSize : null,
    totalInputTokens: known ? ctx.totalInputTokens : null,
    totalOutputTokens: known ? ctx.totalOutputTokens : null,
    hasAssignedWork: node.hasAssignedWork,
    assignedWorkCount: node.assignedWorkCount,
    pendingWorkCount: node.pendingWorkCount,
    inProgressWorkCount: node.inProgressWorkCount,
    blockedWorkCount: node.blockedWorkCount,
    activity: {
      activity: node.activityState?.activity ?? node.activityState?.display ?? node.agentActivity?.state ?? null,
      needsInput: node.activityState?.needsInput
        ? { count: node.activityState.needsInput.count ?? 0, reason: node.activityState.needsInput.reason ?? null }
        : null,
      decidedBy: node.activityState?.decidedBy ?? null,
      signalReason: node.agentActivity?.reason ?? null,
      signalSource: node.agentActivity?.evidenceSource ?? null,
      eventAt: node.agentActivity?.eventAt ?? null,
    },
    // 镜像维护的 web 投影：生命周期真相驱动动作，
    // 而会话/终端活动驱动可见状态标签。
    status: node.startupStatus === "failed"
      ? "failed"
      : node.lifecycleState === "attention_required" || identityDownranked || node.startupStatus === "attention_required"
        ? "attention_required"
        // S19：已服务分类显示优先决策（后台服务唯一桥）；
        // 下方内联混合仅作为分类前回退存活。
        : node.activityState?.display === "needs-input"
          ? "needs_input"
          : node.agentActivity?.state === "needs_input"
            ? "needs_input"
            : node.sessionStatus === "running" || node.sessionStatus === "ready"
              ? (node.activityState?.display === "working"
                  ? "active"
                  : node.activityState?.display === "idle"
                    ? "idle"
                    : (node.terminalActive === true || (node.terminalActive == null && node.agentActivity?.state === "running") ? "active" : "idle"))
              : (node.sessionStatus ?? "unknown"),
    live: node.lifecycleState === "running",
    canRun: node.lifecycleState !== "running"
      && node.sessionStatus !== "running"
      && node.sessionStatus !== "ready"
      && node.terminalActive !== true,
    session: node.canonicalSessionName,
    attach: node.tmuxAttachCommand ?? null,
    cwd: node.cwd ?? null,
    // S19 round-5：已服务 terminalActive 逐字——窗格输出基底
    // （静默窗口内的 tmux window_activity）；null = 无信号
    paneActive: node.terminalActive ?? null,
  };
}

function groupPods(nodes: NodeInventoryRead[]): PodNode[] {
  const pods = new Map<string, AgentRow[]>();
  for (const node of nodes) {
    if (node.nodeKind !== "agent") continue;
    const pod = node.podNamespace ?? "(无席位)";
    const list = pods.get(pod) ?? [];
    list.push(toAgentRow(node));
    pods.set(pod, list);
  }
  return [...pods.entries()].map(([name, agents]) => ({ name, agents }));
}

function toNeedsItem(item: NeedsYouItemRead): NeedsItem {
  // 逐字携带：已服务 kind + 摘要/证据；目标是
  // 后台服务已命名的会话/where（派生行的身份前缀）
  const target = item.source === "derived" ? (item.identity.split("|")[0] ?? item.where) : (item.destinationSession ?? item.where);
  const detail = item.derived ? `${item.summary} — ${item.derived.evidence}` : item.summary;
  return {
    source: item.source,
    kind: item.derived?.kind ?? item.leg,
    target,
    detail,
    qitemId: item.qitemId,
    evidenceRef: item.evidenceRef,
    unblocks: item.unblocks,
    ...(item.hostId ? { hostId: item.hostId } : {}),
  };
}

function resolveAgentRef(ref: string, agentSpecNames: Set<string>): string {
  if (agentSpecNames.has(ref)) return ref;
  const basename = ref.replace(/\/+$/, "").split("/").at(-1)?.replace(/\.(?:ya?ml|json)$/, "");
  return basename && agentSpecNames.has(basename) ? basename : ref;
}

function agentNamespace(relativePath?: string): string | undefined {
  if (!relativePath) return undefined;
  const parts = relativePath.replaceAll("\\", "/").split("/").filter(Boolean);
  const dirs = parts.slice(0, -1);
  const agentsAt = dirs.lastIndexOf("agents");
  const candidates = agentsAt >= 0 ? dirs.slice(agentsAt + 1) : dirs;
  if (parts.at(-1) === "agent.yaml" || parts.at(-1) === "agent.yml") candidates.pop();
  return candidates.length > 0 ? candidates.join("/") : undefined;
}

function agentSpecTruth(raw?: string): { runtime?: string; skills: string[] } {
  if (!raw) return { skills: [] };
  try {
    const spec = parseYaml(raw) as Record<string, unknown> | null;
    if (!spec || typeof spec !== "object") return { skills: [] };
    const defaults = spec["defaults"] as Record<string, unknown> | undefined;
    const profiles = spec["profiles"] as Record<string, unknown> | undefined;
    const profile = (profiles?.["default"] ?? Object.values(profiles ?? {})[0]) as Record<string, unknown> | undefined;
    const uses = profile?.["uses"] as Record<string, unknown> | undefined;
    const skills = Array.isArray(uses?.["skills"])
      ? uses["skills"].filter((skill): skill is string => typeof skill === "string")
      : [];
    return {
      ...(typeof defaults?.["runtime"] === "string" ? { runtime: defaults["runtime"] } : {}),
      skills,
    };
  } catch {
    return { skills: [] };
  }
}

/** 规范详情评审的跨周期备忘录，以 `${id}@${updatedAt}` 为键——
 *  避免每次刷新重读每个规范；键在库
 *  条目的 updatedAt 变更时滚动。由调用者拥有（实例范围，无模块状态）。 */
export type SpecReviewCache = Map<string, SpecLibraryReviewRead>;
export type HydrateViewContext = Pick<ViewState, "project" | "section" | "viewTab" | "drill" | "file" | "externalUrl" | "terminalView" | "attentionOpen">;

export async function hydrateSnapshot(
  client: DaemonClient,
  reviewCache?: SpecReviewCache,
  executionMission?: string | null,
  sliceDetailName?: string | null,
  currentRigName?: string | null,
  viewContext?: HydrateViewContext,
): Promise<FleetSnapshot> {
  const readErrors: string[] = [];
  async function safe<T>(label: string, fn: () => Promise<unknown>): Promise<T | null> {
    try {
      return (await fn()) as T;
    } catch (err) {
      readErrors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  if (viewContext?.file) {
    const target = viewContext.file;
    const [result, roots] = await Promise.all([client.readFile(target), safe<Awaited<ReturnType<DaemonClient["fileRoots"]>>>("文件根", () => client.fileRoots())]);
    if (!("error" in result) && !result.resolvedPath) {
      const canonical = fileTargetForPath(result.absolutePath, roots?.roots ?? []);
      if (canonical?.root === target.root) result.resolvedPath = canonical.path;
    }
    return { ...emptySnapshot(), fileRead: { target, result, readAt: new Date().toISOString() }, fileRoots: roots?.roots ?? [], readErrors, hydratedAt: new Date().toISOString() };
  }
  if (viewContext?.externalUrl) return { ...emptySnapshot(), hydratedAt: new Date().toISOString() };

  if (viewContext?.section === "needs") {
    const [attention, updates, roots] = await Promise.all([
      safe<NonNullable<FleetSnapshot["attentionRead"]>>("attention", () => client.humanAttention(viewContext.attentionOpen)),
      safe<DeliveredHumanUpdates>("已送达更新", () => client.humanUpdates()),
      safe<Awaited<ReturnType<DaemonClient["fileRoots"]>>>("文件根", () => client.fileRoots()),
    ]);
    const attentionRead = composeHumanUpdates(attention, updates, viewContext.attentionOpen);
    return { ...emptySnapshot(), attentionRead, fileRoots: roots?.roots ?? [], readErrors, hydratedAt: new Date().toISOString() };
  }

  if (viewContext?.section === "system") {
    const health = await safe<HealthProjectionRead>("health-findings", () => client.healthFindings());
    return { ...emptySnapshot(), ...(health ? { health: { ...health, availability: "loaded" as const } } : {}), readErrors, hydratedAt: new Date().toISOString() };
  }

  // 项目读取绝不回退到后台服务的默认工作区或队列。
  if (viewContext?.section === "scopes") {
    const projects = await safe<NonNullable<FleetSnapshot["projects"]>>("projects", () => client.projects());
    const selected = viewContext.project;
    const project = selected && projects?.projects.find(p => p.id === selected.id && p.root === selected.root);
    if (selected && (!project || project.error)) readErrors.push(`project ${selected.id}: ${project?.error ?? "选择已变更或不可用；请重新选择项目"}`);
    const readable = !!project && !project.error;
    const scopes = readable ? await safe<{ missions: FleetSnapshot["scopes"]; sources?: Record<string, string>; readErrors?: string[] }>("scopes", () => client.scopesDetailed(selected)) : null;
    const mission = scopes?.missions?.find(m => m.mission === executionMission);
    const slice = mission?.slices.find(s => s.dirName === sliceDetailName);
    const [execution, detail, roots] = await Promise.all([
      readable && executionMission && !mission?.error ? safe<{ rows: NonNullable<FleetSnapshot["execution"]>[] }>("execution", () => client.execution(executionMission, selected)) : null,
      readable && executionMission && sliceDetailName && !mission?.error && !slice?.error ? safe<SliceDetailSnap>("slice-detail", () => client.sliceDetail(sliceDetailName, executionMission, selected)) : null,
      safe<Awaited<ReturnType<DaemonClient["fileRoots"]>>>("文件根", () => client.fileRoots()),
    ]);
    readErrors.push(...(scopes?.readErrors ?? []));
    return { ...emptySnapshot(), projects, projectRead: selected, projectSources: scopes?.sources, scopes: scopes?.missions ?? [], execution: execution?.rows[0] ?? null, executionMission, sliceDetail: detail, sliceDetailName, fileRoots: roots?.roots ?? [], readErrors, hydratedAt: new Date().toISOString() };
  }

  if (viewContext?.section === "terminals") {
    const terminals = await readTerminals(client, viewContext.terminalView);
    return { ...emptySnapshot(), terminals, hydratedAt: new Date().toISOString(), readErrors: terminals.error ? [terminals.error] : [] };
  }

  // CONFIG 绝不调用组聚合、主机探测、队列丰富或提供者检查。
  // 失败以显式不可用状态替换先前值。
  if (viewContext?.section === "config") {
    let configError: string | undefined;
    const passive = async <T>(label: string, read: () => Promise<unknown>): Promise<T | null> => {
      try { return await read() as T; } catch { readErrors.push(`${label}: 不可用`); return null; }
    };
    const [config, controlPlane, connections] = await Promise.all([
      passive<ConfigRead>("配置读取", () => client.configBrowser().catch(error => {
        configError = error instanceof Error ? error.message : "读取失败；原因未识别。";
        throw error;
      })),
      passive<ControlPlaneRead>("后台控制面", () => client.health()),
      passive<ConnectionsRead>("Slack 连接观察", () => client.connections()),
    ]);
    let daemonTarget = "未报告";
    try { daemonTarget = new URL(client.baseUrl).origin; } catch { /* no raw invalid target */ }
    return { ...emptySnapshot(), config, configError, controlPlane, connections, daemonTarget, hydratedAt: new Date().toISOString(), readErrors };
  }

  const readingOnly = viewContext?.section === "specs";
  const fileRoots = readingOnly ? await safe<Awaited<ReturnType<DaemonClient["fileRoots"]>>>("文件根", () => client.fileRoots()) : null;
  const topologyLeaf = viewContext?.section === "topology" ? viewContext.drill.at(-1) : undefined;
  const wantsConnections = viewContext?.section === "connections";
  const wantsSpecs = !viewContext || viewContext.section === "specs" || topologyLeaf?.kind === "agent";
  const wantsTopologyScope = !viewContext || viewContext.section === "topology";
  const wantsRecent = wantsTopologyScope && (!topologyLeaf || topologyLeaf.kind === "host" || topologyLeaf.kind === "rig");
  const focusedTopology = !!viewContext && wantsTopologyScope && viewContext.viewTab !== "pulse";
  const broadReads = !readingOnly && !focusedTopology && !wantsConnections;
  const wantsGraph = wantsTopologyScope && (!viewContext || viewContext.viewTab === "graph");

  const [instanceHealth, healthProjection, agg, summaries, library, review, streamItems, attention, blocked, inProgress, pending, recentlyFinished, scopesRead, executionRead, sliceDetailRead, connectionsRead] = await Promise.all([
    safe<InstanceHealthRead>("health", () => client.health()),
    !(broadReads || viewContext?.viewTab === "health") ? Promise.resolve(null) : safe<HealthProjectionRead>("health-findings", () => client.healthFindings()),
    !broadReads ? Promise.resolve(null) : safe<AttentionAggregateRead>("attention-aggregate", () => client.attentionAggregate()),
    readingOnly ? Promise.resolve(null) : safe<RigSummaryRead[]>("rigs-summary", () => client.rigsSummary()),
    (wantsSpecs || wantsConnections) ? safe<SpecLibraryRead[]>("specs-library", () => client.specsLibrary()) : Promise.resolve(null),
    !broadReads ? Promise.resolve(null) : safe<ReviewFleetRead>("review-fleet", () => client.reviewFleet()),
    !broadReads ? Promise.resolve(null) : safe<StreamItemRead[]>("stream-tail", () => client.streamLatest()),
    // PULSE ▲ 需要你 + ⧗ 阻塞 + ◌ 停驻——已交付队列读取（增量 2/2b）
    !broadReads ? Promise.resolve(null) : safe<QueueItemRead[]>("queue-attention", () => client.queueAttention()),
    !broadReads ? Promise.resolve(null) : safe<QueueItemRead[]>("queue-blocked", () => client.queueBlocked()),
    !broadReads ? Promise.resolve(null) : safe<QueueItemRead[]>("queue-in-progress", () => client.queueInProgress()),
    // PULSE 下一个 + 刚完成泳道读取（增量 3）——相同已交付 /list 路由
    !broadReads ? Promise.resolve(null) : safe<QueueItemRead[]>("queue-pending", () => client.queuePending()),
    !broadReads ? Promise.resolve(null) : safe<QueueItemRead[]>("queue-recently-finished", () => client.queueRecentlyFinished()),
    !broadReads ? Promise.resolve(null) : safe<{ missions: unknown[]; sourceObservation?: { state: string } }>("scopes", () => client.scopesDetailed() as Promise<{ missions: unknown[] }>),
    !broadReads ? Promise.resolve(null) : safe<{ rows: unknown[] }>("execution", () => client.execution(executionMission ?? undefined) as Promise<{ rows: unknown[] }>),
    broadReads && sliceDetailName
      ? safe<SliceDetailSnap>(`slice-detail(${sliceDetailName})`, () => client.sliceDetail(sliceDetailName))
      : Promise.resolve(null),
    wantsConnections ? safe<ConnectionsRead>("connections", () => client.connections()) : Promise.resolve(null),
  ]);

  // 可选：旧后台服务无清单路由；页面则指向 CLI。
  const slackManifest = wantsConnections
    ? await (client.slackManifest() as Promise<SlackManifestRead>).then((m) => (typeof m?.url === "string" && typeof m?.yaml === "string" ? m : null), () => null)
    : null;

  const agentSpecNames = new Set((library ?? []).filter((entry) => entry.kind === "agent").map((entry) => entry.name));
  if (scopesRead?.sourceObservation?.state === "unavailable") readErrors.push("scopes: 证明源更新不可用；仅当前 HTTP 基础");
  if (review?.registryError) readErrors.push(`review-fleet registry: ${review.registryError}`);
  const recentTransitionsRig = currentRigName ?? (!viewContext ? summaries?.[0]?.name : null) ?? null;
  const recentTransitionsScope = topologyLeaf?.kind === "host"
    ? { kind: "instance" } as const
    : recentTransitionsRig ? { kind: "rig", rig: recentTransitionsRig } as const : null;
  const recentTransitions = wantsRecent && recentTransitionsScope
    ? await safe<RecentTransitionSnap[]>(
        `queue-recent(${recentTransitionsScope.kind === "instance" ? "instance" : recentTransitionsScope.rig})`,
        () => client.queueRecentTransitions(recentTransitionsScope),
      )
    : null;

  // 被智能体阻塞标签==所指（r1 发现）：blockedOn 是智能体阻塞的 qitem 指针，
  // 因此阻塞智能体是该 qitem 的拥有者。通过已交付
  // 单 qitem 后台服务读取（client.queueItem）解析每个——有界
  // 逐行查找。规范人类引用优先，即使其
  // 本地部分以 qitem- 开头；类型化和遗留门不是本地 id。
  // 未命中（门名 / 已关闭阻塞者）在渲染时安静降级为原始 blockedOn
  // （诚实）——这是丰富，绝非承重读取，因此它绝不能
  // 污染 readErrors / "读取失败" 状态行（阻塞列表读取
  // 本身是承重的，已通过 safe()）。
  const blockedResolved: QueueRead[] = await Promise.all(
    (blocked ?? []).map(async (item) => {
      const read = toQueueRead(item);
      if (read.blockedOn && !isHumanSeatSession(read.blockedOn) && read.blockedOn.startsWith("qitem-")) {
        const blocker = (await client.queueItem(read.blockedOn, { optional: true }).catch(() => null)) as QueueItemRead | null;
        read.blockerSession = blocker?.destinationSession ?? null;
      }
      return read;
    }),
  );

  // 拓扑：本地主机扩展为后台服务的工作组；远程主机
  // 来自仅带可达性的聚合（每工作组启动；全部工作组
  // 级别故意设计不足——创建者捕获）。
  const rigs = [];
  const rigsDown: FleetSnapshot["hostsDown"] = [];
  const rigSpecRefs = new Map<string, string[]>(); // rig-spec name → agentRefs
  const rigConsumers = new Map<string, NonNullable<SpecEntry["consumers"]>>();
  // PULSE ◌ 停驻待接力——联接的 ps/活动侧，从馈送拓扑的
  // 同一节点读取跨工作组累积（无额外获取）：
  // 每个带规范会话的智能体席位一条（基础设施席位无）。
  const seatActivity: SeatActivitySummary[] = [];
  for (const rig of summaries ?? []) {
    const readInventory = wantsConnections ? connectionsRead?.configuration?.inboundDestination?.split("@")[1] === rig.name
      : !focusedTopology || topologyLeaf?.kind === "host" || currentRigName === rig.name;
    const nodes = readInventory ? await safe<NodeInventoryRead[]>(`nodes(${rig.name})`, () => client.rigNodes(rig.id)) : null;
    for (const node of nodes ?? []) {
      if (node.nodeKind !== "agent" || !node.canonicalSessionName) continue;
      seatActivity.push({
        session: node.canonicalSessionName,
        // 紧凑泳道形式（r1 裁决）：node.logicalId 逐字服务——
        // 表渲染为智能体名称的相同值——不从
        // 会话字符串重建（连字符分割会有损）。
        logicalId: node.logicalId,
        terminalActive: node.terminalActive ?? null,
        lastActivityAt: node.lastActivityAt ?? null,
      });
    }
    // slice-17：拓扑图视图消费声明式 §4.A 图读取
    // （一次获取中的节点 + 边 + 覆盖）；失败读取使视图
    // 诚实空并带命名错误，绝不伪造框。
    const graph = wantsGraph && (topologyLeaf?.kind === "host" || recentTransitionsRig === rig.name)
      ? await safe<import("./topology/graph-types.js").RigGraph>(`graph(${rig.name})`, () => client.rigGraph(rig.id))
      : null;
    const rigRow = {
      id: rig.id,
      name: rig.name,
      pods: nodes ? groupPods(nodes) : [],
      ...(!readInventory ? { inventoryNotLoaded: true } : nodes === null ? { inventoryUnavailable: true } : {}),
      ...(graph ? { graph } : {}),
      ...(rig.lifecycleState ? { lifecycleState: rig.lifecycleState } : {}),
      hasLiveAgents: rig.hasLiveAgents ?? null,
      authoredSpecName: undefined as string | undefined,
    };
    rigs.push(rigRow);
    if (broadReads && rig.lifecycleState && rig.lifecycleState !== "running") {
      // 工作组降级腿（§4.A）：摘要 lifecycleState 逐字，由
      // 工作组状态投影在应答处丰富——在条目旁组合。
      const st = await safe<RigStatusRead>(`rig-status(${rig.name})`, () => client.rigStatus(rig.id));
      const seatDetail = st && st.seatsTotal != null ? `${st.seatsRunning ?? 0}/${st.seatsTotal} 个席位运行中` : undefined;
      rigsDown.push({
        hostId: `rig:${rig.name}`,
        status: st?.status ? `${rig.lifecycleState} (${st.status})` : rig.lifecycleState,
        ...(seatDetail ? { error: seatDetail } : {}),
      });
    }
    const spec = (wantsSpecs || wantsConnections)
      ? await safe<RigSpecJsonRead>(`rig-spec(${rig.name})`, () => client.rigSpec(rig.id))
      : null;
    rigRow.authoredSpecName = spec?.name;
    if (spec?.name) rigConsumers.set(spec.name, [...(rigConsumers.get(spec.name) ?? []), { rig: rig.name, host: instanceHealth?.selfHostId?.trim() || "local", status: rig.lifecycleState ?? "unknown" }]);
    if (spec?.pods) {
      const refs = spec.pods.flatMap((p) =>
        (p.members ?? [])
          .map((m) => m.agentRef)
          .filter((r): r is string => !!r)
          .map((ref) => resolveAgentRef(ref, agentSpecNames)),
      );
      if (spec.name) rigSpecRefs.set(spec.name, refs);
    }
  }
  const aggHosts = agg?.hosts ?? [];
  const localHost: HostNode = {
    id: "local",
    name: instanceHealth?.selfHostId?.trim() || "local",
    reachable: true,
    rigs,
  };
  const remoteHosts: HostNode[] = aggHosts
    .filter((h) => h.hostId !== "local")
    .map((h) => ({ id: h.hostId, name: h.hostId, reachable: h.status === "ok", rigs: [] }));

  // 规范：工作组 + 智能体通过消费现有结构化评审落地良好，
  // 两种类型均如此。工作流保持基础。评审按 updatedAt 备忘录化。
  async function specReview(entry: SpecLibraryRead): Promise<SpecLibraryReviewRead | null> {
    const key = `${entry.id}@${entry.updatedAt ?? ""}`;
    const cached = reviewCache?.get(key);
    // 重读所选源：磁盘上的编辑不需更新库行。
    if (cached && viewContext?.drill.at(-1)?.name !== entry.name) return cached;
    const review = await safe<SpecLibraryReviewRead>(`spec-review(${entry.name})`, () => client.specLibraryReview(entry.id));
    if (review && reviewCache) reviewCache.set(key, review);
    return review;
  }

  const reviewed = new Map<string, SpecLibraryReviewRead>();
  await Promise.all(
    (wantsSpecs ? library ?? [] : []).filter((entry) => entry.kind !== "workflow").map(async (entry) => {
      const detail = await specReview(entry);
      if (detail) reviewed.set(entry.id, detail);
    }),
  );

  const reviewedRigRefs = new Map<string, string[]>();
  for (const entry of library ?? []) {
    const detail = reviewed.get(entry.id);
    if (entry.kind !== "rig" || detail?.kind !== "rig" || detail.format !== "pod_aware") continue;
    const refs: string[] = [];
    for (const pod of detail.pods ?? []) {
      for (const member of pod.members) {
        const ref = resolveAgentRef(member.agentRef, agentSpecNames);
        refs.push(ref);
      }
    }
    reviewedRigRefs.set(entry.name, refs);
  }
  const allRigRefs = new Map([...rigSpecRefs, ...reviewedRigRefs]);

  const specs: SpecEntry[] = await Promise.all(
    (library ?? []).map(async (entry): Promise<SpecEntry> => {
      const base = {
        name: entry.name,
        version: entry.version,
        sourcePath: entry.sourcePath,
        resolvedSourcePath: entry.resolvedSourcePath,
        sourceType: entry.sourceType,
        relativePath: entry.relativePath,
        consumers: readingOnly ? undefined : entry.kind === "rig" ? rigConsumers.get(entry.name) ?? [] : entry.kind === "agent" ? localHost.rigs.flatMap((rig) => rig.pods.flatMap((pod) => pod.agents.filter((agent) => agent.spec === entry.name).map((agent) => ({ rig: rig.name, host: localHost.name, agent: agent.name, runtime: agent.runtime, model: agent.model, status: agent.status })))) : undefined,
      };
      const detail = reviewed.get(entry.id);
      const sourceUnavailable = readErrors.find((error) => error.startsWith(`spec-review(${entry.name}):`)) ?? "源评审不可用";
      if (entry.kind === "rig") {
        if (detail?.kind !== "rig") return { ...base, kind: "rig", sourceUnavailable, agentRefs: allRigRefs.get(entry.name) ?? [] };
        const pods = detail.format === "pod_aware"
          ? (detail.pods ?? []).map((pod) => ({
              ...pod,
              members: pod.members.map((member) => ({
                ...member,
                agentRef: resolveAgentRef(member.agentRef, agentSpecNames),
              })),
            }))
          : undefined;
        return {
          ...base,
          kind: "rig",
          description: authoredDescription(detail.raw),
          sourceState: detail.sourceState,
          format: detail.format,
          agentRefs: allRigRefs.get(entry.name) ?? [],
          ...(pods ? { pods } : {}),
          ...(detail.edges ? { edges: detail.edges } : {}),
          ...(detail.graph ? { graph: detail.graph } : {}),
          ...(detail.raw ? { raw: detail.raw } : {}),
          ...(detail.kind === "rig" && detail.format === "legacy" && detail.nodes ? { legacyNodes: detail.nodes } : {}),
        };
      }
      if (entry.kind === "agent") {
        const usedByRigs = [...allRigRefs.entries()].filter(([, refs]) => refs.includes(entry.name)).map(([rig]) => rig);
        const review = detail?.kind === "agent" ? detail : null;
        const truth = agentSpecTruth(review?.raw);
        const resources = {
          skills: review?.resources?.skills ?? [],
          guidance: review?.resources?.guidance ?? [],
          plugins: review?.resources?.plugins ?? [],
          subagents: review?.resources?.subagents ?? [],
        };
        return {
          ...base,
          kind: "agent",
          ...(!review ? { sourceUnavailable } : {}),
          usedByRigs,
          namespace: agentNamespace(entry.relativePath),
          sourceState: review?.sourceState,
          runtime: truth.runtime,
          ...(review?.description ? { description: review.description } : {}),
          skills: truth.skills.length > 0 ? truth.skills : resources.skills,
          hasGuidance: resources.guidance.length > 0,
          profiles: review?.profiles?.map((profile) => profile.name) ?? [],
          resources,
          ...(review?.startup?.files ? { startupFiles: review.startup.files } : {}),
          ...(review?.raw ? { raw: review.raw } : {}),
        };
      }
      return {
        ...base,
        kind: "workflow",
        ...(entry.rolesCount != null ? { rolesCount: entry.rolesCount } : {}),
        ...(entry.stepsCount != null ? { stepsCount: entry.stepsCount } : {}),
        ...(entry.status ? { workflowStatus: entry.status } : {}),
      };
    }),
  );

  // 需要你：composeNeedsYou 逐字；主机降级在旁。
  const items = review?.needsYou?.items ?? [];
  const needs = items.map(toNeedsItem);
  const hostsDown = [
    ...aggHosts
      .filter((h) => h.status !== "ok")
      .map((h) => ({ hostId: h.hostId, status: h.status, ...(h.error ? { error: h.error } : {}) })),
    ...rigsDown,
  ];
  const execution = (executionRead?.rows?.[0] ?? null) as FleetSnapshot["execution"];

  return {
    connections: connectionsRead,
    controlPlane: instanceHealth,
    slackManifest,
    daemonTarget: (() => { try { const u = new URL(client.baseUrl); return `${u.protocol}//${u.host}${u.pathname}`; } catch { return "未报告"; } })(),
    health: healthProjection
      ? {
          availability: "loaded",
          evaluatedAt: healthProjection.evaluatedAt,
          total: healthProjection.total,
          truncated: healthProjection.truncated,
          records: healthProjection.records,
        }
      : { availability: "unavailable", evaluatedAt: null, total: 0, truncated: false, records: [] },
    hosts: [localHost, ...remoteHosts],
    specs,
    specsLoaded: wantsSpecs && library != null,
    fileRoots: fileRoots?.roots,
    needs,
    humanQueueProbed: review != null && !review.registryError && Array.isArray(review.hosts) && review.hosts.length > 0
      && review.hosts.every((host) => host.status.status === "ok"),
    scopes: (scopesRead?.missions ?? []) as FleetSnapshot["scopes"],
    execution,
    executionMission: executionMission ?? execution?.mission ?? null,
    sliceDetail: sliceDetailRead,
    sliceDetailName: sliceDetailName ?? null,
    ...(recentTransitions && recentTransitionsScope
      ? {
          recentTransitions,
          recentTransitionsScope,
          ...(recentTransitionsScope.kind === "rig" ? { recentTransitionsRig: recentTransitionsScope.rig } : {}),
        }
      : {}),
    attention: (attention ?? []).map(toQueueRead),
    blocked: blockedResolved,
    inProgress: (inProgress ?? []).map(toQueueRead),
    seatActivity,
    pending: (pending ?? []).map(toQueueRead),
    recentlyFinished: (recentlyFinished ?? []).map(toQueueRead),
    hydratedAt: new Date().toISOString(),
    hostsDown,
    stream: (streamItems ?? []).map((s) => ({ tsEmitted: s.tsEmitted, sourceSession: s.sourceSession, body: s.body })),
    readErrors,
  };
}

function authoredDescription(raw?: string): string | undefined {
  try {
    const doc = parseYaml(raw ?? "") as { summary?: unknown; description?: unknown; metadata?: { description?: unknown } } | null;
    // RigSpec summary 优先于遗留撰写描述。
    return [doc?.summary, doc?.description, doc?.metadata?.description]
      .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  } catch { return undefined; }
}
