// TUI 的选择/同意边界。状态来自既有 repository；
// 副作用仍由 kernel 物化、restore 与 seat 生命周期持有。
import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { SnapshotRepository } from "../domain/snapshot-repository.js";
import type { SnapshotCapture } from "../domain/snapshot-capture.js";
import type { RestoreOrchestrator } from "../domain/restore-orchestrator.js";
import type { RuntimeAdapter } from "../domain/runtime-adapter.js";
import type { PodRigInstantiator } from "../domain/rigspec-instantiator.js";
import type { ResumeMetadataRefresher } from "../domain/resume-metadata-refresher.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { Node, RigWithRelations } from "../domain/types.js";
import { defaultProbeRuntimes } from "../domain/kernel-boot.js";
import { SettingsStore } from "../domain/user-settings/settings-store.js";
import { buildRestorePlanPreview, collectPreviewSessionRows } from "../domain/restore-plan-preview.js";
import { assessCurrentStateRehydrateEligibility, snapshotMatchesCurrentOccupants } from "../domain/rehydrate-eligibility.js";
import { deriveCanonicalSessionName, deriveSessionName } from "../domain/session-name.js";
import { observeSolePane } from "../domain/pane-binding-observation.js";
import { assessNativeResumeProbe } from "../domain/native-resume-probe.js";
import { RigSpecCodec } from "../domain/rigspec-codec.js";
import { RigSpecSchema } from "../domain/rigspec-schema.js";
import { seatLifecycleService } from "./seat.js";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import { readFreshOccupantRelations } from "../domain/fresh-occupant-relation.js";

export const startupRoutes = new Hono();
startupRoutes.use("*", async (c, next) => {
  const response = await authBearerTokenMiddleware({
    expectedToken: dep<string | null>(c, "terminalBearerToken") ?? null,
  })(c, next);
  if (response?.status === 401) return c.json({ ok: false, code: "terminal_auth_unavailable", freshAllowed: false,
    message: "此 TUI 无法对所选后台服务完成鉴权。请检查该实例及其 terminal-token 访问权限，然后刷新。未启动任何席位。" }, 401);
  return response;
});
const active = new WeakMap<Database.Database, Set<string>>();
function dep<T>(c: Context, key: string): T { return c.get(key as never) as T; }
function repo(c: Context) { return dep<RigRepository>(c, "rigRepo"); }
function sessions(c: Context) { return dep<SessionRegistry>(c, "sessionRegistry"); }
function tmux(c: Context) { return dep<TmuxAdapter>(c, "tmuxAdapter"); }

/** 由已消费状态派生的同意版本，绝不是第二份 owner 台账。 */
export function startupRevision(db: Database.Database, node: Node): string {
  const currentNode = db.prepare("SELECT * FROM nodes WHERE id = ?").get(node.id);
  const history = db.prepare("SELECT id, status, resume_type, resume_token FROM sessions WHERE node_id = ? ORDER BY id").all(node.id);
  const context = db.prepare("SELECT runtime, projection_entries_json, resolved_files_json, startup_actions_json FROM node_startup_context WHERE node_id = ?").get(node.id);
  return createHash("sha256").update(JSON.stringify({ node: currentNode, history, context })).digest("hex");
}

async function exclusive(c: Context, key: string, action: () => Promise<Response>): Promise<Response> {
  const db = repo(c).db;
  let locks = active.get(db);
  if (!locks) { locks = new Set(); active.set(db, locks); }
  if (locks.has(key)) return c.json({ ok: false, code: "operation_in_progress", message: "该操作已在运行。请刷新以对账其结果。" }, 409);
  locks.add(key);
  try { return await action(); } finally { locks.delete(key); }
}

function currentSnapshot(c: Context, rig: RigWithRelations) {
  const snapshot = dep<SnapshotRepository>(c, "snapshotRepo").findLatestRestoreUsable(rig.rig.id);
  return snapshot && snapshotMatchesCurrentOccupants(repo(c).db, rig, snapshot) ? snapshot : null;
}

