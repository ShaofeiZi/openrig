// V0.3.1 slice 25 第二次后续——cwd + 当前工作区。
//
// 与上方 SeatOverviewTable 在视觉上分隔开。把两个"宽"字段渲染成
// 独立区块里的"标签-值"行，让眼睛能把它们和密集列表区分开。
//
// 数据来源（与原全宽行相同的 NodeDetailData 字段）：
//   - cwd —— data.cwd
//   - 当前工作 —— data.currentQitems[0]；渲染为 qitemId + 正文摘录；
//     无进行中的 qitem 时用破折号占位
//
// CWD 值带 `title={cwd}`，这样值单元格被截断时悬停可看到完整路径。

import type { ReactNode } from "react";
import type { NodeDetailData } from "../hooks/useNodeDetail.js";

interface SeatOverviewSecondaryProps {
  data: NodeDetailData;
}

function placeholderOrValue(value: ReactNode | null | undefined): ReactNode {
  if (value === null || value === undefined) return <span className="text-on-surface-variant">—</span>;
  if (typeof value === "string" && value.trim() === "") return <span className="text-on-surface-variant">—</span>;
  return value;
}

export function SeatOverviewSecondary({ data }: SeatOverviewSecondaryProps) {
  const currentQitem = data.currentQitems?.[0] ?? null;
  const currentWorkValue: ReactNode | null = currentQitem ? (
    <span className="flex min-w-0 items-baseline gap-2">
      <span className="shrink-0 font-mono text-[10px] text-on-surface-variant">
        {currentQitem.qitemId}
      </span>
      <span className="min-w-0 truncate text-[11px] text-on-surface">
        {currentQitem.bodyExcerpt}
      </span>
    </span>
  ) : null;

  return (
    <section
      data-testid="seat-overview-secondary"
      className="border border-outline-variant bg-surface-lowest/30"
    >
      <dl className="divide-y divide-outline-variant/55">
        <Row
          fieldKey="cwd"
          label="cwd"
          value={data.cwd}
          mono
          titleAttr={data.cwd ?? undefined}
        />
        <Row
          fieldKey="current-work"
          label="当前工作"
          value={currentWorkValue}
        />
      </dl>
    </section>
  );
}

function Row({
  fieldKey,
  label,
  value,
  mono,
  titleAttr,
}: {
  fieldKey: string;
  label: string;
  value: ReactNode | null | undefined;
  mono?: boolean;
  titleAttr?: string;
}) {
  return (
    <div
      data-testid={`seat-overview-secondary-row-${fieldKey}`}
      className="flex min-w-0 items-baseline gap-3 px-3 py-1.5"
      title={titleAttr}
    >
      <dt className="shrink-0 font-mono text-[10px] lowercase tracking-[0.04em] text-on-surface-variant">
        {label}
      </dt>
      <dd
        data-testid={`seat-overview-secondary-cell-${fieldKey}`}
        className={`min-w-0 flex-1 truncate ${
          mono ? "font-mono text-[11px]" : "text-[11px]"
        } text-on-surface`}
      >
        {placeholderOrValue(value)}
      </dd>
    </div>
  );
}
