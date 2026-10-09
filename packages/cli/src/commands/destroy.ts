import { Command } from "commander";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ConfigStore } from "../config-store.js";
import { realDeps } from "./daemon.js";
import { getDefaultOpenRigPath, getPreferredOpenRigHome, readOpenRigEnv } from "../openrig-compat.js";
import {
  DESTROY_CONFIRM_TOKEN,
  buildDestroyPlan,
  executeDestroy,
  findListeningPidWithLsof,
  killTmuxSessionWithCli,
  listManagedTmuxSessionsFromDb,
  type DestroyDeps,
  type ListenerInspection,
  type DestroyRuntimeConfig,
  type DestroyScope,
} from "../destroy-helpers.js";
import { stopDaemon } from "../daemon-lifecycle.js";

export interface DestroyCommandDeps {
  configStore: Pick<ConfigStore, "resolve">;
  destroyDeps: DestroyDeps;
}

interface ResolvedDestroyRuntime {
  runtimeConfig: DestroyRuntimeConfig;
  warnings: string[];
}

function resolveRuntimeConfig(configStore: Pick<ConfigStore, "resolve">): ResolvedDestroyRuntime {
  const warnings: string[] = [];
  const stateRoot = getPreferredOpenRigHome();
  const defaultDbPath = getDefaultOpenRigPath("openrig.sqlite");
  const defaultTranscriptsPath = getDefaultOpenRigPath("transcripts");
  const effectiveDefaultDbPath = join(stateRoot, "openrig.sqlite");
  const effectiveDefaultTranscriptsPath = join(stateRoot, "transcripts");
  const overrideUrl = readOpenRigEnv("OPENRIG_URL", "RIGGED_URL")?.trim();
  if (overrideUrl) {
    warnings.push(`已忽略来自 OPENRIG_URL/RIGGED_URL 的 ${overrideUrl}：rig destroy 只操作本地状态。`);
  }

  try {
    const config = configStore.resolve();
    return {
      runtimeConfig: {
        stateRoot,
        dbPath: config.db.path === defaultDbPath ? effectiveDefaultDbPath : config.db.path,
        transcriptsPath: config.transcripts.path === defaultTranscriptsPath ? effectiveDefaultTranscriptsPath : config.transcripts.path,
        daemonHost: config.daemon.host,
        daemonPort: config.daemon.port,
      },
      warnings,
    };
  } catch (err) {
    warnings.push(`读取配置失败；改用兼容默认值：${err instanceof Error ? err.message : String(err)}`);
    return {
      runtimeConfig: {
        stateRoot,
        dbPath: effectiveDefaultDbPath,
        transcriptsPath: effectiveDefaultTranscriptsPath,
        daemonHost: "127.0.0.1",
        daemonPort: 7433,
      },
      warnings,
    };
  }
}

function realDestroyDeps(): DestroyDeps {
  const lifecycleDeps = realDeps();
  return {
    stopDaemon: async () => { await stopDaemon(lifecycleDeps); },
    inspectListener: async (host: string, port: number): Promise<ListenerInspection> => {
      try {
        const res = await fetch(`http://${host}:${port}/healthz`);
        if (!res.ok) {
          return {
            kind: "other_http",
            healthy: false,
            detail: `HTTP ${res.status}`,
          };
        }

        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          return {
            kind: "other_http",
            healthy: false,
            detail: "响应体不是有效的 zrig 健康 JSON。",
          };
        }

        if (body && typeof body === "object" && (body as Record<string, unknown>).status === "ok") {
          return { kind: "openrig", healthy: true };
        }

        return {
          kind: "other_http",
          healthy: false,
          detail: "响应体不符合 zrig 健康契约。",
        };
      } catch {
        return { kind: "unreachable" };
      }
    },
    findListeningPid: findListeningPidWithLsof,
    killProcess: (pid: number) => {
      process.kill(pid, "SIGTERM");
    },
    exists: existsSync,
    renamePath: (from: string, to: string) => renameSync(from, to),
    removePath: (targetPath: string) => rmSync(targetPath, { recursive: true, force: true }),
    mkdirp: (targetPath: string) => mkdirSync(targetPath, { recursive: true }),
    listManagedTmuxSessions: listManagedTmuxSessionsFromDb,
    killTmuxSession: killTmuxSessionWithCli,
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
  };
}

