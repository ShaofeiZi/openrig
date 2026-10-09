import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import Database from "better-sqlite3";
import { describe, it, expect, vi } from "vitest";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import { seedCodexThreads } from "./helpers/codex-state.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

function mockTmux(overrides?: Partial<TmuxAdapter>): TmuxAdapter {
  return {
    getPanePid: vi.fn(async () => null),
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => null),
    capturePaneContent: vi.fn(async () => null),
    ...overrides,
  } as unknown as TmuxAdapter;
}

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

describe("ResumeMetadataRefresher 恢复元数据刷新器", () => {
  it("性能修复 2——定期快照刷新对每个 codex 席位仅尝试一次：发现失败时不会突发 8 次重试", async () => {
    const sessionRegistry = {
      updateResumeToken: vi.fn(),
      markResumeProbeResult: vi.fn(),
    } as unknown as SessionRegistry;
    let panePidCalls = 0;
    let sleeps = 0;
    const tmux = mockTmux({ getPanePid: vi.fn(async () => { panePidCalls += 1; return 900; }) });
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: tmux,
      // 窗格存在但没有 codex 后代进程 → 每次发现均失败（突发触发条件）。
      listProcesses: () => [{ pid: 900, ppid: 1, command: "-zsh" }],
      readCodexThreadIdByPid: () => undefined,
      sleep: async () => { sleeps += 1; },
    });

    await refresher.refresh(
      [{ sessionId: "s1", sessionName: "codex@r", runtime: "codex", resumeType: null, resumeToken: null }],
      { fillNullOnly: true },
    );

    // 5 分钟定期快照路径（fillNullOnly）对每个 codex 席位仅尝试一次：一次窗格探测，
    // 即使发现失败也不等待重试——不是修复前的 8 次突发（8 次探测 + 7 次等待）。
    // OPR.0.5.3.10 小需求 2。若定期轮询回归为 8 次循环，这些断言会失败。
    expect(panePidCalls).toBe(1);
    expect(sleeps).toBe(0);
  });

  it("从实时子进程刷新缺失的 Codex 恢复令牌", async () => {
    const sessionRegistry = {
      updateResumeToken: vi.fn(),
    } as unknown as SessionRegistry;
    const tmux = mockTmux({
      getPanePid: vi.fn(async () => 900),
    });
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: tmux,
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "codex" },
      ],
      readCodexThreadIdByPid: (pid) => pid === 901 ? "019d45c3-e909-7152-b52e-34edab4070ed" : undefined,
      sleep: async () => {},
    });

    await refresher.refresh([
      {
        sessionId: "sess-1",
        sessionName: "dev-qa@demo-rig",
        runtime: "codex",
        resumeType: null,
        resumeToken: null,
      },
    ]);

    expect(sessionRegistry.updateResumeToken).toHaveBeenCalledWith(
      "sess-1",
      "codex_id",
      "019d45c3-e909-7152-b52e-34edab4070ed",
      "scrape"
    );
  });

  it("从嵌套包装器到供应商 codex 的进程树刷新缺失的 Codex 恢复令牌", async () => {
    const sessionRegistry = {
      updateResumeToken: vi.fn(),
    } as unknown as SessionRegistry;
    const tmux = mockTmux({
      getPanePid: vi.fn(async () => 900),
    });
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: tmux,
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "node /opt/homebrew/bin/codex -s workspace-write -C /project" },
        { pid: 902, ppid: 901, command: "/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex/codex -s workspace-write -C /project" },
      ],
      readCodexThreadIdByPid: (pid) => pid === 902 ? "019d45c3-e909-7152-b52e-34edab4070ed" : undefined,
      sleep: async () => {},
    });

    await refresher.refresh([
      {
        sessionId: "sess-1",
        sessionName: "dev-qa@demo-rig",
        runtime: "codex",
        resumeType: null,
        resumeToken: null,
      },
    ]);

    expect(sessionRegistry.updateResumeToken).toHaveBeenCalledWith(
      "sess-1",
      "codex_id",
      "019d45c3-e909-7152-b52e-34edab4070ed",
      "scrape"
    );
  });

  it("从子进程主目录刷新缺失的 Codex 恢复令牌", async () => {
    const tempRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rigged-codex-refresh-"));
    const actualHome = nodePath.join(tempRoot, "actual-home");
    createCodexLogsDb(actualHome, 901, "019d45c3-e909-7152-b52e-34edab4070ed");

    const sessionRegistry = {
      updateResumeToken: vi.fn(),
    } as unknown as SessionRegistry;
    const tmux = mockTmux({
      getPanePid: vi.fn(async () => 900),
    });
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: tmux,
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "codex" },
      ],
      resolveHomeDirByPid: (pid) => pid === 901 ? actualHome : undefined,
      homeDir: "/wrong-home",
      sleep: async () => {},
    });

    await refresher.refresh([
      {
        sessionId: "sess-1",
        sessionName: "dev-qa@demo-rig",
        runtime: "codex",
        resumeType: null,
        resumeToken: null,
      },
    ]);

    expect(sessionRegistry.updateResumeToken).toHaveBeenCalledWith(
      "sess-1",
      "codex_id",
      "019d45c3-e909-7152-b52e-34edab4070ed",
      "scrape"
    );
  });

  it("从当前版本化日志数据库刷新缺失的 Codex 恢复令牌", async () => {
    const tempRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rigged-codex-refresh-"));
    const actualHome = nodePath.join(tempRoot, "actual-home");
    createCodexLogsDb(actualHome, 901, "019d45c3-e909-7152-b52e-34edab4070ed", "logs_2.sqlite");

    const sessionRegistry = {
      updateResumeToken: vi.fn(),
    } as unknown as SessionRegistry;
    const tmux = mockTmux({
      getPanePid: vi.fn(async () => 900),
    });
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: tmux,
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "codex" },
      ],
      resolveHomeDirByPid: (pid) => pid === 901 ? actualHome : undefined,
      homeDir: "/wrong-home",
      sleep: async () => {},
    });

    await refresher.refresh([
      {
        sessionId: "sess-1",
        sessionName: "dev-qa@demo-rig",
        runtime: "codex",
        resumeType: null,
        resumeToken: null,
      },
    ]);

    expect(sessionRegistry.updateResumeToken).toHaveBeenCalledWith(
      "sess-1",
      "codex_id",
      "019d45c3-e909-7152-b52e-34edab4070ed",
      "scrape"
    );
  });

  it("跳过已有恢复令牌的会话", async () => {
    const sessionRegistry = {
      updateResumeToken: vi.fn(),
      clearResumeToken: vi.fn(),
    } as unknown as SessionRegistry;
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      sleep: async () => {},
    });

    await refresher.refresh([
      {
        sessionId: "sess-1",
        sessionName: "dev-qa@demo-rig",
        runtime: "codex",
        resumeType: "codex_id",
        resumeToken: "existing-token",
      },
    ]);

    expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
  });

  // OPR.0.4.6.02 S1 排除项——临时原生恢复探测会话（`rigged-refresh-*`）不是真实的
  // 操作员/智能体席位，因此绝不能接收 tmux 默认选项。刷新器有意不连接共享应用器；
  // 此测试固定刷新路径在整个运行期间不调用任何 tmux 选项设置器
  //（mouse/status/set-clipboard/copy-command）。
  it("排除项：探测/刷新路径绝不应用 tmux 默认选项", async () => {
    const sessionRegistry = {
      updateResumeToken: vi.fn(),
      clearResumeToken: vi.fn(),
      markResumeProbeResult: vi.fn(),
    } as unknown as SessionRegistry;
    const setSessionOption = vi.fn(async () => ({ ok: true as const }));
    const setServerOption = vi.fn(async () => ({ ok: true as const }));
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: mockTmux({ setSessionOption, setServerOption } as Partial<TmuxAdapter>),
      // 使用确定性探测结论来覆盖刷新路径，避免脆弱的实时原生探测；排除项关注的是选项设置器。
      probeClaudeResume: async () => "not_resumable" as const,
      sleep: async () => {},
    });

    await refresher.refresh([
      {
        sessionId: "sess-1",
        sessionName: "dev-design@demo-rig",
        runtime: "claude-code",
        resumeType: "claude_native",
        resumeToken: "abc-123",
      },
    ]);

    expect(setSessionOption).not.toHaveBeenCalled();
    expect(setServerOption).not.toHaveBeenCalled();
  });

  // OPR.0.4.3.20 FR-6 §2.1b——默认（拆除/旧版）校验路径现在标记为 STALE，而不是
  // 清除：存在但无法恢复的令牌会保留在账本中。
  it("将不可恢复的 Claude 令牌标记为 STALE 且不清除（FR-6 §2.1b）", async () => {
    const sessionRegistry = {
      updateResumeToken: vi.fn(),
      clearResumeToken: vi.fn(),
      markResumeProbeResult: vi.fn(),
    } as unknown as SessionRegistry;
    const probeClaudeResume = vi.fn(async () => "not_resumable" as const);
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      probeClaudeResume,
      sleep: async () => {},
    });

    await refresher.refresh([
      {
        sessionId: "sess-1",
        sessionName: "dev-design@demo-rig",
        runtime: "claude-code",
        resumeType: "claude_id",
        resumeToken: "abc-123",
        cwd: "/repo",
      },
    ]);

    expect(probeClaudeResume).toHaveBeenCalledWith("dev-design@demo-rig", "abc-123", "/repo");
    expect(sessionRegistry.markResumeProbeResult).toHaveBeenCalledWith("sess-1", "not_resumable");
    expect(sessionRegistry.clearResumeToken).not.toHaveBeenCalled(); // token SURVIVES for FR-6 to surface
    expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
  });

  it("为通过校验路径验证可恢复的 Claude 令牌记录时间（FR-6 §2.1b）", async () => {
    const sessionRegistry = {
      updateResumeToken: vi.fn(),
      clearResumeToken: vi.fn(),
      markResumeProbeResult: vi.fn(),
    } as unknown as SessionRegistry;
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      probeClaudeResume: async () => "resumable" as const,
      sleep: async () => {},
    });
    await refresher.refresh([
      { sessionId: "sess-1", sessionName: "dev-design@demo-rig", runtime: "claude-code", resumeType: "claude_id", resumeToken: "abc-123", cwd: "/repo" },
    ]);
    expect(sessionRegistry.markResumeProbeResult).toHaveBeenCalledWith("sess-1", "resumable");
    expect(sessionRegistry.clearResumeToken).not.toHaveBeenCalled();
  });

  // OPR.0.4.3.20 FR-4——快照刷新期间从 Claude sidecar 填充空值。
  it("FR-4：从 sidecar session_id（抓取）填充空的 Claude 令牌", async () => {
    const sessionRegistry = { updateResumeToken: vi.fn(), clearResumeToken: vi.fn() } as unknown as SessionRegistry;
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      contextUsageStore: { readSidecar: () => ({ ok: true as const, data: { session_id: "claude-uuid-xyz" } }) },
    });
    await refresher.refresh([
      { sessionId: "sess-c", sessionName: "seat@rig", runtime: "claude-code", resumeType: null, resumeToken: null },
    ]);
    expect(sessionRegistry.updateResumeToken).toHaveBeenCalledWith("sess-c", "claude_id", "claude-uuid-xyz", "scrape");
  });

  it("FR-4：sidecar 缺失或解析错误时 Claude 令牌保持 null（不写入、不抛错）", async () => {
    const sessionRegistry = { updateResumeToken: vi.fn(), clearResumeToken: vi.fn() } as unknown as SessionRegistry;
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      contextUsageStore: { readSidecar: () => ({ ok: false as const, reason: "missing_sidecar" }) },
    });
    await refresher.refresh([
      { sessionId: "sess-c", sessionName: "seat@rig", runtime: "claude-code", resumeType: null, resumeToken: null },
    ]);
    expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
  });

  it("FR-4：不写入空的 sidecar session_id（如实为 null）", async () => {
    const sessionRegistry = { updateResumeToken: vi.fn(), clearResumeToken: vi.fn() } as unknown as SessionRegistry;
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      contextUsageStore: { readSidecar: () => ({ ok: true as const, data: { session_id: "   " } }) },
    });
    await refresher.refresh([
      { sessionId: "sess-c", sessionName: "seat@rig", runtime: "claude-code", resumeType: null, resumeToken: null },
    ]);
    expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
  });

  it("FR-4：校验已有令牌的 Claude 会话，而不是从 sidecar 填充", async () => {
    const sessionRegistry = { updateResumeToken: vi.fn(), clearResumeToken: vi.fn(), markResumeProbeResult: vi.fn() } as unknown as SessionRegistry;
    const readSidecar = vi.fn(() => ({ ok: true as const, data: { session_id: "should-not-be-used" } }));
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      contextUsageStore: { readSidecar },
      probeClaudeResume: async () => "resumable",
    });
    await refresher.refresh([
      { sessionId: "sess-c", sessionName: "seat@rig", runtime: "claude-code", resumeType: "claude_id", resumeToken: "existing-tok" },
    ]);
    expect(readSidecar).not.toHaveBeenCalled(); // present token → validate branch, no null-fill
    expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
  });

  it("FR-4：未接入 contextUsageStore → Claude 空值填充静默不操作（向后兼容）", async () => {
    const sessionRegistry = { updateResumeToken: vi.fn(), clearResumeToken: vi.fn() } as unknown as SessionRegistry;
    const refresher = new ResumeMetadataRefresher({ sessionRegistry, tmuxAdapter: mockTmux() });
    await refresher.refresh([
      { sessionId: "sess-c", sessionName: "seat@rig", runtime: "claude-code", resumeType: null, resumeToken: null },
    ]);
    expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
  });

  // OPR.0.4.3.20 FR-4（rev1 修复）——定期快照刷新模式：只填充空值，绝不清除
  // 已有令牌（rev1-r2），绝不创建 `claude --resume` 探针（rev1-r1）。
  it("FR-4 rev1：fillNullOnly 绝不清除已有 Claude 令牌，也绝不创建恢复探针", async () => {
    const sessionRegistry = { updateResumeToken: vi.fn(), clearResumeToken: vi.fn() } as unknown as SessionRegistry;
    // 探针会返回 not_resumable——默认路径会清除；fillNullOnly 连调用它都不允许。
    const probeClaudeResume = vi.fn(async () => "not_resumable" as const);
    const readSidecar = vi.fn(() => ({ ok: true as const, data: { session_id: "unused" } }));
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      probeClaudeResume,
      contextUsageStore: { readSidecar },
      sleep: async () => {},
    });
    await refresher.refresh([
      { sessionId: "sess-1", sessionName: "dev-design@demo-rig", runtime: "claude-code", resumeType: "claude_id", resumeToken: "present-tok", cwd: "/repo" },
    ], { fillNullOnly: true });
    expect(probeClaudeResume).not.toHaveBeenCalled();                // rev1-r1: no `claude --resume` spawn on the recurring path
    expect(sessionRegistry.clearResumeToken).not.toHaveBeenCalled(); // rev1-r2: present-but-not-resumable token SURVIVES for FR-6
    expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
    // OPR.0.4.3.20 FR-6.1——现在会重新推导已有令牌（纯 sidecar 读取），以检查等值
    // 新鲜度。这里的推导值 "unused" 与存储令牌 "present-tok" 不匹配，因此不重新
    // 记录时间——即使执行重新推导，FR-4 不变量（不探测、不清除、不覆盖）仍成立。
    expect(readSidecar).toHaveBeenCalled();
  });

  it("FR-4 rev1：fillNullOnly 仍从 sidecar 填充空的 Claude 令牌（轻量、无探针）", async () => {
    const sessionRegistry = { updateResumeToken: vi.fn(), clearResumeToken: vi.fn() } as unknown as SessionRegistry;
    const probeClaudeResume = vi.fn(async () => "resumable" as const);
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      probeClaudeResume,
      contextUsageStore: { readSidecar: () => ({ ok: true as const, data: { session_id: "claude-uuid-xyz" } }) },
      sleep: async () => {},
    });
    await refresher.refresh([
      { sessionId: "sess-c", sessionName: "seat@rig", runtime: "claude-code", resumeType: null, resumeToken: null },
    ], { fillNullOnly: true });
    expect(sessionRegistry.updateResumeToken).toHaveBeenCalledWith("sess-c", "claude_id", "claude-uuid-xyz", "scrape");
    expect(probeClaudeResume).not.toHaveBeenCalled();                // still no probe — null-fill is a pure sidecar read
  });

  it("FR-4 rev1：fillNullOnly 仍通过 captureCodexThreadId 填充空的 Codex 令牌（轻量 PID 日志读取）", async () => {
    const sessionRegistry = { updateResumeToken: vi.fn(), clearResumeToken: vi.fn() } as unknown as SessionRegistry;
    const tmux = mockTmux({ getPanePid: vi.fn(async () => 900) });
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: tmux,
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "codex" },
      ],
      readCodexThreadIdByPid: (pid) => pid === 901 ? "019d45c3-e909-7152-b52e-34edab4070ed" : undefined,
      sleep: async () => {},
    });
    await refresher.refresh([
      { sessionId: "sess-x", sessionName: "dev-qa@demo-rig", runtime: "codex", resumeType: null, resumeToken: null },
    ], { fillNullOnly: true });
    expect(sessionRegistry.updateResumeToken).toHaveBeenCalledWith("sess-x", "codex_id", "019d45c3-e909-7152-b52e-34edab4070ed", "scrape");
  });

  // OPR.0.4.3.20 FR-6.1——定期为存在且有效的令牌重新记录新鲜度。等值纯读取推导 →
  // markResumeProbeResult("resumable")；不同/缺失 → 不操作（不重新记录、不覆盖）；
  // fillNullOnly 路径不探测/创建进程。
  describe("FR-6.1 定期重新记录新鲜度", () => {
    it("Codex 已有令牌 + 等值推导 → 通过 markResumeProbeResult('resumable') 重新记录新鲜度且不覆盖", async () => {
      const sessionRegistry = { updateResumeToken: vi.fn(), markResumeProbeResult: vi.fn() } as unknown as SessionRegistry;
      const refresher = new ResumeMetadataRefresher({
        sessionRegistry,
        tmuxAdapter: mockTmux({ getPanePid: vi.fn(async () => 900) }),
        listProcesses: () => [{ pid: 900, ppid: 1, command: "-zsh" }, { pid: 901, ppid: 900, command: "codex" }],
        readCodexThreadIdByPid: (pid) => (pid === 901 ? "codex-tok-A" : undefined),
        sleep: async () => {},
      });
      await refresher.refresh([
        { sessionId: "sess-1", sessionName: "dev-qa@demo-rig", runtime: "codex", resumeType: null, resumeToken: "codex-tok-A" },
      ], { fillNullOnly: true });
      expect(sessionRegistry.markResumeProbeResult).toHaveBeenCalledWith("sess-1", "resumable");
      expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled(); // freshness-only, never re-writes the token
    });

    it("Codex 已有令牌 + 不同推导值 → 不重新记录、不覆盖（保持如实）", async () => {
      const sessionRegistry = { updateResumeToken: vi.fn(), markResumeProbeResult: vi.fn() } as unknown as SessionRegistry;
      const refresher = new ResumeMetadataRefresher({
        sessionRegistry,
        tmuxAdapter: mockTmux({ getPanePid: vi.fn(async () => 900) }),
        listProcesses: () => [{ pid: 900, ppid: 1, command: "-zsh" }, { pid: 901, ppid: 900, command: "codex" }],
        readCodexThreadIdByPid: (pid) => (pid === 901 ? "codex-tok-B" : undefined), // rolled/changed
        sleep: async () => {},
      });
      await refresher.refresh([
        { sessionId: "sess-1", sessionName: "dev-qa@demo-rig", runtime: "codex", resumeType: null, resumeToken: "codex-tok-A" },
      ], { fillNullOnly: true });
      expect(sessionRegistry.markResumeProbeResult).not.toHaveBeenCalled();
      expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
    });

    it("Codex 已有令牌 + 无推导值（无窗格 PID）→ 不操作", async () => {
      const sessionRegistry = { updateResumeToken: vi.fn(), markResumeProbeResult: vi.fn() } as unknown as SessionRegistry;
      const refresher = new ResumeMetadataRefresher({
        sessionRegistry,
        tmuxAdapter: mockTmux({ getPanePid: vi.fn(async () => null) }),
        listProcesses: () => [],
        readCodexThreadIdByPid: () => undefined,
        sleep: async () => {},
      });
      await refresher.refresh([
        { sessionId: "sess-1", sessionName: "dev-qa@demo-rig", runtime: "codex", resumeType: null, resumeToken: "codex-tok-A" },
      ], { fillNullOnly: true });
      expect(sessionRegistry.markResumeProbeResult).not.toHaveBeenCalled();
      expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
    });

    it("Claude 已有令牌 + sidecar 等值推导 → 重新记录新鲜度、不探测、不覆盖", async () => {
      const sessionRegistry = { updateResumeToken: vi.fn(), markResumeProbeResult: vi.fn() } as unknown as SessionRegistry;
      const probeClaudeResume = vi.fn(async () => "resumable" as const);
      const refresher = new ResumeMetadataRefresher({
        sessionRegistry,
        tmuxAdapter: mockTmux(),
        contextUsageStore: { readSidecar: () => ({ ok: true as const, data: { session_id: "claude-tok-A" } }) },
        probeClaudeResume,
        sleep: async () => {},
      });
      await refresher.refresh([
        { sessionId: "sess-c", sessionName: "dev-design@demo-rig", runtime: "claude-code", resumeType: null, resumeToken: "claude-tok-A", cwd: "/repo" },
      ], { fillNullOnly: true });
      expect(sessionRegistry.markResumeProbeResult).toHaveBeenCalledWith("sess-c", "resumable");
      expect(probeClaudeResume).not.toHaveBeenCalled(); // NO heavyweight claude --resume on the periodic path
      expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
    });

    it("Claude 已有令牌 + sidecar 推导值不同 → 不重新记录、不探测、不覆盖", async () => {
      const sessionRegistry = { updateResumeToken: vi.fn(), markResumeProbeResult: vi.fn() } as unknown as SessionRegistry;
      const probeClaudeResume = vi.fn(async () => "resumable" as const);
      const refresher = new ResumeMetadataRefresher({
        sessionRegistry,
        tmuxAdapter: mockTmux(),
        contextUsageStore: { readSidecar: () => ({ ok: true as const, data: { session_id: "claude-tok-B" } }) },
        probeClaudeResume,
        sleep: async () => {},
      });
      await refresher.refresh([
        { sessionId: "sess-c", sessionName: "dev-design@demo-rig", runtime: "claude-code", resumeType: null, resumeToken: "claude-tok-A", cwd: "/repo" },
      ], { fillNullOnly: true });
      expect(sessionRegistry.markResumeProbeResult).not.toHaveBeenCalled();
      expect(probeClaudeResume).not.toHaveBeenCalled();
      expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
    });

    it("Claude 已有令牌 + sidecar 不可读（解析错误/非 ok）→ 不操作、不探测", async () => {
      const sessionRegistry = { updateResumeToken: vi.fn(), markResumeProbeResult: vi.fn() } as unknown as SessionRegistry;
      const probeClaudeResume = vi.fn(async () => "resumable" as const);
      const refresher = new ResumeMetadataRefresher({
        sessionRegistry,
        tmuxAdapter: mockTmux(),
        contextUsageStore: { readSidecar: () => ({ ok: false as const, reason: "missing" }) },
        probeClaudeResume,
        sleep: async () => {},
      });
      await refresher.refresh([
        { sessionId: "sess-c", sessionName: "dev-design@demo-rig", runtime: "claude-code", resumeType: null, resumeToken: "claude-tok-A", cwd: "/repo" },
      ], { fillNullOnly: true });
      expect(sessionRegistry.markResumeProbeResult).not.toHaveBeenCalled();
      expect(probeClaudeResume).not.toHaveBeenCalled();
      expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
    });
  });
});
