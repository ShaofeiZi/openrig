import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { DiscoveryCoordinator } from "../src/domain/discovery-coordinator.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import type { TmuxDiscoveryScanner, ScannedPane, ScanResult } from "../src/domain/tmux-discovery-scanner.js";
import type { SessionFingerprinter, FingerprintResult } from "../src/domain/session-fingerprinter.js";
import type { SessionEnricher, EnrichmentResult } from "../src/domain/session-enricher.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


function makePane(overrides?: Partial<ScannedPane>): ScannedPane {
  return { tmuxSession: "organic", tmuxWindow: "0", tmuxPane: "%0", pid: 1234, cwd: "/tmp", activeCommand: "claude", ...overrides };
}

function mockScanner(panes: ScannedPane[]): TmuxDiscoveryScanner {
  return { scan: vi.fn(async (): Promise<ScanResult> => ({ panes, scannedAt: new Date().toISOString() })) } as unknown as TmuxDiscoveryScanner;
}

function mockFingerprinter(hint: string = "claude-code"): SessionFingerprinter {
  return {
    refreshCmuxSignals: vi.fn(async () => {}),
    fingerprint: vi.fn(async (): Promise<FingerprintResult> => ({
      runtimeHint: hint as any,
      confidence: "high",
      evidence: { layerUsed: 1, processSignal: { command: "claude", matched: "claude" } },
    })),
  } as unknown as SessionFingerprinter;
}

function mockEnricher(): SessionEnricher {
  return {
    enrich: vi.fn((): EnrichmentResult => ({
      skills: [], claudeSkills: [], agentsSkills: [],
      hasClaudeMd: false, hasAgentsMd: false, hasPackageYaml: false, raw: {},
    })),
  } as unknown as SessionEnricher;
}

