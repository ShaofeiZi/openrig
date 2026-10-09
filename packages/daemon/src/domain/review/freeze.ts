// Living Notes Packet 2——由 approval 触发的冻结导出（OPR.0.4.4.20 FR-6）。
//
// 唯一的同步 compose-and-freeze 路径，在 approval stamp + audit row 提交后调用（Packet 1
// FR-9 的 interface cell 一侧）。renderer 是架构固定的最小字符串模板 renderer：把组合文档转成
// 一份静态、自包含 HTML，CSS 内联，图片以内联 data: URI 保存，视频通过链接引用并内联 poster；
// 不发起外部 fetch，也不依赖重型库。契约是 AC（file:// 自包含），而不是 twin build 的 Vite
// plugin；该 plugin 是 build-time 先例，本处只在 runtime 镜像其行为，不直接复用。
//
// 失败语义：这里绝不修改 stamp 和 audit row，render 失败不会撤销 approval。通过后台服务的
// 原子文件写入路径执行 exclusive-create（受 allowlist 约束并记录 actor 审计）；export 已存在时，
// 再次调用是幂等 no-op。

import * as fs from "node:fs";
import * as path from "node:path";
import type { FileWriteService } from "../files/file-write-service.js";
import { FileWriteError } from "../files/file-write-service.js";
import type { AllowlistRoot } from "../files/path-safety.js";
import type { ComposedSliceReview, LockState, VerdictCell } from "./types.js";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov"]);
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function esc(s: string | null | undefined): string {
  return (s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function dataUri(absPath: string): string | null {
  const ext = path.extname(absPath).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return null;
  try {
    return `data:${mime};base64,${fs.readFileSync(absPath).toString("base64")}`;
  } catch {
    return null;
  }
}

function verdictChip(cell: VerdictCell): string {
  // G1：chip 文本逐字使用已记录 token；tone 是独立 class。
  const token = cell.recordedToken ?? "missing";
  return `<span class="chip tone-${cell.tone}">${esc(cell.role)}: ${esc(token)}</span>`;
}

/**
 * media 内联的 slice-dir containment（d6135921 的 rev1 fixback，即 slice-19 路径 containment
 * 类别）：冻结 export 是设计中的未来 broadcast payload，因此 traversal/symlink ref 绝不能把
 * slice 目录外文件内联为 data URI。先检查 resolve prefix，再对现有文件检查 realpath，避免
 * slice 内 symlink 逃逸。返回安全绝对路径，或返回 null 并渲染弱化的 unavailable 分支；绝不
 * 静默，也绝不内联。
 */
function containedMediaPath(sliceDir: string, ref: string): string | null {
  if (ref.startsWith("/")) return null;
  const rootResolved = path.resolve(sliceDir);
  const resolved = path.resolve(sliceDir, ref);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null;
  try {
    const real = fs.realpathSync(resolved);
    const realRoot = fs.realpathSync(rootResolved);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    return real;
  } catch {
    // 文件缺失时，resolve-prefix 已证明 containment；调用方由 existsSync/dataUri 使用弱化分支
    // 处理缺失。
    return resolved;
  }
}

/** 渲染 slice 目录内的 media：图片内联，视频使用链接和 poster。 */
function mediaBlock(sliceDir: string, mediaRefs: string[]): string {
  const parts: string[] = [];
  const images = mediaRefs.filter((r) => IMAGE_EXTS.has(path.extname(r).toLowerCase()));
  const videos = mediaRefs.filter((r) => VIDEO_EXTS.has(path.extname(r).toLowerCase()));
  for (const ref of images) {
    const safe = containedMediaPath(sliceDir, ref);
    const uri = safe ? dataUri(safe) : null;
    if (uri) parts.push(`<figure><img src="${uri}" alt="${esc(ref)}"><figcaption>${esc(ref)}</figcaption></figure>`);
    else parts.push(`<p class="muted">${safe ? "image unavailable" : "media outside slice dir"}: ${esc(ref)}</p>`);
  }
  for (const ref of videos) {
    if (containedMediaPath(sliceDir, ref) === null) {
      parts.push(`<p class="muted">media outside slice dir: ${esc(ref)}</p>`);
      continue;
    }
    // 为保持单文件简单性，视频绝不嵌入；同目录同 basename 的 screenshot poster 存在时，
    // 内联显示在链接旁。
    const base = ref.slice(0, ref.length - path.extname(ref).length);
    const poster = [".png", ".jpg", ".jpeg"]
      .map((e) => `${base}${e}`)
      .find((p) => {
        const safePoster = containedMediaPath(sliceDir, p);
        return safePoster !== null && fs.existsSync(safePoster);
      });
    const safePosterPath = poster ? containedMediaPath(sliceDir, poster) : null;
    const posterUri = safePosterPath ? dataUri(safePosterPath) : null;
    parts.push(
      `<figure>${posterUri ? `<img src="${posterUri}" alt="poster for ${esc(ref)}">` : ""}` +
        `<figcaption>video (by link): <a href="${esc(ref)}">${esc(ref)}</a></figcaption></figure>`,
    );
  }
  return parts.join("\n");
}

const STYLE = `
body{font-family:ui-serif,Georgia,serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#1c1917;background:#fafaf9}
h1,h2{font-family:ui-sans-serif,system-ui,sans-serif}
.chip{display:inline-block;border:1px solid #a8a29e;border-radius:4px;padding:.1rem .45rem;margin:.1rem;font-family:ui-monospace,monospace;font-size:.8rem}
.tone-pass{background:#dcfce7}.tone-fail{background:#fee2e2}.tone-unknown{background:#f5f5f4}
.locked{border:2px solid #1c1917;padding:.6rem 1rem;margin:1rem 0;font-weight:600}
.unverified{border:3px solid #b91c1c;color:#b91c1c;padding:.6rem 1rem;margin:1rem 0;font-weight:700}
.muted{color:#78716c}
.col{border:1px solid #d6d3d1;padding: .75rem;margin:.5rem 0}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #d6d3d1;padding:.3rem .5rem;text-align:left;font-size:.9rem}
img{max-width:100%;height:auto;border:1px solid #d6d3d1}
figure{margin:1rem 0}figcaption{font-size:.8rem;color:#78716c}
pre{white-space:pre-wrap;font-family:inherit}
`;

function stampLine(label: string, lock: LockState | null): string {
  if (!lock) return `<p class="muted">○ ${esc(label)}——未盖章</p>`;
  return lock.auditVerified
    ? `<div class="locked">✓ ${esc(label)}——${esc(lock.by)} 于 ${esc(lock.at)} 盖章</div>`
    : `<div class="unverified">未验证的 ${esc(label)} 盖章——frontmatter 声明 ${esc(lock.by)} 于 ${esc(lock.at)} 盖章，但不存在匹配的审计行</div>`;
}

const VERIFIED_WORDS: Record<string, string> = {
  verified: "✓ QA 已对照计划验证",
  unverified: "◇ 未验证——没有已记录的 QA 比较",
  missing: "✗ 缺失——已有承诺但未交付",
};

/** 组合 slice review 的冻结单文件 HTML，静态镜像唯一的 INTENT → PLAN → DELIVERED stack
 *（CORRECTIVE §3.1）。 */
export function renderFrozenSliceHtml(composed: ComposedSliceReview, sliceDir: string, mediaRefs: string[]): string {
  const lineage = composed.lineage;
  const deliveredRows = composed.delivered.items
    .map(
      (it) =>
        `<tr><td>${esc(it.promised.text)}</td><td>${esc(VERIFIED_WORDS[it.verified] ?? it.verified)}</td><td>${esc(it.note ?? "—")}</td><td>${it.proof.length === 0 ? "—" : it.proof.map((p) => esc(p.src)).join("<br>")}</td></tr>`,
    )
    .join("\n");

  // Evidence media = source-scan ref + curated proof set（相对 slice 的 src）；全部遵循同一
  // contained-path 规则内联。
  const evidenceRefs = [
    ...new Set([
      ...mediaRefs,
      ...composed.delivered.items.flatMap((it) => it.proof.map((p) => p.src)),
      ...composed.delivered.extraProof.map((p) => p.src),
    ]),
  ];

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>评审——${esc(composed.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${esc(composed.title)}</h1>
<p class="muted">${esc(composed.slice)}${composed.sliceId ? ` · ${esc(composed.sliceId)}` : ""} · 泳道 ${esc(composed.laneLabel)} · 于 ${esc(composed.composedAt)} 从组合结果冻结</p>
${stampLine("证明锁（完成）", composed.delivered.lock)}

<h2>验证传承</h2>
<p>证明于：<code>${esc(lineage.candidateSha ?? "未知")}</code> · 合并于：<code>${esc(lineage.mergeSha ?? "未合并")}</code> · 主分支尖端：<code>${esc(lineage.mainTip)}</code> · ${esc(lineage.freshness)}${lineage.staleBehind !== null ? `（落后 ${lineage.staleBehind}）` : ""}</p>
<p>${lineage.gateCells.map(verdictChip).join(" ")}</p>

<h2>意图</h2>
<div class="col"><pre>${esc(composed.intent.text ?? composed.intent.degrade)}</pre></div>

<h2>计划</h2>
<div class="col"><pre>${esc(composed.plan.concise.text ?? "—")}</pre>
${composed.plan.lockedArtifacts.length > 0 ? `<p class="muted">锁定集合：${composed.plan.lockedArtifacts.map((a) => `${esc(a.name)}（${esc(a.kind)}：${esc(a.path)}）`).join(" · ")}</p>` : ""}
${stampLine("计划锁（将构建此集合）", composed.plan.lock)}</div>

<h2>已交付</h2>
${composed.delivered.items.length === 0 ? `<p class="muted">计划中未声明证明契约</p>` : `<table><tr><th>承诺项</th><th>验证状态</th><th>QA 备注</th><th>精选证明</th></tr>${deliveredRows}</table>`}
${composed.delivered.extraProof.length > 0 ? `<p class="muted">补充证明（未关联到单个交付物）：${composed.delivered.extraProof.map((p) => esc(p.src)).join(" · ")}</p>` : ""}

<h2>证据</h2>
${mediaBlock(sliceDir, evidenceRefs)}

<h2>冻结时需要你处理</h2>
${composed.needsYou.items.length === 0 ? `<p class="muted">${esc(composed.needsYou.provenance)}</p>` : `<ul>${composed.needsYou.items.map((i) => `<li>${esc(i.summary)} <span class="muted">(${esc(i.leg)})</span></li>`).join("\n")}</ul>`}

${composed.defects.length > 0 ? `<h2>缺陷发现</h2><ul>${composed.defects.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}
</body>
</html>
`;
}

export function frozenFileName(scopeId: string | null, fallbackName: string, approvedAtIso: string | null): string {
  const id = (scopeId ?? fallbackName).replaceAll("/", "-");
  const date = approvedAtIso ? approvedAtIso.slice(0, 10) : "undated";
  return `REVIEW-${id}-${date}.html`;
}

export type FreezeOutcome =
  | { ok: true; path: string; alreadyFrozen: boolean }
  | { ok: false; error: "stamp_missing" | "not_found" | "allowlist_missing" | "write_failed"; message: string; hint?: string };

/** 把绝对目录映射为 (allowlist root, relative path)，无法映射时返回 null。 */
export function resolveAllowlisted(allowlist: AllowlistRoot[], absDir: string): { root: string; rel: string } | null {
  let real: string;
  try {
    real = fs.realpathSync(absDir);
  } catch {
    return null;
  }
  for (const r of allowlist) {
    if (real === r.canonicalPath || real.startsWith(r.canonicalPath + path.sep)) {
      return { root: r.name, rel: path.relative(r.canonicalPath, real) };
    }
  }
  return null;
}

export function freezeSliceExport(opts: {
  composed: ComposedSliceReview;
  sliceDir: string;
  mediaRefs: string[];
  allowlist: AllowlistRoot[];
  writeService: FileWriteService;
  actor: string;
  /** freeze audit row 的 P21 §4 era-stamp：transport 派生时为 `transport:v1`，UI
   *  named-deferral / claimed-era 路径为 null；传给 createAtomic audit。 */
  identityProvenance?: string | null;
}): FreezeOutcome {
  const { composed } = opts;
  if (!composed.delivered.lock) {
    return {
      ok: false,
      error: "stamp_missing",
      message: `slice '${composed.slice}' 没有 delivery approval stamp；只有 approve verb 提交后才触发 freeze（无论本次 render 如何，stamp + audit row 都保留）`,
    };
  }
  const mapped = resolveAllowlisted(opts.allowlist, opts.sliceDir);
  if (!mapped) {
    return {
      ok: false,
      error: "allowlist_missing",
      message: `slice 文件夹 '${opts.sliceDir}' 不在任何 OPENRIG_FILES_ALLOWLIST 根目录下；freeze 写路径受 allowlist 约束`,
      hint: `请添加 OPENRIG_FILES_ALLOWLIST=<name>:${path.dirname(opts.sliceDir)}（或其父根目录），然后重启后台服务`,
    };
  }
  const fileName = frozenFileName(composed.sliceId, composed.slice, composed.delivered.lock.at);
  const relPath = path.join(mapped.rel, fileName);
  const html = renderFrozenSliceHtml(composed, opts.sliceDir, opts.mediaRefs);
  try {
    const result = opts.writeService.createAtomic({ rootName: mapped.root, path: relPath, content: html, actor: opts.actor, identityProvenance: opts.identityProvenance ?? null });
    return { ok: true, path: result.absolutePath, alreadyFrozen: false };
  } catch (err) {
    if (err instanceof FileWriteError && err.code === "target_exists") {
      // 对同一 approval 幂等重入：export 已存在，冻结 export 永不重写（不变量 8）。
      return { ok: true, path: path.join(opts.sliceDir, fileName), alreadyFrozen: true };
    }
    return {
      ok: false,
      error: "write_failed",
      message: `freeze render/write 失败（approval stamp 和 audit row 仍保留；修复后重新调用）：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
