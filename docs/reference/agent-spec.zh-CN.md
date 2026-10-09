# AgentSpec 参考

版本：1.0
最近一次对照代码校验：2026-04-11
真源：`packages/daemon/src/domain/agent-manifest.ts`、`packages/daemon/src/domain/types.ts`

这是 AgentSpec YAML 格式（`agent.yaml`）的权威参考。本文档记录的每个字段、校验规则和默认值，都从实际解析器和校验器代码追溯而来。

---

## 最小合法示例

```yaml
name: my-agent
version: "1.0"

profiles:
  default:
    uses:
      skills: []
      guidance: []
      subagents: []
      hooks: []
      runtime_resources: []

resources: {}

startup:
  files: []
  actions: []
```

## 实用示例（实现者智能体）

```yaml
name: implementer
version: "1.0"
description: 实现智能体——按 TDD 纪律写代码

defaults:
  runtime: claude-code

imports:
  - ref: local:../../shared

profiles:
  default:
    uses:
      skills: [openrig-user, development-team, test-driven-development, systematic-debugging]
      guidance: []
      subagents: []
      hooks: []
      runtime_resources: []

resources:
  guidance:
    - id: role
      path: guidance/role.md

startup:
  files:
    - path: guidance/role.md
      delivery_hint: send_text
      required: true
  actions: []
```

## 完整示例（全部特性）

```yaml
name: vault-specialist
version: "1.0"
description: Vault 专员智能体——为这个受管应用管理 HashiCorp Vault

defaults:
  runtime: claude-code
  model: claude-opus-4-6
  lifecycle:
    execution_mode: interactive_resident
    compaction_strategy: default-compaction
    restore_policy: resume_if_possible

imports:
  - ref: local:../../shared
  - ref: local:../common-tools
    version: "2.0"

profiles:
  default:
    summary: 标准 Vault 操作 profile
    preferences:
      runtime: claude-code
    uses:
      skills: [openrig-user, systematic-debugging, vault-user]
      guidance: []
      subagents: []
      hooks: []
      runtime_resources: []
    startup:
      files:
        - path: guidance/profile-specific.md
          delivery_hint: send_text
      actions: []
    lifecycle:
      restore_policy: resume_if_possible

resources:
  skills:
    - id: vault-user
      path: skills/vault-user
  guidance:
    - id: role
      path: guidance/role.md
  hooks:
    - id: pre-commit
      path: hooks/pre-commit.sh
      runtimes: [claude-code]
  runtime_resources:
    - id: claude-settings
      path: runtime/claude-settings.fragment.json
      runtime: claude-code
      type: claude_settings_fragment

startup:
  files:
    - path: guidance/role.md
      delivery_hint: send_text
      required: true
    - path: startup/context.md
      delivery_hint: send_text
      required: true
    - path: guidance/optional-tips.md
      delivery_hint: guidance_merge
      required: false
      applies_on: [fresh_start]
  actions:
    - type: send_text
      value: "加载 vault-user skill 并校验 Vault 健康。"
      phase: after_ready
      idempotent: true
```

---

## 顶层字段

| 字段 | 类型 | 必需 | 默认 | 描述 |
|-------|------|----------|---------|-------------|
| `name` | string | 是 | —— | 智能体名。用于 spec 库标识和校验消息。 |
| `version` | string | 是 | —— | spec 版本。仅供参考——不用于兼容门。 |
| `description` | string | 否 | —— | 人类可读描述。显示在 spec 库和评审界面。 |
| `defaults` | Defaults | 否 | —— | 默认运行时、模型和生命周期设置。工作组 spec 或 profile 未覆盖时应用。 |
| `imports` | Import[] | 否 | `[]` | 要 import 的其他 AgentSpec。被 import spec 的资源可供 profile `uses` 引用。 |
| `profiles` | map<string, Profile> | 否 | `{}` | 命名 profile。每个 profile 选资源，可覆盖启动/生命周期。工作组 spec 成员的 `profile` 字段选哪个 profile。 |
| `resources` | Resources | 否 | 全空 | 声明的资源（skills、guidance、subagents、hooks、运行时资源）。这些是 profile 通过 `uses` 选的可用池。 |
| `startup` | StartupBlock | 否 | `{ files: [], actions: [] }` | 智能体级启动文件和动作。通过启动分层模型应用到所有 profile。 |

