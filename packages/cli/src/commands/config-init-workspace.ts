// 供 S05 实例初始化使用的 S01 项目工作区对外适配器。
// 具体实现与行为位于 @openrig/daemon。

import { Command } from "commander";
import {
  ensureDefaultWorkspace,
  workspaceScaffoldDirs,
  workspaceScaffoldFiles,
  type InitWorkspaceResult,
} from "@openrig/daemon/instance-initialization";
import { ConfigStore } from "../config-store.js";

export { workspaceScaffoldDirs, workspaceScaffoldFiles };
export type { InitWorkspaceResult };

export interface InitWorkspaceOpts {
  root?: string;
  /** 已废弃的兼容入参。已有文件始终会被保留。 */
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export function initWorkspaceCommand(configPath?: string): Command {
  const cmd = new Command("init-workspace")
    .description("脚手架化生成可直接入库的项目工作区")
    .option("--root <path>", "覆盖工作区根目录（默认取 workspace.root 配置）")
    .option("--force", "已废弃的兼容开关；已有文件仍会被保留")
    .option("--dry-run", "只展示将要创建的内容，不实际写入")
    .option("--json", "以 JSON 输出")
    .action((opts: InitWorkspaceOpts) => {
      try {
        const effectiveJson = opts.json ?? Boolean(cmd.optsWithGlobals().json);
        const result = runInitWorkspace({ ...opts, json: effectiveJson, configPath });
        if (effectiveJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          if (result.dryRun) console.log(`（试运行）工作区根目录：${result.root}`);
          else console.log(`工作区根目录：${result.root}`);
          for (const sub of result.subdirs) {
            console.log(`  ${sub.created ? "+" : " "} ${sub.name}/`);
          }
          for (const file of result.files) {
            console.log(`  ${file.created ? "+" : " "} ${file.relPath}${file.skipped ? `  （已跳过：${file.skipped}）` : ""}`);
          }
          if (result.dryRun) console.log("（试运行：未写入任何文件。）");
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });
  return cmd;
}

export function runInitWorkspace(opts: InitWorkspaceOpts & { configPath?: string }): InitWorkspaceResult {
  const store = new ConfigStore(opts.configPath);
  const root = opts.root ?? (store.get("workspace.root") as string);
  const result = ensureDefaultWorkspace({ root, dryRun: !!opts.dryRun });
  if (!result.ok) {
    const detail = result.conflicts
      .map((conflict) => `${conflict.path}：期望 ${conflict.expected}，实际为 ${conflict.actual}`)
      .join("; ");
    throw new Error(`工作区初始化被阻止：${detail}`);
  }
  return result;
}
