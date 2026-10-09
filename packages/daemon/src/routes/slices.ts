import { selectedProject, projectMission, workSource, projectReadResponse } from "../domain/workspace/project-read.js";
// Slice Story View v0——HTTP 路由。
//
// 端点：
//   GET /api/slices?filter=all|active|done|blocked  — 列表（默认：all）
//   GET /api/slices/:name                            — 每标签页的完整负载
//   GET /api/slices/:name/proof-asset/:relPath{.+}   — 提供该 slice 匹配的
//                                                       dogfood-evidence 目录中的
//                                                       截图 / 视频 / 追踪
//                                                       （防路径穿越）
//
// 路由顺序纪律（按 Phase A R1 教训）：静态 `/api/slices` 必须在动态 `/:name`
// 之前注册，免得裸列表端点被遮蔽。proof-asset 路由同理在 :name 之前，
// 避免 `/proof-asset` 被解析成 slice 名。

import { Hono } from "hono";
import { readSliceReadiness, readProjectReadiness } from "../domain/proof/judgments.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { SliceIndexer, SliceListEntry, SliceStatus } from "../domain/slices/slice-indexer.js";
import { SliceDetailProjector } from "../domain/slices/slice-detail-projector.js";
import { findSliceWorkflowBinding } from "../domain/workflow/slice-workflow-binding.js";

export interface SlicesRoutesDeps {
  indexer: SliceIndexer;
  projector: SliceDetailProjector;
}

const VALID_FILTERS = new Set<SliceStatus | "all">(["all", "active", "done", "blocked"]);

