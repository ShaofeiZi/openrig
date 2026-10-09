// Phase 3a slice 3.3——plugin HTTP 路由（TDD red→green）。
//
// SC-29 例外 #8 原文声明：
// "Slice 3.3 (UI plugin surface) requires daemon-side plugin-discovery-service
// + 3 条 HTTP 路由（GET /api/plugins、GET /api/plugins/:id、GET /api/plugins/:id/used-by）
// 作为后台 API。无额外状态、无 SQL migration、无 mutation 路由。
// 只读发现表面，按 DESIGN.md §5.4 聚合文件系统扫描并集。
// 按 IMPL-PRD §3.3 'Code touches' 此分配为显式；
// 遵照已入库 SC-29 逐字声明规则记录。"

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PluginDiscoveryService } from "../src/domain/plugin-discovery-service.js";
import { pluginsRoutes } from "../src/routes/plugins.js";

interface TestEnv {
  root: string;
  service: PluginDiscoveryService;
  openrigPluginsDir: string;
  claudeCacheDir: string;
  codexCacheDir: string;
  specLibraryDir: string;
}

function setup(): TestEnv {
  const root = mkdtempSync(join(tmpdir(), "plugins-routes-"));
  const openrigPluginsDir = join(root, "openrig-plugins");
  const claudeCacheDir = join(root, "claude-cache");
  const codexCacheDir = join(root, "codex-cache");
  const specLibraryDir = join(root, "specs");
  mkdirSync(openrigPluginsDir, { recursive: true });
  mkdirSync(claudeCacheDir, { recursive: true });
  mkdirSync(codexCacheDir, { recursive: true });
  mkdirSync(specLibraryDir, { recursive: true });
  const service = new PluginDiscoveryService({
    openrigPluginsDir,
    claudeCacheDir,
    codexCacheDir,
    specLibraryDir,
  });
  return { root, service, openrigPluginsDir, claudeCacheDir, codexCacheDir, specLibraryDir };
}

function writeClaudePluginManifest(pluginDir: string, manifest: Record<string, unknown>): void {
  const manifestDir = join(pluginDir, ".claude-plugin");
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(join(manifestDir, "plugin.json"), JSON.stringify(manifest, null, 2));
}

function writeCodexPluginManifest(pluginDir: string, manifest: Record<string, unknown>): void {
  const manifestDir = join(pluginDir, ".codex-plugin");
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(join(manifestDir, "plugin.json"), JSON.stringify(manifest, null, 2));
}

function createApp(service: PluginDiscoveryService): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("pluginDiscoveryService" as never, service);
    await next();
  });
  app.route("/api/plugins", pluginsRoutes());
  return app;
}

