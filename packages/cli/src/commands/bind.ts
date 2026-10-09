import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function bindCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("bind").description("把发现的会话绑定到工作组节点（已有或新建）");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  cmd
    .argument("<discoveredId>", "发现的会话 ID")
    .requiredOption("--rig <rigId>", "目标工作组 ID")
    .option("--node <logicalId>", "绑定到已有逻辑节点")
    .option("--pod <namespace>", "在此 Pod 中新建节点（需要 --member）")
    .option("--member <name>", "新节点的成员名（需要 --pod）")
    .action(async (discoveredId: string, opts: { rig: string; node?: string; pod?: string; member?: string }) => {
      // 互斥模式校验
      const hasNode = !!opts.node;
      const hasPod = !!opts.pod || !!opts.member;

      if (hasNode && hasPod) {
        console.error("请指定 --node（绑定到已有节点）或 --pod + --member（在 Pod 中新建），二者不可同时使用。");
        process.exitCode = 1;
        return;
      }
      if (!hasNode && !hasPod) {
        console.error("请指定 --node <logicalId> 绑定到已有节点，或 --pod <namespace> --member <name> 在 Pod 中新建节点。");
        process.exitCode = 1;
        return;
      }
      if (hasPod && (!opts.pod || !opts.member)) {
        console.error("在 Pod 中新建节点时，--pod 与 --member 必须同时提供。");
        process.exitCode = 1;
        return;
      }

      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const body: Record<string, unknown> = { rigId: opts.rig };
      if (hasNode) {
        body["logicalId"] = opts.node;
      } else {
        body["podNamespace"] = opts.pod;
        body["memberName"] = opts.member;
      }

      const res = await client.post<Record<string, unknown>>(`/api/discovery/${encodeURIComponent(discoveredId)}/bind`, body);

      if (res.status >= 400) {
        console.error(res.data["error"] ?? `绑定失败（HTTP ${res.status}）`);
        process.exitCode = 1;
        return;
      }

      if (hasNode) {
        console.log(`已把发现项 ${discoveredId} 绑定到工作组 ${opts.rig} 的节点 ${opts.node}`);
      } else {
        console.log(`已创建节点 ${opts.pod}.${opts.member}，并在工作组 ${opts.rig} 中绑定发现项 ${discoveredId}`);
      }
    });

  return cmd;
}
