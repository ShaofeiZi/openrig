// V1 attempt-3 Phase 3：拓扑表格视图，依 topology-table-view.md + SC-25。
//
// 基于 Tanstack 的表格；按拓扑逐智能体一行，由 URL 限定范围。
//
// V1 attempt-3 Phase 5 P5-9 ship-gate bounce P0-1：hooks 规则修复。
// 原写法用 `scopedRigs.map((r) => useNodeInventory(r.id))`，在循环中以可变数量调用 hook。
// 当 scopedRigs 从 0（useRigSummary 解析前的首屏）增长到 N（解析后）时，
// React 检测到 hook 数量变化，下游抛出
// "Cannot read properties of undefined (reading 'length')"。这导致 /topology 在
// 375x812 移动端白屏，因为 P5-9 在 rigs 数据就绪前的首次渲染就立即挂载表格
// （窄视口下 graph 视图降级为 table）。改用 React Query 的 `useQueries`：
// 无论数组长度如何都只调用一次 hook。

import { memo, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { useQueries } from "@tanstack/react-query";
import { useRigSummary } from "../../hooks/useRigSummary.js";
import type { NodeInventoryEntry } from "../../hooks/useNodeInventory.js";
import { VellumInput } from "../ui/vellum-input.js";
import { StatusPip } from "../ui/status-pip.js";
import { inferPodName } from "../../lib/display-name.js";
import { useCmuxLaunch } from "../../hooks/useCmuxLaunch.js";
import { useTopologyActivity } from "../../hooks/useTopologyActivity.js";
import { usePrefersReducedMotion } from "../../hooks/usePrefersReducedMotion.js";
import { useSelectedHostId } from "../../hooks/useHosts.js";
import { LOCAL_HOST_ID, withHostParam } from "../../lib/host-param.js";
import {
  buildTopologySessionIndex,
  type TopologyActivityBaseline,
  type TopologyActivityVisual,
} from "../../lib/topology-activity.js";
import { ActivityRing } from "./ActivityRing.js";
import { TerminalPreviewPopover } from "./TerminalPreviewPopover.js";
import "./topology-table-shimmer.css";
import { RuntimeBadge, ToolMark } from "../graphics/RuntimeMark.js";
import { formatCompactTokenCount, formatTokenTotalTitle, sumTokenCounts } from "../../lib/token-format.js";
import { contextUsageTextClass } from "../ContextUsageRing.js";

async function fetchNodeInventory(rigId: string, hostId: string): Promise<NodeInventoryEntry[]> {
  const res = await fetch(withHostParam(`/api/rigs/${encodeURIComponent(rigId)}/nodes`, hostId));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

interface AgentRow {
  rigId: string;
  rigName: string;
  podName: string;
  logicalId: string;
  sessionName: string;
  runtime: string;
  status: string;
  startupStatus: string | null;
  contextUsage?: NodeInventoryEntry["contextUsage"] | null;
  agentActivity?: TopologyActivityBaseline["agentActivity"];
  currentQitems?: TopologyActivityBaseline["currentQitems"];
  terminalActive?: boolean | null;
  hasAssignedWork?: boolean;
  pendingWorkCount?: number;
  activityRing?: TopologyActivityVisual;
  reducedMotion?: boolean;
}

function statusToSemanticPip(s: string): "active" | "running" | "stopped" | "warning" | "error" | "info" {
  if (s === "running" || s === "ready") return "running";
  if (s === "active") return "active";
  if (s === "stopped") return "stopped";
  if (s === "attention_required" || s === "warning") return "warning";
  if (s === "failed" || s === "error") return "error";
  return "info";
}

function CmuxButton({ row }: { row: AgentRow }) {
  // V0.3.1 slice 14 walk-item 16：操作列按钮无条件保持可见
  //（无 hover/focus 门控）。此前实现用 `opacity-0` + `group-hover:!opacity-100`，
  // 鼠标移开后隐藏了入口——操作者总找不到 cmux 启动器。
  const cmuxLaunch = useCmuxLaunch();
  // OPR.0.4.1.31 part B：把变更错误暴露出来。此前按钮只跟踪 isPending，
  // 一次 open-cmux 失败（无当前 cmux 工作区、缺终端 bearer 等）会静默失败
  // =「按钮从来不好使」。现在失败会显示可见、可操作的消息
  //（TanStack isError/error），出错时点击会重置并重试。
  const failed = cmuxLaunch.isError;
  const errorMessage = failed
    ? (cmuxLaunch.error instanceof Error ? cmuxLaunch.error.message : String(cmuxLaunch.error))
    : null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        data-testid={`topology-table-cmux-${row.logicalId}`}
        onClick={(e) => {
          e.stopPropagation();
          // OPR.0.4.1.31 part D：绝不为畸形行 POST open-cmux
          // （null/空 logicalId 会拼出 /nodes/"null"/open-cmux）。
          if (!row.logicalId) return;
          if (cmuxLaunch.isError) cmuxLaunch.reset();
          cmuxLaunch.mutate({ rigId: row.rigId, logicalId: row.logicalId });
        }}
        aria-busy={cmuxLaunch.isPending || undefined}
        aria-label={
          cmuxLaunch.isPending
            ? `正在 cmux 中打开 ${row.logicalId}`
            : failed
              ? `在 cmux 中打开 ${row.logicalId} 失败：${errorMessage}。点击重试。`
              : `在 cmux 中打开 ${row.logicalId}`
        }
        title={
          cmuxLaunch.isPending
            ? "正在 cmux 中打开"
            : failed
              ? `失败：${errorMessage} —— 点击重试`
              : "在 cmux 中打开"
        }
        disabled={cmuxLaunch.isPending}
        data-error={failed || undefined}
        className={`inline-flex h-7 w-7 items-center justify-center border bg-surface-lowest/65 shadow-[1px_1px_0_rgba(46,52,46,0.12)] transition-colors focus:outline-none focus:ring-2 focus:ring-on-surface/20 disabled:cursor-wait disabled:opacity-60 ${
          failed
            ? "border-rose-400 text-rose-700 hover:bg-rose-50"
            : "border-outline-variant text-on-surface hover:bg-surface-low hover:text-on-surface"
        }`}
      >
        <ToolMark tool="cmux" size="sm" />
        <span className="sr-only">CMUX</span>
      </button>
      {failed ? (
        <span
          data-testid={`topology-table-cmux-error-${row.logicalId}`}
          role="alert"
          className="font-mono text-[9px] text-rose-700 max-w-[220px] leading-tight whitespace-normal break-words"
        >
          {errorMessage}
        </span>
      ) : null}
    </span>
  );
}

/** V0.3.1 slice 14 walk-item 15 —— 状态标签拆分。当该行的活动环处于 `active` 状态时，
 *  单元格显示「活跃」并带 subtle 的从左到右微光；否则显示「空闲」
 *  （对 starting / failed 等非运行态则显示原始状态串）。
 *  通过 CSS 响应 `prefers-reduced-motion: reduce`——见
 *  `topology-table-shimmer.css` 中的 `topology-table-active-shimmer`。
 *
 *  V0.3.1 修复 slice topology-perf：做了 memo，
 *  这样 useTopologyActivity 的刷新（1 秒间隔 + 每流事件）不会在只有某一行
 *  activityState 变化时，重渲染大拓扑里每一个活跃状态单元格。 */
const StatusCell = memo(function StatusCell({ status, activityState }: { status: string; activityState: string | undefined }) {
  const semantic = statusToSemanticPip(status);
  // 只把 "running" 状态拆成 活跃/空闲。其他状态
  // （starting / stopped / failed / unknown）保留原始标签。
  const isRunning = status === "running" || status === "ready";
  const isActive = isRunning && activityState === "active";
  const isIdle = isRunning && !isActive;
  const label = isActive ? "活跃" : isIdle ? "空闲" : status;
  const labelClass = isActive ? "topology-table-active-shimmer" : "";
  return (
    <span data-testid={`topology-table-status-${activityState ?? "unknown"}`} data-activity-state={activityState ?? null}>
      <StatusPip status={semantic} label={label} variant="pill" labelClassName={labelClass} />
    </span>
  );
});
StatusCell.displayName = "StatusCell";

/** V0.3.1 修复 slice topology-perf：做了 memo，当父表格因 1 秒活动刷新重建行、
 *  但本行 context-usage 负载未变时跳过重渲染。 */
const ContextCell = memo(function ContextCell({ row }: { row: AgentRow }) {
  const usage = row.contextUsage;
  const known = usage?.availability === "known" && typeof usage.usedPercentage === "number";
  return (
    <span
      data-testid={`topology-table-context-${row.logicalId}`}
      className={`font-mono text-xs font-bold ${contextUsageTextClass(usage?.usedPercentage, usage?.fresh, usage?.availability)}`}
      title={
        known
          ? usage?.fresh === false
            ? "上下文用量（采样已过期）"
            : "上下文用量（最新采样）"
          : "上下文采样不可用"
      }
    >
      {known ? `${usage.usedPercentage}%` : "--"}
    </span>
  );
}, (prev, next) => {
  const a = prev.row.contextUsage;
  const b = next.row.contextUsage;
  return (
    prev.row.logicalId === next.row.logicalId &&
    a?.availability === b?.availability &&
    a?.usedPercentage === b?.usedPercentage &&
    a?.fresh === b?.fresh
  );
});
ContextCell.displayName = "ContextCell";

/** V0.3.1 修复 slice topology-perf：做了 memo；令牌单元格内容
 *  只依赖（输入、输出）令牌对，该对在多数刷新中保持稳定。 */
const TokenCell = memo(function TokenCell({ row }: { row: AgentRow }) {
  const usage = row.contextUsage;
  const total = sumTokenCounts(usage?.totalInputTokens, usage?.totalOutputTokens);
  const tokenLabel = formatCompactTokenCount(total);
  const tokenTitle = formatTokenTotalTitle(usage?.totalInputTokens, usage?.totalOutputTokens);
  return (
    <span
      data-testid={`topology-table-tokens-${row.logicalId}`}
      className={`font-mono text-xs font-bold ${tokenLabel ? "text-on-surface-variant" : "text-on-surface-variant"}`}
      title={tokenTitle ?? "令牌采样不可用"}
    >
      {tokenLabel ?? "--"}
    </span>
  );
}, (prev, next) => {
  const a = prev.row.contextUsage;
  const b = next.row.contextUsage;
  return (
    prev.row.logicalId === next.row.logicalId &&
    a?.totalInputTokens === b?.totalInputTokens &&
    a?.totalOutputTokens === b?.totalOutputTokens
  );
});
TokenCell.displayName = "TokenCell";

function agentColumns(): ColumnDef<AgentRow>[] {
  return [
    { accessorKey: "rigName", header: "工作组", cell: ({ getValue }) => <span className="font-mono text-xs">{String(getValue())}</span> },
    { accessorKey: "podName", header: "Pod", cell: ({ getValue }) => <span className="font-mono text-xs">{String(getValue())}</span> },
    {
      accessorKey: "logicalId",
      header: "智能体",
      cell: ({ row }) => (
        <ActivityRing
          as="span"
          state={row.original.activityRing?.state ?? "idle"}
          flash={row.original.activityRing?.flash ?? null}
          reducedMotion={row.original.reducedMotion}
          testId={`topology-table-activity-ring-${row.original.logicalId}`}
          className="inline-flex rounded-sm"
          ringClassName="-inset-1"
        >
          <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-xs">
            <span className="truncate">{row.original.logicalId}</span>
          </span>
        </ActivityRing>
      ),
    },
    {
      accessorKey: "runtime",
      header: "运行时",
      cell: ({ getValue }) => (
        <RuntimeBadge runtime={String(getValue() ?? "")} size="xs" compact variant="inline" />
      ),
    },
    {
      id: "context",
      header: "上下文",
      sortingFn: (a, b) => (a.original.contextUsage?.usedPercentage ?? -1) - (b.original.contextUsage?.usedPercentage ?? -1),
      cell: ({ row }) => <ContextCell row={row.original} />,
    },
    {
      id: "tokens",
      header: "令牌",
      sortingFn: (a, b) => {
        const left = sumTokenCounts(a.original.contextUsage?.totalInputTokens, a.original.contextUsage?.totalOutputTokens) ?? -1;
        const right = sumTokenCounts(b.original.contextUsage?.totalInputTokens, b.original.contextUsage?.totalOutputTokens) ?? -1;
        return left - right;
      },
      cell: ({ row }) => <TokenCell row={row.original} />,
    },
    {
      accessorKey: "status",
      header: "状态",
      cell: ({ getValue, row }) => (
        <StatusCell
          status={String(getValue())}
          activityState={row.original.activityRing?.state}
        />
      ),
    },
    {
      id: "actions",
      header: "操作",
      enableSorting: false,
      // V0.3.1 slice 14 walk-item 16：操作列并排显示 cmux + 终端预览，无 hover 门控。
      // 两个按钮始终渲染，保证入口可预期。
      cell: ({ row }) => <TopologyActionsCell row={row.original} />,
    },
  ];
}

/** OPR.0.4.6.MH2 rev1-r2 B1 —— cmux 启动 + 终端预览是本地动作
 * （裸本地 POST / 本地会话读取）；选中远程主机时行数据来自远程主机，
 *  因此本地入口被一个诚实的只读标记挡住（FR-7：远程视图不提供跨主机变更）。 */
function TopologyActionsCell({ row }: { row: AgentRow }) {
  const isRemote = useSelectedHostId() !== LOCAL_HOST_ID;
  if (isRemote) {
    return (
      <span
        data-testid={`topology-table-actions-${row.logicalId}`}
        data-remote-readonly="true"
        className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant"
      >
        只读
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5" data-testid={`topology-table-actions-${row.logicalId}`}>
      <CmuxButton row={row} />
      {row.rigId ? (
        <TerminalPreviewPopover
          rigId={row.rigId}
          logicalId={row.logicalId}
          sessionName={row.sessionName ?? null}
          reducedMotion={false}
          testIdPrefix={`topology-table-${row.logicalId}`}
          buttonClassName="inline-flex h-7 w-7 items-center justify-center border border-outline-variant bg-surface-lowest/65 text-on-surface shadow-[1px_1px_0_rgba(46,52,46,0.12)] transition-colors hover:bg-surface-low hover:text-on-surface focus:outline-none focus:ring-2 focus:ring-on-surface/20"
          progressive
        />
      ) : null}
    </span>
  );
}

export function TopologyTableView({ rigIdScope, podNameScope }: { rigIdScope?: string; podNameScope?: string }) {
  // V1 polish slice Phase 5.1 P5.1-7：行点击导航到 seat-scope 居中页
  //（与 graph 节点点击 + Explorer 树点击 + Topology Tree 的 details 图标退役契约保持一致）。
  const navigate = useNavigate();
  const hostId = useSelectedHostId();
  const { data: rigs } = useRigSummary();
  const reducedMotion = usePrefersReducedMotion();
  const scopedRigs = useMemo(
    () =>
      rigIdScope
        ? rigs?.filter((r) => r.id === rigIdScope) ?? []
        : rigs ?? [],
    [rigs, rigIdScope],
  );

  // P0-1 修复：用 useQueries 替换 .map(useNodeInventory) 循环。无论 scopedRigs
  // 长度如何都只调用一次 hook。即使 rigs 从 undefined 增长到 [N]，React 的 hook
  // 顺序在各次渲染间保持稳定。
  const inventoryResults = useQueries({
    queries: scopedRigs.map((r) => ({
      queryKey: ["rig", r.id, "nodes", hostId] as const,
      queryFn: () => fetchNodeInventory(r.id, hostId),
      refetchInterval: 30_000,
    })),
  });

  const data: AgentRow[] = useMemo(() => {
    const rows: AgentRow[] = [];
    for (let i = 0; i < scopedRigs.length; i++) {
      const rig = scopedRigs[i];
      const result = inventoryResults[i];
      if (!rig || !result) continue;
      const nodes: NodeInventoryEntry[] = result.data ?? [];
      const scopedNodes = podNameScope
        ? nodes.filter((n) => (n.podNamespace ?? n.podId) === podNameScope)
        : nodes;
      for (const n of scopedNodes) {
        rows.push({
          rigId: rig.id,
          rigName: rig.name,
          podName: inferPodName(n.logicalId) ?? "default",
          logicalId: n.logicalId,
          sessionName: n.canonicalSessionName ?? n.logicalId,
          runtime: (n.runtime ?? "-") as string,
          status: (n.sessionStatus ?? "unknown") as string,
          startupStatus: (n.startupStatus ?? null) as string | null,
          contextUsage: n.contextUsage ?? null,
          agentActivity: n.agentActivity ?? null,
          currentQitems: n.currentQitems ?? [],
          terminalActive: n.terminalActive,
          hasAssignedWork: n.hasAssignedWork ?? false,
          pendingWorkCount: n.pendingWorkCount ?? 0,
        });
      }
    }
    return rows;
  }, [scopedRigs, inventoryResults, podNameScope]);

  const sessionIndex = useMemo(() => buildTopologySessionIndex(data.map((row) => ({
    nodeId: `${row.rigId}::${row.logicalId}`,
    rigId: row.rigId,
    rigName: row.rigName,
    logicalId: row.logicalId,
    canonicalSessionName: row.sessionName,
    agentActivity: row.agentActivity ?? null,
    currentQitems: row.currentQitems ?? null,
    startupStatus: row.startupStatus,
    terminalActive: row.terminalActive,
    hasAssignedWork: row.hasAssignedWork ?? false,
    pendingWorkCount: row.pendingWorkCount ?? 0,
  }))), [data]);
  const topologyActivity = useTopologyActivity(sessionIndex);
  const activityData = useMemo(() => data.map((row) => ({
    ...row,
    activityRing: topologyActivity.getNodeActivity(`${row.rigId}::${row.logicalId}`, row),
    reducedMotion,
  })), [data, topologyActivity, reducedMotion]);

  const [sorting, setSorting] = useState<SortingState>([]);
  const [search, setSearch] = useState("");
  const columns = useMemo(() => agentColumns(), []);

  const table = useReactTable({
    data: activityData,
    columns,
    state: { sorting, globalFilter: search },
    onSortingChange: setSorting,
    onGlobalFilterChange: setSearch,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: (row, _columnId, filterValue) => {
      const q = String(filterValue ?? "").toLowerCase();
      if (!q) return true;
      const r = row.original;
      // OPR.0.4.1.13（崩溃修复）：每个字段都做空安全。表格为每个节点都建行，
      // 且在建行时不给 rigName（rig.name）或 logicalId（n.logicalId）兜底，
      // 因此一条畸形库存条目（name / logicalId 为 null——真实边界数据形态）
      // 会在过滤行模型构建时让 `r.rigName.toLowerCase()` / `r.logicalId.toLowerCase()`
      // 在此抛错，使 /topology 白屏（无错误边界）。`String(v ?? "")` 对五个字段都空安全。
      const hay = (v: unknown) => String(v ?? "").toLowerCase();
      return (
        hay(r.rigName).includes(q) ||
        hay(r.podName).includes(q) ||
        hay(r.logicalId).includes(q) ||
        hay(r.runtime).includes(q) ||
        hay(r.status).includes(q)
      );
    },
  });

  return (
    <div data-testid="topology-table-view" className="space-y-3 mt-4">
      <div className="flex items-center gap-2">
        <VellumInput
          placeholder="筛选智能体…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
          testId="topology-table-search"
        />
        <span className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant ml-auto">
          {table.getFilteredRowModel().rows.length} / {activityData.length}
        </span>
      </div>
      <div className="border border-outline-variant overflow-x-auto">
        <table className="w-full text-left">
          <thead className="bg-background border-b border-outline-variant">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    onClick={h.column.getToggleSortingHandler()}
                    className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface-variant cursor-pointer select-none"
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {{ asc: " ↑", desc: " ↓" }[h.column.getIsSorted() as string] ?? null}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-6 text-center font-mono text-xs text-on-surface-variant">
                  无匹配的智能体。
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  data-testid={`topology-table-row-${row.original.logicalId}`}
                  onClick={() => {
                    // OPR.0.4.1.31 part D：防护畸形行：null/空
                    // logicalId 会拼出 /seat/$rigId/"null"
                    //（encodeURIComponent(null) === "null"）。这类行跳过导航，
                    // 而不是路由到一个假的 seat URL。
                    if (!row.original.logicalId) return;
                    navigate({
                      to: "/topology/seat/$rigId/$logicalId",
                      params: {
                        rigId: row.original.rigId,
                        logicalId: encodeURIComponent(row.original.logicalId),
                      },
                    });
                  }}
                  className="group border-b border-outline-variant last:border-b-0 hover:bg-surface-low focus-within:bg-surface-low cursor-pointer"
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
