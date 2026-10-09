import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { ClaudeCompactionEnforcer } from "../domain/claude-compaction-enforcer.js";
import type { ContextUsageStore } from "../domain/context-usage-store.js";
import type { SessionTransport } from "../domain/session-transport.js";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";

/**
 * OPR.0.4.3.14 —— 手动可配置的压缩触发路由。
 *
 * POST /api/compaction/trigger { session } 按需为一个 Claude 席位驱动与自动策略相同的
 * 引导式压缩生命周期。镜像 /api/transport/send 的鉴权 + resolveSessions 歧义/404/409 模式。
 *
 * 本路由把目标解析到 node + runtime，并在触发前读取已存在的 context-usage 投影——绝不臆造用量值。
 * 拒绝理由（非 Claude / 无用量）由 enforcer 拥有，使引导序列契约只有一个事实来源。
 */
export function compactionRoutes(opts?: { bearerToken?: string | null }): Hono {
  const router = new Hono();
  router.use("*", authBearerTokenMiddleware({ expectedToken: opts?.bearerToken ?? null }));

  router.post("/trigger", async (c) => {
    const enforcer = c.get("compactionEnforcer" as never) as ClaudeCompactionEnforcer | undefined;
    const transport = c.get("sessionTransport" as never) as SessionTransport | undefined;
    const usageStore = c.get("contextUsageStore" as never) as ContextUsageStore | undefined;
    const db = c.get("db" as never) as Database.Database | undefined;

    if (!enforcer || !transport || !usageStore || !db) {
      return c.json({
        ok: false,
        reason: "compaction_unavailable",
        error: "手动压缩在此后台服务上不可用（enforcer/transport/context-usage 未接线）。",
      }, 503);
    }

    const body = await c.req.json<{ session?: string }>().catch(() => ({} as { session?: string }));
    if (!body.session) {
      return c.json({ ok: false, error: "缺少必填字段：session" }, 400);
    }
    const sessionName = body.session;

    // 歧义/存在性检查——镜像 /send（409 歧义、404 未找到）。
    const resolved = await transport.resolveSessions({ session: sessionName });
    if (!resolved.ok) {
      const status = resolved.code === "ambiguous" ? 409 : 404;
      return c.json({ ok: false, error: resolved.error }, status);
    }

    // 为最新一条会话行解析 DB node id + runtime。
    const row = db.prepare(`
      SELECT n.id AS node_id, n.runtime AS runtime
      FROM sessions s
      JOIN nodes n ON s.node_id = n.id
      WHERE s.session_name = ?
      ORDER BY s.id DESC
      LIMIT 1
    `).get(sessionName) as { node_id: string; runtime: string | null } | undefined;
    if (!row) {
      return c.json({
        ok: false,
        reason: "session_missing",
        error: `未找到会话 '${sessionName}'。用 zrig ps --nodes 查看会话名`,
      }, 404);
    }

    // 在触发前读取已知的 context-usage 投影。当用量缺失/过期/未知时传 null（绝不臆造值）；
    // 对 Claude 席位，enforcer 会诚实地返回 `no_usage_data` 理由。
    const usage = usageStore.getForNode(row.node_id, sessionName);
    const outcome = await enforcer.triggerManualCompact(
      {
        sessionName,
        runtime: row.runtime,
        usedPercentage: usage.availability === "known" ? usage.usedPercentage : null,
        transcriptPath: usage.transcriptPath,
        sessionId: usage.sessionId,
      },
      // 这是操作员的手动触发动作（bearer 鉴权）；在自动压缩禁用期间，产出序列免于 drain。
      // GHOST-STAGE 修复 (a) actor 门：未设置此项的自动化路径不豁免，因此它们无法把一次 drain
      // 洗过门。
      { operatorInitiated: true },
    );

    if (outcome.triggered) {
      return c.json({ ok: true, session: sessionName, stage: outcome.stage });
    }

    const statusMap: Record<string, number> = {
      runtime_filter: 422,
      no_usage_data: 409,
      mid_work: 409,
      target_needs_input: 409,
      target_activity_unknown: 409,
      wait_for_idle_timeout: 409,
      transport_unavailable: 409,
      invalid_wait_for_idle: 400,
      session_missing: 404,
      tmux_unavailable: 503,
      send_failed: 502,
      submit_failed: 502,
    };
    const status = (statusMap[outcome.reason] ?? 409) as 400 | 404 | 409 | 422 | 502 | 503;
    return c.json({
      ok: false,
      session: sessionName,
      stage: outcome.stage,
      reason: outcome.reason,
      error: manualReasonMessage(sessionName, outcome.reason),
    }, status);
  });

  router.get("/state", (c) => {
    const enforcer = c.get("compactionEnforcer" as never) as ClaudeCompactionEnforcer | undefined;
    if (!enforcer) {
      return c.json({ ok: false, reason: "compaction_unavailable" }, 503);
    }
    const session = c.req.query("session");
    if (!session) {
      return c.json({ ok: false, error: "缺少必填查询参数：session" }, 400);
    }
    return c.json({ ok: true, session, state: enforcer.getManualCompactionState(session) });
  });

  return router;
}

function manualReasonMessage(sessionName: string, reason: string): string {
  switch (reason) {
    case "runtime_filter":
      return `已拒绝：'${sessionName}' 不是 Claude（claude-code）席位。手动压缩只运行 Claude 引导式生命周期。`;
    case "no_usage_data":
      return `已拒绝：暂无 '${sessionName}' 的已知 context-usage 采样，不盲目触发。等遥测刷新后重试。`;
    case "mid_work":
      return `已拒绝：'${sessionName}' 似乎正在任务中途，无法发送压缩前准备。等它稳定后重试。`;
    case "target_needs_input":
      return `已拒绝：'${sessionName}' 正处于交互式提示，无法安全发送压缩前准备。`;
    case "target_activity_unknown":
      return `已拒绝：无法判定 '${sessionName}' 的活动状态，按失败关闭处理，使 /compact 不会落在提示上。`;
    case "wait_for_idle_timeout":
      return `准备已发给 '${sessionName}'，但它未及时进入空闲，因此未发送 /compact。等准备这一轮完成后重试。`;
    default:
      return `'${sessionName}' 的手动压缩未完成（${reason}）。`;
  }
}
