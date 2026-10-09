// V1 Shell Redesign Phase 2 —— 依 shell-redesign-v1 规范文档（universal-shell.md /
// dashboard.md / topology-tree.md / project-tree.md / specs-tree.md /
// for-you-feed.md / agent-chat-surface.md）的规范路由。
//
// Phase 2 铺设路由壳。Phase 3 填充树内容 + 目标卡片 + 视图模式标签页内容。
// 依 SC-5 / SC-10，视图模式标签页在单一 URL 内就地切换（不是独立 URL）。
//
// 后台服务 /api/* 不动（SC-29）。

import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DaemonHealthProvider } from "./components/DaemonHealthProvider.js";
import { queryClient } from "./lib/query-client.js";
import { AppShell } from "./components/AppShell.js";
import { RigGraph } from "./components/RigGraph.js";
import { ImportFlow } from "./components/ImportFlow.js";
import { PackageList } from "./components/PackageList.js";
import { PackageInstallFlow } from "./components/PackageInstallFlow.js";
import { PackageDetail } from "./components/PackageDetail.js";
import { BootstrapWizard } from "./components/BootstrapWizard.js";
import { AgentSpecValidateFlow } from "./components/AgentSpecValidateFlow.js";
import { RigSpecReview } from "./components/RigSpecReview.js";
import { AgentSpecReview } from "./components/AgentSpecReview.js";
import { BundleInspector } from "./components/BundleInspector.js";
import { BundleInstallFlow } from "./components/BundleInstallFlow.js";
import { LibraryReview } from "./components/LibraryReview.js";
import { LiveNodeDetails } from "./components/LiveNodeDetails.js";
import { DiscoveryOverlay } from "./components/DiscoveryOverlay.js";
import { AuditHistoryView } from "./components/mission-control/views/AuditHistoryView.js";
import { useRigSummary } from "./hooks/useRigSummary.js";
import { EmptyState } from "./components/ui/empty-state.js";
// Phase 3 目标组件。
import { Dashboard } from "./components/dashboard/Dashboard.js";
import { Feed } from "./components/for-you/Feed.js";
import { SpecsLibraryPage } from "./components/specs/SpecsLibraryPage.js";
import { SkillDetailPage } from "./components/specs/SkillDetailPage.js";
import { SkillsIndexPage } from "./components/specs/SkillsIndexPage.js";
import { PluginsIndexPage } from "./components/specs/PluginsIndexPage.js";
// Phase 3a slice 3.3 —— 插件详情页路由。
import { PluginDetailPage } from "./components/specs/PluginDetailPage.js";
import { FilesWorkspace } from "./components/files/FilesWorkspace.js";
import { SettingsCenter } from "./components/system/SettingsCenter.js";
import { PoliciesPage } from "./components/system/PoliciesPage.js";
import { LogPage } from "./components/system/LogPage.js";
import { StatusPage } from "./components/system/StatusPage.js";
import {
  HostScopePage,
  RigScopePage,
  PodScopePage,
  SeatScopePage,
} from "./components/topology/ScopePages.js";
import {
  WorkspaceScopePage,
  MissionScopePage,
  SliceScopePage,
} from "./components/project/ScopePages.js";
import { RigAgentsPage } from "./components/review/RigAgentsPage.js";
import { FleetPage } from "./components/review/FleetPage.js";
import { WorkflowsPage } from "./components/workflow/WorkflowsPage.js";
import { WorkflowInstancePage } from "./components/workflow/WorkflowInstancePage.js";
import { ProjectGraphicsPreview } from "./components/lab/ProjectGraphicsPreview.js";
import { CardPreviewsLab } from "./components/lab/CardPreviewsLab.js";
import { VellumLab } from "./components/lab/VellumLab.js";
import {
  VellumBgLarge,
  VellumBgSmall,
  VellumBgAllover,
} from "./components/lab/VellumBackgroundLab.js";

// 根路由——把一切包在 AppShell 中
const rootRoute = createRootRoute({
  component: () => (
    <QueryClientProvider client={queryClient}>
      <DaemonHealthProvider>
        <AppShell>
          <Outlet />
        </AppShell>
      </DaemonHealthProvider>
    </QueryClientProvider>
  ),
});

// =====================================================================
// 规范目标（Phase 2 铺壳；Phase 3 填充）
// =====================================================================

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Dashboard,
});

