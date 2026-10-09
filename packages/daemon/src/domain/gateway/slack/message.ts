// 完整且有界的人类消息，不静默截断任何内容。
// Slack 契约核对于 2026-09-10：
// https://docs.slack.dev/reference/methods/chat.postMessage/ (4,000 recommended;
// 40,000 字符截断；顶层文本是屏幕阅读器/通知的兜底内容）
// https://docs.slack.dev/reference/block-kit/blocks/section-block/ (3,000)
// https://docs.slack.dev/reference/block-kit/blocks/ (50 blocks)
export const SLACK_TEXT_CAP = 3900; // 保守的完整 fallback 预算，并非 Slack 硬上限。
export const SLACK_SECTION_CAP = 3000;
/** @deprecated 完整渲染会忽略 excerpt 请求。 */
export const DEFAULT_BODY_EXCERPT = SLACK_SECTION_CAP;

export interface QitemLike {
  qitemId: string;
  summary?: string | null;
  body?: string | null;
  destinationSession?: string | null;
}

/** M1 A5b——outbound 图片附件。携带 media 的 OutboundDecision 包含这些值；connector 在已发布
 * outbound 路径上将每项渲染为 Slack Block Kit `image` 块。这是终于接线的 T1076 接缝
 *（Slice-12 image relay），不是重新设计。 */
export interface SlackMediaRef {
  imageUrl: string; // 可解析的图片 URL（https），绝不能是含 secret 的 URL（下方会拒绝）。
  altText: string;  // 无障碍和通知 fallback 文本。
}

export interface OutboundMessageOpts {
  sourceLabel: string; // queue 所在位置（host/box/rig），来自配置，绝不硬编码。
  /** @deprecated 已忽略：brief 要么完整渲染，要么显式拒绝。 */
  bodyExcerpt?: number;
  /** @deprecated 缺少无障碍投影时拒绝；请使用 mediaRefs。 */
  extraBlocks?: unknown[];
  /** M1 A5b：outbound 图片附件，渲染为 Block Kit `image` 块（已接线的接缝）。 */
  mediaRefs?: SlackMediaRef[];
  /** S10 / A1.2——结构化席位 attribution header（rig/host/seat/session），以一个真实 bot identity
   * 渲染为一行 sender context。Authorship 存于我们的记录；Slack transport actor 保持为 app。
   * 绝不按消息覆盖 username/icon。 */
  attribution?: SeatAttribution;
  /** S10 临时 loudness 规则：escalation 会 mention 对应 human（`<@Uxxx>`），其他消息保持
   * quiet-threaded。值是 Slack USER ID（mention 语义需要 id，绝非 display name）。 */
  mentionUserId?: string;
  /** 稳定的 decision/part identity，计入完整 fallback 预算。 */
  reconcileMarker?: string;
}

/** A1.2——四个 attribution 字段。 */
export interface SeatAttribution {
  seat: string;
  rig?: string;
  host?: string;
  session: string;
}

/** 将已盖章 session 三元组（`member@rig[@host]`，51-09 存储形式）解析为 attribution 字段。
 * 裸或不可解析 ref 降级为 seat=session，绝不抛错。 */
export function attributionFromSession(sourceSession: string | null | undefined): SeatAttribution | undefined {
  if (!sourceSession) return undefined;
  const parts = sourceSession.split("@");
  if (parts.length >= 2) {
    const a: SeatAttribution = { seat: `${parts[0]}@${parts[1]}`, rig: parts[1], session: sourceSession };
    if (parts.length >= 3) a.host = parts.slice(2).join("@");
    return a;
  }
  return { seat: sourceSession, session: sourceSession };
}

const SLACK_ALT_TEXT_CAP = 2000; // Slack 图片 alt_text 硬上限。

/** M1 A5b——把 media ref 转换为 Block Kit `image` 块。第 7 项卫生要求：含 secret 的 image_url
 *（如伪装成图片的 webhook URL）会被拒绝，绝不转发。Alt text 经脱敏和验证但不截断。只返回
 * 结构正确且无 secret 的图片块。 */
export function buildImageBlocks(mediaRefs: readonly SlackMediaRef[] | undefined): unknown[] {
  if (!mediaRefs?.length) return [];
  const blocks: unknown[] = [];
  for (const m of mediaRefs) {
    const url = String(m.imageUrl || "");
    // 只转发不含 secret 的干净 https URL（纵深防御，第 7 项）。
    if (!/^https:\/\/\S+$/.test(url) || containsSecret(url)) continue;
    blocks.push({
      type: "image",
      image_url: url,
      // R2 B1：alt text 由行携带，因此使用相同的失活 pipeline（redact + neutralize）。
      alt_text: bounded(inert(String(m.altText || "附件")), SLACK_ALT_TEXT_CAP, "图片描述"),
    });
  }
  return blocks;
}

