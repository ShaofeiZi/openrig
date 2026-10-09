// 2026-07-05 §3.3 纠偏式重新设计——重建切片评审页签。
//
// 唯一结构：需要你处理 → 智能体 → 纵向三段堆栈（界面标签为意图/计划/已交付）→ 已定稿。
// 四套并行结构已经移除：被否决的三列并置和单独的条目联结表对应文件已删除，而不是降级保留；
// 根因分析的教训是，降级会让被否决的渲染继续存活。阶段只决定当前聚焦哪个区段，不决定结构
// 是否存在；三个区段始终组合，来源缺失时降级显示低调的“—”。
//
// “已交付”采用重新设计的联结（§3.1）：每个计划交付物在纵向列中与精选证明配对；计划模型图
// 位于已交付产物上方。媒体按文字高度行内显示，点按后一次只展开一个并占满宽度。`verified`
// 用直白文字呈现 QA 记录的比较；unverified/missing 保持可见但不阻塞（§11 失败开放）。这里只显示
// 精选集合，“查看全部证明”会进入 proof/ 目录。两个锁（§4）：计划阶段显示计划锁，定稿阶段显示证明锁。
//
// 移动端优先的单列布局，便于手机快速浏览。卡片统一使用一套 vellum 配方（§7.4）。W5：
// 每种可评审状态都支持深链接（?item= / ?zoom=，媒体校验使用 ?seek+?play）。

import { useState } from "react";
import { useSliceReview, type ComposedSliceReview, type DeliveredItem, type ReviewMedia, type LockState } from "../../hooks/useReview.js";
import { useScopeMarkdown } from "../../hooks/useScopeMarkdown.js";
import { NeedsYouAccordion } from "./NeedsYouAccordion.js";
import { AgentsBandView } from "./AgentsBandView.js";
import { VerifyLineageCard } from "./VerifyLineageCard.js";
import { EvidenceOpener, type EvidenceContext } from "./EvidenceOpener.js";
import { Lightbox } from "../project/Lightbox.js";
import { FileReferenceTrigger } from "../drawer-triggers/FileReferenceTrigger.js";
import { fileAssetUrl } from "../../hooks/useFiles.js";
import { EmptyState } from "../ui/empty-state.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";
import { VELLUM_CARD } from "./vellum.js";
import { cn } from "../../lib/utils.js";
import { proofReadinessLabel } from "../../lib/project-mission-state.js";

/** 界面用于记录操作者来源的执行会话：真正执行解析的会话；委派元数据由后台服务记录。 */
const SURFACE_ACTOR = "human@host";

function bootParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(name);
}

/** 解析 ReviewMedia src：data:/blob: 原样通过，供孪生夹具和任意内联媒体使用；切片相对引用
 * 通过文件白名单解析，与 EvidenceOpener 使用同一套解析逻辑。 */
function mediaSrc(ctx: EvidenceContext, src: string): string | null {
  if (src.startsWith("data:") || src.startsWith("blob:")) return src;
  if (src.startsWith("/")) return null; // absolute = defect, surfaced upstream
  if (!ctx.root) return null;
  return fileAssetUrl(ctx.root, ctx.relPath ? `${ctx.relPath}/${src}` : src);
}

/** §7.3 界面支柱——真正可播放的媒体。视频带原生控件行内渲染，并保留 playsinline 以支持未来
 * iOS；图片在已交付的灯箱中打开。`?seek=<s>&play=1` 会启动播放以校验捕获内容；这是深链接，
 * 绝不是加工过的静态帧。 */
