import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { createFullTestDb } from "./helpers/test-app.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

function seedRig(db: Database.Database) {
  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run(
    "rig-1",
    "test-rig"
  );
  db.prepare(
    "INSERT INTO nodes (id, rig_id, logical_id, role, runtime) VALUES (?, ?, ?, ?, ?)"
  ).run("node-1", "rig-1", "dev1-impl", "worker", "claude-code");
  db.prepare(
    "INSERT INTO nodes (id, rig_id, logical_id, role, runtime) VALUES (?, ?, ?, ?, ?)"
  ).run("node-2", "rig-1", "dev1-qa", "qa", "codex");
}

describe("SessionRegistry 会话注册表", () => {
  let db: Database.Database;
  let registry: SessionRegistry;

  beforeEach(() => {
    db = setupDb();
    registry = new SessionRegistry(db);
    seedRig(db);
  });

  afterEach(() => {
    db.close();
  });

  it("registerSession 持久化并返回 typed Session", () => {
    const session = registry.registerSession("node-1", "r01-dev1-impl");
    expect(session.id).toBeDefined();
    expect(typeof session.id).toBe("string");
    expect(session.nodeId).toBe("node-1");
    expect(session.sessionName).toBe("r01-dev1-impl");
    expect(session.status).toBe("unknown");
    expect(session.createdAt).toBeDefined();
  });

  it("registerSession 使用无效 nodeId 时抛错", () => {
    expect(() =>
      registry.registerSession("nonexistent", "r01-dev1-impl")
    ).toThrow();
  });

  it("registerSession 接受 r01-orchestrator（relaxed pattern 下有效）", () => {
    expect(() =>
      registry.registerSession("node-1", "r01-orchestrator")
    ).not.toThrow();
  });

  it("registerSession 拒绝无效 session name（无 rNN- prefix）", () => {
    expect(() =>
      registry.registerSession("node-1", "random-session-name")
    ).toThrow(/session name/i);

    expect(() =>
      registry.registerSession("node-1", "my-tmux-session")
    ).toThrow(/session name/i);

    // 缺少 rNN- prefix
    expect(() =>
      registry.registerSession("node-1", "orchestrator")
    ).toThrow(/session name/i);

    // 有效名称不应抛错
    expect(() =>
      registry.registerSession("node-2", "r01-dev1-impl")
    ).not.toThrow();
  });

  // NS-T04：updateResumeToken
  it("updateResumeToken 持久化 type 与 token", () => {
    const session = registry.registerSession("node-1", "r01-dev1-impl");
    registry.updateResumeToken(session.id, "claude_id", "abc-123-def");

    const sessions = registry.getSessionsForRig("rig-1");
    const updated = sessions.find((s) => s.id === session.id);
    expect(updated!.resumeType).toBe("claude_id");
    expect(updated!.resumeToken).toBe("abc-123-def");
  });

  it("recordResumeAttempt 保留 unverified lineage，但不认证它", () => {
    const session = registry.registerSession("node-1", "r01-dev1-impl");

    expect(registry.recordResumeAttempt(session.id, " claude_id ", " attempted-token ")).toBe(true);

    const updated = registry.getSessionsForRig("rig-1").find((s) => s.id === session.id)!;
    expect(updated.resumeType).toBe("claude_id");
    expect(updated.resumeToken).toBe("attempted-token");
    expect(updated.resumeProvenance).toBeNull();
    expect(updated.resumeLastVerified).toBeNull();
    expect(updated.resumeLastProbeStatus).toBeNull();
  });

  it("recordResumeAttempt 不覆盖更强的 live evidence", () => {
    const session = registry.registerSession("node-1", "r01-dev1-impl");
    registry.updateResumeToken(session.id, "codex_id", "hook-token", "hook");

    expect(registry.recordResumeAttempt(session.id, "codex_id", "attempted-token")).toBe(false);

    const updated = registry.getSessionsForRig("rig-1").find((s) => s.id === session.id)!;
    expect(updated.resumeToken).toBe("hook-token");
    expect(updated.resumeProvenance).toBe("hook");
    expect(updated.resumeLastVerified).not.toBeNull();
    expect(updated.resumeLastProbeStatus).toBe("resumable");
  });

  // OPR.0.4.0.22——operator/attested provenance 优先于 hook + scrape。
  function provenanceOf(sessionId: string): string | null {
    const row = db.prepare("SELECT resume_provenance FROM sessions WHERE id = ?").get(sessionId) as { resume_provenance: string | null } | undefined;
    return row?.resume_provenance ?? null;
  }
  function tokenOf(sessionId: string): string | null {
    const row = db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(sessionId) as { resume_token: string | null } | undefined;
    return row?.resume_token ?? null;
  }

  it("operator provenance 覆盖现有 hook token", () => {
    const s = registry.registerSession("node-1", "dev-impl@test-rig");
    registry.updateResumeToken(s.id, "claude_id", "hook-tok", "hook");
    registry.updateResumeToken(s.id, "claude_id", "operator-tok", "operator");
    expect(tokenOf(s.id)).toBe("operator-tok");
    expect(provenanceOf(s.id)).toBe("operator");
  });

  it("operator provenance 覆盖现有 scrape token", () => {
    const s = registry.registerSession("node-1", "dev-impl@test-rig");
    registry.updateResumeToken(s.id, "claude_id", "scrape-tok", "scrape");
    registry.updateResumeToken(s.id, "claude_id", "operator-tok", "operator");
    expect(tokenOf(s.id)).toBe("operator-tok");
    expect(provenanceOf(s.id)).toBe("operator");
  });

  it("hook write 不覆盖现有 operator token（operator 优先于 hook）", () => {
    const s = registry.registerSession("node-1", "dev-impl@test-rig");
    registry.updateResumeToken(s.id, "claude_id", "operator-tok", "operator");
    registry.updateResumeToken(s.id, "claude_id", "hook-tok", "hook");
    expect(tokenOf(s.id)).toBe("operator-tok");
    expect(provenanceOf(s.id)).toBe("operator");
  });

  it("scrape write 不覆盖现有 operator token", () => {
    const s = registry.registerSession("node-1", "dev-impl@test-rig");
    registry.updateResumeToken(s.id, "claude_id", "operator-tok", "operator");
    registry.updateResumeToken(s.id, "claude_id", "scrape-tok", "scrape");
    expect(tokenOf(s.id)).toBe("operator-tok");
    expect(provenanceOf(s.id)).toBe("operator");
  });

  it("保留现有规则：scrape 不覆盖 hook", () => {
    const s = registry.registerSession("node-1", "dev-impl@test-rig");
    registry.updateResumeToken(s.id, "claude_id", "hook-tok", "hook");
    registry.updateResumeToken(s.id, "claude_id", "scrape-tok", "scrape");
    expect(tokenOf(s.id)).toBe("hook-tok");
    expect(provenanceOf(s.id)).toBe("hook");
  });

  // OPR.0.4.3.20 FR-6——verification 新鲜度打戳 + 标记过期而非清除。
  function verifiedOf(sessionId: string): string | null {
    const row = db.prepare("SELECT resume_last_verified FROM sessions WHERE id = ?").get(sessionId) as { resume_last_verified: string | null } | undefined;
    return row?.resume_last_verified ?? null;
  }
  function probeStatusOf(sessionId: string): string | null {
    const row = db.prepare("SELECT resume_last_probe_status FROM sessions WHERE id = ?").get(sessionId) as { resume_last_probe_status: string | null } | undefined;
    return row?.resume_last_probe_status ?? null;
  }

  it("FR-6：updateResumeToken 写入时标记 last_verified + probe_status=resumable", () => {
    const s = registry.registerSession("node-1", "dev-impl@test-rig");
    expect(verifiedOf(s.id)).toBeNull();
    registry.updateResumeToken(s.id, "claude_id", "tok-1", "adoption");
    expect(verifiedOf(s.id)).not.toBeNull();
    expect(probeStatusOf(s.id)).toBe("resumable");
  });

  it("FR-6：equal-value refresh 重新验证此前标为 stale 的 token", () => {
    const s = registry.registerSession("node-1", "dev-impl@test-rig");
    registry.updateResumeToken(s.id, "claude_id", "tok-1", "hook");
    registry.markResumeProbeResult(s.id, "not_resumable");
    expect(probeStatusOf(s.id)).toBe("not_resumable");
    // 相同 token value、相同 rank——写入仍执行并重新验证 freshness。
    registry.updateResumeToken(s.id, "claude_id", "tok-1", "hook");
    expect(tokenOf(s.id)).toBe("tok-1");
    expect(probeStatusOf(s.id)).toBe("resumable");
  });

  it("FR-6：markResumeProbeResult(not_resumable) 标记 stale，但不清除 token", () => {
    const s = registry.registerSession("node-1", "dev-impl@test-rig");
    registry.updateResumeToken(s.id, "claude_id", "tok-1", "adoption");
    registry.markResumeProbeResult(s.id, "not_resumable");
    expect(tokenOf(s.id)).toBe("tok-1");          // survival-critical: token SURVIVES (§2.1b)
    expect(probeStatusOf(s.id)).toBe("not_resumable");
    expect(provenanceOf(s.id)).toBe("adoption");  // provenance preserved
  });

  it("FR-6：markResumeProbeResult(inconclusive) 标记 stale；后续 resumable 标记 verified", () => {
    const s = registry.registerSession("node-1", "dev-impl@test-rig");
    registry.updateResumeToken(s.id, "claude_id", "tok-1", "hook");
    registry.markResumeProbeResult(s.id, "inconclusive");
    expect(probeStatusOf(s.id)).toBe("inconclusive");
    registry.markResumeProbeResult(s.id, "resumable");
    expect(probeStatusOf(s.id)).toBe("resumable");
    expect(verifiedOf(s.id)).not.toBeNull();
    expect(tokenOf(s.id)).toBe("tok-1");
  });

  it("FR-6：clearResumeToken 同时将 freshness column 置 null", () => {
    const s = registry.registerSession("node-1", "dev-impl@test-rig");
    registry.updateResumeToken(s.id, "claude_id", "tok-1", "adoption");
    registry.clearResumeToken(s.id);
    expect(tokenOf(s.id)).toBeNull();
    expect(verifiedOf(s.id)).toBeNull();
    expect(probeStatusOf(s.id)).toBeNull();
  });

  // OPR.0.4.3.20 FR-3——`adoption` rung：scrape < adoption < hook < operator。
  it("adoption 覆盖现有 scrape token（adoption 优先于 scrape）", () => {
    const s = registry.registerSession("node-1", "dev-impl@test-rig");
    registry.updateResumeToken(s.id, "codex_id", "scrape-tok", "scrape");
    registry.updateResumeToken(s.id, "codex_id", "adoption-tok", "adoption");
    expect(tokenOf(s.id)).toBe("adoption-tok");
    expect(provenanceOf(s.id)).toBe("adoption");
  });

  it("hook self-report 刷新 adoption token（hook 优先于 adoption——最新 live token 胜出）", () => {
    const s = registry.registerSession("node-1", "dev-impl@test-rig");
    registry.updateResumeToken(s.id, "codex_id", "adoption-tok", "adoption");
    registry.updateResumeToken(s.id, "codex_id", "hook-tok", "hook");
    expect(tokenOf(s.id)).toBe("hook-tok");
    expect(provenanceOf(s.id)).toBe("hook");
  });

  it("adoption write 不覆盖现有 hook token", () => {
    const s = registry.registerSession("node-1", "dev-impl@test-rig");
    registry.updateResumeToken(s.id, "codex_id", "hook-tok", "hook");
    registry.updateResumeToken(s.id, "codex_id", "adoption-tok", "adoption");
    expect(tokenOf(s.id)).toBe("hook-tok");
    expect(provenanceOf(s.id)).toBe("hook");
  });

  it("adoption write 不覆盖现有 operator token", () => {
    const s = registry.registerSession("node-1", "dev-impl@test-rig");
    registry.updateResumeToken(s.id, "claude_id", "operator-tok", "operator");
    registry.updateResumeToken(s.id, "claude_id", "adoption-tok", "adoption");
    expect(tokenOf(s.id)).toBe("operator-tok");
    expect(provenanceOf(s.id)).toBe("operator");
  });

  it("adoption 刷新同 rank 的 adoption token（同 rank 覆盖——幂等 re-capture）", () => {
    const s = registry.registerSession("node-1", "dev-impl@test-rig");
    registry.updateResumeToken(s.id, "codex_id", "adoption-tok-1", "adoption");
    registry.updateResumeToken(s.id, "codex_id", "adoption-tok-2", "adoption");
    expect(tokenOf(s.id)).toBe("adoption-tok-2");
    expect(provenanceOf(s.id)).toBe("adoption");
  });

  // OPR.0.4.3.20 FR-3——validity-before-rank guard：空或全 whitespace token 表示 SKIP，绝不写入；
  // 即使来自更高 provenance，也不能覆盖有效 stored token（“flakiness = missing = no-write”）。
  it("空 token 是 no-op write（即使来自更高 provenance，也让现有有效 token 保持不变）", () => {
    const s = registry.registerSession("node-1", "dev-impl@test-rig");
    registry.updateResumeToken(s.id, "codex_id", "adoption-tok", "adoption");
    registry.updateResumeToken(s.id, "codex_id", "", "operator"); // higher provenance, but empty
    expect(tokenOf(s.id)).toBe("adoption-tok");
    expect(provenanceOf(s.id)).toBe("adoption");
  });

  it("全 whitespace token 是 no-op write", () => {
    const s = registry.registerSession("node-1", "dev-impl@test-rig");
    registry.updateResumeToken(s.id, "codex_id", "hook-tok", "hook");
    registry.updateResumeToken(s.id, "codex_id", "   ", "hook");
    expect(tokenOf(s.id)).toBe("hook-tok");
  });

  it("空 token 绝不填充 fresh（null）session", () => {
    const s = registry.registerSession("node-1", "dev-impl@test-rig");
    registry.updateResumeToken(s.id, "codex_id", "", "adoption");
    expect(tokenOf(s.id)).toBeNull();
    expect(provenanceOf(s.id)).toBeNull();
  });

  // OPR.0.4.3.20 FR-3——updateResumeToken 报告是否实际写入，使 provenance guard 拒绝后，
  // adoption-capture audit event 不会错误声称已 capture write。
  it("updateResumeToken 在真实写入时返回 true，在 rank-blocked no-op 时返回 false", () => {
    const s = registry.registerSession("node-1", "dev-impl@test-rig");
    expect(registry.updateResumeToken(s.id, "codex_id", "adoption-tok", "adoption")).toBe(true);
    expect(registry.updateResumeToken(s.id, "codex_id", "hook-tok", "hook")).toBe(true); // hook > adoption
    expect(registry.updateResumeToken(s.id, "codex_id", "adoption-tok-2", "adoption")).toBe(false); // refused
    expect(tokenOf(s.id)).toBe("hook-tok");
  });

  it("updateResumeToken 对空/全 whitespace token no-op 返回 false", () => {
    const s = registry.registerSession("node-1", "dev-impl@test-rig");
    expect(registry.updateResumeToken(s.id, "codex_id", "", "adoption")).toBe(false);
    registry.updateResumeToken(s.id, "codex_id", "hook-tok", "hook");
    expect(registry.updateResumeToken(s.id, "codex_id", "   ", "hook")).toBe(false);
  });

  it("clearResumeToken 清除已存储 resume metadata", () => {
    const session = registry.registerSession("node-1", "r01-dev1-impl");
    registry.updateResumeToken(session.id, "claude_id", "abc-123-def");

    registry.clearResumeToken(session.id);

    const sessions = registry.getSessionsForRig("rig-1");
    const updated = sessions.find((s) => s.id === session.id);
    expect(updated!.resumeType).toBeNull();
    expect(updated!.resumeToken).toBeNull();
  });

  it("registerSession 接受带 @ 的 canonical session name", () => {
    const session = registry.registerSession("node-1", "dev-impl@auth-feats");
    expect(session.sessionName).toBe("dev-impl@auth-feats");
    expect(session.nodeId).toBe("node-1");
  });

  it("updateStatus 修改 status", () => {
    const session = registry.registerSession("node-1", "r01-dev1-impl");
    registry.updateStatus(session.id, "running");

    const rows = db
      .prepare("SELECT status FROM sessions WHERE id = ?")
      .get(session.id) as { status: string };
    expect(rows.status).toBe("running");
  });

  it("markDetached 将 status 设为 detached", () => {
    const session = registry.registerSession("node-1", "r01-dev1-impl");
    registry.updateStatus(session.id, "running");
    registry.markDetached(session.id);

    const row = db
      .prepare("SELECT status FROM sessions WHERE id = ?")
      .get(session.id) as { status: string };
    expect(row.status).toBe("detached");
  });

  it("getSessionsForRig 返回工作组所有 node 的全部 session", () => {
    registry.registerSession("node-1", "r01-dev1-impl");
    registry.registerSession("node-2", "r01-dev1-qa");

    const sessions = registry.getSessionsForRig("rig-1");
    expect(sessions).toHaveLength(2);
    const names = sessions.map((s) => s.sessionName);
    expect(names).toContain("r01-dev1-impl");
    expect(names).toContain("r01-dev1-qa");
  });

  it("未绑定时 getBindingForNode 返回 null", () => {
    const binding = registry.getBindingForNode("node-1");
    expect(binding).toBeNull();
  });

  it("updateBinding 插入新 binding，并返回 typed Binding", () => {
    const binding = registry.updateBinding("node-1", {
      tmuxSession: "r01-dev1-impl",
    });
    expect(binding.id).toBeDefined();
    expect(binding.nodeId).toBe("node-1");
    expect(binding.tmuxSession).toBe("r01-dev1-impl");
    expect(binding.cmuxSurface).toBeNull();
  });

  it("updateBinding partial update 保留现有字段", () => {
    // 首次：设置 tmux 字段
    registry.updateBinding("node-1", {
      tmuxSession: "r01-dev1-impl",
      tmuxWindow: "0",
      tmuxPane: "%1",
    });

    // 第二次：只设置 cmux 字段——tmux 字段必须保留
    const updated = registry.updateBinding("node-1", {
      cmuxWorkspace: "review",
      cmuxSurface: "surface-42",
    });

    expect(updated.tmuxSession).toBe("r01-dev1-impl");
    expect(updated.tmuxWindow).toBe("0");
    expect(updated.tmuxPane).toBe("%1");
    expect(updated.cmuxWorkspace).toBe("review");
    expect(updated.cmuxSurface).toBe("surface-42");
  });

  it("多次 upsert 后 updateBinding 为每个 node 恰好保留一行", () => {
    registry.updateBinding("node-1", { tmuxSession: "r01-dev1-impl" });
    registry.updateBinding("node-1", { cmuxSurface: "surface-42" });
    registry.updateBinding("node-1", { tmuxPane: "%3" });

    const rows = db
      .prepare("SELECT * FROM bindings WHERE node_id = ?")
      .all("node-1");
    expect(rows).toHaveLength(1);
  });

  // -- P2-T02b：Resume metadata mapping --

  it("registerSession 返回带默认 resume metadata 的 session", () => {
    const session = registry.registerSession("node-1", "r01-dev1-impl");
    expect(session.resumeType).toBeNull();
    expect(session.resumeToken).toBeNull();
    expect(session.restorePolicy).toBe("resume_if_possible");
  });

  it("update 后 getSessionsForRig 返回已填充的 resume metadata", () => {
    const session = registry.registerSession("node-1", "r01-dev1-impl");
    db.prepare(
      "UPDATE sessions SET resume_type = ?, resume_token = ?, restore_policy = ? WHERE id = ?"
    ).run("claude_name", "my-session", "checkpoint_only", session.id);

    const sessions = registry.getSessionsForRig("rig-1");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.resumeType).toBe("claude_name");
    expect(sessions[0]!.resumeToken).toBe("my-session");
    expect(sessions[0]!.restorePolicy).toBe("checkpoint_only");
  });

  // -- P2-T07：Stale-state repair method --

  it("clearBinding 移除 node 的 binding row", () => {
    registry.updateBinding("node-1", { tmuxSession: "r01-dev1-impl" });
    expect(registry.getBindingForNode("node-1")).not.toBeNull();

    registry.clearBinding("node-1");
    expect(registry.getBindingForNode("node-1")).toBeNull();
  });

  it("markSuperseded 将 session status 设为 'superseded'", () => {
    const session = registry.registerSession("node-1", "r01-dev1-impl");
    registry.updateStatus(session.id, "running");

    registry.markSuperseded(session.id);

    const sessions = registry.getSessionsForRig("rig-1");
    expect(sessions[0]!.status).toBe("superseded");
  });
});

