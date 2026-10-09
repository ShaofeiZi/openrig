// B1 Atom B——crash-cart RESTORE CONDUCTOR core。针对三项 plan 行为的 RED-first pin：
// kernel-first 顺序（R2）、best-effort continue（R5）、stop-before-next-rig cancel（R8）。
// 注入 per-rig restore，使此单元无需完整 restore machinery 即可观察 ORDER / FAILURE / CANCEL
//（真实依赖包装 findLatestRestoreUsable + RestoreOrchestrator.restore；由 integration + door
// 测试验证）。
import { describe, it, expect } from "vitest";
import {
  RestoreConductor,
  createDefaultRestoreRig,
  listRigsInKernelFirstOrder,
  aggregateFleetRollup,
  deriveFleetVerdict,
  attentionRowsFromNodes,
  type PerRigOutcome,
  type ConductorRigResult,
} from "../src/domain/crash-cart-conductor.js";

// kernel 优先，其余随后——conductor 必须遵守 founder 指定的顺序。
const rigsInOrder = () => [
  { rigId: "kernel", isKernel: true },
  { rigId: "alpha", isKernel: false },
  { rigId: "beta", isKernel: false },
];

describe("RestoreConductor——Atom B core", () => {
  it("R2：按 kernel-first 顺序恢复工作组", async () => {
    const seen: string[] = [];
    const c = new RestoreConductor({
      listRigsInOrder: rigsInOrder,
      restoreRig: async (rigId) => {
        seen.push(rigId);
        return { outcome: "fully_restored" as PerRigOutcome };
      },
    });
    const results = await c.restoreFleet();
    expect(seen).toEqual(["kernel", "alpha", "beta"]);
    expect(results.map((r) => r.rigId)).toEqual(["kernel", "alpha", "beta"]);
    expect(results.every((r) => r.outcome === "fully_restored")).toBe(true);
  });

  it("R5：best-effort——一个工作组失败绝不停止 fleet；失败工作组为 `failed`", async () => {
    const attempted: string[] = [];
    const c = new RestoreConductor({
      listRigsInOrder: rigsInOrder,
      restoreRig: async (rigId) => {
        attempted.push(rigId);
        if (rigId === "alpha") throw new Error("resume blew up");
        return { outcome: "fully_restored" as PerRigOutcome };
      },
    });
    const results = await c.restoreFleet();
    // alpha 抛错后仍会尝试 beta
    expect(attempted).toEqual(["kernel", "alpha", "beta"]);
    expect(results.find((r) => r.rigId === "alpha")!.outcome).toBe("failed");
    expect(results.find((r) => r.rigId === "beta")!.outcome).toBe("fully_restored");
  });

  it("R8：stop-before-next-rig cancel——in-flight 工作组完成；后续工作组为 `not_attempted`", async () => {
    const attempted: string[] = [];
    let cancelled = false;
    const c = new RestoreConductor({
      listRigsInOrder: rigsInOrder,
      restoreRig: async (rigId) => {
        attempted.push(rigId);
        if (rigId === "kernel") cancelled = true; // kernel 恢复时 operator 取消
        return { outcome: "fully_restored" as PerRigOutcome };
      },
      isCancelled: () => cancelled,
    });
    const results = await c.restoreFleet();
    // kernel（in-flight）已完成；alpha/beta 从未启动
    expect(attempted).toEqual(["kernel"]);
    expect(results.find((r) => r.rigId === "kernel")!.outcome).toBe("fully_restored");
    const alpha = results.find((r) => r.rigId === "alpha")!;
    expect(alpha.outcome).toBe("not_attempted");
    // R3：因 cancel 跳过的工作组携带原因与修复方式（不留下空白 not_attempted）
    expect(alpha.reason).toMatch(/已取消/i);
    expect(alpha.remediation).toMatch(/重新运行/i);
    expect(results.find((r) => r.rigId === "beta")!.outcome).toBe("not_attempted");
  });

  it("为每个工作组携带 receiptRef（ledger lineage）", async () => {
    const c = new RestoreConductor({
      listRigsInOrder: () => [{ rigId: "kernel", isKernel: true }],
      restoreRig: async () => ({ outcome: "fully_restored" as PerRigOutcome, receiptRef: 4242 }),
    });
    const results = await c.restoreFleet();
    expect(results[0]!.receiptRef).toBe(4242);
  });

  it("r1-root：每个工作组完成时按顺序发出 onRigDone（progress stream）", async () => {
    const streamed: Array<{ rigId: string; outcome: PerRigOutcome }> = [];
    const c = new RestoreConductor({
      listRigsInOrder: rigsInOrder,
      restoreRig: async (rigId) => ({ outcome: (rigId === "alpha" ? "failed" : "fully_restored") as PerRigOutcome }),
    });
    const results = await c.restoreFleet({ onRigDone: (r) => streamed.push({ rigId: r.rigId, outcome: r.outcome }) });
    // 每个工作组完成时按 kernel-first 顺序 stream，且与最终 sequence 一致
    expect(streamed.map((r) => r.rigId)).toEqual(["kernel", "alpha", "beta"]);
    expect(streamed).toEqual(results.map((r) => ({ rigId: r.rigId, outcome: r.outcome })));
  });
});

