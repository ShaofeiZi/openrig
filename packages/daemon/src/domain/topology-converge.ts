import type { PodRigInstantiator, AddMemberOutcome } from "./rigspec-instantiator.js";
import type { ClaimService, ReconcileSessionOutcome } from "./claim-service.js";

/**
 * Topology-mutation converge 主干（OPR.0.3.3.24，AC-6 scaffold）。
 *
 * reconciler model 为：diff(declaredSpec, liveTopology) -> Op[]；converge(op) 应用每个受支持 op。
 * 此 release 实现一个 op——`add_member`——基于提取出的 create-node + launch-binding primitive。
 * Op union shape 完整（所有 reshape kind 都有类型），differ 也会分类完整集合；但涉及 identity
 * migration 的 kind（remove/move/fork/change_runtime）被分类后延至 0.4.0 identity 主题：它们会
 * 迁移或克隆现有 seat identity（logical-id re-key + continuity_state migration + queue re-route），
 * 而 add_member 刻意不做这些。
 *
 * 这是 scaffold，而非完整 reconciler：此处没有 `zrig apply` loop（在此 release 中只是设计草图）。
 * converge() 绝不静默跳过不支持的 op——会如实报告“已检测到，但此版本尚不支持”。
 */

/** 完整的 topology-mutation op-kind 集合。 */
export type TopologyOp =
  | { kind: "add_member"; pod: string; member: Record<string, unknown>; edges?: Array<{ from: string; to: string; kind: string }> }
  // OPR.0.3.4.3——将 live、手动恢复的 canonical session 重新纳入其持久化 node，
  // 不执行 launch/kill/input（no-launch reconcile 路径）。这是 imperative repair op，
  // 无法从 declarative membership diff 推导（node 已存在，只有 live-binding projection stale），
  // 因此 diffTopology 不对它分类——由 convergeOp 直接应用。
  | { kind: "reconcile_session"; sessionName: string; rigId?: string; logicalId?: string }
  | { kind: "remove_member"; logicalId: string }
  | { kind: "move_member"; logicalId: string; toPod: string }
  | { kind: "fork_member"; logicalId: string; toMember: string }
  | { kind: "change_runtime"; logicalId: string; runtime: string };

export type TopologyOpKind = TopologyOp["kind"];

/** 此 release 中 converge() 实现的 op kind。其余项分类后延。 */
export const SUPPORTED_OP_KINDS: readonly TopologyOpKind[] = ["add_member", "reconcile_session"];

export function isSupportedOpKind(kind: TopologyOpKind): boolean {
  return SUPPORTED_OP_KINDS.includes(kind);
}

/** 已分类但不支持的 op kind 所用诚实消息（绝不静默跳过）。 */
export const DEFERRED_OP_REASON = "已检测到，但此版本尚不支持";

export type ConvergeResult =
  | { kind: "add_member"; supported: true; outcome: AddMemberOutcome }
  | { kind: "reconcile_session"; supported: true; outcome: ReconcileSessionOutcome }
  | { kind: TopologyOpKind; detected: true; supported: false; reason: string };

/** desired spec 中已声明的 member（一个 pod-scoped member fragment）。 */
export interface DeclaredMember {
  pod: string;
  id: string;
  runtime: string;
  fragment: Record<string, unknown>;
}

/** 工作组中当前实际存在的 member。 */
export interface LiveMember {
  logicalId: string;
  runtime: string;
}

/**
 * 将 declared member 与 live topology 之间的差异分类到完整 op-kind 集合。scaffold 语义：
 *   - 已声明但不在 live 中              -> add_member        （已实现）
 *   - 在 live 中但未声明                -> remove_member     （分类后延）
 *   - 两边都存在但 runtime 不同         -> change_runtime    （分类后延）
 *
 * move_member 与 fork_member 属于完整 shape 的 Op union，但无法从扁平 declarative membership
 * diff 自动推导：没有 stable-identity tracking 时，move 与 remove+add 无法区分；fork 仅为
 * imperative（无 declarative trigger）。检测它们需要 0.4.0 identity model（以 stable node-id
 * 为 key 的 durable state）。直接收到这些 op 时，convergeOp 仍会如实分类。
 */
export function diffTopology(declared: DeclaredMember[], live: LiveMember[]): TopologyOp[] {
  const ops: TopologyOp[] = [];
  const liveById = new Map(live.map((m) => [m.logicalId, m]));
  const declaredIds = new Set(declared.map((m) => `${m.pod}.${m.id}`));

  for (const m of declared) {
    const qualifiedId = `${m.pod}.${m.id}`;
    const liveMatch = liveById.get(qualifiedId);
    if (!liveMatch) {
      ops.push({ kind: "add_member", pod: m.pod, member: m.fragment });
    } else if (liveMatch.runtime !== m.runtime) {
      ops.push({ kind: "change_runtime", logicalId: qualifiedId, runtime: m.runtime });
    }
  }

  for (const m of live) {
    if (!declaredIds.has(m.logicalId)) {
      ops.push({ kind: "remove_member", logicalId: m.logicalId });
    }
  }

  return ops;
}

/** converge boundary 按 op kind 组合的 domain service（OPR.0.3.4.3：主干新增第二个已实现 op，
 *  因此 convergeOp 接受 deps object——add_member 在 instantiator 上运行，reconcile_session
 *  在 claim service 的 no-input reconcile binding 上运行）。 */
export interface ConvergeDeps {
  instantiator: PodRigInstantiator;
  /** reconcile_session op 必需；仅调用 add_member 的 caller 可省略。 */
  claimService?: ClaimService;
}

/**
 * 应用单个 topology op。`add_member` 通过 PodRigInstantiator.addMemberToPod 运行提取出的
 * create-node + launch-binding seam；`reconcile_session` 运行 ClaimService.reconcileSession——
 * 将 live、手动恢复的 session 纳入其持久化 node，不执行 launch 或 input（绝不抵达
 * NodeLauncher.launchNode 或任何 pane-input primitive）。其他 kind 都会如实报告为 detected-but-
 * unsupported，绝不静默跳过。CLI 与 MCP 在此 converge boundary 上公开 agent ergonomics
 *（JSON + 诚实的三段式 error），使未来 verb 继承 human/agent parity。
 */
export async function convergeOp(
  deps: ConvergeDeps,
  rigId: string,
  op: TopologyOp,
  rigRoot: string,
  opts?: { cwdOverride?: string },
): Promise<ConvergeResult> {
  switch (op.kind) {
    case "add_member": {
      const outcome = await deps.instantiator.addMemberToPod(rigId, op.pod, op.member, rigRoot, {
        cwdOverride: opts?.cwdOverride,
        edges: op.edges,
      });
      return { kind: "add_member", supported: true, outcome };
    }
    case "reconcile_session": {
      if (!deps.claimService) {
        return {
          kind: "reconcile_session",
          supported: true,
          outcome: { ok: false, code: "reconcile_error", message: "Claim service 不可用，无法 reconcile。" },
        };
      }
      const outcome = await deps.claimService.reconcileSession({
        sessionName: op.sessionName,
        rigId: op.rigId,
        logicalId: op.logicalId,
      });
      return { kind: "reconcile_session", supported: true, outcome };
    }
    case "remove_member":
    case "move_member":
    case "fork_member":
    case "change_runtime":
      return { kind: op.kind, detected: true, supported: false, reason: DEFERRED_OP_REASON };
    default: {
      const _exhaustive: never = op;
      throw new Error(`未知 topology op kind：${(_exhaustive as TopologyOp).kind}`);
    }
  }
}
