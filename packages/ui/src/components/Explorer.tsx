import { useEffect, useMemo, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Boxes, ChevronLeft, ChevronRight, CircleDot, Globe, Layers3, Server, Activity } from "lucide-react";
import { useRigSummary, type RigSummary } from "../hooks/useRigSummary.js";
import { usePsEntries, type PsEntry } from "../hooks/usePsEntries.js";
import { useNodeInventory, type NodeInventoryEntry } from "../hooks/useNodeInventory.js";
import { cn } from "../lib/utils.js";
import { displayAgentName, displayPodName, inferPodName } from "../lib/display-name.js";
import {
  getActivityStateWithSource,
  getActivityLabel,
  getActivityTextClass,
  getActivityAnimationClass,
  getTimeInState,
  shortQitemTail,
} from "../lib/activity-visuals.js";
import { EmptyState } from "./ui/empty-state.js";
import { ProjectTreeView } from "./project/ProjectTreeView.js";
import { SpecsTreeView } from "./specs/SpecsTreeView.js";
import { SettingsExplorer } from "./system/SettingsExplorer.js";
import { TopologyTreeView } from "./topology/TopologyTreeView.js";
import { SubscriptionToggleList } from "./for-you/SubscriptionToggleList.js";

import type { DrawerSelection } from "./SharedDetailDrawer.js";

export type ExplorerDesktopMode = "full" | "hidden";

// V1 attempt-3 Phase 2——按 universal-shell.md L62 的规范界面并集：
// “渲染目的地的树（For You 为 feed 镜头筛选 chip 轨；Settings 为扁平导航；
// Dashboard 为无）”。
//
// Phase 2 铺并集；Phase 3 填树内容 + 镜头 chip。
export type ExplorerSurface =
  | "topology"
  | "project"
  | "specs"
  | "for-you"
  | "settings"
  | "none";

/**
 * Slice 26.D OPT-D3 拓扑移动端 Explorer 挂载抑制规则。
 *
 * 当给定界面的 Explorer 在当前视口不应挂载时返回 true。唯一例外：
 * 窄视口（isWideLayout=false）下的 Topology 界面。Topology 移动端渲染路径
 * 既有渲染自旋（TopologyTableView + TopologyTreeView 组合）在 Explorer 于
 * 375px 挂载时会卡死浏览器；挂载抑制绕开该卡死触发。
 *
 * 0.3.2 修复 Topology 移动端渲染路径后，此例外对所有界面返回 false。
 */
export function shouldSuppressExplorerMount(
  surface: ExplorerSurface,
  isWideLayout: boolean,
): boolean {
  return surface === "topology" && !isWideLayout;
}

interface ExplorerProps {
  open: boolean;
  onClose: () => void;
  selection: DrawerSelection;
  onSelect: (sel: DrawerSelection) => void;
  desktopMode?: ExplorerDesktopMode;
  surface?: ExplorerSurface;
  onDesktopToggle?: () => void;
  /** V1 attempt-3 Phase 3 回弹修复——B 类选择性 vellum 叠加层。
   *  "overlay" = vellum 半透明 + position absolute z-30（拓扑图视图模式特征）。
   *  "opaque" = 默认实心背景（其他目的地 + 视图模式）。 */
  overlayMode?: "overlay" | "opaque";
}

function statusColor(startupStatus: string | null): string {
  switch (startupStatus) {
    case "ready": return "text-green-600";
    case "pending": return "text-amber-500";
    case "attention_required": return "text-orange-500";
    case "failed": return "text-red-600";
    default: return "text-on-surface-variant";
  }
}

function rigStatusColor(status: string): string {
  switch (status) {
    case "running": return "text-green-600";
    case "partial": return "text-amber-500";
    case "stopped": return "text-on-surface-variant";
    default: return "text-on-surface-variant";
  }
}

