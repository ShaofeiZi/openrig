# extras 中文化交付报告

- Owner：`extras`
- 执行模式：串行；对与 daemon shared 源逐字一致且对应 owner 已完成的中文伴随版进行受控复用
- 状态：118 项全部进入终态；102 done、16 skipped、0 failed、0 pending、0 in_progress
- 文档：59 份 `*.zh-CN.md` 伴随版；原始 Markdown 保持不变
- 代码/配置：43 份完成自然语言注释或展示文案中文化；机器 key、enum、路径、协议字段与 fixture 输入保持不变
- 跳过：16 份无可翻译自然语言或由精确验证器冻结的机器契约文件；原因逐项记录在 `manifests/extras.json`
- 备份：`.codex/translation/backup/extras/original-backup.tar.gz`（113 个本轮起始 pending 源文件）

## 关键行为变化

- demo 的用户命令入口改为 `zrig`，同时允许解析旧英文与中文标签形式的工作组/快照 ID 输出。
- spike TUI 的人类可见文案和相关测试断言已中文化；内部 `rig` 资源命令保持不变。
- spike renderer 新增 Unicode/CJK 终端显示宽度计算与按列切片，避免中文双宽字符破坏对齐或被截断。
- canonical skill 中文伴随版与已完成的 daemon shared 译本保持同步。

## 验证记录

| 检查 | 结果 |
|---|---|
| `python3 .codex/translation/scripts/state.py show extras` | PASS：`total=118 pending=0 in_progress=0 done=102 failed=0 skipped=16` |
| 文档结构审计（标题、代码围栏、占位符泄漏、目标存在性） | PASS：59 文件，0 错误 |
| `verifier rubric check-file-format <file> --expected-ext .md` | PASS：59/59 |
| YAML `safe_load` | PASS：18/18 |
| `bash -n` + `node --check` | PASS：15 文件 |
| `node --test spike/tui-drivability/grammar.test.mjs spike/tui-drivability/parity.test.mjs spike/tui-drivability/state.test.mjs` | PASS：19/19 |
| `npx vitest run --config vitest.config.ts test/release-surface.test.ts test/affected-skills-corpus.test.ts --pool forks --maxWorkers 1 --no-file-parallelism`（`packages/cli`） | PASS：13/13 |
| 定向 daemon 测试 | 已执行的 `public-world-pack` 22/22 与 `spec-library-starters` 27/27 通过；整组随后被 120 秒 CPU 上限终止并报告 `ERR_IPC_CHANNEL_CLOSED`，未观察到断言失败；未自动重试重型检查 |
| `git diff --check`（已跟踪的 extras 交付路径） | PASS |
| 生成文档行尾空白审计 | PASS：59/59 |

## 未翻译残留与跨 owner 注意项

- 16 个 skipped 文件只有机器值/结构，或由仓库 verifier 按精确值冻结；未翻译是为了保留契约。
- 代码围栏中的 shell 输出、错误 token、fixture 文本和协议字面值按约定保留英文。
- `skills/_canonical/core/agent-startup-and-context-ingestion/SKILL.zh-CN.md` 与 shared 中文译本仅有一处有意差异：extras 将面向用户的 ``rig context`` 修为 ``zrig context``。建议 shared owner 同步此品牌修正。其余 43 份 canonical 源和译文均与 shared 侧逐字一致。
- 未运行 build、全量测试、后台服务或真实席位；符合任务限制。
