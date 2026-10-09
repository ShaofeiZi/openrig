import { Command } from "commander";
import { resolveEffectiveHost } from "../host-selection.js";
import { sessionRigOf } from "../session-name.js";
import { DaemonClient, remoteDaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, resolveOriginSelfHostId, type LifecycleDeps , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { loadHostRegistry, resolveHost, hostDisplayTarget, resolveRemoteBearer, classifyHttpFailedStep, classifyHttpError, type HttpHostEntry } from "../host-registry.js";
import { runCrossHostCommand, type RunCrossHostCommandOpts } from "../cross-host-executor.js";
import { emitCrossHostError, emitCrossHostFailure } from "../cross-host-cli-helpers.js";
import { readOpenRigEnv } from "../openrig-compat.js";
import type { AggregatedPayload, PerHostStatus } from "../lib/hosts/fanout-contract.js";

interface PsEntry {
  rigId: string;
  name: string;
  /** L3-followup：`name` 的别名。始终填充且等于 `name`。 */
  rigName?: string;
  nodeCount: number;
  runningCount: number;
  /** Slice 15——静默窗口内产生 tmux 输出的节点子集。
   *  来自后台服务 SeatActivityService；绝不从队列/分派状态推导。 */
  activeCount?: number;
  /** Slice 17——至少有一个 pending/in-progress/blocked qitem 被分派的节点子集。
   *  来自 queue_items；绝不从 tmux 输出推导。 */
  hasWorkCount?: number;
  status: "running" | "partial" | "stopped";
  /** OPR.0.4.4.21——追加：需要关注的席位（生命周期/启动关注、needs_input、
   *  held、启动错误）在后台服务侧折叠。 */
  attentionCount?: number;
  lifecycleState?: "running" | "recoverable" | "stopped" | "degraded" | "attention_required";
  uptime: string | null;
  latestSnapshot: string | null;
  /** OPR.0.3.3.19——归档时的 ISO 时间戳，活动时为 null。仅在后台服务支持归档时出现；为向后兼容可选。 */
  archivedAt?: string | null;
  /** OPR.0.3.3.19——便利标志；当且仅当 rig 已归档时为 true。 */
  isArchived?: boolean;
}

interface NodeEntry {
  rigId: string;
  rigName: string;
  logicalId: string;
  podId: string | null;
  podNamespace?: string | null;
  /** Slice 13 fix 2——被服务后台服务经启动对账后的 self-id，在源处逐行盖章
   *  （后台服务对账前为 null）。区别于 -A fan-out 的 `hostId`，后者是
   *  调用方对其所查询主机的注册表别名。 */
  hostSelfId?: string | null;
  canonicalSessionName: string | null;
  nodeKind: "agent" | "infrastructure";
  runtime: string | null;
  model: string | null;
  sessionStatus: string | null;
  startupStatus: "pending" | "ready" | "attention_required" | "failed" | null;
  restoreOutcome: string;
  // OPR.0.4.3.06——经挑战验证的 orientation，区别于 startupStatus。
  oriented?: string;
  lifecycleState?: "running" | "detached" | "recoverable" | "attention_required";
  tmuxAttachCommand: string | null;
  resumeCommand: string | null;
  latestError: string | null;
  /** Slice 15——`terminal-active` 原语。true=正在产出输出，
   *  false=超过阈值静默，null=无信号。绝不从 hasAssignedWork 推导（非推断契约）。 */
  terminalActive?: boolean | null;
  /** S19——被服务的 taxonomy 状态（由后台服务唯一 bridge 预推导展示）。 */
  activityState?: {
    activity: string;
    display: string;
    needsInput: { count: number; reason: string | null };
    decidedBy: string | null;
  } | null;
  /** Slice 15——`has-work-to-do` 原语。来自 queue_items 推导；
   *  绝不从 terminalActive 推导。 */
  hasAssignedWork?: boolean;
  /** 活动分派总数（pending + in-progress + blocked）。 */
  assignedWorkCount?: number;
  /** Slice 15——本席位的 pending qitem 数（轻量聚合）。 */
  pendingWorkCount?: number;
  inProgressWorkCount?: number;
  blockedWorkCount?: number;
  /** OPR.0.3.4.11——来自 node.held 事件的 held 原因。 */
  heldReason?: string | null;
  agentActivity?: {
    state: "running" | "needs_input" | "idle" | "unknown";
    reason: string;
    evidenceSource: string;
    sampledAt: string;
    evidence: string | null;
  };
  // PL-012：从后台服务 /api/rigs/:id/nodes 路由浮出的 context 用量块
  // （已填充）。可选，因为老后台服务可能不发出。
  contextUsage?: {
    availability: "known" | "unknown";
    usedPercentage: number | null;
    fresh: boolean;
    state?: "critical" | "warning" | "low" | "unknown";
    sampledAt: string | null;
  };
  /** OPR.0.4.0.34——来自后台服务 node-inventory 的恢复摘要。resumeToken
   *  是密钥：紧凑模式只显示是否存在，值仅在 --full 下显示。 */
  resumeType?: string | null;
  resumeToken?: string | null;
  /** OPR.0.4.0.34——启动完成时间戳；无 agentActivity 采样时
   *  紧凑 `lastActivity` 的回退。 */
  startupCompletedAt?: string | null;
  [key: string]: unknown;
}

// L3-followup：人读输出预算，为主机上有真实数量级智能体时的默认终端输出设界。
// `--full` 退出此限制。JSON 输出为向后兼容默认仍不设界（Decision C 混合方案）。
function extractRigName(sessionName: string): string | undefined {
  // OPR.0.4.6.MH1 FR-8：共享解析契约（贪婪的第一个 @ 前的 rig）。
  return sessionRigOf(sessionName);
}

/** 唯一的 active-rig 判定（LEG-7 抽取，fold-wave qitem 79159e6f）：一个 rig 是 active，
 *  除非其生命周期状态恰好为 "stopped"。被裸默认表格投影和 rigsOnHost 作用域计数共享，
 *  让 "1 of N" 标签与展示行永不分歧（LEG-2 QA 标记的"派生标签必须携带活性"那一类问题）。 */
export function isActiveRig(entry: { status?: string | null }): boolean {
  return entry.status !== "stopped";
}

const HUMAN_RIG_BUDGET = 50;
const HUMAN_NODE_BUDGET = 100;

// L3-followup：--filter 只接受这个白名单。未知 key 报错并列出支持列表
// （护栏评审清单：filter 解析器安全）。
//
// PL-019 item 1：用嵌套 key `agentActivity.state` 扩展白名单。
// 这是 v0 支持的唯二嵌套 filter key 之一；解析器显式检查点号形式。裸 `agentActivity`
// 刻意不是 filter key——它是对象不是标量；需要的话用 --fields 投影。
const ALLOWED_FILTER_KEYS = new Set([
  "status",
  "lifecycleState",
  "name-prefix",
  "name",
  "agentActivity.state",
  // PL-012：context 用量过滤器。percent 是数值（>=, >, <=, <, =）；
  // state 是枚举（critical / warning / low / unknown——与
  // computeContextHealthSummary 分层词表锁步）。
  "contextUsage.percent",
  "contextUsage.state",
]);

// PL-019 item 1：当 filter key 是 `agentActivity.state` 时，值按
// AgentActivityState 枚举校验。非法值给出三段式错误
// （哪里错了 / 允许什么 / 该怎么办）。
const ALLOWED_AGENT_ACTIVITY_STATES = new Set(["running", "needs_input", "idle", "unknown"]);

// PL-012：ALLOWED_CONTEXT_USAGE_STATES——必须与后台服务
// computeContextHealthSummary 的紧急词表锁步。
const ALLOWED_CONTEXT_USAGE_STATES = new Set(["critical", "warning", "low", "unknown"]);

const NUMERIC_FILTER_KEYS = new Set(["contextUsage.percent"]);
type NumericComparator = ">=" | ">" | "<=" | "<" | "=";
const NUMERIC_OPERATORS: NumericComparator[] = [">=", "<=", ">", "<", "="];

// C9a：--fields 接受每级一个白名单。未知 key 报错并列出支持列表，
// 镜像 --filter 的拒绝模式。按级区分是因为 rig 与 node 条目 schema 不同
// （接口 PsEntry rig 级 vs NodeEntry node 级）。
//
// 真源：上方 PsEntry / NodeEntry 接口。`name` 只在 rig 级存在；`rigName`
// 是别名，两级都有（据 openrig 0a9fb43 那个闭合的 `rig ps trust and scale-safety` slice）。
const ALLOWED_RIG_FIELDS = new Set([
  "attentionCount",
  "rigId",
  "name",
  "rigName",
  "nodeCount",
  "runningCount",
  "activeCount",
  "hasWorkCount",
  "status",
  "lifecycleState",
  "uptime",
  "latestSnapshot",
]);
const ALLOWED_NODE_FIELDS = new Set([
  "rigId",
  "rigName",
  "logicalId",
  "podId",
  "podNamespace",
  "hostSelfId",
  "canonicalSessionName",
  "nodeKind",
  "runtime",
  "sessionStatus",
  "startupStatus",
  "restoreOutcome",
  "oriented",
  "lifecycleState",
  "tmuxAttachCommand",
  "resumeCommand",
  "latestError",
  "terminalActive",
  "hasAssignedWork",
  "assignedWorkCount",
  "pendingWorkCount",
  "inProgressWorkCount",
  "blockedWorkCount",
  "agentActivity",
  "contextUsage",
  "heldReason",
]);

interface PsCliOptions {
  json?: boolean;
  nodes?: boolean;
  full?: boolean;
  verbose?: boolean;
  limit?: string;
  fields?: string;
  summary?: boolean;
  filter?: string;
  host?: string;
  allHosts?: boolean;
  hosts?: string;
  active?: boolean;
  running?: boolean;
  allRigs?: boolean;
  rig?: string;
  session?: string;
  /** OPR.0.3.3.19——包含已归档 rig（默认排除）。与 `rig stream list --include-archived` 对齐。 */
  includeArchived?: boolean;
}

export interface PsDeps extends StatusDeps {
  /**
   * 跨主机钩子。二者默认都是生产加载器/执行器；测试注入包内 mock，
   * 因此不触碰真实 ssh、真实 ~/.ssh 或真实网络。
   * 镜像闭合的 cross-host-rig-commands slice（cdce3a6）里 SendDeps/CaptureDeps 的形状。
   */
  hostRegistryLoader?: () => ReturnType<typeof loadHostRegistry>;
  crossHostRun?: (
    host: Parameters<typeof runCrossHostCommand>[0],
    argv: readonly string[],
    opts?: RunCrossHostCommandOpts,
  ) => ReturnType<typeof runCrossHostCommand>;
}

interface ParsedFilter {
  key: string;
  value: string;
  /** PL-012：NUMERIC_FILTER_KEYS 中 key 的数值比较符；
   *  其他 key 默认 "="（相等）。 */
  op: NumericComparator;
  /** PL-012：op 为数值比较符时解析出的数值。 */
  numericValue?: number;
}

function parseFilter(filter: string): ParsedFilter | { error: string } {
  // PL-012：预检测数值比较符（>=, <=, >, <, =），让调用方可以写
  // `contextUsage.percent>=80`。顺序重要：先查 >= 和 <= 再查 > 和 <，
  // 让较长前缀胜出。
  let op: NumericComparator = "=";
  let opIdx = -1;
  for (const candidate of NUMERIC_OPERATORS) {
    const i = filter.indexOf(candidate);
    if (i !== -1) {
      // 取最左匹配；并列时取最长比较符。
      if (opIdx === -1 || i < opIdx || (i === opIdx && candidate.length > op.length)) {
        opIdx = i;
        op = candidate;
      }
    }
  }
  if (opIdx === -1) {
    return { error: `--filter 必须是 key<op>value（op = ${NUMERIC_OPERATORS.join(", ")}），实际：'${filter}'` };
  }
  const key = filter.slice(0, opIdx);
  const value = filter.slice(opIdx + op.length);
  if (!ALLOWED_FILTER_KEYS.has(key)) {
    return {
      error: `未知 --filter key '${key}'。支持：${[...ALLOWED_FILTER_KEYS].sort().join(", ")}`,
    };
  }
  if (!value) {
    return { error: `--filter 在 key '${key}' 上的值为空` };
  }

  // PL-012：数值 key 的 filter 校验值能解析成有限数。按既有约定三段式错误。
  if (NUMERIC_FILTER_KEYS.has(key)) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
      return {
        error: `--filter ${key}${op}'${value}' 不是数值。` +
          `允许：一个有限数（例如 ${key}>=80）。` +
          `用 'zrig ps --nodes --fields contextUsage --json' 查看后台服务在报告什么。`,
      };
    }
    return { key, value, op, numericValue };
  }

  // PL-012：contextUsage.state 枚举闸门——形状同 agentActivity.state。
  if (key === "contextUsage.state" && !ALLOWED_CONTEXT_USAGE_STATES.has(value)) {
    return {
      error: `--filter contextUsage.state='${value}' 不是有效的 context 状态。` +
        `允许：${[...ALLOWED_CONTEXT_USAGE_STATES].sort().join(", ")}。` +
        `用 'zrig ps --nodes --fields contextUsage --json' 查看后台服务在报告什么。`,
    };
  }

  // PL-019 item 1：agentActivity.state 是枚举值；提前拒绝非法值，
  // 免得操作者打错字时静默得到空结果。按 `feedback_smart_agents_no_bureaucracy.md`
  // 的三段式：哪里错了 / 允许什么 / 该怎么办。
  if (key === "agentActivity.state" && !ALLOWED_AGENT_ACTIVITY_STATES.has(value)) {
    return {
      error: `--filter agentActivity.state='${value}' 不是有效的活动状态。` +
        `允许：${[...ALLOWED_AGENT_ACTIVITY_STATES].sort().join(", ")}。` +
        `用 'zrig ps --nodes --fields agentActivity --json' 查看后台服务在报告什么。`,
    };
  }

  // 非数值 key 必须用 op = "="。
  if (op !== "=") {
    return {
      error: `--filter ${key}${op}... 在非数值 key 上用了数值比较符。` +
        `允许的数值 key：${[...NUMERIC_FILTER_KEYS].sort().join(", ")}。` +
        `相等比较请用 ${key}=<value>。`,
    };
  }
  return { key, value, op };
}

