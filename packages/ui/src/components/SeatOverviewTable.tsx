// V0.3.1 slice 25 第二次后续——概览信息表打磨。
//
// 席位详情"概览"标签页顶部、按列排布的密集信息表。第二次后续打磨：
//   - 去掉分区头行（列头本身就是第一行）。
//   - 在表头 + 数据行的列单元格之间加竖网格线（border-r border-outline-variant），
//     单元格边界更清晰。
//   - "total tokens" 列表头收紧为 "tokens"，节省横向宽度。
//   - cwd + 当前工作移出本表，放到下方独立基元（SeatOverviewSecondary）；
//     本组件现在只渲染这一行 7 列紧凑字段。
//
// 移动端（HG-8）：列表头行 + 数据行包在 `overflow-x-auto` 滚动容器里，
// 这样 375px 视口可以横向滚动，而不是把 7 个单元格挤在一起。
//
// 数据来源（跨界面唯一真源）：
//   - runtime / model / profile / spec —— 直接取 NodeDetailData
//   - activity —— getActivityState(data.agentActivity) 基线，或经
//     useTopologyActivity 接入时取 activityVisual；与拓扑图 + 拓扑表同源。
//     状态 "running" 映射为标签 "active"，让席位页与拓扑命名一致。
//   - 上下文占比 / 总 token 数——data.contextUsage.usedPercentage +
//     sumTokenCounts(input, output)；与 TopologyTableView 拓扑表用同一组 helper。
//
// 微光：当活动状态为 "active"（或基线映射为 "running"）时，活动值套用
// slice-14 的 .topology-table-active-shimmer CSS 类。按 DESIGN.md §Motion
// 遵循 prefers-reduced-motion。

import type { ReactNode } from "react";
import type { NodeDetailData } from "../hooks/useNodeDetail.js";
import { RuntimeBadge } from "./graphics/RuntimeMark.js";
import {
  formatCompactTokenCount,
  sumTokenCounts,
} from "../lib/token-format.js";
import {
  getActivityLabel,
  getActivityStateWithSource,
  getTimeInState,
  type ActivityState,
} from "../lib/activity-visuals.js";
import type { TopologyActivityVisual } from "../lib/topology-activity.js";
import "./topology/topology-table-shimmer.css";

interface SeatOverviewTableProps {
  data: NodeDetailData;
  activityVisual?: TopologyActivityVisual | null;
}

interface ColumnField {
  key: string;
  label: string;
  value: ReactNode | null | undefined;
  mono?: boolean;
}

function placeholderOrValue(value: ReactNode | null | undefined): ReactNode {
  if (value === null || value === undefined) return <span className="text-on-surface-variant">—</span>;
  if (typeof value === "string" && value.trim() === "") return <span className="text-on-surface-variant">—</span>;
  return value;
}

function activityLabelFromState(state: ActivityState): string {
  if (state === "running") return "活动中";
  return getActivityLabel(state);
}

function activityLabelFromVisualState(state: TopologyActivityVisual["state"]): string {
  if (state === "active") return "活动中";
  if (state === "needs_input") return "需要输入";
  return state;
}

export function SeatOverviewTable({ data, activityVisual }: SeatOverviewTableProps) {
  const { state: fallbackActivityState, source: fallbackActivitySource } = getActivityStateWithSource(data.agentActivity, data.terminalActive);
  const activityState = activityVisual?.state ?? fallbackActivityState;
  const activityLabel = activityVisual
    ? activityLabelFromVisualState(activityVisual.state)
    : activityLabelFromState(fallbackActivityState);
  const activityIsActive = activityVisual
    ? activityVisual.state === "active"
    : fallbackActivityState === "running";
  const usingRecentActivityVisual = Boolean(activityVisual?.recent);
  const timeInState = usingRecentActivityVisual ? null : getTimeInState(data.agentActivity);
  const gradeLabel = !usingRecentActivityVisual && fallbackActivitySource !== "hook" && fallbackActivitySource !== "none" ? "（活动分级）" : "";

  const contextPercentage =
    data.contextUsage?.availability === "known" &&
    typeof data.contextUsage.usedPercentage === "number"
      ? `${data.contextUsage.usedPercentage}%`
      : null;
  const tokenTotal = sumTokenCounts(
    data.contextUsage?.totalInputTokens,
    data.contextUsage?.totalOutputTokens,
  );
  const tokenLabel = formatCompactTokenCount(tokenTotal);
  const specCell =
    data.resolvedSpecName && data.resolvedSpecVersion
      ? `${data.resolvedSpecName}@${data.resolvedSpecVersion}`
      : data.resolvedSpecName ?? null;

  const activityValue: ReactNode = (
    <span
      data-testid="seat-overview-activity-state"
      data-activity-state={activityState}
      data-activity-source={usingRecentActivityVisual ? "ring" : fallbackActivitySource}
      className={
        activityIsActive
          ? "topology-table-active-shimmer text-emerald-600"
          : "text-on-surface"
      }
    >
      {activityLabel}{timeInState ? ` ${timeInState.label}` : ""}{gradeLabel}
    </span>
  );

  const columnFields: ColumnField[] = [
    {
      key: "runtime",
      label: "运行时",
      value: data.runtime ? (
        <RuntimeBadge
          runtime={data.runtime}
          model={data.model}
          size="xs"
          compact
          variant="inline"
          className="max-w-full"
        />
      ) : null,
    },
    { key: "model", label: "模型", value: data.model, mono: true },
    { key: "profile", label: "档案", value: data.profile, mono: true },
    { key: "spec", label: "规格", value: specCell, mono: true },
    { key: "activity", label: "活动", value: activityValue },
    { key: "context-percent", label: "上下文 %", value: contextPercentage, mono: true },
    { key: "total-tokens", label: "令牌数", value: tokenLabel, mono: true },
  ];

  const lastIdx = columnFields.length - 1;

  return (
    <section
      data-testid="seat-overview-table"
      className="border border-outline-variant bg-surface-lowest/30"
    >
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr
              data-testid="seat-overview-header-row"
              className="border-b border-outline-variant/55 bg-background/30"
            >
              {columnFields.map((field, idx) => (
                <th
                  key={field.key}
                  scope="col"
                  data-testid={`seat-overview-header-${field.key}`}
                  className={`px-3 py-1.5 text-left font-mono text-[10px] font-normal lowercase tracking-[0.04em] text-on-surface-variant ${
                    idx < lastIdx ? "border-r border-outline-variant/55" : ""
                  }`}
                >
                  {field.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr
              data-testid="seat-overview-data-row"
              data-row-shape="data"
            >
              {columnFields.map((field, idx) => (
                <td
                  key={field.key}
                  data-testid={`seat-overview-cell-${field.key}`}
                  className={`min-w-0 px-3 py-1.5 align-middle ${
                    field.mono ? "font-mono text-[11px]" : "text-[11px]"
                  } text-on-surface ${
                    idx < lastIdx ? "border-r border-outline-variant/55" : ""
                  }`}
                >
                  <div className="truncate">{placeholderOrValue(field.value)}</div>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
