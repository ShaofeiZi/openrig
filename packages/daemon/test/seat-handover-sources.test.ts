import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { SEAT_HANDOVER_SOURCE_CAPABILITIES } from "../src/domain/seat-handover-planner.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { observeCodexSandbox } from "../src/domain/permission-drift.js";
import { buildRebuildPrimingChain } from "../src/domain/rebuild-priming-chain.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// OPR.0.5.5.5（05-handover-sources-real）——fork/rebuild 交接来源会执行其打印的计划。
// v0 B3 的拒绝（`source_not_supported`）被真实执行替代：fork 通过原生 fork 启动接缝
//（launchHarness forkSource）携带现任者上下文；rebuild 从席位的持久产物链准备新 successor，
// 并准确记录找到的内容。这里每个固定测试都在真实数据库上运行真实服务路径，只在
// tmux/adapter 处使用替身。
describe("SeatHandoverService 来源执行（OPR.0.5.5.5）", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let discoveryRepo: DiscoveryRepository;
  let eventBus: EventBus;
  let hasSession: ReturnType<typeof vi.fn>;
  let createSession: ReturnType<typeof vi.fn>;
  let listPanes: ReturnType<typeof vi.fn>;
  let killSession: ReturnType<typeof vi.fn>;
  let respawnPane: ReturnType<typeof vi.fn>;
  let setRemainOnExit: ReturnType<typeof vi.fn>;
  let signalPaneProcess: ReturnType<typeof vi.fn>;
  let isPaneDead: ReturnType<typeof vi.fn>;
  let sendText: ReturnType<typeof vi.fn>;
  let sendKeys: ReturnType<typeof vi.fn>;
  let capturePaneScreen: ReturnType<typeof vi.fn>;
  let launchHarness: ReturnType<typeof vi.fn>;
  let checkReady: ReturnType<typeof vi.fn>;
  let readSidecar: ReturnType<typeof vi.fn>;
  let captureCodexThreadId: ReturnType<typeof vi.fn>;
  let getDefaultShell: ReturnType<typeof vi.fn>;
  let getPaneCommand: ReturnType<typeof vi.fn>;
  let rebuildChain: ReturnType<typeof vi.fn>;
  let artifactExists: ReturnType<typeof vi.fn>;
  let service: SeatHandoverService;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    discoveryRepo = new DiscoveryRepository(db);
    eventBus = new EventBus(db);
    hasSession = vi.fn(async () => true);
    createSession = vi.fn(async () => ({ ok: true }));
    listPanes = vi.fn(async () => [{ id: "%9", index: 0, cwd: "/project", width: 80, height: 24, active: true }]);
    killSession = vi.fn(async () => ({ ok: true }));
    respawnPane = vi.fn(async () => ({ ok: true }));
    setRemainOnExit = vi.fn(async () => ({ ok: true }));
    signalPaneProcess = vi.fn(async () => ({ ok: true }));
    isPaneDead = vi.fn(async () => true);
    sendText = vi.fn(async () => ({ ok: true }));
    sendKeys = vi.fn(async () => ({ ok: true }));
    capturePaneScreen = vi.fn(async () => "predecessor screen tail");
    launchHarness = vi.fn(async () => ({
      ok: true,
      resumeToken: "post-launch-tok",
      resumeType: "codex_id",
      appliedLaunch: observeCodexSandbox(" -s workspace-write"),
    }));
    checkReady = vi.fn(async () => ({ ready: true }));
    readSidecar = vi.fn(() => ({ ok: true, data: { session_id: "claude-sid-123" } }));
    captureCodexThreadId = vi.fn(async () => "codex-discovered-tok");
    getDefaultShell = vi.fn(async () => "/bin/zsh");
    getPaneCommand = vi.fn(async () => "zsh");
    rebuildChain = vi.fn(() => ({
      artifacts: [
        { address: "/seats/dev-impl/RECAP.md", label: "authored recap (chain depth 2)" },
        { address: "/seats/dev-impl/LEARNED.md", label: "seat lineage lessons" },
      ],
    }));
    artifactExists = vi.fn(() => true);
    service = newService();
  });

  afterEach(() => {
    db.close();
  });

  function tmux(): TmuxAdapter {
    return { hasSession, createSession, listPanes, killSession, respawnPane, setRemainOnExit, signalPaneProcess, isPaneDead, sendText, sendKeys, capturePaneScreen, getDefaultShell, getPaneCommand } as unknown as TmuxAdapter;
  }

  function codexAdapter(): RuntimeAdapter {
    return { runtime: "codex", launchHarness, checkReady } as unknown as RuntimeAdapter;
  }

  function newService(): SeatHandoverService {
    return new SeatHandoverService({
      db,
      rigRepo,
      sessionRegistry,
      discoveryRepo,
      eventBus,
      tmuxAdapter: tmux(),
      now: () => new Date("2026-04-24T18:30:00.000Z"),
      newSuccessorId: () => "01SUCCID0",
      runtimeAdapters: { codex: codexAdapter() },
      contextUsageStore: { readSidecar } as never,
      resumeTokenCapturer: { captureCodexThreadId } as never,
      rebuildPrimingResolver: rebuildChain as never,
      rebuildArtifactExists: artifactExists as never,
      readinessTimeoutMs: 50,
      sleep: async () => {},
    });
  }

  function seedSeat(opts?: { resumeToken?: string | null }) {
    const rig = rigRepo.createRig("seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/project" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready", "2026-04-20T12:00:00Z");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@seat-rig", tmuxPane: "%0" });
    if (opts?.resumeToken) {
      sessionRegistry.updateResumeToken(session.id, "codex_id", opts.resumeToken, "scrape");
    }
    return { rig, node, sessionId: session.id };
  }

  function nodeRow(nodeId: string) {
    return db.prepare("SELECT continuity_outcome, handover_result FROM nodes WHERE id = ?").get(nodeId) as Record<string, string | null>;
  }

  // ——Mini-req 1：执行 FORK——

  it("fork：执行切换，通过 fork 启动接缝携带现任者原生 id，并记录 continuity_outcome=forked", async () => {
    const { node } = seedSeat({ resumeToken: "native-abc" });

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fork:dev-impl@seat-rig",
      operator: "orch-lead@seat-rig",
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok || !("result" in result)) throw new Error("expected handover result");
    // 保留席位身份：successor 占用相同的席位会话名（原地切换），绑定已移动，
    // seat/occupant 分离仍保持真实。
    expect(result.result).toMatchObject({
      ok: true,
      mutated: true,
      source: { mode: "fork", ref: "dev-impl@seat-rig" },
      currentStatus: { continuityOutcome: "forked", handoverResult: "complete" },
    });
    expect(nodeRow(node.id)).toEqual({ continuity_outcome: "forked", handover_result: "complete" });
    // 此次启动是 FORK 启动：adapter 收到已解析的原生 id，绝不是被静默报告为 fork 的空白新启动。
    const launchOpts = launchHarness.mock.calls.at(-1)?.[1];
    expect(launchOpts).toMatchObject({ forkSource: { kind: "native_id", value: "native-abc" } });
    // 提交持久化的是 fork 后的新 token（adapter 结果），绝不是父 token。
    const successor = sessionRegistry.getBindingForNode(node.id);
    expect(successor?.tmuxSession).toBe("dev-impl@seat-rig");
  });

  it("fork：找不到原生恢复 id 时，在任何重新生成前如实拒绝；不创建 successor，也不触碰席位", async () => {
    seedSeat({ resumeToken: null });

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fork:dev-impl@seat-rig",
    });

    expect(result).toMatchObject({ ok: false, code: "resume_token_unavailable" });
    if (result.ok) throw new Error("expected refusal");
    expect(result.message).toContain("dev-impl@seat-rig");
    // 如实拒绝发生在修改前：离开的 pane 从未重新生成，也未尝试启动 harness。
    expect(respawnPane).not.toHaveBeenCalled();
    expect(launchHarness).not.toHaveBeenCalled();
  });

  // ——Mini-req 2：执行 REBUILD——

  it("rebuild：执行由持久链准备的新启动，记录精确准备产物及 continuity_outcome=rebuilt", async () => {
    const { node } = seedSeat();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "degraded-incumbent",
      source: "rebuild",
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok || !("result" in result)) throw new Error("expected handover result");
    expect(result.result).toMatchObject({
      ok: true,
      mutated: true,
      source: { mode: "rebuild" },
      currentStatus: { continuityOutcome: "rebuilt", handoverResult: "complete" },
    });
    expect(nodeRow(node.id)).toEqual({ continuity_outcome: "rebuilt", handover_result: "complete" });
    // 已记录的准备集合与磁盘上解析到的内容完全一致。
    expect(result.result.sourceOutcome).toMatchObject({
      primedArtifacts: [
        expect.objectContaining({ address: "/seats/dev-impl/RECAP.md" }),
        expect.objectContaining({ address: "/seats/dev-impl/LEARNED.md" }),
      ],
      gaps: [],
    });
    // 已交付的准备 packet 会点名产物（通过与新恢复 packet 相同的已交付 tmux 接缝发送）。
    const delivered = sendText.mock.calls.map((call) => String(call[1] ?? call[0])).join("\n");
    expect(delivered).toContain("/seats/dev-impl/RECAP.md");
    expect(delivered).toContain("/seats/dev-impl/LEARNED.md");
    // Rebuild 是全新的 runtime 对话，绝不是 fork/resume 启动。
    const launchOpts = launchHarness.mock.calls.at(-1)?.[1];
    expect(launchOpts?.forkSource).toBeUndefined();
    expect(launchOpts?.resumeToken).toBeUndefined();
  });

  it("rebuild：声明的产物在磁盘缺失时记录为 GAP，不静默丢弃，也不致命", async () => {
    seedSeat();
    artifactExists.mockImplementation((path: string) => !String(path).includes("LEARNED"));

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "degraded-incumbent",
      source: "rebuild",
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok || !("result" in result)) throw new Error("expected handover result");
    expect(result.result.sourceOutcome).toMatchObject({
      primedArtifacts: [expect.objectContaining({ address: "/seats/dev-impl/RECAP.md" })],
      gaps: ["/seats/dev-impl/LEARNED.md"],
    });
  });

  it("rebuild：持久链为空时仍执行，并在结果和交付 packet 中具名说明", async () => {
    const { node } = seedSeat();
    rebuildChain.mockImplementation(() => ({ emptyReason: "no recap chain, no LEARNED, no restore packet for this seat" }));

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "degraded-incumbent",
      source: "rebuild",
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok || !("result" in result)) throw new Error("expected handover result");
    expect(nodeRow(node.id)).toEqual({ continuity_outcome: "rebuilt", handover_result: "complete" });
    expect(result.result.sourceOutcome).toMatchObject({
      primedArtifacts: [],
      gaps: [],
      emptyChainReason: "no recap chain, no LEARNED, no restore packet for this seat",
    });
    const delivered = sendText.mock.calls.map((call) => String(call[1] ?? call[0])).join("\n");
    expect(delivered).toContain("no recap chain, no LEARNED, no restore packet for this seat");
  });

  // ——Mini-req 3：计划与执行一致——

  it("计划与执行器一致：不会为执行阶段以 source_not_supported 拒绝的来源生成 dry-run 修改计划", async () => {
    const sources = ["fresh", "fork:dev-impl@seat-rig", "rebuild"];
    for (const source of sources) {
      seedSeat({ resumeToken: "native-abc" });
      const plan = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source, dryRun: true });
      expect(plan, `dry-run plan for --source ${source}`).toMatchObject({ ok: true });
      const executed = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source });
      if (!executed.ok) {
        expect(executed.code, `execution of --source ${source} refused a source its own plan promised`).not.toBe("source_not_supported");
      }
      db.close();
      db = createFullTestDb();
      rigRepo = new RigRepository(db);
      sessionRegistry = new SessionRegistry(db);
      discoveryRepo = new DiscoveryRepository(db);
      eventBus = new EventBus(db);
      service = newService();
    }
  });

  it("唯一共享来源能力表：每种来源模式都有记录，dry-run 计划从表中生成其创建 successor 步骤", async () => {
    // 对 SeatHandoverSourceMode 使用穷尽 Record；新增模式若未声明记录则无法编译，
    // 本固定测试使记录中的事实传递到计划。
    expect(Object.keys(SEAT_HANDOVER_SOURCE_CAPABILITIES).sort()).toEqual(["discovered", "fork", "fresh", "rebuild"]);
    for (const row of Object.values(SEAT_HANDOVER_SOURCE_CAPABILITIES)) {
      expect(row.executes).toBe(true);
    }
    for (const source of ["fresh", "rebuild", "fork:dev-impl@seat-rig"]) {
      seedSeat();
      const planned = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source, dryRun: true });
      expect(planned.ok).toBe(true);
      if (!planned.ok || !("plan" in planned)) throw new Error("expected plan");
      const step = planned.plan.phases.flatMap((phase) => phase.steps).find((candidate) => candidate.id === "create-successor");
      const mode = source.startsWith("fork") ? "fork" : source;
      expect(step?.description).toContain(SEAT_HANDOVER_SOURCE_CAPABILITIES[mode as keyof typeof SEAT_HANDOVER_SOURCE_CAPABILITIES].contextCarrier);
      db.close();
      db = createFullTestDb();
      rigRepo = new RigRepository(db);
      sessionRegistry = new SessionRegistry(db);
      discoveryRepo = new DiscoveryRepository(db);
      eventBus = new EventBus(db);
      service = newService();
    }
  });


  // ——修复轮次 B2：持久事件就是审计轨迹——

  function lastHandoverEventPayload(): Record<string, unknown> {
    const row = db.prepare("SELECT payload FROM events WHERE type = 'seat.handover_completed' ORDER BY seq DESC LIMIT 1").get() as { payload: string } | undefined;
    if (!row) throw new Error("no persisted seat.handover_completed event");
    return JSON.parse(row.payload);
  }

  it("B2：rebuild 的精确准备集合和缺口持久化到 seat.handover_completed 事件，而不只存在于临时响应", async () => {
    seedSeat();
    artifactExists.mockImplementation((path: string) => !String(path).includes("LEARNED"));

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "degraded-incumbent", source: "rebuild" });

    expect(result).toMatchObject({ ok: true });
    expect(lastHandoverEventPayload().sourceOutcome).toMatchObject({
      mode: "rebuild",
      primedArtifacts: [expect.objectContaining({ address: "/seats/dev-impl/RECAP.md" })],
      gaps: ["/seats/dev-impl/LEARNED.md"],
    });
  });

  it("B2：空 rebuild 链的具名原因持久化到事件", async () => {
    seedSeat();
    rebuildChain.mockImplementation(() => ({ emptyReason: "no recap chain, no LEARNED, no restore packet for this seat" }));

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "degraded-incumbent", source: "rebuild" });

    expect(result).toMatchObject({ ok: true });
    expect(lastHandoverEventPayload().sourceOutcome).toMatchObject({
      mode: "rebuild",
      primedArtifacts: [],
      emptyChainReason: "no recap chain, no LEARNED, no restore packet for this seat",
    });
  });

  it("B2：fork 出处以相同结构持久化到事件", async () => {
    seedSeat({ resumeToken: "native-abc" });

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fork:dev-impl@seat-rig" });

    expect(result).toMatchObject({ ok: true });
    expect(lastHandoverEventPayload().sourceOutcome).toMatchObject({ mode: "fork", forkedFrom: "dev-impl@seat-rig" });
  });

  // ——Mini-req 4：切换中途失败必须如实呈现——

  it("fork：切换中人为制造的启动失败会报告失败步骤，保持绑定不变且席位可恢复，绝不虚假完成", async () => {
    const { node } = seedSeat({ resumeToken: "native-abc" });
    launchHarness.mockImplementation(async () => ({ ok: false, error: "induced: harness died mid-launch" }));

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fork:dev-impl@seat-rig",
    });

    expect(result).toMatchObject({ ok: false, code: "successor_create_failed" });
    if (result.ok) throw new Error("expected failure");
    expect(result.message).toContain("induced: harness died mid-launch");
    // 已记录的部分状态：registry 绑定从未移动，节点记录也没有虚假完成。
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
    expect(nodeRow(node.id).handover_result).not.toBe("complete");
    expect(result.guidance).toMatch(/重新唤醒|绑定未改变/);
  });

  it("rebuild：人为制造的准备交付失败会撤销 successor 候选并报告步骤，绑定保持不变", async () => {
    const { node } = seedSeat();
    sendText.mockImplementation(async () => ({ ok: false, error: "induced: tmux delivery down" }));

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "degraded-incumbent",
      source: "rebuild",
    });

    expect(result).toMatchObject({ ok: false, code: "context_delivery_failed" });
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
    expect(nodeRow(node.id).handover_result).not.toBe("complete");
  });
});


