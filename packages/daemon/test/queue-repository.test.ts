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
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { occupantGenerationStampsSchema } from "../src/db/migrations/063_occupant_generation_stamps.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import {
  QueueRepository,
  QueueRepositoryError,
  classifyNudgeFailure,
} from "../src/domain/queue-repository.js";
import { CLOSURE_REASONS } from "../src/domain/hot-potato-enforcer.js";
import type { PersistedEvent } from "../src/domain/types.js";

describe("QueueRepository", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;
  let captured: PersistedEvent[];

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, outboxEntriesSchema]);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus);
    // W1 MF2：旨在 nudge 的 terminal handoff 现在要求已接入 wake-intent store（生产环境总会在
    // 启动时接入）——harness 中保持一致。
    repo.attachOutbox(new OutboxHandler(db));
    captured = [];
    bus.subscribe((e) => captured.push(e));
  });

  afterEach(() => db.close());

  it("create 写入 qitem_id、transition 与 queue.created event", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig-a",
      destinationSession: "bob@rig-b",
      body: "do the thing",
    });
    expect(item.qitemId).toMatch(/^qitem-\d{14}-[a-f0-9]{8}$/);
    expect(item.state).toBe("pending");
    expect(item.priority).toBe("routine");
    expect(captured.some((e) => e.type === "queue.created")).toBe(true);
    const transitions = repo.transitionLog.listForQitem(item.qitemId);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.state).toBe("pending");
  });

  // 0.5.1-54 DR-1——呈现 create 路径上 failed-nudge 的悬挂项。last_nudge_result 被写入却从不查询，
  // 因此 nudge 失败（`failed:<msg>`）的 create 不可见（sender 以为投递成功，destination 却从未被
  // 唤醒）。findUndelivered 准确呈现该类别：state='pending' 且 last_nudge_result LIKE 'failed:%'。
  // 仅限 V1、无 false positive 模式——delivered row 与从未尝试（NULL）的 cold park 都会排除；
  // never-attempted 类别继续推迟到未来的 create-time intent bit（FP 主导）。DR-1 只读取
  //（不重试、不回滚）。
  it("DR-1 findUndelivered：呈现 pending failed:% 悬挂项，排除 delivered 与 never-attempted", async () => {
    const failed = await repo.create({ sourceSession: "a@rig", destinationSession: "b@rig", body: "failed nudge" });
    repo.recordNudgeAttempt(failed.qitemId, "failed:Session 'b@rig' not found");
    const delivered = await repo.create({ sourceSession: "a@rig", destinationSession: "b@rig", body: "delivered" });
    repo.recordNudgeAttempt(delivered.qitemId, "verified");
    // never-attempted：此 harness 没有 transport → maybeNudge no-op → last_nudge_result 保持 NULL。
    const neverAttempted = await repo.create({ sourceSession: "a@rig", destinationSession: "b@rig", body: "cold park" });
    const ids = repo.findUndelivered().map((s) => s.qitemId);
    expect(ids, "(a) 呈现 failed-nudge 悬挂项").toContain(failed.qitemId);
    expect(ids, "(b) 仅限 V1：不呈现 delivered row").not.toContain(delivered.qitemId);
    expect(ids, "(b) 不呈现 never-attempted（NULL）cold park").not.toContain(neverAttempted.qitemId);
    // (c) nudge 不回滚不变量：DR-1 只读取——呈现悬挂项不得改变它。
    const after = repo.getById(failed.qitemId)!;
    expect(after.state, "(c) 呈现不会回滚/关闭持久 row").toBe("pending");
    expect(after.lastNudgeResult, "(c) 读取不改变 failure record").toContain("failed:");
  });

  // 0.5.1-54 DR-1 classifier fold（PM 裁定）——将悬挂项标为 transient 或 permanent-topology，使
  // 计数可采取行动。permanent-topology = destination 在此 daemon 上不可解析（"not found"），应路由
  // 到 addressing family，而非重试。transient = live seat 拒绝本次尝试。
  it("DR-1 classifyNudgeFailure：三个正向类别 + null；无法识别的失败为 UNKNOWN，绝不静默归为 transient", () => {
    expect(classifyNudgeFailure("failed:Session 'operator-agent@kernel' not found. Check available sessions"), "not-found = 无法在此 daemon 上解析").toBe("permanent-topology");
    expect(classifyNudgeFailure("failed:Refused: 'orch-advisor@v-openrig-build' is at an interactive prompt"), "live seat 拒绝本次尝试属于 transient").toBe("transient");
    expect(classifyNudgeFailure("failed:timeout after 5000ms"), "可解析 seat 的 timeout 属于 transient").toBe("transient");
    // ship-block 断言（PM 裁定）：无法识别的失败文本不属于任何已知类别。不得折叠为 transient
    //（那会声称文本并不支持的结论）。若之后有人再次把未匹配用例默认为已知类别，此处会失败。
    expect(classifyNudgeFailure("failed:ECONNRESET writing to socket"), "无法识别的失败为 unknown，而非静默 transient").toBe("unknown");
    expect(classifyNudgeFailure("failed:"), "无详情的裸 failure 为 unknown，而非 transient").toBe("unknown");
    expect(classifyNudgeFailure("verified"), "已投递结果不是 failure").toBeNull();
    expect(classifyNudgeFailure(null), "无 nudge record 不是 failure").toBeNull();
  });

  it("validateRig 拒绝时，create 拒绝未知 rig", async () => {
    const strictRepo = new QueueRepository(db, bus, {
      validateRig: (s) => s.endsWith("@known-rig"),
    });
    await expect(
      strictRepo.create({
        sourceSession: "alice@known-rig",
        destinationSession: "bob@phantom-rig",
        body: "x",
      })
    ).rejects.toThrow(/未知 rig/);
  });

  it("claim 将 pending 转为 in-progress，并依据 tier 计算 closure_required_at", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
      tier: "fast",
    });
    const claimed = repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    expect(claimed.state).toBe("in-progress");
    expect(claimed.claimedAt).toBeTruthy();
    expect(claimed.closureRequiredAt).toBeTruthy();
    expect(captured.some((e) => e.type === "queue.claimed")).toBe(true);
  });

  it("claim 拒绝不匹配的 destination", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    expect(() => repo.claim({ qitemId: item.qitemId, destinationSession: "carol@rig" })).toThrow(
      /destination/
    );
  });

  it("R2：update 发出包含 fromState、toState 与 closure metadata 的 queue.updated event", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    captured.length = 0;
    repo.update({
      qitemId: item.qitemId,
      actorSession: "bob@rig",
      state: "done",
      closureReason: "no-follow-on",
      transitionNote: "wrapping up",
    });
    const updateEvents = captured.filter((e) => e.type === "queue.updated");
    expect(updateEvents).toHaveLength(1);
    const evt = updateEvents[0]! as {
      qitemId: string;
      fromState: string;
      toState: string;
      closureReason: string | null;
      closureTarget: string | null;
      actorSession: string;
    };
    expect(evt.qitemId).toBe(item.qitemId);
    expect(evt.fromState).toBe("in-progress");
    expect(evt.toState).toBe("done");
    expect(evt.closureReason).toBe("no-follow-on");
    expect(evt.actorSession).toBe("bob@rig");
  });

  it("R2：update 为 blocked transition 发出 queue.updated（fromState=pending、toState=blocked）", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    captured.length = 0;
    repo.update({
      qitemId: item.qitemId,
      actorSession: "bob@rig",
      state: "blocked",
      transitionNote: "blocked on dep",
    });
    const evt = captured.find((e) => e.type === "queue.updated") as { fromState: string; toState: string } | undefined;
    expect(evt).toBeDefined();
    expect(evt!.fromState).toBe("pending");
    expect(evt!.toState).toBe("blocked");
  });

  // 0.5.1-53 Atom 1b(i)——退出时清除。根因：update SET 写入
  // `blocked_on = COALESCE(?, blocked_on)`，因此退出 `blocked`（input.blockedOn=null）会保留旧 blocker。
  // 非 blocked row 绝不能携带 blocker——陈旧 blocked_on 是 dead-blocker 悬挂项（没有任何内容审计它；
  // desk 曾在这种 blocker 上停滞数小时）。
  it("Atom 1b(i)：退出 blocked 时清除 blocked_on（无陈旧 dead-blocker）", async () => {
    const blocker = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "blocker" });
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "work" });
    // 将它停放在 blocker qitem 上。
    repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "blocked", blockedOn: blocker.qitemId });
    expect(repo.getById(item.qitemId)!.blockedOn).toBe(blocker.qitemId);
    // 退出 blocked（unpark）。基线为 RED：blocked_on 仍读到 blocker（COALESCE 保留了它）。
    repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "in-progress" });
    expect(repo.getById(item.qitemId)!.blockedOn, "非 blocked row 不得携带 blocker").toBeNull();
  });

  // 0.5.1-53 Atom 1b(ii)——停放时校验。停放在 QITEM 引用 blocker 上时必须点名真实、live 的 blocker；
  // 不存在或 terminal blocker 是永远无法自行清除的 dead-blocker 停放项（正是那些 21-22 天悬挂项）。
  // 仅适用于 qitem ref（"qitem-…"）：这里不校验 human-seat blocker（member@rig）或裸 gate name
  //（"external-gate"，由 Atom 1a 处理）。
  it("Atom 1b(ii)：停放在不存在的 qitem blocker 上会被显著拒绝", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "work" });
    try {
      repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "blocked", blockedOn: "qitem-19990101000000-deadbeef" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueueRepositoryError);
      expect((err as QueueRepositoryError).code).toBe("blocker_not_found");
    }
  });

  it("Atom 1b(ii)：停放在 terminal（done）qitem blocker 上会被显著拒绝", async () => {
    const blocker = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "blocker" });
    repo.claim({ qitemId: blocker.qitemId, destinationSession: "bob@rig" });
    repo.update({ qitemId: blocker.qitemId, actorSession: "bob@rig", state: "done", closureReason: "no-follow-on" });
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "work" });
    try {
      repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "blocked", blockedOn: blocker.qitemId });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueueRepositoryError);
      expect((err as QueueRepositoryError).code).toBe("blocker_not_live");
    }
  });

  // 0.5.1-53 Atom 1b(iii)——传播完成。blocked_on 承诺“A 等待 B 完成”；该承诺曾从未触发
  //（desk 在已 done blocker 上停滞数小时）。当 B 到达 terminal state 时，阻塞于它的 row 必须
  // 自动 unpark——这是 blocked_on 语义始终应履行的义务。
  it("Atom 1b(iii)：blocker 进入 terminal 时自动 unpark 阻塞于它的 row", async () => {
    const blocker = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "blocker" });
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "work" });
    repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "blocked", blockedOn: blocker.qitemId });
    expect(repo.getById(item.qitemId)!.state).toBe("blocked");
    // 完成 blocker。
    repo.claim({ qitemId: blocker.qitemId, destinationSession: "bob@rig" });
    repo.update({ qitemId: blocker.qitemId, actorSession: "bob@rig", state: "done", closureReason: "no-follow-on" });
    // 1b(ii) 时为 RED：blocked row 永久保持 blocked（completion 从未传播）。
    const after = repo.getById(item.qitemId)!;
    expect(after.state, "阻塞于现已 terminal blocker 的 row 必须自动 unpark").toBe("pending");
    expect(after.blockedOn, "auto-unpark 清除现已解决的 blocker").toBeNull();
  });

  // 0.5.1-53 Atom 1a——有类型的非 qitem blocker 契约。由 fold/auth/external 条件约束的停放项
  //（既非 qitem，也非 human seat）是一等 blocker，例如 `fold:<what>`。它在 compact 视图中可见
  //（blocked_on 会进入 compact projection），可在 PARK 时刻设置，且裁定详情随 transition 携带。
  // 接受格式正确的 typed blocker；显著拒绝格式错误者（只有前缀、没有 gate body），避免拼写错误
  // 伪装成 gate。
  it("Atom 1a：接受格式正确且清晰可读的 typed non-qitem blocker（fold:）", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "gated work" });
    repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "blocked", blockedOn: "fold:one-home+attestation" });
    const row = repo.getById(item.qitemId)!;
    expect(row.state).toBe("blocked");
    expect(row.blockedOn, "typed gate 在 row 上清晰可读（由 compact 携带）").toBe("fold:one-home+attestation");
  });

  it("Atom 1a：格式错误的 typed blocker（裸前缀、空 body）会被显著拒绝", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "gated work" });
    try {
      repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "blocked", blockedOn: "fold:" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueueRepositoryError);
      expect((err as QueueRepositoryError).code).toBe("blocker_malformed");
    }
  });

  // 0.5.1-53 Atom 2a——supersession-cancel 是允许形式。通过 cancel-and-replace 修正的 row 必须记录
  // 它已被 SUPERSEDED（reason=superseded + target=successor），而不能看起来像 abandoned。目前
  // closure-coherence allowlist 只允许 done / park-record / handoff-close 带 reason/target，所以
  // state=canceled + reason 会被拒绝（closure_fields_not_admitted）——这正是 superseded row 与
  // abandoned row 无法区分的原因（二者 closureReason 均为 null）。
  it("Atom 2a：允许并记录 supersession-cancel（canceled + reason=superseded + target）", async () => {
    const successor = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "successor" });
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "original" });
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    repo.update({
      qitemId: item.qitemId, actorSession: "bob@rig", state: "canceled",
      closureReason: "superseded", closureTarget: successor.qitemId,
    });
    const row = repo.getById(item.qitemId)!;
    expect(row.state).toBe("canceled");
    expect(row.closureReason, "superseded row 会记录此原因（非 null，可与 abandoned 区分）").toBe("superseded");
    expect(row.closureTarget).toBe(successor.qitemId);
  });

  it("Atom 2a：普通 cancel（无 reason）保持 abandoned——closureReason 为 null", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "abandon me" });
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "canceled" });
    expect(repo.getById(item.qitemId)!.closureReason, "abandoned = 无 supersession reason").toBeNull();
  });

  it("Atom 2a：superseded 但无 successor target 时被显著拒绝（不静默 no-op）", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "orig" });
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    try {
      repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "canceled", closureReason: "superseded" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueueRepositoryError);
      expect((err as QueueRepositoryError).code).toBe("missing_closure_target");
    }
    // 显著拒绝不得只应用一半：row 保持原状（in-progress），而非 canceled。
    expect(repo.getById(item.qitemId)!.state, "被拒绝的 close 不得静默改变 row").toBe("in-progress");
  });

  // 0.5.1-53 Atom 2b——supersession 回链。cancel-and-replace 不得产生无关联 orphan pair：successor
  // 记录 handedOffFrom = original，使 reader 可从 successor 回溯到被替换项（proof e）。结合 2a 的
  // 前向 link（original.closureTarget = successor），supersession 可双向完整遍历，且绝不会显示为
  // abandonment。
  it("Atom 2b：supersession successor 记录 handedOffFrom = original（双向 link 均存在）", async () => {
    const original = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "original (metadata wrong)" });
    const successor = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "corrected", handedOffFrom: original.qitemId });
    expect(successor.handedOffFrom, "successor -> original 回链").toBe(original.qitemId);
    // 将 original supersede 到 successor（2a 前向 link）。
    repo.claim({ qitemId: original.qitemId, destinationSession: "bob@rig" });
    repo.update({ qitemId: original.qitemId, actorSession: "bob@rig", state: "canceled", closureReason: "superseded", closureTarget: successor.qitemId });
    const orig = repo.getById(original.qitemId)!;
    expect(orig.closureReason, "superseded，而非 abandoned").toBe("superseded");
    expect(orig.closureTarget, "original -> successor 前向 link").toBe(successor.qitemId);
    expect(repo.getById(successor.qitemId)!.handedOffFrom, "successor -> original 回链").toBe(original.qitemId);
  });

  it("update state=done 但无 closure_reason 时以 missing_closure_reason 拒绝", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    try {
      repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "done" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QueueRepositoryError);
      const e = err as QueueRepositoryError;
      expect(e.code).toBe("missing_closure_reason");
      expect((e.meta?.validReasons as readonly string[])).toEqual(CLOSURE_REASONS);
    }
  });

  it("update 接受 6 个有效 closure reason 中的每一个", async () => {
    for (const reason of CLOSURE_REASONS) {
      const item = await repo.create({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: `for ${reason}`,
      });
      repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
      const requiresTarget = reason === "handed_off_to" || reason === "blocked_on" || reason === "escalation";
      const closed = repo.update({
        qitemId: item.qitemId,
        actorSession: "bob@rig",
        state: "done",
        closureReason: reason,
        closureTarget: requiresTarget ? "downstream-target" : undefined,
      });
      expect(closed.state).toBe("done");
      expect(closed.closureReason).toBe(reason);
    }
  });

  it("handoff 具有事务性：将 source 闭合为 handed-off 并创建新 qitem", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "do it",
    });
    const result = await repo.handoff({
      qitemId: item.qitemId,
      fromSession: "bob@rig",
      toSession: "carol@rig",
      transitionNote: "specialty needed",
    });
    expect(result.closed.state).toBe("handed-off");
    expect(result.closed.closureReason).toBe("handed_off_to");
    expect(result.closed.handedOffTo).toBe("carol@rig");
    expect(result.created.state).toBe("pending");
    expect(result.created.handedOffFrom).toBe(item.qitemId);
    expect(result.created.destinationSession).toBe("carol@rig");
    expect(result.created.chainOfRecord).toEqual([item.qitemId]);

    expect(captured.filter((e) => e.type === "queue.handed_off")).toHaveLength(1);
    expect(captured.filter((e) => e.type === "queue.created")).toHaveLength(2); // create + handoff-create
  });

  it("handoff 拒绝已 terminal 的 qitem", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    repo.update({
      qitemId: item.qitemId,
      actorSession: "bob@rig",
      state: "done",
      closureReason: "no-follow-on",
    });
    await expect(
      repo.handoff({
        qitemId: item.qitemId,
        fromSession: "bob@rig",
        toSession: "carol@rig",
      })
    ).rejects.toThrow(/terminal/);
  });

  it("transition 仅追加——每次状态变化都会添加一行", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    repo.unclaim(item.qitemId, "bob@rig", "lunch");
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    repo.update({
      qitemId: item.qitemId,
      actorSession: "bob@rig",
      state: "done",
      closureReason: "no-follow-on",
    });
    const transitions = repo.transitionLog.listForQitem(item.qitemId);
    expect(transitions.map((t) => t.state)).toEqual([
      "pending",
      "in-progress",
      "pending",
      "in-progress",
      "done",
    ]);
  });

  it("findOverdue 呈现超过 closure_required_at 的 in-progress qitem", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
      tier: "fast",
    });
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    // Slice-15 契约：findOverdue 接受 OPTIONS OBJECT（runtime caller routes/queue.ts 使用的形态）——
    // 旧位置 timestamp 不是受支持 API（broad-suite-residue atom 1）。
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const overdue = repo.findOverdue({ now: future });
    expect(overdue.map((q) => q.qitemId)).toContain(item.qitemId);
    // scoped/bounded 判别：不匹配任何内容的 rig scope 返回空，limit 限制结果——options 会生效而非忽略。
    expect(repo.findOverdue({ now: future, rig: "no-such-rig" })).toEqual([]);
    expect(repo.findOverdue({ now: future, limit: 1 }).length).toBeLessThanOrEqual(1);
  });

  it("routeToFallback 发出 qitem.fallback_routed 并重写 destination", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    const rerouted = repo.routeToFallback(item.qitemId, "pod-fallback@rig", "seat-unreachable");
    expect(rerouted.destinationSession).toBe("pod-fallback@rig");
    expect(rerouted.chainOfRecord).toEqual(["fallback-from:bob@rig"]);
    expect(captured.some((e) => e.type === "qitem.fallback_routed")).toBe(true);
  });

  it("list 按 destination 与 state 过滤", async () => {
    const a = await repo.create({ sourceSession: "x@r", destinationSession: "bob@r", body: "1" });
    await repo.create({ sourceSession: "x@r", destinationSession: "carol@r", body: "2" });
    await repo.create({ sourceSession: "x@r", destinationSession: "bob@r", body: "3" });
    repo.claim({ qitemId: a.qitemId, destinationSession: "bob@r" });

    expect(repo.list({ destinationSession: "bob@r" })).toHaveLength(2);
    expect(repo.list({ destinationSession: "bob@r", state: "in-progress" })).toHaveLength(1);
    expect(repo.list({ destinationSession: "bob@r", state: ["pending", "in-progress"] })).toHaveLength(2);
  });

  // ---- PL-004 阶段 A revision（R1）测试 ----

  describe("R1 默认 nudge 接线", () => {
    it("create 默认 nudge destination，并持久化 last_nudge_attempt 与 last_nudge_result", async () => {
      const sends: Array<{ session: string; text: string }> = [];
      const stubTransport = {
        send: async (sessionName: string, text: string) => {
          sends.push({ session: sessionName, text });
          return { ok: true, verified: true };
        },
      };
      const nudgingRepo = new QueueRepository(db, bus, { transport: stubTransport });
      const item = await nudgingRepo.create({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: "ping me",
      });
      expect(sends).toHaveLength(1);
      expect(sends[0]!.session).toBe("bob@rig");
      expect(sends[0]!.text).toContain(item.qitemId);
      const fresh = nudgingRepo.getById(item.qitemId)!;
      expect(fresh.lastNudgeAttempt).not.toBeNull();
      expect(fresh.lastNudgeResult).toBe("verified");
    });

    it("(h) HG-5 基线：handoff nudge 现在携带 Sent: 时间戳与 source gen suffix，并将 stampISO 传入 send", async () => {
      const sends: Array<{ session: string; text: string; opts?: { verify?: boolean; stampISO?: string } }> = [];
      const stubTransport = {
        send: async (session: string, text: string, opts?: { verify?: boolean; stampISO?: string }) => {
          sends.push({ session, text, opts });
          return { ok: true, verified: true };
        },
      };
      const nudgingRepo = new QueueRepository(db, bus, {
        transport: stubTransport,
        resolveOccupantGeneration: (s) => (s === "alice@rig" ? "a1b2c3d4-e5f6-7890-abcd-ef0123456789" : null),
      });
      await nudgingRepo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "ping" });
      expect(sends).toHaveLength(1);
      const { text, opts } = sends[0]!;
      expect(text).toContain("\nSent: "); // 现在带时间戳（此前缺失——延后的 HG-5 变更在此落地）。
      expect(text).toContain(" · gen a1b2c3d4"); // source seat 的 generation 随 g 的渲染携带。
      expect(opts?.stampISO).toBeDefined(); // 完成传递，使 transport 的 delivered-latency flag 生效。
    });

    it("(h) 缺少 resolver ⇒ nudge 带时间戳但省略 gen suffix（UNKNOWN，绝不伪造）", async () => {
      const sends: string[] = [];
      const stubTransport = {
        send: async (_s: string, text: string) => { sends.push(text); return { ok: true, verified: true }; },
      };
      const nudgingRepo = new QueueRepository(db, bus, { transport: stubTransport }); // 未接入 resolver。
      await nudgingRepo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "ping" });
      expect(sends[0]).toContain("\nSent: ");
      expect(sends[0]).not.toContain(" · gen ");
    });

    it("create 使用 nudge:false 时不调用 transport（cold-queue opt-out）", async () => {
      const sends: Array<{ session: string; text: string }> = [];
      const stubTransport = {
        send: async (sessionName: string, text: string) => {
          sends.push({ session: sessionName, text });
          return { ok: true };
        },
      };
      const nudgingRepo = new QueueRepository(db, bus, { transport: stubTransport });
      const item = await nudgingRepo.create({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: "cold",
        nudge: false,
      });
      expect(sends).toHaveLength(0);
      const fresh = nudgingRepo.getById(item.qitemId)!;
      expect(fresh.lastNudgeAttempt).toBeNull();
      expect(fresh.lastNudgeResult).toBeNull();
    });

    it("nudge 失败记录为 failed:<reason>；create 仍成功", async () => {
      const stubTransport = {
        send: async () => ({ ok: false, error: "tmux pane not found" }),
      };
      const nudgingRepo = new QueueRepository(db, bus, { transport: stubTransport });
      const item = await nudgingRepo.create({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: "x",
      });
      const fresh = nudgingRepo.getById(item.qitemId)!;
      expect(fresh.lastNudgeResult).toMatch(/^failed:/);
      // item 本身正常创建——nudge 失败不会回滚 create。
      expect(fresh.state).toBe("pending");
    });

    // OPR.0.3.2.21.FR-4(c)——重命名已投递但 ack 过期用例的措辞。此前的 "sent-unverified" 即使
    // 底层投递正常也像部分失败；"delivered-ack-pending" 表达健康且符合预期的情况（任务执行中的
    // Codex seat 经常错过同步 ack 窗口）。
    it("ok 但未验证的 nudge 将 lastNudgeResult 记录为 'delivered-ack-pending'（原为 'sent-unverified'）", async () => {
      const stubTransport = {
        send: async () => ({ ok: true, verified: false }),
      };
      const nudgingRepo = new QueueRepository(db, bus, { transport: stubTransport });
      const item = await nudgingRepo.create({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: "delivered but ack window expired",
      });
      const fresh = nudgingRepo.getById(item.qitemId)!;
      expect(fresh.lastNudgeResult).toBe("delivered-ack-pending");
      // 判别条件：刚读取的 row 中任何位置都不得出现旧措辞（证明字面量已端到端重命名，而非仅遮蔽）。
      expect(fresh.lastNudgeResult).not.toBe("sent-unverified");
    });

    it("handoff 默认 nudge 新 destination", async () => {
      const sends: Array<{ session: string }> = [];
      const stubTransport = {
        send: async (sessionName: string) => {
          sends.push({ session: sessionName });
          return { ok: true, verified: true };
        },
      };
      const nudgingRepo = new QueueRepository(db, bus, { transport: stubTransport });
      nudgingRepo.attachOutbox(new OutboxHandler(db)); // W1 MF2：handoff 需要 wake-intent store。
      const original = await nudgingRepo.create({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: "x",
        nudge: false, // 抑制 create-time nudge，只统计 handoff。
      });
      const result = await nudgingRepo.handoff({
        qitemId: original.qitemId,
        fromSession: "bob@rig",
        toSession: "carol@rig",
      });
      expect(sends).toHaveLength(1);
      expect(sends[0]!.session).toBe("carol@rig");
      const fresh = nudgingRepo.getById(result.created.qitemId)!;
      expect(fresh.lastNudgeResult).toBe("verified");
    });

    it("attachTransport() 可在构造后工作（事后接线路径）", async () => {
      const repoNoTransport = new QueueRepository(db, bus);
      const sends: Array<{ session: string }> = [];
      const stubTransport = {
        send: async (s: string) => { sends.push({ session: s }); return { ok: true, verified: true }; },
      };
      // 第一次 create：无 transport，无 nudge。
      await repoNoTransport.create({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: "before",
      });
      expect(sends).toHaveLength(0);
      // attach 后再次 create。
      repoNoTransport.attachTransport(stubTransport);
      await repoNoTransport.create({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: "after",
      });
      expect(sends).toHaveLength(1);
    });
  });

  describe("R1 handoff-and-complete", () => {
    it("以 state=done、closure_reason=handed_off_to（terminal）关闭 source，并创建新 qitem", async () => {
      const original = await repo.create({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: "review then route",
      });
      const result = await repo.handoffAndComplete({
        qitemId: original.qitemId,
        fromSession: "bob@rig",
        toSession: "carol@rig",
        body: "carol's follow-on",
      });
      expect(result.closed.state).toBe("done"); // 不是 "handed-off"。
      expect(result.closed.closureReason).toBe("handed_off_to");
      expect(result.closed.handedOffTo).toBe("carol@rig");
      expect(result.created.state).toBe("pending");
      expect(result.created.handedOffFrom).toBe(original.qitemId);
      expect(result.created.destinationSession).toBe("carol@rig");
      expect(result.created.body).toBe("carol's follow-on");
      expect(result.created.chainOfRecord).toEqual([original.qitemId]);
    });

    it("拒绝已 terminal 的 qitem", async () => {
      const item = await repo.create({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: "x",
      });
      repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
      repo.update({
        qitemId: item.qitemId,
        actorSession: "bob@rig",
        state: "done",
        closureReason: "no-follow-on",
      });
      await expect(
        repo.handoffAndComplete({
          qitemId: item.qitemId,
          fromSession: "bob@rig",
          toSession: "carol@rig",
        })
      ).rejects.toThrow(/terminal/);
    });

    it("遵循 validateRig（拒绝未知 destination rig）", async () => {
      const strictRepo = new QueueRepository(db, bus, {
        validateRig: (s) => s.endsWith("@known-rig"),
      });
      const original = await strictRepo.create({
        sourceSession: "alice@known-rig",
        destinationSession: "bob@known-rig",
        body: "x",
      });
      await expect(
        strictRepo.handoffAndComplete({
          qitemId: original.qitemId,
          fromSession: "bob@known-rig",
          toSession: "carol@phantom-rig",
        })
      ).rejects.toThrow(/未知 rig/);
    });
  });

  describe("R1 whoami", () => {
    it("返回 destination session 的计数与最近 active qitem", async () => {
      const a = await repo.create({ sourceSession: "x@r", destinationSession: "bob@r", body: "1" });
      await repo.create({ sourceSession: "x@r", destinationSession: "bob@r", body: "2" });
      await repo.create({ sourceSession: "x@r", destinationSession: "carol@r", body: "3" });
      repo.claim({ qitemId: a.qitemId, destinationSession: "bob@r" });
      const whoami = repo.whoami("bob@r");
      expect(whoami.session).toBe("bob@r");
      expect(whoami.asDestination.pending).toBe(1);
      expect(whoami.asDestination.inProgress).toBe(1);
      expect(whoami.asDestination.recent).toHaveLength(2);
    });

    it("recent 排除 terminal-state qitem", async () => {
      const a = await repo.create({ sourceSession: "x@r", destinationSession: "bob@r", body: "1" });
      repo.claim({ qitemId: a.qitemId, destinationSession: "bob@r" });
      repo.update({ qitemId: a.qitemId, actorSession: "bob@r", state: "done", closureReason: "no-follow-on" });
      const whoami = repo.whoami("bob@r");
      expect(whoami.asDestination.pending).toBe(0);
      expect(whoami.asDestination.inProgress).toBe(0);
      expect(whoami.asDestination.recent).toHaveLength(0);
    });

    it("asSource.total 统计所有 source 侧 qitem，不受 state 影响", async () => {
      await repo.create({ sourceSession: "alice@r", destinationSession: "bob@r", body: "1" });
      await repo.create({ sourceSession: "alice@r", destinationSession: "carol@r", body: "2" });
      const item = await repo.create({ sourceSession: "alice@r", destinationSession: "dan@r", body: "3" });
      repo.claim({ qitemId: item.qitemId, destinationSession: "dan@r" });
      repo.update({ qitemId: item.qitemId, actorSession: "dan@r", state: "done", closureReason: "no-follow-on" });
      const whoami = repo.whoami("alice@r");
      expect(whoami.asSource.total).toBe(3);
    });
  });
});