describe("plugin HTTP 路由", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    rmSync(env.root, { recursive: true, force: true });
  });

  describe("GET /api/plugins", () => {
    it("未发现 plugin 时返回空数组", async () => {
      const res = await createApp(env.service).request("/api/plugins");
      expect(res.status).toBe(200);
      const body = await res.json() as unknown[];
      expect(body).toEqual([]);
    });

    it("返回聚合后的 plugin 列表", async () => {
      writeClaudePluginManifest(join(env.openrigPluginsDir, "openrig-core"), {
        name: "openrig-core",
        version: "0.1.0",
        description: "vendored",
      });
      writeCodexPluginManifest(join(env.openrigPluginsDir, "openrig-core"), {
        name: "openrig-core",
        version: "0.1.0",
        description: "vendored",
      });
      writeClaudePluginManifest(join(env.claudeCacheDir, "anthropics", "github", "1.0.0"), {
        name: "github",
        version: "1.0.0",
        description: "claude-cache",
      });

      const res = await createApp(env.service).request("/api/plugins");
      expect(res.status).toBe(200);
      const body = await res.json() as Array<{ name: string; source: string; runtimes: string[] }>;
      expect(body).toHaveLength(2);
      const names = body.map((p) => p.name).sort();
      expect(names).toEqual(["github", "openrig-core"]);
    });

    it("支持通过 query string 按 runtime 筛选", async () => {
      writeClaudePluginManifest(join(env.openrigPluginsDir, "claude-only"), {
        name: "claude-only",
        version: "1.0.0",
        description: "x",
      });
      writeCodexPluginManifest(join(env.openrigPluginsDir, "codex-only"), {
        name: "codex-only",
        version: "1.0.0",
        description: "x",
      });

      const claudeRes = await createApp(env.service).request("/api/plugins?runtime=claude");
      expect(claudeRes.status).toBe(200);
      const claudeBody = await claudeRes.json() as Array<{ name: string }>;
      expect(claudeBody.map((p) => p.name)).toEqual(["claude-only"]);

      const codexRes = await createApp(env.service).request("/api/plugins?runtime=codex");
      expect(codexRes.status).toBe(200);
      const codexBody = await codexRes.json() as Array<{ name: string }>;
      expect(codexBody.map((p) => p.name)).toEqual(["codex-only"]);
    });

    it("slice 3.3 fix-C——支持通过 ?cwd=<path> query 参数发现 rig-cwd", async () => {
      // velocity-qa VM 验证失败 #3——DESIGN §5.4 union 第四类（rig-bundled cwd plugin root）。
      // API 通过 ?cwd=<path> 公开逐调用 cwd 扫描；service 输出来源为 rig-cwd 的发现结果。
      const rigCwd = join(env.root, "rig-cwd-api");
      const claudeBundleDir = join(rigCwd, ".claude", "plugins");
      mkdirSync(claudeBundleDir, { recursive: true });
      writeClaudePluginManifest(join(claudeBundleDir, "rig-tool"), {
        name: "rig-tool",
        version: "1.0.0",
        description: "rig-bundled tool",
      });

      // 没有 ?cwd 时不产生 rig-cwd 发现结果。
      const baseRes = await createApp(env.service).request("/api/plugins");
      const base = await baseRes.json() as Array<{ source: string }>;
      expect(base.some((p) => p.source === "rig-cwd")).toBe(false);

      // 带 ?cwd=<path> 时显示 rig-tool。
      const cwdRes = await createApp(env.service).request(
        `/api/plugins?cwd=${encodeURIComponent(rigCwd)}`,
      );
      const cwdPlugins = await cwdRes.json() as Array<{ name: string; source: string }>;
      const rigCwdSubset = cwdPlugins.filter((p) => p.source === "rig-cwd");
      expect(rigCwdSubset).toHaveLength(1);
      expect(rigCwdSubset[0]?.name).toBe("rig-tool");
    });

    it("slice 3.3 fix-iteration——rig-cwd plugin 的 list ?cwd= + detail 往返（无 404）", async () => {
      // redo-guard-2 BLOCK 第 1 项：/api/plugins?cwd= 可列出；
      // /api/plugins/<encoded-rig-cwd-id> 必须返回 200 而非 404。修复位于
      // PluginDiscoveryService.getPlugin，通过 id 前缀自行解析。
      const rigCwd = join(env.root, "rig-cwd-roundtrip");
      const claudeBundleDir = join(rigCwd, ".claude", "plugins");
      mkdirSync(claudeBundleDir, { recursive: true });
      writeClaudePluginManifest(join(claudeBundleDir, "roundtrip-tool"), {
        name: "roundtrip-tool",
        version: "1.0.0",
        description: "roundtrip",
      });

      // 第 1 步：带 ?cwd= 列表并捕获 id。
      const listRes = await createApp(env.service).request(
        `/api/plugins?cwd=${encodeURIComponent(rigCwd)}`,
      );
      expect(listRes.status).toBe(200);
      const list = await listRes.json() as Array<{ id: string; source: string }>;
      const rigCwdEntry = list.find((p) => p.source === "rig-cwd");
      expect(rigCwdEntry).toBeDefined();
      const rigCwdId = rigCwdEntry!.id;

      // 第 2 步：使用该 id 请求 detail，必须返回 200（修复前为 404）。
      const detailRes = await createApp(env.service).request(
        `/api/plugins/${encodeURIComponent(rigCwdId)}`,
      );
      expect(detailRes.status).toBe(200);
      const detail = await detailRes.json() as { entry: { name: string; source: string } };
      expect(detail.entry.name).toBe("roundtrip-tool");
      expect(detail.entry.source).toBe("rig-cwd");
    });

    it("支持通过 query string 按 source 筛选", async () => {
      writeClaudePluginManifest(join(env.openrigPluginsDir, "vended"), {
        name: "vended",
        version: "0.1.0",
        description: "x",
      });
      writeClaudePluginManifest(join(env.claudeCacheDir, "anthropics", "cached", "1.0.0"), {
        name: "cached",
        version: "1.0.0",
        description: "x",
      });

      const vendoredRes = await createApp(env.service).request("/api/plugins?source=vendored");
      const vendored = await vendoredRes.json() as Array<{ name: string }>;
      expect(vendored.map((p) => p.name)).toEqual(["vended"]);

      const cacheRes = await createApp(env.service).request("/api/plugins?source=claude-cache");
      const cache = await cacheRes.json() as Array<{ name: string }>;
      expect(cache.map((p) => p.name)).toEqual(["cached"]);
    });

    it("service 未配置时返回 503", async () => {
      const app = new Hono();
      app.route("/api/plugins", pluginsRoutes());
      const res = await app.request("/api/plugins");
      expect(res.status).toBe(503);
    });
  });

  describe("GET /api/plugins/:id", () => {
    it("未知 plugin id 返回 404", async () => {
      const res = await createApp(env.service).request("/api/plugins/nonexistent");
      expect(res.status).toBe(404);
    });

    it("返回包含 manifest + skills + hooks 的 plugin detail", async () => {
      const corePluginDir = join(env.openrigPluginsDir, "openrig-core");
      writeClaudePluginManifest(corePluginDir, {
        name: "openrig-core",
        version: "0.1.0",
        description: "Canonical OpenRig content",
      });
      mkdirSync(join(corePluginDir, "skills", "openrig-user"), { recursive: true });
      writeFileSync(
        join(corePluginDir, "skills", "openrig-user", "SKILL.md"),
        "---\nname: openrig-user\n---\n",
      );
      mkdirSync(join(corePluginDir, "hooks"), { recursive: true });
      writeFileSync(
        join(corePluginDir, "hooks", "claude.json"),
        JSON.stringify({
          hooks: { SessionStart: [{ type: "command", command: "echo hi" }] },
        }),
      );

      const res = await createApp(env.service).request("/api/plugins/openrig-core");
      expect(res.status).toBe(200);
      const body = await res.json() as {
        entry: { name: string };
        claudeManifest: { name: string };
        skills: Array<{ name: string }>;
        hooks: Array<{ runtime: string; events: string[] }>;
      };
      expect(body.entry.name).toBe("openrig-core");
      expect(body.claudeManifest?.name).toBe("openrig-core");
      expect(body.skills.map((s) => s.name)).toEqual(["openrig-user"]);
      expect(body.hooks).toHaveLength(1);
      expect(body.hooks[0]?.runtime).toBe("claude");
      expect(body.hooks[0]?.events).toContain("SessionStart");
    });
  });

  describe("GET /api/plugins/:id/used-by", () => {
    it("没有 agent 使用 plugin 时返回空列表", async () => {
      const res = await createApp(env.service).request("/api/plugins/openrig-core/used-by");
      expect(res.status).toBe(200);
      const body = await res.json() as unknown[];
      expect(body).toEqual([]);
    });

    it("返回带 profile 名称的 agent 引用", async () => {
      const advisorDir = join(env.specLibraryDir, "advisor");
      mkdirSync(advisorDir, { recursive: true });
      writeFileSync(
        join(advisorDir, "agent.yaml"),
        `name: advisor-lead
version: "1.0"
defaults:
  runtime: claude-code
profiles:
  default:
    uses:
      plugins:
        - openrig-core
  review:
    uses:
      plugins:
        - openrig-core
        - reviewer-tools
resources:
  plugins:
    - id: openrig-core
      source:
        kind: local
        path: ~/.openrig/plugins/openrig-core
    - id: reviewer-tools
      source:
        kind: local
        path: ~/.openrig/plugins/reviewer-tools
  skills: []
startup:
  files: []
  actions: []
`,
      );

      const res = await createApp(env.service).request("/api/plugins/openrig-core/used-by");
      expect(res.status).toBe(200);
      const body = await res.json() as Array<{ agentName: string; profiles: string[] }>;
      expect(body).toHaveLength(1);
      expect(body[0]?.agentName).toBe("advisor-lead");
      expect(body[0]?.profiles.sort()).toEqual(["default", "review"]);
    });
  });

  describe("drift-discriminator 回归覆盖", () => {
    it("每种路由结构都可观察地区分（按预存 feedback_poc_regression_must_discriminate）", async () => {
      // 在 3 个 source root 中分别放置 3 个 plugin，使 list endpoint 必须跨三者聚合；验证响应可区分它们。
      writeClaudePluginManifest(join(env.openrigPluginsDir, "vended"), {
        name: "vended", version: "0.1.0", description: "v",
      });
      writeClaudePluginManifest(join(env.claudeCacheDir, "anthropics", "claude-tool", "2.0.0"), {
        name: "claude-tool", version: "2.0.0", description: "c",
      });
      writeCodexPluginManifest(join(env.codexCacheDir, "openai", "codex-tool", "3.0.0"), {
        name: "codex-tool", version: "3.0.0", description: "x",
      });

      const listRes = await createApp(env.service).request("/api/plugins");
      const list = await listRes.json() as Array<{ source: string }>;
      const sources = list.map((p) => p.source).sort();
      expect(sources).toEqual(["claude-cache", "codex-cache", "vendored"]);
    });
  });
});
