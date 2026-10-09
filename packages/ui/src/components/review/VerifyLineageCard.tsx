// Living Notes Packet 2 —— 校验血缘卡片（OPR.0.4.4.20 FR-2 / SS14）。
//
// 从内联条提升为独立的有界卡片。N1 规则：三个渲染时事实
// （验证于 SHA · 合并于或未合并 · 当前尖端）始终渲染；新鲜/过期标签是已展示事实的
// 推导，绝不单独出现。G1 规则：每个门控 chip 逐字渲染记录的 token
// （CONCERNING 绝不渲染成 FAIL），色调单独推导。

import type { VerifyLineage } from "../../hooks/useReview.js";
import { cn } from "../../lib/utils.js";
import { VELLUM_CARD } from "./vellum.js";

const TONE_CLASS: Record<string, string> = {
  pass: "bg-emerald-100 text-emerald-900 border-emerald-300",
  fail: "bg-red-100 text-red-900 border-red-300",
  unknown: "bg-surface-variant text-on-surface-variant border-outline-variant",
};

const FRESHNESS_LABEL: Record<string, string> = {
  fresh: "新鲜",
  stale: "过期",
  unknown: "未知",
};

// CORRECTIVE §11 —— 单独的绿色读数已移除；记录判定的严谨度现在喂给
// DELIVERED 中逐交付物的 `verified`。
export function VerifyLineageCard({ lineage }: { lineage: VerifyLineage }) {
  return (
    <section data-testid="verify-lineage-card" className={cn(VELLUM_CARD, "p-3 space-y-2")}>
      <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">校验血缘</h3>
      <p className="font-mono text-[11px] break-all">
        验证于 <code>{lineage.candidateSha ?? "未知"}</code>
        {" · "}合并于 <code>{lineage.mergeSha ?? "未合并"}</code>
        {" · "}main 尖端 <code>{lineage.mainTip}</code>
        {" · "}
        <span data-testid="lineage-freshness">
          新鲜度 {FRESHNESS_LABEL[lineage.freshness] ?? lineage.freshness}
          {lineage.staleBehind !== null ? `（落后 ${lineage.staleBehind}）` : ""}
        </span>
      </p>
      <div className="flex flex-wrap gap-1" data-testid="lineage-gate-cells">
        {lineage.gateCells.map((cell) => (
          <span
            key={cell.role}
            data-testid={`gate-cell-${cell.role}`}
            title={cell.source ?? "无制品"}
            className={`border px-1.5 py-0.5 font-mono text-[10px] ${TONE_CLASS[cell.tone]}`}
          >
            {cell.role}: {cell.recordedToken ?? "缺失"}
          </span>
        ))}
      </div>
    </section>
  );
}
