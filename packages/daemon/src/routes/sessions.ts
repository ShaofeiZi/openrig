import { inventoryCaptureOptions, type ShadowCapture } from "../domain/shadow-capture.js";
import { Hono } from "hono";
import { getSelfHostId } from "../domain/hosts/fanout-contract.js";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { NodeLauncher } from "../domain/node-launcher.js";
import type { CmuxAdapter } from "../adapters/cmux.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { NodeCmuxService } from "../domain/node-cmux-service.js";
import type { TranscriptStore } from "../domain/transcript-store.js";
import type { AgentActivityStore } from "../domain/agent-activity-store.js";
import type { SeatActivityService } from "../domain/seat-activity-service.js";
import type { SeatStructuralActivityService } from "../domain/seat-structural-activity-service.js";
import {
  attachAgentActivity,
  attachTerminalActivityAndWork,
  getNodeInventory,
  getNodeDetail,
  getNodeInventoryWithContext,
  getNodeDetailWithContext,
} from "../domain/node-inventory.js";
import type { ContextUsageStore } from "../domain/context-usage-store.js";
import type { RigLifecycleService } from "../domain/rig-lifecycle-service.js";
import type { SessionTransport } from "../domain/session-transport.js";
import type { PreviewRateLimiter } from "../domain/preview/preview-rate-limiter.js";
import type { ClaimService } from "../domain/claim-service.js";
import type { PodRigInstantiator } from "../domain/rigspec-instantiator.js";
import { convergeOp } from "../domain/topology-converge.js";
import type { RestoreOrchestrator } from "../domain/restore-orchestrator.js";
import { launchStatusIsRunning } from "../domain/restore-orchestrator.js";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import type { MiddlewareHandler } from "hono";
import type { EventBus } from "../domain/event-bus.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import type { PermissionDriftReader } from "../domain/permission-drift-observer.js";
import { ProcessCensus } from "../domain/process-census.js";
import { CodexThreadIdResolver } from "../domain/codex-thread-id.js";
import { resolveLiveCodexThreadId } from "../domain/model-divergence/current-generation-record.js";
import { SeatIdentityStore } from "../domain/seat-identity-store.js";

const generationCensus = new ProcessCensus({ freshnessMs: 0 }); // 合并并发读取；之后每次读取都重新检查。
const generationThreadIds = new CodexThreadIdResolver();

function terminalAuthGuard(): MiddlewareHandler {
  return async (c, next) => {
    const token = (c.get("terminalBearerToken" as never) as string | null | undefined) ?? null;
    const mw = authBearerTokenMiddleware({ expectedToken: token });
    return mw(c, next);
  };
}

export const sessionsRoutes = new Hono();
export const nodesRoutes = new Hono();
export const sessionAdminRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    shadowCapture: c.get("shadowCapture" as never) as ShadowCapture | undefined,
    rigRepo: c.get("rigRepo" as never) as RigRepository,
    sessionRegistry: c.get("sessionRegistry" as never) as SessionRegistry,
    nodeLauncher: c.get("nodeLauncher" as never) as NodeLauncher,
    tmuxAdapter: c.get("tmuxAdapter" as never) as TmuxAdapter,
    cmuxAdapter: c.get("cmuxAdapter" as never) as CmuxAdapter,
    agentActivityStore: c.get("agentActivityStore" as never) as AgentActivityStore | undefined,
    seatActivityService: c.get("seatActivityService" as never) as SeatActivityService | undefined,
    seatStructuralActivityService: c.get("seatStructuralActivityService" as never) as SeatStructuralActivityService | undefined,
    rigLifecycleService: c.get("rigLifecycleService" as never) as RigLifecycleService | undefined,
    restoreOrchestrator: c.get("restoreOrchestrator" as never) as RestoreOrchestrator | undefined,
  };
}

function narrowLaunchErrorStatus(code: string | undefined): 404 | 409 | 500 {
  if (code === "rig_not_found" || code === "no_matching_nodes" || code === "snapshot_not_found" || code === "snapshot_wrong_rig" || code === "no_usable_snapshot") return 404;
  if (code === "snapshot_unusable") return 409;
  return 500;
}

// OPR.0.4.3.20 FR-7（缺口 2a）：构造节点子集启动所需的运行时适配器和 fsOps，
// 让识别 Pod 的席位执行与完整恢复相同的续接/连续性校验（与 routes/snapshots.ts 一致）。
// 缺少这些依赖时，launchNodeSubset 会跳过校验并返回 `fresh-primed`，形成静默
// fresh-prime。未接入适配器时，FR-7 的失败关闭规则会让续接席位停在 awaiting-decision。
async function resumeLaunchOpts(c: { get: (key: string) => unknown }): Promise<{
  adapters: Record<string, import("../domain/runtime-adapter.js").RuntimeAdapter>;
  fsOps: { exists(path: string): boolean };
}> {
  const adapters = (c.get("runtimeAdapters" as never) as Record<string, import("../domain/runtime-adapter.js").RuntimeAdapter> | undefined) ?? {};
  const fs = await import("node:fs");
  return { adapters, fsOps: { exists: (p: string) => fs.existsSync(p) } };
}

