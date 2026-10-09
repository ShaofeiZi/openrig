import path from "node:path";
import type { ResolvedPackage, FsOps } from "./package-resolver.js";
import { resolveExports, type ResolvedExports, type DeferredExport } from "./role-resolver.js";

// --- 类型 ---

export type ActionClassification =
  | "safe_projection"
  | "managed_merge"
  | "config_mutation"
  | "external_install"
  | "manual_only";

export interface ConflictInfo {
  existingPath: string;
  existingHash?: string;
  sourceHash?: string;
  reason: string;
}

export interface InstallPlanEntry {
  exportType: string;
  exportName: string;
  classification: ActionClassification;
  targetPath: string;
  scope: string;
  sourcePath?: string; // requirement 没有来源文件，因此省略。
  conflict?: ConflictInfo;
  deferred: boolean;
  deferReason?: string;
}

export interface InstallPlan {
  packageId?: string; // 持久化到 DB 时由调用方设置。
  packageName: string;
  packageVersion: string;
  sourceRef: string;
  entries: InstallPlanEntry[];
  actionable: InstallPlanEntry[];
  deferred: InstallPlanEntry[];
  conflicts: InstallPlanEntry[];
}

export interface PlanOptions {
  roleName?: string;
}

// --- 规划器 ---

export class InstallPlanner {
  private fs: FsOps;

  constructor(fs: FsOps) {
    this.fs = fs;
  }

