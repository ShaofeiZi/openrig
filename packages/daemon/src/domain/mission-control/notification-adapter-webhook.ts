// PL-005 Phase B：通用 webhook adapter（操作员可路由的替代方案）。
//
// 记录稳定的 JSON body 结构，使操作员可通过 Slack incoming webhook、Discord、Telegram bot
// 或自有基础设施 POST。

import type {
  NotificationAdapter,
  NotificationDeliveryResult,
  NotificationPayload,
} from "./notification-adapter-types.js";

export interface WebhookAdapterOpts {
  /** 完整 webhook endpoint URL。 */
  endpointUrl: string;
  /** 供测试使用的可选 fetch override。 */
  fetchImpl?: typeof fetch;
  /** 可选额外 header（如 `X-Webhook-Signature`）。 */
  extraHeaders?: Record<string, string>;
}

export interface WebhookBodyShape {
  source: "openrig.mission-control";
  schema_version: 1;
  title: string;
  body: string;
  qitem_ref?: string;
  tags?: string[];
  emitted_at: string;
}

export class WebhookNotificationAdapter implements NotificationAdapter {
  readonly mechanism = "webhook";
  readonly target: string;
  private readonly fetchImpl: typeof fetch;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: WebhookAdapterOpts) {
    this.target = opts.endpointUrl;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.extraHeaders = opts.extraHeaders ?? {};
  }

  async send(payload: NotificationPayload): Promise<NotificationDeliveryResult> {
    const body: WebhookBodyShape = {
      source: "openrig.mission-control",
      schema_version: 1,
      title: payload.title,
      body: payload.body,
      qitem_ref: payload.qitemRef,
      tags: payload.tags,
      emitted_at: new Date().toISOString(),
    };
    try {
      const res = await this.fetchImpl(this.target, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.extraHeaders,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        return { ok: false, error: `webhook POST ${res.status}` };
      }
      return { ok: true, ack: `webhook ${res.status}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
