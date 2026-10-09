// V1 attempt-3 Phase 4 —— 依 content-drawer.md L46–L82 的 QueueItemViewer。
//
// 渲染 qitem 头部（id + 关闭 + 居中打开）+ 元数据（source/
// dest/state/tags/created）+ 正文预览（约 30 行 + 显示全文）
// + Related（可点击引用）。

import { useState } from "react";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { ActorChip, DateChip, FlowChips, QueueStateBadge, TagPill } from "../project/ProjectMetaPrimitives.js";
import { ToolMark } from "../graphics/RuntimeMark.js";

export interface QueueItemViewerData {
  qitemId: string;
  source?: string;
  destination?: string;
  state?: string;
  tags?: string[];
  createdAt?: string;
  body?: string;
  related?: Array<{ kind: "file" | "commit" | "slice" | "seat"; label: string; href?: string }>;
  // OPR.0.4.1.19 —— Tier-3 抽屉 = 完整 queue-item 详情：全部字段 + 完整链。
  // 可选 + 存在即渲染，使既有调用方不受影响。
  updatedAt?: string | null;
  priority?: string | null;
  tier?: string | null;
  closureReason?: string | null;
  closureTarget?: string | null;
  handedOffFrom?: string | null;
  handedOffTo?: string | null;
  blockedOn?: string | null;
  claimedAt?: string | null;
  expiresAt?: string | null;
  closureRequiredAt?: string | null;
  lastNudgeAttempt?: string | null;
  lastNudgeResult?: string | null;
  lastHeartbeat?: string | null;
  resolution?: string | null;
  targetRepo?: string | null;
  chain?: string[] | null;
  /** Tier-3 完整事实来源视图：每个字段都带标签渲染，null 显示为
   *  “—”（不隐藏）。默认 false 使其他调用方保持紧凑。 */
  fullDetail?: boolean;
}

const PREVIEW_LINES = 30;

