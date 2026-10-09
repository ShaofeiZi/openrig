// Operator Surface Reconciliation v0 —— Priority Rail Rule 辅助函数。
//
// 第 2 项：区分四个规范 Priority Rail Rule 级别
// （STEERING / mission / lane / slice）以及不属于这四个具名桶的
// “中间态”cursor 文件的各级排版。
//
// 依 PRD 引用的 workstream-continuity 约定
// （`workstream-continuity/README.md:119-163`），级别纯粹是路径形状分类——
// 操作者的心智模型依附于文件在工作区树中的位置。分类器是一组正则；按审计行 10 由驱动选定。

import type { ProgressFileNode, ProgressRow } from "../../hooks/useProgressTree.js";

export type PriorityRailLevel = "steering" | "mission" | "lane" | "slice" | "intermediate";

const STEERING_BASENAME = /(^|[\\/])STEERING\.md$/i;
const MISSION_PATH = /(^|[\\/])missions[\\/][^\\/]+[\\/]PROGRESS\.md$/;
const ROADMAP_PATH = /(^|[\\/])roadmap[\\/]PROGRESS\.md$/;
const DELIVERY_LANE_PATH = /(^|[\\/])delivery-ready[\\/]mode-\d+[\\/]PROGRESS\.md$/;
const SLICE_PATH = /(^|[\\/])slices[\\/][^\\/]+[\\/]PROGRESS\.md$/;

export function classifyPriorityRailLevel(file: ProgressFileNode): PriorityRailLevel {
  // 同时检查 relPath（相对扫描根跟踪）与 absolutePath（磁盘上的规范路径），
  // 使分类器无论操作者如何圈定扫描根都能工作。
  const candidates = [file.relPath, file.absolutePath];
  for (const candidate of candidates) {
    if (STEERING_BASENAME.test(candidate)) return "steering";
    if (DELIVERY_LANE_PATH.test(candidate)) return "lane";
    if (ROADMAP_PATH.test(candidate)) return "lane";
    if (SLICE_PATH.test(candidate)) return "slice";
    if (MISSION_PATH.test(candidate)) return "mission";
  }
  return "intermediate";
}

export interface PriorityRailLevelStyle {
  label: string;
  /** 行 chip 的 Tailwind 类。 */
  chipClass: string;
  /** 树中分组的排序键（steering 最前 → intermediate 最后）。 */
  order: number;
}

const STYLES: Record<PriorityRailLevel, PriorityRailLevelStyle> = {
  steering:     { label: "约束", chipClass: "border-stone-900 bg-stone-900 text-stone-50", order: 0 },
  mission:      { label: "任务",    chipClass: "border-violet-400 bg-violet-50 text-violet-900", order: 1 },
  lane:         { label: "泳道",   chipClass: "border-emerald-400 bg-emerald-50 text-emerald-900", order: 2 },
  slice:        { label: "切片",   chipClass: "border-sky-400 bg-sky-50 text-sky-900", order: 3 },
  intermediate: { label: "游标",   chipClass: "border-stone-300 bg-stone-50 text-stone-500", order: 4 },
};

export function getPriorityRailLevelStyle(level: PriorityRailLevel): PriorityRailLevelStyle {
  return STYLES[level];
}

/** 按 Priority Rail Rule 语义为泳道文件计算“下一次拉动”行：
 *  第一个状态既非 done 也非 blocked 的 checkbox 行。无此类行时返回 null
 *  （泳道已全部关闭或全部 blocked）。 */
export function computeNextPullLine(file: ProgressFileNode): number | null {
  for (const row of file.rows) {
    if (row.kind !== "checkbox") continue;
    if (row.status !== "done" && row.status !== "blocked") return row.line;
  }
  return null;
}

// --- Lint 规则（第 6 项） ---

export type LintRuleId = "long-row" | "missing-tree" | "narrative-mixed" | "qitem-no-label";

export interface LintWarning {
  ruleId: LintRuleId;
  /** 文件内源行（从 1 计）。文件级警告可能为 null（例如 missing-tree 作用于整个文件）。 */
  line: number | null;
  /** 操作者可读的消息。 */
  message: string;
  /** 指回 workstream-continuity 约定的引用，便于操作者排查时重读规则。 */
  citation: string;
}

