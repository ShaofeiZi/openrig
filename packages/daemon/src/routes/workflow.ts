import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import * as path from "node:path";
import type { EventBus } from "../domain/event-bus.js";
import { QueueRepositoryError } from "../domain/queue-repository.js";
import {
  WorkflowInstanceError,
  WorkflowProjectorError,
  type WorkflowRuntime,
} from "../domain/workflow-runtime.js";
import { WorkflowSpecError } from "../domain/workflow-spec-cache.js";
import { WorkflowHumanDestinationError } from "../domain/workflow-human-destination.js";

/**
 * Workflow 运行时 HTTP 路由（PL-004 Phase D）。支撑 `zrig workflow` CLI。
 *
 * 按 Phase A R1 SSE 路由顺序教训：SSE/字面路径挂载在裸参数
 * /:instance_id catchall 之前。
 *
 * 端点：
 *   POST /api/workflow/validate         按文件路径校验 spec
 *   POST /api/workflow/instantiate      创建 instance + entry qitem
 *   POST /api/workflow/project          close packet + 投影下一个（transactional-scribe）
 *   GET  /api/workflow/list             按 status 列出 instances
 *   GET  /api/workflow/sse              workflow.* 事件的 SSE 流
 *   GET  /api/workflow/watch            /sse 的别名
 *   GET  /api/workflow/:instance_id    显示单个 instance
 *   GET  /api/workflow/:instance_id/trace  实例 + 轨迹
 *   POST /api/workflow/:instance_id/continue  inspect（幂等）
 */
