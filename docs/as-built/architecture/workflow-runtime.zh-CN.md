---
kind: as-built
title: Workflow Runtime + Watchdog 策略（PL-004 Phase C/D）
status: active
topics: [coordination, runtime-control]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  需要了解后台服务原生 Workflow Runtime 如何工作——workflow spec 缓存、实例状态、
  step 轨迹、事务性 scribe 投影契约，或含 workflow-keepalive 的 watchdog 策略集。
siblings: [coordination-primitive.md, mission-control.md]
prerequisite-reads: [../README.md, coordination-primitive.md]
last-verified-against-source: slice/opr-0.4.6.wf2-spec-language tip (base d18907ed — WF-1 merged)
last-updated: 2026-07-06
---

# Workflow Runtime + Watchdog 策略（PL-004 Phase C/D）

后台服务原生 Workflow Runtime（PL-004 Phase D）把一段意图中的工作序列变成持久 SQLite 状态：声明式 workflow spec、活实例状态、append-only step 轨迹，以及承重的事务性 scribe 契约。PRD §L4 操作模型在语义上是 owner-as-author，在机械上是 workflow-as-transactional-scribe（`architecture.md` §3 L398）。

> 已对照 HEAD `7eaf524c` 核验。

## 1. 三张 Phase D 表（+ 诊断新增）

已在 HEAD `packages/daemon/src/db/migrations/` 重新确认：

- **`workflow_specs`**（`033_workflow_specs.ts:33` `CREATE TABLE … workflow_specs`）—— 人工撰写 markdown/YAML spec 文件的 read-through 缓存。源是 workspace 表面；后台服务按 `(name, version)` 缓存，带内容 `source_hash`，使操作者对 spec 文件的有效编辑在下次读取胜出（workspace 表面对账）。Spec 撰写保持 markdown 权威；缓存为快速查找与运行时解析而存在（`architecture.md` §3 L400）。
- **`workflow_instances`**（`034_workflow_instances.ts:45` `CREATE TABLE … workflow_instances`）—— 每个运行 workflow 的活状态：`status`（`active|waiting|completed|failed`）、`current_frontier_json`（活动 qitem id）、`hop_count`（循环守护计数）、`last_continuation_decision_json`。实例从 SQLite 跨后台服务重启存活——无文件系统对账（`architecture.md` §3 L402）。
- **`workflow_step_trails`**（`035_workflow_step_trails.ts:32` `CREATE TABLE … workflow_step_trails`）—— 有意义 step 转换的 append-only 历史。每次关闭产生一行轨迹，配对前一 qitem 与下一 qitem（终态为 null）。`WorkflowStepTrailLog.record()` 是唯一写者（`architecture.md` §3 L404）。
- **`040_workflow_specs_diagnostic.ts`** —— slice-11（`f68f453a`，slice-00 §1.3 来源）。一个 `ALTER TABLE ADD COLUMN`，给 `workflow_specs` 加 parser/validator 诊断列（**无新表，除 DEFAULT 外无约束变更**；缓存携带解析/校验诊断供 UI 渲染——`040_..._diagnostic.ts:5–25`）。**本迁移自 `architecture.md` 上次编辑后净新增**，此前 as-built 文档未述（slice-00 §1.3——`f68f453a` 晚于 §3 正文）——按 slice-08 drift-to-fix 寄存器在此由源码撰写。

