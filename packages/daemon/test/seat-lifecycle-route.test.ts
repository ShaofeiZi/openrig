// S5（OPR.0.5.4.7）——三条 seat-lifecycle 路由：按 PRD 映射 HTTP 状态
//（400 required-input、404 not-found、409 state 冲突、502 tmux 层），
// 并透传 service 的命名拒绝（message + guidance + matches）。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";

describe("POST /api/seat/{set-model,stop,clean}/:seatRef", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  function seedSeat(logicalId = "dev.impl", model = "fable") {
    const rig = setup.rigRepo.findRigsByName("seat-rig")[0] ?? setup.rigRepo.createRig("seat-rig");
    const sessionName = `${logicalId.replace(".", "-")}@seat-rig`;
    const node = setup.rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code", model });
    const session = setup.sessionRegistry.registerSession(node.id, sessionName);
    setup.sessionRegistry.updateStatus(session.id, "running");
    setup.sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: sessionName, tmuxPane: "%1" });
    return { rig, node, session, sessionName };
  }

  function tmux() {
    const t = setup.tmuxAdapter as unknown as Record<string, ReturnType<typeof vi.fn>>;
    // Fix r1（行 9baac99f）：service 消费 CLASSIFIED probeSession。
    // 共享 test-app mock 早于它；从测试的 hasSession mock 派生正证据 probe
    //（present/absent——blip 类在 service 套件中针对真实 adapter 钉死，不在此）。
    if (!t.probeSession) {
      t.probeSession = vi.fn(async (name: string) =>
        (await t.hasSession(name)) ? { state: "present" } : { state: "absent" });
    }
    return t;
  }

  function post(path: string, seatRef: string, body: Record<string, unknown> = {}) {
    return setup.app.request(`/api/seat/${path}/${encodeURIComponent(seatRef)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("set-model 200：持久化，回显 from/to/changed", async () => {
    const { sessionName } = seedSeat();
    const res = await post("set-model", sessionName, { model: "claude-fable-5", reason: "alias migration", operator: "op@rig" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, from: "fable", to: "claude-fable-5", changed: true });
  });

  it("set-model 缺 model 返回 400；缺 reason 返回 400", async () => {
    const { sessionName } = seedSeat();
    const noModel = await post("set-model", sessionName, { reason: "x" });
    expect(noModel.status).toBe(400);
    expect((await noModel.json() as { code: string }).code).toBe("missing_model");
    const noReason = await post("set-model", sessionName, { model: "claude-fable-5" });
    expect(noReason.status).toBe(400);
    expect((await noReason.json() as { code: string }).code).toBe("missing_reason");
  });

  it("404 seat_not_found；409 seat_ambiguous 带 matches", async () => {
    seedSeat();
    const missing = await post("set-model", "ghost@seat-rig", { model: "m", reason: "x" });
    expect(missing.status).toBe(404);

    // 同一 logical id 在第二个 rig → 裸 ref 歧义。
    const rigB = setup.rigRepo.createRig("seat-rig-b");
    setup.rigRepo.addNode(rigB.id, "dev.impl", { runtime: "claude-code" });
    const ambiguous = await post("set-model", "dev.impl", { model: "m", reason: "x" });
    expect(ambiguous.status).toBe(409);
    const body = await ambiguous.json() as { code: string; matches: unknown[] };
    expect(body.code).toBe("seat_ambiguous");
    expect(body.matches.length).toBe(2);
  });

  it("stop 在 live seat 返回 200；在死 seat 返回 409 session_not_live；probe 失败返回 502", async () => {
    const { sessionName } = seedSeat();
    tmux().hasSession.mockResolvedValue(true);
    tmux().killSession.mockResolvedValue({ ok: true });
    const ok = await post("stop", sessionName, { reason: "wave boundary" });
    expect(ok.status).toBe(200);
    expect(tmux().killSession).toHaveBeenCalledWith(sessionName);

    const b = seedSeat("dev.other");
    tmux().hasSession.mockResolvedValue(false);
    const dead = await post("stop", b.sessionName, { reason: "x" });
    expect(dead.status).toBe(409);
    expect((await dead.json() as { code: string }).code).toBe("session_not_live");

    tmux().hasSession.mockRejectedValue(new Error("socket gone"));
    const probe = await post("stop", b.sessionName, { reason: "x" });
    expect(probe.status).toBe(502);
    expect((await probe.json() as { code: string }).code).toBe("tmux_probe_failed");
  });

  it("clean 在 live seat 返回 409 session_live；在死 seat 返回 200；重复调用返回 409 nothing_to_clean", async () => {
    const { sessionName } = seedSeat();
    tmux().hasSession.mockResolvedValue(true);
    const live = await post("clean", sessionName, { reason: "x" });
    expect(live.status).toBe(409);
    expect((await live.json() as { code: string }).code).toBe("session_live");

    tmux().hasSession.mockResolvedValue(false);
    const ok = await post("clean", sessionName, { reason: "clean exit observed" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, actions: { sessionsExited: [sessionName], bindingCleared: true } });

    const again = await post("clean", sessionName, { reason: "x" });
    expect(again.status).toBe(409);
    expect((await again.json() as { code: string }).code).toBe("nothing_to_clean");
  });

  it("launch 要求显式 fresh=true", async () => {
    const { sessionName } = seedSeat();
    const res = await post("launch", sessionName, { reason: "deliberate blank restart" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "fresh_required" });
  });

  it("launch 路由转发显式 fresh/stop/reason 契约并返回 service 结果", async () => {
    const launchFresh = vi.spyOn(SeatLifecycleService.prototype, "launchFresh").mockResolvedValue({
      ok: true,
      seat: { ref: "dev-impl@seat-rig", rigId: "rig-1", rigName: "seat-rig", logicalId: "dev.impl", podId: null, podNamespace: null, runtime: "codex" },
      status: "ready",
      sessionName: "dev-impl@seat-rig",
      sessionId: "sess-fresh",
      generation: "gen-fresh",
      model: "gpt-5.6-codex",
      startupPolicyHash: "policy-hash",
      supersededSessionIds: ["sess-old"],
    });

    const res = await post("launch", "dev-impl@seat-rig", {
      fresh: true,
      stop: true,
      reason: "deliberate blank restart",
      operator: "orch-lead@seat-rig",
    });

    expect(res.status).toBe(200);
    expect(launchFresh).toHaveBeenCalledWith({
      seatRef: "dev-impl@seat-rig",
      fresh: true,
      stop: true,
      reason: "deliberate blank restart",
      operator: "orch-lead@seat-rig",
    });
    expect(await res.json()).toMatchObject({ status: "ready", generation: "gen-fresh" });
  });
});
