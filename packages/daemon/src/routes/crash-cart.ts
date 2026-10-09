// B1 —— crash-cart 恢复指挥路由（后台服务侧批量动词）。计划已锁定
// （B1-CRASH-CART-CONDUCTOR-PLAN-2026-08-21，content-hash 84401cd4）。异步 on-commit
// 形态（锁定的 rollup-stream / onAttemptStarted 设计）：本路由在后台启动指挥器，
// 并立即返回一个 fleet-attempt 句柄——它绝不阻塞到 fleet 完成（真实 fleet 恢复每个席位数秒，
// 会超过任何请求超时）。客户端轮询状态端点，随各工作组完成获取 rollup + 分诊。
// 取消端点设置「在下一个工作组前停止」。
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SnapshotRepository } from "../domain/snapshot-repository.js";
import type { RestoreOrchestrator } from "../domain/restore-orchestrator.js";
import type { RuntimeAdapter } from "../domain/runtime-adapter.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { ClaimService } from "../domain/claim-service.js";
import {
  RestoreConductor,
  createDefaultRestoreRig,
  listRigsInKernelFirstOrder,
  aggregateFleetRollup,
  deriveFleetVerdict,
  type AdoptRigDeps,
  type FleetRollup,
  type ConductorRigResult,
} from "../domain/crash-cart-conductor.js";

export const crashCartRoutes = new Hono();

/** 一次活动的 fleet 恢复尝试——可轮询的进度/rollup 状态，由后台指挥器在每个工作组完成时更新。
 *  每个后台服务进程内存态（v1）。无 verdict 字段：按 ARCH-RULING Q2 / plan R6，fleet 判定是
 *  由 counts 派生的 f(counts)，绝不是存储的第二事实——它在 GET 处理器中计算。 */
interface FleetAttempt {
  sequence: ConductorRigResult[];
  rollup: FleetRollup;
  done: boolean;
  cancelled: boolean;
}
const fleetAttempts = new Map<string, FleetAttempt>();

// 仅导出供测试用——在各用例之间重置内存存储。
export function __resetFleetAttempts(): void {
  fleetAttempts.clear();
}

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    rigRepo: c.get("rigRepo" as never) as RigRepository,
    snapshotRepo: c.get("snapshotRepo" as never) as SnapshotRepository,
    restoreOrchestrator: c.get("restoreOrchestrator" as never) as RestoreOrchestrator,
    // H1——应用的 runtime 适配器 + fs；缺了它们，编排器会把 pod 感知恢复失败关闭为
    // awaiting-decision（席位无法在其窗格中返回）。
    runtimeAdapters: c.get("runtimeAdapters" as never) as Record<string, RuntimeAdapter> | undefined,
    // AMENDMENT 2——adopt 分支所组装的已交付机制。
    sessionRegistry: c.get("sessionRegistry" as never) as SessionRegistry | undefined,
    tmuxAdapter: c.get("tmuxAdapter" as never) as TmuxAdapter | undefined,
    claimService: c.get("claimService" as never) as ClaimService | undefined,
  };
}

/** AMENDMENT 2——用已交付机制构建 adopt 依赖；当降级后台服务缺少其中任何一项时返回
 *  undefined（指挥器随后表现得与修订前完全一致：活动窗格的工作组通过 restore 自己的 409
 *  失败关闭——不覆盖、无新路径）。 */
function buildAdoptDeps(deps: ReturnType<typeof getDeps>): AdoptRigDeps | undefined {
  const { rigRepo, sessionRegistry, tmuxAdapter, claimService, restoreOrchestrator, runtimeAdapters } = deps;
  if (!sessionRegistry || !tmuxAdapter || !claimService) return undefined;
  return {
    // 与 restore 的 409 守卫相同的分类：DB 中 running 的会话 × tmux 现实。tmux 错误不算活动
    // （双向失败关闭：不可探测的窗格在此绝不 adopt，restore 自己的 unknown-blocks 守卫仍会拒绝）。
    probeLiveSessions: async (rigId) => {
      const rig = rigRepo.getRig(rigId);
      if (!rig) return [];
      const logicalByNodeId = new Map(rig.nodes.map((n) => [n.id, n.logicalId]));
      const live: Array<{ sessionName: string; logicalId: string }> = [];
      for (const session of sessionRegistry.getSessionsForRig(rigId)) {
        if (session.status !== "running") continue;
        const logicalId = logicalByNodeId.get(session.nodeId);
        if (!logicalId) continue;
        try {
          if (await tmuxAdapter.hasSession(session.sessionName)) {
            live.push({ sessionName: session.sessionName, logicalId });
          }
        } catch { /* 失败关闭：不可探测 ≠ 活动 */ }
      }
      return live;
    },
    reconcileSession: (sessionName) => claimService.reconcileSession({ sessionName }),
    listRigSeats: (rigId) => rigRepo.getRig(rigId)?.nodes.map((n) => n.logicalId) ?? [],
    launchNodeSubset: (rigId, logicalIds) =>
      restoreOrchestrator.launchNodeSubset(rigId, logicalIds, {
        adapters: runtimeAdapters ?? {},
        fsOps: { exists: (p: string) => existsSync(p) },
      }),
  };
}

