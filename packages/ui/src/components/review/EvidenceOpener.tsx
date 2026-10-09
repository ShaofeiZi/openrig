// Living Notes Packet 2——证据打开行为（OPR.0.4.4.20 FR-11）。
//
// 每个 evidence_ref 都在一个已上线的组件内打开——绝不新增查看器族：
//   .md      → SharedDetailDrawer 里的 FileViewer（FileReferenceTrigger）
//   image    → 实时 proof Lightbox（从 ProofTab 抽出）
//   video    → 经 /api/files/asset 内联 <video playsinline preload="metadata">
//   folder   → 限定到该文件夹的 ArtifactsNavigator（受 OPENRIG_FILES_ALLOWLIST 管控）
//   .html    → 经 ?render=1 在新标签页渲染页面（命名的净新增 opt-in；
//              CSP 姿态是文档化的提示，而非门槛）
// 死代码（ProofImageViewer / TestsVerificationTab 查看器 / DocsTab）保持死。

import { useState } from "react";
import { FileReferenceTrigger } from "../drawer-triggers/FileReferenceTrigger.js";
import { ArtifactsNavigator } from "../project/ArtifactsNavigator.js";
import { Lightbox } from "../project/Lightbox.js";
import { fileAssetUrl } from "../../hooks/useFiles.js";

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"];
const VIDEO_EXTS = [".mp4", ".webm", ".mov"];

export interface EvidenceContext {
  /** slice 目录的白名单解析（来自 useScopeMarkdown.resolved）。 */
  root: string | null;
  relPath: string | null;
  /** 绝对 slice 目录（文件夹打开用）。 */
  slicePath: string | null;
}

type Kind = "markdown" | "image" | "video" | "html" | "folder" | "other";

/** 证据引用的 slice 范围约束（d6135921 的 rev1-r2 修复）：
 *  PRD 的媒体合同是 slice 同置、slice 相对的引用——绝对引用或任何 `..` 段都会逃出 slice 边界，
 *  必须在构造任何 URL/范围之前拒绝（一个具名可见错误，绝不静默打开看似证据的兄弟/父级内容）。 */
export function evidenceRefContained(ref: string): boolean {
  return !ref.startsWith("/") && !/(^|\/)\.\.(\/|$)/.test(ref);
}

function classify(ref: string): Kind {
  const lower = ref.toLowerCase();
  if (lower.endsWith("/") || !/\.[a-z0-9]+$/.test(lower)) return "folder";
  if (lower.endsWith(".md")) return "markdown";
  if (IMAGE_EXTS.some((e) => lower.endsWith(e))) return "image";
  if (VIDEO_EXTS.some((e) => lower.endsWith(e))) return "video";
  if (lower.endsWith(".html")) return "html";
  return "other";
}

function assetUrlFor(ctx: EvidenceContext, ref: string): string | null {
  if (ref.startsWith("/")) return null; // 绝对路径——FR-5 视其为缺陷发现
  if (!ctx.root) return null;
  const rel = ctx.relPath ? `${ctx.relPath}/${ref}` : ref;
  return fileAssetUrl(ctx.root, rel);
}

export function EvidenceOpener({ evidenceRef, ctx, testId }: { evidenceRef: string; ctx: EvidenceContext; testId?: string }) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [folderOpen, setFolderOpen] = useState(false);
  const tid = testId ?? "evidence-opener";
  if (!evidenceRefContained(evidenceRef)) {
    return (
      <span data-testid={`${tid}-outside-scope`} className="font-mono text-[11px] text-red-700">
        证据引用超出切片范围（必须是切片相对路径）：{evidenceRef}
      </span>
    );
  }
  // 无可解析基址（例如无切片目录的工作组高度）：对每种引用类型都做一次具名降级——
  // 诚实的不可打开指针加原因（该引用在切片钻取处可完整打开）。对 Markdown 也承重：
  // 无可读目标的 FileReferenceTrigger 会打开死抽屉（永远 Loading）——绝不在此渲染打开器。
  if (!ctx.root && !ctx.slicePath) {
    return (
      <span className="font-mono text-[11px] text-on-surface-variant">
        <span data-testid={`${tid}-pointer`}>{evidenceRef}</span>
        <span className="ml-1 text-[10px]">（从此视图无法打开——无切片上下文）</span>
      </span>
    );
  }
  const kind = classify(evidenceRef);
  const url = assetUrlFor(ctx, evidenceRef);
  const linkClass = "font-mono text-[11px] underline text-on-surface hover:text-on-surface-variant";

  if (kind === "markdown") {
    return (
      <FileReferenceTrigger
        testId={`${tid}-md`}
        className={`${linkClass} text-left`}
        data={{
          path: evidenceRef,
          kind: "markdown",
          root: ctx.root ?? undefined,
          readPath: ctx.relPath ? `${ctx.relPath}/${evidenceRef}` : evidenceRef,
          absolutePath: evidenceRef.startsWith("/") ? evidenceRef : ctx.slicePath ? `${ctx.slicePath}/${evidenceRef}` : null,
        }}
      >
        {evidenceRef}
      </FileReferenceTrigger>
    );
  }

  if (kind === "image") {
    return (
      <>
        <button type="button" data-testid={`${tid}-image`} className={linkClass} onClick={() => setLightboxSrc(url)}>
          {evidenceRef}
        </button>
        <Lightbox src={lightboxSrc} alt={evidenceRef} onClose={() => setLightboxSrc(null)} />
      </>
    );
  }

  if (kind === "video") {
    if (!url) return <span className="font-mono text-[11px] text-red-700">无法解析的媒体引用：{evidenceRef}</span>;
    // FR-5：内联播放，playsinline + preload=metadata（arch AC 裁定）；
    // 同置的截图 poster 若存在则同基名。
    const poster = assetUrlFor(ctx, evidenceRef.replace(/\.[a-z0-9]+$/i, ".png"));
    return (
      <video
        data-testid={`${tid}-video`}
        controls
        playsInline
        preload="metadata"
        poster={poster ?? undefined}
        src={url}
        className="max-h-64 w-full border border-outline-variant bg-stone-950"
      />
    );
  }

  if (kind === "html") {
    if (!url) return <span className="font-mono text-[11px] text-red-700">无法解析的原型引用：{evidenceRef}</span>;
    return (
      <a data-testid={`${tid}-html`} className={linkClass} href={`${url}&render=1`} target="_blank" rel="noreferrer">
        {evidenceRef} ↗
      </a>
    );
  }

  if (kind === "folder") {
    const scopePath = evidenceRef.startsWith("/")
      ? evidenceRef
      : ctx.slicePath
        ? `${ctx.slicePath}/${evidenceRef.replace(/\/$/, "")}`
        : null;
    return (
      <div>
        <button type="button" data-testid={`${tid}-folder`} className={linkClass} onClick={() => setFolderOpen((v) => !v)}>
          {evidenceRef} {folderOpen ? "▾" : "▸"}
        </button>
        {folderOpen && scopePath ? (
          <div className="mt-2 border border-outline-variant">
            <ArtifactsNavigator scopePath={scopePath} scopeLabel={evidenceRef} />
          </div>
        ) : null}
        {folderOpen && !scopePath ? (
          <p className="font-mono text-[11px] text-red-700">文件夹超出切片范围：{evidenceRef}</p>
        ) : null}
      </div>
    );
  }

  return url ? (
    <a className={linkClass} href={url} target="_blank" rel="noreferrer" data-testid={`${tid}-other`}>
      {evidenceRef}
    </a>
  ) : (
    <span className="font-mono text-[11px]">{evidenceRef}</span>
  );
}
