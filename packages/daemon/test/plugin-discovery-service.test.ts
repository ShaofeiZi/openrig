// Phase 3a slice 3.3——plugin-discovery-service 测试（TDD red→green）。
//
// SC-29 EXCEPTION #8 原文声明：
// "Slice 3.3（UI plugin surface）需要后台服务侧 plugin-discovery-service
// + 3 条 HTTP 路由（GET /api/plugins、GET /api/plugins/:id、GET /api/plugins/:id/used-by）
// 作为后端 API。不新增 state、不迁移 SQL、不增加 mutation route。按 DESIGN.md §5.4，
// 只读 discovery surface 聚合文件系统扫描并集。按 IMPL-PRD §3.3 'Code touches'，此分配是
// 显式的；这里按已记录 SC-29 逐字声明规则进行说明。"
//
// Discovery service 契约：
//   - listPlugins({ runtimeFilter?, sourceFilter?, agentRefFilter? })
//     → PluginEntry[] 并集：
//       * ~/.openrig/plugins/* (vendored)
//       * ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/ (claude-cache)
//       * ~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/ (codex-cache)
//       * agent-ref discovery（agent.yaml resources.plugins[] 内联引用的 plugin）
//   - getPlugin(id) → 包含完整 manifest 内容 + tree summary 的 PluginManifest
//   - findUsedBy(id) → AgentReference[]（引用该 plugin id 的 agent.yaml）
//
// 易于 branch merge：本 service 通过文件系统读取 + 原始 YAML 字符串匹配实现 used-by；不依赖
// plugin-primitive-v0 branch 中 batch 1 的 PluginResource type。合入 plugin-primitive-v0 后，
// 本 service 仍可配合正式 PluginResource type 工作。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PluginDiscoveryService } from "../src/domain/plugin-discovery-service.js";

interface TempDirs {
  root: string;
  openrigPluginsDir: string;
  claudeCacheDir: string;
  codexCacheDir: string;
  specLibraryDir: string;
}

