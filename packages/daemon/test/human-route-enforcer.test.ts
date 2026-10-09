// OPR.0.4.4.19 FR-4/FR-5——人类路由强制规则（约定 C6 + C3）。
//
// §5 的作用域谓词就是完整的触发列表（BR-1）：tier 为 human-gate 或目的地为
// human-seat（park 分支在 blocked-transition 路径上校验，见 FR-6）。
// 谓词未命中的所有情况均保持不变。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository, QueueRepositoryError } from "../src/domain/queue-repository.js";
import {
  isHumanSeatSession,
  validateHumanRoute,
} from "../src/domain/human-route-enforcer.js";

describe("human-route-enforcer（纯校验器）", () => {
  it("§5 谓词分支 1：tier=human-gate 会路由给人类", () => {
    const r = validateHumanRoute({ tier: "human-gate", destinationSession: "b@rig", summary: "s", evidenceRef: "e" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.humanRouted).toBe(true);
  });

  it("§5 谓词分支 2：human-seat 目的地会路由给人类（严格正则）", () => {
    expect(isHumanSeatSession("human@kernel")).toBe(true);
    expect(isHumanSeatSession("human@host")).toBe(true);
    expect(isHumanSeatSession("human-review@kernel")).toBe(true);
    // 格式错误或近似匹配的 session 不是 human seat（不使用 LIKE 超集）：
    expect(isHumanSeatSession("human-@kernel")).toBe(false);
    expect(isHumanSeatSession("human-ish@other-rig")).toBe(false);
    expect(isHumanSeatSession("superhuman@kernel")).toBe(false);
    expect(isHumanSeatSession(null)).toBe(false);
  });

  it("路由给人类时两个字段均缺失 → 错误会列出两个字段及原因", () => {
    const r = validateHumanRoute({ tier: "human-gate", destinationSession: "b@rig", summary: null, evidenceRef: null });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("human_route_fields_required");
      expect(r.missingFields).toEqual(["summary", "evidence_ref"]);
      expect(r.message).toContain("自然语言");
      expect(r.message).toContain("判断");
    }
  });

  it("仅含空白字符的值视为缺失", () => {
    const r = validateHumanRoute({ tier: null, destinationSession: "human@kernel", summary: "   ", evidenceRef: "\t" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missingFields).toEqual(["summary", "evidence_ref"]);
  });

  it("BR-1：未路由给人类的请求不校验任何字段（无论字段如何都通过）", () => {
    const r = validateHumanRoute({ tier: "critical", destinationSession: "guard@rig", summary: null, evidenceRef: null });
    expect(r).toEqual({ ok: true, humanRouted: false });
  });
});

describe("QueueRepository 人类路由强制规则接线（FR-4/FR-5）", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueItemSummarySchema, queueItemEvidenceRefSchema]);
    repo = new QueueRepository(db, new EventBus(db));
  });

  afterEach(() => db.close());

  const ordinary = { sourceSession: "a@rig", destinationSession: "b@rig", body: "工作", nudge: false as const };

  it("create 到 human seat 但缺少 summary/evidence_ref 时，以结构化错误拒绝", async () => {
    await expect(
      repo.create({ sourceSession: "pm@rig", destinationSession: "human-review@kernel", body: "判断", nudge: false })
    ).rejects.toMatchObject({ code: "human_route_fields_required" });
  });

  it("create 使用 tier=human-gate 但缺少字段时会被拒绝", async () => {
    await expect(
      repo.create({ ...ordinary, tier: "human-gate" })
    ).rejects.toThrow(QueueRepositoryError);
  });

  it("路由给人类的 create 同时提供两个字段时会被接受并持久化", async () => {
    const item = await repo.create({
      sourceSession: "pm@rig",
      destinationSession: "human-review@kernel",
      body: "判断",
      summary: "批准 0.4.4 版本",
      evidenceRef: "missions/x/PROOF.md",
      nudge: false,
    });
    expect(item.summary).toBe("批准 0.4.4 版本");
    expect(item.evidenceRef).toBe("missions/x/PROOF.md");
  });

  it("handoff 到 human seat 要求新 item 自带字段（绝不继承）", async () => {
    const src = await repo.create({
      ...ordinary,
      summary: "来源摘要",
      evidenceRef: "proof/source.md",
    });
    // 来源 item 已有两个字段，但 handoff 未提供 → 仍会被拒绝。
    await expect(
      repo.handoff({ qitemId: src.qitemId, fromSession: "b@rig", toSession: "human-review@kernel", nudge: false })
    ).rejects.toMatchObject({ code: "human_route_fields_required" });
    // 在 handoff 本身提供这两个字段即可成功。
    const result = await repo.handoff({
      qitemId: src.qitemId,
      fromSession: "b@rig",
      toSession: "human-review@kernel",
      summary: "请批准",
      evidenceRef: "proof/final.md",
      nudge: false,
    });
    expect(result.created.summary).toBe("请批准");
    expect(result.created.evidenceRef).toBe("proof/final.md");
  });

  it("handoff 从来源继承 human-gate tier 时也会触发强制规则", async () => {
    const src = await repo.create({
      ...ordinary,
      tier: "human-gate",
      summary: "s",
      evidenceRef: "e.md",
    });
    // handoff 未覆盖 tier → 新 item 继承 human-gate → 触发强制规则。
    await expect(
      repo.handoff({ qitemId: src.qitemId, fromSession: "b@rig", toSession: "c@rig", nudge: false })
    ).rejects.toMatchObject({ code: "human_route_fields_required" });
  });

  it("handoffAndComplete 到 human seat 时执行相同的强制规则", async () => {
    const src = await repo.create(ordinary);
    await expect(
      repo.handoffAndComplete({ qitemId: src.qitemId, fromSession: "b@rig", toSession: "human@kernel", nudge: false })
    ).rejects.toMatchObject({ code: "human_route_fields_required" });
  });

  // ——— BR-1 零摩擦反例（guard 的验证目标）———

  it("反例：普通 create 缺少 summary/evidence_ref 时仍与此前一样被接受", async () => {
    const item = await repo.create(ordinary);
    expect(item.state).toBe("pending");
    expect(item.summary).toBeNull();
    expect(item.evidenceRef).toBeNull();
  });

  it("反例：普通 handoff 缺少字段时仍被接受，不新增拒绝路径", async () => {
    const src = await repo.create(ordinary);
    const result = await repo.handoff({ qitemId: src.qitemId, fromSession: "b@rig", toSession: "c@rig", nudge: false });
    expect(result.created.state).toBe("pending");
    expect(result.created.summary).toBeNull();
    expect(result.created.evidenceRef).toBeNull();
  });

  it("反例：普通 update/close 路径不新增要求（关闭契约不变）", async () => {
    const item = await repo.create(ordinary);
    repo.claim({ qitemId: item.qitemId, destinationSession: "b@rig" });
    const done = repo.update({
      qitemId: item.qitemId,
      actorSession: "b@rig",
      state: "done",
      closureReason: "no-follow-on",
    });
    expect(done.state).toBe("done");
  });

  it("反例：近似目的地（正则不匹配）不执行强制规则", async () => {
    const item = await repo.create({ ...ordinary, destinationSession: "human-ish@other-rig" });
    expect(item.state).toBe("pending");
    const item2 = await repo.create({ ...ordinary, destinationSession: "human-@kernel" });
    expect(item2.state).toBe("pending");
  });
});

