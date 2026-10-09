/**
 * Slice 51-02（L2 测试系统）——共享的封闭环境纪律辅助模块。
 *
 * 场景 runner 的安全基石：确保测试不可能静默连接实时或共享后台服务。只在这里实现
 * 一次，由场景 runner 和 D 类 hermetic-harness 加固入口两个消费者导入。
 *
 * 本模块目前提供失败关闭守卫（证明条目 4）。临时 HOME/OPENRIG_HOME 脚手架、
 * 强制本地后台服务启动和注入时钟贯通层构建在此守卫之上（作为后续单元加入）。
 *
 * 原则：静默回退到环境后台服务的辅助模块会重现本切片旨在消除的 D 类风险。检测是
 * 纯同步环境检查，不发送任何流量；遇到外部目标时以明确点名目标的硬错误拒绝，
 * 绝不降级，也不伪造结果。
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * 会把 CLI/daemon 客户端重定向到一个本辅助模块未曾创建的后台服务目标的继承环境变量。
 * 环境中出现其中任意一个即为外部后台服务信号 → 硬拒绝。
 *
 * 顺序即检测顺序（先匹配先生效），保持确定性，使拒绝消息在各次运行间稳定。
 *
 * 出处（已在源码核实，base 13e26355）：
 * - OPENRIG_URL / RIGGED_URL   —— 客户端 base URL（cli/src/client.ts:86，默认 http://127.0.0.1:7433）
 * - OPENRIG_HOST / RIGGED_HOST —— 客户端 host 覆盖（cli/src/index.test.ts:24-31）
 * - OPENRIG_HOST_SELECTED      —— host 选择 env 半侧；解析顺序
 *     env OPENRIG_HOST_SELECTED > ~/.openrig/config.json（磁盘）> "local"
 *     （cli/src/host-selection.ts:7）。scratch-HOME 层覆盖磁盘半侧；
 *     本守卫覆盖 env 半侧——否则持久化/env 选择会在 scratch 层生效之前
 *     静默重定向到远程后台服务（已记录的 D 类第三条泄漏向量）。
 * - OPENRIG_PORT / RIGGED_PORT —— 客户端端口（cli/src/config-store.ts:343）
 */
export const DAEMON_TARGET_ENV_VARS = [
  "OPENRIG_URL",
  "RIGGED_URL",
  "OPENRIG_HOST",
  "RIGGED_HOST",
  "OPENRIG_HOST_SELECTED",
  "OPENRIG_PORT",
  "RIGGED_PORT",
] as const;

export type DaemonTargetEnvVar = (typeof DAEMON_TARGET_ENV_VARS)[number];

/** 检测到的外部后台服务目标：违规变量名及其值。 */
export interface ForeignDaemonTarget {
  name: DaemonTargetEnvVar;
  value: string;
}

/** 环境指向外部后台服务时抛出的硬拒绝错误。 */
export class HermeticEnvError extends Error {
  readonly foreignTarget: ForeignDaemonTarget;
  constructor(target: ForeignDaemonTarget) {
    super(
      `hermetic env refused: ambient daemon target ${target.name}=${target.value} ` +
        `is present — the scenario runner will NOT run against a daemon it did not ` +
        `create (fail-closed; zero traffic sent). Unset ${target.name} or run under ` +
        `the hermetic scaffold, which spawns its own scenario-local daemon.`,
    );
    this.name = "HermeticEnvError";
    this.foreignTarget = target;
  }
}

type EnvLike = Record<string, string | undefined>;

/**
 * 检查环境中继承的后台服务目标变量。按 DAEMON_TARGET_ENV_VARS 顺序返回第一个
 * 非空匹配；环境干净时返回 null。
 *
 * 已导出但为空的变量（如 `OPENRIG_URL=`）不指向后台服务，按缺失处理。该检查
 * 纯净且同步，不访问网络，也无副作用。
 */
export function detectForeignDaemonTarget(
  env: EnvLike = process.env,
): ForeignDaemonTarget | null {
  for (const name of DAEMON_TARGET_ENV_VARS) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) {
      return { name, value };
    }
  }
  return null;
}

/**
 * 失败关闭断言：环境指向外部后台服务目标时抛出具名 HermeticEnvError。必须在构造
 * 或连接任何后台服务前调用；这是 D 类清单要强制执行的边界，不发送任何流量。
 */
export function assertNoForeignDaemon(env: EnvLike = process.env): void {
  const foreign = detectForeignDaemonTarget(env);
  if (foreign) {
    throw new HermeticEnvError(foreign);
  }
}

