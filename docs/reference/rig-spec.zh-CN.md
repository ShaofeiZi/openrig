# RigSpec 参考

版本：0.2（pod 感知）
最近一次对照代码校验：2026-04-11
真源：`packages/daemon/src/domain/rigspec-schema.ts`、`packages/daemon/src/domain/types.ts`

这是 pod 感知 RigSpec YAML 格式的权威参考。本文档记录的每个字段、校验规则和默认值，都从实际解析器和校验器代码追溯而来，而非照搬旧文档。

---

## 最小合法示例

```yaml
version: "0.2"
name: my-rig

pods:
  - id: dev
    label: Development
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: claude-code
        cwd: "."
    edges: []

edges: []
```

## 完整示例（全部特性）

```yaml
version: "0.2"
name: my-product-team
summary: 一个带编排、开发和评审 pod 的完整产品小队。

culture_file: culture/CULTURE.md

docs:
  - path: SETUP.md
  - path: README.md

startup:
  files:
    - path: guidance/team-norms.md
      delivery_hint: guidance_merge
      required: true
  actions: []

services:
  kind: compose
  compose_file: docker-compose.yaml
  project_name: my-product
  profiles: [core]
  down_policy: down
  wait_for:
    - url: http://127.0.0.1:5432/health
    - service: redis
      condition: healthy
  surfaces:
    urls:
      - name: App
        url: http://127.0.0.1:3000
    commands:
      - name: psql
        command: "psql postgresql://app:dev@127.0.0.1:5432/app"
  checkpoints:
    - id: postgres
      export: "docker compose exec -T postgres pg_dump -U app > {{artifacts_dir}}/postgres.sql"
      import: "cat {{artifacts_dir}}/postgres.sql | docker compose exec -T postgres psql -U app"

pods:
  - id: orch
    label: Orchestration
    members:
      - id: lead
        agent_ref: "local:agents/orchestrator"
        profile: default
        runtime: claude-code
        cwd: "."
      - id: peer
        agent_ref: "local:agents/orchestrator"
        profile: default
        runtime: codex
        cwd: "."
    edges: []

  - id: dev
    label: Development
    summary: 实现与质量保证对子。
    continuity_policy:
      enabled: true
      sync_triggers: [pre_compaction, pre_shutdown]
      artifacts:
        session_log: true
        restore_brief: true
      restore_protocol:
        peer_driven: true
        verify_via_quiz: false
    startup:
      files:
        - path: guidance/dev-sop.md
          delivery_hint: guidance_merge
          required: true
      actions: []
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: claude-code
        cwd: "."
        label: "实现负责人"
        model: claude-opus-4-6
        restore_policy: resume_if_possible
        startup:
          files:
            - path: guidance/impl-specific.md
              delivery_hint: send_text
              required: false
              applies_on: [fresh_start]
          actions:
            - type: send_text
              value: "加载 implementation-pair skill 并开始。"
              phase: after_ready
              idempotent: true
      - id: qa
        agent_ref: "local:agents/qa"
        profile: default
        runtime: codex
        cwd: "."
    edges:
      - kind: delegates_to
        from: impl
        to: qa

  - id: rev
    label: Review
    members:
      - id: r1
        agent_ref: "local:agents/reviewer"
        profile: default
        runtime: claude-code
        cwd: "."
      - id: r2
        agent_ref: "local:agents/reviewer"
        profile: default
        runtime: codex
        cwd: "."
    edges: []

edges:
  - kind: delegates_to
    from: orch.lead
    to: dev.impl
  - kind: delegates_to
    from: orch.peer
    to: dev.qa
  - kind: can_observe
    from: rev.r1
    to: dev.impl
  - kind: can_observe
    from: rev.r2
    to: dev.qa
```

---

## 顶层字段

