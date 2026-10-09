// Living Notes——确定性组合器（OPR.0.4.4.20，按 2026-07-05 的纠正性重设计重建）。
//
// 纯函数：`(gathered inputs) -> composed doc`。相同输入（包括调用方提供的视图时间事实
// nowIso/mainTip/git facts）产生逐字节相同输出。每个 section 都有具名 SSOT 与降级值；
// 来源缺失时渲染降级值，绝不捏造内容。从磁盘/队列/git 汇集输入的 gatherer 与本文件并列；
// 保持核心纯粹，使幂等 AC 在结构上成立。
//
// 纠正性设计 §3.1——组合器为每个切片构建唯一可渲染结构：INTENT → PLAN → DELIVERED 堆栈。
// 它不再发出 `sections`、`acceptance`、`compare`、`join` 或同级 `green` 字段。
// 旧 green 背后的记录判定严谨性只保留在两处：逐交付项 `verified` 信号（§11），以及
// 任务目标 ledger 的 completion green（FR-7：任务目标层级事实，不是切片结构）。

import YAML from "yaml";
import { createHash } from "node:crypto";
import type { ScopeReadiness, MissionReadiness } from "../proof/judgments.js";
import * as posixPath from "node:path/posix";
import { renderBriefSpine } from "./brief-spine.js";
import {
  C1_ARTIFACT_TYPES,
  C1_VERDICTS,
  GATE_ROLES,
  PHASE_LANE_LABELS,
  type AgentRow,
  type AgentsBand,
  type AgentsScope,
  type BoardSlot,
  type C1ArtifactType,
  type C1Verdict,
  type ComposedMissionReview,
  type ComposedRigAgents,
  type ComposedSliceReview,
  type DeliveredItem,
  type DerivedException,
  type GateRole,
  type LedgerRow,
  type LockState,
  type LockedArtifact,
  type NeedsYouBand,
  type NeedsYouItem,
  type WorkflowRowRef,
  type ProofArtifact,
  type ReviewMedia,
  type ReviewPhase,
  type SettledRow,
  type VerdictCell,
  type VerdictTone,
  type VerifyLineage,
} from "./types.js";
import {
  isScaffoldPlaceholderText,
  hasAuthoredNumberedItem,
  isPlaceholderOnlyBlock,
  isPristineScaffoldSection,
  selectProofContractBody,
} from "../scope/scaffold-placeholder.js";
import { parseLogicalCheckboxes, type LogicalCheckboxItem } from "../scope/logical-checkbox.js";

// --- 固定且可见的 v1 阈值（由 Markdown 引导的调优是具名后续项） ---
export const IDLE_WITH_WORK_THRESHOLD_MIN = 30;

// ---------------------------------------------------------------------------
// 媒体引用（共享结构辅助函数；纯字符串处理，不访问文件系统）
// ---------------------------------------------------------------------------

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".m4v"]);

function extOf(ref: string): string {
  const clean = ref.split(/[?#]/)[0]!;
  const i = clean.lastIndexOf(".");
  return i === -1 ? "" : clean.slice(i).toLowerCase();
}

export function mediaKind(ref: string): ReviewMedia["kind"] | null {
  const ext = extOf(ref);
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  return null;
}

/** 源字符串中的 Markdown/HTML 媒体引用；排除 http(s) 引用，因为媒体是切片同目录内容（FR-5）。 */
export function extractMediaRefs(markdown: string | null): string[] {
  if (!markdown) return [];
  const refs: string[] = [];
  const re = /!\[[^\]]*\]\(([^)]+)\)|<(?:video|img|source)[^>]*\ssrc="([^"]+)"/g;
  for (const m of markdown.matchAll(re)) {
    const ref = (m[1] ?? m[2] ?? "").trim();
    if (ref && !ref.startsWith("http")) refs.push(ref);
  }
  return refs;
}

/** 把相对 `baseDir`（切片相对根为 ""）书写的媒体引用归一化为切片相对路径。
 * 引用为绝对路径或越出切片目录时返回 null；调用方记录缺陷（FR-5），绝不静默丢弃。 */
