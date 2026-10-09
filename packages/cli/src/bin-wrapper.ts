#!/usr/bin/env node

import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// 防止“切换解释器后再次切换”的无限重入循环：已重入过一次就不再重入。
const REEXEC_GUARD_ENV = "OPENRIG_BIN_REEXEC";
// 调用身份透传环境变量：npm 会为同一个包装器创建 rig / zrig / openrig 三个符号链接，
// 这里按被调用的链接名把品牌名（zrig 等）告知上层程序，仅用于帮助/版本的展示，
// 不改变任何协议、数据或子命令行为。
const INVOKED_AS_ENV = "OPENRIG_INVOKED_AS";

export function resolveBinEntry(invokedPath = process.argv[1], moduleUrl = import.meta.url): string {
  const wrapperPath = invokedPath ? realpathSync(invokedPath) : realpathSync(fileURLToPath(moduleUrl));
  // 包装器位于包根的 dist/ 下，真正的程序入口就是同目录上一级的 dist/index.js。
  const packageRoot = path.resolve(path.dirname(wrapperPath), "..");
  return path.join(packageRoot, "dist", "index.js");
}

export function isDirectRun(argv1 = process.argv[1], moduleUrl = import.meta.url): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

// 记录本次是通过哪个可执行名被调用的（rig / zrig / openrig），供上层以对应品牌渲染帮助。
// 若调用方（例如仓库根的 zrig 包装脚本）已显式设置，则尊重既有值，不覆盖。
function exportInvokedAs(argv1 = process.argv[1]): void {
  if (process.env[INVOKED_AS_ENV]) return;
  if (!argv1) return;
  const base = path.basename(argv1);
  if (base) process.env[INVOKED_AS_ENV] = base;
}

export function resolveNodeReexecBinary(
  currentExecPath = process.execPath,
  invokedPath = process.argv[1],
  env: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = existsSync,
  realpath: (candidate: string) => string = realpathSync,
): string | null {
  if (!invokedPath) return null;
  if (env[REEXEC_GUARD_ENV] === "1") return null;

  try {
    // 安装布局里同目录常附带一个 node 运行时（例如便携版发行）。
    const binDir = realpath(path.dirname(invokedPath));
    const siblingNode = path.join(binDir, process.platform === "win32" ? "node.exe" : "node");
    if (!exists(siblingNode)) return null;

    const normalizedSiblingNode = realpath(siblingNode);
    const normalizedCurrentExec = realpath(currentExecPath);
    if (normalizedSiblingNode === normalizedCurrentExec) return null;

    return normalizedSiblingNode;
  } catch {
    return null;
  }
}

function maybeReexecWithSiblingNode(argv = process.argv): void {
  const preferredNode = resolveNodeReexecBinary(process.execPath, argv[1], process.env);
  if (!preferredNode) return;

  const scriptPath = argv[1] ? realpathSync(argv[1]) : fileURLToPath(import.meta.url);
  // 符号链接本身不具备运行权威性。只有当目标解释器真能加载已安装的原生依赖时才切换，
  // 否则保持当前可用的解释器继续运行。
  if (canLoadInstalledNative(process.execPath, scriptPath)) return;
  if (!canLoadInstalledNative(preferredNode, scriptPath)) return;
  const result = spawnSync(preferredNode, [scriptPath, ...argv.slice(2)], {
    stdio: "inherit",
    env: {
      ...process.env,
      [REEXEC_GUARD_ENV]: "1",
    },
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 0);
}

export function canLoadInstalledNative(node: string, wrapper: string): boolean {
  // 在子进程里探测 better-sqlite3 能否在该 Node 下打开一个内存库，避免主进程直接崩溃。
  const probe = spawnSync(node, ["--input-type=module", "-e",
    "import {createRequire} from 'node:module'; const require=createRequire(process.argv[1]); const D=require('better-sqlite3'); new D(':memory:').close();",
    wrapper,
  ], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
  return probe.status === 0;
}

export async function run(argv = process.argv): Promise<void> {
  const normalizedArgv = [...argv];
  if (normalizedArgv[1]) {
    normalizedArgv[1] = realpathSync(normalizedArgv[1]);
  }

  const entryUrl = pathToFileURL(resolveBinEntry(normalizedArgv[1], import.meta.url)).href;
  const mod = await import(entryUrl) as {
    createProgram: () => import("commander").Command;
    runProgram: (program: import("commander").Command, argv: string[]) => Promise<number>;
    runFrontDoor?: (argv: readonly string[]) => Promise<boolean>;
  };
  // Slice 17：对外的 bin 才是真正的入口——在终端里直接敲 `rig`（或 zrig）应当打开 TUI，
  // 而不只是在 `node dist/index.js` 直接运行时才打开（对应防护发现 1：被 import 时
  // isDirectRun 为 false）。用特性探测调用，让包装器仍能跑旧版同级入口。
  const owned = mod.runFrontDoor ? await mod.runFrontDoor(normalizedArgv) : false;
  if (owned) return;
  // Slice 15：走统一的错误出口，这样 `--json` 失败时输出 JSON 错误对象并不退化为
  // Commander 的纯文本。
  await mod.runProgram(mod.createProgram(), normalizedArgv);
}

if (isDirectRun()) {
  // 先记录调用品牌名（zrig / rig / openrig），再决定是否切换解释器并运行主程序。
  exportInvokedAs(process.argv[1]);
  maybeReexecWithSiblingNode(process.argv);
  await run(process.argv);
}
