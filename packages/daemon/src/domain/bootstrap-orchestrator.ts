import nodePath from "node:path";
import type Database from "better-sqlite3";
import type { LegacyRigSpec as RigSpec } from "./types.js"; // TODO: AS-T08b — 迁移到支持 pod 的 RigSpec
import { LegacyRigSpecCodec as RigSpecCodec } from "./rigspec-codec.js"; // TODO: AS-T08b — 迁移到支持 pod 的 RigSpec
import { LegacyRigSpecSchema as RigSpecSchema } from "./rigspec-schema.js"; // TODO: AS-T08b — 迁移到支持 pod 的 RigSpec
import type { BootstrapRepository } from "./bootstrap-repository.js";
import type { RuntimeVerifier } from "./runtime-verifier.js";
import type { RequirementsProbeRegistry, RequirementSpec } from "./requirements-probe.js";
import type { ExternalInstallPlanner, ExternalInstallAction } from "./external-install-planner.js";
import type { ExternalInstallExecutor, TaggedAction } from "./external-install-executor.js";
import type { PackageInstallService } from "./package-install-service.js";
import type { RigInstantiator } from "./rigspec-instantiator.js";
import type { FsOps, ResolvedPackage } from "./package-resolver.js";
import { resolvePackage, type ResolveResult } from "./package-resolve-helper.js";
import type { BootstrapStatus } from "./bootstrap-types.js";
// TODO: AS-T12 — 迁移到支持 pod 的 bundle 源解析器
import type { LegacyBundleSourceResolver as BundleSourceResolver, BundleResolvedSource } from "./bundle-source-resolver.js";
import type { PodBundleSourceResolver } from "./bundle-source-resolver.js";
import { unpack } from "./bundle-archive.js";
import { parsePodBundleManifest } from "./bundle-types.js";
import os from "node:os";
import fs from "node:fs";
import { getOpenRigInstallCwdError, resolveLaunchCwd } from "./cwd-resolution.js";
import { runSyncSite } from "./sync-site-wrap.js";

/** 引导模式 */
export type BootstrapMode = "plan" | "apply";

/** 引导选项 */
export interface BootstrapOptions {
  mode: BootstrapMode;
  sourceRef: string;
  sourceKind?: string;
  cwdOverride?: string;
  autoApprove?: boolean;
  approvedActionKeys?: string[];
  /** 预创建的运行 ID（路由为实时 started 事件创建运行记录） */
  runId?: string;
  /** 覆盖安装目标根目录（应用 bundle 安装时必需） */
  targetRoot?: string;
}

/** 阶段结果 */
export interface BootstrapStageResult {
  stage: string;
  status: "ok" | "blocked" | "skipped" | "failed";
  detail: unknown;
}

/** 完整的引导结果 */
export interface BootstrapResult {
  runId: string;
  status: BootstrapStatus;
  stages: BootstrapStageResult[];
  rigId?: string;
  errors: string[];
  warnings: string[];
  /** 计划模式下供审核批准的操作键 */
  actionKeys?: string[];
}

import type { PodRigInstantiator } from "./rigspec-instantiator.js";

interface BootstrapOrchestratorDeps {
  db: Database.Database;
  bootstrapRepo: BootstrapRepository;
  runtimeVerifier: RuntimeVerifier;
  probeRegistry: RequirementsProbeRegistry;
  installPlanner: ExternalInstallPlanner;
  installExecutor: ExternalInstallExecutor;
  packageInstallService: PackageInstallService;
  rigInstantiator: RigInstantiator;
  fsOps: FsOps;
  bundleSourceResolver: BundleSourceResolver | null;
  podInstantiator?: PodRigInstantiator;
  podBundleSourceResolver?: PodBundleSourceResolver;
  serviceOrchestrator?: import("./service-orchestrator.js").ServiceOrchestrator;
  rigRepo?: import("./rig-repository.js").RigRepository;
}

/** 生成确定性的操作键，用于保持 plan->apply 身份一致 */
function actionKey(actionKind: string, subjectType: string | null, subjectName: string): string {
  return `${actionKind}:${subjectType ?? ""}:${subjectName}`;
}

/**
 * 顶层引导工作流。将所有第 5 阶段服务组合成分阶段流水线。
 * 每个阶段各自具有事务性，而非全局原子操作。
 */
export class BootstrapOrchestrator {
  private deps: BootstrapOrchestratorDeps;
  private activeLocks = new Set<string>();

