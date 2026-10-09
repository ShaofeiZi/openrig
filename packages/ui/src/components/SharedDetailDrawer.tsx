// V1 第 4 阶段尝试 3 —— SharedDetailDrawer 外壳 + DrawerSelection
// 联合类型，按 content-drawer.md 扩展了 4 种新查看器类型
//（qitem / file / sub-spec / seat-detail）。
//
// SC-22 保留：默认关闭（selection===null 时返回 null）；
// VellumSheet width="wide"（38rem）；用户可关闭的 [×]；
// 同一时刻只开一个触发（点击新触发通过 setSelection 切换内容）。
//
// 第 4 阶段 P4-5：从 DrawerSelection 中移除 'rig' 类型。
// RigDetailPanel 已退役（旧的自动打开右侧边栏模式）；
// 点击工作组现在通过 URL 导航到 /topology/rig/$rigId（不再自动打开抽屉）。

import { SystemPanel } from "./SystemPanel.js";
import { DiscoveryPanel, type DiscoveryPlacementTarget } from "./DiscoveryPanel.js";
import { VellumSheet } from "./ui/vellum-sheet.js";
import { QueueItemViewer, type QueueItemViewerData } from "./drawer-viewers/QueueItemViewer.js";
import { FileViewer, type FileViewerData } from "./drawer-viewers/FileViewer.js";
import { SubSpecPreview, type SubSpecPreviewData } from "./drawer-viewers/SubSpecPreview.js";
import type { ActivityEvent } from "../hooks/useActivityFeed.js";

// V1 润色切片第 5.1 阶段 P5.1-1 + DRIFT P5.1-D2：'seat-detail' 类型
// 在 V1 润色阶段已退役。图节点点击 + 树节点点击 + 表格行点击全部导航到
// /topology/seat/$rigId/$logicalId 中心页面（规范智能体详情表面 = LiveNodeDetails）。
// SeatDetailViewer 包装组件已删除；SeatDetailTrigger 原语已删除。
// 抽屉仍作为其他自动打开触发（qitem / file / sub-spec）的内容查看表面，
// 见 content-drawer.md L23-L34。
export type DrawerSelection =
  | { type: "system"; tab?: "log" | "status" }
  | { type: "discovery" }
  // 第 4 阶段查看器类型（seat-detail 已在第 5.1 阶段 P5.1-D2 退役）
  | { type: "qitem"; data: QueueItemViewerData }
  | { type: "file"; data: FileViewerData }
  | { type: "sub-spec"; data: SubSpecPreviewData }
  | null;

interface SharedDetailDrawerProps {
  selection: DrawerSelection;
  onClose: () => void;
  events: ActivityEvent[];
  selectedDiscoveredId: string | null;
  onSelectDiscoveredId: (id: string | null) => void;
  placementTarget: DiscoveryPlacementTarget;
  onClearPlacement: () => void;
}

export function SharedDetailDrawer({
  selection,
  onClose,
  events,
  selectedDiscoveredId,
  onSelectDiscoveredId,
  placementTarget,
  onClearPlacement,
}: SharedDetailDrawerProps) {
  // SC-6 —— 默认关闭；只有命名触发设置了 selection 时才挂载外壳。
  if (!selection) return null;

  const inner = (() => {
    if (selection.type === "system") {
      return (
        <SystemPanel onClose={onClose} events={events} initialTab={selection.tab ?? "log"} />
      );
    }
    if (selection.type === "discovery") {
      return (
        <DiscoveryPanel
          onClose={onClose}
          selectedDiscoveredId={selectedDiscoveredId}
          onSelectDiscoveredId={onSelectDiscoveredId}
          placementTarget={placementTarget}
          onClearPlacement={onClearPlacement}
        />
      );
    }
    if (selection.type === "qitem") {
      return <QueueItemViewer {...selection.data} />;
    }
    if (selection.type === "file") {
      return <FileViewer {...selection.data} />;
    }
    if (selection.type === "sub-spec") {
      return <SubSpecPreview {...selection.data} />;
    }
    return null;
  })();

  return (
    <div
      data-testid="shared-detail-drawer-layer"
      // CORRECTIVE §7.2 —— 左侧方案已回退（创始者 2026-07-05）：
      // 恢复到全应用右侧边缘，同时移除 FR-11.1 的 z 轴提升
      //（右侧边缘从不与侧边栏不透明的 z-40 竞争）。
      className="fixed top-14 right-0 bottom-0 left-0 z-30 pointer-events-none"
    >
      <button
        type="button"
        aria-label="关闭抽屉"
        data-testid="shared-detail-drawer-outside"
        className="absolute inset-0 cursor-default pointer-events-auto"
        onPointerDown={onClose}
      />
      <VellumSheet
        // CORRECTIVE §7.2 —— 共享抽屉恢复为全应用右边缘面板
        //（edge 属性 = 边框侧；下方 anchor 类负责定位）。
        edge="right"
        width="wide"
        onClose={onClose}
        testId="shared-detail-drawer"
        // top-14 从通用顶栏下方开始（h-14，fixed 在顶部）；bottom-0
        // 锚定视口底部，使抽屉填满剩余高度。
        // 回弹修复 #3 宽度耦合：按 VellumSheet wide 预设为 38rem（lg:w-[38rem]）。
        className="absolute top-0 right-0 bottom-0 z-10 pointer-events-auto"
      >
        {inner}
      </VellumSheet>
    </div>
  );
}
