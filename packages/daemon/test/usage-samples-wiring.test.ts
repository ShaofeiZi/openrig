// 51-08 A1——接线固定项：序列由真实的 30 秒 tick（ContextMonitor.pollOnce）累积，而非测试直接
// 调用 store。PM 裁定 1：复用现有 tick，不增加并行 sampler。RED-first：在 ContextMonitor 接受
// UsageSamplesStore 之前编写。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Database } from "better-sqlite3";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { packagesSchema } from "../src/db/migrations/008_packages.js";
import { installJournalSchema } from "../src/db/migrations/009_install_journal.js";
import { journalSeqSchema } from "../src/db/migrations/010_journal_seq.js";
import { bootstrapSchema } from "../src/db/migrations/011_bootstrap.js";
import { discoverySchema } from "../src/db/migrations/012_discovery.js";
import { discoveryFkFix } from "../src/db/migrations/013_discovery_fk_fix.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { podNamespaceSchema } from "../src/db/migrations/017_pod_namespace.js";
import { contextUsageSchema } from "../src/db/migrations/018_context_usage.js";
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";
import { rigArchiveSchema } from "../src/db/migrations/042_rig_archive.js";
import { usageSamplesSchema } from "../src/db/migrations/062_usage_samples.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { ContextMonitor } from "../src/domain/context-monitor.js";
import { UsageSamplesStore, type ProviderWindowSampleInput } from "../src/domain/usage-samples-store.js";
import type { ReadinessResult } from "../src/domain/runtime-adapter.js";

const ALL_MIGRATIONS = [
  coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema,
  checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema,
  packagesSchema, installJournalSchema, journalSeqSchema, bootstrapSchema,
  discoverySchema, discoveryFkFix, agentspecRebootSchema, podNamespaceSchema,
  contextUsageSchema, externalCliAttachmentSchema, rigArchiveSchema,
  usageSamplesSchema,
];

describe("51-08 A1 接线——序列从真实 poll tick 累积", () => {
  let db: Database;
  let store: ContextUsageStore;
  let samples: UsageSamplesStore;
  let monitor: ContextMonitor;
  let tmpDir: string;
  let sessionName: string;
  let providerRows: ProviderWindowSampleInput[];

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    tmpDir = join(tmpdir(), `usage-samples-wiring-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpDir, "state", "context-usage"), { recursive: true });
    store = new ContextUsageStore(db, { stateDir: tmpDir, codexHomeDir: tmpDir });
    samples = new UsageSamplesStore(db);
    providerRows = [];

    const rig = rigRepo.createRig("t-rig");
    const node = rigRepo.addNode(rig.id, "dev.qa", { runtime: "claude-code" });
    sessionName = "dev-qa@t-rig";
    const session = sessionRegistry.registerSession(node.id, sessionName);
    db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(session.id);

    monitor = new ContextMonitor(
      db,
      store,
      {
        ensureContextCollector: vi.fn(),
        checkReady: vi.fn(async (): Promise<ReadinessResult> => ({ ready: true })),
      },
      undefined,
      undefined,
      samples,
      () => providerRows,
    );
  });

  afterEach(() => {
    monitor.stop();
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSidecar(over: Record<string, unknown> = {}) {
    const safe = sessionName.replace(/[^a-zA-Z0-9@._-]/g, "_");
    writeFileSync(
      join(tmpDir, "state", "context-usage", `${safe}.json`),
      JSON.stringify({
        session_name: sessionName,
        sampled_at: "2026-08-07T09:00:00.000Z",
        context_window: {
          context_window_size: 200000,
          used_percentage: 10,
          remaining_percentage: 90,
          total_input_tokens: 1000,
          total_output_tokens: 100,
        },
        ...over,
      }),
    );
  }

  const seriesCount = (lane: string) =>
    (db.prepare("SELECT COUNT(*) AS n FROM usage_samples WHERE lane = ?").get(lane) as { n: number }).n;

  it("对未变化 sidecar 轮询两次只追加一条 context 行；sidecar 前进后追加第二条", async () => {
    writeSidecar();
    await monitor.pollOnce();
    await monitor.pollOnce();
    expect(seriesCount("context")).toBe(1); // idle seat: zero growth on the second tick
    writeSidecar({
      sampled_at: "2026-08-07T09:00:30.000Z",
      context_window: {
        context_window_size: 200000,
        used_percentage: 12,
        remaining_percentage: 88,
        total_input_tokens: 4000,
        total_output_tokens: 300,
      },
    });
    await monitor.pollOnce();
    expect(seriesCount("context")).toBe(2);
    // 时间点通道回归固定项：context_usage 保持为单条 upsert 行。
    const cu = db.prepare("SELECT COUNT(*) AS n FROM context_usage").get() as { n: number };
    expect(cu.n).toBe(1);
  });

  it("provider-window supplier 在同一 tick 中排空，且仅在前进时写入", async () => {
    writeSidecar();
    providerRows = [
      { seatSession: sessionName, window: "five_hour", usedPercent: 41, resetsAt: "2026-08-07T12:00:00.000Z", asOf: "2026-08-07T09:00:00.000Z" },
      { seatSession: sessionName, window: "weekly", usedPercent: 12, resetsAt: null, asOf: "2026-08-07T09:00:00.000Z" },
    ];
    await monitor.pollOnce();
    expect(seriesCount("provider_window")).toBe(2);
    await monitor.pollOnce(); // unchanged supplier output → no growth
    expect(seriesCount("provider_window")).toBe(2);
    providerRows = [
      { seatSession: sessionName, window: "five_hour", usedPercent: 44, resetsAt: "2026-08-07T12:00:00.000Z", asOf: "2026-08-07T09:05:00.000Z" },
    ];
    await monitor.pollOnce();
    expect(seriesCount("provider_window")).toBe(3);
  });

  it("抛错的 provider supplier 不会中断轮询（与 enforcer 接缝保持防御性一致）", async () => {
    writeSidecar();
    const boom = () => {
      throw new Error("supplier down");
    };
    const m2 = new ContextMonitor(
      db,
      store,
      { ensureContextCollector: vi.fn(), checkReady: vi.fn(async (): Promise<ReadinessResult> => ({ ready: true })) },
      undefined,
      undefined,
      samples,
      boom,
    );
    await expect(m2.pollOnce()).resolves.toBeUndefined();
    expect(seriesCount("context")).toBe(1); // context lane still landed
    m2.stop();
  });
});
