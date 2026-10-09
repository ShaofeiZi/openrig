// OPR.0.4.1.23 Part-3——PROOF 标签页（round-9，策展人独立）。按原样、只读地投影
// 逐 slice 的校验位置。
//
// 机制：每个 slice 的校验位于字节一致的路径契约 `<slicePath>/PROOF.md`
// （slice 根，如 PROGRESS.md）+ `<slicePath>/proof/`（媒体），由 `rig scope`
// （Part-1，已发布）脚手架化、由收尾 SOP（Part-2，skill-library）填充——读取路径上无策展人。
// 本标签页投影那里的一切：渲染 PROOF.md + proof/ 捕获的产物画廊 + 为已脚手架但未填充的
// slice 提供自解释空态。
//
// 复用，不新增界面：读取走现有的白名单 + 遍历守卫的 /api/files 端点，与 slice-21
// Artifacts 导航器完全一致——useScopeMarkdown(slicePath,'PROOF.md') 取判定/正文 +
// useFilesList(root,'<slice>/proof') + fileAssetUrl 做画廊。继承后台服务的路径安全。
//
// 懒加载（slice-17/21 的教训）：本组件只在 PROOF 标签页为活动标签时挂载——
// 在概览/steering 落地页上绝不渲染（也就绝不拉取）。布局是创始人批准的样机
// （digital-twin/opr-0.4.1.23/）。

import { useState } from "react";
import { useFilesList, fileAssetUrl } from "../../hooks/useFiles.js";
import { useScopeMarkdown } from "../../hooks/useScopeMarkdown.js";
import { MarkdownViewer } from "../markdown/MarkdownViewer.js";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { FileLink } from "../ui/FileLink.js";
// OPR.0.4.4.20：逐字提取 Lightbox，供评审界面复用。
import { Lightbox } from "./Lightbox.js";

type Verdict = "PASS" | "PARTIAL" | "FAIL";

const VERDICT_TONE: Record<Verdict, string> = {
  PASS: "border-emerald-500/60 bg-emerald-50 text-emerald-800",
  PARTIAL: "border-amber-500/60 bg-amber-50 text-amber-800",
  FAIL: "border-red-500/60 bg-red-50 text-red-800",
};

// 判定徽章的中文展示（底层仍保留 PASS/PARTIAL/FAIL 枚举）。
const VERDICT_LABEL: Record<Verdict, string> = {
  PASS: "通过",
  PARTIAL: "部分",
  FAIL: "失败",
};

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
// Markdown 工作凭证产物（guard/qa/rev1 判定）在应用内经 FileLink 于
// SharedDetailDrawer 打开——渲染 C1 标题 + 正文——而非跳出 SPA 做整页原始资源导航。
// 非 Markdown 的其他文件（日志/视频/二进制）保留其现有的浏览器可查看原始资源链接。
const MD_RE = /\.mdx?$/i;

/** 内联 PROOF.md 图片的资源基址——例如 Intent→Proof 表里的 `![](proof/real-live.png)`，
 *  相对于 PROOF.md 所在的 slice 根。MarkdownViewer 用 "/" 分隔符拼接相对 src
 *  （resolveAssetUrl），因此非空 relPath 得到精确的 /api/files/asset?...path=<relPath>/proof/<img> URL。
 *  恰为根的情形（relPath ""）锚定到 "."，使拼接保持相对（path=./proof/<img>），
 *  而非前导斜杠的 path=/proof/<img>。否则内联图片会渲染成坏掉的路由相对 `proof/...` URL
 *  （guard fcf1126f）。 */
function proofAssetBase(rootName: string, relPath: string): string {
  return fileAssetUrl(rootName, relPath || ".");
}

/** 解析 PROOF.md 判定，对多种作者写法稳健（脚手架模板 `Verdict: <pass | ...>`、
 *  dev1-qa 捕获 `**Verdict: PASS**`、裸 `Verdict: pass-with-residue`）。
 * `<...>` 尖括号占位符不是真判定——未填充的脚手架返回 null（→ 空态）。 */
