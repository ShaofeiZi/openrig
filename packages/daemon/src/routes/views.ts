import { selectedProject, projectMission, projectReadResponse } from "../domain/workspace/project-read.js";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
import type { ViewProjector } from "../domain/view-projector.js";
import { ViewProjectorError } from "../domain/view-projector.js";

/**
 * 协调 L5——View HTTP 路由（PL-004 Phase B）。
 *
 * 支撑 `zrig view` CLI 动词。列出已注册 view（内置 + 自定义）、运行 view 查询，
 * 并向下游消费方（PL-005 Operator Status / PL-006 Mission Control / PL-008 progress）
 * 暴露 view.changed SSE。
 *
 * 按 Phase A R1 SSE 路由顺序教训（slice IMPL § Audit Row 12）：
 * SSE/静态路由挂载在裸参 /:name 通配之前。
 */
export function viewsRoutes(): Hono {
  const app = new Hono();

  function getProjector(c: { get: (key: string) => unknown }): ViewProjector {
    return c.get("viewProjector" as never) as ViewProjector;
  }
  function getEventBus(c: { get: (key: string) => unknown }): EventBus {
    return c.get("eventBus" as never) as EventBus;
  }

  function errorResponse(c: { json: (body: unknown, status?: number) => Response }, err: unknown): Response {
    if (err instanceof ViewProjectorError) {
      const status = err.code === "view_not_found" ? 404
        : err.code === "view_name_reserved" ? 409
        : err.code === "view_query_failed" ? 400
        : 500;
      return c.json({ error: err.code, message: err.message }, status as 200);
    }
    const message = err instanceof Error ? err.message : "内部错误";
    return c.json({ error: "internal_error", message }, 500);
  }

  // POST /custom/register——注册/更新自定义 view。
  app.post("/custom/register", async (c) => {
    const body = await c.req.json<{
      viewName?: string;
      definition?: string;
      registeredBySession?: string;
    }>().catch(() => ({} as never));
    if (!body.viewName) return c.json({ error: "viewName 为必填项" }, 400);
    if (!body.definition) return c.json({ error: "definition 为必填项" }, 400);
    if (!body.registeredBySession) return c.json({ error: "registeredBySession 为必填项" }, 400);
    try {
      const view = getProjector(c).registerCustomView({
        viewName: body.viewName,
        definition: body.definition,
        registeredBySession: body.registeredBySession,
      });
      return c.json(view, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // GET /list——内置 + 自定义 view 名。
  // 必须在 /:viewName 之前，使字面量路径优先。
  app.get("/list", (c) => {
    return c.json(getProjector(c).list());
  });

  // ---- view.changed 事件的 SSE ----
  // 发出所有 view.changed 事件的通用 SSE。按 Phase A R1 教训：
  // 挂载在 /:viewName 通配之前。
  const sseHandler = (c: Parameters<typeof streamSSE>[0]) => {
    const eventBus = getEventBus(c);
    return streamSSE(c, async (stream) => {
      const unsubscribe = eventBus.subscribe((event) => {
        if (event.type !== "view.changed") return;
        const sse = { id: String(event.seq), data: JSON.stringify(event) };
        stream.writeSSE(sse).catch(() => {});
      });
      try {
        await new Promise<void>((resolve) => stream.onAbort(() => resolve()));
      } finally {
        unsubscribe();
      }
    });
  };
  app.get("/sse", sseHandler);
  app.get("/watch", sseHandler);

  // GET /:viewName/sse——按 viewName 过滤的 view 专属 SSE。
  // /:viewName/sse 路径比 /:viewName 更具体，因此即使通配稍后注册，
  // Hono 也能正确派发。
  app.get("/:viewName/sse", (c) => {
    const viewName = c.req.param("viewName");
    const eventBus = getEventBus(c);
    return streamSSE(c, async (stream) => {
      const unsubscribe = eventBus.subscribe((event) => {
        if (event.type !== "view.changed") return;
        if (event.viewName !== viewName) return;
        const sse = { id: String(event.seq), data: JSON.stringify(event) };
        stream.writeSSE(sse).catch(() => {});
      });
      try {
        await new Promise<void>((resolve) => stream.onAbort(() => resolve()));
      } finally {
        unsubscribe();
      }
    });
  });

  // GET /:viewName——运行一个 view（内置或自定义）。
  // 放最后，使 /list、/sse、/watch、/:viewName/sse 都优先。
  app.get("/:viewName", (c) => {
    const viewName = c.req.param("viewName");
    const rig = c.req.query("rig") || undefined;
    const limit = c.req.query("limit") ? Number.parseInt(c.req.query("limit")!, 10) : undefined;
    // S27——execution view 按 mission 确定范围（模块内派生 release 范围默认；
    // --mission 放宽/收窄）。
    const mission = c.req.query("mission") || undefined;
    try {
      let project;
      try {
        project = viewName === "execution" ? selectedProject(c) : null;
        if (project && mission) projectMission(project, mission);
      } catch (err) { return projectReadResponse(err); }
      const result = getProjector(c).show(viewName, { rig, limit, mission, project });
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  return app;
}
