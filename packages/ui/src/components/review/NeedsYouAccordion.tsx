// Living Notes 包 2——“需要你处理”（OPR.0.4.4.20 FR-4，已批准 U3/U3a）。
//
// 按优先级排序的手风琴：单行包含 {summary, leg, where, age, priority}，并使用两类来源图标：
// ● 表示智能体发起（包括制度 2 的忠实确认），▲ 表示机器派生。每条 ▲ 行都会行内展示自身证据和
// 越过的阈值；没有证据就没有例外。严格只有一行可原地展开为完整卡片，其中包含证据以及创始人
// 指定的两个操作：批准和聊天（SS14）。拒绝、路由、决策框已不再作为按钮，其写入路径改走
// 聊天后由智能体记录。经证明为空时渲染 U4 来源行，绝不留下空白信息带。

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { cn } from "../../lib/utils.js";
import { VELLUM_CARD } from "./vellum.js";
import type { NeedsYouBand, NeedsYouItem } from "../../hooks/useReview.js";
import { EvidenceOpener, type EvidenceContext } from "./EvidenceOpener.js";
import { approveSlice, sliceScopePath, type ActionOutcome } from "./review-actions.js";
import { buildChatPreamble } from "./chat.js";
import { ProgressiveTerminal } from "../terminal/ProgressiveTerminal.js";
import { useInvalidateReview } from "../../hooks/useReview.js";
import { reviewLegLabel, reviewPriorityLabel } from "../project/ProjectMetaPrimitives.js";

