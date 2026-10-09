// OPR.0.4.3.22——rig-status compose（对 per-seat backend truth 的纯 FOLD）。
//
// 这是 rig-status + launch-control UI 的 daemon 侧。它不是新 restore pipeline，也不是 slice-20
// ledger。它将四个已交付 signal 折叠成 UI 渲染的单个 `{ status, perSeat[], src[] }` object：
//
//   1. ps-lifecycle       — per-node `lifecycleState` (running/detached/recoverable/attention).
//   2. restore-plan       —— `buildRestorePlanPreview` 的逐席位预测（tokenState + intendedAction）。
//   3. restore-check      — `RecoveryPlan.status` readiness (blocked / actionable / unknown).
//   4. kernel-status      —— `KernelState`（仅为 kernel 工作组折叠；绝不读取后台服务 /healthz）。
//
// 锁定原则（founder/PM）：aggregate 是 per-seat truth 的纯 FOLD——rig 绝不全局切换为 `fresh`。
// “fresh”只会出现在 `freshLogicalIds`（backend 贯穿传递的 per-seat list）。本模块派生的 aggregate
// 因 individual seat 被阻塞而显示 `blocked`/`partial`；它绝不重绘 per-seat truth（全局 fresh flip
// 会成为 FR-7 刚移除的 silent-fresh-prime 行为的 UI 形式）。compose 函数不会修改 input plan——
// 本应 resume 的 seat 继续保持 `resume-original`。
//
// `src[]` 是组合后的 provenance（折叠了哪些 signal 及其值）——“组合而非推断；source state 在
// debug/test 中可见”的契约。它源自真实 backend data，绝不源自 pane text。

import type { NodeLifecycleState } from "./types.js";
import type { RestorePlanPreview } from "./restore-plan-preview.js";
import type { ResumeTokenState } from "./restore-plan-preview.js";
import type { RecoveryPlan } from "./restore-check-service.js";
import type { KernelState } from "./kernel-boot-tracker.js";
import { deriveRigLifecycleState } from "./ps-projection.js";

/** 组合后的 rig-level aggregate。纯 fold——绝不是覆盖 per-seat truth 的 verdict。 */
export type RigAggStatus = "up" | "partial" | "down" | "blocked" | "unknown";

export interface RigStatusSeat {
  logicalId: string;
  runtime: string | null;
  /** 实时进程生命周期（ps-projection）。 */
  lifecycleState: NodeLifecycleState;
  /** 只读 restore-plan forecast（restore-plan-preview）。 */
  tokenState: ResumeTokenState;
  intendedAction: "resume-original" | "fresh-primed" | "awaiting-decision";
  freshRequired: boolean;
  /** 此 seat 阻塞 restore-original（awaiting-decision）时为 true——该 per-seat blocker 会折叠为
   *  aggregate `blocked`。 */
  blocked: boolean;
  provenance?: string | null;
  lastVerified?: string | null;
  reason?: string;
  runtimePrompt?: string;
}

export interface RigStatusObject {
  rigId: string;
  rigName: string;
  isKernel: boolean;
  status: RigAggStatus;
  seatsTotal: number;
  seatsRunning: number;
  /** rig 无需 operator action 即可恢复（down/partial）时为 true；被阻塞（需要 decision）或已 up
   *  时为 false。 */
  recoverable: boolean;
  perSeat: RigStatusSeat[];
  /** 组合 provenance——已折叠 signal 及其值。在 UI 的 `src:` 行与 debug/test output 中可见
   *  （非推断契约）。 */
  src: string[];
}

export interface SeatLifecycleInput {
  logicalId: string;
  runtime: string | null;
  lifecycleState: NodeLifecycleState;
}

export interface ComposeRigStatusInput {
  rigId: string;
  rigName: string;
  isKernel?: boolean;
  /** per-node ps-lifecycle truth（来自 node-inventory）。 */
  nodes: SeatLifecycleInput[];
  /** 只读 restore-plan forecast（buildRestorePlanPreview）——不会被修改。 */
  plan: RestorePlanPreview;
  /** 此 rig 的 restore-check recovery readiness（可选；存在时参与折叠）。 */
  recovery?: RecoveryPlan | null;
  /** kernel-status state——只为 kernel rig 折叠（绝不使用 /healthz）。 */
  kernelState?: KernelState | null;
}

/** 需要显式 operator action 的 kernel state（真正的 blocker）。 */
function kernelIsBlocked(state: KernelState): boolean {
  return state === "auth_blocked" || state === "spec_missing" || state === "bootstrap_failed";
}

/** 将 kernel state 映射为 aggregate（仅用于 kernel rig）。`skipped` 返回 null——随后 caller 改为
 *  折叠 lifecycle。 */
