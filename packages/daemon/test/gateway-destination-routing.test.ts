// OPR.0.5.6.14——gateway 外部路由：全新的基础范围 RED 测试。
// 此基础中已合入（回归下限在此，绝非缺失 RED）：@external 的 gateway-owned 唤醒支路、
// OWNER 等级枚举/分类器/旋钮（076）、阻塞项注册表解析、绑定回执的去重及外部准入拒绝。
// 这些固定测试针对剩余缺陷集：(1) 没有具名的单一解析器接缝——外部支路仍是内联 `if`，
// 经注册表解析的别名（human-founder@kernel——线上四行样本类别）仍会落入 tmux，未知目标
// 得到原始 tmux 文案而非说明性拒绝；(2) 8f291c37 模式——成功发送后写回执若抛错，会逸出
// deliver 接缝，而不是保留并修复；(3) transport-failed 转换不存在；
// (4) undelivered/classifyNudgeFailure 只读取 nudge 字面量，从不查询投递 ledger
//（34a6ad0b 矛盾）；(5) 行视图不携带投递结果。
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { queueTransitionsArchiveSchema } from "../src/db/migrations/054_queue_transitions_archive.js";
import { ownerNotificationLevelsSchema } from "../src/db/migrations/076_owner_notification_levels.js";
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import type { HumanFragment } from "../src/domain/gateway/human-registry.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const FOUNDER_FRAGMENT = {
  // Fragment 约定：address = <entityId>@external，因此 entityId 是完整的本地部分——
  // 这正是 kernel 别名可解析的原因
  //（parseSessionName("human-founder@kernel").member === "human-founder"）。
  entityId: "human-founder",
  class: "human",
  displayName: "创始人",
  address: "human-founder@external",
  connectorBindings: [{ connector: "slack", ref: "U0FOUNDER", primary: true }],
  prefs: {},
} as unknown as HumanFragment;

const EVIDENCE = "shared-docs/rigs/v-openrig-build/state/evidence-s14.md";

function makeHarness(opts?: { registryReadable?: () => boolean; entities?: () => HumanFragment[] }) {
  const db = createDb();
  migrate(db, [
    coreSchema, bindingsSessionsSchema, externalCliAttachmentSchema, eventsSchema, queueItemsSchema,
    queueTransitionsSchema, outboxEntriesSchema, queueTransitionsArchiveSchema,
    ownerNotificationLevelsSchema,
  ]);
  const bus = new EventBus(db);
  const sends: Array<{ session: string; text: string }> = [];
  const repo = new QueueRepository(db, bus, {
    transport: {
      send: async (sessionName: string, text: string) => {
        sends.push({ session: sessionName, text });
        // 此 fixture 中任何没有实时 pane 的对象都采用真实 tmux 行为：
        return sessionName === "dev-a@rig1"
          ? { ok: true, verified: true }
          : { ok: false, error: `未找到会话 '${sessionName}'：tmux 报告不存在此名称的会话。未发送文本。请使用 zrig ps --nodes 查看可用会话` };
      },
    },
    loadHumanRegistry: () => opts?.registryReadable?.() === false
      ? { ok: false as const, error: "fixture 注册表不可读" }
      : { ok: true as const, entities: opts?.entities?.() ?? [FOUNDER_FRAGMENT] },
  });
  repo.attachOutbox(new OutboxHandler(db));
  // 拓扑 fixture：恰好一个已知的 pane 绑定 seat，即 dev-a@rig1。
  db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'rig1')").run();
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES ('node-a', 'rig-1', 'dev.a', 'claude-code')").run();
  db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES ('sess-a', 'node-a', 'dev-a@rig1')").run();
  db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session) VALUES ('binding-a', 'node-a', 'tmux', 'dev-a@rig1')").run();
  return { db, repo, sends };
}

