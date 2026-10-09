// V1 attempt-3 Phase 3——项目树，按 project-tree.md L13–L46 + SC-24。
//
// V1 attempt-3 Phase 5 P5-5 + P5-6：经 useMissionDiscovery 做基于文件系统的任务发现
// （遍历 workspace.root/missions/，走 /api/files/list）。当白名单未暴露 workspace.root 时，
// 树回退到旧的 railItem/missionId 分组 slice 列表。
// VM-005（release-0.4.7）：任务状态 chip 来自已对账的主页
// （作者撰写的 README frontmatter，经 slices-payload sidecar；派生汇总为回退）——
// P5-6 的 PROGRESS.md 实时状态覆盖已退役（见下方 MissionChipBadge 注释）。

import { useState, useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Globe, RefreshCw } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { useSlices, useRefreshSlices, type SliceListEntry } from "../../hooks/useSlices.js";
import { useHosts, useSelectHost, useLocalFilesAllowed } from "../../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import { useWorkspaceName } from "../../hooks/useWorkspaceName.js";
import {
  useMissionDiscovery,
  type DiscoveredMission,
} from "../../hooks/useMissionDiscovery.js";
import { MissionStatusBadge, type MissionStatus } from "../MissionStatusBadge.js";
import { QueueCountIcon, StatusDot, sliceStatusTone } from "./ProjectMetaPrimitives.js";
import {
  isCurrentProjectSlice,
  partitionProjectMissions,
  projectSliceFromListEntry,
  projectSliceMeta,
  reconcileMissionStatus,
  type ProjectMissionBucket,
  type ProjectSliceRow,
  type MissionStatusSource,
} from "../../lib/project-mission-state.js";

