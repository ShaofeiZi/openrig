export interface DemoRigSummaryLike {
  rigId: string;
  name: string;
  status?: string;
}

export interface DemoNodeLike {
  rigId: string;
}

export function selectCurrentRigSummary<T extends DemoRigSummaryLike>(
  rigs: T[],
  rigName: string
): T | null {
  const matches = rigs.filter((entry) => entry.name === rigName);
  if (matches.length === 0) {
    return null;
  }
  const runningMatches = matches.filter((entry) => entry.status === "running");
  if (runningMatches.length === 1) {
    return runningMatches[0] ?? null;
  }
  if (runningMatches.length > 1) {
    throw new Error(
      `Rig '${rigName}' 存在歧义——有 ${runningMatches.length} 个运行中的 rig 使用该名称。`
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Rig '${rigName}' 存在歧义——有 ${matches.length} 个已停止的 rig 使用该名称，且没有同名 rig 正在运行。`
    );
  }
  return matches[0] ?? null;
}

export function filterNodesForRigId<T extends DemoNodeLike>(
  nodes: T[],
  rigId: string
): T[] {
  return nodes.filter((entry) => entry.rigId === rigId);
}
