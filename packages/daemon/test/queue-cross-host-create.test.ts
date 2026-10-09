// OPR.0.4.6.MH3 C1——跨主机 queue CREATE（先转发再剥离）+ 来源端主键身份处理。关键约束：
//   - 无 host / "local" create = 与当前本地路径逐字节一致（FR-6）；
//   - 已登记的 http host 把完整 body（生成的 id + provenance + nudge，剥离 hostId）转发到
//     /api/queue/create；原样返回来源响应；绝不写入本地行（FR-2，来源拥有记录）；
//   - unknown / ssh / unreachable host = 包含 host 名称的结构化失败，不写入任何内容
//     （FR-2 如实失败分类）；
//   - 来源端：重新转发的 create 在 id 相同且身份匹配时按主键吸收（FR-5/Q-a）；id 相同但身份
//     不同时产生结构化 qitem_id_reuse 冲突，绝不静默覆盖。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import {
  QueueRepository,
  QueueRepositoryError,
  isQitemPrimaryKeyConflict,
} from "../src/domain/queue-repository.js";
import { queueRoutes, crossHostProvenanceTags, CROSS_HOST_TAG } from "../src/routes/queue.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";
import { setSelfHostId } from "../src/domain/hosts/fanout-contract.js";

const REGISTRY: HostRegistry = {
  hosts: [
    { id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "MH3B" },
    { id: "anon-b", transport: "http", url: "http://anon-b:7433" },
    { id: "ssh-1", transport: "ssh", target: "x.local" },
  ],
};
process.env["MH3B"] = "remote-token";

function jsonResponse(payload: unknown, status = 201): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeApp(opts: {
  db: Database.Database;
  bus: EventBus;
  fetchImpl?: typeof fetch;
}): Hono {
  const queueRepo = new QueueRepository(opts.db, opts.bus, { validateRig: () => true });
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (k: string, v: unknown) => void;
    set("eventBus", opts.bus);
    set("queueRepo", queueRepo);
    set("hostRegistryLoader", () => ({ ok: true, registry: REGISTRY }));
    if (opts.fetchImpl) set("remoteFetchImpl", opts.fetchImpl);
    await next();
  });
  app.route("/api/queue", queueRoutes());
  return app;
}

function post(app: Hono, body: Record<string, unknown>) {
  // P21 I3：create 从 transport header 派生 sender；header==body 声明时允许通过（body 不变，
  // 包括 forward-restamp 测试断言的已有三段式 sourceSession）。
  const sender = body["sourceSession"] ?? body["fromSession"] ?? body["actorSession"];
  return app.request("/api/queue/create", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sender ? { "X-OpenRig-Session": String(sender) } : {}),
    },
    body: JSON.stringify(body),
  });
}

function rowCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) c FROM queue_items").get() as { c: number }).c;
}

const BASE = { sourceSession: "orch@rig-a", destinationSession: "dev@rig-b", body: "执行任务" };