// PL-012：从数值百分比推导 context 用量分层。与后台服务
// computeContextHealthSummary 的阈值锁步。
function deriveContextUsageState(percent: number | null | undefined): "critical" | "warning" | "low" | "unknown" {
  if (typeof percent !== "number") return "unknown";
  if (percent >= 80) return "critical";
  if (percent >= 60) return "warning";
  return "low";
}

// C9a：按每级白名单校验 --fields。镜像 parseFilter 的形状：报错时给出
// 排序后的支持列表，并把未知 key 加引号。当操作者对 node 查询敲
// `--fields name` 时会触发"按级提示"（rigName/name 别名只在 rig 级保留
// 的那个最常见混淆情形）。
function parseFields(input: string, allowed: Set<string>, level: "rig" | "nodes"): string[] | { error: string } {
  const fields = input.split(",").map((f) => f.trim()).filter((f) => f.length > 0);
  if (fields.length === 0) {
    return { error: `--fields 不能为空` };
  }
  const unknown = fields.filter((f) => !allowed.has(f));
  if (unknown.length > 0) {
    const sorted = [...allowed].sort().join(", ");
    const hint = level === "nodes" && unknown.includes("name")
      ? ` 提示：'name' 是 rig 级字段；node 条目请用 'rigName'。`
      : "";
    const keyWord = unknown.length > 1 ? "keys" : "key";
    return {
      error: `未知 --fields ${keyWord} ${unknown.map((u) => `'${u}'`).join(", ")}。支持：${sorted}。${hint}`,
    };
  }
  return fields;
}

interface ParsedPsControls {
  parsedFilter: ParsedFilter | null;
  limit: number | null;
  fields: string[] | null;
  useEnvelope: boolean;
}

function parsePsControls(opts: PsCliOptions): ParsedPsControls | { error: string } {
  let effectiveFilter = opts.filter;
  if (opts.active) {
    // Slice 15（发现 5）：智能体活动是逐节点信号；本地 rig 汇总层只带一个
    // activeCount 聚合，无法诚实地按它过滤。裸的本地 `rig ps --active`
    // 过去是个看起来像成功的静默空操作——现在大声失败并说明仅节点级作用域。
    // 远程路径（--host/--all-hosts/--hosts）把 --active 转发到远端，
    // 由远端应用（并重新校验），因此不受本地闸门约束。
    const isRemote = !!(opts.host || opts.allHosts || opts.hosts);
    if (!opts.nodes && !isRemote) {
      return {
        error:
          `--active/--running 过滤 agentActivity.state，这是只在节点层可得的逐节点信号。` +
          `加 --nodes（rig 汇总行不带逐节点活动）——未做任何过滤。`,
      };
    }
    if (effectiveFilter) {
      return {
        error:
          `--active 与 --filter 不能同时用。` +
          `--active 等价于 --filter agentActivity.state=running。` +
          `二选一，或直接升级到 --filter 来组合。`,
      };
    }
    effectiveFilter = "agentActivity.state=running";
  }

  let parsedFilter: ParsedFilter | null = null;
  if (effectiveFilter) {
    const result = parseFilter(effectiveFilter);
    if ("error" in result) return result;
    parsedFilter = result;
  }

  const limit = opts.limit !== undefined ? Number(opts.limit) : null;
  if (limit !== null && (!Number.isInteger(limit) || limit < 0)) {
    return { error: `--limit 必须是非负整数，实际 '${opts.limit}'` };
  }

  let fields: string[] | null = null;
  if (opts.fields !== undefined) {
    const fieldsLevel: "rig" | "nodes" = opts.nodes ? "nodes" : "rig";
    const fieldsAllowed = fieldsLevel === "nodes" ? ALLOWED_NODE_FIELDS : ALLOWED_RIG_FIELDS;
    const fieldsResult = parseFields(opts.fields, fieldsAllowed, fieldsLevel);
    if ("error" in fieldsResult) return fieldsResult;
    fields = fieldsResult;
  }

  return {
    parsedFilter,
    limit,
    fields,
    useEnvelope: parsedFilter !== null || limit !== null || fields !== null || opts.summary === true,
  };
}

function applyRigFilter(entries: PsEntry[], filter: ParsedFilter): PsEntry[] {
  return entries.filter((e) => {
    if (filter.key === "status") return e.status === filter.value;
    if (filter.key === "lifecycleState") return e.lifecycleState === filter.value;
    if (filter.key === "name-prefix") return (e.rigName ?? e.name).startsWith(filter.value);
    if (filter.key === "name") return (e.rigName ?? e.name) === filter.value;
    // PL-019 item 1：agentActivity.state 只在节点级；在 rig 级没有意义，
    // 所以过滤器放行一切，用户看到全部 rig（操作者可加 `--nodes` 收窄）。
    if (filter.key === "agentActivity.state") return true;
    // PL-012：contextUsage.* 过滤器只在节点级。
    if (filter.key === "contextUsage.percent" || filter.key === "contextUsage.state") return true;
    return true;
  });
}

