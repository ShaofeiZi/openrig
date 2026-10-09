---
kind: as-built
title: 现状文档（As-Built）—— 领地地图 + 模块索引
status: active
topics: [knowledge-and-context, observability]
domains: [engineering-advisor, operating-advisor, product-advisor]
applies-when: |
  开始任何需要以 OpenRig 系统实际交付形态为依据的技术任务时。先读本页，
  了解现状文档树包含什么、该打开哪个模块；然后去 codemap.md 按用例导航，
  或直接打开具名模块。
siblings: [codemap.md, cli-reference.md, frontmatter-schema.md]
prerequisite-reads: []
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# OpenRig 现状文档（As-Built Docs）

OpenRig 是一个面向多智能体编码拓扑的本地控制平面——它把你的 Claude Code 与 Codex 会话当作单一系统来管理，是一个多智能体 harness；其上有后台服务（`@openrig/daemon`）、CLI（`@openrig/cli`）、UI（`@openrig/ui`）和一个 MCP 服务器，全部坐落在同一个以 SQLite 为后端的内核上。本目录树是该系统**经源码核验**的、按实际交付形态撰写的描述——每一条承重论断都锚定到 `packages/*/src` 的某个具名提交，而非记忆、聊天记录或旧文档。

> 已对照 HEAD `7eaf524c`（`git describe` → `v0.3.1-6-g7eaf524c`）核验。三个包的版本均为 **0.3.1**；HEAD 携带 6 个未发布的 0.3.2 提交，尚无 `v0.3.2` 标签。

## 本目录树如何组织

现状文档语料经模块化（slice 08，`context-architecture-v1`），从两个单体文件拆成一个由主题模块组成的文件夹；每个模块可独立加载、各自带 frontmatter 标签供检索、每个不超过 300 行（无既有散文的 author-mode 模块可放宽到 400 行——见 slice-08 ACK）。

```
docs/as-built/
├── README.md            ← 你在这里：领地地图 + 索引
├── codemap.md           ← 导航索引（按用例查找、源码根指针）
├── frontmatter-schema.md← 本文档遵循的 frontmatter 约定
├── cli-reference.md     ← 完整 rig CLI 表面（整体保留）
├── architecture/        ← 14 个后端/运行时模块
└── ui/                  ← 4 个操作者表面模块
```

`docs/DESIGN.md`（规范的视觉 / 品牌 / 设计系统规格）按设计**保留在仓库 `docs/` 根目录**——它被许多既有 `docs/DESIGN.md` 路径引用，且不带源码漂移。本目录树指向它（见 `ui/library-specs-and-design-system.md`）；不在此复制。

## 模块索引

### `architecture/` —— 后端、后台服务、运行时