describe("MH-3 C1——跨主机 queue create（route）", () => {
  let db: Database.Database;
  let bus: EventBus;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueTargetRepoSchema]);
    bus = new EventBus(db);
  });
  afterEach(() => db.close());

  it("无 host create：执行本地路径并写入一行本地记录（FR-6 零回归）", async () => {
    const app = makeApp({ db, bus });
    const res = await post(app, BASE);
    expect(res.status).toBe(201);
    expect(rowCount(db)).toBe(1);
    const item = (await res.json()) as { destinationSession: string; hostId?: unknown };
    expect(item.destinationSession).toBe("dev@rig-b");
    expect("hostId" in item).toBe(false);
  });

  it('hostId 为 "local"：使用相同本地路径，只写一行且不转发', async () => {
    let forwarded = false;
    const app = makeApp({ db, bus, fetchImpl: (async () => { forwarded = true; return jsonResponse({}); }) as unknown as typeof fetch });
    const res = await post(app, { ...BASE, hostId: "local" });
    expect(res.status).toBe(201);
    expect(rowCount(db)).toBe(1);
    expect(forwarded).toBe(false);
  });

  it("跨主机 create：转发完整 body（生成的 id、provenance、nudge）并剥离 hostId；原样返回来源响应；无本地行", async () => {
    const capture: { url?: string; body?: Record<string, unknown> } = {};
    const app = makeApp({
      db,
      bus,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        capture.url = String(url);
        capture.body = JSON.parse(String(init?.body));
        return jsonResponse({ qitemId: "qitem-origin-1", destinationSession: "dev@rig-b", state: "pending" }, 201);
      }) as unknown as typeof fetch,
    });
    const res = await post(app, { ...BASE, hostId: "vps-b", nudge: true, tags: ["existing"] });
    expect(res.status).toBe(201);
    // 原样返回来源响应。
    expect((await res.json()) as { qitemId: string }).toMatchObject({ qitemId: "qitem-origin-1" });
    // 转发到来源端的 create route。
    expect(capture.url).toContain("/api/queue/create");
    // 包含生成的 id（Q-a——不依赖调用方）。
    expect(String(capture.body?.["qitemId"])).toMatch(/^qitem-/);
    // 在边缘剥离 hostId（BR-1——绝不带内传输）。
    expect("hostId" in (capture.body ?? {})).toBe(false);
    // 转发包括 nudge 在内的完整 body（FR-3）。
    expect(capture.body?.["nudge"]).toBe(true);
    // 追加 provenance，保留已有 tag（D-4）。
    expect(capture.body?.["tags"]).toContain(CROSS_HOST_TAG);
    expect(capture.body?.["tags"]).toContain("existing");
    // 无本地行（来源拥有记录）。
    expect(rowCount(db)).toBe(0);
  });

  // 51-09 incr 4a 修正——STAMP-AT-FORWARD：转发 daemon 就是来源/sender host，因此构建转发
  // body 时把自身 self-id 写入 sourceSession。否则目的地 daemon 的 create() 会把 receiver host
  // 写入裸 member@rig——恰好在本 slice 要求如实处理的跨主机路径上伪造 sender 身份（响应会路由到
  // 错误 host）。随后由远端的非裸值 guard 保护它。
  it("跨主机 create 在转发时把来源 self-id 写入 sourceSession（绝不是 receiver）", async () => {
    setSelfHostId("host-origin");
    try {
      const capture: { body?: Record<string, unknown> } = {};
      const app = makeApp({
        db, bus,
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
          capture.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return jsonResponse({ qitemId: "qitem-fwd", destinationSession: "dev@rig-b" }, 201);
        }) as unknown as typeof fetch,
      });
      const res = await post(app, { ...BASE, hostId: "vps-b" }); // BASE.sourceSession = "orch@rig-a" (bare)
      expect(res.status).toBe(201);
      // 由来源写入（host-origin），而非 receiver vps-b。
      expect(capture.body?.["sourceSession"]).toBe("orch@rig-a@host-origin");
    } finally {
      setSelfHostId(null);
    }
  });

  it("跨主机 create 转发时原样保留已有三段式 sourceSession（不重新伪造来源）", async () => {
    setSelfHostId("host-origin");
    try {
      const capture: { body?: Record<string, unknown> } = {};
      const app = makeApp({
        db, bus,
        fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
          capture.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return jsonResponse({ qitemId: "qitem-fwd", destinationSession: "dev@rig-b" }, 201);
        }) as unknown as typeof fetch,
      });
      await post(app, { ...BASE, sourceSession: "orch@rig-a@host-elsewhere", hostId: "vps-b" });
      expect(capture.body?.["sourceSession"]).toBe("orch@rig-a@host-elsewhere");
    } finally {
      setSelfHostId(null);
    }
  });

  it("向仅 URL（匿名）host 跨主机 create：转发省略 Authorization；bearer host 仍发送该 header", async () => {
    const anonHeaders: { value?: HeadersInit } = {};
    const anonApp = makeApp({
      db,
      bus,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        anonHeaders.value = init?.headers;
        return jsonResponse({ qitemId: "qitem-anon-1", destinationSession: "dev@rig-b", state: "pending" }, 201);
      }) as unknown as typeof fetch,
    });
    const anonRes = await post(anonApp, { ...BASE, hostId: "anon-b" });
    expect(anonRes.status).toBe(201);
    expect("Authorization" in ((anonHeaders.value ?? {}) as Record<string, string>)).toBe(false);

    const bearerHeaders: { value?: HeadersInit } = {};
    const bearerApp = makeApp({
      db,
      bus,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        bearerHeaders.value = init?.headers;
        return jsonResponse({ qitemId: "qitem-b-1", destinationSession: "dev@rig-b", state: "pending" }, 201);
      }) as unknown as typeof fetch,
    });
    const bearerRes = await post(bearerApp, { ...BASE, hostId: "vps-b" });
    expect(bearerRes.status).toBe(201);
    expect((bearerHeaders.value as Record<string, string>)["Authorization"]).toBe("Bearer remote-token");
  });

  it("调用方提供 --id 的跨主机 create：转发该 id（仅在缺失时生成）", async () => {
    const capture: { body?: Record<string, unknown> } = {};
    const app = makeApp({
      db,
      bus,
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        capture.body = JSON.parse(String(init?.body));
        return jsonResponse({ qitemId: "qitem-mine" });
      }) as unknown as typeof fetch,
    });
    await post(app, { ...BASE, hostId: "vps-b", qitemId: "qitem-mine" });
    expect(capture.body?.["qitemId"]).toBe("qitem-mine");
  });

  it("未知 host：返回包含 host 名称的结构化失败（502），本地不写入任何内容", async () => {
    const app = makeApp({ db, bus });
    const res = await post(app, { ...BASE, hostId: "nope" });
    expect(res.status).toBe(502);
    const err = (await res.json()) as { error: string; hostId: string; failureClass: string };
    expect(err.error).toBe("remote_queue_write_failed");
    expect(err.hostId).toBe("nope");
    expect(err.failureClass).toBe("unknown-host");
    expect(rowCount(db)).toBe(0);
  });

  it("ssh host：返回 unsupported-transport（502），本地不写入任何内容", async () => {
    const app = makeApp({ db, bus });
    const res = await post(app, { ...BASE, hostId: "ssh-1" });
    expect(res.status).toBe(502);
    expect((await res.json()) as { failureClass: string }).toMatchObject({ failureClass: "unsupported-transport" });
    expect(rowCount(db)).toBe(0);
  });

  it("来源不可达：返回结构化 unreachable 失败，本地不写入任何内容", async () => {
    const app = makeApp({
      db,
      bus,
      fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
    });
    const res = await post(app, { ...BASE, hostId: "vps-b" });
    expect(res.status).toBe(502);
    expect((await res.json()) as { failureClass: string }).toMatchObject({ failureClass: "unreachable" });
    expect(rowCount(db)).toBe(0);
  });
});

