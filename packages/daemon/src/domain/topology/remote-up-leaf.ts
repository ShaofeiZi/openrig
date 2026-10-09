// OPR.0.4.4.11——daemon 侧 remote single-rig leaf（FR-4）。
//
// 放置于 host 的 topology entry 通过 POST 已交付的 remote-up surface 启动：
// POST {host.url}/api/up，body shape 与 CLI --host 路径发送的相同。自 OPR.0.4.4.15 起，
// 这里是共享 daemon→daemon transport core（domain/hosts/remote-daemon-http.ts）的轻量 consumer
//（arch cell 1：整个 P3/P4 family 只保留一份与安全相关的 bearer/bounded-abort/classification
// 代码）。此 module 保持已交付的 error-string surface 逐字节不变，仅移动 transport 接线。
// failure class 仍是既有的 [permission-gate] / [remote-command-failed] /
// [remote-daemon-unreachable]——不增加 taxonomy（FR-4 负向 AC）。

import type { HttpHostEntry } from "../hosts/hosts-registry-reader.js";
import { remoteJsonRequest } from "../hosts/remote-daemon-http.js";

export interface RemoteUpLeafDeps {
  /** 测试时可注入；默认使用 global fetch。 */
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
  /** 有界 remote-up deadline（rev1-r2 R2-B1）。默认使用长时 rig-up budget——remote
   *  bootstrap 合理地可能运行数分钟，但不能永久运行。显式传给 shared core
   *  （按 arch required-argument 收紧要求，deadline class 由此 call site 决定）。 */
  timeoutMs?: number;
}

/** 与 CLI 的 LONG_RUNNING_UP_TIMEOUT_MS 一致，用于独立 remote up。 */
export const REMOTE_UP_TIMEOUT_MS = 120_000;

export interface RemoteUpBody {
  sourceRef: string;
  autoApprove?: boolean;
}

/** 将放置后的 entry POST 到 remote daemon 已交付的 /api/up。返回 launcher 的 normalized
 *  {ok, error?} shape；可用时逐字传递 remote daemon 自身的 error text。绝不无限挂起：
 *  shared core 使用同一个 deadline 覆盖 request 与 body parse（G-R2B1-1 类在此结构性关闭）。 */
export async function remoteUpLeaf(
  body: RemoteUpBody,
  host: HttpHostEntry,
  deps: RemoteUpLeafDeps = {},
): Promise<{ ok: boolean; error?: string }> {
  const timeoutMs = deps.timeoutMs ?? REMOTE_UP_TIMEOUT_MS;
  const url = `${host.url.replace(/\/$/, "")}/api/up`;
  const res = await remoteJsonRequest(host, "/api/up", {
    method: "POST",
    body,
    timeoutMs,
    fetchImpl: deps.fetchImpl,
    env: deps.env,
    readFile: deps.readFile,
  });
  if (res.ok) return { ok: true };

  switch (res.kind) {
    case "bearer":
      return { ok: false, error: `[permission-gate] ${res.detail}` };
    case "timeout":
      // R2-B1 / G-R2B1-1：remote /api/up 无论在 header 前后卡住，都会成为结构化的
      // per-entry failure，而非挂起整个遍历。
      return res.phase === "body"
        ? {
            ok: false,
            error: `[remote-daemon-unreachable] 向 host ${host.id} POST ${url} 在 ${timeoutMs}ms 后超时：response header 已到达（HTTP ${res.status}），但 error body 始终未完成`,
          }
        : {
            ok: false,
            error: `[remote-daemon-unreachable] 向 host ${host.id} POST ${url} 在 ${timeoutMs}ms 后超时：remote daemon 未在 rig-up budget 内结束请求`,
          };
    case "network":
      return { ok: false, error: `[remote-daemon-unreachable] 向 host ${host.id} POST ${url} 失败：${res.detail}` };
    case "http": {
      // 使用与 CLI transport（classifyHttpFailedStep）相同的 classification vocabulary。
      const status = res.status ?? 0;
      const cls = status === 401 || status === 403 ? "permission-gate" : status >= 400 && status < 600 ? "remote-command-failed" : "remote-daemon-unreachable";
      const detail = res.detail ? `HTTP ${res.status}: ${res.detail}` : `HTTP ${res.status}`;
      return { ok: false, error: `[${cls}] host ${host.id} 上的 remote up 失败：${detail}` };
    }
  }
}
