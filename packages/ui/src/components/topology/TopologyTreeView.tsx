// V1 attempt-3 Phase 3 —— 依 topology-tree.md L13–L29 + SC-9 + SC-11b 的拓扑树。
//
// host > rig > pod > seat。多 host 信封：V1 在所有 rig 之上只有一个 host 节点
// （"localhost"）；V2 增加远端 host 注册。
//
// V1 polish slice Phase 5.1 P5.1-2 + DRIFT P5.1-D2：SeatLeaf 详情
// 图标（P5-1）在 V1 polish 退役。图节点
// 点击 + 树点击 + 表格行点击都导航到规范的
// /topology/seat/$rigId/$logicalId 中心页。抽屉式 seat 详情模式已移除；
// SeatDetailTrigger 原语删除。
//
// P5.1-2 第二部分——自动展开：当路由在 seat URL 上时，
// 自动展开匹配的 rig + pod 分支，使用户看到智能体在树中的位置。
// 经 RigBranch + PodBranch 内 useRouterState pathname 解析实现。

import { useEffect, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { Archive, ChevronDown, ChevronRight, Globe } from "lucide-react";
import { cn } from "../../lib/utils.js";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import { useArchivedRigs } from "../../hooks/useArchivedRigs.js";
import { useNodeInventory } from "../../hooks/useNodeInventory.js";
import { useSettings } from "../../hooks/useSettings.js";
import { useHosts, useSelectHost } from "../../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import { displayPodName, inferPodName } from "../../lib/display-name.js";
import { RuntimeMark } from "../graphics/RuntimeMark.js";

/** 解析当前拓扑 pathname 中的 seat 作用域 rigId+logicalId，
 *  以及（在 rig/pod URL 上时）激活的 rigId / podName。用于匹配分支的自动展开。 */
function useActiveTopologyContext(): {
  rigId: string | null;
  podName: string | null;
  logicalId: string | null;
} {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // /topology/seat/$rigId/$logicalId
  const seatMatch = pathname.match(/^\/topology\/seat\/([^/]+)\/(.+)$/);
  if (seatMatch) {
    const rigId = decodeURIComponent(seatMatch[1]!);
    const logicalId = decodeURIComponent(seatMatch[2]!);
    const podName = inferPodName(logicalId) ?? "default";
    return { rigId, podName, logicalId };
  }
  // /topology/pod/$rigId/$podName
  const podMatch = pathname.match(/^\/topology\/pod\/([^/]+)\/([^/]+)$/);
  if (podMatch) {
    return {
      rigId: decodeURIComponent(podMatch[1]!),
      podName: decodeURIComponent(podMatch[2]!),
      logicalId: null,
    };
  }
  // /topology/rig/$rigId
  const rigMatch = pathname.match(/^\/topology\/rig\/([^/]+)$/);
  if (rigMatch) {
    return { rigId: decodeURIComponent(rigMatch[1]!), podName: null, logicalId: null };
  }
  return { rigId: null, podName: null, logicalId: null };
}

function SeatLeaf({ rigId, logicalId, label, runtime, isActive }: {
  rigId: string;
  logicalId: string;
  label: string;
  runtime?: string | null;
  isActive: boolean;
}) {
  return (
    <li className="px-2 py-0.5 hover:bg-surface-low">
      <Link
        to="/topology/seat/$rigId/$logicalId"
        params={{ rigId, logicalId: encodeURIComponent(logicalId) }}
        data-testid={`topology-seat-${rigId}-${logicalId}`}
        data-active={isActive}
        className={cn(
          "flex w-full min-w-0 items-center gap-1.5 font-mono text-xs",
          isActive
            ? "text-on-surface font-bold"
            : "text-on-surface hover:text-on-surface",
        )}
      >
        <RuntimeMark runtime={runtime} size="xs" />
        <span className="truncate">{label}</span>
      </Link>
    </li>
  );
}

function PodBranch({ rigId, podName, seats, activeRigId, activePodName, activeLogicalId }: {
  rigId: string;
  podName: string;
  seats: Array<{ logicalId: string; label: string; runtime?: string | null }>;
  activeRigId: string | null;
  activePodName: string | null;
  activeLogicalId: string | null;
}) {
  const [open, setOpen] = useState(false);
  // P5.1-2 自动展开：当当前路由在本 pod 上（经 pod URL，
  // 或经 pod 解析到本 pod 的 seat URL）时，强制展开。
  const shouldAutoExpand =
    activeRigId === rigId && activePodName === podName;
  useEffect(() => {
    if (shouldAutoExpand && !open) setOpen(true);
  }, [shouldAutoExpand, open]);
  return (
    <li data-testid={`topology-pod-${rigId}-${podName}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1 px-2 py-0.5 hover:bg-surface-low text-left"
      >
        {open ? <ChevronDown className="h-3 w-3 text-on-surface-variant" /> : <ChevronRight className="h-3 w-3 text-on-surface-variant" />}
        <Link
          to="/topology/pod/$rigId/$podName"
          params={{ rigId, podName }}
          onClick={(e) => e.stopPropagation()}
          className="font-mono text-[11px] text-on-surface flex-1 truncate hover:underline"
        >
          {displayPodName(podName)}
        </Link>
        <span className="font-mono text-[9px] text-on-surface-variant">{seats.length}</span>
      </button>
      {open ? (
        <ul className="ml-4 border-l border-outline-variant">
          {seats.map((s) => (
            <SeatLeaf
              key={s.logicalId}
              rigId={rigId}
              logicalId={s.logicalId}
              label={s.label}
              runtime={s.runtime}
              isActive={activeRigId === rigId && activeLogicalId === s.logicalId}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function RigBranch({ rigId, rigName, activeRigId, activePodName, activeLogicalId }: {
  rigId: string;
  rigName: string;
  activeRigId: string | null;
  activePodName: string | null;
  activeLogicalId: string | null;
}) {
  // P5.1-2 自动展开：当激活路由位于本 rig 内（rig 作用域 URL，
  // 或 rigId 匹配的 pod/seat 作用域 URL）时，强制展开。
  const shouldAutoExpand = activeRigId === rigId;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (shouldAutoExpand && !open) setOpen(true);
  }, [shouldAutoExpand, open]);
  // 自动展开时 eagerly 抓取节点，使用户落在深层 URL 而未手动展开 rig 时
  // pod 树也能解析。
  const eagerFetch = open || shouldAutoExpand;
  const { data: nodes } = useNodeInventory(eagerFetch ? rigId : null);
  const podsMap = new Map<string, Array<{ logicalId: string; label: string; runtime?: string | null }>>();
  for (const n of nodes ?? []) {
    const pod = inferPodName(n.logicalId) ?? "default";
    if (!podsMap.has(pod)) podsMap.set(pod, []);
    podsMap.get(pod)!.push({
      logicalId: n.logicalId,
      label: n.canonicalSessionName ?? n.logicalId,
      runtime: n.runtime,
    });
  }
  const pods = Array.from(podsMap.entries());

  return (
    <li data-testid={`topology-rig-${rigId}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1 px-2 py-1 hover:bg-surface-low text-left"
      >
        {open ? <ChevronDown className="h-3 w-3 text-on-surface-variant" /> : <ChevronRight className="h-3 w-3 text-on-surface-variant" />}
        <Link
          to="/topology/rig/$rigId"
          params={{ rigId }}
          onClick={(e) => e.stopPropagation()}
          className="font-mono text-[11px] uppercase text-on-surface flex-1 truncate hover:underline"
        >
          {rigName}
        </Link>
      </button>
      {open ? (
        <ul className="ml-4 border-l border-outline-variant">
          {pods.length === 0 ? (
            <li className="px-2 py-1 font-mono text-[10px] text-on-surface-variant italic">
              加载中…
            </li>
          ) : (
            pods.map(([pod, seats]) => (
              <PodBranch
                key={pod}
                rigId={rigId}
                podName={pod}
                seats={seats}
                activeRigId={activeRigId}
                activePodName={activePodName}
                activeLogicalId={activeLogicalId}
              />
            ))
          )}
        </ul>
      ) : null}
    </li>
  );
}

// OPR.0.3.3.19 —— 每 host 的“归档”区。已归档 rig 从上面默认树中隐藏；
// 这个可折叠区（默认折叠）列出它们，使其可被发现且可逆。抓取是惰性的：
// 仅在该区展开后才发 archived-only 查询，故折叠归档零成本
// （镜像树其他地方惰性按 rig 扇出）。
function ArchiveSection({ activeRigId, activePodName, activeLogicalId }: {
  activeRigId: string | null;
  activePodName: string | null;
  activeLogicalId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const { data: archived } = useArchivedRigs({ enabled: open });
  const count = archived?.length ?? 0;

  return (
    <li data-testid="topology-archive-section">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1 px-2 py-1 hover:bg-surface-low text-left"
      >
        {open ? <ChevronDown className="h-3 w-3 text-on-surface-variant" /> : <ChevronRight className="h-3 w-3 text-on-surface-variant" />}
        <Archive className="h-3 w-3 text-on-surface-variant" />
        <span className="font-mono text-[11px] uppercase text-on-surface-variant flex-1">归档</span>
        {open ? <span className="font-mono text-[9px] text-on-surface-variant">{count}</span> : null}
      </button>
      {open ? (
        <ul className="ml-5">
          {count === 0 ? (
            <li className="px-2 py-1 font-mono text-[10px] text-on-surface-variant italic">
              无已归档工作组。
            </li>
          ) : (
            archived!.map((r) => (
              <RigBranch
                key={r.id}
                rigId={r.id}
                rigName={r.name}
                activeRigId={activeRigId}
                activePodName={activePodName}
                activeLogicalId={activeLogicalId}
              />
            ))
          )}
        </ul>
      ) : null}
    </li>
  );
}

// OPR.0.4.6.MH2 FR-1 —— 枚举 host 层中的一个 host 节点。
// 选中的 host 即展开者（展开 = 选中：一次选中重定向所有读取屏幕，
// 故屏幕上一次只有一个 host 的工作区——指示器 + 树 + 数据一起移动）。
// 折叠的 host 渲染为行；点击它通过与 CLI 相同的单写路径写入选择。
// 相对 twin 帧的诚实 v1 偏差（记录在计划日志）：折叠的 host 不携带 rig 计数
// badge——统计未选 host 的 rig 需逐 host 扇出读取，那是 MH-5 fleet 高度，
// 不是单选 host 的读取穿透。
function HostBranch({ hostId, label, chip, isSelected, isLocal, onSelect, rigs, rigsError, rigsLoading, children }: {
  hostId: string;
  label: string;
  chip: string | null;
  isSelected: boolean;
  isLocal: boolean;
  onSelect: () => void;
  rigs: Array<{ id: string; name: string }> | undefined;
  rigsError: string | null;
  rigsLoading: boolean;
  children?: ReactNode;
}) {
  return (
    <li data-testid={isLocal ? "topology-host-localhost" : `topology-host-${hostId}`} data-selected={isSelected}>
      <button
        type="button"
        onClick={onSelect}
        className="w-full flex items-center gap-1 px-2 py-1 hover:bg-surface-low text-left"
      >
        {isSelected ? <ChevronDown className="h-3 w-3 text-on-surface-variant" /> : <ChevronRight className="h-3 w-3 text-on-surface-variant" />}
        <Globe className="h-3 w-3 text-on-surface-variant" />
        {isSelected ? (
          <Link
            to="/topology"
            onClick={(e) => e.stopPropagation()}
            className="font-mono text-[11px] uppercase text-on-surface flex-1 truncate hover:underline"
          >
            {label}
          </Link>
        ) : (
          <span className="font-mono text-[11px] uppercase text-on-surface flex-1 truncate">{label}</span>
        )}
        {chip ? (
          <span
            data-testid={`topology-host-chip-${hostId}`}
            className={cn(
              "font-mono text-[9px] uppercase tracking-[0.12em]",
              chip === "viewing" ? "bg-inverse-surface px-1 text-background" : "text-on-surface-variant",
            )}
          >
            {chip}
          </span>
        ) : null}
        {isSelected ? (
          <span className="font-mono text-[9px] text-on-surface-variant">{rigs?.length ?? 0}</span>
        ) : null}
      </button>
      {isSelected ? (
        <ul className="ml-5">
          {rigsError ? (
            // FR-6 —— 诚实的内联不可达提示（fr6-unreachable 树行）：发生了什么 + 重试在哪。
            <li
              data-testid={`topology-host-error-${hostId}`}
              className="px-2 py-1 font-mono text-[10px] text-error"
            >
              主机不可达——无法列出其工作组。请在页面上重试。
            </li>
          ) : rigsLoading && (rigs === undefined || rigs.length === 0) ? (
            <li className="px-2 py-1 font-mono text-[10px] text-on-surface-variant italic">
              正在拉取 {label} 的工作区…
            </li>
          ) : (
            children
          )}
        </ul>
      ) : null}
    </li>
  );
}

export function TopologyTreeView() {
  const { data: rigs, error: rigsQueryError, isFetching: rigsFetching } = useRigSummary();
  const { data: hostsData } = useHosts();
  const selectHost = useSelectHost();
  // OPR.0.4.6.MH1 FR-4：本机 host 显示名（一个存储名，各表面统一读取）。
  // 默认/未设置时精确如今天渲染 "localhost"。
  const { data: settingsData } = useSettings();
  const ownHostNameRaw = (settingsData?.settings?.["host.name" as never] as { value?: unknown } | undefined)?.value;
  const ownHostName = typeof ownHostNameRaw === "string" && ownHostNameRaw.trim() !== "" ? ownHostNameRaw : "localhost";
  // P5.1-2 自动展开：在树根拉取一次激活路由上下文，
  // 向下穿入 RigBranch + PodBranch。
  const { rigId: activeRigId, podName: activePodName, logicalId: activeLogicalId } =
    useActiveTopologyContext();

  const selected = hostsData?.selected ?? LOCAL_HOST_ID;
  const remoteHosts = hostsData?.hosts ?? [];
  const rigList = rigs ?? [];

  const rigTree = (
    <>
      {rigList.length > 0 ? (
        rigList.map((r) => (
          <RigBranch
            key={r.id}
            rigId={r.id}
            rigName={r.name}
            activeRigId={activeRigId}
            activePodName={activePodName}
            activeLogicalId={activeLogicalId}
          />
        ))
      ) : (
        <li className="px-2 py-1 font-mono text-[10px] text-on-surface-variant italic">
          无工作组。
        </li>
      )}
      {/* OPR.0.3.3.19 —— 已归档工作组仅挂在本地 host 下：
          archived-rigs 读取不在 MH-2 读取白名单上，故远端 host 的归档如实缺席，而非静默本地。 */}
      {selected === LOCAL_HOST_ID ? (
        <ArchiveSection
          activeRigId={activeRigId}
          activePodName={activePodName}
          activeLogicalId={activeLogicalId}
        />
      ) : null}
    </>
  );

  return (
    <div data-testid="topology-tree-view" className="flex-1 overflow-y-auto py-2">
      <ul>
        <HostBranch
          hostId={LOCAL_HOST_ID}
          label={ownHostName}
          // 零回归：注册表为空时本地节点不渲染 chip，精确如今天；
          // LOCAL/viewing chip 仅在 host 层真实（注册表非空）后出现。
          chip={remoteHosts.length === 0 ? null : selected === LOCAL_HOST_ID ? "viewing" : "local"}
          isSelected={selected === LOCAL_HOST_ID}
          isLocal
          onSelect={() => {
            if (selected !== LOCAL_HOST_ID) selectHost.mutate({ hostId: LOCAL_HOST_ID });
          }}
          rigs={rigList}
          rigsError={null}
          rigsLoading={rigsFetching}
        >
          {rigTree}
        </HostBranch>
        {remoteHosts.map((h) => (
          <HostBranch
            key={h.id}
            hostId={h.id}
            label={h.id}
            chip={selected === h.id ? "viewing" : h.status === "unreachable" ? "unreachable" : null}
            isSelected={selected === h.id}
            isLocal={false}
            onSelect={() => {
              if (selected !== h.id) selectHost.mutate({ hostId: h.id });
            }}
            rigs={rigList}
            rigsError={selected === h.id && rigsQueryError ? String((rigsQueryError as Error).message ?? rigsQueryError) : null}
            rigsLoading={rigsFetching}
          >
            {rigTree}
          </HostBranch>
        ))}
      </ul>
    </div>
  );
}
