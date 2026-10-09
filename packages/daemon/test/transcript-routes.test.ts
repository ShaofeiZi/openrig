import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { transcriptRoutes } from "../src/routes/transcripts.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { vi } from "vitest";

function setupDb(): Database.Database {
  const db = createDb();
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema, checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema, agentspecRebootSchema, externalCliAttachmentSchema]);
  return db;
}

function createApp(opts: {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  transcriptStore: TranscriptStore;
  tmuxAdapter?: TmuxAdapter;
}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("rigRepo" as never, opts.rigRepo);
    c.set("sessionRegistry" as never, opts.sessionRegistry);
    c.set("transcriptStore" as never, opts.transcriptStore);
    c.set("db" as never, opts.db);
    c.set("tmuxAdapter" as never, opts.tmuxAdapter);
    await next();
  });
  app.route("/api/transcripts", transcriptRoutes());
  return app;
}

describe("transcript 路由", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let tmpDir: string;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    tmpDir = mkdtempSync(join(tmpdir(), "transcript-routes-"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedRigWithTranscript(content: string) {
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev-impl", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@my-rig");
    sessionRegistry.updateStatus(session.id, "running");

    const store = new TranscriptStore({ transcriptsRoot: tmpDir, enabled: true });
    store.ensureTranscriptDir("my-rig");
    const filePath = store.getTranscriptPath("my-rig", "dev-impl@my-rig");
    writeFileSync(filePath, content);

    return { rig, node, session, store };
  }

  it("GET /tail 为现有 transcript 返回 200 与 stripped content", async () => {
    const { store } = seedRigWithTranscript("line1\n\x1b[1mline2\x1b[0m\nline3\n");
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: store });

    const res = await app.request("/api/transcripts/dev-impl@my-rig/tail?lines=10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session).toBe("dev-impl@my-rig");
    expect(body.content).toContain("line2"); // 已移除 ANSI
    expect(body.content).not.toContain("\x1b[");
  });

  it("GET /tail 为 fresh capture 报告 live transcript ingest metadata", async () => {
    const { store } = seedRigWithTranscript("recent work\n");
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: store });

    const res = await app.request("/api/transcripts/dev-impl@my-rig/tail?lines=10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ingestHealth).toEqual(expect.objectContaining({
      state: "live",
      runtime: "claude-code",
    }));
  });

  it("现有 transcript stale 且 capture 无法重启时，GET /tail 显著失败", async () => {
    const { store } = seedRigWithTranscript("old misleading work\n");
    const transcriptPath = store.getTranscriptPath("my-rig", "dev-impl@my-rig");
    const old = new Date(Date.now() - 60_000);
    utimesSync(transcriptPath, old, old);
    const capturePaneContent = vi.fn(async () => null);
    const app = createApp({
      db,
      rigRepo,
      sessionRegistry,
      transcriptStore: store,
      tmuxAdapter: { capturePaneContent } as unknown as TmuxAdapter,
    });

    const res = await app.request("/api/transcripts/dev-impl@my-rig/tail?lines=10");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("transcript 摄入已降级");
    expect(body.error).toContain("claude-code");
    expect(body.ingestHealth).toEqual(expect.objectContaining({
      state: "degraded",
      runtime: "claude-code",
      reason: "capture_stale",
    }));
  });

  it("GET /tail 使用未知 session 时返回带指引的 404", async () => {
    const store = new TranscriptStore({ transcriptsRoot: tmpDir, enabled: true });
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: store });

    const res = await app.request("/api/transcripts/nonexistent-session/tail");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("未找到会话");
    expect(body.error).toContain("zrig ps");
  });

  it("GET /tail 使用已知 session 但无 transcript 文件时返回带指引的 404", async () => {
    // 创建 rig + session，但不创建 transcript 文件
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev-impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node.id, "dev-impl@my-rig");

    const store = new TranscriptStore({ transcriptsRoot: tmpDir, enabled: true });
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: store });

    const res = await app.request("/api/transcripts/dev-impl@my-rig/tail");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("无 transcript");
    expect(body.error).toContain("下次工作组启动时自动开始");
  });

  it("GET /tail 为无 transcript 文件的 tmux-bound session 注册 transcript rotation timer", async () => {
    const {
      getActiveRotationCount,
      clearAllTranscriptRotationsForTest,
    } = await import("../src/domain/transcript-rotation.js");
    clearAllTranscriptRotationsForTest();
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev-impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node.id, "dev-impl@my-rig");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@my-rig" });

    const store = new TranscriptStore({ transcriptsRoot: tmpDir, enabled: true });
    vi.spyOn(store, "ensureTranscriptDir").mockReturnValue(true);
    // V1 pre-release 第 1 项：capture-pane 返回 null（尚无 terminal content），因此 rotation tick
    // 是 no-op write——transcript 文件保持为空，readTail 返回 null；在首次真实 capture 前轮询的
    // client 会看到 legacy “started now” 404。
    const capturePaneSpy = vi.fn(async () => null);
    const app = createApp({
      db,
      rigRepo,
      sessionRegistry,
      transcriptStore: store,
      tmuxAdapter: { capturePaneContent: capturePaneSpy } as unknown as TmuxAdapter,
    });

    const res = await app.request("/api/transcripts/dev-impl@my-rig/tail");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("现已启动");
    expect(getActiveRotationCount()).toBeGreaterThan(0);
    clearAllTranscriptRotationsForTest();
  });

  it("lazy-start capture 后若 output 很快出现，GET /tail 返回 warmed content", async () => {
    const {
      getActiveRotationCount,
      clearAllTranscriptRotationsForTest,
    } = await import("../src/domain/transcript-rotation.js");
    clearAllTranscriptRotationsForTest();
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev-impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node.id, "dev-impl@my-rig");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@my-rig" });

    const store = new TranscriptStore({ transcriptsRoot: tmpDir, enabled: true });
    vi.spyOn(store, "ensureTranscriptDir").mockReturnValue(true);
    const capturePaneSpy = vi.fn(async () => "READY\n");
    const app = createApp({
      db,
      rigRepo,
      sessionRegistry,
      transcriptStore: store,
      tmuxAdapter: { capturePaneContent: capturePaneSpy } as unknown as TmuxAdapter,
    });

    const res = await app.request("/api/transcripts/dev-impl@my-rig/tail");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("READY\n");
    expect(getActiveRotationCount()).toBeGreaterThan(0);
    clearAllTranscriptRotationsForTest();
  });

  it("GET /tail 使用非正 lines 时 normalize 为默认值", async () => {
    const { store } = seedRigWithTranscript("line1\nline2\nline3\n");
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: store });

    const res = await app.request("/api/transcripts/dev-impl@my-rig/tail?lines=-5");
    expect(res.status).toBe(200);
    const body = await res.json();
    // normalize 为默认 50，response 包含 normalized value
    expect(body.lines).toBe(50);
  });

  it("transcript 禁用时 GET /tail 返回带指引的 404", async () => {
    seedRigWithTranscript("content");
    const disabledStore = new TranscriptStore({ transcriptsRoot: tmpDir, enabled: false });
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: disabledStore });

    const res = await app.request("/api/transcripts/dev-impl@my-rig/tail");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("已禁用");
  });

  it("有匹配时 GET /grep 返回 200 与匹配行", async () => {
    const { store } = seedRigWithTranscript("hello world\ndecision made\nfoo bar\ndecision final\n");
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: store });

    const res = await app.request("/api/transcripts/dev-impl@my-rig/grep?pattern=decision");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session).toBe("dev-impl@my-rig");
    expect(body.matches).toHaveLength(2);
    expect(body.matches[0]).toBe("decision made");
    expect(body.matches[1]).toBe("decision final");
  });

  it("GET /grep 缺少 pattern 时返回 400", async () => {
    const { store } = seedRigWithTranscript("content");
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: store });

    const res = await app.request("/api/transcripts/dev-impl@my-rig/grep");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("pattern");
  });

  it("GET /tail 使用跨工作组歧义 session name 时返回 409", async () => {
    // 创建两个具有相同 name 与 session name 的工作组
    const rig1 = rigRepo.createRig("my-rig");
    const node1 = rigRepo.addNode(rig1.id, "dev-impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node1.id, "dev-impl@my-rig");

    const rig2 = rigRepo.createRig("other-rig");
    const node2 = rigRepo.addNode(rig2.id, "dev-impl2", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node2.id, "dev-impl@my-rig");

    const store = new TranscriptStore({ transcriptsRoot: tmpDir, enabled: true });
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: store });

    const res = await app.request("/api/transcripts/dev-impl@my-rig/tail");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("有歧义");
  });

  it("GET /grep 使用无效 regex 时返回 400", async () => {
    const { store } = seedRigWithTranscript("content");
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: store });

    const res = await app.request("/api/transcripts/dev-impl@my-rig/grep?pattern=[invalid");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("非法 grep 模式");
  });

  // ─────────────────────────────────────────────────────────────────────
  // M2c-Daemon——GET /:session/full route 测试。
  //
  // 根据 orch decision approved-option-a-open-local-transcript-full-read-with-redaction
  //（qitem-20260502020833-68e4eca3）：full-read route 采用现有 tail/grep posture（open route、
  // daemon-local trust boundary）。Redaction 是此 slice 的保护 primitive。由于 daemon 当前不存在
  // caller-identity / session-scope primitive，原请求的 session-scoped denial 测试由 orch 重构为
  // session-resolution failure（404 unknown session）。
  //
  // 测试计划（每次 dispatch 4 个 case + orch easy-case 的 1 个 ambiguity bonus）：
  // (a) authorized success → response 中含完整 transcript content
  // (b) session-resolution failure → 404 unknown session
  // (c) route-level redaction → wire payload 中没有 synthetic credential pattern
  // (d) transcript disabled/missing → 显式 404
  //（额外）ambiguity → 409（与 tail/grep precedent 一致）
  // ─────────────────────────────────────────────────────────────────────

  it("GET /full 为现有 session 返回 200 与完整 transcript content（success case）", async () => {
    const fixture = "first line\nsecond line\nthird line\n";
    const { store } = seedRigWithTranscript(fixture);
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: store });

    const res = await app.request("/api/transcripts/dev-impl@my-rig/full");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session).toBe("dev-impl@my-rig");
    expect(typeof body.content).toBe("string");
    expect(body.content).toContain("first line");
    expect(body.content).toContain("second line");
    expect(body.content).toContain("third line");
  });

  it("GET /full 使用未知 session 时返回 404（session-resolution failure；按 orch 重构）", async () => {
    // Orch 重构：由于不存在 caller-identity/session-scope primitive，以 session-resolution
    // failure 替代 session-scoped denial。
    const store = new TranscriptStore({ transcriptsRoot: tmpDir, enabled: true });
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: store });

    const res = await app.request("/api/transcripts/nonexistent-session/full");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("未找到会话");
    expect(body.error).toContain("zrig ps");
  });

  it("GET /full 应用 route-level redaction：wire payload 中不含 synthetic credential pattern", async () => {
    // synthetic credential 覆盖 5 种 v0 pattern 中的 4 种（sk-*、gh*_*、github_pat_*、Bearer *）。
    // 不是真实 credential。遵循 Quality Lesson v9。
    const fixture = [
      "INFO startup",
      "user pasted token sk-FakeAbCdEfGhIjKlMnOpQr in chat",
      "another sample token ghp_FakeAbCdEfGhIjKlMnOpQrSt was used",
      "fine-grained pat: github_pat_FakeAbCdEfGhIjKlMnOpQrSt",
      "auth header: Bearer FakeAbCdEfGhIjKlMnOpQrStUvWxYz123456",
      "trailing line",
    ].join("\n");
    const { store } = seedRigWithTranscript(fixture);
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: store });

    const res = await app.request("/api/transcripts/dev-impl@my-rig/full");
    expect(res.status).toBe(200);
    const body = await res.json();
    // Wire payload 绝不能包含任何植入的 credential pattern。
    expect(body.content).not.toContain("sk-FakeAbCdEfGhIjKlMnOpQr");
    expect(body.content).not.toContain("ghp_FakeAbCdEfGhIjKlMnOpQrSt");
    expect(body.content).not.toContain("github_pat_FakeAbCdEfGhIjKlMnOpQrSt");
    expect(body.content).not.toContain("Bearer FakeAbCdEfGhIjKlMnOpQrStUvWxYz123456");
    // Route-level redaction 在每处留下 [REDACTED] marker。
    expect(body.content).toContain("[REDACTED]");
    // 保留周围 context（redaction 在行级别是非破坏性的）。
    expect(body.content).toContain("INFO startup");
    expect(body.content).toContain("trailing line");
  });

  it("transcript 禁用时 GET /full 返回带指引的 404（disabled case）", async () => {
    seedRigWithTranscript("content");
    const disabledStore = new TranscriptStore({ transcriptsRoot: tmpDir, enabled: false });
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: disabledStore });

    const res = await app.request("/api/transcripts/dev-impl@my-rig/full");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("已禁用");
  });

  it("GET /full 使用已知 session 但无 transcript 文件时返回带指引的 404（missing case）", async () => {
    // 创建 rig + session，但不创建 transcript 文件。
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev-impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node.id, "dev-impl@my-rig");

    const store = new TranscriptStore({ transcriptsRoot: tmpDir, enabled: true });
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: store });

    const res = await app.request("/api/transcripts/dev-impl@my-rig/full");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("无 transcript");
  });

  it("GET /full 使用跨工作组歧义 session name 时返回 409（与 tail/grep precedent 一致）", async () => {
    // 两个工作组使用相同 session name → ambiguity 409（镜像 tail/grep 行为）。
    const rig1 = rigRepo.createRig("my-rig");
    const node1 = rigRepo.addNode(rig1.id, "dev-impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node1.id, "dev-impl@my-rig");

    const rig2 = rigRepo.createRig("other-rig");
    const node2 = rigRepo.addNode(rig2.id, "dev-impl2", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node2.id, "dev-impl@my-rig");

    const store = new TranscriptStore({ transcriptsRoot: tmpDir, enabled: true });
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: store });

    const res = await app.request("/api/transcripts/dev-impl@my-rig/full");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("有歧义");
  });
});
