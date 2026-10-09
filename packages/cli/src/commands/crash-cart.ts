import { Command } from "commander";
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../config-store.js";

// `zrig crash-cart --json` —— 后台服务宕机时的恢复判定输出（plan c015d9ed §C3，耦合裁决
// 选项 A）。打印一个 JSON = 三态探测器判定 +（宕机时）发现物——只读，是
// 智能体可读的公开面（4 条轨道）。即使是 fail-closed 拒绝也仍打印结构化 JSON
// （绝不只靠退出码）。`emit` 是注入进来的：真实接线从
// 作用域化的 @openrig/daemon/crash-cart 子路径导入 emitCrashCartState（原样复用）——与本命令一同装配。
//
// 范围围栏（plan R10 / Boundaries）："v1 不新增 CLI 动词；裸 `rig` 即是故障车。"
// 不存在公开的 `restore-fleet` / `cancel-fleet` 动词——TUI 通过后台服务客户端
// 直接驱动 conductor，打向 R2 批准的后台服务端批量路由。本命令只输出只读判定。

export type DaemonState = "up" | "down" | "unverified";

export interface CrashCartEmit {
  state: DaemonState;
  evidence?: { pidState: string; probeResult: string; failedSignal: string };
  discovery?: unknown;
  refusal?: string;
}

export interface CrashCartCommandDeps {
  /** 产出判定（真实接线：emitCrashCartState，带实时探测 + C2 读取）。 */
  emit: () => Promise<CrashCartEmit>;
  /** 输出一行（默认：stdout）。 */
  write: (line: string) => void;
}

function openrigHome(): string {
  return process.env.OPENRIG_HOME ?? join(homedir(), ".openrig");
}

/** 读取 daemon.json，返回完整记录（含 `db`；loadCrashCartDiscovery 需要 db 路径；
 *  探测器的 readDaemonJson 会省略它）。 */
function readDaemonJsonWithDb(home: string): { pid: number; port: number; host?: string; db: string } | undefined {
  const p = join(home, "daemon.json");
  if (!existsOrThrow(p)) return undefined;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as { pid?: unknown; port?: unknown; host?: unknown; db?: unknown };
    if (typeof j.pid === "number" && typeof j.port === "number" && typeof j.db === "string") {
      return { pid: j.pid, port: j.port, host: typeof j.host === "string" ? j.host : undefined, db: j.db };
    }
    throw new Error("daemon.json 缺少可用的 PID、端口与数据库路径");
  } catch (error) {
    throw new Error(`无法读取已记录的后台服务状态 ${p}：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 只有 ENOENT 表示不存在；权限错误与悬空链接必须显式失败。 */
function existsOrThrow(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/**
 * 真实判定：在调用时惰性 import 窄的 @openrig/daemon/crash-cart 子路径
 * （依赖轨道 2——rig 启动与其他动词从不加载 daemon 模块），并把随附的探测器
 * + C2 读取原样（轨道 2）与实时探测 + 只读 IO 拼装起来。这是建立在已测的
 * emit/detector/read 核心之上的真实运行胶水。
 */
async function realEmit(): Promise<CrashCartEmit> {
  const cc = await import("@openrig/daemon/crash-cart");
  const home = openrigHome();
  const openrigUrl = process.env.OPENRIG_URL;
  const probeClassified = (url: string) =>
    cc.probeHealthz(url, { fetch: (u, init) => fetch(u, init as RequestInit), timeoutMs: 700 });
  const detectDeps = {
    openrigHome: home,
    readDaemonJson: cc.readDaemonJson,
    isProcessAlive: cc.isProcessAlive,
    probeHealthz: probeClassified,
    openrigUrl,
  };
  return cc.emitCrashCartState({
    resolveState: () =>
      cc.resolveDaemonState({ ...detectDeps, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), maxProbes: 3, retryDelayMs: 400 }),
    assembleEvidence: async () => {
      const state = cc.readDaemonJson(home);
      const pidState = state
        ? cc.isProcessAlive(state.pid)
          ? `alive (pid ${state.pid})`
          : `dead (pid ${state.pid})`
        : "no daemon.json";
      const url = openrigUrl
        ? `${openrigUrl.replace(/\/$/, "")}/healthz`
        : `http://${state?.host ?? "127.0.0.1"}:${state?.port ?? 7433}/healthz`;
      const probeResult = await probeClassified(url);
      return { pidState, probeResult, failedSignal: `healthz ${probeResult} at ${url}` };
    },
    loadDiscovery: async () => {
      const { discovery } = await cc.loadCrashCartDiscovery({
        openrigHome: home,
        readDaemonJson: readDaemonJsonWithDb,
        isProcessAlive: cc.isProcessAlive,
        probeHealthz: (url) => probeClassified(url).then((r) => r === "answered"),
        copyFile: copyFileSync,
        exists: existsOrThrow,
        configuredDbPath: new ConfigStore().resolve().db.path,
        makeScratchDir: () => mkdtempSync(join(tmpdir(), "crash-cart-")),
        removeScratchDir: (d) => rmSync(d, { recursive: true, force: true }),
        openDb: cc.openDaemonDbReadonly,
        openrigUrl,
      });
      return discovery;
    },
  });
}

export function crashCartCommand(deps?: Partial<CrashCartCommandDeps>): Command {
  const cmd = new Command("crash-cart").description(
    "以后台服务宕机时的恢复判定 + 发现物输出为 JSON（只读）。",
  );
  cmd.option("--json", "输出 JSON（默认的机器可读形式）");
  cmd.action(async () => {
    const emit = deps?.emit ?? realEmit;
    const write = deps?.write ?? ((line: string) => process.stdout.write(line + "\n"));
    const result = await emit();
    // 轨道 3：JSON 即真相（判定 + 发现物，或结构化拒绝）。始终打印。
    write(JSON.stringify(result));
    // 非零退出只是提示（未干净起来）；JSON 才是契约。
    process.exitCode = result.state === "up" ? 0 : 1;
  });

  return cmd;
}