describe("createDefaultRestoreRig——组合 findLatestRestoreUsable + restore（R3/R4）", () => {
  it("R3：无可用 snapshot → not_attempted，且绝不调用 restore（无静默替代）", async () => {
    let restoreCalled = false;
    const restoreRig = createDefaultRestoreRig({
      findLatestRestoreUsable: () => null,
      restore: async () => {
        restoreCalled = true;
        return { ok: true, result: { rigResult: "fully_restored" } };
      },
    });
    const r = await restoreRig("alpha");
    expect(r.outcome).toBe("not_attempted");
    expect(restoreCalled).toBe(false);
  });

  it("可用 snapshot → restore(snapshot.id)，并返回其 rigResult + attemptId receiptRef", async () => {
    let usedSnapshotId: string | undefined;
    const restoreRig = createDefaultRestoreRig({
      findLatestRestoreUsable: () => ({ id: "snap-7" }),
      restore: async (snapshotId, opts) => {
        usedSnapshotId = snapshotId;
        opts?.onAttemptStarted?.(99); // restore-started event seq
        return { ok: true, result: { rigResult: "partially_restored" } };
      },
    });
    const r = await restoreRig("alpha");
    expect(usedSnapshotId).toBe("snap-7");
    expect(r.outcome).toBe("partially_restored");
    expect(r.receiptRef).toBe(99);
  });

  it("将 automatic snapshot-selection evidence 传入 restore attempt", async () => {
    const selection = {
      snapshotId: "snap-ranked",
      kind: "auto-periodic",
      createdAt: "2026-09-04 18:00:00",
      ageMs: 60_000,
      mode: "automatic" as const,
      rationale: "自动崩溃保障排序优先选择 auto-pre-down/auto-periodic，其次选择最新可用快照",
      newerUsableAlternative: null,
    };
    let observed: typeof selection | undefined;
    const restoreRig = createDefaultRestoreRig({
      findLatestRestoreUsable: () => ({ id: "fallback" }),
      selectRestoreUsable: () => ({ ok: true, snapshot: { id: "snap-ranked" }, selection }),
      restore: async (_snapshotId, opts) => {
        observed = opts?.snapshotSelection;
        return { ok: true, result: { rigResult: "fully_restored" } };
      },
    });

    await restoreRig("alpha");

    expect(observed).toEqual(selection);
  });

  it("R3：无可用 snapshot → not_attempted 携带 reason + remediation（无空白 gap）", async () => {
    const restoreRig = createDefaultRestoreRig({
      findLatestRestoreUsable: () => null,
      restore: async () => ({ ok: true, result: { rigResult: "fully_restored" } }),
    });
    const r = await restoreRig("alpha");
    expect(r.outcome).toBe("not_attempted");
    expect(r.reason).toMatch(/没有可用于 restore 的 snapshot/i);
    expect(r.remediation).toContain("zrig snapshot alpha");
  });

  it("restore ok:false（无 result）→ failed", async () => {
    const restoreRig = createDefaultRestoreRig({
      findLatestRestoreUsable: () => ({ id: "snap-1" }),
      restore: async () => ({ ok: false }),
    });
    const r = await restoreRig("alpha");
    expect(r.outcome).toBe("failed");
  });

  it("从 restore result node 呈现 per-rig attention（triage row）", async () => {
    const restoreRig = createDefaultRestoreRig({
      findLatestRestoreUsable: () => ({ id: "snap-x" }),
      restore: async () => ({
        ok: true,
        result: {
          rigResult: "partially_restored",
          nodes: [
            { logicalId: "dev.guard", status: "attention_required", attentionEvidence: "pick a conversation" },
            { logicalId: "dev.driver", status: "resumed" },
          ],
        },
      }),
    });
    const r = await restoreRig("myrig");
    expect(r.attention).toEqual([
      { rigId: "myrig", seat: "dev.guard", need: "live runtime prompt——pick a conversation" },
    ]);
  });
});