async function observeSeat(c: Context, rig: RigWithRelations, node: Node) {
  const dot = node.logicalId.indexOf(".");
  const name = sessions(c).getBindingForNode(node.id)?.tmuxSession ?? (node.podId && dot > 0
    ? deriveCanonicalSessionName(node.logicalId.slice(0, dot), node.logicalId.slice(dot + 1), rig.rig.name)
    : deriveSessionName(rig.rig.name, node.logicalId));
  try {
    const presence = await tmux(c).probeSession(name);
    if (presence.state === "absent") return { state: "stopped", detail: "无活动终端", sessionName: name };
    if (presence.state === "transport_unavailable") return { state: "transport_unavailable",
      detail: "terminal 服务器不可用。start/resume 可尝试原子创建，但不能覆盖已存在的终端。", sessionName: name };
    const pane = await observeSolePane(tmux(c), name);
    if (!pane.ok) return { state: "unverified", detail: pane.detail, sessionName: name };
    if (node.runtime === "terminal") return { state: "running", detail: "终端可用", sessionName: name };
    const probe = assessNativeResumeProbe({ runtime: node.runtime,
      paneCommand: await tmux(c).getPaneCommand(pane.pane),
      paneContent: (tmux(c).capturePaneScreen ? await tmux(c).capturePaneScreen(pane.pane) : await tmux(c).capturePaneContent(pane.pane, 40)) ?? "" });
    return { state: probe.status === "resumed" ? "running" : "attention_required", detail: probe.detail, sessionName: name };
  } catch (error) {
    return { state: "unverified", detail: error instanceof Error ? error.message : String(error), sessionName: name };
  }
}

async function refreshNativeMetadata(c: Context, rigId: string) {
  const refresher = dep<ResumeMetadataRefresher | undefined>(c, "resumeMetadataRefresher");
  if (refresher) await refresher.refresh(sessions(c).getLatestLiveSessions(rigId), { fillNullOnly: true });
}

startupRoutes.get("/prerequisites", async (c) => c.json(await defaultProbeRuntimes()));
startupRoutes.post("/terminal", (c) => exclusive(c, "terminal", async () => {
  const result = await tmux(c).startServer();
  return c.json(result, result.ok ? 200 : 409);
}));

// 首次设置只物化内置 topology，不启动任何占用者。
startupRoutes.post("/kernel", (c) => exclusive(c, "kernel", async () => {
  const body = await c.req.json().catch(() => ({}));
  if (body.runtime !== "codex" && body.runtime !== "claude-code") return c.json({ ok: false, message: "请为新 kernel 选择一个已鉴权的运行时。" }, 400);
  const existing = repo(c).findRigsByName("kernel");
  if (existing.length > 1) return c.json({ ok: false, message: "存在多个 kernel；继续前请精确选择一个工作组。" }, 409);
  if (existing.length === 1) return c.json({ ok: true, rigId: existing[0]!.id, reused: true });
  const auth = await defaultProbeRuntimes();
  if ((body.runtime === "codex" ? auth.codex : auth.claudeCode) !== "ok") return c.json({ ok: false, code: "provider_prerequisite", message: "所选运行时不可用或未鉴权。请先修复该前置条件再重试；全新历史无法解决它。" }, 409);
  const root = kernelRoot();
  const source = readFileSync(root + (body.runtime === "codex" ? "rig-codex-only.yaml" : "rig-claude-only.yaml"), "utf8");
  const result = await dep<PodRigInstantiator>(c, "podInstantiator").materialize(source, root, {
    cwdOverride: new SettingsStore().resolveConfig().workspaceRoot,
  });
  return c.json(result.ok ? { ok: true, rigId: result.result.rigId, message: "Kernel 已就绪。请选择要启动的席位。" } : result, result.ok ? 200 : 409);
}));

function kernelRoot() { return fileURLToPath(new URL("../../specs/rigs/launch/kernel/", import.meta.url)); }

