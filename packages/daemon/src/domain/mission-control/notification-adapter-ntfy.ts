// PL-005 阶段 B：ntfy.sh 适配器（按 planner brief 为默认实现）。
//
// ntfy.sh 契约：向 https://ntfy.sh/<topic> 发出 HTTP POST，以 body 作为通知文本。
// Title、Click、Tags 等请求头决定渲染形式。它免费、可自托管，通过简单 HTTP POST
// 即可向操作员手机推送通知（手机上的 ntfy 应用订阅该 topic）。

import type {
  NotificationAdapter,
  NotificationDeliveryResult,
  NotificationPayload,
} from "./notification-adapter-types.js";

export interface NtfyAdapterOpts {
  /**
   * 完整 topic URL，例如 `https://ntfy.sh/my-private-topic-abc123`，
   * 或自托管的 `https://ntfy.example.com/operator-phone`。
   */
  topicUrl: string;
  /** 测试可选的 fetch 覆盖实现。 */
  fetchImpl?: typeof fetch;
}

export class NtfyNotificationAdapter implements NotificationAdapter {
  readonly mechanism = "ntfy";
  readonly target: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: NtfyAdapterOpts) {
    this.target = opts.topicUrl;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async send(payload: NotificationPayload): Promise<NotificationDeliveryResult> {
    const headers: Record<string, string> = {
      Title: truncateHeader(payload.title, 250),
    };
    if (payload.qitemRef) headers.Click = payload.qitemRef;
    if (payload.tags && payload.tags.length > 0) {
      headers.Tags = payload.tags.join(",");
    }
    try {
      const res = await this.fetchImpl(this.target, {
        method: "POST",
        headers,
        body: payload.body,
      });
      if (!res.ok) {
        return { ok: false, error: `ntfy POST ${res.status}` };
      }
      return { ok: true, ack: `ntfy ${res.status}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/** ntfy 请求头必须是单行 ASCII；移除换行并按长度截断。 */
function truncateHeader(s: string, max: number): string {
  const cleaned = s.replace(/[\r\n]+/g, " ").trim();
  return cleaned.length > max ? cleaned.slice(0, max - 1) + "…" : cleaned;
}
