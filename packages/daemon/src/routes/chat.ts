import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
import type { ChatRepository } from "../domain/chat-repository.js";
import { requireSenderIdentity } from "./require-sender-identity.js";

export function chatRoutes(): Hono {
  const app = new Hono();

  function getChatRepo(c: { get: (key: string) => unknown }): ChatRepository {
    return c.get("chatRepo" as never) as ChatRepository;
  }

  function getEventBus(c: { get: (key: string) => unknown }): EventBus {
    return c.get("eventBus" as never) as EventBus;
  }

  // POST /send —— 持久化消息并发出事件
  app.post("/send", async (c) => {
    const rigId = c.req.param("rigId");
    if (!rigId) return c.json({ error: "缺少 rigId" }, 400);

    const body = await c.req.json<{ sender?: string; body?: string }>().catch(() => ({} as { sender?: string; body?: string }));
    if (!body.body) return c.json({ error: "缺少 body" }, 400);

    // P21 I5：聊天发送方是传输派生的身份，绝不取 body.sender（那个 `?? "anonymous"` 静默默认）。
    // P18 投递并标注：body.sender 被线路（transport:v1）取代；头缺失 + body.sender 记录
    // claimed:v1；既无头也无 body → 400 actor_required。
    const identity = requireSenderIdentity(c, { verb: "发送聊天消息", bodyClaim: body.sender });
    if (!identity.ok) return identity.response;
    const sender = identity.session;
    const chatRepo = getChatRepo(c);
    const eventBus = getEventBus(c);

    const msg = chatRepo.send(rigId, sender, body.body);

    eventBus.emit({
      type: "chat.message",
      rigId,
      messageId: msg.id,
      sender: msg.sender,
      kind: msg.kind,
      body: msg.body,
    });

    return c.json(msg, 201);
  });

  // GET /history —— 查询消息历史
  app.get("/history", (c) => {
    const rigId = c.req.param("rigId");
    if (!rigId) return c.json({ error: "缺少 rigId" }, 400);

    const topic = c.req.query("topic");
    const limitStr = c.req.query("limit");
    const after = c.req.query("after");
    const since = c.req.query("since");
    const sender = c.req.query("sender");
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;

    const chatRepo = getChatRepo(c);
    const messages = chatRepo.history(rigId, { topic, limit, after, since, sender });

    return c.json(messages);
  });

  // GET /watch —— 聊天消息的 SSE 流
  app.get("/watch", (c) => {
    const rigId = c.req.param("rigId");
    if (!rigId) return c.json({ error: "缺少 rigId" }, 400);

    const chatRepo = getChatRepo(c);
    const eventBus = getEventBus(c);

    return streamSSE(c, async (stream) => {
      // 先订阅，避免初始批次与新消息之间的竞态
      const pendingMessages: Array<{ id: string; data: string }> = [];
      let initialDone = false;
      const unsubscribe = eventBus.subscribe((event) => {
        if (event.type === "chat.message" && "rigId" in event && (event as { rigId: string }).rigId === rigId) {
          const chatEvent = event as { messageId: string; sender: string; kind: string; body: string; topic?: string; rigId: string };
          const msg = {
            id: chatEvent.messageId,
            rigId: chatEvent.rigId,
            sender: chatEvent.sender,
            kind: chatEvent.kind,
            body: chatEvent.body,
            topic: chatEvent.topic ?? null,
            createdAt: event.createdAt,
          };
          const sseMsg = { id: msg.id, data: JSON.stringify(msg) };
          if (initialDone) {
            stream.writeSSE(sseMsg).catch(() => {});
          } else {
            pendingMessages.push(sseMsg);
          }
        }
      });

      // 发送初始批次
      const initial = chatRepo.latest(rigId, 20);
      const sentIds = new Set<string>();
      for (const msg of initial) {
        await stream.writeSSE({ id: msg.id, data: JSON.stringify(msg) });
        sentIds.add(msg.id);
      }

      // 冲刷初始批次期间收到的消息，按 ID 去重
      initialDone = true;
      for (const pending of pendingMessages) {
        if (!sentIds.has(pending.id)) {
          await stream.writeSSE(pending);
        }
      }

      try {
        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve());
        });
      } finally {
        unsubscribe();
      }
    });
  });

  // POST /topic —— 创建话题标记
  app.post("/topic", async (c) => {
    const rigId = c.req.param("rigId");
    if (!rigId) return c.json({ error: "缺少 rigId" }, 400);

    const body = await c.req.json<{ sender?: string; topic?: string; body?: string }>().catch(() => ({} as { sender?: string; topic?: string; body?: string }));
    if (!body.topic) return c.json({ error: "缺少 topic" }, 400);

    // P21 I5：话题发送方是传输派生的身份，绝不取 body.sender（P18 投递并标注：
    // 线路取代 body.sender；头缺失记录 claimed:v1；无执行者 → 400 actor_required）。
    const identity = requireSenderIdentity(c, { verb: "创建聊天话题", bodyClaim: body.sender });
    if (!identity.ok) return identity.response;
    const sender = identity.session;
    const chatRepo = getChatRepo(c);
    const eventBus = getEventBus(c);

    const msg = chatRepo.sendTopic(rigId, sender, body.topic, body.body);

    eventBus.emit({
      type: "chat.message",
      rigId,
      messageId: msg.id,
      sender: msg.sender,
      kind: msg.kind,
      body: msg.body,
      topic: msg.topic ?? undefined,
    });

    return c.json(msg, 201);
  });

  // POST /clear —— 删除该工作组的所有消息
  app.post("/clear", (c) => {
    const rigId = c.req.param("rigId");
    if (!rigId) return c.json({ error: "缺少 rigId" }, 400);

    const chatRepo = getChatRepo(c);
    const result = chatRepo.clear(rigId);
    return c.json({ ok: true, deleted: result.deleted });
  });

  return app;
}
