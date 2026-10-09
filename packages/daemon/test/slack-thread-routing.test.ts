// S10——确定性 thread↔seat 路由 receipt（证明契约：在枚举的四类中固定错误席位缺失）、从 queue-row
// 标记重建 mapping，以及通过真实投递路径复用 outbound thread。全程零推断：每条断言都是精确查询结果。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../src/db/migrate.js";
import { threadSeatMapSchema } from "../src/db/migrations/072_thread_seat_map.js";
import { ThreadSeatMap, formatPostedStamp, parsePostedStamp } from "../src/domain/gateway/slack/thread-seat-map.js";
import { makeThreadRouteResolver } from "../src/domain/gateway/slack/thread-routing.js";
import { InboundRouter, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { SeenStore, DeadLetterStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import { buildInProcessWire } from "../src/domain/gateway/gateway-subsystem.js";
import { OUTBOUND_OP } from "../src/domain/gateway/slack/outbound-driver.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

function mapDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, [threadSeatMapSchema]);
  return db;
}
function memFs(): StateFsOps {
  const files = new Map<string, string>();
  return {
    readFileSync: (p) => { if (!files.has(p)) throw new Error("ENOENT"); return files.get(p)!; },
    appendFileSync: (p, d) => files.set(p, (files.get(p) ?? "") + d),
    writeFileSync: (p, d) => files.set(p, d),
    rename: (a, b) => { files.set(b, files.get(a) ?? ""); files.delete(a); },
    mkdirp: () => {},
  };
}
const clock = () => new Date("2026-08-27T00:00:00.000Z");
const flush = () => new Promise((r) => setTimeout(r, 5));

describe("thread↔seat map——精确查询语义", () => {
  it("open → resolveByThread → close：状态转换期间 mapping 永不丢失", () => {
    const map = new ThreadSeatMap(mapDb(), clock);
    map.open({ threadTs: "T1", channel: "C1", human: "human-founder@kernel", seat: "dev-driver@v-openrig-build", conversationId: "qitem-1" });
    expect(map.resolveByThread("T1")).toMatchObject({ seat: "dev-driver@v-openrig-build", state: "open" });
    map.close("T1");
    expect(map.resolveByThread("T1")).toMatchObject({ seat: "dev-driver@v-openrig-build", state: "closed" }); // closed ≠ unmapped
  });

  it("open 对 thread_ts 幂等（重放的 root 只保留一行，即首个 mapping）", () => {
    const map = new ThreadSeatMap(mapDb(), clock);
    map.open({ threadTs: "T1", channel: "C1", human: "h", seat: "seat-a@r", conversationId: "q1" });
    map.open({ threadTs: "T1", channel: "C1", human: "h", seat: "seat-B@r", conversationId: "q2" }); // replay/dup
    expect(map.resolveByThread("T1")!.seat).toBe("seat-a@r"); // never silently remapped
  });

  it("resolveOpenForPair 只复用该精确 pair 的 OPEN conversation", () => {
    const map = new ThreadSeatMap(mapDb(), clock);
    map.open({ threadTs: "T1", channel: "C1", human: "h1", seat: "s1", conversationId: "q1" });
    map.open({ threadTs: "T2", channel: "C1", human: "h1", seat: "s2", conversationId: "q2" });
    map.close("T1");
    expect(map.resolveOpenForPair("h1", "s1")).toBeNull(); // closed → no reuse
    expect(map.resolveOpenForPair("h1", "s2")!.threadTs).toBe("T2"); // exact pair only
    expect(map.resolveOpenForPair("h2", "s2")).toBeNull(); // wrong human never matches
  });

  it("resolveOpenForConversation 不会混淆共享同一 human+seat pair 的两个 human gate", () => {
    const map = new ThreadSeatMap(mapDb(), clock);
    map.open({ threadTs: "T1", channel: "C1", human: "h1", seat: "s1", conversationId: "q1" });
    map.open({ threadTs: "T2", channel: "C1", human: "h1", seat: "s1", conversationId: "q2" });
    expect(map.resolveOpenForConversation("h1", "s1", "q1")?.threadTs).toBe("T1");
    expect(map.resolveOpenForConversation("h1", "s1", "q2")?.threadTs).toBe("T2");
    expect(map.resolveOpenForConversation("h1", "s1", "q3")).toBeNull();
  });

  it("从 queue-row 标记重建：丢失表可重新派生；格式错误标记明确跳过且可计数；存活行绝不覆盖", () => {
    const db = mapDb();
    const map = new ThreadSeatMap(db, clock);
    const stamp1 = formatPostedStamp({ threadTs: "T1", messageTs: "T1", channel: "C1", human: "h1", seat: "s1", conversationId: "q1" });
    const stamp2 = formatPostedStamp({ threadTs: "T2", messageTs: "T2", channel: "C1", human: "h2", seat: "s2", conversationId: "q2" });
    expect(parsePostedStamp(stamp1)).toMatchObject({ threadTs: "T1", seat: "s1" });
    // T2 已存在指向不同席位的存活行，重建不得覆盖。
    map.open({ threadTs: "T2", channel: "C1", human: "h2", seat: "s2-live", conversationId: "q2live" });
    const r = map.rebuildFromStamps([stamp1, stamp2, "unrelated transition note", "slack-posted malformed"]);
    expect(r.inserted).toBe(1); // T1
    expect(r.skipped).toBe(3); // T2 (live) + 2 non-stamps
    expect(map.resolveByThread("T1")!.seat).toBe("s1");
    expect(map.resolveByThread("T2")!.seat).toBe("s2-live"); // untouched
  });
});