function applyNodeFilter(entries: NodeEntry[], filter: ParsedFilter): NodeEntry[] {
  return entries.filter((n) => {
  // status 对节点映射到 sessionStatus；lifecycleState 直接套用。
  if (filter.key === "status") return n.sessionStatus === filter.value;
  if (filter.key === "lifecycleState") return n.lifecycleState === filter.value;
  if (filter.key === "name-prefix") return n.rigName.startsWith(filter.value);
  if (filter.key === "name") return n.rigName === filter.value;
    // PL-019 item 1：agentActivity.state 的嵌套 key 遍历。没有 agentActivity
    // 附着的节点永不匹配非 unknown 的过滤值（后台服务无信号时报 `unknown`——显式）。
  if (filter.key === "agentActivity.state") return n.agentActivity?.state === filter.value;
    // PL-012：contextUsage.percent——数值比较。无采样的节点通不过任何比较符
    // （操作者可用 contextUsage.state=unknown 把它们找出来）。
  if (filter.key === "contextUsage.percent") {
      const pct = n.contextUsage?.usedPercentage;
      if (typeof pct !== "number" || filter.numericValue === undefined) return false;
      switch (filter.op) {
        case ">=": return pct >= filter.numericValue;
        case ">":  return pct >  filter.numericValue;
        case "<=": return pct <= filter.numericValue;
        case "<":  return pct <  filter.numericValue;
        case "=":  return pct === filter.numericValue;
      }
    }
    if (filter.key === "contextUsage.state") {
      const derived = n.contextUsage?.state ?? deriveContextUsageState(n.contextUsage?.usedPercentage ?? null);
      return derived === filter.value;
    }
    return true;
  });
}

// OPR.0.3.3.19——构建 /api/ps 路径，在设了 --include-archived 时把已归档 rig
// 重新纳入。默认（不带标志）保持后台服务排除归档的默认行为。
function fanOutNodesError(): string {
  return [
    "zrig ps --all-hosts/--hosts --nodes：逐节点 fan-out 需要完整的显式阶梯。",
    "  zrig ps --all-hosts --nodes -A             （每主机的 fleet 节点，投影行）",
    "  zrig ps --all-hosts --nodes -A --full      （完整逐节点记录——最后一级）",
    "某主机上某 rig 的席位：zrig ps --host <id> --nodes --rig <name>。",
  ].join("\n");
}

/**
 * OPR.0.4.4.21 FR-2/FR-3——集中的披露阶梯校验器。
 * 在本地/HTTP-host/SSH/fan-out 分派分裂之前运行，让每条路径都遵守同一套语法
 * （qa1 plan-review：远程模式绕过了 session-rig 注入并扇出太宽）。
 * 原则（架构批准）：隐式作用域默认值不跨主机边界——session-rig 默认值在远程主机上
 * 没有稳定指代（那里同名的 rig 会静默错解析），所以远程逐节点视图要么显式要么报错。
 * 返回教学错误文本；调用合法时返回 null。
 */
export function validatePsLadder(opts: PsCliOptions, callerRig: string | undefined): string | null {
  const isFanOut = !!(opts.allHosts || opts.hosts);
  const isSingleRemote = !!opts.host;

  // SWEEP-b（shape f2576102）——`--session` 是 --nodes 过滤器；在 rig 层它过去是
  // 接受即丢弃（静默列出全部 rig）。改为报错并教正确写法。
  if (opts.session !== undefined && !opts.nodes) {
    return [
      "zrig ps --session：'--session' 过滤的是节点，所以需要 --nodes 层。",
      "正确写法：zrig ps --nodes --session <member@rig>（加 --rig/-A 限定作用域）。",
    ].join("\n");
  }

  // FR-3：-A/--all-rigs 只有一个含义——--nodes 的 fleet 加宽器。
  if (opts.allRigs && !opts.nodes) {
    return [
      "zrig ps -A：'-A/--all-rigs' 现在只有一个含义——--nodes 的 fleet 加宽器。",
      "合并后的全 rig 视图就是默认：直接运行 'zrig ps'。",
      "fleet 节点：zrig ps --nodes -A（加 --full 看完整逐节点记录）。",
      "归档历史：zrig ps --include-archived。",
    ].join("\n");
  }

  // FR-5：多主机 fan-out 只做汇总，除非请求完整显式阶梯——
  // 每主机 `--nodes -A`（`--full` 看完整记录），正如 PRD 所写。--nodes 下
  // 任何不够显式的写法都报错；绝不在 --nodes 标志下静默给 rig 层数据。
  if (opts.nodes && isFanOut && !opts.allRigs) {
    return fanOutNodesError();
  }

  // FR-2：--nodes 总是点名其作用域——本地用 session 默认，其他地方显式 --rig / -A。
  // 绝不隐式 fan-out。
  if (opts.nodes && !opts.rig && !opts.allRigs) {
    if (isFanOut) {
      return fanOutNodesError();
    }
    if (isSingleRemote) {
      return [
        `zrig ps --host ${opts.host} --nodes：没有目标——本地会话的 rig 不是远程作用域`,
        "（隐式作用域默认值不跨主机边界；远程同名 rig 会静默错解析）。",
        `指定一个：zrig ps --host ${opts.host} --nodes --rig <name>，或显式列该主机 fleet：zrig ps --host ${opts.host} --nodes -A。`,
      ].join("\n");
    }
    if (!callerRig) {
      return [
        "zrig ps --nodes：没有目标——在受管会话之外，没有可默认的当前 rig。",
        "指定一个：zrig ps --nodes --rig <name>，或显式全 fleet：zrig ps --nodes -A。",
      ].join("\n");
    }
  }

  return null;
}

function psApiPath(opts: PsCliOptions): string {
  return opts.includeArchived ? "/api/ps?includeArchived=true" : "/api/ps";
}

function selectFields<T extends Record<string, unknown>>(entries: T[], fields: string[]): Array<Record<string, unknown>> {
  return entries.map((e) => {
    const out: Record<string, unknown> = {};
    for (const f of fields) out[f] = e[f];
    return out;
  });
}

function selectFanOutFields(entries: Array<Record<string, unknown>>, fields: string[]): Array<Record<string, unknown>> {
  return entries.map((e) => {
    const [selected] = selectFields([e], fields);
    return { ...selected, hostId: e.hostId };
  });
}

function needsAttention(node: NodeEntry): boolean {
  return node.lifecycleState === "attention_required"
    || node.startupStatus === "attention_required"
    || node.startupStatus === "failed"
    || node.agentActivity?.state === "needs_input";
}

// OPR.0.4.0.34——紧凑的 orch 字段集（PRD FR-4）。携带编排者一眼所需的、
// 来源可用的身份 + 状态 + 恢复摘要字段，但绝不泄漏 resume token 值或 resumeCommand
// （安全）。recoveryGuidance/currentUsage 留在节点详情（slice 26）。

// 0.5.1 rig ps 遥测（创始人指定）：渲染声明的 model。
//
// 这里留空绝不能并入其他空单元格所用的 em-dash 家族。15 个 claude-code 席位里有
// 13 个不带声明 model，读者看到 "—" 会合理地以为该席位没有 model，而不是没有声明。
// "not-declared" 是对"未声明"的诚实措辞。
//
// 作用域在此声明，因为这一列容易被读得更宽：这是 SPEC 声明的 model（nodes.model），
// 不是席位正在跑的 model。正在跑的 model 今天没有生产者——它是 ACTIVITY 伞下的附带项。
export function formatDeclaredModel(model: string | null | undefined): string {
  const m = (model ?? "").trim();
  return m.length > 0 ? m : "not-declared";
}

export function compactNodeProjection(nodes: NodeEntry[]): Array<Record<string, unknown>> {
  return nodes.map((n) => {
    const attention = needsAttention(n);
    const compact: Record<string, unknown> = {
      // 身份（rigId/rigName + logicalId + session）——在 -A 下消除歧义。
      rigId: n.rigId,
      rigName: n.rigName,
      logicalId: n.logicalId,
      canonicalSessionName: n.canonicalSessionName,
      // Slice 13 fix 2——主机归属也随紧凑投影带出；投影名单必须可归属，
      // 否则部分读取会被当成权威全貌。
      hostSelfId: n.hostSelfId ?? null,
      // 0.5.1 创始人指定遥测：runtime + 声明的 model。
      // node-inventory 两者都带；这个投影过去把它们丢了，所以编排者无法区分
      // 限流的席位和卡住的席位。runtime 全 fleet 完整；model 是一项声明，
      // 15 个 claude-code 席位里 13 个缺失——渲染规则见 formatDeclaredModel。
      runtime: n.runtime ?? null,
      model: n.model ?? null,
      // 生命周期 + 会话/启动状态。
      sessionStatus: n.sessionStatus,
      startupStatus: n.startupStatus,
      // OPR.0.4.3.06——经挑战验证的 orientation，区别于 ready。
      oriented: n.oriented ?? "n-a",
      lifecycleState: n.lifecycleState,
      // 活动（状态总有；仅在需要关注时带简短 reason——保持精简）。
      agentActivity: attention
        ? { state: n.agentActivity?.state ?? "unknown", reason: n.agentActivity?.reason }
        : { state: n.agentActivity?.state ?? "unknown" },
      // 工作量计数。紧凑模式保留基础的 pending-only 键，加上诚实渲染所需的活动总数；
      // 精确的各状态兄弟键仍在 --full 和显式 --fields 上。
      hasAssignedWork: n.hasAssignedWork,
      assignedWorkCount: n.assignedWorkCount,
      pendingWorkCount: n.pendingWorkCount,
      // 恢复摘要——仅类型 + 是否存在的布尔（绝不给 token 值）。
      resumeType: n.resumeType ?? null,
      resumeTokenPresent: Boolean(n.resumeToken),
      // 更新时间/年龄代理。节点列表不发专门的 `updatedAt`；最新信号是
      // agentActivity.sampledAt，其次 startupCompletedAt，否则 null
      // （文档化的 FR-4 回退——不是编造的时间戳）。
      lastActivity: n.agentActivity?.sampledAt ?? n.startupCompletedAt ?? null,
    };
    // held/关注原因（简短）存在时带上。
    if (n.heldReason) compact.heldReason = n.heldReason;
    if (attention && n.latestError) {
      compact.latestError = n.latestError;
    }
    return compact;
  });
}

