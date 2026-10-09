---
name: forming-an-openrig-mental-model
description: >-
  当你尚未理解周围的系统时使用：你刚进入一个席位，不知道各部分如何协作；有人提到
  rig、pod、seat、fleet、topology 或 slice，而你不确定这些词在这里的含义；你不清楚
  自己所在的 rig 属于哪种类型或有何用途；你不知道 skill 如何到达你这里、上下文来自何处；
  或者你正准备依据对 OpenRig 工作方式的猜测采取行动。本 skill 能让你快速建立运行时心智模型，
  从而停止猜测。
metadata:
  cli_surfaces_referenced:
    - ask
    - capture
    - down
    - ps
    - send
    - transcript
    - up
    - whoami
  openrig:
    stage: factory-approved
    sibling_skills:
      - openrig-user
      - openrig-operator
      - openrig-builder
      - openrig-architect
      - openrig-upgrade
      - agent-operated-workflows
      - agent-operated-software
---

# 建立 OpenRig 心智模型

你刚接触 OpenRig，或者离开一段时间后重新回来，需要迅速了解这是怎样的系统、
你的席位是什么，以及可以采取哪些行动。本 skill 是一条快速入门路径。

若要深入了解，请阅读本 skill 指向的权威参考文档。本 skill 的职责是帮助你建立方向感——
准确到足以开展操作，同时足够简洁实用——而不是取代权威文档。

---

## 60 秒心智模型

OpenRig 是一个用于多智能体编码拓扑的**本地控制平面**。你使用 YAML 声明智能体拓扑，
通过一条命令启动它，之后由 OpenRig 管理 tmux 会话、harness 生命周期、transcript、
snapshot 和恢复。当系统关闭时，OpenRig 会创建 snapshot；系统再次启动时，
智能体会恢复各自的对话。

产品循环：

```
down（自动创建 snapshot）→ up <rig-name>（自动恢复）→ 工作 → 重复
```

工作的基本单位是 **rig**——由多个智能体共同协作、作为单一系统运行的拓扑。

---

## 四层模型（你所处的位置）

智能体工程中的一切都发生在以下四层之一。**OpenRig 在第 3 层运行。**

| 层级 | 名称 | 类比 | 含义 |
|---|---|---|---|
| L0 | Model | CPU | 基础模型——Claude、GPT、Gemini。无状态地接收 token 并输出 token。 |
| L1 | Agent Core | 进程循环 | 推理与行动循环：观察、规划、选择、行动，再重复。 |
| L2 | Harness | 容器 / 操作系统 | 模型周围的工具、记忆和生命周期。例如 Claude Code、Codex CLI。 |
| L3 | Rig | Docker Compose / Terraform | 多智能体拓扑——存在哪些智能体、它们如何关联。**OpenRig 位于这一层。** |

你是运行在 L2 harness 内的 L1 智能体，由 L3 OpenRig 配置。OpenRig 管理你的 harness；
harness 包装模型；模型生成你的 token。

---

## 上下文的三大支柱

OpenRig 建立在上下文工程的三大支柱之上。建立方向感后，你应当知道自己正在操作哪一根支柱：

| 支柱 | 含义 | 所在位置 |
|---|---|---|
| **Ontology（本体论）** | 存在什么。经过整理的知识——事实、代码地图、竣工文档。 | 随产品交付的公共 context pack，以及项目编写的文档；通过 `zrig context list` 发现。 |
| **Epistemology（认识论）** | 智能体为何相信自己所相信的内容——推理、直觉、决策。 | 自动捕获的 transcript、会话日志、ADR。 |
| **Topology（拓扑）** | 智能体如何连接——pod、edge、通信路径。 | OpenRig 本身和 RigSpec YAML。 |

OpenRig 管理拓扑，并通过 `zrig context` 暴露公共上下文。项目编写的来源提供项目特定知识，
transcript 保留已记录的工作。这些来源已经共存。你应发现已配置的库和选定的任务上下文，
不要假定存在某个特定的私有语料库。

---

## 核心词汇（请按字面含义理解）