// GET /api/rigs/:rigId/sessions
sessionsRoutes.get("/", (c) => {
  const rigId = c.req.param("rigId")!;
  const { sessionRegistry } = getDeps(c);
  return c.json(sessionRegistry.getSessionsForRig(rigId));
});

// GET /api/rigs/:rigId/nodes——节点清单投影。
// ?refresh=true 会在响应前触发 context-monitor 重新采样。
nodesRoutes.get("/", async (c) => {
  const rigId = c.req.param("rigId")!;
  const deps = getDeps(c);
  const rig = deps.rigRepo.getRig(rigId);
  if (!rig) return c.json({ error: `未找到工作组 "${rigId}"。用 zrig ps 列出工作组` }, 404);

  const refresh = c.req.query("refresh") === "true";
  if (refresh) {
    const monitor = c.get("contextMonitor" as never) as { pollOnce(): Promise<void> } | undefined;
    if (monitor) {
      try {
        await monitor.pollOnce();
      } catch (err) {
        return c.json({
          error: "上下文刷新失败。可能返回过期数据。",
          code: "context_refresh_failed",
          detail: err instanceof Error ? err.message : String(err),
        }, 502);
      }
    }
  }

  const contextUsageStore = c.get("contextUsageStore" as never) as ContextUsageStore | undefined;
  const transcriptStore = c.get("transcriptStore" as never) as TranscriptStore | undefined;
  const inventory = contextUsageStore
    ? getNodeInventoryWithContext(deps.rigRepo.db, rigId, contextUsageStore, transcriptStore)
    : getNodeInventory(deps.rigRepo.db, rigId);
  // Slice 15：用两个新的正交原语充实数据。二者顺序互不影响（各自读取独立来源），
  // 因而可与 attachAgentActivity 顺畅组合。禁止推断契约由数据层维持；此路由只负责
  // 组装 JSON 响应。
  // OPR.0.4.3 healthz 阻塞放大修复：默认采用低成本路径（不逐节点捕获 tmux）。
  // ?full=true / ?refresh=true 才启用逐节点兜底，后者已在上方隐含一次全新扫描。
  const full = c.req.query("full") === "true" || refresh;
  const withActivity = await attachAgentActivity(inventory, {
    ...inventoryCaptureOptions(deps.rigRepo.db, deps.shadowCapture),
    tmuxAdapter: deps.tmuxAdapter,
    activityStore: deps.agentActivityStore,
    structuralActivity: deps.seatStructuralActivityService,
    // ACTIVITY D1+D2：下方 `attachTerminalActivityAndWork` 读取同一个
    // SeatActivityService 实例。现在一份观测同时供给 TERMINAL 列和 ACTIVITY 判定。
    //
    // 二者仍可有意地不一致：TERMINAL 投影在轮询时计算并缓存的
    // `isActiveWithinWindow`，而 ACTIVITY 会按请求时钟重新评估原始 `lastActivityAt`
    // 的时效。tmux 读取持续失败时，`pollSeat` 会保留最后一条记录，因此窗格沉寂很久后
    // 缓存布尔值仍可能是 `true`；TERMINAL 继续报告这个陈旧的 `true`，ACTIVITY 则拒绝它。
    //
    // 这种差异正是陈旧缓存保护在发挥作用，而不是需要调和的不一致。不要通过让
    // ACTIVITY 重新信任缓存布尔值来“修复”它：重新评估时效本身就是守卫；移除该守卫
    // 会让不可用的观测再次被解读为肯定的存活声明。
    seatActivity: deps.seatActivityService,
    captureFallback: full,
  });
  const withTerminalAndWork = attachTerminalActivityAndWork(withActivity, {
    db: deps.rigRepo.db,
    seatActivity: deps.seatActivityService,
  });
  // Slice 13 修复 2：在源头标注主机归属。后台服务只清点本机席位，因此它提供的
  // 每一行都位于本主机。此处写入启动协调后的 self-id，可使合并后的多主机名册仍能
  // 逐行追溯归属；缺少某台主机的名册会明确表现为不完整，而不会看似权威。启动协调前
  // 显式写 null：键始终存在，所以“尚未知晓”是一个值，不会成为使用方可能误读的缺失。
  // 只使用 selfHostId，绝不使用 host.name（后者仅供展示，DP4 混淆检查的 healthz 已拒绝它）。
  const hostSelfId = getSelfHostId();
  return c.json(withTerminalAndWork.map((n) => ({ ...n, hostSelfId })));
});

