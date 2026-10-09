import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { watchdogJobsSchema } from "../src/db/migrations/031_watchdog_jobs.js";
import { watchdogHistorySchema } from "../src/db/migrations/032_watchdog_history.js";
import { EventBus } from "../src/domain/event-bus.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { WatchdogHistoryLog } from "../src/domain/watchdog-history-log.js";
import { watchdogRoutes } from "../src/routes/watchdog.js";

function buildApp(opts: {
  eventBus: EventBus;
  jobsRepo: WatchdogJobsRepository;
  historyLog: WatchdogHistoryLog;
}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("eventBus" as never, opts.eventBus);
    c.set("watchdogJobsRepo" as never, opts.jobsRepo);
    c.set("watchdogHistoryLog" as never, opts.historyLog);
    await next();
  });
  app.route("/api/watchdog", watchdogRoutes());
  return app;
}

describe("watchdog 路由（PL-004 Phase C）", () => {
  let db: Database.Database;
  let bus: EventBus;
  let jobsRepo: WatchdogJobsRepository;
  let log: WatchdogHistoryLog;
  let app: Hono;

  const validRegisterBody = {
    policy: "periodic-reminder",
    specYaml:
      "policy: periodic-reminder\ntarget: alice@rig\ninterval_seconds: 60\ncontext:\n  target:\n    session: alice@rig\n  message: ping\n",
    targetSession: "alice@rig",
    intervalSeconds: 60,
    registeredBySession: "ops@kernel",
  };

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, watchdogJobsSchema, watchdogHistorySchema]);
    bus = new EventBus(db);
    jobsRepo = new WatchdogJobsRepository(db);
    log = new WatchdogHistoryLog(db);
    app = buildApp({ eventBus: bus, jobsRepo, historyLog: log });
  });

  afterEach(() => db.close());

  it("POST /register 返回 201、持久化 job 并发出 watchdog.job_registered", async () => {
    const captured: Array<{ type: string }> = [];
    bus.subscribe((e) => captured.push(e));
    const res = await app.request("/api/watchdog/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validRegisterBody),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { jobId: string; policy: string; state: string };
    expect(body.jobId).toMatch(/^[0-9A-Z]{26}$/);
    expect(body.policy).toBe("periodic-reminder");
    expect(body.state).toBe("active");
    expect(captured.some((e) => e.type === "watchdog.job_registered")).toBe(true);
  });

  // PL-004 Phase D：workflow-keepalive 的 registration-rejection 已替换为正向 registration-accept。
  it("POST /register 接受 workflow-keepalive（Phase D enum 扩展）", async () => {
    const res = await app.request("/api/watchdog/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validRegisterBody, policy: "workflow-keepalive" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { policy: string; state: string };
    expect(body.policy).toBe("workflow-keepalive");
    expect(body.state).toBe("active");
  });

  it("POST /register 以 400 + policy_unknown 拒绝未知 policy", async () => {
    const res = await app.request("/api/watchdog/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validRegisterBody, policy: "totally-bogus" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("policy_unknown");
  });

  it("POST /register 以 400 拒绝缺少必填字段的请求", async () => {
    const res = await app.request("/api/watchdog/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policy: "periodic-reminder" }),
    });
    expect(res.status).toBe(400);
  });

  it.each([
    ["malformed YAML", "message: [unterminated", "无效 YAML"],
    ["non-string message", "message: 42\n", "message"],
    ["non-mapping context", "context: nope\n", "context"],
    ["non-string target", "target: 42\nmessage: ping\n", "target"],
  ])("POST /register 在存储 job 前拒绝 %s", async (_case, specYaml, messagePart) => {
    const res = await app.request("/api/watchdog/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validRegisterBody, specYaml }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("spec_invalid");
    expect(body.message).toContain(messagePart);
    expect(jobsRepo.listAll()).toHaveLength(0);
  });

  it("GET /list 列出所有 job", async () => {
    jobsRepo.register({ ...validRegisterBody, targetSession: "a@rig" });
    jobsRepo.register({ ...validRegisterBody, targetSession: "b@rig" });
    const res = await app.request("/api/watchdog/list");
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<{ targetSession: string }>;
    expect(list).toHaveLength(2);
  });

  it("GET /:job_id 按 id 返回 job", async () => {
    const job = jobsRepo.register(validRegisterBody);
    const res = await app.request(`/api/watchdog/${job.jobId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toBe(job.jobId);
  });

  it("GET /:job_id 对未知 id 返回 404", async () => {
    const res = await app.request("/api/watchdog/unknown-id");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("job_not_found");
  });

  it("GET /:job_id/status 返回 job + 最近 history", async () => {
    const job = jobsRepo.register(validRegisterBody);
    log.record({
      jobId: job.jobId,
      evaluatedAt: "2026-05-03T07:00:00.000Z",
      outcome: "sent",
      deliveryTargetSession: "alice@rig",
      deliveryStatus: "ok",
      deliveryMessage: "ping",
    });
    const res = await app.request(`/api/watchdog/${job.jobId}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job: { jobId: string }; recentHistory: Array<{ outcome: string }> };
    expect(body.job.jobId).toBe(job.jobId);
    expect(body.recentHistory).toHaveLength(1);
    expect(body.recentHistory[0]?.outcome).toBe("sent");
  });

  it("POST /:job_id/stop 停止 job 并发出 watchdog.job_stopped", async () => {
    const captured: Array<{ type: string }> = [];
    bus.subscribe((e) => captured.push(e));
    const job = jobsRepo.register(validRegisterBody);
    const res = await app.request(`/api/watchdog/${job.jobId}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "tester stopped" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string };
    expect(body.state).toBe("stopped");
    expect(captured.some((e) => e.type === "watchdog.job_stopped")).toBe(true);
  });

  it("对 terminal job 调用 POST /:job_id/stop 时返回 409 + job_terminal", async () => {
    const job = jobsRepo.register(validRegisterBody);
    jobsRepo.markTerminal(job.jobId, "done");
    const res = await app.request(`/api/watchdog/${job.jobId}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("job_terminal");
  });

  it("R1 SSE 模式：GET /api/watchdog/sse 返回 200 + content-type text/event-stream", async () => {
    const res = await app.request("/api/watchdog/sse");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("R1 SSE 模式：GET /api/watchdog/watch 返回 200 + content-type text/event-stream", async () => {
    const res = await app.request("/api/watchdog/watch");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("R1 SSE 模式：GET /api/watchdog/sse 不返回 job_not_found（route-order 回归 guard）", async () => {
    const res = await app.request("/api/watchdog/sse");
    try {
      expect(res.status).not.toBe(404);
      expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
    } finally {
      await res.body?.cancel();
    }
  });
});