---

## Defaults

```yaml
defaults:
  runtime: claude-code
  model: claude-opus-4-6
  lifecycle:
    execution_mode: interactive_resident
    compaction_strategy: default-compaction
    restore_policy: resume_if_possible
```

| 字段 | 类型 | 必需 | 默认 | 描述 |
|-------|------|----------|---------|-------------|
| `runtime` | string | 否 | —— | 本智能体默认运行时。可被工作组 spec 成员的 `runtime` 字段覆盖。 |
| `model` | string | 否 | —— | 默认模型。可被工作组 spec 成员的 `model` 字段覆盖。 |
| `lifecycle` | Lifecycle | 否 | 见下 | 生命周期行为默认。 |

### 生命周期默认

| 字段 | 类型 | 默认 | 允许值 |
|-------|------|---------|----------------|
| `execution_mode` | string | `interactive_resident` | `interactive_resident`（v1 唯一值；`wake_on_demand` 明确拒绝） |
| `compaction_strategy` | string | `default-compaction` | `default-compaction`、`managed-compaction`、`handover`、`apprentice-handover`；旧别名接受但带校验建议：`harness_native` → `default-compaction`、`pod_continuity` → `handover`（`custom_prompt` 在 v1 明确拒绝） |
| `restore_policy` | string | `resume_if_possible` | `resume_if_possible`、`relaunch_fresh`、`checkpoint_only` |

---

## Imports

```yaml
imports:
  - ref: local:../../shared
  - ref: local:../common-tools
    version: "2.0"
```

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `ref` | string | 是 | 对另一个 AgentSpec 目录的引用。必须以 `local:`（相对）或 `path:`（绝对）开头。引用目录必须含一个 `agent.yaml`。 |
| `version` | string | 否 | 可选版本约束。必须是确切版本——不支持范围（`~`、`^`、`>=` 等）。 |

### Import 解析

- `local:` 路径相对 import 方 spec 的目录解析
- `path:` 路径是绝对文件系统路径
- 被 import 资源可供 profile 里 `uses` 引用
- 在 `uses` 里引用被 import 资源时，用限定 `namespace:id` 格式（如 `shared:openrig-user`）
- 不限定引用（只写 `id`）先对 spec 自己的本地资源解析

### 共享 import 模式

大多数内置智能体 import 共享内置 spec：

```yaml
imports:
  - ref: local:../../shared
```

这给到共享 skills（openrig-user、systematic-debugging、development-team 等）完整池，智能体通过 profile `uses` 选它们需要的。

---

## Profiles

```yaml
profiles:
  default:
    summary: 标准操作 profile
    preferences:
      runtime: claude-code
      model: claude-opus-4-6
    uses:
      skills: [openrig-user, systematic-debugging, vault-user]
      guidance: [role]
      subagents: []
      hooks: []
      runtime_resources: []
    startup:
      files: []
      actions: []
    lifecycle:
      restore_policy: resume_if_possible
```

| 字段 | 类型 | 必需 | 默认 | 描述 |
|-------|------|----------|---------|-------------|
| `summary` | string | 否 | —— | profile 描述。 |
| `preferences` | object | 否 | —— | 本 profile 的运行时/模型偏好。 |
| `preferences.runtime` | string | 否 | —— | 偏好运行时。 |
| `preferences.model` | string | 否 | —— | 偏好模型。 |
| `uses` | Uses | 否 | 全空 | 选哪些声明资源对本 profile 活跃。 |
| `startup` | StartupBlock | 否 | —— | profile 级启动文件和动作。通过分层与智能体级启动合并。 |
| `lifecycle` | Lifecycle | 否 | —— | profile 级生命周期覆盖。 |

### Uses

`uses` 块选 `resources` 池（含被 import 资源）里哪些对本 profile 活跃。

```yaml
uses:
  skills: [openrig-user, systematic-debugging, vault-user]
  guidance: [role]
  subagents: []
  hooks: [pre-commit]
  runtime_resources: [claude-settings]
```