describe("QueueRepository summary 列（OPR.0.4.1.18）", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = createDb();
    // 包含 migration 044，使 summary 列存在。（主套件有意省略它，以通过 guard 证明 pre-044
    // 降级路径。）
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueItemSummarySchema]);
    repo = new QueueRepository(db, new EventBus(db));
  });

  afterEach(() => db.close());

  it("create 时持久化 --summary，并通过 getById 往返读取", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "agent-speak body that is long and detailed",
      summary: "Wire the dashboard version row to the real daemon version.",
      nudge: false,
    });
    expect(item.summary).toBe("Wire the dashboard version row to the real daemon version.");
    expect(repo.getById(item.qitemId)?.summary).toBe(
      "Wire the dashboard version row to the real daemon version."
    );
  });

  it("省略 --summary 时 summary 为 null（降级契约）", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "no summary here",
      nudge: false,
    });
    expect(item.summary).toBeNull();
    expect(repo.getById(item.qitemId)?.summary).toBeNull();
  });

  it("handoff 持久化新 qitem 自己的 summary，而非从 source 继承", async () => {
    const src = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "source body",
      summary: "Source summary.",
      nudge: false,
    });
    const result = await repo.handoff({
      qitemId: src.qitemId,
      fromSession: "bob@rig",
      toSession: "carol@rig",
      summary: "Handoff summary for the new owner.",
      nudge: false,
    });
    expect(result.created.summary).toBe("Handoff summary for the new owner.");
    // 下一次 handoff 省略时 → null（降级），不从 source 继承。
    const result2 = await repo.handoff({
      qitemId: result.created.qitemId,
      fromSession: "carol@rig",
      toSession: "dan@rig",
      nudge: false,
    });
    expect(result2.created.summary).toBeNull();
  });
});

