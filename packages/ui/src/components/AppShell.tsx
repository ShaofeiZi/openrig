// V1 第 2 阶段尝试 3 —— AppShell 外壳。
//
// 按 universal-shell.md L13–L34（布局契约）的通用外壳：
// 导轨（48px）+ 探索侧栏（280px）+ 中心工作区（flex）+ 内容抽屉（打开时约 720px / 关闭时 0）。
//
// 第 2 阶段删除了 Sidebar.tsx（承重结构修复尝试 1+2 未解决的问题），
// 铺设规范导轨，含 6 个目标图标 + 2 个聊天图标（Advisor、Operator V1 占位，
// 见 agent-chat-surface.md L45–L52）。
//
// 第 3 阶段填充 Explorer 中的树内容；第 4 阶段将抽屉查看器 + 聊天图标点击行为
// 连线到配置的 advisor/operator 席位。
//
// SC-1 满足：桌面端恰好 2 个左侧外壳（导轨 + 探索）。
// SC-2 满足：导轨顺序 仪表盘 / 拓扑 / 为你推荐 / 项目 / 资料库 / 设置
// + Advisor + Operator（导轨中无发现）。
// SC-7 满足：设置挂载在中心区域（导轨图标 → /settings 路由，而非抽屉切换）。
// SC-8 满足：移动端导轨折叠为顶栏菜单；探索变为滑出层。

import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
  createContext,
  useContext,
  type ComponentType,
} from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Brain,
  Cog,
  FileText,
  Folder,
  LayoutDashboard,
  Network,
  Sparkles,
  Wrench,
} from "lucide-react";
import { Explorer, shouldSuppressExplorerMount, type ExplorerSurface } from "./Explorer.js";
import { SharedDetailDrawer, type DrawerSelection } from "./SharedDetailDrawer.js";
import { PreviewStack } from "./preview/PreviewStack.js";
import type { DiscoveryPlacementTarget } from "./DiscoveryPanel.js";
import { SpecsWorkspaceProvider } from "./SpecsWorkspace.js";
import {
  TopologyOverlayProvider,
  useTopologyOverlay,
} from "./topology/topology-overlay-context.js";
import { ThemeSelector } from "./ThemeSelector.js";
import { useSettings } from "../hooks/useSettings.js";
import { useActivityFeed } from "../hooks/useActivityFeed.js";
import { useClearPlacementOnHostSwitch } from "../hooks/useHosts.js";
import { useGlobalEvents } from "../hooks/useGlobalEvents.js";
import { cn } from "../lib/utils.js";
import { parseSessionName } from "../lib/session-name.js";
import { HostIndicator } from "./HostIndicator.js";

// =====================================================================
// 上下文（按 DRIFT P2-B 保留 + Dashboard、RigGraph 中的活跃消费者）
// =====================================================================

interface DrawerSelectionContextValue {
  selection: DrawerSelection;
  setSelection: (sel: DrawerSelection) => void;
}

interface DiscoveryPlacementContextValue {
  selectedDiscoveredId: string | null;
  setSelectedDiscoveredId: (id: string | null) => void;
  placementTarget: DiscoveryPlacementTarget;
  setPlacementTarget: (target: DiscoveryPlacementTarget) => void;
  clearPlacement: () => void;
}

export const DrawerSelectionContext = createContext<DrawerSelectionContextValue>({
  selection: null,
  setSelection: () => {},
});

export const DiscoveryPlacementContext = createContext<DiscoveryPlacementContextValue>({
  selectedDiscoveredId: null,
  setSelectedDiscoveredId: () => {},
  placementTarget: null,
  setPlacementTarget: () => {},
  clearPlacement: () => {},
});

export function useDrawerSelection() {
  return useContext(DrawerSelectionContext);
}

export function useDiscoveryPlacement() {
  return useContext(DiscoveryPlacementContext);
}

