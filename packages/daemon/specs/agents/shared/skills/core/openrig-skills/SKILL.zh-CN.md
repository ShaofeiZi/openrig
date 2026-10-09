---
name: openrig-skills
description: "当你操作 zrig，并需要为智能体群组恢复、席位交接、新席位定向、watchdog 唤醒、跨主机联系另一台机器上的智能体、工作组打包、zrig 升级、系统化调试、队列分流或实现规划选择正确 skill 或上下文时使用；不知道应使用什么，或冷启动后没有投影任何内容时，也使用此 skill。"
allowed-tools: Bash(rig:*)
metadata:
  openrig:
    stage: shipped
---

# zrig skills——索引（从这里开始）

你正在 zrig 内运行。zrig 随附一组 **skills**——它们是小型文档，说明*何时*以及*如何*执行某件事。本文件就是地图：有哪些随附内容、何时使用每一项、如何加载。如果你不知道应使用哪个 skill，或上下文中没有投影任何内容，**从这里开始。**

## zrig 上下文如何工作（30 秒）

Skills 采用**渐进披露**：skill 的*名称 + 描述*会自然存在于上下文中（“热层”）；只有打开时才会加载*正文*。因此不必预先阅读所有内容——根据某个 skill 的“适用时机”匹配当前情境，然后只打开那一项。本文件是完整随附集合的索引。（对于有界流程，打开 `agent-operated-workflows`；对于由智能体持续支持的应用，打开 `agent-operated-software`。）

下方每一行都说明**如何找到该 skill**——它可能已经处于热层，也可能提供确切加载路径。不存在死路。

## 按需加载条目——`zrig context get`

不要猜文件路径或名称。按**查询 → 获取 ref → 加载**三个步骤进行：

1. **发现**——运行 `zrig context list`，查看每个随附条目的 **ref** 和名称。各条目的*适用时机*见下方索引（或 `zrig context list --json`，其中包含每项 purpose），并在其中匹配当前情境。
2. **选择**——将当前情境与某一行的*适用时机*匹配，取得其 **ref**。Refs 是镜像资源库布局的规范完整路径：`skills/<namespace>/<name>`（例如 `skills/core/rig-lifecycle`、`skills/process/systematic-debugging`）。唯一的裸名称（例如 `watchdog`）也可以解析；任何包含斜杠的 ref 都按精确路径查找，不存在时会明确失败。
3. **加载**——运行 `zrig context get skills/<namespace>/<name>`：

```
zrig context get skills/core/rig-lifecycle
```

路由器本身同时支持它所教授的两种形式：`zrig context get openrig-skills` 和 `zrig context get skills/core/openrig-skills`。

内容由**已安装 CLI** 提供，因此加载结果始终匹配正在运行的版本——无需猜路径，也不会产生冻结 fork 漂移。（后台服务会组装 operator 使用 `zrig context preview` 看到的同一 bundle；`get` 是面向智能体的拉取方式。）

## 索引

> 成员规则（`layout.skills[*].edges.length > 0`）：生成的边布局中，每个至少有一条产品边的公开 skill 都会在此索引中恰好出现一次；其他 skill 不会出现。

### 始终加载——通用主干（到达适用时机时打开正文）
这些内容会自动投递给每个工作组；名称和描述已存在于上下文中。遇到对应情境时打开正文。

- **forming-an-openrig-mental-model**——首次启动，或不确定各部分如何配合时。运行时心智模型。
- **openrig-operating-model**——不知道上下文或工作应放在哪里，或即将重复知识时。双树放置与追溯到根模型。
- **openrig-user**——需要使用 `zrig` CLI 命令（send / queue / ps / whoami / scope / broadcast）时。日常 CLI 界面。
- **applying-a-permission-policy**——工作组或席位附加了权限策略，或正在设置策略时：将其转换为实时 harness 配置。
- **claude-compaction-restore**——Claude 刚完成压缩时。在恢复真实工作前，根据持久证据恢复。
- **delegating-work**——决定任务应由自己、生成的子智能体，还是已持有上下文的持久同伴席位完成时。
- **loading-addressable-markdown**——任务在上下文包资源库之外，以 `path#h2-slug` 或 `path#h2-slug/h3-slug` 指定 Markdown 时。
- **session-compaction-and-restore**——准备压缩或从压缩恢复（任意运行时）时。写入端与读取端协议。
- **queue-handoff**——向另一个席位传递持久工作或结束当前轮次时。队列是工作账本，不是聊天。
- **refocusing**——长期运行的席位可能已偏离产品结果、跨越重大边界，或完成压缩后需要基于路径重新追踪时。
- **seat-continuity-and-handover**——跨重启或向另一所有者交接席位工作时。
- **orienting-to-an-inherited-seat**——刚通过计划内交接继承既有席位，需要验证身份、状态和证词时。
- **retiring-and-inheriting-a-seat**——规划席位转变，需要将当前任职者退役并创建新继任者，同时保留连续性时。
- **mission-slice-sop**——处理 mission/slice（SDLC：意图 → 小型需求 + 证据约定 → 构建 → QA → 证据）时。操作手册。
- **messaging-the-human**——为人类撰写消息时。使用平实语言，不用内部术语。
- **agent-operated-workflows**——有界的真实流程需要智能体解释状态并操作确切工具，或需要决定该循环是否应由普通代码负责时。
- **agent-operated-software**——设计或运行一种持续性应用，且其实时后端包含 zrig 智能体时。
- **software-for-agents**——旧 `agent-operated-software` 名称的兼容重定向；将在 0.6.0 移除。
- **openrig-skills**——本索引（你正在阅读）。始终加载；是下方所有内容的入口。

