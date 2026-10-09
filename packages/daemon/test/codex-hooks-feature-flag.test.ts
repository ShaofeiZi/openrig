// plugin-primitive Phase 3a slice 3.5 测试套件——Codex feature flag
//（codex_hooks = true）。遵循 IMPL-PRD §5 + velocity-guard cadence boundary（d）2026-05-10。
//
// 替代 Phase 3a slice 3.1 中移除的、与 activity-hook injection 耦合的
// upsertCodexHooksFeature()。新形态：
//
// 1. zrig setting `runtime.codex.hooks_enabled`（默认 true）
// 2. CodexRuntimeAdapter 暴露 ensureCodexFeatureFlag(setting)，setting=true 时向
//    ~/.codex/config.toml 写入 codex_hooks = true
// 3. 幂等：运行两次不会重复
// 4. 用户 override（setting=false）→ daemon 不修改 Codex config

import { describe, it, expect, vi } from "vitest";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import { SETTINGS_VALID_KEYS } from "../src/domain/user-settings/settings-store.js";

function mockTmux() {
  return {
    sessionExists: vi.fn().mockResolvedValue(true),
    sendKeys: vi.fn().mockResolvedValue(undefined),
    capturePaneContent: vi.fn().mockResolvedValue(""),
    getPaneCommand: vi.fn().mockResolvedValue(""),
    listSessions: vi.fn().mockResolvedValue([]),
    runCommandInSession: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
    setEnvVar: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConstructorParameters<typeof CodexRuntimeAdapter>[0]["tmux"];
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

describe("Slice 3.5——Codex feature flag（runtime.codex.hooks_enabled）", () => {
  // ============================================================
  // HG-5.1：setting 存在于 canonical valid-keys list 中
  // ============================================================

  it("HG-5.1——SETTINGS_VALID_KEYS 包含 runtime.codex.hooks_enabled", () => {
    expect(SETTINGS_VALID_KEYS as readonly string[]).toContain("runtime.codex.hooks_enabled");
  });

  // ============================================================
  // HG-5.2：ensureCodexFeatureFlag 写入 codex_hooks = true
  // ============================================================

  it("HG-5.2——文件缺失时，ensureCodexFeatureFlag(true) 向 ~/.codex/config.toml 写入 codex_hooks = true", () => {
    const fs = mockCodexFs(/* 无现有文件 */);
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });

    adapter.ensureCodexFeatureFlag(true, { codexVersion: "0.120.0" });

    const written = fs._store["/home/test/.codex/config.toml"];
    expect(written).toBeDefined();
    expect(written).toContain("[features]");
    expect(written).toContain("codex_hooks = true");
  });

  it("GAP-7 将 feature flag 写入所注入的 Codex home", () => {
    const fs = mockCodexFs();
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs, codexHome: "/custom-codex" });

    adapter.ensureCodexFeatureFlag(true, { codexVersion: "0.120.0" });

    expect(fs._store["/custom-codex/config.toml"]).toContain("codex_hooks = true");
    expect(fs._store["/home/test/.codex/config.toml"]).toBeUndefined();
  });

  it("HG-5.2——ensureCodexFeatureFlag(true) 设置 codex_hooks = true，同时保留现有 config content", () => {
    const existing = `[model_provider]\nname = "openai"\n\n[other_section]\nfoo = "bar"\n`;
    const fs = mockCodexFs({ "/home/test/.codex/config.toml": existing });
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });

    adapter.ensureCodexFeatureFlag(true, { codexVersion: "0.120.0" });

    const written = fs._store["/home/test/.codex/config.toml"]!;
    expect(written).toContain('name = "openai"');
    expect(written).toContain('foo = "bar"');
    expect(written).toContain("[features]");
    expect(written).toContain("codex_hooks = true");
  });

  // ============================================================
  // HG-5.3：幂等
  // ============================================================

  it("HG-5.3——ensureCodexFeatureFlag(true) 幂等（运行两次不会重复 codex_hooks）", () => {
    const fs = mockCodexFs();
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });

    adapter.ensureCodexFeatureFlag(true, { codexVersion: "0.120.0" });
    adapter.ensureCodexFeatureFlag(true, { codexVersion: "0.120.0" });

    const written = fs._store["/home/test/.codex/config.toml"]!;
    const matches = written.match(/codex_hooks = true/g) ?? [];
    expect(matches).toHaveLength(1);
    const featuresMatches = written.match(/\[features\]/g) ?? [];
    expect(featuresMatches).toHaveLength(1);
  });

  it("HG-5.3——添加 codex_hooks 时保留包含其他 flag 的既有 [features] block", () => {
    const existing = `[features]\nother_flag = false\n`;
    const fs = mockCodexFs({ "/home/test/.codex/config.toml": existing });
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });

    adapter.ensureCodexFeatureFlag(true, { codexVersion: "0.120.0" });

    const written = fs._store["/home/test/.codex/config.toml"]!;
    expect(written).toContain("other_flag = false");
    expect(written).toContain("codex_hooks = true");
  });

  // ============================================================
  // HG-5.4：用户 override（false）→ daemon 不修改
  // ============================================================

  it("HG-5.4——文件缺失时 ensureCodexFeatureFlag(false) 不触碰 ~/.codex/config.toml", () => {
    const fs = mockCodexFs();
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });

    adapter.ensureCodexFeatureFlag(false);

    expect(fs._store["/home/test/.codex/config.toml"]).toBeUndefined();
  });

  it("HG-5.4——ensureCodexFeatureFlag(false) 不触碰现有 ~/.codex/config.toml 内容（由用户所有）", () => {
    const existing = `[features]\ncodex_hooks = false\nother = true\n`;
    const fs = mockCodexFs({ "/home/test/.codex/config.toml": existing });
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });

    adapter.ensureCodexFeatureFlag(false);

    expect(fs._store["/home/test/.codex/config.toml"]).toBe(existing);
  });

  // OPR.0.4.0.11 version-aware 测试
  it("0.4.0.11——未知 version（undefined）不写 config", () => {
    const fs = mockCodexFs();
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });

    adapter.ensureCodexFeatureFlag(true, { codexVersion: undefined });

    expect(fs._store["/home/test/.codex/config.toml"]).toBeUndefined();
  });

  it("0.4.0.11——0.139.0 不写 config（hooks 默认启用）", () => {
    const fs = mockCodexFs();
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });

    adapter.ensureCodexFeatureFlag(true, { codexVersion: "0.139.0" });

    expect(fs._store["/home/test/.codex/config.toml"]).toBeUndefined();
  });

  it("0.4.0.11——0.120.0 会写 config（legacy toggle）", () => {
    const fs = mockCodexFs();
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });

    adapter.ensureCodexFeatureFlag(true, { codexVersion: "0.120.0" });

    const written = fs._store["/home/test/.codex/config.toml"];
    expect(written).toBeDefined();
    expect(written).toContain("codex_hooks = true");
  });
});
