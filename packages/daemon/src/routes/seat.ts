import { OutboxHandler } from "../domain/outbox-handler.js";
import { Hono } from "hono";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { DiscoveryRepository } from "../domain/discovery-repository.js";
import type { EventBus } from "../domain/event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { SeatStatusService } from "../domain/seat-status-service.js";
import { SeatHandoverService } from "../domain/seat-handover-service.js";
import { SeatSwitchClientService } from "../domain/seat-switch-client-service.js";
import { SeatLifecycleService, type SeatRefusal } from "../domain/seat-lifecycle-service.js";
import { makePredecessorRecapResolver } from "../domain/predecessor-recap-resolver.js";
import type { ContextUsageStore } from "../domain/context-usage-store.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveAuthoredRecapPointer } from "../domain/context-packs/seat-recap-store.js";
import { buildRebuildPrimingChain } from "../domain/rebuild-priming-chain.js";
import { OPENRIG_HOME } from "../openrig-compat.js";
import { SettingsStore } from "../domain/user-settings/settings-store.js";

export const seatRoutes = new Hono();

// S09 是独立的投递偏好，绝不是生命周期或权限变更。
seatRoutes.post("/set-typing-guard/:seatRef", async c => {
  const guard = (c.get("tmuxAdapter" as never) as TmuxAdapter).deliveryGuard;
  if (!guard) return c.json({ error: "投递 guard 不可用" }, 503);
  const body = await c.req.json<Record<string, unknown>>();
  if (typeof body.enabled !== "boolean" || typeof body.reason !== "string" || !body.reason.trim()) {
    return c.json({ error: "需要 enabled（布尔）和 reason" }, 400);
  }
  const actor = c.req.header("x-openrig-session")?.trim();
  if (!actor) return c.json({ error: "偏好审计需要发送方身份" }, 400);
  try {
    const target = guard.target(decodeURIComponent(c.req.param("seatRef")));
    const preference = await guard.set(target.nodeId, body.enabled, actor, body.reason);
    return c.json({ ...preference, tradeoff: "启用期间自动终端输入会暂停，即使在空提示符处也是如此。禁用不会重放已保留的消息。" }, preference.pending ? 202 : 200);
  } catch (error) { return c.json({ error: (error as Error).message }, 409); }
});

seatRoutes.get("/held-messages/:seatRef", c => {
  const guard = (c.get("tmuxAdapter" as never) as TmuxAdapter).deliveryGuard;
  if (!guard) return c.json({ error: "投递 guard 不可用" }, 503);
  try {
    const target = guard.target(decodeURIComponent(c.req.param("seatRef")));
    const outbox = new OutboxHandler(guard.db);
    const id = c.req.query("id");
    if (id) {
      const entry = outbox.getById(id);
      if (entry?.guardBinding?.nodeId !== target.nodeId) return c.json({ error: "该 node 与 ID 没有保留的历史" }, 404);
      return c.json({ entry });
    }
    return c.json(outbox.heldForNode(target.nodeId, Number(c.req.query("limit") ?? 100), Number(c.req.query("offset") ?? 0)));
  } catch (error) { return c.json({ error: (error as Error).message }, 400); }
});

seatRoutes.post("/retire-held-message/:seatRef/:id", async c => {
  const guard = (c.get("tmuxAdapter" as never) as TmuxAdapter).deliveryGuard;
  if (!guard) return c.json({ error: "投递 guard 不可用" }, 503);
  const body = await c.req.json<Record<string, unknown>>();
  const actor = c.req.header("x-openrig-session")?.trim();
  if (!actor || typeof body.reason !== "string" || !body.reason.trim()) return c.json({ error: "需要发送方身份和 reason" }, 400);
  try {
    const target = guard.target(decodeURIComponent(c.req.param("seatRef")));
    const outbox = new OutboxHandler(guard.db); const id = c.req.param("id");
    if (outbox.getById(id)?.guardBinding?.nodeId !== target.nodeId) return c.json({ error: "该 node 与 ID 没有暂存的消息" }, 404);
    return c.json({ entry: outbox.retire(id, actor, body.reason), effect: "已从活跃配额退役；证据已保留。不代表已投递、被原生消费或工作已关闭。" });
  } catch (error) { return c.json({ error: (error as Error).message }, 409); }
});

seatRoutes.get("/status/:seatRef", (c) => {
  const rigRepo = c.get("rigRepo" as never) as RigRepository;
  const service = new SeatStatusService({ rigRepo });
  const result = service.getStatus(decodeURIComponent(c.req.param("seatRef")!));

  if (result.ok) {
    const guard = (c.get("tmuxAdapter" as never) as TmuxAdapter | undefined)?.deliveryGuard;
    const target = guard?.maybeTarget(decodeURIComponent(c.req.param("seatRef")!));
    return c.json({ ...result.status, ...(guard && target ? { typingGuard: {
      ...guard.preference(target.nodeId), heldCount: new OutboxHandler(guard.db).heldForNode(target.nodeId, 1).total,
    } } : {}) });
  }

  if (result.code === "seat_ambiguous") {
    return c.json(result, 409);
  }
  if (result.code === "seat_ref_required") {
    return c.json(result, 400);
  }
  return c.json(result, 404);
});

