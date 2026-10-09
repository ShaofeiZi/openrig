// UI 增强包 v0——轻量 Markdown 查看器（无依赖）。
//
// 根据审计结果，UI 包未安装 Markdown 库。此组件实现一个小型解析器，处理操作人员阅读
// 规范文档时会遇到的情况：
//   - YAML frontmatter（作为正文上方的元数据头渲染）
//   - 标题（# / ## / ### / ####）
//   - 列表（- / * / 以两个空格缩进嵌套）
//   - 编号列表（1. / 2. / ...）
//   - 代码块（带语言标签的围栏 → SyntaxHighlight 组件）
//   - 行内代码
//   - 粗体和斜体的轻量支持
//   - 链接和图片
//   - 表格
//   - Mermaid 代码块 → 按 PRD 第 2 项例外规则显示“渲染 Mermaid”占位符
//     （v0 不捆绑 Mermaid 库；若自用验证报告点击渲染流程存在阻力，则触发已命名的 v0+1 工作）
//
// 图片 src 解析：绝对 URL 和 `data:` URI 原样通过；相对路径基于可选的
// `assetBasePath` 属性解析，使后台服务的 /api/files/asset 端点或切片的
// /api/slices/<name>/proof-asset/ 端点可以提供资源。

import { useMemo, useState } from "react";
import { SyntaxHighlight } from "./SyntaxHighlight.js";
import { extractKind, isFencedBlockLanguage } from "./storytelling-primitives.js";
import { FencedBlockRenderer } from "./blocks.js";
import { KindFrame } from "./kind-frame.js";

export interface MarkdownViewerProps {
  content: string;
  /** 用于解析相对图片 src 和链接 href，可选。 */
  assetBasePath?: string;
  /** 隐藏 YAML frontmatter 元数据头（默认 false）。 */
  hideFrontmatter?: boolean;
  /** 操作界面协调 v0 第 4 项：允许调用方隐藏原文/渲染视图切换，例如引导优先级堆栈面板；
   * 在这些位置，切换控件会与周围框架争夺视觉注意力。 */
  hideRawToggle?: boolean;
}

export function MarkdownViewer({ content, assetBasePath, hideFrontmatter = false, hideRawToggle = false }: MarkdownViewerProps) {
  const parsed = useMemo(() => parseMarkdown(content), [content]);
  // 操作界面协调 v0 第 4 项：每个实例可在渲染视图（默认）和原文视图（等宽预格式化文本与
  // 可见 Markdown 源码）之间切换。除非设置 hideFrontmatter，否则原文模式仍渲染
  // frontmatter 元数据头。
  const [mode, setMode] = useState<"rendered" | "raw">("rendered");
  return (
    <article data-testid="markdown-viewer" data-mode={mode} className="prose-tactical max-w-none">
      {!hideRawToggle && (
        <div data-testid="markdown-viewer-mode-toggle" className="mb-2 flex items-center gap-1">
          <button
            type="button"
            data-testid="markdown-viewer-mode-rendered"
            data-active={mode === "rendered"}
            onClick={() => setMode("rendered")}
            className={`border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.10em] ${
              mode === "rendered"
                ? "border-on-surface bg-inverse-surface text-background"
                : "border-outline-variant text-on-surface hover:bg-surface-low"
            }`}
          >
            渲染视图
          </button>
          <button
            type="button"
            data-testid="markdown-viewer-mode-raw"
            data-active={mode === "raw"}
            onClick={() => setMode("raw")}
            className={`border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.10em] ${
              mode === "raw"
                ? "border-on-surface bg-inverse-surface text-background"
                : "border-outline-variant text-on-surface hover:bg-surface-low"
            }`}
          >
            原文
          </button>
        </div>
      )}
      {!hideFrontmatter && parsed.frontmatter && (
        <FrontmatterHeader frontmatter={parsed.frontmatter} />
      )}
      {mode === "raw" ? (
        <pre data-testid="markdown-viewer-raw" className="overflow-x-auto whitespace-pre-wrap break-words bg-background p-3 font-mono text-[10px] text-on-surface">
          {content}
        </pre>
      ) : (
        <RenderedBody parsed={parsed} assetBasePath={assetBasePath} />
      )}
    </article>
  );
}