function parseVerdict(content: string | null): Verdict | null {
  if (!content) return null;
  const m = /verdict\s*:?\s*\**\s*([A-Za-z][A-Za-z-]*)/i.exec(content.replace(/`/g, ""));
  if (!m) return null;
  const token = m[1]!.toLowerCase();
  if (token.startsWith("pass")) return token.includes("residue") ? "PARTIAL" : "PASS";
  if (token.startsWith("partial")) return "PARTIAL";
  if (token.startsWith("fail")) return "FAIL";
  return null;
}

/** 一个 slice 的校验卡片——按原样读取 <slicePath>/PROOF.md + <slicePath>/proof/。 */
function ProofSliceCard({
  sliceId,
  title,
  slicePath,
}: {
  sliceId: string;
  title: string;
  slicePath: string | null;
}) {
  const [preview, setPreview] = useState<string | null>(null);

  // 经 slice-17/21 的 scope-markdown 读取器取 PROOF.md（把 slicePath 解析到白名单并经
  // /api/files/read 读取）。`resolved` = 我们复用于 proof/ 列举 + 资源 URL 的
  // {rootName, relPath}，使路径只解析一次。
  const proofMd = useScopeMarkdown(slicePath, "PROOF.md");
  const resolved = proofMd.resolved;
  const proofRel = resolved ? (resolved.relPath ? `${resolved.relPath}/proof` : "proof") : null;

  // proof/ 列举——惰性（enabled:!!root）。路径解析前禁用。
  const proofList = useFilesList(resolved ? resolved.rootName : null, proofRel);
  const files = (proofList.data?.entries ?? []).filter((e) => e.type === "file");
  const images = files.filter((f) => IMAGE_RE.test(f.name));
  const otherFiles = files.filter((f) => !IMAGE_RE.test(f.name));

  const verdict = parseVerdict(proofMd.content);
  const hasContent = !proofMd.unavailable && !!proofMd.content;
  // 已填充 = 有真实判定，或至少一个捕获产物。已脚手架但未填充的 slice
  // （占位判定、空 proof/）落到空态。
  const populated = verdict !== null || images.length > 0 || otherFiles.length > 0;

  if (proofMd.isLoading) {
    return (
      <section data-testid={`proof-slice-loading-${sliceId}`} className="border border-outline-variant bg-surface-lowest/25 p-4">
        <div className="font-mono text-[11px] text-on-surface-variant">正在加载校验…</div>
      </section>
    );
  }

  if (!populated) {
    // R1（release-0.4.7）：空态不再说谎。`absent`/`idle` 精确保持今天的
    // “待校验”+“尚无校验”字节；根路径错误的 scope（`unresolved`）或基础设施读取失败
    // （`read_error`）各得到诚实文案，使真实的配置/读取问题不被显示成空校验。
    const empty =
      proofMd.state === "read_error"
        ? {
            micro: null as string | null,
            label: "PROOF.MD 读取失败",
            description:
              "后台服务无法读取 PROOF.md——这是读取失败，不是空校验。请检查后台服务日志与文件权限。",
            testId: `proof-read-error-${sliceId}`,
          }
        : proofMd.state === "unresolved"
          ? {
              micro: null as string | null,
              label: "PROOF.MD 不在文件根内",
              description:
                "本切片的路径不在后台服务白名单的任一文件根下，因此无法读取 PROOF.md。请检查 OPENRIG_FILES_ALLOWLIST / 后台服务的 file-roots 设置。",
              testId: `proof-unresolved-${sliceId}`,
            }
          : {
              micro: "待校验" as string | null,
              label: "尚无校验",
              description:
                "本切片有一个已脚手架化的 proof/ 位置，但尚无收尾流程填充。工作凭证捕获（截图/视频）与 PROOF.md 判定会在收尾智能体处理切片收尾时放入此处——无需策展人。",
              testId: `proof-empty-state-${sliceId}`,
            };
    return (
      <section
        data-testid={`proof-slice-empty-${sliceId}`}
        className="border border-dashed border-outline-variant bg-surface-lowest/10 p-4"
      >
        <div className="flex items-baseline justify-between border-b border-outline-variant/60 pb-2">
          <span className="font-mono text-[12px] uppercase tracking-[0.12em] text-on-surface-variant">{sliceId}</span>
          {empty.micro ? (
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-on-surface-variant">{empty.micro}</span>
          ) : null}
        </div>
        <div className="mt-3">
          <EmptyState
            label={empty.label}
            description={empty.description}
            variant="card"
            testId={empty.testId}
          />
        </div>
      </section>
    );
  }

  return (
    <section data-testid={`proof-slice-${sliceId}`} className="border border-outline-variant bg-surface-lowest/25 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-outline-variant pb-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[12px] uppercase tracking-[0.12em] text-on-surface">{sliceId}</span>
          <span className="font-mono text-[10px] text-on-surface-variant">{title}</span>
        </div>
        {verdict ? (
          <span
            data-testid={`proof-verdict-${sliceId}`}
            className={`border px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] ${VERDICT_TONE[verdict]}`}
          >
            {VERDICT_LABEL[verdict]}
          </span>
        ) : null}
      </div>

      {/* PROOF.md 按原样渲染（markdown → UI，像 PROGRESS 投影那样稳健）。 */}
      {hasContent ? (
        <div data-testid={`proof-md-${sliceId}`} className="mt-3">
          <MarkdownViewer
            content={proofMd.content!}
            assetBasePath={resolved ? proofAssetBase(resolved.rootName, resolved.relPath) : undefined}
            hideFrontmatter
            hideRawToggle
          />
        </div>
      ) : null}

      {/* 产物画廊——proof/ 捕获，经 /api/files/asset 浏览器可查看。 */}
      {images.length > 0 ? (
        <div className="mt-3">
          <div className="mb-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-on-surface-variant">
            proof/ · {images.length} 个捕获
          </div>
          <div data-testid={`proof-gallery-${sliceId}`} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {images.map((img) => {
              const url = fileAssetUrl(resolved!.rootName, `${proofRel}/${img.name}`);
              return (
                <figure key={img.name} data-testid={`proof-thumb-${img.name}`} className="border border-outline-variant bg-surface-lowest/40">
                  <button type="button" onClick={() => setPreview(url)} className="block w-full" aria-label={`打开 ${img.name}`}>
                    <img src={url} alt={img.name} loading="lazy" className="block h-[150px] w-full object-cover object-top" />
                  </button>
                  <figcaption className="truncate border-t border-outline-variant px-2 py-1 font-mono text-[8px] uppercase tracking-[0.08em] text-on-surface-variant">
                    {img.name}
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* 非图片校验产物（日志/视频等）——按原样列成链接，不隐藏任何东西。 */}
      {otherFiles.length > 0 ? (
        <ul data-testid={`proof-files-${sliceId}`} className="mt-3 space-y-1 font-mono text-[10px]">
          {otherFiles.map((f) => (
            <li key={f.name}>
              {MD_RE.test(f.name) ? (
                // Markdown 校验产物——在应用内抽屉打开（C1 标题 + 正文），
                // 而非跳出 SPA 做整页原始资源导航。
                <FileLink
                  root={resolved!.rootName}
                  path={`proof/${f.name}`}
                  readPath={`${proofRel}/${f.name}`}
                  className="text-on-surface-variant underline decoration-outline-variant underline-offset-2 hover:text-on-surface"
                >
                  proof/{f.name}
                </FileLink>
              ) : (
                <a
                  href={fileAssetUrl(resolved!.rootName, `${proofRel}/${f.name}`)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-on-surface-variant underline decoration-outline-variant underline-offset-2 hover:text-on-surface"
                >
                  proof/{f.name}
                </a>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      <Lightbox src={preview} alt={preview ? "校验捕获" : ""} onClose={() => setPreview(null)} />
    </section>
  );
}

export interface ProofRollupRow {
  /** slice 索引名（slice 列表里的 `name`） */
  name: string;
  /** 人类可读展示 id，例如 "OPR.0.4.1.16" 或 slice 展示名 */
  displayName: string;
  /** slice 文件夹的绝对文件系统路径（PL-007 slicePath） */
  slicePath: string | null;
}

/** 逐 slice 的校验滚动条（工作区 + 任务高度）。仅在 PROOF 标签页活动时挂载，
 *  因此其文件读取从不在概览/steering 落地页触发。 */
export function ScopeProofRollup({ rows }: { rows: ProofRollupRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        label="工作范围内无切片"
        description="本工作范围尚未索引任何切片，因此暂无校验可投影。"
        variant="card"
        testId="proof-rollup-empty"
      />
    );
  }
  return (
    <div data-testid="proof-tab" className="space-y-6">
      <SectionHeader>校验 · 逐切片的工作凭证</SectionHeader>
      {rows.map((row) => (
        <ProofSliceCard key={row.name} sliceId={row.displayName} title={row.name} slicePath={row.slicePath} />
      ))}
    </div>
  );
}

/** 单 slice 的校验视图（slice 高度）。 */
export function SliceProofTab({
  sliceId,
  title,
  slicePath,
}: {
  sliceId: string;
  title: string;
  slicePath: string | null;
}) {
  return (
    <div data-testid="proof-tab" className="space-y-6">
      <SectionHeader>校验 · 工作凭证</SectionHeader>
      <ProofSliceCard sliceId={sliceId} title={title} slicePath={slicePath} />
    </div>
  );
}
