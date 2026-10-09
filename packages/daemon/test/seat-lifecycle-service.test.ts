// S5（OPR.0.5.4.5）——席位生命周期动词接口：set-model / stop / clean。针对三个
// KI-5.3-9 缺口的先红后绿固定项。缺口 3 缺陷（已终止的托管席位永久为
// `already_bound`）在 P5 固定项中针对真实 NodeLauncher 演示，因此已提交的 RED 模拟
// 运行时关系，而非作者想象的 fixture。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { TmuxAdapter, type TmuxResult } from "../src/adapters/tmux.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";

interface FakeTmux {
  adapter: TmuxAdapter;
  killed: string[];
  setAlive(name: string, alive: boolean): void;
  failProbeFor(name: string): void;
}

function fakeTmux(): FakeTmux {
  const alive = new Map<string, boolean>();
  const failing = new Set<string>();
  const killed: string[] = [];
  const adapter = {
    createSession: async () => ({ ok: true as const }),
    killSession: async (name: string): Promise<TmuxResult> => {
      killed.push(name);
      alive.set(name, false);
      return { ok: true as const };
    },
    hasSession: async (name: string): Promise<boolean> => {
      if (failing.has(name)) throw new Error("tmux probe failed (injected)");
      return alive.get(name) ?? false;
    },
    // 分类探针（OPR.0.5.4.2）：此 fake 只模拟确证——在存活映射中存在/缺失，以及注入失败
    // 集合中的意外抛出（服务必须失败关闭）。此处有意无法表示 transport_unavailable 类；
    // 抖动行为在下方针对真实适配器固定（修复 r1，第 9baac99f 行）。
    probeSession: async (name: string): Promise<{ state: "present" } | { state: "absent" }> => {
      if (failing.has(name)) throw new Error("tmux probe failed (injected)");
      return (alive.get(name) ?? false) ? { state: "present" } : { state: "absent" };
    },
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    sendText: async () => ({ ok: true as const }),
    sendKeys: async () => ({ ok: true as const }),
    setSessionOption: async () => undefined,
  } as unknown as TmuxAdapter;
  return {
    adapter,
    killed,
    setAlive: (name, isAlive) => alive.set(name, isAlive),
    failProbeFor: (name) => failing.add(name),
  };
}

/** 字节级血缘快照：clean/set-model 动词绝不能触碰的全部内容。 */
function lineageSnapshot(db: Database.Database, nodeId: string) {
  return {
    sessionRows: db.prepare(
      "SELECT id, session_name, resume_token, resume_type FROM sessions WHERE node_id = ? ORDER BY id",
    ).all(nodeId),
    tenureCount: (db.prepare(
      "SELECT COUNT(*) AS c FROM occupant_tenures WHERE node_id = ?",
    ).get(nodeId) as { c: number }).c,
    nodeRow: db.prepare("SELECT id, logical_id, model FROM nodes WHERE id = ?").get(nodeId),
  };
}

