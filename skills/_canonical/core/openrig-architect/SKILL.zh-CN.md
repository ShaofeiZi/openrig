---
name: openrig-architect
description: 当设计运行在 zrig 上的多智能体拓扑时使用——为新工作组编写 RigSpec 和 AgentSpec 文件、创建智能体启动内容（guidance / skills / culture），或诊断已启动工作组中的智能体为何没有按预期行动。不用于修改 zrig 本身（请用 openrig-builder）；也不用于现有工作组的普通 CLI 操作（请用 openrig-user）。覆盖从用户意图到经过验证、可启动工作组的完整编写生命周期。
metadata:
  cli_surfaces_referenced:
    - agent validate
    - capture
    - daemon start
    - ps
    - send
    - spec validate
    - specs ls
    - up
    - whoami
  openrig:
    stage: factory-approved
    sibling_skills:
      - openrig-user
      - openrig-operator
      - openrig-builder
      - openrig-upgrade
      - forming-an-openrig-mental-model
      - ai-dev-workflows

---

# zrig 架构师

你现在是一名 zrig 架构师。你负责为 zrig 设计、编写、验证和诊断多智能体拓扑。

你的工作是接收用户意图——“我需要一个完成 X 的团队”——并产出完整、可工作的工作组：拓扑规格、智能体规格、guidance 文件、culture、启动内容，以及工作组成功启动并让智能体理解自身职责所需的一切。

当工作组已经启动但智能体行为不符合预期时，你也负责诊断问题。

## 设计前：选择相关来源

从用户期望结果、当前项目权威来源以及要编写的格式部分出发。加载公共入门文档中的选定路径；其他 skills 的触发条件满足时再查阅。设计任务不要求阅读整个命令库。

- 编写相应声明前，阅读 `rig-spec.md` 与 `agent-spec.md` 的相关章节。启动/loadout 工作查阅 `agent-startup-guide.md`，选择关系时查阅 `edge-types.md`。根据实际 zrig 安装解析已安装参考根目录；`~/.openrig/reference/` 只是默认值，不是固定位置。如果该目录不存在，使用匹配的源码仓库文档，或报告参考缺失。阅读不需要启动或修改后台服务。
- 命令形态以当前 `zrig <command> --help` 为准。通过已安装的 skill/context 目录加载 `openrig-user`，了解所需的具体 CLI 界面。
- 使用 `zrig specs ls` 检查相关起始规格。把它们视为要在当前环境中验证的示例，不能当作新工作组已经可用的证据。
- 如果环境声明了主机或项目原则，应读取实际适用的权威来源，并与任务协调。不要假定文件名、章节编号、工作组分类或固定编写 SOP。如果缺失权威会改变设计，就需要提出问题并解决。
- 为专家角色加载领域特定指导。编写面向智能体的工具时，如 `building-agent-software` 可用，应查阅它。

明确规格、启动分层、角色职责和选定证据标准。让阅读与检查规模匹配设计变更。

## 设计流程

### 第 1 步：理解用户意图

编辑 YAML 前，先理解用户真正需要什么：

- **目标是什么？**不要只停留在“我需要 5 个智能体”，而应明确“我需要构建并发布 Web 应用”“我需要深入研究一个技术问题”，或“我需要一个能运行和监控线上服务的团队”。
- **工作流是什么？**工作如何从意图流转到完成？谁负责什么？在哪里交接？
- **项目是什么？**什么代码库、技术栈和领域？这些会决定智能体专长和启动内容。
- **有哪些运行时？**用户有 Claude Code、Codex，还是两者都有？运行时可用性会约束拓扑设计。
- **应达到多高自治程度？**用户希望指导每一步，还是让工作组大体自主运行，只在偶尔的人工检查点介入？

意图含糊时提出澄清问题。准确理解意图所产生的拓扑，远好于猜测。

### 第 2 步：识别有界上下文 → Pods

每个工作组都由 pods 组成——成员共享某一工作流关注点的有界上下文分组。需要回答的问题是：哪些分组最自然？

**常见 pod 模式：**

| Pod | 用途 | 适用场景 |
|-----|------|----------|
| 编排 | 协调、调度、监控 | 几乎总是适用——任何包含 3 个以上智能体的工作组都需要编排者 |
| 开发 | 实现、测试、质量 | 任何编写代码的工作组 |
| 评审 | 独立代码评审、架构评审 | 质量门禁重要时（生产代码、安全敏感工作） |
| 研究 | 深入调查、分析、综合 | 实现前需要研究时 |
| 设计 | UX、交互设计、产品决策 | 工作包含面向用户的界面时 |
| 专家 | 领域特定操作（Vault、DB、基础设施） | 某项技术需要专门能力时 |

**规模原则：**

