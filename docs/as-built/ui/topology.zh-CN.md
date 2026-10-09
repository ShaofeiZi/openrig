---
kind: as-built
title: UI 拓扑 —— Graph/Table/Terminal、HotPotato、ActivityRing
status: active
topics: [observability, coordination]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  需要了解拓扑表面如何构建 —— host 混合图、table/terminal 视图、
  activity-ring / hot-potato 视觉语言、终端预览弹出，以及拓扑导航/
  overlay 契约。
siblings: [shell-and-routing.md, project-and-for-you.md]
prerequisite-reads: [../README.md, shell-and-routing.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# UI 拓扑 —— Graph/Table/Terminal、HotPotato、ActivityRing

拓扑是带 graph、table、terminal 视图的范围工作区，位于 `/topology` 路由族（`shell-and-routing.md` §3）。它是操作者对 host → rig → pod → 席位的实时画面。

> 已在 HEAD `7eaf524c` 对照源码核验；包版本 **0.3.1**（slice-00 §1.1）。下方组件名全部在 HEAD 对照 `packages/ui/src/components/topology/` 重新确认 —— `ui.md` 与 `DESIGN.md` 命名的是*导出符号*；定义混合节点的源文件是 `HybridTopologyNodes.tsx`（DESIGN.md L344 实现引用）。

## 1. 拓扑组件

> 漂移修正 —— `ui.md` "Topology"（L108–137）把 `HybridAgentNode` / `HybridPodGroupNode` 当顶层文件列出。HEAD 重新确认：二者都是 `packages/ui/src/components/topology/HybridTopologyNodes.tsx` 内的导出（`HybridPodGroupNode` 是 `HybridTopologyNodes.tsx:94` 的 `memo(...)`；`HybridAgentNode` 是 `:272` 的 `memo(HybridAgentNodeInner, ...)`）。组件名准确；文件位置已合并。

`packages/ui/src/components/topology/` 下组件（HEAD 重新确认）：

- `HostMultiRigGraph.tsx` —— host 级混合 React Flow 图（多 rig 单画布）。
- `HybridTopologyNodes.tsx` —— 导出 `HybridAgentNode`（紧凑 agent 卡：runtime 徽章、上下文 %、token 总量、活动状态、终端预览、CMUX 动作）与 `HybridPodGroupNode`（柔和虚线 pod 框）。
- `RigGroupNode.tsx` —— 带注册标记 + 聚合活动的柔和 rig 框。
- `ActivityRing.tsx` —— active / needs-input / blocked 活动环；卡片活动类在 `activity-card-visuals.ts`。
- `HotPotatoEdge.tsx` —— 有向队列移动边动画。
- `TopologyTableView.tsx` —— 拓扑数据的密集表镜像。
- `TopologyTerminalView.tsx` —— 终端导向拓扑状态。
- `TopologyTreeView.tsx` —— 树导航视图。
- `TopologyViewModeTabs.tsx` —— graph/table/terminal/tree 模式切换。
- `TerminalPreviewPopover.tsx` —— black-glass 快速终端预览，portal 到画布上方。
- `LaunchCmuxButton.tsx` —— hover/focus CMUX 启动动作。
- `ScopePages.tsx` —— host/rig/pod/seat 范围页包装。
- `topology-overlay-context.tsx` —— `TopologyOverlayProvider`（展开-rig 状态）。

> 注（对照 `DESIGN.md` "Topology" L205–216）：DESIGN.md 列了同一组导出原语（`HostMultiRigGraph`、`HybridAgentNode`、`HybridPodGroupNode`、`RigGroupNode`、`ActivityRing`、`HotPotatoEdge`、`TerminalPreviewPopover`、`TopologyTableView`、`TopologyTerminalView`）—— 对照源码核对：HEAD 全部存在。`TopologyTreeView` / `TopologyViewModeTabs` / `LaunchCmuxButton` 在源码中存在但不在 DESIGN.md 原语列表（DESIGN.md 是品牌原语列表，不是穷举组件清单；这是范围差异，不是漂移）。DESIGN.md 保持字节一致（Q1）。

## 2. 拓扑契约

来自 `architecture.md` §2 "Current topology UI" + `ui.md` "Important topology contracts"，HEAD 对照源码行为重新确认：

- graph / table / tree 导航都解析到席位详情 URL（`/topology/seat/$rigId/$logicalId`）。
- host 级图对多 rig 单画布使用跨 rig 节点 ID 前缀。
- 展开-rig 状态由 `TopologyOverlayProvider`（`topology-overlay-context.tsx`）持有；graph 数据仅对展开 rig 懒加载。
- 紧凑 agent 卡显示上下文百分比、token 总量、活动卡色调；`ActivityRing` + 活动类表面化 active / needs-input / blocked。
- `HotPotatoEdge` 在 graph 缩放层级动画化有向队列移动；reduced-motion 偏好移除脉冲/行进动画并保留静态状态信号。
- 终端预览动作是 hover/focus-visible；`TerminalPreviewPopover` 必须逃逸 React Flow 堆叠上下文（portal 到画布上方）并留在视口内。

## 3. 布局助手

拓扑布局由 `src/lib/` 助手计算（HEAD 重新确认）：`graph-layout.ts`、`hybrid-layout.ts`、`multi-rig-layout.ts`、`topology-activity.ts`、`activity-visuals.ts`。卡片上的 runtime/tool 身份来自中心 `runtime-brand.ts` / `tool-brand.ts` + `RuntimeMark.tsx`（不要复制品牌逻辑 —— DESIGN.md "Do not"；此处重述为拓扑卡品牌源契约）。

## 另见

- `shell-and-routing.md` —— `/topology` 路由族与 shell。
- `project-and-for-you.md` —— 兄弟可观测表面。
- `../architecture/coordination-primitive.md` —— hot-potato 边可视化的队列移动。
- 源码根：`packages/ui/src/components/topology/`、`packages/ui/src/lib/{graph,hybrid,multi-rig}-layout.ts`。
