// B1——Crash-cart RESTORE CONDUCTOR（daemon-side batch verb）。已锁定计划
//（workspace/missions/release-0.5.2/B1-CRASH-CART-CONDUCTOR-PLAN-2026-08-21，content-hash 84401cd4）。
//
// Atom B——conductor core。它按 founder 指定顺序恢复 fleet 工作组（kernel 工作组优先，其余按序，
// v1 串行），通过可注入 `restoreRig` 依赖组合已交付的 per-rig restore
//（findLatestRestoreUsable + RestoreOrchestrator.restore），不重新实现 restore logic。best-effort：
// 一个工作组失败绝不停止 fleet。cancel 采用 STOP-BEFORE-NEXT-RIG：in-flight 工作组运行到自身
// outcome；尚未开始的工作组变为 `not_attempted`（Atom A/C wire discovery + fleet rollup；
// Atom D 为 TUI ⏎）。

/** 已交付的 closed per-rig union（绝不在 fleet layer 扩宽）。`not_attempted` 是一等状态——表示
 *  conductor 未处理到的工作组（无可用 snapshot，或已取消）。 */
export type PerRigOutcome = "fully_restored" | "partially_restored" | "failed" | "not_attempted";

/** 单个工作组的 conductor result。`receiptRef` 引用持久 restore event/attempt seq（ledger
 *  lineage）——conductor 只渲染 receipt，绝不重新编写。 */
export interface ConductorRigResult {
  rigId: string;
  outcome: PerRigOutcome;
  receiptRef?: string | number;
  /** per-rig triage row（需要 operator action 的 seat）——fleet attention_required 是整条
   *  sequence 上这些 row 的并集。 */
  attention?: AttentionRow[];
  /** R3——对于 `not_attempted` 工作组，说明跳过原因（不留下未解释空白）。 */
  reason?: string;
  /** R3——使该工作组下次可恢复的 operator action。 */
  remediation?: string;
}

export interface RestoreConductorDeps {
  /** 按恢复顺序排列的工作组——KERNEL（supervisor）优先，其余随后。 */
  listRigsInOrder: () => Array<{ rigId: string; isKernel: boolean }>;
  /** 恢复一个工作组。默认值（在路由接线）= findLatestRestoreUsable(rigId) →
   * RestoreOrchestrator.restore(snapshotId) → rollupRestoreRigResult；没有可用快照的工作组
   * 返回 `not_attempted`，绝不静默替换为更旧或不完整的快照。 */
  restoreRig: (
    rigId: string,
  ) => Promise<{ outcome: PerRigOutcome; receiptRef?: string | number; attention?: AttentionRow[]; reason?: string; remediation?: string }>;
  /** cancel signal，在每个工作组边界轮询（stop-before-next-rig）。可选。 */
  isCancelled?: () => boolean;
}

export class RestoreConductor {
  constructor(private readonly deps: RestoreConductorDeps) {}

  /** 以 kernel-first、best-effort 方式恢复 fleet，并遵守 stop-before-next-rig cancel。返回有序的
   *  per-rig sequence（Atom C 将其聚合为 FleetRollup）。 */
  async restoreFleet(opts?: { onRigDone?: (result: ConductorRigResult) => void }): Promise<ConductorRigResult[]> {
    const rigs = this.deps.listRigsInOrder(); // kernel 优先，其余随后
    const results: ConductorRigResult[] = [];
    // progress “stream”：每个工作组完成时发出 result，使 route 可在 fleet restore 继续运行期间
    // 更新可轮询 rollup（锁定的 async shape——route 在 commit 时响应，绝不阻塞等待完成）。
    // onRigDone 在下方接线前由 stub 提供（RED-first）。
    const record = (result: ConductorRigResult) => {
      results.push(result);
      opts?.onRigDone?.(result); // 每个工作组完成时发出 progress
    };
    for (const rig of rigs) {
      // stop-before-next-rig：在此工作组启动前，于工作组边界轮询 cancel。已 in-flight 的工作组
      // 绝不中断；尚未处理到的工作组变为 `not_attempted`（诚实，绝不静默丢弃）。
      if (this.deps.isCancelled?.()) {
        record({
          rigId: rig.rigId,
          outcome: "not_attempted",
          reason: "此工作组启动前已取消（stop-before-next-rig）",
          remediation: "重新运行 fleet restore 以尝试恢复此工作组",
        });
        continue;
      }
      try {
        const r = await this.deps.restoreRig(rig.rigId);
        record({
          rigId: rig.rigId,
          outcome: r.outcome,
          receiptRef: r.receiptRef,
          attention: r.attention,
          reason: r.reason,
          remediation: r.remediation,
        });
      } catch {
        // best-effort 继续：一个工作组失败绝不停止 fleet。
        record({ rigId: rig.rigId, outcome: "failed" });
      }
    }
    return results;
  }
}