// V1 润色切片第 5.1 阶段 P5.1-1 + DRIFT P5.1-D2：useNodeSelection
// 别名已完全退役。'seat-detail' 类型退役后，唯一调用点（RigGraph 节点点击）
// 现在使用 useNavigate 直接路由到 /topology/seat/$rigId/$logicalId 中心页面。
// 已通过 grep 验证——除旧版 AppShell 导出外，无剩余生产环境消费者使用
// useNodeSelection 或 NodeSelectionContext。
//
// NodeSelectionContext 别名保留为空操作导出，供仍导入该符号的测试文件使用
//（反向断言守卫）；函数本身已完全退役。
export const NodeSelectionContext = DrawerSelectionContext;

// =====================================================================
// 导轨图标名册 —— universal-shell.md L37–L58 + agent-chat-surface.md V1 占位
// =====================================================================

interface RailIconSpec {
  id: string;
  label: string;
  to: string;
  // lucide-react 图标接受 SVG 属性（strokeWidth、color、size 等）。
  icon: ComponentType<{ className?: string; strokeWidth?: number | string }>;
  /** 用于激活状态匹配的路径前缀。 */
  activeWhen: (pathname: string) => boolean;
  testId: string;
  group: "destination" | "chat";
}

// V1 默认席位，见 agent-chat-surface.md L51–L52。第 4 阶段切换为
// ConfigStore 驱动的解析（`agents.advisor_session` /
// `agents.operator_session`）；第 2 阶段以 /settings 链接挂载图标作为功能占位。
const RAIL_ICONS: RailIconSpec[] = [
  {
    id: "dashboard",
    label: "仪表盘",
    to: "/",
    icon: LayoutDashboard,
    activeWhen: (p) => p === "/",
    testId: "rail-dashboard",
    group: "destination",
  },
  {
    id: "topology",
    label: "拓扑",
    to: "/topology",
    icon: Network,
    activeWhen: (p) => p.startsWith("/topology") || p.startsWith("/rigs/"),
    testId: "rail-topology",
    group: "destination",
  },
  {
    id: "for-you",
    label: "为你推荐",
    to: "/for-you",
    icon: Sparkles,
    activeWhen: (p) => p.startsWith("/for-you"),
    testId: "rail-for-you",
    group: "destination",
  },
  {
    id: "project",
    label: "项目",
    to: "/project",
    icon: Folder,
    activeWhen: (p) => p.startsWith("/project"),
    testId: "rail-project",
    group: "destination",
  },
  {
    id: "specs",
    label: "资料库",
    to: "/specs",
    icon: FileText,
    activeWhen: (p) => p.startsWith("/specs") || p.startsWith("/plugins"),
    testId: "rail-specs",
    group: "destination",
  },
  {
    id: "settings",
    label: "设置",
    to: "/settings",
    icon: Cog,
    activeWhen: (p) => p.startsWith("/settings"),
    testId: "rail-settings",
    group: "destination",
  },
  {
    id: "advisor",
    label: "顾问",
    to: "/settings#agents-advisor-session",
    icon: Brain,
    activeWhen: () => false,
    testId: "rail-advisor",
    group: "chat",
  },
  {
    id: "operator",
    label: "操作员",
    to: "/settings#agents-operator-session",
    icon: Wrench,
    activeWhen: () => false,
    testId: "rail-operator",
    group: "chat",
  },
];

// V1 第 4 阶段 P4-4 辅助函数 —— 配置驱动的 Advisor / Operator 点击解析。

function readSettingString(
  data: { settings?: Record<string, { value?: unknown }> } | undefined,
  key: string,
): string {
  if (!data || !data.settings) return "";
  const v = data.settings[key]?.value;
  return typeof v === "string" ? v : "";
}

/** 将 ConfigStore 会话字符串（"logicalId@rigId"）映射为导航目标。
 *  已配置时：`/topology/seat/$rigId/$logicalId`。未配置时：
 *  `/settings#agents-{role}-session`。按 universal-shell.md L80
 *（一键导航；非弹窗再 CTA 两次点击）。 */
function resolveChatTo(session: string, role: "advisor" | "operator"): string {
  if (!session) return `/settings#agents-${role}-session`;
  // OPR.0.4.6.MH1 FR-8：共享解析契约；非规范（格式错误/遗留）回退到 /settings。
  const parsed = parseSessionName(session);
  if (parsed.kind !== "canonical") return `/settings#agents-${role}-session`;
  return `/topology/seat/${encodeURIComponent(parsed.rig)}/${encodeURIComponent(parsed.member)}`;
}

