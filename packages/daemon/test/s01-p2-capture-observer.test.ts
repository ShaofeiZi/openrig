import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport, probeSessionActivity } from "../src/domain/session-transport.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import {
  CaptureObserver,
  DEFAULT_OBSERVER_CAPACITY,
  DEFAULT_DRAIN_BATCH,
  hashSentText,
  type CaptureObserverSink,
  type Observation,
  type ObservationInput,
} from "../src/domain/capture-observer.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";

/**
 * 0.6.0 S01/S02 P2——只读 capture observer。
 * 契约：evidence/offline-contract-s01-s02-dev60/CONTRACT.md rev 2.2 §1.5 和
 * HOOK-SEAM-AGREEMENT.md（包含 dev50-guard 的 03:03Z source 限定）。
 * 使用真实 SessionTransport / probeSessionActivity / SeatDeliveryGuard 和注入的 terminal；
 * 使用内存 SQLite；不启动 tmux、网络、provider 或 daemon。
 */

type Capture = (target: string, lines?: number) => Promise<string | null>;

function terminal(opts?: { capture?: Capture; sendText?: (t: string, text: string) => Promise<TmuxResult>; guard?: SeatDeliveryGuard }) {
  const calls = { capture: 0, sendText: [] as string[], sendKeys: 0 };
  const adapter = {
    hasSession: async () => true,
    probeSession: async () => ({ state: "present" as const }),
    sendText: async (t: string, text: string) => {
      calls.sendText.push(text);
      return opts?.sendText ? opts.sendText(t, text) : { ok: true as const };
    },
    sendKeys: async () => { calls.sendKeys++; return { ok: true as const }; },
    capturePaneContent: async (t: string, lines?: number) => {
      calls.capture++;
      return opts?.capture ? opts.capture(t, lines) : "idle\n❯ ";
    },
    getPaneCommand: async () => null,
    deliveryGuard: opts?.guard,
  } as unknown as TmuxAdapter;
  return { adapter, calls };
}

