// UI Enhancement Pack v0——MarkdownViewer 聚焦测试。
//
// 锁定承重渲染原语，使内联 parser 未来重构（如后续换 marked /
// react-markdown 库）保留 operator 可见行为。

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MarkdownViewer } from "../src/components/markdown/MarkdownViewer.js";

afterEach(() => cleanup());

describe("UI Enhancement Pack v0 — MarkdownViewer", () => {
  it("renders YAML frontmatter as a metadata header above the body", () => {
    const md = `---\nslice: my-slice\nstatus: active\n---\n# Title\nbody text`;
    render(<MarkdownViewer content={md} />);
    const fm = screen.getByTestId("markdown-frontmatter");
    expect(fm.textContent).toContain("slice");
    expect(fm.textContent).toContain("my-slice");
    expect(fm.textContent).toContain("status");
    expect(fm.textContent).toContain("active");
  });

  it("hides frontmatter when hideFrontmatter prop is true", () => {
    const md = `---\nslice: x\n---\n# Title`;
    render(<MarkdownViewer content={md} hideFrontmatter />);
    expect(screen.queryByTestId("markdown-frontmatter")).toBeNull();
  });

  it("renders headings with proper levels (# / ## / ### / ####)", () => {
    const md = `# H1\n\n## H2\n\n### H3\n\n#### H4`;
    render(<MarkdownViewer content={md} />);
    expect(screen.getByTestId("md-heading-1").textContent).toBe("H1");
    expect(screen.getByTestId("md-heading-2").textContent).toBe("H2");
    expect(screen.getByTestId("md-heading-3").textContent).toBe("H3");
    expect(screen.getByTestId("md-heading-4").textContent).toBe("H4");
  });

  it("renders bullet lists with depth from indentation", () => {
    const md = `- top-level\n  - nested-1\n    - nested-2`;
    render(<MarkdownViewer content={md} />);
    const list = screen.getByTestId("md-list-ul");
    const items = list.querySelectorAll("li");
    expect(items).toHaveLength(3);
  });

  it("renders ordered lists", () => {
    const md = `1. first\n2. second`;
    render(<MarkdownViewer content={md} />);
    expect(screen.getByTestId("md-list-ol").querySelectorAll("li")).toHaveLength(2);
  });

  it("renders fenced code blocks with the SyntaxHighlight component (per language)", () => {
    const md = "```ts\nconst x = 1;\n```";
    render(<MarkdownViewer content={md} />);
    const block = screen.getByTestId("syntax-highlight-block");
    expect(block.getAttribute("data-language")).toBe("ts");
    expect(block.textContent).toContain("const");
    expect(block.textContent).toContain("x");
  });

  it("renders mermaid code blocks as a placeholder per item 2 carve-out (no library bundled at v0)", () => {
    const md = "```mermaid\ngraph TD\n  A-->B\n```";
    render(<MarkdownViewer content={md} />);
    const placeholder = screen.getByTestId("md-mermaid-placeholder");
    expect(placeholder.textContent).toContain("mermaid");
    const btn = screen.getByTestId("md-mermaid-render-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("renders inline code with `...` syntax", () => {
    const md = `paragraph with \`inline code\` here`;
    render(<MarkdownViewer content={md} />);
    expect(screen.getByTestId("md-inline-code").textContent).toBe("inline code");
  });

  it("renders inline links with [text](url)", () => {
    const md = `see [the docs](https://example.com/docs)`;
    render(<MarkdownViewer content={md} />);
    const link = screen.getByTestId("md-inline-link") as HTMLAnchorElement;
    expect(link.textContent).toBe("the docs");
    expect(link.getAttribute("href")).toBe("https://example.com/docs");
  });

  it("renders inline images with relative src resolved against assetBasePath", () => {
    const md = `![diagram](shots/foo.png)`;
    render(<MarkdownViewer content={md} assetBasePath="/api/files/asset?root=ws&path=docs" />);
    const img = screen.getByTestId("md-inline-image") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/files/asset?root=ws&path=docs/shots/foo.png");
  });

  it("absolute URLs in image src pass through unchanged", () => {
    const md = `![remote](https://example.com/img.png)`;
    render(<MarkdownViewer content={md} assetBasePath="/api/files/asset?root=ws" />);
    const img = screen.getByTestId("md-inline-image") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("https://example.com/img.png");
  });

  it("renders tables with header + body rows", () => {
    const md = `| col-a | col-b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |`;
    render(<MarkdownViewer content={md} />);
    const wrapper = screen.getByTestId("md-table-wrapper");
    const headers = wrapper.querySelectorAll("thead th");
    expect(headers).toHaveLength(2);
    const bodyRows = wrapper.querySelectorAll("tbody tr");
    expect(bodyRows).toHaveLength(2);
  });

  it("renders bold (**) and italic (*) inline emphasis", () => {
    const md = `paragraph with **bold** and *italic* text`;
    render(<MarkdownViewer content={md} />);
    const para = screen.getByTestId("md-paragraph");
    expect(para.querySelector("strong")?.textContent).toBe("bold");
    expect(para.querySelector("em")?.textContent).toBe("italic");
  });
});

// ---------------------------------------------------------------------------
// qitem-render-driver D2——作者有序列表编号 + 缩进续行。根
//（MarkdownViewer.tsx）：parser 捕获 indent+text 但丢弃数值
//（:167-172），renderer 发出无 start=/value= 的
// <ol class="list-decimal">（:302-312），故 CSS 从 1 重新编号。
// list collector（:168）仅在自身以 marker 开头的行上继续，故悬挂缩进
// 续行退出 list 并成为独立段落（:199-209）。
//
// 序号 fixture 故意非连续（3. 然后 5.）：仅 `<ol start="3">` 的修复
// 渲染 3,4，此处仍必须失败。
// ---------------------------------------------------------------------------

describe("qitem-render-driver D2 — authored ordinals + continuation containment", () => {
  it("RED: non-consecutive authored ordinals 3. and 5. both survive (start=3 alone renders 3,4 and must fail)", () => {
    const { container } = render(<MarkdownViewer content={"3. three\n5. five"} hideFrontmatter hideRawToggle />);
    const items = Array.from(container.querySelectorAll("li"));
    expect(items).toHaveLength(2);
    // 序号语义，无论修复如何携带（per-item value= 或等价显式数字）——
    // 读回为有效序号。
    const ordinals = items.map((li) => {
      const v = li.getAttribute("value");
      if (v) return Number(v);
      const ol = li.closest("ol");
      const start = ol?.getAttribute("start");
      const idx = ol ? Array.from(ol.children).indexOf(li) : 0;
      return start ? Number(start) + idx : idx + 1;
    });
    expect(ordinals, "authored 3. and 5. must both render as authored").toEqual([3, 5]);
  });

  it("RED: an indented continuation stays INSIDE its list item (no detached sibling paragraph)", () => {
    const { container } = render(<MarkdownViewer content={"1. item\n    continued here"} hideFrontmatter hideRawToggle />);
    const items = Array.from(container.querySelectorAll("li"));
    expect(items, "the continuation must not open a second item").toHaveLength(1);
    expect(items[0]!.textContent, "one li holds marker text AND its continuation").toContain("item");
    expect(items[0]!.textContent, "one li holds marker text AND its continuation").toContain("continued here");
    const strayParagraph = Array.from(container.querySelectorAll("p")).some((p) => (p.textContent ?? "").includes("continued here"));
    expect(strayParagraph, "no sibling <p> may carry the continuation").toBe(false);
  });

  // 保留锁——必须保持 GREEN。按 guard：断言无 throw / 无静默丢弃，
  // 而非冻结错误的 DOM 编号模型。
  it("GREEN pin: bullets, nesting, and mixed ordered+unordered render without throw or content loss", () => {
    const mixed = "- alpha\n  - nested-alpha\n1. one\n- beta";
    const { container } = render(<MarkdownViewer content={mixed} hideFrontmatter hideRawToggle />);
    const text = container.textContent ?? "";
    for (const token of ["alpha", "nested-alpha", "one", "beta"]) {
      expect(text, `mixed list content must not be dropped: ${token}`).toContain(token);
    }
    expect(container.querySelectorAll("li").length).toBeGreaterThanOrEqual(4);
  });

  it("GREEN pin: malformed/ragged list input degrades without throwing and keeps its text", () => {
    // 注意：裸 marker 行（"- " / "1. "）此处故意排除——它触发 parser
    // 无限循环（MarkdownViewer.tsx:164-176 break 而不推进 i），使 runner
    // OOM。该 hang 作为独立跟踪缺陷报告，有其自己的有界 RED，故本锁聚焦
    // 于参差但终止的输入。
    const ragged = "1.\n   \n2. real item\nplain trailing prose";
    const { container } = render(<MarkdownViewer content={ragged} hideFrontmatter hideRawToggle />);
    const text = container.textContent ?? "";
    expect(text).toContain("real item");
    expect(text).toContain("plain trailing prose");
  });
});

// ---------------------------------------------------------------------------
// qitem-markdown-bare-marker-loop（CRITICAL）——parser 必须在裸 list
// marker 上终止。
//
// 根（MarkdownViewer.tsx:164-176）：外层守卫按
// `/^\s*([-*]|\d+\.)\s+/`（marker + 空白）识别 list 行，而内层捕获
// 另经 `/^(\s*)([-*]|\d+\.)\s+(.+)$/` 要求文本。一行仅 marker+空白无文本
// ——尾部 "- " 或 "1. "，在任何 authored README/PRD 中都可能——满足外层守卫、
// 内层匹配失败，并命中 `if (!m) break;` 而不推进 `i`。外层循环永远重读同一行：
// CPU 钉死 + 堆耗尽（browser-tab hang）。
//
// 安全：渲染在隔离子进程中运行（自有低堆上限 + 硬超时/kill），绝不在此
// Vitest worker——此处直接渲染会 hang 或 OOM CI 而非失败。修复前子进程超时
// 或非零退出；修复后它必须在界限内 exit 0 且显示可见降级。
// ---------------------------------------------------------------------------

describe("qitem-markdown-bare-marker-loop — parser terminates on a bare list marker", () => {
  it("RED: an isolated render of a bare-marker document terminates within the bound and degrades visibly", async () => {
    const { spawn } = await import("node:child_process");
    const path = await import("node:path");
    const childScript = path.resolve(import.meta.dirname, "fixtures/markdown-bare-marker-child.tsx");
    const runner = path.resolve(import.meta.dirname, "../../../node_modules/.bin/tsx");

    const outcome = await new Promise<{ code: number | null; signal: string | null; killed: boolean; out: string; err: string }>((resolve) => {
      const child = spawn(runner, [childScript], {
        cwd: path.resolve(import.meta.dirname, ".."),
        // 低堆，使失控 parser 快速死亡而非吃光机器。
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=256" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      let killed = false;
      // 有界 stdout/stderr，使 OOM backtrace 不在这里气球式膨胀内存。
      const CAP = 8_000;
      child.stdout.on("data", (c: Buffer) => { if (out.length < CAP) out += c.toString("utf8"); });
      child.stderr.on("data", (c: Buffer) => { if (err.length < CAP) err += c.toString("utf8"); });
      const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, 5_000);
      child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, killed, out, err }); });
      child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, signal: null, killed, out, err: err + String(e) }); });
    });

    expect(
      outcome.killed,
      `parser must TERMINATE on a bare list marker — child hit the 5s bound (infinite loop). stderr: ${outcome.err.slice(0, 300)}`,
    ).toBe(false);
    // 此处 exit 134 / SIGABRT 是 V8 的 OOM abort：失控 parser 耗尽子进程
    // 256MB 上限。显式呈现，使 RED 读作它本来的无限循环，而非不透明的
    // 非零退出。
    expect(
      outcome.code,
      `child must exit 0 (terminated + visible degradation); got code=${outcome.code} signal=${outcome.signal}` +
        `${outcome.code === 134 ? " — V8 OOM abort, i.e. the bare-marker infinite loop" : ""}. stderr: ${outcome.err.slice(0, 300)}`,
    ).toBe(0);
    expect(outcome.out).toContain("TERMINATED_OK");
  }, 20_000);
});
