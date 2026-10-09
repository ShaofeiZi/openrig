// PL-005 阶段 B：用于 /api/mission-control/* 的 bearer-token 中间件。
//
// 根据 slice IMPL § Write Set 与审计硬门禁 8 + 9：
//   - 通过 Node `crypto.timingSafeEqual` 对 bearer 做恒定时间比较；字节不匹配时不提前返回。
//   - token 缺失或不匹配时返回 401 及三段式错误正文（失败内容 + 重要原因 + 处理方式）。
//   - 使用非 loopback 绑定接口且 bearer 配置为空时，后台服务拒绝启动——启动侧检查见 startup.ts。
//
// MVP 上下文（单开发者、单用户、单主机）：一个来自配置字段的静态 bearer token。不提供
// OAuth/SSO/逐用户路由/基于角色的权限/token 轮换。token 持有者拥有完整权限。
//
// 至少挂载于 /api/mission-control/* 写动词（POST /action、POST /notifications/test）。
// 操作员可选择让读取（GET /views、/audit 等）受同一 token 保护（阶段 B driver 默认只保护
// 写入；读取在 tailnet 绑定后保持开放，以支持操作员尚未在手机输入 token 时从手机有界面浏览；
// bearer 用于写入完整性，而非视图机密性）。

import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { promises as dns } from "node:dns";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import type { MiddlewareHandler } from "hono";

/**
 * 使用 Node 的 timingSafeEqual 做恒定时间字符串比较。长度不同时返回 false
 *（timingSafeEqual 会因长度不匹配抛错；这里填充后比较，使分支特征尽量保持恒定，
 * 同时如实返回 false）。
 */
export function constantTimeEqual(a: string, b: string): boolean {
  // timingSafeEqual 必须先检查长度，但长度相同时比较仍为恒定时间。长度不同时仍对固定大小的
  // 零缓冲区执行比较，防止攻击者从响应时间推断“长度错误”还是“字节错误”。
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // 与等长零缓冲区比较，使不同不匹配路径的调用成本接近；此处结果始终为 false。
    timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * 遵循 OpenRig 诚实错误报告约定的三段式错误正文；在路由的 c.json 调用内渲染。
 */
function unauthorizedBody(reason: string): {
  error: "unauthorized";
  message: string;
  what_failed: string;
  why_it_matters: string;
  what_to_do: string;
} {
  return {
    error: "unauthorized",
    message: `Mission Control 鉴权失败：${reason}`,
    what_failed: reason,
    why_it_matters:
      "Mission Control 写操作需要 bearer token，因为后台服务可能绑定到非 loopback 接口（tailnet），未经认证的修改并不安全。",
    what_to_do:
      "请在后台服务配置中设置 auth.bearerToken 字段（或 OPENRIG_AUTH_BEARER_TOKEN 环境变量），重启后台服务，再使用 `Authorization: Bearer <token>` 重新发送请求。",
  };
}

export interface AuthBearerTokenOpts {
  /**
   * 预期的 bearer token。为 null 时，中间件允许所有请求通过（其他位置的后台服务启动检查确保
   * 这种情况只会在绑定 loopback 时发生）。
   */
  expectedToken: string | null;
}

/**
 * 在所挂载路由上强制执行 bearer-token 鉴权的 Hono 中间件。token 缺失或不匹配时返回 401
 * 和三段式错误正文。
 *
 * `expectedToken` 为 null 时，中间件直接放行。`startup.ts` 中的启动检查确保 null 只在
 * 绑定接口为 loopback 时有效。
 */
export function authBearerTokenMiddleware(
  opts: AuthBearerTokenOpts,
): MiddlewareHandler {
  const { expectedToken } = opts;
  return async (c, next) => {
    if (expectedToken === null) {
      // 仅 loopback 模式（未配置 bearer），直接放行。
      await next();
      return;
    }
    const header = c.req.header("Authorization") ?? c.req.header("authorization");
    if (!header) {
      return c.json(unauthorizedBody("缺少 Authorization 请求头"), 401);
    }
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      return c.json(
        unauthorizedBody("Authorization 请求头必须为 'Bearer <token>'"),
        401,
      );
    }
    const provided = match[1]!.trim();
    if (!constantTimeEqual(provided, expectedToken)) {
      return c.json(unauthorizedBody("bearer token 不匹配"), 401);
    }
    await next();
  };
}

/**
 * 检测主机绑定值是仅 loopback（可安全跳过 bearer 要求），还是非 loopback（tailnet/公网，
 * 需要 bearer）。loopback 集合：`127.x.x.x`、`::1`、`localhost`。其他值（包括 `0.0.0.0`、
 * `::`、具名主机和 tailnet IP）均视为非 loopback。
 */
export function isLoopbackBind(host: string | undefined | null): boolean {
  if (!host || host.length === 0) {
    // Hono/@hono/node-server 默认绑定 0.0.0.0；为安全起见视为非 loopback，强制操作员显式
    // 绑定到 127.0.0.1 或设置 bearer token。
    return false;
  }
  const trimmed = host.trim().toLowerCase();
  if (trimmed === "localhost" || trimmed === "::1" || trimmed === "[::1]") return true;
  if (trimmed.startsWith("127.")) return true;
  return false;
}