export function sliceRelativeMediaPath(ref: string, baseDir: string): string | null {
  if (ref.startsWith("/")) return null;
  const joined = baseDir ? posixPath.join(baseDir, ref) : ref;
  const normalized = posixPath.normalize(joined);
  if (normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

function toReviewMedia(ref: string, baseDir: string): ReviewMedia | null {
  const kind = mediaKind(ref);
  if (!kind) return null;
  const src = sliceRelativeMediaPath(ref, baseDir);
  if (!src) return null;
  return { kind, src, caption: ref };
}

function dedupMedia(media: ReviewMedia[]): ReviewMedia[] {
  const seen = new Set<string>();
  return media.filter((m) => {
    if (seen.has(m.src)) return false;
    seen.add(m.src);
    return true;
  });
}

// ---------------------------------------------------------------------------
// C1 头部解析
// ---------------------------------------------------------------------------

/** 把证明 artifact 的 YAML frontmatter 解析为 ProofArtifact。集合外/缺失 verdict 转为 null
 *（artifact 存在不等同于 verdict，见 FR-2）；遇到畸形输入也不抛错。
 * 正文媒体引用会被捕获，供 §3.4 精选证明投影使用。 */
export function parseC1Header(content: string, relPath: string, droppedAtIso: string): ProofArtifact {
  const out: ProofArtifact = {
    relPath,
    slice: null,
    candidateSha: null,
    artifactType: null,
    verdict: null,
    moneyEvidence: null,
    evidences: [],
    selfCheck: null,
    mediaRefs: [],
    droppedAt: droppedAtIso,
  };
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  out.mediaRefs = extractMediaRefs(m ? content.slice(m[0].length) : content);
  if (!m) return out;
  let fm: Record<string, unknown>;
  try {
    fm = (YAML.parse(m[1]!) ?? {}) as Record<string, unknown>;
  } catch {
    return out;
  }
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : v != null && typeof v !== "object" ? String(v) : null);
  out.slice = str(fm["slice"]);
  out.candidateSha = str(fm["candidate_sha"]);
  const at = str(fm["artifact_type"]);
  out.artifactType = at && (C1_ARTIFACT_TYPES as readonly string[]).includes(at) ? (at as C1ArtifactType) : null;
  const v = str(fm["verdict"]);
  out.verdict = v && (C1_VERDICTS as readonly string[]).includes(v) ? (v as C1Verdict) : null;
  out.moneyEvidence = str(fm["money_evidence"]);
  out.selfCheck = str(fm["self_check"]);
  const ev = fm["evidences"];
  if (Array.isArray(ev)) out.evidences = ev.map((e) => String(e)).filter((e) => e.trim().length > 0);
  return out;
}

// ---------------------------------------------------------------------------
// FR-2——verdict 选择、通过映射、lineage（保留）
// ---------------------------------------------------------------------------

/** 固定的通过映射；“passing”绝不留给自由解释。 */
export function isPassing(artifactType: C1ArtifactType, verdict: C1Verdict | null): boolean {
  if (verdict === null) return false;
  if (artifactType === "qa") return verdict === "PASS";
  if (artifactType === "adjudication") return verdict === "CLEAR" || verdict === "PASS";
  // guard, rev1-r1, rev1-r2
  return verdict === "CLEAR";
}

function toneFor(artifactType: C1ArtifactType, verdict: C1Verdict | null): VerdictTone {
  if (verdict === null) return "unknown";
  return isPassing(artifactType, verdict) ? "pass" : "fail";
}

/** 每个 (candidate_sha, artifact_type) 采用最新项，这是批准的 C1 选择规则。
 * 未通过 verdict 只能被同一 tuple 的更晚 artifact 取代，不能被相邻 artifact、存在性或批准取代。 */
export function selectWinning(
  artifacts: ProofArtifact[],
  candidateSha: string | null,
): Map<C1ArtifactType, ProofArtifact> {
  const winning = new Map<C1ArtifactType, ProofArtifact>();
  for (const a of artifacts) {
    if (!a.artifactType) continue;
    if (candidateSha !== null && a.candidateSha !== candidateSha) continue;
    const prev = winning.get(a.artifactType);
    if (!prev || a.droppedAt > prev.droppedAt || (a.droppedAt === prev.droppedAt && a.relPath > prev.relPath)) {
      winning.set(a.artifactType, a);
    }
  }
  return winning;
}

/** 待评判候选项：最新落盘 gate artifact 的 candidate_sha；结果确定，同时间按 relPath 打破平局。
 * 没有 artifact 携带该值时为 null。 */
export function deriveCandidateSha(artifacts: ProofArtifact[]): string | null {
  let best: ProofArtifact | null = null;
  for (const a of artifacts) {
    if (!a.candidateSha || !a.artifactType || a.artifactType === "adjudication") continue;
    if (!best || a.droppedAt > best.droppedAt || (a.droppedAt === best.droppedAt && a.relPath > best.relPath)) best = a;
  }
  return best?.candidateSha ?? null;
}

export function deriveGateCells(artifacts: ProofArtifact[], candidateSha: string | null): VerdictCell[] {
  const winning = selectWinning(artifacts, candidateSha);
  return GATE_ROLES.map((role: GateRole): VerdictCell => {
    const a = winning.get(role);
    if (!a || a.verdict === null) {
      return { role, recordedToken: null, tone: "unknown", state: "missing", source: a?.relPath ?? null };
    }
    return {
      role,
      recordedToken: a.verdict,
      tone: toneFor(role, a.verdict),
      state: isPassing(role, a.verdict) ? "passing" : "non-passing",
      source: a.relPath,
    };
  });
}

export interface GitFacts {
  mainTip: string;
  /** 从 `Merge OPR.<id>` subject 解析；null 表示未合并。 */
  mergeSha: string | null;
  /** 合并后：merge 是否为 tip 的祖先？ */
  mergeIsAncestorOfTip: boolean | null;
  /** 合并前：候选项 merge-base 落后 tip 的 commit 数；null 表示 unknown。 */
  candidateBehindTip: number | null;
}

/** 合并前 fresh 标签允许落后 tip 的范围。 */
const FRESH_BEHIND_TOLERANCE = 3;

export function composeLineage(
  candidateSha: string | null,
  git: GitFacts,
  gateCells: VerdictCell[],
): VerifyLineage {
  let freshness: VerifyLineage["freshness"] = "unknown";
  let staleBehind: number | null = null;
  if (git.mergeSha !== null) {
    if (git.mergeIsAncestorOfTip !== null) freshness = git.mergeIsAncestorOfTip ? "fresh" : "stale";
  } else if (candidateSha !== null && git.candidateBehindTip !== null) {
    if (git.candidateBehindTip <= FRESH_BEHIND_TOLERANCE) {
      freshness = "fresh";
    } else {
      freshness = "stale";
      staleBehind = git.candidateBehindTip;
    }
  }
  return { candidateSha, mergeSha: git.mergeSha, mainTip: git.mainTip, freshness, staleBehind, gateCells };
}

// ---------------------------------------------------------------------------
// §4——两个 lock（已交付的分阶段批准印记，架构 F-A）
// ---------------------------------------------------------------------------

export interface ApprovalStampFacts {
  by: string;
  at: string;
  /** 通过一次查询交叉检查固定的 scope-approval 审计结构。 */
  auditRowPresent: boolean;
}

export interface ApprovalFacts {
  /** `--scope spec` 印记（approved-spec-by/at）→ plan.lock。 */
  spec: ApprovalStampFacts | null;
  /** `--scope delivery` 印记（approved-by/at）→ delivered.lock。 */
  delivery: ApprovalStampFacts | null;
}

export function lockFrom(stamp: ApprovalStampFacts | null): LockState | null {
  if (!stamp) return null;
  return { by: stamp.by, at: stamp.at, auditVerified: stamp.auditRowPresent };
}

// ---------------------------------------------------------------------------
// 任务目标 ledger green（FR-7）。它不是切片审阅结构：切片契约中同级的 `green` 字段
// 已移除（§11）；此记录判定计算只供任务目标完成 ledger 与 regime-2 confirm-faithful 触发器使用。
// 批准状态绝不影响它（BR-6）。
// ---------------------------------------------------------------------------

export interface RecordedGreen {
  green: boolean;
  /** 1 = 完整 gate-verdict 集；2 = 已裁决 confirm-faithful；非 green 时为 null。 */
  regime: 1 | 2 | null;
}

export function computeRecordedGreen(
  gateCells: VerdictCell[],
  artifacts: ProofArtifact[],
  candidateSha: string | null,
): RecordedGreen {
  if (gateCells.every((c) => c.state === "passing")) return { green: true, regime: 1 };
  const adjudication = selectWinning(artifacts, candidateSha).get("adjudication");
  if (adjudication && isPassing("adjudication", adjudication.verdict)) return { green: true, regime: 2 };
  return { green: false, regime: null };
}

/** 供任务目标 gatherer 使用的便捷函数：直接从切片 artifact 派生 ledger green；
 * candidate 与 gate cell 在内部派生。 */
export function composeRecordedGreenForSlice(artifacts: ProofArtifact[]): RecordedGreen {
  const candidateSha = deriveCandidateSha(artifacts);
  return computeRecordedGreen(deriveGateCells(artifacts, candidateSha), artifacts, candidateSha);
}

// ---------------------------------------------------------------------------
// FR-1——Markdown 结构提取（保留 extractor；此前供给的 sections/acceptance/compare 结构已移除）
// ---------------------------------------------------------------------------

const SECTION_HEADING_ALIASES: Readonly<Record<string, readonly string[]>> = {
  Intent: ["Intent", "意图"],
  "Mini-requirements(?:[^\\n]*)?": [
    "Mini-requirements(?:[^\\n]*)?",
    "最小需求(?:[^\\n]*)?",
    "小型需求(?:[^\\n]*)?",
  ],
  "Proof contract": ["Proof contract", "证明契约", "证据约定"],
  "Intent visual": ["Intent visual", "意图视觉稿", "意图视觉"],
};

/** 逐字提取中英文 H2 section 正文，保持字符完全相同。 */
export function extractSection(markdown: string | null, heading: string): string | null {
  if (!markdown) return null;
  const aliases = SECTION_HEADING_ALIASES[heading] ?? [heading];
  const re = new RegExp(`^##\\s+(?:${aliases.join("|")})\\s*$`, "im");
  const m = re.exec(markdown);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = markdown.slice(start);
  const next = rest.search(/^##?\s/m);
  const body = next === -1 ? rest : rest.slice(0, next);
  return body.replace(/^\n+/, "").replace(/\s+$/, "");
}

/** PRD 顶部固定的 mini-requirements 层级（plan.concise.text）。 */
export function extractMiniReqs(prd: string | null): string | null {
  return extractSection(prd, "Mini-requirements(?:[^\\n]*)?");
}

/** release-0.4.7 intent-stage：已提取的 mini-reqs section 至少包含一条文本并非 scaffold
 * 占位符的编号项时为 true；模板会生成 `1. [...]`。
 *
 * 单次解析固定点（架构 AR-2）：derivePhase 的 `prdAuthored` 信号与 PLAN 简洁渲染决策，
 * 必须同时派生自这一次 extractMiniReqs 提取的一次解析。在本文件任何位置引入第二套 mini-reqs
 * 语法，都会在文件内重现 seam map 的 R3 分歧类别。
 *
 * release-0.4.7 micro-bundle A：行语法现归属孪生模块的 `hasAuthoredNumberedItem`
 *（与 scope-audit 的两条 mini-reqs 支线共享，即 IF-3 句点/括号修复，架构 MB-AR-1）。
 * 本函数保留上述解析侧契约并委托语法。只有散文/项目符号时刻意视为未编写；
 * reviewer-L1 2026-07-11 裁定的 intent-stage gate 规定，批准从编号层级开始。 */
export function hasAuthoredMiniReqs(miniReqs: string | null): boolean {
  return hasAuthoredNumberedItem(miniReqs);
}

/** D2 `## Proof contract`（§3.1）中的一个承诺交付项：条目文本，以及可选的 planned-mockup
 * 引用；后者以 Markdown 图片写在同一复选框行
 *（`- [ ] 抽屉向右打开 ![模型图](mockups/x.png)`）。 */
export interface PromisedItem {
  text: string;
  /** VM-006（架构 PIN-C，Option-A raw-key join）：编写的契约行正文原样保存，只做 trim；
   * 在移除行内图片并生成 `text` 之前捕获。Progress 标签页的验收行保留原始复选框文本，
   * 因而此字段使两个标签页按验收去重已使用的同一关系关联。`text` 仍移除图片并保持逐字节不变，
   * 因此 `refMatches` 与所有 DELIVERED 渲染不受影响。 */
  rawText: string;
  plannedRef: string | null;
}

// KI-5.3-2——logical-checkbox 语法（LogicalCheckboxItem + parseLogicalCheckboxes）现归属孪生模块
// ../scope/logical-checkbox.ts，与 CLI 逐字节一致，使 `zrig proof add` 索引的条目与本组合器
// 渲染的条目相同。此处重新导出，使现有读取方（slice-detail-projector）继续从组合器导入；
// 单次解析保持不变。
export { parseLogicalCheckboxes };
export type { LogicalCheckboxItem };

/** judgment 权威与读取方共享的身份；保留现有回执哈希。 */
export function proofItemIdentity(rawText: string): { id: string; text: string } {
  const declared = /<!--\s*proof-item:\s*([a-zA-Z0-9_-]+)\s*-->/.exec(rawText);
  const text = rawText.replace(/<!--\s*proof-item:\s*[a-zA-Z0-9_-]+\s*-->/g, "").trim();
  return { id: declared?.[1] ?? `item-${createHash("sha256").update(JSON.stringify(text)).digest("hex").slice(0, 20)}`, text };
}

export function extractProofContract(prd: string | null): PromisedItem[] {
  const body = extractSection(prd, "Proof contract");
  if (!body) return [];
  const items: PromisedItem[] = [];
  // 单次解析：共享 logical-checkbox 关系，续行已连接。
  for (const logical of parseLogicalCheckboxes(body)) {
    // release-0.4.7 intent-stage：scaffold 模板占位行不算承诺；原始契约提取为 []，
    // 使 DELIVERED 如实渲染空状态，而非 "missing" 行（共享语法见 ../scope/scaffold-placeholder.ts）。
    if (isScaffoldPlaceholderText(logical.rawText)) continue;
    // 编写的字节就是记录的 rawText，即 VM-006 key。展示文本由它派生（移除图片），
    // key 本身保持移除前形式。
    const rawText = logical.rawText;
    let text = rawText;
    let plannedRef: string | null = null;
    const img = text.match(/!\[[^\]]*\]\(([^)]+)\)/);
    if (img) {
      plannedRef = img[1]!.trim();
      text = text.replace(img[0], "").replace(/\s{2,}/g, " ").trim();
    }
    items.push({ text, rawText, plannedRef });
  }
  return items;
}

