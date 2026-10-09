// W1——事务性闭合（mission release-0.5.1，51-06）。
//
// Atom origin: workspace/missions/release-0.5.1/WAVE-CONVERSION-state-vs-truth-2026-08-07-pm-openrig.md
//   § "W1 — TRANSACTIONAL CLOSURE", sha-16 5c899ee14a693fdb.
// Plan: workspace/artifacts/PLAN-W1-transactional-closure-dev50-planner.md sha-16 0738722b87e9e38b.
//
// 原子操作：qitem terminal act（close + transition）与其 WAKE INTENT 要么一起提交，要么均不提交，
// 从而让“已执行但未闭合”的 item 无法写入，而不是仅可检测。wake nudge 是 pane 写入，无法加入 DB
// transaction（在 transaction 内写 pane 会让 transaction 在相反方向上撒谎——queue-repository.ts
// post-commit 契约，不可逆）。因此加入 transaction 的是持久 INTENT ROW（outbox_entries row）；
// 外部投递随后从已提交 intent drain。
//
// 证明纪律（PM 修订）：绿色路径运行无法证明原子性——只有观察动作中途失败，才能看到全有或全无。
// 以下 demo 是对 queue emitter 的效果读取，每项都点名其锁定点：
//   demo2 → W1-a（transaction 内失败 ⇒ 不持久化任何内容——全无侧）
//   demo1 → W1-b（drain 幂等——drain 两次，只投递一次）
//   demo3 → W1-c（证明 guard 在接缝处触发）

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import type { QueueNudgeTransport } from "../src/domain/queue-repository.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

interface SendCall {
  session: string;
  text: string;
}

/** 记录每次 send 并允许测试指定 outcome 的 mock wake transport（ok+verified、ok+unverified =
 *  歧义面、not-ok 或 throw）。 */
type SendMode = "verified" | "unverified" | "notok" | "timeout" | "throw" | "throw-timeout";
function makeMockTransport(): {
  transport: QueueNudgeTransport;
  calls: SendCall[];
  outcome: { mode: SendMode; error?: string };
} {
  const calls: SendCall[] = [];
  const outcome: { mode: SendMode; error?: string } = {
    mode: "verified",
  };
  const transport: QueueNudgeTransport = {
    async send(session: string, text: string) {
      calls.push({ session, text });
      switch (outcome.mode) {
        case "verified":
          return { ok: true, verified: true };
        case "unverified":
          return { ok: true, verified: false };
        case "notok":
          return { ok: false, error: outcome.error ?? "unreachable" };
        case "timeout":
          // timeout 具有歧义：send 可能已到达，也可能没有。
          return { ok: false, reason: "verify timeout waiting for render ack" };
        case "throw":
          throw new Error(outcome.error ?? "transport exploded");
        case "throw-timeout":
          throw new Error("send ETIMEDOUT after 5000ms");
      }
    },
  };
  return { transport, calls, outcome };
}

function makeHarness(opts?: { deferTransport?: boolean; resolveOccupantGeneration?: () => string | null }) {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const bus = new EventBus(db);
  const outbox = new OutboxHandler(db);
  const { transport, calls, outcome } = makeMockTransport();
  const repo = new QueueRepository(db, bus, {
    validateRig: () => true,
    resolveOccupantGeneration: opts?.resolveOccupantGeneration,
  });
  // deferTransport 会让真实 handoff 后的 intent 保持 PENDING（没有 transport 时跳过 commit 后立即
  // deliver）——这正是 drain 要恢复的 crash window。
  if (!opts?.deferTransport) repo.attachTransport(transport);
  repo.attachOutbox(outbox);
  return {
    db, bus, outbox, repo, calls, outcome, transport,
    attachTransport: () => repo.attachTransport(transport),
  };
}

