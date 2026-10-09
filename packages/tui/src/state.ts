import { fileTargetForPath } from "./reading.js";
import { terminalExplorerRows } from "./terminals/terminal-model.js";
import { CONFIG_CATEGORIES } from "./config/config-model.js";
import { availableTabs } from "./commands/registry.js";
import { DEFAULT_TIME_ZONE, resolveTimeZone } from "./time.js";
// 一个实例范围视图状态带一个变更路径（dispatch）——PIN 1。
// 此文件中无任何模块级状态（FR-13）。分区集是
// 数据注册，非 switch（FR-12）。从 Phase-0 spike 逐字移植
// 形状：构造对等属性存在于 reducer 解析
// 'activate' 上，针对渲染器绘制的相同行模型。
import type {
  Action,
  DrillSegment,
  ExplorerRow,
  FleetSnapshot,
  GetSnapshot,
  SectionDef,
  ViewState,
  ViewStateStore,
  NavigationFrame,
} from "./types.js";
import { SECTION_REGISTRY, SYSTEM_SECTIONS } from "./sections.js";
import { scopesExplorerRows } from "./scopes/scopes-model.js";
import { GRAPH_STYLE_NAMES } from "./topology/render-graph.js";
import { rowStatusGlyph } from "./topology/glyphs.js";

export function defaultSections(): SectionDef[] {
  return SECTION_REGISTRY.map((section) => ({ ...section }));
}

export function emptySnapshot(): FleetSnapshot {
  return { health: { availability: "unavailable", evaluatedAt: null, total: 0, truncated: false, records: [] }, hosts: [], specs: [], needs: [], humanQueueProbed: false, execution: null, executionMission: null, attention: [], blocked: [], inProgress: [], seatActivity: [], pending: [], recentlyFinished: [], hostsDown: [], stream: [], readErrors: [] };
}

export interface CreateViewStateOptions {
  instanceId: string;
  timeZone?: string;
  timeZoneWarning?: string | null;
  sections?: SectionDef[];
  getSnapshot?: GetSnapshot;
}

