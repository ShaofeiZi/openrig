// V1 第 4 阶段尝试 3 —— FileViewer，按 content-drawer.md L88–L108。
//
// 渲染 markdown / text / YAML / JSON / 图片 / 二进制文件引用。

import { useMemo } from "react";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";
import {
  fileAssetUrl,
  useFilesRead,
  useFilesRoots,
  type AllowlistRoot,
} from "../../hooks/useFiles.js";
import { ToolMark } from "../graphics/RuntimeMark.js";
import { toolBrand } from "../../lib/tool-brand.js";

export type FileKind = "markdown" | "text" | "yaml" | "json" | "image" | "binary";

export interface FileViewerData {
  /** 抽屉中显示的路径。设置 `root` 时也用作相对读取路径。 */
  path: string;
  kind?: FileKind;
  content?: string;
  imageUrl?: string;
  /** 现有 /api/files 白名单根目录名称。 */
  root?: string;
  /** `root` 下的可选显式路径；缺省时回退到 `path`。 */
  readPath?: string;
  /** 绝对文件路径；读取前对照 /api/files/roots 解析。 */
  absolutePath?: string | null;
}

interface ResolvedReadTarget {
  root: string;
  path: string;
}

function inferKind(path: string): FileKind {
  const lower = path.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "markdown";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".gif") || lower.endsWith(".webp") || lower.endsWith(".svg")) return "image";
  if (lower.endsWith(".log") || lower.endsWith(".txt")) return "text";
  return "text";
}

function normalizeAbsolutePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

function resolveFromAbsolutePath(
  roots: AllowlistRoot[] | undefined,
  absolutePath: string | null | undefined,
): ResolvedReadTarget | null {
  if (!roots || !absolutePath) return null;
  const normalizedFile = normalizeAbsolutePath(absolutePath);
  const sortedRoots = [...roots].sort((a, b) => b.path.length - a.path.length);
  for (const root of sortedRoots) {
    const normalizedRoot = normalizeAbsolutePath(root.path);
    if (normalizedFile === normalizedRoot) return null;
    const prefix = `${normalizedRoot}/`;
    if (!normalizedFile.startsWith(prefix)) continue;
    const relativePath = normalizedFile.slice(prefix.length);
    if (!relativePath || relativePath.includes("../")) return null;
    return { root: root.name, path: relativePath };
  }
  return null;
}

function useResolvedReadTarget(data: FileViewerData): {
  rootsLoading: boolean;
  target: ResolvedReadTarget | null;
  hasFetchIntent: boolean;
} {
  const explicitTarget = data.root
    ? { root: data.root, path: data.readPath ?? data.path }
    : null;
  const needsRootResolution = !explicitTarget && !!data.absolutePath;
  const roots = useFilesRoots();
  const absoluteTarget = useMemo(() => {
    if (!needsRootResolution) return null;
    const rootData = roots.data;
    if (!rootData || "unavailable" in rootData) return null;
    return resolveFromAbsolutePath(rootData.roots, data.absolutePath);
  }, [data.absolutePath, needsRootResolution, roots.data]);

  return {
    rootsLoading: needsRootResolution && roots.isLoading,
    target: explicitTarget ?? absoluteTarget,
    hasFetchIntent: !!explicitTarget || !!data.absolutePath,
  };
}

/** 斜杠分隔相对路径的父目录；路径无目录段时（根级文件）为 ""。
 *  纯字符串语义——无 Node path。 */
