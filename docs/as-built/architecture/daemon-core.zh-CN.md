---
kind: as-built
title: 后台服务核心 —— 接线、DB、迁移、启动
status: active
topics: [runtime-control, observability]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  需要了解后台服务如何启动、createDaemon 如何接依赖图、SQLite schema/迁移集，
  或路由挂载表面。
siblings: [coordination-primitive.md, agent-spec-and-startup.md, lifecycle-snapshot-restore.md]
prerequisite-reads: [../README.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# 后台服务核心 —— 接线、DB、迁移、启动

OpenRig 是面向多智能体编码拓扑的本地控制平面。后台服务（`@openrig/daemon`）是无框架、以 SQLite 为后端的内核，CLI（`@openrig/cli`）、UI（`@openrig/ui`）与 MCP 服务器都坐在它之上。

> 已对照 HEAD `7eaf524c`（`git describe` → `v0.3.1-6-g7eaf524c`）核验。当前包版本在三个包均为 **0.3.1**（`package.json` 根 `"version": "0.3.1"`；slice-00 §1.1）。HEAD 携带 6 个未发布的 release-0.3.2 提交；不存在 `v0.3.2` 标签。

## 1. 系统概览

系统有六层架构（`architecture.md` §1 L23–30）：

1. **AgentSpec / pod 感知内核** —— spec 解析、解析、优先级、启动编排、快照/恢复、bundle。
2. **操作者与拓扑层** —— harness 自动启动、节点清单、会话命名、基础设施节点、Explorer UI、既有 rig 上电、自动快照、命令后交接。
3. **通信与历史层** —— 转录捕获（pipe-pane）、通信原语（send/capture/broadcast）、配置/preflight、`rig ask` 上下文包、持久化 rig 聊天。
4. **撰写与身份层** —— spec 评审 + spec 库、`whoami`、adopted-session tmux 元数据对等、bind/materialize/adopt 工作流。
5. **Rig 环境层** —— rig 作用域服务记录、Compose 后端服务编排、就绪门、env 快照/恢复集成。
6. **智能体托管软件层** —— managed-app 分类、面向应用的浏览/评审/运行时 UI，以及规范的 `secrets-manager` 示例。

旧版扁平节点/包流程为向后兼容保留。

### HEAD `7eaf524c` 处已核验源码足迹

> Drift-fix D1/D6 —— `architecture.md` L6,11 称 `OpenRig v0.2.0` / “当前 v0.2.0 发布核验”，L7 称 `376` 个源文件。二者都是 v0.2.0 之前时代的冻结头（slice-00 §1.9——最后编辑 `72982bb2`，2026-03-30）。更正为下列值。

| 指标 | HEAD 处值 | 来源（独立重新确认） |
|---|---|---|
| 包版本 | **0.3.1**（HEAD +6 个未发布 0.3.2 提交） | slice-00 §1.1；`package.json:version` |
| 总源码足迹 | **601** 文件 | slice-00 §1.6；`find packages/*/src` 非测试 = 279+87+235 |
| 后台服务足迹 | **279** 总 / **173** domain / **49** 路由挂载（46 个路由文件）/ **11** 适配器 / **40** 迁移 | slice-00 §1.5/§1.6；`find packages/daemon/src` 非测试 |
| CLI 足迹 | **87** 文件 | slice-00 §1.6；`find packages/cli/src` 非测试 |
| UI 足迹 | **235** 文件 | slice-00 §1.6；`find packages/ui/src` `.ts`+`.tsx` 非测试 |

> 足迹计数使用谓词 `find packages/*/src -type f \( -name '*.ts' -o -name '*.tsx' \) ! -name '*.test.*'`（测试位于独立 `packages/*/test/` 目录）。该谓词下计数可复现；不同计数口径会移动绝对数（slice-00 OPEN-5）。

### 栈

> Drift-fix D2 —— `architecture.md` L37,125 称 `CLI (53 command groups)`。在 HEAD 更正为 **58**（slice-00 §1.2：v0.2.0 标签时 53、v0.3.0 时 56、v0.3.1 时 57、**HEAD 时 58**——第 58 个是 `0b77cba4` 在 0.3.1 后新增的 `scopeCommand()`，已重新确认 `index.ts:20,187`）。
>
> Drift-fix D4 —— `architecture.md` L40 称 `31 route groups`，L76 称“`createApp()` 现挂载 22 个路由组”。更正为 **49 个 `app.route()` 挂载 + 4 个专用处理器**（slice-00 §1.5；重新确认 `server.ts` 49×`app.route(` L450–513，加 `app.get("/healthz")` :446、`handleExportYaml` :461、`handleExportJson` :462、`app.get("*")` :519）。沿用 slice-00 **OPEN-2**：“路由组计数是定义性的”——源码中无单一规范“路由组”定义；报告为挂载数 + 专用处理器。
>
> Drift-fix D3 —— `architecture.md` L54 称 `SQLite state (36 migrations)`。更正为 **40**（slice-00 §1.3；下文重新确认）。

```text
CLI（58 个命令组）/ UI（explorer + workspace + drawer）/ MCP（17 个工具）
      |
      v
Hono 后台服务路由（49 个 app.route() 挂载 + 4 个专用 health/export/static 处理器）
      |
      +-- 双格式路由适配器（旧版 v1 + 重启后 v0.2）
      +-- env 路由（status / logs / down）
      +-- 传输路由（send/capture/broadcast）
      +-- 转录路由（tail/grep）
      +-- ask 路由（上下文证据包）
      +-- 聊天路由（持久化 rig 消息 + SSE）
      +-- spec 评审/库路由（managed-app 富集 + compose 预览）
      +-- whoami 身份 + context-usage 路由
      +-- 协调路由（stream / queue / workflow / mission-control）
      |
      v
无框架领域服务（173 个后台服务 domain 文件）
      |
      +-- SQLite 状态（40 个迁移）
      +-- tmux / cmux / resume 适配器
      +-- 运行时适配器（Claude Code / Codex / 终端）
      +-- RigEnv 基底（compose 适配器、就绪、编排器）
      +-- 传输 / 转录 / 聊天 / ask 层
      +-- whoami 身份服务
```

核心产品循环：`down（自动快照）→ up <rig-name>（自动恢复）→ 交接 → 检视/attach → 工作 → 重复`。

> MCP 工具数为 **17**（`rig_*`）——slice-00 §1.4 确认计数正确、名为 `rig_*`（不是 `rigged_*`；`architecture.md` §2 中的 `rigged_*` 文本已陈旧——重命名早于 v0.2.0）。对任何 `rigged_*` 引用的逐处核验落在 `transport-and-transcripts.md`（D5）；tmux `@rigged_*` 元数据键是单独轴，不 blanket 替换。

## 2. 数据库 schema

> Drift-fix D3 —— `architecture.md` L243 称“27 个迁移（既有 22 个加 PL-004 Phase A 新增 5 个）”，L1002 重复“27 migrations”；§1 栈图 L54 称“36 migrations”。全部更正为 **40** 个迁移（`001`–`040`）。三角定位（slice-00 §1.3，已在 HEAD 重新确认）：(1) 文件系统 `packages/daemon/src/db/migrations/[0-9][0-9][0-9]_*.ts` → 40 个文件，`001_core_schema.ts` … `040_workflow_specs_diagnostic.ts`；(2) `startup.ts:206` `migrate(db, [...])` 传入 40 元素 schema 数组（`coreSchema` … `workflowSpecsDiagnosticSchema`）；(3) `migrate.ts:13` 按名排序应用，记录在 `schema_migrations`。

### 核心状态表（`001_core_schema.ts`）

`rigs`（拓扑容器，`001_core_schema.ts:7`）、`nodes`（逻辑节点身份，`:17`）、`edges`（逻辑拓扑关系，`:30`），外加 `bindings`（物理 tmux/cmux 表面附着）、`sessions`（实时执行状态）、`events`（append-only 事件日志）、`snapshots`（序列化 rig 状态）、`checkpoints`（按节点恢复状态）。`architecture.md` §3 L247–289。

### 重启时代 schema

- `014_agentspec_reboot.ts` —— 重启 schema 形状；在 `nodes`/`sessions`/`checkpoints` 上加 `pods`、`continuity_state` 与重启列（`pod_id`、`agent_ref`、`resolved_spec_*`、`startup_status`、`continuity_source`）。`architecture.md` §3 L253–289。
- `015_startup_context.ts` —— 供恢复用的持久化启动 replay 上下文。
- `016_chat_messages.ts` —— 持久化 rig 作用域聊天（SQLite 后端；转录仍经 pipe-pane 文件系统后端）。
- `017_pod_namespace.ts` —— 一等作者撰写的 pod 命名空间，供 export/adoption。
- `018_context_usage.ts` —— 按节点 context-usage 快照。
- `019_external_cli_attachment.ts` —— 外部 CLI attach 的 binding 行扩展。
- `020_rig_services.ts` —— 服务后端 rig 的 rig 作用域环境记录。
- `021_seat_handover_observability.ts`、`022_node_codex_config_profile.ts`。

### 协调 / PL-004 / PL-005 / 工作区迁移

- `023_stream_items.ts` … `027_outbox_entries.ts` —— PL-004 Phase A 协调表（细节见 `coordination-primitive.md`）。
- `028_project_classifications.ts`、`029_classifier_leases.ts`、`030_views_custom.ts` —— PL-004 Phase B classifier + view 表。（注：`architecture.md` L361 称“028 through 030”；中间迁移字面上是 `029_classifier_leases.ts`——已在 HEAD 重新确认。）
- `031_watchdog_jobs.ts`、`032_watchdog_history.ts` —— PL-004 Phase C watchdog。
- `033_workflow_specs.ts`、`034_workflow_instances.ts`、`035_workflow_step_trails.ts` —— PL-004 Phase D Workflow Runtime 表（细节见 `workflow-runtime.md`）。`036_watchdog_policy_enum_extension.ts` 是文档化 no-op。
- `037_mission_control_actions.ts` —— PL-005 Phase A 审计表（`037_mission_control_actions.ts:54` `CREATE TABLE … mission_control_actions`；细节见 `mission-control.md`）。
- `038_workspace_primitive.ts`、`039_queue_target_repo.ts` —— PL-007 类型化工作区原语（`bab24bf7`）。
- `040_workflow_specs_diagnostic.ts` —— slice-11（`f68f453a`）；一个 `ALTER TABLE ADD COLUMN`，给 `workflow_specs` 加 parser/validator 诊断列（无新表）。**自 `architecture.md` 上次编辑后净新增**——slice-00 §1.3 来源；带入 `workflow-runtime.md`。

旧版 package/bootstrap/discovery 表（`packages`、`package_installs`、`install_journal`、`bootstrap_runs`、`bootstrap_actions`、`runtime_verifications`、`discovered_sessions`）仍在使用。

## 3. 路由挂载表面

`createApp(deps)`（`packages/daemon/src/server.ts:295`）挂载 **49** 个 `app.route()` 路由组挂载（`server.ts` L450–513）加 4 个专用非路由处理器：`GET /healthz`（`:446`）、`GET /api/rigs/:rigId/spec`（`handleExportYaml`，`:461`）、`GET /api/rigs/:rigId/spec.json`（`handleExportJson`，`:462`），以及静态/深链 `app.get("*")` 兜底（`:519`）。

> OPEN-2（逐字保留，slice-00）：路由组“计数”是定义性的——“49”是 `server.ts` 中 `app.route()` 挂载数。更早的“31 route groups”/“createApp now mounts 22 route groups”框法（`architecture.md` L40,76）用了不同、更小的口径。独立佐证：`packages/daemon/src/routes/` 有 46 个非测试路由 `.ts` 文件（部分组由共享模块组成；49 个挂载是已挂载组的权威计数——slice-00 §1.5）。

挂载族包括重启时代 rig/session/spec 路由，外加协调路由（`/api/stream` `server.ts:489`、`/api/queue` `:490`、`/api/workflow` `:495`、`missionControlRoutes(...)` `:498`）、`/api/health-summary`（`:511`）、`/api/rigs/:rigId/env`（`:512`）、`/api/restore-check`（`:513`）。

## 4. 启动序列（`createDaemon`）

`createDaemon(opts?)` 是 `packages/daemon/src/startup.ts:203`（async，返回 `DaemonResult`）。返回 `{ app, db, deps, contextMonitor }`（`startup.ts:1204`）。序列（`architecture.md` §9 L1000–1028，对照源码更正）：

1. 打开 SQLite 并运行**全部 40 个迁移**（`startup.ts:206` `migrate(db, [coreSchema … workflowSpecsDiagnosticSchema])`——40 元素数组；`architecture.md` L1002 称“27 个迁移（既有 22 个加 5 张 PL-004 Phase A 协调表）”——更正为 40，drift-fix D3）。
2. 构造核心仓库与旧版服务。
3. 构造 package/bootstrap/discovery 服务。
4. 构造重启后的启动/运行时服务：`StartupOrchestrator`、`ClaudeCodeAdapter`、`CodexRuntimeAdapter`、`TerminalAdapter`、`PodRigInstantiator`、`PodBundleSourceResolver`。
5. 构造 rig 环境服务：`ComposeServicesAdapter`、`ServiceOrchestrator`。
6. 构造操作者/传输/历史服务：`TranscriptStore`、`SessionTransport`、`ChatRepository`、`AskService`（带 `HistoryQuery`）、`ResumeMetadataRefresher`、`ContextUsageStore`、`ContextMonitor`、`NodeInventory`。
7. 构造撰写/身份/managed-app 服务：`SpecReviewService`、`SpecLibraryService`、`WhoamiService`。
8. 用旧版与重启后双接缝构造 `BootstrapOrchestrator`。
9. 从共享 `QueueRepository` 实例构造 PL-004 Phase A 协调服务（使 `InboxHandler.absorb()` 与 `/api/queue` 写到同一 repo）：`StreamStore`、`QueueRepository`、`InboxHandler`、`OutboxHandler`。
10. 构建 `AppDeps`、强制共享 DB 不变量，并调用 `createApp(deps)`（`startup.ts:1202`）挂载完整路由树。

后台服务入口 `packages/daemon/src/index.ts:36` 调用 `createDaemon({ dbPath, bearerToken })`。

## 5. 测试与验证状态

> Drift-fix D7 / OPEN-3（逐字保留，slice-00）：`architecture.md` L12,13 与 §10 L1036–1046 断言后台服务 `2561/2561` / CLI `794/794` / 合计 `2422/2422` 测试通过数与每包文件数（`127`/`37`/`37`）。**这些是运行时论断，此处不重跑**——一次只读静态追踪只数了 `*.test.ts` 文件：后台服务 **255**、cli **234**（slice-00 §1.7；ui 测试文件数未单独统计）。通过计数标记为 `unverified-runtime-claim`；不要断言为当前。要断言通过数，请运行 `pnpm/npm test` 并重新核验。

## 另见

- `coordination-primitive.md` —— PL-004 Phase A stream/queue/inbox/outbox。
- `agent-spec-and-startup.md` —— spec 解析/解析/启动契约。
- `lifecycle-snapshot-restore.md` —— 快照/恢复/continuity。
- 源码根：`packages/daemon/src/{startup.ts,server.ts,index.ts}`、`packages/daemon/src/db/migrations/`、`packages/cli/src/index.ts`。