// GET /api/rigs/:rigId/nodes/:logicalId——节点详情。
nodesRoutes.get("/:logicalId", async (c) => {
  const rigId = c.req.param("rigId")!;
  const logicalId = decodeURIComponent(c.req.param("logicalId")!);
  const deps = getDeps(c);
  const rig = deps.rigRepo.getRig(rigId);
  if (!rig) return c.json({ error: `未找到工作组 "${rigId}"。用 zrig ps 列出工作组` }, 404);
  const contextUsageStore = c.get("contextUsageStore" as never) as ContextUsageStore | undefined;
  const detail = contextUsageStore
    ? getNodeDetailWithContext(deps.rigRepo.db, rigId, logicalId, contextUsageStore)
    : getNodeDetail(deps.rigRepo.db, rigId, logicalId);
  if (!detail) return c.json({ error: `在工作组 "${rigId}" 中未找到节点 "${logicalId}"。用 zrig ps --nodes 查看节点 ID` }, 404);
  // 节点详情只涉及单个节点，逐节点 tmux 捕获在此成本很低，因此详情始终执行完整兜底，
  // 为这个席位获取最新的 needs_input。
  const [detailWithActivity] = await attachAgentActivity([detail], { ...inventoryCaptureOptions(deps.rigRepo.db, deps.shadowCapture), tmuxAdapter: deps.tmuxAdapter, activityStore: deps.agentActivityStore, seatActivity: deps.seatActivityService, captureFallback: true });
  const [detailWithTerminalAndWork] = attachTerminalActivityAndWork(detailWithActivity ? [detailWithActivity] : [detail], {
    db: deps.rigRepo.db,
    seatActivity: deps.seatActivityService,
  });
  Object.assign(detail, {
    agentActivity: detailWithTerminalAndWork?.agentActivity,
    terminalActive: detailWithTerminalAndWork?.terminalActive,
    // 架构裁定 3a947fb1：节点详情也提供原始 lastActivityAt 事实
    //（列表路由会整体提供完整条目），保持逐席位界面一致。
    lastActivityAt: detailWithTerminalAndWork?.lastActivityAt,
    hasAssignedWork: detailWithTerminalAndWork?.hasAssignedWork,
    pendingWorkCount: detailWithTerminalAndWork?.pendingWorkCount,
    // Slice 13 修复 2：采用与列表路由相同的主机归属标注（见该处注释）。
    hostSelfId: getSelfHostId(),
  });

  // W3：详情针对一个明确席位，因此此处允许只读文件系统观测；列表路径有意不包含它。
  const observer = c.get("permissionDriftObserver" as never) as PermissionDriftReader | undefined;
  if (observer) {
    const row = deps.rigRepo.db.prepare("SELECT id FROM nodes WHERE rig_id = ? AND logical_id = ?")
      .get(rigId, logicalId) as { id: string } | undefined;
    if (row) detail.permissionDrift = observer.diagnose(row.id);
  }

  // PL-019 第 5 项：节点存在会话名时，在节点详情中呈现 in-progress qitem，
  // 其充实数据的形态与 /graph 载荷一致。
  if (detail.canonicalSessionName) {
    const rows = deps.rigRepo.db.prepare(
      `SELECT qitem_id, body, tier
         FROM queue_items
         WHERE state = 'in-progress' AND destination_session = ?
         ORDER BY ts_updated DESC
         LIMIT 3`
    ).all(detail.canonicalSessionName) as Array<{ qitem_id: string; body: string; tier: string | null }>;
    Object.assign(detail, {
      currentQitems: rows.map((r) => ({
        qitemId: r.qitem_id,
        bodyExcerpt: r.body.length > 80 ? `${r.body.slice(0, 80)}…` : r.body,
        tier: r.tier,
      })),
    });
  }

  // 从 TranscriptStore 补充会话记录信息（纯 DB 辅助函数无法获取）。
  const transcriptStore = c.get("transcriptStore" as never) as TranscriptStore | undefined;
  if (transcriptStore?.enabled && detail.canonicalSessionName) {
    const path = transcriptStore.getTranscriptPath(rig.rig.name, detail.canonicalSessionName);
    detail.transcript = {
      enabled: true,
      path,
      tailCommand: `zrig transcript ${detail.canonicalSessionName} --tail 100`,
    };
  }

  return c.json(detail);
});

