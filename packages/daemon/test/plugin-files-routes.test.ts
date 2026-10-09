// Slice 28 Checkpoint C-1——plugin 文档浏览器路由与 skillCount 增强。
//
// SC-29 例外 #11 已在 packages/daemon/src/routes/plugins.ts 文件头逐字声明。本测试文件覆盖
// 两个新 endpoint 和增量的 PluginEntry.skillCount 字段。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
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
  const root = mkdtempSync(join(tmpdir(), "plugin-files-routes-"));
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

function writeClaudeManifest(pluginDir: string, manifest: Record<string, unknown>): void {
  const manifestDir = join(pluginDir, ".claude-plugin");
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

function makePluginWithFolders(pluginsDir: string, name: string, opts: { skills?: string[]; readme?: string; hooks?: boolean } = {}): string {
  const pluginDir = join(pluginsDir, name);
  writeClaudeManifest(pluginDir, { name, version: "1.0.0", description: `${name} test plugin` });
  if (opts.readme !== undefined) {
    writeFileSync(join(pluginDir, "README.md"), opts.readme);
  }
  if (opts.skills) {
    const skillsDir = join(pluginDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    for (const skillName of opts.skills) {
      const skillDir = join(skillsDir, skillName);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), `# ${skillName}\nSkill content.`);
    }
  }
  if (opts.hooks) {
    const hooksDir = join(pluginDir, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "claude.json"), JSON.stringify({ hooks: {} }));
  }
  return pluginDir;
}

describe("PluginEntry.skillCount 增强（slice 28）", () => {
  let env: TestEnv;
  beforeEach(() => { env = setup(); });
  afterEach(() => { rmSync(env.root, { recursive: true, force: true }); });

  it("plugin 没有 skills/ 目录时填充 skillCount = 0", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "skinny");
    const res = await createApp(env.service).request("/api/plugins");
    const body = (await res.json()) as Array<{ id: string; skillCount: number }>;
    const skinny = body.find((p) => p.id === "skinny");
    expect(skinny).toBeDefined();
    expect(skinny!.skillCount).toBe(0);
  });

  it("plugin 发布 N 个 skill 目录时填充 skillCount = N", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core", {
      skills: ["openrig-user", "openrig-architect", "queue-handoff"],
    });
    const res = await createApp(env.service).request("/api/plugins");
    const body = (await res.json()) as Array<{ id: string; skillCount: number }>;
    const core = body.find((p) => p.id === "openrig-core");
    expect(core).toBeDefined();
    expect(core!.skillCount).toBe(3);
  });

  it("也在 PluginDetail.entry 上填充 skillCount（detail endpoint 对齐）", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core", { skills: ["alpha", "beta"] });
    const res = await createApp(env.service).request("/api/plugins/openrig-core");
    const body = (await res.json()) as { entry: { skillCount: number } };
    expect(body.entry.skillCount).toBe(2);
  });

  it("skillCount 只计算 skills/ 下的子目录（忽略散落文件）", async () => {
    const pluginDir = makePluginWithFolders(env.openrigPluginsDir, "core-with-stray", { skills: ["a", "b"] });
    // 在 skills/ 中放入散落文件，不得计数。
    writeFileSync(join(pluginDir, "skills", "README.md"), "stray file");
    const res = await createApp(env.service).request("/api/plugins");
    const body = (await res.json()) as Array<{ id: string; skillCount: number }>;
    const core = body.find((p) => p.id === "core-with-stray");
    expect(core!.skillCount).toBe(2);
  });
});

