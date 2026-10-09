---
name: session-source-fork
description: |
  用于编写需要从此前运行时对话来源启动新受管席位的工作组规格成员或 `rig expand` payload——`session_source: { mode: fork, ref: { kind, value } }`。v1 为 Claude 与 Codex 支持 `mode: fork` 和 `ref.kind: native_id`。新席位持久保存一个全新的 fork 后 token；父 token 绝不会写入新席位。不要用于恢复现有席位或基于产物重建心智模型。
metadata:
  openrig:
    stage: factory-approved
    sibling_skills:
      - claude-compaction-restore
      - mental-model-ha
      - scope-recovery
      - session-compaction-and-restore
      - agent-startup-and-context-ingestion
      - agent-starters
      - composable-priming-packs
      - seat-continuity-and-handover
      - claude-compact-in-place
      - pre-maintenance-agent-preservation
---

# session_source Fork

`session_source` 是一个**工作组成员级 zrig 字段**，声明新启动的受管席位应如何从先前运行时对话来源获得初始对话连续性。

v1 支持一种模式：**`fork`**——从先前的原生运行时对话来源启动一个*新的*受管席位，但不声称原席位得以延续。

Schema 与运行时无关；实现则因运行时而异（Claude 与 Codex 使用各自的原生 fork 命令）。

## 何时使用

- 编写应从先前会话 fork 的工作组规格成员。
- 编写包含 `session_source` 的 `zrig expand` payload。
- 为新席位选择 `fork`、`rebuild`、`resume` 或 `fresh` 时进行判断。
- 组合 fork 与交接（seat-handover-over-fork）——参见 `seat-continuity-and-handover` Skill。

## 何时不使用

- 席位正在被**恢复**而非创建时。Restore 延续已有受管席位；fork 创建新席位。
- 连续性来自**基于产物的心智模型重建**时（从数据包推导理解，而非原生运行时连续性）。请使用 `mode: rebuild`（重建界面见 `seat-continuity-and-handover`）——不要把 fork 与基于产物的重新进入合并；这一区别不可或缺。
- 运行时是 `terminal` 时。Terminal 运行时拒绝 `session_source`。

## 结构（规范 YAML）

```yaml
members:
  - id: reviewer-2
    runtime: claude-code        # 或 "codex"；terminal 不支持
    agent_ref: specs/agents/reviewer.yaml
    profile: reviewer
    cwd: .
    session_source:
      mode: fork
      ref:
        kind: native_id          # v1 fork 模式只支持 native_id
        value: "0b0165d7-cb4d-4650-90de-15c0a1ede9e6"
```

规则：

- v1 中 `mode` 唯一有效值为 `fork`。
- v1 中 `ref.kind` 只支持 `native_id`。Schema 会在启动前拒绝 `artifact_path`、`name`、`last` 和 `artifact_set`，并明确说明延后/较弱/模式错误（见 `packages/daemon/src/domain/rigspec-schema.ts` 的 validateSessionSourceFork）。Adapter 层也有防御性拒绝，但由于 schema 先拒绝，v1 中不应到达该层。
- v1 中 `ref.kind: native_id` 必须提供 `value`（这是 schema 唯一接受的 kind）。`artifact_path` / `name` / `last` 的未来值语义尚未在 v1 启用，因为这些 kind 会在启动前被 schema 拒绝。
- `zrig expand` 接受相同结构，因此动态添加的成员也能携带会话来源归属。

此原语**不会**引入新的顶层命令。它通过现有工作组规格与扩展路径流转。

## 状态模型

`session_source` 是**启动时输入**，不是长期有状态字段：

1. **Declared**——存在于成员配置或扩展 payload 中。
2. **Resolved**——启动时，zrig 根据运行时解析 `ref`。
3. **Realized**——运行时 fork 成功；新受管席位获得一个**全新**原生连续性 token（Claude session id 或 Codex thread id）。zrig 持久保存这个新 token。**父 token 绝不会写入新席位。**
4. **Failed**——解析或 fork 失败；席位未以 fork 方式启动；清晰错误会指出失败的解析步骤。

实现后，`session_source` 实际上成为历史。之后恢复该席位，是对新席位执行 `restore`，而不是再次从父会话 fork。

## 五种失败模式

