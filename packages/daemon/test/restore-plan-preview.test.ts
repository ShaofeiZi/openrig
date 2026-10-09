import { describe, it, expect } from "vitest";
import { buildRestorePlanPreview, collectPreviewSessionRows, type PreviewSessionRow } from "../src/domain/restore-plan-preview.js";
import type { RigWithRelations, Snapshot } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";

// OPR.0.4.3.20 FR-6——恢复计划的逐席位 token 状态（只读预测）。

function rigWith(nodes: Array<{ id: string; logicalId: string; runtime: string | null }>): RigWithRelations {
  return {
    rig: { id: "rig-1", name: "test-rig" },
    nodes: nodes.map((n) => ({ id: n.id, logicalId: n.logicalId, runtime: n.runtime })),
    edges: [],
  } as unknown as RigWithRelations;
}

function row(nodeId: string, over: Partial<PreviewSessionRow> = {}): PreviewSessionRow {
  return {
    nodeId,
    id: "s-" + nodeId,
    restorePolicy: "resume_if_possible",
    resumeType: "claude_id",
    resumeToken: "tok",
    resumeProvenance: "adoption",
    resumeLastVerified: null,
    resumeLastProbeStatus: null,
    status: "running",
    ...over,
  };
}

const NOW = Date.parse("2026-07-02T12:00:00Z");
const FRESH = "2026-07-02 11:59:00"; // 1 min ago (< 1h threshold)
const OLD = "2026-07-02 10:00:00";   // 2h ago (> 1h threshold)

describe("FR-6 恢复计划 token 状态", () => {
  it("将从未被占用的当前席位显示为新席位，且不显示历史警告", () => {
    const rig = rigWith([{ id: "n1", logicalId: "a", runtime: "codex" }]);
    const result = buildRestorePlanPreview(rig, null, []).nodes[0]!;
    expect(result).toMatchObject({ hasHistory: false, intendedAction: "fresh-primed" });
    expect(result.reason).toBeUndefined();
  });
  it("显式快照占用者状态优先于旧关系", () => {
    const rig = rigWith([{ id: "n1", logicalId: "a", runtime: "claude-code" }]);
    const rows = [row("n1")];
    const snapshot = { id: "snap", kind: "manual", createdAt: "now", data: {
      sessions: rows, activeSessionIdByNode: { n1: "s-n1" },
      activeOccupantsByNode: { n1: { kind: "ambiguous", candidateIds: ["s-n1", "other"] } },
    } } as unknown as Snapshot;
    const result = buildRestorePlanPreview(rig, snapshot, rows).nodes[0]!;
    expect(result.intendedAction).toBe("awaiting-decision");
    expect(result.freshRequired).toBe(false);
    expect(result.reason).toContain("多个存活占用者候选");
  });
  it("missing：无 token → freshRequired，需要 --fresh", () => {
    const rig = rigWith([{ id: "n1", logicalId: "a", runtime: "claude-code" }]);
    const p = buildRestorePlanPreview(rig, null, [row("n1", { resumeToken: null, resumeType: null, resumeProvenance: null })], undefined, NOW);
    expect(p.nodes[0]!.tokenState).toBe("missing");
    expect(p.nodes[0]!.freshRequired).toBe(true);
    expect(p.mutated).toBe(false);
  });

  it("unverified：token 存在但从未探测", () => {
    const rig = rigWith([{ id: "n1", logicalId: "a", runtime: "claude-code" }]);
    const p = buildRestorePlanPreview(rig, null, [row("n1", { resumeLastVerified: null, resumeLastProbeStatus: null })], undefined, NOW);
    expect(p.nodes[0]!.tokenState).toBe("unverified");
    expect(p.nodes[0]!.freshRequired).toBe(false);
  });

  it("present：探测结果可恢复，且在新鲜度阈值内通过验证", () => {
    const rig = rigWith([{ id: "n1", logicalId: "a", runtime: "claude-code" }]);
    const p = buildRestorePlanPreview(rig, null, [row("n1", { resumeLastVerified: FRESH, resumeLastProbeStatus: "resumable" })], undefined, NOW);
    expect(p.nodes[0]!.tokenState).toBe("present");
    expect(p.nodes[0]!.provenance).toBe("adoption");
    expect(p.nodes[0]!.lastVerified).toBe(FRESH);
    expect(p.nodes[0]!.runtimePrompt).toMatch(/Claude 会话选择器/);
  });

  // 生存关键用例（§2.4）：存在的 token 若上次探测返回 not_resumable（例如 FR-4 保留的
  // 已滚动 Claude 接管 token），必须显示为 `stale`，绝不能显示为 `missing` 或只提示
  // `--fresh required`。
  it("stale（探测失败）：present + not_resumable 显示为 STALE，而非 missing", () => {
    const rig = rigWith([{ id: "n1", logicalId: "a", runtime: "claude-code" }]);
    const p = buildRestorePlanPreview(rig, null, [row("n1", { resumeLastVerified: FRESH, resumeLastProbeStatus: "not_resumable" })], undefined, NOW);
    expect(p.nodes[0]!.tokenState).toBe("stale");
    expect(p.nodes[0]!.tokenState).not.toBe("missing");
    expect(p.nodes[0]!.freshRequired).toBe(false); // still has a token to try
  });

  it("stale（时间）：可恢复 token 的验证时间超过阈值时显示为 STALE", () => {
    const rig = rigWith([{ id: "n1", logicalId: "a", runtime: "claude-code" }]);
    const p = buildRestorePlanPreview(rig, null, [row("n1", { resumeLastVerified: OLD, resumeLastProbeStatus: "resumable" })], undefined, NOW);
    expect(p.nodes[0]!.tokenState).toBe("stale");
  });

  it("为可恢复的 Codex 席位显示 codex 运行时提示", () => {
    const rig = rigWith([{ id: "n1", logicalId: "a", runtime: "codex" }]);
    const p = buildRestorePlanPreview(rig, null, [row("n1", { resumeType: "codex_id", resumeLastProbeStatus: "resumable", resumeLastVerified: FRESH })], undefined, NOW);
    expect(p.nodes[0]!.runtimePrompt).toMatch(/Codex 认证/);
  });

  it("只读：所有席位状态下 mutated 均保持 false", () => {
    const rig = rigWith([
      { id: "n1", logicalId: "a", runtime: "claude-code" },
      { id: "n2", logicalId: "b", runtime: "codex" },
    ]);
    const p = buildRestorePlanPreview(rig, null, [
      row("n1", { resumeToken: null }),
      row("n2", { resumeLastProbeStatus: "not_resumable" }),
    ], undefined, NOW);
    expect(p.mutated).toBe(false);
    expect(p.nodes).toHaveLength(2);
  });

  it("降级：迁移 45 前序列化的快照会话（无新鲜度字段）→ unverified，且不崩溃", () => {
    const rig = rigWith([{ id: "n1", logicalId: "a", runtime: "claude-code" }]);
    // 模拟完全缺少 FR-6 字段的旧快照行。
    const legacy = { nodeId: "n1", id: "s-n1", restorePolicy: "resume_if_possible", resumeType: "claude_id", resumeToken: "tok", status: "running" } as unknown as PreviewSessionRow;
    const p = buildRestorePlanPreview(rig, null, [legacy], undefined, NOW);
    expect(p.nodes[0]!.tokenState).toBe("unverified");
  });
});