/** 默认 per-rig restore 的依赖——使用结构类型，使 conductor 与完整 orchestrator 解耦（真实接线传入
 *  `snapshotRepo.findLatestRestoreUsable` 与 `RestoreOrchestrator.restore`，其 RestoreOutcome 满足
 *  此 shape）。 */
export interface RestoreRigDeps {
  /** 工作组最新的 restore-usable snapshot；null → `not_attempted`，绝不静默替代。 */
  findLatestRestoreUsable: (rigId: string) => { id: string } | null;
  /** 可选的 richer selector。production 提供它，使 restore attempt 记录 crash-cart 选择此 source
   *  的原因；legacy test/integration caller 可保留历史 finder-only shape。 */
  selectRestoreUsable?: (rigId: string) =>
    | { ok: true; snapshot: { id: string }; selection: import("./types.js").RestoreSnapshotSelection }
    | { ok: false };
  /** 已交付 per-rig restore。`onAttemptStarted` 产生 restore-started event seq，即 receipt ref。 */
  restore: (
    snapshotId: string,
    opts?: {
      onAttemptStarted?: (attemptId: number) => void;
      snapshotSelection?: import("./types.js").RestoreSnapshotSelection;
    },
  ) => Promise<{ ok: boolean; result?: { rigResult: PerRigOutcome; nodes?: RestoreNodeLite[] } }>;
}

// ── AMENDMENT 2（stamped，body hash 72757e81）——surviving-panes ADOPT 分支 ─────────
// 它解决的矛盾：仅 daemon 崩溃（pane 存活）时，restore() 按设计以 409 `rig_not_stopped`
// fail-close，但锁定 acceptance 要求 resumable seat 回到其 pane——只有 ADOPTION 能实现。对每个
// 工作组：live pane 组合已交付 reconcile/adopt + per-seat resume verification；dead pane 逐字不变
// 地走下方 restore composition。R9 边界：adoption 只触碰 SESSION state（binding/session/event），
// 绝不触碰 queue state。

/** subset-launch result 中的一个 seat；在结构上是 triage mapper 所读的已交付 RestoreNodeResult 子集。 */
export interface AdoptSubsetSeat extends RestoreNodeLite {
  logicalId: string;
}

/** RestoreOrchestrator.launchNodeSubset result 的结构子集——已交付的 per-seat resume-verification
 *  机制（FR-7：无法验证的 resume 会 fail-close 为 awaiting-decision，并携带精确
 *  `--fresh <logicalId>` remediation）。 */
export interface AdoptSubsetResult {
  ok: boolean;
  code?: string;
  message?: string;
  launched?: AdoptSubsetSeat[];
  held?: Array<{ logicalId: string; reason: string }>;
  alreadyRunning?: Array<{ logicalId: string }>;
  failedTargets?: Array<{ logicalId: string; reason: string }>;
}

