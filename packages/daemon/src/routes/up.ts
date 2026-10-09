import nodePath from "node:path";
import { Hono } from "hono";
import type { BootstrapOrchestrator } from "../domain/bootstrap-orchestrator.js";
import type { BootstrapRepository } from "../domain/bootstrap-repository.js";
import type { EventBus } from "../domain/event-bus.js";
import type { UpCommandRouter } from "../domain/up-command-router.js";
import type { RigRepository } from "../domain/rig-repository.js";
import { summarizeSnapshot, type SnapshotRepository } from "../domain/snapshot-repository.js";
import type { SnapshotCapture } from "../domain/snapshot-capture.js";
import type { RestoreOrchestrator } from "../domain/restore-orchestrator.js";
import { assessCurrentStateRehydrateEligibility, snapshotMatchesCurrentOccupants } from "../domain/rehydrate-eligibility.js";
import { buildRestorePlanPreview, collectPreviewSessionRows } from "../domain/restore-plan-preview.js";
import { readFreshOccupantRelations } from "../domain/fresh-occupant-relation.js";
import { loadTopologyManifest } from "../domain/topology/topology-manifest.js";
import { MultiRigLauncher } from "../domain/topology/multi-rig-launcher.js";
import { remoteUpLeaf } from "../domain/topology/remote-up-leaf.js";
import { loadHostRegistry } from "../domain/hosts/hosts-registry-reader.js";
import type { HttpHostEntry } from "../domain/hosts/hosts-registry-reader.js";

export const upRoutes = new Hono();

/**
 * OPR.0.3.2.CT——当 bootstrap 结果携带 status='blocked' 且 detail.code ===
 * 'attention_required' 的 import_rig stage 时，组装三段式错误响应体
 * （事实 / 后果 / 行动）。结果不是该形状时返回 null
 * （调用方落到正常的部分成功路径）。
 *
 * 导出供窄单测固定 HG-4 形状，无需完整后台服务 harness。对结果形状纯函数。
 */
export function buildAttentionResponse(result: {
  rigId?: string;
  stages: Array<{ stage: string; status: string; detail?: unknown }>;
}): {
  error: { fact: string; consequence: string; action: string };
  attentionNodes: import("../domain/types.js").AttentionNode[];
} | null {
  const attentionStage = result.stages.find(
    (s) => s.stage === "import_rig"
      && s.status === "blocked"
      && (s.detail as { code?: string } | undefined)?.code === "attention_required",
  );
  if (!attentionStage) return null;
  const detail = attentionStage.detail as {
    code: string;
    message: string;
    attentionNodes: import("../domain/types.js").AttentionNode[];
  };
  const nodeCount = detail.attentionNodes.length;
  const sessionAttachHints = detail.attentionNodes
    .filter((n) => n.sessionName)
    .map((n) => `tmux attach -t ${n.sessionName}`)
  const visibleAttachHints = sessionAttachHints.slice(0, 3).join(" ; ");
  const remainingAttachHintCount = Math.max(0, sessionAttachHints.length - 3);
  const attachHintText = visibleAttachHints
    ? `${visibleAttachHints}${remainingAttachHintCount > 0 ? `；另有 ${remainingAttachHintCount} 个列在 attentionNodes 中` : ""}`
    : "见 `zrig ps`";
  const rigIdDisplay = result.rigId ?? "(rigId 不可用)";
  return {
    error: {
      fact: detail.message,
      consequence: `工作组 ${rigIdDisplay} 已创建，可通过 \`zrig ps\` 列出。标记为 attention_required 的成员尚未被证明可交互；运行时可能在等待输入，也可能已退出。`,
      action: nodeCount === 1
        ? `选择恢复方式前，先检查受影响的会话及其报告的原因：${attachHintText}。`
        : `选择恢复方式前，先检查 attentionNodes 中列出的每个受影响会话及其报告的原因：${attachHintText}。`,
    },
    attentionNodes: detail.attentionNodes,
  };
}

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    bootstrapOrchestrator: c.get("bootstrapOrchestrator" as never) as BootstrapOrchestrator,
    bootstrapRepo: c.get("bootstrapRepo" as never) as BootstrapRepository,
    eventBus: c.get("eventBus" as never) as EventBus,
    upRouter: c.get("upRouter" as never) as UpCommandRouter,
    rigRepo: c.get("rigRepo" as never) as RigRepository,
    snapshotRepo: c.get("snapshotRepo" as never) as SnapshotRepository,
    snapshotCapture: c.get("snapshotCapture" as never) as SnapshotCapture,
    restoreOrchestrator: c.get("restoreOrchestrator" as never) as RestoreOrchestrator | undefined,
    runtimeAdapters: c.get("runtimeAdapters" as never) as Record<string, import("../domain/runtime-adapter.js").RuntimeAdapter> | undefined,
  };
}