export function createViewState(options: CreateViewStateOptions): ViewStateStore {
  const { instanceId, sections = defaultSections(), getSnapshot = emptySnapshot } = options;
  if (!instanceId) throw new Error("createViewState 需要 instanceId（A2：实例可寻址）");

  let state: ViewState = {
    instanceId,
    file: null,
    externalUrl: null,
    timeZone: resolveTimeZone(options.timeZone ?? DEFAULT_TIME_ZONE).timeZone,
    timeZoneWarning: options.timeZoneWarning ?? resolveTimeZone(options.timeZone ?? DEFAULT_TIME_ZONE).warning,
    timeZoneHelp: false,
    recentOpen: null,
    sections,
    section: sections[0]?.name ?? "topology",
    drill: [],
    filter: "",
    selection: 0,
    runningOf: null,
    viewTab: "table",
    // 创建者翻转（2026-08-04，修订规范 a4ae4b24/0a989c0d）：净框
    // 已解决（记录在 99433fde）但字体依赖 = 脆弱——
    // HATCHET 是默认渲染；盲文仍完全可用，通过
    // 样式动词（`style braille`），双向测试固定。
    graphStyle: "hatchet",
    contentOffset: 0,
    contentMaxOffset: 0,
    contentTargetCount: 0,
    contentSelection: 0,
    focusedPane: "explorer",
    copyMode: false,
    footerOn: true,
    expanded: [],
    notice: null,
    lastError: null,
    palette: null,
    project: null,
    scopesMission: null,
    scopesSelected: null,
    scopesCollapseReqs: false,
    scopesNarrative: false,
    executionOpen: null,
    healthOpen: null,
    attentionOpen: null,
  };
  const listeners = new Set<(s: ViewState) => void>();

  function dispatch(action: Action): ViewState {
    const previous = state;
    if (["attention-category", "attention-open", "terminal-preview", "project-select", "jump", "drill", "cross", "tab", "scopes-mission-open", "scopes-open", "health-open", "execution-open", "recent-open", "timezone", "config-category", "config-setting"].includes(action.type)) state = { ...state, file: null, externalUrl: null, recentOpen: null, timeZoneHelp: false, attentionOpen: null };
    state = reduce(state, action, getSnapshot());
    // 连接是工作的旁路，包括资源管理器/面板入口。
    if (action.type === "jump" && ![...SYSTEM_SECTIONS, "needs"].includes(action.section) && ![...SYSTEM_SECTIONS, "needs"].includes(previous.section)) state.history = [];
    // 过滤器变更当前视图；清除它绝不能将正在离开的详情
    // 加回历史（Esc 将无限循环）。
    else if (!["back", "execution-close", "filter"].includes(action.type) && !state.lastError && location(previous) !== location(state)) {
      state.history = [...(previous.history ?? []), navigationFrame(previous)].slice(-50);
    }
    for (const fn of listeners) fn(state);
    return state;
  }

  return {
    instanceId,
    get: () => state,
    dispatch,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

function reduce(state: ViewState, action: Action, snap: FleetSnapshot): ViewState {
  const next: ViewState = { ...state, lastError: null, notice: action.type === "notice" || action.type === "act" ? state.notice : null };
  switch (action.type) {
    case "terminal-result":
      return { ...next, terminalResult: { view: action.view, message: action.message } };
    case "terminal-preview":
      return syncSelection(resetContent({ ...next, section: "terminals", terminalView: action.view, terminalPage: 0, drill: [], viewTab: "table", healthOpen: null }), snap);
    case "terminal-page":
      return resetContent({ ...next, terminalPage: Math.max(0, Math.min(action.page, (snap.terminals?.preview?.composed.pages.length ?? 1) - 1)) });
    case "attention-category":
      return syncSelection({ ...resetContent({ ...next, section: "needs", attentionCategory: action.category, attentionOpen: null }), focusedPane: "content" }, snap);
    case "attention-open":
      return syncSelection({ ...resetContent({ ...next, section: "needs", attentionOpen: action.id, file: null, externalUrl: null, healthOpen: null }), focusedPane: "content" }, snap);
    case "attention-source": {
      const detail = snap.attentionRead?.detail;
      if (!detail || detail.item.id !== next.attentionOpen || !detail.files.some(f => f.path === action.path)) return { ...next, lastError: "源已不在当前待关注读取中" };
      const hash = action.path.indexOf("#");
      const target = fileTargetForPath(hash < 0 ? action.path : action.path.slice(0, hash), snap.fileRoots ?? []);
      if (target && hash >= 0) target.anchor = action.path.slice(hash + 1);
      const project = detail.item.project && action.path.startsWith(detail.item.project.root + "/") ? detail.item.project : null;
      return { ...resetContent({ ...next, project, file: target ?? { root: "", path: action.path } }), focusedPane: "content" };
    }
    case "file-open":
      return { ...resetContent({ ...next, file: action.target, externalUrl: null, healthOpen: null, recentOpen: null, timeZoneHelp: false }), focusedPane: "content" };
    case "print-for-copy":
      return state; // 终端副作用由 main 的 perform 运行；绝非视图状态变更
    case "external-open":
      return { ...resetContent({ ...next, externalUrl: action.url, file: null, healthOpen: null, recentOpen: null, timeZoneHelp: false }), focusedPane: "content" };
    case "time-setting":
      return { ...state, timeZone: action.timeZone, timeZoneWarning: action.timeZoneWarning };
    case "timezone":
      return resetContent({ ...next, timeZoneHelp: true, viewTab: "table", healthOpen: null });
    case "recent-open": {
      const row = snap.recentTransitions?.find((r) => r.transitionId === action.transitionId);
      return row ? resetContent({ ...next, recentOpen: { ...row }, healthOpen: null }) : { ...next, lastError: "事件不在已服务近期窗口内" };
    }
    case "back": {
      const history = [...(state.history ?? [])];
      const frame = history.pop();
      return frame ? { ...next, ...frame, history } : { ...next, notice: "无先前视图" };
    }
    case "noop":
      return next;
    case "error":
      return { ...next, lastError: action.message };
    case "config-category": {
      if (!CONFIG_CATEGORIES.some((c) => c.id === action.category)) return { ...next, lastError: "未知配置类别" };
      return syncSelection(resetContent({ ...next, section: "config", drill: [], viewTab: "table", configCategory: action.category, configKey: null, filter: "", healthOpen: null }), snap);
    }
    case "config-setting":
      return resetContent({ ...next, section: "config", drill: [], viewTab: "table", configKey: action.key, healthOpen: null });
    case "jump": {
      next.terminalView = null;
      next.terminalPage = 0;
      if (action.section === "needs") { next.attentionCategory = null; next.attentionOpen = null; next.file = null; next.externalUrl = null; next.recentOpen = null; next.timeZoneHelp = false; }
      // scopes：跳转到任何位置（包括返回 :scopes）关闭已打开切片。
      if (action.section === "scopes") next.project = null;
      next.scopesMission = null;
      next.scopesSelected = null;
      next.executionOpen = null;
      next.healthOpen = null;
      next.configCategory = null;
      next.configKey = null;
      if (!state.sections.some((s) => s.name === action.section))
        return { ...next, lastError: `未知分区 "${action.section}"` };
      return syncSelection(
        resetContent({ ...next, section: action.section, drill: [], filter: "", runningOf: null, viewTab: "table" }),
        snap,
      );
    }
    case "project-select": {
      const project = snap.projects?.projects.find(p => p.id === action.id);
      if (!project) return { ...next, lastError: `项目 ${action.id} 不在当前目录中` };
      return syncSelection(resetContent({ ...next, section: "scopes", project: { id: project.id, root: project.root }, drill: [], scopesMission: null, scopesSelected: null, executionOpen: null, scopesNarrative: false, filter: "", expanded: [], viewTab: "table" }), snap);
    }
    case "project-source": {
      if (!state.project || snap.projectRead?.id !== state.project.id || snap.projectRead?.root !== state.project.root) return { ...next, lastError: "所选项目读取挂起" };
      const entry = snap.projects?.projects.find(p => p.id === state.project!.id && p.root === state.project!.root);
      const missionSource = state.scopesMission ? snap.projectSources?.[state.scopesMission] : null;
      const sliceDir = state.scopesSelected?.slice ?? snap.sliceDetailName;
      const source = sliceDir && state.scopesMission ? snap.scopes?.find(m => m.mission === state.scopesMission)?.slices.find(s => s.dirName === sliceDir)?.sourcePath : missionSource ?? entry?.sourcePath;
      if (!source) return { ...next, lastError: "所选源不可用" };
      return reduce(next, { type: "file-open", target: fileTargetForPath(source, snap.fileRoots ?? []) ?? { root: "", path: source } }, snap);
    }
    case "scopes-mission-open": {
      if (snap.projects !== undefined && !state.project) return { ...next, lastError: "请先选择项目" };
      const key = `scopes-mission:${action.mission}`;
      const expanded = state.expanded.includes(key) ? state.expanded : [...state.expanded, key];
      return syncSelection(resetContent({ ...next, section: "scopes", drill: [], runningOf: null, viewTab: "table", filter: "", scopesMission: action.mission, scopesSelected: null, executionOpen: null, healthOpen: null, expanded }), snap);
    }
    case "scopes-open":
      return syncSelection(resetContent({ ...next, section: "scopes", drill: [], runningOf: null, viewTab: "table", filter: "", scopesMission: action.mission, scopesSelected: { mission: action.mission, slice: action.slice }, scopesNarrative: false, executionOpen: null, healthOpen: null }), snap);
    case "scopes-reqs":
      return { ...next, scopesCollapseReqs: !next.scopesCollapseReqs };
    case "scopes-narrative":
      return { ...next, scopesNarrative: !next.scopesNarrative };
    case "execution-open":
      if (next.section !== "scopes" || !next.scopesMission) return { ...next, lastError: "先打开任务目标再跟随其工作流或工作包" };
      return resetContent({ ...next, executionOpen: action.key });
    case "execution-close":
      return state.history?.length ? reduce(next, { type: "back" }, snap) : resetContent({ ...next, executionOpen: null });
    case "health-open":
      return { ...resetContent(next), healthOpen: action.findingId };
    case "health-close":
      return { ...resetContent(next), healthOpen: null };
    case "palette-open":
      return { ...next, palette: { query: "", selection: 0 } };
    case "palette-close":
      return { ...next, palette: null };
    case "palette-query":
      return next.palette ? { ...next, palette: { query: action.query, selection: 0 } } : next;
    case "palette-move": {
      if (!next.palette) return next;
      const sel = Math.max(0, next.palette.selection + action.delta);
      return { ...next, palette: { ...next.palette, selection: sel } };
    }
    case "style": {
      // slice-17：针对图样式注册表验证——每个输入适配器的
      // 唯一失败面（与分区相同规则）
      if (!(GRAPH_STYLE_NAMES as readonly string[]).includes(action.name))
        return { ...next, lastError: `未知样式 "${action.name}"——已知: ${GRAPH_STYLE_NAMES.join(", ")}` };
      return { ...next, graphStyle: action.name };
    }
    case "toggle-expand": {
      const expanded = state.expanded.includes(action.key)
        ? state.expanded.filter((key) => key !== action.key)
        : [...state.expanded, action.key];
      return { ...next, expanded };
    }
    case "tab": {
      // 5.2 Wave B——PULSE 是全组顶级视图（mock 的标签集），
      // 从任何内容上下文可达，不同于分区范围标签。
      if (action.tab === "pulse") return resetContent({ ...next, viewTab: "pulse", healthOpen: null });
      const allowed = availableTabs(state, snap);
      if (!allowed.includes(action.tab)) return { ...next, lastError: `标签 ${action.tab} 在此内容上下文中不可用` };
      return { ...resetContent({ ...next, viewTab: action.tab }), healthOpen: null };
    }
    case "content-scroll":
      return { ...next, contentOffset: Math.min(Math.max(0, state.contentOffset + action.delta), state.contentMaxOffset) };
    case "focus":
      return { ...next, focusedPane: action.pane };
    case "content-select": {
      const count = Math.max(state.contentTargetCount, 1);
      const target = action.index ?? state.contentSelection + (action.delta ?? 0);
      return { ...next, contentSelection: Math.min(Math.max(target, 0), count - 1) };
    }
    case "copy-mode":
      return { ...next, copyMode: action.on ?? !state.copyMode };
    case "layout":
      // 不要将恢复书签钳制在另一页的在飞快照上。
      if (state.file && JSON.stringify(state.file) !== JSON.stringify(snap.fileRead?.target)) return next;
      if (!state.file && state.section === "specs" && !snap.specsLoaded && (snap.fileRead || snap.config)) return next;
      return {
        ...next,
        contentMaxOffset: Math.max(action.contentMaxOffset, 0),
        contentTargetCount: Math.max(action.contentTargetCount, 0),
        contentOffset: Math.min(state.contentOffset, Math.max(action.contentMaxOffset, 0)),
        contentSelection: Math.min(state.contentSelection, Math.max(action.contentTargetCount - 1, 0)),
      };
    case "footer":
      return { ...next, footerOn: action.on ?? !state.footerOn };
    case "act":
    case "startup":
      // 动作是后台服务写入，由驱动循环执行，绝非视图状态
      // 变更——视图不被触碰；循环通过 'notice' 报告。
      return next;
    case "notice":
      return { ...next, notice: action.message };
    case "filter":
      return state.section === "config"
        ? syncSelection({ ...resetContent({ ...next, filter: action.text, configKey: null, configCategory: "all" }), focusedPane: "content" }, snap)
        : resetContent({ ...next, filter: action.text, selection: 0 });
    case "select": {
      const count = Math.max(action.rowCount ?? Number.MAX_SAFE_INTEGER, 1);
      const target = action.index ?? state.selection + (action.delta ?? 0);
      return { ...next, selection: Math.min(Math.max(target, 0), count - 1) };
    }
    case "activate": {
      // 回车激活所选资源管理器行——针对渲染器绘制的相同
      // 行模型解析，因此键盘和鼠标不会分歧。
      const row = computeExplorerRows(state, snap)[state.selection];
      if (!row) return { ...next, lastError: "未选择任何项" };
      return reduce(next, row.action, snap);
    }
    case "drill": {
      const drilled = drillTo(next, action.resource, action.name, snap, action.target);
      if (drilled.lastError) return drilled;
      const sectionState = clearScopeCoordinatesOnSectionChange(state, drilled);
      const spec = action.resource === "spec" ? findSpec(snap, action.name) : null;
      // 过滤器是视图范围的：跨分区的钻取清除旧
      // 分区的过滤器（创建者直接驱动捕获——规范过滤器泄漏
      // 到拓扑表并将其置空）
      const filter = drilled.section === state.section ? drilled.filter : "";
      return syncSelection({ ...resetContent({ ...sectionState, filter, viewTab: spec?.kind === "rig" ? "configuration" : "table" }), healthOpen: null }, snap);
    }
    case "cross": {
      const crossed = crossNav(next, action.kind, action.name, snap, action.target);
      if (crossed.lastError) return crossed;
      const sectionState = clearScopeCoordinatesOnSectionChange(state, crossed);
      const filter = crossed.section === state.section ? crossed.filter : "";
      return syncSelection({ ...sectionState, filter, healthOpen: null }, snap);
    }
    default:
      return { ...next, lastError: "未知动作" };
  }
}

function location(s: ViewState): string {
  return JSON.stringify([s.attentionCategory, s.attentionOpen, s.project, s.terminalView, s.section, s.drill, s.runningOf, s.scopesMission, s.scopesSelected, s.executionOpen, s.recentOpen?.transitionId, s.timeZoneHelp, s.configCategory, s.configKey, s.file, s.externalUrl]);
}

function navigationFrame(s: ViewState): NavigationFrame {
  const { attentionCategory, attentionOpen, project, terminalView, terminalPage, file, externalUrl, section, drill, filter, selection, runningOf, viewTab, contentOffset, contentMaxOffset, contentTargetCount, contentSelection, focusedPane, scopesMission, scopesSelected, scopesCollapseReqs, scopesNarrative, executionOpen, expanded, recentOpen, timeZoneHelp, configCategory, configKey } = s;
  return { attentionCategory, attentionOpen, project, terminalView, terminalPage, file, externalUrl, section, drill, filter, selection, runningOf, viewTab, contentOffset, contentMaxOffset, contentTargetCount, contentSelection, focusedPane, scopesMission, scopesSelected, scopesCollapseReqs, scopesNarrative, executionOpen, expanded, recentOpen, timeZoneHelp, configCategory, configKey };
}

function clearScopeCoordinatesOnSectionChange(previous: ViewState, next: ViewState): ViewState {
  return next.section === previous.section
    ? next
    : { ...next, scopesMission: null, scopesSelected: null, executionOpen: null };
}

function resetContent(state: ViewState): ViewState {
  return { ...state, contentOffset: 0, contentMaxOffset: 0, contentTargetCount: 0, contentSelection: 0, focusedPane: "explorer" };
}

/** 创建者滚动修复（类-(b) 焦点模型缺陷）：在可滚动规范
 *  详情上，正文是有意义的面，因此反射式 ↑↓ 滚动它——
 *  而资源管理器持有焦点（每次
 *  钻取焦点重置到资源管理器，这就是反射式键过去驱动隐藏树的原因）。门控
 *  在真实可滚动性（contentMaxOffset）上，因此非溢出规范详情
 *  保留其链接跳转/资源管理器行为。键路由（input.ts）和
 *  页脚/指示器提示（render.ts）都读取这个谓词，因此
 *  提示绝不能再次承诺键不执行的手势。 */
export function specDetailArrowsScroll(state: ViewState): boolean {
  return (!!state.file || !!state.externalUrl || (state.section === "specs" && state.drill.length > 0) || (state.section === "config" && !!state.configKey)) && state.contentMaxOffset > 0 && state.focusedPane !== "content";
}

/** 状态当前位置的资源管理器键（钻取叶或分区）。 */
export function locationKey(state: ViewState): string {
  if (state.section === "system") return "system:health";
  if (state.section === "terminals" && state.terminalView) return `terminal:${state.terminalView}`;
  if (state.section === "needs" && state.attentionCategory) return `attention-category:${state.attentionCategory}`;
  if (state.section === "config" && state.configCategory) return `config:${state.configCategory}`;
  if (state.section === "scopes" && state.scopesSelected) return `scopes-slice:${state.scopesSelected.mission}/${state.scopesSelected.slice}`;
  if (state.section === "scopes" && state.scopesMission) return `scopes-mission:${state.scopesMission}`;
  if (state.section === "scopes" && state.project) return `project:${state.project.id}`;
  const names = new Map(state.drill.map((seg) => [seg.kind, seg.name]));
  const leaf = state.drill.at(-1);
  if (!leaf || state.runningOf) return `section:${state.section}`;
  switch (leaf.kind) {
    case "host":
      return `host:${leaf.name}`;
    case "rig":
      return `rig:${names.get("host")}/${leaf.name}`;
    case "pod":
      return `pod:${names.get("host")}/${names.get("rig")}/${leaf.name}`;
    case "agent":
      return `agent:${names.get("host")}/${names.get("rig")}/${names.get("pod")}/${leaf.name}`;
    case "spec":
      return `spec:${leaf.name}`;
    default:
      return `section:${state.section}`;
  }
}

/** ROUND-4 条目 2-4：导航后资源管理器高亮落在
 * 已打开项上并停留——自动展开隐藏它的任何层级。 */
function syncSelection(state: ViewState, snap: FleetSnapshot): ViewState {
  const expanded = new Set(state.expanded);
  const names = new Map(state.drill.map((seg) => [seg.kind, seg.name]));
  if (names.has("pod")) expanded.add(`pod:${names.get("host")}/${names.get("rig")}/${names.get("pod")}`);
  const leaf = state.drill.at(-1);
  if (leaf?.kind === "spec") {
    const spec = findSpec(snap, leaf.name);
    if (spec) expanded.add(`specs-kind:${spec.kind}`);
    if (spec?.kind === "agent" && spec.namespace) expanded.add(`folder:${spec.namespace}`);
  }
  const withExpansion = { ...state, expanded: [...expanded] };
  const key = locationKey(withExpansion);
  const index = computeExplorerRows(withExpansion, snap).findIndex((row) => row.key === key);
  return index >= 0 ? { ...withExpansion, selection: index } : withExpansion;
}

// --- 快照查找（纯；此处无后台服务调用） ---

function agentMatches(snap: FleetSnapshot, name: string, target?: { host: string; rig?: string; pod?: string }) {
  const matches = [];
  for (const host of snap.hosts)
    for (const rig of host.rigs)
      for (const pod of rig.pods)
        for (const agent of pod.agents)
          if ((agent.name === name || agent.session === name) && (!target || (host.name === target.host && (!target.rig || rig.name === target.rig) && (!target.pod || pod.name === target.pod))))
            matches.push({ host, rig, pod, agent });
  return matches;
}

export function findAgent(snap: FleetSnapshot, name: string, target?: { host: string; rig?: string; pod?: string }) {
  const matches = agentMatches(snap, name, target);
  return matches.length === 1 ? matches[0]! : null;
}

export function findSpec(snap: FleetSnapshot, name: string) {
  return snap.specs.find((s) => s.name === name) ?? null;
}

/** 将需要你目标（会话名）联接回拓扑智能体。 */
export function findAgentBySession(snap: FleetSnapshot, session: string, hostId?: string) {
  const matches = [];
  for (const host of snap.hosts)
    for (const rig of host.rigs)
      for (const pod of rig.pods)
        for (const agent of pod.agents)
          if (agent.session === session && (!hostId || (host.id ?? host.name) === hostId)) matches.push({ host, rig, pod, agent });
  return matches.length === 1 ? matches[0]! : null;
}

function rigMatches(snap: FleetSnapshot, name: string, hostName?: string) {
  return snap.hosts.flatMap((host) => host.rigs
    .filter((rig) => rig.name === name && (!hostName || host.name === hostName))
    .map((rig) => ({ host, rig })));
}

export function findRig(snap: FleetSnapshot, name: string, hostName?: string) {
  const matches = rigMatches(snap, name, hostName);
  return matches.length === 1 ? matches[0]! : null;
}

export function agentsRunningSpec(snap: FleetSnapshot, specName: string): string[] {
  return agentsRunningSpecTargets(snap, specName).map(({ agent }) => agent.name);
}

export function agentsRunningSpecTargets(snap: FleetSnapshot, specName: string) {
  const out = [];
  for (const host of snap.hosts)
    for (const rig of host.rigs)
      for (const pod of rig.pods)
        for (const agent of pod.agents) if (agent.live && agent.spec === specName) out.push({ host, rig, pod, agent });
  return out;
}

function drillTo(state: ViewState, resource: string, name: string, snap: FleetSnapshot, target?: { host: string; rig?: string; pod?: string }): ViewState {
  switch (resource) {
    case "host": {
      if (!snap.hosts.some((h) => h.name === name)) return { ...state, lastError: `无此主机 "${name}"` };
      return { ...state, section: "topology", drill: [{ kind: "host", name }], selection: 0, runningOf: null };
    }
    case "rig": {
      const qualified = !target ? parseQualified(name, 2) : null;
      const rigName = qualified?.at(-1) ?? name;
      const hostName = qualified?.[0] ?? target?.host;
      const matches = rigMatches(snap, rigName, hostName);
      if (matches.length > 1) return { ...state, lastError: `工作组歧义 "${name}"——使用 rig <主机>/<工作组>` };
      const found = matches[0];
      if (!found) return { ...state, lastError: `无此工作组 "${name}"` };
      return {
        ...state,
        section: "topology",
        drill: [
          { kind: "host", name: found.host.name },
          { kind: "rig", name: rigName },
        ],
        selection: 0,
        runningOf: null,
      };
    }
    case "pod": {
      const qualified = !target ? parseQualified(name, 3) : null;
      const podName = qualified?.at(-1) ?? name;
      const hostName = qualified?.[0] ?? target?.host;
      const rigName = qualified?.[1] ?? target?.rig;
      const matches = [];
      for (const host of snap.hosts)
        for (const rig of host.rigs)
          for (const pod of rig.pods)
            if (pod.name === podName && (!hostName || host.name === hostName) && (!rigName || rig.name === rigName)) matches.push({ host, rig, pod });
      if (matches.length > 1) return { ...state, lastError: `席位歧义 "${name}"——使用 pod <主机>/<工作组>/<席位>` };
      const found = matches[0];
      if (found) return {
        ...state,
        section: "topology",
        drill: [
          { kind: "host", name: found.host.name },
          { kind: "rig", name: found.rig.name },
          { kind: "pod", name: podName },
        ],
        selection: 0,
        runningOf: null,
      };
      return { ...state, lastError: `无此席位 "${name}"` };
    }
    case "agent": {
      const qualified = !target ? parseQualifiedAgent(name) : null;
      const agentName = qualified?.name ?? name;
      const exactTarget = qualified?.target ?? target;
      const matches = agentMatches(snap, agentName, exactTarget);
      if (matches.length > 1) return { ...state, lastError: `智能体歧义 "${name}"——使用 agent <主机>/<工作组>/<席位>/<智能体>` };
      const found = matches[0];
      if (!found) return { ...state, lastError: `无此智能体 "${name}"` };
      const drill: DrillSegment[] = [
        { kind: "host", name: found.host.name },
        { kind: "rig", name: found.rig.name },
        { kind: "pod", name: found.pod.name },
        { kind: "agent", name: found.agent.name },
      ];
      return { ...state, section: "topology", drill, selection: 0, runningOf: null };
    }
    case "spec": {
      // 另一分区可能有意省略规范。其在那里缺失不是
      // 此源缺失的证据；在目录读取后判断。
      if (snap.specsLoaded && !findSpec(snap, name)) return { ...state, lastError: `无此规范 "${name}"` };
      return { ...state, section: "specs", drill: [{ kind: "spec", name }], selection: 0, runningOf: null };
    }
    default:
      return { ...state, lastError: `未知资源 "${resource}"` };
  }
}

function parseQualifiedAgent(value: string): { name: string; target: { host: string; rig: string; pod: string } } | null {
  const [host, rig, pod, ...agentParts] = value.split("/");
  if (!host || !rig || !pod || agentParts.length === 0) return null;
  return { name: agentParts.join("/"), target: { host, rig, pod } };
}

function parseQualified(value: string, count: number): string[] | null {
  const parts = value.split("/");
  return parts.length === count && parts.every(Boolean) ? parts : null;
}

function crossNav(state: ViewState, kind: "spec-of" | "running", name: string, snap: FleetSnapshot, target?: { host: string; rig?: string; pod?: string }): ViewState {
  if (kind === "spec-of") {
    const qualified = !target ? parseQualifiedAgent(name) : null;
    const agentName = qualified?.name ?? name;
    const matches = agentMatches(snap, agentName, qualified?.target ?? target);
    if (matches.length > 1) return { ...state, lastError: `智能体歧义 "${name}"——使用 spec-of <主机>/<工作组>/<席位>/<智能体>` };
    const found = matches[0];
    if (!found) return { ...state, lastError: `无此智能体 "${name}"` };
    if (!findSpec(snap, found.agent.spec)) return { ...state, lastError: `规范 "${found.agent.spec}" 不在库中` };
    return resetContent({
      ...state,
      section: "specs",
      drill: [{ kind: "spec", name: found.agent.spec }],
      selection: 0,
      runningOf: null,
      viewTab: "table",
    });
  }
  if (!findSpec(snap, name)) return { ...state, lastError: `无此规范 "${name}"` };
  return resetContent({ ...state, section: "topology", drill: [], runningOf: name, filter: "", selection: 0, viewTab: "table" });
}

// 资源管理器行模型——(状态, 快照) 的纯函数，被
// reducer（'activate'）和渲染器（绘制 + 命中图）共享。一个事实源。
export function computeExplorerRows(state: ViewState, snap: FleetSnapshot): ExplorerRow[] {
  const rows: ExplorerRow[] = [];
  for (const section of state.sections) {
    const active = section.name === state.section || section.name === "system" && SYSTEM_SECTIONS.includes(state.section);
    if (section.name === "config" || section.name === "connections") continue;
    const label =
      section.name === "topology"
        ? "拓扑"
        : section.name === "specs"
          ? "规范"
          : section.name === "needs"
            ? "待关注"
            : section.name === "scopes"
              ? "项目"
              : section.name === "terminals"
                ? "终端"
                : section.name === "system"
                  ? "系统"
                  : section.name.toUpperCase();
    // 分区变更视图但无独立折叠状态。不绘制
    // 无法切换的披露字形。
    rows.push({ label, action: { type: "jump", section: section.name }, key: `section:${section.name}` });
    if (!active) continue;
    if (section.name === "terminals") {
      rows.push(...terminalExplorerRows(state, snap));
      continue;
    }
    if (section.name === "system") {
      rows.push({ label: "  健康", key: "system:health", action: { type: "jump", section: "system" } },
        { label: "  配置", key: "section:config", action: { type: "jump", section: "config" } });
      if (state.section === "config") rows.push(...CONFIG_CATEGORIES.map((c) => ({ label: "    " + c.label, key: `config:${c.id}`, action: { type: "config-category" as const, category: c.id } })));
      rows.push({ label: "  连接", key: "section:connections", action: { type: "jump", section: "connections" } });
      if (state.history?.length) rows.push({ label: "  返回", key: "system:back", action: { type: "back" } });
      continue;
    }
    if (section.name === "scopes") {
      if (snap.projects === undefined) rows.push(...scopesExplorerRows(snap.scopes, new Set(state.expanded), "  "));
      for (const project of snap.projects?.projects ?? []) {
        rows.push({ label: `  ${state.project?.id === project.id ? "●" : "○"} ${project.id}${project.error ? " !" : ""}`, key: `project:${project.id}`, action: { type: "project-select", id: project.id } });
        if (state.project?.id === project.id && state.project.root === project.root && snap.projectRead?.id === project.id && snap.projectRead.root === project.root)
          rows.push(...scopesExplorerRows(snap.scopes, new Set(state.expanded), "    "));
      }
      if (state.history?.length) rows.push({ label: "  返回", key: "project:back", action: { type: "back" } });
      continue;
    }
    if (section.name === "topology") {
      // ROUND-4 条目 4：默认工作组 + 席位；智能体在席位
      // 展开时出现（钻取席位展开它）——"视觉更紧凑"。
      const expanded = new Set(state.expanded);
      for (const host of snap.hosts) {
        rows.push({
          label: `  ▾ ${host.name}${host.reachable ? "" : " (不可达)"}`,
          action: { type: "drill", resource: "host", name: host.name },
          key: `host:${host.name}`,
        });
        for (const rig of host.rigs) {
          const stateSuffix = rig.lifecycleState && rig.lifecycleState !== "running" ? ` (${rig.lifecycleState})` : "";
          rows.push({
            label: `    ▾ ${rig.name}${stateSuffix}`,
            action: { type: "drill", resource: "rig", name: rig.name, target: { host: host.name } },
            key: `rig:${host.name}/${rig.name}`,
          });
          for (const pod of rig.pods) {
            const podKey = `pod:${host.name}/${rig.name}/${pod.name}`;
            const open = expanded.has(podKey);
            rows.push({
              label: `      ${open ? "▾" : "▸"} ${pod.name} (${pod.agents.length})`,
              action: { type: "drill", resource: "pod", name: pod.name, target: { host: host.name, rig: rig.name } },
              disclosureAction: { type: "toggle-expand", key: podKey },
              key: podKey,
            });
            if (!open) continue;
            // S19 round-4（守卫发现 4）：字形来自已服务
            // 状态——活跃/空闲/待关注/未知视觉区分，
            // 离线席位绝不装扮为活跃 ●
            for (const agent of pod.agents)
              rows.push({
                label: `        ${rowStatusGlyph(agent).glyph} ${agent.name}`,
                action: { type: "drill", resource: "agent", name: agent.name, target: { host: host.name, rig: rig.name, pod: pod.name } },
                key: `agent:${host.name}/${rig.name}/${pod.name}/${agent.name}`,
              });
          }
        }
      }
    } else if (section.name === "specs") {
      const kinds = ["rig", "agent", "workflow"] as const;
      rows.push({
        label: state.filter ? `/ 过滤: ${state.filter} · / 替换 · Esc 清除` : "/ 过滤规范…",
        action: { type: "filter", text: state.filter },
      });
      // ROUND-4 条目 3：工作组规范完全展开；智能体规范默认
      // 折叠到文件夹层级（"太多了，会填满"）。
      const expanded = new Set(state.expanded);
      for (const kind of kinds) {
        const list = snap.specs.filter((s) => s.kind === kind).filter((s) => !state.filter || s.name.includes(state.filter));
        if (list.length === 0) continue;
        const key = `specs-kind:${kind}`;
        const openKind = expanded.has(key) || !!state.filter;
        rows.push({ label: `  ${openKind ? "▾" : "▸"} ${kind.toUpperCase()} 规范 (${list.length})`, action: { type: "toggle-expand", key }, disclosureAction: { type: "toggle-expand", key }, key });
        if (!openKind) continue;
        if (kind !== "agent") {
          for (const spec of list)
            rows.push({ label: `    ▪ ${spec.name}`, action: { type: "drill", resource: "spec", name: spec.name }, key: `spec:${spec.name}` });
          continue;
        }
        const groups = new Map<string, typeof list>();
        for (const spec of list) {
          const namespace = spec.namespace ?? "(根)";
          const group = groups.get(namespace) ?? [];
          group.push(spec);
          groups.set(namespace, group);
        }
        for (const [namespace, specs] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          // 过滤器搜索覆盖折叠——匹配必须可见
          const open = namespace === "(根)" || expanded.has(`folder:${namespace}`) || !!state.filter;
          if (namespace !== "(根)")
            rows.push({
              label: `    ${open ? "▾" : "▸"} ${namespace}/ (${specs.length})`,
              action: { type: "toggle-expand", key: `folder:${namespace}` },
              disclosureAction: { type: "toggle-expand", key: `folder:${namespace}` },
              key: `folder:${namespace}`,
            });
          if (!open) continue;
          for (const spec of specs)
            rows.push({
              label: `${namespace === "(根)" ? "    " : "      "}▪ ${spec.name}`,
              action: { type: "drill", resource: "spec", name: spec.name },
              key: `spec:${spec.name}`,
            });
        }
      }
    } else if (section.name === "needs") {
      rows.push({ label: "  人类请求", key: "attention-category:action", action: { type: "attention-category", category: "action" } },
        { label: "  更新", key: "attention-category:update", action: { type: "attention-category", category: "update" } });
      if (state.history?.length) rows.push({ label: "  返回", key: "attention:back", action: { type: "back" } });
    }
  }
  return rows;
}
