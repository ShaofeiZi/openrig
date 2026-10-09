// OPR.0.4.6.MH3 guard fixback（review 86ba8b42，Finding 1）——PL-007 target_repo 校验
// 必须在任何跨主机转发前运行于 SOURCE 主机。校验权威是位于本地的 source 工作组 typed
// workspace；target 后台服务不认识 source 工作组时会直接透传，因此远端无法补救旁路。固定项：
//   - cross-host create/handoff/handoff-and-complete 带无效显式 targetRepo 时，返回 400
//     unknown_target_repo，不触发转发、不本地写入，handoff 变体也不关闭 source；
//   - 有效显式 targetRepo 仍会转发，check 只做 gate，不阻断功能；
//   - 继承的 source.targetRepo（无显式覆盖）在 handoff 时不重新校验，因为 source row 已接受
//     它（guard fix shape，第 2 点）。

import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { queueRoutes } from "../src/routes/queue.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

const REGISTRY: HostRegistry = {
  hosts: [{ id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "MH3B" }],
};
process.env["MH3B"] = "remote-token";

// fake PL-007 权威：source 工作组 "rig-a" 恰好声明一个 repo。
const FAKE_RIG_REPO = {
  findRigsByName: (name: string) => (name === "rig-a" ? [{ id: "rig-a-id" }] : []),
  getRigWorkspace: (rigId: string) =>
    rigId === "rig-a-id" ? { repos: [{ name: "repo-ok" }] } : null,
};

function makeHarness() {
  const db = createDb();
  migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueTargetRepoSchema]);
  const bus = new EventBus(db);
  const repo = new QueueRepository(db, bus, { validateRig: () => true });
  let forwardCount = 0;
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (k: string, v: unknown) => void;
    set("eventBus", bus);
    set("queueRepo", repo);
    set("rigRepo", FAKE_RIG_REPO);
    set("hostRegistryLoader", () => ({ ok: true, registry: REGISTRY }));
    set("remoteFetchImpl", (async (_u: unknown, init?: RequestInit) => {
      forwardCount += 1;
      const b = JSON.parse(String((init as { body?: unknown })?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ qitemId: b["qitemId"] ?? "qitem-origin" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch);
    await next();
  });
  app.route("/api/queue", queueRoutes());
  const post = (path: string, body: Record<string, unknown>) => {
    // P21 I3：create/handoff 从 transport header 派生 sender；header==body claim 时允许。
    const sender = body["sourceSession"] ?? body["fromSession"] ?? body["actorSession"];
    return app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(sender ? { "X-OpenRig-Session": String(sender) } : {}) },
      body: JSON.stringify(body),
    });
  };
  const rowCount = () => (db.prepare("SELECT COUNT(*) c FROM queue_items").get() as { c: number }).c;
  return { db, repo, post, rowCount, forwards: () => forwardCount };
}