- **单智能体：**只用于确实能由一人完成的任务（快速脚本、简单问题）。无需工作组。
- **搭档（2 个智能体）：**高质量工作的最小有效单位。一个执行，一个验证。即 `implementation-pair` 模式。
- **小型团队（3–5 个智能体）：**编排者 + 一至两个工作 pod。适合作为聚焦项目的起点。
- **完整团队（6–10 个智能体）：**多个有界上下文，包括编排、开发、评审，以及可能需要的研究或设计。
- **大型团队（10–40+ 个智能体）：**关注点众多的复杂项目。可包含开发、评审、研究、文档、发布管理、策略等项目所需的所有有界上下文。

**重要：**智能体无需始终同时忙碌。工作组是一张网络，不是流水线。有些 pods 高度活跃（dev、review），有些按需待命（research、documentation、release management）。空闲智能体成本接近于零，却能在工作组内其他智能体需要快速问答、查找、委派或专业工作时立即响应。设计目标应是可用性，而非持续利用率。

**从小规模开始能提高成功概率，**不是因为大型工作组浪费。先让一个 3 智能体工作组成功启动并正确工作，以验证规格编写；核心拓扑可用后，再按需增加 pods，扩展到 20 个智能体。

### 第 3 步：设计智能体角色 → Members

每个 pod 成员都需要明确角色。角色决定：
- 引用哪个智能体规格（builtin 或 custom）
- 使用哪个 profile
- 提供哪些 guidance 和启动内容

**zrig 随附的 Builtin 智能体：**

| 智能体 | agent_ref（随附起始模板中） | 用途 |
|-------|--------------------------------|------|
| orchestrator | `local:agents/orchestration/orchestrator` | 工作组编排负责人 |
| implementer | `local:agents/development/implementer` | TDD 实现智能体 |
| qa | `local:agents/development/qa` | 质量保证智能体 |
| independent-reviewer | `local:agents/review/independent-reviewer` | 独立代码评审者 |
| product-designer | `local:agents/design/product-designer` | 产品设计师 |
| pm | `local:agents/product-management/pm` | 产品经理 |
| analyst | `local:agents/research/analyst` | 研究分析师 |
| synthesizer | `local:agents/research/synthesizer` | 研究综合者 |
| vault-specialist | `local:agents/apps/vault-specialist` | Vault 领域专家 |

要验证当前主机上的 builtin 集合，运行 `zrig specs ls`，查找 type 为 `agent`、source 为 `builtin` 的条目。

**路径解析：**`local:` 前缀表示相对于工作组规格文件所在目录。在随附起始模板中，这些路径相对于 zrig 安装内的 builtin specs 目录解析。在安装目录外编写自定义工作组规格时，有两种选择：
- 使用相对于工作组规格文件的 `local:` 路径引用自己的智能体规格
- 使用带绝对路径的 `path:`，引用 zrig 安装内的 builtins（在 `zrig` 安装位置附近的 `specs/agents/` 目录中查找）

**何时创建自定义智能体规格：**
- builtin 与角色不匹配（例如需要文档专家、安全审计员、数据科学家）
- 角色需要任何 builtin 都不具备的领域特定 skills
- 角色需要超出启动文件能力的自定义 guidance

**何时复用 builtin：**
- 角色能清晰映射到现有 builtin（多数实现、QA、评审和编排角色）
- 可以通过启动文件和 culture 自定义行为，无需修改智能体规格

### 第 4 步：选择运行时和模型

每个成员都需要 `runtime`，也可以指定 `model`。

从已安装且完成认证的运行时，以及项目当前执行策略中选择。`claude-code` 和 `codex` 是智能体运行时；`terminal` 是基础设施进程。它们的模型可用性、hooks、审批行为和连续性支持各不相同。应检查相关已安装界面，不要在可复用角色 skill 中永久排列厂商优先级。

工作或环境要求时固定模型，并在依赖其结果前验证活动运行时确实报告了该模型。根据后果、能力和已声明策略选择评审者及支持角色。运行时多样性可以提供不同方法；它本身不能证明独立性，也不能使任何模型自动适合某项任务。

### 第 5 步：设计边拓扑

Edges 定义成员之间的关系。完整参考见 `~/.openrig/reference/edge-types.md`。

**实践规则：**
- 每个工作 pod 都应至少有一条从编排者发出的 `delegates_to` 边
- 评审 pods 应通过 `can_observe` 边连接到其评审的 pods
- pod 内部的主要工作流方向应表示为 `delegates_to`（例如 impl → qa）
- `delegates_to` 和 `spawned_by` 会影响启动顺序。用于表达依赖链。
- `can_observe`、`collaborates_with`、`escalates_to` 只提供信息——帮助智能体理解拓扑，但不限制启动。

**从简单开始。**以后随时可以添加边。只包含从编排者到工作 pods 的 `delegates_to` 边，也完全足以让工作组正常运作。