// ── AMENDMENT 2（stamped，body hash 72757e81）——surviving-panes ADOPT 分支 ─────────
// round-10 door：daemon 被终止、pane 仍存活 → restore() fail-close 为 409 → fleet 读取 "failed"，
// non-resumable seat 从未进入 triage。amendment 只批准一项变更：每个工作组的 live pane 组合已交付
// reconcile/adopt + per-seat resume verification；dead pane 逐字不变地走现有 restore 路径。union
// 保持 CLOSED（四个 member），adoption 只触碰 session state（R9）。
describe("AMENDMENT 2——createDefaultRestoreRig 中的 per-rig LIVE/DEAD-panes 分支", () => {
  // 已交付 restore 的 409 形态：live-panes 工作组以无 result 的方式 fail-close——正是 conductor
  // 在 round 10 读成 `failed` 的结果。
  const restore409 = async () => ({ ok: false as const });
  const restoreDeps = () => ({
    findLatestRestoreUsable: () => ({ id: "snap-1" }),
    restore: restore409,
  });

  it("关键门槛（unit 形态）：当前返回 409 的 live-panes 工作组必须 ADOPT——绝不调用 restore，outcome 不是 failed", async () => {
    let restoreCalled = false;
    const restoreRig = createDefaultRestoreRig(
      {
        findLatestRestoreUsable: () => ({ id: "snap-1" }),
        restore: async () => { restoreCalled = true; return { ok: false }; },
      },
      {
        probeLiveSessions: async () => [
          { sessionName: "dev-planner@r", logicalId: "dev.planner" },
          { sessionName: "dev-driver@r", logicalId: "dev.driver" },
        ],
        reconcileSession: async () => ({ ok: true }),
        listRigSeats: () => ["dev.planner", "dev.driver"],
        launchNodeSubset: async () => { throw new Error("no remaining seats — must not be called"); },
      },
    );
    const r = await restoreRig("rig-1");
    expect(restoreCalled).toBe(false); // adopt 分支，绝不会返回 409
    expect(r.outcome).toBe("fully_restored"); // 所有 seat 已重新 attach
    expect(r.attention ?? []).toEqual([]);
  });

  it("部分 seat 已 adopt + 设计为不可 resume 的 seat 以其精确 --fresh 行进入 triage → partially_restored", async () => {
    const subsetCalls: string[][] = [];
    const restoreRig = createDefaultRestoreRig(restoreDeps(), {
      probeLiveSessions: async () => [{ sessionName: "dev-planner@r", logicalId: "dev.planner" }],
      reconcileSession: async () => ({ ok: true }),
      listRigSeats: () => ["dev.planner", "dev.qa"],
      launchNodeSubset: async (_rigId, ids) => {
        subsetCalls.push(ids);
        return {
          ok: true,
          launched: [{
            logicalId: "dev.qa",
            status: "awaiting-decision",
            error: "Original session not resumable. Use --fresh dev.qa to fresh-prime, or skip.",
          }],
        };
      },
    });
    const r = await restoreRig("rig-1");
    expect(subsetCalls).toEqual([["dev.qa"]]); // 只验证未 adopt seat
    expect(r.outcome).toBe("partially_restored");
    expect(r.attention).toEqual([
      { rigId: "rig-1", seat: "dev.qa", need: "Original session not resumable. Use --fresh dev.qa to fresh-prime, or skip." },
    ]);
  });

  it("误 probe（probe 为 LIVE，但 pane 在 adopt 前退出）：所有 adoption 失败 → 带 reason+remediation 的 not_attempted；绝不到达 subset launcher", async () => {
    let subsetCalled = false;
    const restoreRig = createDefaultRestoreRig(restoreDeps(), {
      probeLiveSessions: async () => [{ sessionName: "dev-planner@r", logicalId: "dev.planner" }],
      reconcileSession: async () => ({ ok: false, code: "session_not_found", message: "No live tmux session" }),
      listRigSeats: () => ["dev.planner", "dev.qa"],
      launchNodeSubset: async () => { subsetCalled = true; return { ok: true, launched: [] }; },
    });
    const r = await restoreRig("rig-1");
    expect(r.outcome).toBe("not_attempted"); // adopt 为空失败（诚实）——stamped mis-probe analysis
    expect(subsetCalled).toBe(false);
    expect(r.reason).toBeTruthy();
    expect(r.remediation).toBeTruthy();
  });

  it("DEAD pane（probe 为空）：现有 restore composition 原样运行", async () => {
    let restored: string | null = null;
    const restoreRig = createDefaultRestoreRig(
      {
        findLatestRestoreUsable: () => ({ id: "snap-9" }),
        restore: async (snapshotId) => { restored = snapshotId; return { ok: true, result: { rigResult: "fully_restored" } }; },
      },
      {
        probeLiveSessions: async () => [],
        reconcileSession: async () => { throw new Error("must not adopt a dead rig"); },
        listRigSeats: () => [],
        launchNodeSubset: async () => { throw new Error("must not launch on the dead path"); },
      },
    );
    const r = await restoreRig("rig-1");
    expect(restored).toBe("snap-9");
    expect(r.outcome).toBe("fully_restored");
  });

  it("未接入 adopt deps（当前 caller）：行为与现有 composition 逐字一致", async () => {
    const restoreRig = createDefaultRestoreRig(restoreDeps());
    const r = await restoreRig("rig-1");
    expect(r.outcome).toBe("failed"); // amendment 前对 409 的解读——无 adopt deps 时不变
  });

  it("subset launcher 拒绝（如无可用 snapshot）+ failed target 显著 fold：每个未验证 seat 都有 row，outcome 为 partially_restored", async () => {
    const restoreRig = createDefaultRestoreRig(restoreDeps(), {
      probeLiveSessions: async () => [{ sessionName: "dev-planner@r", logicalId: "dev.planner" }],
      reconcileSession: async () => ({ ok: true }),
      listRigSeats: () => ["dev.planner", "dev.qa", "dev.guard"],
      launchNodeSubset: async () => ({ ok: false, code: "no_usable_snapshot", message: "No usable snapshot for rig rig-1" }),
    });
    const r = await restoreRig("rig-1");
    expect(r.outcome).toBe("partially_restored"); // adopted seat 真实存在；未验证 seat 均被点名
    const seats = (r.attention ?? []).map((a) => a.seat).sort();
    expect(seats).toEqual(["dev.guard", "dev.qa"]);
    for (const row of r.attention ?? []) expect(row.need).toContain("No usable snapshot");
  });

  it("r1 LOW：launcher 证明 alreadyRunning 的 adopt-FAILED seat 就是 RUNNING——丢弃 stale failed node，triage 绝不点名 running seat", async () => {
    const restoreRig = createDefaultRestoreRig(restoreDeps(), {
      probeLiveSessions: async () => [
        { sessionName: "dev-planner@r", logicalId: "dev.planner" },
        { sessionName: "dev-qa@r", logicalId: "dev.qa" },
      ],
      // dev.qa 的 adopt 暂时出错——但其 pane 确实 live，已交付 launcher 随后证明这一点
      //（alreadyRunning）。该 seat 正在运行；triage 不得将 stale adopt-failure 作为“exact need”。
      reconcileSession: async (name) =>
        name === "dev-qa@r" ? { ok: false, code: "reconcile_error", message: "transient" } : { ok: true },
      listRigSeats: () => ["dev.planner", "dev.qa"],
      launchNodeSubset: async (_rigId, ids) => {
        expect(ids).toEqual(["dev.qa"]); // the adopt-failed seat reaches verification
        return { ok: true, launched: [], alreadyRunning: [{ logicalId: "dev.qa" }] };
      },
    });
    const r = await restoreRig("rig-1");
    expect(r.attention ?? []).toEqual([]); // no triage row for a seat that is RUNNING
    expect(r.outcome).toBe("fully_restored");
  });

  it("held + failed subset target 成为 triage row（绝不静默）；outcome 保持在 CLOSED union 中", async () => {
    const restoreRig = createDefaultRestoreRig(restoreDeps(), {
      probeLiveSessions: async () => [{ sessionName: "dev-planner@r", logicalId: "dev.planner" }],
      reconcileSession: async () => ({ ok: true }),
      listRigSeats: () => ["dev.planner", "dev.qa", "dev.guard"],
      launchNodeSubset: async () => ({
        ok: true,
        launched: [],
        held: [{ logicalId: "dev.qa", reason: "operator hold" }],
        failedTargets: [{ logicalId: "dev.guard", reason: "tmux probe failed (fail-closed)" }],
      }),
    });
    const r = await restoreRig("rig-1");
    expect(r.outcome).toBe("partially_restored");
    const bySeat = Object.fromEntries((r.attention ?? []).map((a) => [a.seat, a.need]));
    expect(bySeat["dev.qa"]).toContain("held");
    expect(bySeat["dev.guard"]).toContain("tmux probe failed");
    expect(["fully_restored", "partially_restored", "failed", "not_attempted"]).toContain(r.outcome);
  });
});