export function QueueItemViewer({
  qitemId,
  source,
  destination,
  state,
  tags,
  createdAt,
  body,
  related,
  updatedAt,
  priority,
  tier,
  closureReason,
  closureTarget,
  handedOffFrom,
  handedOffTo,
  blockedOn,
  claimedAt,
  expiresAt,
  closureRequiredAt,
  lastNudgeAttempt,
  lastNudgeResult,
  lastHeartbeat,
  resolution,
  targetRepo,
  chain,
  fullDetail = false,
}: QueueItemViewerData) {
  const [showFull, setShowFull] = useState(false);
  const bodyLines = body ? body.split("\n") : [];
  const visibleLines = showFull ? bodyLines : bodyLines.slice(0, PREVIEW_LINES);

  if (!qitemId) {
    return (
      <EmptyState
        label="无队列项"
        description="未选择队列项。"
        variant="card"
        testId="queue-item-viewer-empty"
      />
    );
  }

  return (
    <div data-testid="queue-item-viewer" className="flex flex-col h-full">
      <header className="px-4 py-3 border-b border-outline-variant">
        <SectionHeader tone="muted">队列项</SectionHeader>
        <h3 className="mt-1 font-mono text-xs text-on-surface break-all">{qitemId}</h3>
      </header>
      <div className="px-4 py-3 border-b border-outline-variant space-y-2 font-mono text-xs">
        {source || destination ? (
          <MetaRow label="路由">
            <FlowChips source={source} destination={destination} muted />
          </MetaRow>
        ) : null}
        {source ? (
          <MetaRow label="来源">
            <ActorChip session={source} muted />
          </MetaRow>
        ) : null}
        {destination ? (
          <MetaRow label="目标">
            <ActorChip session={destination} muted />
          </MetaRow>
        ) : null}
        {state ? (
          <MetaRow label="状态">
            <QueueStateBadge state={state} testId="qitem-state" />
          </MetaRow>
        ) : null}
        {tags && tags.length > 0 ? (
          <MetaRow label="标签">
            <span className="flex min-w-0 flex-wrap justify-end gap-1">
              {tags.map((tag) => (
                <TagPill key={tag} tag={tag} />
              ))}
            </span>
          </MetaRow>
        ) : null}
        {createdAt ? (
          <MetaRow label="创建于">
            <DateChip value={createdAt} />
          </MetaRow>
        ) : null}
        {updatedAt ? (
          <MetaRow label="更新于">
            <DateChip value={updatedAt} />
          </MetaRow>
        ) : null}
        {/* OPR.0.4.1.19 Tier-3（fullDetail）：每个字段都带标签；null 显示为“—”。 */}
        <FieldRow label="优先级" value={priority} show={fullDetail} testId="qitem-priority" />
        <FieldRow label="层级" value={tier} show={fullDetail} />
        {closureReason || fullDetail ? (
          <MetaRow label="关闭">
            <span data-testid="qitem-closure" className={closureReason ? "break-all text-on-surface" : "text-on-surface-variant"}>
              {closureReason ? `${closureReason}${closureTarget ? ` → ${closureTarget}` : ""}` : "—"}
            </span>
          </MetaRow>
        ) : null}
        <FieldRow label="来自项" value={handedOffFrom} show={fullDetail} mono />
        <FieldRow label="发往" value={handedOffTo} show={fullDetail} mono />
        <FieldRow label="阻塞于" value={blockedOn} show={fullDetail} mono />
        <FieldRow label="认领于" value={claimedAt} show={fullDetail} testId="qitem-claimed" />
        <FieldRow label="过期" value={expiresAt} show={fullDetail} />
        <FieldRow label="关闭期限" value={closureRequiredAt} show={fullDetail} />
        <FieldRow label="最近提醒" value={lastNudgeAttempt} show={fullDetail} />
        <FieldRow label="提醒结果" value={lastNudgeResult} show={fullDetail} />
        <FieldRow label="心跳" value={lastHeartbeat} show={fullDetail} />
        <FieldRow label="结论" value={resolution} show={fullDetail} />
        <FieldRow label="目标仓库" value={targetRepo} show={fullDetail} testId="qitem-targetrepo" mono />
        {(chain && chain.length > 0) || fullDetail ? (
          <MetaRow label="链">
            {chain && chain.length > 0 ? (
              <span data-testid="qitem-chain" className="flex min-w-0 flex-col items-end gap-0.5 text-right">
                {chain.map((id, i) => (
                  <span key={`${id}-${i}`} className="break-all text-on-surface">
                    {i === 0 ? id : `↳ ${id}`}
                  </span>
                ))}
              </span>
            ) : (
              <span data-testid="qitem-chain" className="text-on-surface-variant">—</span>
            )}
          </MetaRow>
        ) : null}
      </div>
      <div className="px-4 py-3 border-b border-outline-variant flex-1 min-h-0 overflow-y-auto">
        <SectionHeader tone="muted">正文</SectionHeader>
        {body ? (
          <pre data-testid="qitem-body" className="mt-2 whitespace-pre-wrap font-mono text-xs text-on-surface">
            {visibleLines.join("\n")}
          </pre>
        ) : (
          <p className="mt-2 font-mono text-xs text-on-surface-variant italic">无正文。</p>
        )}
        {body && bodyLines.length > PREVIEW_LINES ? (
          <button
            type="button"
            onClick={() => setShowFull((s) => !s)}
            data-testid="qitem-body-toggle"
            className="mt-2 font-mono text-[10px] uppercase tracking-wide text-on-surface hover:text-on-surface underline"
          >
            {showFull ? "收起" : `展开全文（${bodyLines.length} 行）`}
          </button>
        ) : null}
      </div>
      {related && related.length > 0 ? (
        <div className="px-4 py-3">
          <SectionHeader tone="muted">相关</SectionHeader>
          <ul className="mt-2 space-y-1 font-mono text-xs">
            {related.map((r, i) => (
              <li key={`${r.kind}-${i}`} className="flex items-baseline gap-2">
                <span className="inline-flex w-12 shrink-0 items-center gap-1 text-on-surface-variant text-[10px] uppercase tracking-wide">
                  <RelatedKindIcon kind={r.kind} label={r.label} />
                  {r.kind}
                </span>
                {r.href ? (
                  <a href={r.href} className="text-on-surface hover:underline truncate">{r.label}</a>
                ) : (
                  <span className="text-on-surface truncate">{r.label}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function RelatedKindIcon({ kind, label }: { kind: NonNullable<QueueItemViewerData["related"]>[number]["kind"]; label: string }) {
  if (kind === "file") return <ToolMark tool={label} size="xs" />;
  if (kind === "commit") return <ToolMark tool="commit" size="xs" decorative />;
  if (kind === "slice") return <ToolMark tool="folder" size="xs" decorative />;
  return <ToolMark tool="terminal" size="xs" decorative />;
}

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-on-surface-variant">{label}</span>
      <span className="min-w-0 text-on-surface">{children}</span>
    </div>
  );
}

// OPR.0.4.1.19 —— 单个标量字段。值存在时渲染，或 `show`（Tier-3 fullDetail）强制完整项视图时渲染；
// null 值显示为“—”，使抽屉是忠实完整的视图，而非静默隐藏字段。
function FieldRow({
  label,
  value,
  show,
  testId,
  mono,
}: {
  label: string;
  value?: string | null;
  show: boolean;
  testId?: string;
  mono?: boolean;
}) {
  if (!value && !show) return null;
  return (
    <MetaRow label={label}>
      <span
        data-testid={testId}
        className={value ? (mono ? "break-all text-on-surface" : "text-on-surface") : "text-on-surface-variant"}
      >
        {value ?? "—"}
      </span>
    </MetaRow>
  );
}