function summarizeRigs(entries: PsEntry[]): {
  totalRigs: number;
  totalRunning: number;
  byLifecycle: Record<string, number>;
  byStatus: Record<string, number>;
} {
  const byLifecycle: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let totalRunning = 0;
  for (const e of entries) {
    const ls = e.lifecycleState ?? "unknown";
    byLifecycle[ls] = (byLifecycle[ls] ?? 0) + 1;
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    if (e.status === "running") totalRunning++;
  }
  return { totalRigs: entries.length, totalRunning, byLifecycle, byStatus };
}

function summarizeNodes(entries: NodeEntry[]): {
  totalNodes: number;
  byLifecycle: Record<string, number>;
  bySessionStatus: Record<string, number>;
} {
  const byLifecycle: Record<string, number> = {};
  const bySessionStatus: Record<string, number> = {};
  for (const n of entries) {
    const ls = n.lifecycleState ?? "unknown";
    byLifecycle[ls] = (byLifecycle[ls] ?? 0) + 1;
    const ss = n.sessionStatus ?? "unknown";
    bySessionStatus[ss] = (bySessionStatus[ss] ?? 0) + 1;
  }
  return { totalNodes: entries.length, byLifecycle, bySessionStatus };
}

// rig 表头用的紧凑 rig 级生命周期码（3 字符定宽）。
function abbrevRigLifecycle(state: PsEntry["lifecycleState"] | undefined): string {
  if (!state) return "—";
  if (state === "running") return "run";
  if (state === "recoverable") return "rec";
  if (state === "stopped") return "stp";
  if (state === "degraded") return "deg";
  if (state === "attention_required") return "att";
  return "—";
}

// 节点表用的紧凑逐节点生命周期码。
function abbrevNodeLifecycle(state: NodeEntry["lifecycleState"] | undefined): string {
  if (!state) return "—";
  if (state === "running") return "run";
  if (state === "recoverable") return "rec";
  if (state === "detached") return "det";
  if (state === "attention_required") return "att";
  return "—";
}

/**
 * `rig ps`——合并的 fleet 地图 + 显式披露阶梯。
 *
 * OPR.0.4.4.21：默认是所有 active rig，每个一行紧凑 O(rigs)
 * （只看当前 rig 的旧默认已退役）。token 安全不变量：除非显式加标志
 * （--nodes -A），任何调用都不返回跨所有 rig 的逐节点明细；即便那样，
 * 行也是投影过的，除非 --full。默认 `rig ps --json` 为向后兼容保持裸数组形状；
 * 截断/envelope 形状只在指定了 `--limit`/`--summary`/`--fields`/`--filter`
 * 至少其一时才出现。
 */
