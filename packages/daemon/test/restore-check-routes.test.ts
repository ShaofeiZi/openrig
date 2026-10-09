import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { createApp } from "../src/server.js";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import {
  RestoreCheckService,
  // OPR.0.3.2.14——从 source 导入；此前在这里复制。
  CLAUDE_HOOKS_ROOT,
  CLAUDE_SESSION_START_COMPACT_COMMAND as REQUIRED_SESSION_START_COMPACT_COMMAND,
  CLAUDE_USER_PROMPT_SUBMIT_COMMAND as REQUIRED_USER_PROMPT_SUBMIT_COMMAND,
} from "../src/domain/restore-check-service.js";

const VALID_HOST_INFRA_DECLARATION = JSON.stringify({
  schemaVersion: 1,
  daemonBootstrap: {
    declared: true,
    mechanism: "launchd",
    evidence: "com.openrig.daemon",
  },
  supportingInfra: [
    {
      id: "supervisor-wake",
      declared: true,
      required: true,
      evidence: "kernel rig infra seat or host launch agent",
    },
  ],
});

function v2HostInfraDeclaration(overrides?: {
  daemonEvidencePaths?: string[];
  supportingInfraEvidencePaths?: string[];
}): string {
  return JSON.stringify({
    schemaVersion: 2,
    daemonBootstrap: {
      declared: true,
      mechanism: "launchd",
      evidence: "com.openrig.daemon",
      evidencePaths: overrides?.daemonEvidencePaths ?? ["${OPENRIG_HOME}/daemon/launchd.plist"],
    },
    supportingInfra: [
      {
        id: "supervisor-wake",
        declared: true,
        required: true,
        evidence: "kernel rig infra seat or host launch agent",
        evidencePaths: overrides?.supportingInfraEvidencePaths ?? ["${OPENRIG_HOME}/supervisor-wake/README.md"],
      },
    ],
  });
}

function claudeHookSettings(): string {
  return JSON.stringify({
    hooks: {
      SessionStart: [
        {
          matcher: "compact",
          hooks: [{ type: "command", command: REQUIRED_SESSION_START_COMPACT_COMMAND }],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [{ type: "command", command: REQUIRED_USER_PROMPT_SUBMIT_COMMAND }],
        },
      ],
    },
  });
}

function minimalSnapshotData(rigId: string, rigName: string) {
  return {
    rig: {
      id: rigId,
      name: rigName,
      createdAt: "2026-04-23T00:00:00.000Z",
      updatedAt: "2026-04-23T00:00:00.000Z",
    },
    nodes: [],
    edges: [],
    sessions: [],
    checkpoints: {},
  };
}

function insertStartupContextRow(db: Database.Database, nodeId: string, options?: {
  projectionEntriesJson?: string;
  resolvedFilesJson?: string;
  startupActionsJson?: string;
  runtime?: string;
}) {
  db.prepare(
    "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
  ).run(
    nodeId,
    options?.projectionEntriesJson ?? "[]",
    options?.resolvedFilesJson ?? "[]",
    options?.startupActionsJson ?? "[]",
    options?.runtime ?? "claude-code",
  );
}

