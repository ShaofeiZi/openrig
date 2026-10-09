// V0.3.1 切片 13.5 mission-progress-artifacts-heatmap。
//
// 任务范围进度标签页差异化：在现有 PROGRESS.md markdown + 每切片汇总
// 上方渲染切片 × 验收单元格热力图。切片 13.5 之前，任务进度 + 工件标签页
// 都使用相同的 4 单元格指标网格原语形状，一眼望去太相似。热力图给进度
// 自己的视觉格式塔，不触碰工件。
//
// 单元格语义：每切片一行；该切片 PROGRESS.md 清单中每个验收项一个单元格。
// 填充（success 令牌）= 已完成；轮廓（outline-variant）= 未完成。
// 前导列是切片显示名 + 状态药丸；尾随列是（已完成/总数）计数 + 百分比。
//
// 为什么切片 × 验收而非切片 × 阶段：验收项是操作者已在 PROGRESS.md 中
// 每切片编写的持久进度单元。阶段绑定到 workflow_spec，仅部分切片有。
// 验收项对每个切片都有效。
//
// 所有颜色通过共享 slice-status 色调 + status-dot 类映射从现有
// DESIGN.md 状态令牌派生；无新颜色系统。

import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { EmptyState } from "../ui/empty-state.js";
import { ProjectPill } from "./ProjectMetaPrimitives.js";
import {
  type ProjectMetaTone,
  sliceStatusLabel,
  sliceStatusTone,
  statusDotClass,
} from "./ProjectMetaPrimitives.js";
import type { SliceDetail } from "../../hooks/useSlices.js";
import type { SliceListEntry } from "../../hooks/useSlices.js";

/** 热力图单元格和图例都使用的解析规则，使图例色块类名始终与单元格
 *  渲染的字符串完全相同。色调的纯函数；无副作用。 */
function doneCellClass(tone: ProjectMetaTone): string {
  return statusDotClass[tone === "neutral" ? "success" : tone];
}

interface HeatmapRow {
  /** 切片 id（用于钻取链接目标）。 */
  name: string;
  /** 前导列中显示的名称。 */
  displayName: string;
  /** 切片状态（"active" | "done" | "blocked" | "draft"）；驱动前导列中的
   *  状态药丸 + 已阻塞/危险切片已完成单元格的隐含色调
   *（使已阻塞切片的"已完成"单元格读为警告色调而非成功色调）。 */
  status: string;
  /** PROGRESS.md 顺序的验收项。切片尚未编写 PROGRESS.md 时可为空。 */
  items: { text: string; done: boolean }[];
  /** 尾随列中显示的预计算总数。 */
  doneItems: number;
  totalItems: number;
  /** 验收百分比（0-100），由后台服务路由预计算。 */
  percentage: number;
}

export function MissionProgressHeatmap({
  rows,
  detailsByName,
  isLoading,
}: {
  rows: SliceListEntry[];
  detailsByName: Map<string, SliceDetail>;
  isLoading?: boolean;
}) {
  const heatmapRows: HeatmapRow[] = rows.map((row) => {
    const detail = detailsByName.get(row.name);
    const acceptance = detail?.acceptance;
    return {
      name: row.name,
      displayName: row.displayName,
      status: row.status,
      items: acceptance?.items ?? [],
      doneItems: acceptance?.doneItems ?? 0,
      totalItems: acceptance?.totalItems ?? 0,
      percentage: acceptance?.percentage ?? 0,
    };
  });

  if (isLoading && heatmapRows.length === 0) {
    return (
      <EmptyState
        label="正在加载进度"
        description="正在读取任务切片验收。"
        variant="card"
        testId="mission-progress-heatmap-loading"
      />
    );
  }

  if (heatmapRows.length === 0) {
    return (
      <EmptyState
        label="无任务切片"
        description="任务无范围切片可渲染热力图。"
        variant="card"
        testId="mission-progress-heatmap-empty"
      />
    );
  }

  return (
    <section
      data-testid="mission-progress-heatmap"
      className="border border-outline-variant bg-surface-lowest/35 p-4 backdrop-blur-sm"
    >
      <header className="mb-3 flex items-center justify-between gap-3 border-b border-outline-variant pb-2">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.16em] text-on-surface">
          验收热力图
        </h3>
        <span className="font-mono text-[10px] text-on-surface-variant">
          {heatmapRows.length} 个切片 ·
          {" "}
          每个验收项一格
        </span>
      </header>
      <div className="space-y-2">
        {heatmapRows.map((row) => (
          <HeatmapSliceRow key={row.name} row={row} />
        ))}
      </div>
      <HeatmapLegend />
    </section>
  );
}

