// V1 attempt-3 Phase 3——按 project-tree.md L46–L49 + SC-24 的项目工作范围页。
//
// workspace = 概览/进展/产物/队列/拓扑（5 个标签页）
// mission = 同样 5 个标签页
// slice = +故事 +测试 = 7 个标签页
//
// V1 attempt-3 Phase 5 P5-2：SliceScopePage 标签页内容接线。
// 按 Phase 5 派发的 code-map 树折叠后映射：
//   - StoryGraph → 故事标签页（OPR.0.4.1.19；队列血缘 git-graph，取代事件 TimelineTab）
//   - TestsVerificationTab → 测试标签页（保留；tests prop）
//   - TopologyTab → 拓扑标签页（保留；topology prop）
//   - AcceptanceTab → 进展标签页（已折叠；canon-7 进展即 acceptance + currentStep）
//   - 产物标签页 → slice 高度的 ArtifactsNavigator（OPR.0.4.1 AC-4-FF）：
//     slice 产物视图就是高度作用域的文件浏览器，镜像
//     mission 高度的接线。先前的 Files / Commits / Proof / Docs / Decisions
//     区块已删除——Files+Docs 由浏览器吞并，Proof 有自己的
//     标签页 + 出现在树中，Decisions 住在 Story DAG（decision-of-record
//     qitem）+ 经浏览器的决策文档，Commits 标记为 0.4.2（无
//     qitem→提交链接；slice 级 commitRefs 留在 SliceDetail 负载中）。
//   - 概览标签页 → 经 useScopeMarkdown 的 README
//   - 队列标签页 → 带 QueueItemTrigger 的 qitemIds 列表（P5-1 接线），按 content-drawer.md L26
// Workspace + Mission 工作范围标签页接线仍是 Phase 5 打磨（依赖文件系统遍历；
// P5-5 铺数据层）。

import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { cn } from "../../lib/utils.js";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { useWorkspaceName } from "../../hooks/useWorkspaceName.js";
import { useHosts, useHostSelection, useLocalFilesAllowed } from "../../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import {
  useQueueItemMap,
  useSliceDetails,
  useSlices,
  useSliceDetail,
  type QueueItemDetail,
  type SliceDetail,
  type SliceListEntry,
} from "../../hooks/useSlices.js";
import {
  latestProjectMissionActivity,
  partitionProjectMissions,
  projectSliceFromListEntry,
  projectSliceMeta,
  reconcileMissionStatus,
  type ProjectMissionGroup,
} from "../../lib/project-mission-state.js";
import { StoryGraph } from "./StoryGraph.js";
import { buildStoryForest, type StoryQitemInput } from "../../lib/story-graph-model.js";
import { useScopeMarkdown } from "../../hooks/useScopeMarkdown.js";
import { useMission } from "../../hooks/useMission.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";
import { AcceptanceTab } from "../slices/tabs/AcceptanceTab.js";
import { ScopeProofRollup, SliceProofTab } from "./ProofTab.js";
import { TopologyTab } from "../slices/tabs/TopologyTab.js";
import { HostMultiRigGraph } from "../topology/HostMultiRigGraph.js";
import { LiveTerminalProvider, useTerminalCap } from "../terminal/LiveTerminalProvider.js";
import { MissionProgressHeatmap } from "./MissionProgressHeatmap.js";
import { useScopeAudit } from "../../hooks/useScopeAudit.js";
import { QueueItemTrigger } from "../drawer-triggers/QueueItemTrigger.js";
import {
  DateChip,
  EventBadge,
  FlowChips,
  ProjectPill,
  QueueCountIcon,
  QueueStateBadge,
  sliceStatusLabel,
  sliceStatusTone,
  StatusDot,
  TagPill,
  formatFriendlyDate,
  scopeToken,
  stateTone,
} from "./ProjectMetaPrimitives.js";
import { SteeringTab } from "./SteeringTab.js";
import { ArtifactsNavigator } from "./ArtifactsNavigator.js";
import { SliceReviewTab } from "../review/SliceReviewTab.js";
import { MissionReviewTab } from "../review/MissionReviewTab.js";
import { WorkspacePortfolioPanel } from "./WorkspacePortfolioPanel.js";

type SharedTab = "overview" | "story" | "progress" | "artifacts" | "proof" | "queue" | "topology" | "steering" | "review";
type SliceTab = SharedTab | "story" | "proof";

const SHARED_TABS: { id: SharedTab; label: string }[] = [
  { id: "overview", label: "概览" },
  { id: "story", label: "故事" },
  { id: "progress", label: "进展" },
  { id: "artifacts", label: "产物" },
  { id: "proof", label: "校验" },
  { id: "queue", label: "队列" },
  { id: "topology", label: "工作流" },
];

// OPR.0.4.1.17——mission 标签页集新增 Steering 作为落地页（仅 mission；不在父
// 或 slice 高度）。其他分类调整（加 Workflow、去 Queue/Topology）= 独立 slice。
const MISSION_TABS: { id: SharedTab; label: string }[] = [
  { id: "overview", label: "概览" },
  { id: "steering", label: "引导" },
  // OPR.0.4.4.20 FR-7：board 优先的 mission 评审在 Steering 旁——v1 中不是
  // 落地页（Steering 仍为主；翻转是 I5 创始人决定）。
  { id: "review", label: "评审" },
  { id: "story", label: "故事" },
  { id: "progress", label: "进展" },
  { id: "artifacts", label: "产物" },
  { id: "proof", label: "校验" },
  { id: "queue", label: "队列" },
  { id: "topology", label: "工作流" },
];

const SLICE_TABS: { id: SliceTab; label: string }[] = [
  // OPR.0.4.4.20 FR-4：评审标签页是默认落地页（叠加——
  // 概览保留；下方默认翻转是唯一可逆行）。
  { id: "review", label: "评审" },
  { id: "story", label: "故事" },
  { id: "overview", label: "概览" },
  { id: "progress", label: "进展" },
  { id: "artifacts", label: "产物" },
  { id: "proof", label: "校验" },
  { id: "queue", label: "队列" },
  { id: "topology", label: "工作流" },
];

