// Slice Story View v0——决策标签页。
//
// 触及本 slice 的 qitem 链路的每一行操作者驱动的 mission_control_actions，按线性时间排列。
// 过滤控件：按 verb、按 actor、按 reason / verb / qitem 的自由文本搜索。
// 操作者点击某行钻取——展开前后状态快照的 JSON，用于取证重建。

import { useMemo, useState } from "react";
import type { DecisionRow } from "../../../hooks/useSlices.js";

export function DecisionsTab({ rows }: { rows: DecisionRow[] }) {
  const [verbFilter, setVerbFilter] = useState<string>("all");
  const [actorFilter, setActorFilter] = useState<string>("all");
  const [search, setSearch] = useState<string>("");

  const verbs = useMemo(() => {
    const set = new Set(rows.map((r) => r.verb));
    return ["all", ...Array.from(set).sort()];
  }, [rows]);

  const actors = useMemo(() => {
    const set = new Set(rows.map((r) => r.actor));
    return ["all", ...Array.from(set).sort()];
  }, [rows]);

  const filtered = useMemo(() => {
    const lower = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (verbFilter !== "all" && r.verb !== verbFilter) return false;
      if (actorFilter !== "all" && r.actor !== actorFilter) return false;
      if (!lower) return true;
      return (
        r.verb.toLowerCase().includes(lower) ||
        r.qitemId.toLowerCase().includes(lower) ||
        (r.reason ?? "").toLowerCase().includes(lower)
      );
    });
  }, [rows, verbFilter, actorFilter, search]);

  if (rows.length === 0) {
    return <div className="p-4 font-mono text-[10px] text-on-surface-variant" data-testid="decisions-empty">此切片的 qitem 链路上未找到 mission_control_actions 行。</div>;
  }

  return (
    <div data-testid="decisions-tab" className="flex h-full flex-col">
      <div className="flex flex-wrap gap-2 border-b border-outline-variant bg-background p-3" data-testid="decisions-filters">
        <select
          data-testid="decisions-verb-filter"
          value={verbFilter}
          onChange={(e) => setVerbFilter(e.target.value)}
          className="border border-outline-variant bg-surface-lowest px-2 py-1 font-mono text-[10px]"
        >
          {verbs.map((v) => (<option key={v} value={v}>{v}</option>))}
        </select>
        <select
          data-testid="decisions-actor-filter"
          value={actorFilter}
          onChange={(e) => setActorFilter(e.target.value)}
          className="border border-outline-variant bg-surface-lowest px-2 py-1 font-mono text-[10px]"
        >
          {actors.map((a) => (<option key={a} value={a}>{a}</option>))}
        </select>
        <input
          data-testid="decisions-search"
          type="text"
          placeholder="搜索 verb / qitem / reason"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-32 border border-outline-variant bg-surface-lowest px-2 py-1 font-mono text-[10px]"
        />
        <span className="font-mono text-[10px] text-on-surface-variant" data-testid="decisions-result-count">
          {filtered.length} / {rows.length}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto" data-testid="decisions-list">
        {filtered.map((row) => (<DecisionRowItem key={row.actionId} row={row} />))}
      </div>
    </div>
  );
}

function DecisionRowItem({ row }: { row: DecisionRow }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border-b border-outline-variant px-4 py-2 hover:bg-background">
      <button
        type="button"
        data-testid={`decision-row-${row.actionId}`}
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left"
      >
        <div className="flex items-center gap-2">
          <span className="font-mono text-[9px] text-on-surface-variant shrink-0">{row.ts.slice(0, 19)}</span>
          <span className="font-mono text-[10px] font-bold text-on-surface shrink-0">{row.verb}</span>
          <span className="font-mono text-[9px] text-on-surface-variant shrink-0">{row.actor}</span>
          <span className="font-mono text-[9px] text-on-surface-variant truncate">{row.qitemId}</span>
        </div>
        {row.reason && (
          <div className="ml-[120px] font-mono text-[10px] text-on-surface">{row.reason}</div>
        )}
      </button>
      {expanded && (
        <div className="ml-[120px] mt-1 grid grid-cols-2 gap-2" data-testid={`decision-row-detail-${row.actionId}`}>
          <pre className="overflow-x-auto bg-background p-2 font-mono text-[9px] text-on-surface">
            <div className="text-on-surface-variant">之前：</div>
            {row.beforeState ?? "null"}
          </pre>
          <pre className="overflow-x-auto bg-background p-2 font-mono text-[9px] text-on-surface">
            <div className="text-on-surface-variant">之后：</div>
            {row.afterState ?? "null"}
          </pre>
        </div>
      )}
    </div>
  );
}
