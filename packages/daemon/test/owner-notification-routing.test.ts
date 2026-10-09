import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import * as transitionModule from "../src/domain/queue-transition-log.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { filterHumanAlerts, makeQueuePorts, type QueueItem } from "../src/domain/gateway/slack/queue-access.js";
import { SlackOutboundDriver } from "../src/domain/gateway/slack/outbound-driver.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/domain/gateway/slack/config.js";
import { SeenStore, DeadLetterStore } from "../src/domain/gateway/slack/state-store.js";
import { buildSlackGatewayWire, makeHumanReplyResolver } from "../src/domain/gateway/slack/slack-subsystem.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import { OUTBOUND_OP } from "../src/domain/gateway/slack/outbound-driver.js";
import { resolveSlackHandle } from "../src/domain/gateway/human-registry.js";
import { ThreadSeatMap } from "../src/domain/gateway/slack/thread-seat-map.js";
import { makeThreadRouteResolver } from "../src/domain/gateway/slack/thread-routing.js";
import { InboundRouter, type SlackEvent } from "../src/domain/gateway/slack/inbound.js";

const registry = {
  ok: true as const,
  entities: [{
    entityId: "human-founder",
    class: "human" as const,
    displayName: "创始人",
    address: "human-founder@external",
    connectorBindings: [{
      kind: "slack" as const,
      connectorRef: "primary",
      secretsRef: "env:SLACK_BOT_TOKEN",
      role: "primary" as const,
      handle: "UFOUNDER",
    }],
    prefs: { deliveryClass: "A" as const },
  }],
};

function ensureFinalColumns(db: Database.Database): void {
  for (const table of ["queue_transitions", "queue_transitions_archive"]) {
    const names = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name));
    if (!names.has("owner_notification_kind")) db.exec(`ALTER TABLE ${table} ADD COLUMN owner_notification_kind TEXT`);
    if (!names.has("owner_notification_level")) db.exec(`ALTER TABLE ${table} ADD COLUMN owner_notification_level TEXT`);
  }
}

function levels(): readonly string[] | undefined {
  return (transitionModule as unknown as { OWNER_NOTIFICATION_LEVELS?: readonly string[] }).OWNER_NOTIFICATION_LEVELS;
}