  plan(
    resolved: ResolvedPackage,
    targetRoot: string,
    runtime: "claude-code" | "codex",
    options?: PlanOptions,
  ): InstallPlan {
    // R2-H2：兼容性检查——runtime 必须在清单 runtimes 中。
    if (!resolved.manifest.compatibility.runtimes.includes(runtime)) {
      throw new Error(`package '${resolved.manifest.name}' 不支持运行时 '${runtime}'。支持：${resolved.manifest.compatibility.runtimes.join(", ")}`);
    }

    const exports = resolveExports(resolved.manifest, options?.roleName);
    const entries: InstallPlanEntry[] = [];

    // 规划技能。
    for (const skill of exports.skills) {
      // R2-H2：范围强制——跳过/延后不支持 project_shared 的条目。
      if (skill.supportedScopes && !skill.supportedScopes.includes("project_shared")) {
        entries.push({
          exportType: "skill",
          exportName: skill.name,
          classification: "config_mutation",
          targetPath: "",
          scope: "project_shared",
          deferred: true,
          deferReason: `技能 '${skill.name}' 不支持 project_shared 范围`,
        });
        continue;
      }

      // R2-H1：枚举技能来源目录中的全部文件。
      const sourceDir = path.join(resolved.sourceRef, skill.source);
      const files = this.fs.listFiles ? this.fs.listFiles(sourceDir) : ["SKILL.md"];

      for (const file of files) {
        const targetPath = runtime === "claude-code"
          ? path.join(targetRoot, ".claude", "skills", skill.name, file)
          : path.join(targetRoot, ".agents", "skills", skill.name, file);

        const exists = this.fs.exists(targetPath);
        const entry: InstallPlanEntry = {
          exportType: "skill",
          exportName: `${skill.name}/${file}`,
          classification: "safe_projection",
          targetPath,
          sourcePath: path.join(sourceDir, file),
          scope: "project_shared",
          deferred: false,
        };

        // F2.1：检查来源文件是否存在。
        if (!this.fs.exists(entry.sourcePath!)) {
          throw new Error(`未找到来源文件：${entry.sourcePath}`);
        }

        if (exists) {
          entry.conflict = {
            existingPath: targetPath,
            reason: `技能 '${skill.name}/${file}' 已存在于目标位置`,
          };
        }

        entries.push(entry);
      }
    }

    // 规划指导文件。
    for (const g of exports.guidance) {
      // R2-H2：范围强制。
      if (g.supportedScopes && !g.supportedScopes.includes("project_shared")) {
        entries.push({
          exportType: "guidance",
          exportName: g.name,
          classification: "config_mutation",
          targetPath: "",
          scope: "project_shared",
          deferred: true,
          deferReason: `指导文件 '${g.name}' 不支持 project_shared 范围`,
        });
        continue;
      }

      // runtime 与 guidance 类别不匹配时延后。
      if (g.kind === "agents_md" && runtime === "claude-code") {
        entries.push({
          exportType: "guidance",
          exportName: g.name,
          classification: "config_mutation",
          targetPath: "",
          scope: "project_shared",
          deferred: true,
          deferReason: "agents_md 指导文件不适用于 claude-code",
        });
        continue;
      }
      if (g.kind === "claude_md" && runtime === "codex") {
        entries.push({
          exportType: "guidance",
          exportName: g.name,
          classification: "config_mutation",
          targetPath: "",
          scope: "project_shared",
          deferred: true,
          deferReason: "claude_md 指导文件不适用于 codex",
        });
        continue;
      }

      // generic_rules_overlay 暂缓处理。
      if (g.kind === "generic_rules_overlay") {
        entries.push({
          exportType: "guidance",
          exportName: g.name,
          classification: "config_mutation",
          targetPath: "",
          scope: "project_shared",
          deferred: true,
          deferReason: "阶段 4 不支持 generic_rules_overlay",
        });
        continue;
      }

      // replace/manual 策略暂缓处理。
      if (g.mergeStrategy === "replace" || g.mergeStrategy === "manual") {
        entries.push({
          exportType: "guidance",
          exportName: g.name,
          classification: "manual_only",
          targetPath: "",
          scope: "project_shared",
          deferred: true,
          deferReason: `阶段 4 不支持 ${g.mergeStrategy} 合并`,
        });
        continue;
      }

      // 确定目标路径。
      const targetFile = g.kind === "agents_md" ? "AGENTS.md" : "CLAUDE.md";
      const targetPath = path.join(targetRoot, targetFile);
      const exists = this.fs.exists(targetPath);

      const guidanceSourcePath = path.join(resolved.sourceRef, g.source);

      // F2.1：检查来源文件是否存在。
      if (!this.fs.exists(guidanceSourcePath)) {
        throw new Error(`未找到来源文件：${guidanceSourcePath}`);
      }

      entries.push({
        exportType: "guidance",
        exportName: g.name,
        classification: exists ? "managed_merge" : "safe_projection",
        targetPath,
        sourcePath: guidanceSourcePath,
        scope: "project_shared",
        deferred: false,
      });
    }

    // 规划智能体（单个 YAML 文件，而非目录）。
    for (const agent of exports.agents) {
      const agentName = agent.name ?? path.basename(agent.source, path.extname(agent.source));

      // R2-H2：范围强制。
      if (agent.supportedScopes && !agent.supportedScopes.includes("project_shared")) {
        entries.push({
          exportType: "agent",
          exportName: agentName,
          classification: "config_mutation",
          targetPath: "",
          scope: "project_shared",
          deferred: true,
          deferReason: `智能体 '${agentName}' 不支持 project_shared 范围`,
        });
        continue;
      }

      const targetPath = runtime === "claude-code"
        ? path.join(targetRoot, ".claude", "agents", `${agentName}.yaml`)
        : path.join(targetRoot, ".agents", `${agentName}.yaml`);

      const agentSourcePath = path.join(resolved.sourceRef, agent.source);

      // F2.1：检查来源文件是否存在。
      if (!this.fs.exists(agentSourcePath)) {
        throw new Error(`未找到来源文件：${agentSourcePath}`);
      }

      const exists = this.fs.exists(targetPath);
      const entry: InstallPlanEntry = {
        exportType: "agent",
        exportName: agentName,
        classification: "safe_projection",
        targetPath,
        sourcePath: agentSourcePath,
        scope: "project_shared",
        deferred: false,
      };

      if (exists) {
        entry.conflict = {
          existingPath: targetPath,
          reason: `智能体 '${agentName}' 已存在于目标位置`,
        };
      }

      entries.push(entry);
    }

    // 规划延后项（来自角色解析器的 hooks、mcp）。
    for (const d of exports.deferred) {
      entries.push({
        exportType: d.exportType,
        exportName: d.source,
        classification: "config_mutation",
        targetPath: "",
        scope: "project_shared",
        deferred: true,
        deferReason: d.reason,
      });
    }

    // 将 requirements 规划为延后项。
    if (resolved.manifest.requirements?.cliTools) {
      for (const tool of resolved.manifest.requirements.cliTools) {
        entries.push({
          exportType: "requirement",
          exportName: tool.name,
          classification: "external_install",
          targetPath: "",
          scope: "project_shared",
          deferred: true,
          deferReason: `CLI 工具 '${tool.name}' 需要外部安装（阶段 5）`,
        });
      }
    }
    if (resolved.manifest.requirements?.systemPackages) {
      for (const pkg of resolved.manifest.requirements.systemPackages) {
        entries.push({
          exportType: "requirement",
          exportName: pkg.name,
          classification: "external_install",
          targetPath: "",
          scope: "project_shared",
          deferred: true,
          deferReason: `系统 package '${pkg.name}' 需要外部安装（阶段 5）`,
        });
      }
    }

    // 拆分为不同类别。
    const actionable = entries.filter((e) => !e.deferred && !e.conflict);
    const deferred = entries.filter((e) => e.deferred);
    const conflicts = entries.filter((e) => !!e.conflict && !e.deferred);

    return {
      // 调用方持久化到 DB 前，packageId 保持 undefined。
      packageName: resolved.manifest.name,
      packageVersion: resolved.manifest.version,
      sourceRef: resolved.sourceRef,
      entries,
      actionable,
      deferred,
      conflicts,
    };
  }
}