function setupTempDirs(): TempDirs {
  const root = mkdtempSync(join(tmpdir(), "plugin-discovery-test-"));
  const openrigPluginsDir = join(root, "openrig-plugins");
  const claudeCacheDir = join(root, "claude-cache");
  const codexCacheDir = join(root, "codex-cache");
  const specLibraryDir = join(root, "specs", "agents");
  mkdirSync(openrigPluginsDir, { recursive: true });
  mkdirSync(claudeCacheDir, { recursive: true });
  mkdirSync(codexCacheDir, { recursive: true });
  mkdirSync(specLibraryDir, { recursive: true });
  return { root, openrigPluginsDir, claudeCacheDir, codexCacheDir, specLibraryDir };
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

function writeHookManifest(pluginDir: string, runtime: "claude" | "codex", event: string, command: string): void {
  writeHookRegistry(pluginDir, runtime, {
    [event]: [{ hooks: [{ type: "command", command }] }],
  });
}

function writeHookRegistry(
  pluginDir: string,
  runtime: "claude" | "codex",
  hooks: Record<string, unknown>,
): void {
  const hooksDir = join(pluginDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, `${runtime}.json`), JSON.stringify({
    hooks,
  }));
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("PluginDiscoveryService", () => {
  let dirs: TempDirs;

  beforeEach(() => {
    dirs = setupTempDirs();
  });

  afterEach(() => {
    rmSync(dirs.root, { recursive: true, force: true });
  });

  describe("listPlugins", () => {
    it("没有 plugin source 包含 plugin 时返回空列表", () => {
      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      expect(service.listPlugins()).toEqual([]);
    });

    it("在重复校验前退役历史 openrig-lab refocus 注册", () => {
      const core = join(dirs.openrigPluginsDir, "openrig-core");
      const lab = join(dirs.openrigPluginsDir, "openrig-lab");
      writeClaudePluginManifest(core, { name: "openrig-core", version: "0.1.0", hooks: "./hooks/claude.json" });
      writeCodexPluginManifest(core, { name: "openrig-core", version: "0.1.0", hooks: "./hooks/codex.json" });
      writeClaudePluginManifest(lab, { name: "openrig-lab", version: "0.1.0", hooks: "./hooks/claude.json" });
      writeCodexPluginManifest(lab, { name: "openrig-lab", version: "0.1.0", hooks: "./hooks/codex.json" });
      writeHookRegistry(core, "claude", Object.fromEntries(
        ["SessionStart", "UserPromptSubmit", "PostCompact", "Stop"].map((event) => [
          event,
          [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/refocus.cjs"' }] }],
        ]),
      ));
      writeHookRegistry(core, "codex", Object.fromEntries(
        ["SessionStart", "UserPromptSubmit", "Stop"].map((event) => [
          event,
          [{ hooks: [{ type: "command", command: 'node "${PLUGIN_ROOT}/hooks/scripts/refocus.cjs"' }] }],
        ]),
      ));
      // 在 release-boundary ops archive 中保留精确的 obsolete event set。
      writeHookRegistry(lab, "claude", Object.fromEntries(
        ["SessionStart", "UserPromptSubmit", "Stop", "PostCompact"].map((event) => [
          event,
          [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/refocus.cjs"', timeout: 5 }] }],
        ]),
      ));
      writeHookRegistry(lab, "codex", Object.fromEntries(
        ["SessionStart", "UserPromptSubmit", "Stop"].map((event) => [
          event,
          [{ hooks: [{ type: "command", command: 'node "${PLUGIN_ROOT}/hooks/scripts/refocus.cjs"', timeout: 5 }] }],
        ]),
      ));

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });

      expect(service.listPlugins().map((plugin) => plugin.id).sort()).toEqual(["openrig-core", "openrig-lab"]);
      expect(readJson(join(lab, ".claude-plugin", "plugin.json"))).not.toHaveProperty("hooks");
      expect(readJson(join(lab, ".codex-plugin", "plugin.json"))).not.toHaveProperty("hooks");
      expect(readJson(join(lab, "hooks", "claude.json"))).toEqual({ hooks: {} });
      expect(readJson(join(lab, "hooks", "codex.json"))).toEqual({ hooks: {} });
      expect(readJson(join(core, ".claude-plugin", "plugin.json"))).toHaveProperty("hooks", "./hooks/claude.json");
      expect(readJson(join(core, ".codex-plugin", "plugin.json"))).toHaveProperty("hooks", "./hooks/codex.json");
    });

    it("只从 openrig-lab 移除 obsolete refocus 命令", () => {
      const core = join(dirs.openrigPluginsDir, "openrig-core");
      const lab = join(dirs.openrigPluginsDir, "openrig-lab");
      writeClaudePluginManifest(core, { name: "openrig-core", version: "0.1.0", hooks: "./hooks/claude.json" });
      writeClaudePluginManifest(lab, { name: "openrig-lab", version: "0.1.0", hooks: "./hooks/claude.json" });
      writeHookManifest(core, "claude", "Stop", 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/refocus.cjs"');
      writeHookRegistry(lab, "claude", {
        Stop: [{ hooks: [
          { type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/refocus.cjs"', timeout: 5 },
          { type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/activity-relay.cjs"', timeout: 5 },
        ] }],
      });

      expect(() => new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      })).not.toThrow();

      expect(readJson(join(lab, ".claude-plugin", "plugin.json"))).toHaveProperty("hooks", "./hooks/claude.json");
      expect(readJson(join(lab, "hooks", "claude.json"))).toEqual({
        hooks: {
          Stop: [{ hooks: [
            { type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/activity-relay.cjs"', timeout: 5 },
          ] }],
        },
      });
    });

    it("未知 vendored plugin 重复 hook identity 时明确失败并列出两个 Claude manifest 路径", () => {
      const core = join(dirs.openrigPluginsDir, "openrig-core");
      const rogue = join(dirs.openrigPluginsDir, "openrig-rogue");
      writeClaudePluginManifest(core, { name: "openrig-core", version: "0.1.0", hooks: "./hooks/claude.json" });
      writeClaudePluginManifest(rogue, { name: "openrig-rogue", version: "0.1.0", hooks: "./hooks/claude.json" });
      writeHookManifest(core, "claude", "Stop", 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/refocus.cjs"');
      writeHookManifest(rogue, "claude", "Stop", 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/refocus.cjs"');

      expect(() => new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      })).toThrow(new RegExp(`${core}/hooks/claude\\.json.*${rogue}/hooks/claude\\.json`));
    });

    it("未知 vendored plugin 重复 hook identity 时明确失败并列出两个 Codex manifest 路径", () => {
      const core = join(dirs.openrigPluginsDir, "openrig-core");
      const rogue = join(dirs.openrigPluginsDir, "openrig-rogue");
      writeCodexPluginManifest(core, { name: "openrig-core", version: "0.1.0", hooks: "./hooks/codex.json" });
      writeCodexPluginManifest(rogue, { name: "openrig-rogue", version: "0.1.0", hooks: "./hooks/codex.json" });
      writeHookManifest(core, "codex", "Stop", 'node "${PLUGIN_ROOT}/hooks/scripts/refocus.cjs"');
      writeHookManifest(rogue, "codex", "Stop", 'node "${PLUGIN_ROOT}/hooks/scripts/refocus.cjs"');

      expect(() => new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      })).toThrow(new RegExp(`${core}/hooks/codex\\.json.*${rogue}/hooks/codex\\.json`));
    });

    it("发现 vendored OpenRig plugin（dual-manifest）", () => {
      const corePluginDir = join(dirs.openrigPluginsDir, "openrig-core");
      writeClaudePluginManifest(corePluginDir, {
        name: "openrig-core",
        version: "0.1.0",
        description: "OpenRig canonical skills and hooks",
      });
      writeCodexPluginManifest(corePluginDir, {
        name: "openrig-core",
        version: "0.1.0",
        description: "OpenRig canonical skills and hooks",
      });

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const plugins = service.listPlugins();
      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toMatchObject({
        id: "openrig-core",
        name: "openrig-core",
        version: "0.1.0",
        source: "vendored",
        sourceLabel: "vendored:openrig-core",
        runtimes: ["claude", "codex"],
      });
    });

    it("发现 Claude cache plugin（仅 Claude manifest）", () => {
      const claudePluginPath = join(dirs.claudeCacheDir, "anthropics", "github", "1.0.0");
      writeClaudePluginManifest(claudePluginPath, {
        name: "github",
        version: "1.0.0",
        description: "GitHub integration",
      });

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const plugins = service.listPlugins();
      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toMatchObject({
        name: "github",
        version: "1.0.0",
        source: "claude-cache",
        sourceLabel: "claude-cache:anthropics/github/1.0.0",
        runtimes: ["claude"],
      });
    });

    it("发现 Codex cache plugin（仅 Codex manifest）", () => {
      const codexPluginPath = join(dirs.codexCacheDir, "openai", "tools", "0.5.0");
      writeCodexPluginManifest(codexPluginPath, {
        name: "tools",
        version: "0.5.0",
        description: "Codex tools",
      });

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const plugins = service.listPlugins();
      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toMatchObject({
        name: "tools",
        version: "0.5.0",
        source: "codex-cache",
        sourceLabel: "codex-cache:openai/tools/0.5.0",
        runtimes: ["codex"],
      });
    });

    it("聚合全部 3 个 source root 的 discovery，并使用不同 source label", () => {
      // 按已记录 feedback_poc_regression_must_discriminate 做 drift-discriminator 回归检查。
      // 三个 source 各用不同值，使 layer discrimination 可观测。
      writeClaudePluginManifest(join(dirs.openrigPluginsDir, "openrig-core"), {
        name: "openrig-core",
        version: "0.1.0",
        description: "vendored",
      });
      writeClaudePluginManifest(join(dirs.claudeCacheDir, "anthropics", "github", "1.0.0"), {
        name: "github",
        version: "1.0.0",
        description: "claude-cache",
      });
      writeCodexPluginManifest(join(dirs.codexCacheDir, "openai", "tools", "0.5.0"), {
        name: "tools",
        version: "0.5.0",
        description: "codex-cache",
      });

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const plugins = service.listPlugins();
      expect(plugins).toHaveLength(3);
      // 每层使用不同 source label。
      const sources = plugins.map((p) => p.source).sort();
      expect(sources).toEqual(["claude-cache", "codex-cache", "vendored"]);
    });

    it("忽略没有 plugin manifest 的目录", () => {
      mkdirSync(join(dirs.openrigPluginsDir, "not-a-plugin"), { recursive: true });
      writeFileSync(
        join(dirs.openrigPluginsDir, "not-a-plugin", "README.md"),
        "Not a plugin",
      );

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      expect(service.listPlugins()).toEqual([]);
    });

    it("slice 3.3 fix-C——提供 cwdScanRoots 时扫描工作组随附的 cwd plugin root", () => {
      // velocity-qa VM verify failure #3——DESIGN §5.4 的 source 并集必须包含工作组随附的
      // <cwd>/.claude/plugins/* 与 <cwd>/.codex/plugins/*（IMPL-PRD §1.2 的 projection target）。
      // 实现：PluginDiscoveryService 接受可选 cwdScanRoots（构造器 + 逐调用）；每个已扫描 cwd
      // 以 `rig-cwd:` source label 提供 discovery。
      const rigCwd = join(dirs.root, "rig-cwd-1");
      const claudeBundleDir = join(rigCwd, ".claude", "plugins");
      const codexBundleDir = join(rigCwd, ".codex", "plugins");
      mkdirSync(claudeBundleDir, { recursive: true });
      mkdirSync(codexBundleDir, { recursive: true });
      writeClaudePluginManifest(join(claudeBundleDir, "rig-tool"), {
        name: "rig-tool",
        version: "1.0.0",
        description: "Rig-bundled tool",
      });
      writeCodexPluginManifest(join(codexBundleDir, "rig-codex-tool"), {
        name: "rig-codex-tool",
        version: "1.0.0",
        description: "Rig-bundled codex tool",
      });

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
        cwdScanRoots: [rigCwd],
      });
      const plugins = service.listPlugins();
      // 两个 plugin：一个在 Claude 侧，一个在 Codex 侧；两者都标为 rig-cwd。
      const cwdPlugins = plugins.filter((p) => p.source === "rig-cwd");
      expect(cwdPlugins).toHaveLength(2);
      const names = cwdPlugins.map((p) => p.name).sort();
      expect(names).toEqual(["rig-codex-tool", "rig-tool"]);
      // Source label 嵌入工作组 cwd 尾部用于消歧；每个 plugin label 包含其名称，与顺序无关。
      const labels = cwdPlugins.map((p) => p.sourceLabel);
      expect(labels.some((l) => /^rig-cwd:.*rig-tool$/.test(l))).toBe(true);
      expect(labels.some((l) => /^rig-cwd:.*rig-codex-tool$/.test(l))).toBe(true);
    });

    it("slice 3.3 fix-C——逐调用 cwdScanRoots 覆盖构造器 option", () => {
      // 允许 API 层动态传递 ?cwd=<path>，而不修改 service singleton。
      const rigCwd = join(dirs.root, "rig-cwd-dyn");
      const claudeBundleDir = join(rigCwd, ".claude", "plugins");
      mkdirSync(claudeBundleDir, { recursive: true });
      writeClaudePluginManifest(join(claudeBundleDir, "ephemeral-tool"), {
        name: "ephemeral-tool",
        version: "0.1.0",
        description: "dynamic",
      });

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      // 构造时不提供 cwd。
      expect(service.listPlugins().filter((p) => p.source === "rig-cwd")).toEqual([]);
      // 逐调用 cwd 呈现随附 plugin。
      const withCwd = service.listPlugins({ cwdScanRoots: [rigCwd] });
      expect(withCwd.filter((p) => p.source === "rig-cwd")).toHaveLength(1);
      expect(withCwd.find((p) => p.name === "ephemeral-tool")).toBeDefined();
    });

    it("请求时按 runtime 过滤", () => {
      writeClaudePluginManifest(join(dirs.openrigPluginsDir, "claude-only"), {
        name: "claude-only",
        version: "1.0.0",
        description: "x",
      });
      writeCodexPluginManifest(join(dirs.openrigPluginsDir, "codex-only"), {
        name: "codex-only",
        version: "1.0.0",
        description: "x",
      });

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const claudeOnly = service.listPlugins({ runtimeFilter: "claude" });
      expect(claudeOnly).toHaveLength(1);
      expect(claudeOnly[0]?.name).toBe("claude-only");
      const codexOnly = service.listPlugins({ runtimeFilter: "codex" });
      expect(codexOnly).toHaveLength(1);
      expect(codexOnly[0]?.name).toBe("codex-only");
    });
  });

  describe("getPlugin", () => {
    it("未找到 plugin 时返回 null", () => {
      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      expect(service.getPlugin("nonexistent")).toBeNull();
    });

    it("从 manifest mcpServers 字段返回 MCP server summary（slice 3.3 fix-A）", () => {
      // velocity-qa VM verify failure #1：按 DESIGN §5.7 + IMPL-PRD §3.2，PluginViewer 需要
      // MCP section。Manifest 的 mcpServers 字段是以 server-name → server-config 为 key 的
      // object。Discovery 每个 key 返回一个 PluginMcpServerSummary；尽力呈现 name 以及已声明的
      // command/transport metadata。
      const corePluginDir = join(dirs.openrigPluginsDir, "openrig-mcp");
      writeClaudePluginManifest(corePluginDir, {
        name: "openrig-mcp",
        version: "0.1.0",
        description: "MCP-bearing plugin",
        mcpServers: {
          "github-mcp": { command: "node", args: ["server.js"], transport: "stdio" },
          "linear-mcp": { command: "linear-mcp", transport: "http" },
        },
      });
      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const result = service.getPlugin("openrig-mcp");
      expect(result).not.toBeNull();
      expect(result?.mcpServers).toHaveLength(2);
      const serverNames = result?.mcpServers.map((s) => s.name).sort();
      expect(serverNames).toEqual(["github-mcp", "linear-mcp"]);
      expect(result?.mcpServers.find((s) => s.name === "github-mcp")?.runtime).toBe("claude");
    });

    it("manifest 没有 mcpServers 字段时返回空 mcpServers", () => {
      const corePluginDir = join(dirs.openrigPluginsDir, "openrig-no-mcp");
      writeClaudePluginManifest(corePluginDir, {
        name: "openrig-no-mcp",
        version: "0.1.0",
        description: "no mcp",
      });
      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      expect(service.getPlugin("openrig-no-mcp")?.mcpServers).toEqual([]);
    });

    it("slice 3.3 fix-iteration——getPlugin 无需外部 cwd state 即可自行解析 Claude 侧 rig-cwd: ID", () => {
      // redo-guard-2 BLOCK item 1：/api/plugins?cwd=... 可列出 rig-cwd plugin，但
      // /api/plugins/:id detail 调用返回 404，因为没有 cwdScanRoots 的 listPlugins() 不会重新
      // 扫描 cwd，getPlugin 无法按 id 找到 entry。修复：从 rig-cwd: id prefix 解析 cwd，重新
      // 扫描该 cwd 并解析 entry。ID 格式：
      //   rig-cwd:<cwd>/.claude/plugins/<plugin>
      //   rig-cwd:<cwd>/.codex/plugins/<plugin>
      const rigCwd = join(dirs.root, "rig-cwd-self-resolve");
      const claudeBundleDir = join(rigCwd, ".claude", "plugins");
      mkdirSync(claudeBundleDir, { recursive: true });
      writeClaudePluginManifest(join(claudeBundleDir, "rig-tool"), {
        name: "rig-tool",
        version: "1.0.0",
        description: "rig-bundled tool",
      });
      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const listed = service.listPlugins({ cwdScanRoots: [rigCwd] });
      const rigToolEntry = listed.find((p) => p.source === "rig-cwd");
      expect(rigToolEntry).toBeDefined();
      const rigToolId = rigToolEntry!.id;
      // 直接用该 id 调用 getPlugin，不提供 cwd option；必须能解析。
      const detail = service.getPlugin(rigToolId);
      expect(detail).not.toBeNull();
      expect(detail?.entry.name).toBe("rig-tool");
      expect(detail?.entry.source).toBe("rig-cwd");
    });

    it("slice 3.3 fix-iteration——getPlugin 同样自行解析 Codex 侧 rig-cwd: ID", () => {
      const rigCwd = join(dirs.root, "rig-cwd-self-resolve-codex");
      const codexBundleDir = join(rigCwd, ".codex", "plugins");
      mkdirSync(codexBundleDir, { recursive: true });
      writeCodexPluginManifest(join(codexBundleDir, "codex-tool"), {
        name: "codex-tool",
        version: "2.0.0",
        description: "rig-bundled codex tool",
      });
      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const listed = service.listPlugins({ cwdScanRoots: [rigCwd] });
      const codexToolEntry = listed.find((p) => p.name === "codex-tool");
      expect(codexToolEntry).toBeDefined();
      const detail = service.getPlugin(codexToolEntry!.id);
      expect(detail).not.toBeNull();
      expect(detail?.entry.name).toBe("codex-tool");
    });

    it("slice 3.3 fix-iteration——getPlugin 对 malformed rig-cwd: id 返回 null", () => {
      // 负向：乱码 prefix 或无法解析的 cwd → null，而不是抛错。
      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      expect(service.getPlugin("rig-cwd:notapath")).toBeNull();
      expect(service.getPlugin("rig-cwd:/nonexistent/.claude/plugins/x")).toBeNull();
    });

    it("为已发现 plugin 返回完整 manifest + tree summary", () => {
      const corePluginDir = join(dirs.openrigPluginsDir, "openrig-core");
      writeClaudePluginManifest(corePluginDir, {
        name: "openrig-core",
        version: "0.1.0",
        description: "Canonical OpenRig content",
        author: { name: "OpenRig" },
        skills: "./skills",
        hooks: "./hooks/claude.json",
      });
      // 添加 skill 文件夹 + hook config，使 tree summary 有内容。
      mkdirSync(join(corePluginDir, "skills", "openrig-user"), { recursive: true });
      writeFileSync(
        join(corePluginDir, "skills", "openrig-user", "SKILL.md"),
        "---\nname: openrig-user\ndescription: User skill\n---\n",
      );
      mkdirSync(join(corePluginDir, "hooks"), { recursive: true });
      writeFileSync(join(corePluginDir, "hooks", "claude.json"), JSON.stringify({
        hooks: { SessionStart: [{ type: "command", command: "echo hi" }] },
      }));

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const result = service.getPlugin("openrig-core");
      expect(result).not.toBeNull();
      expect(result?.entry.name).toBe("openrig-core");
      expect(result?.claudeManifest).toMatchObject({
        name: "openrig-core",
        version: "0.1.0",
        description: "Canonical OpenRig content",
      });
      expect(result?.skills).toContainEqual(
        expect.objectContaining({ name: "openrig-user" }),
      );
      expect(result?.hooks).toContainEqual(
        expect.objectContaining({ runtime: "claude" }),
      );
    });
  });

  describe("findUsedBy", () => {
    it("没有 agent spec 引用 plugin 时返回空列表", () => {
      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      expect(service.findUsedBy("openrig-core")).toEqual([]);
    });

    it("找到 resources.plugins[] 引用该 plugin id 的智能体", () => {
      const advisorDir = join(dirs.specLibraryDir, "advisor");
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
        - superpowers
resources:
  plugins:
    - id: openrig-core
      source:
        kind: local
        path: ~/.openrig/plugins/openrig-core
    - id: superpowers
      source:
        kind: local
        path: ~/.claude/plugins/cache/anthropics/superpowers/5.1.0
  skills: []
startup:
  files: []
  actions: []
`,
      );
      const driverDir = join(dirs.specLibraryDir, "driver");
      mkdirSync(driverDir, { recursive: true });
      writeFileSync(
        join(driverDir, "agent.yaml"),
        `name: velocity-driver
version: "1.0"
defaults:
  runtime: claude-code
profiles:
  default:
    uses:
      plugins:
        - openrig-core
resources:
  plugins:
    - id: openrig-core
      source:
        kind: local
        path: ~/.openrig/plugins/openrig-core
  skills: []
startup:
  files: []
  actions: []
`,
      );

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const usedBy = service.findUsedBy("openrig-core");
      expect(usedBy).toHaveLength(2);
      expect(usedBy.map((u) => u.agentName).sort()).toEqual(["advisor-lead", "velocity-driver"]);
      const superpowersUsedBy = service.findUsedBy("superpowers");
      expect(superpowersUsedBy).toHaveLength(1);
      expect(superpowersUsedBy[0]?.agentName).toBe("advisor-lead");
    });

    it("不匹配只出现在注释或非 resource 字段中的 plugin id", () => {
      const agentDir = join(dirs.specLibraryDir, "false-positive-test");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, "agent.yaml"),
        `name: false-positive-test
version: "1.0"
defaults:
  runtime: claude-code
# Note: this agent does NOT use openrig-core (just a comment mention).
profiles:
  default:
    uses:
      plugins: []
resources:
  plugins: []
  skills:
    - id: my-skill
      # related to openrig-core skill set but not using the plugin
      path: ./skills/my-skill.md
startup:
  files: []
  actions: []
`,
      );

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      // 注释 + skill description 提到 openrig-core，但 resources.plugins 为空。实现解析 YAML 并
      // 遍历 resources.plugins[].id；忽略注释和无关字符串位置。
      expect(service.findUsedBy("openrig-core")).toEqual([]);
    });
  });
});