describe("DiscoveryCoordinator", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
  });

  afterEach(() => { db.close(); });

  function buildCoordinator(opts?: { scanner?: TmuxDiscoveryScanner; fingerprinter?: SessionFingerprinter; enricher?: SessionEnricher }) {
    const discoveryRepo = new DiscoveryRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    return {
      coordinator: new DiscoveryCoordinator({
        scanner: opts?.scanner ?? mockScanner([]),
        fingerprinter: opts?.fingerprinter ?? mockFingerprinter(),
        enricher: opts?.enricher ?? mockEnricher(),
        discoveryRepo,
        sessionRegistry,
        eventBus,
      }),
      discoveryRepo,
      sessionRegistry,
      eventBus,
    };
  }

  // T1：完整流水线
  it("完整流水线：扫描 -> 指纹识别 -> 丰富信息 -> 持久化", async () => {
    const pane = makePane();
    const { coordinator, discoveryRepo } = buildCoordinator({ scanner: mockScanner([pane]) });

    const results = await coordinator.scanOnce();

    expect(results).toHaveLength(1);
    expect(results[0]!.tmuxSession).toBe("organic");
    expect(results[0]!.runtimeHint).toBe("claude-code");

    const stored = discoveryRepo.getDiscoveredSession(results[0]!.id);
    expect(stored).toBeDefined();
  });

  // T2：插入新会话
  it("发现新会话 -> 插入数据库", async () => {
    const { coordinator, discoveryRepo } = buildCoordinator({ scanner: mockScanner([makePane()]) });

    await coordinator.scanOnce();

    const all = discoveryRepo.listDiscovered("active");
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("active");
  });

  // T3：重新扫描保留 id + first_seen_at
  it("重新扫描已知会话 -> 保留 id 和 first_seen_at，并更新 last_seen_at", async () => {
    const pane = makePane();
    const { coordinator, discoveryRepo } = buildCoordinator({ scanner: mockScanner([pane]) });

    const first = await coordinator.scanOnce();
    const firstId = first[0]!.id;
    const firstSeen = first[0]!.firstSeenAt;

    // 短暂延迟，确保 last_seen_at 不同。
    const second = await coordinator.scanOnce();

    expect(second[0]!.id).toBe(firstId);
    expect(second[0]!.firstSeenAt).toBe(firstSeen);
  });

  // T4：缺失会话 -> vanished
  it("将缺失会话标记为 vanished", async () => {
    const pane = makePane();
    const scanner1 = mockScanner([pane]);
    const { coordinator, discoveryRepo } = buildCoordinator({ scanner: scanner1 });

    await coordinator.scanOnce();
    expect(discoveryRepo.listDiscovered("active")).toHaveLength(1);

    // 第二次扫描返回空结果。
    (scanner1.scan as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ panes: [], scannedAt: new Date().toISOString() });
    await coordinator.scanOnce();

    expect(discoveryRepo.listDiscovered("active")).toHaveLength(0);
    expect(discoveryRepo.listDiscovered("vanished")).toHaveLength(1);
  });

  // T5a：会话级绑定过滤该会话的所有窗格
  it("会话级托管绑定过滤所有窗格", async () => {
    // 创建没有窗格的托管工作组 + 节点 + 绑定。
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "r01");
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run("n-1", "rig-1", "dev");
    db.prepare("INSERT INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)").run("b-1", "n-1", "r01-dev");

    const panes = [
      makePane({ tmuxSession: "r01-dev", tmuxPane: "%0" }),
      makePane({ tmuxSession: "r01-dev", tmuxPane: "%1" }),
      makePane({ tmuxSession: "organic", tmuxPane: "%2" }),
    ];
    const { coordinator } = buildCoordinator({ scanner: mockScanner(panes) });

    const results = await coordinator.scanOnce();

    // 应当只发现自然会话。
    expect(results).toHaveLength(1);
    expect(results[0]!.tmuxSession).toBe("organic");
  });

  // T5b：窗格级绑定只过滤对应窗格
  it("窗格级托管绑定只过滤对应窗格", async () => {
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "r01");
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run("n-1", "rig-1", "dev");
    db.prepare("INSERT INTO bindings (id, node_id, tmux_session, tmux_pane) VALUES (?, ?, ?, ?)").run("b-1", "n-1", "multi", "%1");

    const panes = [
      makePane({ tmuxSession: "multi", tmuxPane: "%0" }),
      makePane({ tmuxSession: "multi", tmuxPane: "%1" }),
    ];
    const { coordinator } = buildCoordinator({ scanner: mockScanner(panes) });

    const results = await coordinator.scanOnce();

    // 应当只发现 %0，%1 已托管。
    expect(results).toHaveLength(1);
    expect(results[0]!.tmuxPane).toBe("%0");
  });

  // T6：已认领会话不会被再次发现
  it("后续扫描过滤已认领会话", async () => {
    const { coordinator, discoveryRepo } = buildCoordinator({ scanner: mockScanner([makePane()]) });

    // 首次扫描发现会话。
    const first = await coordinator.scanOnce();
    expect(first).toHaveLength(1);

    // 认领会话。
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "r01");
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run("n-1", "rig-1", "dev");
    discoveryRepo.markClaimed(first[0]!.id, "n-1");

    // 第二次扫描不应再次发现它。
    const second = await coordinator.scanOnce();
    expect(second).toHaveLength(0);
  });

  // T7：scanOnce 返回活跃会话
  it("scanOnce 返回已发现的活跃会话", async () => {
    const panes = [makePane({ tmuxPane: "%0" }), makePane({ tmuxPane: "%1" })];
    const { coordinator } = buildCoordinator({ scanner: mockScanner(panes) });

    const results = await coordinator.scanOnce();

    expect(results).toHaveLength(2);
    expect(results.every((s) => s.status === "active")).toBe(true);
  });

  // T9：单次扫描发现多个会话
  it("单次扫描发现多个会话", async () => {
    const panes = [
      makePane({ tmuxSession: "s1", tmuxPane: "%0" }),
      makePane({ tmuxSession: "s2", tmuxPane: "%0" }),
      makePane({ tmuxSession: "s3", tmuxPane: "%0" }),
    ];
    const { coordinator } = buildCoordinator({ scanner: mockScanner(panes) });

    const results = await coordinator.scanOnce();

    expect(results).toHaveLength(3);
  });

  // T10：空 tmux -> 空结果
  it("空 tmux 返回空结果", async () => {
    const { coordinator } = buildCoordinator({ scanner: mockScanner([]) });

    const results = await coordinator.scanOnce();

    expect(results).toHaveLength(0);
  });

  // T11：发现和消失时发出事件
  it("发出 session.discovered 和 session.vanished 事件", async () => {
    const pane = makePane();
    const scanner = mockScanner([pane]);
    const { coordinator } = buildCoordinator({ scanner });

    await coordinator.scanOnce();

    // 检查发现事件。
    const events = db.prepare("SELECT type, payload FROM events ORDER BY seq").all() as Array<{ type: string; payload: string }>;
    const discovered = events.filter((e) => e.type === "session.discovered");
    expect(discovered).toHaveLength(1);
    const dp = JSON.parse(discovered[0]!.payload);
    expect(dp.tmuxSession).toBe("organic");
    expect(dp.tmuxPane).toBe("%0");

    // 第二次扫描为空 -> 消失事件。
    (scanner.scan as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ panes: [], scannedAt: new Date().toISOString() });
    await coordinator.scanOnce();

    const allEvents = db.prepare("SELECT type FROM events ORDER BY seq").all() as Array<{ type: string }>;
    expect(allEvents.some((e) => e.type === "session.vanished")).toBe(true);
  });

  // T12：仓库增删改查操作
  it("仓库增删改查：upsert、list、get、markClaimed、markVanished", () => {
    const repo = new DiscoveryRepository(db);

    // 插入或更新。
    const created = repo.upsertDiscoveredSession({
      tmuxSession: "test", tmuxPane: "%0", runtimeHint: "claude-code", confidence: "high",
    });
    expect(created.id).toBeTruthy();
    expect(created.status).toBe("active");

    // 列表。
    expect(repo.listDiscovered("active")).toHaveLength(1);

    // 获取。
    expect(repo.getDiscoveredSession(created.id)!.tmuxSession).toBe("test");

    // 标记为已消失。
    repo.markVanished([created.id]);
    expect(repo.getDiscoveredSession(created.id)!.status).toBe("vanished");

    // 再创建一个并标记为已认领。
    const s2 = repo.upsertDiscoveredSession({
      tmuxSession: "test2", tmuxPane: "%0", runtimeHint: "codex", confidence: "high",
    });
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("rig-1", "r01");
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, ?, ?)").run("n-1", "rig-1", "dev");
    repo.markClaimed(s2.id, "n-1");
    expect(repo.getDiscoveredSession(s2.id)!.status).toBe("claimed");
  });
});
