// 0.3.1 slice 06——围栏块渲染器。每种块语言
// （timeline / stats / risk-table / compare / slate）解析其正文并分发到对应的空间基础组件。
// 解析失败回退为普通代码块，使源码仍可检视。

import {
  parseTimelineBlock,
  parseStatsBlock,
  parseRiskTableBlock,
  parseCompareBlock,
  parseSlateBlock,
  type FencedBlockLanguage,
} from "./storytelling-primitives.js";
import {
  TLDRSlate,
  DotTimeline,
  StatCardBand,
  RiskTableGrid,
  CompareTable,
} from "./primitives.js";

interface FencedBlockProps {
  language: FencedBlockLanguage;
  text: string;
}

/** 把围栏块分发到其专用渲染器。当语言不是已知围栏块语法时返回 null
 *  （调用方随后落到普通代码块渲染器）。当语言已知但正文解析失败时，渲染一个普通代码块，
 *  使源码仍可检视。 */
export function FencedBlockRenderer({ language, text }: FencedBlockProps): React.ReactElement | null {
  if (language === "timeline") {
    const r = parseTimelineBlock(text);
    if (!r.ok) return <FallbackCode language={language} text={text} reason={r.reason} />;
    return <DotTimeline entries={r.entries} testId={`fenced-block-${language}`} />;
  }
  if (language === "stats") {
    const r = parseStatsBlock(text);
    if (!r.ok) return <FallbackCode language={language} text={text} reason={r.reason} />;
    return <StatCardBand entries={r.entries} testId={`fenced-block-${language}`} />;
  }
  if (language === "risk-table") {
    const r = parseRiskTableBlock(text);
    if (!r.ok) return <FallbackCode language={language} text={text} reason={r.reason} />;
    return <RiskTableGrid entries={r.entries} testId={`fenced-block-${language}`} />;
  }
  if (language === "compare") {
    const r = parseCompareBlock(text);
    if (!r.ok) return <FallbackCode language={language} text={text} reason={r.reason} />;
    return <CompareTable columns={r.columns} rows={r.rows} testId={`fenced-block-${language}`} />;
  }
  if (language === "slate") {
    const r = parseSlateBlock(text);
    if (!r.ok) return <FallbackCode language={language} text={text} reason={r.reason} />;
    return <TLDRSlate testId={`fenced-block-${language}`}>{r.text}</TLDRSlate>;
  }
  return null;
}

function FallbackCode({ language, text, reason }: { language: string; text: string; reason: string }) {
  return (
    <div data-testid={`fenced-block-${language}-fallback`} className="my-3 border border-amber-300 bg-amber-50/60 p-3">
      <div className="mb-2 font-mono text-[8px] uppercase tracking-[0.18em] text-amber-700">
        {language} 块（回退：{reason}）
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[10px] text-on-surface">{text}</pre>
    </div>
  );
}
