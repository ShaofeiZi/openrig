import type { ShadowCapture } from "../domain/shadow-capture.js";
import type Database from "better-sqlite3";
import type { StreamStore } from "../domain/stream-store.js";
import { classifierOccupant, classificationSources } from "../domain/classification-sources.js";
import { selectedProject } from "../domain/workspace/project-read.js";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
import type { ProjectClassifier } from "../domain/project-classifier.js";
import { ProjectClassifierError } from "../domain/project-classifier.js";
import type { ClassifierLeaseManager } from "../domain/classifier-lease-manager.js";
import { ClassifierLeaseError } from "../domain/classifier-lease-manager.js";
import type { ClassificationAttemptLedger } from "../domain/classification-attempts.js";
import { ClassificationAttemptError } from "../domain/classification-attempts.js";

import { requireSenderIdentity, resolveRecordedProvenance } from "./require-sender-identity.js";

/**
 * 协调层 L2——Project（分类器）HTTP 路由（PL-004 Phase B）。
 *
 * 支撑 `zrig project` CLI 动词。租约生命周期端点 + project（幂等 classify）
 * + operator 动词 reclaim + SSE。
 *
 * 按 Phase A R1 SSE 路由顺序教训（slice IMPL § Audit Row 12）：
 * SSE/静态路由挂载在裸参数 /:id catchall 之前。
 */