// POST /api/rigs/:rigId/nodes/:logicalId/launch——启动单个节点。
nodesRoutes.post("/:logicalId/launch", async (c) => {
  const rigId = c.req.param("rigId")!;
  const logicalId = c.req.param("logicalId")!;
  const { rigRepo, nodeLauncher } = getDeps(c);

  const rig = rigRepo.getRig(rigId);
  if (!rig) {
    return c.json({ ok: false, code: "rig_not_found", error: `未找到工作组 "${rigId}"` }, 404);
  }

  const node = rig.nodes.find((entry) => entry.logicalId === logicalId || entry.id === logicalId);
  if (!node) {
    return c.json({ ok: false, code: "node_not_found", error: `在工作组 "${rigId}" 中未找到节点 "${logicalId}"` }, 404);
  }

  const body = await c.req.json().catch(() => ({})) as { snapshotId?: string; retryStartupFrom?: { member?: Record<string, unknown>; rigRoot?: string } };
  if (body.retryStartupFrom !== undefined) {
    const retry = body.retryStartupFrom;
    if (body.snapshotId || !retry || !retry.member || typeof retry.member !== "object" || Array.isArray(retry.member) || typeof retry.rigRoot !== "string") {
      return c.json({ ok: false, code: "invalid_retry", message: "请提供 retryStartupFrom.member 和绝对路径 rigRoot，不要带 snapshotId。" }, 400);
    }
    const instantiator = c.get("podInstantiator" as never) as PodRigInstantiator | undefined;
    if (!instantiator) return c.json({ ok: false, code: "internal_error", message: "Pod 实例化器不可用" }, 500);
    const result = await instantiator.retryFirstStart(rigId, node.id, retry.member, retry.rigRoot);
    return c.json(result, result.ok ? 201 : result.code === "failed" ? 500 : 409);
  }

  if (node.podId) {
    const { restoreOrchestrator } = getDeps(c);
    if (!restoreOrchestrator) {
      return c.json({ ok: false, code: "internal_error", error: "恢复编排器不可用" }, 500);
    }
    const result = await restoreOrchestrator.launchSingleNode(rigId, node.logicalId, { snapshotId: body.snapshotId, ...(await resumeLaunchOpts(c)) });
    if (!result.ok) {
      return c.json(result, narrowLaunchErrorStatus(result.code));
    }
    const failedTarget = result.failedTargets?.find((n) => n.logicalId === node.logicalId);
    if (failedTarget) {
      return c.json({ ok: false, code: "target_liveness_unknown", error: `目标 '${node.logicalId}' tmux 探测失败（fail-closed）。无法判断席位是否存活。`, failedTargets: result.failedTargets }, 503);
    }
    const launchedNode = result.launched?.[0];
    if (launchedNode) {
      // OPR.0.4.3.20 FR-7：恢复结果若落在 awaiting-decision、attention_required
      // 或 failed，就不算启动成功（没有会话正在运行）。绝不能报告为 201 ok:true；
      // 必须如实呈现，让 CLI 以非零状态退出。
      if (!launchStatusIsRunning(launchedNode.status)) {
        return c.json({
          ok: false, rigId, nodeId: launchedNode.nodeId, logicalId: launchedNode.logicalId,
          code: launchedNode.status, status: launchedNode.status, error: launchedNode.error,
          launched: result.launched, held: result.held, warnings: result.warnings,
          snapshotSelection: result.snapshotSelection, nonTargetEffects: result.nonTargetEffects,
        }, launchedNode.status === "failed" ? 500 : 409);
      }
      return c.json({ ok: true, rigId, nodeId: launchedNode.nodeId, logicalId: launchedNode.logicalId, launched: result.launched, held: result.held, alreadyRunning: result.alreadyRunning, warnings: result.warnings, snapshotSelection: result.snapshotSelection, nonTargetEffects: result.nonTargetEffects }, 201);
    }
    const alreadyRunningNode = result.alreadyRunning?.find((n) => n.logicalId === node.logicalId);
    if (alreadyRunningNode) {
      return c.json({ ok: true, rigId, nodeId: alreadyRunningNode.nodeId, logicalId: alreadyRunningNode.logicalId, code: "already_running", launched: result.launched, held: result.held, alreadyRunning: result.alreadyRunning, snapshotSelection: result.snapshotSelection, nonTargetEffects: result.nonTargetEffects });
    }
    return c.json(result);
  }

  const result = await nodeLauncher.launchNode(rigId, logicalId);

  if (!result.ok) {
    const status = result.code === "node_not_found" ? 404
      : result.code === "already_bound" ? 409
      : result.code === "invalid_session_name" ? 400
      : 500;
    return c.json(result, status);
  }

  return c.json(result, 201);
});

// POST /api/rigs/:rigId/nodes/launch-subset——多目标受管子集启动。
nodesRoutes.post("/launch-subset", async (c) => {
  const rigId = c.req.param("rigId")!;
  const { restoreOrchestrator } = getDeps(c);
  if (!restoreOrchestrator) {
    return c.json({ ok: false, code: "internal_error", error: "恢复编排器不可用" }, 500);
  }
  const body = await c.req.json().catch(() => ({})) as { seats?: string[]; holdReason?: string; snapshotId?: string; plan?: boolean };
  if (!Array.isArray(body.seats) || body.seats.length === 0) {
    return c.json({ ok: false, code: "invalid_request", error: "请求 body 必须包含非空的 'seats' 逻辑 ID 数组" }, 400);
  }
  const result = body.plan === true
    ? restoreOrchestrator.planNodeSubset(rigId, body.seats, { holdReason: body.holdReason, snapshotId: body.snapshotId })
    : await restoreOrchestrator.launchNodeSubset(rigId, body.seats, { holdReason: body.holdReason, snapshotId: body.snapshotId, ...(await resumeLaunchOpts(c)) });
  if (!result.ok) {
    return c.json(result, narrowLaunchErrorStatus(result.code));
  }
  // OPR.0.4.3.20 FR-7：目标若落在 awaiting-decision、attention_required 或 failed，
  // 就不算已启动（没有运行中的会话）。成功要求至少有一个启动结果正在运行，且没有任何
  // 非运行目标；否则返回 ok:false 和 409，让 CLI 以非零状态退出，绝不打印虚假的“已启动”。
  const launchedEntries = result.launched ?? [];
  const nonRunning = launchedEntries.filter((n) => !launchStatusIsRunning(n.status));
  const running = launchedEntries.filter((n) => launchStatusIsRunning(n.status));
  const status = nonRunning.length > 0 ? 409 : running.length > 0 ? 201 : 200;
  return c.json({ ...result, ok: nonRunning.length === 0 && result.ok }, status);
});

