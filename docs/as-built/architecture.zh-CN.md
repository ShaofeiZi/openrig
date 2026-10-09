---
kind: as-built
title: architecture.md —— 已重组为模块化现状文档树（重定向桩）
status: superseded
topics: [knowledge-and-context]
domains: [engineering-advisor, operating-advisor, product-advisor]
applies-when: |
  你跟随了一条指向 docs/as-built/architecture.md 的旧引用。该单体文件
  已重组（slice-08，context-architecture-v1）为一个主题模块文件夹。
  请前往 README.md（领地地图）或 codemap.md（按用例查找），再到具名模块。
siblings: [README.md, codemap.md, ui.md]
prerequisite-reads: []
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# architecture.md 已重组进模块化现状文档树

这个单文件单体被拆成一个由可独立加载、带 frontmatter 标签的主题模块组成的文件夹（slice-08，`context-architecture-v1`）。对交付的后台服务/运行时的规范现状描述现位于 `architecture/`。本桩只是转发指针，使旧引用仍能解析。

**从这里开始：**

- [`./README.md`](./README.md) —— 领地地图与完整模块索引。
- [`./codemap.md`](./codemap.md) —— 导航索引：按用例查找表与源码根指针。当你知道*要什么*但不知*哪个模块*时用它。

## 主要内容迁到了哪里

architecture 内容现为 `architecture/` 下的 **14 个模块**（slice-08 重组的 13 个 + v0.4.4 加入的 `living-notes-review.md`）：

| 模块 | 迁入内容 |
|---|---|
| [`architecture/daemon-core.md`](architecture/daemon-core.md) | 后台服务启动、`createDaemon` 接线、SQLite schema/迁移集、路由挂载表面、系统概览、包边界。 |
| [`architecture/adapters-and-runtimes.md`](architecture/adapters-and-runtimes.md) | 五方法 RuntimeAdapter 契约；Claude/Codex/终端适配器；**Resume 诚实**层（§ Resume honesty）。 |
| [`architecture/coordination-primitive.md`](architecture/coordination-primitive.md) | PL-004 Phase A stream/queue/inbox/outbox；hot-potato 关闭契约；持久化交接。 |
| [`architecture/workflow-runtime.md`](architecture/workflow-runtime.md) | PL-004 Phase D Workflow Runtime —— spec 缓存、实例状态、步骤轨迹、事务性 scribe、看门狗策略。 |
| [`architecture/mission-control.md`](architecture/mission-control.md) | PL-005 Mission Control / 队列可观测 —— `/api/mission-control/*` 表面、七个视图、七个写动词、操作审计、bearer-token 中间件。 |
| [`architecture/agent-spec-and-startup.md`](architecture/agent-spec-and-startup.md) | AgentSpec/RigSpec 类型、profile 解析、叠加式启动分层、StartupOrchestrator、whoami/materialize/bind/adopt。 |
| [`architecture/lifecycle-snapshot-restore.md`](architecture/lifecycle-snapshot-restore.md) | 快照捕获、诚实恢复（resume vs rebuild vs fresh）、逐字的恢复诚实规则、restore-check / restore-packet 探针。 |
| [`architecture/transport-and-transcripts.md`](architecture/transport-and-transcripts.md) | 经 tmux 的 rig send/capture/broadcast、转录捕获 + 搜索、持久化 SQLite 聊天、`rig ask`、MCP 名与 tmux key。 |
| [`architecture/workspace-primitive.md`](architecture/workspace-primitive.md) | PL-007 类型化工作区声明、迁移 038/039、按项 repo 作用域门控、文件后端的 missions/slices 索引。 |
| [`architecture/content-surfaces.md`](architecture/content-surfaces.md) | 操作者白名单文件浏览器、原子的带冲突检查写入 + 编辑审计、PROGRESS.md 树索引器、Steering 编辑器。 |
| [`architecture/plugin-agent-image-context-pack.md`](architecture/plugin-agent-image-context-pack.md) | 插件发现、智能体镜像、context pack、Claude 自动压缩执行器。 |
| [`architecture/packaging-bootstrap-bundles.md`](architecture/packaging-bootstrap-bundles.md) | Bundle 组装（schema-v2 + 旧版 v1）、bundle create/inspect/install + `/api/up`、分级 BootstrapOrchestrator、旧版安装接缝。 |
| [`architecture/architecture-rules-and-event-system.md`](architecture/architecture-rules-and-event-system.md) | 横切不变量 —— 25 条架构规则（含**规则 15**：恢复诚实）、RigEvent 联合 + SSE 投递、有意的兼容性边界。 |
| [`architecture/living-notes-review.md`](architecture/living-notes-review.md) | **v0.4.4 新增**（不在原单体内）：Living Notes 评审表面 —— 唯一的 intent→plan→delivered 投影、分级批准锁、证明产物、冻结导出、按区间提供媒体。 |

旧 `### UI architecture` 节的 UI 半壁现为 `ui/` 下的 **4 个模块**（见 [`ui.md`](ui.md)，同为重定向桩，以及 [`./README.md`](./README.md) 中的 `ui/` 索引）。
