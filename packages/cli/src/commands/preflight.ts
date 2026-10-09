import { Command } from "commander";
import { SystemPreflight } from "../system-preflight.js";
import { ConfigStore } from "../config-store.js";
import { getDaemonStatus, type DaemonStatus } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";

interface PreflightCommandDeps {
  exec?: (cmd: string) => Promise<string>;
  configPath?: string;
  riggedHome?: string;
  getDaemonStatus?: () => Promise<DaemonStatus>;
}

export function preflightCommand(depsOverride?: PreflightCommandDeps): Command {
  const cmd = new Command("preflight").description("检查本机是否满足运行 zrig 的条件");

  cmd
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (opts: { json?: boolean }) => {
      const configStore = new ConfigStore(depsOverride?.configPath);
      const config = configStore.resolve();

      const exec = depsOverride?.exec ?? (async (c: string) => {
        const { execSync } = await import("node:child_process");
        return execSync(c, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      });

      const preflight = new SystemPreflight({
        exec,
        configStore,
        getDaemonStatus: depsOverride?.getDaemonStatus ?? (() => getDaemonStatus(realDeps())),
        riggedHome: depsOverride?.riggedHome ?? config.db.path.replace(/\/[^/]+$/, ""),
      });

      const result = await preflight.run();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        if (!result.ready) process.exitCode = 1;
        return;
      }

      for (const check of result.checks) {
        if (check.ok) {
          console.log(`✓ ${check.name}`);
          if (check.warning) console.log(`  注意：${check.warning}`);
        } else {
          console.log(`✗ ${check.name}：${check.error}`);
          if (check.reason) console.log(`  原因：${check.reason}`);
          if (check.fix) console.log(`  修复：${check.fix}`);
        }
      }

      if (result.ready) {
        console.log("\n全部检查通过。可以开始运行。");
      } else {
        const failCount = result.checks.filter((c) => !c.ok).length;
        console.log(`\n${failCount} 项检查未通过。请修复上述问题后重新运行 zrig preflight。`);
        process.exitCode = 1;
      }
    });

  return cmd;
}
