// lifecycle 重启/恢复 scenario 矩阵的 Tier 1 进程内基础证明。每个 scenario 一个 suite。
// 在 adapter 边界 mock tmuxExec/cmuxExec；通过 createDaemon/createFullTestDb 使用内存 SQLite。
//
// Slice 包：
//   <shared-docs>/missions/primitive-hardening/
//   slices/lifecycle-reboot-recovery-scenario-matrix/

import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createDaemon } from "../src/startup.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { TmuxAdapter, type ExecFn } from "../src/adapters/tmux.js";
import type { ResumeResult } from "../src/adapters/claude-resume.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { PsProjectionService } from "../src/domain/ps-projection.js";

// ---------------------------------------------------------------------------
// 共享 helper
// ---------------------------------------------------------------------------

function seedDbWithStaleSessions(
  dbPath: string,
  rigs: { rigName: string; logicalId: string; sessionName: string }[],
): void {
  const db = createDb(dbPath);
  migrate(db, [
    coreSchema,
    bindingsSessionsSchema,
    eventsSchema,
    nodeSpecFieldsSchema,
    checkpointsSchema,
    agentspecRebootSchema,
  ]);
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  for (const r of rigs) {
    const rig = rigRepo.createRig(r.rigName);
    const node = rigRepo.addNode(rig.id, r.logicalId);
    const session = sessionRegistry.registerSession(node.id, r.sessionName);
    sessionRegistry.updateStatus(session.id, "running");
  }
  db.close();
}

function unavailableCmuxExec(): ExecFn {
  return async () => {
    throw Object.assign(new Error(""), { code: "ENOENT" });
  };
}

function captureLog<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return (async () => {
    try {
      const value = await fn();
      return { value, lines };
    } finally {
      logSpy.mockRestore();
    }
  })();
}

function mockTmuxForRestore(overrides?: Partial<{
  hasSession: boolean | (() => Promise<boolean>);
  paneCommand: string;
  paneContent: string;
}>): TmuxAdapter {
  const hasSessionVal = overrides?.hasSession ?? true;
  const hasSessionFn = typeof hasSessionVal === "function"
    ? hasSessionVal
    : async () => hasSessionVal;
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendShellCommand: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => overrides?.paneCommand ?? "claude"),
    capturePaneContent: vi.fn(async () => overrides?.paneContent ?? ""),
    hasSession: vi.fn(hasSessionFn),
    probeSession: vi.fn(async () =>
      (await hasSessionFn()) ? { state: "present" as const } : { state: "absent" as const }
    ),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
  } as unknown as TmuxAdapter;
}

function mockClaudeResumeReturning(result: ResumeResult): ClaudeResumeAdapter {
  return {
    canResume: vi.fn((type: string | null) => type === "claude_name" || type === "claude_id"),
    resume: vi.fn(async () => result),
  } as unknown as ClaudeResumeAdapter;
}

function mockCodexResumeReturning(result: ResumeResult): CodexResumeAdapter {
  return {
    canResume: vi.fn((type: string | null) => type === "codex_id" || type === "codex_last"),
    resume: vi.fn(async () => result),
  } as unknown as CodexResumeAdapter;
}

// ---------------------------------------------------------------------------
// Scenario 测试套件
// ---------------------------------------------------------------------------

