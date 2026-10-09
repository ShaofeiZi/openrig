import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { RunnerCore, type RunnerIo } from "../src/adapters/pi-runner.js";
import { buildPiChildEnv } from "../src/adapters/pi-runner-protocol.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import type { EventBus } from "../src/domain/event-bus.js";
import { activityRoutes } from "../src/routes/activity.js";

// 真实 runner → 进程内 HTTP 路由 → 真实存储/读取门禁。仅注入持久化脚手架、tenure
// 查找和 runner 副作用；不启动后台服务或 Pi。
const SESSION = "worker@pi-test";
const NODE = "pi-node";
const GENERATION = "pi-current";
const NOW = new Date("2026-09-27T12:00:00Z");
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture(generation: string | null = GENERATION) {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE nodes (id TEXT, rig_id TEXT, runtime TEXT);
    CREATE TABLE sessions (id INTEGER, node_id TEXT, session_name TEXT);
    CREATE TABLE events (seq INTEGER PRIMARY KEY, node_id TEXT, type TEXT, payload TEXT);
    INSERT INTO nodes VALUES ('pi-node', 'rig', 'pi'), ('other-node', 'rig', 'pi');
    INSERT INTO sessions VALUES (1, 'pi-node', 'worker@pi-test'), (2, 'other-node', 'other@pi-test');
  `);
  let liveGeneration: string | null = GENERATION;
  const eventBus = { emit(event: { nodeId: string; type: string }) {
    db.prepare("INSERT INTO events (node_id, type, payload) VALUES (?, ?, ?)")
      .run(event.nodeId, event.type, JSON.stringify(event));
    return event;
  } } as unknown as EventBus;
  const store = new AgentActivityStore({ db, eventBus, now: () => NOW,
    resolveOccupantGeneration: node => node === NODE ? liveGeneration : "other-current",
    isRegisteredOccupantGeneration: (node, gen) => node === NODE
      ? [GENERATION, "pi-prior"].includes(gen) : gen === "other-current",
  });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    c.set("activityHookToken" as never, "fixture-token" as never);
    await next();
  });
  app.route("/api/activity", activityRoutes);
  const post = (payload: Record<string, unknown>) => app.request("/api/activity/hooks", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fixture-token" },
    body: JSON.stringify(payload),
  });
  const payloads: Record<string, unknown>[] = [];
  const pending: Promise<Response>[] = [];
  const io: RunnerIo = {
    sendRpc() {}, mirrorLine() {}, mirrorAppend() {}, writeSidecar() {}, now: () => NOW.toISOString(),
    postActivity(payload) {
      payloads.push(payload);
      if (!payload.eventFamily) pending.push(post(payload));
    },
  };
  const core = new RunnerCore(io, { sessionName: SESSION, nodeId: NODE, generation: generation ?? undefined, launchId: "launch-not-generation" });
  return { core, payloads, post, store,
    setLiveGeneration: (value: string | null) => { liveGeneration = value; },
    flush: () => Promise.all(pending.splice(0)),
    read: () => store.getLatestForNode({ nodeId: NODE, sessionName: SESSION }),
  };
}

describe("Pi 绑定占用者的活动（#29）", () => {
  it("每个 hook 都携带启动身份，并忽略 Pi 事件中的身份声明", async () => {
    const f = fixture();
    f.core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state",
      data: { sessionId: "native-id", sessionFile: "/fixture/session.jsonl", generation: "spoofed" } }));
    for (const type of ["agent_start", "tool_execution_start", "compaction_start", "auto_retry_start", "agent_end"]) {
      f.core.handlePiLine(JSON.stringify({ type, nodeId: "other-node", sessionName: "other@pi-test", generation: "other-current" }));
    }
    f.core.handlePiExit(0);
    const responses = await f.flush();
    expect(f.payloads).toHaveLength(7);
    for (const payload of f.payloads) expect(payload).toMatchObject({
      nodeId: NODE, sessionName: SESSION, runtime: "pi", generation: GENERATION,
    });
    expect(responses.every(r => r.status === 200)).toBe(true);
    expect(f.store.getLatestForNode({ nodeId: "other-node" })).toBeNull();
  });

  it("通过真实 HTTP/存储接缝投射当前运行中与空闲活动", async () => {
    const f = fixture();
    for (const [type, state] of [["agent_start", "running"], ["agent_end", "idle"]]) {
      f.core.handlePiLine(JSON.stringify({ type }));
      expect((await f.flush())[0].status).toBe(200);
      expect(f.read()).toMatchObject({ state, generation: GENERATION, generationProvenance: "resolved", stale: false });
    }
  });

  it.each([
    [null, "generation_unverifiable"],
    ["", "generation_unverifiable"],
    ["pi-prior", "generation_mismatch"],
    ["other-current", "generation_unresolvable"],
  ])("never presents generation %s as the current occupant", async (generation, reason) => {
    const f = fixture(generation);
    f.core.handlePiLine(JSON.stringify({ type: "agent_start", generation: GENERATION }));
    await f.flush();
    expect(f.read()).toMatchObject({ state: "unknown", stale: true, reason });
  });

  it("续期后不重新标记旧 runner，也不虚构缺失的存活 tenure", async () => {
    const f = fixture();
    f.core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    await f.flush();
    expect(f.read()).toMatchObject({ state: "running", generation: GENERATION });
    f.setLiveGeneration("pi-next");
    f.core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    await f.flush();
    expect(f.read()).toMatchObject({ reason: "generation_mismatch", generation: GENERATION });
    f.setLiveGeneration(null);
    expect(f.read()).toMatchObject({ state: "unknown", reason: "generation_unresolvable" });
    const response = await f.post({ runtime: "pi", nodeId: "missing", sessionName: "missing@pi-test", generation: GENERATION, hookEvent: "active" });
    expect(response.status).toBe(404);
  });

  it("保留已接受的子身份允许列表，但不转发 hook 凭证", () => {
    const env = buildPiChildEnv({ OPENRIG_SESSION_NAME: SESSION, OPENRIG_NODE_ID: NODE,
      OPENRIG_OCCUPANT_GENERATION: GENERATION, OPENRIG_ACTIVITY_HOOK_TOKEN: "fixture-only",
      OPENRIG_TERMINAL_BEARER_TOKEN: "fixture-only", OPENRIG_UNREVIEWED_SETTING: "exclude",
    }, { agentDir: "/fixture/agent", sessionsDir: "/fixture/sessions" });
    expect(env).toEqual({ OPENRIG_SESSION_NAME: SESSION, OPENRIG_NODE_ID: NODE,
      OPENRIG_OCCUPANT_GENERATION: GENERATION, PI_CODING_AGENT_DIR: "/fixture/agent", PI_CODING_AGENT_SESSION_DIR: "/fixture/sessions" });
    expect(buildPiChildEnv({}, { agentDir: "/a", sessionsDir: "/s" })).not.toHaveProperty("OPENRIG_OCCUPANT_GENERATION");
  });
});
