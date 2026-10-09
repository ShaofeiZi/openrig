import type { PackageRepository } from "./package-repository.js";
import type { InstallRepository } from "./install-repository.js";
import type { InstallEngine, InstallResult } from "./install-engine.js";
import type { InstallVerifier } from "./install-verifier.js";
import type { ResolvedPackage, FsOps } from "./package-resolver.js";
import { InstallPlanner } from "./install-planner.js";
import { detectConflicts } from "./conflict-detector.js";
import { applyPolicy } from "./install-policy.js";

export type PackageInstallOutcome =
  | { ok: true; installId: string; packageId: string; applied: number; deferred: number }
  | { ok: false; code: "conflict_blocked"; message: string }
  | { ok: false; code: "policy_rejected"; message: string }
  | { ok: false; code: "manifest_hash_mismatch"; message: string }
  | { ok: false; code: "apply_error"; message: string }
  | { ok: false; code: "verification_failed"; message: string };

interface PackageInstallOpts {
  resolved: ResolvedPackage;
  targetRoot: string;
  runtime: "claude-code" | "codex";
  roleName?: string;
  allowMerge?: boolean;
  bootstrapId?: string;
  fsOps: FsOps;
}

interface PackageInstallServiceDeps {
  packageRepo: PackageRepository;
  installRepo: InstallRepository;
  installEngine: InstallEngine;
  installVerifier: InstallVerifier;
}

/**
 * 可复用 package 安装 pipeline。组合 resolve -> plan -> detect -> policy -> dedup -> apply -> verify。
 * packages 路由与 bootstrap orchestrator 共同使用。
 */
export class PackageInstallService {
  readonly db: import("better-sqlite3").Database;
  private packageRepo: PackageRepository;
  private installEngine: InstallEngine;
  private installVerifier: InstallVerifier;

  constructor(deps: PackageInstallServiceDeps) {
    this.db = deps.packageRepo.db;
    if (deps.installRepo.db !== this.db) throw new Error("PackageInstallService：installRepo 必须共享同一个数据库句柄");
    this.packageRepo = deps.packageRepo;
    this.installEngine = deps.installEngine;
    this.installVerifier = deps.installVerifier;
  }

  /**
   * 为单个已解析 package 运行完整安装 pipeline。
   */
  install(opts: PackageInstallOpts): PackageInstallOutcome {
    const { resolved, targetRoot, runtime, roleName, allowMerge, bootstrapId, fsOps } = opts;

    // 规划并检测冲突。
    let plan, refined;
    try {
      const planner = new InstallPlanner(fsOps);
      plan = planner.plan(resolved, targetRoot, runtime, { roleName });
      refined = detectConflicts(plan, fsOps);
    } catch (err) {
      return { ok: false, code: "apply_error", message: (err as Error).message };
    }

    // 检查内容级冲突。
    if (refined.conflicts.length > 0) {
      return { ok: false, code: "conflict_blocked", message: `${refined.conflicts.length} 个未解决冲突` };
    }

    // 应用 policy。
    const policyResult = applyPolicy(refined, { allowMerge: allowMerge ?? false });

    if (policyResult.approved.length === 0) {
      return { ok: false, code: "policy_rejected", message: "policy 未批准任何条目" };
    }

    // 对 package record 去重。
    const existing = this.packageRepo.findByNameVersion(resolved.manifest.name, resolved.manifest.version);
    if (existing && existing.manifestHash !== resolved.manifestHash) {
      return { ok: false, code: "manifest_hash_mismatch", message: "Package 已注册，但内容不同" };
    }
    const pkg = existing ?? this.packageRepo.createPackage({
      name: resolved.manifest.name,
      version: resolved.manifest.version,
      sourceKind: resolved.sourceKind,
      sourceRef: resolved.sourceRef,
      manifestHash: resolved.manifestHash,
      summary: resolved.manifest.summary,
    });

    // 应用。
    let result: InstallResult;
    try {
      result = this.installEngine.apply(policyResult, refined, pkg.id, targetRoot, bootstrapId);
    } catch (err) {
      return { ok: false, code: "apply_error", message: (err as Error).message };
    }

    // 验证。
    const verification = this.installVerifier.verify(result.installId);
    if (!verification.passed) {
      return { ok: false, code: "verification_failed", message: "应用后验证失败" };
    }

    return {
      ok: true,
      installId: result.installId,
      packageId: pkg.id,
      applied: result.applied.length,
      deferred: result.deferred.length,
    };
  }
}