// 端到端实时路径（FR-6 的主要生存证明）：数据库标记 → 实时 SELECT
//（collectPreviewSessionRows）→ 运行期间计划公开 stale-present。
describe("FR-6 实时路径——DB → collectPreviewSessionRows → 计划状态", () => {
  it("标记为 not_resumable 的现有 token 在实时计划中显示为 STALE（而非 missing）", () => {
    const db = createFullTestDb();
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "t");
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, role, runtime) VALUES (?,?,?,?,?)").run("n1", "rig-1", "a", "worker", "claude-code");
    const reg = new SessionRegistry(db);
    const s = reg.registerSession("n1", "r01-a");
    reg.updateStatus(s.id, "running");
    reg.updateResumeToken(s.id, "claude_id", "tok-1", "adoption"); // stamps verified + resumable
    reg.markResumeProbeResult(s.id, "not_resumable");              // mark stale, keep the token
    const rig = { rig: { id: "rig-1", name: "t" }, nodes: [{ id: "n1", logicalId: "a", runtime: "claude-code" }], edges: [] } as unknown as RigWithRelations;
    const rows = collectPreviewSessionRows(db, rig, null);
    const r = rows.find((x) => x.nodeId === "n1")!;
    // 实时 SELECT 携带数据库中的来源与新鲜度列。
    expect(r.resumeToken).toBe("tok-1");
    expect(r.resumeProvenance).toBe("adoption");
    expect(r.resumeLastProbeStatus).toBe("not_resumable");
    expect(r.resumeLastVerified).not.toBeNull();
    // 计划将其显示为 stale-present（保留而不置空）。
    const p = buildRestorePlanPreview(rig, null, rows);
    expect(p.nodes[0]!.tokenState).toBe("stale");
    expect(p.mutated).toBe(false);
    db.close();
  });
});