| 模块 | 覆盖内容 |
|---|---|
| [daemon-core.md](architecture/daemon-core.md) | 后台服务如何启动、`createDaemon` 接线、SQLite schema/40 个迁移集、路由挂载表面。 |
| [adapters-and-runtimes.md](architecture/adapters-and-runtimes.md) | 五方法 RuntimeAdapter 契约、Claude/Codex/终端适配器（在 tmux 中 launch/resume/fork）、resume 诚实层（对恢复会话 vs 全新会话的诚实评估）。 |
| [coordination-primitive.md](architecture/coordination-primitive.md) | PL-004 Phase A 的 stream/queue/inbox/outbox；hot-potato 关闭契约；队列关闭在何处强制。 |
| [workflow-runtime.md](architecture/workflow-runtime.md) | PL-004 Phase D Workflow Runtime —— spec 缓存、实例状态、步骤轨迹、事务性 scribe 投影、看门狗策略。 |
| [mission-control.md](architecture/mission-control.md) | PL-005 队列可观测表面 —— 七个视图、七个写动词、操作审计、bearer-token 中间件。 |
| [agent-spec-and-startup.md](architecture/agent-spec-and-startup.md) | AgentSpec/RigSpec 类型、profile 解析、叠加式启动分层、StartupOrchestrator、whoami/materialize/bind/adopt 身份。 |
| [lifecycle-snapshot-restore.md](architecture/lifecycle-snapshot-restore.md) | 快照捕获、诚实恢复（resume vs rebuild vs fresh）、恢复诚实性强制、restore-check / restore-packet 探针。 |
| [transport-and-transcripts.md](architecture/transport-and-transcripts.md) | 经 tmux 的 rig send/capture/broadcast、pipe-pane 转录捕获 + 搜索、持久化 SQLite 聊天、`rig ask`、MCP 名与 tmux key 的区分。 |
| [workspace-primitive.md](architecture/workspace-primitive.md) | PL-007 类型化工作区声明（root/repos/defaultRepo/knowledgeRoot）、迁移 038/039、按项 repo 作用域门控、文件后端的 missions/slices 索引。 |
| [content-surfaces.md](architecture/content-surfaces.md) | 操作者白名单文件浏览器、原子的带冲突检查写入 + JSONL 编辑审计、PROGRESS.md 树索引器、单屏 Steering 编辑器。 |
| [living-notes-review.md](architecture/living-notes-review.md) | **v0.4.4** —— Living Notes 评审表面：唯一的 `ComposedSliceReview`（intent→plan→delivered）投影、纯 composer + gatherer、分级批准锁、绑定 C1 的 `verified`、`/api/review/*` 路由、冻结导出、按区间提供媒体，以及它所投影的 SDLC 磁盘约定。 |
| [plugin-agent-image-context-pack.md](architecture/plugin-agent-image-context-pack.md) | 文件系统规范的内容层 —— 插件发现、智能体镜像、context pack、Claude 自动压缩策略执行器。 |
| [packaging-bootstrap-bundles.md](architecture/packaging-bootstrap-bundles.md) | Bundle 组装（schema-v2 pod bundle + 旧版 v1）、bundle create/inspect/install + `/api/up`、分级 BootstrapOrchestrator、旧版安装接缝。 |
| [architecture-rules-and-event-system.md](architecture/architecture-rules-and-event-system.md) | 横切不变量 —— 25 条架构规则、RigEvent 联合 + SSE 投递、有意的兼容性边界。 |

### `ui/` —— 操作者表面

| 模块 | 覆盖内容 |
|---|---|
| [shell-and-routing.md](ui/shell-and-routing.md) | UI 外壳（rail / Explorer / 中心工作区 / 抽屉 / 预览栈）、交付 UI 实际挂载的路由树、共享详情抽屉 + 事件消费。 |
| [topology.md](ui/topology.md) | 拓扑表面 —— host 混合图、表格/终端视图、活动环 / hot-potato 视觉语言、终端预览弹层、导航/叠加契约。 |
| [project-and-for-you.md](ui/project-and-for-you.md) | 操作者目标表面 —— For-You 关注流（5 卡片分类器 + 动词操作）、Project 工作区/mission/slice 作用域页、落在 vellum 品牌系统上的 Dashboard 落地页。 |
| [library-specs-and-design-system.md](ui/library-specs-and-design-system.md) | Library（`/specs`）UI —— specs/skills/plugins/智能体镜像表面、spec 评审 + spec 库 + 实时身份流、设计系统指针。 |

### 根级文档

| 文档 | 覆盖内容 |
|---|---|
| [codemap.md](codemap.md) | 导航索引 —— 模块地图、结构关系图、按用例快速查找、源码根指针表。当你知道*要什么*但不知*哪个模块*时从这里开始。 |
| [cli-reference.md](cli-reference.md) | 完整 `rig` CLI 表面 —— 命令组、子命令、标志、JSON 输出、跨主机、协调原语。作为单篇保留（slice-08 Q4）。 |
| [frontmatter-schema.md](frontmatter-schema.md) | 本目录每篇文档遵循的 frontmatter 约定，以及唯一一个现状文档特有字段（`last-verified-against-source`）。 |
| `../DESIGN.md` | 规范的视觉 / 品牌 / 设计系统规格（按设计位于 `docs/` 根目录；仅指针——不在此复制）。 |

## 源码锚定契约

每个模块都声明 `last-verified-against-source: <commit-sha>` —— 其论断被核对所依据的提交。承重修正以可审计注释内联记录（`> Drift-fix Dx —— 原称 X；更正为 Y；slice-00 §z；于 <file:line> @HEAD 重新确认`）。OPEN 项（定义性或仅运行时的计数）逐字保留，从不抹平。schema 定义见 [frontmatter-schema.md](frontmatter-schema.md)，管辖约定为 `openrig-work/conventions/frontmatter-for-context/`。
