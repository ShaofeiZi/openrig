/**
 * Slice 51-02 delta D7——scenario TUI provisioning（opt-in、有界、明确失败）。
 *
 * `tui_socket` surface 读取已交付 TUI 的 control socket；该 socket 只存在于运行中的 TUI process
 * 内，其他组件不会创建。仅启动 TUI 就继续，会让首次读取与可能尚未 listen 的 socket 竞争：
 * `readTuiSocket` 遇到连接错误会立即 reject，`expect` poller 又不捕获 observation error，
 * 因此 scenario 会直接中止，而不是轮询。
 *
 * 因此 provisioning 会在有界时间内等待真实 `state` 往返——与 surface reader 发出的 query 相同——
 * 同时监测 process 是否提前退出，任一情况都以具名 error 失败。成功和所有失败路径都会执行
 * teardown（caller 使用 try/finally 包裹）。
 *
 * TUI 在 scaffold 自己的 tmux server（D5）中运行，并使用 scaffold socket path，
 * 因此 provisioning 不会触碰用户的 TUI 或 fleet server。
 */

import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";

/** TUI 无法 provision 时抛出（提前退出或 readiness timeout）。 */
export class TuiProvisioningError extends Error {
  readonly reason: "early_exit" | "readiness_timeout";
  constructor(reason: "early_exit" | "readiness_timeout", detail: string) {
    super(`TUI provisioning 失败（${reason}）：${detail}`);
    this.name = "TuiProvisioningError";
    this.reason = reason;
  }
}

/** 已 provision 的 TUI：其 control-socket path 与幂等 teardown。 */
export interface ProvisionedTui {
  socketPath: string;
  stop(): Promise<void>;
}

/** provisioning 所需的 process handle——收窄以便测试注入 fake。 */
export interface TuiProcessLike {
  /** process 退出时以 exit code resolve；绝不 reject。 */
  exited: Promise<number | null>;
  /** process 退出后为 true。 */
  hasExited(): boolean;
  kill(): void;
}

export interface ProvisionTuiOptions {
  socketPath: string;
  /** 启动 TUI。可注入，以便对 readiness/exit 路径做单元测试。 */
  spawnTui: () => TuiProcessLike;
  /** readiness 总时限，单位 ms。 */
  readinessTimeoutMs?: number;
  /** readiness probe 间隔，单位 ms。 */
  probeIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** probe override（默认为 socket 上的真实 `state` 往返）。 */
  probe?: (socketPath: string) => Promise<boolean>;
}

const DEFAULT_READINESS_TIMEOUT_MS = 20_000;
const DEFAULT_PROBE_INTERVAL_MS = 100;

/**
 * 在 control socket 上执行一次 `state` 往返。仅当 TUI 返回可解析的一行时才返回 true——
 * 这是 surface reader 依赖的精确 contract，而非只检查“socket file 存在”。
 */
export function probeTuiState(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
    const conn = net.createConnection(socketPath);
    let buf = "";
    const timer = setTimeout(() => { conn.destroy(); done(false); }, timeoutMs);
    conn.on("connect", () => conn.write("state\n"));
    conn.on("data", (b) => {
      buf += b.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      const line = buf.slice(0, nl);
      conn.end();
      try { JSON.parse(line); done(true); } catch { done(false); }
    });
    conn.on("error", () => { clearTimeout(timer); done(false); });
  });
}

/**
 * 启动 TUI，并在有界时间内等待其 control socket 回答 `state`。提前退出或超时时以具名方式失败，
 * 两种情况下都会终止 process，确保没有 orphan 存留。成功后由 caller 负责 `stop()`。
 */
export async function provisionTui(opts: ProvisionTuiOptions): Promise<ProvisionedTui> {
  const {
    socketPath,
    spawnTui,
    readinessTimeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
    probeIntervalMs = DEFAULT_PROBE_INTERVAL_MS,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
    probe = (p: string) => probeTuiState(p),
  } = opts;

  const proc = spawnTui();
  let exitCode: number | null | undefined;
  void proc.exited.then((code) => { exitCode = code; });

  const stop = async (): Promise<void> => {
    if (!proc.hasExited()) proc.kill();
    await proc.exited.catch(() => null);
  };

  const start = now();
  for (;;) {
    if (proc.hasExited()) {
      // 提前退出优先于 readiness：已退出的 TUI 不会 listen，若等待完整时限，会把真实 crash
      // 错报为 timeout。
      await stop();
      throw new TuiProvisioningError(
        "early_exit",
        `TUI process 在 ${socketPath} 的 control socket 回答 \`state\` 前退出（code ${String(exitCode)}）`,
      );
    }
    if (await probe(socketPath)) {
      return { socketPath, stop };
    }
    if (now() - start >= readinessTimeoutMs) {
      await stop();
      throw new TuiProvisioningError(
        "readiness_timeout",
        `${socketPath} 的 control socket 未在 ${readinessTimeoutMs}ms 内回答 \`state\`（process 仍在运行）`,
      );
    }
    await sleep(probeIntervalMs);
  }
}

/** 将已交付的 TUI binary 作为脱离 terminal 的 child process 启动。 */
export function spawnShippedTui(tuiBin: string, env: Record<string, string | undefined>): TuiProcessLike {
  const child: ChildProcess = spawn(process.execPath, [tuiBin], {
    env: env as NodeJS.ProcessEnv,
    stdio: ["ignore", "ignore", "ignore"],
  });
  let exited = false;
  const exitedPromise = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => { exited = true; resolve(code); });
    child.on("error", () => { exited = true; resolve(null); });
  });
  return {
    exited: exitedPromise,
    hasExited: () => exited,
    kill: () => { try { child.kill("SIGTERM"); } catch { /* 已退出 */ } },
  };
}
