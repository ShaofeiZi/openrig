// Phase 3a slice 3.3——插件 HTTP 路由（只读）。
//
// SC-29 例外 #8 逐字声明：
// "Slice 3.3（UI 插件表面）需要后台服务侧 plugin-discovery-service
// + 3 个 HTTP 路由（GET /api/plugins、GET /api/plugins/:id、GET /api/plugins/:id/used-by）
// 作为支撑 API。无额外状态、无 SQL migration、无变更路由。
// 只读发现表面，按 DESIGN.md §5.4 聚合文件系统扫描的并集。
// 按 IMPL-PRD §3.3 'Code touches' 此分配是显式的；
// 按已记录的 SC-29 逐字声明规则留档。"
//
// SC-29 例外 #11（slice 28 library-explorer-finishing）逐字声明：
// "Slice 28（Library Explorer 收尾——founder walk 后续）需要：
// (a) 两个附加只读 HTTP 路由——GET /api/plugins/:id/files/list
// 和 GET /api/plugins/:id/files/read——包装既有 path-safety 机制
// （resolveAllowedDirectory/File），以发现的插件绝对路径充当合成单根 allowlist。
// 使 docs-browser 能导航插件的磁盘文件夹，而无需操作者在
// OPENRIG_FILES_ALLOWLIST 中把 ~/.openrig/plugins/ 加白。
// (b) 一个 PluginEntry 形状扩展——skillCount: number——在 detectPlugin() 中
// 通过 readdir <plugin>/skills/ 填充。在插件列表响应中暴露 skill 计数，
// 使 PluginsIndexPage 渲染该列时无需每行一次 N+1 详情拉取。
// 无额外状态、无 SQL migration、对插件文件夹无写变更。
// 按 slice 28 founder 指示的只读 docs-browser 表面
// 「finishing it is 0.3.1 work, not 0.3.2」。路由决策
// qitem-20260513042155-f31c11c3（orch OPT-A 授权）。"
//
// 端点形状：
//   GET /api/plugins                              → PluginEntry[]   （?runtime=、?source= 过滤）
//   GET /api/plugins/:id                          → PluginDetail    （未知时 404）
//   GET /api/plugins/:id/used-by                  → AgentReference[]
//   GET /api/plugins/:id/files/list?path=<rel>    → FilesListResponse（slice 28）
//   GET /api/plugins/:id/files/read?path=<rel>    → FilesReadResponse（slice 28）
//
// 服务未在 context 中配置时所有端点返回 503
// （与既有后台服务可选服务路由模式一致）。
// /files/list + /files/read 用发现的插件路径作为合成 AllowlistRoot，
// 并复用 resolveAllowedDirectory/File 做路径安全。

import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  PluginDiscoveryService,
  PluginRuntime,
  PluginSourceKind,
} from "../domain/plugin-discovery-service.js";
import {
  resolveAllowedDirectory,
  resolveAllowedFile,
  FilePathSafetyError,
  type AllowlistRoot,
} from "../domain/files/path-safety.js";
import { sha256Hex } from "../domain/files/file-write-service.js";
import { FILE_READ_TRUNCATION_BYTES } from "./files.js";

type ContextGetter = (key: string) => unknown;

function getService(c: { get: ContextGetter }): PluginDiscoveryService | undefined {
  return c.get("pluginDiscoveryService" as never) as PluginDiscoveryService | undefined;
}

function parseRuntimeFilter(value: string | undefined): PluginRuntime | undefined {
  if (value === "claude" || value === "codex") return value;
  return undefined;
}

function parseSourceFilter(value: string | undefined): PluginSourceKind | undefined {
  if (value === "vendored" || value === "claude-cache" || value === "codex-cache") return value;
  return undefined;
}

function pluginRootAllowlist(absolutePath: string): AllowlistRoot[] {
  // 限定在插件文件夹内的合成单根 allowlist。
  // 复用既有 path-safety helper 做 ../ 逃逸 / 符号链接 realpath 包含检查，
  // 不与任何 allowlist 环境变量耦合
  // （操作者无需在 OPENRIG_FILES_ALLOWLIST 中声明插件路径）。
  //
  // 经 fs.realpathSync 归一化，使包含检查（realpath vs canonicalPath）
  // 在输入路径本身就是符号链接链的平台上成立
  // （例如 macOS /tmp → /private/tmp、/var/folders → /private/var/folders）。
  // 与 path-safety.ts 中 decodeAllowlist 的归一化一致。
  let canonical: string;
  try {
    canonical = fs.realpathSync(absolutePath);
  } catch {
    canonical = path.resolve(absolutePath);
  }
  return [{ name: "plugin", canonicalPath: canonical }];
}

function pathSafetyErrorResponse(
  c: { json: (body: unknown, status?: number) => Response },
  err: FilePathSafetyError,
): Response {
  const status =
    err.code === "root_unknown" ? 400
    : err.code === "path_invalid" || err.code === "path_escape" ? 400
    : err.code === "stat_failed" ? 404
    : err.code === "not_a_file" || err.code === "not_a_directory" ? 400
    : 500;
  return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, status as 200);
}

