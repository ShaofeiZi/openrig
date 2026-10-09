import { Command } from "commander";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps , daemonStatusGuard} from "../daemon-lifecycle.js";
import { readOpenRigEnv } from "../openrig-compat.js";
import { realDeps } from "./daemon.js";

export interface UiDeps {
  lifecycleDeps: LifecycleDeps;
  exec: (cmd: string, args: string[]) => Promise<void>;
}

export const UI_MAINTENANCE_NOTICE =
  "zrig Web UI 仍为实验性且处于维护模式。它不在积极开发中，支持为尽力而为。CLI 是主要受支持的界面。欢迎贡献。";

export function uiCommand(depsOverride?: UiDeps): Command {
  const cmd = new Command("ui").description("UI 相关命令");
  const getDeps = (): UiDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    exec: async (cmd, args) => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      await promisify(execFile)(cmd, args);
    },
  };

  cmd
    .command("open")
    .description("在默认浏览器中打开 zrig Web UI")
    .action(async () => {
      console.error(UI_MAINTENANCE_NOTICE);
      const deps = getDeps();

      // 显式覆盖时完全跳过后台服务状态检查（配合 Vite 的开发流程）
      const overrideUrl = readOpenRigEnv("OPENRIG_UI_URL", "RIGGED_UI_URL")?.trim();
      if (overrideUrl) {
        console.log(overrideUrl);
        try {
          await deps.exec("open", [overrideUrl]);
        } catch {
          console.error("无法打开浏览器 —— 请手动打开该 URL");
          process.exitCode = 1;
        }
        return;
      }

      // 默认：从后台服务状态推导 UI URL（后台服务同时托管 UI）
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      const url = getDaemonUrl(status);
      console.log(url);

      try {
        await deps.exec("open", [url]);
      } catch {
        console.error("无法打开浏览器 —— 请手动打开该 URL");
        process.exitCode = 1;
      }
    });

  return cmd;
}
