/**
 * Slice 51-02（L2 测试系统）——真实依赖适配器。
 *
 * 把哑运行器核心（scenario-runner.ts）绑到一个 LIVE 的 scenario 本地 daemon：
 *   • runAction——把每个 action verb 映射到 SHIPPED `rig … --json` 调用
 *     （product-is-truth 传输），作为真实子进程对 daemon 运行。
 *   • observe——经 readSurface 读 shipped surface（绑到 daemon）。
 *   • `daemon` verb 直接驱动 scenario 本地 daemon 生命周期（sigterm/restart）——
 *     它是测试工具自己的 daemon，不是 rig 子进程。
 *
 * Verb → shipped `rig` 命令（traced at 13e26355）：
 *   up            → rig up <topology> --json --yes        （捕获 rigId/rigName）
 *   send          → rig send <to> <text> --json
 *   restart <seat>→ rig launch <rigId> <seat> --json      （席位 relaunch/resume；
 *                                                            无顶层
 *                                                            `restart` 命令）
 *   down          → rig down <rigName|rigId> --json --force
 *   daemon {op}   → ScenarioDaemon 生命周期（sigterm | restart）
 *
 * restore/emit/mutate/policy/seed_regression 在 v1 无 shipped 运行时绑定
 * （它们随 51-03 / A5 items 6-8）——适配器 FAILS LOUD，抛具名 UnboundActionError，
 * 而不是编造调用（与 FLAG-1 `proof` surface 同下限：unbound 绝不被静默跳过）。
 *
 * `rigBin` 注入（单一 51-04 container-mode seam）；`runRig` 注入，使 verb→argv 映射
 * 无需 live daemon 即可单测。
 */

import { runRig as realRunRig, type RigResult, type ScenarioDaemon } from "./scenario-daemon.js";
import { readSurface } from "./scenario-surfaces.js";
import type { ExpectSurface } from "./scenario-schema.js";
import type { ScenarioRunnerDeps, ActionResult } from "./scenario-runner.js";
import type { RunRecord } from "./scenario-run-record.js";

/** 当 action verb 在 v1 无 shipped 运行时绑定（FLAG-1 风格下限）时抛出。 */
export class UnboundActionError extends Error {
  readonly verb: string;
  constructor(verb: string) {
    super(
      `action verb "${verb}" 在 v1 未绑定：它无 shipped 运行时绑定，因此运行器在此 ` +
        `FAILS LOUD，而非编造调用（其绑定随 51-03 / A5 items 6-8）。这不是被静默跳过的 ` +
        `action。` +
        (verb === "emit"
          ? ` 原因（在源码处实测）：stub 运行器无输入通道——无 stdin reader、无 socket、` +
            `无 CLI/daemon 路由触发行为；行为只从它启动时读的 LAUNCH 脚本执行。因此 step-time ` +
            `emit 无法在不做 51-01 源码工作的情况下被诚实地绑定（已路由到 51-01 backlog），` +
            `模拟一个将是毫无意义的绿。v1 路径：声明 env.stub_scripts 以交付 per-seat ` +
            `launch 脚本，其 steps 携带你需要的行为。`
          : ""),
    );
    this.name = "UnboundActionError";
    this.verb = verb;
  }
}

/** 适配器所需的 live ScenarioDaemon 子集（readEnv + 生命周期）。 */
export type RealDepsDaemon = Pick<ScenarioDaemon, "readEnv" | "baseUrl" | "sigterm" | "restart">;

export interface RealDepsOptions {
  daemon: RealDepsDaemon;
  /** shipped `rig` bin 路径（单一 51-04 可注入调用 seam）。 */
  rigBin: string;
  /** `up` verb 的已解析 rig-spec 路径（scenario 的 `topology`）。 */
  topologyPath: string;
  /**
   * 传给 `rig up --cwd` 的临时工作目录，使席位的 `cwd: "."` 在 hermetic scaffold 下解析
   * （其托管文件写——AGENTS.md、stub readiness sidecar——绝不污染启动 cwd）。省略 →
   * shipped 默认（daemon 的 cwd）。
   */
  seatCwd?: string;
  /** 注入的 `rig` 运行器（默认真实子进程运行器；测试注入 spy）。 */
  runRig?: (
    args: string[],
    env: Record<string, string | undefined>,
    rigBin: string,
    timeoutMs?: number,
  ) => Promise<RigResult>;
  /** 为 poll 绑定注入的 scenario 本地时钟（ms）。默认 Date.now。 */
  now?: () => number;
  /** poll 之间注入的 sleep。默认真实定时器。 */
  sleep?: (ms: number) => Promise<void>;
  /** 可选 run-record sink。 */
  appendRecord?: (rec: RunRecord) => void;
  /** 单一默认 within/poll 对。 */
  defaults?: { withinMs: number; pollIntervalMs: number };
  /** `equals` 模式的 v1 运行器内部 normalizer seam（lock 修订 A-N1：runner 内部记录接口；
   *  DECLARATIVE artifact 仍是唯一面向 scenario 的形式，随 51-03，并降低到此 seam）。 */
  normalizer?: (surface: ExpectSurface, value: unknown) => unknown;
  /** mission scope 读 audit（D3）——从 scenario 的 env.scope_mission 穿到
   *  `rig scope audit --mission <name> --json`。 */
  scopeMission?: string;
}

