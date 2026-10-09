import { Command } from "commander";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { acquireDaemonStartLock } from "../daemon-start-lock.js";
import { execFileSync, spawn } from "node:child_process";
import { fetchWithTimeout } from "../fetch-with-timeout.js";
import {
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  readLogs,
  tailLogs,
  type LifecycleDeps,
  OPENRIG_DIR,
  STATE_FILE,
  resolveBindIntent,
} from "../daemon-lifecycle.js";

interface ProcessAliveDeps {
  signalCheck: (pid: number) => boolean;
  readProcessState: (pid: number) => string | null;
}

export function createIsProcessAlive(deps: ProcessAliveDeps): (pid: number) => boolean {
  return (pid: number) => {
    if (!deps.signalCheck(pid)) return false;

    const state = deps.readProcessState(pid)?.trim();
    if (!state) return false;
    if (state.startsWith("Z")) return false;
    return true;
  };
}

export function realDeps(): LifecycleDeps {
  const isProcessAlive = createIsProcessAlive({
    signalCheck: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    readProcessState: (pid) => {
      try {
        return execFileSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf-8" });
      } catch {
        return null;
      }
    },
  });

  return {
    acquireStartLock: () => acquireDaemonStartLock(OPENRIG_DIR),
    spawn: (cmd, args, opts) => spawn(cmd, args, opts as Parameters<typeof spawn>[2]),
    fetch: async (url) => {
      const res = await fetchWithTimeout(globalThis.fetch, url, {}, {
        timeoutMs: 1_500,
        timeoutMessage: `后台服务健康探测超时：${url}`,
      });
      // OPR.0.4.3.21 —— 暴露 json()，使 getDaemonStatus 能读取更丰富的
      // /healthz 事件循环证据。绑定到本 Response 实例。
      return { ok: res.ok, json: () => res.json() };
    },
    kill: (pid, signal) => { process.kill(pid, signal as NodeJS.Signals); return true; },
    readFile: (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } },
    writeFile: (p, content) => {
      if (p !== STATE_FILE) { fs.writeFileSync(p, content, "utf-8"); return; }
      const temporary = `${p}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, content, { encoding: "utf-8", flag: "wx" });
        fs.renameSync(temporary, p);
      } finally {
        try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    },
    removeFile: (p) => { try { fs.unlinkSync(p); } catch { /* ignore */ } },
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    pathKind: (p) => {
      try {
        const value = fs.lstatSync(p);
        if (value.isDirectory()) return "directory";
        if (value.isFile()) return "file";
        return "other";
      } catch {
        return "missing";
      }
    },
    openForAppend: (p) => fs.openSync(p, "a"),
    closeFile: (fd) => fs.closeSync(fd),
    isProcessAlive,
    // RULING 1ae863d2 —— 兄弟 home 扫描（home 解析诚实性）。
    listDir: (p) => { try { return fs.readdirSync(p); } catch { return []; } },
  };
}

export function daemonCommand(depsOverride?: LifecycleDeps): Command {
  const getDeps = () => depsOverride ?? realDeps();
  const cmd = new Command("daemon").description("管理 zrig 后台服务");

  cmd
    .command("start")
    .description("启动后台服务")
    .addHelpText("after", "\n启动会在初始化前预留本本地实例，并在每个必需监听器上校验派生出的子进程 PID。\n身份缺失/不匹配或子进程退出都会使启动失败；发布失败只撤回本次启动对应的状态。请使用配套的 CLI/后台服务安装。\n并发启动不会再派生另一个子进程而失败。启动中断后可查看 daemon-start.lock 了解启动器/子进程 PID；\n只有在证明两个进程都已不存在后，才可归档被遗弃的预留。清理失败会保留它并报告子进程 PID。\n")
    .option("--port <port>", "监听端口")
    .option("--host <host>", "绑定主机")
    .option("--db <path>", "数据库路径")
    // V0.3.1 slice 05 kernel-rig-as-default —— 跳过内核自动引导
    // 路径。供测试夹具、无头 CI，以及只想要无内核后台服务做临时
    // 拓扑工作的操作者使用。后台服务照常启动并提供 HTTP API；
    // 只是不物化内核工作组。
    .option("--no-kernel", "跳过内核自动引导（后台服务在无内核工作组下提供服务）")
    // V0.3.1 slice 05 kernel-rig-as-default —— 前瞻性修复 #3 架构。
    // 在后台服务 healthz 绑定后（保留当前行为），额外轮询
    // /api/kernel/status 直到 kernel_state 为 ready / partial_ready，
    // 或超时。供那些在启动时想要"内核就绪"信号、而非较弱的
    // "后台服务就绪"的操作者使用。默认 60s；用 --wait-for-kernel-ms 覆盖。
    .option("--wait-for-kernel", "后台服务绑定后，再等待内核智能体就绪（默认超时 60s）")
    .option("--wait-for-kernel-ms <ms>", "覆盖 --wait-for-kernel 超时，单位毫秒")
    .action(async (opts: { port?: string; host?: string; db?: string; kernel?: boolean; waitForKernel?: boolean; waitForKernelMs?: string }) => {
      try {
        const { ConfigStore } = await import("../config-store.js");
        const { SystemPreflight } = await import("../system-preflight.js");
        const { execSync } = await import("node:child_process");
        const configStore = new ConfigStore();
        const config = configStore.resolve();
        const effectivePort = opts.port ? parseInt(opts.port, 10) : config.daemon.port;
        // bug-fix slice auth-bearer-tailscale-trust：区分
        // 用户显式指定与默认回退，使后台服务在操作者
        // 从未选择特定主机时能多绑定（回环 + tailscale 自动探测）。
        const hostResolution = configStore.resolveWithSource("daemon.host");
        // S20 —— 绑定意图只来自专门入口：--host 标志、
        // 文件来源的 daemon.host，或 OPENRIG_BIND_HOST。环境变量来源的
        // daemon.host 是重载的路由通道（ENV_MAP 把它从 OPENRIG_HOST 映射来——
        // 即托管环境携带的注入状态），绝不产生意图。
        const intent = resolveBindIntent({
          flagHost: opts.host,
          envBindHost: process.env["OPENRIG_BIND_HOST"],
          configSource: hostResolution.source,
          configHost: config.daemon.host,
        });
        const hostUserExplicit = intent.explicit;
        const effectiveHost = intent.host ?? "127.0.0.1";
        const hostForDaemon = intent.host;

        // 启动前运行预检
          const preflight = new SystemPreflight({
            exec: async (cmd) => execSync(cmd, { encoding: "utf-8" }),
            configStore,
            getDaemonStatus: () => getDaemonStatus(getDeps()),
            openrigHome: OPENRIG_DIR,
          });
        const preflightResult = await preflight.run({ port: effectivePort, host: effectiveHost });
        if (!preflightResult.ready) {
          for (const check of preflightResult.checks.filter((c) => !c.ok)) {
            console.error(`✗ ${check.name}：${check.error}`);
            if (check.reason) console.error(`  原因：${check.reason}`);
            if (check.fix) console.error(`  修复：${check.fix}`);
          }
          process.exitCode = 1;
          return;
        }

        // V0.3.1 slice 05 —— Commander 的 --no-kernel 反转为 opts.kernel === false。
        const skipKernel = opts.kernel === false;
        const state = await startDaemon(
          {
            port: effectivePort,
            host: hostForDaemon,
            db: opts.db ?? config.db.path,
            transcriptsEnabled: config.transcripts.enabled,
            transcriptsPath: config.transcripts.path,
            workspaceRoot: config.workspace.root,
            contextRoot: config.context.root,
            skillsRoot: config.skills.root,
            topologyRoot: config.topology.root,
            // V1 预发布 CLI/后台服务 第 1 项 —— 把 ConfigStore
            // 解析出的轮转可调项投射到后台服务进程环境，使文件里
            // 存的值（`rig config set transcripts.lines 500`）
            // 真正到达轮转钩子。
            transcriptsLines: config.transcripts.lines,
            transcriptsPollIntervalSeconds: config.transcripts.pollIntervalSeconds,
            // V0.3.1 slice 05 kernel-rig-as-default —— 经
            // OPENRIG_NO_KERNEL 环境变量传递，使后台服务在
            // startup.ts 里的内核启动检查遵守该标志。
            skipKernelBoot: skipKernel,
          },
          getDeps(),
        );
        console.log(`后台服务已在端口 ${state.port} 启动（pid ${state.pid}）`);

        // V0.3.1 slice 05 前瞻性修复 #3 架构 —— --wait-for-kernel
        // 绑定后轮询。后台服务绑定 healthz 后内核引导是 fire-and-forget，
        // 因此没有该标志时 CLI 不知道内核本身是否到达 ready。
        // 需要内核就绪信号的操作者在此选择加入。
        if (opts.waitForKernel) {
          const { waitForKernelReady } = await import("../daemon-lifecycle.js");
          const timeoutMs = opts.waitForKernelMs && /^\d+$/.test(opts.waitForKernelMs)
            ? parseInt(opts.waitForKernelMs, 10)
            : 60_000;
          const baseUrl = `http://${state.host}:${state.port}`;
          const result = await waitForKernelReady(baseUrl, timeoutMs);
          if (result.ok) {
            console.log(`内核 ${result.kernelState}；variant=${result.variant ?? "（无）"}`);
          } else {
            // 按既定纪律给出诚实的三段式错误。
            console.error(
              `错误：内核在 ${timeoutMs}ms 内未到达 ready / partial_ready。\n` +
                `原因：kernel_state=${result.kernelState ?? "未知"}` +
                (result.detail ? `；${result.detail}` : "") +
                "\n" +
                "修复：用 `zrig ps --rig kernel` 检查卡住的智能体，或运行 `claude auth status` / `codex login status` 确认运行时登录。",
            );
            process.exitCode = 1;
          }
        }
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  cmd
    .command("stop")
    .description("停止后台服务（10s 关停预算；12s 进程等待；排空不完整则非零退出）")
    .addHelpText("after", "\n对存活目标至多发送一次 SIGTERM，并校验原 PID 与监听器。重复信号并入关停。\n对已记录目标，回执缺失/过期与排空不完整都会非零退出，包括重试。\n目标状态保留直到匹配的干净回执；状态读取保留未验证状态。\n无目标是一种独立的空操作，绝非干净排空认证；未绑定的不完整证据保持未验证。\n请查看 OPENRIG_HOME/daemon-shutdown.json 与 daemon.log 了解阶段与结果。\n该绑定覆盖异步关停；事件循环卡住仍需操作者恢复。\n")
    .action(async () => {
      try {
        const outcome = await stopDaemon(getDeps());
        console.log(outcome === "stopped" ? "后台服务已停止" : "未记录后台服务目标；监听器拒绝连接。无可停止；此前排空未认证。");
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  cmd
    .command("status")
    .description("显示后台服务状态")
    .action(async () => {
      const status = await getDaemonStatus(getDeps());
      const pidSuffix = status.pid !== undefined ? `（pid ${status.pid}）` : "";
      switch (status.state) {
        case "running":
          if (status.healthy === false) {
            // OPR.0.4.3.21 —— 进程在但不健康：指明真实原因（控制面卡住），
            // 而不是干巴巴的 "healthz failed"，并附上事件循环证据 + 保席位的恢复提示。
            const cause = status.reason === "unresponsive"
              ? "无响应（事件循环可能被饿死——/healthz 超时）"
              : status.reason === "event-loop-starved"
                ? "事件循环被饿死"
                : "healthz 失败";
            console.log(`后台服务运行于端口 ${status.port}${pidSuffix} —— 进程在但不健康：${cause}`);
            if (status.eventLoop) {
              const el = status.eventLoop;
              console.log(
                `  事件循环：lag 均值 ${el.lagMeanMs.toFixed(1)}ms，p99 ${el.lagP99Ms.toFixed(1)}ms，`
                + `利用率 ${(el.utilization * 100).toFixed(0)}%，最近一拍距今 ${el.lastTickAgeMs.toFixed(0)}ms`,
              );
            }
            console.log("  恢复：仅重启后台服务（`zrig daemon stop && zrig daemon start`）——这样会保留 tmux 席位。");
          } else {
            console.log(`后台服务运行于端口 ${status.port}${pidSuffix}`);
          }
          break;
        case "stopped":
          console.log("后台服务已停止");
          break;
        case "stale":
          console.log("后台服务 PID 已不存在（状态过期）");
          break;
        case "unverified":
          // 1ae863d2 —— C3 语义：我们无法确认它是起是落；绝不声称已停止。
          if (status.siblingHint) {
            console.log("后台服务状态未验证——解析出的 OPENRIG_HOME 没有后台服务状态，但兄弟 home 下似乎有一个运行中的后台服务：");
            console.log(`  已解析：${status.siblingHint.resolvedHome}`);
            console.log(`  兄弟：  ${status.siblingHint.siblingHome}`);
            console.log("  修复：把 OPENRIG_HOME 指向正确的 home（或检查你的 shell 环境）——本 CLI 很可能解析错了 home。");
          } else {
            console.log("后台服务状态未验证——探测超时或结果不确定（这并不代表后台服务已宕）。");
            console.log("  用以下命令复查：zrig daemon status  ·  直连：curl 后台服务 /healthz");
          }
          break;
      }
    });

  cmd
    .command("logs")
    .description("显示后台服务日志")
    .option("--follow", "持续跟踪日志输出")
    .action((opts: { follow?: boolean }) => {
      if (opts.follow) {
        tailLogs(getDeps(), { follow: true });
      } else {
        const content = readLogs(getDeps());
        if (content) {
          console.log(content);
        } else {
          console.log("未找到后台服务日志");
        }
      }
    });

  return cmd;
}
