// 独立入口与裸 rig 前门共用同一条路径。共享入口把客户端挂到内核已有的终端上，
// 不另起第二个 TUI。
import { Command } from "commander";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { openMissionControl, USAGE_LINES, type FrontDoorIo } from "../front-door.js";
import { sharedTuiTarget, attachSharedTui } from "../shared-tui.js";

/** `rig tui commands` 序列化输出的注册表条目结构（REGISTRY I2，裁定 64f1dbdf）。
 *  是 TUI CommandEntry 数据字段的结构性镜像（函数不序列化）。 */
export interface TuiCommandEntry {
  name: string;
  aliases: string[];
  args: string;
  description: string;
  context: string;
  sample: string;
}

/** 默认加载器——解析 TUI 构建产物中的注册表模块（resolveTuiPath 遵循 monorepo
 *  优先/打包兜底模式），再动态 import。不启动 TUI 进程，也不新增包依赖边：
 *  以 dist 为准，与启动器一致。 */
async function loadRegistryFromDist(baseDir: string): Promise<TuiCommandEntry[]> {
  const cliBaseDir = path.basename(baseDir) === "commands" ? path.resolve(baseDir, "..") : baseDir;
  const candidates = [
    path.join(path.resolve(cliBaseDir, "../../tui"), "dist/commands/registry.js"),
    path.join(path.resolve(cliBaseDir, "../tui"), "dist/commands/registry.js"),
  ];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error("TUI 命令注册表未安装（本 CLI 旁边缺少 tui/dist/commands/registry.js）");
  const mod = (await import(pathToFileURL(found).href)) as { COMMAND_REGISTRY: TuiCommandEntry[] };
  // 只序列化数据契约——绝不手工维护（PM pin 2）。
  return mod.COMMAND_REGISTRY.map(({ name, aliases, args, description, context, sample }) => ({
    name, aliases, args, description, context, sample,
  }));
}

export function tuiCommand(io: FrontDoorIo & {
  loadRegistry?: () => Promise<TuiCommandEntry[]>;
  sharedTarget?: () => Promise<string>;
  attachShared?: (target: string) => Promise<number>;
} = {}): Command {
  const cmd = new Command("tui")
    .description("打开任务控制台（默认独立打开；--shared 加入内核终端）")
    .option("--shared", "加入内核已有的共享终端；用 Ctrl-b d 脱离")
    .addHelpText("after", "\n共享终端在你脱离后会保留视图。若内核版本较旧，或退出过 TUI，在该终端里运行一次 zrig tui 即可。--shared 不会启动任何智能体或终端。\nHerdr/cmux 用户也可通过 zrig terminal open kernel --provider herdr|cmux 打开内核。");

  cmd
    .command("commands")
    .description("列出全部 TUI 命令（来自唯一命令注册表的序列化结果；--json 供智能体使用）")
    .option("--json", "供智能体使用的 JSON 输出")
    .action(async (opts: { json?: boolean }) => {
      const load = io.loadRegistry ?? (() => loadRegistryFromDist(import.meta.dirname));
      const entries = await load();
      if (opts.json) {
        console.log(JSON.stringify(entries));
        return;
      }
      // 人类可读表格：name/aliases/args/description/context——context 列在每一行都渲染
      // （PM pin 3：如实展示可用性，并与 C3 检测状态组合）。
      const w1 = Math.max(...entries.map((e) => (e.name + " " + e.args).trim().length), 7);
      const w2 = Math.max(...entries.map((e) => e.aliases.join(",").length), 7);
      const w3 = Math.max(...entries.map((e) => e.context.length), 7);
      console.log(`${"命令".padEnd(w1)}  ${"别名".padEnd(w2)}  ${"上下文".padEnd(w3)}  描述`);
      for (const e of entries) {
        const cmdCol = (e.name + " " + e.args).trim();
        console.log(`${cmdCol.padEnd(w1)}  ${e.aliases.join(",").padEnd(w2)}  ${e.context.padEnd(w3)}  ${e.description}`);
      }
    });

  cmd
    .action(async (opts: { shared?: boolean }) => {
      const stdoutIsTTY = io.stdoutIsTTY ?? process.stdout.isTTY === true;
      if (!stdoutIsTTY || (opts.shared && !(io.stdinIsTTY ?? process.stdin.isTTY === true))) {
        // 与裸 rig 前门同样的 TTY 感知：降级处理，绝不把交互式 TUI
        // 启动到被重定向/管道化的 stdout。
        const err = io.err ?? ((l: string) => process.stderr.write(l + "\n"));
        const exit = io.exit ?? ((c: number) => process.exit(c));
        for (const line of USAGE_LINES) err(line);
        err("");
        err("任务控制台需要交互式终端（共享入口需要 TTY 输入输出）");
        exit(1);
        return;
      }
      if (opts.shared) {
        const err = io.err ?? ((line: string) => process.stderr.write(line + "\n"));
        const exit = io.exit ?? ((code: number) => process.exit(code));
        try {
          const target = await (io.sharedTarget ?? sharedTuiTarget)();
          err("正在加入内核终端。Ctrl-b d 脱离并保留视图；若看到的是 shell，请运行一次 zrig tui。");
          const code = await (io.attachShared ?? attachSharedTui)(target);
          if (code !== 0) err("无法挂载内核终端。请检查 zrig ps --nodes --rig kernel 与 zrig status；独立模式：zrig tui。");
          exit(code);
        } catch (error) {
          err(error instanceof Error ? error.message : String(error));
          exit(1);
        }
        return;
      }
      await openMissionControl(io);
    });

  return cmd;
}