describe("S01/S02 P2 capture observer", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessions: SessionRegistry;
  let clock: number;
  let occupant: string;
  const now = () => new Date(clock);

  function seed(pane = "%7") {
    const rig = rigRepo.createRig("obs-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "codex" });
    const s = sessions.registerSession(node.id, "dev-impl@obs-rig");
    sessions.updateStatus(s.id, "running");
    sessions.updateBinding(node.id, { tmuxSession: "dev-impl@obs-rig", tmuxPane: pane });
    // registerSession 生成首个 occupant tenure；读取真实值。
    occupant = (db.prepare(`SELECT generation_uuid AS g FROM occupant_tenures WHERE node_id = ? ORDER BY generation_ordinal DESC LIMIT 1`)
      .get(node.id) as { g: string }).g;
    return node;
  }

  function transport(adapter: TmuxAdapter, captureObserver?: CaptureObserverSink) {
    return new SessionTransport({ db, rigRepo, sessionRegistry: sessions, tmuxAdapter: adapter, now, sleep: async () => {}, captureObserver });
  }

  async function drainAll(o: CaptureObserver): Promise<Observation[]> {
    const out: Observation[] = [];
    while (o.stats().queued > 0) await o.drain((batch) => { out.push(...batch); });
    return out;
  }
  /** 普通 send 首先运行 readiness probe（其自身的 probe_activity observation）。 */
  async function sendObs(o: CaptureObserver): Promise<Observation[]> {
    return (await drainAll(o)).filter((x) => x.seam === "send_verify");
  }

  beforeEach(() => {
    clock = Date.parse("2026-09-27T03:00:00.000Z");
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessions = new SessionRegistry(db);
  });
  afterEach(() => db.close());

  describe("send_verify seam", () => {
    it("记录两次 capture、冻结的入口 binding、发送哈希和正则 verdict", async () => {
      const node = seed();
      let n = 0;
      // 20 行调用用于 readiness probe；30 行调用用于 verify 前后 capture。
      const t = terminal({ capture: async (_t, lines) => (lines === 20 ? "idle\n❯ " : ++n === 1 ? "before\n❯ " : "before\nhello world\n❯ ") });
      const o = new CaptureObserver();
      const result = await transport(t.adapter, o).send("dev-impl@obs-rig", "hello world", { verify: true });
      expect(result.outcome).toBe("delivered");
      const [obs] = await sendObs(o);
      expect(obs).toMatchObject({
        seam: "send_verify",
        binding: { sessionName: "dev-impl@obs-rig", nodeId: node.id, occupant, pane: "%7" },
        runtime: "codex",
        sentHash: hashSentText(t.calls.sendText[0]!),
        pre: { state: "captured", content: "before\n❯ " },
        post: { state: "captured", content: "before\nhello world\n❯ " },
        regexResult: { ok: true, outcome: "delivered", verified: true },
      });
      expect(obs!.seq).toBe(2); // seq 1 是此次 send 的 readiness probe
      expect(typeof obs!.attemptId).toBe("string");
      expect(Object.isFrozen(obs)).toBe(true);
      expect(Object.isFrozen(obs!.binding)).toBe(true);
    });

    it("null capture 为 unavailable(empty_or_failed)；抛出异常的 capture 为 capture_error", async () => {
      seed();
      let n = 0;
      const t = terminal({ capture: async (_t, lines) => { if (lines === 20) return "idle\n❯ "; if (++n === 1) return null; throw new Error("tmux gone"); } });
      const o = new CaptureObserver();
      const result = await transport(t.adapter, o).send("dev-impl@obs-rig", "x", { verify: true });
      expect(result.outcome).toBe("rendered-unconfirmed");
      const [obs] = await sendObs(o);
      expect(obs!.pre).toMatchObject({ state: "unavailable", cause: "empty_or_failed" });
      expect(obs!.post).toMatchObject({ state: "unavailable", cause: "capture_error" });
      expect(o.stats().missingCaptures).toBe(2); // probe 的 capture 成功
    });

    it("不带 verify 时两个 slot 均为 not_requested，且不虚构 verdict", async () => {
      seed();
      const t = terminal();
      const o = new CaptureObserver();
      await transport(t.adapter, o).send("dev-impl@obs-rig", "x");
      const [obs] = await sendObs(o);
      expect(obs!.pre).toEqual({ state: "not_requested" });
      expect(obs!.post).toEqual({ state: "not_requested" });
      expect(obs!.regexResult).toEqual({ ok: true });
      expect(t.calls.capture).toBe(1); // 只有原有 readiness-probe capture；P2 未新增
    });

    it("paste 失败时 post capture 保持 not_reached", async () => {
      seed();
      const t = terminal({ sendText: async () => ({ ok: false, code: "x", message: "boom" }) as TmuxResult });
      const o = new CaptureObserver();
      const result = await transport(t.adapter, o).send("dev-impl@obs-rig", "x", { verify: true });
      expect(result.reason).toBe("send_failed");
      const [obs] = await sendObs(o);
      expect(obs!.pre.state).toBe("captured");
      expect(obs!.post).toEqual({ state: "not_reached" });
      expect(obs!.regexResult).toMatchObject({ ok: false, outcome: "failed", reason: "send_failed" });
      expect(o.stats().notReachedCaptures).toBe(1);
    });

    it("即使 binding 在 send 期间变化，identity 仍冻结于 attempt 入口", async () => {
      const node = seed("%7");
      const t = terminal({
        sendText: async () => { sessions.updateBinding(node.id, { tmuxPane: "%99" }); return { ok: true as const }; },
      });
      const o = new CaptureObserver();
      await transport(t.adapter, o).send("dev-impl@obs-rig", "x", { verify: true });
      const [obs] = await sendObs(o);
      expect(obs!.binding.pane).toBe("%7");
    });

    it.each([undefined, 100])("rebind 后 readiness probe 仍携带 send 入口 binding（wait=%s）", async (waitForIdleMs) => {
      const node = seed();
      const t = terminal({ capture: async () => {
        sessions.updateBinding(node.id, { tmuxPane: "%99" });
        return "idle\n❯ ";
      } });
      const o = new CaptureObserver();
      await transport(t.adapter, o).send("dev-impl@obs-rig", "x", { waitForIdleMs });
      const [probe, send] = await drainAll(o);
      const expected = { sessionName: "dev-impl@obs-rig", nodeId: node.id, occupant, pane: "%7" };
      expect(probe!.binding).toEqual(expected);
      expect(send!.binding).toEqual(expected);
    });

    it("send 以相反顺序完成时仍保留 capture 顺序和时间", async () => {
      seed();
      let release!: () => void;
      let started!: () => void;
      let verifyCalls = 0;
      const postStarted = new Promise<void>((r) => { started = r; });
      const t = terminal({ capture: async (_target, lines) => {
        clock += 1000;
        if (lines === 30 && ++verifyCalls === 1) {
          return "before\n❯ ";
        }
        if (lines === 30 && verifyCalls === 2) {
          return new Promise<string>((r) => { release = () => r("after\n❯ "); started(); });
        }
        return "idle\n❯ ";
      } });
      const o = new CaptureObserver();
      const tr = transport(t.adapter, o);
      const first = tr.send("dev-impl@obs-rig", "first", { verify: true });
      await postStarted;
      await tr.send("dev-impl@obs-rig", "second", { verify: true });
      release();
      await first;
      const [second, earlier] = await sendObs(o);
      expect(earlier!.sentHash).toBe(hashSentText(t.calls.sendText[0]!));
      expect(second!.seq).toBeLessThan(earlier!.seq);
      expect(earlier!.pre).toHaveProperty("captureSeq", expect.any(Number));
      if (earlier!.pre.state !== "captured" || earlier!.post.state !== "captured" || second!.pre.state !== "captured") throw Error("missing capture");
      expect(earlier!.pre.captureSeq).toBeLessThan(earlier!.post.captureSeq);
      expect(earlier!.post.captureSeq).toBeLessThan(second!.pre.captureSeq);
      expect(Date.parse(earlier!.pre.capturedAt)).toBeLessThan(Date.parse(earlier!.completedAt));
    });

    it("历史 session 行不会标记当前 binding 的 pane/occupant", async () => {
      const node = seed("%7");
      const old = sessions.registerSession(node.id, "dev-impl-old@obs-rig");
      sessions.updateStatus(old.id, "running");
      const o = new CaptureObserver();
      // 节点 binding 仍指向 dev-impl@obs-rig；向旧名称发送时不得借用该 binding。
      await transport(terminal().adapter, o).send("dev-impl-old@obs-rig", "x");
      const [obs] = await sendObs(o);
      expect(obs!.binding).toMatchObject({ sessionName: "dev-impl-old@obs-rig", pane: null, occupant: null });
    });
  });

  describe("observer 绝不能改变 transport", () => {
    const input = (i: number): ObservationInput => ({
      seam: "probe_activity", attemptId: `bounded-${i}`,
      binding: { sessionName: "s", nodeId: null, occupant: null, pane: null },
      runtime: null, sentHash: null, pre: { state: "not_requested" }, post: { state: "not_reached" },
      regexResult: {}, completedAt: "t",
    });

    it("无效 capacity 和 drain size 不能禁用有限边界或使队列搁浅", async () => {
      for (const capacity of [NaN, Infinity, -1, 0, 0.5]) {
        const o = new CaptureObserver({ capacity });
        for (let i = 0; i < DEFAULT_OBSERVER_CAPACITY + 1; i++) o.record(input(i));
        expect(o.stats()).toMatchObject({ queued: DEFAULT_OBSERVER_CAPACITY, dropped: 1 });
        expect(await o.drain(() => {}, NaN)).toBe(DEFAULT_DRAIN_BATCH);
        expect(await o.drain(() => {}, Infinity)).toBe(DEFAULT_DRAIN_BATCH);
      }
    });

    it("consumer 修改不能清除或夸大 batch 计数", async () => {
      const o = new CaptureObserver();
      o.record(input(1)); o.record(input(2));
      expect(await o.drain((batch) => {
        expect(() => { (batch as Observation[]).length = 0; }).toThrow();
      })).toBe(2);
      expect(o.stats()).toMatchObject({ drained: 2, queued: 0, consumerFailures: 0 });
    });

    it("overflow 时仍统计 missing/not-requested/not-reached slot", () => {
      const o = new CaptureObserver({ capacity: 1 });
      o.record(input(1));
      o.record({ ...input(2), pre: { state: "unavailable", cause: "empty_or_failed", capturedAt: "t", captureSeq: 1 } });
      expect(o.stats()).toMatchObject({ recorded: 1, dropped: 1, missingCaptures: 1, notRequestedCaptures: 1, notReachedCaptures: 2 });
    });
    async function run(sink?: CaptureObserverSink) {
      seed();
      let n = 0;
      const t = terminal({ capture: async () => (++n % 2 === 1 ? "a\n❯ " : "a\nhi\n❯ ") });
      const result = await transport(t.adapter, sink).send("dev-impl@obs-rig", "hi", { verify: true });
      return { result, calls: t.calls };
    }

    it("抛出异常的 sink、已满 buffer 和无 observer 都产生相同结果及 terminal 调用", async () => {
      const baseline = await run(undefined);
      db.close(); db = createDb(); migrate(db, ALL_MIGRATIONS); rigRepo = new RigRepository(db); sessions = new SessionRegistry(db);
      const throwing = await run({ record: () => { throw new Error("sink exploded"); } });
      db.close(); db = createDb(); migrate(db, ALL_MIGRATIONS); rigRepo = new RigRepository(db); sessions = new SessionRegistry(db);
      const full = new CaptureObserver({ capacity: 1 });
      full.record({ seam: "probe_activity", attemptId: "fill", binding: { sessionName: "x", nodeId: null, occupant: null, pane: null },
        runtime: null, sentHash: null, pre: { state: "not_requested" }, post: { state: "not_requested" }, regexResult: {}, completedAt: "t" });
      const saturated = await run(full);
      for (const other of [throwing, saturated]) {
        expect(other.result).toEqual(baseline.result);
        expect(other.calls).toEqual(baseline.calls);
      }
      expect(full.stats()).toMatchObject({ recorded: 1, dropped: 2, queued: 1 }); // probe + send 均被丢弃
    });

    it("缓慢或失败的 consumer 绝不阻塞记录，且不重放任何内容", async () => {
      seed();
      const o = new CaptureObserver();
      const tr = transport(terminal().adapter, o);
      await tr.send("dev-impl@obs-rig", "one"); // seq 1 为 probe，2 为 send
      let release!: () => void;
      const slow = o.drain(() => new Promise<void>((r) => { release = r; }));
      expect(await o.drain(() => {})).toBe(0); // 拒绝并发 drain，不等待
      await tr.send("dev-impl@obs-rig", "two"); // seq 3、4：consumer 卡住时继续记录
      expect(o.stats().queued).toBe(2);
      release();
      expect(await slow).toBe(2);
      expect(await o.drain(() => { throw new Error("consumer down"); })).toBe(0);
      expect(o.stats()).toMatchObject({ drained: 2, consumerFailures: 1, consumerFailedObservations: 2, queued: 0 });
      await tr.send("dev-impl@obs-rig", "three");
      const later = await drainAll(o);
      expect(later.map((x) => x.seq)).toEqual([5, 6]); // 不重放失败 batch（3、4）
    });

    it("sequence number 在各 observation 之间有序", async () => {
      seed();
      const o = new CaptureObserver();
      const tr = transport(terminal().adapter, o);
      for (const text of ["a", "b", "c"]) await tr.send("dev-impl@obs-rig", text);
      const all = await drainAll(o);
      expect(all.map((x) => x.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(all.map((x) => x.seam)).toEqual(["probe_activity", "send_verify", "probe_activity", "send_verify", "probe_activity", "send_verify"]);
      // readiness probe 是独立 attempt；绝不借用 send 的 identity。
      expect(new Set(all.map((x) => x.attemptId)).size).toBe(6);
    });
  });

  describe("probe_activity seam", () => {
    it("在首次 await 前而非 capture 后快照 caller identity", async () => {
      const o = new CaptureObserver();
      let release!: () => void;
      const t = terminal();
      t.adapter.hasSession = () => new Promise<boolean>((r) => { release = () => r(true); });
      const binding = { nodeId: "original", occupant: "original-occupant", pane: "%7" };
      const pending = probeSessionActivity({ sessionName: "s@r", runtime: "codex", attachmentType: "tmux", tmuxAdapter: t.adapter, captureObserver: o, binding });
      binding.nodeId = "successor"; binding.occupant = "successor-occupant"; binding.pane = "%99";
      release();
      await pending;
      const [obs] = await drainAll(o);
      expect(obs!.binding).toEqual({ sessionName: "s@r", nodeId: "original", occupant: "original-occupant", pane: "%7" });
    });
    it("记录 captured、null 和抛出异常的 capture 及其分类 verdict", async () => {
      const o = new CaptureObserver();
      const probe = (capture: Capture) =>
        probeSessionActivity({ sessionName: "s@r", runtime: "codex", attachmentType: "tmux", tmuxAdapter: terminal({ capture }).adapter, captureObserver: o });
      const idle = await probe(async () => "x\n❯ ");
      await probe(async () => null);
      const failed = await probe(async () => { throw new Error("gone"); });
      const [a, b, c] = await drainAll(o);
      expect(a).toMatchObject({ seam: "probe_activity", pre: { state: "captured" }, post: { state: "not_requested" }, regexResult: { state: idle.state } });
      expect(b!.pre).toMatchObject({ state: "unavailable", cause: "empty_or_failed" });
      expect(c!.pre).toMatchObject({ state: "unavailable", cause: "capture_error" });
      expect(c!.regexResult).toEqual({ state: failed.state, reason: "capture_failed" });
    });

    it("没有 observer 时 probe 结果不变", async () => {
      const args = { sessionName: "s@r", runtime: "codex", attachmentType: "tmux" as const, now: new Date(0) };
      const plain = await probeSessionActivity({ ...args, tmuxAdapter: terminal().adapter });
      const observed = await probeSessionActivity({ ...args, tmuxAdapter: terminal().adapter, captureObserver: { record: () => { throw new Error("x"); } } });
      expect(observed).toEqual(plain);
    });
  });

  describe("retained_no_write seam", () => {
    it("真实 retention 后记录 guard 绑定的目标，且绝不记为 delivery", async () => {
      const node = seed();
      const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
      await guard.set(node.id, true, "tester", "protect draft");
      const t = terminal({ guard });
      const o = new CaptureObserver();
      const result = await transport(t.adapter, o).send("dev-impl@obs-rig", "held text", { deliveryId: "d-1", actorSession: "orch@r" });
      expect(result.outcome).toBe("retained");
      expect(t.calls.sendText).toHaveLength(0);
      const [obs] = await drainAll(o);
      expect(obs).toMatchObject({
        seam: "retained_no_write",
        binding: { sessionName: "dev-impl@obs-rig", nodeId: node.id, occupant, pane: "%7" },
        sentHash: hashSentText("held text"),
        pre: { state: "not_requested" },
        post: { state: "not_requested" },
        regexResult: { outcome: "retained" },
      });
      expect(t.calls.capture).toBe(0);
      // 回读同一 retained ID 不属于新的 retention。
      await transport(t.adapter, o).send("dev-impl@obs-rig", "held text", { deliveryId: "d-1", actorSession: "orch@r" });
      expect(o.stats().recorded).toBe(1);
    });

    it("guard 下仅提交的拒绝不属于 retained 事件", async () => {
      const node = seed();
      const guard = new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
      await guard.set(node.id, true, "tester", "protect draft");
      const o = new CaptureObserver();
      const result = await transport(terminal({ guard }).adapter, o).send("dev-impl@obs-rig", "", { submitOnly: true });
      expect(result.reason).toBe("typing_guard_enabled");
      expect(o.stats().recorded).toBe(0);
    });
  });

});