// ---------------------------------------------------------------------------
// PM dogfood #1（qitem-20260720015700-630eef64）——逐 section 来源选择，由本组合器与
// slice-detail projector 共享：已编写 PRD section 是规范来源；仅含 scaffold 且保持原样的
// PRD section 则让位给已编写（非原样 scaffold）的 README section。缺失、散文格式错误或
// 混合编写的 PRD section 仍以 PRD 为规范来源（isPristineScaffoldSection(null) 为 false，
// 缺失 section 不触发回退）。它不感知状态，不读取 lifecycle status。
// 现有 extractor 保持不变，这些函数只在外层封装。
// ---------------------------------------------------------------------------

export function extractMiniReqsSelected(
  prd: string | null,
  readme: string | null,
  spec: string | null = null,
): { body: string | null; fromReadme: boolean } {
  if (spec !== null) return { body: extractMiniReqs(spec), fromReadme: false };
  const prdBody = extractMiniReqs(prd);
  if (isPristineScaffoldSection(prdBody)) {
    const readmeBody = extractMiniReqs(readme);
    if (readmeBody !== null && !isPristineScaffoldSection(readmeBody)) return { body: readmeBody, fromReadme: true };
  }
  return { body: prdBody, fromReadme: false };
}

// KI-5.3-2 第二表面（row e69daaef）：来源选择唯一归属于 scaffold-placeholder 孪生模块
//（selectProofContractBody），使本读取方、scope-audit 孪生实现与 proof-add 不再对回退目标产生分歧。
// 已确认的脑裂曾表现为 proof-add 从 SPEC 派生，而本读取方在没有 SPEC 路径时回退 README。
// 可选 `spec` 参数让旧版双参数调用方继续编译；在参数接入前，它们保持已交付的仅 README 行为。
export function extractProofContractSelected(prd: string | null, readme: string | null, spec: string | null = null): { items: PromisedItem[]; fromReadme: boolean; source: "prd" | "spec" | "readme" | null } {
  const selection = selectProofContractBody({
    prdBody: extractSection(prd, "Proof contract"),
    specBody: extractSection(spec, "Proof contract"),
    readmeBody: extractSection(readme, "Proof contract"),
  });
  if (selection.source === "spec") return { items: extractProofContract(spec), fromReadme: false, source: "spec" };
  if (selection.source === "readme") return { items: extractProofContract(readme), fromReadme: true, source: "readme" };
  // source 为 "prd"（已编写）或 null（没有已编写内容）时沿用已交付行为：解析 PRD；
  // 原样/缺失 PRD 产生自身的空/占位条目集，`source` 告诉调用方当前状态。
  const authoredPrd = !isPristineScaffoldSection(extractSection(prd, "Proof contract"));
  return { items: extractProofContract(prd), fromReadme: false, source: authoredPrd && prd !== null ? "prd" : null };
}

// ---------------------------------------------------------------------------
// FR-3——派生阶段（五类，自上而下优先级；保留）
// ---------------------------------------------------------------------------

export interface PhaseSignals {
  /** spec 携带已编写结构（架构 AR-2）：过滤占位符后的承诺项，或已编写且非占位符的 mini-reqs
   * 编号项；从逐 section 选定来源读取（PM dogfood #1：入选的已编写 README section 会计入，
   * 原样 scaffold PRD 仍不算 spec）。取代旧版文件存在性 `prdPresent`。 */
  prdAuthored: boolean;
  /** 只计算真实落盘的 proof artifact（`artifacts.length > 0`）。PROOF.md 在切片创建时即生成
   * scaffold，因此文件存在本身不是构建证据；其 VERDICT 内容已通过
   * `verdictOrEvidenceSetPresent` 进入 review 层级（release-0.4.7 intent-stage）。 */
  realProofArtifactsPresent: boolean;
  activeQitemPresent: boolean;
  /** 存在 evidence/verdict 集（任一已记录 verdict，或声明的 PROOF.md + 媒体集）。 */
  verdictOrEvidenceSetPresent: boolean;
  /** PLAN 的 plan-lock 印记（`--scope spec`）：由明确授权写入，是操作员不依赖内容
   * 把切片提升为 spec 的如实覆盖。 */
  specLocked: boolean;
  /** 交付批准印记。 */
  approved: boolean;
}

/** 按优先级自上而下：locked > review > building > spec > intent。
 * 明确写出顺序，因为一个信号可能满足两个通道。
 *
 * phase 标签描述 SDLC artifact 进度，而非协作活动（架构 AR-3）：单独的跟踪 qitem 属于协作，
 * 只有与已编写/已锁定 spec 配对时才计入 building；协作本身渲染在 queue/agents 区域。 */
