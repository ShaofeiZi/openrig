// Living Notes 包 2——任务层级（OPR.0.4.4.20 FR-7）。
//
// 看板优先：每个切片在其派生泳道中占据独立槽位（意图、计划、构建、评审、锁定——BR-10
// 词汇），一眼即可看出已完成、进行中和剩余项。U5：看板行原地展开，一次严格只展开一行，
// 并消费按行限定范围的同一组合评审读取契约；只是同一契约多一个使用方，绝不新增第二端点。
// 批准和聊天沿用切片层级的相同动作（BR-9：看板层级没有并行写入器）。完成台账按原文渲染为
// 任务的已定稿信息带，并应用三重切片完成规则。信息带顺序：需要你处理 → 智能体 → 看板 → 已定稿。
// delta-A：任务智能体带在 mission:<id> 范围内紧邻“需要你处理”下方，只显示行和放大入口，绝不
// 嵌入切片页面。40 切片不变量：泳道折叠为数量和需要关注的行；一次点按即可“显示全部”；
// 每个切片始终只有一行。

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  useMissionReview,
  useSliceReview,
  type BoardSlot,
  type ComposedMissionReview,
} from "../../hooks/useReview.js";
import { AgentsBandView } from "./AgentsBandView.js";
import { VerifyLineageCard } from "./VerifyLineageCard.js";
import { approveSlice, sliceScopePath, type ActionOutcome } from "./review-actions.js";
import { buildChatPreamble } from "./chat.js";
import { ProgressiveTerminal } from "../terminal/ProgressiveTerminal.js";
import { useInvalidateReview } from "../../hooks/useReview.js";
import { EmptyState } from "../ui/empty-state.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";
import { cn } from "../../lib/utils.js";
import { VELLUM_CARD } from "./vellum.js";
import { reviewLegLabel, reviewPriorityLabel } from "../project/ProjectMetaPrimitives.js";
import { proofReadinessLabel } from "../../lib/project-mission-state.js";

const LANES = ["INTENT", "PLAN", "BUILD", "REVIEW", "LOCKED"] as const;
const LANE_LABELS: Record<(typeof LANES)[number], string> = {
  INTENT: "意图",
  PLAN: "计划",
  BUILD: "构建",
  REVIEW: "评审",
  LOCKED: "已锁定",
};
const COLLAPSE_THRESHOLD = 12;
const SURFACE_ACTOR = "human@host";

const TONE_CLASS: Record<string, string> = {
  pass: "bg-emerald-100 text-emerald-900 border-emerald-300",
  fail: "bg-red-100 text-red-900 border-red-300",
  unknown: "bg-surface-variant text-on-surface-variant border-outline-variant",
};

/** U5 展开：首先显示意图和已交付/证明，这是任务层级的首要组合；通过切片页面再点一次即可
 * 查看简洁 PRD。操作沿用切片层级的相同动作。 */