export interface AdoptRigDeps {
  /** 工作组中 DB-running 且 tmux pane 存活的 session——与 restore 的 409 guard 使用相同 classification
   *  （sessionRegistry row × tmuxAdapter.hasSession）；conductor 绝不虚构 probe。 */
  probeLiveSessions: (rigId: string) => Promise<Array<{ sessionName: string; logicalId: string }>>;
  /** 已交付的 no-launch adopt（ClaimService.reconcileSession——`zrig reconcile-session` 先例）：
   *  只处理 session state，绝不输入。 */
  reconcileSession: (sessionName: string) => Promise<{ ok: boolean; code?: string; message?: string }>;
  /** 工作组完整 seat roster（logical id）——adoption 的补集正是 per-seat resume verification
   *  必须覆盖的范围。 */
  listRigSeats: (rigId: string) => string[];
  /** 针对未 adopt seat 的已交付 subset launcher。 */
  launchNodeSubset: (rigId: string, logicalIds: string[]) => Promise<AdoptSubsetResult>;
}

/** LIVE-panes 分支：adopt 每个 surviving session，再对其余项执行 per-seat resume verification，
 *  并折叠到未改变的 closed union。seat 当且仅当不产生 triage row 时为 OK
 *  （attentionRowsFromNodes 是唯一 non-OK authority，因此 fold 无法虚构第五种 outcome 或第二映射）。 */
async function adoptLivePanesRig(
  rigId: string,
  live: Array<{ sessionName: string; logicalId: string }>,
  deps: AdoptRigDeps,
): Promise<{ outcome: PerRigOutcome; attention?: AttentionRow[]; reason?: string; remediation?: string }> {
  const nodes: RestoreNodeLite[] = [];
  const adoptedIds = new Set<string>();
  for (const seat of live) {
    const adopted = await deps.reconcileSession(seat.sessionName);
    if (adopted.ok) {
      adoptedIds.add(seat.logicalId);
      nodes.push({ logicalId: seat.logicalId, status: "resumed" });
    } else {
      nodes.push({
        logicalId: seat.logicalId,
        status: "failed",
        error: `无法 adopt surviving session "${seat.sessionName}"：${adopted.message ?? adopted.code ?? "未知错误"}`,
      });
    }
  }
  if (adoptedIds.size === 0) {
    // stamped mis-probe analysis：对 dead 工作组 probe 得到 LIVE → adopt 为空失败（诚实）。adoption
    // 刚证明没有 surviving session 后，绝不继续在该工作组 launch——重跑时走 restore 路径。
    return {
      outcome: "not_attempted",
      reason: "probe 发现 live pane，但没有可 adopt 的 surviving session（pane 可能在 probe 与 adopt 之间退出）",
      remediation: "重新运行 fleet restore——真正 stopped 的工作组会走 snapshot-restore 路径",
      attention: attentionRowsFromNodes(rigId, nodes),
    };
  }
  const remaining = deps.listRigSeats(rigId).filter((id) => !adoptedIds.has(id));
  if (remaining.length > 0) {
    const subset = await deps.launchNodeSubset(rigId, remaining);
    if (subset.ok) {
      for (const n of subset.launched ?? []) nodes.push(n);
      for (const a of subset.alreadyRunning ?? []) {
        // r1 LOW：ADOPT 失败的 seat 仍可由 launcher 证明为 LIVE（它自行对照 tmux 分类 target）。
        // 该 seat 正在 RUNNING——移除 stale adopt-failure node，否则 triage 会将 running seat 点名为
        // “need”。
        const staleFailed = nodes.findIndex((n) => n.logicalId === a.logicalId && n.status === "failed");
        if (staleFailed >= 0) nodes.splice(staleFailed, 1);
        nodes.push({ logicalId: a.logicalId, status: "resumed" });
      }
      for (const f of subset.failedTargets ?? [])
        nodes.push({ logicalId: f.logicalId, status: "failed", error: `无法运行 resume verification：${f.reason}` });
      for (const h of subset.held ?? [])
        nodes.push({ logicalId: h.logicalId, status: "attention_required", attentionEvidence: `从 launch 保持 held——${h.reason}` });
    } else {
      // whole-subset refusal（如无可用 snapshot）会让每个 remaining seat 保持 unverified——每个 seat
      // 都获得具名 row；此处静默会再次造成 round-10 gap。
      for (const id of remaining)
        nodes.push({ logicalId: id, status: "failed", error: `per-seat resume verification 不可用：${subset.message ?? subset.code ?? "launch subset 失败"}` });
    }
  }
  const attention = attentionRowsFromNodes(rigId, nodes);
  // 按 amendment 的 R6 closed union：所有 seat re-attached+verified → fully_restored；部分
  // non-resumable → partially_restored（其精确 need 随 triage row 传递）。adoptedIds.size > 0
  // 保证此处至少有一个 OK seat。
  return attention.length === 0
    ? { outcome: "fully_restored", attention }
    : { outcome: "partially_restored", attention };
}

