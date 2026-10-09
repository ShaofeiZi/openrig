---
kind: as-built
title: UI Shell、路由、抽屉系统
status: active
topics: [observability]
domains: [engineering-advisor, product-advisor]
applies-when: |
  需要了解 UI shell（AppShell rail / Explorer / 中心工作区 / 抽屉 / 预览栈）
  如何装配、已交付 UI 挂载的真实路由树，或共享详情抽屉与事件消费如何工作。
siblings: [topology.md, project-and-for-you.md, library-specs-and-design-system.md]
prerequisite-reads: [../README.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# UI Shell、路由、抽屉系统

`@openrig/ui` 包是 shell 优先、路由优先、原语驱动的操作者表面。品牌/视觉规则在 `docs/DESIGN.md`（从 `library-specs-and-design-system.md` 指针）；本模块讲 shell 如何装配、挂载哪些路由。

> 已在 HEAD `7eaf524c` 对照源码核验；包版本 **0.3.1**（slice-00 §1.1）。UI 足迹为 **235** 个源文件（`packages/ui/src`，`.ts`+`.tsx`，非测试；slice-00 §1.6 / D6）。

## 1. 包形态

UI 包：`packages/ui`。主要实现区域：

- `src/routes.tsx` —— TanStack Router 路由树。
- `src/components/AppShell.tsx` —— 全局 shell：rail、Explorer、抽屉、预览栈。
- `src/components/ui/` —— 可复用 vellum + 基础 UI 原语。
- `src/components/graphics/RuntimeMark.tsx` —— runtime/tool/actor 标记。
- `src/components/topology/` —— graph/table/terminal 拓扑表面。
- `src/components/project/`、`for-you/`、`dashboard/`、`feed/` —— 可观测表面。
- `src/components/specs/` —— Library / skills / plugins 表面。
- `src/components/{preview,markdown,drawer-viewers}/` —— 查看器。
- `src/hooks/`、`src/lib/` —— 路由数据 hooks、分类器、格式化器、布局/品牌助手。

## 2. Shell 模型

`AppShell` 包裹每条路由。`AppShell.tsx` 铺设 48px 图标 rail + 路由感知 Explorer 侧栏 + 中心工作区 + 共享右侧抽屉 + 预览栈 + 拓扑 overlay provider + 共享抽屉选择/发现放置上下文。

rail 目的地（`AppShell.tsx` `RAIL_ICONS`，HEAD 重新确认）恰为六个目的地图标加 Advisor/Operator 条目：

- Dashboard `/`（`rail-dashboard`）
- Topology `/topology`（`rail-topology`）
- For You `/for-you`（`rail-for-you`）
- Project `/project`（`rail-project`）
- Library `/specs`（`rail-specs`）
- Settings `/settings`（`rail-settings`）

Explorer 是上下文相关的：其树随当前目的地变化，而非通用文件浏览器。

## 3. 路由模型

> 漂移修正 D16 —— `ui.md` "Route Model"（L52–73 列表）与 `architecture.md` §2 "UI architecture" 早于 0.3.x。下方路由表是**在 HEAD 从 `packages/ui/src/routes.tsx` 重新推导**（542 行）。路由树在 `routes.tsx:480`（`rootRoute.addChildren([...])`）装配。
>
> 对 D16 预期本身的修正（HEAD 源码核验）：调研预期 `/mission-control`、`/progress`、`/markdown` 是全新*真实*路由。HEAD 处 `/mission-control` 与 `/progress` 是**重定向桩**，不是目的地路由；**没有 `/markdown` 路由**。确实有真实 `/files` 路由（markdown 由 file/抽屉表面内的 `MarkdownViewer` 组件渲染，不经 `/markdown` 路由）。路由表按源码所述上报，而非按调研预测。

### 主要目的地路由

| 路径 | 组件 | 注 |
|---|---|---|
| `/` | Dashboard（`indexRoute` `routes.tsx:88`） | rail 目的地 |
| `/topology` | host 拓扑（`:98`） | + rig/pod/seat 范围（见 `topology.md`） |
| `/topology/rig/$rigId` | rig 范围（`:104`） | |
| `/topology/pod/$rigId/$podName` | pod 范围（`:110`） | |
| `/topology/seat/$rigId/$logicalId` | 席位范围（`:116`） | live 节点详情 |
| `/for-you` | 关注流（`:122`） | rail 目的地 |
| `/project` | 工作区 project 范围（`:128`） | rail 目的地 |
| `/project/mission/$missionId` | mission 范围（`:134`） | |
| `/project/slice/$sliceId` | slice 范围（`:140`） | |
| `/specs` | Library（`:146`） | rail 目的地 |
| `/specs/applications` | applications 段（`:152`） | |
| `/specs/skills` | skills 索引（`:160`） | |
| `/specs/skills/$skillToken` | skill 查看器（`:166`） | 默认 `skill.md` |
| `/specs/skills/$skillToken/file/$fileToken` | skill 文件查看器（`:175`） | |
| `/specs/plugins` | plugins 索引（`:186`） | 0.3.1（见 `library-specs…`） |
| `/plugins/$pluginId` | 插件详情（`:201`） | 0.3.1 |
| `/specs/$specKind/$specName` | 通用 spec → 库重定向（`:213`） | |
| `/files` | Files 工作区（`:192`） | 相对 ui.md/D16 为新增 |
| `/settings` | 设置中心（`:222`） | rail 目的地 |
| `/settings/policies` | Policies（`:232`） | slice 27 Claude-compaction 表单 |
| `/settings/log` | Log（`:237`） | slice 26 4 项 Settings explorer |
| `/settings/status` | Status（`:242`） | |
| `/search` | 审计/历史视图（`:248`） | |

### Lab 路由（设计实验）

`/lab/project-graphics-preview`（`:254`）、`/lab/card-previews`（`:262`）、`/lab/vellum-lab`（`:272`）、`/lab/vellum-bg/{a-large,b-small,c-allover}`（`:283`–`:293`）。vellum-lab + vellum-bg 路由是 0.3.1 vellum 品牌系统实验表面（slice-00 0.3.0-GT seam b：vellum 品牌身份在 0.3.1 成熟；`dashboard/vellum/*` 系统是 0.3.1）。

### 旧版 / 兼容路由

`/rigs/$rigId`（`:318`）、`/rigs/$rigId/nodes/$logicalId`（`:324`）、`/import`（`:333`）、`/packages`、`/packages/install`、`/packages/$packageId`（`:339`–`:351`）、`/bootstrap`（`:357`）、`/agents/validate`（`:363`）、`/specs/rig` + `/specs/agent` 评审（`:372`/`:378`）、`/specs/library/$entryId`（`:384`）、`/discovery` + `/discovery/inventory`（`:395`/`:410`）、`/bundles/inspect` + `/bundles/install`（`:416`/`:422`）。

### 重定向桩（已删路由）

`routes.tsx:432`–`:474` 为已删路由挂载 `<Navigate>` 重定向 —— 不是目的地页：`/context` → `/topology`；`/mission-control` → `/for-you`（SC-18：`/mission-control` 删除，For-You 取代它）；`/slices` + `/slices/$name` → `/project`；`/progress` → `/project`；`/steering` → `/project`。Mission Control *系统*仍存在于后台服务/PL-005 层（`../architecture/mission-control.md`）；只是旧 UI *路由*退役，改用 For-You。

## 4. 抽屉与查看器系统

`SharedDetailDrawer` 是队列项查看器、文件查看器、子 spec 预览及其他详情选择的共享瞬态详情表面。抽屉触发器带 root/path 来源，使查看器取/渲染正确内容；抽屉支持 outside-click 关闭。图像证明查看由 `ProofImageViewer` 处理，black-glass 样式遵循 shell 布局。skill 详情用 Library Explorer 导航 + 中心工作区 `FileViewer`（`components/drawer-viewers/FileViewer.tsx`），不是嵌套三列浏览器。

## 5. 事件与活动消费

UI 事件消费通过共享事件 hooks 集中，使 app 避免为相关表面重复 SSE 连接。当前消费者：For You feed 水合、拓扑活动环 + hot-potato 移动、活动 feed/系统表面、rig 事件表面。reduced-motion 偏好对 pulse/packet 动画生效。（后台服务 SSE 表面：`/api/events`、`/api/stream/watch`、`/api/queue/watch` —— `architecture-rules-and-event-system.md` §2.4。）

## 另见

- `topology.md` —— graph/table/terminal 拓扑表面。
- `project-and-for-you.md` —— project 可观测 + For-You feed。
- `library-specs-and-design-system.md` —— Library/specs + DESIGN.md 指针。
- 源码根：`packages/ui/src/routes.tsx`、`packages/ui/src/components/AppShell.tsx`。
