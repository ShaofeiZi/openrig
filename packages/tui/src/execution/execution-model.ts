import { DEFAULT_TIME_ZONE, displayTime } from "../time.js";
import { workflowOverview, workflowDetail } from "./workflow-model.js";
import { padEndW, clipW, strWidth } from "../text-width.js";
// 任务执行故事——建立在两个已交付投影上的纯展示模型：工作范围存储（声明的切片状态、
// 证明配对）和后台服务派生执行视图（泳道、顺序、阶梯、停放）。它从不读取 PROGRESS
// 正文、队列正文或转换记录。
//
// 设计（创建者实时 QA 修正）：普通读者从上到下阅读任务。
//   - 身份/状态优先；“现在”“下一步”“进度”是紧凑扫描目标。
//   - “需要人工”只在可操作时出现，并打开受影响切片。
//   - 来源与共享证据缺口保持次要层级，但可继续钻取。
//   - 波次仍是主体并包含每个切片；窄或矮窗口靠视口滚动访问，而不是省略行。
//   - 不使用依赖位置的字形串、裸缩写或占位单元格。带依据的完整逐阶梯信息放在切片页。
// 每一行都会打开一个由投影自身值构成的页面；按 `esc` 返回。
import type { Action, SliceDetailSnap } from "../types.js";
import type { Token } from "../theme.js";
import { wrapDetailLines, detailPage, listItem, sectionRule, type ContentLine, type Section } from "../detail.js";
import { scopeContractLines, scopeIdentityLines, proofProvenanceLines, type ReadinessSnap, type MissionScopesSnap, type SliceScopeSnap } from "../scopes/scopes-model.js";

export interface ExecutionViewSnap {
  readiness?: { historicalStatus?: string | null; revision: string; state: string; slices: Array<{ scope: string; readiness: import("../scopes/scopes-model.js").ReadinessSnap }> };
  view: "execution";
  mission: string;
  derived_at?: string;
  sources: Record<string, unknown>;
  q1_lanes: Array<Record<string, unknown>>;
  q2_sequencing: Array<Record<string, unknown>>;
  q3_care?: Array<Record<string, unknown>>;
  q4_ladder: Array<Record<string, unknown>>;
  q5_park: Array<Record<string, unknown>>;
  q6_parallelism?: Record<string, unknown>;
  /** S06：连接到所选任务的现有工作流引擎事实。 */
  lifecycle_instances?: Array<Record<string, unknown>>;
  planning_guidance?: Array<{ label: string; text: string; source: string; wave?: string }>;
}

const INDETERMINATE = "INDETERMINATE";
const RUNGS = ["locked", "built", "reviewed", "folded", "adopted"] as const;
type Rung = (typeof RUNGS)[number];
/** 阶梯各层使用的普通用语。 */
const RUNG_WORD: Record<Rung, string> = { locked: "规范锁定", built: "已构建", reviewed: "已评审", folded: "已合并", adopted: "活跃" };
const ACTIVITY_WORD: Record<string, string> = { working: "工作中", claimed: "已认领", "in-progress": "进行中", blocked: "已阻塞" };
const READINESS_WORD: Record<string, string> = { ready: "就绪", pending: "待处理", blocked: "已阻塞" };
const DECLARED_WORD: Record<string, string> = { active: "活跃", done: "完成", wip: "进行中", blocked: "已阻塞", pending: "待处理", spec: "规范" };

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function str(value: unknown, fallback = "?"): string {
  return typeof value === "string" && value !== "" ? value : value == null ? fallback : String(value);
}

function shortSha(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 9) : "?";
}

function clip(text: string, room: number): string {
  return clipW(text, room);
}

type SemanticSeg = NonNullable<ContentLine["segs"]>[number];

function fitSegs(parts: SemanticSeg[], width: number): SemanticSeg[] {
  const out: SemanticSeg[] = [];
  let room = Math.max(0, width);
  for (const part of parts) {
    if (room <= 0) break;
    const partWidth = strWidth(part.text);
    if (partWidth <= room) {
      out.push(part);
      room -= partWidth;
      continue;
    }
    out.push({ ...part, text: clipW(part.text, room) });
    room = 0;
  }
  return out;
}

function semantic(parts: SemanticSeg[], width: number, action?: Action): ContentLine {
  const segs = fitSegs(parts, width);
  return { text: segs.map((part) => part.text).join(""), segs, ...(action ? { action } : {}) };
}

function semanticAction(parts: SemanticSeg[], action: Action, width: number): ContentLine {
  const suffix: SemanticSeg = { text: "  (打开 ▸)", token: "accent", bold: true };
  const body = fitSegs(parts, Math.max(0, width - strWidth(suffix.text)));
  return semantic([...body, suffix], width, action);
}

function stateToken(word: string): Token {
  if (word === "工作中" || word === "done" || word === "结果完成" || word === "active") return "ok";
  if (word === "需要输入" || word === "已阻塞" || word === "parked") return "warn";
  if (word === "failed") return "error";
  return "dim";
}

function open(key: string): Action {
  return { type: "execution-open", key };
}

/** 可钻取行。文本会受限，使“打开”入口在任何 pane 宽度下都能保留；完整事实位于下一层。 */
function actionRow(text: string, action: Action, width = Number.MAX_SAFE_INTEGER): ContentLine {
  const suffix = "  (打开 ▸)";
  return { text: `  ${clip(text, Math.max(width - strWidth(suffix) - 2, 24))}${suffix}`, action };
}

function row(text: string, key: string, width = Number.MAX_SAFE_INTEGER): ContentLine {
  return actionRow(text, open(key), width);
}

// ---- 逐切片事实 ---------------------------------------------------------------

interface RungCell { value: unknown; basis: string; state: "yes" | "no" | "undetermined" }