// GET /api/rigs/:rigId/nodes/:logicalId/preview?lines=N
//
// 终端预览 v0（PL-018）：通过 SessionTransport.capture 返回席位最后 N 行。
// 后台服务侧 PreviewRateLimiter 按会话限流（默认窗口为 1 秒），避免多个窗格的
// 实时轮询集中冲击 tmux。
//
// 无法解析工作组、节点或会话时返回 404（UI 显示为“此工作组无法预览”）。
// 上下文缺少 SessionTransport（后台服务降级）时返回 503。
nodesRoutes.get("/:logicalId/preview", terminalAuthGuard(), async (c) => {
  const rigId = c.req.param("rigId")!;
  const logicalId = decodeURIComponent(c.req.param("logicalId")!);
  const deps = getDeps(c);
  const sessionTransport = c.get("sessionTransport" as never) as SessionTransport | undefined;
  const rateLimiter = c.get("previewRateLimiter" as never) as PreviewRateLimiter<{
    content: string;
    lines: number;
    sessionName: string;
    capturedAt: string;
  }> | undefined;
  if (!sessionTransport) {
    return c.json({ error: "preview_unavailable", hint: "本后台服务未配置 SessionTransport。" }, 503);
  }

  const rig = deps.rigRepo.getRig(rigId);
  if (!rig) return c.json({ error: `未找到工作组 "${rigId}"。` }, 404);

  // 解析规范会话名。节点详情投影器已执行同样操作；此处复用原始工作组对象，
  // 以保持路由低成本。
  const node = rig.nodes.find((n) => n.logicalId === logicalId || n.id === logicalId);
  if (!node) return c.json({ error: `在工作组 "${rigId}" 中未找到节点 "${logicalId}"。` }, 404);
  const sessionName = node.binding?.tmuxSession;
  if (!sessionName) {
    return c.json({
      error: "session_unbound",
      hint: "节点尚无 tmux 会话。用 zrig up 或 zrig launch 启动席位。",
    }, 409);
  }

  const linesRaw = c.req.query("lines");
  const linesParsed = linesRaw ? parseInt(linesRaw, 10) : NaN;
  // 将行数限制在合理范围；默认 50 行，与 v0 UI 偏好一致。
  const lines = Number.isFinite(linesParsed) && linesParsed > 0
    ? Math.min(linesParsed, 1000)
    : 50;

  // 缓存键包含行数，避免 50 行轮询污染 200 行手动获取，反之亦然。
  const cacheKey = `${sessionName}:${lines}`;
  const cached = rateLimiter?.get(cacheKey);
  if (cached) {
    return c.json(cached.payload);
  }

  const result = await sessionTransport.capture(sessionName, { lines });
  if (!result.ok) {
    return c.json({
      error: result.reason ?? "capture_failed",
      hint: result.error,
      sessionName,
    }, 502);
  }
  const payload = {
    content: result.content ?? "",
    lines: result.lines ?? lines,
    sessionName,
    capturedAt: new Date().toISOString(),
  };
  rateLimiter?.set(cacheKey, payload);
  return c.json(payload);
});

// POST /api/rigs/:rigId/nodes/:logicalId/open-cmux
nodesRoutes.post("/:logicalId/open-cmux", terminalAuthGuard(), async (c) => {
  const rigId = c.req.param("rigId")!;
  const logicalId = decodeURIComponent(c.req.param("logicalId")!);
  const nodeCmuxService = c.get("nodeCmuxService" as never) as NodeCmuxService | undefined;

  if (!nodeCmuxService) {
    return c.json({ ok: false, error: "cmux 服务不可用", code: "unavailable" }, 500);
  }

  const result = await nodeCmuxService.openOrFocusNodeSurface(rigId, logicalId);
  if (!result.ok && result.code === "not_found") {
    return c.json(result, 404);
  }
  return c.json(result);
});

// POST /api/rigs/:rigId/nodes/:logicalId/focus
nodesRoutes.post("/:logicalId/focus", async (c) => {
  const rigId = c.req.param("rigId")!;
  const logicalId = c.req.param("logicalId")!;
  const { rigRepo, cmuxAdapter } = getDeps(c);

  const rig = rigRepo.getRig(rigId);
  if (!rig) return c.json({ error: "未找到工作组" }, 404);

  const node = rig.nodes.find((n) => n.logicalId === logicalId);
  if (!node) return c.json({ error: "未找到节点" }, 404);

  const cmuxSurface = node.binding?.cmuxSurface;
  if (!cmuxSurface) {
    return c.json({ error: "节点无 cmux surface 绑定" }, 409);
  }

  const result = await cmuxAdapter.focusSurface(cmuxSurface);
  return c.json(result);
});

