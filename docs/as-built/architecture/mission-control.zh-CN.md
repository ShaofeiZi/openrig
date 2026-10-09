---
kind: as-built
title: Mission Control —— 队列可观测 + 7 动词契约（PL-005）
status: active
topics: [coordination, observability]
domains: [engineering-advisor, operating-advisor, orchestrator, human-operator]
applies-when: |
  需要了解后台服务支撑的 Mission Control 表面如何工作——七个视图、七个写动词、
  动作审计表、bearer-token 中间件，或队列可观测如何映射到 PL-004 源。
siblings: [coordination-primitive.md, workflow-runtime.md, ../ui/project-and-for-you.md]
prerequisite-reads: [../README.md, coordination-primitive.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# Mission Control —— 队列可观测 + 7 动词契约（PL-005）

Mission Control（PL-005）是后台服务支撑的队列可观测表面：在既有 shell 内集成的产品 UI（顶层 `/mission-control` 路由，**不是**新 managed app），坐于 PL-004 Phase A 协调原语之上。按 PRD 验收标准：七个视图、七个动词、一等人类席位、recent-ships=10、以及后台服务支撑的动作审计表；无旧 dashboard 迁移/切换（`architecture.md` §3 L368、L390）。

> 已对照 HEAD `7eaf524c` 核验。Mission Control 是 PL-005（0.3.0 早期嫁接）；插件与 Claude auto-compaction 是 0.3.1 特性，此处不反向归属（slice-00 0.3.0-ground-truth seams a/row-7）。

## 1. 七个视图

`MISSION_CONTROL_VIEWS` 是规范视图清单（已在 HEAD `packages/daemon/src/domain/mission-control/mission-control-read-layer.ts:32–42` 重新确认）：`my-queue`、`human-gate`、`fleet`、`active-work`、`recent-ships`、`recently-active`、`recent-observations`。

七个视图全部以承重 9 字段手机友好内容模型返回行（rig/mission 名、当前 phase、active|idle|attention|blocked|degraded、next-action、pending-human-decision、read-cost、last-update 时间戳、confidence/freshness、证据链接）。该模型跨全部 7 视图不可协商；UI 可紧凑渲染，JSON 保留全部 9 字段（`architecture.md` §3 L370）。

`MissionControlReadLayer` 把每个视图映射到其真相源路径（`mission-control-read-layer.ts:4–14`，已在 HEAD 重新确认）：

- `my-queue` / `human-gate` / `active-work` / `recent-ships` 经 `QueueRepository` 查询 PL-004 Phase A `queue_items`。
- `fleet` 消费逐 rig CLI 能力缓存 + 队列摘要。
- `recently-active` 委托给 PL-004 Phase B `ViewProjector.show("recently-active")`。
- `recent-observations` 经 `StreamStore` 读 PL-004 Phase A `stream_items`。

文件系统回退（`~/.openrig/stream/<date>.jsonl`、原始队列文件 grep）是优雅降级辅助，**不是**主路径（`architecture.md` §3 L378）。

> 范围注（slice-00 0.3.0-ground-truth OPEN-3，保留）：For-You 动词子集的确切范围是未决的 velocity slice-01 裁定。本模块描述**系统级** 7 动词词汇（已证，slice-00 §1.6/seam-c）。它**不**枚举 For-You 表面子集——该表面在撰写时见 `../ui/project-and-for-you.md`。

## 2. 七个动词（写契约）

七个动词经承重 `MissionControlWriteContract` 执行（已在 HEAD `packages/daemon/src/domain/mission-control/mission-control-write-contract.ts:27–36` 重新确认）：

| 动词 | 效果 |
|---|---|
| `approve` | `state="done"`、`closure_reason="no-follow-on"` |
| `deny` | `state="done"`、`closure_reason="denied"` |
| `route` | `state="done"`、`closure_reason="handed_off_to"`、`closure_target`+`handed_off_to`=路由目标；在路由目标处创建新 qitem（1-hop） |
| `annotate` | 无队列变更；仅审计记录 |
| `hold` | `state="blocked"`、`closure_reason="blocked_on"` |
| `drop` | `state="done"`、`closure_reason="canceled"` |
| `handoff` | 四步形状（见下） |

每个动词是一个原子后台服务事务：经 `QueueRepository.updateWithinTransaction()` 做队列变更（保留 Phase A hot-potato 关闭校验——见 `coordination-primitive.md` §3）+ `mission_control_actions` 中审计行 + 持久化 `mission_control.action_executed` 事件，全在一个 `db.transaction` 内。四步 `handoff` 形状（source-update + destination-create + opt-in 尽力通知 + 审计记录追加）经原子验证；通知失败**不**回滚持久变更（PRD 不变量）。失败注入把 source 关闭 + 审计行 + 新 qitem 一起回滚（`architecture.md` §3 L380；`mission-control-write-contract.ts:5,15`）。

## 3. 动作审计表

`mission_control_actions`（`037_mission_control_actions.ts:54` `CREATE TABLE IF NOT EXISTS mission_control_actions`）在 API 表面 append-only：它记录经 Mission Control 的每个操作者动作，带 before/after qitem 快照供取证重建。列含 `action_verb`（TEXT，应用层枚举强制，`:56`）与 `acted_at`（TEXT NOT NULL ISO 时间戳）；索引 `(acted_at DESC, action_verb)`、`(qitem_id, acted_at DESC)`、`(actor_session, acted_at DESC)`（`037_mission_control_actions.ts:28–44`）。Phase B 未加迁移——这张 Phase A 表是唯一数据源（`architecture.md` §3 L364、L392）。

## 4. PL-005 Phase B —— bearer 中间件、通知、审计浏览

Phase B 扩展后台服务 Mission Control 表面：

- **Bearer-token 中间件** —— `packages/daemon/src/middleware/auth-bearer-token.ts`（已在 HEAD 重新确认：头 `auth-bearer-token.ts:1–9` “PL-005 Phase B”）。经 Node `crypto.timingSafeEqual` 做常量时间 bearer 比较；后台服务在非回环绑定接口**且**空 bearer 配置时拒绝启动（启动侧检查）。写动词强制 bearer：`app.post("/action", requireAuth)`（`routes/mission-control.ts:294`）与 `app.post("/notifications/test", requireAuth)`（`:295`）。v0 是 bearer-on-write；无 OAuth/SSO/每用户模型。
- **通知分发器** —— 两个适配器（`notification-adapter-ntfy.ts` 默认 + `notification-adapter-webhook.ts` 备选；经 `OPENRIG_NOTIFICATIONS_MECHANISM` 环境变量选择）加 `notification-dispatcher.ts`（已在 `domain/mission-control/` 重新确认）。推荐经 tailnet 用 ntfy.sh 到操作者手机。
- **只读审计历史浏览** —— `audit-browse.ts` 基于 `mission_control_actions`，暴露于 `GET /api/mission-control/audit`（`routes/mission-control.ts:346`），带过滤与 `(limit, before_id)` 分页，按 SQLite `rowid` 做游标（`architecture.md` §3 L392）。

## 5. Mission Control 事件

> Drift-fix D8 / OPEN-4（逐字保留，slice-00）：`architecture.md` §3 L394 称“既有 32 个 PL-004 事件不动”——与 §3 L410 的“20”内部不一致，且早于 0.3.x。**不要沿用任一数字。** 当前 `RigEvent` 联合（`packages/daemon/src/domain/types.ts:94`）共 **73 个成员**（slice-00 §1.8，已在 HEAD 重新确认）；增量 `mission_control.*` 事件在下方描述，**不**断言有争议的 PL-004 子计数。

已在 `domain/types.ts:212–218` 重新确认：Phase A 加 `mission_control.action_executed`、`mission_control.cli_drift_detected`、`mission_control.view_refreshed`；Phase B 加 `mission_control.notification_sent`、`mission_control.notification_failed`（HEAD 处 5 个 `mission_control.*` 成员）。

## 6. 路由表面

`missionControlRoutes({ bearerToken })` 挂载于 `server.ts:498`。关键路由（`routes/mission-control.ts`）：`GET /views`（`:245`）、`GET /cli-capabilities`（`:250`）、`POST /action`（`:298`，auth 门控）、`GET /audit`（`:346`）、`POST /notifications/test`（auth 门控），加 SSE 表面。集成 UI 是 `packages/ui/src/routes.tsx` 中挂载 `MissionControlSurface` 的 `/mission-control` 顶层路由（`architecture.md` §3 L390）；UI 细节落在 `../ui/project-and-for-you.md`。

## 另见

- `coordination-primitive.md` —— Mission Control 所读的 PL-004 Phase A `queue_items`/`stream_items` 源，以及动词遵守的 hot-potato 关闭契约。
- `workflow-runtime.md` —— PL-004 Phase D 事务性 scribe runtime。
- `../ui/project-and-for-you.md` —— UI 表面对应（撰写阶段）。
- 源码根：`packages/daemon/src/domain/mission-control/`、`packages/daemon/src/middleware/auth-bearer-token.ts`、`packages/daemon/src/routes/mission-control.ts`、`packages/daemon/src/db/migrations/037_mission_control_actions.ts`。
