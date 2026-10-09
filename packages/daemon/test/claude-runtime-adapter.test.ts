import { describe, it, expect, vi, afterEach } from "vitest";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../src/domain/projection-planner.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { claudePostureFlag } from "../src/adapters/yolo-mode.js";

function mockTmux(): TmuxAdapter {
  return {
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => ""),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
}

function mockFs(files?: Record<string, string>): ClaudeAdapterFsOps {
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

function makeBinding(cwd = "/project"): NodeBinding {
  return {
    id: "b1", nodeId: "n1", tmuxSession: "r01-impl", tmuxWindow: null, tmuxPane: null,
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

// 51-07 A1 —— spec 中声明的逐智能体模型必须进入 claude 启动命令。binding.model 已经从
// resolver 传到 instantiator；这里固定适配器在三种启动构建器中都输出它。红灯优先：
// 三个 --model 测试在 main 上失败（适配器没有模型引用）；字节一致性和姿态测试是变更
// 前后都应保持为绿的不变量。
describe("launchHarness——逐智能体 --model 进入 claude 启动命令（51-07 A1）", () => {
  const MODEL = "claude-haiku-4-5";
  const POSTURE = claudePostureFlag(process.env, undefined); // acceptEdits 底线，即姿态固定基线

  const withModel = (model?: string): NodeBinding => ({ ...makeBinding(), model } as NodeBinding);
  const adapterWith = (tmux: TmuxAdapter) => new ClaudeCodeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });
  const lastCmd = (tmux: TmuxAdapter): string => {
    const calls = (tmux.sendText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    return (calls[calls.length - 1]?.[1] as string) ?? "";
  };

  it("全新启动在绑定声明模型时输出 --model", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(withModel(MODEL), { name: "seat" });
    expect(lastCmd(tmux)).toContain(`--model '${MODEL}'`);
  });

  it("恢复启动输出 --model", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(withModel(MODEL), { name: "seat", resumeToken: "tok-123" });
    expect(lastCmd(tmux)).toContain(`--model '${MODEL}'`);
  });

  it("分叉启动输出 --model", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(withModel(MODEL), { name: "seat", forkSource: { kind: "native_id", value: "parent-xyz" } });
    expect(lastCmd(tmux)).toContain(`--model '${MODEL}'`);
  });

  // 模型缺失时产生确定性字节，不添加 --model。基线现在默认携带 OPR.0.5.3.1 经典渲染器
  // 前缀，参见下方 scrollback-restore describe。
  it("模型缺失时恢复命令字节完全一致，不添加 --model 且姿态不变", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(withModel(undefined), { name: "seat", resumeToken: "tok-123" });
    expect(lastCmd(tmux)).toBe(`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude ${POSTURE} --resume tok-123 --name seat`);
  });

  // D1 固定项：两个方向上的姿态都保持字节不变；有无模型之间唯一差异是新增
  // ` --model '<x>'`，姿态与其他所有 token 均字节一致。
  it("只添加 --model，姿态与结构保持字节不变", async () => {
    const tmuxNo = mockTmux(); await adapterWith(tmuxNo).launchHarness(withModel(undefined), { name: "seat", resumeToken: "T" });
    const tmuxYes = mockTmux(); await adapterWith(tmuxYes).launchHarness(withModel(MODEL), { name: "seat", resumeToken: "T" });
    const noModel = lastCmd(tmuxNo), withMdl = lastCmd(tmuxYes);
    expect(noModel).toContain(POSTURE);
    expect(withMdl).toContain(POSTURE);
    expect(withMdl.replace(` --model '${MODEL}'`, "")).toBe(noModel);
  });
});

