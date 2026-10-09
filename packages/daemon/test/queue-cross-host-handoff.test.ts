// OPR.0.4.6.MH3 C2——跨主机队列移交编排（消息传递，架构 Q-c 顺序）及 D-1
// 确定性后继 id。关键固定项：
//   - 无 host / "local" 移交 = 当前本地事务式关闭 + 创建，字节完全一致（FR-6）；
//   - 跨主机：先转发后继创建（D-1 派生 id、延续链、来源标签、转发 nudge、移除 hostId），
//     再关闭本地来源（closure_target = 主机限定后继 id，handed_off_to 保持两段式——BR-1/R1）；
//   - 绝不丢弃：转发失败（不可达/未知/ssh）时来源保持不变——接力任务仍存活；
//   - 重驱动：来源已朝匹配的 closure_target 关闭时幂等吸收（使用相同派生 id 再次转发，
//     并在目标主键上吸收）；重驱动指向不同目标时，在任何转发前冲突（绝不为无法完成的
//     重驱动制造目标侧孤儿）；
//   - /handoff 以 `handed-off` 关闭来源；/handoff-and-complete 以 `done` 关闭——
//     编排相同，机制统一。

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
  deriveCrossHostSuccessorId,
} from "../src/domain/queue-repository.js";
import { queueRoutes, CROSS_HOST_TAG } from "../src/routes/queue.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

const REGISTRY: HostRegistry = {
  hosts: [
    { id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "MH3B" },
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

function makeHarness(opts?: { fetchImpl?: typeof fetch }) {
  const db = createDb();
  migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueTargetRepoSchema]);
  const bus = new EventBus(db);
  const repo = new QueueRepository(db, bus, { validateRig: () => true });
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (k: string, v: unknown) => void;
    set("eventBus", bus);
    set("queueRepo", repo);
    set("hostRegistryLoader", () => ({ ok: true, registry: REGISTRY }));
    if (opts?.fetchImpl) set("remoteFetchImpl", opts.fetchImpl);
    await next();
  });
  app.route("/api/queue", queueRoutes());
  return { db, bus, repo, app };
}

function post(app: Hono, path: string, body: Record<string, unknown>) {
  // P21 I3：handoff/create 从传输头推导发送者；请求头与请求体声明相同则允许。
  const sender = body["fromSession"] ?? body["sourceSession"] ?? body["actorSession"];
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(sender ? { "X-OpenRig-Session": String(sender) } : {}) },
    body: JSON.stringify(body),
  });
}

function rowCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) c FROM queue_items").get() as { c: number }).c;
}

async function seedSource(repo: QueueRepository, over?: Partial<{ qitemId: string; tags: string[]; chainOfRecord: string[] }>) {
  return repo.create({
    qitemId: over?.qitemId ?? "qitem-source-1",
    sourceSession: "orch@rig-a",
    destinationSession: "worker@rig-a",
    body: "carry the potato",
    tags: over?.tags,
    chainOfRecord: over?.chainOfRecord,
    nudge: false,
  });
}

const HANDOFF = { fromSession: "worker@rig-a", toSession: "dev@rig-b" };