export function psCommand(depsOverride?: PsDeps): Command {
  const cmd = new Command("ps")
    .description("列出 rig 及其状态")
    .addHelpText("after", `
默认（OPR.0.4.4.21）：所有 active rig，每个一行紧凑——O(rigs)，绝不做 fleet 节点 fan-out——
外加主机汇总行（"N rigs · M seats · K need attention"）、归档/停止计数行，以及下钻阶梯页脚。
明示契约：默认 --json 是所有未归档 rig 的裸数组，含已停止的（保留既有键；追加 attentionCount）；
只有人读表格把停止的 rig 折进计数行。

披露阶梯（每一档更重的视图都是显式一步）：
  zrig ps                      合并地图（本默认）
  zrig ps --rig <name>         一个 rig 的明细
  zrig ps --nodes              逐节点，当前 rig（会话默认，仅本地）
  zrig ps --nodes --rig <name> 逐节点，指定 rig
  zrig ps --nodes -A           fleet 节点，投影行
  zrig ps --nodes -A --full    完整逐节点记录（唯一的全 fan-out）

-A/--all-rigs 只有一个含义：--nodes 的 fleet 加宽器。裸 -A 报错
（全 rig 就是默认；归档历史在 --include-archived 之后）。会话 rig 默认绝不跨主机边界：
远程 --nodes 需要显式 --rig 或 -A。

紧凑默认：'zrig ps --nodes' 每节点显示紧凑摘要
（rig、会话、生命周期、活动状态、关注时的原因、队列计数、恢复类型 + 是否存在指示）。
resume token 值与 resumeCommand 不进紧凑输出（安全）；用 --full 查看。

用 '--full'（或 '--verbose'）看未压缩的逐节点负载（contextUsage 标量、恢复命令/token、智能体引用）。
注意（OPR.0.4.0.26）：即便 --full，节点列表负载也带 recoveryGuidance: null 与
contextUsage.currentUsage: null；完整恢复指导 + currentUsage 请到单节点详情
（/api/rigs/:rigId/nodes/:logicalId）或 'rig whoami' 取。

示例：
  zrig ps                                          所有 active rig，每行一个 + 汇总
  zrig ps --rig <name>                             一个 rig 的明细
  zrig ps --full                                   所有 rig，不做表格截断
  zrig ps --json                                   所有未归档 rig，裸 JSON 数组
  zrig ps --json --limit 20                        有界 JSON envelope
  zrig ps --json --summary                         仅聚合的 JSON
  zrig ps --json --fields rigName,status,lifecycleState
                                                  把 JSON 投影到指定字段
  zrig ps --filter lifecycleState=attention_required
                                                  只看需要关注的 rig
  zrig ps --filter status=running                  只看 running rig
  zrig ps --filter name-prefix=demo                按 rig 名前缀过滤
  zrig ps --nodes                                  当前 rig 逐节点紧凑摘要
  zrig ps --nodes -A                               所有 rig 逐节点紧凑摘要
  zrig ps --nodes --json                           当前 rig 逐节点紧凑 JSON
  zrig ps --nodes --json --full                    完整逐节点 LIST 负载（guidance/currentUsage 已迁到节点详情）
  zrig ps --nodes --json --rig openrig-build      指定 rig 的紧凑节点
  zrig ps --nodes --json --session dev1-impl@myrig 过滤到单个会话（在当前 rig 内；跨 rig 用 -A）
  zrig ps --nodes --json --limit 50                有界逐节点 JSON envelope
  zrig ps --nodes --active                         只看 agentActivity.state=running 的节点
  zrig ps --nodes --running                        同 --active
  zrig ps --nodes --filter agentActivity.state=running
                                                  同 --active（显式写法）
  zrig ps --host vm-1 --nodes --rig <name> --json  远程主机逐节点（需显式目标）
  zrig ps --all-hosts                              逐主机 O(rigs) 汇总（AggregatedPayload JSON）
  zrig ps --include-archived                       包含已归档 rig（标 *）；默认隐藏

--rig <name> 限定到一个 rig。-A/--all-rigs 只是 --nodes 的 fleet 加宽器。
--session <name> 在有效 rig 作用域内过滤；若目标会话在别的 rig，用 --nodes -A。
多主机 fan-out（--all-hosts/--hosts）默认只做汇总；完整显式阶梯
（--all-hosts --nodes -A，--full 看完整记录）才逐节点 fan-out，并给投影行盖 hostId。

--active/--running 收窄到 agentActivity.state=running。仅节点级：需要 --nodes
（rig 汇总行不带逐节点活动）。不能与 --filter 同用。

--filter 接受：status, lifecycleState, name-prefix, name, agentActivity.state,
contextUsage.percent, contextUsage.state。其他 key 被拒绝。

--fields 接受（rig 级）：rigId, name, rigName, nodeCount, runningCount,
activeCount, hasWorkCount, attentionCount, status, lifecycleState, uptime,
latestSnapshot。
--fields 接受（节点级，配合 --nodes）：rigId, rigName, logicalId, podId,
podNamespace, canonicalSessionName, nodeKind, runtime, sessionStatus,
startupStatus, restoreOutcome, lifecycleState, tmuxAttachCommand,
resumeCommand, latestError, terminalActive, hasAssignedWork,
assignedWorkCount, pendingWorkCount, inProgressWorkCount, blockedWorkCount,
agentActivity, contextUsage, heldReason。

--host 在 ~/.openrig/hosts.yaml 里声明的远程主机上运行（不套当前 rig 默认；
显示该远程主机的 rig）。

退出码：
  0  成功
  1  后台服务未运行，或 --filter / --limit / --fields 非法
  2  从后台服务取数失败`);
  const getDepsF = (): PsDeps => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .option("--json", "供智能体使用的 JSON 输出")
    .option("--nodes", "显示逐节点明细（当前 rig；-A 看所有 rig）")
    .option("--full", "每节点显示全部 node-list 字段（未压缩行；node-list 的 recoveryGuidance/currentUsage 在节点详情而非列表上）")
    .option("--verbose", "--full 的别名")
    .option("--limit <n>", "限制条目数（rig 或节点）")
    .option("--fields <list>", "逗号分隔的字段列表做投影（仅 JSON）")
    .option("--summary", "只输出聚合（按 status/lifecycle 的计数）")
    .option("--filter <key=value>", "过滤条目；支持 key：status, lifecycleState, name-prefix, name, agentActivity.state")
    .option("--active", "--filter agentActivity.state=running 的快捷方式（PL-019）")
    .option("--running", "--active 的别名")
    .option("-A, --all-rigs", "显示所有 rig（默认仅当前 rig）")
    .option("--rig <name>", "只显示属于指定 rig 的节点")
    .option("--session <name>", "只显示匹配此规范会话名的节点")
    .option("--include-archived", "包含已归档 rig（默认隐藏）；与 'rig stream list --include-archived' 对齐")
    .option("--host <id>", "在 ~/.openrig/hosts.yaml 里声明的远程主机上运行")
    .option("--all-hosts", "扇出到所有已登记 HTTP 主机（仅观察）")
    .option("--hosts <ids>", "扇出到指定主机（逗号分隔）")
    .action(async (opts: PsCliOptions) => {
      // OPR.0.4.6.MH1 FR-2：所选主机路由——显式 --host 优先；
      // 否则持久化的选择喂给交付的 --host 路径；无选择 = 今天的行为完全一致。
      // fan-out 标志是它自己的显式作用域——绝不与选择混用。
      if (!opts.allHosts && !opts.hosts) opts.host = resolveEffectiveHost(opts.host);
      if (opts.verbose) opts.full = true;
      if (opts.running) opts.active = true;
      const isRemote = !!(opts.host || opts.allHosts || opts.hosts);
      // OPR.0.4.4.21 FR-1：rig 层默认是合并的全 active rig（只看当前 rig 的
      // 旧默认已退役——它把 running rig 藏在操作者视野之外）。会话 rig 默认现在
      // 只应用于节点层（FR-2 的作用域 --nodes），且只在本地（阶梯校验器在每条
      // 远程路径上强制显式或报错）。
      const sessionName = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
      const callerRig = sessionName ? extractRigName(sessionName) : undefined;
      const ladderError = validatePsLadder(opts, callerRig);
      if (ladderError) {
        console.error(ladderError);
        process.exitCode = 1;
        return;
      }
      // OPR.0.5.0 作用域诚实：捕获 --nodes 何时回退到会话 rig，从而在输出中
      // 声明（正确的）仅当前 rig 作用域——静默的完整性就是静默的丢失
      // （正在恢复的智能体不得把一个收窄的列表当成整台主机）。
      let scopedToSessionRig = false;
      if (opts.nodes && !opts.allRigs && !opts.rig && !isRemote && callerRig) {
        opts.rig = callerRig;
        scopedToSessionRig = true;
      }
      const deps = getDepsF();

      // OPR.0.4.4.21 rev1-r2 回补：共享的塑形控制
      // （--active/--filter/--limit/--fields/--summary）在任何分派之前
      // （本地、单主机或 fan-out）就解析 + 校验，让每条路径遵守同一套组合契约，
      // 远程路径上的拒绝也保持在 HTTP 之前。
      // 一次性前置解析共享组合控制，让本地、单主机和 fan-out 路径都在任何 HTTP 调用
      // 之前拒绝畸形的 --filter/--limit/--fields，并套用相同的塑形语义。
      const controls = parsePsControls(opts);
      if ("error" in controls) {
        console.error(controls.error);
        process.exitCode = 1;
        return;
      }
      const { parsedFilter, limit, fields, useEnvelope } = controls;

      if (opts.allHosts || opts.hosts) {
        // AggregatedPayload 是闭合的 fan-out 契约（items + hosts）。
        // 不要在这里加临时的 summary 成员；请教逐主机写法。
        if (opts.summary) {
          console.error(
            "zrig ps --all-hosts/--hosts --summary：summary 不能与合并后的 fan-out 负载组合。\n" +
            "汇总某一台主机：zrig ps --host <id> --summary；或去掉 --summary 看合并的 AggregatedPayload。",
          );
          process.exitCode = 1;
          return;
        }
        await runFanOutPs(opts, deps, { parsedFilter, limit, fields });
        return;
      }

      if (opts.host) {
        await runCrossHostPs(opts.host, opts, deps);
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));

      if (opts.nodes) {
        await handleNodes(client, opts, parsedFilter, limit, fields, useEnvelope, undefined, scopedToSessionRig);
        return;
      }

      // OPR.0.4.4.21 FR-1：一次 O(rigs) 抓取，含归档，以便算出计数行；
      // 可见性在下面客户端侧拆分（JSON 保持今天排除归档的默认——对齐）。
      const res = await client.get<PsEntry[]>("/api/ps?includeArchived=true");

      if (res.status >= 400) {
        console.error(`从后台服务取 rig 列表失败（HTTP ${res.status}）。用它查看后台服务状态：zrig status`);
        process.exitCode = 2;
        return;
      }

      const all = res.data;

      // OPR.0.4.4.21——归档可见性对齐：上面的后台服务调用总是含归档（为了计数行）；
      // 不带 --include-archived 时它们从这里的两种渲染中都被丢弃，正如后台服务默认过去做的。
      // archivedCount 只喂给 FR-1 计数行。
      const archivedCount = all.filter((e) => e.isArchived === true).length;
      const visible = opts.includeArchived ? all : all.filter((e) => e.isArchived !== true);

      const rigScoped = opts.rig
        ? visible.filter((e) => (e.rigName ?? e.name) === opts.rig)
        : visible;

      // 应用 CLI 侧过滤（Amendment A：优先 CLI 塑形）。
      const filtered = parsedFilter ? applyRigFilter(rigScoped, parsedFilter) : rigScoped;

      // summary 模式短路逐条目输出。
      if (opts.summary) {
        const summary = summarizeRigs(filtered);
        if (opts.json) {
          console.log(JSON.stringify(summary));
        } else {
          console.log(`rig 总数：${summary.totalRigs}`);
          console.log(`running 总数：${summary.totalRunning}`);
          console.log(`按状态：${JSON.stringify(summary.byStatus)}`);
          console.log(`按生命周期：${JSON.stringify(summary.byLifecycle)}`);
        }
        return;
      }

      // 在过滤之上再套 --limit（CLI 侧；后台服务保持裸数组）。
      const limited = limit !== null ? filtered.slice(0, limit) : filtered;
      const truncated = limit !== null && filtered.length > limit;

      // 字段投影最后跑，让所请求字段作用于受限后的集合。
      const projected = fields ? selectFields(limited as unknown as Array<Record<string, unknown>>, fields) : limited;

      if (opts.json) {
        if (useEnvelope) {
          // 只在用标志时才 envelope；默认 JSON 为兼容保持裸数组。
          const envelope: Record<string, unknown> = {
            entries: projected,
            totalRigs: filtered.length,
            truncated,
          };
          if (truncated) envelope.hint = "zrig ps --full --json";
          console.log(JSON.stringify(envelope));
        } else {
          console.log(JSON.stringify(projected));
        }
        return;
      }

      if (limited.length === 0) {
        if (parsedFilter) {
          console.log(`没有 rig 匹配 --filter ${parsedFilter.key}=${parsedFilter.value}`);
        } else if (archivedCount > 0 && !opts.includeArchived) {
          // 确实为空时给历史指针；只要还有归档历史，就绝不只输出裸的 "No rigs"。
          console.log(`没有 active rig · ${archivedCount} 个已归档（zrig ps --include-archived）`);
        } else {
          console.log("没有 rig");
        }
        return;
      }

      // OPR.0.4.4.21 FR-1（仅人读表格——JSON 保留所有未归档条目含已停止；
      // 这个作用域切分是帮助文本里一句明示契约）：在裸默认下
      // （无 filter、无 --rig、无 --include-archived），已停止 rig 折进计数行——
      // 默认丢弃的是历史，不是视野。
      const bareDefault = !parsedFilter && !opts.rig && !opts.includeArchived;
      const tableRows = bareDefault ? limited.filter(isActiveRig) : limited;
      const stoppedCount = bareDefault ? limited.length - tableRows.length : 0;

      // FR-1 展示元素 1：主机汇总行。
      const rollupSeats = tableRows.reduce((n, e) => n + e.nodeCount, 0);
      const rollupAttention = tableRows.reduce((n, e) => n + (e.attentionCount ?? 0), 0);
      console.log(`${tableRows.length} 个rig · ${rollupSeats} 个席位 · ${rollupAttention} 需关注`);

      // 人读输出：除非 --full，套用默认截断预算。
      const humanList = (opts.full || limit !== null) ? tableRows : tableRows.slice(0, HUMAN_RIG_BUDGET);
      const humanTruncated = !opts.full && limit === null && tableRows.length > HUMAN_RIG_BUDGET;

      const header = padRigRow("RIG", "NODES", "RUNNING", "ACTIVE", "WORK", "ATTN", "STATUS", "LIFECYCLE", "UPTIME", "SNAPSHOT");
      console.log(header);
      let anyArchivedShown = false;
      for (const e of humanList as PsEntry[]) {
        // OPR.0.3.3.19——已归档 rig 只在 --include-archived 下出现；用尾随 "*"
        // 标记（图例页脚见下），让操作者一眼区分归档与活动。
        if (e.isArchived) anyArchivedShown = true;
        console.log(padRigRow(
          e.isArchived ? `${e.rigName ?? e.name} *` : (e.rigName ?? e.name),
          String(e.nodeCount),
          String(e.runningCount),
          // Slice 15——后台服务早于该字段时 "—"；诚实地缺失。
          e.activeCount !== undefined ? String(e.activeCount) : "—",
          e.hasWorkCount !== undefined ? String(e.hasWorkCount) : "—",
          // OPR.0.4.4.21——创始人的视野锚点：可能让我担心的东西在哪。
          // "—" = 后台服务早于该字段。
          e.attentionCount !== undefined ? (e.attentionCount > 0 ? `▲${e.attentionCount}` : "0") : "—",
          e.status,
          abbrevRigLifecycle(e.lifecycleState),
          e.uptime ?? "—",
          e.latestSnapshot ?? "—",
        ));
      }
      if (anyArchivedShown) {
        console.log("* = 已归档（默认视图隐藏；经 --include-archived 显示）。反向操作：zrig unarchive <rig>");
      }
      // FR-1 展示元素 2：历史作为一行计数，绝不成行。
      if (stoppedCount > 0 || (!opts.includeArchived && archivedCount > 0)) {
        const parts: string[] = [];
        if (stoppedCount > 0) parts.push(`${stoppedCount} 个已停止（zrig ps --filter status=stopped）`);
        if (!opts.includeArchived && archivedCount > 0) parts.push(`${archivedCount} 个已归档（zrig ps --include-archived）`);
        console.log(`未显示：${parts.join(" · ")}`);
      }
      // FR-1 展示元素 3： affordance 页脚——下钻阶梯。
      if (bareDefault) {
        console.log("下钻：zrig ps --rig <name>（一个 rig）· zrig ps --nodes --rig <name>（它的席位）· --full（全部）");
      }
      if (humanTruncated) {
        const remaining = filtered.length - HUMAN_RIG_BUDGET;
        console.log(`…还有 ${remaining} 个 rig（截断于 ${HUMAN_RIG_BUDGET}）。`);
        console.log("运行 'zrig ps --full' 看全部，或 'zrig ps --filter lifecycleState=attention_required' 收窄。");
      } else if (truncated) {
        const remaining = filtered.length - (limit ?? 0);
        console.log(`…还有 ${remaining} 个 rig（--limit ${limit}）。`);
      }
    });

  return cmd;
}

