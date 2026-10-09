import { Hono } from "hono";
import type Database from "better-sqlite3";
import { readFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ActiveLensStore } from "../domain/active-lens-store.js";
import type { SpecLibraryService } from "../domain/spec-library-service.js";
import { SpecReviewService, SpecReviewError } from "../domain/spec-review-service.js";
import {
  getWorkflowReview,
  parseWorkflowLibraryId,
  scanWorkflowSpecs,
  scanWorkflowSpecFolder,
} from "../domain/spec-library-workflow-scanner.js";
import type { WorkflowSpecCache } from "../domain/workflow-spec-cache.js";
import type { EventBus } from "../domain/event-bus.js";

export function specLibraryRoutes(): Hono {
  const router = new Hono();

  function refreshWorkflowEntries(c: { get: (k: string) => unknown }): SpecLibraryService {
    const lib = c.get("specLibraryService" as never) as SpecLibraryService;
    const db = c.get("rigRepoDb" as never) as Database.Database | undefined
      ?? (c.get("rigRepo" as never) as { db: Database.Database } | undefined)?.db;
    const builtinDir = c.get("workflowBuiltinSpecsDir" as never) as string | undefined;
    if (db) {
      // Slice 11（workflow-spec-folder-discovery）——机会式地遍历操作员工作区的
      // workflows 目录（若已接线），使新放入的 YAML 文件在下面读缓存之前
      // 物化为缓存行（有效或诊断性）。目录扫描受上下文接线门控；
      // slice-11 之前的调用方仍获得纯缓存行为。
      const cache = c.get("workflowSpecCache" as never) as WorkflowSpecCache | undefined;
      const folder = c.get("workflowsFolderDir" as never) as string | undefined;
      const eventBus = c.get("eventBus" as never) as EventBus | undefined;
      if (cache && folder) {
        try {
          scanWorkflowSpecFolder({ db, cache, folder, builtinDir: builtinDir ?? null, eventBus });
        } catch { /* 尽力而为——目录扫描失败绝不能破坏 Library 列表 */ }
      }
      // 每次列表请求都重新扫描 workflow spec——很便宜（对 workflow_specs 缓存一次
      // SELECT），且意味着 lens 驱动的表面总能看到最新缓存状态，无需单独的 POST /sync。
      const workflowEntries = scanWorkflowSpecs({ db, workflowBuiltinSpecsDir: builtinDir ?? null });
      lib.setWorkflowEntries(workflowEntries);
    }
    return lib;
  }

  // GET /active-lens——读当前激活的 workflow lens（若有）。
  // 挂载在 /:id 之前，免得字面量路径被裸参通配吞掉
  // （Phase A R1 SSE 路由顺序教训）。
  router.get("/active-lens", (c) => {
    const store = c.get("activeLensStore" as never) as ActiveLensStore | undefined;
    if (!store) return c.json({ activeLens: null });
    return c.json({ activeLens: store.get() });
  });

  // POST /active-lens——设置 / 替换当前激活的 workflow lens。
  router.post("/active-lens", async (c) => {
    const store = c.get("activeLensStore" as never) as ActiveLensStore | undefined;
    if (!store) return c.json({ error: "active_lens_unavailable" }, 503);
    const body = await c.req.json<{ specName?: string; specVersion?: string }>().catch(() => ({} as { specName?: string; specVersion?: string }));
    if (!body.specName || !body.specVersion) {
      return c.json({ error: "specName 和 specVersion 均为必填项" }, 400);
    }
    const lens = store.set(body.specName, body.specVersion);
    return c.json({ activeLens: lens });
  });

  // DELETE /active-lens——清除当前激活的 workflow lens。
  router.delete("/active-lens", (c) => {
    const store = c.get("activeLensStore" as never) as ActiveLensStore | undefined;
    if (!store) return c.json({ error: "active_lens_unavailable" }, 503);
    store.clear();
    return c.json({ activeLens: null });
  });

  // GET / ——列出库条目
  router.get("/", (c) => {
    const lib = refreshWorkflowEntries(c);
    const kind = c.req.query("kind") as "rig" | "agent" | "workflow" | undefined;
    const entries = lib.list(kind ? { kind } : undefined);
    return c.json(entries.map((entry) => {
      // 保留 authored/目录路径，同时标明其真实来源。
      // 消费方仍通过既有 file-root 边界读取。
      let resolvedSourcePath: string | null = null;
      try { resolvedSourcePath = realpathSync(entry.sourcePath); } catch { /* 缺失/被拒的来源保持显式 */ }
      return { ...entry, resolvedSourcePath };
    }));
  });

  // GET /:id——条目元数据 + YAML 内容
  router.get("/:id", (c) => {
    const lib = refreshWorkflowEntries(c);
    const id = c.req.param("id");

    // 守卫：不要匹配 /review、/sync、/active-lens 这类子路径
    if (id === "sync" || id === "review" || id === "active-lens") return c.notFound();

    const result = lib.get(id);
    if (!result) {
      return c.json({ error: `库中未找到 spec '${id}'` }, 404);
    }
    return c.json(result);
  });

  // GET /:id/review——带库出处的结构化 review
  router.get("/:id/review", (c) => {
    const lib = refreshWorkflowEntries(c);
    const svc = c.get("specReviewService" as never) as SpecReviewService;
    const id = c.req.param("id");

    const result = lib.get(id);
    if (!result) {
      return c.json({ error: `库中未找到 spec '${id}'` }, 404);
    }

    // Spec Library v0 中的 Workflow：workflow review 是独立的负载形状——
    // 拓扑图 + 逐步骤列表 + 来源路径——从 workflow_specs SQLite 缓存投影而来。
    if (result.entry.kind === "workflow") {
      const parsed = parseWorkflowLibraryId(id);
      if (!parsed) return c.json({ error: `无法解析 workflow 库 id '${id}'` }, 400);
      const db = (c.get("rigRepo" as never) as { db: Database.Database } | undefined)?.db;
      const builtinDir = c.get("workflowBuiltinSpecsDir" as never) as string | undefined;
      if (!db) return c.json({ error: "workflow_specs_db_unavailable" }, 503);
      const review = getWorkflowReview({
        db,
        workflowBuiltinSpecsDir: builtinDir ?? null,
        name: parsed.name,
        version: parsed.version,
      });
      if (!review) {
        return c.json({ error: `workflow_specs 缓存中没有 workflow spec '${parsed.name}' v${parsed.version}` }, 404);
      }
      return c.json({ ...review, libraryEntryId: id });
    }

    try {
      let review: Record<string, unknown>;
      if (result.entry.kind === "rig") {
        review = svc.reviewRigSpec(result.yaml, "library_item") as unknown as Record<string, unknown>;
      } else {
        review = svc.reviewAgentSpec(result.yaml, "library_item") as unknown as Record<string, unknown>;
      }

      // 尽力为 service 支撑的 rig 补充 composePreview
      const services = review["services"] as Record<string, unknown> | undefined;
      if (services && services["composeFile"]) {
        try {
          const composeFilePath = join(dirname(result.entry.sourcePath), services["composeFile"] as string);
          const composeYaml = readFileSync(composeFilePath, "utf-8");
          const composeDoc = parseYaml(composeYaml) as Record<string, unknown>;
          const composeServices = composeDoc["services"] as Record<string, Record<string, unknown>> | undefined;
          if (composeServices && typeof composeServices === "object") {
            const preview = Object.entries(composeServices).map(([name, svc]) => ({
              name,
              image: (svc["image"] as string) ?? undefined,
            }));
            services["composePreview"] = { services: preview };
          }
        } catch { /* 尽力而为：compose 文件缺失 = 无预览 */ }
      }

      // 补充库出处
      return c.json({
        ...review,
        libraryEntryId: id,
        sourcePath: result.entry.sourcePath,
      });
    } catch (err) {
      if (err instanceof SpecReviewError) {
        return c.json({ errors: err.errors }, 400);
      }
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // POST /sync——重新扫描各根
  router.post("/sync", (c) => {
    const lib = c.get("specLibraryService" as never) as SpecLibraryService;
    lib.scan();
    return c.json(lib.list());
  });

  // DELETE /:id——删除一个用户文件库条目
  router.delete("/:id", (c) => {
    const lib = c.get("specLibraryService" as never) as SpecLibraryService;
    const result = lib.remove(c.req.param("id"));
    if (!result.ok) {
      const status = result.code === "not_found" ? 404
        : result.code === "read_only" ? 409
        : result.code === "conflict" ? 409
        : 400;
      return c.json(result, status);
    }
    return c.json({ ok: true, id: result.entry.id, name: result.entry.name });
  });

  // POST /:id/rename——重命名一个用户文件库条目
  router.post("/:id/rename", async (c) => {
    const lib = c.get("specLibraryService" as never) as SpecLibraryService;
    const body = await c.req.json().catch(() => ({}));
    const name = body["name"];
    if (typeof name !== "string" || name.trim().length === 0) {
      return c.json({ ok: false, code: "invalid_spec", error: "name 为必填项" }, 400);
    }

    const result = lib.rename(c.req.param("id"), name);
    if (!result.ok) {
      const status = result.code === "not_found" ? 404
        : result.code === "read_only" ? 409
        : result.code === "conflict" ? 409
        : 400;
      return c.json(result, status);
    }
    return c.json({ ok: true, entry: result.entry });
  });

  return router;
}
