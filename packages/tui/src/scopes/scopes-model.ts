// 范围视图——纯资源管理器行 + 内容行，基于直接存储的后台服务数据。
// 创建者实时 QA 用紧凑语义
// 头部和响应式意图 / 需求 / 证明区域取代了原始装饰性散文框。PROGRESS.md 仍仅在
// `n` 叙事面板渲染，绝不在状态、证明或锁定事实中。
import type { Action, ExplorerRow } from "../types.js";
import type { ContentLine } from "../detail.js";
import type { Token } from "../theme.js";
import { padEndW, clipW, strWidth } from "../text-width.js";

export interface ScopeDropRef { file: string; artifactType: string | null; verdict: string | null; media: string[] }
export interface ScopeContractItem { id?: string; source?: { file: string; line: number }; index: number; text: string; paired: boolean; drops: ScopeDropRef[] }
export interface ScopeLocksSnap { spec: { by: string; at: string } | null; delivery: { by: string; at: string } | null }
export interface ReadinessSnap {
  configured: boolean; state: string; revision: string;
  issues?: string[];
  history?: Array<{ ref: string; id: string; verdict: string; previous: string | null }>;
  items: Array<{ id: string; index: number; text: string; state: string; reason: string; judgment: {
    id: string; actor?: string; at?: string; verdict?: string; previous?: string | null;
    subject?: { kind: string; ref: string; comparison?: string };
    evidence?: Array<{ ref: string; sha256: string }>;
  } | null }>;
}
export interface SliceScopeSnap {
  error?: string;
  sourcePath?: string;
  readiness?: ReadinessSnap;
  dirName: string;
  id: string | null;
  displayName: string;
  status: string | null;
  stage: string | null;
  locks: ScopeLocksSnap;
  proof: { paired: number; total: number };
  intent: string;
  miniRequirements: string[];
  proofContract: ScopeContractItem[];
  narrative: string | null;
  specShaShort: string | null;
  prdExists: boolean;
}
export interface MissionScopesSnap { mission: string; slices: SliceScopeSnap[]; error?: string }

/** 仅翻译展示标签；原始状态值继续用于协议和业务判断。 */
function scopeStatusLabel(value: string): string {
  return {
    active: "活跃", building: "构建中", spec: "规范", done: "已完成", pending: "待处理",
    blocked: "已阻塞", ready: "就绪", accepted: "已接受", rejected: "已拒绝",
    withdrawn: "已撤回", unknown: "未知", paired: "已配对", unpaired: "未配对",
  }[value.toLowerCase()] ?? value;
}

/** 切片状态字形（mock：● 构建中/规范 · ✓ 交付锁定 · ⊙ 其他/空闲）。 */
export function sliceGlyph(s: SliceScopeSnap): string {
  if (s.error) return "!";
  if (s.readiness?.configured) return s.readiness.state === "ready" ? "✓" : "⊙";
  if (s.locks.delivery) return "✓";
  if (s.stage === "building" || s.status === "building" || s.status === "spec") return "●";
  return "⊙";
}

/** 创建者锁定字形形式：`证明: N/M 🔒` 仅在交付锁定时——无删除令牌，
 *  无未证明后缀；可见计数携带诚实（4/6 🔒 显示部分）。 */
export function proofBadge(s: SliceScopeSnap): string {
  if (s.readiness?.configured) return `已接受: ${s.readiness.items.filter(i => i.state === "accepted").length}/${s.readiness.items.length} · ${scopeStatusLabel(s.readiness.state)}`;
  const base = `证明: ${s.proof.paired}/${s.proof.total} 已配对`;
  return s.locks.delivery ? `${base} 🔒` : base;
}

