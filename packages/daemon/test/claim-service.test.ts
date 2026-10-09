import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { ClaimService } from "../src/domain/claim-service.js";
import { vi } from "vitest";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


describe("ClaimService", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let discoveryRepo: DiscoveryRepository;
  let claimService: ClaimService;
  let mockTmux: TmuxAdapter;
  let setSessionOptionSpy: ReturnType<typeof vi.fn>;
  let sendTextSpy: ReturnType<typeof vi.fn>;
  let sendKeysSpy: ReturnType<typeof vi.fn>;
  let startPipePaneSpy: ReturnType<typeof vi.fn>;
  let ensureContextCollectorSpy: ReturnType<typeof vi.fn>;
  let transcriptStore: TranscriptStore;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    discoveryRepo = new DiscoveryRepository(db);
    setSessionOptionSpy = vi.fn(async () => ({ ok: true as const }));
    sendTextSpy = vi.fn(async () => ({ ok: true as const }));
    sendKeysSpy = vi.fn(async () => ({ ok: true as const }));
    startPipePaneSpy = vi.fn(async () => ({ ok: true as const }));
    ensureContextCollectorSpy = vi.fn();
    mockTmux = {
      setSessionOption: setSessionOptionSpy,
      getSessionOption: vi.fn(async () => null),
      sendText: sendTextSpy,
      sendKeys: sendKeysSpy,
      startPipePane: startPipePaneSpy,
    } as unknown as TmuxAdapter;
    transcriptStore = new TranscriptStore({ transcriptsRoot: "/tmp/openrig-claim-service-transcripts", enabled: true });
    claimService = new ClaimService({
      db,
      rigRepo,
      sessionRegistry,
      discoveryRepo,
      eventBus,
      tmuxAdapter: mockTmux,
      transcriptStore,
      claudeContextProvisioner: {
        ensureContextCollector: ensureContextCollectorSpy,
      },
    });
  });

  afterEach(() => { db.close(); });

  function seedDiscovery(opts?: { runtimeHint?: string; tmuxSession?: string; tmuxPane?: string }) {
    return discoveryRepo.upsertDiscoveredSession({
      tmuxSession: opts?.tmuxSession ?? "organic-session",
      tmuxPane: opts?.tmuxPane ?? "%0",
      runtimeHint: (opts?.runtimeHint ?? "claude-code") as any,
      confidence: "high",
      cwd: "/projects/myapp",
    });
  }

  function seedRig() {
    return rigRepo.createRig("test-rig");
  }

  // bind 合并后已移除 claim() 方法，对应的 claim 专用测试也已删除。

  it("bind 将发现的会话连接到现有节点", async () => {
    const rig = seedRig();
    const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/myapp" });
    const discovered = seedDiscovery({ tmuxSession: "orch-lead@host" });

    const result = await claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.nodeId).toBe(node.id);
    const binding = sessionRegistry.getBindingForNode(node.id);
    expect(binding?.tmuxSession).toBe("orch-lead@host");

    const sessions = sessionRegistry.getSessionsForRig(rig.id).filter((s) => s.nodeId === node.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.origin).toBe("claimed");

    const updated = discoveryRepo.getDiscoveredSession(discovered.id);
    expect(updated?.status).toBe("claimed");
    expect(updated?.claimedNodeId).toBe(node.id);
  });

  it("bind 使用发现的实时窗格替换现有 NULL 窗格", async () => {
    const rig = seedRig();
    const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/myapp" });
    sessionRegistry.updateBinding(node.id, {});
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxPane).toBeNull();
    const discovered = seedDiscovery({ tmuxSession: "orch-lead@host", tmuxPane: "%discovered" });

    const result = await claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });

    expect(result.ok).toBe(true);
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxPane).toBe("%discovered");
  });

  it("bind 拒绝与目标节点不匹配的运行时", async () => {
    const rig = seedRig();
    rigRepo.addNode(rig.id, "orch.lead", { runtime: "codex", cwd: "/projects/myapp" });
    const discovered = seedDiscovery({ runtimeHint: "claude-code" });

    const result = await claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("runtime_mismatch");
  });

  // T15：bind 为接入的会话设置 tmux 元数据。
  it("bind 为接入的会话设置 @rigged_* tmux 元数据", async () => {
    const rig = seedRig();
    const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/myapp" });
    const discovered = seedDiscovery({ tmuxSession: "orch-lead@host" });

    const result = await claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });
    expect(result.ok).toBe(true);

    expect(setSessionOptionSpy).toHaveBeenCalledTimes(5);
    const calls = setSessionOptionSpy.mock.calls as [string, string, string][];
    const metaMap = new Map(calls.map((c) => [c[1], c[2]]));
    expect(metaMap.get("@rigged_node_id")).toBe(node.id);
    expect(metaMap.get("@rigged_session_name")).toBe("orch-lead@host");
    expect(metaMap.get("@rigged_rig_id")).toBe(rig.id);
    expect(metaMap.get("@rigged_rig_name")).toBe("test-rig");
    expect(metaMap.get("@rigged_logical_id")).toBe("orch.lead");
  });

  // T16：createAndBindToPod 设置 tmux 元数据。
  it("createAndBindToPod 为接入的会话设置 @rigged_* tmux 元数据", async () => {
    const rig = seedRig();
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-dev", rig.id, "dev", "Dev");
    const discovered = seedDiscovery({ tmuxSession: "dev-coder@host" });

    const result = await claimService.createAndBindToPod({
      discoveredId: discovered.id, rigId: rig.id,
      podId: "pod-dev", podNamespace: "dev", memberName: "coder",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(setSessionOptionSpy).toHaveBeenCalledTimes(5);
    const calls = setSessionOptionSpy.mock.calls as [string, string, string][];
    const metaMap = new Map(calls.map((c) => [c[1], c[2]]));
    expect(metaMap.get("@rigged_node_id")).toBe(result.nodeId);
    expect(metaMap.get("@rigged_session_name")).toBe("dev-coder@host");
    expect(metaMap.get("@rigged_rig_id")).toBe(rig.id);
    expect(metaMap.get("@rigged_rig_name")).toBe("test-rig");
    expect(metaMap.get("@rigged_logical_id")).toBe("dev.coder");
  });

  // T17：bind 通过 sendText + sendKeys C-m 发送认领后的身份提示。
  it("bind 通过 sendText + sendKeys 发送认领后的身份提示", async () => {
    const rig = seedRig();
    const node = rigRepo.addNode(rig.id, "adopted-sess", { runtime: "claude-code", cwd: "/tmp" });
    const discovered = seedDiscovery({ tmuxSession: "adopted-sess" });

    await claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "adopted-sess" });

    expect(sendTextSpy).toHaveBeenCalled();
    const textCall = sendTextSpy.mock.calls[0] as [string, string];
    expect(textCall[0]).toBe("adopted-sess");
    expect(textCall[1]).toContain("test-rig");
    expect(textCall[1]).toContain("adopted-sess"); // logicalId 默认使用 tmux 会话名称
    expect(textCall[1]).toContain("zrig whoami --json");

    // 还必须使用 C-m 提交输入。
    expect(sendKeysSpy).toHaveBeenCalled();
    const keysCall = sendKeysSpy.mock.calls[0] as [string, string[]];
    expect(keysCall[0]).toBe("adopted-sess");
    expect(keysCall[1]).toContain("C-m");
  });

  // T18：bind 发送认领后的身份提示。
  it("bind 通过 sendText + sendKeys 发送认领后的身份提示", async () => {
    const rig = seedRig();
    rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/myapp" });
    const discovered = seedDiscovery({ tmuxSession: "orch-lead@host" });

    await claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });

    expect(sendTextSpy).toHaveBeenCalled();
    const textCall = sendTextSpy.mock.calls[0] as [string, string];
    expect(textCall[0]).toBe("orch-lead@host");
    expect(textCall[1]).toContain("test-rig");
    expect(textCall[1]).toContain("orch.lead");

    expect(sendKeysSpy).toHaveBeenCalled();
    const keysCall = sendKeysSpy.mock.calls[0] as [string, string[]];
    expect(keysCall[1]).toContain("C-m");
  });

  // T19：createAndBindToPod 发送认领后的身份提示。
  it("createAndBindToPod 通过 sendText + sendKeys 发送认领后的身份提示", async () => {
    const rig = seedRig();
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-dev2", rig.id, "dev", "Dev");
    const discovered = seedDiscovery({ tmuxSession: "dev-coder2@host" });

    await claimService.createAndBindToPod({
      discoveredId: discovered.id, rigId: rig.id,
      podId: "pod-dev2", podNamespace: "dev", memberName: "coder",
    });

    expect(sendTextSpy).toHaveBeenCalled();
    const textCall = sendTextSpy.mock.calls[0] as [string, string];
    expect(textCall[0]).toBe("dev-coder2@host");
    expect(textCall[1]).toContain("dev.coder");

    expect(sendKeysSpy).toHaveBeenCalled();
    const keysCall = sendKeysSpy.mock.calls[0] as [string, string[]];
    expect(keysCall[1]).toContain("C-m");
  });

  // T20：提示文本包含必要的身份字段。
  it("提示文本包含工作组名称、logicalId 和 whoami 引用", async () => {
    const rig = seedRig();
    rigRepo.addNode(rig.id, "custom.id", { runtime: "claude-code", cwd: "/tmp" });
    const discovered = seedDiscovery({ tmuxSession: "my-session" });

    await claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "custom.id" });

    const textCall = sendTextSpy.mock.calls[0] as [string, string];
    const hint = textCall[1];
    expect(hint).toContain("test-rig");
    expect(hint).toContain("custom.id");
    expect(hint).toContain("zrig whoami --json");
  });

  // T21：身份提示发送失败不会导致 bind 失败。
  it("即使身份提示发送失败，bind 仍会成功", async () => {
    const rig = seedRig();
    rigRepo.addNode(rig.id, "organic-session", { runtime: "claude-code", cwd: "/tmp" });
    const discovered = seedDiscovery();

    sendTextSpy.mockImplementation(async () => { throw new Error("tmux not available"); });

    const result = await claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "organic-session" });
    expect(result.ok).toBe(true);
  });

  it("bind 为接入的 tmux 会话启动转录捕获", async () => {
    const rig = seedRig();
    rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/myapp" });
    const discovered = seedDiscovery({ tmuxSession: "orch-lead@host" });
    vi.spyOn(transcriptStore, "ensureTranscriptDir").mockReturnValue(true);

    const result = await claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });

    expect(result.ok).toBe(true);
    // V1 预发布条目 1：转录捕获路径现在启动轮换定时器，而不再使用 pipe-pane。
    // 因此通过轮换模块的活动计数确认，而不是使用旧式 pipe-pane spy。
    const { getActiveRotationCount, clearAllTranscriptRotationsForTest } =
      await import("../src/domain/transcript-rotation.js");
    expect(getActiveRotationCount()).toBeGreaterThan(0);
    clearAllTranscriptRotationsForTest();
  });

  it("bind 为接入的 tmux 会话配置 Claude 上下文收集", async () => {
    const rig = seedRig();
    rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/myapp" });
    const discovered = seedDiscovery({ tmuxSession: "orch-lead@host" });

    const result = await claimService.bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });

    expect(result.ok).toBe(true);
    expect(ensureContextCollectorSpy).toHaveBeenCalledWith({
      cwd: "/projects/myapp",
      tmuxSession: "orch-lead@host",
    });
  });
});
