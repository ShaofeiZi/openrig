import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function releaseCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("release").description("释放工作组中已认领的会话，而不结束 tmux 会话");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  cmd
    .argument("<rigId>", "工作组标识")
    .option("--delete", "干净释放后删除工作组记录")
    .option("--json", "JSON 输出")
    .addHelpText("after", `
说明：
  - 用 zrig unclaim <sessionRef> 释放单个已认领会话。
  - release 仅覆盖已认领/已采纳的会话；由 zrig 启动的节点仍需 zrig down。`)
    .action(async (rigId: string, opts: { delete?: boolean; json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) {
        process.exitCode = 1;
        return;
      }

      const res = await client.post<Record<string, unknown>>(`/api/rigs/${encodeURIComponent(rigId)}/release`, {
        delete: opts.delete === true,
      });

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400 || res.status === 207) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const launched = Array.isArray(res.data["launchedLogicalIds"])
          ? (res.data["launchedLogicalIds"] as unknown[]).filter((value): value is string => typeof value === "string")
          : [];
        console.error(res.data["error"] ?? `释放失败（HTTP ${res.status}）`);
        if (launched.length > 0) {
          console.error(`已启动的节点：${launched.join(", ")}`);
        }
        process.exitCode = 1;
        return;
      }

      const released = Array.isArray(res.data["released"]) ? res.data["released"] as Array<Record<string, unknown>> : [];
      const failed = Array.isArray(res.data["failed"]) ? res.data["failed"] as Array<Record<string, unknown>> : [];
      const status = res.data["status"];

      if (status === "partial") {
        console.error(`仅从工作组 ${rigId} 部分释放了 ${released.length} 个已认领会话`);
        for (const entry of failed) {
          console.error(`  ${entry["logicalId"]}：${entry["error"]}`);
        }
        process.exitCode = 1;
        return;
      }

      console.log(`已从工作组 ${rigId} 释放 ${released.length} 个已认领会话${opts.delete ? "，并删除了工作组记录" : ""}`);
      for (const entry of released) {
        console.log(`  ${entry["logicalId"]} <- ${entry["sessionName"]}`);
      }
    });

  return cmd;
}