function rungCell(ladder: Record<string, unknown>, rung: Rung): RungCell {
  const cell = record(ladder[rung]);
  const basis = str(cell["basis"], "依据不可用");
  if (rung === "built") {
    const sha = cell["candidate_sha"];
    return { value: sha, basis, state: typeof sha === "string" && sha !== INDETERMINATE ? "yes" : "undetermined" };
  }
  const value = cell["value"];
  return { value, basis, state: value === true ? "yes" : value === false ? "no" : "undetermined" };
}

/** 实际确认的最高阶梯（true / 构建 SHA）；0 表示无确认项。 */
function reachedRank(cells: Record<Rung, RungCell>): number {
  for (let i = RUNGS.length - 1; i >= 0; i--) if (cells[RUNGS[i]!].state === "yes") return i + 1;
  return 0;
}

/** 证据事实的文字表达：最高已确认阶梯，或没有确认项的原因。 */
function evidenceText(cells: Record<Rung, RungCell>, rank: number): string {
  if (rank === 0) return cells.built.state === "undetermined" ? "无候选已记录" : "无已确认项";
  const rung = RUNGS[rank - 1]!;
  return rung === "built" ? `已构建 ${shortSha(cells.built.value)}` : RUNG_WORD[rung];
}

interface SliceFacts {
  id: string;
  dir: string;
  name: string;
  order: number;
  ladder: Record<string, unknown>;
  readiness: ReadinessSnap | null;
  cells: Record<Rung, RungCell>;
  rank: number;
  sequencing: Record<string, unknown> | null;
  care: Record<string, unknown> | null;
  scope: SliceScopeSnap | null;
  lane: Record<string, unknown> | null;
  work: Array<Record<string, unknown>>;
  plannedOwners: Array<{ component: string; owner: string; source: string }>;
  park: Record<string, unknown> | null;
}

function sliceName(scope: SliceScopeSnap | null, dir: string): string {
  const raw = scope?.displayName ?? dir;
  // ID 列已经说明是哪个切片，名称前的 `Slice 04 —` 属于噪声。
  return raw.replace(/^slice\s+\d+\s*[—–-]\s*/i, "").trim() || dir;
}

function sliceFacts(execution: ExecutionViewSnap, scopes: readonly MissionScopesSnap[] | undefined): SliceFacts[] {
  const missionScopes = scopes?.find((item) => item.mission === execution.mission);
  const seq = execution.q2_sequencing ?? [];
  const care = execution.q3_care ?? [];
  const lanes = execution.q1_lanes ?? [];
  const parks = execution.q5_park ?? [];
  return (execution.q4_ladder ?? []).map((ladder, index) => {
    const id = str(ladder["slice_id"] ?? ladder["dir"]);
    const dir = str(ladder["dir"], id);
    const cells = Object.fromEntries(RUNGS.map((rung) => [rung, rungCell(ladder, rung)])) as Record<Rung, RungCell>;
    const seqIndex = seq.findIndex((item) => item["slice_id"] === id || item["dir"] === dir);
    const scope = missionScopes?.slices.find((slice) => slice.id === id || slice.dirName === dir) ?? null;
    const lane = lanes.find((candidate) => candidate["slice"] === id) ?? null;
    return {
      id,
      dir,
      name: sliceName(scope, dir),
      order: seqIndex >= 0 ? seqIndex : seq.length + index,
      ladder,
      readiness: execution.readiness?.slices.find(s => s.scope === dir)?.readiness ?? scope?.readiness ?? null,
      cells,
      rank: reachedRank(cells),
      sequencing: seqIndex >= 0 ? seq[seqIndex]! : null,
      care: care.find((item) => item["slice_id"] === id) ?? null,
      scope,
      lane,
      work: Array.isArray(seq[seqIndex]?.["work_rows"]) ? seq[seqIndex]!["work_rows"] as Array<Record<string, unknown>> : lane ? [lane] : [],
      plannedOwners: (seq[seqIndex]?.["planned_owners"] ?? []) as Array<{ component: string; owner: string; source: string }>,
      park: lane ? parks.find((item) => item["qitem_id"] === lane["qitem_id"]) ?? null : null,
    };
  }).sort((a, b) => a.order - b.order);
}

/** blocked_on_rows 条目为 `{ qitem_id, blocked_on }`，即切片自身行与它等待的行。
 * 只渲染关系，绝不渲染对象本身。 */
function blockerText(rows: unknown, lead: "blocker" | "row" = "row"): string {
  if (!Array.isArray(rows) || rows.length === 0) return "";
  return rows
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const r = record(entry);
      const own = str(r["qitem_id"], "?");
      const blocker = str(r["blocked_on"], "?");
      return lead === "blocker" ? `等待 ${blocker} · 自身行 ${own}` : `${own} 等待 ${blocker}`;
    })
    .join("; ");
}

/** 声明的工作状态——逐字使用切片文件自身的状态词。 */
function declaredText(slice: SliceFacts): string {
  return slice.scope?.status?.trim().toLowerCase() || "无声明状态";
}

function seatShort(seat: unknown): string {
  const full = str(seat, "");
  return full.includes("@") ? full.slice(0, full.indexOf("@")) : full;
}

/** 切片上的实时问题，以文字表示；没有则为 null。仅凭经过时间绝不能形成判定。 */
function problemText(slice: SliceFacts): string | null {
  const activity = record(slice.lane?.["activity"]);
  const needs = record(activity["needs_input"]);
  if (Number(needs["count"] ?? 0) > 0) return `需要输入: ${str(needs["reason"], String(needs["count"]))}`;
  const blocked = blockerText(slice.sequencing?.["blocked_on_rows"], "blocker");
  if (blocked) return blocked.split(" · own row ")[0]!;
  const pickup = slice.park?.["pickup_state"];
  if (slice.park && pickup !== "working") {
    const age = slice.park["age_minutes"] != null ? ` ${String(slice.park["age_minutes"])} 分` : "";
    return `${str(pickup, INDETERMINATE)}${age}`;
  }
  return null;
}

