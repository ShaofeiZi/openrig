// OPR.0.4.4.19 FR-9——scope approve：frontmatter 唯一 writer + 仅追加 audit 行
//（终止凭感觉传递的审批）。
//
// 按设计位于后台服务侧（plan-review 已确认；arch-lead interface-cell 通过）：stamp 是 workspace
// frontmatter 写入，audit 行是 mission_control_actions 插入；freeze-trigger interface cell
//（Packet 2）在 stamp+audit 提交后调用 compose-and-freeze endpoint。因此 stamp+audit 对位于一个
// 后台服务操作之后。
//
// 顺序（arch-lead 钉扎，2026-07-04）：先 frontmatter → 后 audit → audit 失败时显著失败并按字节恢复
// 原 frontmatter。拒绝补偿性 DELETE 方案——绝不从 mission_control_actions 删除行；保持仅追加。
//
// 两阶段职责清晰（BR-6，已批准）：approval 是 freeze/LOCKED 触发器和 regime-2 sign-off，绝不是
// proven-green 的来源。此处不计算也不存储“green”。

import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import type { MissionControlActionLog } from "../mission-control/mission-control-action-log.js";
import { derivePlanLockArtifacts, isContentlessPlanLockSet } from "./plan-lock-artifacts.js";
import { sliceRelativeMediaPath } from "../review/compose.js";
import { NODE_FILE_PRECEDENCE, resolveNodeFile } from "./node-file.js";

export type ScopeTier = "slice" | "mission";
export type ApprovalScope = "spec" | "delivery";

export interface ScopeApproveInput {
  scopeTier: ScopeTier;
  /** 相对于 missions 根目录的 canonical 路径（例如
   *  "release-0.4.4/slices/19-living-notes-signal-layer" 或 "release-0.4.4"）。 */
  scopePath: string;
  /** 分阶段审批（founder 不再 defer）：`spec` = “SPEC 符合我的 intent”（首个接受点）；
   * `delivery` = 最终 sign-off（freeze 触发器）。上游省略 ⇒ delivery（向后兼容）。 */
  approvalScope: ApprovalScope;
  /** 真实调用 session（如实记录 provenance，绝不被 delegation 覆盖）。 */
  actorSession: string;
  /** P21 era-stamp：actorSession 的确定方式。当 route 从认证 transport chokepoint 派生 actor 时传入
   * `transport:v1`；省略（null）⇒ claimed-era（直接调用方 / P21 前行），渲染为“已记录（验证前时代）”，
   * 绝不重新标记。 */
  identityProvenance?: string | null;
  /** 委托审批：agent 代表 founder 调用时，此 stamp 记录谁的决定。仅记录在 audit notes 中。 */
  onBehalfOf?: string | null;
  /** OPR.0.5.0.18——修订/重新盖章：用一份新的有理由 attestation 重新批准已批准 scope，取代先前
   * attestation（两者都保留在仅追加 audit log 中；ARCH-SHAPING 9d64ceb6 v2）。原子性：采用相同的
   * frontmatter-first → audit-second → byte-restore 顺序，不存在 unapprove 窗口。 */
  reApprove?: boolean;
  /** 使用 reApprove 时必填（有理由的有意操作，绝非意外）。 */
  reason?: string | null;
  /** 仅 PLAN-LOCK——盖章者显式指定的 locked-artifact 集合（slice 相对路径）。存在时完全替换派生
   * 默认值：集合由人选择，而非继承。每条路径必须存在于 slice 目录。delivery/mission 审批忽略它。 */
  lockedArtifacts?: string[] | null;
}

export interface ScopeApproveResult {
  scopeTier: ScopeTier;
  scopeId: string;
  scopePath: string;
  approvalScope: ApprovalScope;
  approvedBy: string;
  approvedAt: string;
  onBehalfOf: string | null;
  actionId: string;
  /** Packet-2 interface cell：只有 DELIVERY stamp 触发 freeze；compose-and-freeze endpoint 在
   * Packet 2 发布，因此 P1 始终报告 false。无论 render 结果如何，stamp + audit 行都成立。 */
  freezeFired: false;
  /** OPR.0.5.0.18——结果是修订（重新盖章）时为 true。 */
  reApproved: boolean;
  /** 被取代的 attestation（仅重新盖章时存在）。 */
  priorApprovedBy?: string;
  priorApprovedAt?: string | null;
}

