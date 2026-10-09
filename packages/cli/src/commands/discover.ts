import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, printDaemonNotRunning } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function discoverCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("discover").description("扫描未纳管的 tmux 会话");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      printDaemonNotRunning();
      return null;
    }
    return deps.clientFactory(getDaemonUrl(status));
  }

  cmd
    .option("--json", "输出可解析的 JSON")
    .option("--draft", "根据发现的会话生成候选工作组规范")
    .action(async (opts: { json?: boolean; draft?: boolean }) => {
      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.post<{ sessions?: Array<Record<string, unknown>>; error?: string }>("/api/discovery/scan", {});

      if (res.status >= 400) {
        console.error(res.data.error ?? `扫描失败（HTTP ${res.status}）`);
        process.exitCode = 1;
        return;
      }

      if (opts.draft) {
        const draftRes = await client.postExpectText("/api/discovery/draft-rig", {});
        if (draftRes.status >= 400) {
          console.error(`草稿生成失败（HTTP ${draftRes.status}）。请先用以下命令扫描：zrig discover`);
          process.exitCode = 1;
          return;
        }
        console.log(draftRes.data);
        return;
      }

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        return;
      }

      const sessions = res.data.sessions ?? [];
      if (sessions.length === 0) {
        console.log("未发现未纳管的会话。");
        return;
      }

      console.log("发现的会话");
      for (const s of sessions) {
        const hint = String(s["runtimeHint"] ?? "未知").padEnd(12);
        const conf = String(s["confidence"] ?? "").padEnd(8);
        console.log(`  ${s["id"]}  ${hint} ${conf} ${s["tmuxSession"]}:${s["tmuxPane"]}  ${s["cwd"] ?? ""}`);
      }
    });

  return cmd;
}