function HeatmapSliceRow({ row }: { row: HeatmapRow }) {
  const tone = sliceStatusTone(row.status);
  return (
    <article
      data-testid={`mission-progress-heatmap-row-${row.name}`}
      data-status={row.status}
      data-tone={tone}
      className="grid grid-cols-[minmax(8rem,16rem)_1fr_auto] items-center gap-3"
    >
      <div className="min-w-0 space-y-1">
        <Link
          to="/project/slice/$sliceId"
          params={{ sliceId: row.name }}
          className="block truncate font-mono text-[11px] uppercase tracking-[0.12em] text-on-surface hover:underline"
          title={row.displayName}
          aria-label={`${row.displayName}（${row.doneItems}/${row.totalItems} 个验收项）`}
        >
          {row.displayName}
        </Link>
        <ProjectPill token={{ label: sliceStatusLabel(row.status), tone }} compact />
      </div>
      <Cells row={row} />
      <div className="font-mono text-[10px] text-on-surface tabular-nums whitespace-nowrap">
        {row.doneItems}/{row.totalItems || 0}
        {row.totalItems > 0 ? ` (${row.percentage}%)` : ""}
      </div>
    </article>
  );
}

function Cells({ row }: { row: HeatmapRow }) {
  if (row.items.length === 0) {
    return (
      <div
        data-testid={`mission-progress-heatmap-cells-${row.name}`}
        data-cell-state="empty"
        className="font-mono text-[10px] italic text-on-surface-variant"
      >
        尚未声明验收项。
      </div>
    );
  }
  const tone = sliceStatusTone(row.status);
  // 已完成单元格采用切片的状态色调（active 为 info、done 为 success、
  // blocked 为 danger 等），使热力图一眼可读单元格 + 行。
  // 未完成单元格仅保留轮廓，使眼睛快速找到未完成工作。
  const doneClass = doneCellClass(tone);
  return (
    <div
      data-testid={`mission-progress-heatmap-cells-${row.name}`}
      className="flex flex-wrap gap-[3px]"
    >
      {row.items.map((item, idx) => (
        <span
          key={idx}
          data-testid={`mission-progress-heatmap-cell-${row.name}-${idx}`}
          data-done={item.done ? "true" : "false"}
          aria-label={`${item.text}（${item.done ? "已完成" : "未完成"}）`}
          title={item.text}
          className={
            item.done
              ? `h-4 w-4 border ${doneClass}`
              : "h-4 w-4 border border-outline-variant bg-surface-lowest/35"
          }
        />
      ))}
    </div>
  );
}

function HeatmapLegend() {
  // 图例色块必须使用与单元格对给定色调渲染的相同类名字符串。
  // doneCellClass() 是唯一事实来源；图例仅将热力图为每个状态关键字
  // 解析的相同色调喂给它。
  return (
    <footer
      data-testid="mission-progress-heatmap-legend"
      className="mt-3 flex flex-wrap items-center gap-3 border-t border-outline-variant pt-2 font-mono text-[10px] text-on-surface-variant"
    >
      <LegendCell label="已完成（进行中）" tone="info" testId="legend-active" />
      <LegendCell label="已完成（完成）" tone="success" testId="legend-complete" />
      <LegendCell label="已完成（警告）" tone="warning" testId="legend-warning" />
      <LegendCell label="已完成（已阻塞）" tone="danger" testId="legend-blocked" />
      <LegendCell label="未完成" notDone testId="legend-not-done" />
    </footer>
  );
}

function LegendCell({
  label,
  tone,
  notDone,
  testId,
}: {
  label: string;
  tone?: ProjectMetaTone;
  notDone?: boolean;
  testId: string;
}): ReactNode {
  const swatchClass = notDone
    ? "border-outline-variant bg-surface-lowest/35"
    : doneCellClass(tone!);
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        data-testid={`mission-progress-heatmap-${testId}`}
        className={`inline-block h-3 w-3 border ${swatchClass}`}
      />
      <span>{label}</span>
    </span>
  );
}
