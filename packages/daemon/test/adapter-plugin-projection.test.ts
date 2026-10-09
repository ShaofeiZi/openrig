// plugin-primitive Phase 3a slice 3.1 测试套件——adapter plugin directory projection。
// 按 velocity-guard cadence boundary（c）2026-05-10：证明 runtime adapter 会将真实 plugin
// tree（嵌套 .claude-plugin/ + skills/ + hooks/ subdir）复制到 runtime plugin 位置，
// 而不只是计算 targetDir。
//
// Claude target: <cwd>/.claude/plugins/<id>/
// Codex target:  <cwd>/.codex/plugins/<id>/
//
// Plugin tree shape（按 DESIGN.md §5.5 + IMPL-PRD §2.2）：
//   <plugin-root>/
//     .claude-plugin/plugin.json     （Claude manifest）
//     .codex-plugin/plugin.json      （Codex manifest；Claude-only plugin 中缺失）
//     skills/<id>/SKILL.md           （一个或多个 skill subdir）
//     hooks/{claude,codex}.json      （hook event config）
//     hooks/scripts/<file>.cjs       （hook command script）

import { describe, it, expect, vi } from "vitest";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../src/domain/projection-planner.js";
import type { NodeBinding } from "../src/domain/types.js";

// ----- 与现有 adapter 测试共享的 mock helper -----

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
    _store: store,
  } as CodexAdapterFsOps & { _store: Record<string, string> };
}

function makeBinding(cwd = "/cwd"): NodeBinding {
  return {
    id: "b1", nodeId: "n1", tmuxSession: "test", tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd,
  };
}

function makePluginEntry(id: string, absolutePath: string): ProjectionEntry {
  return {
    category: "plugin",
    effectiveId: id,
    sourceSpec: "test-spec",
    sourcePath: "/specs/test-spec",
    resourcePath: absolutePath,
    absolutePath,
    classification: "safe_projection",
  };
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
// Plugin tree fixture
// ============================================================

const OPENRIG_CORE_TREE = {
  "/p/openrig-core/.claude-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0"}',
  "/p/openrig-core/.codex-plugin/plugin.json": '{"name":"openrig-core","version":"0.1.0","description":"openrig"}',
  "/p/openrig-core/skills/openrig-user/SKILL.md": "# openrig-user\nUse for ...",
  "/p/openrig-core/skills/openrig-architect/SKILL.md": "# openrig-architect",
  "/p/openrig-core/hooks/claude.json": '{"hooks":{"SessionStart":[]}}',
  "/p/openrig-core/hooks/codex.json": '{"hooks":{"SessionStart":[]}}',
  "/p/openrig-core/hooks/scripts/activity-relay.cjs": "// relay script body",
  "/p/openrig-core/README.md": "# openrig-core plugin",
};

// ============================================================
// Claude Code adapter——plugin tree projection
// ============================================================

describe("Claude Code adapter——plugin directory projection", () => {
  it("将整个 plugin tree 复制到 <cwd>/.claude/plugins/<id>/，保留嵌套结构", async () => {
    const fs = mockClaudeFs(OPENRIG_CORE_TREE);
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("openrig-core", "/p/openrig-core")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.projected).toContain("openrig-core");
    expect(result.failed).toEqual([]);

    // 所有 8 个 source file 都应落到正确的嵌套 target path
    expect(fs._store["/cwd/.claude/plugins/openrig-core/.claude-plugin/plugin.json"]).toBe('{"name":"openrig-core","version":"0.1.0"}');
    expect(fs._store["/cwd/.claude/plugins/openrig-core/.codex-plugin/plugin.json"]).toBe('{"name":"openrig-core","version":"0.1.0","description":"openrig"}');
    expect(fs._store["/cwd/.claude/plugins/openrig-core/skills/openrig-user/SKILL.md"]).toBe("# openrig-user\nUse for ...");
    expect(fs._store["/cwd/.claude/plugins/openrig-core/skills/openrig-architect/SKILL.md"]).toBe("# openrig-architect");
    expect(fs._store["/cwd/.claude/plugins/openrig-core/hooks/claude.json"]).toBe('{"hooks":{"SessionStart":[]}}');
    expect(fs._store["/cwd/.claude/plugins/openrig-core/hooks/codex.json"]).toBe('{"hooks":{"SessionStart":[]}}');
    expect(fs._store["/cwd/.claude/plugins/openrig-core/hooks/scripts/activity-relay.cjs"]).toBe("// relay script body");
    expect(fs._store["/cwd/.claude/plugins/openrig-core/README.md"]).toBe("# openrig-core plugin");
  });

  it("plugin projection 落到 .claude/plugins/，而非 .claude/skills/ 或其他 category dir（drift discriminator）", async () => {
    const fs = mockClaudeFs({ "/p/test-plugin/.claude-plugin/plugin.json": "{}", "/p/test-plugin/skills/x/SKILL.md": "# x" });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("test-plugin", "/p/test-plugin")]);

    await adapter.project(plan, makeBinding("/cwd"));

    // 落到 plugin dir
    expect(fs._store["/cwd/.claude/plugins/test-plugin/.claude-plugin/plugin.json"]).toBe("{}");
    // 不会落到 skill dir（plugin 内的 skill SKILL.md 属于 plugin tree，不提升到 .claude/skills）
    expect(fs._store["/cwd/.claude/skills/test-plugin/SKILL.md"]).toBeUndefined();
    expect(fs._store["/cwd/.claude/skills/x/SKILL.md"]).toBeUndefined();
    // plugin 的嵌套 skill 保留在 plugin tree 内
    expect(fs._store["/cwd/.claude/plugins/test-plugin/skills/x/SKILL.md"]).toBe("# x");
  });

  it("多个 plugin 投影到各自的 <id> subdir", async () => {
    const fs = mockClaudeFs({
      "/p/plugin-a/.claude-plugin/plugin.json": '{"name":"plugin-a"}',
      "/p/plugin-a/skills/a-skill/SKILL.md": "# a",
      "/p/plugin-b/.claude-plugin/plugin.json": '{"name":"plugin-b"}',
      "/p/plugin-b/skills/b-skill/SKILL.md": "# b",
    });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([
      makePluginEntry("plugin-a", "/p/plugin-a"),
      makePluginEntry("plugin-b", "/p/plugin-b"),
    ]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.projected).toContain("plugin-a");
    expect(result.projected).toContain("plugin-b");
    expect(fs._store["/cwd/.claude/plugins/plugin-a/skills/a-skill/SKILL.md"]).toBe("# a");
    expect(fs._store["/cwd/.claude/plugins/plugin-b/skills/b-skill/SKILL.md"]).toBe("# b");
    // plugin 保持隔离；b 的 skill 不在 a 的 plugin tree 下
    expect(fs._store["/cwd/.claude/plugins/plugin-a/skills/b-skill/SKILL.md"]).toBeUndefined();
  });

  it("hash 匹配时 plugin re-projection 为 no-op（幂等）", async () => {
    const fs = mockClaudeFs({
      "/p/openrig-core/.claude-plugin/plugin.json": "{}",
      "/cwd/.claude/plugins/openrig-core/.claude-plugin/plugin.json": "{}", // already projected with same content
    });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("openrig-core", "/p/openrig-core")]);

    let writeCount = 0;
    const origWrite = fs.writeFile;
    fs.writeFile = (p, c) => { writeCount++; origWrite(p, c); };

    await adapter.project(plan, makeBinding("/cwd"));

    // hash 匹配时应跳过写入——不无故覆盖未变化的 plugin file
    expect(writeCount).toBe(0);
  });
});

