import { mockShellCommand } from "./helpers/shell-command-mock.js";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import Database from "better-sqlite3";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { CodexRuntimeAdapter, type CodexAdapterFsOps } from "../src/adapters/codex-runtime-adapter.js";
import type { NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../src/domain/projection-planner.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { seedCodexThreads } from "./helpers/codex-state.js";
import { execFileSync } from "node:child_process";

const CODEX_FLOOR_EFFECT = {
  runtime: "codex",
  axis: "sandbox",
  state: "observed",
  value: "workspace-write",
  reason: "emitted_launch_arguments",
} as const;

function mockTmux(overrides?: Partial<TmuxAdapter>): TmuxAdapter {
  const tmux = {
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "codex"),
    capturePaneContent: vi.fn(async () => "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything"),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPanePid: vi.fn(async () => null),
    ...overrides,
  } as unknown as TmuxAdapter;
  return mockShellCommand(tmux);
}

function mockFs(files?: Record<string, string>): CodexAdapterFsOps {
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

function makeBinding(cwd = "/project"): NodeBinding {
  return {
    id: "b1", nodeId: "n1", tmuxSession: "r01-qa", tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd,
  };
}

function makeEntry(overrides?: Partial<ProjectionEntry>): ProjectionEntry {
  return {
    category: "skill", effectiveId: "test-skill", sourceSpec: "base", sourcePath: "/agents/base",
    resourcePath: "skills/test", absolutePath: "/agents/base/skills/test/SKILL.md",
    classification: "safe_projection", ...overrides,
  };
}

function testQueueRoot(sharedDocsRoot = nodePath.join(os.homedir(), ".openrig", "shared-docs")): string {
  return nodePath.join(sharedDocsRoot, "rigs", "test-rig", "state", "dev");
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function expectedFreshLaunchCommand(options: { cwd?: string; model?: string; queueRoot?: string | null } = {}): string {
  const cwd = options.cwd ?? "/project";
  const gitDirArg = ` --add-dir ${quote(nodePath.join(cwd, ".git"))}`;
  const queueDirArg = options.queueRoot === null ? "" : ` --add-dir ${quote(options.queueRoot ?? testQueueRoot())}`;
  const modelArg = options.model ? ` -m ${quote(options.model)}` : "";
  return `codex -s workspace-write -C ${quote(cwd)}${gitDirArg}${queueDirArg}${modelArg}`;
}

function expectedResumeCommand(token = "sess-456", queueRoot: string | null = testQueueRoot(), model?: string): string {
  const queueDirArg = queueRoot === null ? "" : `--add-dir ${quote(queueRoot)} `;
  const modelArg = model ? ` -m ${quote(model)}` : "";
  return `codex -s workspace-write${modelArg} resume ${queueDirArg}${quote(token)}`;
}

function expectedForkCommand(parentId = "parent-thread-id", options: { model?: string; queueRoot?: string | null } = {}): string {
  const queueDirArg = options.queueRoot === null ? "" : ` --add-dir ${quote(options.queueRoot ?? testQueueRoot())}`;
  const modelArg = options.model ? ` -m ${quote(options.model)}` : "";
  return `codex -s workspace-write${modelArg} fork${queueDirArg} ${quote(parentId)}`;
}

function expectedProfileFreshLaunchCommand(profile: string, options: { cwd?: string; model?: string; queueRoot?: string | null } = {}): string {
  const cwd = options.cwd ?? "/project";
  const gitDirArg = ` --add-dir ${quote(nodePath.join(cwd, ".git"))}`;
  const queueDirArg = options.queueRoot === null ? "" : ` --add-dir ${quote(options.queueRoot ?? testQueueRoot())}`;
  const modelArg = options.model ? ` -m ${quote(options.model)}` : "";
  return `codex -p ${quote(profile)} -C ${quote(cwd)}${gitDirArg}${queueDirArg}${modelArg}`;
}

function expectedProfileResumeCommand(profile: string, token = "sess-456", queueRoot: string | null = testQueueRoot()): string {
  const queueDirArg = queueRoot === null ? "" : `--add-dir ${quote(queueRoot)} `;
  return `codex -p ${quote(profile)} resume ${queueDirArg}${quote(token)}`;
}

beforeEach(() => {
  // 环境耦合加固（housekeeping，qitem-20260711131501-e43707b0）。两项 launchHarness
  // profile/model 测试的漂移判定是环境敏感，并非断言过期或产品回归。launchHarness 会正确
  // 遵循 OPENRIG_SHARED_DOCS_ROOT，作为 Codex 队列状态的可写根目录；专门的测试通过显式
  // stub 证明该行为。但 profile/model 启动命令测试假设使用 testQueueRoot() 编码的未设置
  // 回退路径 os.homedir()/.openrig/shared-docs。部分运行环境（基础设施主机、预配 VM）会
  // 导出该变量，使两个测试在字节完全相同时仍不稳定。这里清除环境值以保证默认行为确定，
  // unstubAllEnvs() 会在之后恢复。
  vi.stubEnv("OPENRIG_SHARED_DOCS_ROOT", undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function createCodexLogsDb(homeDir: string, pid: number, threadId: string, dbName = "logs_1.sqlite"): void {
  const codexDir = nodePath.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  seedCodexThreads(homeDir, [threadId]);
  const db = new Database(nodePath.join(codexDir, dbName));
  try {
    db.exec(`
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        ts_nanos INTEGER NOT NULL,
        process_uuid TEXT NOT NULL,
        thread_id TEXT
      );
    `);
    db.prepare(
      "INSERT INTO logs (ts, ts_nanos, process_uuid, thread_id) VALUES (?, ?, ?, ?)"
    ).run(
      1,
      1,
      `pid:${pid}:test-process`,
      threadId
    );
  } finally {
    db.close();
  }
}

describe("Codex 运行时适配器", () => {
  it("即使登录 shell 的 PATH 不同，也启动探测到的可执行文件", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "codex-launch-path-"));
    try {
      const selected = nodePath.join(root, "selected tools");
      const stale = nodePath.join(root, "stale");
      fs.mkdirSync(selected); fs.mkdirSync(stale);
      fs.writeFileSync(nodePath.join(selected, "codex"), "#!/bin/sh\nprintf selected", { mode: 0o755 });
      fs.writeFileSync(nodePath.join(stale, "codex"), "#!/bin/sh\nprintf stale", { mode: 0o755 });
      const tmux = mockTmux();
      const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), launchPath: selected + ":/usr/bin:/bin", sleep: async () => {} });
      await adapter.launchHarness(makeBinding(), { name: "operator@example-rig" });
      const command = vi.mocked(tmux.sendText).mock.calls[0]![1];
      const output = execFileSync("/bin/sh", ["-c", command], { env: { ...process.env, PATH: stale + ":/usr/bin:/bin" }, encoding: "utf8" });
      expect(output).toBe("selected");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  // T2：实现全部四个方法。
  it("实现全部四个方法", () => {
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: mockFs() });
    expect(typeof adapter.listInstalled).toBe("function");
    expect(typeof adapter.project).toBe("function");
    expect(typeof adapter.deliverStartup).toBe("function");
    expect(typeof adapter.checkReady).toBe("function");
    expect(adapter.runtime).toBe("codex");
  });

  // T7：会话响应正常时 checkReady 返回 true。
  it("会话响应正常时 checkReady 返回 true", async () => {
    const tmux = mockTmux({ hasSession: vi.fn(async () => true) });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs() });
    const result = await adapter.checkReady(makeBinding());
    expect(result.ready).toBe(true);
  });

  it("窗格回退到 shell 提示符时 checkReady 返回 false", async () => {
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "zsh"),
      capturePaneContent: vi.fn(async () => "user@example.test rigged %"),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs() });

    const result = await adapter.checkReady(makeBinding());

    expect(result).toEqual({
      ready: false,
      reason: "探测窗格已返回 shell，没有停留在运行时内部。",
      code: "returned_to_shell",
    });
  });

  it("Codex 阻塞在工作区信任提示时 checkReady 返回 false", async () => {
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "codex"),
      capturePaneContent: vi.fn(async () => [
        "> You are in /some/workspace",
        "",
        "  Do you trust the contents of this directory? Working with untrusted contents",
        "  comes with higher risk of prompt injection.",
        "",
        "› 1. Yes, continue",
        "  2. No, quit",
        "",
        "  Press enter to continue",
      ].join("\n")),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs() });

    const result = await adapter.checkReady(makeBinding());

    expect(result).toEqual({
      ready: false,
      reason: "Codex 正等待工作区信任批准，批准后会话才能交互。",
      code: "trust_gate",
    });
  });

  it("Codex 阻塞在编号模型选择提示时 checkReady 返回 false", async () => {
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "codex-aarch64-a"),
      capturePaneContent: vi.fn(async () => [
        "╭───────────────────────────────────────╮",
        "│ >_ OpenAI Codex (v0.124.0)            │",
        "╰───────────────────────────────────────╯",
        "",
        "› 1. Switch to gpt-5.1-codex-mini Optimized for codex. Cheaper,",
        "  2. Switch to gpt-5.4-codex Stronger for complex tasks.",
        "  3. Keep current model",
        "",
        "  gpt-5.4 default · ~/code/openrig",
      ].join("\n")),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs() });

    const result = await adapter.checkReady(makeBinding());

    expect(result).toEqual({
      ready: false,
      reason: "Codex 正等待选择模型，选择后会话才能交互。",
      code: "model_selection_gate",
    });
  });

  it("即使回滚缓冲区仍有更新横幅，Codex 可交互时 checkReady 也返回 true", async () => {
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "codex"),
      capturePaneContent: vi.fn(async () => [
        "✨ Update available! 0.120.0 -> 0.121.0",
        "Run npm install -g @openai/codex to update.",
        "",
        "╭───────────────────────────────────────╮",
        "│ >_ OpenAI Codex (v0.120.0)            │",
        "│                                       │",
        "│ model:     gpt-5.4   /model to change │",
        "│ directory: ~/code/openrig             │",
        "╰───────────────────────────────────────╯",
        "",
        "› Improve documentation in @filename",
        "",
        "  gpt-5.4 default · ~/code/openrig",
      ].join("\n")),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs() });

    const result = await adapter.checkReady(makeBinding());

    expect(result).toEqual({ ready: true });
  });

  it("恢复的 Codex 窗格通过 Node 前台运行且近期回滚区只剩实时提示尾部时 checkReady 返回 true", async () => {
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "node"),
      capturePaneContent: vi.fn(async () => [
        "› Without using tools or reading files, reply in exactly one line: CONFIRM",
        "  CODEX2_B_20260418T1431 crimson-delta-pulse. Remember both exact lines for",
        "  later continuity verification.",
        "",
        "",
        "• CONFIRM CODEX2_B_20260418T1431 crimson-delta-pulse",
        "",
        "",
        "› Use /skills to list available skills",
        "",
        "  gpt-5.4 default · ~/code/openrig",
        "",
        "",
      ].join("\n")),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs() });

    const result = await adapter.checkReady(makeBinding());

    expect(result).toEqual({ ready: true });
  });

  // T8：listInstalled 报告已投影资源。
  it("listInstalled 报告 .agents/ 中的已投影资源", async () => {
    const fs = mockFs({
      "/project/.agents/skills": "", // directory marker
      "/project/.agents/skills/deep-review/SKILL.md": "content",
    });
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const result = await adapter.listInstalled(makeBinding());
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]!.category).toBe("skill");
  });

  // T10：deliverStartup 不执行启动操作。
  it("deliverStartup 只处理文件，不执行操作", async () => {
    // 验证接口只接受 ResolvedStartupFile[]，而不接受 StartupAction[]。
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs({ "/rig/file.md": "content" }), sleep: async () => {} });
    const file: ResolvedStartupFile = {
      path: "file.md", absolutePath: "/rig/file.md", ownerRoot: "/rig",
      deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start"],
    };
    const result = await adapter.deliverStartup([file], makeBinding());
    expect(result.delivered).toBe(1);
    // 不调用操作相关方法，只进行文件交付。
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it("交付 openrig-start 指引时替换旧式 using-openrig 受管区块", async () => {
    const fs = mockFs({
      "/rig/openrig-start.md": "# OpenRig Start\n\nNew guidance",
      "/project/AGENTS.md": [
        "<!-- BEGIN OpenRig MANAGED BLOCK: using-openrig.md -->",
        "# Using OpenRig",
        "Old guidance",
        "<!-- END OpenRig MANAGED BLOCK: using-openrig.md -->",
      ].join("\n"),
    });
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const file: ResolvedStartupFile = {
      path: "openrig-start.md",
      absolutePath: "/rig/openrig-start.md",
      ownerRoot: "/rig",
      deliveryHint: "guidance_merge",
      required: true,
      appliesOn: ["fresh_start", "restore"],
    };

    await adapter.deliverStartup([file], makeBinding());

    const store = (fs as unknown as { _store: Record<string, string> })._store;
    const content = store["/project/AGENTS.md"]!;
    expect(content).toContain("BEGIN OpenRig MANAGED BLOCK: openrig-start.md");
    expect(content).not.toContain("BEGIN OpenRig MANAGED BLOCK: using-openrig.md");
    expect(content).toContain("New guidance");
  });

  // T11：交付错误时返回结构化失败。
  it("交付失败时返回结构化失败", async () => {
    const fs = mockFs({}); // 空文件系统，找不到文件
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const file: ResolvedStartupFile = {
      path: "missing.md", absolutePath: "/rig/missing.md", ownerRoot: "/rig",
      deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start"],
    };
    const result = await adapter.deliverStartup([file], makeBinding());
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.path).toBe("missing.md");
    expect(result.failed[0]!.error).toContain("Not found");
  });

  it("粘贴 send_text 启动文件后提交输入", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs({ "/rig/startup/init.sh": "echo hello" }),
      sleep: async () => {},
    });
    const file: ResolvedStartupFile = {
      path: "startup/init.sh", absolutePath: "/rig/startup/init.sh", ownerRoot: "/rig",
      deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"],
    };

    await adapter.deliverStartup([file], makeBinding());

    expect(tmux.sendText).toHaveBeenCalledWith("r01-qa", "echo hello");
    expect(tmux.sendKeys).toHaveBeenCalledWith("r01-qa", ["C-m"]);
  });

  // OPR.0.3.3.16：大于 100KB 的 send_text 启动包仍必须原样经过
  // sendText → sleep → sendKeys(["C-m"]) 序列。大载荷缓冲机制位于 TmuxAdapter；
  // 适配器把完整内容交给 sendText，并只在末尾提交一次。
  it("通过 sendText 交付大于 100KB 的 send_text 启动文件，随后用 C-m 提交", async () => {
    const tmux = mockTmux();
    const big = "L".repeat(120 * 1024);
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs({ "/rig/startup/big-pack.md": big }),
      sleep: async () => {},
    });
    const file: ResolvedStartupFile = {
      path: "startup/big-pack.md", absolutePath: "/rig/startup/big-pack.md", ownerRoot: "/rig",
      deliveryHint: "send_text", required: true, appliesOn: ["fresh_start", "restore"],
    };

    const result = await adapter.deliverStartup([file], makeBinding());

    expect(result.delivered).toBe(1);
    expect(result.failed).toEqual([]);
    // 完整载荷交给 sendText，TmuxAdapter 会将其路由到缓冲路径。
    expect(tmux.sendText).toHaveBeenCalledWith("r01-qa", big);
    // 保持末尾只提交一次。
    expect(tmux.sendKeys).toHaveBeenCalledWith("r01-qa", ["C-m"]);
  });

  // T12：恢复时重放已投影内容是安全的。
  it("恢复时安全重放已投影内容", async () => {
    const fs = mockFs({
      "/rig/guide.md": "# Guidance",
      "/project/AGENTS.md": "<!-- BEGIN OpenRig MANAGED BLOCK: guide.md -->\n# Guidance\n<!-- END OpenRig MANAGED BLOCK: guide.md -->",
    });
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const file: ResolvedStartupFile = {
      path: "guide.md", absolutePath: "/rig/guide.md", ownerRoot: "/rig",
      deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start", "restore"],
    };

    // 交付两次时应替换受管区块，而不是重复追加。
    await adapter.deliverStartup([file], makeBinding());
    await adapter.deliverStartup([file], makeBinding());

    const store = (fs as unknown as { _store: Record<string, string> })._store;
    const content = store["/project/AGENTS.md"]!;
    const blockCount = (content.match(/BEGIN OpenRig MANAGED BLOCK/g) ?? []).length;
    expect(blockCount).toBe(1); // 恰好一个区块，而不是两个
  });

  // NS-T04：launchHarness 测试。
  it("launchHarness 发送正确的全新启动命令", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [],
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedFreshLaunchCommand());
  });

  it("全新启动时 launchHarness 传递请求的 Codex 模型", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [],
      sleep: async () => {},
    });
    const binding = { ...makeBinding(), model: "gpt-5.5" };

    const result = await adapter.launchHarness(binding, { name: "dev-qa@test-rig" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedFreshLaunchCommand({ model: "gpt-5.5" }));
  });

  it("launchHarness 使用请求的 Codex 配置 profile，且不覆盖 sandbox 或审批策略", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [],
      sleep: async () => {},
      // Housekeeping B1 修正：注入受控预检，避免运行真实的 `codex -p fleet mcp list`
      // 子进程。下方断言保持不变；它们始终针对启动命令结构，现在可在密闭环境中测试。
      verifyProfilePreflight: async (profile) => ({ ok: true, profile }),
    });
    const binding = { ...makeBinding(), codexConfigProfile: "fleet" };

    const result = await adapter.launchHarness(binding, { name: "dev-qa@test-rig" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedProfileFreshLaunchCommand("fleet"));
  });

  it("全新启动时 launchHarness 传递一次性证明用 Codex 模型", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [],
      sleep: async () => {},
    });
    const binding = { ...makeBinding(), model: "gpt-5.1-codex-mini" };

    const result = await adapter.launchHarness(binding, { name: "dev-qa@test-rig" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith(
      "r01-qa",
      expectedFreshLaunchCommand({ model: "gpt-5.1-codex-mini" })
    );
  });

  it("launchHarness 使用 OPENRIG_SHARED_DOCS_ROOT 作为 Codex 队列状态可写根目录", async () => {
    vi.stubEnv("OPENRIG_SHARED_DOCS_ROOT", "/custom/shared-docs");
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [],
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith(
      "r01-qa",
      expectedFreshLaunchCommand({ queueRoot: testQueueRoot("/custom/shared-docs") })
    );
  });

  it("会话名称不规范时 launchHarness 不猜测队列状态可写根目录", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [],
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "devqa@test-rig" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedFreshLaunchCommand({ queueRoot: null }));
  });

  it("捕获新线程 ID 前，launchHarness 用一次控制按键跳过 Codex 更新提示", async () => {
    const initialShell = [
      expectedFreshLaunchCommand(),
      "admin@host project %",
    ].join("\n");
    const updatePrompt = [
      "✨ Update available! 0.120.0 -> 0.121.0",
      "Release notes: https://github.com/openai/codex/releases/latest",
      "› 1. Update now (runs `npm install -g @openai/codex`)",
      "  2. Skip",
      "  3. Skip until next version",
      "Press enter to continue",
    ].join("\n");
    const tmux = mockTmux({
      getPaneCommand: vi.fn()
        .mockResolvedValueOnce("zsh")
        .mockResolvedValue("codex"),
      capturePaneScreen: vi.fn()
        .mockResolvedValueOnce(initialShell)
        .mockResolvedValueOnce(updatePrompt)
        .mockResolvedValueOnce(updatePrompt)
        .mockResolvedValue("OpenAI Codex (v0.120.0)\n› Ask Codex to do anything"),
      getPanePid: vi.fn(async () => 900),
    });
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh", pgid: 900, tpgid: 901, executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000" },
        { pid: 901, ppid: 900, command: "codex", pgid: 901, tpgid: 901, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000" },
      ],
      readThreadIdByPid: (pid) => pid === 901 ? "019d45bc-117d-78a3-a4ad-6fb186e5a86d" : undefined,
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result).toEqual({
      ok: true,
      resumeToken: "019d45bc-117d-78a3-a4ad-6fb186e5a86d",
      resumeType: "codex_id",
      appliedLaunch: CODEX_FLOOR_EFFECT,
    });
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText.mock.calls).toEqual([
      ["r01-qa", expectedFreshLaunchCommand()],
    ]);
    const sendKeys = tmux.sendKeys as ReturnType<typeof vi.fn>;
    expect(sendKeys.mock.calls).toEqual([
      ["r01-qa", ["Enter"]],
      ["r01-qa", ["3"]],
    ]);
  });

  it("只有“跳过到下一版本”可见时 launchHarness 才选择 Codex 更新操作", async () => {
    const tmux = mockTmux({
      capturePaneContent: vi.fn(async () => [
        "✨ Update available! 0.120.0 -> 0.121.0",
        "Press enter to continue",
      ].join("\n")),
    });
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [],
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText.mock.calls).toEqual([
      ["r01-qa", expectedFreshLaunchCommand()],
    ]);
  });

  it("等待新线程 ID 时 launchHarness 持续检查可跳过的 Codex 更新", async () => {
    const initialShell = [
      expectedFreshLaunchCommand(),
      "admin@host project %",
    ].join("\n");
    const updatePrompt = [
      "✨ Update available! 0.120.0 -> 0.121.0",
      "› 1. Update now (runs `npm install -g @openai/codex`)",
      "  2. Skip",
      "  3. Skip until next version",
      "Press enter to continue",
    ].join("\n");
    const tmux = mockTmux({
      getPaneCommand: vi.fn()
        .mockResolvedValueOnce("zsh").mockResolvedValueOnce("zsh")
        .mockResolvedValueOnce("zsh").mockResolvedValueOnce("zsh")
        .mockResolvedValueOnce("zsh").mockResolvedValueOnce("zsh")
        .mockResolvedValue("codex"),
      capturePaneScreen: vi.fn()
        .mockResolvedValueOnce(initialShell)
        .mockResolvedValueOnce(initialShell)
        .mockResolvedValueOnce(initialShell)
        .mockResolvedValueOnce(initialShell)
        .mockResolvedValueOnce(initialShell)
        .mockResolvedValueOnce(initialShell)
        .mockResolvedValueOnce(updatePrompt)
        .mockResolvedValueOnce(updatePrompt)
        .mockResolvedValue("OpenAI Codex (v0.120.0)\n› Ask Codex to do anything"),
      getPanePid: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(900),
    });
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh", pgid: 900, tpgid: 901, executableName: "zsh", startedAt: "Sat Jan  1 12:00:00 2000" },
        { pid: 901, ppid: 900, command: "codex", pgid: 901, tpgid: 901, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000" },
      ],
      readThreadIdByPid: (pid) => pid === 901 ? "019d45bc-117d-78a3-a4ad-6fb186e5a86d" : undefined,
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result).toEqual({
      ok: true,
      resumeToken: "019d45bc-117d-78a3-a4ad-6fb186e5a86d",
      resumeType: "codex_id",
      appliedLaunch: CODEX_FLOOR_EFFECT,
    });
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText.mock.calls).toEqual([
      ["r01-qa", expectedFreshLaunchCommand()],
    ]);
    expect(tmux.sendKeys).toHaveBeenLastCalledWith("r01-qa", ["3"]);
  });

  it("使用当前可见对话，而不是已消失的加载/评审回滚内容", async () => {
    const tmux = mockTmux({ capturePaneContent: vi.fn(async () => "OpenAI Codex (v0.153.4)\nmodel: loading\nHooks need review\nTrust all and continue"),
      capturePaneScreen: vi.fn(async () => "› Ask Codex to do anything\n  gpt-6-astra xhigh · /work") });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs() });
    expect(await adapter.checkReady(makeBinding())).toEqual({ ready: true });
    expect(tmux.capturePaneContent).not.toHaveBeenCalled();
    vi.mocked(tmux.capturePaneScreen).mockResolvedValue(null);
    expect((await adapter.checkReady(makeBinding())).ready).toBe(false);
  });

  it("不会在新出现的 hook 评审中输入一概信任选项", async () => {
    const tmux = mockTmux({ capturePaneContent: vi.fn(async () => "Hooks need review\n1. Review hooks\n2. Trust all and continue\n3. Continue without trusting"), getPanePid: vi.fn(async () => 900) });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {}, listProcesses: () => [] });
    await adapter.launchHarness(makeBinding(), { name: "impl" });
    expect(tmux.sendText).toHaveBeenCalledTimes(1);
    expect(tmux.sendKeys).toHaveBeenCalledTimes(1);
  });

  it("launchHarness 从实时子进程捕获新的 Codex 线程 ID", async () => {
    const tmux = mockTmux({
      getPanePid: vi.fn(async () => 900),
    });
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "codex" },
      ],
      readThreadIdByPid: (pid) => pid === 901 ? "019d45bc-117d-78a3-a4ad-6fb186e5a86d" : undefined,
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result).toEqual({
      ok: true,
      resumeToken: "019d45bc-117d-78a3-a4ad-6fb186e5a86d",
      resumeType: "codex_id",
      appliedLaunch: CODEX_FLOOR_EFFECT,
    });
  });

  it("launchHarness 从嵌套 wrapper 到 vendor codex 的进程树捕获新线程 ID", async () => {
    const tmux = mockTmux({
      getPanePid: vi.fn(async () => 900),
    });
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "node /opt/homebrew/bin/codex -s workspace-write -C /project" },
        { pid: 902, ppid: 901, command: "/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex/codex -s workspace-write -C /project" },
      ],
      readThreadIdByPid: (pid) => pid === 902 ? "019d45bc-117d-78a3-a4ad-6fb186e5a86d" : undefined,
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result).toEqual({
      ok: true,
      resumeToken: "019d45bc-117d-78a3-a4ad-6fb186e5a86d",
      resumeType: "codex_id",
      appliedLaunch: CODEX_FLOOR_EFFECT,
    });
  });

  it("launchHarness 从子进程主目录捕获新的 Codex 线程 ID", async () => {
    const tempRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rigged-codex-home-"));
    const actualHome = nodePath.join(tempRoot, "actual-home");
    createCodexLogsDb(actualHome, 901, "019d45bc-117d-78a3-a4ad-6fb186e5a86d");

    const tmux = mockTmux({
      getPanePid: vi.fn(async () => 900),
    });
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: {
        readFile: (p: string) => fs.readFileSync(p, "utf-8"),
        writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
        exists: (p: string) => fs.existsSync(p),
        mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
        listFiles: (dir: string) => fs.readdirSync(dir),
        homedir: "/wrong-home",
      },
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "codex" },
      ],
      resolveHomeDirByPid: (pid) => pid === 901 ? actualHome : undefined,
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result).toEqual({
      ok: true,
      resumeToken: "019d45bc-117d-78a3-a4ad-6fb186e5a86d",
      resumeType: "codex_id",
      appliedLaunch: CODEX_FLOOR_EFFECT,
    });
  });

  it("launchHarness 从当前版本的日志数据库捕获新的 Codex 线程 ID", async () => {
    const tempRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rigged-codex-home-"));
    const actualHome = nodePath.join(tempRoot, "actual-home");
    createCodexLogsDb(actualHome, 901, "019d45bc-117d-78a3-a4ad-6fb186e5a86d", "logs_2.sqlite");

    const tmux = mockTmux({
      getPanePid: vi.fn(async () => 900),
    });
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: {
        readFile: (p: string) => fs.readFileSync(p, "utf-8"),
        writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
        exists: (p: string) => fs.existsSync(p),
        mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
        listFiles: (dir: string) => fs.readdirSync(dir),
        homedir: "/wrong-home",
      },
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "codex" },
      ],
      resolveHomeDirByPid: (pid) => pid === 901 ? actualHome : undefined,
      sleep: async () => {},
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig" });

    expect(result).toEqual({
      ok: true,
      resumeToken: "019d45bc-117d-78a3-a4ad-6fb186e5a86d",
      resumeType: "codex_id",
      appliedLaunch: CODEX_FLOOR_EFFECT,
    });
  });

  it("launchHarness 发送正确的恢复命令", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs() });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedResumeCommand());
  });

  it("0.5.2-07 A2-3：launchHarness 将 spec 模型传入 Codex 恢复命令", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs() });
    const binding = { ...makeBinding(), model: "gpt-5.4-cheap" };

    const result = await adapter.launchHarness(binding, { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedResumeCommand("sess-456", testQueueRoot(), "gpt-5.4-cheap"));
  });

  it("0.5.2-07 A2-3：launchHarness 将 spec 模型传入 Codex 分叉命令", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [],
      sleep: async () => {},
    });
    const binding = { ...makeBinding(), model: "gpt-5.4-cheap" };

    // 命令在分叉后的线程 ID 捕获前构建并发送；即使未模拟线程捕获（分叉最终返回
    // not-captured），仍需断言已发送命令。
    await adapter.launchHarness(binding, {
      name: "dev-qa@test-rig",
      forkSource: { kind: "native_id", value: "parent-thread-id" },
    });

    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedForkCommand("parent-thread-id", { model: "gpt-5.4-cheap" }));
  });

  it("恢复时 launchHarness 传递请求的 Codex 配置 profile", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [],
      sleep: async () => {},
      // Housekeeping B1 修正：使用受控预检，不运行真实 codex 子进程。
      verifyProfilePreflight: async (profile) => ({ ok: true, profile }),
    });
    const binding = { ...makeBinding(), codexConfigProfile: "fleet" };

    const result = await adapter.launchHarness(binding, { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedProfileResumeCommand("fleet"));
  });

  // Housekeeping B1 修正（S-3）—— 适配器边界失败契约。注入的 profile 预检失败时，
  // launchHarness 必须在构建或发送任何启动命令前，以适配器组合后的错误（探测错误 +
  // "\n  修复：" + migrationHint）拒绝，即绝不调用 tmux.sendText。丰富的真实探测失败向量
  //（旧表、TOML、超时、引用）仍由 codex-profile-preflight.test.ts 负责；这里仅固定
  // 适配器的关联与顺序。
  it("profile 预检失败时 launchHarness 返回组合错误且不发送任何内容", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      listProcesses: () => [],
      sleep: async () => {},
      verifyProfilePreflight: async (profile) => ({
        ok: false,
        profile,
        error: `Codex profile '${profile}' failed to load: legacy [profiles.fleet] table present`,
        migrationHint: "Move the profile settings into ~/.codex/fleet.config.toml and remove the legacy [profiles.fleet] table.",
      }),
    });
    const binding = { ...makeBinding(), codexConfigProfile: "fleet" };

    const result = await adapter.launchHarness(binding, { name: "dev-qa@test-rig" });

    expect(result).toEqual({
      ok: false,
      error:
        "Codex profile 'fleet' failed to load: legacy [profiles.fleet] table present" +
        "\n  修复：Move the profile settings into ~/.codex/fleet.config.toml and remove the legacy [profiles.fleet] table.",
    });
    // 在构建命令前拒绝，因此不会发送任何启动文本。
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).not.toHaveBeenCalled();
  });

  // 清理前的“配置项目本地 Codex hook 与特性开关且不持久化 hook token”测试已在
  // plugin-primitive Phase 3a slice 3.1 中移除；活动 hook 自动注入已删除，
  // provisionActivityHooks 不再存在。替代覆盖位于 codex-hooks-feature-flag.test.ts
  //（slice 3.5 ensureCodexFeatureFlag）和 activity-hook-rip-proof.test.ts
  //（反向断言适配器符号缺失及端点保持不变）。

  it("恢复验证期间 launchHarness 用一次控制按键跳过 Codex 更新提示", async () => {
    const updatePrompt = [
      "✨ Update available! 0.120.0 -> 0.121.0",
      "› 1. Update now (runs `npm install -g @openai/codex`)",
      "  2. Skip",
      "  3. Skip until next version",
      "Press enter to continue",
    ].join("\n");
    const tmux = mockTmux({
      getPanePid: vi.fn(async () => 901),
      capturePaneScreen: vi.fn()
        .mockResolvedValueOnce(updatePrompt)
        .mockResolvedValueOnce(updatePrompt)
        .mockResolvedValue("OpenAI Codex (v0.120.0)\n› Ask Codex to do anything"),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {},
      listProcesses: () => [{ pid: 901, ppid: 1, pgid: 901, tpgid: 901, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000", command: "codex" }],
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result).toEqual({ ok: true, resumeToken: "sess-456", resumeType: "codex_id", appliedLaunch: CODEX_FLOOR_EFFECT });
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText.mock.calls).toEqual([
      ["r01-qa", expectedResumeCommand()],
    ]);
    const sendKeys = tmux.sendKeys as ReturnType<typeof vi.fn>;
    expect(sendKeys.mock.calls).toEqual([
      ["r01-qa", ["Enter"]],
      ["r01-qa", ["3"]],
    ]);
  });

  // 0.5.2-07 A2-3 契约翻转：此测试此前断言恢复时丢弃模型（`.not.toContain("-m")`），
  // 只是描述 51-07-A1 时期的增量推理缺陷：全新启动传递 -m，而恢复/分叉不传递，且没有
  // 理由如此。这正是本切片消除的问题。修正后恢复会携带 -m（顶层标志，与已发布的 -p
  // 同类），队列 --add-dir 保持不变。
  it("恢复 Codex 时 launchHarness 传递 spec 模型参数 -m", async () => {
    const tmux = mockTmux();
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs() });
    const binding = { ...makeBinding(), model: "gpt-5.5" };

    const result = await adapter.launchHarness(binding, { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith("r01-qa", expectedResumeCommand("sess-456", testQueueRoot(), "gpt-5.5"));
    expect(sendText.mock.calls[0]?.[1]).toContain(" -m 'gpt-5.5'");
    expect(sendText.mock.calls[0]?.[1]).toContain("--add-dir");
  });

  it("Codex 报告找不到恢复令牌对应的已保存会话时 launchHarness 返回 retry_fresh", async () => {
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "zsh"),
      capturePaneContent: vi.fn(async () => [
        "No saved session found for id sess-456",
        "admin@host openrig %",
      ].join("\n")),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result).toEqual({
      ok: false,
      error: "Codex resume 失败：找不到所请求 session 对应的已保存会话",
      recovery: "retry_fresh",
    });
  });

  // Codex 认证拒绝的 pod 感知路径。verifyResumeLaunch 必须把
  // probe.status === "attention_required" 显示为 recovery: "attention_required"，
  // 并附带最后 12 行证据。它与旧 CodexResumeAdapter 路径共同修复提交 63ee206 中
  // guard 被阻塞的缺口。
  it("恢复期间 Codex 登出后刷新令牌失败时 launchHarness 返回 attention_required", async () => {
    const refusalPane = [
      "$ codex -s workspace-write resume sess-456",
      "Error: Your access token could not be refreshed because you have since",
      "logged out or signed in to another account. Please sign in again.",
    ].join("\n");
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "zsh"),
      capturePaneContent: vi.fn(async () => refusalPane),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recovery).toBe("attention_required");
      expect(result.error).toContain("重新登录");
      // 证据是最后 12 行尾部，与 claude-resume.ts 对应逻辑一致。
      expect(result.evidence).toBeDefined();
      expect(result.evidence).toContain("access token could not be refreshed");
      expect(result.evidence).toContain("Please sign in again");
    }
  });

  it("遇到 Codex `log out and sign in` 变体时 launchHarness 返回 attention_required", async () => {
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "zsh"),
      capturePaneContent: vi.fn(async () => [
        "$ codex -s workspace-write resume sess-456",
        "Your access token could not be refreshed.",
        "Please log out and sign in again.",
      ].join("\n")),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.recovery).toBe("attention_required");
  });

  // OPR.0.3.3.21 FR-2 —— 如实恢复门禁。探测只能证明进程存活但门禁尚未解决时，
  // verifyResumeLaunch 不得返回启动成功。本切片前这些情况都会返回 { ok: true }
  //（04.3 bootstrap_failed 提示）；下方每个测试在旧行为下都会失败。

  // 关键判别条件（04.3 Codex 更新流程场景）：无法自动关闭的更新门禁必须分类为
  // attention_required，不能只因进程存活就判定启动成功。
  it("FR-2 判别条件：在未解决 Codex 更新门禁上恢复时返回 attention_required 而非 ok:true", async () => {
    const updateGate = [
      "✨ Update available! 0.120.0 -> 0.121.0",
      "Updating Codex...",
    ].join("\n"); // 没有“跳过到下一版本”选项，因此无法自动关闭
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "node"),
      capturePaneContent: vi.fn(async () => updateGate), // 每次轮询都保持门禁状态
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(false); // 修复前门禁仍返回 ok:true，此断言会失败
    if (!result.ok) {
      expect(result.recovery).toBe("attention_required");
      expect(result.error).toContain("仅有进程存活不能证明");
      expect(result.evidence).toContain("Update available");
    }
  });

  it("FR-2：在未解决 Codex 信任门禁上恢复时返回 attention_required 而非 ok:true", async () => {
    const trustGate = [
      "Do you trust the contents of this directory?",
      "› 1. Yes, continue",
      "  2. No, exit",
    ].join("\n");
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "codex"),
      capturePaneContent: vi.fn(async () => trustGate),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recovery).toBe("attention_required");
      expect(result.error).toContain("信任");
    }
  });

  it("FR-2：在未解决 Codex 模型选择门禁上恢复时返回 attention_required 而非 ok:true", async () => {
    const modelGate = [
      "Select a model to continue:",
      "› 1. gpt-5.1-codex",
      "  2. gpt-5.1-codex-mini",
    ].join("\n");
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "codex"),
      capturePaneContent: vi.fn(async () => modelGate),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recovery).toBe("attention_required");
      expect(result.error).toContain("选择模型");
    }
  });

  it("FR-2：有界轮询内始终无法证明 resumed 时返回 attention_required 而非 ok:true", async () => {
    // 进程存活但尚未成为前台运行时，且没有显式门禁，因此探测保持 `inconclusive`；
    // 旧回退逻辑会错误地把它洗成 ok:true。
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "node"),
      capturePaneContent: vi.fn(async () => "spawning codex worker..."),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recovery).toBe("attention_required");
      expect(result.evidence).toBeDefined();
    }
  });

  // OPR.0.3.4.13 —— 缓慢但有效的 Codex 恢复：经历数个 boot-in-progress tick 后，
  // 窗格变为就绪 Codex TUI；必须分类为 `resumed` 并携带恢复元数据，而不是
  // `attention_required`。
  it("OPR.0.3.4.13：Codex 缓慢恢复后 TUI 就绪时分类为 resumed 并携带元数据", async () => {
    let callCount = 0;
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => {
        callCount++;
        return callCount <= 10 ? "node" : "codex";
      }),
      capturePaneContent: vi.fn(async () => {
        if (callCount <= 10) return "codex -s workspace-write resume 019ecd3b-test-thread\nCodex v0.128.0\nloading...";
        return "OpenAI Codex (v0.128.0)\n  gpt-5.5 · session 019ecd3b-test-thread\n› ";
      }),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-worker@test-rig",
      resumeToken: "019ecd3b-test-thread",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resumeToken).toBe("019ecd3b-test-thread");
      expect(result.resumeType).toBe("codex_id");
    }
  });

  // OPR.0.3.4.13：真实门禁仍快速分类；信任门禁不会获得延长的 boot-in-progress 窗口。
  it("OPR.0.3.4.13：信任门禁不延长等待，仍分类为 attention_required", async () => {
    let pollCount = 0;
    const trustGate = "Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, exit";
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => { pollCount++; return "codex"; }),
      capturePaneContent: vi.fn(async () => trustGate),
    });
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-qa@test-rig", resumeToken: "sess-456" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.recovery).toBe("attention_required");
    }
    // 信任门禁不应进入延长阶段（30 次尝试）。快速阶段为 6 次，随后立即退出。
    expect(pollCount).toBeLessThanOrEqual(7);
  });

  // 防止破坏已工作的自动关闭逻辑：可跳过的更新门禁仍会自动关闭并继续成功；上方恢复
  // 验证测试已端到端覆盖。只有未解决门禁会醒目失败。

  it("deliverStartup 为受管项目预先写入 Codex 信任", async () => {
    const fs = mockFs({});
    const fsWithHome = { ...fs, homedir: "/home/tester" };
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fsWithHome });

    await adapter.deliverStartup([], makeBinding("/tmp/workspace"));

    const store = (fsWithHome as unknown as { _store: Record<string, string> })._store;
    const content = store["/home/tester/.codex/config.toml"];
    expect(content).toBeDefined();
    expect(content).toContain('[projects."/tmp/workspace"]');
    expect(content).toContain('trust_level = "trusted"');
  });

  it("GAP-7 通过注入的 Codex 主目录路由工作区信任与运行时配置片段", async () => {
    const fs = mockFs({
      "/agents/base/runtime/codex-config.toml": "[mcp_servers.test]\nurl = \"https://example.test\"\n",
    });
    const fsWithHome = { ...fs, homedir: "/daemon-home" };
    const adapter = new CodexRuntimeAdapter({
      tmux: mockTmux(),
      fsOps: fsWithHome,
      codexHome: "/daemon-codex",
    });
    const plan: ProjectionPlan = {
      runtime: "codex", cwd: "/tmp/workspace",
      entries: [makeEntry({
        category: "runtime_resource",
        effectiveId: "codex-test-config",
        resourceType: "codex_config_fragment",
        absolutePath: "/agents/base/runtime/codex-config.toml",
        resourcePath: "runtime/codex-config.toml",
      })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    await adapter.deliverStartup([], makeBinding("/tmp/workspace"));
    await adapter.project(plan, makeBinding("/tmp/workspace"));

    const store = (fsWithHome as unknown as { _store: Record<string, string> })._store;
    expect(store["/daemon-codex/config.toml"]).toContain('[projects."/tmp/workspace"]');
    expect(store["/daemon-codex/config.toml"]).toContain("[mcp_servers.test]");
    expect(store["/daemon-home/.codex/config.toml"]).toBeUndefined();
  });

  it("没有运行时资源时 deliverStartup 不注入 Codex MCP 服务器", async () => {
    const fs = mockFs({
      "/home/tester/.codex/config.toml": '[projects."/tmp/workspace"]\ntrust_level = "trusted"\n',
    });
    const fsWithHome = { ...fs, homedir: "/home/tester" };
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fsWithHome });

    await adapter.deliverStartup([], makeBinding("/tmp/workspace"));

    const store = (fsWithHome as unknown as { _store: Record<string, string> })._store;
    const content = store["/home/tester/.codex/config.toml"];
    expect(content).toContain('[projects."/tmp/workspace"]');
    expect(content).toContain('trust_level = "trusted"');
    expect(content).not.toContain('[mcp_servers.exa]');
    expect(content).not.toContain('[mcp_servers.context7]');
  });

  it("将 codex_config_fragment 运行时资源幂等应用到全局 Codex 配置", async () => {
    const fs = mockFs({
      "/agents/base/runtime/codex-config.toml": [
        "[mcp_servers.exa]",
        'url = "https://mcp.exa.ai/mcp"',
        "",
        "[mcp_servers.context7]",
        'url = "https://mcp.context7.com/mcp"',
        "",
      ].join("\n"),
      "/home/tester/.codex/config.toml": '[projects."/tmp/workspace"]\ntrust_level = "trusted"\n',
    });
    const fsWithHome = { ...fs, homedir: "/home/tester" };
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fsWithHome });
    const plan: ProjectionPlan = {
      runtime: "codex", cwd: "/tmp/workspace",
      entries: [makeEntry({
        category: "runtime_resource",
        effectiveId: "codex-default-config",
        resourceType: "codex_config_fragment",
        absolutePath: "/agents/base/runtime/codex-config.toml",
        resourcePath: "runtime/codex-config.toml",
      })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    const first = await adapter.project(plan, makeBinding("/tmp/workspace"));
    const second = await adapter.project(plan, makeBinding("/tmp/workspace"));

    expect(first).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });
    expect(second).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });
    const store = (fsWithHome as unknown as { _store: Record<string, string> })._store;
    const content = store["/home/tester/.codex/config.toml"];
    expect(content).toContain('[projects."/tmp/workspace"]');
    expect(content).toContain('trust_level = "trusted"');
    expect(content.match(/\[mcp_servers\.exa\]/g)?.length ?? 0).toBe(1);
    expect(content.match(/\[mcp_servers\.context7\]/g)?.length ?? 0).toBe(1);
    expect(content.match(/BEGIN OPENRIG MANAGED CODEX CONFIG FRAGMENT: codex-default-config/g)?.length ?? 0).toBe(1);
  });

  // --- OPR.0.5.8.12：用户所有的 Codex 表在投影后保留 ---
  //
  // 修复前片段会原样拼入，因此已经拥有 [mcp_servers.exa] 的用户会得到重复表，
  // 导致 Codex 拒绝启动：
  //   "failed to load bootstrap configuration ... duplicate key"
  // 已在 codex-cli 0.147.0 上复现。下方每项断言都以真实结果——渲染后的配置能够解析——
  // 为终点，而不是只检查字符串形态。

  const SHIPPED_FRAGMENT = [
    "[mcp_servers.exa]",
    'url = "https://mcp.exa.ai/mcp"',
    "",
    "[mcp_servers.context7]",
    'url = "https://mcp.context7.com/mcp"',
    "",
  ].join("\n");

  async function projectFragment(userConfig: string, fragment = SHIPPED_FRAGMENT) {
    const fs = mockFs({
      "/agents/base/runtime/codex-config.toml": fragment,
      "/home/tester/.codex/config.toml": userConfig,
    });
    const fsWithHome = { ...fs, homedir: "/home/tester" };
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fsWithHome });
    const plan: ProjectionPlan = {
      runtime: "codex", cwd: "/tmp/workspace",
      entries: [makeEntry({
        category: "runtime_resource",
        effectiveId: "codex-default-config",
        resourceType: "codex_config_fragment",
        absolutePath: "/agents/base/runtime/codex-config.toml",
        resourcePath: "runtime/codex-config.toml",
      })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };
    const store = (fsWithHome as unknown as { _store: Record<string, string> })._store;
    const project = () => adapter.project(plan, makeBinding("/tmp/workspace"));
    return { project, read: () => store["/home/tester/.codex/config.toml"]! };
  }

  it("片段声明同名表时保留用户所有的 MCP 表及其值", async () => {
    const { project, read } = await projectFragment([
      '[projects."/tmp/workspace"]',
      'trust_level = "trusted"',
      "",
      "[mcp_servers.exa]",
      'url = "https://exa.internal.example/mcp"',
      'api_key = "USER-OWNED"',
      "",
    ].join("\n"));

    expect(await project()).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });

    const parsed = parseToml(read()) as Record<string, any>;
    expect(parsed.mcp_servers.exa.url).toBe("https://exa.internal.example/mcp");
    expect(parsed.mcp_servers.exa.api_key).toBe("USER-OWNED");
    // 片段中不冲突的另一半仍会落地。
    expect(parsed.mcp_servers.context7.url).toBe("https://mcp.context7.com/mcp");
    expect(parsed.projects["/tmp/workspace"].trust_level).toBe("trusted");
  });

  it("片段声明多个同名表时保留所有用户所有的 MCP 表", async () => {
    const { project, read } = await projectFragment([
      "[mcp_servers.exa]",
      'url = "https://exa.internal.example/mcp"',
      "",
      "[mcp_servers.context7]",
      'url = "https://c7.internal.example/mcp"',
      "",
    ].join("\n"));

    expect(await project()).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });

    const parsed = parseToml(read()) as Record<string, any>;
    expect(parsed.mcp_servers.exa.url).toBe("https://exa.internal.example/mcp");
    expect(parsed.mcp_servers.context7.url).toBe("https://c7.internal.example/mcp");
  });

  it("用户在同一父级下拥有其他表时仍完整落地片段", async () => {
    // [mcp_servers.other] 与 [mcp_servers.exa] 共享隐式父级，但可以合法共存；
    // 在父级检测冲突会错误地丢弃两者。
    const { project, read } = await projectFragment([
      "[mcp_servers.other]",
      'url = "https://other.example/mcp"',
      "",
    ].join("\n"));

    await project();
    const parsed = parseToml(read()) as Record<string, any>;
    expect(parsed.mcp_servers.other.url).toBe("https://other.example/mcp");
    expect(parsed.mcp_servers.exa.url).toBe("https://mcp.exa.ai/mcp");
    expect(parsed.mcp_servers.context7.url).toBe("https://mcp.context7.com/mcp");
  });

  it("发生冲突时重复投影保持幂等，不重复添加受管区块", async () => {
    const { project, read } = await projectFragment([
      "[mcp_servers.exa]",
      'url = "https://exa.internal.example/mcp"',
      "",
    ].join("\n"));

    expect(await project()).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });
    const afterFirst = read();
    expect(await project()).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });
    const afterSecond = read();

    expect(afterSecond).toBe(afterFirst);
    expect(() => parseToml(afterSecond)).not.toThrow();
    expect(afterSecond.match(/BEGIN OPENRIG MANAGED CODEX CONFIG FRAGMENT: codex-default-config/g)!.length).toBe(1);
    expect((parseToml(afterSecond) as Record<string, any>).mcp_servers.exa.url)
      .toBe("https://exa.internal.example/mcp");
  });

  it("不把多行字符串内转义分隔符之后的内容误认成表头（r2 NOT-CLEAR，09-01）", async () => {
    // review50-r2 对候选提交 4d2ad86c 的阻塞发现。`\"""` 是一个转义引号加两个引号，
    // 并非字符串结束，因此此处 [mcp_servers.exa] 是字符串数据，受管 exa 仍必须落地。
    // 旧用户侧表头扫描器把转义符误认为终止符，并在报告成功的同时静默丢弃该表；最终解析
    // 保护无法发现，因为错误答案仍是有效 TOML。
    const userConfig = [
      "[profiles.notes]",
      'text = """',
      '\\"""',
      "[mcp_servers.exa]",
      "this is still string data",
      '"""',
      "",
    ].join("\n");
    const { project, read } = await projectFragment(userConfig);

    // 事实 1：用户确实没有声明 exa 表。
    expect((parseToml(userConfig) as Record<string, any>).mcp_servers).toBeUndefined();
    // 事实 2：投影成功。
    expect(await project()).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });
    const after = parseToml(read()) as Record<string, any>;
    // 事实 3：两个受管表都落地。
    expect(after.mcp_servers.exa.url).toBe("https://mcp.exa.ai/mcp");
    expect(after.mcp_servers.context7.url).toBe("https://mcp.context7.com/mcp");
    // 事实 4：用户字符串保持不变。
    expect(after.profiles.notes.text).toBe((parseToml(userConfig) as Record<string, any>).profiles.notes.text);
  });

  it("投影包含多行嵌套数组的片段（r2 NOT-CLEAR #3，09-01）", async () => {
    // review50-r2 对候选提交 a760ec27 的阻塞发现。`  [1, 2],` 是多行数组的一行，
    // 不是表头；但分割器曾把任何以方括号开头的行都分类为表头，拆散数组，随后渲染保护
    // 拒绝完全有效的片段。应由深度而不是行文本自身来区分。
    //
    // OPR.0.5.8.15 对此作了修正而非弱化。R2 原始复现把数组放在根级；.15 现在因无关
    // 原因直接拒绝该形态（TOML 无法重新打开根）。若把断言改为期待拒绝，会在变绿的同时
    // 废掉 R2 真正修复的行为，因此数组移入表内——唯一合法形态——并保持深度断言不变。
    // 根级形态的拒绝在下方单独固定。
    const original = 'model = "gpt-5"\n';
    const fragment = ["[managed.data]", "matrix = [", "  [1, 2],", "  [3, 4],", "]", ""].join("\n");
    const { project, read } = await projectFragment(original, fragment);

    const result = await project();
    expect(result).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });
    const after = parseToml(read()) as Record<string, any>;
    expect(after.model).toBe("gpt-5");                          // 保留用户值
    expect(after.managed.data.matrix).toEqual([[1, 2], [3, 4]]); // 数组完整，没有被拆散
  });

  it("仍能识别多行数组之后的真实表头", async () => {
    // 深度修复不能过度：数组关闭后回到文档层级，后续两个表头都应重新识别为表头；
    // 冲突表让位给用户，另一个表正常落地。
    const original = '[mcp_servers.exa]\nurl = "https://user.example/mcp"\n';
    const fragment = [
      "[managed.data]",
      "matrix = [", "  [1, 2],", "]",
      "[mcp_servers.exa]", 'url = "https://mcp.exa.ai/mcp"',
      "[mcp_servers.context7]", 'url = "https://mcp.context7.com/mcp"', "",
    ].join("\n");
    const { project, read } = await projectFragment(original, fragment);

    expect(await project()).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });
    const after = parseToml(read()) as Record<string, any>;
    expect(after.mcp_servers.exa.url).toBe("https://user.example/mcp");   // 用户值优先
    expect(after.mcp_servers.context7.url).toBe("https://mcp.context7.com/mcp");
    expect(after.managed.data.matrix).toEqual([[1, 2]]);                  // 数组保持完整
  });

  // --- OPR.0.5.8.15：拒绝片段根级 key，而不是将其静默绑定到用户所有的表。---
  //
  // 取代 OPR.0.5.8.12 中把该现象记录为继承行为的固定项（`matrix` 落为
  // `mcp_servers.other.matrix`）。该固定项对机制的描述正确，但作为契约现已过时：
  // 此结构应被拒绝。

  it("拒绝首个表头前声明 key 的片段（OPR.0.5.8.15）", async () => {
    // spec 复现：用户文档结束于 [mcp_servers.other] 内，因此追加的根级 key 只能绑定到
    // 用户的表。TOML 没有重新打开根的语法，所以保留作者意图不是代价高，而是根本不可能；
    // 如实做法是拒绝并说明原因。
    const original = '[mcp_servers.other]\nurl = "https://user.example/mcp"\n';
    const { project, read } = await projectFragment(original, "matrix = [[1, 2]]\n");

    const result = await project();
    expect(result.projected).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.error).toMatch(/首个表头之前声明了根级 key/);
    expect(result.failed[0]!.error).toMatch(/请先打开一个表/);   // 点明作者应采取的修复。
    expect(read()).toBe(original);                                   // 字节不变
  });

  it("即使用户文件结束于根级，也确定性拒绝相同形态", async () => {
    // 此时 key 实际上会绑定到根级，依赖状态的规则可能允许它。但仍应拒绝：片段作者看不到
    // 用户状态，依赖他人文件决定成败的契约无法由作者复现。
    const original = 'model = "gpt-5"\n';
    const { project, read } = await projectFragment(original, "matrix = [[1, 2]]\n");

    const result = await project();
    expect(result.projected).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(read()).toBe(original);
  });

  it("允许首个表头前出现注释和空行", async () => {
    // 因开头注释而拒绝会让规则显得武断，也会拒绝完全普通的自定义片段。
    const original = 'model = "gpt-5"\n';
    const fragment = ["# managed by openrig", "", "[mcp_servers.context7]", 'url = "https://mcp.context7.com/mcp"', ""].join("\n");
    const { project, read } = await projectFragment(original, fragment);

    expect(await project()).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });
    expect((parseToml(read()) as Record<string, any>).mcp_servers.context7.url).toBe("https://mcp.context7.com/mcp");
  });

  it("已发布的 codex-default-config 片段不受影响（OPR.0.5.8.15 回归）", async () => {
    // 已发布片段以表头开头，因此新拒绝规则不得影响它，包括其 OPR.0.5.8.12 冲突行为。
    const original = [
      '[projects."/tmp/workspace"]', 'trust_level = "trusted"', "",
      "[mcp_servers.exa]", 'url = "https://exa.internal.example/mcp"', 'api_key = "USER-SECRET"', "",
    ].join("\n");
    const { project, read } = await projectFragment(original);

    expect(await project()).toEqual({ projected: ["codex-default-config"], skipped: [], failed: [] });
    const after = parseToml(read()) as Record<string, any>;
    expect(after.mcp_servers.exa.url).toBe("https://exa.internal.example/mcp");
    expect(after.mcp_servers.exa.api_key).toBe("USER-SECRET");
    expect(after.mcp_servers.context7.url).toBe("https://mcp.context7.com/mcp");
  });

  it("拒绝本身无效的受管片段，而不是删除它（r2 NOT-CLEAR，09-01）", async () => {
    // review50-r2 对候选提交 ebfe60d9 的阻塞发现。“追加该区块导致解析失败”有两种原因：
    // 用户冲突或区块格式错误。混淆两者会让冲突过滤器删除无效的自定义片段；随后恰因错误
    // 输入已消失，渲染保护通过，回执也错误地报告 projected。
    const original = 'model = "gpt-5"\n';
    const { project, read } = await projectFragment(original, "[mcp_servers.exa]\nurl =\n");

    const result = await project();
    expect(result.projected).toEqual([]);            // 投影数量为零
    expect(result.failed).toHaveLength(1);           // 一项投影失败
    expect(result.failed[0]!.error).toMatch(/本身不是有效 TOML/);
    expect(read()).toBe(original);                   // 用户文件字节不变
  });

  it("拒绝自身表之间相互冲突的片段", async () => {
    // 同一个独立检查修复此问题：逐区块冲突测试只把每个区块与用户配置比较，因此不可能
    // 捕获片段内部的冲突。
    const original = 'model = "gpt-5"\n';
    const dup = "[mcp_servers.exa]\nurl = \"a\"\n\n[mcp_servers.exa]\nurl = \"b\"\n";
    const { project, read } = await projectFragment(original, dup);

    const result = await project();
    expect(result.projected).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(read()).toBe(original);
  });

  it("用户配置无法解析时保持片段完整并拒绝写入", async () => {
    // 无法读取的文件无法进行冲突判定，因此不丢弃任何内容，由渲染保护拒绝写入，
    // 而不是尝试“修复”。
    const broken = "[mcp_servers.exa\nurl = \n";
    const { project, read } = await projectFragment(broken);
    const result = await project();
    expect(result.projected).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(read()).toBe(broken);
  });

  it("不把多行字符串内的表头误认成用户所有的表", async () => {
    const { project, read } = await projectFragment([
      "[profiles.notes]",
      'text = """',
      "[mcp_servers.exa]",
      'not a table, just prose"""',
      "",
    ].join("\n"));

    await project();
    // 用户从未真正声明 exa，因此受管表必须落地。
    expect((parseToml(read()) as Record<string, any>).mcp_servers.exa.url).toBe("https://mcp.exa.ai/mcp");
  });

  it("拒绝重复的根级 key 而不是写入，并保持文件不变", async () => {
    // 原行为：重复顶层 key 不是表冲突，因此丢弃表无法修复，必须由渲染保护拒绝。
    //
    // OPR.0.5.8.15 修正后，该情况会提前一层被根 scope 拒绝，因此不再由渲染保护阻止。
    // 用户可见契约不变并继续在此固定：不写入任何内容，文件字节完全一致；但断言不再声称
    // 由哪个保护触发，因为该说法已经不成立。
    //
    // 更正（orch-lead，09-01）：此前曾声称 `assertRendersAsLoadableToml` 已不可达，这是错误的。
    // 反例就在本文件中：下方无效用户配置测试可以到达它；userParses=false，因此不会丢弃
    // 区块，渲染文档仍无效。已验证该路径以“将写入 Codex 无法解析的配置”失败。保护仍在
    // 生效；此前把主观猜测误报成了代码属性。
    const original = 'model = "user-choice"\n';
    const { project, read } = await projectFragment(original, 'model = "managed-choice"\n');

    const result = await project();
    expect(result.projected).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.error).toMatch(/保持不变/);
    expect(read()).toBe(original);
  });

  // --- Regenerator 缺陷修复：跳过 rig-role 受管区块 ---
  //
  // 与 Claude Code 适配器修复并行。Codex 成员的 AGENTS.md 也会出现相同的 rig-role 席位
  // 冲突。按照架构 SHAPE 1：区块 ID 为 `rig-role` 时跳过 mergeManagedBlock，并如实
  // 记录跳过。

  it("projectEntry 跳过 rig-role 指引受管区块，不写入 AGENTS.md", async () => {
    const fs = mockFs({ "/agents/qa/guidance/role.md": "# You are `qa`\ngate discipline." });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "codex", cwd: "/project",
      entries: [{
        category: "guidance", effectiveId: "rig-role", mergeStrategy: "managed_block",
        sourceSpec: "base", sourcePath: "/agents/qa",
        resourcePath: "guidance/role.md", absolutePath: "/agents/qa/guidance/role.md",
        classification: "safe_projection",
      } as ProjectionEntry],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    const result = await adapter.project(plan, makeBinding());

    const store = (fs as unknown as { _store: Record<string, string> })._store;
    expect(store["/project/AGENTS.md"]).toBeUndefined();
    // ProjectionResult 契约：rig-role 必须出现在 `skipped`，而不是 `projected` 中。
    expect(result.skipped).toContain("rig-role");
    expect(result.projected).not.toContain("rig-role");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("跳过：effectiveId 为 rig-role")
    );
    logSpy.mockRestore();
  });

  it("projectEntry 将非 rig-role 指引记入 `projected` 而非 `skipped`（契约回归）", async () => {
    const fs = mockFs({ "/agents/base/guidance/using-openrig.md": "# Using OpenRig\nhub guidance" });
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "codex", cwd: "/project",
      entries: [{
        category: "guidance", effectiveId: "using-openrig.md", mergeStrategy: "managed_block",
        sourceSpec: "base", sourcePath: "/agents/base",
        resourcePath: "guidance/using-openrig.md",
        absolutePath: "/agents/base/guidance/using-openrig.md",
        classification: "safe_projection",
      } as ProjectionEntry],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    const result = await adapter.project(plan, makeBinding());

    expect(result.projected).toContain("using-openrig.md");
    expect(result.skipped).not.toContain("using-openrig.md");
  });

  it("projectEntry 仍合并非 rig-role 指引区块（回归）", async () => {
    const fs = mockFs({ "/agents/base/guidance/using-openrig.md": "# Using OpenRig\nhub guidance" });
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "codex", cwd: "/project",
      entries: [{
        category: "guidance", effectiveId: "using-openrig.md", mergeStrategy: "managed_block",
        sourceSpec: "base", sourcePath: "/agents/base",
        resourcePath: "guidance/using-openrig.md",
        absolutePath: "/agents/base/guidance/using-openrig.md",
        classification: "safe_projection",
      } as ProjectionEntry],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    await adapter.project(plan, makeBinding());

    const store = (fs as unknown as { _store: Record<string, string> })._store;
    expect(store["/project/AGENTS.md"]).toContain("BEGIN OpenRig MANAGED BLOCK: using-openrig.md");
    expect(store["/project/AGENTS.md"]).toContain("hub guidance");
  });

  it("deliverStartup 跳过 rig-role guidance_merge，且 delivered 不增加（如实指标）", async () => {
    const fs = mockFs({ "/rig/rig-role": "# You are `qa`\nrole body" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: fs });
    const file: ResolvedStartupFile = {
      path: "rig-role", absolutePath: "/rig/rig-role", ownerRoot: "/rig",
      deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start", "restore"],
    };

    const result = await adapter.deliverStartup([file], makeBinding());

    // StartupDeliveryResult 契约：跳过不计为已交付。
    expect(result.delivered).toBe(0);
    expect(result.failed).toEqual([]);
    const store = (fs as unknown as { _store: Record<string, string> })._store;
    expect(store["/project/AGENTS.md"]).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("跳过：effectiveId 为 rig-role")
    );
    logSpy.mockRestore();
  });
});