export function derivePhase(s: PhaseSignals): ReviewPhase {
  if (s.approved) return "locked";
  if (s.verdictOrEvidenceSetPresent) return "review";
  if (s.realProofArtifactsPresent || (s.activeQitemPresent && (s.specLocked || s.prdAuthored))) return "building";
  if (s.prdAuthored || s.specLocked) return "spec";
  return "intent";
}

// ---------------------------------------------------------------------------
// §3.1 DELIVERED——重新设计的关联：planned ↔ curated proof ↔ verified
// ---------------------------------------------------------------------------

/** `evidences:` 引用按精确文本或从 1 开始的索引匹配承诺项。 */
function refMatches(ref: string, promised: PromisedItem[], index: number): boolean {
  const trimmed = ref.trim();
  return trimmed === promised[index]!.text || trimmed === String(index + 1);
}

export interface ComposedDelivered {
  items: DeliveredItem[];
  extraProof: ReviewMedia[];
  /** 为 ▲ insufficient-proof（FR-4）与看板 building 单元格 n/m（FR-7）提供数据。 */
  missingCount: number;
  /** 越出切片目录的 artifact 媒体引用（FR-5 缺陷发现）。 */
  escapingRefs: string[];
}

/** 仅供展示使用；不改变 readiness 协议枚举。 */
function readinessStateLabel(state: string): string {
  return ({
    ready: "就绪",
    "not-ready": "未就绪",
    accepted: "已接受",
    pending: "待处理",
    rejected: "已拒绝",
    withdrawn: "已撤回",
    unknown: "未知",
    legacy: "旧版",
  } as Record<string, string>)[state] ?? state;
}

/**
 * `delivered.items` 就是重新设计后的关联（§3.1）：每个 `## Proof contract` 交付项
 * 与覆盖它的 artifact 精选证明媒体、QA 已记录的比较信号配对。
 *
 * `verified` 绑定已交付的 C1 字段（架构 F3），绝不依据存在性：
 *   verified   — 覆盖该项的 qa|adjudication artifact 记录了比较（self_check），
 *                且已记录 verdict 为通过；
 *   unverified — 存在覆盖 artifact，但没有已记录且通过的 QA 比较（仍显示 QA 驳回说明）；
 *   missing    — 已承诺但没有交付。
 * 结构上失败开放：这些只是渲染状态，绝不阻塞。
 */
export function composeDelivered(promised: PromisedItem[], artifacts: ProofArtifact[], readiness?: ScopeReadiness): ComposedDelivered {
  const escaping = new Set<string>();
  const mediaOf = (a: ProofArtifact): ReviewMedia[] => {
    const out: ReviewMedia[] = [];
    for (const ref of a.mediaRefs) {
      const m = toReviewMedia(ref, "proof");
      if (m) out.push(m);
      else if (mediaKind(ref)) escaping.add(ref);
    }
    return out;
  };
  const byLatest = (a: ProofArtifact, b: ProofArtifact) =>
    a.droppedAt < b.droppedAt ? 1 : a.droppedAt > b.droppedAt ? -1 : a.relPath.localeCompare(b.relPath);

  const covered = new Set<string>();
  const items: DeliveredItem[] = promised.map((p, i) => {
    const covering = artifacts.filter((a) => a.evidences.some((ref) => refMatches(ref, promised, i))).sort(byLatest);
    covering.forEach((a) => covered.add(a.relPath));
    const qaCovering = covering.filter((a) => a.artifactType === "qa" || a.artifactType === "adjudication");
    const winners = selectWinning(covering, deriveCandidateSha(covering));
    const verifiedBy = qaCovering.find((a) => a.artifactType !== null && winners.get(a.artifactType) === a && a.selfCheck !== null && isPassing(a.artifactType, a.verdict));
    const noteSource = qaCovering.find((a) => a.selfCheck !== null) ?? covering.find((a) => a.selfCheck !== null);
    const plannedRef = p.plannedRef ? toReviewMedia(p.plannedRef, "") : null;
    if (p.plannedRef && !plannedRef && mediaKind(p.plannedRef)) escaping.add(p.plannedRef);
    const item: DeliveredItem = {
      promised: plannedRef ? { text: p.text, plannedRef } : { text: p.text },
      proof: dedupMedia(covering.flatMap(mediaOf)),
      verified: verifiedBy ? "verified" : covering.length > 0 ? "unverified" : "missing",
    };
    const note = noteSource?.selfCheck ?? null;
    if (note) item.note = note;
    if (readiness?.configured) {
      const current = readiness.items.find(i => i.id === proofItemIdentity(p.rawText).id);
      item.verified = current?.state === "accepted" && !readiness.issues.length ? "verified" : current?.judgment || covering.length ? "unverified" : "missing";
      item.note = current ? `判定 ${readinessStateLabel(current.state)}：${current.reason}` : `当前判定不可用：${readiness.issues.join("; ")}`;
    } else if (verifiedBy) item.note = `旧版已记录验证（未绑定条目修订）。${item.note ?? ""}`.trim();
    return item;
  });

  // 有帮助但未映射的 artifact（§6）：其媒体在 extraProof 标签下有界渲染；
  // 保持可见，绝不丢弃，也绝不堆到主视图中。
  const extraProof = dedupMedia(
    artifacts
      .filter((a) => !covered.has(a.relPath))
      .sort(byLatest)
      .flatMap(mediaOf),
  );

  return {
    items,
    extraProof,
    missingCount: items.filter((it) => it.verified === "missing").length,
    escapingRefs: [...escaping].sort(),
  };
}

// ---------------------------------------------------------------------------
// FR-4——需要你处理（两个来源、一个队列）+ 智能体（保留）
// ---------------------------------------------------------------------------

export interface AttentionInput {
  qitemId: string;
  summary: string | null;
  leg: string;
  where: string;
  createdAtIso: string | null;
  priority: string | null;
  tier: string | null;
  evidenceRef: string | null;
  unblocks: string | null;
  destinationSession: string | null;
  closureRequiredAtIso: string | null;
  /** OPR.0.4.6.WF4 Q6——item 携带 `instance:<id>` workflow-exception tag 时由 gatherer 设置；
   * 逐字携带到结果行。 */
  workflow?: WorkflowRowRef;
}

export interface AgentInput {
  agentName: string;
  sessionName: string;
  runtime: AgentRow["runtime"];
  /** 队列证明的 park 目标（human/qitem 等）；null 表示没有 parked 行状态。 */
  parkedOn: string | null;
  /** null 表示 telemetry 不可用（如实 unknown）。 */
  idle: boolean | null;
  idleSinceIso: string | null;
  doing: string | null;
  holdsCount: number;
  lastTransitionIso: string | null;
  slices: string[];
}

function minutesBetween(aIso: string, bIso: string): number {
  return Math.floor((Date.parse(bIso) - Date.parse(aIso)) / 60_000);
}

/** ▲ insufficient-proof 规则读取的交付完整性事实（原为旧 join 的计数；§3.1 重新绑定后，
 * 信号为 delivered.items 的 MISSING 数量）。 */
export interface DeliveredCounts {
  promisedCount: number;
  missingCount: number;
}

/** 对已捕获信号应用四条 ▲ 异常规则。每行都携带证据和越过的阈值；没有证据就没有异常，
 * 绝不无依据指控。▲ 是给人看的信息，对被标记智能体的工作流不可见。 */