describe("queue.* event payload 携带 summary（OPR.0.4.4.19 FR-1）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;
  let captured: PersistedEvent[];

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueItemSummarySchema]);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus);
    captured = [];
    bus.subscribe((e) => captured.push(e));
  });

  afterEach(() => db.close());

  const eventOf = (type: string) =>
    captured.find((e) => e.type === type) as Record<string, unknown> | undefined;

  it("queue.created 携带所提供的 summary", async () => {
    await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "body",
      summary: "Approve the 0.4.4 cut",
      nudge: false,
    });
    const ev = eventOf("queue.created");
    expect(ev).toBeDefined();
    expect(ev!.summary).toBe("Approve the 0.4.4 cut");
  });

  it("每个 queue.* event 都携带 summary：省略时为 null——字段始终存在", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "no summary",
      nudge: false,
    });
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    repo.unclaim(item.qitemId, "bob@rig", "requeue");
    repo.update({
      qitemId: item.qitemId,
      actorSession: "bob@rig",
      state: "in-progress",
    });
    await repo.handoff({
      qitemId: item.qitemId,
      fromSession: "bob@rig",
      toSession: "carol@rig",
      nudge: false,
    });
    for (const type of [
      "queue.created",
      "queue.claimed",
      "queue.unclaimed",
      "queue.updated",
      "queue.handed_off",
    ]) {
      const ev = eventOf(type);
      expect(ev, `${type} 已发出`).toBeDefined();
      expect("summary" in ev!, `${type} payload 包含 summary key`).toBe(true);
      expect(ev!.summary, `${type} summary 为 null`).toBeNull();
    }
  });

  it("claim/unclaim/updated event 携带 row 的持久 summary；handed_off 携带 source summary，handoff 的 queue.created 携带新 summary", async () => {
    const item = await repo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "body",
      summary: "Source summary.",
      nudge: false,
    });
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    expect(eventOf("queue.claimed")!.summary).toBe("Source summary.");
    repo.unclaim(item.qitemId, "bob@rig", "requeue");
    expect(eventOf("queue.unclaimed")!.summary).toBe("Source summary.");
    repo.update({ qitemId: item.qitemId, actorSession: "bob@rig", state: "in-progress" });
    expect(eventOf("queue.updated")!.summary).toBe("Source summary.");
    captured.length = 0;
    await repo.handoff({
      qitemId: item.qitemId,
      fromSession: "bob@rig",
      toSession: "carol@rig",
      summary: "New owner summary.",
      nudge: false,
    });
    expect(eventOf("queue.handed_off")!.summary).toBe("Source summary.");
    expect(eventOf("queue.created")!.summary).toBe("New owner summary.");
  });

  it("旧版 pre-044 schema（无 summary 列）：event 仍携带值为 null 的 summary key", async () => {
    const legacyDb = createDb();
    migrate(legacyDb, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema]);
    const legacyBus = new EventBus(legacyDb);
    const legacyRepo = new QueueRepository(legacyDb, legacyBus);
    const legacyCaptured: PersistedEvent[] = [];
    legacyBus.subscribe((e) => legacyCaptured.push(e));
    await legacyRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "legacy",
      nudge: false,
    });
    const ev = legacyCaptured.find((e) => e.type === "queue.created") as Record<string, unknown>;
    expect("summary" in ev).toBe(true);
    expect(ev.summary).toBeNull();
    legacyDb.close();
  });
});

