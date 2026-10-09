---
kind: as-built
title: 生命周期 —— 快照、恢复、Continuity
status: active
topics: [continuity, runtime-control]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  需要了解 OpenRig 如何捕获快照、恢复一个 rig（resume vs rebuild vs fresh）、
  强制恢复诚实性、查询实时 continuity 状态，或后台服务侧 restore-check /
  restore-packet 就绪探针如何工作。
siblings: [daemon-core.md, agent-spec-and-startup.md, transport-and-transcripts.md]
prerequisite-reads: [../README.md, agent-spec-and-startup.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# 生命周期 —— 快照、恢复、Continuity

核心产品循环的持久状态半壁：`down（自动快照）→ up <rig-name>（自动恢复）→ 交接`。快照捕获序列化 rig 状态；恢复诚实地 replay 它（无静默 fresh 回退）；restore-check 是独立的只读就绪探针。

> 已对照 HEAD `7eaf524c`（`git describe` → `v0.3.1-6-g7eaf524c`）核验。包版本 **0.3.1**（slice-00 §1.1）。源码按 `architecture.md` 标题（§4 执行与恢复、§5 快照/恢复/continuity、§6 快照/恢复 + 自动快照、§7 规则）依 slice-08 §10.1 定位——行号仅供参考。本模块除 §6（restore-check/restore-packet）为 D15 author-from-source 部分外，均为纯拆分——在该处显式标记。

## 1. 快照 / 恢复 / continuity 类型

（`architecture.md` §4“执行与恢复”——spec/projection 成员见 `agent-spec-and-startup.md`；快照/恢复成员在此）

- **NodeRestoreOutcome** —— `"resumed" | "rebuilt" | "fresh" | "failed" | "n-a"`——锁定的恢复词汇。已在源码重新确认：`restore-orchestrator.ts:725-726` 在 resumed harness 上设 `baseStatus = "resumed"`；`:763` 在 replay checkpoint 时设 `"rebuilt"`；结果联合出现在 `:944`（`{ kind: "resumed" }` …）。
- **SnapshotData** —— 当前序列化快照负载。重启扩展为旧快照兼容可选：`pods?`、`continuityStates?`、`nodeStartupContext?`。
- **NodeStartupSnapshot** —— 持久化恢复 replay 输入：无分类投影条目、已解析启动文件、启动动作、运行时。
- **PersistedProjectionEntry** —— 无分类恢复 replay 接缝：只持久化条目身份 + 来源元数据，**不**持久化陈旧 `classification`、`conflicts` 或 `noOps`（Architecture Rule 10）。

## 2. 快照、恢复、continuity 领域服务

（`architecture.md` §5“快照、恢复与 continuity”）

- `checkpoint-store.ts` —— 带 pod/continuity 上下文的 checkpoint 持久化。
- `snapshot-capture.ts` —— 捕获 pods、continuity 状态、启动 replay 上下文与最新 env 回执。重新确认：`snapshot-capture.ts:66-77` 逐 rig 拉取 `pods`、`continuity_state`、`node_startup_context` 行。
- `snapshot-repository.ts` —— 快照 CRUD。
- `restore-orchestrator.ts` —— resume、checkpoint 投递、启动 replay、实时 continuity 查询、拓扑排序，以及智能体恢复前的 RigEnv 启动门。

## 3. 恢复流程与恢复诚实性

（`architecture.md` §6“快照 / 恢复” + §7 规则 7/14/15/16）

恢复行为，每点已在 `restore-orchestrator.ts` 重新确认：

- 按**单调 ULID**（而非仅时间戳）读取最新会话（`:700`——“找该节点最新会话。ULID 单调，故 latest = max id”）。
- 查询实时 `continuity_state`；当节点已 `restoring` 时保留状态（`:611-615`——`SELECT status FROM continuity_state …`；若 `status === "restoring"` 则节点带警告跳过）。
- 用持久化启动上下文 replay 恢复安全启动；把缺失可选工件预过滤为警告；**若必需启动文件缺失则节点硬失败**（`:799`——状态 `"failed"`，错误“Missing required startup files: …”）。
- **重新启动前写 transcript 边界标记**（`:652`——“在 launch 前（pipe-pane 附着前）写 transcript 边界标记”）。
- 拒绝覆盖实时会话恢复（`:168`——`rig_not_stopped`：“Rig … has live sessions. Stop the rig with 'rig down' before restoring”）。
- 用 `nativeResumeProbe` 诚实评估 harness 是否真的 resume（`:857` continuity 结果对账）。

**恢复诚实规则（逐字保留，`architecture.md` §7）：**

- Rule 7 —— 恢复策略收窄仅单向：`resume_if_possible` → `relaunch_fresh` → `checkpoint_only`。
- Rule 14 —— resume 状态锁定：`resumed` / `rebuilt` / `fresh`。`rebuilt` = 从工件装配的新进程。
- Rule 15 —— resume 失败响亮地 FAILED。无自动 fresh 回退。fresh 启动仅作显式后续。
- Rule 16 —— `up`、`down`、`restore`、`snapshot create` 要求命令后交接：发生了什么 + 当前状态 + 下一步。

（完整 25 条规则清单见 `architecture-rules-and-event-system.md`。）

## 4. 自动快照与既有 rig 上电

（`architecture.md` §6“自动快照与既有 rig 上电”）

- `rig down <rigId>` 在 teardown 前自动捕获 `auto-pre-down` 快照。
- `rig up <rig-name>`（无文件扩展名）按名搜索既有 rig，并从最新 `auto-pre-down` 快照恢复。
- 无快照时：带指引报错（“No saved snapshot for rig 'X'. Boot from a spec or bundle path.”）。
- 命令后交接：`down` 输出含快照 ID + 恢复命令；`up` 输出含节点状态 + attach 命令。

## 5. 后台服务侧 restore-check / restore-packet —— 由源码撰写（D15）

> **D15 撰写位（按 slice-08 §4.7 绑定标记）：** `restore-check` 与 `restore-packet` 无 `architecture.md` 叙述。本节是这个本为纯拆分模块中唯一由源码撰写的部分——按 slice-00 取证标准，从 `routes/restore-check.ts` + `domain/restore-check-service.ts` + `commands/restore-packet.ts` 撰写，引用 file:line，版本归属经取证核验。
>
> **版本归属（取证）：** restore-check 不是 0.3.1 特性。`routes/restore-check.ts` 首次创建于 `277e279c`（“feat: native rig restore-check command”，2026-04-23，早于 0.3.0）；在 `v0.3.0` 与 `v0.3.1` git 树均存在（`git ls-tree` 确认）。`restore-packet` 首次创建于 `23f2921e`（“Restore-Packet vertical M2a”，2026-05-01），同样在 v0.3.0 与 v0.3.1 存在。缺口是缺失的 architecture.md *散文*，不是版本归属漂移。

### 5.1 `rig restore-check` —— 就绪探针

`GET /api/restore-check?rig=<name>&noQueue=<bool>&noHooks=<bool>`（`routes/restore-check.ts:131`）。路由在既有后台服务投影上组装无框架 `RestoreCheckDeps`（`:138-168`）——来自 `rigRepo` 的 `listRigs`、`getNodeInventory`（按 `logical_id` 连 `node_id`，`:21-26,143-149`）、`getStartupContext`（读 `node_startup_context`，解析 `projection_entries_json` / `resolved_files_json` / `startup_actions_json`，`:44-128`）、来自 `snapshotRepo` 的 `hasSnapshot` / `getLatestSnapshot`，以及 `probeDaemonHealth`（自明：“我们在后台服务内部——若此路由在响应，后台服务即健康”，`:160-163`）。随后运行 `new RestoreCheckService(deps).check(...)`（`:170-171`）。

`RestoreCheckService.check()`（`restore-check-service.ts:244`）分层：

1. **主机检查** —— `checkDaemonReachable`（探针抛错 → `verdict: unknown`，不是 `not_restorable`，`:252-259`）、`checkStateDirWritable`（`:261`）、`checkHostInfraDeclaration`（`:262`，实现 `:406`）。
2. **Rig 枚举** —— `listRigs()` 抛错 → `buildUnknown`（`:267-274`）；`--rig` 过滤；未知 rig → 红色 `rig.<name>.exists`（`:276-284`）。
3. **逐 rig 检查** —— `checkSnapshot`（`:290`，实现 `:675`）、`checkSpecPresent`（`:295`）。
4. **逐席位检查** —— `checkSeatReadiness`（`:311`）、`checkStartupContext`（`:315`，实现 `:763`；`unknownChecks` → `buildUnknown`）、`checkTranscript`（`:325`）、`checkResumePath`（`:329`），以及除非选择跳过：`checkQueueFile`（`:334`，由 `--no-queue` 门控，实现 `:870`）与 `checkHooks`（`:339`，由 `--no-hooks` 门控，实现 `:896`）。
5. **判定** —— `buildResult` 聚合：任一红 → `not_restorable`；任一黄 → `restorable_with_caveats`；否则 `restorable`；探针不可检视 → `unknown`（`:1074-1085`、`:1362-1379`）。外加 `RecoveryPlan`（`buildRecovery`，`:1186`）与 `RepairStep[]` 包（`buildRepairPacket`，`:1392`；完全可恢复时 `null`）。

结果形状为 `RestoreCheckResult`（`restore-check-service.ts:120-130`）：`verdict`、`readiness`、`continuity`、`rigs[]`、`hostInfra`、`recovery`、`counts {red,yellow,green}`、`checks[]`、`repairPacket`。

**诚实错误设计（slice-00 标准）：** 后台服务探针*异常*产生 `verdict: unknown`（不可检视状态），区别于后台服务确定宕机的红 / `not_restorable` 状态（`restore-check-service.ts:249-259`）。路由兜底返回相同 `unknown` 形状 body，HTTP 500 + 一条 `probe.error` 红检查（`routes/restore-check.ts:174-222`）。`CheckEntry.remediationSafe` 默认 `false`（保守——未分类修复不自动执行安全，`restore-check-service.ts:18-24`）。

CLI 表面（`cli-reference.md` `### rig restore-check`）：`rig restore-check [--rig <name>] [--no-queue] [--no-hooks] [--json]`。退出码：`0` 可恢复（或带告诫）、`1` 不可恢复（红）、`2` 未知 / 探针错误。

### 5.2 `rig restore-packet` —— 跨运行时恢复包

CLI 侧，无后台服务路由。`commands/restore-packet.ts`（528 行）实现三个子命令（`cli-reference.md` `### rig restore-packet`）：`write [options]`（从来源会话或 JSONL 文件生成包目录，带 `omitted-records` 账目）、`read <packet-dir> [--json]`（渲染内容；非变更）、`validate <packet-dir> [--json]`（对照 v0 schema 校验；非变更）。包形状是跨运行时 v0 标准——Claude Code 与 Codex 转录均经运行时解析器 + 脱敏支持。

## OPEN / 保留项

- **D15（author-from-source，已完成）：** restore-check / restore-packet 由上方源码撰写；标记为本模块唯一撰写位。版本归属取证解决（均早于 0.3.0；缺口是缺失散文，非漂移）。
- 无 slice-00 数字漂移适用于本模块拆分内容（足迹/迁移/路由计数落在 `daemon-core.md`）。

## 另见

- `agent-spec-and-startup.md` —— StartupOrchestrator 持久化恢复所消费的 replay 上下文。
- `daemon-core.md` —— `/api/restore-check` 是 49 个路由挂载之一（`server.ts:513`）。
- `transport-and-transcripts.md` —— 恢复时写的 transcript 边界标记。
- 源码根：`packages/daemon/src/domain/{restore-orchestrator,snapshot-capture,snapshot-repository,checkpoint-store,restore-check-service}.ts`、`packages/daemon/src/routes/restore-check.ts`、`packages/cli/src/commands/restore-packet.ts`。