`036_watchdog_policy_enum_extension.ts` 是文档化 no-op，记录 Phase D watchdog 枚举扩展（Phase C 经 `PHASE_D_POLICIES` 数组做应用层强制，故无需 DDL——`architecture.md` §3 L363`）。

## 2. 事务性 scribe 契约

承重 Phase D 保证在 `WorkflowProjector.project()`（`packages/daemon/src/domain/workflow-projector.ts`）实现。已在 HEAD 重新确认：projector 头（`workflow-projector.ts:1–20`）声明“transactional-scribe contract”，`project()` 跑单个 `db.transaction`（`workflow-projector.ts:184` `const txn = this.db.transaction(...)`）。在该单事务内：

1. 关闭当前 packet（`queue_items` 上状态变更）。
2. 创建下一步 packet（`QueueRepository.createWithinTransaction()`，`workflow-projector.ts:230`）。
3. 记录轨迹条目。
4. 更新实例 frontier + 状态。
5. 持久化 workflow 事件。

要么全部提交，要么全部回滚；按设计不可能丢失 handoff。提交后通知订阅者并 nudge 下一 owner（`architecture.md` §3 L406）。

`WorkflowRuntime`（`packages/daemon/src/domain/workflow-runtime.ts:61` `export class WorkflowRuntime`）是 projector 之上的编排类。

**Phase D 范围边界**（`architecture.md` §3 L412）：排除多跳链、门回扫、关闭强制路径。后台服务事务状态仍经 Phase A hot-potato 严格拒绝作为关闭权威（见 `coordination-primitive.md` §3）；workflow runtime **在关闭时投影，不门控关闭**。

## 3. workflow-keepalive watchdog 策略

`workflow-keepalive` 是 Phase C 推迟的 watchdog 策略，POC `lib/policies/workflow-keepalive.mjs` 的 TypeScript 移植，适配读 SQLite（`packages/daemon/src/domain/policies/workflow-keepalive.ts:1–5`）。已在 HEAD 重新确认（`workflow-keepalive.ts:5–16`）：

- **承重：** 它**必须**经 SQLite 直读 `workflow_instances`——从不读 markdown 源。
- 资格：`status === "active" || status === "waiting"`。否则 `action=terminal, reason="workflow_not_active"`。
- Frontier 空 + 无回退目标：带 `reason="empty_frontier"` 跳过。
- 经查 `queue_items` 解析 frontier qitem owner；与显式 observer/created-by 目标合并；发到第一个解析目标。

watchdog 监督树本身（PL-004 Phase C，`031_watchdog_jobs.ts` / `032_watchdog_history.ts`）只记录有意义评估；安静跳过原因（`not_due`、`no_actionable_artifacts`、`active_wake_not_due`）**不**记录，也**不**发 `watchdog.*` 事件——POC 对等，使智能体不因调度器轮询被唤醒（`architecture.md` §3 L362`）。Phase D 策略枚举在 Phase C 三个值上加 `workflow-keepalive`。

## 4. Workflow 事件

> Drift-fix D8 / OPEN-4（逐字保留，slice-00）：`architecture.md` §3 L410 称“既有 20 个 PL-004 事件不变”——与 L394 的“32 个 PL-004 事件不动”内部不一致。**不要沿用任一数字。** 当前 `RigEvent` 联合（`packages/daemon/src/domain/types.ts:94`）共 **73 个成员**（slice-00 §1.8，已在 HEAD 重新确认）。增量 Phase D `workflow.*` 事件在下方描述，**不**断言有争议的 PL-004 子计数。

Phase D 用增量 `workflow.*` 事件扩展 `RigEvent`（已重新确认 `domain/types.ts:196–201`）：`workflow.instantiated`、`workflow.step_closed`、`workflow.next_qitem_projected`、`workflow.completed`、`workflow.failed`、`workflow.routing_table_changed`（6 成员；联合中另有独立 `workflow_spec` 事件）。

## 5. 路由表面

`/api/workflow`（`server.ts:495`）—— `POST /validate`（`routes/workflow.ts:82`）、`POST /instantiate`（`:93`，`getRuntime(c).instantiate(...)`）、`POST /project`（`:118`，`getRuntime(c).project(...)`——事务性 scribe 入口）、`GET /:instance_id/trace`（实例 + 轨迹）、`POST /:instance_id/continue`（幂等检视）。表面枚举见 `routes/workflow.ts:21–28`。交叉引用：`rig workflow` CLI 表面——见 `../cli-reference.md`。

## 6. WF-1 失败信封（OPR.0.4.6.WF1）

在保留的 Phase D 内核之上新增（上文无重 spec；FR-1 回归测试钉住）：