describe("S14 owner notification——系统通知，而非记忆中的 tag", () => {
  let db: Database.Database;
  let bus: EventBus;
  let repo: QueueRepository;
  let home: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    ensureFinalColumns(db); // 最终测试代码可在原始 076 前基线上运行
    bus = new EventBus(db);
    repo = new QueueRepository(db, bus, { loadHumanRegistry: () => registry } as never);
    home = mkdtempSync(join(tmpdir(), "s14-owner-notify-"));
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("定义一套有序 OWNER 词汇、archive 一致性及普通/直接面向人类矩阵", async () => {
    expect(levels()).toEqual(["RECORD", "NOTICE", "ALERT"]);
    expect(ALL_MIGRATIONS.map(({ name }) => name)).toContain("076_owner_notification_levels.sql");
    for (const table of ["queue_transitions", "queue_transitions_archive"]) {
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
      expect(columns).toContain("owner_notification_kind");
      expect(columns).toContain("owner_notification_level");
    }

    const ordinary = await repo.create({ sourceSession: "a@rig", destinationSession: "b@rig", body: "普通请求", nudge: false });
    expect(db.prepare(
      "SELECT owner_notification_kind, owner_notification_level FROM queue_transitions WHERE qitem_id=? ORDER BY transition_id DESC LIMIT 1",
    ).get(ordinary.qitemId)).toEqual({ owner_notification_kind: null, owner_notification_level: null });

    const direct = await repo.create({
      sourceSession: "orch-lead@v-openrig-build",
      destinationSession: "human-founder@kernel",
      body: "直接决策",
      summary: "创始人直接决策",
      evidenceRef: "/proof/direct.md",
      nudge: false,
    });
    expect(db.prepare(
      "SELECT owner_notification_kind, owner_notification_level FROM queue_transitions WHERE qitem_id=? ORDER BY transition_id DESC LIMIT 1",
    ).get(direct.qitemId)).toEqual({ owner_notification_kind: "human-required", owner_notification_level: "ALERT" });

    const handed = await repo.handoff({
      qitemId: ordinary.qitemId,
      fromSession: "b@rig",
      toSession: "human-founder@kernel",
      body: "交接决策",
      summary: "交接给创始人的决策",
      evidenceRef: "/proof/handoff.md",
      nudge: false,
    });
    expect(db.prepare(
      "SELECT owner_notification_kind, owner_notification_level FROM queue_transitions WHERE qitem_id=? ORDER BY transition_id DESC LIMIT 1",
    ).get(handed.created.qitemId)).toEqual({ owner_notification_kind: "human-required", owner_notification_level: "ALERT" });
  });

  it("默认发布 NOTICE 并以 ALERT 中断，拒绝未知 level，且没有 tag classifier", () => {
    const cfg = loadConfig(home) as Record<string, unknown>;
    expect(cfg.minimumLevelThatPosts).toBe("NOTICE");
    expect(cfg.minimumLevelThatInterrupts).toBe("ALERT");
    expect(DEFAULT_CONFIG).not.toHaveProperty("alertTag");
    writeFileSync(join(home, "slack-connector.json"), JSON.stringify({ ...DEFAULT_CONFIG, alertTag: "founder-alert" }));
    expect(loadConfig(home)).not.toHaveProperty("alertTag");
    expect(filterHumanAlerts([{
      qitemId: "qitem-legacy-tag",
      destinationSession: "human-founder@external",
      tags: ["founder-alert"],
      state: "pending",
    }], { alertTag: "founder-alert", minimumLevel: "NOTICE" } as never)).toEqual([]);
    expect(() => saveConfig({ ...DEFAULT_CONFIG, minimumLevelThatPosts: "LOUD" } as never, home)).toThrow(/minimumLevelThatPosts.*RECORD.*NOTICE.*ALERT/i);
  });

  it("只路由一次实时 human-blocker 形态，解析别名，并把回复返回给行 owner", async () => {
    const row = await repo.create({
      sourceSession: "dev-qa@v-openrig-build",
      destinationSession: "orch-lead@v-openrig-build",
      body: "还剩两项创始人决策",
      priority: "critical",
      tier: "deep",
      tags: ["founder-gated"],
      nudge: false,
    });
    repo.update({
      qitemId: row.qitemId,
      actorSession: "orch-lead@v-openrig-build",
      state: "blocked",
      blockedOn: "human-founder@kernel",
      summary: "需要创始人决策",
      evidenceRef: "/proof/SPEC.md",
      transitionNote: "已 park，并附精确继续方式",
    });

    const parked = db.prepare(
      "SELECT transition_id, owner_notification_kind, owner_notification_level FROM queue_transitions WHERE qitem_id=? ORDER BY transition_id DESC LIMIT 1",
    ).get(row.qitemId) as Record<string, unknown>;
    expect(parked).toMatchObject({ owner_notification_kind: "human-required", owner_notification_level: "ALERT" });

    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    const first = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      qitemId: row.qitemId,
      destinationSession: "human-founder@external",
      sourceSession: "orch-lead@v-openrig-build",
      ownerNotificationLevel: "ALERT",
    });
    expect(first[0]!.notificationKey).toContain(`${row.qitemId}:`);

    const seen = new SeenStore(join(home, "seen.jsonl"));
    seen.mark(first[0]!.notificationKey!, "posted");
    repo.update({ qitemId: row.qitemId, actorSession: "watchdog@system", transitionNote: "15 分钟 park 唤醒，无变化" });
    const unchanged = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
    expect(unchanged[0]!.notificationKey).toBe(first[0]!.notificationKey);
    const quiet = new SlackOutboundDriver({
      home,
      queue: { async listHumanAlerts() { return unchanged; } },
      seen,
      filter: { minimumLevel: "NOTICE" },
      dispatch: () => ({ ok: true, decision: {} as never }),
    });
    expect((await quiet.sweepOnce()).fresh).toBe(0);

    repo.update({ qitemId: row.qitemId, actorSession: "orch-lead@v-openrig-build", state: "in-progress", transitionNote: "决策已消费" });
    repo.update({
      qitemId: row.qitemId,
      actorSession: "orch-lead@v-openrig-build",
      state: "blocked",
      blockedOn: "human-founder@kernel",
      transitionNote: "后续另一项创始人决策",
    });
    const reparks = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
    expect(reparks[0]!.notificationKey).not.toBe(first[0]!.notificationKey);
    const next = new SlackOutboundDriver({
      home,
      queue: { async listHumanAlerts() { return reparks; } },
      seen,
      filter: { minimumLevel: "NOTICE" },
      dispatch: () => ({ ok: true, decision: {} as never }),
    });
    expect((await next.sweepOnce()).fresh).toBe(1);
  });

  it("无需重读 prose，即把专用 queue resolve 操作分类为 NOTICE", async () => {
    const row = await repo.create({
      sourceSession: "dev-qa@v-openrig-build",
      destinationSession: "orch-lead@v-openrig-build",
      body: "等待决策",
      nudge: false,
    });
    repo.update({
      qitemId: row.qitemId,
      actorSession: "orch-lead@v-openrig-build",
      state: "blocked",
      blockedOn: "human-founder@kernel",
      summary: "选择 A 或 B",
      evidenceRef: "/proof/decision.md",
      transitionNote: "已 park",
    });
    const contract = new MissionControlWriteContract({
      db,
      eventBus: bus,
      queueRepo: repo,
      actionLog: new MissionControlActionLog(db),
    });
    await contract.act({
      verb: "resolve",
      qitemId: row.qitemId,
      actorSession: "human-founder@kernel",
      decision: "选择 A",
      notify: false,
    });

    const resolved = db.prepare(
      "SELECT owner_notification_kind, owner_notification_level FROM queue_transitions WHERE qitem_id=? ORDER BY transition_id DESC LIMIT 1",
    ).get(row.qitemId) as Record<string, unknown>;
    expect(resolved).toEqual({ owner_notification_kind: "human-decision-resolved", owner_notification_level: "NOTICE" });

    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    const notices = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
    expect(notices).toEqual([
      expect.objectContaining({
        qitemId: row.qitemId,
        destinationSession: "human-founder@external",
        sourceSession: "orch-lead@v-openrig-build",
        ownerNotificationLevel: "NOTICE",
      }),
    ] satisfies QueueItem[]);
  });

  it("为 root 与 threaded post 写入同行 receipt；ALERT 会中断，NOTICE 保持安静", async () => {
    const row = await repo.create({
      sourceSession: "dev-qa@v-openrig-build",
      destinationSession: "orch-lead@v-openrig-build",
      body: "等待决策",
      nudge: false,
    });
    repo.update({
      qitemId: row.qitemId,
      actorSession: "orch-lead@v-openrig-build",
      state: "blocked",
      blockedOn: "human-founder@kernel",
      summary: "选择 A 或 B",
      evidenceRef: "/proof/decision.md",
      transitionNote: "已 park",
    });
    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    const [alert] = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
    expect(alert).toBeDefined();

    const secrets = join(home, "slack.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n", { mode: 0o600 });
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-OWNER", secretsEnvFile: secrets }, home);
    const posts: Array<Record<string, unknown>> = [];
    const wire = buildSlackGatewayWire({
      home,
      queueRepo: repo,
      registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      outboundIntervalMs: 60_000,
      fetchImpl: async (_url, init) => {
        posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response(JSON.stringify({ ok: true, ts: `1724.000${posts.length}` }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      wire.startServices?.();
      expect(wire.dispatcher.dispatch(OUTBOUND_OP, alert!.destinationSession!, alert)).toMatchObject({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(JSON.stringify(posts[0])).toContain("<@UFOUNDER>");
      expect(await ports.listHumanAlerts({ minimumLevel: "NOTICE" })).toEqual([]);

      const contract = new MissionControlWriteContract({
        db,
        eventBus: bus,
        queueRepo: repo,
        actionLog: new MissionControlActionLog(db),
      });
      await contract.act({
        verb: "resolve",
        qitemId: row.qitemId,
        actorSession: "human-founder@kernel",
        decision: "选择 A",
        notify: false,
      });
      const [notice] = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
      expect(notice?.ownerNotificationLevel).toBe("NOTICE");
      expect(wire.dispatcher.dispatch(OUTBOUND_OP, notice!.destinationSession!, notice)).toMatchObject({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(JSON.stringify(posts[1])).not.toContain("<@UFOUNDER>");
      expect(await ports.listHumanAlerts({ minimumLevel: "NOTICE" })).toEqual([]);

      const receipts = repo.listTransitions(row.qitemId).filter((transition) =>
        transition.transitionNote?.startsWith("slack-owner-notification-posted "),
      );
      expect(receipts).toHaveLength(2);
      expect(receipts[0]!.transitionNote).toContain(`notification_key=${alert!.notificationKey}`);
      expect(receipts[1]!.transitionNote).toContain(`notification_key=${notice!.notificationKey}`);
    } finally {
      wire.stop();
    }
  });

  it("在写入行 receipt 前保留并重放缺少消息时间戳的 ok 响应", async () => {
    const row = await repo.create({
      sourceSession: "dev-qa@v-openrig-build",
      destinationSession: "orch-lead@v-openrig-build",
      body: "等待决策",
      nudge: false,
    });
    repo.update({
      qitemId: row.qitemId,
      actorSession: "orch-lead@v-openrig-build",
      state: "blocked",
      blockedOn: "human-founder@kernel",
      summary: "选择 A 或 B",
      evidenceRef: "/proof/decision.md",
      transitionNote: "已 park",
    });
    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    const [alert] = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
    expect(alert).toBeDefined();

    const secrets = join(home, "slack.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n", { mode: 0o600 });
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-OWNER", secretsEnvFile: secrets }, home);
    let postCalls = 0;
    const fetchImpl = async (url: string | URL) => {
      if (String(url).includes("conversations.history")) {
        return new Response(JSON.stringify({ ok: true, messages: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      postCalls++;
      return new Response(JSON.stringify(postCalls === 1 ? { ok: true } : { ok: true, ts: "1724.9002" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const firstWire = buildSlackGatewayWire({
      home,
      queueRepo: repo,
      registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      outboundIntervalMs: 60_000,
      fetchImpl,
    });
    try {
      expect(firstWire.dispatcher.dispatch(OUTBOUND_OP, alert!.destinationSession!, alert)).toMatchObject({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(postCalls).toBe(1);
      expect(new DispatchBuffer(home).pending()).toHaveLength(1);
      expect(repo.listTransitions(row.qitemId).filter((transition) =>
        transition.transitionNote?.startsWith("slack-owner-notification-posted "),
      )).toEqual([]);
    } finally {
      firstWire.stop();
    }

    const replayWire = buildSlackGatewayWire({
      home,
      queueRepo: repo,
      registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      outboundIntervalMs: 60_000,
      fetchImpl,
    });
    try {
      replayWire.startServices?.();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(postCalls).toBe(2);
      expect(new DispatchBuffer(home).pending()).toEqual([]);
      expect(repo.listTransitions(row.qitemId).filter((transition) =>
        transition.transitionNote?.startsWith("slack-owner-notification-posted "),
      )).toHaveLength(1);
    } finally {
      replayWire.stop();
    }
  });

  it("路由回复前，使用真实 Slack 时间戳校准已送达的 root", async () => {
    const row = await repo.create({
      sourceSession: "dev-qa@v-openrig-build",
      destinationSession: "orch-lead@v-openrig-build",
      body: "等待决策",
      nudge: false,
    });
    repo.update({
      qitemId: row.qitemId,
      actorSession: "orch-lead@v-openrig-build",
      state: "blocked",
      blockedOn: "human-founder@kernel",
      summary: "选择 A 或 B",
      evidenceRef: "/proof/decision.md",
      transitionNote: "已 park",
    });
    const ports = makeQueuePorts(repo, { loadHumanRegistry: () => registry } as never);
    const [alert] = await ports.listHumanAlerts({ minimumLevel: "NOTICE" });
    expect(alert).toBeDefined();

    const secrets = join(home, "slack.env");
    writeFileSync(secrets, "SLACK_BOT_TOKEN=xoxb-EXAMPLE-fake\n", { mode: 0o600 });
    saveConfig({ ...DEFAULT_CONFIG, enabled: true, channel: "C-OWNER", secretsEnvFile: secrets }, home);
    let postCalls = 0;
    let landedText = "";
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("conversations.history")) {
        return new Response(JSON.stringify({
          ok: true,
          messages: [{ text: landedText, ts: "1724.9100" }],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      postCalls++;
      landedText = String((JSON.parse(String(init?.body ?? "{}")) as { text?: string }).text ?? "");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const firstWire = buildSlackGatewayWire({
      home,
      queueRepo: repo,
      registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      outboundIntervalMs: 60_000,
      fetchImpl,
    });
    try {
      expect(firstWire.dispatcher.dispatch(OUTBOUND_OP, alert!.destinationSession!, alert)).toMatchObject({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(postCalls).toBe(1);
      expect(new DispatchBuffer(home).pending()).toHaveLength(1);
    } finally {
      firstWire.stop();
    }

    const replayWire = buildSlackGatewayWire({
      home,
      queueRepo: repo,
      registry: { loadHumanRegistry: () => registry, resolveSlackHandle },
      outboundIntervalMs: 60_000,
      fetchImpl,
    });
    try {
      replayWire.startServices?.();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(postCalls).toBe(1);
      expect(new DispatchBuffer(home).pending()).toEqual([]);

      const receipts = repo.listTransitions(row.qitemId).filter((transition) =>
        transition.transitionNote?.startsWith("slack-owner-notification-posted "),
      );
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.transitionNote).toContain("message_ts=1724.9100");
      expect(receipts[0]!.transitionNote).toContain("thread_ts=1724.9100");

      const resolveRoute = makeThreadRouteResolver({
        map: new ThreadSeatMap(db),
        unroutedDestination: "operator-agent@kernel",
      });
      const reply: SlackEvent = {
        type: "message",
        user: "UFOUNDER",
        text: "选择 A",
        ts: "1724.9101",
        thread_ts: "1724.9100",
        channel: "C-OWNER",
      };
      expect(resolveRoute(reply)).toMatchObject({
        destination: "orch-lead@v-openrig-build",
        routeClass: "existing-thread",
        correlationQitemId: row.qitemId,
      });

      const contract = new MissionControlWriteContract({
        db,
        eventBus: bus,
        queueRepo: repo,
        actionLog: new MissionControlActionLog(db),
      });
      const router = new InboundRouter({
        queue: ports,
        seen: new SeenStore(join(home, "inbound-seen.jsonl")),
        deadLetter: new DeadLetterStore<SlackEvent>(join(home, "inbound-dead.jsonl")),
        destination: "operator-agent@kernel",
        resolveSender: () => ({ admitted: true, source: "human-founder@external" }),
        resolveRoute,
        resolveHumanReply: makeHumanReplyResolver(repo, contract),
      });
      expect(await router.route(reply)).toMatchObject({
        landed: true,
        correlationQitemId: row.qitemId,
        replyResolution: "resolved",
      });
      expect(repo.getById(row.qitemId)).toMatchObject({ state: "in-progress", blockedOn: null });
      expect(repo.listTransitions(row.qitemId).filter((transition) =>
        transition.ownerNotificationKind === "human-decision-resolved",
      )).toHaveLength(1);
      expect(await router.route(reply)).toMatchObject({ landed: false, disposition: "ignored", reason: "dup" });
      expect(repo.listTransitions(row.qitemId).filter((transition) =>
        transition.ownerNotificationKind === "human-decision-resolved",
      )).toHaveLength(1);
    } finally {
      replayWire.stop();
    }
  });

  it("解决直接由人类持有的请求，并恰好唤醒一次来源席位", async () => {
    let nudges = 0;
    const directRepo = new QueueRepository(db, bus, {
      validateRig: () => true,
      loadHumanRegistry: () => registry,
      transport: {
        async send() {
          nudges += 1;
          return { ok: true, verified: true };
        },
      },
    });
    const direct = await directRepo.create({
      sourceSession: "driver@rig",
      destinationSession: "human-founder@external",
      body: "请选择发布方案。",
      summary: "发布方案选择",
      evidenceRef: "proof/release-choice.md",
      tier: "human-gate",
      nudge: false,
    });
    const map = new ThreadSeatMap(db);
    map.open({
      threadTs: "T-DIRECT",
      channel: "C-OWNER",
      human: "human-founder@external",
      seat: "driver@rig",
      conversationId: direct.qitemId,
    });
    const resolver = makeHumanReplyResolver(directRepo, new MissionControlWriteContract({
      db,
      eventBus: bus,
      queueRepo: directRepo,
      actionLog: new MissionControlActionLog(db),
    }));
    const router = new InboundRouter({
      queue: makeQueuePorts(directRepo, { loadHumanRegistry: () => registry }),
      seen: new SeenStore(join(home, "direct-inbound-seen.jsonl")),
      deadLetter: new DeadLetterStore<SlackEvent>(join(home, "direct-inbound-dead.jsonl")),
      destination: "operator-agent@kernel",
      resolveSender: () => ({ admitted: true, source: "human-founder@external" }),
      resolveRoute: makeThreadRouteResolver({ map, unroutedDestination: "operator-agent@kernel" }),
      resolveHumanReply: resolver,
    });
    const reply: SlackEvent = {
      type: "message",
      user: "UFOUNDER",
      text: "采用方案 A。",
      ts: "200.2",
      thread_ts: "T-DIRECT",
      channel: "C-OWNER",
    };

    const beforeRows = directRepo.list({ limit: 100 }).length;
    expect(await router.route(reply)).toMatchObject({
      landed: true,
      correlationQitemId: direct.qitemId,
      replyResolution: "resolved",
    });
    const afterRows = directRepo.list({ limit: 100 }).length;
    expect(directRepo.getById(direct.qitemId)).toMatchObject({
      state: "done",
      closureReason: "no-follow-on",
    });
    const resolved = directRepo.listTransitions(direct.qitemId).filter((transition) =>
      transition.ownerNotificationKind === "human-decision-resolved",
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.transitionNote).not.toContain(reply.text!);
    expect(afterRows - beforeRows).toBe(1);
    expect(nudges).toBe(1);

    expect(await router.route(reply)).toMatchObject({ landed: false, disposition: "ignored", reason: "dup" });
    expect(directRepo.list({ limit: 100 })).toHaveLength(afterRows);
    expect(directRepo.listTransitions(direct.qitemId).filter((transition) =>
      transition.ownerNotificationKind === "human-decision-resolved",
    )).toHaveLength(1);
    expect(nudges).toBe(1);

    const ordinary = await directRepo.create({
      sourceSession: "requester@rig",
      destinationSession: "driver@rig",
      body: "普通请求",
      nudge: false,
    });
    expect(await resolver({
      qitemId: ordinary.qitemId,
      actorSession: "human-founder@external",
      decision: "不是这一行",
    })).toBe("not-applicable");
    expect(directRepo.getById(ordinary.qitemId)?.state).toBe("pending");

    const mismatched = await directRepo.create({
      sourceSession: "driver@rig",
      destinationSession: "human-founder@external",
      body: "另一项选择",
      summary: "另一项选择",
      evidenceRef: "proof/another-choice.md",
      tier: "human-gate",
      nudge: false,
    });
    expect(await resolver({
      qitemId: mismatched.qitemId,
      actorSession: "human-other@external",
      decision: "不是此人",
    })).toBe("not-applicable");
    expect(directRepo.getById(mismatched.qitemId)?.state).toBe("pending");
  });
});
