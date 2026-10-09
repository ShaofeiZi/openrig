// 终端预览 v0（PL-018）——/preview 的逐会话限流器。
//
// 如果每个操作人员和每个固定窗格都不受限地执行 `tmux capture-pane`，
// 实时预览轮询可能压垮 tmux。这个内存缓存会在限流窗口内为后续请求
// 返回最近一次捕获的 payload。
//
// 默认窗口：每个会话 1 秒。UI 默认每 3 秒轮询一次
//（`ui.preview.refresh_interval_seconds`），所以只有多个窗格固定到同一席位，
// 或操作人员手动刷新更快时才会冲突——恰好是适合缓存的场景。
//
// MVP 单主机场景：只有一个后台服务进程，不跨主机共享状态；Map 属于单个进程。

export interface CachedCapture<T> {
  payload: T;
  capturedAt: number; // epoch 毫秒
}

export class PreviewRateLimiter<T> {
  private readonly cache = new Map<string, CachedCapture<T>>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * 若 `sessionName` 的 payload 在限流窗口内捕获，则返回缓存；否则返回 null。
   * 收到 null 时，调用方应重新捕获并通过 `set` 写回。
   */
  get(sessionName: string): CachedCapture<T> | null {
    const cached = this.cache.get(sessionName);
    if (!cached) return null;
    if (this.now() - cached.capturedAt > this.windowMs) return null;
    return cached;
  }

  set(sessionName: string, payload: T): CachedCapture<T> {
    const entry: CachedCapture<T> = { payload, capturedAt: this.now() };
    this.cache.set(sessionName, entry);
    return entry;
  }

  /** 清除某个会话的缓存条目，例如会话拆除时。 */
  clear(sessionName: string): void {
    this.cache.delete(sessionName);
  }
}
