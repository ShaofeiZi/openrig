import { helpScreen } from "./commands/help.js";
import { commandFocusVisible } from "./motion.js";
import { attentionLines } from "./attention/attention-model.js";
import { fileLines, externalLines, fileTargetForPath, referenceLines, referenceAction } from "./reading.js";
import { DEFAULT_TIME_ZONE, displayTime } from "./time.js";
import { startupLines, type StartupState } from "./startup.js";
import { configLines } from "./config/config-model.js";
import { connectionsLines } from "./connections/connections-model.js";
function sectionLabel(section: string): string {
  return { topology: "拓扑", specs: "规范", scopes: "项目", needs: "待关注", terminals: "终端", system: "系统", config: "配置", connections: "连接" }[section] ?? section.toUpperCase();
}

// 手写 ANSI 渲染器（Phase-0 基础决策）。纯函数：
// (状态, 快照) → {lines, hitMap, explorerRows}。两个窗格都发出命中
// 目标——资源管理器行和内容窗格表面（表行、视图标签、
// 智能体引用、需要你项）——因此任何位置的鼠标点击解析为
// 命令产生的相同语义动作（PIN 1）。隔离接缝：基础
// 替换仅触及此模块（spike 判定复核触发器）。
import { computeExplorerRows, findAgent, findSpec, findAgentBySession, agentsRunningSpec, agentsRunningSpecTargets, specDetailArrowsScroll } from "./state.js";
import { scopesContentLines } from "./scopes/scopes-model.js";
import { executionContentLines, executionSliceStripLines } from "./execution/execution-model.js";
import { navigatorDisplay } from "./navigator.js";
import { renderGraphStyle } from "./topology/render-graph.js";
import { buildPulseModel } from "./pulse/pulse-model.js";
import { renderPulseView, pulseLaneTargets } from "./pulse/render-pulse.js";
import { renderCrashCartView, renderUnverifiedView, renderRestoreLifecycleView, renderConfirmBanner } from "./crash-cart/render-crash-cart.js";
import type { RestoreLifecycleVM } from "./crash-cart/restore-lifecycle.js";
import { buildLedgerExplorer } from "./crash-cart/ledger-explorer.js";
import type { CrashCartModel } from "./crash-cart/crash-cart-model.js";
import type { DaemonState, DaemonUnverifiedEvidence } from "./crash-cart/contract.js";
import { runtimeMarkSegs } from "./topology/runtime-marks.js";
import { barCells, flashActive, reducedMotion, spinnerFrame } from "./motion.js";
import { explorerWidth, MOTION_FRAME_MS } from "./visual-layout.js";
import type { ColorMode, Token } from "./theme.js";
import { terminalLines } from "./terminals/terminal-model.js";
import { detailPage, fieldLine, sectionRule, listItem, alignedRow, LABEL_W, wrapDetailLines } from "./detail.js";
import { healthAgentLines, healthDetailLines, healthListLines, healthSummaryLine } from "./health/health-model.js";
import type { Action, FleetSnapshot, LoadState, NeedsItem, RecentTransitionSnap, RowFlash, Screen, ViewState } from "./types.js";

interface ContentLine {
  text: string;
  /** 点击此行时分派，仅限打开/导航类操作。 */
  action?: Action;
  /** 行内点击区域（相对于内容的索引），先于 `action` 匹配。BR-9：区域操作只驱动结构，
   * 即生命周期和导航。 */
  zones?: Array<{ start: number; end: number; action: Action }>;
  /** slice-17：画布渲染行（图视图）的 token 分段。 */
  segs?: Array<{ text: string; token?: import("./theme.js").Token; bold?: boolean; bg?: import("./theme.js").Token }>;
}

import { columnIndex, strWidth, clipW as truncateToWidth, padEndW, clipW } from "./text-width.js";

function pad(text: string | number | null | undefined, width: number): string {
  const t = String(text ?? "");
  const w = strWidth(t);
  if (w <= width) return t + " ".repeat(width - w);
  return padEndW(truncateToWidth(t, width), width);
}

function padLeft(text: string | number | null | undefined, width: number): string {
  const t = String(text ?? "");
  const w = strWidth(t);
  if (w <= width) return " ".repeat(width - w) + t;
  const clipped = truncateToWidth(t, width);
  return " ".repeat(Math.max(0, width - strWidth(clipped))) + clipped;
}

type Align = "left" | "right";
type AgentColumnKey = "rig" | "pod" | "seat" | "runtime" | "model" | "context" | "status" | "queue" | "work" | "now" | "actions";
type AgentColumn = [key: AgentColumnKey, name: string, width: number, align: Align];

function columnsWidth(columns: AgentColumn[]): number {
  return columns.reduce((total, [, , width]) => total + width + 1, -1);
}

function agentColumns(contentWidth: number): AgentColumn[] {
  if (contentWidth >= 110) return [
    ["pod", "席位", 8, "left"], ["seat", "席位", 15, "left"], ["runtime", "运行时", 6, "left"],
    ["model", "模型", 12, "left"], ["context", "上下文", 8, "right"], ["status", "状态", 11, "left"],
    ["queue", "队列", 4, "right"], ["work", "工作", 15, "left"], ["now", "现在", Math.max(7, contentWidth - 103), "left"],
    ["actions", "动作", 15, "left"],
  ];
  if (contentWidth >= 88) return [
    ["pod", "席位", 5, "left"], ["seat", "席位", 8, "left"], ["runtime", "运行时", 6, "left"],
    ["model", "模型", 8, "left"], ["context", "上下文", 6, "right"], ["status", "状态", 8, "left"],
    ["queue", "队列", 4, "right"], ["work", "工作", 8, "left"], ["now", "现在", Math.max(11, contentWidth - 77), "left"],
    ["actions", "动作", 15, "left"],
  ];
  // 在 84x28 下，L2 内容窗格宽 58 个单元格。明确延后的三列（MODEL/NOW/ACTIONS）移入详情；
  // 身份、状态和工作仍保留。
  const fixed = 6 + 12 + 6 + 6 + 9 + 4 + 6; // widths + separators, excluding WORK
  return [
    ["pod", "席位", 6, "left"], ["seat", "席位", 12, "left"], ["runtime", "运行时", 6, "left"],
    ["context", "上下文", 6, "right"], ["status", "状态", 9, "left"], ["queue", "队列", 4, "right"],
    ["work", "工作", Math.max(4, contentWidth - fixed), "left"],
  ];
}

function instanceAgentColumns(contentWidth: number): AgentColumn[] {
  if (contentWidth >= 110) return [
    ["rig", "工作组", 13, "left"], ["pod", "席位", 8, "left"], ["seat", "席位", 14, "left"],
    ["runtime", "运行时", 6, "left"], ["context", "上下文", 8, "right"], ["status", "状态", 10, "left"],
    ["queue", "队列", 4, "right"], ["work", "工作", 12, "left"], ["now", "现在", Math.max(18, contentWidth - 84), "left"],
  ];
  if (contentWidth >= 78) return [
    ["rig", "工作组", 10, "left"], ["pod", "席位", 6, "left"], ["seat", "席位", 12, "left"],
    ["runtime", "运行时", 6, "left"], ["context", "上下文", 6, "right"], ["status", "状态", 9, "left"],
    ["queue", "队列", 4, "right"], ["work", "工作", Math.max(8, contentWidth - 58), "left"],
  ];
  const fixed = 10 + 6 + 12 + 6 + 6 + 9 + 4 + 6;
  return [
    ["rig", "工作组", 10, "left"], ["pod", "席位", 6, "left"], ["seat", "席位", 12, "left"],
    ["runtime", "运行时", 6, "left"], ["context", "上下文", 6, "right"], ["status", "状态", 9, "left"],
    ["queue", "队列", 4, "right"], ["work", "工作", Math.max(4, contentWidth - fixed), "left"],
  ];
}

function tableRow(columns: AgentColumn[], cells: Partial<Record<AgentColumnKey, string | number | null>>): string {
  return columns.map(([key, , width, align]) => align === "right" ? padLeft(cells[key], width) : pad(cells[key], width)).join(" ");
}

function runtimeShort(runtime: string): string {
  if (/claude/i.test(runtime)) return "cl";
  if (/codex/i.test(runtime)) return "cx";
  if (/terminal/i.test(runtime)) return ">_";
  if (/human/i.test(runtime)) return "hu";
  return runtime.slice(0, 2) || "—";
}

/** 表格针对扫视宽度优化；详情保留规范模型 ID。 */
function tableModel(model: string | null | undefined): string {
  return model?.replace(/^claude-/i, "") || "—";
}

function contextCompact(value: number | null, narrow: boolean): string {
  if (value == null) return "—";
  if (narrow) return `${value}%`;
  const filled = Math.max(0, Math.min(3, Math.round(value / 33.4)));
  return `${value}%${"▪".repeat(filled)}${"▫".repeat(3 - filled)}`;
}

function seatName(pod: string, name: string): string {
  for (const prefix of [`${pod}.`, `${pod}-`]) if (name.startsWith(prefix)) return name.slice(prefix.length);
  return name;
}

function operationalStateLabel(status: string | null | undefined): string {
  const key = (status ?? "").toLowerCase().replaceAll("_", "-");
  if (key === "active" || key === "working" || key === "running") return "工作中";
  if (key === "attention-required" || key === "needs-attention" || key === "needs-input") return "需要你";
  if (key === "blocked") return "被阻塞";
  if (key === "failed" || key === "down") return "失败";
  if (key === "idle") return "空闲";
  if (key === "detached" || key === "stopped") return "已分离";
  return "未知";
}

function operationalState(status: string, motion: MotionCtx): { mark: string; word: string } {
  const key = status.toLowerCase().replaceAll("_", "-");
  if (key === "active" || key === "working" || key === "running") {
    if (!motion.reduced) motion.used = true;
    return { mark: motion.reduced ? "●" : motion.frame, word: operationalStateLabel(status) };
  }
  if (key === "attention-required" || key === "needs-attention" || key === "needs-input")
    return { mark: "◐", word: operationalStateLabel(status) };
  if (key === "blocked") return { mark: "⚑", word: operationalStateLabel(status) };
  if (key === "failed" || key === "down") return { mark: "✕", word: operationalStateLabel(status) };
  if (key === "idle") return { mark: "·", word: operationalStateLabel(status) };
  if (key === "detached" || key === "stopped") return { mark: "○", word: operationalStateLabel(status) };
  return { mark: "?", word: operationalStateLabel(status) };
}

/** 工作组生命周期只在展示层翻译；服务端枚举值保持原样。 */
function lifecycleLabel(value: string | null | undefined): string {
  return { running: "运行中", recoverable: "可恢复", stopped: "已停止", archived: "已归档" }[value ?? ""] ?? value ?? "未知";
}

function queueFacts(snap: FleetSnapshot, session: string | null | undefined): { count: number; work: string; now: string } {
  if (!session) return { count: 0, work: "—", now: "—" };
  const sources: Array<["needs you" | "blocked" | "working" | "queued", FleetSnapshot["attention"]]> = [
    ["needs you", snap.attention], ["blocked", snap.blocked], ["working", snap.inProgress], ["queued", snap.pending],
  ];
  const rows: Array<{ role: string; row: FleetSnapshot["attention"][number] }> = [];
  const seen = new Set<string>();
  for (const [role, items] of sources) for (const row of items) {
    if (row.destinationSession !== session || seen.has(row.qitemId)) continue;
    seen.add(row.qitemId);
    rows.push({ role, row });
  }
  const primary = rows[0];
  if (!primary) return { count: 0, work: "—", now: "—" };
  const slice = primary.row.tags?.find((tag) => tag.startsWith("slice:"))?.slice("slice:".length);
  const work = slice?.match(/^OPR(?:\.\d+){3}\.(\d+)$/)?.[1]
    ? `S${slice.slice(slice.lastIndexOf(".") + 1)}`
    : slice ?? "—";
  const summary = primary.row.summary?.trim() || primary.row.body.split("\n").find((line) => line.trim())?.trim() || primary.row.qitemId;
  const queueRole = { "needs you": "需要你", blocked: "已阻塞", queued: "已排队" }[primary.role] ?? primary.role;
  const now = primary.role === "working" ? summary : `${queueRole} · ${summary}`;
  return { count: rows.length, work, now };
}

function number(value: number | null | undefined): string {
  return value == null ? "—" : value.toLocaleString("en-US");
}

function queueStateLabel(value: string): string {
  return { pending: "待处理", "in-progress": "进行中", blocked: "已阻塞", done: "已完成", "handed-off": "已交接" }[value] ?? value;
}

function wrapDetailValue(label: string, value: string, width: number): ContentLine[] {
  const prefix = `  ${padEndW(`${label}:`, LABEL_W)} `;
  const continuation = " ".repeat(strWidth(prefix));
  const room = Math.max(8, width - strWidth(prefix));
  const words = value.trim().split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  let line = "";
  for (const raw of words) {
    let word = raw;
    while (strWidth(word) > room) {
      if (line) { chunks.push(line); line = ""; }
      const clipped = clipW(word, room + 1);
      const chunk = clipped.endsWith("…") ? clipped.slice(0, -1) : clipped;
      chunks.push(chunk);
      word = word.slice(chunk.length);
    }
    if (!word) continue;
    if (!line) line = word;
    else if (strWidth(line) + strWidth(word) + 1 <= room) line += ` ${word}`;
    else { chunks.push(line); line = word; }
  }
  if (line) chunks.push(line);
  return (chunks.length ? chunks : [""]).map((chunk, index) => ({ text: `${index === 0 ? prefix : continuation}${chunk}` }));
}