### 角色或任务要求时加载（仓库随附，由 profile 选择）
这些 skills 随 zrig 仓库提供；profile 选中后会到达席位。要使用某项，请在 profile 的 `uses.skills` 中选择，或直接打开 `packages/daemon/specs/agents/shared/skills/core/<skill>/SKILL.md`。

- **openrig-software-factory**——用户希望持续开展经评审的工作时：选择手动/团队、仅队列编排或显式 Workflow；必要时向正在运行的起始模板添加一至两个席位，并设置上下文、所有权、并发、开销和权限限制。加载 `zrig context get skills/core/openrig-software-factory/SKILL.md`。
- **openrig-architect**——编写工作组或拓扑时（不用于修改 zrig 本身——那属于 `openrig-builder`）。
- **openrig-cmux**——操作 `cmux` 终端 provider 时。
- **openrig-herdr**——通过默认且受证据门禁约束的 provider 打开/管理席位终端时。
- **agent-startup-and-context-ingestion**——席位启动并摄取启动上下文时。
- **topology-mutation-and-seat-management**——添加、删除、重命名席位或以其他方式改变工作组拓扑时。
- **rig-lifecycle**——工作组 up / down / pause / resume 生命周期操作。
- **rig-bundles-and-shareable-artifacts**——打包或安装工作组 bundle / 可共享制品。
- **cross-host-rig-commands**——通过 `--host` 联系另一主机上的席位或队列。
- **openrig-upgrade**——升级 zrig 或后台服务。
- **agent-starters**——组合智能体 starter 上下文 / priming packs。
- **specification-system**——编写或阅读 AgentSpecs 与工作组规格。
- **human-in-the-loop**——决定何时联系人类，何时在自身权限内继续。
- **watchdog**——监控或恢复席位（健康、恢复、卡住状态）。
- **session-source-fork**——fork 会话的 source/context。
- **context-engineering**——设计上下文系统。此项为 provisional 且非规范；发生冲突时，以当前 zrig skills、明确裁定和实测实践为准。

Pod 手册（进入对应 pod 时加载）：
- **orchestration-team**——正在编排工作组时：调度、监控、保持循环推进。
- **development-team**——位于 dev pod 时：构建并交付产品变更。
- **review-team**——执行评审时：以新视角检查、反对低质量输出、开展实证验证。
- **oversight-team**——位于 oversight pod 时：监控边界并路由问题，不接管工作。

产品管理工艺（塑造/评审工作时加载）：
- **requirements-writer**——将意图转化为明确需求。
- **plan-review**——构建前评审计划。
- **exec-summary**——为人类编写便于决策的摘要。
- **office-hours**——主持结构化咨询 / 决策会话。
- **context-builder**——组装任务或席位所需上下文。
- **backlog-capture**——捕获并塑造 backlog 项。
- **ui-mockup**——为切片制作 UI mockup。

### Vendored 工艺——编码时按需加载（保留上游来源）
zrig 随附的通用工程 skills 是 vendored 副本。任务匹配时打开；它们带有“modified by OpenRig”来源信息。

- **test-driven-development**——实现功能或修复缺陷时：先编写失败测试。
- **verification-before-completion**——即将声称 done / passing / fixed 时：先运行检查并阅读输出。
- **systematic-debugging**——调试时：修复前先查明根因。
- **agent-browser**——由智能体操作浏览器（截图 / 录屏）时。
- **frontend-design**——设计前端 / UI 时。
- **dogfood**——对已发布 UI 开展 web QA / dogfood 时。

## 需要超出随附集合的能力？

本索引覆盖**随产品提供**的界面。开发主机还包含更多 factory、architecture、PM-craft 和 studio skills，可通过主机自己的 routers/codemaps 获取——如果你位于 builder 主机并需要列表之外的内容，更深一层路由就是下一跳，而不是死路。（主机级路由属于 context-routing 架构文档的主题；在产品层，本文件就是完整地图。）