/**
 * 按 ID 从其最新可恢复快照恢复工作组。
 *
 * L3b：优先 `auto-pre-down`（既有行为作为偏好信号保留），
 * 但回退到结构元数据满足 `RestoreOrchestrator.restore` 预校验的最新手动快照。
 * 响应体回显 `snapshotKind`，使 operator/CLI 能呈现用了哪个快照。
 *
 * 由 /api/up（rig_name）和 /api/rigs/:rigId/up（Explorer）共用的 helper。
 */
async function restoreByRigId(rigId: string, rigName: string | null, deps: ReturnType<typeof getDeps>, c: { json: (data: unknown, status?: number) => Response }, freshLogicalIds?: string[], plan?: boolean) {
  const { snapshotRepo, restoreOrchestrator } = deps;

  const rig = deps.rigRepo.getRig(rigId);
  if (!rig) {
    return c.json({ error: `未找到工作组 ${rigId}`, code: "rig_not_found" }, 404);
  }

  const automaticSelection = snapshotRepo.selectRestoreUsable(rigId);
  let snapshot = automaticSelection.ok ? automaticSelection.snapshot : null;
  let snapshotSelection = automaticSelection.ok ? automaticSelection.selection : undefined;
  let staleSnapshot = false;
  if (snapshot && !snapshotMatchesCurrentOccupants(snapshotRepo.db, rig, snapshot)) {
    snapshot = null;
    snapshotSelection = undefined;
    staleSnapshot = true;
  }
  let capturedCurrentState = false;
  if (!snapshot) {
    const eligibility = assessCurrentStateRehydrateEligibility(snapshotRepo.db, rig);
    if (!eligibility.ok) {
      return c.json({
        error: `工作组存在，但 ${staleSnapshot ? "其恢复快照命名的是更旧的占用者" : "没有可恢复快照"}，且当前 DB 状态不足以 rehydrate。请全新启动：zrig up <spec-path>`,
        code: "no_snapshot",
        blockers: eligibility.blockers,
      }, 404);
    }
  }

  // OPR.0.3.4.4——只读 plan 门，在任何 restore 变更之前。
  // rig_name 路径此前早返回、越过了 bootstrap plan 门，
  // 因此 `zrig up --existing <rig> --plan` 会真正变更（outage-01 bypass）。
  // plan 模式绝不到达 restoreOrchestrator.restore()，auto-rehydrate
  // 快照捕获（本身是变更）被报告为 would-happen，绝不执行。
  if (plan) {
    return c.json(buildRestorePlanPreview(rig, snapshot ?? null, collectPreviewSessionRows(snapshotRepo.db, rig, snapshot ?? null), freshLogicalIds, Date.now(), readFreshOccupantRelations(snapshotRepo.db, rig.rig.id)), 200);
  }

  if (!snapshot) {
    snapshot = deps.snapshotCapture.captureSnapshot(rigId, "auto-rehydrate");
    snapshotSelection = {
      ...summarizeSnapshot(snapshot),
      mode: "automatic",
      rationale: "自动 rehydrate 捕获了当前合格状态，因为没有可用的当前占用者快照",
      newerUsableAlternative: null,
    };
    capturedCurrentState = true;
  }

  if (!restoreOrchestrator) {
    return c.json({ error: "restore orchestrator 不可用" }, 500);
  }

  const fs = await import("node:fs");
  const result = await restoreOrchestrator.restore(snapshot.id, {
    adapters: deps.runtimeAdapters ?? {},
    fsOps: { exists: (p: string) => fs.existsSync(p) },
    // OPR.0.3.4.2——来自 `zrig up --existing --fresh` 的 operation B opt-in 席位。
    freshLogicalIds,
    snapshotSelection,
  });
  if (!result.ok) {
    if (result.code === "pre_restore_validation_failed") {
      return c.json({
        status: "not_attempted",
        rigId,
        rigName,
        error: result.message,
        code: result.code,
        snapshotKind: snapshot.kind,
        ...result.result,
        remediation: result.result.blockers?.map((blocker) => blocker.remediation) ?? [],
      }, 409);
    }
    return c.json({ error: result.message, code: result.code }, result.code === "rig_not_stopped" ? 409 : 400);
  }

  // 从第一个 running node 计算 attach 命令（与 /api/rigs/:id/up 同逻辑）
  const { getNodeInventory } = await import("../domain/node-inventory.js");
  const inventory = getNodeInventory(deps.snapshotRepo.db, rigId);
  const firstRunning = inventory.find((n) => n.canonicalSessionName && n.sessionStatus === "running");
  const attachCommand = firstRunning?.tmuxAttachCommand ?? inventory.find((n) => n.canonicalSessionName)?.tmuxAttachCommand ?? null;

  return c.json({
    status: "restored",
    rigId,
    rigName,
    snapshotId: snapshot.id,
    snapshotKind: snapshot.kind,
    rigResult: result.result.rigResult,
    nodes: result.result.nodes,
    warnings: capturedCurrentState
      ? [staleSnapshot
          ? "既有恢复快照命名的是更旧占用者；已捕获当前 DB 状态作为 auto-rehydrate 快照供重启恢复。"
          : "不存在可恢复快照；已捕获当前 DB 状态作为 auto-rehydrate 快照供重启恢复。", ...result.result.warnings]
      : result.result.warnings,
    attachCommand,
  }, 200);
}

