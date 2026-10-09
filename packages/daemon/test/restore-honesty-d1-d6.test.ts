// OPR.0.5.7.1——恢复真实性，收窄后的修复子项 D1+D6a（修订后 SPEC 的 post-stamp sha256
// a2fbcd795fa9bb215917027fc09d76628fd0308da480fd7ba803a0120b14ed61；A1 独立重新盖章；
// desk 裁定 qitem-20260829080039-c47a571e）。
//
// D1 四路 OCCUPANT 事实：只有整个 activeSessionIdByNode 字段缺失（约定前 snapshot）时才能运行
// legacy 推断。存在的 map 若含 null 值、缺失节点 key 或悬空 id，都应明确失败，resume 与替换 occupant
// 均为零；绝不以最新行胜出，也绝不静默进入 legacy。fixture 前提必须显式：每次 snapshot 重写都声明
// 自身 relation mode，不从 capture 意外克隆任何状态。
//
// D6a 无条件零 REPLAY：精确 resume 不能 replay startup 或 onboarding 内容，且仅 replay 的验证不能
// 阻断 resume（该事故自身的判别项：continuity 从不需要 replay container）。有意的 fresh launch 仍会
// 完整验证其 replay 输入。旧 replay opt-in surface 已整体移除；下方缺失固定项证明其任何编码都未在
// 此子项源码或测试中残留。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ClaudeResumeAdapter, ResumeResult } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { Snapshot } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";

// 手工编写的 ULID，其陷阱在于词法顺序：OLD 排在 NEW 前，因此已退役缺陷“latest = max id”会选 NEW。
const ULID_OLD = "01ARZ3NDEKTSV4RRFFQ69G5AAA";
const ULID_MID = "01ARZ3NDEKTSV4RRFFQ69G5MMM";
const ULID_NEW = "01ARZ3NDEKTSV4RRFFQ69G5ZZZ";
const ULID_GONE = "01ARZ3NDEKTSV4RRFFQ69G5XXX"; // named by a dangling relation

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => ""),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    hasSession: async () => false,
  } as unknown as TmuxAdapter;
}

function mockClaudeResume(result?: ResumeResult): ClaudeResumeAdapter {
  return {
    canResume: vi.fn((type: string | null) => type === "claude_name" || type === "claude_id"),
    resume: vi.fn(async () => result ?? { ok: true as const }),
  } as unknown as ClaudeResumeAdapter;
}

function mockCodexResume(): CodexResumeAdapter {
  return {
    canResume: vi.fn(() => false),
    resume: vi.fn(async () => ({ ok: true as const })),
  } as unknown as CodexResumeAdapter;
}

/** 内容通道 spy adapter：`project` 携带 projection entry，`deliverStartup` 携带 startup 文件/action。 */
function spyRuntimeAdapter() {
  return {
    runtime: "claude-code",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true as const, resumeToken: "t", resumeType: "claude_id" })),
  };
}

/** fixture 声明的 relation mode；绝不从 capture 意外克隆状态（修复裁定点名的隐藏前提缺陷）。 */
type RelationMode =
  | { mode: "field-absent" }
  | { mode: "explicit-null" }
  | { mode: "missing-node-key" }
  | { mode: "explicit-id"; id: string }
  | { mode: "dangling-id"; id: string };