export function scopesExplorerRows(
  scopes: readonly MissionScopesSnap[] | undefined,
  expanded: ReadonlySet<string>,
  indent: string,
): ExplorerRow[] {
  const rows: ExplorerRow[] = [];
  if (!scopes) return rows;
  for (const m of scopes) {
    const key = `scopes-mission:${m.mission}`;
    const open = expanded.has(key);
    rows.push({
      label: `${indent}${open ? "▾" : "▸"} ${m.mission}${m.error ? " · 不可用" : ""}`,
      action: { type: "scopes-mission-open", mission: m.mission },
      disclosureAction: { type: "toggle-expand", key },
      key,
    });
    if (!open) continue;
    for (const s of m.slices) {
      rows.push({
        label: `${indent}  ${sliceGlyph(s)} ${s.dirName}`,
        action: { type: "scopes-open", mission: m.mission, slice: s.dirName },
        key: `scopes-slice:${m.mission}/${s.dirName}`,
      });
    }
  }
  return rows;
}

type Seg = NonNullable<ContentLine["segs"]>[number];

function semantic(parts: Seg[], width: number, action?: Action): ContentLine {
  const segs: Seg[] = [];
  let room = Math.max(0, width);
  for (const part of parts) {
    if (room <= 0) break;
    const partWidth = strWidth(part.text);
    if (partWidth <= room) {
      segs.push(part);
      room -= partWidth;
    } else {
      segs.push({ ...part, text: clipW(part.text, room) });
      room = 0;
    }
  }
  return { text: segs.map((part) => part.text).join(""), segs, ...(action ? { action } : {}) };
}

function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  const limit = Math.max(1, width);
  for (const paragraph of text.split("\n")) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) { out.push(""); continue; }
    let line = "";
    for (const original of words) {
      let word = original;
      while (strWidth(word) > limit) {
        if (line) { out.push(line); line = ""; }
        let used = 0;
        let end = 0;
        for (const char of word) {
          const charWidth = strWidth(char);
          if (used + charWidth > limit) break;
          used += charWidth;
          end += char.length;
        }
        const chunk = word.slice(0, end || 1);
        out.push(chunk);
        word = word.slice(chunk.length);
      }
      if (!word) continue;
      if (!line) line = word;
      else if (strWidth(line) + 1 + strWidth(word) <= limit) line += ` ${word}`;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [""];
}

function rule(title: string, width: number): ContentLine {
  const head = `  ── ${title} `;
  return semantic([
    { text: "  ── ", token: "chrome" },
    { text: title, token: "bright", bold: true },
    { text: ` ${"─".repeat(Math.max(4, width - strWidth(head)))}`, token: "chrome" },
  ], width);
}

function wrapped(text: string, width: number, indent: string, token: Token = "bright"): ContentLine[] {
  return wrapText(text, Math.max(1, width - strWidth(indent))).map((part) => semantic([
    { text: indent },
    { text: part, token },
  ], width));
}

/** 渲染权威读取模型，包括已失效和已更正收据。
 * 可选字段将旧后台服务的不完整投影显式保持未知。 */
export function proofProvenanceLines(proof: ReadinessSnap | null | undefined, width: number): ContentLine[] {
  if (!proof?.configured) return [];
  const lines: ContentLine[] = [rule("证明裁决 · " + proof.state.toUpperCase(), width)];
  const add = (text: string, token: Token = "dim") => lines.push(...wrapped(text, width, "  ", token));
  add("修订: " + proof.revision);
  add("条目接受不建立代码构建、合并、运行时采用或发布。");
  for (const issue of proof.issues ?? []) add(issue, "warn");
  if (!proof.items.length) add("无可用条目裁决；检查上述合同和问题。", "warn");
  for (const item of proof.items) {
    lines.push({ text: "" });
    add("条目 " + item.index + " · " + item.state.toUpperCase() + " · " + item.text, item.state === "accepted" ? "ok" : "warn");
    add(item.reason, item.state === "unknown" ? "warn" : "dim");
    const judgment = item.judgment;
    if (!judgment) { add("无当前归属裁决。", "warn"); continue; }
    add("主体: " + (judgment.subject ? judgment.subject.kind + " · " + judgment.subject.ref : "未知——主体未服务"));
    if (judgment.subject?.comparison) add("比较: " + judgment.subject.comparison);
    add("操作者: " + (judgment.actor ?? "未知——操作者未服务") + " · 记录于 " + (judgment.at ?? "未知"));
    add("收据: " + judgment.id + " · 记录裁决 " + (judgment.verdict ?? "未知"));
    if (judgment.previous) add("更正: " + judgment.previous);
    for (const evidence of judgment.evidence ?? []) {
      add("证据: " + evidence.ref);
      add("SHA256: " + evidence.sha256);
    }
    if (!judgment.evidence?.length) add("证据引用未服务。", "warn");
  }
  if (proof.history?.length) {
    lines.push({ text: "" });
    add("保留历史（历史裁决；当前处置如上）:");
    for (const receipt of proof.history) add(receipt.verdict + " · " + receipt.id + " · " + receipt.ref);
  }
  return lines;
}

