import { Command } from "commander";
import fs from "node:fs";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export interface ExportDeps extends StatusDeps {
  writeFile: (path: string, content: string) => void;
}

export function exportCommand(depsOverride?: ExportDeps): Command {
  const cmd = new Command("export").description("导出工作组规范为 YAML");
  const getDeps = (): ExportDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
    writeFile: (p, content) => fs.writeFileSync(p, content, "utf-8"),
  };

  cmd
    .argument("<rigId>", "要导出的工作组 ID")
    .option("-o, --output <path>", "输出文件路径", "rig.yaml")
    .action(async (rigId: string, opts: { output: string }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);

      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.getText(`/api/rigs/${encodeURIComponent(rigId)}/spec`);

      if (res.status === 404) {
        console.error(`工作组 '${rigId}' 未找到`);
        process.exitCode = 1;
      } else if (res.status >= 400) {
        console.error(`导出失败：${res.data}`);
        process.exitCode = 1;
      } else {
        deps.writeFile(opts.output, res.data);
        console.log(`已导出到 ${opts.output}`);
      }
    });

  return cmd;
}
