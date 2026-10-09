// V0.3.1 slice 23 founder-walk-queue-handoff-envelope。
//
// 后台服务侧的邮件风格信封渲染器：当 peer 通过 `zrig send` 发送消息，或 queue handoff/create
// 发出提醒时，接收方的 tmux pane 会显示它。用 From/To/---/正文/---/↩ 回复 包裹正文，
// 同时提供发送方身份和可复制粘贴的回复提示。
//
// 与 CLI 的一致性契约：`packages/cli/src/commands/send.ts :: wrapSendBody` 对相同输入必须
// 产出逐字节相同的输出。两个实现位于不同包，因为 CLI 与后台服务目前不跨包导入；契约通过：
//   1. 相同函数体（视觉 diff）
//   2. `packages/daemon/test/pane-envelope.test.ts` 镜像
//      `packages/cli/test/send-header.test.ts` 中的断言
//   3. 实时集成一致性（HG-5）：发往同一目标的 queue handoff 提醒与 zrig send 除正文外，
//      渲染结果逐字节一致
// 若修改此函数，必须同步更新 wrapSendBody。

const SENDER_FALLBACK = "<unknown sender>";

/** Send/broadcast 头部信封元数据（裁定 03c35295）。ENVELOPE 携带机器事实；渲染头部是其投影。
 * 本实现与 CLI wrapSendBody 两个孪生共享此结构。 */
export interface EnvelopeScope {
  /** dm = 单个接收方；multi = 具名接收方集合；rig-broadcast/topology = 带规模的广播。 */
  kind: "dm" | "multi" | "rig-broadcast" | "topology";
  /** multi：完整接收方列表（谁收到了）。 */
  recipients?: string[];
  /** rig-broadcast：rig + 席位数（防风暴规模）。 */
  rig?: string;
  seats?: number;
}
export interface EnvelopeMeta {
  /** ISO-8601，在发送时由传输层只盖章一次。渲染只读取，绝不重新派生
   *（51-02 禁止在投影读取时计算墙上时钟）。 */
  stampISO?: string;
  scope?: EnvelopeScope;
  /** GHOST-STAGE (g)：发送方的 atom-B occupant generation-uuid，在发送时由传输层只解析一次
   *（与 stampISO 为同一接缝）。使接收方能把延迟的生命周期消息归属于编写该消息的代，而不是
   * 继承为当前 occupant 的消息。ABSENT ⇒ UNKNOWN（发送方不在本地的跨主机 --from 中继，或
   * tenure 之前的后台服务）；渲染会省略它，绝不伪造代。渲染是此机器事实的投影。 */
  genUuid?: string;
}

/** To 行投影 + 防风暴规模（仅头部即可区分，裁定 pin 2）。 */
export function renderToLine(recipient: string, scope?: EnvelopeScope): string {
  if (!scope || scope.kind === "dm") return `To: ${recipient}`;
  if (scope.kind === "multi") return `To: ${(scope.recipients ?? [recipient]).join(", ")}`;
  if (scope.kind === "rig-broadcast") return `To: 广播到 ${scope.rig}（${scope.seats} 个席位）`;
  return "To: 广播到 topology";
}

/** 从传输 ISO 生成易于扫读的短时间戳 MM-DD HH:MMZ（12 个字符，裁定 pin 3）。 */
export function renderShortStamp(stampISO: string): string {
  return `${stampISO.slice(5, 7)}-${stampISO.slice(8, 10)} ${stampISO.slice(11, 16)}Z`;
}

/** GHOST-STAGE (h)：仅当 compose→write 间隔超过此阈值时，才把投递标为延迟。10 秒显然超出
 * idle-wait 抖动，明确表示“发生过等待”；低于阈值的间隔不渲染任何内容（测量遥测：标记而非
 * 亚秒噪声）。只使用一个具名常量。 */
export const DELIVERED_LATENCY_FLAG_MS = 10_000;

