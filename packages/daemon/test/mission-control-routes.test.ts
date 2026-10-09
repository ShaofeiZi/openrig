import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { viewsCustomSchema } from "../src/db/migrations/030_views_custom.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { rigArchiveSchema } from "../src/db/migrations/042_rig_archive.js";
import { identityProvenanceSchema } from "../src/db/migrations/065_identity_provenance.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { ViewProjector } from "../src/domain/view-projector.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlReadLayer } from "../src/domain/mission-control/mission-control-read-layer.js";
import {
  MissionControlFleetCliCapability,
  makeLocalCliCapabilityProbe,
  LOCAL_CLI_VERSION_LABEL,
} from "../src/domain/mission-control/mission-control-fleet-cli-capability.js";
import { missionControlRoutes } from "../src/routes/mission-control.js";

function buildApp(opts: {
  eventBus: EventBus;
  readLayer: MissionControlReadLayer;
  writeContract: MissionControlWriteContract;
  fleetCli: MissionControlFleetCliCapability;
}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("eventBus" as never, opts.eventBus);
    c.set("missionControlReadLayer" as never, opts.readLayer);
    c.set("missionControlWriteContract" as never, opts.writeContract);
    c.set("missionControlFleetCliCapability" as never, opts.fleetCli);
    await next();
  });
  app.route("/api/mission-control", missionControlRoutes());
  return app;
}