// OPR.0.5.3.1 slice 01 —— Claude 回滚缓冲区恢复。每条受管启动路径默认必须添加
// CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 前缀（经典渲染器 → 原生回滚缓冲区）；显式设置
// OPENRIG_CLAUDE_DISABLE_ALTERNATE_SCREEN=0 时恢复全屏模式，与变更前保持字节一致。
// 红灯优先：默认前缀固定项在 main 上失败，因为适配器不输出前缀。
describe("launchHarness——经典渲染器环境前缀（OPR.0.5.3.1 回滚缓冲区恢复）", () => {
  const POSTURE = claudePostureFlag(process.env, undefined);
  const adapterWith = (tmux: TmuxAdapter) => new ClaudeCodeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });
  const lastCmd = (tmux: TmuxAdapter): string => {
    const calls = (tmux.sendText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    return (calls[calls.length - 1]?.[1] as string) ?? "";
  };
  const PREFIX = "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 ";

  afterEach(() => {
    delete process.env.OPENRIG_CLAUDE_DISABLE_ALTERNATE_SCREEN;
  });

  it("全新启动默认添加经典渲染器前缀", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(makeBinding(), { name: "seat" });
    expect(lastCmd(tmux).startsWith(PREFIX + "claude ")).toBe(true);
  });

  it("恢复启动携带该前缀", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(makeBinding(), { name: "seat", resumeToken: "tok-123" });
    expect(lastCmd(tmux)).toBe(`${PREFIX}claude ${POSTURE} --resume tok-123 --name seat`);
  });

  it("分叉启动携带该前缀", async () => {
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(makeBinding(), { name: "seat", forkSource: { kind: "native_id", value: "parent-xyz" } });
    expect(lastCmd(tmux).startsWith(PREFIX + "claude ")).toBe(true);
  });

  it("覆盖 OPENRIG_CLAUDE_DISABLE_ALTERNATE_SCREEN=0 时省略前缀并与变更前字节一致", async () => {
    process.env.OPENRIG_CLAUDE_DISABLE_ALTERNATE_SCREEN = "0";
    const tmux = mockTmux();
    await adapterWith(tmux).launchHarness(makeBinding(), { name: "seat", resumeToken: "tok-123" });
    expect(lastCmd(tmux)).toBe(`claude ${POSTURE} --resume tok-123 --name seat`);
  });
});