// MF2（guard HOLD）：原子接缝不得可选，也不得跨两个数据库。只有在同一 transaction 内使用同一
// connection 写入，持久 wake intent 才能与 close 原子提交；旨在 nudge 的 terminal act 若没有 intent
// store，便无法履行 W1 保证，因此必须 fail closed，而不能没有 intent 却静默 close。
describe("W1 MF2——原子接缝必须存在且使用单一 DB", () => {
  it("attachOutbox 拒绝由另一 DB connection 支持的 outbox（split-DB）", () => {
    const db1 = createDb();
    migrate(db1, ALL_MIGRATIONS);
    const db2 = createDb();
    migrate(db2, [outboxEntriesSchema]);
    const repo = new QueueRepository(db1, new EventBus(db1), { validateRig: () => true });
    const foreignOutbox = new OutboxHandler(db2); // 不同 connection。
    expect(() => repo.attachOutbox(foreignOutbox)).toThrow(/db|connection|same/i);
    db1.close();
    db2.close();
  });

  it("旨在 nudge 的 terminal handoff 未接入 outbox 时 FAILS CLOSED（不静默 close-without-intent）", async () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const { transport } = makeMockTransport();
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    repo.attachTransport(transport);
    // 有意不调用 attachOutbox。
    const source = await repo.create({
      sourceSession: "planner@rig", destinationSession: "driver@rig", body: "x",
    });
    await expect(
      repo.handoff({ qitemId: source.qitemId, fromSession: "driver@rig", toSession: "reviewer@rig", body: "y" }),
    ).rejects.toThrow(/intent store|outbox|unavailable/i);
    // close 已回滚——source 保持 open。
    expect(repo.getById(source.qitemId)!.state).toBe("pending");
    db.close();
  });

  it("允许 nudge:false 且无 outbox 的 terminal handoff（不准备 wake ⇒ 不需要 store）", async () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
    const source = await repo.create({
      sourceSession: "planner@rig", destinationSession: "driver@rig", body: "x",
    });
    const { closed } = await repo.handoff({
      qitemId: source.qitemId, fromSession: "driver@rig", toSession: "reviewer@rig", body: "y", nudge: false,
    });
    expect(closed.state).toBe("handed-off");
    db.close();
  });
});

describe("W1 事务性闭合——W1-a：持久 intent row 加入 terminal transaction", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.db.close());

  it("handoff 原子提交 close + successor + wake intent（intent row 存在且 pending）", async () => {
    const source = await h.repo.create({
      sourceSession: "planner@rig",
      destinationSession: "driver@rig",
      body: "do the thing",
    });

    const { closed, created } = await h.repo.handoff({
      qitemId: source.qitemId,
      fromSession: "driver@rig",
      toSession: "reviewer@rig",
      body: "review the thing",
    });

    expect(closed.state).toBe("handed-off");
    expect(created.destinationSession).toBe("reviewer@rig");

    // successor 的 wake intent 已持久提交——存在 destination 为 successor owner 的 row。（其投递
    // outcome 由 W1-b 关注；W1-a 的性质是 intent 存在，并与 close 原子耦合。）
    const intents = h.outbox.listForSender("driver@rig");
    const wake = intents.find((e) => e.destinationSession === "reviewer@rig");
    expect(wake).toBeTruthy();
    expect(wake!.auditPointer).toBe(created.qitemId);
  });

  it("handoffAndComplete 也暂存持久 wake intent（对称）", async () => {
    const source = await h.repo.create({
      sourceSession: "planner@rig",
      destinationSession: "driver@rig",
      body: "do the thing",
    });

    const { closed } = await h.repo.handoffAndComplete({
      qitemId: source.qitemId,
      fromSession: "driver@rig",
      toSession: "reviewer@rig",
      body: "review the thing",
    });

    expect(closed.state).toBe("done");
    const intents = h.outbox.listForSender("driver@rig");
    expect(intents.some((e) => e.destinationSession === "reviewer@rig")).toBe(true);
  });

  // demo2 → W1-a：全无侧。terminal transaction 内失败（这里是 intent stage 抛错）必须回滚所有内容——
  // 无 close、无 successor、无 intent。这正是原子操作与“三次连续写入”的区别：没有 intent 时，
  // close 不可观测。
  it("demo2——transaction 内失败时不持久化任何内容（无 close、无 successor、无 intent）", async () => {
    const source = await h.repo.create({
      sourceSession: "planner@rig",
      destinationSession: "driver@rig",
      body: "do the thing",
    });

    // 强制 transaction 内 intent stage 抛错——模拟 transaction 中途故障。
    const spy = vi.spyOn(h.outbox, "record").mockImplementationOnce(() => {
      throw new Error("intent-stage fault mid-transaction");
    });

    await expect(
      h.repo.handoff({
        qitemId: source.qitemId,
        fromSession: "driver@rig",
        toSession: "reviewer@rig",
        body: "review the thing",
      }),
    ).rejects.toThrow();

    spy.mockRestore();

    // source 未 close。
    const reloaded = h.repo.getById(source.qitemId);
    expect(reloaded!.state).toBe("pending");
    // 未创建 successor（seat 只有原始 item）。
    const successors = h.db
      .prepare("SELECT COUNT(*) AS n FROM queue_items WHERE handed_off_from = ?")
      .get(source.qitemId) as { n: number };
    expect(successors.n).toBe(0);
    // 回滚后没有 intent row 残留。
    expect(h.outbox.listForSender("driver@rig")).toHaveLength(0);
  });

  it("nudge:false 不暂存 wake intent（不准备 wake ⇒ 无持久 intent，无内容可 drain）", async () => {
    const source = await h.repo.create({
      sourceSession: "planner@rig",
      destinationSession: "driver@rig",
      body: "do the thing",
    });
    await h.repo.handoff({
      qitemId: source.qitemId,
      fromSession: "driver@rig",
      toSession: "reviewer@rig",
      body: "review the thing",
      nudge: false,
    });
    expect(h.outbox.listForSender("driver@rig")).toHaveLength(0);
  });
});

