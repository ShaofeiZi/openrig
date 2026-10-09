// PL-007 工作区原语 v0 — 工作区 HTTP 路由测试。
//
// 固定行为:
//   - POST /api/workspace/validate 返回结构化缺口报告
//   - 缺少 root 时返回 400
//   - workspace kind 非法时返回 400
//   - 不区分 kind 的调用(无 workspaceKind)在未强制约定时返回 0 个缺口

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { workspaceRoutes } from "../src/routes/workspace.js";

let dir: string;
let app: Hono;

const CONVENTION_BODY = "# S\n## Intent\nx\n## Mini-requirements\n1. y\n## Proof contract\n- [ ] z\n";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pl007-route-"));
  app = new Hono();
  app.route("/api/workspace", workspaceRoutes());
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("工作区 HTTP 路由 (PL-007)", () => {
  it("POST /validate 在 knowledge 规范上返回结构化缺口报告", async () => {
    fs.writeFileSync(path.join(dir, "a.md"), "---\ndoc: a\nstatus: active\ncreated: 2026-05-04\nowner: x\n---\n", "utf-8");
    fs.writeFileSync(path.join(dir, "missing.md"), "---\ndoc: m\nstatus: active\ncreated: 2026-05-04\n---\n", "utf-8");
    const res = await app.request("/api/workspace/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: dir, workspaceKind: "knowledge" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { totalFiles: number; gapCount: number; gaps: Array<{ kind: string; field: string | null }> };
    expect(body.totalFiles).toBe(2);
    expect(body.gapCount).toBe(1);
    expect(body.gaps[0]?.field).toBe("owner");
  });

  it("POST /validate 缺少 root 时以 400 拒绝", async () => {
    const res = await app.request("/api/workspace/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("POST /validate 拒绝未知的 workspace kind", async () => {
    const res = await app.request("/api/workspace/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: dir, workspaceKind: "rd-pod" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /validate 在无 workspaceKind 时只做结构检查", async () => {
    fs.writeFileSync(path.join(dir, "a.md"), "---\ndoc: a\n---\n", "utf-8");
    const res = await app.request("/api/workspace/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: dir }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { gapCount: number; workspaceKind: string | null };
    expect(body.gapCount).toBe(0);
    expect(body.workspaceKind).toBeNull();
  });
});

// Slice-21 FR-5 — POST /api/workspace/doctor 路由测试。
//
// 通过 Hono 中间件接入桩 SettingsStore(与 server.ts:430 处
// `c.set("settingsStore", ...)` 的生产写法一致)。
// SettingsStore 使用临时配置文件路径构造,避免测试套件触碰 ~/.openrig。
describe("工作区 doctor HTTP 路由 (slice-21 FR-5)", () => {
  let doctorDir: string;
  let doctorApp: Hono;
  let configPath: string;

  beforeEach(async () => {
    doctorDir = fs.mkdtempSync(path.join(os.tmpdir(), "fr5-route-"));
    // 在 doctorDir 下构造一个健康的工作区结构。
    fs.mkdirSync(path.join(doctorDir, "missions", "getting-started"), { recursive: true });
    fs.writeFileSync(path.join(doctorDir, "missions", "getting-started", "MISSION_NOTES.md"), "");
    fs.mkdirSync(path.join(doctorDir, "missions", "getting-started", "slices", "s1"), { recursive: true });
    fs.writeFileSync(path.join(doctorDir, "missions", "getting-started", "slices", "s1", "README.md"), CONVENTION_BODY);

    // 桩对象,形状与 SettingsStore 一致 —— 只需 doctor 路由用到的表面:
    // resolveOne + configPath。SettingsStore 的公开表面很大,桩只对齐
    // resolveOne 的返回形状(value/source/defaultValue)。
    configPath = path.join(doctorDir, ".test-config.json");
    fs.writeFileSync(configPath, "{}");
    // 配置文件 mtime 强制设为 epoch(1970-01-01),这样无论 Vitest worker
    // 运行多久,路由由 process.uptime() 推导的后台服务启动时间都必定
    // 晚于配置 mtime。若改用 Date.now() - 60_000 这类相对偏移,当 worker
    // 存活时间超过该偏移时,检查 #5 会翻为 warn(已归档的守卫 BLOCKER,
    // 见 FR-5c qitem-20260602042720-e27ec982)。
    const epochMtime = new Date(0);
    fs.utimesSync(configPath, epochMtime, epochMtime);

    const stubStore = {
      configPath,
      resolveOne(key: string) {
        switch (key) {
          case "workspace.root":
            return { value: doctorDir, source: "env", defaultValue: doctorDir };
          case "workspace.slices_root":
            return { value: path.join(doctorDir, "missions"), source: "default", defaultValue: path.join(doctorDir, "missions") };
          case "files.allowlist":
            return { value: `workspace:${fs.realpathSync(doctorDir)}`, source: "default", defaultValue: `workspace:${doctorDir}` };
          default:
            return { value: "", source: "default", defaultValue: "" };
        }
      },
    };

    doctorApp = new Hono();
    doctorApp.use("*", async (c, next) => {
      c.set("settingsStore" as never, stubStore as never);
      await next();
    });
    doctorApp.route("/api/workspace", workspaceRoutes());
  });

  afterEach(() => {
    try { fs.rmSync(doctorDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("POST /doctor 在健康工作区上返回 200 与 8 项检查的 DoctorReport", async () => {
    const res = await doctorApp.request("/api/workspace/doctor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      workspaceRoot: string;
      checks: Array<{ check: string; status: string }>;
      summary: { ok: number; warn: number; fail: number };
      daemonResolvedAt: string;
    };
    expect(body.workspaceRoot).toBe(doctorDir);
    expect(body.checks).toHaveLength(8);
    expect(body.summary.ok).toBe(8);
    expect(body.summary.warn).toBe(0);
    expect(body.summary.fail).toBe(0);
    expect(body.daemonResolvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // 判别翻转:必须采用调用方提供的 workspaceRoot。
  // 若没有 body.workspaceRoot 分支,路由将始终检查后台服务解析出的工作区。
  it("POST /doctor 采用 body.workspaceRoot 作为受检工作区", async () => {
    const altRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fr5-route-alt-"));
    try {
      const res = await doctorApp.request("/api/workspace/doctor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceRoot: altRoot }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as {
        workspaceRoot: string;
        checks: Array<{ check: string; status: string; evidence?: Record<string, unknown> }>;
        summary: { ok: number; warn: number; fail: number };
      };
      expect(body.workspaceRoot).toBe(altRoot);
      // 检查 #4(daemon_points_at_this_workspace)必须 FAIL,因为后台服务
      // 解析出的 root 与调用方提供的不同。
      const daemonCheck = body.checks.find((c) => c.check === "daemon_points_at_this_workspace");
      expect(daemonCheck?.status).toBe("fail");
    } finally {
      fs.rmSync(altRoot, { recursive: true, force: true });
    }
  });

  // 判别翻转:SettingsStore 缺失时返回 503。若没有
  // `if (!store) return 503` 守卫,路由会崩溃。
  it("POST /doctor 在 settingsStore 不可用时返回 503", async () => {
    const bareApp = new Hono();
    bareApp.route("/api/workspace", workspaceRoutes());
    const res = await bareApp.request("/api/workspace/doctor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("settings_unavailable");
  });

  // 判别翻转:必须容忍空 body。若没有 .catch(() => ({})) 守卫,
  // JSON 解析会抛错,返回 500 而不是报告。
  it("POST /doctor 容忍空 body(无 Content-Type、无 JSON)", async () => {
    const res = await doctorApp.request("/api/workspace/doctor", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { workspaceRoot: string };
    expect(body.workspaceRoot).toBe(doctorDir);
  });

  // GUARD/QA BLOCKING-A2 判别:当 CLI 通过 body.filesAllowlistOverride
  // 转发 OPENRIG_FILES_ALLOWLIST 覆盖值时,后台服务路由的检查 #3 必须
  // 使用该值,而不是自身 SettingsStore 解析出的 files.allowlist。若没有
  // 覆盖分支,运维者的环境变量会静默失效。
  it("POST /doctor 检查 #3 采用 body.filesAllowlistOverride", async () => {
    // workspace:. 是相对路径;按 FR-5b BLOCKER-1,规范解码器会丢弃它,
    // 检查 #3 因零个可用条目而失败。后台服务 SettingsStore 桩返回的是
    // 健康 allowlist(workspace:${doctorDir});若没有覆盖分支,doctor 会
    // 高高兴兴地报 ok。加上覆盖后则正确失败。
    const res = await doctorApp.request("/api/workspace/doctor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filesAllowlistOverride: "workspace:." }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      checks: Array<{ check: string; status: string; evidence?: { allowlistSource?: string } }>;
      summary: { ok: number; warn: number; fail: number };
    };
    const allowlistCheck = body.checks.find((c) => c.check === "file_allowlist_sane");
    expect(allowlistCheck?.status).toBe("fail");
    // evidence 必须上报 source="env",让运维者知道覆盖已生效
    // (而非后台服务自身解析的结果)。
    expect(allowlistCheck?.evidence?.allowlistSource).toBe("env");
    expect(body.summary.fail).toBeGreaterThanOrEqual(1);
  });

  // 判别翻转:空字符串的 filesAllowlistOverride 不得抑制后台服务自身的
  // SettingsStore allowlist。若没有 length > 0 守卫,空覆盖会伪造检查结果。
  it("忽略空字符串 filesAllowlistOverride(改用后台服务的 SettingsStore)", async () => {
    const res = await doctorApp.request("/api/workspace/doctor", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filesAllowlistOverride: "" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      checks: Array<{ check: string; status: string; evidence?: { allowlistSource?: string } }>;
    };
    const allowlistCheck = body.checks.find((c) => c.check === "file_allowlist_sane");
    expect(allowlistCheck?.status).toBe("ok");
    // 桩对 files.allowlist 返回 source="default";验证走的是
    // SettingsStore,而非空覆盖。
    expect(allowlistCheck?.evidence?.allowlistSource).toBe("default");
  });

  // GUARD BLOCKER-1 (qitem-20260602042720-e27ec982) 确定性判别:
  // 即使在很长的 process.uptime() 下(模拟长时间运行的 Vitest worker),
  // 健康 fixture 仍必须返回 summary {ok:8, warn:0, fail:0}。若出现
  // 回归——路由测试的配置 mtime 改为相对 Date.now() 而非绝对旧 epoch——
  // 那么任何 worker 存活时间超过该相对偏移时,检查 #5 都会翻为 warn。
  it("POST /doctor 在模拟的长时间 worker 运行下保持健康", async () => {
    const origUptime = process.uptime;
    // 把后台服务启动时间强制拉到很远的过去(相对当前 Date.now() 约 10 年前);
    // epoch-1970 的配置 mtime 仍必须更旧。
    Object.defineProperty(process, "uptime", {
      value: () => 60 * 60 * 24 * 365 * 10,
      writable: true,
      configurable: true,
    });
    try {
      const res = await doctorApp.request("/api/workspace/doctor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as {
        summary: { ok: number; warn: number; fail: number };
        checks: Array<{ check: string; status: string }>;
      };
      expect(body.summary).toEqual({ ok: 8, warn: 0, fail: 0 });
      const reload = body.checks.find((c) => c.check === "daemon_reload_needed");
      expect(reload?.status).toBe("ok");
    } finally {
      Object.defineProperty(process, "uptime", {
        value: origUptime,
        writable: true,
        configurable: true,
      });
    }
  });
});
