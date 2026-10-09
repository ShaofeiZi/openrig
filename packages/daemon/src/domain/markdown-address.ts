// OPR.0.5.3.5 mini-req 6——可寻址 Markdown 的 resolver core。
//
// 锁定约定（SPEC.md Q1 裁定，由 review-r1 批准；语法权威为 FOUNDER_NOTES.md P1）：地址只有
// `name#H2-slug/H3-slug` 这一种易于记忆的形式。`name` 由调用方解析（库索引或已配置 tree root，
// 即 Q2-Amendment 1 的“一套语法、两个 resolver”裁定）；`#` 后的部分在这里对照 Markdown 文本解析。
// 裸地址返回 section 的完整 span：直至下一个同级或更高级标题之前，包含子级。section 自身文本
//（直至任意层级的下一个标题之前）通过同一解析结果的 `ownText` 字段返回，绝不是第二套地址语法。
// 已废弃的五月设计曾接受两种分隔形式，我们有意只交付一种。代码围栏中的标题永远不是地址，也不会
// 终止 span（这是五月原型已验证的陷阱）。解析必须显著失败：没有匹配项时抛出
// AddressResolutionError，点明原因和真实候选项，绝不静默返回空值；安装流水线中缺失 atom 必须停止
// compose，不能悄悄缩短遍历（明确不继承原型的 graceful-undefined 行为）。
//
// 本模块是纯函数模块（输入文本，输出 span），归属于后台服务，使依赖 @openrig/daemon 的 CLI 与
// 后台服务 assembler 共享同一个 resolver，即一套语法、一个归属。范围边界（Q4）：只支持解析与组合；
// CRUD、精细编辑与 lint 留在 0.6.0 mdar-full-ship 轨道。

/** 按 Q1 裁定，可寻址深度为 H2 和 H3。 */
const MIN_LEVEL = 2;
const MAX_LEVEL = 3;

export class AddressResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddressResolutionError";
  }
}

/** 唯一 slug 规则，简单到足以记忆：转为小写；移除 Markdown 强调/代码 marker 但保留文本；
 *  连续非字母数字字符折叠成一个连字符；裁掉首尾连字符。 */
