/**
 * Slice 51-02（L2 test-system）——scenario PIPELINE（parse → validate → run）。
 *
 * loadScenarioFile 是纯前端：读取 scenario YAML，相对 scenario 文件解析其 `topology` rig-spec
 * 路径，再验证架构结构。I/O 和 YAML 语法失败会明确抛出 ScenarioLoadError；内容问题返回
 * validator error list，绝不静默 no-op。
 *
 * runScenarioFile 是重型 integration 后端：在 hermetic scaffold 下启动强制本地的 scenario-local
 * 后台服务，接入 real-deps adapter，以真实子进程对正式 `zrig` CLI 运行已验证 scenario，最后
 * 关闭后台服务。`up` verb 在真实 tmux 中启动 runtime:stub 席位，因此该路径是
 * product-is-truth e2e，只供 integration suite 使用，不属于纯单元测试。
 */

import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  validateScenario,
  type ValidatedScenario,
  type ValidationError,
} from "./scenario-schema.js";
import { prepareHermeticEnv, type HermeticScaffold } from "./hermetic-env.js";
import {
  spawnScenarioDaemon,
  runRig as realRunRig,
  type RigResult,
  type ScenarioDaemon,
} from "./scenario-daemon.js";
import { buildRealDeps, type RealDepsOptions } from "./scenario-real-deps.js";
import { runValidatedScenario, type RunScenarioResult } from "./scenario-runner.js";
import type { RunRecord } from "./scenario-run-record.js";
import { stageTopologyRoot, deliverStubScripts, resolveStubScriptTargets } from "./scenario-stage.js";
import { provisionTui, spawnShippedTui, type ProvisionedTui, type TuiProcessLike } from "./scenario-tui.js";

/** 从本 helper 自身位置解析出的 tui package root。 */
const TUI_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tui");

/** scenario 文件无法读取或解析时抛出，构成明确的 I/O/语法下限。 */
export class ScenarioLoadError extends Error {
  readonly path: string;
  constructor(path: string, detail: string) {
    super(`could not load scenario ${JSON.stringify(path)}: ${detail}`);
    this.name = "ScenarioLoadError";
    this.path = path;
  }
}

/** `env` 前置条件（fixture 级 baton 设置）失败时抛出。 */
export class ScenarioPreconditionError extends Error {
  constructor(detail: string) {
    super(`scenario precondition failed: ${detail}`);
    this.name = "ScenarioPreconditionError";
  }
}

/** scenario 请求当前后台服务模式无法满足的 capability 时抛出。 */
export class ScenarioModeUnsupportedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ScenarioModeUnsupportedError";
  }
}

/** 提取并检查 `env.stub_scripts` 结构（D1）。load 时 validator 已检查结构；这里是 pipeline
 *  对同一字段的自身读取。 */
export function extractStubScripts(env: Record<string, unknown> | undefined): Record<string, string> {
  const raw = env?.stub_scripts;
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ScenarioPreconditionError("env.stub_scripts must be a mapping of <seat> → <script path>");
  }
  const out: Record<string, string> = {};
  for (const [seat, p] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof p !== "string" || p.length === 0) {
      throw new ScenarioPreconditionError(`env.stub_scripts.${seat}: a non-empty script path is required`);
    }
    out[seat] = p;
  }
  return out;
}

/**
 * queue-baton 前置条件（fixture 级）。scenario 断言 observable；`env.queue` 在 step 运行前通过
 * 正式 `zrig queue create|claim` 写入建立 claimed baton。由于没有 queue action verb，baton 按
 * 锁定 verb set 位于 scenario grammar 外，并在 scenario 文件中显式记录。Queue state 位于
 * 后台服务侧，与任何席位进程无关。
 */
export interface QueuePrecondition {
  id: string;
  source: string;
  destination: string;
  summary?: string;
  body?: string;
  /** claim 已创建 qitem，使其进入 in-progress 并归 `destination` 所有。 */
  claim?: boolean;
}

