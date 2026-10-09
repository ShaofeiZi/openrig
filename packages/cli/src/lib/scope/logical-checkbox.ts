// KI-5.3-2——唯一的 logical-checkbox 条目语法：把编写的 `## Proof contract`
//（或 acceptance）复选框区块解析为逻辑条目。
//
// 对等契约（2026-07-11 架构裁定 twin-plus-parity，由 KI-5.3-2 扩展）：
// 本文件是字节完全相同的 twin，在以下两个位置保持一致：
//   packages/cli/src/lib/scope/logical-checkbox.ts
//   packages/daemon/src/domain/scope/logical-checkbox.ts
// scope-audit-parity 的 CLASSIFIER_FILES 会在 CI 中强制字节等价。不要让副本产生差异，
// 也不要把它们“去重”为单个文件：当前布局不存在两个 package 都能导入的真正共享模块，因此
// twin-plus-parity 布局就是单一语法保证。review composer、slice-detail acceptance
// projector 和 CLI `zrig proof add` evidence-index validator 全部通过这一语法解析，
// 因而以 1 为基准的 byIndex evidence ref 在每一侧都指向同一个约定条目，不会静默错位。
// 如果未来布局中加入真正的共享 package，再把 twin 合并进去；不能提前合并。

/** qitem-render-driver B——唯一的 logical-checkbox 记录，由所有编写型复选框列表 reader 共用，
 *  包括 Review 的 proof contract、slice-detail projector 的 acceptance 行和 CLI proof-add
 *  索引。
 *
 *  `rawText` 是完整的逻辑条目：复选框行加上所有符合条件的缩进续行，并以恰好一个 U+0020
 *  连接；它也是 VM-006 join key（textKey = 对这些字节执行 trim + casefold）。每个 reader
 *  都必须消费该记录，使 promise、acceptance、dedup 和 QA-verdict 从构造上基于相同字节关联；
 *  第二套解析器会让关联关系悄然失去同步。 */
export interface LogicalCheckboxItem {
  /** 作者设置的勾选状态（`- [x]`）。 */
  checked: boolean;
  /** 完整逻辑条目文本（续行已连接），仅做 trim。 */
  rawText: string;
  /** 复选框自身所在的 1-based 行号，绝不会指向续行。 */
  sourceLine: number;
}

const CHECKBOX_LINE = /^(\s*)-?\s*\[(\s|x|X)\]\s+(.+)$/;

/** 把编写的复选框区块解析为逻辑条目。
 *
 *  续行资格（由测试锁定）：一行必须非空、本身不是复选框，且缩进严格深于复选框行，才算前一
 *  复选框的续行。下一个复选框、空行或缩进相同/更浅的正文都会终止当前条目。 */
export function parseLogicalCheckboxes(block: string | null): LogicalCheckboxItem[] {
  if (!block) return [];
  const lines = block.split("\n");
  const out: LogicalCheckboxItem[] = [];
  let current: { checked: boolean; parts: string[]; indent: number; sourceLine: number } | null = null;

  const flush = () => {
    if (!current) return;
    out.push({ checked: current.checked, rawText: current.parts.join(" ").trim(), sourceLine: current.sourceLine });
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(CHECKBOX_LINE);
    if (m) {
      flush();
      current = {
        checked: m[2]!.toLowerCase() === "x",
        parts: [m[3]!.trim()],
        indent: m[1]!.length,
        sourceLine: i + 1,
      };
      continue;
    }
    if (!current) continue;
    if (line.trim().length === 0) { flush(); continue; }
    const indent = line.length - line.trimStart().length;
    if (indent > current.indent) {
      current.parts.push(line.trim());
      continue;
    }
    flush();
  }
  flush();
  return out;
}
