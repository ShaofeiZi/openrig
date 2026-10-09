// OPR.0.5.5.19 AM-R18——TUI 的 oracle 订阅路径。HTTP 在
// daemon-client（FR-8 单模块规则）中：此模块消费一个 OPENER 并解析 SSE
// 帧。推送仅是更改通知（席位 + 序号）——打开的视图通过
// 重新水合相同的 /api/ps 投影来重新渲染，因此在此路径上不存在第二个活动派生
// （桌面接受的形状，裁决行 qitem-20260827001530）。
// 无空闲轮询：null open（端点缺失/后台服务不可达/非 SSE 应答）
// 永久禁用该通道——零重试，S16 节奏契约保持
// （启动时一个特性检测请求，然后静默）。重连仅在
// 真正建立的流断开后发生，带加倍退避（连接维护，
// 绝非数据轮询；定时器 unref'd）。

export interface ActivityEventsSubscription {
  close: () => void;
}

export interface SubscribeActivityEventsOpts {
  /** 打开 SSE 流（daemon-client.openActivityEvents）。null = 通道不可用——
   *  永久禁用，绝不重试。 */
  open: () => Promise<Response | null>;
  /** 一个推送的 oracle 更改（已解析的 SSE data 行）。消费者刷新；它绝不
   *  从推送读取活动字段。 */
  onEvent: (event: { type: string; seatNodeId?: string; seq?: number }) => void;
  /** 连接生命周期说明（断开/重连/不可用）——浮现，绝不致命。 */
  onStatus?: (status: "connected" | "dropped" | "reconnecting" | "unavailable") => void;
  /** 真实流断开后的初始重连退避（ms）；加倍到 30 秒上限。 */
  reconnectDelayMs?: number;
}

const RECONNECT_CAP_MS = 30_000;

export function subscribeActivityEvents(opts: SubscribeActivityEventsOpts): ActivityEventsSubscription {
  const baseDelayMs = opts.reconnectDelayMs ?? 1_000;
  let delayMs = baseDelayMs;
  let closed = false;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const connect = async (): Promise<void> => {
    if (closed) return;
    let established = false;
    try {
      const res = await opts.open();
      if (closed) return;
      if (!res?.body) {
        opts.onStatus?.("unavailable");
        return; // 特性检测说不行——通道保持关闭，S16 行为完整
      }
      established = true;
      delayMs = baseDelayMs; // 真实连接重置退避
      opts.onStatus?.("connected");
      const reader = res.body.getReader();
      activeReader = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue; // 注释/事件名行是成帧
            const raw = line.slice(5).trim();
            if (!raw) continue;
            try {
              opts.onEvent(JSON.parse(raw) as { type: string; seatNodeId?: string; seq?: number });
            } catch {
              // 非 JSON 保活行是成帧，非事件
            }
          }
        }
      }
    } catch {
      // 已建立流上的读取错误——作为下面的断开处理
    } finally {
      activeReader = null;
    }
    if (!closed && established) {
      opts.onStatus?.("dropped");
      reconnectTimer = setTimeout(() => {
        opts.onStatus?.("reconnecting");
        void connect();
      }, delayMs);
      delayMs = Math.min(delayMs * 2, RECONNECT_CAP_MS);
      reconnectTimer.unref?.();
    }
  };

  void connect();
  return {
    close: () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      void activeReader?.cancel().catch(() => {});
    },
  };
}