function eventsOfType(db: Database.Database, type: string): Array<Record<string, unknown>> {
  const rows = db.prepare("SELECT payload FROM events WHERE type = ? ORDER BY seq").all(type) as Array<{ payload: string }>;
  return rows.map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

describe("SeatLifecycleService", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let tmux: FakeTmux;
  let service: SeatLifecycleService;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    tmux = fakeTmux();
    service = new SeatLifecycleService({
      db,
      rigRepo,
      sessionRegistry,
      eventBus,
      tmuxAdapter: tmux.adapter,
    });
  });

  afterEach(() => {
    db.close();
  });

  /** 一个存活托管席位：节点 + 运行中会话 + 绑定 + 存活 tmux。 */
  function seatFixture(rigName: string, logicalId: string, opts?: { model?: string; origin?: "claimed" }) {
    const existing = rigRepo.findRigsByName(rigName)[0] ?? rigRepo.createRig(rigName);
    const sessionName = `${logicalId.replace(".", "-")}@${rigName}`;
    const node = rigRepo.addNode(existing.id, logicalId, {
      runtime: "claude-code",
      cwd: "/project",
      model: opts?.model ?? "fable",
    });
    const session = opts?.origin === "claimed"
      ? sessionRegistry.registerClaimedSession(node.id, sessionName)
      : sessionRegistry.registerSession(node.id, sessionName);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateResumeToken(session.id, "claude_session_id", "resume-uuid-1234", "hook");
    sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: sessionName, tmuxPane: "%1" });
    tmux.setAlive(sessionName, true);
    return { rig: existing, node, session, sessionName };
  }

  // ---- P1 / P2——set-model ----

  it("P1：set-model 持久化 nodes.model，并发出一个已审计 node.model_changed 事件", async () => {
    const { rig, node, sessionName } = seatFixture("s5-rig", "dev.impl", { model: "fable" });

    const result = await service.setModel({
      seatRef: sessionName,
      model: "claude-fable-5",
      reason: "alias migration to canonical id",
      operator: "orch-lead@s5-rig",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.from).toBe("fable");
    expect(result.to).toBe("claude-fable-5");
    expect(result.changed).toBe(true);

    const persisted = rigRepo.getRig(rig.id)!.nodes.find((n) => n.id === node.id)!;
    expect(persisted.model).toBe("claude-fable-5");

    const events = eventsOfType(db, "node.model_changed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      rigId: rig.id,
      nodeId: node.id,
      logicalId: "dev.impl",
      from: "fable",
      to: "claude-fable-5",
      reason: "alias migration to canonical id",
      operator: "orch-lead@s5-rig",
    });
  });

  it("P1：set-model 使用已持久化值时 changed:false，且不发出事件", async () => {
    const { sessionName } = seatFixture("s5-rig", "dev.impl", { model: "claude-fable-5" });

    const result = await service.setModel({ seatRef: sessionName, model: "claude-fable-5", reason: "no-op check" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.changed).toBe(false);
    expect(eventsOfType(db, "node.model_changed")).toHaveLength(0);
  });

  it("P2：set-model 保持会话血缘字节完全一致（sessions + occupant_tenures + resume token）", async () => {
    const { node, sessionName } = seatFixture("s5-rig", "dev.impl", { model: "fable" });
    const before = lineageSnapshot(db, node.id);

    const result = await service.setModel({ seatRef: sessionName, model: "claude-fable-5", reason: "alias migration" });
    expect(result.ok).toBe(true);

    const after = lineageSnapshot(db, node.id);
    expect(after.sessionRows).toEqual(before.sessionRows);
    expect(after.tenureCount).toBe(before.tenureCount);
    // 节点行唯一的变更是 model 列。
    expect(after.nodeRow).toEqual({ ...(before.nodeRow as Record<string, unknown>), model: "claude-fable-5" });
  });

  it("set-model 明确拒绝且不产生变更", async () => {
    const { rig, node, sessionName } = seatFixture("s5-rig", "dev.impl", { model: "fable" });

    const missingModel = await service.setModel({ seatRef: sessionName, model: "   ", reason: "x" });
    expect(missingModel.ok).toBe(false);
    if (missingModel.ok) throw new Error("expected refusal");
    expect(missingModel.code).toBe("missing_model");

    const missingReason = await service.setModel({ seatRef: sessionName, model: "claude-fable-5", reason: "" });
    expect(missingReason.ok).toBe(false);
    if (missingReason.ok) throw new Error("expected refusal");
    expect(missingReason.code).toBe("missing_reason");

    const notFound = await service.setModel({ seatRef: "ghost-seat@s5-rig", model: "claude-fable-5", reason: "x" });
    expect(notFound.ok).toBe(false);
    if (notFound.ok) throw new Error("expected refusal");
    expect(notFound.code).toBe("seat_not_found");

    // 两个工作组中存在相同 logical id，裸引用 → 有歧义，并列出匹配项。
    seatFixture("s5-rig-b", "dev.impl", { model: "fable" });
    const ambiguous = await service.setModel({ seatRef: "dev.impl", model: "claude-fable-5", reason: "x" });
    expect(ambiguous.ok).toBe(false);
    if (ambiguous.ok) throw new Error("expected refusal");
    expect(ambiguous.code).toBe("seat_ambiguous");
    expect(ambiguous.matches?.length).toBe(2);

    // 拒绝过程中任何位置都未发生变更。
    const persisted = rigRepo.getRig(rig.id)!.nodes.find((n) => n.id === node.id)!;
    expect(persisted.model).toBe("fable");
    expect(eventsOfType(db, "node.model_changed")).toHaveLength(0);
  });

  // ---- P3 / P4——stop ----

  it("P3：stop 只终止目标席位；同级席位的会话、绑定和 tmux 保留", async () => {
    const a = seatFixture("s5-rig", "dev.impla");
    const b = seatFixture("s5-rig", "dev.implb");

    const result = await service.stopSeat({ seatRef: a.sessionName, reason: "single-seat stop test", operator: "op@rig" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(tmux.killed).toEqual([a.sessionName]);

    const aSession = db.prepare("SELECT status FROM sessions WHERE id = ?").get(a.session.id) as { status: string };
    expect(aSession.status).toBe("exited");
    expect(sessionRegistry.getBindingForNode(a.node.id)).toBeNull();

    const bSession = db.prepare("SELECT status FROM sessions WHERE id = ?").get(b.session.id) as { status: string };
    expect(bSession.status).toBe("running");
    expect(sessionRegistry.getBindingForNode(b.node.id)).not.toBeNull();

    const events = eventsOfType(db, "session.stopped");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ nodeId: a.node.id, sessionName: a.sessionName, reason: "single-seat stop test", operator: "op@rig" });
  });

  it("P4：stop 拒绝已终止席位（session_not_live → 指导中指明 clean），且不产生变更", async () => {
    const a = seatFixture("s5-rig", "dev.impl");
    tmux.setAlive(a.sessionName, false);

    const result = await service.stopSeat({ seatRef: a.sessionName, reason: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.code).toBe("session_not_live");
    expect(result.guidance).toContain("clean");
    expect(tmux.killed).toEqual([]);
    expect((db.prepare("SELECT status FROM sessions WHERE id = ?").get(a.session.id) as { status: string }).status).toBe("running");
    expect(sessionRegistry.getBindingForNode(a.node.id)).not.toBeNull();
  });

  it("P4：stop 拒绝已认领（接管）会话、不确定探测和无会话节点", async () => {
    const claimed = seatFixture("s5-rig", "dev.adopted", { origin: "claimed" });
    const claimedResult = await service.stopSeat({ seatRef: claimed.sessionName, reason: "x" });
    expect(claimedResult.ok).toBe(false);
    if (claimedResult.ok) throw new Error("expected refusal");
    expect(claimedResult.code).toBe("claimed_session");

    const probed = seatFixture("s5-rig", "dev.flaky");
    tmux.failProbeFor(probed.sessionName);
    const probeResult = await service.stopSeat({ seatRef: probed.sessionName, reason: "x" });
    expect(probeResult.ok).toBe(false);
    if (probeResult.ok) throw new Error("expected refusal");
    expect(probeResult.code).toBe("tmux_probe_failed");
    expect(tmux.killed).toEqual([]);

    const rig = rigRepo.findRigsByName("s5-rig")[0]!;
    rigRepo.addNode(rig.id, "dev.bare", { runtime: "claude-code" });
    const bare = await service.stopSeat({ seatRef: "dev.bare", reason: "x" });
    expect(bare.ok).toBe(false);
    if (bare.ok) throw new Error("expected refusal");
    expect(bare.code).toBe("no_session");
  });

  // ---- P5 / P6——clean ----

  it("P5：clean 在不删除所有者状态的前提下使已终止席位恢复可启动（固定 already_bound 缺陷）", async () => {
    const a = seatFixture("s5-rig", "dev.impl");
    // 席位在所有受支持动词之外终止（正常退出）：tmux 消失，数据库过期。
    tmux.setAlive(a.sessionName, false);

    const launcher = new NodeLauncher({
      db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux.adapter,
    });

    // 基线中的缺口 3 缺陷：绑定在终止后仍存在，因此 launch 永久拒绝。
    const blocked = await launcher.launchNode(a.rig.id, "dev.impl");
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("expected already_bound");
    expect(blocked.code).toBe("already_bound");

    const before = lineageSnapshot(db, a.node.id);
    const cleaned = await service.cleanSeat({ seatRef: a.sessionName, reason: "clean exit observed", operator: "op@rig" });
    expect(cleaned.ok).toBe(true);
    if (!cleaned.ok) throw new Error(cleaned.message);
    expect(cleaned.actions.bindingCleared).toBe(true);
    expect(cleaned.actions.sessionsExited).toEqual([a.sessionName]);

    // 保留所有者状态：节点行、会话历史（包括 resume token）、tenure 台账。
    const after = lineageSnapshot(db, a.node.id);
    expect(after.nodeRow).toEqual(before.nodeRow);
    expect(after.tenureCount).toBe(before.tenureCount);
    expect(after.sessionRows.length).toBe(before.sessionRows.length);
    expect((after.sessionRows[0] as { resume_token: string | null }).resume_token).toBe("resume-uuid-1234");

    // 绑定已清除；会话已终止；审计事件已持久化。
    expect(sessionRegistry.getBindingForNode(a.node.id)).toBeNull();
    expect((db.prepare("SELECT status FROM sessions WHERE id = ?").get(a.session.id) as { status: string }).status).toBe("exited");
    expect(eventsOfType(db, "session.cleaned")).toHaveLength(1);

    // 定义该动词的后置条件：launch 不再以 already_bound 拒绝。
    const relaunch = await launcher.launchNode(a.rig.id, "dev.impl");
    expect(relaunch.code === "already_bound").toBe(false);
  });

  it("P5：clean 处理被协调器分离的席位时只清除过期绑定", async () => {
    const a = seatFixture("s5-rig", "dev.impl");
    tmux.setAlive(a.sessionName, false);
    sessionRegistry.markDetached(a.session.id); // what the reconciler records on death

    const cleaned = await service.cleanSeat({ seatRef: a.sessionName, reason: "post-reconcile clean" });
    expect(cleaned.ok).toBe(true);
    if (!cleaned.ok) throw new Error(cleaned.message);
    expect(cleaned.actions.bindingCleared).toBe(true);
    expect(cleaned.actions.sessionsExited).toEqual([]); // detached is already terminal
    expect(sessionRegistry.getBindingForNode(a.node.id)).toBeNull();
  });

  it("P6：clean 拒绝存活席位（session_live → 指导中指明 stop）、不确定探测和干净席位（nothing_to_clean 指明两项检查）", async () => {
    const live = seatFixture("s5-rig", "dev.live");
    const liveResult = await service.cleanSeat({ seatRef: live.sessionName, reason: "x" });
    expect(liveResult.ok).toBe(false);
    if (liveResult.ok) throw new Error("expected refusal");
    expect(liveResult.code).toBe("session_live");
    expect(liveResult.guidance).toContain("stop");
    expect(sessionRegistry.getBindingForNode(live.node.id)).not.toBeNull();

    const probed = seatFixture("s5-rig", "dev.flaky");
    tmux.failProbeFor(probed.sessionName);
    const probeResult = await service.cleanSeat({ seatRef: probed.sessionName, reason: "x" });
    expect(probeResult.ok).toBe(false);
    if (probeResult.ok) throw new Error("expected refusal");
    expect(probeResult.code).toBe("tmux_probe_failed");

    const done = seatFixture("s5-rig", "dev.done");
    tmux.setAlive(done.sessionName, false);
    sessionRegistry.markDetached(done.session.id);
    sessionRegistry.clearBinding(done.node.id);
    const nothing = await service.cleanSeat({ seatRef: done.sessionName, reason: "x" });
    expect(nothing.ok).toBe(false);
    if (nothing.ok) throw new Error("expected refusal");
    expect(nothing.code).toBe("nothing_to_clean");
    expect(nothing.message).toMatch(/binding/i);
    expect(nothing.message).toMatch(/session/i);
  });

  // ---- 第 2 波修复第 1 轮（r1 阻断，第 9baac99f 行）——传输抖动与真实适配器 ----
  //
  // r1 证据（在此反转为 RED）：真实 TmuxAdapter 遇到无服务端抖动时，将 probeSession()
  // 分类为 transport_unavailable，而其折叠后的 hasSession() 视图返回 false。消费折叠视图的
  // 动词会把抖动视为缺失——这是 KI-5.3-8 伪造缺失类型，且方向具有破坏性：clean 会清除
  // 存活席位的状态。
  describe("传输抖动（真实 TmuxAdapter，注入无服务端 exec）", () => {
    function blipWorld() {
      const realTmux = new TmuxAdapter(async () => {
        throw new Error("no server running on /private/tmp/tmux-501/default");
      });
      const svc = new SeatLifecycleService({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: realTmux });
      const seat = seatFixture("s5-rig", "dev.impl");
      return { realTmux, svc, seat };
    }

    it("适配器自身可区分抖动（对照：探针报告 transport_unavailable）", async () => {
      const { realTmux, seat } = blipWorld();
      const probe = await realTmux.probeSession(seat.sessionName);
      expect(probe.state).toBe("transport_unavailable");
    });

    it("抖动期间 clean 以 indeterminate 拒绝，并保持存活席位状态字节完全一致", async () => {
      const { svc, seat } = blipWorld();
      const before = lineageSnapshot(db, seat.node.id);

      const res = await svc.cleanSeat({ seatRef: seat.sessionName, reason: "blip pin" });

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("DEFECT: cleanSeat proceeded under a transport blip against a live seat");
      expect(res.code).toBe("tmux_probe_failed");
      expect(res.message).toContain("未能确定");

      // 没有内容被破坏：绑定完整、会话仍在运行、没有事件。
      expect(sessionRegistry.getBindingForNode(seat.node.id)).not.toBeNull();
      expect((db.prepare("SELECT status FROM sessions WHERE id = ?").get(seat.session.id) as { status: string }).status).toBe("running");
      expect(eventsOfType(db, "session.cleaned")).toHaveLength(0);
      expect(lineageSnapshot(db, seat.node.id)).toEqual(before);
    });

    it("F3 固定项（r2 第 30045f39 行）：较旧存活 / 较新终止会话——clean 必须拒绝，不能终止较旧存活会话", async () => {
      // 规范名称变化可能让一个节点留下多个不同名称的非终止会话行（分阶段/旧版重命名）。
      // clean 会修改全部非终止行，因此安全探针必须覆盖将触碰的每一行——只探测最新行会
      // 为其他行伪造安全性。
      const tmuxLocal = fakeTmux();
      const svcLocal = new SeatLifecycleService({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmuxLocal.adapter });
      // fixture 会话是较旧行，且在 tmux 中保持存活。
      //（seatFixture 在外层 fake 上标记存活；在本测试自己的 fake 上同步标记。）
      const seat = seatFixture("s5-rig", "dev.impl");
      tmuxLocal.setAlive(seat.sessionName, true);
      // 使用后继名称的较新会话行，在 tmux 中已终止。
      const newerName = "dev-impl-v2@s5-rig";
      const newer = sessionRegistry.registerSession(seat.node.id, newerName);
      sessionRegistry.updateStatus(newer.id, "running");
      tmuxLocal.setAlive(newerName, false);
      // 来自数据库本身的排序防护：已终止行确实最新。
      const newest = db.prepare("SELECT id FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1").get(seat.node.id) as { id: string };
      expect(newest.id).toBe(newer.id);

      // 通过当前规范名称（最新会话的名称）寻址——这是现实的操作者引用；较旧存活会话
      // 隐藏在其后。
      const res = await svcLocal.cleanSeat({ seatRef: newerName, reason: "F3 pin" });

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error(`DEFECT (F3): clean proceeded and terminalized sessions ${JSON.stringify(res.actions)} while "${seat.sessionName}" is LIVE`);
      expect(res.code).toBe("session_live");
      expect(res.message).toContain(seat.sessionName);
      // 较旧的存活会话行保持不变。
      expect((db.prepare("SELECT status FROM sessions WHERE id = ?").get(seat.session.id) as { status: string }).status).toBe("running");
      expect(sessionRegistry.getBindingForNode(seat.node.id)).not.toBeNull();
    });

    it("抖动期间 stop 以 indeterminate 拒绝——且不把操作者引导到 clean", async () => {
      const { svc, seat } = blipWorld();

      const res = await svc.stopSeat({ seatRef: seat.sessionName, reason: "blip pin" });

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("DEFECT: stopSeat acted under a transport blip");
      // 抖动必须产生 INDETERMINATE 拒绝，绝不能产生确证缺失拒绝。
      expect(res.code).toBe("tmux_probe_failed");
      // r1 标出的不安全路由：抖动期间拒绝不得指向破坏性动词。
      expect(res.guidance ?? "").not.toContain("clean");
      expect(res.message ?? "").not.toContain("rig seat clean");
      // 会话保持不变。
      expect((db.prepare("SELECT status FROM sessions WHERE id = ?").get(seat.session.id) as { status: string }).status).toBe("running");
    });
  });
});