// 拓扑目标：SC-5 / SC-10 —— 单一 URL，视图模式标签页就地切换
// （graph / table / terminal）。标签页状态是各 scope 页内部的 React useState；
// 切换标签页时 URL 保持在该 scope 路径。

const topologyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/topology",
  component: HostScopePage,
});

const topologyRigRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/topology/rig/$rigId",
  component: RigScopePage,
});

const topologyPodRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/topology/pod/$rigId/$podName",
  component: PodScopePage,
});

const topologySeatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/topology/seat/$rigId/$logicalId",
  component: SeatScopePage,
});

const forYouRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/for-you",
  component: Feed,
});

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/project",
  component: WorkspaceScopePage,
});

const projectMissionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/project/mission/$missionId",
  component: MissionScopePage,
});

const projectSliceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/project/slice/$sliceId",
  component: SliceScopePage,
});

// OPR.0.4.4.22 —— AGENTS 高度（rig 作用域独立面板）。该路由为“寻址”而存在，不是导航 chrome：
// 只能通过 ZOOM 到达（board/host 智能体计数 chip、slice 区域锚定缩放、面包屑上翻）——
// 刻意不加入任何导航 rail（架构裁定，drift-killer 4）。锚定/过滤状态随查询参数
// （?slice=、?group=）携带。
const rigAgentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents",
  component: RigAgentsPage,
});

// OPR.0.4.6.MH5 (C3) —— host 之上的 FLEET 关注高度（创始人 LOCK = BOTH 的放置选项 A；
// band 是各 host 表面上的选项 B）。像 /agents 一样按缩放寻址（寻址用，非导航 chrome）；
// 从 FLEET band 的 OPEN FLEET → 进入。展开异常状态随 ?open=<fleetKey>
// （按本族惯例在窗口侧读取），使每种状态都可深链寻址。
const fleetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/fleet",
  component: FleetPage,
});

// OPR.0.4.6.WF4 (C4) —— workflow 表面。两者都像上面的 /agents 一样按缩放寻址
// （路由为寻址而存在，非导航 chrome）：从 NEEDS-YOU workflow 行、Library 实例 band 与实例深链进入；
// 刻意不加入任何导航 rail（pm/创始人确认 v1）。
const workflowsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflows",
  component: WorkflowsPage,
});

const workflowInstanceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workflow/instance/$instanceId",
  // FR-3 `?step=<id>` 深链锚点（关注行指向的门控/失败步骤）。可选；校验为字符串，使类型化 Link 诚实。
  validateSearch: (search: Record<string, unknown>): { step?: string } => ({
    step: typeof search.step === "string" ? search.step : undefined,
  }),
  component: () => {
    const { instanceId } = useParams({ from: "/workflow/instance/$instanceId" });
    const { step } = useSearch({ from: "/workflow/instance/$instanceId" });
    return <WorkflowInstancePage instanceId={instanceId} anchorStepId={step ?? null} />;
  },
});

const specsLibraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs",
  component: SpecsLibraryPage,
});

const specsApplicationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/applications",
  component: SpecsLibraryPage,
});

// Slice 18 —— 挂载于 /specs/skills 的 Skills 顶层 Library 索引页。
// 详情路由 /specs/skills/$skillToken 保持不变，见下。
const specsSkillsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/skills",
  component: SkillsIndexPage,
});

const specsSkillRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/skills/$skillToken",
  component: () => {
    const { skillToken } = useParams({ from: "/specs/skills/$skillToken" });
    return <SkillDetailPage skillToken={skillToken} />;
  },
});

const specsSkillFileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/skills/$skillToken/file/$fileToken",
  component: () => {
    const { skillToken, fileToken } = useParams({ from: "/specs/skills/$skillToken/file/$fileToken" });
    return <SkillDetailPage skillToken={skillToken} fileToken={fileToken} />;
  },
});

// Slice 18 —— 挂载于 /specs/plugins 的 Plugins 顶层 Library 索引页。
// 下面的详情路由 /plugins/$pluginId 保持不变。
const specsPluginsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/plugins",
  component: PluginsIndexPage,
});

const filesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/files",
  component: FilesWorkspace,
});

