// 操作员表面对账 v0 —— steering 编排路由。
//
// 端点：
//   GET /api/steering —— /steering UI 表面的编排载荷。
//
// 按 PRD § Item 1，在单个载荷中返回优先级栈 + roadmap 轨道 + lane 轨道。
// UI 从既有 PL-005 端点取 in-motion + loop-state，从 /api/health-summary 取健康门
// （保持分离，使 steering 编排器保持窄且可测）。

import { Hono } from "hono";
import type { SteeringComposer } from "../domain/steering/steering-composer.js";

export interface SteeringRoutesDeps {
  composer: SteeringComposer;
}

export function steeringRoutes(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const composer = c.get("steeringComposer" as never) as SteeringComposer | undefined;
    if (!composer) return c.json({ error: "steering_composer_unavailable" }, 503);
    if (!composer.isReady()) {
      return c.json({
        error: "steering_workspace_not_configured",
        hint: "运行 zrig config init-workspace，或为非标准布局设置 workspace.steering_path / OPENRIG_STEERING_PATH，然后重启后台服务。",
      }, 503);
    }
    return c.json(composer.compose());
  });

  return app;
}