describe("Claude Code 运行时适配器", () => {
  // T1：实现全部四个方法。
  it("实现全部四个方法", () => {
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: mockFs() });
    expect(typeof adapter.listInstalled).toBe("function");
    expect(typeof adapter.project).toBe("function");
    expect(typeof adapter.deliverStartup).toBe("function");
    expect(typeof adapter.checkReady).toBe("function");
    expect(adapter.runtime).toBe("claude-code");
  });

  it("窗格回退到 shell 提示符时 checkReady 返回 false", async () => {
    const tmux = mockTmux();
    (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("zsh");
    (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue("user@example.test rigged %");
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs() });

    const result = await adapter.checkReady(makeBinding());

    expect(result).toEqual({
      ready: false,
      reason: "探测窗格已返回 shell，没有停留在运行时内部。",
      code: "returned_to_shell",
    });
  });

  it("Claude 阻塞在工作区信任提示时 checkReady 返回 false", async () => {
    const tmux = mockTmux();
    (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("claude");
    (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue(
      [
        "Accessing workspace:",
        "/some/workspace",
        "",
        "Quick safety check: Is this a project you created or one you trust?",
        "1. Yes, I trust this folder",
        "2. No, exit",
      ].join("\n")
    );
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs() });

    const result = await adapter.checkReady(makeBinding());

    expect(result).toEqual({
      ready: false,
      reason: "Claude 正等待工作区信任批准，批准后会话才能交互。",
      code: "trust_gate",
    });
  });

  // T3：自动为 .md 启动文件选择 guidance_merge。
  it("自动为 .md 启动文件选择 guidance_merge", async () => {
    const fs = mockFs({ "/rig/startup/guide.md": "# Guide content" });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const file: ResolvedStartupFile = {
      path: "startup/guide.md", absolutePath: "/rig/startup/guide.md", ownerRoot: "/rig",
      deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"],
    };
    const result = await adapter.deliverStartup([file], makeBinding());
    expect(result.delivered).toBe(1);
    const store = (fs as unknown as { _store: Record<string, string> })._store;
    expect(store["/project/CLAUDE.md"]).toContain("Guide content");
  });

  it("交付 openrig-start 指引时替换旧式 using-openrig 受管区块", async () => {
    const fs = mockFs({
      "/rig/openrig-start.md": "# OpenRig Start\n\nNew guidance",
      "/project/CLAUDE.md": [
        "<!-- BEGIN OpenRig MANAGED BLOCK: using-openrig.md -->",
        "# Using OpenRig",
        "Old guidance",
        "<!-- END OpenRig MANAGED BLOCK: using-openrig.md -->",
      ].join("\n"),
    });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
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
    const content = store["/project/CLAUDE.md"]!;
    expect(content).toContain("BEGIN OpenRig MANAGED BLOCK: openrig-start.md");
    expect(content).not.toContain("BEGIN OpenRig MANAGED BLOCK: using-openrig.md");
    expect(content).toContain("New guidance");
  });

  // T4：自动为 SKILL.md 内容选择 skill_install。
  it("自动为 SKILL.md 内容选择 skill_install", async () => {
    const fs = mockFs({ "/rig/skills/deep/SKILL.md": "# SKILL Deep PR Review" });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const file: ResolvedStartupFile = {
      path: "skills/deep/SKILL.md", absolutePath: "/rig/skills/deep/SKILL.md", ownerRoot: "/rig",
      deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"],
    };
    const result = await adapter.deliverStartup([file], makeBinding());
    expect(result.delivered).toBe(1);
  });

  // T5：普通内容自动回退到 send_text。
  it("普通文件自动回退到 send_text", async () => {
    const tmux = mockTmux();
    const fs = mockFs({ "/rig/startup/init.sh": "echo hello" });
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: fs, sleep: async () => {} });
    const file: ResolvedStartupFile = {
      path: "startup/init.sh", absolutePath: "/rig/startup/init.sh", ownerRoot: "/rig",
      deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"],
    };
    await adapter.deliverStartup([file], makeBinding());
    expect(tmux.sendText).toHaveBeenCalledWith("r01-impl", "echo hello");
    expect(tmux.sendKeys).toHaveBeenCalledWith("r01-impl", ["C-m"]);
  });

  // OPR.0.3.3.16：大于 100KB 的 send_text 启动包仍必须原样经过
  // sendText → sleep → sendKeys(["C-m"]) 序列。大载荷缓冲机制位于 TmuxAdapter；
  // 适配器负责把完整内容交给 sendText，并只在末尾提交一次。
  it("通过 sendText 交付大于 100KB 的 send_text 启动文件，随后用 C-m 提交", async () => {
    const tmux = mockTmux();
    const big = "L".repeat(120 * 1024);
    const fs = mockFs({ "/rig/startup/big-pack.md": big });
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: fs, sleep: async () => {} });
    const file: ResolvedStartupFile = {
      path: "startup/big-pack.md", absolutePath: "/rig/startup/big-pack.md", ownerRoot: "/rig",
      deliveryHint: "send_text", required: true, appliesOn: ["fresh_start", "restore"],
    };

    const result = await adapter.deliverStartup([file], makeBinding());

    expect(result.delivered).toBe(1);
    expect(result.failed).toEqual([]);
    // 完整载荷交给 sendText，TmuxAdapter 会将其路由到缓冲路径。
    expect(tmux.sendText).toHaveBeenCalledWith("r01-impl", big);
    // 保持末尾只提交一次。
    expect(tmux.sendKeys).toHaveBeenCalledWith("r01-impl", ["C-m"]);
  });

  // T6：重复交付保持幂等。
  it("通过哈希检查确保重复投影幂等", async () => {
    const fs = mockFs({
      "/agents/base/skills/test/SKILL.md": "skill content",
      "/project/.claude/skills/test-skill/SKILL.md": "skill content", // same content
    });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "claude-code", cwd: "/project",
      entries: [makeEntry({ absolutePath: "/agents/base/skills/test/SKILL.md" })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };
    const result = await adapter.project(plan, makeBinding());
    // 哈希相同：应视为已投影；复制本身幂等，但仍计数。
    expect(result.failed).toHaveLength(0);
  });

  // T9：投影可处理目录形态的 Skill 资源。
  it("将 Skill 目录投影到 .claude/skills/{id}/", async () => {
    const fs = mockFs({
      "/agents/base/skills/test/SKILL.md": "skill content",
      "/agents/base/skills/test/helper.ts": "export default {}",
    });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "claude-code", cwd: "/project",
      entries: [makeEntry({ absolutePath: "/agents/base/skills/test" })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };
    await adapter.project(plan, makeBinding());
    const store = (fs as unknown as { _store: Record<string, string> })._store;
    expect(store["/project/.claude/skills/test-skill/SKILL.md"]).toBe("skill content");
    expect(store["/project/.claude/skills/test-skill/helper.ts"]).toBe("export default {}");
  });

  // T9b：正确投影文件形态的子智能体。
  it("将文件形态的子智能体投影到 .claude/agents/", async () => {
    const fs = mockFs({ "/agents/base/subagents/reviewer.yaml": "name: reviewer" });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "claude-code", cwd: "/project",
      entries: [makeEntry({ category: "subagent", effectiveId: "reviewer", absolutePath: "/agents/base/subagents/reviewer.yaml", resourcePath: "subagents/reviewer.yaml" })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };
    await adapter.project(plan, makeBinding());
    const store = (fs as unknown as { _store: Record<string, string> })._store;
    expect(store["/project/.claude/agents/reviewer.yaml"]).toBe("name: reviewer");
  });

  it("将 claude_settings_fragment 运行时资源应用到项目本地 Claude 设置", async () => {
    const fs = mockFs({
      "/agents/base/runtime/claude-settings.json": JSON.stringify({
        permissions: {
          defaultMode: "acceptEdits",
          allow: ["Bash(npm:*)"],
          ask: ["Bash(rig up:*)"],
        },
        enabledMcpjsonServers: ["context7"],
      }),
      "/project/.claude/settings.local.json": JSON.stringify({
        customSetting: true,
        permissions: {
          allow: ["Bash(existing:*)"],
          ask: ["Bash(existing-ask:*)"],
        },
        enabledMcpjsonServers: ["existing"],
      }),
    });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "claude-code", cwd: "/project",
      entries: [makeEntry({
        category: "runtime_resource",
        effectiveId: "claude-settings",
        resourceType: "claude_settings_fragment",
        absolutePath: "/agents/base/runtime/claude-settings.json",
        resourcePath: "runtime/claude-settings.json",
      })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    const result = await adapter.project(plan, makeBinding());

    expect(result).toEqual({ projected: ["claude-settings"], skipped: [], failed: [] });
    const store = (fs as unknown as { _store: Record<string, string> })._store;
    const settings = JSON.parse(store["/project/.claude/settings.local.json"]!);
    expect(settings.customSetting).toBe(true);
    expect(settings.permissions.defaultMode).toBe("acceptEdits");
    expect(settings.permissions.allow).toEqual(["Bash(existing:*)", "Bash(npm:*)"]);
    expect(settings.permissions.ask).toEqual(["Bash(existing-ask:*)", "Bash(rig up:*)"]);
    expect(settings.enabledMcpjsonServers).toEqual(["existing", "context7"]);
    expect(store["/project/.claude/extensions/claude-settings/claude-settings.json"]).toBeUndefined();
  });

  it("将 claude_mcp_fragment 运行时资源应用到项目本地 MCP 配置", async () => {
    const fs = mockFs({
      "/agents/base/runtime/claude-mcp.json": JSON.stringify({
        mcpServers: {
          context7: { type: "http", url: "https://mcp.context7.com/mcp" },
        },
      }),
      "/project/.mcp.json": JSON.stringify({
        mcpServers: {
          existing: { type: "http", url: "https://example.com/mcp" },
        },
      }),
    });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "claude-code", cwd: "/project",
      entries: [makeEntry({
        category: "runtime_resource",
        effectiveId: "claude-mcp",
        resourceType: "claude_mcp_fragment",
        absolutePath: "/agents/base/runtime/claude-mcp.json",
        resourcePath: "runtime/claude-mcp.json",
      })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    const result = await adapter.project(plan, makeBinding());

    expect(result).toEqual({ projected: ["claude-mcp"], skipped: [], failed: [] });
    const store = (fs as unknown as { _store: Record<string, string> })._store;
    const mcp = JSON.parse(store["/project/.mcp.json"]!);
    expect(Object.keys(mcp.mcpServers)).toEqual(["existing", "context7"]);
    expect(mcp.mcpServers.existing.url).toBe("https://example.com/mcp");
    expect(mcp.mcpServers.context7.url).toBe("https://mcp.context7.com/mcp");
  });

  it("Claude 运行时设置片段格式错误时如实报告投影失败", async () => {
    const fs = mockFs({ "/agents/base/runtime/claude-settings.json": "[]" });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "claude-code", cwd: "/project",
      entries: [makeEntry({
        category: "runtime_resource",
        effectiveId: "claude-settings",
        resourceType: "claude_settings_fragment",
        absolutePath: "/agents/base/runtime/claude-settings.json",
        resourcePath: "runtime/claude-settings.json",
      })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    const result = await adapter.project(plan, makeBinding());

    expect(result.projected).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.effectiveId).toBe("claude-settings");
    expect(result.failed[0]!.error).toContain("必须是 JSON 对象");
  });

  // NS-T04：launchHarness 测试。
  it("launchHarness 发送正确的全新启动命令", async () => {
    const tmux = mockTmux();
    const adapter = new ClaudeCodeAdapter({
      tmux,
      fsOps: mockFs(),
      sessionIdFactory: () => "11111111-1111-4111-8111-111111111111",
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith(
      "r01-impl",
      "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude --permission-mode acceptEdits --session-id 11111111-1111-4111-8111-111111111111 --name dev-impl@test-rig"
    );
    if (result.ok) {
      expect(result.resumeToken).toBe("11111111-1111-4111-8111-111111111111");
      expect(result.resumeType).toBe("claude_id");
    }
  });

  it("launchHarness 发送带令牌的正确恢复命令", async () => {
    const tmux = mockTmux();
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs() });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig", resumeToken: "abc-123" });

    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    expect(sendText).toHaveBeenCalledWith(
      "r01-impl",
      "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 claude --permission-mode acceptEdits --resume abc-123 --name dev-impl@test-rig"
    );
  });

  it("Claude 报告找不到恢复令牌对应会话时 launchHarness 返回 retry_fresh", async () => {
    const tmux = mockTmux();
    (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("zsh");
    (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue(
      "No conversation found with session ID: abc-123\nuser@example.test %"
    );
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig", resumeToken: "abc-123" });

    expect(result).toEqual({
      ok: false,
      error: "Claude resume 失败：找不到所请求 session 的会话",
      recovery: "retry_fresh",
    });
  });

  it("仅在显式配置时由 launchHarness 自动接受 Claude 工作区信任提示", async () => {
    const tmux = mockTmux();
    (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("claude");
    (tmux.capturePaneContent as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([
        "Accessing workspace:",
        "/project",
        "❯ 1. Yes, I trust this folder",
        "  2. No, exit",
      ].join("\n"))
      .mockResolvedValue([
        "Claude Code v2.1.89",
        "❯ Ready",
      ].join("\n"));
    const adapter = new ClaudeCodeAdapter({
      tmux,
      fsOps: mockFs(),
      sleep: async () => {},
      autoDriveProviderPrompts: true,
    });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig", resumeToken: "abc-123" });

    expect(result).toEqual({
      ok: true,
      resumeToken: "abc-123",
      resumeType: "claude_id",
      appliedLaunch: { runtime: "claude-code", axis: "permission", state: "observed", value: "acceptEdits", reason: "emitted_launch_arguments" },
    });
    expect(tmux.sendKeys).toHaveBeenCalledTimes(2);
    expect(tmux.sendKeys).toHaveBeenNthCalledWith(2, "r01-impl", ["Enter"]);
  });

  it("即使 tmux 报告版本字符串前台命令，launchHarness 也将实时 Claude TUI 视为成功", async () => {
    const tmux = mockTmux();
    (tmux.getPaneCommand as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("zsh")
      .mockResolvedValue("2.1.89");
    (tmux.capturePaneContent as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("")
      .mockResolvedValue(
        [
          "Claude Code v2.1.89",
          "❯ Baseline warmup 4/6 for dev.impl.",
          "────────────────────────────────────────────────────────────────────────────────",
          "  ? for shortcuts                                             ● high · /effort",
        ].join("\n")
      );
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs(), sleep: async () => {} });

    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      resumeToken: "abc-123",
    });

    expect(result).toEqual({
      ok: true,
      resumeToken: "abc-123",
      resumeType: "claude_id",
      appliedLaunch: { runtime: "claude-code", axis: "permission", state: "observed", value: "acceptEdits", reason: "emitted_launch_arguments" },
    });
  });

  it("launchHarness 从会话文件捕获恢复令牌", async () => {
    const tmux = mockTmux();
    const sessionData = JSON.stringify({ pid: 12345, sessionId: "abc-session-id", name: "dev-impl@test-rig" });
    const fs = mockFs({});
    // 添加 readdir 与 homedir 能力。
    const fsWithDir = {
      ...fs,
      readdir: (dir: string) => dir.includes("sessions") ? ["12345.json"] : [],
      homedir: "/mock-home",
      readFile: (p: string) => {
        if (p.includes("12345.json")) return sessionData;
        return fs.readFile(p);
      },
      exists: (p: string) => p.includes("sessions") || fs.exists(p),
    };
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: fsWithDir });

    const result = await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resumeToken).toBe("abc-session-id");
      expect(result.resumeType).toBe("claude_id");
    }
  });

  it("没有绑定 tmux 会话时 launchHarness 返回错误", async () => {
    const tmux = mockTmux();
    const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs() });
    const binding = { ...makeBinding(), tmuxSession: null };

    const result = await adapter.launchHarness(binding, { name: "test" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("未绑定 tmux session");
  });

  // --- Regenerator 缺陷修复：跳过 rig-role 受管区块 ---
  //
  // rig-role 受管区块注入器不考虑席位身份，独立配对 target-file × spec，导致多席位 pod
  // 的 CLAUDE.md 收到错误席位的正文。按照架构 SHAPE 1：区块 ID 为 `rig-role` 时跳过
  // mergeManagedBlock；逐席位交付改走 startup.files 的 send_text 路径。跳过必须记录，
  // 绝不能静默。

  it("projectEntry 跳过 rig-role 指引受管区块，不写入 CLAUDE.md", async () => {
    const fs = mockFs({ "/agents/impl/guidance/role.md": "# You are `impl`\nTDD discipline." });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "claude-code", cwd: "/project",
      entries: [makeEntry({
        category: "guidance", effectiveId: "rig-role", mergeStrategy: "managed_block",
        absolutePath: "/agents/impl/guidance/role.md", resourcePath: "guidance/role.md",
      })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    const result = await adapter.project(plan, makeBinding());

    const store = (fs as unknown as { _store: Record<string, string> })._store;
    expect(store["/project/CLAUDE.md"]).toBeUndefined();
    // ProjectionResult 契约：rig-role 必须出现在 `skipped` 而不是 `projected` 中，否则
    // 适配器会报告并未完成的工作，违反如实检测原则。
    expect(result.skipped).toContain("rig-role");
    expect(result.projected).not.toContain("rig-role");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("跳过：effectiveId 为 rig-role")
    );
    logSpy.mockRestore();
  });

  it("projectEntry 将非 rig-role 指引记入 `projected` 而非 `skipped`（契约回归）", async () => {
    const fs = mockFs({ "/agents/base/guidance/using-openrig.md": "# Using OpenRig\nhub guidance" });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "claude-code", cwd: "/project",
      entries: [makeEntry({
        category: "guidance", effectiveId: "using-openrig.md", mergeStrategy: "managed_block",
        absolutePath: "/agents/base/guidance/using-openrig.md", resourcePath: "guidance/using-openrig.md",
      })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    const result = await adapter.project(plan, makeBinding());

    expect(result.projected).toContain("using-openrig.md");
    expect(result.skipped).not.toContain("using-openrig.md");
  });

  it("projectEntry 仍合并非 rig-role 指引区块（回归）", async () => {
    const fs = mockFs({ "/agents/base/guidance/using-openrig.md": "# Using OpenRig\nhub guidance" });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const plan: ProjectionPlan = {
      runtime: "claude-code", cwd: "/project",
      entries: [makeEntry({
        category: "guidance", effectiveId: "using-openrig.md", mergeStrategy: "managed_block",
        absolutePath: "/agents/base/guidance/using-openrig.md", resourcePath: "guidance/using-openrig.md",
      })],
      startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [],
    };

    await adapter.project(plan, makeBinding());

    const store = (fs as unknown as { _store: Record<string, string> })._store;
    expect(store["/project/CLAUDE.md"]).toContain("BEGIN OpenRig MANAGED BLOCK: using-openrig.md");
    expect(store["/project/CLAUDE.md"]).toContain("hub guidance");
  });

  it("deliverStartup 跳过 rig-role guidance_merge，且 delivered 不增加（如实指标）", async () => {
    const fs = mockFs({ "/rig/rig-role": "# You are `impl`\nrole body" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: fs });
    const file: ResolvedStartupFile = {
      path: "rig-role", absolutePath: "/rig/rig-role", ownerRoot: "/rig",
      deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start", "restore"],
    };

    const result = await adapter.deliverStartup([file], makeBinding());

    // StartupDeliveryResult 契约：跳过不计为已交付，否则 delivered 会偏离实际写入，
    // 违反如实检测原则。
    expect(result.delivered).toBe(0);
    expect(result.failed).toEqual([]);
    const store = (fs as unknown as { _store: Record<string, string> })._store;
    expect(store["/project/CLAUDE.md"]).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("跳过：effectiveId 为 rig-role")
    );
    logSpy.mockRestore();
  });

  // OPR.0.4.8.2 去特定运行时化清理：整个“启动时权限配置：Bash 便利基线配置”区段
  //（7 个 provisionRigPermissions 测试）已移除，写入器（评估 C2）也已删除。替代覆盖位于
  // agnostic-rip-out.test.ts：全新启动不会为权限创建 ~/.claude/settings.json；已有且带
  // 溯源标记的设置文件保持字节不变，不做追溯清理。

  // 清理前的“配置项目本地 Claude hook 且不覆盖已有本地设置或持久化 hook token”测试已在
  // plugin-primitive Phase 3a slice 3.1 中移除；活动 hook 自动注入已删除，
  // provisionActivityHooks 不再存在。替代覆盖位于 activity-hook-rip-proof.test.ts：
  // 不写入 .openrig/activity-hook-relay.cjs；settings.local.json 中没有 OpenRig 注入的 hook；
  // 已有用户自定义 hook 原样保留；源码搜索确认适配器已移除
  // provisionActivityHooks/upsertCommandHook 等实现。
});
