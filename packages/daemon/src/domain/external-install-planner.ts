import type { ProbeResult } from "./requirements-probe.js";
import { shellQuote } from "../adapters/shell-quote.js";

/** external install action 的审批分类 */
export type ApprovalClassification = "auto_approvable" | "review_required" | "manual_only";

/** plan 中的单个 external install action */
export interface ExternalInstallAction {
  requirementName: string;
  kind: "cli_tool" | "system_package";
  provider: string | null;
  commandPreview: string | null;
  classification: ApprovalClassification;
  installHints: Record<string, string> | null;
  reason: string;
}

/** 完整的 external install plan */
export interface ExternalInstallPlan {
  actions: ExternalInstallAction[];
  autoApprovable: ExternalInstallAction[];
  reviewRequired: ExternalInstallAction[];
  manualOnly: ExternalInstallAction[];
  alreadyInstalled: string[];
}

interface PlannerOptions {
  platform?: string;
}

/**
 * 将缺失 requirement 映射为可信 provider install action。Phase 5 仅交付 Homebrew（darwin）。
 * 其他所有 platform 都产生 manual_only。manifest 中的 install_hints 仅用于展示——绝不执行。
 */
export class ExternalInstallPlanner {
  private platform: string;

  constructor(opts?: PlannerOptions) {
    this.platform = opts?.platform ?? process.platform;
  }

  /**
   * 从 probe result 构建 install plan。
   * @param probeResults RequirementsProbeRegistry.probeAll() 的结果
   */
  planInstalls(probeResults: ProbeResult[]): ExternalInstallPlan {
    const actions: ExternalInstallAction[] = [];
    const alreadyInstalled: string[] = [];

    for (const probe of probeResults) {
      if (probe.status === "installed") {
        alreadyInstalled.push(probe.name);
        continue;
      }

      const action = this.mapToAction(probe);
      actions.push(action);
    }

    return {
      actions,
      autoApprovable: actions.filter((a) => a.classification === "auto_approvable"),
      reviewRequired: actions.filter((a) => a.classification === "review_required"),
      manualOnly: actions.filter((a) => a.classification === "manual_only"),
      alreadyInstalled,
    };
  }

  private mapToAction(probe: ProbeResult): ExternalInstallAction {
    // 不支持的 platform probe 或 unknown（probe 失败）-> manual_only
    if (probe.status === "unsupported") {
      return {
        requirementName: probe.name,
        kind: probe.kind,
        provider: null,
        commandPreview: null,
        classification: "manual_only",
        installHints: probe.installHints,
        reason: "此平台没有可信 provider",
      };
    }

    if (probe.status === "unknown") {
      return {
        requirementName: probe.name,
        kind: probe.kind,
        provider: null,
        commandPreview: null,
        classification: "manual_only",
        installHints: probe.installHints,
        reason: "probe 失败——无法确定 install action",
      };
    }

    // status === "missing"——尝试映射到可信 provider
    if (this.platform === "darwin") {
      return {
        requirementName: probe.name,
        kind: probe.kind,
        provider: "homebrew",
        commandPreview: `brew install ${shellQuote(probe.name)}`,
        classification: "auto_approvable",
        installHints: probe.installHints,
        reason: "可信 Homebrew 安装",
      };
    }

    // 非 darwin 且 requirement 缺失 -> manual_only
    return {
      requirementName: probe.name,
      kind: probe.kind,
      provider: null,
      commandPreview: null,
      classification: "manual_only",
      installHints: probe.installHints,
      reason: "此平台没有可信 provider",
    };
  }
}