/** 结果验收、实时工作和作者意图是彼此独立的输入。 */
function outcomeComplete(slice: SliceFacts): boolean {
  const r = slice.readiness;
  return !!r?.configured && r.state === "ready" && r.items.length > 0 && r.items.every(i => i.state === "accepted");
}
function stateWord(slice: SliceFacts): string {
  const problem = problemText(slice);
  if (problem) return problem.startsWith("需要输入") ? "需要输入" : problem.startsWith("等待") ? "已阻塞" : "等待";
  if (record(slice.lane?.["activity"])["activity"] === "working") return "工作中";
  if (slice.work.length) return slice.work.some(w => w["state"] === "blocked") ? "等待" : "已分派";
  if (outcomeComplete(slice)) return "结果完成";
  if (slice.readiness?.items.some(i => i.state === "withdrawn" || i.state === "rejected")) return "已重开";
  if (slice.readiness?.configured) return "结果待处理";
  return declaredText(slice) === "done" ? "已声明完成" : "计划";
}

function proofText(scope: SliceScopeSnap | null): string | null {
  if (!scope) return null;
  if (scope.proof.total === 0) return "无证明契约";
  return `证明 ${scope.proof.paired}/${scope.proof.total}`;
}

function assigneeText(slice: SliceFacts): string | null {
  const owners = [...new Set(slice.work.map(w => seatShort(w["seat"])).filter(Boolean))];
  return owners.length ? owners.join(", ") : null;
}
function plannedOwnerText(slice: SliceFacts): string {
  const build = slice.plannedOwners.filter(p => p.component === "build.minimal-gap");
  return [...new Set((build.length ? build : slice.plannedOwners).map(p => seatShort(p.owner)))].join(", ") || "未知";
}

/** 只有投影明确给出时，才描述下一步会解锁什么。 */
function nextText(slice: SliceFacts): string | null {
  const seq = slice.sequencing;
  if (!seq) return null;
  if (outcomeComplete(slice) || slice.work.length) return null;
  if (seq["next_up"] === true) return "准备开始";
  if (blockerText(seq["blocked_on_rows"])) return null; // the problem column carries it

  const deps = seq["depends_on"];
  if (Array.isArray(deps) && deps.length > 0) return `在 ${deps.map(String).join(", ")} 之后`;
  return null;
}

function waveOf(slice: SliceFacts): string {
  const wave = slice.care?.["build_wave"];
  return typeof wave === "string" && wave !== INDETERMINATE ? wave : "无声明波次";
}

// ---- rows ----------------------------------------------------------------------

function sliceAction(execution: ExecutionViewSnap, slice: SliceFacts): Action {
  void execution;
  return open(`slice:${slice.id}`);
}

