---
kind: as-built
title: 传输、转录、聊天、Ask
status: active
topics: [coordination, observability]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  需要了解 rig send/capture/broadcast 如何工作、pipe-pane 转录捕获与 rg/grep
  搜索如何行为、持久化 rig 聊天（SQLite + SSE）如何建模、rig ask 收集什么，
  或 MCP 工具名 vs tmux 元数据键的确切命名区分。
siblings: [daemon-core.md, lifecycle-snapshot-restore.md]
prerequisite-reads: [../README.md, daemon-core.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# 传输、转录、聊天、Ask

通信与历史层：tmux 是传输，不是真相。Send/capture/broadcast 用诚实错误包装 tmux；转录是原始 pipe-pane 捕获；聊天是后台服务支撑 SQLite；`rig ask` 收集证据但从不调 LLM。

> 已对照 HEAD `7eaf524c`（`git describe` → `v0.3.1-6-g7eaf524c`）核验。包版本 **0.3.1**（slice-00 §1.1）。源码按 `architecture.md` 标题（§5 传输与通信、§6 通信/转录/聊天流、§11 兼容注）依 slice-08 §10.1 定位——行号仅供参考。

## 1. 命名轴（D5——先读）

本模块携带 D5 漂移，它有**两条独立轴**，绝不可混淆或 blanket 替换（已存 `feedback_release_prep_three_layer_depersonalization`：重命名是有范围的，不是全局）。逐处源码核验：

**轴 1 —— MCP 工具名：`rig_*`（architecture.md 已陈旧 → 更正）。** slice-00 §1.4 确认全部 17 个 MCP 工具都是 `rig_*`。`architecture.md` 中的 `rigged_*` 引用是早于 v0.2.0 重命名的陈旧文本：

> Drift-fix D5（MCP 工具名轴）—— `architecture.md` §5 `node-inventory.ts` 描述称 MCP `rigged_rig_nodes`；§6 聊天流称 MCP `rigged_chatroom_send` + `rigged_chatroom_watch`。更正为 **`rig_*`**。已在源码重新确认：`mcp-server.ts:288` 注册 `"rig_rig_nodes"`、`:305` `"rig_send"`、`:339` `"rig_capture"`、`:364` `"rig_chatroom_send"`、`"rig_chatroom_watch"`（第 17 个工具）。非测试产品源码中零 `rigged_chatroom_send` / `rigged_send` / `rigged_rig_nodes`（@HEAD grep 干净）。slice-00 §1.4；重命名落在 v0.2.0 之前的 `b183c50c`。

**轴 2 —— tmux 元数据键：`@rigged_*`（architecture.md 正确 → 不要改）。** claim/bind 时写的 tmux 元数据键与 MCP 工具名是**两回事**，且**未**被重命名：

> Drift-nuance D5（tmux 元数据键轴）—— `architecture.md` §6“Whoami 与 adopted-session 对等流”列 `@rigged_node_id`、`@rigged_session_name`、`@rigged_rig_id`、`@rigged_rig_name`、`@rigged_logical_id`。这些**原样正确**——已在源码逐字核验：`claim-service.ts:77-81` 恰好写这五个 `@rigged_*` 键。不要 blanket sed `rigged` → `rig`；这是逐处核验，不是全局替换。（元数据键轴详见 `agent-spec-and-startup.md` §6。）已在 HEAD 重新确认 `claim-service.ts:77-81`。

## 2. 传输与通信领域服务

（`architecture.md` §5“传输与通信”）

- `session-transport.ts` —— 通信原语：send/capture/broadcast，带会话解析（规范 + 旧版名）、mid-work 检测、诚实错误报告、pod/rig/全局定向。
- `transcript-store.ts` —— pipe-pane 转录管理：读时 ANSI 剥离、边界标记、readTail、grep。文件系统后端，**不是** SQLite。
- `history-query.ts` —— 转录 + 聊天搜索。优先 `rg`，回退 `grep -E`，呈现用了哪个后端。重新确认：`history-query.ts:7` `backend: "rg" | "grep" | "none"`；`:103` exec `rg -i --no-filename -e <pattern>`；`:108` 返回 `backend: "rg"`。
- `ask-service.ts` —— 上下文工程证据包：收集 rig 摘要加转录摘录、聊天摘录、不足状态、指引。**不**调外部 LLM。
- `chat-repository.ts` —— 持久化 rig 作用域聊天：`chat_messages` 表 CRUD、SSE 兼容事件发出。

路由：`routes/{transport,transcripts,ask,chat,whoami}.ts`——全部已在 HEAD 确认存在。

## 3. 通信流

（`architecture.md` §6“通信流”）

`rig send <session> "message"` → CLI → `POST /api/transport/send` → `SessionTransport`：

1. 解析会话名（规范或旧版；按 session/rig/pod/全局）。
2. 检查 mid-work 状态（除非 `--force`）——已重新确认 `session-transport.ts:136-141`（`findPatternEvidence(recentLines, MID_WORK_PATTERNS)`）；旧版 mid-work 检查在 `:666`。
3. 两步 tmux send：在每个负载尺寸下先用 `paste-buffer -d -r -p` 粘贴唯一文件/缓冲 → 约 200ms 延迟 → 单独 `C-m`。Bracketed paste 在支持的 TUI 中保留多行输入；负载从不进 shell 参数。成功 paste 证明传输执行，不证明运行时消费。（`session-transport.ts:717` 提交 `C-m`。）
4. 可选 `--verify`：捕获发送后 pane，检查消息可见性（`session-transport.ts:305` `verify?`；`:694` `if (opts?.verify)`）。
5. 失败时带原因的诚实结果。

Architecture Rule 18（保留，`architecture.md` §7）：tmux 是传输，不是真相——`send/capture/broadcast` 可靠包装 tmux 并带诚实错误。

### 3b. 跨 host 协调动词（v0.4.6 —— OPR.0.4.6.MH4）

`rig send/capture/transcript/broadcast --host <id>`（及会话目标动词上的 `agent@rig@host` 目标语法糖）跨 host 边界，**零后台服务侧改动**——远端后台服务既有本地路由做全部工作；唯一净新增是 CLI 传输分支。

- **接缝原则（arch 规则）：方向性 + 调用方选接缝。** 来自**可携带 bearer**调用方（CLI 在本地解析注册表 bearer）的**单边**远端操作走**CLI 直连**，经已交付 `runRemoteHttpOp`——一跳，无本地后台服务参与（`ps --all-hosts` 先例）。**双边**操作（MH-3 的队列 handoff 关闭本地 source 并创建远端后继——本地后台服务拥有事务的一半）或**不可携带 bearer**调用方（浏览器：MC-action、MH-2 的 read-through）用**后台服务侧先转发后剥离**。MH-4 的四个动词是来自 CLI 的纯单边远端操作。
- **传输由 host 条目决定（ssh XOR http），从不是每调用选择：** ssh host 为 send/capture 保留已交付 shell-out 字节逐字；http host（`pair` 前门的种类）走 CLI 直连分支到 `POST /api/transport/send|capture|broadcast` / `GET /api/transcripts/*`，带本地 CLI 构建的**相同** body/路径（一路由，两调用方 = 构造上 wrap 对等）。transcript 与 broadcast 仅 http（无 ssh 路径）；错传输动词以结构化需求错误死——从不回退。
- **终端 bearer 姿态（具名限制，v0——仅 `/api/transport/*`）：** 远端的传输路由（send/capture/broadcast）门控于**其终端 bearer 类**（`OPENRIG_TERMINAL_BEARER_TOKEN`，默认 null → 直通；按设计 tailnet 是认证边界），而 CLI 在配置了时呈现来自 `hosts.yaml` 的**注册表** bearer；对纯 URL 匿名 host 则省略 `Authorization` 头。远端强制**不同**终端 bearer 呈现为结构化 `permission-gate` 步骤（从不停滞，从不静默）。补救：把远端终端 bearer 设成配对注册表 bearer，或依赖 tailnet 边界。**转录读取刻意在此类之外（arch n2）：** `/api/transcripts/*` 无门挂载（`server.ts`——已交付开放路由姿态；带路由级凭证脱敏作为保护原语的后台服务本地信任边界），故 permission-gate `send --host` 的错终端 bearer **不**门控 `transcript --host`——读取持续成功，证明矩阵不得把认证失败类当作四动词统一。跨 tail/grep/full 的一致转录读认证策略按 `routes/transcripts.ts` 自身注释（orch approved-option-a）是具名未来 slice。Bearer 类统一同样是**具名后续**，非 v0（无未被要求的认证机制）。
- **BR-1 成立：** 三段式仅为 CLI 边缘语法糖（后缀须匹配**已注册** host id，否则直通 + 响亮 host 提示）；到达任一后台服务的每个会话字符串保持 `member@rig`；host 带外传输。持久跨 host 协调仍是 MH-3 的队列——MH-4 不加队列表面。

## 4. 转录流

（`architecture.md` §6“转录流”）

1. `NodeLauncher` 在 tmux 会话创建后（harness 启动前）立即启动 `pipe-pane`。
2. 原始终端输出流到 `~/.openrig/transcripts/{rig-name}/{session-name}.log`。
3. `TranscriptStore` 拥有路径约定、读时 ANSI 剥离、边界标记、`readTail`、`grep`。
4. `rig transcript <session> --tail N / --grep "pattern"` 提供面向智能体访问。
5. 恢复时：重新启动前写边界标记；pipe-pane 重连同一文件（追加）。（恢复侧细节见 `lifecycle-snapshot-restore.md` §3。）
6. `rig ask` 收集 rig 摘要加转录摘录、聊天摘录、不足状态与指引。

Architecture Rule 19（保留）：转录是经 pipe-pane 的原始捕获，读时 ANSI 剥离；优先 `rg`，回退 `grep -E`。Rule 22：`rig ask` 是上下文工程——收集证据，**不**调外部 LLM；智能体**就是** LLM。

## 5. 聊天流

（`architecture.md` §6“聊天流”）

1. `rig chatroom send <rig> "message"` → `POST /api/rigs/:rigId/chat/send` → `ChatRepository.addMessage()`。
2. SSE：`GET /api/rigs/:rigId/chat/watch` 投递实时消息。
3. 历史：`GET /api/rigs/:rigId/chat/history` 返回完整频道历史；`POST /api/rigs/:rigId/chat/topic` 持久化 topic 标记。
4. UI：rig 抽屉中聊天房间标签页。
5. MCP：**`rig_chatroom_send` + `rig_chatroom_watch`**（D5 轴 1 更正——`architecture.md` §6 称 `rigged_*`；源码 `mcp-server.ts:364` + 第 17 个工具）。
6. 真相源：后台服务支撑 SQLite（`chat_messages` 表），**不是** tmux 回滚。

**ChatMessage** 类型（`architecture.md` §4）：持久化 rig 作用域消息——`id`、`rigId`、`sender`、`kind`、`body`、`topic`、`createdAt`。

## 6. 兼容注（逐字保留，`architecture.md` §11）

本层的刻意限制：

- 注 4 —— `rig ask` 仅收集上下文；不调外部 LLM。智能体对收集的证据推理。
- 注 5 —— 转录搜索优先 `rg` 但回退 `grep -E`；搜索质量/性能因后端而异。
- 注 6 —— 聊天仅 rig 作用域：无跨 rig 频道或 DM。
- 注 7 —— `rig send` 的 `--verify` 检查 pane 内容中消息可见性，但可能因既有匹配内容产生误报。已知限制。

（完整 §11 兼容注清单见 `architecture-rules-and-event-system.md`。）

## OPEN / 保留项

- **D5（要小心的那个——逐处解决，不 blanket 替换）：** 轴 1（MCP 工具名）把 `rigged_*` 更正为 `rig_*`（3 处：§5 node-inventory、§6 聊天流 ×2）。轴 2（tmux `@rigged_*` 元数据键）在 `claim-service.ts:77-81` 逐字核验正确，保持不动。本模块拆分内容无 slice-00 数字漂移。

## 另见

- `daemon-core.md` —— 传输/转录/聊天/ask 在 49 个路由挂载之中；MCP 工具数（17，`rig_*`）锚定在那。
- `agent-spec-and-startup.md` §6 —— tmux `@rigged_*` 元数据键轴细节（whoami/adopt）。
- `lifecycle-snapshot-restore.md` §3 —— 恢复侧转录边界标记。
- `coordination-primitive.md` §3b —— MH-3 的跨 host 队列路由（§3b 单边 CLI 直连动词的双边后台服务转发孪生）。
- `cli-reference.md` § 跨 host 执行——逐动词传输能力表、解析规则与 http 失败分类（MH-3 + MH-4）。
- 源码根：`packages/daemon/src/domain/{session-transport,transcript-store,history-query,ask-service,chat-repository}.ts`、`packages/daemon/src/routes/{transport,transcripts,ask,chat}.ts`、`packages/cli/src/mcp-server.ts`、`packages/cli/src/{remote-host-ops,cross-host-target,cross-host-executor}.ts`（v0.4.6 MH-4）。