describe("Lifecycle 重启/恢复 scenario 矩阵（Tier 1）", () => {
  describe("Scenario 1：干净启动（空 DB、无 rig）", () => {
    it("后台服务启动，reconciliation 汇总行为 rigs=0 checked=0 detached=0 errors=0", async () => {
      const tmuxExec: ExecFn = async () => "";
      const cmuxExec = unavailableCmuxExec();

      const { value, lines } = await captureLog(async () =>
        createDaemon({ tmuxExec, cmuxExec }),
      );

      const summary = lines.find((line) => line.startsWith("启动协调："));
      expect(summary).toBeDefined();
      expect(summary).toMatch(/rigs=0\b/);
      expect(summary).toMatch(/checked=0\b/);
      expect(summary).toMatch(/detached=0\b/);
      expect(summary).toMatch(/errors=0\b/);

      // 干净启动时没有虚假的 session.detached event。
      const detachedEvents = value.db
        .prepare("SELECT type FROM events WHERE type = 'session.detached'")
        .all();
      expect(detachedEvents).toHaveLength(0);

      value.db.close();
    });
  });

  describe("Scenario 2：热恢复（后台服务重启，tmux 仍存活）", () => {
    it("存活 tmux session 不标为 detached；汇总显示 detached=0", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-matrix-warm-"));
      const dbPath = path.join(tmpDir, "warm.sqlite");
      seedDbWithStaleSessions(dbPath, [
        { rigName: "r01", logicalId: "dev1-impl", sessionName: "r01-dev1-impl" },
      ]);

      // tmux 存活；has-session 成功返回（stdout 为空，不抛错）。
      const tmuxExec: ExecFn = async () => "";
      const cmuxExec = unavailableCmuxExec();

      const { value, lines } = await captureLog(async () =>
        createDaemon({ dbPath, tmuxExec, cmuxExec }),
      );

      const sessions = value.db
        .prepare("SELECT status FROM sessions")
        .all() as { status: string }[];
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.status).toBe("running");

      const detachedEvents = value.db
        .prepare("SELECT type FROM events WHERE type = 'session.detached'")
        .all();
      expect(detachedEvents).toHaveLength(0);

      const summary = lines.find((line) => line.startsWith("启动协调："));
      expect(summary).toMatch(/detached=0\b/);
      expect(summary).toMatch(/errors=0\b/);

      value.db.close();
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe("Scenario 3：主机重启 / tmux socket 缺失（事后修复 #1、#2）", () => {
    // 每个 absence 类错误都必须分类为 session 缺失，不能崩溃，也不能静默保留 running 标记。
    it.each([
      ["error connecting to /private/tmp/tmux-501/default (No such file or directory)"],
      ["error connecting to /private/tmp/tmux-501/default (Connection refused)"],
      ["no server running on /private/tmp/tmux-501/default"],
      ["can't find session: r01-dev1-impl"],
      ["session not found"],
    ])("将 %s 分类为缺失；session 标为 detached 并发出 event", async (errMsg) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-matrix-reboot-"));
      const dbPath = path.join(tmpDir, "reboot.sqlite");
      seedDbWithStaleSessions(dbPath, [
        { rigName: "r01", logicalId: "dev1-impl", sessionName: "r01-dev1-impl" },
      ]);

      const tmuxExec: ExecFn = async (cmd: string) => {
        if (cmd.includes("has-session")) throw new Error(errMsg);
        return "";
      };
      const cmuxExec = unavailableCmuxExec();

      const { db } = await createDaemon({ dbPath, tmuxExec, cmuxExec });

      const sessions = db.prepare("SELECT status FROM sessions").all() as { status: string }[];
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.status).toBe("detached");

      const detachedEvents = db
        .prepare("SELECT type FROM events WHERE type = 'session.detached'")
        .all();
      expect(detachedEvents).toHaveLength(1);

      db.close();
      fs.rmSync(tmpDir, { recursive: true });
    });

    // 负例：permission-denied tmux probe 不得分类为缺失。Session 保持 running（关闭失败），意外
    // probe 错误记录到汇总的 errors=N 计数和一条警告行中。
    it("permission-denied tmux probe 保持非 detached（关闭失败）并显示警告", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-matrix-permerr-"));
      const dbPath = path.join(tmpDir, "permerr.sqlite");
      seedDbWithStaleSessions(dbPath, [
        { rigName: "r02", logicalId: "dev2-impl", sessionName: "r02-dev2-impl" },
      ]);

      const tmuxExec: ExecFn = async (cmd: string) => {
        if (cmd.includes("has-session")) {
          throw new Error("error: permission denied (EACCES)");
        }
        return "";
      };
      const cmuxExec = unavailableCmuxExec();

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { value, lines } = await captureLog(async () =>
        createDaemon({ dbPath, tmuxExec, cmuxExec }),
      );

      try {
        // probe 失败有歧义时不得把 session 标为 detached。
        const sessions = value.db
          .prepare("SELECT status FROM sessions")
          .all() as { status: string }[];
        expect(sessions).toHaveLength(1);
        expect(sessions[0]!.status).toBe("running");

        // 没有 detached event。
        const detached = value.db
          .prepare("SELECT type FROM events WHERE type = 'session.detached'")
          .all();
        expect(detached).toHaveLength(0);

        // 汇总记录错误数。
        const summary = lines.find((line) => line.startsWith("启动协调："));
        expect(summary).toMatch(/errors=1\b/);
        expect(summary).toMatch(/detached=0\b/);

        // 发出逐 session 警告行。
        const warnCalls = warnSpy.mock.calls.map((c) => String(c[0] ?? ""));
        const sessWarn = warnCalls.find((line) =>
          line.startsWith("启动协调警告：") && line.includes("session="),
        );
        expect(sessWarn).toBeDefined();
        expect(sessWarn).toContain("permission denied");

        value.db.close();
      } finally {
        warnSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true });
      }
    });
  });

  describe("Scenario 4：Provider auth 丢失", () => {
    // Helper：构建 orchestrator，并播种包含通过 claude_name 请求 resume 的 Claude 节点 snapshot
    //（legacy resume 路径）。
    function setupClaudeAttentionRequiredScenario(opts: {
      claudeResult: ResumeResult;
    }) {
      const db = createFullTestDb();
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const snapshotRepo = new SnapshotRepository(db);
      const checkpointStore = new CheckpointStore(db);
      const snapshotCapture = new SnapshotCapture({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore,
      });
      const tmux = mockTmuxForRestore({ hasSession: false }); // session does not exist yet
      const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
      const orchestrator = new RestoreOrchestrator({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
        checkpointStore, nodeLauncher, tmuxAdapter: tmux,
        claudeResume: mockClaudeResumeReturning(opts.claudeResult),
        codexResume: mockCodexResumeReturning({ ok: true }),
      });

      // 播种 rig、node 和包含可恢复 session 的 snapshot。
      const rig = rigRepo.createRig("r88");
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code", cwd: "/tmp" });
      const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
      // 修改持久化 snapshot 以嵌入 resume_token，使 orchestrator 对非 pod-aware 节点走 legacy
      // resume 路径。
      const fullSnap = snapshotRepo.getSnapshot(snap.id)!;
      const data = JSON.parse(JSON.stringify(fullSnap.data));
      data.sessions = [{
        id: "sess-1",
        nodeId: node.id,
        sessionName: "r88-worker",
        status: "running",
        resumeType: "claude_name",
        resumeToken: "tok-abc",
        restorePolicy: "resume_if_possible",
      }];
      data.activeSessionIdByNode = { [node.id]: "sess-1" };
      data.activeOccupantsByNode = { [node.id]: { kind: "resolved", sessionId: "sess-1" } };
      db.prepare("UPDATE snapshots SET data = ? WHERE id = ?")
        .run(JSON.stringify(data), snap.id);

      return { db, rigRepo, sessionRegistry, eventBus, snapshotRepo, orchestrator, rig, node, snapshotId: snap.id };
    }

    it("Claude resume 返回 attention_required 时节点 status=attention_required 且带 prompt evidence", async () => {
      const ctx = setupClaudeAttentionRequiredScenario({
        claudeResult: {
          ok: false,
          code: "attention_required",
          message: "Claude is at a resume-selection prompt; an operator must choose the conversation to continue.",
          evidence: "Choose a conversation to resume:\n  1. project-foo\n  2. project-bar",
        },
      });

      const outcome = await ctx.orchestrator.restore(ctx.snapshotId);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(`restore failed: ${outcome.code}`);

      // 逐节点 status 携带 attention_required，而非 failed。
      const workerNode = outcome.result.nodes.find((n) => n.nodeId === ctx.node.id);
      expect(workerNode?.status).toBe("attention_required");
      // 节点结果保留 evidence。
      expect(workerNode?.attentionEvidence).toBeDefined();
      expect(workerNode?.attentionEvidence).toContain("Choose a conversation");

      // Rig 级 rollup：任一 attention_required（且至少一个非 failed）产生 partially_restored，
      // 而非 failed。
      expect(outcome.result.rigResult).toBe("partially_restored");

      ctx.db.close();
    });

    // Codex 侧——关闭 fire-and-forget 留下的假阳性 `resumed` 结构。本 slice 的 driver 补丁增加
    // Codex verifyResume，使用现有 native-resume-probe Codex 结果镜像 Claude。
    describe("Codex verifyResume（本 slice 的 driver 补丁）", () => {
      // 使用真实 CodexResumeAdapter 和受控 tmux mock，验证补丁真实连接 probe + tmux；不增加探针模式。
      const fastOptions = { pollMs: 1, maxWaitMs: 5, sleep: async () => {} };

      it("probe 看到可交互 Codex prompt 时返回 {ok: true}", async () => {
        const tmux = mockTmuxForRestore({ paneCommand: "codex", paneContent: "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything" });
        const adapter = new CodexResumeAdapter(tmux, fastOptions);

        const r = await adapter.resume("r99-worker", "codex_id", "tok-abc", "/tmp");

        expect(tmux.sendShellCommand).toHaveBeenCalledWith("r99-worker", "codex -s workspace-write resume 'tok-abc'");
        expect(tmux.sendText).not.toHaveBeenCalled();
        expect(r).toEqual({
          ok: true,
          appliedLaunch: {
            runtime: "codex",
            axis: "sandbox",
            state: "observed",
            value: "workspace-write",
            reason: "emitted_launch_arguments",
          },
        });
      });

      it("没有可交互 prompt 的 Codex 进程不算成功 resume", async () => {
        const tmux = mockTmuxForRestore({ paneCommand: "codex", paneContent: "" });
        const adapter = new CodexResumeAdapter(tmux, fastOptions);
        const result = await adapter.resume("r99-worker", "codex_id", "tok-abc", "/tmp");
        expect(result).toMatchObject({ ok: false, code: "resume_failed" });
      });

      it("probe 看到 `No saved session found` 时返回 {ok:false, code:'retry_fresh'}，不静默返回 ok:true", async () => {
        const tmux = mockTmuxForRestore({
          paneCommand: "codex",
          paneContent: "Error: No saved session found for that token.",
        });
        const adapter = new CodexResumeAdapter(tmux, fastOptions);

        const r = await adapter.resume("r99-worker", "codex_id", "tok-abc", "/tmp");

        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe("retry_fresh");
      });

      it("pane 返回 shell 时返回 {ok:false, code:'retry_fresh'}，不静默返回 ok:true", async () => {
        const tmux = mockTmuxForRestore({ paneCommand: "zsh", paneContent: "" });
        const adapter = new CodexResumeAdapter(tmux, fastOptions);

        const r = await adapter.resume("r99-worker", "codex_id", "tok-abc", "/tmp");

        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe("retry_fresh");
      });

      // Codex auth-refusal 端到端转为 attention_required，关闭此前记录在本文件中的延期项。
      // 由 codex-auth-refusal-attention-required slice 通过以下方式实现：
      //   (a) native-resume-probe.ts 中的 `looksLikeCodexAuthRefusal`；
      //   (b) codex-resume.ts 中的 `attention_required` 透传；
      //   (c) restore-orchestrator.ts:944-960 中的 Codex 分支转换。
      // restore-orchestrator.ts:725-735 中与 runtime 无关的逐节点 mapping，为两个 runtime 都输出
      // 带 `attentionEvidence` 的 `status: "attention_required"`，无需额外接线。
      it("Codex auth-refusal 产生 node status=attention_required 及 auth-refusal pane evidence", async () => {
        const db = createFullTestDb();
        const rigRepo = new RigRepository(db);
        const sessionRegistry = new SessionRegistry(db);
        const eventBus = new EventBus(db);
        const snapshotRepo = new SnapshotRepository(db);
        const checkpointStore = new CheckpointStore(db);
        const snapshotCapture = new SnapshotCapture({
          db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore,
        });
        const tmux = mockTmuxForRestore({ hasSession: false });
        const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });

        // Codex adapter stub 返回真实 adapter 遇到 auth-refusal 时会输出的相同结构：
        // { ok: false, code: "attention_required", message, evidence }，其中 evidence 是 pane 内容
        // 最后 12 行。覆盖本 slice 修补的 restore-orchestrator Codex 分支转换。
        const refusalEvidence = [
          "$ codex resume tok-codex",
          "Error: Your access token could not be refreshed because you have since",
          "logged out or signed in to another account. Please sign in again.",
        ].join("\n");
        const codexAttentionResult: ResumeResult = {
          ok: false,
          code: "attention_required",
          message: "Codex could not refresh the stored access token; an operator must sign in again before the session can resume.",
          evidence: refusalEvidence,
        };
        const orchestrator = new RestoreOrchestrator({
          db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
          checkpointStore, nodeLauncher, tmuxAdapter: tmux,
          claudeResume: mockClaudeResumeReturning({ ok: true }),
          codexResume: mockCodexResumeReturning(codexAttentionResult),
        });

        const rig = rigRepo.createRig("r97");
        const node = rigRepo.addNode(rig.id, "codex-worker", { role: "worker", runtime: "codex", cwd: "/tmp" });
        const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
        const fullSnap = snapshotRepo.getSnapshot(snap.id)!;
        const data = JSON.parse(JSON.stringify(fullSnap.data));
        data.sessions = [{
          id: "sess-codex-1",
          nodeId: node.id,
          sessionName: "r97-codex-worker",
          status: "running",
          resumeType: "codex_id",
          resumeToken: "tok-codex",
          restorePolicy: "resume_if_possible",
        }];
        data.activeSessionIdByNode = { [node.id]: "sess-codex-1" };
        data.activeOccupantsByNode = { [node.id]: { kind: "resolved", sessionId: "sess-codex-1" } };
        db.prepare("UPDATE snapshots SET data = ? WHERE id = ?")
          .run(JSON.stringify(data), snap.id);

        const outcome = await orchestrator.restore(snap.id);
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) throw new Error(`restore failed: ${outcome.code}`);

        // 逐节点 status：attention_required，而非 failed 或 resumed。
        const codexNode = outcome.result.nodes.find((n) => n.nodeId === node.id);
        expect(codexNode?.status).toBe("attention_required");
        // 通过 restore-orchestrator.ts:725-735 中与 runtime 无关的 mapping，在节点结果上保留 evidence。
        expect(codexNode?.attentionEvidence).toBeDefined();
        expect(codexNode?.attentionEvidence).toContain("access token could not be refreshed");
        expect(codexNode?.attentionEvidence).toContain("Please sign in again");

        // Rig 级 rollup：单个 attention_required 节点产生 partially_restored，而非 failed。
        // restore-orchestrator.ts:65 的聚合已把 attention_required 纳入混合状态集合；本测试确认
        // Codex 如实参与。
        expect(outcome.result.rigResult).toBe("partially_restored");

        db.close();
      });

      // 感知 pod 的 Codex auth-refusal 端到端路径。感知 pod 的 Codex 节点在生产中沿
      // `launchHarness` → `verifyResumeLaunch` → probe → `recovery: "attention_required"` →
      // startup-orchestrator 返回 `startupStatus: "attention_required"` → restore-orchestrator 提升的
      // pod-aware mapping 显示带 `attentionEvidence` 的 `status: "attention_required"`。关闭 revision 1
      // 发现的 gap（commit 63ee206 只覆盖 legacy CodexResumeAdapter 路径）。
      it("感知 pod 的 Codex auth-refusal 产生 node status=attention_required（生产路径）", async () => {
        const db = createFullTestDb();
        const rigRepo = new RigRepository(db);
        const sessionRegistry = new SessionRegistry(db);
        const eventBus = new EventBus(db);
        const snapshotRepo = new SnapshotRepository(db);
        const checkpointStore = new CheckpointStore(db);
        const snapshotCapture = new SnapshotCapture({
          db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore,
        });
        const tmux = mockTmuxForRestore();
        const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });

        const rig = rigRepo.createRig("r96");
        // Pod-aware 设置镜像 restore-orchestrator.test.ts:1296-1362 的模式
        //（pods 行 + node.podId + node_startup_context + snapshot）。
        db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)")
          .run("pod-codex-attention", rig.id, "Codex");
        const node = rigRepo.addNode(rig.id, "dev.qa", {
          role: "worker", runtime: "codex", podId: "pod-codex-attention",
        });
        const session = sessionRegistry.registerSession(node.id, "dev-qa@r96");
        sessionRegistry.updateStatus(session.id, "running");
        sessionRegistry.updateResumeToken(session.id, "codex_id", "stale-codex-token");
        db.prepare(
          "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
        ).run(node.id, "[]", "[]", "[]", "codex");
        const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
        // 重置为 "exited"，使 restore 真正尝试启动。
        sessionRegistry.updateStatus(session.id, "exited");
        db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

        // Codex runtime adapter 的 launchHarness 返回本 revision 引入的新结构：ok:false、
        // recovery: "attention_required" 以及 pane 最后 12 行 evidence。
        const refusalEvidence = [
          "$ codex resume stale-codex-token",
          "Error: Your access token could not be refreshed because you have since",
          "logged out or signed in to another account. Please sign in again.",
        ].join("\n");
        const codexLaunchAttentionResult = {
          ok: false as const,
          error: "Codex could not refresh the stored access token; an operator must sign in again before the session can resume.",
          recovery: "attention_required" as const,
          evidence: refusalEvidence,
        };
        const launchHarness = vi.fn().mockResolvedValue(codexLaunchAttentionResult);
        const mockCodexAdapter = {
          runtime: "codex",
          listInstalled: vi.fn(async () => []),
          project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
          deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
          checkReady: vi.fn(async () => ({ ready: true })),
          launchHarness,
        };

        const orchestrator = new RestoreOrchestrator({
          db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
          checkpointStore, nodeLauncher, tmuxAdapter: tmux,
          claudeResume: mockClaudeResumeReturning({ ok: true }),
          codexResume: mockCodexResumeReturning({ ok: true }),
        });

        const outcome = await orchestrator.restore(snap.id, {
          adapters: { codex: mockCodexAdapter },
        });

        expect(outcome.ok).toBe(true);
        if (!outcome.ok) throw new Error(`restore failed: ${outcome.code}`);

        const codexNode = outcome.result.nodes.find((n) => n.nodeId === node.id);
        expect(codexNode?.status).toBe("attention_required");
        expect(codexNode?.attentionEvidence).toBeDefined();
        expect(codexNode?.attentionEvidence).toContain("access token could not be refreshed");
        expect(codexNode?.attentionEvidence).toContain("Please sign in again");

        // Rig 级 rollup：单个 attention_required 节点产生 partially_restored。
        expect(outcome.result.rigResult).toBe("partially_restored");

        // launchHarness 只调用一次；attention_required 不触发 fresh-fallback（auth-refusal 可由操作员
        // 恢复，不是 stale-token 信号）。startup orchestrator 新分支区分
        // recovery: "attention_required" 与 "retry_fresh"。
        expect(launchHarness).toHaveBeenCalledTimes(1);

        db.close();
      });
    });
  });

  describe("Scenario 5：部分启动", () => {
    function buildOrchestratorWithMixedNodes() {
      const db = createFullTestDb();
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const snapshotRepo = new SnapshotRepository(db);
      const checkpointStore = new CheckpointStore(db);
      const snapshotCapture = new SnapshotCapture({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore,
      });

      // Mock Claude 为一个节点返回 attention_required，另一个成功；Codex 为第三个返回 failed。
      // 播种共享一个 snapshot 的三个节点。
      const tmux = {
        ...mockTmuxForRestore({ hasSession: false }),
        listPanes: vi.fn(async () => [{ id: "%1", index: 0, cwd: "/", width: 80, height: 24, active: true }]),
        getPanePid: vi.fn(async () => 1234),
      } as unknown as TmuxAdapter;
      const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
      // 按 sessionName 分派，使测试不依赖迭代顺序。
      const claudeStub = {
        canResume: vi.fn((type: string | null) => type === "claude_name" || type === "claude_id"),
        resume: vi.fn(async (sessionName: string) => {
          if (sessionName.includes("claude-ok")) return { ok: true as const };
          return {
            ok: false as const,
            code: "attention_required",
            message: "Claude resume-selection prompt",
            evidence: "Choose a conversation:\n  1. foo",
          };
        }),
      } as unknown as ClaudeResumeAdapter;
      const codexStub = {
        canResume: vi.fn((type: string | null) => type === "codex_id" || type === "codex_last"),
        resume: vi.fn(async () => ({
          ok: false,
          code: "resume_failed",
          message: "Codex resume failed: timed out",
        })),
      } as unknown as CodexResumeAdapter;

      const orchestrator = new RestoreOrchestrator({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
        checkpointStore, nodeLauncher, tmuxAdapter: tmux,
        claudeResume: claudeStub, codexResume: codexStub,
        listProcesses: async () => [
          { pid: 1234, ppid: 1, command: "zsh" },
          { pid: 5678, ppid: 1234, command: "claude --resume t1" },
        ],
      });

      const rig = rigRepo.createRig("r77");
      const claudeOk = rigRepo.addNode(rig.id, "claude-ok", { role: "worker", runtime: "claude-code", cwd: "/tmp" });
      const claudeAtt = rigRepo.addNode(rig.id, "claude-att", { role: "worker", runtime: "claude-code", cwd: "/tmp" });
      const codexFail = rigRepo.addNode(rig.id, "codex-fail", { role: "worker", runtime: "codex", cwd: "/tmp" });
      const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
      const fullSnap = snapshotRepo.getSnapshot(snap.id)!;
      const data = JSON.parse(JSON.stringify(fullSnap.data));
      data.sessions = [
        { id: "s-ok", nodeId: claudeOk.id, sessionName: "r77-claude-ok",
          status: "running", resumeType: "claude_name", resumeToken: "t1",
          restorePolicy: "resume_if_possible" },
        { id: "s-att", nodeId: claudeAtt.id, sessionName: "r77-claude-att",
          status: "running", resumeType: "claude_name", resumeToken: "t2",
          restorePolicy: "resume_if_possible" },
        { id: "s-fail", nodeId: codexFail.id, sessionName: "r77-codex-fail",
          status: "running", resumeType: "codex_id", resumeToken: "t3",
          restorePolicy: "resume_if_possible" },
      ];
      data.activeSessionIdByNode = {
        [claudeOk.id]: "s-ok",
        [claudeAtt.id]: "s-att",
        [codexFail.id]: "s-fail",
      };
      data.activeOccupantsByNode = {
        [claudeOk.id]: { kind: "resolved", sessionId: "s-ok" },
        [claudeAtt.id]: { kind: "resolved", sessionId: "s-att" },
        [codexFail.id]: { kind: "resolved", sessionId: "s-fail" },
      };
      db.prepare("UPDATE snapshots SET data = ? WHERE id = ?")
        .run(JSON.stringify(data), snap.id);

      return { db, orchestrator, rig, snapshotId: snap.id, nodeIds: { claudeOk: claudeOk.id, claudeAtt: claudeAtt.id, codexFail: codexFail.id } };
    }

    it("混合 resumed + attention_required + failed 时 rigResult=partially_restored", async () => {
      const ctx = buildOrchestratorWithMixedNodes();

      const outcome = await ctx.orchestrator.restore(ctx.snapshotId);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(`restore failed: ${outcome.code}`);

      expect(outcome.result.rigResult).toBe("partially_restored");

      // restore.completed payload 保留逐节点状态。
      const map = Object.fromEntries(outcome.result.nodes.map((n) => [n.nodeId, n.status]));
      expect(map[ctx.nodeIds.claudeOk]).toBe("resumed");
      expect(map[ctx.nodeIds.claudeAtt]).toBe("attention_required");
      // OPR.0.3.4.2：已定论的 resume 失败回滚到零 session，并报告 awaiting-decision
      //（停止并询问），而非 failed。
      expect(map[ctx.nodeIds.codexFail]).toBe("awaiting-decision");

      // restore.completed event payload 保留逐节点判别。
      const completedRow = ctx.db
        .prepare("SELECT payload FROM events WHERE type = 'restore.completed' ORDER BY seq DESC LIMIT 1")
        .get() as { payload: string };
      const parsed = JSON.parse(completedRow.payload) as { result: { rigResult: string; nodes: Array<{ nodeId: string; status: string }> } };
      expect(parsed.result.rigResult).toBe("partially_restored");
      expect(parsed.result.nodes.find((n) => n.nodeId === ctx.nodeIds.claudeAtt)?.status).toBe("attention_required");

      ctx.db.close();
    });

    it("所有 resume 失败都停止并询问时 rigResult=partially_restored（awaiting-decision 不等于 failed）", async () => {
      const db = createFullTestDb();
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const snapshotRepo = new SnapshotRepository(db);
      const checkpointStore = new CheckpointStore(db);
      const snapshotCapture = new SnapshotCapture({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore,
      });
      const tmux = mockTmuxForRestore({ hasSession: false });
      const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
      const orchestrator = new RestoreOrchestrator({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
        checkpointStore, nodeLauncher, tmuxAdapter: tmux,
        claudeResume: mockClaudeResumeReturning({ ok: false, code: "resume_failed", message: "boom" }),
        codexResume: mockCodexResumeReturning({ ok: true }),
      });

      const rig = rigRepo.createRig("r66");
      const a = rigRepo.addNode(rig.id, "a", { role: "worker", runtime: "claude-code", cwd: "/tmp" });
      const b = rigRepo.addNode(rig.id, "b", { role: "worker", runtime: "claude-code", cwd: "/tmp" });
      const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
      const fullSnap = snapshotRepo.getSnapshot(snap.id)!;
      const data = JSON.parse(JSON.stringify(fullSnap.data));
      data.sessions = [
        { id: "s-a", nodeId: a.id, sessionName: "r66-a", status: "running",
          resumeType: "claude_name", resumeToken: "ta", restorePolicy: "resume_if_possible" },
        { id: "s-b", nodeId: b.id, sessionName: "r66-b", status: "running",
          resumeType: "claude_name", resumeToken: "tb", restorePolicy: "resume_if_possible" },
      ];
      data.activeSessionIdByNode = { [a.id]: "s-a", [b.id]: "s-b" };
      data.activeOccupantsByNode = {
        [a.id]: { kind: "resolved", sessionId: "s-a" },
        [b.id]: { kind: "resolved", sessionId: "s-b" },
      };
      db.prepare("UPDATE snapshots SET data = ? WHERE id = ?")
        .run(JSON.stringify(data), snap.id);

      const outcome = await orchestrator.restore(snap.id);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(`restore failed: ${outcome.code}`);
      // OPR.0.3.4.2：已定论的 resume 失败为 awaiting-decision（零 session、操作员必须选择），
      // 而非 failed，因此 rig 汇总为 partially_restored。真正的全 harness 失败 rollup 仍由启动失败测试覆盖。
      expect(outcome.result.rigResult).toBe("partially_restored");

      db.close();
    });
  });

  describe("Scenario 6：操作员恢复（reconcileNodeRuntimeTruth）", () => {
    function setupForReconcile(opts: {
      runtime: "claude-code" | "codex";
      restoreOutcome: "failed" | "attention_required";
      withResumeToken?: boolean;
      paneCommand?: string;
      paneContent?: string;
      hasSession?: boolean;
    }) {
      const db = createFullTestDb();
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const snapshotRepo = new SnapshotRepository(db);
      const checkpointStore = new CheckpointStore(db);
      const snapshotCapture = new SnapshotCapture({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore,
      });
      const tmux = mockTmuxForRestore({
        hasSession: opts.hasSession ?? true,
        paneCommand: opts.paneCommand ?? (opts.runtime === "codex" ? "codex" : "claude"),
        paneContent: opts.paneContent ?? "",
      });
      tmux.listPanes = vi.fn(async () => [{ id: "%1", index: 0, cwd: "/", width: 80, height: 24, active: true }]);
      tmux.getPanePid = vi.fn(async () => 1234);
      const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
      const orchestrator = new RestoreOrchestrator({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
        checkpointStore, nodeLauncher, tmuxAdapter: tmux,
        claudeResume: mockClaudeResumeReturning({ ok: true }),
        codexResume: mockCodexResumeReturning({ ok: true }),
        // 完整 ps 列：Codex identity 需要 pane 前台进程组、启动时间和可执行文件名
        //（native-process-lineage selectCodexProcess）；刻意不把 pid/ppid/command 本身当作充分正向证明。
        listProcesses: async () => [
          { pid: 1234, ppid: 1, pgid: 1234, tpgid: 5678, executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000", command: "zsh" },
          {
            pid: 5678,
            ppid: 1234,
            pgid: 5678,
            tpgid: 5678,
            executableName: opts.runtime === "codex" ? "codex" : "claude",
            startedAt: "Sat Jan  1 12:00:00 2000",
            command: opts.runtime === "codex" ? "codex resume tok-abc" : "claude --resume tok-abc",
          },
        ],
      });

      const rig = rigRepo.createRig(`r${Math.floor(Math.random() * 90) + 10}`);
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: opts.runtime });
      sessionRegistry.updateBinding(node.id, { tmuxSession: `${rig.name}-worker` });
      const sess = sessionRegistry.registerSession(node.id, `${rig.name}-worker`);
      if (opts.withResumeToken ?? true) {
        db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ? WHERE id = ?").run(
          opts.runtime === "codex" ? "codex_id" : "claude_id",
          "tok-abc",
          sess.id,
        );
      }
      eventBus.emit({ type: "restore.started", rigId: rig.id, snapshotId: "snap-recon" });
      eventBus.emit({
        type: "restore.completed",
        rigId: rig.id,
        snapshotId: "snap-recon",
        result: {
          snapshotId: "snap-recon",
          preRestoreSnapshotId: null,
          rigResult: "partially_restored",
          nodes: [{ nodeId: node.id, logicalId: "worker", status: opts.restoreOutcome }],
          warnings: [],
        },
      });

      return { db, orchestrator, rig, nodeId: node.id };
    }

    it("四项前置条件全部满足时将 failed 升级为 operator_recovered，并发出 restore.outcome_reconciled", async () => {
      const ctx = setupForReconcile({
        runtime: "claude-code",
        restoreOutcome: "failed",
        paneContent: "Claude Code v2.1.89\n ❯ accept edits on",
      });
      const result = await ctx.orchestrator.reconcileNodeRuntimeTruth(ctx.rig.id, ctx.nodeId);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.from).toBe("failed");
        expect(result.to).toBe("operator_recovered");
        expect(result.evidence).toEqual({
          tmux: true, fgProcess: "claude", resumeTokenUsed: true, paneState: "usable",
        });
      }

      const reconciled = ctx.db
        .prepare("SELECT type FROM events WHERE rig_id = ? AND type = 'restore.outcome_reconciled'")
        .all(ctx.rig.id);
      expect(reconciled).toHaveLength(1);

      // 原始 failure event 不被修改或删除（承重不变量）。
      const completed = ctx.db
        .prepare("SELECT payload FROM events WHERE rig_id = ? AND type = 'restore.completed'")
        .all(ctx.rig.id) as { payload: string }[];
      expect(completed).toHaveLength(1);
      const parsed = JSON.parse(completed[0]!.payload) as { result: { nodes: Array<{ status: string }> } };
      expect(parsed.result.nodes[0]!.status).toBe("failed");

      ctx.db.close();
    });

    // 按 planner 研究缺口，Codex 前台识别是承重行为
    //（restore-orchestrator.ts:1038 的 `paneCommand.startsWith("codex")`）。
    it("识别 Codex 前台进程：paneCommand='codex' 时 operator_recovered 且 fgProcess='codex'", async () => {
      const ctx = setupForReconcile({
        runtime: "codex",
        restoreOutcome: "failed",
        paneCommand: "codex",
        paneContent: "OpenAI Codex (v0.42.0)\n  ›  ready\n  gpt-5 · context",
      });
      const result = await ctx.orchestrator.reconcileNodeRuntimeTruth(ctx.rig.id, ctx.nodeId);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.evidence.fgProcess).toBe("codex");
      }

      ctx.db.close();
    });

    it("terminal 结果绝不产生 'ready'，只能是 operator_recovered", async () => {
      const ctx = setupForReconcile({
        runtime: "claude-code",
        restoreOutcome: "failed",
        paneContent: "Claude Code v2.1.89\n ❯ accept edits on",
      });
      const result = await ctx.orchestrator.reconcileNodeRuntimeTruth(ctx.rig.id, ctx.nodeId);
      if (result.ok) {
        expect(result.to).toBe("operator_recovered");
        expect((result.to as string)).not.toBe("ready");
      }
      const rows = ctx.db
        .prepare("SELECT payload FROM events WHERE type = 'restore.outcome_reconciled'")
        .all() as { payload: string }[];
      for (const row of rows) {
        const parsed = JSON.parse(row.payload) as { to: string };
        expect(parsed.to).toBe("operator_recovered");
      }
      ctx.db.close();
    });

    // 各前置条件的拒绝 code（承载真实 UX）。
    it("tmux probe 返回 false 时以 code=tmux_session_missing 拒绝升级", async () => {
      const ctx = setupForReconcile({
        runtime: "claude-code", restoreOutcome: "failed", hasSession: false,
      });
      const result = await ctx.orchestrator.reconcileNodeRuntimeTruth(ctx.rig.id, ctx.nodeId);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("tmux_session_missing");
      ctx.db.close();
    });

    it("pane 位于 shell 时以 code=process_lineage_mismatch 拒绝升级", async () => {
      const ctx = setupForReconcile({
        runtime: "claude-code", restoreOutcome: "failed",
        paneCommand: "zsh", paneContent: "$ ",
      });
      const result = await ctx.orchestrator.reconcileNodeRuntimeTruth(ctx.rig.id, ctx.nodeId);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("process_lineage_mismatch");
      ctx.db.close();
    });

    it("未记录 token 时以 code=resume_token_not_used 拒绝升级", async () => {
      const ctx = setupForReconcile({
        runtime: "claude-code", restoreOutcome: "failed",
        withResumeToken: false,
        paneContent: "Claude Code v2.1.89\n ❯ accept edits on",
      });
      const result = await ctx.orchestrator.reconcileNodeRuntimeTruth(ctx.rig.id, ctx.nodeId);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("resume_token_not_used");
      ctx.db.close();
    });

    it("pane 位于 Claude resume-selection prompt 时以 code=pane_not_usable 拒绝升级", async () => {
      const ctx = setupForReconcile({
        runtime: "claude-code", restoreOutcome: "attention_required",
        paneContent: "Choose a conversation to resume:\n  1. project-foo\n  2. project-bar",
      });
      const result = await ctx.orchestrator.reconcileNodeRuntimeTruth(ctx.rig.id, ctx.nodeId);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("pane_not_usable");
      ctx.db.close();
    });

    it("结果已 resumed 时以 code=outcome_not_upgradable 拒绝升级", async () => {
      const db = createFullTestDb();
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const snapshotRepo = new SnapshotRepository(db);
      const checkpointStore = new CheckpointStore(db);
      const snapshotCapture = new SnapshotCapture({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore,
      });
      const tmux = mockTmuxForRestore();
      const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
      const orchestrator = new RestoreOrchestrator({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
        checkpointStore, nodeLauncher, tmuxAdapter: tmux,
        claudeResume: mockClaudeResumeReturning({ ok: true }),
        codexResume: mockCodexResumeReturning({ ok: true }),
      });

      const rig = rigRepo.createRig("r55");
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
      sessionRegistry.updateBinding(node.id, { tmuxSession: "r55-worker" });
      eventBus.emit({ type: "restore.started", rigId: rig.id, snapshotId: "snap-x" });
      eventBus.emit({
        type: "restore.completed",
        rigId: rig.id,
        snapshotId: "snap-x",
        result: {
          snapshotId: "snap-x",
          preRestoreSnapshotId: null,
          rigResult: "fully_restored",
          nodes: [{ nodeId: node.id, logicalId: "worker", status: "resumed" }],
          warnings: [],
        },
      });

      const result = await orchestrator.reconcileNodeRuntimeTruth(rig.id, node.id);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("outcome_not_upgradable");

      db.close();
    });

    it("rig 没有 restore.started 时以 code=no_attempt 拒绝升级", async () => {
      const db = createFullTestDb();
      const rigRepo = new RigRepository(db);
      const sessionRegistry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const snapshotRepo = new SnapshotRepository(db);
      const checkpointStore = new CheckpointStore(db);
      const snapshotCapture = new SnapshotCapture({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore,
      });
      const tmux = mockTmuxForRestore();
      const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
      const orchestrator = new RestoreOrchestrator({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
        checkpointStore, nodeLauncher, tmuxAdapter: tmux,
        claudeResume: mockClaudeResumeReturning({ ok: true }),
        codexResume: mockCodexResumeReturning({ ok: true }),
      });

      const rig = rigRepo.createRig("r44");
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });

      const result = await orchestrator.reconcileNodeRuntimeTruth(rig.id, node.id);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("no_attempt");

      db.close();
    });
  });
});