/**
 * A3-R3 注入时钟环境变量（OPR.0.5.1.1 第 6-8 项）。compaction-restore
 * bridge——通用生产 hook（真实 seat、真实 compaction）——读取它获取确定性时间戳，
 * 缺失时回退 `new Date()`（缺失=生产状态）。真实 seat 中存在 clock 变量会静默冻结
 * 生产 compaction-asset 时间戳：本 slice env-discipline 旨在消灭的 silent-retarget
 * 类的时间版本。故 hermetic guard 硬拒绝非自身设置的环境 clock 变量（兜底）；scaffold
 * 仅通过 `injectClockNow` 设置。故意用 TEST 语义命名——生产中可见的 `TEST` 变量
 * 显然错误。
 */
export const TEST_CLOCK_ENV_VARS = ["OPENRIG_TEST_CLOCK_NOW"] as const;

export type TestClockEnvVar = (typeof TEST_CLOCK_ENV_VARS)[number];

/** 检测到的环境注入时钟变量：违规变量名及其值。 */
export interface AmbientClockHazard {
  name: TestClockEnvVar;
  value: string;
}

/** 环境携带注入时钟变量时抛出的硬拒绝错误。 */
export class AmbientClockHazardError extends Error {
  readonly hazard: AmbientClockHazard;
  constructor(hazard: AmbientClockHazard) {
    super(
      `hermetic env refused: ambient injected-clock ${hazard.name}=${hazard.value} is present — ` +
        `this var freezes compaction-asset timestamps and must NEVER leak into a real seat ` +
        `(temporal silent-retarget). The scaffold sets it only via injectClockNow; a pre-existing ` +
        `value is a leak. Fail-closed; zero traffic sent. Unset ${hazard.name}.`,
    );
    this.name = "AmbientClockHazardError";
    this.hazard = hazard;
  }
}

/**
 * 检查环境中是否有继承来的注入时钟变量。返回首个非空匹配，干净时返回 null。
 * 空值（`OPENRIG_TEST_CLOCK_NOW=`）视为不存在。纯同步——无网络、无副作用。
 */
export function detectAmbientClockHazard(env: EnvLike = process.env): AmbientClockHazard | null {
  for (const name of TEST_CLOCK_ENV_VARS) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) {
      return { name, value };
    }
  }
  return null;
}

/**
 * FAIL-CLOSED 断言：若环境已携带注入 clock 变量则抛 AmbientClockHazardError。
 * scaffold 仅通过 injectClockNow 设置 clock，故预存值是会冻结生产时间戳的泄漏。
 * 发送 ZERO
 * traffic.
 */
export function assertNoAmbientClock(env: EnvLike = process.env): void {
  const hazard = detectAmbientClockHazard(env);
  if (hazard) {
    throw new AmbientClockHazardError(hazard);
  }
}

/**
 * tmux 附着变量（D5）。场景 `up` 会拉起真实 tmux 席位；若脚手架不拥有 server 目录，
 * 这些席位会落到操作者的 tmux server 上——这是真实的 fleet 安全隐患（从某个席位 kill-server
 * 会收割整个 fleet，游离席位也会污染操作者的会话列表）。`TMUX` 存在意味着本进程
 * 处在 tmux 客户端内部：派生出的子进程会继承该附着，并对本辅助模块未曾创建的
 * server 动手，这是静默重定向类的 tmux 版本。单列 hazard 类别，使拒绝消息
 * 准确——区别于后台服务目标与时钟泄漏。
 *
 * TMUX_TMPDIR 刻意不作为拒绝触发项：它指的是一个兼容目录，而非活动附着。
 * 脚手架会替换它并使用显式私有 socket 作为 server 身份。
 */
export const TMUX_ATTACHMENT_ENV_VARS = ["TMUX"] as const;

export type TmuxAttachmentEnvVar = (typeof TMUX_ATTACHMENT_ENV_VARS)[number];

/** A detected ambient tmux attachment: the offending var name and its value. */
export interface AmbientTmuxHazard {
  name: TmuxAttachmentEnvVar;
  value: string;
}

/** Hard-refusal error thrown when the ambient env is attached to a tmux server. */
export class AmbientTmuxHazardError extends Error {
  readonly hazard: AmbientTmuxHazard;
  constructor(hazard: AmbientTmuxHazard) {
    super(
      `hermetic env refused: ambient tmux attachment ${hazard.name}=${hazard.value} is present — ` +
        `scenario seats would land on a tmux SERVER the helper did not create (the operator's/fleet ` +
        `server), where a stray kill-server reaps live seats. The scaffold uses its own explicit ` +
        `private socket; an inherited attachment is a leak. Fail-closed; zero traffic sent, no ` +
        `scaffold created. Unset ${hazard.name} (run outside tmux, or via env -u ${hazard.name}).`,
    );
    this.name = "AmbientTmuxHazardError";
    this.hazard = hazard;
  }
}