function InlineMedia({ media, ctx, full }: { media: ReviewMedia; ctx: EvidenceContext; full?: boolean }) {
  const [zoom, setZoom] = useState(false);
  const src = mediaSrc(ctx, media.src);
  if (!src) {
    return <span className="font-mono text-[11px] text-red-700">无法解析媒体：{media.src}</span>;
  }
  if (media.kind === "video") {
    const seek = bootParam("seek");
    const autoplay = bootParam("play") === "1";
    return (
      <figure className={cn("min-w-0", full ? "w-full" : "max-w-[420px]")}>
        <video
          data-testid="review-inline-video"
          controls
          playsInline
          preload={autoplay ? "auto" : "metadata"}
          poster={media.poster}
          src={src}
          // React 的 `muted` 属性在首次渲染时可能不会落为 DOM 属性，因而触发 Chrome 自动播放
          // 策略阻止元素。?play=1 深链接会在挂载时以命令方式静音并播放（W5 捕获路径）；
          // 普通渲染仍保持仅由控件播放的行为。
          ref={(el) => {
            if (el && autoplay && el.paused) {
              el.muted = true;
              void el.play().catch(() => {});
            }
          }}
          onLoadedMetadata={(e) => {
            if (seek) e.currentTarget.currentTime = Number(seek);
          }}
          className="block w-full border border-outline-variant bg-stone-950"
        />
        <figcaption className="mt-0.5 font-mono text-[9px] uppercase text-on-surface-variant">▶ {media.caption}</figcaption>
      </figure>
    );
  }
  return (
    <figure className={cn("min-w-0", full ? "w-full" : "max-w-[420px]")}>
      <img
        src={src}
        alt={media.caption}
        loading="lazy"
        title="打开大图"
        onClick={() => setZoom(true)}
        className="block w-full cursor-zoom-in border border-outline-variant"
      />
      <figcaption className="mt-0.5 font-mono text-[9px] uppercase text-on-surface-variant">{media.caption}</figcaption>
      {zoom ? <Lightbox src={src} alt={media.caption} onClose={() => setZoom(false)} /> : null}
    </figure>
  );
}

function LockStamp({ lock, label }: { lock: LockState | null; label: string }) {
  return (
    <p className="font-mono text-[10px] text-on-surface-variant">
      <span className={lock ? "text-on-surface" : ""}>{lock ? "✓" : "○"}</span> {label} —{" "}
      {lock ? (
        <>
          {lock.by} · {lock.at}
          {lock.auditVerified ? "" : <span className="font-bold text-red-700">（未校验戳记——没有匹配的审计记录）</span>}
        </>
      ) : (
        "未锁定"
      )}
    </p>
  );
}

// §3.1 verified 使用创始人易懂的直白文字；QA 未完成保持可见，但绝不阻塞。
const VERIFIED_RENDER: Record<DeliveredItem["verified"], { label: string; cls: string }> = {
  verified: { label: "✓ 旧版 QA 已校验（条目修订未绑定）", cls: "text-emerald-700 dark:text-emerald-400" },
  unverified: { label: "◇ 未校验 —— 无通过的 QA 对比", cls: "text-amber-700 dark:text-amber-400" },
  missing: { label: "✗ 缺失 —— 承诺了却未交付", cls: "font-bold text-red-700 dark:text-red-400" },
};