seatRoutes.post("/handover/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const rigRepo = c.get("rigRepo" as never) as RigRepository;
  const service = new SeatHandoverService({
    db: rigRepo.db,
    rigRepo,
    sessionRegistry: c.get("sessionRegistry" as never) as SessionRegistry,
    discoveryRepo: c.get("discoveryRepo" as never) as DiscoveryRepository,
    eventBus: c.get("eventBus" as never) as EventBus,
    tmuxAdapter: c.get("tmuxAdapter" as never) as TmuxAdapter,
    sessionEnv: (c.get("sessionEnv" as never) as Record<string, string | undefined> | undefined) ?? undefined,
    // B1——通过 runtime adapters 把全新继任者 launch 到存活的智能体中。
    runtimeAdapters: (c.get("runtimeAdapters" as never) as Record<string, import("../domain/runtime-adapter.js").RuntimeAdapter> | undefined) ?? undefined,
    // OPR.0.4.6.02 S1——共享的 tmux option 默认值 applier，使 FRESH
    // handover 继任者获得与已 launch 席位相同的 mouse/status/clipboard 默认值
    // （orch C1 scope 裁定）。
    tmuxOptionDefaults: (c.get("tmuxOptionDefaults" as never) as import("../domain/tmux-option-defaults.js").TmuxOptionDefaultsApplier | undefined) ?? undefined,
    // B2——discovered 模式 resume-token 捕获 derive-helper 依赖。
    contextUsageStore: (c.get("contextUsageStore" as never) as import("../domain/resume-token-capture.js").ResumeTokenCaptureDeps["contextUsageStore"]) ?? undefined,
    resumeTokenCapturer: (c.get("resumeMetadataRefresher" as never) as import("../domain/resume-token-capture.js").ResumeTokenCaptureDeps["resumeTokenCapturer"]) ?? undefined,
    // 接入 predecessor-recap resolver，使继任者 boot packet 带着有界的 from-record recap 触发。
    // 复用 context 中的完整 ContextUsageStore（readAndNormalize = claude transcript_path；
    // readCodexAndNormalize = codex rollout_path）+ 对 codex thread id 的 resume-token 查找；
    // parseJsonlExchanges 是 resolver 的默认。store 缺失 → resolver 省略（recap 段落诚实省略）。
    // 触发已在 money-proof e2e 中实况验证。
    predecessorRecapResolver: (() => {
      const store = c.get("contextUsageStore" as never) as ContextUsageStore | undefined;
      if (!store) return undefined;
      const db = rigRepo.db;
      return makePredecessorRecapResolver({
        // B16——session_id 随 read 携带，使 resolver 能校验 name-keyed sidecar 是
        // 前任的（canonical-name 复用意味着被 boot 的继任者会覆盖它）。
        readClaudeRecord: (sessionName) => {
          const usage = store.readAndNormalize(sessionName);
          return { transcriptPath: usage.transcriptPath, sessionId: usage.sessionId ?? null };
        },
        readCodexTranscriptPath: (args) => store.readCodexAndNormalize(args).transcriptPath,
        lookupResumeToken: (nodeId, sessionName) => {
          const row = db
            .prepare("SELECT resume_token FROM sessions WHERE node_id = ? AND session_name = ? ORDER BY id DESC LIMIT 1")
            .get(nodeId, sessionName) as { resume_token: string | null } | undefined;
          return row?.resume_token ?? null;
        },
      });
    })(),
    // OPR.0.5.3.5 mini-req 7——继任者 packet 的 AUTHORED recap 指针：
    // seat 目录来自 topology.root CONFIG（slice-06 D1 布局）；每个结果都具名——
    // 存在则带 chain 深度，缺失则带尝试过的路径（seat-id/目录映射缺口在 door drive 处
    // 响亮暴露，而非静默）。
    authoredRecapResolver: (seatRef: string) => {
      const topologyRoot = String(new SettingsStore().resolveOne("topology.root").value);
      return resolveAuthoredRecapPointer(seatRef, topologyRoot);
    },
    // OPR.0.5.5.5（fix B3）——唯一的生产 rebuild priming chain builder
    //（rebuild-priming-chain.ts）：RECAP.md、LEARNED.md、最新 restore packet
    // （当席位的 restore-pending marker 指定了一个时），被取代的 recap 按新到旧。
    // 只声明；service 做存在性过滤（具名缺口）。
    rebuildPrimingResolver: (seatRef: string) => buildRebuildPrimingChain(seatRef, {
      topologyRoot: String(new SettingsStore().resolveOne("topology.root").value),
      openrigHome: OPENRIG_HOME,
    }),
    // OPR.0.4.6.PI1 FR-6——runtime-adapter map 中的 Pi adapter 暴露
    // pi-runner sidecar reader；结构性复用它（不新增 context 变量）。
    piRunnerStateStore: (() => {
      const adapters = c.get("runtimeAdapters" as never) as Record<string, unknown> | undefined;
      const pi = adapters?.["pi"] as { readSessionFile?: (sessionName: string) => { ok: true; sessionFile: string } | { ok: false; reason: string } } | undefined;
      return typeof pi?.readSessionFile === "function"
        ? { readSessionFile: pi.readSessionFile.bind(pi) as (sessionName: string) => { ok: true; sessionFile: string } | { ok: false; reason: string } }
        : undefined;
    })(),
    // GHOST-STAGE（e/Class-B）——规范 OccupantInvalidator，使 commit() 的 re-key 调用触发
    // （在继任者积累任何数据之前，使退役占用者的 seat-name-keyed stores 失效）。
    occupantInvalidator: (c.get("occupantInvalidator" as never) as import("../domain/occupant-invalidator.js").OccupantInvalidator | undefined) ?? undefined,
    // WAVE-O B1（R2 508e383d）——后台服务唯一的 SeatActivityService 搭乘每次
    // 生产 handover 构造，使真实已提交的 swap 到达 declareOccupantSwap，
    // 继任者绝不继承退役者的证据或已提升的 rung 权限。在 deps 契约中可选；此处始终接入。
    activityOracle: (c.get("seatActivityService" as never) as import("../domain/seat-activity-service.js").SeatActivityService | undefined) ?? undefined,
  });
  const result = await service.handover({
    seatRef: decodeURIComponent(c.req.param("seatRef")!),
    reason: typeof body["reason"] === "string" ? body["reason"] : null,
    source: typeof body["source"] === "string" ? body["source"] : null,
    operator: typeof body["operator"] === "string" ? body["operator"] : null,
    dryRun: body["dryRun"] === true,
  });

  if (result.ok) {
    return c.json("plan" in result ? result.plan : result.result);
  }

  if (result.code === "missing_reason" || result.code === "invalid_source") {
    return c.json(result, 400);
  }
  if (result.code === "seat_ambiguous") {
    return c.json(result, 409);
  }
  if (result.code === "successor_creation_not_implemented" ||
    result.code === "source_not_supported") {
    return c.json(result, 501);
  }
  if (result.code === "tmux_probe_failed") {
    return c.json(result, 502);
  }
  if (result.code === "current_occupant_required" ||
    result.code === "discovered_not_active" ||
    result.code === "successor_tmux_absent" ||
    result.code === "successor_already_managed" ||
    result.code === "successor_is_current" ||
    result.code === "runtime_mismatch") {
    return c.json(result, 409);
  }
  if (result.code === "seat_ref_required") {
    return c.json(result, 400);
  }
  if (result.code === "handover_commit_failed" ||
    result.code === "successor_create_failed" ||
    result.code === "context_delivery_failed") {
    return c.json(result, 500);
  }
  return c.json(result, 404);
});