describe("OPR.0.5.6.14——单一目标解析器，无回落", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });

  it.each(["human-operator@kernel", "operator-human@kernel", "operator-admin@kernel"])("升级后 pending %s 保持可见：明确冲突或注册表解析，绝不暗示已投递", async (alias) => {
    const local = alias.split("@")[0]!;
    const entities: HumanFragment[] = [FOUNDER_FRAGMENT];
    const fixture = makeHarness({ entities: () => entities });
    const item = await fixture.repo.create({ sourceSession: "dev-a@rig1", destinationSession: alias,
      tier: "human-gate", summary: "旧版决策", evidenceRef: EVIDENCE, body: "保留这些字节" });
    expect(fixture.repo.getById(item.qitemId)).toMatchObject({ state: "pending", body: "保留这些字节", lastNudgeResult: expect.stringMatching(/unroutable/) });
    expect(fixture.sends).toHaveLength(0);
    const ports = makeQueuePorts(fixture.repo, { loadHumanRegistry: () => ({ ok: true, entities }) });
    expect(await ports.listHumanAlerts({})).toHaveLength(0);
    entities.push({ ...FOUNDER_FRAGMENT, entityId: local, address: `${local}@external` });
    // 注册不会重放更早的未分类义务。其显式路由失败记录会保留，供操作者主动协调。
    expect(await ports.listHumanAlerts({})).toHaveLength(0);
    const registered = await fixture.repo.create({ sourceSession: "dev-a@rig1", destinationSession: alias,
      summary: "已注册的旧版拼写", evidenceRef: EVIDENCE, body: "新的明确请求" });
    const alerts = await ports.listHumanAlerts({});
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ qitemId: registered.qitemId, destinationSession: `${local}@external` });
    expect(fixture.repo.getById(item.qitemId)).toMatchObject({ state: "pending", destinationSession: alias, body: "保留这些字节" });
    expect(fixture.repo.listTransitions(item.qitemId).filter((row) => row.transitionNote?.includes("slack-owner-notification-posted"))).toHaveLength(0);
    expect(fixture.sends).toHaveLength(0);
    fixture.db.close();
  });

  it("消除四行类别：注册表解析的 human 别名（kernel 虚拟 seat）绝不接触 tmux，并记录 gateway-owned", async () => {
    const item = await h.repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: "human-founder@kernel",
      body: "通过 kernel 别名向创始人升级",
      summary: "创始人决策请求（别名寻址）",
      evidenceRef: EVIDENCE,
    });
    expect(h.sends, "不得为注册表解析出的人员查询 tmux transport").toHaveLength(0);
    const fresh = h.repo.getById(item.qitemId)!;
    expect(fresh.lastNudgeResult).toMatch(/^gateway-owned/);
    expect(fresh.lastNudgeResult, "如实文案明确说明注册表解析结果").toMatch(/registry|已注册 human/i);
    expect(fresh.lastNudgeResult).not.toMatch(/tmux 报告不存在/);
  });

  it("下限：@external 类别保持 gateway-owned（已合入行为不变）", async () => {
    const item = await h.repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: "human-founder@external",
      body: "直接外部告警",
      summary: "创始人告警",
      evidenceRef: EVIDENCE,
    });
    expect(h.sends).toHaveLength(0);
    expect(h.repo.getById(item.qitemId)!.lastNudgeResult).toMatch(/^gateway-owned/);
  });

  it("UNROUTABLE 保持显式且结构化：未知目标得到说明性拒绝，绝不返回原始 tmux 文案", async () => {
    const item = await h.repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: "ghost-writer@nowhere",
      body: "发送到既不在拓扑也不在注册表中的目标",
      nudge: true,
    });
    const fresh = h.repo.getById(item.qitemId)!;
    expect(h.sends, "对于 tmux 永远无法承载的目标，不会查询 tmux").toHaveLength(0);
    expect(fresh.lastNudgeResult, "拒绝文案说明已执行两项检查").toMatch(/没有 terminal transport|未指向已注册人员|unroutable/i);
    expect(fresh.lastNudgeResult).not.toMatch(/tmux 报告不存在/);
  });

  it("下限：pane-bound 分派逐字节一致——已知 seat 原样使用 terminal transport", async () => {
    const item = await h.repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: "dev-a@rig1",
      body: "普通 seat 提醒",
      nudge: true,
    });
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.session).toBe("dev-a@rig1");
    const fresh = h.repo.getById(item.qitemId)!;
    expect(fresh.lastNudgeResult).not.toMatch(/^gateway-owned/);
    expect(fresh.lastNudgeAttempt).not.toBeNull();
  });

  it("下限：拥有真实 pane 的已注册人员保持 pane-bound；只有其无 pane 别名可通过 gateway 路由", async () => {
    h.db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES ('node-human', 'rig-1', 'human.founder', 'terminal')").run();
    h.db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES ('sess-human', 'node-human', 'human-founder@rig1')").run();
    h.db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session) VALUES ('binding-human', 'node-human', 'tmux', 'human-founder@rig1')").run();
    const item = await h.repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: "human-founder@rig1",
      body: "由 pane 支持的创始人 seat",
    });
    expect(h.sends.map((send) => send.session)).toEqual(["human-founder@rig1"]);
    expect(h.repo.getById(item.qitemId)!.lastNudgeResult).toMatch(/^failed:/);
  });

  it("无 pane 拓扑不是终端：绑定 external_cli 的已注册人员保持 gateway-routable", async () => {
    h.db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES ('node-external', 'rig-1', 'human.founder', 'external')").run();
    h.db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES ('sess-external', 'node-external', 'human-founder@kernel')").run();
    h.db.prepare("INSERT INTO bindings (id, node_id, attachment_type, external_session_name) VALUES ('binding-external', 'node-external', 'external_cli', 'human-founder@kernel')").run();

    const item = await h.repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: "human-founder@kernel",
      body: "通过已知无 pane 节点传递创始人决策",
      summary: "创始人决策",
      evidenceRef: EVIDENCE,
    });

    expect(h.sends, "无 pane 的 external_cli 绑定没有 terminal transport").toHaveLength(0);
    expect(h.repo.getById(item.qitemId)!.lastNudgeResult).toMatch(/^gateway-owned/);
  });

  it("D3 结构接缝：单一具名分类位置；唤醒路径中不再有内联 external 分支", () => {
    const repoSource = readFileSync(join(HERE, "../src/domain/queue-repository.ts"), "utf8");
    const resolverPath = join(HERE, "../src/domain/gateway/destination-resolver.ts");
    let resolverSource = "";
    expect(() => { resolverSource = readFileSync(resolverPath, "utf8"); },
      "单一解析器模块必须存在（gateway/destination-resolver.ts）").not.toThrow();
    expect(resolverSource).toMatch(/export function classifyDestination/);
    // 唤醒路径查询接缝，而非内联分类：
    expect(repoSource, "唤醒路径中没有内联 external 分类").not.toMatch(/parseSessionName\(destinationSession\)\.kind === "external"/);
    expect(repoSource).toMatch(/classifyDestination/);
  });
});