export class ScopeApproveError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ScopeApproveError";
  }
}

/** 锁定的 audit_notes_json 结构（spec-guard blocker 2）：稳定、可查询的 scope-target identity +
 * approval scope + delegation provenance。audit-browse 读取路径按这些 key 过滤——正是这组信息
 * 让 Packet 2 的单次查询 UNVERIFIED-stamp 交叉检查真正可行。 */
export interface ScopeApprovalAuditNotes extends Record<string, unknown> {
  kind: "scope-approval";
  scope_tier: ScopeTier;
  scope_id: string;
  scope_path: string;
  approval_scope: ApprovalScope;
  on_behalf_of: string | null;
}

const STAMP_FIELDS: Record<ApprovalScope, { by: string; at: string; priors: string }> = {
  delivery: { by: "approved-by", at: "approved-at", priors: "approved-priors" },
  spec: { by: "approved-spec-by", at: "approved-spec-at", priors: "approved-spec-priors" },
};

interface ScopeApproveDeps {
  /** 解析实时 missions 根目录（SliceIndexer.slicesRoot）；workspace 未配置时返回 null。 */
  missionsRoot: () => string | null;
  actionLog: MissionControlActionLog;
  now?: () => Date;
}

export class ScopeApproveService {
  private readonly deps: ScopeApproveDeps;

  constructor(deps: ScopeApproveDeps) {
    this.deps = deps;
  }

