// UI 增强包 v0——文件浏览器工作区。
//
// /files 路由的顶层中心工作区界面，采用双窗格布局：
//   - 左侧：白名单根目录选择器和所选根目录的目录树。
//   - 右侧：文件内容面板（Markdown 由 MarkdownViewer 渲染，代码由 SyntaxHighlight 渲染，
//     图片行内显示，其他类型提供“以文本查看”操作）。
//
// 已集成第 4 项（编辑模式）：标题栏开关可将右侧窗格切换为带保存/取消操作的 `<textarea>`
// 编辑器；保存遵循后台服务的原子写入契约；按 PRD 建议，409 冲突时提供刷新操作。
// 第 4 项建议的初始方案采用轻量 `<textarea>`，不引入 CodeMirror。

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  fileAssetUrl,
  useFilesList,
  useFilesRead,
  useFilesRoots,
  useFilesWrite,
  type AllowlistRoot,
  type FileEntry,
  type FilesReadResponse,
  type FileWriteResult,
} from "../../hooks/useFiles.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";
import { SyntaxHighlight } from "../markdown/SyntaxHighlight.js";
import { useSpecReview } from "../../hooks/useSteering.js";
import { useWorkspace } from "../../hooks/useWorkspace.js";
import { WorkspaceKindBadge, resolveKindForPath } from "../WorkspaceKindBadge.js";