describe("W1 事务性闭合——W1-b：采用 indeterminate outcome 纪律的 drain", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.db.close());

  async function doHandoff() {
    const source = await h.repo.create({
      sourceSession: "planner@rig",
      destinationSession: "driver@rig",
      body: "do the thing",
    });
    // 上方 create() 会向 driver@rig 发出自身 nudge——清空记录，使下方计数只衡量 handoff 向 successor
    // 的 wake 投递。
    h.calls.length = 0;
    return h.repo.handoff({
      qitemId: source.qitemId,
      fromSession: "driver@rig",
      toSession: "reviewer@rig",
      body: "review the thing",
    });
  }

  it("verified nudge 的 commit 后立即投递会将 intent 标为 DELIVERED", async () => {
    h.outcome.mode = "verified";
    const { created } = await doHandoff();
    const row = h.outbox.getById(`wake-intent-${created.qitemId}`);
    expect(row!.deliveryState).toBe("delivered");
    expect(h.calls).toHaveLength(1);
  });

  it("歧义 nudge（res.ok 但未 verified）记录为 INDETERMINATE——绝非 delivered 或 failed", async () => {
    // live 样本：rendered-unconfirmed send（已到达，但未确认 pane 重绘）在当前生产环境中为
    // res.ok && !verified。
    h.outcome.mode = "unverified";
    const { created } = await doHandoff();
    const row = h.outbox.getById(`wake-intent-${created.qitemId}`);
    expect(row!.deliveryState).toBe("indeterminate");
  });

  it("硬投递失败记录为 FAILED，item 保持 CLOSED（close 不以投递为条件）", async () => {
    h.outcome.mode = "notok";
    const { closed, created } = await doHandoff();
    // 无论后续投递如何，close 都已在 transaction 中提交。
    expect(closed.state).toBe("handed-off");
    // Q1 残留：live daemon 的 transient failure 会落入可见状态，而不会滞留在 `pending`
    //（周期重试是具名后续项，不在范围内）。
    const row = h.outbox.getById(`wake-intent-${created.qitemId}`);
    expect(row!.deliveryState).toBe("failed");
  });

  it("demo1——真实 handoff 遗留的 crash-orphaned intent 可幂等 drain：drain 两次，只投递一次", async () => {
    // 驱动真实 emitter（proof 契约）：未接入 transport 的 handoff 会提交持久 intent，但跳过立即 deliver——
    // 正好模拟 commit 后、drain 前崩溃。随后 recovery sweep 投递一次。
    const g = makeHarness({ deferTransport: true });
    const source = await g.repo.create({ sourceSession: "planner@rig", destinationSession: "driver@rig", body: "x" });
    const { created } = await g.repo.handoff({
      qitemId: source.qitemId, fromSession: "driver@rig", toSession: "reviewer@rig", body: "y",
    });
    // 已提交但为 PENDING，且从未发送——即 crash window。
    expect(g.outbox.getById(`wake-intent-${created.qitemId}`)!.deliveryState).toBe("pending");
    expect(g.calls).toHaveLength(0);

    g.attachTransport();
    g.outcome.mode = "verified";
    const first = await g.repo.drainPendingWakeIntents();
    expect(first.delivered).toBe(1);
    expect(g.calls).toHaveLength(1);
    expect(g.outbox.getById(`wake-intent-${created.qitemId}`)!.deliveryState).toBe("delivered");

    // 第二次 drain 找不到 pending 内容——compare-and-set 使其成为 no-op。
    const second = await g.repo.drainPendingWakeIntents();
    expect(second.delivered).toBe(0);
    expect(g.calls).toHaveLength(1); // 恰好投递一次。
    g.db.close();
  });
});

