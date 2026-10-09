// ── 已就地退役 (S10, OPR.0.5.5.10) ───────────────────────────────────────────────────
// 进程拆分式 gateway 形态已按修订后的 M1 §3（桌面负责人修订，创始人 R2）退役：gateway 作为
// 后台服务内部子系统运行（gateway-subsystem.ts）——不再 spawn 独立 gateway 进程，也没有
// gateway↔connector 套接字线路。本模块保持可编译、其测试继续通过，仅作为历史组件保留，
// 但绝不能再获得生产调用方：第二个可部署物的「缺席证明」就钉在这一点上（任何被 spawn 的
// gateway 进程或打开的 connector 线路都是红线）。按 spec 级裁决就地保留而非删除
// （删除还是标记由构建者自行裁量）。
// ─────────────────────────────────────────────────────────────────────────────────────────
// M1 A4a —— gateway OS 进程运行器：后台服务 spawn 的长生命周期大脑。它主动向外拨号连接
// connector 套接字（transport.ts），而且——关键在于——在 connector 中断期间保持存活。
//
// 存活原理（教训 idle-process-needs-refd-handle）：已连接的套接字是一个被引用的 libuv
// 句柄，但在中断期间没有打开的套接字，事件循环会因此清空，进程会静默退出。一个被引用的
// 心跳定时器既是保活器也是重拨驱动器：断开时每隔 reconnectMs 重拨一次；连接时则是廉价的
// 空操作。我们绝不停在 `new Promise(() => {})` 上（没有被引用的句柄 → 静默退出）——定时器
// 就是锚点。

import { DispatchBuffer } from "./dispatch-buffer.js";
import { connectGateway, type GatewayConnection } from "./transport.js";

export interface GatewayProcessOpts {
  socketPath: string;
  home?: string;
  /** 断开时的重拨节奏（同时也是心跳/保活节拍）。 */
  reconnectMs?: number;
  onError?: (error: Error) => void;
  onProtocolError?: (error: string) => void;
}

export interface GatewayProcessHandle {
  /** 当前活动连接（在一次断线到下一次成功重拨之间为 undefined）。 */
  connection(): GatewayConnection | undefined;
  connected(): boolean;
  /** 拆除：清掉心跳并关闭套接字（让进程得以退出）。 */
  stop(): void;
}

/** 启动 gateway 进程大脑。返回生命周期/测试用句柄。幂等重拨是安全的：持久缓冲区在每次
 *  （重）连时重放尚未 Ack 的决策（不丢失）。 */
export function runGatewayProcess(opts: GatewayProcessOpts): GatewayProcessHandle {
  const reconnectMs = opts.reconnectMs ?? 1000;
  const buffer = new DispatchBuffer(opts.home);
  let conn: GatewayConnection | undefined;
  let connected = false;
  let stopped = false;

  const dial = (): void => {
    if (stopped || connected) return;
    connected = true; // 乐观标记：若拨号失败/断线，onClose 会把它翻回 false
    conn = connectGateway({
      socketPath: opts.socketPath,
      buffer,
      onError: opts.onError,
      onProtocolError: opts.onProtocolError,
      onClose: () => { connected = false; conn = undefined; }, // 心跳在下一拍重拨
    });
  };

  dial();
  // 被引用的心跳：在中断期间保持事件循环存活，并驱动重拨。不要 unref——
  // 整个意义就在于进程在还欠着 connector 投递任务时不能退出。
  const heartbeat = setInterval(() => { if (!connected) dial(); }, reconnectMs);

  return {
    connection: () => conn,
    connected: () => connected,
    stop: () => {
      stopped = true;
      clearInterval(heartbeat);
      try { conn?.close(); } catch { /* 尽力而为 */ }
      conn = undefined;
      connected = false;
    },
  };
}