// DELETE /api/rigs/:rigId/nodes/:logicalId
nodesRoutes.delete("/:logicalId", async (c) => {
  const rigId = c.req.param("rigId")!;
  const nodeRef = decodeURIComponent(c.req.param("logicalId")!);
  const fallbackDestination = c.req.query("fallback");
  const { rigLifecycleService } = getDeps(c);
  if (!rigLifecycleService) {
    return c.json({ error: "生命周期服务不可用" }, 500);
  }

  const result = await rigLifecycleService.removeNode(rigId, nodeRef, { fallbackDestination });
  if (!result.ok) {
    const status = result.code === "rig_not_found" ? 404
      : result.code === "node_not_found" ? 404
      : result.code === "active_qitems" ? 409
      : result.code === "fallback_not_running" ? 409
      : result.code === "fallback_in_target" ? 409
      : result.code === "kill_failed" ? 409
      : 500;
    return c.json(result, status);
  }

  return c.json(result, 200);
});

// GET /api/sessions/:sessionName/preview?lines=N
//
// 终端预览 v0（PL-018）：以会话为键的 /preview 别名。供仅持有 sessionName、
// 没有 (rigId, logicalId) 组合的界面使用（引导循环状态面板、切片故事视图拓扑页签）。
// 其他行为与以工作组和节点为键的路由完全一致。
sessionAdminRoutes.get("/:sessionName/preview", terminalAuthGuard(), async (c) => {
  const sessionName = decodeURIComponent(c.req.param("sessionName")!);
  const sessionTransport = c.get("sessionTransport" as never) as SessionTransport | undefined;
  const rateLimiter = c.get("previewRateLimiter" as never) as PreviewRateLimiter<{
    content: string;
    lines: number;
    sessionName: string;
    capturedAt: string;
  }> | undefined;
  if (!sessionTransport) {
    return c.json({ error: "preview_unavailable", hint: "本后台服务未配置 SessionTransport。" }, 503);
  }

  const linesRaw = c.req.query("lines");
  const linesParsed = linesRaw ? parseInt(linesRaw, 10) : NaN;
  const lines = Number.isFinite(linesParsed) && linesParsed > 0
    ? Math.min(linesParsed, 1000)
    : 50;

  const cacheKey = `${sessionName}:${lines}`;
  const cached = rateLimiter?.get(cacheKey);
  if (cached) return c.json(cached.payload);

  const result = await sessionTransport.capture(sessionName, { lines });
  if (!result.ok) {
    return c.json({
      error: result.reason ?? "capture_failed",
      hint: result.error,
      sessionName,
    }, 502);
  }
  const payload = {
    content: result.content ?? "",
    lines: result.lines ?? lines,
    sessionName,
    capturedAt: new Date().toISOString(),
  };
  rateLimiter?.set(cacheKey, payload);
  return c.json(payload);
});

// POST /api/sessions/:sessionName/reconcile——OPR.0.3.4.3 不启动的协调操作。
// 通过 reconcile_session converge 操作（拓扑主干上的语法糖），将手动续接且仍存活的
// 规范会话重新接纳到其持久化节点中。绝不会启动/终止会话、重放启动流程或向目标窗格写入输入。
sessionAdminRoutes.post("/:sessionName/reconcile", terminalAuthGuard(), async (c) => {
  const sessionName = decodeURIComponent(c.req.param("sessionName")!);
  const claimService = c.get("claimService" as never) as ClaimService | undefined;
  const podInstantiator = c.get("podInstantiator" as never) as PodRigInstantiator | undefined;
  if (!claimService || !podInstantiator) {
    return c.json({ error: "Reconcile 不可用：本后台服务未配置 claim 服务。" }, 503);
  }

  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const rigId = typeof body["rigId"] === "string" ? body["rigId"] : undefined;
  const logicalId = typeof body["logicalId"] === "string" ? body["logicalId"] : undefined;
  if ((rigId && !logicalId) || (!rigId && logicalId)) {
    return c.json({ error: "rigId 和 logicalId 必须同时提供（或同时省略）。" }, 400);
  }

  const converged = await convergeOp(
    { instantiator: podInstantiator, claimService },
    rigId ?? "",
    { kind: "reconcile_session", sessionName, rigId, logicalId },
    ".",
  );
  if (converged.kind !== "reconcile_session" || !converged.supported) {
    return c.json({ error: "reconcile_session 返回了意外的 converge 结果" }, 500);
  }
  const outcome = converged.outcome;

  if (!outcome.ok) {
    switch (outcome.code) {
      case "session_not_found":
      case "node_not_found":
      case "rig_not_found":
        return c.json(outcome, 404);
      case "node_mismatch":
        return c.json(outcome, 409);
      default:
        return c.json(outcome, 500);
    }
  }

  return c.json(outcome, 200);
});

// POST /api/sessions/:sessionName/clear-attention — OPR.0.3.4.10.
sessionAdminRoutes.post("/:sessionName/clear-attention", terminalAuthGuard(), async (c) => {
  const sessionName = decodeURIComponent(c.req.param("sessionName")!);
  const reconciler = c.get("seatAttentionReconciler" as never) as import("../domain/seat-attention-reconciler.js").SeatAttentionReconciler | undefined;
  if (!reconciler) {
    return c.json({ error: "本后台服务未配置席位 attention reconciler。" }, 503);
  }
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const reason = typeof body["reason"] === "string" ? body["reason"].trim() : undefined;
  const result = await reconciler.clearAttention(sessionName, reason ? { reason } : undefined);
  if (!result.ok) {
    return c.json(result, result.code === "not_in_attention" ? 409 : 422);
  }
  return c.json(result, 200);
});

