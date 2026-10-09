// OPR.0.4.6.02 C3——terminal-provider-ride 后台服务路由。
//
// 面向每种 view 类型的唯一、规范、非 rig 范围的 composer（arch R1 / guard
// b1）：`POST /api/terminal/open {provider, view}` + `GET /api/terminal/views` +
// `GET /api/terminal/status`。rig 范围的 `POST /api/rigs/:rigId/terminal/open`
// 是一个薄别名，它拼出 `view = rig:<rigId>` 并委托给同一个 `TerminalService`——
// 自身零组合逻辑。CLI 与 web-UI 启动器都打这个规范接缝。
//
// 响应体始终是同一个共享 `OpenViewResult { opened, absent, degraded }` 形状
// （arch Q3）——在此处与 CLI JSON 中字节一致。HTTP 状态只映射解析结果：
// 坏输入 → 400，未知 view → 404；provider 不可用或诚实部分结果是一个 200，
// 其 BODY 说出真相（ok / opened / degraded），绝不是错误状态码。
//
// 无新 auth/trust 表面（PRD「no new auth surface v1」）：这些路由镜像已交付
// cmux 启动路由的姿态（它不按 terminal bearer token 门控）——组合一个 view 只读
// inventory 并返回 provider 在客户端运行的 attach 命令；它不改变任何后台服务状态。

import { Hono } from "hono";
import type { TerminalService } from "../domain/terminal/terminal-service.js";

function getService(c: { get(key: string): unknown }): TerminalService | null {
  return (c.get("terminalService" as never) as TerminalService | undefined) ?? null;
}

/** 把服务 OpenViewResult code 映射到 HTTP 状态（body 始终是完整结果）。 */
function statusForOpen(ok: boolean, code: string | undefined): 200 | 400 | 404 | 409 {
  if (ok) return 200;
  if (code === "view_required" || code === "unknown_provider") return 400;
  if (code === "view_not_found") return 404;
  if (code === "preview_changed") return 409;
  // provider 不可用 / layout 不支持 / 诚实部分结果：一个诚实的 200 body。
  return 200;
}

/** 诚实地解析 `{ provider?, view }` open body（非对象 / 缺 view → 上游结构化 400）。 */
function readOpenBody(raw: unknown): { provider?: string; view?: string; expectedPlan?: string } {
  if (raw === null || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  const provider = typeof obj["provider"] === "string" ? (obj["provider"] as string) : undefined;
  const view = typeof obj["view"] === "string" ? (obj["view"] as string) : undefined;
  const expectedPlan = typeof obj["expectedPlan"] === "string" ? obj["expectedPlan"] : undefined;
  return { ...(provider !== undefined ? { provider } : {}), ...(view !== undefined ? { view } : {}), ...(expectedPlan !== undefined ? { expectedPlan } : {}) };
}

/** 规范的、非 rig 范围的 terminal 路由族。挂载在 `/api/terminal`。 */
export function terminalRoutes(): Hono {
  const app = new Hono();

  app.post("/open", async (c) => {
    const svc = getService(c);
    if (!svc) return c.json({ error: "terminal_service_unavailable" }, 503);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "body_invalid", hint: "期望一个 JSON 对象 { provider?, view }" }, 400);
    }
    const { provider, view, expectedPlan } = readOpenBody(raw);
    const result = await svc.openView({ ...(provider !== undefined ? { provider } : {}), view: view ?? "", ...(expectedPlan !== undefined ? { expectedPlan } : {}) });
    return c.json(result, statusForOpen(result.ok, result.code));
  });

  app.get("/views", async (c) => {
    const svc = getService(c);
    if (!svc) return c.json({ error: "terminal_service_unavailable" }, 503);
    return c.json(await svc.listViews(c.req.query("detail") === "1"));
  });

  app.get("/preview", async (c) => {
    const svc = getService(c);
    if (!svc) return c.json({ error: "terminal_service_unavailable" }, 503);
    const result = await svc.previewView({ view: c.req.query("view") ?? "", provider: c.req.query("provider") });
    return c.json(result, "planId" in result ? 200 : statusForOpen(result.ok, result.code));
  });

  app.get("/status", async (c) => {
    const svc = getService(c);
    if (!svc) return c.json({ error: "terminal_service_unavailable" }, 503);
    const provider = c.req.query("provider");
    return c.json(await svc.status(provider));
  });

  return app;
}

/**
 * rig 范围的薄别名。挂载在 `/api/rigs/:rigId/terminal`，因此 `POST
 * /api/rigs/:rigId/terminal/open` 拼出 `view = rig:<rigId>` 并委托给同一个规范的
 * `TerminalService.openView`——此处无组合逻辑（arch R1 / guard b1）。body 里仍可带 `provider`。
 */
export const rigTerminalRoutes = new Hono();

rigTerminalRoutes.post("/open", async (c) => {
  const svc = getService(c);
  if (!svc) return c.json({ error: "terminal_service_unavailable" }, 503);
  const rigId = c.req.param("rigId");
  if (!rigId) return c.json({ error: "rig_id_required" }, 400);
  let provider: string | undefined;
  try {
    const raw = (await c.req.json()) as unknown;
    if (raw && typeof raw === "object" && typeof (raw as Record<string, unknown>)["provider"] === "string") {
      provider = (raw as Record<string, unknown>)["provider"] as string;
    }
  } catch {
    // 对别名来说空/缺失的 body 是可以的——view 就是该工作组本身。
  }
  const result = await svc.openView({ ...(provider !== undefined ? { provider } : {}), view: `rig:${rigId}` });
  return c.json(result, statusForOpen(result.ok, result.code));
});