// GHOST-STAGE atom-B（P12 3548d8eb）——occupant-generation TENURE ledger。sessions row 是
// REGISTRATION；register verb 按 OCCUPANT GENERATION 生成 tenure，caller 声明 kind，而 RELAUNCH
//（同一 native session）是 CONTINUATION（无新 generation）。
describe("SessionRegistry——atom-B occupant tenure", () => {
  let db: Database.Database;
  let registry: SessionRegistry;
  beforeEach(() => {
    db = createFullTestDb();
    registry = new SessionRegistry(db);
    seedRig(db);
  });
  afterEach(() => { db.close(); });

  it("registerSession 生成 INITIAL generation-1 tenure；currentOccupantTenure 返回它", () => {
    registry.registerSession("node-1", "r01-dev1-impl");
    const t = registry.currentOccupantTenure("node-1");
    expect(t).not.toBeNull();
    expect(t!.generationOrdinal).toBe(1);
    expect(t!.kind).toBe("initial");
    expect(t!.generationUuid).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("registerClaimedSession 声明 kind；同一 node 连续 register 会递增 generation ordinal", () => {
    registry.registerSession("node-1", "r01-dev1-impl"); // gen 1, initial
    registry.registerClaimedSession("node-1", "r01-dev1-impl", "handover"); // gen 2, handover
    const t = registry.currentOccupantTenure("node-1");
    expect(t!.generationOrdinal).toBe(2);
    expect(t!.kind).toBe("handover");
    const rows = db.prepare("SELECT generation_uuid FROM occupant_tenures WHERE node_id = ?").all("node-1") as { generation_uuid: string }[];
    expect(new Set(rows.map((r) => r.generation_uuid)).size).toBe(2); // unique per generation
  });

  it("RELAUNCH 是 CONTINUATION：相同 native session id 不重新生成任何内容（同一 generation）", () => {
    const first = registry.mintOccupantTenure("node-1", "initial", "native-abc");
    const relaunch = registry.mintOccupantTenure("node-1", "initial", "native-abc"); // same native = relaunch
    expect(relaunch.generationUuid).toBe(first.generationUuid); // continuation, not a new generation
    expect(relaunch.generationOrdinal).toBe(first.generationOrdinal);
    expect((db.prepare("SELECT COUNT(*) AS c FROM occupant_tenures WHERE node_id = ?").get("node-1") as { c: number }).c).toBe(1);
  });

  it("新的 native session id 生成下一 generation", () => {
    const g1 = registry.mintOccupantTenure("node-1", "initial", "native-abc");
    const g2 = registry.mintOccupantTenure("node-1", "handover", "native-xyz"); // different native = new occupant
    expect(g2.generationOrdinal).toBe(g1.generationOrdinal + 1);
    expect(g2.generationUuid).not.toBe(g1.generationUuid);
  });

  it("ordinal 按 node 计算；无 tenure 的 node 返回 null", () => {
    registry.mintOccupantTenure("node-1", "initial");
    registry.mintOccupantTenure("node-1", "handover");
    registry.mintOccupantTenure("node-2", "initial");
    expect(registry.currentOccupantTenure("node-1")!.generationOrdinal).toBe(2);
    expect(registry.currentOccupantTenure("node-2")!.generationOrdinal).toBe(1);
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, role, runtime) VALUES ('node-3','rig-1','dev1-x','worker','claude-code')").run();
    expect(registry.currentOccupantTenure("node-3")).toBeNull();
  });
});

// OPR.0.5.1 51-06 W2c——两个 live-seat mint verb 共享一个 watchdog seam。特意在刚插入的
// session 仍为 `unknown` 时观察正常 launch hook；NodeLauncher 随后将其提升为 running。
describe("SessionRegistry——W2c live-seat watchdog mint seam", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createFullTestDb();
    seedRig(db);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  type Observer = {
    ensure(nodeId: string, sessionName: string): void;
    assertCoverage(nodeId: string, sessionName: string): void;
  };

  function withObserver(observer: Observer): SessionRegistry {
    return new (SessionRegistry as unknown as new (
      db: Database.Database,
      observer: Observer,
    ) => SessionRegistry)(db, observer);
  }

  function statusAtHook(nodeId: string, sessionName: string): string | undefined {
    return (db.prepare(
      "SELECT status FROM sessions WHERE node_id = ? AND session_name = ? ORDER BY created_at DESC LIMIT 1",
    ).get(nodeId, sessionName) as { status: string } | undefined)?.status;
  }

  it("registerSession 在 status=unknown 时先调用 ensure，再调用 coverage", () => {
    const seen: string[] = [];
    const registry = withObserver({
      ensure: (nodeId, sessionName) => seen.push(`ensure:${statusAtHook(nodeId, sessionName)}`),
      assertCoverage: (nodeId, sessionName) => seen.push(`coverage:${statusAtHook(nodeId, sessionName)}`),
    });
    const session = registry.registerSession("node-1", "dev-impl@test-rig");
    expect(session.status).toBe("unknown");
    expect(seen).toEqual(["ensure:unknown", "coverage:unknown"]);
  });

  it("registerClaimedSession 在 status=running 时调用同一 ensure/coverage seam", () => {
    const seen: string[] = [];
    const registry = withObserver({
      ensure: (nodeId, sessionName) => seen.push(`ensure:${statusAtHook(nodeId, sessionName)}`),
      assertCoverage: (nodeId, sessionName) => seen.push(`coverage:${statusAtHook(nodeId, sessionName)}`),
    });
    const session = registry.registerClaimedSession("node-1", "dev-impl@test-rig");
    expect(session.status).toBe("running");
    expect(seen).toEqual(["ensure:running", "coverage:running"]);
  });

  it("watchdog failure 绝不回滚 session；ensure 只 warning 一次，coverage 持续显著报告", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ensure = vi.fn(() => { throw new Error("injected ensure failure"); });
    const assertCoverage = vi.fn(() => { throw new Error("missing auto-registration"); });
    const registry = withObserver({ ensure, assertCoverage });

    expect(() => registry.registerSession("node-1", "dev-impl@test-rig")).not.toThrow();
    expect(() => registry.registerClaimedSession("node-2", "dev-qa@test-rig")).not.toThrow();
    expect(registry.getSessionsForRig("rig-1")).toHaveLength(2);
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(assertCoverage).toHaveBeenCalledTimes(2);

    const lines = warn.mock.calls.map((args) => args.map(String).join(" "));
    expect(lines.filter((line) => line.includes("injected ensure failure"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("missing auto-registration"))).toHaveLength(2);
    expect(lines.some((line) => line.includes("node-1") && line.includes("dev-impl@test-rig"))).toBe(true);
    expect(lines.some((line) => line.includes("node-2") && line.includes("dev-qa@test-rig"))).toBe(true);
  });
});
