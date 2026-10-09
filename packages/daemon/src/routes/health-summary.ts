// 操作员表面对账 v0 —— 紧凑的 health-summary 路由。
//
// 端点（item 1F）：
//   GET /api/health-summary/nodes    跨工作组汇总节点 sessionStatus + 生命周期
//   GET /api/health-summary/context 跨工作组汇总 context 用量的紧迫度 + 新鲜度
//   GET /api/health-summary/version 后台服务自身的运行版本（OPR.0.4.1.14）
//
// nodes/context 路由封装既有的后台服务侧聚合辅助函数；steering 表面的紧凑门消费它们。
// version 路由无依赖地读取后台服务自己的 package.json，使仪表盘 Field Environment
// 显示真实运行的后台服务版本（绝不显示 UI bundle 版本——后者在版本不一致时会静默漂移）。

import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { RigRepository } from "../domain/rig-repository.js";
import {
  computeContextHealthSummary,
  computeNodeHealthSummary,
} from "../domain/steering/health-summary.js";
import { getDaemonVersion } from "../domain/daemon-version.js";

export interface HealthSummaryRoutesDeps {
  db: Database.Database;
  rigRepo: RigRepository;
}

export function healthSummaryRoutes(): Hono {
  const app = new Hono();

  function getDeps(c: { get: (key: string) => unknown }): HealthSummaryRoutesDeps | null {
    const rigRepo = c.get("rigRepo" as never) as RigRepository | undefined;
    if (!rigRepo) return null;
    return { db: rigRepo.db, rigRepo };
  }

  app.get("/nodes", (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "health_summary_unavailable" }, 503);
    return c.json(computeNodeHealthSummary(deps));
  });

  app.get("/context", (c) => {
    const deps = getDeps(c);
    if (!deps) return c.json({ error: "health_summary_unavailable" }, 503);
    return c.json(computeContextHealthSummary({ db: deps.db }));
  });

  // 无依赖：运行版本是对后台服务自己 package.json 的读取。
  // getDaemonVersion 在任何读取失败时返回 "unknown"，因此本路由恒为 200，
  // 由客户端渲染该值（或它自己诚实的回退）。
  app.get("/version", (c) => {
    return c.json({ version: getDaemonVersion() });
  });

  // S10 —— 后台服务内 gateway 子系统的健康状态（修订后 M1 §3 形态）。缺失的句柄会被诚实上报
  // （一个未构建该子系统的后台服务绝不能读作健康的 gateway）。
  app.get("/gateway", (c) => {
    const subsystem = c.get("gatewaySubsystem" as never) as
      | { status: () => Record<string, unknown> }
      | undefined;
    if (!subsystem) return c.json({ error: "gateway_subsystem_unavailable" }, 503);
    return c.json(subsystem.status());
  });

  return app;
}
