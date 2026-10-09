// OPR.0.4.6.02 FB4——herdr SOCKET transport（arm's-length AGPL 边界）。
//
// herdr 是 AGPL terminal multiplexer。OpenRig 与其保持独立集成：我们连接本地 unix-domain
// CONTROL SOCKET（由 operator 安装的 herdr 暴露的 runtime IPC endpoint），方式与 shell out 到
// tmux/cmux 完全一样——只是本地 IPC client，绝不 import、link、embed 或 vendor herdr 代码。
// 此文件只在 operator 所拥有的 herdr socket 上组装 JSON frame。
//
// 为何使用 socket 而非 CLI（FB4 修正）：herdr 0.7.1 没有 `layout` CLI command——此前的 CLI
// transport（`herdr layout apply …`）无法平铺 view（e373f741 的 VM proof 命中
// `herdr_layout_unsupported`）。herdr 0.7.1 的 layout 机制是 socket JSON-RPC `layout.apply`，
// slice research 已通过 raw socket 验证。这里的 wire protocol 以以下位置保存的逐字 capture 为依据：
// research/herdr-socket-captures/herdr-phase3-*.json:
//   - socket：~/.config/herdr/herdr.sock（可由 HERDR_SOCKET_PATH / HERDR_SESSION 覆盖）
//   - framing：newline-delimited JSON（每行一个 object）
//   - envelope：request {id,method,params} → success {id,result:{type,…}}
//     （不是 JSON-RPC 2.0——没有 `jsonrpc` 字段；ping 等部分 method 可能返回裸 {type,…}）
// error-response envelope、精确 socket lifecycle 与 workspace.create 未被逐字 capture；此处进行
// 防御性处理，并将它们列为 fresh VM re-proof 必须确认的 first-run empirical 项（proof artifact
// 落盘前仍未证实）。

import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";

/** herdr socket result body——始终携带 `type` discriminator。 */
export interface HerdrResult {
  type: string;
  [k: string]: unknown;
}

export interface HerdrProbeResult {
  /** herdr control socket 是否可达且会响应 `ping`？ */
  alive: boolean;
  version: string | null;
  protocol: number | null;
}

/** 一次 socket round-trip：发送 {id,method,params}，解析匹配的 response body。 */
export type HerdrSocketRpc = (req: { id: string; method: string; params: unknown }) => Promise<HerdrResult>;

export interface HerdrTransport {
  /** 通过 socket `ping`（而非不存在的 CLI）获取 liveness + version/protocol。 */
  probe(): Promise<HerdrProbeResult>;
  /** 发送 socket request；解析 `result` body，遇到 error / 无 result / 不可达时 reject。 */
  request(method: string, params: unknown): Promise<HerdrResult>;
}

export type HerdrTransportFactory = () => HerdrTransport;

/** 解析 herdr control socket path：env override → per-session → 默认值。 */
export function resolveHerdrSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env["HERDR_SOCKET_PATH"]) return env["HERDR_SOCKET_PATH"] as string;
  const base = path.join(homedir(), ".config", "herdr");
  const session = env["HERDR_SESSION"];
  return session ? path.join(base, "sessions", session, "herdr.sock") : path.join(base, "herdr.sock");
}

/** 提取 version token（例如来自 ping result 的 `version` 或 `herdr --version`）。 */
export function parseHerdrVersion(out: unknown): string | null {
  if (typeof out !== "string") return null;
  const m = out.match(/(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*)/);
  return m?.[1] ?? null;
}

/**
 * 将解析后的 response line 规范化为 result body。同时接受 wrapped
 * `{id,result:{type,…}}`（layout.apply/workspace.create）与裸 `{type,…}`（ping）形态；
 * 将 `{…,error:…}`（未 capture 的形态，防御性处理）或无结构 line 视为错误。
 */
export function unwrapHerdrResponse(raw: unknown): HerdrResult {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (obj["error"] != null) {
      const e = obj["error"];
      throw new Error(`herdr error（错误）：${typeof e === "string" ? e : JSON.stringify(e)}`);
    }
    const result = obj["result"];
    if (result && typeof result === "object") return result as HerdrResult;
    if (typeof obj["type"] === "string") return obj as HerdrResult; // bare {type,…} (e.g. pong)
  }
  throw new Error(`herdr: unrecognized socket response（无法识别的 socket 响应）${JSON.stringify(raw)}`);
}

/**
 * 真实 unix-socket RPC（node:net）。每个 request 一次连接：连接后发送一行 newline-delimited JSON，
 * 读取 line 直到遇到 `id` 匹配的 response（或裸 typed response），然后关闭。遇到 ENOENT
 *（herdr 未运行）、timeout、连接错误、response 前 socket 关闭或 herdr 错误时 reject。可注入，
 * 因此 adapter/test 绝不会打开真实 socket。
 */
export function createHerdrSocketRpc(
  socketPath: string = resolveHerdrSocketPath(),
  timeoutMs = 5000,
): HerdrSocketRpc {
  return (req) =>
    new Promise<HerdrResult>((resolve, reject) => {
      const conn = net.createConnection({ path: socketPath });
      let buf = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        conn.destroy();
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error(`herdr socket 在 ${timeoutMs}ms 后超时（${socketPath}）`))),
        timeoutMs,
      );
      conn.on("connect", () => conn.write(`${JSON.stringify(req)}\n`));
      conn.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue; // partial/foreign line——继续读取
          }
          const id = (parsed as { id?: unknown })?.id;
          if (id != null && id !== req.id) continue; // subscription/其他消息，不是本次 reply
          try {
            const body = unwrapHerdrResponse(parsed);
            finish(() => resolve(body));
          } catch (err) {
            finish(() => reject(err instanceof Error ? err : new Error(String(err))));
          }
          return;
        }
      });
      conn.on("error", (err) => finish(() => reject(err)));
      conn.on("end", () => finish(() => reject(new Error("herdr socket 在响应前已关闭"))));
    });
}

/**
 * socket transport。`request` 使用 fresh id 通过注入的 RPC 发送；`probe` 发送 `ping` 并读取
 * `{type:"pong",version,protocol}`（不可达 / 非 pong → alive:false，即诚实答案）。
 */
export function createHerdrSocketTransport(rpc: HerdrSocketRpc): HerdrTransportFactory {
  return (): HerdrTransport => {
    let counter = 0;
    const nextId = () => `openrig-${(counter += 1)}`;
    return {
      async probe(): Promise<HerdrProbeResult> {
        try {
          const pong = await rpc({ id: nextId(), method: "ping", params: {} });
          const version = parseHerdrVersion(pong["version"]);
          const protocol = typeof pong["protocol"] === "number" ? (pong["protocol"] as number) : null;
          return { alive: pong["type"] === "pong" || version != null || protocol != null, version, protocol };
        } catch {
          return { alive: false, version: null, protocol: null };
        }
      },
      request(method: string, params: unknown): Promise<HerdrResult> {
        return rpc({ id: nextId(), method, params });
      },
    };
  };
}
