import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { queueRoutes } from "../src/routes/queue.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { archiveAgedTerminalTransitions } from "../src/domain/queue-retention.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { buildOutboundMessage, escapeSlackText, reconcileToken } from "../src/domain/gateway/slack/message.js";
import { subsystemSlackDeliver } from "../src/domain/gateway/slack/slack-delivery.js";
import { SeenStore } from "../src/domain/gateway/slack/state-store.js";
import { makeQueuePorts } from "../src/domain/gateway/slack/queue-access.js";
import { buildSlackGatewayWire, makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import { DEFAULT_CONFIG, saveConfig } from "../src/domain/gateway/slack/config.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { runDeliveryDigestFlush } from "../src/domain/policies/delivery-digest-flush.js";
import type { OutboundDecision } from "../src/domain/gateway/protocol.js";
import type { FetchImpl } from "../src/domain/gateway/slack/slack-api.js";

const registry = { ok: true as const, entities: [{ entityId: "human-founder", class: "human" as const, displayName: "Founder", address: "human-founder@external", connectorBindings: [{ kind: "slack" as const, connectorRef: "primary", secretsRef: "env:SLACK_BOT_TOKEN", role: "primary" as const, handle: "UFOUNDER" }], prefs: { deliveryClass: "A" as const } }] };
const request = { sourceSession: "author@rig", destinationSession: "human-founder@external", summary: "Use the repaired view?", body: "Why: restores readable status. Recommendation: proceed; status briefly pauses. Approve or hold?", evidenceRef: "/private/retained-proof.md", nudge: false };
const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("完整的人工通知", () => {
  let home: string;
  let db: ReturnType<typeof createDb>;
  let repo: QueueRepository;
  const stops: Array<() => void> = [];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "complete-human-"));
    db = createDb(); migrate(db, ALL_MIGRATIONS);
    repo = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => registry });
  });
  afterEach(() => { for (const stop of stops.splice(0)) stop(); db.close(); rmSync(home, { recursive: true, force: true }); });

  it("在 block 和无障碍 fallback 中完整保留超过旧摘要限制的 action", () => {
    const body = "Context. ".repeat(100) + "\nAction: approve or hold.";
    const result = buildOutboundMessage({ qitemId: "q", summary: "Decision", body }, { sourceLabel: "proof", bodyExcerpt: 1, reconcileMarker: reconcileToken("d") });
    expect(result.text).toContain(body);
    expect(JSON.stringify(result.blocks)).toContain("Action: approve or hold.");
    expect(result.text).toContain(reconcileToken("d"));
  });

  it("处理实际转义后的 section 边界，不截断 Unicode 或 entity", () => {
    const body = "😀".repeat(1498) + "<&";
    expect(() => buildOutboundMessage({ qitemId: "q", body }, { sourceLabel: "proof" })).toThrow(/上限 3000/);
    const fits = "😀".repeat(1495) + "<&";
    const result = buildOutboundMessage({ qitemId: "q", body: fits }, { sourceLabel: "proof" });
    expect(result.text).toContain(escapeSlackText(fits));
    expect(result.text).not.toContain("\uFFFD");
  });

  it("显式拒绝 subject、fallback 和附件溢出", () => {
    expect(() => buildOutboundMessage({ qitemId: "q", summary: "x".repeat(3000) }, { sourceLabel: "proof" })).toThrow(/subject/);
    expect(() => buildOutboundMessage({ qitemId: "q", summary: "s".repeat(1000), body: "b".repeat(2900) }, { sourceLabel: "proof" })).toThrow(/完整 fallback/);
    expect(() => buildOutboundMessage({ qitemId: "q", body: "safe" }, { sourceLabel: "proof", mediaRefs: [{ imageUrl: "https://example.invalid/a.png", altText: "x".repeat(2001) }] })).toThrow(/图片描述/);
    const result = buildOutboundMessage({ qitemId: "q", body: "No action needed." }, { sourceLabel: "proof", mediaRefs: [{ imageUrl: "https://example.invalid/a.png", altText: "Capacity graph" }] });
    expect(result.text).toContain("图片：Capacity graph");
  });

  it("保留旧版 decision，并在不推断 prose/tag 的情况下分类显式 update", async () => {
    const legacy = await repo.create({ ...request, body: "FYI no action needed", tags: ["informational"] });
    const update = await repo.create({ ...request, humanIntent: "update", tags: ["escalation"], humanDetail: "Retained supplemental context." });
    const rows = await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({});
    expect(rows.find((q) => q.qitemId === legacy.qitemId)).toMatchObject({ ownerNotificationKind: "human-required", ownerNotificationLevel: "ALERT" });
    expect(rows.find((q) => q.qitemId === update.qitemId)).toMatchObject({ humanIntent: "update", humanDetail: "Retained supplemental context.", ownerNotificationKind: "human-update", ownerNotificationLevel: "NOTICE" });
    expect(repo.listAttention().map((q) => q.qitemId)).toEqual([legacy.qitemId]);
    expect(repo.list({ compact: true }).find((q) => q.qitemId === update.qitemId)?.humanIntent).toBe("update");
    const work = await repo.create({ ...request, destinationSession: "worker@rig" });
    expect(() => repo.update({ qitemId: work.qitemId, actorSession: "worker@rig", state: "blocked", blockedOn: update.qitemId, transitionNote: "await update" })).toThrow(/不是审批依赖/);
    await expect(repo.create({ ...request, humanIntent: "urgent" as never })).rejects.toThrow(/decision 或 update/);
    await expect(repo.create({ ...request, destinationSession: "worker@rig", humanIntent: "update" })).rejects.toThrow(/human destination/);
  });

  it("在 LIMIT 前应用 canonical external/legacy 谓词，tier/格式错误/非人工行无法将其挤出", async () => {
    const external = await repo.create(request);
    const legacy = await repo.create({ ...request, destinationSession: "human-founder@kernel" });
    const parked = await repo.create({ ...request, destinationSession: "worker@rig" });
    db.prepare("UPDATE queue_items SET state='blocked', blocked_on='human-founder@external' WHERE qitem_id=?").run(parked.qitemId);
    for (const destinationSession of ["human-@kernel", "@external", "x@external@host", "worker@rig", "human-founder@external.invalid"]) {
      const row = await repo.create({ ...request, destinationSession: "worker@rig" });
      db.prepare("UPDATE queue_items SET destination_session=?, tier='human-gate', ts_created='2099-01-01' WHERE qitem_id=?").run(destinationSession, row.qitemId);
    }
    expect(repo.listAttention({ limit: 3 }).map((q) => q.qitemId).sort()).toEqual([external.qitemId, legacy.qitemId, parked.qitemId].sort());
  });

  it.each([false, true])("跨重建时只续传缺失或不确定的补充部分（landed=%s）", async (landed) => {
    const posted: Array<{ text: string; ts: string; thread_ts?: string }> = [];
    let calls = 0;
    const fetchImpl: FetchImpl = async (url, init) => {
      if (!url.endsWith("chat.postMessage")) return reply({ ok: true, messages: posted });
      const content = JSON.parse(String(init?.body)); calls++;
      const msg = { ...content, ts: `${100 + calls}.1` };
      if (calls !== 2 || landed) posted.push(msg);
      if (calls === 2) throw new Error("synthetic timeout");
      return reply({ ok: true, ts: msg.ts });
    };
    const delivered = new SeenStore(join(home, "delivered"));
    const attempted = new SeenStore(join(home, "attempted"));
    const outboundSeen = new SeenStore(join(home, "seen"));
    const onPosted = vi.fn();
    const opts = { botToken: "synthetic", channel: "C-TEST", sourceLabel: "fixture", fetchImpl, delivered, attempted, outboundSeen, onPosted };
    const decision: OutboundDecision = { kind: "outbound_decision", decisionId: "stable", op: "post_message", entityBindingRef: request.destinationSession, payload: { ...request, qitemId: "q", humanDetail: "Supplemental context only." } };
    expect((await subsystemSlackDeliver(opts)(decision)).ok).toBe(false);
    expect(onPosted).not.toHaveBeenCalled();
    expect(outboundSeen.load().has("q")).toBe(false);
    expect(delivered.load().has("stable")).toBe(false);
    expect((await subsystemSlackDeliver(opts)(decision)).ok).toBe(true);
    expect(calls).toBe(landed ? 2 : 3);
    expect(posted.filter((p) => !p.thread_ts)).toHaveLength(1);
    expect(posted[1]?.thread_ts).toBe("101.1");
    expect(onPosted).toHaveBeenCalledTimes(1);
    expect(delivered.load().has("stable")).toBe(true);
    expect((await subsystemSlackDeliver(opts)(decision)).ok).toBe(true);
    expect(calls).toBe(landed ? 2 : 3);
  });

  it("预检每个部分：无效补充内容不会发送任何帖子，并给出可见修正提示", async () => {
    const fetchImpl = vi.fn(); const failed = vi.fn();
    const deliver = subsystemSlackDeliver({ botToken: "synthetic", channel: "C", sourceLabel: "fixture", fetchImpl, delivered: new SeenStore(join(home, "d")), attempted: new SeenStore(join(home, "a")), outboundSeen: new SeenStore(join(home, "s")), onTransportFailed: failed });
    const result = await deliver({ kind: "outbound_decision", decisionId: "d", op: "post_message", entityBindingRef: request.destinationSession, payload: { ...request, qitemId: "q", humanDetail: "x".repeat(3001) } });
    expect(result).toMatchObject({ ok: false, class: "human-message-unrenderable" });
    expect(fetchImpl).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledOnce();
  });

  it("无需人工 decision 即可完成 queue→wire→完整静默多部分投递→done，并保留有界 Feed 历史", async () => {
    const item = await repo.create({ ...request, humanIntent: "update", body: "The release is ready. No action needed.", humanDetail: "Known limit: this is synthetic delivery proof.", tags: ["escalation"] });
    const secrets = join(home, "fake.env"); writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n");
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-TEST", secretsEnvFile: secrets, minimumLevelThatInterrupts: "NOTICE" }, home);
    const posts: Array<Record<string, unknown>> = [];
    const wire = buildSlackGatewayWire({ home, queueRepo: repo, registry: { loadHumanRegistry: () => registry, resolveSlackHandle }, fetchImpl: async (_url, init) => { posts.push(JSON.parse(String(init?.body))); return reply({ ok: true, ts: `${posts.length}.1` }); } });
    stops.push(() => wire.stop()); wire.startServices?.();
    const [alert] = await makeQueuePorts(repo, { loadHumanRegistry: () => registry }).listHumanAlerts({});
    expect(wire.dispatcher.dispatch("post_message", request.destinationSession, alert)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(repo.getById(item.qitemId)?.state).toBe("done"));
    expect(posts).toHaveLength(2); expect(JSON.stringify(posts)).not.toContain("<@UFOUNDER>");
    expect(posts[1]?.thread_ts).toBe(posts[0] ? "1.1" : "missing");
    const history = repo.listDeliveredHumanUpdates({ limit: 1 });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ qitemId: item.qitemId, state: "done", humanIntent: "update", evidenceRef: request.evidenceRef });
    expect(history[0]?.deliveryReceipt).toContain("kind=human-update");
    expect(repo.listTransitions(item.qitemId).some((t) => t.ownerNotificationKind === "human-decision-resolved")).toBe(false);
    const act = vi.fn();
    expect(await makeHumanReplyResolver(repo, { act } as never)({ qitemId: item.qitemId, actorSession: request.destinationSession, decision: "Thanks" } as never)).toBe("not-applicable");
    expect(act).not.toHaveBeenCalled();
    // 无需让 terminal transition 保持热状态，仍可查询保留的 receipt。
    archiveAgedTerminalTransitions(db, { nowIso: "2099-01-02T00:00:00Z", batchSize: 10 });
    expect(repo.listDeliveredHumanUpdates({ limit: 1 })[0]?.qitemId).toBe(item.qitemId);
  });

  it("所有部分落地后修复最终 receipt，且不重复任何部分", async () => {
    let posts = 0;
    const onPosted = vi.fn().mockImplementationOnce(() => { throw new Error("synthetic receipt failure"); });
    const opts = { botToken: "synthetic", channel: "C", sourceLabel: "fixture", delivered: new SeenStore(join(home, "d")), attempted: new SeenStore(join(home, "a")), outboundSeen: new SeenStore(join(home, "s")), onPosted,
      fetchImpl: async () => reply({ ok: true, ts: `${++posts}.1` }) };
    const decision: OutboundDecision = { kind: "outbound_decision", decisionId: "receipt-repair", op: "post_message", entityBindingRef: request.destinationSession, payload: { ...request, qitemId: "q", humanDetail: "Related context." } };
    expect(await subsystemSlackDeliver(opts)(decision)).toMatchObject({ ok: false, class: "receipt-failed" });
    expect(posts).toBe(2); expect(opts.outboundSeen.load().has("q")).toBe(false);
    expect(await subsystemSlackDeliver(opts)(decision)).toEqual({ ok: true });
    expect(posts).toBe(2); expect(onPosted).toHaveBeenCalledTimes(2);
  });

  it("通过 HTTP 公开增量 intent，并以如实截断限制已投递历史", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => { (c.set as (k: string, v: unknown) => void)("queueRepo", repo); await next(); });
    app.route("/api/queue", queueRoutes());
    const create = (value: unknown) => app.request("/api/queue/create", { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": request.sourceSession }, body: JSON.stringify(value) });
    expect((await create({ ...request, humanIntent: "arbitrary" })).status).toBe(400);
    for (let i = 0; i < 2; i++) {
      const response = await create({ ...request, humanIntent: "update", humanDetail: `Supplement ${i}` });
      expect(response.status).toBe(201);
      const item = await response.json(); expect(item.humanIntent).toBe("update");
      expect(item.humanDetail).toBe(`Supplement ${i}`);
      repo.update({ qitemId: item.qitemId, actorSession: "daemon@kernel", state: "done", closureReason: "no-follow-on", transitionNote: `slack-owner-notification-posted notification_key=${item.qitemId}:fixture level=NOTICE kind=human-update message_ts=${i}.1` });
    }
    const result = await (await app.request("/api/queue/human-updates?limit=1")).json();
    expect(result).toMatchObject({ limit: 1, truncated: true }); expect(result.items).toHaveLength(1);
    expect(result.items[0].deliveryReceipt).toContain("kind=human-update");
    expect((await app.request("/api/queue/human-updates?limit=101")).status).toBe(400);
    expect(await (await app.request("/api/queue/list?attention=1")).json()).toEqual([]);
  });

  it("让投递失败的 FYI 保持 pending，且不进入已投递历史", async () => {
    const item = await repo.create({ ...request, humanIntent: "update" });
    expect(item.state).toBe("pending"); expect(repo.listDeliveredHumanUpdates()).toEqual([]);
    repo.update({ qitemId: item.qitemId, actorSession: "daemon@kernel", transitionNote: "slack-owner-notification-transport-failed notification_key=x class=transport error=synthetic" });
    expect(repo.getById(item.qitemId)?.state).toBe("pending"); expect(repo.listDeliveredHumanUpdates()).toEqual([]);
  });

  it("保留 digest 时序，同时以稳定 identity 完整分发每个人工 request/update", async () => {
    for (const humanIntent of ["decision", "update"] as const) {
      const item = await repo.create({ ...request, humanIntent, humanDetail: "Supplemental detail." });
      const key = `${item.qitemId}:${repo.transitionLog.latestOwnerNotificationForQitem(item.qitemId)!.transitionId}`;
      repo.update({ qitemId: item.qitemId, actorSession: "daemon@kernel", transitionNote: `delivery-decision: digest window=4h notification_key=${key}` });
    }
    const dispatch = vi.fn(() => ({ ok: true }));
    const input = { queueRepo: repo, registry: { loadHumanRegistry: () => registry }, home, dispatch, window: "4h" as const };
    expect(await runDeliveryDigestFlush(input)).toEqual({ dispatched: 2, members: 2 });
    const first = dispatch.mock.calls as unknown as Array<[string, string, Record<string, unknown>, { decisionId: string }]>;
    expect(first.every((call) => call[2].body === request.body && call[2].humanDetail === "Supplemental detail.")).toBe(true);
    const ids = first.map((call) => call[3].decisionId);
    await runDeliveryDigestFlush(input);
    expect((dispatch.mock.calls.slice(2) as unknown as typeof first).map((call) => call[3].decisionId)).toEqual(ids);
  });
});
