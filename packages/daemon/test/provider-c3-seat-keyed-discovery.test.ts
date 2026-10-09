// Slice-04（OPR.0.5.0.4）C3——Claude provider_usage 发现的生产高度固定项
//（PM 选项 A，逐席位）。它取代仅辅助层的假绿测试（provider-service-impl.test.ts
//“从 collectClaudeSignals 依赖公开……” + provider-claude-usage-reader.test.ts 手动输入的
// account/cache stub）；后者未触发生产发现流程，就让按席位 unknown 的测试变绿。
//
// 契约（选项 A）：存活的 claude-code node-inventory 席位即使没有 provider_usage 缓存
//（或缓存缺失/格式错误），仍必须发出按席位索引、明确为 unknown 的行——发现由
// node-inventory 驱动，而非依赖缓存解析。通过真实 ProviderServiceImpl.getReadModel
//（已封闭的 C1 接口）驱动，绝不使用注入信号。

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { spawnSync } from "node:child_process";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { ProviderServiceImpl } from "../src/domain/provider/provider-service-impl.js";
import { collectClaudeSignalsFromProviderUsageDirectory } from "../src/domain/provider/claude-usage-reader.js";

const ASOF = "2026-08-04T00:00:00.000Z";

function emptyCodexHomeEnv(): NodeJS.ProcessEnv {
  const home = fs.mkdtempSync(nodePath.join(os.tmpdir(), "provider-c3-codex-"));
  return { CODEX_HOME: home } as NodeJS.ProcessEnv;
}

/** 向 node-inventory 预置存活的 claude-code 席位（工作组 + pod + 节点 + 运行中会话/绑定）。 */
function seedClaudeSeat(
  db: Database.Database,
  sessionName = "dev-impl@test-rig",
  sessionStatus: "running" | "exited" = "running",
) {
  db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "test-rig");
  db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-1", "rig-1", "dev", "Dev");
  db.prepare(
    "INSERT INTO nodes (id, rig_id, logical_id, runtime, cwd, pod_id, agent_ref, profile, resolved_spec_name, resolved_spec_version, resolved_spec_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run("node-1", "rig-1", "dev.impl", "claude-code", "/project", "pod-1", "local:agents/impl", "default", "impl", "1.0.0", "abc123");
  db.prepare(
    "INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES (?, ?, ?, ?, ?)"
  ).run("sess-node-1", "node-1", sessionName, sessionStatus, "ready");
  db.prepare("INSERT OR REPLACE INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)").run("bind-node-1", "node-1", sessionName);
}

