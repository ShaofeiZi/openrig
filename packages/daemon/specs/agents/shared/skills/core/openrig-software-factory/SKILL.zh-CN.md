---
name: openrig-software-factory
description: >-
  当用户希望为真实仓库建立持续运作的软件团队，或已有第一个 zrig 团队，
  并需要一条可重复的经评审工作与后续任务路径时使用。
metadata:
  cli_surfaces_referenced:
    - context get
    - context list
    - context show
    - grow
    - queue create
    - queue handoff
    - workflow compile
    - workflow instantiate-lifecycle
  openrig:
    stage: WIP
    transfer_test: pending
---

# zrig 软件工厂

从一个有价值的仓库结果开始，只在协调成本值得时增加协调机制。初学者无需 Workflow，也能完成经评审的工作。这些是利用现有能力作出的选择，不是每个人都必须逐级晋升的阶段。

## 选择团队工作方式

| 需求 | 从这里开始 | 何时增加更多机制 |
| --- | --- | --- |
| 一项变更，人类近距离指导 | 手动/团队工作：把结果交给一个所有者；遵循仓库说明；完成实现并获取选定的独立检查。 | 工作必须跨轮次保留，或需要在席位之间流转。 |
| 持续工作且所有权可见 | 队列支持的编排：使用 `zrig queue create`，认领工作，再用 `zrig queue handoff` 将候选结果/证据交给下一位所有者。记录真实阻塞和后续工作。无需 Workflow 实例。 | 重复步骤需要明确的依赖图和允许的出口。 |
| 明确的执行契约 | Workflow：检查 `zrig workflow compile`，然后有意识地使用 `zrig workflow instantiate-lifecycle`。通过工作流投影机制推进其工作包。 | 实际项目需要可复用 profiles、额外角色或门禁。 |

具体队列循环、唤醒行为和可选的双切片 Workflow 见 [references/worked-example.md](references/worked-example.md)。安装副本：`zrig context get skills/core/openrig-software-factory/references/worked-example.md`。roadmap、YAML 文件或 wake 本身既不会执行工作，也不会授权新结果。

## 建立工作约定

阅读仓库说明、当前工作和期望的用户可见结果。验证目标实例、代码/工作根目录、真实席位地址和原生就绪状态。复用合适的小团队；现有智能体可以启动它。kernel operator 是可选角色，不会自动成为项目所有者。

约定工作边界、时间/开销上限、由谁回答未决选择，以及何时停止：结果已检查、没有获授权的下一项工作、预算耗尽，或遇到真实的用户/权限/provider 阻塞。后台服务的后台检查本身不产生模型轮次，但投递的唤醒和恢复后的工作**可能消耗 token**。优先采用事件驱动等待，避免频繁发送空提醒。Wakes 无法回答用户问题、解除权限提示或保证进展。

**启动或分配工作前先选择权限。**提供普通提示、针对选定命令的持久规则，或有意识选择更宽泛的访问。按照 [Applying a permission policy](#find-the-compatible-permission-guide) 执行用户选择，并在目标对话中验证。保留限制和无关设置。允许整个 `zrig` 会覆盖其所有动词，而不只是读取；它不会授予新的产品权限，也不会改变其他人的默认设置。

将目的、验收、决策和证据保存在现有项目文件中。投递选定上下文，并取得每个席位对工作范围的反馈；仅仅检索并不等于已投递给同伴。所有者负责让候选结果完成所选检查和有界修复，说明如何试用，并保留下一项获授权任务，或明确报告没有后续任务。在受支持的停止前，保全工作和托管关系。

## 扩展软件工厂

团队规模应与上方协调方式分别选择：

1. **使用双智能体起始模板。**当现有所有者与独立检查者能够承担工作量时，继续使用这一组合。所有者可以同时实现和协调。
2. **向正在运行的工作组添加一至两个席位。**这是通常的下一步。按照 [Grow the running team](references/worked-example.md#grow-the-running-team) 使用 `zrig grow` 命令，完成就绪/上下文/工作分配并保存扩展后的拓扑。仅为了增加容量，无需重建既有会话，也无需 down/up。
3. **需要不同结构时编写自定义工作组。**阅读 [zrig Architect](../openrig-architect/SKILL.md)，也可通过 `zrig context get skills/core/openrig-architect/SKILL.md` 获取。请求内容示例：
   “请使用兼容的 RigSpec/AgentSpec 指导，为 [outcome] 设计一个用户所有的工作组。复用合适的智能体，定义职责和上下文，并验证文件。保留现有工作组，任何新启动都需先达成一致。”

随着独立工作增加，原始所有者可以专注于编排，多位构建者可以实现不同结果，检查者也能保持独立评审能力。应明确记录这种分工；添加席位不会自动分配工作、改变权限或创建并行。约定文件/工作树边界和集成所有权，遵循项目现有评审策略，并让活动并发保持在用户的时间/开销预算内。两个席位只是起点，不是完整工厂，也不是上限。

## 阅读兼容指导

安装前，应使用与所选软件包相同 published tag 或 commit 上的本文件及伴随文档。安装后运行：

```sh
zrig --version
zrig context list --json
zrig context show skills/core/openrig-software-factory --json
zrig context get skills/core/openrig-software-factory/SKILL.md
```

除了版本，还要比较构建身份。保留 missing、unreadable 或 older recipe 结果；不要静默替换成较新的 main，也不要跳过缺失的伴随文档。

### 查找兼容的权限指南

使用 `zrig context get skills/applying-a-permission-policy/SKILL.md` 获取持续维护的流程。对于源码或归档阅读者，请按下表定位；配套入门指南在 **Opt-in permissive operation** 下包含可选的更宽泛启动模式配方。这些路径相对于表中具名根目录，而不是本 skill：

| 阅读来源 | 与本配方版本一致的流程和指南 |
| --- | --- |
| 源码 checkout，包括 `skills/_canonical` | 仓库根目录下：`packages/daemon/assets/plugins/openrig-core/skills/applying-a-permission-policy/SKILL.md` 和 `docs/reference/getting-started.md`。 |
| npm 安装 | 匹配的 `npm root -g` 或本地 `npm root` 下：`@openrig/cli/daemon/assets/plugins/openrig-core/skills/applying-a-permission-policy/SKILL.md` 和 `@openrig/cli/daemon/docs/reference/getting-started.md`。 |
| 解包后的 npm 归档 | 解压目录下：`package/daemon/assets/plugins/openrig-core/skills/applying-a-permission-policy/SKILL.md` 和 `package/daemon/docs/reference/getting-started.md`。 |

对于已安装指导，应使用提供所选 `zrig` 可执行文件的 npm 安装；另一 prefix 或本地项目可能包含不同版本。如果匹配的指南或章节缺失，应在继续前报告缺口；不要用当前 main 或另一份安装中的指导替代。

## 可交给智能体的请求

> 帮助我在此仓库中实现 [可观察变更]。阅读兼容的 Software Factory 配方，选择最轻量且有用的团队/队列/Workflow 路径，并保持下一位所有者可见。保留现有文件和权限。约定时间/开销限制，执行获授权的工作与选定独立检查，只对该范围外尚未解决的决策或影响进行询问。不要在此任务中执行发布和破坏性变更。

命令、默认值或权限语义发生变化时，应同时检查此来源和伴随文档，并重新生成它们的现有投影。网站指导应链接到同一版本配方，而不是另行维护一套流程。