function ageLabel(iso: string | null): string {
  if (!iso) return "—";
  const mins = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60_000));
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / (60 * 24))}d`;
}

function ExpandedCard({
  item,
  slice,
  missionId,
  actorSession,
  ctx,
  showApprove = true,
}: {
  item: NeedsYouItem;
  slice: string;
  missionId: string | null;
  actorSession: string;
  ctx: EvidenceContext;
  showApprove?: boolean;
}) {
  const [chatOpen, setChatOpen] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);
  const invalidate = useInvalidateReview();

  const chatSession = item.destinationSession;
  const itemRef = item.qitemId ? `${slice} ${item.qitemId}` : slice;

  const onApprove = async () => {
    // 批准映射到 FAITHFUL，即切片终态批准动作/裁定语义；FR-2 写路径不变，绝不生成合成 qitem。
    // slice-04 REV6：共享推导——发送相对于 missions 根的 <mission>/slices/<slice>；
    // 只有 missionId 为 null 的旧版根切片才发送裸名称。
    const result = await approveSlice(sliceScopePath(missionId, slice), actorSession);
    setOutcome(result);
    if (result.ok) invalidate(); // rows must actually LEAVE the band (FR-4)
  };

  return (
    <div data-testid={`needs-you-expanded-${item.identity}`} className="space-y-2 border-t border-outline-variant/50 p-2">
      {item.derived ? (
        <p data-testid="derived-evidence" className="font-mono text-[10px] text-amber-800">
          ▲ {item.derived.evidence} · 阈值：{item.derived.threshold}
        </p>
      ) : null}
      {/* OPR.0.4.6.WF4 FR-3 — the WEB DESTINATION for workflow-sourced rows. The
          join is the Q6 structured `item.workflow` pointer ONLY (stamped
          daemon-side) — NEVER prose from identity/evidenceRef/summary (the
          anti-prose rule; P3 test). The ?step= anchor opens the gated/failed
          step. Absent on non-workflow rows → renders nothing. */}
      {item.workflow ? (
        <Link
          to="/workflow/instance/$instanceId"
          params={{ instanceId: item.workflow.instanceId }}
          search={item.workflow.stepId ? { step: item.workflow.stepId } : {}}
          data-testid={`needs-you-workflow-link-${item.identity}`}
          className="inline-block border border-outline px-3 py-1 font-mono text-[11px] uppercase hover:bg-surface-variant"
        >
          查看实例 →
        </Link>
      ) : null}
      {item.evidenceRef ? (
        <div>
          <span className="font-mono text-[10px] uppercase text-on-surface-variant">证据：</span>
          <EvidenceOpener evidenceRef={item.evidenceRef} ctx={ctx} testId={`needs-you-evidence-${item.identity}`} />
        </div>
      ) : null}
      {item.unblocks ? (
        <p className="font-mono text-[10px] text-on-surface-variant">解除阻塞：{item.unblocks}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {showApprove ? (
          <button
            type="button"
            data-testid="needs-you-approve"
            onClick={() => void onApprove()}
            className="border border-outline px-3 py-1 font-mono text-[11px] uppercase hover:bg-surface-variant"
          >
            批准
          </button>
        ) : null}
        <button
          type="button"
          data-testid="needs-you-chat"
          disabled={!chatSession}
          title={chatSession ? `在终端与 ${chatSession} 对话` : "未为此项解析到归属智能体会话"}
          onClick={() => setChatOpen((v) => !v)}
          className="border border-outline px-3 py-1 font-mono text-[11px] uppercase hover:bg-surface-variant disabled:cursor-not-allowed disabled:opacity-50"
        >
          聊天
        </button>
        {outcome ? (
          <span data-testid="action-outcome" className={`font-mono text-[10px] ${outcome.ok ? "text-emerald-800" : "text-red-700"}`}>
            {outcome.message}
          </span>
        ) : null}
      </div>
      {chatOpen && chatSession ? (
        // BR-12：聊天就是现有终端组件族，直接进入交互，并预填一个不含 Enter 的文本帧。
        // 不存在聊天面板。
        <div className="border border-outline-variant" data-testid="needs-you-chat-terminal">
          <ProgressiveTerminal
            sessionName={chatSession}
            terminalKey={`review-chat:${item.identity}`}
            initialText={buildChatPreamble({ sessionName: chatSession, itemRef })}
          />
        </div>
      ) : null}
    </div>
  );
}

export function NeedsYouAccordion({
  band,
  slice,
  missionId,
  actorSession,
  ctx,
  anchorIdentity,
  showApprove = true,
}: {
  band: NeedsYouBand;
  slice: string;
  /** slice-04 REV6——切片所属任务；旧版根切片为 null。用于通过 sliceScopePath 组合相对于
   * missions 根的批准 scopePath。 */
  missionId: string | null;
  actorSession: string;
  ctx: EvidenceContext;
  /** FR-9 深链接：加载时自动展开此身份。 */
  anchorIdentity?: string | null;
  /** OPR.0.4.4.22——批准是切片终态操作；工作组层级会隐藏它，需放大进入切片后批准，
   * 不在当前层级行内处理。扩展只位于这一归属位置；P2 页面保持默认 true。 */
  showApprove?: boolean;
}) {
  const [expanded, setExpanded] = useState<string | null>(anchorIdentity ?? null);

  return (
    <section data-testid="needs-you-band" className={cn(VELLUM_CARD, "space-y-1 p-2")}>
      <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">需要你处理</h3>
      {band.items.length === 0 ? (
        <p data-testid="needs-you-empty" className="font-mono text-[11px] text-on-surface-variant">
          {band.provenance}
        </p>
      ) : (
        <ul className="divide-y divide-outline-variant/50 border border-outline-variant">
          {band.items.map((item) => (
            <li key={item.identity} id={`needs-you-${item.identity}`}>
              <button
                type="button"
                data-testid={`needs-you-row-${item.identity}`}
                onClick={() => setExpanded((cur) => (cur === item.identity ? null : item.identity))}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-surface-variant/50"
              >
                <span className={item.source === "derived" ? "text-amber-700" : "text-on-surface"} aria-hidden>
                  {item.source === "derived" ? "▲" : "●"}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px]">{item.summary}</span>
                <span className="hidden font-mono text-[10px] text-on-surface-variant sm:inline">{reviewLegLabel(item.leg)}</span>
                <span className="hidden font-mono text-[10px] text-on-surface-variant md:inline truncate max-w-32">{item.where}</span>
                <span className="font-mono text-[10px] text-on-surface-variant">{ageLabel(item.ageIso)}</span>
                {item.priority ? <span className="font-mono text-[10px] uppercase">{reviewPriorityLabel(item.priority)}</span> : null}
              </button>
              {expanded === item.identity ? (
                <ExpandedCard item={item} slice={slice} missionId={missionId} actorSession={actorSession} ctx={ctx} showApprove={showApprove} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {band.items.length > 0 ? (
        <p className="font-mono text-[10px] text-on-surface-variant">{band.provenance}</p>
      ) : null}
    </section>
  );
}