describe("W1 事务性闭合——W1-c：接缝 guard（terminal close 无 intent 时不能提交）", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });
  afterEach(() => h.db.close());

  // demo3 → W1-c：证明 guard 会触发。驱动真实 handoff chokepoint——与生产环境相同的路径——但禁用
  // transaction 内 intent stage，模拟未来 refactor 写入 close 却丢失 intent。guard 必须在接缝处令其
  // 失败（在 transaction 内抛错），而不能延后到 review。只存在却从未证明会触发的 guard，属于
  // assert-the-effect-not-the-indicator 类。
  it("demo3——跳过 intent staging 的 terminal close 在接缝处失败（guard 抛错，transaction 回滚）", async () => {
    const source = await h.repo.create({
      sourceSession: "planner@rig",
      destinationSession: "driver@rig",
      body: "do the thing",
    });

    // 合成 close-without-intent：仍写入 close，但不暂存 wake intent——正是 guard 禁止的类别。
    const spy = vi
      .spyOn(h.repo as unknown as { stageWakeIntent: () => void }, "stageWakeIntent")
      .mockImplementation(() => {});

    await expect(
      h.repo.handoff({
        qitemId: source.qitemId,
        fromSession: "driver@rig",
        toSession: "reviewer@rig",
        body: "review the thing",
      }),
    ).rejects.toThrow(/terminal_close_without_wake_intent|一个操作或全无/i);

    spy.mockRestore();

    // guard 在 transaction 内触发，因此 close 回滚——source 仍为 open。已执行但未 wake 的 close
    // 已变得不可写入。
    expect(h.repo.getById(source.qitemId)!.state).toBe("pending");
  });

  it("nudge:false 不触发 guard（不准备 wake ⇒ 不需要 intent）", async () => {
    const source = await h.repo.create({
      sourceSession: "planner@rig",
      destinationSession: "driver@rig",
      body: "do the thing",
    });

    // 跳过 intent staging 且 nudge:false——guard 必须识别出未准备 wake，并允许 close 提交。
    const spy = vi
      .spyOn(h.repo as unknown as { stageWakeIntent: () => void }, "stageWakeIntent")
      .mockImplementation(() => {});

    const { closed } = await h.repo.handoff({
      qitemId: source.qitemId,
      fromSession: "driver@rig",
      toSession: "reviewer@rig",
      body: "review the thing",
      nudge: false,
    });

    expect(closed.state).toBe("handed-off");
    spy.mockRestore();
  });
});

// MF6（guard HOLD）：LOCK 要求将 timeout/ambiguous outcome 记录为 `indeterminate`。此前代码只把
// ok&&!verified 如此分类；timeout 形态的非 OK 会变为 `failed`，而 recovery 只 drain `pending`，
// 导致 `failed` row 尽管文案声称会重试，实际从不重试。修复：根据类型化结果把 timeout 分类为
// indeterminate；保持诚实的 retry policy（只重试 `pending`；failed/indeterminate 为终态可见）。
describe("W1 MF6——timeout 分类为 indeterminate；retry policy 如实", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => h.db.close());

  async function doHandoff() {
    const source = await h.repo.create({
      sourceSession: "planner@rig", destinationSession: "driver@rig", body: "x",
    });
    h.calls.length = 0;
    return h.repo.handoff({
      qitemId: source.qitemId, fromSession: "driver@rig", toSession: "reviewer@rig", body: "y",
    });
  }

  it("transport TIMEOUT（ok:false、timeout reason）记录为 INDETERMINATE，而非 failed", async () => {
    h.outcome.mode = "timeout";
    const { created } = await doHandoff();
    expect(h.outbox.getById(`wake-intent-${created.qitemId}`)!.deliveryState).toBe("indeterminate");
  });

  it("抛出的 timeout（ETIMEDOUT）也记录为 INDETERMINATE", async () => {
    h.outcome.mode = "throw-timeout";
    const { created } = await doHandoff();
    expect(h.outbox.getById(`wake-intent-${created.qitemId}`)!.deliveryState).toBe("indeterminate");
  });

  it("真正的硬失败（unreachable）仍记录为 FAILED", async () => {
    h.outcome.mode = "notok";
    const { created } = await doHandoff();
    expect(h.outbox.getById(`wake-intent-${created.qitemId}`)!.deliveryState).toBe("failed");
  });

  it("retry policy 如实：recovery sweep 不会再次 drain FAILED intent", async () => {
    h.outcome.mode = "notok";
    const { created } = await doHandoff();
    expect(h.outbox.getById(`wake-intent-${created.qitemId}`)!.deliveryState).toBe("failed");
    h.calls.length = 0;
    h.outcome.mode = "verified";
    const tally = await h.repo.drainPendingWakeIntents();
    // recovery 只 drain `pending`——terminal `failed` 保持可见，不会重发。
    expect(tally).toEqual({ delivered: 0, indeterminate: 0, failed: 0, retained: 0 });
    expect(h.calls).toHaveLength(0);
    expect(h.outbox.getById(`wake-intent-${created.qitemId}`)!.deliveryState).toBe("failed");
  });
});

