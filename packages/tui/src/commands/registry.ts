// REGISTRY I1（裁决 64f1dbdf）——唯一命令注册表，TUI 命令界面的唯一来源。
// 一个 UI 动作如果没有此处条目就无法存在：语法（grammar.ts）从此注册表派生其动词表、
// 参数校验和错误列表，因此未文档化的动作在构造上不可能发生（PM pin 1 的对等测试在 CI 中强制执行）。
// 渲染界面（CLI 转储、面板、socket 查询——I2-I4）是这些条目的序列化投影，绝不手工维护（PM pin 2）。
// `context` 是诚实可用性限定符（PM pin 3）："always" 在所有状态渲染；"standard" 要求正常的后台服务运行 shell。
import type { Action, ResourceKind, SectionDef, FleetSnapshot, ViewState, ViewTab } from "../types.js";

import { CONFIG_CATEGORIES } from "../config/config-model.js";
import { GRAPH_STYLE_NAMES } from "../topology/render-graph.js";

export interface CompletionContext { state: ViewState; snapshot: FleetSnapshot }

export function availableTabs(state: ViewState, snap: FleetSnapshot): ViewTab[] {
  const rigSpec = state.section === "specs" && state.drill.at(-1)?.kind === "spec"
    && snap.specs.find((s) => s.name === state.drill.at(-1)?.name)?.kind === "rig";
  return [...(rigSpec ? ["topology", "configuration", "yaml"] : state.section === "topology" ? ["table", "recent", "overview", "graph", "health"] : []), "pulse"] as ViewTab[];
}

function resourceNames(resource: ResourceKind, snap: FleetSnapshot): string[] {
  if (resource === "spec") return snap.specs.map((s) => s.name);
  if (resource === "host") return snap.hosts.map((h) => h.name);
  const entries: Array<{ name: string; qualified: string }> = [];
  for (const h of snap.hosts) for (const r of h.rigs) {
    if (resource === "rig") entries.push({ name: r.name, qualified: `${h.name}/${r.name}` });
    for (const p of r.pods) {
      if (resource === "pod") entries.push({ name: p.name, qualified: `${h.name}/${r.name}/${p.name}` });
      if (resource === "agent") for (const a of p.agents) entries.push({ name: a.name, qualified: `${h.name}/${r.name}/${p.name}/${a.name}` });
    }
  }
  return entries.map((entry) => entries.filter((e) => e.name === entry.name).length > 1 ? entry.qualified : entry.name);
}

function workflowArgs(ctx: CompletionContext, packets: boolean): string[] {
  const ex = ctx.snapshot.execution;
  if (!ctx.state.scopesMission || ex?.mission !== ctx.state.scopesMission) return [];
  return (ex.lifecycle_instances ?? []).flatMap((instance) => packets
    ? (Array.isArray(instance.frontier_packets) ? instance.frontier_packets : []).map((p: { packet_id?: unknown }) => p.packet_id).filter((v): v is string => typeof v === "string")
    : typeof instance.instance_id === "string" ? [instance.instance_id] : []);
}

export interface CommandEntry {
  /** 规范动词（或前缀形式命令的前缀符号）。 */
  name: string;
  /** 一等备选——面板和语法同等匹配这些别名（PM pin 5）。 */
  aliases: string[];
  /** 人类可读的参数形状，例如 "<view>"——逐字序列化到所有界面。 */
  args: string;
  description: string;
  /** 可用性上下文（PM pin 3）：与下游 C3 检测器状态组合。 */
  context: "standard" | "always";
  /** 前缀形式命令（`:` 跳转、`/` 过滤）结构性解析，而非按动词 token。 */
  prefix?: boolean;
  /** 一个规范的可解析调用——对等测试证明它产生非错误动作。 */
  sample: string;
  /** 从参数余料构建动作（仅动词命令）。 */
  build?: (name: string, ctx: BuildCtx) => Action;
  complete?: (ctx: CompletionContext) => readonly string[];
}

export interface BuildCtx {
  sections: readonly SectionDef[];
}

const RESOURCES: ResourceKind[] = ["host", "rig", "pod", "agent", "spec"];
const TABS = ["table", "recent", "overview", "graph", "health", "topology", "configuration", "yaml", "pulse"] as const;

function drillEntry(resource: ResourceKind): CommandEntry {
  return {
    name: resource,
    aliases: [],
    args: "<name>",
    description: `钻取到命名的 ${resource}`,
    context: "standard",
    sample: `${resource} x`,
    complete: ({ snapshot }) => resourceNames(resource, snapshot),
    build: (name) =>
      name
        ? { type: "drill", resource, name }
        : { type: "error", message: `${resource} 钻取需要名称（例如 "${resource} <name>"）` },
  };
}

