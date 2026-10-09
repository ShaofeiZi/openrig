import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type Database from "better-sqlite3";
import type { EventBus } from "../domain/event-bus.js";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import { LOCAL_HOST_ID, getSelfHostId } from "../domain/hosts/fanout-contract.js";
import { loadHostRegistry, resolveHost } from "../domain/hosts/hosts-registry-reader.js";
import { remoteJsonRequest } from "../domain/hosts/remote-daemon-http.js";

/** OPR.0.4.4.15 FR-4——remote-action 超时类（事务性写，不是 bootstrap；
 *  按 arch required-argument 锐化在本 call-site 命名）。 */
const REMOTE_ACTION_TIMEOUT_MS = 10_000;
import {
  MissionControlActionLogError,
  MISSION_CONTROL_VERBS,
  type MissionControlVerb,
} from "../domain/mission-control/mission-control-action-log.js";
import {
  MISSION_CONTROL_VIEWS,
  type MissionControlReadLayer,
  type MissionControlViewName,
} from "../domain/mission-control/mission-control-read-layer.js";
import {
  MissionControlWriteContractError,
  type MissionControlWriteContract,
} from "../domain/mission-control/mission-control-write-contract.js";
import type { MissionControlFleetCliCapability } from "../domain/mission-control/mission-control-fleet-cli-capability.js";
import type { MissionControlAuditBrowse } from "../domain/mission-control/audit-browse.js";
import type { MissionControlNotificationDispatcher } from "../domain/mission-control/notification-dispatcher.js";
import { resolveActorWithDeferral, resolveRecordedProvenance } from "./require-sender-identity.js";

/**
 * Mission Control HTTP 路由（PL-005 Phase A）。支撑既有 shell 内集成的
 * Mission Control 产品 UI。
 *
 * 按 Phase A R1（PL-004）SSE 路由顺序教训：SSE/字面路径挂载在
 * 裸参数 /:view-name catchall 之前。
 *
 * 端点：
 *   GET  /api/mission-control/views/:view-name   读 7 视图之一
 *   POST /api/mission-control/action              执行 7 verb 之一
 *   GET  /api/mission-control/sse                 mission_control.* 事件的 SSE 流
 *   GET  /api/mission-control/watch              /sse 的别名
 *   GET  /api/mission-control/cli-capabilities   每 rig CLI capability 缓存
 *   GET  /api/mission-control/destinations       handoff/route 目标候选
 *   GET  /api/mission-control/views             列出视图名
 */
export interface MissionControlRoutesOpts {
  /**
   * PL-005 Phase B：设置后在写 verb（POST /action、POST /notifications/test）上
   * 强制 bearer token。为 null 时后台服务绑定 loopback、不强制鉴权
   * （index.ts 启动检查保证这一点）。
   */
  bearerToken?: string | null;
}

export interface MissionControlDestination {
  sessionName: string;
  label: string;
  source: "topology" | "queue";
  rigName?: string | null;
  logicalId?: string | null;
  runtime?: string | null;
  status?: string | null;
}