  approve(input: ScopeApproveInput): ScopeApproveResult {
    const missionsRoot = this.deps.missionsRoot();
    if (!missionsRoot) {
      throw new ScopeApproveError(
        "workspace_not_configured",
        "后台服务未配置 missions 根目录；scope approve 需要 workspace primitive。",
      );
    }

    // 路径包含性：scope path 必须解析到 missions 根目录内（content-surfaces 约束——禁止 ../ 逃逸）。
    const resolved = path.resolve(missionsRoot, input.scopePath);
    if (resolved !== missionsRoot && !resolved.startsWith(missionsRoot + path.sep)) {
      throw new ScopeApproveError(
        "scope_path_escape",
        `scopePath '${input.scopePath}' 解析到了 missions 根目录之外。`,
        { scopePath: input.scopePath },
      );
    }
    const readmePath = resolveNodeFile(resolved);
    if (!readmePath) {
      throw new ScopeApproveError(
        "scope_not_found",
        `missions 根目录下的 ${input.scopePath} 中没有 ${NODE_FILE_PRECEDENCE.join(" 或 ")}——它不是已声明的 ${input.scopeTier}。`,
        { scopePath: input.scopePath, scopeTier: input.scopeTier },
      );
    }

    const originalBytes = fs.readFileSync(readmePath, "utf8");
    const frontmatter = parseFrontmatter(originalBytes);

    const scopeId = typeof frontmatter["id"] === "string" && frontmatter["id"].trim().length > 0
      ? (frontmatter["id"] as string)
      : null;
    if (!scopeId) {
      throw new ScopeApproveError(
        "scope_id_missing",
        `${input.scopePath} 没有 frontmatter id（dot-ID）——audit target 契约要求稳定的 scope_id。`,
        { scopePath: input.scopePath, action: "请运行：rig scope " + input.scopeTier + " reconcile <path> 生成 id，然后重新审批。" },
      );
    }

    // OPR.0.5.0.18——修订/重新盖章动词（ARCH-SHAPING 9d64ceb6 v2）：lock 是时间点
    // ATTESTATION，而非不可逆 seal。无 --re-approve 时，已有 stamp 仍会显著拒绝，但拒绝信息会教授
    // 获准动词，而非形成死路。使用时，新有理由 attestation 取代旧 stamp；两者均保留在仅追加 audit
    // log 中。spec stamp 后接 delivery stamp 仍是常规分阶段顺序（不同 scope 绝不冲突）。
    const fields = STAMP_FIELDS[input.approvalScope];
    const existingBy = frontmatter[fields.by];
    const hasExistingStamp = typeof existingBy === "string" && existingBy.trim().length > 0;
    const isReApprove = input.reApprove === true;
    if (hasExistingStamp && !isReApprove) {
      throw new ScopeApproveError(
        "already_approved",
        `${input.scopePath} 已有 ${input.approvalScope} approval stamp：${fields.by}: ${existingBy}，${fields.at}: ${String(frontmatter[fields.at] ?? "?")}。若要以新的有理由 attestation 修订/重新盖章（先前记录保留在 audit log 中），请使用 --re-approve --reason "<why>" 重新运行。`,
        { scopePath: input.scopePath, approvalScope: input.approvalScope, existingBy, existingAt: frontmatter[fields.at] ?? null },
      );
    }
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (isReApprove && reason.length === 0) {
      throw new ScopeApproveError(
        "reason_required",
        `--re-approve 是有理由的有意操作：请传入 --reason "<why>"，说明自上一份 ${input.approvalScope} attestation 以来发生的变化。`,
        { scopePath: input.scopePath, approvalScope: input.approvalScope },
      );
    }
    if (isReApprove && !hasExistingStamp) {
      throw new ScopeApproveError(
        "nothing_to_reapprove",
        `${input.scopePath} 没有可取代的 ${input.approvalScope} approval stamp——第一次 attestation 请执行普通 approve（不带 --re-approve）。`,
        { scopePath: input.scopePath, approvalScope: input.approvalScope },
      );
    }
    const priorApprovedBy = hasExistingStamp ? (existingBy as string) : null;
    const priorApprovedAt = hasExistingStamp
      ? (typeof frontmatter[fields.at] === "string" ? (frontmatter[fields.at] as string) : null)
      : null;
    const priorCount = typeof frontmatter[fields.priors] === "number" ? (frontmatter[fields.priors] as number) : 0;

    const approvedAt = (this.deps.now?.() ?? new Date()).toISOString();

    // Stage-3 Lever A——plan-lock snapshot：只有 slice SPEC 审批才派生并共同序列化
    // `locked-artifacts` 集合（mission/delivery 绝不创建；delivery merge 保留现有列表）。PRD 读取
    // 失败时开放式回退为 null。
    //
    // B14——集合必须由人选择，而非继承。显式 `lockedArtifacts` 完全替代派生（校验为存在的 slice
    // 相对路径）。缺席时仍采用派生默认值，但若集合只会冻结缺失/脚手架 PRD，则显著拒绝：plan-lock
    // 表示“构建的就是这组 artifact”，而此检查出现前曾有两个 live lock 冻结 placeholder 字节。
    const isPlanLock = input.scopeTier === "slice" && input.approvalScope === "spec";
    let lockedArtifacts: ReturnType<typeof derivePlanLockArtifacts> | undefined;
    if (isPlanLock) {
      const explicit = Array.isArray(input.lockedArtifacts)
        ? input.lockedArtifacts.map((p) => String(p).trim()).filter((p) => p.length > 0)
        : [];
      if (explicit.length > 0) {
        lockedArtifacts = resolveExplicitPlanLockArtifacts(explicit, resolved, input.scopePath);
      } else {
        const prd = tryReadPRD(resolved);
        const nodeFileName = path.basename(readmePath) === "SPEC.md" ? "SPEC.md" : "README.md";
        lockedArtifacts = derivePlanLockArtifacts(originalBytes, prd, nodeFileName);
        if (isContentlessPlanLockSet(originalBytes, lockedArtifacts)) {
          throw new ScopeApproveError(
            "plan_lock_contentless",
            `${input.scopePath}：派生的 locked-artifacts 集合只包含无内容的 ${nodeFileName}——该 lock 会冻结无人选择的内容。`,
            {
              scopePath: input.scopePath,
              action: "请编写 SPEC.md，让计划包含真实内容；或显式指定真实集合：rig scope slice approve <slice> --scope spec --locked-artifacts \"SPEC.md,PLAN-….md\"。",
            },
          );
        }
      }
    }

    // 1. 先写 Frontmatter（架构锁定顺序）。stamp 与共同序列化的 `locked-artifacts` 通过一次
    // writeFrontmatterFields + writeFileSync 落盘，后续 audit 失败即可恢复干净且逐字一致的 README。
    const updated = writeFrontmatterFields(originalBytes, {
      [fields.by]: input.actorSession,
      [fields.at]: approvedAt,
      // OPR.0.5.0.18——一次原子 frontmatter 写入中的修订 lineage：prior-count 与当前
      // attestation 一并写入，使文件系统本地 scope audit 可显示 lineage；行中保留完整历史。
      ...(isReApprove ? { [fields.priors]: priorCount + 1 } : {}),
      ...(isPlanLock ? { "locked-artifacts": lockedArtifacts } : {}),
      // P21 era-stamp：approved-by stamp 旁的 `provenance:` 行记录 approver identity 的确定方式。
      // 存在（`transport:v1`）⇒ transport-derived；缺席 ⇒ claimed-era。
      ...(input.identityProvenance ? { provenance: input.identityProvenance } : {}),
    });
    fs.writeFileSync(readmePath, updated, "utf8");

    // 2. 后写 Audit。失败时按字节恢复先前 frontmatter 并显著失败；audit 写入失败绝不能留下被信任的
    // 半 stamp（QA plan-review guardrail），且绝不删除 audit 行。
    const scopePathCanonical = path.relative(missionsRoot, resolved).split(path.sep).join("/");
    const auditNotes: ScopeApprovalAuditNotes = {
      kind: "scope-approval",
      scope_tier: input.scopeTier,
      scope_id: scopeId,
      scope_path: scopePathCanonical,
      approval_scope: input.approvalScope,
      on_behalf_of: input.onBehalfOf ?? null,
      // OPR.0.5.0.18——修订行显式表达取代关系（增量 key；audit-browse scope filter 不变）。
      // provenance 三元组：authorizer = on_behalf_of、acting agent = actor_session、
      // reason = 操作员原样 reason。
      ...(isReApprove
        ? {
            re_approval: true,
            reason,
            prior_approved_by: priorApprovedBy,
            prior_approved_at: priorApprovedAt,
            prior_count: priorCount + 1,
          }
        : {}),
    };
    let actionId: string;
    try {
      const baseReason = input.onBehalfOf
        ? `scope-approval (${input.approvalScope}) on behalf of ${input.onBehalfOf}`
        : `scope-approval (${input.approvalScope})`;
      const entry = this.deps.actionLog.record({
        actionVerb: "approve",
        qitemId: null, // scope approval 不是 qitem action。
        actorSession: input.actorSession,
        actedAt: approvedAt,
        reason: isReApprove ? `${baseReason} re-approve: ${reason}` : baseReason,
        auditNotes,
        identityProvenance: input.identityProvenance ?? null,
      });
      actionId = entry.actionId;
    } catch (err) {
      fs.writeFileSync(readmePath, originalBytes, "utf8");
      throw new ScopeApproveError(
        "audit_write_failed",
        `无法写入 approval audit 行；frontmatter stamp 已恢复到先前状态（无半 stamp）。原因：${err instanceof Error ? err.message : String(err)}`,
        { scopePath: input.scopePath, approvalScope: input.approvalScope },
      );
    }

    // 3. Freeze-trigger interface cell（Packet 2）：DELIVERY stamp 会在此点之后同步调用唯一
    // compose-and-freeze endpoint。P1 中该 endpoint 尚不存在；实现后，render 失败也绝不会撤销
    // approval 或留下半 stamp——无论 render 结果如何，上述 stamp + audit 行均成立。

    return {
      scopeTier: input.scopeTier,
      scopeId,
      scopePath: scopePathCanonical,
      approvalScope: input.approvalScope,
      approvedBy: input.actorSession,
      approvedAt,
      onBehalfOf: input.onBehalfOf ?? null,
      actionId,
      freezeFired: false,
      reApproved: isReApprove,
      ...(isReApprove && priorApprovedBy !== null
        ? { priorApprovedBy, priorApprovedAt }
        : {}),
    };
  }
}

