import type Database from "better-sqlite3";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { classifyPaneActivity, type PaneActivityClassification } from "./session-transport.js";

/** 缓存的结构化窗格观测：包含 classifyPaneActivity 裁决，以及窗格何时被读取为有活动。
 * observedAt 是存活时间戳（最后一次看到窗格），不是 hook 到达时长——这种区分正是
 * 约束 2 的核心：真实计数器并不等于真实存活裁决。 */
export interface StructuralObservation {
  state: PaneActivityClassification["state"];
  reason: string;
  evidence: string | null;
  observedAt: string;
}

export const DEFAULT_STRUCTURAL_POLL_INTERVAL_MS = 1000;
// 缓存观测仅在当前窗口内具有权威性。超过窗口仍无新捕获——无论是 tmux/capture 中断、
// 轮询器卡住，还是同名占用者切换——读取都会拒绝并逐出它，使陈旧的肯定裁决无法冒充存活
//（MUST-FIX 1）。5 倍轮询间隔可容忍少量漏 tick；持续失败或卡住的轮询器会让该行过期，
// ACTIVITY 投影随后回退到诚实的 hook/unknown 状态。
export const DEFAULT_STRUCTURAL_STALE_MS = 5000;

/**
 * 5b82324b——结构化活动缓存。它与 SeatActivityService 并列；后者只读取 tmux
 * window_activity 时间戳，并刻意不看文本。本服务每个 tick 为每个运行中的 tmux 席位捕获一次
 * 窗格文本，再通过 classifyPaneActivity 做结构分类（spinner 形状、`esc to interrupt`、
 * 空闲提示/status bar 特征；绝不用动词白名单，因此 "Drizzling" 一类 spinner 会识别为活动，
 * 而不是误判停驻）。attachAgentActivity 只读缓存且不再捕获，使 `zrig ps` 的 ACTIVITY 列能反映
 * 无 hook、陈旧 hook 或回合边界席位的真实窗格活动，同时不会重新引入 healthz-wedge 的廉价默认
 * 所消除的逐请求捕获风暴。后台路径靠两条安全规则自保：
 *   (MF1) 读取拒绝陈旧观测，捕获失败使前一行失效——陈旧肯定裁决不能穿越捕获中断或同名占用者切换；
 *   (MF2) sweep 单飞，并一直持有到实际捕获完成——缓慢/卡死的 tmux 无法累积重叠的全舰队捕获，
 *         任一时刻最多只有一次 sweep 的 N 个席位捕获在途。
 * 我们刻意不靠 capture 超时释放守卫：execCommand 没有 AbortSignal，包装层超时会在子进程仍存活时
 * 释放单飞，使后续 sweep 启动更多子进程，形成进程级风暴。因此永久卡住的 tmux 只会通过 MF1
 * 时效过期诚实降级为“无结构信号”，绝不会形成风暴。带 kill 的有界中止捕获原语留待 tmux-adapter 后续实现。
 */
export class SeatStructuralActivityService {
  private readonly latestBySession = new Map<string, StructuralObservation>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false; // 单飞守卫：同一时刻只允许一次全舰队 sweep（MUST-FIX 2）

  constructor(
    private readonly tmuxAdapter: Pick<TmuxAdapter, "capturePaneContent">,
    private readonly now: () => Date = () => new Date(),
    private readonly captureLines: number = 20,
    private readonly staleAfterMs: number = DEFAULT_STRUCTURAL_STALE_MS,
  ) {}

  /** 缓存的结构观测仅在新鲜时有效（读取不触发 capture）。观测超过新鲜窗口后返回 null 并逐出，
   *  确保卡住或失败的轮询器不会留下一个陈旧肯定裁决，压过诚实的陈旧 hook（MUST-FIX 1）。 */
  getStructuralActivity(sessionName: string): StructuralObservation | null {
    const obs = this.latestBySession.get(sessionName);
    if (!obs) return null;
    if (this.now().getTime() - Date.parse(obs.observedAt) >= this.staleAfterMs) {
      this.latestBySession.delete(sessionName);
      return null;
    }
    return obs;
  }

  /** 捕获并结构化分类一个席位窗格，以会话名为键缓存观测。null 或失败的捕获会使前一行失效，
   *  绝不留下陈旧肯定裁决，并返回 null（MUST-FIX 1）。 */
  async pollSeat(sessionName: string): Promise<StructuralObservation | null> {
    let content: string | null;
    try {
      content = await this.tmuxAdapter.capturePaneContent(sessionName, this.captureLines);
    } catch {
      this.latestBySession.delete(sessionName);
      return null;
    }
    if (content === null) {
      this.latestBySession.delete(sessionName);
      return null;
    }
    const c = classifyPaneActivity(content);
    const obs: StructuralObservation = {
      state: c.state,
      reason: c.reason,
      evidence: c.evidence,
      observedAt: this.now().toISOString(),
    };
    this.latestBySession.set(sessionName, obs);
    return obs;
  }

  /** 刷新每个运行中且绑定 tmux 的席位一次。单飞并持有到所有捕获完成：已有 sweep 在途时
   *  绝不启动新 sweep（MUST-FIX 2），因此缓慢/卡住的 tmux 无法累积重叠的全舰队捕获；
   *  任一时刻最多只有一次 sweep 的 N 个席位捕获在途。 */
  async pollAllRunningTmuxSeats(db: Database.Database): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const rows = db.prepare(`
        SELECT s.session_name as session_name
        FROM nodes n
        JOIN sessions s ON s.node_id = n.id
          AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
        LEFT JOIN bindings b ON b.node_id = n.id
        WHERE s.status = 'running'
          AND s.session_name IS NOT NULL
          AND COALESCE(b.attachment_type, 'tmux') = 'tmux'
      `).all() as Array<{ session_name: string }>;
      const live = new Set(rows.map((r) => r.session_name));
      for (const s of Array.from(this.latestBySession.keys())) {
        if (!live.has(s)) this.latestBySession.delete(s); // 释放内存，也绝不提供陈旧读取
      }
      await Promise.all(rows.map(async (r) => {
        try { await this.pollSeat(r.session_name); } catch { /* 隔离错误：单个席位失败绝不击穿 sweep */ }
      }));
    } finally {
      this.sweeping = false;
    }
  }

  start(db: Database.Database, intervalMs: number = DEFAULT_STRUCTURAL_POLL_INTERVAL_MS): void {
    if (this.timer) return; // 幂等
    this.timer = setInterval(() => { void this.pollAllRunningTmuxSeats(db); }, intervalMs);
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
