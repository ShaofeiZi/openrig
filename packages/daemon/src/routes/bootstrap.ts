import nodePath from "node:path";
import { Hono } from "hono";
import type { BootstrapOrchestrator } from "../domain/bootstrap-orchestrator.js";
import type { BootstrapRepository } from "../domain/bootstrap-repository.js";
import type { EventBus } from "../domain/event-bus.js";

export const bootstrapRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    bootstrapOrchestrator: c.get("bootstrapOrchestrator" as never) as BootstrapOrchestrator,
    bootstrapRepo: c.get("bootstrapRepo" as never) as BootstrapRepository,
    eventBus: c.get("eventBus" as never) as EventBus,
  };
}

/** 用结构化 stage 码把失败的 plan 结果映射到 HTTP 状态码 */
function planFailureStatus(result: { stages: Array<{ stage: string; status: string; detail: unknown }> }): 400 | 409 | 500 {
  const failedStage = result.stages.find((s) => s.status === "failed" || s.status === "blocked");
  if (!failedStage) return 500;

  if (failedStage.stage === "resolve_spec") {
    const detail = failedStage.detail as { code?: string } | undefined;
    if (detail?.code === "file_not_found" || detail?.code === "parse_error" || detail?.code === "validation_failed" || detail?.code === "invalid_cwd") {
      return 400;
    }
    return 500;
  }

  if (failedStage.status === "blocked") return 409;
  return 500;
}

// POST /api/bootstrap/plan
bootstrapRoutes.post("/plan", async (c) => {
  const { bootstrapOrchestrator, eventBus } = getDeps(c);
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const sourceRef = typeof body["sourceRef"] === "string" ? body["sourceRef"] : "";
  const cwdOverride = typeof body["cwdOverride"] === "string" ? body["cwdOverride"] : undefined;

  if (!sourceRef) {
    return c.json({ error: "sourceRef 为必填项" }, 400);
  }

  // 并发锁——plan 期间状态一致
  if (!bootstrapOrchestrator.tryAcquire(sourceRef)) {
    return c.json({ error: "该 spec 的 bootstrap 已在进行中", code: "conflict" }, 409);
  }

  try {
    const result = await bootstrapOrchestrator.bootstrap({
      mode: "plan",
      sourceRef,
      cwdOverride,
      sourceKind: typeof body["sourceKind"] === "string" ? body["sourceKind"] : undefined,
    });

    if (result.status === "planned") {
      eventBus.emit({
        type: "bootstrap.planned",
        runId: result.runId,
        sourceRef,
        stages: result.stages.length,
      });
      return c.json(result, 200);
    }

    // Plan 失败——发出 failed 事件，返回合适的状态码
    eventBus.emit({ type: "bootstrap.failed", runId: result.runId, sourceRef, error: result.errors[0] ?? "plan 失败" });
    return c.json(result, planFailureStatus(result));
  } finally {
    bootstrapOrchestrator.release(sourceRef);
  }
});

// POST /api/bootstrap/apply
bootstrapRoutes.post("/apply", async (c) => {
  const { bootstrapOrchestrator, bootstrapRepo, eventBus } = getDeps(c);
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const sourceRef = typeof body["sourceRef"] === "string" ? body["sourceRef"] : "";

  if (!sourceRef) {
    return c.json({ error: "sourceRef 为必填项" }, 400);
  }

  // 并发锁——在创建 run 之前获取
  if (!bootstrapOrchestrator.tryAcquire(sourceRef)) {
    return c.json({ error: "该 spec 的 bootstrap 已在进行中", code: "conflict" }, 409);
  }

  const sourceKind = typeof body["sourceKind"] === "string" ? body["sourceKind"] : "rig_spec";
  const autoApprove = body["autoApprove"] === true;
  const cwdOverride = typeof body["cwdOverride"] === "string" ? body["cwdOverride"] : undefined;
  const approvedActionKeys = Array.isArray(body["approvedActionKeys"]) ? body["approvedActionKeys"] as string[] : undefined;

  try {
    // 在编排器工作之前预创建 run + 置为 running + 发出 started
    const run = bootstrapRepo.createRun(sourceKind, sourceRef);
    bootstrapRepo.updateRunStatus(run.id, "running");
    eventBus.emit({ type: "bootstrap.started", runId: run.id, sourceRef });

    let result;
    try {
      result = await bootstrapOrchestrator.bootstrap({
        mode: "apply",
        sourceRef,
        sourceKind,
        cwdOverride,
        autoApprove,
        approvedActionKeys,
        runId: run.id,
      });
    } catch (err) {
      // 异常边界：把 run 置为 failed，发出 failed 事件
      bootstrapRepo.updateRunStatus(run.id, "failed");
      const errorMsg = (err as Error).message ?? "bootstrap 失败";
      eventBus.emit({ type: "bootstrap.failed", runId: run.id, sourceRef, error: errorMsg });
      return c.json({ runId: run.id, status: "failed", error: errorMsg }, 500);
    }

    // 发出结果事件
    if (result.status === "completed") {
      eventBus.emit({ type: "bootstrap.completed", runId: result.runId, rigId: result.rigId!, sourceRef });
      return c.json(result, 201);
    } else if (result.status === "partial") {
      const completedCount = result.stages.filter((s) => s.status === "ok").length;
      const failedCount = result.stages.filter((s) => s.status === "failed" || s.status === "blocked").length;
      eventBus.emit({ type: "bootstrap.partial", runId: result.runId, sourceRef, rigId: result.rigId, completed: completedCount, failed: failedCount });
      return c.json(result, 200);
    } else {
      const errorMsg = result.errors[0] ?? "bootstrap 失败";
      eventBus.emit({ type: "bootstrap.failed", runId: result.runId, sourceRef, error: errorMsg });
      const hasBlocked = result.stages.some((s) => s.status === "blocked");
      const hasBadRequest = result.stages.some((s) => {
        if (s.stage !== "resolve_spec") return false;
        const detail = s.detail as { code?: string } | undefined;
        return detail?.code === "file_not_found" || detail?.code === "parse_error" || detail?.code === "validation_failed" || detail?.code === "invalid_cwd";
      });
      return c.json(result, hasBlocked ? 409 : hasBadRequest ? 400 : 500);
    }
  } finally {
    bootstrapOrchestrator.release(sourceRef);
  }
});

// GET /api/bootstrap/:id
bootstrapRoutes.get("/:id", (c) => {
  const { bootstrapRepo } = getDeps(c);
  const id = c.req.param("id")!;

  const run = bootstrapRepo.getRun(id);
  if (!run) {
    return c.json({ error: "未找到 bootstrap run" }, 404);
  }

  const actions = bootstrapRepo.getRunActions(id);
  return c.json({ ...run, actions });
});

// GET /api/bootstrap
bootstrapRoutes.get("/", (c) => {
  const { bootstrapRepo } = getDeps(c);
  return c.json(bootstrapRepo.listRuns());
});