function itemState(detail: SliceScopeSnap, item: ScopeContractItem): string {
  if (detail.readiness?.configured) {
    const state = detail.readiness.items.find(i => item.id !== undefined && i.id === item.id)?.state;
    return state ? scopeStatusLabel(state) : "未知";
  }
  return item.paired ? "已配对" : "未配对";
}
function proofColumns(detail: SliceScopeSnap, width: number): ContentLine[] {
  const stateW = 8;
  const indexW = 3;
  const evidenceW = Math.max(20, Math.floor(width * 0.28));
  const requirementW = Math.max(18, width - 17 - evidenceW);
  const column = (
    state: string,
    index: string,
    requirement: string,
    evidence: string,
    stateToken: Token = "dim",
    evidenceToken: Token = "dim",
  ): ContentLine => semantic([
    { text: "  " },
    { text: padEndW(state, stateW), token: stateToken, bold: !!state.trim() },
    { text: " " },
    { text: padEndW(index, indexW), token: "accentBright", bold: !!index.trim() },
    { text: " " },
    { text: padEndW(requirement, requirementW), token: requirement.trim() ? "bright" : undefined },
    { text: "  " },
    { text: padEndW(evidence, evidenceW), token: evidenceToken },
  ], width);
  const lines = [column("状态", "#", "需求", "证据", "accentBright", "accentBright")];
  for (const item of detail.proofContract) {
    const requirements = wrapText(item.text, requirementW);
    const evidence: Array<{ text: string; token: Token }> = [];
    const judgment = detail.readiness?.items.find(i => item.id !== undefined && i.id === item.id);
    if (judgment?.judgment) evidence.push({ text: `裁决 ${judgment.judgment.id.slice(0, 12)}: ${judgment.reason}`, token: judgment.state === "accepted" ? "ok" : "warn" });
    if (item.drops.length === 0 && !judgment?.judgment) evidence.push({ text: "未记录", token: "warn" });
    for (const drop of item.drops) {
      evidence.push({ text: `↳ ${(drop.artifactType ?? "drop").toUpperCase()} ${drop.verdict ?? ""}`.trimEnd(), token: drop.verdict === "PASS" || drop.verdict === "CLEAR" ? "ok" : "dim" });
      evidence.push(...wrapText(drop.file, evidenceW).map((text) => ({ text, token: "dim" as Token })));
      for (const media of drop.media) evidence.push(...wrapText(`媒体 ${media}`, evidenceW).map((text) => ({ text, token: "dim" as Token })));
    }
    const count = Math.max(requirements.length, evidence.length, 1);
    for (let i = 0; i < count; i += 1) {
      lines.push(column(
        i === 0 ? itemState(detail, item) : "",
        i === 0 ? String(item.index) : "",
        requirements[i] ?? "",
        evidence[i]?.text ?? "",
        itemState(detail, item) === "已接受" || itemState(detail, item) === "已配对" ? "ok" : "warn",
        evidence[i]?.token ?? "dim",
      ));
    }
  }
  return lines;
}