| 字段 | 类型 | 必需 | 默认 | 描述 |
|-------|------|----------|---------|-------------|
| `version` | string | 是 | —— | pod 感知 spec 必须为 `"0.2"`。 |
| `name` | string | 是 | —— | 工作组名。用于会话命名（`{pod}-{member}@{name}`）、快照标识和 spec 库查找。 |
| `summary` | string | 否 | —— | 人类可读描述。显示在 spec 库、评审界面和 `zrig specs show`。 |
| `culture_file` | string | 否 | —— | 工作组级文化/章程文件相对路径。必须是安全相对路径（无 `..`、无绝对）。 |
| `permission_policy` | string | 否 | —— | 附在工作组上的权限策略。内置（`builtin:locked`、`builtin:standard`、`builtin:open`、`builtin:yolo`）或一个自定义策略文件的安全相对路径（从本 spec 目录解析；无 `..`、无绝对）。缺省留默认地板。一个成员可以设自己的 `permission_policy`，优先于工作组级。见下文"挂载权限策略"。 |
| `managed_blocks` | map | 否 | `CLAUDE.md` | 接收 OpenRig 为 Claude Code 成员写的受管指令块的文件。只接受 `claude-code` 键，值为 `CLAUDE.md` 或 `CLAUDE.local.md`。Codex 成员永远用 `AGENTS.md`。见下文"选 Claude 指令文件"。 |
| `docs` | Doc[] | 否 | —— | 应随工作组走的文档文件。打进工作组 bundle。每条有一个 `path` 字段（安全相对路径）。引擎不消费它们——它们供人和智能体在启动前搭环境。 |
| `startup` | StartupBlock | 否 | —— | 工作组级启动文件和动作。通过启动分层模型应用到所有成员。 |
| `services` | ServicesBlock | 否 | —— | 可选受管服务（Docker Compose）。在场时，服务在任何智能体启动前先 boot。 |
| `pods` | Pod[] | 是 | —— | 至少一个 pod。每个 pod 是一个含成员和 pod 内边的有界上下文。 |
| `edges` | CrossPodEdge[] | 否 | `[]` | 连接不同 pod 成员的跨 pod 边。必须用全限定 `pod.member` ID。 |

### 挂载权限策略

用 `permission_policy` 把策略挂到一个工作组，在工作组级或成员上：

```yaml
# 内置，按名：
permission_policy: builtin:standard

# 或一个自定义策略文件，按相对路径（从本 spec 目录解析）：
permission_policy: policies/my-cautious-dev.policy.md
```

内置策略（`locked` / `standard` / `open` / `yolo`）只读，引用为 `builtin:<name>`。自定义策略住在你自己的项目里，用安全相对路径引用（无 `..`、无绝对）。自定义形状的随包示例是 `packages/daemon/policies/examples/my-cautious-dev.policy.md`——拷进你项目按需编辑。

