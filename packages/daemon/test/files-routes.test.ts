// UI 增强包 v0——文件路由端到端测试。
//
// 针对手动挂载的 Hono 应用和临时允许列表驱动路由。固定以下行为：
//   - GET /api/files/roots：roots 为空 → 提示；非空 → 列表
//   - GET /api/files/list：目录列表 + 路径安全负向用例
//   - GET /api/files/read：content + mtime + contentHash + size
//   - GET /api/files/asset：以正确 Content-Type 返回图片字节
//   - POST /api/files/write：成功 → 追加审计行；mtime 不匹配 → 409 并携带
//     current{Mtime,ContentHash}
//   - 未设置 filesAllowlist 上下文时优雅返回 503

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesRoutes } from "../src/routes/files.js";
import { FileWriteService } from "../src/domain/files/file-write-service.js";
import type { AllowlistRoot } from "../src/domain/files/path-safety.js";

function buildApp(opts: { allowlist: AllowlistRoot[]; writeService: FileWriteService | null } | null): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (opts) {
      c.set("filesAllowlist" as never, opts.allowlist);
      c.set("fileWriteService" as never, opts.writeService);
    }
    await next();
  });
  app.route("/api/files", filesRoutes());
  return app;
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("UI 增强包 v0——/api/files 路由", () => {
  let tempDir: string;
  let allowlist: AllowlistRoot[];
  let writeService: FileWriteService;
  let app: Hono;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "files-routes-"));
    mkdirSync(join(tempDir, "workspace", "subdir"), { recursive: true });
    writeFileSync(join(tempDir, "workspace", "STEERING.md"), "# steering content\n");
    writeFileSync(join(tempDir, "workspace", "subdir", "nested.md"), "# nested\n");
    // 用于产物类型检测的最小 PNG 文件头。
    writeFileSync(join(tempDir, "workspace", "image.png"), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
    allowlist = [{ name: "workspace", canonicalPath: realpathSync(join(tempDir, "workspace")) }];
    writeService = new FileWriteService({
      allowlist,
      auditFilePath: join(tempDir, "audit.jsonl"),
    });
    app = buildApp({ allowlist, writeService });
  });

  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  describe("GET /roots", () => {
    it("未设置 filesAllowlist 上下文时返回 503", async () => {
      const res = await buildApp(null).request("/api/files/roots");
      expect(res.status).toBe(503);
    });

    it("允许列表为空时返回空 roots 和设置提示", async () => {
      const res = await buildApp({ allowlist: [], writeService: null }).request("/api/files/roots");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { roots: AllowlistRoot[]; hint?: string };
      expect(body.roots).toEqual([]);
      expect(body.hint).toContain("OPENRIG_FILES_ALLOWLIST");
    });

    it("返回已配置的 roots", async () => {
      const res = await app.request("/api/files/roots");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { roots: Array<{ name: string; path: string }> };
      expect(body.roots).toEqual([{ name: "workspace", path: realpathSync(join(tempDir, "workspace")) }]);
    });
  });

  describe("GET /list", () => {
    it("列出根目录条目及其 type、size 和 mtime", async () => {
      const res = await app.request("/api/files/list?root=workspace&path=");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entries: Array<{ name: string; type: string }> };
      const names = body.entries.map((e) => e.name).sort();
      expect(names).toContain("STEERING.md");
      expect(names).toContain("subdir");
      expect(names).toContain("image.png");
    });

    it("将目录排在文件之前", async () => {
      const res = await app.request("/api/files/list?root=workspace&path=");
      const body = (await res.json()) as { entries: Array<{ name: string; type: string }> };
      const types = body.entries.map((e) => e.type);
      // 前 N 个条目均为目录。
      const dirCount = types.findIndex((t) => t !== "dir");
      const allDirsFirst = types.slice(0, dirCount === -1 ? types.length : dirCount).every((t) => t === "dir");
      expect(allDirsFirst).toBe(true);
    });

    it("以 400 拒绝 '..' 越界", async () => {
      const res = await app.request("/api/files/list?root=workspace&path=..%2F..%2F");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("path_escape");
    });

    it("以 400 拒绝未知 root", async () => {
      const res = await app.request("/api/files/list?root=does-not-exist&path=");
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("root_unknown");
    });
  });

  describe("GET /read", () => {
    it("返回 content、mtime、contentHash 和 size", async () => {
      const res = await app.request("/api/files/read?root=workspace&path=STEERING.md");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { content: string; mtime: string; contentHash: string; size: number };
      expect(body.content).toBe("# steering content\n");
      expect(body.contentHash).toBe(sha256("# steering content\n"));
      expect(body.size).toBeGreaterThan(0);
      expect(body.mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("以 400 拒绝路径穿越", async () => {
      const res = await app.request("/api/files/read?root=workspace&path=..%2Fescape.md");
      expect(res.status).toBe(400);
    });
  });

  describe("GET /asset", () => {
    it("以 image/png Content-Type 提供 .png 文件", async () => {
      const res = await app.request("/api/files/asset?root=workspace&path=image.png");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("cache-control")).toContain("max-age");
    });
  });

  describe("POST /write", () => {
    it("未接入 writeService 时返回 503 和提示", async () => {
      const res = await buildApp({ allowlist, writeService: null }).request("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: "workspace", path: "STEERING.md", content: "x", expectedMtime: "x", expectedContentHash: "x", actor: "y" }),
      });
      expect(res.status).toBe(503);
    });

    it("expectedMtime 不匹配时以 409 和当前值拒绝", async () => {
      const res = await app.request("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          root: "workspace",
          path: "STEERING.md",
          content: "rewritten",
          expectedMtime: "2099-01-01T00:00:00.000Z",
          expectedContentHash: "deadbeef",
          actor: "test@r",
        }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; currentMtime: string; currentContentHash: string };
      expect(body.error).toBe("write_conflict");
      expect(body.currentContentHash).toBe(sha256("# steering content\n"));
    });

    it("expectedMtime 与 expectedContentHash 匹配时成功，并追加审计行", async () => {
      const target = join(tempDir, "workspace", "STEERING.md");
      const stat = statSync(target);
      const expectedMtime = stat.mtime.toISOString();
      const expectedContentHash = sha256(readFileSync(target));
      const res = await app.request("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          root: "workspace",
          path: "STEERING.md",
          content: "# new steering\n",
          expectedMtime,
          expectedContentHash,
          actor: "test@r",
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { newContentHash: string; byteCountDelta: number };
      expect(body.newContentHash).toBe(sha256("# new steering\n"));
      // 磁盘文件包含新内容。
      expect(readFileSync(target, "utf-8")).toBe("# new steering\n");
      // 已追加审计行。
      const auditPath = join(tempDir, "audit.jsonl");
      const audit = readFileSync(auditPath, "utf-8").trim().split("\n");
      expect(audit).toHaveLength(1);
      const row = JSON.parse(audit[0]!) as { actor: string; root: string; path: string };
      expect(row.actor).toBe("test@r");
      expect(row.root).toBe("workspace");
      expect(row.path).toBe("STEERING.md");
      // P21 I5 具名延后处理：缺少请求头（UI/浏览器路径）时记录请求体操作者，并标记已声明的
      // claimed-era 变体 `claimed:v1`（PM 固定——绝不为 null；如今 null 仅表示清查前旧数据，
      // 因而旧行与今天创始人在 UI 的点击仍可区分）。绝不拒绝或破坏流程。
      expect((row as { identity_provenance: string | null }).identity_provenance).toBe("claimed:v1");
    });

    // P21 I5——文件写入是创始人可见接口；resolveActorWithDeferral 将其拆分为两条路径：
    // 有请求头（CLI/DaemonClient）→ 推导身份 + transport:v1 + 不匹配时返回 409；无请求头
    //（浏览器 UI）→ claimed-era（NULL 来源），绝不中断（具名延后处理，owner=dev50）。
    it("write——存在请求头时推导操作者，并为审计 identity_provenance 标记 transport:v1", async () => {
      const target = join(tempDir, "workspace", "STEERING.md");
      const expectedMtime = statSync(target).mtime.toISOString();
      const expectedContentHash = sha256(readFileSync(target));
      const res = await app.request("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "cli@r" },
        body: JSON.stringify({ root: "workspace", path: "STEERING.md", content: "# via cli\n", expectedMtime, expectedContentHash }),
      });
      expect(res.status).toBe(200);
      const audit = readFileSync(join(tempDir, "audit.jsonl"), "utf-8").trim().split("\n");
      const row = JSON.parse(audit[audit.length - 1]!) as { actor: string; identity_provenance: string | null };
      expect(row.actor).toBe("cli@r");
      expect(row.identity_provenance).toBe("transport:v1");
    });

    it("write——请求头存在且请求体 actor 不同时，以线路身份为准（actor cli@r，transport:v1）；不再返回 409", async () => {
      const target = join(tempDir, "workspace", "STEERING.md");
      const expectedMtime = statSync(target).mtime.toISOString();
      const expectedContentHash = sha256(readFileSync(target));
      const res = await app.request("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "cli@r" },
        body: JSON.stringify({ root: "workspace", path: "STEERING.md", content: "x", expectedMtime, expectedContentHash, actor: "mallory@r" }), // 被覆盖。
      });
      expect(res.status).toBe(200);
      const audit = readFileSync(join(tempDir, "audit.jsonl"), "utf-8").trim().split("\n");
      const row = JSON.parse(audit[audit.length - 1]!) as { actor: string; identity_provenance: string | null };
      expect(row.actor).toBe("cli@r"); // 以线路身份为准；mallory@r 被覆盖。
      expect(row.identity_provenance).toBe("transport:v1");
    });

    it("write——缺少请求头且请求体无 actor → 400 actor_required（延后处理仍需某个操作者）", async () => {
      const target = join(tempDir, "workspace", "STEERING.md");
      const expectedMtime = statSync(target).mtime.toISOString();
      const expectedContentHash = sha256(readFileSync(target));
      const res = await app.request("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: "workspace", path: "STEERING.md", content: "x", expectedMtime, expectedContentHash }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("actor_required");
    });

    it("以 400 拒绝缺少必填字段的请求", async () => {
      const res = await app.request("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: "workspace" }),
      });
      expect(res.status).toBe(400);
    });

    it("以 400 拒绝路径穿越（路径安全检查优先于 stat）", async () => {
      const res = await app.request("/api/files/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          root: "workspace",
          path: "../escape.md",
          content: "x",
          expectedMtime: "x",
          expectedContentHash: "x",
          actor: "y",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("path_escape");
    });
  });
});