describe("恢复检查路由", () => {
  let db: Database.Database;
  let app: Hono;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let snapshotRepo: SnapshotRepository;
  let openRigHome: string;
  let originalOpenRigHome: string | undefined;

  beforeEach(() => {
    originalOpenRigHome = process.env["OPENRIG_HOME"];
    openRigHome = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-route-openrig-home-"));
    process.env["OPENRIG_HOME"] = openRigHome;

    db = createFullTestDb();
    const setup = createTestApp(db);
    app = createApp(setup);
    rigRepo = setup.rigRepo;
    sessionRegistry = setup.sessionRegistry;
    snapshotRepo = setup.snapshotRepo;
  });

  afterEach(() => {
    db.close();
    if (originalOpenRigHome === undefined) delete process.env["OPENRIG_HOME"];
    else process.env["OPENRIG_HOME"] = originalOpenRigHome;
    fs.rmSync(openRigHome, { recursive: true, force: true });
  });

  it("GET /api/restore-check 返回带 verdict + checks + repairPacket 的 JSON", async () => {
    rigRepo.createRig("test-rig");

    const res = await app.request("/api/restore-check");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.verdict).toBeDefined();
    expect(["restorable", "restorable_with_caveats", "not_restorable", "unknown"]).toContain(body.verdict);
    expect(body.readiness).toBeDefined();
    expect(["ready", "ready_with_caveats", "not_ready", "unknown"]).toContain(body.readiness.status);
    expect(body.continuity).toBeDefined();
    expect(body.rigs).toBeInstanceOf(Array);
    expect(body.hostInfra).toBeDefined();
    expect(body.counts).toBeDefined();
    expect(body.checks).toBeInstanceOf(Array);
    // restorable 时 repairPacket 为 null，存在 caveat/blocker 时为数组。
    if (body.verdict === "restorable") {
      expect(body.repairPacket).toBeNull();
    } else {
      expect(body.repairPacket).toBeInstanceOf(Array);
    }

    // 每个 check 都包含必需字段。
    for (const check of body.checks) {
      expect(typeof check.check).toBe("string");
      expect(["green", "yellow", "red"]).toContain(check.status);
      expect(typeof check.evidence).toBe("string");
      expect(typeof check.remediation).toBe("string");
    }
  });

  it("GET /api/restore-check?rig=test-rig 过滤到具名工作组", async () => {
    rigRepo.createRig("rig-a");
    rigRepo.createRig("rig-b");

    const res = await app.request("/api/restore-check?rig=rig-a");
    const body = await res.json();

    const rigChecks = body.checks.filter((c: { check: string }) => c.check.includes("rig."));
    expect(rigChecks.every((c: { check: string }) => !c.check.includes("rig-b"))).toBe(true);
  });

  it("GET /api/restore-check?rig=unknown 返回 not_restorable 和 red check", async () => {
    rigRepo.createRig("real-rig");

    const res = await app.request("/api/restore-check?rig=nonexistent");
    const body = await res.json();

    expect(body.verdict).toBe("not_restorable");
    const notFound = body.checks.find((c: { check: string }) => c.check.includes("nonexistent"));
    expect(notFound).toBeDefined();
    expect(notFound.status).toBe("red");
  });

  it("GET /api/restore-check?noQueue=true 跳过 queue check", async () => {
    const rig = rigRepo.createRig("test-rig");
    rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });

    const res = await app.request("/api/restore-check?noQueue=true");
    const body = await res.json();

    const queueChecks = body.checks.filter((c: { check: string }) => c.check.includes("queue-file"));
    expect(queueChecks).toHaveLength(0);
  });

  it("GET /api/restore-check?noHooks=true 跳过 hook check", async () => {
    const rig = rigRepo.createRig("test-rig");
    rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });

    const res = await app.request("/api/restore-check?noHooks=true");
    const body = await res.json();

    const hookChecks = body.checks.filter((c: { check: string }) => c.check.includes("hooks"));
    expect(hookChecks).toHaveLength(0);
  });

  it("GET /api/restore-check 使用节点 cwd 检查项目本地 Claude hook settings", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-route-hook-cwd-"));
    const settingsDir = path.join(projectDir, ".claude");
    const settingsPath = path.join(settingsDir, "settings.local.json");
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(settingsPath, claudeHookSettings());
    const rig = rigRepo.createRig("hooked-rig");
    rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: projectDir });

    try {
      const res = await app.request("/api/restore-check?rig=hooked-rig");
      const body = await res.json();
      const hook = body.checks.find((c: { check: string }) => c.check.includes(".hooks"));

      expect(res.status).toBe(200);
      expect(hook).toEqual(expect.objectContaining({
        status: "green",
        remediation: "",
      }));
      expect(hook.evidence).toContain(settingsPath);
      expect(hook.evidence).toContain("配置已存在，但尚未验证 hook 执行");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("GET /api/restore-check 为有快照支撑的已停止工作组返回可执行 recovery", async () => {
    const rig = rigRepo.createRig("recoverable-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@recoverable-rig");
    sessionRegistry.updateStatus(session.id, "stopped");
    sessionRegistry.updateStartupStatus(session.id, "failed");
    insertStartupContextRow(db, node.id);
    snapshotRepo.createSnapshot(rig.id, "auto-pre-down", minimalSnapshotData(rig.id, rig.name) as never);

    const res = await app.request("/api/restore-check?rig=recoverable-rig&noQueue=true&noHooks=true");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.recovery).toEqual({
      status: "actionable",
      summary: expect.stringContaining("1 个工作组可用已知 zrig 命令恢复"),
      actions: [
        expect.objectContaining({
          scope: "rig",
          rigId: rig.id,
          rigName: "recoverable-rig",
          command: "zrig up --existing recoverable-rig",
          safe: false,
          blocking: true,
        }),
      ],
      blocked: [],
      unknown: [],
    });
  });

  it("有快照支撑的已停止工作组缺少 startup context 时，GET /api/restore-check 阻塞 recovery", async () => {
    const rig = rigRepo.createRig("recoverable-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@recoverable-rig");
    sessionRegistry.updateStatus(session.id, "stopped");
    sessionRegistry.updateStartupStatus(session.id, "failed");
    snapshotRepo.createSnapshot(rig.id, "auto-pre-down", minimalSnapshotData(rig.id, rig.name) as never);

    const res = await app.request("/api/restore-check?rig=recoverable-rig&noQueue=true&noHooks=true");
    expect(res.status).toBe(200);

    const body = await res.json();
    const startup = body.checks.find((c: { check: string }) => c.check === "seat.dev-impl@recoverable-rig.startup-context");

    expect(startup).toEqual(expect.objectContaining({
      status: "red",
    }));
    expect(startup.evidence).toContain("启动上下文");
    expect(body.recovery).toEqual({
      status: "blocked",
      summary: expect.stringContaining("1 个工作组被阻塞"),
      actions: [],
      blocked: [
        expect.objectContaining({
          scope: "rig",
          rigId: rig.id,
          rigName: "recoverable-rig",
          reason: expect.stringContaining("启动上下文"),
        }),
      ],
      unknown: [],
    });
  });

  it("GET /api/restore-check 为 malformed startup-context row 返回结构化 JSON", async () => {
    const rig = rigRepo.createRig("malformed-startup-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@malformed-startup-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready");
    insertStartupContextRow(db, node.id, {
      resolvedFilesJson: "{",
    });

    const res = await app.request("/api/restore-check?rig=malformed-startup-rig&noQueue=true&noHooks=true");
    expect(res.status).toBe(200);

    const body = await res.json();
    const startup = body.checks.find((c: { check: string }) => c.check === "seat.dev-impl@malformed-startup-rig.startup-context");

    expect(startup).toEqual(expect.objectContaining({
      status: "yellow",
      remediationSafe: false,
    }));
    expect(startup.evidence).toContain("JSON");
    expect(startup.evidence).toContain("resolved_files_json");
    expect(body.readiness.reason).not.toBe("unknown_probe_state");
    expect(body.checks.some((c: { check: string }) => c.check === "probe.error")).toBe(false);
  });

  it("GET /api/restore-check 不会把 malformed startup_actions_json 误判为 green", async () => {
    const rig = rigRepo.createRig("malformed-startup-actions-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@malformed-startup-actions-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready");
    insertStartupContextRow(db, node.id, {
      startupActionsJson: "{",
    });

    const res = await app.request("/api/restore-check?rig=malformed-startup-actions-rig&noQueue=true&noHooks=true");
    expect(res.status).toBe(200);

    const body = await res.json();
    const startup = body.checks.find((c: { check: string }) => c.check === "seat.dev-impl@malformed-startup-actions-rig.startup-context");

    expect(startup).toBeDefined();
    expect(startup.status).not.toBe("green");
    expect(startup).toEqual(expect.objectContaining({
      status: "yellow",
      remediationSafe: false,
    }));
    expect(startup.evidence).toContain("startup_actions_json");
    expect(body.readiness.reason).not.toBe("unknown_probe_state");
    expect(body.checks.some((c: { check: string }) => c.check === "probe.error")).toBe(false);
  });

  it("后台服务路由内 daemon.reachable 为 green（自证明）", async () => {
    rigRepo.createRig("test-rig");

    const res = await app.request("/api/restore-check");
    const body = await res.json();

    const daemon = body.checks.find((c: { check: string }) => c.check === "daemon.reachable");
    expect(daemon).toBeDefined();
    expect(daemon.status).toBe("green");
    expect(daemon.evidence).toContain("后台服务运行中");
  });

  it("GET /api/restore-check 为损坏 fixture 返回非 null repairPacket，并包含 blocking 字段", async () => {
    // 创建带一个节点的工作组；hook 默认为 yellow（Slice 2 未实现），从而产生
    // restorable_with_caveats 和非 null repairPacket。
    const rig = rigRepo.createRig("broken-rig");
    rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });

    const res = await app.request("/api/restore-check?rig=broken-rig");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.readiness).toBeDefined();
    expect(body.readiness.status).not.toBe("ready");
    expect(body.rigs).toBeInstanceOf(Array);
    expect(body.rigs[0]).toEqual(expect.objectContaining({
      rigId: rig.id,
      rigName: "broken-rig",
      expectedNodes: 1,
      runningReadyNodes: expect.any(Number),
      blockedNodes: expect.any(Number),
      caveatNodes: expect.any(Number),
      blockingChecks: expect.any(Array),
      caveatChecks: expect.any(Array),
    }));
    expect(body.hostInfra).toEqual(expect.objectContaining({
      status: "not_declared",
    }));
    // Hooks yellow → restorable_with_caveats → 填充 repairPacket。
    expect(body.repairPacket).toBeInstanceOf(Array);
    expect(body.repairPacket.length).toBeGreaterThan(0);

    // 每个 repair step 都包含必需字段，包括 blocking。
    for (const step of body.repairPacket) {
      expect(typeof step.step).toBe("number");
      expect(typeof step.command).toBe("string");
      expect(typeof step.rationale).toBe("string");
      expect(typeof step.safe).toBe("boolean");
      expect(typeof step.blocking).toBe("boolean");
    }

    // Yellow hook 是非阻塞 caveat。
    const hookStep = body.repairPacket.find((s: { rationale: string }) => s.rationale.includes("Hook"));
    if (hookStep) {
      expect(hookStep.blocking).toBe(false);
    }
  });

  it("GET /api/restore-check 呈现 OPENRIG_HOME 中已声明的 host-infra state", async () => {
    fs.writeFileSync(path.join(openRigHome, "host-infra.json"), VALID_HOST_INFRA_DECLARATION);
    rigRepo.createRig("declared-rig");

    const res = await app.request("/api/restore-check?rig=declared-rig");
    expect(res.status).toBe(200);

    const body = await res.json();
    const check = body.checks.find((entry: { check: string }) => entry.check === "host.bootstrap-autostart.declaration");
    expect(check).toEqual(expect.objectContaining({
      status: "green",
    }));
    expect(check.evidence).toContain(path.join(openRigHome, "host-infra.json"));
    expect(check.evidence).toContain("已声明主机基础设施，但尚未验证");
    expect(body.hostInfra).toEqual(expect.objectContaining({
      status: "declared",
      evidence: expect.stringContaining("已声明主机基础设施，但尚未验证"),
    }));
  });

  it("GET /api/restore-check 呈现 schemaVersion 2 evidence path 已存在", async () => {
    const daemonPath = path.join(openRigHome, "daemon", "launchd.plist");
    const supportPath = path.join(openRigHome, "supervisor-wake", "README.md");
    fs.mkdirSync(path.dirname(daemonPath), { recursive: true });
    fs.mkdirSync(path.dirname(supportPath), { recursive: true });
    fs.writeFileSync(path.join(openRigHome, "host-infra.json"), v2HostInfraDeclaration());
    fs.writeFileSync(daemonPath, "daemon evidence");
    fs.writeFileSync(supportPath, "support evidence");
    rigRepo.createRig("declared-rig");

    const res = await app.request("/api/restore-check?rig=declared-rig");
    expect(res.status).toBe(200);

    const body = await res.json();
    const check = body.checks.find((entry: { check: string }) => entry.check === "host.bootstrap-autostart.declaration");
    expect(check).toEqual(expect.objectContaining({
      status: "green",
    }));
    expect(check.evidence).toContain("evidence path 已存在，但尚未验证自动启动");
    expect(check.evidence).toContain(daemonPath);
    expect(check.evidence).toContain(supportPath);
    expect(body.hostInfra).toEqual(expect.objectContaining({
      status: "declared",
      evidence: expect.stringContaining("尚未验证自动启动"),
    }));
  });

  it("GET /api/restore-check 把 schemaVersion 2 缺失 evidence path 呈现为 caveat", async () => {
    const daemonPath = path.join(openRigHome, "daemon", "launchd.plist");
    const supportPath = path.join(openRigHome, "supervisor-wake", "README.md");
    fs.mkdirSync(path.dirname(daemonPath), { recursive: true });
    fs.writeFileSync(path.join(openRigHome, "host-infra.json"), v2HostInfraDeclaration());
    fs.writeFileSync(daemonPath, "daemon evidence");
    rigRepo.createRig("declared-rig");

    const res = await app.request("/api/restore-check?rig=declared-rig&noQueue=true&noHooks=true");
    expect(res.status).toBe(200);

    const body = await res.json();
    const check = body.checks.find((entry: { check: string }) => entry.check === "host.bootstrap-autostart.declaration");
    expect(check).toEqual(expect.objectContaining({
      status: "yellow",
    }));
    expect(check.evidence).toContain(supportPath);
    expect(body.hostInfra.status).toBe("declared");
    expect(body.repairPacket.some((step: { command: string; safe: boolean; blocking: boolean }) => (
      step.command.includes(supportPath) && step.safe === false && step.blocking === false
    ))).toBe(true);
  });

  it("GET /api/restore-check?rig=nonexistent 保留缺失 host-infra state", async () => {
    rigRepo.createRig("real-rig");

    const res = await app.request("/api/restore-check?rig=nonexistent&noQueue=true&noHooks=true");
    expect(res.status).toBe(200);

    const body = await res.json();
    const check = body.checks.find((entry: { check: string }) => entry.check === "host.bootstrap-autostart.declaration");
    expect(body.verdict).toBe("not_restorable");
    expect(check).toEqual(expect.objectContaining({
      status: "yellow",
      evidence: expect.stringContaining(path.join(openRigHome, "host-infra.json")),
    }));
    expect(body.hostInfra).toEqual(expect.objectContaining({
      status: "not_declared",
      evidence: check.evidence,
    }));
  });

  it("GET /api/restore-check?rig=nonexistent 保留已声明 host-infra state", async () => {
    fs.writeFileSync(path.join(openRigHome, "host-infra.json"), VALID_HOST_INFRA_DECLARATION);
    rigRepo.createRig("real-rig");

    const res = await app.request("/api/restore-check?rig=nonexistent&noQueue=true&noHooks=true");
    expect(res.status).toBe(200);

    const body = await res.json();
    const check = body.checks.find((entry: { check: string }) => entry.check === "host.bootstrap-autostart.declaration");
    expect(body.verdict).toBe("not_restorable");
    expect(check).toEqual(expect.objectContaining({
      status: "green",
      evidence: expect.stringContaining(path.join(openRigHome, "host-infra.json")),
    }));
    expect(body.hostInfra).toEqual(expect.objectContaining({
      status: "declared",
      evidence: check.evidence,
    }));
  });

  it("GET /api/restore-check 路由 catch 返回可执行 repairPacket", async () => {
    const spy = vi.spyOn(RestoreCheckService.prototype, "check").mockImplementationOnce(() => {
      throw new Error("route boom");
    });

    try {
      const res = await app.request("/api/restore-check");
      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.verdict).toBe("unknown");
      expect(body.readiness.status).toBe("unknown");
      expect(body.readiness.reason).toBe("unknown_probe_state");
      expect(body.recovery).toEqual({
        status: "unknown",
        summary: expect.stringContaining("无法检视恢复状态"),
        actions: [],
        blocked: [],
        unknown: [
          expect.objectContaining({
            scope: "host",
            reason: expect.stringContaining("route boom"),
          }),
        ],
      });
      expect(body.checks[0]).toEqual(expect.objectContaining({
        check: "probe.error",
        status: "red",
        remediation: "用 zrig daemon logs 查看后台服务日志",
      }));
      expect(body.checks[0].evidence).toContain("route boom");
      expect(body.repairPacket).toEqual([{
        step: 1,
        command: "用 zrig daemon logs 查看后台服务日志",
        rationale: expect.stringContaining("route boom"),
        safe: true,
        blocking: true,
      }]);
    } finally {
      spy.mockRestore();
    }
  });

  it("GET /api/restore-check?rig=nonexistent 返回含 blocking:true entry 的 repairPacket", async () => {
    rigRepo.createRig("real-rig");

    const res = await app.request("/api/restore-check?rig=nonexistent");
    const body = await res.json();

    expect(body.verdict).toBe("not_restorable");
    expect(body.repairPacket).toBeInstanceOf(Array);
    const blocker = body.repairPacket.find((s: { blocking: boolean }) => s.blocking);
    expect(blocker).toBeDefined();
    expect(blocker.command).toContain("zrig ps");
  });

  // --- H62 absence 证明 ---

  it("GET /api/restore-check 响应没有 fullyBack 或 assertion 字段", async () => {
    rigRepo.createRig("test-rig");

    const res = await app.request("/api/restore-check");
    const body = await res.json();

    expect("fullyBack" in body).toBe(false);
    expect("assertion" in body).toBe(false);
    expect(body.readiness).toBeDefined();
    expect(body.continuity).toBeDefined();
  });

  it("路由 500 fallback 发出 readiness + continuity，不含 legacy 字段", async () => {
    const spy = vi.spyOn(RestoreCheckService.prototype, "check").mockImplementationOnce(() => {
      throw new Error("fallback test");
    });

    try {
      const res = await app.request("/api/restore-check");
      expect(res.status).toBe(500);
      const body = await res.json();

      expect("fullyBack" in body).toBe(false);
      expect("assertion" in body).toBe(false);
      expect(body.readiness).toBeDefined();
      expect(body.readiness.status).toBe("unknown");
      expect(body.continuity).toBeDefined();
      expect(body.continuity.status).toBe("not_proven");
      expect(body.continuity.unprovenCapabilities).toBeInstanceOf(Array);
      expect(body.continuity.unprovenCapabilities.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("路由响应中的 continuity 始终为 not_proven", async () => {
    rigRepo.createRig("test-rig");

    const res = await app.request("/api/restore-check");
    const body = await res.json();

    expect(body.continuity.status).toBe("not_proven");
    expect(body.continuity.evidence).toBeTruthy();
    expect(body.continuity.unprovenCapabilities).toContain("provider_session_resume");
  });

  // OPR.0.4.0.29——生产路由上的 compact 与 --ready（ready=1）对比。finding 3 要求执行
  // restoreCheckRoutes，而不是复制仅测试路径。
  it("?compact=1 丢弃 green check 以节省 token；?compact=1&ready=1 保留 ready detail", async () => {
    rigRepo.createRig("test-rig");

    const compact = await (await app.request("/api/restore-check?compact=1")).json();
    // compact 模式丢弃 green check，例如 daemon.reachable。
    expect(compact.checks.some((c: { check: string }) => c.check === "daemon.reachable")).toBe(false);

    const compactReady = await (await app.request("/api/restore-check?compact=1&ready=1")).json();
    // --ready（ready=1）在保持 compact 的同时保留 ready-seat（green）detail，不退回完整信息流
    //（FR-2 修正）。
    expect(compactReady.checks.some((c: { check: string }) => c.check === "daemon.reachable")).toBe(true);
    expect(compactReady.checks.length).toBeGreaterThan(compact.checks.length);
  });
});