const TEXT_LIKE_EXTENSIONS = new Set([".md", ".txt", ".log", ".yaml", ".yml", ".json", ".js", ".jsx", ".ts", ".tsx", ".py", ".sh", ".bash", ".sql", ".css", ".html"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const DOWNLOAD_ONLY_EXTENSIONS = new Set([".zip", ".tar", ".gz", ".pdf", ".mp4", ".webm", ".mov"]);

function isUnavailable(data: unknown): data is { unavailable: true; error: string; hint?: string } {
  return Boolean(data && typeof data === "object" && "unavailable" in (data as Record<string, unknown>));
}

export function FilesWorkspace() {
  const roots = useFilesRoots();
  const workspace = useWorkspace();
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState<string>("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<boolean>(false);

  // 根目录返回后默认选中第一个。
  useEffect(() => {
    if (selectedRoot) return;
    if (!roots.data || isUnavailable(roots.data)) return;
    const first = roots.data.roots[0];
    if (first) setSelectedRoot(first.name);
  }, [roots.data, selectedRoot]);

  // 根目录变化时重置路径和所选文件。
  useEffect(() => {
    setCurrentPath("");
    setSelectedFile(null);
    setEditMode(false);
  }, [selectedRoot]);

  return (
    <div data-testid="files-workspace" className="flex h-full flex-col lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]">
      <header className="border-b border-outline-variant bg-background px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface-variant">工作区</div>
        <h1 className="font-headline text-xl font-bold tracking-tight text-on-surface">文件</h1>
      </header>
      {/* Slice 20 mobile: at narrow viewports the two-pane
          shape stacks vertically so the document panel claims full width
          on a phone. Tree pane caps at max-h-48 on mobile so the user
          can scroll past it to the content. Desktop (sm:) layout
          unchanged — horizontal flex + 288px tree column. */}
      <div className="flex flex-1 min-h-0 flex-col sm:flex-row">
        <aside data-testid="files-tree-pane" className="w-full max-h-48 shrink-0 overflow-y-auto border-b border-outline-variant bg-background sm:w-72 sm:max-h-none sm:border-b-0 sm:border-r">
          <RootSelector roots={roots.data} isLoading={roots.isLoading} selectedRoot={selectedRoot} onSelect={setSelectedRoot} workspace={workspace.data ?? null} />
          {selectedRoot && (
            <>
              <Breadcrumbs root={selectedRoot} path={currentPath} onNavigate={setCurrentPath} />
              <DirectoryTree
                root={selectedRoot}
                path={currentPath}
                onEnterDir={(rel) => { setCurrentPath(rel); setSelectedFile(null); }}
                onSelectFile={(rel) => { setSelectedFile(rel); setEditMode(false); }}
                selectedFile={selectedFile}
              />
            </>
          )}
        </aside>
        <main data-testid="files-content-pane" className="flex-1 min-w-0 overflow-y-auto bg-surface-lowest">
          {!selectedRoot && (
            <div className="m-auto p-4 font-mono text-[10px] text-on-surface-variant">
              选择一个允许列表根目录以浏览。
            </div>
          )}
          {selectedRoot && !selectedFile && (
            <div className="p-4 font-mono text-[10px] text-on-surface-variant" data-testid="files-no-selection">
              从树中选择一个文件。
            </div>
          )}
          {selectedRoot && selectedFile && (
            <FileContentPanel
              root={selectedRoot}
              path={selectedFile}
              editMode={editMode}
              onToggleEditMode={() => setEditMode((v) => !v)}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function RootSelector({
  roots,
  isLoading,
  selectedRoot,
  onSelect,
  workspace,
}: {
  roots: ReturnType<typeof useFilesRoots>["data"] | undefined;
  isLoading: boolean;
  selectedRoot: string | null;
  onSelect: (name: string) => void;
  workspace: import("../../hooks/useWorkspace.js").WhoamiWorkspaceUI | null;
}) {
  if (isLoading) return <div className="p-3 font-mono text-[10px] text-on-surface-variant">正在加载根目录…</div>;
  if (!roots) return null;
  if (isUnavailable(roots)) {
    return (
      <div data-testid="files-roots-unavailable" className="p-3 font-mono text-[10px] text-on-surface-variant">
        <div>文件路由不可用。</div>
        {roots.hint && <div className="mt-1 text-on-surface-variant">{roots.hint}</div>}
      </div>
    );
  }
  if (roots.roots.length === 0) {
    return (
      <div data-testid="files-roots-empty" className="p-3 font-mono text-[10px] text-on-surface-variant">
        <div>未配置任何允许列表根目录。</div>
        {roots.hint && <div className="mt-1 text-on-surface-variant">{roots.hint}</div>}
      </div>
    );
  }
  return (
    <div data-testid="files-root-selector" className="border-b border-outline-variant p-2">
      <div className="mb-1 font-mono text-[8px] uppercase tracking-[0.18em] text-on-surface-variant">根目录</div>
      <ul>
        {roots.roots.map((r: AllowlistRoot) => {
          const kind = resolveKindForPath(r.path, workspace);
          return (
            <li key={r.name}>
              <button
                type="button"
                data-testid={`files-root-${r.name}`}
                data-active={selectedRoot === r.name}
                onClick={() => onSelect(r.name)}
                className={`flex w-full items-center justify-between gap-2 px-2 py-1 text-left font-mono text-[10px] hover:bg-surface-low ${
                  selectedRoot === r.name ? "bg-surface-high/80 text-on-surface" : "text-on-surface"
                }`}
                title={r.path}
              >
                <span className="truncate">{r.name}</span>
                {kind && <WorkspaceKindBadge kind={kind} compact />}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Breadcrumbs({ root, path, onNavigate }: { root: string; path: string; onNavigate: (path: string) => void }) {
  const segments = path ? path.split("/") : [];
  return (
    <nav data-testid="files-breadcrumbs" className="flex flex-wrap items-baseline gap-1 border-b border-outline-variant px-2 py-1 font-mono text-[10px] text-on-surface">
      <button type="button" onClick={() => onNavigate("")} className="font-bold hover:underline">{root}</button>
      {segments.map((seg, idx) => {
        const accumulated = segments.slice(0, idx + 1).join("/");
        return (
          <span key={accumulated}>
            <span className="mx-0.5 text-on-surface-variant">/</span>
            <button type="button" onClick={() => onNavigate(accumulated)} className="hover:underline">
              {seg}
            </button>
          </span>
        );
      })}
    </nav>
  );
}

function DirectoryTree({
  root,
  path,
  onEnterDir,
  onSelectFile,
  selectedFile,
}: {
  root: string;
  path: string;
  onEnterDir: (rel: string) => void;
  onSelectFile: (rel: string) => void;
  selectedFile: string | null;
}) {
  const list = useFilesList(root, path);
  if (list.isLoading) return <div className="p-3 font-mono text-[10px] text-on-surface-variant">加载中…</div>;
  if (list.isError) return <div data-testid="files-list-error" className="p-3 font-mono text-[10px] text-red-600">{(list.error as Error)?.message ?? "加载目录出错。"}</div>;
  if (!list.data || list.data.entries.length === 0) {
    return <div className="p-3 font-mono text-[10px] text-on-surface-variant">空目录。</div>;
  }
  return (
    <ul data-testid="files-directory-tree" className="p-1">
      {path && (
        <li>
          <button
            type="button"
            data-testid="files-up"
            onClick={() => onEnterDir(parentPath(path))}
            className="block w-full px-2 py-1 text-left font-mono text-[10px] text-on-surface-variant hover:bg-surface-low"
          >
            ..
          </button>
        </li>
      )}
      {list.data.entries.map((entry: FileEntry) => {
        const rel = path ? `${path}/${entry.name}` : entry.name;
        const isFile = entry.type === "file";
        const isSelected = selectedFile === rel;
        return (
          <li key={rel}>
            <button
              type="button"
              data-testid={`files-entry-${rel}`}
              data-type={entry.type}
              onClick={() => isFile ? onSelectFile(rel) : entry.type === "dir" ? onEnterDir(rel) : undefined}
              disabled={entry.type === "other"}
              className={`block w-full px-2 py-1 text-left font-mono text-[10px] ${
                entry.type === "other"
                  ? "text-on-surface-variant"
                  : `hover:bg-surface-low ${isSelected ? "bg-surface-high/80 text-on-surface" : "text-on-surface"}`
              }`}
            >
              {entry.type === "dir" ? `▸ ${entry.name}` : entry.name}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function FileContentPanel({
  root,
  path,
  editMode,
  onToggleEditMode,
}: {
  root: string;
  path: string;
  editMode: boolean;
  onToggleEditMode: () => void;
}) {
  const read = useFilesRead(root, path);
  return (
    <div data-testid="files-content-panel" className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-outline-variant bg-background px-3 py-2 font-mono text-[10px]">
        <div className="text-on-surface" data-testid="files-content-path">{root}/{path}</div>
        <div className="flex items-center gap-3 text-on-surface-variant">
          {read.data && (
            <>
              <span data-testid="files-content-size">{read.data.size}b</span>
              <span data-testid="files-content-mtime">{read.data.mtime}</span>
            </>
          )}
          <button
            type="button"
            data-testid="files-edit-toggle"
            data-active={editMode}
            onClick={onToggleEditMode}
            className={`border px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.10em] ${
              editMode
                ? "border-amber-400 bg-amber-50 text-amber-900"
                : "border-outline-variant text-on-surface hover:bg-surface-low"
            }`}
          >
            {editMode ? "编辑中" : "编辑"}
          </button>
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {read.isLoading && <div className="p-4 font-mono text-[10px] text-on-surface-variant">正在加载…</div>}
        {read.isError && <div data-testid="files-read-error" className="p-4 font-mono text-[10px] text-red-600">{(read.error as Error)?.message ?? "加载文件失败。"}</div>}
        {read.data && (
          editMode
            ? <FileEditor root={root} path={path} read={read.data} />
            : <FileViewer root={root} path={path} read={read.data} />
        )}
      </div>
    </div>
  );
}

function FileViewer({ root, path, read }: { root: string; path: string; read: FilesReadResponse }) {
  const ext = pathExtension(path);
  // OSR v0 第 3 项：识别规格类 YAML 文件并进行行内校验。
  const specKind = detectSpecKind(path);
  if (IMAGE_EXTENSIONS.has(ext)) {
    return (
      <div data-testid="files-image-view" className="p-4">
        <TruncationMarker read={read} />
        <img src={fileAssetUrl(root, path)} alt={path} className="max-w-full border border-outline-variant" />
      </div>
    );
  }
  if (ext === ".md") {
    return (
      <div className="p-4">
        <TruncationMarker read={read} />
        <MarkdownViewer content={read.content} />
      </div>
    );
  }
  if (TEXT_LIKE_EXTENSIONS.has(ext)) {
    return (
      <div data-testid="files-code-view" className="p-4">
        <TruncationMarker read={read} />
        {specKind && <SpecValidationPanel kind={specKind} yaml={read.content} />}
        <SyntaxHighlight code={read.content} language={ext.slice(1)} />
      </div>
    );
  }
  if (DOWNLOAD_ONLY_EXTENSIONS.has(ext)) {
    return (
      <div data-testid="files-download-only" className="p-4 font-mono text-[10px] text-on-surface">
        <a href={fileAssetUrl(root, path)} download className="text-blue-700 underline">
          下载 {path}
        </a>
      </div>
    );
  }
  return (
    <div data-testid="files-text-fallback" className="p-4">
      <TruncationMarker read={read} />
      <pre className="whitespace-pre-wrap break-words font-mono text-[10px] text-on-surface">{read.content}</pre>
    </div>
  );
}

// Operator Surface Reconciliation v0 第 5 项：后台服务把读取量限制在
// FILE_READ_TRUNCATION_BYTES（1 MB）时，在文件正文上方显示明确的截断标记。
// 如实说明限制，提醒操作者使用外部编辑器查看完整内容。
function TruncationMarker({ read }: { read: FilesReadResponse }) {
  if (!read.truncated) return null;
  const totalKb = Math.round((read.totalBytes ?? read.size) / 1024);
  return (
    <div
      data-testid="files-truncation-marker"
      data-truncated-at-bytes={read.truncatedAtBytes ?? ""}
      data-total-bytes={read.totalBytes ?? ""}
      className="mb-3 border border-amber-400 bg-amber-50 px-3 py-2 font-mono text-[10px] text-amber-900"
    >
      ⚠ 文件查看器已在 {Math.round((read.truncatedAtBytes ?? 0) / 1024)} KB 处截断——
      文件总大小为 {totalKb} KB。请使用外部编辑器查看完整内容。
    </div>
  );
}

// OSR v0 第 3 项：RigSpec / AgentSpec 校验面板。根据文件名识别规范种类，
// 并通过 useSpecReview hook 调用现有的 /api/specs/review/{rig|agent} 端点。
// 错误和警告会显示在 YAML 视图旁；非规范 YAML 文件完全不显示此面板。
function detectSpecKind(filePath: string): "rig" | "agent" | null {
  const lower = filePath.toLowerCase();
  if (lower.endsWith("/rig.yaml") || lower === "rig.yaml" || lower.endsWith("/rig.yml") || lower === "rig.yml") return "rig";
  if (lower.endsWith("/agent.yaml") || lower === "agent.yaml" || lower.endsWith("/agent.yml") || lower === "agent.yml") return "agent";
  // 规范库条目采用 <pkg>/specs/<spec-name>/{rig,agent}.yaml 结构；
  // 上面已经通过 basename 匹配。若规避误判开始造成使用阻碍（例如工作区树中
  // 不相关的 "config.yaml" 不应触发规范校验），驱动方可在 v0+1 中补充启发式规则。
  return null;
}

function SpecValidationPanel({ kind, yaml }: { kind: "rig" | "agent"; yaml: string }) {
  const review = useSpecReview(kind, yaml);
  if (review.isLoading) {
    return (
      <div data-testid="files-spec-validation-loading" className="mb-3 border border-outline-variant bg-background px-3 py-2 font-mono text-[10px] text-on-surface-variant">
        正在校验 {kind}.yaml…
      </div>
    );
  }
  if (review.isError) {
    return (
      <div data-testid="files-spec-validation-error" className="mb-3 border border-red-400 bg-red-50 px-3 py-2 font-mono text-[10px] text-red-900">
        校验运行失败：{(review.error as Error)?.message ?? "未知错误"}
      </div>
    );
  }
  if (!review.data) return null;
  const errors = review.data.errors ?? [];
  const isValid = errors.length === 0;
  return (
    <div
      data-testid="files-spec-validation-panel"
      data-spec-kind={kind}
      data-valid={isValid}
      className={`mb-3 border px-3 py-2 font-mono text-[10px] ${
        isValid
          ? "border-emerald-400 bg-emerald-50 text-emerald-900"
          : "border-red-400 bg-red-50 text-red-900"
      }`}
    >
      <div className="mb-1 font-bold uppercase tracking-[0.10em]">
        {isValid ? `✓ ${kind === "rig" ? "RigSpec" : "AgentSpec"} 有效` : `✗ ${kind === "rig" ? "RigSpec" : "AgentSpec"} 校验错误`}
      </div>
      {errors.length > 0 && (
        <ul className="space-y-1">
          {errors.map((err, idx) => (
            <li
              key={idx}
              data-testid={`files-spec-validation-error-${idx}`}
              className="text-[10px]"
            >
              {err.field && <span className="font-bold">{err.field}: </span>}
              {err.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FileEditor({ root, path, read }: { root: string; path: string; read: FilesReadResponse }) {
  const [draft, setDraft] = useState(read.content);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ currentMtime: string; currentContentHash: string } | null>(null);
  const [savedIndicator, setSavedIndicator] = useState(false);
  const write = useFilesWrite();
  const qc = useQueryClient();

  // 新读取结果返回时（冲突后刷新，或成功保存后），将草稿重置为新内容。注意：发生 409 冲突时，
  // useFilesWrite 有意不使读取查询失效，因此冲突状态下的读取会保持稳定，直到操作人员点击刷新，
  // 由该操作显式触发失效。
  useEffect(() => {
    setDraft(read.content);
    setConflict(null);
  }, [read.contentHash, read.mtime, read.content]);

  const dirty = useMemo(() => draft !== read.content, [draft, read.content]);

  return (
    <div data-testid="files-editor" className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-outline-variant bg-amber-50 px-3 py-1.5 font-mono text-[9px]">
        <span className="font-bold text-amber-900" data-testid="files-editor-status">
          {dirty ? "草稿（未保存）" : "无改动"}
        </span>
        <button
          type="button"
          data-testid="files-editor-save"
          disabled={!dirty || write.isPending}
          onClick={() => {
            setSaveError(null);
            setConflict(null);
            setSavedIndicator(false);
            write.mutate(
              {
                root,
                path,
                content: draft,
                expectedMtime: read.mtime,
                expectedContentHash: read.contentHash,
                actor: "ui-files-edit-mode",
              },
              {
                onSuccess: (result: FileWriteResult) => {
                  if ("conflict" in result) {
                    setConflict({ currentMtime: result.currentMtime, currentContentHash: result.currentContentHash });
                  } else {
                    setSavedIndicator(true);
                    setTimeout(() => setSavedIndicator(false), 2000);
                  }
                },
                onError: (err) => {
                  setSaveError(err instanceof Error ? err.message : String(err));
                },
              },
            );
          }}
          className="border border-emerald-500 bg-emerald-50 px-2 py-0.5 uppercase tracking-[0.10em] text-emerald-900 disabled:cursor-not-allowed disabled:opacity-50"
        >
          保存
        </button>
        <button
          type="button"
          data-testid="files-editor-cancel"
          onClick={() => { setDraft(read.content); setSaveError(null); setConflict(null); }}
          className="border border-outline bg-surface-lowest px-2 py-0.5 uppercase tracking-[0.10em] text-on-surface"
        >
          取消
        </button>
        {savedIndicator && (
          <span data-testid="files-editor-saved" className="ml-auto text-emerald-700">已保存</span>
        )}
      </div>
      {conflict && (
        <div data-testid="files-editor-conflict" className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-3 py-2 font-mono text-[10px] text-red-900">
          <span className="flex-1">
            文件已被外部修改。本地 mtime <code>{read.mtime}</code> ≠ 服务器 <code>{conflict.currentMtime}</code>。点击“刷新”重新读取文件（你的草稿将被服务器新内容替换；如需重新应用，请先复制到别处）。
          </span>
          <button
            type="button"
            data-testid="files-editor-refresh"
            onClick={() => {
              qc.invalidateQueries({ queryKey: ["files", "read", root, path] });
            }}
            className="border border-red-500 bg-surface-lowest px-2 py-0.5 uppercase tracking-[0.10em] text-red-900"
          >
            刷新
          </button>
        </div>
      )}
      {saveError && (
        <div data-testid="files-editor-error" className="border-b border-red-200 bg-red-50 px-3 py-2 font-mono text-[10px] text-red-900">
          保存失败：{saveError}
        </div>
      )}
      <textarea
        data-testid="files-editor-textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="flex-1 min-h-0 resize-none border-0 bg-background p-3 font-mono text-[11px] leading-relaxed text-on-surface outline-none"
        spellCheck={false}
      />
    </div>
  );
}

function pathExtension(p: string): string {
  const idx = p.lastIndexOf(".");
  if (idx === -1) return "";
  return p.slice(idx).toLowerCase();
}

function parentPath(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "" : p.slice(0, idx);
}