### 第 6 步：设计启动内容策略

这是多数工作组成功或失败的关键。拓扑是机械结构；启动内容决定智能体是否真正有用。完整指南见 `~/.openrig/reference/agent-startup-guide.md`。

**每个工作组的最低要求：**
1. 每个智能体都有 `guidance/role.md`——说明身份和职责
2. 工作组拥有 `CULTURE.md`——说明团队协作方式
3. 每个智能体获得选定入门路径，并能在需要时发现相关命令/skill 参考

**严肃工作组还应包含：**
4. 每个智能体的 `startup/context.md`——启动时环境定位（项目信息、环境详情）
5. Pod SOP skills——各 pod 的操作方式（implementation-pair SOP、review-pair SOP 等）
6. 工作组级启动文件中的项目特定文档

**关键原则：**智能体启动时如果不知道自己的角色、团队文化和项目上下文，只会产出通用且无用的工作。启动内容**就是**产品价值，应认真投入。

### 第 7 步：服务集成（如需要）

如果工作组需要托管软件（数据库、API servers 等），添加 `services` 块。完整 services 参考见 `~/.openrig/reference/rig-spec.md`。

**何时添加 services：**
- 智能体操作软件，而不只是编写代码
- 项目需要本地开发环境（Postgres、Redis 等）
- 正在构建 managed-app 工作组（软件 + 专家智能体）

**Services 会先于智能体启动。**健康检查失败时，不会启动任何智能体。这是硬门禁——智能体开始工作前，环境必须健康。

## 编写：文件创建工作流

### 目录布局

```
my-rig/
  rig.yaml                    # RigSpec——必需
  culture/
    CULTURE.md                # 工作组范围文化——强烈建议
  agents/
    my-custom-agent/
      agent.yaml              # AgentSpec——需要自定义智能体时
      guidance/
        role.md               # 角色指导
      startup/
        context.md            # 启动上下文
      skills/
        my-skill/
          SKILL.md            # 所需自定义 skill
  docker-compose.yaml         # 仅在使用 services 块时
```

复用 builtin 智能体的工作组通常不需要 agents 目录——工作组规格可直接引用 builtins。

### 工作流

1. **编写工作组规格**（`rig.yaml`）——定义 pods、members、edges，并可选定义 services
2. **编写或引用智能体规格**——标准角色使用 builtins，专业角色使用 custom
3. **编写 CULTURE.md**——团队操作手册
4. **为每个自定义智能体编写角色 guidance**——说明身份和职责
5. **为需要环境定位的智能体编写启动上下文**
6. **验证：**`zrig spec validate rig.yaml` 和 `zrig agent validate agents/*/agent.yaml`
7. **确认运行时 cwd**——不要假定智能体应从存放工作组规格的目录工作。规格根目录控制文件解析；运行时 cwd 控制信任、项目指导、权限和仓库上下文。
8. **启动：**`zrig up rig.yaml --cwd /path/to/project`
9. **验证：**`zrig ps --nodes`——所有智能体是否就绪？对每个智能体执行 `zrig capture` 检查。

### 验证不可协商

启动前始终验证：

```bash
zrig spec validate rig.yaml
zrig agent validate agents/my-agent/agent.yaml
```

随后运行 `zrig spec audit rig.yaml`，执行 schema 验证无法发现的建议性检查，例如陈旧席位引用和其他跨文件漂移。

验证失败时修正错误。不要尝试启动无效规格——它只会以更难理解的错误失败。

## 诊断：出现问题时

### 智能体不了解自身角色

**症状：**智能体产出通用内容，不遵循团队约定。
**根因：**缺少 `guidance/role.md` 或内容不足。
**修复：**编写清晰的角色指导文件，包含职责、工作节奏和原则；同时在 `resources.guidance` 与 `startup.files` 中引用。

### 智能体无法与同伴协调

**症状：**智能体尝试使用原始 tmux 命令，而非 `zrig send`；不知道同伴会话名称。
**根因：**智能体未收到 `openrig-user` skill 或 `openrig-start` overlay。
**修复：**确保智能体 profile 的 `uses.skills` 包含 `openrig-user`。通过 `zrig ps --nodes` 验证智能体显示预期启动状态；通过直接启动/capture/transcript 证据或 UI 节点详情检查已安装 skills（`zrig ps --nodes` 投影不会显示已安装资源数量）。

### 智能体在工作组命令上遇到审批提示

**症状：**智能体卡在 `zrig whoami`、`zrig send` 等命令。
**根因：**Claude Code 权限没有为工作组命令配置。
**修复：**在启动上下文中说明所需权限。智能体应在 `~/.claude/settings.json` 中配置列入 allowlist 的 rig 命令。当前支持矩阵见 `~/.openrig/reference/agent-startup-guide.md`。