// POST /api/up——主路由
upRoutes.post("/", async (c) => {
  const { bootstrapOrchestrator, bootstrapRepo, eventBus, upRouter } = getDeps(c);
  const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
  const sourceRef = typeof body["sourceRef"] === "string" ? body["sourceRef"] : "";
  const plan = body["plan"] === true;
  const autoApprove = body["autoApprove"] === true;
  const cwdOverride = typeof body["cwdOverride"] === "string" ? body["cwdOverride"] : undefined;
  const targetRoot = typeof body["targetRoot"] === "string" ? body["targetRoot"] : undefined;

  if (!sourceRef) {
    return c.json({ error: "sourceRef 为必填项" }, 400);
  }

  // 路由 source——先对原始 sourceRef 分类，仅对文件类解析路径
  let sourceKind: string;
  let resolvedSourceRef = sourceRef;
  try {
    const route = upRouter.route(sourceRef);
    sourceKind = route.sourceKind;

    // rig 名：从最新 auto-pre-down 快照恢复
    if (sourceKind === "rig_name") {
      const { rigRepo } = getDeps(c);
      const rigs = rigRepo.findRigsByName(sourceRef);
      if (rigs.length === 0) {
        return c.json({ error: `未找到名为 "${sourceRef}" 的工作组。请提供 .yaml spec 路径以创建新工作组。`, code: "rig_not_found" }, 404);
      }
      if (rigs.length > 1) {
        const ids = rigs.map((r) => r.id).join(", ");
        return c.json({ error: `找到多个名为 "${sourceRef}" 的工作组（ID：${ids}）。请用具体工作组 ID：zrig restore --rig <rigId>。`, code: "ambiguous_name" }, 409);
      }
      const freshLogicalIds = Array.isArray(body["freshLogicalIds"])
        ? (body["freshLogicalIds"] as unknown[]).filter((v): v is string => typeof v === "string")
        : undefined;
      return restoreByRigId(rigs[0]!.id, sourceRef, getDeps(c), c, freshLogicalIds, plan) as any;
    }

    // 文件类：现在解析路径
    resolvedSourceRef = nodePath.resolve(sourceRef);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  // ── OPR.0.4.4.11——拓扑分支（FR-2..FR-5）──────────────────────────
  if (sourceKind === "topology") {
    // R11-2 后台服务侧（arch 裁定 4——在公共写路径上强制，使每个客户端继承）：
    // placement flag 与 topology source 组合会被拒绝；per-entry `host:`
    // 是 topology 唯一的 placement 机制。
    if (typeof body["host"] === "string" && (body["host"] as string).trim() !== "") {
      return c.json(
        {
          error:
            "topology source 不能带 host placement flag：manifest 中 per-entry 'host:' 是 topology 唯一的 placement 机制（两种 placement 机制不得共存）。在 entries 上写 'host: <id>' 以远程放置。",
          code: "host_flag_topology",
        },
        400,
      );
    }
    if (plan) {
      return c.json({ error: "v0 不支持 topology source 的 plan 模式——用 dry read 校验 manifest 或直接跑 up", code: "topology_plan_unsupported" }, 400);
    }

    const manifestRes = loadTopologyManifest(resolvedSourceRef);
    if (!manifestRes.ok) {
      return c.json({ error: manifestRes.errors.join("\n"), errors: manifestRes.errors, code: "invalid_topology_manifest" }, 400);
    }

    // 路径形式的 entry source 相对 manifest 所在目录解析——
    // manifest 是可移植制品（FR-1：同一文件、第二个环境、同一 topology）。
    // 裸名原样透传。
    const manifestDir = nodePath.dirname(resolvedSourceRef);
    const resolveEntrySource = (source: string): string =>
      source.includes("/") || /\.(ya?ml|rigbundle|rigtopology)$/i.test(source)
        ? nodePath.resolve(manifestDir, source)
        : source;

    const launcher = new MultiRigLauncher({
      // 与本路由单 rig up 使用的同一对公共锁（guard G-2）：launcher 参与路由侧锁集。
      // resolveLocalRef 使锁 key 与 launch ref 完全相同（guard F1）——
      // launchLocal 收到已解析的 ref。
      resolveLocalRef: resolveEntrySource,
      tryAcquire: (ref) => bootstrapOrchestrator.tryAcquire(ref),
      release: (ref) => bootstrapOrchestrator.release(ref),
      launchLocal: async (entryRef) => {
        let entryKind: string;
        try {
          entryKind = upRouter.route(entryRef).sourceKind;
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
        // 仅纵深防御：manifest validator 中 parse 时的 v0 source-form 边界
        // （仅 spec 路径）在 walk 开始前就拒绝这些；若未来调用方绕过校验，
        // 这些守卫保持 leaf 诚实。
        if (entryKind === "topology") {
          return { ok: false, error: `entry '${entryRef}' 本身是 topology——不支持嵌套 topology；entries 必须是单 rig spec 路径` };
        }
        if (entryKind === "rig_name") {
          return {
            ok: false,
            error: `entry '${entryRef}' 解析为既有工作组名；v0 topology entries 仅为 spec 路径——用 'zrig up ${entryRef}' 直接恢复既有工作组`,
          };
        }
        // 既有单 rig leaf：本路由调用的同一公共 bootstrap() 入口——
        // stages/locks/provenance 不动（FR-3）。
        const result = await bootstrapOrchestrator.bootstrap({
          mode: "apply",
          sourceRef: entryRef,
          sourceKind: entryKind as "rig_spec" | "rig_bundle",
          autoApprove,
        });
        if (result.status === "completed") {
          eventBus.emit({ type: "bootstrap.completed", runId: result.runId, rigId: result.rigId!, sourceRef: entryRef });
          return { ok: true };
        }
        eventBus.emit({ type: "bootstrap.failed", runId: result.runId, sourceRef: entryRef, error: result.errors[0] ?? result.status });
        return { ok: false, error: result.errors[0] ?? `bootstrap ${result.status}` };
      },
      // 已交付的远程单 rig leaf（POST {host}/api/up）。路径形式的 ref 在
      // 远程后台服务文件系统上解析——已交付的 remote-up 语义，不变。
      launchRemote: (source, host) => remoteUpLeaf({ sourceRef: source, autoApprove }, host as HttpHostEntry),
      loadRegistry: () => loadHostRegistry(),
    });

    const aggregate = await launcher.launch(manifestRes.manifest);
    // 两种情况都诚实聚合：仅当每个 entry 都 ok 时才 200（FR-5）。
    return c.json({ topology: sourceRef, ...aggregate }, aggregate.ok ? 200 : 500);
  }

  // bundle apply 需要 targetRoot
  if (sourceKind === "rig_bundle" && !plan && !targetRoot) {
    return c.json({ error: "bundle apply 模式需要 targetRoot" }, 400);
  }

  // 并发锁
  if (!bootstrapOrchestrator.tryAcquire(sourceRef)) {
    return c.json({ error: "该 source 已在进行中", code: "conflict" }, 409);
  }

  try {
    if (plan) {
      // plan 模式——无 run 生命周期
      const result = await bootstrapOrchestrator.bootstrap({
        mode: "plan",
        sourceRef: resolvedSourceRef,
        sourceKind,
        cwdOverride,
        targetRoot,
      });

      if (result.status === "planned") {
        eventBus.emit({ type: "bootstrap.planned", runId: result.runId, sourceRef, stages: result.stages.length });
        return c.json(result, 200);
      }
      // plan 失败
      eventBus.emit({ type: "bootstrap.failed", runId: result.runId, sourceRef, error: result.errors[0] ?? "plan 失败" });
      const failedStage = result.stages.find((s) => s.status === "failed" || s.status === "blocked");
      let httpStatus: 400 | 409 | 500 = 500;
      if (failedStage?.status === "blocked") httpStatus = 409;
      else if (failedStage?.stage === "resolve_spec") {
        const detail = failedStage.detail as { code?: string } | undefined;
        if (detail?.code === "file_not_found" || detail?.code === "parse_error" || detail?.code === "validation_failed" || detail?.code === "bundle_error" || detail?.code === "cycle_error" || detail?.code === "invalid_cwd") httpStatus = 400;
      }
      return c.json(result, httpStatus);
    }

    // apply 模式——完整生命周期
    const run = bootstrapRepo.createRun(sourceKind, sourceRef);
    bootstrapRepo.updateRunStatus(run.id, "running");
    eventBus.emit({ type: "bootstrap.started", runId: run.id, sourceRef });

    try {
      const result = await bootstrapOrchestrator.bootstrap({
        mode: "apply",
        sourceRef: resolvedSourceRef,
        sourceKind,
        autoApprove,
        cwdOverride,
        targetRoot,
        runId: run.id,
      });

      if (result.status === "completed") {
        eventBus.emit({ type: "bootstrap.completed", runId: result.runId, rigId: result.rigId!, sourceRef });

        // 从第一个 running node 计算 attach 命令
        let attachCommand: string | null = null;
        if (result.rigId) {
          const { getNodeInventory } = await import("../domain/node-inventory.js");
          const inventory = getNodeInventory(bootstrapRepo.db, result.rigId);
          const firstRunning = inventory.find((n) => n.canonicalSessionName && n.sessionStatus === "running");
          attachCommand = firstRunning?.tmuxAttachCommand ?? inventory.find((n) => n.canonicalSessionName)?.tmuxAttachCommand ?? null;
        }

        return c.json({ ...result, attachCommand }, 201);
      }
      if (result.status === "partial") {
        const ok = result.stages.filter((s) => s.status === "ok").length;
        const fail = result.stages.filter((s) => s.status === "failed" || s.status === "blocked").length;
        eventBus.emit({ type: "bootstrap.partial", runId: result.runId, sourceRef, rigId: result.rigId, completed: ok, failed: fail });

        // 从第一个 running node 计算 attach 命令
        let attachCommand: string | null = null;
        if (result.rigId) {
          const { getNodeInventory } = await import("../domain/node-inventory.js");
          const inventory = getNodeInventory(bootstrapRepo.db, result.rigId);
          const firstRunning = inventory.find((n) => n.canonicalSessionName && n.sessionStatus === "running");
          attachCommand = firstRunning?.tmuxAttachCommand ?? inventory.find((n) => n.canonicalSessionName)?.tmuxAttachCommand ?? null;
        }

        // OPR.0.3.2.CT——当部分结果携带 attention_required 的 import_rig stage 时
        // （要么是 instantiator 新 outcome 变体的全 attention 路径，
        // 要么是 orchestrator 同路由的混合 launched+attention 路径），
        // 呈现三段式错误，使 operator 看到受影响会话并检查其真实状态。
        // 工作组 + 会话在磁盘上保留；`zrig ps` 列出它们。PRD HG-4。
        const attentionResponse = buildAttentionResponse(result);
        if (attentionResponse) {
          return c.json({ ...result, attachCommand, ...attentionResponse }, 409);
        }

        return c.json({ ...result, attachCommand }, 200);
      }
      eventBus.emit({ type: "bootstrap.failed", runId: result.runId, sourceRef, error: result.errors[0] ?? "failed" });
      const hasBlocked = result.stages.some((s) => s.status === "blocked");
      // OPR.0.3.2.22 Bug 1 BONUS——在顶层呈现失败 code，并把 import_rig stage
      // 的 code（cycle_error、preflight_failed、validation_failed、
      // service_boot_failed）纳入 4xx 映射。CLI up.ts 已按 res.data["code"]
      // 对这些 code 分支；此修复前，后台服务把 code 埋在 stages[N].detail.code 里，
      // 返回裸 500——正是 openrig-comms hero-flow dogfood 在全新 0.3.1 安装上踩到的。
      let topLevelCode: string | undefined;
      // S5b final-fix F1（OPR.0.5.4.11）：running-name 守卫拒绝是冲突，
      // 不是服务端错误——把它的 code 和教学消息提升到顶层，使 CLI 能渲染锁定拒绝。
      // flat import 路径把完整 outcome 打进 stage detail（message 在场）；
      // pod 路径把 message 提升到 result.errors[0]、只打 code——两者都读。
      let conflictError: string | undefined;
      const hasConflict = result.stages.some((s) => {
        if (s.status !== "failed" || s.stage !== "import_rig") return false;
        const detail = s.detail as { code?: string; message?: string } | undefined;
        if (detail?.code !== "rig_name_running") return false;
        topLevelCode ??= "rig_name_running";
        conflictError ??= detail.message ?? result.errors[0];
        return true;
      });
      const hasBadRequest = result.stages.some((s) => {
        if (s.status !== "failed") return false;
        const detail = s.detail as { code?: string } | undefined;
        const code = detail?.code;
        if (!code) return false;
        const isResolveSpec4xx = s.stage === "resolve_spec" && (code === "file_not_found" || code === "parse_error" || code === "validation_failed" || code === "bundle_error" || code === "cycle_error" || code === "invalid_cwd");
        const isImportRig4xx = s.stage === "import_rig" && (code === "validation_failed" || code === "preflight_failed" || code === "cycle_error" || code === "service_boot_failed");
        if (isResolveSpec4xx || isImportRig4xx) {
          topLevelCode ??= code;
          return true;
        }
        return false;
      });
      const failedBody = topLevelCode
        ? { ...result, code: topLevelCode, ...(conflictError ? { error: conflictError } : {}) }
        : result;
      return c.json(failedBody, hasBlocked || hasConflict ? 409 : hasBadRequest ? 400 : 500);
    } catch (err) {
      bootstrapRepo.updateRunStatus(run.id, "failed");
      eventBus.emit({ type: "bootstrap.failed", runId: run.id, sourceRef, error: (err as Error).message });
      return c.json({ runId: run.id, status: "failed", error: (err as Error).message }, 500);
    }
  } finally {
    bootstrapOrchestrator.release(sourceRef);
  }
});