// S5（OPR.0.5.4.7）——seat-lifecycle 动词表面：set-model / stop / clean。
// 一个 service、一条解析路径、一张三动词共用的状态映射。
export function seatLifecycleService(c: { get(key: never): unknown }): SeatLifecycleService {
  const rigRepo = c.get("rigRepo" as never) as RigRepository;
  return new SeatLifecycleService({
    db: rigRepo.db,
    rigRepo,
    sessionRegistry: c.get("sessionRegistry" as never) as SessionRegistry,
    eventBus: c.get("eventBus" as never) as EventBus,
    tmuxAdapter: c.get("tmuxAdapter" as never) as TmuxAdapter,
    nodeLauncher: c.get("nodeLauncher" as never) as import("../domain/node-launcher.js").NodeLauncher,
    startupOrchestrator: (c.get("startupOrchestrator" as never) as import("../domain/startup-orchestrator.js").StartupOrchestrator | undefined) ?? undefined,
    runtimeAdapters: (c.get("runtimeAdapters" as never) as Record<string, import("../domain/runtime-adapter.js").RuntimeAdapter> | undefined) ?? undefined,
    occupantInvalidator: (c.get("occupantInvalidator" as never) as import("../domain/occupant-invalidator.js").OccupantInvalidator | undefined) ?? undefined,
    activityOracle: (c.get("seatActivityService" as never) as import("../domain/seat-activity-service.js").SeatActivityService | undefined) ?? undefined,
  });
}

