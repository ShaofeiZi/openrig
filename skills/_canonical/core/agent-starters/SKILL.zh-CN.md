---
name: agent-starters
description: 用于创建、刷新、打包、检查、提升或弃用具名的按席位启动点——包括 Agent Starter manifest 编写、六状态生命周期（captured → named → inspectable → used → promoted → deprecated）、诚实记录来源和拒绝规则。它不是 VM 镜像，而是由智能体角色、启动上下文、可选原生会话来源与来源信息组合出的受管启动点。
metadata:
  openrig:
    stage: factory-approved
    sibling_skills:
      - claude-compaction-restore
      - mental-model-ha
      - scope-recovery
      - session-compaction-and-restore
      - agent-startup-and-context-ingestion
      - composable-priming-packs
      - session-source-fork
      - seat-continuity-and-handover
      - claude-compact-in-place
      - pre-maintenance-agent-preservation
---

# 智能体启动器

智能体启动器是具名、可复用的按席位启动点。它把智能体角色、启动上下文、可选原生会话来源和来源信息组合成用户或工作组在创建、刷新或打包席位时可以选择的内容。

这种由注册表支持的启动上下文不同于 `zrig agent-image` 界面，也不同于 VM 镜像。在把可选会话来源视为可执行的原生会话来源前，请先阅读下述当前行为。

## 何时使用

- 从已知可靠的启动上下文创建新席位。
- 使用 `zrig expand` 和 `starter_ref` 刷新席位。
- 编写新的启动器（注册表条目）。
- 检查现有启动器的来源、新鲜度或推荐状态。
- 在注册表中提升或弃用启动器。
- 将启动器与 Composable Priming Pack 组合（记录 manifest id/version、运行时、源会话 ID 或转录路径、ready-check 证据及新鲜度状态）。

## 何时不使用

- 需要 VM 风格的确定性状态捕获时。启动器不会捕获 VM 状态。
- 想把提供方身份验证材料复制进启动器时。**启动器只引用会话来源和上下文；绝不会复制凭据。**

## 什么使启动器有价值

启动器的价值在于它是否**真正可用**——它应携带席位做好任务所需的上下文。真正可用是衡量优秀启动器的**唯一**标准，大小不是：更小的启动器不一定更好，更大的也不一定更差。席位为真正胜任工作所需的一切，才是正确的启动器——无论是 80K token 还是 800K。

应在席位自然达到功能完整且已有证明的时刻捕获它。不要填入席位没有使用的上下文，同样重要的是，不要为了缩小体积而删除上下文。大小是席位实际需求产生的*结果*，绝不能成为目标。

绝不要为了制作或“精简”启动器而压缩、总结或缩减席位。“更小”本身没有任何价值，而且压缩会丢失信息——你会牺牲启动器本应保留的准确能力。（压缩是席位真正接近上下文限制时的独立兜底步骤，拥有自己的前后计划——绝不是捕获启动器的一部分。）

## 编写生命周期——六个概念状态

1. **Captured**——识别到有用的席位、会话或上下文模式。
2. **Named**——它成为具有稳定 ID 与负责人的 Agent Starter。
3. **Inspectable**——运行时、上下文输入、会话来源和来源信息均可见。
4. **Used**——工作组成员或 `zrig expand` 操作从它启动。
5. **Promoted**——证据表明它适合被推荐给某个角色或 bundle。
6. **Deprecated**——已被替代、过时、不安全或不兼容。

## 五种失败模式

1. **夸大镜像语义**——UI/文档暗示它能像 VM 一样确定性捕获状态。应称其为“启动器”，明确包含内容并展示来源。
2. **隐藏来源**——用户无法判断启动器来自哪个会话、上下文或规格。**在来源可检查之前拒绝提升。**
3. **启动器过时**——指向过时规范、缺失文件或无效原生会话来源。**检查时必须如实报告过时状态。**
4. **秘密泄漏**——启动器打包或展示提供方身份验证材料。**拒绝执行。** 只引用会话来源和上下文，绝不复制凭据。
5. **运行时不匹配**——启动器被用于不受支持的运行时。**以清晰错误拒绝执行。**

## 注册表条目与当前行为

将一个条目保存为 `<registry-root>/reviewer-v1.yaml`。解析器优先选择显式根目录或 `OPENRIG_AGENT_STARTER_ROOT`；两者均不存在时，会检查主目录注册表 `~/.openrig/agent-starters` 和配置的后备位置。

```yaml
starter_id: reviewer-v1
role: Review the assigned change against its stated outcome.
context: Read the current task and the source needed to judge it.
```

当前解析器会检查条目结构和凭据边界，然后在全新启动时，把这份 YAML 本身作为一个必需的 `guidance_merge` 启动文件交付。它不会解释任意上下文 ref，不会从此示例加载原生对话，也不会封装镜像。目前，组合使用 `starter_ref` 与 `session_source.mode: fork` 的 RigSpec 成员会被拒绝；当目标是原生连续性时，应使用一条独立且受支持的会话来源路径。

成员用法：

```yaml
members:
  - id: reviewer
    starter_ref:
      name: reviewer-v1
```

当启动器指向由 Composable Priming Pack 生成的预热会话时，应记录：

- manifest id/version
- 运行时
- 源会话 ID 或转录路径
- ready-check 证据
- 新鲜度状态

## 证明矩阵

| 界面 | 测试类型 | 权威来源 |
|---|---|---|
| 注册表 schema 接受最小启动器 | unit | 后台服务或配置层原型 |
| Inspect 展示来源与包含的上下文 | unit / snapshot | 后台服务或 CLI |
| 成员可以使用 `starter_ref` | integration | 后台服务 |
| 不受支持的运行时或过时来源会被如实拒绝 | unit + integration | 后台服务 |
| 启动器产物中未复制秘密材料 | grep / fixture | 测试者 |
| Bundle 可以包含或引用启动器 | package inspection | bundle 层 |

## 对其他原语的依赖

- **独立路径：** `session-source-fork`——原生对话来源连续性；当前无法与 `starter_ref` 组合。
- **强依赖：** `specification-system`——声明式启动器和成员引用。
- **软依赖：** `rig-bundles-and-shareable-artifacts`——可分享的启动器打包。
- **软依赖：** `context-engineering-and-retrieval`——更丰富的声明式上下文组合。
- **软依赖：** `seat-continuity-and-handover`——基于启动器的刷新和交换工作流。

## RSI 前置要求

在 RSI 循环可以依赖 Agent Starter 刷新席位前，启动器必须具有可查询的来源和诚实的 inspect 输出。工作流必须能够回答：“此席位使用了什么启动器、包含了哪个源会话或上下文，以及该启动器是否仍然受到推荐？”

## 另请参阅

- `session-source-fork` Skill——使基于原生会话的启动器成为可能的底层 fork 原语。
- `composable-priming-packs` Skill——生成启动器所引用预热会话的 manifest 驱动层。