function proofStack(detail: SliceScopeSnap, width: number): ContentLine[] {
  const lines: ContentLine[] = [];
  for (const item of detail.proofContract) {
    const status = itemState(detail, item);
    lines.push(semantic([
      { text: `  需求 ${item.index} · `, token: "accentBright", bold: true },
      { text: status, token: status === "已接受" || status === "已配对" ? "ok" : "warn", bold: true },
    ], width));
    lines.push(...wrapped(item.text, width, "    "));
    const judgment = detail.readiness?.items.find(i => item.id !== undefined && i.id === item.id);
    if (judgment?.judgment) lines.push(...wrapped(`裁决 ${judgment.judgment.id.slice(0, 12)}: ${judgment.reason}`, width, "    "));
    if (item.drops.length === 0) {
      if (judgment?.judgment) continue;
      lines.push(semantic([{ text: "    证据 · ", token: "dim" }, { text: "未记录", token: "warn" }], width));
      continue;
    }
    lines.push(semantic([{ text: "    证据", token: "dim", bold: true }], width));
    for (const drop of item.drops) {
      lines.push(semantic([
        { text: "    ↳ ", token: "chrome" },
        { text: (drop.artifactType ?? "drop").toUpperCase(), token: "accentBright" },
        { text: ` ${drop.verdict ?? ""}`.trimEnd(), token: drop.verdict === "PASS" || drop.verdict === "CLEAR" ? "ok" : "dim" },
      ], width));
      lines.push(...wrapped(drop.file, width, "    ", "dim"));
      for (const media of drop.media) lines.push(...wrapped(`媒体 ${media}`, width, "    ", "dim"));
    }
  }
  return lines;
}

export interface ScopeContentOpts {
  collapseReqs: boolean;
  narrative: boolean;
  width: number;
  executionStrip?: ContentLine[];
}

/** 每个进入规范切片详情的路由共享的紧凑身份/状态/来源块。
 * 保留在此防止资源管理器和任务目标图
 * 导航再次增长单独的切片页。 */
export function scopeIdentityLines(detail: SliceScopeSnap, mission: string | null, width: number): ContentLine[] {
  if (detail.error) return wrapped(`${mission}/${detail.dirName} · 源不可用: ${detail.error}`, width, "", "warn");
  const lines: ContentLine[] = [];
  const w = Math.max(24, width);
  const rawStage = detail.readiness?.configured ? (detail.readiness.state === "ready" ? "结果完成" : detail.readiness.items.some(i => i.state === "withdrawn" || i.state === "rejected") ? "已重开" : "结果待定") : detail.stage ?? detail.status ?? "unknown";
  const stage = scopeStatusLabel(rawStage);
  const stateToken: Token = /done|established|building|active|spec|完成|构建中|活跃|规范/i.test(stage) ? "ok" : "dim";
  const proofToken: Token = detail.proof.total > 0 && detail.proof.paired === detail.proof.total ? "ok" : "warn";
  const locks = `${detail.locks.spec ? "规范已锁定" : "规范开放"} · ${detail.locks.delivery ? "交付已锁定" : "交付开放"}`;
  lines.push(semantic([
    { text: `${sliceGlyph(detail)} `, token: stateToken, bold: true },
    { text: detail.dirName, token: "accentBright", bold: true },
    { text: " · ", token: "chrome" },
    { text: detail.id ?? "未注册", token: "bright" },
    { text: " · ", token: "chrome" },
    { text: mission ?? "未知任务目标", token: "dim" },
  ], w));
  if (detail.displayName !== detail.dirName) {
    lines.push(semantic([
      { text: "  标题  ", token: "dim" },
      { text: `${detail.id ?? "未注册"} · ${detail.displayName}`, token: "bright" },
    ], w));
  }
  if (w < 70) {
    lines.push(semantic([{ text: "  状态  ", token: "dim" }, { text: stage, token: stateToken, bold: true }], w));
    lines.push(semantic([{ text: "  证明  ", token: "dim" }, { text: `${detail.proof.paired}/${detail.proof.total}`, token: proofToken, bold: true }], w));
    lines.push(semantic([{ text: "  锁定  ", token: "dim" }, { text: locks, token: detail.locks.delivery ? "ok" : "bright" }], w));
  } else {
    lines.push(semantic([
      { text: "  状态 ", token: "dim" }, { text: stage, token: stateToken, bold: true },
      { text: " · ", token: "chrome" },
      { text: "证明 ", token: "dim" }, { text: `${detail.proof.paired}/${detail.proof.total}`, token: proofToken, bold: true },
      { text: " · ", token: "chrome" },
      { text: "锁定 ", token: "dim" }, { text: locks, token: detail.locks.delivery ? "ok" : "bright" },
    ], w));
  }
  if (detail.readiness?.configured) lines.push({ text: `  裁决基础 ${detail.readiness.revision.slice(0, 12)} · 发布独立` });
  const provenance = [
    detail.specShaShort ? `规范 ${detail.specShaShort}` : "规范 sha 未知",
    detail.locks.spec ? `${detail.locks.spec.at.slice(5, 10)} ${detail.locks.spec.by.split("@")[0]}` : "未锁定",
    detail.prdExists ? "PRD" : "无 PRD",
  ].join(" · ");
  // 窄详情在起始视口中优先身份、状态和第一个证明关系。
  // 完整来源保留在下方的源中。
  if (w >= 70) lines.push(semantic([{ text: `  ${provenance}`, token: "dim" }], w));
  return lines;
}