// ——frontmatter helper（CLI scope-fs 结构的后台服务侧镜像：手写 split + YAML.parse，
// 按 PRD §4 第 2 分支默认安全）——

function parseFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith("---")) return {};
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!match) return {};
  try {
    const parsed = YAML.parse(match[1]!) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 读取 slice IMPLEMENTATION-PRD.md；任何缺失/不可读错误都返回 null（绝不抛错），使 plan-lock
 * 派生开放式回退为仅 PRD 集合。 */
function tryReadPRD(sliceDir: string): string | null {
  try {
    return fs.readFileSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"), "utf8");
  } catch {
    return null;
  }
}

/** B14——盖章者显式指定的 plan-lock 集合：slice 相对路径，按与派生路径相同的规则规范化
 *（无 scheme/绝对路径/逃逸），并验证每个文件存在。选定集合若指向缺失文件，正是显式路径旨在
 * 消除的同类缺陷。去重时首项优先。 */
function resolveExplicitPlanLockArtifacts(
  raw: string[],
  sliceDir: string,
  scopePath: string,
): ReturnType<typeof derivePlanLockArtifacts> {
  const out: ReturnType<typeof derivePlanLockArtifacts> = [];
  const seen = new Set<string>();
  for (const ref of raw) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) {
      throw new ScopeApproveError(
        "locked_artifact_invalid",
        `${scopePath}：locked artifact "${ref}" 带 URI scheme——每个 locked-artifact 路径都必须相对于 slice。`,
        { scopePath, ref },
      );
    }
    const norm = sliceRelativeMediaPath(ref, "");
    if (norm === null) {
      throw new ScopeApproveError(
        "locked_artifact_invalid",
        `${scopePath}：locked artifact "${ref}" 是绝对路径或逃逸出 slice 目录——每个 locked-artifact 路径都必须相对于 slice。`,
        { scopePath, ref },
      );
    }
    if (!fs.existsSync(path.join(sliceDir, norm))) {
      throw new ScopeApproveError(
        "locked_artifact_missing",
        `${scopePath}：locked artifact "${norm}" 在 slice 目录中不存在——选定集合必须指向真实文件。`,
        { scopePath, ref: norm },
      );
    }
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push({ name: norm, path: norm, kind: "spec" });
  }
  return out;
}

