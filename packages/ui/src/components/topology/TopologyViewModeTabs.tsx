// V1 attempt-3 Phase 3 —— 拓扑视图模式标签页，依 topology-tree.md L46–L60 + SC-5 + SC-10。
//
// **承重的 SC-10：** 视图模式标签页位于居中区域顶部，服务于单一 URL。
// 标签页原地切换——不是独立路由。（Attempt-2 曾用 `/topology/host/table` 等路由，
// 规范明确禁止。）
//
// 状态由 React 管理（scope 页内 useState）；URL 始终停留在 scope 路径
// （/topology、/topology/rig/$rigId 等）。

import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";

export type TopologyHostScopeTab = "graph" | "table" | "terminal";
export type TopologyRigPodScopeTab = "graph" | "table" | "terminal" | "overview";
export type TopologySeatScopeTab = "detail" | "transcript" | "terminal";
export type AnyTopologyTab =
  | TopologyHostScopeTab
  | TopologyRigPodScopeTab
  | TopologySeatScopeTab;

interface TopologyViewModeTabsProps<T extends string> {
  tabs: { id: T; label: string }[];
  active: T;
  onSelect: (id: T) => void;
  testIdPrefix?: string;
  /**
   * Slice 24——可选尾部槽位，在页签栏 flex 容器内以 ml-auto 渲染。RigScopePage 按 README
   * §按钮放置方案 C，用它在页签栏最右侧渲染“在 CMUX 中启动”按钮；该按钮在所有工作组范围
   * 视图模式页签中持续存在。
   */
  trailing?: ReactNode;
}

export function TopologyViewModeTabs<T extends string>({
  tabs,
  active,
  onSelect,
  testIdPrefix = "topology-view-mode",
  trailing,
}: TopologyViewModeTabsProps<T>) {
  // Slice 24.D 修复（velocity-guard 次要关注点）：tablist 的子项只包含页签；外层 flex 包装器
  // 将 tablist 与尾部槽位作为同级元素承载。内部 tablist 使用 div 而非 <nav>，使 SC-1 左侧
  // 外观计数 querySelectorAll("nav, aside") 始终恰好为 2。不添加包装器线框；只有活跃页签
  // 带下划线，其余页签在画布上留有呼吸空间。
  const tablist = (
    <div
      role="tablist"
      aria-label="拓扑视图模式"
      data-testid={`${testIdPrefix}-tabs`}
      className="flex gap-6 items-center"
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          data-testid={`${testIdPrefix}-tab-${t.id}`}
          data-active={active === t.id}
          onClick={() => onSelect(t.id)}
          className={cn(
            "py-3 font-mono text-[10px] uppercase tracking-[0.18em] border-b-2",
            active === t.id
              ? "border-on-surface text-on-surface"
              : "border-transparent text-on-surface-variant hover:text-on-surface",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );

  if (!trailing) return tablist;

  return (
    <div
      data-testid={`${testIdPrefix}-tab-bar`}
      className="flex items-center"
    >
      {tablist}
      <div data-testid={`${testIdPrefix}-trailing`} className="ml-auto">
        {trailing}
      </div>
    </div>
  );
}

export const HOST_SCOPE_TABS: { id: TopologyHostScopeTab; label: string }[] = [
  { id: "graph", label: "图表" },
  { id: "table", label: "表格" },
  { id: "terminal", label: "终端" },
];

export const RIG_POD_SCOPE_TABS: { id: TopologyRigPodScopeTab; label: string }[] = [
  { id: "graph", label: "图表" },
  { id: "table", label: "表格" },
  { id: "terminal", label: "终端" },
  { id: "overview", label: "总览" },
];

export const SEAT_SCOPE_TABS: { id: TopologySeatScopeTab; label: string }[] = [
  { id: "detail", label: "详情" },
  { id: "transcript", label: "记录" },
  { id: "terminal", label: "终端" },
];