/** 规范切片详情的撰写半部分。导出使资源管理器和
 * 任务目标图路由可使用一个操作页而不复制
 * 意图/需求/证明合同渲染器。导航铬保留在
 * 拥有页。 */
export function scopeContractLines(detail: SliceScopeSnap, opts: Pick<ScopeContentOpts, "collapseReqs" | "narrative" | "width">): ContentLine[] {
  if (detail.error) return [];
  const lines: ContentLine[] = [];
  const w = Math.max(24, opts.width);
  if (opts.narrative) {
    lines.push({ text: "" }, rule("进度 · 仅叙事 · n 关闭", w));
    for (const l of (detail.narrative ?? "(无 PROGRESS.md)").split("\n")) lines.push(...wrapped(l, w, "  "));
    return lines;
  }

  lines.push({ text: "" }, rule("意图", w));
  lines.push(...wrapped(detail.intent, w, "  "));

  lines.push({ text: "" }, rule(`需求 (${detail.miniRequirements.length}) · m 折叠`, w));
  if (!opts.collapseReqs) {
    detail.miniRequirements.forEach((requirement, i) => {
      const chunks = wrapText(requirement, Math.max(1, w - 5));
      chunks.forEach((chunk, j) => lines.push(semantic([
        { text: j === 0 ? `  ${i + 1}  ` : "     ", token: j === 0 ? "accentBright" : undefined, bold: j === 0 },
        { text: chunk, token: "bright" },
      ], w)));
    });
  } else {
    lines.push(semantic([{ text: "  已折叠 · m 展开", token: "dim" }], w));
  }

  lines.push({ text: "" }, rule(`证明 · ${detail.proof.paired}/${detail.proof.total} 已配对`, w));
  lines.push(...(w < 70 ? proofStack(detail, w) : proofColumns(detail, w)));
  return lines;
}

export function scopesContentLines(
  detail: SliceScopeSnap | null,
  mission: string | null,
  opts: ScopeContentOpts,
): ContentLine[] {
  const lines: ContentLine[] = [];
  if (!detail) {
    lines.push({ text: "从范围树选择一个任务目标以打开其执行路径" });
    return lines;
  }
  const w = Math.max(24, opts.width);
  lines.push(...scopeIdentityLines(detail, mission, w));

  if (opts.executionStrip?.length) lines.push(...opts.executionStrip);
  lines.push(...proofProvenanceLines(detail.readiness, w));
  lines.push(...scopeContractLines(detail, opts));
  lines.push({ text: "" }, semantic([{
    text: opts.narrative ? "  Esc 返回 · n 叙事 · m 需求 · : 命令栏" : "  Esc 返回 · m 折叠需求 · n 叙事 · : 命令栏",
    token: "dim",
  }], w));
  return lines;
}