describe("mission-control 路由（PL-005 Phase A）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema, viewsCustomSchema,
      missionControlActionsSchema, rigArchiveSchema,
      identityProvenanceSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    const viewProjector = new ViewProjector(db, bus);
    const streamStore = new StreamStore(db, bus);
    const rigRepo = new RigRepository(db);
    const fleetCli = new MissionControlFleetCliCapability({ db, eventBus: bus, rigRepo });
    const actionLog = new MissionControlActionLog(db);
    const writeContract = new MissionControlWriteContract({ db, eventBus: bus, queueRepo, actionLog });
    const readLayer = new MissionControlReadLayer({
      db, queueRepo, viewProjector, streamStore, fleetCliCapability: fleetCli,
    });
    app = buildApp({ eventBus: bus, readLayer, writeContract, fleetCli });
  });

  afterEach(() => db.close());

  it("GET /views 返回 7 个视图名称", async () => {
    const res = await app.request("/api/mission-control/views");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { views: string[] };
    expect(body.views).toEqual([
      "my-queue", "human-gate", "fleet", "active-work",
      "recent-ships", "recently-active", "recent-observations",
    ]);
  });

  it("GET /views/:view-name 为合法视图返回视图记录", async () => {
    const res = await app.request("/api/mission-control/views/active-work");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { viewName: string; rows: unknown[] };
    expect(body.viewName).toBe("active-work");
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it("GET /views/:view-name 对未知视图返回 404", async () => {
    const res = await app.request("/api/mission-control/views/totally-bogus");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("view_unknown");
  });

  it("POST /action 使用合法 approve 动词时返回 200 和结构化结果", async () => {
    const created = await queueRepo.create({
      sourceSession: "src@rig",
      destinationSession: "dst@rig",
      body: "x",
    });
    const res = await app.request("/api/mission-control/action", {
      method: "POST",
      // P21：actor 来自传输 header（X-OpenRig-Session），而非请求体声明。
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "human@r" },
      body: JSON.stringify({
        verb: "approve",
        qitemId: created.qitemId,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actionId: string; verb: string };
    expect(body.actionId).toMatch(/^[0-9A-Z]{26}$/);
    expect(body.verb).toBe("approve");
  });

  it("POST /action 使用未知动词时返回 400 和 verb_unknown", async () => {
    const res = await app.request("/api/mission-control/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verb: "totally-bogus", qitemId: "x", actorSession: "y" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("verb_unknown");
  });

  it("对终态 qitem 执行 POST /action 时返回 409 和 qitem_already_terminal", async () => {
    const created = await queueRepo.create({ sourceSession: "s@r", destinationSession: "d@r", body: "x" });
    await app.request("/api/mission-control/action", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "h@r" },
      body: JSON.stringify({ verb: "approve", qitemId: created.qitemId }),
    });
    const res = await app.request("/api/mission-control/action", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "h@r" },
      body: JSON.stringify({ verb: "approve", qitemId: created.qitemId }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("qitem_already_terminal");
  });

  it("对缺失 qitem 执行 annotate 时返回 404 和 qitem_not_found", async () => {
    const res = await app.request("/api/mission-control/action", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "human@r" },
      body: JSON.stringify({
        verb: "annotate",
        qitemId: "qitem-missing",
        annotation: "operator note",
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("qitem_not_found");
  });

  // P21 修订（原为“伪造或缺失身份时响亮拒绝”）。这是有意的契约变更：mission-control
  // /action 是创始人可见的 review-actions 表面（d00c468d），浏览器 UI 发出 approve/deny 等操作时
  // 不带该 header（只有 bearer 和请求体 actorSession）。响亮拒绝会破坏一键评审，因此缺少 header
  // 时改为延后处理（把请求体 actor 记录为 declared 的 claimed 时代变体 `claimed:v1`），绝不返回 401。
  // CLI 伪造守卫保持不变：header 存在但请求体声明不同则由线上值覆盖。
  it("P21 review-actions 延后：UI 无 header 时记录 claimed:v1（绝不拒绝或记为 null）；CLI header 记为 transport:v1；body 与 header 不同时以线上值为准（transport:v1，不再返回 409）", async () => {
    const mk = async (body: string) => (await queueRepo.create({ sourceSession: "s@r", destinationSession: "d@r", body })).qitemId;
    const [qUi, qCli, qMm] = [await mk("u"), await mk("c"), await mk("m")];
    const req = (qitemId: string, headers: Record<string, string>, extra: Record<string, unknown> = {}) =>
      app.request("/api/mission-control/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ verb: "annotate", qitemId, annotation: "n", ...extra }),
      });
    const provenanceOf = (qitemId: string) =>
      (db.prepare("SELECT identity_provenance FROM mission_control_actions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1").get(qitemId) as { identity_provenance: string | null } | undefined)?.identity_provenance ?? null;

    // UI 路径：无 header + 请求体 actorSession，不拒绝；记录 claimed 时代的 declared 变体。
    const ui = await req(qUi, {}, { actorSession: "founder@r" });
    expect(ui.status).toBe(200);
    expect(provenanceOf(qUi)).toBe("claimed:v1");

    // CLI 路径：传输 header 存在，推导并盖戳 transport:v1。
    const cli = await req(qCli, { "X-OpenRig-Session": "human@r" });
    expect(cli.status).toBe(200);
    expect(provenanceOf(qCli)).toBe("transport:v1");

    // P18 扫描：header 存在且请求体声明不同，线上值覆盖（200），记录 transport:v1。
    // 此处也退役 409，使本延后辅助函数与 requireSenderIdentity 同级逻辑一致。
    const mismatch = await req(qMm, { "X-OpenRig-Session": "human@r" }, { actorSession: "mallory@r" });
    expect(mismatch.status).toBe(200);
    expect(provenanceOf(qMm)).toBe("transport:v1"); // wire wins; mallory@r superseded
  });

  // P21 反向对照（轨道 4）——防洗白固定测试。没有它，未来重构可能把转发的 claimed 时代 actor
  // 静默升级回 transport:v1，使审计轨迹再次失真。
  it("P21：转发的 claimed 时代 action 记录 claimed:v1（绝不是 transport:v1，禁止洗白）；有 transport 标记时记为 relay:v1，缺少标记时降级为 claimed:v1", async () => {
    const mk = async (body: string) => (await queueRepo.create({ sourceSession: "s@r", destinationSession: "d@r", body })).qitemId;
    const [qClaimed, qTransport, qMissing] = [await mk("a"), await mk("b"), await mk("c")];
    const req = (qitemId: string, headers: Record<string, string>) =>
      app.request("/api/mission-control/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "origin@r", ...headers },
        body: JSON.stringify({ verb: "annotate", qitemId, annotation: "n" }),
      });
    const provenanceOf = (qitemId: string) =>
      (db.prepare("SELECT identity_provenance FROM mission_control_actions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1").get(qitemId) as { identity_provenance: string | null } | undefined)?.identity_provenance ?? null;

    // 转发的 CLAIMED 时代源 actor（标记为 claimed:v1）：来源记录 claimed:v1，绝不是 transport:v1；
    // 未验证 actor 不能仅因跨过一跳就洗白为已验证。
    await req(qClaimed, { "X-OpenRig-Relay": "host-a", "X-OpenRig-Provenance": "claimed:v1" });
    expect(provenanceOf(qClaimed)).toBe("claimed:v1");

    // 转发的 TRANSPORT 已验证 actor：记录 relay:v1（在一跳之外已验证，如实表达距离），
    // 绝不记录 transport:v1（否则会谎称本跳完成验证）。
    await req(qTransport, { "X-OpenRig-Relay": "host-a", "X-OpenRig-Provenance": "transport:v1" });
    expect(provenanceOf(qTransport)).toBe("relay:v1");

    // 轨道 1 默认从弱：没有标记的转发请求（旧转发方）降级到 claimed:v1，绝不是 transport:v1；
    // 缺少标记与 claimed 时代不可区分，二者均未验证。
    await req(qMissing, { "X-OpenRig-Relay": "host-a" });
    expect(provenanceOf(qMissing)).toBe("claimed:v1");
  });

  it("GET /cli-capabilities 返回机群汇总", async () => {
    const res = await app.request("/api/mission-control/cli-capabilities");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; staleCliCount: number };
    expect(Array.isArray(body.rows)).toBe(true);
    expect(typeof body.staleCliCount).toBe("number");
  });

  // 按 PL-005 Phase A 守卫评审（2026-05-04）的 R1 修复。通过生产接线的路由路径做端到端证明，
  // 而不只测试注入式单元接缝：当机群能力用生产探针（startup.ts 接线的同一工厂）构建时，
  // /api/mission-control/cli-capabilities 路由 payload 会向 UI 使用方暴露 recoveryGuidance 漂移。
  it("R1 PRODUCTION-WIRED ROUTE: /cli-capabilities reports recoveryGuidance drift in JSON payload + per-row cliDriftDetected", async () => {
    // 构建接入生产探针的新应用（用权威工厂替换早期测试中的空操作默认值）。
    const productionFleetCli = new MissionControlFleetCliCapability({
      db,
      eventBus: bus,
      rigRepo: new RigRepository(db),
      probeRig: makeLocalCliCapabilityProbe(),
    });
    const productionApp = new Hono();
    productionApp.use("*", async (c, next) => {
      c.set("eventBus" as never, bus);
      c.set("missionControlReadLayer" as never, c.get("missionControlReadLayer" as never));
      c.set("missionControlWriteContract" as never, c.get("missionControlWriteContract" as never));
      c.set("missionControlFleetCliCapability" as never, productionFleetCli);
      await next();
    });
    productionApp.route("/api/mission-control", missionControlRoutes());

    const res = await productionApp.request("/api/mission-control/cli-capabilities");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ rigName: string; cliDriftDetected: boolean; cliVersionLabel: string }>;
      staleCliCount: number;
      degradedFields: string[];
      sourceFallback: string | null;
    };
    expect(body.staleCliCount).toBeGreaterThan(0);
    expect(body.degradedFields).toContain("recoveryGuidance");
    expect(body.degradedFields).not.toContain("agentActivity");
    for (const row of body.rows) {
      expect(row.cliDriftDetected).toBe(true);
      expect(row.cliVersionLabel).toBe(LOCAL_CLI_VERSION_LABEL);
    }
  });

  // SSE 路由顺序纪律（沿用 PL-004 Phase A R1 经验）：字面路径 /views、/sse、/watch、
  // /cli-capabilities 必须先于 /views/:view-name 挂载。
  it("R1 SSE 模式：GET /api/mission-control/sse 返回 200 和 content-type text/event-stream", async () => {
    const res = await app.request("/api/mission-control/sse");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("R1 SSE 模式：GET /api/mission-control/watch 返回 200 和 content-type text/event-stream", async () => {
    const res = await app.request("/api/mission-control/watch");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("R1 SSE 模式：字面路径 /views 返回数组，不被 /views/:view-name 遮蔽", async () => {
    const res = await app.request("/api/mission-control/views");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { views: string[] };
    expect(Array.isArray(body.views)).toBe(true);
  });
});