export function projectsRoutes(): Hono {
  const app = new Hono();

  function getClassifier(c: { get: (key: string) => unknown }): ProjectClassifier {
    return c.get("projectClassifier" as never) as ProjectClassifier;
  }
  function getLease(c: { get: (key: string) => unknown }): ClassifierLeaseManager {
    return c.get("classifierLeaseManager" as never) as ClassifierLeaseManager;
  }
  function getAttempts(c: { get: (key: string) => unknown }): ClassificationAttemptLedger | undefined {
    return c.get("classificationAttemptLedger" as never) as ClassificationAttemptLedger | undefined;
  }
  function getEventBus(c: { get: (key: string) => unknown }): EventBus {
    return c.get("eventBus" as never) as EventBus;
  }

  // JSON 形状不可信，即便 session 可能使用所声称的 fallback。
  // 绝不把对象传给共享 helper 的字符串 trim。wire 身份始终优先。
  function sender(c: Context, claim: unknown, field = "classifierSession") {
    if (!c.req.header("x-openrig-session")?.trim() && claim !== undefined && typeof claim !== "string") {
      return { ok: false as const, response: c.json({ error: "invalid_field", field, message: `${field} 必须是字符串` }, 400) };
    }
    const actor = requireSenderIdentity(c, { verb: "classification", bodyClaim: typeof claim === "string" ? claim : undefined });
    if (!actor.ok) return actor;
    const expected = c.req.query("expectedOccupant");
    if (expected !== undefined && classifierOccupant(c.get("db" as never) as Database.Database, actor.session)?.generation !== expected) {
      return { ok: false as const, response: c.json({ error: "occupant_changed", message: "分类器占用者不可用或已变更；不要复用其租约。" }, 409) };
    }
    return actor;
  }

  function errorResponse(c: { json: (body: unknown, status?: number) => Response }, err: unknown): Response {
    if (err instanceof ProjectClassifierError) {
      const status = err.code === "idempotency_violation" ? 409
        : err.code === "project_not_found" ? 404
        : err.code === "attempt_mismatch" || err.code === "attempt_superseded" ? 409
        : err.code === "unknown_stream_item"
          || err.code === "invalid_field"
          || err.code === "execution_id_required"
          || err.code === "lease_id_required"
          || err.code === "invalid_needs_human"
          || err.code === "invalid_duplicate_of"
          || err.code === "candidate_set_version_required"
          || err.code === "attempt_versions_required" ? 400
        : 500;
      return c.json({ error: err.code, message: err.message, ...(err.meta ?? {}) }, status as 200);
    }
    if (err instanceof ClassifierLeaseError) {
      const status = err.code === "lease_held" ? 409
        : err.code === "lease_session_mismatch" ? 403
        : err.code === "lease_not_active" ? 409
        : err.code === "lease_expired" ? 409
        : err.code === "lease_not_found" ? 404
        : err.code === "no_active_lease" ? 409
        : err.code === "lease_still_active" ? 409
        : err.code === "lease_mismatch" ? 409
        : 500;
      return c.json({ error: err.code, message: err.message, ...(err.meta ?? {}) }, status as 200);
    }
    if (err instanceof ClassificationAttemptError) {
      const status = err.code === "attempt_not_found" ? 404
        : err.code === "unknown_stream_item" || err.code === "invalid_attempt_identity"
          || err.code === "unknown_cursor" || err.code === "invalid_field" ? 400
        : 409;
      return c.json({ error: err.code, message: err.message, ...(err.meta ?? {}) }, status as 200);
    }
    const message = err instanceof Error ? err.message : "内部错误";
    return c.json({ error: "internal_error", message }, 500);
  }

  // 此处不做任何分类法或模型判断：只返回当前、已识别的源事实。
  app.get("/worker-sources", c => {
    const actor = sender(c, undefined);
    if (!actor.ok) return actor.response;
    const db = c.get("db" as never) as Database.Database;
    const occupant = classifierOccupant(db, actor.session);
    if (!occupant) return c.json({ error: "occupant_unavailable", message: "需要一个真实运行中的分类器占用者。" }, 409);
    try {
      const project = selectedProject(c);
      if (!project) return c.json({ error: "project_required" }, 400);
      return c.json(classificationSources(db, project, occupant, c.get("streamStore" as never) as StreamStore));
    } catch (error) { return c.json({ error: "candidate_sources_unavailable", message: error instanceof Error ? error.message : "源不可用" }, 409); }
  });

  app.get("/shadow", c => {
    const capture = c.get("shadowCapture" as never) as ShadowCapture | undefined;
    return c.json(capture?.status() ?? {enabled: false, error: c.get("shadowCaptureError" as never) ?? null});
  });
  app.post("/shadow/drain", async c => {
    const actor = sender(c, undefined); if (!actor.ok) return actor.response;
    const capture = c.get("shadowCapture" as never) as ShadowCapture | undefined;
    if (!capture) return c.json({enabled: false, error: c.get("shadowCaptureError" as never) ?? null}, 409);
    return c.json(await capture.drain());
  });
  app.post("/shadow/stop", async c => {
    const actor = sender(c, undefined); if (!actor.ok) return actor.response;
    const capture = c.get("shadowCapture" as never) as ShadowCapture | undefined;
    return c.json(capture ? await capture.stop() : {enabled: false, error: c.get("shadowCaptureError" as never) ?? null});
  });

  // POST /lease/acquire——为调用方获取活跃分类器租约。
  // R1 NOTE 3：可选 `evaluateDeadnessFirst: true` 使路由在 acquire 之前先调用
  // evaluateDeadness，清除 TTL 过期或持有者已死的陈旧租约。不开启此 opt-in 时，
  // 即便持有者已死 acquire 也返回 409 lease_held（operator 动词 reclaim 路径是
  // 唯一另一种无需等待 TTL+下次 evaluateDeadness 调用即可清除死租约的方式）。
  // 默认关闭——由 operator/分类器显式请求主动清理。
  app.post("/lease/acquire", async (c) => {
    const body = await c.req.json<{ classifierSession?: string; evaluateDeadnessFirst?: boolean }>().catch(() => ({} as never));
    const actor = sender(c, body.classifierSession);
    if (!actor.ok) return actor.response;
    try {
      if (body.evaluateDeadnessFirst === true) {
        getLease(c).evaluateDeadness();
      }
      const lease = getLease(c).acquire(actor.session);
      return c.json(lease, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /lease/heartbeat——更新 last_heartbeat 并延长 expires_at。
  app.post("/lease/heartbeat", async (c) => {
    const body = await c.req.json<{ leaseId?: string; classifierSession?: string }>().catch(() => ({} as never));
    if (typeof body.leaseId !== "string" || !body.leaseId.trim()) return c.json({ error: "invalid_field", field: "leaseId" }, 400);
    const actor = sender(c, body.classifierSession);
    if (!actor.ok) return actor.response;
    try {
      const lease = getLease(c).heartbeat(body.leaseId, actor.session);
      return c.json(lease);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /reclaim-classifier——operator 动词 reclaim（按 PRD § L2 硬规则）。
  app.post("/reclaim-classifier", async (c) => {
    const body = await c.req.json<{
      byClassifierSession?: string;
      ifDead?: boolean;
      reason?: string;
    }>().catch(() => ({} as never));
    const actor = sender(c, body.byClassifierSession, "byClassifierSession");
    if (!actor.ok) return actor.response;
    try {
      const lease = getLease(c).reclaim(actor.session, {
        ifDead: body.ifDead,
        reason: body.reason,
      });
      return c.json(lease);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /project——投影一个 stream item（按 stream_item_id 幂等）。
  app.post("/project", async (c) => {
    const body = await c.req.json<{
      streamItemId?: string;
      classifierSession?: string;
      leaseId?: string;
      attemptId?: string;
      executionId?: string;
      classificationType?: string;
      classificationUrgency?: string;
      classificationMaturity?: string;
      classificationConfidence?: string;
      classificationDestination?: string;
      action?: string;
      area?: string;
      scopeRef?: string;
      duplicateOfStreamItemId?: string;
      needsHuman?: boolean | null;
      classifierVersion?: string;
      taxonomyVersion?: string;
      candidateSetVersion?: string;
    }>().catch(() => ({} as never));
    if (!body.streamItemId) return c.json({ error: "streamItemId 为必填项" }, 400);
    const actor = sender(c, body.classifierSession);
    if (!actor.ok) return actor.response;
    try {
      const project = getClassifier(c).classify({
        streamItemId: body.streamItemId,
        classifierSession: actor.session,
        identityProvenance: resolveRecordedProvenance(c, actor),
        leaseId: body.leaseId as string,
        attemptId: body.attemptId,
        executionId: body.executionId,
        classificationType: body.classificationType,
        classificationUrgency: body.classificationUrgency,
        classificationMaturity: body.classificationMaturity,
        classificationConfidence: body.classificationConfidence,
        classificationDestination: body.classificationDestination,
        action: body.action,
        area: body.area,
        scopeRef: body.scopeRef,
        duplicateOfStreamItemId: body.duplicateOfStreamItemId,
        needsHuman: body.needsHuman,
        classifierVersion: body.classifierVersion,
        taxonomyVersion: body.taxonomyVersion,
        candidateSetVersion: body.candidateSetVersion,
      });
      return c.json(project, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // ---- 尝试台账（S02 P1）----
  // 字面路径；全部挂载在 /:projectId 之前。
  const attemptsUnavailable = (c: { json: (b: unknown, s?: number) => Response }) =>
    c.json({ error: "attempt_ledger_unavailable", message: "本后台服务未接入分类 attempt ledger" }, 503);

  app.post("/attempts/begin", async (c) => {
    const ledger = getAttempts(c);
    if (!ledger) return attemptsUnavailable(c);
    // ledger 在 sender 解析后校验其余被消费字段。
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as never));
    const actor = sender(c, body.classifierSession);
    if (!actor.ok) return actor.response;
    try {
      return c.json(ledger.begin({
        streamItemId: body.streamItemId as string,
        classifierVersion: body.classifierVersion as string,
        taxonomyVersion: body.taxonomyVersion as string,
        evidenceEpoch: body.evidenceEpoch as string,
        leaseId: body.leaseId as string,
        classifierSession: actor.session,
      }), 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  for (const verb of ["abstain", "fail"] as const) {
    app.post(`/attempts/:attemptId/${verb}`, async (c) => {
      const ledger = getAttempts(c);
      if (!ledger) return attemptsUnavailable(c);
      // ledger 对其余字段做形状校验（invalid_field）。
      const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as never));
      const actor = sender(c, body.classifierSession);
      if (!actor.ok) return actor.response;
      if (body.reason === undefined) return c.json({ error: "reason 为必填项" }, 400);
      try {
        const input = {
          attemptId: c.req.param("attemptId"),
          executionId: body.executionId as string,
          leaseId: body.leaseId as string,
          classifierSession: actor.session,
          reason: body.reason as string,
        };
        return c.json(verb === "abstain" ? ledger.abstain(input) : ledger.fail(input));
      } catch (err) {
        return errorResponse(c, err);
      }
    });
  }

  // GET /eligible——按 stream 顺序返回当前可 attempt 的一页有界条目。
  app.get("/eligible", (c) => {
    if (c.req.query("expectedOccupant") !== undefined) { const actor = sender(c, undefined); if (!actor.ok) return actor.response; }
    const ledger = getAttempts(c);
    if (!ledger) return attemptsUnavailable(c);
    try {
      const limit = c.req.query("limit") ? Number.parseInt(c.req.query("limit")!, 10) : undefined;
      return c.json(ledger.eligible({
        classifierVersion: c.req.query("classifierVersion") ?? "",
        taxonomyVersion: c.req.query("taxonomyVersion") ?? "",
        evidenceEpoch: c.req.query("evidenceEpoch") ?? "",
        limit: Number.isFinite(limit) ? limit : undefined,
        afterSortKey: c.req.query("afterSortKey") || undefined,
      }));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // GET /lease——显示活跃租约。
  // 必须在 /:projectId 之前，使字面路径优先。
  app.get("/lease", (c) => {
    if (c.req.query("expectedOccupant") !== undefined) {
      const actor = sender(c, undefined); if (!actor.ok) return actor.response;
      try { getLease(c).requireActiveHolder(actor.session, c.req.query("expectedLeaseId")); }
      catch (error) { return errorResponse(c, error); }
    }
    const lease = getLease(c).getActiveLease();
    if (!lease) return c.json({ error: "no_active_lease" }, 404);
    return c.json(lease);
  });

  // GET /list——带过滤列出分类结果。
  // 必须在 /:projectId 之前，使字面路径优先。
  app.get("/list", (c) => {
    const classifierSession = c.req.query("classifierSession") || undefined;
    const classificationDestination = c.req.query("classificationDestination") || undefined;
    const area = c.req.query("area") || undefined;
    const scopeRef = c.req.query("scopeRef") || undefined;
    const needsHumanRaw = c.req.query("needsHuman") || undefined;
    if (needsHumanRaw && !["true", "false", "unknown"].includes(needsHumanRaw)) {
      return c.json({ error: "needsHuman 过滤值必须为 true、false 或 unknown" }, 400);
    }
    const needsHuman = needsHumanRaw as "true" | "false" | "unknown" | undefined;
    const limit = c.req.query("limit") ? Number.parseInt(c.req.query("limit")!, 10) : undefined;
    const items = getClassifier(c).list({ classifierSession, classificationDestination, area, scopeRef, needsHuman, limit });
    return c.json(items);
  });

  // ---- project + 分类器事件的 SSE ----
  // 必须在 /:projectId 之前，使字面 `sse` 和 `watch` 路径优先于裸参数路由。
  // 按 Phase A R1 SSE 路由顺序教训。
  const sseHandler = (c: Parameters<typeof streamSSE>[0]) => {
    const eventBus = getEventBus(c);
    return streamSSE(c, async (stream) => {
      const unsubscribe = eventBus.subscribe((event) => {
        if (
          event.type !== "project.classified" &&
          event.type !== "classifier.lease_acquired" &&
          event.type !== "classifier.lease_expired" &&
          event.type !== "classifier.dead" &&
          event.type !== "classifier.reclaimed"
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

  // GET /:projectId——显示单个 project（必须在字面路由之后）。
  app.get("/:projectId", (c) => {
    const projectId = c.req.param("projectId");
    const project = getClassifier(c).getById(projectId);
    if (!project) return c.json({ error: "project_not_found" }, 404);
    return c.json(project);
  });

  return app;
}