// =====================================================================
// 路径 → Explorer 表面映射
// =====================================================================

function surfaceForPath(pathname: string): ExplorerSurface {
  if (pathname.startsWith("/topology") || pathname.startsWith("/rigs/")) return "topology";
  if (pathname.startsWith("/project")) return "project";
  if (pathname.startsWith("/specs") || pathname.startsWith("/plugins")) return "specs";
  if (pathname.startsWith("/for-you")) return "for-you";
  if (pathname.startsWith("/settings")) return "settings";
  return "none";
}

// =====================================================================
// 导轨组件
// =====================================================================

function Rail({
  pathname,
  onMobileClose,
  vertical,
}: {
  pathname: string;
  onMobileClose?: () => void;
  vertical: boolean;
}) {
  const destinationIcons = RAIL_ICONS.filter((i) => i.group === "destination");
  // V1 第 4 阶段尝试 3 P4-4 —— Advisor / Operator 点击处理器
  // 从 ConfigStore（通过 useSettings）解析 `agents.advisor_session` /
  // `agents.operator_session`。已配置时：导航到席位详情。未配置时：
  // 导航到 /settings#agents-{role}-session CTA。
  // 默认值来自 universal-shell.md L83-L84
  //（advisor = advisor-lead@openrig-velocity；operator = 空/未配置）。
  const { data: settingsData } = useSettings();
  const advisorSession = readSettingString(settingsData, "agents.advisor_session");
  const operatorSession = readSettingString(settingsData, "agents.operator_session");
  const chatIcons: RailIconSpec[] = RAIL_ICONS.filter((i) => i.group === "chat").map((spec) => {
    if (spec.id === "advisor") {
      return { ...spec, to: resolveChatTo(advisorSession, "advisor") };
    }
    if (spec.id === "operator") {
      return { ...spec, to: resolveChatTo(operatorSession, "operator") };
    }
    return spec;
  });

  const renderIcon = (spec: RailIconSpec) => {
    const Icon = spec.icon;
    const active = spec.activeWhen(pathname);
    return (
      <Link
        key={spec.id}
        to={spec.to}
        data-testid={spec.testId}
        data-active={active}
        aria-label={spec.label}
        title={spec.label}
        onClick={onMobileClose}
        className={cn(
          // 切片 20 移动端：触控目标在移动端达到 iOS HIG 最小值（44px）
          //（默认 `h-11 w-11`），在 `lg:`（桌面端）恢复原始 40px 命中区域，
          // 因为桌面端的输入模型是鼠标精度而非拇指。
          "relative flex h-11 w-11 items-center justify-center transition-colors lg:h-10 lg:w-10",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-on-surface focus-visible:outline-offset-2",
          active
            ? "bg-inverse-surface text-background"
            : "text-on-surface hover:bg-surface-high/60 hover:text-on-surface",
        )}
      >
        {/* 更轻的图标线条：stroke-width 1.25（lucide 默认 2），
            营造建筑制图感，与 1px 幽灵边框原则一致。 */}
        <Icon className="h-5 w-5" strokeWidth={1.25} />
        {active && (
          <span
            aria-hidden="true"
            className="absolute left-0 top-1 bottom-1 w-[2px] bg-tertiary"
          />
        )}
      </Link>
    );
  };

  return (
    <nav
      data-testid="app-rail"
      aria-label="主导航"
      className={cn(
        // V1 边框粗细原则（universal-shell.md L39–L48）：
        // 区域间边缘使用 1px outline-variant 幽灵线。
        // 羊皮纸表面：与拓扑图 Explorer 遮罩相同的半透明处理，
        // 使导轨读作叠在画布上的纸页（羊皮纸层叠美学，见 universal-shell.md L48）。
        "vellum border-outline-variant flex shrink-0",
        vertical
          ? "w-12 flex-col items-center border-r py-2 gap-1"
          : "w-full flex-row items-center border-b px-2 gap-1 overflow-x-auto",
      )}
    >
      <div
        className={cn(
          "flex",
          vertical ? "flex-col gap-1 items-center" : "flex-row gap-1 items-center",
        )}
      >
        {destinationIcons.map(renderIcon)}
      </div>
      <div className={cn(vertical ? "flex-1" : "flex-1 hidden lg:block")} />
      <div
        className={cn(
          "flex",
          vertical ? "flex-col gap-1 items-center pb-1" : "flex-row gap-1 items-center",
        )}
      >
        {chatIcons.map(renderIcon)}
      </div>
    </nav>
  );
}