/** 0.3.1 slice 06——感知 kind 的正文渲染。frontmatter 声明已知 `kind:` 时，用
 * KindFrame 包裹正文，使查看器呈现标题框架、可选摘要面板和其余正文。kind 未知或缺少
 * frontmatter 时，回退到普通块流程，也就是自 UI 增强包 v0 起一直采用的渲染方式。
 * 无论是否设置 kind，BlockRenderer 都会拦截围栏块语法
 *（timeline / stats / risk-table / compare / slate），使这些原语可用于任意 Markdown 界面。 */
function RenderedBody({ parsed, assetBasePath }: { parsed: ParsedDocument; assetBasePath?: string }) {
  const kind = extractKind(parsed.frontmatter);
  const body = (
    <div className="space-y-3" data-testid="markdown-viewer-rendered">
      {parsed.blocks.map((block, idx) => (
        <BlockRenderer key={idx} block={block} assetBasePath={assetBasePath} />
      ))}
    </div>
  );
  if (kind && parsed.frontmatter) {
    return <KindFrame kind={kind} frontmatter={parsed.frontmatter}>{body}</KindFrame>;
  }
  return body;
}

interface ParsedDocument {
  frontmatter: Record<string, string> | null;
  blocks: Block[];
}

type Block =
  | { type: "heading"; level: 1 | 2 | 3 | 4; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; language: string | null; text: string; isMermaid: boolean }
  | { type: "list"; ordered: boolean; items: Array<{ depth: number; text: string; ordinal: number | null }> }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "blank" };

// 列表项识别和捕获统一使用一套语法。要求存在已编写文本，可防止裸标记进入列表分支；
// 它会通过普通段落路径前进一步并保持可见，而不是循环或消失。
const LIST_ITEM_LINE = /^(\s*)(?:([-*])|(\d+)\.)\s+(.+)$/;

function parseMarkdown(content: string): ParsedDocument {
  const { frontmatter, body } = stripFrontmatter(content);
  const lines = body.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // 围栏代码块。语言匹配器接受连字符，使 0.3.1 slice 06 中 `risk-table` 一类围栏块语法
    // 可以正确解析。
    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      const language = fence[1] || null;
      const isMermaid = language?.toLowerCase() === "mermaid";
      const start = i + 1;
      let end = start;
      while (end < lines.length && !lines[end]!.match(/^```\s*$/)) end++;
      const text = lines.slice(start, end).join("\n");
      blocks.push({ type: "code", language, text, isMermaid });
      i = end + 1;
      continue;
    }

    // 标题。
    const heading = line.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length as 1 | 2 | 3 | 4, text: heading[2]! });
      i++;
      continue;
    }

    // 列表（项目符号或有序）。
    const firstListItem = line.match(LIST_ITEM_LINE);
    if (firstListItem) {
      const items: Array<{ depth: number; text: string; ordinal: number | null }> = [];
      const ordered = firstListItem[3] !== undefined;
      while (i < lines.length) {
        const m = lines[i]!.match(LIST_ITEM_LINE);
        if (!m) break;
        const indent = m[1]!.length;
        const parts = [m[4]!.trim()];
        const ordinal = m[3] === undefined ? null : Number(m[3]);
        i++;
        // 非空且非列表项的行，只有在缩进严格深于已编写标记时才归入当前列表项。
        // 合并显示文本时使用一个空格，在保留归属关系的同时不虚构新列表项。
        while (i < lines.length) {
          const continuation = lines[i]!;
          if (continuation.trim() === "" || LIST_ITEM_LINE.test(continuation)) break;
          const continuationIndent = continuation.length - continuation.trimStart().length;
          if (continuationIndent <= indent) break;
          parts.push(continuation.trim());
          i++;
        }
        items.push({
          depth: Math.floor(indent / 2),
          text: parts.join(" "),
          ordinal,
        });
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    // 表格（表头、分隔行和正文行）。
    if (line.match(/^\s*\|.*\|\s*$/) && i + 1 < lines.length && lines[i + 1]!.match(/^\s*\|[\s\-:|]+\|\s*$/)) {
      const headers = parseTableRow(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.match(/^\s*\|.*\|\s*$/)) {
        rows.push(parseTableRow(lines[i]!));
        i++;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    // 空行。
    if (line.trim() === "") {
      blocks.push({ type: "blank" });
      i++;
      continue;
    }

    // 段落（收集连续的非空、非特殊行）。
    const paragraph: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i]!;
      if (next.trim() === "") break;
      if (next.match(/^```/) || next.match(/^#{1,4}\s/) || LIST_ITEM_LINE.test(next) || next.match(/^\s*\|.*\|\s*$/)) break;
      paragraph.push(next);
      i++;
    }
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
  }
  return { frontmatter, blocks };
}