function aggregateStatus(nodes: NodeInventoryEntry[]): "ready" | "pending" | "attention_required" | "failed" | null {
  if (nodes.some((node) => node.startupStatus === "failed")) return "failed";
  if (nodes.some((node) => node.startupStatus === "attention_required")) return "attention_required";
  if (nodes.some((node) => node.startupStatus === "pending")) return "pending";
  if (nodes.some((node) => node.startupStatus === "ready")) return "ready";
  return null;
}

function parseCurrentRigId(pathname: string): string | null {
  const match = pathname.match(/^\/rigs\/([^/]+)/);
  return match?.[1] ?? null;
}

function TreeToggle({
  expanded,
  label,
  onClick,
}: {
  expanded: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      aria-label={`${expanded ? "折叠" : "展开"} ${label}`}
      className="inline-flex h-5 w-5 items-center justify-center text-on-surface-variant transition-colors hover:text-on-surface"
    >
      <ChevronRight className={cn("h-4 w-4 transition-transform duration-150", expanded && "rotate-90")} />
    </button>
  );
}

// PL-019 第 3 项：逐行活动指示器，挨着启动状态图标。与 RigNode（第 2 项）
// 共用同一调色板，使操作手在两个界面上的心智模型一致。
//
// “持有活动中工作”标签（qitem 提示）仅在后台服务于节点详情/清单负载上挂载了
// 一个或多个进行中 qitem 时渲染——currentQitems 来自 routes/sessions.ts
// + routes/rigs.ts 的读侧 join。
function NodeActivityIndicator({ node }: { node: NodeInventoryEntry }) {
  const activity = node.agentActivity;
  const { state, source: activitySource } = getActivityStateWithSource(activity, node.terminalActive);
  const label = getActivityLabel(state);
  const textClass = getActivityTextClass(state);
  const animClass = getActivityAnimationClass(state);
  const qitems = node.currentQitems ?? [];

  const sourceLabel = activitySource !== "hook" && activitySource !== "none" ? "（活动分级）" : "";
  const timeInState = getTimeInState(activity);
  const durationSuffix = timeInState ? ` ${timeInState.label}` : "";
  const titleLines = [`活动：${label}${durationSuffix}${sourceLabel}`];
  if (qitems.length > 0) {
    for (const q of qitems) {
      titleLines.push(`进行中 ${shortQitemTail(q.qitemId)} — ${q.bodyExcerpt}`);
    }
  }
  const title = titleLines.join("\n");

  return (
    <span
      className="inline-flex items-center gap-0.5 ml-1"
      data-testid={`node-activity-${node.logicalId}`}
      data-activity-state={state}
      data-activity-source={activitySource}
      title={title}
    >
      <Activity className={cn("h-2.5 w-2.5 shrink-0", textClass, animClass)} strokeWidth={2.4} aria-label={title} />
      {qitems.length > 0 && (
        <span
          className="font-mono text-[8px] uppercase tracking-[0.10em] text-on-surface-variant"
          data-testid={`node-active-work-${node.logicalId}`}
          aria-label="持有活动中的工作"
        >
          ●
        </span>
      )}
    </span>
  );
}

function ExplorerKindIcon({
  kind,
  statusClass,
  testId,
}: {
  kind: "environment" | "rig" | "pod" | "agent" | "infrastructure";
  statusClass: string;
  testId?: string;
}) {
  const sizeClass = kind === "rig" ? "h-3.5 w-3.5" : "h-2.5 w-2.5";
  const sharedProps = {
    "data-testid": testId,
    className: cn(sizeClass, "shrink-0", statusClass),
    strokeWidth: 1.8,
  };

  switch (kind) {
    case "environment":
      return <Globe {...sharedProps} />;
    case "rig":
      return <Boxes {...sharedProps} />;
    case "pod":
      return <Layers3 {...sharedProps} />;
    case "infrastructure":
      return <Server {...sharedProps} />;
    default:
      return <CircleDot {...sharedProps} />;
  }
}


