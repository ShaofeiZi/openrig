---
kind: as-built
title: OpenRig 代码地图 —— 导航索引 / 领地地图
status: active
topics: [knowledge-and-context, observability]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  你知道要了解已交付 OpenRig 系统的哪方面，但不知道哪个 as-built 模块承载。
  用模块地图、用例查找或源码根表路由到正确文档——或直接跳到代码地图指向的
  源码根。
siblings: [README.md, cli-reference.md]
prerequisite-reads: [README.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# OpenRig 代码地图 —— 导航索引

这是一张**领地地图**，不是内容倾倒。它告诉你哪个 as-built 模块回答哪个问题、该模块锚定在哪个 `packages/*/src` 根。深内容在模块里；代码在源码根里；本文件指向二者。

> 旧代码地图是一个 425 行逐文件 `Exports:`/`Related:` 扁平倾倒，漂移最快（它自己的头部就带着陈旧 v0.2.0 足迹与内部矛盾的命令组数），从塞不进上下文窗口。该反模式已退役（slice-08 Q5，创始人批准）。真正有用的部分——源码根索引——作为下方源码根指针表保留；逐文件转写不再。

## (a) 产品框架

OpenRig 是面向多智能体编码拓扑的本地控制平面——一个多智能体 harness，把你的 Claude Code 与 Codex 会话作为单一系统管理。后台服务（`@openrig/daemon`）是无框架、SQLite 后端内核；CLI（`@openrig/cli`）、UI（`@openrig/ui`）与 MCP 服务器都坐在它之上。

> 已在 HEAD `7eaf524c`（`v0.3.1-6-g7eaf524c`）源码核验；包版本 **0.3.1**，HEAD 上 6 个未发布 0.3.2 提交，无 `v0.3.2` 标签。框架句对照 `architecture/daemon-core.md` §1 + `openrig-internal/product/positioning.md`（"a multi-agent harness, a local control plane that manages your Claude Code and Codex sessions as a single system"）三角定位。

## (b) 模块地图

每模块一行。"何时取用…"镜像每模块实际 `applies-when` frontmatter。

### architecture/

| 模块 | 一句话摘要 | 何时取用… |
|---|---|---|
| `daemon-core.md` | CLI/UI/MCP 都坐其上的无框架 SQLite 后端内核。 | 你需要了解后台服务如何启动、`createDaemon` 如何接依赖图、SQLite schema/迁移集，或路由挂载表面。 |
| `adapters-and-runtimes.md` | 五方法运行时适配器契约 + resume 诚实层。 | 你需要运行时适配器契约、OpenRig 如何在 tmux 内启动/resume Claude Code、Codex 或终端 harness，或后台服务如何诚实评估 harness 真的 resume vs fresh 启动。 |
| `coordination-primitive.md` | PL-004 Phase A：SQLite 规范持久工作层（`/api/stream`、`/api/queue`）。 | 你需要 stream/queue/inbox/outbox 表、hot-potato 关闭契约、事务性 handoff 保证，或队列关闭在何处强制。 |
| `workflow-runtime.md` | PL-004 Phase D：把意图工作序列变成持久 SQLite 状态。 | 你需要 workflow spec 缓存、实例状态、step 轨迹、事务性 scribe 投影契约，或含 workflow-keepalive 的 watchdog 策略集。 |
| `mission-control.md` | PL-005：既有 shell 内后台服务支撑队列可观测表面。 | 你需要七个视图、七个写动词、动作审计表、bearer-token 中间件，或队列可观测如何映射 PL-004 源。 |
| `agent-spec-and-startup.md` | authored YAML spec 如何变成已解析、已启动、身份可寻址拓扑。 | 你需要 AgentSpec/RigSpec/pod 感知重启类型、profile 解析 + 加法启动分层、StartupOrchestrator 交付切分，或 whoami/materialize/bind/adopt 如何解析身份。 |
| `lifecycle-snapshot-restore.md` | `down → up → handoff` 的持久状态半壁。 | 你需要 OpenRig 如何捕获快照、恢复 rig（resume vs rebuild vs fresh）、强制恢复诚实、查询实时 continuity，或 restore-check / restore-packet 就绪探针如何工作。 |
| `transport-and-transcripts.md` | 通信与历史层；tmux 是传输，不是真相。 | 你需要 rig send/capture/broadcast 如何工作、pipe-pane 转录捕获 + 搜索、持久 SQLite 聊天、`rig ask` 收集什么，或 MCP 工具名 vs tmux 元数据键区分。 |
| `workspace-primitive.md` | PL-007：rig 工作所在处的类型化声明。 | 你需要 rig 如何声明类型化工作区（root/repos/defaultRepo/knowledgeRoot）、如何持久化/解析进 whoami / node-inventory、逐项 `target_repo` 范围如何校验，或文件后端 missions/slices 树如何索引并投影到 Project。 |
| `content-surfaces.md` | Project/Steering 所坐的操作者白名单、文件系统规范读写层。 | 你需要文件浏览器如何强制路径安全、原子带冲突检查写 + JSONL 编辑审计如何工作、PROGRESS.md 树如何索引，或单屏 Steering 表面如何组合。 |
| `plugin-agent-image-context-pack.md` | 后台服务发现并服务的四个文件系统规范内容原语。 | 你需要 OpenRig 如何发现插件、捕获/fork 智能体镜像、组装/发送上下文包，或 Claude auto-compaction 强制器如何决定发 `/compact`。 |
| `packaging-bootstrap-bundles.md` | 拓扑如何打包成可分享 bundle 并在他处重建。 | 你需要 rig/pod bundle 如何装配（schema-v2 vs 旧版 v1）、bundle create/inspect/install + `/api/up` 如何跨源种类路由、staged BootstrapOrchestrator 流程，或哪些旧版安装引擎接缝仍交付。 |
| `architecture-rules-and-event-system.md` | 不属于单子系统的横切不变量。 | 你需要 25 条架构规则 + 启动/导入约束、RigEvent 联合形状及其 SSE 投递，或仍描述已交付系统的刻意兼容限制。 |
| `living-notes-review.md` | **v0.4.4** —— 磁盘 SDLC markdown 上的单一 intent→plan→delivered 评审投影。 | 你需要 `ComposedSliceReview` 契约、`/api/review/*` 路由、staged-approval 锁（`--scope spec|delivery`）、`## Proof contract` ↔ 证明工件 join 与 C1 绑定 `verified`、freeze 导出，或评审证据的区间媒体服务。 |

### ui/

| 模块 | 一句话摘要 | 何时取用… |
|---|---|---|
| `shell-and-routing.md` | shell 优先、路由优先、原语驱动的操作者表面。 | 你需要 UI shell（rail / Explorer / 中心工作区 / 抽屉 / 预览栈）如何装配、已交付 UI 挂载的真实路由树，或共享详情抽屉与事件消费如何工作。 |
| `topology.md` | 操作者对 host → rig → pod → 席位的实时画面。 | 你需要拓扑表面如何构建——host 混合图、table/terminal 视图、activity-ring / hot-potato 视觉语言、终端预览弹出，以及导航/overlay 契约。 |
| `project-and-for-you.md` | 三个操作者面向目的地表面（For You / Project / Dashboard）。 | 你需要 For-You 关注流（5 卡分类器 + 动词动作）、Project 工作区/mission/slice 范围页，以及 vellum 品牌系统上 Dashboard 着陆如何构建。 |
| `library-specs-and-design-system.md` | Library（`/specs`）目的地 + 设计系统指针。 | 你需要 Library UI 如何装配——spec/skills/plugins 表面、喂它的 spec-review + spec-library + live-identity 流——或规范视觉/设计系统 spec 在何处。 |

### 根

| 文档 | 一句话摘要 | 何时取用… |
|---|---|---|
| `cli-reference.md` | 完整 `rig` CLI 表面，保持单一文档。 | 你需要确切 rig CLI 表面——命令组、子命令、flag、JSON 输出、跨 host、协调原语。 |
| `frontmatter-schema.md` | 这些文档遵循的 frontmatter 约定 + as-built 专属字段。 | 你在 `docs/as-built/` 下撰写或更新文档。 |
| `../DESIGN.md` | 规范视觉 / 品牌 / 设计系统 spec（仓库 `docs/` 根）。 | 你需要视觉系统、品牌身份或设计系统 token。（按设计留在根；仅指针。） |

## (c) 结构关系图

从每模块 `siblings` / `prerequisite-reads` frontmatter 构建。`daemon-core.md` 是脊柱（几乎每个 architecture 模块的前置）；`shell-and-routing.md` 是 UI 脊柱。

```
                         README.md  (入口——全部前置)
                              │
              ┌───────────────┴───────────────┐
              ▼                                ▼
        architecture/                         ui/
              │                                │
   daemon-core.md ◀── (下列列的前置脊柱)
      │   │   │  │
      │   │   │  └──▶ adapters-and-runtimes.md
      │   │   │         (五方法契约 + resume 诚实；
      │   │   │          被 agent-spec 启动编排消费)
      │   │   └────────────────────────────┐
      │   └──────────────┐                  │
      ▼                  ▼                  ▼
 coordination-      agent-spec-and-    transport-and-
 primitive.md        startup.md         transcripts.md
   │     │              │  │
   ▼     ▼              │  ▼
 workflow-  mission-    │  lifecycle-snapshot-restore.md
 runtime.md control.md  │     ▲ (消费持久 replay 上下文)
   │          │         │
   └────┬─────┘         ├──▶ packaging-bootstrap-bundles.md
        ▼               │        ▲
 architecture-rules-    │        │ (0.3.x 可复用 starter-state 簇)
 and-event-system.md    │        ▼
 (消费全部              └──▶ plugin-agent-image-context-pack.md
  PL-004/005 事件)

 workspace-primitive.md ──▶ content-surfaces.md
   (PL-007 声明)            (其上的文件系统读写层)
        │                          │
        └──────────┬───────────────┘
                   ▼  (UI 对应)
            ui/project-and-for-you.md

 shell-and-routing.md ──▶ topology.md
        │             └──▶ project-and-for-you.md ◀──▶ architecture/mission-control.md
        └──────────────▶ library-specs-and-design-system.md ──▶ ../DESIGN.md (指针)
```

阅读顺序规则：先开模块的 `prerequisite-reads`（大多数 architecture 模块先 `README.md` 再 `daemon-core.md`；大多数 ui 模块先 `README.md` 再 `shell-and-routing.md`）。

## (d) 按用例快速查找

| 我需要了解… | → 见 |
|---|---|
| 后台服务启动 / `createDaemon` 接线 / 迁移集 / 路由挂载 | `architecture/daemon-core.md` |
| 运行时适配器契约 / harness 如何在 tmux 启动或 resume | `architecture/adapters-and-runtimes.md` |
| Claude resume 诚实所在 / resumed-vs-fresh 评估 | `architecture/adapters-and-runtimes.md` |
| 队列关闭在何处强制 / hot-potato 契约 / 持久 handoff | `architecture/coordination-primitive.md` |
| workflow spec 如何在关闭时投影 / 事务性 scribe / watchdog 策略 | `architecture/workflow-runtime.md` |
| Mission Control 视图/动词 / 队列可观测 / 动作审计 | `architecture/mission-control.md` |
| AgentSpec/RigSpec 类型、profile 解析、启动分层、whoami/bind/adopt | `architecture/agent-spec-and-startup.md` |
| 快照/恢复、恢复诚实、restore-check / restore-packet 探针 | `architecture/lifecycle-snapshot-restore.md` |
| rig send/capture/broadcast、转录、持久聊天、`rig ask`、MCP 名 vs tmux 键 | `architecture/transport-and-transcripts.md` |
| 工作区原语（root/repos）、`target_repo` 范围门控、missions/slices 索引 | `architecture/workspace-primitive.md` |
| 文件浏览器路径安全、原子写 + 编辑审计、PROGRESS 树、Steering 编辑器 | `architecture/content-surfaces.md` |
| 组合 slice/mission 评审（`/api/review/*`）、staged-approval 锁、证明工件 + `verified`、freeze 导出、区间媒体 | `architecture/living-notes-review.md` |
| 插件发现 / 智能体镜像 / 上下文包 / Claude auto-compaction 强制器 | `architecture/plugin-agent-image-context-pack.md` |
| Bundle 装配、bundle 安装 / `/api/up`、BootstrapOrchestrator、旧版安装接缝 | `architecture/packaging-bootstrap-bundles.md` |
| 25 条架构规则 / RigEvent 联合 / SSE 投递 / 兼容限制 | `architecture/architecture-rules-and-event-system.md` |
| UI shell、真实路由树、共享详情抽屉 | `ui/shell-and-routing.md` |
| 拓扑图/表/终端视图、activity-ring / hot-potato 视觉 | `ui/topology.md` |
| For-You 关注流、Project 范围页、Dashboard 着陆 | `ui/project-and-for-you.md` |
| 目的地表面上的 vellum 品牌系统（0.3.1 品牌身份） | `ui/project-and-for-you.md`（vellum 品牌 = **0.3.1**，依 slice-00 0.3.0-GT seam (b)；slice-00 §2 行 1 = vellum-primitives → brand-identity，行 2 = destination-model → polished-destinations） |
| Library `/specs` UI + spec-review/spec-library/live-identity 流 | `ui/library-specs-and-design-system.md` |
| 完整 `rig` CLI 表面 | `cli-reference.md` |
| 视觉 / 品牌 / 设计系统 spec | `../DESIGN.md`（仓库 `docs/` 根） |
| 这些文档用哪个 frontmatter + as-built 专属字段 | `frontmatter-schema.md` |

## (e) 源码根指针表

模块 → 主 `packages/*/src/...` 根。这取代旧逐文件 `Exports:`/`Related:` 倾倒：它指向代码，不转写代码。每条论断的源码锚定在模块内，带 file:line 引用。

| 模块 | 主源码根 |
|---|---|
| `architecture/daemon-core.md` | `packages/daemon/src/{startup.ts,server.ts,index.ts}`、`packages/daemon/src/db/migrations/`、`packages/cli/src/index.ts` |
| `architecture/adapters-and-runtimes.md` | `packages/daemon/src/domain/runtime-adapter.ts`、`packages/daemon/src/adapters/{claude-code-adapter,codex-runtime-adapter,terminal-adapter}.ts`、`packages/daemon/src/domain/{native-resume-probe,resume-metadata-refresher,codex-thread-id}.ts` |
| `architecture/coordination-primitive.md` | `packages/daemon/src/domain/{stream-store,queue-repository,queue-transition-log,hot-potato-enforcer,inbox-handler,outbox-handler}.ts`、`packages/daemon/src/routes/{stream,queue}.ts` |
| `architecture/workflow-runtime.md` | `packages/daemon/src/domain/{workflow-projector,workflow-runtime,workflow-instance-store,workflow-spec-cache,workflow-step-trail-log,workflow-validator}.ts`、`packages/daemon/src/domain/policies/workflow-keepalive.ts`、`packages/daemon/src/routes/workflow.ts` |
| `architecture/mission-control.md` | `packages/daemon/src/domain/mission-control/`、`packages/daemon/src/middleware/auth-bearer-token.ts`、`packages/daemon/src/routes/mission-control.ts`、`packages/daemon/src/db/migrations/037_mission_control_actions.ts` |
| `architecture/agent-spec-and-startup.md` | `packages/daemon/src/domain/{agent-manifest,rigspec-schema,profile-resolver,startup-orchestrator,whoami-service,claim-service}.ts`、`packages/daemon/src/routes/{rigspec,whoami}.ts` |
| `architecture/lifecycle-snapshot-restore.md` | `packages/daemon/src/domain/{restore-orchestrator,snapshot-capture,snapshot-repository,checkpoint-store}.ts`、`packages/daemon/src/routes/restore-check.ts`、`packages/cli/src/commands/restore-packet.ts` |
| `architecture/transport-and-transcripts.md` | `packages/daemon/src/domain/{session-transport,transcript-store,history-query,ask-service,chat-repository}.ts`、`packages/daemon/src/routes/{transport,transcripts,ask,chat}.ts`、`packages/cli/src/mcp-server.ts` |
| `architecture/workspace-primitive.md` | `packages/daemon/src/domain/workspace/`、`packages/cli/src/commands/config-init-workspace.ts`、`packages/daemon/src/db/migrations/{038,039}*`、`packages/ui/src/routes.tsx` |
| `architecture/content-surfaces.md` | `packages/daemon/src/domain/{files,progress,steering}*`、`packages/daemon/src/routes/{files,progress,steering}.ts`、`packages/ui/src/routes.tsx` |
| `architecture/living-notes-review.md` | `packages/daemon/src/domain/review/{types,compose,gather,freeze,brief-spine}.ts`、`packages/daemon/src/routes/{review,files,slices}.ts`、`packages/cli/src/commands/{scope,proof}.ts`、`packages/ui/src/components/review/` |
| `architecture/plugin-agent-image-context-pack.md` | `packages/daemon/src/domain/plugin-discovery-service.ts`、`packages/daemon/src/domain/{agent-images,context-packs}/`、`packages/daemon/src/domain/claude-compaction-enforcer.ts` |
| `architecture/packaging-bootstrap-bundles.md` | `packages/daemon/src/domain/{pod-bundle-assembler,bootstrap-orchestrator,bundle-*,package-*,install-*}.ts`、`packages/daemon/src/routes/{bundles,up}.ts` |
| `architecture/architecture-rules-and-event-system.md` | `packages/daemon/src/domain/types.ts`（RigEvent 联合）、`packages/daemon/src/routes/{stream,queue}.ts`（SSE watch）、`packages/daemon/src/server.ts`（`/api/events`） |
| `ui/shell-and-routing.md` | `packages/ui/src/routes.tsx`、`packages/ui/src/components/AppShell.tsx` |
| `ui/topology.md` | `packages/ui/src/components/topology/`、`packages/ui/src/lib/{graph,hybrid,multi-rig}-layout.ts` |
| `ui/project-and-for-you.md` | `packages/ui/src/routes.tsx`、`packages/ui/src/components/dashboard/vellum/` |
| `ui/library-specs-and-design-system.md` | `packages/ui/src/components/specs/`、`packages/daemon/src/domain/{spec-review-service,spec-library-service}.ts`、`../DESIGN.md`（指针） |
| `cli-reference.md` | `packages/cli/src/index.ts`、`packages/cli/src/commands/*` |

> 无逐文件扁平倾倒。文件级细节在代码里；本代码地图指向源码根与解释它的模块。逐文件索引反模式（旧代码地图）已退役，未搬迁。