/** P15（WRITER-EXCEEDS-ITS-OWNERSHIP 修复，PM 于 2026-08-07 裁定）：stamp 是自身 key
 * 的唯一 writer，必须按字节保留不归其所有的每一行。旧实现解析并重新序列化整个 block，导致盖章
 * 使文件上的任何 seal 失效——seal-then-lock 按构造损坏。现在每个自有 key 单独序列化，并按索引
 * 拼接（key 存在时就地替换，缺席时追加到 block 末尾）。非自有字节——折叠 scalar、引号风格、
 * 顺序——保持不变，因此精确移除自有行即可恢复 stamp 前字节。按索引拼接（绝不使用带动态替换的
 * String.replace）使值中的 $ 元字符保持惰性。 */
function writeFrontmatterFields(content: string, fields: Record<string, unknown>): string {
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!match) {
    const yaml = YAML.stringify(fields).trimEnd();
    return `---\n${yaml}\n---\n\n${content}`;
  }
  let block = match[1]!;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const rendered = YAML.stringify({ [key]: value }).trimEnd();
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 顶层 `key:` 行及其缩进 continuation 行（嵌套 block）。
    const keyRe = new RegExp(`^${escaped}:[^\\n]*(?:\\n[ \\t]+[^\\n]*)*`, "m");
    const existing = keyRe.exec(block);
    if (existing) {
      block = block.slice(0, existing.index) + rendered + block.slice(existing.index + existing[0].length);
    } else {
      block = block.length > 0 ? `${block}\n${rendered}` : rendered;
    }
  }
  return content.slice(0, match.index) + `---\n${block}\n---` + content.slice(match.index + match[0].length);
}
