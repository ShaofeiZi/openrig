// OPR.0.4.0.33 —— 面向 PROGRESS 轨道的纯函数、外科手术式 markdown 编辑器。
//
// 这些函数为 `rig scope ... progress` 提供后端。它们消费
// packages/daemon/src/domain/progress/progress-indexer.ts 的 UI 解析契约：
//   - 标题只取自【第一个】`# H1`（跳过 frontmatter），
//   - 章节层级来自 `##`/`###`/`####` 标题，
//   - 行来自 `- [ ]` / `- [x]` / `- [~]` 复选框行。
// 因此每次编辑都原样保留 `# H1` 与 YAML frontmatter，并严格按该形状写入行。
// 函数是纯函数（字符串进、字符串出），使命令层保持纤薄，且行为无需文件系统即可单测。

import { ScopeCliError } from "./types.js";

export type ProgressStatus = "active" | "done" | "blocked";

export const PROGRESS_STATUSES: ReadonlyArray<ProgressStatus> = ["active", "done", "blocked"];

export const DEFAULT_PROGRESS_SECTION = "Rail";

/** 把状态词映射为索引器使用的单个指示字符。 */
export function statusIndicator(status: ProgressStatus): " " | "x" | "~" {
  switch (status) {
    case "active": return " ";
    case "done": return "x";
    case "blocked": return "~";
  }
}

function indicatorToStatus(indicator: string): ProgressStatus {
  const c = indicator.toLowerCase();
  if (c === "x") return "done";
  if (c === "~") return "blocked";
  return "active";
}

/** 校验任意字符串并收窄为 ProgressStatus，否则抛出三段式错误。
 *  状态词表就是索引器认识的那三个。 */
export function parseStatus(raw: string): ProgressStatus {
  if ((PROGRESS_STATUSES as ReadonlyArray<string>).includes(raw)) {
    return raw as ProgressStatus;
  }
  throw new ScopeCliError({
    fact: `未知的 --status "${raw}"。`,
    consequence: "未写入任何进度行。",
    action: `请使用以下之一：${PROGRESS_STATUSES.join(", ")}。`,
  });
}

// 与索引器对齐的行匹配：可选缩进、可选 `- `/`* ` 项目符号、
// `[ x ~]` 指示符，然后是行文本。
const ROW_RE = /^(\s*)(?:[-*]\s+)?\[([ xX~])\]\s+(.+?)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const SECTION_ALIASES: readonly (readonly string[])[] = [
  ["Acceptance", "验收"],
];

function sectionNames(section: string): readonly string[] {
  return SECTION_ALIASES.find((aliases) => aliases.some((alias) => alias.toLocaleLowerCase() === section.toLocaleLowerCase()))
    ?? [section];
}

/** 正文第一行的下标（跳过任何开头的 YAML frontmatter 之后）。 */
function bodyStartIndex(lines: string[]): number {
  if ((lines[0] ?? "").trim() !== "---") return 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "---") return i + 1;
  }
  return 0; // frontmatter 未闭合——当作无 frontmatter
}

export interface ProgressEditResult {
  content: string;
  changed: boolean;
}

/**
 * 在 `## <section>` 下追加一行 `- [<指示符>] <文本>`。
 * - 当 `## <section>` 不存在时创建它（追加到最后一个既有章节之后）。
 * - 幂等：完全相同的（章节、文本、状态）行是无操作。
 * - 拒绝创建冲突重复（同文本、不同状态）——那是 `--set` 操作，不是 `--add`。
 * - 绝不触碰 frontmatter、`# H1` 或无关行。
 */