export const COMMAND_REGISTRY: readonly CommandEntry[] = [
  { name: "terminals", aliases: [], args: "", description: "浏览已保存和派生的终端视图；在显式打开前预览", context: "standard", sample: "terminals", build: () => ({ type: "jump", section: "terminals" }) },
  { name: "terminal-preview", aliases: [], args: "<view>", description: "被动预览 saved:id 或 rig:name 终端视图", context: "standard", sample: "terminal-preview rig:example", build: view => view ? ({ type: "terminal-preview", view }) : ({ type: "error", message: "terminal-preview 需要一个视图" }) },
  { name: "terminal", aliases: [], args: "<view>", description: "在默认提供程序（herdr）中以瓦片打开 rig:name、pod:rig/pod、mission:id、slice:id 或 saved:id 视图", context: "standard", sample: "terminal rig:example",
    complete: ({ snapshot }) => snapshot.hosts.flatMap((h) => h.rigs.map((r) => `rig:${r.name}`)),
    build: view => view ? ({ type: "act", act: "open-terminal", view }) : ({ type: "error", message: "terminal 需要一个视图，例如 rig:<name>" }) },
  { name: "attention", aliases: ["needs", "feed", "需要"], args: "", description: "查看人类请求和结果/健康状态更新", context: "standard", sample: "attention", build: () => ({ type: "jump", section: "needs" }) },
  { name: "read", aliases: [], args: "<root>/<path>[#heading]", description: "在显式配置的根目录内读取当前文件", context: "standard", sample: "read workspace/README.md", complete: ({ snapshot }) => (snapshot.fileRoots ?? []).map((root) => `${root.name}/`), build: (value) => {
    const slash = value.indexOf("/");
    if (slash < 1 || slash === value.length - 1) return { type: "error", message: "read 需要从已配置的可读根目录提供 <root>/<path>[#heading]" };
    const hash = value.indexOf("#", slash);
    return { type: "file-open", target: { root: value.slice(0, slash), path: value.slice(slash + 1, hash < 0 ? undefined : hash), ...(hash < 0 ? {} : { anchor: value.slice(hash + 1) }) } };
  } },
  { name: "system", aliases: [], args: "", description: "实例健康状态、配置和连接", context: "standard", sample: "system", build: () => ({ type: "jump", section: "system" }) },
  { name: "config", aliases: [], args: "[category]", description: "浏览实例设置；Slack 是其中一个类别", context: "standard", sample: "config", complete: () => CONFIG_CATEGORIES.map((c) => c.id), build: (category) => category ? { type: "config-category", category } : { type: "jump", section: "config" } },
  { name: "setting", aliases: [], args: "<key>", description: "打开一个设置及其完整值、来源和范围", context: "standard", sample: "setting workspace.root", complete: ({ snapshot }) => (snapshot.config?.entries ?? []).map((e) => e.key), build: (key) => key ? { type: "config-setting", key } : { type: "error", message: "setting 需要一个键" } },
  { name: "refresh", aliases: [], args: "", description: "重新读取当前视图；存储值不证明运行时已采纳", context: "standard", sample: "refresh", build: () => ({ type: "noop" }) },
  { name: "timezone", aliases: [], args: "", description: "显示本地时间设置和持久化工作组配置说明", context: "standard", sample: "timezone", build: () => ({ type: "timezone" }) },
  { name: "recent", aliases: [], args: "<transition-id>", description: "从服务的最近窗口查看原始事件", context: "standard", sample: "recent 1", complete: ({ snapshot }) => (snapshot.recentTransitions ?? []).map((r) => String(r.transitionId)), build: (id) => /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) ? { type: "recent-open", transitionId: Number(id) } : { type: "error", message: "recent 需要来自服务窗口的事件 ID" } },
  { name: "connections", aliases: [], args: "", description: "系统连接：网关、接收者和路由", context: "standard", sample: "connections", build: () => ({ type: "jump", section: "connections" }) },
  { name: "back", aliases: [], args: "", description: "返回上一个视图、选择和滚动位置", context: "standard", sample: "back", build: () => ({ type: "back" }) },
  { name: "projects", aliases: [], args: "", description: "从工作区目录选择项目", context: "standard", sample: "projects", build: () => ({ type: "jump", section: "scopes" }) },
  { name: "project", aliases: [], args: "<id>", description: "选择一个确切的目录项目", context: "standard", sample: "project example", complete: ({ snapshot }) => (snapshot.projects?.projects ?? []).map(p => p.id), build: id => id ? { type: "project-select", id } : { type: "error", message: "project 需要一个目录 ID" } },
  { name: "source", aliases: [], args: "", description: "读取所选项目、任务目标或切片的来源", context: "standard", sample: "source", build: () => ({ type: "project-source" }) },
  { name: "mission", aliases: [], args: "<name>", description: "打开任务目标的工作和工作流", context: "standard", sample: "mission release-demo", complete: ({ snapshot }) => (snapshot.scopes ?? []).map((m) => m.mission), build: (name) => name ? { type: "scopes-mission-open", mission: name } : { type: "error", message: "mission 需要一个名称" } },
  { name: "workflow", aliases: [], args: "<instance-id>", description: "在所选任务目标中打开工作流", context: "standard", sample: "workflow example", complete: (ctx) => workflowArgs(ctx, false), build: (name) => name ? { type: "execution-open", key: `workflow:${name}` } : { type: "error", message: "workflow 需要一个实例 ID" } },
  { name: "packet", aliases: [], args: "<qitem-id>", description: "打开所选任务目标中当前工作流的工作项", context: "standard", sample: "packet example", complete: (ctx) => workflowArgs(ctx, true), build: (name) => name ? { type: "execution-open", key: `packet:${name}` } : { type: "error", message: "packet 需要一个队列 ID" } },
  {
    name: ":",
    aliases: [],
    args: "<section>",
    description: "跳转到分区",
    context: "standard",
    prefix: true,
    sample: ":topology",
  },
  {
    name: "/",
    aliases: [],
    args: "<text>",
    description: "按文本过滤行",
    context: "standard",
    prefix: true,
    sample: "/dev",
  },
  {
    name: "tab",
    aliases: [],
    args: `<${TABS.join("|")}>`,
    description: "切换内容面板视图标签页",
    context: "standard",
    sample: "tab table",
    complete: ({ state, snapshot }) => availableTabs(state, snapshot),
    build: (name) =>
      (TABS as readonly string[]).includes(name)
        ? { type: "tab", tab: name as Extract<Action, { type: "tab" }>["tab"] }
        : { type: "error", message: `未知标签页 "${name}" — 已知：${TABS.join(", ")}` },
  },
  {
    // P10（创建者发现）——注册表的第一个迁移命令（PM pin 4）：以前是裸语法特例，
    // 现在是已注册的一等命令。与 `tab graph` 动作相同；
    // 当没有图形服务时，视图渲染为诚实空状态（诚实降级轨道）。
    name: "graph",
    // "g" —— 第一个真正的别名（I1-review nit 2）：真实地演练别名对等分支。
    aliases: ["g"],
    args: "",
    description: "打开拓扑图形视图",
    context: "standard",
    sample: "graph",
    build: () => ({ type: "tab", tab: "graph" }),
  },
  {
    name: "style",
    aliases: [],
    args: "<name>",
    description: "设置图形渲染样式（由 dispatch 对照样式注册表验证）",
    context: "standard",
    sample: "style hatchet",
    complete: () => GRAPH_STYLE_NAMES,
    build: (name) =>
      name ? { type: "style", name } : { type: "error", message: 'style 需要一个名称（例如 "style hatchet"）' },
  },
  {
    name: "scroll",
    aliases: [],
    args: "<up|down>",
    description: "滚动内容面板",
    context: "standard",
    sample: "scroll down",
    complete: () => ["up", "down"],
    build: (name) =>
      name === "up" || name === "down"
        ? { type: "content-scroll", delta: name === "down" ? 10 : -10 }
        : { type: "error", message: `未知滚动方向 "${name}" — 已知：scroll up、scroll down` },
  },
  {
    name: "select-text",
    aliases: ["copy"],
    args: "",
    description: "切换终端原生拖选和复制",
    context: "standard",
    sample: "select-text",
    build: () => ({ type: "copy-mode" }),
  },
  {
    // TUI 滚动（裁决 cfec754f）：将内容面板跳转到极端位置。注册为动词（`top`），
    // 而非 `:top`——`:` 是分区别跳转前缀（会被解析为未知分区）。复用 content-scroll：
    // reducer 将 `contentOffset + delta` 钳制在 [0, max]，因此极端负 delta 落在顶部（无需新动作/reducer）。
    name: "top",
    aliases: [],
    args: "",
    description: "将内容面板滚动到顶部",
    context: "standard",
    sample: "top",
    build: () => ({ type: "content-scroll", delta: -Number.MAX_SAFE_INTEGER }),
  },
  {
    name: "bottom",
    aliases: [],
    args: "",
    description: "将内容面板滚动到底部",
    context: "standard",
    sample: "bottom",
    build: () => ({ type: "content-scroll", delta: Number.MAX_SAFE_INTEGER }),
  },
  {
    // `find <text>` —— `/` 过滤前缀的可发现动词形式（相同过滤动作）。
    name: "find",
    aliases: [],
    args: "<text>",
    description: "按文本过滤行（/ 前缀的动词形式）",
    context: "standard",
    sample: "find dev",
    build: (name) =>
      name ? { type: "filter", text: name } : { type: "error", message: 'find 需要文本（例如 "find dev"）' },
  },
  {
    name: "spec-of",
    aliases: [],
    args: "<agent>",
    description: "交叉导航到命名智能体的规格",
    context: "standard",
    sample: "spec-of dev.driver",
    complete: ({ snapshot }) => resourceNames("agent", snapshot),
    build: (name) =>
      name
        ? { type: "cross", kind: "spec-of", name }
        : { type: "error", message: `spec-of 需要一个目标名称（例如 "spec-of dev.driver"）` },
  },
  {
    name: "running",
    aliases: [],
    args: "<spec>",
    description: "交叉导航到运行命名规格的智能体",
    context: "standard",
    sample: "running driver-agent",
    complete: ({ snapshot }) => resourceNames("spec", snapshot),
    build: (name) =>
      name
        ? { type: "cross", kind: "running", name }
        : { type: "error", message: `running 需要一个目标名称（例如 "running driver-agent"）` },
  },
  {
    // I3 —— 面板触发本身是一个已注册命令（'?' 是创建者人体工学别名）；context "always"：
    // 帮助必须在每个状态下都能工作。
    name: "help",
    aliases: ["?"],
    args: "",
    description: "打开命令面板（模糊查找所有命令）",
    context: "always",
    sample: "help",
    build: () => ({ type: "palette-open" }),
  },
  {
    // SCOPES 视图（d64d2f5c）：m 键快捷键的命令形式。
    name: "reqs",
    aliases: [],
    args: "",
    description: "切换迷你需求折叠（工作范围视图）",
    context: "standard",
    sample: "reqs",
    build: () => ({ type: "scopes-reqs" }),
  },
  {
    // SCOPES 视图：PROGRESS.md 作为人类叙事日志——仅显示，绝不是数据。
    name: "narrative",
    aliases: [],
    args: "",
    description: "切换 PROGRESS.md 叙事面板（工作范围视图）",
    context: "standard",
    sample: "narrative",
    build: () => ({ type: "scopes-narrative" }),
  },
  ...RESOURCES.map(drillEntry),
];