describe("MH-3 guard fixback——PL-007 target_repo 在任何跨主机转发前校验", () => {
  let h: ReturnType<typeof makeHarness>;
  afterEach(() => h?.db.close());

  it("跨主机 CREATE 带无效显式 targetRepo：400 unknown_target_repo，不转发、不本地写入", async () => {
    h = makeHarness();
    const res = await h.post("/api/queue/create", {
      sourceSession: "orch@rig-a", destinationSession: "dev@rig-b",
      body: "x", hostId: "vps-b", targetRepo: "repo-BOGUS", nudge: false,
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "unknown_target_repo" });
    expect(h.forwards()).toBe(0);
    expect(h.rowCount()).toBe(0);
  });

  it("跨主机 CREATE 带有效显式 targetRepo：校验后转发，不写本地 row", async () => {
    h = makeHarness();
    const res = await h.post("/api/queue/create", {
      sourceSession: "orch@rig-a", destinationSession: "dev@rig-b",
      body: "x", hostId: "vps-b", targetRepo: "repo-ok", nudge: false,
    });
    expect(res.status).toBe(201);
    expect(h.forwards()).toBe(1);
    expect(h.rowCount()).toBe(0);
  });

  it("跨主机 HANDOFF 带无效显式 targetRepo：转发前返回 400，source 不关闭", async () => {
    h = makeHarness();
    await h.repo.create({ qitemId: "qitem-src", sourceSession: "orch@rig-a", destinationSession: "worker@rig-a", body: "src", nudge: false });
    const res = await h.post("/api/queue/qitem-src/handoff", {
      fromSession: "worker@rig-a", toSession: "dev@rig-b",
      hostId: "vps-b", targetRepo: "repo-BOGUS", nudge: false,
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "unknown_target_repo" });
    expect(h.forwards()).toBe(0);
    const source = h.repo.getById("qitem-src")!;
    expect(source.state).toBe("pending");
    expect(source.closureTarget).toBeNull();
  });

  it("跨主机 HANDOFF-AND-COMPLETE 带无效显式 targetRepo：转发前返回 400，source 不关闭", async () => {
    h = makeHarness();
    await h.repo.create({ qitemId: "qitem-src2", sourceSession: "orch@rig-a", destinationSession: "worker@rig-a", body: "src", nudge: false });
    const res = await h.post("/api/queue/qitem-src2/handoff-and-complete", {
      fromSession: "worker@rig-a", toSession: "dev@rig-b",
      hostId: "vps-b", targetRepo: "repo-BOGUS", nudge: false,
    });
    expect(res.status).toBe(400);
    expect(h.forwards()).toBe(0);
    expect(h.repo.getById("qitem-src2")!.state).toBe("pending");
  });

  it("跨主机 HANDOFF 带有效显式 targetRepo：完成校验与转发，并关闭 source", async () => {
    h = makeHarness();
    await h.repo.create({ qitemId: "qitem-src3", sourceSession: "orch@rig-a", destinationSession: "worker@rig-a", body: "src", nudge: false });
    const res = await h.post("/api/queue/qitem-src3/handoff", {
      fromSession: "worker@rig-a", toSession: "dev@rig-b",
      hostId: "vps-b", targetRepo: "repo-ok", nudge: false,
    });
    expect(res.status).toBe(201);
    expect(h.forwards()).toBe(1);
    expect(h.repo.getById("qitem-src3")!.state).toBe("handed-off");
  });

  it("跨主机 handoff 不重新校验继承的 source.targetRepo，因为 source row 已接受且没有显式覆盖", async () => {
    h = makeHarness();
    // 用 fake authority 当前会拒绝的 targetRepo 填种 source row；repo 层接受它，因为旧 row 或
    // 已演进 workspace 可能存在。
    await h.repo.create({ qitemId: "qitem-src4", sourceSession: "someone@rig-z", destinationSession: "worker@rig-a", body: "src", targetRepo: "repo-legacy", nudge: false });
    const res = await h.post("/api/queue/qitem-src4/handoff", {
      fromSession: "worker@rig-a", toSession: "dev@rig-b",
      hostId: "vps-b", nudge: false,
    });
    // 无显式覆盖 → 不重新校验 → 继续转发，继承值随 forwarded body 传递。
    expect(res.status).toBe(201);
    expect(h.forwards()).toBe(1);
    expect(h.repo.getById("qitem-src4")!.state).toBe("handed-off");
  });

  it("本地 create/handoff 校验顺序不变，无效显式 targetRepo 仍在本地返回 400", async () => {
    h = makeHarness();
    const create = await h.post("/api/queue/create", {
      sourceSession: "orch@rig-a", destinationSession: "worker@rig-a",
      body: "x", targetRepo: "repo-BOGUS", nudge: false,
    });
    expect(create.status).toBe(400);
    await h.repo.create({ qitemId: "qitem-src5", sourceSession: "orch@rig-a", destinationSession: "worker@rig-a", body: "src", nudge: false });
    const handoff = await h.post("/api/queue/qitem-src5/handoff", {
      fromSession: "worker@rig-a", toSession: "peer@rig-a", targetRepo: "repo-BOGUS", nudge: false,
    });
    expect(handoff.status).toBe(400);
  });
});
