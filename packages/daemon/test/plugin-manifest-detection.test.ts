// plugin-primitive Phase 3a slice 3.1 的测试套件——HG-1.3 plugin manifest 检测 +
// plugin_type runtime 适用性过滤。依据 velocity-guard Checkpoint C 延续事项 + IMPL-PRD §1.3 HG-1.3。
//
// 必须正确检测并路由三种形式：
//   - 仅 Claude plugin：source 有 .claude-plugin/，但没有 .codex-plugin/
//   - 仅 Codex plugin： source 有 .codex-plugin/，但没有 .claude-plugin/
//   - 双 manifest：     source 同时有 .claude-plugin/ 和 .codex-plugin/
//                       （Obra Superpowers 形态）
//
// 过滤规则（依据 DESIGN.md §5.1 PluginResource.pluginType）：
//   - pluginType: "claude" → 仅 Claude adapter 投影此 plugin
//   - pluginType: "codex"  → 仅 Codex adapter 投影此 plugin
//   - pluginType: "auto"（或省略）→ 只有 source 中存在对应 runtime 的 manifest 目录时，adapter 才投影

import { describe, it, expect, vi } from "vitest";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../src/domain/projection-planner.js";
import type { NodeBinding } from "../src/domain/types.js";

function mockTmux() {
  return {
    sessionExists: vi.fn().mockResolvedValue(true),
    sendKeys: vi.fn().mockResolvedValue(undefined),
    capturePaneContent: vi.fn().mockResolvedValue(""),
    getPaneCommand: vi.fn().mockResolvedValue(""),
    listSessions: vi.fn().mockResolvedValue([]),
    runCommandInSession: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    setEnvVar: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConstructorParameters<typeof ClaudeCodeAdapter>[0]["tmux"];
}

function mockClaudeFs(files?: Record<string, string>): ClaudeAdapterFsOps & { _store: Record<string, string> } {
  const store: Record<string, string> = { ...files };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    copyFile: () => {},
    listFiles: (dir: string) => Object.keys(store).filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
    homedir: "/home/test",
    _store: store,
  } as ClaudeAdapterFsOps & { _store: Record<string, string> };
}

function mockCodexFs(files?: Record<string, string>): CodexAdapterFsOps & { _store: Record<string, string> } {
  const store: Record<string, string> = { ...files };
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    listFiles: (dir: string) => Object.keys(store).filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
    homedir: "/home/test",
    _store: store,
  } as CodexAdapterFsOps & { _store: Record<string, string> };
}

function makeBinding(cwd = "/cwd"): NodeBinding {
  return {
    id: "b1", nodeId: "n1", tmuxSession: "test", tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd,
  };
}

function makePluginEntry(id: string, absolutePath: string, pluginType?: "claude" | "codex" | "auto"): ProjectionEntry {
  return {
    category: "plugin",
    effectiveId: id,
    sourceSpec: "test-spec",
    sourcePath: "/specs/test-spec",
    resourcePath: absolutePath,
    absolutePath,
    classification: "safe_projection",
    // 通过 ProjectionEntry 携带 pluginType；planner 负责根据 qr.resource.pluginType 字段设置它。
    pluginType,
  } as ProjectionEntry & { pluginType?: "claude" | "codex" | "auto" };
}

function makePlan(entries: ProjectionEntry[]): ProjectionPlan {
  return {
    runtime: "claude-code",
    cwd: "/cwd",
    entries,
    startup: { files: [], actions: [] },
    conflicts: [],
    noOps: [],
    diagnostics: [],
  };
}

// ============================================================
// Plugin tree fixture——三种 manifest 形态
// ============================================================

const CLAUDE_ONLY_TREE = {
  "/p/claude-only/.claude-plugin/plugin.json": '{"name":"claude-only"}',
  "/p/claude-only/skills/c1/SKILL.md": "# c1",
};

const CODEX_ONLY_TREE = {
  "/p/codex-only/.codex-plugin/plugin.json": '{"name":"codex-only","version":"1.0","description":"d"}',
  "/p/codex-only/skills/x1/SKILL.md": "# x1",
};

const DUAL_TREE = {
  "/p/dual/.claude-plugin/plugin.json": '{"name":"dual"}',
  "/p/dual/.codex-plugin/plugin.json": '{"name":"dual","version":"1.0","description":"d"}',
  "/p/dual/skills/d1/SKILL.md": "# d1",
};

// ============================================================
// Claude adapter——runtime 适用性过滤
// ============================================================