function kernelAggregate(state: KernelState): RigAggStatus | null {
  switch (state) {
    case "ready":
      return "up";
    case "booting":
    case "partial_ready":
    case "degraded":
      return "partial";
    case "auth_blocked":
    case "spec_missing":
    case "bootstrap_failed":
      return "blocked";
    case "skipped":
      return null;
  }
}

/** 将四个 backend signal 折叠为单个 rig-status object。纯函数——不修改 input plan
 *  （可 resume 的 seat 保持 resume-original）。 */
export function composeRigStatus(input: ComposeRigStatusInput): RigStatusObject {
  const { rigId, rigName, nodes, plan, recovery, kernelState } = input;
  const isKernel = input.isKernel ?? false;

  // 按 logicalId 连接 ps-lifecycle node 与 restore-plan forecast。
  const planByLogicalId = new Map(plan.nodes.map((n) => [n.logicalId, n]));
  const perSeat: RigStatusSeat[] = nodes.map((node) => {
    const p = planByLogicalId.get(node.logicalId);
    const intendedAction = p?.intendedAction ?? "awaiting-decision";
    const tokenState: ResumeTokenState = p?.tokenState ?? "unverified";
    const blocked = intendedAction === "awaiting-decision";
    return {
      logicalId: node.logicalId,
      runtime: node.runtime,
      lifecycleState: node.lifecycleState,
      tokenState,
      intendedAction,
      freshRequired: p?.freshRequired ?? false,
      blocked,
      provenance: p?.provenance ?? null,
      lastVerified: p?.lastVerified ?? null,
      ...(p?.reason ? { reason: p.reason } : {}),
      ...(p?.runtimePrompt ? { runtimePrompt: p.runtimePrompt } : {}),
    };
  });

  const seatsTotal = nodes.length;
  const seatsRunning = nodes.filter((n) => n.lifecycleState === "running").length;
  const lifecycle = deriveRigLifecycleState(nodes.map((n) => n.lifecycleState));

  // --- Aggregate fold（优先级：blocked > unknown > lifecycle/kernel）-----------
  // 任意 blocked seat（awaiting-decision / restore-check blocker / kernel auth/spec/bootstrap
  // failure）→ aggregate `blocked`。这是锁定原则的关键场景：同时有 resumable 与 blocked seat 的
  // rig 会因为 seat 被阻塞而显示 `blocked`——resumable seat 在 perSeat 中仍为 resume-original。
  const anySeatBlocked = perSeat.some((s) => s.blocked);
  const recoveryBlocked = recovery?.status === "blocked";
  const kernelBlocked = isKernel && kernelState != null && kernelIsBlocked(kernelState);

  let status: RigAggStatus;
  if (anySeatBlocked || recoveryBlocked || kernelBlocked) {
    status = "blocked";
  } else if (recovery?.status === "unknown") {
    status = "unknown";
  } else {
    // Kernel rig：由 kernel-status 驱动非 blocked aggregate（绝不只用 lifecycle，也绝不使用
    // /healthz）。skipped 时回退到 lifecycle fold。
    const kernelAgg = isKernel && kernelState != null ? kernelAggregate(kernelState) : null;
    if (kernelAgg) {
      status = kernelAgg;
    } else {
      status = lifecycleToAggregate(lifecycle);
    }
  }

  const recoverable = status === "down" || status === "partial";

  // --- src[] provenance（组合而非推断）---------------------------------------
  const actionCounts = countActions(perSeat);
  const src: string[] = [
    `ps: ${seatsRunning}/${seatsTotal} 运行中 · lifecycle=${lifecycle}`,
    `restore-plan: ${actionCounts}`,
  ];
  if (recovery) src.push(`restore-check: ${recovery.status}`);
  if (isKernel && kernelState != null) src.push(`kernel-status.kernel_state=${kernelState}`);

  return {
    rigId,
    rigName,
    isKernel,
    status,
    seatsTotal,
    seatsRunning,
    recoverable,
    perSeat,
    src,
  };
}

function lifecycleToAggregate(lifecycle: ReturnType<typeof deriveRigLifecycleState>): RigAggStatus {
  switch (lifecycle) {
    case "running":
      return "up";
    case "degraded":
    case "attention_required":
      return "partial";
    case "recoverable":
    case "stopped":
      return "down";
  }
}

function countActions(perSeat: RigStatusSeat[]): string {
  const counts = { "resume-original": 0, "fresh-primed": 0, "awaiting-decision": 0 };
  for (const s of perSeat) counts[s.intendedAction] += 1;
  const parts: string[] = [];
  if (counts["resume-original"]) parts.push(`${counts["resume-original"]} resume-original`);
  if (counts["fresh-primed"]) parts.push(`${counts["fresh-primed"]} fresh-primed`);
  if (counts["awaiting-decision"]) parts.push(`${counts["awaiting-decision"]} awaiting-decision`);
  return parts.length > 0 ? parts.join(", ") : "无 seat";
}
