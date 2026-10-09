import { inventoryCaptureOptions, type ShadowCapture } from "../domain/shadow-capture.js";
import { DeliveryGuardError } from "../domain/seat-delivery-guard.js";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { EventBus } from "../domain/event-bus.js";
import { summarizeSnapshot, type SnapshotRepository } from "../domain/snapshot-repository.js";
import type { SnapshotCapture } from "../domain/snapshot-capture.js";
import type { RestoreOrchestrator } from "../domain/restore-orchestrator.js";
import { projectRigToGraph, type InventoryOverlay, type CurrentQitemSummary } from "../domain/graph-projection.js";
import {
  getNodeInventory,
  getNodeInventoryForRigs,
  getNodeInventoryWithContext,
  attachAgentActivity,
  attachTerminalActivityAndWork,
} from "../domain/node-inventory.js";
import { projectionLane } from "../domain/projection-lane.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { AgentActivityStore } from "../domain/agent-activity-store.js";
import type { SeatActivityService } from "../domain/seat-activity-service.js";
import type { SeatStructuralActivityService } from "../domain/seat-structural-activity-service.js";
import { deriveRigLifecycleState } from "../domain/ps-projection.js";
import { assessCurrentStateRehydrateEligibility, snapshotMatchesCurrentOccupants } from "../domain/rehydrate-eligibility.js";
import { buildRestorePlanPreview, collectPreviewSessionRows } from "../domain/restore-plan-preview.js";
import { readFreshOccupantRelations } from "../domain/fresh-occupant-relation.js";
import { composeRigStatus, type SeatLifecycleInput } from "../domain/rig-status-compose.js";
import { createRestoreCheckService } from "./restore-check.js";
import type { KernelBootTracker, KernelState } from "../domain/kernel-boot-tracker.js";
import type { RecoveryPlan } from "../domain/restore-check-service.js";
import type { ContextUsageStore } from "../domain/context-usage-store.js";
import type { TranscriptStore } from "../domain/transcript-store.js";
import type { Pod, ExpansionPodFragment } from "../domain/types.js";
import type { RigExpansionService } from "../domain/rig-expansion-service.js";
import type { PodRigInstantiator } from "../domain/rigspec-instantiator.js";
import { convergeOp } from "../domain/topology-converge.js";
import type { RigLifecycleService } from "../domain/rig-lifecycle-service.js";
import type { SelfAttachService } from "../domain/self-attach-service.js";

export const rigsRoutes = new Hono();

// PL-019 第 5 项：读取侧联结辅助函数。返回 destination_session → in-progress
// qitem 的映射（每个节点最多 MAX_QITEMS_PER_NODE 条），并以
// canonicalSessionName 为键，便于路由将结果拼入 InventoryOverlay。正文会截断，
// 以便第 5 项的 UI 使用方在手机端的工具提示和抽屉中展示。
const MAX_QITEMS_PER_NODE = 3;
const BODY_EXCERPT_MAX_CHARS = 80;

