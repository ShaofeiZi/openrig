// 0.3.1 slice 06——KindFrame。
//
// Markdown 文件在 frontmatter 中声明已知 `kind:` 时，MarkdownViewer 会用 KindFrame 包裹正文：
// 包含紧凑标题外观（类型徽标、标题、元数据行），以及由 `tldr:` frontmatter 字段组成的可选摘要板。
// 正文仍由现有块流程渲染，其中围栏块语法（timeline / stats / risk-table / compare / slate）
// 会被拦截并转换为空间原语。除三种完整实现布局外，其余四种类型共享该外观；视觉差异只在强调色
// 和类型标签。

import { TLDRSlate, SummaryStrip } from "./primitives.js";
import type { KindName } from "./storytelling-primitives.js";

interface KindFrameProps {
  kind: KindName;
  frontmatter: Record<string, string>;
  children: React.ReactNode;
}

const KIND_ACCENTS: Record<KindName, { ink: string; pill: string; label: string }> = {
  "incident-timeline":   { ink: "text-red-800",     pill: "bg-red-50 border-red-300",       label: "事件时间线" },
  "progress":            { ink: "text-sky-800",     pill: "bg-sky-50 border-sky-300",       label: "进展" },
  "feature-shipped":     { ink: "text-emerald-800", pill: "bg-emerald-50 border-emerald-300", label: "功能已交付" },
  "implementation-plan": { ink: "text-violet-800",  pill: "bg-violet-50 border-violet-300", label: "实现计划" },
  "concept-explainer":   { ink: "text-amber-800",   pill: "bg-amber-50 border-amber-300",   label: "概念讲解" },
  "pr-writeup":          { ink: "text-on-surface",   pill: "bg-background border-outline-variant",   label: "PR 说明" },
  "post-mortem":         { ink: "text-on-surface",   pill: "bg-surface-low border-outline",  label: "复盘" },
};

export function KindFrame({ kind, frontmatter, children }: KindFrameProps): React.ReactElement {
  const accent = KIND_ACCENTS[kind];
  const title = frontmatter.title;
  const status = frontmatter.status;
  const author = frontmatter.author;
  const date = frontmatter.authored || frontmatter.date;
  const tldr = frontmatter.tldr;
  const summary = frontmatter.summary;

  return (
    <section data-testid={`kind-frame-${kind}`} data-kind={kind} className="my-2">
      <header className="mb-3 border-b border-outline-variant pb-2">
        <div
          data-testid={`kind-badge-${kind}`}
          className={`inline-block border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em] ${accent.pill} ${accent.ink}`}
        >
          {accent.label}
        </div>
        {title && (
          <h1 data-testid="kind-frame-title" className="mt-2 text-[16px] font-bold text-on-surface">
            {title}
          </h1>
        )}
        {(status || author || date) && (
          <div data-testid="kind-frame-meta" className="mt-1 flex flex-wrap items-center gap-3 font-mono text-[9px] uppercase tracking-[0.10em] text-on-surface-variant">
            {status && <span data-testid="kind-frame-meta-status">状态：{status}</span>}
            {author && <span data-testid="kind-frame-meta-author">{author}</span>}
            {date && <span data-testid="kind-frame-meta-date">{date}</span>}
          </div>
        )}
      </header>
      {tldr && <TLDRSlate testId="kind-frame-tldr">{tldr}</TLDRSlate>}
      {kind === "feature-shipped" && summary && (
        <SummaryStrip label="已交付" body={summary} testId="kind-frame-summary" />
      )}
      <div data-testid="kind-frame-body">{children}</div>
    </section>
  );
}