/**
 * 检查环境中是否继承了 tmux attachment。返回首个非空匹配，干净时返回 null。
 * 空（`TMUX=`）视为缺失。纯函数且
 * synchronous — no network, no side effects.
 */
export function detectAmbientTmuxHazard(env: EnvLike = process.env): AmbientTmuxHazard | null {
  for (const name of TMUX_ATTACHMENT_ENV_VARS) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) {
      return { name, value };
    }
  }
  return null;
}

/**
 * 失败关闭断言：若环境携带 tmux 附着则抛 AmbientTmuxHazardError。
 * 在任何脚手架/进程副作用之前调用——场景席位只能到达脚手架自有的 server。零流量。
 */
export function assertNoAmbientTmux(env: EnvLike = process.env): void {
  const hazard = detectAmbientTmuxHazard(env);
  if (hazard) {
    throw new AmbientTmuxHazardError(hazard);
  }
}

/**
 * 与 daemon-target 变量一同从子环境清除的 credential 变量。
 * 自身不触发 fail-closed（不携带目标地址），但绝不得渗入 scenario-local
 * daemon 的环境。
 */
const CREDENTIAL_ENV_VARS = ["OPENRIG_AUTH_BEARER_TOKEN", "RIGGED_AUTH_BEARER_TOKEN"] as const;

/** 逐次运行的封闭脚手架：临时目录、干净的子进程环境与拆除。 */
export interface HermeticScaffold {
  /** 脚手架根目录（全新临时目录）；所有内容都位于其中。 */
  root: string;
  /** 临时 HOME，不允许真实设置、策略或信任状态流入或流出。 */
  home: string;
  /** 临时 OPENRIG_HOME（操作员状态，包括主机选择 config.json 的磁盘侧）。 */
  openrigHome: string;
  /** Scratch state dir (the scenario-local daemon's db lives here). */
  stateDir: string;
  /**
   * scaffold 自有的兼容目录，导出为 TMUX_TMPDIR。下方显式 tmuxSocketPath
   * 才是 server 身份；本目录不是。
   */
  tmuxTmpDir: string;
  /** Explicit private tmux socket used by every scaffold child invocation. */
  tmuxSocketPath: string;
  /**
   * 子进程（scenario-local daemon + `rig` CLI 调用）的干净环境：调用方环境
   * 清除 daemon-target + credential 变量并设置 scratch 路径。独立对象——绝非调用方的
   * env 或 `process.env`。
   */
  env: Record<string, string | undefined>;
  /** 删除脚手架根目录。幂等。 */
  cleanup(): void;
}

export interface PrepareHermeticEnvOptions {
  /** 派生干净子进程 env 所用的基础环境。默认 process.env。 */
  baseEnv?: EnvLike;
  /**
   * A3-R3 注入时钟。设置时，scaffold 子环境携带
   * OPENRIG_TEST_CLOCK_NOW = 此值（ISO 时间戳），使 compaction bridge 确定性打戳；
   * 省略时变量保持 UNSET，bridge 回退实时 `new Date()`（生产行为）。这是唯一获准的
   * 设置方式——baseEnv 中预存值作为泄漏被拒绝。
   */
  injectClockNow?: string;
}

/**
 * 构建每次运行的封闭脚手架。先失败关闭：若基础 env 指向外部后台服务目标，
 * 在创建任何脚手架之前抛 HermeticEnvError（零流量、零文件系统副作用）。否则创建
 * 临时 HOME/OPENRIG_HOME/state 目录，并返回一个干净的子进程 env——已清除
 * 后台服务目标 + 凭证变量，并设置临时路径。
 *
 * 不改变调用方的 env 对象或 process.env——runner 进程保持原样；只有派生的子进程
 * 收到清洗后的临时 env。状态存活在脚手架内部（封闭性教训）。
 *
 * 临时 OPENRIG_HOME 覆盖 host 选择泄漏向量的磁盘半侧（~/.openrig/config.json）；
 * 失败关闭守卫覆盖 env 半侧（OPENRIG_HOST_SELECTED）。二者合起来，脚手架无法静默重定向。
 */
