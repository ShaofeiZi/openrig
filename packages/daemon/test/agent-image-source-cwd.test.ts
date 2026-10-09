// PL-016 source-cwd 往返测试。
//
// 固定以下行为：
//   - 创建时 manifest 捕获 source_cwd（snapshot capturer 从 nodes table 读取 source seat cwd）
//   - snippet generator 在渲染的“用作 starter”YAML 中发出 cwd: <source_cwd>
//   - 向后兼容：不含 source_cwd 的 manifest 仍可加载与渲染 snippet，并省略 cwd
//     （保留当前行为）
//   - 用户覆盖场景（cwd 不同 → fork 如实失败，不存在 daemon 侧隐式 override——通过不存在
//     任何 daemon cwd-rewriting 代码路径验证）

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import {
  AgentImageLibraryService,
} from "../src/domain/agent-images/agent-image-library-service.js";
import { parseAgentImageManifest } from "../src/domain/agent-images/manifest-parser.js";
import { agentImagesRoutes } from "../src/routes/agent-images.js";
import { SnapshotCapturer } from "../src/domain/agent-images/snapshot-capturer.js";
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
import { podNamespaceSchema } from "../src/db/migrations/017_pod_namespace.js";
import { contextUsageSchema } from "../src/db/migrations/018_context_usage.js";
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ulid } from "ulid";

let tmp: string;
let userRoot: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "pl016-fxn2-cwd-"));
  userRoot = join(tmp, "user");
  mkdirSync(userRoot, { recursive: true });
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeImage(root: string, name: string, manifest: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.yaml"), manifest);
}

// ============================================================================
// 测试 1——创建时 manifest 捕获 source_cwd（snapshot capturer）
// ============================================================================

