---
kind: as-built
title: UI 项目可观测性、为你推荐与仪表盘
status: active
topics: [observability, coordination]
domains: [engineering-advisor, product-advisor, operating-advisor]
applies-when: |
  需要了解面向操作者的目的地界面如何构建时使用——包括 For You 关注流（五类卡片分类器 + verb
  操作）、Project 工作区/mission/slice 范围页（标签式汇总），以及基于 vellum 品牌系统的 Dashboard
  落地页。这是 author-mode 模块——ui.md 对这些界面的说明早于 0.3.x；每项声明均指向 HEAD 的
  file:line。
siblings: [shell-and-routing.md, ../architecture/mission-control.md]
prerequisite-reads: [../README.md, shell-and-routing.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-07-06
---

# UI 项目可观测性、为你推荐与仪表盘

三个面向操作者的目的地界面：**For You**（`/for-you`，关注流）、**Project**（`/project*`，
工作区/mission/slice 范围页）和 **Dashboard**（`/`，基于 vellum 品牌系统的落地页）。它们都读取
live daemon 状态；除了按 event 的 soft-dismiss 外，都不增加 UI 本地持久化。

> **AUTHOR-HEAVY 模块。** `ui.md` 中的 Project Observability / For You / Graphics-Layer 章节较薄，
> 且早于 0.3.1 dashboard/vellum 品牌更新。每项承重声明都带有
> `> Source: <file:line> @HEAD`；歧义会明确标为 OPEN，绝不抹平。除带 `docs/` 前缀外，路径均相对
> 于 `packages/ui/src/`。
>
> 已在 HEAD `7eaf524c` 验证（`git describe` → `v0.3.1-6-g7eaf524c`）。包版本为 **0.3.1**；
> HEAD 包含 6 个尚未发布的 release-0.3.2 commit；不存在 `v0.3.2` tag（daemon-core.md；
> slice-00 §1.1）。

## 0. 发布归属（取证接缝——请先阅读）

已在 HEAD 通过 `git cat-file -e <tag>:<path>` 重新验证：

| 层 | 版本 | HEAD 上的取证证据 |
|---|---|---|
| 项目可观测性基础（For-You feed、feed-classifier、project 范围页、Mission Control 七 verb 词汇） | **0.3.0** | `v0.3.0:components/for-you/Feed.tsx`、`v0.3.0:lib/feed-classifier.ts`、`v0.3.0:components/project/ScopePages.tsx`、`v0.3.0:components/mission-control/components/VerbActions.tsx` 均可在 `v0.3.0` 解析（slice-00 0.3.0-GT §1.5/§1.6/§1.7） |
| Dashboard/For-You 当前渲染所依赖的 Vellum **品牌 identity 系统**（`dashboard/vellum/*`：CornerBracket、VellumDestinationCard、marks、graphics、单一事实来源 barrel） | **0.3.1，而非 0.3.0** | `git cat-file -e v0.3.0:components/dashboard/vellum/index.ts` → **不存在**（"exists on disk, but not in 'v0.3.0'"）；`v0.3.1:` → 存在（slice-00 0.3.0-GT 接缝 (b)；§2 第 1/2 行） |

> Source：在 HEAD `7eaf524c` 重新运行——
> `git cat-file -e v0.3.0:packages/ui/src/components/dashboard/vellum/index.ts` 失败；
> `v0.3.0:.../for-you/Feed.tsx`、`.../lib/feed-classifier.ts`、
> `.../project/ScopePages.tsx`、`.../mission-control/components/VerbActions.tsx` 均可在 `v0.3.0`
> 解析。Vellum 界面*原语*（`components/ui/vellum-*.tsx`）在 0.3.0 发布；`dashboard/vellum/`
> 下完整一致的 vellum *品牌系统*属于 0.3.1——slice-00 0.3.0-GT 接缝 (b) 正是这条分界。
> **不要把 vellum 品牌系统倒归到 0.3.0。**

## 1. 路由事实（在 `routes.tsx`@HEAD 对照源码验证——BINDING）

叙述任何界面前，均已在 `packages/ui/src/routes.tsx`@HEAD（542 行）验证对应路由。Phase-8.1
调研中“缺失路由”的预期来自 grep，且部分有误；下表依据 `routes.tsx` 的实际情况编写，而非调研预测：

| 路径 | HEAD 上的实际情况 | 组件 | 来源 |
|---|---|---|---|
| `/for-you` | **真实目的地路由** | `Feed` | `routes.tsx:122-126` |
| `/project` | **真实目的地路由** | `WorkspaceScopePage` | `routes.tsx:128-132` |
| `/project/mission/$missionId` | **真实目的地路由** | `MissionScopePage` | `routes.tsx:134-138` |
| `/project/slice/$sliceId` | **真实目的地路由** | `SliceScopePage` | `routes.tsx:140-144` |
| `/`（index） | **真实目的地路由** | `Dashboard` | `routes.tsx:88-92` |
| `/mission-control` | **已删除的 `<Navigate to="/for-you">` redirect stub** | `() => <Navigate to="/for-you">` | `routes.tsx:440-444` |
| `/progress` | **`<Navigate to="/project">` redirect stub**（并入 Project 标签） | `() => <Navigate to="/project">` | `routes.tsx:463-467` |
| `/slices` | **已删除的 `<Navigate to="/project">` redirect stub** | `() => <Navigate to="/project">` | `routes.tsx:447-451` |
| `/slices/$name` | **`<Navigate to="/project/slice/$sliceId">` redirect stub** | `useParams` → `<Navigate>` | `routes.tsx:453-460` |
| `/steering` | **`<Navigate to="/project">` redirect stub** | `() => <Navigate to="/project">` | `routes.tsx:470-474` |
| `/markdown` | **不是路由**——`MarkdownViewer` 是 `MissionScopePage` 内使用的组件 |（无路由）| grep `routes.tsx`@HEAD：`path: "/markdown"` 为零 |

> Source：`routes.tsx:88-92`、`:122-144`、`:440-474` @HEAD；组件 import 位于
> `routes.tsx:40-41`（`Dashboard`、`Feed`）、`:60-63`（来自
> `components/project/ScopePages.js` 的 `WorkspaceScopePage`/`MissionScopePage`/`SliceScopePage`）
> @HEAD。

> **路由事实契约（slice-08 §10.7）：** **Mission Control 系统**位于 daemon/PL-005 层（见
> `../architecture/mission-control.md`）——`/mission-control` **不是 UI 目的地**；它是已删除的 redirect
> stub（SC-18）。七 verb *操作词汇*通过嵌入 For-You 卡片的 `VerbActions` 出现在本模块，但系统
> 本身不是本模块主题。`/progress`、`/slices`、`/steering` 均并入 `/project` 标签——它们是 redirect
> stub，不是需要叙述的界面。

## 2. For You——关注流（`/for-you` → `Feed`）

`Feed` 是操作者的关注界面：它基于 live activity feed，形成按时间排序、按订阅过滤、可 soft-dismiss
的卡片流。Header 显示 `Attention` / `For You`；最大宽度为 720px。

> Source：`components/for-you/Feed.tsx:364-369`（`data-testid="for-you-feed"`、max-w-720 +
> `For You` header），feed centerpiece 设计说明 `:3-12`（PRIMARY UX = feed；subscription 不应
> 占据主导——承重 SC-16）@HEAD。

### 2.1 五类卡片分类器（0.3.0 spine）

`classifyFeed(events)` 将每个 `ActivityEvent` 映射到五种 `FeedCardKind` 值之一——
`action-required`、`approval`、`shipped`、`progress`、`observation`——随后按 `receivedAt` 降序
排列。**不会静默丢弃任何内容**：未匹配的 event type 均落入 `observation`。queue visibility event
由 `queueKind(type, state)` 进一步分类（例如 `*.closed` → shipped；`human-gate` /
`pending-approval` → action-required；`closeout-pending-ratify` → approval）；human-seat destination
会强制归为 `action-required`。

> Source：`lib/feed-classifier.ts:9-14`（`FeedCardKind` union）、`classifyEvent` `:145-218`
>（默认 observation fallthrough L216-217）、`queueKind` `:93-110`、`classifyFeed` `:220-223`
>（receivedAt 降序排序）、`isHumanSeat` `:141-144` @HEAD。

feed pipeline（`Feed.tsx`）：`classifyFeed` → 限制到 `HISTORY_LIMIT = 50` → 从 live queue-item map
与 action audit hydrate 每张卡片的 kind（`hydratedCardKind`：action/approval 卡片上有已记录 outcome →
`approval`；`done|closed|completed` qitem → `shipped`）→ **subscription filter**（根据五个
`feed.subscriptions.*` config key 执行 `isCardKindSubscribed`；`action-required` 始终可见，
`observation` 仅在 audit subscription 开启时可见）→ 瞬态 **lens-chip** filter（All / Action req /
Approvals / Shipped / Progress / Audit；不持久化）→ 按 event seq 的 soft-dismiss filter。

> Source：`components/for-you/Feed.tsx:63`（`HISTORY_LIMIT = 50`）、`:238`
>（`classifyFeed(events).slice(0, HISTORY_LIMIT)`）、`hydratedCardKind` `:156-180`、subscription +
> lens + dismiss pipeline `:269-285`（subscription 优先 L280-282；lens L283；dismiss L284）、
> `LENS_CHIPS` `:54-61` @HEAD；subscription 强制/默认规则见 `Feed.tsx:3-12`
>（action_required 强制开启 L9；observation 受 audit_log 控制 L10）@HEAD。

### 2.2 Queue-item hydration + proof 预览

对于 payload 中携带 `qitemId` 的卡片，`useQueueItemMap` 会 hydrate 完整 queue-item body；对于
`shipped` 卡片，`sliceForCard` 按 tag/text 匹配 slice，`proofPreviewForSlice` 拉取首个带 screenshot
的 proof packet，使卡片能够内联渲染 `ProofThumbnailGrid` → `ProofImageViewer`。这是 slice-00 §1.5
“queue card hydrate qitem body + proof preview”基础，已经 live 接线。

> Source：`components/for-you/Feed.tsx:263`（`useQueueItemMap`）、`sliceForCard` `:182-201`、
> `proofPreviewForSlice` `:203-213`、每卡 proof 接线 `:421-427`；`FeedCard.tsx` proof block
> `:453-471`（`ProofPacketHeader` + `ProofThumbnailGrid`）、`ProofImageViewer` `:521` @HEAD。

### 2.3 action/approval 卡片上的 verb 操作（七 verb 系统；OPEN-3）

可操作卡片（`action-required` 或 `approval`，无已记录 outcome，且 qitem 非 terminal）嵌入
`VerbActions`。**规范 Mission Control 操作词汇是七 verb 系统**——`MISSION_CONTROL_VERBS =
[approve, deny, route, annotate, hold, drop, handoff]`——定义于 Mission Control 系统层
（slice-00 0.3.0-GT §1.6/接缝 (c)：该词汇*源自 0.3.0 源码*）。

> Source：`components/mission-control/hooks/useMissionControlAction.ts:5-15`
>（七元素 const `MISSION_CONTROL_VERBS` `:5-13` + `MissionControlVerb` type `:15`）、
> `components/mission-control/components/VerbActions.tsx:82`（通过
> `enabledVerbs = [...MISSION_CONTROL_VERBS]` 默认启用全部七项）、每个 verb 的输入需求 `:97-99`
>（route/handoff→destination L97；annotate→annotation L98；hold/drop→reason L99）@HEAD；
> slice-00 0.3.0-GT §1.6 + 接缝 (c)。

> **OPEN-3 已解决（v0.4.4 living-notes 修正，founder 裁定 N-1，2026-07-05）。** For-You
> 可操作卡片界面是**裸 one-tap APPROVE + CHAT——没有其他操作**。`FeedCard` 传入
> `enabledVerbs={["approve"]}` + `oneClickVerbs={["approve"]}` + v0.4.4 `bare` prop（仅 JSX：
> 跳过 "Choose response" header chrome；mutation/receipt/error 路径字节级一致——由 raw-body
> 测试锁定），旁边是 CHAT 按钮，用于打开经 `buildChatPreamble` 预置的共享
> `ProgressiveTerminal`（terminal，绝不是 chat panel——BR-12）。Deny/route 已从该界面退役
>（包括 action-required lens 的空状态文案："one-tap approve and chat with the owning agent"）；
> 卡片级 kind tag 是状态标签 "Action required"，绝不是指令 chrome。上文的七 verb 词汇仍是
> MISSION-CONTROL 系统级词汇；For-You 提供其中两个 action。
>
> Source @`bb5ad219`：`FeedCard.tsx:547-593`（bare `VerbActions`、
> `enabledVerbs=["approve"]` `:561-566` + chat button + 内联 `ProgressiveTerminal`）、`:87-94`
>（`resolveCardTerminalSession`——human-action 卡片与 sender chat）、`Feed.tsx:76-82`
>（`EMPTY_COPY["action-required"]`）、`VerbActions.tsx`（`bare` prop）、`review/chat.ts:21`
>（`buildChatPreamble`）；测试 `test/foryou-bare-approve-chat.test.tsx`（字节一致 mutation +
> chatBtns:1/denyRoute:0 + 已退役文案源码扫描）。

mutation 成功时，`VerbActions` 触发 `onOptimisticOutcome`；`Feed` 维护以 `qitemId` 为 key 的
optimistic-outcome map，使 `ActionOutcomePanel` receipt 无需等待 audit-log 重新 fetch 即可立即渲染
（audit re-fetch 最终会呈现相同形态）。没有已记录 outcome 的 terminal qitem 会从 closure reason
派生 fallback receipt。

> Source：`components/for-you/Feed.tsx:224-236`（optimistic-outcome map +
> `setOptimisticOutcome`）、`:426-428`（optimistic 优先，audit fallback：
> `optimisticOutcomes.get ?? actionOutcomes.get ?? null`）；`FeedCard.tsx:473-500`
>（`isActionableCard` gate L473 + `VerbActions` 接线 L489-499）、`isActionableCard` `:166-175`、
> `fallbackOutcomeFromQueueItem` `:177-198`、`ActionOutcomePanel` `:271-310`；
> `VerbActions.tsx:138-145`（mutation `onSuccess` 上的 `onOptimisticOutcome`）@HEAD。

### 2.4 卡片界面——与 vellum 一致（0.3.1 品牌层）

`FeedCard` 基于 **0.3.1 vellum 品牌系统**渲染：`bg-stone-100/45 backdrop-blur` surface，带三段
ambient box-shadow（无 border）；四个 `CornerBracket` mark 穿过 vellum 标记边界；mono uppercase
kind tag + 彩色 dot；以及 runtime graphics mark（session 使用 `ActorMark`）——即 slice-00 §1.7
“drawer / proof row / queue ref / story row 共用 graphics mark”的基础，现在以成熟 vellum 词汇表达。
卡片可通过键盘 Backspace/Delete 与 swipe dismiss，并带 `UndoToast`。

> Source：`components/for-you/FeedCard.tsx:72-73`（`CARD_SURFACE_CLASS`）、`:74-80`
>（`CARD_SHADOW_STYLE` 三段 box-shadow）、corner bracket `:401-404`（4×
> `<CornerBracket position=…>`）、`KIND_DOT` `:33-39`、kind tag span `:410-414`、`ActorMark`
> import `:25` + 使用 `:229`；`CornerBracket` 来自 0.3.1 brand barrel
> `dashboard/vellum/index.ts:17`；slice-00 0.3.0-GT 接缝 (b) + §1.7 @HEAD。

### 2.5 Storytelling 预览带

在旧卡片列表上方，`Feed` 渲染由 `buildStorytellingFeedItems` 构建的 `StorytellingFeed` 预览：
来源是已发现 mission（`useMissionDiscovery` → `ProgressCard`，取前 2 个）+ slice
（`useSlices` → shipped/done 使用 `ShippedCard`，其余使用 `IncidentCard`，最多 3 个）。mission row
携带 daemon 派生的 `status`，因此可持久执行类似 "Getting Started" 的完成并隐藏过滤
（`status === "complete"`）；同时提供乐观本地隐藏与 best-effort
`POST /api/missions/:id/complete` audit 写入，并吞掉网络错误，使部分 air-gapped daemon 不会阻碍隐藏。

> Source：`components/for-you/Feed.tsx:319-343`（mission/slice adapter：
> `useMissionDiscovery` L319、`missionsWithStatus` L329-335、`buildStorytellingFeedItems` L336-343；
> adapter 注释 L305-318）、`handleMarkMissionComplete` `:351-361`（best-effort `void fetch` L354、
> 吞掉错误 L357）、预览渲染 `:399-409`；`components/feed/cards/storytelling-cards.tsx:36`
>（`CardKind`）、`ShippedCard` `:184`、`IncidentCard` `:235`、`ProgressCard` `:289` @HEAD。

## 3. Project——工作区 / mission / slice 范围页（0.3.0 spine）

`/project*` 挂载三个范围页，全部基于共享 `ScopeShell` + 标签式 rollup 模式（slice-00 §1.5
project observability 基础）。`SHARED_TABS` 集合——`overview / story / progress / artifacts / tests /
queue / topology`——驱动 `WorkspaceScopePage` 与 `MissionScopePage`；`SLICE_TABS` 为
`SliceScopePage` 将 `story` 调整到首位，但 `SliceScopePage` 的 `useState` 默认值是 `overview`
（README + readiness 优先，而非 metric grid）。

> Source：`components/project/ScopePages.tsx:75-76`（`SharedTab` / `SliceTab` type）、
> `SHARED_TABS` `:78-86`、`SLICE_TABS` `:88-96`、`ScopeShell` `:137-166`、`TabNav`
> `:98-135` @HEAD。

### 3.1 WorkspaceScopePage（`/project`）

读取 live workspace name（`useWorkspaceName`）；未设置时呈现诚实空状态（`NO WORKSPACE CONNECTED`
及打开 settings 的 action）。`overview` 标签渲染 `WorkspaceOverviewPanel`：先把 slice 分组进
mission，再由 `partitionProjectMissions` 拆成双栏 **Current Work / Archive** 布局（slice-00 §1.5
“current/archive grouping”）。每张 mission card 将其 slice 列为指向 `/project/slice/$sliceId` 的
`Link`，并带 `QueueCountIcon` + `StatusDot`。其他标签为范围 rollup（§3.4）。

> Source：`components/project/ScopePages.tsx:676-749`（`WorkspaceScopePage`；无 workspace
> 空状态 guard `:682-693`，`workspace-scope-no-workspace` `:689`）、`WorkspaceOverviewPanel`
> `:534-674`（mission 分桶 `:536-551`、`partitionProjectMissions` `:552`、双栏 panel `:631`、
> Current 区段 `:632-651`、Archive 区段 `:652-671`）@HEAD。

### 3.2 MissionScopePage（`/project/mission/$missionId`）

使用相同 `ScopeShell`/`SHARED_TABS`。`overview` 通过 `MarkdownViewer` 渲染 mission README
（`useScopeMarkdown(missionPath, "README.md")`），下方是 slice rail；`progress` 渲染
`MissionProgressHeatmap` + mission `PROGRESS.md` + 共享 `ScopeProgressRollup`。当 mission README
frontmatter 声明已进入 `WorkflowSpecCache` 的 `workflow_spec` 时，`topology` 标签通过 `TopologyTab`
渲染**投影后的 workflow spec graph**（daemon 返回 `topology.specGraph`）；否则回退到 session-name
聚合。

> Source：`components/project/ScopePages.tsx:751-895`（`MissionScopePage`；`useMission` `:759`、
> `missionPath` `:760-761`、README/PROGRESS markdown `:762-763`、overview README 区段 `:775`、
> progress heatmap `:832`、`mission-progress-readme` `:838`、spec-graph topology branch `:875-891`——
> `missionTopology` `:875`、`specGraph` 检查 `:879`、session-name fallback `:890`）@HEAD。

### 3.3 SliceScopePage（`/project/slice/$sliceId`）

默认标签为 `overview`（`SliceOverviewTab`——README + current step + readiness）。loading/error 状态
是诚实 empty state（错误状态点名 `rig config get workspace.slices_root` 这一可能的配置错误）。
`progress` 并入 `AcceptanceTab`（acceptance 是规范的 slice-scope progress proof）；`story` 渲染
`TimelineTab`，其中 curated `timeline.md`（`useSliceTimelineMarkdown`）位于自动捕获 event feed 上方；
`topology` 渲染感知 slice workflow instance 的 `TopologyTab`；**`review`（v0.4.4）渲染 Living Notes
`SliceReviewTab`**（§3.5）。

> Source：`components/project/ScopePages.tsx:1187-1297`（`SliceScopePage`；默认 `overview`
> `:1192`、timeline md `:1204`、loading-state guard `:1206`、error-state guard `:1225`
>（slices_root 修复提示 `:1239`）、story=`TimelineTab` `:1258-1265`、
> progress=`AcceptanceTab` `:1269-1273`、topology `:1294`）@HEAD。

### 3.4 共享范围 rollup

`ScopeStoryRollup`、`ScopeProgressRollup`、`ScopeArtifactsRollup`、`ScopeTestsRollup`、
`ScopeQueueRollup`、`ScopeTopologyRollup`（非 overview 标签）均从同一个
`useProjectScopeRollup(missionId, loadDetails)` hook 读取，因此 workspace 与 mission scope 会针对
各自 slice 集合共享相同 rollup 行为——即 slice-00 §1.5“workspace/mission rollup”基础。详情 fetch
由 active tab 控制（`active !== "overview"`），使 overview 路径保持轻量。

> Source：`components/project/ScopePages.tsx:198-217`（`useProjectScopeRollup`；`rowsForScope`
> `:193-196`）、rollup 组件 `:219-532`；gate `:679`、`:754`（`active !== "overview"`）@HEAD。

### 3.5 Review 标签（v0.4.4——Living Notes 界面）

slice 与 mission 范围页都挂载 `Review` 标签（`SLICE_TABS`/mission tabs，
`ScopePages.tsx:99-113`）。slice 标签（`review/SliceReviewTab.tsx`）从
`GET /api/review/slice/:name`（`hooks/useReview.ts`）渲染每个 slice 唯一的可 review 结构——band
依次为 **NEEDS YOU → AGENTS → INTENT / PLAN / DELIVERED → verify-lineage → SETTLED**：

- **DELIVERED** 将每个计划 deliverable 与其 curated proof 纵向配对（计划 mockup 在上，已交付
  artifact 在下）；media 以内联文本高度显示，点击时逐个展开（`?item=` deep link）；`verified` 用
  简明语言渲染 QA 已记录的比较（✓ QA-verified · ◇ unverified · ✗ missing + QA note）——可见但不
  阻塞。"See all proof" 可深入 `proof/`。
- **Media 确实可播放**：video 使用原生 controls 内联渲染（用于 capture 验证的 `?seek`/`?play`
  deep link）；image 打开随附 `Lightbox`；evidence 与 "full PRD →" door 在共享的**右侧** drawer 中
  打开随附 `FileViewer`（v0.4.4 修正撤回了三个 token 上的 FR-11.1 左侧翻转）。
- **两个 lock**（架构模块 §4）渲染为明确 stamp：PLAN 中显示 plan-lock，SETTLED 中显示两个 stamp；
  未审计 stamp 会显著显示为 UNVERIFIED。
- review card 共用一个 vellum recipe（`review/vellum.ts`——背景匹配的透明度 + backdrop blur，
  两种 theme 均由 token 驱动）；DELIVERED row 在 `sm` breakpoint 以下纵向堆叠（phone-first 单栏扫描）。
- mission 标签（`review/MissionReviewTab.tsx`）以 board 为先：来自折叠契约的 stage cell、completion
  ledger、cut-complete，以及读取同一契约的 U5 row expansion（原样 intent + 有界 per-item verified
  summary；完整配对位于 slice 页）。rig altitude（`review/RigAgentsPage.tsx`）读取
  `GET /api/review/rig`。

后端契约与组合：见 [`../architecture/living-notes-review.md`](../architecture/living-notes-review.md)。

> Source @`bb5ad219`：`components/review/{SliceReviewTab,MissionReviewTab,NeedsYouAccordion,
> AgentsBandView,VerifyLineageCard,EvidenceOpener,RigAgentsPage}.tsx`、`review/vellum.ts`、
> `hooks/useReview.ts`、`SharedDetailDrawer.tsx`（右侧锚定 + 翻转前 z）；测试
> `test/{fileviewer-resolvable-target,drawer-primitives}.test.tsx`。被否决的三栏 compare 与独立
> item-join table 已删除（corrective delete-not-demote；引用数为零）。

## 4. Dashboard——落地界面（`/` → `Dashboard`）

`Dashboard` 是基于 **0.3.1 vellum 品牌系统**的轻量组合：它从 `dashboard/vellum/index.js` import
`MidLayerContent`、`TopLayerContent`、`DestinationsLayer`——与 `/lab/vellum-lab` import 的 barrel
相同，因此生产 dashboard 与 design lab 精确同步（单一事实来源）。真实数据接线：`useRigSummary` →
totalRigs/totalAgents，`usePsEntries` → activeAgents，`useSpecLibrary` → librarySize，
`window.location.hostname` → classification eyebrow。根据 2026-05-15 founder dispatch，重型
`BackLayerContent` / `BackVellumSheet` back layer 已移除，使 dashboard 位于 page-level cream
paper-grid 上；barrel 仍导出它们（供 lab 使用）。

> Source：`components/dashboard/Dashboard.tsx:1-52`（vellum barrel import `:12-16`、
> 单一事实来源注释 `:2-5`、真实数据 hook `:29-39`、back-layer removal 注释 `:21-27`、render
> `:40-50`）；`components/dashboard/vellum/index.ts:1-26`（barrel；`BackLayerContent` `:5` /
> `BackVellumSheet` `:6` 仍导出）；slice-00 0.3.0-GT 接缝 (b) + §2 第 1/2 行 @HEAD。

## 5. 跨模块属性

- **live daemon 状态，除 soft-dismiss 外无 UI 本地持久化**——每个界面读取 daemon hook；唯一 UI
  本地状态是按 event seq 的 dismiss set、瞬态 lens chip 与 optimistic-outcome map（`Feed.tsx:217`
  lens、`:224` optimistic map、`:240-241` dismiss set；`ScopePages.tsx` `useState` tab state
  `:677`、`:753`、`:1192`）@HEAD。
- **诚实 empty/error state**——`WorkspaceScopePage` 无 workspace（`ScopePages.tsx:682-693`）、
  `WorkspaceOverviewPanel` index unavailable（`:565-573`，label `:568`）、`SliceScopePage` not
  available（`:1225-1245`，label `:1235`）均呈现原因与 remediation 指针，绝不显示空白屏幕 @HEAD。
- **0.3.0 observability spine 位于 0.3.1 vellum 品牌层之上**——classifier / verb-action /
  scope-rollup *逻辑*是 0.3.0 基础（§0）；*视觉界面*（vellum card、corner bracket、graphics mark、
  dashboard）是 0.3.1 品牌成熟成果。分界为 slice-00 0.3.0-GT 接缝 (b)；不可向任一方向合并 @HEAD。

## OPEN 项（保留，不抹平）

- **OPEN——For-You verb 子集（slice-00 0.3.0-GT OPEN-3）。** 实际发布的 For-You 界面 verb 子集
  是未解决的 velocity slice-01 裁定（CHANGELOG `[0.3.1]` "all 7" 与 source material §6
  "subset" 不一致）。本模块只描述**七 verb 系统级词汇**，并将当前 `enabledVerbs` prop 字面值
  （§2.3）作为源码状态报告，**不**把它当作结论。For-You 子集枚举推迟到待定 velocity 裁定。
- **OPEN——`/project` redirect-stub 合并。** `/progress`、`/slices`、`/steering` 是
  `<Navigate to="/project">` stub，`/slices/$name` 重定向到 `/project/slice/$sliceId`（§1）。
  原独立界面并入 Project 标签；这些 stub 是永久还是过渡方案，属于无法从源码判定的产品决策。
- 本模块不涉及 slice-00 数字 drift OPEN（1–5）——没有 migration / route-group / PL-004-event 计数。