describe("Claude adapter——plugin_type runtime 适用性过滤（HG-1.3）", () => {
  it("将仅 Claude 的 plugin（未设置 plugin_type；只有 .claude-plugin/）投影到 .claude/plugins/", async () => {
    const fs = mockClaudeFs(CLAUDE_ONLY_TREE);
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("claude-only", "/p/claude-only", "auto")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.projected).toContain("claude-only");
    expect(fs._store["/cwd/.claude/plugins/claude-only/.claude-plugin/plugin.json"]).toBeDefined();
  });

  it("跳过仅 Codex 的 plugin（无 .claude-plugin/ 目录；自动检测）——不投影到 .claude/plugins/", async () => {
    const fs = mockClaudeFs(CODEX_ONLY_TREE);
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("codex-only", "/p/codex-only", "auto")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    // 由于 plugin 没有 .claude-plugin/ manifest 而跳过——自动检测认为它不适用于 Claude runtime。
    expect(result.skipped).toContain("codex-only");
    expect(fs._store["/cwd/.claude/plugins/codex-only/.codex-plugin/plugin.json"]).toBeUndefined();
    expect(fs._store["/cwd/.claude/plugins/codex-only/skills/x1/SKILL.md"]).toBeUndefined();
  });

  it("将双 manifest plugin（两者都存在；自动检测）投影到 .claude/plugins/", async () => {
    const fs = mockClaudeFs(DUAL_TREE);
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("dual", "/p/dual", "auto")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.projected).toContain("dual");
    expect(fs._store["/cwd/.claude/plugins/dual/.claude-plugin/plugin.json"]).toBeDefined();
    expect(fs._store["/cwd/.claude/plugins/dual/skills/d1/SKILL.md"]).toBeDefined();
  });

  it("显式 plugin_type=claude 时，即使缺少 .claude-plugin/ 也强制投影（operator override）", async () => {
    const fs = mockClaudeFs(CODEX_ONLY_TREE);
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("codex-only", "/p/codex-only", "claude")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.projected).toContain("codex-only");
    expect(fs._store["/cwd/.claude/plugins/codex-only/.codex-plugin/plugin.json"]).toBeDefined();
  });

  it("显式 plugin_type=codex 时，即使存在 .claude-plugin/ 也跳过 Claude 投影", async () => {
    const fs = mockClaudeFs(CLAUDE_ONLY_TREE);
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("claude-only", "/p/claude-only", "codex")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.skipped).toContain("claude-only");
    expect(fs._store["/cwd/.claude/plugins/claude-only/.claude-plugin/plugin.json"]).toBeUndefined();
  });
});

// ============================================================
// Codex adapter——runtime 适用性过滤
// ============================================================

describe("Codex adapter——plugin_type runtime 适用性过滤（HG-1.3）", () => {
  it("将仅 Codex 的 plugin（未设置 plugin_type；只有 .codex-plugin/）投影到 .codex/plugins/", async () => {
    const fs = mockCodexFs(CODEX_ONLY_TREE);
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("codex-only", "/p/codex-only", "auto")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.projected).toContain("codex-only");
    expect(fs._store["/cwd/.codex/plugins/codex-only/.codex-plugin/plugin.json"]).toBeDefined();
  });

  it("跳过仅 Claude 的 plugin（无 .codex-plugin/ 目录；自动检测）——不投影到 .codex/plugins/", async () => {
    const fs = mockCodexFs(CLAUDE_ONLY_TREE);
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("claude-only", "/p/claude-only", "auto")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.skipped).toContain("claude-only");
    expect(fs._store["/cwd/.codex/plugins/claude-only/.claude-plugin/plugin.json"]).toBeUndefined();
  });

  it("将双 manifest plugin 投影到 .codex/plugins/", async () => {
    const fs = mockCodexFs(DUAL_TREE);
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("dual", "/p/dual", "auto")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.projected).toContain("dual");
    expect(fs._store["/cwd/.codex/plugins/dual/.codex-plugin/plugin.json"]).toBeDefined();
  });

  it("显式 plugin_type=claude 时，即使存在 .codex-plugin/ 也跳过 Codex 投影", async () => {
    const fs = mockCodexFs(CODEX_ONLY_TREE);
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("codex-only", "/p/codex-only", "claude")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.skipped).toContain("codex-only");
    expect(fs._store["/cwd/.codex/plugins/codex-only/.codex-plugin/plugin.json"]).toBeUndefined();
  });
});

// ============================================================
// 漂移判别测试——三个 plugin，每个 adapter 有三种不同过滤结果
// ============================================================

describe("Plugin manifest 检测——跨 runtime 漂移判别测试", () => {
  it("三个 plugin（claude-only、codex-only、dual）按 adapter 分别投影（漂移判别）", async () => {
    const allTrees = { ...CLAUDE_ONLY_TREE, ...CODEX_ONLY_TREE, ...DUAL_TREE };
    const claudeFs = mockClaudeFs(allTrees);
    const codexFs = mockCodexFs(allTrees);
    const claudeAdapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: claudeFs });
    const codexAdapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: codexFs });
    const plan = makePlan([
      makePluginEntry("claude-only", "/p/claude-only", "auto"),
      makePluginEntry("codex-only", "/p/codex-only", "auto"),
      makePluginEntry("dual", "/p/dual", "auto"),
    ]);

    const claudeResult = await claudeAdapter.project(plan, makeBinding("/cwd"));
    const codexResult = await codexAdapter.project(plan, makeBinding("/cwd"));

    // Claude：投影 claude-only + dual；跳过 codex-only
    expect(claudeResult.projected.sort()).toEqual(["claude-only", "dual"]);
    expect(claudeResult.skipped).toContain("codex-only");

    // Codex：投影 codex-only + dual；跳过 claude-only
    expect(codexResult.projected.sort()).toEqual(["codex-only", "dual"]);
    expect(codexResult.skipped).toContain("claude-only");

    // 交叉检查：任何 plugin 都不得落到错误的 runtime 目标
    expect(claudeFs._store["/cwd/.claude/plugins/codex-only/.codex-plugin/plugin.json"]).toBeUndefined();
    expect(codexFs._store["/cwd/.codex/plugins/claude-only/.claude-plugin/plugin.json"]).toBeUndefined();
  });
});
