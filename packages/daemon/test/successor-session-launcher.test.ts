import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { SuccessorSessionLauncher } from "../src/domain/successor-session-launcher.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxOptionDefaultsApplier } from "../src/domain/tmux-option-defaults.js";

describe("SuccessorSessionLauncher", () => {
  let db: Database.Database;
  let discoveryRepo: DiscoveryRepository;
  let createSession: ReturnType<typeof vi.fn>;
  let listPanes: ReturnType<typeof vi.fn>;
  let killSession: ReturnType<typeof vi.fn>;
  let respawnPane: ReturnType<typeof vi.fn>;
  let setRemainOnExit: ReturnType<typeof vi.fn>;
  let signalPaneProcess: ReturnType<typeof vi.fn>;
  let isPaneDead: ReturnType<typeof vi.fn>;
  let launchHarness: ReturnType<typeof vi.fn>;
  let checkReady: ReturnType<typeof vi.fn>;
  let getDefaultShell: ReturnType<typeof vi.fn>;
  let getPaneCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createFullTestDb();
    discoveryRepo = new DiscoveryRepository(db);
    createSession = vi.fn(async () => ({ ok: true }));
    listPanes = vi.fn(async () => [{ id: "%7", index: 0, cwd: "/w", width: 80, height: 24, active: true }]);
    killSession = vi.fn(async () => ({ ok: true }));
    respawnPane = vi.fn(async () => ({ ok: true }));
    setRemainOnExit = vi.fn(async () => ({ ok: true }));
    signalPaneProcess = vi.fn(async () => ({ ok: true }));
    // KI-14：默认 = healthy pane；respawn 后的 pane 以空白 shell 启动。
    getDefaultShell = vi.fn(async () => "/bin/zsh");
    getPaneCommand = vi.fn(async () => "zsh");
    // Cutover：默认 = retiree 优雅退出（SIGTERM 后立即死亡），因此无需强制 fallback。
    isPaneDead = vi.fn(async () => true);
    // 通过 runtime adapter（launchHarness + readiness）启动 live successor，而不是停留在裸 shell。
    // 默认 mock：启动为 ready，并带抓取的 resume token。
    launchHarness = vi.fn(async () => ({ ok: true, resumeToken: "codex-thread-xyz", resumeType: "codex_id" }));
    checkReady = vi.fn(async () => ({ ready: true }));
  });

  afterEach(() => db.close());

  function fakeAdapter(runtime: string): RuntimeAdapter {
    return { runtime, launchHarness, checkReady } as unknown as RuntimeAdapter;
  }

  function launcher(tmuxOptionDefaults?: TmuxOptionDefaultsApplier): SuccessorSessionLauncher {
    const tmux = { createSession, listPanes, killSession, respawnPane, setRemainOnExit, signalPaneProcess, isPaneDead, getDefaultShell, getPaneCommand } as unknown as TmuxAdapter;
    return new SuccessorSessionLauncher(tmux, discoveryRepo, {
      sessionEnv: { OPENRIG_HOME: "/home", HOME: "/daemon-home", CODEX_HOME: "/daemon-codex" },
      newId: () => "01ABCDEFG",
      runtimeAdapters: { codex: fakeAdapter("codex") },
      readinessTimeoutMs: 50,
      sleep: async () => {},
      exitPollMs: 1,
      exitTimeoutMs: 5,
      tmuxOptionDefaults,
    });
  }

  it("关键证明（0.5.2-07）：successor 启动 binding 携带 SPEC 锁定的 model，而非 runtime 默认值", async () => {
    // 低成本启动 → handover → successor 启动必须携带 spec model。adapter 从 binding.model 生成
    // -m/--model（51-07 A1）；这锁定 handover 会将 spec model 传给它。缺失意味着 founder 设计的
    // 拓扑在每次 handover 时静默偏离 spec。
    listPanes.mockResolvedValue([{ id: "%42", index: 0, cwd: "/w", width: 80, height: 24, active: true }]);
    const res = await launcher().createSuccessor({
      node: { id: "node-1", runtime: "codex", cwd: "/w", model: "gpt-5.4-cheap" },
      departingSessionName: "dev-impl@rig",
    });
    expect(res.ok).toBe(true);
    expect(launchHarness).toHaveBeenCalledTimes(1);
    const binding = launchHarness.mock.calls[0]![0] as { model?: string };
    expect(binding.model).toBe("gpt-5.4-cheap");
  });

  it("CUTOVER：终止 retiree，再 respawn（无 -k）到离任 pane（保留名称和 pane id）", async () => {
    // 一个 SEAT = 一个持久 tmux session；successor 接管 retiree 的同一 pane，使原生 scrollback
    // 保留。先原地终止 retiree（remain-on-exit → 优雅 SIGTERM），再用不带 -k 的 respawn-pane 复用
    // 死亡 pane（respawn -k 会清除 scrollback）。不新建 session，也不进行 -h 调换：保留 canonical
    // session 名，pane id 不变。
    listPanes.mockResolvedValue([{ id: "%42", index: 0, cwd: "/w", width: 80, height: 24, active: true }]);

    const res = await launcher().createSuccessor({
      node: { id: "node-1", runtime: "codex", cwd: "/w" },
      departingSessionName: "dev-impl@rig",
    });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");

    // 不新建 session——原地复用 retiree pane。
    expect(createSession).not.toHaveBeenCalled();
    // 先解析离任 session 的 pane（用于接管），再原地 respawn。
    expect(listPanes).toHaveBeenCalledWith("dev-impl@rig");
    expect(respawnPane).toHaveBeenCalledTimes(1);
    const [paneTarget, command, opts] = respawnPane.mock.calls[0]!;
    expect(paneTarget).toBe("%42");
    // KI-14：显式空白 shell——undefined 命令会重新运行 pane 创建命令；adopted pane 上该命令是
    // 完整的 `codex … resume <old-token>` 调用。
    expect(command).toBe("/bin/zsh");
    expect(opts).toMatchObject({ cwd: "/w" });
    // Identity env 携带保留的 canonical session 名（绝非 -h successor 名）和后台服务 session env
    //（像已启动 seat 一样自我识别并报告活动）。
    expect(opts.env).toMatchObject({
      OPENRIG_NODE_ID: "node-1",
      OPENRIG_SESSION_NAME: "dev-impl@rig",
      OPENRIG_RUNTIME: "codex",
      OPENRIG_HOME: "/home",
      HOME: "/daemon-home",
      CODEX_HOME: "/daemon-codex",
    });

    // respawn 前原地终止 retiree：设置 remain-on-exit，再优雅 SIGTERM；pane 在首次 probe 时即死亡，
    // 因此不执行强制 KILL。只有 pane 死亡后才 respawn。
    expect(setRemainOnExit).toHaveBeenCalledWith("%42", true);
    expect(signalPaneProcess).toHaveBeenCalledWith("%42", "TERM");
    expect(signalPaneProcess).not.toHaveBeenCalledWith("%42", "KILL");
    expect(setRemainOnExit.mock.invocationCallOrder[0]!).toBeLessThan(signalPaneProcess.mock.invocationCallOrder[0]!);
    expect(respawnPane.mock.invocationCallOrder[0]!).toBeGreaterThan(signalPaneProcess.mock.invocationCallOrder[0]!);

    // launchHarness 将 harness 驱动到同一保留 session/pane；运行 readiness；捕获并返回启动 resume
    // token（由 composer 在 commit 时持久化，绝不在此处）。
    expect(launchHarness).toHaveBeenCalledTimes(1);
    const [binding, launchOpts] = launchHarness.mock.calls[0]!;
    expect(binding).toMatchObject({ tmuxSession: "dev-impl@rig", tmuxPane: "%42", cwd: "/w" });
    expect(launchOpts).toMatchObject({ name: "dev-impl@rig" });
    expect(checkReady).toHaveBeenCalled();
    expect(res.resumeToken).toBe("codex-thread-xyz");
    expect(res.resumeType).toBe("codex_id");
    expect(res.tmuxSession).toBe("dev-impl@rig");
    expect(res.tmuxPane).toBe("%42");
    // 顺序：解析离任 pane → 终止 → 原地 respawn → 向其中启动 harness。
    expect(respawnPane.mock.invocationCallOrder[0]!).toBeGreaterThan(listPanes.mock.invocationCallOrder[0]!);
    expect(launchHarness.mock.invocationCallOrder[0]!).toBeGreaterThan(respawnPane.mock.invocationCallOrder[0]!);

    // 以保留名称记录为 active、未受管的 discovery candidate（commit 会 rebind 到它）；此处不创建
    // binding/session 行，commit 是唯一 rebind。
    const row = discoveryRepo.getDiscoveredSession(res.discoveredId);
    expect(row).toMatchObject({ tmuxSession: "dev-impl@rig", tmuxPane: "%42", status: "active", claimedNodeId: null });
    expect(db.prepare("SELECT COUNT(*) AS n FROM bindings").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 0 });
  });

  it("精确携带提供的 generation，绝不允许 ambient session env 覆盖它", async () => {
    const tmux = { createSession, listPanes, killSession, respawnPane, setRemainOnExit, signalPaneProcess, isPaneDead, getDefaultShell, getPaneCommand } as unknown as TmuxAdapter;
    const subject = new SuccessorSessionLauncher(tmux, discoveryRepo, {
      sessionEnv: { OPENRIG_OCCUPANT_GENERATION: "stale-ambient-generation" },
      newId: () => "01ABCDEFG",
      runtimeAdapters: { codex: fakeAdapter("codex") },
      readinessTimeoutMs: 50,
      sleep: async () => {},
      exitPollMs: 1,
      exitTimeoutMs: 5,
    });

    const result = await subject.createSuccessor({
      node: { id: "node-1", runtime: "codex", cwd: "/w" },
      departingSessionName: "dev-impl@rig",
      occupantGeneration: "reserved-generation",
    });

    expect(result.ok).toBe(true);
    expect(respawnPane.mock.calls[0]![2]!.env.OPENRIG_OCCUPANT_GENERATION).toBe("reserved-generation");
  });

  it("CUTOVER 强制 fallback：retiree 在优雅 SIGTERM 后仍存活 → 有界 SIGKILL，再 respawn", async () => {
    listPanes.mockResolvedValue([{ id: "%42", index: 0, cwd: "/w", width: 80, height: 24, active: true }]);
    // pane 在 graceful 窗口内保持 live；只有强制 KILL 才使其死亡。
    let killed = false;
    signalPaneProcess.mockImplementation(async (_p: string, sig: string) => { if (sig === "KILL") killed = true; return { ok: true }; });
    isPaneDead.mockImplementation(async () => killed);

    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "dev-impl@rig" });

    expect(res.ok).toBe(true);
    expect(signalPaneProcess).toHaveBeenCalledWith("%42", "TERM");
    expect(signalPaneProcess).toHaveBeenCalledWith("%42", "KILL"); // graceful failed → forced fallback
    expect(respawnPane).toHaveBeenCalledTimes(1); // respawn only after the pane died (post-KILL)
    expect(launchHarness).toHaveBeenCalledTimes(1);
  });

  it("retiree 始终不退出（TERM 和 KILL 后仍存活）→ 结构化 retiree_not_terminated，不 respawn（绝不破坏 live retiree）", async () => {
    isPaneDead.mockResolvedValue(false); // never becomes dead
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "create_successor", code: "retiree_not_terminated" });
    expect(signalPaneProcess).toHaveBeenCalledWith("%7", "TERM");
    expect(signalPaneProcess).toHaveBeenCalledWith("%7", "KILL");
    // pane 始终未死亡 → 绝不 respawn（覆盖 live retiree 会失败/破坏），也绝不启动。
    expect(respawnPane).not.toHaveBeenCalled();
    expect(launchHarness).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("process/pane 事实无法证明 cutover 时保留结构化 tmux 失败", async () => {
    setRemainOnExit.mockResolvedValue({ ok: false, code: "option_failed", message: "remain rejected" });
    signalPaneProcess.mockImplementation(async (_pane: string, signal: string) => ({
      ok: false,
      code: "signal_failed",
      message: `${signal} rejected`,
    }));
    isPaneDead.mockResolvedValue(false);

    const result = await launcher().createSuccessor({
      node: { id: "n", runtime: "codex", cwd: "/w" },
      departingSessionName: "a@r",
    });

    expect(result).toMatchObject({ ok: false, code: "retiree_not_terminated", replacementStarted: false });
    expect((result as { message: string }).message).toContain("remain-on-exit: remain rejected");
    expect((result as { message: string }).message).toContain("TERM: TERM rejected");
    expect((result as { message: string }).message).toContain("KILL: KILL rejected");
  });

  it("remain-on-exit 失败但 TERM 移除 pane 时，在 respawn 前标记 physical replacement", async () => {
    const replacementStarted = vi.fn();
    setRemainOnExit.mockResolvedValue({ ok: false, code: "unknown", message: "option rejected" });
    signalPaneProcess.mockResolvedValue({ ok: true });
    isPaneDead.mockResolvedValue(true); // production adapter: a known-missing pane proves the retiree is gone
    respawnPane.mockResolvedValue({ ok: false, code: "session_not_found", message: "can't find pane" });

    const result = await launcher().createSuccessor({
      node: { id: "n", runtime: "codex", cwd: "/w" },
      departingSessionName: "a@r",
      onReplacementStarted: replacementStarted,
    });

    expect(result).toMatchObject({ ok: false, replacementStarted: true });
    expect(replacementStarted).toHaveBeenCalledTimes(1);
    expect(replacementStarted.mock.invocationCallOrder[0]!).toBeLessThan(respawnPane.mock.invocationCallOrder[0]!);
  });

  it("UNWIND 不变量：successor 启动失败绝不终止 retiree 保留的 session——仍可从 session 文件再次 wake", async () => {
    // 新安全不变量（cutover）：retiree 原地退出，其 provider session 文件是持久 wake target。因此
    // successor 在 respawn 后 launch/readiness 失败时，unwind 不得 killSession 已保留 seat，否则会
    // 破坏可恢复状态；它返回结构化 start_agent 失败，并将可再次 wake 的 shell 留在 pane 中。
    launchHarness.mockResolvedValue({ ok: false, error: "codex binary not found" });

    const res = await launcher().createSuccessor({
      node: { id: "n", runtime: "codex", cwd: "/w" },
      departingSessionName: "dev-impl@rig",
    });

    expect(res).toMatchObject({ ok: false, step: "start_agent", code: "successor_launch_failed" });
    expect((res as { message: string }).message).toContain("codex binary not found");
    // unwind 时绝不终止保留 seat 的 session（retiree 状态保持可恢复）。
    expect(killSession).not.toHaveBeenCalled();
    // 不为失败的 successor 提交 discovery candidate。
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("readiness 超时 → 结构化 start_agent 失败，不终止保留 seat，也无 candidate", async () => {
    checkReady.mockResolvedValue({ ready: false, reason: "harness not interactive" });
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "start_agent", code: "successor_not_ready" });
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("checkReady 抛错（adapter/socket 错误）→ 结构化 start_agent 失败，不终止保留 seat，也无 candidate", async () => {
    // 抛错的 readiness probe 不得以非结构化错误拒绝 createSuccessor；按 cutover 不变量，也不得终止
    // 已保留 seat。
    checkReady.mockRejectedValue(new Error("tmux socket closed"));
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "start_agent", code: "successor_readiness_failed" });
    expect((res as { message: string }).message).toContain("tmux socket closed");
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("readiness 报告 attention_required（auth/trust gate）→ 结构化失败，不终止保留 seat", async () => {
    checkReady.mockResolvedValue({ ready: false, code: "trust_gate", reason: "trust prompt" });
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "start_agent", code: "successor_attention_required" });
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("seat runtime 无 adapter → 结构化失败，不终止保留 seat", async () => {
    const tmux = { createSession, listPanes, killSession, respawnPane, setRemainOnExit, signalPaneProcess, isPaneDead, getDefaultShell, getPaneCommand } as unknown as TmuxAdapter;
    const noAdapter = new SuccessorSessionLauncher(tmux, discoveryRepo, { newId: () => "01ABCDEFG", runtimeAdapters: {}, exitPollMs: 1, exitTimeoutMs: 5 });
    const res = await noAdapter.createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "start_agent", code: "successor_runtime_unsupported" });
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("respawn-pane 失败 → 结构化 create_successor 失败（不 kill，无 candidate）", async () => {
    // 若原地 respawn 本身失败，则不存在 successor；返回结构化 create_successor 错误且不终止 pane，
    // seat 仍可从其 session 文件再次 wake。
    respawnPane.mockResolvedValue({ ok: false, code: "no_server", message: "no server running" });
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: "/w" }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "create_successor", code: "no_server" });
    expect((res as { message: string }).message).toContain("no server running");
    expect(launchHarness).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("没有可解析的离任 pane → 在任何 respawn 前返回结构化 resolve_pane 失败（seat 未触碰）", async () => {
    listPanes.mockResolvedValue([]);
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: null }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "resolve_pane", code: "pane_unresolved" });
    // 未 respawn 或 kill 任何内容——live retiree 完全未触碰。
    expect(respawnPane).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("listPanes 抛错 → 结构化 resolve_pane 失败（不 reject），不 respawn，seat 未触碰", async () => {
    listPanes.mockRejectedValue(new Error("socket permission denied"));
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: null }, departingSessionName: "a@r" });
    expect(res).toMatchObject({ ok: false, step: "resolve_pane", code: "pane_probe_failed" });
    expect((res as { message: string }).message).toContain("socket permission denied");
    expect(respawnPane).not.toHaveBeenCalled();
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.listDiscovered()).toHaveLength(0);
  });

  it("cleanup 将 candidate 标为 vanished，但不终止保留的 session", async () => {
    // Cutover cleanup 展开下游失败（delivery/verify）；但 successor 占用 retiree 保留的 pane，因此
    // cleanup 绝不能 killSession，否则会破坏可恢复 seat。
    const res = await launcher().createSuccessor({ node: { id: "n", runtime: "codex", cwd: null }, departingSessionName: "a@r" });
    if (!res.ok) throw new Error("expected ok");
    await launcher().cleanup(res.tmuxSession, res.discoveredId);
    expect(killSession).not.toHaveBeenCalled();
    expect(discoveryRepo.getDiscoveredSession(res.discoveredId)?.status).toBe("vanished");
  });

  describe("KI-14（5.3 wave-1）：fresh 必须产生经验证的空白 shell，绝非 pane 内嵌命令", () => {
    // 线上缺陷（2026-08-22 重装批次，4 个 Codex seat）：不带命令的 tmux `respawn-pane` 会重新运行
    // pane 的创建命令（或上次 respawn 命令）；adopted/手工恢复 pane 的该命令是
    // `codex … resume <old-token>`，因此“fresh” respawn 会启动旧上下文，而所有下游标签都报告 fresh。
    // 这些 mock 模拟真实 tmux 语义：无命令 respawn → pane 重新运行内嵌 codex resume（foreground
    // 为 "node"，即 codex wrapper）；显式 shell respawn → pane 即该 shell。
    let paneStartCommandRerun: string;
    beforeEach(() => {
      paneStartCommandRerun = "node"; // the baked-in `codex … resume <old>` wrapper
      getDefaultShell.mockResolvedValue("/bin/zsh");
      getPaneCommand.mockImplementation(async () => {
        const call = respawnPane.mock.calls[respawnPane.mock.calls.length - 1];
        const explicit = call?.[1] as string | undefined;
        if (explicit && explicit.length > 0) return explicit.split("/").pop() ?? explicit;
        return paneStartCommandRerun; // tmux re-ran the pane's original command
      });
    });

    it("使用显式默认 shell respawn——绝不传 `undefined`，否则会重跑 pane 创建命令", async () => {
      const res = await launcher().createSuccessor({
        node: { id: "n", runtime: "codex", cwd: "/w" },
        departingSessionName: "dev-guard@rig",
      });
      expect(res.ok).toBe(true);
      // 整个缺陷：此处 `undefined` 会把 successor identity 交给 pane 历史决定。
      const [, command] = respawnPane.mock.calls[0]!;
      expect(command).toBe("/bin/zsh");
      // 并且只有 pane 经验证确为 shell 后才继续启动。
      expect(getPaneCommand).toHaveBeenCalled();
      expect(launchHarness).toHaveBeenCalledTimes(1);
    });

    it("respawn 后仍启动非 shell 的 pane → 结构化 successor_pane_not_blank；绝不运行 launchHarness；保留 seat", async () => {
      // 恶意/受污染 pane：无论如何 respawn，foreground 都会成为旧 codex wrapper（例如 tmux
      // default-command 污染，或 server 忽略 respawn）。fresh 契约要求经验证的空白状态，否则显著
      // 拒绝；绝不向已恢复上下文启动后再标记 complete。
      getPaneCommand.mockResolvedValue("node");
      const res = await launcher().createSuccessor({
        node: { id: "n", runtime: "codex", cwd: "/w" },
        departingSessionName: "dev-guard@rig",
      });
      expect(res).toMatchObject({ ok: false, code: "successor_pane_not_blank", step: "create_successor", replacementStarted: true });
      expect((res as { message: string }).message).toContain("node");
      // 绝不能把旧上下文当作 fresh successor 驱动。
      expect(launchHarness).not.toHaveBeenCalled();
      // Unwind 不变量：绝不终止保留 seat；不注册 candidate。
      expect(killSession).not.toHaveBeenCalled();
      expect(discoveryRepo.listDiscovered()).toHaveLength(0);
    });

    it("r2 B1 回归：已配置但未列出的默认 shell（tcsh）是有效空白——retiree 离开后绝不误报 successor_pane_not_blank", async () => {
      // r2 行为证明（tmux 3.6a）：default-shell /bin/tcsh → pane_current_command "tcsh"。verifier
      // 必须接受 launcher 自己选择的 shell basename；硬编码集合若拒绝已配置 shell，会在破坏性
      // cutover 已发生后误拒绝有效空白 pane。
      getDefaultShell.mockResolvedValue("/bin/tcsh");
      const res = await launcher().createSuccessor({
        node: { id: "n", runtime: "codex", cwd: "/w" },
        departingSessionName: "dev-guard@rig",
      });
      expect(res.ok).toBe(true);
      const [, command] = respawnPane.mock.calls[0]!;
      expect(command).toBe("/bin/tcsh");
      expect(launchHarness).toHaveBeenCalledTimes(1);
    });

    it("r2-B1：pane 恰以任意已配置默认 shell 启动时接受它", async () => {
      // r2 要求的泛化：launcher 选择了 respawn 命令，因此 pane 报告该命令 basename 就是经验证的
      // 空白状态；适用于任何已配置 shell，而不只是枚举的常见集合。（Mock 语义：getPaneCommand
      // 回显显式 respawn 命令的 basename。）
      getDefaultShell.mockResolvedValue("/opt/oddshells/bin/osh");
      const res = await launcher().createSuccessor({
        node: { id: "n", runtime: "codex", cwd: "/w" },
        departingSessionName: "dev-guard@rig",
      });
      expect(res.ok).toBe(true);
      expect(launchHarness).toHaveBeenCalledTimes(1);
    });

    it("r2-B1：pane_current_command 上的 login-shell '-' 前缀仍识别为空白 shell", async () => {
      getPaneCommand.mockResolvedValue("-zsh");
      const res = await launcher().createSuccessor({
        node: { id: "n", runtime: "codex", cwd: "/w" },
        departingSessionName: "dev-guard@rig",
      });
      expect(res.ok).toBe(true);
      expect(launchHarness).toHaveBeenCalledTimes(1);
    });

    it("getDefaultShell 不可用 → 回退到 /bin/sh，而不是使用 undefined respawn", async () => {
      getDefaultShell.mockResolvedValue(null);
      const res = await launcher().createSuccessor({
        node: { id: "n", runtime: "codex", cwd: "/w" },
        departingSessionName: "dev-guard@rig",
      });
      expect(res.ok).toBe(true);
      const [, command] = respawnPane.mock.calls[0]!;
      expect(command).toBe("/bin/sh");
    });
  });
});