describe("inbound 路由——四类情况，固定错误席位缺失", () => {
  function harness() {
    const map = new ThreadSeatMap(mapDb(), clock);
    map.open({ threadTs: "T-OPEN", channel: "C1", human: "mike@external", seat: "dev-driver@v-openrig-build", conversationId: "q-open" });
    map.open({ threadTs: "T-CLOSED", channel: "C1", human: "mike@external", seat: "review-r1@v-openrig-build", conversationId: "q-closed" });
    map.close("T-CLOSED");
    const creates: { destination: string; tags?: string[] }[] = [];
    const fs = memFs();
    const router = new InboundRouter({
      queue: { createQitem: async (i) => { creates.push({ destination: i.destination, tags: i.tags }); return `qitem-${creates.length}`; } },
      seen: new SeenStore("/s.jsonl", fs, clock),
      deadLetter: new DeadLetterStore<SlackEvent>("/d.jsonl", fs, clock),
      destination: "orch-lead@v-openrig-build",
      resolveSender: () => ({ admitted: true, source: "mike@external" }),
      resolveRoute: makeThreadRouteResolver({ map, unroutedDestination: "orch-lead@v-openrig-build" }),
    });
    return { router, creates };
  }
  const ev = (ts: string, thread_ts?: string): SlackEvent => ({ type: "message", user: "U1", text: "reply", ts, channel: "C1", ...(thread_ts ? { thread_ts } : {}) });

  it("已有 thread：回复只落到精确映射的席位，不落到其他席位", async () => {
    const { router, creates } = harness();
    await router.route(ev("1.1", "T-OPEN"));
    expect(creates).toHaveLength(1);
    expect(creates[0]!.destination).toBe("dev-driver@v-openrig-build");
    expect(creates[0]!.tags).toContain("thread");
    expect(creates[0]!.tags).toContain("reply-to:q-open");
    expect(creates[0]!.tags).not.toContain("unrouted-signal");
  });

  it("已关闭 thread：仍精确落到映射席位（关闭不会形成路由黑洞）", async () => {
    const { router, creates } = harness();
    await router.route(ev("2.1", "T-CLOSED"));
    expect(creates[0]!.destination).toBe("review-r1@v-openrig-build");
  });

  it("未映射 thread：写入 orchestrator unrouted-signal 行，绝不丢弃或猜测席位", async () => {
    const { router, creates } = harness();
    const r = await router.route(ev("3.1", "T-NEVER-SEEN"));
    expect(r.landed).toBe(true); // never dropped
    expect(creates[0]!.destination).toBe("orch-lead@v-openrig-build");
    expect(creates[0]!.tags).toContain("unrouted-signal");
    // 错误席位缺失：没有映射席位收到该消息。
    expect(creates[0]!.destination).not.toBe("dev-driver@v-openrig-build");
    expect(creates[0]!.destination).not.toBe("review-r1@v-openrig-build");
  });

  it("人工发起（无 thread_ts）：落地 unrouted-signal 行，绝不猜测", async () => {
    const { router, creates } = harness();
    const r = await router.route(ev("4.1"));
    expect(r.landed).toBe(true);
    expect(creates[0]!.destination).toBe("orch-lead@v-openrig-build");
    expect(creates[0]!.tags).toContain("unrouted-signal");
  });
});

