import { resolveAgentRef, type AgentResolverFsOps } from "./agent-resolver.js";
import type { PreflightResult } from "./types.js";

/**
 * 仅针对智能体的预检：解析 `agent_ref` 及其导入。
 * 不检查运行时；该字段以工作组预检中的成员声明为准。
 * @param agentRef `agent_ref` 字符串
 * @param rigRoot 工作组根目录
 * @param fsOps 文件系统操作
 * @returns 包含错误与警告的 `PreflightResult`
 */
export function agentPreflight(
  agentRef: string,
  rigRoot: string,
  fsOps: AgentResolverFsOps,
): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const result = resolveAgentRef(agentRef, rigRoot, fsOps);
  if (!result.ok) {
    if (result.code === "validation_failed") {
      errors.push(...(result as { errors: string[] }).errors);
    } else {
      errors.push((result as { error: string }).error);
    }
    return { ready: false, errors, warnings };
  }

  // 导入冲突仅作为警告，不会导致预检失败。
  for (const col of result.collisions) {
    if (col.sources.length >= 2) {
      const hasBase = col.sources.some((s) => s.qualifiedId === col.resourceId);
      if (hasBase) {
        warnings.push(`${col.category} 中存在基础资源/导入资源冲突："${col.resourceId}"。基础资源保留无限定 ID，导入资源可通过 ${col.sources.find((s) => s.qualifiedId !== col.resourceId)?.qualifiedId} 访问`);
      } else {
        warnings.push(`${col.category} 中存在导入资源之间的冲突："${col.resourceId}"。请使用限定 ID：${col.sources.map((s) => s.qualifiedId).join(", ")}`);
      }
    }
  }

  return { ready: errors.length === 0, errors, warnings };
}
