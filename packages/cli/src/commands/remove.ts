import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function removeCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("remove").description("从运行中的工作组移除一个节点");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  cmd
    .argument("<rigId>", "目标工作组 ID")
    .argument("<nodeRef>", "节点逻辑 ID 或节点 ID")
    .option("--fallback <live-seat>", "移除前把活跃队列项改路由到该运行中的席位")
    .option("--json", "JSON 输出")
    .action(async (rigId: string, nodeRef: string, opts: { fallback?: string; json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) {
        process.exitCode = 1;
        return;
      }

      const fallbackQuery = opts.fallback ? `?fallback=${encodeURIComponent(opts.fallback)}` : "";
      const res = await client.delete<Record<string, unknown>>(
        `/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(nodeRef)}${fallbackQuery}`,
      );
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      const reroutedQitemIds = Array.isArray(res.data["reroutedQitemIds"])
        ? res.data["reroutedQitemIds"] as string[]
        : [];
      if (reroutedQitemIds.length > 0 && typeof res.data["fallbackDestination"] === "string") {
        console.log(`已将 ${reroutedQitemIds.join(", ")} 改路由到 ${res.data["fallbackDestination"]}`);
      }

      if (res.status >= 400) {
        console.error(res.data["error"] ?? `移除失败（HTTP ${res.status}）`);
        process.exitCode = 1;
        return;
      }

      console.log(`已从工作组 ${res.data["rigId"]} 移除节点 ${res.data["logicalId"]}（结束 ${res.data["sessionsKilled"]} 个会话）`);
    });

  return cmd;
}