// ===================================================================
// SLICE-05 第 5+6 项——跨契约不变量 RED（第 6 项回归）。不变量：实时 tmux session 已消失的席位
//（通过驱动真实 SessionTransport.send 和 .capture 证明；二者只在正向缺失证据下经
// tmuxAdapter.probeSession gate 返回 { ok:false, reason:"session_missing" }，OPR.0.5.4.2），
// 绝不能同时被 ps 报告为 running。ps.runningCount 读取原始持久化 sessions.status='running'，从不
// 查询实时 tmux，因此当前违反该不变量。使用同一 DB、同一 tmux adapter 和逐 session hasSession
// 事实。行 (b) 承重：对于最后/唯一 session，reconciler 在空 census 上发出 tmux_unavailable 而非
// session_missing，所以仅降低 verdict 无法满足；修复必须尊重确定性的 send/capture liveness。
// 这是结果层且与修法无关，不发明生产接缝。
// ===================================================================
describe("Slice-05 第 5+6 项——真实 send/capture 与 ps running（跨契约回归）", () => {
  function seedSeat(db: Database.Database, rigId: string, node: string, sessionName: string, pane: string): void {
    db.prepare("INSERT OR IGNORE INTO rigs (id, name) VALUES (?, ?)").run(rigId, rigId);
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd) VALUES (?, ?, ?, 'claude-code', '/tmp')").run(node, rigId, `pod.${node}`);
    db.prepare(
      "INSERT INTO sessions (id, node_id, session_name, status, startup_status, created_at) VALUES (?, ?, ?, 'running', 'ready', '2026-07-02 12:00:00')",
    ).run(`sess-${node}`, node, sessionName);
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_pane) VALUES (?, ?, 'tmux', ?, ?)").run(`bind-${node}`, node, sessionName, pane);
  }
  function tmuxWithLive(live: Set<string>): TmuxAdapter {
    return {
      hasSession: async (name: string) => live.has(name),
      probeSession: async (name: string) =>
        live.has(name) ? { state: "present" as const } : { state: "absent" as const },
      sendText: async () => ({ ok: true as const }),
      sendKeys: async () => ({ ok: true as const }),
      capturePaneContent: async () => "idle\n> ",
      createSession: async () => ({ ok: true as const }),
      killSession: async () => ({ ok: true as const }),
      listSessions: async () => [],
      listWindows: async () => [],
      listPanes: async () => [],
      startPipePane: async () => ({ ok: true as const }),
      stopPipePane: async () => ({ ok: true as const }),
      getPanePid: async () => null,
      getPaneCommand: async () => null,
    } as unknown as TmuxAdapter;
  }
  function transportFor(db: Database.Database, tmux: TmuxAdapter): SessionTransport {
    return new SessionTransport({ db, rigRepo: new RigRepository(db), sessionRegistry: new SessionRegistry(db), tmuxAdapter: tmux });
  }

  it("RED（仍有另一 session）：send+capture 的 session_missing 不得与 ps running 并存", async () => {
    const db = createFullTestDb();
    try {
      seedSeat(db, "rig-1", "n1", "s1@rig", "%1"); // 已死亡席位。
      seedSeat(db, "rig-1", "n2", "s2@rig", "%2"); // 另一存活席位仍在。
      const transport = transportFor(db, tmuxWithLive(new Set(["s2@rig"]))); // s1 消失，s2 存活。
      const send = await transport.send("s1@rig", "hi");
      const cap = await transport.capture("s1@rig");
      expect(send.ok).toBe(false);
      expect(send.reason).toBe("session_missing");
      expect(cap.ok).toBe(false);
      expect(cap.reason).toBe("session_missing");
      // 不变量：ps 不得把 send+capture 刚声明缺失的席位报告为 running。
      const rig = new PsProjectionService({ db }).getEntries()[0]!;
      expect(rig.runningCount).toBe(1); // <-- RED：当前为 2（伪造 s1 running）。
    } finally {
      db.close();
    }
  });

  it("RED（承重的最后/唯一 session）：send+capture 的 session_missing 不得与 ps running 并存", async () => {
    const db = createFullTestDb();
    try {
      seedSeat(db, "rig-1", "n1", "s1@rig", "%1"); // 唯一席位。
      const transport = transportFor(db, tmuxWithLive(new Set())); // 无存活 session（空 census）。
      const send = await transport.send("s1@rig", "hi");
      const cap = await transport.capture("s1@rig");
      expect(send.ok).toBe(false);
      expect(send.reason).toBe("session_missing");
      expect(cap.ok).toBe(false);
      expect(cap.reason).toBe("session_missing");
      const entry = new PsProjectionService({ db }).getEntries()[0]!;
      expect(entry.runningCount).toBe(0); // <-- RED：尽管已有确定 session_missing，当前仍为 1。
      expect(entry.status).not.toBe("running"); // <-- RED
    } finally {
      db.close();
    }
  });
});