// =====================================================================
// AppShell
// =====================================================================

interface AppShellProps {
  children: ReactNode;
}

const WIDE_LAYOUT_BREAKPOINT = 1024;

export function AppShell({ children }: AppShellProps) {
  return (
    <SpecsWorkspaceProvider>
      <TopologyOverlayProvider>
        <AppShellInner>{children}</AppShellInner>
      </TopologyOverlayProvider>
    </SpecsWorkspaceProvider>
  );
}

function AppShellInner({ children }: AppShellProps) {
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;
  const surface = surfaceForPath(pathname);
  const { mode: explorerMode } = useTopologyOverlay();

  const [explorerOpen, setExplorerOpen] = useState(false); // 移动端滑出层状态
  const [desktopExplorerOpen, setDesktopExplorerOpen] = useState(true);
  const [isWideLayout, setIsWideLayout] = useState(() => {
    if (typeof window === "undefined") return true;
    return window.innerWidth >= WIDE_LAYOUT_BREAKPOINT;
  });
  const [selectionState, setSelectionState] = useState<DrawerSelection>(null);
  const [selectedDiscoveredId, setSelectedDiscoveredIdState] = useState<string | null>(null);
  const [placementTarget, setPlacementTargetState] = useState<DiscoveryPlacementTarget>(null);

  const { events } = useActivityFeed();

  const setSelection = useCallback(
    (next: DrawerSelection) => {
      setSelectionState(next);
      if (!isWideLayout && next) {
        setExplorerOpen(false);
      }
    },
    [isWideLayout],
  );

  const clearPlacement = useCallback(() => {
    setSelectedDiscoveredIdState(null);
    setPlacementTargetState(null);
  }, []);

  const setSelectedDiscoveredId = useCallback((id: string | null) => {
    setSelectedDiscoveredIdState(id);
    setPlacementTargetState(null);
  }, []);

  // 窗口尺寸变化 → 宽布局标志。
  useEffect(() => {
    const handleResize = () => {
      setIsWideLayout(window.innerWidth >= WIDE_LAYOUT_BREAKPOINT);
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // 跨路由：当发现选择清除时清除放置目标。
  useEffect(() => {
    if (selectionState?.type !== "discovery") clearPlacement();
  }, [selectionState, clearPlacement]);

  // OPR.0.4.6.MH2 rev1-r2 再裁定 B1：在本机状态下创建的放置目标不得在
  // 切换主机后存活——任何选中主机变更都清除目标 + 发现会话选择
  //（面板侧的大括号额外在远端下抑制采用 UI）。
  useClearPlacementOnHostSwitch(clearPlacement);

  // SC-3a —— 抽屉内容不在重新加载后持久化（它是上下文相关的）。
  // 移动端窄视口：路由变化时关闭抽屉 + 关闭探索
  // 除非路由专门处理抽屉（第 2 阶段无）。
  useEffect(() => {
    if (!isWideLayout) {
      setSelectionState(null);
      setExplorerOpen(false);
    }
  }, [isWideLayout, pathname]);

  // 挂载全局 SSE 事件监听器。
  const proofConnection = useGlobalEvents();

  const explorerVisible = surface !== "none";
  // 切片 26.D OPT-D3 拓扑移动端挂载抑制：规则在
  // shouldSuppressExplorerMount()（Explorer.tsx）中。Topology 移动端渲染路径中
  // 既有的渲染自旋在 Explorer 于 375px 挂载时会卡住浏览器；
  // 只有挂载抑制能绕开这个卡点触发器。其他 4 个目标不管视口宽度都正常挂载。
  // 0.3.2 修复 Topology 移动端渲染路径；届时此抑制将回退。
  const explorerMounted = explorerVisible && !shouldSuppressExplorerMount(surface, isWideLayout);
  const drawerOpen = Boolean(selectionState);

  // V1 第 3 阶段尝试 3 回弹修复 —— B 类固定锚点 + 选择性遮罩。
  // 拓扑图模式发出遮罩信号；仅在 /topology（surface === "topology"）时有效。
  // 其他表面始终使用不透明布局。
  const isTopologyOverlay = explorerMode === "overlay" && surface === "topology";

  // 两种模式下锚点保持不变 —— 标签栏位置从不移动。
  // 主 padding-left 不同：
  //   - 不透明：padding = 锚点（内容从探索器之后开始）
  //   - 遮罩：padding = 0（内容延伸到半透明探索器后方）；
  //            标签栏独立 sticky/positioned 在 left=锚点 处。
  // 21rem = 导轨（3rem）+ 探索器（18rem）。
  // 探索器完全打开时为 21rem（导轨 3 + 探索器 18）。
  // 折叠时：3rem（仅导轨）——浮动箭头开关浮在画布上，不占用布局空间。
  // 目标无探索器时：3rem（仅导轨）。
  const explorerAnchorLeft = isWideLayout && explorerVisible && desktopExplorerOpen
    ? "21rem"
    : "3rem";
  const workspaceLeftOffset = isWideLayout
    ? isTopologyOverlay
      ? "0rem"
      : explorerAnchorLeft
    : "0rem";
  // B 类固定锚点：头部（eyebrow + 标题 + 视图模式标签）始终
  // 位于探索器锚点偏移处，即使在画布延伸到探索器后方的遮罩模式下也是如此。
  // 这使标签栏在视图模式切换间保持稳定的左侧位置。
  const headerAnchorOffset = isWideLayout && isTopologyOverlay ? explorerAnchorLeft : "0rem";
  // 与 VellumSheet wide 预设（lg:w-[38rem]）耦合——回弹修复 #3 发现了
  // 回弹修复 #2 将抽屉从 45rem 校准到 38rem 时未更新此偏移量所产生的间隙。
  // 保持这两个字面量同步；app-shell.test.tsx 中的回归测试断言它们匹配。
  const workspaceRightOffset = isWideLayout && drawerOpen ? "38rem" : "0rem";
  const workspaceStyle = {
    "--workspace-left-offset": workspaceLeftOffset,
    "--workspace-right-offset": workspaceRightOffset,
    "--explorer-anchor-left": explorerAnchorLeft,
    "--header-anchor-offset": headerAnchorOffset,
  } as CSSProperties;

  return (
    <DrawerSelectionContext.Provider value={{ selection: selectionState, setSelection }}>
      <DiscoveryPlacementContext.Provider
          value={{
            selectedDiscoveredId,
            setSelectedDiscoveredId,
            placementTarget,
            setPlacementTarget: setPlacementTargetState,
            clearPlacement,
          }}
        >
          <div className="h-screen flex flex-col">
            {/* 顶栏 —— 按 universal-shell.md L40–L53 跨视口通用。
                单一真相来源：同一元素在所有尺寸下渲染。
                汉堡按钮保留自己的 lg:hidden，仅在窄视口出现；
                品牌标记 + 右侧槽位在所有位置可见。 */}
            <header
              data-testid="app-topbar"
              className="h-14 flex items-center justify-between px-4 bg-background border-b border-outline-variant shrink-0 relative z-30"
            >
              <div className="flex items-center gap-3">
                {/* 切片 26.E OPT-E 拓扑移动端切换 carved-out：在 /topology
                    的窄视口上不渲染菜单切换按钮。点击它会翻转 explorerOpen
                    状态从而重新渲染 AppShellInner 的子元素；拓扑移动端渲染路径
                    （TopologyTableView + TopologyTreeView）在该级联中有既存的
                    渲染成本，会在该路径上卡住浏览器——与 Explorer 抽屉本身是否挂载
                    无关（OPT-D3 已抑制）。隐藏入口点防止状态翻转触发器。
                    既存渲染自旋计划在 0.3.2 专用渲染路径切片中修复；
                    0.3.1 carved-out 保留拓扑移动端可用性
                   （降级表格仍可加载 + 导航；品牌首页链接在顶栏可达）。
                    复用 shouldSuppressExplorerMount 谓词——相同底层 carved-out 场景。 */}
                {!shouldSuppressExplorerMount(surface, isWideLayout) && (
                  <button
                    type="button"
                    data-testid="mobile-menu-toggle"
                    onClick={() => setExplorerOpen((open) => !open)}
                    aria-label="切换导航"
                    className="flex flex-col gap-[3px] p-2 lg:hidden"
                  >
                    <span className="block w-4 h-[1.5px] bg-inverse-surface" />
                    <span className="block w-4 h-[1.5px] bg-inverse-surface" />
                    <span className="block w-3 h-[1.5px] bg-inverse-surface" />
                  </button>
                )}
                <Link
                  to="/"
                  data-testid="brand-home-link"
                  className="inline-flex items-center bg-inverse-surface px-3 py-1 font-mono text-sm font-bold uppercase tracking-[0.08em] text-background hover:bg-inverse-surface"
                >
                  zrig
                </Link>
              </div>
              {/* 右侧槽位 —— V2 全局控件预留的槽位：MH-2 当前主机指示器
                  （FR-3），忠于选中的数据源。窄视口隐藏以保留移动端空间。 */}
              <div
                data-testid="topbar-right-slot"
                className="hidden sm:flex items-center gap-3"
              >
                <HostIndicator />
                {/* OPR.0.4.3.29 —— 主题选择器（位置由创始者口味决定）。 */}
                <ThemeSelector />
              </div>
            </header>

            {/* 主区域：导轨 + 探索 + 中心 + 抽屉 */}
            <div className="flex flex-1 min-h-0 relative">
              {/* 导轨 —— 仅桌面端（lg:flex）。移动端导轨在滑出层内出现。 */}
              <div className="hidden lg:flex">
                <Rail pathname={pathname} vertical />
              </div>

              {/* 移动端滑出层：导轨（水平）+ 探索。
                  仅在窄视口条件渲染，使桌面 DOM 不携带屏幕外 <nav>，
                  以免破坏 SC-1"恰好 2 个左侧外壳"计数检查。 */}
              {!isWideLayout && (
                <>
                  {explorerOpen && (
                    <div
                      className="fixed inset-0 bg-black/20 z-20 lg:hidden"
                      onClick={() => setExplorerOpen(false)}
                    />
                  )}
                  <div
                    data-testid="mobile-rail-tray"
                    className={cn(
                      "fixed top-14 left-0 bottom-0 z-30 bg-background border-r border-outline-variant transition-transform duration-200 ease-tactical lg:hidden",
                      "w-72 max-w-[85vw] flex flex-col",
                      explorerOpen ? "translate-x-0" : "-translate-x-full",
                    )}
                  >
                    {/* 切片 20 移动端：移动端滑出层导轨为垂直方向
                        （每行一项）——拇指友好的堆叠，取代之前的水平滚动。 */}
                    <Rail pathname={pathname} vertical onMobileClose={() => setExplorerOpen(false)} />
                  </div>
                </>
              )}

              {/* 探索器 —— 桌面列或移动端滑出层。
                  遮罩模式（拓扑图）：羊皮纸半透明 + z-30，浮在画布上。
                  不透明模式：z-40，按切片 26.B OPT-B（在移动端导轨托盘之上）。
                  切片 26.D OPT-D3：拓扑探索器在移动端不挂载
                  （上方 suppressTopologyMobileExplorer）。 */}
              {explorerMounted && (
                <Explorer
                  open={explorerOpen}
                  onClose={() => setExplorerOpen(false)}
                  selection={selectionState}
                  onSelect={setSelection}
                  desktopMode={desktopExplorerOpen ? "full" : "hidden"}
                  surface={surface}
                  onDesktopToggle={() => setDesktopExplorerOpen((open) => !open)}
                  overlayMode={isTopologyOverlay ? "overlay" : "opaque"}
                />
              )}

              {/* 中心工作区 */}
              <main
                data-testid="content-area"
                data-explorer-mode={isTopologyOverlay ? "overlay" : "opaque"}
                className="flex-1 flex flex-col overflow-auto relative"
                style={{
                  ...workspaceStyle,
                  paddingLeft: `var(--workspace-left-offset, 0px)`,
                }}
              >
                {!proofConnection.connected && <p role="status" className="px-4 py-1 text-sm">实时更新不可用。显示的就绪状态为上次确认的依据；静默刷新已激活。</p>}
                {/* 在 main 内将工作区偏移 CSS 变量重置为 0，使旧版子元素
                    （如 LiveNodeDetails → WorkspacePage，其自身也读取
                    var(--workspace-left-offset) 做 padding）不会双重 padding。
                    padding 已在上方 <main> 应用；子表面应将自身偏移视为 0。 */}
                <div
                  key={pathname}
                  className="relative z-10 route-enter flex-1 flex flex-col pb-14 lg:pb-0"
                  style={{
                    "--workspace-left-offset": "0px",
                    "--workspace-right-offset": "0px",
                  } as CSSProperties}
                >
                  {children}
                </div>
              </main>

              {/* 内容抽屉 —— 默认关闭（selection===null 时抽屉内部返回 null）。 */}
              <SharedDetailDrawer
                selection={selectionState}
                onClose={() => setSelection(null)}
                events={events}
                selectedDiscoveredId={selectedDiscoveredId}
                onSelectDiscoveredId={setSelectedDiscoveredId}
                placementTarget={placementTarget}
                onClearPlacement={clearPlacement}
              />

              {/* 预览终端 v0（PL-018）—— 固定预览侧导轨。
                  无固定项时自隐藏；抽屉挂载时定位在右边缘抽屉下方。 */}
              <PreviewStack />

              {/* V1 第 5 阶段 P5-9 —— 移动端底部导航，按
                  universal-shell.md L135 + L144：仅 为你推荐 / 项目 /
                  拓扑（不含 Talk；Talk 槽位在 Web 终端发布时为 V2）。
                  lg:hidden 使桌面端永不显示。 */}
              <MobileBottomNav pathname={pathname} />
            </div>
          </div>
      </DiscoveryPlacementContext.Provider>
    </DrawerSelectionContext.Provider>
  );
}

/** V1 移动端底部导航，按 universal-shell.md L135 + L144 —— 3 个槽位
 *  （为你推荐 / 项目 / 拓扑）。Talk 槽位延迟到 V2（Web 终端发布时）。
 *  以 lg:hidden 渲染，桌面端永不显示。 */
function MobileBottomNav({ pathname }: { pathname: string }) {
  const slots: Array<{
    id: "for-you" | "project" | "topology";
    label: string;
    to: string;
    activeWhen: (p: string) => boolean;
    icon: ComponentType<{ className?: string; strokeWidth?: number | string }>;
  }> = [
    { id: "for-you", label: "为你推荐", to: "/for-you", activeWhen: (p) => p.startsWith("/for-you"), icon: Sparkles },
    { id: "project", label: "项目", to: "/project", activeWhen: (p) => p.startsWith("/project"), icon: Folder },
    { id: "topology", label: "拓扑", to: "/topology", activeWhen: (p) => p.startsWith("/topology") || p.startsWith("/rigs/"), icon: Network },
  ];
  return (
    <nav
      data-testid="mobile-bottom-nav"
      aria-label="移动端底部导航"
      className="fixed bottom-0 left-0 right-0 z-40 lg:hidden vellum border-t border-outline-variant flex"
    >
      {slots.map((slot) => {
        const active = slot.activeWhen(pathname);
        return (
          <Link
            key={slot.id}
            to={slot.to}
            data-testid={`mobile-nav-${slot.id}`}
            data-active={active}
            className={cn(
              "flex-1 flex flex-col items-center justify-center gap-0.5 py-2 font-mono text-[9px] uppercase tracking-wide",
              active
                ? "text-on-surface"
                : "text-on-surface-variant hover:text-on-surface",
            )}
          >
            <slot.icon className="h-5 w-5" strokeWidth={1.25} aria-hidden="true" />
            <span>{slot.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