export function slicesRoutes(): Hono {
  const app = new Hono();

  // 1) 静态字面量 `/` 在动态 `/:name` 之前，免得列表被一个叫 "list" 之类的 slice 遮蔽。
  app.get("/", (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "slices_indexer_unavailable" }, 503);
    if (!deps.indexer.isReady()) {
      return c.json({
        error: "slices_root_not_configured",
        hint: "运行 zrig config init-workspace，或把 workspace.slices_root 设为 workspace/missions。支持的形状：missions/<mission>/slices/<slice>。",
      }, 503);
    }
    const filter = (c.req.query("filter") ?? "all").toLowerCase();
    if (!VALID_FILTERS.has(filter as SliceStatus | "all")) {
      return c.json({
        error: "filter_invalid",
        hint: `未知 filter '${filter}'。允许值：${[...VALID_FILTERS].sort().join(", ")}。`,
      }, 400);
    }
    const refresh = c.req.query("refresh");
    if (refresh === "1" || refresh === "true") {
      deps.indexer.invalidate();
    }
    // qitem-ccf87c0d 修正——一次 HTTP 请求是一个复合操作：列表重建、按 slice 的
    // boundToWorkflow get 循环、以及 mission sidecar 共享同一个 membership 批次
    // （改前，每个未缓存的 get 自建 2 扫描批次：总共 2+2N 次队列扫描）。
    return deps.indexer.withMembershipBatch(() => {
      const all = deps.indexer.list();
      let filtered = filter === "all" ? all : all.filter((s) => s.status === filter);
      // Spec Library v0 中的 Workflow：可选 lens 过滤——收窄到绑定了
      // <name>:<version> 的 workflow_instance 的 slice。
      const boundToWorkflow = c.req.query("boundToWorkflow");
      let boundDiagnostic: { specName: string; specVersion: string; matched: number; total: number } | null = null;
      if (boundToWorkflow) {
        const colonIdx = boundToWorkflow.lastIndexOf(":");
        if (colonIdx === -1) {
          return c.json({
            error: "boundToWorkflow_invalid",
            hint: "格式为 boundToWorkflow=<specName>:<specVersion>",
          }, 400);
        }
        const specName = boundToWorkflow.slice(0, colonIdx);
        const specVersion = boundToWorkflow.slice(colonIdx + 1);
        const db = deps.indexer.db;
        const before = filtered.length;
        filtered = filtered.filter((slice) => {
          // 按 slice 重新解析 binding。indexer 的列表负载不带 workflowName，
          // 所以在这里做 join。v0 开销受 slice 数 + 每 slice 一条小 SQL 约束
          // （membership 批次在整个请求间共享）。
          const sliceRecord = deps.indexer.get(slice.name);
          if (!sliceRecord || sliceRecord.qitemIds.length === 0) return false;
          const binding = findSliceWorkflowBinding(db, sliceRecord.qitemIds);
          return binding.primary?.workflowName === specName
            && binding.primary?.workflowVersion === specVersion;
        });
        boundDiagnostic = { specName, specVersion, matched: filtered.length, total: before };
      }
      // 按 lastActivityAt 降序排序（最近动过的在前）；无活动的 slice 排到末尾。
      filtered.sort(compareByActivityDesc);
      const authored = deps.indexer.missionAuthoredStatuses();
      return c.json({
        slices: filtered.map(s => ({ ...s, readiness: readSliceReadiness(s.slicePath) })),
        totalCount: filtered.length,
        filter,
        boundToWorkflow: boundDiagnostic,
        // VM-005 (release-0.4.7)：叠加 authored mission-status sidecar，使 chip 表面
        // 无需第二次往返就能遵守 authored-wins 优先。`slices` 数组本身字节不动。
        missions: { ...authored, ...Object.fromEntries(readProjectReadiness(deps.indexer.slicesRoot).missions.map(m => [m.name, {
          ...authored[m.name],
          authoredStatus: m.historicalStatus ?? authored[m.name]?.authoredStatus ?? null,
          readiness: m,
        }])) },
      });
    });
  });

  // V0.3.1 slice 17 founder-walk-workspace-state-correctness（walk item 8——Explorer 自动展示）：
  // 显式缓存失效表面。POST /api/slices/refresh 清空两个 indexer 缓存，
  // 使新建的 slice / mission 目录无需重启后台服务即可被拾取。
  // 注册在动态 /:name 路由之前，免得被遮蔽。
  app.post("/refresh", (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "slices_indexer_unavailable" }, 503);
    deps.indexer.invalidate();
    return c.json({ ok: true });
  });

  // 2) proof 资产服务——注册在 /:name 之前，免得 /:name 吞掉 /proof-asset 路径。
  //    Hono 的 :wildcard 只匹配单段；我们手动解析路径其余部分，
  //    以支持 "screenshots/foo.png" 或 "headed-browser/screenshots/bar.png" 这类
  //    嵌套相对路径。
  app.get("/:name/proof-asset/*", (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "slices_indexer_unavailable" }, 503);
    const name = c.req.param("name");
    const slice = deps.indexer.get(name);
    if (!slice || !slice.proofPacket) {
      return c.json({ error: "proof_packet_not_found" }, 404);
    }
    // Hono 路径：c.req.path = "/api/slices/<name>/proof-asset/<rest>"。
    // 取 "/proof-asset/" 之后的全部内容。
    const fullPath = c.req.path;
    const marker = `/proof-asset/`;
    const idx = fullPath.indexOf(marker);
    if (idx === -1) return c.json({ error: "proof_asset_path_invalid" }, 400);
    const relPath = decodeURIComponent(fullPath.slice(idx + marker.length));
    if (!relPath || relPath.includes("..")) {
      return c.json({ error: "proof_asset_path_invalid" }, 400);
    }
    const abs = deps.projector.resolveProofAssetPath(slice.proofPacket, relPath);
    if (!abs) return c.json({ error: "proof_asset_not_found" }, 404);

    const contentType = inferContentType(abs);
    return fileAssetResponse(abs, contentType, c.req.header("Range"));
  });

  // 3) Docs 标签页的文档服务——slice 文件夹内单个文件的 markdown 内容。
  //    由 projector 防路径穿越。
  app.get("/:name/doc/*", (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "slices_indexer_unavailable" }, 503);
    const name = c.req.param("name");
    const fullPath = c.req.path;
    const marker = `/doc/`;
    const idx = fullPath.indexOf(marker);
    if (idx === -1) return c.json({ error: "doc_path_invalid" }, 400);
    const relPath = decodeURIComponent(fullPath.slice(idx + marker.length));
    if (!relPath || relPath.includes("..")) {
      return c.json({ error: "doc_path_invalid" }, 400);
    }
    const content = deps.projector.readDoc(name, relPath);
    if (content === null) return c.json({ error: "doc_not_found" }, 404);
    return c.json({ relPath, content });
  });

  // 4) 动态 `/:name` 最后，免得上面的字面量路由被遮蔽。
  app.get("/:name", (c) => {
    let deps = getDeps(c);
    if (!deps) return c.json({ error: "slices_indexer_unavailable" }, 503);
    const name = c.req.param("name");
    try {
      const project = selectedProject(c);
      if (project) {
        const mission = c.req.query("mission");
        if (!mission || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) return c.json({ error: "exact_mission_and_slice_required" }, 400);
        const dir = projectMission(project, mission);
        workSource(project.root, path.join(dir, "slices", name));
        const indexer = new SliceIndexer({ db: deps.indexer.db, slicesRoot: project.missionsRoot, dogfoodEvidenceRoot: null, projectId: project.id, missionId: mission });
        deps = { indexer, projector: deps.projector.withIndexer(indexer) };
      }
    } catch (err) { return projectReadResponse(err); }
    const slice = deps.indexer.get(name);
    if (!slice) return c.json({ error: "slice_not_found", name }, 404);
    const payload = deps.projector.project(slice);
    return c.json(payload);
  });

  return app;
}

