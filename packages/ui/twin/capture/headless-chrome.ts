// OPR.0.4.1.11.2（FR-2 + FR-6）——确定性的 headless-Chrome 截图参数与结果分类器。
// 以 URL 为基础，同一机制可捕获意图（file:// twin）和证明（http:// 真实交付 UI）。计时标志
// 参数化，而非盲目共用：--virtual-time-budget 能让静态、无后台服务的 file:// 页面确定性
// 稳定（D-1），但无法在实时 http:// OpenRig 路由上完成，因为 SSE/轮询让页面无法进入空闲，
// 虚拟时钟不会结束，Chrome 会挂起（QA 复现，候选 7a578b32）。意图捕获保留 vtb，证明捕获
// 则省略。classifyCaptureResult 会如实且有界地解释捕获失败，不允许静默挂起。
export interface ChromeScreenshotInput {
  /** 要捕获的页面：file:// twin URL（意图）或 http:// 真实 UI URL（证明）。 */
  url: string;
  /** 截图 PNG 的绝对输出路径。 */
  pngPath: string;
  /**
   * --virtual-time-budget 的毫秒数。静态/file:// 捕获（意图 + D-1）应传入，使异步绘制
   * 确定性稳定。实时 http:// 路由必须省略；页面不进入空闲时 vtb 会挂起。值为
   * undefined/0 时不传该标志，Chrome 在页面加载后截图。
   */
  virtualTimeBudgetMs?: number;
}

/** 把绝对文件系统路径转换为 file:// URL，用于捕获 twin 的 intent.html。 */
export function fileUrl(absPath: string): string {
  return `file://${absPath}`;
}

/**
 * 构造确定性 headless-Chrome 截图参数。仅在传入正数 `virtualTimeBudgetMs` 时加入
 * `--virtual-time-budget`（静态意图/D-1）；实时证明 URL 不传该参数。
 */
export function buildChromeScreenshotArgs(input: ChromeScreenshotInput): string[] {
  const args = ["--headless=new", "--window-size=1440,900"];
  if (typeof input.virtualTimeBudgetMs === "number" && input.virtualTimeBudgetMs > 0) {
    args.push(`--virtual-time-budget=${input.virtualTimeBudgetMs}`);
  }
  args.push(`--screenshot=${input.pngPath}`, input.url);
  return args;
}

export interface CaptureResultInput {
  /** spawnSync 状态；进程被终止或出错时为 null。 */
  status: number | null;
  /** spawnSync 信号，例如有界超时终止进程时的 SIGTERM。 */
  signal: string | null;
  /** 进程超过有界超时（spawnSync ETIMEDOUT）时为 true。 */
  timedOut: boolean;
  /** 执行后截图文件是否真实存在。 */
  pngExists: boolean;
}

export interface CaptureVerdict {
  ok: boolean;
  reason: string;
}

/**
 * 如实且有界地解释截图进程结果。超时是明确失败，绝不静默挂起；非零退出或被终止均失败；
 * 退出码为 0 但没有 PNG 也失败；只有退出码为 0 且 PNG 存在才成功。纯函数，无需启动进程
 * 即可做单元测试。
 */
export function classifyCaptureResult(r: CaptureResultInput): CaptureVerdict {
  if (r.timedOut) {
    return { ok: false, reason: "timed out (bounded kill) — capture did not complete" };
  }
  if (r.status !== 0) {
    const sig = r.signal ? ` (signal ${r.signal})` : "";
    return { ok: false, reason: `chrome exited with status ${r.status ?? "null"}${sig}` };
  }
  if (!r.pngExists) {
    return { ok: false, reason: "chrome exited 0 but no screenshot was written" };
  }
  return { ok: true, reason: "ok" };
}