每个数组含资源 ID。这些可以是：
- **不限定**（`vault-user`）——先对 spec 自己的 `resources` 解析，再到被 import spec
- **限定**（`shared:openrig-user`）——对一个特定被 import spec 的资源解析

`uses` 类别是：`skills`、`guidance`、`subagents`、`hooks`、`runtime_resources`。

---

## Resources

```yaml
resources:
  skills:
    - id: vault-user
      path: skills/vault-user
  guidance:
    - id: role
      path: guidance/role.md
  subagents:
    - id: helper
      path: subagents/helper
  hooks:
    - id: pre-commit
      path: hooks/pre-commit.sh
      runtimes: [claude-code]
  runtime_resources:
    - id: claude-settings
      path: runtime/claude-settings.fragment.json
      runtime: claude-code
      type: claude_settings_fragment
```

资源是可用池。它们**不**自动投递给智能体——profile 通过 `uses` 选它们。唯一投递的资源是活动 profile 的 `uses` 块引用的那些。

### 资源类别

| 类别 | 字段 | 描述 |
|----------|--------|-------------|
| `skills` | `id`、`path` | 含 SKILL.md 的 skill 目录。通过 `skill_install` 投递。 |
| `guidance` | `id`、`path`、`target`*、`merge`* | 指引文件。通过 `guidance_merge` 投进 CLAUDE.md/AGENTS.md。 |
| `subagents` | `id`、`path` | 子智能体定义。 |
| `hooks` | `id`、`path`、`runtimes`* | hook 脚本。可选 `runtimes` 数组限制到特定运行时。 |
| `runtime_resources` | `id`、`path`、`runtime`、`type` | 运行时特定资源。`runtime` 和 `type` 必填。 |

*标 `*` 的字段可选。

识别的运行时资源类型：
- `claude_settings_fragment` —— 把一个 JSON 对象合并进 `<cwd>/.claude/settings.local.json`。
- `claude_mcp_fragment` —— 把一个 JSON 对象合并进 `<cwd>/.mcp.json`。
- `codex_config_fragment` —— 在一个 OpenRig 受管块内 upsert 一个 TOML 片段进 `~/.codex/config.toml`。

未知运行时资源类型仍拷到运行时扩展目录，供智能体可见上下文。

#### 写一个 `codex_config_fragment`

**片段以一个表表头开头。** 一个片段本身必须是一个合法 TOML 文档，它设的每个键必须坐在它声明的一个表下。一个把键放在第一个表表头之前的片段在投影时被拒，什么都不写。

原因是 TOML 语法，不是策略选择。受管块追加到用户 `config.toml` 末尾，而 TOML 一旦开了表就没有回到文档根的语法。所以如果用户文件结束在任何表内部，一个追加的根级键不落根——它静默变成*他们*表的一个成员。拒绝是确定性的，绝不检视用户文件：一个片段作者看不到用户状态，一条依赖它而通过或失败的规则无法复现。

```toml
# 被拒——`model` 会绑进用户文件结束处碰巧在的表
model = "gpt-5"

[mcp_servers.exa]
url = "https://mcp.exa.ai/mcp"
```

```toml
# 接受——每个键坐在本片段声明的一个表下
[mcp_servers.exa]
url = "https://mcp.exa.ai/mcp"
```

当一个片段的表是用户已声明的表，用户表赢：受管表被丢，他们的值从不被合并、改写或覆盖，片段其余部分仍适用。

### 资源路径规则

- 所有资源路径必须是安全相对路径（无 `..` 穿越、无绝对路径）
- 路径相对智能体 spec 目录解析
- 资源 ID 在类别内唯一
- 资源 ID 是 `uses` 引用用的标识

### Guidance 资源

```yaml
guidance:
  - id: role
    path: guidance/role.md
    target: CLAUDE.md      # 可选——合并到哪
    merge: managed_block   # 可选——怎么合并（默认 managed_block）
```

| 字段 | 类型 | 必需 | 默认 | 描述 |
|-------|------|----------|---------|-------------|
| `id` | string | 是 | —— | 资源标识。 |
| `path` | string | 是 | —— | 指引文件相对路径。 |
| `target` | string | 否 | —— | 合并目标文件（如 `CLAUDE.md`）。 |
| `merge` | string | 否 | `managed_block` | 合并策略。之一：`managed_block`、`append`。 |