function rowsForAgent(snap: FleetSnapshot, session: string, sources: Array<FleetSnapshot["attention"]>): FleetSnapshot["attention"] {
  const rows: FleetSnapshot["attention"] = [];
  const seen = new Set<string>();
  for (const source of sources) for (const row of source) {
    if (row.destinationSession !== session || seen.has(row.qitemId)) continue;
    seen.add(row.qitemId);
    rows.push(row);
  }
  return rows;
}

function workRows(rows: FleetSnapshot["attention"], width: number): ContentLine[] {
  if (rows.length === 0) return [fieldLine({ label: "行", value: "已服务有界列表中无项" })];
  return rows.flatMap((row) => {
    const summary = row.summary?.trim() || row.body.split("\n").find((line) => line.trim())?.trim() || "未服务摘要";
    return [
      ...wrapDetailValue("队列项", `${row.qitemId} · ${queueStateLabel(row.state)}`, width),
      ...wrapDetailValue("工作", summary, width),
      ...(row.blockedOn ? wrapDetailValue("阻塞者", `被 ${row.blockedOn} 阻塞`, width) : []),
    ];
  });
}

function agentDetailLines(
  snap: FleetSnapshot,
  found: NonNullable<ReturnType<typeof findAgent>>,
  contentWidth: number,
  timeZone = DEFAULT_TIME_ZONE,
): ContentLine[] {
  const { agent, rig, pod } = found;
  const session = agent.session;
  const specInLibrary = !!agent.spec && !!findSpec(snap, agent.spec);
  const currentRows = session ? rowsForAgent(snap, session, [snap.attention, snap.blocked, snap.inProgress]) : [];
  const pendingRows = session ? rowsForAgent(snap, session, [snap.pending]) : [];
  const recentRows = session ? rowsForAgent(snap, session, [snap.recentlyFinished]) : [];
  const needs = session ? snap.needs.filter((item) => item.target === session) : [];
  const visibleAssigned = currentRows.length + pendingRows.length;
  const assigned = agent.assignedWorkCount ?? visibleAssigned;
  const pending = agent.pendingWorkCount ?? pendingRows.length;
  const inProgress = agent.inProgressWorkCount ?? currentRows.filter((row) => row.state === "in-progress").length;
  const blocked = agent.blockedWorkCount ?? currentRows.filter((row) => row.state === "blocked").length;
  const context = agent.context;
  const meterWidth = Math.max(10, Math.min(36, contentWidth - 24));
  const rtName = agent.runtime ?? "未知";
  const rtSegs = [
    { text: "  " },
    { text: "运行时:", token: "dim" as const },
    { text: " ".repeat(Math.max(1, LABEL_W - strWidth("运行时:") + 1)) },
    { text: rtName },
    { text: "  " },
    ...runtimeMarkSegs(agent.runtime),
  ];
  const runtimeLine: ContentLine = { text: rtSegs.map((segment) => segment.text).join(""), segs: rtSegs };
  const activityReason = agent.activity?.needsInput?.reason ?? agent.activity?.signalReason ?? null;
  const needsRows = needs.length > 0
    ? needs.flatMap((item) => [
      ...wrapDetailValue("队列项", item.qitemId ?? "未服务可操作队列项 id", contentWidth),
      ...wrapDetailValue("原因", item.detail, contentWidth),
      ...(item.unblocks ? wrapDetailValue("动作", `解除 ${item.unblocks} 阻塞`, contentWidth) : []),
      ...(item.evidenceRef ? wrapDetailValue("证据", item.evidenceRef, contentWidth) : []),
    ])
    : agent.activity?.needsInput && agent.activity.needsInput.count > 0
      ? wrapDetailValue("原因", agent.activity.needsInput.reason ?? "需要输入；未服务原因", contentWidth)
      : [fieldLine({ label: "状态", value: "已服务投影上无项" })];

  return [
    ...detailPage({ text: `智能体 ${agent.name} · ${operationalStateLabel(agent.status)}` }, [
      {
        title: `上下文 · ${context == null ? "未知" : `${context}%`}`,
        lines: [
          fieldLine({ label: "仪表", value: context == null ? "— (尚未知)" : `${context}% 已用  ${barCells(context / 100, meterWidth)}` }),
          fieldLine({ label: "令牌", value: `${number(agent.totalInputTokens)} 输入 · ${number(agent.totalOutputTokens)} 输出 · ${number(agent.contextWindowSize)} 窗口` }),
          runtimeLine,
          ...(agent.attach ? [fieldLine({ label: "附加", value: agent.attach })] : []),
          fieldLine({ label: "终端", value: `终端 ▸ 席位 ${pod.name}`, link: { type: "act", act: "open-terminal", view: `pod:${rig.name}/${pod.name}` } }),
        ],
      },
      {
        title: "当前活动",
        fields: [
          { label: "活动", value: operationalStateLabel(agent.activity?.activity ?? agent.status) },
          ...(activityReason ? [{ label: "原因", value: activityReason }] : []),
          ...(agent.activity?.decidedBy ? [{ label: "决定者", value: agent.activity.decidedBy }] : []),
          ...(agent.activity?.signalSource || agent.activity?.signalReason ? [{ label: "信号", value: `${agent.activity.signalSource ?? "未知"} · ${agent.activity.signalReason ?? "无原因"}` }] : []),
          ...(agent.activity?.eventAt ? [{ label: "变更", value: displayTime(agent.activity.eventAt, timeZone) }] : []),
        ],
      },
      {
        title: "健康",
        lines: healthAgentLines(snap, {
          kind: "seat",
          rigId: rig.id ?? rig.name,
          seatId: agent.nodeId ?? null,
          seatName: agent.name,
          local: found.host === snap.hosts[0],
        }, contentWidth),
      },
      { title: `当前工作 · ${currentRows.length}`, lines: workRows(currentRows, contentWidth) },
      {
        title: "队列",
        lines: [
          ...wrapDetailValue("深度", `${assigned} 已分配 · ${pending} 待处理 · ${inProgress} 进行中 · ${blocked} 已阻塞`, contentWidth),
          ...(agent.assignedWorkCount == null ? wrapDetailValue("基础", `${visibleAssigned} 行在有界列表读取中可见；完整计数未服务`, contentWidth) : []),
        ],
      },
      { title: `下一个 · ${pending}`, lines: workRows(pendingRows, contentWidth) },
      { title: `需要你 · ${needs.length || agent.activity?.needsInput?.count || 0}`, lines: needsRows },
      ...(recentRows.length ? [{ title: "刚完成 · 有界窗口", lines: workRows(recentRows, contentWidth) }] : []),
      {
        title: "席位",
        fields: [
          { label: "主机", value: found.host.name },
          { label: "工作组", value: rig.name },
          { label: "席位", value: pod.name },
        ],
        lines: [
          fieldLine({ label: "工作目录", value: agent.cwd ?? "— (未服务)" }),
        ],
      },
      {
        title: "规范 · 有效席位绑定",
        fields: [specInLibrary
          ? { label: "规范", value: agent.spec, link: { type: "cross", kind: "spec-of", name: agent.name, target: { host: found.host.name, rig: rig.name, pod: pod.name } } }
          : { label: "规范", value: agent.spec ? `${agent.spec}  (不在库中)` : "—" }],
        lines: [
          ...wrapDetailValue("配置", agent.profile ?? "未服务", contentWidth),
          ...wrapDetailValue("版本", agent.specVersion ?? "未服务", contentWidth),
          ...wrapDetailValue("源哈希", agent.specHash ?? "未服务", contentWidth),
          ...wrapDetailValue("基础", "已服务席位绑定；撰写库自启动以来可能已变更。", contentWidth),
        ],
      },
    ]),
  ];
}

function tabsLine(state: ViewState, suffix: string): ContentLine[] {
  // 每个拓扑标签是自己的点击区（第一区从
  // 内容列 0 开始，保留焦点标记底线）；`tab graph` =
  // 拓扑图视图（frame-01 hatchet 主线）
  const labels: Array<[Extract<ViewState["viewTab"], "table" | "recent" | "overview" | "graph" | "health">, string]> = [
    ["table", state.viewTab === "table" ? "[ 表格 ]" : "  表格  "],
    ["recent", state.viewTab === "recent" ? "[ 近期 ]" : "  近期  "],
    ["overview", state.viewTab === "overview" ? "[ 概览 ]" : "  概览  "],
    ["graph", state.viewTab === "graph" ? "[ 图 ]" : "  图  "],
    ["health", state.viewTab === "health" ? "[ 健康 ]" : "  健康  "],
  ];
  const text = `${labels.map(([, label]) => label).join("")}   ${suffix}`;
  const zones: ContentLine["zones"] = [];
  let at = 0;
  for (const [tab, label] of labels) {
    zones.push({ start: at, end: at + strWidth(label), action: { type: "tab", tab } });
    at += strWidth(label);
  }
  return [{ text, zones }];
}

function queueRows(snap: FleetSnapshot): FleetSnapshot["attention"] {
  return [...snap.attention, ...snap.blocked, ...snap.inProgress, ...snap.pending, ...snap.recentlyFinished];
}

function recentWorkText(snap: FleetSnapshot, row: RecentTransitionSnap): string {
  const qitem = queueRows(snap).find((candidate) => candidate.qitemId === row.qitemId);
  const work = qitem?.summary?.trim() || qitem?.body.split("\n").find((line) => line.trim())?.trim();
  return row.summary?.trim() || work || "未服务工作";
}

function agentDrillForSession(snap: FleetSnapshot, session: string): Action | undefined {
  const found = findAgentBySession(snap, session);
  return found
    ? { type: "drill", resource: "agent", name: found.agent.name, target: { host: found.host.name, rig: found.rig.name, pod: found.pod.name } }
    : undefined;
}

function recentTargetAction(snap: FleetSnapshot, row: RecentTransitionSnap): Action | undefined {
  if (row.targetKind === "mission") {
    if (snap.scopes?.some((mission) => mission.mission === row.target))
      return { type: "scopes-mission-open", mission: row.target };
  }
  if (row.targetKind === "slice") {
    for (const mission of snap.scopes ?? []) {
      const slice = mission.slices.find((candidate) => candidate.id === row.target || candidate.dirName === row.target);
      if (slice) return { type: "scopes-open", mission: mission.mission, slice: slice.dirName };
    }
  }
  const qitem = queueRows(snap).find((candidate) => candidate.qitemId === row.qitemId || candidate.qitemId === row.target);
  return (qitem ? agentDrillForSession(snap, qitem.destinationSession) : undefined)
    ?? agentDrillForSession(snap, row.actorSession)
    ?? (row.rig && snap.hosts.some((host) => host.rigs.some((rig) => rig.name === row.rig))
      ? { type: "drill", resource: "rig", name: row.rig }
      : undefined);
}

type RecentScope = { kind: "instance" } | { kind: "rig"; rig: string };

function recentScopeMatches(snap: FleetSnapshot, scope: RecentScope): boolean {
  const served = snap.recentTransitionsScope
    ?? (snap.recentTransitionsRig ? { kind: "rig" as const, rig: snap.recentTransitionsRig } : null);
  if (!served || served.kind !== scope.kind) return false;
  return scope.kind === "instance" || (served.kind === "rig" && served.rig === scope.rig);
}

function recentLines(snap: FleetSnapshot, scope: RecentScope, width: number, expanded: boolean, timeZone: string): ContentLine[] {
  if (!recentScopeMatches(snap, scope) || snap.recentTransitions == null) return [];
  const rows = expanded ? snap.recentTransitions : snap.recentTransitions.slice(-5);
  const lines: ContentLine[] = [
    ...(expanded ? [] : [{ text: "" }]),
    sectionRule(`近期 · ${scope.kind === "instance" ? "实例" : `工作组 ${scope.rig}`}`, width),
    { text: "  已记录队列变更 · 旧到新 · 回车检查" },
  ];
  if (rows.length === 0) return [...lines, { text: "  当前窗口中无已记录变更。" }];
  for (const row of rows) {
    lines.push(listItem(`${displayTime(row.ts, timeZone)} · #${row.transitionId}`, { type: "recent-open", transitionId: row.transitionId }),
      { text: `    ${row.actorSession || "未知执行者"} · ${row.change || "未知变更"}` },
      { text: `    ${recentWorkText(snap, row)}` },
      { text: `    ${row.targetKind}: ${row.target}${scope.kind === "instance" ? ` · 工作组 ${row.rig ?? "未知"}` : ""}` },
      { text: "" });
  }
  return wrapDetailLines(lines, width);
}

function recentDetailLines(state: ViewState, snap: FleetSnapshot, width: number): ContentLine[] {
  const row = state.recentOpen!;
  const target = recentTargetAction(snap, row);
  return wrapDetailLines([
    { text: `近期事件 #${row.transitionId} · Esc 返回` },
    fieldLine({ label: "时间", value: displayTime(row.ts, state.timeZone) }),
    fieldLine({ label: "执行者", value: row.actorSession || "未知" }),
    fieldLine({ label: "变更", value: row.change || "未知" }),
    fieldLine({ label: "工作", value: recentWorkText(snap, row) }),
    fieldLine({ label: "目标", value: `${row.targetKind}: ${row.target}` }),
    fieldLine({ label: "工作组", value: row.rig ?? "未服务" }),
    fieldLine({ label: "队列项", value: row.qitemId }),
    fieldLine({ label: "原始时间", value: row.ts }),
    { text: "  这是已记录的变更，不是对其结果的独立检查。" },
    ...(target ? [listItem("相关工作 / 所有者", target)] : [{ text: "  相关工作在当前快照之外。" }]),
    listItem("返回 · Esc", { type: "back" }),
  ], width);
}

