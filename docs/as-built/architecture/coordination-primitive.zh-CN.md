---
kind: as-built
title: 协调原语 —— Stream/Queue/Inbox/Outbox（PL-004 Phase A）
status: active
topics: [coordination, observability]
domains: [engineering-advisor, operating-advisor, orchestrator]
applies-when: |
  需要了解后台服务支撑的协调原语如何工作——stream/queue/inbox/outbox 表、
  hot-potato 关闭契约、事务性交接保证，或队列关闭在何处强制。
siblings: [workflow-runtime.md, mission-control.md, daemon-core.md]
prerequisite-reads: [../README.md, daemon-core.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# 协调原语 —— Stream/Queue/Inbox/Outbox（PL-004 Phase A）

PL-004 Phase A 协调原语是后台服务经 `/api/stream` 与 `/api/queue` 暴露的、以 SQLite 为规范的持久工作层。它取代 POC 文件系统 `rigx queue` / `rigx stream` 路径用于后台服务支撑的工作；POC 文件系统路径保持不动，后台服务 `rig queue` / `rig stream` 只写 SQLite（`architecture.md` §5 L651）。

> 已对照 HEAD `7eaf524c` 核验。

## 1. 五张 host 作用域表

该原语由五张 host 作用域表支撑（`architecture.md` §3 L416–438；迁移已在 HEAD `packages/daemon/src/db/migrations/` 重新确认）：

- **`stream_items`**（`023_stream_items.ts`）—— L1 append-only 摄取/审计根。列：`stream_item_id`（ULID 主键）、`ts_emitted`、`stream_sort_key`、`source_session`、`body`、`format`（默认 `text`）、`hint_type`、`hint_urgency`、`hint_destination`、`hint_tags`（JSON）、`interrupt`、`archived_at`。条目发出后不可变（仅可设 `archived_at`）。
- **`queue_items`**（`024_queue_items.ts`）—— L3 所属工作队列。`qitem_id` 是 TEXT 主键，保留 POC 的 `qitem-YYYYMMDDHHMMSS-<hex>` 形状。状态枚举（8 值）：`pending | in-progress | done | blocked | failed | denied | canceled | handed-off`。携带 `closure_reason`、`closure_target`、`closure_required_at`、`chain_of_record`（JSON）、`blocked_on`、`handed_off_to`/`handed_off_from`、nudge/heartbeat 字段。
- **`queue_transitions`**（`025_queue_transitions.ts`）—— L3 append-only 转换日志；状态演进的权威审计轨迹。领域代码中无 UPDATE/DELETE。
- **`inbox_entries`**（`026_inbox_entries.ts`）—— 邮箱式异步投递；按 `inbox_id` 幂等。状态：`pending | absorbed | denied`。
- **`outbox_entries`**（`027_outbox_entries.ts`）—— 发送方审计；与 inbox 对称；按 `outbox_id` 幂等。投递状态：`pending | delivered | failed`。

> Drift-fix D3 —— `architecture.md` §3 L243 把 schema 框为“27 个迁移（既有 22 个加 PL-004 Phase A 新增 5 个）”。5 张 PL-004 Phase A 协调表（`023`–`027`）作为*区间*仍正确，但头条迁移数是 **40**，不是 27（slice-00 §1.3，已在 HEAD 重新确认：`startup.ts:206` 的 40 元素 `migrate()` 数组；完整 drift-fix 权威与更正见 `daemon-core.md`）。

## 2. 六个 host 作用域服务

六个 host 作用域领域服务实现该层（`architecture.md` §5 L649–658；文件已在 HEAD `packages/daemon/src/domain/` 重新确认）。路由导入这些；服务无 Hono：

- **`stream-store.ts`** —— L1 stream：幂等发出（按 `stream_item_id`）、带游标分页的时间序列表，外加 source、destination、精确 tag 与闭时间窗过滤，软归档。`direction=latest` 在取最新有界页之前先应用所有过滤，再按时间顺序返回该页。
- **`queue-repository.ts`** —— L3 队列：create、claim/unclaim、update（带 hot-potato 严格拒绝 `done` 的通用状态变更器）、事务性 handoff（在单事务内把 source 关闭为 `handed-off` 并创建新所属 qitem）、pod 兜底重路由、逾期查找、nudge/heartbeat 跟踪。跨 rig 校验钩子以 `validateRig` 构造选项暴露。
- **`queue-transition-log.ts`** —— append-only 状态转换日志；由 `queue-repository.ts` 使用，在 `queue_repository.transitionLog` 上只读暴露。
- **`hot-potato-enforcer.ts`** —— 承重 API 契约的纯校验器（见 §3）。
- **`inbox-handler.ts`** —— 邮箱处理器：认证投递（按 `inbox_id` 幂等）、absorb（把 pending 条目提升为 `queue_item`，幂等）、deny（记录原因）。认证检查是可插拔构造钩子。
- **`outbox-handler.ts`** —— 发送方 outbox：幂等记录、标记 delivered/failed、列表。不发任何 event-bus 事件（纯审计）。

`queue-stuck-sweep.ts` 中的常驻检测器经队列仓库创建发现，`evidenceRef: rig queue show <source-qitem-id>` 指向底层持久工作行。这满足既有人工路由证据契约而不改变目标解析：一个被接纳的发现仍可能不可路由。重复检测刷新既有发现；当 source 条件消解时，sweep 关闭自己的发现。

## 3. hot-potato 关闭契约（队列关闭在何处强制）

`hot-potato-enforcer.ts` 是承重 API 契约的纯校验器。已在 HEAD 重新确认（`hot-potato-enforcer.ts:10–24`）：

`state=done` 要求 `closure_reason ∈ {handed_off_to, blocked_on, denied, canceled, no-follow-on, escalation}`。原因 `handed_off_to | blocked_on | escalation` 还额外要求 `closure_target`：

- `handed_off_to` —— 工作继续在另一席位进行（`closure_target` = 新 owner）。
- `blocked_on` —— 工作挂起等待另一 qitem（`closure_target` = 阻塞者 `qitem_id`）。
- `denied` —— 接收方拒绝了工作（`closure_target` = 原因文本）。
- `canceled` —— 发送方或接收方撤回（`closure_target` = 备注）。
- `no-follow-on` —— 终态完成，无需他事。
- `escalation` —— 上提到更高层（`closure_target` = 升级目标）。

`closure_required_at` 的层级→SLA 映射也在 `hot-potato-enforcer.ts`。该校验器由 `QueueRepository.update()`（及 `updateWithinTransaction()`）调用，故关闭在后台服务事务边界强制——workflow runtime 在关闭时*投影*但不门控它（见 `workflow-runtime.md`）。

## 3b. 跨 host 队列路由（v0.4.6 —— OPR.0.4.6.MH3）

队列的两个协调写动词——**仅 create + handoff(-and-complete)**——是 host 感知的：写体可携带带外 `hostId` 信封（BR-1——会话字符串处处保持 `member@rig`；三段式 `agent@rig@host` 形态是 CLI 输入语法糖，从不离开 CLI 边缘）。该机制**泛化已交付的 mission-control 先转发后剥离写模板**（`routes/mission-control.ts` § remote action）：一个共享路由层辅助（`forwardQueueWrite`，`routes/queue.ts`）在后台服务侧解析 host 注册表（bearer 从不抵达调用方），拒绝 ssh 声明的 host（`unsupported-transport`——后台服务→后台服务路径仅 http，因为正是它触发远端 nudge），剥离 `hostId`，并在具名写类时限（`QUEUE_FORWARD_TIMEOUT_MS`）下经 `remoteJsonRequest` 转发整个 body。origin 的响应逐字返回；传输失败映射为结构化的、按 host 命名的分类（`remote_queue_write_failed`：unknown-host / unsupported-transport / unreachable / auth-failed / remote-error）。跨 host 路径上从不写本地行。

**模型：origin 拥有记录、至少一次 + 幂等、消息传递式关闭（绝不用 2PC）。**

- **Origin 拥有记录。** qitem 位于目标 host 的 DB；该行即记录。目标后台服务自己的 `maybeNudge` 在其本地 tmux 触发（转发的 body 含 `nudge` 标志）——发送方后台服务从不跨越 host 边界。
- **幂等（arch Q-a）。** 转发方后台服务在首次转发*之前*铸造 `qitemId`，故每次重试带同一 id；去重骑在既有 `qitem_id TEXT PRIMARY KEY` 上。主键冲突时，身份字段匹配则 origin 返回已存行（幂等 absorb），不同则返回结构化 `qitem_id_reuse` 错误（`QueueRepository.create()` catch 路径 + `isQitemPrimaryKey`）。
- **跨 host handoff 编排（arch Q-c）。** 本地原子 close+create 不能跨两个 DB，故路由层编排（`crossHostHandoff`，`routes/queue.ts`）执行：先在目标 host 创建后继（经单转发辅助），第二步才关闭本地 source（`QueueRepository.closeCrossHostHandoffSource`）——绝不相反。两次之间崩溃留下一个活的重复，由幂等重驱动收敛；相反顺序会留下一个指向不存在后继的已关闭 source（掉落的土豆——唯一禁止的结局）。后继 id 是*派生*而非铸造：`deriveCrossHostSuccessorId(source, destination, host)` → `qitem-xh-<sha256[:16]>`——纯无状态函数，故重驱动跨后台服务重启派生出同一 id 并在目标主键上 absorb。*（具名残差，为 at-least-once/无 2PC 栅栏所固有：若重驱动命名*不同* destination，则派生出不同 id，无法 absorb 早先的后继——该孤儿经链 + 来源 tag 保持可见；source-close 冲突检查会暴露分歧。）*
- **跨边界关闭。** source 以 `closure_reason=handed_off_to` 与 `closure_target=member@rig@<host>` 关闭——三段式在*那里*合法，因为 `closure_target` 是不透明的审计/展示元数据，仅做存在性检查，从不被解析做路由（arch R1；任何 PR 把它当会话字符串解析都是违规）。该豁免恰好覆盖 `queue_items` 的 `closure_target` 列及其在 `queue_transitions` 上的逐字镜像——别无其他。特别地，转换日志的自由文本 `transition_note` 也是持久载体：铸造的跨 host close 备注只命名两段式 `toSession`（rev1-r2 B1）。`handed_off_to` 与其他所有会话字符串载体保持两段式。重驱动语义：已终态 + 匹配 `closure_target` = absorb；不匹配 = 结构化 `cross_host_close_conflict`（409）。后继携带 `chain_of_record = [...source.chain, source.qitemId]`——A 侧 id 在 B 上是不透明谱系标识（arch R2b；不在 B 的 DB 解引用）——外加来源 tag `cross-host` + `from-host:<self-declared name>`（诚实尽力，非认证身份）。
- **边界纪律。** Claim / update / inbox 按原则保持本地（跨 host handoff 后继生活在其 worker 所在处）；对转发项的发送方操作是具名后续。本地（无 host）路径与 MH-3 之前行为字节一致；hot-potato 校验契约（§3）跨边界不被削弱。

## 4. 协调事件

> Drift-fix D8 / OPEN-4（逐字保留，slice-00）：`architecture.md` §3 L394 称“既有 32 个 PL-004 事件不动”，L410 称“既有 20 个 PL-004 事件不变”——这两条正文论断彼此内部不一致，且早于 0.3.x。**不要沿用任一数字。** 当前 `RigEvent` 联合（`packages/daemon/src/domain/types.ts:94`）共 **73 个联合成员**（slice-00 §1.8，已在 HEAD 重新确认：`grep -cE '^\s*\| \{ type: '` = 73）。精确的 PL-004 专属 vs PL-005 专属子划分在不引入 slice 对全部 73 个成员做分类的情况下，无法从静态检视调和；slice-00 OPEN-4 标记此点并保留，不抹平。

这些服务发出的协调事件（已在 HEAD `domain/types.ts` 重新确认）：`stream.emitted`（StreamStore.emit，`types.ts:155`）；`queue.created` / `queue.handed_off` / `queue.claimed` / `queue.unclaimed` / `qitem.fallback_routed` / `qitem.closure_overdue`（QueueRepository）；`inbox.absorbed`（`types.ts:162`）/ `inbox.denied`（InboxHandler）。`architecture.md` §8 L987–990 把这些列为“9 个协调事件”；HEAD 处更宽的 `stream|queue|inbox|qitem` 事件族计数为 10（`stream` 1 + `queue` 5 + `inbox` 2 + `qitem` 2）——作为重新推导的族计数陈述，而非有争议的 PL-004 子计数（OPEN-4）。

两个 SSE 表面流送协调事件：`/api/stream/watch`（别名 `/api/stream/sse`，`routes/stream.ts:117–118`）送新 stream 条目，`/api/queue/watch` 送队列/inbox 事件。事件日志保持 append-only、以 SQLite 为后端。`rig stream watch` 是 `/api/stream/sse` 的瘦单连接消费者；不新增后台服务路由或重连策略。

## 5. 路由表面

- `/api/stream`（`server.ts:489`）—— `POST /emit`（`routes/stream.ts:24`）、`GET /list`（`:56`，含 `sourceSession`、`hintDestination`、`hintTag`、`since`、`until` 过滤）、`GET /watch` + `/sse` SSE（`:117`）、`GET /:streamItemId`（`:121`）、`POST /:streamItemId/archive`（`:130`）。
- `/api/queue`（`server.ts:490`）—— `POST /create`（`routes/queue.ts:99`）、`POST /:qitemId/claim`（`:144`）、`POST /:qitemId/unclaim`（`:157`）、`POST /:qitemId/update`（`:170`），加 handoff/list/watch 表面。

## 另见

- `daemon-core.md` —— 后台服务接线、40 迁移集、路由表面。
- `workflow-runtime.md` —— 在关闭时投影的 PL-004 Phase D runtime。
- `mission-control.md` —— 基于 `queue_items` 的 PL-005 队列可观测。
- 源码根：`packages/daemon/src/domain/{stream-store,queue-repository,queue-transition-log,hot-potato-enforcer,inbox-handler,outbox-handler}.ts`、`packages/daemon/src/routes/{stream,queue}.ts`。