// Phase 3a slice 3.3 —— 挂载于 /plugins/:pluginId 的插件详情页。
// Library Explorer 的 Plugins 区链接到此；AgentSpec Plugins 块
// （Batch 1）也通过“在库中查看”入口导航到此。
const pluginDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/plugins/$pluginId",
  component: () => {
    const { pluginId } = useParams({ from: "/plugins/$pluginId" });
    return <PluginDetailPage pluginId={pluginId} />;
  },
});

// 按 kind/name 的通用 spec 详情 —— Phase 4+ 按 kind 直挂既有详情页
// （RigSpecReview / AgentSpecReview 等）。
// V1 占位：kind 匹配时重定向到 /specs/library/$specName。
const specsKindRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/$specKind/$specName",
  component: () => {
    const { specName } = useParams({ from: "/specs/$specKind/$specName" });
    return <Navigate to="/specs/library/$entryId" params={{ entryId: specName }} />;
  },
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsCenter,
});

// Slice 26 —— Settings 目标变为 4 项 Explorer（Settings /
// Policies / Log / Status）。每项都是 settings 前缀下的独立路由；Explorer 侧栏负责导航。
// Slice 27 用 Claude 自动压缩策略表单填充 Policies 页。
const settingsPoliciesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/policies",
  component: PoliciesPage,
});
const settingsLogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/log",
  component: LogPage,
});
const settingsStatusRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/status",
  component: StatusPage,
});

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/search",
  component: AuditHistoryView,
});

const projectGraphicsPreviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/lab/project-graphics-preview",
  component: ProjectGraphicsPreview,
});

// V0.3.1 slice 21 onboarding-conveyor —— for-you 卡片类型变体画廊。
// 与 `/lab/project-graphics-preview` 模式一致。
const cardPreviewsLabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/lab/card-previews",
  component: CardPreviewsLab,
});

// 2026-05-13 —— vellum 展示设计实验。静态 dashboard 形状，
// 用于在不触碰生产 dashboard 的情况下迭代分层 vellum 技法。调妥后把配方移植回
// packages/ui/src/components/dashboard/。
const vellumLabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/lab/vellum-lab",
  component: VellumLab,
});

// 2026-05-14 iter 2 —— 按创始人指令、附参考照片的 back-layer “满版印花”spike。
// iter 1（战术标记）方向错误；本 iter 用大号褪色抽象图形
// （企业徽 / 辐射符号 / 衬线字体）做三种尺寸/密度处理。
const vellumBgLargeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/lab/vellum-bg/a-large",
  component: VellumBgLarge,
});
const vellumBgSmallRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/lab/vellum-bg/b-small",
  component: VellumBgSmall,
});
const vellumBgAlloverRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/lab/vellum-bg/c-allover",
  component: VellumBgAllover,
});

// =====================================================================
// 依 code-map 在树之后保留的既有路由（不在删除清单中）
// =====================================================================

// Rig 图（旧版详情；拓扑目标已取代——保留到 Phase 3 接好 /topology/rig/$rigId）。
function RigDetail() {
  const { rigId } = useParams({ from: "/rigs/$rigId" });
  const { data: rigs } = useRigSummary();
  const rigName = rigs?.find((r: { id: string; name: string }) => r.id === rigId)?.name;
  return (
    <div className="flex flex-col flex-1 h-full">
      <div className="flex-1 min-h-[400px] relative">
        <RigGraph rigId={rigId} rigName={rigName ?? null} showDiscovered={false} />
      </div>
    </div>
  );
}

const rigDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/rigs/$rigId",
  component: RigDetail,
});

const liveNodeDetailsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/rigs/$rigId/nodes/$logicalId",
  component: () => {
    const { rigId, logicalId } = useParams({ from: "/rigs/$rigId/nodes/$logicalId" });
    return <LiveNodeDetails rigId={rigId} logicalId={decodeURIComponent(logicalId)} />;
  },
});

const importRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/import",
  component: ImportFlow,
});

const packagesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/packages",
  component: PackageList,
});

const packageInstallRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/packages/install",
  component: PackageInstallFlow,
});

const packageDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/packages/$packageId",
  component: PackageDetail,
});

const bootstrapRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/bootstrap",
  component: BootstrapWizard,
});

const agentValidateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents/validate",
  component: AgentSpecValidateFlow,
});

