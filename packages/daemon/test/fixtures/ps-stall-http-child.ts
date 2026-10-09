// D2 事件循环回归使用的真实 HTTP 子进程 fixture（slice-04，
// qitem-20260721000001-ps-stall-driver).
//
// buildStallApp(db) 是共享接线：既供进程内 D1/D3 通过 app.request 使用，也供子进程 `main()`
// 通过真实 localhost listener 执行 D2。PsProjectionService 会接入 AgentActivityStore
//（createTestApp 会省略它），从而覆盖 attention fold。SeatActivityService 刻意缺失
//（复制状态的环境限制），绝不合成。
//
// 作为子进程运行：`node --import tsx ps-stall-http-child.ts`。它填充主机形状的合成 DB
//（27/198，恰好 219,541 个事件），监听临时 loopback 端口，并且只打印一行就绪标记
// `READY <port>`。
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import { RigRepository } from "../../src/domain/rig-repository.js";
import { EventBus } from "../../src/domain/event-bus.js";
import { AgentActivityStore } from "../../src/domain/agent-activity-store.js";
import { PsProjectionService } from "../../src/domain/ps-projection.js";
import { psRoutes } from "../../src/routes/ps.js";
import { rigsRoutes } from "../../src/routes/rigs.js";
import { createMigratedDb, seedHostShaped } from "../helpers/seed-host-shaped.js";

export function buildStallApp(db: Database.Database): Hono {
  const repo = new RigRepository(db);
  const eventBus = new EventBus(db);
  const agentActivity = new AgentActivityStore({ db, eventBus });
  const psService = new PsProjectionService({ db, agentActivity }); // agentActivity 必需；seatActivity 缺失。

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("psProjectionService" as never, psService as never);
    c.set("rigRepo" as never, repo as never);
    c.set("eventBus" as never, eventBus as never);
    c.set("agentActivityStore" as never, agentActivity as never);
    await next();
  });
  app.route("/api/ps", psRoutes);
  app.route("/api/rigs", rigsRoutes);
  // 简单诊断 /healthz，不代表后台服务健康语义；它只测量事件循环可用性，
  // 同步 ps/summary handler 连这个端点也会阻塞。
  app.get("/healthz", (c) => c.json({ ok: true, diagnostic_stub: true }));
  return app;
}

// ---- 子进程入口 ----
const runAsChild = Boolean(process.argv[1] && process.argv[1].includes("ps-stall-http-child"));
if (runAsChild) {
  // 子进程同时拥有 server 与 DB：每条退出路径（setup 抛错、signal 或未捕获错误）都会在退出前
  // 关闭二者，因此绝不泄漏 listener 或 sqlite handle。
  let db: Database.Database | null = null;
  let server: { close: (cb?: () => void) => void } | null = null;
  let closing = false;
  const closeAll = (code: number) => {
    if (closing) return; // 幂等：重复 signal/error 路径不会二次关闭或退出。
    closing = true;
    const done = () => { try { db?.close(); } catch { /* noop */ } process.exit(code); };
    try { if (server) server.close(done); else done(); } catch { done(); }
  };
  process.on("SIGTERM", () => closeAll(0));
  process.on("SIGINT", () => closeAll(0));
  process.on("uncaughtException", (e) => { process.stderr.write(`子进程未捕获错误：${(e as Error).message}\n`); closeAll(1); });
  try {
    db = createMigratedDb();
    seedHostShaped(db);
    const app = buildStallApp(db);
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      process.stdout.write(`READY ${info.port}\n`);
    });
  } catch (e) {
    process.stderr.write(`子进程 setup 失败：${(e as Error).message}\n`);
    closeAll(1); // setup 失败时仍关闭 DB。
  }
}
