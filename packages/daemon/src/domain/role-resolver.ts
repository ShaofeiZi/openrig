import type {
  PackageManifest,
  SkillExport,
  GuidanceExport,
  AgentExport,
} from "./package-manifest.js";

export interface DeferredExport {
  exportType: "hook" | "mcp";
  source: string;
  reason: string;
}

export interface ResolvedExports {
  skills: SkillExport[];
  guidance: GuidanceExport[];
  agents: AgentExport[];
  deferred: DeferredExport[];
}

/**
 * 解析 package export，可选按 role 过滤。
 * - 提供 roleName 时：将 skill/guidance 过滤为 role reference，保留所有 agent，
 *   延后 role 引用的 hook。
 * - 未提供 roleName 时：返回所有 export，延后所有 hook/mcp。
 * - 忽略 context reference（仅供人阅读的文档）。
 */
export function resolveExports(
  manifest: PackageManifest,
  roleName?: string
): ResolvedExports {
  const allSkills = manifest.exports.skills ?? [];
  const allGuidance = manifest.exports.guidance ?? [];
  const allAgents = manifest.exports.agents ?? [];
  const allHooks = manifest.exports.hooks ?? [];
  const allMcp = manifest.exports.mcp ?? [];

  // 无 role → 完整 package
  if (!roleName) {
    const deferred: DeferredExport[] = [
      ...allHooks.map((h) => ({
        exportType: "hook" as const,
        source: h.source,
        reason: "Hook 延后至 Phase 5",
      })),
      ...allMcp.map((m) => ({
        exportType: "mcp" as const,
        source: m.source,
        reason: "MCP 延后至 Phase 5",
      })),
    ];

    return {
      skills: allSkills,
      guidance: allGuidance,
      agents: allAgents,
      deferred,
    };
  }

  // 查找 role
  const role = manifest.roles?.find((r) => r.name === roleName);
  if (!role) {
    throw new Error(`manifest 中未找到 role '${roleName}'`);
  }

  // 按 role reference 过滤 skill
  const roleSkillNames = new Set(role.skills ?? []);
  const skills = allSkills.filter((s) => roleSkillNames.has(s.name));

  // 校验所有引用的 skill 均存在
  for (const skillRef of role.skills ?? []) {
    if (!allSkills.some((s) => s.name === skillRef)) {
      throw new Error(`Role '${roleName}' 引用了不存在的 skill：'${skillRef}'`);
    }
  }

  // 按 role reference 过滤 guidance
  const roleGuidanceNames = new Set(role.guidance ?? []);
  const guidance = allGuidance.filter((g) => roleGuidanceNames.has(g.name));

  // 校验所有引用的 guidance 均存在
  for (const guidanceRef of role.guidance ?? []) {
    if (!allGuidance.some((g) => g.name === guidanceRef)) {
      throw new Error(`Role '${roleName}' 引用了不存在的 guidance：'${guidanceRef}'`);
    }
  }

  // 无论 role 如何，始终包含全部 agent
  const agents = allAgents;

  // hook：若 role 指定 hook，则只延后这些；否则全部延后
  const roleHookRefs = new Set(role.hooks ?? []);
  const deferred: DeferredExport[] = [];

  for (const hook of allHooks) {
    if (roleHookRefs.size === 0 || roleHookRefs.has(hook.source)) {
      deferred.push({
        exportType: "hook",
        source: hook.source,
        reason: "Hook 延后至 Phase 5",
      });
    }
  }

  // MCP 始终延后
  for (const mcp of allMcp) {
    deferred.push({
      exportType: "mcp",
      source: mcp.source,
      reason: "MCP 延后至 Phase 5",
    });
  }

  // 显式忽略 context（仅供人阅读的文档）

  return { skills, guidance, agents, deferred };
}
