import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { discoverySchema } from "../src/db/migrations/012_discovery.js";
import { discoveryFkFix } from "../src/db/migrations/013_discovery_fk_fix.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { transportRoutes } from "../src/routes/transport.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { createFullTestDb } from "./helpers/test-app.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

function mockTmux(overrides?: Partial<{
  hasSession: (name: string) => Promise<boolean>;
  sendText: (target: string, text: string) => Promise<TmuxResult>;
  sendKeys: (target: string, keys: string[]) => Promise<TmuxResult>;
  capturePaneContent: (paneId: string, lines?: number) => Promise<string | null>;
  getPaneCommand: (paneId: string) => Promise<string | null>;
}>): TmuxAdapter {
  return {
    hasSession: overrides?.hasSession ?? (async () => true),
    probeSession: async (name: string) =>
      (await (overrides?.hasSession ?? (async () => true))(name))
        ? { state: "present" as const }
        : { state: "absent" as const },
    sendText: overrides?.sendText ?? (async () => ({ ok: true as const })),
    sendKeys: overrides?.sendKeys ?? (async () => ({ ok: true as const })),
    capturePaneContent: overrides?.capturePaneContent ?? (async () => "idle\n❯ "),
    createSession: async () => ({ ok: true as const }),
    killSession: async () => ({ ok: true as const }),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    startPipePane: async () => ({ ok: true as const }),
    stopPipePane: async () => ({ ok: true as const }),
    getPanePid: async () => null,
    getPaneCommand: overrides?.getPaneCommand ?? (async () => null),
  } as unknown as TmuxAdapter;
}

function createApp(deps: { sessionTransport: SessionTransport; outboxHandler?: OutboxHandler }): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionTransport" as never, deps.sessionTransport);
    if (deps.outboxHandler) c.set("outboxHandler" as never, deps.outboxHandler);
    await next();
  });
  app.route("/api/transport", transportRoutes());
  return app;
}