// MF3（guard HOLD）：重叠 drain 必须只发送一次外部 wake，而不能只是收敛到同一终态。发送前 claim
//（pending→sending）使落败的 drain 找不到可领取内容。
describe("W1 MF3——重叠 drain 只发送一次外部 wake", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });
  afterEach(() => h.db.close());

  it("两个 drain 并发处理同一 crash-orphaned intent：只 send 一次，计数如实", async () => {
    const g = makeHarness({ deferTransport: true });
    const source = await g.repo.create({ sourceSession: "planner@rig", destinationSession: "driver@rig", body: "x" });
    const { created } = await g.repo.handoff({
      qitemId: source.qitemId, fromSession: "driver@rig", toSession: "reviewer@rig", body: "y",
    });
    g.attachTransport();
    g.outcome.mode = "verified";
    const [ta, tb] = await Promise.all([
      g.repo.drainPendingWakeIntents(),
      g.repo.drainPendingWakeIntents(),
    ]);
    expect(g.calls).toHaveLength(1); // 外部 wake 恰好发生一次。
    expect(ta.delivered + tb.delivered).toBe(1); // 各 drain 计数之和为一，而非二。
    expect(g.outbox.getById(`wake-intent-${created.qitemId}`)!.deliveryState).toBe("delivered");
    g.db.close();
  });
});

// MF4（guard HOLD）：recovery 不得把当前 occupant 的 generation 伪造到旧 intent 上。intent 冻结
// emitting envelope（在 stage 时解析 generation），delivery 原样重放它。
describe("W1 MF4——intent 冻结其 emitting generation/envelope", () => {
  it("冻结：已暂存 intent 携带在 stage 时解析的 source generation", async () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const { transport } = makeMockTransport();
    const repo = new QueueRepository(db, new EventBus(db), {
      validateRig: () => true,
      resolveOccupantGeneration: () => "11111111-aaaa-bbbb-cccc-dddddddddddd",
    });
    repo.attachTransport(transport);
    const outbox = new OutboxHandler(db);
    repo.attachOutbox(outbox);
    const source = await repo.create({ sourceSession: "planner@rig", destinationSession: "driver@rig", body: "x" });
    const { created } = await repo.handoff({
      qitemId: source.qitemId, fromSession: "driver@rig", toSession: "reviewer@rig", body: "y",
    });
    const intent = outbox.getById(`wake-intent-${created.qitemId}`);
    expect(intent!.body).toContain("gen 11111111"); // 在 stage 时冻结。
    db.close();
  });

  it("不 relabel：tenure 切换后，recovery 原样投递已冻结 envelope", async () => {
    const db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const { transport, calls, outcome } = makeMockTransport();
    // 若投递时重新解析，此 resolver 会 relabel 为当前 occupant。
    const repo = new QueueRepository(db, new EventBus(db), {
      validateRig: () => true,
      resolveOccupantGeneration: () => "22222222-current-occupant-tenure",
    });
    const outbox = new OutboxHandler(db);
    repo.attachOutbox(outbox);
    // 使用真实 successor qitem，使 intent 引用现有目标（MF5）。
    const successor = await repo.create({ sourceSession: "driver@rig", destinationSession: "reviewer@rig", body: "z" });
    // 已提交但未投递的 intent，其冻结 envelope 携带原始 gen。
    const FROZEN =
      `From: driver@rig\nTo: reviewer@rig\nSent: 08-08 19:44Z · gen 11111111\n---\nQueue handoff: ${successor.qitemId} - check your queue.\n---\n↩ 回复：rig send driver@rig \"...\"`;
    outbox.record({ outboxId: `wake-intent-${successor.qitemId}`, senderSession: "driver@rig", destinationSession: "reviewer@rig", body: FROZEN, auditPointer: successor.qitemId });
    repo.attachTransport(transport); // tenure 切换：transport 现在可用。
    outcome.mode = "verified";
    await repo.drainPendingWakeIntents();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toBe(FROZEN); // 原样。
    expect(calls[0]!.text).not.toContain("22222222"); // 未重新解析为当前 occupant。
    db.close();
  });
});

