// OPR.0.4.3.14——手动压缩触发路由（POST /api/compaction/trigger）。
//
// 证明：路由在调用 enforcer 前解析目标并读取既有 context-usage 投影，准备 prompt 携带来源使用率；
// 非 Claude → 422 runtime_filter；使用率未知 → 409 no_usage_data（路由传 null，绝不虚构）；
// 歧义 → 409；字段缺失 → 400；enforcer 未接线 → 503。复用已交付 SessionTransport 与同一个
// ClaudeCompactionEnforcer，不建立第二条路径。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { ClaudeCompactionEnforcer } from "../src/domain/claude-compaction-enforcer.js";
import type { ClaudeCompactionPolicy, SettingsStore } from "../src/domain/user-settings/settings-store.js";
import type { ContextUsage } from "../src/domain/types.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { compactionRoutes } from "../src/routes/compaction.js";
import { createFullTestDb } from "./helpers/test-app.js";

const POLICY: ClaudeCompactionPolicy = {
  enabled: true,
  thresholdPercent: 80,
  preCompactInstruction: "",
  compactInstruction: "",
  messageInline: "",
  messageFilePath: "",
  postRestoreAuditInstruction: "",
};

function makeSettings(): SettingsStore {
  return { resolveClaudeCompactionPolicy: () => POLICY } as unknown as SettingsStore;
}

function idleTmux(sendText?: (target: string, text: string) => Promise<{ ok: true }>): TmuxAdapter {
  return {
    hasSession: async () => true,
    probeSession: async () => ({ state: "present" as const }),
    sendText: sendText ?? (async () => ({ ok: true as const })),
    sendKeys: async () => ({ ok: true as const }),
    capturePaneContent: async () => "idle\n❯ ",
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

function knownUsage(sessionName: string, usedPercentage: number): ContextUsage {
  return {
    availability: "known",
    reason: null,
    source: "claude_statusline_json",
    usedPercentage,
    remainingPercentage: 100 - usedPercentage,
    contextWindowSize: 200_000,
    totalInputTokens: null,
    totalOutputTokens: null,
    currentUsage: null,
    transcriptPath: "/tmp/claude.jsonl",
    sessionId: "sid-123",
    sessionName,
    sampledAt: new Date().toISOString(),
    fresh: true,
  };
}

interface AppParts {
  app: Hono;
  sentTexts: string[];
}

describe("压缩路由——POST /api/compaction/trigger", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let usageStore: ContextUsageStore;
  let stateDir: string;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    stateDir = mkdtempSync(join(tmpdir(), "compaction-route-"));
    usageStore = new ContextUsageStore(db, { stateDir });
  });

  afterEach(() => {
    db.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function seed(): { claudeNodeId: string; codexNodeId: string } {
    const rig = rigRepo.createRig("my-rig");
    const claude = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const s1 = sessionRegistry.registerSession(claude.id, "dev-impl@my-rig");
    sessionRegistry.updateStatus(s1.id, "running");
    sessionRegistry.updateBinding(claude.id, { tmuxSession: "dev-impl@my-rig" });

    const codex = rigRepo.addNode(rig.id, "dev.qa", { role: "worker", runtime: "codex" });
    const s2 = sessionRegistry.registerSession(codex.id, "dev-qa@my-rig");
    sessionRegistry.updateStatus(s2.id, "running");
    sessionRegistry.updateBinding(codex.id, { tmuxSession: "dev-qa@my-rig" });
    return { claudeNodeId: claude.id, codexNodeId: codex.id };
  }

  function buildApp(opts?: { wireEnforcer?: boolean }): AppParts {
    const sentTexts: string[] = [];
    const transport = new SessionTransport({
      db,
      rigRepo,
      sessionRegistry,
      tmuxAdapter: idleTmux(async (_t, text) => { sentTexts.push(text); return { ok: true as const }; }),
      sleep: async () => undefined,
      waitForIdlePollMs: 1,
    });
    const enforcer = new ClaudeCompactionEnforcer(makeSettings(), transport, { openrigHome: stateDir });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("sessionTransport" as never, transport);
      c.set("contextUsageStore" as never, usageStore);
      c.set("db" as never, db);
      if (opts?.wireEnforcer !== false) c.set("compactionEnforcer" as never, enforcer);
      await next();
    });
    app.route("/api/compaction", compactionRoutes());
    return { app, sentTexts };
  }

  it("触发前读取已知 context-usage 百分比：准备 prompt 携带该值，随后发送 /compact", async () => {
    const { claudeNodeId } = seed();
    usageStore.persist(claudeNodeId, knownUsage("dev-impl@my-rig", 42));
    const { app, sentTexts } = buildApp();

    const res = await app.request("/api/compaction/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, session: "dev-impl@my-rig", stage: "compact-sent" });
    // 第 1 阶段准备携带来源使用率，证明触发前已读取 usage。
    expect(sentTexts[0]).toContain("当前上下文使用率为 42%");
    // 随后执行第 2 阶段 /compact。
    expect(sentTexts[1]).toContain("/compact");
    expect(sentTexts).toHaveLength(2);
  });

  it("非 Claude 席位 → 422 runtime_filter（明确拒绝而非静默 no-op）", async () => {
    seed();
    const { app, sentTexts } = buildApp();
    const res = await app.request("/api/compaction/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-qa@my-rig" }),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).reason).toBe("runtime_filter");
    expect(sentTexts).toHaveLength(0);
  });

  it("使用率未知（无持久样本）→ 409 no_usage_data（绝不盲目触发）", async () => {
    seed();
    const { app, sentTexts } = buildApp();
    const res = await app.request("/api/compaction/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("no_usage_data");
    expect(sentTexts).toHaveLength(0);
  });

  it("会话跨工作组有歧义 → 409", async () => {
    const rigA = rigRepo.createRig("rig-a");
    const nA = rigRepo.addNode(rigA.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(nA.id, "dev-impl@shared");
    const rigB = rigRepo.createRig("rig-b");
    const nB = rigRepo.addNode(rigB.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(nB.id, "dev-impl@shared");

    const { app } = buildApp();
    const res = await app.request("/api/compaction/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@shared" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("有歧义");
  });

  it("缺少 session 字段 → 400", async () => {
    seed();
    const { app } = buildApp();
    const res = await app.request("/api/compaction/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("enforcer 未接线 → 503 compaction_unavailable", async () => {
    seed();
    const { app } = buildApp({ wireEnforcer: false });
    const res = await app.request("/api/compaction/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: "dev-impl@my-rig" }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()).reason).toBe("compaction_unavailable");
  });
});
