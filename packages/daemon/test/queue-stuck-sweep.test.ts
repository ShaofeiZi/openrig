// S02（OPR.0.5.5.2）——常驻卡住项扫描，RED-first。“queue overdue 与 queue undelivered
// 都是必须有人记得运行的 verb——而此前没人运行。”此 slice 将 sweep 变成常驻 daemon loop：
// 两部分按 config 指定 cadence 扫描，finding 以 row 形式路由到 owning seat；安静扫描成本低
//（一个 heartbeat，不创建 row），失败显著。
//
// 四种 finding：
//   overdue-claim        ——claimed-never-closed（findOverdue 部分，verb 不变）；
//   undelivered-wake     ——sender-believed-delivered-never-woken（findUndelivered 部分），
//                          排除带 live S01 ladder 的 row（接缝：S01 特意让其 ladder 在 transition
//                          上可读，使此 filter 可派生），并纳入 laddered-then-exhausted handback
//                          （恰好一个 finding）；
//   unclaimed-obligation ——A1 兜底：携带真实 obligation 的 created-with-destination row，
//                          超过 config 指定时长仍未 claim（排除 park——state=blocked 属于 S03，
//                          可以合法等待）；
//   dangling-closure     ——custody 类的内部兼容 key：terminal row 的 successor 无法在本地
//                          store 验证。面向用户的 finding 是 verification-required/indeterminate，
//                          绝不宣称目标不存在。跨所有 state 按 destination + obligation shape
//                          选择，绝不按 tag。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository, deriveCrossHostSuccessorId, type QueueItem } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { archiveAgedTerminalTransitions } from "../src/domain/queue-retention.js";

const sweepMod = () => import("../src/domain/queue-stuck-sweep.js");

