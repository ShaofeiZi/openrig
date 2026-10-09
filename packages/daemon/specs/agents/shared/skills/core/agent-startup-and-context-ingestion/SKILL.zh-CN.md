---
name: agent-startup-and-context-ingestion
description: 用于设计或审计智能体启动后如何变得可用——包括 AGENTS.md 覆盖层、角色文件、Skill、工作组规格、工作流规格、启动检查清单、重新聚焦消息和 `zrig context` 界面。涵盖导致启动上下文失败的四种模式：旧工作组规格遗漏当前操作模式；当前智能体从未获知新指导；启动文件沦为杂物堆；编排者传递实现说明却没有保留产品意图。
metadata:
  cli_surfaces_referenced:
    - context
    - whoami
  openrig:
    stage: factory-approved
    sibling_skills:
      - claude-compaction-restore
      - mental-model-ha
      - scope-recovery
      - session-compaction-and-restore
      - agent-starters
      - composable-priming-packs
      - session-source-fork
      - seat-continuity-and-handover
      - claude-compact-in-place
      - pre-maintenance-agent-preservation
---

# 智能体启动与上下文摄取

智能体在启动后如何变得可用：**AGENTS.md 覆盖层、角色文件、Skill、工作组规格、工作流规格、启动检查清单、重新聚焦消息**，以及当前的 `zrig context` 获取与 profile 界面。

这是更广义的 context-engineering-and-retrieval 原语中，目前具体采用的启动路径。启动负责让席位获得正确的初始形态；上下文工程则处理更大的问题：席位如何为自己此刻正在做的工作获得正确上下文。

**大多数协作失败不是工具失败，而是上下文失败。** 智能体需要知道自己的角色、操作模式、协作约定、边界和当前产品意图。如果启动上下文分散或过时，智能体只会非常高效地执行错误工作。

## 何时使用

- 编写新智能体的启动文件（role / culture / startup-context）。
- 刷新一个长期依赖过时指导运行的席位。
- 审计智能体是否获得当前操作模式，而不只是旧文件中的模式。
- 设计编排者 → 下一智能体的上下文传递结构。
- 为构建 zrig 的工作组创建启动映射。

## 何时不使用

- 智能体通过 Agent Starter 创建时——启动器 manifest 已携带启动上下文。
- 工作是根据数据包中的产物重建心智模型时——应使用 `session-compaction-and-restore`。
- 目标是把可复用启动内容作为 Skill 交付时——应使用 `writing-skills-for-openrig`。

## 四种失败模式

1. **新智能体从旧工作组规格启动，漏掉当前操作模式。** 规格会过时；启动时必须能看到当前状态，而不只是历史配置。
2. **指导已写入未来智能体会读取的文件，但当前智能体从未获知。** 文件编辑不会传播到运行中的会话。除了编辑文件，还需要文化推广（broadcast + fleet-changes-feed）。
3. **启动文件沦为杂物堆，失去指向规范来源的映射作用。** 启动文件应该指向规范来源，而不应试图自己成为规范来源。
4. **编排者传递实现说明，却没有保留产品意图。** 说明会衰减；意图才能持续传递。

## 任务范围内的启动

运行 `zrig whoami --json`，然后依次解析 `project.yaml -> mission.yaml -> active slice.yaml -> selected component or wave map -> addressed context`。完整的查找与优先级规则见 `docs/reference/product-journey-sdlc.md#resolve-the-selected-path`（安装后路径：`$OPENRIG_HOME/reference/product-journey-sdlc.md#resolve-the-selected-path`）。读取此任务所需的选定地址与源材料；profile 中可用的 Skill 是能力集合，不是强制阅读清单。没有组合配置时，采用轻量 Part A。角色名称和空闲席位不会增加门禁。明确指定的严谨度与作者划定的 wave 边界，仍需保留各自具名检查。

启动文件是地址映射，不是通用阅读强制要求。不要预加载无关的规划/审查规范，也不要要求逐文件 ACK 与测验。Skill 可用不同于加载其完整正文。旧工作包不能决定当前工作。缺少选定上下文是需要具名解决的空白。

## 证明标准

在一次可丢弃的全新会话中，观察实际读取内容及由此产生的下一行动。测试未选择、显式严谨度和 wave 边界三种情形。编辑文件不能证明已经运行的席位采纳了它；确认采纳需要经过授权的刷新，或观察下一次启动。不要仅为测试文字而清空或重新预热实时席位。

## 跨运行时启动路径（五种；不可合并）

当席位启动基于产物重建心智模型时（适用于重新进入活跃工作的情形，不同于可复用 Agent Starter / priming pack）：

- 参见 **cross-runtime restore/reentry packet standard v0**。
- 来源信任排序为：**`zrig whoami` > 目标 rigspec > 有边界的最新转录 > 完整转录 > touched-files > `restore-summary.json`**。

## 启动时使用的记忆界面

盘点选定的启动输入：AGENTS/role/CULTURE 覆盖层、重放上下文，以及所有已声明的恢复数据包或启动器。记录每项来源、是否为当前版本，以及此任务为何需要它。可用 Skill 或旧数据包都不能选择当前工作。

使用上方任务范围内的启动路径解析当前权限。允许读取某项输入并不等于允许改写其来源；写入操作遵循当前项目/工作组策略和任务分配。需要决定持久上下文应放在哪里时，通过 `zrig context get` 加载 `skills/openrig-operating-model/SKILL.md`。

## 启动文件与 Skill 的区别

根据 `agent-startup-guide.md`（产品参考文档）和团队手册：

| 启动文件 | Skill |
|---|---|
| 特定于工作组和角色的身份 | 可复用的 SOP / 方法 / 知识 |
| 告诉智能体自己是谁、正在处理什么，以及团队如何运作 | 告诉智能体如何完成某件事（可跨工作组迁移） |
| 示例：`role.md`、`CULTURE.md`、`startup/context.md` | 示例：`openrig-user`、`test-driven-development`、`vault-user` |
| 按工作组编写 | 编写一次，到处使用 |

不要把 Skill 内容写进启动文件，也不要把身份内容放进 Skill。七层累加启动模型（agent / profile / rig / culture / pod / member / operator）负责处理层叠关系。

## 另请参阅

- `mission-slice-sop`——开始处理已分配的任务目标/切片工作时加载；它为 SPEC.md、NOTES.md、PROGRESS.md 与证明提供轻量产物和交接流程，但不会替任务选择 SDLC。
- `writing-skills-for-openrig` Skill——Skill 内容的编写规范，以及哪些内容不属于启动文件。
- `forming-an-openrig-mental-model` Skill——新智能体定位指南。
- `session-compaction-and-restore` Skill——恢复时的启动上下文摄取。
- `agent-starters` Skill——用于组合启动上下文的可复用启动器 manifest。
- `composable-priming-packs` Skill——用于生成预热会话的 manifest。
- `openrig-operating-model` Skill——持久上下文的位置与权限。
- `openrig/docs/reference/agent-startup-guide.md`（产品参考文档，不是 Skill）——七层累加启动模型和投递提示。
