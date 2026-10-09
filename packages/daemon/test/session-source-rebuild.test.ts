import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";

import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { resolveRebuildArtifacts } from "../src/domain/session-source-rebuild-resolver.js";
import { StartupOrchestrator, type StartupInput } from "../src/domain/startup-orchestrator.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import type { RuntimeAdapter, NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import type { RigSpec, SessionSourceRebuildSpec } from "../src/domain/types.js";

// ============================================================================
// Fixture
// ============================================================================

function baseValidSpec(): Record<string, unknown> {
  return {
    version: "0.2",
    name: "rebuild-test-rig",
    pods: [
      {
        id: "dev",
        label: "Dev pod",
        members: [
          {
            id: "writer",
            agent_ref: "local:agents/writer",
            profile: "default",
            runtime: "claude-code",
            cwd: ".",
          },
        ],
        edges: [],
      },
    ],
    edges: [],
  };
}

function withMember(spec: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const next = JSON.parse(JSON.stringify(spec));
  const pods = next.pods as Array<Record<string, unknown>>;
  const members = pods[0]!.members as Array<Record<string, unknown>>;
  members[0] = { ...members[0], ...override };
  return next;
}

// ============================================================================
// Schema 校验——诚实拒绝矩阵（rebuild-mode row）
// ============================================================================

describe("session_source rebuild——schema 校验", () => {
  it("接受 claude-code + rebuild + 非空 value array 的 artifact_set", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: {
        mode: "rebuild",
        ref: { kind: "artifact_set", value: ["/tmp/CULTURE.md", "/tmp/role.md"] },
      },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("接受 codex + rebuild + artifact_set", () => {
    const spec = withMember(baseValidSpec(), {
      runtime: "codex",
      session_source: { mode: "rebuild", ref: { kind: "artifact_set", value: ["/x/y.md"] } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(true);
  });

  it("拒绝 terminal runtime 使用 rebuild", () => {
    const spec = withMember(baseValidSpec(), {
      runtime: "terminal",
      agent_ref: "builtin:terminal",
      profile: "none",
      session_source: { mode: "rebuild", ref: { kind: "artifact_set", value: ["/x.md"] } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("terminal 运行时没有原生 fork 原语，也没有可重建的 agent 上下文"))).toBe(true);
  });

  it("拒绝 rebuild + ref.kind=native_id（该 kind 属于 fork mode）", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "rebuild", ref: { kind: "native_id", value: "abc" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('rebuild 模式要求 ref.kind: "artifact_set"'))).toBe(true);
    expect(result.errors.some((e) => e.includes('属于 "fork" 模式'))).toBe(true);
  });

  it("拒绝 rebuild + ref.kind=artifact_path", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "rebuild", ref: { kind: "artifact_path", value: "/x" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('rebuild 模式要求 ref.kind: "artifact_set"'))).toBe(true);
  });

  it("拒绝 rebuild + 空 artifact_set value", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "rebuild", ref: { kind: "artifact_set", value: [] } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("rebuild 至少需要一个工件路径"))).toBe(true);
    // error 会提及 trust-precedence 顺序作为指引。
    expect(result.errors.some((e) => e.includes("信任优先级"))).toBe(true);
  });

  it("拒绝 rebuild + 非 array 的 value", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "rebuild", ref: { kind: "artifact_set", value: "/just/one/path.md" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("非空工件路径数组"))).toBe(true);
  });

  it("拒绝 rebuild + 包含空字符串的 value array", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "rebuild", ref: { kind: "artifact_set", value: ["/x.md", "  "] } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("每一项都必须是非空字符串"))).toBe(true);
  });

  it("拒绝 rebuild 使用未知 ref.kind", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "rebuild", ref: { kind: "magic", value: ["/x"] } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('v1 rebuild 模式仅支持 "artifact_set"'))).toBe(true);
  });

  it("拒绝未知 mode（既非 fork 也非 rebuild）", () => {
    const spec = withMember(baseValidSpec(), {
      session_source: { mode: "snapshot", ref: { kind: "native_id", value: "x" } },
    });
    const result = RigSpecSchema.validate(spec);
    expect(result.valid).toBe(false);
    // PL-016 第 4 项：error message 列出当前三个有效 mode。
    expect(result.errors.some((e) => e.includes('支持 "fork"、"rebuild" 或 "agent_image"'))).toBe(true);
  });
});

// ============================================================================
// Codec 往返
// ============================================================================