export function slugifyHeader(title: string): string {
  return title
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface ParsedAddress {
  /** `#` 之前的 ref，可以是 library ref 或 tree path；由调用方 resolver 负责。 */
  ref: string;
  /** slug 数量：0 表示整个文件，1 表示 H2，2 表示 H2/H3。 */
  headerPath: string[];
}

/** 解析唯一语法形式 `ref` / `ref#h2` / `ref#h2/h3`；其他形式均显著失败。 */
export function parseAddress(address: string): ParsedAddress {
  const hashCount = (address.match(/#/g) ?? []).length;
  if (hashCount > 1) {
    throw new AddressResolutionError(
      `地址 '${address}' 包含 ${hashCount} 个 '#' 分隔符；唯一合法形式是 name#H2-slug/H3-slug（只有一个 '#'）。`,
    );
  }
  const [ref, headerPart] = hashCount === 1 ? (address.split("#") as [string, string]) : [address, undefined];
  if (!ref) {
    throw new AddressResolutionError(`地址 '${address}' 在 '#' 前的 ref 为空；地址必须指明文件/ref。`);
  }
  if (headerPart === undefined) return { ref, headerPath: [] };
  const headerPath = headerPart.split("/");
  if (headerPath.some((seg) => seg.length === 0)) {
    throw new AddressResolutionError(`地址 '${address}' 含空标题段；合法形式是 name#H2-slug 或 name#H2-slug/H3-slug。`);
  }
  if (headerPath.length > MAX_LEVEL - MIN_LEVEL + 1) {
    throw new AddressResolutionError(
      `地址 '${address}' 深入 ${headerPath.length} 层；按 Q1 裁定，地址只能指向 H2 和 H3，最深形式为 name#H2-slug/H3-slug。`,
    );
  }
  return { ref, headerPath };
}

export interface MarkdownSection {
  /** 标题层级（2 或 3）。 */
  level: number;
  /** 标题的原始文本。 */
  title: string;
  /** 此 section 的地址路径：[h2Slug] 或 [h2Slug, h3Slug]。 */
  headerPath: string[];
  /** 标题本身所在的行号，从 0 开始。 */
  headerLine: number;
  /** 完整 span（Q1）：从标题行到下一个同级或更高级标题的前一行。 */
  text: string;
  /** 自身文本：从标题行到任意层级下一个标题的前一行。 */
  ownText: string;
}

interface HeaderHit {
  level: number;
  title: string;
  line: number;
}

interface HeaderScan {
  hits: HeaderHit[];
  /** 到达 EOF 时仍处于未闭合围栏内则设置（r1 F1）：起始围栏后的所有标题都被吞掉。validator
   *  必须点明该问题，否则一个因孤立围栏丢失大部分 section 的文件仍会通过 gate。 */
  unterminatedFenceLine: number | null;
}

/** 扫描真实标题并跳过 fenced code block（``` 或 ~~~，允许任意 info string）；
 *  只有相同 marker 且长度不短于起始围栏时才闭合。 */
function scanHeaders(lines: string[]): HeaderScan {
  const hits: HeaderHit[] = [];
  let fence: { marker: string; length: number; line: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      const length = fenceMatch[1]!.length;
      if (!fence) {
        fence = { marker, length, line: i };
      } else if (fence.marker === marker && length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (fence) continue;
    const header = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (header) hits.push({ level: header[1]!.length, title: header[2]!, line: i });
  }
  return { hits, unterminatedFenceLine: fence?.line ?? null };
}

/** 解析 Markdown 文本中可寻址的 H2/H3 section tree。按构造，匹配的 section 永不为空：span
 *  包含标题行本身，因此即使 `## alpha` 没有正文（下一行是另一标题或已到 EOF），也至少解析为
 *  自身标题。已匹配却为空的 section 绝不会悄悄缩短 compose（fail-loud 契约的结构部分；r1 A2）。 */
export function parseMarkdownSections(text: string): MarkdownSection[] {
  const lines = text.split("\n");
  const { hits: headers } = scanHeaders(lines);
  const sections: MarkdownSection[] = [];
  let currentH2: string | null = null;
  for (let idx = 0; idx < headers.length; idx++) {
    const h = headers[idx]!;
    if (h.level < MIN_LEVEL || h.level > MAX_LEVEL) {
      if (h.level < MIN_LEVEL) currentH2 = null; // H1 会重置 H2 scope。
      continue;
    }
    const slug = slugifyHeader(h.title);
    if (h.level === 2) currentH2 = slug;
    // r1 F2：用 null 而非 truthiness 检查 scope。标题 slug 化为 "" 的 H2 仍拥有其子级；
    // 子级保留在空 segment 下（任何合法地址都无法到达，validator 会点名这一组），
    // 而不会被静默提升为顶层地址。
    const headerPath = h.level === 2 ? [slug] : currentH2 !== null ? [currentH2, slug] : [slug];
    // 完整 span：到下一个层级小于等于当前标题的标题，即同级或更高级标题。
    const fullEnd = headers.slice(idx + 1).find((n) => n.level <= h.level)?.line ?? lines.length;
    // 自身文本：到任意层级的下一个标题。
    const ownEnd = headers[idx + 1]?.line ?? lines.length;
    sections.push({
      level: h.level,
      title: h.title,
      headerPath,
      headerLine: h.line,
      text: lines.slice(h.line, fullEnd).join("\n"),
      ownText: lines.slice(h.line, ownEnd).join("\n"),
    });
  }
  return sections;
}

/** 对照 Markdown 文本解析标题路径。必须显著失败：无匹配项时抛错并点明缺失项及该层级真实候选，
 *  绝不静默返回空值。 */
export function resolveAddress(text: string, headerPath: string[]): MarkdownSection {
  if (headerPath.length === 0) {
    throw new AddressResolutionError("resolveAddress 至少需要一个标题 slug；裸 ref 由调用方解析为整个文件。");
  }
  const sections = parseMarkdownSections(text);
  const wanted = headerPath.join("/");
  const hits = sections.filter((s) => s.headerPath.join("/") === wanted);
  // 歧义必须在 RESOLVE 时显著失败（Atom 4c）：重复 header-path 会成为 validator finding，
  // 但 serving 不能依赖 validator 已运行；对已交付重复项取首个匹配会静默给出错误答案。
  if (hits.length > 1) {
    throw new AddressResolutionError(
      `地址 '#${wanted}' 在此文件中存在歧义：${hits.length} 个 section 共享该路径` +
        `（标题行 ${hits.map((h) => h.headerLine).join(", ")}）。请修复重复标题；` +
        `返回其中任意一个都会静默给出错误答案。`,
    );
  }
  if (hits.length === 1) return hits[0]!;
  const parentPath = headerPath.slice(0, -1).join("/");
  const candidates = sections
    .filter((s) => s.headerPath.slice(0, -1).join("/") === parentPath)
    .map((s) => s.headerPath.join("/"));
  throw new AddressResolutionError(
    `地址 '#${wanted}' 未匹配此文件中的任何标题；组合在此停止，而不会缩短遍历。` +
      (candidates.length > 0
        ? `'${parentPath || "(top)"}' 下的可寻址 section：${candidates.join(", ")}。`
        : `此文件有 ${sections.length} 个可寻址 section：${sections.map((s) => s.headerPath.join("/")).join(", ") || "（无）"}。`),
  );
}

export type AddressabilityFinding =
  | { kind: "duplicate-header-path"; headerPath: string; lines: number[] }
  | { kind: "unaddressable-header"; headerPath: string; line: number; title: string }
  | { kind: "unterminated-fence"; line: number };

/** compose gate validator：按唯一 slug 规则，每个 H2/H3 都必须可唯一寻址，文件也不得静默丢失
 *  section。返回 finding 而不抛错，由调用方决定 gate。 */
export function validateMarkdownAddressability(text: string): AddressabilityFinding[] {
  const lines = text.split("\n");
  const { unterminatedFenceLine } = scanHeaders(lines);
  const sections = parseMarkdownSections(text);
  const findings: AddressabilityFinding[] = [];
  // r1 F1：未闭合围栏会吞掉之后所有标题。解析仍保持诚实（被吞地址会显著失败），但 gate 必须
  // 提前点明损失；这是实际文件最可能包含的语料缺陷。
  if (unterminatedFenceLine !== null) {
    findings.push({ kind: "unterminated-fence", line: unterminatedFenceLine });
  }
  const seen = new Map<string, number[]>();
  for (const s of sections) {
    // r1 F2 family 规则：任意空 segment 都会使 section 无法通过合法地址到达
    //（parseAddress 会拒绝空 segment），因此同时标记 parent 与 child。
    if (s.headerPath.some((segment) => segment.length === 0)) {
      findings.push({ kind: "unaddressable-header", headerPath: s.headerPath.join("/"), line: s.headerLine, title: s.title });
      continue;
    }
    const key = s.headerPath.join("/");
    seen.set(key, [...(seen.get(key) ?? []), s.headerLine]);
  }
  for (const [headerPath, lineNumbers] of seen) {
    if (lineNumbers.length > 1) findings.push({ kind: "duplicate-header-path", headerPath, lines: lineNumbers });
  }
  return findings;
}
