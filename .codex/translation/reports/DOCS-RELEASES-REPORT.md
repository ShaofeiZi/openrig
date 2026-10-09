# docs-releases 中文化交付报告

- owner: `docs-releases`
- manifest: `.codex/translation/manifests/docs-releases.json`
- 范围: `docs/releases/` 下 36 个 Markdown 原文及对应 `*.zh-CN.md` 伴随版
- 执行方式: 串行翻译，每次最多 2 个 `in_progress`，逐项通过 `state.py claim` / `done` 更新
- 原文策略: 原始 Markdown 保持不变；未覆盖其他 owner 文件
- 备份: `.codex/translation/backup/` 已存在且可写；本组仅新增伴随版，未改原文，因此无需恢复原文副本

## 总状态

```text
docs-releases total=36 pending=0 in_progress=0 done=36 failed=0 skipped=0
```

全部 36 个目标文件存在且非空。无 pending、in_progress、failed 或 skipped 项。

## 翻译与保留原则

- 人类可见产品品牌统一为 zrig；用户命令示例的顶层 `rig` 改为 `zrig`。
- 原始 Markdown 不变，译文与原文并列保存。
- 保留 code fence、链接目标、路径、版本号、commit/tree SHA、环境变量、API route、JSON key、枚举、状态字段、错误 code 和机器协议。
- 历史 commit subject、测试断言和 Claude permission rule `Bash(rig down:*)` 中的 `rig` 按历史/协议原值保留。
- 发布状态、已知限制、未验证项和 publication/adoption 边界均保留，不将 candidate 或实验能力表述为已正式发布或已证明。

## 验证结果

未运行 build、typecheck、test、daemon 或真实席位；这是纯文档 owner，且执行规范要求修改任务不得自行运行重型验证。截图不适用于 Markdown 文档。

执行的轻量检查：

1. `python3 .codex/translation/scripts/state.py show docs-releases`
   - 退出码 0。
   - 结果：36 done，0 pending，0 in_progress，0 failed，0 skipped。
2. 自定义只读结构审计（遍历 manifest 的 36 对 source/target）
   - 退出码 0。
   - 结果：标题、代码围栏、Markdown 表格、列表项、链接目标、版本集合和含数字 SHA 集合全部匹配，`structural_errors=0`。
3. `git diff --no-index --check /dev/null <target>`（逐个目标文件）
   - 退出码 0。
   - 结果：`whitespace_failures=0`。
4. 英文自然语言残留审计（排除 fenced code、inline code、链接和 URL）
   - 退出码 0。
   - 结果：未发现缺少中文上下文的长英文正文行。允许残留仅为技术术语、协议值、代码、历史提交文本和专有名称。
5. verifier-hub `rubric check-file-format <target> --expected-ext .md` 与 `text lang-ratio --file <target>`（逐个目标文件）
   - 退出码 0。
   - 结果：`verifier_files=36 failures=0`。
6. verifier-hub `text placeholder-audit --file docs/releases/v0.6.0.zh-CN.md`
   - 退出码 0。
   - 证据：`0 placeholders (none)`。

全组译文共 3,005 行、约 292 KB；CJK 字符 47,668。未翻译的人类可见英文正文：0。

## 给集成者的说明

- 无跨 owner 代码问题。
- 无需启动后台服务、真实席位或浏览器。
- 未 commit、未 push。