export function deriveExceptions(
  agents: AgentInput[],
  attention: AttentionInput[],
  delivered: DeliveredCounts,
  scopeLabel: string,
  nowIso: string,
  latestArtifactIso: string | null,
  governingStampIso: string | null,
): NeedsYouItem[] {
  const items: NeedsYouItem[] = [];
  const push = (identity: string, summary: string, d: DerivedException) => {
    items.push({
      source: "derived",
      identity,
      summary,
      leg: d.kind,
      where: scopeLabel,
      ageIso: null,
      priority: null,
      tier: null,
      evidenceRef: null,
      unblocks: null,
      qitemId: null,
      destinationSession: null,
      derived: d,
    });
  };

  for (const a of agents) {
    if (a.idle === true && a.holdsCount > 0 && a.idleSinceIso) {
      const idleMin = minutesBetween(a.idleSinceIso, nowIso);
      if (idleMin >= IDLE_WITH_WORK_THRESHOLD_MIN) {
        push(
          `${a.sessionName}|stuck|${a.idleSinceIso}`,
          `${a.agentName} 似乎已卡住`,
          {
            kind: "stuck",
            evidence: `空闲 ${idleMin}m >= 默认值 ${IDLE_WITH_WORK_THRESHOLD_MIN}m · 持有 ${a.holdsCount}`,
            threshold: `有工作时空闲 >= ${IDLE_WITH_WORK_THRESHOLD_MIN}m`,
          },
        );
      }
    }
  }
  for (const q of attention) {
    if (q.closureRequiredAtIso && q.closureRequiredAtIso < nowIso) {
      push(
        `${q.qitemId}|overdue|${q.closureRequiredAtIso}`,
        `${q.summary ?? q.qitemId} 已逾期`,
        {
          kind: "overdue",
          evidence: `要求在 ${q.closureRequiredAtIso} 前关闭 · 当前 ${nowIso}`,
          threshold: "已超过 closure_required_at",
        },
      );
    }
  }
  if (delivered.promisedCount > 0 && delivered.missingCount > 0) {
    push(
      `${scopeLabel}|insufficient-proof|${delivered.missingCount}`,
      `证明不足：${delivered.promisedCount} 个承诺项中缺少 ${delivered.missingCount} 个`,
      {
        kind: "insufficient-proof",
        evidence: `${delivered.promisedCount} 个承诺交付项中有 ${delivered.missingCount} 个缺少已交付证据`,
        threshold: "delivered.items 的 MISSING 数量 > 0",
      },
    );
  }
  if (latestArtifactIso && governingStampIso && latestArtifactIso > governingStampIso) {
    push(
      `${scopeLabel}|stale-after-change|${latestArtifactIso}`,
      "artifact 在治理印记后发生变化",
      {
        kind: "stale-after-change",
        evidence: `${latestArtifactIso} 的 artifact 晚于 ${governingStampIso} 的印记`,
        threshold: "artifact 晚于治理印记",
      },
    );
  }
  return items;
}

export function composeNeedsYou(
  attention: AttentionInput[],
  derived: NeedsYouItem[],
  confirmFaithful: NeedsYouItem[],
  computedOver: string,
  nowIso: string,
): NeedsYouBand {
  const agentItems: NeedsYouItem[] = attention.map((q) => ({
    source: "agent",
    // OPR.0.4.6.WF4 Q6——逐字携带 gatherer 的指针；非工作流项省略，按省略保持字节身份。
    ...(q.workflow ? { workflow: q.workflow } : {}),
    identity: q.qitemId,
    summary: q.summary ?? q.qitemId,
    leg: q.leg,
    where: q.where,
    ageIso: q.createdAtIso,
    priority: q.priority,
    tier: q.tier,
    evidenceRef: q.evidenceRef,
    unblocks: q.unblocks,
    qitemId: q.qitemId,
    destinationSession: q.destinationSession,
    derived: null,
  }));
  // 单次计数身份规则：只在当前范围内对不同身份去重。
  const seen = new Set<string>();
  const all = [...agentItems, ...confirmFaithful, ...derived].filter((i) => {
    if (seen.has(i.identity)) return false;
    seen.add(i.identity);
    return true;
  });
  // 按优先级排序，影响最大者优先：先显式 priority 等级，再按年龄。
  const rank: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  all.sort((a, b) => {
    const ra = rank[a.priority ?? "normal"] ?? 2;
    const rb = rank[b.priority ?? "normal"] ?? 2;
    if (ra !== rb) return ra - rb;
    return (a.ageIso ?? "9999") < (b.ageIso ?? "9999") ? -1 : 1;
  });
  return {
    items: all,
    provenance:
      all.length === 0
        ? `0 个待关注项 · 0 个 park · 0 个未确认证明 · 根据 ${computedOver} 计算于 ${nowIso}`
        : `根据 ${computedOver} 计算于 ${nowIso}`,
  };
}

// --- OPR.0.4.4.22（slice 22）：智能体范围异常 + 工作组读取根（保留） ---

/** OPR.0.4.6.WF5 FR-3——▲ 区域的一条已记录工作流实例视图。GATHERER 只根据已记录状态
 *（workflow_instances + 队列行 + WF-1 评估器判定 + 按 tag 查询的开放异常项）组装；
 * 本模块以纯函数方式派生行。 */
export interface WorkflowExceptionInput {
  instanceId: string;
  workflowName: string;
  status: string;
  currentStepId: string | null;
  /** WF-1 评估器对 frontier 的判定状态（"healthy" 或 overdue 状态）及证据行，
   * 由 gatherer 预先组合。此处绝不重新计算，确保阈值只有一个归属。 */
  deadlineState: string;
  deadlineEvidence: string | null;
  /** frontier id 解析到非开放 packet 时为 true。这是带外损坏状态；
   * WF-3 FR-6 守卫负责预防，本行作为检测兜底。 */
  frontierRefsNonOpenPacket: boolean;
  /** 此实例的开放异常项（按 tag 查询）；不存在时为 null。 */
  openItem: {
    qitemId: string;
    destinationSession: string;
    humanRouted: boolean;
    createdAtIso: string | null;
    summary: string | null;
  } | null;
}

/**
 * OPR.0.4.6.WF5 FR-3——workflow_instances ▲ 来源与感知通道。跨通道只计一次（BR-3）：
 * 带活跃人员路由 ● 项的异常在此不渲染任何内容，因为该项本身就是人员行；
 * ORCHESTRATOR 路由 ● 项只渲染一条感知行（同一身份、第二投影，使人能在高层看到）；
 * 没有项的失败实例渲染 ▲ 兜底，同时指出异常和缺项异常（兜底触发本身就是 bug 证据）。
 * 健康实例渲染零行，满足该区域零噪声负向要求。通过派生保持持久：每次组合都从已记录状态
 * 重新计算；状态退出时通过重组清除行，绝不手工清除。
 */
