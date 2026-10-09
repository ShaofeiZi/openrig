// 切片故事视图 v0 + UI 增强包 v0 —— 文档标签页。
//
// 双栏布局：左侧 = 文件树（切片文件夹 + 后代），
// 右侧 = 所选文件的懒加载 Markdown 查看器。
//
// UI 增强包 v0 第 2 项：右侧窗格现在通过新的 MarkdownViewer 渲染 Markdown
//（YAML frontmatter 作为元数据头、带语法高亮的代码块、列表、表格、链接、
// 图片、按 carved-out 预留的 mermaid 占位）。v0 的纯 `<pre>` 回退
// 对非 `.md` 文件保留。
//
// 图片 src 解析：`.md` 内容中的相对路径在适用时对照切片的 proof-asset
// 端点解析。UI 增强包 v1 可将此扩展到切片的 docs 端点，
// 前提是后台服务为切片文档添加类似的静态资源路径。

import { useState } from "react";
import type { DocsTreeEntry } from "../../../hooks/useSlices.js";
import { useSliceDoc } from "../../../hooks/useSlices.js";
import { MarkdownViewer } from "../../markdown/MarkdownViewer.js";
import { ToolMark } from "../../graphics/RuntimeMark.js";

export function DocsTab({ sliceName, tree }: { sliceName: string; tree: DocsTreeEntry[] }) {
  const initial = tree.find((e) => e.type === "file" && e.name === "README.md")?.relPath
    ?? tree.find((e) => e.type === "file" && e.name === "IMPLEMENTATION-PRD.md")?.relPath
    ?? tree.find((e) => e.type === "file")?.relPath
    ?? null;
  const [selected, setSelected] = useState<string | null>(initial);
  const doc = useSliceDoc(sliceName, selected);

  return (
    <div data-testid="docs-tab" className="flex h-full flex-col sm:flex-row">
      <aside className="w-full max-h-48 shrink-0 overflow-y-auto border-b border-outline-variant bg-background p-2 sm:w-56 sm:max-h-none sm:border-b-0 sm:border-r" data-testid="docs-tree">
        {tree.length === 0 && (
          <div className="font-mono text-[10px] text-on-surface-variant">切片文件夹为空。</div>
        )}
        {tree.map((entry) => (
          <button
            key={entry.relPath}
            type="button"
            data-testid={`docs-tree-${entry.relPath}`}
            data-selected={entry.relPath === selected}
            disabled={entry.type === "dir"}
            onClick={() => entry.type === "file" && setSelected(entry.relPath)}
            className={`block w-full text-left font-mono text-[10px] ${
              entry.type === "dir"
                ? "py-1 text-on-surface-variant"
                : `cursor-pointer py-1 hover:bg-surface-low ${entry.relPath === selected ? "bg-surface-high/80 text-on-surface" : "text-on-surface"}`
            }`}
            style={{ paddingLeft: `${(entry.relPath.split("/").length - 1) * 0.75 + 0.25}rem` }}
          >
            <span className="inline-flex min-w-0 items-center gap-1.5">
              {entry.type === "dir" ? (
                <ToolMark tool="folder" size="xs" decorative />
              ) : (
                <ToolMark tool={entry.name} size="xs" decorative />
              )}
              <span className="truncate">{entry.name}</span>
            </span>
          </button>
        ))}
      </aside>
      <main className="flex-1 min-w-0 overflow-y-auto bg-surface-lowest" data-testid="docs-viewer">
        {!selected && (
          <div className="m-auto p-4 font-mono text-[10px] text-on-surface-variant">从树中选择一个文件</div>
        )}
        {selected && doc.isLoading && (
          <div className="p-4 font-mono text-[10px] text-on-surface-variant">加载中…</div>
        )}
        {selected && doc.isError && (
          <div className="p-4 font-mono text-[10px] text-red-600">加载文档时出错。</div>
        )}
        {selected && doc.data && (
          <div data-testid="docs-viewer-content" className="p-4">
            {selected.toLowerCase().endsWith(".md") ? (
              <MarkdownViewer content={doc.data.content} />
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-on-surface">
                {doc.data.content}
              </pre>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