describe("S02 常驻卡住项扫描——双路扫描、finding 路由、安静但可观测", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  });
  afterEach(() => {
    db.close();
  });

  async function mkRow(dest = "worker@r"): Promise<QueueItem> {
    return repo.create({ sourceSession: "sender@r", destinationSession: dest, body: "work" });
  }

  /** 通过 SQL 将既有事实老化的 fixture——产品代码绝不会看到注入的时钟。 */
  function ageCreated(qitemId: string, minutes: number): void {
    const past = new Date(Date.now() - minutes * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(past, qitemId);
  }
  function ageClaim(qitemId: string, minutes: number): void {
    const past = new Date(Date.now() - minutes * 60_000).toISOString();
    const beforePast = new Date(Date.now() - (minutes + 1) * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET claimed_at = ?, ts_created = ? WHERE qitem_id = ?").run(past, beforePast, qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND transition_note = 'claimed'").run(past, qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND transition_note = 'created'").run(beforePast, qitemId);
  }
  function makeOverdue(qitemId: string): void {
    const past = new Date(Date.now() - 60 * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET closure_required_at = ? WHERE qitem_id = ?").run(past, qitemId);
  }
  function failNudge(qitemId: string): void {
    setNudgeResult(qitemId, "failed:tmux session not found", new Date());
  }
  function setNudgeResult(qitemId: string, result: string, at: Date): void {
    db.prepare(
      "UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = ? WHERE qitem_id = ?",
    ).run(at.toISOString(), result, qitemId);
  }

  async function runSweep(overrides: Record<string, unknown> = {}) {
    const mod = await sweepMod();
    const status = mod.createStuckSweepStatus();
    const result = await mod.runStuckSweep({
      db,
      queueRepo: repo,
      status,
      resolveOrchestrator: () => null,
      unclaimedAgeMinutes: 60,
      log: () => {},
      // Hermetic 默认值：无 registered host。覆盖 proof-at-write 信任分支的测试会注入自己的
      // registry view。
      isRegisteredHost: () => false,
      ...overrides,
    });
    return { mod, status, result };
  }

  async function findingsFor(qitemId: string): Promise<QueueItem[]> {
    const mod = await sweepMod();
    const all = repo.list({ limit: 500 });
    return all.filter(
      (i) =>
        (i.tags ?? []).includes(mod.STUCK_SWEEP_FINDING_TAG) &&
        (i.tags ?? []).some((t) => t.endsWith(`:${qitemId}`)),
    );
  }

  it("逾期部分：claimed-never-closed row 超过 closure_required_at 后，恰好向 claimant 生成一条内联 evidence 的 finding row", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    makeOverdue(row.qitemId);
    const { result } = await runSweep();
    expect(result.outcome).toBe("findings");
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.destinationSession).toBe("worker@r"); // 持有卡住 obligation 的 seat
    expect(f.body).toContain(row.qitemId); // row id
    expect(f.body).toMatch(/已领取|closure_required_at/i);
    expect(f.body).toMatch(/\d+\s*分钟/i); // 时长
  });

  it("S04 PICKUP 接缝：stalled-after-claim 向 claimant 路由一条 finding，后续 motion 会自动关闭它", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    ageClaim(row.qitemId, 60);
    expect(repo.getById(row.qitemId)!.pickup?.state).toBe("stalled-after-claim");

    const first = await runSweep();
    expect(first.result.findings).toContainEqual(expect.objectContaining({
      kind: "stalled-after-claim",
      qitemId: row.qitemId,
      action: "created",
    }));
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.destinationSession).toBe("worker@r");

    await repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      transitionNote: "resumed work",
    });
    expect(repo.getById(row.qitemId)!.pickup?.state).toBe("working");
    const second = await runSweep();
    expect(second.result.findings).toContainEqual(expect.objectContaining({
      kind: "stalled-after-claim",
      qitemId: row.qitemId,
      action: "closed",
    }));
    expect((await findingsFor(row.qitemId))[0]).toMatchObject({
      state: "done",
      closureReason: "no-follow-on",
    });
  });

  it("未送达部分：nudge 失败的 pending row 恰好生成一条 finding，并路由到 destination 的 orchestrator", async () => {
    const row = await mkRow();
    failNudge(row.qitemId);
    const { result } = await runSweep({ resolveOrchestrator: () => "orch@r" });
    expect(result.outcome).toBe("findings");
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    // 无人持有未送达 obligation——将其路由到 owner 的 orchestrator。
    expect(findings[0]!.destinationSession).toBe("orch@r");
    expect(findings[0]!.body).toContain(row.qitemId);
    expect(findings[0]!.evidenceRef).toBe(`rig queue show ${row.qitemId}`);
  });

  it.each(["human@host", "human-owner@kernel"])("发给 %s 的 finding 携带真实 source evidence、保持 unroutable、能够去重并完成解决", async (destinationSession) => {
    // 禁用 repository 的 pre-topology transport 快捷路径。解析是真实的；注入的 transport 绝不能
    // 收到这些未知地址。
    db.prepare("INSERT INTO rigs(id,name) VALUES ('fixture-rig','r')").run();
    db.prepare("INSERT INTO nodes(id,rig_id,logical_id,runtime,profile) VALUES ('fixture-node','fixture-rig','worker','codex','none')").run();
    const sent: string[] = [];
    repo = new QueueRepository(db, new EventBus(db), {
      validateRig: () => true,
      loadHumanRegistry: () => ({ ok: true, entities: [] }),
      transport: { send: async (destination) => { sent.push(destination); return { ok: true, verified: true }; } },
    });
    const source = await mkRow();
    const row = await repo.create({
      sourceSession: "sender@r", destinationSession, body: "An actual work row awaits a decision",
      summary: "Fixture decision", evidenceRef: `rig queue show ${source.qitemId}`,
    });
    expect(row.lastNudgeResult).toMatch(/^unroutable:/);
    const first = await runSweep();
    expect(first.result.outcome).toBe("findings");
    expect(first.status.snapshot()).toMatchObject({ lastOutcome: "findings", lastError: null });
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    const finding = findings[0]!;
    expect(finding.evidenceRef).toBe(`rig queue show ${row.qitemId}`);
    expect(repo.getById(finding.evidenceRef!.slice("rig queue show ".length))?.body).toBe(row.body);
    expect(finding.destinationSession).toBe(destinationSession);
    expect(finding.lastNudgeResult).toMatch(/^unroutable:/);
    expect(sent).toEqual([]);

    expect((await runSweep()).result.findings).toContainEqual(expect.objectContaining({ findingQitemId: finding.qitemId, action: "refreshed" }));
    expect(await findingsFor(row.qitemId)).toHaveLength(1);
    await repo.update({ qitemId: row.qitemId, actorSession: row.sourceSession, state: "done", closureReason: "no-follow-on", transitionNote: "fixture resolved" });
    expect((await runSweep()).result.findings).toContainEqual(expect.objectContaining({ findingQitemId: finding.qitemId, action: "closed" }));
    expect(repo.getById(finding.qitemId)).toMatchObject({ state: "done", closureReason: "no-follow-on" });

    await expect(repo.create({ sourceSession: "sender@r", destinationSession, body: "Missing evidence", summary: "Decision" }))
      .rejects.toMatchObject({ code: "human_route_fields_required" });
  });

  it("按 destination 而非 tag：能发现完全无 tag 的卡住 row（0.5.3 教训的准确形态）", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    makeOverdue(row.qitemId);
    db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run("[]", row.qitemId);
    await runSweep();
    expect(await findingsFor(row.qitemId)).toHaveLength(1);
  });

  it("诚实报告本地缺失：未解析的本地 successor 为 verification-required，绝不宣称其失效，也不附带修改历史的指令", async () => {
    const unresolved = await mkRow();
    repo.claim({ qitemId: unresolved.qitemId, destinationSession: "worker@r" });
    const missing = "qitem-20990101000000-deadbeef";
    repo.update({
      qitemId: unresolved.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: missing,
      transitionNote: "handed off to a successor not visible in this local store",
    });

    await runSweep();
    const findings = await findingsFor(unresolved.qitemId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.body).toContain(missing);
    expect(findings[0]!.body).toMatch(/verification.required|indeterminate/i);
    expect(findings[0]!.body).toContain("OPENRIG_URL=<registered-host> zrig queue show");
    expect(findings[0]!.body).not.toMatch(/does not exist|dangling/i);
    expect(findings[0]!.body).not.toMatch(/请解决底层 row|重写历史 row/i);

    const successor = await repo.create({
      qitemId: "qitem-20990101000000-livefeed",
      sourceSession: "worker@r",
      destinationSession: "next@r",
      body: "successor",
    });
    const resolved = await mkRow();
    repo.claim({ qitemId: resolved.qitemId, destinationSession: "worker@r" });
    repo.update({
      qitemId: resolved.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: successor.qitemId,
      transitionNote: "handed off to a locally visible successor",
    });
    await runSweep();
    expect(await findingsFor(resolved.qitemId)).toHaveLength(0);
  });

  it("逗号拆分：完全本地的 fan-out 无异常；部分本地缺失只点名需要验证的 member", async () => {
    const a = await repo.create({ qitemId: "qitem-local-a", sourceSession: "worker@r", destinationSession: "a@r", body: "a" });
    const b = await repo.create({ qitemId: "qitem-local-b", sourceSession: "worker@r", destinationSession: "b@r", body: "b" });
    const complete = await mkRow();
    repo.update({
      qitemId: complete.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: `${a.qitemId},${b.qitemId}`,
    });
    const partial = await mkRow();
    const missing = "qitem-local-missing";
    repo.update({
      qitemId: partial.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: `${a.qitemId},${missing}`,
    });

    await runSweep();
    expect(await findingsFor(complete.qitemId)).toHaveLength(0);
    const findings = await findingsFor(partial.qitemId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.body).toContain(missing);
    expect(findings[0]!.body).not.toContain(a.qitemId);
  });

  it("HOST 限定 KEY：无需本地查询即可分类外部 successor，包括 handed-off source row", async () => {
    const row = await mkRow();
    const foreign = "qitem-xh-0123456789abcdef@vps-b";
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "handed-off",
      closureReason: "handed_off_to",
      closureTarget: foreign,
    });
    await runSweep();
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.body).toContain(foreign);
    expect(findings[0]!.body).toMatch(/verification.required|indeterminate/i);
  });

  it("幂等 REFRESH：对未解决 finding 连续扫描三次，只保留一条 open finding row，不伪造进展", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    makeOverdue(row.qitemId);
    await runSweep();
    await runSweep();
    const { result } = await runSweep();
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    expect(result.findings.some((f) => f.action === "refreshed")).toBe(true);
    const transitions = db
      .prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY ts")
      .all(findings[0]!.qitemId) as Array<{ transition_note: string | null }>;
    expect(transitions.some((t) => /refresh/i.test(t.transition_note ?? ""))).toBe(false);
  });

  it("抑制重新生成：evidence 未变时关闭 finding，会抑制下一次 sweep", async () => {
    const row = await mkRow();
    failNudge(row.qitemId);
    await runSweep();
    const first = (await findingsFor(row.qitemId))[0]!;
    repo.update({
      qitemId: first.qitemId,
      actorSession: first.destinationSession,
      state: "done",
      closureReason: "no-follow-on",
      transitionNote: "verified and closed",
    });

    const next = await runSweep();
    expect(next.result.findings).not.toContainEqual(expect.objectContaining({ qitemId: row.qitemId, action: "created" }));
    expect(await findingsFor(row.qitemId)).toHaveLength(1);
  });

  it("新 EVIDENCE + 自动关闭后复发：更新的 nudge row 字段时间戳恰好生成一条后继 finding，且无需底层 transition", async () => {
    const row = await mkRow();
    const initial = new Date(Date.now() - 60_000);
    setNudgeResult(row.qitemId, "failed:first", initial);
    await runSweep();

    setNudgeResult(row.qitemId, "verified", new Date());
    await runSweep();
    expect((await findingsFor(row.qitemId))[0]!.state).toBe("done");

    const futureEvidence = new Date(Date.now() + 60_000);
    setNudgeResult(row.qitemId, "failed:recurred", futureEvidence);
    const beforeTransitions = repo.transitionLog.listForQitem(row.qitemId).length;
    const recur = await runSweep();
    expect(recur.result.findings).toContainEqual(expect.objectContaining({
      kind: "undelivered-wake",
      qitemId: row.qitemId,
      action: "created",
    }));
    expect(await findingsFor(row.qitemId)).toHaveLength(2);
    expect(repo.transitionLog.listForQitem(row.qitemId)).toHaveLength(beforeTransitions);
  });

  it("OPEN FINDING 优先：即使相同 row 与 kind 有更早的 closed watermark，仍 refresh open finding", async () => {
    const row = await mkRow();
    setNudgeResult(row.qitemId, "failed:first", new Date(Date.now() - 120_000));
    await runSweep();
    const closed = (await findingsFor(row.qitemId))[0]!;
    repo.update({
      qitemId: closed.qitemId,
      actorSession: closed.destinationSession,
      state: "done",
      closureReason: "no-follow-on",
    });
    setNudgeResult(row.qitemId, "failed:new", new Date(Date.now() + 60_000));
    await runSweep();
    const open = (await findingsFor(row.qitemId)).find((f) => f.state === "pending")!;

    const again = await runSweep();
    expect(again.result.findings).toContainEqual(expect.objectContaining({
      findingQitemId: open.qitemId,
      action: "refreshed",
    }));
    expect((await findingsFor(row.qitemId)).filter((f) => f.state === "pending")).toHaveLength(1);
  });

  it("并发下恰好一次：两次重叠 sweep 只生成一条 finding row", async () => {
    const row = await mkRow();
    failNudge(row.qitemId);
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const gatedRepo = new Proxy(repo, {
      get(target, prop, receiver) {
        if (prop === "create") {
          return async (...args: Parameters<QueueRepository["create"]>) => {
            arrivals += 1;
            if (arrivals === 2) release();
            await barrier;
            return target.create(...args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await Promise.all([
      runSweep({ queueRepo: gatedRepo }),
      runSweep({ queueRepo: gatedRepo }),
    ]);
    expect(await findingsFor(row.qitemId)).toHaveLength(1);
  });

  it("解决后关闭：底层 row 解决后，下一次 sweep 会携带原因关闭 finding", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    makeOverdue(row.qitemId);
    await runSweep();
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "no-follow-on",
      transitionNote: "finished the work",
    });
    await runSweep();
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.state).toBe("done");
    expect(findings[0]!.closureReason).toBeTruthy();
  });

  it("安静扫描成本低：clean sweep 不创建 row，只记录一个可观测 heartbeat", async () => {
    const before = (db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n;
    const { status, result } = await runSweep();
    expect(result.outcome).toBe("clean");
    const after = (db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n;
    expect(after).toBe(before);
    const snap = status.snapshot();
    expect(snap.lastSweepAt).toBeTruthy();
    expect(snap.lastOutcome).toBe("clean");
  });

  it("失败显著：无法运行的 sweep 会在 status surface 记录具名错误，绝不静默跳过", async () => {
    const brokenDb = new Database(":memory:"); // 无 migration——让 sweep 自身的查询失败
    const mod = await sweepMod();
    const status = mod.createStuckSweepStatus();
    const loud: string[] = [];
    const result = await mod.runStuckSweep({
      db: brokenDb,
      queueRepo: repo, // repo 正常；失败的是 sweep 的 db 环节
      status,
      resolveOrchestrator: () => null,
      unclaimedAgeMinutes: 60,
      log: (line: string) => loud.push(line),
    });
    brokenDb.close();
    expect(result.outcome).toBe("failed");
    expect(result.error).toBeTruthy();
    const snap = status.snapshot();
    expect(snap.lastOutcome).toBe("failed");
    expect(snap.lastError).toBeTruthy();
    expect(loud.length).toBeGreaterThan(0); // 显著信息会发出，而不只是存储
  });

  it("S01 接缝——跳过 LIVE LADDER：transition 携带 live ladder marker 的未送达 row 不生成 finding（由 S01 负责）", async () => {
    const mod = await sweepMod();
    expect(mod.LADDER_ATTEMPT_PREFIX).toBe("wake-attempt:");
    expect(mod.LADDER_EXHAUSTED_PREFIX).toBe("ladder-exhausted:");
    const row = await mkRow();
    failNudge(row.qitemId);
    repo.update({
      qitemId: row.qitemId,
      actorSession: "sender@r",
      transitionNote: `${mod.LADDER_ATTEMPT_PREFIX} 1 failed:tmux session not found`,
    });
    await runSweep();
    expect(await findingsFor(row.qitemId)).toHaveLength(0);
  });

  it("S01 接缝——捕获 EXHAUSTED 交回：laddered-then-exhausted row 再次由 sweep 兜底——恰好一个 finding", async () => {
    const mod = await sweepMod();
    const row = await mkRow();
    failNudge(row.qitemId);
    repo.update({
      qitemId: row.qitemId,
      actorSession: "sender@r",
      transitionNote: `${mod.LADDER_ATTEMPT_PREFIX} 3 failed:tmux session not found`,
    });
    repo.update({
      qitemId: row.qitemId,
      actorSession: "sender@r",
      transitionNote: `${mod.LADDER_EXHAUSTED_PREFIX} cap reached after 3 attempts`,
    });
    await runSweep();
    await runSweep(); // handback 仍会去重：绝不重复报告
    expect(await findingsFor(row.qitemId)).toHaveLength(1);
  });

  it("S01 接缝——最新 MARKER 优先：attempt → exhausted → attempt 会再次 live 并被跳过", async () => {
    const mod = await sweepMod();
    const row = await mkRow();
    failNudge(row.qitemId);
    for (const transitionNote of [
      `${mod.LADDER_ATTEMPT_PREFIX} 1`,
      `${mod.LADDER_EXHAUSTED_PREFIX} old cycle exhausted`,
      `${mod.LADDER_ATTEMPT_PREFIX} 1 new cycle`,
    ]) {
      repo.update({ qitemId: row.qitemId, actorSession: "sender@r", transitionNote });
    }
    await runSweep();
    expect(await findingsFor(row.qitemId)).toHaveLength(0);
  });

  it("A1 兜底——UNCLAIMED OBLIGATION：能发现超过时长阈值仍未 claim 的 created-with-destination row；新 row 与 parked row 不会被发现", async () => {
    const stale = await mkRow();
    ageCreated(stale.qitemId, 120);
    const fresh = await mkRow();
    const parked = await mkRow();
    repo.update({
      qitemId: parked.qitemId,
      actorSession: "sender@r",
      state: "blocked",
      blockedOn: stale.qitemId,
      transitionNote: "parked on blocker",
    });
    ageCreated(parked.qitemId, 120);
    const { result } = await runSweep({ resolveOrchestrator: () => "orch@r" });
    expect(result.outcome).toBe("findings");
    const staleFindings = await findingsFor(stale.qitemId);
    expect(staleFindings).toHaveLength(1);
    expect(staleFindings[0]!.destinationSession).toBe("orch@r");
    expect(await findingsFor(fresh.qitemId)).toHaveLength(0);
    expect(await findingsFor(parked.qitemId)).toHaveLength(0); // park 可以合法等待（属于 S03）
  });

  it("不级联：finding row 自身绝不产生 finding——路由后再次 sweep 不生成新 row", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    makeOverdue(row.qitemId);
    await runSweep();
    const afterFirst = (db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n;
    // 将 finding row 自身老化到超过 unclaimed threshold——仍不扫描（自我排除）。
    const findings = await findingsFor(row.qitemId);
    ageCreated(findings[0]!.qitemId, 120);
    await runSweep();
    const afterSecond = (db.prepare("SELECT COUNT(*) AS n FROM queue_items").get() as { n: number }).n;
    expect(afterSecond).toBe(afterFirst);
  });

  it("默认 ORCHESTRATOR 解析：production identity 形态通过持久 session binding 解析——点号 logical id、短横线 canonical session，不做字符串派生", async () => {
    // live fleet 形态（review-r2 修复轮次）：`orch-lead@r` 绑定 logical_id 为 `orch.lead` 的
    // node——两种形式相互独立定义；持久链接是 sessions table binding，绝不是字符串转换。
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig1', 'r')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n-orch', 'rig1', 'orch.lead')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n-worker', 'rig1', 'worker.b2')").run();
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-orch', 'n-orch', 'orch-lead@r', 'running')",
    ).run();
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-worker', 'n-worker', 'worker-b2@r', 'running')",
    ).run();
    db.prepare(
      "INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES ('e1', 'rig1', 'n-orch', 'n-worker', 'delegates_to')",
    ).run();
    const row = await mkRow("worker-b2@r");
    failNudge(row.qitemId);
    await runSweep({ resolveOrchestrator: undefined }); // 覆盖默认实现
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    // parent 当前的 canonical session binding——绝不是合成的 logical_id@rig。
    expect(findings[0]!.destinationSession).toBe("orch-lead@r");
  });

  // ——— S02 detector family 延续（row c2172d32）：cross-host close 写入的 host-qualified target
  // 属于 proof-at-write（routes/queue.ts 先在 registered host 创建 successor，再执行 close），而手工
  // registered-host read 会获得持久 custody-verified disposition。两者都会停止无休止的
  // verification-required refresh；未注册 host 与未验证的本地缺失仍保持诚实的 indeterminate 类，
  // 同时保留真正的本地 dangling 检测与自动关闭。

  it("可信 HOST 限定目标：真实 cross-host close 在 REGISTERED host 上的派生 key 是写入时 custody evidence——不生成 finding", async () => {
    // forwarding route 在 successor-create 成功后执行的准确写入（routes/queue.ts：先
    // forwardQueueWrite，再 close）：确定性派生的 successor id + host qualifier + handed_off_to。
    const row = await mkRow();
    const derived = deriveCrossHostSuccessorId(row.qitemId, "next@r2", "mm2-parent");
    repo.closeCrossHostHandoffSource({
      qitemId: row.qitemId,
      fromSession: "worker@r",
      toSession: "next@r2",
      closureTarget: `${derived}@mm2-parent`,
      terminalState: "handed-off",
    });
    await runSweep({ isRegisteredHost: (h: string) => h === "mm2-parent" });
    expect(await findingsFor(row.qitemId)).toHaveLength(0);
  });

  it("不信任伪造的 HOST 限定目标：通用 close 写入形似 registered-host 但无派生 key 的 target，仍为 verification-required", async () => {
    // 通用 update route 接受任意 closureTarget——只有 registered host 后缀只是语法，不是 forward
    // provenance。只有 cross-host close 根据（source row、handed_off_to、host）派生的 id 才有效。
    const row = await mkRow();
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "handed-off",
      closureReason: "handed_off_to",
      closureTarget: "qitem-xh-0123456789abcdef@mm2-parent",
    });
    await runSweep({ isRegisteredHost: (h: string) => h === "mm2-parent" });
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.body).toContain("qitem-xh-0123456789abcdef@mm2-parent");
    expect(findings[0]!.body).toMatch(/verification.required|indeterminate/i);
  });

  it("DISPOSITION 经受 RETENTION：真实 archiver 移走 terminal row 的 transition 后，custody-verified note 仍能抑制 finding", async () => {
    const row = await mkRow();
    const missing = "qitem-20990101000000-precon04";
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: missing,
    });
    await repo.update({
      qitemId: row.qitemId,
      actorSession: "verifier@r",
      transitionNote: `custody-verified: ${missing} confirmed on the parent host`,
    });
    // 将每条 transition 老化到超过 30 天 window，并运行实际交付的 archiver——这是实际 retention
    // 机制，而非模拟。
    const aged = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(aged, row.qitemId);
    const archived = archiveAgedTerminalTransitions(db, { nowIso: new Date().toISOString() });
    expect(archived.archivedRows).toBeGreaterThan(0);
    const activeLeft = db
      .prepare("SELECT COUNT(*) AS n FROM queue_transitions WHERE qitem_id = ?")
      .get(row.qitemId) as { n: number };
    expect(activeLeft.n).toBe(0); // disposition 已从 active table 移除

    await runSweep();
    expect(await findingsFor(row.qitemId)).toHaveLength(0);
  });

  it("未注册 HOST 保持 INDETERMINATE：未知 host qualifier 仍会得到措辞诚实的 verification-required finding", async () => {
    const row = await mkRow();
    const foreign = "qitem-xh-fedcba9876543210@vps-unknown";
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: foreign,
    });
    await runSweep({ isRegisteredHost: (h: string) => h === "mm2-parent" });
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.body).toContain(foreign);
    expect(findings[0]!.body).toMatch(/verification.required|indeterminate/i);
    expect(findings[0]!.body).not.toMatch(/does not exist|dangling/i);
  });

  it("CUSTODY-VERIFIED DISPOSITION：closed row 上的持久 custody-verified note 会抑制裸 id 的本地缺失", async () => {
    const row = await mkRow();
    const missing = "qitem-20990101000000-precon01";
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: missing,
    });
    await repo.update({
      qitemId: row.qitemId,
      actorSession: "verifier@r",
      transitionNote: `custody-verified: ${missing} confirmed on the parent host via OPENRIG_URL read`,
    });
    await runSweep();
    expect(await findingsFor(row.qitemId)).toHaveLength(0);
  });

  it("DISPOSITION 关闭 OPEN FINDING：finding 生成后写入 verification，下一次 sweep 自动关闭它，且 finding 已给出操作方法", async () => {
    const row = await mkRow();
    const missing = "qitem-20990101000000-precon02";
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: missing,
    });
    await runSweep();
    const open = (await findingsFor(row.qitemId))[0]!;
    expect(open.state).toBe("pending");
    // finding body 说明如何持久记录 verification。
    expect(open.body).toContain("custody-verified:");

    await repo.update({
      qitemId: row.qitemId,
      actorSession: "verifier@r",
      transitionNote: `custody-verified: ${missing} confirmed on the parent host`,
    });
    const next = await runSweep();
    expect(next.result.findings).toContainEqual(expect.objectContaining({
      kind: "dangling-closure",
      qitemId: row.qitemId,
      action: "closed",
    }));
    expect((await findingsFor(row.qitemId))[0]).toMatchObject({
      state: "done",
      closureReason: "no-follow-on",
    });
  });

  it("混合逗号 MEMBER 信任：一个 member 已由 disposition 验证、一个本地缺失的 fan-out，只点名未解决 member", async () => {
    // 真实 legacy 形态：逗号 fan-out 中已验证 member 获得持久 disposition（逗号列表来自
    // legacy/通用 close；cross-host close 路径只写一个派生 target，绝不写列表）。
    const row = await mkRow();
    const missing = "qitem-local-missing2";
    const verified = "qitem-local-verified1";
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: `${missing},${verified}`,
    });
    await repo.update({
      qitemId: row.qitemId,
      actorSession: "verifier@r",
      transitionNote: `custody-verified: ${verified} confirmed on the parent host`,
    });
    await runSweep();
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    // verification-targets checklist 将每个 member 渲染为 "- <target>"；已验证 member 必须不在
    // 该列表中。（body 的 last-transition 行会逐字回显 custody-verified note，因此直接断言 body
    // 不含该 id，会因 disposition 自身的诚实回显而失败。）
    expect(findings[0]!.body).toContain(`- ${missing}`);
    expect(findings[0]!.body).not.toContain(`- ${verified}`);
  });

  it("DISPOSITION 精确匹配：custody-verified note 点名不同 target 时不会抑制任何内容", async () => {
    const row = await mkRow();
    const missing = "qitem-20990101000000-precon03";
    repo.update({
      qitemId: row.qitemId,
      actorSession: "worker@r",
      state: "done",
      closureReason: "handed_off_to",
      closureTarget: missing,
    });
    await repo.update({
      qitemId: row.qitemId,
      actorSession: "verifier@r",
      transitionNote: "custody-verified: qitem-20990101000000-otherrow confirmed elsewhere",
    });
    await runSweep();
    const findings = await findingsFor(row.qitemId);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.body).toContain(missing);
  });

  it("FOUNDING 默认值：daemon config surface 上 cadence 为 300 秒、unclaimed age 为 60 分钟，并与 module 常量一致", async () => {
    const mod = await sweepMod();
    expect(mod.DEFAULT_STUCK_SWEEP_INTERVAL_SECONDS).toBe(300);
    expect(mod.DEFAULT_STUCK_SWEEP_UNCLAIMED_AGE_MINUTES).toBe(60);
    const missingConfig = `/tmp/openrig-s02-missing-${process.pid}-${Date.now()}.json`;
    const store = new SettingsStore(missingConfig);
    expect(store.resolveOne("queue.stuck_sweep_interval_seconds" as never)).toMatchObject({
      value: 300,
      source: "default",
    });
    expect(store.resolveOne("queue.stuck_sweep_unclaimed_age_minutes" as never)).toMatchObject({
      value: 60,
      source: "default",
    });
  });
});