describe("FR-6 park-on-human（第 1 阶段）——强制规则、持久化与 attention", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueItemSummarySchema, queueItemEvidenceRefSchema]);
    repo = new QueueRepository(db, new EventBus(db));
  });

  afterEach(() => db.close());

  async function inProgressItem() {
    const item = await repo.create({
      sourceSession: "orch@rig",
      destinationSession: "driver@rig",
      body: "构建目标",
      nudge: false,
    });
    repo.claim({ qitemId: item.qitemId, destinationSession: "driver@rig" });
    return item;
  }

  it("park 到 human seat 时提供 summary + evidence_ref 会成功、保留归属、不要求 closure_reason，并持久化两个字段", async () => {
    const item = await inProgressItem();
    const parked = repo.update({
      qitemId: item.qitemId,
      actorSession: "driver@rig",
      state: "blocked",
      blockedOn: "human-review@kernel",
      summary: "应发布哪一条 hook-trust 时序规则？",
      evidenceRef: "missions/x/slices/y/OPTIONS.md",
    });
    expect(parked.state).toBe("blocked");
    expect(parked.destinationSession).toBe("driver@rig"); // owner 继续持有 hot potato
    expect(parked.closureReason).toBeNull();              // 非终态
    const read = repo.getById(item.qitemId)!;
    expect(read.summary).toBe("应发布哪一条 hook-trust 时序规则？");
    expect(read.evidenceRef).toBe("missions/x/slices/y/OPTIONS.md");
  });

  it("park 到 human seat 但缺少 summary/evidence_ref 时会被拒绝，并列出两个字段", async () => {
    const item = await inProgressItem();
    expect(() =>
      repo.update({
        qitemId: item.qitemId,
        actorSession: "driver@rig",
        state: "blocked",
        blockedOn: "human-review@kernel",
      })
    ).toThrow(/summary \+ evidence_ref|summary/);
    try {
      repo.update({ qitemId: item.qitemId, actorSession: "driver@rig", state: "blocked", blockedOn: "human-review@kernel" });
    } catch (err) {
      expect((err as QueueRepositoryError).code).toBe("human_route_fields_required");
      expect((err as QueueRepositoryError).meta?.missingFields).toEqual(["summary", "evidence_ref"]);
    }
  });

  it("已携带两个字段的 item 无需重复输入即可 park（生效值规则）", async () => {
    const item = await repo.create({
      sourceSession: "orch@rig",
      destinationSession: "driver@rig",
      body: "b",
      summary: "从 create 携带",
      evidenceRef: "proof/carried.md",
      nudge: false,
    });
    repo.claim({ qitemId: item.qitemId, destinationSession: "driver@rig" });
    const parked = repo.update({
      qitemId: item.qitemId,
      actorSession: "driver@rig",
      state: "blocked",
      blockedOn: "human@kernel",
    });
    expect(parked.state).toBe("blocked");
  });

  it("parked-on-human item 会由 attention 查询返回（谓词第 3 个分支）", async () => {
    const item = await inProgressItem();
    repo.update({
      qitemId: item.qitemId,
      actorSession: "driver@rig",
      state: "blocked",
      blockedOn: "human-review@kernel",
      summary: "待作决策",
      evidenceRef: "proof/x.md",
    });
    const attention = repo.listAttention();
    expect(attention.map((q) => q.qitemId)).toContain(item.qitemId);
  });

  it("反例：阻塞于另一个 qitem 不新增要求，也不会出现在 attention 中", async () => {
    const blocker = await repo.create({ sourceSession: "a@rig", destinationSession: "b@rig", body: "阻塞项", nudge: false });
    const item = await inProgressItem();
    const parked = repo.update({
      qitemId: item.qitemId,
      actorSession: "driver@rig",
      state: "blocked",
      blockedOn: blocker.qitemId,
    });
    expect(parked.state).toBe("blocked");
    const attention = repo.listAttention();
    expect(attention.map((q) => q.qitemId)).not.toContain(item.qitemId);
  });

  it("queue.updated 事件携带 park 时的 summary（FR-1 × FR-6，P2 刷新契约）", async () => {
    const bus = new EventBus(db);
    const repo2 = new QueueRepository(db, bus);
    const captured: Array<Record<string, unknown>> = [];
    bus.subscribe((e) => captured.push(e as unknown as Record<string, unknown>));
    const item = await repo2.create({ sourceSession: "a@rig", destinationSession: "d@rig", body: "b", nudge: false });
    repo2.update({
      qitemId: item.qitemId,
      actorSession: "d@rig",
      state: "blocked",
      blockedOn: "human@kernel",
      summary: "park 时的摘要",
      evidenceRef: "proof/p.md",
    });
    const ev = captured.find((e) => e.type === "queue.updated");
    expect(ev).toBeDefined();
    expect(ev!.summary).toBe("park 时的摘要");
    expect(ev!.toState).toBe("blocked");
  });

  // OPR.0.5.1 slice-51-06 D2：过去会静默丢弃非 park 的 summary/evidence（数据丢失陷阱）；
  // 现在会在任何变更前直接拒绝。接口面仍保持收紧（非 park item 不持久化任何内容），
  // 但现在会明确拒绝，而不是静默处理。
  it("反例：非 park 更新拒绝 summary/evidence_ref 输入（明确保持收紧的接口面）", async () => {
    const item = await inProgressItem();
    let err: unknown;
    try {
      repo.update({
        qitemId: item.qitemId,
        actorSession: "driver@rig",
        state: "in-progress",
        summary: "不应持久化",
        evidenceRef: "should-not-persist.md",
      });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(QueueRepositoryError);
    expect((err as QueueRepositoryError).code).toBe("summary_evidence_not_persistable");
    expect((err as QueueRepositoryError).meta?.invalidFields).toEqual(["summary", "evidenceRef"]);
    const read = repo.getById(item.qitemId)!;
    expect(read.summary).toBeNull(); // 未持久化任何内容（在写入前已拒绝）
    expect(read.evidenceRef).toBeNull();
  });
});
