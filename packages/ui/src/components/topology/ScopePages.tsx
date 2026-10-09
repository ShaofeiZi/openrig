// V1 attempt-3 Phase 3 —— 依 topology-tree.md 的拓扑 scope 页。
//
// SC-10 承重：视图模式标签页就地切换——跨标签页切换保持单一 URL。标签页状态是 React useState，
// 不是 URL 参数。每个 scope 页渲染其标签页导航 + 激活的视图模式面板。
// （Attempt-2 因对每个视图模式用独立路由而违反此点。）

import { useState, useEffect } from "react";
import { useParams } from "@tanstack/react-router";
import {
  TopologyViewModeTabs,
  HOST_SCOPE_TABS,
  RIG_POD_SCOPE_TABS,
  SEAT_SCOPE_TABS,
  type TopologyHostScopeTab,
  type TopologyRigPodScopeTab,
  type TopologySeatScopeTab,
} from "./TopologyViewModeTabs.js";
import { TopologyTableView } from "./TopologyTableView.js";
import { ErrorBoundary } from "../ui/ErrorBoundary.js";
// OPR.0.4.6.2 (FR-5)：已交付的 rig 作用域“在 CMUX 中启动”按钮泛化为
// provider + 视图选择器（herdr 主选，cmux 尽力）。同一标签栏尾部槽位；
// LaunchCmuxButton.tsx 保留（其图/详情入口不动），在此处被 TerminalLauncher 取代。
import { TerminalLauncher } from "./TerminalLauncher.js";
import { TopologyTerminalView } from "./TopologyTerminalView.js";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { RigGraph } from "../RigGraph.js";
import { RigSpecDisplay } from "../RigSpecDisplay.js";
import { RigStatusControl } from "../RigStatusControl.js";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import { useHosts, useSelectHost, useHostSelection } from "../../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import { useSpecLibrary, useLibraryReview, type LibraryRigReview } from "../../hooks/useSpecLibrary.js";
import { LiveNodeDetails } from "../LiveNodeDetails.js";
import { useTopologyOverlay } from "./topology-overlay-context.js";
// V1 attempt-3 Phase 5 P5-9：图视图模式在窄视口下降级为表格，
// 依 universal-shell.md L143（“拓扑图视图在手机上默认降级为表格视图
// （图对手机屏幕过密）”）。
import { useShellViewport } from "../../hooks/useShellViewport.js";
import { useNodeInventory } from "../../hooks/useNodeInventory.js";
import { computeActivityRollup, formatRollupLabel } from "../../lib/activity-visuals.js";

function ActivityRollupBar({ rigId }: { rigId: string }) {
  const { data: nodes } = useNodeInventory(rigId);
  if (!nodes || nodes.length === 0) return null;
  const rollup = computeActivityRollup(
    nodes.map((n) => ({ activity: n.agentActivity, terminalActive: n.terminalActive })),
  );
  return (
    <div
      data-testid="activity-rollup-bar"
      className="px-6 py-2 font-mono text-[10px] text-on-surface-variant border-b border-outline-variant bg-surface-lowest/30"
    >
      {formatRollupLabel(rollup)}
    </div>
  );
}
// V1 polish slice Phase 5.2：HostScopePage 图视图模式用多 rig 单画布组件
// 取代先前占位（rig 折叠入口；默认全部折叠；按 URL 自动展开）。
import { HostMultiRigGraph } from "./HostMultiRigGraph.js";
// OPR.0.4.0.1：每个 scope 页一个全局 LiveTerminalProvider，约束该页图 + 表格 +
// 终端标签表面上的实时终端总数。
import { LiveTerminalProvider, useTerminalCap } from "../terminal/LiveTerminalProvider.js";

/** 根据 scope 页激活的视图模式设置 AppShell 的 Explorer 叠加模式。
 *  图视图模式 → 叠加（画布上 vellum 半透明 Explorer）；表格/终端 → 不透明。
 *  组件卸载时重置为不透明，使非拓扑目标不继承叠加状态。 */
function useOverlayForActiveTab(active: string) {
  const { setMode } = useTopologyOverlay();
  useEffect(() => {
    setMode(active === "graph" ? "overlay" : "opaque");
    return () => {
      setMode("opaque");
    };
  }, [active, setMode]);
}