| 术语 | 含义 |
|---|---|
| **Rig** | 由多个智能体共同协作、作为单一系统运行的拓扑。使用 YAML（RigSpec）定义，是顶层对象。 |
| **Pod** | rig 内有明确边界的上下文分组。一个 pod 的成员共享上下文领域和连续性责任。可将其理解为知识层面的 Kubernetes pod。 |
| **Member / Node** | pod 内的单个智能体（或 terminal-node 服务）。 |
| **Edge** | member 或 pod 之间的关系。种类包括：`delegates_to`、`spawned_by`、`can_observe`、`collaborates_with`、`escalates_to`。 |
| **Topology** | rig 的结构——智能体如何分组为 pod、edge 如何连接它们，以及整体如何组合。 |
| **AgentSpec** | 可复用的智能体蓝图。定义 skill、guidance、hook、profile 和 startup。文件：`agent.yaml`。 |
| **RigSpec** | 拓扑 YAML。定义 pod、member、edge 和 culture。文件：`rig.yaml`。 |
| **RigBundle** | RigSpec 与 vendored AgentSpec 组成的可移植归档，用于在机器之间迁移拓扑。 |
| **Agent Starter** | 具名、可复用的起始上下文 bundle。RigSpec member 可以声明 `starter_ref`。 |
| **Skill** | 带 frontmatter 的 Markdown 文件，智能体在启动或激活时加载。它是 `agentskills.io` 定义的跨 runtime 标准。 |
| **Profile** | AgentSpec 内的具名配置。rig spec 的 member 字段选择要使用的 profile。 |
| **Culture** | rig 范围内的章程——团队如何沟通、何谓“完成”、如何升级。文件：`CULTURE.md`。 |
| **Snapshot** | rig 在某个时间点的捕获——包括会话、对话和状态，可用于恢复。 |
| **Session name** | `{pod}-{member}@{rig}`。tmux 会话和智能体间消息传递使用的规范地址。 |

会话名格式 `{pod}-{member}@{rig}` 就是你的地址。运行 `zrig whoami --json` 后，
你会获得完整的拓扑上下文：rig 名称、pod、member、peer、edge 和 transcript 路径。

---

## Rig 类别（我所在的是哪种 rig？）

OpenRig 有五种 rig 类别。类别决定编写纪律、监管方式和生命周期策略。

| 类别 | 用途 | 生命周期 |
|---|---|---|
| **kernel** | 主机级监管、接收任务和编写内容。每台主机一个。 | 始终运行，绝不自动休眠。 |
| **project** | 绑定到代码库的长期团队。 | 活跃时保持热状态；仅在明确请求时休眠。 |
| **ephemeral** | 短期 mission（研究、构建、迁移、探索）。 | 生成 → 工作 → 退役。 |
| **infra-build** | ephemeral 的子类，其产出会成为永久基础设施。 | 只有在产出经过原位验证后才退役。 |
| **managed-app** | 由服务支撑、包含专业智能体的 rig（例如 vault specialist、skill librarian）。 | 长期运行，供其他 rig 使用。 |

如果你正在开展实质性工作，你很可能位于 project rig 或 managed-app rig。了解自己的类别，
有助于理解该席位所受的监管要求。

---

## Skill 如何加载（最需要正确理解的部分）

Skill 是 `https://agentskills.io/specification` 定义的**成熟跨 runtime 标准**。
Claude Code 和 Codex 都建立在这个标准之上。

### 结构

一个 skill 是包含 `SKILL.md`（大写）的目录。SKILL.md 包含 YAML frontmatter
（`name`、`description`）和 Markdown 正文。可选的同级目录包括：`references/`、
`scripts/`、`assets/`。

### 渐进式披露（为什么 skill 能够扩展）

harness 在启动时以较低成本读取所有可用 skill 的 frontmatter，即名称和描述。
只有 skill 被激活时才加载正文。这就是**环境感知**：你知道所有 skill 都存在，
但只有真正使用某项 skill 时才支付相应 token 成本。

### OpenRig 中 skill 的来源

- **逐智能体 loadout：** AgentSpec 的 `profile.uses.skills` 列表决定在 harness 启动前，
  哪些 skill 会被投影到 runtime skill 目录（`.claude/skills/` 或 `.agents/skills/`）。
  这是**结构化组合**层。
- **跨 pod 共享：** AgentSpec 可以通过 `imports: [shared]` 访问共享 skill 池。
  内置智能体通常采用这种方式。
- **双重保障：** spec 会投影 skill 文件；startup guidance 也会告诉你加载特定 skill。
  两条路径都很重要——如果投影静默失败，guidance 仍会告诉你应该读取什么。

