// #69——较新 Codex 会把 interactive TUI attach 到一台机器共用的 `codex app-server` daemon，tool
// shell 在该 daemon 环境下运行。于是一个 seat 的 tool 可能以另一 seat 的 OpenRig identity 执行。
// `--no-daemon` 将 app-server 限制在 seat 自身 process tree 中，但较旧 Codex 会拒绝该 flag。
// 因此 OpenRig 每次 launch 都会查询 seat 实际运行的 binary：在 seat working directory 中、使用
// launch PATH 执行 `codex --help`（相对 PATH entry 的解析方式与 pane 中完全一致）。
//   supported → Codex usage 列出 `--no-daemon` option：带此项启动；
//   legacy    → Codex usage 不含该 option：保留现有 invocation；
//   unknown   → failure、timeout 或非 Codex output：拒绝，而不是启动可能共享的 seat。

export type CodexDaemonSupport =
  | { kind: "supported" }
  | { kind: "legacy" }
  | { kind: "unknown"; detail: string };

/** 检测 `cwd` 中 seat 将运行的 Codex 是否支持该能力。 */
export type CodexDaemonSupportDetector = (cwd: string) => Promise<CodexDaemonSupport>;

const CODEX_USAGE = /^Usage: codex(?:[ \t]|$)/m;
const NO_DAEMON_OPTION = /^[ \t]*--no-daemon(?:[ \t]|$)/m;

/** 对一次 `codex --help` 运行分类；`runHelp` 以输出 resolve，或 reject。 */
export async function probeCodexDaemonSupport(runHelp: () => Promise<string>): Promise<CodexDaemonSupport> {
  let help: string;
  try {
    help = await runHelp();
  } catch (error) {
    return { kind: "unknown", detail: `codex --help 执行失败：${String(error instanceof Error ? error.message : error).split("\n")[0]}` };
  }
  if (!CODEX_USAGE.test(help)) return { kind: "unknown", detail: "codex --help 未打印 Codex usage" };
  return NO_DAEMON_OPTION.test(help) ? { kind: "supported" } : { kind: "legacy" };
}

/** 生产 detector：异步运行 `codex --help`，使 daemon 可继续提供服务。 */
export function codexDaemonSupportProbe(launchPath?: string, timeoutMs = 10_000): CodexDaemonSupportDetector {
  return (cwd) => probeCodexDaemonSupport(async () => {
    const { execFile } = await import("node:child_process");
    const env = launchPath ? { ...process.env, PATH: launchPath } : process.env;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    return new Promise<string>((resolve, reject) => {
      // execFile 会在 timeout 时关闭 pipe，但如果 wrapper 已以零退出、descendant 仍保持 pipe 打开，
      // 它可能报告成功。因此单独限制决策时限；execFile 仍负责 pipe/direct-child 清理，而非整个 tree。
      deadline = setTimeout(() => reject(new Error(`${timeoutMs} ms 后超时`)), timeoutMs);
      execFile("codex", ["--help"], { cwd, env, timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf-8" }, (error, stdout) => {
        if (error) reject(error.killed ? new Error(`${timeoutMs} ms 后超时`) : error);
        else resolve(stdout);
      });
    }).finally(() => clearTimeout(deadline));
  });
}

export function unknownDaemonSupportMessage(detail: string): string {
  return `无法判断已安装 Codex 是否支持 --no-daemon（${detail}）。`
    + "没有该选项时，共用一个 app-server daemon 的 Codex 可能以另一 seat 的 identity 运行此 seat "
    + "的 tool，因此 zrig 未启动它。请确认 `codex --help` 能在 seat working directory 中使用 "
    + "daemon 的 PATH 运行，然后再次启动。";
}
