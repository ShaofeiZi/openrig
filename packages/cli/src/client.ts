import fs from "node:fs";
import path from "node:path";
import { ConfigStore } from "./config-store.js";
import { readOpenRigEnv } from "./openrig-compat.js";
import { fetchWithTimeout, FetchTimeoutError } from "./fetch-with-timeout.js";
import { readLocalOrigin } from "./local-origin.js";

export function terminalAuthHeaders(): Record<string, string> {
  const token = resolveTerminalToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** 携带调用方席位身份的请求头，在传输检查点一次性派生。 */
export const SENDER_IDENTITY_HEADER = "X-OpenRig-Session";

/**
 * P18 发送方来源——从席位环境变量派生调用方身份（绝不用请求体声称的值）。
 * 将作者记录到频道记录中的路由只读此请求头，因此有 bug 的/过期的调用方
 * 无法通过手误或复制过期的请求体字段来写入虚假历史。
 * 无环境变量 ⇒ 无请求头 ⇒ 后台服务投递并标注写入 `claimed:v1`
 * （P18 投递并标注；完全没有 actor 的写入返回 400 actor_required——
 * 这是参数完整性问题，不是拒绝）。一个检查点：`DaemonClient.fetch`
 * 在每个请求上盖印；调用方绝不手动设置。
 */
export function senderIdentityHeaders(originSelfHostId?: string): Record<string, string> {
  const session = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME")?.trim();
  if (!session) return {};
  // 保留已限定的发送方；仅追加本地派生的实例 id。
  const value =
    originSelfHostId && originSelfHostId.length > 0 && session.split("@").length < 3
      ? `${session}@${originSelfHostId}`
      : session;
  return { [SENDER_IDENTITY_HEADER]: value };
}

/** 构造已注册的远程客户端，origin 从本实例的持久存储派生。 */
export function remoteDaemonClient(
  clientFactory: (baseUrl: string) => DaemonClient,
  url: string,
  originSelfHostId?: string,
): DaemonClient {
  const client = clientFactory(url);
  client.originSelfHostId = originSelfHostId;
  client.remoteTarget = true;
  return client;
}

function resolveTerminalToken(): string | null {
  const env = process.env.OPENRIG_TERMINAL_BEARER_TOKEN?.trim();
  if (env) return env;
  try {
    const homeDir = process.env.OPENRIG_HOME ?? path.join(process.env.HOME ?? "", ".openrig");
    const tokenPath = path.join(homeDir, "terminal-token");
    const token = fs.readFileSync(tokenPath, "utf-8").trim();
    return token || null;
  } catch {
    return null;
  }
}

export class DaemonConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonConnectionError";
  }
}

/**
 * 慢响应：请求到达了时限但没有回复。是 DaemonConnectionError 的子类，
 * 因此现有调用方仍能捕获它，但可区分以便 CLI 渲染"慢，不是停了"
 * 而不是后台服务宕机的措辞。
 */
export class DaemonTimeoutError extends DaemonConnectionError {
  constructor(message: string) {
    super(message);
    this.name = "DaemonTimeoutError";
  }
}

/**
 * 坏响应：后台服务回复了，但正文无法作为 JSON 读取
 * （截断 / 不可解析 / 非 JSON——后台服务饱和下的真实症状）。
 * 与停止或不可达的后台服务不同：请求确实已投递且结果未知，
 * 因此绝不能渲染为后台服务未运行。
 */
export class DaemonResponseError extends Error {
  readonly status: number;
  readonly bodySnippet: string;
  constructor(status: number, body: string) {
    super(`后台服务返回了不可读的响应（HTTP ${status}）。`);
    this.name = "DaemonResponseError";
    this.status = status;
    this.bodySnippet = body.slice(0, 200);
  }
}

export interface DaemonResponse<T = unknown> {
  status: number;
  data: T;
}

interface DaemonRequestOptions {
  timeoutMs?: number;
  /** 每次调用的请求头覆盖（例如 `Authorization: Bearer ...`）。 */
  headers?: Record<string, string>;
}

interface DaemonClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class DaemonClient {
  readonly baseUrl: string;
  private fetchImpl: typeof fetch = fetch;
  private timeoutMs = 5_000;
  /** 由 remoteDaemonClient 设置；远程请求上缺失 origin 会被显式标注。 */
  originSelfHostId?: string;
  remoteTarget = false;
  private identity?: Promise<Record<string, string>>;
  private originUnknown = false;

