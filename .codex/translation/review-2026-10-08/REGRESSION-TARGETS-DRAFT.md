# 定向回归候选文件清单（预备稿，待冻结确认）

> 状态：预备稿。最终以修改方（CLI s_000cae46UNk / TUI s_000cae46uuw / UI s_000cae46wD0）
> 回复的冻结与最终文件清单为准。运行约束已定：vitest `run --maxWorkers=1 --minWorkers=1
> --no-file-parallelism`、隔离 HOME/OPENRIG_HOME、nice、单命令≤5min、只列具体文件。

## 入口三向探针（真实独立 symlink，非同一入口推断）

临时目录分别建 `rig`/`openrig`/`zrig` → `packages/cli/dist/bin-wrapper.js` 软链，逐一 `--version`/`--help`：

| 入口 | --version rc | --version 输出 | --help 首行 |
|---|---|---|---|
| rig | 0 | `0.6.0` | `用法： rig [选项] [命令]` |
| openrig | 0 | `0.6.0` | `用法： openrig [选项] [命令]` |
| zrig | 0 | `0.6.0` | `用法： zrig [选项] [命令]` |

- 品牌名确实按调用链接 basename 分别渲染（OPENRIG_INVOKED_AS 机制验证有效）。
- **观察项（非阻断）**：基线探针（构建前旧 dist）版本串为 `0.6.0 (57380a25, dirty)`；
  20:41 重建后 `dist/build-info.js` 回到开发占位 `{semver:null,...}`，版本串只剩 `0.6.0`。
  这是开发构建 vs 打包盖戳的既有机制（scripts/build-package.sh 才盖戳），非翻译回归；
  最终回归若比较版本串，以 `0.6.0` 裸串为基线预期，不要拿带 commit 后缀的旧串当断言。

## scripts 入口兼容守卫（node:test，非 vitest）

- `scripts/zrig-entry.test.mjs`（漏登记，CLI 方核查中）——隔离 HOME、仅 --version/--help、
  校验根 zrig 包装器 + npm bin 三名指向同一包装器。待冻结后跑。
- 同目录其余 `scripts/*.test.mjs`（28 个）属 test:repo 范围，**不裸跑全量**；
  仅当某文件与本次改动直接相关时按文件单个执行。

## CLI 候选（packages/cli）

- 入口/前门：`bin-wrapper.test.ts`、`front-door.test.ts`、`version-build-info.test.ts`
- JSON 边界与错误出口：`workflow-errors.test.ts`、`queue.test.ts`、`queue-cross-host-cli.test.ts`、
  `queue-update-metadata-reject-cli.test.ts`、`d14-loud-queue-transport-failure.test.ts`、
  `skill.test.ts`、`bootstrap.test.ts`
- 依据：源码中 `--json` 选项分布在 commands/queue.ts（10+ 处）、skill.ts、bootstrap.ts；
  统一 JSON 错误出口在 src/cli-error.ts（未知命令已实测输出合规 JSON）。

## TUI 候选（packages/tui）

- 中文宽度核心：`src/text-width.ts`（strWidth/padEndW，CJK 双宽区间表）
- action argv / shellWords / shell 续行：`src/execution/workflow-model.ts`
  （shellWords tokenizer、splitQuotedWord、actionLines 用 strWidth 计算续行）
- 对应测试：`actions.test.ts`、`grammar.test.ts`、`crash-cart-in-shell.test.ts`
- 展示断言相关：`render-regressions.test.ts`、`reading-regressions.test.ts`、
  `parity.test.ts`、`parity-content.test.ts`、`stylize`/`visual-layout` 配套测试

## UI 候选（packages/ui，待 UI 方给清单）

- 原则：只跑与中文展示文案/原展示断言直接相关的 test 文件；不跑全量 vitest。

## 不做

- 不跑裸根 vitest、不跑无参数 `npm test`、不跑 watch。
- 不删/不放宽任何断言；仅人类展示断言可按中文预期更新（由修改方完成，我只验证）。
- 视觉（TUI/UI 渲染、截图、截断、快捷键提示）本轮仍未验证，单列未覆盖。
