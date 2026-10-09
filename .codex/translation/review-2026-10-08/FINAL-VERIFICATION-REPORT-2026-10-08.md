# zrig 中文化最终定向验证报告（2026-10-08）

- 仓库：`/Users/bytedance/openrig`，HEAD `57380a25`（0.6.0，dirty 工作树）
- 运行约束：nice 低优先级；隔离 HOME/OPENRIG_HOME；连接环境变量全部 unset；
  vitest `--maxWorkers=1 --minWorkers=1 --no-file-parallelism`；全程串行、单条重命令。
- 计数口径：distinct 测试文件/用例（复跑不叠）；用例数 = vitest/node:test `Tests` 计数，非独立断言数。
  本报告所有计数均由 `results.json` 程序化求和得出（共 21 文件 / 301 用例）。

## 总结论

**21 个定向测试文件 / 301 个测试用例全部通过，0 失败；build exit=0；四包 tsc 全 exit=0；
三入口（rig/openrig/zrig）探针全部符合预期。**

这是定向子集结果，不等于全量无回归：其余 vitest 套件与 test:repo 其余守卫本轮未跑。

按工作区分项（程序化求和）：daemon 62；ui 53；cli 73；scripts(node:test) 5；tui 108。

## 时间窗（均取自原日志起止标记，不含手工合计）

| 批次 | 窗口 | 结果 |
|---|---|---|
| b01 构建 | 20:41:25–20:41:51 | exit=0 |
| b02 类型检查 | 20:42:09–20:42:23 | 四包 exit=0 |
| t01 daemon 定向 | 20:47:18–20:47:21 | 见下表 |
| t02 UI 定向（首版） | 20:52:57–20:53:10 | 见下表 |
| t03 daemon coherence | 20:53:33–20:53:34 | 见下表 |
| t04 UI 复跑（新断言） | 20:55:29–20:55:33 | 见下表；**该批 exit=1 系验证者把 `build-setup-prompt.test.ts` 误写成 `.tsx` 导致“找不到测试文件”，非测试失败**（该文件后在 t05 以正确扩展名通过） |
| t05 混合批 | 20:56:20–20:56:24 | 见下表；含 hydrate:516 一处失败，已转作者修复 |
| t06 CLI/scripts/TUI | 21:01:48–21:01:54 | 见下表 |
| t07 execution-view 复跑 | 21:04:10–21:04:11 | 见下表，前后 hash 一致 |
| t08 TUI 终验 5 文件 | 21:05:27–21:05:32 | 见下表（含 hydrate 修复后结果） |
| t09 终验 build+tsc+入口 | 21:06:00–21:06:34 | build rc=0（20s）、tsc rc=0（合计 11s）、探针全过 |

## 逐文件明细（取自 results.json，逐行可核对）

