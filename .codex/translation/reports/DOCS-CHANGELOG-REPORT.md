# docs-changelog 中文化验证记录

- Owner：`docs-changelog`
- 执行模式：串行
- 范围：`CHANGELOG.md` → `CHANGELOG.zh-CN.md`
- 原文策略：保留原文件不变；备份位于 `.codex/translation/backup/docs-changelog/CHANGELOG.md.bak`

## 翻译规则

- 人类可见产品品牌统一为 zrig；用户可执行命令的顶层 `rig` 改为 `zrig`。
- 历史兼容语境、内部 `rig` 标识、命令参数、API 路由、环境变量、枚举、版本号和贡献者信息保持原义。
- 保留标题层级、列表层级、代码围栏、加粗标记、分隔线与链接目标。
- 未修改 `CHANGELOG.md`，也未修改其他 owner 的源文件或目标文件。

## 验证结果

1. 源文件与备份逐字节相同：通过。
2. 自定义结构与协议审计：通过。
   - 标题：297 / 297。
   - 发布版本章节：30 / 30。
   - 代码围栏：22 / 22。
   - 顶层列表项：772 / 772；嵌套列表项：23 / 23。
   - 编号列表项：顶层 9 / 9；嵌套 6 / 6。
   - 加粗标记：1268 / 1268；水平分隔线：24 / 24。
   - Markdown 链接目标：52 / 52，目标集合完全一致。
   - 行内代码：1480 / 1480；仅对用户可执行的顶层入口应用 `rig` → `zrig`。
   - 围栏内命令：46 / 46；除顶层入口 `rig` → `zrig` 及人类可见说明翻译外，命令骨架一致。
   - 占位符残留：0；可执行裸 `rig <verb>` 残留：0。
3. `git diff --check -- CHANGELOG.zh-CN.md`：退出码 0。
4. verifier-hub `rubric check-file-format`：通过，证据见 `validation.log`。
5. verifier-hub `text lang-ratio`：CJK 42141 / 非空白字符 89219，比例 0.472；证据见 `validation.log`。
6. verifier-hub `text placeholder-audit`：报告 11 个省略号；逐项核对均为原文保留的命令参数或结构省略号，不含 TODO、FIXME、TBD、翻译占位符或生成器令牌；证据见 `validation.log`。

## 未执行

- 未运行 build、typecheck 或测试；当前 owner 只新增 Markdown 伴随译本，且执行规范禁止修改任务自行运行重型验证。
- 未启动后台服务、真实席位或浏览器；本任务不涉及 UI/TUI 运行时改动，截图不适用。
- 未提交、未推送。

## 最终状态

- 总计：1
- 完成：1
- 跳过：0
- 失败：0
- 未处理：0
- 未翻译的人类可见英文正文：0（保留内容均为技术术语、协议值、命令、路径、专有名称或历史原文标识）