describe("listRigsInKernelFirstOrder（R2——kernel supervisor 优先）", () => {
  it("先放 kernel 工作组，再按 listRigs 顺序放其余工作组", () => {
    const ordered = listRigsInKernelFirstOrder({
      listRigs: () => [
        { id: "r-alpha", name: "alpha" },
        { id: "r-kernel", name: "kernel" },
        { id: "r-beta", name: "beta" },
      ],
    });
    expect(ordered.map((r) => r.rigId)).toEqual(["r-kernel", "r-alpha", "r-beta"]);
    expect(ordered[0]!.isKernel).toBe(true);
    expect(ordered.slice(1).every((r) => !r.isKernel)).toBe(true);
  });

  it("无 kernel 工作组 → 返回所有工作组，且均不标记 kernel（诚实，不伪造）", () => {
    const ordered = listRigsInKernelFirstOrder({ listRigs: () => [{ id: "r-a", name: "a" }] });
    expect(ordered).toEqual([{ rigId: "r-a", isKernel: false }]);
  });
});

describe("aggregateFleetRollup + deriveFleetVerdict（R6 / ARCH-RULING Q2——纯 aggregation）", () => {
  const seq: ConductorRigResult[] = [
    { rigId: "kernel", outcome: "fully_restored", receiptRef: 1 },
    { rigId: "alpha", outcome: "failed" },
    { rigId: "beta", outcome: "not_attempted" },
    { rigId: "gamma", outcome: "partially_restored", receiptRef: 4 },
  ];

  it("按 CLOSED union 计数；not_attempted 是一等状态（绝不折叠为 failed）", () => {
    const rollup = aggregateFleetRollup(seq);
    expect(rollup.counts).toEqual({ fully_restored: 1, partially_restored: 1, failed: 1, not_attempted: 1 });
  });

  it("sequence 是携带 receiptRef 的 view；rollup 不存储 verdict 字段", () => {
    const rollup = aggregateFleetRollup(seq);
    expect(rollup.sequence).toBe(seq);
    expect(rollup.sequence.find((r) => r.rigId === "kernel")!.receiptRef).toBe(1);
    expect((rollup as Record<string, unknown>)["verdict"]).toBeUndefined(); // verdict 是派生值，不存储
  });

  it("attention_required 是 sequence 所携带 per-rig triage row 的并集", () => {
    const seqWithAttention: ConductorRigResult[] = [
      { rigId: "kernel", outcome: "fully_restored" },
      { rigId: "alpha", outcome: "failed", attention: [{ rigId: "alpha", seat: "dev.driver", need: "codex auth" }] },
      { rigId: "beta", outcome: "not_attempted" },
    ];
    expect(aggregateFleetRollup(seqWithAttention).attention_required).toEqual([
      { rigId: "alpha", seat: "dev.driver", need: "codex auth" },
    ]);
    expect(aggregateFleetRollup(seq).attention_required).toEqual([]); // 无 per-rig attention → 空
  });

  it("deriveFleetVerdict 是 f(counts)：全成功→all_fully_restored，全失败→all_failed，全未尝试→none_attempted，混合→mixed", () => {
    expect(deriveFleetVerdict({ fully_restored: 3, partially_restored: 0, failed: 0, not_attempted: 0 })).toBe("all_fully_restored");
    expect(deriveFleetVerdict({ fully_restored: 0, partially_restored: 0, failed: 2, not_attempted: 0 })).toBe("all_failed");
    expect(deriveFleetVerdict({ fully_restored: 0, partially_restored: 0, failed: 0, not_attempted: 2 })).toBe("none_attempted");
    expect(deriveFleetVerdict(aggregateFleetRollup(seq).counts)).toBe("mixed");
    expect(deriveFleetVerdict({ fully_restored: 0, partially_restored: 0, failed: 0, not_attempted: 0 })).toBe("none_attempted");
  });
});