// 拒绝转发看似 secret 的模式（第 7 项纵深防御）。
const SECRET_PATTERNS: RegExp[] = [
  /xox[baprs]-[A-Za-z0-9-]+/g, // Slack bot/user/app/refresh tokens
  /xapp-[A-Za-z0-9-]+/g, // Slack app-level (Socket Mode) token
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g, // incoming webhook URL
  /\bBearer\s+[A-Za-z0-9._-]{12,}/gi, // bearer tokens
  /xoxe\.xox[bp]-[A-Za-z0-9-]+/g, // rotation tokens
];

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => {
    p.lastIndex = 0;
    return p.test(text);
  });
}

export function redactSecrets(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p, "[redacted-secret]");
  }
  return out;
}

/** S10 fix-r1（R2 B1）——对 queue 控制内容做结构性中和。Slack 格式契约仅从字面 "<" 解析
 * 控制序列（<@U…>、<!here>、<!channel>、<!subteam^…>、<url|label>）；其文档规定显示用户生成文本
 * 时只转义 &、<、>（docs.slack.dev/messaging/formatting-message-text）。转义这三个字符会从构造上
 * 使所有新旧控制形式失活，而不是维护已知拼写 blocklist。普通 mrkdwn 样式（*bold*、_italic_、
 * 裸 URL）不使用这三个字符，因此原样保留。顺序很重要：必须先处理 "&"，否则转义本身会再次转义。 */
export function escapeSlackText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** 不可信字段 pipeline：先脱敏 secret，再中和 Slack 控制语法。 */
function inert(text: string): string {
  return escapeSlackText(redactSecrets(text));
}

/** S10 fix-r3（R2 exactly-once）——结构化 reconciliation identity：有界、按 decision 定界的 token。
 * decisionId 由后台服务逐 decision 生成（绝不能通过 queue 行设置），并在同一 decision 重试间稳定，
 * 因此只有目标 posted message 携带这个精确定界 token；引用 qitem id 的普通文本（甚至用 qitem id 构造
 * 的近似串）都无法复现。仅一个 producer 函数；reconcile scanner 精确匹配该函数输出——producer 与
 * scanner 按构造共享 identity 字节。只使用括号/冒号，不含 &、<、>，因此 token 转义稳定，绝不会解析为
 * Slack 控制语法。 */
export function reconcileToken(decisionId: string): string {
  return `(or-mark:${escapeSlackText(String(decisionId))})`;
}

export interface SlackMessagePayload {
  text: string; // 通知 fallback（始终设置）。
  blocks: unknown[]; // Block Kit（可按 T1076 扩展）。
}

export class HumanMessageShapeError extends Error {
  readonly code = "human_message_unrenderable";
}

function bounded(text: string, max: number, field: string): string {
  // 保守地按 UTF-16 unit 计算转义后的 wire 字符串。绝不截断 entity 或 surrogate pair；在任何 post
  // 之前拒绝整个请求。
  if (text.length > max) {
    throw new HumanMessageShapeError(`${field} 转义后为 ${text.length} 个 unit（上限 ${max}）。请缩短人工摘要；仅把补充上下文放入 --human-detail-file，并把 action 和选项留在主 body。`);
  }
  return text;
}

/** 纯且确定的渲染。队列元数据保留在持久请求中；人工接收者会看到一个主题、完整正文和一条
 * 发送方归属。 */
export function buildOutboundMessage(q: QitemLike, opts: OutboundMessageOpts): SlackMessagePayload {
  const summary = inert(String(q.summary || "（无摘要）"));
  const body = bounded(inert(String(q.body || "")), SLACK_SECTION_CAP, "body");
  const mention = opts.mentionUserId ? `<@${opts.mentionUserId}> :rotating_light: ` : "";
  const headline = bounded(`${mention}*${summary}*`, SLACK_SECTION_CAP, "subject");
  const attr = bounded(`来自 ${inert(opts.attribution?.session || opts.sourceLabel)}`, 2000, "发送方");
  const imageBlocks = buildImageBlocks(opts.mediaRefs);
  const attachmentText = imageBlocks.map((b) => `图片：${(b as { alt_text: string }).alt_text}`).join("\n");
  if (opts.extraBlocks?.length) {
    throw new HumanMessageShapeError("额外 block 没有完整的无障碍 fallback。图片请使用 mediaRefs，其他内容请编写补充人工详情。");
  }
  const text = bounded([headline, body, attr, attachmentText, opts.reconcileMarker].filter(Boolean).join("\n"), SLACK_TEXT_CAP, "完整 fallback");
  const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: headline } }];
  if (body.trim()) blocks.push({ type: "section", text: { type: "mrkdwn", text: body } });
  blocks.push(...imageBlocks, { type: "context", elements: [{ type: "mrkdwn", text: attr }] });
  if (blocks.length > 50) throw new HumanMessageShapeError("消息超过 50 个 Slack block。请在发送前减少附件。");
  return { text, blocks };
}