function parentDir(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

function FileViewerBody({
  path,
  resolvedKind,
  content,
  imageUrl,
  target,
}: {
  path: string;
  resolvedKind: FileKind;
  content?: string;
  imageUrl?: string;
  target?: ResolvedReadTarget | null;
}) {
  if (!content && !imageUrl && resolvedKind !== "binary") {
    return (
      <EmptyState
        label="无内容"
        description={`正在加载 ${path}…`}
        variant="card"
        testId="file-viewer-empty"
      />
    );
  }

  // 抽屉 Markdown 中的内联 C1-body 图片是切片相对的——文件的兄弟
  //（例如 proof/qa.md 正文 `![](proof-image.png)`）。通过从文件父目录派生的
  // 规范 /api/files/asset 基解析它们（解析后 target.path 上的斜杠语义；
  // 根级文件锚定在 "."），使它们在应用内加载，而非落到破碎的 SPA 路由相对 URL。
  // 无解析目标（仅内联调用者）=> 无基（保留 MarkdownViewer 透传）。
  const markdownAssetBase = target
    ? fileAssetUrl(target.root, parentDir(target.path) || ".")
    : undefined;

  return (
    <div data-testid="file-viewer" data-file-kind={resolvedKind} className="flex flex-col h-full">
      <header className="px-4 py-3 border-b border-outline-variant">
        <div className="inline-flex items-center gap-1.5">
          <ToolMark tool={path} size="sm" decorative />
          <SectionHeader tone="muted">{toolBrand(path).label}</SectionHeader>
        </div>
        <h3 className="mt-1 font-mono text-xs text-on-surface break-all">{path}</h3>
        {target && (
          <div data-testid="file-viewer-root-path" className="mt-1 font-mono text-[9px] text-on-surface-variant break-all">
            {target.root}/{target.path}
          </div>
        )}
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {resolvedKind === "markdown" && content ? (
          <div className="px-4 py-3">
            <MarkdownViewer content={content} assetBasePath={markdownAssetBase} />
          </div>
        ) : null}
        {resolvedKind === "yaml" || resolvedKind === "json" ? (
          <pre className="px-4 py-3 font-mono text-xs text-on-surface whitespace-pre-wrap">
            {content}
          </pre>
        ) : null}
        {resolvedKind === "text" ? (
          <pre className="px-4 py-3 font-mono text-xs text-on-surface whitespace-pre">
            {content}
          </pre>
        ) : null}
        {resolvedKind === "image" && imageUrl ? (
          <div className="px-4 py-3 flex justify-center">
            <img src={imageUrl} alt={path} className="max-w-full h-auto" />
          </div>
        ) : null}
        {resolvedKind === "binary" ? (
          <div className="px-4 py-6">
            <EmptyState
              label="二进制文件"
              description="无法预览；请改为下载。"
              variant="card"
              testId="file-viewer-binary"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FileViewerWithFetch(data: FileViewerData) {
  const { path, kind, content, imageUrl } = data;
  const resolvedKind = kind ?? inferKind(path);
  const { rootsLoading, target, hasFetchIntent } = useResolvedReadTarget(data);
  const read = useFilesRead(target?.root ?? null, target?.path ?? null);
  const fetchedContent = read.data?.content;
  const fetchedImageUrl = target && resolvedKind === "image"
    ? fileAssetUrl(target.root, target.path)
    : undefined;
  const resolvedContent = content ?? fetchedContent;
  const resolvedImageUrl = imageUrl ?? fetchedImageUrl;

  if (!content && !imageUrl && hasFetchIntent && (rootsLoading || read.isLoading)) {
    return (
      <EmptyState
        label="加载中"
        description={`正在加载 ${path}…`}
        variant="card"
        testId="file-viewer-empty"
      />
    );
  }

  if (!content && !imageUrl && hasFetchIntent && !target) {
    return (
      <EmptyState
        label="文件不可用"
        description={`无已配置文件根目录包含 ${path}。`}
        variant="card"
        testId="file-viewer-error"
      />
    );
  }

  if (!content && !imageUrl && read.isError) {
    return (
      <EmptyState
        label="文件不可用"
        description={(read.error as Error)?.message ?? `无法加载 ${path}。`}
        variant="card"
        testId="file-viewer-error"
      />
    );
  }

  return (
    <FileViewerBody
      path={path}
      resolvedKind={resolvedKind}
      content={resolvedContent}
      imageUrl={resolvedImageUrl}
      target={target}
    />
  );
}

export function FileViewer(data: FileViewerData) {
  if (!data.root && !data.absolutePath) {
    // OPR.0.4.4.20 回溯 demo 修复：既不提供内联内容也不提供任何可读目标
    //（root/readPath 或 absolutePath）的调用者永远无法加载任何内容——
    // 诚实说明，而非误导性的永久"加载中…"（demo proof 捕获的；后端读取正常；
    // 查看器从未被给予可请求的目标）。
    if (!data.content && !data.imageUrl) {
      return (
        <EmptyState
          label="无法解析"
          description={`${data.path} 无可读目标：调用者既未提供内容，也未提供文件根目录/绝对路径。`}
          variant="card"
          testId="file-viewer-unresolvable"
        />
      );
    }
    return (
      <FileViewerBody
        path={data.path}
        resolvedKind={data.kind ?? inferKind(data.path)}
        content={data.content}
        imageUrl={data.imageUrl}
      />
    );
  }
  return <FileViewerWithFetch {...data} />;
}
