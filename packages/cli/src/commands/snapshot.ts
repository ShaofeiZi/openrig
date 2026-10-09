import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function snapshotCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("snapshot").description("管理工作组快照");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  // zrig snapshot <rigId> — 默认动作为创建快照
  cmd
    .argument("<rigId>", "要创建快照的工作组 ID")
    .option("--intended-seats <ids>", "随快照保存的预期拓扑席位名单，逗号分隔")
    .action(async (rigId: string, opts: { intendedSeats?: string }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const intendedSeats = opts.intendedSeats?.split(",").map((seat) => seat.trim()).filter(Boolean);
      const res = await client.post<{ id: string }>(
        `/api/rigs/${encodeURIComponent(rigId)}/snapshots`,
        intendedSeats ? { intendedSeats } : undefined,
      );
      if (res.status === 404) {
        console.error(`未找到工作组 '${rigId}'`);
        process.exitCode = 1;
      } else if (res.status >= 400) {
        console.error(`快照创建失败：${(res.data as { error?: string }).error ?? "未知错误"}`);
        process.exitCode = 1;
      } else {
        console.log(`快照已创建：${res.data.id}`);
        console.log(`恢复命令：zrig restore ${res.data.id} --rig ${rigId}`);
      }
    });

  // zrig snapshot list <rigId>
  cmd
    .command("list <rigId>")
    .description("列出某个工作组的快照")
    .action(async (rigId: string) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.get<Array<{ id: string; kind: string; status: string; createdAt: string }>>(`/api/rigs/${encodeURIComponent(rigId)}/snapshots`);
      if (res.status >= 400) {
        console.error(`快照列表获取失败：${(res.data as { error?: string }).error ?? "未知错误"}`);
        process.exitCode = 1;
        return;
      }

      const snapshots = res.data;
      if (snapshots.length === 0) {
        console.log("暂无快照");
        return;
      }

      console.log("ID                         类型      状态        创建时间");
      for (const snap of snapshots) {
        console.log(`${snap.id.padEnd(27)} ${snap.kind.padEnd(8)} ${snap.status.padEnd(10)} ${snap.createdAt}`);
      }
    });

  return cmd;
}