/** `rig up` 重（真实 tmux 席位启动）——给它宽裕上限。 */
const UP_TIMEOUT_MS = 120_000;

const fail = (stderr: string): ActionResult => ({ code: 1, stdout: "", stderr });

/** 为哑运行器核心构建 live ScenarioRunnerDeps。 */
export function buildRealDeps(opts: RealDepsOptions): ScenarioRunnerDeps {
  const { daemon, rigBin, topologyPath } = opts;
  const runRig = opts.runRig ?? realRunRig;

  // 从 `up` 结果捕获，使 down/restart 瞄准真实 rig（绝不编造）。
  let rigId: string | undefined;
  let rigName: string | undefined;

  const runAction = async (verb: string, payload: unknown, seat?: string): Promise<ActionResult> => {
    switch (verb) {
      case "up": {
        const upArgs = ["up", topologyPath, "--json", "--yes"];
        if (opts.seatCwd) upArgs.push("--cwd", opts.seatCwd);
        const r = await runRig(upArgs, daemon.readEnv, rigBin, UP_TIMEOUT_MS);
        if (r.code === 0) {
          try {
            const j = JSON.parse(r.stdout) as Record<string, unknown>;
            const rig = (j.rig as Record<string, unknown> | undefined) ?? undefined;
            rigId = (j.rigId as string) ?? (rig?.id as string) ?? rigId;
            rigName = (j.rigName as string) ?? (rig?.name as string) ?? rigName;
          } catch {
            /* 非 JSON up 输出——留 rig id 不捕获；down/restart 会 fail loud */
          }
        }
        return r;
      }
      case "send": {
        const p = (payload && typeof payload === "object" ? payload : {}) as { to?: string; text?: string };
        const to = p.to ?? seat;
        const text = p.text ?? "";
        if (!to) return fail("send：无收件人（需要 payload.to 或 seat）");
        return runRig(["send", to, text, "--json"], daemon.readEnv, rigBin);
      }
      case "restart": {
        // 席位 relaunch/resume——rig launch <rigId> <seat>。与 `daemon` verb 不同
        // （后者重启 scenario 本地 DAEMON，不是席位）。
        const node = typeof payload === "string" ? payload : seat;
        const target = rigId ?? rigName;
        if (!target) return fail("restart：尚未启动 rig（未从 `up` 捕获 rigId/rigName）");
        if (!node) return fail("restart：未指定席位（restart <seat>）");
        return runRig(["launch", target, node, "--json"], daemon.readEnv, rigBin);
      }
      case "down": {
        const target = rigName ?? rigId;
        if (!target) return fail("down：尚未启动 rig（未从 `up` 捕获 rigId/rigName）");
        return runRig(["down", target, "--json", "--force"], daemon.readEnv, rigBin);
      }
      case "daemon": {
        const op = (payload && typeof payload === "object" ? (payload as { op?: string }).op : undefined);
        if (op === "sigterm") { await daemon.sigterm(); return { code: 0, stdout: "", stderr: "" }; }
        if (op === "restart") { await daemon.restart(); return { code: 0, stdout: "", stderr: "" }; }
        return fail(`daemon：未知 op ${JSON.stringify(op)}（允许：sigterm、restart）`);
      }
      default:
        // restore / emit / mutate / policy / seed_regression——v1 无 shipped 绑定。
        throw new UnboundActionError(verb);
    }
  };

  const observe = (surface: ExpectSurface, o: { seat?: string }): Promise<unknown> =>
    readSurface(
      surface,
      { rigBin, readEnv: daemon.readEnv, baseUrl: daemon.baseUrl },
      { seat: o.seat, scopeMission: opts.scopeMission },
    );

  return {
    runAction,
    observe,
    now: opts.now ?? (() => Date.now()),
    sleep: opts.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms))),
    appendRecord: opts.appendRecord,
    defaults: opts.defaults ?? { withinMs: 15_000, pollIntervalMs: 250 },
    normalizer: opts.normalizer,
  };
}
