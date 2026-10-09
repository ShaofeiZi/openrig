// release-0.3.2 slice 12 —— 按
// `openrig-work/conventions/scope-and-versioning/README.md` §1 的 dot-ID 语法。
//
// 语法（v0 单项目）：
//   project  = <PFX>            （2-3 个字母；v0 硬编码为 "OPR"）
//   mission  = <PFX>.<ver>
//   slice    = <PFX>.<ver>.<n>
//   sub      = <PFX>.<ver>.<n>.<m>
//
// 从 mission 目录名推断版本：
//   release-X.Y[.Z]     → "X.Y[.Z]"         （发布列车）
//   其他任何名字        → "99.0.<m>" 逃逸带（纯数字；
//                          不带 alpha——约定 §1 明确要求）
//
// 逃逸带的 <m> 通过扫描同级非发布任务的既有 id，取 max+1 分配。
// 发布任务保留其 semver。

import type { DotId } from "./types.js";
import { ScopeCliError } from "./types.js";

/** OpenRig 单项目工作区的默认项目前缀。多项目工作需等待真正的第二个项目
 *  （约定 §1）。 */
export const DEFAULT_PROJECT_PREFIX = "OPR";

const RELEASE_NAME_RE = /^release-(\d+\.\d+(?:\.\d+)?)$/;
// 严格的位置语法：除位置 0 的 2-3 字母项目前缀外，每一段都是数字。
// 接受前缀后接 2-5 个数字段（mission 为 2-3，slice 为 3-4，sub-slice 为 4-5）。
// 下面按层级解析的辅助函数会正确切分 version/n/m。
const DOT_ID_RE = /^([A-Z]{2,3})\.(\d+(?:\.\d+){1,4})$/;

/** 把 dot-ID 字符串解析为结构化部分；当字符串不符合 §1 位置语法时返回 null。
 *  提供 `tier` 时，末尾若干段会被切到 `n`（slice）或 `n` + `m`（sub-slice）。
 *  不提供 tier 时，所有数字段都作为 `version` 返回，以保持向后兼容。 */
export function parseDotId(
  raw: string,
  tier?: "mission" | "slice" | "sub-slice",
): DotId | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const m = DOT_ID_RE.exec(trimmed);
  if (!m) return null;
  const project = m[1]!;
  const segments = m[2]!.split(".");
  if (!tier) {
    return { project, version: segments.join("."), n: undefined, m: undefined };
  }
  if (tier === "mission") {
    return { project, version: segments.join("."), n: undefined, m: undefined };
  }
  if (tier === "slice") {
    if (segments.length < 3) return null; // slice = ver(>=2) + n
    const verSegs = segments.slice(0, -1);
    const nSeg = segments[segments.length - 1]!;
    return { project, version: verSegs.join("."), n: Number(nSeg), m: undefined };
  }
  // sub-slice
  if (segments.length < 4) return null;
  const verSegs = segments.slice(0, -2);
  const nSeg = segments[segments.length - 2]!;
  const mSeg = segments[segments.length - 1]!;
  return { project, version: verSegs.join("."), n: Number(nSeg), m: Number(mSeg) };
}

/** 按 §1 逃逸带规则校验 mission 版本段数组。约定把非发布逃逸带定义为
 *  `<PFX>.99.0.<n>`——`99` 后的那个 `0` 是【固定】的。像 `99.7.8` 这样的版本
 *  不合法。isMissionDotId 与 isSliceDotId 内部的父版本校验共用本函数，
 *  保证两处口径一致。 */
function isValidMissionVerSegments(segs: string[]): boolean {
  if (segs.length < 2 || segs.length > 3) return false;
  if (segs[0] === "99") {
    // 逃逸带：恰好 [99, "0", "<序号>"]。`0` 段固定；<序号> 必须是非空数字串。
    return segs.length === 3 && segs[1] === "0" && /^\d+$/.test(segs[2] ?? "");
  }
  return true;
}