- **Step 期限（FR-2，派生——从不存储）：** `workflow-deadline.ts` 按锚分类每个 active|waiting 实例的 frontier packet——带 `closure_required_at` 的 claimed · deadline 为 NULL 的 claimed（`claimed_at` + 阈值；workflow packet 发 tier `mode2`，无 SLA 条目）· 从未 claimed（`created_at` + 阈值）· claim 后 unclaim（`created_at`；unclaim 把 `claimed_at` 置 NULL）。`WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS`（4h，= 常规层 SLA）是唯一阈值之家；WF-5 绑定它。卡住经正常重投影自清除。
- **Keepalive 自动武装（FR-3）：** instantiate + 每次 handoff 在 scribe 事务**内**确保每实例一个 `workflow-keepalive` watchdog job；终态退出解除武装。自动武装 job 带 `context.deadline_gated: true`——健康时安静，其逾期发送把重投影 steering 指向卡住 packet 的 owner。操作者注册 job 保持精确 POC 始终发送对等。
- **启动扫（FR-4）：** 后台服务启动时 `workflow-boot-sweep.ts`——重新武装缺失 keepalive、重发 LOST 提交后 nudge（`last_nudge_attempt` 为 NULL 的 pending frontier packet = 提交后崩溃窗口，从 nudge 台账检测）、呈现卡住实例；一行摘要日志。
- **真幂等（FR-5）：** waiting-replay 在完整关闭意图身份（exit/packet/step/actor/resultNote/effective-blocker/evidence 深等）下吸收——精确 replay = 零写；任何不匹配 = 经正常路径的新决策。迁移 049 加 `workflow_instances.version`：每次受守护推进在 `WHERE version = ?` 递增；stale 写者得到结构化 `instance_version_conflict` 且其整个事务回滚。
- **max_hops 强制（FR-6）：** 在投影时经 `exceedsMaxHops(hopCount, baseline, maxHops)` 比较（v1 baseline = 0；baseline 是 WF-5 的 resume 接缝）。超出把 handoff 转为诚实结构化失败（packet 关闭、实例 failed、轨迹中守护证据 + `workflow.failed`）。迁移 050 加 `workflow_specs.spec_json`——此前 `loop_guards`/`invariants`/`closure`/`entry` 在投影时 rehydration 被静默丢弃（仅列重建）；旧行在 readThrough 自修复并**可见**降级（每 spec 一次建议性提示）。
- **校验（FR-7）：** `parseWorkflowSpec` 在每层对照导出的封闭键集响亮拒绝未知键（WF-2 扩展之）；validator 在 projector 自身导出的 `resolveNextStep` 上走可达性/环——不可达 step 失败；无 `max_hops` 的环失败并命名修复；有则 sanctioned。
- **`continue` 诚实（FR-8）：** 各处重标为其真实只读检视器语义（CLI 描述/outcome、路由注释）；`project` 仍是唯一推进写路径。
- **v2 处置（FR-9）：** 每个声明但未强制的键——`invariants.{continuation_required,preserve_lineage,closure_required}`、`closure.*`、step `gates[]`、role `skill_refs`、`next_hop.mode: prefer`、`loop_guards.spawn_budget`——产生 fail-open `declared_not_enforced_v1` validator 建议（警告；从不阻塞）。`spawn_budget` 的建议命名其 WF-2/WF-6 平行 frontier 验收指针（arch 裁定 2026-07-06）。`fallbackSynthesis`（实例列，从不写）在 `workflow-types.ts` JSDoc 中处置。

## 7. WF-2 spec 语言（OPR.0.4.6.WF2）

WF-2 扩展已批准 WF-1 引擎所说的语言。一个具名引擎扩展（分支执行）；其余皆为语言 + 编译到已交付接缝。

**按结果条件分支（FR-1）。** Step 可声明 `next_hop.on: {<exit>: <step-id>}`——分支键**仅**为记录的 exit 枚举（`handoff|waiting|done|failed`；封闭集，解析时强制——`spec_branch_key_invalid`）。映射的 exit 在同一 scribe 事务内路由到其目标：下一 qitem 在事务内创建，实例保持 ACTIVE 绑定到目标，hop 计数 + 版本守护像线性推进一样递增，所取分支**增量**记录（`lastContinuationDecision.branchTaken` + 轨迹行的 `closure_evidence.branch_taken`）——从不在 `closure_reason` 中（封闭 Phase-A 枚举）。未映射的 `failed`/`done` 像从前一样保持终态；未映射 `waiting` 保持 park。`max_hops` 守护在任一路由触发（分支路由创建规范补救环）；校验时环检测在结构 ∪ 分支边集上跑，需声明 `max_hops` 才 sanctioned 任何环。路由接缝：`resolveNextStep(spec, step, recordedExit?)`——一个导出函数，无 exit 时结构默认（validator 路径）。

