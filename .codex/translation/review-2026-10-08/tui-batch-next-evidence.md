# TUI 中文化复审 Batch-next（text-width ANSI 边界收口）

日期：2026-10-08 ｜ 范围 packages/tui/src/text-width.ts + test/text-width.test.ts。
不改 batch1/2/3 报告；本文件独立。

## 修的真实点
1. `dropW` 与 `columnIndex` 原逐字符 `strWidth(ch)`，与 clipW 旧版同病：
   SGR 被拆字节逐字符计数、slice/索引可落在半个转义序列上。
   - dropW：改为 token 化，SGR 整段保留进 prefix（颜色状态不丢）、不计列；
     丢弃条件 `used+cw>width` 原样保留 → 无 SGR 路径行为逐字不变，双宽不拆。
   - columnIndex：SGR 占 UTF-16 索引但不占显示列（render.ts:1801 选中标记定位不再被转义带偏）。
2. clipW 契约写明确（不改行为）：内部 SGR 整段保留但**不补 reset**（颜色调用方管）；
   width<=0 仍返回省略号；双宽不拆、省略号占 1 列。

## 契约边界（明确不宣称）
- 只保证 SGR(`\x1b[..m`) 整体 + BMP 内 CJK 码点。
- 不做 grapheme cluster：组合符(combining marks)在 strWidth 里各自计 1 列，未按字素合并。
- 补充平面 emoji(1f300+)按现有区间计 2 列；其余未列符号计 1 列。
- 真实终端渲染目视仍未做。

## 新增回归（不改行为掩盖失败）
test/text-width.test.ts 追加：
- dropW：无 SGR 路径逐字（你好世界/2→好世界，/1→不拆保留）、width<=0 原样、前导 SGR 保留且无半个转义残留。
- columnIndex：无 SGR 列定位、SGR 占索引不占列、越列只走到末尾。

## verifier
见本文件 format + must-contain 校验（单次 --terms 三词）。
