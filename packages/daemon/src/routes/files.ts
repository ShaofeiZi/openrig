// UI 增强包 v0 + 操作员表面对账 v0——文件浏览路由。
//
// 端点（item 3 + item 4）：
//   GET  /api/files/roots                          白名单 root 列表
//   GET  /api/files/list?root=<name>&path=<rel>    目录条目
//   GET  /api/files/read?root=<name>&path=<rel>    文件内容 + 元数据
//   GET  /api/files/asset?root=<name>&path=<rel>   内嵌图片的原始字节
//   POST /api/files/write                          原子写（item 4）
//
// 操作员表面对账 v0 item 5：GET /read 把返回内容截断到
// FILE_READ_TRUNCATION_BYTES（1 MB；PRD § Item 5；dashboard 先例）。
// 响应包含 `truncated`、`truncatedAtBytes`、`totalBytes`，以便 UI 渲染截断标记。
// 哈希仍基于完整文件内容计算，这样即使读取被截断，原子写冲突检测依然诚实。
//
// 路由顺序纪律（按 Phase A R1 SSE 教训）：所有路由都是字面量——无 `/:param`
// 通配——因此顺序对遮蔽无影响。按可读性保持顺序排列。

import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveActorWithDeferral } from "./require-sender-identity.js";
import {
  resolveAllowedDirectory,
  resolveAllowedFile,
  resolveAllowedPath,
  FilePathSafetyError,
  type AllowlistRoot,
} from "../domain/files/path-safety.js";
import {
  WriteConflictError,
  FileWriteError,
  type FileWriteService,
} from "../domain/files/file-write-service.js";

export interface FilesRoutesDeps {
  /** 启动时解析的白名单；空数组 = 未配置任何 root。 */
  allowlist: AllowlistRoot[];
  /** 原子写服务；缺失 → POST /write 返回 503 未配置。 */
  writeService: FileWriteService | null;
}

/** 操作员表面对账 v0 item 5：文件读取截断上限。PRD § Item 5 取 1 MB。
 *  dashboard 先例是 200 KB；v0 上限取 1 MB，以便操作员能完整读取大多数工作区 canon 文件。 */
export { FILE_READ_TRUNCATION_BYTES } from "../domain/files/file-read.js";
import { readAllowedFile } from "../domain/files/file-read.js";