**逐 step `harness:` 钉（FR-2）。** `claude-code | codex`（仅智能体 harness——`terminal` 在解析时拒绝并带教学错误；Pi 在 0.4.7 加入）。Owner 解析选首个 `preferred_target`，其节点 `runtime` 列匹配（`nodeRuntimeOf`：最新会话 → 节点 join）；无匹配 = 结构化 `harness_pin_unsatisfied`，命名钉 + 每个候选的 runtime。显式 owner 覆盖也对账——覆盖从不能静默击败钉。instantiate 时对每个钉 step 静态检查；每次路由重查。

**逐 step `host:` 钉（FR-3）。** `local`/缺席 = 今日全本地执行。注册表 id 对照 `~/.openrig/hosts.yaml` 校验（后台服务只读孪生；未知 id = `host_not_registered`，命名已注册 id），但远端钉在 INSTANTIATE 时响亮失败 `host_pin_remote_unsupported`，命名 MH-3 边界 + 变通——队列在 MH-3 前仅本地；从不把 qitem 铸进无法路由的队列，也无静默本地回退。

**结构化 step 级 `gate:`（FR-5——插槽；WF-5 拥有语义）。** 每 step 单值，封闭键集 `{target, summary, evidence_ref}`。HUMAN 目标（已交付 human-seat 谓词）→ 编译为人类路由项（tier `human-gate` + summary + evidence_ref——已交付 0.4.4 写路径），由已交付 `resolve` 动词解析；HANDLER-ROLE 目标 → 到角色解析席位的普通智能体项。路由**进** gated step 时把 gate 项创建为 frontier packet 并 park 实例 `waiting`；resolve/close 从该 step 继续流（WF-1 unpark——无重启）。gated ENTRY step 自出生 park。

**处置（FR-4）——惰性第三态已死。** 旧版 step `gates: [...]` 字符串列表在解析时**移除**（`spec_gates_removed`，what/why/fix 命名新 `gate:` 对象）；`next_hop.mode: prefer` 在解析时**移除**（`spec_prefer_mode_removed`——它从无独特行为）。`skill_refs` / `closure.*` / `invariants.{continuation_required,preserve_lineage,closure_required}` 保留 WF-1 FR-9 显式-v2 建议；`spawn_budget` 保持显式-v2（WF-6/平行 frontier 验收指针）。每个键被消费、移除或机器可读建议——零静默惰性键。

**版本诚实（FR-6）。** 新严格性落在 `parseWorkflowSpec`（唯一见原始键的接缝；WF-1 导出封闭键集扩展 `harness`/`host`/`gate` + `next_hop.on`），并在 validate/instantiate/重解析时应用。钉在 WF-2 前 spec 版本的 LIVE 实例保持不失败执行（`project()` 按设计无校验门；缺新可选字段的已存 `spec_json` blob 读起来正常）；同一 spec 文件在新规则下重校验失败。

**可手写性（FR-6）。** `packages/daemon/src/builtins/workflow-specs/` 三个已交付示例形状：`linear-build.yaml`（零 WF-2 特性——零回归参考）、`gated-release.yaml`（人类门 + harness 钉）、`branched-remediation.yaml`（有界失败路径补救环）。

**组合 RSI 示例（OPR.0.4.6.FAC2）。** `factory-rsi.yaml` 是单 rig 递归自改进工厂 MVP：它把分支 + 门 + 守护原语组合进内循环——`plan → implement → qa_check → review → release_prep`——其中 `qa_check`/`review` 把 `failed` 分支回 `implement`（有界补救），`release_prep`（release-manager 准备工件，无门）交接给人类门 `release_signoff`。Dogfood 与此门控循环解耦：dogfood 席位带外对已交付产品跑，并把发现喂入下一 plan（RSI 边缘，无门）。补救环仅由可强制 `loop_guards.max_hops` sanctioned；触发是 WF-5 异常（经 `exception_routing` orchestrator-first）。它面向已交付 `factory-rsi` 启动 starter（`specs/rigs/launch/factory-rsi/`），其席位经 `preferred_targets` 1:1 钉角色——v0 硬编码接缝，无绑定层。

