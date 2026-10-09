# TUI 中文化复审 Batch-2 证据（agent s_000cae46uuw）

日期：2026-10-08 ｜ 范围：packages/tui/**，未触 ui/cli/daemon/根配置。改前均已快照。

## 实际修复（4 源/测试文件）

### 1. `src/render.ts` 自然语言残留
- 拓扑表头 `NODE/LABEL/RUNTIME`（纯展示列头，第 4 列"席位"已中文）→ `节点/标签/运行时`。列宽不变。
- 状态栏 `⚠ N read(s) failed: <err>`（1476、1833 两处，纯展示）→ `⚠ N 次读取失败: <err>`。
- 机器行数据（orch.lead / lead / orch / claude-code）与路由键均未动。

### 2. `src/execution/workflow-model.ts` splitQuotedWord 中文宽度低估
- 分块阈值由 `quoteShell(chunk+char).length` 改为 `strWidth(quoteShell(chunk+char))`。
- 证据：ASCII 下 strWidth==.length，既有 ASCII acceptance 测试 chunk 边界逐字不变；引号内 CJK 双宽字符不再被低估导致块过宽。

### 3. `test/workflow-journey.test.ts` 宽度断言升级（严格化，非放松）
- `screen.lines.every(line => line.length <= cols)` → `strWidth(line) <= cols`（60/84/120 三档）。中文双宽按 2 列计，堵住旧弱断言放过的越界。

### 4. 展示断言同步（保留行为）
- `test/render-regressions.test.ts:198` 表头断言 `/NODE\s+LABEL\s+席位\s+RUNTIME/` → `/节点\s+标签\s+席位\s+运行时/`。
- `test/execution-view.test.ts` 新增 CJK 回归用例（见下）。

## 新增精准回归测试
- `test/execution-view.test.ts`：单引号长中文参数 targeted_action，窄列（84/120）下
  1) `strWidth(line) <= cols` 无越界；
  2) 重构续行后交 `/bin/sh` 切分，argv 与原机器命令**逐字相等**（rig/workflow/project/--instance/.../--note/<整段中文>）；
  3) 不含省略号。复用既有 acceptance-action 强断言模式。

## 机器兼容
- shellWords/quoteShell 机器分词仍与 HEAD 逐字一致；argv 经真实 shell 复算逐字相等。
- readError 路由前缀 execution:/nodes(/rigs-summary:/specs-library 未动。

## 未验证
- 真实 TUI 终端截图目视仍未做（本环境未用官方电脑工具起终端）；宽度/argv 正确性由 strWidth 静态实现 + 上述单测（含 /bin/sh 逐字复算）佐证。