export function filesRoutes(): Hono {
  const app = new Hono();

  function getDeps(c: { get: (key: string) => unknown }): FilesRoutesDeps | null {
    const allowlist = c.get("filesAllowlist" as never) as AllowlistRoot[] | undefined;
    const writeService = c.get("fileWriteService" as never) as FileWriteService | null | undefined;
    if (!allowlist) return null;
    return { allowlist, writeService: writeService ?? null };
  }

  function pathSafetyErrorResponse(c: { json: (body: unknown, status?: number) => Response }, err: FilePathSafetyError): Response {
    const status =
      err.code === "root_unknown" ? 400
      : err.code === "path_invalid" || err.code === "path_escape" ? 400
      : err.code === "stat_failed" ? 404
      : err.code === "not_a_file" || err.code === "not_a_directory" ? 400
      : 500;
    return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, status as 200);
  }

  app.get("/roots", (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "files_routes_unavailable" }, 503);
    if (deps.allowlist.length === 0) {
      return c.json({
        roots: [],
        hint: "未配置白名单 root。请设置 OPENRIG_FILES_ALLOWLIST=name1:/abs/path,name2:/abs/path 并重启后台服务。",
      });
    }
    return c.json({
      roots: deps.allowlist.map((r) => ({ name: r.name, path: r.canonicalPath })),
    });
  });

  app.get("/list", (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "files_routes_unavailable" }, 503);
    const rootName = c.req.query("root") ?? "";
    const relativePath = c.req.query("path") ?? "";
    if (!rootName) return c.json({ error: "root_required" }, 400);
    try {
      const resolved = resolveAllowedDirectory(deps.allowlist, rootName, relativePath);
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      return c.json({
        root: rootName,
        path: relativePath,
        entries: entries
          .map((entry) => {
            // 默认跳过 dotfile，除非它们位于一个本身就是点目录的白名单 root 内
            // （例如操作员把 ~/.openrig 加入白名单——此时操作员显然想检视 dotfile）。
            // 实现：v0 始终包含 dotfile；操作员通过把该 root 加入白名单已经表达了检视意图。
            const fullPath = path.join(resolved, entry.name);
            let stat: fs.Stats | null = null;
            try { stat = fs.statSync(fullPath); } catch { /* 跳过 stat 失败 */ }
            return {
              name: entry.name,
              type: entry.isDirectory() ? "dir" as const : entry.isFile() ? "file" as const : "other" as const,
              size: stat?.isFile() ? stat.size : null,
              mtime: stat ? stat.mtime.toISOString() : null,
            };
          })
          .sort((a, b) => {
            if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
            return a.name.localeCompare(b.name);
          }),
      });
    } catch (err) {
      if (err instanceof FilePathSafetyError) return pathSafetyErrorResponse(c, err);
      return c.json({ error: "list_failed", message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/read", (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "files_routes_unavailable" }, 503);
    const rootName = c.req.query("root") ?? "";
    const relativePath = c.req.query("path") ?? "";
    if (!rootName || !relativePath) return c.json({ error: "root_and_path_required" }, 400);
    try {
      return c.json(readAllowedFile(deps.allowlist, rootName, relativePath));
    } catch (err) {
      if (err instanceof FilePathSafetyError) return pathSafetyErrorResponse(c, err);
      return c.json({ error: "read_failed", message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/asset", (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "files_routes_unavailable" }, 503);
    const rootName = c.req.query("root") ?? "";
    const relativePath = c.req.query("path") ?? "";
    if (!rootName || !relativePath) return c.json({ error: "root_and_path_required" }, 400);
    try {
      const resolved = resolveAllowedFile(deps.allowlist, rootName, relativePath);
      const size = fs.statSync(resolved).size;
      let contentType = inferContentType(resolved);
      // OPR.0.4.4.20 FR-11：.html 仅在显式 ?render=1 时渲染为 text/html
      // （其他所有读取仍默认 text/plain）。一方操作员 mockup 在新标签页打开；此处 CSP 是
      // 文档化的建议姿态，刻意不作为默认拒绝门。
      if (c.req.query("render") === "1" && path.extname(resolved).toLowerCase() === ".html") {
        contentType = "text/html; charset=utf-8";
      }

      // OPR.0.4.4.20 FR-5：仅在本路由支持 byte-range（iOS Safari 媒体播放需要
      // 206 + Accept-Ranges；整文件 200 是文档化的 iOS 失败模式）。仅支持单 range 形式。
      const rangeHeader = c.req.header("Range");
      if (rangeHeader) {
        const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
        const start = m && m[1] !== "" ? Number(m[1]) : m && m[2] !== "" ? size - Number(m[2]) : NaN;
        const end = m && m[1] !== "" && m[2] !== "" ? Number(m[2]) : size - 1;
        if (!m || Number.isNaN(start) || start < 0 || start >= size || end < start) {
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" },
          });
        }
        const boundedEnd = Math.min(end, size - 1);
        const length = boundedEnd - start + 1;
        const fd = fs.openSync(resolved, "r");
        try {
          const buf = Buffer.alloc(length);
          fs.readSync(fd, buf, 0, length, start);
          return new Response(new Uint8Array(buf), {
            status: 206,
            headers: {
              "Content-Type": contentType,
              "Content-Range": `bytes ${start}-${boundedEnd}/${size}`,
              "Content-Length": String(length),
              "Accept-Ranges": "bytes",
              "Cache-Control": "public, max-age=300",
            },
          });
        } finally {
          fs.closeSync(fd);
        }
      }

      const data = fs.readFileSync(resolved);
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=300",
        },
      });
    } catch (err) {
      if (err instanceof FilePathSafetyError) return pathSafetyErrorResponse(c, err);
      return c.json({ error: "asset_failed", message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/write", async (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "files_routes_unavailable" }, 503);
    if (!deps.writeService) {
      return c.json({
        error: "file_write_service_unavailable",
        hint: "OPENRIG_FILES_ALLOWLIST 为空或未设置；请至少配置一个根目录并重启。",
      }, 503);
    }
    const body = await c.req.json<{
      root?: string;
      path?: string;
      content?: string;
      expectedMtime?: string;
      expectedContentHash?: string;
      actor?: string;
    }>().catch(() => ({} as never));
    if (!body.root) return c.json({ error: "root_required" }, 400);
    if (!body.path) return c.json({ error: "path_required" }, 400);
    if (typeof body.content !== "string") return c.json({ error: "content_required" }, 400);
    if (!body.expectedMtime) return c.json({ error: "expectedMtime_required" }, 400);
    if (!body.expectedContentHash) return c.json({ error: "expectedContentHash_required" }, 400);
    // P21 I5：files 写是创始人可见表面——transport 头存在时以其为准（transport:v1）；
    // 缺失时（浏览器 UI 路径）body actor 按 CLAIMED 时代记录（identity_provenance null），
    // 而非拒绝——这是具名 deferral（owner=dev50，d00c468d）。
    const identity = resolveActorWithDeferral(c, { verb: "文件写入", bodyClaim: body.actor });
    if (!identity.ok) return identity.response;
    try {
      const result = deps.writeService.writeAtomic({
        rootName: body.root,
        path: body.path,
        content: body.content,
        expectedMtime: body.expectedMtime,
        expectedContentHash: body.expectedContentHash,
        actor: identity.session,
        identityProvenance: identity.provenance,
      });
      return c.json({
        root: body.root,
        path: body.path,
        absolutePath: result.absolutePath,
        newMtime: result.newMtime,
        newContentHash: result.newContentHash,
        byteCountDelta: result.byteCountDelta,
      });
    } catch (err) {
      if (err instanceof WriteConflictError) {
        return c.json({
          error: "write_conflict",
          message: err.message,
          currentMtime: err.currentMtime,
          currentContentHash: err.currentContentHash,
        }, 409);
      }
      if (err instanceof FilePathSafetyError) return pathSafetyErrorResponse(c, err);
      if (err instanceof FileWriteError) {
        return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, 500);
      }
      return c.json({ error: "write_failed", message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  return app;
}

function inferContentType(absPath: string): string {
  const ext = path.extname(absPath).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".mp4": return "video/mp4";
    case ".webm": return "video/webm";
    case ".pdf": return "application/pdf";
    case ".md":
    case ".txt":
    case ".log": return "text/plain; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".yaml":
    case ".yml": return "text/yaml; charset=utf-8";
    case ".js":
    case ".ts":
    case ".tsx":
    case ".jsx":
    case ".css":
    case ".html": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

// 为 workflow-routes 中的路由顺序纪律测试而重新导出。
export { resolveAllowedPath };