/** 构建默认 `restoreRig` 依赖：组合 findLatestRestoreUsable → restore → rigResult。无可用
 *  snapshot 的工作组为 `not_attempted`（不运行 restore）；restore 直接失败则为 `failed`。绝不重新
 *  实现 restore logic。接入 `adoptDeps`（Amendment 2）时，pane 存活的工作组走上方 ADOPT 分支；
 *  dead pane（以及无 adoptDeps 的 caller）保持原路径。 */
export function createDefaultRestoreRig(
  _deps: RestoreRigDeps,
  adoptDeps?: AdoptRigDeps,
): (rigId: string) => Promise<{ outcome: PerRigOutcome; receiptRef?: number; attention?: AttentionRow[]; reason?: string; remediation?: string }> {
  return async (rigId) => {
    if (adoptDeps) {
      const live = await adoptDeps.probeLiveSessions(rigId);
      // Adopt 没有 restore-attempt receipt：其 ledger lineage 是已交付 adopt 按 seat 发出的
      // node.reconciled 事件。
      if (live.length > 0) return adoptLivePanesRig(rigId, live, adoptDeps);
    }
    const selected = _deps.selectRestoreUsable?.(rigId);
    const snapshot = selected?.ok ? selected.snapshot : _deps.findLatestRestoreUsable(rigId);
    if (!snapshot)
      // 无可用 snapshot——绝不静默替代；R3：携带原因与修复方法。
      return {
        outcome: "not_attempted",
        reason: "此工作组没有可用于 restore 的 snapshot",
        remediation: `创建 snapshot（zrig snapshot ${rigId}），或将现有 snapshot 标记为 restore-usable`,
      };
    let receiptRef: number | undefined;
    const outcome = await _deps.restore(snapshot.id, {
      ...(selected?.ok ? { snapshotSelection: selected.selection } : {}),
      onAttemptStarted: (attemptId) => {
        receiptRef = attemptId;
      },
    });
    // ok:true → result.rigResult；带 result 的 ok:false（如 pre-restore validation fail →
    // `not_attempted`）→ 其 rigResult；无 result 的 ok:false（hard failure：snapshot/rig not found、
    // 工作组未停止、恢复进行中）→ `failed`。
    const outcomeResult: PerRigOutcome = outcome.result?.rigResult ?? "failed";
    // 需要 operator action 的工作组 seat triage row（来自 restore result node）——已交付的 per-rig
    // attention，在 fleet layer 取并集。
    const attention = outcome.result?.nodes ? attentionRowsFromNodes(rigId, outcome.result.nodes) : [];
    return { outcome: outcomeResult, receiptRef, attention };
  };
}

export interface RigOrderDeps {
  /** 此 host 上所有未 archived 的工作组——conductor 的 fleet scope，v1。 */
  listRigs: () => Array<{ id: string; name: string }>;
}

/** R2——founder 指定的顺序：先恢复 KERNEL 工作组（supervisor，名为 "kernel"），再按 listRigs
 *  顺序恢复其余工作组。无 kernel 工作组 → 返回所有工作组，且均不标记 kernel（诚实，绝不伪造）。
 *  这是 conductor 使用的 `listRigsInOrder` source。 */
export function listRigsInKernelFirstOrder(
  deps: RigOrderDeps,
): Array<{ rigId: string; isKernel: boolean }> {
  const all = deps.listRigs();
  const kernel = all.filter((r) => r.name === "kernel");
  const rest = all.filter((r) => r.name !== "kernel");
  return [...kernel, ...rest].map((r) => ({ rigId: r.id, isKernel: r.name === "kernel" }));
}

