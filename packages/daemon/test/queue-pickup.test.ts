// S04（OPR.0.5.5.4）——PICKUP RECEIPT，RED-first。“无人唤醒的持久 row 与正在进行的工作无法
// 区分”——此 slice 只从现有事实派生差异：claimedAt + config 指定 threshold 内首次有意义的 claim
// 后 transition（或 heartbeat）。无 claimant 编写的 receipt 字段，无 sweep loop。状态：
//   unclaimed            ——尚未 claim；
//   working              ——已 claim，且 claim 后有实质 motion，或仍在 threshold 内（anti-noise 方向）；
//   stalled-after-claim  ——已 claim、超过 threshold、无实质 motion；点名 evidence；
//   parked               ——仅 state=blocked。Wake health 由独立 `rig parked` 诊断派生；没有 wake 的
//                           blocked row 仍投影为 parked。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { QueueRepository, type QueueItem } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { ViewProjector } from "../src/domain/view-projector.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";

const THRESHOLD_ENV = "OPENRIG_QUEUE_PICKUP_STALL_THRESHOLD_MINUTES";

interface PickupShape {
  state: "unclaimed" | "working" | "stalled-after-claim" | "parked";
  evidence?: string;
}
const pickupOf = (item: QueueItem): PickupShape | undefined =>
  (item as unknown as { pickup?: PickupShape }).pickup;

const DOMAIN_ROOT = resolve(import.meta.dirname, "../src/domain");

