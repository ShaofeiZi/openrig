// S10——OUTBOUND driver：gateway 子系统负责 outbound decision（M1 reconciliation 命名的
// queue poll + admission 形态，现在位于进程内）。每轮 sweep 选择新的人类 alert；逐字保留
// slice-11 语义：以 qitemId 为 key 的持久 seen-state 只在 delivered 后标记。每条 alert 经
// 子系统 wire 派发；wire 在 delivery 前持久化 decision，失败时保留，由 replay 负责重试。
//
// 消除重复的设计（证明项：失败期间仍持久）：
//   - seen(qitemId)：只在 delivered-ok 后标记，满足 slice-11 的 at-least-once 契约。
//   - 内存 inflight(qitemId)：已派发但未解决的 qitem 不会被后续 sweep 再次派发；重试由持久
//     buffer 的 replay 负责，绝不会创建第二个 decision。
//   - start() 时从持久 buffer 的 pending decision 为 inflight 填种（payload 携带 qitemId）。
//     后台服务重启后，这些 qitem 归 replay 路径负责，因此 sweep 无法为同一 alert 再生成一个
//     decisionId，从构造上关闭重启双重派发窗口。唯一剩余重复是锁定契约接受的罕见崩溃窗口：
//     delivery 已完成，但在 seen-mark/ack 前崩溃；重放逐字节相同，绝不丢失。

import type { SeenStore } from "./state-store.js";
import type { AlertFilterOpts, OutboundQueuePort, QueueItem } from "./queue-access.js";
import type { DispatchResult } from "../dispatcher.js";
import { DispatchBuffer } from "../dispatch-buffer.js";

export const OUTBOUND_OP = "post_message";

/** op=post_message 的 decision payload：delivery 层要渲染的队列内容。qitemId 同时作为幂等
 *  锚点（seen-state key + H reconcile marker）传递。 */
export interface OutboundPostPayload {
  qitemId: string;
  notificationKey?: string | null;
  ownerNotificationKind?: string | null;
  ownerNotificationLevel?: import("../../queue-transition-log.js").OwnerNotificationLevel | null;
  humanIntent?: "decision" | "update" | null;
  humanDetail?: string | null;
  summary?: string | null;
  body?: string | null;
  destinationSession?: string | null;
  sourceSession?: string | null;
  evidenceRef?: string | null;
  /** F：响度判别项；临时规则为 escalation 要 mention，其他全部静默。 */
  tier?: string | null;
  tags?: string[] | null;
}

export interface OutboundDriverDeps {
  home: string;
  queue: OutboundQueuePort;
  seen: SeenStore;
  filter: AlertFilterOpts;
  /** 派发到子系统 wire（durable-first）。通过注入提供；driver 自身绝不 post。 */
  dispatch: (op: string, entityBindingRef: string, payload: unknown) => DispatchResult;
  /** 不由 delivery 层 ack 路径调用——WIRE 负责 ack；driver 通过 delivery 层标记的 seen-store
   *  获知成功。此 callback seam 供测试观察 sweep。 */
  onSweep?: (result: SweepResult) => void;
  intervalMs?: number;
  log?: (msg: string) => void;
}

export interface SweepResult {
  alerts: number;
  fresh: number;
  dispatched: string[]; // qitemIds
  refused: { qitemId: string; error: string }[];
}

export class SlackOutboundDriver {
  private readonly inflight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private sweeping = false;

  constructor(private readonly deps: OutboundDriverDeps) {}

  /** 从持久 buffer 为 inflight 填种（重启不重复派发），再启动轮询。 */
  start(): void {
    try {
      for (const d of new DispatchBuffer(this.deps.home).pending()) {
        const payload = d.payload as OutboundPostPayload | undefined;
        const key = payload?.notificationKey ?? payload?.qitemId;
        if (key) this.inflight.add(key);
      }
    } catch { /* buffer 不可读时，replay 仍会在 delivery 处按 decisionId 去重。 */ }
    const interval = this.deps.intervalMs ?? 30000;
    this.timer = setInterval(() => void this.sweepOnce(), interval);
    if (typeof (this.timer as unknown as { unref?: () => void }).unref === "function") {
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }

  /** 单轮 sweep：fresh = 活跃人类 alert 减去 seen 与 inflight；逐条派发。 */
  async sweepOnce(): Promise<SweepResult> {
    if (this.sweeping) return { alerts: 0, fresh: 0, dispatched: [], refused: [] };
    this.sweeping = true;
    try {
      const alerts = await this.deps.queue.listHumanAlerts(this.deps.filter);
      const seen = this.deps.seen.load();
      const fresh = alerts.filter((q) => !seen.has(notificationKey(q)) && !this.inflight.has(notificationKey(q)));
      const dispatched: string[] = [];
      const refused: { qitemId: string; error: string }[] = [];
      for (const alert of fresh) {
        const res = this.deps.dispatch(OUTBOUND_OP, alert.destinationSession ?? "(unknown)", toPayload(alert));
        if (res.ok) {
          this.inflight.add(notificationKey(alert));
          dispatched.push(alert.qitemId);
        } else {
          // 被拒绝（例如 delivery 层未配置，导致 op 未声明）时如实记录并在下一轮重试。
          // 由于没有生成任何持久记录，这不是 retained decision。
          refused.push({ qitemId: alert.qitemId, error: res.error });
          this.deps.log?.(`拒绝为 ${alert.qitemId} 派发 outbound 消息：${res.error}`);
        }
      }
      const result = { alerts: alerts.length, fresh: fresh.length, dispatched, refused };
      this.deps.onSweep?.(result);
      return result;
    } finally {
      this.sweeping = false;
    }
  }

  /** delivery 层将 qitem 标为 seen（已送达）后，释放内存 guard。 */
  release(qitemId: string): void {
    this.inflight.delete(qitemId);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

function toPayload(q: QueueItem): OutboundPostPayload {
  return {
    qitemId: q.qitemId,
    notificationKey: q.notificationKey,
    ownerNotificationKind: q.ownerNotificationKind,
    ownerNotificationLevel: q.ownerNotificationLevel,
    humanIntent: q.humanIntent,
    humanDetail: q.humanDetail,
    summary: q.summary,
    body: q.body,
    destinationSession: q.destinationSession,
    sourceSession: q.sourceSession,
    evidenceRef: q.evidenceRef,
    tier: q.tier,
    tags: q.tags,
  };
}

function notificationKey(q: QueueItem): string {
  return q.notificationKey ?? q.qitemId;
}
