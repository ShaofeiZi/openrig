// Operator Surface Reconciliation v0——MarkdownViewer 原文/渲染切换测试。
//
// 第 4 项：页头栏开关在渲染模式（默认，即 MarkdownViewer 的常规块渲染）与原文模式
//（等宽预格式化文本 + 可见 Markdown 源码）之间切换。除非设置 hideFrontmatter，原文模式
// 仍会渲染 frontmatter 元数据头。hideRawToggle 属性可为不需要此装饰的调用方
//（如 PriorityStackPanel）隐藏开关。

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MarkdownViewer } from "../src/components/markdown/MarkdownViewer.js";

afterEach(() => cleanup());

const SAMPLE_MD = `---\nslice: foo\n---\n# Heading\n- list item`;

describe("OSR v0 — MarkdownViewer raw/rendered toggle", () => {
  it("default mode is rendered; toggle buttons present", () => {
    render(<MarkdownViewer content={SAMPLE_MD} />);
    expect(screen.getByTestId("markdown-viewer").getAttribute("data-mode")).toBe("rendered");
    expect(screen.getByTestId("markdown-viewer-mode-rendered").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("markdown-viewer-mode-raw").getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("markdown-viewer-mode-rendered").textContent).toContain("渲染视图");
    expect(screen.getByTestId("markdown-viewer-mode-raw").textContent).toContain("原文");
    expect(screen.getByTestId("markdown-frontmatter").textContent).toContain("前置元数据");
    expect(screen.getByTestId("markdown-viewer-rendered")).toBeDefined();
  });

  it("clicking raw toggle switches mode + renders source verbatim", () => {
    render(<MarkdownViewer content={SAMPLE_MD} />);
    fireEvent.click(screen.getByTestId("markdown-viewer-mode-raw"));
    expect(screen.getByTestId("markdown-viewer").getAttribute("data-mode")).toBe("raw");
    expect(screen.getByTestId("markdown-viewer-mode-raw").getAttribute("data-active")).toBe("true");
    const raw = screen.getByTestId("markdown-viewer-raw");
    expect(raw.textContent).toContain("# Heading");
    expect(raw.textContent).toContain("- list item");
    expect(screen.queryByTestId("markdown-viewer-rendered")).toBeNull();
  });

  it("frontmatter metadata header still renders in raw mode", () => {
    render(<MarkdownViewer content={SAMPLE_MD} />);
    fireEvent.click(screen.getByTestId("markdown-viewer-mode-raw"));
    expect(screen.getByTestId("markdown-frontmatter").textContent).toContain("foo");
  });

  it("hideRawToggle hides the toggle entirely (caller renders only one mode)", () => {
    render(<MarkdownViewer content={SAMPLE_MD} hideRawToggle />);
    expect(screen.queryByTestId("markdown-viewer-mode-toggle")).toBeNull();
    expect(screen.queryByTestId("markdown-viewer-mode-raw")).toBeNull();
  });

  it("toggling back to rendered from raw restores block render", () => {
    render(<MarkdownViewer content={SAMPLE_MD} />);
    fireEvent.click(screen.getByTestId("markdown-viewer-mode-raw"));
    fireEvent.click(screen.getByTestId("markdown-viewer-mode-rendered"));
    expect(screen.getByTestId("markdown-viewer").getAttribute("data-mode")).toBe("rendered");
    expect(screen.getByTestId("markdown-viewer-rendered")).toBeDefined();
    expect(screen.queryByTestId("markdown-viewer-raw")).toBeNull();
  });
});