export function workflowRoutes(): Hono {
  const app = new Hono();

  function getRuntime(c: { get: (key: string) => unknown }): WorkflowRuntime {
    return c.get("workflowRuntime" as never) as WorkflowRuntime;
  }
  function getEventBus(c: { get: (key: string) => unknown }): EventBus {
    return c.get("eventBus" as never) as EventBus;
  }

  function errorResponse(
    c: { json: (body: unknown, status?: number) => Response },
    err: unknown,
  ): Response {
    if (err instanceof WorkflowHumanDestinationError) {
      return c.json({ error: err.code, message: err.message, ...err.details }, 409);
    }
    if (err instanceof WorkflowSpecError) {
      // OPR.0.4.6.WF1 FR-7（guard round-2 blocker）：新 strict-validation
      // 拒绝（spec_unknown_key、spec_field_invalid）是 operator/spec 误用——
      // 结构化 400，绝不是 500（与 spec 分支上 FR-5 冲突映射同类）。
      const status =
        err.code === "spec_file_missing" || err.code === "lifecycle_manifest_missing" || err.code === "lifecycle_member_missing" ? 404
        : err.code === "spec_yaml_invalid" || err.code === "spec_shape_invalid" || err.code === "spec_field_missing" ? 400
        : err.code === "spec_unknown_key" || err.code === "spec_field_invalid" ? 400
        : err.code.startsWith("lifecycle_") ? 400
        : err.code === "spec_not_found" ? 404
        : 500;
      return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, status as 200);
    }
    if (err instanceof WorkflowInstanceError) {
      // OPR.0.4.6.WF1 FR-5（guard blocker 1）：乐观并发 loser 得到结构化冲突类——
      // HTTP 409，body 带 expectedVersion/actualVersion——绝不是 500。
      const status =
        err.code === "instance_not_found" ? 404
        : err.code === "instance_version_conflict" || err.code === "lifecycle_revision_conflict" ? 409
        : 500;
      return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, status as 200);
    }
    if (err instanceof WorkflowProjectorError) {
      const status =
        err.code === "instance_not_active" || err.code === "packet_not_on_frontier" ? 409
        : err.code === "frontier_packet_required" || err.code === "frontier_binding_indeterminate" ? 409
        : err.code === "failure_occurrence_required" || err.code === "failure_occurrence_not_unresolved" || err.code === "failure_occurrence_replay_indeterminate" || err.code === "failure_occurrence_replay_conflict" ? 409
        : err.code === "instance_not_abortable" || err.code === "instance_not_resumable" ? 409
        : err.code === "lifecycle_operation_conflict" || err.code === "lifecycle_replay_indeterminate" ? 409
        : err.code === "lifecycle_identity_invalid" || err.code === "lifecycle_not_eligible" || err.code === "lifecycle_receipt_required" ? 400
        : err.code.startsWith("acceptance_") || err.code === "abort_reason_required" ? 400
        : err.code === "spec_not_cached" || err.code === "current_step_unknown" ? 409
        : err.code === "no_next_step" || err.code === "next_owner_unresolved" ? 400
        : err.code === "spec_invalid" || err.code === "entry_owner_unresolved" || err.code === "spec_no_steps" ? 400
        // R3 fix（guard blocker）：把 allowed_exits 投影时拒绝映射到 400，
        // 使公共表面（HTTP API + CLI）诚实呈现 operator/spec 误用，
        // 而不是伪造为 500 internal-server-error。
        : err.code === "exit_not_allowed" ? 400
        // OPR.0.4.6.WF2（guard blocker 2）：新 language/routing 失败是预期的
        // operator/spec 错误，绝不是 500。编写时边界 -> 400；live-state 冲突 -> 409。
        : err.code === "host_pin_remote_unsupported" ? 400
        : err.code === "gate_target_unresolved" || err.code === "gate_handler_unresolved" ? 400
        : err.code === "gate_human_fields_missing" || err.code === "gate_owner_unresolved" || err.code === "gate_missing" ? 400
        : err.code === "harness_pin_unsatisfied" ? 409
        // OPR.0.4.6.WF5 FR-4：resume 拒绝——live-state 冲突 -> 409
        // （instance 状态错），unrecoverable-binding / spec-drift -> 409
        // （state-vs-spec 冲突，operator 可修）。
        : err.code === "instance_not_failed" ? 409
        : err.code === "resume_step_unrecoverable" || err.code === "resume_step_missing_from_spec" ? 409
        : err.code === "branch_target_missing" ? 409
        // OPR.0.4.6.FAC1（guard code-review blocker at 6e991a9d）：新 bound-rig
        // 错误是预期的 operator/spec 拒绝，不是 500——同样的
        // authoring-boundary(400)/live-state-conflict(409) 划分。
        // bound_rig_unknown = 显式 --rig 命名了未登记 rig（编写误用 → 400）；
        // bound_rig_role_uncovered = bound rig 在 instantiate 时结构性地
        // 未为所需 role 声明席位（spec/rig 不匹配 → 400）；
        // bound_rig_not_found = 已持久化的 bound rig 在 run 中途消失
        // （live state-vs-instance 冲突 → 409，harness_pin/instance_version_conflict 类）。
        : err.code === "bound_rig_unknown" || err.code === "bound_rig_role_uncovered" ? 400
        : err.code === "bound_rig_not_found" ? 409
        : err.code === "packet_not_found" ? 404
        : 500;
      return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, status as 200);
    }
    if (err instanceof QueueRepositoryError) {
      const status =
        err.code === "unknown_destination_rig" ? 400
        : err.code === "qitem_not_found" ? 404
        : err.code === "workflow_frontier_packet" ? 400
        : 500;
      return c.json({ error: err.code, message: err.message, ...(err.meta ?? {}) }, status as 200);
    }
    const message = err instanceof Error ? err.message : "内部错误";
    return c.json({ error: "internal_error", message }, 500);
  }

  app.post("/validate", async (c) => {
    const body = await c.req.json<{ specPath?: string }>().catch(() => ({} as never));
    if (!body.specPath) return c.json({ error: "specPath 为必填项" }, 400);
    try {
      const result = getRuntime(c).validate(body.specPath);
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/compile", async (c) => {
    const body = await c.req.json<{ missionPath?: string; operationKey?: string }>().catch(() => ({} as never));
    if (!body.missionPath) return c.json({ error: "missionPath 为必填项" }, 400);
    try {
      return c.json(getRuntime(c).compileLifecycle(body.missionPath, body.operationKey));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/instantiate-lifecycle", async (c) => {
    const body = await c.req.json<{
      missionPath?: string;
      operationKey?: string;
      rootObjective?: string;
      createdBySession?: string;
      entryOwnerSession?: string;
      targetRig?: string;
    }>().catch(() => ({} as never));
    if (!body.missionPath) return c.json({ error: "missionPath 为必填项" }, 400);
    if (!body.operationKey) return c.json({ error: "operationKey 为必填项" }, 400);
    if (!body.rootObjective) return c.json({ error: "rootObjective 为必填项" }, 400);
    if (!body.createdBySession) return c.json({ error: "createdBySession 为必填项" }, 400);
    try {
      const result = await getRuntime(c).instantiateLifecycle({
        missionPath: body.missionPath,
        operationKey: body.operationKey,
        rootObjective: body.rootObjective,
        createdBySession: body.createdBySession,
        entryOwnerSession: body.entryOwnerSession,
        targetRig: body.targetRig,
      });
      return c.json(result, result.replayed ? 200 : 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get("/operations/:key", (c) => {
    try {
      const result = getRuntime(c).recoverOperation(c.req.param("key"));
      return result ? c.json(result) : c.json({ error: "operation_not_found", message: "该 key 无已提交副作用。重试原命令时请保留它。" }, 404);
    } catch (err) { return errorResponse(c, err); }
  });

  app.get("/:instance_id/revision", (c) => {
    try { return c.json(getRuntime(c).inspectGraph(c.req.param("instance_id"))); }
    catch (err) { return errorResponse(c, err); }
  });

  app.post("/:instance_id/revision", async (c) => {
    const body = await c.req.json<Parameters<WorkflowRuntime["reviseGraph"]>[0]>().catch(() => ({} as never));
    try { return c.json(getRuntime(c).reviseGraph({ ...body, instanceId: c.req.param("instance_id") })); }
    catch (err) { return errorResponse(c, err); }
  });

  app.post("/instantiate", async (c) => {
    const body = await c.req
      .json<{
        specPath?: string;
        rootObjective?: string;
        createdBySession?: string;
        entryOwnerSession?: string;
        /** OPR.0.4.6.FAC1：覆盖 spec 的 target.rig 默认值。 */
        targetRig?: string;
      }>()
      .catch(() => ({} as never));
    if (!body.specPath) return c.json({ error: "specPath 为必填项" }, 400);
    if (!body.rootObjective) return c.json({ error: "rootObjective 为必填项" }, 400);
    if (!body.createdBySession) return c.json({ error: "createdBySession 为必填项" }, 400);
    try {
      const result = await getRuntime(c).instantiate({
        specPath: body.specPath,
        rootObjective: body.rootObjective,
        createdBySession: body.createdBySession,
        entryOwnerSession: body.entryOwnerSession,
        targetRig: body.targetRig,
      });
      return c.json(result, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/project", async (c) => {
    const body = await c.req
      .json<{
        instanceId?: string;
        currentPacketId?: string;
        exit?: "handoff" | "waiting" | "done" | "failed";
        resultNote?: string;
        blockedOn?: string;
        closureEvidence?: Record<string, unknown>;
        actorSession?: string;
        nextOwnerSession?: string;
      }>()
      .catch(() => ({} as never));
    if (!body.instanceId) return c.json({ error: "instanceId 为必填项" }, 400);
    if (!body.currentPacketId) return c.json({ error: "currentPacketId 为必填项" }, 400);
    if (!body.exit) return c.json({ error: "exit 为必填项" }, 400);
    if (!body.actorSession) return c.json({ error: "actorSession 为必填项" }, 400);
    try {
      const result = await getRuntime(c).project({
        instanceId: body.instanceId,
        currentPacketId: body.currentPacketId,
        exit: body.exit,
        resultNote: body.resultNote,
        blockedOn: body.blockedOn,
        closureEvidence: body.closureEvidence,
        actorSession: body.actorSession,
        nextOwnerSession: body.nextOwnerSession,
      });
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // OPR.0.4.6.WF1 FR-2 完成回修（qitem-20260706211220-279039f5）：
  // list/show/trace 携带派生的 deadline 结论——已批准的 FR-2 可查询条款
  // （"可经 list/show/trace 查询……带证据（step、owner、deadline、age）"）。
  // 附加字段，每次读重算，绝不存储；唯一 evaluator 归属
  // （workflow-deadline.ts）。trace/continue 经 runtime.continue() 的丰富 instance 继承它。
  app.get("/list", (c) => {
    const status = c.req.query("status");
    if (status === "active" || status === "waiting" || status === "completed" || status === "failed" || status === "aborted") {
      return c.json(getRuntime(c).listInstancesWithDeadline(status));
    }
    return c.json(getRuntime(c).listInstancesWithDeadline());
  });

  // 列出每个缓存的 workflow_spec，带 `isBuiltIn` 标志——按 spec 的 source_path
  // 是否在后台服务内置 starter 目录下计算。挂载在 /:instance_id 之前
  // （Phase A R1 SSE 路由顺序教训），使字面 `/specs` 路径不被裸参数 catchall 遮蔽。
  app.get("/specs", (c) => {
    const runtime = getRuntime(c);
    const builtinDirAbs = c.get("workflowBuiltinSpecsDir" as never) as string | undefined;
    const rows = runtime.specCache.listAll();
    const payload = rows.map((row) => ({
      name: row.name,
      version: row.version,
      purpose: row.purpose,
      targetRig: row.targetRig,
      coordinationTerminalTurnRule: row.coordinationTerminalTurnRule,
      sourcePath: row.sourcePath,
      cachedAt: row.cachedAt,
      isBuiltIn: builtinDirAbs ? isUnderDir(row.sourcePath, builtinDirAbs) : false,
    }));
    return c.json({ specs: payload });
  });

  // workflow.* 事件的 SSE。必须在 /:instance_id 之前（Phase A R1 教训）。
  const sseHandler = (c: Parameters<typeof streamSSE>[0]) => {
    const eventBus = getEventBus(c);
    return streamSSE(c, async (stream) => {
      const unsubscribe = eventBus.subscribe((event) => {
        if (
          event.type !== "workflow.revised" &&
          event.type !== "workflow.instantiated" &&
          event.type !== "workflow.step_closed" &&
          event.type !== "workflow.next_qitem_projected" &&
          event.type !== "workflow.completed" &&
          event.type !== "workflow.failed" &&
          // OPR.0.4.6.WF5（rev1-r2 B2 fold）：resume 实时流式发出——
          // run/watch 跟随者看到 redrive，而非静默缺口。
          event.type !== "workflow.resumed" &&
          event.type !== "workflow.routing_table_changed"
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

  // OPR.0.4.6.WF3 FR-4——唯一的 WF-3 变更：重路由当前 frontier step
  // （close+recreate+rebind，一个 scribe txn，在 runtime 内）。
  app.post("/:instance_id/route", async (c) => {
    const instanceId = c.req.param("instance_id");
    const body = await c.req
      .json<{ packetId?: string; toSession?: string; actorSession?: string; reason?: string }>()
      .catch(() => ({}) as never);
    if (!body.toSession) return c.json({ error: "toSession 为必填项" }, 400);
    if (!body.actorSession) return c.json({ error: "actorSession 为必填项" }, 400);
    try {
      const result = await getRuntime(c).route({
        instanceId,
        packetId: body.packetId,
        toSession: body.toSession,
        actorSession: body.actorSession,
        reason: body.reason,
      });
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/:instance_id/resume", async (c) => {
    const instanceId = c.req.param("instance_id");
    const body = await c.req
      .json<{ occurrenceId?: string; decision?: string; actorSession?: string }>()
      .catch(() => ({}) as never);
    if (!body.actorSession) return c.json({ error: "actorSession 为必填项" }, 400);
    try {
      const result = await getRuntime(c).resume({
        instanceId,
        occurrenceId: body.occurrenceId,
        decision: body.decision,
        actorSession: body.actorSession,
      });
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/:instance_id/abort", async (c) => {
    const instanceId = c.req.param("instance_id");
    const body = await c.req.json<{ reason?: string; actorSession?: string }>().catch(() => ({} as never));
    if (!body.reason) return c.json({ error: "reason 为必填项" }, 400);
    if (!body.actorSession) return c.json({ error: "actorSession 为必填项" }, 400);
    try {
      return c.json(await getRuntime(c).abort({ instanceId, reason: body.reason, actorSession: body.actorSession }));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get("/:instance_id/trace", (c) => {
    const instanceId = c.req.param("instance_id");
    try {
      const result = getRuntime(c).continue(instanceId);
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/:instance_id/continue", (c) => {
    const instanceId = c.req.param("instance_id");
    try {
      const result = getRuntime(c).continue(instanceId);
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get("/:instance_id/guidance", (c) => {
    try {
      return c.json(getRuntime(c).guidance(c.req.param("instance_id"), {
        packetId: c.req.query("packet"), component: c.req.query("component"), full: c.req.query("full") === "true",
      }));
    } catch (err) { return errorResponse(c, err); }
  });

  app.get("/:instance_id", (c) => {
    const instanceId = c.req.param("instance_id");
    const runtime = getRuntime(c);
    const inst = runtime.instanceStore.getById(instanceId);
    if (!inst) return c.json({ error: "instance_not_found", instanceId }, 404);
    // WF-1 FR-2 完成回修：show 携带 deadline 结论。
    const inspected = runtime.inspect(instanceId);
    return c.json({
      ...runtime.withDeadline(inst),
      guidance: runtime.guidance(instanceId),
      exceptionReadiness: runtime.exceptionReadiness(instanceId),
      exceptionObligations: runtime.exceptionObligations(instanceId),
      ...(inst.lifecycleBinding ? { reconciliation: runtime.inspectGraph(instanceId) } : {}),
      frontierPackets: inspected.frontier,
      failureOccurrences: inspected.failures,
      unknowns: inspected.unknowns,
      boundaryObligations: inspected.boundaryObligations,
    });
  });

  return app;
}

/**
 * 当 childPath 在磁盘上解析到 parentDir 严格子目录下时返回 true。
 * 两个输入先解析为绝对路径；父比较追加尾部 path.sep，
 * 以避免 `/foo/bar-other` 误匹配 `/foo/bar` 的假阳性。
 */
function isUnderDir(childPath: string, parentDir: string): boolean {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentDir);
  if (child === parent) return false;
  const parentWithSep = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return child.startsWith(parentWithSep);
}
