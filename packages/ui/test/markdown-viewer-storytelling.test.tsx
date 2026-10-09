// 0.3.1 slice 06——MarkdownViewer storytelling 集成：kind
// 分发器 + fenced-block 文法经既有
// rendered-mode 流接线。验证 IMPLEMENTATION-PRD §10 的
// HG-1、HG-2、HG-3 验收门禁。

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MarkdownViewer } from "../src/components/markdown/MarkdownViewer.js";

afterEach(cleanup);

describe("HG-1 — kind dispatcher", () => {
  it("wraps the body in a KindFrame when frontmatter declares a known kind", () => {
    const content = `---
kind: incident-timeline
title: Plugin primitive narrative
status: in-flight
---

# Background

Paragraph here.`;
    const { container } = render(<MarkdownViewer content={content} hideFrontmatter />);
    expect(container.querySelector("[data-testid='kind-frame-incident-timeline']")).toBeTruthy();
    expect(container.querySelector("[data-testid='kind-badge-incident-timeline']")?.textContent).toContain("事件时间线");
    expect(container.querySelector("[data-testid='kind-frame-title']")?.textContent).toContain("Plugin primitive narrative");
    expect(container.querySelector("[data-testid='kind-frame-meta-status']")?.textContent).toContain("in-flight");
    // body 仍渲染在 frame 内。
    expect(container.querySelector("[data-testid='md-heading-1']")?.textContent).toContain("Background");
  });

  it("renders a feature-shipped kind with its summary strip when frontmatter.summary is present", () => {
    const content = `---
kind: feature-shipped
title: Plugin primitive shipped
summary: Plugin support landed in 0.3.1 with G-Stack and Obra Superpowers packs.
---

Body content.`;
    const { container } = render(<MarkdownViewer content={content} hideFrontmatter />);
    expect(container.querySelector("[data-testid='kind-frame-feature-shipped']")).toBeTruthy();
    expect(container.querySelector("[data-testid='kind-frame-summary']")?.textContent).toContain("Plugin support landed");
  });

  it("falls through to plain markdown when kind is unknown (graceful degradation)", () => {
    const content = `---
kind: not-a-real-kind
title: Just text
---

Body content.`;
    const { container } = render(<MarkdownViewer content={content} hideFrontmatter />);
    expect(container.querySelector("[data-testid^='kind-frame']")).toBeNull();
    expect(container.querySelector("[data-testid='markdown-viewer-rendered']")).toBeTruthy();
  });

  it("falls through to plain markdown when no frontmatter is present at all", () => {
    const { container } = render(<MarkdownViewer content="Just a paragraph." hideFrontmatter />);
    expect(container.querySelector("[data-testid^='kind-frame']")).toBeNull();
    expect(container.querySelector("[data-testid='md-paragraph']")?.textContent).toContain("Just a paragraph.");
  });
});

describe("HG-2 — fenced-block grammars", () => {
  it("renders a ```timeline``` block as a DotTimeline primitive", () => {
    const content = `---
kind: incident-timeline
---

\`\`\`timeline
- time: "2026-05-09 14:02"
  status: success
  title: Plugin primitive design landed
  body: DESIGN.md authored
- time: "2026-05-09 16:30"
  status: warning
  title: Hooks pivot
  body: Decision to rip hooks scaffolding
\`\`\`
`;
    const { container } = render(<MarkdownViewer content={content} hideFrontmatter />);
    expect(container.querySelector("[data-testid='fenced-block-timeline']")).toBeTruthy();
    expect(container.querySelector("[data-testid='primitive-dot-timeline-entry-0']")?.textContent).toContain("Plugin primitive design landed");
    expect(container.querySelectorAll("[data-testid^='primitive-dot-timeline-entry-']").length).toBe(2);
  });

  it("renders a ```stats``` block as a StatCardBand primitive", () => {
    const content = `\`\`\`stats
- label: Slices in 0.3.1
  value: 10
  trend: up
- label: Driver seats
  value: 3
\`\`\`
`;
    const { container } = render(<MarkdownViewer content={content} hideFrontmatter />);
    expect(container.querySelector("[data-testid='fenced-block-stats']")).toBeTruthy();
    expect(container.querySelector("[data-testid='primitive-stat-card-0']")?.textContent).toContain("10");
    expect(container.querySelector("[data-testid='primitive-stat-card-0']")?.textContent).toContain("↑");
  });

  it("renders a ```risk-table``` block as a RiskTableGrid primitive", () => {
    const content = `\`\`\`risk-table
- risk: Hooks may not fire reliably
  probability: low
  impact: high
  mitigation: Phase 3b dogfood
\`\`\`
`;
    const { container } = render(<MarkdownViewer content={content} hideFrontmatter />);
    expect(container.querySelector("[data-testid='fenced-block-risk-table']")).toBeTruthy();
    expect(container.querySelector("[data-testid='primitive-risk-row-0']")?.textContent).toContain("Hooks may not fire reliably");
  });

  it("renders a ```compare``` block as a CompareTable primitive", () => {
    const content = `\`\`\`compare
columns: [Old approach, New approach]
rows:
  - label: Editability
    values: [Hard, Easy]
\`\`\`
`;
    const { container } = render(<MarkdownViewer content={content} hideFrontmatter />);
    expect(container.querySelector("[data-testid='fenced-block-compare']")).toBeTruthy();
    expect(container.querySelector("[data-testid='primitive-compare-row-0']")?.textContent).toContain("Easy");
  });

  it("renders a ```slate``` block as a TLDRSlate primitive", () => {
    const content = "```slate\nTL;DR text. Three sentences. Renders dark.\n```\n";
    const { container } = render(<MarkdownViewer content={content} hideFrontmatter />);
    expect(container.querySelector("[data-testid='fenced-block-slate']")).toBeTruthy();
    expect(container.querySelector("[data-testid='fenced-block-slate']")?.textContent).toContain("TL;DR text");
  });

  it("falls back to a labeled error box when a fenced block fails to parse", () => {
    const content = "```timeline\n[broken yaml\n```\n";
    const { container } = render(<MarkdownViewer content={content} hideFrontmatter />);
    expect(container.querySelector("[data-testid='fenced-block-timeline-fallback']")).toBeTruthy();
    expect(container.querySelector("[data-testid='fenced-block-timeline-fallback']")?.textContent).toContain("回退");
  });

  it("leaves unknown fenced-block languages (e.g. python) to the standard SyntaxHighlight renderer", () => {
    const content = "```python\nprint('hello')\n```\n";
    const { container } = render(<MarkdownViewer content={content} hideFrontmatter />);
    expect(container.querySelector("[data-testid^='fenced-block-']")).toBeNull();
    // 标准 code-block 渲染路径仍触发。
    expect(container.textContent).toContain("print");
  });
});

describe("HG-3 — plain markdown still renders identically when no convention is used", () => {
  it("renders headings, lists, paragraphs, tables, and plain code blocks without any kind frame or fenced primitives", () => {
    const content = `# Heading

A paragraph.

- list item one
- list item two

\`\`\`
plain code block
\`\`\`
`;
    const { container } = render(<MarkdownViewer content={content} hideFrontmatter />);
    expect(container.querySelector("[data-testid^='kind-frame']")).toBeNull();
    expect(container.querySelector("[data-testid^='fenced-block-']")).toBeNull();
    expect(container.querySelector("[data-testid='md-heading-1']")).toBeTruthy();
    expect(container.querySelector("[data-testid='md-list-ul']")).toBeTruthy();
    expect(container.querySelector("[data-testid='md-paragraph']")).toBeTruthy();
  });
});