describe("MH-3 C2——跨主机移交（路由编排）", () => {
  let h: ReturnType<typeof makeHarness>;
  afterEach(() => h?.db.close());

  it("无 host 移交：当前本地事务路径——关闭与创建均在本地，不转发（FR-6 零回归）", async () => {
    let forwarded = false;
    h = makeHarness({ fetchImpl: (async () => { forwarded = true; return jsonResponse({}); }) as unknown as typeof fetch });
    await seedSource(h.repo);
    const res = await post(h.app, "/api/queue/qitem-source-1/handoff", { ...HANDOFF, nudge: false });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { closed: { state: string; closureTarget: string }; created: { qitemId: string } };
    expect(out.closed.state).toBe("handed-off");
    // 本地关闭保留两段式 closure_target（本地语义不变）。
    expect(out.closed.closureTarget).toBe("dev@rig-b");
    // 本地后继行存在——共两行，使用自然 id（非 xh 派生）。
    expect(rowCount(h.db)).toBe(2);
    expect(out.created.qitemId).not.toMatch(/^qitem-xh-/);
    expect(forwarded).toBe(false);
  });

  it('hostId 为 "local"：使用相同本地路径，不转发', async () => {
    let forwarded = false;
    h = makeHarness({ fetchImpl: (async () => { forwarded = true; return jsonResponse({}); }) as unknown as typeof fetch });
    await seedSource(h.repo);
    const res = await post(h.app, "/api/queue/qitem-source-1/handoff", { ...HANDOFF, hostId: "local", nudge: false });
    expect(res.status).toBe(201);
    expect(rowCount(h.db)).toBe(2);
    expect(forwarded).toBe(false);
  });

  it("跨主机移交：先转发后继；再以主机限定后继键和两段式 handed_off_to 关闭来源", async () => {
    const capture: { url?: string; body?: Record<string, unknown> } = {};
    h = makeHarness({
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        capture.url = String(url);
        capture.body = JSON.parse(String(init?.body));
        return jsonResponse({ qitemId: String(capture.body?.["qitemId"]), destinationSession: "dev@rig-b", state: "pending" }, 201);
      }) as unknown as typeof fetch,
    });
    await seedSource(h.repo, { tags: ["keep"], chainOfRecord: ["qitem-root"] });

    const res = await post(h.app, "/api/queue/qitem-source-1/handoff", { ...HANDOFF, hostId: "vps-b", nudge: true });
    expect(res.status).toBe(201);

    // 转发到来源端的 CREATE 路由（唯一共享机制）。
    expect(capture.url).toContain("/api/queue/create");
    // D-1：派生的命名空间后继 id——具有确定性，且等于导出的派生结果。
    const expectedId = deriveCrossHostSuccessorId("qitem-source-1", "dev@rig-b", "vps-b");
    expect(capture.body?.["qitemId"]).toBe(expectedId);
    expect(String(capture.body?.["qitemId"])).toMatch(/^qitem-xh-[0-9a-f]{16}$/);
    // 通过转发请求体延续链（R2b——不透明血缘 id）。
    expect(capture.body?.["chainOfRecord"]).toEqual(["qitem-root", "qitem-source-1"]);
    // 追加 D-4 来源；保留现有标签。
    expect(capture.body?.["tags"]).toContain(CROSS_HOST_TAG);
    expect(capture.body?.["tags"]).toContain("keep");
    // 完整请求体语义：转发 nudge；移除 hostId（BR-1）。
    expect(capture.body?.["nudge"]).toBe(true);
    expect("hostId" in (capture.body ?? {})).toBe(false);
    // 转发请求体中的来源/目标保持两段式会话字符串。
    expect(capture.body?.["sourceSession"]).toBe("worker@rig-a");
    expect(capture.body?.["destinationSession"]).toBe("dev@rig-b");

    // 响应将本地关闭与来源端原样返回的后继配对。
    const out = (await res.json()) as {
      closed: { qitemId: string; state: string; closureReason: string; closureTarget: string; handedOffTo: string };
      created: { qitemId: string };
    };
    expect(out.created.qitemId).toBe(expectedId);
    expect(out.closed.qitemId).toBe("qitem-source-1");
    expect(out.closed.state).toBe("handed-off");
    expect(out.closed.closureReason).toBe("handed_off_to");
    // 关闭目标携带主机限定的后继身份。
    expect(out.closed.closureTarget).toBe(`${expectedId}@vps-b`);
    // ……而会话字符串载体保持两段式（BR-1）。
    expect(out.closed.handedOffTo).toBe("dev@rig-b");

    // 来源端拥有记录：不存在本地后继行——只有已关闭的来源。
    expect(rowCount(h.db)).toBe(1);
    // 持久化层的 BR-1 负向用例：任何会话载体中都没有 @host。
    const row = h.db
      .prepare("SELECT source_session s, destination_session d, blocked_on b, handed_off_to ho FROM queue_items WHERE qitem_id = 'qitem-source-1'")
      .get() as { s: string; d: string; b: string | null; ho: string };
    for (const v of [row.s, row.d, row.b, row.ho]) {
      if (v) expect(v.split("@").length).toBeLessThanOrEqual(2);
    }
  });

  it("跨主机 handoff-and-complete：编排相同，来源以 `done` 关闭", async () => {
    h = makeHarness({
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ qitemId: b["qitemId"] }, 201);
      }) as unknown as typeof fetch,
    });
    await seedSource(h.repo);
    const res = await post(h.app, "/api/queue/qitem-source-1/handoff-and-complete", { ...HANDOFF, hostId: "vps-b", nudge: false });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { closed: { state: string; closureTarget: string } };
    expect(out.closed.state).toBe("done");
    expect(out.closed.closureTarget).toBe(`${deriveCrossHostSuccessorId("qitem-source-1", "dev@rig-b", "vps-b")}@vps-b`);
    expect(rowCount(h.db)).toBe(1);
  });

  it("绝不丢弃：转发失败（不可达）→ 结构化 502，来源保持不变（仍 pending，无关闭转换）", async () => {
    h = makeHarness({ fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch });
    await seedSource(h.repo);
    const res = await post(h.app, "/api/queue/qitem-source-1/handoff", { ...HANDOFF, hostId: "vps-b" });
    expect(res.status).toBe(502);
    expect((await res.json()) as { failureClass: string }).toMatchObject({ error: "remote_queue_write_failed", failureClass: "unreachable" });
    const source = h.repo.getById("qitem-source-1")!;
    expect(source.state).toBe("pending");
    expect(source.closureTarget).toBeNull();
    expect(rowCount(h.db)).toBe(1);
  });

  it("未知主机 / ssh 主机：结构化 502，来源保持不变", async () => {
    h = makeHarness();
    await seedSource(h.repo);
    const unknown = await post(h.app, "/api/queue/qitem-source-1/handoff", { ...HANDOFF, hostId: "nope" });
    expect(unknown.status).toBe(502);
    expect((await unknown.json()) as { failureClass: string }).toMatchObject({ failureClass: "unknown-host" });
    const ssh = await post(h.app, "/api/queue/qitem-source-1/handoff", { ...HANDOFF, hostId: "ssh-1" });
    expect(ssh.status).toBe(502);
    expect((await ssh.json()) as { failureClass: string }).toMatchObject({ failureClass: "unsupported-transport" });
    expect(h.repo.getById("qitem-source-1")!.state).toBe("pending");
  });

  it("重驱动吸收（FR-5，中断关闭用例）：第二次运行以相同派生 id 再转发并吸收已关闭来源——只关闭一次，201 收敛", async () => {
    const forwardedIds: unknown[] = [];
    h = makeHarness({
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
        forwardedIds.push(b["qitemId"]);
        return jsonResponse({ qitemId: b["qitemId"] }, 201);
      }) as unknown as typeof fetch,
    });
    await seedSource(h.repo);
    const first = await post(h.app, "/api/queue/qitem-source-1/handoff", { ...HANDOFF, hostId: "vps-b" });
    expect(first.status).toBe(201);
    const tsAfterFirst = h.repo.getById("qitem-source-1")!.tsUpdated;

    const redrive = await post(h.app, "/api/queue/qitem-source-1/handoff", { ...HANDOFF, hostId: "vps-b" });
    expect(redrive.status).toBe(201);
    // 两次驱动使用相同操作身份——由目标侧主键吸收。
    expect(forwardedIds).toHaveLength(2);
    expect(forwardedIds[0]).toBe(forwardedIds[1]);
    // 本地来源恰好关闭一次（吸收意味着没有第二次写入）。
    const source = h.repo.getById("qitem-source-1")!;
    expect(source.state).toBe("handed-off");
    expect(source.tsUpdated).toBe(tsAfterFirst);
    const closeTransitions = h.repo.transitionLog
      .listForQitem("qitem-source-1")
      .filter((t) => t.state === "handed-off");
    expect(closeTransitions).toHaveLength(1);
  });

  it("前瞻键兼容：约定前的终止来源按已存 member@rig@host 目标重驱动，而不改写历史", async () => {
    h = makeHarness({
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ qitemId: b["qitemId"] }, 201);
      }) as unknown as typeof fetch,
    });
    await seedSource(h.repo);
    h.repo.closeCrossHostHandoffSource({
      qitemId: "qitem-source-1",
      fromSession: "worker@rig-a",
      toSession: "dev@rig-b",
      closureTarget: "dev@rig-b@vps-b",
      terminalState: "handed-off",
    });

    const redrive = await post(h.app, "/api/queue/qitem-source-1/handoff", { ...HANDOFF, hostId: "vps-b" });
    expect(redrive.status).toBe(201);
    expect(h.repo.getById("qitem-source-1")!.closureTarget).toBe("dev@rig-b@vps-b");
  });

  it("重驱动指向不同目标：任何转发前返回 409 cross_host_close_conflict（不创建目标侧孤儿）", async () => {
    let forwardCount = 0;
    h = makeHarness({
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        forwardCount += 1;
        const b = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ qitemId: b["qitemId"] }, 201);
      }) as unknown as typeof fetch,
    });
    await seedSource(h.repo);
    const first = await post(h.app, "/api/queue/qitem-source-1/handoff", { ...HANDOFF, hostId: "vps-b" });
    expect(first.status).toBe(201);
    expect(forwardCount).toBe(1);

    const conflicted = await post(h.app, "/api/queue/qitem-source-1/handoff", { fromSession: "worker@rig-a", toSession: "SOMEONE@rig-z", hostId: "vps-b" });
    expect(conflicted.status).toBe(409);
    expect((await conflicted.json()) as { error: string }).toMatchObject({ error: "cross_host_close_conflict" });
    // 预检在转发前触发——未创建孤儿后继。
    expect(forwardCount).toBe(1);
    // 已记录的关闭保持不变。
    expect(h.repo.getById("qitem-source-1")!.closureTarget).toBe(
      `${deriveCrossHostSuccessorId("qitem-source-1", "dev@rig-b", "vps-b")}@vps-b`,
    );
  });

  it("来源 qitem 未知：返回 404，不转发任何内容", async () => {
    let forwarded = false;
    h = makeHarness({ fetchImpl: (async () => { forwarded = true; return jsonResponse({}); }) as unknown as typeof fetch });
    const res = await post(h.app, "/api/queue/qitem-ghost/handoff", { ...HANDOFF, hostId: "vps-b" });
    expect(res.status).toBe(404);
    expect(forwarded).toBe(false);
  });
});

