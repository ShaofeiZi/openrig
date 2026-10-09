// OPR.0.4.3.20 FR-3——在接纳边界（reconcile / adopt / bind）自动捕获席位恢复令牌。
// 通过注入的模拟实现（模拟 Claude sidecar 读取器 + 模拟 Codex thread-id 捕获器），确定性地
// 证明全部三条 ClaimService 接纳路径的捕获矩阵——不执行真实 `ps`，不使用实时 tmux。
// 复用派生、持久化和校验原语；此套件验证接线、来源、如实跳过、尽力而为、终端跳过、
// 幂等性及事件不含密钥等不变量。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { ClaimService } from "../src/domain/claim-service.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


type SidecarResult = { ok: true; data: { session_id?: string } } | { ok: false; reason: string };

describe("ClaimService FR-3——接纳边界恢复令牌捕获", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let discoveryRepo: DiscoveryRepository;
  let mockTmux: TmuxAdapter;
  let readSidecar: ReturnType<typeof vi.fn>;
  let captureCodexThreadId: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    discoveryRepo = new DiscoveryRepository(db);
    mockTmux = {
      setSessionOption: vi.fn(async () => ({ ok: true as const })),
      getSessionOption: vi.fn(async () => null),
      sendText: vi.fn(async () => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      startPipePane: vi.fn(async () => ({ ok: true as const })),
      hasSession: vi.fn(async () => true),
      getPaneCommand: vi.fn(async () => "zsh"),
      getPanePid: vi.fn(async () => 4242),
    } as unknown as TmuxAdapter;
    readSidecar = vi.fn((): SidecarResult => ({ ok: false, reason: "missing_sidecar" }));
    captureCodexThreadId = vi.fn(async (): Promise<string | undefined> => undefined);
  });

  afterEach(() => { db.close(); });

  function buildService(): ClaimService {
    return new ClaimService({
      db, rigRepo, sessionRegistry, discoveryRepo, eventBus, tmuxAdapter: mockTmux,
      contextUsageStore: { readSidecar: readSidecar as unknown as (n: string) => SidecarResult },
      resumeTokenCapturer: { captureCodexThreadId: captureCodexThreadId as unknown as (n: string) => Promise<string | undefined> },
    });
  }

  function seedDiscovery(opts?: { runtimeHint?: string; tmuxSession?: string }) {
    return discoveryRepo.upsertDiscoveredSession({
      tmuxSession: opts?.tmuxSession ?? "seat@test-rig",
      tmuxPane: "%0",
      runtimeHint: (opts?.runtimeHint ?? "claude-code") as never,
      confidence: "high",
      cwd: "/projects/app",
    });
  }

  function tokenRow(nodeId: string): { resume_type: string | null; resume_token: string | null; resume_provenance: string | null } {
    return db.prepare(
      "SELECT resume_type, resume_token, resume_provenance FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1"
    ).get(nodeId) as { resume_type: string | null; resume_token: string | null; resume_provenance: string | null };
  }

  function latestEvent(): { type: string; payload: Record<string, unknown> } | undefined {
    const row = db.prepare("SELECT type, payload FROM events ORDER BY seq DESC LIMIT 1").get() as { type: string; payload: string } | undefined;
    if (!row) return undefined;
    return { type: row.type, payload: JSON.parse(row.payload) as Record<string, unknown> };
  }

  // ---- bind() 路径 ----

  it("bind 从 sidecar session_id 捕获 Claude 恢复令牌（provenance=adoption）", async () => {
    readSidecar.mockReturnValue({ ok: true, data: { session_id: "claude-uuid-1234" } });
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/app" });
    const discovered = seedDiscovery({ runtimeHint: "claude-code", tmuxSession: "orch-lead@test-rig" });

    const result = await buildService().bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });
    expect(result.ok).toBe(true);

    const row = tokenRow(node.id);
    expect(row.resume_token).toBe("claude-uuid-1234");
    expect(row.resume_type).toBe("claude_id");
    expect(row.resume_provenance).toBe("adoption");

    const ev = latestEvent();
    expect(ev?.type).toBe("session.resume_token_captured");
    expect(ev?.payload.outcome).toBe("captured");
    expect(ev?.payload.provenance).toBe("adoption");
    // 不含密钥的事件：payload 中绝不出现令牌值。
    expect(JSON.stringify(ev?.payload)).not.toContain("claude-uuid-1234");
  });

  it("bind 从 thread-id 捕获器捕获 Codex 恢复令牌（provenance=adoption）", async () => {
    captureCodexThreadId.mockResolvedValue("codex-thread-abcd");
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex", cwd: "/projects/app" });
    const discovered = seedDiscovery({ runtimeHint: "codex", tmuxSession: "dev-qa@test-rig" });

    const result = await buildService().bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "dev.qa" });
    expect(result.ok).toBe(true);

    const row = tokenRow(node.id);
    expect(row.resume_token).toBe("codex-thread-abcd");
    expect(row.resume_type).toBe("codex_id");
    expect(row.resume_provenance).toBe("adoption");
    expect(captureCodexThreadId).toHaveBeenCalledWith("dev-qa@test-rig");
  });

  it("Claude sidecar 缺失时 bind 如实跳过（不持久化令牌，跳过事件包含原因）", async () => {
    readSidecar.mockReturnValue({ ok: false, reason: "missing_sidecar" });
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/app" });
    const discovered = seedDiscovery({ runtimeHint: "claude-code", tmuxSession: "orch-lead@test-rig" });

    const result = await buildService().bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });
    expect(result.ok).toBe(true);

    expect(tokenRow(node.id).resume_token).toBeNull();
    const ev = latestEvent();
    expect(ev?.type).toBe("session.resume_token_captured");
    expect(ev?.payload.outcome).toBe("skipped");
    expect(ev?.payload.reason).toBe("missing_sidecar");
  });

  it("Codex 探测超时时 bind 如实跳过（undefined → reason=probe_timeout）", async () => {
    captureCodexThreadId.mockResolvedValue(undefined);
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex", cwd: "/projects/app" });
    const discovered = seedDiscovery({ runtimeHint: "codex", tmuxSession: "dev-qa@test-rig" });

    const result = await buildService().bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "dev.qa" });
    expect(result.ok).toBe(true);

    expect(tokenRow(node.id).resume_token).toBeNull();
    expect(latestEvent()?.payload.reason).toBe("probe_timeout");
  });

  it("bind 如实跳过无效或格式错误的派生令牌（先校验再持久化 → reason=invalid_token）", async () => {
    readSidecar.mockReturnValue({ ok: true, data: { session_id: "bad token with spaces!" } });
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/app" });
    const discovered = seedDiscovery({ runtimeHint: "claude-code", tmuxSession: "orch-lead@test-rig" });

    const result = await buildService().bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });
    expect(result.ok).toBe(true);

    expect(tokenRow(node.id).resume_token).toBeNull();
    expect(latestEvent()?.payload.reason).toBe("invalid_token");
  });

  it("terminal runtime 节点的 bind 豁免：不捕获、不发事件，也不视为失败", async () => {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "infra.term", { runtime: "terminal", cwd: "/tmp" });
    const discovered = seedDiscovery({ runtimeHint: "terminal", tmuxSession: "infra-term@test-rig" });

    const result = await buildService().bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "infra.term" });
    expect(result.ok).toBe(true);

    expect(tokenRow(node.id).resume_token).toBeNull();
    expect(readSidecar).not.toHaveBeenCalled();
    expect(captureCodexThreadId).not.toHaveBeenCalled();
    // 不发出捕获事件——最后一个事件是 node.claimed，而不是捕获/跳过事件。
    expect(latestEvent()?.type).not.toBe("session.resume_token_captured");
  });

  it("bind 尽力而为：捕获内部抛错不会导致接纳失败", async () => {
    readSidecar.mockImplementation(() => { throw new Error("sidecar read blew up"); });
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/app" });
    const discovered = seedDiscovery({ runtimeHint: "claude-code", tmuxSession: "orch-lead@test-rig" });

    const result = await buildService().bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });
    expect(result.ok).toBe(true);
    expect(tokenRow(node.id).resume_token).toBeNull();
  });

  it("来源保护拒绝写入时，bind 发出 outcome=preserved（而非 captured）", async () => {
    // 阻塞场景：确实派生出有效令牌，但写入时已有更高优先级令牌（hook/operator；例如异步探测
    // 窗口期间触发了 hook）。写入器返回 false；事件必须反映台账得到保留，绝不能错误声称
    // 已捕获接纳写入。
    readSidecar.mockReturnValue({ ok: true, data: { session_id: "claude-uuid-preserve" } });
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "orch.lead", { runtime: "claude-code", cwd: "/projects/app" });
    const discovered = seedDiscovery({ runtimeHint: "claude-code", tmuxSession: "orch-lead@test-rig" });
    const writeSpy = vi.spyOn(sessionRegistry, "updateResumeToken").mockReturnValue(false);

    const result = await buildService().bind({ discoveredId: discovered.id, rigId: rig.id, logicalId: "orch.lead" });
    expect(result.ok).toBe(true);
    // 接纳捕获确实尝试使用派生令牌和来源执行写入。
    expect(writeSpy).toHaveBeenCalledWith(expect.any(String), "claude_id", "claude-uuid-preserve", "adoption");

    const ev = latestEvent();
    expect(ev?.type).toBe("session.resume_token_captured");
    expect(ev?.payload.outcome).toBe("preserved");
    expect(ev?.payload.reason).toBe("higher_rank_present");
    // 绝不能错误报告已捕获接纳写入。
    expect(ev?.payload.provenance).toBeUndefined();
    void node;
  });

  // ---- createAndBindToPod() 路径 ----

  it("createAndBindToPod 从 sidecar 捕获 Claude 令牌", async () => {
    readSidecar.mockReturnValue({ ok: true, data: { session_id: "claude-uuid-cbp" } });
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-dev", rig.id, "dev", "Dev");
    const discovered = seedDiscovery({ runtimeHint: "claude-code", tmuxSession: "dev-coder@test-rig" });

    const result = await buildService().createAndBindToPod({
      discoveredId: discovered.id, rigId: rig.id, podId: "pod-dev", podNamespace: "dev", memberName: "coder",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = tokenRow(result.nodeId);
    expect(row.resume_token).toBe("claude-uuid-cbp");
    expect(row.resume_provenance).toBe("adoption");
  });

  // ---- reconcileSession() 路径 ----

  /** 建立一个先前托管的席位，其绑定将规范名称映射到节点，然后将会话标记为 detached
   * （故障状态），使 reconcileSession 可以按名称重新接纳实时会话。 */
  function seedDetachedManagedSeat(runtime: string, sessionName: string) {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.driver", { runtime, cwd: "/projects/app" });
    sessionRegistry.updateBinding(node.id, { tmuxSession: sessionName });
    const s = sessionRegistry.registerClaimedSession(node.id, sessionName);
    sessionRegistry.markDetached(s.id);
    return { rig, node, session: s };
  }

  it("reconcileSession 在不启动的接纳边界捕获 Codex 令牌", async () => {
    captureCodexThreadId.mockResolvedValue("codex-thread-reconcile");
    const { node } = seedDetachedManagedSeat("codex", "dev-driver@test-rig");

    const result = await buildService().reconcileSession({ sessionName: "dev-driver@test-rig" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // FR-3 捕获令牌，但绝不声称对话连续性。
    expect(result.result.continuity).toBe("unverified");

    const row = tokenRow(node.id);
    expect(row.resume_token).toBe("codex-thread-reconcile");
    expect(row.resume_type).toBe("codex_id");
    expect(row.resume_provenance).toBe("adoption");
  });

  it("reconcileSession 只在新绑定的占用者行上替换过期 Claude 令牌", async () => {
    const stale = "9e1ac0df-505a-4050-857b-a494b46dabc6";
    const current = "f16594c5-179a-4be7-bf5e-fd759b2b87a3";
    const { node, session } = seedDetachedManagedSeat("claude-code", "dev-driver@test-rig");
    sessionRegistry.updateResumeToken(session.id, "claude_id", stale, "scrape");
    readSidecar.mockReturnValue({ ok: true, data: { session_id: current } });

    const result = await buildService().reconcileSession({ sessionName: "dev-driver@test-rig" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(tokenRow(node.id)).toMatchObject({
      resume_type: "claude_id",
      resume_token: current,
      resume_provenance: "adoption",
    });
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-driver@test-rig");
    expect(sessionRegistry.getSessionsForRig(result.result.rigId).find((row) => row.id === session.id)).toMatchObject({
      status: "detached",
      resumeToken: stale,
    });
  });

  it("reconcileSession 捕获幂等：再次协调会刷新为单一一致的接纳条目", async () => {
    captureCodexThreadId.mockResolvedValue("codex-thread-v1");
    const { node } = seedDetachedManagedSeat("codex", "dev-driver@test-rig");
    const svc = buildService();

    await svc.reconcileSession({ sessionName: "dev-driver@test-rig" });
    // 模拟令牌轮换；再次接纳。
    captureCodexThreadId.mockResolvedValue("codex-thread-v2");
    const again = await svc.reconcileSession({ sessionName: "dev-driver@test-rig" });
    expect(again.ok).toBe(true);

    // 最新（运行中）会话行携带已刷新的令牌，来源仍为 adoption。
    const row = tokenRow(node.id);
    expect(row.resume_token).toBe("codex-thread-v2");
    expect(row.resume_provenance).toBe("adoption");
    // 节点恰有一条运行中会话记录（无重复或损坏）。
    const running = db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE node_id = ? AND status = 'running'").get(node.id) as { c: number };
    expect(running.c).toBe(1);
  });
});