// POST /api/sessions/:sessionName/resume-token — OPR.0.4.0.22.
// 受管、经证明且可审计地设置席位的持久续接令牌（主机升级的风险控制守卫，
// 用以替代手工编辑 SQLite 的反模式）。该凭据写入受 terminalAuthGuard() 保护。
// 原始令牌通过请求体传入（CLI 从 stdin 而非 argv 读取），绝不会被回显、写入错误消息、
// 记入日志或审计事件；它属于凭据级数据。
sessionAdminRoutes.post("/:sessionName/resume-token", terminalAuthGuard(), async (c) => {
  const sessionName = decodeURIComponent(c.req.param("sessionName")!);
  const { sessionRegistry } = getDeps(c);
  const eventBus = c.get("eventBus" as never) as EventBus | undefined;

  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const reason = typeof body["reason"] === "string" ? body["reason"].trim() : "";
  if (!reason) {
    return c.json({ error: "missing_reason", message: "set-resume-token 需要 --reason（操作员证明）。" }, 400);
  }

  const ctx = sessionRegistry.findResumeContextByName(sessionName);
  if (!ctx) {
    return c.json({ error: "session_not_found", message: `未找到会话 '${sessionName}'。` }, 404);
  }

  // FR-2：按运行时校验并拒绝畸形值。错误信息经过脱敏，绝不包含令牌值。
  const validation = validateResumeToken(ctx.runtime, body["token"]);
  if (!validation.ok) {
    return c.json({ error: "invalid_token", message: validation.error }, 422);
  }

  // FR-1：operator/attested 来源优先级高于 hook/scrape。
  sessionRegistry.updateResumeToken(ctx.sessionId, validation.resumeType, validation.token, "operator");

  // FR-5：仅追加审计事件，不包含原始令牌。
  if (eventBus) {
    eventBus.emit({
      type: "session.resume_token_set",
      rigId: ctx.rigId,
      nodeId: ctx.nodeId,
      sessionName,
      sessionId: ctx.sessionId,
      resumeType: validation.resumeType,
      previousProvenance: (ctx.currentProvenance as "hook" | "scrape" | "operator" | null) ?? null,
      newProvenance: "operator",
      source: "operator_set",
      reason,
      redacted: true,
    });
  }

  // 响应不携带令牌（FR-2 脱敏）。
  return c.json({
    ok: true,
    sessionName,
    resumeType: validation.resumeType,
    provenance: "operator",
    previousProvenance: ctx.currentProvenance ?? null,
    reason,
    redacted: true,
  }, 200);
});

// POST /api/sessions/:sessionRef/unclaim
sessionAdminRoutes.post("/:sessionRef/unclaim", terminalAuthGuard(), async (c) => {
  const sessionRef = decodeURIComponent(c.req.param("sessionRef")!);
  const { rigLifecycleService } = getDeps(c);
  if (!rigLifecycleService) {
    return c.json({ error: "生命周期服务不可用" }, 500);
  }

  const result = await rigLifecycleService.unclaimSession(sessionRef);
  if (!result.ok) {
    const status = result.code === "session_ambiguous" ? 409 : 404;
    return c.json(result, status);
  }

  return c.json(result, 200);
});