| 工作区 | 文件 | 用例数 | 状态 | 运行时刻 | 日志 |
|---|---|---|---|---|---|
| daemon | packages/daemon/test/profile-resolver.test.ts | 34 | passed | 2026-10-08T20:47:19 | verification-logs/t01-daemon-targeted.log |
| daemon | packages/daemon/test/mission-control-read-layer.test.ts | 8 | passed | 2026-10-08T20:47:20 | verification-logs/t01-daemon-targeted.log |
| daemon | packages/daemon/test/progress-review-done-coherence.test.ts | 20 | passed | 2026-10-08T20:53:33 | verification-logs/t03-daemon-coherence.log |
| ui | packages/ui/test/mission-status-badge.test.tsx | 10 | passed | 2026-10-08T20:52:58 | verification-logs/t02-ui-targeted.log |
| ui | packages/ui/test/bundle-inspector.test.tsx | 10 | passed | 2026-10-08T20:55:29 | verification-logs/t04-ui-rerun.log |
| ui | packages/ui/test/package-list.test.tsx | 11 | passed | 2026-10-08T20:55:31 | verification-logs/t04-ui-rerun.log |
| ui | packages/ui/test/mission-status-surfaces.test.tsx | 9 | passed | 2026-10-08T20:53:03 | verification-logs/t02-ui-targeted.log |
| ui | packages/ui/test/workspace-portfolio.test.tsx | 6 | passed | 2026-10-08T20:53:07 | verification-logs/t02-ui-targeted.log |
| ui | packages/ui/test/project-workspace-overview.test.tsx | 6 | passed | 2026-10-08T20:53:08 | verification-logs/t02-ui-targeted.log |
| ui | packages/ui/test/build-setup-prompt.test.ts | 1 | passed | 2026-10-08T20:56:20 | verification-logs/t05-ui-tui-mix.log |
| cli | packages/cli/test/send.test.ts | 73 | passed | 2026-10-08T21:01:48 | verification-logs/t06-cli-scripts-tui.log |
| scripts(node:test) | scripts/zrig-entry.test.mjs | 5 | passed | 2026-10-08T21:01:50 | verification-logs/t06-cli-scripts-tui.log |
| tui | packages/tui/test/text-width.test.ts | 5 | passed | 2026-10-08T21:05:27 | verification-logs/t08-tui-final5.log |
| tui | packages/tui/test/hydrate.test.ts | 36 | passed | 2026-10-08T21:05:28 | verification-logs/t08-tui-final5.log |
| tui | packages/tui/test/config-model.test.ts | 4 | passed | 2026-10-08T20:56:22 | verification-logs/t05-ui-tui-mix.log |
| tui | packages/tui/test/execution-view.test.ts | 27 | passed | 2026-10-08T21:05:28 | verification-logs/t08-tui-final5.log |
| tui | packages/tui/test/actions.test.ts | 7 | passed | 2026-10-08T20:56:23 | verification-logs/t05-ui-tui-mix.log |
| tui | packages/tui/test/workflow-journey.test.ts | 2 | passed | 2026-10-08T21:05:29 | verification-logs/t08-tui-final5.log |
| tui | packages/tui/test/render-regressions.test.ts | 13 | passed | 2026-10-08T21:05:31 | verification-logs/t08-tui-final5.log |
| tui | packages/tui/test/parity.test.ts | 4 | passed | 2026-10-08T21:01:53 | verification-logs/t06-cli-scripts-tui.log |
| tui | packages/tui/test/parity-content.test.ts | 10 | passed | 2026-10-08T21:01:54 | verification-logs/t06-cli-scripts-tui.log |

命令全文、test_sha256 与 hash 采样时刻见 `results.json`。

## 三入口探针（t09，独立 symlink 真实调用）

- rig / openrig / zrig `--version` 均输出 `0.6.0`
- `--help` 首行分别为 `用法： rig/openrig/zrig [选项] [命令]`
- 未知命令 `--json` 三者均输出同一对象：
  `{"ok":false,"error":{"code":"commander.unknownCommand","message":"未知命令“no-such-cmd-xyz”"}}`

## 原始日志（原件，未改动）

目录：`/Users/bytedance/openrig/.codex/translation/review-2026-10-08/verification-logs/`
共 33 份：b01/b02、p01–p05 与 p10 入口探针、t01–t09 全部批次日志。

## 未覆盖（不得当全量完工）

1. 除上述 21 个文件外的所有测试套件未跑。
2. 本轮未执行真实 GUI 视觉核查（UI/TUI 渲染、截图、中文截断、快捷键提示均未目视）。
3. 零点台账 1965 项 done 为当时自报，期末由台账重算；本报告不沿用该数。
4. version-build-info 为开发占位（`0.6.0` 裸串），盖戳差异属打包机制，非翻译回归。

## 过程中发现并修复的唯一失败

`tui/test/hydrate.test.ts:516`：夹具未隔离 Slack，中文“不可用”错误过滤期望 1 条实得 2 条；
作者补 readOnly/sources/exclusions 隔离后，t08 复跑 36/36 通过。未删/未放宽任何断言；
机器字段、JSON 边界、枚举、协议标识均未改动。
