import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { deriveRestoreAttemptReceipt } from "../src/domain/restore-attempt-receipt.js";

describe("deriveRestoreAttemptReceipt", () => {
  let db: Database.Database;
  let events: EventBus;

  beforeEach(() => {
    db = createFullTestDb();
    events = new EventBus(db);
  });

  afterEach(() => db.close());

  it("派生操作者已完成的预期集合事实时保留原始部分结果", () => {
    const started = events.emit({
      type: "restore.started",
      rigId: "rig-1",
      snapshotId: "snap-manual",
      snapshotSelection: {
        snapshotId: "snap-manual",
        kind: "manual",
        createdAt: "2026-09-04 00:00:00",
        ageMs: 1000,
        mode: "explicit",
        rationale: "操作者选择了这个确切且可用于恢复的快照",
        newerUsableAlternative: null,
      },
      intendedRoster: [
        { nodeId: "n1", logicalId: "lead" },
        { nodeId: "n2", logicalId: "worker" },
      ],
      excludedNodes: [{ nodeId: "old", logicalId: "historical", reason: "historical_not_in_intended_roster" }],
    });
    events.emit({
      type: "restore.completed",
      rigId: "rig-1",
      snapshotId: "snap-manual",
      result: {
        snapshotId: "snap-manual",
        preRestoreSnapshotId: "pre",
        rigResult: "partially_restored",
        nodes: [
          { nodeId: "n1", logicalId: "lead", status: "resumed" },
          { nodeId: "n2", logicalId: "worker", status: "attention_required" },
        ],
        warnings: [],
      },
    });
    events.emit({
      type: "restore.outcome_reconciled",
      rigId: "rig-1",
      nodeId: "n2",
      attemptId: started.seq,
      from: "attention_required",
      to: "operator_recovered",
      evidence: { tmux: true, fgProcess: "codex", resumeTokenUsed: true, paneState: "usable" },
    });

    const receipt = deriveRestoreAttemptReceipt(db, "rig-1", started.seq);

    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.originalResult.rigResult).toBe("partially_restored");
    expect(receipt.originalResult.nodes[1]!.status).toBe("attention_required");
    expect(receipt.reconciliations).toHaveLength(1);
    expect(receipt.currentNodes[1]!.status).toBe("operator_recovered");
    expect(receipt.unresolvedIntendedSeats).toEqual([]);
    expect(receipt.currentIntendedSetVerdict).toBe("fully_restored");
    expect(receipt.excludedNodes).toEqual([expect.objectContaining({ logicalId: "historical" })]);
  });

  it("不允许后续尝试为本次尝试提供完成结果", () => {
    const first = events.emit({ type: "restore.started", rigId: "rig-1", snapshotId: "s1" });
    events.emit({ type: "restore.started", rigId: "rig-1", snapshotId: "s2" });
    events.emit({
      type: "restore.completed",
      rigId: "rig-1",
      snapshotId: "s2",
      result: { snapshotId: "s2", preRestoreSnapshotId: null, rigResult: "fully_restored", nodes: [], warnings: [] },
    });

    expect(deriveRestoreAttemptReceipt(db, "rig-1", first.seq)).toMatchObject({ ok: false, code: "attempt_incomplete" });
  });

  it("让没有节点结果的预期 seat 保持可见并标记为未解决", () => {
    const started = events.emit({
      type: "restore.started",
      rigId: "rig-1",
      snapshotId: "s1",
      intendedRoster: [{ nodeId: "n1", logicalId: "lead" }],
    });
    events.emit({
      type: "restore.completed",
      rigId: "rig-1",
      snapshotId: "s1",
      result: { snapshotId: "s1", preRestoreSnapshotId: null, rigResult: "fully_restored", nodes: [], warnings: [] },
    });

    const receipt = deriveRestoreAttemptReceipt(db, "rig-1", started.seq);

    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.currentIntendedSetVerdict).toBe("failed");
    expect(receipt.unresolvedIntendedSeats).toEqual([
      expect.objectContaining({ nodeId: "n1", logicalId: "lead", status: "failed" }),
    ]);
  });
});