// GET /api/sessions/:sessionName/generation-record?sinceBytes=N
// 机制守卫修复（桌面裁定 d9b3989a）：`rig walk` 的按效果消耗来源。
// 提供席位当前代次的仅追加对话记录身份，以及从 sinceBytes 开始的后缀。Claude 使用其
// 上下文伴随文件；Codex 将当前绑定窗格/进程关联到其原生线程，再关联到现有上下文存储
// 的线程表，绝不使用窗格快照或按会话记录新旧程度搜索。席位没有可解析记录时明确拒绝：
// 此时无法校验，绝不能返回空的成功结果。
// 第二轮（r2 HIGH-2）：原始对话字节不做会话记录脱敏，属于终端级界面；它与相邻接口
// 共用 bearer 守卫（401/401/200；空令牌的回环请求可以通过）。
sessionAdminRoutes.get("/:sessionName/generation-record", terminalAuthGuard(), async (c) => {
  const sessionName = decodeURIComponent(c.req.param("sessionName")!);
  const store = c.get("contextUsageStore" as never) as ContextUsageStore | undefined;
  if (!store) {
    return c.json({ error: "unsupported_runtime", message: "本后台服务无 context-usage store；无法解析该席位的 generation record。" }, 409);
  }
  const { sessionRegistry: registry, tmuxAdapter } = getDeps(c);
  const context = registry?.findResumeContextByName(sessionName);
  const occupant = context ? registry.currentOccupantTenure(context.nodeId) : null;
  const runtime = context?.runtime ?? "claude-code";
  let transcriptPath: string | null;
  let sessionId: string | null;
  if (runtime === "codex") {
    const binding = registry.getBindingForNode(context!.nodeId);
    const identity = new SeatIdentityStore(registry.db).getForNode(context!.nodeId);
    if (!occupant || !binding?.tmuxPane || binding.tmuxSession !== sessionName
      || identity?.verdict !== "verified" || identity.sessionName !== sessionName
      || identity.evidence.registeredPane !== binding.tmuxPane
      || !(Date.parse(identity.observedAt) >= Date.parse(occupant.bootAt))) {
      return c.json({ error: "record_identity_unverified", message: `'${sessionName}' 无已验证的当前占用者/pane 绑定。` }, 409);
    }
    try {
      const pid = await tmuxAdapter?.getPanePid?.(binding.tmuxPane);
      if (!pid || pid !== identity.evidence.observedPid) {
        return c.json({ error: "record_identity_unverified", message: `'${sessionName}' 的绑定 pane 不再匹配其已验证占用者。` }, 409);
      }
      const live = await resolveLiveCodexThreadId(binding.tmuxPane, {
        getPanePid: async () => pid,
        listProcesses: () => generationCensus.list(),
        readThreadIdByPid: (nativePid, startedAt) => startedAt
          ? generationThreadIds.resolve(nativePid, startedAt) : undefined,
      });
      if (!live.ok) return c.json({ error: "record_identity_unverified", message: live.reason }, 409);
      sessionId = live.id;
      transcriptPath = store.readCodexTranscriptPath(sessionId);
      if (registry.currentOccupantTenure(context!.nodeId)?.generationUuid !== occupant.generationUuid
        || registry.getBindingForNode(context!.nodeId)?.tmuxPane !== binding.tmuxPane
        || await tmuxAdapter.getPanePid?.(binding.tmuxPane) !== pid) {
        return c.json({ error: "record_identity_unverified", message: `解析 '${sessionName}' 期间占用者绑定发生了变化。` }, 409);
      }
    } catch (err) {
      return c.json({ error: "record_identity_unverified", message: `无法解析 '${sessionName}'：${(err as Error).message}` }, 409);
    }
  } else {
    const usage = store.readAndNormalize(sessionName);
    transcriptPath = usage.transcriptPath;
    sessionId = usage.sessionId;
  }
  if (!transcriptPath || !sessionId) {
    return c.json({ error: "unsupported_runtime", message: `'${sessionName}' (${runtime}) 无当前 generation record 可解析——无法校验该席位的消耗。` }, 409);
  }
  const fs = await import("node:fs");
  const sinceRaw = c.req.query("sinceBytes");
  const since = sinceRaw === undefined ? 0 : Number(sinceRaw);
  if (!Number.isSafeInteger(since) || since < 0 || sinceRaw === "") {
    return c.json({ error: "invalid_since_bytes", message: "sinceBytes 必须是非负 safe integer。" }, 400);
  }
  // 限制所提供后缀的大小：调用方会轮询，失控增长的记录不能变成失控增长的响应。
  const MAX_SUFFIX_BYTES = 8 * 1024 * 1024;
  try {
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new Error("record 不是普通文件");
      const totalBytes = stat.size;
      // 身份和字节来自同一个已打开文件。追加操作会保持该身份；即使原生 ID 未变，
      // 在相同路径替换 rollout 也会改变该身份。
      const generationId = JSON.stringify([occupant?.generationUuid ?? null, sessionId, transcriptPath, stat.dev, stat.ino, stat.birthtimeMs]);
      if (runtime === "codex") {
        let header = "";
        for (let offset = 0; offset < Math.min(totalBytes, MAX_SUFFIX_BYTES) && !header.includes("\n");) {
          const chunk = Buffer.alloc(Math.min(64 * 1024, totalBytes - offset, MAX_SUFFIX_BYTES - offset));
          const n = fs.readSync(fd, chunk, 0, chunk.length, offset);
          if (!n) break;
          header += chunk.subarray(0, n).toString("utf8");
          offset += n;
        }
        let meta;
        try { meta = JSON.parse(header.slice(0, header.indexOf("\n"))); } catch { /* explicit no-answer below */ }
        if (meta?.type !== "session_meta" || meta.payload?.id !== sessionId) {
          return c.json({ error: "record_identity_mismatch", message: `rollout 头部未标识当前线程 '${sessionId}'。` }, 409);
        }
      }
      if (sinceRaw === undefined) return c.json({ generationId, sessionId, runtime, totalBytes });
      if (since > totalBytes) return c.json({ error: "record_truncated", message: "generation record 缩小到了请求的字节边界以下。" }, 409);
      const length = Math.min(totalBytes - since, MAX_SUFFIX_BYTES);
      const buf = Buffer.alloc(length);
      const read = fs.readSync(fd, buf, 0, length, since);
      return c.json({ generationId, sessionId, runtime, totalBytes, suffix: buf.subarray(0, read).toString("utf8"), truncated: totalBytes - since > read });
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return c.json({ error: "record_unreadable", message: `'${sessionName}' 的 generation record 不可读：${(err as Error).message}` }, 409);
  }
});