## CLI 表面（OPR.0.4.6.WF3）

WF-3 使 CLI 成为主要人类/智能体驱动表面。按规则渲染侧（BR-2）：`run`/`watch` 消费已交付 SSE 端点（snapshot-first-then-stream、priorQitemId 去重、重连 → 公告轮询回退、outcome 作退出码：0 completed / 3 failed）；`trace`/`list`/`show` 人类模式格式化（argo 形树、ps 机制列、ATTN 标记）而 `--json` 保持字节稳定；`status` 在 CLI 侧从 API 携带的 `instance.deadline` 分类组合需关注汇总（单一阈值之家——CLI 从不重算类）。两处后台服务新增：

- **`route`**（`POST /api/workflow/:id/route`，runtime `route()`）：在一个 scribe 事务内 close+recreate+rebind——带来源的诚实 `handed_off_to` 关闭，后继 recreate（同 step；`current_step_id` 不变；无 hop 递增——route 不是推进），frontier 在版本守护下 rebind，keepalive 在事务内重定向。推进权威撤销是**结构性**的：旧 packet 在事务内离开 frontier，故僵尸 owner 的 stale `project` 撞上已交付 `packet_not_on_frontier` 409。
- **frontier 关闭路径守护**（`workflow-frontier-guard.ts` → 启动时注入 `QueueRepository`；队列从不导入 workflow 域）：非 workflow 动词对活 frontier packet 的终态关闭拒绝 `workflow_frontier_packet`，带 what/why/fix 命名 `rig workflow project` / `route`。Workflow 写者传 `viaWorkflowVerb`；非 workflow qitem 见零新行为。

## 异常 + 人类门模型（OPR.0.4.6.WF5）

确定性引擎的异常层：happy path 保持无编排器且已证；每个异常在存在瞬间恰好变成一个持久关注项；响应者解析它，流从停下处恢复。