describe("MH-3 C1——来源端主键身份处理（repo）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueTargetRepoSchema]);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { validateRig: () => true });
  });
  afterEach(() => db.close());

  it("主键吸收：重新转发的 create 使用相同 id + 匹配身份时返回现有行，且恰好一行", async () => {
    const first = await repo.create({ qitemId: "qitem-x", ...BASE, nudge: false });
    const again = await repo.create({ qitemId: "qitem-x", ...BASE, nudge: false });
    expect(again.qitemId).toBe(first.qitemId);
    expect(again.tsCreated).toBe(first.tsCreated); // 已存储行，而非新插入
    expect(rowCount(db)).toBe(1);
  });

  it("id-reuse：相同 id、不同 destination = 结构化 qitem_id_reuse 冲突；原记录不变", async () => {
    await repo.create({ qitemId: "qitem-x", ...BASE, nudge: false });
    await expect(
      repo.create({ qitemId: "qitem-x", sourceSession: "orch@rig-a", destinationSession: "SOMEONE@rig-z", body: "不同内容", nudge: false }),
    ).rejects.toMatchObject({ code: "qitem_id_reuse" });
    const row = db.prepare("SELECT destination_session d FROM queue_items WHERE qitem_id = 'qitem-x'").get() as { d: string };
    expect(row.d).toBe("dev@rig-b"); // 从未覆盖
    expect(rowCount(db)).toBe(1);
  });
});

describe("MH-3 C1——纯辅助函数", () => {
  it("crossHostProvenanceTags：追加 marker + from-host、保留已有值且幂等", () => {
    const once = crossHostProvenanceTags(["keep"]);
    expect(once).toContain("keep");
    expect(once).toContain(CROSS_HOST_TAG);
    expect(once.some((t) => t.startsWith("from-host:"))).toBe(true);
    // 幂等——重新标记已标记的列表不会添加新内容。
    expect(crossHostProvenanceTags(once).length).toBe(once.length);
    // undefined 基值可安全处理。
    expect(crossHostProvenanceTags(undefined)).toContain(CROSS_HOST_TAG);
  });

  it("isQitemPrimaryKeyConflict：qitem_id 的 PK/UNIQUE 约束返回 true，否则返回 false", () => {
    const byCode = Object.assign(new Error("x"), { code: "SQLITE_CONSTRAINT_PRIMARYKEY" });
    expect(isQitemPrimaryKeyConflict(byCode)).toBe(true);
    const byMsg = new Error("UNIQUE constraint failed: queue_items.qitem_id");
    expect(isQitemPrimaryKeyConflict(byMsg)).toBe(true);
    expect(isQitemPrimaryKeyConflict(new Error("some other error"))).toBe(false);
    expect(isQitemPrimaryKeyConflict("not an error")).toBe(false);
  });
});
