# zrig 中文化项目 — 零点基线验证报告（构建 / 类型检查 / 入口）

- 验证执行者：s_000cae4sfcS（唯一构建/类型检查/测试执行者）
- 仓库：`/Users/bytedance/openrig`，HEAD `57380a25`（version 0.6.0，工作树 dirty=3141 项既有改动）
- 基线时间窗：2026-10-08 20:40:42 ~ 20:42:23 +0800
- **基线非冻结快照**：3 个修改方（CLI+daemon s_000cae46UNk / TUI s_000cae46uuw / UI s_000cae46wD0）同期在改产品源码；本结果仅对上述时间窗内代码状态负责，最终回归需以修改方完成后复跑为准。

## 资源与前置只读检查

- 运行前 `ps` 只读核查：无 vitest / tsc / build / watch 进程在跑；存在 3 个长期 daemon 进程（ packages/daemon/dist/index.js ，由其他会话长期持有）与 tmux 场景会话，本次**未启动、未连接、未终止**任何此类进程。
- node v22.23.2 / npm 10.9.8（满足 engines `^22 || ^24`）。
- 本会话所有重命令均：`nice -n 10`、隔离 `HOME`/`OPENRIG_HOME`（指向本证据目录 isolated-home）、串行单一执行、日志落盘。

## 入口核实（无副作用探针，全部管道非 TTY）

| 探针 | 命令 | exit | 耗时 | 结果 |
|---|---|---|---|---|
| p01 | `OPENRIG_INVOKED_AS=zrig node packages/cli/dist/bin-wrapper.js --version` | 0 | 1s | `0.6.0 (57380a25, dirty)` |
| p02 | 同上，品牌 rig | 0 | <1s | 同上（版本输出与品牌无关） |
| p03 | 同上，品牌 openrig | 0 | <1s | 同上 |
| p04 | 同上 `--help` | 0 | 1s | 中文用法/命令列表，命令标识（start/daemon/status/up…）未中文化保留 |
| p05 | 未知命令 `--json`（机器 JSON 错误边界） | 1 | <1s | stdout: `{"ok":false,"error":{"code":"commander.unknownCommand","message":"未知命令“no-such-cmd-xyz”"}}`，stderr 为空 |

入口关系确认：
- 源码检出入口 = 仓库根 `zrig` 薄包装脚本 → `packages/cli/dist/bin-wrapper.js` → `dist/index.js`。
- npm 安装布局：`packages/cli/package.json` bin 同时映射 `rig`/`zrig`/`openrig` → 同一个 `dist/bin-wrapper.js`；品牌仅通过 `OPENRIG_INVOKED_AS` 影响帮助/版本展示，协议/socket/包名不变。
- 未启动任何真实 daemon、Claude/Codex 或真实任务；未运行裸 `zrig`（会在交互 TTY 开 TUI）。

## 构建（npm run build）

- 日志：`logs/b01-build.log`（103 行）
- 时间：20:40:42 → 20:41:51，约 69s，**exitcode=0**
- 覆盖：daemon → ui（vite 产物 index 1972 kB，chunk>500kB 仅为既有 warning，非错误）→ cli（tsc + schemas/scope-templates 拷贝）→ tui（tsc）。

## 类型检查（四包 tsc --noEmit）

- 日志：`logs/b02-typecheck.log`
- 时间：20:42:09 → 20:42:23，约 14s，**exitcode=0**

| 项目 | exit | 耗时 |
|---|---|---|
| packages/daemon | 0 | 5s |
| packages/ui | 0 | 6s |
| packages/cli | 0 | 2s |
| packages/tui | 0 | 1s |

（直接复用已构建产物，未重复 build daemon，符合“勿无谓反复 build”。）

## 本轮明确未覆盖（不得视为通过）

1. **任何自动化测试均未运行**（按指令零点只做构建/类型检查/入口；vitest 最终回归待修改方完成后通知执行）。
2. **UI/TUI 视觉验证未做**：无截图、无 GUI 渲染核查——中文宽度、截断、快捷键提示、TUI 机器字段宽度等均属未验证项，不以前述构建通过替代。
3. 未跑 test:repo（scripts/*.test.mjs、docs-guard、mirror-skills/context-packs --check）、未跑 daemon/cli/tui/ui 任何 vitest 套件。
4. 未触碰 ledger（.codex/translation/plan.md / _records.json / manifests），未做任何 git 操作。

## 给最终回归的边界备忘

- Vitest 实跑时将用：`run --maxWorkers=1 --minWorkers=1 --no-file-parallelism`（严于上限 4 workers），列具体测试文件，禁 watch、禁无参数根跑。
- 回归重点：TUI 机器字段/中文宽度/action argv/shellWords、UI 可见文本与原展示断言、CLI 帮助与 JSON 兼容。