describe("Slice-04 C3——按席位索引的 Claude provider_usage 发现（生产高度，PM 选项 A）", () => {
  it("存活 claude-code 席位没有 provider_usage 缓存时，真实 getReadModel 仍返回按席位索引的显式 unknown", async () => {
    const db = createFullTestDb();
    seedClaudeSeat(db);
    // 有意不提供 collectClaudeSignals（缓存通道）——缓存缺失。发现仍必须从 node-inventory
    // 发出按席位索引的 unknown。使用真实 getReadModel，C1 接口保持不变。
    const svc = new ProviderServiceImpl({ db, listRigs: () => [{ id: "rig-1" }], env: emptyCodexHomeEnv(), now: () => ASOF });
    const model = await svc.getReadModel();

    const claude = model.signals.filter((s) => s.provider === "claude");
    expect(claude.length, `expected exactly one seat-keyed Claude unknown row; got ${JSON.stringify(model.signals)}`).toBe(1);
    const sig = claude[0]! as Record<string, unknown>;
    expect(sig["seatSession"], "Option A: SEAT-keyed").toBe("dev-impl@test-rig");
    expect(sig["accountRef"], "Option A: NO fabricated account identity").toBeUndefined();
    expect(sig["sourceClass"]).toBe("unknown");
    expect(sig["authority"]).toBe("unknown");
    expect(sig["automationUse"]).toBe("do_not_automate");
    expect(sig["usedPercent"], "never a fabricated zero").toBeUndefined();
  });

  it("没有 claude-code 席位（清单为空）→ 没有 Claude 信号（绝不虚构行）", async () => {
    const db = createFullTestDb();
    const svc = new ProviderServiceImpl({ db, listRigs: () => [], env: emptyCodexHomeEnv(), now: () => ASOF });
    const model = await svc.getReadModel();
    expect(model.signals.filter((s) => s.provider === "claude")).toEqual([]);
  });

  it("通过真实 getReadModel 组合随附 collector 与生产缓存读取器", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "provider-c3-altitude-"));
    try {
      const contextDir = nodePath.join(root, "context");
      const usageDir = nodePath.join(root, "provider-usage");
      const seatSession = "dev-impl@test-rig";
      const collectorPath = nodePath.join(import.meta.dirname, "../assets/claude-statusline-context.cjs");
      const result = spawnSync(process.execPath, [collectorPath, contextDir, usageDir], {
        encoding: "utf-8",
        input: JSON.stringify({
          session_id: "sess-123",
          session_name: seatSession,
          context_window: { context_window_size: 200_000, used_percentage: 10 },
          rate_limits: {
            five_hour: { used_percentage: 0, resets_at: "2026-08-04T05:00:00.000Z" },
            seven_day: { used_percentage: 7, resets_at: "2026-08-10T00:00:00.000Z" },
          },
        }),
      });
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(nodePath.join(usageDir, `${seatSession}.json`))).toBe(true);

      const db = createFullTestDb();
      seedClaudeSeat(db, seatSession);
      const svc = new ProviderServiceImpl({
        db,
        listRigs: () => [{ id: "rig-1" }],
        env: emptyCodexHomeEnv(),
        now: () => ASOF,
        collectClaudeSignals: () => collectClaudeSignalsFromProviderUsageDirectory(usageDir, () => ASOF),
      });
      const model = await svc.getReadModel();
      const claude = model.signals.filter((signal) => signal.provider === "claude");

      expect(claude).toHaveLength(2);
      expect(claude.map((signal) => signal.window).sort()).toEqual(["five_hour", "weekly"]);
      expect(claude.find((signal) => signal.window === "five_hour")?.usedPercent).toBe(0);
      expect(claude.every((signal) => signal.seatSession === seatSession && signal.accountRef === undefined)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("最新 Claude 会话已退出且缓存相应过期时，不发出 Claude 信号", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "provider-c3-exited-"));
    try {
      const contextDir = nodePath.join(root, "context");
      const usageDir = nodePath.join(root, "provider-usage");
      const seatSession = "exited-impl@test-rig";
      const collectorPath = nodePath.join(import.meta.dirname, "../assets/claude-statusline-context.cjs");
      const result = spawnSync(process.execPath, [collectorPath, contextDir, usageDir], {
        encoding: "utf-8",
        input: JSON.stringify({
          session_id: "sess-exited",
          session_name: seatSession,
          context_window: { context_window_size: 200_000, used_percentage: 10 },
          rate_limits: {
            five_hour: { used_percentage: 0, resets_at: "2026-08-04T05:00:00.000Z" },
            seven_day: { used_percentage: 7, resets_at: "2026-08-10T00:00:00.000Z" },
          },
        }),
      });
      expect(result.status, result.stderr).toBe(0);

      const db = createFullTestDb();
      seedClaudeSeat(db, seatSession, "exited");
      const svc = new ProviderServiceImpl({
        db,
        listRigs: () => [{ id: "rig-1" }],
        env: emptyCodexHomeEnv(),
        now: () => ASOF,
        collectClaudeSignals: () => collectClaudeSignalsFromProviderUsageDirectory(usageDir, () => ASOF),
      });
      const model = await svc.getReadModel();

      expect(model.signals.filter((signal) => signal.provider === "claude")).toEqual([]);
      expect(model.bindings).toEqual([expect.objectContaining({ seatSession, accountId: null })]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
