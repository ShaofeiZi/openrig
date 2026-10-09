# TUI 中文化复审 Batch-3（失败修复 + 审读结论更正）

日期：2026-10-08 ｜ 范围 packages/tui/**。

## 性质澄清（更正措辞）
- 本批两项并非"两个实测失败"：
  - **1 项实测失败**：t05 跑 hydrate.test.ts:516 红了（readErrors 实得 2 项）。
  - **1 项静态缺陷**：clipW 逐字符 strWidth 拆 SGR，由用户直接读 text-width.ts 代码发现，**无运行时测试触发**，属代码审查发现的潜在缺陷，非测试红。

## 审读结论更正（重要）
- 我 batch1 曾称 `src/text-width.ts` "ANSI 安全/实现正确"——**错误**。
  `clipW` 原实现逐字符调用 `strWidth(ch)`：`strWidth` 只对整串剥 SGR，逐字符时 `\x1b[31m` 被拆成单字节逐个计数（各 1 列），且会从序列中间截断，残留半个 `\x1b[3` 之类泄漏终端。已修正结论：clipW 原实现对内嵌 SGR 不安全。
- （dropW/columnIndex 同为逐字符 strWidth 模式，属同类潜在点；本轮按授权只修 clipW，其余记录为后续缺口，不扩散。）

## 实际修复
1. `src/text-width.ts` clipW：改为 token 化扫描——SGR 序列 `\x1b[..m` 整段原样透传（0 列、不截断），其余按 Unicode 码点 strWidth 计列。纯文本路径行为不变。
2. `test/hydrate.test.ts` 我新增用例 fixture：configBrowser 需完整契约（readOnly:true + entries/sources/exclusions 数组），原 `{groups,entries}` 缺契约导致它另抛"配置读取: 不可用"。已给合法响应，把 readError 精确隔离为仅 Slack 连接故障——数量断言 toHaveLength(1) **保留不放宽**。

## 新增回归
- `test/text-width.test.ts`（新建）：strWidth CJK=2/SGR 剥列；clipW CJK 不拆字；clipW 内嵌 SGR 整段透传、无截断半成品、结果显示宽度<=width。

## 根因（t05 失败）
hydrate 用例实得 2 项 readError：`Slack 连接观察: 不可用` + `配置读取: 不可用`。第二项来自 configBrowser 契约校验抛错，非断言放宽可解；给合法响应隔离后预期仍为精确 1 项（仅 Slack）。

## verifier
- 见本目录 batch3 报告校验（format + must-contain 3/3）。

## 明确保留的缺口（不宣称已解决）
- dropW / columnIndex 同为逐字符 strWidth 模式，同类 SGR 拆分隐患未修。
- 真实 TUI 终端渲染截图目视始终未做。
- 补充平面（emoji/扩展 BMP）与组合符（combining marks）的显示宽度**未全量评估**；
  text-width.test.ts 只覆盖 BMP 内 CJK + SGR，**不能据此宣称所有 Unicode 宽度正确**。
