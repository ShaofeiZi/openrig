import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import type { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { buildAttentionResponse } from "../src/routes/up.js";

const VALID_SPEC = `
schema_version: 1
name: r99
version: "1.0"
nodes:
  - id: dev
    runtime: claude-code
edges: []
`.trim();

function insertStartupContextRow(db: Database.Database, nodeId: string) {
  db.prepare(
    "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
  ).run(nodeId, "[]", "[]", "[]", "claude-code");
}

describe("Up API 路由", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createTestApp>["app"];
  let tmpDir: string;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let snapshotCapture: SnapshotCapture;
  let restoreOrchestrator: RestoreOrchestrator;

  beforeEach(() => {
    db = createFullTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "up-route-"));
    // 使用指向 tmpDir 的真实 UpCommandRouter fsOps 创建测试 app
    const setup = createTestApp(db);
    app = setup.app;
    rigRepo = setup.rigRepo;
    sessionRegistry = setup.sessionRegistry;
    snapshotCapture = setup.snapshotCapture;
    restoreOrchestrator = setup.restoreOrchestrator;
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // T5：缺少 sourceRef -> 400
  it("POST /api/up 缺少 sourceRef 时返回 400", async () => {
    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // T2：未知 source -> 400
  it("POST /api/up 使用不存在的 source 时返回 400", async () => {
    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: "/nonexistent/file.yaml" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("未找到 source");
  });

  // T6：Startup 接线
  it("createDaemon 接入 /api/up 路由", async () => {
    db.close();
    const { createDaemon } = await import("../src/startup.js");
    const { app: daemonApp, db: daemonDb } = await createDaemon({ dbPath: ":memory:" });
    try {
      const res = await daemonApp.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400); // 证明 route 已挂载
    } finally {
      daemonDb.close();
    }
  });

  it("POST /api/up 恢复现有工作组名称时包含 rigResult", async () => {
    const rig = rigRepo.createRig("restore-me");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const session = sessionRegistry.registerSession(node.id, "worker@restore-me");
    db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, restore_policy = ? WHERE id = ?")
      .run("claude_name", "tok-restore", "relaunch_fresh", session.id);
    sessionRegistry.updateStatus(session.id, "running");
    snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
    sessionRegistry.updateStatus(session.id, "exited");

    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: "restore-me" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("restored");
    expect(body.rigResult).toBe("partially_restored");
    expect(body.nodes[0].status).toBe("fresh-primed");
  });

  it("POST /api/up 恢复现有工作组名称时返回 validation blocker", async () => {
    const rig = rigRepo.createRig("restore-blocked");
    const fixtureNode = rigRepo.addNode(rig.id, "worker", { role: "worker" });
    const session = sessionRegistry.registerSession(fixtureNode.id, "worker@restore-blocked");
    db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, restore_policy = ? WHERE id = ?")
      .run("claude_name", "tok-blocked", "relaunch_fresh", session.id);
    sessionRegistry.updateStatus(session.id, "running");
    const snap = snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
    sessionRegistry.updateStatus(session.id, "exited");
    const data = JSON.parse(JSON.stringify(snap.data));
    const node = data.nodes[0];
    const missingPath = `/tmp/openrig-slice7-up-missing-${Date.now()}.md`;
    data.nodeStartupContext[node.id] = {
      projectionEntries: [],
      resolvedStartupFiles: [{
        path: "startup.md",
        absolutePath: missingPath,
        ownerRoot: "/tmp",
        deliveryHint: "guidance_merge",
        required: true,
        appliesOn: ["restore"],
      }],
      startupActions: [],
      runtime: "claude-code",
    };
    db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snap.id);

    const res = await app.request("/api/up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceRef: "restore-blocked" }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.status).toBe("not_attempted");
    expect(body.code).toBe("pre_restore_validation_failed");
    expect(body.rigResult).toBe("not_attempted");
    expect(body.blockers[0].path).toBe(missingPath);
  });

  // L3b：无 auto-pre-down 时，rig-name 路径回退到 manual snapshot。两个 route 都保留
  // auto-pre-down 优先级并回显 `snapshotKind`。
  describe("L3b snapshot-selection 回退", () => {
    it("存在 auto-pre-down 时优先使用；response 回显 snapshotKind=auto-pre-down", async () => {
      const rig = rigRepo.createRig("auto-pref");
      rigRepo.addNode(rig.id, "worker", { role: "worker" });
      // 先 capture manual，再 capture auto-pre-down。必须由 auto-pre-down 胜出。
      snapshotCapture.captureSnapshot(rig.id, "manual");
      snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "auto-pref" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("restored");
      expect(body.snapshotKind).toBe("auto-pre-down");
    });

    it("无 auto-pre-down 时回退到 manual snapshot；response 回显 snapshotKind=manual", async () => {
      const rig = rigRepo.createRig("manual-only");
      rigRepo.addNode(rig.id, "worker", { role: "worker" });
      snapshotCapture.captureSnapshot(rig.id, "manual");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "manual-only" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("restored");
      expect(body.snapshotKind).toBe("manual");
    });

    it("无可用 snapshot 时返回 404，并携带更新后的“没有可恢复快照”消息", async () => {
      rigRepo.createRig("no-snap");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "no-snap" }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("no_snapshot");
      expect(body.error).toContain("没有可恢复快照");
      // 旧消息特指 auto-pre-down——现在不得再出现。
      expect(body.error).not.toContain("auto-pre-down snapshot");
    });

    it("无可用 snapshot 时，从持久 current state capture auto-rehydrate snapshot", async () => {
      const rig = rigRepo.createRig("current-state-rig");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
      const session = sessionRegistry.registerSession(node.id, "dev-impl@current-state-rig");
      sessionRegistry.updateStatus(session.id, "stopped");
      sessionRegistry.updateStartupStatus(session.id, "failed");
      insertStartupContextRow(db, node.id);

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "current-state-rig" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("restored");
      expect(body.snapshotKind).toBe("auto-rehydrate");
      expect(body.warnings).toContain("不存在可恢复快照；已捕获当前 DB 状态作为 auto-rehydrate 快照供重启恢复。");
    });

    it("旧 restore snapshot 指向先前 occupant 时，根据 detached current occupant 制定计划", async () => {
      const rig = rigRepo.createRig("stale-occupant-rig");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
      insertStartupContextRow(db, node.id);

      const prior = sessionRegistry.registerSession(node.id, "dev-impl@stale-occupant-rig");
      db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, status = ? WHERE id = ?")
        .run("claude_id", "11111111-1111-4111-8111-111111111111", "running", prior.id);
      snapshotCapture.captureSnapshot(rig.id, "auto-periodic");

      sessionRegistry.markSuperseded(prior.id);
      const current = sessionRegistry.registerSession(node.id, "dev-impl@stale-occupant-rig");
      db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, status = ? WHERE id = ?")
        .run("claude_id", "22222222-2222-4222-8222-222222222222", "detached", current.id);

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "stale-occupant-rig", plan: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.snapshot).toBeNull();
      expect(body.wouldCaptureCurrentState).toBe(true);
      expect(body.nodes).toEqual([
        expect.objectContaining({
          logicalId: "dev.impl",
          intendedAction: "resume-original",
        }),
      ]);
    });

    it("同一 occupant row 有更新的 native resume identity 时，根据 current state 制定计划", async () => {
      const rig = rigRepo.createRig("stale-native-identity-rig");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
      insertStartupContextRow(db, node.id);

      const session = sessionRegistry.registerSession(node.id, "dev-impl@stale-native-identity-rig");
      db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, status = ? WHERE id = ?")
        .run("claude_id", "11111111-1111-4111-8111-111111111111", "running", session.id);
      snapshotCapture.captureSnapshot(rig.id, "auto-periodic");

      db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, status = ? WHERE id = ?")
        .run("claude_id", "22222222-2222-4222-8222-222222222222", "detached", session.id);

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "stale-native-identity-rig", plan: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.snapshot).toBeNull();
      expect(body.wouldCaptureCurrentState).toBe(true);
      expect(body.nodes).toEqual([
        expect.objectContaining({
          logicalId: "dev.impl",
          intendedAction: "resume-original",
        }),
      ]);
    });
  });

  // OPR.0.3.4.9——Option Y：restore selection 中 auto-periodic 与 auto-pre-down 同级。
  describe("通过 /api/up 执行 OPR.0.3.4.9 Option Y restore selection", () => {
    it("过期 auto-pre-down + 更新的 auto-periodic -> 从 auto-periodic 恢复", async () => {
      const rig = rigRepo.createRig("option-y-rig");
      rigRepo.addNode(rig.id, "worker", { role: "worker" });
      snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
      // 等一个 tick，使 created_at 不同
      await new Promise((r) => setTimeout(r, 10));
      snapshotCapture.captureSnapshot(rig.id, "auto-periodic");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "option-y-rig" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("restored");
      expect(body.snapshotKind).toBe("auto-periodic");
    });

    it("更新的 auto-pre-down + 更旧的 auto-periodic -> 从 auto-pre-down 恢复", async () => {
      const rig = rigRepo.createRig("option-y-rig2");
      rigRepo.addNode(rig.id, "worker", { role: "worker" });
      snapshotCapture.captureSnapshot(rig.id, "auto-periodic");
      await new Promise((r) => setTimeout(r, 10));
      snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "option-y-rig2" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.snapshotKind).toBe("auto-pre-down");
    });
  });

  // OPR.0.3.4.4——在 rig_name restore 路径上，`--plan` 必须只读。rig_name 分支此前在 bootstrap
  // plan gate 之前提前返回，使 `zrig up --existing <rig> --plan` 发生 mutation（重建 session，
  // detached->running）。这些测试固定 daemon-level gate。
  describe("OPR.0.3.4.4 --plan 只读 restore gate（rig_name 路径）", () => {
    function snapshotOf(db_: Database.Database, table: string): unknown[] {
      return db_.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
    }

    it("plan:true 返回只读 preview：不调用 restore()，session/snapshot 零 mutation", async () => {
      const rig = rigRepo.createRig("plan-ro-rig");
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
      const sess = sessionRegistry.registerSession(node.id, "worker@plan-ro-rig");
      db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, status = ? WHERE id = ?")
        .run("claude_name", "tok-1", "running", sess.id);
      snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
      sessionRegistry.updateStatus(sess.id, "detached");
      const restoreSpy = vi.spyOn(restoreOrchestrator, "restore");
      const sessionsBefore = snapshotOf(db, "sessions");
      const snapshotsBefore = snapshotOf(db, "snapshots");
      const bindingsBefore = snapshotOf(db, "bindings");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "plan-ro-rig", plan: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("plan");
      expect(body.mode).toBe("restore");
      expect(body.mutated).toBe(false);
      // 有用的 preview：根据 resume state 派生 per-seat intended action。
      expect(body.nodes).toHaveLength(1);
      expect(body.nodes[0].logicalId).toBe("worker");
      expect(body.nodes[0].intendedAction).toBe("resume-original");
      expect(body.snapshot).not.toBeNull();
      expect(body.wouldCaptureCurrentState).toBe(false);
      // 关键 gate：不发生任何 restore mutation。
      expect(restoreSpy).not.toHaveBeenCalled();
      expect(snapshotOf(db, "sessions")).toEqual(sessionsBefore);
      expect(snapshotOf(db, "snapshots")).toEqual(snapshotsBefore);
      expect(snapshotOf(db, "bindings")).toEqual(bindingsBefore);
    });

    it("plan:true 对 recorded-source/no-token seat 预览 awaiting-decision（预测 slice-02 stop）", async () => {
      const rig = rigRepo.createRig("plan-ad-rig");
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
      const sess = sessionRegistry.registerSession(node.id, "worker@plan-ad-rig");
      db.prepare("UPDATE sessions SET resume_type = ?, resume_token = NULL, status = ? WHERE id = ?")
        .run("claude_name", "running", sess.id);
      snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
      sessionRegistry.updateStatus(sess.id, "detached");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "plan-ad-rig", plan: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.nodes[0].intendedAction).toBe("awaiting-decision");
      expect(body.nodes[0].reason).toContain("没有可用的原生恢复身份");
    });

    it("plan:true + freshLogicalIds 对列出的 RESUMABLE seat 预览 fresh-primed（operation-B 诚实性），零 mutation", async () => {
      // Guard BLOCKING a23009d8：列在 --fresh 中的 token-resumable seat 必须预览 apply 会执行的
      // 操作（有意 fresh-prime），而非 token 单独暗示的 resume-original。
      const rig = rigRepo.createRig("plan-fresh-rig");
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
      const sess = sessionRegistry.registerSession(node.id, "worker@plan-fresh-rig");
      db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, status = ? WHERE id = ?")
        .run("claude_name", "tok-1", "running", sess.id);
      snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
      sessionRegistry.updateStatus(sess.id, "detached");
      const restoreSpy = vi.spyOn(restoreOrchestrator, "restore");
      const sessionsBefore = snapshotOf(db, "sessions");
      const snapshotsBefore = snapshotOf(db, "snapshots");
      const bindingsBefore = snapshotOf(db, "bindings");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "plan-fresh-rig", plan: true, freshLogicalIds: ["worker"] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("plan");
      expect(body.nodes[0].logicalId).toBe("worker");
      expect(body.nodes[0].intendedAction).toBe("fresh-primed");
      expect(body.nodes[0].reason).toContain("--fresh");
      expect(restoreSpy).not.toHaveBeenCalled();
      expect(snapshotOf(db, "sessions")).toEqual(sessionsBefore);
      expect(snapshotOf(db, "snapshots")).toEqual(snapshotsBefore);
      expect(snapshotOf(db, "bindings")).toEqual(bindingsBefore);
    });

    it("plan:true + freshLogicalIds 让未列出的 seat 继续按其 resume state 预测", async () => {
      const rig = rigRepo.createRig("plan-fresh-mixed");
      const nodeA = rigRepo.addNode(rig.id, "worker-a", { role: "worker", runtime: "claude-code" });
      const nodeB = rigRepo.addNode(rig.id, "worker-b", { role: "worker", runtime: "claude-code" });
      for (const [node, name] of [[nodeA, "worker-a"], [nodeB, "worker-b"]] as const) {
        const sess = sessionRegistry.registerSession(node.id, `${name}@plan-fresh-mixed`);
        db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, status = ? WHERE id = ?")
          .run("claude_name", "tok-1", "running", sess.id);
      }
      snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
      db.prepare("UPDATE sessions SET status = 'detached' WHERE node_id IN (?, ?)").run(nodeA.id, nodeB.id);

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "plan-fresh-mixed", plan: true, freshLogicalIds: ["worker-b"] }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      const byId = Object.fromEntries((body.nodes as Array<{ logicalId: string; intendedAction: string }>).map((n) => [n.logicalId, n.intendedAction]));
      expect(byId["worker-a"]).toBe("resume-original");
      expect(byId["worker-b"]).toBe("fresh-primed");
    });

    it("plan:true 且无可用 snapshot 时报告 wouldCaptureCurrentState，但不实际 capture", async () => {
      const rig = rigRepo.createRig("plan-rehydrate-rig");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
      const session = sessionRegistry.registerSession(node.id, "dev-impl@plan-rehydrate-rig");
      sessionRegistry.updateStatus(session.id, "stopped");
      sessionRegistry.updateStartupStatus(session.id, "failed");
      insertStartupContextRow(db, node.id);
      const restoreSpy = vi.spyOn(restoreOrchestrator, "restore");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "plan-rehydrate-rig", plan: true }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("plan");
      expect(body.snapshot).toBeNull();
      expect(body.wouldCaptureCurrentState).toBe(true);
      // auto-rehydrate capture 是 mutation；plan 绝不能执行它。
      const rows = db.prepare("SELECT COUNT(*) as c FROM snapshots WHERE rig_id = ?").get(rig.id) as { c: number };
      expect(rows.c).toBe(0);
      expect(restoreSpy).not.toHaveBeenCalled();
    });

    it("plan:true 且无可用 snapshot、state 不合格时仍返回 404（与 apply 相同）", async () => {
      rigRepo.createRig("plan-no-snap");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "plan-no-snap", plan: true }),
      });

      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("no_snapshot");
    });

    it("APPLY 回归：未提供 plan 时仍会恢复（调用 restore() 一次）", async () => {
      const rig = rigRepo.createRig("plan-apply-rig");
      rigRepo.addNode(rig.id, "worker", { role: "worker" });
      snapshotCapture.captureSnapshot(rig.id, "auto-pre-down");
      const restoreSpy = vi.spyOn(restoreOrchestrator, "restore");

      const res = await app.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: "plan-apply-rig" }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("restored");
      expect(restoreSpy).toHaveBeenCalledTimes(1);
    });
  });

  // Agent Starter v1 vertical M2 R2——starter_ref 的 POST /api/up 端到端证明。
  //
  // 这些测试通过 route 覆盖完整 apply 路径。正向 case 证明 STARTER artifact 到达
  // startup-orchestrator（通过 `node_startup_context.resolved_files_json` SQLite roundtrip 验证——
  // 与 agent-starter-instantiator.test.ts 固定相同 persistence boundary，但此处由 HTTP layer 驱动）。
  // failed-scan 阴性 case 证明含 credential 的 registry entry 会以明确 failure 拒绝 launch，且没有
  // completed startup_context（关键 credential-safety contract）。schema-composition 阴性 case
  //（fork+starter_ref、terminal+starter_ref）因 upfront 拒绝，仍使用 plan-mode 测试。
  describe("M2 R2：带 starter_ref 的 POST /api/up（端到端）", () => {
    let specDir: string;
    let registryDir: string;
    let app2: ReturnType<typeof createTestApp>["app"];
    let setup2: ReturnType<typeof createTestApp>;
    let db2: Database.Database;

    beforeEach(() => {
      specDir = fs.mkdtempSync(path.join(os.tmpdir(), "up-route-starter-"));
      registryDir = fs.mkdtempSync(path.join(os.tmpdir(), "up-route-registry-"));

      // 真实 agent.yaml fixture，使 apply-mode agent_ref 解析成功。
      const agentDir = path.join(specDir, "agents", "impl");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(
        path.join(agentDir, "agent.yaml"),
        `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n`,
      );

      db2 = createFullTestDb();
      const realRouterFsOps = {
        exists: (p: string) => fs.existsSync(p),
        readFile: (p: string) => fs.readFileSync(p, "utf-8"),
        readHead: (p: string, n: number) => {
          const buf = Buffer.alloc(n);
          const fd = fs.openSync(p, "r");
          try { fs.readSync(fd, buf, 0, n, 0); } finally { fs.closeSync(fd); }
          return buf;
        },
      };
      const realInstantiatorFsOps = {
        exists: (p: string) => fs.existsSync(p),
        readFile: (p: string) => fs.readFileSync(p, "utf-8"),
      };
      setup2 = createTestApp(db2, {
        upRouterFsOps: realRouterFsOps,
        podInstantiatorFsOps: realInstantiatorFsOps,
      });
      app2 = setup2.app;
      process.env.OPENRIG_AGENT_STARTER_ROOT = registryDir;
    });

    afterEach(() => {
      delete process.env.OPENRIG_AGENT_STARTER_ROOT;
      db2.close();
      fs.rmSync(specDir, { recursive: true, force: true });
      fs.rmSync(registryDir, { recursive: true, force: true });
    });

    function writeSpec(name: string, body: string): string {
      const p = path.join(specDir, name);
      fs.writeFileSync(p, body, "utf-8");
      return p;
    }

    function writeRegistryEntry(name: string, body: string): void {
      fs.writeFileSync(path.join(registryDir, `${name}.yaml`), body, "utf-8");
    }

    const CLEAN_REGISTRY_BODY = `draft: false
starter_id: route-fixture
runtime: claude-code
manifest_id: openrig-builder-base
manifest_version: "0.2"
session_source:
  mode: fork
  ref:
    kind: native_id
    value: "fx"
captured_at: 2026-05-01T00:00:00Z
captured_by: fixture
ready_check_evidence: ../evidence/fixture.md
status: captured
state: 2-named
`;

    const CRED_REGISTRY_BODY = `draft: false
starter_id: route-fixture-mal
runtime: claude-code
manifest_id: openrig-builder-base
manifest_version: "0.2"
session_source:
  mode: fork
  ref:
    kind: native_id
    value: "fx"
captured_at: 2026-05-01T00:00:00Z
captured_by: fixture
ready_check_evidence: ../evidence/fixture.md
status: captured
state: 2-named
api_key: example-not-real
`;

    it("端到端正向：apply-mode POST /api/up 解析 starter，且 STARTER 到达 orchestrator（DB roundtrip）", async () => {
      writeRegistryEntry("route-fixture", CLEAN_REGISTRY_BODY);
      const yaml = `version: "0.2"
name: starter-route-positive
pods:
  - id: dev
    label: Development
    members:
      - id: impl
        agent_ref: local:agents/impl
        profile: default
        runtime: claude-code
        cwd: .
        starter_ref:
          name: route-fixture
    edges: []
edges: []
`;
      const specPath = writeSpec("starter-route-positive.yaml", yaml);

      const res = await app2.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: specPath }),
      });
      const body = await res.json();
      // Apply mode：201 completed（若其他 stage 偶发失败则为 200 partial，但 import_rig stage 必须
      // 为 ok，且必须返回 rigId）。
      expect(body.rigId, JSON.stringify(body)).toBeDefined();

      // 查询 impl node 并读取其 node_startup_context row，验证 STARTER layer 跨越 persistence
      // boundary（startup-orchestrator.ts:293-301 SQLite write）。
      const rig = setup2.rigRepo.getRig(body.rigId);
      expect(rig).not.toBeNull();
      const dbNode = rig!.nodes.find((n) => n.logicalId === "dev.impl");
      expect(dbNode).toBeDefined();

      const row = db2
        .prepare("SELECT resolved_files_json FROM node_startup_context WHERE node_id = ?")
        .get(dbNode!.id) as { resolved_files_json: string } | undefined;
      expect(row, "expected node_startup_context row to exist after route apply").toBeDefined();
      const persisted = JSON.parse(row!.resolved_files_json) as Array<{
        path: string;
        ownerRoot: string;
        appliesOn: string[];
        deliveryHint: string;
      }>;
      expect(persisted.length).toBeGreaterThan(0);
      // index 0 的 STARTER layer——registry-rooted、fresh_start、guidance_merge。
      expect(persisted[0]!.ownerRoot).toBe(registryDir);
      expect(persisted[0]!.path).toBe("route-fixture.yaml");
      expect(persisted[0]!.appliesOn).toEqual(["fresh_start"]);
      expect(persisted[0]!.deliveryHint).toBe("guidance_merge");
    });

    it("端到端阴性：含 credential 的 registry entry → launch 以明确错误失败，且没有 startup_context row", async () => {
      writeRegistryEntry("route-fixture-mal", CRED_REGISTRY_BODY);
      const yaml = `version: "0.2"
name: starter-route-failed-scan
pods:
  - id: dev
    label: Development
    members:
      - id: impl
        agent_ref: local:agents/impl
        profile: default
        runtime: claude-code
        cwd: .
        starter_ref:
          name: route-fixture-mal
    edges: []
edges: []
`;
      const specPath = writeSpec("starter-route-failed-scan.yaml", yaml);

      const res = await app2.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: specPath }),
      });
      const body = await res.json();
      // credential-scan failure 以 node-level launch failure 呈现。instantiator 返回
      // status="failed" 且 error 提及“Agent Starter resolver failed”的 NodeOutcome——向上传播为
      // partial/failed bootstrap。route 返回非 2xx。
      expect(res.status).not.toBe(201);
      const errStr = JSON.stringify(body);
      expect(errStr).toMatch(/Agent Starter resolver failed|credential/i);

      // 是否已创建 rigId 取决于 partial-failure policy；关键断言是没有持久化
      // node_startup_context row（launch 在 startup-orchestrator.startNode 写入 SQLite row 前中止）。
      const startupRows = db2
        .prepare("SELECT COUNT(*) as cnt FROM node_startup_context")
        .get() as { cnt: number };
      expect(startupRows.cnt).toBe(0);
    });

    it("以 400 拒绝 fork + starter_ref composition（terminal 等价 route surface）", async () => {
      const yaml = `version: "0.2"
name: starter-fork-reject
pods:
  - id: dev
    label: Development
    members:
      - id: impl
        agent_ref: local:agents/impl
        profile: default
        runtime: claude-code
        cwd: .
        starter_ref:
          name: openrig-builder-base--claude-code
        session_source:
          mode: fork
          ref:
            kind: native_id
            value: some-id
    edges: []
edges: []
`;
      const specPath = writeSpec("starter-fork-reject.yaml", yaml);

      const res = await app2.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: specPath, plan: true }),
      });
      // Pod-aware composition rule（rigspec-schema 中的 validateStarterRef）拒绝
      // fork+starter_ref，因此 upRouter 不会把 YAML 分类为有效 pod-aware rig_spec。route 返回 400。
      //（既有 UX caveat：error message 从 legacy fallthrough 冒出，而非 pod-aware validator；但 M2
      // 要求的契约行为是拒绝该 spec。）
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("不是有效的工作组 spec");
    });

    it("以 400 拒绝 terminal + starter_ref composition", async () => {
      const yaml = `version: "0.2"
name: starter-terminal-reject
pods:
  - id: dev
    label: Development
    members:
      - id: t1
        agent_ref: local:agents/t1
        profile: default
        runtime: terminal
        cwd: .
        starter_ref:
          name: openrig-builder-base--claude-code
    edges: []
edges: []
`;
      const specPath = writeSpec("starter-terminal-reject.yaml", yaml);

      const res = await app2.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: specPath, plan: true }),
      });
      // Pod-aware composition rule 拒绝 terminal+starter_ref。route 返回 400（error message
      // provenance 与上方 fork case 有相同 caveat——M2 要求的契约行为是拒绝）。
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("不是有效的工作组 spec");
    });
  });

  // --- Conveyor-Trust 最小修复（OPR.0.3.2.CT）——guard verdict
  //     qitem-20260518082933 BLOCKER 2：必须由测试固定 HG-4 route response shape。
  //     buildAttentionResponse 是纯 helper，根据包含 blocked/attention_required import_rig stage
  //     的 bootstrap result 构建三段式错误；route 携带该 body 返回 409。这些测试无需完整 daemon
  //     harness 即可固定 shape。

  describe("OPR.0.3.2.CT BLOCKER-2：HG-4 三段式 error shape", () => {
    it("没有 blocked/attention_required import_rig stage 时返回 null（普通 partial 路径）", () => {
      const result = {
        rigId: "rig-1",
        stages: [
          { stage: "resolve_spec", status: "ok" },
          { stage: "import_rig", status: "ok", detail: { rigId: "rig-1", nodes: [] } },
        ],
      };
      expect(buildAttentionResponse(result)).toBeNull();
    });

    it("import_rig stage 为 failed 且无 attention_required code 时返回 null", () => {
      const result = {
        rigId: "rig-1",
        stages: [
          { stage: "import_rig", status: "failed", detail: { code: "instantiate_error" } },
        ],
      };
      expect(buildAttentionResponse(result)).toBeNull();
    });

    it("HG-4：blocked + attention_required stage → 带 attentionNodes 的 fact/consequence/action", () => {
      const result = {
        rigId: "rig-conveyor-1",
        stages: [
          {
            stage: "import_rig",
            status: "blocked",
            detail: {
              code: "attention_required",
              message: "1 node requires attention before becoming interactive (rig parked, NOT failed; approve and resume to proceed).",
              attentionNodes: [
                { logicalId: "dev.impl", sessionName: "dev-impl@conveyor", evidence: "trust prompt", reason: "trust_gate" },
              ],
            },
          },
        ],
      };
      const r = buildAttentionResponse(result);
      expect(r).not.toBeNull();
      expect(r!.error.fact).toMatch(/requires attention/i);
      expect(r!.error.consequence).toMatch(/rig-conveyor-1/);
      expect(r!.error.consequence).toMatch(/rig ps/);
      expect(r!.error.consequence).toMatch(/attention_required/);
      expect(r!.error.action).toMatch(/tmux attach -t dev-impl@conveyor/);
      expect(r!.error.action).not.toMatch(/rig setup --cwd/);
      // 单 node case 使用单数措辞
      expect(r!.error.action).toMatch(/^选择恢复方式前，先检查受影响的会话/);
      expect(r!.attentionNodes).toHaveLength(1);
      expect(r!.attentionNodes[0]!.logicalId).toBe("dev.impl");
    });

    it("HG-4：多 node action message 使用复数措辞，并列出多个 tmux attach 提示", () => {
      const result = {
        rigId: "rig-conveyor-2",
        stages: [
          {
            stage: "import_rig",
            status: "blocked",
            detail: {
              code: "attention_required",
              message: "3 nodes require attention before becoming interactive.",
              attentionNodes: [
                { logicalId: "dev.impl", sessionName: "dev-impl@conveyor", reason: "trust_gate" },
                { logicalId: "dev.qa", sessionName: "dev-qa@conveyor", reason: "trust_gate" },
                { logicalId: "dev.review", sessionName: "dev-review@conveyor", reason: "trust_gate" },
              ],
            },
          },
        ],
      };
      const r = buildAttentionResponse(result);
      expect(r).not.toBeNull();
      // 复数措辞
      expect(r!.error.action).toMatch(/^选择恢复方式前，先检查 attentionNodes 中列出的每个受影响会话/);
      // 列出前 3 个提示
      expect(r!.error.action).toContain("tmux attach -t dev-impl@conveyor");
      expect(r!.error.action).toContain("tmux attach -t dev-qa@conveyor");
      expect(r!.error.action).toContain("tmux attach -t dev-review@conveyor");
      expect(r!.attentionNodes).toHaveLength(3);
    });

    it("HG-4：attach 提示缩略时，多 node action message 指向 attentionNodes", () => {
      const result = {
        rigId: "rig-conveyor-4",
        stages: [
          {
            stage: "import_rig",
            status: "blocked",
            detail: {
              code: "attention_required",
              message: "4 nodes require attention before becoming interactive.",
              attentionNodes: [
                { logicalId: "intake.lead", sessionName: "intake-lead@conveyor", reason: "trust_gate" },
                { logicalId: "plan.planner", sessionName: "plan-planner@conveyor", reason: "trust_gate" },
                { logicalId: "build.builder", sessionName: "build-builder@conveyor", reason: "trust_gate" },
                { logicalId: "review.reviewer", sessionName: "review-reviewer@conveyor", reason: "trust_gate" },
              ],
            },
          },
        ],
      };
      const r = buildAttentionResponse(result);
      expect(r).not.toBeNull();
      expect(r!.error.action).toMatch(/^选择恢复方式前，先检查 attentionNodes 中列出的每个受影响会话/);
      expect(r!.error.action).toContain("tmux attach -t intake-lead@conveyor");
      expect(r!.error.action).toContain("tmux attach -t plan-planner@conveyor");
      expect(r!.error.action).toContain("tmux attach -t build-builder@conveyor");
      expect(r!.error.action).toContain("另有 1 个列在 attentionNodes 中");
      expect(r!.error.action).not.toContain("review-reviewer@conveyor");
      expect(r!.attentionNodes).toHaveLength(4);
    });

    it("HG-4：所有 node 都没有 sessionName 时，action 回退到“见 zrig ps”（防御）", () => {
      const result = {
        rigId: "rig-conveyor-3",
        stages: [
          {
            stage: "import_rig",
            status: "blocked",
            detail: {
              code: "attention_required",
              message: "1 node requires attention.",
              attentionNodes: [
                { logicalId: "dev.impl", sessionName: "", reason: "trust_gate" },
              ],
            },
          },
        ],
      };
      const r = buildAttentionResponse(result);
      expect(r!.error.action).toContain("见 `zrig ps`");
    });

    it("HG-4：没有 rigId 的 result 仍生成有效 response（防御）", () => {
      const result = {
        stages: [
          {
            stage: "import_rig",
            status: "blocked",
            detail: {
              code: "attention_required",
              message: "1 node requires attention.",
              attentionNodes: [
                { logicalId: "dev.impl", sessionName: "dev-impl@x", reason: "trust_gate" },
              ],
            },
          },
        ],
      };
      const r = buildAttentionResponse(result);
      expect(r).not.toBeNull();
      expect(r!.error.consequence).toContain("(rigId 不可用)");
    });
  });

  // OPR.0.3.2.CT——route-level POST /api/up discriminator
  //
  // Guard re-verify（qitem-20260518083805）BLOCKER：此前 forward-fix 增加了
  // buildAttentionResponse 的纯 helper 测试，但即使 route 不再调用 helper 或不再返回 409，这些测试
  // 仍会通过。本测试以 partial+blocked+attention result stub bootstrapOrchestrator.bootstrap，覆盖真实
  // route；若 up.ts 返回 200（普通 partial 路径）或 201（completed 路径）而非带三段式 body 的 409，
  // 测试会失败。
  describe("OPR.0.3.2.CT BLOCKER-2（route-level）：attention_required partial 时 POST /api/up 以三段式 body 返回 409", () => {
    it("attention_required partial → 409，包含 error.fact / error.consequence / error.action / attentionNodes", async () => {
      // 构建 fresh app instance，以便 monkey-patch orchestrator 且不向其他测试泄漏 state。
      db.close();
      const freshDb = createFullTestDb();
      // 使用 real-fs upRouter，使写入的 spec 文件可解析。
      const setup = createTestApp(freshDb, {
        upRouterFsOps: {
          exists: (p: string) => fs.existsSync(p),
          readFile: (p: string) => fs.readFileSync(p, "utf-8"),
          readHead: (p: string, n: number) => {
            const fd = fs.openSync(p, "r");
            try {
              const buf = Buffer.alloc(n);
              const bytes = fs.readSync(fd, buf, 0, n, 0);
              return buf.subarray(0, bytes);
            } finally {
              fs.closeSync(fd);
            }
          },
        },
      });
      const freshApp = setup.app;
      const bootstrapOrch = setup.bootstrapOrchestrator;

      // 写入有效 pod spec 文件，使 route 的 pre-bootstrap resolution 路径成功并到达 bootstrap()。
      const podSpecYaml = `
version: "0.2"
name: conveyor-attention-route-test
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
edges: []
`.trim();
      const specPath = path.join(tmpDir, "attention-route-spec.yaml");
      fs.writeFileSync(specPath, podSpecYaml);

      // stub orchestrator bootstrap，使其发出真实 trust-gated launch 预期的
      // partial+blocked+attention shape。route 必须将其转换为 409。
      const stubResult = {
        runId: "run-stub-1",
        status: "partial" as const,
        rigId: "rig-stub-1",
        stages: [
          { stage: "resolve_spec" as const, status: "ok" as const, detail: {} },
          {
            stage: "import_rig" as const,
            status: "blocked" as const,
            detail: {
              code: "attention_required",
              message: "1 node requires attention before becoming interactive (rig parked, NOT failed; approve and resume to proceed).",
              rigId: "rig-stub-1",
              specName: "conveyor-attention-route-test",
              nodes: [{ logicalId: "dev.impl", status: "attention_required" as const, sessionName: "dev-impl@conveyor-attention-route-test", evidence: "trust prompt" }],
              attentionNodes: [
                { logicalId: "dev.impl", sessionName: "dev-impl@conveyor-attention-route-test", evidence: "trust prompt", reason: "trust_gate" },
              ],
            },
          },
        ],
        errors: ["1 node requires attention before becoming interactive (rig parked, NOT failed; approve and resume to proceed)."],
        warnings: [],
      };
      const origBootstrap = bootstrapOrch.bootstrap.bind(bootstrapOrch);
      bootstrapOrch.bootstrap = (async () => stubResult) as typeof bootstrapOrch.bootstrap;
      // 同时 stub release()，避免尝试释放 orchestrator 内部 map 中未知的 sourceRef key。
      const origRelease = bootstrapOrch.release.bind(bootstrapOrch);
      bootstrapOrch.release = (() => undefined) as typeof bootstrapOrch.release;

      try {
        const res = await freshApp.request("/api/up", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceRef: specPath }),
        });

        // re-verify 的 BLOCKER-2：route 必须返回 409（不是 200 partial-success，也不是 201 completed）。
        expect(res.status).toBe(409);
        const body = await res.json();
        // HG-4 三段式 error shape。
        expect(body.error).toBeDefined();
        expect(body.error.fact).toMatch(/requires attention/i);
        expect(body.error.consequence).toMatch(/rig-stub-1/);
        expect(body.error.consequence).toMatch(/rig ps/);
        expect(body.error.action).toMatch(/tmux attach -t dev-impl@conveyor-attention-route-test/);
        expect(body.error.action).not.toMatch(/rig setup --cwd/);
        // attentionNodes array 原样传给 operator
        expect(body.attentionNodes).toBeInstanceOf(Array);
        expect(body.attentionNodes).toHaveLength(1);
        expect(body.attentionNodes[0].logicalId).toBe("dev.impl");
        // bootstrap 的 partial result 仍携带 rigId，供 `zrig ps` 查询
        expect(body.rigId).toBe("rig-stub-1");
        // status 保持 "partial"，使下游 tooling 可以分支
        expect(body.status).toBe("partial");
      } finally {
        bootstrapOrch.bootstrap = origBootstrap;
        bootstrapOrch.release = origRelease;
        freshDb.close();
      }
      // 恢复 db，避免 afterEach 的 close() 重复关闭；但 afterEach 会关闭上方已关闭的原始 `db`，
      // 因此在剩余 teardown 中将其替换为 no-op stub。
      db = { close: () => undefined } as unknown as Database.Database;
    });
  });

  // --- OPR.0.3.2.22 Bug 1 BONUS——带已知 code 的 import_rig stage failure
  //     （cycle_error、preflight_failed、validation_failed、service_boot_failed）以 HTTP 4xx
  //     呈现，code 位于 response body 顶层。CLI up.ts:208-227 已针对这些 code 按
  //     res.data["code"] 分支——daemon 只需将 code 放在 CLI 查找的位置，避免 operator 只能看到
  //     裸 500，而真正原因埋在 stages[N].detail.code 中。
  //
  //     conveyor delegates_to cycle（f3449baf 已在 main）是 openrig-comms hero-flow dogfood
  //     报告的直接表现。此回归也固定更通用的契约。
  describe("OPR.0.3.2.22 Bug 1 BONUS：import_rig stage failure 映射为带顶层 code 的 HTTP 4xx", () => {
    let specDir: string;
    let app3: ReturnType<typeof createTestApp>["app"];
    let db3: Database.Database;

    beforeEach(() => {
      specDir = fs.mkdtempSync(path.join(os.tmpdir(), "up-route-import-rig-fail-"));

      for (const name of ["builder", "reviewer"]) {
        const agentDir = path.join(specDir, "agents", name);
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(
          path.join(agentDir, "agent.yaml"),
          `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n`,
        );
      }

      db3 = createFullTestDb();
      const realRouterFsOps = {
        exists: (p: string) => fs.existsSync(p),
        readFile: (p: string) => fs.readFileSync(p, "utf-8"),
        readHead: (p: string, n: number) => {
          const buf = Buffer.alloc(n);
          const fd = fs.openSync(p, "r");
          try { fs.readSync(fd, buf, 0, n, 0); } finally { fs.closeSync(fd); }
          return buf;
        },
      };
      const realInstantiatorFsOps = {
        exists: (p: string) => fs.existsSync(p),
        readFile: (p: string) => fs.readFileSync(p, "utf-8"),
      };
      const setup3 = createTestApp(db3, {
        upRouterFsOps: realRouterFsOps,
        podInstantiatorFsOps: realInstantiatorFsOps,
      });
      app3 = setup3.app;
    });

    afterEach(() => {
      db3.close();
      fs.rmSync(specDir, { recursive: true, force: true });
    });

    it("apply-mode delegates_to cycle 返回 HTTP 400，且顶层 code=cycle_error", async () => {
      const yaml = `version: "0.2"
name: cycle-bug-rig
pods:
  - id: build
    label: Build
    members:
      - id: builder
        agent_ref: local:agents/builder
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
  - id: review
    label: Review
    members:
      - id: reviewer
        agent_ref: local:agents/reviewer
        profile: default
        runtime: claude-code
        cwd: .
    edges: []
edges:
  - from: build.builder
    to: review.reviewer
    kind: delegates_to
  - from: review.reviewer
    to: build.builder
    kind: delegates_to
`;
      const specPath = path.join(specDir, "cycle.yaml");
      fs.writeFileSync(specPath, yaml, "utf-8");

      const res = await app3.request("/api/up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceRef: specPath }),
      });

      const bodyForDebug = await res.clone().json();
      expect(res.status, `expected 400 for import_rig cycle_error, got ${res.status} with body ${JSON.stringify(bodyForDebug)}`).toBe(400);
      const body = await res.json() as { code?: string; stages?: Array<{ stage: string; status: string; detail?: { code?: string } }> };

      // 关键修复：code 出现在 CLI 查询的顶层。
      expect(body.code, `expected top-level code=cycle_error, got body=${JSON.stringify(body)}`).toBe("cycle_error");

      // Provenance discriminator——证明 code 来自 import_rig stage（不是现有 400 mapping 路径
      // 已处理的 resolve_spec 误分类）。
      const importRigStage = (body.stages ?? []).find((s) => s.stage === "import_rig");
      expect(importRigStage, `expected import_rig stage in body.stages, got ${JSON.stringify(body.stages)}`).toBeDefined();
      expect(importRigStage!.status).toBe("failed");
      expect(importRigStage!.detail?.code).toBe("cycle_error");
    });
  });
});
