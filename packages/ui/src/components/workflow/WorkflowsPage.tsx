// OPR.0.4.6.WF4（C4）方案 B——工作流运行层级。
//
// 与 /agents 一样通过放大入口寻址（架构漂移终结器 4）：有意不放入任何导航栏；PM/创始人确认
// v1 可寻址但不进导航，因此没有栏图标。可从“需要你处理”工作流行、实例深链接和资料库页面进入。
// 一眼即可回答哪些正在运行、每个实例位于何处、哪些需要关注；按已批准的“需要你处理”优先顺序，
// 注意项排在最前。
//
// FR-4 对等：在客户端基于 WF-3 CLI 用来组合状态汇总的同一组读取
// GET /api/workflow/list 和 /api/workflow/specs 进行组合。commands/workflow.ts 将后台服务汇总
// 端点延后到已命名的未来触发器；本页面只对后台服务已分类的行做算术计算（Q4）。

import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { WorkspacePage } from "../WorkspacePage.js";
import { WorkflowHeader } from "../WorkflowScaffold.js";
import {
  useWorkflowInstances,
  useWorkflowSpecs,
  type WorkflowInstanceWithDeadline,
} from "../../hooks/useWorkflow.js";
import { WorkflowInstanceRow, instanceAttentionRank } from "./WorkflowInstancesBand.js";

function groupByWorkflow(
  rows: WorkflowInstanceWithDeadline[],
): Array<{ key: string; name: string; version: string; rows: WorkflowInstanceWithDeadline[] }> {
  const byKey = new Map<string, WorkflowInstanceWithDeadline[]>();
  for (const r of rows) {
    const key = `${r.workflowName}:${r.workflowVersion}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(r);
  }
  const groups = [...byKey.entries()].map(([key, groupRows]) => ({
    key,
    name: groupRows[0]!.workflowName,
    version: groupRows[0]!.workflowVersion,
    rows: groupRows.sort((a, b) => instanceAttentionRank(a) - instanceAttentionRank(b)),
  }));
  // 组间同样以注意项优先：组的排序由其最紧急行决定。
  groups.sort((a, b) => instanceAttentionRank(a.rows[0]!) - instanceAttentionRank(b.rows[0]!));
  return groups;
}

export function WorkflowsPage() {
  const navigate = useNavigate();
  const { data: instances, isLoading } = useWorkflowInstances();
  const { data: specsData } = useWorkflowSpecs();

  const rows = instances ?? [];
  const groups = groupByWorkflow(rows);
  const attention = rows.filter((r) => instanceAttentionRank(r) <= 1).length;
  const live = rows.filter((r) => r.status === "active" || r.status === "waiting").length;
  const closed = rows.filter((r) => r.status === "completed").length;

  const instantiatedNames = new Set(rows.map((r) => `${r.workflowName}:${r.workflowVersion}`));
  const idleSpecs = (specsData?.specs ?? []).filter((s) => !instantiatedNames.has(`${s.name}:${s.version}`));

  return (
    <WorkspacePage>
      <div data-testid="workflows-page" className="space-y-6">
        <WorkflowHeader
          eyebrow="工作流"
          title="确定性运行"
          description={
            isLoading
              ? "正在加载实例…"
              : `${rows.length} 个实例 · ${attention} 个需要关注 · ${live} 个运行中 · ${closed} 个已完成 —— 由 /api/workflow/list 计算`
          }
          actions={
            <Button variant="outline" size="sm" onClick={() => navigate({ to: "/specs" })}>
              工作流库
            </Button>
          }
        />

        {rows.length === 0 && !isLoading ? (
          <p data-testid="workflows-empty" className="font-mono text-[11px] text-on-surface-variant">
            暂无实例 —— 从库规格实例化一个（zrig workflow instantiate），它会连同其实时位置一起出现在这里。
          </p>
        ) : null}

        {groups.map((g) => {
          const gAttention = g.rows.filter((r) => instanceAttentionRank(r) <= 1).length;
          const gLive = g.rows.filter((r) => r.status === "active" || r.status === "waiting").length;
          return (
            <section key={g.key} data-testid={`workflows-group-${g.name}`} className="space-y-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid={`workflows-group-spec-${g.name}`}
                  onClick={() =>
                    navigate({
                      to: "/specs/library/$entryId",
                      params: { entryId: `workflow:${g.name}:${g.version}` },
                    })
                  }
                  className="font-mono text-[11px] font-bold text-on-surface underline-offset-2 hover:underline"
                >
                  {g.name} v{g.version}
                </button>
                <span className="font-mono text-[10px] text-on-surface-variant">
                  {g.rows.length} 个实例 · {gLive} 个运行中
                  {gAttention > 0 ? ` · ▲ ${gAttention}` : ""}
                </span>
              </div>
              <ul className="divide-y divide-outline-variant/50 border border-outline-variant">
                {g.rows.map((i) => (
                  <WorkflowInstanceRow key={i.instanceId} instance={i} />
                ))}
              </ul>
            </section>
          );
        })}

        {idleSpecs.length > 0 ? (
          <section data-testid="workflows-idle-specs" className="space-y-2">
            <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-on-surface-variant">
              已缓存规格 —— 无实例
            </div>
            <ul className="divide-y divide-outline-variant/50 border border-outline-variant">
              {idleSpecs.map((s) => (
                <li key={`${s.name}:${s.version}`}>
                  <button
                    type="button"
                    data-testid={`workflows-idle-spec-${s.name}`}
                    onClick={() =>
                      navigate({
                        to: "/specs/library/$entryId",
                        params: { entryId: `workflow:${s.name}:${s.version}` },
                      })
                    }
                    className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-surface-variant/50"
                  >
                    <span className="font-mono text-[11px] text-on-surface-variant" aria-hidden>
                      ◌
                    </span>
                    <span className="font-mono text-[11px] text-on-surface">
                      {s.name} v{s.version}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-on-surface-variant">
                      {s.purpose ?? ""}
                    </span>
                    <span className="font-mono text-[10px] text-on-surface-variant">
                      {s.isBuiltIn ? "内置" : "用户文件"} · 0 个实例
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </WorkspacePage>
  );
}