describe("OPR.0.5.6.14——投递 ledger 通用且会被查询", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => { h = makeHarness(); });

  function currentEpisode(qitemId: string) {
    const transition = h.repo.transitionLog.latestOwnerNotificationForQitem(qitemId);
    expect(transition, "fixture 必须携带当前 OWNER 通知 episode").not.toBeNull();
    return transition!;
  }

  function currentEpisodeKey(qitemId: string): string {
    return `${qitemId}:${currentEpisode(qitemId).transitionId}`;
  }

  function ageCurrentEpisode(qitemId: string): void {
    const transition = currentEpisode(qitemId);
    h.db.prepare("UPDATE queue_transitions SET ts = datetime('now', '-1 hour') WHERE transition_id = ?").run(transition.transitionId);
  }

  function receipt(qitemId: string, outcome: "posted" | "transport-failed", detail: string): void {
    h.repo.update({
      qitemId,
      actorSession: "daemon@kernel",
      transitionNote: `slack-owner-notification-${outcome} notification_key=${currentEpisodeKey(qitemId)} ${detail}`,
    });
  }

  async function humanPark(qitemId: string, note: string): Promise<string> {
    h.repo.update({
      qitemId,
      actorSession: "orch-lead@v-openrig-build",
      state: "blocked",
      blockedOn: "human-founder@kernel",
      summary: "需要创始人决策",
      evidenceRef: EVIDENCE,
      transitionNote: note,
    });
    return currentEpisodeKey(qitemId);
  }

  function memStore() {
    const m = new Map<string, string>();
    return { load: () => m, mark: (k: string, v: string) => m.set(k, v) };
  }

  function deliverHarness(opts?: {
    postStatus?: number;
    postStatuses?: number[];
    attemptedStore?: ReturnType<typeof memStore>;
    onPostedImpl?: (p: unknown, ts: string) => void;
    onTransportFailed?: (p: unknown, cls: string, detail: string) => void;
  }) {
    const posts: string[] = [];
    const logs: string[] = [];
    const postedTexts: Array<{ text: string; ts: string }> = [];
    const postStatuses = [...(opts?.postStatuses ?? [])];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("chat.postMessage")) {
        posts.push(url);
        const postStatus = postStatuses.shift() ?? opts?.postStatus ?? 200;
        if (postStatus !== 200) return new Response("err", { status: postStatus });
        // Slack 如实性：返回 200 的已发送消息确实存在于频道中，且必须出现在后续协调扫描中
        //（这就是完整的修复逻辑）。
        try {
          const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
          postedTexts.push({ text: String(body.text ?? ""), ts: "1234.5678" });
        } catch { /* 非 JSON 正文：扫描结果保持为空 */ }
        return new Response(JSON.stringify({ ok: true, ts: "1234.5678", channel: "C1" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      // 协调扫描能看到实际发送的内容
      return new Response(JSON.stringify({ ok: true, messages: postedTexts }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const attempted = opts?.attemptedStore ?? memStore();
    const delivered = memStore();
    const outboundSeen = memStore();
    const deliver = subsystemSlackDeliver({
      botToken: "xoxb-t",
      channel: "C1",
      sourceLabel: "test",
      attempted,
      delivered,
      outboundSeen,
      fetchImpl,
      log: (message) => logs.push(message),
      onPosted: opts?.onPostedImpl ?? (() => {}),
      // OPR.0.5.6.14：传输失败回执回调（RED：尚不存在）。
      onTransportFailed: opts?.onTransportFailed,
    } as never);
    return { deliver, posts, attempted, delivered, logs };
  }

  const DECISION = (qitemId: string) => ({
    decisionId: `dec-${qitemId}`,
    entityBindingRef: "human-founder@external",
    payload: {
      qitemId,
      summary: "s",
      body: "b",
      destinationSession: "human-founder@external",
      sourceSession: "orch-lead@v-openrig-build",
    },
  });

  it("传输失败写入 LEDGER：发送失败时调用 transport-failed 回执回调并携带错误", async () => {
    const failures: Array<{ cls: string; detail: string }> = [];
    const { deliver } = deliverHarness({
      postStatus: 500,
      onTransportFailed: (_p, cls, detail) => failures.push({ cls, detail }),
    });
    const out = await deliver(DECISION("q-tf-1") as never);
    expect(out.ok).toBe(false);
    expect(failures, "行 ledger 会获知传输失败").toHaveLength(1);
    expect(failures[0]!.cls).toMatch(/http-500|transport/);
  });

  it("传输失败回执修复：抛错的 ledger 写入会在后续成功发送前恢复", async () => {
    let failureReceiptCalls = 0;
    let throwOnce = true;
    const ledger: string[] = [];
    const { deliver, posts } = deliverHarness({
      postStatuses: [500, 200],
      onTransportFailed: (_p, cls) => {
        failureReceiptCalls++;
        if (throwOnce) { throwOnce = false; throw new Error("SQLITE_BUSY：失败回执写入失败"); }
        ledger.push(`failed:${cls}`);
      },
      onPostedImpl: () => ledger.push("posted"),
    });

    expect((await deliver(DECISION("q-tf-repair") as never)).ok).toBe(false);
    expect((await deliver(DECISION("q-tf-repair") as never)).ok).toBe(true);
    expect(ledger, "失败结果会先于后续成功结果持久化").toEqual(["failed:http-500", "posted"]);
    expect(posts).toHaveLength(2);
    expect(failureReceiptCalls).toBe(2);
  });

  it("待处理回执存储失败不能阻止健康的权威 LEDGER 写入", async () => {
    const attemptedIds = new Map<string, string>();
    const attemptedStore = {
      load: () => attemptedIds,
      mark: (key: string, status: string) => {
        if (key.includes("::transport-failure-receipt::")) {
          throw new Error("ENOSPC：追加待处理回执失败");
        }
        return attemptedIds.set(key, status);
      },
    };
    const ledger: string[] = [];
    const { deliver, posts, logs } = deliverHarness({
      postStatuses: [500, 200],
      attemptedStore,
      onTransportFailed: (_p, cls) => ledger.push(`failed:${cls}`),
      onPostedImpl: () => ledger.push("posted"),
    });

    const first = await deliver(DECISION("q-tf-pending-store") as never);
    const second = await deliver(DECISION("q-tf-pending-store") as never);
    expect({
      firstClass: first.ok ? null : first.class,
      secondOk: second.ok,
      ledger,
      posts: posts.length,
      claimedRetained: logs.some((message) => message.includes("retained")),
    }).toEqual({
      firstClass: "http-500",
      secondOk: true,
      ledger: ["failed:http-500", "posted"],
      posts: 2,
      claimedRetained: false,
    });
  });

  it("通过修复消除 8f291c37 模式：成功发送后回执写入抛错会明确保留，并在下一 tick 修复且只发送一次", async () => {
    let receiptCalls = 0;
    let throwOnce = true;
    const receipts: string[] = [];
    const { deliver, posts } = deliverHarness({
      onPostedImpl: (_p, ts) => {
        receiptCalls++;
        if (throwOnce) { throwOnce = false; throw new Error("SQLITE_BUSY：回执写入失败"); }
        receipts.push(ts);
      },
    });
    const first = await deliver(DECISION("q-rc-1") as never);
    expect(first.ok, "发送后回执崩溃会得到明确的 RETAINED 结果，异常绝不外逸").toBe(false);
    // 下一 tick：重放同一 decision——走按标记协调路径或幂等重投
    const second = await deliver(DECISION("q-rc-1") as never);
    expect(second.ok).toBe(true);
    expect(receipts, "修复时回执成功落地").toHaveLength(1);
    expect(posts, "修复绝不会重复通知人员").toHaveLength(1);
    expect(receiptCalls).toBe(2);
  });

  it("UNDELIVERED 根据 ledger 如实呈现，而非依赖 nudge 字面量（消除 34a6ad0b 矛盾）", async () => {
    // 行 A：gateway-routed，已 POSTED（存在回执转换），但 nudge 字面量显示失败。
    const a = await h.repo.create({ sourceSession: "s@r", destinationSession: "human-founder@external", body: "a", summary: "a", evidenceRef: EVIDENCE, nudge: false });
    h.db.prepare("UPDATE queue_items SET last_nudge_result = 'failed: stale poison literal', last_nudge_attempt = datetime('now') WHERE qitem_id = ?").run(a.qitemId);
    receipt(a.qitemId, "posted", "level=ALERT kind=unclassified message_ts=111.22 thread_ts=111.22");
    // 行 B：gateway-routed，存在 TRANSPORT-FAILED 转换。
    const b = await h.repo.create({ sourceSession: "s@r", destinationSession: "human-founder@external", body: "b", summary: "b", evidenceRef: EVIDENCE, nudge: false });
    receipt(b.qitemId, "transport-failed", "class=http-500 error=internal-server-error");
    // 行 C：gateway-routed，无回执，早于发送窗口。
    const c = await h.repo.create({ sourceSession: "s@r", destinationSession: "human-founder@external", body: "c", summary: "c", evidenceRef: EVIDENCE, nudge: false });
    ageCurrentEpisode(c.qitemId);

    const und = h.repo.findUndelivered({});
    const ids = und.map((u) => u.qitemId);
    expect(ids, "无论 nudge 支路如何描述，POSTED 行都绝不是未投递").not.toContain(a.qitemId);
    expect(ids, "transport-failed 行属于未投递").toContain(b.qitemId);
    expect(ids, "超过发送窗口且无回执的 gateway 行属于未投递（never-posted）").toContain(c.qitemId);
    const byId = new Map(und.map((u) => [u.qitemId, u as unknown as { deliveryFailureClass?: string }]));
    expect(byId.get(b.qitemId)?.deliveryFailureClass ?? (byId.get(b.qitemId) as { deliveryClass?: string })?.deliveryClass, "class 会指明 gateway 错误").toMatch(/transport-failed/);
    expect(byId.get(c.qitemId)?.deliveryFailureClass ?? (byId.get(c.qitemId) as { deliveryClass?: string })?.deliveryClass).toMatch(/never-posted/);
  });

  it("当前 EPISODE 优先：旧 posted 回执不能掩盖后来失败的 human-park episode", async () => {
    const row = await h.repo.create({ sourceSession: "s@r", destinationSession: "orch-lead@v-openrig-build", body: "ask", nudge: false });
    const firstKey = await humanPark(row.qitemId, "episode A");
    receipt(row.qitemId, "posted", "message_ts=100.1 thread_ts=100.1");
    h.repo.update({ qitemId: row.qitemId, actorSession: "orch-lead@v-openrig-build", state: "in-progress", transitionNote: "episode A consumed" });
    const secondKey = await humanPark(row.qitemId, "episode B");
    expect(secondKey).not.toBe(firstKey);
    receipt(row.qitemId, "transport-failed", "class=http-500 error=episode-b-needle");

    expect(h.repo.deliveryOutcomeFor(row.qitemId)).toMatchObject({ outcome: "transport-failed" });
    const failed = h.repo.findUndelivered({}).find((item) => item.qitemId === row.qitemId) as
      | { deliveryFailureDetail?: string }
      | undefined;
    expect(failed?.deliveryFailureDetail, "消费者保留 gateway 的真实错误证据").toContain("episode-b-needle");
    expect(h.repo.getById(row.qitemId)?.deliveryFailureDetail, "queue show/--verify 行视图保留相同错误证据").toContain("episode-b-needle");
  });

  it("注册表不可读属于 INDETERMINATE：不能用 episode A 的 posted 覆盖 episode B 的失败", async () => {
    let registryReadable = true;
    h = makeHarness({ registryReadable: () => registryReadable });
    const row = await h.repo.create({ sourceSession: "s@r", destinationSession: "orch-lead@v-openrig-build", body: "ask", nudge: false });
    await humanPark(row.qitemId, "episode A");
    receipt(row.qitemId, "posted", "message_ts=300.1 thread_ts=300.1");
    h.repo.update({ qitemId: row.qitemId, actorSession: "orch-lead@v-openrig-build", state: "in-progress", transitionNote: "episode A consumed" });
    await humanPark(row.qitemId, "episode B");
    receipt(row.qitemId, "transport-failed", "class=http-500 error=episode-b-registry-needle");
    registryReadable = false;

    const surfaced = h.repo.findUndelivered({}).some((item) => item.qitemId === row.qitemId);
    expect({ outcome: h.repo.deliveryOutcomeFor(row.qitemId)?.outcome ?? null, surfaced }).toEqual({
      outcome: null,
      surfaced: false,
    });
  });

  it("已消费 EPISODE 会清除：恢复后的非人员行不能继承旧的失败 human-park 回执", async () => {
    const row = await h.repo.create({ sourceSession: "s@r", destinationSession: "orch-lead@v-openrig-build", body: "ask", nudge: false });
    await humanPark(row.qitemId, "episode A");
    receipt(row.qitemId, "transport-failed", "class=http-500 error=episode-a-consumed");
    h.repo.update({ qitemId: row.qitemId, actorSession: "orch-lead@v-openrig-build", state: "in-progress", transitionNote: "episode A consumed" });

    const surfaced = h.repo.findUndelivered({}).some((item) => item.qitemId === row.qitemId);
    expect({ outcome: h.repo.deliveryOutcomeFor(row.qitemId)?.outcome ?? null, surfaced }).toEqual({
      outcome: null,
      surfaced: false,
    });
  });

  it("当前 EPISODE 窗口：无回执的重新停放与直接无 nudge 人员从 episode 时间起变为 never-posted", async () => {
    const parked = await h.repo.create({ sourceSession: "s@r", destinationSession: "orch-lead@v-openrig-build", body: "ask", nudge: false });
    await humanPark(parked.qitemId, "episode A");
    receipt(parked.qitemId, "posted", "message_ts=200.1 thread_ts=200.1");
    h.repo.update({ qitemId: parked.qitemId, actorSession: "orch-lead@v-openrig-build", state: "in-progress", transitionNote: "episode A consumed" });
    const secondKey = await humanPark(parked.qitemId, "episode B");
    h.repo.update({ qitemId: parked.qitemId, actorSession: "watchdog@system", transitionNote: "unchanged wake" });
    expect(currentEpisodeKey(parked.qitemId), "未变化的唤醒仍位于 episode B 内").toBe(secondKey);
    ageCurrentEpisode(parked.qitemId);

    const direct = await h.repo.create({
      sourceSession: "s@r",
      destinationSession: "human-founder@external",
      body: "直接发送给无 nudge 人员",
      summary: "direct",
      evidenceRef: EVIDENCE,
      nudge: false,
    });
    ageCurrentEpisode(direct.qitemId);

    expect(h.repo.deliveryOutcomeFor(parked.qitemId)).toMatchObject({ outcome: "never-posted" });
    const undelivered = h.repo.findUndelivered({});
    expect(undelivered.find((item) => item.qitemId === parked.qitemId)?.deliveryOutcome).toBe("never-posted");
    expect(undelivered.find((item) => item.qitemId === direct.qitemId)?.deliveryOutcome).toBe("never-posted");
  });

  it("行视图读取投递状态：gateway-routed 行显示 posted/transport-failed/never-posted；pane-bound 行保持精确键", async () => {
    const posted = await h.repo.create({ sourceSession: "s@r", destinationSession: "human-founder@external", body: "p", summary: "p", evidenceRef: EVIDENCE, nudge: false });
    receipt(posted.qitemId, "posted", "level=ALERT kind=unclassified message_ts=222.33 thread_ts=222.33");
    const face = h.repo.getById(posted.qitemId) as unknown as { deliveryOutcome?: string | null };
    expect(face.deliveryOutcome, "已发送的 gateway 行可在一次读取中回答是否送达").toMatch(/posted/);
    const listFace = h.repo.list({ limit: 100 }).find((item) => item.qitemId === posted.qitemId) as
      | { deliveryOutcome?: string | null }
      | undefined;
    expect(listFace?.deliveryOutcome, "list 与 show 投影同一行 ledger 裁决").toBe("posted");

    const pane = await h.repo.create({ sourceSession: "s@r", destinationSession: "dev-a@rig1", body: "n", nudge: true });
    const paneFace = h.repo.getById(pane.qitemId) as unknown as { deliveryOutcome?: string | null };
    expect(paneFace.deliveryOutcome ?? null, "pane-bound 行不携带 gateway 投递结果（字段不说谎）").toBeNull();
  });

  it("UNDELIVERED 限制如实执行：posted 行不能占用窗口并隐藏后续 gateway 故障", async () => {
    const posted = await h.repo.create({ sourceSession: "s@r", destinationSession: "human-founder@external", body: "p", summary: "p", evidenceRef: EVIDENCE, nudge: false });
    receipt(posted.qitemId, "posted", "level=ALERT kind=unclassified message_ts=444.55 thread_ts=444.55");
    const failed = await h.repo.create({ sourceSession: "s@r", destinationSession: "human-founder@external", body: "f", summary: "f", evidenceRef: EVIDENCE, nudge: false });
    receipt(failed.qitemId, "transport-failed", "class=http-500 error=failed");
    expect(h.repo.findUndelivered({ limit: 1 }).map((item) => item.qitemId)).toEqual([failed.qitemId]);
  });

  it("下限：绑定回执的 episode 去重保持有效——第二次相同回执写入为空操作", async () => {
    const row = await h.repo.create({ sourceSession: "s@r", destinationSession: "human-founder@external", body: "d", summary: "d", evidenceRef: EVIDENCE, nudge: false });
    const key = currentEpisodeKey(row.qitemId);
    const note = "slack-owner-notification-posted notification_key=" + key + " level=ALERT kind=unclassified message_ts=333.44 thread_ts=333.44";
    h.repo.update({ qitemId: row.qitemId, actorSession: "daemon@kernel", transitionNote: note });
    expect(h.repo.transitionLog.hasOwnerNotificationReceipt(row.qitemId, key), "回执会抑制重复操作").toBe(true);
  });
});
