// User Settings v0——后台服务 HTTP 路由测试。
//
// 固定 /api/config 的承重行为：
//   - GET /api/config 返回所有设置 key 及其 source + default
//   - GET /api/config/:key 返回一个 key
//   - POST /api/config/:key 设置值并持久化到磁盘
//   - DELETE /api/config/:key 将一个 key 恢复为默认值
//   - POST /api/config/init-workspace 创建可直接用于仓库的 project workspace
//   - settingsStore 不可用时返回 503
//   - key 未知或缺少 body 时返回 400

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { configRoutes } from "../src/routes/config.js";

function clearEnv(): () => void {
  const keys = [
    "OPENRIG_PORT", "OPENRIG_FILES_ALLOWLIST", "OPENRIG_PROGRESS_SCAN_ROOTS",
    "OPENRIG_WORKSPACE_ROOT", "OPENRIG_DOGFOOD_EVIDENCE_ROOT",
    "OPENRIG_WORKSPACE_PROJECTS_ROOT", "OPENRIG_WORKSPACE_CATALOG_PATH",
    "OPENRIG_CONTEXT_ROOT", "OPENRIG_CONTEXT_PACKS_ROOT",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_ENABLED",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_PRE_COMPACT_INSTRUCTION",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_COMPACT_INSTRUCTION",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_MESSAGE_INLINE",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_MESSAGE_FILE_PATH",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_POST_RESTORE_AUDIT_INSTRUCTION",
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return () => {
    for (const k of keys) {
      if (saved[k] !== undefined) process.env[k] = saved[k]!;
      else delete process.env[k];
    }
  };
}

describe("config 路由（User Settings v0）", () => {
  let tmpDir: string;
  let configPath: string;
  let store: SettingsStore;
  let restoreEnv: () => void;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "config-routes-"));
    configPath = join(tmpDir, "config.json");
    store = new SettingsStore(configPath);
    restoreEnv = clearEnv();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  function buildApp(): Hono {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("settingsStore" as never, store);
      await next();
    });
    app.route("/api/config", configRoutes());
    return app;
  }

  it("GET /api/config 返回所有设置 key 及其 source + default", async () => {
    const app = buildApp();
    const res = await app.request("/api/config");
    expect(res.status).toBe(200);
    const body = await res.json() as { settings: Record<string, { value: unknown; source: string }> };
    // 18 个 v0 key + Phase 4 的 2 个（advisor/operator）+ Phase 5 的 5 个（feed.subscriptions.*）
    // + V1 预发布第 1 项的 2 个（transcripts.lines / transcripts.poll_interval_seconds）
    // + plugin-primitive Phase 3a slice 3.5 的 1 个（runtime.codex.hooks_enabled）
    // + V0.3.1 slice 05 的 1 个（workspace.operator_seat_name）
    // + slice 27 的 7 个（policies.claude_compaction.*）
    // + OPR.0.3.4.9 的 3 个（snapshots.periodic.*）
    // + OPR.0.4.0.1 的 1 个（ui.terminal.max_live_terminals）
    // + OPR.0.4.6.MH1 的 2 个（host.selected / host.name）
    // + OPR.0.4.6.WF5 的 1 个（workflow.exception_routing）
    // + OPR.0.4.6.02 的 1 个（terminal.status_bar——已批准的唯一 v1 terminal key）
    // + OPR.0.4.6.FS-1 W2 的 5 个（retention.enabled / transitions_days / watchdog_days /
    //   watchdog_keep_per_job / batch_size——CLI 可设置的 queue-retention 旋钮；
    //   + retention.usage_samples_days, 51-08 A2)
    // + 2 OPR.0.5.1 W2c (policies.idle_gate_qitem.scan_interval_seconds /
    //   active_wake_interval_seconds)
    // + 2 B6 founder ruling (policies.idle_gate_qitem.auto_register /
    //   opt_in_sessions——非默认开启的 gate）
    // + OPR.0.5.3.6 D1 的 1 个（topology.root——topology tree root）
    // + 1 OPR.0.5.9.5 Wave B (context.root)
    // + 1 S15 (onboarding.default_pack.enabled)
    // + 1 S04 (queue.pickup_stall_threshold_minutes)
    // + 2 S02 (queue.stuck_sweep_interval_seconds /
    //   stuck_sweep_unclaimed_age_minutes)
    // + 4 S01 (queue.wake_retry_interval_seconds / wake_retry_cap /
    //   wake_unconfirmed_window_minutes / wake_swap_grace_seconds)
    // + 1 OPR.0.5.9.4 (skills.root)
    // + 1 OPR.0.5.9.5 (context.system_world)
    // + OPR.0.5.10.7 的 2 个 context-pressure policy 阈值，共 68 个。
    // + S07 的 1 个本地时间偏好。
    expect(Object.keys(body.settings).length).toBe(69);
    expect(body.settings["ui.timezone"]).toMatchObject({ value: "America/Los_Angeles", source: "default" });
    expect(body.settings["daemon.port"]?.source).toBe("default");
    expect(body.settings["health.context_pressure.warning_percent"]).toMatchObject({
      value: 95,
      source: "default",
      defaultValue: 95,
    });
    expect(body.settings["health.context_pressure.critical_percent"]).toMatchObject({
      value: 99,
      source: "default",
      defaultValue: 99,
    });
    expect(body.settings["ui.preview.refresh_interval_seconds"]?.value).toBe(3);
    expect(body.settings["ui.preview.max_pins"]?.value).toBe(4);
    expect(body.settings["ui.preview.default_lines"]?.value).toBe(50);
    expect(body.settings["recovery.auto_drive_provider_prompts"]?.value).toBe(false);
    expect(body.settings["recovery.provider_auth_env_allowlist"]?.value).toBe("");
    expect(body.settings["host.selected"]).toMatchObject({ value: "local", source: "default" });
    expect(body.settings["host.name"]).toMatchObject({ value: "localhost", source: "default" });
    expect(body.settings["onboarding.default_pack.enabled"]).toMatchObject({ value: true, source: "default" });
    expect(String(body.settings["workspace.projects_root"]?.value)).toMatch(/projects$/);
    expect(String(body.settings["workspace.catalog_path"]?.value)).toMatch(/workspace\.yaml$/);
    expect(String(body.settings["context.root"]?.value)).toMatch(/context$/);
    expect(body.settings["context.system_world"]).toMatchObject({ value: "default", source: "default" });
    expect(body.settings["workspace.field_notes_root"]).toBeUndefined();
    expect(body.settings["workspace.dogfood_evidence_root"]).toBeUndefined();
  });

  it("GET /api/config/:key 返回解析后的值", async () => {
    store.set("workspace.root", "/custom/ws");
    const app = buildApp();
    const res = await app.request("/api/config/workspace.root");
    expect(res.status).toBe(200);
    const body = await res.json() as { value: string; source: string };
    expect(body.value).toBe("/custom/ws");
    expect(body.source).toBe("file");
  });

  it("GET /api/config 重新基准化持久化的 legacy workspace 默认值", async () => {
    store.set("workspace.root", "/custom/ws");
    store.set("workspace.slices_root", "/custom/ws/slices");
    store.set("workspace.steering_path", "/custom/ws/steering/STEERING.md");
    const app = buildApp();
    const res = await app.request("/api/config");
    expect(res.status).toBe(200);
    const body = await res.json() as { settings: Record<string, { value: unknown; source: string }> };
    expect(body.settings["workspace.slices_root"]).toMatchObject({
      value: "/custom/ws/missions",
      source: "default",
    });
    expect(body.settings["workspace.steering_path"]).toMatchObject({
      value: "/custom/ws/STEERING.md",
      source: "default",
    });
  });

  it("GET /api/config/:key 对未知 key 返回 400", async () => {
    const app = buildApp();
    const res = await app.request("/api/config/workspace.bogus");
    expect(res.status).toBe(400);
    const body = await res.json() as { validKeys: string[] };
    expect(body.validKeys).toContain("workspace.root");
  });

  it.each(["GET", "POST", "DELETE"] as const)(
    "%s /api/config/context.packs_root 拒绝已移除的 key 并给出替代项",
    async (method) => {
      const app = buildApp();
      const res = await app.request("/api/config/context.packs_root", {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "POST" ? JSON.stringify({ value: "/legacy" }) : undefined,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ replacement: "context.root" });
    },
  );

  it("GET /api/config 在投影设置前拒绝已持久化的 context.packsRoot", async () => {
    writeFileSync(configPath, JSON.stringify({ context: { packsRoot: "/legacy" } }));
    const res = await buildApp().request("/api/config");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("context.root") });
  });

  it("GET /api/config/context.root 保留已移除环境设置的迁移指南", async () => {
    process.env.OPENRIG_CONTEXT_PACKS_ROOT = "/legacy";

    const res = await buildApp().request("/api/config/context.root");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("OPENRIG_CONTEXT_ROOT"),
    });
  });

  it("GET /api/config/context.root 保留已移除持久化设置的迁移指南", async () => {
    writeFileSync(configPath, JSON.stringify({ context: { packsRoot: "/legacy" } }));

    const res = await buildApp().request("/api/config/context.root");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("context.root") });
  });

  it("POST /api/config/:key 设置值并持久化到磁盘", async () => {
    const app = buildApp();
    const res = await app.request("/api/config/workspace.slices_root", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "/custom/slices" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; resolved: { value: string } };
    expect(body.ok).toBe(true);
    expect(body.resolved.value).toBe("/custom/slices");
    // 已持久化到磁盘。
    expect(JSON.parse(readFileSync(configPath, "utf-8")).workspace.slicesRoot).toBe("/custom/slices");
  });

  it("缺少 value 字段时 POST /api/config/:key 返回 400", async () => {
    const app = buildApp();
    const res = await app.request("/api/config/workspace.root", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  // Slice 27 BLOCKING-FIX——/api/config POST 必须拒绝无效 threshold_percent 输入。路由捕获
  // SettingsStore.set 抛出的错误并映射为 400；集成测试端到端断言该契约，使未来漂移在 CI 中暴露。
  describe("POST /api/config/policies.claude_compaction.threshold_percent 严格验证", () => {
    const rejectCases = ["0", "101", "-1", "80abc", "80.5", "", " ", "NaN", "Infinity"];

    for (const raw of rejectCases) {
      it(`对 ${JSON.stringify(raw)} 返回 400`, async () => {
        const app = buildApp();
        const res = await app.request("/api/config/policies.claude_compaction.threshold_percent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: raw }),
        });
        expect(res.status).toBe(400);
        const body = await res.json() as { error?: string };
        expect(body.error).toMatch(/整数|数字|\[1, 100\] 范围/);
      });
    }

    it("接受范围内的有效整数并持久化到磁盘", async () => {
      const app = buildApp();
      const res = await app.request("/api/config/policies.claude_compaction.threshold_percent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "60" }),
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(readFileSync(configPath, "utf-8")).policies.claudeCompaction.thresholdPercent).toBe(60);
    });
  });

  it("DELETE /api/config/:key 重置为默认值", async () => {
    store.set("workspace.slices_root", "/x");
    const app = buildApp();
    const res = await app.request("/api/config/workspace.slices_root", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json() as { resolved: { source: string } };
    expect(body.resolved.source).toBe("default");
  });

  it("POST /api/config/init-workspace 创建 canonical 六项 workspace", async () => {
    const root = join(tmpDir, "workspace");
    const app = buildApp();
    const res = await app.request("/api/config/init-workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { root: string; subdirs: Array<{ name: string }>; files: Array<{ relPath: string }> };
    expect(body.root).toBe(root);
    expect(body.subdirs.map((s) => s.name)).toEqual(["missions", "exhaust"]);
    expect(body.files.map((file) => file.relPath)).toEqual(["SPEC.md", "project.yaml", "workspace.yaml", ".gitignore"]);
    for (const path of ["SPEC.md", "project.yaml", "workspace.yaml", ".gitignore", "missions", "exhaust"]) {
      expect(existsSync(join(root, path))).toBe(true);
    }
    for (const retired of ["README.md", "STEERING.md", "artifacts", "evidence", "progress", "field-notes", "specs", "dogfood-evidence", "skills", "context", "state"]) {
      expect(existsSync(join(root, retired))).toBe(false);
    }
  });

  it("POST /api/config/init-workspace --dry-run 不写入", async () => {
    const root = join(tmpDir, "ws-dry");
    const app = buildApp();
    const res = await app.request("/api/config/init-workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, dryRun: true }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(root)).toBe(false);
  });

  it("即使使用 force，POST /api/config/init-workspace 仍保留现有文件", async () => {
    const root = join(tmpDir, "ws-existing");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "SPEC.md"), "operator-owned", "utf-8");
    const app = buildApp();
    const res = await app.request("/api/config/init-workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, force: true }),
    });
    expect(res.status).toBe(200);
    expect(readFileSync(join(root, "SPEC.md"), "utf-8")).toBe("operator-owned");
  });

  it("context 缺少 settingsStore 时返回 503", async () => {
    const app = new Hono();
    app.route("/api/config", configRoutes());
    const res = await app.request("/api/config");
    expect(res.status).toBe(503);
  });

  it("仅 project 的初始化不查询 mission-note override", async () => {
    const root = join(tmpDir, "project-only-workspace");
    expect(existsSync(root)).toBe(false);
    const original = process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH;
    process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH = join(tmpDir, "does-not-exist.md");
    try {
      const app = buildApp();
      const res = await app.request("/api/config/init-workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root }),
      });
      expect(res.status).toBe(200);
      expect(existsSync(root)).toBe(true);
      expect(existsSync(join(root, "missions", "getting-started"))).toBe(false);
    } finally {
      if (original === undefined) delete process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH;
      else process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH = original;
    }
  });
});
