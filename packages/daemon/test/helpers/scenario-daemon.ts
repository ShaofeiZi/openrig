/**
 * Slice 51-02（L2 test-system）——强制本地 scenario daemon 生命周期。
 *
 * hermetic helper 在已清除 scratch 环境下通过随附 `rig` bin 生成真实
 * scenario-local daemon，runner 用真实 `rig … --json` 子进程驱动它。
 * 这在真实进程边界证明 env-discipline（直接进程内方法调用不是传输证明），
 * 并使断言精确反映 user/agent 观察到的内容（product-is-truth）。
 *
 * `rig` bin 是单一可注入接缝（`rigBin`），故 51-04 container-mode 可
 * 指向容器内安装的 `rig` 而不触碰 host-mode
 * contract.
 */

import { execFile } from "node:child_process";
import net from "node:net";
import { join } from "node:path";
import { assertNoForeignDaemon, type HermeticScaffold } from "./hermetic-env.js";

export interface RigResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** 正在运行的 scenario-local daemon，以及读取与 teardown 方法。 */
export interface ScenarioDaemon {
  /** daemon 监听的 ephemeral port。 */
  port: number;
  /** http://127.0.0.1:<port> */
  baseUrl: string;
  /**
   * Environment for shipped read/write subprocesses: the scaffold's scrubbed
   * scratch 环境，OPENRIG_URL 指向本 daemon（helper 自有——非外部目标）。
   */
  readEnv: Record<string, string | undefined>;
  /**
   * 对 scenario-local daemon 发 SIGTERM（`daemon: {op: sigterm}` verb）——通过
   * 随附 `rig daemon stop` 杀死；scaffold 保留以便重启可经同一保证重新生成。幂等。
   */
  sigterm: () => Promise<void>;
  /**
   * 重启 scenario-local daemon（`daemon: {op: restart}` verb）——确保其已停，
   * 再在同一 port/db/scratch 环境重新生成，即经同一
   * forced-local/scratch/fail-closed 保证（单一 owner，无第二
   * 生命周期路径）。区别于 seat 级重启——后者绝不触碰它。
   */
  restart: () => Promise<void>;
  /** 通过已交付的 `zrig daemon stop` 停止 daemon，并移除 scaffold。 */
  stop: () => Promise<void>;
  /**
   * L6 STEP-0——将 HOST topology 路径翻译为 daemon 可读路径。Host-mode 省略此步
   * （身份：daemon 直接读 host 路径）。CONTAINER-mode 通过把 topology 目录暂存到容器内
   * 并返回容器内路径来实现，故 `rig up` 绝不会被传入容器 daemon 无法解析的 host 绝对路径
   * （"Source not found"）。
   */
  stageTopology?: (hostTopologyPath: string) => Promise<string>;
}

export interface SpawnScenarioDaemonOptions {
  /** 已交付 `zrig` bin 的路径（唯一可注入 invocation seam）。 */
  rigBin: string;
  /** 覆盖 port（默认为 ephemeral free port）。 */
  port?: number;
  /** 每次 `zrig` subprocess invocation 的 timeout（毫秒）。 */
  timeoutMs?: number;
}

/** 在 127.0.0.1 上保留 ephemeral free port（立即关闭；best-effort）。 */
export function findFreePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? res(port) : rej(new Error("could not reserve a free port"))));
    });
  });
}

/** 使用给定 env 调用 `node <rigBin> <args...>`。永不 reject——返回 exit code。 */
export function runRig(
  args: string[],
  env: Record<string, string | undefined>,
  rigBin: string,
  timeoutMs = 30_000,
): Promise<RigResult> {
  // execFile 会整体替换 environment——丢弃 undefined 值，使 scrubbed（已删除）变量绝不会以字面
  // string "undefined" 泄漏回来。
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) cleanEnv[k] = v;
  return new Promise((resolve) => {
    execFile(
      "node",
      [rigBin, ...args],
      { env: cleanEnv, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === "number"
            ? ((err as unknown as { code: number }).code)
            : err
              ? 1
              : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
  });
}

/**
 * 在 hermetic scaffold 下生成真实强制本地 scenario daemon。随附
 * `rig daemon start` 在返回前等待自身 /healthz，故退出 0 表示 daemon 正在接受请求。
 * 若 scaffold 环境仍携带外部 daemon 目标或 start 失败则抛错（fail-closed）。
 */
export async function spawnScenarioDaemon(
  scaffold: HermeticScaffold,
  opts: SpawnScenarioDaemonOptions,
): Promise<ScenarioDaemon> {
  // 纵深防御：scaffold env 已 scrubbed，但绝不面向 foreign target spawn。
  assertNoForeignDaemon(scaffold.env);

  const { rigBin, timeoutMs } = opts;
  const port = opts.port ?? (await findFreePort());
  const db = join(scaffold.stateDir, "scenario.db");

  // 唯一 start 路径——由初始 spawn 与 restart 共用，因此 restart 通过完全相同的
  // forced-local/scratch/fail-closed 保证重新 spawn。
  const startProc = async () => {
    const start = await runRig(
      ["daemon", "start", "--port", String(port), "--db", db, "--no-kernel"],
      scaffold.env,
      rigBin,
      timeoutMs,
    );
    if (start.code !== 0) {
      throw new Error(
        `scenario-local daemon failed to start (exit ${start.code}) on port ${port}: ${start.stderr || start.stdout}`,
      );
    }
  };
  const killProc = async () => {
    // `zrig daemon stop` 读取 scratch OPENRIG_HOME 下的 daemon.json，并向 daemon 发送 SIGTERM。
    // best-effort（已停止也可接受）。
    await runRig(["daemon", "stop"], scaffold.env, rigBin, timeoutMs).catch(() => {});
  };

  await startProc();

  const baseUrl = `http://127.0.0.1:${port}`;
  const readEnv: Record<string, string | undefined> = { ...scaffold.env, OPENRIG_URL: baseUrl };

  return {
    port,
    baseUrl,
    readEnv,
    sigterm: killProc,
    restart: async () => {
      await killProc();
      await startProc();
    },
    stop: async () => {
      await killProc();
      scaffold.cleanup();
    },
  };
}