- **分类法**（`workflow-exception.ts`）：三个封闭类作为对记录状态的纯谓词——`unmapped_failed`（记录 `status=failed`；WF-2 映射的 `failed` 路由到补救，**不**是异常）、`stuck_overdue`（WF-1 期限评估器的 verdict 逐字消费——单一阈值之家）、`human_gate_trip`（WF-2 HUMAN 门；编译的 park 即项）。Handler-role 门触发是确定性 handoff，非异常——类 (a)/(b) 是 handler 自身 step 的兜底。发生键是该事件的记录 packet id：重检测去重，resolve+resume 关闭，新 packet 是新发生。
- **成熟度拨盘**（`workflow-exception-router.ts` + `exception_routing` spec 语法 + `workflow.exception_routing` 设置键）：目标解析 = spec 逐类 → spec 默认 → host 动态键 → ORCHESTRATOR-FIRST（声明编排器角色，经 step owner 所用同一 `preferred_targets` 挑选）→ 注册人类选择（`workflow-human-destination.ts`）。**层级切分**：`human-gate` 仅骑人类路由位置——编排器路由项带普通 tier，使已交付关注 union（按 tier 匹配而不论目标）从不把它漏进 NEEDS-YOU。已交付关注谓词不动。
- **类 (a) born-in-txn**：串行失败与未处理依赖分支失败共享异常接纳。失败 packet、依赖发生、所属项与分阶段 wake 一起提交，即使无关 frontier 保持实例 active。映射补救仍是普通 workflow 工作；未映射或 max-hop 失败需 owner。被拒为未知 rig 的智能体目标尝试注册人类选择。选择、接纳或存储失败回滚关闭；从不提交幽灵人类告警。其他错误保留原诊断。**类 (b) 在检测时**：启动扫与 keepalive 评估调用注入的 ensurer（`workflow-exception-escalation.ts`）——按 tag 查询对 OPEN 项做发生去重，范围限于确切 workflow、实例与 packet；崩溃存活的扫重建遗漏项。正常投影、keepalive（含健康/终态返回）与启动（含已完成实例）对账每个逾期项自己的 packet。已解析等待、完成或过时 frontier packet 仅关闭该发生，保留转换；逾期兄弟保持开放。未知来源保留。后续逾期事件即使复用同一 packet 也可创建新项。
- **人类选择与失败**：既有 `workspace.operator_seat_name` 设置选注册人类；未设时要求恰好一个注册人类。不发明 `human@host` 别名，不在多人间做任意选择。设置与注册表在回退时读取，故有效配置的智能体路由无需人类注册表。缺失、歧义、无效或不可用选择产生 `workflow_human_destination_unavailable`（失败投影 HTTP 409）。修注册/选择后重试。检测时接纳失败由启动记录，并纳入 keepalive 既有 owner nudge 与评估备注；后续检测重试。注册目标仍用网关普通投递规则与回执台账。接纳不等于投递或已读证明。能力清单或检测器实例绑定读失败向上传播而非变为 no-match：失败投影返回 HTTP 500 并回滚其 packet、实例与历史写；逾期检测呈现读错误而无异常项。有据 no-match 仍用注册人类选择。
- **`resume`**（`POST /api/workflow/:id/resume`，runtime `resume()`，`rig workflow resume`）：一个 scribe 事务内 redrive 语义——failed→active REBOUND 到记录的失败 step；owner 经投影解析器**重解析**（从不从 stale 目标拷贝——resume 是唯一 sanctioned 重解析点）；`--decision` 持久落入 redrive packet；该发生的开放项带来源关闭；轨迹保留，从不重写。对依赖图，`--occurrence <failed-qitem-id>` 选事件（多个未解决失败时必需）。其解析、redrive packet/wake 与确切实例/发生异常关闭共享一个事务；兄弟保持完好。相同发生/决策重试返回既有 redrive；变更决策字节冲突而不变更。**活锁护栏**（迁移 051）：`hops_baseline` 在 resume 重新锚定 max_hops 守护，使每次 redrive 恰好一个有界窗口；`resume_count` 是记录的 redrive 事实；再超提升诚实**新**发生。
- **workflow 感知 ▲ 带**（`review/compose.ts deriveWorkflowExceptions` + gatherer 源）：缺项兜底行、带评估器证据的卡住行、frontier 非开放 ANOMALY 行（WF-3 FR-6 预防之后检测），以及**感知行**——编排器路由异常在人类带渲染 holder + 年龄（一身份、两投影、计数 = 1）；人类路由项在那里什么都不渲染（● 项即行）。状态退出时重组清除。

## workflow ↔ rig 绑定层（OPR.0.4.6.FAC1）

在任何能支持它的 rig 上跑任何 workflow，无需编辑 spec——自动驾驶工厂的绑定基底。三接缝：