export function loadCurrentQitemsForSessions(
  db: Database.Database,
  sessionNames: string[]
): Map<string, CurrentQitemSummary[]> {
  const out = new Map<string, CurrentQitemSummary[]>();
  if (sessionNames.length === 0) return out;
  const placeholders = sessionNames.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT qitem_id, destination_session, body, tier
       FROM queue_items
       WHERE state = 'in-progress' AND destination_session IN (${placeholders})
       ORDER BY ts_updated DESC`
  ).all(...sessionNames) as Array<{ qitem_id: string; destination_session: string; body: string; tier: string | null }>;
  for (const row of rows) {
    const list = out.get(row.destination_session) ?? [];
    if (list.length < MAX_QITEMS_PER_NODE) {
      list.push({
        qitemId: row.qitem_id,
        bodyExcerpt: row.body.length > BODY_EXCERPT_MAX_CHARS
          ? `${row.body.slice(0, BODY_EXCERPT_MAX_CHARS)}…`
          : row.body,
        tier: row.tier,
      });
    }
    out.set(row.destination_session, list);
  }
  return out;
}

function normalizeExpansionPodFragment(raw: Record<string, unknown>): ExpansionPodFragment | null {
  if (!raw || typeof raw !== "object") return null;
  const id = raw["id"];
  const label = raw["label"];
  const members = raw["members"];
  if (typeof id !== "string" || !Array.isArray(members)) return null;

  return {
    id,
    label: typeof label === "string" ? label : id,
    summary: typeof raw["summary"] === "string" ? raw["summary"] : undefined,
    members: members.map((member) => {
      const m = (member ?? {}) as Record<string, unknown>;
      // OPR.0.5.6.3 存在性不变量：跟踪键是否存在，而非值的形态。只要出现了
      // sessionSource/session_source（包括 null、原始值、仅有 mode、ref:null、
      // 未知 mode 或畸形 ref 字段），就必须交给唯一的规范校验器；只有真正不存在的键
      // 才保持缺省（沿用 permission_policy R2 的先例，并应用到 session_source）。
      const hasSessionSource = "sessionSource" in m || "session_source" in m;
      const rawSessionSource: unknown = "sessionSource" in m ? m["sessionSource"] : m["session_source"];
      let sessionSource: import("../domain/types.js").SessionSourceSpec | undefined;
      if (rawSessionSource !== undefined && rawSessionSource !== null && typeof rawSessionSource === "object") {
        const ss = rawSessionSource as Record<string, unknown>;
        const mode = ss["mode"];
        const ref = ss["ref"];
        if (ref !== null && typeof ref === "object") {
          const refRec = ref as Record<string, unknown>;
          const kind = refRec["kind"];
          if (mode === "fork" && (kind === "native_id" || kind === "artifact_path" || kind === "name" || kind === "last")) {
            const value = typeof refRec["value"] === "string" ? (refRec["value"] as string) : undefined;
            sessionSource = { mode: "fork", ref: { kind, ...(value !== undefined ? { value } : {}) } };
          } else if (mode === "rebuild" && kind === "artifact_set" && Array.isArray(refRec["value"])) {
            const paths: string[] = [];
            for (const p of refRec["value"] as unknown[]) {
              if (typeof p === "string" && p.trim() !== "") paths.push(p);
            }
            if (paths.length > 0) {
              sessionSource = { mode: "rebuild", ref: { kind: "artifact_set", value: paths } };
            }
          } else if (mode === "agent_image") {
            // OPR.0.5.6.3 修复：agent_image 与 fork/rebuild 一样通过该入口。
            // 合法的 v0 形态（kind 为 image_name、value 为非空字符串、version 为
            // string|number）会按 SCHEMA-PARITY 规则用 String() 转换并构造类型值，
            // 与 rigspec-schema.ts 的 normalize 完全一致（YAML 中的 `version: 3`
            // 会以 JSON 数字进入；若忽略它，就会重现静默采用默认值的缺陷）。
            const versionRaw = refRec["version"];
            const validValue = kind === "image_name"
              && typeof refRec["value"] === "string" && refRec["value"].trim() !== "";
            const validVersion = versionRaw === undefined
              || typeof versionRaw === "string" || typeof versionRaw === "number";
            if (validValue && validVersion) {
              const version = versionRaw === undefined ? undefined : String(versionRaw);
              sessionSource = {
                mode: "agent_image",
                ref: { kind: "image_name", value: refRec["value"] as string, ...(version !== undefined ? { version } : {}) },
              };
            }
          }
        }
      }
      // 存在性兜底：若已有值无法规范化为合法的类型形态，就原样携带 RAW 值，
      // 让规范校验器按结构拒绝；绝不能把它转换为缺省。
      if (hasSessionSource && sessionSource === undefined) {
        sessionSource = rawSessionSource as import("../domain/types.js").SessionSourceSpec;
      }
      return {
        id: typeof m["id"] === "string" ? m["id"] : "",
        runtime: typeof m["runtime"] === "string" ? m["runtime"] : "",
        agentRef:
          typeof m["agentRef"] === "string"
            ? m["agentRef"]
            : typeof m["agent_ref"] === "string"
              ? m["agent_ref"]
              : undefined,
        profile: typeof m["profile"] === "string" ? m["profile"] : undefined,
        codexConfigProfile:
          typeof m["codexConfigProfile"] === "string"
            ? m["codexConfigProfile"]
            : typeof m["codex_config_profile"] === "string"
              ? m["codex_config_profile"]
              : undefined,
        cwd: typeof m["cwd"] === "string" ? m["cwd"] : undefined,
        model: typeof m["model"] === "string" ? m["model"] : undefined,
        // R2 (4ac243c3)：保留原始存在性。已存在但无效的值（null、number、
        // object 等）必须原样交给规范 RigSpec 校验器并由其拒绝；只有真正不存在的键
        // 才保持缺省。这里不做路由级校验，也不做类型转换。
        ...("permissionPolicy" in m
          ? { permissionPolicy: m["permissionPolicy"] }
          : "permission_policy" in m
            ? { permissionPolicy: m["permission_policy"] }
            : {}),
        restorePolicy:
          typeof m["restorePolicy"] === "string"
            ? m["restorePolicy"]
            : typeof m["restore_policy"] === "string"
              ? m["restore_policy"]
              : undefined,
        label: typeof m["label"] === "string" ? m["label"] : undefined,
        // 以存在性而非真值判断：null、false 或原始类型的原值必须保留到规范校验，
        // 不能因真值检查而消失。
        ...(hasSessionSource ? { sessionSource } : {}),
      };
    }),
    edges: Array.isArray(raw["edges"])
      ? raw["edges"].map((edge) => {
          const e = (edge ?? {}) as Record<string, unknown>;
          return {
            from: typeof e["from"] === "string" ? e["from"] : "",
            to: typeof e["to"] === "string" ? e["to"] : "",
            kind: typeof e["kind"] === "string" ? e["kind"] : "",
          };
        })
      : [],
  };
}

function getRepo(c: { get: (key: string) => unknown }): RigRepository {
  return c.get("rigRepo" as never) as RigRepository;
}

function getSessionRegistry(c: { get: (key: string) => unknown }): SessionRegistry {
  return c.get("sessionRegistry" as never) as SessionRegistry;
}

function getRigLifecycleService(c: { get: (key: string) => unknown }): RigLifecycleService | undefined {
  return c.get("rigLifecycleService" as never) as RigLifecycleService | undefined;
}

function getSelfAttachService(c: { get: (key: string) => unknown }): SelfAttachService | undefined {
  return c.get("selfAttachService" as never) as SelfAttachService | undefined;
}

// GET /api/rigs/summary — 必须在 /:id 之前注册，避免 Hono 将 "summary" 解析为工作组 ID。
rigsRoutes.get("/summary", (c) => {
  const repo = getRepo(c);
  // OPR.0.3.3.19——默认排除已归档项；通过 ?includeArchived=true / ?archived=only 显式启用。
  const includeArchived = c.req.query("includeArchived") === "true";
  const archivedOnly = c.req.query("archived") === "only";
  // slice-04：整个响应（摘要、限定范围的清单折叠、充实数据以及 c.json）会作为
  // 一个协作式通道任务运行，并与 /api/ps 共享通道。这样并发突发时，每个任务之间
  // 都会让出事件循环，使 /healthz 保持可响应。进入通道前只解析查询标志。
  //   - 清单折叠范围仅限本次请求返回的工作组（默认仅活跃项；归档变体会传入其
  //     已归档工作组 ID），因此逐节点折叠绝不会扩展到被排除的工作组；全舰队只需
  //     一次启动扫描和一次恢复扫描。
  //   - 每次请求都读取实时数据；没有缓存或陈旧数据（getRigSummaries 与折叠均读实时 DB）。
  return projectionLane.run(() => {
    const summaries = repo.getRigSummaries({ includeArchived, archivedOnly });
    const invByRig = getNodeInventoryForRigs(repo.db, new Set(summaries.map((s) => s.id)));
    const enriched = summaries.map((s) => {
      const inventory = invByRig.get(s.id) ?? [];
      const lifecycleState = deriveRigLifecycleState(inventory.map((e) => e.lifecycleState));
      const agents = inventory.filter((e) => e.nodeKind === "agent");
      // 存活性与生命周期/注意项相互独立，并复用同一次清单折叠。
      const hasLiveAgents = agents.some((e) => e.sessionStatus === "running" || e.sessionStatus === "idle")
        ? true : agents.every((e) => e.sessionStatus === null || e.sessionStatus === "stopped" || e.sessionStatus === "exited") ? false : null;
      return { ...s, lifecycleState, hasLiveAgents };
    });
    return c.json(enriched);
  });
});

// OPR.0.4.3.22 — GET /api/rigs/:id/status — 组合后的工作组状态对象。
// 它通过纯折叠（composeRigStatus）组合四个已交付信号：ps-lifecycle、
// restore-plan（只读预测）、restore-check 就绪状态，以及 kernel-status
//（仅 kernel 工作组）。状态绝不根据窗格文本或后台服务 /healthz 推断；`src[]`
// 携带组合后的来源信息（即禁止推断契约）。折叠保留逐席位事实，工作组绝不会
// 整体切换为 fresh（锁定规则）。
rigsRoutes.get("/:id/status", (c) => {
  const repo = getRepo(c);
  const rig = repo.getRig(c.req.param("id"));
  if (!rig) return c.json({ error: `未找到工作组 "${c.req.param("id")}"` }, 404);

  const snapshotRepo = c.get("snapshotRepo" as never) as SnapshotRepository;
  const snapshot = snapshotRepo.findLatestRestoreUsable(rig.rig.id) ?? null;
  // 逐席位只读预测（mutated:false），即 restore-plan 信号。
  const plan = buildRestorePlanPreview(rig, snapshot, collectPreviewSessionRows(repo.db, rig, snapshot), undefined, Date.now(), readFreshOccupantRelations(repo.db, rig.rig.id));

  // ps-lifecycle：逐节点 lifecycleState（绝不来自窗格文本）。
  const nodes: SeatLifecycleInput[] = getNodeInventory(repo.db, rig.rig.id).map((e) => ({
    logicalId: e.logicalId,
    runtime: e.runtime,
    lifecycleState: e.lifecycleState,
  }));

  // restore-check 就绪状态，即 RecoveryPlan 状态。防御性处理：探测抛错时不提供该信号，
  // 折叠仍读取 plan 与 lifecycle，而不是返回 500。
  let recovery: RecoveryPlan | null = null;
  try {
    recovery = createRestoreCheckService(repo, snapshotRepo)
      .check({ rig: rig.rig.name, noQueue: true, noHooks: true })
      .recovery;
  } catch {
    recovery = null;
  }

  // kernel-status：仅为 kernel 工作组折叠，来源是启动跟踪器。
  // 绝不根据后台服务 /healthz 推断（守卫 4）。
  const isKernel = rig.rig.name === "kernel";
  let kernelState: KernelState | null = null;
  if (isKernel) {
    const tracker = c.get("kernelBootTracker" as never) as KernelBootTracker | undefined;
    kernelState = tracker ? tracker.getStatus().kernelState : null;
  }

  return c.json(
    composeRigStatus({ rigId: rig.rig.id, rigName: rig.rig.name, isKernel, nodes, plan, recovery, kernelState }),
  );
});

// OPR.0.4.3.22 — POST /api/rigs/:id/launch-plan — 逐席位只读计划。
// 启动/恢复弹窗会在任何变更之前获取该计划。此路由绝不会恢复、创建/终止/替换/
// 续接会话，也不会写投影或捕获快照；它只做预测
//（buildRestorePlanPreview，mutated:false）。可选的 freshLogicalIds 会针对显式
// fresh 选择预测 fresh-primed 计划（锁定规则：fresh 始终只是逐席位列表，绝非全局切换）。
rigsRoutes.post("/:id/launch-plan", async (c) => {
  const repo = getRepo(c);
  const rig = repo.getRig(c.req.param("id"));
  if (!rig) return c.json({ error: `未找到工作组 "${c.req.param("id")}"` }, 404);

  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const freshLogicalIds = Array.isArray(body["freshLogicalIds"])
    ? (body["freshLogicalIds"] as unknown[]).filter((v): v is string => typeof v === "string")
    : undefined;

  const snapshotRepo = c.get("snapshotRepo" as never) as SnapshotRepository;
  const snapshot = snapshotRepo.findLatestRestoreUsable(rig.rig.id) ?? null;
  return c.json(
    buildRestorePlanPreview(rig, snapshot, collectPreviewSessionRows(repo.db, rig, snapshot), freshLogicalIds, Date.now(), readFreshOccupantRelations(repo.db, rig.rig.id)),
    200,
  );
});

rigsRoutes.post("/", async (c) => {
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const name = body["name"];
  if (!name || typeof name !== "string") {
    return c.json({ error: "name 为必填项" }, 400);
  }
  const rig = getRepo(c).createRig(name);
  return c.json(rig, 201);
});

rigsRoutes.get("/", (c) => {
  // OPR.0.3.3.19——默认排除已归档项；通过 ?includeArchived=true / ?archived=only 显式启用。
  const includeArchived = c.req.query("includeArchived") === "true";
  const archivedOnly = c.req.query("archived") === "only";
  const rigs = getRepo(c).listRigs({ includeArchived, archivedOnly });
  return c.json(rigs);
});

rigsRoutes.get("/:id", (c) => {
  const rig = getRepo(c).getRig(c.req.param("id"));
  if (!rig) {
    return c.json({ error: "未找到工作组" }, 404);
  }
  return c.json(rig);
});

rigsRoutes.get("/:id/graph", async (c) => {
  const rig = getRepo(c).getRig(c.req.param("id"));
  if (!rig) {
    return c.json({ error: "未找到工作组" }, 404);
  }
  const rigId = c.req.param("id");
  const sessions = getSessionRegistry(c).getSessionsForRig(rigId);
  // 叠加清单数据，以填充图中的扩展字段。
  const ctxStore = c.get("contextUsageStore" as never) as ContextUsageStore | undefined;
  const transcriptStore = c.get("transcriptStore" as never) as TranscriptStore | undefined;
  const inventory = ctxStore
    ? getNodeInventoryWithContext(getRepo(c).db, rigId, ctxStore, transcriptStore)
    : getNodeInventory(getRepo(c).db, rigId);

  // PL-019 第 4 项：生成图载荷时，用 agentActivity 充实清单，使 UI 使用方一次请求
  // 就能获得活动数据，无须仅为拓扑圆点着色再往返请求 /api/rigs/:id/nodes。
  const tmuxAdapter = c.get("tmuxAdapter" as never) as TmuxAdapter | undefined;
  const agentActivityStore = c.get("agentActivityStore" as never) as AgentActivityStore | undefined;
  // OPR.0.4.3 healthz 阻塞放大修复：默认采用低成本路径（不逐节点捕获 tmux）。
  // 30 秒一次的拓扑轮询根据快照（running/idle）和 hook 活动为圆点着色；
  // ?full=true 才会启用逐节点 needs_input 捕获。
  const graphFull = c.req.query("full") === "true";
  const seatStructuralActivityService = c.get("seatStructuralActivityService" as never) as SeatStructuralActivityService | undefined;
  // ACTIVITY D1+D2：现在先于 attachAgentActivity 解析，因为 ACTIVITY 判定阶梯读取的
  // 动态观测与 TERMINAL 列相同；顺序只影响此处声明。
  //
  // 共享该观测不会破坏 slice-15 中 `terminalActive` 与 `hasAssignedWork` 之间的
  // 禁止推断契约；ACTIVITY 仍不读取队列或分配状态。两个界面出现差异是合法的：
  // ACTIVITY 会在读取时按原始时间戳重新计算时效，而 TERMINAL 投影轮询时的布尔值。
  // 此差异是防止陈旧缓存的保护，而非不一致，原因详见 sessions 路由。
  const seatActivityService = c.get("seatActivityService" as never) as SeatActivityService | undefined;
  const inventoryWithActivityOnly = tmuxAdapter
    ? await attachAgentActivity(inventory, { ...inventoryCaptureOptions(getRepo(c).db, c.get("shadowCapture" as never) as ShadowCapture | undefined), tmuxAdapter, activityStore: agentActivityStore, structuralActivity: seatStructuralActivityService, seatActivity: seatActivityService, captureFallback: graphFull })
    : inventory;
  const inventoryWithActivity = attachTerminalActivityAndWork(inventoryWithActivityOnly, {
    db: getRepo(c).db,
    seatActivity: seatActivityService,
  });

  // PL-019 第 5 项：通过读取侧联结补充 active qitem。现有索引
  // idx_queue_items_destination_state 使该操作成本很低。辅助函数会导出，
  // 因而无须启动完整路由栈即可做单元测试。
  const currentQitemsBySession = loadCurrentQitemsForSessions(
    getRepo(c).db,
    inventoryWithActivity
      .map((n) => n.canonicalSessionName)
      .filter((s): s is string => Boolean(s))
  );

  const pods = getRepo(c).db
    .prepare("SELECT id, rig_id, namespace, label, summary, continuity_policy_json, created_at FROM pods WHERE rig_id = ? ORDER BY created_at")
    .all(rigId) as Array<{ id: string; rig_id: string; namespace: string; label: string; summary: string | null; continuity_policy_json: string | null; created_at: string }>;
  const overlay: InventoryOverlay[] = inventoryWithActivity.map((n) => ({
    logicalId: n.logicalId,
    startupStatus: n.startupStatus,
    canonicalSessionName: n.canonicalSessionName,
    restoreOutcome: n.restoreOutcome,
    oriented: n.oriented,
    contextUsedPercentage: n.contextUsage?.usedPercentage ?? null,
    contextFresh: n.contextUsage?.fresh ?? false,
    contextAvailability: n.contextUsage?.availability ?? "unknown",
    contextTotalInputTokens: n.contextUsage?.totalInputTokens ?? null,
    contextTotalOutputTokens: n.contextUsage?.totalOutputTokens ?? null,
    agentActivity: n.agentActivity ?? null,
    currentQitems: n.canonicalSessionName
      ? currentQitemsBySession.get(n.canonicalSessionName) ?? []
      : [],
    terminalActive: n.terminalActive,
    hasAssignedWork: n.hasAssignedWork ?? false,
    assignedWorkCount: n.assignedWorkCount ?? 0,
    pendingWorkCount: n.pendingWorkCount ?? 0,
    inProgressWorkCount: n.inProgressWorkCount ?? 0,
    blockedWorkCount: n.blockedWorkCount ?? 0,
    identityVerdict: n.identityVerdict ?? null,
  }));
  const projectedPods: Pod[] = pods.map((pod) => ({
    id: pod.id,
    rigId: pod.rig_id,
    namespace: pod.namespace,
    label: pod.label,
    summary: pod.summary,
    continuityPolicyJson: pod.continuity_policy_json,
    createdAt: pod.created_at,
  }));
  return c.json(projectRigToGraph({ ...rig, sessions, pods: projectedPods }, overlay));
});

rigsRoutes.delete("/:id", async (c) => {
  const rigId = c.req.param("id");
  const repo = getRepo(c);
  const eventBus = c.get("eventBus" as never) as EventBus;

  // 仅在工作组存在时发送事件并删除。
  const rig = repo.getRig(rigId);
  if (!rig) {
    return c.body(null, 204);
  }

  // 原子操作：在同一事务中持久化事件并删除工作组。
  // 使用 eventBus.db（与 rigRepo.db 是同一句柄，由共享 AppDeps 保证）。
  const txn = eventBus.db.transaction(() => {
    const persisted = eventBus.persistWithinTransaction({
      type: "rig.deleted",
      rigId,
    });
    repo.deleteRig(rigId);
    return persisted;
  });

  try {
    const remove = async () => {
      const persistedEvent = txn();
      eventBus.notifySubscribers(persistedEvent);
      return c.body(null, 204);
    };
    const guard = (c.get("tmuxAdapter" as never) as TmuxAdapter | undefined)?.deliveryGuard;
    return guard ? await guard.lifecycle(rig.nodes.map(node => node.id), remove) : await remove();
  } catch (err) {
    if (err instanceof DeliveryGuardError) throw err;
    return c.json({ error: "删除失败" }, 500);
  }
});

// OPR.0.3.3.19 - POST /api/rigs/:id/archive——软归档且可逆（不是删除）。
// 保留工作组行、拓扑行和快照，只设置 `archived_at`。
rigsRoutes.post("/:id/archive", async (c) => {
  const rigId = c.req.param("id");
  const repo = getRepo(c);
  const eventBus = c.get("eventBus" as never) as EventBus;
  const rig = repo.getRig(rigId);
  if (!rig) {
    return c.json({ error: "未找到工作组" }, 404);
  }
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const force = body["force"] === true;

  // AC-6 运行中工作组守卫（位于后台服务层，因此所有客户端都会继承）：
  // running/degraded 工作组需要 --force，否则返回包含三部分事实的明确错误。
  const inventory = getNodeInventory(repo.db, rigId);
  const lifecycleState = deriveRigLifecycleState(inventory.map((e) => e.lifecycleState));
  if ((lifecycleState === "running" || lifecycleState === "degraded") && !force) {
    return c.json({
      error: {
        fact: `工作组 '${rig.rig.name}' 处于 ${lifecycleState}（有存活会话）。`,
        consequence: "归档会把有运行中席位的工作组从默认视图隐藏。",
        action: `先停掉它（'zrig down ${rigId}'），或带 --force 重跑以强制归档。`,
      },
    }, 409);
  }

  const result = eventBus.db.transaction(() => {
    const changed = repo.archiveRig(rigId);
    const persisted = changed
      ? eventBus.persistWithinTransaction({ type: "rig.archived", rigId })
      : null;
    return { changed, persisted };
  })();

  try {
    if (result.persisted) eventBus.notifySubscribers(result.persisted);
    return c.json({ ok: true, rigId, archived: result.changed });
  } catch {
    return c.json({ error: "归档失败" }, 500);
  }
});

// OPR.0.3.3.19 - POST /api/rigs/:id/unarchive——撤销归档标志。
rigsRoutes.post("/:id/unarchive", (c) => {
  const rigId = c.req.param("id");
  const repo = getRepo(c);
  const eventBus = c.get("eventBus" as never) as EventBus;
  const rig = repo.getRig(rigId);
  if (!rig) {
    return c.json({ error: "未找到工作组" }, 404);
  }
  const result = eventBus.db.transaction(() => {
    const changed = repo.unarchiveRig(rigId);
    const persisted = changed
      ? eventBus.persistWithinTransaction({ type: "rig.unarchived", rigId })
      : null;
    return { changed, persisted };
  })();
  if (result.persisted) eventBus.notifySubscribers(result.persisted);
  return c.json({ ok: true, rigId, unarchived: result.changed });
});

// POST /api/rigs/:id/release——无损释放已认领的会话。
rigsRoutes.post("/:id/release", async (c) => {
  const rigId = c.req.param("id")!;
  const rigLifecycleService = getRigLifecycleService(c);
  if (!rigLifecycleService) {
    return c.json({ error: "工作组生命周期服务不可用" }, 500);
  }

  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const result = await rigLifecycleService.releaseRig(rigId, {
    delete: body["delete"] === true,
  });

  if (result.ok) {
    return c.json(result, result.status === "partial" ? 207 : 200);
  }

  switch (result.code) {
    case "rig_not_found":
      return c.json(result, 404);
    case "contains_launched_nodes":
      return c.json(result, 409);
    default:
      return c.json(result, 500);
  }
});

// POST /api/rigs/:id/attach-self——挂接当前 shell/智能体，支持 tmux 和外部进程。
rigsRoutes.post("/:id/attach-self", async (c) => {
  const rigId = c.req.param("id")!;
  const selfAttachService = getSelfAttachService(c);
  if (!selfAttachService) {
    return c.json({ error: "自 attach 服务不可用" }, 500);
  }

  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const logicalId = typeof body["logicalId"] === "string" ? body["logicalId"].trim() : "";
  const podNamespace = typeof body["podNamespace"] === "string" ? body["podNamespace"].trim() : "";
  const memberName = typeof body["memberName"] === "string" ? body["memberName"].trim() : "";
  const runtime = typeof body["runtime"] === "string" ? body["runtime"].trim() : "";
  const cwd = typeof body["cwd"] === "string" ? body["cwd"] : undefined;
  const displayName = typeof body["displayName"] === "string" ? body["displayName"] : undefined;
  const attachmentType = typeof body["attachmentType"] === "string" ? body["attachmentType"].trim() : "";
  const tmuxSession = typeof body["tmuxSession"] === "string" ? body["tmuxSession"].trim() : "";
  const tmuxWindow = typeof body["tmuxWindow"] === "string" ? body["tmuxWindow"].trim() : "";
  const tmuxPane = typeof body["tmuxPane"] === "string" ? body["tmuxPane"].trim() : "";

  const hasNodeTarget = logicalId.length > 0;
  const hasPodFields = podNamespace.length > 0 || memberName.length > 0 || runtime.length > 0;

  if (hasNodeTarget && hasPodFields) {
    return c.json({ error: "请指定 logicalId，或指定 podNamespace + memberName + runtime" }, 400);
  }
  if (!hasNodeTarget && !hasPodFields) {
    return c.json({ error: "请指定 logicalId，或指定 podNamespace + memberName + runtime" }, 400);
  }
  if (!hasNodeTarget && (!podNamespace || !memberName)) {
    return c.json({ error: "attach 进 pod 时 podNamespace 和 memberName 为必填项" }, 400);
  }
  if (attachmentType && attachmentType !== "tmux" && attachmentType !== "external_cli") {
    return c.json({ error: "attachmentType 必须是 'tmux' 或 'external_cli'" }, 400);
  }
  if (attachmentType === "tmux" && !tmuxSession) {
    return c.json({ error: "attachmentType 为 'tmux' 时 tmuxSession 为必填项" }, 400);
  }

  const context = attachmentType === "tmux" || tmuxSession
    ? {
        attachmentType: "tmux" as const,
        tmuxSession,
        tmuxWindow: tmuxWindow || undefined,
        tmuxPane: tmuxPane || undefined,
      }
    : undefined;

  const result = hasNodeTarget
    ? await selfAttachService.attachToNode({ rigId, logicalId, runtime: runtime || undefined, cwd, displayName, context })
    : await selfAttachService.attachToPod({ rigId, podNamespace, memberName, runtime, cwd, displayName, context });

  if (result.ok) {
    return c.json(result, 201);
  }

  switch (result.code) {
    case "rig_not_found":
    case "node_not_found":
    case "pod_not_found":
      return c.json(result, 404);
    case "runtime_required":
      return c.json(result, 400);
    case "already_bound":
    case "duplicate_logical_id":
    case "invalid_member_name":
    case "runtime_mismatch":
      return c.json(result, 409);
    default:
      return c.json(result, 500);
  }
});

// POST /api/rigs/:id/up——从最新的可恢复快照启动现有工作组。
// L3b：存在 `auto-pre-down` 时优先使用，否则回退到结构元数据通过预校验的
// 最新手动快照。响应会回显 `snapshotKind`，让操作人员知道实际使用了哪个快照。
rigsRoutes.post("/:id/up", async (c) => {
  const rigId = c.req.param("id")!;
  const repo = getRepo(c);
  const rig = repo.getRig(rigId);
  if (!rig) return c.json({ error: `未找到工作组 "${rigId}"。用 zrig ps 列出工作组` }, 404);

  // OPR.0.3.4.4：此独立的 Explorer 恢复路由过去完全不解析请求体，导致
  // plan:true 被静默忽略，路由总会执行变更。
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const plan = body["plan"] === true;
  // OPR.0.3.4.1：传递 freshLogicalIds，使基于 ID 的路由支持
  // awaiting-decision 状态下的 fresh-prime 重试（操作 B）。
  const freshLogicalIds = Array.isArray(body["freshLogicalIds"])
    ? (body["freshLogicalIds"] as unknown[]).filter((v): v is string => typeof v === "string")
    : undefined;

  const snapshotRepo = c.get("snapshotRepo" as never) as SnapshotRepository;
  const snapshotCapture = c.get("snapshotCapture" as never) as SnapshotCapture;
  const automaticSelection = snapshotRepo.selectRestoreUsable(rigId);
  let snapshot = automaticSelection.ok ? automaticSelection.snapshot : null;
  let snapshotSelection = automaticSelection.ok ? automaticSelection.selection : undefined;
  let staleSnapshot = false;
  if (snapshot && !snapshotMatchesCurrentOccupants(repo.db, rig, snapshot)) {
    snapshot = null;
    snapshotSelection = undefined;
    staleSnapshot = true;
  }
  let capturedCurrentState = false;
  if (!snapshot) {
    const eligibility = assessCurrentStateRehydrateEligibility(repo.db, rig);
    if (!eligibility.ok) {
      return c.json({
        error: `工作组 "${rig.rig.name}" 存在，但 ${staleSnapshot ? "其恢复快照命名的是更早的占用者" : "没有可用恢复快照"}，且当前 DB 状态不足以 rehydrate。用 zrig up <spec-path> 全新启动`,
        code: "no_snapshot",
        blockers: eligibility.blockers,
      }, 404);
    }
  }

  // OPR.0.3.4.4：只读计划守卫必须位于 auto-rehydrate 捕获之前
  //（捕获本身会产生变更），也必须位于 restoreOrch.restore() 之前。
  if (plan) {
    return c.json(buildRestorePlanPreview(rig, snapshot ?? null, collectPreviewSessionRows(repo.db, rig, snapshot ?? null), undefined, Date.now(), readFreshOccupantRelations(repo.db, rig.rig.id)), 200);
  }

  if (!snapshot) {
    snapshot = snapshotCapture.captureSnapshot(rigId, "auto-rehydrate");
    snapshotSelection = {
      ...summarizeSnapshot(snapshot),
      mode: "automatic",
      rationale: "因无可用当前占用者快照，自动 rehydrate 捕获了当前合格状态",
      newerUsableAlternative: null,
    };
    capturedCurrentState = true;
  }

  const restoreOrch = c.get("restoreOrchestrator" as never) as RestoreOrchestrator | undefined;
  if (!restoreOrch) {
    return c.json({ error: "恢复编排器不可用" }, 500);
  }

  const adapters = c.get("runtimeAdapters" as never) as Record<string, import("../domain/runtime-adapter.js").RuntimeAdapter> | undefined;
  const fs = await import("node:fs");
  const result = await restoreOrch.restore(snapshot.id, {
    adapters: adapters ?? {},
    fsOps: { exists: (p: string) => fs.existsSync(p) },
    freshLogicalIds,
    snapshotSelection,
  });
  if (!result.ok) {
    if (result.code === "pre_restore_validation_failed") {
      return c.json({
        status: "not_attempted",
        rigId,
        rigName: rig.rig.name,
        error: result.message,
        code: result.code,
        snapshotKind: snapshot.kind,
        ...result.result,
        remediation: result.result.blockers?.map((blocker) => blocker.remediation) ?? [],
      }, 409);
    }
    return c.json({ error: result.message, code: result.code }, result.code === "rig_not_stopped" ? 409 : 400);
  }

  // 根据第一个 running/resumed 节点计算挂接命令（与 /api/up 逻辑相同）。
  const { getNodeInventory } = await import("../domain/node-inventory.js");
  const inventory = getNodeInventory(repo.db, rigId);
  const firstRunning = inventory.find((n) => n.canonicalSessionName && n.sessionStatus === "running");
  const attachCommand = firstRunning?.tmuxAttachCommand ?? inventory.find((n) => n.canonicalSessionName)?.tmuxAttachCommand ?? null;

  return c.json({
    status: "restored",
    rigId,
    rigName: rig.rig.name,
    snapshotId: snapshot.id,
    snapshotKind: snapshot.kind,
    rigResult: result.result.rigResult,
    nodes: result.result.nodes,
    warnings: capturedCurrentState
      ? [staleSnapshot
          ? "既有恢复快照命名的是更早占用者；已捕获当前 DB 状态作为 auto-rehydrate 快照用于重启恢复。"
          : "无可用恢复快照；已捕获当前 DB 状态作为 auto-rehydrate 快照用于重启恢复。", ...result.result.warnings]
      : result.result.warnings,
    attachCommand,
  }, 200);
});

// POST /api/rigs/:rigId/expand——动态扩容工作组。
rigsRoutes.post("/:rigId/expand", async (c) => {
  const rigId = c.req.param("rigId")!;
  const expansionService = c.get("rigExpansionService" as never) as RigExpansionService | undefined;
  if (!expansionService) {
    return c.json({ error: "扩容服务不可用" }, 500);
  }

  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const pod = normalizeExpansionPodFragment((body["pod"] ?? {}) as Record<string, unknown>);
  if (!pod) {
    return c.json({ error: "pod 为必填项，需带 id 和 members[]" }, 400);
  }

  const crossPodEdges = Array.isArray(body["crossPodEdges"]) ? body["crossPodEdges"] as Array<{ from: string; to: string; kind: string }> : undefined;
  const rigRoot = typeof body["rigRoot"] === "string" ? body["rigRoot"] : undefined;

  const result = await expansionService.expand({ rigId, pod, crossPodEdges, rigRoot });

  if (!result.ok) {
    switch (result.code) {
      case "rig_not_found":
      case "target_rig_not_found":
        return c.json(result, 404);
      case "materialize_conflict":
        return c.json(result, 409);
      case "validation_failed":
      case "preflight_failed":
        return c.json(result, 400);
      default:
        return c.json(result, 500);
    }
  }

  const httpStatus = result.status === "ok" ? 201 : 207;
  return c.json(result, httpStatus);
});

// POST /api/rigs/:rigId/pods/:podNamespace/members——向现有 Pod 添加单个成员
//（OPR.0.3.3.24，即 add_member converge 操作）。这是 converge 接口的命令式语法糖，
// 不涉及身份迁移。member 片段使用规格中的 snake_case 字段名
//（id、runtime、agent_ref、profile、cwd 等）。
rigsRoutes.post("/:rigId/pods/:podNamespace/members", async (c) => {
  const rigId = c.req.param("rigId")!;
  const podNamespace = decodeURIComponent(c.req.param("podNamespace")!);
  const podInstantiator = c.get("podInstantiator" as never) as PodRigInstantiator | undefined;
  if (!podInstantiator) {
    return c.json({ error: "Pod 实例化器不可用" }, 500);
  }

  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const member = body["member"];
  if (!member || typeof member !== "object" || Array.isArray(member)) {
    return c.json({ error: "member 为必填项（带 id、runtime、agent_ref 的 member 片段）" }, 400);
  }
  const rigRoot = typeof body["rigRoot"] === "string" ? body["rigRoot"] : ".";
  // 可选的 Pod 内部边（from/to 是 Pod 中的成员 ID）。这些边会传递给 converge 操作，
  // 避免丢弃已声明的拓扑意图；领域层会校验 kind、解析端点并将其持久化
  //（目前还没有边的运行时行为）。若 edges 字段已存在但不是数组，则明确拒绝，
  // 绝不静默视为缺省（治理规则 FM2：不得静默丢弃）。
  const rawEdges = body["edges"];
  if (rawEdges !== undefined && rawEdges !== null && !Array.isArray(rawEdges)) {
    return c.json({ ok: false, code: "validation_failed", errors: ["edges：必须是 { from, to, kind } 数组"] }, 400);
  }
  const edges = Array.isArray(rawEdges)
    ? (rawEdges as Array<{ from: string; to: string; kind: string }>)
    : undefined;

  const converged = await convergeOp(
    { instantiator: podInstantiator },
    rigId,
    { kind: "add_member", pod: podNamespace, member: member as Record<string, unknown>, edges },
    rigRoot,
  );
  // 此路由是 converge 接口上 add_member 操作的语法糖。
  if (converged.kind !== "add_member" || !converged.supported) {
    return c.json({ error: "add_member 返回了意外的 converge 结果" }, 500);
  }
  const outcome = converged.outcome;

  if (!outcome.ok) {
    switch (outcome.code) {
      case "rig_not_found":
      case "pod_not_found":
        return c.json(outcome, 404);
      case "member_conflict":
        return c.json(outcome, 409);
      case "edge_unresolved":
      case "validation_failed":
      case "preflight_failed":
        return c.json(outcome, 400);
      default:
        return c.json(outcome, 500);
    }
  }

  // 返回 201 created。节点在启动时仍可能处于 failed/attention_required；
  // 该状态由 outcome.result.node.status 携带（与 expand 的逐节点状态一致）。
  return c.json(outcome, 201);
});

// DELETE /api/rigs/:rigId/pods/:podRef
rigsRoutes.delete("/:rigId/pods/:podRef", async (c) => {
  const rigId = c.req.param("rigId")!;
  const podRef = decodeURIComponent(c.req.param("podRef")!);
  const fallbackDestination = c.req.query("fallback");
  const lifecycleService = c.get("rigLifecycleService" as never) as RigLifecycleService | undefined;
  if (!lifecycleService) {
    return c.json({ error: "生命周期服务不可用" }, 500);
  }

  const result = await lifecycleService.shrinkPod(rigId, podRef, { fallbackDestination });
  if (!result.ok) {
    const status = result.code === "rig_not_found" ? 404
      : result.code === "pod_not_found" ? 404
      : result.code === "active_qitems" ? 409
      : result.code === "fallback_not_running" ? 409
      : result.code === "fallback_in_target" ? 409
      : result.code === "kill_failed" ? 409
      : 500;
    return c.json(result, status);
  }

  return c.json(result, result.status === "ok" ? 200 : 207);
});
