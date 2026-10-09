# docs-packages-a 中文化验证记录

- Owner：`docs-packages-a`
- 执行模式：串行小批处理（逐项 `state.py claim`，验证后逐项 `done`/`skip`）
- 本次开始时：92 pending
- 本次修改：88 个文件（新增 55 个 `*.zh-CN.md`，原地本地化 33 个 YAML）
- 本次跳过：4 个 YAML；仅含 `name/version/resources/profiles/uses/skills` 等机器字段和标识符，没有可翻译的自然语言值或注释
- Owner 最终状态：96 done，4 skipped，0 failed，0 pending，0 in_progress
- 备份：`.codex/translation/backup/docs-packages-a/`（92/92 个本次源文件）

## 行为与契约

- 原始 Markdown 均保持不变，中文伴随版位于相邻 `*.zh-CN.md`。
- 面向用户的顶层命令示例使用 `zrig`；兼容入口、历史命令语义或机器标识中的 `rig`/`openrig` 保留。
- YAML 仅翻译注释和明确的人类可读值；key、ID、enum、路径、正则、步骤动词、状态和 fixture 契约保持不变。
- 未发现未翻译的英文自然语言段落；保留的英文为命令、API/JSON/YAML 字段、状态、标识符、产品/技术名词和引用原文。

## 验证

| 检查 | 结果 |
| --- | --- |
| 源文件与 owner 备份逐字节比较 | 55/55 个 Markdown 源文件未变 |
| Markdown 结构审计（heading、fence、bullet、Mustache） | 55/55 通过；0 errors，0 suspicious English prose warnings |
| YAML `safe_load` 与递归结构/字段 allowlist 对比 | 33 个修改项和 4 个跳过项均通过；机器契约无非预期漂移 |
| `git diff --check`（仅本 owner 目标） | 退出码 0 |
| verifier `rubric check-file-format`（逐文件） | 92/92 通过 |
| verifier `text lang-ratio`（逐 Markdown） | 55/55 检测到中文；最低比例 0.168（命令密集的 Vault 文档） |
| `state.py show docs-packages-a` | `total=100 pending=0 in_progress=0 done=96 failed=0 skipped=4` |

遵循资源限制，未运行构建、测试、daemon 或真实席位；本分区没有 UI/TUI 运行时变更，因此无需截图。
