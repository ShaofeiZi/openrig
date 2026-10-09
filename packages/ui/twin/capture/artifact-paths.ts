// OPR.0.4.1.11.2（FR-5）——twin 截图的确定性产物命名与放置。
// 纯解析器：给定 slice + 界面 + 输出根，返回截图包装器写入的稳定、无冲突路径
// （intent.html / intent.png / change.diff），放在按 slice 划分的文件夹下。纯且确定性，
// 使同一输入总得到同一路径——这是 FR-2 确定性命名与 D-1 截两次校验所依赖的地基。
// `outRoot` 是参数（不写死），因为规范根路径 + 已存在项规范化的决策仍是开放约定
// （Open-Q3）；本模块只拥有确定性机制。
import path from "node:path";

export interface ArtifactPathInput {
  /** Slice 标识符——成为按 slice 划分的文件夹名（slug 化）。 */
  slice: string;
  /** 产物所捕获的界面/样机（例如一条路由或人类可读标签）——成为文件基名（slug 化）。 */
  surface: string;
  /** 数字孪生产物根，按 slice 划分的文件夹落在其下。 */
  outRoot: string;
}

export interface ArtifactPaths {
  /** outRoot/<slice-slug>——按 slice 划分的文件夹。 */
  dir: string;
  /** <dir>/<surface-slug>.intent.html——可重新生成的单文件原型。 */
  intentHtml: string;
  /** <dir>/<surface-slug>.intent.png——持久的 INTENT 截图（来自 twin，构建前）。 */
  intentPng: string;
  /** <dir>/<surface-slug>.proof.png——持久的 PROOF 截图（来自真实发布 UI，构建后）。与 intentPng 成对。 */
  proofPng: string;
  /** <dir>/<surface-slug>.change.diff——持久的 fixture/变体覆盖 diff。 */
  changeDiff: string;
}

/**
 * 把任意标签/路由 slug 化为小写、文件系统安全的 token，用作 SURFACE 基名：
 * 把每段非字母数字字符（含点和斜杠）折叠为单个连字符，并修剪首尾连字符。
 * 确定性（无时间/随机），输出可复现。用于界面/路由名——不要用于 slice-id（见 sanitizeSliceId）。
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * 把 slice 标识符清洗为按 slice 划分的文件夹名。与 slugify 不同，这里保留点号，
 * 因为已批准的约定（pm + brief1-curator）是 digital-twin/<slice-id>/，其中 slice-id 是
 * 带点的 OPR id（例如 `opr-0.4.1.11.2`）。转小写并把其他不安全片段（空格/斜杠等）折叠为
 * 单个连字符；点号保留。确定性。
 */
export function sanitizeSliceId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/** 为一次 twin 截图解析确定性产物路径。 */
export function resolveArtifactPaths(input: ArtifactPathInput): ArtifactPaths {
  const dir = path.posix.join(input.outRoot, sanitizeSliceId(input.slice));
  const base = slugify(input.surface);
  return {
    dir,
    intentHtml: path.posix.join(dir, `${base}.intent.html`),
    intentPng: path.posix.join(dir, `${base}.intent.png`),
    proofPng: path.posix.join(dir, `${base}.proof.png`),
    changeDiff: path.posix.join(dir, `${base}.change.diff`),
  };
}
