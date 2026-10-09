import { Hono } from "hono";
import type { WakeResolveService } from "../domain/wake-resolve-service.js";

export const wakeResolveRoutes = new Hono();

// L3b —— 为 `zrig ask --wake <seat>` 把一个 seat[@generation] 解析成 resume token
// （或拒绝并给出指引性列表）。只读；此处不做执行（CLI 用返回的 token 运行 wake）。
wakeResolveRoutes.post("/", async (c) => {
  const svc = c.get("wakeResolveService" as never) as WakeResolveService;
  const body = await c.req.json<{ seat?: string; generation?: number }>().catch(() => ({}) as { seat?: string; generation?: number });

  if (!body.seat) {
    return c.json({ error: "缺少必填字段：seat" }, 400);
  }

  return c.json(svc.resolve(body.seat, body.generation));
});
