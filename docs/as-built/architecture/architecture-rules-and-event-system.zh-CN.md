---
kind: as-built
title: 架构不变量、事件系统、兼容性说明
status: active
topics: [runtime-control, observability, doctrine]
domains: [engineering-advisor, operating-advisor, review]
applies-when: |
  需要代码库强制的横切架构不变量（25 条架构规则 + 启动/import 约束）、
  RigEvent 联合的形状及其 SSE 投递表面，或仍描述交付系统的有意兼容性边界。
siblings: [daemon-core.md, coordination-primitive.md]
prerequisite-reads: [../README.md, daemon-core.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# 架构不变量、事件系统、兼容性说明

本模块汇集不属于任何单一子系统的横切不变量：代码库自持的架构规则、事件系统形状，以及有意的兼容性边界。

> 已对照 HEAD `7eaf524c`（`git describe` → `v0.3.1-6-g7eaf524c`）核验；三个包版本均为 **0.3.1**（slice-00 §1.1）。HEAD 携带 6 个未发布的 0.3.2 提交；不存在 `v0.3.2` 标签。

## 1. 架构规则

这些是代码库为自保而保留的不变量（`architecture.md` §7）。规则 6（启动分层）与规则 7（restore 策略收窄）即 spec/启动契约——其流程细节见 `agent-spec-and-startup.md`；在此作为系统级不变量重述。

1. `domain/` 与 `adapters/` 内零 Hono。
2. routes 依赖 domain；domain 从不依赖 routes。
3. 共享 DB 句柄不变量在构造时强制。
4. 重启是引擎优先：领域服务先落地，再重接公共表面。
5. pod 感知模型中运行时由成员权威决定。
6. 启动分层叠加且有序：agent 基座 → profile → rig culture 文件 → rig startup → pod startup → member startup → 操作者调试追加。
7. Restore 策略收窄单向：`resume_if_possible` → `relaunch_fresh` → `checkpoint_only`。
8. 基座/import 冲突告警；歧义 import/import 未限定引用响亮失败。
9. Bundle 组装与启动文件解析使用以所属产物为根的 containment 检查。
10. Restore replay 使用无分类的投影意图，而非启动时陈旧的 `no_op` / 冲突分类。
11. 启动状态是显式会话状态：`pending`、`ready`、`failed`。
12. 会话新近度依赖单调 ULID：`session-registry.ts` 使用 `monotonicFactory()`；restore 按最大 ULID 选最新会话。
13. 就绪检查是带指数退避与可配置超时的重试循环，使用适配器专属探针（Claude TUI 指标、Codex 就绪消息、终端立即就绪）。
14. 恢复状态锁定：`resumed` / `rebuilt` / `fresh`。`rebuilt` = 由产物组装的新进程。
15. 恢复诚实：失败 resume 响亮失败。无自动 fresh 回退。fresh 启动只能是显式后续动作。
16. `up`、`down`、`restore`、`snapshot create` 后必须交接：发生了什么 + 当前状态 + 下一步动作。
17. 会话命名：`{pod}-{member}@{rig}`——人写、系统校验。不生成、不 slugify。
18. 通信：tmux 是传输，不是真理。`send/capture/broadcast` 可靠封装 tmux 并带诚实错误。
19. 转录：经 pipe-pane 原始捕获，读取时剥离 ANSI。优先 `rg`，回退 `grep -E`。
20. 配置优先级：CLI 标志 > 环境变量 > 配置文件（`~/.openrig/config.json`，并从 `~/.rigged/config.json` 旧版回退）> 默认。
21. 半确定性校准：构建智能体高频使用之物。智能体从错误消息处理边缘情况。
22. `rig ask` 是上下文工程：收集证据，不调用外部 LLM。智能体即 LLM。
23. Spec 库真理是磁盘上的 YAML；后台服务拥有结构化评审/索引/缓存层。
24. Adopted-session 对等是 tmux 元数据对等，而非伪造的环境变量对等。
25. 人类可读 ID 仅为 UI 展示辅助。CLI/API/MCP/后端保留完整规范 id。

### 启动动作约束

- 无 shell 启动动作。
- 动作类型仅 `slash_command` 与 `send_text`。
- 非幂等动作不得在 restore 时应用。
- 重试失败启动按 restore 处理。

### 远端 import 约束

重启支持 `local:...` 与 `path:/abs/...` 智能体引用。远端 `agent_ref` 源仍不支持，在 preflight 失败（`architecture.md` §7“Remote import constraints”；在兼容性说明 1 重述）。

## 2. 事件系统

后台服务的事件表面是单一的 `RigEvent` 判别联合。

> Drift-fix D8 / OPEN-4（逐字保留，slice-00）：`architecture.md` §8 称“PL-004 Phase A 新增 9 个协调事件”，并（在 §3）称“既有 32 个 PL-004 事件”/“既有 20 个 PL-004 事件”——内部不一致、彼此冲突的 PL-004 子计数。**不要沿用 9 / 32 / 20 这些数字。**`architecture.md` §8“当前生产代码中发出”/“在联合中但尚未发出”的清单也早于 0.3.x，已陈旧。下面的联合形状是在 HEAD 从源码重新推导的，不是迁移来的。

`RigEvent` 声明于 `packages/daemon/src/domain/types.ts:94`（`export type RigEvent =`），贯穿 `types.ts:218`。它有 **73 个联合成员**（slice-00 §1.8，已在 HEAD 重新确认：对 L94–218 执行 `grep -cE '^\s*\| \{ type:'` = 73）。73 个声明的 `type:` 字面量每一个都在 `packages/daemon/src/{domain,routes}` 某处被构造（已在 HEAD 复核：domain+routes 中 `type: "<x>"` 字面量集合恰好等于 73 个联合成员——零个仅在联合中却从不被引用的类型）。

### 按前缀的事件族（HEAD 处 grep 核验）

下面每个计数都是对联合主体（`types.ts:94–218`）新做的、经一手源码 grep 核验、明确标注的按前缀族计数——不是有争议的 PL-004 子计数（OPEN-4 裁定：标注的 grep 核验族计数为地面真理；`9`/`32`/`20` 数字禁用）。

| 前缀 | 成员数 | 示例 / 角色 |
|---|---|---|
| `node.*` | 7 | `node.added`（`types.ts:97`）… `node.startup_failed`（`:139`）——生命周期/启动 |
| `workflow.*` | 6 | PL-004 Phase D workflow runtime（细节见 `workflow-runtime.md`） |
| `watchdog.*` | 5 | `watchdog.evaluation_fired`（`:187`）… `watchdog.job_stopped`（`:191`）——PL-004 Phase C |
| `rig.*` | 5 | `rig.created` / `rig.deleted` / `rig.imported` / `rig.stopped` / `rig.expanded`（`:151`） |
| `queue.*` | 5 | PL-004 Phase A 队列生命周期（`:156`–`:159`、`:169`；细节见 `coordination-primitive.md`） |
| `package.*` | 5 | 旧版 package/install 引擎事件 |
| `mission_control.*` | 5 | PL-005 审计/通知（`:212`–`:218`；细节见 `mission-control.md`） |
| `bootstrap.*` | 5 | 旧版 bootstrap-run 事件 |
| `session.*` | 4 | 会话发现 / 状态 / detach / 消失 |
| `classifier.*` | 4 | PL-004 Phase B classifier-lease 生命周期 |
| `restore.*` | 3 | restore start/complete/reconcile（细节见 `lifecycle-snapshot-restore.md`） |
| `qitem.*` | 2 | `qitem.fallback_routed`（`:160`）、`qitem.closure_overdue`（`:161`） |
| `pod.*` | 2 | `pod.created`（`:135`）、`pod.deleted`（`:136`） |
| `inbox.*` | 2 | `inbox.absorbed`（`:162`）、`inbox.denied`（`:163`） |
| `continuity.*` | 2 | `continuity.sync`（`:140`）、`continuity.degraded`（`:141`） |
| 单例 | 11 | 各一个成员：`workflow_spec.*`、`view.*`、`stream.*`（`:155`）、`snapshot.*`、`seat.*`、`project.*`、`kernel.*`、`chat.*`（`:149`）、`bundle.*`、`binding.*`、`agent.*` |

族计数合计 73（15 个多成员族共 62 + 11 个单例），已在 HEAD 重新确认。

### 发出与投递

事件经各领域服务（`stream-store.ts`、`workflow-runtime.ts`、`restore-orchestrator.ts`、`node-launcher.ts` 等）与路由处理器中的 `eventBus.emit({ type: ... })` 构造并发出。事件日志 append-only、以 SQLite 为后端。

三个 SSE 投递表面（已在 HEAD 重新确认）：

- `GET /api/events` —— 全部事件的全局流（`server.ts:457` `app.route("/api/events", eventsRoute)`）。
- `GET /api/stream/watch` —— 新 stream 条目（`routes/stream.ts:117`）。
- `GET /api/queue/watch` —— 队列/inbox 协调事件（`routes/queue.ts:357`）。
- 聊天 SSE 流 `GET /api/rigs/:rigId/chat/watch` 为单个 rig 投递 `chat.message`（rig 作用域；见兼容性说明 6）。

> OPEN-4（逐字保留，slice-00）：精确的 PL-004 专属 vs PL-005 专属子划分不在此断言。`architecture.md` 的 `32`/`20`/`9` 数字内部不一致，在不对全部 73 个成员引入 slice 做分类的情况下无法调和——已标记，不抹平。上面 grep 核验的按前缀族计数是替代的地面真理。

## 3. 其余兼容性说明

仍描述交付系统的有意边界（`architecture.md` §11），已在 HEAD 核验为仍然成立：

1. 远端 `agent_ref` import 仍不支持（见 §1 远端 import 约束）。
2. 启动动作仍有意受限（`slash_command`、`send_text`）。
3. 为重启前数据与 v1 产物保留旧版兼容接缝。
4. `rig ask` 仅收集上下文——不调用外部 LLM（规则 22）。
5. 转录搜索优先 `rg`，回退 `grep -E`；质量/性能因后端而异。
6. 聊天仅 rig 作用域——无跨 rig 频道或私信。
7. `rig send` 的 `--verify` 检查 pane 内容以确认消息可见，但可能因既有匹配内容产生误报。已知限制。
8. 终端节点就绪仅指 shell 就绪——无服务健康探针。
9. `rig env down --volumes` 存在于 CLI 表面，但后台服务侧的显式 override 尚未完全接通。
10. Managed-app 服务表面仅作描述——OpenRig 不在作者撰写的启动/上下文文件之外，自动把服务 URL/令牌注入智能体提示。
11. 专家委派是约定式的，非自动——通过会话名或常规通信表面处理。

## 4. 交叉引用

`architecture.md` §12 自称为架构级真理来源，并指向 `codemap.md` 做逐文件结构。在模块化现状文档下，该职责被分散：本模块拥有不变量 + 事件形状；真理来源指针是重写后的 `../codemap.md` 导航索引。

## 另见

- `daemon-core.md` —— 接线、DB、迁移、启动；足迹 drift-fix。
- `coordination-primitive.md` —— PL-004 Phase A 队列/stream/inbox/outbox 事件。
- `workflow-runtime.md` —— PL-004 Phase D `workflow.*` 事件。
- `mission-control.md` —— PL-005 `mission_control.*` 事件。
- 源码根：`packages/daemon/src/domain/types.ts`（RigEvent 联合）、`packages/daemon/src/routes/{stream,queue}.ts`（SSE watch）、`packages/daemon/src/server.ts`（`/api/events`）。