  /** 尝试获取 sourceRef 的锁。若已锁定，则返回 false。 */
  tryAcquire(sourceRef: string): boolean {
    const key = nodePath.resolve(sourceRef);
    if (this.activeLocks.has(key)) return false;
    this.activeLocks.add(key);
    return true;
  }

  /** 释放 sourceRef 的锁。 */
  release(sourceRef: string): void {
    this.activeLocks.delete(nodePath.resolve(sourceRef));
  }

  constructor(deps: BootstrapOrchestratorDeps) {
    // 检查是否使用同一个数据库句柄
    if (deps.bootstrapRepo.db !== deps.db) throw new Error("BootstrapOrchestrator：bootstrapRepo 必须共享同一个数据库句柄");
    if (deps.runtimeVerifier.db !== deps.db) throw new Error("BootstrapOrchestrator：runtimeVerifier 必须共享同一个数据库句柄");
    if (deps.installExecutor.db !== deps.db) throw new Error("BootstrapOrchestrator：installExecutor 必须共享同一个数据库句柄");
    if (deps.packageInstallService.db !== deps.db) throw new Error("BootstrapOrchestrator：packageInstallService 必须共享同一个数据库句柄");
    this.deps = deps;
  }

  async bootstrap(opts: BootstrapOptions): Promise<BootstrapResult> {
    const { mode, sourceRef, autoApprove, approvedActionKeys } = opts;
    const sourceKind = opts.sourceKind ?? "rig_spec";
    const stages: BootstrapStageResult[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];

    // 使用预创建的运行记录，或新建一条记录
    const run = opts.runId
      ? this.deps.bootstrapRepo.getRun(opts.runId)!
      : this.deps.bootstrapRepo.createRun(sourceKind, sourceRef);
    let seqCounter = 1;

    // --- 阶段 1：RESOLVE_SPEC ---
    let spec: RigSpec;
    let specDir: string;
    let bundleSource: BundleResolvedSource | null = null;
    let bundleTempDir: string | null = null;

    if (sourceKind === "rig_bundle") {
      // 预览 bundle 清单以检测 schema 版本
      let bundleSchemaVersion = 1;
      const peekDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "bundle-peek-"));
      try {
        await unpack(sourceRef, peekDir);
        const manifestPath = nodePath.join(peekDir, "bundle.yaml");
        if (fs.existsSync(manifestPath)) {
          const manifestYaml = fs.readFileSync(manifestPath, "utf-8");
          const raw = parsePodBundleManifest(manifestYaml) as Record<string, unknown>;
          if (raw && raw["schema_version"] === 2) {
            bundleSchemaVersion = 2;
          }
        }
      } catch { /* 预览失败——回退到旧版流程 */ }
      finally { try { fs.rmSync(peekDir, { recursive: true, force: true }); } catch {} }

      if (bundleSchemaVersion === 2 && this.deps.podBundleSourceResolver) {
        let podBundleTempDir: string | null = null;
        try {
          const podSource = await this.deps.podBundleSourceResolver.resolve(sourceRef);
          const rawYaml = this.deps.fsOps.readFile(podSource.specPath);
          specDir = nodePath.dirname(podSource.specPath);
          podBundleTempDir = podSource.tempDir;
          stages.push({ stage: "resolve_spec", status: "ok", detail: { specName: podSource.manifest.name, source: "pod_bundle" } });

          try {
            // 拒绝由服务支持的 bundle——服务需要稳定的源目录
            try {
              const parsed = parsePodBundleManifest(rawYaml) as Record<string, unknown>;
              if (parsed && typeof parsed === "object" && parsed["services"] && typeof parsed["services"] === "object") {
                const msg = "无法从 .rigbundle 归档启动由服务支持的 rig。services 块需要稳定的源目录。请改用源目录路径：zrig up <path/to/rig.yaml>";
                stages.push({ stage: "resolve_spec", status: "failed", detail: { code: "services_unsupported", error: msg } });
                errors.push(msg);
                this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
                return { runId: run.id, status: "failed" as BootstrapStatus, stages, errors, warnings };
              }
            } catch { /* YAML 解析失败——交由 handlePodAwareSpec 处理 */ }

            return await this.handlePodAwareSpec(opts, run, rawYaml, specDir, stages, errors, warnings);
          } finally {
            if (podBundleTempDir) this.deps.podBundleSourceResolver.cleanup(podBundleTempDir);
          }
        } catch (err) {
          const msg = (err as Error).message;
          stages.push({ stage: "resolve_spec", status: "failed", detail: { code: "bundle_error", error: msg } });
          errors.push(msg);
          this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
          return { runId: run.id, status: "failed", stages, errors, warnings };
        }
      }