// drain 拒绝目标 qitem 不存在的 wake。路由侧 prefix 拒绝未构建（founder 裁定），因此 caller 可以
// 在可执行 prefix 下记录 id；此锁定会阻止指向空目标的 row 作为真实 wake 发出。
describe("W1——drain 绝不为不存在的 qitem 发送 wake", () => {
  it("指向不存在 qitem 的 wake-intent 会失败，绝不发送", async () => {
    const h = makeHarness();
    h.outbox.record({
      outboxId: "wake-intent-ghost",
      senderSession: "attacker@rig",
      destinationSession: "victim@rig",
      body: "forged wake payload",
      auditPointer: "qitem-does-not-exist",
    });
    h.outcome.mode = "verified";
    const tally = await h.repo.drainPendingWakeIntents();
    expect(h.calls).toHaveLength(0); // 绝不作为真实 wake 发送。
    expect(tally.failed).toBe(1);
    expect(h.outbox.getById("wake-intent-ghost")!.deliveryState).toBe("failed");
    h.db.close();
  });
});

// Re-seal BLOCKING 1（guard）：遗弃的 `sending` claim（claim 后、finalize 前崩溃——无论 send 是否
// 到达，持久化状态都相同）必须在 recovery 边界对账为 `indeterminate`，且不重发。
describe("W1 re-seal BLOCKING 1——遗弃的 `sending` claim 对账为 indeterminate", () => {
  it("崩溃后遗留为 `sending` 的已领取 intent 在 recovery 时变为 `indeterminate`，绝不重发", async () => {
    const g = makeHarness({ deferTransport: true });
    const source = await g.repo.create({ sourceSession: "planner@rig", destinationSession: "driver@rig", body: "x" });
    const { created } = await g.repo.handoff({
      qitemId: source.qitemId, fromSession: "driver@rig", toSession: "reviewer@rig", body: "y",
    });
    const intentId = `wake-intent-${created.qitemId}`;
    // 模拟 crash window：claim（pending->sending），随后在 finalize 前崩溃。
    g.outbox.claimForDelivery(intentId);
    expect(g.outbox.getById(intentId)!.deliveryState).toBe("sending");

    // 重新打开：同一 DB 上的新 repo 运行启动 recovery sweep。
    const reopened = new QueueRepository(g.db, new EventBus(g.db), { validateRig: () => true });
    reopened.attachOutbox(g.outbox);
    reopened.attachTransport(g.transport);
    g.outcome.mode = "verified";
    const reconciled = reopened.reconcileAbandonedWakeIntents();
    const tally = await reopened.drainPendingWakeIntents();

    expect(reconciled).toBe(1);
    expect(g.calls).toHaveLength(0); // 绝不重发。
    expect(tally.delivered).toBe(0); // 对账为 indeterminate ⇒ 无 pending 内容可投递。
    expect(g.outbox.getById(intentId)!.deliveryState).toBe("indeterminate");
    g.db.close();
  });
});

