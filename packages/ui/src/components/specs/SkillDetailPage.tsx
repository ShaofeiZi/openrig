import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "../ui/empty-state.js";
import { SectionHeader } from "../ui/section-header.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";
import { SyntaxHighlight } from "../markdown/SyntaxHighlight.js";
import { useLibrarySkills } from "../../hooks/useLibrarySkills.js";
import { useSkillFilesList, useSkillFilesRead } from "../../hooks/useSkillFiles.js";
import {
  librarySkillFilePathFromToken,
  librarySkillIdFromToken,
} from "../../lib/library-skills-routing.js";

const TEXT_LIKE_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".log",
  ".yaml", ".yml", ".json",
  ".js", ".jsx", ".ts", ".tsx",
  ".py", ".sh", ".bash",
  ".css", ".html",
]);

function pathExtension(p: string): string {
  const idx = p.lastIndexOf(".");
  if (idx === -1) return "";
  return p.slice(idx).toLowerCase();
}

function parentPath(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "" : p.slice(0, idx);
}

function joinPath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

export function SkillDetailPage({
  skillToken,
  fileToken,
}: {
  skillToken: string;
  fileToken?: string | null;
}) {
  const { data: skills = [], isLoading } = useLibrarySkills();
  const skillId = librarySkillIdFromToken(skillToken);
  const skill = skillId ? skills.find((entry) => entry.id === skillId) ?? null : null;

  // 技能文件夹内的相对路径。空字符串 = 技能根。
  const [currentPath, setCurrentPath] = useState<string>("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [defaultPicked, setDefaultPicked] = useState(false);

  // 技能可用后，把 fileToken 解析为 currentPath + selectedFile。fileToken 的编码路径
  // 在 C4 之后相对于技能根（例如 "SKILL.md" 或 "examples/basic.md"）。
  useEffect(() => {
    if (!fileToken || !skill) return;
    const requestedRelPath = librarySkillFilePathFromToken(fileToken);
    if (!requestedRelPath) return;
    setCurrentPath(parentPath(requestedRelPath));
    setSelectedFile(requestedRelPath);
    setDefaultPicked(true);
  }, [fileToken, skill]);

  // 后台服务 /api/skills/:id/files/list 调用（取代 /api/files/list）。
  const list = useSkillFilesList(skill?.id ?? null, currentPath);

  // 首次加载时在技能根自动选中 SKILL.md（当未发生 fileToken 解析时）。
  useEffect(() => {
    if (defaultPicked) return;
    if (currentPath !== "") return;
    if (!list.data) return;
    const skillMd = list.data.entries.find(
      (e) => e.type === "file" && /^skill\.md$/i.test(e.name),
    );
    if (skillMd) setSelectedFile(skillMd.name);
    setDefaultPicked(true);
  }, [list.data, currentPath, defaultPicked]);

  if (isLoading) {
    return (
      <div className="h-full bg-paper-grid px-6 py-5 lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]">
        <EmptyState
          label="正在加载技能"
          description="正在从后台服务技能库加载技能文件。"
          variant="card"
          testId="skill-detail-loading"
        />
      </div>
    );
  }

  if (!skill) {
    return (
      <div className="h-full bg-paper-grid px-6 py-5 lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]">
        <EmptyState
          label="未找到技能"
          description="所选技能无法在后台服务技能库中检索到。"
          variant="card"
          testId="skill-detail-not-found"
        />
      </div>
    );
  }

  return (
    <div
      data-testid="skill-detail-page"
      className="h-full overflow-hidden bg-paper-grid px-6 py-5 lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]"
    >
      <header className="mb-4">
        <SectionHeader tone="muted">技能</SectionHeader>
        <div className="mt-1 flex flex-wrap items-baseline gap-3">
          <h1 className="font-headline text-2xl font-bold tracking-tight text-on-surface">
            {skill.name}
          </h1>
          <span
            data-testid="skill-detail-source"
            className="font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant"
          >
            {skill.source}
          </span>
        </div>
        {/* Slice 29 HG-4——展示磁盘上的绝对路径，使操作者看到后台服务从何处读取每个技能。 */}
        <div
          data-testid="skill-detail-absolute-path"
          className="mt-1 font-mono text-[10px] text-on-surface-variant truncate"
          title={skill.absolutePath}
        >
          {skill.absolutePath}
        </div>
      </header>

      <div
        data-testid="skill-detail-docs-browser"
        className="flex h-[calc(100%-5rem)] flex-col border border-outline-variant bg-surface-lowest/25 hard-shadow sm:flex-row"
      >
        <aside
          data-testid="skill-detail-tree"
          className="w-full max-h-48 shrink-0 overflow-y-auto border-b border-outline-variant bg-surface-lowest/30 sm:w-64 sm:max-h-none sm:border-b-0 sm:border-r"
        >
          <Breadcrumbs
            testId="skill-detail-breadcrumbs"
            skillName={skill.name}
            path={currentPath}
            onNavigate={(rel) => { setCurrentPath(rel); setSelectedFile(null); }}
          />
          {list.isLoading ? (
            <div data-testid="skill-detail-tree-loading" className="p-3 font-mono text-[10px] text-on-surface-variant">
              正在加载…
            </div>
          ) : list.isError ? (
            <div data-testid="skill-detail-tree-error" className="p-3 font-mono text-[10px] text-red-600">
              {(list.error as Error)?.message ?? "加载目录出错。"}
            </div>
          ) : !list.data || list.data.entries.length === 0 ? (
            <div data-testid="skill-detail-tree-empty" className="p-3 font-mono text-[10px] text-on-surface-variant">
              空目录。
            </div>
          ) : (
            <ul className="p-1">
              {currentPath && (
                <li>
                  <button
                    type="button"
                    data-testid="skill-detail-tree-up"
                    onClick={() => { setCurrentPath(parentPath(currentPath)); setSelectedFile(null); }}
                    className="block w-full px-2 py-1 text-left font-mono text-[10px] text-on-surface-variant hover:bg-surface-low"
                  >
                    ..
                  </button>
                </li>
              )}
              {list.data.entries.map((fileEntry) => {
                const rel = joinPath(currentPath, fileEntry.name);
                const isFile = fileEntry.type === "file";
                const isSelected = selectedFile === rel;
                return (
                  <li key={rel}>
                    <button
                      type="button"
                      data-testid={`skill-detail-tree-entry-${rel}`}
                      data-type={fileEntry.type}
                      data-active={isSelected}
                      onClick={() => {
                        if (isFile) setSelectedFile(rel);
                        else if (fileEntry.type === "dir") { setCurrentPath(rel); setSelectedFile(null); }
                      }}
                      disabled={fileEntry.type === "other"}
                      className={`block w-full px-2 py-1 text-left font-mono text-[10px] ${
                        fileEntry.type === "other"
                          ? "text-on-surface-variant"
                          : `hover:bg-surface-low ${isSelected ? "bg-surface-high/80 text-on-surface" : "text-on-surface"}`
                      }`}
                    >
                      {fileEntry.type === "dir" ? `▸ ${fileEntry.name}` : fileEntry.name}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <main data-testid="skill-detail-viewer" className="flex-1 min-w-0 overflow-y-auto bg-surface-lowest">
          {!selectedFile ? (
            <div data-testid="skill-detail-viewer-no-selection" className="p-4 font-mono text-[10px] text-on-surface-variant">
              请从树中选择一个文件。
            </div>
          ) : (
            <SkillFileContent skillId={skill.id} path={selectedFile} />
          )}
        </main>
      </div>
    </div>
  );
}

function Breadcrumbs({
  testId,
  skillName,
  path,
  onNavigate,
}: {
  testId: string;
  skillName: string;
  path: string;
  onNavigate: (path: string) => void;
}) {
  const segments = path ? path.split("/") : [];
  return (
    <nav data-testid={testId} className="flex flex-wrap items-baseline gap-1 border-b border-outline-variant px-2 py-1 font-mono text-[10px] text-on-surface">
      <button type="button" onClick={() => onNavigate("")} className="font-bold hover:underline">
        {skillName}
      </button>
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

function SkillFileContent({ skillId, path }: { skillId: string; path: string }) {
  const read = useSkillFilesRead(skillId, path);
  const ext = useMemo(() => pathExtension(path), [path]);

  if (read.isLoading) {
    return (
      <div data-testid="skill-detail-viewer-loading" className="p-4 font-mono text-[10px] text-on-surface-variant">
        正在加载…
      </div>
    );
  }
  if (read.isError) {
    return (
      <div data-testid="skill-detail-viewer-error" className="p-4 font-mono text-[10px] text-red-600">
        {(read.error as Error)?.message ?? "加载文件出错。"}
      </div>
    );
  }
  if (!read.data) return null;

  return (
    <div data-testid="skill-detail-viewer-content" className="flex h-full flex-col">
      <header className="flex items-baseline justify-between border-b border-outline-variant bg-surface-lowest/30 px-3 py-2 font-mono text-[10px]">
        <div data-testid="skill-detail-viewer-path" className="text-on-surface">{path}</div>
        <div className="flex items-baseline gap-3 text-on-surface-variant">
          <span>{read.data.size}b</span>
          <span>{read.data.mtime}</span>
        </div>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {read.data.truncated && (
          <div
            data-testid="skill-detail-viewer-truncated"
            className="mb-3 mx-4 mt-4 border border-amber-400 bg-amber-50 px-3 py-2 font-mono text-[10px] text-amber-900"
          >
            ⚠ 在 {Math.round((read.data.truncatedAtBytes ?? 0) / 1024)} KB 处截断——文件共{" "}
            {Math.round((read.data.totalBytes ?? read.data.size) / 1024)} KB。
          </div>
        )}
        {ext === ".md" || ext === ".mdx" ? (
          <div className="p-4">
            <MarkdownViewer content={read.data.content} />
          </div>
        ) : TEXT_LIKE_EXTENSIONS.has(ext) ? (
          <div className="p-4">
            <SyntaxHighlight code={read.data.content} language={ext.slice(1)} />
          </div>
        ) : (
          <pre data-testid="skill-detail-viewer-text-fallback" className="p-4 whitespace-pre-wrap break-words font-mono text-[10px] text-on-surface">
            {read.data.content}
          </pre>
        )}
      </div>
    </div>
  );
}
