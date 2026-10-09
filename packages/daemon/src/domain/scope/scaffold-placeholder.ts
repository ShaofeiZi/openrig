// release-0.4.7 intent-stage/scaffold-projection——唯一 scaffold 识别语法：
// “此文本是已发布模板占位符，而非已编写内容。”
//
// PARITY 契约（架构裁定 2026-07-11，intent-stage 计划 AR-1 + P1 固定项）：
// 此文件是逐字节等价的镜像，完全相同地存在于
//   packages/cli/src/lib/scope/scaffold-placeholder.ts
//   packages/daemon/src/domain/scope/scaffold-placeholder.ts
// 字节等价性由 scope-audit-parity CLASSIFIER_FILES 在 CI 中强制。不得让两个副本分叉，也不得在
// 清理中把它们“去重”为单文件；当前布局不存在两个 package 都能导入的真正共享模块，因此
// twin-plus-parity 安排本身就是单一语法保证（一套语法、三个消费者：review compose、
// slice-detail-projector 和两个 scope-audit 镜像）。若布局将来获得真正共享 package，届时再合并，
// 不能提前。
//
// 语法（架构规定）：trim 后文本完全由方括号包裹即为 scaffold placeholder，也就是已发布模板标记；
// 已在 scope-templates/*.md 中逐模板验证。真实边界（由测试固定，不设 gate）：方括号外出现任意字符
// 即视为真实内容；完全由方括号包裹的真实交付物就是按模板语法编写。`[a] and [b]` 以 `[` 开头、
// 以 `]` 结尾，因此归类为 placeholder；忠于架构语法，刻意不做特殊处理（无私有语法）。

/** `text` 经 trim 后完全由方括号包裹（`[...]`）时为 true；这是已发布 scaffold-template 的
 * placeholder 标记，即非 authored 内容。 */
export function isScaffoldPlaceholderText(text: string): boolean {
  return /^\[.*\]$/.test(text.trim());
}

/** release-0.4.7 placeholder-suppression 完整性：当 `body` 至少包含一个正文不是 scaffold
 * placeholder 的编号项（`1.` 或 `1)`）时为 true；这是唯一 authored-numbered-item 语法。消费者：
 * review compose `hasAuthoredMiniReqs` + 两个 scope-audit mini-reqs 分支；一个谓词同时修复 IF-3
 * 点号/括号语法漂移与 audit 分支对 placeholder 不敏感的问题（架构 MB-AR-1 主结构）。只有 prose
 * 或 bullet 的 body 刻意不视为 authored；批准从编号层开始（reviewer-L1 裁定 2026-07-11，
 * intent-stage gate）。`null` 返回 false。 */
export function hasAuthoredNumberedItem(body: string | null): boolean {
  if (body === null) return false;
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (m && !isScaffoldPlaceholderText(m[1]!.trim())) return true;
  }
  return false;
}

/** release-0.4.7 placeholder-suppression 完整性：当 `block` 每条非空行都是 scaffold placeholder
 * 时为 true，即 section 级“此处未编写任何内容”检查。刻意逐行判断而非整体 trim；两行
 * `[a]\n[b]` 的 body 逐行都只是 placeholder，却无法通过单行正则（多行真实情况，架构 MB-AR-2）。
 * `null`/空/纯空白返回 false：缺失是独立状态；调用方保留现有 null 处理。 */
export function isPlaceholderOnlyBlock(block: string | null): boolean {
  if (block === null) return false;
  const lines = block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return false;
  return lines.every((l) => isScaffoldPlaceholderText(l));
}

/** PM dogfood #1（qitem-20260720015700-630eef64）：当 `body` 是存在的 section，且其每条非空行
 * 都是 scaffold-placeholder 内容时为 true；内容可以是裸 placeholder 行，或正文为 placeholder 的
 * 结构列表行（编号 `1.`/`1)`、checkbox `- [ ]`、bullet `-`/`*`），即恰好只有已发布模板提供的
 * scaffold，没有 authored 内容。这是逐 section 来源选择背后的 pristine 检查：只有 pristine PRD
 * section 可让位于 authored README section；authored/prose/mixed 内容不 pristine，无论位于何处都
 * 保持 canonical。`null`/空/纯空白返回 false（缺失是独立状态；缺失 section 不触发 fallback）。 */
export function isPristineScaffoldSection(body: string | null): boolean {
  if (body === null) return false;
  const lines = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return false;
  return lines.every((l) => {
    const stripped = l.replace(/^(?:\d+[.)]\s+|-\s*\[[ xX]\]\s*|[-*]\s+)/, "");
    return isScaffoldPlaceholderText(stripped);
  });
}

/** 由 `packages/cli/src/lib/scope-templates/slice-progress.md` 搭建的通用 acceptance 三元组；
 * 使用精确 trim 后字面量，并与已发布模板做同步测试，使 constant/template 漂移在 CI 失败，而非
 * 静默恢复错误的 pristine 计数。 */
export const GENERIC_SCAFFOLD_ACCEPTANCE: readonly string[] = [
  "实现完成",
  "测试通过",
  "审查批准",
];

/** 旧版英文脚手架的同一组三项；读取面保留兼容，但新脚手架默认写中文。 */
export const LEGACY_GENERIC_SCAFFOLD_ACCEPTANCE: readonly string[] = [
  "Implementation complete",
  "Tests passing",
  "Review approved",
];

/** KI-5.3-2 第二界面后续（行 e69daaef；r1 A3 已确认）——proof-contract SOURCE-SELECTION 的
 * 唯一归属位置。三个 reader（proof-add、review compose DELIVERED 配对、两个 scope-audit 镜像）
 * 过去独立派生 fallback 目标并发生漂移：proof-add 从 SPEC 派生，而 compose/audit 在没有 SPEC 路径时
 * 回退到 README，导致证据按一份契约记录、按另一份展示。针对 SECTION BODY 的选择顺序
 *（各 reader 保留自身 extractor）：
 *   authored SPEC -> "spec"（唯一当前契约）
 *   缺失/pristine SPEC -> authored PRD -> "prd"（legacy fallback）
 *                        -> authored README -> "readme"（更旧 fallback）
 *                        -> null
 * “Authored”表示存在且不是 isPristineScaffoldSection。消费者使用已发布 parser 从所选来源正文解析 item。 */
export function selectProofContractBody(args: {
  prdBody: string | null;
  specBody: string | null;
  readmeBody: string | null;
}): { source: "prd" | "spec" | "readme" | null; body: string | null } {
  const authored = (b: string | null): boolean => b !== null && !isPristineScaffoldSection(b);
  if (authored(args.specBody)) return { source: "spec", body: args.specBody };
  if (authored(args.prdBody)) return { source: "prd", body: args.prdBody };
  if (authored(args.readmeBody)) return { source: "readme", body: args.readmeBody };
  return { source: null, body: null };
}
