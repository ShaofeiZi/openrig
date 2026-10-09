// OPR.0.4.4.15——共享 daemon→daemon HTTP core（arch cell 1，已批准）。
//
// 从 topology/remote-up-leaf.ts 提取，避免 P4 aggregation fan-out 复制第二份安全相关 transport
// 代码（bearer 解析 + bounded-abort 纪律 + status 分类）。up-leaf 现在只是薄 consumer，将本模块的
// 结构化 result 格式化为其已交付 error string（由测试逐字保护）。
//
// DEADLINE 是必填参数（架构收紧，module 不提供默认值）：up-leaf 在自己的 call-site 传入 120 秒
// long-running rig-up budget；attention aggregator 在自己的 call-site 传入 5 秒 read-class deadline。
// 隐藏的默认值会让下一个 consumer 静默继承错误类别。
//
// 此处以结构保证 G-R2B1-1 纪律：整个 exchange 只启用一个 deadline——覆盖 request 与 body parse
//（2xx 或 error body）。host 若发送 header 后一直不结束 body，会得到结构化 timeout，而非挂起 caller。
// body 与 signal 显式竞速（手工构建或代理的 Response 不一定连接 controller——不信任 fetch 内部实现）。

import { readFileSync } from "node:fs";
import type { HttpHostEntry } from "./hosts-registry-reader.js";

export interface RemoteJsonDeps {
  /** 可为测试注入；默认为全局 fetch。 */
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
}

export interface RemoteJsonOptions extends RemoteJsonDeps {
  method: "GET" | "POST";
  body?: unknown;
  /** 必填——caller 显式指定自己的 deadline 类别。 */
  timeoutMs: number;
  /** P21：额外 request header（例如 cross-host forward 中重新盖章的 X-OpenRig-Session +
   *  X-OpenRig-Relay）。在 Content-Type/Authorization 后合并，使 remote 读取 forwarder 重新盖章的
   *  identity——绝不读取 inbound body claim。 */
  headers?: Record<string, string>;
}

export type RemoteJsonFailureKind = "bearer" | "timeout" | "network" | "http";

export interface RemoteJsonFailure {
  ok: false;
  kind: RemoteJsonFailureKind;
  /** kind=timeout 时：deadline 是在收到 header 前（"request"）还是读取 body 时（"body"）触发。 */
  phase?: "request" | "body";
  /** 收到 header 时的 HTTP status（kind=http，或 kind=timeout/phase=body）。 */
  status?: number;
  /** Bearer 消息 / network error 消息 / remote error 文本（可为 ""）。 */
  detail: string;
}

export type RemoteJsonResult = { ok: true; status: number; payload: unknown } | RemoteJsonFailure;

export interface RemoteRawOptions extends RemoteJsonDeps {
  /** 必填——caller 显式指定自己的 deadline 类别。 */
  timeoutMs: number;
}

// OPR.0.4.6.MH2 FR-2/FR-7——read-through 的 transport 环节。逐字 passthrough 指 STATUS +
// CONTENT-TYPE + BODY（arch P3）：origin 自身的 404/500 就是答案，因此不同于 remoteJsonRequest，
// 此 variant 对每种 origin status 都返回完整 body TEXT，绝不将 error body 折叠成 detail string。
// failure kind 只保留 transport 类（bearer/timeout/network）——只要 origin 已响应，此处就始终
// ok:true。设计上仅支持 text：v1 read allowlist 只含 JSON endpoint；binary surface
//（proof-asset）被有意排除。
export type RemoteRawResult =
  | { ok: true; status: number; contentType: string; bodyText: string }
  | { ok: false; kind: Exclude<RemoteJsonFailureKind, "http">; phase?: "request" | "body"; status?: number; detail: string };

/** 镜像 CLI 的 resolveRemoteBearer（host-registry.ts）：bearer_env / bearer_file 至多配置一个，
 *  在调用时解析。两者都未配置表示 anonymous（仅 URL）host——无 token daemon；无 token 也视为
 *  正常，因此不发送 Authorization header。已配置但无法解析的 pointer 仍会失败（fail-closed）。 */