function stripFrontmatter(content: string): { frontmatter: Record<string, string> | null; body: string } {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { frontmatter: null, body: content };
  }
  const rest = content.slice(content.indexOf("\n") + 1);
  const endMatch = rest.match(/(^|\n)---(\n|$)/);
  if (!endMatch || endMatch.index === undefined) return { frontmatter: null, body: content };
  const fmText = rest.slice(0, endMatch.index);
  const body = rest.slice(endMatch.index + endMatch[0].length);
  const frontmatter: Record<string, string> = {};
  for (const line of fmText.split("\n")) {
    const m = line.match(/^([\w.-]+):\s*(.+?)\s*$/);
    if (m) {
      let v = m[2]!;
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      frontmatter[m[1]!] = v;
    }
  }
  return { frontmatter, body };
}

function parseTableRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

function FrontmatterHeader({ frontmatter }: { frontmatter: Record<string, string> }) {
  const entries = Object.entries(frontmatter);
  if (entries.length === 0) return null;
  return (
    <section
      data-testid="markdown-frontmatter"
      className="mb-4 border border-outline-variant bg-background p-3"
    >
      <div className="mb-2 font-mono text-[8px] uppercase tracking-[0.18em] text-on-surface-variant">
        前置元数据
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        {entries.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="font-mono text-[10px] font-bold text-on-surface">{k}</dt>
            <dd className="font-mono text-[10px] text-on-surface break-all">{v}</dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}

function BlockRenderer({ block, assetBasePath }: { block: Block; assetBasePath?: string }) {
  if (block.type === "blank") return null;
  if (block.type === "heading") {
    const sizes = { 1: "text-lg font-bold", 2: "text-base font-bold", 3: "text-sm font-bold", 4: "text-xs font-bold" } as const;
    const Tag = (`h${block.level}` as "h1" | "h2" | "h3" | "h4");
    return <Tag data-testid={`md-heading-${block.level}`} className={`${sizes[block.level]} mt-4 text-on-surface`}>{renderInline(block.text, assetBasePath)}</Tag>;
  }
  if (block.type === "paragraph") {
    return <p data-testid="md-paragraph" className="text-[12px] leading-relaxed text-on-surface">{renderInline(block.text, assetBasePath)}</p>;
  }
  if (block.type === "code") {
    // 0.3.1 slice 06：在通用 SyntaxHighlight 兜底前拦截围栏块语法。未知语言会回退到
    // SyntaxHighlight，保留原有行为。
    if (isFencedBlockLanguage(block.language)) {
      return <FencedBlockRenderer language={block.language} text={block.text} />;
    }
    if (block.isMermaid) {
      return (
        <div data-testid="md-mermaid-placeholder" className="border border-amber-300 bg-amber-50 p-3">
          <div className="mb-2 font-mono text-[8px] uppercase tracking-[0.18em] text-amber-700">
            mermaid 图（v0+1 触发：点击渲染流程）
          </div>
          <pre className="overflow-x-auto bg-stone-900 p-2 font-mono text-[10px] text-stone-100">
            <code>{block.text}</code>
          </pre>
          <button
            type="button"
            data-testid="md-mermaid-render-btn"
            disabled
            title="v0 未打包 mermaid 渲染（命名为 v0+1 触发）。请查看上方源码。"
            className="mt-2 cursor-not-allowed border border-amber-400 bg-amber-100 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.10em] text-amber-800"
          >
            [渲染 mermaid]（v0+1）
          </button>
        </div>
      );
    }
    return <SyntaxHighlight code={block.text} language={block.language} />;
  }
  if (block.type === "list") {
    const ListTag = block.ordered ? "ol" : "ul";
    return (
      <ListTag data-testid={`md-list-${block.ordered ? "ol" : "ul"}`} className={`${block.ordered ? "list-decimal" : "list-disc"} ml-5 space-y-1 text-[12px] text-on-surface`}>
        {block.items.map((item, idx) => (
          <li
            key={idx}
            value={block.ordered && item.ordinal !== null ? item.ordinal : undefined}
            style={{ marginLeft: `${item.depth * 1}rem` }}
          >
            {renderInline(item.text, assetBasePath)}
          </li>
        ))}
      </ListTag>
    );
  }
  if (block.type === "table") {
    return (
      <div data-testid="md-table-wrapper" className="overflow-x-auto">
        <table className="w-full border-collapse border border-outline-variant text-[10px]">
          <thead className="bg-surface-low">
            <tr>{block.headers.map((h, i) => <th key={i} className="border border-outline-variant px-2 py-1 text-left font-bold text-on-surface">{renderInline(h, assetBasePath)}</th>)}</tr>
          </thead>
          <tbody>
            {block.rows.map((row, ri) => (
              <tr key={ri} className={ri % 2 === 0 ? "bg-surface-lowest" : "bg-background"}>
                {row.map((cell, ci) => <td key={ci} className="border border-outline-variant px-2 py-1 text-on-surface">{renderInline(cell, assetBasePath)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return null;
}

// 轻量行内解析器：处理行内代码、粗体、斜体、链接和图片。
function renderInline(text: string, assetBasePath?: string): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  const flushPlain = (start: number, end: number) => {
    if (end > start) nodes.push(text.slice(start, end));
  };
  let plainStart = 0;
  while (i < text.length) {
    const remaining = text.slice(i);
    // 图片：![alt](src)
    const imgMatch = remaining.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
    if (imgMatch) {
      flushPlain(plainStart, i);
      const src = resolveAssetUrl(imgMatch[2]!, assetBasePath);
      nodes.push(
        <img
          key={key++}
          data-testid="md-inline-image"
          src={src}
          alt={imgMatch[1] ?? ""}
          loading="lazy"
          className="my-2 inline-block max-w-full border border-outline-variant"
        />,
      );
      i += imgMatch[0].length;
      plainStart = i;
      continue;
    }
    // 链接：[text](href)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      flushPlain(plainStart, i);
      nodes.push(
        <a
          key={key++}
          data-testid="md-inline-link"
          href={linkMatch[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-700 underline hover:text-blue-900"
        >
          {linkMatch[1]}
        </a>,
      );
      i += linkMatch[0].length;
      plainStart = i;
      continue;
    }
    // 行内代码。
    if (remaining.startsWith("`")) {
      const close = remaining.indexOf("`", 1);
      if (close !== -1) {
        flushPlain(plainStart, i);
        nodes.push(
          <code
            key={key++}
            data-testid="md-inline-code"
            className="bg-surface-low px-1 font-mono text-[10px] text-on-surface"
          >
            {remaining.slice(1, close)}
          </code>,
        );
        i += close + 1;
        plainStart = i;
        continue;
      }
    }
    // 粗体。
    if (remaining.startsWith("**")) {
      const close = remaining.indexOf("**", 2);
      if (close !== -1) {
        flushPlain(plainStart, i);
        nodes.push(<strong key={key++} className="font-bold">{remaining.slice(2, close)}</strong>);
        i += close + 2;
        plainStart = i;
        continue;
      }
    }
    // 斜体。
    if (remaining.startsWith("*") && !remaining.startsWith("**")) {
      const close = remaining.indexOf("*", 1);
      if (close !== -1 && close > 1) {
        flushPlain(plainStart, i);
        nodes.push(<em key={key++} className="italic">{remaining.slice(1, close)}</em>);
        i += close + 1;
        plainStart = i;
        continue;
      }
    }
    i++;
  }
  flushPlain(plainStart, text.length);
  return nodes;
}

function resolveAssetUrl(src: string, assetBasePath?: string): string {
  if (!src) return src;
  if (src.startsWith("http://") || src.startsWith("https://") || src.startsWith("data:") || src.startsWith("/")) return src;
  if (!assetBasePath) return src;
  // 将 assetBasePath 视为 URL 前缀；谨慎拼接，避免产生双斜杠或移除路径的相对部分。
  const sep = assetBasePath.endsWith("/") ? "" : "/";
  return `${assetBasePath}${sep}${src}`;
}

// 最小化的 Fragment 等价实现，无须直接导入 react/jsx-runtime；React 19 通过具名导出
// 提供 Fragment。
import { Fragment } from "react";
