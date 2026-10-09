// qitem-markdown-bare-marker-loop——隔离的子渲染器。
//
// 使用裸列表标记行（标记后只有空白、没有文本）渲染真实 MarkdownViewer。修复前的解析器会让
// 外层列表守卫识别该行，却被内层条目捕获拒绝；随后在不推进游标的情况下 `break`，形成占满
// CPU 并耗尽堆的无限循环。
//
// 此 fixture 在独立进程中运行，设置较小的 --max-old-space-size 与父进程硬超时，因此可通过
// 非零退出/终止观察挂起，而不会连带拖垮 Vitest worker。
//
// 退出码为 0 的契约：解析器已终止，且裸标记可见地降级——标记文本保留在输出中，绝不静默丢弃。

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownViewer } from "../../src/components/markdown/MarkdownViewer.js";

// fixture 依次包含有效条目、裸标记行和更多真实内容，因此终止与降级均可观测。
const CONTENT = "1. real item\n- \n2. after the bare marker";

const html = renderToStaticMarkup(
  React.createElement(MarkdownViewer, { content: CONTENT, hideFrontmatter: true, hideRawToggle: true }),
);

// 降级必须可见，不能静默。需要满足两项义务：
//  (a) 裸标记行前后的原创内容仍然保留；
//  (b) 裸标记本身对操作员仍然可见；它可以降级为段落/原始标记文本，但绝不能被吞掉。
// (b) 在移除标签后的渲染文本上检查，因此只有 `<li>`/`<ul>` 元素不足以满足要求，
// 必须出现独立的 "-" token。
const text = html
  .replace(/<[^>]*>/g, "\n")   // 标签 → 边界，避免标记结构伪造 token。
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">");

const missing: string[] = [];
if (!text.includes("real item")) missing.push("real item");
if (!text.includes("after the bare marker")) missing.push("after the bare marker");
// 独立连字符 token：裸标记被渲染为可见文本。
if (!/(^|\s)-(\s|$)/m.test(text)) missing.push("visible bare '-' marker token");

if (missing.length > 0) {
  process.stderr.write(`SILENT_DROP: missing ${missing.join(", ")}\n`);
  process.exit(2);
}

process.stdout.write("TERMINATED_OK\n");
process.exit(0);