describe("queue_items.evidence_ref 列（OPR.0.4.4.19 FR-5 storage）", () => {
  let db: Database.Database;
  let repo: QueueRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, queueItemSummarySchema, queueItemEvidenceRefSchema]);
    repo = new QueueRepository(db, new EventBus(db));
  });

  afterEach(() => db.close());

  it("create 时持久化 --evidence-ref，并通过 getById 往返读取", async () => {
    const item = await repo.create({
      sourceSession: "pm@rig",
      destinationSession: "human-review@kernel",
      body: "please judge",
      summary: "Approve the 0.4.4 cut",
      evidenceRef: "missions/release-0.4.4/slices/19/PROOF.md",
      nudge: false,
    });
    expect(item.evidenceRef).toBe("missions/release-0.4.4/slices/19/PROOF.md");
    expect(repo.getById(item.qitemId)?.evidenceRef).toBe("missions/release-0.4.4/slices/19/PROOF.md");
  });

  it("省略时 evidence_ref 为 null（BR-1：普通 item 从不要求它）", async () => {
    const item = await repo.create({
      sourceSession: "a@rig",
      destinationSession: "b@rig",
      body: "ordinary agent-to-agent work",
      nudge: false,
    });
    expect(item.evidenceRef).toBeNull();
  });

  it("handoff 编写自己的 evidence_ref，不从 source 继承（summary 语义）", async () => {
    const src = await repo.create({
      sourceSession: "a@rig",
      destinationSession: "b@rig",
      body: "src",
      evidenceRef: "proof/source.md",
      nudge: false,
    });
    const result = await repo.handoff({
      qitemId: src.qitemId,
      fromSession: "b@rig",
      toSession: "c@rig",
      nudge: false,
    });
    expect(result.created.evidenceRef).toBeNull();
    const result2 = await repo.handoff({
      qitemId: result.created.qitemId,
      fromSession: "c@rig",
      toSession: "d@rig",
      evidenceRef: "proof/new.md",
      nudge: false,
    });
    expect(result2.created.evidenceRef).toBe("proof/new.md");
  });

  it("listAttention JSON 为 human-routed item 携带 evidence_ref（FR-5 read-path AC）", async () => {
    await repo.create({
      sourceSession: "pm@rig",
      destinationSession: "human-review@kernel",
      body: "judge me",
      summary: "s",
      evidenceRef: "proof/PROOF.md",
      nudge: false,
    });
    const attention = repo.listAttention();
    expect(attention).toHaveLength(1);
    expect(attention[0]!.evidenceRef).toBe("proof/PROOF.md");
  });

  it("旧版 pre-048 schema：evidenceRef 输入静默降级；读取值为 null", async () => {
    const legacyDb = createDb();
    migrate(legacyDb, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema]);
    const legacyRepo = new QueueRepository(legacyDb, new EventBus(legacyDb));
    const item = await legacyRepo.create({
      sourceSession: "a@rig",
      destinationSession: "b@rig",
      body: "legacy",
      evidenceRef: "proof/x.md",
      nudge: false,
    });
    expect(item.evidenceRef).toBeNull();
    legacyDb.close();
  });
});

