// PL-005 Phase B：Mission Control 通知 dispatcher。
//
// 订阅 EventBus 上的相关 event，并通过配置的通知 adapter POST（默认 ntfy，也可用 webhook）。
// delivery 尽力而为；失败不会中断被通知的底层 action，这是 PRD 不变量。为审计轨迹发出
// `mission_control.notification_sent` / `_failed`。
//
// 触发条件（Phase B v0）：
//   - 必选：human-gate qitem 到达。通过 Phase A coordination event `queue.created` 检测，
//     其中新建 qitem 的 tier == "human-gate"。
//   - 可选：verb 完成。opts.includeVerbCompletion 为 true 时也派发
//     `mission_control.action_executed` event。
//
// 只有一个通知目标，即操作员手机。MVP 不提供多用户路由或逐用户 opt-in matrix。

import type Database from "better-sqlite3";
import type { EventBus } from "../event-bus.js";
import type { PersistedEvent } from "../types.js";
import type {
  NotificationAdapter,
  NotificationPayload,
} from "./notification-adapter-types.js";

export interface NotificationDispatcherDeps {
  db: Database.Database;
  eventBus: EventBus;
  adapter: NotificationAdapter;
  /**
   * 为 true 时，在 `mission_control.action_executed` event（verb 完成）上派发。默认 false：
   * 按 planner brief 的必选触发条件，默认只响应 human-gate 到达。
   */
  includeVerbCompletion?: boolean;
  missionControlBaseUrl?: string;
  now?: () => Date;
}

interface QueueRow {
  qitem_id: string;
  source_session: string;
  destination_session: string;
  tier: string | null;
  body: string;
}

export class MissionControlNotificationDispatcher {
  private readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly adapter: NotificationAdapter;
  private readonly includeVerbCompletion: boolean;
  private readonly missionControlBaseUrl: string | null;
  private readonly now: () => Date;
  private unsubscribe: (() => void) | null = null;
  /** 按 (qitem_id, mechanism) 保存的 drop set，用于逐 qitem 单次去重。 */
  private readonly dispatchedKeys = new Set<string>();

  constructor(deps: NotificationDispatcherDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.adapter = deps.adapter;
    this.includeVerbCompletion = Boolean(deps.includeVerbCompletion);
    this.missionControlBaseUrl = normalizeBaseUrl(deps.missionControlBaseUrl);
    this.now = deps.now ?? (() => new Date());
  }

  /** 订阅相关 EventBus event。幂等。 */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.eventBus.subscribe((event) => {
      void this.handleEvent(event);
    });
  }

  /** 取消订阅并清空 dedup set。幂等。 */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.dispatchedKeys.clear();
  }

  /**
   * 通过已配置 adapter 发送一条合成通知，让操作员验证设置。由
   * `POST /api/mission-control/notifications/test` 路由使用。
   */
  async sendTest(): Promise<{
    mechanism: string;
    target: string;
    ok: boolean;
    ack?: string;
    error?: string;
  }> {
    const payload: NotificationPayload = {
      title: "Mission Control 测试通知",
      body: `来自 zrig 后台服务的合成测试，时间 ${this.now().toISOString()}`,
      tags: ["openrig", "mission-control", "test"],
    };
    const result = await this.adapter.send(payload);
    if (result.ok) {
      this.emitSent(null, "test");
    } else {
      this.emitFailed(null, result.error ?? "unknown");
    }
    return {
      mechanism: this.adapter.mechanism,
      target: this.adapter.target,
      ok: result.ok,
      ack: result.ack,
      error: result.error,
    };
  }

  private async handleEvent(event: PersistedEvent): Promise<void> {
    if (event.type === "queue.created") {
      const qitem = this.lookupQitem(event.qitemId);
      if (!qitem || qitem.tier !== "human-gate") return;
      // 必选触发条件：human-gate qitem 到达。
      await this.dispatch({
        triggerKind: "human-gate-arrival",
        qitemId: qitem.qitem_id,
        title: "human-gate qitem 已到达",
        body:
          `新的 human-gate qitem ${qitem.qitem_id}：${qitem.source_session} → ${qitem.destination_session}\n\n` +
          truncateBody(qitem.body, 280),
        tags: ["openrig", "mission-control", "human-gate"],
      });
      return;
    }
    if (event.type === "mission_control.action_executed" && this.includeVerbCompletion) {
      await this.dispatch({
        triggerKind: "verb-completion",
        qitemId: event.qitemId,
        title: `verb 已完成：${event.actionVerb}`,
        body: `${event.actorSession} 已在 qitem ${event.qitemId ?? "（无）"} 上完成 Mission Control verb ${event.actionVerb}`,
        tags: ["openrig", "mission-control", "verb-complete"],
      });
      return;
    }
  }

  private async dispatch(input: {
    /** 作为 dedup key 的一部分，避免同一 qitem 的不同 trigger 互相抑制；human-gate-arrival
     * 与 verb-completion 是不同 event。 */
    triggerKind: string;
    qitemId: string | null;
    title: string;
    body: string;
    tags?: string[];
  }): Promise<void> {
    const dedupKey = `${input.qitemId ?? "no-qitem"}::${input.triggerKind}::${this.adapter.mechanism}`;
    if (this.dispatchedKeys.has(dedupKey)) return;
    this.dispatchedKeys.add(dedupKey);
    const result = await this.adapter.send({
      title: input.title,
      body: input.body,
      qitemRef: this.qitemRef(input.qitemId),
      tags: input.tags,
    });
    if (result.ok) {
      this.emitSent(input.qitemId, result.ack ?? "ok");
    } else {
      this.emitFailed(input.qitemId, result.error ?? "unknown");
    }
  }

  private emitSent(qitemId: string | null, _ack: string): void {
    this.eventBus.emit({
      type: "mission_control.notification_sent",
      mechanism: this.adapter.mechanism,
      target: this.adapter.target,
      qitemId,
      sentAt: this.now().toISOString(),
    });
  }

  private emitFailed(qitemId: string | null, error: string): void {
    this.eventBus.emit({
      type: "mission_control.notification_failed",
      mechanism: this.adapter.mechanism,
      target: this.adapter.target,
      qitemId,
      error,
      failedAt: this.now().toISOString(),
    });
  }

  private lookupQitem(qitemId: string): QueueRow | null {
    const row = this.db
      .prepare(
        `SELECT qitem_id, source_session, destination_session, tier, body
           FROM queue_items WHERE qitem_id = ? LIMIT 1`,
      )
      .get(qitemId) as QueueRow | undefined;
    return row ?? null;
  }

  private qitemRef(qitemId: string | null): string | undefined {
    if (!qitemId) return undefined;
    if (!this.missionControlBaseUrl) return qitemId;
    const url = new URL("/mission-control", this.missionControlBaseUrl);
    url.searchParams.set("view", "human-gate");
    url.searchParams.set("qitem", qitemId);
    return url.toString();
  }

  /** 测试/可观测性：清空逐 qitem 单次去重 set。 */
  resetDedupForTest(): void {
    this.dispatchedKeys.clear();
  }
}

function truncateBody(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function normalizeBaseUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.toString();
  } catch {
    return null;
  }
}