function getDeps(c: { get: (key: string) => unknown }): SlicesRoutesDeps | null {
  const indexer = c.get("sliceIndexer" as never) as SliceIndexer | undefined;
  const projector = c.get("sliceDetailProjector" as never) as SliceDetailProjector | undefined;
  if (!indexer || !projector) return null;
  return { indexer, projector };
}

function compareByActivityDesc(a: SliceListEntry, b: SliceListEntry): number {
  if (a.lastActivityAt === b.lastActivityAt) return a.name.localeCompare(b.name);
  if (!a.lastActivityAt) return 1;
  if (!b.lastActivityAt) return -1;
  return b.lastActivityAt.localeCompare(a.lastActivityAt);
}

function inferContentType(absPath: string): string {
  const ext = path.extname(absPath).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".mp4": return "video/mp4";
    case ".webm": return "video/webm";
    case ".mov": return "video/quicktime";
    case ".zip": return "application/zip";
    case ".md":
    case ".txt": return "text/plain; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function fileAssetResponse(absPath: string, contentType: string, rangeHeader?: string): Response {
  const size = fs.statSync(absPath).size;
  const cacheControl = "public, max-age=86400";

  if (rangeHeader) {
    const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
    const start = m && m[1] !== "" ? Number(m[1]) : m && m[2] !== "" ? size - Number(m[2]) : NaN;
    const end = m && m[1] !== "" && m[2] !== "" ? Number(m[2]) : size - 1;
    if (!m || Number.isNaN(start) || start < 0 || start >= size || end < start) {
      return new Response(null, {
        status: 416,
        headers: {
          "Content-Range": `bytes */${size}`,
          "Accept-Ranges": "bytes",
        },
      });
    }

    const boundedEnd = Math.min(end, size - 1);
    const length = boundedEnd - start + 1;
    const fd = fs.openSync(absPath, "r");
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
          "Cache-Control": cacheControl,
        },
      });
    } finally {
      fs.closeSync(fd);
    }
  }

  const data = fs.readFileSync(absPath);
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
      "Cache-Control": cacheControl,
    },
  });
}