function timeZoneLines(state: ViewState, width: number): ContentLine[] {
  return wrapDetailLines([
    { text: "本地时间 · 显示设置" },
    fieldLine({ label: "时区", value: state.timeZone }),
    ...(state.timeZoneWarning ? [{ text: `  ${state.timeZoneWarning}` }] : []),
    { text: "  绝对时间包含日期和时区。夏令时跟随命名时区。经过时间保持相对；源时间戳不变。" },
    { text: "" },
    { text: "  从 shell 更改持久设置，然后重新打开此 TUI：" },
    { text: "  zrig config set ui.timezone Europe/London" },
    { text: "  zrig config reset ui.timezone" },
    { text: "  zrig config get ui.timezone --show-source" },
    { text: "  默认: America/Los_Angeles. OPENRIG_UI_TIMEZONE 覆盖此 TUI 实例的文件设置。" },
    listItem("返回 · Esc", { type: "back" }),
  ], width);
}

function specTabsLine(state: ViewState): ContentLine {
  const active = state.viewTab === "topology" || state.viewTab === "yaml" ? state.viewTab : "configuration";
  const labels = ["topology", "configuration", "yaml"] as const;
  const visible = { topology: "拓扑", configuration: "配置", yaml: "YAML" } as const;
  const parts = labels.map((tab) => (tab === active ? `[ ${visible[tab]} ]` : `  ${visible[tab]}  `));
  const text = parts.join(" " );
  return {
    text,
    zones: labels.map((tab, index) => {
      const label = parts[index]!;
      const start = text.indexOf(label);
      const displayStart = strWidth(text.slice(0, start));
      return { start: displayStart, end: displayStart + strWidth(label), action: { type: "tab", tab } };
    }),
  };
}

function needsLine(prefix: string, item: NeedsItem, snap: FleetSnapshot): ContentLine {
  // 对齐列以提升扫视速度：类型、主机、目标、详情；每行的同类事实都位于相同视觉位置。
  const found = findAgentBySession(snap, item.target, item.hostId);
  const cols = alignedRow([
    [item.kind, 16],
    [item.hostId ? `[${item.hostId}]` : "", 11],
    [item.target, 34],
  ]);
  return {
    text: `${prefix}${cols} ${item.detail}${found ? "  (打开 ▸)" : ""}`,
    ...(found ? { action: { type: "drill", resource: "agent", name: found.agent.name, target: { host: found.host.name, rig: found.rig.name, pod: found.pod.name } } as const } : {}),
  };
}

function sourceProvenance(spec: FleetSnapshot["specs"][number]): string {
  if (spec.sourceType === "builtin") return "内置库";
  if (spec.sourceType === "user_file") return "用户库";
  return spec.sourceState === "library_item" ? "库" : "源未知";
}

