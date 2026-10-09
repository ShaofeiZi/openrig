// Slice-11 slack-connector —— Slack HTTP 客户端。
//
// 基于 `fetch`（与 http/https 无关且可注入），对应后台服务
// WebhookNotificationAdapter 及其 fake-fetch 测试模式；每次调用都有显式超时，
// 并返回结构化失败结果（异常不越过边界，也不会永久挂起），遵循 remote-daemon-http 纪律。
//
// 条目 5（setup-scope 陷阱）：Slack 的“Add New Webhook”只授予 webhook scope；
// 完整重装前，已配置的 bot scope 不会被授予，而且没有警告。授权 scope 的唯一证据
// 是真实 API 调用响应中的 `x-oauth-scopes` 头；已配置不等于已授权。
// getGrantedScopes() 只读取该响应头。声明入站就绪前，也要实时验证频道成员关系
// （conversations.info.is_member）。

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: FetchImpl = (url, init) => fetch(url, init);
const DEFAULT_TIMEOUT_MS = 15000;

export interface HttpResult {
  ok: boolean; // 传输和状态均正常（2xx）。
  status: number;
  error?: string;
}

async function withTimeout<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`${timeoutMs}ms 后超时`)), timeoutMs);
  try {
    return await run(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 向 Slack incoming webhook 发送请求。失败必须可见（条目 3）：任何非 2xx 或传输
 * 错误都返回 ok:false 及长度受限的错误字符串；调用方明确记录错误且不把告警标记为
 * 已读，以便重试，绝不静默丢弃。
 *
 * S10：已退出生产路径。出站消息通过后台服务内子系统的 postChatMessage 发送
 * （webhook 无法携带 thread_ts）。此函数作为经过测试的通用客户端保留，生产环境
 * 已无调用方。
 */
export async function postWebhook(
  url: string,
  payload: unknown,
  fetchImpl: FetchImpl = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HttpResult> {
  try {
    return await withTimeout(timeoutMs, async (signal) => {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, status: res.status, error: `slack ${res.status}: ${text.slice(0, 160)}` };
      }
      return { ok: true, status: res.status };
    });
  } catch (e) {
    return { ok: false, status: 0, error: `Webhook 传输：${(e as Error).message}` };
  }
}

export interface WebApiResult {
  ok: boolean; // Slack 层成功（json.ok === true 且为 2xx）。
  status: number;
  grantedScopes: string[]; // 从 x-oauth-scopes 响应头解析（条目 5）。
  json: Record<string, unknown>;
  error?: string;
}

/** S10 结构修复——逐方法指定请求结构。Slack 读取方法（conversations.info/history/
 * replies）会以 `invalid_arguments` 拒绝 JSON POST（操作员实时测得）；其支持的结构
 * 是带 URL 查询参数的 GET。写入/JSON 方法（auth.test、apps.connections.open、
 * chat.postMessage、files.completeUploadExternal）逐字节保持 JSON POST；这也是默认值，
 * 因此现有调用方不会隐式改变请求结构。 */
export type WebApiRequestShape = "json-post" | "get-query";

/** 调用 Slack Web API 方法（Bearer token），并暴露已授权 scope 的响应头。 */
export async function callWebApi(
  method: string,
  token: string,
  body: Record<string, unknown>,
  fetchImpl: FetchImpl = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  shape: WebApiRequestShape = "json-post",
): Promise<WebApiResult> {
  try {
    return await withTimeout(timeoutMs, async (signal) => {
      let res: Response;
      if (shape === "get-query") {
    // 读取请求结构：参数放入查询字符串，只发送 Authorization，不带 body 或
    // content-type；该端点恰好会拒绝 body 或 JSON content-type。
        const url = new URL(`https://slack.com/api/${method}`);
        for (const [k, v] of Object.entries(body)) {
          if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
        }
        res = await fetchImpl(url.toString(), {
          method: "GET",
          headers: { authorization: `Bearer ${token}` },
          signal,
        });
      } else {
        res = await fetchImpl(`https://slack.com/api/${method}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify(body),
          signal,
        });
      }
      const scopeHeader = res.headers.get("x-oauth-scopes") ?? "";
      const grantedScopes = scopeHeader
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      let json: Record<string, unknown> = {};
      try {
        json = (await res.json()) as Record<string, unknown>;
      } catch {
      /* 非 JSON 响应。 */
      }
      const ok = res.ok && json.ok === true;
      return { ok, status: res.status, grantedScopes, json, error: ok ? undefined : String(json.error ?? `http ${res.status}`) };
    });
  } catch (e) {
    return { ok: false, status: 0, grantedScopes: [], json: {}, error: `Web API 传输：${(e as Error).message}` };
  }
}

/** 条目 5：从响应头读取实际授权的 scope（已配置不等于已授权）。 */
export async function getGrantedScopes(
  token: string,
  fetchImpl: FetchImpl = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; granted: string[]; error?: string }> {
  const r = await callWebApi("auth.test", token, {}, fetchImpl, timeoutMs);
  return { ok: r.ok, granted: r.grantedScopes, error: r.error };
}

/** OPR.0.5.6.2 —— 经过认证的私有文件下载（`url_private` + Bearer，是人机层设计
 * §4.1 中已验证的入站机制）。大小有界：body 超过 `maxBytes` 时拒绝，绝不截断后
 * 存储。Slack 的典型认证失败模式会返回状态 200 的 HTML 登录页；这里按
 * content-type 识别并明确命名，绝不把垃圾内容存成文件。错误以消息而非异常返回：
 * 调用方的失败真实性契约要求逐文件给出名称，不能因抛出异常丢失整个事件。 */
export const INBOUND_FILE_MAX_BYTES = 26_214_400; // 25 MiB——按产品限制约束写入大小。

export async function downloadPrivateFile(
  url: string,
  token: string,
  fetchImpl: FetchImpl = fetch,
  timeoutMs = 30_000,
  maxBytes = INBOUND_FILE_MAX_BYTES,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  try {
    return await withTimeout(timeoutMs, async (signal) => {
      const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal } as RequestInit);
      if (!res.ok) return { ok: false as const, error: `http ${res.status}` };
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("text/html")) {
        return { ok: false as const, error: "认证失败（Slack 返回了 HTML 页面而不是文件）" };
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > maxBytes) return { ok: false as const, error: `超过大小限制（${buf.byteLength} > ${maxBytes}）` };
      return { ok: true as const, bytes: buf };
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message || "下载失败" };
  }
}

export interface ScopeVerdict {
  ok: boolean;
  granted: string[];
  missing: string[];
  error?: string;
}

/** 条目 5：根据响应头而非配置验证令牌确实拥有所需 scope。 */
export async function verifyScopes(
  token: string,
  required: string[],
  fetchImpl: FetchImpl = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ScopeVerdict> {
  const g = await getGrantedScopes(token, fetchImpl, timeoutMs);
  if (!g.ok) return { ok: false, granted: g.granted, missing: required, error: g.error };
  const grantedSet = new Set(g.granted);
  const missing = required.filter((s) => !grantedSet.has(s));
  return { ok: missing.length === 0, granted: g.granted, missing };
}

/** 条目 5：入站就绪前验证机器人确实是频道成员。 */
export async function verifyChannelMembership(
  token: string,
  channel: string,
  fetchImpl: FetchImpl = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; isMember: boolean; name?: string; error?: string }> {
  const r = await callWebApi("conversations.info", token, { channel }, fetchImpl, timeoutMs, "get-query");
  if (!r.ok) return { ok: false, isMember: false, error: r.error };
  const ch = (r.json.channel ?? {}) as { is_member?: boolean; name?: string };
  return { ok: true, isMember: ch.is_member === true, name: ch.name };
}

/** 入站 Socket Mode：通过 apps.connections.open 打开 WebSocket URL（应用级 xapp 令牌）。 */
export async function openSocketConnection(
  appToken: string,
  fetchImpl: FetchImpl = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const r = await callWebApi("apps.connections.open", appToken, {}, fetchImpl, timeoutMs);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, url: r.json.url as string };
}

// ── S10 出站图片——EXTERNAL-UPLOAD 流程（唯一仍在使用的上传路径）──────────────
// `files.upload` 已于 2025-11-12 停用，不再工作（已验证可用性）。流程如下：
//   1. files.getUploadURLExternal (filename, length)  → { upload_url, file_id }
//   2. 将原始字节 POST 到 upload_url（octet-stream）
//   3. files.completeUploadExternal ({ files, channel_id, thread_ts?, initial_comment? })
// Scope：files:write。thread_ts 把文件附加到对话线程中。

export async function getUploadURLExternal(
  token: string,
  filename: string,
  length: number,
  fetchImpl: FetchImpl = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; uploadUrl?: string; fileId?: string; error?: string }> {
  const r = await callWebApi("files.getUploadURLExternal", token, { filename, length }, fetchImpl, timeoutMs);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, uploadUrl: r.json.upload_url as string, fileId: r.json.file_id as string };
}

/** 第 2 段：把原始字节 POST 到预签名上传 URL（octet-stream，不带认证头）。 */
export async function uploadBytesExternal(
  uploadUrl: string,
  bytes: Uint8Array,
  fetchImpl: FetchImpl = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<HttpResult> {
  try {
    return await withTimeout(timeoutMs, async (signal) => {
      const res = await fetchImpl(uploadUrl, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: bytes as unknown as RequestInit["body"],
        signal,
      });
      if (!res.ok) return { ok: false, status: res.status, error: `upload ${res.status}` };
      return { ok: true, status: res.status };
    });
  } catch (e) {
    return { ok: false, status: 0, error: `上传传输：${(e as Error).message}` };
  }
}

export async function completeUploadExternal(
  token: string,
  input: { files: { id: string; title?: string }[]; channelId: string; threadTs?: string; initialComment?: string },
  fetchImpl: FetchImpl = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; error?: string }> {
  const body: Record<string, unknown> = { files: input.files, channel_id: input.channelId };
  if (input.threadTs) body.thread_ts = input.threadTs;
  if (input.initialComment) body.initial_comment = input.initialComment;
  const r = await callWebApi("files.completeUploadExternal", token, body, fetchImpl, timeoutMs);
  return { ok: r.ok, error: r.error };
}

/** S10（H）——读取近期消息文本以按标记对账：超时属于有歧义的结果（消息可能已经
 * 送达），因此重新发送前，发送方先搜索嵌入的记录 ID 标记。设置 threadTs 时读取
 * conversations.replies（线程回复位于其线程中，而非频道历史）；未设置时读取
 * conversations.history。操作只读且有界。 */
export async function fetchRecentMessageTexts(
  token: string,
  channel: string,
  threadTs: string | undefined,
  fetchImpl: FetchImpl = defaultFetch,
  limit = 100,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; texts: string[]; messages: { text: string; ts: string }[]; error?: string }> {
  const method = threadTs ? "conversations.replies" : "conversations.history";
  const body: Record<string, unknown> = threadTs ? { channel, ts: threadTs, limit } : { channel, limit };
  const r = await callWebApi(method, token, body, fetchImpl, timeoutMs, "get-query");
  if (!r.ok) return { ok: false, texts: [], messages: [], error: r.error };
  const messages = (r.json.messages ?? []) as { text?: string; ts?: string }[];
  // S14 修复：将每条消息的真实 Slack ts 与文本一起保留。按标记对账的路径需要
  // 匹配消息的 ts 来打开线程映射，并用真实锚点标记回执，而不是合成值。
  const shaped = messages.map((m) => ({ text: String(m.text ?? ""), ts: String(m.ts ?? "") }));
  return { ok: true, texts: shaped.map((m) => m.text), messages: shaped };
}

export interface PostChatMessageInput {
  channel: string;
  text: string; // 通知回退文本，始终设置（已验证可用性：所有发送均保留 text 参数）。
  blocks?: unknown[];
  /** 线程回复：父消息的 ts（绝不是回复自身的 ts，这是可用性判别条件）。 */
  thread_ts?: string;
}

export type PostChatMessageResult =
  | { ok: true; status: number; ts: string }
  | { ok: false; status: number; error?: string };

/** S10 —— 通过 Web API（`chat.postMessage`）发送出站消息。R2 原生结构需要
 * thread_ts，而 incoming webhook 无法携带它，因此 webhook 路径随中继一起退役。
 * A1.2 身份护栏：本函数绝不接受逐消息的 `username`/`icon_*` 覆盖；应用自身身份
 * 是唯一出站身份（证明不存在自定义入口）。返回已发送消息的 ts，作为新会话根的
 * 线程锚点。 */
export async function postChatMessage(
  token: string,
  input: PostChatMessageInput,
  fetchImpl: FetchImpl = defaultFetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<PostChatMessageResult> {
  const body: Record<string, unknown> = { channel: input.channel, text: input.text };
  if (input.blocks?.length) body.blocks = input.blocks;
  if (input.thread_ts) body.thread_ts = input.thread_ts;
  const r = await callWebApi("chat.postMessage", token, body, fetchImpl, timeoutMs);
  if (!r.ok) return { ok: false, status: r.status, error: r.error };
  const ts = typeof r.json.ts === "string" ? r.json.ts.trim() : "";
  if (!ts) {
    return { ok: false, status: r.status, error: "chat.postMessage 返回 ok，但没有消息 ts" };
  }
  return { ok: true, status: r.status, ts };
}