export function missionControlRoutes(opts?: MissionControlRoutesOpts): Hono {
  const app = new Hono();
  const bearerToken = opts?.bearerToken ?? null;
  // PL-005 Phase B：bearer-token middleware 挂载在写 verb 上。
  // 读在 tailnet 绑定后保持开放，覆盖"手机端带浏览器"场景——operator 还没在
  // 移动端输入 token——bearer 是为了写完整性，不是视图机密性。
  // （operator 可在未来修订中把 gating 扩到读路径；按 planner brief，v0 默认只门控写。）
  const requireAuth = authBearerTokenMiddleware({ expectedToken: bearerToken });

  function getReadLayer(c: { get: (key: string) => unknown }): MissionControlReadLayer {
    return c.get("missionControlReadLayer" as never) as MissionControlReadLayer;
  }
  function getAuditBrowse(c: { get: (key: string) => unknown }): MissionControlAuditBrowse {
    return c.get("missionControlAuditBrowse" as never) as MissionControlAuditBrowse;
  }
  function getNotificationDispatcher(
    c: { get: (key: string) => unknown },
  ): MissionControlNotificationDispatcher | undefined {
    return c.get("missionControlNotificationDispatcher" as never) as
      | MissionControlNotificationDispatcher
      | undefined;
  }
  function getWriteContract(c: { get: (key: string) => unknown }): MissionControlWriteContract {
    return c.get("missionControlWriteContract" as never) as MissionControlWriteContract;
  }
  function getCliCapability(c: { get: (key: string) => unknown }): MissionControlFleetCliCapability {
    return c.get("missionControlFleetCliCapability" as never) as MissionControlFleetCliCapability;
  }
  function getEventBus(c: { get: (key: string) => unknown }): EventBus {
    return c.get("eventBus" as never) as EventBus;
  }
  function getDb(c: { get: (key: string) => unknown }): Database.Database | undefined {
    return c.get("db" as never) as Database.Database | undefined;
  }

  function tableExists(db: Database.Database, tableName: string): boolean {
    const row = db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as { present: number } | undefined;
    return Boolean(row);
  }

  function listDestinations(
    db: Database.Database,
    operatorSeatFallback?: string | null,
  ): MissionControlDestination[] {
    const destinations = new Map<string, MissionControlDestination>();
    const addDestination = (candidate: MissionControlDestination) => {
      const sessionName = candidate.sessionName.trim();
      if (!sessionName) return;
      const existing = destinations.get(sessionName);
      if (!existing || candidate.source === "topology") {
        destinations.set(sessionName, { ...candidate, sessionName });
      }
    };

    if (tableExists(db, "sessions") && tableExists(db, "nodes") && tableExists(db, "rigs")) {
      const rows = db
        .prepare(
          `
            SELECT
              s.session_name,
              s.status,
              n.logical_id,
              n.runtime,
              r.name AS rig_name
            FROM sessions s
            JOIN nodes n ON n.id = s.node_id
            JOIN rigs r ON r.id = n.rig_id
            WHERE s.session_name IS NOT NULL AND TRIM(s.session_name) != ''
            ORDER BY r.name COLLATE NOCASE, n.logical_id COLLATE NOCASE, s.session_name COLLATE NOCASE
          `,
        )
        .all() as Array<{
          session_name: string;
          status: string | null;
          logical_id: string | null;
          runtime: string | null;
          rig_name: string | null;
        }>;

      for (const row of rows) {
        const topologyLabel =
          row.logical_id && row.rig_name ? `${row.logical_id}@${row.rig_name}` : null;
        addDestination({
          sessionName: row.session_name,
          label:
            topologyLabel && topologyLabel !== row.session_name
              ? `${topologyLabel} - ${row.session_name}`
              : row.session_name,
          source: "topology",
          rigName: row.rig_name,
          logicalId: row.logical_id,
          runtime: row.runtime,
          status: row.status,
        });
      }
    }

    if (tableExists(db, "queue_items")) {
      const rows = db
        .prepare(
          `
            SELECT DISTINCT TRIM(session_name) AS session_name
            FROM (
              SELECT source_session AS session_name FROM queue_items
              UNION
              SELECT destination_session AS session_name FROM queue_items
              UNION
              SELECT handed_off_to AS session_name FROM queue_items
              UNION
              SELECT handed_off_from AS session_name FROM queue_items
            )
            WHERE session_name IS NOT NULL AND TRIM(session_name) != ''
            ORDER BY session_name COLLATE NOCASE
          `,
        )
        .all() as Array<{ session_name: string }>;

      for (const row of rows) {
        addDestination({
          sessionName: row.session_name,
          label: row.session_name,
          source: "queue",
        });
      }
    }

    // V0.3.1 slice 05——kernel 宕机状态的双保险：若配置的 operator seat
    // 还不在 topology + 队列历史里（全新安装、kernel 尚未启动、或 kernel 崩溃），
    // 仍把它纳入，使 picker 能路由到后台服务其余 mission-control 读层将解析的席位。
    // source 标签刻意保持 "queue"，使 picker 排序把 live topology 条目留在顶部。
    if (operatorSeatFallback) {
      const trimmed = operatorSeatFallback.trim();
      if (trimmed && !destinations.has(trimmed)) {
        destinations.set(trimmed, {
          sessionName: trimmed,
          label: trimmed,
          source: "queue",
        });
      }
    }

    return [...destinations.values()].sort((a, b) => {
      if (a.source !== b.source) return a.source === "topology" ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  }

  function errorResponse(
    c: { json: (body: unknown, status?: number) => Response },
    err: unknown,
  ): Response {
    if (err instanceof MissionControlActionLogError) {
      const status =
        err.code === "verb_unknown" ? 400
        : err.code === "annotation_required" || err.code === "reason_required" ? 400
        : 500;
      return c.json(
        { error: err.code, message: err.message, ...(err.details ?? {}) },
        status as 200,
      );
    }
    if (err instanceof MissionControlWriteContractError) {
      const status =
        err.code === "qitem_not_found" ? 404
        : err.code === "qitem_already_terminal" ? 409
        : err.code === "destination_required" ? 400
        : err.code === "annotation_required" ? 400
        : err.code === "decision_required" ? 400
        : err.code === "qitem_not_leg1_parked" ? 409
        : 500;
      return c.json(
        { error: err.code, message: err.message, ...(err.details ?? {}) },
        status as 200,
      );
    }
    const message = err instanceof Error ? err.message : "内部错误";
    return c.json({ error: "internal_error", message }, 500);
  }

  // GET /views——列出视图名。必须在 /views/:view-name catchall 之前。
  app.get("/views", (c) => {
    return c.json({ views: [...MISSION_CONTROL_VIEWS] });
  });

  // GET /cli-capabilities——fleet 汇总 + 漂移指示。
  app.get("/cli-capabilities", async (c) => {
    const fleet = await getCliCapability(c).rollupFleet();
    return c.json(fleet);
  });

  // GET /destinations——手机友好的 route/handoff 候选。必须与其他 Mission Control
  // 字面路由一起在 /views/:view-name catchall 之前。
  // V0.3.1 slice 05——从 mission-control 读层的 defaultOperatorSession
  // 解析 operator-seat fallback（它自己跟踪 workspace.operator_seat_name 设置），
  // 使 picker 即使在 kernel 尚未启动时也始终提供已配置的 operator seat。
  app.get("/destinations", (c) => {
    const db = getDb(c);
    if (!db) return c.json({ destinations: [] });
    const operatorSeat = getReadLayer(c).getDefaultOperatorSession();
    return c.json({ destinations: listDestinations(db, operatorSeat) });
  });

  // mission_control.* 事件的 SSE。必须在 /views/:view-name 之前
  // （按 PL-004 Phase A R1 SSE 路由顺序教训）。
  const sseHandler = (c: Parameters<typeof streamSSE>[0]) => {
    const eventBus = getEventBus(c);
    return streamSSE(c, async (stream) => {
      const unsubscribe = eventBus.subscribe((event) => {
        if (
          event.type !== "mission_control.action_executed" &&
          event.type !== "mission_control.cli_drift_detected" &&
          event.type !== "mission_control.view_refreshed"
        ) return;
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

  // PL-005 Phase B：写 verb 上的 bearer-token 门。
  app.post("/action", requireAuth);
  app.post("/notifications/test", requireAuth);

  // POST /action——经原子写契约执行 7 verb 之一。
  // OPR.0.4.4.15 FR-4：可选 hostId 把同一 verb 路由到 ORIGIN host 的后台服务服务端
  // （item 的 verb 在 qitem 所在处执行）。hostId 缺失或 'local' = 今日路径逐字节不变。
  app.post("/action", async (c) => {
    const body = await c.req
      .json<{
        verb?: MissionControlVerb;
        qitemId?: string;
        actorSession?: string;
        destinationSession?: string;
        body?: string;
        annotation?: string;
        reason?: string;
        decision?: string;
        notify?: boolean;
        auditNotes?: Record<string, unknown>;
        hostId?: string;
      }>()
      .catch(() => ({} as never));
    if (!body.verb) return c.json({ error: "verb 为必填项" }, 400);
    if (!MISSION_CONTROL_VERBS.includes(body.verb)) {
      return c.json(
        {
          error: "verb_unknown",
          message: `未知 verb '${body.verb}'；支持：${MISSION_CONTROL_VERBS.join(", ")}`,
          supported: [...MISSION_CONTROL_VERBS],
        },
        400,
      );
    }
    if (!body.qitemId) return c.json({ error: "qitemId 为必填项" }, 400);
    // P21 I2 + review-actions deferral：mission-control /action 是 FOUNDER 可见表面——
    // 浏览器 UI HEADERLESS 触发 approve/deny 等（仅 bearer，body actorSession）。
    // resolveActorWithDeferral、P18 deliver-and-label：CLI 头 ⇒ transport:v1，
    // wire 取代不匹配的 body（409 已退役，裁定 A）；UI headerless ⇒ body actor
    // 记为 claimed:v1（已声明但未核实），绝不拒绝、绝不洗白。
    // 在本地写与跨 host forward 之前运行。
    const identity = resolveActorWithDeferral(c, { verb: `mission-control ${body.verb}`, bodyClaim: body.actorSession });
    if (!identity.ok) return identity.response;
    // 唯一 provenance 决定者（rail 2）：仅当 transport 在本跳证明时才 transport:v1；
    // 一跳之外 relay:v1；UI deferral 或不可传播/遗留标记时 claimed:v1（降级默认）。
    const recordedProvenance = resolveRecordedProvenance(c, identity);
    if (typeof body.hostId === "string" && body.hostId !== "" && body.hostId !== LOCAL_HOST_ID) {
      // 远程 forward（arch 裁定 4：一条写路径、一份 verb allowlist——
      // 上面的检查已跑；origin 后台服务在自己路由上重新校验）。
      // 此处不向 LOCAL mission_control_actions 写任何东西——
      // origin host 的审计行 + 此结构化透传即记录本身（R15-3；本地出站审计 log 按 arch 丢弃）。
      const registryLoader = (c.get("hostRegistryLoader" as never) as (() => ReturnType<typeof loadHostRegistry>) | undefined) ?? loadHostRegistry;
      const fetchImpl = c.get("remoteFetchImpl" as never) as typeof fetch | undefined;
      const hostId = body.hostId;
      const fail = (detail: string, failureClass: string, remoteStatus?: number) =>
        c.json({ error: "remote_action_failed", hostId, failureClass, ...(remoteStatus !== undefined ? { remoteStatus } : {}), detail }, 502);
      const reg = registryLoader();
      if (!reg.ok) return fail(reg.error, "registry");
      const resolved = resolveHost(reg.registry, hostId);
      if (!resolved.ok) return fail(resolved.error, "unknown-host");
      if (resolved.host.transport !== "http") {
        return fail(`host '${hostId}' 声明为 SSH；远程 action 需要 http-transport registry 条目（url；bearer 可选）`, "unsupported-transport");
      }
      // P21 I2 跨 host 重盖章：剥离入站身份声明（hostId 与 actorSession），
      // 并从本后台服务的派生 actor（`identity.session`，来自上面 chokepoint）
      // 重盖 X-OpenRig-Session + 标记 relay provenance——origin 派生重盖章后的 actor，
      // 绝不取转发的 body 声明（census 的 #5/#17 forward 站点）。
      const { hostId: _dropped, actorSession: _claim, ...forwardBody } = body as Record<string, unknown>;
      const res = await remoteJsonRequest(resolved.host, "/api/mission-control/action", {
        method: "POST",
        body: forwardBody,
        timeoutMs: REMOTE_ACTION_TIMEOUT_MS,
        fetchImpl,
        headers: {
          "X-OpenRig-Session": identity.session,
          "X-OpenRig-Relay": getSelfHostId() ?? "unknown",
          // 携带本跳解析出的 provenance，使 origin 绝不把 claimed 时代 actor 洗白成已验证：
          // identity.provenance 是 transport:v1（CLI）或 claimed:v1（UI deferral）。
          // origin 的 resolveRecordedProvenance 降级——transport:v1 标记 ⇒ relay:v1，
          // 其他全部 ⇒ claimed:v1。（字面大写 key，与兄弟 X-OpenRig-Session/Relay 发送约定一致；
          // 接收侧经 IDENTITY_PROVENANCE_HEADER 大小写不敏感读取。）
          "X-OpenRig-Provenance": identity.provenance,
        },
      });
      if (res.ok) {
        // origin 的结构化成功响应，逐字——不做乐观的本地重塑形，不做本地审计写。
        return c.json(res.payload as Record<string, unknown>);
      }
      switch (res.kind) {
        case "bearer":
          return fail(res.detail, "auth-failed");
        case "timeout":
          return fail(
            res.phase === "body"
              ? `远程 action 超时：响应头已到（HTTP ${res.status}）但 body 一直未完成`
              : `远程 action 在 ${REMOTE_ACTION_TIMEOUT_MS}ms 后超时`,
            "unreachable",
            res.status,
          );
        case "network":
          return fail(res.detail, "unreachable");
        case "http":
          // origin 拒绝（它自己的校验/鉴权/冲突）——其结构化错误透传；不造假成功。
          return fail(res.detail || `HTTP ${res.status}`, res.status === 401 || res.status === 403 ? "auth-failed" : "remote-error", res.status);
      }
    }
    try {
      const result = await getWriteContract(c).act({
        verb: body.verb,
        qitemId: body.qitemId,
        actorSession: identity.session, // 派生（CLI）或已声明的 claimed 时代 actor（UI deferral）
        // P21 era 戳——resolver 是唯一来源（rail 2），绝不硬编码：
        // transport:v1（此处已证明）| relay:v1（一跳之外）| claimed:v1（UI deferral，或降级/遗留 relay 标记）。
        identityProvenance: recordedProvenance,

        destinationSession: body.destinationSession,
        body: body.body,
        annotation: body.annotation,
        reason: body.reason,
        decision: body.decision,
        notify: body.notify,
        auditNotes: body.auditNotes,
      });
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // PL-005 Phase B：GET /audit——对 mission_control_actions 的只读浏览。
  // 必须在 /views/:view-name catchall 之前（按 PL-004 Phase A R1 教训的路由顺序纪律）。
  app.get("/audit", async (c) => {
    const audit = getAuditBrowse(c);
    if (!audit) return c.json({ error: "audit_browse_unavailable" }, 500);
    const qitemId = c.req.query("qitem_id") || undefined;
    const actionVerb = c.req.query("action_verb") || undefined;
    const actorSession = c.req.query("actor_session") || undefined;
    const since = c.req.query("since") || undefined;
    const until = c.req.query("until") || undefined;
    const limit = c.req.query("limit") ? Number.parseInt(c.req.query("limit")!, 10) : undefined;
    const beforeId = c.req.query("before_id") || undefined;
    // OPR.0.4.4.19 FR-9——scope-approval 目标过滤（固定的
    // audit_notes_json 读路径）。
    const scopeTier = c.req.query("scope_tier") || undefined;
    const scopeId = c.req.query("scope_id") || undefined;
    const scopePath = c.req.query("scope_path") || undefined;
    const approvalScope = c.req.query("approval_scope") || undefined;
    try {
      const result = audit.query({ qitemId, actionVerb, actorSession, since, until, limit, beforeId, scopeTier, scopeId, scopePath, approvalScope });
      return c.json(result);
    } catch (err) {
      return c.json(
        {
          error: "audit_query_failed",
          message: err instanceof Error ? err.message : "内部错误",
        },
        500,
      );
    }
  });

  // PL-005 Phase B：POST /notifications/test——经配置机制发送合成通知，
  // 使 operator 在依赖前能验证。bearer-token 门控（上面已注册）。
  app.post("/notifications/test", async (c) => {
    const dispatcher = getNotificationDispatcher(c);
    if (!dispatcher) {
      return c.json(
        {
          error: "notifications_unconfigured",
          message:
            "notifications dispatcher 未接入；请在后台服务配置中设置 notifications.mechanism (ntfy|webhook) 后重启",
        },
        503,
      );
    }
    try {
      const result = await dispatcher.sendTest();
      return c.json(result);
    } catch (err) {
      return c.json(
        {
          error: "notification_test_failed",
          message: err instanceof Error ? err.message : "内部错误",
        },
        500,
      );
    }
  });

  // GET /views/:view-name——读 7 视图之一。必须在 /views、
  // /cli-capabilities、/sse、/watch、/audit 字面路径之后。
  app.get("/views/:view-name", async (c) => {
    const viewName = c.req.param("view-name") as MissionControlViewName;
    if (!MISSION_CONTROL_VIEWS.includes(viewName)) {
      return c.json(
        {
          error: "view_unknown",
          message: `未知视图 '${viewName}'；支持：${MISSION_CONTROL_VIEWS.join(", ")}`,
          supported: [...MISSION_CONTROL_VIEWS],
        },
        404,
      );
    }
    const operatorSession = c.req.query("operatorSession") || undefined;
    try {
      const result = await getReadLayer(c).readView(viewName, { operatorSession });
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  return app;
}
