// V1 润色切片第 5.2 阶段 P5.2-4：RigGroupNode 渲染器。
//
// 多工作组单画布 /topology 图中的最外层容器。
// 每个工作组在画布上呈现为柔和的羊皮纸边框；点击主体切换折叠；
// 使用工作组标签上的箭头控件钻取到 /topology/rig/$rigId。
// 折叠时，摘要卡片显示计数。展开时，卡片作为包围框容器；
// Pod 组 + 智能体节点通过 react-flow 父子关系在内部渲染。
//
// 视觉：1px outline-variant 边框（universal-shell.md L43-L48 原则）
// + 4 角 RegistrationMarks + 等宽大写工作组标签。

import { memo } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { Handle, Position } from "@xyflow/react";
import { RegistrationMarks } from "../ui/registration-marks.js";
import { StatusPip } from "../ui/status-pip.js";
import { cn } from "../../lib/utils.js";

export interface RigGroupNodeData {
  rigId: string;
  rigName: string;
  /** 为 true 时，主体显示摘要卡片，子节点在外部渲染。
   *  为 false 时，主体作为包围框；子节点通过 react-flow 父子定位在内部渲染。 */
  collapsed: boolean;
  status: "running" | "partial" | "stopped";
  nodeCount: number;
  runningCount: number;
  /**
   * 切片 15 —— 工作组的终端活跃计数。提供时，"active" 标签读取此原始值
   * 而非进程存活的 `runningCount`。后台服务尚未发出时回退到 runningCount
   * （诚实回退，不静默混淆）。
   */
  activeCount?: number;
  podCount?: number; // 可选；展开后图获取时填充
  recentActivity?: boolean;
  /** 点击处理：拥有者串联切换展开状态。 */
  onToggle: (rigId: string) => void;
}

function statusToPip(s: RigGroupNodeData["status"]): React.ComponentProps<typeof StatusPip>["status"] {
  if (s === "running") return "running";
  if (s === "stopped") return "stopped";
  return "warning"; // partial
}

function RigGroupNodeInner({ data }: { data: RigGroupNodeData }) {
  const { rigId, rigName, collapsed, status, nodeCount, runningCount, activeCount, podCount, recentActivity, onToggle } = data;
  // 切片 15 —— 有终端活跃计数时显示；对早于该切片的后台服务回退到
  // runningCount。如实标注："{N} active" 读取 active 原始值，非 runningCount。
  const displayedActiveCount = activeCount ?? runningCount;
  return (
    <div
      data-testid={`rig-group-node-${rigId}`}
      data-collapsed={collapsed ? "true" : "false"}
      onClick={(e) => {
        // 主体点击切换折叠。内部的钻取 Link 停止冒泡，
        // 使其点击导航时不会同时触发切换。
        e.stopPropagation();
        onToggle(rigId);
      }}
      className={cn(
        "w-full h-full relative flex flex-col cursor-pointer select-none overflow-visible",
        collapsed
          ? "border border-outline-variant bg-surface-lowest/40 backdrop-blur-[8px] hard-shadow hover:bg-surface-lowest/50"
          : "border border-outline-variant/70 bg-surface-lowest/40 backdrop-blur-[8px] shadow-[0_0_0_1px_rgba(84,96,115,0.06)]",
        recentActivity && "rig-activity-frame-pulse",
      )}
    >
      <RegistrationMarks testIdPrefix={`rig-group-${rigId}`} />
      <header className="absolute -top-8 left-4 z-10 flex items-center gap-2 border border-outline-variant/70 bg-background px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.10em] text-on-surface shadow-[2px_2px_0_rgba(46,52,46,0.10)]">
        <div className="flex items-center gap-2 min-w-0">
          <ChevronRight
            className={cn(
              "h-3 w-3 text-on-surface-variant shrink-0 transition-transform",
              collapsed ? "" : "rotate-90",
            )}
            aria-hidden="true"
          />
          <span
            data-testid={`rig-group-name-${rigId}`}
            className="font-mono text-[11px] font-bold uppercase tracking-[0.10em] text-on-surface truncate"
          >
            {rigName}
          </span>
        </div>
        <StatusPip
          status={statusToPip(status)}
          label={status}
          variant="pill"
          testId={`rig-group-status-${rigId}`}
        />
        <Link
          to="/topology/rig/$rigId"
          params={{ rigId }}
          onClick={(e) => e.stopPropagation()}
          data-testid={`rig-group-drill-${rigId}`}
          className="shrink-0 p-0.5 text-on-surface-variant hover:text-on-surface hover:bg-surface-high/60"
          aria-label={`打开 ${rigName} 工作组页面`}
        >
          <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      </header>
      {collapsed ? (
        <div className="px-3 pt-8 pb-3 flex items-center justify-between gap-2 flex-1">
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="font-mono text-[9px] uppercase tracking-wider text-on-surface-variant">
              {podCount !== undefined ? `${podCount} 个 Pod / ` : ""}
              {nodeCount} 个智能体
            </div>
            <div className="font-mono text-[9px] text-on-surface-variant">
              {displayedActiveCount} 个活跃
            </div>
          </div>
        </div>
      ) : (
        <div
          className="absolute right-3 top-3 flex items-center gap-2 font-mono text-[8px] uppercase tracking-[0.12em] text-on-surface-variant"
          data-testid={`rig-group-expanded-counts-${rigId}`}
        >
          <span>{podCount !== undefined ? `${podCount} 个 Pod` : ""}</span>
          {podCount !== undefined ? <span>/</span> : null}
          <span>{nodeCount} 个智能体</span>
          <span>/</span>
          <span>{displayedActiveCount} 个活跃</span>
        </div>
      )}
      {/* React-flow 连接点（不可见）：工作组组是容器，不是边端点，
          但连接点使 react-flow 的 NodeRenderer 对工作组组内可能在 V1.5+
          跨组边界有边的节点保持正常。 */}
      <Handle type="target" position={Position.Top} className="opacity-0 pointer-events-none" />
      <Handle type="source" position={Position.Bottom} className="opacity-0 pointer-events-none" />
    </div>
  );
}

/** V0.3.1 错误修复切片 topology-perf —— 图 CPU 优化。
 *
 * 用 React.memo 包装 + 对视觉字段做自定义比较。data prop 引用在每次
 * `useTopologyActivity` 更新（1 秒间隔 + 每流事件）时都变化，因为
 * HostMultiRigGraph 通过 `.map(...)` 重建节点数组以串联 `recentActivity`。
 * 没有 memo 时，每次更新都重新渲染每个工作组组。有了 memo，
 * 除非用户可见内容真的变化，否则跳过重渲染。 */
export const RigGroupNode = memo(RigGroupNodeInner, (prev, next) => {
  const a = prev.data;
  const b = next.data;
  return (
    a.rigId === b.rigId &&
    a.rigName === b.rigName &&
    a.collapsed === b.collapsed &&
    a.status === b.status &&
    a.nodeCount === b.nodeCount &&
    a.runningCount === b.runningCount &&
    a.activeCount === b.activeCount &&
    a.podCount === b.podCount &&
    a.recentActivity === b.recentActivity &&
    a.onToggle === b.onToggle
  );
});
RigGroupNode.displayName = "RigGroupNode";