describe("session_source rebuild——codec 往返", () => {
  it("经过 serialize → parse → normalize 后保留 rebuild + artifact_set + value array", () => {
    const seed: RigSpec = {
      version: "0.2",
      name: "rebuild-test-rig",
      pods: [{
        id: "dev",
        label: "Dev pod",
        members: [{
          id: "writer",
          agentRef: "local:agents/writer",
          profile: "default",
          runtime: "claude-code",
          cwd: ".",
          sessionSource: { mode: "rebuild", ref: { kind: "artifact_set", value: ["/tmp/CULTURE.md", "/tmp/role.md", "/tmp/handover.md"] } },
        }],
        edges: [],
      }],
      edges: [],
    };
    const yaml = RigSpecCodec.serialize(seed);
    expect(yaml).toContain("session_source:");
    expect(yaml).toContain("mode: rebuild");
    expect(yaml).toContain("kind: artifact_set");
    expect(yaml).toContain("/tmp/CULTURE.md");
    expect(yaml).toContain("/tmp/role.md");
    expect(yaml).toContain("/tmp/handover.md");

    const parsed = RigSpecCodec.parse(yaml);
    const validation = RigSpecSchema.validate(parsed);
    expect(validation.valid).toBe(true);

    const normalized = RigSpecSchema.normalize(parsed as Record<string, unknown>) as RigSpec;
    const member = normalized.pods[0]!.members[0]!;
    expect(member.sessionSource).toEqual(seed.pods[0]!.members[0]!.sessionSource);
  });
});

// ============================================================================
// Rebuild artifact resolver
// ============================================================================

describe("resolveRebuildArtifacts", () => {
  function makeSpec(paths: string[]): SessionSourceRebuildSpec {
    return { mode: "rebuild", ref: { kind: "artifact_set", value: paths } };
  }

  it("将全部存在的 path 解析为 ResolvedStartupFile[]，并保留用户顺序", () => {
    const exists = (p: string) => p === "/x/CULTURE.md" || p === "/y/role.md" || p === "/z/handover.md";
    const result = resolveRebuildArtifacts(makeSpec(["/x/CULTURE.md", "/y/role.md", "/z/handover.md"]), { exists });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files.map((f) => f.absolutePath)).toEqual(["/x/CULTURE.md", "/y/role.md", "/z/handover.md"]);
      expect(result.gaps).toEqual([]);
      // Identity-honesty：deliveryHint 为 `send_text`（用户为运行中的 TUI 整理的 context）。
      expect(result.files.every((f) => f.deliveryHint === "send_text")).toBe(true);
      // appliesOn: ["fresh_start"]——从 runtime 视角看，rebuild 就是一次全新启动。
      expect(result.files.every((f) => f.appliesOn.includes("fresh_start"))).toBe(true);
      // 必须设为 required，使 orchestrator 如实呈现资源缺失失败。
      expect(result.files.every((f) => f.required === true)).toBe(true);
    }
  });

  it("部分文件存在时，将缺失 path 记录为 gap 而不失败", () => {
    const exists = (p: string) => p === "/exists.md";
    const result = resolveRebuildArtifacts(makeSpec(["/exists.md", "/missing.md", "/also-missing.md"]), { exists });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files.map((f) => f.absolutePath)).toEqual(["/exists.md"]);
      expect(result.gaps).toEqual(["/missing.md", "/also-missing.md"]);
    }
  });

  it("所有声明 path 都缺失时，以明确 error 使启动失败", () => {
    const exists = () => false;
    const result = resolveRebuildArtifacts(makeSpec(["/missing-1.md", "/missing-2.md"]), { exists });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("声明的 artifact 路径共 2 项，均未解析到现有文件");
      expect(result.error).toContain("信任优先级");
      expect(result.gaps).toEqual(["/missing-1.md", "/missing-2.md"]);
    }
  });

  it("保留用户声明顺序（不施加字母顺序或其他排序）", () => {
    const exists = () => true;
    const order = ["/zzz-low-trust.md", "/aaa-mid-trust.md", "/mmm-highest-trust.md"];
    const result = resolveRebuildArtifacts(makeSpec(order), { exists });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files.map((f) => f.absolutePath)).toEqual(order);
    }
  });
});

// ============================================================================
// Startup orchestrator——rebuild 集成
// ============================================================================

function mockOrchTmux(): TmuxAdapter {
  return {
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
}

function makeStubAdapter(): RuntimeAdapter {
  return {
    runtime: "claude-code",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    // Fresh-launch shape：返回 ok 且没有 resumeToken（rebuild seat 没有可恢复的
    // native runtime conversation）。
    launchHarness: vi.fn(async () => ({ ok: true })),
  };
}

function emptyPlan(): ProjectionPlan {
  return { runtime: "claude-code", cwd: ".", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] };
}

