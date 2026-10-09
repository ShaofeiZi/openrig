// OPR.0.4.1.6 —— `rig scope` 的读时信任推导（FR-5）。
//
// scope-and-versioning 约定 §2 的拱心石：一个 `established`/`canonical`
// 工件，若其 `verified` 过期、缺失、无格式，或是尚未验证的占位符，
// 就按 `provisional` 处理。信任在【读时】由 (stage × verified) 推导，
// 绝不存储（存储下来的复合状态会再次腐化）。
//
// 这是 daemon skill-audit 在静态工件侧的姊妹逻辑。90 天新鲜度窗口 +
// bare/stale/verified 分类法镜像自
// `packages/daemon/src/domain/skill-audit.ts:34`（`FRESHNESS_WINDOW_DAYS = 90`）
// 及其 `checkStaleness`（:118-126）。daemon 模块无法从 CLI 导入
// （独立包；daemon 是被拉起的应用而非库），因此我们在此镜像常量 + 分类法，
// 而不跨包导入。约定本身不规定时间窗口——90 天是与 skill-audit 共享的承重锚点。

/** skill-audit.ts:34 的镜像——若该窗口变化请同步。 */
export const FRESHNESS_WINDOW_DAYS = 90;

export type VerifiedTrust =
  | "verified"               // <日期> 对 <真实来源>，且在窗口内
  | "stale_verified"         // <日期> 对 <真实来源>，超过窗口
  | "bare_verified"          // 有内容但无可解析的 `<日期> 对 <来源>`
  | "missing_verified"       // 缺失 / 为空
  | "unverified_provenance"; // 工具脚手架生成的占位来源，并非真正的验证

export interface VerifiedTrustResult {
  status: VerifiedTrust;
  date?: string;
  source?: string;
}

const VERIFIED_RE = /^(\d{4}-\d{2}-\d{2})\s+against\s+(.+)$/i;

// 工具写入的占位 provenance。没有一个是针对具名来源的真实验证，
// 因此携带它们的 established/canonical 不能冒充“新鲜”
// ——正是 §2 要堵的“看起来新鲜、实则在说谎”陷阱。
// `rig scope verified` 会用真实来源替换这些。
const PLACEHOLDER_PROVENANCE_RE =
  /\bscaffold \(rig scope create\)|\bbackfill \(rig scope repair\)|\(unverified\)/i;

function isValidISODate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  // 拒绝溢出的分量（例如 2026-13-99 → Date 会进位）。
  return d.toISOString().slice(0, 10) === dateStr;
}

/** 对 `verified:` frontmatter 取值分类。镜像 skill-audit 的 checkStaleness。 */
export function deriveVerifiedTrust(verified: unknown, now: Date = new Date()): VerifiedTrustResult {
  if (typeof verified !== "string" || verified.trim().length === 0) {
    return { status: "missing_verified" };
  }
  const m = VERIFIED_RE.exec(verified.trim());
  if (!m) {
    return { status: "bare_verified" };
  }
  const dateStr = m[1]!;
  const source = m[2]!.trim();
  if (!isValidISODate(dateStr)) {
    return { status: "bare_verified", date: dateStr };
  }
  if (PLACEHOLDER_PROVENANCE_RE.test(source)) {
    return { status: "unverified_provenance", date: dateStr, source };
  }
  const daysDiff = (now.getTime() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24);
  if (daysDiff > FRESHNESS_WINDOW_DAYS) {
    return { status: "stale_verified", date: dateStr, source };
  }
  return { status: "verified", date: dateStr, source };
}

export interface EffectiveStageResult {
  /** frontmatter 中写明的 stage（原样回显，可能为空）。 */
  declaredStage: string;
  /** 当下实际应信任的 stage。 */
  effectiveStage: string;
  /** 当声明的 stage 因 `verified` 偏弱而被降级时为 true。 */
  downgraded: boolean;
  /** 一行说明原因；未降级时为 null。 */
  reason: string | null;
}

/** 推导有效的（经信任调整的）stage。只有 `established`/`canonical` 会被降级——
 *  正是它们宣称“请依赖我”，因此偏弱的 `verified` 会把它们打回 `provisional`。
 *  wip/provisional/出口状态原样回显。 */
export function deriveEffectiveStage(stage: unknown, verifiedStatus: VerifiedTrust): EffectiveStageResult {
  const declaredStage = typeof stage === "string" ? stage : "";
  const claimsReliable = declaredStage === "established" || declaredStage === "canonical";
  const trusted = verifiedStatus === "verified";
  if (claimsReliable && !trusted) {
    return {
      declaredStage,
      effectiveStage: "provisional",
      downgraded: true,
      reason: `${declaredStage} 的 verified 状态为 ${verifiedStatus} -> 按 provisional 处理（scope-and-versioning §2）`,
    };
  }
  return { declaredStage, effectiveStage: declaredStage, downgraded: false, reason: null };
}

/** 便捷方法：从已解析的 frontmatter 对象推导完整的读时信任。 */
export function deriveScopeTrust(
  frontmatter: Record<string, unknown>,
  now: Date = new Date(),
): { verified: VerifiedTrustResult } & EffectiveStageResult {
  const verified = deriveVerifiedTrust(frontmatter.verified, now);
  const effective = deriveEffectiveStage(frontmatter.stage, verified.status);
  return { verified, ...effective };
}