/** 提取并检查 `env.queue` 前置条件结构；malformed entry 会明确失败。 */
export function extractQueuePreconditions(env: Record<string, unknown> | undefined): QueuePrecondition[] {
  const q = env?.queue;
  if (q === undefined) return [];
  if (!Array.isArray(q)) {
    throw new ScenarioPreconditionError("env.queue must be a list of {id, source, destination, claim?} entries");
  }
  return q.map((raw, i) => {
    const e = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    for (const key of ["id", "source", "destination"] as const) {
      if (typeof e[key] !== "string" || (e[key] as string).length === 0) {
        throw new ScenarioPreconditionError(`env.queue[${i}].${key} is required (non-empty string)`);
      }
    }
    return {
      id: e.id as string,
      source: e.source as string,
      destination: e.destination as string,
      summary: typeof e.summary === "string" ? e.summary : undefined,
      body: typeof e.body === "string" ? e.body : undefined,
      claim: e.claim === true,
    };
  });
}

export interface PreconditionContext {
  rigBin: string;
  readEnv: Record<string, string | undefined>;
  /** 注入的 `zrig` runner；默认真实子进程 runner，测试注入 spy。 */
  runRig?: (
    args: string[],
    env: Record<string, string | undefined>,
    rigBin: string,
    timeoutMs?: number,
  ) => Promise<RigResult>;
}

/**
 * 通过正式 `zrig queue` 写入应用 queue-baton 前置条件。Fail-closed。
 *
 * Identity（P21 之后）：`--source` 已由 P21 I3 退役（c4fad7b39，2026-08-07），现已 deprecated
 * 且忽略；queue-spine verb 不再发送 body identity。sender 现在通过 transport header 传递，CLI
 * 从 OPENRIG_SESSION_NAME 派生。fixture 声明的 provenance 因此作为逐调用 ENV identity 传递：
 * creator = `source`，claimant = `destination`。这与产品强制的 transport-not-body 原则一致，
 * 不是绕过它。
 */
export async function applyQueuePreconditions(
  preconditions: QueuePrecondition[],
  ctx: PreconditionContext,
): Promise<void> {
  const runRig = ctx.runRig ?? realRunRig;
  for (const p of preconditions) {
    const create = await runRig(
      ["queue", "create", "--id", p.id, "--destination", p.destination,
        "--summary", p.summary ?? p.id, "--body", p.body ?? `51-02 precondition baton ${p.id}`, "--json"],
      { ...ctx.readEnv, OPENRIG_SESSION_NAME: p.source }, ctx.rigBin,
    );
    if (create.code !== 0) {
      throw new ScenarioPreconditionError(`queue create ${p.id} (exit ${create.code}): ${create.stderr || create.stdout}`);
    }
    if (p.claim) {
      const claim = await runRig(
        ["queue", "claim", p.id, "--destination", p.destination, "--json"],
        { ...ctx.readEnv, OPENRIG_SESSION_NAME: p.destination }, ctx.rigBin,
      );
      if (claim.code !== 0) {
        throw new ScenarioPreconditionError(`queue claim ${p.id} (exit ${claim.code}): ${claim.stderr || claim.stdout}`);
      }
    }
  }
}

export interface LoadedScenario {
  scenario: ValidatedScenario;
  /** 相对 scenario 文件目录解析出的 rig-spec 绝对路径。 */
  topologyPath: string;
}

export type LoadScenarioResult =
  | { ok: true; loaded: LoadedScenario }
  | { ok: false; errors: ValidationError[] };

export interface LoadScenarioOptions {
  topologyKind?: "stub" | "real";
}

/** 读取、解析并验证 scenario 文件；I/O/YAML 失败时抛出 ScenarioLoadError。 */
export function loadScenarioFile(path: string, opts: LoadScenarioOptions = {}): LoadScenarioResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new ScenarioLoadError(path, `read failed: ${(err as Error).message}`);
  }
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    throw new ScenarioLoadError(path, `YAML parse failed: ${(err as Error).message}`);
  }

  const result = validateScenario(doc, { topologyKind: opts.topologyKind });
  if (!result.ok) return { ok: false, errors: result.errors };

  const topologyPath = resolve(dirname(path), result.scenario.topology);
  return { ok: true, loaded: { scenario: result.scenario, topologyPath } };
}