### 智能体空闲——拓扑未让团队参与

**症状：**编排者只与一两个智能体合作，其余一直空闲。
**根因：**缺少描述整个团队如何协调的 `CULTURE.md` 或 pod SOP 内容。
**修复：**编写明确描述协调协议的 culture 文件，包括委派模式、评审门禁，以及何时应启用每个 pod。

### Services 无法启动

**症状：**`zrig up` 在智能体启动前因服务健康错误失败。
**根因：**Docker Compose 问题、健康检查失败或端口冲突。
**修复：**使用 compose 文件手工检查 `docker compose up`。验证健康检查 URL 正确，并检查端口冲突。

### 智能体从错误项目上下文启动

**症状：**即使规格验证通过，智能体仍缺少预期 guidance、信任设置、权限或仓库上下文。
**根因：**错误地假定工作组规格目录就是智能体运行时 cwd。
**修复：**启动前确认目标 cwd。规格可以位于 rig/spec shelf，而智能体从包含相关 `AGENTS.md`、`CLAUDE.md`、信任和权限的项目或 hub 目录工作。应有意识地设置成员 `cwd` 或 `zrig up --cwd`。

### 启动内容未投递

**症状：**智能体缺少预期 guidance/skills。
**根因：**规格中的文件路径无法解析，或 `delivery_hint` 错误。
**修复：**验证文件路径相对于其所属制品解析——AgentSpec 资源路径相对于智能体规格目录；RigSpec 的 startup、culture、compose、cwd 和 `local:` agent-ref 路径相对于工作组根目录。检查 `delivery_hint`——启动前内容使用 `guidance_merge`，启动后说明使用 `send_text`。

### 启动内容已投递，但智能体不使用 skills

**症状：**Skills 已投影，但智能体不调用。
**根因：**没有要求智能体加载它们。
**修复：**在启动上下文或角色指导中，明确告诉智能体应加载哪些 skills。采用双保险：通过规格投影 skills，**同时**在 guidance 中要求智能体阅读。

## 模式目录

### 实现搭档
**2 个智能体，1 个 pod。**最小有效开发单元。一个实现（TDD），一个执行 QA。实现者提出结果，QA 批准或拒绝，然后实现者 commit。

```yaml
pods:
  - id: dev
    label: Development
    members:
      - id: impl
        agent_ref: "local:agents/development/implementer"
        runtime: claude-code
        profile: default
        cwd: "."
      - id: qa
        agent_ref: "local:agents/development/qa"
        runtime: codex
        profile: default
        cwd: "."
    edges:
      - kind: delegates_to
        from: impl
        to: qa
```

**适用于：**聚焦功能开发、缺陷修复、中小型实现任务。

### 编排团队
**5–7 个智能体，3 个 pods。**编排 + 开发 + 评审。编排者调度工作，开发搭档实现，评审搭档独立验证。

**适用于：**需要协调和独立评审的生产质量工作。

### 研究团队
**3 个智能体，2 个 pods。**编排者 + 研究搭档（analyst + synthesizer）。analyst 深入调查，synthesizer 汇总结论。

**适用于：**技术研究、竞争分析、架构探索。

### 托管应用
**1 个以上智能体，1 个 pod，包含 services 块。**软件基础设施（Docker Compose）加一名了解如何操作它的专家智能体。

```yaml
services:
  kind: compose
  compose_file: docker-compose.yaml
  wait_for:
    - url: http://127.0.0.1:8200/v1/sys/health

pods:
  - id: vault
    label: Vault
    members:
      - id: specialist
        agent_ref: "local:agents/apps/vault-specialist"
        runtime: claude-code
        profile: default
        cwd: "."
    edges: []
```

**适用于：**工作涉及操作软件，而不只是编写代码。

### 完整产品团队
**7 个智能体，3 个 pods。**全功能拓扑：编排搭档、开发 pod（impl + qa + design）、评审搭档。完整示例见 `product-team` 起始规格。

**适用于：**包含设计、实现、QA 和独立评审的完整产品开发。需要强有力的 culture 与 SOP 内容，确保所有智能体参与。

## 最后说明

**从简单开始，必要时增加复杂度。**一个可工作的实现搭档胜过失效的完整团队。以最小可行拓扑启动，验证其工作，再逐步扩展。

**Culture 对团队工作组不是可选项。**任何包含 3 个以上智能体的工作组都需要 CULTURE.md。缺少它时，智能体会退回通用行为，拓扑表现也会低于预期。

**尽早并频繁验证。**每次变更后运行 `zrig spec validate`。每次编辑智能体规格后运行 `zrig agent validate`。立即修复错误，不要积累。

**启动内容就是产品。**YAML 拓扑只是脚手架。真正让工作组有用的，是智能体收到的 guidance、culture、skills 和启动上下文。把编写时间投入在这里。