export function deriveWorkflowExceptions(
  workflows: WorkflowExceptionInput[],
  scopeLabel: string,
  nowIso: string,
): NeedsYouItem[] {
  const workflowStateLabel = (state: string): string => ({
    failed: "失败",
    "overdue-claimed": "已认领但逾期",
    "overdue-unclaimed": "未认领且逾期",
  })[state] ?? state;
  const items: NeedsYouItem[] = [];
  const push = (
    identity: string,
    summary: string,
    d: DerivedException,
    evidenceRef: string | null,
    workflow: WorkflowRowRef,
  ) => {
    items.push({
      source: "derived",
      // OPR.0.4.6.WF4 Q6——每条派生工作流行都携带指针。
      workflow,
      identity,
      summary,
      leg: d.kind,
      where: scopeLabel,
      ageIso: null,
      priority: null,
      tier: null,
      evidenceRef,
      unblocks: null,
      qitemId: null,
      destinationSession: null,
      derived: d,
    });
  };
  for (const w of workflows) {
    const trace = `zrig workflow trace ${w.instanceId}`;
    // OPR.0.4.6.WF4 Q6——此实例发出的每行都携带指针；身份仅在此处派生一次，
    // 绝不由下游自然语言派生。
    const wref: WorkflowRowRef = {
      instanceId: w.instanceId,
      workflowName: w.workflowName,
      ...(w.currentStepId ? { stepId: w.currentStepId } : {}),
    };
    // 无论 item 状态如何都触发异常兜底，因为损坏与异常路由相互正交。
    if (w.frontierRefsNonOpenPacket) {
      push(
        `${w.instanceId}|anomaly|frontier-non-open`,
        `${w.workflowName} 实例 frontier 引用了已关闭 packet`,
        {
          kind: "anomaly",
          evidence: `实例 ${w.instanceId} 的 frontier 指向非开放 packet；带外关闭绕过了 WF-3 关闭路径守卫`,
          threshold: "frontier packet 必须处于开放状态",
        },
        trace,
        wref,
      );
    }
    const exceptional =
      w.status === "failed" || (w.deadlineState !== "healthy" && w.deadlineEvidence !== null);
    if (!exceptional) continue;
    const kindLabel = workflowStateLabel(w.status === "failed" ? "failed" : w.deadlineState);
    if (w.openItem && w.openItem.humanRouted) {
      // ● item 已位于人员待关注支线；在此再生成一行会重复渲染，违反单次计数。
      continue;
    }
    if (w.openItem) {
      // ORCHESTRATOR 路由：感知行包含 holder、age 与 evidence；用于感知而非分派。
      // 使用与 ● item 相同的记录身份，投影到人员区域。
      const ageMin = w.openItem.createdAtIso ? minutesBetween(w.openItem.createdAtIso, nowIso) : null;
      push(
        `${w.instanceId}|awareness|${w.openItem.qitemId}`,
        `感知：${w.workflowName} ${kindLabel} · 由 ${w.openItem.destinationSession} 持有`,
        {
          kind: "awareness",
          evidence: `${w.openItem.destinationSession} 上的异常项 ${w.openItem.qitemId}${ageMin !== null ? `，已持续 ${ageMin}m` : ""}${w.openItem.summary ? ` — ${w.openItem.summary}` : ""}`,
          threshold: "感知（orchestrator 正在处理；步骤可处于任意时间点）",
        },
        trace,
        wref,
      );
      continue;
    }
    // 没有 item：▲ 兜底同时指出异常与缺项异常。
    push(
      `${w.instanceId}|workflow-${kindLabel}|no-item`,
      `${w.workflowName} 实例为 ${kindLabel}，但没有异常项`,
      {
        kind: w.status === "failed" ? "workflow-failed" : "stuck",
        evidence: `${w.deadlineEvidence ?? `实例 ${w.instanceId} 在步骤 ${w.currentStepId ?? "?"} 为 ${kindLabel}`} · 缺项异常：never-lost 通道未生成条目（这本身就是 bug，请报告）`,
        threshold: w.status === "failed" ? "失败实例应携带异常项" : "已超过 WF-1 截止时间评估器阈值",
      },
      trace,
      wref,
    );
  }
  return items;
}

/** 第三个具名 ▲ 启发式规则的可见 v1 默认值（slice-22 FR-3：too-long-in-state，
 * 超过阈值仍无转换）。它位于此处，因为 compose.ts 是唯一阈值归属（P2 架构注记 N2）：
 * 只需改一次，各层级都会继承。与 IDLE_WITH_WORK_THRESHOLD_MIN 一样，Markdown 引导调优是后续项。 */
export const TOO_LONG_IN_STATE_THRESHOLD_MIN = 120;

/**
 * Slice-22 FR-3——智能体范围 ▲ 集，严格包含三个具名启发式规则：idle-with-assigned-work、
 * overdue handoff、too-long-in-state。前两个复用 deriveExceptions 规则（调用时交付计数为零，
 * 且无 artifact/stamp 事实，因此切片专用 insufficient-proof / stale-after-change 不会触发）；
 * too-long-in-state 在此追加，使切片范围组合逐字节不变。没有证据就没有异常：unknown 不是 idle，
 * unknown lastTransition 也不是 too-long。
 */
export function deriveAgentScopeExceptions(
  agents: AgentInput[],
  attention: AttentionInput[],
  scopeLabel: string,
  nowIso: string,
): NeedsYouItem[] {
  const items = deriveExceptions(agents, attention, { promisedCount: 0, missingCount: 0 }, scopeLabel, nowIso, null, null);
  for (const a of agents) {
    if (a.holdsCount > 0 && a.lastTransitionIso) {
      const sinceMin = minutesBetween(a.lastTransitionIso, nowIso);
      if (sinceMin >= TOO_LONG_IN_STATE_THRESHOLD_MIN) {
        items.push({
          source: "derived",
          identity: `${a.sessionName}|too-long-in-state|${a.lastTransitionIso}`,
          summary: `${a.agentName} 已有 ${sinceMin}m 未发生转换`,
          leg: "stuck",
          where: scopeLabel,
          ageIso: null,
          priority: null,
          tier: null,
          evidenceRef: null,
          unblocks: null,
          qitemId: null,
          destinationSession: null,
          derived: {
            kind: "stuck",
            evidence: `无转换 ${sinceMin}m >= 默认值 ${TOO_LONG_IN_STATE_THRESHOLD_MIN}m · 持有 ${a.holdsCount}`,
            threshold: `状态停留过久 >= ${TOO_LONG_IN_STATE_THRESHOLD_MIN}m`,
          },
        });
      }
    }
  }
  return items;
}

export interface RigComposeInputs {
  agents: AgentInput[];
  overdue: AttentionInput[];
  attention: AttentionInput[];
  settled: SettledRow[];
  handoffsToday: number;
  overdueCount: number;
  /** FR-1 roster 展示窗口，在 provenance 表面具名（plan-review 裁定：
   * “根据 queue+ps 计算 · 窗口：今日”）。 */
  rosterWindow: string;
  /** OPR.0.4.6.WF5 FR-3：已记录的工作流实例视图（可选）。 */
  workflows?: WorkflowExceptionInput[];
  nowIso: string;
}

/** Slice-22 FR-1..FR-4——工作组范围组合根。纯函数：相同输入产生逐字节相同输出，
 * 幂等性是关键证明。 */
export function composeRigAgents(inputs: RigComposeInputs): ComposedRigAgents {
  const { nowIso } = inputs;
  const scopeLabel = "rig";
  const derived = [
    ...deriveAgentScopeExceptions(inputs.agents, inputs.overdue, scopeLabel, nowIso),
    ...deriveWorkflowExceptions(inputs.workflows ?? [], scopeLabel, nowIso),
  ];
  const needsYou = composeNeedsYou(
    inputs.attention,
    derived,
    [],
    `queue+ps（工作组范围）· 窗口：${inputs.rosterWindow}`,
    nowIso,
  );
  const band = composeAgentsBand(inputs.agents, "rig", derived, nowIso);
  return {
    scope: "rig",
    needsYou,
    agents: {
      ...band,
      provenance:
        band.rows.length === 0
          ? `没有正在或近期持有工作的智能体 · 根据 queue+ps 计算 · 窗口：${inputs.rosterWindow} · 时间：${nowIso}`
          : `根据 queue+ps 计算 · 窗口：${inputs.rosterWindow} · 时间：${nowIso}`,
      // FR-4：每个范围一条健康状态行，来自 transitions 日志。
      coordinationHealth: `今日 ${inputs.handoffsToday} 次交接 · ${inputs.overdueCount} 个逾期`,
    },
    settled: inputs.settled,
    settledProvenance:
      inputs.settled.length === 0
        ? `今日 0 次交接 · 根据队列转换计算 · 窗口：今日 · 时间：${nowIso}`
        : `根据队列转换计算 · 窗口：今日 · 时间：${nowIso}`,
    composedAt: nowIso,
  };
}

/** 区域成员关系从当前范围上的工作派生，绝不依据工作组共存关系。 */
export function composeAgentsBand(
  agents: AgentInput[],
  scope: AgentsScope,
  exceptions: NeedsYouItem[],
  nowIso: string,
): AgentsBand {
  const rows: AgentRow[] = agents.map((a) => {
    const ex = exceptions.find((e) => e.derived && e.identity.startsWith(`${a.sessionName}|`));
    return {
      agentName: a.agentName,
      runtime: a.runtime,
      stateGlyph: a.parkedOn ? "parked" : a.idle === null ? "unknown" : a.idle ? "idle" : "active",
      doing: a.doing,
      holdsCount: a.holdsCount,
      lastTransitionIso: a.lastTransitionIso,
      exception: ex?.derived ?? null,
      sessionName: a.sessionName,
      slices: a.slices,
    };
  });
  return {
    scope,
    rows,
    provenance:
      rows.length === 0
        ? `没有正在或近期持有工作的智能体 · 根据队列计算于 ${nowIso}`
        : `根据队列计算于 ${nowIso}`,
    coordinationHealth: null,
  };
}

