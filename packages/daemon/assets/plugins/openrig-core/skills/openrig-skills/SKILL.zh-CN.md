---
name: openrig-skills
description: "当你操作 zrig，需要为舰队恢复、席位交接、新席位定位、watchdog 唤醒、跨主机触达另一台机器上的智能体、工作组打包、zrig 升级、系统化调试、队列分类或实现规划选择正确的 Skill 或上下文时使用；不知道该用什么，或冷启动时没有投影任何内容，也使用本 Skill。"
allowed-tools: Bash(rig:*)
metadata:
  openrig:
    stage: shipped
---

# zrig Skill——索引（从这里开始）

你正在 zrig 内运行。zrig 随产品提供一组 **Skill**——这些小型文档会说明*何时*做某件事以及*如何*做。此文件是它们的地图：随产品交付什么、何时选择哪一个，以及如何加载。如果不知道哪项 Skill 适用，或上下文中没有投影任何内容，**请从这里开始。**

## zrig 上下文如何工作（30 秒）

Skill 采用**渐进式披露**：Skill 的*名称和描述*会自然存在于上下文中（“热层”）；只有打开它时才加载*正文*。因此，无需预读所有内容——将 Skill 的“何时使用”与当前情境匹配，然后只打开对应的一项。此文件是随产品交付内容的总索引。（有边界流程请打开 `agent-operated-workflows`；持续运行、由智能体支持的应用请打开 `agent-operated-software`。）

下方每一行都会说明**如何触达 Skill**——它可能已经处于热层，也可能提供准确加载路径，没有任何一行是死路。

## 按需加载条目——`zrig context get`

不要猜测文件路径或名称。按“**询问 → ref → 加载**”三个步骤操作：

1. **发现**——运行 `zrig context list`，获取每个随产品交付条目的 **ref** 和名称。每项的*使用时机*见下方索引（或运行 `zrig context list --json`，其中包含各条目的目的），并与当前情境匹配。
2. **选择**——将当前情境与某行的*使用时机*匹配，并获取其 **ref**。Ref 是镜像库布局的规范完整路径：`skills/<namespace>/<name>`（例如 `skills/core/rig-lifecycle`、`skills/process/systematic-debugging`）。唯一的裸名称（例如 `watchdog`）也能解析；任何包含斜杠的 ref 都是精确查找，不存在时会明确失败。
3. **加载**——运行 `zrig context get skills/<namespace>/<name>`：

```
zrig context get skills/core/rig-lifecycle
```

路由器本身可以通过它所讲授的两种形式获取：`zrig context get openrig-skills` 和 `zrig context get skills/core/openrig-skills`。

内容由**已安装的 CLI** 提供，因此加载结果始终与你运行的版本匹配——无需猜路径，也不会出现冻结 fork 漂移。（后台服务会组装 `zrig context preview` 向操作者展示的同一 bundle；`get` 是面向智能体的拉取方式。）

## 索引

> 成员规则（`layout.skills[*].edges.length > 0`）：生成的边布局中，每项至少有一条产品边的公开 Skill 都恰好在此索引出现一次；其他 Skill 不会出现。

### 始终加载——通用主干（触发时机到来时打开正文）

这些 Skill 会自动交付给每个工作组；其名称与描述已经在上下文中。符合“何时使用”时再打开正文。

- **forming-an-openrig-mental-model**——首次启动，或不确定各部分如何配合时使用。运行时心智模型。
- **openrig-operating-model**——不知道上下文或工作应放在哪里，或即将重复知识时使用。双树放置与 trace-to-root 模型。
- **openrig-user**——需要 `zrig` CLI 命令（send / queue / ps / whoami / scope / broadcast）时使用。日常 CLI 界面。
- **applying-a-permission-policy**——工作组或席位附有权限策略，或正在设置策略时使用：将其转换为实时工具配置。
- **claude-compaction-restore**——刚刚完成 Claude 上下文压缩时使用。在恢复真实工作前从持久证据恢复。
- **delegating-work**——决定任务应由自己、临时子智能体，还是已有相关上下文的持久同伴席位完成时使用。
- **loading-addressable-markdown**——任务引用上下文包库外部形如 `path#h2-slug` 或 `path#h2-slug/h3-slug` 的 Markdown 时使用。
- **session-compaction-and-restore**——准备上下文压缩或从压缩恢复时使用（适用于任意运行时）。包含写入端与读取端协议。
- **queue-handoff**——将持久工作交给另一席位或结束当前轮次时使用。队列是工作账本，不是聊天。
- **refocusing**——长时间运行的席位可能偏离产品结果、跨越重要边界，或已压缩并需要重新执行基于路径的追踪时使用。
- **seat-continuity-and-handover**——跨重启或向其他负责人交接席位工作时使用。
- **orienting-to-an-inherited-seat**——刚通过计划交接继承现有席位，需要验证其身份、状态和证词时使用。
- **retiring-and-inheriting-a-seat**——规划席位过渡，需要在不丢失连续性的情况下把当前占用者移交给全新后继者时使用。
- **mission-slice-sop**——处理任务目标/切片时使用（SDLC：意图 → 最小需求 + 证明契约 → 构建 → QA → 证明）。操作手册。
- **messaging-the-human**——撰写给人类的消息时使用。使用普通语言，避免内部术语。
- **agent-operated-workflows**——有边界的现实流程需要智能体解释状态并操作精确工具，或需要决定循环是否应由普通代码负责时使用。
- **agent-operated-software**——设计或操作实时后端包含 zrig 智能体的持续运行应用时使用。
- **software-for-agents**——原 `agent-operated-software` 名称的兼容重定向；将在 0.6.0 中移除。
- **openrig-skills**——本索引（你正在阅读）。始终加载；是下方所有内容的入口。

