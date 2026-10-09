// OPR.0.4.3.05 席位分叉收尾——守护进程的窄范围分叉编排路由
//（POST /api/agent-images/fork）。验证驱动说明中的三项不变量：
//   1. 恢复令牌发现服务端运行（resume-token-discovery.ts）。
//   2. 原生恢复 ID 仅保留在守护进程本地——绝不出现在路由响应中。
//   3. --keep-image 会固定镜像，并且证据护栏在固定后保护它
//      （保留即固定是真实发行的保护机制）。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { AgentImageLibraryService } from "../src/domain/agent-images/agent-image-library-service.js";
import { evaluateProtection } from "../src/domain/agent-images/evidence-guard.js";
import { agentImagesRoutes } from "../src/routes/agent-images.js";
import type { SnapshotCapturer } from "../src/domain/agent-images/snapshot-capturer.js";
import type { PodRigInstantiator, AddMemberOutcome } from "../src/domain/rigspec-instantiator.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


const NATIVE_SECRET = "NATIVE-RESUME-ID-MUST-STAY-DAEMON-LOCAL";

function writeImage(root: string, name: string, manifest: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.yaml"), manifest);
}

describe("智能体镜像分叉编排路由（OPR.0.4.3.05）", () => {
  let tmp: string;
  let libRoot: string;
  let specRoot: string;
  let db: Database.Database;
  let rigRepo: RigRepository;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "fork-route-"));
    libRoot = join(tmp, "lib");
    specRoot = join(tmp, "specs");
    mkdirSync(libRoot, { recursive: true });
    mkdirSync(specRoot, { recursive: true });
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
  });

  afterEach(() => {
    try { db.close(); } catch { /* 忽略 */ }
    rmSync(tmp, { recursive: true, force: true });
  });

  /** 植入带有原生恢复 ID 的 claude-code 源席位。 */
  function seedClaudeSource(sessionName: string, resumeToken: string | null): void {
    const rig = rigRepo.createRig("src-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", {
      runtime: "claude-code",
      cwd: "/Users/op/code/openrig",
      agentRef: "local:agents/impl",
      profile: "default",
    });
    const sessionId = ulid();
    db.prepare(
      `INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, 'live', ?)`,
    ).run(sessionId, node.id, sessionName, new Date().toISOString());
    if (resumeToken) {
      db.prepare(`UPDATE sessions SET resume_token = ?, resume_type = 'claude_id' WHERE id = ?`).run(resumeToken, sessionId);
    }
  }

  function seedTerminalSource(sessionName: string): void {
    const rig = rigRepo.createRig("term-rig");
    const node = rigRepo.addNode(rig.id, "ops.term", { runtime: "terminal", cwd: "/tmp" });
    db.prepare(
      `INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, 'live', ?)`,
    ).run(ulid(), node.id, sessionName, new Date().toISOString());
  }

  function buildApp(opts: {
    addMember: (rigId: string, pod: string, member: Record<string, unknown>, rigRoot: string, o?: unknown) => Promise<AddMemberOutcome>;
    lib?: AgentImageLibraryService;
    capturer?: SnapshotCapturer;
  }): Hono {
    const app = new Hono();
    const podInstantiator = { addMemberToPod: vi.fn(opts.addMember) } as unknown as PodRigInstantiator;
    app.use("*", async (c, next) => {
      c.set("db" as never, db);
      c.set("podInstantiator" as never, podInstantiator);
      if (opts.lib) c.set("agentImageLibrary" as never, opts.lib);
      if (opts.capturer) c.set("snapshotCapturer" as never, opts.capturer);
      await next();
    });
    // 暴露 spy 供断言使用。
    (app as unknown as { _addMember: unknown })._addMember = podInstantiator.addMemberToPod;
    app.route("/api/agent-images", agentImagesRoutes({ specRoots: () => [specRoot] }));
    return app;
  }

  async function post(app: Hono, body: unknown) {
    return app.request("/api/agent-images/fork", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("默认分叉 → add_member(mode:fork, native_id)；响应中绝不包含原生 ID（驱动说明 2）", async () => {
    seedClaudeSource("dev-impl@src-rig", NATIVE_SECRET);
    const addMember = vi.fn(async () => ({
      ok: true as const,
      result: { podId: "p1", podNamespace: "dev", node: { logicalId: "dev.forked", nodeId: "n2", status: "launched", sessionName: "forked@dst" } },
    } as unknown as AddMemberOutcome));
    const app = buildApp({ addMember });

    const res = await post(app, { sourceSession: "dev-impl@src-rig", rigId: "dst-rig", pod: "dev", member: "forked" });
    expect(res.status).toBe(201);
    const raw = await res.text();
    // 原生 ID 仅保留在守护进程本地——不得泄漏到响应体。
    expect(raw).not.toContain(NATIVE_SECRET);
    const body = JSON.parse(raw);
    expect(body.ok).toBe(true);

    // 编排后的成员片段携带 mode:fork 和发现的原生 ID。
    expect(addMember).toHaveBeenCalledTimes(1);
    const [rigId, pod, member] = addMember.mock.calls[0]!;
    expect(rigId).toBe("dst-rig");
    expect(pod).toBe("dev");
    expect((member as Record<string, unknown>).runtime).toBe("claude-code");
    expect((member as Record<string, unknown>).agent_ref).toBe("local:agents/impl");
    expect((member as Record<string, unknown>).session_source).toEqual({
      mode: "fork",
      ref: { kind: "native_id", value: NATIVE_SECRET },
    });
  });

  it("未知源会话 → 404 session_not_found", async () => {
    const app = buildApp({ addMember: vi.fn(async () => ({ ok: true } as unknown as AddMemberOutcome)) });
    const res = await post(app, { sourceSession: "nope@nope", rigId: "r", pod: "p", member: "m" });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: string }).error).toBe("session_not_found");
  });

  it("terminal 运行时源 → 如实拒绝（400 runtime_unsupported）", async () => {
    seedTerminalSource("ops-term@term-rig");
    const addMember = vi.fn(async () => ({ ok: true } as unknown as AddMemberOutcome));
    const app = buildApp({ addMember });
    const res = await post(app, { sourceSession: "ops-term@term-rig", rigId: "r", pod: "p", member: "m" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("runtime_unsupported");
    expect(addMember).not.toHaveBeenCalled();
  });

  it("源没有可推导的恢复令牌 → 如实返回 409，不伪造、不启动", async () => {
    seedClaudeSource("dev-impl@src-rig", null); // 没有 resume_token，也没有 context_usage
    const addMember = vi.fn(async () => ({ ok: true } as unknown as AddMemberOutcome));
    const app = buildApp({ addMember });
    const res = await post(app, { sourceSession: "dev-impl@src-rig", rigId: "r", pod: "p", member: "m" });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("resume_token_unavailable");
    expect(body.message).toMatch(/伪造/);
    expect(addMember).not.toHaveBeenCalled();
  });

  it("add_member 返回 member_conflict → 如实呈现为 409", async () => {
    seedClaudeSource("dev-impl@src-rig", NATIVE_SECRET);
    const addMember = vi.fn(async () => ({
      ok: false as const, code: "member_conflict" as const, message: '成员 "dev.forked" 已存在',
    }));
    const app = buildApp({ addMember: addMember as never });
    const res = await post(app, { sourceSession: "dev-impl@src-rig", rigId: "r", pod: "dev", member: "forked" });
    expect(res.status).toBe(409);
    expect((await res.json() as { code: string }).code).toBe("member_conflict");
  });

  it("--keep-image → 创建持久镜像并固定，且固定后受证据护栏保护（驱动说明 3）", async () => {
    seedClaudeSource("dev-impl@src-rig", NATIVE_SECRET);
    const lib = new AgentImageLibraryService({ roots: [{ path: libRoot, sourceType: "user_file" }] });
    // capturer 存根像真实捕获器一样安装真实镜像目录，使路由的 lib.pin 和后续
    // evaluateProtection 操作真实条目。
    const capturer = {
      capture: vi.fn((o: { name: string; version?: string }) => {
        writeImage(libRoot, o.name, `\nname: ${o.name}\nversion: ${o.version ?? "1"}\nruntime: claude-code\nsource_seat: dev-impl@src-rig\nsource_session_id: ${NATIVE_SECRET}\nsource_resume_token: ${NATIVE_SECRET}\nfiles: []\n`);
        lib.scan();
        return { imageId: `agent-image:${o.name}:${o.version ?? "1"}`, imagePath: join(libRoot, o.name), manifest: {} };
      }),
    } as unknown as SnapshotCapturer;

    const addMember = vi.fn(async () => ({
      ok: true as const,
      result: { podId: "p1", podNamespace: "dev", node: { logicalId: "dev.forked", nodeId: "n2", status: "launched", sessionName: "forked@dst" } },
    } as unknown as AddMemberOutcome));
    const app = buildApp({ addMember, lib, capturer });

    const res = await post(app, { sourceSession: "dev-impl@src-rig", rigId: "dst-rig", pod: "dev", member: "forked", keepImage: true, imageName: "kept" });
    expect(res.status).toBe(201);
    const raw = await res.text();
    expect(raw).not.toContain(NATIVE_SECRET); // 仍仅保留在守护进程本地
    const body = JSON.parse(raw) as { image: { id: string; name: string; pinned: boolean } };
    expect(body.image).toEqual({ id: "agent-image:kept:1", name: "kept", version: "1", pinned: true });

    // 镜像已在实时库中固定……
    expect(lib.get("agent-image:kept:1")!.pinned).toBe(true);
    // ……并且在固定后断言：证据护栏现在会保护它。
    const protections = evaluateProtection({ images: lib.list(), specRoots: [specRoot] });
    const kept = protections.find((p) => p.imageId === "agent-image:kept:1")!;
    expect(kept.protected).toBe(true);
    expect(kept.reasons).toContain("pinned");

    // 通过 mode:agent_image 启动（不是原始原生 ID）。
    const [, , member] = addMember.mock.calls[0]!;
    expect((member as Record<string, unknown>).session_source).toEqual({
      mode: "agent_image", ref: { kind: "image_name", value: "kept", version: "1" },
    });
  });

  it("缺少必填字段 → 400", async () => {
    const app = buildApp({ addMember: vi.fn(async () => ({ ok: true } as unknown as AddMemberOutcome)) });
    const res = await post(app, { sourceSession: "x@y" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("missing_required_fields");
  });
});
