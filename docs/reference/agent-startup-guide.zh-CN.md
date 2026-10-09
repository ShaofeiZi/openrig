# 智能体启动指南

版本：0.2.0
最近校验：2026-04-11
适用：OpenRig 0.1.x

本教你怎么思考一个智能体启动体验里该放什么——写哪些文件、放哪、分层模型怎么投递它们。它是撰写指南，不是 schema 参考。字段级细节见 `rig-spec.md` 和 `agent-spec.md`。

---

## 两类启动

智能体在 boot 时收到的一切，归入两类之一：

### 第 1 类：上下文加载

智能体把 markdown 文件读进上下文窗口。这是今天 OpenRig 的**主机制**，也是你该把大部分撰写精力投进去的地方。

上下文加载塑造智能体知道什么、相信什么、能做什么：
- 它是谁（角色、身份、pod 成员）
- 团队怎么工作（文化、沟通规范、协调协议）
- 项目是什么（代码库上下文、架构、领域知识）
- 它能做什么（skills、SOP、操作流程）
- 它的环境长什么样（服务、访问凭据、工具）

### 第 2 类：确定性配置

工作组 spec 声明式地往智能体运行时环境里装东西：
- Hooks（git hooks、pre-commit 脚本）
- 权限（`.claude/settings.json` 允许清单、审批模式）
- MCP（Model Context Protocol 服务器）
- 系统依赖（工具、包）

今天哪些可靠、哪些是实验性，见本指南末尾的**当前支持矩阵**。

**v0.2.0 建议：** 把尽可能多的设置逻辑放进第 1 类（通过 markdown 文件做上下文加载）。在启动文件里描述期望的终态，让智能体自己处理配置。确定性路径存在于 spec 里，会随时间变可靠，但眼下跨运行时稳定管用的是上下文加载路径。

---

## 上下文加载：什么放哪

### Skills 与启动文件——关键区别

**Skills** 是可复用 SOP。它们教智能体**怎么**做一件事——怎么用 OpenRig、怎么做 TDD、怎么做一次 code review、怎么操作 Vault。skills 跨工作组迁移。你写一次的 skill 可被任何工作组里的任何智能体用。

**启动/指引文件** 是工作组特定、角色特定的。它们告诉智能体**它是谁**、**在做什么**、**这个特定团队怎么运作**。它们按工作组撰写，常常按 pod 或成员撰写。

| 放在 skill 里，当…… | 放在启动/指引文件里，当…… |
|------------------------|---------------------------------------|
| 知识跨工作组可复用 | 知识对这个工作组或项目特定 |
| 它教一个流程或方法论 | 它教身份、角色或团队上下文 |
| 这类任何智能体都可能用 | 只对这个特定拓扑里的智能体有用 |
| 示例：`openrig-user`、`test-driven-development`、`vault-user` | 示例：`role.md`、`CULTURE.md`、`startup/context.md` |

### Skills 的双保险模式

skills 通过两条并行路径投递给智能体：

1. **Spec 声明：** 智能体 spec 的 `resources.skills` + profile `uses.skills` 保证 skill 文件投射到智能体工作区（在运行框架 boot 前安装）
2. **启动指令：** 指引/启动文件告诉智能体真去读、加载这些 skill

两条路径都重要。spec 投射保证文件物理在场。启动指令保证智能体知道去读它们。这个冗余是有意的——它处理一条路径失败的情况。

示例：一个实现者智能体的启动指引说"加载以下 skills：openrig-user、test-driven-development、systematic-debugging"——**而且**智能体 spec 的 profile 用了这些同样的 skill ID。智能体从投射拿到文件，从指引拿到读它们的指令。

### 文件类型

**角色指引（`guidance/role.md`）**

告诉智能体它是谁、职责是什么：
- 头衔和主要职能
- 具体职责（项目符号列表）
- 工作节奏（智能体日常怎么运作）
- 原则（行为准则）
- 与其他团队成员的关系

这是智能体的身份文件。每个智能体都该有一个。

**工作组文化（`CULTURE.md`）**

工作组级章程。应用到工作组里**所有**智能体：
- 沟通规范（用 `zrig send`/聊天室，不用裸 tmux）
- 协调协议（工作怎么在 pod 间流）
- 质量标准（"做完"意味着什么）
- 提交/合并策略
- 上报规则

把它想成每个团队成员第一天读的团队操作手册。

**启动上下文（`startup/context.md`）**

本智能体运行环境特定的 boot 时定位信息：
- 身份恢复指令（`zrig whoami --json`）
- 环境细节（服务 URL、访问凭据、端口）
- 系统检查指令（什么该在跑、怎么验）
- 角色特定的委派信息（问谁、谁委派给你）