/**
 * 检测 tailscale CGNAT IPv4（100.64.0.0/10）与 ULA IPv6 前缀
 *（fd7a:115c:a1e0::/48）。仅对 tailnet 字面 IP 地址返回 true；主机名调用方必须先通过
 * {@link resolveToIpOrNull} 解析。
 *
 * 原因：tailscale 的 WireGuard mesh + ACL 就是鉴权边界，因此绑定 tailnet 的后台服务不需要
 * 额外 bearer token。CGNAT IPv4 范围和 ULA IPv6 前缀由 tailscale 保留并有文档说明；
 * 在真实网络中发生冲突的概率近乎为零。
 *
 * HG-3 边界语义：CGNAT 为 100.64.0.0/10，即第一段必须为 100，第二段包含 64..127。
 * 100.63.x.x 与 100.128.x.x 不属于 tailnet。
 */
export function isTailscaleBind(host: string | undefined | null): boolean {
  if (!host) return false;
  const trimmed = host.trim().toLowerCase();
  const ipv4Match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
  if (ipv4Match) {
    const first = parseInt(ipv4Match[1]!, 10);
    const second = parseInt(ipv4Match[2]!, 10);
    if (first === 100 && second >= 64 && second <= 127) return true;
    return false;
  }
  const cleaned = trimmed.replace(/^\[|\]$/g, "");
  if (cleaned.startsWith("fd7a:115c:a1e0:")) return true;
  return false;
}

/**
 * {@link detectTailscaleInterface} 的纯辅助函数：接收 NetworkInterfaces 字典
 *（os.networkInterfaces() 返回的结构），返回第一个匹配 tailnet IP 范围的非内部地址，否则
 * 返回 null。单独抽出后，测试可提供合成网络接口 fixture，而无需 mock node:os。
 */
export function findTailscaleIpInInterfaces(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): string | null {
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.internal) continue;
      if (isTailscaleBind(addr.address)) return addr.address;
    }
  }
  return null;
}

/**
 * 探测主机网络接口并返回首个找到的 tailscale IP 地址（CGNAT IPv4 或 tailnet ULA IPv6）；
 * 当前没有活跃 tailnet 接口时返回 null。后台服务启动时据此决定多重绑定（loopback + tailnet）
 * 还是仅绑定 loopback。检测基于 IP 而非接口名，因此不受各平台 tailscale tun 设备命名差异影响。
 */
export function detectTailscaleInterface(): string | null {
  return findTailscaleIpInInterfaces(networkInterfaces());
}

/**
 * 通过 node:dns/promises lookup 将主机名解析为首个 IP。解析失败（DNS 错误、超时、主机不存在）
 * 时返回 null。根据 slice IMPL-PRD 的风险 9.2，以 5 秒竞速超时包装，避免无响应解析器无限阻塞
 * 后台服务启动。
 */
export async function resolveToIpOrNull(host: string): Promise<string | null> {
  try {
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), 5000).unref();
    });
    const lookup = dns
      .lookup(host, { all: false })
      .then((r) => r.address)
      .catch(() => null);
    return await Promise.race([lookup, timeout]);
  } catch {
    return null;
  }
}

export class AuthBearerTokenStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthBearerTokenStartupError";
  }
}

/**
 * 启动侧检查（HARD-GATE 审计第 8 行）。绑定接口确实是公网/LAN 且 bearer token 为空时，
 * 显式抛出 AuthBearerTokenStartupError。loopback 或 tailscale IP 绑定会短路（tailnet 即鉴权
 * 边界）。主机名绑定先通过 DNS 解析；若解析为 loopback 或 tailnet IP，同样短路。公网/LAN
 * 绑定缺少 bearer 时抛错，后台服务拒绝启动。
 */
export async function assertBindAuthInvariant(opts: {
  host: string;
  bearerToken: string | null;
}): Promise<void> {
  if (isLoopbackBind(opts.host)) return;
  if (isTailscaleBind(opts.host)) return;

  let resolvedIp: string | null = null;
  // 主机名（非字面 IP）——解析后重新检查。
  if (!/^[\d.]+$/.test(opts.host) && !opts.host.includes(":")) {
    resolvedIp = await resolveToIpOrNull(opts.host);
    if (resolvedIp) {
      if (isLoopbackBind(resolvedIp)) return;
      if (isTailscaleBind(resolvedIp)) return;
    }
  }

  if (opts.bearerToken && opts.bearerToken.length > 0) return;
  throw new AuthBearerTokenStartupError(
    `后台服务拒绝启动：绑定主机 '${opts.host}'${resolvedIp ? `（解析为 ${resolvedIp}）` : ""} 不是 loopback 或 tailscale，` +
      `且 auth.bearerToken（环境变量 OPENRIG_AUTH_BEARER_TOKEN）为空。` +
      `请选择：(a) 绑定到 127.0.0.1/localhost；(b) 绑定到 tailscale 接口（100.64.0.0/10 IPv4 或 fd7a:115c:a1e0::/48 IPv6）；` +
      `或 (c) 在启动后台服务前将 OPENRIG_AUTH_BEARER_TOKEN 设为非空值。`,
  );
}