- **A1 —— instantiation 时绑定**（迁移 052，`workflow_instances.bound_rig`）：有效绑定 = `--rig`/`targetRig` 覆盖 `?? spec.target.rig ?? null`；spec 字段保持 DEFAULT（无路由路径读它——仅展示）。Rig **名**持久化（持久操作者空间坐标）；名→id 在每个解析点新鲜重解析——消失的 rig 响亮失败（`bound_rig_not_found`），从不静默。NULL = 未绑定 = 字节相同的 FAC-1 前行为。**未知 rig 校验按来源切分**（arch 裁定 2026-07-07，target-rig 零回归）：显式操作者 `--rig`/`targetRig` 是权威——未知 → `bound_rig_unknown` 在任何变更**前**硬失败；spec 默认 `target.rig` 是建议性（在 FAC-1 前体制下撰写，该字段运行时被忽略）——未知 → 降级到未绑定 + instantiate 结果上响亮 `advisories` 提示（由路由 + CLI stderr 呈现），从不硬失败。这为声明描述性 `target.rig` 且经 `preferred_targets` 路由的已交付/示例 spec（如 `conveyor`）保留 AC-1 零回归：它们像 FAC-1 前一样 instantiate。真正需要绑定 rig 的 spec 仍按 step 响亮失败（instantiate 时 entry，后续仅角色 step 在投影时）——降级是带提示的诚实逐步失败，从不到静默。
- **A2 —— 角色→席位能力解析**（`workflow-role-resolver.ts` 纯策略 + `workflow-role-context.ts` 懒同步快照）：`resolveDefaultOwner` 内 TIER 3，仅当角色声明零 `preferred_targets` 且实例绑定时激活。层级顺序神圣：显式 owner → 门编译 → 声明 `preferred_targets`（字节相同，从不过滤清单）→ 能力 → 响亮 null。封闭事实集：角色（`nodes.role`，按 pod 成员声明——席位侧，opt-in）· nodeKind · lifecycleState（仅 `running`）· runtime（harness 钉感知）· 同步 `pendingWorkCount`（仅 pending 积压）· 派生规范坐标。异步 `attachAgentActivity`/tmux 探测在事务中结构性缺席。仅托管席位：adopted 席位被响亮排除（`adopted_seat_not_role_resolvable_v1`）。选择 = 最少积压，纯码点坐标平局决胜（`driver10@rig < driver2@rig`）。解析在 step 关闭时**跑一次**（在 frontier + 吸收守护之后——重放执行零清单读），并记录为 packet 目标；WF-5 resume 是重解析点，现能力感知。全部**六**个 owner 解析点带上下文：projector next-step、人类门 park packet owner、handler-role 门目标（无目标 + 绑定 → 能力）、runtime entry（活 + 记录）、eager instantiate 循环（仅结构性零角色覆盖检查——`bound_rig_role_uncovered`；未来 step 无活解析；预热 rig 可 instantiate）、resume。WF-5 异常拨盘的编排器角色位置在两处（事务内类-(a) + 检测时类-(b)）都在绑定 rig 上能力感知解析，若无智能体解析则用注册人类选择。失败响亮带候选：结构化逐候选取消资格 + 命名零候选消息；从不 spawn、从不自动 `add_member`、从不死席位路由。增量 `owner_resolution` 轨迹证据按路由决策记录 `{mode, role, boundRig?, seat}`。
- **A3 —— 角色绑定到席位，从不到居住者**：唯一字符串规则——派生规范坐标 `{pod}-{member}@{rig}` 既是平局决胜键又是记录目标，故席位后的智能体 handover 从不 stranded workflow（原始居住者时代会话名从不记录为角色解析目标）。

## member-exists instantiate 建议（OPR.0.4.6.FAC3——引擎位）

队列传输校验目标的 RIG，从不到 member（`topologyValidateRig` 按设计仅 rig-exists——加固它会门控每次队列写并破坏合法非托管目标），故声明的 `preferred_target` 命名注册 rig 但 member 拼错或过期会铸造孤儿 packet，仅后来作为 WF-5 卡住异常可见。FAC-3 在最早可知时刻捕获：instantiate 时，对每个 step 引用角色（每 step `actor_role` 加 handler 门的目标角色——结构覆盖检查遍历的同一引用集），每个解析为规范且命名本后台服务注册 rig 的声明 `preferred_target` 被探测 member 存在（`rigMemberExists` 在 `rigDeclaresRole` 旁——同步 SQL，按 FAC-1 Q5 一字符串规则派生规范坐标，任意生命周期状态与节点种类都存在；活性仍是投影的事）。未知 member 对每个唯一目标产生一条聚合建议——命名每个声明 step/角色对、后果（工作不会被认领；将作为卡住异常呈现）与修复提示——推入已交付 `InstantiateResult.advisories` 列表（FAC-1 `target.rig` 降级表面：一个列表，现两个生产者；由路由 body + CLI stderr 渲染，零新表面）。**建议从不拒绝**：instantiate 总是继续。按序跳过：人类席位引用（解析前分类，队列门原型）、非规范原始/adopted 目标（清单无法担保）、未注册 rig（传输已在队列写时响亮拒绝——无重复建议）。

## 另见

- `coordination-primitive.md` —— PL-004 Phase A；runtime 投影所对的关闭权威。
- `mission-control.md` —— PL-005 队列可观测 + 7 动词契约。
- 源码根：`packages/daemon/src/domain/{workflow-projector,workflow-runtime,workflow-instance-store,workflow-spec-cache,workflow-step-trail-log,workflow-validator}.ts`、`packages/daemon/src/domain/policies/workflow-keepalive.ts`、`packages/daemon/src/domain/{workflow-exception,workflow-exception-router,workflow-exception-escalation}.ts`、`packages/daemon/src/routes/workflow.ts`。
