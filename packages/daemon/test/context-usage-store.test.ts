import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RigRepository } from "../src/domain/rig-repository.js";
import { ContextUsageStore, FRESHNESS_THRESHOLD_MS } from "../src/domain/context-usage-store.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


describe("ContextUsageStore 上下文用量存储", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let store: ContextUsageStore;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    store = new ContextUsageStore(db, { stateDir: "/tmp/openrig-test" });
  });

  afterEach(() => { db.close(); });

  function seedNode(logicalId = "dev.impl") {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code" });
    return { rig, node };
  }

  const VALID_SIDECAR = {
    context_window: {
      context_window_size: 200000,
      used_percentage: 67,
      remaining_percentage: 33,
      total_input_tokens: 120000,
      total_output_tokens: 14000,
      current_usage: "67% used",
    },
    session_id: "sess-123",
    session_name: "dev-impl@test-rig",
    transcript_path: "/tmp/transcripts/test.log",
    sampled_at: new Date().toISOString(),
  };

  const VALID_SIDECAR_WITH_OBJECT_USAGE = {
    ...VALID_SIDECAR,
    context_window: {
      ...VALID_SIDECAR.context_window,
      current_usage: {
        input_tokens: 3,
        output_tokens: 129,
        cache_creation_input_tokens: 79,
        cache_read_input_tokens: 251672,
      },
    },
  };

  // T1：有效 sidecar normalize 为 known ContextUsage
  it("有效 sidecar JSON normalize 为 known ContextUsage", () => {
    const usage = store.normalizeSample(VALID_SIDECAR);
    expect(usage.availability).toBe("known");
    expect(usage.reason).toBeNull();
    expect(usage.source).toBe("claude_statusline_json");
    expect(usage.usedPercentage).toBe(67);
    expect(usage.remainingPercentage).toBe(33);
    expect(usage.contextWindowSize).toBe(200000);
    expect(usage.totalInputTokens).toBe(120000);
    expect(usage.totalOutputTokens).toBe(14000);
    expect(usage.currentUsage).toBe("67% used");
    expect(usage.sessionId).toBe("sess-123");
    expect(usage.sessionName).toBe("dev-impl@test-rig");
    expect(usage.transcriptPath).toBe("/tmp/transcripts/test.log");
    expect(usage.fresh).toBe(true);
  });

  it("object-shaped current_usage 保留为 JSON 文本", () => {
    const usage = store.normalizeSample(VALID_SIDECAR_WITH_OBJECT_USAGE);
    expect(usage.availability).toBe("known");
    expect(usage.currentUsage).toBe(
      JSON.stringify(VALID_SIDECAR_WITH_OBJECT_USAGE.context_window.current_usage),
    );
  });

  it("Codex token_count JSONL normalize 为 known ContextUsage", () => {
    const codexHome = join(tmpdir(), `codex-context-${Date.now()}`);
    const codexDir = join(codexHome, ".codex");
    const rolloutPath = join(codexDir, "sessions", "rollout-thread-1.jsonl");
    mkdirSync(join(codexDir, "sessions"), { recursive: true });

    const stateDbPath = join(codexDir, "state_5.sqlite");
    const stateDb = new BetterSqlite3(stateDbPath);
    try {
      stateDb.prepare("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)").run();
      stateDb.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run("thread-1", rolloutPath);
    } finally {
      stateDb.close();
    }

    writeFileSync(rolloutPath, [
      JSON.stringify({ type: "event_msg", payload: { type: "other" } }),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 227139,
              output_tokens: 611,
              total_tokens: 227750,
            },
            model_context_window: 258400,
          },
        },
      }),
    ].join("\n"));

    const codexStore = new ContextUsageStore(db, { stateDir: "/tmp/openrig-test", codexHomeDir: codexHome });
    const usage = codexStore.readCodexAndNormalize({
      threadId: "thread-1",
      sessionName: "dev-qa@test-rig",
    });

    expect(usage.availability).toBe("known");
    expect(usage.reason).toBeNull();
    expect(usage.source).toBe("codex_token_count_jsonl");
    expect(usage.usedPercentage).toBe(88);
    expect(usage.remainingPercentage).toBe(12);
    expect(usage.contextWindowSize).toBe(258400);
    expect(usage.totalInputTokens).toBe(227139);
    expect(usage.totalOutputTokens).toBe(611);
    expect(usage.sessionId).toBe("thread-1");
    expect(usage.sessionName).toBe("dev-qa@test-rig");
    expect(usage.transcriptPath).toBe(rolloutPath);
    expect(usage.currentUsage).toContain("\"model_context_window\":258400");

    rmSync(codexHome, { recursive: true, force: true });
  });

  // T2：sidecar 缺失 -> 带 reason 的 unknown
  it("null raw 生成 reason 为 missing_sidecar 的 unknown", () => {
    const usage = store.normalizeSample(null);
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("missing_sidecar");
    expect(usage.usedPercentage).toBeNull();
    expect(usage.fresh).toBe(false);
  });

  // T3：无效 JSON（缺少 context_window）-> parse_error
  it("无 context_window 的 raw 生成 reason 为 parse_error 的 unknown", () => {
    const usage = store.normalizeSample({ session_id: "x" } as any);
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("parse_error");
  });

  // T4：stale sample -> fresh=false，但保留值
  it("stale sample 的 fresh=false，但保留持久化值", () => {
    const stale = {
      ...VALID_SIDECAR,
      sampled_at: new Date(Date.now() - FRESHNESS_THRESHOLD_MS - 60_000).toISOString(),
    };
    const usage = store.normalizeSample(stale);
    expect(usage.availability).toBe("known");
    expect(usage.fresh).toBe(false);
    expect(usage.usedPercentage).toBe(67); // values retained, not erased
  });

  // T5：persist + getForNode round-trip
  it("persist 执行 upsert，getForNode 返回带 freshness 的结果", () => {
    const { node } = seedNode();
    const usage = store.normalizeSample(VALID_SIDECAR);
    store.persist(node.id, usage);

    const retrieved = store.getForNode(node.id, "dev-impl@test-rig");
    expect(retrieved.availability).toBe("known");
    expect(retrieved.usedPercentage).toBe(67);
    expect(retrieved.sessionName).toBe("dev-impl@test-rig");
  });

  // T6：对不存在 node 调用 getForNode -> unknown
  it("对不存在 node 调用 getForNode 时返回 unknown", () => {
    const result = store.getForNode("nonexistent", "some-session");
    expect(result.availability).toBe("unknown");
    expect(result.reason).toBe("no_data");
  });

  // T7：unknownUsage factory
  it("unknownUsage 生成正确 shape", () => {
    const usage = store.unknownUsage("unsupported_runtime");
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("unsupported_runtime");
    expect(usage.usedPercentage).toBeNull();
    expect(usage.fresh).toBe(false);
    expect(usage.source).toBeNull();
  });

  // OPR.0.5.9.5 Wave A：runtime telemetry 位于 state/ 下，让 $OPENRIG_HOME/context 可供
  // addressable context library 使用。
  it("getSidecarPath 返回 state/context-usage/ 下的路径", () => {
    const path = store.getSidecarPath("dev-impl@test-rig");
    expect(path).toBe("/tmp/openrig-test/state/context-usage/dev-impl@test-rig.json");
  });

  // T9：freshness threshold 集中定义
  it("FRESHNESS_THRESHOLD_MS 已导出且一致使用", () => {
    expect(typeof FRESHNESS_THRESHOLD_MS).toBe("number");
    expect(FRESHNESS_THRESHOLD_MS).toBe(600_000);
  });

  // T10：删除 node 时级联删除 context_usage row
  it("删除 node 时级联删除 context_usage", () => {
    const { rig, node } = seedNode();
    store.persist(node.id, store.normalizeSample(VALID_SIDECAR));

    // 验证 row 存在
    const before = db.prepare("SELECT COUNT(*) as c FROM context_usage WHERE node_id = ?").get(node.id) as { c: number };
    expect(before.c).toBe(1);

    // 删除 node（cascade 应移除 context_usage）
    db.prepare("DELETE FROM nodes WHERE id = ?").run(node.id);

    const after = db.prepare("SELECT COUNT(*) as c FROM context_usage WHERE node_id = ?").get(node.id) as { c: number };
    expect(after.c).toBe(0);
  });

  // T11：getForNode session 不匹配 -> unknown
  it("session_name 不匹配时 getForNode 返回 unknown", () => {
    const { node } = seedNode();
    const usage = store.normalizeSample(VALID_SIDECAR);
    store.persist(node.id, usage);

    const result = store.getForNode(node.id, "different-session@new-rig");
    expect(result.availability).toBe("unknown");
    expect(result.reason).toBe("session_mismatch");
  });

  // T12：getForNodes 批量 session 不匹配
  it("getForNodes 在 batch 中为不匹配 session 返回 unknown", () => {
    const { node } = seedNode();
    const usage = store.normalizeSample(VALID_SIDECAR);
    store.persist(node.id, usage);

    const results = store.getForNodes([
      { nodeId: node.id, currentSessionName: "different-session" },
    ]);

    expect(results.get(node.id)?.availability).toBe("unknown");
    expect(results.get(node.id)?.reason).toBe("session_mismatch");
  });

  // T12b：getForNodes 的 currentSessionName 为 null -> not_managed
  it("currentSessionName 为 null 时 getForNodes 返回 unknown", () => {
    const { node } = seedNode();
    store.persist(node.id, store.normalizeSample(VALID_SIDECAR));

    const results = store.getForNodes([
      { nodeId: node.id, currentSessionName: null },
    ]);

    expect(results.get(node.id)?.availability).toBe("unknown");
    expect(results.get(node.id)?.reason).toBe("not_managed");
  });

  // T14：readSidecar 文件缺失 -> { ok: false, reason: 'missing_sidecar' }
  it("文件不存在时 readSidecar 返回 missing_sidecar", () => {
    const result = store.readSidecar("nonexistent-session");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_sidecar");
  });

  it("优先读取 canonical context usage，仅在其缺失时回退到 legacy 0.5.8 sidecar", () => {
    const home = join(tmpdir(), `context-bridge-${Date.now()}`);
    const sessionName = "dev-impl@test-rig";
    const canonical = join(home, "state", "context-usage", `${sessionName}.json`);
    const legacy = join(home, "context", `${sessionName}.json`);
    mkdirSync(join(home, "state", "context-usage"), { recursive: true });
    mkdirSync(join(home, "context"), { recursive: true });
    writeFileSync(legacy, JSON.stringify({
      ...VALID_SIDECAR,
      context_window: { ...VALID_SIDECAR.context_window, used_percentage: 41 },
    }));

    const bridge = new ContextUsageStore(db, { stateDir: home });
    expect(bridge.readAndNormalize(sessionName).usedPercentage).toBe(41);

    writeFileSync(canonical, JSON.stringify({
      ...VALID_SIDECAR,
      context_window: { ...VALID_SIDECAR.context_window, used_percentage: 73 },
    }));
    expect(bridge.readAndNormalize(sessionName).usedPercentage).toBe(73);

    writeFileSync(canonical, "not json");
    expect(bridge.readAndNormalize(sessionName).reason).toBe("parse_error");
    rmSync(home, { recursive: true, force: true });
  });

  // T15：readSidecar 无效 JSON 文件 -> { ok: false, reason: 'parse_error' }
  it("sidecar JSON 文件无效时 readSidecar 返回 parse_error", () => {
    const tmpDir = join(tmpdir(), `context-test-${Date.now()}`);
    const contextDir = join(tmpDir, "state", "context-usage");
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(join(contextDir, "bad-session.json"), "this is not json {{{");

    const tmpStore = new ContextUsageStore(db, { stateDir: tmpDir });
    const result = tmpStore.readSidecar("bad-session");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("parse_error");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  // T16：readAndNormalize 在完整路径中区分 missing 与 parse_error
  it("文件缺失时 readAndNormalize 生成 missing_sidecar", () => {
    const usage = store.readAndNormalize("totally-missing");
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("missing_sidecar");
  });

  it("JSON 文件无效时 readAndNormalize 生成 parse_error", () => {
    const tmpDir = join(tmpdir(), `context-test-parse-${Date.now()}`);
    const contextDir = join(tmpDir, "state", "context-usage");
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(join(contextDir, "corrupt.json"), "not valid json!!!");

    const tmpStore = new ContextUsageStore(db, { stateDir: tmpDir });
    const usage = tmpStore.readAndNormalize("corrupt");
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("parse_error");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  // T13：getForNodes 为匹配 session 返回 known
  it("getForNodes 在 batch 中为匹配 session 返回 known", () => {
    const { node } = seedNode();
    const usage = store.normalizeSample(VALID_SIDECAR);
    store.persist(node.id, usage);

    const results = store.getForNodes([
      { nodeId: node.id, currentSessionName: "dev-impl@test-rig" },
    ]);

    expect(results.get(node.id)?.availability).toBe("known");
    expect(results.get(node.id)?.usedPercentage).toBe(67);
  });

  // ── GHOST-STAGE（c-id）：generation guard ───────────────────────────────────
  // handover 时 successor 在同一 pane 恢复并复用名称，因此 session_mismatch 无法捕获 retiree 的
  // frozen reading。generation guard 拒绝 live occupant boot 前采样的 reading（atom-B tenure
  // boot_at）——只评估 current-gen；pre-boot sample 报告 insufficient-data，绝不泄露 frozen percentage。
  describe("c-id generation guard", () => {
    let genStore: ContextUsageStore;
    let bootAtByNode: Map<string, string | null>;

    beforeEach(() => {
      bootAtByNode = new Map();
      genStore = new ContextUsageStore(db, {
        stateDir: "/tmp/openrig-test",
        resolveOccupantBootAt: (nodeId) => bootAtByNode.get(nodeId) ?? null,
      });
    });

    // reading 携带 retired generation 的 frozen 88%，且名称已复用（因此通过 session_mismatch）。
    // sampledAt 让每个测试可将其放在 successor boot 的相对时刻。
    function persistFrozen(nodeId: string, sampledAtIso: string) {
      genStore.persist(nodeId, genStore.normalizeSample({
        ...VALID_SIDECAR,
        session_name: "dev-impl@test-rig",
        sampled_at: sampledAtIso,
        context_window: { ...VALID_SIDECAR.context_window, used_percentage: 88, remaining_percentage: 12 },
      }));
    }

    // MIXED-GEN WINDOW：successor 在 retiree 最后 sample 后 boot；只有 pre-boot reading 存在 →
    // insufficient-data（stale_generation），且 frozen 88% 绝不能泄露。
    it("拒绝 pre-boot reading，且不泄露 frozen percentage（mixed-gen window）", () => {
      const { node } = seedNode();
      persistFrozen(node.id, "2026-08-07T08:00:00.000Z");
      bootAtByNode.set(node.id, "2026-08-07T08:05:00.000Z"); // successor booted 5m later
      const result = genStore.getForNode(node.id, "dev-impl@test-rig");
      expect(result.availability).toBe("unknown");
      expect(result.reason).toBe("stale_generation");
      expect(result.usedPercentage).toBeNull(); // the 88 is not evaluated across the boundary
    });

    it("接受在 live occupant boot 时或之后采样的 reading（current generation）", () => {
      const { node } = seedNode();
      persistFrozen(node.id, "2026-08-07T08:10:00.000Z"); // sampled after boot
      bootAtByNode.set(node.id, "2026-08-07T08:05:00.000Z");
      const result = genStore.getForNode(node.id, "dev-impl@test-rig");
      expect(result.availability).toBe("known");
      expect(result.usedPercentage).toBe(88);
    });

    it("接受恰好在 boot 时采样的 reading（边界为严格早于）", () => {
      const { node } = seedNode();
      persistFrozen(node.id, "2026-08-07T08:05:00.000Z");
      bootAtByNode.set(node.id, "2026-08-07T08:05:00.000Z");
      const result = genStore.getForNode(node.id, "dev-impl@test-rig");
      expect(result.availability).toBe("known");
    });

    // NOTE-2：tenure 缺失 = UNKNOWN，绝不将 unknown 视为 stale。gate 不生效；reading 仍经过
    // session_mismatch + freshness，但不会作为 prior-gen 被拒绝。
    it("boot time 为 UNKNOWN（tenure 缺失）时不启用 gate", () => {
      const { node } = seedNode();
      persistFrozen(node.id, "2026-08-07T08:00:00.000Z");
      bootAtByNode.set(node.id, null);
      const result = genStore.getForNode(node.id, "dev-impl@test-rig");
      expect(result.availability).toBe("known");
    });

    it("在 batch 路径（getForNodes）应用相同 guard", () => {
      const { node } = seedNode();
      persistFrozen(node.id, "2026-08-07T08:00:00.000Z");
      bootAtByNode.set(node.id, "2026-08-07T08:05:00.000Z");
      const results = genStore.getForNodes([{ nodeId: node.id, currentSessionName: "dev-impl@test-rig" }]);
      expect(results.get(node.id)?.reason).toBe("stale_generation");
    });

    it("未接入 resolver 时绝不启用 gate（opt-in）", () => {
      const plain = new ContextUsageStore(db, { stateDir: "/tmp/openrig-test" });
      const { node } = seedNode();
      plain.persist(node.id, plain.normalizeSample({
        ...VALID_SIDECAR, session_name: "dev-impl@test-rig", sampled_at: "2026-08-07T08:00:00.000Z",
      }));
      const result = plain.getForNode(node.id, "dev-impl@test-rig");
      expect(result.availability).toBe("known");
    });
  });
});