function resolveBearer(host: HttpHostEntry, deps: RemoteJsonDeps): { ok: true; token?: string } | { ok: false; detail: string } {
  const env = deps.env ?? process.env;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  if (host.bearer_env) {
    const token = env[host.bearer_env]?.trim();
    if (token) return { ok: true, token };
    return { ok: false, detail: `host ${host.id} 的 bearer 环境变量 ${host.bearer_env} 未设置或为空` };
  }
  if (host.bearer_file) {
    try {
      const token = readFile(host.bearer_file).trim();
      if (token) return { ok: true, token };
      return { ok: false, detail: `host ${host.id} 的 bearer 文件 ${host.bearer_file} 为空` };
    } catch {
      return { ok: false, detail: `无法读取 host ${host.id} 的 bearer 文件 ${host.bearer_file}` };
    }
  }
  return { ok: true };
}

/** 一次有界 daemon→daemon JSON exchange。单个 deadline 覆盖 request + body；每种 outcome 都是
 *  结构化结果——此函数永不挂起，也永不抛错。 */
export async function remoteJsonRequest(host: HttpHostEntry, path: string, opts: RemoteJsonOptions): Promise<RemoteJsonResult> {
  const bearer = resolveBearer(host, opts);
  if (!bearer.ok) return { ok: false, kind: "bearer", detail: bearer.detail };

  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${host.url.replace(/\/$/, "")}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: opts.method,
      headers: {
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(bearer.token ? { Authorization: `Bearer ${bearer.token}` } : {}),
        ...(opts.headers ?? {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) return { ok: false, kind: "timeout", phase: "request", detail: "" };
    return { ok: false, kind: "network", detail: (err as Error).message };
  }

  // 在同一个仍有效的截止时间内解析响应体，并显式参与竞速。
  const abortRace = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(new Error("body read aborted"));
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
  });

  let payload: unknown;
  let bodyTimedOut = false;
  try {
    payload = await Promise.race([res.json(), abortRace]);
  } catch {
    if (controller.signal.aborted) bodyTimedOut = true;
    // 否则：非 JSON body——payload 保持 undefined；status 是诚实 detail
  } finally {
    clearTimeout(timer);
  }

  if (bodyTimedOut) return { ok: false, kind: "timeout", phase: "body", status: res.status, detail: "" };
  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, payload };

  const remoteError = payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
    ? (payload as { error: string }).error
    : "";
  return { ok: false, kind: "http", status: res.status, detail: remoteError };
}

/** 一次有界 daemon→daemon GET，对任意 origin status 都以 text 原样传递 body（arch P3 逐字规则）。
 *  与 remoteJsonRequest 使用相同 bearer 解析、single-deadline 与显式 body race 纪律；永不挂起，
 *  也永不抛错。 */
export async function remoteRawRequest(host: HttpHostEntry, path: string, opts: RemoteRawOptions): Promise<RemoteRawResult> {
  const bearer = resolveBearer(host, opts);
  if (!bearer.ok) return { ok: false, kind: "bearer", detail: bearer.detail };

  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${host.url.replace(/\/$/, "")}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: bearer.token ? { Authorization: `Bearer ${bearer.token}` } : {},
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) return { ok: false, kind: "timeout", phase: "request", detail: "" };
    return { ok: false, kind: "network", detail: (err as Error).message };
  }

  const abortRace = new Promise<never>((_resolve, reject) => {
    const onAbort = () => reject(new Error("body read aborted"));
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
  });

  let bodyText = "";
  let bodyTimedOut = false;
  try {
    bodyText = await Promise.race([res.text(), abortRace]);
  } catch {
    if (controller.signal.aborted) bodyTimedOut = true;
  } finally {
    clearTimeout(timer);
  }

  if (bodyTimedOut) return { ok: false, kind: "timeout", phase: "body", status: res.status, detail: "" };
  return { ok: true, status: res.status, contentType: res.headers.get("content-type") ?? "application/json", bodyText };
}