  private async identityHeaders(): Promise<Record<string, string>> {
    const localHeaders = senderIdentityHeaders();
    const session = localHeaders[SENDER_IDENTITY_HEADER];
    if (!session || session.split("@").length >= 3) return localHeaders;
    const directTarget = readOpenRigEnv("OPENRIG_URL", "RIGGED_URL");
    if (!this.remoteTarget && !directTarget) return localHeaders;
    const origin = this.originSelfHostId ?? readLocalOrigin();
    if (!origin) {
      this.originUnknown = true;
      return { ...localHeaders, "X-OpenRig-Origin-Unknown": "true" };
    }
    if (!this.remoteTarget) {
      // 环回可能是转发的端点。只有匹配的实例身份才能证明本地性。
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const target = await Promise.race([
          (async () => {
            const res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/healthz`, { signal: controller.signal });
            return res.ok ? (await res.json() as { selfHostId?: unknown }).selfHostId : undefined;
          })(),
          new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), Math.min(this.timeoutMs, 1000)); }),
        ]);
        if (target === origin) return localHeaders;
      } catch { /* 未证明本地性：携带已知 origin，绝不携带端点身份。 */ }
      finally { clearTimeout(timer); controller.abort(); }
    }
    return senderIdentityHeaders(origin);
  }

  constructor(baseUrl?: string, options?: DaemonClientOptions) {
    if (baseUrl) {
      this.baseUrl = baseUrl;
    } else {
      const envUrl = readOpenRigEnv("OPENRIG_URL", "RIGGED_URL");
      if (envUrl) {
        this.baseUrl = envUrl;
      } else {
        // 从配置解析（env > file > defaults）
        const config = new ConfigStore().resolve();
        this.baseUrl = `http://${config.daemon.host}:${config.daemon.port}`;
      }
    }

    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.timeoutMs = options?.timeoutMs ?? 5_000;
  }

  async get<T = unknown>(path: string, options?: DaemonRequestOptions): Promise<DaemonResponse<T>> {
    return this.requestJson<T>(path, { method: "GET" }, options);
  }

  async getText(path: string, options?: DaemonRequestOptions): Promise<DaemonResponse<string>> {
    return this.requestText(path, { method: "GET" }, options);
  }

  async post<T = unknown>(path: string, body?: unknown, options?: DaemonRequestOptions): Promise<DaemonResponse<T>> {
    return this.requestJson<T>(path, {
      method: "POST",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, options);
  }

  async postText<T = unknown>(path: string, text: string, contentType = "text/yaml", extraHeaders?: Record<string, string>, options?: DaemonRequestOptions): Promise<DaemonResponse<T>> {
    return this.requestJson<T>(path, {
      method: "POST",
      headers: { "Content-Type": contentType, ...extraHeaders },
      body: text,
    }, options);
  }

  async postExpectText(path: string, body?: unknown, options?: DaemonRequestOptions): Promise<DaemonResponse<string>> {
    return this.requestText(path, {
      method: "POST",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, options);
  }

  async delete<T = unknown>(path: string, options?: DaemonRequestOptions): Promise<DaemonResponse<T>> {
    return this.requestJson<T>(path, {
      method: "DELETE",
      headers: options?.headers,
    }, options);
  }

  async put<T = unknown>(path: string, body?: unknown, options?: DaemonRequestOptions): Promise<DaemonResponse<T>> {
    const baseHeaders: Record<string, string> = body !== undefined ? { "Content-Type": "application/json" } : {};
    const headers = { ...baseHeaders, ...(options?.headers ?? {}) };
    return this.requestJson<T>(path, {
      method: "PUT",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, options);
  }

  private async fetch(path: string, init: RequestInit, options?: DaemonRequestOptions): Promise<Response> {
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    if (options?.headers) {
      init = { ...init, headers: { ...(init.headers as Record<string, string> ?? {}), ...options.headers } };
    }
    // P18 发送方来源：最后盖印席位派生的身份请求头，因此是传输层——
    // 绝不调用方提供的请求头或请求体——决定频道记录所记录的调用方身份。
    // 已知远程或未证明的直连端点携带 origin；已证明的本地请求保持裸头。
    this.identity ??= this.identityHeaders();
    init = { ...init, headers: { ...(init.headers as Record<string, string> ?? {}), ...await this.identity } };
    try {
      const response = await fetchWithTimeout(
        this.fetchImpl,
        `${this.baseUrl}${path}`,
        init,
        {
          timeoutMs,
          timeoutMessage: `请求 ${this.baseUrl}${path} 在 ${timeoutMs}ms 后超时`,
        },
      );
      if (response.ok && this.originUnknown) {
        console.error("来源实例未知：本地持久身份不可用；继续以来源未知的来源标注投递。");
        this.originUnknown = false;
      }
      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 慢响应（超时的请求）与无法连接是不同类别：
      // 后台服务可能已启动但已饱和。作为子类暴露，以便调用方
      // 仍捕获 DaemonConnectionError，但 CLI 可以说"慢，不是停了"。
      if (err instanceof FetchTimeoutError) {
        throw new DaemonTimeoutError(`位于 ${this.baseUrl} 的 zrig 后台服务未及时响应：${msg}`);
      }
      throw new DaemonConnectionError(`无法连接到位于 ${this.baseUrl} 的 zrig 后台服务：${msg}`);
    }
  }

  private async requestJson<T>(path: string, init: RequestInit, options?: DaemonRequestOptions): Promise<DaemonResponse<T>> {
    const res = await this.fetch(path, init, options);
    // 先读取原始正文，再解析——这样截断/不可解析的响应
    // （后台服务饱和下的真实症状）会作为带状态码和有限片段的
    // DaemonResponseError 暴露，而不是原始 SyntaxError
    // 冒泡到隐晦的 (json) 或静默的 (human) CLI 退出。
    // 格式良好的非 2xx 正文仍会解析并返回 {status,data}；204 没有正文。
    const text = await res.text();
    if (res.status === 204) return { status: res.status, data: undefined as T };
    try {
      return { status: res.status, data: JSON.parse(text) as T };
    } catch {
      throw new DaemonResponseError(res.status, text);
    }
  }

  private async requestText(path: string, init: RequestInit, options?: DaemonRequestOptions): Promise<DaemonResponse<string>> {
    const res = await this.fetch(path, init, options);
    const data = await res.text();
    return { status: res.status, data };
  }
}
