// PL-005 阶段 B：共用的通知适配器契约。
//
// 每个适配器都实现 `send(payload)`。dispatcher 在构造时根据操作方的通知机制配置选择适配器。

export interface NotificationPayload {
  /** 简短的人类可读标题，例如“human-gate qitem 已到达”。 */
  title: string;
  /** 较长的正文，可包含 qitem id、来源 rig 和动作动词。 */
  body: string;
  /** 可选的 qitem 引用（URL 或 id），用于点击跳转。 */
  qitemRef?: string;
  /** 操作方提供的下游路由标签，例如 Slack channel。 */
  tags?: string[];
}

export interface NotificationDeliveryResult {
  ok: boolean;
  /** ok=true 时为 provider 侧 ack，例如 httpStatus、message-id。 */
  ack?: string;
  /** ok=false 时为人类可读错误。 */
  error?: string;
}

export interface NotificationAdapter {
  /** 用于事件和审计的 adapter 机制标签。 */
  readonly mechanism: string;
  /** 目标描述符，例如 ntfy topic URL 或 webhook endpoint URL。 */
  readonly target: string;
  send(payload: NotificationPayload): Promise<NotificationDeliveryResult>;
}