// ============================================================
// Codex adapter——plugin tree projection
// ============================================================

describe("Codex adapter——plugin directory projection", () => {
  it("将整个 plugin tree 复制到 <cwd>/.codex/plugins/<id>/，保留嵌套结构", async () => {
    const fs = mockCodexFs(OPENRIG_CORE_TREE);
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("openrig-core", "/p/openrig-core")]);

    const result = await adapter.project(plan, makeBinding("/cwd"));

    expect(result.projected).toContain("openrig-core");
    expect(result.failed).toEqual([]);

    // 所有 8 个 source file 都应落到正确的嵌套 Codex target path
    expect(fs._store["/cwd/.codex/plugins/openrig-core/.claude-plugin/plugin.json"]).toBe('{"name":"openrig-core","version":"0.1.0"}');
    expect(fs._store["/cwd/.codex/plugins/openrig-core/.codex-plugin/plugin.json"]).toBe('{"name":"openrig-core","version":"0.1.0","description":"openrig"}');
    expect(fs._store["/cwd/.codex/plugins/openrig-core/skills/openrig-user/SKILL.md"]).toBe("# openrig-user\nUse for ...");
    expect(fs._store["/cwd/.codex/plugins/openrig-core/hooks/codex.json"]).toBe('{"hooks":{"SessionStart":[]}}');
    expect(fs._store["/cwd/.codex/plugins/openrig-core/hooks/scripts/activity-relay.cjs"]).toBe("// relay script body");
  });

  it("Codex plugin 落到 .codex/plugins/，而非 .agents/skills/（相对 skill projection 的 drift discriminator）", async () => {
    const fs = mockCodexFs({
      "/p/test-plugin/.codex-plugin/plugin.json": "{}",
      "/p/test-plugin/skills/x/SKILL.md": "# x",
    });
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan = makePlan([makePluginEntry("test-plugin", "/p/test-plugin")]);

    await adapter.project(plan, makeBinding("/cwd"));

    expect(fs._store["/cwd/.codex/plugins/test-plugin/.codex-plugin/plugin.json"]).toBe("{}");
    expect(fs._store["/cwd/.codex/plugins/test-plugin/skills/x/SKILL.md"]).toBe("# x");
    // 嵌套 skill 不提升到 runtime skill dir
    expect(fs._store["/cwd/.agents/skills/test-plugin/SKILL.md"]).toBeUndefined();
    expect(fs._store["/cwd/.agents/skills/x/SKILL.md"]).toBeUndefined();
  });
});

// ============================================================
// Cross-runtime layer-discrimination——同一 plugin，不同 target
// ============================================================

describe("Plugin projection——cross-runtime target 区分", () => {
  it("同一 plugin source 在 Claude 上投影到 .claude/plugins，在 Codex 上投影到 .codex/plugins（不同 target）", async () => {
    const claudeFs = mockClaudeFs(OPENRIG_CORE_TREE);
    const codexFs = mockCodexFs(OPENRIG_CORE_TREE);
    const claudeAdapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: claudeFs });
    const codexAdapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: codexFs });
    const plan = makePlan([makePluginEntry("openrig-core", "/p/openrig-core")]);

    await claudeAdapter.project(plan, makeBinding("/cwd"));
    await codexAdapter.project(plan, makeBinding("/cwd"));

    // Claude target 与 Codex target 不同
    expect(claudeFs._store["/cwd/.claude/plugins/openrig-core/.claude-plugin/plugin.json"]).toBeDefined();
    expect(claudeFs._store["/cwd/.codex/plugins/openrig-core/.codex-plugin/plugin.json"]).toBeUndefined();

    expect(codexFs._store["/cwd/.codex/plugins/openrig-core/.codex-plugin/plugin.json"]).toBeDefined();
    expect(codexFs._store["/cwd/.claude/plugins/openrig-core/.claude-plugin/plugin.json"]).toBeUndefined();
  });
});