// ---------------------------------------------------------------------------
// 切片组合根——唯一结构（§3.1）
// ---------------------------------------------------------------------------

export interface SliceComposeInputs {
  readiness?: ScopeReadiness;
  slice: { name: string; id: string | null; title: string; missionId: string | null };
  /** 原始文件内容（null 表示缺失）。 */
  readme: string | null;
  /** 提供 `readme` 的节点文件名；缺失时保持旧版调用方行为。 */
  nodeFileName?: "SPEC.md" | "README.md";
  prd: string | null;
  proofMd: string | null;
  artifacts: ProofArtifact[];
  /** 固定的计划集：从切片 README 的 `locked-artifacts:` 读取 frontmatter。 */
  lockedArtifacts: LockedArtifact[];
  /** 在组合来源中找到的媒体引用；绝对路径或越界路径属于缺陷发现（FR-5）。 */
  mediaRefs: string[];
  /** 切片 proof/ 目录存在时为 true；该目录是“查看所有证明”的深入目标。 */
  proofDirExists: boolean;
  attention: AttentionInput[];
  agents: AgentInput[];
  /** OPR.0.4.6.WF5 FR-3：已记录的工作流实例视图（可选；缺失时与 WF-5 前逐字节一致）。 */
  workflows?: WorkflowExceptionInput[];
  activeQitemPresent: boolean;
  git: GitFacts;
  approval: ApprovalFacts;
  nowIso: string;
}

/** 切片自身 PROOF.md 中自我声明的 PASS；绝不视为 verdict。 */
export function proofClaimsPass(proofMd: string | null): boolean {
  if (!proofMd) return false;
  return proofMd
    .split(/\r?\n/)
    .some((line) => /^\s*(?:Closed by:.*\bVerdict:|Verdict:|Result:)\s*PASS\b/i.test(line));
}

function sectionMedia(sectionBody: string | null, escaping: Set<string>): ReviewMedia[] {
  const out: ReviewMedia[] = [];
  for (const ref of extractMediaRefs(sectionBody)) {
    const m = toReviewMedia(ref, "");
    if (m) out.push(m);
    else if (mediaKind(ref)) escaping.add(ref);
  }
  return out;
}

export function composeSliceReview(inputs: SliceComposeInputs): ComposedSliceReview {
  const { slice, nowIso } = inputs;
  const sliceRef = `${slice.missionId ?? "?"}/slices/${slice.name}`;

  const candidateSha = deriveCandidateSha(inputs.artifacts);
  const gateCells = deriveGateCells(inputs.artifacts, candidateSha);
  const lineage = composeLineage(candidateSha, inputs.git, gateCells);
  const planLock = lockFrom(inputs.approval.spec);
  const deliveredLock = lockFrom(inputs.approval.delivery);

  const escaping = new Set<string>();
  // release-0.4.7 micro-bundle B：仅含占位符的 Intent section（已交付模板将其 scaffold
  // 为一整行方括号内容）在来源处视为缺失，使现有“未记录意图”降级触发；不新增字符串，
  // UI/freeze 继承（R7）。块内存在任一已编写行时，逐字保留整个 section（字节身份例外）。
  const currentSpec = inputs.nodeFileName === "SPEC.md" ? inputs.readme : null;
  const legacyReadme = inputs.nodeFileName === "SPEC.md" ? null : inputs.readme;
  const intentTextRaw = extractSection(inputs.readme, "Intent");
  const intentText = intentTextRaw !== null && !isPlaceholderOnlyBlock(intentTextRaw) ? intentTextRaw : null;
  const intentMedia = sectionMedia(intentText, escaping);
  // PM dogfood #1——逐 section 选定来源：已编写 PRD 为规范来源；原样 scaffold-only PRD
  // section 让位给已编写 README section。每个 section 的一次选定解析同时驱动渲染与下方
  // phase 信号，保留单次解析固定点 AR-2/S5。
  const miniSel = extractMiniReqsSelected(inputs.prd, legacyReadme, currentSpec);
  const miniReqs = miniSel.body;
  const planMedia = dedupMedia([
    ...sectionMedia(miniReqs, escaping),
    ...inputs.lockedArtifacts
      .map((a): ReviewMedia | null => (mediaKind(a.path) ? toReviewMedia(a.path, "") : null))
      .filter((m): m is ReviewMedia => m !== null),
  ]);

  const promised = extractProofContractSelected(inputs.prd, legacyReadme, currentSpec).items;
  const delivered = composeDelivered(promised, inputs.artifacts, inputs.readiness);
  delivered.escapingRefs.forEach((r) => escaping.add(r));

  const claimedPass = proofClaimsPass(inputs.proofMd);
  const anyRecordedVerdict = gateCells.some((c) => c.state !== "missing");
  const evidencePresent = inputs.artifacts.length > 0 || claimedPass;

  // release-0.4.7 intent-stage：`promised` 是过滤占位符后的契约，在上方从选定来源仅提取一次，
  // 同时供 DELIVERED 与此信号消费；`miniReqsIsAuthored` 从唯一一次选定 mini-reqs 解析派生，
  // 并驱动下方 PLAN 简洁渲染，保持单次解析固定点。PM dogfood #1：入选的已编写 README section
  // 作为已编写结构计数，渲染与信号始终同步。
  const miniReqsIsAuthored = hasAuthoredMiniReqs(miniReqs);
  const phase = derivePhase({
    prdAuthored: (currentSpec !== null || inputs.prd !== null) && (promised.length > 0 || miniReqsIsAuthored),
    realProofArtifactsPresent: inputs.artifacts.length > 0,
    activeQitemPresent: inputs.activeQitemPresent,
    verdictOrEvidenceSetPresent: anyRecordedVerdict || claimedPass,
    specLocked: planLock !== null,
    approved: deliveredLock !== null,
  });

  // Regime 2：存在证据但没有已记录的通过状态 → confirm-faithful。
  const recordedGreen = computeRecordedGreen(gateCells, inputs.artifacts, candidateSha);
  const confirmFaithful: NeedsYouItem[] = [];
  if (!inputs.readiness?.configured && !recordedGreen.green && evidencePresent && claimedPass) {
    confirmFaithful.push({
      source: "agent",
      identity: `${slice.name}|confirm-faithful|${candidateSha ?? "no-sha"}`,
      summary: "确认此证明真实可靠",
      leg: "confirm-faithful",
      where: sliceRef,
      ageIso: null,
      priority: "high",
      tier: null,
      evidenceRef: "PROOF.md",
      unblocks: `${slice.name} 达到通过条件（regime 2）`,
      qitemId: null,
      destinationSession: null,
      derived: null,
    });
  }

  const latestArtifactIso = inputs.artifacts.reduce<string | null>(
    (acc, a) => (acc === null || a.droppedAt > acc ? a.droppedAt : acc),
    null,
  );
  const derived = deriveExceptions(
    inputs.agents,
    inputs.attention,
    { promisedCount: promised.length, missingCount: delivered.missingCount },
    sliceRef,
    nowIso,
    latestArtifactIso,
    inputs.approval.delivery?.at ?? null,
  );
  const workflowDerived = deriveWorkflowExceptions(inputs.workflows ?? [], sliceRef, nowIso);
  const needsYou = composeNeedsYou(inputs.attention, [...derived, ...workflowDerived], confirmFaithful, "queue+artifacts", nowIso);
  const agents = composeAgentsBand(inputs.agents, `slice:${slice.name}`, derived, nowIso);

  // FR-5：越出切片的媒体引用属于缺陷发现，绝不静默不渲染。绝对路径与 ../ 遍历段都会越出
  // 同目录契约（d6135921 的 rev1 回补，slice-19 路径约束类别）。
  const defects = [
    ...inputs.mediaRefs
      .filter((r) => r.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(r))
      .map((r) =>
        r.startsWith("/")
          ? `绝对媒体路径（必须为切片相对路径）：${r}`
          : `媒体引用越出切片目录（必须同目录存放）：${r}`,
      ),
    ...[...escaping]
      .sort()
      .map((r) =>
        r.startsWith("/")
          ? `绝对媒体路径（必须为切片相对路径）：${r}`
          : `媒体引用越出切片目录（必须同目录存放）：${r}`,
      ),
  ];

  return {
    slice: slice.name,
    sliceId: slice.id,
    title: slice.title,
    missionId: slice.missionId,
    phase,
    laneLabel: PHASE_LANE_LABELS[phase],
    intent: {
      text: intentText,
      media: intentMedia,
      ssotPath: inputs.readme !== null ? `${sliceRef}/${inputs.nodeFileName ?? "README.md"}` : null,
      degrade: intentText === null ? "未记录意图" : null,
    },
    plan: {
      // release-0.4.7 intent-stage（S5 合入）：没有已编写编号项的 mini-reqs section
      //（按架构 AR-2，仅占位符或仅散文）渲染为缺失，使现有“— 尚未规划”降级触发；
      // 使用与 phase 信号相同的 boolean，保持单次解析固定点。
      concise: { text: miniReqsIsAuthored ? miniReqs : null, media: planMedia },
      lockedArtifacts: inputs.lockedArtifacts,
      lock: planLock,
      // PM dogfood #1——SSOT 指针跟随选定的 mini-reqs 来源；当已编写 README section
      // 胜过原样 PRD section 时指向 README。来源缺失行为不变。
      ssotPath: currentSpec !== null
        ? `${sliceRef}/SPEC.md`
        : miniSel.fromReadme
          ? `${sliceRef}/README.md`
        : inputs.prd !== null ? `${sliceRef}/IMPLEMENTATION-PRD.md` : null,
    },
    delivered: {
      items: delivered.items,
      extraProof: delivered.extraProof,
      lock: deliveredLock,
      proofDirPath: inputs.proofDirExists ? `${sliceRef}/proof` : null,
    },
    needsYou,
    agents,
    lineage,
    defects,
    ...(inputs.readiness ? { readiness: inputs.readiness } : {}),
    composedAt: nowIso,
  };
}

