// ── 已就地退役 (S10, OPR.0.5.5.10) ───────────────────────────────────────────────────
// 进程拆分式 gateway 形态已按修订后的 M1 §3（桌面负责人修订，创始人 R2）退役：gateway 作为
// 后台服务内部子系统运行（gateway-subsystem.ts）——不再 spawn 独立 gateway 进程，也没有
// gateway↔connector 套接字线路。本模块保持可编译、其测试继续通过，仅作为历史组件保留，
// 但绝不能再获得生产调用方：第二个可部署物的「缺席证明」就钉在这一点上（任何被 spawn 的
// gateway 进程或打开的 connector 线路都是红线）。按 spec 级裁决就地保留而非删除
// （删除还是标记由构建者自行裁量）。
// ─────────────────────────────────────────────────────────────────────────────────────────
// M1 A4a —— gateway 进程入口点：后台服务作为独立 OS 进程 spawn 的那个文件
// （`node dist/domain/gateway/gateway-process-main.js`）。刻意保持单薄——它从 spawn 包装器
// 设定的环境变量读取配置，启动长生命周期的 runGatewayProcess 大脑，并接上干净的
// SIGTERM/SIGINT 关机流程。全部行为都在 gateway-process.ts 里（在进程内做单元测试）；
// 本文件的存在意义仅仅是作为一个可执行的 node 入口。

import { pathToFileURL } from "node:url";
import { runGatewayProcess, type GatewayProcessHandle } from "./gateway-process.js";

export const GATEWAY_SOCKET_ENV = "OPENRIG_GATEWAY_SOCKET";
export const GATEWAY_RECONNECT_MS_ENV = "OPENRIG_GATEWAY_RECONNECT_MS";

/** 从环境变量配置启动 gateway 进程。返回句柄（若缺少必需的套接字路径，则入口设置非零退出码并返回）。 */
export function mainFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayProcessHandle | undefined {
  const socketPath = env[GATEWAY_SOCKET_ENV];
  if (!socketPath) {
    process.stderr.write(`[gateway] 缺少必需环境变量 ${GATEWAY_SOCKET_ENV}\n`);
    process.exitCode = 2;
    return undefined;
  }
  const reconnectRaw = env[GATEWAY_RECONNECT_MS_ENV];
  const reconnectMs = reconnectRaw !== undefined && Number.isFinite(Number(reconnectRaw)) && Number(reconnectRaw) > 0
    ? Number(reconnectRaw) : undefined;
  const handle = runGatewayProcess({
    socketPath,
    home: env.OPENRIG_HOME,
    reconnectMs,
    onError: (e) => process.stderr.write(`[gateway] 套接字错误：${e.message}\n`),
    onProtocolError: (m) => process.stderr.write(`[gateway] 协议拒绝：${m}\n`),
  });
  const shutdown = (): void => { handle.stop(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.stdout.write(`[gateway] 已在 ${socketPath} 上启动\n`);
  return handle;
}

// 自运行守卫：仅当作为 `node gateway-process-main.js` 直接执行时才自动启动，
// 被 import 时绝不触发（后台服务/测试 import mainFromEnv 时不应有副作用）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mainFromEnv();
}
