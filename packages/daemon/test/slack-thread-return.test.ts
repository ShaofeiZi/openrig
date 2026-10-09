// S10 LIVE ACCEPTANCE L2（founder root invariant 与 transition 10816/10817/10818 后的最终形态）：
// 在同一 instance 中，queue row source 是裸 member@rig，因此 Slack thread map 存储裸 seat，
// founder thread reply 会直接路由到 queue 接受的 canonical session。临时 self-host localizer 已随
// root stamping 删除；历史 triple map row 是 operator adoption 的一次性清理项。仅使用合成 fixture。
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { threadSeatMapSchema } from "../src/db/migrations/072_thread_seat_map.js";
import { ThreadSeatMap } from "../src/domain/gateway/slack/thread-seat-map.js";
import { makeThreadRouteResolver } from "../src/domain/gateway/slack/thread-routing.js";
import { InboundRouter, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";
import { SeenStore, DeadLetterStore, type StateFsOps } from "../src/domain/gateway/slack/state-store.js";

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
const clock = () => new Date("2026-08-27T05:00:00.000Z");

function mapDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db, [threadSeatMapSchema]);
  return db;
}

/** LIVE-MIRROR queue port：只接受 canonical 裸 member@rig destination，与 daemon topology
 *  validator 完全一致（triple 会被贪婪解析为未知 rig 并拒绝）。 */
function mirrorQueuePort() {
  const creates: { qitemId?: string; destination: string; tags?: string[] }[] = [];
  return {
    creates,
    createQitem: async (i: { qitemId?: string; destination: string; tags?: string[] }) => {
      if (i.destination.split("@").length !== 2) {
        throw new Error(`destination_session ${i.destination} references an unknown rig`);
      }
      creates.push({ qitemId: i.qitemId, destination: i.destination, tags: i.tags });
      return i.qitemId ?? `qitem-landed-${creates.length}`;
    },
  };
}

describe("L2 返回路径——裸 map seat 直接路由到 queue 接受的 session", () => {
  it("mapped thread 上的 founder reply 恰好成为一条发往裸 local seat 的持久 qitem（绝不进入 dead letter）", async () => {
    const map = new ThreadSeatMap(mapDb(), clock);
    // root invariant 后的事实：outbound row source 是裸值，因此 map 也存储裸值。
    map.open({ threadTs: "T-ROOT", channel: "C1", human: "human-founder@external", seat: "orch-lead@v-openrig-build", conversationId: "q-root" });
    const port = mirrorQueuePort();
    const fs = memFs();
    const dead = new DeadLetterStore<SlackEvent>("/d.jsonl", fs, clock);
    const resolutions: Array<{ qitemId: string; actorSession: string; decision: string }> = [];
    const router = new InboundRouter({
      queue: port,
      seen: new SeenStore("/s.jsonl", fs, clock),
      deadLetter: dead,
      destination: "orch-lead@v-openrig-build",
      resolveSender: () => ({ admitted: true, source: "human-founder@external" }),
      resolveRoute: makeThreadRouteResolver({ map, unroutedDestination: "orch-lead@v-openrig-build" }),
      resolveHumanReply: async (input) => { resolutions.push(input); return "resolved"; },
    });
    const r = await router.route({ type: "message", user: "U-FOUNDER", text: "reply received on mobile", ts: "200.2", thread_ts: "T-ROOT", channel: "C1" });
    await router.route({ type: "message", user: "U-FOUNDER", text: "reply received on mobile", ts: "200.2", thread_ts: "T-ROOT", channel: "C1" });
    expect(r.landed).toBe(true);
    expect(r.correlationQitemId).toBe("q-root");
    expect(r.replyResolution).toBe("resolved");
    expect(port.creates).toHaveLength(1);
    expect(port.creates[0]!.qitemId).toMatch(/^qitem-slack-inbound-/);
    expect(port.creates[0]!.destination).toBe("orch-lead@v-openrig-build");
    expect(port.creates[0]!.tags).toContain("thread");
    expect(port.creates[0]!.tags).toContain("reply-to:q-root");
    expect(resolutions).toEqual([{ qitemId: "q-root", actorSession: "human-founder@external", decision: "reply received on mobile" }]);
    expect(dead.readAll()).toHaveLength(0);
  });

  it("continuation 失败时重试确定性 inbound row，并恰好一次地解决原始 gate", async () => {
    const map = new ThreadSeatMap(mapDb(), clock);
    map.open({ threadTs: "T-ROOT", channel: "C1", human: "human-founder@external", seat: "orch-lead@v-openrig-build", conversationId: "q-root" });
    const fs = memFs();
    const dead = new DeadLetterStore<SlackEvent>("/d.jsonl", fs, clock);
    const seen = new SeenStore("/s.jsonl", fs, clock);
    const created = new Set<string>();
    let creates = 0;
    let resolves = 0;
    const router = new InboundRouter({
      queue: {
        createQitem: async (input) => {
          creates++;
          const id = input.qitemId!;
          created.add(id); // 镜像 QueueRepository 对相同 id re-delivery 的幂等行为
          return id;
        },
      },
      seen,
      deadLetter: dead,
      destination: "orch-lead@v-openrig-build",
      resolveSender: () => ({ admitted: true, source: "human-founder@external" }),
      resolveRoute: makeThreadRouteResolver({ map, unroutedDestination: "orch-lead@v-openrig-build" }),
      resolveHumanReply: async () => {
        resolves++;
        if (resolves === 1) throw new Error("temporary continuation failure");
        return "resolved";
      },
    });
    const event: SlackEvent = { type: "message", user: "U-FOUNDER", text: "approved", ts: "201.2", thread_ts: "T-ROOT", channel: "C1" };
    const first = await router.route(event);
    expect(first).toMatchObject({ landed: false, disposition: "dead-lettered", reason: "resolve_failed" });
    expect(dead.readAll()).toHaveLength(1);
    expect(seen.load().has("201.2")).toBe(false);

    expect(await router.retryDeadLetters()).toEqual({ retried: 1, landed: 1 });
    expect(created.size).toBe(1);
    expect(creates).toBe(2); // retry 到达幂等 create seam；不存在重复 row
    expect(resolves).toBe(2);
    expect(dead.readAll()).toHaveLength(0);
    expect(seen.load().has("201.2")).toBe(true);
  });
});