// ---------------------------------------------------------------------------
// FR-7——任务目标组合（看板 + ledger + 联合区域；保留；ledger 的 green 是任务目标层级
// 已记录 verdict 的完成事实）
// ---------------------------------------------------------------------------

export interface MissionSliceEntry {
  review: ComposedSliceReview;
  /** 完成 ledger 的已记录 verdict green；由持有切片 artifact 的 gatherer 对其调用
   * computeRecordedGreen 后提供。 */
  green: boolean;
}

export interface MissionComposeInputs {
  readiness?: MissionReadiness;
  mission: { name: string; id: string | null; title: string; intent?: string | null };
  slices: MissionSliceEntry[];
  missionAttention: AttentionInput[];
  agents: AgentInput[];
  nowIso: string;
}

export function composeMissionReview(inputs: MissionComposeInputs): ComposedMissionReview {
  const { nowIso } = inputs;

  const board: BoardSlot[] = inputs.slices.map(({ review: s, green }) => {
    let stageCell: string;
    switch (s.phase) {
      case "spec":
        stageCell = s.plan.lock ? `规格已批准 ${s.plan.lock.at}` : "规格未盖章";
        break;
      case "building":
        stageCell =
          s.delivered.items.length > 0
            ? `${s.delivered.items.filter((it) => it.verified !== "missing").length}/${s.delivered.items.length} 个证明`
            : "构建中";
        break;
      case "review":
        stageCell = `${green ? "通过" : "未通过"} · ${s.lineage.mergeSha ?? "未合并"}`;
        break;
      case "locked":
        stageCell = `已盖章 ${s.delivered.lock?.at ?? "?"}`;
        break;
      default:
        stageCell = "意图";
    }
    if (s.readiness?.configured) stageCell = `证明 ${readinessStateLabel(s.readiness.state)} · ${s.readiness.revision.slice(0, 12)}`;
    const changedSinceStamp = s.needsYou.items.some((i) => i.derived?.kind === "stale-after-change");
    return {
      slice: s.slice,
      title: s.title,
      phase: s.phase,
      laneLabel: s.laneLabel,
      agentsCount: s.agents.rows.length,
      stageCell,
      changedSinceStamp,
      attentionWorthy: s.needsYou.items.length > 0 || changedSinceStamp,
    };
  });

  // 完成 ledger：对任务目标切片集执行查询，绝不是编写列表；结构上防遗漏。
  const ledger: LedgerRow[] = inputs.slices.map(({ review: s, green }) => ({
    slice: s.slice,
    candidateSha: s.lineage.candidateSha,
    gateCells: s.lineage.gateCells,
    mergeSha: s.lineage.mergeSha,
    needsHumanCount: s.needsYou.items.length,
    green: s.readiness?.configured ? s.readiness.state === "ready" : green,
  }));

  // Cut-complete：只有每个切入切片都满足 (a) green、(b) 已合并、(c) 开放 needs-human 项为零时
  // 才为 TRUE；绝不从 status 字段推断。
  const incomplete = ledger.filter((r) => !(r.green && r.mergeSha !== null && r.needsHumanCount === 0));
  const cutComplete = ledger.length > 0 && incomplete.length === 0;

  // 任务目标 NEEDS YOU = 联合查询（slice ∪ mission ∪ ▲），按身份去重；
  // 一个条目出现在 N 个层级，表示从 N 个高度看到同一条目。
  const seen = new Set<string>();
  const unionItems: NeedsYouItem[] = [];
  for (const { review: s } of inputs.slices) {
    for (const i of s.needsYou.items) {
      if (!seen.has(i.identity)) {
        seen.add(i.identity);
        unionItems.push(i);
      }
    }
  }
  const missionBand = composeNeedsYou(inputs.missionAttention, [], [], "任务目标队列与切片并集", nowIso);
  for (const i of missionBand.items) {
    if (!seen.has(i.identity)) {
      seen.add(i.identity);
      unionItems.push(i);
    }
  }

  const agents = composeAgentsBand(inputs.agents, `mission:${inputs.mission.name}`, [], nowIso);

  const composed: ComposedMissionReview = {
    ...(inputs.readiness ? { readiness: inputs.readiness } : {}),
    mission: inputs.mission.name,
    missionId: inputs.mission.id,
    title: inputs.mission.title,
    intent: inputs.mission.intent ?? null,
    briefSpine: { building: "", progress: "", proven: "", needsYou: "" },
    board,
    ledger,
    cutComplete,
    cutCompleteBasis: (inputs.slices.some(s => s.review.readiness?.configured) ? "证明就绪度加历史合并/关注事实；结果与发布决策仍彼此独立。" : "") + (cutComplete
      ? `切入的 ${ledger.length} 个切片全部通过、已合并且需人工处理项为零 · 计算于 ${nowIso}`
      : `${ledger.length} 个切片中有 ${incomplete.length} 个尚未完成切入（${incomplete.map((r) => r.slice).join(", ") || "无"}）· 计算于 ${nowIso}`),
    needsYou: {
      items: unionItems,
      provenance:
        unionItems.length === 0
          ? `${inputs.slices.length} 个切片中有 0 个待关注项 · 根据 queue+artifacts 计算于 ${nowIso}`
          : `${inputs.slices.length} 个切片范围与任务目标范围的并集 · 计算于 ${nowIso}`,
    },
    agents,
    composedAt: nowIso,
  };
  composed.briefSpine = renderBriefSpine(composed);
  return composed;
}