// ── GHOST-STAGE（e/Class-B）：queue_items generation stamp + 切换时 release-to-pending ──
describe("QueueRepository——generation stamp（Class-B）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;
  let genBySession: Map<string, string | null>;

  beforeEach(() => {
    db = createDb();
    // 063 在同一 migration 中同时 ALTER queue_items 与 watchdog_jobs，因此 watchdog_jobs 也必须存在。
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, watchdogJobsSchema, occupantGenerationStampsSchema]);
    bus = new EventBus(db);
    genBySession = new Map();
    repo = new QueueRepository(db, bus, { resolveOccupantGeneration: (s) => genBySession.get(s) ?? null });
  });
  afterEach(() => db.close());

  const col = (qitemId: string, name: string): string | null =>
    (db.prepare(`SELECT ${name} AS v FROM queue_items WHERE qitem_id = ?`).get(qitemId) as { v: string | null }).v;

  it("create 时从 source occupant 写入 minting_generation_uuid", async () => {
    genBySession.set("alice@rig", "gen-src");
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    expect(col(item.qitemId, "minting_generation_uuid")).toBe("gen-src");
  });

  it("claim 时从 claimant 写入 claimed_by_generation_uuid，unclaim 时清除", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    genBySession.set("bob@rig", "gen-claimant");
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    expect(col(item.qitemId, "claimed_by_generation_uuid")).toBe("gen-claimant");
    repo.unclaim(item.qitemId, "bob@rig", "stepping away");
    expect(col(item.qitemId, "claimed_by_generation_uuid")).toBeNull();
  });

  it("将 retired-gen 的 in-progress item 释放为 pending（绝不丢弃），清除 claim 并审计", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    genBySession.set("bob@rig", "gen-retired");
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });

    const released = repo.releaseClaimsByGeneration("gen-retired");
    expect(released).toBe(1);
    const after = repo.getById(item.qitemId)!;
    expect(after.state).toBe("pending"); // 已释放而非丢弃——item 保留。
    expect(col(item.qitemId, "claimed_by_generation_uuid")).toBeNull();
    const notes = repo.transitionLog.listForQitem(item.qitemId).map((t) => t.transitionNote ?? "");
    expect(notes.some((n) => /claimant generation 已退役/.test(n))).toBe(true);
  });

  it("不释放 successor 自己的 claim（相同 seat name、live gen）——按 gen 而非 name 限定", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    genBySession.set("bob@rig", "gen-live"); // successor 以相同名称、全新 generation 执行 claim。
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    expect(repo.releaseClaimsByGeneration("gen-retired")).toBe(0);
    expect(repo.getById(item.qitemId)!.state).toBe("in-progress"); // 保持不变。
  });

  it("空 generation 为 no-op（绝不进行 catch-all release）", async () => {
    const item = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    genBySession.set("bob@rig", "gen-1");
    repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    expect(repo.releaseClaimsByGeneration("")).toBe(0);
    expect(repo.getById(item.qitemId)!.state).toBe("in-progress");
  });

  it("pending（从未 claim）item 绝不被 release——claimed_by 为 NULL（UNKNOWN != retired）", async () => {
    const pending = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "y" });
    genBySession.set("bob@rig", "gen-retired");
    expect(repo.releaseClaimsByGeneration("gen-retired")).toBe(0);
    expect(repo.getById(pending.qitemId)!.state).toBe("pending");
  });
});