function specSourceLines(spec: FleetSnapshot["specs"][number], snap: FleetSnapshot): ContentLine[] {
  if (!spec.sourcePath) return [{ text: "源路径不可用；无当前文件声明。" }];
  const target = fileTargetForPath(spec.resolvedSourcePath ?? spec.sourcePath, snap.fileRoots ?? []) ?? { root: "", path: spec.sourcePath };
  const lines = [fieldLine({ label: "源", value: `${displayPath(spec.sourcePath, 56)} · ${sourceProvenance(spec)}` }), listItem("查看当前源", { type: "file-open", target })];
  if (!target.root) lines.push({ text: "源未映射到配置的可读根。" });
  if (target.root) {
    lines.push({ text: `可读根: ${target.root}` }, ...referenceLines(spec.description ?? "", target));
    const markdownLinks = new Set([...((spec.description ?? "").matchAll(/\[[^\]\n]+\]\(<?([^\s)>]+)/g))].map((match) => match[1]));
    // 散文路径保持相对于命名源，而非推断检出。
    for (const match of (spec.description ?? "").matchAll(/(?:[\w.-]+\/)+[\w.-]+\.(?:md|txt|ya?ml)(?:#[\w-]+)?/g)) {
      if (markdownLinks.has(match[0])) continue;
      lines.push(listItem(`引用: ${match[0]} · 相对于源`, referenceAction(target, match[0])));
    }
  }
  return lines;
}

function displayPath(path: string, max = 68): string {
  if (path.length <= max) return path;
  const parts = path.split("/").filter(Boolean);
  const kept: string[] = [];
  while (parts.length > 0) {
    const candidate = [parts.at(-1)!, ...kept];
    if (`…/${candidate.join("/")}`.length > max) break;
    kept.unshift(parts.pop()!);
  }
  return `…/${kept.join("/")}`;
}

function wrappedList(prefix: string, values: string[], max = 84): ContentLine[] {
  if (values.length === 0) return [{ text: `${prefix}(无)` }];
  const lines: ContentLine[] = [];
  const indent = " ".repeat(prefix.length);
  let current = prefix;
  for (const value of values) {
    const addition = `${current === prefix ? "" : ", "}${value}`;
    if (current !== prefix && current.length + addition.length > max) {
      lines.push({ text: current });
      current = `${indent}${value}`;
    } else {
      current += addition;
    }
  }
  lines.push({ text: current });
  return lines;
}

/** 值列表在值列处换行的字段行，保持标签节奏。 */
function fieldWrapped(label: string, values: string[]): ContentLine[] {
  if (values.length === 0) return [fieldLine({ label, value: "(无)" })];
  const valueCol = 2 + 12 + 1; // indent + LABEL_W + gap — where field values start
  const wrapped = wrappedList(" ".repeat(valueCol), values, 92);
  const first = wrapped[0]!.text.slice(valueCol);
  return [fieldLine({ label, value: first }), ...wrapped.slice(1)];
}

/** S19 第 5 轮（守卫）：本次渲染的加载旋转帧，以及供入口循环判断该帧由时间驱动、必须继续重绘的
 * 使用标志。`loading` 是刷新所有者的显式生命周期，也是旋转器唯一可依附的状态；已结算的缺席
 *（已证明为空或具名读取失败）渲染静态如实文本，绝不虚构等待中声明。 */
interface MotionCtx {
  frame: string;
  reduced: boolean;
  used: boolean;
  loading: boolean;
}

function instanceContentLines(
  state: ViewState,
  snap: FleetSnapshot,
  host: FleetSnapshot["hosts"][number],
  contentWidth: number,
  motion: MotionCtx,
): ContentLine[] {
  const lines = tabsLine(state, `实例 ${host.name}`);
  const scope = { kind: "instance", local: host === snap.hosts[0] } as const;
  if (state.viewTab === "health") return [...lines, { text: "" }, ...healthListLines(snap, scope, contentWidth)];
  if (state.viewTab === "recent") {
    const recent = recentLines(snap, scope, contentWidth, true, state.timeZone);
    return recent.length > 0
      ? [...lines, ...recent]
      : [...lines, { text: "" }, { text: motion.loading ? `${motion.frame} 实例近期读取挂起` : "(实例近期窗口未服务)" }];
  }
  if (state.viewTab === "overview") {
    return [
      ...lines,
      ...detailPage({ text: `instance ${host.name}` }, [
        {
          title: "实例",
          fields: [
            { label: "标识", value: host.name },
            { label: "传输", value: host.id ?? "本地" },
            { label: "形态", value: host.rigs.some(r => r.inventoryUnavailable) ? `${host.rigs.length} 个工作组 · 席位清单不完整` : `${host.rigs.length} 个工作组 · ${host.rigs.reduce((n, rig) => n + rig.pods.reduce((m, pod) => m + pod.agents.length, 0), 0)} 个席位` },
          ],
        },
        {
          title: "工作组",
          lines: host.rigs.length > 0
            ? host.rigs.map((rig) => listItem(
                alignedRow([[rig.name, 20], [lifecycleLabel(rig.lifecycleState), 20], [rig.inventoryUnavailable ? "清单不可用" : `${rig.pods.length} 个席位 · ${rig.pods.reduce((n, pod) => n + pod.agents.length, 0)} 个席位`, 24]]),
                { type: "drill", resource: "rig", name: rig.name, target: { host: host.name } },
              ))
            : [{ text: "  (未服务本地工作组 — 已证明为空)" }],
        },
      ]),
    ];
  }
  if (state.viewTab === "graph") {
    for (const rig of host.rigs) {
      lines.push({ text: "" }, sectionRule(`工作组 ${rig.name} · ${lifecycleLabel(rig.lifecycleState)}`, contentWidth));
      if (!rig.graph) {
        if (motion.loading) {
          if (!motion.reduced) motion.used = true;
          lines.push({ text: `  ${motion.frame} 拓扑图读取挂起` });
        } else if (snap.readErrors.some((error) => error.startsWith(`graph(${rig.name})`))) {
          lines.push({ text: "  ✕ 拓扑图读取失败 — 已在状态行命名" });
        } else {
          lines.push({ text: "  (未服务拓扑图)" });
        }
        continue;
      }
      const canvas = renderGraphStyle(state.graphStyle, rig.graph, { host: host.name, rig: rig.name, selected: null }, contentWidth);
      const plain = canvas.plainLines();
      const segs = canvas.segLines();
      for (let row = 0; row < plain.length; row++) lines.push({
        text: plain[row]!,
        segs: segs[row]!,
        zones: canvas.zones.filter((zone) => zone.y === row).map((zone) => ({ start: zone.start, end: zone.end, action: zone.action })),
      });
    }
    if (host.rigs.length === 0) lines.push({ text: "" }, { text: "  (未服务本地工作组 — 已证明为空)" });
    lines.push({ text: "" }, { text: `  样式: ${state.graphStyle} · style hatchet|braille|braille-fallback 走命令栏` });
    return lines;
  }

  lines.push(healthSummaryLine(snap, scope, contentWidth));
  lines.push({ text: state.filter ? `/ 过滤实例行: ${state.filter} · / 替换 · Esc 清除` : "/ 过滤实例行…" });
  const columns = instanceAgentColumns(contentWidth);
  lines.push({ text: tableRow(columns, { rig: "工作组", pod: "席位", seat: "席位", runtime: "运行时", context: "上下文", status: "状态", queue: "队列", work: "工作", now: "现在" }) });
  lines.push({ text: "━".repeat(columnsWidth(columns)) });
  let seatCount = 0;
  let workingCount = 0;
  let attentionCount = 0;
  let openCount = 0;
  for (const rig of host.rigs) {
    const agents = rig.pods.flatMap((pod) => pod.agents.map((agent) => ({ pod: pod.name, agent })))
      .filter(({ pod, agent }) => !state.filter || rig.name.includes(state.filter) || pod.includes(state.filter) || agent.name.includes(state.filter));
    if (state.filter && agents.length === 0 && !rig.name.includes(state.filter)) continue;
    const rigAction: Action = { type: "drill", resource: "rig", name: rig.name, target: { host: host.name } };
    if (agents.length === 0) {
      lines.push({
        text: tableRow(columns, { rig: rig.name, pod: "—", seat: rig.inventoryUnavailable ? "(读取失败)" : "(无席位)", status: lifecycleLabel(rig.lifecycleState) }),
        action: rigAction,
      });
      continue;
    }
    let previousPod: string | null = null;
    for (const { pod, agent } of agents) {
      const firstInPod = pod !== previousPod;
      if (firstInPod && previousPod != null) lines.push({ text: "┈".repeat(columnsWidth(columns)) });
      previousPod = pod;
      const stateCell = operationalState(agent.status, motion);
      const queue = queueFacts(snap, agent.session);
      seatCount += 1;
      if (["active", "working", "running"].includes(agent.status)) workingCount += 1;
      if (/attention|needs|blocked|unknown|failed/.test(agent.status)) attentionCount += 1;
      openCount += queue.count;
      lines.push({
        text: tableRow(columns, {
          rig: rig.name,
          pod: firstInPod ? pod : "",
          seat: `${stateCell.mark} ${seatName(pod, agent.name)}`,
          runtime: runtimeShort(agent.runtime),
          context: contextCompact(agent.context, contentWidth < 110),
          status: stateCell.word,
          queue: queue.count || "·",
          work: queue.work,
          now: queue.now,
        }),
        action: { type: "drill", resource: "agent", name: agent.name, target: { host: host.name, rig: rig.name, pod } },
        zones: [{ start: 0, end: columns[0]![2], action: rigAction }],
      });
    }
  }
  lines.push({ text: "" }, { text: host.rigs.some(r => r.inventoryUnavailable) ? `${host.rigs.length} 个工作组 · 清单不完整 · ${seatCount} 个席位已读` : `${host.rigs.length} 个工作组 · ${seatCount} 个席位 · ${workingCount} 工作中 · ${attentionCount} 需要关注 · ${openCount} 行打开` });
  lines.push(...recentLines(snap, scope, contentWidth, false, state.timeZone));
  return lines;
}

function contentLines(state: ViewState, snap: FleetSnapshot, contentWidth: number, motion: MotionCtx): ContentLine[] {
  if (state.file) {
    const read = JSON.stringify(snap.fileRead?.target) === JSON.stringify(state.file) ? snap.fileRead?.result : null;
    return [...(state.project ? wrapDetailLines([{ text: `项目 ${state.project.id} · ${state.project.root}` }], contentWidth) : []), ...fileLines(read, state.file, contentWidth)];
  }
  if (state.externalUrl) return externalLines(state.externalUrl, contentWidth);
  const contentWidthForGraph = contentWidth;
  void contentWidthForGraph;
  const lines: ContentLine[] = [];
  if (state.timeZoneHelp) return timeZoneLines(state, contentWidth);
  if (state.recentOpen) return recentDetailLines(state, snap, contentWidth);
  if (state.section === "terminals") return terminalLines(state, snap, contentWidth);
  if (state.section === "config") return configLines(state, snap, contentWidth);
  if (state.section === "connections") return connectionsLines(snap, contentWidth, state.timeZone, state.expanded);
  if (state.healthOpen) return healthDetailLines(snap, state.healthOpen, contentWidth, state.timeZone);
  if (state.section === "system") return [{ text: "系统 · 实例健康" }, { text: "" }, ...healthListLines(snap, { kind: "instance", local: true }, contentWidth)];
  // PULSE 是全宽视图，由 renderScreen 中的提前返回处理
  //（renderPulseScreen）——它绝不到达下方的侧栏+内容布局。
  if (state.section === "topology") {
    if (state.runningOf) {
      const seats = agentsRunningSpecTargets(snap, state.runningOf);
      return detailPage({ text: `运行规范 ${state.runningOf} 的席位` }, [
        {
          lines:
            seats.length === 0
              ? [{ text: "  (当前无席位运行它)" }]
              : seats.map((seat) =>
                  listItem(`${seat.agent.name}  ·  ${seat.rig.name} / ${seat.pod.name}  ·  ${seat.agent.status}`, {
                    type: "drill",
                    resource: "agent",
                    name: seat.agent.name,
                    target: { host: seat.host.name, rig: seat.rig.name, pod: seat.pod.name },
                  }),
                ),
        },
      ]);
    }
    const leaf = state.drill.at(-1);
    if (leaf?.kind === "agent") {
      const hostName = state.drill.find((part) => part.kind === "host")?.name;
      const rigName = state.drill.find((part) => part.kind === "rig")?.name;
      const podName = state.drill.find((part) => part.kind === "pod")?.name;
      const found = hostName ? findAgent(snap, leaf.name, { host: hostName, rig: rigName, pod: podName }) : findAgent(snap, leaf.name);
      if (!found) return [{ text: `智能体 "${leaf.name}" 不在当前快照中` }];
      return agentDetailLines(snap, found, contentWidth, state.timeZone);
    }
    const hostName = state.drill.find((d) => d.kind === "host")?.name;
    const host = (hostName ? snap.hosts.find((candidate) => candidate.name === hostName) : snap.hosts[0]);
    if (leaf?.kind === "host" && host) return instanceContentLines(state, snap, host, contentWidth, motion);
    if (!leaf && host?.rigs.length) return wrapDetailLines([
      { text: `拓扑 · ${host.name}` }, { text: "选择一个工作组以读取其席位和工作。" },
      { text: `${host.rigs.length} 个工作组 · 在资源管理器中选择一个` },
      { text: "亮 ▦ 活跃智能体 · 灰 ▦ 无 · ? 未知" },
    ], contentWidth);
    const rigName = state.drill.find((d) => d.kind === "rig")?.name ;
    const rig = host?.rigs.find((candidate) => candidate.name === rigName);
    if (!rig || !host) {
      const notLoaded = snap.readErrors.find((error) => error.startsWith("实时数据未加载"));
      if (notLoaded) return [{ text: notLoaded }];
      // round-6（守卫）：根拓扑分支像其他读取表面一样消耗所有者的负载
      // 真相——真实在飞冷启动
      // 渲染旋转器；结算后仅命名工作组摘要
      // 失败或证明无工作组真相可渲染，绝不"等待"
      if (motion.loading) {
        if (!motion.reduced) motion.used = true;
        return [{ text: `${motion.frame} 拓扑读取挂起 — 等待后台服务工作组读取（诚实空，非伪造）` }];
      }
      if (snap.readErrors.some((e) => e.startsWith("rigs-summary"))) {
        return [{ text: "✕ 工作组读取失败 — 已在状态行命名（诚实空，非伪造）" }];
      }
      return [{ text: "(未服务工作组 — 已证明为空，非伪造)" }];
    }
    if (rig.inventoryNotLoaded) return [{ text: `正在读取 ${rig.name}…` }];
    if (rig.inventoryUnavailable) return [{ text: `${rig.name} 的清单不可用 · 刷新以重试` }];
    const podFilter = leaf?.kind === "pod" ? leaf.name : null;
    const all = rig.pods.flatMap((p) => p.agents.map((a) => ({ pod: p.name, ...a })));
    const rows = all
      .filter((a) => !podFilter || a.pod === podFilter)
      .filter((a) => !state.filter || a.name.includes(state.filter) || a.pod.includes(state.filter));
    const suffix = `rig ${rig.name}${podFilter ? ` · pod ${podFilter}` : ""}${state.filter ? ` · filter "${state.filter}"` : ""}`;
    lines.push(...tabsLine(state, suffix));
    // OPR.0.6.0.8：将工作组的每个活跃席位打开为终端磁贴（Herdr：每标签 4×4）。
    if (!podFilter) lines.push(fieldLine({ label: "终端", value: `终端 ▸ 工作组 ${rig.name}`, link: { type: "act", act: "open-terminal", view: `rig:${rig.name}` } }));
    const healthScope = { kind: "rig" as const, rigId: rig.id ?? rig.name, rigName: rig.name, local: host === snap.hosts[0] };
    if (state.viewTab === "health") return [...lines, { text: "" }, ...healthListLines(snap, healthScope, contentWidth)];
    if (state.viewTab === "recent") {
      const recent = recentLines(snap, { kind: "rig", rig: rig.name }, contentWidth, true, state.timeZone);
      return recent.length > 0
        ? [...lines, ...recent]
        : [...lines, { text: "" }, { text: motion.loading ? `${motion.frame} 工作组近期读取挂起` : "(工作组近期窗口未服务)" }];
    }
    if (state.viewTab === "graph") {
      // slice-17 拓扑视图（frame-01）：工作组的已服务 /graph 投影
      // 由样式注册表渲染；读取应答前诚实空。
      if (!rig.graph) {
        lines.push({ text: "" });
        // round-5（守卫）：旋转器仅乘坐所有者的在飞状态；
        // 结算缺失渲染诚实静态真相 — 命名失败或
        // 证明空读取 — 绝不旋转
        if (motion.loading) {
          if (!motion.reduced) motion.used = true;
          lines.push({ text: `  ${motion.frame} 拓扑图读取挂起（诚实空，绝不伪造）` });
        } else if (snap.readErrors.some((e) => e.startsWith(`graph(${rig.name})`))) {
          lines.push({ text: "  ✕ 拓扑图读取失败 — 已在状态行命名（诚实空，绝不伪造）" });
        } else {
          lines.push({ text: "  (未服务拓扑图 — 诚实空，绝不伪造)" });
        }
        return lines;
      }
      // 逐视图放大（PM b7f95c4b）：进入 Pod 详情时，将同一投影限定到该 Pod 的包含子图。
      // 在工作组尺度被裁掉的节点会在此变得可见且可操作；可操作性始终取当前视图裁剪后的命中区事实，
      // 绝不是全局筛选。
      let graphView = rig.graph;
      if (podFilter) {
        const podGroup = rig.graph.nodes.find((n) => n.type === "podGroup" && (n.data.podNamespace ?? n.data.logicalId) === podFilter);
        const memberIds = new Set(rig.graph.nodes.filter((n) => n.parentId && n.parentId === podGroup?.id).map((n) => n.id));
        graphView = {
          nodes: rig.graph.nodes.filter((n) => n === podGroup || memberIds.has(n.id)),
          edges: rig.graph.edges.filter((e) => memberIds.has(e.source) && memberIds.has(e.target)),
        };
      }
      const canvas = renderGraphStyle(state.graphStyle, graphView, { host: host.name, rig: rig.name, selected: null }, contentWidth);
      const plain = canvas.plainLines();
      const segs = canvas.segLines();
      for (let row = 0; row < plain.length; row++) {
        lines.push({
          text: plain[row]!,
          segs: segs[row]!,
          zones: canvas.zones.filter((z) => z.y === row).map((z) => ({ start: z.start, end: z.end, action: z.action })),
        });
      }
      lines.push({ text: "" });
      lines.push({ text: `  样式: ${state.graphStyle} · style hatchet|braille|braille-fallback 走命令栏` });
      return lines;
    }
    lines.push(listItem("配置 · 实例设置", { type: "jump", section: "config" }));
    lines.push(healthSummaryLine(snap, healthScope, contentWidth));
    lines.push({ text: state.filter ? `/ 过滤智能体: ${state.filter} · / 替换 · Esc 清除` : "/ 过滤智能体…" });
    if (state.viewTab === "overview") {
      lines.push(
        ...detailPage({ text: `rig ${rig.name}` }, [
          {
            title: "工作组",
            fields: [
              { label: "主机", value: host.name },
              { label: "形态", value: `${rig.pods.length} 个席位 · ${all.length} 个智能体` },
              ...(rig.lifecycleState ? [{ label: "状态", value: lifecycleLabel(rig.lifecycleState) }] : []),
            ],
          },
          {
            title: "席位",
            lines: rig.pods.map((pod) =>
              listItem(
                alignedRow([[pod.name, 14], [`${pod.agents.length} 个智能体`, 10], [pod.agents.map((a) => a.status).filter((s, i, arr) => arr.indexOf(s) === i).join(" · "), 40]]),
                { type: "drill", resource: "pod", name: pod.name, target: { host: host.name, rig: rig.name } },
              ),
            ),
          },
        ]),
      );
      return lines;
    }
    const agentCols = agentColumns(contentWidth);
    const narrowFactory = !agentCols.some(([key]) => key === "model");
    if (narrowFactory) lines.push({ text: "模型/当前/动作 在钻取时（回车）" });
    lines.push({
      text: tableRow(agentCols, {
        pod: "席位", seat: "席位", runtime: "运行时", model: "模型", context: "上下文",
        status: "状态", queue: "队列", work: "工作", now: "现在", actions: "动作",
      }),
    });
    lines.push({ text: "━".repeat(columnsWidth(agentCols)) });
    const actionsIndex = agentCols.findIndex(([key]) => key === "actions");
    const actionsColStart = actionsIndex < 0 ? -1 : agentCols.slice(0, actionsIndex).reduce((n, [, , width]) => n + width + 1, 0);
    let previousPod: string | null = null;
    for (const a of rows) {
      const firstInPod = a.pod !== previousPod;
      if (firstInPod && previousPod != null && !narrowFactory) lines.push({ text: "┈".repeat(columnsWidth(agentCols)) });
      previousPod = a.pod;
      // 动作 = 仅驱动结构（BR-9），每个映射到现有
      // 写入契约：`运行 ▸` = 工作组恢复写入（仅在
      // 适用处渲染 — 席位未运行）；`终端 ▸` = 终端打开
      // 视图契约（席位范围，web 的粒度）。无虚假提示。
      const canRun = a.canRun ?? !a.live;
      const actionsCell = canRun ? "运行 ▸ · 终端 ▸" : "终端 ▸";
      const zones: ContentLine["zones"] = [];
      if (actionsColStart >= 0) {
        const termIndex = actionsCell.indexOf("终端 ▸");
        const termOffset = actionsColStart + strWidth(actionsCell.slice(0, termIndex));
        zones.push({ start: termOffset, end: termOffset + strWidth("终端 ▸"), action: { type: "act", act: "open-terminal", view: `pod:${rig.name}/${a.pod}` } });
      }
      if (canRun && actionsColStart >= 0)
        zones.push({
          start: actionsColStart,
          end: actionsColStart + strWidth("运行 ▸"),
          action: { type: "act", act: "run", rigId: rig.id ?? rig.name, agent: a.name },
        });
      const stateCell = operationalState(a.status, motion);
      const queue = queueFacts(snap, a.session);
      lines.push({
        // 整行是命中表面（非 testid 控件）：点击
        // 任何可见单元格打开智能体；动作区覆盖。
        text: tableRow(agentCols, {
          pod: firstInPod ? a.pod : "",
          seat: `${stateCell.mark} ${seatName(a.pod, a.name)}`,
          runtime: runtimeShort(a.runtime),
          model: tableModel(a.model),
          context: contextCompact(a.context, narrowFactory),
          status: stateCell.word,
          queue: queue.count || "·",
          work: queue.work,
          now: queue.now,
          actions: actionsCell,
        }),
        action: { type: "drill", resource: "agent", name: a.name, target: { host: host.name, rig: rig.name, pod: a.pod } },
        zones,
      });
    }
    lines.push({ text: "" });
    const working = rows.filter((agent) => ["active", "working", "running"].includes(agent.status)).length;
    const attention = rows.filter((agent) => /attention|needs|blocked|unknown|failed/.test(agent.status)).length;
    lines.push({ text: `${rows.length} 个席位 · ${working} 工作中 · ${attention} 需要关注 · ${rows.reduce((n, agent) => n + queueFacts(snap, agent.session).count, 0)} 行打开` });
    if (!podFilter) lines.push(...recentLines(snap, { kind: "rig", rig: rig.name }, contentWidth, false, state.timeZone));
    return lines;
  }
  if (state.section === "specs") {
    const leaf = state.drill.at(-1);
    if (leaf?.kind === "spec") {
      const spec = findSpec(snap, leaf.name);
      if (!spec) return [{ text: snap.readErrors.find((error) => error.startsWith("specs-library")) ?? (!snap.specsLoaded ? "规范目录读取挂起" : `规范 "${leaf.name}" 不在当前目录中`) }];
      if (spec.kind === "rig") lines.push(specTabsLine(state));
      lines.push({ text: `${spec.kind} 规范 ${spec.name}` });
      lines.push(fieldLine({ label: "用途", value: spec.description ?? "未在可用源中声明" }));
      lines.push(fieldLine({ label: "来源", value: `${sourceProvenance(spec)} · ${spec.sourceState ?? "源状态未服务"}` }));
      lines.push(...specSourceLines(spec, snap));
      lines.push({ text: "  撰写声明。资源可用性不是运行中席位的有效装载。" });
      lines.push(sectionRule("观察到的消费者 · 为有效运行时/配置打开", contentWidth));
      for (const consumer of spec.consumers ?? []) {
        const resource = consumer.agent ? "agent" : "rig";
        lines.push(listItem(`${consumer.agent ?? consumer.rig} · ${consumer.status ?? "unknown"}${consumer.runtime ? ` · ${consumer.runtime}` : ""}${consumer.model ? ` · ${consumer.model}` : ""}`, { type: "drill", resource, name: consumer.agent ?? consumer.rig, target: { host: consumer.host, rig: consumer.rig } }));
      }
      if (spec.consumers && !spec.consumers.length) lines.push({ text: "  可用本地清单中未观察到消费者（远程席位未枚举）。" });
      if (spec.consumers === undefined) lines.push({ text: "  消费者投影不可用。" });
      for (const error of snap.readErrors.filter((error) => error.startsWith("nodes(") || error.startsWith("rig-spec(") || error.startsWith("rigs-summary:"))) lines.push({ text: `  清单不完整: ${error}` });
      lines.push(listItem("返回 · Esc", { type: "back" }));
      if (spec.sourceUnavailable) return wrapDetailLines([...lines, { text: `  源不可用: ${spec.sourceUnavailable}` }], contentWidth);
      if (spec.kind === "rig") {
        if (state.viewTab === "topology") {
          // ROUND-4 条目 1：已建立的表格处理，非未格式化行
          const nodes = spec.graph?.nodes ?? [];
          const graphEdges = spec.graph?.edges ?? [];
          const NODE_COLS: Array<[string, number]> = [["节点", 16], ["标签", 24], ["席位", 12], ["运行时", 14]];
          lines.push(fieldLine({ label: "形态", value: `${nodes.length} 个节点 · ${graphEdges.length} 条边` }));
          lines.push({ text: "" });
          if (nodes.length === 0) {
            lines.push({ text: "  (拓扑投影为空)" });
            return wrapDetailLines(lines, contentWidth);
          }
          lines.push({ text: `  ${alignedRow(NODE_COLS)}` });
          lines.push({ text: `  ${"─".repeat(NODE_COLS.reduce((n, [, w]) => n + w + 1, -1))}` });
          for (const node of nodes)
            lines.push({ text: `  ${alignedRow([[node.id, 16], [node.label, 24], [node.pod ?? "—", 12], [node.runtime, 14]])}` });
          if (graphEdges.length > 0) {
            lines.push({ text: "" });
            lines.push(sectionRule("边"));
            for (const edge of graphEdges) lines.push({ text: `  ${alignedRow([[edge.source, 16], ["→", 2], [edge.target, 20]])} (${edge.kind})` });
          }
          return wrapDetailLines(lines, contentWidth);
        }
        if (state.viewTab === "yaml") {
          for (const rawLine of (spec.raw ?? "# 原始 YAML 不可用").split("\n")) lines.push({ text: `  ${rawLine}` });
          return wrapDetailLines(lines, contentWidth);
        }
        const members = spec.pods?.reduce((count, pod) => count + pod.members.length, 0) ?? spec.legacyNodes?.length ?? 0;
        const edges = (spec.edges?.length ?? 0) + (spec.pods?.reduce((count, pod) => count + pod.edges.length, 0) ?? 0);
        lines.push(
          ...detailPage({ text: "" }, [
            {
              fields: [
                ...(spec.format ? [{ label: "格式", value: spec.format.replace("_", "-") }] : []),
                { label: "形态", value: `${spec.pods?.length ?? 0} 个席位 · ${members} 个成员 · ${edges} 条边` },
              ],
            },
            ...(spec.pods ?? []).map((pod) => ({
              title: `席位 ${pod.namespace ?? pod.id}${pod.label ? ` — ${pod.label}` : ""}`,
              lines: [
                ...pod.members.map((member) =>
                  listItem(
                    `${alignedRow([[member.id, 12], [member.agentRef, 34], [member.runtime, 12]])}${member.profile ? ` 配置 ${member.profile}` : ""}`,
                    { type: "drill", resource: "spec", name: member.agentRef },
                  ),
                ),
                ...pod.edges.map((edge) => ({ text: `    ${edge.from} → ${edge.to}  (${edge.kind})` })),
                // 空席位仍存在 — 诚实渲染，绝不跳过
                ...(pod.members.length === 0 && pod.edges.length === 0 ? [{ text: "  (无成员)" }] : []),
              ],
            })),
            ...(spec.legacyNodes?.length
              ? [{ title: "节点", lines: spec.legacyNodes.map((node) => listItem(`${alignedRow([[node.id, 16], [node.runtime, 12]])}${node.role ? ` ${node.role}` : ""}`)) }]
              : []),
            ...((spec.edges?.length ?? 0) > 0
              ? [{ title: "跨席位边", lines: (spec.edges ?? []).map((edge) => ({ text: `  ${edge.from} → ${edge.to}  (${edge.kind})` })) }]
              : []),
          ]).slice(1),
        );
      } else if (spec.kind === "workflow") {
        lines.push(
          ...detailPage({ text: `工作流规范 ${spec.name}${spec.version ? `  ·  v${spec.version}` : ""}` }, [
            {
              title: "工作流",
              fields: [
                { label: "角色", value: spec.rolesCount != null ? String(spec.rolesCount) : "—" },
                { label: "步骤", value: spec.stepsCount != null ? String(spec.stepsCount) : "—" },
                { label: "状态", value: spec.workflowStatus ?? "—" },
              ],
            },
            {
              title: "源",
              fields: [{ label: "源", value: spec.sourcePath ? `${displayPath(spec.sourcePath)} · ${sourceProvenance(spec)}` : "—" }],
            },
          ]),
        );
      } else {
        // mockup 的智能体规范框架就是字段网格引用 — 重建它
        const seats = agentsRunningSpec(snap, spec.name);
        const resources = [
          spec.resources?.guidance.length ? `guidance ${spec.resources.guidance.join(", ")}` : "",
          spec.resources?.plugins.length ? `plugins ${spec.resources.plugins.join(", ")}` : "",
          spec.resources?.subagents.length ? `subagents ${spec.resources.subagents.join(", ")}` : "",
        ].filter(Boolean);
        lines.push(
          ...detailPage({ text: `智能体规范 ${spec.name}${spec.version ? `  ·  v${spec.version}` : ""}` }, [
            {
              title: "规范",
              fields: [
                ...(spec.description ? [{ label: "关于", value: spec.description }] : []),
                { label: "运行时", value: spec.runtime ?? "—" },
              ],
              lines: spec.skills ? fieldWrapped("技能", spec.skills) : [],
            },
            {
              title: "启动",
              fields: [
                ...(spec.hasGuidance != null ? [{ label: "指导", value: spec.hasGuidance ? "是" : "否" }] : []),
                ...(spec.startupFiles ?? []).map((f) => ({ label: "启动", value: `${f.path}${f.required ? "  (必需)" : ""}` })),
                ...(spec.profiles?.length ? [{ label: "配置", value: spec.profiles.join(", ") }] : []),
                ...(spec.resources ? [{ label: "资源", value: resources.join(" · ") || "(技能之外无)" }] : []),
              ],
            },
            {
              title: "源",
              fields: [{ label: "源", value: spec.sourcePath ? `${displayPath(spec.sourcePath, 56)} · ${sourceProvenance(spec)}` : "—" }],
            },
            {
              title: "声明的工作组引用",
              fields: [
                ...((spec.usedByRigs?.length ?? 0) === 0
                  ? [{ label: "声明者", value: "—" }]
                  : (spec.usedByRigs ?? []).map((rig) => ({
                      label: "声明者",
                      value: `工作组 ${rig}`,
                      link: { type: "drill", resource: "spec", name: rig } as Action,
                    }))),
                {
                  label: "当前席位",
                  value: seats.join(", ") || "(无)",
                  link: { type: "cross", kind: "running", name: spec.name },
                },
              ],
            },
          ]),
        );
      }
      return wrapDetailLines(lines, contentWidth);
    }
    if (state.filter) lines.push({ text: `/ 过滤规范: ${state.filter} · / 替换 · Esc 清除` });
    const selected = computeExplorerRows(state, snap)[state.selection]?.action;
    const spec = selected?.type === "drill" && selected.resource === "spec" ? findSpec(snap, selected.name) : null;
    if (spec) {
      lines.push({ text: `${spec.name} · ${spec.kind} · ${sourceProvenance(spec)}` });
      lines.push({ text: "" }, { text: spec.description?.trim() || "用途未在可用源中声明。" });
      if (spec.kind === "rig") lines.push(fieldLine({ label: "内容", value: `${spec.pods?.length ?? 0} 个席位 · ${spec.pods?.reduce((n, p) => n + p.members.length, 0) ?? spec.legacyNodes?.length ?? 0} 个成员 · ${spec.agentRefs?.join(", ") || "未服务成员引用"}` }));
      else if (spec.kind === "agent") lines.push(fieldLine({ label: "内容", value: `${spec.runtime ?? "运行时未声明"} · ${(spec.skills ?? []).length} 个技能 · ${(spec.startupFiles ?? []).length} 个启动文件` }));
      else lines.push(fieldLine({ label: "内容", value: `${spec.rolesCount ?? "未知"} 个角色 · ${spec.stepsCount ?? "未知"} 个步骤` }));
      lines.push({ text: "" }, listItem("读取详情 · 回车", { type: "drill", resource: "spec", name: spec.name }), ...specSourceLines(spec, snap));
      if (spec.sourceUnavailable) lines.push({ text: `源不可用: ${spec.sourceUnavailable}` });
    } else {
      lines.push({ text: "规范库" }, { text: "在左侧选择规范以预览其用途、内容和源。" },
        { text: "回车读取详情 · / 过滤 · 源打开当前磁盘内容" }, { text: "" });
      if (snap.specsLoaded !== false && !snap.readErrors.some(e => e.startsWith("specs-library"))) for (const kind of ["rig", "agent", "workflow"] as const) lines.push({ text: `${kind}: ${snap.specs.filter((spec) => spec.kind === kind).length} 个可用` });
      if (!snap.specs.length) {
        if (motion.loading) {
          if (!motion.reduced) motion.used = true;
          lines.push({ text: `  ${motion.frame} 库读取挂起` });
        } else {
          const failure = snap.readErrors.find((error) => error.startsWith("specs-library"));
          const notLoaded = snap.readErrors.find((error) => error.startsWith("实时数据未加载"));
          lines.push({ text: failure ? `  ✕ 库读取失败: ${failure}` : notLoaded ?? (snap.specsLoaded === false ? "规范目录读取不可用" : "  (库为空 — 已证明，未服务规范)") });
        }
      }
    }
    return wrapDetailLines(lines, contentWidth);
  }

  if (state.section === "needs") return attentionLines(state, snap, contentWidth);
  if (state.section === "scopes") {
    const catalog = snap.projects;
    if (!state.project && catalog !== undefined) return wrapDetailLines([
      { text: "项目 · 选择项目" },
      { text: catalog ? `目录: ${catalog.catalogPath}` : "项目目录不可用或加载中" },
      ...(snap.readErrors ?? []).map(text => ({ text })),
      ...(catalog?.projects ?? []).flatMap(p => [listItem(`${p.name} · ${p.id}`, { type: "project-select", id: p.id }), { text: p.root }, ...(p.error ? [{ text: `不可用: ${p.error}` }] : [])]),
      ...(catalog?.projects.length === 0 ? [{ text: "此目录中未声明项目。" }] : []),
    ], contentWidth);
    const identity = state.project ? wrapDetailLines([{ text: `项目 ${state.project.id}` }, { text: state.project.root }], contentWidth) : [];
    if (state.project && (snap.projectRead?.id !== state.project.id || snap.projectRead?.root !== state.project.root)) return [...identity, { text: "正在读取所选项目…" }];
    const entry = catalog?.projects.find(p => p.id === state.project!.id && p.root === state.project!.root);
    const readErrorLabel: Record<string, string> = { "attention": "待关注", "review-fleet": "评审-船队", "scopes": "工作范围", "execution": "执行" };
    const errors = (snap.readErrors ?? []).map(text => {
      const mapped = text.replace(/^(attention|review-fleet|scopes|execution)(:|\s)/, (_, prefix, sep) => `${readErrorLabel[prefix] ?? prefix}${sep}`);
      return { text: `不可用: ${mapped}` };
    });
    const missionOverview = !!state.scopesMission && !state.scopesSelected && !state.executionOpen;
    const projectHeader = state.project ? missionOverview
      ? [{ text: `项目 ${state.project.id}`, action: { type: "project-source" as const } }, ...wrapDetailLines(errors, contentWidth)]
      : [...identity, listItem("读取当前源", { type: "project-source" }), ...wrapDetailLines(errors, contentWidth)] : [];
    if (state.project && (!entry || entry.error)) return [...projectHeader, { text: "请重新选择项目或返回。" }];
    if (state.project && !state.scopesMission) return [...projectHeader, { text: "选择任务目标" }, ...(snap.scopes ?? []).map(m => listItem(m.mission + (m.error ? " · 源不可用" : ""), { type: "scopes-mission-open", mission: m.mission })), ...(!snap.scopes?.length && !errors.length ? [{ text: "此项目中未找到任务目标。" }] : [])];
    // SCOPES 拥有两个层级。任务图和资源管理器切片路由都落在
    // 同一执行支持的规范详情上；存储直接内容
    // 组合到该页面，而非作为竞争目的地存活。
    const sel = state.scopesSelected;
    const missionName = state.scopesMission;
    const mission = snap.scopes?.find(m => m.mission === missionName);
    if (mission?.error) return [...projectHeader, ...wrapDetailLines([{ text: `${missionName} · 源不可用` }, { text: mission.error }, { text: "修正源并刷新；返回回到其他任务目标。" }], contentWidth)];
    const execution = snap.execution?.mission === missionName ? snap.execution : null;
    const detail = sel
      ? (snap.scopes ?? []).find((m) => m.mission === sel.mission)?.slices.find((sl) => sl.dirName === sel.slice) ?? null
      : null;
    if (detail?.error) return [...projectHeader, ...wrapDetailLines([{ text: `${missionName}/${detail.dirName} · 源不可用` }, { text: detail.error }, { text: "修正源并刷新；返回回到其他切片。" }], contentWidth)];
    if (!sel && !state.executionOpen) projectHeader.push(...(mission?.slices.filter(s => s.error) ?? []).map(s => listItem(`${s.dirName} · 源不可用`, { type: "scopes-open", mission: missionName!, slice: s.dirName })));
    if (state.executionOpen && execution) {
      return [...projectHeader, ...executionContentLines(execution, snap.scopes, snap.readErrors, state.executionOpen, contentWidth, false, snap.sliceDetail, {
        collapseReqs: state.scopesCollapseReqs,
        narrative: state.scopesNarrative,
      }, state.timeZone)];
    }
    if (detail && execution) {
      return [...projectHeader, ...executionContentLines(execution, snap.scopes, snap.readErrors, `slice:${detail.id ?? detail.dirName}`, contentWidth, false, snap.sliceDetail, {
        collapseReqs: state.scopesCollapseReqs,
        narrative: state.scopesNarrative,
      }, state.timeZone)];
    }
    if (!detail && missionName) {
      const lines = executionContentLines(execution, snap.scopes, snap.readErrors, state.executionOpen, contentWidth, !snap.hydratedAt || snap.executionMission !== missionName, undefined, undefined, state.timeZone);
      return [...projectHeader, ...(execution ? lines : [{ text: `  ${missionName} 执行` }, ...lines])];
    }
    return [...projectHeader, ...scopesContentLines(detail, missionName, {
      collapseReqs: state.scopesCollapseReqs,
      narrative: state.scopesNarrative,
      width: contentWidth,
      executionStrip: detail ? executionSliceStripLines(null, detail.id ?? detail.dirName, detail.dirName, contentWidth, detail.status) : undefined,
    })];
  }
  return [{ text: `(${state.section})` }];
}

export interface RenderOptions {
/** 首次访问：保留先前帧及其原始标签，无效果目标。 */
  previousPage?: { state: ViewState; snapshot: FleetSnapshot };
  startup?: StartupState;
  /** I5 — 实时命令上下文（来自 C3 检测器）；默认 "standard"。 */
  commandContext?: string;
  completion?: { candidates: string[]; message: string } | null;
  cols?: number;
  rows?: number;
  /** 挂钟 ms 用于时间驱动运动（旋转器帧、闪烁窗口）；
   * renderScreen 保持纯 — 调用者提供时间（round-4 接线） */
  nowMs?: number;
  /** 活动样式的颜色模式 — 选择盲文 vs 线条旋转器帧 */
  colorMode?: ColorMode;
  /** S19 round-5（守卫）：刷新所有者的诚实负载生命周期 —
   * 旋转器仅在未结算/在飞时渲染；省略 = 已结算
   *（演示/fixture：给定数据就是答案，无加载中） */
  load?: LoadState;
  /** S19 round-5（守卫）：来自刷新所有者的每席位新窗格输出
   * 事件 — renderScreen 在一次性窗口打开时定位每个智能体的
   * 资源管理器行；省略 = 无闪烁 */
  rowFlashes?: RowFlash[];
  /** 5.2 故障诊断：已解析后台服务关闭信号。存在 ⇒ 整屏为后台服务关闭
   * 路径 — 后台服务不服务时正常组视图无数据。 */
  daemonState?: DaemonState;
  unavailable?: string;
  unavailableExpanded?: boolean;
  starting?: string;
  /** 驾驶舱模型 — 当 daemonState === "down" 时渲染。 */
  crashCart?: CrashCartModel;
  /** UNVERIFIED 屏幕的证据 — 当 daemonState === "unverified" 时渲染。 */
  daemonEvidence?: DaemonUnverifiedEvidence;
  /** B1 ROUND 2 — 实时组恢复生命周期；存在时渲染（进度 → 汇总+分类）
   * 并优先于驾驶舱，因此恢复进度和分类列表可见。 */
  restore?: RestoreLifecycleVM;
  /** B1 ROUND 3 (HIGH-2) — 恢复内容的垂直滚动偏移，因此分类列表长于
   * 视口保持键盘可走（shell 报告 contentMaxOffset 用于钳制）。 */
  restoreScroll?: number;
  /** B1 ROUND 10 — ⏎ 确认横幅文本（非零代数恢复）。在驾驶舱中渲染，因此
   * 确认在操作员查看处可见（ViewState.notice 不在驾驶舱中显示）。 */
  confirm?: string;
}

/** 将一个字符替换为纯文本位置的 token 分段行中的
 * 键盘焦点标记（重音、粗体）— 保持 plain(segs) 等于
 * 拼接内容文本（R2 HIGH-3） */
function spliceMarkerIntoSegs(
  segs: NonNullable<ContentLine["segs"]>,
  pos: number,
): NonNullable<ContentLine["segs"]> {
  const out: NonNullable<ContentLine["segs"]> = [];
  let at = 0;
  for (const seg of segs) {
    const end = at + seg.text.length;
    if (pos >= at && pos < end) {
      const off = pos - at;
      if (off > 0) out.push({ ...seg, text: seg.text.slice(0, off) });
      out.push({ text: "›", token: "accent", bold: true });
      if (off + 1 < seg.text.length) out.push({ ...seg, text: seg.text.slice(off + 1) });
    } else {
      out.push(seg);
    }
    at = end;
  }
  return out;
}

function paneRule(cols: number, explW: number, joint: "top" | "bottom", leftTitle?: string, rightTitle?: string): string {
  void joint;
  const left = leftTitle ? `━ ${leftTitle} ` : "";
  const right = rightTitle ? `━ ${rightTitle} ` : "";
  const rulePart = (head: string, width: number) => {
    const clipped = truncateToWidth(head, width);
    return clipped + "━".repeat(Math.max(0, width - strWidth(clipped)));
  };
  const leftPart = rulePart(left, explW);
  const rightPart = rulePart(right, Math.max(cols - explW - 1, 0));
  return `${leftPart}╋${rightPart}`;
}

function keybindHints(state: ViewState): string {
  if (state.copyMode) return "拖动选择/复制 · v 恢复鼠标 · q 退出";
  // 提示面基于真实可滚动性（contentMaxOffset），绝不门控
  // 在已内容聚焦后 — 那个门控是第22条军规（
  // 提示恰好在需要处隐藏）。当 ↑↓ 自身滚动时（
  // 可滚动规范详情），导航标签如此说明；否则 ↑↓ 移动且
  // 翻页键携带滚动。
  if (state.section === "config") return state.configKey
    ? `${specDetailArrowsScroll(state) ? "↑↓ 滚动" : "↑↓ 移动"} · Esc 返回 · v 选择/复制 · 刷新 · q 退出`
    : "↑↓ 移动 · ←→ 窗格 · ⏎ 打开 · / 搜索 · Esc 返回 · 刷新 · q 退出";
  const arrowsScroll = specDetailArrowsScroll(state);
  const nav = arrowsScroll ? "↑↓ 滚动" : "↑↓ 移动";
  const pageScroll = state.contentMaxOffset > 0 && !arrowsScroll ? "⇞⇟ 滚动 · " : "";
  const filter = state.filter ? "/ 替换 · Esc 清除" : "/ 过滤";
  return `${nav} · ←→ 窗格 · ⏎ 打开 · ${pageScroll}: 命令 · ${filter} · S 启动 · v 选择/复制 · f 页脚 · q 退出`;
}

/** PULSE 视图全宽渲染，无资源管理器侧栏（增量 2）。一个
 * 最小自包含屏幕：命令栏 + 全宽标题线 + pulse
 * 行跨所有 `cols` + 底部装饰。跳过 computeExplorerRows
 * 和左│内容绘制。 */
/** 将分段列表截断到列预算，必要时在文本中间切最终段 —
 * 保持 plain(segs) === 截断内容前缀（剥离不变）。 */
function truncateSegs(
  segs: NonNullable<Screen["segRows"]>[number],
  width: number,
): NonNullable<Screen["segRows"]>[number] {
  const totalWidth = segs.reduce((sum, segment) => sum + strWidth(segment.text), 0);
  if (totalWidth <= width) return segs;
  const out: NonNullable<Screen["segRows"]>[number] = [];
  let used = 0;
  const textBudget = Math.max(0, width - 1);
  let finalStyle: NonNullable<Screen["segRows"]>[number][number] | undefined;
  for (const s of segs) {
    if (used >= textBudget) break;
    const room = textBudget - used;
    const segmentWidth = strWidth(s.text);
    if (segmentWidth <= room) {
      out.push(s);
      used += segmentWidth;
      finalStyle = s;
    } else {
      let text = "";
      let columns = 0;
      for (const char of s.text) {
        const charWidth = strWidth(char);
        if (columns + charWidth > room) break;
        text += char;
        columns += charWidth;
      }
      if (text) out.push({ ...s, text });
      finalStyle = s;
      break;
    }
  }
  out.push({ ...(finalStyle ?? {}), text: "…" });
  return out;
}

/** 披露单元格是与行体不同的控件。命中查找是
 * 首次匹配，因此在行级目标之前注册这个单格目标。 */
function pushExplorerTargets(
  hitMap: Screen["hitMap"],
  row: import("./types.js").ExplorerRow,
  display: string,
  y: number,
  explorerWidth: number,
): void {
  if (row.disclosureAction) {
    const at = display.search(/[⌄›]/);
    if (at >= 0) hitMap.push({ y, x1: at + 2, x2: at + 2, action: row.disclosureAction });
  }
  hitMap.push({ y, x1: 1, x2: explorerWidth, action: row.action });
}

function readStatus(load: import("./types.js").LoadState, zone: string): string {
  const at = load.retainedAt ?? load.lastSuccessAt;
  const basis = at === undefined ? "" : ` · last ${displayTime(new Date(at).toISOString(), zone)}`;
  if (load.inFlight) return `${load.settled ? "刷新中" : "加载中"}…${basis} · ? 帮助`;
  if (load.stale) return `${at === undefined ? "读取失败" : "无法刷新"}${basis} · 刷新以重试`;
  return `标签页完成 · ? 帮助${basis}`;
}

function renderPulseScreen(state: ViewState, snap: FleetSnapshot, options: RenderOptions, inputLine: string): Screen {
  const { cols = 120, rows = 32, nowMs = 0 } = options;
  const explW = explorerWidth(cols);
  // 创建者选项-B（取代早期全宽判定）：PULSE 渲染为
  // 标准装饰内的内容窗格视图 — 资源管理器侧栏保留（它
  // 是创建者的动作路径：从需要你行，鼠标到侧栏并
  // 导航）。因此这构建每个其他视图使用的相同资源管理器│内容分割；
  // 泳道截断到内容宽度（创建者接受的权衡）。
  // 每格选择高亮 + 新输出闪烁通过正常
  // 分割窗格 segRows 路径绘制 — 无全宽样式绕过（那个特殊情况
  // 已消失）。incr-5 的刷新接缝/运动/读取器时钟沿不变。
  //
  // 为什么专用渲染器 + 自定义格目标而非通用内容
  // 区机制（审阅者：与原生对等的文档化原因产生）：
  // 已批准 mock 的 `.sel` 行是高亮格 — 原生
  // "›"标记区选择无法表达的提示。mock 绑定那个
  // 提示，因此选择保持 incr-4 的每格 accent-bg，由
  // pulseLaneTargets 列主序走。侧栏半是正常分割（相同
  // 助手），因此创建者导航器行为与每个其他视图相同。
  const reduced = reducedMotion();
  const load = options.load ?? { inFlight: false, settled: true };
  const loading = load.inFlight || !load.settled;
  const frame = spinnerFrame(Math.floor(nowMs / MOTION_FRAME_MS), options.colorMode ?? "truecolor", reduced);
  const liveFlashes = (options.rowFlashes ?? []).filter((f) => flashActive(f.at, nowMs, 600, reduced));
  const ackFlashes = (options.rowFlashes ?? []).filter((f) => flashActive(f.at, nowMs, 600, false));

  const lines: string[] = [];
  const hitMap: Screen["hitMap"] = [];
  const segRows: NonNullable<Screen["segRows"]> = {};
  const explorerRows: Screen["explorerRows"] = [];
  const explorerMeta: NonNullable<Screen["explorerMeta"]> = {};
  const contentTargets: Screen["contentTargets"] = [];
  const flashRows: number[] = [];
  let flashAck = false;

  lines.push(pad(`cmd ▸ ${inputLine}▊${inputLine ? "" : "  " + readStatus(load, state.timeZone)}`, cols));
  if (load.stale && !inputLine) hitMap.push({ y: 1, x1: 9, x2: cols, action: { type: "noop" } });
  if (options.completion) {
    lines.push(pad(options.completion.message, cols));
    for (const candidate of options.completion.candidates.slice(0, 4)) lines.push(pad(`  ${candidate}`, cols));
    if (options.completion.candidates.length > 4) lines.push(pad("  … 继续键入以缩小匹配", cols));
  }

  const explorerTitle = state.focusedPane === "explorer" ? "{ 资源管理器 }" : "资源管理器";
  const contentTitle = state.focusedPane === "content" ? "{ PULSE }" : "PULSE";
  lines.push(paneRule(cols, explW, "top", explorerTitle, contentTitle));

  const contentWidth = Math.max(cols - explW - 2, 0);
  const model = buildPulseModel(snap, nowMs);
  const chromeRows = 3; // bottom rule + hint bar + status line
  const bodyRows = Math.max(rows - lines.length - chromeRows, 1);

  const maxContentOffset = Math.max(renderPulseView(model).length - bodyRows, 0);
  const contentStart = Math.min(state.contentOffset, maxContentOffset);

  // 泳道格（列主序），截断到内容宽度：列
  // 跨度起始超过内容边缘的格不渲染 → 非目标（无
  // 不可见但可动作的格）。x 是内容相对的（泳道内 1 基）。
  const allTargets = pulseLaneTargets(model).filter((t) => t.x1 <= contentWidth);
  const visibleTargets = allTargets.filter((t) => t.lineIndex >= contentStart && t.lineIndex < contentStart + bodyRows);

  // 泳道光标位于内容窗格上；仅在内容
  // 聚焦时显示（资源管理器聚焦 → 侧栏光标领先，创建者的路径）。
  const sel =
    state.focusedPane === "content" && visibleTargets.length > 0
      ? Math.min(Math.max(state.contentSelection, 0), visibleTargets.length - 1)
      : -1;
  if (sel >= 0) {
    const t = visibleTargets[sel]!;
    model.lanes[t.lane]!.rows[t.row]!.selected = true; // per-cell accent-bg (mock affordance)
  }

  // 运动预算：现在（泳道 0）席位产生新窗格输出的格闪烁
  // 每格（反相）— 相同已服务 terminalActive false→true 起始，表
  // 行闪烁乘坐。刚完成/下一个绝不闪烁（无已服务完成事件）。
  if (liveFlashes.length) {
    for (const t of allTargets) {
      if (t.lane !== 0) continue;
      const a = t.action;
      if (a.type !== "drill" || a.resource !== "agent" || !a.target?.rig || !a.target?.pod) continue;
      const key = `agent:${a.target.host}/${a.target.rig}/${a.target.pod}/${a.name}`;
      if (liveFlashes.some((f) => f.key === key)) model.lanes[t.lane]!.rows[t.row]!.flashed = true;
    }
  }

  const pulseLines = renderPulseView(model);
  const visiblePulse = pulseLines.slice(contentStart, contentStart + bodyRows);

  // 资源管理器侧栏 = 正常导航器（与每个其他视图相同助手）。
  const explorer = computeExplorerRows(state, snap);
  const { labels: explorerDisplay, metas: explorerMetas } = navigatorDisplay(explorer, snap, explW - 1);
  const explorerStart = Math.min(Math.max(state.selection - bodyRows + 1, 0), Math.max(explorer.length - bodyRows, 0));

  for (let i = 0; i < bodyRows; i++) {
    const y = lines.length + 1;
    // 资源管理器半（与正常分割相同 — 真实装饰，动作路径）
    const explorerIndex = explorerStart + i;
    const row = explorer[explorerIndex];
    const flashed = row?.key != null && ackFlashes.some((f) => f.key === row.key);
    if (flashed) flashAck = true;
    const marker = explorerIndex === state.selection && row ? (flashed ? "◆" : "▶") : flashed ? "≈" : " ";
    const left = pad(row ? `${marker}${explorerDisplay[explorerIndex] ?? row.label}` : "", explW);
    // 内容半 = pulse 视图，截断到内容宽度。选择是
    // segs 上的每格 bg（mock 提示），因此内容标记槽
    // 保持空白 — 无 "›" 箭头（mock 覆盖的原生提示）。
    const citem = visiblePulse[i];
    const contentText = (citem?.text ?? "").slice(0, contentWidth);
    lines.push(pad(`${left}┃ ${contentText}`, cols));
    if (row) {
      pushExplorerTargets(hitMap, row, explorerDisplay[explorerIndex] ?? row.label, y, explW);
      explorerRows.push({ ...row, y });
      const em = explorerMetas[explorerIndex];
      if (em && em.length) explorerMeta[y] = em.map((run) => ({ start: 1 + run.start, segs: run.segs }));
      if (row.key && liveFlashes.some((f) => f.key === row.key)) flashRows.push(y);
    }
    if (citem?.segs) segRows[y] = truncateSegs(citem.segs, contentWidth);
  }

  // 泳道格 → 内容目标，x 映射到内容列（原点 =
  // 资源管理器边界 + 3，匹配正常内容几何），钳制到 `cols`。
  for (const t of visibleTargets) {
    const x1 = explW + 2 + t.x1;
    if (x1 > cols) continue;
    const target = { y: t.lineIndex - contentStart + 3, x1, x2: Math.min(explW + 2 + t.x2, cols), action: t.action };
    contentTargets.push(target);
    hitMap.push(target);
  }

  lines.push(paneRule(cols, explW, "bottom"));
  lines.push(pad(keybindHints(state), cols));
  const drillPath = state.drill.map((d) => d.name).join(" → ");
  const readWarn = snap.readErrors.length > 0 ? `  ⚠ ${snap.readErrors.length} 次读取失败: ${snap.readErrors[0]}` : "";
  // 诚实首次加载生命周期：刷新所有者的首次水合在飞时
  // （！结算）显示旋转器标记的"加载中" — 区分"仍在
  // 读取"与真正空组。结算后，刷新静默；
  // 页脚的实时"N 秒前更新"是进行中刷新信号（读取器
  // 时钟），因此结算空视图保持平静。减少运动 → 静态 "·"。
  const loadTag = loading ? `  ${frame} 加载中` : "";
  lines.push(
    pad(
      `[${state.instanceId}] ${sectionLabel(state.section)}${drillPath ? " · " + drillPath : ""}${state.lastError ? "  ✗ " + state.lastError : ""}${state.notice ? "  ▸ " + state.notice : ""}${readWarn}${loadTag}${state.timeZoneWarning ? " · ⚠ 时区; 运行 timezone" : ""}`,
      cols,
    ),
  );
  while (lines.length < rows) lines.push("");
  const anyFlash = model.lanes.some((l) => l.rows.some((r) => r.flashed));
  return {
    lines: lines.slice(0, rows),
    explorerWidth: explW,
    hitMap,
    contentTargets,
    contentMaxOffset: maxContentOffset,
    explorerRows,
    segRows,
    explorerMeta,
    // 整行资源管理器活动闪烁（tmux 风格）在侧栏半，完全
    // 如表视图；PULSE 格闪烁是每格（segs 中反相）。
    flashRows,
    // 调度有界过期重绘，当首次加载旋转器或
    // 未过期闪烁活跃时；减少运动（无动画）通过刷新结算。
    motionActive: (!reduced && loading) || anyFlash || flashRows.length > 0 || flashAck,
  };
}

// 故障诊断外壳（判定 3c6c2be0）：后台服务关闭驾驶舱作为内容窗格视图在
// 标准资源管理器│内容外壳内 — 左侧账本馈送的资源管理器（诚实标记），
// 右侧已批准内容。镜像 renderPulseScreen 的分割；内容 segs 通过正常
// 分割窗格路径绘制（stylize │ 分支），无全宽绕过。所有轨道在内容构建器中。
type PaneContentLine = { text: string; action?: Action; segs?: Array<{ text: string; token?: Token; bold?: boolean; bg?: Token; inverse?: boolean }> };

/** 长内容字换行到窗格宽度，带悬挂缩进，因此无内容静默
 * 从右边缘裁剪。仅在内容短到可承受额外行处使用
 * （恢复生命周期视图）— 固定高度驾驶舱仍裁剪以保留其行布局。 */
function wrapContentLines(content: PaneContentLine[], width: number): PaneContentLine[] {
  if (width <= 0) return content;
  const out: PaneContentLine[] = [];
  const indent = "     ";
  for (const item of content) {
    const text = item.text ?? "";
    if (strWidth(text) <= width) {
      out.push(item);
      continue;
    }
    let rest = text;
    let first = true;
    while (strWidth(rest) > 0) {
      const w = first ? width : Math.max(1, width - strWidth(indent));
      let prefix = "";
      let used = 0;
      for (const char of rest) {
        const charWidth = strWidth(char);
        if (used + charWidth > w) break;
        prefix += char;
        used += charWidth;
      }
      let cut = prefix.length;
      if (cut < rest.length) {
        const sp = prefix.lastIndexOf(" ");
        if (sp >= Math.floor(prefix.length / 2)) cut = sp;
      }
      const chunk = rest.slice(0, cut).trimEnd();
      rest = rest.slice(cut).replace(/^\s+/, "");
      out.push(first ? { text: chunk, action: item.action } : { text: indent + chunk });
      first = false;
    }
  }
  return out;
}

function crashCartShell(
  content: PaneContentLine[],
  led: Pick<ReturnType<typeof buildLedgerExplorer>, "note" | "rows">,
  contentTitle: string,
  cols: number,
  rows: number,
  inputLine: string,
  opts?: { wrap?: boolean; scroll?: number },
): Screen {
  const explW = explorerWidth(cols);
  const lines: string[] = [];
  const segRows: NonNullable<Screen["segRows"]> = {};
  const hitMap: Screen["hitMap"] = [];
  lines.push(pad(`cmd ▸ ${inputLine}▊`, cols));
  lines.push(paneRule(cols, explW, "top", "{ EXPLORER }", contentTitle));

  // 资源管理器的源注释，然后任何发现的工作组（名称 + 席位计数）。
  const leftRows: string[] = [led.note, "", ...led.rows.map((r) => `${r.label} (${r.seatCount})`)];
  const contentWidth = Math.max(cols - explW - 2, 0);
  if (opts?.wrap) content = wrapContentLines(content, contentWidth);
  const bodyRows = Math.max(rows - 2 - 3, 1); // 减命令栏 + 顶线 + (底线、提示、状态)
  // HIGH-2 — 内容超过视口时，垂直可滚动：contentMaxOffset 是
  // 操作员可滚动到的最远行，渲染窗口从钳制滚动偏移开始。
  // 适合的列表（偏移 0，maxOffset 0）不变。仅内容窗格滚动；资源管理器保留。
  const contentMaxOffset = Math.max(0, content.length - bodyRows);
  const scroll = Math.max(0, Math.min(contentMaxOffset, opts?.scroll ?? 0));
  for (let i = 0; i < bodyRows; i++) {
    const y = lines.length + 1;
    const left = pad(leftRows[i] ?? "", explW);
    const citem = content[scroll + i];
    const contentText = (citem?.text ?? "").slice(0, contentWidth);
    if (citem?.action) hitMap.push({ y, x1: explW + 2, x2: cols, action: citem.action });
    lines.push(pad(`${left}┃ ${contentText}`, cols));
    if (citem?.segs) segRows[y] = truncateSegs(citem.segs, contentWidth);
  }
  lines.push(paneRule(cols, explW, "bottom"));
  lines.push(pad("", cols));
  const scrollHint = contentMaxOffset > 0 ? ` · ↑↓ 滚动 (${scroll}/${contentMaxOffset})` : "";
  lines.push(pad(`[故障诊断] ${led.note}${scrollHint}`, cols));
  while (lines.length < rows) lines.push("");
  return {
    lines: lines.slice(0, rows),
    explorerWidth: explW,
    hitMap,
    contentTargets: [],
    contentMaxOffset,
    explorerRows: [],
    segRows,
  };
}

export function renderScreen(state: ViewState, snap: FleetSnapshot, options: RenderOptions = {}, inputLine = ""): Screen {
  if (state.palette) return helpScreen(state.palette, options.commandContext ?? "standard", options.cols ?? 120, options.rows ?? 32);
  const screen = renderBody(state, snap, options, inputLine);
  const commandReady = !options.startup?.open && !options.restore && !options.unavailable && (!options.daemonState || options.daemonState === "up");
  if (commandReady) {
    const reduced = reducedMotion();
    if (!commandFocusVisible(options.nowMs ?? 0, inputLine.length > 0, reduced)) {
      const line = screen.lines[0]!;
      screen.lines[0] = line.slice(0, 6) + " " + line.slice(7);
    }
    screen.commandMotionActive = !reduced && inputLine.length === 0;
  }
  return screen;
}

function renderBody(state: ViewState, snap: FleetSnapshot, options: RenderOptions = {}, inputLine = ""): Screen {
  const { cols = 120, rows = 32, nowMs = 0 } = options;
  const fullReading = !options.startup?.open && (!!state.file || !!state.externalUrl || (cols <= 90 && state.section === "specs" && state.drill.length > 0));
  const explW = fullReading ? 0 : explorerWidth(cols);
  if (options.startup?.open) {
    const startup = options.startup;
    const content = wrapContentLines(startupLines(startup).map((line) => ({ ...line,
      text: line.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\x00-\x1f\x7f]/g, " ")
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@").replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]"),
    })), Math.max(1, cols - explW - 2));
    const selected = content.findIndex((line) => line.action?.type === "startup" && line.action.key === `select:${startup.local?.selected ?? startup.selected}`);
    const scroll = startup.local && !startup.local.result.entries ? startup.local.scroll : startup.expanded ? startup.scroll : Math.max(0, selected - Math.max(1, rows - 12));
    const screen = crashCartShell(content, { note: "启动", rows: [] }, "启动并返回", cols, rows, "", { scroll });
    screen.lines[rows - 1] = pad("? 帮助 · w 跳过 · L 本地 · ↑↓ 滚动 · 回车读取 · Esc 返回 · q 退出", cols);
    return screen;
  }
  // 5.2 故障诊断（外壳放置返工，判定 3c6c2be0）：后台服务关闭渲染为内容窗格
  // 视图在标准外壳内 — 资源管理器侧栏始终存在，账本馈送 + 诚实
  // 标记（来自同一单 JSON 发现，绝不第二次读取）。内容移入右窗格
  // 逐字；所有轨道保留。DOWN → 驾驶舱；UNVERIFIED → 无法验证（无恢复）。
  // B1 ROUND 2 — 活动组恢复优先于驾驶舱：操作员看到实时
  // 进度（来自轮询流），完成时，汇总 + 键盘可走分类列表。
  if (options.restore) {
    const led = buildLedgerExplorer(options.crashCart?.foundOnHost ?? []);
    // 换行：分类需求是完整句子 — 换行到窗格，因此确切需求绝不
    // 从边缘裁剪。滚动：长于视口的分类列表垂直可滚动，因此
    // 最终行的确切需求可达（HIGH-2 — 键盘可走，非视口截断）。
    return crashCartShell(renderRestoreLifecycleView(options.restore), led, "恢复", cols, rows, inputLine, {
      wrap: true,
      scroll: options.restoreScroll ?? 0,
    });
  }
  if (options.unavailable) {
    const detail = options.unavailable
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
      .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]");
    const summary = /NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|better-sqlite3/i.test(detail)
      ? "已安装的原生模块无法在此运行时加载。修复安装前提，然后重试。"
      : "无法读取启动状态。解决报告的前提后重试。";
    return crashCartShell([
      { text: "启动前提不可用" },
      { text: summary },
      { text: "已保存身份和对话历史未被分类为缺失。" },
      { text: "" },
      { text: "r 重试 · d 详情 · q 退出" },
      ...(options.unavailableExpanded ? [{ text: "" }, { text: detail }] : []),
    ], { note: "状态不可用", rows: [] }, "启动", cols, rows, inputLine,
    { wrap: true, scroll: options.restoreScroll ?? 0 });
  }
  if (options.daemonState === "down" && options.crashCart) {
    const led = buildLedgerExplorer(options.crashCart.foundOnHost);
    // B1 ROUND 10 — 确认武装时，在驾驶舱顶部渲染（操作员
    // 查看处），因此第一个 ⏎ 被可见确认；换行使句子不在窗格边缘裁剪。
    const content = options.starting
      ? [{ text: `正在 ${options.starting} 启动后台服务…` }, { text: "席位保持停止，直到被选择。" }]
      : options.confirm
      ? [...renderConfirmBanner(options.confirm), ...renderCrashCartView(options.crashCart)]
      : renderCrashCartView(options.crashCart);
    return crashCartShell(content, led, "故障诊断", cols, rows, inputLine, options.confirm ? { wrap: true } : undefined);
  }
  if (options.daemonState === "unverified" && options.daemonEvidence) {
    const led = { note: "后台服务未验证", rows: [] }; // 此路径未发生账本发现。
    return crashCartShell(renderUnverifiedView(options.daemonEvidence), led, "后台服务?", cols, rows, inputLine);
  }
  // PULSE（创建者选项-B）：标准资源管理器│
  // 内容装饰内的内容窗格视图 — renderPulseScreen 构建自己的分割（侧栏 + 泳道）
  // 并乘坐相同 segRows 绘制路径，因此它在表布局之前返回。
  if (state.viewTab === "pulse" && options.load?.settled !== false) return renderPulseScreen(state, snap, options, inputLine);
  // S19 round-5（守卫）：每次渲染通过从调用者时间取一个旋转器帧；
  // `loading` 来自刷新所有者（省略 = 已结算 — 演示/fixture
  // 数据就是答案）；减少运动杀死所有这些
  const reduced = reducedMotion();
  const load = options.load ?? { inFlight: false, settled: true };
  const motion: MotionCtx = {
    frame: spinnerFrame(Math.floor(nowMs / MOTION_FRAME_MS), options.colorMode ?? "truecolor", reduced),
    reduced,
    used: false,
    loading: load.inFlight || !load.settled,
  };
  const lines: string[] = [];
  const hitMap: Screen["hitMap"] = [];
  // S19 MR5a（守卫修正）：一个 ▊ 插入格在栏的
  // 当前插入点渲染，对空和非空缓冲区都一样 —
  // shell 从空状态接受键入，因此诚实就绪
  // 提示必须在第一个键之前显示（无新焦点状态；stylize
  // 绘制格；共享运动时钟控制其可见性）。
  lines.push(pad(`cmd ▸ ${inputLine}▊${inputLine ? "" : "  " + readStatus(load, state.timeZone)}`, cols));
  if (load.stale && !inputLine) hitMap.push({ y: 1, x1: 9, x2: cols, action: { type: "noop" } });
  if (options.completion) {
    lines.push(pad(options.completion.message, cols));
    for (const candidate of options.completion.candidates.slice(0, 4)) lines.push(pad(`  ${candidate}`, cols));
    if (options.completion.candidates.length > 4) lines.push(pad("  … 继续键入以缩小匹配", cols));
  }

  const sectionTitle = { topology: "拓扑", specs: "规范", scopes: "项目", needs: "待关注", system: "系统 · 健康", config: "系统 · 配置", connections: "系统 · 连接" }[state.section] ?? state.section.toUpperCase();
  // 活动窗格强调（k9s 类装饰）：聚焦窗格的标题加括号
  const explorerTitle = state.focusedPane === "explorer" ? "{ 资源管理器 }" : "资源管理器";
  const contentTitle = state.focusedPane === "content" ? `{ ${sectionTitle} }` : sectionTitle;
  lines.push(fullReading ? pad(`━ ${state.file ? "读取" : state.externalUrl ? "外部 URL" : "规范"} · Esc / ← 返回 `, cols) : paneRule(cols, explW, "top", explorerTitle, contentTitle));

  const explorer = fullReading ? [] : computeExplorerRows(state, snap);
  // Slice-17：文件树重皮肤是显示变换 — 行、键、
  // 动作和命中图都保持针对上方行模型解析。
  const { labels: explorerDisplay, metas: explorerMetas } = navigatorDisplay(explorer, snap, explW - 1);
  const contentWidth = Math.max(cols - explW - (fullReading ? 1 : 2), 0);
  const previous = !load.settled && !state.externalUrl ? options.previousPage : undefined;
  const content: ContentLine[] = previous
    ? [...wrapDetailLines([{ text: `先前: ${sectionLabel(previous.state.section)} · ${previous.state.file ? `${previous.state.file.root}/${previous.state.file.path}` : previous.state.drill.map(d => d.name).join(" / ") || [previous.state.project?.id, previous.state.scopesMission, previous.state.terminalView].filter(Boolean).join(" / ") || "概览"}` }], contentWidth),
       { text: `正在打开 ${sectionTitle.toLowerCase()}… · 资源管理器保持可用` },
       ...contentLines(previous.state, previous.snapshot, contentWidth, { ...motion, loading: false }).map(line => ({ text: line.text }))]
    : !load.settled && !state.externalUrl
      ? [{ text: `${sectionTitle} · 在资源管理器中选择位置` }, { text: `${motion.frame} ${sectionTitle.toLowerCase()} 读取挂起…` }]
      : contentLines(state, snap, contentWidth, motion);
  if (!load.settled && !reduced) motion.used = true;
  const footer = state.footerOn ? snap.stream.at(-1) : undefined;
  // round-5（守卫）：tmux 风格一次性活动闪烁定位
  // 闪烁智能体的资源管理器行 — 来自
  // 刷新所有者的每席位窗格输出事件，在此窗口化。环境
  // 工作组流页脚不是
  // 事件源且绝不闪烁。round-6（守卫发现 2）：SGR
  // 反相是动画（在减少运动下杀死），而
  // 确认窗口本身忽略减少 — 纯层 "≈"
  // 标记槽字形是减少运动（和
  // NO_COLOR）保留的稳定静态信号，随相同有界窗口过期。
  const liveFlashes = (options.rowFlashes ?? []).filter((f) => flashActive(f.at, nowMs, 600, reduced));
  const ackFlashes = (options.rowFlashes ?? []).filter((f) => flashActive(f.at, nowMs, 600, false));
  const chromeRows = footer ? 4 : 3; // 底线 + 提示栏 + 状态行 (+ 页脚)
  const bodyRows = Math.max(rows - lines.length - chromeRows, 1);
  const explorerStart = Math.min(
    Math.max(state.selection - bodyRows + 1, 0),
    Math.max(explorer.length - bodyRows, 0),
  );
  const contentRows = content.length > bodyRows ? Math.max(bodyRows - 1, 0) : bodyRows;
  const maxContentOffset = Math.max(content.length - contentRows, 0);
  const contentStart = Math.min(state.contentOffset, maxContentOffset);
  const visibleContent = content.slice(contentStart, contentStart + contentRows);
  if (content.length > bodyRows) {
    const scrollText = `滚动 ↑/↓ · ${contentStart + 1}-${contentStart + visibleContent.length} / ${content.length}`;
    const up = scrollText.indexOf("↑");
    const down = scrollText.indexOf("↓");
    visibleContent.push({
      text: scrollText,
      zones: [
        { start: up, end: up + 1, action: { type: "content-scroll", delta: -10 } },
        { start: down, end: down + 1, action: { type: "content-scroll", delta: 10 } },
      ],
    });
  }
  const explorerRows: Screen["explorerRows"] = [];
  const contentTargets: Screen["contentTargets"] = [];
  const segRows: NonNullable<Screen["segRows"]> = {};
  const explorerMeta: NonNullable<Screen["explorerMeta"]> = {};
  const flashRows: number[] = [];
  let flashAck = false;
  for (let i = 0; i < bodyRows; i++) {
    const y = lines.length + 1; // 1-based terminal row this line will occupy
    const explorerIndex = explorerStart + i;
    const row = explorer[explorerIndex];
    // round-6/7（守卫）：新输出确认乘坐标记槽（零
    // 几何漂移）。冲突矩阵：所选闪烁行显示 "»" —
    // 仍明确是选择箭头，同时视觉区分于
    // 纯 "›" 基线和未选 "≈" 确认 — 因此无
    // 信号在减少运动 / NO_COLOR 下丢失；过期返回
    // 确切 "›" 基线
    const flashed = row?.key != null && ackFlashes.some((f) => f.key === row.key);
    if (flashed) flashAck = true;
    const marker = explorerIndex === state.selection && row ? (flashed ? "◆" : "▶") : flashed ? "≈" : " ";
    const left = pad(row ? `${marker}${explorerDisplay[explorerIndex] ?? row.label}` : "", explW);
    const item = visibleContent[i];
    const targetIndex = contentTargets.length;
    const zones = item?.zones ?? [];
    const selectedOnLine = state.focusedPane === "content" ? state.contentSelection - targetIndex : -1;
    const selectedZone = selectedOnLine >= 0 && selectedOnLine < zones.length ? zones[selectedOnLine] : undefined;
    const selectedAction = !!item?.action && selectedOnLine === zones.length;
    let contentText = clipW(item?.text ?? "", contentWidth);
    let contentMarker = selectedAction ? "›" : " ";
    let rowSegs = item?.segs;
    if (selectedZone) {
      if (selectedZone.start > 0) {
        const markerAt = columnIndex(contentText, selectedZone.start - 1);
        const afterMarker = columnIndex(contentText, selectedZone.start);
        contentText = `${contentText.slice(0, markerAt)}›${contentText.slice(afterMarker)}`;
        // R2 HIGH-3：segs 行的绘制源必须携带相同拼接，
        // 纯文本携带，否则样式化擦除键盘焦点标记
        if (rowSegs) rowSegs = spliceMarkerIntoSegs(rowSegs, markerAt);
      } else contentMarker = "›";
    }
    lines.push(pad(fullReading ? `${contentMarker}${contentText}` : `${left}┃${contentMarker}${contentText}`, cols));
    if (row) {
      pushExplorerTargets(hitMap, row, explorerDisplay[explorerIndex] ?? row.label, y, explW);
      explorerRows.push({ ...row, y });
      const em = explorerMetas[explorerIndex];
      if (em && em.length) explorerMeta[y] = em.map((run) => ({ start: 1 + run.start, segs: run.segs })); // +1 = 标记槽
      if (row.key && liveFlashes.some((f) => f.key === row.key)) flashRows.push(y);
    }
    // 区优先：命中查找取首次匹配，因此区赢过全行动作
    for (const z of zones) {
      const target = { y, x1: (fullReading ? 2 : explW + 3) + z.start, x2: (fullReading ? 1 : explW + 2) + z.end, action: z.action };
      hitMap.push(target);
      contentTargets.push(target);
    }
    if (item?.action) {
      const target = { y, x1: fullReading ? 2 : explW + 3, x2: cols, action: item.action };
      hitMap.push(target);
      contentTargets.push(target);
    }
    if (rowSegs) segRows[y] = truncateSegs(rowSegs, contentWidth);
  }

  if (footer) lines.push(pad(`≋ ${displayTime(footer.tsEmitted, state.timeZone)} ${footer.sourceSession}: ${footer.body}`, cols));
  const drillPath = state.drill.map((d) => d.name).join(" → ");
  const readWarn = snap.readErrors.length > 0 ? `  ⚠ ${snap.readErrors.length} 次读取失败: ${snap.readErrors[0]}` : "";
  lines.push(fullReading ? "━".repeat(cols) : paneRule(cols, explW, "bottom"));
  lines.push(pad(fullReading ? "↑↓ 滚动 / 链接 · → 链接 · 回车打开 · Esc 返回 · 刷新 · v 复制" : keybindHints(state), cols));
  lines.push(
    pad(
      `[${state.instanceId}] ${sectionLabel(state.section)}${drillPath ? " · " + drillPath : ""}${state.lastError ? "  ✗ " + state.lastError : ""}${state.notice ? "  ▸ " + state.notice : ""}${readWarn}${state.timeZoneWarning ? " · ⚠ 时区; 运行 timezone" : ""}`,
      cols,
    ),
  );
  while (lines.length < rows) lines.push("");
  return {
    lines: lines.slice(0, rows),
    explorerWidth: explW,
    hitMap,
    contentTargets,
    contentMaxOffset: maxContentOffset,
    explorerRows,
    segRows,
    explorerMeta,
    flashRows,
    // 未过期确认（即使静态减少运动字形）调度
    // 有界过期重绘 — 确认必须干净结算
    motionActive: motion.used || flashRows.length > 0 || flashAck,
  };
}
