# 构建你的世界

## 第一版保持精简

<!-- world-claim: minimal-world-layout -->
从一个能说明它服务于哪个世界的目录开始：

```text
book-world/
  manifest.yaml
  world.md
  boundaries.md
```

<!-- world-claim: authoring-convention -->
manifest 列出文件；正文说明持久目的、关系以及应信任的来源。当同一份内容需要携带情境、运行时、顺序或区域元数据时，再添加 atom。当人工编写的陈述可能漂移成会造成后果的错误信息时，再添加 claim ledger 和 verifier。不要在尚无读者时引入流程负担。

## 区分内容类型，为区域添加标签

<!-- world-claim: context-kinds -->
WORLD + LORE + SKILLS + MISSION 是上下文类型的顶层划分。

- WORLD：智能体所处的位置——实体、关系、规则、历史、状态来源和可执行能力。
- LORE：某个位置在实际运行中积累的知识。
- SKILLS：可重复使用的过程能力。
- MISSION：当前工作及其重要原因。

<!-- world-claim: regions-are-tags -->
八个区域是 atom 上的元数据，不是强制目录树。为现有人工编写文件添加 identity、ontology、terrain、actors、laws、history、state 和 affordances 标签。一份连贯的文件可以覆盖多个区域；不要把同一观点分叉成八份副本。

## 维护诚实的覆盖地图

<!-- world-claim: coverage-map-contract -->
每个覆盖项都应说明一个维度、一个准确的上下文地址，以及应触发读取的任务时机。地址就是事实源：在该维度作出关键决策之前，使用 `zrig context get <address>` 获取它。

| 维度 | 准确地址 | 包含内容 | 当任务要求你执行以下操作时读取 |
|---|---|---|---|
| product | `world-public/boundaries.md#this-pack-does-not-cover` | 公共指引的边界；项目必须提供自己的实际目的和产品判断。 | 选择产品结果或权衡方案，并找到能够作出决定的项目权威来源。 |
| topology | `skills/core/openrig-architect/SKILL.md` | 可迁移的拓扑编写方法、角色选择、验证和上下文指引。 | 新增、拆分、合并或分配席位、pod、边或职责边界。 |
| context | `world-public/build-your-world.md#separate-kinds-tag-regions` | World/Lore/Skills/Mission 划分方式和区域标签规则。 | 决定知识应放在哪里，或是否应预加载。 |
| skill | `onboarding-width/public-reference-material.md#the-one-you-read-rather-than-consult` | 运行模型入口，以及它与按需查询参考资料之间的区别。 | 选择运行模型或可重复过程，而不是即兴设计。 |
| queue/custody | `onboarding-width/public-what-you-can-do.md#making-work-outlive-you` | 持久队列的所有权、状态、阻塞和事务性交接。 | 分配、认领、阻塞、交接或关闭必须跨 turn 或跨任期保留的工作。 |
| source/worktree | `onboarding-width/public-reference-material.md#the-command-surface-docs-as-built-in-the-source-repo` | 维护中的 as-built 源码地图及其信任元数据。 | 定位源代码 owner、选择权威文档，或区分分支状态与运行行为。 |
| proof/review | `skills/process/verification-before-completion/SKILL.md` | 先有证据再下结论、内容检查和未测试维度；应用项目选择的证明标准。 | 决定哪些证据能支持变更，或设计负向对照。 |
| lifecycle/release | `skills/core/rig-lifecycle/SKILL.md` | 生命周期机制与限制；发布归属必须来自实际项目权威。 | 规划生命周期操作，并明确谁有权执行或发布。 |
| continuity/recovery | `onboarding-width/public-what-you-can-do.md#when-something-is-broken` | 恢复、交接、上下文压缩、快照和还原能力。 | 在不丢失连续性的前提下恢复、交接、压缩或修复席位、工作组、后台服务或主机。 |
| host-boundary | `skills/core/cross-host-rig-commands/SKILL.md` | 主机寻址、传输和验证限制；本地权限仍需单独声明。 | 在主机之间迁移操作，或判断适用的目标与权限。 |

以上地址是公共入口，不代表本项目已经作出对应决策。当某一行需要本地产品、发布或主机权限时，应解析已配置的项目上下文，并在行动前记录其准确地址。如果没有编写或无法取得这样的权威来源，应报告缺失的决策；不要把公共机制指南当成授权。该地图只负责指出起点，不会虚构内置项目策略。

检查公共 pack，并为新会话组合它：

```bash
zrig context get world-public
zrig context profile world-public --situation fresh
```

<!-- world-claim: retrieve-public-pack -->
使用 `zrig context get world-public` 获取组装后的公共 pack 内容。

<!-- world-claim: compose-fresh-profile -->
使用 `zrig context profile world-public --situation fresh` 组合其新会话 atom 图。

<!-- world-claim: region-metadata -->
`regions` 字段说明一个 atom 覆盖哪些维度；atom 将其作为 manifest 元数据携带，消费者可以把这些元数据当作数据进行过滤。
<!-- world-claim: no-region-selector -->
本 pack 不承诺提供区域选择器或子集组合操作。如果真实消费者需要按区域子集组合，应将该能力作为独立的 profile-composer 工作来处理。

<!-- world-claim: derived-reading-cost -->
阅读成本在组合 profile 时推导，而不是复制进本 pack。使用组合后 profile 报告的 token 总数，判断未来消费者应该请求什么内容；不要为了削减长度而删到句意破损。

## 练习：图书世界

<!-- world-claim: book-example-purpose -->
练习选择图书，是因为模型已有的世界构建能力在这里几乎无需转换；同时，不具备任何软件背景的读者也是最严格的陌生人场景。

<!-- world-claim: retrieve-world-example -->
使用 `zrig context get world-example` 获取完成的图书世界模板。

<!-- world-claim: book-exercise-guidance -->
借助示例说明作者是谁、有哪些书稿和来源、它们位于何处、适用哪些编辑规则、哪些决策塑造了当前草稿、当前状态如何推导，以及智能体接下来能做什么。文档应保持易读；如果整体组织更像档案系统而不是一个真实场所，就继续简化。

<!-- world-claim: book-to-software -->
在图书练习中，书稿对应代码库，编辑规则对应工程法则和约定，草稿状态对应推导得到的构建与部署状态，作者对应团队。软件世界采用同样的映射方式。

<!-- world-claim: software-shaped-bridge -->
智能体已经熟悉通过规范、验证循环、工具和编程基础来塑造软件。按此方式构建的 world pack 使用具名文件和 manifest 作为规范形态，使用逐项 claim 检查和可失败的 verifier 作为测试套件，并使用从事实源推导的命令作为反馈循环。因此，一个空白读者已经知道如何构建这类产物：世界构建提供信息架构，软件塑造方法则让它具备可构建性。

<!-- world-claim: optional-claim-checking-climb -->
完整公共 pack 演示了可选的 claim 检查进阶路径。

<!-- world-claim: derive-pack-path -->
使用 `zrig context show world-public --json` 推导已安装 pack 的目录。
<!-- world-claim: run-public-verifier -->
在推导得到的目录中运行 `sh verify-world.sh`，不要写死某台机器专属的路径。
