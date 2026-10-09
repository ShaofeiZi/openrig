import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

const LONG_RUNNING_TIMEOUT_MS = 45_000;

export function envCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("env")
    .description("查看并控制服务型工作组的环境服务与受管应用")
    .addHelpText("after", `
示例：
  zrig env status secrets-manager
  zrig env logs secrets-manager vault
  zrig env down secrets-manager
`);
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  async function resolveRigId(client: DaemonClient, rigRef: string): Promise<string> {
    const summaries = await client.get<Array<{ id: string; name: string }>>("/api/rigs/summary");
    const match = summaries.data.find((r) => r.name === rigRef || r.id === rigRef);
    if (!match) throw new Error(`未找到工作组 '${rigRef}'`);
    return match.id;
  }

  // zrig env status <rig>
  cmd
    .command("status")
    .argument("<rig>", "工作组名或 ID")
    .option("--json", "以 JSON 输出")
    .action(async (rig: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      let rigId: string;
      try { rigId = await resolveRigId(client, rig); } catch (err) {
        console.error((err as Error).message); process.exitCode = 1; return;
      }

      const res = await client.get<Record<string, unknown>>(`/api/rigs/${encodeURIComponent(rigId)}/env`);

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        return;
      }

      if (!res.data["hasServices"]) {
        console.log("该工作组未配置任何服务。");
        return;
      }

      const receipt = res.data["receipt"] as Record<string, unknown> | null;
      if (!receipt) {
        console.log("已配置服务，但回执尚未生成。");
        return;
      }

      console.log(`环境：${res.data["kind"]}（${res.data["projectName"]}）`);
      const services = receipt["services"] as Array<{ name: string; status: string; health?: string | null }>;
      if (services) {
        for (const svc of services) {
          const health = svc.health ? `（${svc.health}）` : "";
          console.log(`  ${svc.name}：${svc.status}${health}`);
        }
      }
    });

  // zrig env logs <rig> [service]
  cmd
    .command("logs")
    .argument("<rig>", "工作组名或 ID")
    .argument("[service]", "指定服务名")
    .option("--tail <n>", "显示行数", "100")
    .action(async (rig: string, service: string | undefined, opts: { tail: string }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      let rigId: string;
      try { rigId = await resolveRigId(client, rig); } catch (err) {
        console.error((err as Error).message); process.exitCode = 1; return;
      }

      const params = new URLSearchParams({ tail: opts.tail });
      if (service) params.set("service", service);

      const res = await client.get<{ ok: boolean; output?: string; error?: string }>(
        `/api/rigs/${encodeURIComponent(rigId)}/env/logs?${params}`,
      );

      if (res.status >= 400 || !res.data.ok) {
        console.error(res.data.error ?? `日志获取失败（HTTP ${res.status}）`);
        process.exitCode = 1;
        return;
      }

      console.log(res.data.output ?? "");
    });

  // zrig env down <rig> [--volumes]
  cmd
    .command("down")
    .argument("<rig>", "工作组名或 ID")
    .option("--volumes", "同时删除数据卷")
    .action(async (rig: string, opts: { volumes?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      let rigId: string;
      try { rigId = await resolveRigId(client, rig); } catch (err) {
        console.error((err as Error).message); process.exitCode = 1; return;
      }

      const res = await client.post<{ ok: boolean; error?: string }>(
        `/api/rigs/${encodeURIComponent(rigId)}/env/down`,
        { volumes: opts.volumes ?? false },
        { timeoutMs: LONG_RUNNING_TIMEOUT_MS },
      );

      if (res.status >= 400 || !res.data.ok) {
        console.error(res.data.error ?? `服务停止失败（HTTP ${res.status}）`);
        process.exitCode = 1;
        return;
      }

      console.log(`已停止 ${rig} 的服务。`);
    });

  return cmd;
}