function recompute(attempt: FleetAttempt): void {
  attempt.rollup = aggregateFleetRollup(attempt.sequence);
}

// POST /api/crash-cart/restore-fleet——启动 fleet 恢复，on-commit 即应答。
crashCartRoutes.post("/restore-fleet", (c) => {
  const deps = getDeps(c);
  const { rigRepo, snapshotRepo, restoreOrchestrator, runtimeAdapters } = deps;
  const fleetAttemptId = `fleet-${randomUUID()}`;
  const attempt: FleetAttempt = {
    sequence: [],
    rollup: aggregateFleetRollup([]),
    done: false,
    cancelled: false,
  };
  fleetAttempts.set(fleetAttemptId, attempt);

  const conductor = new RestoreConductor({
    listRigsInOrder: () => listRigsInKernelFirstOrder({ listRigs: () => rigRepo.listRigs() }),
    restoreRig: createDefaultRestoreRig(
      {
        findLatestRestoreUsable: (rigId) => snapshotRepo.findLatestRestoreUsable(rigId),
        ...(typeof snapshotRepo.selectRestoreUsable === "function"
          ? { selectRestoreUsable: (rigId: string) => snapshotRepo.selectRestoreUsable(rigId) }
          : {}),
        // H1——把应用的适配器 + fsOps 穿入已交付的 restore。
        restore: (snapshotId, opts) =>
          restoreOrchestrator.restore(snapshotId, {
            ...opts,
            adapters: runtimeAdapters ?? {},
            fsOps: { exists: (p: string) => existsSync(p) },
          }),
      },
      // AMENDMENT 2——活动窗格通过已交付机制 adopt；死窗格不变。
      buildAdoptDeps(deps),
    ),
    // H3——运行中尝试的取消标志，被轮询以实现「在下一个工作组前停止」。
    isCancelled: () => attempt.cancelled,
  });

  // 在后台运行 fleet 恢复——响应早已发出。每个工作组完成时更新可轮询的 rollup（进度流）。
  void conductor
    .restoreFleet({
      onRigDone: (r) => {
        attempt.sequence.push(r);
        recompute(attempt);
      },
    })
    .then(() => {
      attempt.done = true;
    })
    .catch(() => {
      // 尽力而为：fleet 循环本身按工作组守卫；标记 done 使客户端停止轮询。
      // 各工作组的失败已在 rollup 中。
      attempt.done = true;
    });

  // on-commit 应答（立即）——绝不阻塞到 fleet 完成（r1 根）。
  return c.json({ fleetAttemptId, status: "started" }, 202);
});

// GET /api/crash-cart/restore-fleet/:fleetAttemptId——轮询进度 + rollup/分诊。
crashCartRoutes.get("/restore-fleet/:fleetAttemptId", (c) => {
  const attempt = fleetAttempts.get(c.req.param("fleetAttemptId"));
  if (!attempt) return c.json({ error: "未知的 fleet 恢复尝试" }, 404);
  // verdict 在读取时从当前 counts 派生（R6 / ARCH-RULING Q2）——绝不是存储字段。
  return c.json({
    done: attempt.done,
    cancelled: attempt.cancelled,
    rollup: attempt.rollup,
    verdict: deriveFleetVerdict(attempt.rollup.counts),
  });
});

// POST /api/crash-cart/restore-fleet/:fleetAttemptId/cancel——在下一个工作组前停止。
crashCartRoutes.post("/restore-fleet/:fleetAttemptId/cancel", (c) => {
  const attempt = fleetAttempts.get(c.req.param("fleetAttemptId"));
  if (!attempt) return c.json({ error: "未知的 fleet 恢复尝试" }, 404);
  attempt.cancelled = true;
  return c.json({ ok: true, cancelled: true });
});
