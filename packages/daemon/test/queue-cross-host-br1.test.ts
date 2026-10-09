// OPR.0.4.6.MH3 C4——合并后的 BR-1 负向控制（计划 §4 C4，QA2 note 10 的单元级镜像）：
// 完整跨 host 遍历（本地 create、跨 host create、跨 host handoff、本地 handoff、跨 host
// handoff-and-complete）后，queue schema 中任何已持久化 session 字符串 carrier 都不携带 `@host`
// 扩展——`destination_session`、`source_session`、`blocked_on`、`handed_off_to`/`handed_off_from`、
// transition log 的 `actor_session`，以及 transition log 的自由文本 `transition_note`（rev1-r2 B1：
// note 同样是持久 audit carrier；按 token 扫描，因为一条 note 可以如实提及两个独立的两段式 session）
// 均保持非三段式。唯一允许（且跨 host 闭合时必须）携带带 host 限定 successor key 的列，是
// queue_items 上的 `closure_target` 及其在 queue_transitions 中的原样镜像；以正向断言锁定，确保
// 该豁免是一项契约，而非偶然。
//
// VM proof 的 leg-7 grep 会在两个 daemon home 上运行同一负向检查；此单元镜像从源头锁定 A 侧
// writer 路径。

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
import { QueueRepository, deriveCrossHostSuccessorId } from "../src/domain/queue-repository.js";
import { queueRoutes } from "../src/routes/queue.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

const REGISTRY: HostRegistry = {
  hosts: [{ id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "MH3B" }],
};
process.env["MH3B"] = "remote-token";

const atParts = (s: string): number => s.split("@").length - 1;

