// OPR.0.4.1.21——产物页签：按层级限定范围的文件导航器。
//
// 对现有 /api/files/* 端点的只读投影：左侧为目录树，展开时按目录延迟请求 /list；
// 右侧为所选目录的文件列表，类型徽标来自扩展名，大小和 mtime 直接来自 /list。
// 文件正文只在打开时加载（FileLink → SharedDetailDrawer → /read 或 /asset）。
// 不新增端点，也不新增写入或安全界面；沿用后台服务现有路由的白名单和路径穿越守卫。
//
// 延迟加载边界（吸取 slice-17 过度获取的教训，见
// feedback_new_default_tab_flips_every_active_neq_guard）：首次进入只获取 /roots 和
// /list(base)；展开目录时获取该目录的 /list；打开文件时才获取 /read 或 /asset。折叠目录向
// useFilesList 传入 root=null，使查询禁用（enabled:!!root）；绝不预遍历目录树，也不在首次进入
// 或渲染目录树时提前获取任何文件正文。

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useFilesRoots, useFilesList } from "../../hooks/useFiles.js";
import { resolveScopePathToAllowlist } from "../../hooks/useScopeMarkdown.js";
import { FileLink } from "../ui/FileLink.js";
import { EmptyState } from "../ui/empty-state.js";

function isUnavailable(data: unknown): data is { unavailable: true; error: string; hint?: string } {
  return Boolean(data && typeof data === "object" && "unavailable" in (data as Record<string, unknown>));
}

/** 根据文件扩展名生成类型徽标（由 UI 派生；模型图展示 MD / DIFF / PNG）。 */
function fileBadge(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0 || idx === name.length - 1) return "···";
  return name.slice(idx + 1).toUpperCase();
}