### Skill 所在位置（事实来源）

| 位置 | 用途 |
|---|---|
| `<rig-cwd>/.claude/skills/`、`<rig-cwd>/.agents/skills/` | harness 实际加载 skill 的位置，由 `zrig up` 填充。 |
| `~/.claude/skills/`、`~/.agents/skills/` | 用户级 harness skill 目录。检查当前投影和 harness 配置，以确定安装了哪些 skill 及其来源。 |
| `openrig/packages/daemon/{specs/agents/shared/skills,assets/plugins/*/skills}/` | 随 OpenRig 交付的产品 skill——spec 池和内置 plugin 资产（openrig-user、openrig-operator、openrig-architect、forming-an-openrig-mental-model、queue-handoff、claude-compaction-restore 等）。 |
| skill 编写工作区 | Skill 编写来源，不会在 runtime 加载。 |

产品已经能够发现其已安装的共享 skill 池，并通过 `zrig context list/get` 提供打包上下文。
发现和检索并不能证明每个 skill 都已投影到每个 harness。请检查所选 profile 和实际 runtime
目录；不要根据本表假定存在通用 home/bootstrap 安装。

---

## 产品循环（日常操作）

```
zrig up <rig-name>         # 启动或恢复拓扑
zrig ps --nodes            # 查看正在运行的内容
zrig whoami --json         # 确认自己的身份
zrig send <session> "msg"  # 与 peer 沟通
zrig capture <session>     # 查看 peer 的终端
zrig transcript <session>  # 阅读 peer 的历史记录
zrig down <rigId>          # 创建 snapshot 并拆除
zrig up <rig-name>         # 从 snapshot 恢复
```

进入任何新席位后，第一条命令都应是 `zrig whoami --json`。它会告诉你自己的 rig、pod、
member、peer、edge 和 transcript 路径。**请把它视为事实来源——CLAUDE.md 或 AGENTS.md
中的 startup overlay 可能有误，whoami 才是权威信息。**

---

## 文化姿态（如何行事）

OpenRig 有几条关键文化原则，请将它们内化：

- **诚实优先于便利。** 如果恢复失败，应响亮说明。不要静默执行全新启动。
- **智能体是高级用户。** CLI 面向在终端工作的十倍效率资深工程师设计。你就是这个用户。
- **CLI 就是上下文工程。** 每条错误消息和帮助文本都在提供可行动的信息。请仔细阅读错误。
- **约定优先于发明。** 遵循 docker/git/kubectl 模式。智能体的操作肌肉记忆确实存在。
- **半确定性可以接受。** 核心契约稳固；边缘情况由智能体处理。
- **当前是宠物，而非牲畜。** OpenRig 目前针对能在多个会话中形成经验的长期智能体优化。
  “牲畜式”支持仍在路线图中。

---

## 最初 10 分钟应该做什么

如果你刚进入 OpenRig rig 中的一个新席位：

1. **`zrig whoami --json`**——恢复身份。了解自己的 rig、pod、member 和 peer。
2. **阅读角色 guidance**——通常通过 startup 文件交付。阅读当前席位专属的
   `guidance/role.md`。
3. **阅读 rig 的 `CULTURE.md`**（如果存在）——这是团队操作手册。
4. **检查你拥有的 skill**——列出当前工作目录中的 `.claude/skills/` 或
   `.agents/skills/`。每个 skill 的 frontmatter 描述会告诉你何时使用它。
5. **检查 peer**——使用 `zrig capture <peer-session>` 查看 peer 的当前状态。
6. **如果你要返回进行中的工作流，请检查 transcript**——使用
   `zrig transcript <session> --tail 100` 查看近期上下文。
7. **如果需要从 rig 的 transcript 和 chat 中获取跨领域证据，请运行
   `zrig ask <rig> "<question>"`**。

现在，你已经具备开展有用工作所需的基本方向感。

**权限策略（设置时）：** OpenRig 只为 harness 权限设置最低可用下限，随后提供由你选择采用的
推荐策略（Locked / Standard / Open，或者用 YOLO 绕过）。如果你正在创建或启动 rig，
这项选择由你决定，而不是由 OpenRig 代为决定。请参阅 openrig-user 中的
“Permission policy — pick one at setup”和 `applying-a-permission-policy` skill。

