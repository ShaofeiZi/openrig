// 0.3.1 切片 06 —— storytelling-primitives 基础。
//
// MarkdownViewer 类型分发器和围栏块渲染器使用的纯逻辑辅助函数。
// 每个解析器返回一个可区分联合（{ ok: true, ... } | { ok: false, reason: string }），
// 使调用方在正文解析失败时可回退到普通代码块。优雅降级是承重的——
// 一个完整约定的 markdown 文件在渲染器不识别类型或围栏块语言时仍应清晰可读。

import { parse as parseYaml } from "yaml";

// -----------------------------------------------------------------------------
// 类型分派
// -----------------------------------------------------------------------------

export const KNOWN_KINDS = [
  "incident-timeline",
  "progress",
  "feature-shipped",
  "implementation-plan",
  "concept-explainer",
  "pr-writeup",
  "post-mortem",
] as const;

export type KindName = typeof KNOWN_KINDS[number];

const KIND_SET = new Set<string>(KNOWN_KINDS);

/** 从 frontmatter 提取已知 `kind:` 值。当 frontmatter 缺失、字段缺失或值
 *  不在精选集合中时返回 null——查看器随后回退到普通 markdown 渲染。 */
export function extractKind(frontmatter: Record<string, string> | null): KindName | null {
  if (!frontmatter) return null;
  const raw = frontmatter["kind"];
  if (!raw) return null;
  return KIND_SET.has(raw) ? (raw as KindName) : null;
}

// -----------------------------------------------------------------------------
// 围栏块语法
// -----------------------------------------------------------------------------

export const FENCED_BLOCK_LANGUAGES = ["timeline", "stats", "risk-table", "compare", "slate"] as const;
export type FencedBlockLanguage = typeof FENCED_BLOCK_LANGUAGES[number];

const FENCED_BLOCK_SET = new Set<string>(FENCED_BLOCK_LANGUAGES);

export function isFencedBlockLanguage(language: string | null | undefined): language is FencedBlockLanguage {
  return typeof language === "string" && FENCED_BLOCK_SET.has(language);
}

// --- timeline -----

export type TimelineStatus = "success" | "warning" | "danger" | "info" | "muted";
const TIMELINE_STATUSES = new Set<TimelineStatus>(["success", "warning", "danger", "info", "muted"]);

export interface TimelineEntry {
  time: string;
  status: TimelineStatus;
  title: string;
  body: string;
}

export type TimelineParseResult =
  | { ok: true; entries: TimelineEntry[] }
  | { ok: false; reason: string };

export function parseTimelineBlock(body: string): TimelineParseResult {
  let parsed: unknown;
  try { parsed = parseYaml(body); } catch (err) {
    return { ok: false, reason: `YAML 解析错误：${err instanceof Error ? err.message : String(err)}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: "应为 YAML 条目列表" };
  }
  const entries: TimelineEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    entries.push({
      time: stringField(r.time),
      status: TIMELINE_STATUSES.has(r.status as TimelineStatus) ? (r.status as TimelineStatus) : "info",
      title: stringField(r.title),
      body: stringField(r.body),
    });
  }
  return { ok: true, entries };
}

// --- stats -----

export type StatsTrend = "up" | "flat" | "down";
const STATS_TRENDS = new Set<StatsTrend>(["up", "flat", "down"]);

export interface StatsEntry {
  label: string;
  value: string;
  trend?: StatsTrend;
}

export type StatsParseResult =
  | { ok: true; entries: StatsEntry[] }
  | { ok: false; reason: string };

export function parseStatsBlock(body: string): StatsParseResult {
  let parsed: unknown;
  try { parsed = parseYaml(body); } catch (err) {
    return { ok: false, reason: `YAML 解析错误：${err instanceof Error ? err.message : String(err)}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: "应为 YAML 条目列表" };
  }
  const entries: StatsEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const trendRaw = r.trend as StatsTrend | undefined;
    entries.push({
      label: stringField(r.label),
      value: stringField(r.value),
      ...(STATS_TRENDS.has(trendRaw as StatsTrend) ? { trend: trendRaw as StatsTrend } : {}),
    });
  }
  return { ok: true, entries };
}

// --- risk-table -----

export type RiskLevel = "low" | "med" | "high";
const RISK_LEVELS = new Set<RiskLevel>(["low", "med", "high"]);

export interface RiskTableEntry {
  risk: string;
  probability: RiskLevel;
  impact: RiskLevel;
  mitigation: string;
}

export type RiskTableParseResult =
  | { ok: true; entries: RiskTableEntry[] }
  | { ok: false; reason: string };

export function parseRiskTableBlock(body: string): RiskTableParseResult {
  let parsed: unknown;
  try { parsed = parseYaml(body); } catch (err) {
    return { ok: false, reason: `YAML 解析错误：${err instanceof Error ? err.message : String(err)}` };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: "应为 YAML 条目列表" };
  }
  const entries: RiskTableEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    entries.push({
      risk: stringField(r.risk),
      probability: RISK_LEVELS.has(r.probability as RiskLevel) ? (r.probability as RiskLevel) : "med",
      impact: RISK_LEVELS.has(r.impact as RiskLevel) ? (r.impact as RiskLevel) : "med",
      mitigation: stringField(r.mitigation),
    });
  }
  return { ok: true, entries };
}

// --- compare -----

export interface CompareRow {
  label: string;
  values: string[];
}

export type CompareParseResult =
  | { ok: true; columns: string[]; rows: CompareRow[] }
  | { ok: false; reason: string };

export function parseCompareBlock(body: string): CompareParseResult {
  let parsed: unknown;
  try { parsed = parseYaml(body); } catch (err) {
    return { ok: false, reason: `YAML 解析错误：${err instanceof Error ? err.message : String(err)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "应为包含 columns 和 rows 的 YAML 映射" };
  }
  const r = parsed as Record<string, unknown>;
  if (!Array.isArray(r.columns)) {
    return { ok: false, reason: "缺少 columns 数组" };
  }
  const columns = (r.columns as unknown[]).map(stringField);
  const rowsRaw = Array.isArray(r.rows) ? (r.rows as unknown[]) : [];
  const rows: CompareRow[] = [];
  for (const row of rowsRaw) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const rr = row as Record<string, unknown>;
    rows.push({
      label: stringField(rr.label),
      values: Array.isArray(rr.values) ? (rr.values as unknown[]).map(stringField) : [],
    });
  }
  return { ok: true, columns, rows };
}

// --- slate -----

export type SlateParseResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

export function parseSlateBlock(body: string): SlateParseResult {
  const trimmed = body.trim();
  if (trimmed.length === 0) return { ok: false, reason: "面板正文为空" };
  return { ok: true, text: trimmed };
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

function stringField(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}