      // 旧版 v1 bundle 路径
      if (!this.deps.bundleSourceResolver) {
        throw new Error("rig_bundle 源类型需要 BundleSourceResolver");
      }
      try {
        bundleSource = await this.deps.bundleSourceResolver.resolve(sourceRef);
        bundleTempDir = bundleSource.tempDir;
        specDir = nodePath.dirname(bundleSource.specPath);
        const rawYaml = this.deps.fsOps.readFile(bundleSource.specPath);
        const raw = RigSpecCodec.parse(rawYaml);
        const validation = RigSpecSchema.validate(raw);
        if (!validation.valid) {
          stages.push({ stage: "resolve_spec", status: "failed", detail: { code: "validation_failed", errors: validation.errors } });
          this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
          return { runId: run.id, status: "failed", stages, errors: validation.errors, warnings };
        }
        spec = this.resolveLegacyNodeCwds(RigSpecSchema.normalize(raw), specDir, opts.cwdOverride);
        stages.push({ stage: "resolve_spec", status: "ok", detail: { specName: spec.name, specVersion: spec.schemaVersion, source: "rig_bundle" } });
      } catch (err) {
        const msg = (err as Error).message;
        stages.push({ stage: "resolve_spec", status: "failed", detail: { code: "bundle_error", error: msg } });
        errors.push(msg);
        this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
        return { runId: run.id, status: "failed", stages, errors, warnings };
      }
    } else {
      // 直接使用 rig_spec 路径——在旧版校验之前检测格式
      try {
        specDir = nodePath.dirname(nodePath.resolve(sourceRef));
        const rawYaml = this.deps.fsOps.readFile(nodePath.resolve(sourceRef));
        const raw = RigSpecCodec.parse(rawYaml) as Record<string, unknown> | null;

        // 检测支持 pod 的格式：若含有 pods[]，则委托给 PodRigInstantiator
        if (raw && Array.isArray(raw["pods"]) && this.deps.podInstantiator) {
          return this.handlePodAwareSpec(opts, run, rawYaml, specDir, stages, errors, warnings);
        }

        // 旧版路径：按扁平节点规范校验
        const validation = RigSpecSchema.validate(raw);
        if (!validation.valid) {
          stages.push({ stage: "resolve_spec", status: "failed", detail: { code: "validation_failed", errors: validation.errors } });
          this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
          return { runId: run.id, status: "failed", stages, errors: validation.errors, warnings };
        }
        spec = this.resolveLegacyNodeCwds(RigSpecSchema.normalize(raw), specDir, opts.cwdOverride);
        const cwdError = spec.nodes
          .map((node) => getOpenRigInstallCwdError(node.cwd ?? specDir, opts.cwdOverride))
          .find((error): error is string => Boolean(error));
        if (cwdError) {
          stages.push({ stage: "resolve_spec", status: "failed", detail: { code: "invalid_cwd", error: cwdError } });
          this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
          return { runId: run.id, status: "failed", stages, errors: [cwdError], warnings };
        }
        stages.push({ stage: "resolve_spec", status: "ok", detail: { specName: spec.name, specVersion: spec.schemaVersion } });
      } catch (err) {
        const msg = (err as Error).message;
        const code = (err as NodeJS.ErrnoException).code === "ENOENT" ? "file_not_found"
          : msg.includes("YAML") || msg.includes("parse") ? "parse_error"
          : "read_error";
        stages.push({ stage: "resolve_spec", status: "failed", detail: { code, error: msg } });
        errors.push(msg);
        this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
        return { runId: run.id, status: "failed", stages, errors, warnings };
      }
    }

    // 用 try/finally 包裹剩余阶段，以清理 bundle 临时目录（旧版路径）
    try { return await this.executeStages(opts, run, spec, specDir, bundleSource, stages, errors, warnings, seqCounter); }
    finally { if (bundleTempDir && this.deps.bundleSourceResolver) this.deps.bundleSourceResolver.cleanup(bundleTempDir); }
  }

  private async executeStages(
    opts: BootstrapOptions,
    run: { id: string },
    spec: RigSpec,
    specDir: string,
    bundleSource: BundleResolvedSource | null,
    stages: BootstrapStageResult[],
    errors: string[],
    warnings: string[],
    seqCounter: number,
  ): Promise<BootstrapResult> {
    const { mode, autoApprove, approvedActionKeys } = opts;

    // --- 阶段 2：RESOLVE_PACKAGES ---
    const packageRefs = new Set<string>();
    for (const node of spec.nodes) {
      if (node.packageRefs) {
        for (const ref of node.packageRefs) {
          packageRefs.add(ref);
        }
      }
    }

    const resolvedPackages: Map<string, ResolveResult & { ok: true }> = new Map();
    const unresolvedRefs: string[] = [];

    for (const ref of packageRefs) {
      // Bundle 路径：在 packageRefMap 中查找
      if (bundleSource) {
        const bundleResolved = bundleSource.packageRefMap[ref];
        if (bundleResolved) {
          resolvedPackages.set(ref, { ok: true, resolved: bundleResolved });
          continue;
        }
        // bundle 映射中没有该引用——尝试回退到本地解析
      }

      // 检查不支持的 scheme
      if (ref.includes("github:") || ref.includes("://")) {
        errors.push(`不支持的软件包引用 scheme：'${ref}'`);
        unresolvedRefs.push(ref);
        continue;
      }

      // 若存在 local: 前缀，则将其移除
      const cleanRef = ref.startsWith("local:") ? ref.slice(6) : ref;
      const result = resolvePackage(cleanRef, specDir, this.deps.fsOps);
      if (result.ok) {
        resolvedPackages.set(ref, result);
      } else {
        const errMsg = result.kind === "validation" ? result.errors.join("; ") : result.error;
        errors.push(`解析软件包 '${ref}' 失败：${errMsg}`);
        unresolvedRefs.push(ref);
      }
    }

    if (unresolvedRefs.length > 0) {
      stages.push({ stage: "resolve_packages", status: "blocked", detail: { unresolved: unresolvedRefs, errors } });
      this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
      return { runId: run.id, status: "failed", stages, errors, warnings };
    }
    stages.push({ stage: "resolve_packages", status: "ok", detail: { resolved: [...resolvedPackages.keys()] } });

    // --- 阶段 3：VERIFY_RUNTIMES ---
    const runtimes = new Set<string>(["tmux"]);
    for (const node of spec.nodes) {
      if (node.runtime) runtimes.add(node.runtime);
    }

    const verifications = await this.deps.runtimeVerifier.verifyAll([...runtimes]);
    const runtimeBlocked: string[] = [];

    for (const v of verifications) {
      if (mode === "apply") {
        this.deps.bootstrapRepo.journalAction(run.id, seqCounter++, "runtime_check", null, v.runtime, v.status === "verified" || v.status === "degraded" ? "completed" : "failed", {
          detailJson: JSON.stringify({ version: v.version, status: v.status, error: v.error }),
        });
      }

      if (v.status === "not_found" || v.status === "error") {
        runtimeBlocked.push(v.runtime);
      }
      if (v.status === "degraded") {
        warnings.push(`${v.runtime} 已降级，但不会阻塞流程`);
      }
    }

    if (runtimeBlocked.length > 0 && mode === "apply") {
      stages.push({ stage: "verify_runtimes", status: "blocked", detail: { blocked: runtimeBlocked } });
      errors.push(`未找到必需的运行时：${runtimeBlocked.join(", ")}`);
      this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
      return { runId: run.id, status: "failed", stages, errors, warnings };
    }
    stages.push({
      stage: "verify_runtimes",
      status: runtimeBlocked.length > 0 ? "blocked" : "ok",
      detail: { verifications: verifications.map((v) => ({ runtime: v.runtime, status: v.status })) },
    });

    // --- 阶段 4：PROBE_REQUIREMENTS ---
    const requirementMap = new Map<string, RequirementSpec>();
    for (const [, resolved] of resolvedPackages) {
      const manifest = resolved.resolved.manifest;
      if (manifest.requirements?.cliTools) {
        for (const tool of manifest.requirements.cliTools) {
          const key = `cli_tool:${tool.name}`;
          if (!requirementMap.has(key)) {
            requirementMap.set(key, { name: tool.name, kind: "cli_tool", installHints: tool.installHints });
          }
        }
      }
      if (manifest.requirements?.systemPackages) {
        for (const pkg of manifest.requirements.systemPackages) {
          const key = `system_package:${pkg.name}`;
          if (!requirementMap.has(key)) {
            requirementMap.set(key, { name: pkg.name, kind: "system_package" });
          }
        }
      }
    }

    const uniqueRequirements = [...requirementMap.values()];
    const probeResults = await this.deps.probeRegistry.probeAll(uniqueRequirements);

    for (const probe of probeResults) {
      if (mode === "apply") {
        this.deps.bootstrapRepo.journalAction(run.id, seqCounter++, "requirement_check", probe.kind, probe.name, "completed", {
          detailJson: JSON.stringify({ status: probe.status, detectedPath: probe.detectedPath, version: probe.version }),
        });
      }
    }

    stages.push({
      stage: "probe_requirements",
      status: "ok",
      detail: {
        probed: probeResults.length,
        results: probeResults.map((p) => ({
          name: p.name,
          kind: p.kind,
          status: p.status,
          version: p.version,
          detectedPath: p.detectedPath,
        })),
      },
    });

    // --- 阶段 5：BUILD_INSTALL_PLAN ---
    const installPlan = this.deps.installPlanner.planInstalls(probeResults);

    // 检查 manual_only 是否造成阻塞
    const hasManualOnly = installPlan.manualOnly.length > 0;

    // 为计划输出构建操作键
    const allActionKeys: string[] = installPlan.actions.map((a) =>
      actionKey("external_install", a.kind, a.requirementName)
    );

    stages.push({
      stage: "build_install_plan",
      status: hasManualOnly ? "blocked" : "ok",
      detail: {
        autoApprovable: installPlan.autoApprovable.length,
        manualOnly: installPlan.manualOnly.length,
        alreadyInstalled: installPlan.alreadyInstalled.length,
        actions: installPlan.actions.map((a) => ({
          key: actionKey("external_install", a.kind, a.requirementName),
          requirementName: a.requirementName,
          classification: a.classification,
          commandPreview: a.commandPreview,
          provider: a.provider,
        })),
      },
    });

    // *** 计划模式到此为止 ***
    if (mode === "plan") {
      return { runId: run.id, status: "planned", stages, errors, warnings, actionKeys: allActionKeys };
    }

    // --- 应用模式：检查 manual_only 阻塞项 ---
    if (hasManualOnly) {
      errors.push(`${installPlan.manualOnly.length} 个仅允许手动处理的依赖无法自动安装：${installPlan.manualOnly.map((a) => a.requirementName).join(", ")}`);
      this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
      return { runId: run.id, status: "failed", stages, errors, warnings };
    }

    // --- 阶段 6：EXECUTE_EXTERNAL_INSTALLS ---
    const taggedActions: TaggedAction[] = installPlan.actions.map((a) => {
      const key = actionKey("external_install", a.kind, a.requirementName);
      let approved = false;
      if (autoApprove && a.classification === "auto_approvable") {
        approved = true;
      } else if (approvedActionKeys?.includes(key)) {
        approved = true;
      }
      return { action: a, approved };
    });

    // 对未知的已批准操作键发出警告
    if (approvedActionKeys) {
      const validKeys = new Set(taggedActions.map((t) => actionKey("external_install", t.action.kind, t.action.requirementName)));
      for (const key of approvedActionKeys) {
        if (!validKeys.has(key)) {
          warnings.push(`已忽略未知的已批准操作键：'${key}'`);
        }
      }
    }

    // 若存在外部安装操作但均未获批准，则阻塞流程
    const anyApproved = taggedActions.some((t) => t.approved);
    const hasActionableInstalls = taggedActions.some((t) => t.action.classification !== "manual_only" && t.action.commandPreview);
    if (hasActionableInstalls && !anyApproved) {
      errors.push("外部安装需要批准。对可自动批准的操作使用 --yes，或提供 approvedActionKeys。");
      stages.push({ stage: "execute_external_installs", status: "blocked", detail: { reason: "未提供批准信息" } });
      this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
      return { runId: run.id, status: "failed", stages, errors, warnings };
    }

    const execSummary = await this.deps.installExecutor.execute(run.id, taggedActions, seqCounter);
    seqCounter += taggedActions.length;

    const hasExecFailures = execSummary.failed.length > 0;
    stages.push({
      stage: "execute_external_installs",
      status: hasExecFailures ? "failed" : "ok",
      detail: { completed: execSummary.completed.length, failed: execSummary.failed.length, skipped: execSummary.skipped.length },
    });

    // --- 阶段 7：INSTALL_PACKAGES ---
    let packageInstallFailed = false;
    for (const [ref, resolved] of resolvedPackages) {
      const runtimesForRef = new Set<string>();
      for (const node of spec.nodes) {
        if (node.packageRefs?.includes(ref) && node.runtime) {
          runtimesForRef.add(node.runtime);
        }
      }
      // 针对引用此软件包的每个运行时各安装一次
      const runtimes = runtimesForRef.size > 0 ? [...runtimesForRef] : ["claude-code"];
      for (const rt of runtimes) {
        const runtime = rt as "claude-code" | "codex";
        const outcome = this.deps.packageInstallService.install({
          resolved: resolved.resolved,
          targetRoot: opts.targetRoot ?? specDir,
          runtime,
          allowMerge: true,
          bootstrapId: run.id,
          fsOps: this.deps.fsOps,
        });

        this.deps.bootstrapRepo.journalAction(run.id, seqCounter++, "package_install", runtime, resolved.resolved.manifest.name, outcome.ok ? "completed" : "failed", {
          detailJson: JSON.stringify(outcome),
        });

        if (!outcome.ok) {
          errors.push(`为 '${ref}' (${runtime}) 安装软件包失败：${outcome.message}`);
          packageInstallFailed = true;
        }
      }
    }

    stages.push({
      stage: "install_packages",
      status: packageInstallFailed ? "failed" : "ok",
      detail: { installed: resolvedPackages.size },
    });

    // --- 阶段 8：IMPORT_RIG ---
    // 若软件包安装失败，则跳过 rig 导入——缺少软件包的 rig 无法正常工作
    if (packageInstallFailed) {
      errors.push("因软件包安装失败，已跳过 rig 导入");
      stages.push({ stage: "import_rig", status: "skipped", detail: { reason: "软件包安装失败" } });
      this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
      return { runId: run.id, status: "failed", stages, errors, warnings };
    }

    const instantiateOutcome = await this.deps.rigInstantiator.instantiate(spec);

    this.deps.bootstrapRepo.journalAction(run.id, seqCounter++, "rig_import", null, spec.name, instantiateOutcome.ok ? "completed" : "failed", {
      detailJson: JSON.stringify(instantiateOutcome),
    });

    if (!instantiateOutcome.ok) {
      errors.push(`Rig 导入失败：${instantiateOutcome.code}`);
      stages.push({ stage: "import_rig", status: "failed", detail: instantiateOutcome });
      const finalStatus: BootstrapStatus = hasExecFailures || packageInstallFailed ? "partial" : "failed";
      this.deps.bootstrapRepo.updateRunStatus(run.id, finalStatus);
      return { runId: run.id, status: finalStatus, stages, errors, warnings };
    }

    stages.push({ stage: "import_rig", status: "ok", detail: instantiateOutcome.result });
    if (instantiateOutcome.result.warnings?.length) {
      warnings.push(...instantiateOutcome.result.warnings);
    }

    // --- 完成 ---
    const finalStatus: BootstrapStatus = hasExecFailures || packageInstallFailed ? "partial" : "completed";
    this.deps.bootstrapRepo.updateRunStatus(run.id, finalStatus, { rigId: instantiateOutcome.result.rigId });

    return {
      runId: run.id,
      status: finalStatus,
      stages,
      rigId: instantiateOutcome.result.rigId,
      errors,
      warnings,
    };
  }

  // -- 支持 pod 的引导路径 --

  private async handlePodAwareSpec(
    opts: BootstrapOptions,
    run: { id: string },
    rigSpecYaml: string,
    specDir: string,
    stages: BootstrapStageResult[],
    errors: string[],
    warnings: string[],
  ): Promise<BootstrapResult> {
    const { mode } = opts;
    const podInstantiator = this.deps.podInstantiator!;
    const rigRoot = specDir;

    if (mode === "plan") {
      // 计划模式：仅执行校验和预检
      const { rigPreflight } = await import("./rigspec-preflight.js");
      const { RigSpecCodec: PodCodec } = await import("./rigspec-codec.js");
      const { RigSpecSchema: PodSchema } = await import("./rigspec-schema.js");

      try {
        const raw = PodCodec.parse(rigSpecYaml);
        const validation = PodSchema.validate(raw);
        if (!validation.valid) {
          stages.push({ stage: "resolve_spec", status: "failed", detail: { code: "validation_failed", errors: validation.errors } });
          this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
          return { runId: run.id, status: "failed", stages, errors: validation.errors, warnings };
        }
        const spec = PodSchema.normalize(raw as Record<string, unknown>);
        stages.push({ stage: "resolve_spec", status: "ok", detail: { specName: spec.name, specVersion: spec.version } });

        const { execSync } = await import("node:child_process");
        const execFn = async (cmd: string) => runSyncSite("bootstrap.plan.preflight", () =>
          execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 })
        );
        const preflight = await rigPreflight({
          rigSpecYaml,
          rigRoot,
          cwdOverride: opts.cwdOverride,
          fsOps: podInstantiator["deps"].fsOps,
          skillsRoot: podInstantiator.resolveSkillsRoot?.(),
          exec: execFn,
        });

        stages.push({
          stage: "preflight",
          status: preflight.ready ? "ok" : "blocked",
          detail: { errors: preflight.errors, warnings: preflight.warnings },
        });

        this.deps.bootstrapRepo.updateRunStatus(run.id, preflight.ready ? "planned" : "failed");
        return {
          runId: run.id,
          status: preflight.ready ? "planned" : "failed",
          stages,
          errors: preflight.errors,
          warnings: preflight.warnings,
        };
      } catch (err) {
        stages.push({ stage: "resolve_spec", status: "failed", detail: { error: (err as Error).message } });
        this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
        return { runId: run.id, status: "failed", stages, errors: [(err as Error).message], warnings };
      }
    }

    // 应用模式：通过 PodRigInstantiator 完整实例化
    // 若存在服务，则预启动钩子会在创建拓扑与启动节点之间引导这些服务
    const prelaunchHook = await this.buildServicePrelaunchHook(rigSpecYaml, rigRoot, stages, errors);
    const outcome = await podInstantiator.instantiate(rigSpecYaml, rigRoot, { cwdOverride: opts.cwdOverride, prelaunchHook });

    if (!outcome.ok) {
      // OPR.0.3.2.CT — attention_required 是可恢复的结果
      //（rig 和会话均会保留）。需要将它与终止性故障明确区分，
      // 以便路由返回三段式错误，引导操作者走 approve→resume 路径。
      // 引导运行状态为 `partial`（而非 `failed`），因为 rig 仍然存在，
      // 且操作者可以对其采取操作。
      if (outcome.code === "attention_required") {
        const attentionMsg = (outcome as { message: string }).message;
        const attentionNodes = (outcome as { attentionNodes: import("./types.js").AttentionNode[] }).attentionNodes;
        stages.push({
          stage: "import_rig",
          status: "blocked",
          detail: {
            code: "attention_required",
            message: attentionMsg,
            attentionNodes,
          },
        });
        this.deps.bootstrapRepo.updateRunStatus(run.id, "partial", { rigId: (outcome as { rigId: string }).rigId });
        return {
          runId: run.id,
          status: "partial",
          stages,
          rigId: (outcome as { rigId: string }).rigId,
          errors: [attentionMsg],
          warnings,
        };
      }
      const outErrors = outcome.code === "validation_failed" || outcome.code === "preflight_failed"
        ? (outcome as { errors: string[] }).errors
        : [(outcome as { message: string }).message];
      const outWarnings = (outcome as { warnings?: string[] }).warnings ?? [];
      stages.push({ stage: "import_rig", status: "failed", detail: { code: outcome.code } });
      this.deps.bootstrapRepo.updateRunStatus(run.id, "failed");
      return { runId: run.id, status: "failed", stages, errors: outErrors, warnings: outWarnings };
    }

    const result = outcome.result;
    const anyFailed = result.nodes.some((n) => n.status === "failed");
    const anyAttention = result.nodes.some((n) => n.status === "attention_required");

    // OPR.0.3.2.CT（守卫裁决 qitem-20260518082933 BLOCKER 1）：
    // attention_required 节点可恢复，但尚未完成——启动结果为 partial，
    // 操作者需要与全 attention 路径相同的检查入口。若将混合的
    // launched+attention 状态视为 "completed"，会让已停放的 seat
    // 隐藏在 201 成功响应之后。只要有任一节点 failed 或
    // attention_required，finalStatus 就应为 partial；import_rig 阶段
    // 应为 "blocked"（而非 "ok"），并携带 attentionNodes 详情，
    // 让路由能够通过与全 attention 场景相同的路径构建三段式错误。
    const finalStatus: BootstrapStatus = anyFailed || anyAttention ? "partial" : "completed";

    if (anyAttention) {
      const attentionNodes: import("./types.js").AttentionNode[] = result.nodes
        .filter((n) => n.status === "attention_required")
        .map((n) => ({
          logicalId: n.logicalId,
          sessionName: n.sessionName ?? "",
          evidence: n.evidence,
          reason: n.error ?? "节点正在等待处理",
        }));
      const message = `${attentionNodes.length} 个节点需要先处理才能进入可交互状态。请选择恢复方式前，先检查受影响的会话及其原因。`;
      stages.push({
        stage: "import_rig",
        status: "blocked",
        detail: {
          code: "attention_required",
          message,
          rigId: result.rigId,
          specName: result.specName,
          nodes: result.nodes,
          attentionNodes,
        },
      });
    } else {
      stages.push({
        stage: "import_rig",
        status: anyFailed ? "failed" : "ok",
        detail: { rigId: result.rigId, specName: result.specName, nodes: result.nodes },
      });
    }
    if (result.warnings?.length) {
      warnings.push(...result.warnings);
    }

    this.deps.bootstrapRepo.updateRunStatus(run.id, finalStatus);
    return {
      runId: run.id,
      status: finalStatus,
      stages,
      rigId: result.rigId,
      errors: result.nodes.filter((n) => n.error).map((n) => n.error!),
      warnings,
    };
  }

  /**
   * 为服务门禁构建预启动钩子。若未配置服务或没有可用的
   * ServiceOrchestrator，则返回 undefined。
   */
  private async buildServicePrelaunchHook(
    rigSpecYaml: string,
    rigRoot: string,
    stages: BootstrapStageResult[],
    errors: string[],
  ): Promise<((rigId: string) => Promise<{ ok: true } | { ok: false; code: string; message: string }>) | undefined> {
    if (!this.deps.serviceOrchestrator || !this.deps.rigRepo) return undefined;

    // 通过规范的 pod 感知 codec/schema 路径解析并规范化
    let normalizedSpec: import("./types.js").RigSpec;
    try {
      const { RigSpecCodec: PodCodec } = await import("./rigspec-codec.js");
      const { RigSpecSchema: PodSchema } = await import("./rigspec-schema.js");
      const raw = PodCodec.parse(rigSpecYaml);
      const validation = PodSchema.validate(raw);
      if (!validation.valid) return undefined;
      normalizedSpec = PodSchema.normalize(raw as Record<string, unknown>);
    } catch {
      return undefined;
    }

    if (!normalizedSpec.services || normalizedSpec.services.kind !== "compose") return undefined;

    const serviceOrch = this.deps.serviceOrchestrator;
    const rigRepo = this.deps.rigRepo;
    const services = normalizedSpec.services;
    const rigName = normalizedSpec.name;

    return async (rigId: string) => {
      // 为刚创建的 rig 持久化服务记录
      const { deriveComposeProjectName } = await import("./compose-project-name.js");
      const composeFile = nodePath.resolve(rigRoot, services.composeFile);
      const projectName = services.projectName ?? deriveComposeProjectName(rigName);

      rigRepo.setServicesRecord(rigId, {
        kind: "compose",
        specJson: JSON.stringify(services),
        rigRoot,
        composeFile,
        projectName,
      });

      // 引导服务——在启动任何 agent 前执行严格的健康门禁
      const bootResult = await serviceOrch.boot(rigId);

      if (!bootResult.ok) {
        errors.push(`服务引导失败：${bootResult.error}`);
        stages.push({
          stage: "service_boot",
          status: "failed",
          detail: { code: bootResult.code, error: bootResult.error, receipt: bootResult.receipt },
        });
        // OPR.0.3.2.22 Bug 2 后续修复——serviceOrch.boot 可能已经启动
        // compose 资源，随后才在 status/wait 阶段失败。接下来
        // PodRigInstantiator 会删除 rig 记录，并级联删除 rig_services
        // 和常规拆除句柄，从而导致已启动的 compose 容器成为孤儿。
        // 趁 rig 句柄仍然存在，在此尽力拆除这些资源。吞掉拆除错误，
        // 避免它们掩盖作为关键返回结果的引导失败。
        try {
          await serviceOrch.teardown(rigId);
        } catch {
          // 尽力而为。若拆除也失败，操作者真正需要的是引导失败错误；
          // 仍可使用规范中的 compose 文件路径手动执行 `docker compose down`。
        }
        return { ok: false, code: "service_boot_failed", message: `服务引导失败：${bootResult.error}` };
      }

      stages.push({
        stage: "service_boot",
        status: "ok",
        detail: { receipt: bootResult.receipt, health: bootResult.health },
      });
      return { ok: true };
    };
  }

  private resolveLegacyNodeCwds(spec: RigSpec, specRoot: string, cwdOverride?: string): RigSpec {
    return {
      ...spec,
      nodes: spec.nodes.map((node) => ({
        ...node,
        cwd: resolveLaunchCwd(node.cwd, specRoot, cwdOverride),
      })),
    };
  }
}
