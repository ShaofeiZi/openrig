import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function requirementsCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("requirements").description("检查工作组规范的依赖要求");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  cmd
    .argument("<spec>", "工作组规范 YAML 文件路径")
    .option("--json", "输出可解析的 JSON")
    .action(async (spec: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.post<Record<string, unknown>>("/api/bootstrap/plan", { sourceRef: spec });

      if (res.status >= 500) {
        console.error(res.data["errors"] ?? res.data["error"] ?? "检查依赖要求失败");
        process.exitCode = 2;
        return;
      }

      const stages = (res.data["stages"] as Array<{ stage: string; status: string; detail: unknown }>) ?? [];
      const reqStage = stages.find((s) => s.stage === "probe_requirements");
      const planStage = stages.find((s) => s.stage === "build_install_plan");
      const detail = reqStage?.detail as { probed: number; results?: Array<{ name: string; kind: string; status: string; detectedPath: string | null }> } | undefined;

      if (opts.json) {
        const results = detail?.results ?? [];
        const allMet = results.length === 0 || results.every((r) => r.status === "installed");
        console.log(JSON.stringify({ requirements: reqStage?.detail, installPlan: planStage?.detail }));
        if (!allMet) process.exitCode = 1;
        return;
      }

      if (!detail?.results || detail.results.length === 0) {
        console.log("未声明任何依赖要求。");
        return;
      }

      console.log("依赖要求");
      let allMet = true;
      for (const r of detail.results) {
        const statusIcon = r.status === "installed" ? "OK" : r.status === "missing" ? "缺失" : r.status.toUpperCase();
        console.log(`  ${statusIcon.padEnd(12)} ${r.kind.padEnd(16)} ${r.name}${r.detectedPath ? ` (${r.detectedPath})` : ""}`);
        if (r.status !== "installed") allMet = false;
      }

      if (allMet) {
        console.log("\n所有依赖要求均已满足。");
      } else {
        console.log("\n部分依赖要求未满足。");
        process.exitCode = 1;
      }
    });

  return cmd;
}
