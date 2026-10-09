import { Hono } from "hono";
import { RigNotFoundError } from "../domain/errors.js";
import type { SnapshotCapture } from "../domain/snapshot-capture.js";
import type { SnapshotRepository } from "../domain/snapshot-repository.js";
import type { RestoreOrchestrator } from "../domain/restore-orchestrator.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { ResumeMetadataRefresher } from "../domain/resume-metadata-refresher.js";
import type { RigRepository } from "../domain/rig-repository.js";
import { deriveRestoreAttemptReceipt } from "../domain/restore-attempt-receipt.js";

export const snapshotsRoutes = new Hono();
export const restoreRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    snapshotCapture: c.get("snapshotCapture" as never) as SnapshotCapture,
    snapshotRepo: c.get("snapshotRepo" as never) as SnapshotRepository,
    restoreOrchestrator: c.get("restoreOrchestrator" as never) as RestoreOrchestrator,
    // OPR.0.4.3.20 FR-4——用于手动快照在序列化前刷新。
    resumeMetadataRefresher: c.get("resumeMetadataRefresher" as never) as ResumeMetadataRefresher | undefined,
    sessionRegistry: c.get("sessionRegistry" as never) as SessionRegistry | undefined,
    rigRepo: c.get("rigRepo" as never) as RigRepository,
  };
}

// POST /api/rigs/:rigId/snapshots
snapshotsRoutes.post("/", async (c) => {
  const rigId = c.req.param("rigId")!;
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const kind = typeof body["kind"] === "string" ? body["kind"] : "manual";
  const { snapshotCapture, resumeMetadataRefresher, sessionRegistry, rigRepo } = getDeps(c);

  try {
    // OPR.0.4.3.20 FR-4——序列化前刷新 live token，放在它自己的 try/catch 里，
    // 这样刷新抛错绝不跳过快照（守卫注意事项）。
    if (resumeMetadataRefresher && sessionRegistry) {
      try {
        // fillNullOnly：例行快照刷新只填 null token（轻量 sidecar/pid-log 读取），
        // 但绝不清除已存在的 token，也绝不派生 `claude --resume` 探针
        // （rev1 修复——为 FR-6 保留 stale-present，无周期性探针爆炸半径）。
        await resumeMetadataRefresher.refresh(
          sessionRegistry.getLatestLiveSessions(rigId),
          { fillNullOnly: true },
        );
      } catch { /* 尽力而为——下面的快照仍会写入 */ }
    }
    let intendedNodeIds: string[] | undefined;
    if (body["intendedSeats"] !== undefined) {
      if (!Array.isArray(body["intendedSeats"])) {
        return c.json({ error: "intendedSeats 必须是节点引用的非空数组" }, 400);
      }
      const rawRequested = body["intendedSeats"] as unknown[];
      if (rawRequested.length === 0 || !rawRequested.every((value) => typeof value === "string" && value.trim().length > 0)) {
        return c.json({ error: "intendedSeats 必须是节点引用的非空数组" }, 400);
      }
      const requested = rawRequested.map((value) => (value as string).trim());
      const rig = rigRepo.getRig(rigId);
      if (!rig) throw new RigNotFoundError(rigId);
      const byRef = new Map(rig.nodes.flatMap((node) => [[node.id, node.id], [node.logicalId, node.id]]));
      intendedNodeIds = requested.map((ref) => byRef.get(ref)).filter((id): id is string => !!id);
      if (intendedNodeIds.length !== requested.length || new Set(intendedNodeIds).size !== intendedNodeIds.length) {
        return c.json({ error: "每个 intendedSeats 条目都必须指定目标工作组中一个唯一节点" }, 400);
      }
    }
    const snapshot = snapshotCapture.captureSnapshot(rigId, kind, { intendedNodeIds });
    return c.json(snapshot, 201);
  } catch (err) {
    if (err instanceof RigNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: "捕获快照失败" }, 500);
  }
});

// GET /api/rigs/:rigId/restore/status/:attemptId——派生的只读回执。
restoreRoutes.get("/status/:attemptId", (c) => {
  const rigId = c.req.param("rigId")!;
  const attemptId = Number(c.req.param("attemptId"));
  if (!Number.isSafeInteger(attemptId) || attemptId < 1) {
    return c.json({ error: "attemptId 必须是正整数", code: "invalid_attempt_id" }, 400);
  }
  const { snapshotRepo } = getDeps(c);
  const receipt = deriveRestoreAttemptReceipt(snapshotRepo.db, rigId, attemptId);
  if (!receipt.ok) {
    const status = receipt.code === "attempt_not_found" || receipt.code === "attempt_wrong_rig" ? 404
      : receipt.code === "attempt_incomplete" ? 409
      : 500;
    return c.json({ error: receipt.message, code: receipt.code }, status);
  }
  return c.json(receipt);
});

