// ── 原地退役（S10，OPR.0.5.5.10）────────────────────────────────────────────────────────
// 根据修订后的 M1 §3（desk head amendment、founder R2），进程拆分式 gateway 已退役：gateway
// 作为后台服务内子系统运行（gateway-subsystem.ts），不再生成 gateway 进程，也没有
// gateway↔connector socket 接线。本模块作为历史组件仍需可编译、测试仍需通过，但绝不能新增
// production caller；第二可部署体缺席证明锁定了这一点（任何生成的 gateway 进程或打开的
// connector 接线都表示失败）。按照 spec 层裁定保留而不删除，删除或标记由构建者自行决定。
// ─────────────────────────────────────────────────────────────────────────────────────────
// M1 A4a——gateway 侧 UNIX-SOCKET transport：gateway 主动拨号 connector 监听的本地 socket，
// 交换以换行分帧的 JSON（protocol.ts codec），并将数据流接入 GatewayDispatcher
//（契约 a305310d）。不存在入站网络监听；unix-domain socket 是受本地文件系统权限控制的 IPC，
// 不是网络攻击面。
//
// 分帧：使用换行分隔 JSON frame（encodeGatewayMessage 会追加 `\n`）。入站字节先进入缓冲区，
// 再按 `\n` 切分；每个完整 frame 都会解码。未知 kind 或不完整 frame 会显著拒绝并通过
// onProtocolError 呈现，绝不静默丢弃。
//
// 注意（sun_path 约 104 字节上限）：调用方必须传入位于短 runtime 目录中的 socketPath，
// 绝不能使用层级很深的 scratchpad 路径。

import { createConnection, type Socket } from "node:net";
import type { DispatchBuffer } from "./dispatch-buffer.js";
import { GatewayDispatcher } from "./dispatcher.js";
import { decodeGatewayMessage, encodeGatewayMessage } from "./protocol.js";

export interface GatewayConnection {
  dispatcher: GatewayDispatcher;
  close(): void;
}

export interface ConnectOpts {
  socketPath: string;
  buffer: DispatchBuffer;
  /** 显著呈现被拒绝或格式错误的 frame，绝不静默丢弃。 */
  onProtocolError?: (error: string) => void;
  /** Socket 层错误（connector 停机或断线）。始终附加 handler，确保 ECONNREFUSED/EPIPE 不会
   *  使后台服务崩溃；持久 buffer 已保证不丢失，spawn wrapper 负责重连，此处只提供可观测界面。 */
  onError?: (error: Error) => void;
  /** socket 已关闭（connector 离开）；spawn wrapper 用它重新拨号。 */
  onClose?: () => void;
  newDecisionId?: () => string;
}

/** 主动拨号 connector socket 并接入 GatewayDispatcher。CapabilityDescriptor 握手后，dispatcher
 *  进入 ready 状态并重放所有未 Ack 的 decision，从而保证重连不丢失；Ack frame 会排出 buffer。
 *  返回 dispatcher，供后台服务分发 decision。 */
export function connectGateway(opts: ConnectOpts): GatewayConnection {
  const socket: Socket = createConnection(opts.socketPath);
  const dispatcher = new GatewayDispatcher({
    buffer: opts.buffer,
    send: (decision) => socket.write(encodeGatewayMessage(decision)),
    newDecisionId: opts.newDecisionId,
  });

  let acc = "";
  socket.setEncoding("utf8");
  // 始终附加错误 handler：connector 停机或断线时不得抛出未捕获异常。
  socket.on("error", (err: Error) => opts.onError?.(err));
  socket.on("close", () => opts.onClose?.());
  socket.on("data", (chunk: string) => {
    acc += chunk;
    let nl: number;
    while ((nl = acc.indexOf("\n")) >= 0) {
      const frame = acc.slice(0, nl);
      acc = acc.slice(nl + 1);
      if (frame.length === 0) continue;
      const decoded = decodeGatewayMessage(frame);
      if (!decoded.ok) { opts.onProtocolError?.(decoded.error); continue; }
      const msg = decoded.message;
      if (msg.kind === "capability") {
        dispatcher.onCapability(msg);
        dispatcher.replayPending(); // 重连不丢失：重新发送未 Ack 的 decision。
      } else if (msg.kind === "ack") {
        if (msg.ok) {
          dispatcher.onAck(msg.decisionId); // 已投递：排出持久行。
        } else {
          // ok:false 表示 connector 已收到 decision，但投递失败且未记录它；按契约，gateway 应保留并
          // 重放。此处绝不能排出，否则会静默丢失通知，违反 invariant-2 no-loss。保持该行 pending，
          // 使 replayPending 在下次连接或重连时重新发送；connector 对 decisionId 去重，确保最终重投递
          // 不会重复发帖。同时呈现失败以便观测。
          opts.onError?.(new Error(
            `connector 报告 decision ${msg.decisionId} 投递失败（${msg.failed.class}${msg.failed.detail ? "：" + msg.failed.detail : ""}）——已保留待重放`,
          ));
        }
      }
      // outbound_decision 只能从 gateway 发往 connector；收到该类型属于协议错误。
      else if (msg.kind === "outbound_decision") {
        opts.onProtocolError?.(`从 connector 收到非预期的 outbound_decision frame（decisionId ${msg.decisionId}）`);
      }
    }
  });

  return {
    dispatcher,
    close: () => { try { socket.end(); socket.destroy(); } catch { /* 尽力关闭。 */ } },
  };
}