### 角色或任务需要时加载（仓库随附、由 profile 选择）

这些 Skill 随 zrig 仓库交付，并在席位 profile 选择后触达席位。要使用某一项，请在 profile 的 `uses.skills` 中选择，或直接打开 `packages/daemon/specs/agents/shared/skills/core/<skill>/SKILL.md`。

- **openrig-software-factory**——用户需要持续的经审查工作时使用：支持人工/团队、仅队列编排或显式 Workflow；必要时为运行中的启动器增加一两个席位，并设置上下文、归属、并发、费用和权限限制。运行 `zrig context get skills/core/openrig-software-factory/SKILL.md` 加载。
- **openrig-architect**——编写工作组或拓扑时使用（不要用于修改 zrig 本身；那是 `openrig-builder`）。
- **openrig-cmux**——驱动 `cmux` 终端提供方时使用。
- **openrig-herdr**——通过默认的证明门禁提供方打开/管理席位终端时使用。
- **agent-startup-and-context-ingestion**——席位启动并摄取启动上下文时使用。
- **topology-mutation-and-seat-management**——添加、删除、重命名席位，或以其他方式修改工作组拓扑时使用。
- **rig-lifecycle**——执行工作组 up / down / pause / resume 生命周期操作时使用。
- **rig-bundles-and-shareable-artifacts**——打包或安装工作组 bundle / 可分享产物时使用。
- **cross-host-rig-commands**——触达另一主机上的席位或队列（`--host`）时使用。
- **openrig-upgrade**——升级 zrig 或后台服务时使用。
- **agent-starters**——组合智能体的启动上下文 / 预热包时使用。
- **specification-system**——编写或读取 AgentSpec 与工作组规格时使用。
- **human-in-the-loop**——决定何时联系人类、何时在自身权限范围内继续时使用。
- **watchdog**——监控或恢复席位（健康状态、恢复、卡住状态）时使用。
- **session-source-fork**——fork 会话来源/上下文时使用。
- **context-engineering**——设计上下文系统时使用。它是临时且非规范性的；若有冲突，以当前 zrig Skill、明确裁决和实测实践为准。

Pod 手册（身处对应 pod 时加载）：

- **orchestration-team**——编排工作组时使用：派发、监控并保持循环向前推进。
- **development-team**——身处开发 pod 时使用：构建并交付产品变更。
- **review-team**——执行审查时使用：以全新视角检查，避免低质产出，并进行实证验证。
- **oversight-team**——身处监督 pod 时使用：监控边界并路由发现，但不接管工作。

产品管理实践（组织或审查工作时加载）：

- **requirements-writer**——将意图转化为清晰需求。
- **plan-review**——在计划进入构建前审查。
- **exec-summary**——为人类编写可直接决策的摘要。
- **office-hours**——开展结构化咨询 / 决策会话。
- **context-builder**——组装任务或席位所需的上下文。
- **backlog-capture**——捕获并整理 backlog 条目。
- **ui-mockup**——为切片制作 UI 原型图。

### 引入的工程实践——编码时按需加载（保留上游来源）

zrig 以引入副本形式交付的通用工程 Skill。任务匹配时打开；这些 Skill 携带“由 zrig 修改”的来源信息。

- **test-driven-development**——实现功能或修复 bug 时使用：先编写失败测试。
- **verification-before-completion**——即将声称完成、通过或修复时使用：先运行检查并阅读输出。
- **systematic-debugging**——调试时使用：先找到根因再修复。
- **agent-browser**——由智能体驱动浏览器（截图 / 录屏）时使用。
- **frontend-design**——设计前端 / UI 时使用。
- **dogfood**——对已交付 UI 做 Web QA / dogfood 时使用。

## 需要超出随产品交付的内容？

此索引只覆盖**随产品交付**的界面。开发主机还拥有更多内容（工厂、架构、PM 实践、Studio Skill），可通过主机自己的路由器或 codemap 访问——如果你位于构建主机，需要此处未列出的内容，下一步应进入更深一层路由，而不是停在这里。（主机级路由由上下文路由架构文档说明；在产品尺度上，此文件就是完整地图。）