这对受管应用专员尤其重要（比如一个 Vault 专员需要知道 Vault 地址和 dev token）。

**项目文档**

教智能体了解项目的工作组级启动文件：
- 架构概览
- 关键约定
- 领域词汇
- 近况（最近在发生什么、在做什么）

这些放在工作组级或 pod 级启动块里，投递给相关智能体。

---

## 分层模型

启动内容通过各层增量合并。每层加到前几层提供的东西上。后层**不**替换前层——它们追加。

### 各层（按投递顺序）

```
1. 智能体层   —— 来自 AgentSpec 顶层启动块
2. Profile 层 —— 来自活动 profile 的启动块
3. 工作组层   —— 来自 RigSpec 顶层启动块
4. 文化层     —— 来自 RigSpec 的 culture_file
5. Pod 层     —— 来自 pod 的启动块
6. 成员层     —— 来自 RigSpec 里成员的启动块
7. 操作员层   —— 运行时注入（openrig-start 叠加、上下文收集器等）
```

### 每层干什么

| 层 | 谁写 | 用途 | 示例内容 |
|-------|-------------|---------|-----------------|
| 智能体 | 智能体 spec 作者 | 随这个智能体类型走的核心身份和能力 | 角色指引、默认 skills |
| Profile | 智能体 spec 作者 | profile 特定变体 | "default" 与 "minimal" profile 不同 skill 集 |
| 工作组 | 工作组 spec 作者 | 给所有智能体的工作组级上下文 | 团队规范、项目文档 |
| 文化 | 工作组 spec 作者 | 工作组章程 | `CULTURE.md`——沟通、质量、操作哲学 |
| Pod | 工作组 spec 作者 | pod 特定协调上下文 | pod SOP、pod 内工作流 |
| 成员 | 工作组 spec 作者 | 单个成员覆盖 | 成员特定指令、cwd 特定上下文 |
| 操作员 | OpenRig 系统 | 系统注入的运行时内容 | `openrig-start.md`、上下文收集器 |

### 实用建议

**大多数工作组只需三层：** 智能体（role.md）、工作组（culture）、操作员（openrig-start）。从简单开始。只在同 pod 里智能体需要不同启动内容时才加 pod 和成员层。

**文化层高价值且常被跳过。** 一个没有 `CULTURE.md` 的工作组靠智能体猜团队怎么沟通协调。写一个。哪怕一个短文化文件也大幅提升团队一致性。

**成员级启动用于例外，不是常态。** 如果每个成员都有自己的启动块，分层模型就被当成配置垃圾堆了。把共享内容上移到 pod 或工作组级重构。

---

## 投递机制

### 文件怎么到智能体

| 投递提示 | 何时 | 怎么 | 用于 |
|---------------|------|-----|---------|
| `auto` | 运行框架 boot 前 | 系统选 | 默认——让 OpenRig 决定 |
| `guidance_merge` | 运行框架 boot 前 | 作为受管块合并进 `CLAUDE.md` / `AGENTS.md` | 角色指引、文化、项目上下文 |
| `skill_install` | 运行框架 boot 前 | 拷到运行时的 skill 目录 | skills |
| `send_text` | 运行框架就绪后 | 通过 tmux 作为文本发到智能体终端 | boot 时定位、身份提示、读 skills 的指令 |

### 投递时机要紧

通过 `guidance_merge` 和 `skill_install` 投递的文件发生在智能体运行框架 boot **之前**。智能体启动时立刻看到它们——它们是初始上下文的一部分。

通过 `send_text` 投递的文件发生在运行框架就绪**之后**。智能体在终端里作为消息收到它们。用于：
- 身份定位（智能体读并处理指令）
- 加载 skills 的指令（文件已投射，消息告诉智能体去读）
- 感觉像操作员简报、而不是预载内容的上下文

### `applies_on` 字段

每个启动文件和动作指定何时适用：
- `fresh_start` —— 只在首次启动投递
- `restore` —— 从快照恢复时投递
- 默认：`[fresh_start, restore]`（两者）

用这个避免重发智能体从恢复对话里已有的上下文。比如一次性项目简报可能只在 `fresh_start` 适用，而身份定位两者都该适用。

---

## 确定性配置

AgentSpec 和 RigSpec 允许声明确定性环境配置：

### Spec 支持什么

**Hooks**（在 `resources.hooks`）：
```yaml
resources:
  hooks:
    - id: pre-commit
      path: hooks/pre-commit.sh
      runtimes: [claude-code]
```
hooks 是拷到智能体工作区的脚本。它们可以是 git hooks、自动化脚本或环境设置。