export function prepareHermeticEnv(opts: PrepareHermeticEnvOptions = {}): HermeticScaffold {
  const baseEnv = opts.baseEnv ?? process.env;

  // 在任何文件系统副作用之前失败关闭：外部后台服务目标，或泄漏的注入时钟变量
  // （时间维静默重定向），都在此硬拒绝。
  assertNoForeignDaemon(baseEnv);
  assertNoAmbientClock(baseEnv);
  // D5：继承的 tmux ATTACHMENT 会把真实 scenario seat 放到
  // operator 的 server 上。像其他项一样在任何文件系统效果前拒绝。
  assertNoAmbientTmux(baseEnv);

  const root = mkdtempSync(join(tmpdir(), "openrig-scenario-"));
  const home = join(root, "home");
  const openrigHome = join(root, "openrig-home");
  const stateDir = join(root, "state");
  // 让兼容路径与显式 socket 路径都保持在 sun_path 上限之内。
  const tmuxTmpDir = join(root, "tx");
  const tmuxSocketPath = join(root, "tmux.sock");
  const tmuxWrapperDir = join(root, "bin");
  const tmuxWrapperPath = join(tmuxWrapperDir, "tmux");
  for (const dir of [home, openrigHome, stateDir, tmuxTmpDir, tmuxWrapperDir]) {
    mkdirSync(dir, { recursive: true });
  }

  // 仅测试用命令接缝：每次子 `tmux` 调用获得一个显式私有
  // socket。TMUX_TMPDIR 保留兼容，但绝非选择器。
  const originalPath = baseEnv.PATH ?? process.env.PATH ?? "";
  writeFileSync(
    tmuxWrapperPath,
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const socketPath = ${JSON.stringify(tmuxSocketPath)};
const originalPath = ${JSON.stringify(originalPath)};
const env = { ...process.env, PATH: originalPath };
const result = spawnSync("tmux", ["-S", socketPath, ...process.argv.slice(2)], { env, stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(127);
}
process.exit(result.status ?? 1);
`,
    { mode: 0o755 },
  );

  // 干净子环境：复制、清除每个 redirect/credential 变量，再设 scratch 路径。
  const env: Record<string, string | undefined> = { ...baseEnv };
  for (const name of DAEMON_TARGET_ENV_VARS) delete env[name];
  for (const name of CREDENTIAL_ENV_VARS) delete env[name];
  // 清除任何注入 clock 变量（fail-closed guard 后的纵深防御），使
  // 下方仅显式 injectClockNow 可设置——绝非继承值。
  for (const name of TEST_CLOCK_ENV_VARS) delete env[name];
  env.HOME = home;
  env.XDG_CONFIG_HOME = join(home, ".config");
  env.XDG_STATE_HOME = join(home, ".local", "state");
  env.XDG_DATA_HOME = join(home, ".local", "share");
  env.XDG_CACHE_HOME = join(home, ".cache");
  env.OPENRIG_HOME = openrigHome;
  // D5 兼容半：替换继承的 TMUX_TMPDIR。wrapper 的显式
  // -S socket 才是承载身份的半，故缺失目录不能使
  // 后续调用回退到 operator 默认 server。
  env.TMUX_TMPDIR = tmuxTmpDir;
  env.PATH = `${tmuxWrapperDir}${delimiter}${originalPath}`;
  // 强制本地：绝不解析/attach 共享 fleet kernel。
  env.OPENRIG_NO_KERNEL = "1";
  // A3-R3 注入时钟：OPENRIG_TEST_CLOCK_NOW 唯一获准的设置方式——
  // scaffold 自有值，绝非继承值。省略=>unset=>bridge
  // stamps real-time (production behavior).
  if (opts.injectClockNow !== undefined) {
    env.OPENRIG_TEST_CLOCK_NOW = opts.injectClockNow;
  }

  const cleanup = () => {
    if (!existsSync(root)) return;
    if (existsSync(tmuxSocketPath)) {
      let privateServerRunning = true;
      try {
        execFileSync("tmux", ["-S", tmuxSocketPath, "list-sessions"], {
          env: { ...env, PATH: originalPath } as NodeJS.ProcessEnv,
          stdio: "ignore",
        });
      } catch (error) {
        if (typeof (error as { status?: unknown }).status !== "number") throw error;
        privateServerRunning = false;
      }
      if (privateServerRunning) {
        execFileSync("tmux", ["-S", tmuxSocketPath, "kill-server"], {
          env: { ...env, PATH: originalPath } as NodeJS.ProcessEnv,
          stdio: "ignore",
        });
      }
    }
    rmSync(root, { recursive: true, force: true });
  };

  return {
    root,
    home,
    openrigHome,
    stateDir,
    tmuxTmpDir,
    tmuxSocketPath,
    env,
    cleanup,
  };
}
