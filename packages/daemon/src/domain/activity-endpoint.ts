// OPR.0.4.3.28 B2/B3——自动配置的活动 hook 端点（URL + token）。
//
// 后台服务为每次安装生成一个活动 hook token，并推导自身的接收 URL，使已启动席位无需
// 操作员在 shell 中预先注入 OPENRIG_URL / OPENRIG_ACTIVITY_HOOK_TOKEN，
// 也能访问 /api/activity/hooks（已确认的线上断点——见 slice-28 IMPL-SPEC §1.1）。
//
// 该 token 是 LOCALHOST 内部鉴权句柄，不是创建者密钥：不得写入日志或打印输出，
// 并以 0600 权限存储，但无需为其构建专门的脱敏机制（orch-advisor 裁定 2026-07-02）。
//
// - activity-hook-token：持久 token，后台服务重启后仍保持稳定，使已启动席位
//   （其环境变量在启动时冻结了该 token）在重启后仍可通过鉴权。
// - activity-endpoint.json：{baseUrl, token} 快照，每次启动时重写；对于已对账/恢复且
//   冻结进程环境中不含 OpenRig 活动变量的席位，中继器通过文件发现回退读取它（B3）。

import fs from "node:fs";
import nodePath from "node:path";
import { randomBytes } from "node:crypto";

const TOKEN_FILE = "activity-hook-token";
const ENDPOINT_FILE = "activity-endpoint.json";
const DEFAULT_DAEMON_PORT = "7433";

/** OPR.0.4.3.28 B2——根据后台服务自身绑定的 host+port 推导注入席位的活动接收 URL，
 *  确保席位中继器向后台服务实际监听的地址发送请求。OPENRIG_HOST 显式指定主机
 *  （loopback、localhost、tailnet IP 或主机名）时，后台服务只绑定该主机，因此 URL
 *  必须使用该值；写死 127.0.0.1 将无法访问。通配/全地址绑定值（0.0.0.0 / ::）不是
 *  可连接地址，且后台服务在此情形下也绑定 loopback，所以映射为 127.0.0.1。未提供主机
 *  （默认的 loopback+tailscale 多地址绑定）时也使用 loopback。 */
export function deriveActivityUrl(host: string | undefined, port: string | undefined): string {
  const p = port && port.trim().length > 0 ? port.trim() : DEFAULT_DAEMON_PORT;
  const h = host?.trim();
  const wildcard = !h || h === "0.0.0.0" || h === "::" || h === "[::]" || h === "*";
  return `http://${wildcard ? "127.0.0.1" : h}:${p}`;
}

/** 从状态目录读取持久活动 hook token；不存在时生成并持久化。
 *  token 跨重启保持稳定，使环境已冻结的席位能够继续鉴权。 */
export function ensureActivityHookToken(stateDir: string): string {
  const tokenPath = nodePath.join(stateDir, TOKEN_FILE);
  try {
    const existing = fs.readFileSync(tokenPath, "utf-8").trim();
    if (existing.length > 0) return existing;
  } catch {
    // 尚不存在，继续在下方生成。
  }
  const token = randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    fs.chmodSync(tokenPath, 0o600); // 即使文件原先已存在，也强制校正权限。
  } catch {
    // 尽力持久化：内存中的 token 在本次后台服务运行期间仍可用，
    // 但无法跨重启保留，届时会回退为重新生成。
  }
  return token;
}

/** 将当前 {baseUrl, token} 快照写入 activity-endpoint.json（权限 0600），
 *  供中继器的文件发现回退使用（B3）。此操作采用尽力而为语义。 */
export function writeActivityEndpointFile(stateDir: string, endpoint: { baseUrl: string; token: string }): void {
  const endpointPath = nodePath.join(stateDir, ENDPOINT_FILE);
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(endpointPath, JSON.stringify({ baseUrl: endpoint.baseUrl, token: endpoint.token }), { mode: 0o600 });
    fs.chmodSync(endpointPath, 0o600);
  } catch {
    // 尽力而为：写入失败时，已对账/恢复席位不会获得文件发现能力。
  }
}

/** 从 activity-endpoint.json 读取 {baseUrl, token}；文件缺失或无效时返回 null。
 *  中继器的 .cjs 会直接读取该文件；此函数供后台服务侧逻辑与测试使用。 */
export function readActivityEndpointFile(stateDir: string): { baseUrl: string; token: string } | null {
  const endpointPath = nodePath.join(stateDir, ENDPOINT_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(endpointPath, "utf-8")) as { baseUrl?: unknown; token?: unknown };
    if (typeof parsed.baseUrl === "string" && parsed.baseUrl.length > 0
      && typeof parsed.token === "string" && parsed.token.length > 0) {
      return { baseUrl: parsed.baseUrl, token: parsed.token };
    }
  } catch {
    // 文件缺失或格式错误。
  }
  return null;
}
