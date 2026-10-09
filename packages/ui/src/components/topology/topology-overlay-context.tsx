// V1 第 3 阶段尝试 3 回弹修复 —— B 类 TopologyOverlayContext。
//
// 拓扑目标签名：当活动视图模式为 GRAPH 时，Explorer 渲染为羊皮纸半透明遮罩，
// 浮在画布上（羊皮纸层叠美学，见 universal-shell.md L48）。
// 中心工作区画布延伸到视口左边缘，位于 Explorer 遮罩下方。
//
// 当活动视图模式为 TABLE / TERMINAL（或任何非拓扑目标）时，Explorer
// 不透明（默认行为）；中心工作区从 Explorer 右边缘开始。
//
// 视图模式标签栏固定在 left = 导轨（48px）+ 探索器（280px）= 328px =
// var(--explorer-anchor-left)。与模式无关，因此标签在 graph / table /
// terminal 切换间从不跳动。
//
// V1 润色切片第 5.2 阶段回弹修复 —— 工作组折叠状态持久化。
// 第 5.2 阶段第 6 项自动展开是死代码：HostMultiRigGraph 将 `expanded`
// 作为本地 useState，activeRigId useEffect 仅在 HostMultiRigGraph 自身
// 挂载时触发。但拓扑路由是兄弟节点（非嵌套），所以
// /topology/rig/$id 渲染 RigScopePage，而非 HostMultiRigGraph——
// 该 effect 对直接 URL 入口从不运行。导航回 /topology 会以空 Map
// 重新挂载 HostMultiRigGraph。修复：将 expanded Map 提升到此 provider，
// 使状态在 HostScopePage 卸载/重挂载周期中存活；在 provider 作用域运行
// 自动展开 useEffect（始终挂载在 AppShell 下），使 URL 驱动的展开
// 不管当前中心是哪个范围页面都能触发。

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { useRouterState } from "@tanstack/react-router";

export type ExplorerMode = "overlay" | "opaque";

interface TopologyOverlayContextValue {
  mode: ExplorerMode;
  setMode: (mode: ExplorerMode) => void;
  /** V1 润色切片第 5.2 阶段 —— 工作组展开状态在 provider 作用域持久化，
   *  使 HostMultiRigGraph 挂载/卸载周期不重置折叠 Map。默认为空 → 所有工作组折叠。 */
  expandedRigs: ReadonlyMap<string, boolean>;
  /** 幂等设置器：显式标记工作组展开或折叠。
   *  由 URL 驱动的自动展开 effect（始终设为 true）和直接编程控制使用。 */
  setRigExpanded: (rigId: string, expanded: boolean) => void;
  /** 点击切换：翻转工作组的展开状态。由 RigGroupNode 主体点击使用。 */
  toggleRig: (rigId: string) => void;
}

const TopologyOverlayContext = createContext<TopologyOverlayContextValue>({
  mode: "opaque",
  setMode: () => {},
  expandedRigs: new Map(),
  setRigExpanded: () => {},
  toggleRig: () => {},
});

/** 从拓扑路径名解析活动工作组标识符。由 provider 的自动展开 effect
 *  以及需要知道 URL 当前作用于哪个工作组的消费者使用
 * （例如活动行高亮）。当路径名不在工作组范围路由上时返回 null。 */
export function parseActiveRigId(pathname: string): string | null {
  const seat = pathname.match(/^\/topology\/seat\/([^/]+)\//);
  if (seat) return decodeURIComponent(seat[1]!);
  const pod = pathname.match(/^\/topology\/pod\/([^/]+)\//);
  if (pod) return decodeURIComponent(pod[1]!);
  const rig = pathname.match(/^\/topology\/rig\/([^/]+)$/);
  if (rig) return decodeURIComponent(rig[1]!);
  return null;
}

export function TopologyOverlayProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ExplorerMode>("opaque");
  const setMode = useCallback((next: ExplorerMode) => {
    setModeState(next);
  }, []);

  // V1 润色切片第 5.2 阶段回弹修复 —— 工作组展开状态提升到 provider 作用域，
  // 使直接 URL 导航（HostMultiRigGraph 因路由是兄弟节点而未挂载时）
  // 仍能更新 HostMultiRigGraph 在用户返回 /topology 时读取的状态。
  const [expandedRigs, setExpandedRigs] = useState<Map<string, boolean>>(
    () => new Map(),
  );
  const setRigExpanded = useCallback((rigId: string, expanded: boolean) => {
    setExpandedRigs((prev) => {
      if (prev.has(rigId) && prev.get(rigId) === expanded) return prev;
      const next = new Map(prev);
      next.set(rigId, expanded);
      return next;
    });
  }, []);
  const toggleRig = useCallback((rigId: string) => {
    setExpandedRigs((prev) => {
      const next = new Map(prev);
      next.set(rigId, !(prev.get(rigId) ?? false));
      return next;
    });
  }, []);

  // provider 作用域的自动展开 effect。通过 useRouterState 读取路径名
  //（provider 在 AppShell 下的 RouterProvider 树内）。每当路由在工作组范围
  // 拓扑 URL 上时，标记对应工作组为展开。不管当前中心挂载的是哪个范围页面
  // 都触发——解决了之前组件内自动展开的死代码 bug。
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    const rigId = parseActiveRigId(pathname);
    if (rigId) setRigExpanded(rigId, true);
  }, [pathname, setRigExpanded]);

  const value = useMemo<TopologyOverlayContextValue>(
    () => ({ mode, setMode, expandedRigs, setRigExpanded, toggleRig }),
    [mode, setMode, expandedRigs, setRigExpanded, toggleRig],
  );

  return (
    <TopologyOverlayContext.Provider value={value}>
      {children}
    </TopologyOverlayContext.Provider>
  );
}

export function useTopologyOverlay(): TopologyOverlayContextValue {
  return useContext(TopologyOverlayContext);
}
