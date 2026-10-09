import { Command } from "commander";
import fs from "node:fs";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export interface AgentDeps extends StatusDeps {
  readFile: (path: string) => string;
}

/** 从 YAML 文本中提取顶层标量值（简单的逐行解析实现）。 */
function yamlScalar(text: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const m = text.match(re);
  return m?.[1]?.replace(/^["']|["']$/g, "").trim();
}

export function agentCommand(depsOverride?: AgentDeps): Command {
  const cmd = new Command("agent").description("管理智能体规格（agent spec）");
  const getDeps = (): AgentDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
  };

  cmd
    .command("validate <path>")
    .description("校验智能体规格文件（agent.yaml）")
    .option("--json", "以 JSON 输出")
    .action(async (filePath: string, opts: { json?: boolean }) => {
      const deps = getDeps();

      let yaml: string;
      try {
        yaml = deps.readFile(filePath);
      } catch {
        console.error(`无法读取文件：${filePath}`);
        process.exitCode = 1;
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));

      const res = await client.postText<{ valid?: boolean; errors?: string[] }>("/api/agents/validate", yaml);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400 || !res.data.valid) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const data = res.data;
        if (data.errors && data.errors.length > 0) {
          console.error(`智能体规格校验未通过：\n${data.errors.map((e) => `  ${e}`).join("\n")}\n请更新 ${filePath} 后重新校验。`);
        } else {
          console.error(`校验请求失败（HTTP ${res.status}）。请检查 agent.yaml 语法。`);
        }
        process.exitCode = 1;
        return;
      }

      const data = res.data;
      if (data.valid) {
        const name = yamlScalar(yaml, "name") ?? "unknown";
        const version = yamlScalar(yaml, "version") ?? "unknown";
        console.log(`智能体规格校验通过：${name} v${version}`);
      } else {
        if (data.errors && data.errors.length > 0) {
          console.error(`智能体规格校验未通过：\n${data.errors.map((e) => `  ${e}`).join("\n")}\n请更新 ${filePath} 后重新校验。`);
        }
        process.exitCode = 1;
      }
    });

  return cmd;
}