const LONG_ROW_THRESHOLD_CHARS = 160;
const TREE_HEADING_REGEX = /^#{1,4}\s+(tree|hierarchy|topology)/i;
const QITEM_PATTERN = /^qitem-\d{8,}-[0-9a-f]+$/i;

/** 按 PRD § 第 6 项引用的 workstream-continuity 规则，为单个 PROGRESS.md 文件计算 lint 警告。
 *  v0 交付四个具名规则；结果仅供建议（不修改文件）。 */
export function computeLintWarnings(file: ProgressFileNode, hasChildFiles: boolean): LintWarning[] {
  const warnings: LintWarning[] = [];

  // 规则 1 —— 超过两个视觉行的条目（160 字符启发式）。
  for (const row of file.rows) {
    if (row.kind === "checkbox" && row.text.length > LONG_ROW_THRESHOLD_CHARS) {
      warnings.push({
        ruleId: "long-row",
        line: row.line,
        message: `行文本为 ${row.text.length} 字符（超过 ${LONG_ROW_THRESHOLD_CHARS}）。请拆成父 rail + 子条目。`,
        citation: "workstream-continuity/README.md § rule 1 (items ≤ 2 visual lines)",
      });
    }
  }

  // 规则 2 —— 文件夹参与层级却缺少树图。
  if (hasChildFiles) {
    const hasTreeHeading = file.rows.some((r) => r.kind === "heading" && TREE_HEADING_REGEX.test(`## ${r.text}`));
    if (!hasTreeHeading) {
      warnings.push({
        ruleId: "missing-tree",
        line: null,
        message: "本文件作为其他 PROGRESS.md 的父级，却没有 '## Tree' / '## Hierarchy' / '## Topology' 标题。",
        citation: "workstream-continuity/README.md § rule 2 (authored tree diagrams for parent files)",
      });
    }
  }

  // 规则 3 —— 叙述风格条目与 rail 条目混在同一节。
  // 启发式：在两个标题边界之间，统计 checkbox 行数量与“叙述”行
  // （非 checkbox、非标题且非空的行）数量。二者都 > 0 时在该节第一个 checkbox 行告警。
  // v0 仅在该节至少有 2 个 checkbox + 2 行叙述时才应用，以保持低噪声。
  let sectionCheckboxes: ProgressRow[] = [];
  let sectionNarrativeCount = 0;
  let sectionStartLine = 1;
  const flushSection = () => {
    if (sectionCheckboxes.length >= 2 && sectionNarrativeCount >= 2) {
      const first = sectionCheckboxes[0]!;
      warnings.push({
        ruleId: "narrative-mixed",
        line: first.line,
        message: `约从 L${sectionStartLine} 开始的节把 ${sectionNarrativeCount} 行叙述与 ${sectionCheckboxes.length} 个 rail 条目交错在一起。请把 prose 移到节标题正文或兄弟 notes 文件。`,
        citation: "workstream-continuity/README.md § rule 3 (narrative vs. rail-item separation)",
      });
    }
    sectionCheckboxes = [];
    sectionNarrativeCount = 0;
  };
  for (const row of file.rows) {
    if (row.kind === "heading") {
      flushSection();
      sectionStartLine = row.line;
      continue;
    }
    if (row.kind === "checkbox") {
      sectionCheckboxes.push(row);
    }
  }
  flushSection();
  // 叙述计数：ProgressFileNode 形状里没有非 checkbox/非标题行（索引器丢弃了它们）；
  // 规则 3 在 v0 处于“生效但安静”状态。上面的启发式仅在 sectionNarrativeCount ≥ 2 时触发，
  // 而 v0 中永不为真——显式记录为已知限制；v0+1 推广需教索引器保留叙述行。

  // 规则 4 —— 没有人类可读名称的 qitem id。
  for (const row of file.rows) {
    if (row.kind !== "checkbox") continue;
    if (QITEM_PATTERN.test(row.text)) {
      warnings.push({
        ruleId: "qitem-no-label",
        line: row.line,
        message: "行正文是一个裸 qitem id，没有人类可读标签。请补一行说明。",
        citation: "workstream-continuity/README.md § rule 4 (human-readable rail rows)",
      });
    }
  }

  return warnings;
}