describe("MH-3 C4——BR-1 扫描：完整跨 host 遍历后，任何持久化 session carrier 中均无 @host", () => {
  let db: Database.Database;
  afterEach(() => db?.close());

  it("所有 session carrier 均保持至多两段；跨 host 闭合时只有 closure_target 携带 host 限定 successor key", async () => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueTargetRepoSchema]);
    const bus = new EventBus(db);
    const repo = new QueueRepository(db, bus, { validateRig: () => true });
    const app = new Hono();
    app.use("*", async (c, next) => {
      const set = c.set.bind(c) as (k: string, v: unknown) => void;
      set("eventBus", bus);
      set("queueRepo", repo);
      set("hostRegistryLoader", () => ({ ok: true, registry: REGISTRY }));
      set("remoteFetchImpl", (async (_u: unknown, init?: RequestInit) => {
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
      // P21 I3：create/handoff 从 transport header 推导 sender；header == body 声明 ⇒ 可接受。
      const sender = body["sourceSession"] ?? body["fromSession"] ?? body["actorSession"];
      return app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(sender ? { "X-OpenRig-Session": String(sender) } : {}) },
        body: JSON.stringify(body),
      });
    };

    // 遍历：MH-3 涉及的每条 writer 路径，包括本地与跨 host。
    expect((await post("/api/queue/create", { sourceSession: "orch@rig-a", destinationSession: "w1@rig-a", body: "local", nudge: false })).status).toBe(201);
    expect((await post("/api/queue/create", { sourceSession: "orch@rig-a", destinationSession: "dev@rig-b", body: "xh", hostId: "vps-b", nudge: false })).status).toBe(201);
    await repo.create({ qitemId: "qitem-xh-src", sourceSession: "orch@rig-a", destinationSession: "w2@rig-a", body: "src", nudge: false });
    expect((await post("/api/queue/qitem-xh-src/handoff", { fromSession: "w2@rig-a", toSession: "dev@rig-b", hostId: "vps-b", nudge: false })).status).toBe(201);
    await repo.create({ qitemId: "qitem-local-src", sourceSession: "orch@rig-a", destinationSession: "w3@rig-a", body: "src2", nudge: false });
    expect((await post("/api/queue/qitem-local-src/handoff", { fromSession: "w3@rig-a", toSession: "w4@rig-a", nudge: false })).status).toBe(201);
    await repo.create({ qitemId: "qitem-xh-src2", sourceSession: "orch@rig-a", destinationSession: "w5@rig-a", body: "src3", nudge: false });
    expect((await post("/api/queue/qitem-xh-src2/handoff-and-complete", { fromSession: "w5@rig-a", toSession: "dev@rig-b", hostId: "vps-b", nudge: false })).status).toBe(201);

    // 全面扫描——每个已持久化 session 字符串 carrier、每一行。
    const items = db
      .prepare("SELECT qitem_id id, source_session s, destination_session d, blocked_on b, handed_off_to ht, handed_off_from hf, closure_target ct FROM queue_items")
      .all() as Array<{ id: string; s: string; d: string; b: string | null; ht: string | null; hf: string | null; ct: string | null }>;
    expect(items.length).toBeGreaterThan(0);
    for (const row of items) {
      for (const carrier of [row.s, row.d, row.b, row.ht, row.hf]) {
        if (carrier) expect(atParts(carrier), `${row.id} 上的 session carrier '${carrier}' 必须保持至多两段`).toBeLessThanOrEqual(1);
      }
    }
    // rev1-r1 扩展：这里枚举完整的 queue_transitions opaque/free-text 列集合——actor_session、
    // transition_note、closure_reason、closure_target；表中没有未扫描或未锁定的内容。
    const transitions = db
      .prepare("SELECT qitem_id id, actor_session a, transition_note n, closure_reason cr, closure_target ct FROM queue_transitions")
      .all() as Array<{ id: string; a: string; n: string | null; cr: string | null; ct: string | null }>;
    expect(transitions.length).toBeGreaterThan(0);
    for (const t of transitions) {
      expect(atParts(t.a), `actor_session '${t.a}' 必须保持至多两段`).toBeLessThanOrEqual(1);
      if (t.cr) expect(atParts(t.cr), `closure_reason '${t.cr}' 不得携带任何 session 形式`).toBe(0);
      // rev1-r2 B1：transition_note 是持久 carrier——其中任何单个 token 都不得采用三段式
      // member@rig@host。按 token 而非整串检查：一条 note 可以合法点名两个独立的两段式 session
      //（fallback-routed note 正是如此）。
      if (t.n) {
        for (const token of t.n.split(/\s+/)) {
          expect(atParts(token), `${t.id} 上的 transition_note token '${token}' 不得为三段式`).toBeLessThanOrEqual(1);
        }
      }
    }

    // 正向锁定豁免：两个跨 host source close 都携带由 host 限定的确定性 successor qitem，且没有
    // 其他内容携带该 host suffix。transition 镜像完全相同的值。
    const expectedClosureTargets = ["qitem-xh-src", "qitem-xh-src2"].map((id) =>
      `${id}:${deriveCrossHostSuccessorId(id, "dev@rig-b", "vps-b")}@vps-b`,
    ).sort();
    const hostQualifiedCts = items
      .filter((r) => r.ct?.endsWith("@vps-b"))
      .map((r) => r.id)
      .sort();
    expect(hostQualifiedCts).toEqual(["qitem-xh-src", "qitem-xh-src2"]);
    for (const row of items) {
      if (row.ct) expect(atParts(row.ct)).toBeLessThanOrEqual(2);
    }
    // Guard G-MH3-BR1-FIXBACK-1：必须在值上证明“原样镜像”，而非只看 id/count——比较准确的
    // (qitem_id, closure_target) 集合，使正确 qitem 上错误的 host 限定值（或互换）无法通过。
    const itemClosureTargets = items
      .filter((r) => r.ct?.endsWith("@vps-b"))
      .map((r) => `${r.id}:${r.ct}`)
      .sort();
    const transitionClosureTargets = transitions
      .filter((t) => t.ct?.endsWith("@vps-b"))
      .map((t) => `${t.id}:${t.ct}`)
      .sort();
    expect(transitionClosureTargets).toEqual(itemClosureTargets);
    expect(itemClosureTargets).toEqual(expectedClosureTargets);
    for (const t of transitions) {
      if (t.ct) expect(atParts(t.ct)).toBeLessThanOrEqual(2);
    }

    // 在最严格处锁定 B1 回归：跨 host source close 生成默认 note（本次遍历没有 caller note）——
    // 它必须引用两段式 toSession，且不得包含三段式形式。
    const xhCloseNotes = transitions.filter(
      (t) => (t.id === "qitem-xh-src" || t.id === "qitem-xh-src2") && t.n?.startsWith("cross-host handoff to ")
    );
    expect(xhCloseNotes.length).toBe(2);
    for (const t of xhCloseNotes) {
      expect(t.n).toContain("dev@rig-b");
      expect(t.n).not.toContain("dev@rig-b@vps-b");
    }
  });
});
