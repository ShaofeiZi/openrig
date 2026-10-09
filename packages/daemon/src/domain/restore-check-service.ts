import { existsSync, accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { getCompatibleOpenRigPath } from "../openrig-compat.js";

// --- 类型 ---

export type CheckStatus = "green" | "yellow" | "red";
export type Verdict = "restorable" | "restorable_with_caveats" | "not_restorable" | "unknown";
export type ReadinessStatus = "ready" | "ready_with_caveats" | "not_ready" | "unknown";
export type HostInfraStatus = "not_inspected" | "not_declared" | "declared" | "unknown";

export interface CheckEntry {
  check: string;
  status: CheckStatus;
  evidence: string;
  remediation: string;
  /** remediation action 是否可安全执行（只读或人工检查）。会修改状态的 action（启动后台服务、
   *  chmod、创建文件、快照）为 false。省略时保守地默认为 false（不安全），防止没有显式分类的
   *  新 check 诱导智能体自动执行修改命令。 */
  remediationSafe?: boolean;
}

export interface RepairStep {
  step: number;
  command: string;
  rationale: string;
  safe: boolean;
  blocking: boolean;
}

export interface ReadinessAssertion {
  status: ReadinessStatus;
  reason: string;
  blockingRigCount: number;
  caveatRigCount: number;
  unknownRigCount: number;
}

export interface ContinuityAssertion {
  status: "proven" | "not_proven" | "partial" | "not_applicable";
  evidence: string;
  provenCapabilities: string[];
  unprovenCapabilities: string[];
}

// OPR.0.4.0.29 FR-8——按 5 个真实 enum 席位 class 拆分 ready-confidence。每项均从真实
// primitive 派生，不发明 status：ready / ready_with_caveats / not_ready 来自席位 readiness
// check；attention_required 来自 node.startupStatus；unknown 是无法确定的剩余项。
// ready_with_caveats 中 fresh-primed/awaiting-decision 的拆分属于延后/escalated 后续工作，
// 本处不发出。
export interface ReadinessClassCounts {
  ready: number;
  ready_with_caveats: number;
  not_ready: number;
  attention_required: number;
  unknown: number;
}

export interface RigRestoreRollup {
  rigId: string;
  rigName: string;
  status: ReadinessStatus;
  verdict: Verdict;
  expectedNodes: number;
  runningReadyNodes: number;
  blockedNodes: number;
  caveatNodes: number;
  classCounts: ReadinessClassCounts;
  blockingChecks: CheckEntry[];
  caveatChecks: CheckEntry[];
}

export interface HostInfraAssertion {
  status: HostInfraStatus;
  evidence: string;
}

export type RecoveryStatus = "not_needed" | "actionable" | "blocked" | "unknown";

export interface RecoveryAction {
  scope: "rig";
  rigId: string;
  rigName: string;
  action: "restore_from_latest_snapshot";
  command: string;
  reason: string;
  safe: boolean;
  blocking: boolean;
}

export interface RecoveryIssue {
  scope: "host" | "rig";
  rigId?: string;
  rigName?: string;
  reason: string;
}

export interface RecoveryPlan {
  status: RecoveryStatus;
  summary: string;
  actions: RecoveryAction[];
  blocked: RecoveryIssue[];
  unknown: RecoveryIssue[];
}

export interface StartupContextResolvedFile {
  absolutePath: string;
  required: boolean;
  path?: string | null;
  deliveryHint?: string | null;
}

export interface StartupContextProjectionEntry {
  absolutePath: string;
  effectiveId?: string | null;
  category?: string | null;
}

export type StartupContextProbeResult =
  | {
      status: "ok";
      runtime: string | null;
      resolvedStartupFiles: StartupContextResolvedFile[];
      projectionEntries: StartupContextProjectionEntry[];
    }
  | {
      status: "missing" | "malformed" | "probe_error";
      evidence: string;
    };

export interface RestoreCheckResult {
  verdict: Verdict;
  readiness: ReadinessAssertion;
  continuity: ContinuityAssertion;
  rigs: RigRestoreRollup[];
  hostInfra: HostInfraAssertion;
  recovery: RecoveryPlan;
  counts: { red: number; yellow: number; green: number };
  /** OPR.0.4.0.29 FR-8——全机队按 class 拆分的 ready-confidence。 */
  classCounts: ReadinessClassCounts;
  checks: CheckEntry[];
  repairPacket: RepairStep[] | null;
}

export interface RestoreCheckOpts {
  rig?: string;
  noQueue?: boolean;
  noHooks?: boolean;
  compact?: boolean;
  /** OPR.0.4.0.29 FR-2：compact 模式下仍组合 ready-seat detail，使 `--ready` 可显示
   *  ready 席位，而无需退回完整信息流。 */
  includeReady?: boolean;
}

// --- 依赖（按 ADR-0001 不依赖框架；按 ADR-0002 读取现有 projection）---

export interface NodeInventoryEntry {
  nodeId?: string | null;
  rigId: string;
  rigName: string;
  logicalId: string;
  podId: string | null;
  podNamespace?: string | null;
  canonicalSessionName: string | null;
  nodeKind: "agent" | "infrastructure";
  runtime: string | null;
  sessionStatus: string | null;
  startupStatus: string | null;
  tmuxAttachCommand: string | null;
  latestError: string | null;
  cwd?: string | null;
}

export interface RestoreCheckDeps {
  /** 获取所有工作组摘要。 */
  listRigs: () => Array<{ rigId: string; name: string; hasServices?: boolean }>;
  /** 获取工作组的节点 inventory（ADR-0002：NodeInventory projection）。 */
  getNodeInventory: (rigId: string) => NodeInventoryEntry[];
  /** 获取节点持久化的 startup context。 */
  getStartupContext: (nodeId: string) => StartupContextProbeResult;
  /** 检查工作组是否存在快照。 */
  hasSnapshot: (rigId: string) => boolean;
  /** 可用时获取最新快照，用于精确恢复规划。 */
  getLatestSnapshot?: (rigId: string) => { id: string; kind: string } | null;
  /** 探测后台服务健康状态，返回 { healthy: boolean; evidence: string }。 */
  probeDaemonHealth: () => { healthy: boolean; evidence: string };
  /** 文件系统探测。 */
  exists: (path: string) => boolean;
  /** 读取声明/配置文件。保持可注入，使 restore-check 可测试且 source-safe。 */
  readFile: (path: string) => string;
  /** 解析 queue 文件路径所用的 substrate root。 */
  substrateRoot?: string;
}

interface RigRollupInput {
  rig: { rigId: string; name: string };
  nodes: NodeInventoryEntry[];
  checks: CheckEntry[];
}

interface RecoveryRigInput {
  rigId: string;
  rigName: string;
  expectedNodes: number;
  runningReadyNodes: number;
  blockingChecks: CheckEntry[];
  latestSnapshot: { id: string; kind: string } | null;
  snapshotLookupError?: string;
}

interface HostInfraCheckResult {
  check: CheckEntry;
  hostInfra: HostInfraAssertion;
}

// --- 服务 ---

const DAEMON_HEALTHY_PATTERN = /^(?:Daemon running\b|后台服务运行中)/m;
// OPR.0.3.2.14——fallback 子路径使用通用 .openrig 占位，而不是内部团队布局，以消除 source
// 侧隐私泄漏。按 slice README §“Architecture note”保留 fallback；在 0.3.1 清理中移除 option-A
// 曾连锁产生 36 个测试 yellow。
const SUBSTRATE_SHARED_DOCS_ROOT = process.env["OPENRIG_SUBSTRATE_SHARED_DOCS"]
  ?? join(homedir(), ".openrig", "shared-docs");
// OPR.0.3.2.14——这四个常量曾被复制到 7 个以上测试文件。改为从 source 导出并由测试导入，
// 消除 0.3.1 清理期间导致 17 个测试损坏的漂移类别。
export const CLAUDE_HOOKS_ROOT = join(
  SUBSTRATE_SHARED_DOCS_ROOT,
  "control-plane",
  "services",
  "claude-hooks",
);
export const CLAUDE_SESSION_START_COMPACT_COMMAND = join(
  CLAUDE_HOOKS_ROOT,
  "bin",
  "session-start-compact-context.sh",
);
export const CLAUDE_USER_PROMPT_SUBMIT_COMMAND = join(
  CLAUDE_HOOKS_ROOT,
  "bin",
  "userpromptsubmit-queue-attention.sh",
);
export const CLAUDE_HOOK_FRAGMENT_PATH = join(
  CLAUDE_HOOKS_ROOT,
  "config",
  "settings.fragment.json",
);

interface ClaudeSettingsCandidate {
  path: string;
  scope: "host-global" | "project" | "project-local";
}

interface ClaudeHookInspection {
  path: string;
  hasSessionStartCompact: boolean;
  hasUserPromptSubmit: boolean;
}

export class RestoreCheckService {
  private deps: RestoreCheckDeps;

  constructor(deps: RestoreCheckDeps) {
    this.deps = deps;
  }

  check(opts: RestoreCheckOpts): RestoreCheckResult {
    const checks: CheckEntry[] = [];
    // rev1-r2 no-false-ready：默认 compact 会计算但不发出的 ready-seat caveat signal
    //（AC-4 token-safe）仍计入顶层 verdict/readiness/counts，避免工作组 rollup 已为
    // ready_with_caveats 时 headline 错报 ready。
    const deferredAssessmentChecks: CheckEntry[] = [];
    const rigRollupInputs: RigRollupInput[] = [];
    const recoveryRigInputs: RecoveryRigInput[] = [];

    // 主机级检查：后台服务探测抛错得到 unknown，而非 not_restorable；明确离线
    //（healthy=false，负向文本）得到 red/not_restorable；socket 不可用等探测异常得到 unknown。
    const daemonCheck = this.checkDaemonReachable();
    if (daemonCheck === null) {
      // 探测抛错，状态无法检查。
      return this.buildUnknown([
        { check: "daemon.reachable", status: "red", evidence: "后台服务健康探测失败，无法确定状态", remediation: "启动后台服务：zrig daemon start",
      remediationSafe: false },
      ]);
    }
    checks.push(daemonCheck);
    checks.push(this.checkStateDirWritable());
    const hostInfraCheck = this.checkHostInfraDeclaration();
    checks.push(hostInfraCheck.check);

    // 获取工作组；探测错误得到 unknown，而非 not_restorable。
    let rigs: Array<{ rigId: string; name: string; hasServices?: boolean }>;
    try {
      rigs = this.deps.listRigs();
    } catch (err) {
      return this.buildUnknown([
        ...checks,
        { check: "probe.error", status: "red", evidence: `列出工作组失败：${err instanceof Error ? err.message : String(err)}`, remediation: "检查后台服务状态：zrig daemon status", remediationSafe: true },
      ]);
    }

    if (opts.rig) {
      rigs = rigs.filter((r) => r.name === opts.rig);
      if (rigs.length === 0) {
        return this.buildResult([
          ...checks,
          { check: `rig.${opts.rig}.exists`, status: "red", evidence: `未找到工作组 "${opts.rig}"`, remediation: "列出工作组：zrig ps", remediationSafe: true },
        ], [], hostInfraCheck.hostInfra);
      }
    }

    // 逐工作组检查。
    for (const rig of rigs) {
      const rigChecks: CheckEntry[] = [];

      const snapshotCheck = this.checkSnapshot(rig);
      checks.push(snapshotCheck);
      rigChecks.push(snapshotCheck);

      // 检查工作组 spec/root。
      const specCheck = this.checkSpecPresent(rig);
      checks.push(specCheck);
      rigChecks.push(specCheck);

      // 逐席位检查；探测错误得到 unknown，而非 not_restorable。
      let nodes: NodeInventoryEntry[];
      try {
        nodes = this.deps.getNodeInventory(rig.rigId);
      } catch (err) {
        return this.buildUnknown([
          ...checks,
          { check: "probe.error", status: "red", evidence: `获取工作组 ${rig.name} 的节点 inventory 失败：${err instanceof Error ? err.message : String(err)}`, remediation: "检查后台服务状态" },
        ]);
      }

      for (const node of nodes) {
        const readinessCheck = this.checkSeatReadiness(node);
        checks.push(readinessCheck);
        rigChecks.push(readinessCheck);

        // OPR.0.4.0.29：默认 compact 下，ready（green）席位跳过完整逐席位 detail 组合，即
        // FR-3/AC-4 的 compute “look-above” 优化；不探测 transcript、resume、queue、hook。
        // 但 FR-8 summary 仍需 restore-readiness caveat signal：running/ready 席位若 startup
        // context 缺失或无法恢复，应为 ready_with_caveats，而非 ready。因此每个席位只计算
        // checkStartupContext 并传给工作组 rollup（rigChecks）；只有不跳过时（full、
        // --ready/includeReady 或非 ready 席位）才发到顶层 `checks`。
        const omitReadyDetail = opts.compact && !opts.includeReady && readinessCheck.status === "green";

        const startupContextCheck = this.checkStartupContext(node);
        if ("unknownChecks" in startupContextCheck) {
          return this.buildUnknown([
            ...checks,
            ...startupContextCheck.unknownChecks,
          ]);
        }
        rigChecks.push(startupContextCheck.check);
        if (omitReadyDetail) {
          // 不发出（AC-4 token-safe），但计入顶层 verdict/readiness/counts
          //（rev1-r2 no-false-ready）。
          deferredAssessmentChecks.push(startupContextCheck.check);
        } else {
          checks.push(startupContextCheck.check);
        }

        // AC-4 / FR-3：默认 compact 不组合其余 ready-seat detail；这是真正跳过计算，不是
        // 组合完成后再隐藏。
        if (omitReadyDetail) {
          continue;
        }

        const transcriptCheck = this.checkTranscript(rig.name, node);
        checks.push(transcriptCheck);
        rigChecks.push(transcriptCheck);

        const resumeCheck = this.checkResumePath(node);
        checks.push(resumeCheck);
        rigChecks.push(resumeCheck);

        if (!opts.noQueue) {
          const queueCheck = this.checkQueueFile(rig.name, node);
          checks.push(queueCheck);
          rigChecks.push(queueCheck);
        }
        if (!opts.noHooks) {
          const hooksCheck = this.checkHooks(node);
          checks.push(hooksCheck);
          rigChecks.push(hooksCheck);
        }
      }

      rigRollupInputs.push({ rig, nodes, checks: rigChecks });
    }

    const rigRollups = rigRollupInputs.map((input) => this.buildRigRollup(input));
    for (const rollup of rigRollups) {
      const latestSnapshot = this.inspectLatestSnapshot(rollup.rigId);
      recoveryRigInputs.push({
        rigId: rollup.rigId,
        rigName: rollup.rigName,
        expectedNodes: rollup.expectedNodes,
        runningReadyNodes: rollup.runningReadyNodes,
        blockingChecks: rollup.blockingChecks,
        latestSnapshot: latestSnapshot.snapshot,
        snapshotLookupError: latestSnapshot.error,
      });
    }

    return this.buildResult(checks, rigRollups, hostInfraCheck.hostInfra, recoveryRigInputs, deferredAssessmentChecks);
  }

  /** 成功或明确离线时返回 CheckEntry；探测异常时返回 null（状态不可检查，调用方应生成
   *  verdict: unknown）。 */
  private checkDaemonReachable(): CheckEntry | null {
    try {
      const probe = this.deps.probeDaemonHealth();
      // 锚定正向匹配：只有行首的中英文明确成功文本才是 green。其他内容均为 red，包括
      // 否定文本、空输出，或在非锚定位置包含成功词的文本。这保留了 prototype 0e2af8d
      // 的 review 修复，同时允许中文化后的健康探针输出。
      if (probe.healthy && DAEMON_HEALTHY_PATTERN.test(probe.evidence)) {
        return { check: "daemon.reachable", status: "green", evidence: probe.evidence, remediation: "" };
      }
      return {
        check: "daemon.reachable", status: "red",
        evidence: probe.evidence || "后台服务健康探测返回非正向结果",
        remediation: "启动后台服务：zrig daemon start",
      remediationSafe: false,
      };
    } catch {
      // 探测抛错，返回 null 表示状态不可检查。
      return null;
    }
  }

  private checkStateDirWritable(): CheckEntry {
    const stateDir = getCompatibleOpenRigPath("");
    try {
      // 不修改状态的权限探测，不创建或删除文件。目录不可写时 accessSync 抛错。
      accessSync(stateDir, constants.W_OK);
      return { check: "host.state-dir-writable", status: "green", evidence: `${stateDir} 可写`, remediation: "" };
    } catch {
      return {
        check: "host.state-dir-writable", status: "red",
        evidence: `${stateDir} 不可写`,
        remediation: `修复权限：chmod u+w ${stateDir}`,
      remediationSafe: false,
      };
    }
  }

  private checkHostInfraDeclaration(): HostInfraCheckResult {
    const declarationPath = getCompatibleOpenRigPath("host-infra.json");
    const check = "host.bootstrap-autostart.declaration";

    try {
      if (!this.deps.exists(declarationPath)) {
        const evidence = `${declarationPath} 中缺少主机基础设施声明`;
        return {
          check: {
            check,
            status: "yellow",
            evidence,
            remediation: `在 ${declarationPath} 创建主机基础设施声明`,
            remediationSafe: false,
          },
          hostInfra: {
            status: "not_declared",
            evidence,
          },
        };
      }

      let raw: string;
      try {
        raw = this.deps.readFile(declarationPath);
      } catch (err) {
        const evidence = `检查 ${declarationPath} 中的主机基础设施声明失败：${err instanceof Error ? err.message : String(err)}`;
        return {
          check: {
            check,
            status: "yellow",
            evidence,
            remediation: `检查或修复 ${declarationPath} 中的主机基础设施声明`,
            remediationSafe: false,
          },
          hostInfra: {
            status: "unknown",
            evidence,
          },
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        const evidence = `解析 ${declarationPath} 中的主机基础设施声明 JSON 失败：${err instanceof Error ? err.message : String(err)}`;
        return {
          check: {
            check,
            status: "yellow",
            evidence,
            remediation: `修复 ${declarationPath} 中的主机基础设施声明 JSON`,
            remediationSafe: false,
          },
          hostInfra: {
            status: "not_declared",
            evidence,
          },
        };
      }

      const validation = this.validateHostInfraDeclaration(parsed);
      if (validation.errors.length > 0) {
        const evidence = `${declarationPath} 中的主机基础设施声明无效：缺失或无效字段 ${validation.errors.join(", ")}`;
        return {
          check: {
            check,
            status: "yellow",
            evidence,
            remediation: `修复 ${declarationPath} 中主机基础设施声明的结构`,
            remediationSafe: false,
          },
          hostInfra: {
            status: "not_declared",
            evidence,
          },
        };
      }

      if (validation.schemaVersion === 2 && validation.evidenceProblems.length > 0) {
        const evidence = `${declarationPath} 中的主机基础设施声明缺少充分的 evidence path；${validation.evidenceProblems.join("; ")}`;
        return {
          check: {
            check,
            status: "yellow",
            evidence,
            remediation: `添加或修复主机基础设施 evidence path：${validation.evidenceProblems.join("; ")}`,
            remediationSafe: false,
          },
          hostInfra: {
            status: "declared",
            evidence,
          },
        };
      }

      const evidence = validation.schemaVersion === 2
        ? `${declarationPath} 中已声明主机基础设施，evidence path 已存在，但尚未验证自动启动；daemonBootstrap mechanism=${validation.mechanism}；requiredSupportingInfra=${validation.requiredSupportingInfra}；evidencePaths=${validation.evidencePaths.join(", ")}`
        : `${declarationPath} 中已声明主机基础设施，但尚未验证；daemonBootstrap mechanism=${validation.mechanism}；requiredSupportingInfra=${validation.requiredSupportingInfra}`;
      return {
        check: {
          check,
          status: "green",
          evidence,
          remediation: "",
        },
        hostInfra: {
          status: "declared",
          evidence,
        },
      };
    } catch (err) {
      const evidence = `检查 ${declarationPath} 中的主机基础设施声明失败：${err instanceof Error ? err.message : String(err)}`;
      return {
        check: {
          check,
          status: "yellow",
          evidence,
          remediation: `检查或修复 ${declarationPath} 中的主机基础设施声明`,
          remediationSafe: false,
        },
        hostInfra: {
          status: "unknown",
          evidence,
        },
      };
    }
  }

  private validateHostInfraDeclaration(value: unknown): {
    errors: string[];
    schemaVersion: 1 | 2 | null;
    mechanism: string;
    requiredSupportingInfra: number;
    evidencePaths: string[];
    evidenceProblems: string[];
  } {
    const errors: string[] = [];
    const evidencePaths: string[] = [];
    const evidenceProblems: string[] = [];
    const obj = isRecord(value) ? value : null;
    if (obj === null) {
      return {
        errors: ["schemaVersion", "daemonBootstrap.mechanism", "supportingInfra"],
        schemaVersion: null,
        mechanism: "unknown",
        requiredSupportingInfra: 0,
        evidencePaths,
        evidenceProblems,
      };
    }

    const schemaVersion = obj["schemaVersion"] === 1 || obj["schemaVersion"] === 2
      ? obj["schemaVersion"]
      : null;
    if (schemaVersion === null) {
      errors.push("schemaVersion");
    }

    const daemonBootstrap = isRecord(obj["daemonBootstrap"]) ? obj["daemonBootstrap"] : null;
    const mechanism = daemonBootstrap && typeof daemonBootstrap["mechanism"] === "string"
      ? daemonBootstrap["mechanism"].trim()
      : "";
    if (!mechanism) {
      errors.push("daemonBootstrap.mechanism");
    }
    if (daemonBootstrap?.["declared"] !== true) {
      errors.push("daemonBootstrap.declared");
    }

    const supportingInfra = Array.isArray(obj["supportingInfra"]) ? obj["supportingInfra"] : null;
    if (!supportingInfra) {
      errors.push("supportingInfra");
    }
    const requiredSupportingInfra = supportingInfra
      ? supportingInfra.filter((entry) => isRecord(entry) && entry["required"] === true).length
      : 0;

    if (schemaVersion === 2 && errors.length === 0) {
      this.collectRequiredEvidencePaths(
        "daemonBootstrap.evidencePaths",
        daemonBootstrap?.["evidencePaths"],
        evidencePaths,
        evidenceProblems,
      );

      supportingInfra?.forEach((entry, index) => {
        if (!isRecord(entry) || entry["required"] !== true) return;
        const id = typeof entry["id"] === "string" && entry["id"].trim()
          ? entry["id"].trim()
          : String(index);
        this.collectRequiredEvidencePaths(
          `supportingInfra[${id}].evidencePaths`,
          entry["evidencePaths"],
          evidencePaths,
          evidenceProblems,
        );
      });
    }

    return {
      errors,
      schemaVersion,
      mechanism: mechanism || "unknown",
      requiredSupportingInfra,
      evidencePaths,
      evidenceProblems,
    };
  }

  private collectRequiredEvidencePaths(
    label: string,
    value: unknown,
    evidencePaths: string[],
    evidenceProblems: string[],
  ): void {
    if (!Array.isArray(value) || value.length === 0) {
      evidenceProblems.push(`${label} 缺失或为空`);
      return;
    }

    for (const candidate of value) {
      if (typeof candidate !== "string" || candidate.trim() === "") {
        evidenceProblems.push(`${label} 包含无效 evidence path ${String(candidate)}`);
        continue;
      }

      const resolved = this.resolveHostInfraEvidencePath(candidate.trim());
      if ("error" in resolved) {
        evidenceProblems.push(`${label} 的 evidence path ${candidate} 无效：${resolved.error}`);
        continue;
      }

      const resolvedPath = resolved.path;
      evidencePaths.push(resolvedPath);
      if (!this.deps.exists(resolvedPath)) {
        evidenceProblems.push(`${label} 缺少 evidence path ${resolvedPath}`);
      }
    }
  }

  private resolveHostInfraEvidencePath(rawPath: string): { path: string; error?: undefined } | { path?: undefined; error: string } {
    const openRigPrefix = "${OPENRIG_HOME}/";
    const hasTraversal = rawPath.split(/[\\/]+/).includes("..");

    if (rawPath.startsWith(openRigPrefix)) {
      const relativePath = rawPath.slice(openRigPrefix.length);
      if (!relativePath || isAbsolute(relativePath) || hasTraversal) {
        return { error: "已拒绝路径穿越或空的 OPENRIG_HOME 相对路径" };
      }
      const openRigHome = getCompatibleOpenRigPath("");
      const resolved = join(openRigHome, relativePath);
      const relativeToHome = relative(openRigHome, resolved);
      if (relativeToHome.startsWith("..") || isAbsolute(relativeToHome)) {
        return { error: "已拒绝穿越到 OPENRIG_HOME 外的路径" };
      }
      return { path: resolved };
    }

    if (!isAbsolute(rawPath)) {
      return { error: "已拒绝普通相对 evidence path；请使用绝对路径或 ${OPENRIG_HOME}/..." };
    }
    if (hasTraversal) {
      return { error: "已拒绝包含路径穿越的 evidence path" };
    }
    return { path: rawPath };
  }

  private checkSnapshot(rig: { rigId: string; name: string }): CheckEntry {
    try {
      const has = this.deps.hasSnapshot(rig.rigId);
      if (has) {
        return { check: `rig.${rig.name}.snapshot`, status: "green", evidence: "快照可用", remediation: "" };
      }
      return {
        check: `rig.${rig.name}.snapshot`, status: "yellow",
        evidence: "未找到快照（首次启动或已接管的工作组）",
        remediation: "创建快照：zrig snapshot <rigId>",
      remediationSafe: false,
      };
    } catch {
      return { check: `rig.${rig.name}.snapshot`, status: "yellow", evidence: "无法检查快照", remediation: "" };
    }
  }

  private checkTranscript(rigName: string, node: NodeInventoryEntry): CheckEntry {
    const session = node.canonicalSessionName ?? node.logicalId;
    const check = `seat.${session}.transcript`;

    // Terminal/infrastructure 节点免于 transcript 检查。
    if (node.nodeKind === "infrastructure") {
      return { check, status: "green", evidence: "Terminal/infrastructure 节点无需检查 transcript", remediation: "" };
    }

    const transcriptPath = join(
      getCompatibleOpenRigPath("transcripts"),
      rigName,
      `${session}.log`
    );
    if (this.deps.exists(transcriptPath)) {
      return { check, status: "green", evidence: `Transcript 存在于 ${transcriptPath}`, remediation: "" };
    }
    return {
      check, status: "yellow",
      evidence: `缺少 transcript：${transcriptPath}`,
      remediation: "下次启动会话时将创建 transcript",
      remediationSafe: true,
    };
  }

  private checkSeatReadiness(node: NodeInventoryEntry): CheckEntry {
    const session = node.canonicalSessionName ?? node.logicalId;
    const check = `seat.${session}.readiness`;

    if (!node.canonicalSessionName) {
      return {
        check,
        status: "red",
        evidence: "缺少 canonical session identity",
        remediation: "恢复或重新启动席位，使其获得 canonical session identity",
        remediationSafe: false,
      };
    }

    if (node.sessionStatus !== "running" || node.startupStatus !== "ready") {
      const latestError = node.latestError ? ` latestError=${node.latestError}` : "";
      return {
        check,
        status: "red",
        evidence: `席位未处于 running/ready：sessionStatus=${node.sessionStatus ?? "unknown"} startupStatus=${node.startupStatus ?? "unknown"}${latestError}`,
        remediation: "恢复或重新启动席位，然后重新运行 zrig restore-check",
        remediationSafe: false,
      };
    }

    return {
      check,
      status: "green",
      evidence: `席位已运行且就绪：${node.canonicalSessionName}`,
      remediation: "",
    };
  }

  private checkResumePath(node: NodeInventoryEntry): CheckEntry {
    const session = node.canonicalSessionName ?? node.logicalId;
    if (node.tmuxAttachCommand) {
      return { check: `seat.${session}.resume-path`, status: "green", evidence: node.tmuxAttachCommand, remediation: "" };
    }
    return {
      check: `seat.${session}.resume-path`, status: "yellow",
      evidence: "没有可用的 attach 命令",
      remediation: "恢复时将全新创建会话",
      remediationSafe: true,
    };
  }

  private checkStartupContext(node: NodeInventoryEntry): { check: CheckEntry } | { unknownChecks: CheckEntry[] } {
    const session = node.canonicalSessionName ?? node.logicalId;
    const check = `seat.${session}.startup-context`;
    const runningReady = node.sessionStatus === "running" && node.startupStatus === "ready";

    if (!node.nodeId) {
      return {
        check: this.buildStartupContextAvailabilityCheck(
          check,
          runningReady,
          `无法检查 startup context，因为 ${session} 缺少 node id`,
        ),
      };
    }

    const probe = this.deps.getStartupContext(node.nodeId);
    switch (probe.status) {
      case "probe_error":
        return {
          unknownChecks: [{
            check: "probe.error",
            status: "red",
            evidence: `检查 ${session} 的 startup context 失败：${probe.evidence}`,
            remediation: "检查后台服务日志：zrig daemon logs",
            remediationSafe: true,
          }],
        };
      case "missing":
      case "malformed":
        return {
          check: this.buildStartupContextAvailabilityCheck(check, runningReady, probe.evidence),
        };
      case "ok":
        break;
    }

    const startupContext = probe;
    const missingRequired = startupContext.resolvedStartupFiles.filter((file) => file.required && !this.deps.exists(file.absolutePath));
    const missingOptional = startupContext.resolvedStartupFiles.filter((file) => !file.required && !this.deps.exists(file.absolutePath));
    const missingProjectionEntries = startupContext.projectionEntries.filter((entry) => !this.deps.exists(entry.absolutePath));

    if (missingRequired.length === 0 && missingOptional.length === 0 && missingProjectionEntries.length === 0) {
      const detailParts: string[] = [];
      if (startupContext.resolvedStartupFiles.length > 0) {
        detailParts.push(
          `已解析的 startup file 存在：${startupContext.resolvedStartupFiles.map((file) => file.absolutePath).join(", ")}`
        );
      }
      if (startupContext.projectionEntries.length > 0) {
        detailParts.push(
          `projection source path 存在：${startupContext.projectionEntries.map((entry) => entry.absolutePath).join(", ")}`
        );
      }
      if (detailParts.length === 0) {
        detailParts.push("未声明持久化 startup file 或 projection source path");
      }
      return {
        check: {
          check,
          status: "green",
          evidence: `节点 ${node.nodeId} 的 startup context 已存在；${detailParts.join("; ")}`,
          remediation: "",
        },
      };
    }

    const evidenceParts: string[] = [];
    if (missingRequired.length > 0) {
      evidenceParts.push(`缺少必需 startup file：${missingRequired.map((file) => file.absolutePath).join(", ")}`);
    }
    if (missingOptional.length > 0) {
      evidenceParts.push(`缺少可选 startup file：${missingOptional.map((file) => file.absolutePath).join(", ")}`);
    }
    if (missingProjectionEntries.length > 0) {
      evidenceParts.push(`缺少 projection source path：${missingProjectionEntries.map((entry) => entry.absolutePath).join(", ")}`);
    }

    const status: CheckStatus = missingRequired.length > 0 && !runningReady ? "red" : "yellow";
    return {
      check: {
        check,
        status,
        evidence: `节点 ${node.nodeId} 的 startup context 已存在，但 replay 输入不完整：${evidenceParts.join("; ")}`,
        remediation: `信任 replay 前，请从工作组或智能体 spec 恢复或重建缺失的 startup 输入：${[
          ...missingRequired.map((file) => file.absolutePath),
          ...missingOptional.map((file) => file.absolutePath),
          ...missingProjectionEntries.map((entry) => entry.absolutePath),
        ].join(", ")}`,
        remediationSafe: false,
      },
    };
  }

  private buildStartupContextAvailabilityCheck(
    check: string,
    runningReady: boolean,
    evidence: string,
  ): CheckEntry {
    return {
      check,
      status: runningReady ? "yellow" : "red",
      evidence,
      remediation: "信任 replay 输入前，请从工作组或智能体 spec 重建席位 startup context",
      remediationSafe: false,
    };
  }

  private checkQueueFile(rigName: string, node: NodeInventoryEntry): CheckEntry {
    const session = node.canonicalSessionName ?? node.logicalId;
    const check = `seat.${session}.queue-file`;

    // 从 pod/member 派生 queue 文件路径。
    const podName = node.podNamespace ?? (node.logicalId.includes(".") ? node.logicalId.split(".")[0] : null);
    const memberName = node.logicalId.includes(".") ? node.logicalId.split(".").slice(1).join(".") : node.logicalId;

    if (!podName) {
      return { check, status: "yellow", evidence: "无法派生 queue 路径（没有 pod namespace）", remediation: "" };
    }

    // OPR.0.3.2.14——子路径已清理（内部团队布局 → 通用占位符）。
    const substrateRoot = this.deps.substrateRoot ?? join(process.env["HOME"] ?? "~", ".openrig", "shared-docs");
    const queuePath = join(substrateRoot, "rigs", rigName, "state", podName, `${memberName}.queue.md`);

    if (this.deps.exists(queuePath)) {
      return { check, status: "green", evidence: `Queue 文件存在于 ${queuePath}`, remediation: "" };
    }
    return {
      check, status: "yellow",
      evidence: `缺少 queue 文件：${queuePath}`,
      remediation: "依赖恢复后的 queue continuity 前，请创建缺失的持久 queue 文件",
      remediationSafe: false,
    };
  }

  private checkHooks(node: NodeInventoryEntry): CheckEntry {
    const session = node.canonicalSessionName ?? node.logicalId;

    if (node.nodeKind !== "agent") {
      return {
        check: `seat.${session}.hooks`, status: "green",
        evidence: "Infrastructure/terminal 节点不适用 Claude Code hook 检查",
        remediation: "",
      };
    }

    if (node.runtime !== "claude-code") {
      return {
        check: `seat.${session}.hooks`, status: "green",
        evidence: `${node.runtime ?? "non-Claude"} 席位不适用 Claude Code hook 检查`,
        remediation: "",
      };
    }

    const candidates = this.getClaudeSettingsCandidates(node);
    const searchedPaths = candidates.map((candidate) => candidate.path);
    const cwdUnavailable = !node.cwd;
    const inspections: ClaudeHookInspection[] = [];
    const malformed: string[] = [];

    for (const candidate of candidates) {
      if (!this.deps.exists(candidate.path)) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(this.deps.readFile(candidate.path));
      } catch (err) {
        malformed.push(`${candidate.path}：${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      inspections.push({
        path: candidate.path,
        hasSessionStartCompact: this.hasClaudeCommandHook(parsed, "SessionStart", CLAUDE_SESSION_START_COMPACT_COMMAND, "compact"),
        hasUserPromptSubmit: this.hasClaudeCommandHook(parsed, "UserPromptSubmit", CLAUDE_USER_PROMPT_SUBMIT_COMMAND),
      });
    }

    if (malformed.length > 0) {
      return {
        check: `seat.${session}.hooks`, status: "yellow",
        evidence: `适用的 Claude settings 文件格式错误：${malformed.join("; ")}。修复格式错误的适用 settings 文件前，不能信任 Claude hook 配置。已搜索 settings 路径：${searchedPaths.join(", ")}`,
        remediation: `信任 hook readiness 前，请修复 Claude settings JSON：${malformed.map((entry) => entry.split("：")[0]).join(", ")}`,
        remediationSafe: false,
      };
    }

    const sessionStartPaths = inspections
      .filter((inspection) => inspection.hasSessionStartCompact)
      .map((inspection) => inspection.path);
    const userPromptSubmitPaths = inspections
      .filter((inspection) => inspection.hasUserPromptSubmit)
      .map((inspection) => inspection.path);
    const hasSessionStart = sessionStartPaths.length > 0;
    const hasUserPromptSubmit = userPromptSubmitPaths.length > 0;

    if (hasSessionStart && hasUserPromptSubmit) {
      return {
        check: `seat.${session}.hooks`, status: "green",
        evidence: `Claude Code hook 配置已存在，但尚未验证 hook 执行；在 ${sessionStartPaths.join(", ")} 找到 SessionStart matcher compact 命令；在 ${userPromptSubmitPaths.join(", ")} 找到 UserPromptSubmit 命令。已搜索 settings 路径：${searchedPaths.join(", ")}`,
        remediation: "",
      };
    }

    const missing = [];
    if (!hasSessionStart) {
      missing.push(`SessionStart matcher compact 命令 ${CLAUDE_SESSION_START_COMPACT_COMMAND}`);
    }
    if (!hasUserPromptSubmit) {
      missing.push(`UserPromptSubmit 命令 ${CLAUDE_USER_PROMPT_SUBMIT_COMMAND}`);
    }

    const inspected = inspections.length > 0
      ? `已检查现有 settings：${inspections.map((inspection) => inspection.path).join(", ")}。`
      : "未找到现有 Claude settings 文件。";
    const cwdEvidence = cwdUnavailable
      ? " cwd 不可用，因此未检查项目 settings。"
      : "";

    return {
      check: `seat.${session}.hooks`, status: "yellow",
      evidence: `Claude Code hook 配置缺少必需 entry：${missing.join("; ")}。已搜索 settings 路径：${searchedPaths.join(", ")}。${inspected}${cwdEvidence}`,
      remediation: `把 ${CLAUDE_HOOK_FRAGMENT_PATH} 中必需的 Claude hook entry 合并到 host-global 或项目 Claude settings`,
      remediationSafe: false,
    };
  }

  private getClaudeSettingsCandidates(node: NodeInventoryEntry): ClaudeSettingsCandidate[] {
    const home = process.env["HOME"] ?? "~";
    const candidates: ClaudeSettingsCandidate[] = [{
      path: join(home, ".claude", "settings.json"),
      scope: "host-global",
    }];

    if (node.cwd) {
      candidates.push({
        path: join(node.cwd, ".claude", "settings.json"),
        scope: "project",
      });
      candidates.push({
        path: join(node.cwd, ".claude", "settings.local.json"),
        scope: "project-local",
      });
    }

    return candidates;
  }

  private hasClaudeCommandHook(settings: unknown, eventName: string, requiredCommand: string, requiredMatcher?: string): boolean {
    if (!isRecord(settings) || !isRecord(settings["hooks"])) return false;
    const eventEntries = settings["hooks"][eventName];
    if (!Array.isArray(eventEntries)) return false;

    return eventEntries.some((entry) => {
      if (!isRecord(entry)) return false;
      if (requiredMatcher !== undefined && entry["matcher"] !== requiredMatcher) return false;
      const hooks = entry["hooks"];
      if (!Array.isArray(hooks)) return false;
      return hooks.some((hook) => isRecord(hook) && hook["command"] === requiredCommand);
    });
  }

  private checkSpecPresent(rig: { rigId: string; name: string }): CheckEntry {
    // OPR.0.3.2.14——子路径已清理（内部团队布局 → 通用占位符）。
    const substrateRoot = this.deps.substrateRoot ?? join(process.env["HOME"] ?? "~", ".openrig", "shared-docs");
    const rigRoot = join(substrateRoot, "rigs", rig.name);
    const rigYaml = join(rigRoot, "rig.yaml");

    if (!this.deps.exists(rigRoot)) {
      return {
        check: `rig.${rig.name}.spec-present`, status: "red",
        evidence: `缺少工作组根目录：${rigRoot}`,
        remediation: `在 ${rigRoot} 创建工作组根目录，并添加 rig.yaml spec`,
      remediationSafe: false,
      };
    }
    if (!this.deps.exists(rigYaml)) {
      return {
        check: `rig.${rig.name}.spec-present`, status: "yellow",
        evidence: `工作组根目录存在，但缺少 rig.yaml：${rigYaml}`,
        remediation: `向 ${rigRoot} 添加 rig.yaml spec`,
      remediationSafe: false,
      };
    }
    return { check: `rig.${rig.name}.spec-present`, status: "green", evidence: `Spec 存在于 ${rigYaml}`, remediation: "" };
  }

  private inspectLatestSnapshot(rigId: string): { snapshot: { id: string; kind: string } | null; error?: string } {
    if (!this.deps.getLatestSnapshot) {
      return { snapshot: null };
    }

    try {
      const snapshot = this.deps.getLatestSnapshot(rigId);
      if (!snapshot) return { snapshot: null };
      return { snapshot: { id: snapshot.id, kind: snapshot.kind } };
    } catch (err) {
      return {
        snapshot: null,
        error: `查询最新快照失败：${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private buildResult(
    checks: CheckEntry[],
    rigs: RigRestoreRollup[],
    hostInfra?: HostInfraAssertion,
    recoveryInputs: RecoveryRigInput[] = [],
    assessmentExtra: CheckEntry[] = [],
  ): RestoreCheckResult {
    // counts + verdict 评估完整 signal（已发出的 check + 已计算但省略的 ready-seat caveat），
    // 因此默认 compact 不会误报 ready；repairPacket/recovery 仍只处理已发出 check（token-safe）。
    const assessed = assessmentExtra.length > 0 ? [...checks, ...assessmentExtra] : checks;
    const red = assessed.filter((c) => c.status === "red").length;
    const yellow = assessed.filter((c) => c.status === "yellow").length;
    const green = assessed.filter((c) => c.status === "green").length;

    let verdict: Verdict;
    if (red > 0) {
      verdict = "not_restorable";
    } else if (yellow > 0) {
      verdict = "restorable_with_caveats";
    } else {
      verdict = "restorable";
    }

    const repairPacket = this.buildRepairPacket(checks, verdict);
    const recovery = this.buildRecovery(verdict, checks, recoveryInputs);
    return this.withAssertion({ verdict, counts: { red, yellow, green }, checks, repairPacket, recovery }, rigs, hostInfra);
  }

  /** 探测错误产生 verdict=unknown，而非 not_restorable，使操作员能区分“确定损坏”和“检查器
   *  无法检查”。 */
  private buildUnknown(checks: CheckEntry[]): RestoreCheckResult {
    const red = checks.filter((c) => c.status === "red").length;
    const yellow = checks.filter((c) => c.status === "yellow").length;
    const green = checks.filter((c) => c.status === "green").length;
    const repairPacket = this.buildRepairPacket(checks, "unknown");
    const evidence = checks.find((check) => check.status === "red")?.evidence
      ?? "无法检查 restore-check 状态";
    return this.withAssertion({
      verdict: "unknown",
      counts: { red, yellow, green },
      checks,
      repairPacket,
      recovery: {
        status: "unknown",
        summary: "restore-check 状态未知，因此无法检查恢复状态。",
        actions: [],
        blocked: [],
        unknown: [{ scope: "host", reason: evidence }],
      },
    }, []);
  }

  private withAssertion(
    result: Pick<RestoreCheckResult, "verdict" | "counts" | "checks" | "repairPacket" | "recovery">,
    rigs: RigRestoreRollup[],
    hostInfra?: HostInfraAssertion,
  ): RestoreCheckResult {
    const blockingRigCount = rigs.filter((rig) => rig.blockedNodes > 0 || rig.blockingChecks.length > 0).length;
    const caveatRigCount = rigs.filter((rig) => rig.blockedNodes === 0 && rig.blockingChecks.length === 0 && (rig.caveatNodes > 0 || rig.caveatChecks.length > 0)).length;
    const unknownRigCount = rigs.filter((rig) => rig.status === "unknown").length;

    let readinessStatus: ReadinessStatus;
    let reason: string;
    if (result.verdict === "unknown") {
      readinessStatus = "unknown";
      reason = "unknown_probe_state";
    } else if (result.counts.red > 0) {
      readinessStatus = "not_ready";
      reason = "blockers_present";
    } else if (result.counts.yellow > 0) {
      readinessStatus = "ready_with_caveats";
      reason = "caveats_present";
    } else {
      readinessStatus = "ready";
      reason = hostInfra?.status === "declared"
        ? "all_observable_checks_green_host_infra_declared_not_verified"
        : "all_observable_checks_green";
    }

    // v1 中 continuity 始终为 not_proven，没有任何代码路径能产生 "proven"。
    const continuity: ContinuityAssertion = {
      status: "not_proven",
      evidence: "restore-check v1 尚未验证严格的同 session/provider-context resume；已验证可观测 readiness。",
      provenCapabilities: this.computeProvenCapabilities(result.checks),
      unprovenCapabilities: [
        "provider_session_resume",
        "context_window_preservation",
        "interrupted_work_functional_resume",
      ],
    };

    return {
      ...result,
      readiness: {
        status: readinessStatus,
        reason,
        blockingRigCount,
        caveatRigCount,
        unknownRigCount,
      },
      continuity,
      rigs,
      // FR-8：全机队 ready-confidence 拆分 = 各工作组 class count 之和。
      classCounts: rigs.reduce<ReadinessClassCounts>((acc, r) => ({
        ready: acc.ready + r.classCounts.ready,
        ready_with_caveats: acc.ready_with_caveats + r.classCounts.ready_with_caveats,
        not_ready: acc.not_ready + r.classCounts.not_ready,
        attention_required: acc.attention_required + r.classCounts.attention_required,
        unknown: acc.unknown + r.classCounts.unknown,
      }), { ready: 0, ready_with_caveats: 0, not_ready: 0, attention_required: 0, unknown: 0 }),
      hostInfra: result.verdict === "unknown"
        ? {
            status: "unknown",
            evidence: "restore-check 状态未知，因此无法检查主机 bootstrap/autostart source",
          }
        : (hostInfra ?? {
            status: "not_inspected",
            evidence: "v0 未检查主机 bootstrap/autostart source；readiness 只覆盖可观测的后台服务、工作组与席位检查",
          }),
      recovery: result.recovery,
    };
  }

  /** 从 green check 派生 continuity block 的 proven capability。 */
  private computeProvenCapabilities(checks: CheckEntry[]): string[] {
    const proven: string[] = [];
    if (checks.some((c) => c.check === "daemon.reachable" && c.status === "green")) proven.push("daemon_reachable");
    if (checks.some((c) => c.check.endsWith(".transcript") && c.status === "green")) proven.push("transcript_readable");
    if (checks.some((c) => c.check.endsWith(".spec-present") && c.status === "green")) proven.push("spec_present");
    if (checks.some((c) => c.check.endsWith(".queue-file") && c.status === "green")) proven.push("queue_file_present");
    if (checks.some((c) => c.check.endsWith(".resume-path") && c.status === "green")) proven.push("seat_identity_resolvable");
    return proven;
  }

  private buildRecovery(
    verdict: Verdict,
    checks: CheckEntry[],
    recoveryInputs: RecoveryRigInput[],
  ): RecoveryPlan {
    if (verdict === "unknown") {
      const evidence = checks.find((check) => check.status === "red")?.evidence
        ?? "无法检查 restore-check 状态";
      return {
        status: "unknown",
        summary: "restore-check 状态未知，因此无法检查恢复状态。",
        actions: [],
        blocked: [],
        unknown: [{ scope: "host", reason: evidence }],
      };
    }

    if (recoveryInputs.length === 0) {
      const firstRed = checks.find((check) => check.status === "red");
      if (firstRed) {
        return {
          status: "blocked",
          summary: "restore-check 在可运行工作组 inventory 之外发现 blocker，因此 v0 无法确定精确恢复 action。",
          actions: [],
          blocked: [{ scope: "host", reason: firstRed.evidence }],
          unknown: [],
        };
      }
      return {
        status: "not_needed",
        summary: "所有可观测工作组均已 running/ready，无需恢复 action。",
        actions: [],
        blocked: [],
        unknown: [],
      };
    }

    const allReady = recoveryInputs.every((input) => input.runningReadyNodes === input.expectedNodes);
    if (allReady) {
      return {
        status: "not_needed",
        summary: "所有可观测工作组均已 running/ready，无需恢复 action。",
        actions: [],
        blocked: [],
        unknown: [],
      };
    }

    const actions: RecoveryAction[] = [];
    const blocked: RecoveryIssue[] = [];
    const unknown: RecoveryIssue[] = [];

    for (const input of recoveryInputs) {
      if (input.runningReadyNodes === input.expectedNodes) continue;

      if (input.snapshotLookupError) {
        unknown.push({
          scope: "rig",
          rigId: input.rigId,
          rigName: input.rigName,
          reason: input.snapshotLookupError,
        });
        continue;
      }

      const restoreInputBlockers = input.blockingChecks.filter((check) =>
        this.classifyRecoveryBlockingCheck(check) === "restore_input"
      );
      if (restoreInputBlockers.length > 0) {
        blocked.push({
          scope: "rig",
          rigId: input.rigId,
          rigName: input.rigName,
          reason: `仍存在 restore-input blocker，因此 v0 无法确定精确恢复 action：${restoreInputBlockers.map((check) => check.evidence).join("; ")}`,
        });
        continue;
      }

      if (input.latestSnapshot) {
        actions.push({
          scope: "rig",
          rigId: input.rigId,
          rigName: input.rigName,
          action: "restore_from_latest_snapshot",
          command: `zrig up --existing ${shellQuote(input.rigName)}`,
          reason: "工作组有最新快照，且至少一个席位未处于 running/ready。",
          safe: false,
          blocking: true,
        });
        continue;
      }

      actions.push({
        scope: "rig",
        rigId: input.rigId,
        rigName: input.rigName,
        action: "restore_from_latest_snapshot",
        command: `zrig up --existing ${shellQuote(input.rigName)}`,
        reason: "工作组已持久化当前 DB 状态，但没有最新快照；zrig up 会捕获 auto-rehydrate 快照并恢复。",
        safe: false,
        blocking: true,
      });
    }

    const status: RecoveryStatus = unknown.length > 0
      ? "unknown"
      : actions.length > 0
        ? "actionable"
        : blocked.length > 0
          ? "blocked"
          : "not_needed";

    return {
      status,
      summary: this.buildRecoverySummary(status, actions, blocked, unknown),
      actions,
      blocked,
      unknown,
    };
  }

  private classifyRecoveryBlockingCheck(check: CheckEntry): "restore_input" | "runtime" | "other" {
    if (check.status !== "red") return "other";

    if (check.check.startsWith("seat.") && check.check.endsWith(".readiness")) {
      if (check.evidence.includes("缺少 canonical session identity")) {
        return "restore_input";
      }
      return "runtime";
    }

    if (check.check.startsWith("seat.") && check.check.endsWith(".startup-context")) {
      return "restore_input";
    }

    return "other";
  }

  private buildRecoverySummary(
    status: RecoveryStatus,
    actions: RecoveryAction[],
    blocked: RecoveryIssue[],
    unknown: RecoveryIssue[],
  ): string {
    if (status === "not_needed") {
      return "所有可观测工作组均已 running/ready，无需恢复 action。";
    }
    if (status === "unknown") {
      return `无法完整检查恢复状态；${actions.length} 个可执行，${blocked.length} 个被阻塞，${unknown.length} 个未知。`;
    }
    if (status === "actionable") {
      return `${actions.length} 个工作组可用已知 zrig 命令恢复；${blocked.length} 个工作组被阻塞；${unknown.length} 个未知。`;
    }
    return `${blocked.length} 个工作组被阻塞；${actions.length} 个可执行；${unknown.length} 个未知。`;
  }

  private buildRigRollup(input: RigRollupInput): RigRestoreRollup {
    const blockingChecks = input.checks.filter((check) => check.status === "red");
    const caveatChecks = input.checks.filter((check) => check.status === "yellow");
    const expectedNodes = input.nodes.length;
    let runningReadyNodes = 0;
    let blockedNodes = 0;
    let caveatNodes = 0;
    // FR-8：逐席位 class 拆分，每个席位恰好计入一个 class。
    const classCounts: ReadinessClassCounts = { ready: 0, ready_with_caveats: 0, not_ready: 0, attention_required: 0, unknown: 0 };
    // unknown/no-snapshot 从真实 snapshot primitive 派生：工作组级 `rig.<name>.snapshot`
    // yellow check（未找到快照或无法检查）。没有快照的工作组无法恢复，因此按 FR-8/AC-7，
    // 其中席位的 restore-readiness 为 unknown，而不是 "ready"。
    const rigNoSnapshot = input.checks.some(
      (check) => check.check === `rig.${input.rig.name}.snapshot` && check.status === "yellow",
    );

    for (const node of input.nodes) {
      const session = node.canonicalSessionName ?? node.logicalId;
      const nodeChecks = input.checks.filter((check) => check.check.startsWith(`seat.${session}.`));
      const hasBlocking = nodeChecks.some((check) => check.status === "red");
      const hasCaveat = nodeChecks.some((check) => check.status === "yellow");
      const runningReady = Boolean(node.canonicalSessionName) && node.sessionStatus === "running" && node.startupStatus === "ready";
      if (runningReady) runningReadyNodes += 1;
      if (hasBlocking) blockedNodes += 1;
      else if (hasCaveat) caveatNodes += 1;

      // FR-8 class 派生（按优先级，每项来自真实 primitive）。attention/not_ready 最优先，
      // 即使工作组没有快照，也会呈现 failed/attention 席位；no-snapshot 随后只覆盖 ready/caveat，
      // 不可恢复工作组中的 clean 席位为 unknown；真实 yellow caveat 再优先于普通 ready，使
      // class count 与逐工作组 status + caveatNodes 一致。带 yellow check 的 running/ready 席位
      // 不是普通 ready：
      //   attention_required ← node.startupStatus
      //   not_ready          ← 红色席位检查（failed/down）
      //   unknown            ← 无快照（工作组无法恢复）
      //   ready_with_caveats ← 黄色席位检查
      //   ready              ← running/ready, no caveat
      //   unknown            ← 无法确定的其余情况
      if (node.startupStatus === "attention_required") classCounts.attention_required += 1;
      else if (hasBlocking) classCounts.not_ready += 1;
      else if (rigNoSnapshot) classCounts.unknown += 1;
      else if (hasCaveat) classCounts.ready_with_caveats += 1;
      else if (runningReady) classCounts.ready += 1;
      else classCounts.unknown += 1;
    }

    let verdict: Verdict;
    let status: ReadinessStatus;
    if (blockingChecks.length > 0) {
      verdict = "not_restorable";
      status = "not_ready";
    } else if (caveatChecks.length > 0) {
      verdict = "restorable_with_caveats";
      status = "ready_with_caveats";
    } else {
      verdict = "restorable";
      status = "ready";
    }

    return {
      rigId: input.rig.rigId,
      rigName: input.rig.name,
      status,
      verdict,
      expectedNodes,
      runningReadyNodes,
      blockedNodes,
      caveatNodes,
      classCounts,
      blockingChecks,
      caveatChecks,
    };
  }

  /** 从带 remediation 的非 green check 生成有序 repair step。全部 green 时返回 null，即
   *  restorable 且无需修复。先按原 check 顺序放 blocker（red），再放 caveat（yellow）。 */
  private buildRepairPacket(checks: CheckEntry[], verdict: Verdict): RepairStep[] | null {
    if (verdict === "restorable") return null;

    // 先 blocker，后 caveat；每组内保留原 check 顺序。
    const blockers = checks.filter((c) => c.status === "red" && c.remediation);
    const caveats = checks.filter((c) => c.status === "yellow" && c.remediation);
    const ordered = [...blockers, ...caveats];

    if (ordered.length === 0) return null;

    let step = 0;
    return ordered.map((c) => ({
      step: ++step,
      command: c.remediation,
      rationale: c.evidence,
      safe: c.remediationSafe === true,  // 保守处理：除非明确标为 safe，否则默认 false。
      blocking: c.status === "red",
    }));
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._@:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pluralize(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