---

## 深入阅读（权威参考）

若要真正深入理解，请阅读以下关键权威文档：

| 参考资料 | 涵盖内容 |
|---|---|
| `openrig/docs/as-built/README.md` | 系统竣工版图——后台服务架构、系统概览、package 边界；通过 `codemap.md` 导向 13 个 `architecture/` 模块和 4 个 `ui/` 模块。 |
| `openrig/docs/as-built/cli-reference.md` | 完整的 `zrig` CLI 表面，包含所有子命令和 flag。 |
| `openrig/docs/reference/rig-spec.md` | RigSpec YAML 格式——pod、member、edge 和所有字段。 |
| `openrig/docs/reference/agent-spec.md` | AgentSpec YAML 格式——resource、profile、import。 |
| `openrig/docs/reference/agent-startup-guide.md` | 七层 startup 分层模型和 delivery hint。 |
| 产品 taxonomy | 权威词汇，按字面含义理解。 |
| `openrig-operating-model` skill | 放置与操作模型 guidance——topology、work tree 和 context altitude。 |
| `openrig-architect` skill | Rig 和拓扑编写。 |
| `https://agentskills.io/specification` | 跨 runtime skill 标准。 |

如果你要编写 rig，请在修改 YAML 前使用 `openrig-architect` skill。

---

## 本 skill 不适用于什么

- **压缩恢复。** 应使用 `claude-compaction-restore`，这是不同场景下的不同 skill。
- **操作某个特定 rig。** 具体 rig 有自己的 DESIGN.md 和 CULTURE.md，请阅读它们。
- **编写新 rig。** 请使用 `openrig-architect` skill。
- **OpenRig 日常操作。** 请使用 `openrig-user`。
- **管理 OpenRig 安装。** 请使用 `openrig-operator`。

本 skill 的存在目的是帮助你**建立 OpenRig 作为一个系统的初始心智模型**。完成定位后，
请根据实际工作选用适合角色或任务的 skill。

---

## 应避免的常见错误认知

| 错误认知 | 实际情况 |
|---|---|
| “OpenRig 是聊天界面或助手” | 不是。OpenRig 是管理 harness 会话的控制平面。聊天发生在 harness 内部，OpenRig 环绕在其外。 |
| “Pod 是工作流分组” | 不是。Pod 是**上下文领域**，其中的智能体共享工作上下文。如果两个智能体每个 turn 都要交流，它们应位于同一个 pod；如果很少交流，则不应位于同一个 pod。 |
| “Edge 表示汇报层级” | 不是。Edge 描述**协作形状**——谁向谁委派、谁观察谁。避免按层级关系解读，否则会扭曲行为。 |
| “我应该像管理 Claude 的压缩一样管理 Codex 的压缩” | 不是。Codex 能干净地自动压缩，Claude 不能。不同 runtime 具有不同生命周期。 |
| “MEMORY.md 会自动加载，所以我不需要读取它” | 不一定。有时 MEMORY.md 会通过系统提醒自动加载，有时不会。不要假定。如果工作涉及其中覆盖的主题，请显式读取。 |
| “Skill 会从父级继承，或者像类一样组合” | 不是。Skill 是扁平产物；组合发生在 AgentSpec `profile.uses.skills`（结构化）或 skill 正文中的软交叉引用（建议性），而非面向对象式继承。 |
| “底座的 `shared-docs/skills/` 文件夹是权威 runtime 路径” | 不是。harness 不会从那里读取。它是编写工作区。runtime 从 `.claude/skills/`、`.agents/skills/` 和产品内置位置加载。 |

---

## 本 skill 的灾难恢复测试

如果你只阅读本 skill，能否做到以下几点？

1. 用一句话说明 OpenRig 是什么类型的系统？
2. 说出四个层级，以及自己所在的位置？
3. 运行 `zrig whoami --json` 并解释输出？
4. 找到自己的角色 guidance 和 peer？
5. 判断自己位于哪种 rig（kernel / project / ephemeral 等）？
6. 知道应去哪个文件夹寻找 skill 正文？
7. 知道接下来应阅读哪些权威参考资料以深入理解？

如果答案都是“可以”，说明你已经建立了方向感。如果有任何一项不行，请告诉 peer 或人类；
上下文缺失可以修复，但前提是明确暴露出来。