describe("agent image source_cwd——snapshot capturer 捕获 cwd", () => {
  function setupDb(): { db: Database.Database; rigRepo: RigRepository; sessionRegistry: SessionRegistry } {
    const db = createDb();
    migrate(db, [
      coreSchema,
      bindingsSessionsSchema,
      eventsSchema,
      snapshotsSchema,
      checkpointsSchema,
      resumeMetadataSchema,
      nodeSpecFieldsSchema,
      agentspecRebootSchema,
      podNamespaceSchema,
      contextUsageSchema,
      externalCliAttachmentSchema,
    ]);
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    return { db, rigRepo, sessionRegistry };
  }

  it("将 source seat 的 cwd 捕获到 manifest source_cwd", () => {
    const { db, rigRepo, sessionRegistry } = setupDb();
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", {
      runtime: "claude-code",
      cwd: "/Users/op/code/projects/openrig",
    });
    // 创建 session row + resume_token，使 discoverResumeToken 返回它。
    const sessionId = ulid();
    db.prepare(
      `INSERT INTO sessions (id, node_id, session_name, status, created_at)
       VALUES (?, ?, ?, 'live', ?)`,
    ).run(sessionId, node.id, "dev-impl@test-rig", new Date().toISOString());
    db.prepare(`UPDATE sessions SET resume_token = ?, resume_type = 'claude_id' WHERE id = ?`).run("NATIVE-RESUME-TOKEN", sessionId);

    const library = new AgentImageLibraryService({ roots: [{ path: userRoot, sourceType: "user_file" }] });
    const capturer = new SnapshotCapturer({
      db, rigRepo, sessionRegistry, agentImageLibrary: library,
      targetRoot: userRoot,
    });

    const result = capturer.capture({
      sourceSession: "dev-impl@test-rig",
      name: "captured-image",
    });

    expect(result.manifest.sourceCwd).toBe("/Users/op/code/projects/openrig");

    // manifest 也持久化到磁盘——验证 YAML 包含 source_cwd，使全新 re-scan 能正确重新加载。
    const yaml = readFileSync(join(userRoot, "captured-image", "manifest.yaml"), "utf-8");
    expect(yaml).toContain("source_cwd:");
    expect(yaml).toContain("/Users/op/code/projects/openrig");

    db.close();
  });

  it("捕获 Claude live context session id，而非 stale launch resume_token", () => {
    const { db, rigRepo, sessionRegistry } = setupDb();
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", {
      runtime: "claude-code",
      cwd: "/Users/op/code/projects/openrig",
    });
    const sessionId = ulid();
    db.prepare(
      `INSERT INTO sessions (id, node_id, session_name, status, created_at)
       VALUES (?, ?, ?, 'live', ?)`,
    ).run(sessionId, node.id, "dev-impl@test-rig", new Date().toISOString());
    db.prepare(`UPDATE sessions SET resume_token = ?, resume_type = 'claude_id' WHERE id = ?`)
      .run("STALE-GENERATED-LAUNCH-ID", sessionId);
    db.prepare(`
      INSERT INTO context_usage (
        node_id, session_id, session_name, availability, source, sampled_at
      ) VALUES (?, ?, ?, 'known', 'claude_statusline_json', ?)
    `).run(node.id, "LIVE-CLAUDE-TRANSCRIPT-ID", "dev-impl@test-rig", new Date().toISOString());

    const library = new AgentImageLibraryService({ roots: [{ path: userRoot, sourceType: "user_file" }] });
    const capturer = new SnapshotCapturer({
      db, rigRepo, sessionRegistry, agentImageLibrary: library,
      targetRoot: userRoot,
    });

    const result = capturer.capture({
      sourceSession: "dev-impl@test-rig",
      name: "captured-live-session-image",
    });

    expect(result.manifest.sourceSessionId).toBe("LIVE-CLAUDE-TRANSCRIPT-ID");
    expect(result.manifest.sourceResumeToken).toBe("LIVE-CLAUDE-TRANSCRIPT-ID");
    expect(result.manifest.sourceResumeToken).not.toBe("STALE-GENERATED-LAUNCH-ID");

    db.close();
  });

  it("将 managed Codex seat 已持久化的 thread id 捕获到 manifest", () => {
    const { db, rigRepo, sessionRegistry } = setupDb();
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "dev.qa", {
      runtime: "codex",
      cwd: "/Users/op/code/projects/openrig",
    });
    const sessionId = ulid();
    db.prepare(
      `INSERT INTO sessions (id, node_id, session_name, status, created_at)
       VALUES (?, ?, ?, 'live', ?)`,
    ).run(sessionId, node.id, "dev-qa@test-rig", new Date().toISOString());
    db.prepare(`UPDATE sessions SET resume_token = ?, resume_type = 'codex_id' WHERE id = ?`)
      .run("LIVE-CODEX-THREAD-ID", sessionId);

    const library = new AgentImageLibraryService({ roots: [{ path: userRoot, sourceType: "user_file" }] });
    const capturer = new SnapshotCapturer({
      db, rigRepo, sessionRegistry, agentImageLibrary: library,
      targetRoot: userRoot,
    });

    const result = capturer.capture({
      sourceSession: "dev-qa@test-rig",
      name: "captured-codex-image",
    });

    expect(result.manifest.runtime).toBe("codex");
    expect(result.manifest.sourceSessionId).toBe("LIVE-CODEX-THREAD-ID");
    expect(result.manifest.sourceResumeToken).toBe("LIVE-CODEX-THREAD-ID");
    expect(result.manifest.sourceCwd).toBe("/Users/op/code/projects/openrig");

    db.close();
  });

  it("source node 没有已记录 cwd 时省略 source_cwd（legacy fixture）", () => {
    const { db, rigRepo, sessionRegistry } = setupDb();
    const rig = rigRepo.createRig("legacy-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", {
      runtime: "claude-code",
      // cwd 刻意为 null——模拟 cwd-capture 前的 node row
    });
    const sessionId = ulid();
    db.prepare(
      `INSERT INTO sessions (id, node_id, session_name, status, created_at)
       VALUES (?, ?, ?, 'live', ?)`,
    ).run(sessionId, node.id, "dev-impl@legacy-rig", new Date().toISOString());
    db.prepare(`UPDATE sessions SET resume_token = ?, resume_type = 'claude_id' WHERE id = ?`).run("TOKEN", sessionId);

    const library = new AgentImageLibraryService({ roots: [{ path: userRoot, sourceType: "user_file" }] });
    const capturer = new SnapshotCapturer({
      db, rigRepo, sessionRegistry, agentImageLibrary: library,
      targetRoot: userRoot,
    });

    const result = capturer.capture({
      sourceSession: "dev-impl@legacy-rig",
      name: "no-cwd-image",
    });

    expect(result.manifest.sourceCwd).toBeUndefined();
    const yaml = readFileSync(join(userRoot, "no-cwd-image", "manifest.yaml"), "utf-8");
    expect(yaml).not.toContain("source_cwd:");

    db.close();
  });
});

// ============================================================================
// 测试 2——snippet generator 在“用作 starter”的 YAML 中发出 cwd
// ============================================================================