1. **找不到源会话 ID**——运行时无法解析 `native_id`。**行动：**发出包含运行时和缺失 ID 的错误；绝不要静默全新启动。（未来说明：后续切片支持 `artifact_path` 后，它可以成为 Claude 的候选后备；v1 schema 会在启动前拒绝 `artifact_path`，因此不存在后备路径。）
2. **源产物路径缺失**（不属于 v1 范围）——在 `ref.kind: artifact_path` 被 schema 接受后才适用。v1 schema 会在启动前拒绝此 kind。
3. **不受支持的运行时/kind 组合**（v1 中大多被 schema 预先拒绝）——schema 会提前拒绝所有非 `native_id` kind。Adapter 层的防御性拒绝仍然存在，但 v1 不会到达。
4. **解析来源后 fork 启动失败**——运行时命令（`claude --resume <parent> --fork-session` 或 `codex fork <id>`）返回非零或挂起。保留运行时 stderr；不要将新席位记录为已启动；不要把父 token 写入席位。
5. **持久化不一致**——fork 成功，但席位 token 持久化无法记录新的连续性 token。**内部失败：**只有新 token 已持久写入后，席位才可视为已启动。

## 诚实 UX 规则（原义要求）

此原语绝不能报告“恢复了原智能体”“继续了原席位”或“快照”。正确表述是**“从源会话 fork”** / **“从先前对话来源启动”**。

检查实际用户结果和持久身份；仅凭措辞不能证明已经创建预期连续性。

## 硬边界（禁止事项；原义要求）

- **不要引入分叉的 fork 原语。** 此原语应通过现有 spec/扩展路径流转。（2026-08-07 更新：此后已交付 `zrig fork <source-session>`，作为组合现有 agent-image fork 路径的轻量便捷动词——它遵守此边界，不是分叉原语。当前规则是：不得在 spec / 扩展 / agent-image 路径外增加新的 fork 机制。）
- **任何 UX 界面都不得报告“restored”“resumed the original seat”或“snapshot”。**
- **不要把 `session_source` 与 AgentSpec 耦合。** 它是成员级启动时输入。
- **不要改变 `restore` 语义。** `session_source` 创建席位；`restore` 延续已有受管席位。

## Adapter 命令结构（已交付 v1）

| 运行时 | 命令结构 |
|---|---|
| Claude（`mode: fork` + `ref.kind: native_id`） | `claude --resume <parent-id> --fork-session` |
| Codex（`mode: fork` + `ref.kind: native_id`） | `codex... fork <parent-id>` |
| Terminal | 在 schema 层拒绝 |

后台服务在三层强制 `resumeToken`（restore 路径）与 `forkSource`（fork 路径）互斥。

## 连续性结果字面值

| 结果 | 适用情形 |
|---|---|
| `forked` | Fork 成功；新席位拥有新原生 token；父 token 从未写入新席位 |
| `fresh` | 全新启动（未声明 `session_source`） |
| `resumed` | 恢复已有受管席位 |
| `failed` | 解析或 fork 失败 |

对于 `seat handover over fork` 组合，绑定结果彼此独立（见 `seat-continuity-and-handover` Skill）。

## 验证运行中的实现

源代码 checkout 与运行中的后台服务可能包含不同实现。在执行已授权 fork 前，应检查目标后台服务的构建身份以及对所请求来源的支持。源代码或隔离测试只能证明对应切点的行为，不能证明实时运行时正在使用它。

记录真实父历史、新席位身份、新连续性 token 和独立绑定结果。保留错误与不完整结果，不要把全新启动或恢复原席位报告为成功 fork。这些检查不会赋予启动、替换或退役实时席位的权限。

## 当前已交付（v1）与延后项

zrig `c7b6df1`（2026-04-30）已交付：

- 完整 Honest Refusal Matrix 的 schema 接受/拒绝。
- Codec roundtrip（serialize → parse → normalize 如实保留 `session_source`）。
- 经 `zrig expand` member-input 的扩展路径。
- Claude + Codex `native_id` 的 Adapter 命令结构。
- 持久化诚实性（席位的 `resume_token` 是 fork 后的新 token；绝不写入父 token）。
- 诚实 UX 字面值契约（`continuityOutcome: forked`）。

延后：

- Claude `artifact_path` 模式（schema 当前以延后消息拒绝）。
- 来源列（供可查询 RSI 消费者使用的 `parent_native_id` / `created_via`）。
- 跨主机 fork（来源在主机 A，新席位在主机 B）——依赖 `cross-host-rig-commands`。

## 另请参阅

- `seat-continuity-and-handover` Skill——同级占用者创建原语（resume / fork / rebuild / fresh）与席位绑定（handover 可与 fork 组合）。
- `agent-starters` Skill——把 session_source fork 组合为具名、可复用启动点。
- `cross-host-rig-commands` Skill——多主机 fork（延后）。