// 界面路由的主体。Phase 2 为非拓扑界面铺占位；Phase 3 填树内容 + 镜头 chip。
// "none" 界面（仅 Dashboard——slice 26 把 Settings 提升为带自己 SettingsExplorer
// 界面的第 4 个目的地 Explorer 对等项）意味着 Explorer 完全不渲染。
function SurfaceBody({
  surface,
  rigs,
  psMap,
  selection,
  onSelect,
  onClose,
  currentRigId,
}: {
  surface: ExplorerSurface;
  rigs: RigSummary[] | undefined;
  psMap: Map<string, PsEntry>;
  selection: DrawerSelection;
  onSelect: (sel: DrawerSelection) => void;
  onClose: () => void;
  currentRigId: string | null;
}) {
  if (surface === "topology") {
    return <TopologyTreeView />;
  }
  if (surface === "project") {
    return <ProjectTreeView />;
  }
  if (surface === "specs") {
    return <SpecsTreeView />;
  }
  if (surface === "settings") {
    return <SettingsExplorer />;
  }
  if (surface === "for-you") {
    // 订阅提示——按 for-you-feed.md L134-L140 的设置形界面。
    // /for-you 的首要 UX 是中央 FEED；订阅作为一个小型按需列表住在这里。不喧宾夺主。
    //
    // OPR.0.4.1.27：首要订阅控制是 feed 顶部的通俗 LevelControl（Feed.tsx）——
    // 按 v5 mockup 可触达。此 Explorer 侧栏放 5 个独立开关作为高级视图（桌面）。
    // action_required 强制开。设置不可达 → 规范默认 + CLI 提示。
    return (
      <div data-testid="explorer-for-you-subscriptions" className="flex-1 overflow-y-auto py-3 px-3">
        <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-on-surface-variant mb-2">
          高级 · 独立开关
        </div>
        <SubscriptionToggleList />
      </div>
    );
  }
  return null;
}