describe("StartupOrchestrator rebuild 集成", () => {
  let db: Database.Database;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let rigRepo: RigRepository;

  beforeEach(() => {
    db = createFullTestDb();
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    rigRepo = new RigRepository(db);
  });
  afterEach(() => { db.close(); });

  function seed(): { rigId: string; nodeId: string; sessionId: string } {
    const rig = rigRepo.createRig("rebuild-rig");
    const node = rigRepo.addNode(rig.id, "writer", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-writer");
    sessionRegistry.updateStatus(session.id, "running");
    return { rigId: rig.id, nodeId: node.id, sessionId: session.id };
  }

  function makeInput(s: { rigId: string; nodeId: string; sessionId: string }, overrides?: Partial<StartupInput>): StartupInput {
    return {
      rigId: s.rigId,
      nodeId: s.nodeId,
      sessionId: s.sessionId,
      binding: { id: "b1", nodeId: s.nodeId, tmuxSession: "r01-writer", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "." },
      adapter: makeStubAdapter(),
      plan: emptyPlan(),
      resolvedStartupFiles: [],
      startupActions: [],
      isRestore: false,
      ...overrides,
    };
  }

  function createOrch(): StartupOrchestrator {
    return new StartupOrchestrator({
      db, sessionRegistry, eventBus,
      tmuxAdapter: mockOrchTmux(),
      sleep: async () => {},
    });
  }

  function makeRebuildArtifacts(): ResolvedStartupFile[] {
    return [
      { path: "CULTURE.md", absolutePath: "/x/CULTURE.md", ownerRoot: "/x", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] },
      { path: "role.md", absolutePath: "/y/role.md", ownerRoot: "/y", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] },
      { path: "handover.md", absolutePath: "/z/handover.md", ownerRoot: "/z", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] },
    ];
  }

  it("提供 rebuildArtifacts 且启动成功时设置 continuityOutcome=rebuilt", async () => {
    const s = seed();
    const orch = createOrch();
    const result = await orch.startNode(makeInput(s, { rebuildArtifacts: makeRebuildArtifacts() }));
    expect(result).toEqual({
      ok: true,
      startupStatus: "ready",
      continuityOutcome: "rebuilt",
    });
  });

  it("rebuild 时调用 adapter.launchHarness，不传 resumeToken 和 forkSource", async () => {
    const s = seed();
    const adapter = makeStubAdapter();
    const launchSpy = adapter.launchHarness as ReturnType<typeof vi.fn>;
    const orch = createOrch();
    await orch.startNode(makeInput(s, { adapter, rebuildArtifacts: makeRebuildArtifacts() }));

    expect(launchSpy).toHaveBeenCalledTimes(1);
    const opts = launchSpy.mock.calls[0]![1];
    expect(opts.resumeToken).toBeUndefined();
    expect(opts.forkSource).toBeUndefined();
  });

  it("rebuild seat 持久化时没有 resumeToken（identity-honesty：rebuild 是 artifact 注入，而非 native resume）", async () => {
    const s = seed();
    const orch = createOrch();
    await orch.startNode(makeInput(s, { rebuildArtifacts: makeRebuildArtifacts() }));

    const row = db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(s.sessionId) as { resume_token: string | null };
    expect(row.resume_token).toBeNull();
  });

  it("将 rebuild artifact 交给 adapter.deliverStartup（启动后通过 send_text 交付）", async () => {
    const s = seed();
    const adapter = makeStubAdapter();
    const deliverSpy = adapter.deliverStartup as ReturnType<typeof vi.fn>;
    const orch = createOrch();
    const artifacts = makeRebuildArtifacts();

    await orch.startNode(makeInput(s, { adapter, rebuildArtifacts: artifacts }));

    // deliverStartup 调用两次：一次在启动前（filesystem file；仅 rebuild 时为空），
    // 一次在启动后（TUI file；即 rebuild artifact）。
    expect(deliverSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    // 启动后调用必须按用户顺序包含 rebuild artifact。
    const allDeliveredFiles = deliverSpy.mock.calls.flatMap((call) => call[0] as ResolvedStartupFile[]);
    const deliveredAbsPaths = allDeliveredFiles.map((f) => f.absolutePath);
    for (const artifact of artifacts) {
      expect(deliveredAbsPaths).toContain(artifact.absolutePath);
    }
    // 保留用户顺序：CULTURE 位于 role 前，role 位于 handover 前。
    const cultureIdx = deliveredAbsPaths.indexOf("/x/CULTURE.md");
    const roleIdx = deliveredAbsPaths.indexOf("/y/role.md");
    const handoverIdx = deliveredAbsPaths.indexOf("/z/handover.md");
    expect(cultureIdx).toBeGreaterThanOrEqual(0);
    expect(cultureIdx).toBeLessThan(roleIdx);
    expect(roleIdx).toBeLessThan(handoverIdx);
  });

  it("fresh 路径（无 rebuildArtifacts、resumeToken、forkSource）保持不变：continuityOutcome=fresh", async () => {
    const s = seed();
    const orch = createOrch();
    const result = await orch.startNode(makeInput(s));
    expect(result).toEqual({ ok: true, startupStatus: "ready", continuityOutcome: "fresh" });
  });

  it("fork 路径（已设置 forkSource）不受 rebuild 接线影响：continuityOutcome=forked", async () => {
    const s = seed();
    const adapter = makeStubAdapter();
    (adapter.launchHarness as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      resumeToken: "NEW-FORK-TOKEN",
      resumeType: "claude_id",
    });
    const orch = createOrch();
    const result = await orch.startNode(makeInput(s, {
      adapter,
      forkSource: { kind: "native_id", value: "PARENT-FORK-TOKEN" },
    }));
    expect(result).toEqual({ ok: true, startupStatus: "ready", continuityOutcome: "forked" });
  });
});

