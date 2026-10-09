import { statSync } from "node:fs";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
import type { WatchdogHistoryLog } from "../domain/watchdog-history-log.js";
import {
  type WatchdogJobsRepository,
  WatchdogJobsError,
} from "../domain/watchdog-jobs-repository.js";
import { parseWatchdogSpec } from "../domain/watchdog-policy-engine.js";

/**
 * watchdog HTTP 路由（PL-004 Phase C）。支撑 `zrig watchdog` CLI 动词。
 *
 * 按 Phase A R1 SSE 路由顺序教训：SSE/静态路由挂载在裸参 /:job_id 通配之前，
 * 这样字面量 `/sse` 与字面量动作路径优先于参数路由。
 *
 * 端点：
 *   POST /register          注册新 watchdog job
 *   GET  /list              列出所有 watchdog job（active + stopped + terminal）
 *   GET  /sse               watchdog.* 事件的 SSE 流
 *   GET  /:job_id           展示一个 job
 *   GET  /:job_id/status    job + 近期历史（紧凑摘要）
 *   POST /:job_id/stop      操作员停止
 */
export function watchdogRoutes(): Hono {
  const app = new Hono();

  function getJobsRepo(c: { get: (key: string) => unknown }): WatchdogJobsRepository {
    return c.get("watchdogJobsRepo" as never) as WatchdogJobsRepository;
  }
  function getHistoryLog(c: { get: (key: string) => unknown }): WatchdogHistoryLog {
    return c.get("watchdogHistoryLog" as never) as WatchdogHistoryLog;
  }
  function getEventBus(c: { get: (key: string) => unknown }): EventBus {
    return c.get("eventBus" as never) as EventBus;
  }

  function errorResponse(
    c: { json: (body: unknown, status?: number) => Response },
    err: unknown,
  ): Response {
    if (err instanceof WatchdogJobsError) {
      const status =
        err.code === "job_not_found" ? 404
        : err.code === "policy_unknown" ? 400
        : err.code === "policy_deferred_to_phase_d" ? 400
        : err.code === "interval_invalid" ? 400
        : err.code === "target_session_invalid" ? 400
        : err.code === "spec_invalid" ? 400
        : err.code === "context_usage_schema_missing" ? 400
        : err.code === "threshold_invalid" ? 400
        : err.code === "watched_file_unresolved" ? 400
        : err.code === "requires_job_not_found" ? 400
        : err.code === "job_terminal" ? 409
        : 500;
      return c.json(
        { error: err.code, message: err.message, ...(err.details ?? {}) },
        status as 200,
      );
    }
    const message = err instanceof Error ? err.message : "内部错误";
    return c.json({ error: "internal_error", message }, 500);
  }

  app.post("/register", async (c) => {
    const body = await c.req
      .json<{
        policy?: string;
        specYaml?: string;
        targetSession?: string;
        intervalSeconds?: number;
        activeWakeIntervalSeconds?: number;
        scanIntervalSeconds?: number;
        registeredBySession?: string;
        watchedFilePath?: string;
        thresholdBytes?: number;
        requiresJobId?: string;
      }>()
      .catch(() => ({} as never));
    if (!body.policy) return c.json({ error: "policy 为必填项" }, 400);
    if (!body.specYaml) return c.json({ error: "specYaml 为必填项" }, 400);
    if (!body.targetSession) return c.json({ error: "targetSession 为必填项" }, 400);
    if (typeof body.intervalSeconds !== "number") {
      return c.json({ error: "intervalSeconds 为必填项" }, 400);
    }
    if (!body.registeredBySession) return c.json({ error: "registeredBySession 为必填项" }, 400);
    try {
      const jobsRepo = getJobsRepo(c);
      const context = parseWatchdogSpec(body.specYaml).context;
      const isContextUsageThreshold = body.policy === "context-usage-threshold";
      const specWatchedFile = typeof context.watched_file === "string"
        ? context.watched_file
        : null;
      const specThresholdBytes = typeof context.threshold_bytes === "number"
        ? context.threshold_bytes
        : null;
      const specRequiresJobId = typeof context.requires === "string"
        ? context.requires
        : null;
      const watchedFilePath = isContextUsageThreshold
        ? (body.watchedFilePath ?? specWatchedFile ?? jobsRepo.findTranscriptPath(body.targetSession))
        : null;
      if (isContextUsageThreshold) {
        try {
          if (!watchedFilePath || !statSync(watchedFilePath).isFile()) throw new Error("不是文件");
        } catch {
          throw new WatchdogJobsError(
            "watched_file_unresolved",
            `无法为 ${body.targetSession} 解析出可读的 transcript 文件`,
            { targetSession: body.targetSession, watchedFilePath },
          );
        }
      }
      const job = jobsRepo.register({
        policy: body.policy,
        specYaml: body.specYaml,
        targetSession: body.targetSession,
        intervalSeconds: body.intervalSeconds,
        activeWakeIntervalSeconds: body.activeWakeIntervalSeconds,
        scanIntervalSeconds: body.scanIntervalSeconds,
        registeredBySession: body.registeredBySession,
        watchedFilePath,
        thresholdBytes: isContextUsageThreshold
          ? (body.thresholdBytes ?? specThresholdBytes)
          : null,
        requiresJobId: isContextUsageThreshold
          ? (body.requiresJobId ?? specRequiresJobId)
          : null,
      });
      getEventBus(c).emit({
        type: "watchdog.job_registered",
        jobId: job.jobId,
        policy: job.policy,
        targetSession: job.targetSession,
        registeredBy: job.registeredBySession,
      });
      return c.json(job, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // GET /list——列出所有 watchdog job。
  // 字面量路径在 /:job_id 之前（按 Phase A R1 SSE 路由顺序教训）。
  app.get("/list", (c) => {
    const jobs = getJobsRepo(c).listAll();
    return c.json(jobs);
  });

  // watchdog.* 事件的 SSE。必须在 /:job_id 之前，使字面量路径优先。
  // 按 Phase A R1 SSE 路由顺序教训。
  const sseHandler = (c: Parameters<typeof streamSSE>[0]) => {
    const eventBus = getEventBus(c);
    return streamSSE(c, async (stream) => {
      const unsubscribe = eventBus.subscribe((event) => {
        if (
          event.type !== "watchdog.evaluation_fired" &&
          event.type !== "watchdog.evaluation_skipped" &&
          event.type !== "watchdog.evaluation_terminal" &&
          event.type !== "watchdog.job_registered" &&
          event.type !== "watchdog.job_stopped"
        ) return;
        const sse = { id: String(event.seq), data: JSON.stringify(event) };
        stream.writeSSE(sse).catch(() => {});
      });
      try {
        await new Promise<void>((resolve) => stream.onAbort(() => resolve()));
      } finally {
        unsubscribe();
      }
    });
  };

  app.get("/sse", sseHandler);
  app.get("/watch", sseHandler);

  app.get("/:job_id/status", (c) => {
    const jobId = c.req.param("job_id");
    const job = getJobsRepo(c).getById(jobId);
    if (!job) return c.json({ error: "job_not_found", jobId }, 404);
    const recentHistory = getHistoryLog(c).listForJob(jobId, 20);
    return c.json({ job, recentHistory });
  });

  app.post("/:job_id/stop", async (c) => {
    const jobId = c.req.param("job_id");
    const body = await c.req
      .json<{ reason?: string }>()
      .catch(() => ({} as { reason?: string }));
    try {
      const job = getJobsRepo(c).stop(jobId, body.reason ?? "operator_stopped");
      getEventBus(c).emit({
        type: "watchdog.job_stopped",
        jobId: job.jobId,
        reason: body.reason ?? "operator_stopped",
      });
      return c.json(job);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get("/:job_id", (c) => {
    const jobId = c.req.param("job_id");
    const job = getJobsRepo(c).getById(jobId);
    if (!job) return c.json({ error: "job_not_found", jobId }, 404);
    return c.json(job);
  });

  return app;
}