function printPlan(
  scope: DestroyScope,
  backup: boolean,
  runtimeConfig: DestroyRuntimeConfig,
  managedTmuxSessions: string[],
  warnings: string[]
): void {
  console.log("销毁计划");
  console.log(`  范围：${scope}`);
  console.log(`  状态根目录：${runtimeConfig.stateRoot}`);
  console.log(`  后台服务：http://${runtimeConfig.daemonHost}:${runtimeConfig.daemonPort}`);
  console.log(`  备份：${backup ? "已启用" : "已禁用"}`);
  console.log(`  tmux 清理：${scope === "all" ? `已启用（${managedTmuxSessions.length} 个受管会话）` : "已禁用"}`);
  for (const warning of warnings) {
    console.log(`  警告：${warning}`);
  }
  console.log("");
}

function printResult(result: Awaited<ReturnType<typeof executeDestroy>>): void {
  console.log("销毁结果");
  console.log(`  后台服务：${result.daemonStopped ? "已停止" : "仍在响应"}`);
  console.log(`  端口：${result.portCleared ? "已释放" : "仍被占用"}`);
  if (result.scope === "all") {
    console.log(`  已移除的 tmux 会话：${result.tmuxKilled}`);
    if (result.tmuxMissing > 0) {
      console.log(`  缺失/已不存在的 tmux 会话：${result.tmuxMissing}`);
    }
  }
  if (result.backupPaths.length > 0) {
    for (const backupPath of result.backupPaths) {
      console.log(`  备份：${backupPath}`);
    }
  } else if (result.backup) {
    console.log("  备份：无内容可移动");
  }
  console.log(result.stateRecreated ? `  新状态根目录：${result.stateRoot}` : "  新状态根目录：未创建（状态未改动）");
  for (const warning of result.warnings) {
    console.log(`  警告：${warning}`);
  }
}

export function destroyCommand(depsOverride?: DestroyCommandDeps): Command {
  const cmd = new Command("destroy").description("销毁 zrig 本地状态以进行恢复");

  cmd
    .option("--state", "销毁 zrig 状态并重建空的状态根目录")
    .option("--all", "销毁 zrig 状态并移除受管 tmux 会话")
    .option("--backup", "把状态移走而不是删除")
    .option("--yes", "确认执行该破坏性操作")
    .option("--confirm <token>", `精确确认令牌：${DESTROY_CONFIRM_TOKEN}`)
    .action(async (opts: { state?: boolean; all?: boolean; backup?: boolean; yes?: boolean; confirm?: string }) => {
      const selectedScopes = [opts.state ? "state" : null, opts.all ? "all" : null].filter(Boolean) as DestroyScope[];
      if (selectedScopes.length !== 1) {
        console.error("只能指定一个销毁范围：--state 或 --all");
        process.exitCode = 1;
        return;
      }
      if (!opts.yes) {
        console.error("销毁操作需要 --yes");
        process.exitCode = 1;
        return;
      }
      if (opts.confirm !== DESTROY_CONFIRM_TOKEN) {
        console.error(`销毁操作需要：--confirm ${DESTROY_CONFIRM_TOKEN}`);
        process.exitCode = 1;
        return;
      }

      const deps = depsOverride ?? {
        configStore: new ConfigStore(),
        destroyDeps: realDestroyDeps(),
      };

      const { runtimeConfig, warnings } = resolveRuntimeConfig(deps.configStore);
      const plan = buildDestroyPlan(selectedScopes[0]!, Boolean(opts.backup), runtimeConfig, deps.destroyDeps);
      printPlan(plan.scope, plan.backup, runtimeConfig, plan.managedTmuxSessions, [...warnings, ...plan.warnings]);
      plan.warnings = [...warnings, ...plan.warnings];
      const result = await executeDestroy(plan, deps.destroyDeps);
      printResult(result);
      if (!result.portCleared) {
        process.exitCode = 1;
      }
    });

  return cmd;
}