export function pluginsRoutes(): Hono {
  const router = new Hono();

  // GET /——列出可发现的插件
  router.get("/", (c) => {
    const service = getService(c);
    if (!service) return c.json({ error: "plugin_discovery_unavailable" }, 503);
    const runtimeFilter = parseRuntimeFilter(c.req.query("runtime"));
    const sourceFilter = parseSourceFilter(c.req.query("source"));
    // Slice 3.3 fix-C——DESIGN §5.4 并集第 4 类：rig 捆绑的
    // <cwd>/.claude/plugins/* + <cwd>/.codex/plugins/*。API 调用方
    // （rig 上下文中的 UI、slice 3.4 的 CLI）在希望纳入 rig-cwd 发现时传 ?cwd=<path>；
    // Library 页面省略它（跨切视图）。
    const cwd = c.req.query("cwd");
    const cwdScanRoots = cwd ? [cwd] : undefined;
    const plugins = service.listPlugins({ runtimeFilter, sourceFilter, cwdScanRoots });
    return c.json(plugins);
  });

  // GET /:id/used-by——反查引用此插件的智能体。
  // 挂载在 /:id 之前，使字面子路径不被裸参数 catchall 吃掉
  // （按 spec-library-routes Phase A R1 SSE 路由顺序教训，已记录在该文件）。
  router.get("/:id/used-by", (c) => {
    const service = getService(c);
    if (!service) return c.json({ error: "plugin_discovery_unavailable" }, 503);
    const id = c.req.param("id");
    return c.json(service.findUsedBy(id));
  });

  // Slice 28——GET /:id/files/list?path=<rel>
  // 列出插件源文件夹内的目录条目。用既有 path-safety helper，
  // 配以由发现的插件绝对路径构建的合成单根 allowlist。
  // 挂载在裸 /:id 路由之前（与 /:id/used-by 相同的路由顺序纪律）。
  router.get("/:id/files/list", (c) => {
    const service = getService(c);
    if (!service) return c.json({ error: "plugin_discovery_unavailable" }, 503);
    const id = c.req.param("id");
    const detail = service.getPlugin(id);
    if (!detail) return c.notFound();
    const relativePath = c.req.query("path") ?? "";
    try {
      const allowlist = pluginRootAllowlist(detail.entry.path);
      const resolved = resolveAllowedDirectory(allowlist, "plugin", relativePath);
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      return c.json({
        pluginId: id,
        path: relativePath,
        entries: entries
          .map((entry) => {
            const fullPath = path.join(resolved, entry.name);
            let stat: fs.Stats | null = null;
            try { stat = fs.statSync(fullPath); } catch { /* 跳过 stat 失败的项 */ }
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

  // Slice 28——GET /:id/files/read?path=<rel>
  // 读取插件源文件夹内的文件。与 /api/files/read 相同的截断上限语义
  // （FILE_READ_TRUNCATION_BYTES；对完整内容做 hash 以保证诚实的编辑冲突语义——
  // 但 v0 插件文件夹只读，因此 hash 仅供参考）。
  router.get("/:id/files/read", (c) => {
    const service = getService(c);
    if (!service) return c.json({ error: "plugin_discovery_unavailable" }, 503);
    const id = c.req.param("id");
    const detail = service.getPlugin(id);
    if (!detail) return c.notFound();
    const relativePath = c.req.query("path") ?? "";
    if (!relativePath) return c.json({ error: "path_required" }, 400);
    try {
      const allowlist = pluginRootAllowlist(detail.entry.path);
      const resolved = resolveAllowedFile(allowlist, "plugin", relativePath);
      const stat = fs.statSync(resolved);
      const fullContent = fs.readFileSync(resolved);
      const truncated = stat.size > FILE_READ_TRUNCATION_BYTES;
      const returnedContent = truncated
        ? fullContent.subarray(0, FILE_READ_TRUNCATION_BYTES)
        : fullContent;
      return c.json({
        pluginId: id,
        path: relativePath,
        absolutePath: resolved,
        content: returnedContent.toString("utf-8"),
        mtime: stat.mtime.toISOString(),
        contentHash: sha256Hex(fullContent),
        size: stat.size,
        truncated,
        truncatedAtBytes: truncated ? FILE_READ_TRUNCATION_BYTES : null,
        totalBytes: stat.size,
      });
    } catch (err) {
      if (err instanceof FilePathSafetyError) return pathSafetyErrorResponse(c, err);
      return c.json({ error: "read_failed", message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // GET /:id——插件详情
  router.get("/:id", (c) => {
    const service = getService(c);
    if (!service) return c.json({ error: "plugin_discovery_unavailable" }, 503);
    const id = c.req.param("id");
    const detail = service.getPlugin(id);
    if (!detail) return c.notFound();
    return c.json(detail);
  });

  return router;
}