function countWords(slices: SliceFacts[]): string {
  const counts = new Map<string, number>();
  for (const slice of slices) counts.set(stateWord(slice), (counts.get(stateWord(slice)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([word, n]) => `${n} ${word}`).join(", ");
}

function waveTitle(wave: string, members: SliceFacts[]): string {
  return `波次 ${wave} · ${members.length} 个切片 · ${countWords(members)}`;
}

function stateMark(word: string): string {
  if (word === "工作中") return "●";
  if (word === "需要输入") return "◐";
  if (word === "已阻塞") return "⚑";
  if (word === "done" || word === "结果完成") return "✓";
  if (word === "failed") return "✕";
  return "○";
}

function padCell(text: string, width: number): string {
  const value = clip(text, width);
  return value + " ".repeat(Math.max(0, width - value.length));
}

function graphNode(slice: SliceFacts, width: number): ContentLine[] {
  const inside = width - 2;
  const state = stateWord(slice);
  const owners = assigneeText(slice);
  const deps = slice.sequencing?.["depends_on"];
  const after = Array.isArray(deps) ? deps.map(String).join(", ") || "未声明" : "未知";
  const cell = (text: string, token: Token): ContentLine => semantic([
    { text: "│", token: "chrome" }, { text: padCell(" " + text, inside), token }, { text: "│", token: "chrome" },
  ], width);
  return [
    semantic([{ text: "┌" + padCell(`─ ${slice.id} `, inside).replace(/ +$/, m => "─".repeat(m.length)) + "┐", token: "accentBright" }], width),
    cell(slice.name, "bright"), cell(`${stateMark(state)} ${state}`, stateToken(state)),
    cell(owners ? `归属: ${owners}` : `计划: ${plannedOwnerText(slice)}`, "dim"),
    cell(`之后: ${after}`, "dim"),
    semantic([{ text: `└${"─".repeat(inside)}┘`, token: "chrome" }], width),
  ];
}

function graphChunk(execution: ExecutionViewSnap, members: SliceFacts[], width: number): ContentLine[] {
  const gap = 2;
  const perRow = width >= 108 ? 3 : width >= 70 ? 2 : 1;
  const nodeWidth = Math.floor((width - gap * (Math.min(perRow, members.length) - 1)) / Math.min(perRow, members.length));
  const out: ContentLine[] = [];
  for (let start = 0; start < members.length; start += perRow) {
    const chunk = members.slice(start, start + perRow);
    const boxes = chunk.map(slice => graphNode(slice, nodeWidth));
    const zones = chunk.map((slice, index) => ({ start: index * (nodeWidth + gap), end: index * (nodeWidth + gap) + nodeWidth, action: sliceAction(execution, slice) }));
    for (let line = 0; line < 6; line++) {
      const segs = boxes.flatMap((box, index) => [...(index ? [{ text: " ".repeat(gap) }] : []), ...box[line]!.segs!]);
      out.push({ text: segs.map(seg => seg.text).join(""), segs, zones });
    }
    if (start + perRow < members.length) out.push(semantic([{ text: "  ↓ 计划顺序中的下一项 · 依赖见上方", token: "chrome" }], width));
  }
  return out;
}

function planningLines(execution: ExecutionViewSnap, width: number, wave?: string, expanded = false): ContentLine[] {
  const guidance = (execution.planning_guidance ?? []).filter(item => item.wave === wave &&
    (expanded || (wave ? item.label !== "Review" : item.label === "Integration decision")));
  if (!guidance.length) return [];
  return wrapDetailLines([
    sectionRule(`撰写指导${wave ? " · " + wave : " · 任务目标"}`, width),
    { text: "  准入规则用于辅助决策。可执行依赖、证明和保管责任是相互独立的事实。" },
    ...guidance.map(item => ({ text: `  ${{ "Integration decision": "集成决策", Admission: "准入", Review: "评审", Exit: "退出条件" }[item.label] ?? item.label}：${item.text}` })),
    { text: `  来源：${guidance[0]!.source.split("#")[0]} · 安排${wave ? ".波次" : ""}` },
  ], width);
}

function waveRows(execution: ExecutionViewSnap, wave: string, members: SliceFacts[], width: number, expanded = false): ContentLine[] {
  const title = waveTitle(wave, members);
  const header = semantic([
    { text: "━ ", token: "chrome" },
    { text: title, token: "bright", bold: true },
    { text: ` ${"━".repeat(width)}`, token: "chrome" },
  ], width);
  return [
    { text: "" }, { ...header, zones: [{ start: 0, end: width, action: open(`group:wave:${wave}`) }] }, ...graphChunk(execution, members, width),
    ...(expanded ? planningLines(execution, width, wave, true) : []),
  ];
}

// ---- 证据缺口：只陈述一次 ----------------------------------------------

interface BasisGroup { basis: string; where: string; members: string[] }

function collectIndeterminate(execution: ExecutionViewSnap, slices: SliceFacts[]): BasisGroup[] {
  const groups = new Map<string, BasisGroup>();
  const add = (where: string, member: string, basis: unknown) => {
    if (typeof basis !== "string") return;
    const key = `${where}|${basis}`;
    const existing = groups.get(key) ?? { basis, where, members: [] };
    if (!existing.members.includes(member)) existing.members.push(member);
    groups.set(key, existing);
  };
  // 只有第一个未确定阶梯是盲点；其上所有阶梯都因此未确定，重复展示只会复述同一事实。
  for (const slice of slices) {
    if (slice.readiness?.configured && slice.cells.built.state !== "yes") continue;
    const first = RUNGS.find((rung) => slice.cells[rung].state === "undetermined");
    if (first) add(RUNG_WORD[first], slice.id, slice.cells[first].basis);
  }
  for (const lane of execution.q1_lanes ?? []) {
    const activity = record(lane["activity"]);
    if (activity["activity"] === INDETERMINATE) add("活动", str(lane["slice"] ?? lane["qitem_id"], "泳道"), activity["basis"]);
  }
  return [...groups.values()].sort((a, b) => b.members.length - a.members.length);
}

function evidenceDetail(execution: ExecutionViewSnap, slices: SliceFacts[], width: number, timeZone = DEFAULT_TIME_ZONE): ContentLine[] {
  const attributed = slices.filter(slice => slice.readiness?.configured);
  const gitBasis = str(record(execution.sources?.["git"])["basis"], "（无 Git 来源单元格）");
  const lines: ContentLine[] = [
    { text: `${execution.mission} · ${attributed.length ? "证明来源" : "证据缺口"} · 派生于 ${displayTime(execution.derived_at, timeZone) || "?"}` },
    { text: "" },
  ];
  if (attributed.length) {
    lines.push(...wrapDetailLines([{ text: "  任务证明修订：" + execution.readiness!.revision }], width));
    for (const slice of attributed) lines.push(
      { text: "" }, listItem(slice.id + " · " + slice.name, open(`slice:${slice.id}`)),
      ...proofProvenanceLines(slice.readiness, width),
    );
  } else {
    lines.push(...wrapDetailLines([{ text: "  声明状态来自每个切片文件。旧版代码证据使用候选标签、评审记录和 Git。未确认即未知，不能据此认定工作正在等待或已经完成。" }], width));
  }
  lines.push({ text: "" }, sectionRule("代码谱系 · 与条目判定分开", width),
    { text: `  Git：        ${gitBasis}` },
    ...wrapDetailLines([{ text: "  构建、评审、合并和实时运行事实仍以各切片的代码证据为准。产物验收不会提供这些代码事实。" }], width));
  for (const item of collectIndeterminate(execution, slices)) {
    lines.push({ text: "" }, sectionRule(`${item.where} 已构建未确认 · ${item.members.length} 个切片`, width));
    lines.push({ text: `  依据：       ${item.basis}` });
    for (const member of item.members) lines.push(listItem(member, open(`slice:${member}`)));
  }
  lines.push({ text: "" }, row("投影来源与派生基础", "sources", width), { text: "" }, back());
  return lines;
}

// ---- overview ----------------------------------------------------------------------

function overviewLines(execution: ExecutionViewSnap, scopes: readonly MissionScopesSnap[] | undefined, width: number, timeZone = DEFAULT_TIME_ZONE): ContentLine[] {
  const slices = sliceFacts(execution, scopes);
  const live = slices.filter(slice => stateWord(slice) === "工作中").length;
  const problems = slices.filter(slice => problemText(slice)).length;
  const build = shortSha(record(execution.sources?.["build_info"])["commit"]);
  const active = slices.filter(slice => slice.work.length || problemText(slice));
  const needsHuman = slices.filter(slice => problemText(slice)?.startsWith("需要输入"));
  const attributed = slices.some(slice => slice.readiness?.configured);
  const done = slices.filter(outcomeComplete).length;
  const allComplete = slices.length > 0 && done === slices.length;
  const next = slices.find(slice => nextText(slice) === "准备开始") ?? slices.find(slice => !outcomeComplete(slice) && !slice.work.length);
  const unknown = slices.filter(slice => !slice.readiness?.configured).length;
  const missionState = allComplete ? "结果完成" : "结果开放";
  const missionToken: Token = problems ? "warn" : allComplete ? "ok" : "dim";
  const nowText = active.length ? active.map(slice => `${slice.id} · ${assigneeText(slice) ?? "所有者未知"} · ${stateWord(slice)}`).join("; ") : "此读取中无开放切片工作";
  const nextValue = next ? `${next.id} · ${nextText(next) ?? "依赖资格未知"}`
    : allComplete ? "结果已完成；发布决策独立"
    : active.length ? "等待当前工作；结果仍开放"
    : "下一项资格未知";
  const progress = `${done}/${slices.length} 结果完成 · ${live} 工作中${problems ? ` · ${problems} 等待` : ""}${unknown ? ` · ${unknown} 证明未知` : ""}`;
  const fact = (label: string, value: string, token: Token): ContentLine => semantic([
    { text: `  ${padEndW(label, 10)}`, token: "dim", bold: true },
    { text: value, token },
  ], width);
  const lines: ContentLine[] = [semantic([
    { text: execution.mission, token: "accentBright", bold: true },
    { text: " · ", token: "chrome" },
    { text: execution.lifecycle_instances?.length ? `切片: ${missionState}` : missionState, token: missionToken, bold: true },
    { text: " · ", token: "chrome" },
    { text: `${slices.length} 个切片`, token: "bright" },
  ], width)];

  lines.push(fact("现在", nowText, active.length ? "ok" : "dim"));
  if (active.length) {
    const first = active[0]!;
    const detail = problemText(first) ?? str(first.work[0]?.["summary"], "打开切片查看队列和活动证据");
    lines.push(semanticAction([{ text: "  " + detail, token: problemText(first) ? "warn" : "bright" }], sliceAction(execution, first), width));
  }
  lines.push(fact("下一个", nextValue, next ? "accentBright" : "dim"));
  lines.push(fact("进度", progress, "bright"));
  lines.push(fact("生命周期", `${execution.readiness?.historicalStatus === "unknown" ? "未知" : (execution.readiness?.historicalStatus ?? "未知")} · 独立于结果`, "dim"));
  if (needsHuman.length) {
    const first = needsHuman[0]!;
    lines.push(semanticAction([
      { text: "  ⚑ 需要人类 ", token: "warn", bold: true },
      { text: `${needsHuman.map((slice) => slice.id).join(", ")} · ${problemText(first)}`, token: "bright" },
    ], sliceAction(execution, first), width));
  }
  const waves = new Map<string, SliceFacts[]>();
  for (const slice of slices) waves.set(waveOf(slice), [...(waves.get(waveOf(slice)) ?? []), slice]);
  for (const [wave, members] of waves) lines.push(...waveRows(execution, wave, members, width));
  const provenanceAction = attributed || unknown > 0 ? open("evidence") : open("sources");
  const provenance: SemanticSeg[] = [
    { text: "  来源 · ", token: "dim" },
    { text: attributed ? `证明判断 · ${done}/${slices.length} 就绪${unknown ? ` · ${unknown} 遗留未知` : ""}` : unknown > 0 ? `证据缺口 ${unknown}/${slices.length} 未知` : `构建 ${build}`, token: unknown > 0 || (attributed && execution.readiness!.state === "unknown") ? "warn" : "dim" },
  ];
  const localTime = displayTime(execution.derived_at, timeZone);
  if (provenance.reduce((n, s) => n + strWidth(s.text), 0) + strWidth(localTime) + 3 <= width) {
    provenance.push({ text: ` · ${localTime}`, token: "dim" });
    lines.push(semanticAction(provenance, provenanceAction, width));
  } else {
    lines.push(semanticAction(provenance, provenanceAction, width));
    lines.push(...wrapDetailLines([{ text: `  derived ${localTime}` }], width));
  }
  lines.push(...lifecycleLines(execution, width));
  lines.push(...planningLines(execution, width));

  if (slices.length === 0) lines.push({ text: "  (此任务目标无切片)" });
  return lines;
}

const lifecycleLines = workflowOverview;

function waveDetail(execution: ExecutionViewSnap, scopes: readonly MissionScopesSnap[] | undefined, width: number, key: string): ContentLine[] | null {
  const wave = key.slice("group:wave:".length);
  const slices = sliceFacts(execution, scopes);
  const members = slices.filter((slice) => waveOf(slice) === wave);
  if (members.length === 0) return null;
  return [
    { text: `${execution.mission} · 波次 ${wave} · 全部 ${members.length} 行` },
    ...planningLines(execution, width),
    ...waveRows(execution, wave, members, width, true),
    { text: "" },
    back(),
  ];
}

// ---- 详情页面 -----------------------------------------------------------------

function back(): ContentLine {
  return { text: "  Esc 返回 · ⏎ 打开 · : 命令面板" };
}

function laneKey(lane: Record<string, unknown>): string {
  return `lane:${str(lane["qitem_id"], "未知")}`;
}

function card(title: string, rows: ContentLine[], width: number): ContentLine[] {
  const w = Math.max(28, width);
  const label = ` ${title} `;
  const top = `┌─${label}${"─".repeat(Math.max(0, w - strWidth(label) - 3))}┐`;
  return [
    { text: clip(top, w) },
    ...rows.map((item) => {
      const suffix = item.action ? "  (打开 ▸)" : "";
      const value = clip(item.text.trim(), Math.max(1, w - 4 - strWidth(suffix)));
      return { ...item, text: `│ ${padCell(value + suffix, w - 4)} │` };
    }),
    { text: `└${"─".repeat(w - 2)}┘` },
  ];
}

function cardField(label: string, value: string, action?: Action): ContentLine {
  return { text: `${padEndW(`${label}:`, 13)} ${value}`, ...(action ? { action } : {}) };
}

function wrapWords(text: string, width: number): string[] {
  const room = Math.max(1, width);
  const out: string[] = [];
  let line = "";
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    let word = raw;
    while (strWidth(word) > room) {
      if (line) { out.push(line); line = ""; }
      const chunk = clipW(word, room + 1).slice(0, -1);
      out.push(chunk);
      word = word.slice(chunk.length);
    }
    if (!word) continue;
    if (!line) line = word;
    else if (strWidth(line) + strWidth(word) + 1 <= room) line += ` ${word}`;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

function wrappedCardField(label: string, value: string, width: number): ContentLine[] {
  const prefix = `${padEndW(`${label}:`, 13)} `;
  const continuation = " ".repeat(strWidth(prefix));
  const firstRoom = Math.max(8, width - 4 - strWidth(prefix));
  const chunks = wrapWords(value, firstRoom);
  return chunks.map((chunk, index) => ({ text: `${index === 0 ? prefix : continuation}${chunk}` }));
}

function touchedRows(detail: SliceDetailSnap | null, width: number, timeZone = DEFAULT_TIME_ZONE): ContentLine[] {
  if (!detail) return [cardField("已送达数据", "此选择的切片详情未加载")];
  const latest = new Map<string, SliceDetailSnap["story"]["events"][number]>();
  for (const event of detail.story.events) if (event.actorSession) latest.set(event.actorSession, event);
  if (latest.size === 0) return [cardField("执行者", "已服务切片事件历史中无记录")];
  const limit = width < 70 ? 1 : 3;
  const shown = [...latest.entries()].sort((a, b) => b[1].ts.localeCompare(a[1].ts)).slice(0, limit);
  return [
    ...shown.flatMap(([actor, event]) => [
      ...wrappedCardField("执行者", actor, width),
      ...wrappedCardField("最近变更", `${displayTime(event.ts, timeZone) || event.ts} · ${event.kind}${event.qitemId ? ` · ${event.qitemId}` : ""}`, width),
    ]),
    cardField("历史", `${latest.size} 个已服务执行者 · 显示最新 ${shown.length} 个`),
  ];
}

function rulingRows(detail: SliceDetailSnap | null, width: number, timeZone = DEFAULT_TIME_ZONE): ContentLine[] {
  if (!detail) return [cardField("已送达数据", "此选择的切片详情未加载")];
  const latest = [...detail.decisions.rows].sort((a, b) => b.ts.localeCompare(a.ts))[0];
  if (!latest) return [cardField("决策", "已服务切片决策历史中无记录")];
  return [
    ...wrappedCardField("执行者", `${latest.actor} · ${displayTime(latest.ts, timeZone) || latest.ts} · ${latest.verb}`, width),
    ...wrappedCardField("队列项", latest.qitemId, width),
    ...wrappedCardField("决策", latest.reason ?? "未提供决策原因", width),
    cardField("历史", `${detail.decisions.rows.length} 条已服务决策 · 显示最新一条`),
  ];
}

function sliceDetail(
  execution: ExecutionViewSnap,
  slices: SliceFacts[],
  id: string,
  width: number,
  richDetail?: SliceDetailSnap | null,
  scopeOpts: { collapseReqs: boolean; narrative: boolean } = { collapseReqs: false, narrative: false },
  timeZone = DEFAULT_TIME_ZONE,
): ContentLine[] | null {
  const slice = slices.find((item) => item.id === id || item.dir === id);
  if (!slice) return null;
  const detail = richDetail?.name === slice.dir ? richDetail : null;
  const activity = record(slice.lane?.["activity"]);
  const needs = problemText(slice);
  const deps = Array.isArray(slice.sequencing?.["depends_on"]) ? (slice.sequencing!["depends_on"] as unknown[]).map(String) : [];
  const unlocks = slices.filter((candidate) => {
    const candidateDeps = candidate.sequencing?.["depends_on"];
    return Array.isArray(candidateDeps) && candidateDeps.map(String).includes(slice.id);
  }).map((candidate) => candidate.id);
  const ownership: ContentLine[] = [
    cardField("席位", slice.lane ? str(slice.lane["seat"]) : "无 — 无认领泳道", slice.lane ? open(laneKey(slice.lane)) : undefined),
    cardField("活动", slice.lane ? (ACTIVITY_WORD[str(activity["activity"], INDETERMINATE)] ?? str(activity["activity"], "已认领")) : "未分配"),
    cardField("决定于", slice.lane ? str(activity["decided_by"] ?? activity["basis"], "依据不可用") : "—"),
    cardField("变更于", slice.lane ? str(activity["changed_at"], "—") : "—"),
  ];
  const evidence: ContentLine[] = [];
  for (const rung of RUNGS) {
    const cell = slice.cells[rung];
    const value = rung === "built" ? (cell.state === "yes" ? shortSha(cell.value) : "undetermined") : cell.state;
    evidence.push(cardField(RUNG_WORD[rung], `${value} · ${cell.basis}`));
  }
  const legs = record(slice.ladder["reviewed"])["legs"];
  if (Array.isArray(legs)) for (const leg of legs) {
    const l = record(leg);
    evidence.push(cardField("评审腿", `${str(l["verdict"], "?")} · ${str(l["artifact_type"], "?")} · ${str(l["path"])}`));
  }
  const typedRows: ContentLine[] = slice.lane ? [
    cardField("队列项", str(slice.lane["qitem_id"]), open(laneKey(slice.lane))),
    cardField("认领", str(record(slice.lane["pickup"])["state"], str(slice.park?.["pickup_state"], INDETERMINATE))),
    cardField("需要输入", Number(record(activity["needs_input"])["count"] ?? 0) > 0 ? str(record(activity["needs_input"])["reason"], "input") : "none"),
    cardField("仓库连接", `${str(slice.lane["worktree_path"], INDETERMINATE)} · ${str(slice.lane["branch"], INDETERMINATE)}`),
  ] : [cardField("行", "无——此切片没有类型化队列行")];
  if (slice.park) typedRows.push(cardField("暂存", `${str(slice.park["pickup_state"], INDETERMINATE)} · 唤醒 ${str(slice.park["wake_target"], "无已武装")}`));

  const dependencies: ContentLine[] = [
    cardField("波次", waveOf(slice)),
    cardField("依赖于", deps.join(", ") || "无"),
    cardField("解锁", unlocks.join(", ") || "无"),
    cardField("下一个", nextText(slice) ?? "未派生下一转换"),
    cardField("已阻塞于", blockerText(slice.sequencing?.["blocked_on_rows"]) || "无"),
  ];

  const source = record(slice.sequencing?.["source"]);
  const sourceRows = [
    cardField("规范", str(source["spec_path"], "未命名")),
    cardField("安排", str(source["arrangement_path"], "未命名")),
    cardField("波次映射", str(source["wave_map_row"], "未命名")),
  ];
  const identity = slice.scope
    ? scopeIdentityLines(slice.scope, execution.mission, width)
    : [
      { text: clip(`${slice.id} · ${slice.name} · ${stateMark(stateWord(slice))} ${stateWord(slice)} · 波次 ${waveOf(slice)}`, width) },
    ];
  const authored = slice.scope
    ? scopeContractLines(slice.scope, { ...scopeOpts, width })
    : [{ text: "" }, ...card("作者声明的契约", [cardField("状态", "未提供工作范围详情")], width)];
  return [
    ...identity,
    { text: "" }, ...card("归属", ownership, width),
    { text: "" }, ...card("已触及", touchedRows(detail, width, timeZone), width),
    { text: "" }, ...proofProvenanceLines(slice.readiness, width),
    { text: "" }, ...card(`${slice.readiness?.configured ? "代码谱系" : "证据"} · 已声明${DECLARED_WORD[declaredText(slice)?.toLowerCase() ?? ""] ?? declaredText(slice) ?? "无声明状态"} · ${evidenceText(slice.cells, slice.rank)}`, evidence, width),
    { text: "" }, ...card("裁决", rulingRows(detail, width, timeZone), width),
    { text: "" }, ...card("需要你", [cardField("状态", needs ?? "当前投影无")], width),
    ...wrapDetailLines([
      { text: `结果: ${outcomeComplete(slice) ? "完成 — 所有当前必需判断已接受" : "未完成 / 证明待处理或未知"}` },
      ...slice.work.map(w => ({ text: `队列 ${str(w["qitem_id"])} · ${str(w["state"], "已分派")} · 所有者 ${str(w["seat"])} · ${str(w["summary"], "")}${w["blocked_on"] ? ` · 等待 ${str(w["blocked_on"])}` : ""}` })),
      ...slice.plannedOwners.map(p => ({ text: `计划 ${p.component}: ${p.owner} · ${p.source}` })),
      { text: "调度：仅依赖顺序；预计完成时间未知。" },
    ], width),
    { text: "" }, ...card("类型化行", typedRows, width),
    { text: "" }, ...planningLines(execution, width), ...planningLines(execution, width, waveOf(slice), true),
    { text: "" }, ...card("依赖", dependencies, width),
    ...authored,
    { text: "" }, ...card("来源", sourceRows, width),
    { text: "" }, back(),
  ];
}

function laneDetail(execution: ExecutionViewSnap, key: string): ContentLine[] | null {
  const lane = (execution.q1_lanes ?? []).find((item) => laneKey(item) === key);
  const park = (execution.q5_park ?? []).find((item) => `lane:${str(item["qitem_id"])}` === key || `park:${str(item["qitem_id"])}` === key);
  if (!lane && !park) return null;
  const activity = record(lane?.["activity"]);
  const needs = record(activity["needs_input"]);
  const sections: Section[] = [];
  if (lane) {
    sections.push({
      title: "泳道",
      fields: [
        { label: "队列项", value: str(lane["qitem_id"]) },
        { label: "切片", value: str(lane["slice"]), link: open(`slice:${str(lane["slice"])}`) },
        { label: "席位", value: str(lane["seat"]) },
        { label: "活动", value: ACTIVITY_WORD[str(activity["activity"], INDETERMINATE)] ?? str(activity["activity"], "已认领") },
        { label: "决定于", value: str(activity["decided_by"] ?? activity["basis"], "依据不可用") },
        { label: "变更于", value: str(activity["changed_at"], "—") },
        
        { label: "认领", value: str(record(lane["pickup"])["state"], INDETERMINATE) },
        { label: "来源", value: str(activity["source"], "(未命名)") },
      ],
    });
    if (Number(needs["count"] ?? 0) > 0) {
      sections.push({ title: "", fields: [{ label: "", value: `需要输入: ${str(needs["count"])} · ${str(needs["reason"], "输入")}` }] });
    }
    sections.push({
      title: `仓库关联${lane["fragile_join"] === true ? " · 脆弱" : ""}`,
      fields: [
        { label: "工作树", value: str(lane["worktree_path"], INDETERMINATE) },
        { label: "分支", value: str(lane["branch"], INDETERMINATE) },
        { label: "头指针", value: str(lane["head_sha"], INDETERMINATE) },
        { label: "关联依据", value: str(lane["join_basis"], "(未命名)") },
      ],
    });
  }
  if (park) {
    sections.push({
      title: "认领 · 停放行",
      fields: [
        { label: "队列项", value: str(park["qitem_id"]) },
        { label: "认领", value: str(park["pickup_state"], INDETERMINATE) },
        { label: "类型", value: str(park["park_kind"], "不确定") },
        { label: "依据", value: str(park["park_kind_basis"], "(未命名)") },
        { label: "唤醒目标", value: str(park["wake_target"], "未设置") },
        { label: "时长", value: park["age_minutes"] != null ? `${String(park["age_minutes"])} 分钟前认领` : "—" },
        ...(park["pickup_evidence"] ? [{ label: "证据", value: str(park["pickup_evidence"]) }] : []),
      ],
    });
  }
  const heading = lane ? `泳道 ${str(lane["slice"])} · ${str(lane["seat"])}` : `行 ${str(park?.["qitem_id"])}`;
  return [...detailPage({ text: heading }, sections), { text: "" }, back()];
}

function sourcesDetail(execution: ExecutionViewSnap, timeZone = DEFAULT_TIME_ZONE, width = 96): ContentLine[] {
  const lines: ContentLine[] = [{ text: `${execution.mission} 的来源 · 派生于 ${displayTime(execution.derived_at, timeZone) || "?"}` }];
  for (const [name, raw] of Object.entries(execution.sources ?? {})) {
    const cell = record(raw);
    lines.push({ text: "" });
    lines.push(sectionRule(name));
    for (const [field, value] of Object.entries(cell)) lines.push({ text: `  ${`${field}:`.padEnd(12)} ${str(value, "—")}` });
    if (Object.keys(cell).length === 0) lines.push({ text: `  ${str(raw, "—")}` });
  }
  lines.push({ text: "" });
  lines.push(...planningLines(execution, width, undefined, true));
  lines.push(back());
  return lines;
}

export function executionContentLines(
  execution: ExecutionViewSnap | null | undefined,
  scopes: readonly MissionScopesSnap[] | undefined,
  readErrors: readonly string[],
  opened: string | null,
  width = 96,
  pending = false,
  sliceDetailRead?: SliceDetailSnap | null,
  scopeOpts: { collapseReqs: boolean; narrative: boolean } = { collapseReqs: false, narrative: false },
  timeZone = DEFAULT_TIME_ZONE,
): ContentLine[] {
  if (!execution) {
    const failure = readErrors.find((entry) => entry.startsWith("execution:"));
  // 三种不同真相绝不能合并为一条消息：读取失败（有明确名称）、读取尚未应答（pending），
  // 或读取已经应答但完全没有执行行。
    const mappedFailure = failure
      ? failure.replace(/^execution:/, "执行:").replace(/daemon read failed/i, "后台服务读取失败")
      : failure;
    if (failure) return [sectionRule("待关注  1", width), { text: `  执行投影不可用 — ${mappedFailure}` }];
    if (pending) return [{ text: "  执行投影: 读取挂起 — 首次后台服务读取尚未应答（诚实空，非虚构）" }];
    return [sectionRule("待关注  1", width), { text: "  执行投影无行返回 — 后台服务上未解析到活跃任务目标" }];
  }
  if (opened) {
    const slices = sliceFacts(execution, scopes);
    const page = opened.startsWith("workflow:") || opened.startsWith("packet:")
      ? workflowDetail(execution, opened, width, timeZone)
      : opened === "sources"
      ? sourcesDetail(execution, timeZone, width)
      : opened === "evidence"
        ? evidenceDetail(execution, slices, width, timeZone)
      : opened.startsWith("group:wave:")
        ? waveDetail(execution, scopes, width, opened)
      : opened.startsWith("slice:")
        ? sliceDetail(execution, slices, opened.slice("slice:".length), width, sliceDetailRead, scopeOpts, timeZone)
        : opened.startsWith("lane:") || opened.startsWith("park:")
          ? laneDetail(execution, opened)
          : null;
    return page ?? [{ text: `  ${opened} 不在当前快照中（可能已关闭或重新派生）` }, { text: "" }, back()];
  }
  return overviewLines(execution, scopes, width, timeZone);
}

/** 嵌入现有丰富 SCOPES 切片详情中的紧凑、基于来源的执行条带。投影或切片数据缺失时
 * 明确展示，绝不推断。 */
export function executionSliceStripLines(
  execution: ExecutionViewSnap | null | undefined,
  sliceId: string,
  sliceDir: string,
  width = 96,
  declared?: string | null,
): ContentLine[] {
  if (!execution) return [{ text: "" }, sectionRule("执行 · 未加载", width), { text: "  此选择未加载任务目标执行投影" }];
  const slice = sliceFacts(execution, undefined).find((item) => item.id === sliceId || item.dir === sliceDir);
  if (!slice) return [{ text: "" }, sectionRule("执行 · 不在投影中", width), { text: "  切片不在任务目标执行投影中" }];
  const activity = record(slice.lane?.["activity"]);
  const problem = problemText(slice);
  const unconfirmed = RUNGS.filter((rung) => slice.cells[rung].state === "undetermined").map((rung) => RUNG_WORD[rung]);
  const evidence = `${evidenceText(slice.cells, slice.rank)}${unconfirmed.length ? ` · ${unconfirmed.join(" / ")} 未确认 (${slice.cells[RUNGS.find((rung) => slice.cells[rung].state === "undetermined")!].basis})` : ""}`;
  const liveWord = slice.lane ? (ACTIVITY_WORD[str(activity["activity"], "claimed")] ?? str(activity["activity"], "已认领")) : "无认领泳道";
  const declaredRaw = declared?.trim().toLowerCase() || "无声明状态";
  const declaredWord = DECLARED_WORD[declaredRaw] ?? declaredRaw;
  const next = declaredRaw === "done" && !slice.lane
    ? "无 — 已声明完成"
    : nextText(slice) ?? (slice.lane ? "在上游泳道进行中" : "投影无法排序的内容");
  const readinessWord = slice.readiness ? (READINESS_WORD[slice.readiness.state] ?? slice.readiness.state) : null;
  return [
    { text: "" },
    sectionRule(`执行 · ${problem ? stateWord(slice) : liveWord} · 波次 ${waveOf(slice)}`, width),
    ...workflowOverview(execution, width),
    { text: `  已声明    ${declaredWord} (切片文件)` },
    actionRow(slice.readiness?.configured && readinessWord ? `证明 ${readinessWord} · 检查判断和证据` : `证据    ${evidence}`, open("evidence"), width),
    { text: `  分配  ${slice.lane ? `${str(slice.lane["seat"])} · ${ACTIVITY_WORD[str(activity["activity"], INDETERMINATE)] ?? str(activity["activity"], "已认领")} (${str(activity["decided_by"], "?")})` : "无 — 无认领泳道"}`, ...(slice.lane ? { action: open(laneKey(slice.lane)) } : {}) },
    { text: `  下一步      ${next}` },
    { text: `  问题        ${problem ?? "投影当前表面无问题"}` },
    ...planningLines(execution, width), ...planningLines(execution, width, waveOf(slice), true),
  ];
}