**运行时资源**（在 `resources.runtime_resources`）：
```yaml
resources:
  runtime_resources:
    - id: claude-settings
      path: runtime/claude-settings.fragment.json
      runtime: claude-code
      type: claude_settings_fragment
```
投射进智能体运行时环境的运行时特定配置文件。

**启动动作**（在 `startup.actions`）：
```yaml
startup:
  actions:
    - type: send_text
      value: "/install-mcp my-server"
      phase: after_ready
      idempotent: true
```
智能体就绪后发到它终端的命令。可以装 MCP、跑设置命令等。

### 当前支持矩阵（OpenRig 0.1.x）

| 能力 | 状态 | 备注 |
|------------|--------|-------|
| 指引文件投射（`guidance_merge`） | **支持** | 可靠。主投递机制。 |
| Skill 投射（`skill_install`） | **支持** | 可靠。skills 拷到工作区。 |
| 就绪后 `send_text` 投递 | **支持** | 可靠。需要运行框架就绪。 |
| Hook 投射 | **实验性** | 文件拷过去，但执行/集成因运行时而异。 |
| 运行时资源投射 | **对识别片段支持** | `claude_settings_fragment`、`claude_mcp_fragment`、`codex_config_fragment` 应用到提供商配置。未知类型拷到运行时扩展目录。 |
| 权限配置 | **原生设置加受管启动标志** | OpenRig 用 `acceptEdits` 启 Claude、用 `workspace-write` 启 Codex，除非一个显式支持的选择改它们。它不加一个全局 Claude `Bash(rig:*)` 允许。opt-in 和自定义选择见[首用户权限指南](getting-started.md#opt-in-permissive-operation)。 |
| MCP 安装 | **实验性** | Claude Code：`/mcp` 交互命令或 CLI 的 `claude mcp add`。也可在启动文件里描述，让智能体自配置。可靠性取决于运行时 TUI 状态。 |
| 系统依赖安装 | **不确定** | 在启动文件里描述；智能体通过 shell 命令处理。 |
| 周期任务 / 唤醒定时器 | **依赖运行时** | Claude Code 通过 `/loop` 命令支持周期任务。Codex 没有确认的等价物。编排者应为 Claude Code 智能体在启动里含 `/loop` 指令。 |

### v0.2.0 方法：描述，然后让智能体处理

对 `guidance_merge`、`skill_install`、`send_text` 之外的一切，推荐方法是：

1. 在启动文件里**描述期望终态**（比如"你需要配这些 MCP 服务器、设这些权限、装这些 hooks"）
2. 在启动指令里**含一个系统检查**（"校验你的环境：检查 X 装了、Y 配了、Z 可访问"）
3. **赋能智能体自配置**（"如果缺这些，装/配它们"）
4. **可选地也在 spec 里声明**，等确定性支持变好时——spec 当蓝图，启动文件当回退指令

这样，当确定性支持完全可靠时，智能体 boot 起来、看到一切已（由确定性路径）设好、跑系统检查、确认一切看着对、继续。在那之前，智能体读指令自己处理设置。

### 运行时配置披露

OpenRig 对受管会话尽力做确定性运行时配置。核心 bootstrap 保持最小；用户/自定义策略属于 spec 选定的运行时资源。这些写是刻意侵入式的，应坦白披露：

- Claude 全局配置：`~/.claude/settings.json`
  OpenRig 不再在这里写核心 `Bash(rig:*)` 权限允许。旧安装可能保留一条；既有用户设置不移除。
- Claude 全局状态：`~/.claude.json`
  用途：预信任受管工作区、为全新受管会话标记 onboarding 完成。
- Claude 项目本地配置：`.claude/settings.local.json`
  用途：在项目内应用上下文收集器/活动 hooks 和选定的 `claude_settings_fragment` 资源，而不提交进 git。
- Claude 项目本地 MCP 配置：`.mcp.json`
  用途：为该项目里的 Claude 应用选定的 `claude_mcp_fragment` 资源。
- Codex 全局配置：`~/.codex/config.toml`
  用途：预信任受管工作区、应用选定的 `codex_config_fragment` 资源。Codex 目前没有等价的项目本地 MCP 配置路径用于全局 profile 设置。

两个重要警告：
- 这些写是尽力而为的，仍应配启动指引，好让本地智能体在需要时校验并修复它们
- 已在跑的接纳会话可能需要重启才拾起新写的配置

权限模式和运行时资源投射是分开的。一个选定片段可以影响原生配置，但 OpenRig 的启动标志可以覆盖那些值。记录一个配置面 `permission_policy` 不证明其规则已被翻译或应用。见[权限优先级与限制](getting-started.md#custom-settings-and-precedence)。

### 运行时差异

**Claude Code：**
- 从 `CLAUDE.md` 和 `.claude/` 目录读
- 通过 `/loop` 命令做周期任务（如 `/loop 5m "check rig health"`）——这**不是** hooks；hooks 是事件驱动的
- 通过 `/mcp` 交互命令或 CLI 的 `claude mcp add` 管理 MCP 服务器
- `.claude/settings.json` 里事件驱动 hooks 系统——响应 `PreToolUse`、`PostToolUse`、`SessionStart` 等事件（不是基于时间）
- 通过 `.claude/settings.json`（`permissions.allow`、`permissions.deny`、`permissions.defaultMode`）做权限允许清单
- 可从启动指令自配置 MCP 服务器、权限和 hooks

**Codex：**
- 从 `AGENTS.md` 和 `.agents/` 目录读
- 周期任务支持有限——没有确认等价于 Claude Code `/loop` 的东西
- MCP 配置机制不同于 Claude Code
- 审批策略和沙箱访问是分开的控制。OpenRig 默认 `-s workspace-write` 选沙箱；它不强加 `-a`。一个成员的 `codex_config_profile` 选原生 `-p`，独立于 AgentSpec `profile`。
- 可从指令自装依赖，但定时器/周期行为不可靠可用

撰写启动内容时，注意哪些指令是运行时特定的。比如一个需要监控循环的编排者应含这样的指令："如果跑 Claude Code，用 `/loop 3m` 定期检查组健康。如果跑 Codex，改为在每个任务周期开始检查组健康。"

---

## 模式与反模式

### 好模式

**从角色 + 文化 + 一个 skill 开始**
```
agent.yaml → guidance/role.md
rig.yaml → culture_file: CULTURE.md
profile → uses.skills: [openrig-user]
```
这是最小有效启动。智能体知道它是谁、团队怎么工作、怎么用工作组。

**把项目上下文和角色分开**

别把项目文档塞进角色指引。角色讲智能体职能；项目上下文讲智能体在做什么。项目上下文用工作组级或 pod 级启动文件。

**明确告诉智能体它的 skills**

在启动文件或指引里，加一行像这样：
```
你已加载以下 skills：openrig-user、test-driven-development、systematic-debugging。用它们。
```
这提示智能体真去调用 skills，而不只是当被动上下文拥有它们。

**在启动上下文里含一个系统检查**

```
## 系统检查

身份恢复后，校验：
1. `zrig ps --nodes` 显示你的工作组在跑（默认按你会话的工作组范围；受管会话外显式点名：`zrig ps --nodes --rig <name>`）
2. `zrig env status` 显示服务健康（若适用）
3. 你的工作目录正确
4. 所需工具可用（node、npm、git 等）

缺什么先修好再开始工作。
```

### 反模式

**把一切倒进一个巨型 CLAUDE.md**

别。用分层模型。角色放智能体 spec。文化放工作组 spec。项目上下文放工作组/pod 启动文件。如果一切在一个文件里，你哪部分都复用不了。

**在指引文件里复制 skill 内容**

如果你发现自己把 skill 里的文本拷进指引文件，停下。改引用 skill。skills 是投射的；指引该指向它们，不复制它们。

**把该预载的内容用 send_text**

如果智能体在开始推理**之前**就需要知道某事，用 `guidance_merge`（boot 前投递），不用 `send_text`（boot 后投递）。`send_text` 用于智能体该当第一个任务处理的指令，不用于基础上下文。

**过度指定成员级启动**

如果每个成员都有一个大启动块，工作组 spec 就成了配置垃圾堆。把共享内容上移到 pod 级重构。成员级启动该是小覆盖，不是完整智能体简报。

**关键设置依赖确定性 hooks**

如果你的工作组**需要**一个 hook 才能工作、而 hook 安装静默失败，智能体不会知道哪里坏了。永远把确定性配置配一个验证结果的启动指令或系统检查。

---

## 撰写清单

创建一个新智能体的启动体验时：

- [ ] 写一个 `guidance/role.md` —— 这个智能体是谁？
- [ ] 在智能体 spec 的 `resources.guidance` **和** `startup.files` 里引用它
- [ ] 如果工作组没有，写一个工作组 `CULTURE.md`
- [ ] 通过 profile `uses` 从共享池选 skills
- [ ] 如果智能体需要环境定位，写一个 `startup/context.md`
- [ ] 在启动上下文里含一个系统检查
- [ ] 校验智能体 spec 通过：`zrig agent validate agent.yaml`
- [ ] 校验工作组 spec 通过：`zrig spec validate rig.yaml`
- [ ] 跑建议性撰写检查：`zrig spec audit rig.yaml`
- [ ] 启动工作组测试，检查智能体收到了预期内容