---

## 启动块

启动块格式同 RigSpec（文件和动作完整细节见 `docs/reference/rig-spec.md`）。

智能体级启动应用到所有 profile。profile 级启动只在该 profile 活动时应用。两者通过启动分层模型增量合并。

一个额外定向挑战需要一个显式 `startup_proof` 动作，带 `value: authenticated` 和 `idempotent: true`。省略不加练习；后来适用的 `value: none` 覆盖早先选择。优先级、恢复行为和就绪与已验证证明的区分见[启动证明选择](rig-spec.md#startup-proof-selection)。

### 投递提示速查

| 提示 | 何时投递 | 机制 |
|------|---------------|-----------|
| `auto` | 运行框架 boot 前 | 系统按文件类型选 |
| `guidance_merge` | 运行框架 boot 前 | 作为受管块合并进 CLAUDE.md/AGENTS.md |
| `skill_install` | 运行框架 boot 前 | 装到运行时 skill 目录 |
| `send_text` | 运行框架就绪后 | 通过 tmux 作为文本发到智能体终端 |

---

## 校验规则汇总

1. `name` 和 `version` 必填非空字符串。
2. `imports` 必须是带 `ref` 字段的对象数组。
3. import `ref` 必须以 `local:`（相对）或 `path:`（绝对）开头。
4. import `version` 必须是确切版本（无范围）。
5. `profiles` 必须是 map（对象），不是数组。
6. profile `uses` 引用必须解析到声明资源（本地或被 import）。
7. 不解析到本地资源的不限定 `uses` 引用需要 imports 在场。
8. 限定 `uses` 引用必须是 `namespace:id` 格式。
9. 所有资源路径必须是安全相对路径。
10. 资源 ID 在类别内唯一。
11. `runtime_resources` 条目需要 `runtime` 字段。
12. 生命周期 `execution_mode` 必须为 `interactive_resident`。
13. 生命周期 `compaction_strategy` 必须是 `default-compaction`、`managed-compaction`、`handover`、`apprentice-handover` 之一——或一个旧别名（`harness_native`、`pod_continuity`），带弃用建议校验并规范化为其 canonical 值（OPR.0.5.6.20）。
14. 生命周期 `restore_policy` 必须是 `resume_if_possible`、`relaunch_fresh` 或 `checkpoint_only`。
15. 启动文件和动作遵循 RigSpec 里同样的校验规则。

---

## 文件系统布局

一个智能体 spec 目录遵循这个约定布局：

```
my-agent/
  agent.yaml              # 必填——AgentSpec
  guidance/
    role.md               # 角色定义
  startup/
    context.md            # boot 时定位
  skills/
    my-skill/
      SKILL.md            # skill 内容
  hooks/
    pre-commit.sh         # hook 脚本
  runtime/
    claude-settings.fragment.json  # 运行时特定资源
```

唯一必填文件是 `agent.yaml`。其他都由 spec 里路径引用，必须存在于那些相对路径。

---

## 随包示例

| 智能体 | 位置 | Imports | Profile Skills | 用途 |
|-------|----------|---------|---------------|---------|
| `shared` | `specs/agents/shared/` | 无 | —（仅资源池） | 所有内置智能体的共享 skill 池 |
| `implementer` | `specs/agents/development/implementer/` | `shared` | openrig-user、development-team、test-driven-development、systematic-debugging 等 | TDD 实现智能体 |
| `qa` | `specs/agents/development/qa/` | `shared` | openrig-user、development-team 等 | 质量保证智能体 |
| `orchestrator` | `specs/agents/orchestration/orchestrator/` | `shared` | openrig-user、orchestration-team 等 | 工作组编排首席 |
| `independent-reviewer` | `specs/agents/review/independent-reviewer/` | `shared` | review-team、systematic-debugging、verification-before-completion | 独立 code 评审者 |
| `vault-specialist` | `specs/agents/apps/vault-specialist/` | `shared` | openrig-user、systematic-debugging、vault-user | Vault 领域专员 |
| `design` | `specs/agents/design/` | 无 | — | 产品设计师 |