describe("S04 pickup receipt——派生、可见且如实反映 threshold", () => {
  let db: Database.Database;
  let repo: QueueRepository;
  let priorEnv: string | undefined;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    priorEnv = process.env[THRESHOLD_ENV];
    delete process.env[THRESHOLD_ENV];
  });
  afterEach(() => {
    if (priorEnv === undefined) delete process.env[THRESHOLD_ENV];
    else process.env[THRESHOLD_ENV] = priorEnv;
    db.close();
  });

  /** 让 claim 老化：把 claimed_at（及 claim transition）向过去移动 N 分钟。对已有事实进行 fixture
   *  老化——产品代码不会看到注入 clock。 */
  function ageClaim(qitemId: string, minutes: number): void {
    const past = new Date(Date.now() - minutes * 60_000).toISOString();
    const beforePast = new Date(Date.now() - (minutes + 1) * 60_000).toISOString();
    db.prepare("UPDATE queue_items SET claimed_at = ?, ts_created = ? WHERE qitem_id = ?").run(past, beforePast, qitemId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND transition_note = 'claimed'").run(past, qitemId);
    // 一致 history：claim 前发生的一切（creation）随其一起老化——否则 created transition 会落在
    // 已老化 claim 之后，被读作 motion。
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ? AND transition_note = 'created'").run(beforePast, qitemId);
  }

  async function mkRow(): Promise<QueueItem> {
    return repo.create({ sourceSession: "a@r", destinationSession: "worker@r", body: "work" });
  }

  it("UNCLAIMED：从未 claim 的 row 在 getById projection 上读为 pickup.state=unclaimed", async () => {
    const row = await mkRow();
    const item = repo.getById(row.qitemId)!;
    expect(pickupOf(item)?.state).toBe("unclaimed");
  });

  it("WORKING（早期 motion）：claim 后有实质 transition 时读为 working——即使已超过 threshold", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    repo.update({ qitemId: row.qitemId, actorSession: "worker@r", transitionNote: "starting on the seam" });
    ageClaim(row.qitemId, 60); // 远超任何合理 threshold——motion 已证明 pickup。
    const item = repo.getById(row.qitemId)!;
    expect(pickupOf(item)?.state).toBe("working");
  });

  it("WORKING（heartbeat）：claim 后 heartbeat 算作 motion", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    ageClaim(row.qitemId, 60);
    db.prepare("UPDATE queue_items SET last_heartbeat = ? WHERE qitem_id = ?").run(new Date().toISOString(), row.qitemId);
    const item = repo.getById(row.qitemId)!;
    expect(pickupOf(item)?.state).toBe("working");
  });

  it("负向对照（threshold 诚实性）：尚无 motion 的新 claim 在 threshold 内读为 WORKING——绝不提前 stalled", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    const item = repo.getById(row.qitemId)!;
    expect(pickupOf(item)?.state).toBe("working");
  });

  it("FOUNDER 默认值：daemon config surface 的 pickup stall threshold 默认为 3 分钟", () => {
    const missingConfig = `/tmp/openrig-s04-missing-${process.pid}-${Date.now()}.json`;
    const setting = new SettingsStore(missingConfig).resolveOne(
      "queue.pickup_stall_threshold_minutes" as never,
    );
    expect(setting).toMatchObject({ value: 3, source: "default", defaultValue: 3 });
  });

  it("FOUNDER 默认值：pickup resolver 的 fail-open fallback 也是 3 分钟", async () => {
    const mod = await import("../src/domain/queue-pickup.js");
    expect(mod.DEFAULT_PICKUP_STALL_THRESHOLD_MINUTES).toBe(3);
  });

  it("STALLED-AFTER-CLAIM：超过 threshold 且无实质 motion——projection 中点名 evidence", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    ageClaim(row.qitemId, 60); // 默认 threshold 远低于 60 分钟。
    const item = repo.getById(row.qitemId)!;
    const p = pickupOf(item);
    expect(p?.state).toBe("stalled-after-claim");
    expect(p?.evidence).toMatch(/没有有意义的 queue change/i); // “N 分钟前已领取……”
    expect(p?.evidence).toContain("owner activity 为 unknown"); // “……此后没有实质 transition”。
  });

  it("PARKED（第四种诚实状态）：blocked row 绝不是 stalled——读为 parked", async () => {
    const blocker = await mkRow();
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    repo.update({ qitemId: row.qitemId, actorSession: "worker@r", state: "blocked", blockedOn: blocker.qitemId, transitionNote: "parked on blocker" });
    ageClaim(row.qitemId, 60);
    const item = repo.getById(row.qitemId)!;
    expect(pickupOf(item)?.state).toBe("parked");
  });

  it("来自 CONFIG 的 THRESHOLD，以效果观测：提高 threshold 会将 stalled row 变回 working", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    ageClaim(row.qitemId, 60);
    expect(pickupOf(repo.getById(row.qitemId)!)?.state).toBe("stalled-after-claim");
    process.env[THRESHOLD_ENV] = "120"; // fresh-read config surface：无需 restart。
    expect(pickupOf(repo.getById(row.qitemId)!)?.state).toBe("working");
  });

  it("LIST projection 也携带 pickup（row 视图一次读取即可回答 park-vs-strand）", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    ageClaim(row.qitemId, 60);
    const listed = repo.list({ destinationSession: "worker@r" }).find((i) => i.qitemId === row.qitemId)!;
    expect(pickupOf(listed)?.state).toBe("stalled-after-claim");
  });

  it("SCHEMA 证明：不存在新的 claimant-written receipt 字段——queue table 不含 pickup/receipt column", () => {
    for (const table of ["queue_items", "queue_transitions"]) {
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      expect(cols.some((c) => /pickup|receipt/i.test(c)), `${table} 不得携带 derived-state column`).toBe(false);
    }
  });

  it("SUPERSESSION：失效 queue-row writer 保持不存在，live daemon heartbeat 与容忍 null 的 reader 保留", () => {
    const queueRepository = readFileSync(resolve(DOMAIN_ROOT, "queue-repository.ts"), "utf8");
    const daemonLifecycle = readFileSync(resolve(DOMAIN_ROOT, "daemon-lifecycle-store.ts"), "utf8");
    const daemonEntry = readFileSync(resolve(DOMAIN_ROOT, "../index.ts"), "utf8");
    const rowWriter = /\brecordHeartbeat\s*\(/;
    const daemonWriter = ["record", "Heartbeat(nowIso"].join("");
    const daemonCall = ["daemonLifecycleStore.record", "Heartbeat"].join("");

    expect(queueRepository).not.toMatch(rowWriter);
    expect(daemonLifecycle).toContain(daemonWriter);
    expect(daemonEntry).toContain(daemonCall);
    for (const reader of ["queue-pickup.ts", "queue-stuck-sweep.ts", "queue-wake-ladder.ts"]) {
      expect(readFileSync(resolve(DOMAIN_ROOT, reader), "utf8")).toContain(
        "为知道 in-flight row 的 0.5.7 mechanized-pull turn-end hook 保留此 null 分支",
      );
    }
  });

  it("S02 接缝：stalledPickupFinding() 是纯 INPUT CONTRACT（kind、claimant target、evidence）——library 形态，而非 loop", async () => {
    const mod = (await import("../src/domain/queue-pickup.js")) as {
      stalledPickupFinding: (item: QueueItem) => { kind: string; target: string; qitemId: string; evidence: string } | null;
    };
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    ageClaim(row.qitemId, 60);
    const finding = mod.stalledPickupFinding(repo.getById(row.qitemId)!);
    expect(finding?.kind).toBe("stalled-after-claim");
    expect(finding?.target).toBe("worker@r"); // claimant 优先；S02 拥有 escalation chain。
    expect(finding?.qitemId).toBe(row.qitemId);
    expect(finding?.evidence).toMatch(/没有有意义的 queue change/i);
    // WORKING row 不产生 finding：
    const fresh = await mkRow();
    repo.claim({ qitemId: fresh.qitemId, destinationSession: "worker@r" });
    expect(mod.stalledPickupFinding(repo.getById(fresh.qitemId)!)).toBeNull();
  });

  it("VIEW LENS 'pickup'：带派生 state 与具名 stalled evidence 的 claimed row 可查询", async () => {
    const row = await mkRow();
    repo.claim({ qitemId: row.qitemId, destinationSession: "worker@r" });
    ageClaim(row.qitemId, 60);
    const projector = new ViewProjector(db, new EventBus(db));
    const result = projector.show("pickup");
    const mine = result.rows.find((r) => r.qitem_id === row.qitemId) as Record<string, unknown> | undefined;
    expect(mine, "pickup lens 必须列出 claimed row").toBeDefined();
    expect(String(mine!.pickup_state)).toBe("stalled-after-claim");
    expect(String(mine!.pickup_evidence)).toMatch(/没有有意义的 queue change/i);
  });
});