export function Explorer({
  open,
  onClose,
  selection,
  onSelect,
  desktopMode = "full",
  surface = "topology",
  onDesktopToggle = () => {},
  overlayMode = "opaque",
}: ExplorerProps) {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;
  const currentRigId = parseCurrentRigId(currentPath);
  const { data: rigs } = useRigSummary();
  const { data: psEntries } = usePsEntries();

  const psMap = new Map((psEntries ?? []).map((entry) => [entry.rigId, entry]));

  // 界面 "none"（仅 Dashboard——自 slice 26 起 Settings 有自己的 Explorer 界面）——
  // Explorer 不渲染。
  if (surface === "none") return null;

  // B 类：overlay 与 opaque 背景语法。
  // OPAQUE（默认；除拓扑图外所有目的地）：实心
  //   纸奶油色调（Phase 2 基线），使浏览树相对中央工作区清晰可读。
  // OVERLAY（仅拓扑图）：浅 vellum 半透明表面
  //   （globals.css L113-117 的 .vellum 类——rgba(255,255,255,0.4)
  //   + backdrop-blur(8px)），提升 z-index 使下方图面透出。
  //   按 universal-shell.md L48 的叠层 vellum 美感。Vellum(40%) 与 Phase 2 的
  //   基线 3.5% 不透明度读起来连贯；vellum 过重(70%) 太密。
  const isOverlay = overlayMode === "overlay";
  const isCollapsed = desktopMode === "hidden";

  // 桌面折叠时：仅在 rail 边缘 left 渲染一个浮动切换按钮（其后无 aside 容器）。
  // Explorer 界面树卸载；画布 + 标签页回流填满释放的宽度。
  if (isCollapsed) {
    return (
      <button
        type="button"
        data-testid="explorer-edge-toggle"
        data-explorer-collapsed="true"
        aria-label="展开浏览器"
        onClick={onDesktopToggle}
        className={cn(
          "hidden lg:flex fixed top-[5.5rem] left-[3.5rem] z-30 h-8 w-8 items-center justify-center",
          "rounded-full border border-outline-variant bg-background/90 text-on-surface",
          "shadow-[0_2px_8px_rgba(41,37,36,0.08)] backdrop-blur-sm transition-colors",
          "hover:bg-surface-low hover:text-on-surface",
        )}
      >
        <ChevronRight className="h-4 w-4" strokeWidth={1.5} />
      </button>
    );
  }

  return (
    <aside
      data-testid="explorer"
      data-surface={surface}
      data-explorer-mode={overlayMode}
      data-explorer-collapsed="false"
      className={cn(
        // V1 边框权重原则（universal-shell.md L39–L48）：
        // 区域间边缘用 1px outline-variant 幽灵线。
        "border-r border-outline-variant flex overflow-hidden",
        // 按模式的背景语法：
        //
        // Slice 26.B HG-8 移动端抽屉分层修复（按 orch 路由取 OPT-B）：
        // opaque 模式 Explorer 移动端抽屉必须分层在移动 rail-tray
        // （AppShell.tsx z-30）之上，使点击命中落在 Explorer 条目上。
        // 修复前值为 z-20（在 rail-tray 之下）——slice 26 暴露的既有 bug，
        // 因为 Settings 是移动端第 5 个带 Explorer 的目的地。opaque 模式对所有
        // 界面升到 z-40；overlay 模式保持 z-30（拓扑图行为保留；rail-tray 与
        // overlay 模式 Explorer 同 z 绘制，DOM 顺序使 Explorer 在后渲染而居上）。
        // rail-tray 在移动端仍可经背景点击关闭触达。
        //
        // Slice 26.D OPT-D3 例外（在 AppShell.tsx 的独立门控，不在此）：
        // 拓扑移动端 Explorer 在视口 < lg 时不挂载（避免既有 TopologyTableView
        // 渲染自旋——Explorer 在 375px 挂载时卡死浏览器）。挂载门控在
        // AppShell.tsx ~577 行；此 z-index 块仅在 Explorer 实际挂载时到达，
        // 故此处无需条件。0.3.2 将修复拓扑移动端渲染路径；届时 AppShell
        // 挂载门控回退。
        isOverlay
          ? "vellum z-30 shadow-[6px_0_14px_rgba(46,52,46,0.06)]"
          : "z-40 bg-[hsl(var(--background)/0.035)] supports-[backdrop-filter]:bg-[hsl(var(--background)/0.018)] backdrop-blur-[14px] backdrop-saturate-75 shadow-[6px_0_14px_rgba(46,52,46,0.04)]",
        // 移动端：自顶栏头（h-14）下方左侧滑入。
        "fixed top-14 bottom-0 left-0 transition-transform duration-200 ease-tactical w-72 max-w-[80vw]",
        open ? "translate-x-0" : "-translate-x-full",
        // 桌面（>=lg）：按 universal-shell.md L34 的 280px 持久列（lg:w-72）。
        // 位于 48px rail 之后，绝对定位。
        "lg:absolute lg:top-0 lg:bottom-0 lg:left-12 lg:w-72 lg:max-w-none lg:translate-x-0",
      )}
    >
      <div className="relative flex h-full w-full flex-col">
        <button
          type="button"
          data-testid="explorer-edge-toggle"
          aria-label="折叠浏览器"
          onClick={onDesktopToggle}
          className={cn(
            "hidden lg:flex absolute z-10 h-8 w-8 items-center justify-center rounded-full border border-outline-variant bg-background/90 text-on-surface",
            "shadow-[0_2px_8px_rgba(41,37,36,0.08)] backdrop-blur-sm transition-colors hover:bg-surface-low hover:text-on-surface",
            "right-2 top-3",
          )}
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={1.5} />
        </button>

        <SurfaceBody
          surface={surface}
          rigs={rigs}
          psMap={psMap}
          selection={selection}
          onSelect={onSelect}
          onClose={onClose}
          currentRigId={currentRigId}
        />
      </div>
    </aside>
  );
}