/** §3.3 已交付：一个计划交付物与其精选证明纵向配对；点按后一次只将一项展开至全宽。 */
function DeliveredSection({ d, ctx, attributed }: { d: ComposedSliceReview["delivered"]; ctx: EvidenceContext; attributed: boolean }) {
  const [openIdx, setOpenIdx] = useState<number | null>(() => {
    const boot = bootParam("item");
    return boot !== null ? Number(boot) : null;
  });
  return (
    <section data-testid="delivered-section" className={cn(VELLUM_CARD, "space-y-0 p-0")}>
      <h3 className="border-b border-outline-variant px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-wide text-on-surface">已交付</h3>
      {d.items.length === 0 ? (
        <p data-testid="delivered-empty" className="px-3 py-2 font-mono text-[11px] text-on-surface-variant">
          — 计划尚未声明校验契约
        </p>
      ) : (
        d.items.map((item, i) => {
          const open = openIdx === i;
          const v = VERIFIED_RENDER[item.verified];
          return (
            <div key={i} className="border-b border-outline-variant/60">
              <button
                type="button"
                data-testid={`delivered-item-${i}`}
                onClick={() => setOpenIdx(open ? null : i)}
                className="flex w-full flex-col gap-y-1 px-3 py-2 text-left hover:bg-surface-variant/30 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-3"
              >
                <span className="min-w-0 flex-1 text-[12px] leading-snug text-on-surface">{item.promised.text}</span>
                <span className={cn("shrink-0 font-mono text-[10px] uppercase tracking-wide", v.cls)}>{attributed ? item.verified === "verified" ? "✓ 已按所选策略接受" : "◇ 当前无验收结论" : v.label}</span>
              </button>
              {open ? (
                <div data-testid={`delivered-item-open-${i}`} className="space-y-3 border-t border-outline-variant/60 px-3 py-3">
                  {item.promised.plannedRef ? (
                    <div>
                      <p className="mb-1 font-mono text-[9px] uppercase tracking-wide text-on-surface-variant">计划内容（已锁定的样机）</p>
                      <InlineMedia media={item.promised.plannedRef} ctx={ctx} full />
                    </div>
                  ) : null}
                  {item.proof.length > 0 ? (
                    <div className="space-y-2">
                      <p className="mb-1 font-mono text-[9px] uppercase tracking-wide text-on-surface-variant">已交付内容（精选证明）</p>
                      {item.proof.map((m, j) => (
                        <InlineMedia key={j} media={m} ctx={ctx} full />
                      ))}
                    </div>
                  ) : item.verified === "verified" ? (
                    <p className="font-mono text-[11px] text-on-surface-variant">✓ 已由产物校验；未附媒体</p>
                  ) : item.verified === "unverified" ? (
                    // slice-04 REV6：unverified 表示已交付产物（covering.length>0），但没有通过的
                    // 比较；这是真实状态，而不是“未交付任何内容”（后者留给下方 `missing`）。
                    // 所有 QA 备注均显示在其下。
                    <p className="font-mono text-[11px] text-on-surface-variant">◇ 已记录产物；未附媒体</p>
                  ) : (
                    <p className="font-mono text-[11px] text-on-surface-variant">— 此项尚无交付内容</p>
                  )}
                  {item.note ? (
                    <p data-testid={`delivered-note-${i}`} className="font-mono text-[11px] text-on-surface-variant">
                      判定说明：{item.note}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })
      )}
      {d.extraProof.length > 0 ? (
        <div className="space-y-2 px-3 py-2">
          <p className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant">补充证明（未绑定到单个交付项）</p>
          <div className="flex flex-wrap gap-3">
            {d.extraProof.map((m, j) => (
              <InlineMedia key={j} media={m} ctx={ctx} />
            ))}
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <span className="font-mono text-[10px] text-on-surface-variant">
          仅展示精选集合——修复循环历史保留在 proof/ 中
        </span>
        {d.proofDirPath ? (
          <span className="font-mono text-[11px]">
            <EvidenceOpener evidenceRef="proof/" ctx={ctx} testId="delivered-see-all" />
          </span>
        ) : null}
      </div>
    </section>
  );
}

export function SliceReviewTab({
  sliceName,
  slicePath,
  anchorIdentity,
}: {
  sliceName: string;
  slicePath: string | null;
  /** FR-9 深链接目标：加载时打开的一条“需要你处理”身份。 */
  anchorIdentity?: string | null;
}) {
  const review = useSliceReview(sliceName);
  const scopeResolved = useScopeMarkdown(slicePath, "PROOF.md");

  if (review.isLoading) {
    return <EmptyState label="正在撰写" description={`正在为 ${sliceName} 撰写评审…`} variant="card" testId="review-loading" />;
  }
  if (review.isError || !review.data) {
    return (
      <EmptyState
        label="评审不可用"
        description={review.error instanceof Error ? review.error.message : "评审撰写器无法为此切片生成评审。"}
        variant="card"
        testId="review-error"
      />
    );
  }
  const data = review.data;
  const ctx: EvidenceContext = {
    root: scopeResolved.resolved?.rootName ?? null,
    relPath: scopeResolved.resolved?.relPath ?? null,
    slicePath,
  };

  return (
    <div data-testid="slice-review-tab" className="space-y-5">
      {data.readiness && <p role="status" data-testid="proof-readiness">校验就绪：{review.updatesUnavailable ? "源更新不可用；最后确认状态 " + proofReadinessLabel(data.readiness.state) : review.basisInvalidated ? "检测到变更；正在确认当前依据" : proofReadinessLabel(data.readiness.state)} · 最后确认 {data.readiness.revision.slice(0, 12)} · 发布是独立动作</p>}
      {data.defects.length > 0 ? (
        <section data-testid="review-defects" className="border border-red-300 bg-red-50 p-2 dark:bg-red-950/40">
          <ul className="space-y-0.5 font-mono text-[10px] text-red-800 dark:text-red-300">
            {data.defects.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Band 1: NEEDS YOU (kept — orthogonal and sound). */}
      <NeedsYouAccordion band={data.needsYou} slice={data.slice} missionId={data.missionId} actorSession={SURFACE_ACTOR} ctx={ctx} anchorIdentity={anchorIdentity} />

      {/* Band 2: AGENTS — standing band, zoom to the rig altitude (kept). */}
      <AgentsBandView band={data.agents} itemRef={data.slice} />

      {/* Band 3: THE ONE STACK — INTENT → PLAN → DELIVERED (§3.3). Scanned
          top-to-bottom: did intent become a correct plan become a correct
          build. Phase highlights the current focus, never hides a section. */}
      <section data-testid="intent-section" className={cn(VELLUM_CARD, "p-3")}>
        <h3 className="mb-1 font-mono text-[11px] font-bold uppercase tracking-wide text-on-surface">意图</h3>
        {data.intent.text ? (
          <MarkdownViewer content={data.intent.text} hideFrontmatter hideRawToggle />
        ) : (
          <p className="font-mono text-[11px] text-on-surface-variant">— {data.intent.degrade ?? "未记录意图"}</p>
        )}
        {data.intent.media.map((m, i) => (
          <div key={i} className="mt-2">
            <InlineMedia media={m} ctx={ctx} />
          </div>
        ))}
      </section>

      <section data-testid="plan-section" className={cn(VELLUM_CARD, "space-y-2 p-3")}>
        <h3 className="font-mono text-[11px] font-bold uppercase tracking-wide text-on-surface">计划</h3>
        {data.plan.concise.text ? (
          <MarkdownViewer content={data.plan.concise.text} hideFrontmatter hideRawToggle />
        ) : (
          // 第 3 阶段杠杆 C（第 1 阶段）：当且仅当微型需求尚未编写时，组合器已返回
          // text===null；此处用静态、不可交互的注意标记如实指出不合规，而不是只显示简短横线。
          // 它在每个阶段都渲染，仅影响呈现，不抑制任何同级内容。
          <p data-testid="plan-mini-reqs-noncompliant" className="font-mono text-[11px] text-amber-700 dark:text-amber-400">
            不合规 · 尚未编写最小需求
          </p>
        )}
        {data.plan.concise.media.length > 0 ? (
          <div className="flex flex-wrap gap-3">
            {data.plan.concise.media.map((m, i) => (
              <InlineMedia key={i} media={m} ctx={ctx} />
            ))}
          </div>
        ) : null}
        {data.plan.lockedArtifacts.length > 0 ? (
          <div data-testid="plan-locked-set">
            <p className="mb-1 font-mono text-[9px] uppercase tracking-wide text-on-surface-variant">已锁定集合（将按此构建）</p>
            <ul className="space-y-0.5">
              {data.plan.lockedArtifacts.map((a) => (
                <li key={a.path} className="font-mono text-[11px]">
                  <EvidenceOpener evidenceRef={a.path} ctx={ctx} testId={`plan-artifact-${a.name}`} />
                  <span className="ml-1 text-[9px] uppercase text-on-surface-variant">{a.kind}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <LockStamp lock={data.plan.lock} label="计划锁（将按此集合构建）" />
          {data.plan.ssotPath ? (
            <FileReferenceTrigger
              testId="plan-full-prd"
              className="font-mono text-[10px] uppercase text-on-surface-variant underline underline-offset-2 hover:text-on-surface"
              data={{
                path: data.plan.ssotPath,
                kind: "markdown",
                root: ctx.root ?? undefined,
                // ssotPath 相对于工作区；已解析根目录下可获取的目标是切片目录中的文件。
                // relPath "" 是合法的精确根目录解析，结果为裸文件名（23ca5031 过度加前缀类）；
                // relPath 为 null 表示没有根目录目标，此时回退到 absolutePath。
                readPath:
                  ctx.relPath !== null
                    ? ctx.relPath
                      ? `${ctx.relPath}/${data.plan.ssotPath.split("/").pop()!}`
                      : data.plan.ssotPath.split("/").pop()!
                    : undefined,
                absolutePath: ctx.slicePath ? `${ctx.slicePath}/${data.plan.ssotPath.split("/").pop()!}` : null,
              }}
            >
              完整 PRD →
            </FileReferenceTrigger>
          ) : null}
        </div>
      </section>

      <DeliveredSection d={data.delivered} ctx={ctx} attributed={data.readiness?.configured === true} />

      <VerifyLineageCard lineage={data.lineage} />

      {/* Band 4: SETTLED — the two deliberate stamps (§4). */}
      <section data-testid="settled-band" className={cn(VELLUM_CARD, "space-y-1 p-3")}>
        <h3 className="font-mono text-[10px] uppercase tracking-wide text-on-surface-variant">已定稿</h3>
        <LockStamp lock={data.plan.lock} label="门控 1 · 计划锁（计划 ↔ 意图）" />
        <LockStamp lock={data.delivered.lock} label={data.readiness?.configured ? "历史证明锁（当前判定见上方）" : "门控 2 · 证明锁（交付 ↔ 计划）——已记录戳记"} />
      </section>
    </div>
  );
}
