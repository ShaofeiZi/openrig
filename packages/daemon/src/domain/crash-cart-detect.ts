// 故障诊断 C3——后台服务状态检测（planner + PM 裁定；如实降级的防误报护栏）。
//
// 三态模型：驾驶舱与 C2 直接读取仅在 DOWN 时触发，且 DOWN 必须有肯定证据。
// 短暂探测异常绝不能捏造崩溃叙事或提供“恢复全部”：
//   UP         — /healthz 已响应（openrig 正在提供服务）。
//   DOWN       —（无 daemon.json 或 pid 已终止）且 /healthz 连接被拒绝。REFUSED 是唯一强下线信号；
//                无论重试多少次，超时都绝不会提升为 DOWN。
//   UNVERIFIED — 其他所有情况：超时、后台服务卡死（pid 存活但拒绝或不响应），或端口被非 openrig
//                进程占用。此状态渲染自己的最小界面，绝不进入驾驶舱。
//
// 所有探针和时钟均可注入，使判定可确定性测试。

export type DaemonState = "up" | "down" | "unverified";

/** /healthz 探测结果：区分连接被拒绝（强下线信号）、超时（未验证）与外部进程占用（未验证）。 */
export type HealthzProbeResult = "answered" | "refused" | "timeout" | "not-openrig";

/** 在 UNVERIFIED 界面逐字渲染的证据；它绝不是崩溃叙事，而是如实记录“无法确认后台服务已停止”。
 * 调用方根据 pid 检查和最后一次探测组装。 */
export interface DaemonUnverifiedEvidence {
  pidState: string;
  probeResult: string;
  failedSignal: string;
}

/** 分类器所需的最小 daemon.json 结构。 */
export interface DaemonStateFile {
  pid: number;
  port: number;
  host?: string;
}

export interface ClassifyDaemonDeps {
  openrigHome: string;
  readDaemonJson: (openrigHome: string) => DaemonStateFile | undefined;
  isProcessAlive: (pid: number) => boolean;
  probeHealthz: (url: string) => Promise<HealthzProbeResult>;
  openrigUrl?: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 7433;

function healthzUrl(deps: ClassifyDaemonDeps, state: DaemonStateFile | undefined): string {
  if (deps.openrigUrl && deps.openrigUrl.trim().length > 0) {
    const base = deps.openrigUrl.trim();
    return `${base.endsWith("/") ? base.slice(0, -1) : base}/healthz`;
  }
  const host = state?.host ?? DEFAULT_HOST;
  const port = state?.port ?? DEFAULT_PORT;
  return `http://${host}:${port}/healthz`;
}

/**
 * 单次分类（每次探测的基础操作；有界重试由 resolveDaemonState 完成）。
 * 只有肯定证据（pid 已终止/缺失且连接被拒绝）才判为 DOWN；已响应判为 UP；其余为 UNVERIFIED。
 */
export async function classifyDaemonState(deps: ClassifyDaemonDeps): Promise<DaemonState> {
  const state = deps.readDaemonJson(deps.openrigHome);
  const pidDeadOrAbsent = !state || !deps.isProcessAlive(state.pid);
  const probe = await deps.probeHealthz(healthzUrl(deps, state));
  if (probe === "answered") return "up";
  if (probe === "refused" && pidDeadOrAbsent) return "down";
  // 超时、卡死（pid 存活但拒绝/不响应）或外部进程占用，都绝不能得出崩溃结论。
  return "unverified";
}

export interface ResolveDaemonDeps extends ClassifyDaemonDeps {
  /** 探测间可注入的延迟（便于确定性测试）。 */
  sleep: (ms: number) => Promise<void>;
  /** 最大探测次数（少量且有界，体验上不超过 2 秒；默认 3 次）。 */
  maxProbes?: number;
  /** 探测间延迟，单位毫秒（默认 400；探测 3 次时约两个间隔，总计小于 2 秒）。 */
  retryDelayMs?: number;
}

/**
 * 有界重试判定。UP（已响应）和 DOWN（拒绝连接且 pid 已终止）是决定性结果，首次探测得到后立即返回，
 * 不再重试。UNVERIFIED（超时、卡死或外部进程占用）触发有界重试；若在 maxProbes 内始终无法判定
 * UP 或 DOWN，最终结果仍为 UNVERIFIED。无论重试多少次，超时都绝不会提升为 DOWN。
 */
export async function resolveDaemonState(deps: ResolveDaemonDeps): Promise<DaemonState> {
  const max = Math.max(1, deps.maxProbes ?? 3);
  const delay = deps.retryDelayMs ?? 400;
  for (let i = 0; i < max; i += 1) {
    const s = await classifyDaemonState(deps);
    if (s === "up" || s === "down") return s; // 决定性结果
    if (i < max - 1) await deps.sleep(delay); // 未验证则重试
  }
  return "unverified";
}