function ScopeShell({
  tabsNav,
  children,
}: {
  /** eyebrow + title 不再渲染：仅标签页，锚定到 Explorer 右侧。scope
   *  身份从 URL + Explorer 树激活状态读取，画布中 DISCOVERY.INTAKE-ROUTER 式大标题冗余。
   *  暂保留 prop 名，以防 Phase 5 想恢复较小的面包屑。 */
  eyebrow?: string;
  title?: string;
  tabsNav: React.ReactNode;
  children: React.ReactNode;
}) {
  // B 类固定锚点：tabsNav 位于左侧 = var(--explorer-anchor-left)
  // （在 AppShell 的 <main> 上设置），使 graph/table/terminal 切换时位置一致。
  // 画布上方透明——纸张网格透出。z-30 使标签页在图模式下位于 Explorer 叠加之上
  // （标签页锚定在 Explorer 右缘之外，本不应重叠，但 z 序是安全网）。
  return (
    <div className="flex flex-col h-full">
      <div
        className="relative z-30 px-6 pt-4"
        style={{ marginLeft: "var(--header-anchor-offset, 0px)" }}
      >
        {tabsNav}
      </div>
      {/* flex 列，使激活的视图模式面板占满剩余高度。min-h-0 让 flex 子项在
          AppShell 主滚动容器内正确收缩。 */}
      <div className="flex-1 min-h-0 flex flex-col">
        {children}
      </div>
    </div>
  );
}

// V1 attempt-3 Phase 5 P5-7：TopologyTerminalView 用真实的 safe-N=12 分页钉住卡片网格
// + 活动终端上的脉冲环取代占位（依 topology-terminal-view.md L47/L60-65/L70-80）。

