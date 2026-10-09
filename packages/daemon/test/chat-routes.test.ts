import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { chatMessagesSchema } from "../src/db/migrations/016_chat_messages.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { ChatRepository } from "../src/domain/chat-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { chatRoutes } from "../src/routes/chat.js";

function setupDb(): Database.Database {
  const db = createDb();
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, chatMessagesSchema]);
  return db;
}

function createApp(opts: { db: Database.Database; chatRepo: ChatRepository; eventBus: EventBus }): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("chatRepo" as never, opts.chatRepo);
    c.set("eventBus" as never, opts.eventBus);
    await next();
  });
  // 挂载时将 rigId 作为参数。
  app.route("/api/rigs/:rigId/chat", chatRoutes());
  return app;
}

describe("聊天路由", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let chatRepo: ChatRepository;
  let eventBus: EventBus;
  let app: Hono;
  let rigId: string;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    chatRepo = new ChatRepository(db);
    eventBus = new EventBus(db);
    app = createApp({ db, chatRepo, eventBus });
    const rig = rigRepo.createRig("test-rig");
    rigId = rig.id;
  });

  afterEach(() => {
    db.close();
  });

  it("POST /send 持久化并返回消息", async () => {
    const res = await app.request(`/api/rigs/${rigId}/chat/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice" }, // P21 I5：发送者取自传输头（允许请求体声明相同值）。
      body: JSON.stringify({ sender: "alice", body: "hello" }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.sender).toBe("alice");
    expect(data.body).toBe("hello");
    expect(data.id).toBeTruthy();
  });

  // P21 I5——聊天发送从传输头（X-OpenRig-Session）推导发送者，绝不使用 body.sender
  //（`?? "anonymous"` 静默默认值是清查中验证最薄弱的位置）。聊天并非会打断创始人
  // 可见流程的接口，因此默认明确拒绝（不延后处理）。
  it("send——缺少请求头但请求体有 sender 时，以声明的操作者身份交付（201，sender alice）", async () => {
    const res = await app.request(`/api/rigs/${rigId}/chat/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "alice", body: "hi" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).sender).toBe("alice");
  });

  it("send——请求头存在且与请求体 sender 不同时，以线路身份为准（sender alice，201）；不再返回 409", async () => {
    const res = await app.request(`/api/rigs/${rigId}/chat/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice" },
      body: JSON.stringify({ sender: "mallory", body: "hi" }), // 被线路身份覆盖。
    });
    expect(res.status).toBe(201);
    expect((await res.json()).sender).toBe("alice");
  });

  it("send——发送者只从请求头推导，不取自请求体（请求体缺少 sender）", async () => {
    const res = await app.request(`/api/rigs/${rigId}/chat/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice" },
      body: JSON.stringify({ body: "hi" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).sender).toBe("alice");
  });

  it("GET /history 返回消息", async () => {
    chatRepo.send(rigId, "alice", "msg1");
    chatRepo.send(rigId, "bob", "msg2");

    const res = await app.request(`/api/rigs/${rigId}/chat/history`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(2);
    expect(data[0].body).toBe("msg1");
    expect(data[1].body).toBe("msg2");
  });

  it("GET /history?topic=X 按主题过滤", async () => {
    chatRepo.send(rigId, "alice", "before topic");
    chatRepo.sendTopic(rigId, "alice", "deploy");
    chatRepo.send(rigId, "bob", "deploy msg");

    const res = await app.request(`/api/rigs/${rigId}/chat/history?topic=deploy`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBeGreaterThanOrEqual(1);
    const bodies = data.map((m: { body: string }) => m.body);
    expect(bodies).toContain("deploy msg");
  });

  it("POST /topic 创建主题标记", async () => {
    const res = await app.request(`/api/rigs/${rigId}/chat/topic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice" }, // P21 I5：主题发送者取自传输头。
      body: JSON.stringify({ sender: "alice", topic: "standup", body: "daily" }),
    });

    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.kind).toBe("topic");
    expect(data.topic).toBe("standup");
  });

  it("topic——缺少请求头但请求体有 sender 时，以声明的操作者身份交付（201，sender alice）", async () => {
    const res = await app.request(`/api/rigs/${rigId}/chat/topic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: "alice", topic: "standup", body: "daily" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).sender).toBe("alice");
  });

  it("topic——请求头存在且与请求体 sender 不同时，以线路身份为准（sender alice，201）；不再返回 409", async () => {
    const res = await app.request(`/api/rigs/${rigId}/chat/topic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice" },
      body: JSON.stringify({ sender: "mallory", topic: "standup", body: "daily" }), // 被线路身份覆盖。
    });
    expect(res.status).toBe(201);
    expect((await res.json()).sender).toBe("alice");
  });

  it("topic——发送者只从请求头推导，不取自请求体（请求体缺少 sender）", async () => {
    const res = await app.request(`/api/rigs/${rigId}/chat/topic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice" },
      body: JSON.stringify({ topic: "standup", body: "daily" }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).sender).toBe("alice");
  });

  it("GET /watch SSE 流交付初始批次和新消息", async () => {
    // 预置若干消息。
    chatRepo.send(rigId, "alice", "msg1");
    chatRepo.send(rigId, "bob", "msg2");

    const res = await app.request(`/api/rigs/${rigId}/chat/watch`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // 读取流中当前所有可用的数据块。
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let output = "";

    // 持续读取，直到收到两条消息或达到读取次数上限。
    for (let i = 0; i < 10; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
      if (output.includes("msg1") && output.includes("msg2")) break;
    }

    // SSE 数据行应包含预置消息。
    expect(output).toContain("msg1");
    expect(output).toContain("msg2");

    reader.cancel();
  });

  it("GET /history?sender=X 按发送者过滤", async () => {
    chatRepo.send(rigId, "alice", "alice msg");
    chatRepo.send(rigId, "bob", "bob msg");

    const res = await app.request(`/api/rigs/${rigId}/chat/history?sender=alice`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].sender).toBe("alice");
  });

  it("GET /history?since=X 按时间戳过滤", async () => {
    chatRepo.send(rigId, "alice", "msg1");
    chatRepo.send(rigId, "bob", "msg2");

    // 截止时间在未来——没有消息。
    const res = await app.request(`/api/rigs/${rigId}/chat/history?since=${encodeURIComponent("2099-01-01T00:00:00Z")}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(0);

    // 截止时间在过去——包含全部消息。
    const res2 = await app.request(`/api/rigs/${rigId}/chat/history?since=${encodeURIComponent("2020-01-01T00:00:00Z")}`);
    const data2 = await res2.json();
    expect(data2).toHaveLength(2);
  });

  it("POST /clear 删除消息并返回数量", async () => {
    chatRepo.send(rigId, "alice", "msg1");
    chatRepo.send(rigId, "bob", "msg2");

    const res = await app.request(`/api/rigs/${rigId}/chat/clear`, { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.deleted).toBe(2);

    // 验证房间为空。
    const historyRes = await app.request(`/api/rigs/${rigId}/chat/history`);
    const history = await historyRes.json();
    expect(history).toHaveLength(0);
  });

  it("对空房间调用 POST /clear 时返回 deleted: 0", async () => {
    const res = await app.request(`/api/rigs/${rigId}/chat/clear`, { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.deleted).toBe(0);
  });

  it("POST /clear 保留其他工作组的消息", async () => {
    const otherRig = rigRepo.createRig("other-rig");
    chatRepo.send(rigId, "alice", "target msg");
    chatRepo.send(otherRig.id, "bob", "other msg");

    await app.request(`/api/rigs/${rigId}/chat/clear`, { method: "POST" });

    const targetHistory = await (await app.request(`/api/rigs/${rigId}/chat/history`)).json();
    const otherHistory = await (await app.request(`/api/rigs/${otherRig.id}/chat/history`)).json();
    expect(targetHistory).toHaveLength(0);
    expect(otherHistory).toHaveLength(1);
  });
});