// ============================================================================
// 诚实 UX literal contract——continuityOutcome 包含 "rebuilt"；rebuild dossier 文案中不会
// 混入 `restored|resumed|snapshot|forked`。
// ============================================================================

describe("identity-honesty literal contract——rebuild", () => {
  it('continuityOutcome union 除其他结果外也接受 "rebuilt"', () => {
    const r: { ok: true; startupStatus: "ready"; continuityOutcome: "rebuilt" } = {
      ok: true, startupStatus: "ready", continuityOutcome: "rebuilt",
    };
    expect(r.continuityOutcome).toBe("rebuilt");
  });

  it("rebuild mode literal 是 'rebuild'（不是 'fresh'、'resumed'、'forked'、'restored' 或 'snapshot'）", () => {
    const spec: SessionSourceRebuildSpec = { mode: "rebuild", ref: { kind: "artifact_set", value: ["/x"] } };
    expect(spec.mode).toBe("rebuild");
    expect(["fresh", "resumed", "forked", "restored", "snapshot"]).not.toContain(spec.mode as string);
  });

  it("resolver 产生的 ResolvedStartupFile entry 不携带任何 restored/resumed/snapshot/forked tag", () => {
    const exists = () => true;
    const result = resolveRebuildArtifacts(
      { mode: "rebuild", ref: { kind: "artifact_set", value: ["/x.md"] } },
      { exists },
    );
    if (!result.ok) throw new Error("预期结果为 ok");
    const serialized = JSON.stringify(result.files);
    expect(serialized).not.toMatch(/restored/i);
    expect(serialized).not.toMatch(/resumed/i);
    expect(serialized).not.toMatch(/snapshot/i);
    expect(serialized).not.toMatch(/forked/i);
  });
});

// ============================================================================
// 真实 filesystem smoke：resolver 默认 `exists` 可用（轻量集成）
// ============================================================================

describe("rebuild resolver 真实 filesystem smoke（默认 existsSync）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openrig-rebuild-resolver-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("解析写入临时目录的真实文件", () => {
    const a = join(dir, "CULTURE.md");
    const b = join(dir, "role.md");
    writeFileSync(a, "culture body");
    writeFileSync(b, "role body");

    const result = resolveRebuildArtifacts({
      mode: "rebuild",
      ref: { kind: "artifact_set", value: [a, b] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files.map((f) => f.absolutePath)).toEqual([a, b]);
      expect(result.gaps).toEqual([]);
    }
  });

  it("同时存在已解析文件时，为缺失文件返回 gap", () => {
    const real = join(dir, "real.md");
    writeFileSync(real, "x");
    const ghost = join(dir, "ghost.md"); // 刻意不写入

    const result = resolveRebuildArtifacts({
      mode: "rebuild",
      ref: { kind: "artifact_set", value: [real, ghost] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.files.map((f) => f.absolutePath)).toEqual([real]);
      expect(result.gaps).toEqual([ghost]);
    }
  });
});