export function HostScopePage() {
  const [active, setActive] = useState<TopologyHostScopeTab>("graph");
  const { data: rigs, error: rigsError, isFetching, isPlaceholderData, refetch } = useRigSummary();
  const { isWideLayout } = useShellViewport();
  useOverlayForActiveTab(active);

  // OPR.0.4.6.MH2 FR-3/FR-6 —— 页面标题命名真实数据源
  // （硬编码的 "localhost" 已移除）：本地渲染 MH-1 自身名，
  // 远端选择渲染其 host id。远端读取状态如实：
  // 读取失败用按 host 命名的不可达面板取代画布（重试 + 返回本地，依锁定的 fr6-unreachable twin）；
  // 进行中的拉取在先前视图上方显示真实横幅（keepPreviousData，依 fr6-loading）。本地从不出现这两者。
  const { data: hostsData } = useHosts();
  const selectHost = useSelectHost();
  const selectedHost = hostsData?.selected ?? LOCAL_HOST_ID;
  const isRemote = selectedHost !== LOCAL_HOST_ID;
  const ownName = hostsData?.ownName && hostsData.ownName.trim() !== "" ? hostsData.ownName : "localhost";

  // P5-9 移动图降级：<lg 视口下，按 universal-shell.md L143 把图视图模式视为表格。
  // 标签导航仍显示图为选中（操作者可拖宽，图会重新激活）。
  const effectiveActive = !isWideLayout && active === "graph" ? "table" : active;
  const liveCap = useTerminalCap();

  const remoteUnreachable = isRemote && !!rigsError;
  const remoteLoading = isRemote && !remoteUnreachable && (isPlaceholderData || (isFetching && rigs === undefined));

  return (
    <LiveTerminalProvider cap={liveCap}>
    <ScopeShell
      eyebrow="拓扑 · 主机"
      title={isRemote ? selectedHost : ownName}
      tabsNav={<TopologyViewModeTabs tabs={HOST_SCOPE_TABS} active={active} onSelect={setActive} testIdPrefix="topology-host" />}
    >
      {remoteUnreachable ? (
        <div
          className="px-6 py-6"
          style={{ marginLeft: "var(--header-anchor-offset, 0px)" }}
        >
          <div
            data-testid="topology-remote-unreachable"
            className="max-w-2xl border-l-2 border-error bg-surface-low px-4 py-4 font-mono text-xs"
          >
            <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-error">
              {selectedHost} 不可达
            </div>
            <p className="mb-1 text-on-surface">
              本地后台服务无法连接到 {selectedHost} 的后台服务，无法显示其工作区。
            </p>
            <p className="mb-3 text-[10px] text-on-surface-variant">
              请确认该主机已启动并完成配对（zrig host ls），然后重试。其他主机不受影响。
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="topology-remote-retry"
                onClick={() => void refetch()}
                className="border border-outline px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-on-surface hover:bg-surface-low/60"
              >
                重试
              </button>
              <button
                type="button"
                data-testid="topology-remote-back-local"
                onClick={() => selectHost.mutate({ hostId: LOCAL_HOST_ID })}
                className="border border-outline-variant px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-on-surface-variant hover:text-on-surface"
              >
                返回 {ownName}（本地）
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {remoteLoading ? (
        <div
          data-testid="topology-remote-loading"
          className="mr-6 mt-3 border border-outline-variant bg-surface-low px-3 py-2 font-mono text-[10px] text-on-surface-variant"
          style={{ marginLeft: "calc(var(--header-anchor-offset, 0px) + 1.5rem)" }}
        >
          正在通过网络拉取 {selectedHost} 的工作区……到达前先显示先前视图。
        </div>
      ) : null}
      {!remoteUnreachable && effectiveActive === "graph" ? (
        <div className="flex-1 min-h-0 relative">
          <HostMultiRigGraph />
        </div>
      ) : null}
      {effectiveActive === "table" ? (
        <div className="px-6 pb-6">
          {!isWideLayout && active === "graph" ? (
            <p
              data-testid="topology-mobile-graph-degraded"
              className="font-mono text-[9px] text-on-surface-variant italic mb-2"
            >
              窄视口下图视图降级为表格。
            </p>
          ) : null}
          {/* OPR.0.4.1.13：包住表格渲染异常，避免白屏。 */}
          <ErrorBoundary label="表格视图">
            <TopologyTableView />
          </ErrorBoundary>
        </div>
      ) : null}
      {effectiveActive === "terminal" ? <TopologyTerminalView scope="host" /> : null}
    </ScopeShell>
    </LiveTerminalProvider>
  );
}

export function RigScopePage() {
  // OPR.0.4.6.MH2 guard delta-confirm blocker：生命周期/操作表面是三态——
  // 未知选择时不挂载任何本地控件，也不发裸状态读取（useSelectedHostId 预缓存默认本地，
  // 对一个挂载即发读取的表面会 OPEN 失败）。主动观察者：页面自行获知选择。
  const { known: hostSelectionKnown, isLocal: hostSelectionLocal } = useHostSelection();
  const rigScopeIsRemote = hostSelectionKnown && !hostSelectionLocal;
  const rigScopeActionsAllowed = hostSelectionKnown && hostSelectionLocal;
  const { rigId } = useParams({ from: "/topology/rig/$rigId" });
  const { data: rigs } = useRigSummary();
  const rig = rigs?.find((r) => r.id === rigId);
  const [active, setActive] = useState<TopologyRigPodScopeTab>("graph");
  const { isWideLayout } = useShellViewport();
  useOverlayForActiveTab(active);

  const effectiveActive = !isWideLayout && active === "graph" ? "table" : active;
  const liveCap = useTerminalCap();

  return (
    <LiveTerminalProvider cap={liveCap}>
    <ScopeShell
      eyebrow="拓扑 · 工作组"
      title={rig?.name ?? rigId}
      tabsNav={
        <TopologyViewModeTabs
          tabs={RIG_POD_SCOPE_TABS}
          active={active}
          onSelect={setActive}
          testIdPrefix="topology-rig"
          // OPR.0.4.6.MH2 rev1-r2 B1 —— 在 CMUX 中启动是本地操作
          // （裸本地 open-cmux POST）；远端视图上无跨主机变更入口（FR-7）。
          trailing={rigScopeActionsAllowed ? <TerminalLauncher rigId={rigId} rigName={rig?.name ?? null} /> : null}
        />
      }
    >
      {/* OPR.0.4.3.22 —— rig 标题附近的 rig 状态 + 启动/恢复控件。
          终端表面操作（在 CMUX 中启动）单独渲染在标签栏（尾部，上方），从不恢复或新鲜预热。
          OPR.0.4.6.MH2 rev1-r2 复核 B1：整个控件是本地
          恢复/启动表面（裸 /api/rigs/:id/status 读取 + 启动计划
          + /up POST）——远端选择下从不挂载；用如实的只读标记代替（FR-7）。 */}
      {!hostSelectionKnown ? (
        <div
          className="px-6 pt-4 max-w-md"
          style={{ marginLeft: "var(--header-anchor-offset, 0px)" }}
        >
          <div
            data-testid="rig-status-selection-pending"
            className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant italic"
          >
            正在解析所选主机…
          </div>
        </div>
      ) : rigScopeIsRemote ? (
        <div
          className="px-6 pt-4 max-w-md"
          // 与 FR-6 表面相同的锚定纪律：图叠加模式下在 explorer 叠加后仍可读；
          // 0px 回退使非叠加模式不变。
          style={{ marginLeft: "var(--header-anchor-offset, 0px)" }}
        >
          <div
            data-testid="rig-status-remote-readonly"
            data-remote-readonly="true"
            className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant"
          >
            只读——远端主机（启动/恢复是本地操作）
          </div>
        </div>
      ) : (
        // OPR.0.4.7.1 —— 紧凑控件，右对齐：explorer 叠加
        // 锚定左侧，故右对齐使启动控件在图叠加模式下完全可见（复现的卡片被遮挡 bug）。
        <div className="px-6 pt-4 flex justify-end">
          <ErrorBoundary label="工作组状态">
            <RigStatusControl rigId={rigId} rigName={rig?.name ?? rigId} />
          </ErrorBoundary>
        </div>
      )}
      <ActivityRollupBar rigId={rigId} />
      {effectiveActive === "graph" ? (
        <div className="flex-1 min-h-0 relative">
          <RigGraph rigId={rigId} rigName={rig?.name ?? null} showDiscovered={false} />
        </div>
      ) : null}
      {effectiveActive === "table" ? (
        <div className="px-6 pb-6">
          {!isWideLayout && active === "graph" ? (
            <p
              data-testid="topology-mobile-graph-degraded"
              className="font-mono text-[9px] text-on-surface-variant italic mb-2"
            >
              窄视口下图视图降级为表格。
            </p>
          ) : null}
          {/* OPR.0.4.1.13：包住表格渲染异常，避免白屏。 */}
          <ErrorBoundary label="表格视图">
            <TopologyTableView rigIdScope={rigId} />
          </ErrorBoundary>
        </div>
      ) : null}
      {effectiveActive === "terminal" ? <TopologyTerminalView scope="rig" rigId={rigId} /> : null}
      {active === "overview" ? <RigOverviewTab rigId={rigId} rigName={rig?.name ?? null} /> : null}
    </ScopeShell>
    </LiveTerminalProvider>
  );
}

/** V1 polish slice Phase 5.1 P5.1-6 —— Rig 概览标签页。
 *
 *  挂载既有规范 RigSpecDisplay 组件（来自 /specs/rig/$id），
 *  经 useSpecLibrary("rig") + useLibraryReview 取数。按 rig 名匹配库条目
 *  （依 LibraryReview.tsx 模式）并渲染 spec 详情。
 */
function RigOverviewTab({ rigId, rigName }: { rigId: string; rigName: string | null }) {
  const { data: entries = [], isLoading: entriesLoading } = useSpecLibrary("rig");
  // 有 rig 名时按名匹配；某些 rig 每个名字可能对应一条库条目
  // （操作者撰写的 rig spec）。
  const matches = rigName ? entries.filter((e) => e.name === rigName) : [];
  const entryId = matches.length === 1 ? matches[0]!.id : null;
  const { data: review, isLoading: reviewLoading } = useLibraryReview(entryId);

  if (entriesLoading || reviewLoading) {
    return (
      <div className="p-6">
        <div className="font-mono text-[10px] text-on-surface-variant">正在加载工作组规格…</div>
      </div>
    );
  }
  if (matches.length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          label="无工作组规格"
          description={`未找到 "${rigName ?? rigId}" 对应的 rig spec 条目。请通过 /specs 撰写。`}
          variant="card"
          testId="topology-rig-overview-no-spec"
        />
      </div>
    );
  }
  if (matches.length > 1) {
    return (
      <div className="p-6">
        <EmptyState
          label="工作组规格不唯一"
          description={`有 ${matches.length} 条 rig spec 条目匹配 "${rigName ?? rigId}"。请到 /specs 消歧。`}
          variant="card"
        />
      </div>
    );
  }
  if (!review || review.kind !== "rig") {
    return (
      <div className="p-6">
        <EmptyState
          label="工作组规格不可用"
          description="工作组规格加载失败。"
          variant="card"
        />
      </div>
    );
  }
  const rigReview = review as LibraryRigReview;
  return (
    <div className="px-6 pb-6" data-testid="topology-rig-overview">
      <RigSpecDisplay
        review={rigReview}
        yaml={rigReview.raw}
        testIdPrefix="topology-rig-overview-"
      />
    </div>
  );
}

export function PodScopePage() {
  // V1 polish slice Phase 5.1 P5.1-5：pod 作用域图接通
  // RigGraph 新的 podScope prop（把节点 + 边 + pod 分组过滤到匹配 pod）。
  // 默认标签页移到 "graph"，使图视图模式成为落地表面
  // （与 host/rig 作用域模式一致；pod 作用域应遵守与其他作用域相同的
  // 图/表格/终端语法。
  const { rigId, podName } = useParams({ from: "/topology/pod/$rigId/$podName" });
  const [active, setActive] = useState<TopologyRigPodScopeTab>("graph");
  const { isWideLayout } = useShellViewport();
  useOverlayForActiveTab(active);
  const effectiveActive = !isWideLayout && active === "graph" ? "table" : active;

  return (
    <ScopeShell
      eyebrow="拓扑 · Pod"
      title={`${rigId} / ${podName}`}
      tabsNav={<TopologyViewModeTabs tabs={RIG_POD_SCOPE_TABS} active={active} onSelect={setActive} testIdPrefix="topology-pod" />}
    >
      {effectiveActive === "graph" ? (
        <div className="flex-1 min-h-0 relative">
          <RigGraph rigId={rigId} rigName={null} showDiscovered={false} podScope={podName} />
        </div>
      ) : null}
      {effectiveActive === "table" ? (
        <div className="px-6 pb-6">
          {!isWideLayout && active === "graph" ? (
            <p
              data-testid="topology-mobile-graph-degraded"
              className="font-mono text-[9px] text-on-surface-variant italic mb-2"
            >
              窄视口下图视图降级为表格。
            </p>
          ) : null}
          {/* OPR.0.4.1.13：包住表格渲染异常，避免白屏。 */}
          <ErrorBoundary label="表格视图">
            <TopologyTableView rigIdScope={rigId} podNameScope={podName} />
          </ErrorBoundary>
        </div>
      ) : null}
      {effectiveActive === "terminal" ? (
        <TopologyTerminalView scope="pod" rigId={rigId} podName={podName} />
      ) : null}
      {active === "overview" ? (
        <div className="p-6">
          <EmptyState label="Pod 概览" description="Pod 详情（阶段 5）。" variant="card" />
        </div>
      ) : null}
    </ScopeShell>
  );
}

export function SeatScopePage() {
  // V1 polish slice Phase 5.1 P5.1-1 + DRIFT P5.1-D1：外层作用域标签页
  // （detail / transcript / terminal）在 V1 polish 退役。
  // LiveNodeDetails 内联拥有规范的 5 标签页主体行
  // （身份 / 智能体 Spec / 启动 / 转录 / 终端）。
  // ScopeShell 包装也一并去掉——LiveNodeDetails 即页面。
  const { rigId, logicalId } = useParams({ from: "/topology/seat/$rigId/$logicalId" });
  const decodedLogicalId = decodeURIComponent(logicalId);
  return (
    <div data-testid="seat-scope-page" className="flex flex-col h-full">
      <LiveNodeDetails rigId={rigId} logicalId={decodedLogicalId} />
    </div>
  );
}
