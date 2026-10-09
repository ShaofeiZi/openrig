// V1 第 4 阶段尝试 3 —— SubSpecPreview，依据 content-drawer.md L112–L135。

import { Link } from "@tanstack/react-router";
import { SectionHeader } from "../ui/section-header.js";

export interface SubSpecPreviewData {
  specKind: string;
  specName: string;
  version?: string;
  source?: "builtin" | "user_file" | "fork";
  manifestExcerpt?: string;
  entryId?: string;
}

export function SubSpecPreview({
  specKind,
  specName,
  version,
  source,
  manifestExcerpt,
  entryId,
}: SubSpecPreviewData) {
  return (
    <div data-testid="sub-spec-preview" className="flex flex-col h-full">
      <header className="px-4 py-3 border-b border-outline-variant">
        <SectionHeader tone="muted">引用的规格</SectionHeader>
        <h3 className="mt-1 font-mono text-xs text-on-surface break-all">
          {specKind}: {specName}
        </h3>
      </header>
      <div className="px-4 py-3 border-b border-outline-variant space-y-1.5 font-mono text-xs">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-on-surface-variant">类型</span>
          <span className="text-on-surface">{specKind}</span>
        </div>
        {version ? (
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-on-surface-variant">版本</span>
            <span className="text-on-surface">{version}</span>
          </div>
        ) : null}
        {source ? (
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-on-surface-variant">来源</span>
            <span className="text-on-surface uppercase">{source.replace("_", " ")}</span>
          </div>
        ) : null}
      </div>
      <div className="px-4 py-3 flex-1 min-h-0 overflow-y-auto">
        <SectionHeader tone="muted">清单摘录</SectionHeader>
        {manifestExcerpt ? (
          <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-on-surface">
            {manifestExcerpt}
          </pre>
        ) : (
          <p className="mt-2 font-mono text-xs text-on-surface-variant italic">无可用摘录。</p>
        )}
      </div>
      {entryId ? (
        <div className="px-4 py-3 border-t border-outline-variant">
          <Link
            to="/specs/library/$entryId"
            params={{ entryId }}
            data-testid="sub-spec-open-center"
            className="inline-flex items-center px-3 py-1 border border-outline-variant bg-surface-lowest font-mono text-[10px] uppercase tracking-wide text-on-surface hover:bg-surface-low"
          >
            在中心区域打开 →
          </Link>
        </div>
      ) : null}
    </div>
  );
}