export function addProgressRow(
  content: string,
  opts: { section: string; text: string; status: ProgressStatus },
): ProgressEditResult {
  const section = opts.section.trim();
  const acceptedSectionNames = sectionNames(section);
  const text = opts.text.trim();
  if (!text) {
    throw new ScopeCliError({
      fact: "--add 的行文本为空。",
      consequence: "未写入任何进度行。",
      action: '请传入非空行，例如 --add "Guard approved"。',
    });
  }
  const newRow = `- [${statusIndicator(opts.status)}] ${text}`;
  const lines = content.split("\n");
  const start = bodyStartIndex(lines);

  // 定位目标章节标题。
  let sectionIdx = -1;
  for (let i = start; i < lines.length; i++) {
    const h = lines[i]!.match(HEADING_RE);
    if (h && acceptedSectionNames.some((name) => name.toLocaleLowerCase() === h[2]!.trim().toLocaleLowerCase())) {
      sectionIdx = i;
      break;
    }
  }

  if (sectionIdx === -1) {
    // 创建该章节，追加到最后一段既有内容之后。
    let end = lines.length;
    while (end > start && lines[end - 1]!.trim() === "") end--;
    const head = lines.slice(0, end);
    const rebuilt = [...head, "", `## ${section}`, "", newRow, ""].join("\n");
    return { content: rebuilt, changed: true };
  }

  // 章节块 = [sectionIdx+1, 下一个标题或 EOF)。
  let blockEnd = lines.length;
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    if (HEADING_RE.test(lines[i]!)) { blockEnd = i; break; }
  }

  // 在章节内做幂等 / 冲突扫描。
  for (let i = sectionIdx + 1; i < blockEnd; i++) {
    const cb = lines[i]!.match(ROW_RE);
    if (cb && cb[3]!.trim() === text) {
      const current = indicatorToStatus(cb[2]!);
      if (current === opts.status) return { content, changed: false };
      throw new ScopeCliError({
        fact: `章节 "${section}" 中已存在状态为 ${current} 的行 "${text}"。`,
        consequence: "拒绝追加冲突的重复行。",
        action: `请用：zrig scope ... progress --set "${text}" --status ${opts.status} 来修改其状态。`,
      });
    }
  }

  // 插入到章节块内最后一个非空行之后。
  let insertAt = sectionIdx + 1;
  for (let i = sectionIdx + 1; i < blockEnd; i++) {
    if (lines[i]!.trim() !== "") insertAt = i + 1;
  }
  lines.splice(insertAt, 0, newRow);
  return { content: lines.join("\n"), changed: true };
}

/**
 * 重写【唯一】一行的指示符——其去空格后文本与 `text` 【完全】相等。
 * 行选择按“去空格后精确文本”（不是行号，也不是生成的 id——索引器两者都不生成）。
 * - 0 个匹配 → 报错（点出缺失的文本）。
 * - >1 个匹配 → 报错（有歧义；v0 拒绝猜测）。
 * - 幂等：把某行设为其当前状态是无操作。
 * - 只重写匹配行的指示符字符；其余逐字节保留。
 */
export function setProgressRow(
  content: string,
  opts: { text: string; status: ProgressStatus },
): ProgressEditResult {
  const text = opts.text.trim();
  const lines = content.split("\n");
  const start = bodyStartIndex(lines);

  const matches: number[] = [];
  for (let i = start; i < lines.length; i++) {
    const cb = lines[i]!.match(ROW_RE);
    if (cb && cb[3]!.trim() === text) matches.push(i);
  }

  if (matches.length === 0) {
    throw new ScopeCliError({
      fact: `没有进度行与精确文本 "${text}" 匹配。`,
      consequence: "未做任何改动。",
      action: '请核对行文本（精确、去空格匹配），或用 --add 添加它。列出行：zrig scope ... show。',
    });
  }
  if (matches.length > 1) {
    throw new ScopeCliError({
      fact: `有 ${matches.length} 行匹配文本 "${text}"（有歧义）。`,
      consequence: "v0 拒绝猜测要更新哪一行；未做任何改动。",
      action: "请使行文本唯一后重试。",
    });
  }

  const i = matches[0]!;
  const indMatch = lines[i]!.match(/\[([ xX~])\]/)!;
  if (indicatorToStatus(indMatch[1]!) === opts.status) {
    return { content, changed: false };
  }
  lines[i] = lines[i]!.replace(/\[([ xX~])\]/, `[${statusIndicator(opts.status)}]`);
  return { content: lines.join("\n"), changed: true };
}