function TabNav<T extends string>({
  tabs,
  active,
  onSelect,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onSelect: (id: T) => void;
}) {
  return (
    // 内部 tablist——div 而非 <nav>，以保持 SC-1 chrome 计数干净。
    <div
      role="tablist"
      data-testid="project-tab-nav"
      className="flex gap-1 border-b border-outline-variant mb-6 overflow-x-auto"
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          data-testid={`project-tab-${t.id}`}
          data-active={active === t.id}
          onClick={() => onSelect(t.id)}
          className={cn(
            "px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] border-b-2 -mb-px shrink-0",
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
}


/** OPR.0.4.6.MH2 guard-B1 第 2 轮——仅本地的评审编排器
 *  （/api/review 不在读取白名单）获得与本地文件相同的
 *  选择已知处理：未知 ⇒ 此待处理态
 *  （标签页组件从不挂载，故零 /api/review 触发）；
 *  已知远程 ⇒ 下方诚实的不可用态。 */
function ReviewSelectionPending({ testId }: { testId: string }) {
  return (
    <div data-testid={testId} className="font-mono text-[11px] text-on-surface-variant">
      正在解析主机选择…
    </div>
  );
}

function ReviewRemoteGated({ testId }: { testId: string }) {
  return (
    <EmptyState
      label="远程主机不可用评审"
      description="评审编排读取本机本地记录。请选择本地主机以评审本地工作；远程评审随 MH-3/MH-4 行动通道落地。"
      variant="card"
      testId={testId}
    />
  );
}

function ScopeShell({
  eyebrow,
  title,
  hostChip,
  tabs,
  active,
  onSelect,
  children,
}: {
  eyebrow: string;
  title: string;
  /** OPR.0.4.6.MH2 FR-4——`ON <HOST>` 头部 chip（fr4a 免费的 FR-3
   *  强化）；null/缺省不渲染任何内容（本地今日形态）。 */
  hostChip?: string | null;
  tabs: { id: string; label: string }[];
  active: string;
  onSelect: (id: string) => void;
  children: ReactNode;
}) {
  // OPR.0.4.0.1 前向修复（FR-2）：为每个项目工作范围页挂载一个显式
  // LiveTerminalProvider，使页面所有渐进终端（
  // TopologyTab + HostMultiRigGraph 等）共享一个全局 live-terminal
  // 注册表 + 配置的上限，而非让 TopologyTab 解析到独立的
  // 模块单例回退（那会静默地不共享上限）。镜像 topology/ScopePages provider 挂载。
  const liveCap = useTerminalCap();
  return (
    <LiveTerminalProvider cap={liveCap}>
    <div className="mx-auto w-full max-w-[1200px] px-6 py-8">
      <header className="border-b border-outline-variant pb-4 mb-4">
        <SectionHeader tone="muted">{eyebrow}</SectionHeader>
        <h1 className="font-headline text-headline-md font-bold tracking-tight uppercase text-on-surface mt-1">
          {title}
          {hostChip ? (
            <span
              data-testid="scope-host-chip"
              className="ml-3 inline-flex translate-y-[-0.15em] items-center bg-inverse-surface px-2 py-0.5 align-middle font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-background"
            >
              在 {hostChip} 上
            </span>
          ) : null}
        </h1>
      </header>
      <TabNav tabs={tabs} active={active} onSelect={onSelect} />
      <div role="tabpanel" data-testid="project-tab-panel">
        {children}
      </div>
    </div>
    </LiveTerminalProvider>
  );
}

function PlaceholderTab({ label, description }: { label: string; description?: string }) {
  return (
    <EmptyState
      label={label}
      description={description ?? "Phase 5 打磨中。"}
      variant="card"
      testId={`project-tab-placeholder-${label.toLowerCase()}`}
    />
  );
}

function formatLastActivity(ts: number): string {
  if (ts <= 0) return "近期无活动";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function sliceMissionKey(slice: SliceListEntry): string {
  return slice.missionId ?? slice.railItem ?? "unsorted";
}

function rowsForScope(rows: SliceListEntry[], missionId: string | null): SliceListEntry[] {
  if (!missionId) return rows;
  return rows.filter((slice) => sliceMissionKey(slice) === missionId);
}

function useProjectScopeRollup(missionId: string | null, loadDetails: boolean) {
  const list = useSlices("all");
  const rows = useMemo(() => {
    if (!list.data || "unavailable" in list.data) return [];
    return rowsForScope(list.data.slices, missionId);
  }, [list.data, missionId]);
  const details = useSliceDetails(loadDetails ? rows.map((slice) => slice.name) : []);
  const qitemIds = useMemo(() => {
    const ids = new Set<string>();
    for (const detail of details.itemsByName.values()) {
      if (Array.isArray(detail.qitemIds)) {
        detail.qitemIds.forEach((qitemId) => ids.add(qitemId));
      }
    }
    return Array.from(ids).sort();
  }, [details.itemsByName]);
  const queueItems = useQueueItemMap(loadDetails ? qitemIds : []);

  return { list, rows, details, qitemIds, queueItems };
}

function ScopeProgressRollup({
  rows,
  detailsByName,
  isLoading,
}: {
  rows: SliceListEntry[];
  detailsByName: Map<string, SliceDetail>;
  isLoading: boolean;
}) {
  if (isLoading && rows.length === 0) {
    return <PlaceholderTab label="正在加载进展" description="正在读取工作范围内的切片进展。" />;
  }
  if (rows.length === 0) {
    return <EmptyState label="工作范围内无切片" description="该工作范围尚未索引任何切片。" variant="card" testId="scope-progress-empty" />;
  }
  return (
    <div data-testid="scope-progress-rollup" className="space-y-3">
      {rows.map((row) => {
        const detail = detailsByName.get(row.name);
        return (
          <article key={row.name} className="border border-outline-variant bg-surface-lowest/35 p-3 backdrop-blur-sm">
            <div className="flex items-start justify-between gap-3 border-b border-outline-variant pb-2">
              <div className="min-w-0">
                <Link
                  to="/project/slice/$sliceId"
                  params={{ sliceId: row.name }}
                  className="font-mono text-[12px] uppercase tracking-[0.12em] text-on-surface hover:underline"
                >
                  {row.displayName}
                </Link>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <ProjectPill token={scopeToken("slice")} compact />
                  <ProjectPill token={{ label: sliceStatusLabel(row.status), tone: stateTone(row.status) }} compact />
                  <DateChip value={row.lastActivityAt} />
                </div>
              </div>
            </div>
            <div className="mt-3 grid gap-2 font-mono text-[10px] text-on-surface sm:grid-cols-4">
              <SliceMetric label="队列项" value={detail?.qitemIds.length ?? row.qitemCount} />
              <SliceMetric label="校验" value={detail ? detail.tests.proofPackets.length : row.hasProofPacket ? 1 : 0} />
              <SliceMetric label="进展" value={detail ? `${detail.acceptance.percentage}%` : "未知"} />
              <SliceMetric label="最近活动" value={formatMaybeDate(row.lastActivityAt)} />
            </div>
          </article>
        );
      })}
    </div>
  );
}

function ScopeQueueRollup({
  qitemIds,
  queueItemsById,
  isFetching,
}: {
  qitemIds: string[];
  queueItemsById: Map<string, QueueItemDetail>;
  isFetching: boolean;
}) {
  // V0.3.1 slice 17 founder-walk-workspace-state-correctness——遍历第 10 项（slice 队列降序）。最新 qitem 在前。优先
  // 已加载 detail 的 tsCreated；回退到
  // qitem-id（其编码时间戳前缀 `qitem-YYYYMMDD...`），使
  // 在 queueItemsById 加载完成前排序仍生效。
  const sortedQitemIds = [...qitemIds].sort((a, b) => {
    const itemA = queueItemsById.get(a);
    const itemB = queueItemsById.get(b);
    const tsA = itemA?.tsCreated ?? a;
    const tsB = itemB?.tsCreated ?? b;
    if (tsA === tsB) return 0;
    return tsA < tsB ? 1 : -1; // DESC
  });
  if (sortedQitemIds.length === 0) {
    return <EmptyState label="无队列项" description="该工作范围尚未索引任何队列项。" variant="card" testId="scope-queue-empty" />;
  }
  return (
    <div data-testid="scope-queue-rollup">
      {isFetching ? (
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant">
          正在加载队列正文...
        </div>
      ) : null}
      <ul className="divide-y divide-outline-variant border border-outline-variant">
        {sortedQitemIds.map((qitemId) => {
          const item = queueItemsById.get(qitemId);
          return (
            <li key={qitemId} className="bg-surface-lowest/35 backdrop-blur-sm">
              <QueueItemTrigger
                data={queueItemViewerData(qitemId, item)}
                testId={`scope-queue-trigger-${qitemId}`}
                className="block w-full px-3 py-2 text-left font-mono text-xs transition-colors hover:bg-surface-lowest/55"
              >
                <span className="flex flex-wrap items-center gap-2">
                  {item?.state ? <QueueStateBadge state={item.state} compact /> : <EventBadge kind="queue.item" compact />}
                  <DateChip value={item?.tsCreated} />
                </span>
                <span className="mt-2 block whitespace-pre-wrap break-words text-on-surface">
                  {queueBodyPreview(qitemId, item)}
                </span>
                {item ? (
                  <span className="mt-2 block space-y-2">
                    <FlowChips source={item.sourceSession} destination={item.destinationSession} muted />
                    <span className="flex flex-wrap gap-1.5">
                      {(item.tags ?? []).slice(0, 5).map((tag) => <TagPill key={tag} tag={tag} />)}
                    </span>
                  </span>
                ) : null}
              </QueueItemTrigger>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ScopeArtifactsRollup({
  rows,
  detailsByName,
}: {
  rows: SliceListEntry[];
  detailsByName: Map<string, SliceDetail>;
}) {
  if (rows.length === 0) {
    return <EmptyState label="无产物" description="该工作范围尚未索引任何切片。" variant="card" testId="scope-artifacts-empty" />;
  }
  return (
    <div data-testid="scope-artifacts-rollup" className="space-y-3">
      {rows.map((row) => {
        const detail = detailsByName.get(row.name);
        const proofCount = detail?.tests.proofPackets.length ?? (row.hasProofPacket ? 1 : 0);
        const screenshotCount = detail?.tests.proofPackets.reduce((count, packet) => count + packet.screenshots.length, 0) ?? 0;
        return (
          <article key={row.name} className="border border-outline-variant bg-surface-lowest/35 p-3 backdrop-blur-sm">
            <Link
              to="/project/slice/$sliceId"
              params={{ sliceId: row.name }}
              className="font-mono text-[12px] uppercase tracking-[0.12em] text-on-surface hover:underline"
            >
              {row.displayName}
            </Link>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <ProjectPill token={scopeToken("slice")} compact />
              <ProjectPill token={{ label: sliceStatusLabel(row.status), tone: stateTone(row.status) }} compact />
            </div>
            <div className="mt-3 grid gap-2 font-mono text-[10px] text-on-surface sm:grid-cols-4">
              <SliceMetric label="文件" value={detail?.docs.tree.length ?? "未知"} />
              <SliceMetric label="提交" value={detail?.commitRefs.length ?? "未知"} />
              <SliceMetric label="校验包" value={proofCount} />
              <SliceMetric label="截图" value={screenshotCount} />
            </div>
          </article>
        );
      })}
    </div>
  );
}

// 导出以供聚焦单测覆盖（OPR.0.4.1.18）：曾阻塞 QA 的 bug 是
// 此映射器硬编码 summary: null，故回归守卫直接测它。
export function toStoryInput(item: QueueItemDetail): StoryQitemInput {
  return {
    qitemId: item.qitemId,
    tsCreated: item.tsCreated,
    tsUpdated: item.tsUpdated,
    sourceSession: item.sourceSession,
    destinationSession: item.destinationSession,
    state: item.state,
    closureReason: item.closureReason ?? null,
    closureTarget: item.closureTarget ?? null,
    priority: item.priority ?? null,
    tier: item.tier ?? null,
    blockedOn: item.blockedOn ?? null,
    tags: item.tags ?? [],
    body: item.body,
    // OPR.0.4.1.18：作者撰写的人工摘要现挂在 QueueItemDetail
    // （由 /api/queue/:id 提供）。透传；story-graph-model 的
    // deriveSummary 优先采用它，为 null 时退化为正文首行
    // （18 之前的 qitem + 作者省略的任何项）。body 仍是
    // 抽屉/钻取的真相来源；使用交接子项自身的摘要（
    // 模型读每项的 summary，从不读父项的）。
    summary: item.summary ?? null,
    chainOfRecord: item.chainOfRecord ?? null,
    handedOffFrom: item.handedOffFrom ?? null,
    handedOffTo: item.handedOffTo ?? null,
    claimedAt: item.claimedAt ?? null,
    expiresAt: item.expiresAt ?? null,
    closureRequiredAt: item.closureRequiredAt ?? null,
    lastNudgeAttempt: item.lastNudgeAttempt ?? null,
    lastNudgeResult: item.lastNudgeResult ?? null,
    lastHeartbeat: item.lastHeartbeat ?? null,
    resolution: item.resolution ?? null,
    targetRepo: item.targetRepo ?? null,
  };
}

// OPR.0.4.1.19——故事标签页即队列血缘 git-graph（在 mission 和 slice 高度取代先前
// 事件时间线）。森林从工作范围的队列项（chain_of_record + 交接血缘）重构。
function ScopeStoryRollup({
  queueItemsById,
  isFetching,
}: {
  rows: SliceListEntry[];
  detailsByName: Map<string, SliceDetail>;
  queueItemsById: Map<string, QueueItemDetail>;
  isFetching: boolean;
}) {
  const forest = useMemo(
    () => buildStoryForest(Array.from(queueItemsById.values()).map(toStoryInput)),
    [queueItemsById],
  );
  if (isFetching && forest.nodes.length === 0) {
    return <PlaceholderTab label="正在加载故事" description="正在读取队列血缘。" />;
  }
  return (
    <div data-testid="scope-story-rollup">
      <StoryGraph forest={forest} />
    </div>
  );
}


function aggregateTopology(detailsByName: Map<string, SliceDetail>): SliceDetail["topology"] {
  const rigs = new Map<string, { rigId: string; rigName: string; sessionNames: Set<string> }>();
  for (const detail of detailsByName.values()) {
    if (!detail.topology || !Array.isArray(detail.topology.affectedRigs)) continue;
    for (const rig of detail.topology.affectedRigs) {
      const key = rig.rigName || rig.rigId;
      if (!rigs.has(key)) {
        rigs.set(key, { rigId: rig.rigId, rigName: rig.rigName, sessionNames: new Set() });
      }
      const aggregate = rigs.get(key)!;
      rig.sessionNames.forEach((session) => aggregate.sessionNames.add(session));
    }
  }
  const affectedRigs = Array.from(rigs.values()).map((rig) => ({
    rigId: rig.rigId,
    rigName: rig.rigName,
    sessionNames: Array.from(rig.sessionNames).sort(),
  }));
  return {
    affectedRigs,
    totalSeats: affectedRigs.reduce((count, rig) => count + rig.sessionNames.length, 0),
    specGraph: null,
  };
}

function ScopeTopologyRollup({ detailsByName }: { detailsByName: Map<string, SliceDetail> }) {
  return (
    <div data-testid="scope-topology-rollup">
      <TopologyTab topology={aggregateTopology(detailsByName)} />
    </div>
  );
}

function WorkspaceOverviewPanel() {
  const { data, isLoading } = useSlices("all");
  const missions = useMemo<ProjectMissionGroup[]>(() => {
    if (!data || "unavailable" in data) return [];
    const buckets = new Map<string, ProjectMissionGroup["slices"]>();
    for (const slice of data.slices) {
      const row = projectSliceFromListEntry(slice);
      const key = row.missionId ?? row.railItem ?? "unsorted";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(row);
    }
    // VM-005：经后台服务 missions sidecar 的"作者优先"优先级；
    // railItem/unsorted 键无 sidecar 条目，回退到推导值。
    const authored = data.missions ?? {};
    return Array.from(buckets.entries()).map(([key, slices]) => {
      const rec = reconcileMissionStatus(authored[key]?.authoredStatus ?? null, slices, undefined, authored[key]?.readiness);
      return {
        id: key,
        label: key === "unsorted" ? "未排序" : key,
        status: rec.state,
        statusLabel: rec.label,
        statusSource: rec.source,
        slices,
      };
    });
  }, [data]);
  const sections = useMemo(() => partitionProjectMissions(missions), [missions]);

  if (isLoading) {
    return (
      <EmptyState
        label="正在加载工作区"
        description="正在读取切片索引。"
        variant="card"
        testId="workspace-overview-loading"
      />
    );
  }

  if (data && "unavailable" in data) {
    return (
      <EmptyState
        label="工作区索引不可用"
        description={data.hint ?? "已配置工作区未提供切片索引。"}
        variant="card"
        testId="workspace-overview-unavailable"
      />
    );
  }

  const renderMissionCard = (mission: ProjectMissionGroup, bucket: "current" | "archive") => (
    <article
      key={mission.id}
      data-testid={`workspace-overview-mission-${mission.id}`}
      data-mission-bucket={bucket}
      className="border border-outline-variant bg-surface-lowest/20 px-3 py-3"
    >
      <div className="flex items-start justify-between gap-3 border-b border-outline-variant pb-2">
        <div className="min-w-0">
          <h3 className="font-mono text-[12px] uppercase tracking-[0.12em] text-on-surface truncate">
            {mission.label}
          </h3>
          <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">
            {mission.slices.length} 个切片 ·{" "}
            {formatLastActivity(latestProjectMissionActivity(mission))}
          </p>
        </div>
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">
          {mission.statusLabel ?? mission.status}
        </span>
      </div>
      <ul className="mt-2 space-y-1">
        {mission.slices.map((slice) => {
          const meta = projectSliceMeta(slice);
          return (
            <li key={slice.name}>
              <Link
                to="/project/slice/$sliceId"
                params={{ sliceId: slice.name }}
                data-testid={`workspace-overview-slice-${slice.name}`}
                title={`${slice.displayName} — ${meta}`}
                aria-label={`${slice.displayName} (${meta})`}
                className="flex items-start gap-2 px-2 py-1 font-mono text-[11px] text-on-surface hover:bg-surface-low hover:text-on-surface"
              >
                <span className="min-w-0 flex-1 whitespace-normal break-words leading-snug">{slice.displayName}</span>
                <span
                  data-testid={`workspace-overview-slice-${slice.name}-meta`}
                  className="flex shrink-0 items-center gap-1.5"
                >
                  <QueueCountIcon count={slice.qitemCount} testId={`workspace-overview-slice-${slice.name}-qitems`} />
                  <StatusDot
                    tone={sliceStatusTone(slice.status)}
                    label={slice.status}
                    testId={`workspace-overview-slice-${slice.name}-status`}
                  />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </article>
  );

  return (
    <div data-testid="workspace-overview-panel" className="grid gap-4 lg:grid-cols-2">
      <section data-testid="workspace-overview-current" className="space-y-3">
        <div className="flex items-center justify-between border-b border-outline-variant pb-2">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-on-surface">
            当前工作
          </h2>
          <span className="font-mono text-[10px] text-on-surface-variant">
            {sections.current.length}
          </span>
        </div>
        {sections.current.length > 0 ? (
          sections.current.map((mission) => renderMissionCard(mission, "current"))
        ) : (
          <EmptyState
            label="无当前工作"
            description="尚未索引任何有实时队列项支撑或近期活跃的切片。"
            variant="card"
            testId="workspace-overview-current-empty"
          />
        )}
      </section>
      <section data-testid="workspace-overview-archive" className="space-y-3">
        <div className="flex items-center justify-between border-b border-outline-variant pb-2">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.16em] text-on-surface">
            归档
          </h2>
          <span className="font-mono text-[10px] text-on-surface-variant">
            {sections.archive.length}
          </span>
        </div>
        {sections.archive.length > 0 ? (
          sections.archive.map((mission) => renderMissionCard(mission, "archive"))
        ) : (
          <EmptyState
            label="无归档"
            description="尚未索引任何已归档切片。"
            variant="card"
            testId="workspace-overview-archive-empty"
          />
        )}
      </section>
    </div>
  );
}

export function WorkspaceScopePage() {
  const [active, setActive] = useState<SharedTab>("overview");
  const workspace = useWorkspaceName();
  const rollup = useProjectScopeRollup(null, active !== "overview");
  // OPR.0.4.6.MH2 FR-4——所选主机拥有此工作区视图。v1 中远程主机的工作区
  // 名称不可读（诚实通用标题）；ON <host> chip 命名属主（fr4a 裁决）。
  const { data: hostsData } = useHosts();
  const selectedHost = hostsData?.selected ?? LOCAL_HOST_ID;
  const isRemote = selectedHost !== LOCAL_HOST_ID;
  // OPR.0.4.6.MH5 FR-4 钻取连续性：从 fleet 高度进入时
  // eyebrow 显示上方主干（FLEET ▸ host）；以下全部为
  // 不变的 MH-2。窗口侧读取 = 本家族的 query-param 惯用法。
  const fromFleet =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("from") === "fleet";
  // guard-B1：唯一共享的本地文件门（选择已知 && 本地）。
  const filesAllowed = useLocalFilesAllowed();

  // A5 回弹修复：实时接线的工作区名称；未设置时诚实空态。
  // MH-2：仅本地——workspace.name 是本地配置；远程选择
  // 渲染远程视图，与本地工作区状态无关。
  if (!isRemote && !workspace.isLoading && workspace.name === null) {
    return (
      <div className="mx-auto w-full max-w-[960px] px-6 py-12">
        <EmptyState
          label="未连接工作区"
          description="请配置工作区根目录，以便在此页面浏览任务与切片。"
          variant="card"
          testId="workspace-scope-no-workspace"
          action={{ label: "打开设置", href: "/settings" }}
        />
      </div>
    );
  }

  return (
    <ScopeShell
      eyebrow={fromFleet ? `Fleet ▸ ${selectedHost} · 工作区` : "工作区"}
      title={isRemote ? "工作区" : (workspace.name ?? "加载中…")}
      hostChip={isRemote ? selectedHost : null}
      tabs={SHARED_TABS}
      active={active}
      onSelect={(id) => setActive(id as SharedTab)}
    >
      {active === "overview" ? (
        // OPR.0.4.1.24——工作区父高度落地到跨任务
        // 组合面板（折叠任务、最近修改、展开→引导一瞥）。
        // 取代先前的 WorkspaceOverviewPanel 任务网格。
        <WorkspacePortfolioPanel />
      ) : null}
      {active === "story" ? (
        <ScopeStoryRollup
          rows={rollup.rows}
          detailsByName={rollup.details.itemsByName}
          queueItemsById={rollup.queueItems.itemsById}
          isFetching={rollup.details.isFetching || rollup.queueItems.isFetching}
        />
      ) : null}
      {active === "progress" ? (
        <ScopeProgressRollup
          rows={rollup.rows}
          detailsByName={rollup.details.itemsByName}
          isLoading={rollup.list.isLoading || rollup.details.isFetching}
        />
      ) : null}
      {active === "artifacts" ? (
        <ScopeArtifactsRollup rows={rollup.rows} detailsByName={rollup.details.itemsByName} />
      ) : null}
      {active === "proof" ? (
        <ScopeProofRollup
          rows={rollup.rows.map((r) => ({
            name: r.name,
            displayName: r.displayName,
            // MH-2 guard-B1：远程或未知选择下的切片路径绝不在本地解析。
            slicePath: filesAllowed ? (r.slicePath ?? null) : null,
          }))}
        />
      ) : null}
      {active === "queue" ? (
        <ScopeQueueRollup
          qitemIds={rollup.qitemIds}
          queueItemsById={rollup.queueItems.itemsById}
          isFetching={rollup.details.isFetching || rollup.queueItems.isFetching}
        />
      ) : null}
      {active === "topology" ? (
        <div
          data-testid="workspace-topology-hostmultirig"
          className="flex-1 min-h-0 relative h-[60vh]"
        >
          <HostMultiRigGraph />
        </div>
      ) : null}
    </ScopeShell>
  );
}

export function MissionScopePage() {
  const { missionId } = useParams({ from: "/project/mission/$missionId" });
  // OPR.0.4.1.17——引导是任务落地标签页。
  const [active, setActive] = useState<SharedTab>("steering");
  // 引导（落地页）+ 概览只需 slice 列表，不需要逐 slice
  // 详情或队列正文。对两者都关闭详情+队列级联，使
  // 双投影落地页从不触发隐藏的 slice 详情/队列正文拉取
  // （前向修复：否则 steering !== overview 会加载它们）。
  const rollup = useProjectScopeRollup(missionId, active !== "overview" && active !== "steering");
  // V0.3.1 slice 12 walk-item 1——拉取聚合的任务元数据
  // （用于 README/PROGRESS 查找的 missionPath；slice 已由
  // rollup 覆盖）。README + PROGRESS 经 useScopeMarkdown 渲染在
  // 既有 slice 轨道之上。
  const missionData = useMission(missionId);
  // OPR.0.4.6.MH2 FR-4——README/PROGRESS 经 /api/files/read 渲染，这是
  // 本地文件系统读取。对远程选择，路径被门控关闭
  // （null），使本地文件夹绝不会渲染在远程主机的
  // 标签下；远程任务视图来自读取透传数据。
  const { data: hostsData } = useHosts();
  const selectedHost = hostsData?.selected ?? LOCAL_HOST_ID;
  const isRemote = selectedHost !== LOCAL_HOST_ID;
  // guard-B1：唯一共享的本地文件门（选择已知 && 本地）。
  const filesAllowed = useLocalFilesAllowed();
  // guard-B1 第 2 轮：评审编排器仅本地——同样处理。
  const { known: hostSelectionKnown, isLocal: hostIsLocal } = useHostSelection();
  const missionPath =
    filesAllowed && missionData.data && "missionPath" in missionData.data ? missionData.data.missionPath : null;
  const missionReadme = useScopeMarkdown(missionPath, "README.md");
  const missionProgress = useScopeMarkdown(missionPath, "PROGRESS.md");
  const scopeAudit = useScopeAudit(missionId);
  return (
    <ScopeShell
      eyebrow="任务"
      title={missionId}
      hostChip={isRemote ? selectedHost : null}
      tabs={MISSION_TABS}
      active={active}
      onSelect={(id) => setActive(id as SharedTab)}
    >
      {active === "steering" ? <SteeringTab missionId={missionId} /> : null}
      {active === "review" ? (
        // guard-B1 第 2 轮：/api/review 仅本地——选择已知的
        // 三向分支（未知 ⇒ 待处理，远程 ⇒ 诚实门控）。
        !hostSelectionKnown ? (
          <ReviewSelectionPending testId="mission-review-selection-pending" />
        ) : !hostIsLocal ? (
          <ReviewRemoteGated testId="mission-review-remote-gated" />
        ) : (
          <MissionReviewTab missionId={missionId} />
        )
      ) : null}
      {active === "overview" ? (
        <div data-testid="mission-overview-panel" className="space-y-6">
          {missionReadme.content && (
            <section data-testid="mission-overview-readme" className="border border-outline-variant bg-surface-lowest/20 p-4">
              <MarkdownViewer content={missionReadme.content} hideFrontmatter hideRawToggle />
            </section>
          )}
          <div className="space-y-3">
            {rollup.rows.length > 0 ? (
              rollup.rows.map((slice) => {
                const meta = projectSliceMeta(slice);
                return (
                  <article key={slice.name} className="border border-outline-variant bg-surface-lowest/35 p-3 backdrop-blur-sm">
                    <div className="flex items-start gap-3">
                      <Link
                        to="/project/slice/$sliceId"
                        params={{ sliceId: slice.name }}
                        data-testid={`mission-overview-slice-${slice.name}`}
                        title={`${slice.displayName} — ${meta}`}
                        aria-label={`${slice.displayName} (${meta})`}
                        className="min-w-0 flex-1 whitespace-normal break-words font-mono text-[12px] uppercase leading-snug tracking-[0.12em] text-on-surface hover:underline"
                      >
                        {slice.displayName}
                      </Link>
                      <span
                        data-testid={`mission-overview-slice-${slice.name}-meta`}
                        className="flex shrink-0 items-center gap-1.5"
                      >
                        <QueueCountIcon count={slice.qitemCount} testId={`mission-overview-slice-${slice.name}-qitems`} />
                        <StatusDot
                          tone={sliceStatusTone(slice.status)}
                          label={slice.status}
                          testId={`mission-overview-slice-${slice.name}-status`}
                        />
                      </span>
                    </div>
                  </article>
                );
              })
            ) : (
              <EmptyState
                label="无切片"
                description="该任务尚未挂载任何已索引切片。"
                variant="card"
                testId="mission-overview-empty"
              />
            )}
          </div>
        </div>
      ) : null}
      {active === "story" ? (
        <ScopeStoryRollup
          rows={rollup.rows}
          detailsByName={rollup.details.itemsByName}
          queueItemsById={rollup.queueItems.itemsById}
          isFetching={rollup.details.isFetching || rollup.queueItems.isFetching}
        />
      ) : null}
      {active === "progress" ? (
        <div data-testid="mission-progress-panel" className="space-y-6">
          <MissionProgressHeatmap
            rows={rollup.rows}
            detailsByName={rollup.details.itemsByName}
            isLoading={rollup.list.isLoading || rollup.details.isFetching}
          />
          {scopeAudit.data && (scopeAudit.data.mission.railStatus === "missing" || scopeAudit.data.mission.railStatus === "malformed") ? (
            <EmptyState
              label={scopeAudit.data.mission.railStatus === "malformed" ? "进展轨道格式错误" : "缺少进展轨道"}
              description={
                scopeAudit.data.mission.railStatus === "malformed"
                  ? `任务进展轨道存在错误（${scopeAudit.data.mission.frontmatterError ?? "frontmatter 格式错误"}）。请运行审计命令诊断。`
                  : "该任务无 PROGRESS.md。请脚手架生成一份或运行审计以检查工作范围健康状态。"
              }
              variant="card"
              testId="mission-progress-rail-status"
              action={{ label: `zrig scope audit --mission ${missionId}` }}
            />
          ) : hostSelectionKnown && !hostIsLocal ? (
            // R1（release-0.4.7）req-5（G16；v1.2 门控修复）：已知远程选择
            // 关闭本地 /api/files 读取（上方 missionPath 为 null）。诚实地
            // 说明，而非落到"尚无进展"——远程读取
            // 绝不能冒充本地缺失。仅对已知远程门控（不
            // 对 !filesAllowed，那包含未知冷启动窗口，会
            // 在本地闪现此提示——即 SteeringTab +
            // WorkspacePortfolioPanel 先例禁止的误导性门控闪现）；未知选择
            // 落到加载/缺失处理。数据层 null 路径门控
            // 经 filesAllowed（上方 missionPath）保持不变。
            <EmptyState
              label="不显示本地文件"
              description="不显示本地文件——任务进展 markdown 读取本机本地文件系统，远程读取视图不浏览它。"
              variant="card"
              testId="mission-progress-remote-gated"
            />
          ) : missionProgress.content ? (
            <section data-testid="mission-progress-readme" className="border border-outline-variant bg-surface-lowest/20 p-4">
              <MarkdownViewer content={missionProgress.content} hideFrontmatter hideRawToggle />
            </section>
          ) : missionProgress.state === "read_error" ? (
            // R1：读取失败——不是空进展文件。
            <EmptyState
              label="进展读取失败"
              description="后台服务无法读取 PROGRESS.md——这是读取失败，而非空进展文件。请检查后台服务日志与文件权限。"
              variant="card"
              testId="mission-progress-read-error"
            />
          ) : missionProgress.state === "unresolved" ? (
            // R1：任务路径不在白名单文件根（配置）之下。
            <EmptyState
              label="进展在文件根之外"
              description="任务路径不在任何白名单文件根之下，故无法读取 PROGRESS.md。请检查 OPENRIG_FILES_ALLOWLIST / 后台服务的文件根设置。"
              variant="card"
              testId="mission-progress-unresolved"
            />
          ) : !scopeAudit.isLoading ? (
            <EmptyState
              label="尚无进展"
              description="该任务尚未写入任何进展数据。"
              variant="card"
              testId="mission-progress-empty"
            />
          ) : null}
          {scopeAudit.data && scopeAudit.data.totalFindings > 0 && (
            <section data-testid="mission-scope-findings" className="border border-outline-variant bg-amber-50/40 p-4">
              <SectionHeader>工作范围审计发现（{scopeAudit.data.totalFindings}）</SectionHeader>
              <ul className="mt-2 space-y-1 font-mono text-[11px]">
                {[...scopeAudit.data.mission.findings, ...scopeAudit.data.slices.flatMap((s) => s.findings)].map((f, i) => (
                  <li key={i} className={cn("px-2 py-1", f.severity === "high" ? "text-red-700" : "text-on-surface-variant")}>
                    [{f.severity}] {f.kind}: {f.message}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {/* OPR.0.4.1.22——逐 slice rollup 卡片已从任务
              进展标签页移除（创始人第 8 轮：移除卡片，保留热力图）。上方
              MissionProgressHeatmap 即逐 slice 验收视图；冗余的
              ScopeProgressRollup 卡墙已剪除。（rollup.details
              仍加载——热力图的验收单元格读取它。） */}
        </div>
      ) : null}
      {active === "artifacts" ? (
        // OPR.0.4.1.21——任务产物现为高度作用域的文件
        // 浏览器（根为任务目录 = 全部任务产物），
        // 取代逐 slice 的 ScopeArtifactsRollup 卡墙。
        <ArtifactsNavigator scopePath={missionPath} scopeLabel={missionId} remoteGated={isRemote} />
      ) : null}
      {active === "proof" ? (
        <ScopeProofRollup
          rows={rollup.rows.map((r) => ({
            name: r.name,
            displayName: r.displayName,
            // MH-2 guard-B1：远程或未知选择下的切片路径绝不在本地解析。
            slicePath: filesAllowed ? (r.slicePath ?? null) : null,
          }))}
        />
      ) : null}
      {active === "queue" ? (
        <ScopeQueueRollup
          qitemIds={rollup.qitemIds}
          queueItemsById={rollup.queueItems.itemsById}
          isFetching={rollup.details.isFetching || rollup.queueItems.isFetching}
        />
      ) : null}
      {active === "topology" ? (
        (() => {
          // V0.3.1 slice 13 walk-item 7——当任务在其 README frontmatter
          // 中声明 `workflow_spec: <name>@<version>`
          // 且该 spec 在 WorkflowSpecCache 中时，任务
          // 路由返回投影的 spec 图。经
          // TopologyTab 渲染（与 slice 工作范围用的同一组件）。声明
          // 缺失或 spec 未缓存时回退到会话名聚合。
          const missionTopology =
            missionData.data && "topology" in missionData.data
              ? missionData.data.topology
              : null;
          if (missionTopology?.specGraph) {
            return (
              <TopologyTab
                topology={{
                  affectedRigs: [],
                  totalSeats: 0,
                  specGraph: missionTopology.specGraph,
                }}
              />
            );
          }
          return <ScopeTopologyRollup detailsByName={rollup.details.itemsByName} />;
        })()
      ) : null}
    </ScopeShell>
  );
}

function queueItemViewerData(qitemId: string, item: QueueItemDetail | undefined) {
  return {
    qitemId,
    source: item?.sourceSession,
    destination: item?.destinationSession,
    state: item?.state,
    tags: item?.tags ?? undefined,
    createdAt: item?.tsCreated,
    body: item?.body,
  };
}

function queueBodyPreview(qitemId: string, item: QueueItemDetail | undefined): string {
  if (!item?.body) return qitemId;
  const lines = item.body.split("\n");
  if (lines.length <= 8) return item.body;
  return `${lines.slice(0, 8).join("\n")}\n… 另有 ${lines.length - 8} 行`;
}

function SliceQueueTab({
  qitemIds,
  queueItemsById,
  queueItemsFetching,
}: {
  qitemIds: string[];
  queueItemsById: Map<string, QueueItemDetail>;
  queueItemsFetching: boolean;
}) {
  // V1 attempt-3 Phase 5 P5-2：slice 队列标签页。每个 qitem id 包在
  // QueueItemTrigger（P5-1 触发原语）中。Phase B 在可用时从既有
  // 队列详情端点提供正文与来源。
  if (qitemIds.length === 0) {
    return (
      <EmptyState
        label="无队列项"
        description="该切片未关联任何队列项。"
        variant="card"
        testId="slice-queue-empty"
      />
    );
  }
  return (
    <div>
      {queueItemsFetching ? (
        <div
          data-testid="slice-queue-fetching"
          className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant"
        >
          正在加载队列正文...
        </div>
      ) : null}
      <ul
        data-testid="slice-queue-list"
        className="divide-y divide-outline-variant border border-outline-variant"
      >
        {qitemIds.map((qitemId) => {
          const item = queueItemsById.get(qitemId);
          return (
            <li key={qitemId} className="bg-surface-lowest/35 backdrop-blur-sm">
              <QueueItemTrigger
                data={queueItemViewerData(qitemId, item)}
                testId={`slice-queue-trigger-${qitemId}`}
                className="block w-full px-3 py-2 text-left hover:bg-surface-lowest/55 transition-colors font-mono text-xs"
              >
                <span className="flex flex-wrap items-center gap-2">
                  {item?.state ? <QueueStateBadge state={item.state} compact /> : <EventBadge kind="queue.item" compact />}
                  <DateChip value={item?.tsCreated} />
                </span>
                <span className="mt-2 block whitespace-pre-wrap break-words text-on-surface">
                  {queueBodyPreview(qitemId, item)}
                </span>
                {item ? (
                  <span
                    data-testid={`slice-queue-meta-${qitemId}`}
                    className="mt-2 block space-y-2 text-[10px] text-on-surface-variant"
                  >
                    <FlowChips source={item.sourceSession} destination={item.destinationSession} muted />
                    <span className="flex flex-wrap gap-1.5">
                      <TagPill tag={qitemId} />
                      {(item.tags ?? []).slice(0, 5).map((tag) => <TagPill key={tag} tag={tag} />)}
                    </span>
                  </span>
                ) : null}
              </QueueItemTrigger>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function formatMaybeDate(ts: string | null): string {
  return formatFriendlyDate(ts);
}

function SliceMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border border-outline-variant bg-surface-lowest/35 p-3 backdrop-blur-sm">
      <div className="font-mono text-[8px] uppercase tracking-[0.14em] text-on-surface-variant">{label}</div>
      <div className="mt-1 font-mono text-sm font-bold text-on-surface">{value}</div>
    </div>
  );
}

function SliceOverviewTab({ detail, remoteGated }: { detail: SliceDetail; remoteGated?: boolean }) {
  const currentStep = detail.acceptance.currentStep;
  // V0.3.1 slice 12 walk-item 1——经
  // 通用 scope-markdown 读取器渲染 slice README；Primary Docs 文件名
  // 重复区块已删除（README 自身 + Docs 标签页
  // 树已足够）。
  // MH-2 guard-B1：远程 slicePath 从不针对本地根解析。
  const readmeMd = useScopeMarkdown(remoteGated ? null : (detail.slicePath ?? null), "README.md");

  return (
    <div data-testid="slice-overview-tab" className="space-y-6">
      <section data-testid="slice-overview-summary" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SliceMetric label="状态" value={detail.status} />
        <SliceMetric label="进展" value={`${detail.acceptance.percentage}%`} />
        <SliceMetric label="队列项" value={detail.qitemIds.length} />
        <SliceMetric label="最近活动" value={formatMaybeDate(detail.lastActivityAt)} />
      </section>

      {readmeMd.content && (
        <section data-testid="slice-overview-readme" className="border border-outline-variant bg-surface-lowest/20 p-4">
          <MarkdownViewer content={readmeMd.content} hideFrontmatter hideRawToggle />
        </section>
      )}

      <section data-testid="slice-overview-current-step" className="border border-outline-variant bg-surface-lowest/20 p-4">
        <SectionHeader tone="muted">当前步骤</SectionHeader>
        {currentStep ? (
          <div className="mt-3 grid gap-2 font-mono text-[10px] text-on-surface sm:grid-cols-2">
            <div>
              <div className="text-[8px] uppercase tracking-[0.14em] text-on-surface-variant">步骤</div>
              <div className="font-bold text-on-surface">{currentStep.stepId}</div>
            </div>
            <div>
              <div className="text-[8px] uppercase tracking-[0.14em] text-on-surface-variant">角色</div>
              <div className="font-bold text-on-surface">{currentStep.role}</div>
            </div>
            <div className="sm:col-span-2">
              <div className="text-[8px] uppercase tracking-[0.14em] text-on-surface-variant">目标</div>
              <div>{currentStep.objective ?? "未声明目标。"}</div>
            </div>
            <div>
              <div className="text-[8px] uppercase tracking-[0.14em] text-on-surface-variant">允许出口</div>
              <div>{currentStep.allowedExits.join(", ") || "-"}</div>
            </div>
            <div>
              <div className="text-[8px] uppercase tracking-[0.14em] text-on-surface-variant">跳数</div>
              <div>{currentStep.hopCount}</div>
            </div>
          </div>
        ) : (
          <div className="mt-3 font-mono text-[10px] text-on-surface-variant">当前未绑定任何工作流步骤。</div>
        )}
      </section>

      <section data-testid="slice-overview-readiness" className="border border-outline-variant bg-surface-lowest/20 p-4">
        <SectionHeader tone="muted">就绪度</SectionHeader>
        <div className="mt-3 space-y-2 font-mono text-[10px] text-on-surface">
          <div>{detail.acceptance.doneItems} / {detail.acceptance.totalItems} 项验收已完成。</div>
          <div>{detail.tests.aggregate.passCount} 个校验包通过 / {detail.tests.aggregate.failCount} 个失败。</div>
          {detail.acceptance.closureCallout && (
            <div className="border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800">
              {detail.acceptance.closureCallout}
            </div>
          )}
          {detail.workflowBinding && (
            <div className="text-on-surface-variant">
              工作流：{detail.workflowBinding.workflowName} v{detail.workflowBinding.workflowVersion}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export function SliceScopePage() {
  const { sliceId } = useParams({ from: "/project/slice/$sliceId" });
  // OPR.0.4.4.20 FR-4：默认标签页为评审（阶段感知对比 +
  // NEEDS YOU）。一行可逆行——翻回 "overview" 即恢复
  // v0.3.1 落地页。
  const [active, setActive] = useState<SliceTab>("review");
  // OPR.0.4.6.MH2 guard-B1——远程选择下 detail.slicePath 是
  // 远程文件系统路径；下方文件支撑标签页绝不能
  // 针对本地白名单根解析它（null/remoteGated ⇒ 零
  // /api/files/* 请求 + 诚实缺失态）。文件读取等待
  // 选择变为已知——首渲染时单靠 !isRemote 会竞态。
  const { data: sliceHostsData } = useHosts();
  const isRemote = (sliceHostsData?.selected ?? LOCAL_HOST_ID) !== LOCAL_HOST_ID;
  // guard-B1：唯一共享的本地文件门（选择已知 && 本地）。
  const filesAllowed = useLocalFilesAllowed();
  // guard-B1 第 2 轮：评审组合器仅限本地，采用相同处理。
  const { known: hostSelectionKnown, isLocal: hostIsLocal } = useHostSelection();
  const detailQuery = useSliceDetail(sliceId);
  const queueItems = useQueueItemMap(detailQuery.data?.qitemIds ?? []);
  const queueItemsById = useMemo(() => queueItems.itemsById, [queueItems.itemsById]);
  const sliceScopeAudit = useScopeAudit(detailQuery.data?.missionId ?? null);

  if (detailQuery.isLoading) {
    return (
      <ScopeShell
        eyebrow="切片"
        title={sliceId}
        tabs={SLICE_TABS}
        active={active}
        onSelect={(id) => setActive(id as SliceTab)}
      >
        <EmptyState
          label="正在加载"
          description={`正在拉取 /api/slices/${sliceId}…`}
          variant="card"
          testId="slice-scope-loading"
        />
      </ScopeShell>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <ScopeShell
        eyebrow="切片"
        title={sliceId}
        tabs={SLICE_TABS}
        active={active}
        onSelect={(id) => setActive(id as SliceTab)}
      >
        <EmptyState
          label="切片不可用"
          description={
            detailQuery.error instanceof Error
              ? detailQuery.error.message
              : `无法加载 slice "${sliceId}"。slice 索引器可能未配置（zrig config get workspace.slices_root）。`
          }
          variant="card"
          testId="slice-scope-error"
        />
      </ScopeShell>
    );
  }

  const detail = detailQuery.data;
  const sliceAuditEntry = sliceScopeAudit.data?.slices.find((s) => s.name === detail.name) ?? null;

  return (
    <ScopeShell
      eyebrow="切片"
      title={detail.displayName || detail.name}
      tabs={SLICE_TABS}
      active={active}
      onSelect={(id) => setActive(id as SliceTab)}
    >
      {active === "review" ? (
        // guard-B1 第 2 轮：评审编排器读本地 /api/review
        //（不在读取透传白名单）——选择已知三向
        // 分支，同本地文件：未知 ⇒ 待处理（零 /api/review
        // 触发——仅 isRemote 门控在首渲染竞态），
        // 已知远程 ⇒ 诚实门控，已知本地 ⇒ 真正标签页。
        !hostSelectionKnown ? (
          <ReviewSelectionPending testId="slice-review-selection-pending" />
        ) : !hostIsLocal ? (
          <ReviewRemoteGated testId="slice-review-remote-gated" />
        ) : (
        <SliceReviewTab
          sliceName={detail.name}
          slicePath={filesAllowed ? detail.slicePath : null}
          anchorIdentity={typeof window !== "undefined" && window.location.hash.startsWith("#needs-you-")
            ? window.location.hash.slice("#needs-you-".length)
            : null}
        />
        )
      ) : null}
      {active === "story" ? (
        <ScopeStoryRollup
          rows={[]}
          detailsByName={new Map<string, SliceDetail>()}
          queueItemsById={queueItemsById}
          isFetching={false}
        />
      ) : null}
      {active === "overview" ? (
        <SliceOverviewTab detail={detail} remoteGated={!filesAllowed} />
      ) : null}
      {active === "progress" ? (
        <div className="space-y-6">
          {sliceAuditEntry && (sliceAuditEntry.railStatus === "missing" || sliceAuditEntry.railStatus === "malformed") && (
            <EmptyState
              label={sliceAuditEntry.railStatus === "malformed" ? "进展轨道格式错误" : "缺少进展轨道"}
              description={
                sliceAuditEntry.railStatus === "malformed"
                  ? `slice 进展轨道存在错误（${sliceAuditEntry.frontmatterError ?? "frontmatter 格式错误"}）。请运行审计命令诊断。`
                  : "该切片无 PROGRESS.md，也无仅 README 标记。"
              }
              variant="card"
              testId="slice-progress-rail-status"
              action={{ label: `zrig scope audit --mission ${detail.missionId}` }}
            />
          )}
          {sliceAuditEntry && sliceAuditEntry.findings.length > 0 && (
            <section data-testid="slice-scope-findings" className="border border-outline-variant bg-amber-50/40 p-4">
              <SectionHeader>工作范围发现（{sliceAuditEntry.findings.length}）</SectionHeader>
              <ul className="mt-2 space-y-1 font-mono text-[11px]">
                {sliceAuditEntry.findings.map((f, i) => (
                  <li key={i} className={cn("px-2 py-1", f.severity === "high" ? "text-red-700" : "text-on-surface-variant")}>
                    [{f.severity}] {f.kind}: {f.message}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <AcceptanceTab acceptance={detail.acceptance} />
        </div>
      ) : null}
      {active === "artifacts" ? (
        // OPR.0.4.1 AC-4-FF——slice 产物视图即高度作用域文件
        // 浏览器（slice 21 在 slice 高度的模式），根为 slice 目录。
        // 先前的 Files/Commits/Proof/Docs/Decisions 卡墙已删除；commits
        // 标记为 0.4.2（无 qitem→提交链接），decisions 住在 Story
        // DAG + 决策文档出现在此浏览器树中。
        <ArtifactsNavigator scopePath={filesAllowed ? detail.slicePath : null} scopeLabel={detail.displayName || detail.name} remoteGated={isRemote} />
      ) : null}
      {active === "proof" ? (
        <SliceProofTab
          sliceId={detail.displayName}
          title={detail.name}
          slicePath={filesAllowed ? detail.slicePath : null}
        />
      ) : null}
      {active === "queue" ? (
        <SliceQueueTab
          qitemIds={detail.qitemIds}
          queueItemsById={queueItemsById}
          queueItemsFetching={queueItems.isFetching}
        />
      ) : null}
      {active === "topology" ? <TopologyTab topology={detail.topology} /> : null}
    </ScopeShell>
  );
}
