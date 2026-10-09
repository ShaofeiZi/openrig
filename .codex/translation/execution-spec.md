# 中文化执行要求（所有分区）

项目根目录 `/Users/bytedance/openrig`。任务为全量简体中文化，人类可见品牌为 zrig。执行时先读本文件、项目 `.codex/translation/style-spec.md`、分配给你的 manifest，以及用户选用的两个技能：
- `/Users/bytedance/.agents/skills/translate-docs-and-comment-code-zh/SKILL.md`（含 references/translation-workflow.md）
- `/Users/bytedance/.agents/skills/translation/SKILL.md`

## 独占范围与状态
只能修改 `.codex/translation/manifests/<owner>.json` 中分配的文件及对应中文伴随版、新增仅属于本分区的本地化测试/辅助模块。不得修改其他分区源文件、package-lock、其他 package manifests 或计划生成器。若跨文件修复属于别人的范围，报告给协调者。
逐文件通过 `python3 .codex/translation/scripts/state.py claim <owner> <source>` 标记进行中，完成时 `done <owner> <source> <具体说明>`，未完成/不适用用 `fail`/`skip` 附精确原因。不得直接批量覆盖计划/manifest。开始前确认备份路径可用（已由台账负责人统一准备）。新增文件单独记录在本组报告。
原始 Markdown 保持不变，所有译本 `*.zh-CN.md` 放旁边。机器消费的模板标题/字段要保留；让运行时实际加载中文版必须由拥有加载代码的执行者完成，跨组协调。

## 翻译质量与品牌
全文保真中文，不得用摘要、词典前缀替换、复制未翻译正文冒充完成。按规范翻译已有注释与全部人类可见帮助、错误、日志、默认界面文字和占位提示。API、JSON、枚举、协议、内部路径、命令标识、环境变量不变，使用本地展示映射而不污染机器数据。原始第三方/用户输入文本不强行翻译。`rig` 顶层示例改 `zrig`，内部 `rig` 子命令/字段/名称不改。原 `rig/openrig` 作为兼容入口保留。
英文自然语言残留必须审计，无法完成的文件不能标 done；可标 failed（局部已改但未全译）并量化剩余。不要因短期测试只覆盖首页就称全量完成。

## 恢复后的资源约束（优先于下文旧规则）
- 当前为部分完成，禁止把台账行结束或旧百分比当作交付完成。未覆盖、翻译错误、原有测试失败、新增回归必须分列。
- 同时最多两个轻量源码/文档修改任务；所有构建、类型检查、测试只能由统一验证任务执行，其他修改任务不得自行运行 npm test、vitest、tsc、build 或同类重操作。
- 同一时刻只运行一组验证。Vitest 必须核实本地版本参数，显式单 worker、关闭文件并行，列出具体测试文件；禁止 watch、无参数全量测试、并行版本对照和自动无限重试。
- 验证必须低进程优先级、有界超时、记录准确 PID 与进程树；结束或中止清理本次已核实进程树。禁止 pkill、killall 或按名称通杀，不能触及其他应用及安全软件。
- 源码按小批处理，使用已有日志与备份；完成批次后向统一验证任务请求定向验证。不要重复扫描全仓，不打印环境变量或令牌。系统负载仍高时先做轻量读取/编辑，不堆积验证进程。

## 验证与安全
项目依赖已安装，原始 `npm run build` 与 `npm run lint` 通过。基线测试有既有失败；原始报告位于 `/Users/bytedance/Library/Application Support/DoubaoWork/Default/.doubaowork/agent_mode/workspace/.sessions/38444802165309186/agents/s_000cDMtTmpJ/artifacts/baseline/BASELINE-REPORT.md`。
不得启动真实 daemon 或 Claude/Codex agent，不能改全局hooks/trust/权限，不能调用实际付费服务，不提交、不推送。测试必须按工作区 config 运行，并使用隔离 HOME/OPENRIG_HOME；不运行裸根 vitest。不要删除失败测试、宽泛放松断言或篡改协议使断言通过。只有人类展示断言按中文更新，保留行为检查。不要同时运行全仓测试，使用相关定向测试，最终集成由专人负责。
输出实体均在项目原位；工作报告/验证日志放你自己的 artifacts 并返回绝对路径。读取 `/Users/bytedance/Library/Application Support/DoubaoWork/Default/.doubaowork/agent_mode/workspace/.skills/verifier-hub/SKILL.md` 对交付文本/代码做适用格式验证并记录命令/结果（不是仅声称检查过）。UI/TUI需实际渲染截图且目视检查中文宽度、截断、快捷键提示；不能用 shell 启动/控制Chrome，GUI必须通过官方电脑工具。构建测试不是视觉检查的替代。

## 汇报格式
只回传精炼结果：owner；修改文件数/完整完成/跳过/失败/未处理数；关键行为变化；未翻译残留量及原因；测试命令与退出码；验证记录及截图的绝对路径；给集成者的跨文件问题。按分配范围持续完成，而不是早停在少数示范。若任务确实过大，尽早给出具体可拆分清单，不自行把剩余判为不需要翻译。

## 文档种子（必须参照语气与结构，不重复制作）
`/Users/bytedance/openrig/SECURITY.zh-CN.md`
`/Users/bytedance/openrig/CODE_OF_CONDUCT.zh-CN.md`
这些对应原文已完整翻译并通过格式检查，勿覆盖。
