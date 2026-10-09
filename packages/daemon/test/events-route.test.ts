import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { EventBus } from "../src/domain/event-bus.js";
import { createDaemon } from "../src/startup.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";

/**
 * 从流式响应读取 SSE 行，直到数量足够或超时。
 * 返回解析为 { id, data } 对象的 SSE 事件。
 */
async function readSSEEvents(
  res: Response,
  count: number,
  timeoutMs = 500
): Promise<{ id: string; data: string }[]> {
  const events: { id: string; data: string }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const deadline = Date.now() + timeoutMs;

  while (events.length < count && Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: true }>((resolve) =>
        setTimeout(() => resolve({ value: undefined, done: true }), Math.max(1, deadline - Date.now()))
      ),
    ]);

    if (done && !value) break;
    if (value) buffer += decoder.decode(value, { stream: true });

    // 解析完整 SSE 块（以 \n\n 分隔）。
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop()!; // keep incomplete block

    for (const block of blocks) {
      if (!block.trim()) continue;
      let id = "";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("id:")) id = line.slice(3).trim();
        if (line.startsWith("data:")) data = line.slice(5).trim();
      }
      if (data) events.push({ id, data });
    }
  }

  reader.cancel().catch(() => {});
  return events;
}

describe("SSE 事件路由", () => {
  let db: Database.Database;
  let app: Hono;
  let rigRepo: RigRepository;
  let eventBus: EventBus;

  beforeEach(() => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    app = setup.app;
    rigRepo = setup.rigRepo;
    eventBus = setup.eventBus;
  });

  afterEach(() => {
    db.close();
  });

  it("连接 SSE 后收到 content-type text/event-stream", async () => {
    const rig = rigRepo.createRig("r01");
    const res = await app.request(`/api/events?rigId=${rig.id}`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // 取消流。
    res.body?.cancel();
  });

  it("总线发出事件后，流以带 id 字段的 SSE 数据行接收", async () => {
    const rig = rigRepo.createRig("r01");

    const res = await app.request(`/api/events?rigId=${rig.id}`);

    // 连接后发出事件。
    setTimeout(() => {
      eventBus.emit({ type: "rig.created", rigId: rig.id });
    }, 10);

    const events = await readSSEEvents(res, 1);
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBeDefined();
    expect(events[0]!.id).not.toBe("");
    const parsed = JSON.parse(events[0]!.data);
    expect(parsed.type).toBe("rig.created");
  });

  it("Last-Event-ID 重放：携带 header 连接后从数据库取得错过的事件", async () => {
    const rig = rigRepo.createRig("r01");

    // 连接前预先发出事件。
    const e1 = eventBus.emit({ type: "rig.created", rigId: rig.id });
    const e2 = eventBus.emit({ type: "node.added", rigId: rig.id, nodeId: "n1", logicalId: "worker" });

    // 以 Last-Event-ID = e1.seq 连接（应只重放 e2）。
    const res = await app.request(`/api/events?rigId=${rig.id}`, {
      headers: { "Last-Event-ID": String(e1.seq) },
    });

    const events = await readSSEEvents(res, 1);
    expect(events).toHaveLength(1);
    const parsed = JSON.parse(events[0]!.data);
    expect(parsed.type).toBe("node.added");
    expect(events[0]!.id).toBe(String(e2.seq));
  });

  it("无缺口：重放窗口内发出的事件恰好交付一次", async () => {
    const rig = rigRepo.createRig("r01");

    // 预先发出 2 个事件。
    const e1 = eventBus.emit({ type: "rig.created", rigId: rig.id });
    eventBus.emit({ type: "node.added", rigId: rig.id, nodeId: "n1", logicalId: "a" });

    // 以 Last-Event-ID = e1.seq 连接，随后立即发出另一个可能落入重放和实时重叠窗口的事件。
    const res = await app.request(`/api/events?rigId=${rig.id}`, {
      headers: { "Last-Event-ID": String(e1.seq) },
    });

    // 在重放窗口中发出。
    setTimeout(() => {
      eventBus.emit({ type: "node.added", rigId: rig.id, nodeId: "n2", logicalId: "b" });
    }, 10);

    const events = await readSSEEvents(res, 3, 1000);

    // 应恰好有 2 个：重放的 e2 加实时的 e3。e2 应只出现一次（按 seq 去重）。
    const seqs = events.map((e) => e.id);
    const uniqueSeqs = new Set(seqs);
    expect(uniqueSeqs.size).toBe(seqs.length); // no duplicates
    expect(events.length).toBe(2);
  });

  it("客户端断开后清理订阅者（subscriberCount 下降）", async () => {
    const rig = rigRepo.createRig("r01");
    const countBefore = eventBus.subscriberCount;

    const res = await app.request(`/api/events?rigId=${rig.id}`);

    // 给流一点时间建立订阅。
    await new Promise((r) => setTimeout(r, 50));
    expect(eventBus.subscriberCount).toBe(countBefore + 1);

    // 读取一个事件后取消（断开连接）。
    setTimeout(() => {
      eventBus.emit({ type: "rig.created", rigId: rig.id });
    }, 10);
    await readSSEEvents(res, 1);

    // readSSEEvents 会调用 reader.cancel()——给流一点清理时间。
    await new Promise((r) => setTimeout(r, 100));
    expect(eventBus.subscriberCount).toBe(countBefore);
  });

  it("rigId 过滤：仅流式发送所请求工作组的事件", async () => {
    const rig1 = rigRepo.createRig("r01");
    const rig2 = rigRepo.createRig("r02");

    const res = await app.request(`/api/events?rigId=${rig1.id}`);

    setTimeout(() => {
      eventBus.emit({ type: "rig.created", rigId: rig2.id }); // different rig
      eventBus.emit({ type: "rig.created", rigId: rig1.id }); // target rig
    }, 10);

    const events = await readSSEEvents(res, 1);
    expect(events).toHaveLength(1);
    const parsed = JSON.parse(events[0]!.data);
    expect(parsed.rigId).toBe(rig1.id);
  });

  it("缺少 rigId 时返回全局 SSE 流（200）", async () => {
    const res = await app.request("/api/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // 取消流。
    if (res.body) {
      const reader = res.body.getReader();
      reader.cancel().catch(() => {});
    }
  });

  it("无效的 Last-Event-ID（非数字）按 0 处理，并重放全部事件", async () => {
    const rig = rigRepo.createRig("r01");
    eventBus.emit({ type: "rig.created", rigId: rig.id });
    eventBus.emit({ type: "node.added", rigId: rig.id, nodeId: "n1", logicalId: "worker" });

    const res = await app.request(`/api/events?rigId=${rig.id}`, {
      headers: { "Last-Event-ID": "garbage" },
    });

    // 应重放全部事件（将畸形值按 0 处理）。
    const events = await readSSEEvents(res, 2);
    expect(events).toHaveLength(2);
  });

  it("SSE id 字段与事件序号匹配", async () => {
    const rig = rigRepo.createRig("r01");
    const emitted = eventBus.emit({ type: "rig.created", rigId: rig.id });

    const res = await app.request(`/api/events?rigId=${rig.id}`, {
      headers: { "Last-Event-ID": "0" },
    });

    const events = await readSSEEvents(res, 1);
    expect(events[0]!.id).toBe(String(emitted.seq));
  });

  it("生产应用挂载 /api/events（回归）", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";

    const { app: prodApp, db: prodDb, deps } = await createDaemon({ cmuxFactory, tmuxExec });
    const rig = deps.rigRepo.createRig("r01");

    const res = await prodApp.request(`/api/events?rigId=${rig.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    res.body?.cancel();

    prodDb.close();
  });
});