describe("QueueRepository——S26 blocker actuation 统一（OPR.0.5.6.26）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;
  let captured: PersistedEvent[];

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, outboxEntriesSchema]);
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus);
    repo.attachOutbox(new OutboxHandler(db));
    captured = [];
    bus.subscribe((e) => captured.push(e));
  });

  afterEach(() => db.close());
  // ── OPR.0.5.6.26——blocker actuation 统一。blocked_on 承诺“A 等待 B 完成”；
  // propagate-completion block 只存在于一个位置（update 路径），而 handoff family 在自己的
  // transaction 内通过直接 SQL 写入 terminal state——所以通过该 family 的任何 closure 都不会履行
  // 承诺（按 code path 类，而非按 closure state）。spec 中有三个 live 样本；以下 fixture 是锁定的
  // RED。每项先断言 state，使基线失败原因为已锁定项（blocked row 保持 blocked），随后断言 update
  // 路径已有的完整 effect-set parity（transition、wake intent、event）。

  it("S26 RED 1：通过 handoff verb 向等待 owner 返回结果时，自动 unpark 其关联 row", async () => {
    const blocker = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "blocker A" });
    const parked = await repo.create({ sourceSession: "alice@rig", destinationSession: "carol@rig", body: "work B" });
    repo.update({ qitemId: parked.qitemId, actorSession: "carol@rig", state: "blocked", blockedOn: blocker.qitemId });
    expect(repo.getById(parked.qitemId)!.state).toBe("blocked");

    // 通过 handoff verb 关闭 blocker（terminal state 'handed-off'，successor 明确）。
    await repo.handoff({ qitemId: blocker.qitemId, fromSession: "bob@rig", toSession: "carol@rig", nudge: false });
    expect(repo.getById(blocker.qitemId)!.state).toBe("handed-off");

    // 锁定的 RED 原因（specimen-1 形态）：基线中 parked row 保持 blocked——handoff family 从不调用
    // propagate-completion。
    const after = repo.getById(parked.qitemId)!;
    expect(after.state, "阻塞于 handed-off blocker 的 row 必须自动 unpark").toBe("pending");
    expect(after.blockedOn, "auto-unpark 清除已解决 blocker").toBeNull();

    // 与 update 路径保持 effect-set parity（跨 entry path 一致）：
    const notes = repo.transitionLog.listForQitem(parked.qitemId).map((t) => t.transitionNote ?? "");
    expect(
      notes.some((n) => n.includes("auto-unparked") && n.includes(blocker.qitemId)),
      "resume transition 点名 blocker",
    ).toBe(true);
    const wake = db
      .prepare("SELECT COUNT(*) AS c FROM outbox_entries WHERE tags LIKE ?")
      .get(`%queue:auto-unpark:blocker%`) as { c: number };
    expect(wake.c, "为已 unpark row 暂存 wake intent").toBeGreaterThan(0);
    expect(
      captured.some(
        (e) =>
          e.type === "queue.updated" &&
          (e as { qitemId?: string }).qitemId === parked.qitemId &&
          (e as { fromState?: string }).fromState === "blocked" &&
          (e as { toState?: string }).toState === "pending",
      ),
      "已发出 blocked->pending event",
    ).toBe(true);
  });

  // R-2 证实或证伪：此 fixture 编码没有 live 样本的派生预测——通过 handoffAndComplete 执行的
  // 'done' closure 走同一直接 SQL 旁路。若此测试在基线意外通过，则预测被证伪：就地修正 spec 的
  // 缺陷陈述（保留日期与可见的错误版本），并将此测试保留为回归底线。基线通过是一项发现，绝不能
  // 掩盖。
  it("S26 RED 2（证实或证伪）：blocker 通过 handoff-and-complete 以 done 闭合时，自动 unpark 其关联 row", async () => {
    const blocker = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "blocker A2" });
    const parked = await repo.create({ sourceSession: "alice@rig", destinationSession: "carol@rig", body: "work B2" });
    repo.update({ qitemId: parked.qitemId, actorSession: "carol@rig", state: "blocked", blockedOn: blocker.qitemId });
    expect(repo.getById(parked.qitemId)!.state).toBe("blocked");

    // 通过 handoff-and-complete 关闭 blocker（terminal state 'done'，同一旁路 family）。
    await repo.handoffAndComplete({ qitemId: blocker.qitemId, fromSession: "bob@rig", toSession: "dave@rig", nudge: false });
    expect(repo.getById(blocker.qitemId)!.state).toBe("done");

    // 锁定的 RED 原因（派生预测）：基线中 parked row 保持 blocked。
    const after = repo.getById(parked.qitemId)!;
    expect(after.state, "阻塞于经 handoff-and-complete 变为 done 的 blocker 上的 row 必须自动 unpark").toBe("pending");
    expect(after.blockedOn, "auto-unpark 清除已解决 blocker").toBeNull();

    // effect-set parity，与 RED 1 的断言相同：
    const notes = repo.transitionLog.listForQitem(parked.qitemId).map((t) => t.transitionNote ?? "");
    expect(
      notes.some((n) => n.includes("auto-unparked") && n.includes(blocker.qitemId)),
      "resume transition 点名 blocker",
    ).toBe(true);
    expect(
      captured.some(
        (e) =>
          e.type === "queue.updated" &&
          (e as { qitemId?: string }).qitemId === parked.qitemId &&
          (e as { fromState?: string }).fromState === "blocked" &&
          (e as { toState?: string }).toState === "pending",
      ),
      "已发出 blocked->pending event",
    ).toBe(true);
  });

  // R2 B-1（HOLD 5496b628）——第三条 handoff-family 路径：live 跨 host terminal close
  //（routes/queue.ts 调用 closeCrossHostHandoffSource）通过直接 SQL 提交 handed-off/done，并且必须
  // 像两个本地 sibling 一样经唯一传播位置执行。此 fixture 还锁定 ABSORBED-REDRIVE 底线：幂等重复
  //（同一 closureTarget -> absorbed:true）不得执行两次——始终只有一次 auto-unpark transition。
  it("S26 RED 3：blocker 经跨 host terminal close 闭合时驱动关联 row，absorbed redrive 绝不重复驱动", async () => {
    const blocker = await repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "blocker A3" });
    const parked = await repo.create({ sourceSession: "alice@rig", destinationSession: "carol@rig", body: "work B3" });
    repo.update({ qitemId: parked.qitemId, actorSession: "carol@rig", state: "blocked", blockedOn: blocker.qitemId });
    expect(repo.getById(parked.qitemId)!.state).toBe("blocked");

    // 通过跨 host terminal close 关闭 blocker（terminal state 'handed-off'；按 BR-1，host 限定的
    // successor key 由 closure_target 携带）。
    const first = repo.closeCrossHostHandoffSource({
      qitemId: blocker.qitemId,
      fromSession: "bob@rig",
      toSession: "dave@rig",
      closureTarget: "qitem-19990101000000-cafef00d@other-host",
      terminalState: "handed-off",
    });
    expect(first.absorbed).toBe(false);
    expect(repo.getById(blocker.qitemId)!.state).toBe("handed-off");

    // 锁定的 RED 原因（B-1 类）：基线中 parked row 保持 blocked——此路径从不调用
    // propagate-completion。
    const after = repo.getById(parked.qitemId)!;
    expect(after.state, "阻塞于跨 host closed blocker 的 row 必须自动 unpark").toBe("pending");
    expect(after.blockedOn, "auto-unpark 清除已解决 blocker").toBeNull();

    // 与其他 entry path 保持 effect-set parity：
    const unparkNotes = () =>
      repo.transitionLog
        .listForQitem(parked.qitemId)
        .filter((tr) => (tr.transitionNote ?? "").includes("auto-unparked") && (tr.transitionNote ?? "").includes(blocker.qitemId));
    expect(unparkNotes().length, "resume transition 点名 blocker，且只出现一次").toBe(1);
    const wake = db
      .prepare("SELECT COUNT(*) AS c FROM outbox_entries WHERE tags LIKE ?")
      .get(`%queue:auto-unpark:blocker%`) as { c: number };
    expect(wake.c, "为已 unpark row 暂存 wake intent").toBeGreaterThan(0);
    expect(
      captured.some(
        (e) =>
          e.type === "queue.updated" &&
          (e as { qitemId?: string }).qitemId === parked.qitemId &&
          (e as { fromState?: string }).fromState === "blocked" &&
          (e as { toState?: string }).toState === "pending",
      ),
      "已发出 blocked->pending event",
    ).toBe(true);

    // ABSORBED-REDRIVE 底线：同一 closure target 的幂等重复会被吸收，且不得再次驱动——始终只有
    // 一次 auto-unpark transition。
    const redrive = repo.closeCrossHostHandoffSource({
      qitemId: blocker.qitemId,
      fromSession: "bob@rig",
      toSession: "dave@rig",
      closureTarget: "qitem-19990101000000-cafef00d@other-host",
      terminalState: "handed-off",
    });
    expect(redrive.absorbed, "重复操作被吸收，绝不再次闭合").toBe(true);
    expect(unparkNotes().length, "absorbed redrive 绝不重复驱动").toBe(1);
    expect(repo.getById(parked.qitemId)!.state, "redrive 不改变已 unpark row").toBe("pending");
  });
});
