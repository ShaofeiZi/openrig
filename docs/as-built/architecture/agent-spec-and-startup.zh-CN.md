---
kind: as-built
title: Agent/Rig Spec、解析、启动、身份
status: active
topics: [specification-and-bundles, agent-runtime]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  需要了解规范的 AgentSpec/RigSpec/pod 感知重启类型、profile 解析与叠加式启动分层
  如何工作、StartupOrchestrator 启动前 vs 交互式交付拆分，或 whoami/materialize/bind/adopt
  如何解析并保留身份。
siblings: [daemon-core.md, adapters-and-runtimes.md, lifecycle-snapshot-restore.md, packaging-bootstrap-bundles.md]
prerequisite-reads: [../README.md, daemon-core.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# Agent/Rig Spec、解析、启动、身份

后台服务如何把作者撰写的 YAML spec 变成一个已解析、已投影、已启动且可按身份寻址的拓扑。spec-启动契约：parse → resolve → project → deliver → launch → wait → persist replay context。

> 已对照 HEAD `7eaf524c`（`git describe` → `v0.3.1-6-g7eaf524c`）核验。三个包版本均为 **0.3.1**（slice-00 §1.1）。源码入口按 `architecture.md` 标题（§4 规范重启类型、§5 领域服务、§6 执行流、§7 架构规则）定位，依 slice-08 §10.1——行号仅供参考。

## 1. 规范 spec 与拓扑类型

（`architecture.md` §4“Spec and topology”）

- **AgentSpec** —— 从 `agent.yaml` 解析。拥有 imports、defaults、startup、resources 与 profiles。规范 parse/normalize/validate 在 `domain/agent-manifest.ts`。
- **RigSpec** —— 规范的 pod 感知 rig 拓扑。使用 `version: "0.2"` 与 `pods[]`；拥有跨 pod `edges[]`、rig 级 startup 覆盖与 `cultureFile`。

  > Drift-fix D-spec-version —— `architecture.md` §4 称 RigSpec“使用 `version: "0.2"`”。这是 **spec-schema 版本，不是包版本**——与 0.3.1 包版本是不同的版本轴。该值不是代码常量：`rigspec-schema.ts:52` 仅把 `version` 校验为“必填非空字符串”（`if (!obj["version"] || typeof obj["version"] !== "string")`）；`:163` 以 `raw["version"] as string` 透传。`"0.2"` 是规范的作者撰写值，正确描述为 schema 轴。不要把它“改”成 0.3.1（slice-08 §4.6 绑定）。已在 `rigspec-schema.ts:52,163` @HEAD 重新确认。

- **RigServicesSpec** —— pod 感知 RigSpec 上可选的 `services` 块。交付形态是 Compose 后端的环境管理，带 `composeFile`、`projectName?`、`profiles?`、`downPolicy?`、`waitFor?`、`surfaces?`、`checkpoints?`。
- **RigSpecPod** —— pod 本地有界上下文，带 `members[]`、pod 本地 `edges[]`、pod startup、可选 continuity 策略。
- **RigSpecPodMember** —— 成员级运行时/启动表面：`agentRef`、`profile`、`runtime`、`model?`、`cwd`、`restorePolicy?`、成员 startup 覆盖。
- **Pod** —— 一个 pod 的持久化 DB 实体。
- **ContinuityState** —— 以 `podId + nodeId` 为键的持久化实时 continuity 行。

## 2. 执行与投影类型

（`architecture.md` §4“Execution and restore”——restore/snapshot 成员详见 `lifecycle-snapshot-restore.md`；spec/投影成员在此）

- **ResolvedNodeConfig** —— profile 解析的输出。携带生效的 runtime/model/cwd、收窄后的 restore 策略、所选资源、分层启动块、已解析的 spec 身份。
- **ProjectionPlan** —— 一个节点的运行时投影计划：runtime、cwd、投影条目、启动块、诊断、冲突/no-op 分类。
- **RuntimeAdapter** —— 五方法契约（适配器细节见 `adapters-and-runtimes.md`）：`listInstalled(binding)`（`runtime-adapter.ts:131`）、`project(plan, binding)`（`:134`）、`deliverStartup(files, binding)`（`:137`）、`launchHarness(binding, opts)`（`:147`）、`checkReady(binding)`（`:153`）。已 @HEAD 重新确认——契约为当前。
- **HarnessLaunchResult** —— `launchHarness` 返回的 `{ ok, resumeToken?, resumeType?, error? }`。
- **StartupOrchestrator** —— 驱动完整启动序列（见下文 §4）。

## 3. 解析、校验、解析流水线

（`architecture.md` §5“Parsing and validation”+“Resolution pipeline”；全部位于 `packages/daemon/src/domain/`，依架构规则 1 零 Hono 导入）

**Parse / validate：**

- `agent-manifest.ts` —— 规范 AgentSpec parse/normalize/validate。
- `rigspec-schema.ts` —— 双格式 RigSpec 校验。
- `rigspec-codec.ts` —— 双格式 YAML codec。
- `startup-validation.ts` —— 共享启动块校验。
- `path-safety.ts` —— 共享相对路径安全检查。
- `spec-validation-service.ts` —— 纯 raw-YAML 校验辅助。
- `spec-review-service.ts` —— 后台服务自有的 RigSpec/AgentSpec YAML 结构化评审模型，含拓扑预览、来源状态、managed-app 服务元数据（`waitFor`、`surfaces`、`composePreview`）。

**Resolve：**

- `agent-resolver.ts` —— 解析 `agent_ref`、imports、冲突元数据。
- `agent-preflight.ts` —— 单智能体解析/preflight。
- `profile-resolver.ts` —— 应用 defaults、profile uses、资源选择、启动分层、restore 策略收窄。
- `startup-resolver.ts` —— 叠加式启动分层。
- `projection-planner.ts` —— 运行时资源投影规划。

全部 11 个文件已 @HEAD 重新确认存在于 `packages/daemon/src/domain/`。

## 4. 启动编排（spec-启动契约）

（`architecture.md` §4“StartupOrchestrator”+ §5“Startup, runtime, and instantiation”+ §7 架构规则 6）

`StartupOrchestrator`（`domain/startup-orchestrator.ts`）驱动：标记 pending → 投影资源 → 交付启动前文件 → 启动 harness → 等待就绪 → 交付交互式文件 → 执行动作 → 持久化 context → 标记 ready。

**启动前 vs 交互式交付拆分**——承重接缝，已在源码处重新确认：

- 启动前（文件系统，harness 启动前）：`guidance_merge`、`skill_install`（`startup-orchestrator.ts:78,167`——“交付启动前文件（guidance_merge, skill_install → 文件系统）”）。
- 启动后（TUI，harness 就绪后）：`send_text`（`startup-orchestrator.ts:82,160,263`——在 `:141` 按具体 hint 分区，在 `:263` 就绪后交付）。

orchestrator 持久化 replay context（含 resume 令牌）供未来恢复使用（由 `lifecycle-snapshot-restore.md` 消费）。

**架构规则 6 —— 启动分层是叠加且有序的**（逐字照搬，`architecture.md` §7）：(1) agent 基座、(2) profile、(3) rig culture 文件、(4) rig startup、(5) pod startup、(6) member startup、(7) 操作者调试追加。这是 spec-启动契约的不变量；完整 25 条规则清单见 `architecture-rules-and-event-system.md`。

**启动动作约束**（`architecture.md` §7“Current startup action constraints”）：无 shell 启动动作；动作类型仅 `slash_command` 与 `send_text`；非幂等动作不得在 restore 时应用；重试失败启动按 restore 处理。

**远端 import 约束**（§7）：重启支持 `local:...` 与 `path:/abs/...`。远端 `agent_ref` 源仍不支持，在 preflight 失败。

## 5. 实例化、preflight、导出

（`architecture.md` §5“Startup, runtime, and instantiation”+ §6“RigSpec import / validate / preflight / export”）

- `runtime-adapter.ts` —— 适配器契约 + 桥接类型。
- `rigspec-preflight.ts` —— 双栈旧版 preflight 加重启后的 `rigPreflight(...)`。
- `rigspec-instantiator.ts` —— 双栈 `RigInstantiator` 加 `PodRigInstantiator`。
- `rigspec-exporter.ts` —— 双格式 live rig 导出为 YAML/JSON。
- `pod-repository.ts` —— pod CRUD 加 live continuity-state CRUD。

`routes/rigspec.ts` 是双格式接缝：校验（pod 感知 → `RigSpecSchema.validate`；旧版 → `LegacyRigSpecSchema.validate`）、preflight（`rigPreflight({ rigSpecYaml, rigRoot, fsOps })` 对 `RigSpecPreflight.check(spec)`）、import（`podInstantiator.instantiate(yaml, rigRoot)` 对 `RigInstantiator.instantiate(spec)`）、导出（pod 感知导出规范 `version: "0.2"` RigSpec；旧版导出扁平节点 v1）。

## 6. 身份：whoami、materialize、bind、adopt

（`architecture.md` §6“Whoami and adopted-session parity flow”+“Materialize / bind / adopt flow”）

**Whoami 解析**——后台服务通过 `/api/whoami`（`routes/whoami.ts`）拥有真理表面；tmux 元数据是 adopted-session 锚点，而非主权真理。`whoami-service.ts:8` 声明 `resolvedBy: "node_id" | "session_name"`。路由要求 `nodeId` 或 `sessionName`（`routes/whoami.ts:10-15`）。解析顺序：显式 `--node-id` → 显式 `--session` → 环境变量 → tmux 元数据 → 裸 tmux session-name 兜底。

- 托管会话优先使用投影的 `OPENRIG_NODE_ID` / `OPENRIG_SESSION_NAME`。
- adopted 会话使用 claim/bind 时写入的 tmux 自有元数据。

  > Drift-nuance D5（需谨慎的轴——另见 `transport-and-transcripts.md`）：`architecture.md` §6 中的 tmux 元数据键 `@rigged_node_id` / `@rigged_session_name` / `@rigged_rig_id` / `@rigged_rig_name` / `@rigged_logical_id` **原样正确**，并在源码逐字核验——`claim-service.ts:77-81` 恰写入这些 `@rigged_*` 键；`claim-service.ts` 与 `rig-lifecycle-service.ts` 读取它们。这是与 MCP 工具名（为 `rig_*`，slice-00 §1.4）**不同的轴**。不要把 `rigged`  blanket 替换为 `rig`（已存档 `feedback_release_prep_three_layer_depersonalization`：重命名是有范围的，非全局）。tmux 元数据键未被重命名。已在 `claim-service.ts:77-81` @HEAD 重新确认。

**Materialize / bind / adopt**（`architecture.md` §6）：`POST /api/rigs/import/materialize` 创建 pod 感知拓扑但不启动会话；`POST /api/discovery/:id/bind` 把一个已发现的 live 会话挂到既有逻辑节点；`POST /api/discovery/:id/adopt` 是组合路由（绑到既有节点，或在目标 pod 中创建新成员并立即绑定）。CLI 经 `rig bind` / `rig adopt` 对应。作者撰写的 pod 命名空间在 adopt 中保留，故逻辑 id 保持 `${podNamespace}.${memberName}`（架构规则 24：adopted-session 对等是 tmux 元数据对等，而非伪造的环境变量对等）。

## OPEN / 遗留项

- **D-spec-version（判定为正确）：** RigSpec `version: "0.2"` 是 spec-schema 轴，在源码中仅校验为非空字符串。已记录，不“更正”。
- **D5（需谨慎，本模块判定为正确）：** tmux `@rigged_*` 元数据键在 HEAD 逐字仍是 `@rigged_*`——architecture.md §6 准确。MCP 工具名 `rigged_*` 漂移落在 `transport-and-transcripts.md`。

## 另见

- `daemon-core.md` —— createDaemon 接线；迁移/路由表面。
- `adapters-and-runtimes.md` —— 五方法 RuntimeAdapter 契约细节。
- `lifecycle-snapshot-restore.md` —— snapshot/restore 消费持久化的 replay context。
- `architecture-rules-and-event-system.md` —— 完整 25 条架构规则。
- 源码根：`packages/daemon/src/domain/{agent-manifest,rigspec-schema,profile-resolver,startup-orchestrator,whoami-service,claim-service}.ts`、`packages/daemon/src/routes/{rigspec,whoami}.ts`。