startupRoutes.get("/:rigId", async (c) => {
  const rig = repo(c).getRig(c.req.param("rigId"));
  if (!rig) return c.json({ ok: false, message: "该工作组已不可用。" }, 404);
  const snapshot = currentSnapshot(c, rig);
  const plan = buildRestorePlanPreview(rig, snapshot, collectPreviewSessionRows(repo(c).db, rig, snapshot), undefined, Date.now(), readFreshOccupantRelations(repo(c).db, rig.rig.id));
  const auth = await defaultProbeRuntimes();
  const history = sessions(c).getSessionsForRig(rig.rig.id);
  const seats = [];
  for (const node of rig.nodes) {
    const forecast = plan.nodes.find((entry) => entry.logicalId === node.logicalId)!;
    const hasHistory = history.some((session) => session.nodeId === node.id);
    const available = node.runtime === "codex" ? auth.codex === "ok" : node.runtime === "claude-code" ? auth.claudeCode === "ok" : true;
    const observed = await observeSeat(c, rig, node);
    seats.push({ ...forecast, hasHistory, nodeId: node.id, runtime: node.runtime, model: node.model,
      revision: startupRevision(repo(c).db, node), observed,
      contextPending: history.some((session) => session.nodeId === node.id && dep<import("../domain/startup-orchestrator.js").StartupOrchestrator>(c, "startupOrchestrator")?.canContinueFresh(node.id, session.id)),
      freshAllowed: available && observed.state === "stopped",
      ...(!available ? { prerequisite: `${node.runtime} 不可用或未鉴权。请修复后重试；全新历史无法修复此前置条件。` } : {}) });
  }
  return c.json({ rigId: rig.rig.id, rigName: rig.rig.name, seats });
});