// /specs/rig + /specs/agent + /specs/library/$entryId —— 依 code-map 在树之后保留的既有评审表面。
// 不自动打开抽屉（SC-6：抽屉默认关闭；仅在具名触发时打开）。
const rigSpecReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/rig",
  component: RigSpecReview,
});

const agentSpecReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/agent",
  component: AgentSpecReview,
});

const libraryReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/specs/library/$entryId",
  component: () => {
    const { entryId } = useParams({ from: "/specs/library/$entryId" });
    return <LibraryReview entryId={entryId} />;
  },
});

// Discovery —— 依 code-map 保留（“发现表面——保留，但评估路由”）。
// 不自动打开抽屉（SC-6）。
const discoveryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/discovery",
  component: () => (
    <div className="flex h-full w-full items-center justify-center p-8">
      <EmptyState
        label="发现"
        description="发现界面已保留；按代码导航图推迟重设计。"
        variant="card"
        testId="discovery-placeholder"
      />
    </div>
  ),
});

const discoveryInventoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/discovery/inventory",
  component: DiscoveryOverlay,
});

const bundleInspectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/bundles/inspect",
  component: BundleInspector,
});

const bundleInstallRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/bundles/install",
  component: BundleInstallFlow,
});

// =====================================================================
// 已删除路由的重定向
// =====================================================================

// /context 重定向到 /topology（SC-25 —— 迁到拓扑表格视图；Phase 3 接真实视图）。
const contextRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/context",
  component: () => <Navigate to="/topology" />,
});

// /mission-control 依 SC-18 删除 —— 重定向到 /for-you（取代它）。
const missionControlRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/mission-control",
  component: () => <Navigate to="/for-you" />,
});

// /slices 依 project-tree.md 删除 —— 重定向到 /project。
const slicesRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/slices",
  component: () => <Navigate to="/project" />,
});

const sliceDetailRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/slices/$name",
  component: () => {
    const { name } = useParams({ from: "/slices/$name" });
    return <Navigate to="/project/slice/$sliceId" params={{ sliceId: name }} />;
  },
});

// /progress 并入 Project 标签页（Phase 3）—— 重定向到 /project。
const progressRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/progress",
  component: () => <Navigate to="/project" />,
});

// /steering 并入 Project 工作区概览标签页（Phase 3）—— 重定向到 /project。
const steeringRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/steering",
  component: () => <Navigate to="/project" />,
});

// =====================================================================
// 路由树
// =====================================================================

// 导出，使 OPR.0.4.1.11.1 digital-twin 测试架能用 MEMORY 历史自建路由
// （静态可双击的 intent.html 没有可匹配的服务器路径），且复用同一份真实路由树——不分叉组件。
export const routeTree = rootRoute.addChildren([
  // 规范目标
  indexRoute,
  topologyRoute,
  topologyRigRoute,
  topologyPodRoute,
  topologySeatRoute,
  forYouRoute,
  projectRoute,
  projectMissionRoute,
  projectSliceRoute,
  rigAgentsRoute,
  fleetRoute,
  workflowsRoute,
  workflowInstanceRoute,
  specsLibraryRoute,
  specsApplicationsRoute,
  specsSkillsIndexRoute,
  specsPluginsIndexRoute,
  specsSkillRoute,
  specsSkillFileRoute,
  pluginDetailRoute,
  filesRoute,
  specsKindRoute,
  settingsRoute,
  settingsPoliciesRoute,
  settingsLogRoute,
  settingsStatusRoute,
  searchRoute,
  projectGraphicsPreviewRoute,
  cardPreviewsLabRoute,
  vellumLabRoute,
  vellumBgLargeRoute,
  vellumBgSmallRoute,
  vellumBgAlloverRoute,
  // 保留的既有路由
  rigDetailRoute,
  liveNodeDetailsRoute,
  importRoute,
  packagesRoute,
  packageInstallRoute,
  packageDetailRoute,
  bootstrapRoute,
  agentValidateRoute,
  rigSpecReviewRoute,
  agentSpecReviewRoute,
  libraryReviewRoute,
  discoveryRoute,
  discoveryInventoryRoute,
  bundleInspectRoute,
  bundleInstallRoute,
  // 已删除路由的重定向
  contextRedirectRoute,
  missionControlRedirectRoute,
  slicesRedirectRoute,
  sliceDetailRedirectRoute,
  progressRedirectRoute,
  steeringRedirectRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