// ── Atom C——舰队汇总（纯聚合，架构裁定 Q2）────────────────────────────────

/** triage row：seat + 其准确 need（picker/auth/remediation），来自已交付 per-rig restore-check
 *  attention projection。fleet `attention_required` 是这些 row 在工作组间的并集——是 VIEW，
 *  不是 parallel record。 */
export interface AttentionRow {
  rigId: string;
  seat: string;
  need: string;
}

/** Fleet rollup——对 conductor per-rig sequence 的纯聚合。per-rig outcome 保持已交付 CLOSED union
 *  （绝不扩宽）。此处不存储 fleet verdict——存储的 verdict 可能偏离 per-rig truth；通过
 *  {@link deriveFleetVerdict} 按需派生。`not_attempted` 是一等状态（绝不折叠为 failed）。 */
export interface FleetRollup {
  counts: Record<PerRigOutcome, number>;
  sequence: ConductorRigResult[];
  attention_required: AttentionRow[];
}

/** fleet verdict 是 counts 的派生函数——绝不是存储字段。 */
export type FleetVerdict = "all_fully_restored" | "all_failed" | "none_attempted" | "mixed";

/** restore node（已交付 RestoreNodeResult 的结构子集）——足以为需要 operator action 的 seat 构建
 *  分诊行。 */
export interface RestoreNodeLite {
  logicalId: string;
  status: string;
  error?: string;
  attentionEvidence?: string | null;
}

/** R5——将工作组 restore node 映射为 triage row：需要 operator action 的 seat（live runtime
 *  prompt、无法 resume 的 session 或 hard failure），每项都携带精确 need。排除 running/resumed
 *  node。绝不虚构 need。 */
export function attentionRowsFromNodes(rigId: string, nodes: RestoreNodeLite[]): AttentionRow[] {
  const rows: AttentionRow[] = [];
  for (const n of nodes) {
    if (n.status === "attention_required") {
      rows.push({
        rigId,
        seat: n.logicalId,
        need: n.attentionEvidence
          ? `live runtime prompt——${n.attentionEvidence}`
          : "live runtime prompt（resume selection / auth）——需要 operator",
      });
    } else if (n.status === "awaiting-decision") {
      // BLOCKER 3——保留已交付 orchestrator 的精确 error/remediation（含具体
      // `--fresh <logicalId>` command 与原因）；仅在 node 未携带时回退到通用句。抵达 operator 的
      // 精确 need 就是该 door 的“seat + exact need”验收条件。
      rows.push({
        rigId,
        seat: n.logicalId,
        need: n.error ? n.error : "原始 session 无法 resume 且未指定 --fresh——请选择 fresh-prime 或跳过",
      });
    } else if (n.status === "failed") {
      rows.push({ rigId, seat: n.logicalId, need: n.error ? `restore 失败：${n.error}` : "restore 失败" });
    }
  }
  return rows;
}

export function aggregateFleetRollup(sequence: ConductorRigResult[]): FleetRollup {
  // 初始化全部四个 closed-union key——`not_attempted` 是一等状态，绝不缺失，也绝不折叠为 `failed`。
  const counts: Record<PerRigOutcome, number> = {
    fully_restored: 0,
    partially_restored: 0,
    failed: 0,
    not_attempted: 0,
  };
  for (const r of sequence) counts[r.outcome] += 1;
  // attention_required = sequence 携带的 per-rig triage row 并集（view）。
  const attention_required = sequence.flatMap((r) => r.attention ?? []);
  return { counts, sequence, attention_required };
}

/** 派生 f(counts)——计算而不存储（存储的 verdict 可能发生 drift）。 */
export function deriveFleetVerdict(counts: Record<PerRigOutcome, number>): FleetVerdict {
  const total = counts.fully_restored + counts.partially_restored + counts.failed + counts.not_attempted;
  if (total === 0 || counts.not_attempted === total) return "none_attempted";
  if (counts.fully_restored === total) return "all_fully_restored";
  if (counts.failed === total) return "all_failed";
  return "mixed";
}