/** 直接使用 /list 条目中的大小（字节 → 人类可读 KB）。 */
function formatSize(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** 直接使用 /list 条目中的 mtime（ISO → "MM-DD HH:mm"）。 */
function formatMtime(mtime: string | null): string {
  if (!mtime) return "—";
  const d = new Date(mtime);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

function baseName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

// 左侧：单个目录节点，仅在展开时延迟列出子项。
function FolderNode({
  root,
  path,
  label,
  depth,
  selectedFolder,
  onSelectFolder,
  defaultExpanded = false,
}: {
  root: string;
  path: string;
  label: string;
  depth: number;
  selectedFolder: string;
  onSelectFolder: (path: string) => void;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  // 延迟边界：仅在展开时传入 root，使 useFilesList 在折叠期间禁用
  //（enabled:!!root）；折叠目录不获取任何内容。
  const list = useFilesList(expanded ? root : null, path);
  const entries = list.data?.entries ?? [];
  const isSelected = selectedFolder === path;
  const indent = (d: number) => ({ paddingLeft: `${d * 12 + 4}px` });

  return (
    <li data-testid={`artifacts-tree-node-${path}`}>
      <div
        className={`flex items-center gap-1 font-mono text-[11px] ${
          isSelected ? "bg-surface-high/80 text-on-surface" : "text-on-surface hover:bg-surface-low"
        }`}
        style={indent(depth)}
      >
        <button
          type="button"
          aria-label={expanded ? `折叠 ${label}` : `展开 ${label}`}
          data-testid={`artifacts-tree-toggle-${path}`}
          onClick={() => setExpanded((e) => !e)}
          className="flex h-4 w-4 shrink-0 items-center justify-center"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
        <button
          type="button"
          data-testid={`artifacts-tree-folder-${path}`}
          data-selected={isSelected}
          onClick={() => {
            setExpanded(true);
            onSelectFolder(path);
          }}
          className="flex-1 truncate py-0.5 text-left"
        >
          {label}/
        </button>
      </div>
      {expanded ? (
        list.isLoading ? (
          <div style={indent(depth + 1)} className="py-0.5 font-mono text-[10px] text-on-surface-variant">
            加载中…
          </div>
        ) : list.isError ? (
          <div
            data-testid={`artifacts-tree-error-${path}`}
            style={indent(depth + 1)}
            className="py-0.5 font-mono text-[10px] text-red-600"
          >
            加载文件夹出错。
          </div>
        ) : (
          <ul>
            {entries
              .filter((e) => e.type === "dir")
              .map((e) => (
                <FolderNode
                  key={e.name}
                  root={root}
                  path={joinPath(path, e.name)}
                  label={e.name}
                  depth={depth + 1}
                  selectedFolder={selectedFolder}
                  onSelectFolder={onSelectFolder}
                />
              ))}
            {entries
              .filter((e) => e.type === "file")
              .map((e) => (
                <li key={e.name}>
                  {/* Depth indentation lives on the full-width FileLink button, NOT
                      the inert li, so the whole indented row is the hit target.
                      paddingLeft = the moved li indent (indent(depth+1) = *12+4) plus
                      the button's former pl-5 (20px) glyph inset, folded into one
                      inline value so the prior visual indentation is preserved. */}
                  <FileLink
                    root={root}
                    path={joinPath(path, e.name)}
                    testId={`artifacts-tree-file-${joinPath(path, e.name)}`}
                    style={{ paddingLeft: `${(depth + 1) * 12 + 24}px` }}
                    className="block w-full truncate py-0.5 text-left font-mono text-[11px] text-on-surface-variant hover:text-on-surface hover:underline"
                  >
                    {e.name}
                  </FileLink>
                </li>
              ))}
          </ul>
        )
      ) : null}
    </li>
  );
}

// 右侧：所选目录的文件列表（元数据而非正文）。
function FolderFileList({ root, path }: { root: string; path: string }) {
  const list = useFilesList(root, path);
  const files = (list.data?.entries ?? []).filter((e) => e.type === "file");
  const header = `${(path || root).toUpperCase()} · ${files.length} 个文件`;

  return (
    <div data-testid="artifacts-file-list" className="min-w-0 flex-1">
      <div
        data-testid="artifacts-file-list-header"
        className="border-b border-outline-variant px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant"
      >
        {header}
      </div>
      {list.isLoading ? (
        <div className="px-3 py-2 font-mono text-[10px] text-on-surface-variant">加载中…</div>
      ) : list.isError ? (
        <div data-testid="artifacts-file-list-error" className="px-3 py-2 font-mono text-[10px] text-red-600">
          加载文件夹出错。
        </div>
      ) : files.length === 0 ? (
        <div data-testid="artifacts-file-list-empty" className="px-3 py-2 font-mono text-[10px] text-on-surface-variant">
          此文件夹中无文件。
        </div>
      ) : (
        <ul className="divide-y divide-outline-variant/60">
          {files.map((f) => (
            <li
              key={f.name}
              data-testid={`artifacts-file-row-${f.name}`}
              className="font-mono text-[11px]"
            >
              {/* The ENTIRE row is one FileLink hitbox — badge, filename, size,
                  separator, and mtime all sit inside the existing button so a click
                  anywhere on the row opens the file, not only the filename glyphs.
                  The row layout (flex/gap/padding) moves onto the button; all
                  testids/text/order and the per-cell styles are preserved. */}
              <FileLink
                root={root}
                path={joinPath(path, f.name)}
                testId={`artifacts-file-open-${f.name}`}
                className="group flex w-full items-center gap-3 px-3 py-1.5 text-left"
              >
                <span
                  data-testid={`artifacts-file-badge-${f.name}`}
                  className="w-10 shrink-0 border border-outline-variant px-1 py-0.5 text-center text-[8px] uppercase tracking-[0.08em] text-on-surface-variant"
                >
                  {fileBadge(f.name)}
                </span>
                {/* Full row is the hitbox (group), but only the filename underlines
                    on hover — preserving the pre-fix per-cell decoration. */}
                <span className="min-w-0 flex-1 truncate text-on-surface group-hover:underline">{f.name}</span>
                <span data-testid={`artifacts-file-size-${f.name}`} className="shrink-0 text-on-surface-variant">
                  {formatSize(f.size)}
                </span>
                <span className="shrink-0 text-on-surface-variant">·</span>
                <span data-testid={`artifacts-file-mtime-${f.name}`} className="shrink-0 text-on-surface-variant">
                  {formatMtime(f.mtime)}
                </span>
              </FileLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 按层级限定范围的产物文件导航器。
 * @param scopePath 当前层级目录的绝对文件系统路径（任务层级为任务目录，切片层级为切片目录）；
 *   通过 useScopeMarkdown 所用的同一解析器解析为白名单中的 (root, relPath)。
 * @param scopeLabel 目录树根标签，例如任务名或切片名。
 */
export function ArtifactsNavigator({ scopePath, scopeLabel, remoteGated }: { scopePath: string | null; scopeLabel: string; remoteGated?: boolean }) {
  // OPR.0.4.6.MH2 guard-B1：选择远程主机时，范围路径属于远程文件系统，绝不能依据本地
  // 白名单根目录解析。remoteGated 不发出任何文件请求，并显示如实说明。本地空路径流程保持
  // 字节不变（获取 roots 并渲染 OUT OF SCOPE）；守卫取决于显式属性，而非是否为 null。
  const rootsQuery = useFilesRoots({ enabled: remoteGated !== true });
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);

  if (remoteGated) {
    return (
      <EmptyState
        label="不显示本地文件"
        description={`${scopeLabel} 的产物位于所选主机的文件系统上，远程只读视图不会浏览它。请选择本地主机以浏览本地产物。`}
        variant="card"
        testId="artifacts-navigator-remote-gated"
      />
    );
  }

  if (rootsQuery.isLoading) {
    return (
      <div data-testid="artifacts-navigator-loading" className="font-mono text-[11px] text-on-surface-variant">
        加载中…
      </div>
    );
  }
  // “未配置白名单”会从 /api/files/roots 以两种方式出现：503 `unavailable` 哨兵，或 200 加
  // { roots: [], hint }（未设置 OPENRIG_FILES_ALLOWLIST 时 files.ts 返回后者）。两者都必须渲染
  // 相同的设置提示；没有白名单的用户需要操作说明，而不是误导性的“无产物/超出范围”
  //（AC-5；rev1-r2 补漏）。
  if (!rootsQuery.data || isUnavailable(rootsQuery.data) || rootsQuery.data.roots.length === 0) {
    return (
      <EmptyState
        label="文件不可用"
        description={
          rootsQuery.data?.hint ||
          "未配置允许列表文件根，因此产物导航器无法列出文件。请配置一个工作区文件根以浏览产物。"
        }
        variant="card"
        testId="artifacts-navigator-unavailable"
      />
    );
  }

  const resolved = scopePath ? resolveScopePathToAllowlist(rootsQuery.data.roots, scopePath) : null;
  if (!resolved) {
    return (
      <EmptyState
        label="产物超出范围"
        description="此范围的文件夹不在任何已配置的文件根之下，因此无法列出其产物。"
        variant="card"
        testId="artifacts-navigator-no-scope"
      />
    );
  }

  const root = resolved.rootName;
  const basePath = resolved.relPath;
  // 默认选择当前层级的基础目录，因此首次进入只获取 /roots 和 /list(base)；目录树根与右侧列表
  // 共享同一查询键并去重。
  const activeFolder = selectedFolder ?? basePath;

  return (
    <div
      data-testid="artifacts-navigator"
      className="flex min-h-[20rem] border border-outline-variant bg-surface-lowest/20"
    >
      <aside
        data-testid="artifacts-tree"
        className="w-64 shrink-0 overflow-y-auto border-r border-outline-variant py-1"
      >
        <ul>
          <FolderNode
            root={root}
            path={basePath}
            label={scopeLabel || baseName(basePath) || root}
            depth={0}
            selectedFolder={activeFolder}
            onSelectFolder={setSelectedFolder}
            defaultExpanded
          />
        </ul>
      </aside>
      <FolderFileList root={root} path={activeFolder} />
    </div>
  );
}