/** 动词 → 条目映射，别名一等公民（PM pin 5）。 */
export const VERB_TABLE: ReadonlyMap<string, CommandEntry> = new Map(
  COMMAND_REGISTRY.filter((e) => !e.prefix).flatMap((e) => [
    [e.name, e] as const,
    ...e.aliases.map((a) => [a, e] as const),
  ]),
);

/** 未知动词错误列表——从注册表序列化（绝不手工维护）。 */
export function unknownCommandMessage(verb: string): string {
  // I1-review nit 1：前缀片段也从前缀条目序列化——
  // 任何地方都没有手写命令列表（镜像律，整条消息）。
  const prefixes = COMMAND_REGISTRY.filter((e) => e.prefix)
    .map((e) => `${e.name}${e.args}`)
    .join(" ");
  const verbs = COMMAND_REGISTRY.filter((e) => !e.prefix)
    .map((e) => (e.args ? `${e.name} ${e.args}` : e.name))
    .join(", ");
  return `未知命令 "${verb}" — 已知：${prefixes} ${verbs}`;
}

/** 一条可用性规则（I3 面板和 I4 socket 共享）："always" 满足任何上下文；
 *  否则条目的上下文必须等于当前上下文。 */
export function evaluateAvailability(entry: CommandEntry, currentContext: string): { available: boolean; reason?: string } {
  const available = entry.context === "always" || entry.context === currentContext;
  return available ? { available } : { available: false, reason: `需要 ${entry.context} 上下文` };
}

/** I4 —— socket "commands" 观察投影：数据契约 + 实时可用性。
 *  从唯一注册表序列化（PM pin 2），按会话评估（PM pin 3）。 */
export function serializeCommands(currentContext: string): Array<{
  name: string; aliases: string[]; args: string; description: string; context: string;
  sample: string; available: boolean; reason?: string;
}> {
  return COMMAND_REGISTRY.map((e) => ({
    name: e.name, aliases: e.aliases, args: e.args, description: e.description,
    context: e.context, sample: e.sample, ...evaluateAvailability(e, currentContext),
  }));
}

/** I5 —— C3 检测器状态 → 命令上下文映射（将 PM pin 3 与故障诊断检测器组合）：
 *  up/absent = 标准 shell；down = 故障诊断座舱；
 *  unverified = 其自身的诚实上下文（没有任何东西假装后台服务已启动或已停止）。 */
export function currentCommandContext(daemonState: "up" | "down" | "unverified" | null | undefined): string {
  if (daemonState === "down") return "crash-cart";
  if (daemonState === "unverified") return "unverified";
  return "standard";
}