describe("GET /api/plugins/:id/files/list（slice 28）", () => {
  let env: TestEnv;
  beforeEach(() => { env = setup(); });
  afterEach(() => { rmSync(env.root, { recursive: true, force: true }); });

  it("列出 plugin 根目录的文件和目录（path=''）", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core", {
      skills: ["alpha"],
      readme: "# OpenRig Core\nplugin docs",
      hooks: true,
    });
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/list?path=");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pluginId: string; path: string; entries: Array<{ name: string; type: string }> };
    expect(body.pluginId).toBe("openrig-core");
    expect(body.path).toBe("");
    const names = body.entries.map((e) => e.name);
    // 目录优先（按名称排序），随后是文件。Plugin 根目录包含：
    // .claude-plugin/、hooks/、skills/、README.md。
    expect(names).toContain(".claude-plugin");
    expect(names).toContain("hooks");
    expect(names).toContain("skills");
    expect(names).toContain("README.md");
    // 验证目录先于文件的顺序。
    const readmeIdx = names.indexOf("README.md");
    const skillsIdx = names.indexOf("skills");
    expect(skillsIdx).toBeLessThan(readmeIdx);
  });

  it("列出嵌套目录内容（path='skills'）", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core", { skills: ["alpha", "beta"] });
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/list?path=skills");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ name: string; type: string }> };
    const names = body.entries.map((e) => e.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(body.entries.every((e) => e.type === "dir")).toBe(true);
  });

  it("plugin id 未知时返回 404", async () => {
    const res = await createApp(env.service).request("/api/plugins/missing/files/list?path=");
    expect(res.status).toBe(404);
  });

  it("以 400 path_escape 拒绝 '..' 逃逸尝试", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core", { skills: ["alpha"] });
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/list?path=..%2Fsomewhere");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("path_escape");
  });

  it("以 400 path_invalid 拒绝绝对路径", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core");
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/list?path=%2Fetc");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("path_invalid");
  });

  it("拒绝 symlink 逃逸（realpath 位于 plugin 目录外）", async () => {
    const pluginDir = makePluginWithFolders(env.openrigPluginsDir, "openrig-core");
    // 在 plugin 内创建指向外部的 symlink。
    const escapeTarget = join(env.root, "outside-target");
    mkdirSync(escapeTarget, { recursive: true });
    writeFileSync(join(escapeTarget, "secret.txt"), "out-of-bounds");
    symlinkSync(escapeTarget, join(pluginDir, "escape-link"));
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/list?path=escape-link");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("path_escape");
  });
});

describe("GET /api/plugins/:id/files/read（slice 28）", () => {
  let env: TestEnv;
  beforeEach(() => { env = setup(); });
  afterEach(() => { rmSync(env.root, { recursive: true, force: true }); });

  it("读取 plugin 根目录的 README.md", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core", { readme: "# Plugin docs body" });
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/read?path=README.md");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pluginId: string;
      path: string;
      content: string;
      contentHash: string;
      size: number;
      truncated: boolean;
    };
    expect(body.pluginId).toBe("openrig-core");
    expect(body.path).toBe("README.md");
    expect(body.content).toContain("Plugin docs body");
    expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.truncated).toBe(false);
  });

  it("读取嵌套 skill 的 SKILL.md 文件", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core", { skills: ["openrig-user"] });
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/read?path=skills%2Fopenrig-user%2FSKILL.md");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string };
    expect(body.content).toContain("# openrig-user");
  });

  it("缺少 path query 时返回 400 path_required", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core");
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/read");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("path_required");
  });

  it("plugin id 未知时返回 404", async () => {
    const res = await createApp(env.service).request("/api/plugins/missing/files/read?path=README.md");
    expect(res.status).toBe(404);
  });

  it("plugin 下文件不存在时返回 404 stat_failed", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core");
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/read?path=nonexistent.md");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("stat_failed");
  });

  it("以 400 path_escape 拒绝 '..' 逃逸尝试", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core");
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/read?path=..%2Fsomewhere.md");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("path_escape");
  });
});

describe("路由顺序纪律（slice 28）：/files/list + /files/read 在裸 /:id 之前挂载", () => {
  let env: TestEnv;
  beforeEach(() => { env = setup(); });
  afterEach(() => { rmSync(env.root, { recursive: true, force: true }); });

  it("/api/plugins/openrig-core/files/list 不会被 /:id catchall 捕获（404 与 detail 的区别）", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core", { skills: ["alpha"] });
    // /:id catchall 会把 'openrig-core' 当作 id 并忽略余下路径。更早挂载的 /files/list 会在该
    // catchall 之前拦截子路径。判别条件：响应结构包含 `entries`（list），而非 `entry` + `skills`
    //（detail）。
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/list?path=");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries?: unknown; entry?: unknown };
    expect(body.entries).toBeDefined();
    expect(body.entry).toBeUndefined();
  });

  it("/api/plugins/openrig-core/files/read 不会被 /:id catchall 捕获", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core", { readme: "doc" });
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/read?path=README.md");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content?: unknown; entry?: unknown };
    expect(body.content).toBeDefined();
    expect(body.entry).toBeUndefined();
  });
});