describe("MH-3 C2——deriveCrossHostSuccessorId（D-1）", () => {
  it("确定且带命名空间：相同 (source,dest,host) → 相同 id；任一参数变化 → 不同 id", () => {
    const a = deriveCrossHostSuccessorId("qitem-s", "dev@rig-b", "vps-b");
    expect(a).toBe(deriveCrossHostSuccessorId("qitem-s", "dev@rig-b", "vps-b"));
    expect(a).toMatch(/^qitem-xh-[0-9a-f]{16}$/);
    expect(a).not.toBe(deriveCrossHostSuccessorId("qitem-s2", "dev@rig-b", "vps-b"));
    expect(a).not.toBe(deriveCrossHostSuccessorId("qitem-s", "dev2@rig-b", "vps-b"));
    expect(a).not.toBe(deriveCrossHostSuccessorId("qitem-s", "dev@rig-b", "vps-c"));
  });
});

describe("MH-3 C2——closeCrossHostHandoffSource（仓库、重驱动语义）", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => h.db.close());

  it("非终止来源：以两段式 handed_off_to、主机限定后继 closure_target 和 handed_off_to 原因关闭", async () => {
    await seedSource(h.repo);
    const closureTarget = `${deriveCrossHostSuccessorId("qitem-source-1", "dev@rig-b", "vps-b")}@vps-b`;
    const out = h.repo.closeCrossHostHandoffSource({
      qitemId: "qitem-source-1",
      fromSession: "worker@rig-a",
      toSession: "dev@rig-b",
      closureTarget,
      terminalState: "handed-off",
    });
    expect(out.absorbed).toBe(false);
    expect(out.item.state).toBe("handed-off");
    expect(out.item.closureReason).toBe("handed_off_to");
    expect(out.item.closureTarget).toBe(closureTarget);
    expect(out.item.handedOffTo).toBe("dev@rig-b");
  });

  it("已终止且 closure_target 匹配：幂等吸收——返回已存行，不产生变更", async () => {
    await seedSource(h.repo);
    const closureTarget = `${deriveCrossHostSuccessorId("qitem-source-1", "dev@rig-b", "vps-b")}@vps-b`;
    h.repo.closeCrossHostHandoffSource({
      qitemId: "qitem-source-1", fromSession: "worker@rig-a", toSession: "dev@rig-b",
      closureTarget, terminalState: "done",
    });
    const ts = h.repo.getById("qitem-source-1")!.tsUpdated;
    const out = h.repo.closeCrossHostHandoffSource({
      qitemId: "qitem-source-1", fromSession: "worker@rig-a", toSession: "dev@rig-b",
      closureTarget, terminalState: "done",
    });
    expect(out.absorbed).toBe(true);
    expect(out.item.tsUpdated).toBe(ts);
  });

  it("已终止且 closure_target 不匹配：结构化 cross_host_close_conflict，绝不覆盖", async () => {
    await seedSource(h.repo);
    const closureTarget = `${deriveCrossHostSuccessorId("qitem-source-1", "dev@rig-b", "vps-b")}@vps-b`;
    h.repo.closeCrossHostHandoffSource({
      qitemId: "qitem-source-1", fromSession: "worker@rig-a", toSession: "dev@rig-b",
      closureTarget, terminalState: "handed-off",
    });
    expect(() =>
      h.repo.closeCrossHostHandoffSource({
        qitemId: "qitem-source-1", fromSession: "worker@rig-a", toSession: "other@rig-c",
        closureTarget: `${deriveCrossHostSuccessorId("qitem-source-1", "other@rig-c", "vps-b")}@vps-b`, terminalState: "handed-off",
      }),
    ).toThrowError(expect.objectContaining({ code: "cross_host_close_conflict" }));
    expect(h.repo.getById("qitem-source-1")!.closureTarget).toBe(closureTarget);
  });
});