// ——修复轮次 B3：生产链包含最新恢复 packet——

describe("buildRebuildPrimingChain (production resolver, OPR.0.5.5.5 fix B3)", () => {
  let topologyRoot: string;
  let openrigHome: string;
  let seatDir: string;
  const SEAT = "dev-impl@seat-rig";

  function markerPath(): string {
    return join(openrigHome, "compaction", "restore-pending", "dev-impl@seat-rig.json");
  }

  function chain(): Array<{ address: string; label: string }> {
    const result = buildRebuildPrimingChain(SEAT, { topologyRoot, openrigHome });
    if (!("artifacts" in result)) throw new Error(`expected artifacts, got: ${JSON.stringify(result)}`);
    return result.artifacts;
  }

  beforeEach(() => {
    topologyRoot = mkdtempSync(join(tmpdir(), "s05b3-topo-"));
    openrigHome = mkdtempSync(join(tmpdir(), "s05b3-home-"));
    seatDir = join(topologyRoot, "rigs", "seat-rig", "seats", "dev-impl");
    mkdirSync(seatDir, { recursive: true });
    mkdirSync(join(openrigHome, "compaction", "restore-pending"), { recursive: true });
  });

  afterEach(() => {
    rmSync(topologyRoot, { recursive: true, force: true });
    rmSync(openrigHome, { recursive: true, force: true });
  });

  it("合法 restore-pending 标记的 packet 在链中具名，位于 LEARNED 之后、被取代的 recap 之前", () => {
    const packetDir = join(openrigHome, "packet-x");
    mkdirSync(packetDir, { recursive: true });
    writeFileSync(markerPath(), JSON.stringify({ version: 1, createdAt: "2026-08-27T00:00:00Z", outputDir: packetDir }));
    mkdirSync(join(seatDir, "recap-superseded"), { recursive: true });
    writeFileSync(join(seatDir, "recap-superseded", "RECAP-1000.md"), "old recap");

    const addresses = chain().map((artifact) => artifact.address);
    expect(addresses).toEqual([
      join(seatDir, "RECAP.md"),
      join(seatDir, "LEARNED.md"),
      packetDir,
      join(seatDir, "recap-superseded", "RECAP-1000.md"),
    ]);
    const packet = chain().find((artifact) => artifact.address === packetDir);
    expect(packet?.label).toContain("restore packet");
  });

  it("packet 目录已消失的标记仍声明地址（服务将其记录为具名缺口，绝不静默丢弃）", () => {
    const goneDir = join(openrigHome, "packet-deleted");
    writeFileSync(markerPath(), JSON.stringify({ version: 1, outputDir: goneDir }));

    const addresses = chain().map((artifact) => artifact.address);
    expect(addresses).toContain(goneDir);
  });

  it("无法解析的标记被如实具名：声明标记文件本身并附无效标签，绝不伪造连续性", () => {
    writeFileSync(markerPath(), "{not json");

    const marker = chain().find((artifact) => artifact.address === markerPath());
    expect(marker, "invalid marker named, not silently skipped").toBeDefined();
    expect(marker?.label).toContain("无效");
  });

  it("回归：缺少标记时保持既有优先级（RECAP、LEARNED、被取代项按最新优先）", () => {
    mkdirSync(join(seatDir, "recap-superseded"), { recursive: true });
    writeFileSync(join(seatDir, "recap-superseded", "RECAP-1000.md"), "older");
    writeFileSync(join(seatDir, "recap-superseded", "RECAP-2000.md"), "newer");

    expect(chain().map((artifact) => artifact.address)).toEqual([
      join(seatDir, "RECAP.md"),
      join(seatDir, "LEARNED.md"),
      join(seatDir, "recap-superseded", "RECAP-2000.md"),
      join(seatDir, "recap-superseded", "RECAP-1000.md"),
    ]);
  });

  it("无法解析的席位引用形成具名空链，绝不猜测", () => {
    const result = buildRebuildPrimingChain("not a canonical ref", { topologyRoot, openrigHome });
    expect(result).toMatchObject({ emptyReason: expect.stringContaining("无法解析为 canonical") });
  });
});