/** GHOST-STAGE (h)：在写入时把相对投递延迟片段追加到 Sent: 行（仅后台服务侧；CLI 只组合，
 * 从不投递到 pane，因此这里没有 compose 孪生）。`deltaMs` = 写入时间 − Sent: stampISO，表示消息
 * 从组合后等待了多久。只有真正延迟的投递（deltaMs ≥ DELIVERED_LATENCY_FLAG_MS）才渲染片段；
 * 使用整秒及 g 的 gen 后缀风格（' · 已投递 +12s'）。sent ISO + 此差值即可得到绝对投递时间。
 * 包含边界（g 的 ' · gen ' 对应项）：片段只追加到头部块内（第一个 "\n---\n" 之前）的 Sent: 行，
 * 因此正文中即使出现 ' · 已投递 …' 也不会被误认为真实 stamp。没有 Sent: 行（无信封/无 meta
 * 的发送）则原样返回。 */
export function appendDeliveredSegment(envelope: string, deltaMs: number): string {
  if (!Number.isFinite(deltaMs) || deltaMs < DELIVERED_LATENCY_FLAG_MS) return envelope;
  const marker = "\n---\n";
  const idx = envelope.indexOf(marker);
  const headerBlock = idx === -1 ? envelope : envelope.slice(0, idx);
  const rest = idx === -1 ? "" : envelope.slice(idx);
  const lines = headerBlock.split("\n");
  const sentIdx = lines.findIndex((l) => l.startsWith("Sent: "));
  if (sentIdx === -1) return envelope;
  lines[sentIdx] = `${lines[sentIdx]} · 已投递 +${Math.floor(deltaMs / 1000)}s`;
  return lines.join("\n") + rest;
}

/** 用 canonical From/To 信封包裹 tmux pane 正文。接收方 pane 同时看到发送方身份和回复提示。
 * 跨主机提醒不得重复包裹：远程 rig 处理同一命令时会自行包裹（与 `wrapSendBody` 的跨主机
 * 特例一致）。`meta`（裁定 03c35295）投影接收方规模与传输层时间戳；缺失时保持当前精确的
 * DM 信封（在所有发送界面都传递该参数前保持向后兼容）。 */
export function wrapPaneEnvelope(
  sender: string | undefined,
  recipient: string,
  body: string,
  meta?: EnvelopeMeta,
): string {
  // 创始人根不变量（2026-08-27，取代 51-09 增量 3/裁定 cb19867f Q2 的总是后缀）：发送方
  // 按收到的内容原样渲染。本地发送方是裸 member@rig（回复提示可在本地复制粘贴）；跨主机到达
  // 已从转发边界携带来源三元组，继续原样传递；wrapper 绝不向任何内容追加当前主机 id。
  const senderLabel = sender && sender.trim().length > 0 ? sender : SENDER_FALLBACK;
  const header = [`From: ${senderLabel}`, renderToLine(recipient, meta?.scope)];
  if (meta?.stampISO) {
    // GHOST-STAGE (g)：发送方 occupant generation 作为短后缀附在 Sent: 行上（UUID 前 8 位，
    // 可在逐节点规模区分；台账保留完整 UUID 以精确 join）。gen 缺失时完全省略后缀，绝不写
    // “gen unknown”或伪造值。后缀按位置绑定到 Sent: 头部行；正文行始终在第一个 "---" 之后，
    // 可以包含 " · gen …"，但无法注入 Sent: 行，从而保证包含边界。
    const genSuffix = meta.genUuid && meta.genUuid.length > 0 ? ` · gen ${meta.genUuid.slice(0, 8)}` : "";
    header.push(`Sent: ${renderShortStamp(meta.stampISO)}${genSuffix}`);
  }
  const reply = senderLabel.endsWith("@external")
    ? `↩ 如需回复：zrig queue create --destination ${senderLabel} --body "..." --verify`
    : `↩ 回复：zrig send ${senderLabel} "..."`;
  return [...header, "---", body, "---", reply].join("\n");
}