describe("通过真实投递路径进行 outbound threading（每个持久 conversation 一个 reply root）", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "s10-thr-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  function capturing(rootTs: string): { fetchImpl: FetchImpl; bodies: Record<string, unknown>[] } {
    const bodies: Record<string, unknown>[] = [];
    return {
      bodies,
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true, ts: `${rootTs}.${bodies.length}` }), { status: 200, headers: { "content-type": "application/json" } });
      },
    };
  }

  it("同一 pair 的两个 qitem 获得不同 root；其中一个 qitem 的另一 episode 只复用自己的 root", async () => {
    const map = new ThreadSeatMap(mapDb(), clock);
    const fsx = memFs();
    const { fetchImpl, bodies } = capturing("1724");
    const stamps: string[] = [];
    const deliver = subsystemSlackDeliver({
      botToken: "xoxb-EXAMPLE-fake",
      channel: "C1",
      sourceLabel: "vm",
      fetchImpl,
      delivered: new SeenStore("/del.jsonl", fsx, clock),
      attempted: new SeenStore("/att.jsonl", fsx, clock),
      outboundSeen: new SeenStore("/seen.jsonl", fsx, clock),
      resolveThreadTs: (p) => map.resolveOpenForConversation(p.destinationSession ?? "", p.sourceSession ?? "", p.qitemId)?.threadTs,
      onPostedRoot: (p, ts) => {
        map.open({ threadTs: ts, channel: "C1", human: p.destinationSession ?? "", seat: p.sourceSession ?? "", conversationId: p.qitemId });
        stamps.push(formatPostedStamp({ threadTs: ts, messageTs: ts, channel: "C1", human: p.destinationSession ?? "", seat: p.sourceSession ?? "", conversationId: p.qitemId }));
      },
    });
    const wire = buildInProcessWire({ home, ops: [OUTBOUND_OP], deliver });
    const payload = (q: string) => ({ qitemId: q, summary: "s", body: "b", destinationSession: "mike@external", sourceSession: "dev-driver@v-openrig-build" });
    wire.dispatcher.dispatch(OUTBOUND_OP, "mike@external", payload("q1"));
    await flush();
    expect(bodies[0]!.thread_ts).toBeUndefined(); // class: NEW conversation — a fresh root
    expect(map.resolveByThread("1724.1")).not.toBeNull(); // mapped from the posted root's ts
    wire.dispatcher.dispatch(OUTBOUND_OP, "mike@external", payload("q2"));
    await flush();
    expect(bodies[1]!.thread_ts).toBeUndefined(); // q2 is a distinct reply-correlated gate
    expect(map.resolveByThread("1724.2")?.conversationId).toBe("q2");
    wire.dispatcher.dispatch(OUTBOUND_OP, "mike@external", { ...payload("q2"), notificationKey: "q2:episode-2" });
    await flush();
    expect(bodies[2]!.thread_ts).toBe("1724.2"); // same qitem, exact parent root
    // 两个持久 conversation 都有独立重建标记。
    expect(stamps).toHaveLength(2);
    expect(parsePostedStamp(stamps[0]!)).toMatchObject({ threadTs: "1724.1", conversationId: "q1" });
    expect(parsePostedStamp(stamps[1]!)).toMatchObject({ threadTs: "1724.2", conversationId: "q2" });
  });
});
