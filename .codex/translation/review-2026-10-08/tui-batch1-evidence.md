# TUI 中文化复审 Batch-1 证据（agent s_000cae46uuw）

日期：2026-10-08 ｜ 范围：仅 packages/tui/**，未触 ui/cli/daemon/根配置。

## 机器兼容审查证据（git 基线 HEAD=57380a25）

- `src/execution/workflow-model.ts`：`shellWords`/`quoteShell`/`splitQuotedWord` 与 HEAD 逐字节相同（纯 ASCII shell 分词，无中文侵入）。
  - 上一轮正确把 `actionLines` 两处列宽判断从 `.length` 改为 `strWidth(...)`（HEAD 用 `.length`，中文双宽会换行错误）；展示标签 `action`→`动作`。
  - `splitQuotedWord` 内部分块阈值仍用 `.length`：但该函数只作用于 daemon 机器构造的单引号参数（候选 sha / 证据路径 / 会话邮箱，均 ASCII），ASCII 下 `.length`==显示宽度，且无 CJK 可达路径——判为无需修改，不凑数。
- `src/text-width.ts`：剥离 ANSI SGR、按 codePoint 迭代、CJK 双宽=2；pad/clip/drop/column 全部基于显示宽度。（台账待补登记为新 pending。）
- `src/detail.ts`：`wrapDetailLines`/`takeColumns`/`pad`/`sectionRule` 均用 strWidth。

## 机器路由键（保持英文原值，未翻译）
- readError 前缀 `execution:` / `nodes(<rig>):` / `rig-spec(` / `rigs-summary:` / `specs-library` 被 execution-model.ts:779、connections-model.ts:135、render.ts:958/944 做 startsWith 程序化匹配——必须保持英文。
- Action 对象 `{type:"act",act:"run"|"open-terminal",rigId,agent,view}` 在 actions.test.ts 逐字断言；grammar 无 act 动词（`run/term/up` 解析为 error）行为断言保留。
- `targeted_action==="INDETERMINATE"`、`queue_state:"blocked"`、`graph_source.mode:"project-profile"`、`stepId` 序列在 workflow-journey/execution-view 测试逐字保留。
- execution-model.ts:363 guidance 标签映射 `{Integration decision→集成决策, Admission→准入, Review→评审, Exit→退出条件}`，未知 label 原样回落；line 358 逻辑判断仍用机器枚举原值。映射完整（daemon 仅发这 4 类）。

## 实际修复（本批）
`src/hydrate.ts` config 分支 3 个纯展示 readError label（HEAD 即英文、翻译轮遗漏、无 startsWith 路由匹配、无测试断言）：
- `"CONFIG"` → `"配置读取"`
- `"control plane"` → `"后台控制面"`
- `"Slack observation"` → `"Slack 连接观察"`
（后缀“: 不可用”已是中文。）

## 新增精准回归测试（不删/不放松原断言）
`test/hydrate.test.ts` 新增 1 例：config 分支 connections 读取 503 时，
- readError 以 `Slack 连接观察: 不可用` 开头（展示中文）；
- 不得再出现 `Slack observation` 旧英文 label；
- 仅产生 1 条“不可用”（configBrowser/health 成功）。

## 未验证 / 剩余缺口（如实）
- TUI GUI 实际渲染截图与目视宽度/截断/快捷键：本环境未通过官方电脑工具启动真实终端，**视觉项未验证**；宽度正确性依据静态 strWidth 实现 + execution-view.test.ts:341 的 strWidth 越界断言与 :358 `/bin/sh` argv 逐字节回归。
- render.ts:1476/1833 状态栏英文 `read(s) failed:`（HEAD 即英文）：render.ts 不在本批 needs_review，未动，列为剩余缺口。
- workflow-journey.test.ts:115 宽度断言为弱 `line.length<=cols`（非本批引入），未改。