function seatLifecycleStatus(code: SeatRefusal["code"]): 400 | 404 | 409 | 500 | 502 {
  if (code === "seat_ref_required" || code === "missing_model" || code === "missing_reason" || code === "fresh_required") return 400;
  if (code === "seat_not_found") return 404;
  if (code === "tmux_probe_failed") return 502;
  if (code === "launch_unavailable" || code === "runtime_adapter_missing" || code === "launch_failed" || code === "startup_failed") return 500;
  // seat_ambiguous / session_live / session_not_live / no_session / claimed_session /
  // nothing_to_clean——状态冲突，不是客户端语法错误。
  return 409;
}

seatRoutes.post("/set-permissions/:seatRef", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const actor = c.req.header("x-openrig-session")?.trim();
  if (!actor || !body || Array.isArray(body) || typeof body.mode !== "string" || typeof body.reason !== "string") {
    return c.json({ error: "需要发送方身份、mode 和 reason" }, 400);
  }
  const result = await seatLifecycleService(c).setPermissions({
    seatRef: decodeURIComponent(c.req.param("seatRef")), mode: body.mode, reason: body.reason, actor,
  });
  return c.json(result, result.ok ? 200 : seatLifecycleStatus(result.code));
});

seatRoutes.post("/set-model/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const result = await seatLifecycleService(c).setModel({
    seatRef: decodeURIComponent(c.req.param("seatRef")!),
    model: typeof body["model"] === "string" ? body["model"] : "",
    reason: typeof body["reason"] === "string" ? body["reason"] : "",
    operator: typeof body["operator"] === "string" ? body["operator"] : null,
  });
  if (result.ok) return c.json(result);
  return c.json(result, seatLifecycleStatus(result.code));
});

seatRoutes.post("/launch/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const result = await seatLifecycleService(c).launchFresh({
    seatRef: decodeURIComponent(c.req.param("seatRef")!),
    fresh: body["fresh"] === true,
    reason: typeof body["reason"] === "string" ? body["reason"] : "",
    stop: body["stop"] === true,
    operator: typeof body["operator"] === "string" ? body["operator"] : null,
  });
  if (result.ok) return c.json(result);
  return c.json(result, seatLifecycleStatus(result.code));
});

seatRoutes.post("/stop/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const result = await seatLifecycleService(c).stopSeat({
    seatRef: decodeURIComponent(c.req.param("seatRef")!),
    reason: typeof body["reason"] === "string" ? body["reason"] : "",
    operator: typeof body["operator"] === "string" ? body["operator"] : null,
  });
  if (result.ok) return c.json(result);
  return c.json(result, seatLifecycleStatus(result.code));
});

seatRoutes.post("/clean/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const result = await seatLifecycleService(c).cleanSeat({
    seatRef: decodeURIComponent(c.req.param("seatRef")!),
    reason: typeof body["reason"] === "string" ? body["reason"] : "",
    operator: typeof body["operator"] === "string" ? body["operator"] : null,
  });
  if (result.ok) return c.json(result);
  return c.json(result, seatLifecycleStatus(result.code));
});

// OPR.0.4.3.26——seat-recovery VIEW 重定向。把已 attach 的 tmux client 指向
// 席位的 canonical session/window。仅 VIEW：只读解析席位（SeatStatusService），
// 且仅经 tmux adapter（已在 context 中）probe/switch。它不构造
// SeatHandoverService / SessionRegistry 写 / ClaimService，也绝不经 converge/reconcile 路由——
// 此处不可能发生路由、绑定、session、transcript 或身份变更。
seatRoutes.post("/switch-client/:seatRef", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const rigRepo = c.get("rigRepo" as never) as RigRepository;
  const service = new SeatSwitchClientService({
    rigRepo,
    tmuxAdapter: c.get("tmuxAdapter" as never) as TmuxAdapter,
  });

  const rawWindow = body["toWindow"];
  const toWindow = typeof rawWindow === "number" && Number.isInteger(rawWindow) ? rawWindow : null;

  const result = await service.switchClient({
    seatRef: decodeURIComponent(c.req.param("seatRef")!),
    client: typeof body["client"] === "string" && body["client"] !== "" ? body["client"] : null,
    toWindow,
  });

  if (result.ok) {
    return c.json(result.result);
  }

  if (result.code === "seat_ref_required") {
    return c.json(result, 400);
  }
  if (result.code === "seat_not_found" ||
    result.code === "client_not_found" ||
    result.code === "window_not_found") {
    return c.json(result, 404);
  }
  if (result.code === "seat_ambiguous" ||
    result.code === "missing_canonical_session" ||
    result.code === "session_not_found" ||
    result.code === "no_client" ||
    result.code === "ambiguous_client") {
    return c.json(result, 409);
  }
  // switch_failed / tmux_probe_failed——tmux 层失败，不是客户端错误。
  return c.json(result, 502);
});
