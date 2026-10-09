// OPR.0.6.0.5——Slack connector 的 canonical capability 集合，作为纯常量（无 import、无 I/O）。
// config.ts、inbound.ts 和已发布 app manifest 都读取这些值，因此无需加载配置即可构建 manifest，
// 且不会偏离 connector 实际检查和接纳的内容。

/** 基线 bot scope：`rig slack verify` 检查的默认 `requiredScopes`。 */
export const BASELINE_REQUIRED_SCOPES: readonly string[] = ["chat:write", "channels:history", "channels:read"];

/** 已发布 connector 代码除基线外使用的 bot scope。`rig slack verify` 不要求这些 scope，因此
 * 基线 READY 不能证明这些功能已获授权。app manifest 会请求它们；每个条目指明所需代码路径。 */
export const FEATURE_SCOPES: ReadonlyArray<{ scope: string; usedBy: string }> = [
  { scope: "files:read", usedBy: "inbound 附件：经过认证的 url_private 下载（slack-subsystem inbound 文件端口）" },
  { scope: "files:write", usedBy: "outbound 附件：files.getUploadURLExternal / files.completeUploadExternal（slack-api）" },
  { scope: "app_mentions:read", usedBy: "inbound 路径接纳的 app_mention event（ADMITTED_EVENT_TYPES）" },
];

/** inbound 路径接纳的 Slack event payload 类型（ingestDecision 的 `type` gate）。 */
export const ADMITTED_EVENT_TYPES: readonly string[] = ["message", "app_mention"];

/** 已接纳 payload 类型 → 要订阅的 Slack bot event 及 Slack 所需 scope。订阅名不总等于 payload
 * 类型：`message.channels` 投递 `message` 类型的 payload。只支持公共频道，不订阅 DM 或私有频道。 */
export const EVENT_SUBSCRIPTIONS: Readonly<Record<string, { subscription: string; scope: string }>> = {
  message: { subscription: "message.channels", scope: "channels:history" },
  app_mention: { subscription: "app_mention", scope: "app_mentions:read" },
};