describe("agent image source_cwd——snippet generator 发出 cwd", () => {
  function buildApp(library: AgentImageLibraryService): Hono {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("agentImageLibrary" as never, library);
      await next();
    });
    app.route("/api/agent-images", agentImagesRoutes({ specRoots: () => [] }));
    return app;
  }

  it("manifest 含 source_cwd 时，渲染的 snippet 包含 cwd 行", async () => {
    writeImage(userRoot, "with-cwd", `
name: with-cwd
version: 1
runtime: claude-code
source_seat: alice@rig
source_session_id: SID
source_resume_token: TOK
source_cwd: /Users/op/code/projects/openrig
files: []
`);
    const lib = new AgentImageLibraryService({ roots: [{ path: userRoot, sourceType: "user_file" }] });
    lib.scan();
    const app = buildApp(lib);

    const id = encodeURIComponent("agent-image:with-cwd:1");
    const res = await app.request(`/api/agent-images/library/${id}/preview`);
    expect(res.status).toBe(200);
    const body = await res.json() as { starterSnippet: string };
    expect(body.starterSnippet).toContain('cwd: "/Users/op/code/projects/openrig"');
    expect(body.starterSnippet).toContain("session_source:");
    expect(body.starterSnippet).toContain("    value: \"with-cwd\"");
    // cwd 行位于 session_source block 前（用户逐字粘贴）。
    const cwdIdx = body.starterSnippet.indexOf("cwd:");
    const ssIdx = body.starterSnippet.indexOf("session_source:");
    expect(cwdIdx).toBeLessThan(ssIdx);
  });

  it("向后兼容：manifest 不含 source_cwd 时 snippet 省略 cwd 行（保留当前行为）", async () => {
    writeImage(userRoot, "no-cwd", `
name: no-cwd
version: 1
runtime: claude-code
source_seat: alice@rig
source_session_id: SID
source_resume_token: TOK
files: []
`);
    const lib = new AgentImageLibraryService({ roots: [{ path: userRoot, sourceType: "user_file" }] });
    lib.scan();
    const app = buildApp(lib);

    const id = encodeURIComponent("agent-image:no-cwd:1");
    const res = await app.request(`/api/agent-images/library/${id}/preview`);
    expect(res.status).toBe(200);
    const body = await res.json() as { starterSnippet: string };
    expect(body.starterSnippet).not.toContain("cwd:");
    expect(body.starterSnippet).toContain("session_source:");
  });

  it("存在时 library entry 逐字呈现 sourceCwd，旧 manifest 则为 null", async () => {
    writeImage(userRoot, "with-cwd", `
name: with-cwd
version: 1
runtime: claude-code
source_seat: alice@rig
source_session_id: SID
source_resume_token: TOK
source_cwd: /Users/op/code
files: []
`);
    writeImage(userRoot, "no-cwd", `
name: no-cwd
version: 1
runtime: claude-code
source_seat: alice@rig
source_session_id: SID
source_resume_token: TOK
files: []
`);
    const lib = new AgentImageLibraryService({ roots: [{ path: userRoot, sourceType: "user_file" }] });
    lib.scan();
    const app = buildApp(lib);

    const res = await app.request("/api/agent-images/library");
    const body = await res.json() as Array<{ name: string; sourceCwd: string | null }>;
    const withCwd = body.find((e) => e.name === "with-cwd")!;
    const withoutCwd = body.find((e) => e.name === "no-cwd")!;
    expect(withCwd.sourceCwd).toBe("/Users/op/code");
    expect(withoutCwd.sourceCwd).toBeNull();
  });
});

// ============================================================================
// 测试 3——parser 向后兼容（snake + camel + missing）
// ============================================================================

describe("agent image source_cwd——manifest parser 向后兼容", () => {
  it("接受 source_cwd（snake_case）", () => {
    const manifest = parseAgentImageManifest(`
name: x
version: "1"
runtime: claude-code
source_seat: a@r
source_session_id: s
source_resume_token: t
source_cwd: /Users/op/code
`, "/path");
    expect(manifest.sourceCwd).toBe("/Users/op/code");
  });

  it("接受 sourceCwd（camelCase）", () => {
    const manifest = parseAgentImageManifest(`
name: x
version: "1"
runtime: claude-code
source_seat: a@r
source_session_id: s
source_resume_token: t
sourceCwd: /Users/op/code
`, "/path");
    expect(manifest.sourceCwd).toBe("/Users/op/code");
  });

  it("不含 source_cwd 的 manifest 仍可解析（兼容 Finding-2 前的 fixture）", () => {
    const manifest = parseAgentImageManifest(`
name: x
version: "1"
runtime: claude-code
source_seat: a@r
source_session_id: s
source_resume_token: t
`, "/path");
    expect(manifest.sourceCwd).toBeUndefined();
  });
});

// ============================================================================
// 测试 4——用户覆盖安全性：不存在 daemon 侧 cwd 重写
// ============================================================================
//
// daemon 在 fork dispatch 时不得覆盖 cwd——逐字遵循用户在 rig.yaml 中选择的 cwd。若错误，
// Claude 返回 "no conversation found"，用户收到如实 error。
//
// 本测试扫描 rigspec-instantiator + claude-code-adapter source 中已记录的 red flag，
// 强制确保不存在 daemon override 路径：若未来 patch 在此加入 override，测试会失败，
// author 必须显式说明理由。

describe("agent image source_cwd——用户覆盖安全性", () => {
  it("rigspec-instantiator 不会根据 agent_image manifest 修改 member.cwd", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      join(import.meta.dirname ?? __dirname, "../src/domain/rigspec-instantiator.ts"),
      "utf-8",
    );
    // 负向 assertion：没有代码路径从 resolved agent_image 读取 sourceCwd 并覆盖 member cwd。
    expect(src).not.toMatch(/member\.cwd\s*=\s*image\.sourceCwd/);
    expect(src).not.toMatch(/cwd:\s*image\.sourceCwd/);
  });

  it("snippet generator 仅根据 manifest source_cwd 发出 cwd（不推断 fallback）", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      join(import.meta.dirname ?? __dirname, "../src/routes/agent-images.ts"),
      "utf-8",
    );
    // 正向 assertion：snippet generator 明确以 entry.sourceCwd 控制 cwd 行——
    // 不回退到 homedir / cwd 等。
    expect(src).toMatch(/if\s*\(\s*entry\.sourceCwd\s*\)/);
  });
});
