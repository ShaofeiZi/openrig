// OPR.0.4.6.WF4（C4）—— 基于 GET /api/workflow/list 的实例行（与 WF-3 CLI 投影的同一份读取；
// FR-4 对齐——界面侧零重算，下面每个单元格都是记录字段或后台服务自己派生的截止时间判定）。
//
// 用在两处：Option A（Library spec 页的“本 spec 的运行”条带，按 workflowName 过滤）
// 和 /workflows 高度（不过滤，由调用方分组）。当 `quietWhenEmpty` 时零实例不渲染任何东西——
// 交付的 Library 页保持字节一致（零回归 AC）。

import { Link } from "@tanstack/react-router";
import { cn } from "../../lib/utils.js";
import {
  useWorkflowInstances,
  type WorkflowInstanceWithDeadline,
} from "../../hooks/useWorkflow.js";

/** 待关注优先排序：异常高于健康，运行中高于已完成——在每个高度都是“先看需要你的”阅读序。 */
export function instanceAttentionRank(i: WorkflowInstanceWithDeadline): number {
  if (i.status === "failed") return 0;
  if (i.deadline.state !== "healthy") return 1;
  if (i.status === "waiting") return 2;
  if (i.status === "active") return 3;
  return 4; // 已完成
}

// 截止时间判定状态的中文展示标签（数据枚举保留原值，仅展示层加中文）。
const DEADLINE_STATE_LABEL: Record<string, string> = {
  "overdue-claimed": "逾期·已认领",
  "overdue-unclaimed": "逾期·未认领",
  healthy: "健康",
};

function statusChip(i: WorkflowInstanceWithDeadline): { glyph: string; label: string; cls: string } {
  if (i.status === "failed") return { glyph: "▲", label: "失败", cls: "text-red-700" };
  if (i.deadline.state !== "healthy") return { glyph: "▲", label: DEADLINE_STATE_LABEL[i.deadline.state] ?? i.deadline.state, cls: "text-amber-700" };
  if (i.status === "waiting") return { glyph: "◐", label: "等待中", cls: "text-on-surface-variant" };
  if (i.status === "active") return { glyph: "●", label: "运行中", cls: "text-emerald-800" };
  return { glyph: "○", label: "已完成", cls: "text-on-surface-variant" };
}

function shortUlid(id: string): string {
  return `…${id.slice(-6)}`;
}

function ageLabel(iso: string): string {
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 60) return `${mins}分`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}时`;
  return `${Math.floor(mins / (60 * 24))}天`;
}

/** 记录的实时位置，忠实于列表负载：active/waiting 实例持有持久的 currentStepId 绑定；
 *  终态实例已清空（在哪结束请读实例页上的轨迹）。 */
function positionLabel(i: WorkflowInstanceWithDeadline): string {
  if (i.currentStepId) return `在 ${i.currentStepId}`;
  if (i.status === "completed") return "已关闭";
  if (i.status === "failed") return "已中断";
  return "—";
}

export function WorkflowInstanceRow({ instance }: { instance: WorkflowInstanceWithDeadline }) {
  const chip = statusChip(instance);
  return (
    <li>
      <Link
        to="/workflow/instance/$instanceId"
        params={{ instanceId: instance.instanceId }}
        data-testid={`workflow-instance-row-${instance.instanceId}`}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-surface-variant/50"
      >
        <span className={cn("font-mono text-[11px]", chip.cls)} aria-hidden>
          {chip.glyph}
        </span>
        <span className={cn("font-mono text-[9px] uppercase w-32 shrink-0", chip.cls)}>{chip.label}</span>
        <span className="font-mono text-[11px] text-on-surface" title={instance.instanceId}>
          {shortUlid(instance.instanceId)}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-on-surface">
          {positionLabel(instance)}
          <span className="text-on-surface-variant"> · 跳 {instance.hopCount}</span>
          {instance.resumeCount > 0 ? (
            <span className="text-on-surface-variant"> · 恢复 {instance.resumeCount} 次</span>
          ) : null}
        </span>
        {instance.deadline.state !== "healthy" && instance.deadline.evidence ? (
          <span className="hidden font-mono text-[10px] text-amber-800 md:inline truncate max-w-64">
            {instance.deadline.evidence.ownerSession} · 超期 {Math.floor(instance.deadline.evidence.overdueBySeconds / 60)} 分
          </span>
        ) : null}
        <span className="font-mono text-[10px] text-on-surface-variant">{ageLabel(instance.createdAt)}</span>
        <span className="font-mono text-[10px] text-on-surface-variant" aria-hidden>
          →
        </span>
      </Link>
    </li>
  );
}

/** 选择某 spec 条带显示的实例：name+version 双重判别（仅按名过滤会跨 spec 混版本——守卫 blocker 2）
 *  + 待关注优先排序。纯函数；渲染已在 VM 租约中验证。 */
export function selectSpecInstances(
  rows: readonly WorkflowInstanceWithDeadline[],
  workflowName?: string,
  workflowVersion?: string,
): WorkflowInstanceWithDeadline[] {
  return rows
    .filter((i) => (workflowName ? i.workflowName === workflowName : true))
    .filter((i) => (workflowVersion ? i.workflowVersion === workflowVersion : true))
    .slice()
    .sort((a, b) => instanceAttentionRank(a) - instanceAttentionRank(b));
}

export function WorkflowInstancesBand({
  workflowName,
  workflowVersion,
  testId,
  quietWhenEmpty = true,
}: {
  /** 过滤为某一个 spec 的运行（Option-A spec 页条带）。`workflowVersion` 钉死确切 spec：
   *  两个缓存 spec 可能跨版本同名，而 Library 页是“本 spec 的运行”，因此仅按名过滤会混版本
   *  （守卫 blocker 2）。 */
  workflowName?: string;
  workflowVersion?: string;
  testId?: string;
  /** Option A：无实例时不渲染（零回归）。/workflows 高度传 false 并自管空态。 */
  quietWhenEmpty?: boolean;
}) {
  const { data, isLoading } = useWorkflowInstances();
  const rows = selectSpecInstances(data ?? [], workflowName, workflowVersion);

  if (isLoading || rows.length === 0) {
    if (quietWhenEmpty) return null;
    return (
      <p data-testid={testId ? `${testId}-empty` : undefined} className="font-mono text-[11px] text-on-surface-variant">
        {isLoading ? "正在加载实例…" : "0 个实例——来自 /api/workflow/list"}
      </p>
    );
  }

  const live = rows.filter((r) => r.status === "active" || r.status === "waiting").length;
  const exceptional = rows.filter((r) => instanceAttentionRank(r) <= 1).length;

  return (
    <div data-testid={testId ?? "workflow-instances-band"} className="space-y-2">
      <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-on-surface-variant">
        实例
        <span className="ml-2 normal-case tracking-normal">
          共 {rows.length} 个 · {live} 个运行中{exceptional > 0 ? ` · ${exceptional} 个待关注` : ""}
        </span>
      </div>
      <ul className="divide-y divide-outline-variant/50 border border-outline-variant">
        {rows.map((i) => (
          <WorkflowInstanceRow key={i.instanceId} instance={i} />
        ))}
      </ul>
    </div>
  );
}