describe("transport 路由", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedRig() {
    const rig = rigRepo.createRig("my-rig");
    const node1 = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const sess1 = sessionRegistry.registerSession(node1.id, "dev-impl@my-rig");
    sessionRegistry.updateStatus(sess1.id, "running");
    sessionRegistry.updateBinding(node1.id, { tmuxSession: "dev-impl@my-rig" });

    const node2 = rigRepo.addNode(rig.id, "dev.qa", { role: "worker", runtime: "codex" });
    const sess2 = sessionRegistry.registerSession(node2.id, "dev-qa@my-rig");
    sessionRegistry.updateStatus(sess2.id, "running");
    sessionRegistry.updateBinding(node2.id, { tmuxSession: "dev-qa@my-rig" });
    return { rig, node1, node2 };
  }

  function seedExternalCliRig() {
    const rig = rigRepo.createRig("rigged-buildout");
    const node = rigRepo.addNode(rig.id, "orch1.lead", { role: "orchestrator", runtime: "claude-code" });
    const session = sessionRegistry.registerClaimedSession(node.id, "orch1-lead@rigged-buildout");
    sessionRegistry.updateBinding(node.id, {
      attachmentType: "external_cli",
      externalSessionName: "orch1-lead@rigged-buildout",
    });
    return { rig, node, session };
  }

  it("使用有效 session 调用 POST /send 时返回 200 和 SendResult", async () => {
    seedRig();
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hello" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sessionName).toBe("dev-impl@my-rig");
  });

  // ── A3（P22）——将已 dispatch 的 send 自动记录到发送方 outbox，避免 DERIVED send 在审计层
  //    接收后丢弃（specimen-5 窗口：没有 outbox 行，只能通过 provider JSONL 保留归属信息）。
  //    严格位于已认证 header 推导的下游（使用已经推导出的 actor，绝不重新推导）。──
  function outboxRows(): Array<Record<string, unknown>> {
    return db.prepare("SELECT * FROM outbox_entries ORDER BY rowid").all() as Array<Record<string, unknown>>;
  }
  function sendApp() {
    // createFullTestDb 排除 027（outbox 不在共享 core edge 上——P24）；在此处内联 migrate，
    // 并加上 067 identity_provenance 列（outbox 部分），使自动记录能够标记时代。
    migrate(db, [outboxEntriesSchema]);
    const hasProv = (db.prepare("PRAGMA table_info(outbox_entries)").all() as Array<{ name: string }>)
      .some((c) => c.name === "identity_provenance");
    if (!hasProv) db.exec("ALTER TABLE outbox_entries ADD COLUMN identity_provenance TEXT");
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: mockTmux() });
    return createApp({ sessionTransport: transport, outboxHandler: new OutboxHandler(db) });
  }

  it("A3——DERIVED send 自动记录恰好一条 outbox 行（sender=derived actor，provenance=transport:v1）", async () => {
    seedRig();
    const res = await sendApp().request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hello" }),
    });
    expect(res.status).toBe(200);
    const rows = outboxRows();
    expect(rows).toHaveLength(1); // 恰好一条，不是零条或两条
    expect(rows[0]!["sender_session"]).toBe("orch@my-rig"); // DERIVED actor，绝不是 body 声明
    expect(rows[0]!["destination_session"]).toBe("dev-impl@my-rig");
    expect(rows[0]!["body"]).toBe("hello");
    expect(rows[0]!["identity_provenance"]).toBe("transport:v1"); // 来自运行过程的时代标记，而非硬编码伪造
  });

  it("A3——跨 host send 记录 ORIGIN 三元组（推导出的 header），绝不记录 relay 席位", async () => {
    seedRig();
    const res = await sendApp().request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@rig-a@origin-host" }, // 三段式 origin（A2/A4 携带）
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "coordinate" }),
    });
    expect(res.status).toBe(200);
    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["sender_session"]).toBe("orch@rig-a@origin-host"); // ORIGIN 三元组，而非 relay
  });

  // 原为：“被拒绝的 send 不写入 outbox 行”。该拒绝类别已裁定删除（PM (A)，2026-08-11）——
  // 不一致的 body 声明会被取代而非拒绝——因此 send 现在会 DELIVER，记录行使用 wire identity。
  // 此固定测试的目的不变：body 声明绝不能进入 ledger。
  it("A3——body actor 不同时仍 DELIVERED，且 outbox 行携带 HEADER identity", async () => {
    seedRig();
    const res = await sendApp().request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hi", actorSession: "mallory@my-rig" }),
    });
    expect(res.status).toBe(200);
    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["sender_session"]).toBe("orch@my-rig");
    expect(rows[0]!["sender_session"]).not.toContain("mallory");
  });

  // 5.1 RELEASE BLOCKER（L5 leg A3，在路由层复现）：51-09 将 origin host 追加到 transport identity，
  // 因此 header 携带三元组，body 仍携带二元组。这两个值并不冲突——三元组只是为同一 actor 添加 origin——
  // 但字面字符串比较会将其视为不匹配，并在同一 SHA 上让首次真实跨 host send 返回 409。
  it("L5 A3——header 三元组 + body 二元组可投递，并记录 WIRE identity（而非 body 声明）", async () => {
    seedRig();
    const res = await sendApp().request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch-main@rig-a@host-a16b0df1" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "cross-host probe", actorSession: "orch-main@rig-a" }),
    });
    expect(res.status).toBe(200); // 原为 409 identity_mismatch——发布阻塞项
    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    // provenance 不变：由 WIRE 决定 actor，body 绝不参与。如果 body 二元组泄漏到记录的 sender，
    // 删除 guard 就是错误的。
    expect(rows[0]!["sender_session"]).toBe("orch-main@rig-a@host-a16b0df1");
    expect(rows[0]!["sender_session"]).not.toBe("orch-main@rig-a");
  });

  it("L5 A3——body 声明不同 actor 时被取代，绝不信任，也不拒绝", async () => {
    seedRig();
    const res = await sendApp().request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hi", actorSession: "mallory@my-rig" }),
    });
    expect(res.status).toBe(200);
    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["sender_session"]).toBe("orch@my-rig"); // 以 wire 为准
    expect(rows[0]!["sender_session"]).not.toContain("mallory"); // 丢弃 body，不作记录
  });

  it("A3——无 header 的 send（无 derived actor）不自动记录行（无从归属，也不虚构 sender）", async () => {
    seedRig();
    const res = await sendApp().request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // 没有 X-OpenRig-Session
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hi" }),
    });
    expect(res.status).toBe(200); // 可投递（非交互 send 容忍 null actor）
    expect(outboxRows()).toHaveLength(0); // 但没有 derived sender ⇒ 不自动记录，绝不产生 null-sender 行
  });

  // ── A3b（P22 后续，planner 裁定在范围内）——/broadcast fan-out 自动记录 N 行，每个已解析 recipient 一行
  //    （schema 中带类型和索引的 destination_session + 每行 delivery_state 采用逐 recipient 设计；
  //    TargetSpec 会污染类型化列）。与 /send 一样，严格位于推导逻辑下游。──
  it("A3b——broadcast 自动记录 N 行，每个已解析 recipient 一行（sender=derived、provenance=transport:v1、destination=各 session，绝非 TargetSpec）", async () => {
    seedRig();
    const res = await sendApp().request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" },
      body: JSON.stringify({ rig: "my-rig", text: "team update" }),
    });
    expect(res.status).toBe(200);
    const rows = outboxRows();
    expect(rows).toHaveLength(2); // 每个已解析 recipient 一行，不是一条 broadcast 行
    expect(rows.map((r) => r["destination_session"]).sort()).toEqual(["dev-impl@my-rig", "dev-qa@my-rig"]);
    for (const r of rows) {
      expect(r["sender_session"]).toBe("orch@my-rig"); // 每行均为 DERIVED actor
      expect(r["identity_provenance"]).toBe("transport:v1");
      expect(String(r["destination_session"])).not.toContain("rig:"); // 已解析 session，绝非 TargetSpec
      expect(r["delivery_state"]).toBe("delivered"); // 全部送达（mockTmux）⇒ 逐行状态
    }
  });

  it("A3b——PARTIAL fan-out 逐行记录 delivery_state（delivered 与 failed）——单行无法表达的真实情况", async () => {
    seedRig();
    const transport = new SessionTransport({
      db, rigRepo, sessionRegistry,
      // dev-qa 的 pane 缺失 ⇒ 发送失败；dev-impl 成功送达。形成 partial fan-out。
      tmuxAdapter: mockTmux({ hasSession: async (name: string) => name !== "dev-qa@my-rig" }),
    });
    migrate(db, [outboxEntriesSchema]);
    if (!(db.prepare("PRAGMA table_info(outbox_entries)").all() as Array<{ name: string }>).some((c) => c.name === "identity_provenance")) {
      db.exec("ALTER TABLE outbox_entries ADD COLUMN identity_provenance TEXT");
    }
    const app = createApp({ sessionTransport: transport, outboxHandler: new OutboxHandler(db) });
    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" },
      body: JSON.stringify({ rig: "my-rig", text: "team update" }),
    });
    expect(res.status).toBe(200);
    const byDest = Object.fromEntries(outboxRows().map((r) => [r["destination_session"], r["delivery_state"]]));
    expect(byDest["dev-impl@my-rig"]).toBe("delivered");
    expect(byDest["dev-qa@my-rig"]).toBe("failed"); // 逐 recipient 的真实情况，而非有损聚合
  });

  // fan-out 路径上的相同转换（第二个已删除 guard，transport.ts:223）。
  it("A3b——body actor 不同的 broadcast 仍 DELIVERED，且每行都携带 HEADER identity", async () => {
    seedRig();
    const res = await sendApp().request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" },
      body: JSON.stringify({ rig: "my-rig", text: "hi", actorSession: "mallory@my-rig" }),
    });
    expect(res.status).toBe(200);
    const rows = outboxRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row["sender_session"]).toBe("orch@my-rig");
      expect(row["sender_session"]).not.toContain("mallory");
    }
  });

  it("A3b——无 header 的 broadcast 不自动记录行（没有可归属的 derived sender）", async () => {
    seedRig();
    const res = await sendApp().request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rig: "my-rig", text: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(outboxRows()).toHaveLength(0);
  });

  // OPR.99.0.6.3——增量 outcome 字段通过 c.json(result) 透传自动呈现；失败 HTTP 映射不变。
  it("带 verify 的 POST /send 在 JSON 响应中呈现 outcome 字段（透传）", async () => {
    seedRig();
    // 预先存在的 pane 内容意味着 post-capture 无法重新确认：这是 redraw-race 的中间结果。
    const tmux = {
      ...mockTmux(),
      capturePaneContent: async () => "idle\nhello\n❯ ",
    } as unknown as TmuxAdapter;
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hello", verify: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.verified).toBe(false);
    expect(body.outcome).toBe("rendered-unconfirmed");
  });

  it("POST /send verify 失败与中间结果保持不同 HTTP 错误（判别测试）", async () => {
    seedRig();
    const tmux = {
      ...mockTmux(),
      sendKeys: async () => ({ ok: false as const, code: "session_not_found", message: "session died" }),
    } as unknown as TmuxAdapter;
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hello", verify: true }),
    });
    // submit_failed 映射为 502（不变）；上面的中间结果为 200。
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("submit_failed");
    expect(body.outcome).toBe("failed");
  });

  it("向 mid-work pane 调用 POST /send 时返回 200 并 DELIVER，同时给出非阻塞提示（OPR.0.4.3.28 fast-follow——mid_work 已降级）", async () => {
    seedRig();
    const tmux = {
      ...mockTmux(),
      capturePaneContent: async () => "Working on task...\n⠋ Processing\nesc to interrupt",
    } as unknown as TmuxAdapter;
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hello" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.warning).toContain("正在任务中");
  });

  // OPR.0.4.1.10——prompt/permission guard 通过路由呈现为 409 target_needs_input。
  it("向交互式 prompt 调用 POST /send 时返回 409 target_needs_input（默认，无 override）", async () => {
    seedRig();
    const tmux = { ...mockTmux(), capturePaneContent: async () => "❯ 1. Authorize\n  2. Hold" } as unknown as TmuxAdapter;
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });
    const res = await app.request("/api/transport/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "stand down" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("target_needs_input");
  });

  // OPR.0.4.1.10——路由在 transport 前拒绝矛盾或不可审计的 override 请求。
  it("POST /send 以 400 拒绝 --dangerously-interact + --wait-for-idle", async () => {
    seedRig();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: mockTmux() });
    const app = createApp({ sessionTransport: transport });
    const res = await app.request("/api/transport/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "x", dangerouslyInteract: true, reason: "y", waitForIdleMs: 1000 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("invalid_dangerously_interact");
  });

  it("POST /send 以 400 拒绝不带 reason 的 --dangerously-interact", async () => {
    seedRig();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: mockTmux() });
    const app = createApp({ sessionTransport: transport });
    const res = await app.request("/api/transport/send", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "x", dangerouslyInteract: true }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("dangerously_interact_requires_reason");
  });

  it("带 waitForIdleMs 的 POST /send 等待 idle 并返回 activity 证据", async () => {
    seedRig();
    let captureCount = 0;
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => {
        captureCount++;
        return captureCount === 1
          ? "Working on task...\n⠋ Processing\nesc to interrupt"
          : "› Use /skills to list available skills\n\n  gpt-5.5 high · Context [████ ] · ~/code/projects/openrig";
      },
      sendText: sendTextSpy,
    });
    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: tmux,
      sleep: async () => undefined,
      waitForIdlePollMs: 1,
    });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hello", waitForIdleMs: 50 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sent).toBe(true);
    expect(body.attempts).toBe(2);
    expect(body.activity.state).toBe("idle");
    expect(sendTextSpy).toHaveBeenCalledWith("dev-impl@my-rig", "hello");
  });

  it("POST /send 在发送前拒绝同时使用 force 和 waitForIdleMs", async () => {
    seedRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: mockTmux({ sendText: sendTextSpy }),
    });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hello", force: true, waitForIdleMs: 50 }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe("invalid_wait_for_idle");
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("POST /send 将等待超时映射为 409，且不发送文本", async () => {
    seedRig();
    const sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    const tmux = mockTmux({
      capturePaneContent: async () => "Working on task...\n⠋ Processing\nesc to interrupt",
      sendText: sendTextSpy,
    });
    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: tmux,
      waitForIdlePollMs: 1,
    });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "hello", waitForIdleMs: 1 }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("wait_for_idle_timeout");
    expect(body.sent).toBe(false);
    expect(sendTextSpy).not.toHaveBeenCalled();
  });

  it("使用有歧义 session 调用 POST /send 时返回 409", async () => {
    // 创建两个具有相同 canonical session name 的 rig
    const rig1 = rigRepo.createRig("rig-a");
    const node1 = rigRepo.addNode(rig1.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node1.id, "dev-impl@shared");

    const rig2 = rigRepo.createRig("rig-b");
    const node2 = rigRepo.addNode(rig2.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node2.id, "dev-impl@shared");

    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@shared", text: "hello" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("有歧义");
  });

  it("向 external_cli 目标调用 POST /send 时返回 409 和如实的 transport 指引", async () => {
    seedExternalCliRig();
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "orch1-lead@rigged-buildout", text: "hello" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("transport_unavailable");
    expect(body.error).toContain("external CLI");
  });

  it("按 rig 定位的 POST /capture 返回多 session 结果", async () => {
    seedRig();
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rig: "my-rig" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toBeDefined();
    expect(body.results.length).toBe(2);
    expect(body.results.every((r: { ok: boolean }) => r.ok)).toBe(true);
  });

  it("按 rig 定位的 POST /capture 将 external_cli 目标列为显式失败", async () => {
    seedRig();
    seedExternalCliRig();
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rig: "rigged-buildout" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.ok).toBe(false);
    expect(body.results[0]!.reason).toBe("transport_unavailable");
  });

  it("针对 external_cli 目标的 POST /capture 返回 409 和如实的 transport 指引", async () => {
    seedExternalCliRig();
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "orch1-lead@rigged-buildout" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("transport_unavailable");
    expect(body.error).toContain("external CLI");
  });

  it("不带 rig/pod 的 POST /broadcast 向所有运行中 session 全局广播", async () => {
    seedRig(); // 创建含 dev-impl@my-rig 和 dev-qa@my-rig 的 my-rig
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "global message", force: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.sent).toBe(2);
  });

  it("部分失败的 POST /broadcast 返回如实的逐目标结果", async () => {
    seedRig();
    let callCount = 0;
    const tmux = {
      ...mockTmux(),
      hasSession: async () => true,
      sendText: async () => {
        callCount++;
        // 第二次 send 失败
        if (callCount > 1) return { ok: false as const, code: "err", message: "failed" };
        return { ok: true as const };
      },
      capturePaneContent: async () => "idle\n❯ ",
    } as unknown as TmuxAdapter;
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rig: "my-rig", text: "broadcast message", force: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.sent).toBe(1);
    expect(body.failed).toBe(1);
  });

  // OPR.0.4.3.30——`zrig send` 通过 /broadcast fan-out：显式列表目标 + 逐 recipient envelope。
  // 契约变更（裁定 03c35295，审查可见）：`sessions` 多目标 send 现在会在每个 recipient 的 To 行呈现
  // 完整 recipient 列表——这是防风暴行为（每个 recipient 都知道还有谁收到，从而不会再次转发给已收到的 peer）。
  // 它取代了先前逐 recipient 隔离的 To（B1）；包装仍按 recipient 生成（各自的 From + reply 提示），
  // 只有 To 投影从 <该席位> 改为 <完整列表>。
  it("带 sessions 列表的 POST /broadcast 在每个 To 中呈现完整 recipient 列表（防风暴，B1）", async () => {
    seedRig(); // dev-impl@my-rig + dev-qa@my-rig
    const delivered: string[] = [];
    const tmux = mockTmux({ sendText: async (_target: string, text: string) => { delivered.push(text); return { ok: true as const }; } });
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" }, // P21：From: 来自 header
      body: JSON.stringify({
        sessions: ["dev-impl@my-rig", "dev-qa@my-rig"],
        text: "hello team",
        force: true,
        envelopeSender: "orch@my-rig",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.sent).toBe(2);
    expect(delivered).toHaveLength(2);
    // 两个 recipient 都得到相同的完整列表 To（说明谁已收到）——这是防风暴机制的关键。
    for (const text of delivered) {
      expect(text).toContain("To: dev-impl@my-rig, dev-qa@my-rig");
      expect(text).toContain("From: orch@my-rig"); // 仍按 recipient 包装（各自的 From + reply）
      expect(text).toContain("---\nhello team\n---");
    }
  });

  it("不带 envelopeSender 的 POST /broadcast 向所有目标投递原始文本（rig broadcast 不变）", async () => {
    seedRig();
    const delivered: string[] = [];
    const tmux = mockTmux({ sendText: async (_target: string, text: string) => { delivered.push(text); return { ok: true as const }; } });
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rig: "my-rig", text: "raw msg", force: true }),
    });
    expect(res.status).toBe(200);
    expect(delivered).toHaveLength(2);
    expect(delivered.every((t) => t === "raw msg")).toBe(true);
    expect(delivered.some((t) => t.includes("To:"))).toBe(false);
  });

  it("POST /broadcast 列表包含未知席位时如实拒绝并指明该席位", async () => {
    seedRig();
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessions: ["dev-impl@my-rig", "ghost@my-rig"], text: "x", force: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(0);
    expect(body.results[0].error).toContain("ghost@my-rig");
  });

  it("POST /broadcast 列表：一个 recipient 失败不会中止其他 recipient（独立性）", async () => {
    seedRig();
    let n = 0;
    const tmux = mockTmux({
      sendText: async () => { n++; return n > 1 ? { ok: false as const, code: "e", message: "boom" } : { ok: true as const }; },
    });
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" }, // P21：From: 来自 header
      body: JSON.stringify({ sessions: ["dev-impl@my-rig", "dev-qa@my-rig"], text: "x", force: true, envelopeSender: "orch@my-rig" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.sent).toBe(1);
    expect(body.failed).toBe(1);
  });

  it("POST /broadcast 列表为 unknown telemetry 和 picker 拒绝保留逐 recipient send guard 语义", async () => {
    seedRig();
    const delivered: string[] = [];
    const tmux = mockTmux({
      capturePaneContent: async (target: string) => {
        if (target === "dev-impl@my-rig") {
          return "OpenRig pane capture failed before activity could be classified";
        }
        return [
          "Would you like to run the following command?",
          "❯ 1. Yes, continue",
          "  2. No, cancel",
          "Enter to select · Esc to cancel",
        ].join("\n");
      },
      sendText: async (target: string, text: string) => {
        delivered.push(`${target}:${text}`);
        return { ok: true as const };
      },
    });
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" }, // P21：From: 来自 header
      body: JSON.stringify({
        sessions: ["dev-impl@my-rig", "dev-qa@my-rig"],
        text: "union seam",
        envelopeSender: "orch@my-rig",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.sent).toBe(1);
    expect(body.failed).toBe(1);

    const impl = body.results.find((r: { sessionName: string }) => r.sessionName === "dev-impl@my-rig");
    const qa = body.results.find((r: { sessionName: string }) => r.sessionName === "dev-qa@my-rig");
    expect(impl).toMatchObject({ ok: true, sessionName: "dev-impl@my-rig" });
    expect(impl.warning).toContain("producer-link：");
    expect(impl.warning).toContain("仍已发送（遥测仅作提示）");
    expect(qa).toMatchObject({ ok: false, sessionName: "dev-qa@my-rig", reason: "target_needs_input" });
    expect(qa.error).toContain("--dangerously-interact --reason");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("dev-impl@my-rig:");
    expect(delivered[0]).toContain("To: dev-impl@my-rig");
  });

  it("POST /broadcast 将 danger/reason/actorSession 传递给每个 recipient send（逐席位，而非逐 batch）", async () => {
    seedRig();
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const sendSpy = vi.spyOn(transport, "send");
    const app = createApp({ sessionTransport: transport });

    await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" }, // P21：From: 来自 header
      body: JSON.stringify({
        sessions: ["dev-impl@my-rig", "dev-qa@my-rig"],
        text: "unblock please",
        dangerouslyInteract: true,
        reason: "drive the stuck prompt",
        actorSession: "orch@my-rig",
      }),
    });
    expect(sendSpy).toHaveBeenCalledTimes(2);
    for (const call of sendSpy.mock.calls) {
      expect(call[2]).toMatchObject({
        dangerouslyInteract: true,
        reason: "drive the stuck prompt",
        actorSession: "orch@my-rig",
      });
    }
  });

  it("POST /broadcast 将 external_cli 目标列为显式 transport_unavailable 失败", async () => {
    seedExternalCliRig();
    const tmux = mockTmux();
    const transport = new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux });
    const app = createApp({ sessionTransport: transport });

    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rig: "rigged-buildout", text: "broadcast message", force: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.sent).toBe(0);
    expect(body.failed).toBe(1);
    expect(body.results[0]!.reason).toBe("transport_unavailable");
  });

  // ── P21 I4：呈现的 From: 和 override 审计 actor 来自 transport，绝不来自 body ──
  it("P21 I4：From: 行来自 transport header，忽略伪造的 body.envelopeSender（终结 specimen-5）", async () => {
    seedRig();
    const delivered: string[] = [];
    const tmux = mockTmux({ sendText: async (_t: string, text: string) => { delivered.push(text); return { ok: true as const }; } });
    const app = createApp({ sessionTransport: new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux }) });
    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" }, // 真实 sender
      body: JSON.stringify({ sessions: ["dev-impl@my-rig"], text: "hi", force: true, envelopeSender: "pm-lead@my-rig" }), // 伪造 From:
    });
    expect(res.status).toBe(200);
    for (const text of delivered) {
      expect(text).toContain("From: orch@my-rig"); // transport identity，而非伪造的 pm-lead 声明
      expect(text).not.toContain("From: pm-lead@my-rig"); // 事故所针对的虚假 From: 绝不呈现
    }
  });

  it("P21 I4 → S2：没有已认证 identity 的 enveloped send 以 unknown 身份 DELIVER（仍不呈现未经验证的 From:）", async () => {
    seedRig();
    const delivered: string[] = [];
    const tmux = mockTmux({
      sendText: async (_t: string, text: string) => { delivered.push(text); return { ok: true as const }; },
    });
    const app = createApp({ sessionTransport: new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: tmux }) });
    const res = await app.request("/api/transport/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // 没有 X-OpenRig-Session
      body: JSON.stringify({ sessions: ["dev-impl@my-rig"], text: "hi", force: true, envelopeSender: "anyone@my-rig" }),
    });
    // S2（OPR.0.5.4.3，founder 缩减范围）：delivery 取代拒绝；specimen-5 不变量保持不变——
    // body 声明绝不呈现。
    expect(res.status).toBe(200);
    expect(delivered.some((t) => t.includes("From: <unknown sender>"))).toBe(true);
    expect(delivered.every((t) => !t.includes("anyone@my-rig"))).toBe(true);
  });

  it("P21 I4 → S2：无 identity 的 --dangerously-interact 可投递；非 needs_input 目标不写 override 审计行", async () => {
    seedRig();
    const eventBus = new EventBus(db);
    const app = createApp({ sessionTransport: new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: mockTmux(), eventBus, agentActivityStore: new AgentActivityStore({ db, eventBus }) }) });
    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // 没有 X-OpenRig-Session
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "drive it", dangerouslyInteract: true, reason: "why" }),
    });
    // S2（OPR.0.5.4.3）：401 已废弃。idle 目标采用普通 send 路径；override 审计只存在于
    // needs_input 分支，因此此处不写入行——姿态不变，现在可容忍未归属请求。
    expect(res.status).toBe(200);
    const rows = db.prepare("SELECT * FROM events WHERE type = 'transport.prompt_override'").all();
    expect(rows).toHaveLength(0);
  });

  it("P21 I4：与 header 不同的 body actorSession 会被取代（不以 identity_mismatch 拒绝）", async () => {
    seedRig();
    const app = createApp({ sessionTransport: new SessionTransport({ db, rigRepo, sessionRegistry, tmuxAdapter: mockTmux() }) });
    const res = await app.request("/api/transport/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" },
      body: JSON.stringify({ session: "dev-impl@my-rig", text: "x", actorSession: "mallory@my-rig" }),
    });
    expect(res.status).toBe(200);
    // 此路径已完全移除该拒绝——而不只是改为不同 status
    expect(JSON.stringify(await res.json())).not.toContain("identity_mismatch");
  });

  // ── S2（OPR.0.5.4.3）——unknown-sender 如实性：三种归属拒绝改为如实投递
  //（enveloped 呈现 From: unknown；override 审计记录 null actor；raw send 保持字节原样），
  // 且面向 sender 的响应携带签名提示。
  describe("S2——unknown-sender 如实性（OPR.0.5.4.3）", () => {
    const HOSTILE_CLAIM = "pm-lead@evil-rig";
    const PICKER_PROMPT = [
      "Authorize the 0.4.0 release?",
      "",
      "❯ 1. Authorize publish → @latest (Recommended)",
      "  2. Roll back",
      "  3. Hold",
    ].join("\n");

    function spyTransportApp(opts?: { paneContent?: string }) {
      const sentTexts: Array<{ target: string; text: string }> = [];
      const eventBus = new EventBus(db);
      const agentActivityStore = new AgentActivityStore({ db, eventBus });
      const tmux = mockTmux({
        sendText: async (target: string, text: string) => {
          sentTexts.push({ target, text });
          return { ok: true as const };
        },
        capturePaneContent: async () => opts?.paneContent ?? "idle\n❯ ",
        getPaneCommand: async () => "claude",
      });
      const transport = new SessionTransport({
        db, rigRepo, sessionRegistry, tmuxAdapter: tmux, eventBus, agentActivityStore,
      });
      return { app: createApp({ sessionTransport: transport }), sentTexts };
    }

    const overrideAuditRows = () =>
      (db.prepare("SELECT payload FROM events WHERE type = 'transport.prompt_override'").all() as Array<{ payload: string }>)
        .map((r) => JSON.parse(r.payload) as Record<string, unknown>);

    it("PROOF-1：无 header 的 enveloped broadcast 可 DELIVER，From: 为 unknown 标记，危险 body 声明绝不呈现，payload 含提示", async () => {
      seedRig();
      const { app, sentTexts } = spyTransportApp();
      const res = await app.request("/api/transport/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessions: ["dev-impl@my-rig", "dev-qa@my-rig"], text: "hello team", envelopeSender: HOSTILE_CLAIM }),
      });
      expect(res.status).toBe(200); // 修复前字节下为 RED：401 unattributable_sender
      const data = (await res.json()) as Record<string, unknown>;
      expect(data["sent"]).toBe(2);
      expect(sentTexts).toHaveLength(2);
      for (const s of sentTexts) {
        expect(s.text).toContain("From: <unknown sender>");
        expect(s.text).not.toContain(HOSTILE_CLAIM); // specimen-5 固定测试：body 声明绝不呈现
      }
      expect(String(data["warning"])).toContain("接收方无法知道是谁发的");
      expect(String(data["warning"])).toContain("签名");
    });

    it("PROOF-2：无 header 的 send --dangerously-interact 可在 STAGED needs_input prompt 上继续；审计行携带 actorSession NULL", async () => {
      seedRig();
      const { app } = spyTransportApp({ paneContent: PICKER_PROMPT });
      // override 前的正向 staged-prompt 证据：默认 guard 会自行检测 pending picker 并拒绝。
      const guard = await app.request("/api/transport/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: "dev-impl@my-rig", text: "hi" }),
      });
      expect(guard.status).toBe(409);
      expect(((await guard.json()) as Record<string, unknown>)["reason"]).toBe("target_needs_input");

      const res = await app.request("/api/transport/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: "dev-impl@my-rig", text: "1", dangerouslyInteract: true, reason: "S2 proof: drive the staged test prompt" }),
      });
      expect(res.status).toBe(200); // 修复前字节下为 RED：401 unattributable_sender
      const rows = overrideAuditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!["actorSession"]).toBeNull();
      expect(String(((await res.json()) as Record<string, unknown>)["warning"] ?? "")).toContain("签名");
    });

    it("PROOF-2b：无 header 的 broadcast --dangerously-interact 可继续；逐席位审计 actorSession 为 NULL", async () => {
      seedRig();
      const { app } = spyTransportApp({ paneContent: PICKER_PROMPT });
      const res = await app.request("/api/transport/broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessions: ["dev-impl@my-rig"], text: "1", dangerouslyInteract: true, reason: "S2 proof: drive the staged test prompt" }),
      });
      expect(res.status).toBe(200); // 修复前字节下为 RED：401 unattributable_sender
      const rows = overrideAuditRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!["actorSession"]).toBeNull();
    });

    it("PROOF-4a：普通未归属 send 按原字节投递（无 recipient 侧标记），并附响应提示", async () => {
      seedRig();
      const { app, sentTexts } = spyTransportApp();
      const res = await app.request("/api/transport/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: "dev-impl@my-rig", text: "exact bytes ✓ --- é" }),
      });
      expect(res.status).toBe(200);
      expect(sentTexts[0]!.text).toBe("exact bytes ✓ --- é"); // raw send 是按键输入，绝非邮件
      const data = (await res.json()) as Record<string, unknown>;
      expect(String(data["warning"] ?? "")).toContain("签名"); // 修复前字节下为 RED：无提示
      expect(String(data["warning"] ?? "")).toContain("接收方无法知道是谁发的");
    });

    it("PROOF-4b：已归属 send 的响应不带提醒，并原样投递", async () => {
      seedRig();
      const { app, sentTexts } = spyTransportApp();
      const res = await app.request("/api/transport/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "orch@my-rig" },
        body: JSON.stringify({ session: "dev-impl@my-rig", text: "hello" }),
      });
      expect(res.status).toBe(200);
      expect(sentTexts[0]!.text).toBe("hello");
      const data = (await res.json()) as Record<string, unknown>;
      expect(data["warning"]).toBeUndefined();
    });
  });
});