这记录的是一个选择，不是活的权限变更。标志面策略选启动标志；配置面策略仍需原生配置应用和检查。特别地，`builtin:yolo` 选 Codex 的 `danger-full-access` 沙箱和 `never` 审批策略，并替换任何 `codex_config_profile` 参数。见[实用权限选择](getting-started.md#opt-in-permissive-operation)。

一次显式的 `zrig seat set-permissions` 选择，对那个稳定席位未来的受管启动覆盖成员/工作组策略；它不改写本 spec 或其继承的策略来源。`inherit` 移除该覆盖。见[逐席位权限模式](getting-started.md#per-seat-permission-mode)。

### 选 Claude 指令文件

OpenRig 把给 Claude Code 成员的指令写进成员工作目录里的受管块。默认文件是 `CLAUDE.md`。如果你的仓库跟踪 `CLAUDE.md`，改写到 `CLAUDE.local.md`：

```yaml
managed_blocks:
  claude-code: CLAUDE.local.md
```

Claude Code 也从工作目录加载 `CLAUDE.local.md`。按惯例这个文件不进 git，比如加一条 `.gitignore`。

- 接受值是 `CLAUDE.md` 和 `CLAUDE.local.md`。任何其他值或运行时键在成员启动前被拒。
- 该设置适用于启动、恢复、重启、交接、加成员和导出。`zrig down` 只从选定文件移除 OpenRig 的块。
- OpenRig 绝不编辑、移动或删除另一个文件里的块。

一个已经把块写进 `CLAUDE.md` 的工作组，切换后块仍留在那里。在你移除它们之前，`CLAUDE.md` 保持被修改，Claude Code 加载两份。手工删每个 `<!-- BEGIN OpenRig MANAGED BLOCK: … -->` … `<!-- END OpenRig MANAGED BLOCK: … -->` 段，保留文件其余部分。如果 `CLAUDE.md` 没有其他你要保留的未提交改动，你可以跑 `git restore CLAUDE.md`；那条命令丢弃该文件所有未暂存改动，不只是 OpenRig 的块。对一个仍用默认的工作组跑 `zrig down` 不是替代：它剥掉该目录 `CLAUDE.md` 里所有 OpenRig 块，包括其他工作组写的块。

---

## Pod

| 字段 | 类型 | 必需 | 默认 | 描述 |
|-------|------|----------|---------|-------------|
| `id` | string | 是 | —— | pod 标识。不含点。工作组内唯一。用作会话名和逻辑 ID 的第一段。 |
| `label` | string | 是 | —— | 人类可读 pod 名。显示在 UI 资源管理器、图分组和详情界面。 |
| `summary` | string | 否 | —— | pod 描述。 |
| `continuity_policy` | ContinuityPolicy | 否 | —— | pod 级连续性/恢复策略。控制压缩恢复、产物管理和对等驱动恢复。 |
| `startup` | StartupBlock | 否 | —— | pod 级启动文件和动作。通过启动分层模型应用到本 pod 所有成员。 |
| `members` | Member[] | 是 | —— | 至少一个成员（由 pod 需要内容强制）。 |
| `edges` | PodLocalEdge[] | 否 | `[]` | 本 pod 内成员之间的边。必须用不限定的成员 ID（不是 `pod.member`）。 |

### Pod ID 规则

- 不含点（`.`）
- 工作组内所有 pod 间唯一
- 成为全限定逻辑 ID 的第一段：`{podId}.{memberId}`
- 成为规范会话名的第一段：`{podId}-{memberId}@{rigName}`

---

## Member

| 字段 | 类型 | 必需 | 默认 | 描述 |
|-------|------|----------|---------|-------------|
| `id` | string | 是 | —— | 成员标识。不含点。pod 内唯一。 |
| `agent_ref` | string | 是 | —— | 对一个 AgentSpec 的引用。必须以 `local:`（相对）或 `path:`（绝对）开头。例外：基础设施节点用 `builtin:terminal`。 |
| `profile` | string | 是 | —— | 引用 AgentSpec 里的 profile 名。默认 profile 用 `default`。例外：终端节点用 `none`。 |
| `codex_config_profile` | string | 否 | —— | 仅 Codex 的原生 profile，作为 `-p <name>` 传入；字母、数字、`_`、`.`、`-`。独立于 AgentSpec `profile`。正常启动模式下，它替换 OpenRig 显式 workspace-write 沙箱标志。全绕过策略则改发 danger-full-access 并省略本 profile 参数。 |
| `runtime` | string | 是 | —— | 智能体运行时。当前支持值：`claude-code`、`codex`、`terminal`。 |
| `cwd` | string | 是 | —— | 智能体工作目录。相对工作组根（含工作组 spec 的目录）解析。工作组根本身用 `"."`。启动时可用 `zrig up --cwd` 覆盖。 |
| `label` | string | 否 | —— | 人类可读成员名。在场时显示在 UI。 |
| `model` | string | 否 | —— | 模型覆盖。运行时特定（如 Claude Code 用 `claude-opus-4-6`）。 |
| `restore_policy` | string | 否 | `resume_if_possible` | 恢复行为。之一：`resume_if_possible`、`relaunch_fresh`、`checkpoint_only`。 |
| `startup` | StartupBlock | 否 | —— | 成员级启动文件和动作。只应用于本成员。 |

### 终端节点

终端节点是基础设施进程（服务器、日志 tail、构建 watcher），不是智能体运行时。它们需要确切三件套：

```yaml
runtime: terminal
agent_ref: "builtin:terminal"
profile: none
```

三者必须同时在场。任何部分组合都是校验错误。

### agent_ref 规则

- 必须以 `local:` 或 `path:` 开头
- `local:` 路径相对工作组 spec 文件目录（工作组根）
- `path:` 路径是绝对文件系统路径
- 引用路径必须含一个 `agent.yaml` 文件
- 例外：终端节点用 `builtin:terminal`

### 会话命名

规范会话名由 pod ID、成员 ID 和工作组名派生：

```
{podId}-{memberId}@{rigName}
```

示例：pod `dev`、成员 `impl`、工作组 `my-team` → 会话 `dev-impl@my-team`

这是人写的（你选 pod/成员 ID）、系统校验的（系统强制格式）。

---

## 边

### 边种类

| 种类 | 含义 | 何时用 |
|------|---------|----------|
| `delegates_to` | 源把工作委派给目标。约束启动顺序。 | 编排者→实现者、首席→工人 |
| `spawned_by` | 目标由源 spawn。约束启动顺序。 | 层级拓扑里父→子 |
| `can_observe` | 源可观察目标输出。**不**约束启动顺序。 | 评审者→实现者、监控→工人 |
| `collaborates_with` | 对等协作。**不**约束启动顺序。 | 并肩工作的平等同伴 |
| `escalates_to` | 源就决定上报给目标。**不**约束启动顺序。 | 工人→首席上报 |

### pod 内边

pod 内的边用**不限定成员 ID**（只写成员 `id`，不写 `pod.member`）：

```yaml
pods:
  - id: dev
    members:
      - id: impl
        # ...
      - id: qa
        # ...
    edges:
      - kind: delegates_to
        from: impl      # 不是 dev.impl
        to: qa          # 不是 dev.qa
```

`from` 和 `to` 都必须引用同 pod 内存在的成员。

### 跨 pod 边

pod 之间的边用**全限定 `pod.member` ID**：

```yaml
edges:
  - kind: delegates_to
    from: orch.lead     # pod.member 格式
    to: dev.impl        # pod.member 格式
```

跨 pod 边必须引用不同 pod。一条 `from` 和 `to` 同 pod 的边是校验错误——改用 pod 内边。

---

## 启动块

启动块可出现在三层：工作组、pod、成员。它们通过启动分层模型增量合并（见 `docs/reference/startup-layering.md`）。

### 文件

| 字段 | 类型 | 必需 | 默认 | 描述 |
|-------|------|----------|---------|-------------|
| `path` | string | 是 | —— | 文件相对路径。必须是安全相对路径。 |
| `delivery_hint` | string | 否 | `auto` | 文件如何投递。之一：`auto`、`guidance_merge`、`skill_install`、`send_text`。 |
| `required` | boolean | 否 | `true` | 本文件投递不了时启动是否失败。 |
| `applies_on` | string[] | 否 | `[fresh_start, restore]` | 本文件何时投递。子集：`fresh_start`、`restore`。 |

#### 投递提示

| 提示 | 行为 |
|------|----------|
| `auto` | 系统按文件类型和上下文选。 |
| `guidance_merge` | 作为受管块合并进运行时的指引文件（`CLAUDE.md` 或 `AGENTS.md`）。在运行框架 boot 前投递。 |
| `skill_install` | 作为 skill 装进运行时的 skill 目录。在运行框架 boot 前投递。 |
| `send_text` | 运行框架就绪后作为文本发到智能体终端。需要智能体 TUI 活跃。 |

### 动作

| 字段 | 类型 | 必需 | 默认 | 描述 |
|-------|------|----------|---------|-------------|
| `type` | string | 是 | —— | 动作类型。之一：`slash_command`、`send_text`、`startup_proof`。注意：v1 明确**不**支持 `shell`。 |
| `value` | string | 是 | —— | 要发的命令/文本，或 `startup_proof` 用 `authenticated` / `none`。 |
| `phase` | string | 否 | `after_files` | 何时执行文本/命令。之一：`after_files`（启动文件投递后）、`after_ready`（运行框架就绪检查过后）。无论哪个 phase，证明选择都在投影前解析。 |
| `idempotent` | boolean | 是 | —— | 本动作在恢复时重放是否安全。**必填字段。** 非幂等动作的 `applies_on` 绝不能含 `restore`。 |
| `applies_on` | string[] | 否 | `[fresh_start, restore]` | 本动作何时跑。子集：`fresh_start`、`restore`。 |

### 启动证明选择

启动默认不加定向练习。要选认证启动挑战，在一个智能体、profile、工作组、pod、成员或操作员启动块里声明一个动作：

```yaml
startup:
  actions:
    - type: startup_proof
      value: authenticated
      idempotent: true
```

在更后一层用 `value: none` 显选精简启动。按 智能体 → profile → 工作组 → pod → 成员 → 操作员 顺序，最后适用的声明赢。文化贡献文件，不贡献证明选择。没有适用声明时结果为 `none`；启动文件数量从不选择证明。无效值和非幂等证明声明校验失败，包括被后来覆盖的声明。这些动作声明策略，绝不打进终端。

一个认证选择只挑战一次全新或全新回退的受管智能体启动。恢复、fork、重建和接纳的会话不收到新挑战；终端节点永不收。`applies_on` 跟随请求的启动上下文，所以恢复期间的全新回退用 `restore` 选择。保留默认 `[fresh_start, restore]` 覆盖两条全新启动路径。

身份投递、投影、就绪和普通启动动作仍跑。`startup_status: ready` 表示启动完成，而 `oriented: missing` 表示一个选定证明等待认证提交。省略/`none` 在一次新的全新启动上产出 `oriented: n-a`，并让旧挑战退役而不删其审计历史。退役在成功运行框架启动后、就绪检查前，好让注意力、超时或就绪异常保留不住前一个证明。一个启动失败的替代者不退役当前证明；恢复/接纳也保留既有证明历史。生效选择记在 `node.startup_pending`；动作持久化在启动上下文里，供恢复和全新重启用。

---

## 服务块

服务块可选。在场时，服务在任何智能体节点启动前 boot。服务健康检查失败则阻断智能体启动。

| 字段 | 类型 | 必需 | 默认 | 描述 |
|-------|------|----------|---------|-------------|
| `kind` | string | 是 | —— | 服务后端。v1 只支持 `compose`。 |
| `compose_file` | string | 是 | —— | Docker Compose 文件相对路径。必须安全相对路径。相对工作组根解析。 |
| `project_name` | string | 否 | 从工作组名派生 | Docker Compose 项目名。必须匹配 `[a-z0-9][a-z0-9_-]*`。省略则由清洗工作组名派生。 |
| `profiles` | string[] | 否 | —— | 要激活的 Compose profile。 |
| `down_policy` | string | 否 | `down` | `zrig down` 时怎么办。之一：`leave_running`、`down`、`down_and_volumes`。 |
| `wait_for` | WaitTarget[] | 否 | —— | 智能体启动前必须通过的健康目标。 |
| `surfaces` | Surfaces | 否 | —— | 可访问 URL 和命令的元数据。不执行——仅供信息。 |
| `checkpoints` | CheckpointHook[] | 否 | —— | 快照/恢复期间做检查点导出/导入的 shell 命令。 |

### 等待目标

每个目标必须恰定义 `service`、`url` 或 `tcp` 之一：

```yaml
wait_for:
  # HTTP 探测 —— 打 URL，期望 2xx
  - url: http://127.0.0.1:8200/v1/sys/health

  # TCP 探测 —— 连 host:port
  - tcp: "127.0.0.1:5432"

  # Compose 健康检查 —— 要求 Docker 健康报 "healthy"
  - service: postgres
    condition: healthy
```

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `url` | string | 三者之一 | 探测的 HTTP URL。 |
| `tcp` | string | 三者之一 | TCP 探测的 `host:port`。 |
| `service` | string | 三者之一 | Compose 服务名。需要 `condition: healthy`。 |
| `condition` | string | 仅随 `service` | 必须为 `healthy`。仅对 `service` 目标合法。 |

### 界面

```yaml
surfaces:
  urls:
    - name: Vault UI
      url: http://127.0.0.1:8200/ui
  commands:
    - name: Vault status
      command: "vault status -address=http://127.0.0.1:8200"
```

界面只是元数据。它们显示在 UI 和 `zrig env status` 输出里，但 OpenRig **不**执行它们。

### 检查点钩子

```yaml
checkpoints:
  - id: postgres
    export: "docker compose exec -T postgres pg_dump -U app > {{artifacts_dir}}/postgres.sql"
    import: "cat {{artifacts_dir}}/postgres.sql | docker compose exec -T postgres psql -U app"
```

| 字段 | 类型 | 必需 | 描述 |
|-------|------|----------|-------------|
| `id` | string | 是 | 本检查点唯一标识。 |
| `export` | string | 是 | 导出状态的 shell 命令。`{{artifacts_dir}}` 替换为 daemon 管理路径。 |
| `import` | string | 否 | 恢复时导入状态的 shell 命令。 |

检查点钩子是 daemon 跑的 shell 命令。它们尽力而为——导出失败不阻断快照，但连续性被归类为 `receipt_only` 而非 `checkpointed`。

---

## 连续性策略

可选的 pod 级配置，控制压缩恢复行为。

```yaml
continuity_policy:
  enabled: true
  sync_triggers: [pre_compaction, pre_shutdown, manual, milestone]
  artifacts:
    session_log: true
    restore_brief: true
    quiz: false
  restore_protocol:
    peer_driven: true
    verify_via_quiz: false
```

| 字段 | 类型 | 必需 | 默认 | 描述 |
|-------|------|----------|---------|-------------|
| `enabled` | boolean | 是 | —— | 本 pod 连续性是否激活。 |
| `sync_triggers` | string[] | 否 | —— | 何时同步。值：`pre_compaction`、`pre_shutdown`、`manual`、`milestone`。 |
| `artifacts.session_log` | boolean | 否 | —— | 是否维护会话日志。 |
| `artifacts.restore_brief` | boolean | 否 | —— | 是否维护恢复简报。 |
| `artifacts.quiz` | boolean | 否 | —— | 是否用 quiz 校验。 |
| `restore_protocol.peer_driven` | boolean | 否 | —— | 对等方是否驱动恢复过程。 |
| `restore_protocol.verify_via_quiz` | boolean | 否 | —— | 是否通过 quiz 验证恢复。 |

---

## 校验规则汇总

这些规则由校验器强制。违反任一条的 spec 会被 `zrig spec validate` 和 `zrig up` 拒绝。

1. `version` 和 `name` 必填非空字符串。
2. `pods` 必须是非空数组。
3. pod ID 不含点，且唯一。
4. pod label 必填。
5. 成员 ID 不含点，且 pod 内唯一。
6. 每个成员必填 `agent_ref`、`profile`、`runtime`、`cwd`。
7. 终端节点要求确切三件套：`runtime: terminal`、`agent_ref: builtin:terminal`、`profile: none`。
8. `agent_ref` 必须以 `local:`（相对）或 `path:`（绝对）开头，`builtin:terminal` 除外。
9. `local:` ref 必须是相对路径。`path:` ref 必须是绝对路径。
10. `restore_policy` 必须是：`resume_if_possible`、`relaunch_fresh`、`checkpoint_only`。
11. pod 内边用不限定成员 ID。跨 pod 边用 `pod.member` 格式。
12. 跨 pod 边必须引用不同 pod。
13. 边种类必须是：`delegates_to`、`spawned_by`、`can_observe`、`collaborates_with`、`escalates_to`。
14. 所有文件路径（`culture_file`、启动文件路径、`compose_file`）必须是安全相对路径。
15. `services.kind` 必须为 `compose`。
16. 有 services 时 `services.compose_file` 必填。
17. `services.project_name` 必须匹配 `[a-z0-9][a-z0-9_-]*`。
18. `services.down_policy` 必须是：`leave_running`、`down`、`down_and_volumes`。
19. 每个等待目标必须恰定义：`service`、`url`、`tcp` 之一。
20. `condition` 只对 `service` 目标合法，且必须为 `healthy`。
21. 启动文件 `delivery_hint` 必须是：`auto`、`guidance_merge`、`skill_install`、`send_text`。
22. 启动动作 `type` 必须是：`slash_command`、`send_text`、`startup_proof`（`shell` 明确拒绝）。证明选择要求 `value: authenticated` 或 `none` 且 `idempotent: true`。
23. 启动动作 `phase` 必须是：`after_files`、`after_ready`。
24. 启动动作 `idempotent` 必填布尔。
25. 非幂等动作的 `applies_on` 不得含 `restore`。
26. `applies_on` 值必须来自：`fresh_start`、`restore`。

---

## 随包示例

这些是 OpenRig 自带的内置 spec。当作完整示例读。

| Spec | 位置 | pod | 成员 | 服务 |
|------|----------|------|---------|----------|
| `product-team` | `packages/daemon/specs/rigs/preview/product-team/rig.yaml` | orch1, dev1, rev1 | 7（lead、peer、impl、qa、design、r1、r2） | 无 |
| `implementation-pair` | `packages/daemon/specs/rigs/launch/implementation-pair/rig.yaml` | dev | 2（impl、qa） | 无 |
| `adversarial-review` | `packages/daemon/specs/rigs/focused/adversarial-review/rig.yaml` | orch、review | 3（lead、r1、r2） | 无 |
| `research-team` | `packages/daemon/specs/rigs/focused/research-team/rig.yaml` | orch、research | 3（lead、analyst、synthesizer） | 无 |
| `secrets-manager` | `packages/daemon/specs/rigs/launch/secrets-manager/rig.yaml` | vault | 1（specialist） | 有（Vault） |