export interface RunScenarioFileOptions {
  /** 正式 `zrig` bin 路径（唯一 51-04 调用 seam）。 */
  rigBin: string;
  topologyKind?: "stub" | "real";
  /** hermetic scaffold 的基础环境（HOME/PATH/TERM）。 */
  baseEnv?: Record<string, string | undefined>;
  /** 转发给 buildRealDeps 的覆盖项（clock/sleep/appendRecord/defaults/normalizer）。 */
  deps?: Partial<Pick<RealDepsOptions, "now" | "sleep" | "appendRecord" | "defaults" | "normalizer">>;
  /**
   * 51-04 opt-in：如何启动 scenario-local 后台服务。缺失时使用 host-mode，与 51-04 之前
   * 逐字节相同（`defaultHostDaemon` = 使用 rigBin 的 spawnScenarioDaemon）。Container-mode
   *（scenario-container.ts）在这里提供自身 spawner；host-mode 路径的其他部分不变，因此
   * 51-02 契约保持字节完整。
   */
  daemon?: ScenarioDaemonSpawner;
  /**
   * 51-04 container-mode：本次运行使用的 testbed image manifest identity（digest）。设置后
   * 会盖到每条 results-ledger record 上，使不同 image version 的运行可比较（plan §4）。
   * host-mode 下缺失。
   */
  imageId?: string;
  /**
   * D7：scenario 声明 `env.tui: true` 时如何启动正式 TUI。tui_socket surface 读取只存在于
   * 运行中 TUI 内的 control socket。缺失时使用真实 binary；测试通过注入，使 readiness 与
   * early-exit 路径无需 terminal 也可执行。
   */
  spawnTui?: (env: Record<string, string | undefined>) => TuiProcessLike;
  /** D7：正式 TUI entry 路径，默认指向已构建 tui package main。 */
  tuiBin?: string;
  /**
   * D8：本次运行注入的 A3-R3 时钟（ISO 时间点）。传入 hermetic scaffold，由其为后台服务、
   * `zrig` CLI 与 stub runner 等每个 child 设置 OPENRIG_TEST_CLOCK_NOW，使 compaction-asset
   * stamp 和 stub 自身 stamp 保持确定。缺失表示 unset，使用真实 wall clock（生产行为）。
   * 未传递该值却声称确定性，等于断言并未请求的稳定性。
   */
  injectClockNow?: string;
  /**
   * D7：TUI provisioning 的 readiness 边界。将其暴露，使 failure matrix 能穿过本函数执行
   *（guard finding 3），而不是只测试 helper；只固定 helper 无法证明 pipeline 会传播具名失败
   * 并继续 teardown。
   */
  tuiReadiness?: { readinessTimeoutMs?: number; probeIntervalMs?: number };
}

/**
 * 把 image manifest id 盖到 appendRecord sink 收到的每条 record。未提供 image id 时
 *（host-mode：ledger row 与 51-04 之前逐字节相同），或没有可写入的 sink 时，原样返回原始
 * sink。stamp 使用副本，绝不修改调用方 record object。
 */
export function withImageId(
  appendRecord: ((rec: RunRecord) => void) | undefined,
  imageId: string | undefined,
): ((rec: RunRecord) => void) | undefined {
  if (!imageId || !appendRecord) return appendRecord;
  return (rec) => appendRecord({ ...rec, imageId });
}

/**
 * 启动 scenario-local 后台服务并返回 ScenarioDaemon contract。默认使用 host-mode
 *（`defaultHostDaemon`）；51-04 container-mode 通过 RunScenarioFileOptions.daemon 注入自身
 * spawner。runScenarioFile 只通过 ScenarioDaemon interface 绑定返回值，因此两种模式可互换。
 */
export type ScenarioDaemonSpawner = (
  scaffold: HermeticScaffold,
  opts: RunScenarioFileOptions,
) => Promise<ScenarioDaemon>;

