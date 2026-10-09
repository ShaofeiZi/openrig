// Rig Context / Composable Context Injection v0（PL-014）——daemon HTTP 路由测试。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContextPackLibraryService } from "../src/domain/context-packs/context-pack-library-service.js";
import { contextPacksRoutes } from "../src/routes/context-packs.js";

interface FakeSendResult {
  ok: boolean;
  sessionName: string;
  reason?: string;
  error?: string;
}

class FakeSessionTransport {
  public calls: Array<{ sessionName: string; text: string }> = [];
  public response: FakeSendResult = { ok: true, sessionName: "x" };
  async send(sessionName: string, text: string): Promise<FakeSendResult> {
    this.calls.push({ sessionName, text });
    return { ...this.response, sessionName };
  }
}

function writePack(root: string, name: string, manifest: string, files: Record<string, string>) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.yaml"), manifest);
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(dir, path), content);
  }
}

describe("context-packs 路由（PL-014）", () => {
  let tmp: string;
  let libRoot: string;
  let lib: ContextPackLibraryService;
  let transport: FakeSessionTransport;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "context-pack-routes-"));
    libRoot = join(tmp, "lib");
    mkdirSync(libRoot, { recursive: true });
    lib = new ContextPackLibraryService({
      roots: [{ path: libRoot, sourceType: "user_file" }],
    });
    transport = new FakeSessionTransport();
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function buildApp(opts?: { withTransport?: boolean; withLib?: boolean }): Hono {
    const app = new Hono();
    const withTransport = opts?.withTransport !== false;
    const withLib = opts?.withLib !== false;
    app.use("*", async (c, next) => {
      if (withLib) c.set("contextPackLibrary" as never, lib);
      if (withTransport) c.set("sessionTransport" as never, transport);
      await next();
    });
    app.route("/api/context-packs", contextPacksRoutes());
    return app;
  }

  it("service 未接线时 GET /library 返回 503", async () => {
    const app = buildApp({ withLib: false });
    const res = await app.request("/api/context-packs/library");
    expect(res.status).toBe(503);
  });

  it("GET /library 返回已索引的 pack", async () => {
    writePack(libRoot, "smoke", `
name: smoke
version: 1
taxonomy: world
purpose: Smoke
files:
  - path: notes.md
    role: notes
`, { "notes.md": "Hello" });
    lib.scan();
    const app = buildApp();
    const res = await app.request("/api/context-packs/library");
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ name: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]!.name).toBe("smoke");
  });

  it("POST /library/sync 重新索引并返回 count + entry", async () => {
    writePack(libRoot, "p1", `
name: p1
version: 1
taxonomy: world
files:
  - path: a.md
    role: r
`, { "a.md": "x" });
    const app = buildApp();
    const res = await app.request("/api/context-packs/library/sync", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { count: number; entries: Array<{ name: string }> };
    expect(body.count).toBe(1);
    expect(body.entries[0]!.name).toBe("p1");
  });

  it("POST /library/compose 写入有序 durable ref，无需或不调用 transport", async () => {
    const a = join(tmp, "a.md");
    const b = join(tmp, "b.md");
    writeFileSync(a, "A\n");
    writeFileSync(b, "B");
    const app = buildApp({ withTransport: false });
    const res = await app.request("/api/context-packs/library/compose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        outRef: "packs/qitem-brief",
        sources: [{ path: a, label: "a.md" }, { path: b, label: "b.md" }],
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { ref: string; text: string; entry: { relativePath: string } };
    expect(body.ref).toBe("packs/qitem-brief");
    expect(body.entry.relativePath).toBe("packs/qitem-brief");
    expect(body.text).toBe("A\n\n\nB");
    expect(body.text).not.toContain("# zrig 上下文包：");
    expect(body.text).not.toContain("## 文件：");
    expect(lib.getByRef("packs/qitem-brief")).not.toBeNull();
    expect(transport.calls).toEqual([]);
  });

  it("POST /library/compose 返回结构化 unsafe_ref，且不写入", async () => {
    const a = join(tmp, "a.md");
    writeFileSync(a, "A");
    const app = buildApp({ withTransport: false });
    const res = await app.request("/api/context-packs/library/compose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outRef: "../escape", sources: [{ path: a, label: "a.md" }] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("unsafe_ref");
    expect(body.message).toMatch(/不安全的 pack ref/);
    expect(existsSync(join(tmp, "escape"))).toBe(false);
    expect(transport.calls).toEqual([]);
  });

  it("POST /library/compose 返回精确 missing_files envelope", async () => {
    const missing = join(tmp, "absent.md");
    const app = buildApp({ withTransport: false });
    const res = await app.request("/api/context-packs/library/compose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        outRef: "packs/missing",
        sources: [{ path: missing, label: "absent.md" }],
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "missing_files",
      message: `找不到 context 组合源文件：${missing}`,
      missingFiles: [missing],
    });
    expect(existsSync(join(libRoot, "packs", "missing"))).toBe(false);
    expect(transport.calls).toEqual([]);
  });

  it("POST /library/compose 对空 source list 返回 missing_files", async () => {
    const app = buildApp({ withTransport: false });
    const res = await app.request("/api/context-packs/library/compose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outRef: "packs/empty", sources: [] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "missing_files",
      message: "context 组合至少需要一个 --from 文件",
      missingFiles: [],
    });
    expect(existsSync(join(libRoot, "packs", "empty"))).toBe(false);
    expect(transport.calls).toEqual([]);
  });

  it.each([null, 7, []])(
    "POST /library/compose 以结构化 400 envelope 拒绝格式错误的 source member %j",
    async (sourceMember) => {
      const app = buildApp({ withTransport: false });
      const res = await app.request("/api/context-packs/library/compose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outRef: "packs/malformed", sources: [sourceMember] }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "invalid_compose_request",
        message: "body 必须包含 { outRef, sources: [{ path, label }, ...] }",
      });
      expect(existsSync(join(libRoot, "packs", "malformed"))).toBe(false);
      expect(transport.calls).toEqual([]);
    },
  );

  // Slice-03 Atom 5——死路径：已移除 colon-id `/library/:id[/preview|/send]` 路由。
  // pack 仍可按 ref 解析；legacy addressing 返回 404。
  it("colon-id /library/:id[/preview|/send] 路由已移除 → 404；by-ref 仍可解析", async () => {
    writePack(libRoot, "p1", `
name: p1
version: 1
taxonomy: world
files:
  - path: a.md
    role: r
`, { "a.md": "content" });
    lib.scan();
    const app = buildApp();
    const cid = encodeURIComponent("context-pack:p1:1");
    expect((await app.request(`/api/context-packs/library/${cid}`)).status).toBe(404);
    expect((await app.request(`/api/context-packs/library/${cid}/preview`)).status).toBe(404);
    const send = await app.request(`/api/context-packs/library/${cid}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destinationSession: "x@rig" }),
    });
    expect(send.status).toBe(404);
    // ref-primary 解析保持完好
    expect((await app.request(`/api/context-packs/library/by-ref?ref=${encodeURIComponent("p1")}`)).status).toBe(200);
  });

  it("GET /library/by-ref/preview 返回组合后的 bundle", async () => {
    writePack(libRoot, "preview-pack", `
name: preview-pack
version: 1
taxonomy: world
purpose: Preview test
files:
  - path: a.md
    role: r
`, { "a.md": "BODY-A" });
    lib.scan();
    const app = buildApp();
    const res = await app.request(`/api/context-packs/library/by-ref/preview?ref=${encodeURIComponent("preview-pack")}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; bundleText: string; bundleBytes: number; missingFiles: unknown[] };
    expect(body.id).toBe("context-pack:preview-pack");
    expect(body.bundleText).toContain("# zrig 上下文包：preview-pack v1");
    expect(body.bundleText).toContain("BODY-A");
    expect(body.bundleBytes).toBeGreaterThan(0);
    expect(body.missingFiles).toEqual([]);
  });

  it("GET /library/by-ref/preview 对缺失 ref 返回 404，对不安全/未提供 ref 返回 400", async () => {
    const app = buildApp();
    expect((await app.request(`/api/context-packs/library/by-ref/preview?ref=${encodeURIComponent("packs/absent")}`)).status).toBe(404);
    expect((await app.request(`/api/context-packs/library/by-ref/preview?ref=${encodeURIComponent("../escape")}`)).status).toBe(400);
    expect((await app.request(`/api/context-packs/library/by-ref/preview`)).status).toBe(400);
  });

  it("无 delivery：没有 send route、SessionTransport import 或 transport call", async () => {
    const app = buildApp();
    const response = await app.request(`/api/context-packs/library/by-ref/send?ref=${encodeURIComponent("dry")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destinationSession: "test@rig" }),
    });
    expect(response.status).toBe(404);
    expect(transport.calls).toEqual([]);
    const source = readFileSync(new URL("../src/routes/context-packs.ts", import.meta.url), "utf8");
    expect(source).not.toContain("SessionTransport");
    expect(source).not.toMatch(/router\.post\([^\n]*\/send/);
  });

  // Slice-03 ATOM 4——path-like-ref 解析/删除 surface。ref 包含 '/'，因此作为 `?ref=` query
  // 传递（绝不作为 `:id` path segment）。两个操作都经过封闭的 getByRef/removeByRef boundary。
  it("GET /library/by-ref 按 path-like ref 解析 pack（由 getByRef 支撑）", async () => {
    writePack(libRoot, join("packs", "smoke"), `
name: smoke
version: 1
taxonomy: world
purpose: Ref pack
files:
  - path: notes.md
    role: notes
`, { "notes.md": "Hello" });
    lib.scan();
    const app = buildApp();
    const res = await app.request(`/api/context-packs/library/by-ref?ref=${encodeURIComponent("packs/smoke")}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { name: string; relativePath: string };
    expect(body.name).toBe("smoke");
    expect(body.relativePath).toBe("packs/smoke");
  });

  it("GET /library/by-ref 对 traversal ref 返回结构化 400 unsafe_ref", async () => {
    const app = buildApp();
    const res = await app.request(`/api/context-packs/library/by-ref?ref=${encodeURIComponent("../escape")}`);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe("unsafe_ref");
    expect(body.message).toMatch(/不安全的 pack ref/);
  });

  it("GET /library/by-ref 对安全但不存在的 ref 返回 404", async () => {
    const app = buildApp();
    const res = await app.request(`/api/context-packs/library/by-ref?ref=${encodeURIComponent("packs/absent")}`);
    expect(res.status).toBe(404);
  });

  it("GET /library/by-ref 缺少 ref query 时返回 400", async () => {
    const app = buildApp();
    const res = await app.request("/api/context-packs/library/by-ref");
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("ref_required");
  });

  it("DELETE /library/by-ref 删除 pack；随后无法解析该 ref", async () => {
    writePack(libRoot, join("packs", "smoke"), `
name: smoke
version: 1
taxonomy: world
files:
  - path: notes.md
    role: notes
`, { "notes.md": "Hello" });
    lib.scan();
    expect(lib.getByRef("packs/smoke")).not.toBeNull();
    const app = buildApp();
    const res = await app.request(`/api/context-packs/library/by-ref?ref=${encodeURIComponent("packs/smoke")}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json() as { removed: boolean; ref: string };
    expect(body.removed).toBe(true);
    expect(body.ref).toBe("packs/smoke");
    expect(lib.getByRef("packs/smoke")).toBeNull();
    expect(existsSync(join(libRoot, "packs", "smoke"))).toBe(false);
  });

  it("DELETE /library/by-ref 返回结构化 400 unsafe_ref，且不作修改", async () => {
    writePack(libRoot, join("packs", "keep"), `
name: keep
version: 1
taxonomy: world
files:
  - path: notes.md
    role: notes
`, { "notes.md": "x" });
    lib.scan();
    const app = buildApp();
    const res = await app.request(`/api/context-packs/library/by-ref?ref=${encodeURIComponent("../escape")}`, { method: "DELETE" });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unsafe_ref");
    expect(lib.getByRef("packs/keep")).not.toBeNull();
    expect(existsSync(join(libRoot, "packs", "keep"))).toBe(true);
  });

  it("DELETE /library/by-ref 对安全但不存在的 ref 返回 404 pack_not_found", async () => {
    const app = buildApp();
    const res = await app.request(`/api/context-packs/library/by-ref?ref=${encodeURIComponent("packs/absent")}`, { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("pack_not_found");
  });

  it("DELETE /library/by-ref 对已交付的 builtin pack 返回 403 pack_not_removable", async () => {
    const builtinRoot = join(tmp, "builtin");
    writePack(builtinRoot, join("packs", "shipped"), `
name: shipped
version: 1
taxonomy: world
files:
  - path: notes.md
    role: notes
`, { "notes.md": "x" });
    const builtinLib = new ContextPackLibraryService({ roots: [{ path: builtinRoot, sourceType: "builtin" }] });
    builtinLib.scan();
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("contextPackLibrary" as never, builtinLib); await next(); });
    app.route("/api/context-packs", contextPacksRoutes());
    const res = await app.request(`/api/context-packs/library/by-ref?ref=${encodeURIComponent("packs/shipped")}`, { method: "DELETE" });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("pack_not_removable");
    expect(existsSync(join(builtinRoot, "packs", "shipped"))).toBe(true);
  });

  // Slice-03 Atom 6（zrig walk）——供 paced delivery 使用的有序逐 member 内容。
  it("GET /library/by-ref/pieces 返回有序 member 内容，并报告缺失 member", async () => {
    writePack(libRoot, join("packs", "walkme"), `
name: walkme
version: 1
taxonomy: world
files:
  - path: intro.md
    role: intro
  - path: gone.md
    role: proof
  - path: steps.md
    role: steps
`, { "intro.md": "INTRO-BODY", "steps.md": "STEPS-BODY" }); // gone.md intentionally absent
    lib.scan();
    const app = buildApp();
    const res = await app.request(`/api/context-packs/library/by-ref/pieces?ref=${encodeURIComponent("packs/walkme")}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { ref: string; pieces: Array<{ path: string; content: string }>; missingFiles: Array<{ path: string }>; text: string; bytes: number };
    expect(body.ref).toBe("packs/walkme");
    expect(body.pieces.map((p) => p.path)).toEqual(["intro.md", "steps.md"]);
    expect(body.pieces.map((p) => p.content)).toEqual(["INTRO-BODY", "STEPS-BODY"]);
    expect(body.missingFiles.map((m) => m.path)).toEqual(["gone.md"]);
    // Atom 6b：`text` = 完整 plain content（以 compose separator "\n\n" 连接存在的 member）。
    expect(body.text).toBe("INTRO-BODY\n\nSTEPS-BODY");
    expect(body.bytes).toBe(Buffer.byteLength("INTRO-BODY\n\nSTEPS-BODY"));
  });

  it("GET /library/by-ref/pieces 对缺失 ref 返回 404，对不安全/未提供 ref 返回 400", async () => {
    const app = buildApp();
    expect((await app.request(`/api/context-packs/library/by-ref/pieces?ref=${encodeURIComponent("packs/absent")}`)).status).toBe(404);
    expect((await app.request(`/api/context-packs/library/by-ref/pieces?ref=${encodeURIComponent("../escape")}`)).status).toBe(400);
    expect((await app.request(`/api/context-packs/library/by-ref/pieces`)).status).toBe(400);
  });
});
