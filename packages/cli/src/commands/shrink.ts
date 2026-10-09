import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

type ShrinkResponse = {
  ok: boolean;
  status?: "ok" | "partial";
  rigId?: string;
  podId?: string;
  namespace?: string;
  removedLogicalIds?: string[];
  sessionsKilled?: number;
  fallbackDestination?: string;
  reroutedQitemIds?: string[];
  nodes?: Array<{
    logicalId: string;
    nodeId: string;
    status: "removed" | "failed";
    sessionsKilled: number;
    error?: string;
  }>;
  error?: string;
};

export function shrinkCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("shrink").description("从运行中的工作组移除整个 Pod");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  cmd
    .argument("<rigId>", "目标工作组 ID")
    .argument("<podRef>", "Pod 命名空间或 Pod ID")
    .option("--fallback <live-seat>", "移除 Pod 前把活跃队列项改路由到该运行中的席位")
    .option("--json", "JSON 输出")
    .action(async (rigId: string, podRef: string, opts: { fallback?: string; json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) {
        process.exitCode = 1;
        return;
      }

      const fallbackQuery = opts.fallback ? `?fallback=${encodeURIComponent(opts.fallback)}` : "";
      const res = await client.delete<ShrinkResponse>(
        `/api/rigs/${encodeURIComponent(rigId)}/pods/${encodeURIComponent(podRef)}${fallbackQuery}`,
      );
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400 || (res.data.ok && res.data.status !== "ok")) process.exitCode = 1;
        return;
      }

      if ((res.data.reroutedQitemIds?.length ?? 0) > 0 && res.data.fallbackDestination) {
        console.log(`已将 ${res.data.reroutedQitemIds!.join(", ")} 改路由到 ${res.data.fallbackDestination}`);
      }

      if (res.status >= 400) {
        console.error(res.data["error"] ?? `收缩失败（HTTP ${res.status}）`);
        process.exitCode = 1;
        return;
      }

      if (res.data.status === "partial") {
        console.log(
          `已从工作组 ${res.data.rigId} 部分移除 Pod ${res.data.namespace}（${res.data.removedLogicalIds?.length ?? 0} 个节点，结束 ${res.data.sessionsKilled} 个会话）`
        );
        for (const node of res.data.nodes ?? []) {
          const icon = node.status === "removed" ? "OK" : "FAIL";
          const error = node.error ? ` — ${node.error}` : "";
          console.log(`  [${icon}] ${node.logicalId}${error}`);
        }
        process.exitCode = 1;
        return;
      }

      console.log(
        `已从工作组 ${res.data.rigId} 移除 Pod ${res.data.namespace}（${res.data.removedLogicalIds?.length ?? 0} 个节点，结束 ${res.data.sessionsKilled} 个会话）`
      );
    });

  return cmd;
}