describe("attentionRowsFromNodes（R5——triage：seat + exact need）", () => {
  it("将 attention_required / awaiting-decision / failed node 映射为 triage row；排除 running node", () => {
    const rows = attentionRowsFromNodes("kernel", [
      { logicalId: "dev.driver", status: "resumed" }, // running——无 triage
      { logicalId: "dev.guard", status: "attention_required", attentionEvidence: "select a conversation to resume" },
      { logicalId: "dev.qa", status: "awaiting-decision" },
      { logicalId: "orch.lead", status: "failed", error: "spawn ENOENT" },
    ]);
    expect(rows.map((r) => r.seat)).toEqual(["dev.guard", "dev.qa", "orch.lead"]);
    expect(rows.find((r) => r.seat === "dev.guard")!.need).toContain("select a conversation");
    expect(rows.find((r) => r.seat === "dev.qa")!.need).toContain("请选择");
    expect(rows.find((r) => r.seat === "orch.lead")!.need).toContain("spawn ENOENT");
    expect(rows.every((r) => r.rigId === "kernel")).toBe(true);
  });

  it("BLOCKER 3：awaiting-decision 保留精确 node error/remediation（--fresh command），而非泛化句子", () => {
    const exact = "session for dev.qa not resumable (resume_token expired); run: rig restore snap-7 --fresh dev.qa — or skip this seat";
    const rows = attentionRowsFromNodes("myrig", [{ logicalId: "dev.qa", status: "awaiting-decision", error: exact }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.need).toBe(exact); // 精确 evidence 到达 operator（door acceptance sentence）
    expect(rows[0]!.need).toContain("--fresh dev.qa");
  });

  it("无 node error 的 awaiting-decision 回退到通用句子（绝不为空）", () => {
    const rows = attentionRowsFromNodes("r", [{ logicalId: "dev.x", status: "awaiting-decision" }]);
    expect(rows[0]!.need).toContain("请选择 fresh-prime 或跳过");
  });

  it("无需要 attention 的 node → 空（绝不伪造）", () => {
    expect(attentionRowsFromNodes("r", [{ logicalId: "a", status: "resumed" }, { logicalId: "b", status: "fresh-primed" }])).toEqual([]);
  });
});