// GET /api/rigs/:rigId/snapshots
snapshotsRoutes.get("/", (c) => {
  const rigId = c.req.param("rigId")!;
  const { snapshotRepo } = getDeps(c);
  return c.json(snapshotRepo.listSnapshots(rigId));
});

// GET /api/rigs/:rigId/snapshots/:id
snapshotsRoutes.get("/:id", (c) => {
  const rigId = c.req.param("rigId")!;
  const id = c.req.param("id")!;
  const { snapshotRepo } = getDeps(c);

  const snapshot = snapshotRepo.getSnapshot(id);
  if (!snapshot || snapshot.rigId !== rigId) {
    return c.json({ error: "未找到快照" }, 404);
  }

  return c.json(snapshot);
});

// POST /api/rigs/:rigId/restore/:snapshotId
//
// L3：编排器一发出 `restore.started` 就（在逐节点恢复工作完成之前）立即返回
// `{ ok: true, attemptId, status: "started", rigId }`。持久化的 `restore.started`
// 事件 seq 即 attempt id（决策 1：不单独建 restore_attempts 表）。逐节点工作在后台继续；
// 客户端查询事件日志 / 节点清单以跟进进度。
//
// 恢复前校验失败与其他「根本没起来」的错误，按合适的 HTTP 状态码（404/409/500）
// 返回原始错误负载，因为这些情况下没有发出 `restore.started` 事件。
restoreRoutes.post("/:snapshotId", async (c) => {
  const rigId = c.req.param("rigId")!;
  const snapshotId = c.req.param("snapshotId")!;
  const { snapshotRepo, restoreOrchestrator } = getDeps(c);

  // 跨工作组守卫：校验快照属于本工作组
  const snapshot = snapshotRepo.getSnapshot(snapshotId);
  if (!snapshot || snapshot.rigId !== rigId) {
    return c.json({ error: "未找到快照" }, 404);
  }

  const adapters = c.get("runtimeAdapters" as never) as Record<string, import("../domain/runtime-adapter.js").RuntimeAdapter> | undefined;
  const fs = await import("node:fs");

  return new Promise<Response>((resolve) => {
    let resolved = false;

    const restorePromise = restoreOrchestrator.restore(snapshotId, {
      adapters: adapters ?? {},
      fsOps: { exists: (p: string) => fs.existsSync(p) },
      onAttemptStarted: (attemptId) => {
        if (resolved) return;
        resolved = true;
        // 逐节点恢复工作在后台运行；客户端立即收到 attemptId，可轮询 /api/events 或节点清单看进度。
        resolve(c.json({ ok: true, attemptId, status: "started", rigId }, 202));
      },
    });

    restorePromise
      .then((outcome) => {
        if (resolved) {
          // 后台路径：响应已发出。逐节点失败在事件日志中；这里无需再做什么。
          return;
        }
        // 恢复前 started 的错误路径：未发出 `restore.started`，因此路由应按原始错误映射应答。
        resolved = true;
        if (!outcome.ok) {
          if (outcome.code === "pre_restore_validation_failed") {
            resolve(c.json({
              error: outcome.message,
              code: outcome.code,
              ...outcome.result,
              remediation: outcome.result.blockers?.map((blocker) => blocker.remediation) ?? [],
            }, 409));
            return;
          }
          const status = outcome.code === "snapshot_not_found" || outcome.code === "rig_not_found"
            ? 404
            : outcome.code === "snapshot_unusable" || outcome.code === "restore_in_progress" || outcome.code === "rig_not_stopped"
            ? 409
            : 500;
          resolve(c.json({ error: outcome.message, code: outcome.code }, status));
          return;
        }
        // 防御性：outcome.ok 但 onAttemptStarted 未触发，意味着编排器发出了 restore.started
        // 但回调不知怎么被绕过了。无论如何用合成的 attemptId 把结果显现出来。
        resolve(c.json({ ok: true, attemptId: -1, status: "completed", rigId, result: outcome.result }, 200));
      })
      .catch((err) => {
        if (resolved) return;
        resolved = true;
        resolve(c.json({
          error: err instanceof Error ? err.message : String(err),
          code: "restore_error",
        }, 500));
      });
  });
});