// 可执行 drain selector 区分大小写，因此永远不会选择/执行 `WAKE-INTENT-…` 变体。注意：公开
// /outbox/record 路由不再拒绝保留 prefix id（W4 时期 MF5 路由 guard 未构建——founder 裁定：其理由
// 需要此信任域内存在 adversary，而唯一 caller 是 daemon 自己的 localhost client）。这使 selector
// 锁定更承重，而非更轻：它现在是阻止已记录大小写变体 id 进入可执行 drain 的唯一机制。
describe("W1——可执行 drain selector 区分大小写", () => {
  it("drain 不选择 WAKE-INTENT- 大小写变体（绝不执行）", async () => {
    const h = makeHarness();
    const q = await h.repo.create({ sourceSession: "driver@rig", destinationSession: "reviewer@rig", body: "z" });
    h.calls.length = 0; // 忽略 create-time nudge；只统计 drain send。
    const variantId = `WAKE-INTENT-${q.qitemId}`; // 大写变体，真实 target qitem。
    h.outbox.record({ outboxId: variantId, senderSession: "attacker@rig", destinationSession: "victim@rig", body: "variant", auditPointer: q.qitemId });
    h.outcome.mode = "verified";
    const tally = await h.repo.drainPendingWakeIntents();
    expect(h.calls).toHaveLength(0); // 变体从未被选择/发送。
    expect(tally.delivered).toBe(0);
    expect(h.outbox.getById(variantId)!.deliveryState).toBe("pending"); // 保持不变。
    h.db.close();
  });
});

// Re-seal #3（guard）：真实 file-backed close/reopen crash 边界。此前 BLOCKING 1 测试复用同一个
// 仍打开的内存 Database，因此并未真正跨越 restart。本测试持久化到磁盘、关闭 connection（崩溃），
// 随后在 recovery 前以新对象（新进程）重新打开同一文件。发送前与发送后/finalize 前窗口共享同一个
// 持久化 `sending` 状态，因此一个等价性锁定足够。
describe("W1 re-seal #3——真实 file-backed close/reopen crash 边界", () => {
  it("已领取的 `sending` intent 在 DB close/reopen 后仍存在，对账为 indeterminate 且绝不重发", async () => {
    const dbPath = join(tmpdir(), `w1-reopen-${Date.now()}-${process.pid}.sqlite`);
    try {
      // --- 进程 1：真实 handoff，领取 intent，随后崩溃（关闭 DB）---
      const db1 = createDb(dbPath);
      migrate(db1, ALL_MIGRATIONS);
      const outbox1 = new OutboxHandler(db1);
      const repo1 = new QueueRepository(db1, new EventBus(db1), { validateRig: () => true });
      repo1.attachOutbox(outbox1); // no transport ⇒ immediate deliver skipped ⇒ intent pending
      const source = await repo1.create({ sourceSession: "planner@rig", destinationSession: "driver@rig", body: "x" });
      const { created } = await repo1.handoff({ qitemId: source.qitemId, fromSession: "driver@rig", toSession: "reviewer@rig", body: "y" });
      const intentId = `wake-intent-${created.qitemId}`;
      outbox1.claimForDelivery(intentId); // claim，随后在 finalize 前崩溃。
      expect(outbox1.getById(intentId)!.deliveryState).toBe("sending");
      db1.close(); // 崩溃：connection 消失；row 以 `sending` 状态持久化到磁盘。

      // --- 进程 2：以新对象重新打开同一 DB 文件，随后 recovery ---
      const db2 = createDb(dbPath);
      const outbox2 = new OutboxHandler(db2);
      const { transport, calls } = makeMockTransport();
      const repo2 = new QueueRepository(db2, new EventBus(db2), { validateRig: () => true });
      repo2.attachOutbox(outbox2);
      repo2.attachTransport(transport);
      expect(outbox2.getById(intentId)!.deliveryState).toBe("sending"); // reopen 后仍存在。

      const reconciled = repo2.reconcileAbandonedWakeIntents();
      const tally = await repo2.drainPendingWakeIntents();

      expect(reconciled).toBe(1);
      expect(outbox2.getById(intentId)!.deliveryState).toBe("indeterminate");
      expect(calls).toHaveLength(0); // 跨 restart 绝不重发。
      expect(tally).toEqual({ delivered: 0, indeterminate: 0, failed: 0, retained: 0 }); // 不重新驱动。
      db2.close();
    } finally {
      for (const suffix of ["", "-journal", "-wal", "-shm"]) {
        try { rmSync(`${dbPath}${suffix}`, { force: true }); } catch { /* 尽力清理。 */ }
      }
    }
  });
});
