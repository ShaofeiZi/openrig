import { Command } from "commander";
import { DaemonClient, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function unclaimCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("unclaim").description("释放已认领的会话，但不结束其 tmux 会话");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  cmd
    .argument("<sessionRef>", "已认领的会话 ID 或会话名")
    .option("--json", "以 JSON 输出")
    .addHelpText("after", `
说明：
  - 使用 zrig release <rigId> 可释放某个工作组下全部已认领的会话。
  - 取消认领会保留正在运行的会话，仅移除 zrig 对该节点的管理。`)
    .action(async (sessionRef: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) {
        process.exitCode = 1;
        return;
      }

      const res = await client.post<Record<string, unknown>>(`/api/sessions/${encodeURIComponent(sessionRef)}/unclaim`, {}, { headers: terminalAuthHeaders() });
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        console.error(res.data["error"] ?? `取消认领失败（HTTP ${res.status}）`);
        process.exitCode = 1;
        return;
      }

      console.log(`已释放工作组 ${res.data["rigId"]} 中 ${res.data["logicalId"]} 的已认领会话 ${res.data["sessionName"]}`);
    });

  return cmd;
}