function ProjectTreeRefreshHeader({ remoteReadonly }: { remoteReadonly: boolean }) {
  const refresh = useRefreshSlices();
  return (
    <div className="flex items-center justify-between px-2 pb-2 border-b border-outline-variant">
      <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant">
        项目
      </span>
      {/* OPR.0.4.6.MH2 rev1-r2 重新判定 B1（同类、枚举）：刷新 POST 本地 slice/文件重扫——
          一个本地变更提示，绝不在带远程标签的树上渲染。 */}
      {remoteReadonly ? null : (
        <button
          type="button"
          data-testid="project-tree-refresh"
          title="刷新切片与文件缓存"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          className="flex items-center gap-1 px-1 py-0.5 text-on-surface-variant hover:text-on-surface disabled:opacity-50"
        >
          <RefreshCw
            className={`h-3 w-3 ${refresh.isPending ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          <span className="font-mono text-[9px] uppercase tracking-wide">刷新</span>
        </button>
      )}
    </div>
  );
}

type GroupedMission = {
  id: string;
  label: string;
  status: MissionStatus;
  statusLabel: string;
  statusSource: MissionStatusSource;
  slices: ProjectSliceRow[];
  // P5-5：文件系统发现的任务携带 root + path，使实时 PROGRESS.md 状态获取器知道从何处读。
  fsRoot?: string;
  fsPath?: string;
};

// VM-005 FR-1（Q1 选项 A，PIN Q1-P1）：PROGRESS.md 实时任务状态覆盖
// （LiveMissionStatusBadge / useMissionProgressStatus）已移除——SC-26 的
// “PROGRESS.md 是任务状态的真相来源”对任务状态 chip 而言，已被已对账主页取代
// （作者 README frontmatter 优先，派生汇总仅作回退）。SC-26 的 PROGRESS.md 权威
// 在其真实域——Progress 标签页/轨道——保留。hook 本身保留（消费者休眠，PIN Q1-P2）。
function MissionChipBadge({ mission }: { mission: GroupedMission }) {
  return (
    <MissionStatusBadge
      status={mission.status}
      label={mission.statusLabel}
      testId={`project-mission-${mission.id}-badge`}
    />
  );
}

export function ProjectTreeView() {
  const { data: slicesResp } = useSlices("all");
  const workspace = useWorkspaceName();
  // OPR.0.4.6.MH2 FR-4——所选主机 + 注册表驱动项目浏览器的主机层（fr4a 裁定）。
  // 发现遍历本地工作区文件，因此对远程选择，它在 hook 处被门控关闭
  // （enabled:false ⇒ 零 /api/files 请求——guard-B1：事后的结果包装器不是门控），
  // 任务仅从主机键控的 slice 列表派生——本地文件夹绝不被标注为远程主机的
  // （twin 的 mock 接缝规则，保留在构建中）。
  const { data: hostsData } = useHosts();
  const selectHost = useSelectHost();
  const selectedHost = hostsData?.selected ?? LOCAL_HOST_ID;
  const isRemote = selectedHost !== LOCAL_HOST_ID;
  const remoteHosts = hostsData?.hosts ?? [];
  // 发现等待选择已知（主机负载已到达）：仅门控 !isRemote 会竞态——首次渲染默认本地，
  // 在远程选择解析前就触发了 /api/files/roots。唯一的共享门控（useLocalFilesAllowed）
  // 同时编码两个条件。
  const filesAllowed = useLocalFilesAllowed();
  const discovery = useMissionDiscovery({ enabled: filesAllowed });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    workspace: true,
  });
  const toggle = (k: string) =>
    setExpanded((p) => ({ ...p, [k]: !p[k] }));

  const sliceList: SliceListEntry[] =
    slicesResp && "slices" in slicesResp ? slicesResp.slices : [];
  // VM-005：后台服务的作者撰写任务状态 sidecar（作者优先）。无条目的键
  // （railItem 分组、零 slice 发现任务、旧后台服务）从派生汇总对账。memo 化，
  // 使下方任务 memo 保持稳定的依赖身份。
  const authoredStatuses = useMemo(
    () => (slicesResp && "slices" in slicesResp ? (slicesResp.missions ?? {}) : {}),
    [slicesResp],
  );

  // 先按 missionId 分组 slice，再按 railItem 作为旧的扁平根。
  const slicesByMissionKey = useMemo(() => {
    const buckets = new Map<string, ProjectSliceRow[]>();
    for (const s of sliceList) {
      const key = s.missionId ?? s.railItem ?? "unsorted";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(projectSliceFromListEntry(s));
    }
    return buckets;
  }, [sliceList]);

  // P5-5：当文件系统任务发现可用时，展示磁盘发现的任务并经 missionId 匹配挂载其 slice。
  // 否则回退到仅 missionId/railItem 分组。
  const missions = useMemo<GroupedMission[]>(() => {
    if (!discovery.unavailable && discovery.missions.length > 0) {
      const consumedKeys = new Set<string>();
      const discovered: GroupedMission[] = discovery.missions.map((m: DiscoveredMission) => {
        const matchedSlices = slicesByMissionKey.get(m.name) ?? [];
        if (matchedSlices.length > 0) consumedKeys.add(m.name);
        const rec = reconcileMissionStatus(
          authoredStatuses[m.name]?.authoredStatus ?? null,
          matchedSlices, undefined, authoredStatuses[m.name]?.readiness,
        );
        return {
          id: m.name,
          label: m.name,
          status: rec.state,
          statusLabel: rec.label,
          statusSource: rec.source,
          slices: matchedSlices,
          fsRoot: m.root,
          fsPath: m.path,
        };
      });
      // 其 mission 键不匹配磁盘任务的任何 slice，归入自己的索引组，使旧 railItem 任务
      // 不被折叠进一个混合的当前/归档桶。
      for (const [missionKey, slices] of slicesByMissionKey.entries()) {
        if (consumedKeys.has(missionKey)) continue;
        const rec = reconcileMissionStatus(
          authoredStatuses[missionKey]?.authoredStatus ?? null,
          slices, undefined, authoredStatuses[missionKey]?.readiness,
        );
        discovered.push({
          id: missionKey,
          label: missionKey === "unsorted" ? "未分类" : missionKey,
          status: rec.state,
          statusLabel: rec.label,
          statusSource: rec.source,
          slices,
        });
      }
      return discovered;
    }
    // 回退：仅 missionId/railItem 分组。
    return Array.from(slicesByMissionKey.entries()).map(([k, slices]) => {
      const rec = reconcileMissionStatus(authoredStatuses[k]?.authoredStatus ?? null, slices, undefined, authoredStatuses[k]?.readiness);
      return {
        id: k,
        label: k === "unsorted" ? "未分类" : k,
        status: rec.state,
        statusLabel: rec.label,
        statusSource: rec.source,
        slices,
      };
    });
  }, [discovery.unavailable, discovery.missions, slicesByMissionKey, authoredStatuses]);

  const missionSections = useMemo(() => {
    return partitionProjectMissions(missions);
  }, [missions]);

  // A5 回弹修复：用 ConfigStore 实时接线的工作区名取代硬编码 "openrig-work"。
  // 未设置/不可达时：渲染诚实的空态节点（"未连接工作区" + 指向 /settings 的 Link）。
  // MH-2：仅本地——工作区名是本地配置；远程选择按本地工作区状态无关地渲染远程树。
  if (!isRemote && !workspace.isLoading && workspace.name === null) {
    return (
      <div
        data-testid="project-tree-view"
        className="flex-1 overflow-y-auto py-3 px-3"
      >
        <div
          data-testid="project-no-workspace"
          className="border border-outline-variant bg-surface-low px-3 py-3 font-mono text-[10px]"
        >
          <div className="text-on-surface uppercase tracking-wide font-bold mb-1">
            未连接工作区
          </div>
          <p className="text-on-surface-variant mb-2">
            请配置工作区根，以便浏览任务与切片。
          </p>
          <Link
            to="/settings"
            data-testid="project-no-workspace-cta"
            className="inline-flex items-center text-on-surface hover:underline uppercase"
          >
            打开设置 →
          </Link>
        </div>
      </div>
    );
  }

  // MH-2 诚实标签：远程主机的工作区名在 v1 中不可读（配置不在读取白名单；
  // /api/hosts 不带远程 workspaceName）——上方主机层命名主机，工作区节点保持通用。
  // 记为已命名的 twin 偏差。
  const workspaceLabel = isRemote ? "工作区" : (workspace.name ?? "正在加载…");
  const isExpanded = (key: string, defaultValue = false) => expanded[key] ?? defaultValue;

  const renderMission = (m: GroupedMission, bucket: ProjectMissionBucket) => {
    const defaultExpanded = bucket === "current";
    const missionExpanded = isExpanded(`mission-${m.id}`, defaultExpanded);
    return (
      <li
        key={m.id}
        data-testid={`project-mission-${m.id}`}
        data-mission-bucket={bucket}
      >
        <div className="w-full flex items-center gap-1 px-2 py-0.5 hover:bg-surface-low text-left">
          <button
            type="button"
            aria-label={`${missionExpanded ? "折叠" : "展开"} ${m.label}`}
            onClick={() =>
              setExpanded((p) => ({
                ...p,
                [`mission-${m.id}`]: !missionExpanded,
              }))
            }
            className="flex h-4 w-4 items-center justify-center"
            data-testid={`project-mission-toggle-${m.id}`}
          >
            {missionExpanded ? (
              <ChevronDown className="h-3 w-3 text-on-surface-variant" />
            ) : (
              <ChevronRight className="h-3 w-3 text-on-surface-variant" />
            )}
          </button>
          <Link
            to="/project/mission/$missionId"
            params={{ missionId: m.id }}
            data-testid={`project-mission-link-${m.id}`}
            className="font-mono text-[11px] text-on-surface flex-1 truncate hover:underline"
          >
            {m.label}
          </Link>
          <MissionChipBadge mission={m} />
        </div>
        {missionExpanded ? (
          <ul className="ml-4 border-l border-outline-variant">
            {m.slices.length === 0 ? (
              <li className="px-2 py-0.5 font-mono text-[10px] text-on-surface-variant italic">
                  暂无切片。
              </li>
            ) : (
              m.slices.map((s) => {
                const sliceBucket = isCurrentProjectSlice(s) ? "current" : "archive";
                const meta = projectSliceMeta(s);
                return (
                  <li key={s.name} data-slice-bucket={sliceBucket}>
                    <Link
                      to="/project/slice/$sliceId"
                      params={{ sliceId: s.name }}
                      data-testid={`project-slice-${s.name}`}
                      title={`${s.displayName} — ${meta}`}
                      aria-label={`${s.displayName} (${meta})`}
                      className="flex items-start gap-2 px-2 py-1 font-mono text-xs text-on-surface hover:text-on-surface hover:bg-surface-low"
                    >
                      <span className="min-w-0 flex-1 whitespace-normal break-words leading-snug">{s.displayName}</span>
                      <span
                        data-testid={`project-slice-${s.name}-meta`}
                        className="flex shrink-0 items-center gap-1.5"
                      >
                        <QueueCountIcon count={s.qitemCount} testId={`project-slice-${s.name}-qitems`} />
                        <StatusDot
                          tone={sliceStatusTone(s.status)}
                          label={s.status}
                          testId={`project-slice-${s.name}-status`}
                        />
                      </span>
                    </Link>
                  </li>
                );
              })
            )}
          </ul>
        ) : null}
      </li>
    );
  };

  const workspaceNode = (
        <li data-testid="project-workspace-node">
          <button
            type="button"
            onClick={() => toggle("workspace")}
            className="w-full flex items-center gap-1 px-2 py-1 hover:bg-surface-low text-left"
            data-testid="project-workspace-toggle"
          >
            {expanded.workspace ? (
              <ChevronDown className="h-3 w-3 text-on-surface-variant" />
            ) : (
              <ChevronRight className="h-3 w-3 text-on-surface-variant" />
            )}
            <span
              data-testid="project-workspace-label"
              className="font-mono text-[11px] uppercase tracking-wide text-on-surface flex-1"
            >
              {workspaceLabel}
            </span>
            <Link
              to="/project"
              data-testid="project-workspace-link"
              onClick={(e) => e.stopPropagation()}
              className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant hover:text-on-surface"
            >
              打开
            </Link>
          </button>
          {isExpanded("workspace") ? (
            <ul className="ml-4 border-l border-outline-variant">
              {discovery.unavailable && discovery.hint ? (
                <li
                  data-testid="project-discovery-degraded"
                  className="px-2 py-1 font-mono text-[9px] text-on-surface-variant italic"
                  title={discovery.hint}
                >
              工作区任务文件夹不可用；展示已索引的切片分组。预期路径为 workspace/missions/&lt;mission&gt;/slices/&lt;slice&gt;。
                </li>
              ) : null}
              {missions.length === 0 ? (
                <li className="px-2 py-1 font-mono text-[10px] text-on-surface-variant italic">
                  暂无任务。
                </li>
              ) : (
                <>
                  <li
                    data-testid="project-mission-section-current"
                    className="px-2 pt-2 pb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant"
                  >
                    当前工作 · {missionSections.current.length}
                  </li>
                  {missionSections.current.length > 0 ? (
                    missionSections.current.map((m) => renderMission(m, "current"))
                  ) : (
                    <li
                      data-testid="project-mission-section-current-empty"
                      className="px-2 py-1 font-mono text-[10px] text-on-surface-variant italic"
                    >
                      暂无当前工作。
                    </li>
                  )}
                  <li
                    data-testid="project-mission-section-archive"
                    className="px-2 pt-3 pb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant"
                  >
                    归档 · {missionSections.archive.length}
                  </li>
                  {missionSections.archive.length > 0 ? (
                    missionSections.archive.map((m) => renderMission(m, "archive"))
                  ) : (
                    <li
                      data-testid="project-mission-section-archive-empty"
                      className="px-2 py-1 font-mono text-[10px] text-on-surface-variant italic"
                    >
                      暂无归档工作。
                    </li>
                  )}
                </>
              )}
            </ul>
          ) : null}
        </li>
  );

  // OPR.0.4.6.MH2 FR-4（fr4a 已裁定）——主机 → 工作区 → 任务 → slice。
  // 主机层仅在注册表非空时渲染（FR-1 的“给定一个或多个已添加主机”）——
  // 空注册表保持今天的确切树（零回归）。展开 = 选中，镜像拓扑树：
  // 屏上恰好一个主机的工作区，指示 + 数据原子。
  const showHostLevel = remoteHosts.length > 0 || isRemote;
  const ownName = hostsData?.ownName && hostsData.ownName.trim() !== "" ? hostsData.ownName : "localhost";
  const hostRow = (opts: { hostId: string; label: string; isLocal: boolean }) => {
    const isSelected = selectedHost === opts.hostId;
    const chip = isSelected ? "查看中" : opts.isLocal ? "本地" : null;
    return (
      <li
        key={opts.hostId}
        data-testid={`project-host-${opts.isLocal ? "localhost" : opts.hostId}`}
        data-selected={isSelected}
      >
        <button
          type="button"
          onClick={() => {
            if (!isSelected) selectHost.mutate({ hostId: opts.hostId });
          }}
          className="w-full flex items-center gap-1 px-2 py-1 hover:bg-surface-low text-left"
        >
          {isSelected ? <ChevronDown className="h-3 w-3 text-on-surface-variant" /> : <ChevronRight className="h-3 w-3 text-on-surface-variant" />}
          <Globe className="h-3 w-3 text-on-surface-variant" />
          <span className="font-mono text-[11px] uppercase tracking-wide text-on-surface flex-1 truncate">{opts.label}</span>
          {chip ? (
            <span
              className={cn(
                "font-mono text-[9px] uppercase tracking-[0.12em]",
                isSelected ? "bg-inverse-surface px-1 text-background" : "text-on-surface-variant",
              )}
            >
              {chip}
            </span>
          ) : null}
        </button>
        {isSelected ? <ul className="ml-4 border-l border-outline-variant">{workspaceNode}</ul> : null}
      </li>
    );
  };

  return (
    <div data-testid="project-tree-view" className="flex-1 overflow-y-auto py-2">
      {/*
        V0.3.1 slice 17 founder-walk-workspace-state-correctness——第 8 步（Explorer 自动展示）。手动刷新按钮丢弃
        后台服务侧索引器缓存与 react-query slice/文件缓存，使新建的 slice/任务文件夹
        无需重启后台服务即可出现。useSlices / useFilesList 中的 window-focus 重取
        处理常见的“切出去 mkdir 又回来”情形；此按钮是 window-focus 不触发时的
        显式回退（例如从不离开标签页的快操作手）。
      */}
      <ProjectTreeRefreshHeader remoteReadonly={isRemote} />
      <ul>
        {showHostLevel ? (
          <>
            {hostRow({ hostId: LOCAL_HOST_ID, label: ownName, isLocal: true })}
            {remoteHosts.map((h) => hostRow({ hostId: h.id, label: h.id, isLocal: false }))}
          </>
        ) : (
          workspaceNode
        )}
      </ul>
    </div>
  );
}