async function handleNodes(
  client: DaemonClient,
  opts: PsCliOptions,
  parsedFilter: ParsedFilter | null,
  limit: number | null,
  fields: string[] | null,
  useEnvelope: boolean,
  requestHeaders?: Record<string, string>,
  scopedToSessionRig?: boolean,
): Promise<void> {
  const rigRes = await client.get<PsEntry[]>(psApiPath(opts), requestHeaders ? { headers: requestHeaders } : undefined);
  if (rigRes.status >= 400) {
    console.error(`从后台服务取 rig 列表失败（HTTP ${rigRes.status}）。用它查看后台服务状态：zrig status`);
    process.exitCode = 2;
    return;
  }

  const effectiveRigs = opts.rig
    ? rigRes.data.filter((r) => (r.rigName ?? r.name) === opts.rig)
    : rigRes.data;

  // OPR.0.4.3 healthz-wedge：后台服务 nodes 路由默认很便宜（无逐节点 tmux 抓取）——
  // `rig ps --nodes` 拿到基于快照的活动。只有操作者要 --full 时才传 ?full=true，
  // 即选择逐节点 pane 启发式（最新 needs_input），代价是 fan-out 的开销。
  const nodesQuery = opts.full ? "?full=true" : "";
  const allNodes: NodeEntry[] = [];
  for (const rig of effectiveRigs) {
    const nodesRes = await client.get<NodeEntry[]>(`/api/rigs/${encodeURIComponent(rig.rigId)}/nodes${nodesQuery}`, requestHeaders ? { headers: requestHeaders } : undefined);
    if (nodesRes.status >= 400) {
      console.error(`警告：取 rig "${rig.rigName ?? rig.name}" 的节点失败（HTTP ${nodesRes.status}）。列 rig：zrig ps`);
      continue;
    }
    const parentRigName = rig.rigName ?? rig.name;
    allNodes.push(...nodesRes.data.map((n) => ({
      ...n,
      rigId: n.rigId ?? rig.rigId,
      rigName: n.rigName ?? parentRigName,
    })));
  }

  let narrowed = allNodes;
  if (opts.rig) narrowed = narrowed.filter((n) => n.rigName === opts.rig);
  if (opts.session) narrowed = narrowed.filter((n) => n.canonicalSessionName === opts.session);

  const filtered = parsedFilter ? applyNodeFilter(narrowed, parsedFilter) : narrowed;

  if (opts.summary) {
    const summary = summarizeNodes(filtered);
    if (opts.json) {
      console.log(JSON.stringify(summary));
    } else {
      console.log(`节点总数：${summary.totalNodes}`);
      console.log(`按会话状态：${JSON.stringify(summary.bySessionStatus)}`);
      console.log(`按生命周期：${JSON.stringify(summary.byLifecycle)}`);
    }
    return;
  }

  const limited = limit !== null ? filtered.slice(0, limit) : filtered;
  const limitTruncated = limit !== null && filtered.length > limit;
  const useCompact = !opts.full && !fields;
  const projected = fields
    ? selectFields(limited as unknown as Array<Record<string, unknown>>, fields)
    : useCompact
      ? compactNodeProjection(limited)
      : limited;

  // OPR.0.5.0 作用域诚实：当 --nodes 回退到会话 rig 且主机上还有其他 rig 时，
  // 声明作用域，免得一个收窄的列表被当成整台主机。单 rig 主机和显式 --rig/-A 路径
  // 保持逐字节稳定（无隐藏 → 无作用域 envelope、无 stderr 提示）。
  // 计数必须与提示所引用的表面一致：`rig ps` 裸默认表头渲染的是
  // active rig 投影——已停止 rig 折进计数行，不是视野（~L942 的 FR-1 契约）。
  // 所以 rigsOnHost 数的是同一组 active 集合；若把每个未归档条目（含已停止）都算上，
  // 会让 "1 of N" 与操作者照提示看到的不一致（派生标签必须携带活性 / 宽度截断诚实那一类）。
  const rigsOnHost = rigRes.data.filter(isActiveRig).length;
  const scope = scopedToSessionRig && rigsOnHost > 1
    ? { rig: opts.rig as string, rigsOnHost, hint: `仅显示 ${rigsOnHost} 个工作组中的 1 个；zrig ps 可列出全部，使用 --rig NAME 或 -A 查看其他工作组` }
    : null;

  if (opts.json) {
    if (useEnvelope || scope) {
      const envelope: Record<string, unknown> = {
        entries: projected,
        totalNodes: filtered.length,
        truncated: limitTruncated,
      };
      if (limitTruncated) envelope.hint = "zrig ps --nodes --full --json";
      if (scope) envelope.scope = scope;
      console.log(JSON.stringify(envelope));
    } else {
      console.log(JSON.stringify(projected));
    }
    return;
  }

  // 对应的人读路径行（走 stderr，绝不污染管道里的 stdout）。
  if (scope) {
    console.error(`仅显示 ${rigsOnHost} 个rig中的 1 个（作用域限定在 ${opts.rig}）；zrig ps 列出全部——其他 rig 用 --rig NAME 或 -A`);
  }

  if (limited.length === 0) {
    if (parsedFilter) {
      console.log(`没有节点匹配 --filter ${parsedFilter.key}=${parsedFilter.value}`);
    } else {
      console.log("没有节点");
    }
    return;
  }

  const humanList = (opts.full || limit !== null) ? limited : limited.slice(0, HUMAN_NODE_BUDGET);
  const humanTruncated = !opts.full && limit === null && filtered.length > HUMAN_NODE_BUDGET;

  if (useCompact) {
    console.log(padCompactNodeRow("RIG", "SESSION", "LIFECYCLE", "ACTIVITY", "WORK", "REASON"));
    for (const n of humanList as NodeEntry[]) {
      const attn = needsAttention(n);
      const reason = attn
        ? (n.latestError ? truncate(n.latestError, 40) : n.agentActivity?.reason ?? "—")
        : "—";
      console.log(padCompactNodeRow(
        n.rigName,
        n.canonicalSessionName ?? "—",
        abbrevNodeLifecycle(n.lifecycleState),
        formatActivity(n),
        formatHasWork(n.hasAssignedWork, n.assignedWorkCount ?? n.pendingWorkCount),
        reason,
      ));
    }
  } else {
    const header = padNodeRow("RIG", "POD", "MEMBER", "SESSION", "RUNTIME", "MODEL(DECLARED)", "STATUS", "STARTUP", "ORIENTED", "LIFECYCLE", "TERMINAL", "WORK", "ACTIVITY", "CTX", "RESTORE", "ERROR");
    console.log(header);
    for (const n of humanList as NodeEntry[]) {
      const parts = n.logicalId.split(".");
      const pod = n.podNamespace ?? (parts.length > 1 ? parts[0]! : "—");
      const member = parts.length > 1 ? parts.slice(1).join(".") : n.logicalId;
      const rig = `${n.rigName}#${n.rigId}`;
      console.log(padNodeRow(
        rig,
        pod,
        member,
        n.canonicalSessionName ?? "—",
        n.runtime ?? "—",
        formatDeclaredModel(n.model),
        n.sessionStatus ?? "—",
        n.startupStatus ?? "—",
        n.oriented ?? "—",
        abbrevNodeLifecycle(n.lifecycleState),
        formatTerminalActive(n.terminalActive),
        formatHasWork(n.hasAssignedWork, n.assignedWorkCount ?? n.pendingWorkCount),
        formatActivity(n),
        formatContextUsage(n.contextUsage),
        n.restoreOutcome,
        n.latestError ? truncate(n.latestError, 30) : n.heldReason ? `held: ${truncate(n.heldReason, 25)}` : "—",
      ));
    }
  }
  if (humanTruncated) {
    const remaining = filtered.length - HUMAN_NODE_BUDGET;
    console.log(`…还有 ${remaining} 个节点（截断于 ${HUMAN_NODE_BUDGET}）。`);
    console.log("运行 'zrig ps --nodes --full' 看全部，或 '--filter lifecycleState=attention_required' 收窄。");
  } else if (limitTruncated) {
    const remaining = filtered.length - (limit ?? 0);
    console.log(`…还有 ${remaining} 个节点（--limit ${limit}）。`);
  }
}

