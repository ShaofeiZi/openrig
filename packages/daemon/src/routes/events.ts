import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
import type { PersistedEvent } from "../domain/types.js";

export const eventsRoute = new Hono();

function getEventBus(c: { get: (key: string) => unknown }): EventBus {
  return c.get("eventBus" as never) as EventBus;
}

eventsRoute.get("/", (c) => {
  const rigId = c.req.query("rigId"); // 可选——省略则为全局流

  const lastEventIdRaw = c.req.header("Last-Event-ID") ?? "0";
  const lastEventId = parseInt(lastEventIdRaw, 10);
  const lastSeq = isNaN(lastEventId) ? 0 : lastEventId;

  const eventBus = getEventBus(c);

  return streamSSE(c, async (stream) => {
    // 缓冲重放期间到达的活动事件
    const buffer: PersistedEvent[] = [];
    let replaying = true;
    let maxReplayedSeq = lastSeq;

    // 1. 在重放查询之前先订阅活动总线（不丢事件）
    const unsubscribe = eventBus.subscribe((event) => {
      // 工作组范围：按 rigId 过滤。全局：接受所有事件。
      if (rigId) {
        const eventRigId = "rigId" in event ? (event as { rigId: string }).rigId : null;
        if (eventRigId !== rigId) return;
      }
      if (replaying) {
        buffer.push(event);
      } else {
        // 直接流式下发——若重放期间已发送则跳过
        if (event.seq <= maxReplayedSeq) return;
        stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) }).catch(() => {});
      }
    });

    try {
      // 2. 从 DB 重放错过的事件
      const missed = rigId
        ? eventBus.replaySince(lastSeq, rigId)
        : eventBus.replayAll(lastSeq);
      for (const event of missed) {
        await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) });
        if (event.seq > maxReplayedSeq) maxReplayedSeq = event.seq;
      }

      // 3. 仍在重放模式下冲刷缓冲（新的活动事件继续缓冲，保持单调顺序）
      //    循环冲刷，因为冲刷期间可能有新事件到达。
      while (buffer.length > 0) {
        const snapshot = buffer.splice(0);
        for (const event of snapshot) {
          if (event.seq <= maxReplayedSeq) continue; // 去重
          await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) });
          if (event.seq > maxReplayedSeq) maxReplayedSeq = event.seq;
        }
      }

      // 4. 切换到活动模式——新事件直接进入流
      replaying = false;

      // 4. 保持流存活直到客户端断开
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
    } finally {
      unsubscribe();
    }
  });
});
