// plugin-primitive Phase 3a slice 3.1 测试套件——activity-hook injection 移除证明。遵循
// velocity-guard cadence boundary（d）Checkpoint D.2 2026-05-10。阴性断言：移除后，
// deliverStartup 绝不能向 provider config location 写入 zrig activity-hook 内容。
//
// 已移除：
//   - project cwd 中的 .openrig/activity-hook-relay.cjs 文件
//   - .claude/settings.local.json hooks block 中由 zrig 注入的 entry
//     （所有既有 user-authored hook 保持不变）
//   - 含 zrig SessionStart/UserPromptSubmit/Stop 的 .codex/hooks.json
//     （该文件可能根本不存在；即使存在，zrig 也不会写入）
//   - 不再接受 activityHookRelayAssetPath constructor option
//
// 保留：
//   - /api/activity/hooks endpoint（3.2 后由 plugin-shipped hook 使用）
//   - settings.local.json 中 user-authored 的既有 hook——保持不变
//   - upsertCodexHooksFeature TOML helper——slice 3.5 ensureCodexFeatureFlag 会使用它

import { describe, it, expect, vi } from "vitest";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
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

function makeBinding(cwd = "/project"): NodeBinding {
  return {
    id: "b1", nodeId: "n1", tmuxSession: "test", tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd,
  };
}

describe("Activity-hook injection 移除证明——Claude Code adapter", () => {
  it("HG-1.5——deliverStartup 不在 project cwd 创建 .openrig/activity-hook-relay.cjs", async () => {
    const fs = mockClaudeFs();
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });

    await adapter.deliverStartup([], makeBinding("/project"));

    expect(fs._store["/project/.openrig/activity-hook-relay.cjs"]).toBeUndefined();
  });

  it("HG-1.5——deliverStartup 不向 settings.local.json 添加 zrig 注入的 hook entry", async () => {
    const fs = mockClaudeFs();
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });

    await adapter.deliverStartup([], makeBinding("/project"));

    const settings = fs._store["/project/.claude/settings.local.json"];
    if (settings !== undefined) {
      const parsed = JSON.parse(settings);
      // 若 settings.local.json 被创建或触碰，其 hooks block 不得引用 activity-hook-relay.cjs
      //（由 zrig 注入的 command）。
      const hookJson = JSON.stringify(parsed.hooks ?? {});
      expect(hookJson).not.toContain("activity-hook-relay");
    }
  });

  it("HG-1.5——settings.local.json 中既有 user-authored hook 原样保留", async () => {
    const userHooks = JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "node ./my-stop-hook.cjs", timeout: 10 }] }],
      },
    });
    const fs = mockClaudeFs({ "/project/.claude/settings.local.json": userHooks });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });

    await adapter.deliverStartup([], makeBinding("/project"));

    // 用户既有 Stop hook 仍存在（移除后 zrig 完全不修改 hooks block）。
    const after = JSON.parse(fs._store["/project/.claude/settings.local.json"]!);
    const hookJson = JSON.stringify(after.hooks);
    expect(hookJson).toContain("node ./my-stop-hook.cjs");
    // 不添加 zrig 注入的 entry
    expect(hookJson).not.toContain("activity-hook-relay");
  });

  it("HG-1.6——Claude adapter source 不再引用 provisionActivityHooks / upsertCommandHook / activityHookRelayAssetPath / openrig-activity-hook-relay", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "../src/adapters/claude-code-adapter.ts"), "utf-8");
    expect(src).not.toMatch(/provisionActivityHooks/);
    expect(src).not.toMatch(/upsertCommandHook/);
    expect(src).not.toMatch(/hookEntryContainsCommand/);
    expect(src).not.toMatch(/activityHookRelayAssetPath/);
    expect(src).not.toMatch(/openrig-activity-hook-relay/);
  });
});

describe("Activity-hook injection 移除证明——Codex adapter", () => {
  it("HG-1.5——deliverStartup 不在 project cwd 创建 .openrig/activity-hook-relay.cjs", async () => {
    const fs = mockCodexFs();
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });

    await adapter.deliverStartup([], makeBinding("/project"));

    expect(fs._store["/project/.openrig/activity-hook-relay.cjs"]).toBeUndefined();
  });

  it("HG-1.5——deliverStartup 不向 project cwd 的 .codex/hooks.json 写入 zrig 注入 event", async () => {
    const fs = mockCodexFs();
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });

    await adapter.deliverStartup([], makeBinding("/project"));

    // 移除后，deliverStartup 不应在 project cwd 创建 .codex/hooks.json。移除前，该文件会获得
    // 指向 relay script 的 SessionStart + UserPromptSubmit + Stop entry。
    expect(fs._store["/project/.codex/hooks.json"]).toBeUndefined();
  });

  it("HG-1.6——Codex adapter source 不再引用 provisionActivityHooks / upsertCommandHook / activityHookRelayAssetPath / openrig-activity-hook-relay", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(import.meta.dirname, "../src/adapters/codex-runtime-adapter.ts"), "utf-8");
    expect(src).not.toMatch(/provisionActivityHooks/);
    expect(src).not.toMatch(/upsertCommandHook/);
    expect(src).not.toMatch(/hookEntryContainsCommand/);
    expect(src).not.toMatch(/activityHookRelayAssetPath/);
    expect(src).not.toMatch(/openrig-activity-hook-relay/);
    // 保留 upsertCodexHooksFeature——slice 3.5 ensureCodexFeatureFlag 会使用它
    expect(src).toMatch(/upsertCodexHooksFeature/);
  });
});

describe("Activity-hook injection 移除证明——endpoint 纪律", () => {
  it("/api/activity/hooks endpoint 保留在 source 中（3.2 后由 plugin-shipped hook 使用）", async () => {
    // Documentation-of-intent regression lock：根据 IMPL-PRD §1 + DESIGN.md §3，移除过程中有意
    // 保留 endpoint。Plugin-shipped hook（slice 3.2）会 POST 到此 endpoint 进行 activity tracking。
    const fs = await import("node:fs");
    const path = await import("node:path");
    const activityRoutesFile = path.resolve(import.meta.dirname, "../src/routes/activity.ts");
    const content = fs.readFileSync(activityRoutesFile, "utf-8");
    // endpoint 注册 POST /hooks（在 app 中挂载于 /api/activity/）
    expect(content).toMatch(/activityRoutes\.post\(\s*["']\/hooks["']/);
  });
});
