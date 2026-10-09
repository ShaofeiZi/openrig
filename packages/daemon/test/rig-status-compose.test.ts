import { describe, it, expect } from "vitest";
import { composeRigStatus, type SeatLifecycleInput } from "../src/domain/rig-status-compose.js";
import type { RestorePlanPreview, RestorePlanPreviewNode } from "../src/domain/restore-plan-preview.js";
import type { RecoveryPlan } from "../src/domain/restore-check-service.js";

function planNode(over: Partial<RestorePlanPreviewNode> & { logicalId: string }): RestorePlanPreviewNode {
  return {
    intendedAction: "resume-original",
    tokenState: "present",
    freshRequired: false,
    ...over,
  };
}

function plan(nodes: RestorePlanPreviewNode[]): RestorePlanPreview {
  return {
    status: "plan",
    mode: "restore",
    rigId: "rig1",
    rigName: "r1",
    snapshot: null,
    wouldCaptureCurrentState: true,
    nodes,
    mutated: false,
  };
}

function seat(logicalId: string, lifecycleState: SeatLifecycleInput["lifecycleState"], runtime = "claude-code"): SeatLifecycleInput {
  return { logicalId, runtime, lifecycleState };
}

describe("composeRigStatus——per-seat truth 的纯 fold（锁定原则）", () => {
  it("关键场景：2 个 resumable + 3 个 blocked seat → aggregate blocked；resumable seat 保持 resume-original；不修改 input plan", () => {
    const inputPlan = plan([
      planNode({ logicalId: "a", intendedAction: "resume-original", tokenState: "present" }),
      planNode({ logicalId: "b", intendedAction: "resume-original", tokenState: "present" }),
      planNode({ logicalId: "c", intendedAction: "awaiting-decision", tokenState: "missing", freshRequired: true }),
      planNode({ logicalId: "d", intendedAction: "awaiting-decision", tokenState: "missing", freshRequired: true }),
      planNode({ logicalId: "e", intendedAction: "awaiting-decision", tokenState: "missing", freshRequired: true }),
    ]);
    const snapshotBefore = JSON.stringify(inputPlan.nodes);

    const out = composeRigStatus({
      rigId: "rig1",
      rigName: "r1",
      nodes: [
        seat("a", "recoverable"),
        seat("b", "recoverable"),
        seat("c", "recoverable"),
        seat("d", "recoverable"),
        seat("e", "recoverable"),
      ],
      plan: inputPlan,
    });

    // aggregate 因 seat 被阻塞而 blocked。
    expect(out.status).toBe("blocked");
    // 2 个 resumable seat 在 per-seat table 中保持 resume-original（无 global-fresh flip）。
    const a = out.perSeat.find((s) => s.logicalId === "a")!;
    const b = out.perSeat.find((s) => s.logicalId === "b")!;
    expect(a.intendedAction).toBe("resume-original");
    expect(b.intendedAction).toBe("resume-original");
    expect(a.blocked).toBe(false);
    expect(b.blocked).toBe(false);
    // 3 个 blocked seat 以 awaiting-decision blocker 呈现。
    expect(out.perSeat.filter((s) => s.blocked)).toHaveLength(3);
    // blocked rig 无法在没有 operator action 时恢复。
    expect(out.recoverable).toBe(false);
    // 没有代码路径将任何 seat 设为 fresh。
    expect(out.perSeat.some((s) => s.intendedAction === "fresh-primed")).toBe(false);
    // input plan 未被修改。
    expect(JSON.stringify(inputPlan.nodes)).toBe(snapshotBefore);
  });

  it("所有 seat 运行中 → up（组合得出，带 src provenance 行）", () => {
    const out = composeRigStatus({
      rigId: "rig1",
      rigName: "r1",
      nodes: [seat("a", "running"), seat("b", "running")],
      plan: plan([planNode({ logicalId: "a" }), planNode({ logicalId: "b" })]),
    });
    expect(out.status).toBe("up");
    expect(out.seatsRunning).toBe(2);
    expect(out.seatsTotal).toBe(2);
    // 组合而非推断——src 点名已折叠 signal 及其值。
    expect(out.src.some((s) => s.startsWith("ps: 2/2 运行中"))).toBe(true);
    expect(out.src.some((s) => s.startsWith("restore-plan:"))).toBe(true);
  });

  it("混合 running + stopped → partial（可恢复）", () => {
    const out = composeRigStatus({
      rigId: "rig1",
      rigName: "r1",
      nodes: [seat("a", "running"), seat("b", "detached")],
      plan: plan([planNode({ logicalId: "a" }), planNode({ logicalId: "b" })]),
    });
    expect(out.status).toBe("partial");
    expect(out.recoverable).toBe(true);
  });

  it("没有 seat 运行且全部可恢复 → down（可恢复）", () => {
    const out = composeRigStatus({
      rigId: "rig1",
      rigName: "r1",
      nodes: [seat("a", "recoverable"), seat("b", "recoverable")],
      plan: plan([planNode({ logicalId: "a" }), planNode({ logicalId: "b" })]),
    });
    expect(out.status).toBe("down");
    expect(out.recoverable).toBe(true);
  });

  it("restore-original 诚实性：有 recorded source 但缺 token 的 seat → awaiting-decision（blocked），其他 seat 独立 resume-original", () => {
    const out = composeRigStatus({
      rigId: "rig1",
      rigName: "r1",
      nodes: [seat("a", "recoverable"), seat("b", "recoverable")],
      plan: plan([
        planNode({ logicalId: "a", intendedAction: "resume-original", tokenState: "present" }),
        planNode({ logicalId: "b", intendedAction: "awaiting-decision", tokenState: "missing", freshRequired: true }),
      ]),
    });
    expect(out.status).toBe("blocked");
    expect(out.perSeat.find((s) => s.logicalId === "a")!.intendedAction).toBe("resume-original");
    expect(out.perSeat.find((s) => s.logicalId === "b")!.intendedAction).toBe("awaiting-decision");
  });

  it("stale-but-present token 与 missing 不同（FR-6），且本身不是 blocker", () => {
    const out = composeRigStatus({
      rigId: "rig1",
      rigName: "r1",
      nodes: [seat("a", "recoverable")],
      plan: plan([planNode({ logicalId: "a", intendedAction: "resume-original", tokenState: "stale" })]),
    });
    const a = out.perSeat[0]!;
    expect(a.tokenState).toBe("stale");
    expect(a.tokenState).not.toBe("missing");
    expect(a.blocked).toBe(false); // stale 可见，但不是 blocker
    expect(out.status).toBe("down");
  });

  it("即使 plan 本身无异常，restore-check blocked verdict 仍折叠为 aggregate blocked", () => {
    const recovery: RecoveryPlan = {
      status: "blocked",
      summary: "restore-input blockers remain",
      actions: [],
      blocked: [{ scope: "rig", rigId: "rig1", rigName: "r1", reason: "missing canonical identity" }],
      unknown: [],
    };
    const out = composeRigStatus({
      rigId: "rig1",
      rigName: "r1",
      nodes: [seat("a", "recoverable")],
      plan: plan([planNode({ logicalId: "a", intendedAction: "resume-original", tokenState: "present" })]),
      recovery,
    });
    // plan seat 无异常，但 restore-check 判定 blocked → 使用该 verdict，不默认判绿。
    expect(out.status).toBe("blocked");
    expect(out.src.some((s) => s === "restore-check: blocked")).toBe(true);
  });

  it("无 seat 被阻塞时，restore-check unknown → aggregate unknown（probe uncertainty）", () => {
    const recovery: RecoveryPlan = {
      status: "unknown",
      summary: "could not inspect",
      actions: [],
      blocked: [],
      unknown: [{ scope: "host", reason: "probe error" }],
    };
    const out = composeRigStatus({
      rigId: "rig1",
      rigName: "r1",
      nodes: [seat("a", "recoverable")],
      plan: plan([planNode({ logicalId: "a", intendedAction: "resume-original", tokenState: "present" })]),
      recovery,
    });
    expect(out.status).toBe("unknown");
  });

  it("kernel 工作组折叠 kernel-status（而非 /healthz）：auth_blocked → blocked；ready → up；degraded → partial", () => {
    const nodes = [seat("k", "running", "claude-code")];
    const p = plan([planNode({ logicalId: "k" })]);

    const blocked = composeRigStatus({ rigId: "rig1", rigName: "kernel", isKernel: true, nodes, plan: p, kernelState: "auth_blocked" });
    expect(blocked.status).toBe("blocked");
    expect(blocked.src.some((s) => s === "kernel-status.kernel_state=auth_blocked")).toBe(true);

    const up = composeRigStatus({ rigId: "rig1", rigName: "kernel", isKernel: true, nodes, plan: p, kernelState: "ready" });
    expect(up.status).toBe("up");

    const degraded = composeRigStatus({ rigId: "rig1", rigName: "kernel", isKernel: true, nodes, plan: p, kernelState: "degraded" });
    expect(degraded.status).toBe("partial");
  });
});