function BoardRowExpansion({ slot }: { slot: BoardSlot }) {
  const detail = useSliceReview(slot.slice);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const invalidate = useInvalidateReview();

  if (detail.isLoading) return <p className="p-2 font-mono text-[10px] text-on-surface-variant">正在撰写…</p>;
  if (detail.isError || !detail.data) return <p className="p-2 font-mono text-[10px] text-red-700">展开内容不可用</p>;
  const d = detail.data;
  const chatSession = d.agents.rows[0]?.sessionName ?? null;

  const onApprove = async () => {
    // slice-04 REV6：scope-approve 契约使用相对于 missions 根的
    // <mission>/slices/<slice>；任务看板必须发送组合后的路径。裸切片名会返回 404，因为它不是根切片。
    // 使用共享推导。
    const result = await approveSlice(sliceScopePath(d.missionId, d.slice), SURFACE_ACTOR);
    setOutcome(result);
    if (result.ok) invalidate();
  };

  // 纠偏 §3.1：展开视图读取与切片页签相同的折叠契约，即逐字意图和当前层级下逐项已验证的
  // 已交付摘要。这里保持有界，包含媒体的完整配对位于切片页面。
  const verifiedCounts = d.delivered.items.reduce(
    (acc, it) => ({ ...acc, [it.verified]: (acc[it.verified] ?? 0) + 1 }),
    {} as Record<string, number>,
  );
  return (
    <div data-testid={`board-expansion-${slot.slice}`} className="space-y-2 border-t border-outline-variant/60 bg-surface p-2">
      <div className="min-w-0 border border-outline-variant p-2">
        <h5 className="font-mono text-[10px] uppercase text-on-surface-variant">意图</h5>
        <MarkdownViewer content={d.intent.text ?? d.intent.degrade ?? ""} hideFrontmatter hideRawToggle />
      </div>
      <div className="min-w-0 border border-outline-variant p-2">
        <h5 className="font-mono text-[10px] uppercase text-on-surface-variant">已交付</h5>
        {d.delivered.items.length === 0 ? (
          <p className="font-mono text-[11px] text-on-surface-variant">— 计划尚未声明校验契约</p>
        ) : (
          <>
            <ul className="space-y-0.5">
              {d.delivered.items.map((it, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                  <span className="min-w-0 flex-1">{it.promised.text}</span>
                  <span
                    className={
                      it.verified === "verified"
                        ? "font-mono text-[10px] uppercase text-emerald-700 dark:text-emerald-400"
                        : it.verified === "missing"
                          ? "font-mono text-[10px] font-bold uppercase text-red-700 dark:text-red-400"
                          : "font-mono text-[10px] uppercase text-amber-700 dark:text-amber-400"
                    }
                  >
                    {it.verified === "verified" ? (d.readiness?.configured ? "✓ 已接受" : "✓ 旧版 QA 已校验") : it.verified === "missing" ? "✗ 缺失" : "◇ 未校验"}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-1 font-mono text-[10px] text-on-surface-variant">
              {verifiedCounts["verified"] ?? 0}/{d.delivered.items.length} {d.readiness?.configured ? "已接受" : "旧版 QA 已校验"} · 完整配对见切片页面
            </p>
          </>
        )}
      </div>
      <VerifyLineageCard lineage={d.lineage} />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid={`board-approve-${slot.slice}`}
          onClick={() => void onApprove()}
          className="border border-outline px-3 py-1 font-mono text-[11px] uppercase hover:bg-surface-variant"
        >
          批准
        </button>
        <button
          type="button"
          data-testid={`board-send-back-${slot.slice}`}
          disabled={!chatSession}
          title={chatSession ? `通过 ${chatSession} 退回` : "未解析到归属智能体"}
          onClick={() => setChatOpen((v) => !v)}
          className="border border-outline px-3 py-1 font-mono text-[11px] uppercase hover:bg-surface-variant disabled:opacity-50"
        >
          退回（聊天）
        </button>
        <Link
          to="/project/slice/$sliceId"
          params={{ sliceId: slot.slice }}
          className="font-mono text-[10px] underline text-on-surface-variant"
        >
          完整切片 →
        </Link>
        {outcome ? (
          <span className={`font-mono text-[10px] ${outcome.ok ? "text-emerald-800" : "text-red-700"}`}>{outcome.message}</span>
        ) : null}
      </div>
      {chatOpen && chatSession ? (
        <div className="border border-outline-variant">
          <ProgressiveTerminal
            sessionName={chatSession}
            terminalKey={`board-chat:${slot.slice}`}
            initialText={buildChatPreamble({ sessionName: chatSession, itemRef: slot.slice })}
          />
        </div>
      ) : null}
    </div>
  );
}

function Board({ review }: { review: ComposedMissionReview }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const collapse = review.board.length > COLLAPSE_THRESHOLD && !showAll;
  const laneSlots = LANES.map((lane) => ({ lane, slots: review.board.filter((b) => b.laneLabel === lane) }));
  const emptyLanes = laneSlots.filter(({ slots }) => slots.length === 0).map(({ lane }) => lane);

  return (
    <section data-testid="mission-board" className="space-y-3">
      <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">切片</h3>
      {review.board.length === 0 ? (
        <p data-testid="board-empty" className="font-mono text-[11px] text-on-surface-variant">
          尚无切片
        </p>
      ) : (
        <>
          {emptyLanes.length > 0 ? (
            <p data-testid="board-empty-lanes" className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant">
              {emptyLanes.map((lane) => `${LANE_LABELS[lane]} 0`).join(" · ")}
            </p>
          ) : null}
          {laneSlots.filter(({ slots }) => slots.length > 0).map(({ lane, slots }) => {
          const visible = collapse ? slots.filter((s) => s.attentionWorthy) : slots;
          const hidden = slots.length - visible.length;
          return (
            <section key={lane} data-testid={`board-lane-card-${lane}`} className={cn(VELLUM_CARD, "overflow-hidden")}>
              <div data-testid={`board-lane-header-${lane}`} className="flex items-center gap-2 px-2 py-1.5">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-wide text-on-surface">{LANE_LABELS[lane]}</span>
                <span className="rounded-full border border-outline-variant px-1.5 font-mono text-[9px] text-on-surface-variant">{slots.length}</span>
                {collapse && hidden > 0 ? (
                  <span className="font-mono text-[9px] text-on-surface-variant">（已折叠 {hidden} 项）</span>
                ) : null}
              </div>
              <ul className="divide-y divide-outline-variant/40 border-t border-outline-variant">
                {visible.map((slot) => (
                  <li key={slot.slice}>
                    <div className="flex w-full flex-wrap items-center gap-2 px-2 py-1.5 hover:bg-surface-variant/50">
                      <button
                        type="button"
                        data-testid={`board-row-${slot.slice}`}
                        onClick={() => setExpanded((cur) => (cur === slot.slice ? null : slot.slice))}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <span className="min-w-0 flex-1 truncate text-[12px]">{slot.title}</span>
                        {slot.attentionWorthy ? <span className="text-amber-700">▲</span> : null}
                        {slot.changedSinceStamp ? (
                          <span className="font-mono text-[9px] uppercase text-amber-800">已变更</span>
                        ) : null}
                        <span className="font-mono text-[10px] text-on-surface-variant">{slot.stageCell}</span>
                      </button>
                      {/* OPR.0.4.4.22 FR-5: the board agent-count chip is a
                          front door — zooms to the AGENTS altitude at rig
                          scope, as a sibling control so the row expansion
                          button keeps valid interactive markup. */}
                      <a
                        href="/agents"
                        data-testid={`board-agents-zoom-${slot.slice}`}
                        className="font-mono text-[10px] text-on-surface-variant underline-offset-2 hover:underline"
                        title="缩放到智能体高度（工作组范围）"
                      >
                        智能体 {slot.agentsCount}
                      </a>
                    </div>
                    {expanded === slot.slice ? <BoardRowExpansion slot={slot} /> : null}
                  </li>
                ))}
              </ul>
            </section>
          );
          })}
        </>
      )}
      {review.board.length > COLLAPSE_THRESHOLD ? (
        <button
          type="button"
          data-testid="board-show-all"
          onClick={() => setShowAll((v) => !v)}
          className="font-mono text-[10px] underline text-on-surface-variant"
        >
          {showAll ? "仅显示需关注项" : `显示全部 ${review.board.length} 个切片`}
        </button>
      ) : null}
    </section>
  );
}

function Ledger({ review }: { review: ComposedMissionReview }) {
  return (
    <section data-testid="mission-ledger" className={cn(VELLUM_CARD, "overflow-hidden")}>
      <div data-testid="ledger-header" className="flex flex-wrap items-center justify-between gap-2 border-b border-outline-variant px-3 py-2">
        <div>
          <h3 className="font-mono text-[10px] font-semibold uppercase tracking-wide text-on-surface">已定稿</h3>
          <p className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant">完成台账</p>
        </div>
        <p
          data-testid="cut-complete"
          className={`border px-2 py-1 font-mono text-[10px] ${review.cutComplete ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-outline-variant text-on-surface-variant"}`}
        >
          交付门控 {review.cutComplete ? "完成" : "未完成"} —— {review.cutCompleteBasis}
        </p>
      </div>
      <div className="overflow-x-auto px-3 pb-3">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="border-b border-outline-variant font-mono text-[10px] uppercase text-on-surface-variant">
              <th className="py-1 pr-2 text-left">切片</th>
              <th className="py-1 pr-2 text-left">候选版本</th>
              <th className="py-1 pr-2 text-left">门控</th>
              <th className="py-1 pr-2 text-left">合并版本</th>
              <th className="py-1 text-left">需人工处理</th>
            </tr>
          </thead>
          <tbody>
            {review.ledger.map((row) => (
              <tr key={row.slice} data-testid={`ledger-row-${row.slice}`} className="border-b border-outline-variant/50">
                <td className="py-1 pr-2">{row.slice}</td>
                <td className="py-1 pr-2 font-mono">{row.candidateSha ?? "未知"}</td>
                <td className="py-1 pr-2">
                  <span className="flex flex-wrap gap-1">
                    {row.gateCells.map((c) => (
                      <span key={c.role} className={`border px-1 font-mono text-[9px] ${TONE_CLASS[c.tone]}`}>
                        {c.role}:{c.recordedToken ?? "缺失"}
                      </span>
                    ))}
                  </span>
                </td>
                <td className="py-1 pr-2 font-mono">{row.mergeSha ?? "未知"}</td>
                <td className="py-1 font-mono">{row.needsHumanCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function MissionReviewTab({ missionId }: { missionId: string }) {
  const review = useMissionReview(missionId);

  if (review.isLoading) {
    return <EmptyState label="正在撰写" description={`正在为 ${missionId} 撰写任务评审…`} variant="card" testId="mission-review-loading" />;
  }
  if (review.isError || !review.data) {
    return (
      <EmptyState
        label="评审不可用"
        description={review.error instanceof Error ? review.error.message : "评审撰写器无法为此任务生成评审。"}
        variant="card"
        testId="mission-review-error"
      />
    );
  }
  const data = review.data;

  return (
    <div data-testid="mission-review-tab" className="space-y-5">
      {data.readiness && <p role="status" data-testid="proof-readiness">校验就绪：{review.updatesUnavailable ? "源更新不可用；最后确认状态 " + proofReadinessLabel(data.readiness.state) : review.basisInvalidated ? "检测到变更；正在确认当前依据" : proofReadinessLabel(data.readiness.state)} · 最后确认 {data.readiness.revision.slice(0, 12)} · 发布是独立动作</p>}
      {/* FR-8: the brief's What & why — the founder's words, verbatim, never edited. */}
      {data.intent ? (
        <section data-testid="mission-intent" className="border border-outline-variant p-3">
          <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">内容与原因</h3>
          <MarkdownViewer content={data.intent} hideFrontmatter hideRawToggle />
        </section>
      ) : null}

      {/* Mission NEEDS YOU — the union query, COMPACT one-line rows only
          (never full cards at this altitude); each row deep-links into the
          slice Review tab anchored at the item. */}
      <section data-testid="mission-needs-you" className="space-y-1">
        <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">需要你处理</h3>
        {data.needsYou.items.length === 0 ? (
          <p className="font-mono text-[11px] text-on-surface-variant">{data.needsYou.provenance}</p>
        ) : (
          <ul className="divide-y divide-outline-variant/50 border border-outline-variant">
            {data.needsYou.items.map((item) => {
              const sliceName = item.where.includes("/slices/") ? item.where.split("/slices/")[1] : null;
              const inner = (
                <span className="flex w-full items-center gap-2 px-2 py-1.5">
                  <span className={item.source === "derived" ? "text-amber-700" : "text-on-surface"}>{item.source === "derived" ? "▲" : "●"}</span>
                  {sliceName ? (
                    <span className="shrink-0 font-mono text-[10px] text-on-surface-variant">{sliceName}</span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-[12px]">{item.summary}</span>
                  <span className="hidden font-mono text-[10px] text-on-surface-variant sm:inline">{reviewLegLabel(item.leg)}</span>
                  {item.priority ? <span className="font-mono text-[10px] uppercase">{reviewPriorityLabel(item.priority)}</span> : null}
                </span>
              );
              return (
                <li key={item.identity}>
                  {sliceName ? (
                    <Link
                      to="/project/slice/$sliceId"
                      params={{ sliceId: sliceName }}
                      hash={`needs-you-${item.identity}`}
                      className="block hover:bg-surface-variant/50"
                      data-testid={`mission-needs-you-${item.identity}`}
                    >
                      {inner}
                    </Link>
                  ) : (
                    inner
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Delta-A: the mission AGENTS band, directly below NEEDS YOU, at
          mission:<id> scope — rows + zoom only, never embedded slice pages. */}
      <div data-testid="mission-agents-preview">
        <AgentsBandView band={data.agents} itemRef={data.mission} previewLimit={6} />
      </div>

      <Board review={data} />
      <Ledger review={data} />
    </div>
  );
}
