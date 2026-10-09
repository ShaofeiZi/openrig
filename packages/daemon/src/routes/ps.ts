import { Hono } from "hono";
import type { PsProjectionService } from "../domain/ps-projection.js";
import { projectionLane } from "../domain/projection-lane.js";

export const psRoutes = new Hono();

psRoutes.get("/", (c) => {
  const psService = c.get("psProjectionService" as never) as PsProjectionService;
  // OPR.0.3.3.19 —— 默认排除已归档；?includeArchived=true / ?archived=only 可显式纳入。
  const includeArchived = c.req.query("includeArchived") === "true";
  const archivedOnly = c.req.query("archived") === "only";
  // slice-04：整个投影 + JSON 序列化作为一个协作 lane 作业运行（与 /api/rigs/summary 共享），
  // 使并发突发在作业之间让出事件循环，/healthz 保持响应。这里只做查询标志解析。
  return projectionLane.run(() => c.json(psService.getEntries({ includeArchived, archivedOnly })));
});