/** Host-mode 默认值——逐字保留 51-04 之前的启动方式（spawnScenarioDaemon + rigBin）。 */
export const defaultHostDaemon: ScenarioDaemonSpawner = (scaffold, opts) =>
  spawnScenarioDaemon(scaffold, { rigBin: opts.rigBin });

/**
 * 选择后台服务 spawner：优先调用方 opt-in 覆盖，否则用 host-mode。覆盖缺失时完整保留原
 * host-mode 启动方式；这是 additive-opt-in fence，使 51-02 host-mode 契约字节完整，不跨越
 * PM 51-02 gate。
 */
export function resolveScenarioDaemonSpawner(opts: RunScenarioFileOptions): ScenarioDaemonSpawner {
  return opts.daemon ?? defaultHostDaemon;
}

/**
 * 完整 e2e：加载 scenario，启动强制本地的 scenario-local 后台服务，对正式 `zrig` CLI 运行
 * 已验证 scenario，再 teardown。任何 spawn 前，I/O/YAML 问题抛 ScenarioLoadError，内容问题
 * 抛聚合 validation error。
 */
export async function runScenarioFile(
  path: string,
  opts: RunScenarioFileOptions,
): Promise<RunScenarioResult> {
  const loaded = loadScenarioFile(path, { topologyKind: opts.topologyKind });
  if (!loaded.ok) {
    throw new ScenarioLoadError(path, `validation failed:\n  ${loaded.errors.map((e) => `${e.path}: ${e.message}`).join("\n  ")}`);
  }

  const preconditions = extractQueuePreconditions(loaded.loaded.scenario.env);
  const stubScripts = extractStubScripts(loaded.loaded.scenario.env);

  // D1 key contract：在任何文件系统或进程 effect 前对 source topology 检查。拼错、有歧义、
  // 重复或非 stub target 必须在这里失败，不能等后台服务和满席位工作组都启动后才失败。
  if (Object.keys(stubScripts).length > 0) {
    resolveStubScriptTargets(
      parseYaml(readFileSync(loaded.loaded.topologyPath, "utf-8")),
      stubScripts,
    );
  }

  const scaffold = prepareHermeticEnv({
    ...(opts.baseEnv ? { baseEnv: opts.baseEnv } : {}),
    ...(opts.injectClockNow !== undefined ? { injectClockNow: opts.injectClockNow } : {}),
  });
  // 席位以 scaffold 下的 cwd 启动，使其托管写入（AGENTS.md、stub sidecar）留在 scratch，
  // 绝不污染 launch cwd。
  const seatCwd = join(scaffold.root, "seat-cwd");
  mkdirSync(seatCwd, { recursive: true });
  const daemon = await resolveScenarioDaemonSpawner(opts)(scaffold, opts);
  let tui: ProvisionedTui | undefined;
  try {
    // L6 STEP-0——container-mode 把主机 topology 路径转换为容器内 staged 路径；host-mode 没有
    // stageTopology，主机路径原样透传。stage/fence 失败在此明确、具名抛出，finally 会 teardown
    // 容器；绝不会让 `zrig up` 在容器内读取不可见主机路径后只报难解的 "Source not found"。
    // D1 逐席位 script（仅 host-mode）。Container mode 把主机路径转换到容器内；尚未证明它与
    // 主机侧逐席位 staging 可组合，因此带 script 的 container scenario 会明确、具名失败并路由到
    // 51-04，而不是静默交付容器看不到的 script。无 script 的 container mode 保持现有 stage
    // 路径字节不变。
    const wantsStubScripts = Object.keys(stubScripts).length > 0;
    if (wantsStubScripts && daemon.stageTopology) {
      throw new ScenarioModeUnsupportedError(
        "env.stub_scripts is not supported in container mode yet: per-seat script delivery stages a " +
          "host-side topology root with per-seat CWDs, which the container's own path translation does " +
          "not yet compose with. Run this scenario in host mode (51-04 owns the container binding).",
      );
    }

    // 带 script 的 host mode：暂存自包含 topology root，让相对 culture_file / local: agent
    // closure 一并传递；在 staged copy 中为每个席位编写不同 cwd，再把每个已映射席位的 script
    // 投递到各自 cwd。此时不使用 `--cwd` 覆盖，否则 resolveLaunchCwd 会让一个目录覆盖所有席位，
    // 正是导致逐席位 script 无法实现的原因。
    let staged: ReturnType<typeof stageTopologyRoot> | undefined;
    if (wantsStubScripts) {
      staged = stageTopologyRoot(loaded.loaded.topologyPath, join(scaffold.root, "topology"));
      deliverStubScripts(staged, stubScripts, dirname(path));
    }

    const upTopologyPath = staged
      ? staged.topologyPath
      : daemon.stageTopology
        ? await daemon.stageTopology(loaded.loaded.topologyPath)
        : loaded.loaded.topologyPath;
    const baseDeps = buildRealDeps({
      daemon,
      rigBin: opts.rigBin,
      topologyPath: upTopologyPath,
      // staged run 在 spec 内编写逐席位 cwd；--cwd 覆盖会把它们重新折叠到同一目录。
      seatCwd: staged ? undefined : seatCwd,
      scopeMission: typeof loaded.loaded.scenario.env?.scope_mission === "string"
        ? (loaded.loaded.scenario.env.scope_mission as string)
        : undefined,
      ...opts.deps,
      // Container-mode 把 image id 盖到每条 ledger row；host-mode 无 imageId，逐字保留
      // opts.deps.appendRecord。
      appendRecord: withImageId(opts.deps?.appendRecord, opts.imageId),
    });

    // Fixture 级前置条件（baton）在 topology 启动后立即应用：`zrig queue create` 会拒绝工作组
    // 尚未启动的 destination（unknown_destination_rig），因此 baton 不能先于 `up`。它仍属于
    // setup，而不是被断言的 observable，并在 scenario `env` block 中明确声明。
    let batonApplied = preconditions.length === 0;
    // D7：control socket 位于运行中的 TUI 内，因此 opt-in scenario 在 `up` 后 provision 一个。
    // readiness 以真实 `state` 往返为有界条件，early exit/timeout 产生具名失败；socket path 注入
    // read env，使 tui_socket surface 可找到它。绝不使用操作员 TUI：它运行在 scaffold 自身
    // tmux server（D5）和 scaffold socket path 上。
    const wantsTui = loaded.loaded.scenario.env?.tui === true;
    const tuiSocketPath = join(scaffold.root, "tui.sock");
    const runAction: typeof baseDeps.runAction = async (verb, payload, seat) => {
      const res = await baseDeps.runAction(verb, payload, seat);
      if (!batonApplied && verb === "up" && res.code === 0) {
        batonApplied = true;
        await applyQueuePreconditions(preconditions, { rigBin: opts.rigBin, readEnv: daemon.readEnv });
      }
      if (wantsTui && !tui && verb === "up" && res.code === 0) {
        const tuiEnv = { ...daemon.readEnv, OPENRIG_TUI_SOCKET: tuiSocketPath };
        tui = await provisionTui({
          socketPath: tuiSocketPath,
          spawnTui: () => (opts.spawnTui ? opts.spawnTui(tuiEnv) : spawnShippedTui(resolveTuiBin(opts), tuiEnv)),
          ...(opts.tuiReadiness ?? {}),
        });
        // surface reader 通过 CLI 读取的同一 env 找到 socket。
        daemon.readEnv.OPENRIG_TUI_SOCKET = tuiSocketPath;
      }
      return res;
    };

    return await runValidatedScenario(loaded.loaded.scenario, { ...baseDeps, runAction });
  } finally {
    // 每条路径都 teardown，包括成功、assertion failure 和 provisioning error。
    await tui?.stop().catch(() => {});
    await daemon.stop().catch(() => {});
  }
}

/** 正式 TUI entry（已构建 package main）；container/test 运行可覆盖。 */
function resolveTuiBin(opts: RunScenarioFileOptions): string {
  return opts.tuiBin ?? resolve(TUI_PACKAGE_ROOT, "dist", "main.js");
}