startupRoutes.post("/:rigId/:logicalId", async (c) => {
  const rig = repo(c).getRig(c.req.param("rigId"));
  const node = rig?.nodes.find((entry) => entry.logicalId === c.req.param("logicalId"));
  if (!rig || !node) return c.json({ ok: false, message: "所选席位已不可用。" }, 404);
  return exclusive(c, node.id, async () => {
    const body = await c.req.json().catch(() => ({}));
    if (!["resume", "start", "fresh", "continue"].includes(body.action) || typeof body.revision !== "string") return c.json({ ok: false, message: "需要指定具名 action 与当前席位 revision。" }, 400);
    if (body.revision !== startupRevision(repo(c).db, node)) return c.json({ ok: false, code: "selection_changed", message: "自本次选择展示以来席位已变化。请刷新后重新决策。" }, 409);
    const observed = await observeSeat(c, rig, node);
    if (body.action === "continue") {
      const result = await seatLifecycleService(c).continueFreshStartup(observed.sessionName);
      await refreshNativeMetadata(c, rig.rig.id);
      return c.json(result, result.ok ? 200 : 409);
    }
    // 已有内容或无法探测的 pane 绝不被覆盖，即使显式 fresh 也不行。
    if (observed.state !== "stopped" && !(observed.state === "transport_unavailable" && body.action !== "fresh")) return c.json({ ok: observed.state === "running", code: observed.state,
      message: observed.detail, sessionName: observed.sessionName }, observed.state === "running" ? 200 : 409);
    if (node.runtime === "codex" || node.runtime === "claude-code") {
      const auth = await defaultProbeRuntimes();
      if ((node.runtime === "codex" ? auth.codex : auth.claudeCode) !== "ok") return c.json({ ok: false, code: "provider_prerequisite", freshAllowed: false,
        message: `${node.runtime} 不可用或未鉴权。请修复后重试。开启全新对话无法修复鉴权。` }, 409);
    }
    if (body.revision !== startupRevision(repo(c).db, node)) return c.json({ ok: false, code: "selection_changed",
      message: "检查前置条件期间席位已变化。请刷新后再做新决策。" }, 409);
    const history = sessions(c).getSessionsForRig(rig.rig.id).filter((session) => session.nodeId === node.id);
    if (body.action === "start" && history.length > 0) return c.json({ ok: false, code: "history_present", message: "该席位有历史记录。请选择 resume，或显式确认开启全新对话。" }, 409);
    if (body.action === "fresh") {
      const result = await seatLifecycleService(c).launchFresh({ seatRef: observed.sessionName, fresh: true,
        reason: `TUI 对 ${node.logicalId} 显式同意 fresh，观测 revision ${body.revision}`, stop: false });
      await refreshNativeMetadata(c, rig.rig.id);
      if (result.ok) dep<SnapshotCapture>(c, "snapshotCapture").captureSnapshot(rig.rig.id, "auto-rehydrate");
      return c.json(result, result.ok ? 200 : 409);
    }
    // 从未占用的内置席位复用物化已有的 launch 副作用。
    if (history.length === 0 && rig.rig.name === "kernel") {
      const root = kernelRoot();
      const raw = RigSpecCodec.parse(readFileSync(root + (node.runtime === "codex" ? "rig-codex-only.yaml" : "rig-claude-only.yaml"), "utf8"));
      const spec = RigSpecSchema.normalize(raw as Record<string, unknown>);
      const pod = spec.pods.find((entry) => entry.id === node.logicalId.split(".")[0]);
      const member = pod?.members.find((entry) => `${pod.id}.${entry.id}` === node.logicalId);
      if (!pod || !member || member.agentRef !== node.agentRef || member.runtime !== node.runtime) return c.json({ ok: false, message: "此 kernel 席位与已安装定义不一致；其 owner 必须修复 startup 来源。" }, 409);
      const result = await dep<PodRigInstantiator>(c, "podInstantiator").launchBinding({ rigId: rig.rig.id, rigSpec: spec, rigRoot: root, pod,
        member: { ...member, ...(node.model ? { model: node.model } : {}) }, qualifiedId: node.logicalId, nodeId: node.id, cwdOverride: node.cwd ?? undefined });
      await refreshNativeMetadata(c, rig.rig.id);
      dep<SnapshotCapture>(c, "snapshotCapture").captureSnapshot(rig.rig.id, "auto-rehydrate");
      const after = await observeSeat(c, rig, node);
      const ok = result.status === "launched" && after.state === "running";
      return c.json({ ...result, ok, observed: after, ...(!ok ? { message: after.detail, freshAllowed: false } : {}) }, ok ? 200 : 409);
    }
    const selectedRig = { ...rig, nodes: [node] };
    let snapshot = currentSnapshot(c, selectedRig);
    if (!snapshot) {
      const eligibility = assessCurrentStateRehydrateEligibility(repo(c).db, selectedRig);
      if (!eligibility.ok) return c.json({ ok: false, code: "startup_source_unavailable", message: eligibility.blockers.join("; ") }, 409);
      snapshot = dep<SnapshotCapture>(c, "snapshotCapture").captureSnapshot(rig.rig.id, "auto-rehydrate");
    }
    const forecast = buildRestorePlanPreview(selectedRig, snapshot, collectPreviewSessionRows(repo(c).db, selectedRig, snapshot)).nodes[0]!;
    if (history.length > 0 && forecast.intendedAction !== "resume-original") return c.json({ ok: false, code: "resume_unavailable", freshAllowed: forecast.freshRequired,
      message: forecast.reason ?? "按此席位的配置策略无法恢复先前对话。全新对话需要单独决策。" }, 409);
    const result = await dep<RestoreOrchestrator>(c, "restoreOrchestrator").launchSingleNode(rig.rig.id, node.logicalId, {
      snapshotId: snapshot.id, adapters: dep<Record<string, RuntimeAdapter>>(c, "runtimeAdapters"), fsOps: { exists: existsSync },
    });
    const outcome = result.launched?.[0];
    const ok = result.ok && (!outcome || ["resumed", "fresh-primed"].includes(outcome.status));
    await refreshNativeMetadata(c, rig.rig.id);
    return c.json({ ...result, ok, code: outcome?.status ?? result.code,
      message: outcome?.error ?? result.message ?? (outcome?.status === "resumed" ? "已恢复先前对话。" : "席位启动已对账。") }, ok ? 200 : 409);
  });
});