/** 基于深度的层级判别。按 §1，位置语法是固定的：
 *    mission   = <PFX>.<ver>           （ver = 2-3 个数字段；
 *                                       逃逸带恰好为 99.0.n）
 *    slice     = <PFX>.<ver>.<n>       （3-4 个数字段）
 *    sub-slice = <PFX>.<ver>.<n>.<m>   （4-5 个数字段）
 *  当 mission 形状与 slice 形状【重叠】时（例如 release X.Y mission 有 2 段；
 *  release X.Y.Z mission 有 3 段，这也正是 release X.Y mission 的 slice 形状），
 *  层级由深度解决：mission 最多 3 个数字段；slice 恒为 3-4；sub-slice 为 4-5。
 *  逃逸带完全无歧义，因为 §1 同时固定了 99 标记和其后的 0 段。 */
export function isMissionDotId(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const parsed = parseDotId(raw, "mission");
  if (!parsed) return false;
  return isValidMissionVerSegments(parsed.version.split("."));
}

export function isSliceDotId(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const parsed = parseDotId(raw, "slice");
  if (!parsed) return false;
  // slice = mission 版本 + 1 个序号。父版本本身必须是合法的 mission 形状
  // （包括逃逸带严格 [99.0.n] 规则——像 99.7.8 这样的父任务不是真正的 mission）。
  return isValidMissionVerSegments(parsed.version.split("."));
}

/** 把 DotId 渲染回规范的 dot 字符串。 */
export function formatDotId(id: DotId): string {
  const parts = [id.project, id.version];
  if (id.n !== undefined) parts.push(String(id.n));
  if (id.m !== undefined) parts.push(String(id.m));
  return parts.join(".");
}

/** 在父 mission id 后追加序号，组合出 slice id。 */
export function sliceIdFromMission(missionId: string, n: number): string {
  return `${missionId}.${n}`;
}

/** 未显式提供 id 时，从 mission 目录名推断 (project, version)。
 *  发布任务用其 semver；其他名字落入逃逸带，由调用方通过第二个参数给出下一个序号。 */
export function inferMissionDotId(
  missionFolderName: string,
  escapeBandOrdinal: number | null,
  projectPrefix: string = DEFAULT_PROJECT_PREFIX,
): string {
  const releaseMatch = RELEASE_NAME_RE.exec(missionFolderName);
  if (releaseMatch) {
    return `${projectPrefix}.${releaseMatch[1]}`;
  }
  if (escapeBandOrdinal === null) {
    throw new ScopeCliError({
      fact: `任务 "${missionFolderName}" 不匹配 release-X.Y[.Z] 模式，且未提供逃逸带序号。`,
      consequence: "无法为该任务推断 dot-ID。",
      action: "请传入显式序号，或把任务改名为 release-X.Y.Z，或在 CLI 上用 --id 指定。",
    });
  }
  return `${projectPrefix}.99.0.${escapeBandOrdinal}`;
}

/** 通过扫描同级 mission id 选出下一个逃逸带序号。
 *  查找 `<PFX>.99.0.<m>` 形状并返回 max(m)+1；无同级时从 1 开始。 */
export function nextEscapeBandOrdinal(
  existingIds: ReadonlyArray<string | null>,
  projectPrefix: string = DEFAULT_PROJECT_PREFIX,
): number {
  let max = 0;
  const re = new RegExp(`^${projectPrefix}\\.99\\.0\\.(\\d+)$`);
  for (const id of existingIds) {
    if (!id) continue;
    const m = re.exec(id);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/** 该候选字符串是否在【任意】层级都能解析为合法的 §1 dot-ID？
 *  在已知层级的调用点优先用按层级的 isMissionDotId/isSliceDotId——
 *  对形状重叠的发布 id，单凭深度无法区分 mission 与 slice。 */
export function isConformantDotId(raw: unknown): boolean {
  return typeof raw === "string" && parseDotId(raw) !== null;
}
