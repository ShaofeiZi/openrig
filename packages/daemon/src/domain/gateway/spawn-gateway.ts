// ── 已就地退役（S10, OPR.0.5.5.10）──────────────────────────────────────────────────────
// 进程拆分式 gateway 形态已按修订后的 M1 §3（桌面负责人修订，创始人 R2）退役：gateway
// 作为后台服务内子系统运行（gateway-subsystem.ts），不再 spawn gateway 进程，也没有
// gateway↔connector socket wire。本模块作为历史组件继续编译并保留测试，但绝不能再获得生产
// 调用方：第二个可部署物的“缺席证明”已固定这一点，任何被 spawn 的 gateway 进程或打开的
// connector wire 都会触发红灯。按规范级裁决保留本文件而非删除（删除或标记由构建者决定）。
// ─────────────────────────────────────────────────────────────────────────────────────────
// M1 A4a——后台服务侧 SPAWN 包装器：把 gateway 启动为独立 OS 进程
//（架构 a8343a38：由后台服务 spawn 的进程，而非进程内线程）。该层保持单薄：解析相邻的编译
// 入口、在子进程环境中设置 socket 路径，并返回 ChildProcess 句柄供后台服务生命周期监管。
// 子进程自己的存活/重连由 gateway-process.ts 心跳负责；本包装器只负责启动。

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GATEWAY_SOCKET_ENV } from "./gateway-process-main.js";

export interface SpawnGatewayOpts {
  socketPath: string;
  home?: string;
  /** 覆盖编译后的入口文件；测试会指向已构建的 dist 入口。 */
  entryPath?: string;
  env?: NodeJS.ProcessEnv;
}

/** 后台服务 spawn 的编译入口，即 dist 中相邻的 gateway-process-main.js。通过 import.meta.url
 * 解析，确保无论后台服务 dist 安装在何处都能定位正确。 */
export function gatewayProcessEntry(): string {
  return fileURLToPath(new URL("./gateway-process-main.js", import.meta.url));
}

/** Spawn gateway OS 进程并主动拨号 `socketPath`。返回 ChildProcess，供后台服务监管/终止；
 * stdout/stderr 使用 pipe，便于后台服务合并进自身日志。 */
export function spawnGatewayProcess(opts: SpawnGatewayOpts): ChildProcess {
  const entry = opts.entryPath ?? gatewayProcessEntry();
  const env: NodeJS.ProcessEnv = {
    ...(opts.env ?? process.env),
    [GATEWAY_SOCKET_ENV]: opts.socketPath,
  };
  if (opts.home) env.OPENRIG_HOME = opts.home;
  return spawn(process.execPath, [entry], { env, stdio: ["ignore", "pipe", "pipe"] });
}