function formatActivity(n: Pick<NodeEntry, "agentActivity" | "activityState">): string {
  // S19——有被服务的 taxonomy 状态时从它渲染：needs-input 显示成 count(+reason)，
  // 否则用 bridge 的 display 值。不做本地仲裁。
  const tax = n.activityState;
  if (tax) {
    if (tax.needsInput.count > 0) return `需要输入 ×${tax.needsInput.count}`;
    return tax.display;
  }
  // 遗留回退（没有 S19 富化的后台服务）——按"阶梯即迁移"规则随前 taxonomy 表面一起退役。
  const activity = n.agentActivity;
  if (!activity) return "unknown";
  if (activity.state === "running") return "running";
  if (activity.state === "needs_input") return "needs_input";
  if (activity.state === "idle") return "idle";
  return "unknown";
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function fitCell(value: string, width: number): string {
  return truncate(value, width).padEnd(width);
}

function padRigRow(rig: string, nodes: string, running: string, active: string, work: string, attn: string, status: string, lifecycle: string, uptime: string, snapshot: string): string {
  return [
    fitCell(rig, 24),
    fitCell(nodes, 7),
    fitCell(running, 9),
    // Slice 15——三个正交原语各自一列。
    // RUNNING = 进程存活（遗留）；ACTIVE = terminal-active（tmux）；
    // WORK = has-assigned-work（队列）。UI/CLI 分开渲染，让操作者一眼看出
    // 是哪个维度不同。
    fitCell(active, 8),
    fitCell(work, 6),
    // OPR.0.4.4.21——ATTN：需要关注的席位（视野锚点）。
    fitCell(attn, 6),
    fitCell(status, 10),
    fitCell(lifecycle, 11),
    fitCell(uptime, 11),
    snapshot,
  ].join("");
}

export function padNodeRow(rig: string, pod: string, member: string, session: string, runtime: string, model: string, status: string, startup: string, oriented: string, lifecycle: string, terminal: string, work: string, activity: string, ctx: string, restore: string, error: string): string {
  return [
    fitCell(rig, 30),
    fitCell(pod, 10),
    fitCell(member, 14),
    fitCell(session, 34),
    fitCell(runtime, 12),
    fitCell(model, 17),
    fitCell(status, 10),
    fitCell(startup, 10),
    // OPR.0.4.3.06——经挑战验证的 orientation，区别于 STARTUP。
    fitCell(oriented, 9),
    fitCell(lifecycle, 11),
    // Slice 15——TERMINAL 与 WORK 各自一列。
    fitCell(terminal, 9),
    fitCell(work, 6),
    fitCell(activity, 12),
    fitCell(ctx, 6),
    fitCell(restore, 10),
    error,
  ].join("");
}

export function padCompactNodeRow(rig: string, session: string, lifecycle: string, activity: string, work: string, reason: string): string {
  return [
    fitCell(rig, 22),
    fitCell(session, 38),
    fitCell(lifecycle, 11),
    fitCell(activity, 14),
    fitCell(work, 6),
    reason,
  ].join("");
}

// Slice 15——诚实渲染 terminal-active 原语。
// `null`（无信号）与 `false`（超过阈值静默）渲染得不同，让操作者能看出
// 是后台服务还没观察到该席位，还是观察了但没看到输出。
function formatTerminalActive(t: boolean | null | undefined): string {
  if (t === true) return "active";
  if (t === false) return "idle";
  return "—"; // null / undefined → 无信号
}

// Slice 17——渲染活动分派总数。pendingWorkCount 仍只表示 pending，绝不在此被替换，
// 因为被认领/阻塞的工作离开 pending 后仍须可见。pendingWorkCount 只是
// 早于 assignedWorkCount 的老后台服务的兼容回退。
function formatHasWork(has: boolean | undefined, count: number | undefined): string {
  if (has === undefined) return "—";
  if (!has) return "no";
  if (typeof count === "number" && count > 1) return `${count}`;
  return "yes";
}

// PL-012：context 用量渲染成一个 5 字符单元格——
// 已知且新鲜时 "<percent>%"，已知但过期时 "<percent>%*"，未知时 "??"。
// 4 字符宽保持表格紧凑，又不截断两位百分比（如 "98%*" 或 "5%"）。
function formatContextUsage(ctx: NodeEntry["contextUsage"]): string {
  if (!ctx || ctx.availability !== "known" || typeof ctx.usedPercentage !== "number") {
    return "??";
  }
  const stale = ctx.fresh === false ? "*" : "";
  return `${ctx.usedPercentage}%${stale}`;
}


async function runCrossHostPs(
  hostId: string,
  opts: PsCliOptions,
  deps: PsDeps,
): Promise<void> {
  const loader = deps.hostRegistryLoader ?? loadHostRegistry;
  const runner = deps.crossHostRun ?? runCrossHostCommand;

  const registry = loader();
  if (!registry.ok) {
    emitCrossHostError(hostId, "registry-load-failed", registry.error, opts.json);
    return;
  }
  const resolved = resolveHost(registry.registry, hostId);
  if (!resolved.ok) {
    emitCrossHostError(hostId, "unknown-host", resolved.error, opts.json);
    return;
  }
  const host = resolved.host;

  if (host.transport === "http") {
    await runHttpPs(host, opts, deps);
    return;
  }

  // SSH 路径——重建 argv
  const argv: string[] = ["rig", "ps"];
  if (opts.nodes) argv.push("--nodes");
  if (opts.full) argv.push("--full");
  // OPR.0.4.0.34：转发宽度标志，让 `--host h -A` 跨一跳仍保持全 rig 宽度
  // （当前 rig 默认是本地的，绝不应用于远程调用，但显式 -A 仍须到达远端）。
  // OPR.0.4.4.21 FR-3：-A 只在配合 --nodes 时合法（校验器已在任何分派前拒绝裸形式；
  // 本闸门让重建出的远程 argv 遵守同一语法）。
  if (opts.allRigs && opts.nodes) argv.push("--all-rigs");
  if (opts.limit !== undefined) argv.push("--limit", opts.limit);
  if (opts.fields !== undefined) argv.push("--fields", opts.fields);
  if (opts.summary) argv.push("--summary");
  if (opts.filter !== undefined) argv.push("--filter", opts.filter);
  // OPR.0.4.0.34：opts.active 是归一化形式（由 --active 或 --running 设置）。
  // 转发它，让状态过滤跨跳存活。
  if (opts.active) argv.push("--active");
  if (opts.rig !== undefined) argv.push("--rig", opts.rig);
  if (opts.session !== undefined) argv.push("--session", opts.session);
  if (opts.includeArchived) argv.push("--include-archived");
  if (opts.json) argv.push("--json");

  const result = await runner(host, argv);

  if (opts.json) {
    if (result.ok) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      return;
    }
    emitCrossHostFailure(host.id, hostDisplayTarget(host), result, true);
    return;
  }

  console.log(`[经 host=${host.id} (${hostDisplayTarget(host)})]`);
  if (result.ok) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return;
  }
  emitCrossHostFailure(host.id, hostDisplayTarget(host), result, false);
}

function buildRemoteHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function runHttpPs(
  host: HttpHostEntry,
  opts: PsCliOptions,
  deps: PsDeps,
): Promise<void> {
  const bearerResult = resolveRemoteBearer(host);
  if (!bearerResult.ok) {
    emitCrossHostError(host.id, bearerResult.failedStep, bearerResult.error, opts.json);
    process.exitCode = 1;
    return;
  }

  const controls = parsePsControls(opts);
  if ("error" in controls) {
    console.error(controls.error);
    process.exitCode = 1;
    return;
  }
  const { parsedFilter, limit, fields, useEnvelope } = controls;

  // A4：在这次远程读上盖 origin 三元组（不可用时 fail-open 退化为两段）。
  const originSelfHostId = await resolveOriginSelfHostId(deps.lifecycleDeps);
  const client = remoteDaemonClient(deps.clientFactory, host.url, originSelfHostId);
  const headers = buildRemoteHeaders(bearerResult.token);

  try {
    if (opts.nodes) {
      await handleNodes(client, opts, parsedFilter, limit, fields, useEnvelope, headers);
      return;
    }

    const res = await client.get<PsEntry[]>(psApiPath(opts), { headers });
    const failedStep = classifyHttpFailedStep(res.status);
    if (failedStep !== "none") {
      emitCrossHostError(host.id, failedStep, `HTTP ${res.status}`, opts.json);
      process.exitCode = 1;
      return;
    }

    const all = Array.isArray(res.data) ? res.data : [];
    const filtered = parsedFilter ? applyRigFilter(all, parsedFilter) : all;

    if (opts.summary) {
      const summary = summarizeRigs(filtered);
      if (opts.json) {
        console.log(JSON.stringify(summary));
      } else {
        console.log(`[经 host=${host.id} (${host.url})]`);
        console.log(JSON.stringify(summary, null, 2));
      }
      return;
    }

    const limited = limit !== null ? filtered.slice(0, limit) : filtered;
    const truncated = limit !== null && filtered.length > limit;
    const projected = fields ? selectFields(limited as unknown as Array<Record<string, unknown>>, fields) : limited;

    if (opts.json) {
      if (useEnvelope) {
        const envelope: Record<string, unknown> = { entries: projected, totalRigs: filtered.length, truncated };
        console.log(JSON.stringify(envelope));
      } else {
        console.log(JSON.stringify(projected));
      }
    } else {
      console.log(`[经 host=${host.id} (${host.url})]`);
      console.log(JSON.stringify(projected, null, 2));
    }
  } catch (err) {
    const failedStep = classifyHttpError(err);
    emitCrossHostError(host.id, failedStep, (err as Error).message, opts.json);
    process.exitCode = 1;
  }
}

/** 一段 fan-out 的内部传输结果（架构裁定：共享的 P4 契约是 fanout-contract 的
 *  AggregatedPayload/PerHostStatus；这个形状只作为 fan-out 的内部载体存活，
 *  在下面发出任何东西之前会被适配）。 */
interface FanOutHostResult {
  host: string;
  ok: boolean;
  failedStep: import("../cross-host-types.js").FailedStep | "unsupported-transport";
  data?: unknown;
  error?: string;
}

/** OPR.0.4.4.21 FR-5——适配到 P4 内共享契约的适配器
 *  （fanout-contract.ts，slice 15 首着陆于 0ecd329b；闭合的
 *  status 枚举才是契约，failedStep 作为追加细节携带）。 */
function toPerHostStatus(r: FanOutHostResult): PerHostStatus {
  const status: PerHostStatus["status"] =
    r.ok ? "ok"
    : r.failedStep === "unsupported-transport" ? "unsupported-transport"
    : r.failedStep === "permission-gate" ? "auth-failed"
    : "unreachable";
  const out: PerHostStatus = { hostId: r.host, status };
  if (r.error) out.error = r.error;
  if (!r.ok && r.failedStep !== "unsupported-transport") out.failedStep = r.failedStep;
  return out;
}

async function runFanOutPs(
  opts: PsCliOptions,
  deps: PsDeps,
  shaping: { parsedFilter: ParsedFilter | null; limit: number | null; fields: string[] | null },
): Promise<void> {
  const loader = deps.hostRegistryLoader ?? loadHostRegistry;
  const registry = loader();
  if (!registry.ok) {
    console.error(`错误：${registry.error}`);
    process.exitCode = 1;
    return;
  }

  const allHosts = registry.registry.hosts;
  let targetIds: string[];
  if (opts.hosts) {
    targetIds = opts.hosts.split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = targetIds.filter((id) => !allHosts.some((h) => h.id === id));
    if (unknown.length > 0) {
      console.error(`错误：未知主机 id：${unknown.join(", ")}`);
      process.exitCode = 1;
      return;
    }
  } else {
    // OPR.0.4.4.21 回补（qa1 F1）：目标是每一台已声明主机——非 HTTP 主机必须以
    // unsupported-transport 出现在 hosts[] 里（R15-2），绝不静默缺席。
    // 逐主机段负责分类传输。
    targetIds = allHosts.map((h) => h.id);
  }

  // A4：origin 三元组只解析一次（它是本机 id，对每段 fan-out 都相同），再盖到每个远程客户端——
  // 本地 selfHostId 不可用时 fail-open 退化为两段。
  const originSelfHostId = await resolveOriginSelfHostId(deps.lifecycleDeps);
  const results: FanOutHostResult[] = await Promise.all(
    targetIds.map(async (id): Promise<FanOutHostResult> => {
      const host = allHosts.find((h) => h.id === id);
      if (!host) return { host: id, ok: false, failedStep: "remote-daemon-unreachable", error: `未知主机 ${id}` };
      if (host.transport !== "http") {
        // R15-2（共享契约）：SSH 声明的主机是一个结构化的
        // unsupported-transport 状态——绝不只有文字、绝不静默变瘦输出。
        return { host: id, ok: false, failedStep: "unsupported-transport", error: `主机 ${id} 使用传输 ${host.transport}；HTTP fan-out 要求 transport: http` };
      }
      const httpHost = host as HttpHostEntry;
      const bearerResult = resolveRemoteBearer(httpHost);
      if (!bearerResult.ok) {
        return { host: id, ok: false, failedStep: bearerResult.failedStep, error: bearerResult.error };
      }
      const client = remoteDaemonClient(deps.clientFactory, httpHost.url, originSelfHostId);
      const headers = buildRemoteHeaders(bearerResult.token);
      try {
        const psQuery = opts.includeArchived ? "?includeArchived=true" : "";
        const res = await client.get<unknown>(`/api/ps${psQuery}`, { headers });
        const failedStep = classifyHttpFailedStep(res.status);
        if (failedStep !== "none") {
          return { host: id, ok: false, failedStep, error: `HTTP ${res.status}` };
        }
        if (!opts.nodes) {
          return { host: id, ok: true, failedStep: "none", data: res.data };
        }
        // OPR.0.4.4.21 FR-5——完整显式阶梯（--nodes -A，--full 看完整记录）：
        // 逐主机节点 fan-out，除非 --full 否则投影（不变量的最后一级；
        // 上游已校验为仅 -A）。
        const rigs = Array.isArray(res.data) ? (res.data as PsEntry[]) : [];
        const nodes: NodeEntry[] = [];
        for (const rig of rigs) {
          const nodesRes = await client.get<NodeEntry[]>(`/api/rigs/${encodeURIComponent(rig.rigId)}/nodes`, { headers });
          if (nodesRes.status >= 400) {
            return { host: id, ok: false, failedStep: classifyHttpFailedStep(nodesRes.status), error: `取 rig ${rig.rigName ?? rig.name} 的节点时 HTTP ${nodesRes.status}` };
          }
          const parentRigName = rig.rigName ?? rig.name;
          nodes.push(...nodesRes.data.map((n) => ({
            ...n,
            rigId: n.rigId ?? rig.rigId,
            rigName: n.rigName ?? parentRigName,
          })));
        }
        return { host: id, ok: true, failedStep: "none", data: nodes };
      } catch (err) {
        return { host: id, ok: false, failedStep: classifyHttpError(err), error: (err as Error).message };
      }
    }),
  );

  const hasFailure = results.some((r) => !r.ok);

  if (opts.json) {
    // OPR.0.4.4.21 FR-5——P4 内共享负载（与 slice 15 同一份契约）：
    // items = 每台主机的行盖上其来源 hostId（可平铺合并；来源绝不靠位置），
    // hosts = 逐主机结构化状态数组。每一台目标主机都出现在 hosts[] 里——
    // 成功或失败（不静默变瘦）。
    const rawItems: Array<Record<string, unknown>> = results.flatMap((r) =>
      r.ok && Array.isArray(r.data)
        ? (r.data as Array<Record<string, unknown>>).map((row) => ({ ...row, hostId: r.host }))
        : [],
    );
    const hostStatuses = results.map(toPerHostStatus);
    let narrowed = rawItems;
    if (opts.rig) narrowed = narrowed.filter((e) => (e.rigName ?? e.name) === opts.rig);
    if (opts.nodes && opts.session) narrowed = narrowed.filter((n) => n.canonicalSessionName === opts.session);

    const filtered = shaping.parsedFilter
      ? opts.nodes
        ? (applyNodeFilter(narrowed as unknown as NodeEntry[], shaping.parsedFilter) as unknown as Array<Record<string, unknown>>)
        : (applyRigFilter(narrowed as unknown as PsEntry[], shaping.parsedFilter) as unknown as Array<Record<string, unknown>>)
      : narrowed;

    let items: Array<Record<string, unknown>>;
    if (opts.summary) {
      items = [
        opts.nodes
          ? summarizeNodes(filtered as unknown as NodeEntry[])
          : summarizeRigs(filtered as unknown as PsEntry[]),
      ];
    } else {
      const limited = shaping.limit !== null ? filtered.slice(0, shaping.limit) : filtered;
      items = shaping.fields
        ? selectFanOutFields(limited, shaping.fields)
        : opts.nodes && !opts.full
          ? compactNodeProjection(limited as unknown as NodeEntry[]).map((row, i) => ({
              ...row,
              hostId: limited[i]?.hostId,
            }))
          : limited;
    }

    const payload: AggregatedPayload<Record<string, unknown>> = {
      items,
      hosts: hostStatuses,
    };
    console.log(JSON.stringify(payload));
  } else {
    for (const r of results) {
      if (r.ok) {
        console.log(`\n[host=${r.host}]`);
        console.log(JSON.stringify(r.data, null, 2));
      } else {
        console.log(`\n[host=${r.host}] 失败 (${r.failedStep})：${r.error}`);
      }
    }
  }

  if (hasFailure) process.exitCode = 3;
}
