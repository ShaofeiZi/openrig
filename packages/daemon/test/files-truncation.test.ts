// Operator Surface Reconciliation v0——files /read 截断测试。
//
// 固定第 5 项：GET /api/files/read 将返回内容限制在 FILE_READ_TRUNCATION_BYTES（1 MB），并在
// 响应中显示截断标记字段。Hash 根据完整文件计算，使 edit-mode 冲突检测在读取被截断时仍然真实。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_READ_TRUNCATION_BYTES, filesRoutes } from "../src/routes/files.js";
import type { AllowlistRoot } from "../src/domain/files/path-safety.js";

function buildApp(allowlist: AllowlistRoot[]): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("filesAllowlist" as never, allowlist);
    c.set("fileWriteService" as never, null);
    await next();
  });
  app.route("/api/files", filesRoutes());
  return app;
}

describe("Operator Surface Reconciliation v0——/api/files/read 截断", () => {
  let tempDir: string;
  let allowlist: AllowlistRoot[];
  let app: Hono;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "files-trunc-"));
    mkdirSync(join(tempDir, "ws"), { recursive: true });
    allowlist = [{ name: "ws", canonicalPath: realpathSync(join(tempDir, "ws")) }];
    app = buildApp(allowlist);
  });

  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  it("文件不超过 1 MB 时返回 truncated=false、truncatedAtBytes=null 和完整内容", async () => {
    const content = "small file content\n";
    writeFileSync(join(tempDir, "ws", "small.md"), content);
    const res = await app.request("/api/files/read?root=ws&path=small.md");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      content: string; truncated: boolean; truncatedAtBytes: number | null; totalBytes: number;
    };
    expect(body.truncated).toBe(false);
    expect(body.truncatedAtBytes).toBeNull();
    expect(body.totalBytes).toBe(content.length);
    expect(body.content).toBe(content);
  });

  it("文件超过 1 MB 时返回 truncated=true、truncatedAtBytes=1048576 和截断内容", async () => {
    // 1.5 MB 合成文件：首字节为 'H'，其余以 'x' 填充。
    const totalBytes = 1_572_864; // 1.5 MB
    const content = "H" + "x".repeat(totalBytes - 1);
    writeFileSync(join(tempDir, "ws", "large.md"), content);
    const res = await app.request("/api/files/read?root=ws&path=large.md");
    expect(res.status).toBe(200);
    const body = await res.json() as {
      content: string;
      truncated: boolean;
      truncatedAtBytes: number | null;
      totalBytes: number;
      contentHash: string;
    };
    expect(body.truncated).toBe(true);
    expect(body.truncatedAtBytes).toBe(FILE_READ_TRUNCATION_BYTES);
    expect(body.totalBytes).toBe(totalBytes);
    // 内容限制在 FILE_READ_TRUNCATION_BYTES（1 MB）。
    expect(body.content.length).toBe(FILE_READ_TRUNCATION_BYTES);
    expect(body.content[0]).toBe("H");
    // Hash 根据完整文件而非截断片段计算，使 edit-mode 冲突检测在超过 1 MB 的文件被截断读取时
    // 仍然真实。（编辑此类文件属于操作员错误范围；UI 会显示截断标记，提示操作员使用外部编辑器。）
    const fullHash = createHash("sha256").update(content).digest("hex");
    expect(body.contentHash).toBe(fullHash);
  });

  it("按 PRD 第 5 项，FILE_READ_TRUNCATION_BYTES 恰为 1 MB", () => {
    expect(FILE_READ_TRUNCATION_BYTES).toBe(1_048_576);
  });
});