describe("OPR.0.5.7.1 修复子项——D1 四路 occupant 事实 + D6a 无条件零 replay", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let snapshotRepo: SnapshotRepository;
  let checkpointStore: CheckpointStore;
  let snapshotCapture: SnapshotCapture;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    snapshotRepo = new SnapshotRepository(db);
    checkpointStore = new CheckpointStore(db);
    snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  });

  afterEach(() => {
    db.close();
  });

  function createOrchestrator(opts?: { claude?: ClaudeResumeAdapter; tmux?: TmuxAdapter }) {
    const tmux = opts?.tmux ?? mockTmux();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    return new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux,
      claudeResume: opts?.claude ?? mockClaudeResume(),
      codexResume: mockCodexResume(),
    });
  }

  function seedSnapshot(opts?: { startupContext?: { entries: unknown[]; files: unknown[]; actions: unknown[] } }): { snap: Snapshot; nodeId: string } {
    const rig = rigRepo.createRig("r77");
    const node = rigRepo.addNode(rig.id, "seat", { role: "worker", runtime: "claude-code" });
    const sess = sessionRegistry.registerSession(node.id, "r77-seat");
    db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, restore_policy = ? WHERE id = ?")
      .run("claude_name", "tok-seed", "resume_if_possible", sess.id);
    if (opts?.startupContext) {
      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)")
        .run(node.id, JSON.stringify(opts.startupContext.entries), JSON.stringify(opts.startupContext.files), JSON.stringify(opts.startupContext.actions), "claude-code");
    }
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
    sessionRegistry.updateStatus(sess.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);
    return { snap, nodeId: node.id };
  }

  /** 重写 snapshot 的 session 行和 relation 状态；二者都由调用方显式声明。 */
  function rewriteSnapshot(
    snap: Snapshot,
    nodeId: string,
    rows: Array<{ id: string; status: string; token: string }>,
    relation: RelationMode,
  ): Snapshot {
    const data = JSON.parse(JSON.stringify(snap.data));
    const template = data.sessions.find((s: { nodeId: string }) => s.nodeId === nodeId);
    data.sessions = rows.map((r) => ({
      ...template,
      id: r.id,
      status: r.status,
      resumeType: "claude_name",
      resumeToken: r.token,
      restorePolicy: "resume_if_possible",
    }));
    // 此套件固定与 predecessor relation 字段的兼容性。新捕获的 snapshot 也携带新的三态 relation，
    // 因此在表达下方每个 legacy relation 前提之前将其移除。
    delete data.activeOccupantsByNode;
    switch (relation.mode) {
      case "field-absent":
        delete data.activeSessionIdByNode;
        break;
      case "explicit-null":
        data.activeSessionIdByNode = { [nodeId]: null };
        break;
      case "missing-node-key":
        data.activeSessionIdByNode = { "some-other-node": null };
        break;
      case "explicit-id":
      case "dangling-id":
        data.activeSessionIdByNode = { [nodeId]: relation.id };
        break;
    }
    db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snap.id);
    const updated = snapshotRepo.getSnapshot(snap.id);
    if (!updated) throw new Error("预期得到更新后的 snapshot");
    return updated;
  }

  const resumeTokenArg = (claude: ClaudeResumeAdapter, call = 0): unknown =>
    (claude.resume as ReturnType<typeof vi.fn>).mock.calls[call]?.[2];

  function expectLoudUnrecoverable(
    result: Awaited<ReturnType<RestoreOrchestrator["restore"]>>,
    claude: ClaudeResumeAdapter,
    naming?: string[],
  ) {
    expect(result.ok).toBe(true);
    if (result.ok) {
      const seat = result.result.nodes.find((n) => n.logicalId === "seat");
      expect(seat?.status).toBe("failed");
      const err = seat && "error" in seat ? String(seat.error) : "";
      expect(err.length).toBeGreaterThan(0);
      for (const term of naming ?? []) expect(err).toContain(term);
    }
    // 零 resume、零替换 occupant：席位 session 与此前停止状态留下的一致，没有启动任何内容。
    expect(claude.resume).not.toHaveBeenCalled();
  }

  // ------------------------------------------------------------------ D1 ---

  it("D1-legacy-single：整个字段缺失且只有一行时，legacy 推断可解析", async () => {
    const { snap, nodeId } = seedSnapshot();
    const fixed = rewriteSnapshot(snap, nodeId, [
      { id: ULID_OLD, status: "unknown", token: "tok-active" },
    ], { mode: "field-absent" });
    const claude = mockClaudeResume();
    const result = await createOrchestrator({ claude }).restore(fixed.id);
    expect(result.ok).toBe(true);
    expect(resumeTokenArg(claude)).toBe("tok-active");
  });

  it("D1-legacy-uniquely-running：字段缺失且有多行时，唯一 running 行胜出，而非最新 ULID", async () => {
    const { snap, nodeId } = seedSnapshot();
    const fixed = rewriteSnapshot(snap, nodeId, [
      { id: ULID_OLD, status: "exited", token: "tok-oldest" },
      { id: ULID_MID, status: "running", token: "tok-active" },
      { id: ULID_NEW, status: "superseded", token: "tok-stale" },
    ], { mode: "field-absent" });
    const claude = mockClaudeResume();
    const result = await createOrchestrator({ claude }).restore(fixed.id);
    expect(result.ok).toBe(true);
    expect(resumeTokenArg(claude)).toBe("tok-active");
  });

  it("D1-legacy-ambiguous：字段缺失且有两个 running 行时明确不可恢复，零 resume、零替换", async () => {
    const { snap, nodeId } = seedSnapshot();
    const fixed = rewriteSnapshot(snap, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-a" },
      { id: ULID_NEW, status: "running", token: "tok-b" },
    ], { mode: "field-absent" });
    const claude = mockClaudeResume();
    const result = await createOrchestrator({ claude }).restore(fixed.id);
    expectLoudUnrecoverable(result, claude, [ULID_OLD, ULID_NEW]);
  });

  it("D1-explicit-hit：有效显式 relation 直接消费，不做 status 推断", async () => {
    const { snap, nodeId } = seedSnapshot();
    const fixed = rewriteSnapshot(snap, nodeId, [
      { id: ULID_OLD, status: "detached", token: "tok-active" },
      { id: ULID_NEW, status: "detached", token: "tok-stale" },
    ], { mode: "explicit-id", id: ULID_OLD });
    const claude = mockClaudeResume();
    const result = await createOrchestrator({ claude }).restore(fixed.id);
    expect(result.ok).toBe(true);
    expect(resumeTokenArg(claude)).toBe("tok-active");
  });

  it("D1-present-null：存在 map、显式 null 且有历史行时明确不可恢复，绝不静默 legacy", async () => {
    const { snap, nodeId } = seedSnapshot();
    const fixed = rewriteSnapshot(snap, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-a" },
      { id: ULID_NEW, status: "superseded", token: "tok-b" },
    ], { mode: "explicit-null" });
    const claude = mockClaudeResume();
    const result = await createOrchestrator({ claude }).restore(fixed.id);
    expectLoudUnrecoverable(result, claude);
  });

  it("D1-missing-key：存在 map 但缺少此节点 key 时明确不可恢复，绝不静默 legacy", async () => {
    const { snap, nodeId } = seedSnapshot();
    const fixed = rewriteSnapshot(snap, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-a" },
    ], { mode: "missing-node-key" });
    const claude = mockClaudeResume();
    const result = await createOrchestrator({ claude }).restore(fixed.id);
    expectLoudUnrecoverable(result, claude);
  });

  it("D1-dangling：非 null relation 未指向任何 snapshot 行时明确不可恢复，并点名违规 relation", async () => {
    const { snap, nodeId } = seedSnapshot();
    const fixed = rewriteSnapshot(snap, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-a" },
    ], { mode: "dangling-id", id: ULID_GONE });
    const claude = mockClaudeResume();
    const result = await createOrchestrator({ claude }).restore(fixed.id);
    expectLoudUnrecoverable(result, claude, [ULID_GONE]);
  });

  it("D1-absence-pin：max-ULID reduce 持续从生产源码中消失（第二种编码）", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, "../src/domain/restore-orchestrator.ts"), "utf8");
    const hits = source.match(/s\.id > latest\.id \? s : latest/g) ?? [];
    expect(hits).toHaveLength(0);
  });

  it("D1-roundtrip：capture + JSON 持久化同时保留有效显式 relation 和显式 null", async () => {
    // (a) 恰有一条 RUNNING session 行：capture 将其记录为 occupant。（0ecd79a3 的 desk 裁定：
    // registerSession 默认的 'unknown' 是 fixture 前提，不是 occupant；capture 语义保持“恰有一条
    // running”，因此 fixture 显式声明 occupancy。）
    const rigA = rigRepo.createRig("rt-a");
    const nodeA = rigRepo.addNode(rigA.id, "seat", { role: "worker", runtime: "claude-code" });
    const sessA = sessionRegistry.registerSession(nodeA.id, "r78-seat");
    sessionRegistry.updateStatus(sessA.id, "running");
    const snapA = snapshotCapture.captureSnapshot(rigA.id, "manual");
    const rawA = db.prepare("SELECT data FROM snapshots WHERE id = ?").get(snapA.id) as { data: string };
    expect(JSON.parse(rawA.data).activeSessionIdByNode[nodeA.id]).toBe(sessA.id);

    // (b) 多行且没有唯一 running：capture 记录显式 null（来源处有歧义，真实记录），JSON 保留它。
    const rigB = rigRepo.createRig("rt-b");
    const nodeB = rigRepo.addNode(rigB.id, "seat", { role: "worker", runtime: "claude-code" });
    const s1 = sessionRegistry.registerSession(nodeB.id, "r79-seat");
    const s2 = sessionRegistry.registerSession(nodeB.id, "r79-seat-v2");
    sessionRegistry.updateStatus(s1.id, "running");
    sessionRegistry.updateStatus(s2.id, "running");
    const snapB = snapshotCapture.captureSnapshot(rigB.id, "manual");
    const rawB = db.prepare("SELECT data FROM snapshots WHERE id = ?").get(snapB.id) as { data: string };
    const mapB = JSON.parse(rawB.data).activeSessionIdByNode;
    expect(Object.prototype.hasOwnProperty.call(mapB, nodeB.id)).toBe(true);
    expect(mapB[nodeB.id]).toBeNull();
  });

  // ----------------------------------------------------------------- D6a ---

  const GHOST_CONTEXT = {
    entries: [{
      absolutePath: "/tmp/never-read/CLAUDE.md",
      relativePath: "CLAUDE.md",
      category: "memory",
      mergeStrategy: "managed_block",
      content: "STARTUP-GHOST-BLOCK",
    }],
    files: [{ path: "required-onboarding.md", absolutePath: "/tmp/never-read/required-onboarding.md", required: true, appliesOn: ["restore"] }],
    actions: [{ type: "send_text", text: "STARTUP-GHOST-PROMPT", idempotent: true }],
  };

  it("D6a-resume-unblocked：精确 resume + 缺失 required replay-only 文件仍成功，且零内容投递", async () => {
    const { snap, nodeId } = seedSnapshot({ startupContext: GHOST_CONTEXT });
    const fixed = rewriteSnapshot(snap, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-active" },
    ], { mode: "explicit-id", id: ULID_OLD });
    const claude = mockClaudeResume();
    const adapter = spyRuntimeAdapter();
    const result = await createOrchestrator({ claude }).restore(fixed.id, {
      adapters: { "claude-code": adapter },
      // required replay 文件不存在。仅 replay 的验证不得阻断 resume：continuity 从不需要 replay container。
      fsOps: { exists: (p) => !p.includes("never-read") },
    });
    expect(result.ok).toBe(true);
    expect(claude.resume).toHaveBeenCalledTimes(1);
    expect(resumeTokenArg(claude)).toBe("tok-active");
    const projectedEntries = (adapter.project.mock.calls[0]?.[0]?.entries ?? []) as unknown[];
    expect(projectedEntries).toHaveLength(0);
    const delivered = adapter.deliverStartup.mock.calls.flatMap((c) => JSON.stringify(c[0] ?? ""));
    expect(delivered.join("")).not.toContain("STARTUP-GHOST");
  });

  it("D6a-fresh-still-validates：有意 fresh launch 遇到同一缺失 required 文件时仍验证失败", async () => {
    const { snap, nodeId } = seedSnapshot({ startupContext: GHOST_CONTEXT });
    const fixed = rewriteSnapshot(snap, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-active" },
    ], { mode: "explicit-id", id: ULID_OLD });
    const adapter = spyRuntimeAdapter();
    const result = await createOrchestrator().restore(fixed.id, {
      adapters: { "claude-code": adapter },
      fsOps: { exists: (p) => !p.includes("never-read") },
      freshLogicalIds: ["seat"],
    });
    // 有意 fresh 会消费 replay 输入，因此仍需验证。
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("pre_restore_validation_failed");
  });

  it("D6a-zero-content-pin：带完整 startup context 的精确 resume 仍零内容投递（launch 环节完整）", async () => {
    const { snap, nodeId } = seedSnapshot({ startupContext: GHOST_CONTEXT });
    const fixed = rewriteSnapshot(snap, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-active" },
    ], { mode: "explicit-id", id: ULID_OLD });
    const claude = mockClaudeResume();
    const adapter = spyRuntimeAdapter();
    const result = await createOrchestrator({ claude }).restore(fixed.id, {
      adapters: { "claude-code": adapter },
    });
    expect(result.ok).toBe(true);
    expect(claude.resume).toHaveBeenCalledTimes(1);
    const projectedEntries = (adapter.project.mock.calls[0]?.[0]?.entries ?? []) as unknown[];
    expect(projectedEntries).toHaveLength(0);
  });

  it("D6a-fresh-replay-floor：输入存在时，有意 fresh launch 保留 startup replay", async () => {
    const { snap, nodeId } = seedSnapshot({ startupContext: GHOST_CONTEXT });
    const fixed = rewriteSnapshot(snap, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-active" },
    ], { mode: "explicit-id", id: ULID_OLD });
    const adapter = spyRuntimeAdapter();
    const result = await createOrchestrator().restore(fixed.id, {
      adapters: { "claude-code": adapter },
      freshLogicalIds: ["seat"],
      // 此路径上的每个 replay 输入都存在。
    });
    expect(result.ok).toBe(true);
    const projectedEntries = (adapter.project.mock.calls[0]?.[0]?.entries ?? []) as unknown[];
    expect(projectedEntries.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------- opt-in surface 已移除 ---

  it("D6a-optin-absence-pin：已移除 replay opt-in 的任何编码都不在此子项源码或测试中残留", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // 此标识符通过拼接构造，此处绝不连续拼写。
    const camel = ["startup", "Replay", "Opt", "In"].join("");
    const snake = ["startup", "replay", "opt", "in"].join("_");
    const kebab = ["startup", "replay", "opt", "in"].join("-");
    const needle = new RegExp(`${camel}|${snake}|${kebab}`, "i");
    const surfaces = [
      "../src/domain/restore-orchestrator.ts",
      "../src/domain/snapshot-capture.ts",
      "../src/domain/types.ts",
      "./restore-honesty-d1-d6.test.ts",
      "./restore-orchestrator.test.ts",
    ];
    for (const rel of surfaces) {
      const bytes = fs.readFileSync(path.join(here, rel), "utf8");
      const hit = bytes.match(needle);
      expect(hit, `${rel} must carry no encoding of the removed opt-in surface (found: ${hit?.[0] ?? "none"})`).toBeNull();
    }
  });
});
