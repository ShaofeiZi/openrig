import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AgentActivityStore } from "../domain/agent-activity-store.js";
import type { SessionRegistry } from "../domain/session-registry.js";
import type { EventBus } from "../domain/event-bus.js";
import { verifyStartupProof } from "../domain/startup-proof.js";
import type { ActivityEvidence } from "../domain/activity-taxonomy.js";
import type { AgentActivity } from "../domain/types.js";
import * as parkedQuery from "../domain/parked-query.js";
import { runtimeRungInventory } from "../domain/activity-taxonomy.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";

// ── S19 A4——adapter 接缝的摄入半侧：hook 事件经此翻译到达唯一 oracle ──
// （SeatActivityService），使 AgentActivityStore 退化为原始事件的消费者/记录器，
// 仲裁只在一处发生。输入是 store 已经归一化的状态（一个事件名 parser，无孪生）。

/** 把已记录的 hook 活动翻译为 oracle 证据。oracle 不应消费的状态返回 null
 *  （unknown = 噪声，绝非证据）。needs_input 在 hooks rung 上变为 COUNT+reason——
 *  绝不是 activity 值（分类法的绑定排除）；turn 的 working/idle 由其他证据决定。 */
export function evidenceFromHookActivity(input: {
  seatNodeId: string;
  sessionName: string;
  runtime: string | null;
  activity: AgentActivity;
  seq: number;
}): ActivityEvidence | null {
  const base = {
    seatNodeId: input.seatNodeId,
    sessionName: input.sessionName,
    rung: "lifecycle-hooks" as const,
    sourceId: `${input.runtime ?? "unknown-runtime"}:hooks`,
    seq: input.seq,
    observedAt: input.activity.eventAt ?? input.activity.sampledAt,
  };
  switch (input.activity.state) {
    case "running":
      return { ...base, activity: "working", needsInput: { count: 0, reason: null } };
    case "idle":
      return { ...base, activity: "idle-at-prompt", needsInput: { count: 0, reason: null } };
    case "needs_input":
      return { ...base, needsInput: { count: 1, reason: input.activity.reason || "需要输入" } };
    default:
      return null; // unknown = 噪声，绝非证据
  }
}

// 摄入的 hook 证据按源单调递增的 seq（relay 不生成）。
const hookEvidenceSeq = new Map<string, number>();
function nextHookSeq(key: string): number {
  const next = (hookEvidenceSeq.get(key) ?? 0) + 1;
  hookEvidenceSeq.set(key, next);
  return next;
}

export const activityRoutes = new Hono();

activityRoutes.post("/hooks", async (c) => {
  const store = c.get("agentActivityStore" as never) as AgentActivityStore | undefined;
  const expectedToken = c.get("activityHookToken" as never) as string | undefined;

  if (!store || !expectedToken) {
    return c.json({
      ok: false,
      code: "activity_hook_unconfigured",
      error: "本后台服务未配置智能体活动 hook 摄入。",
    }, 503);
  }

  const authHeader = c.req.header("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : null;
  const headerToken = c.req.header("x-openrig-activity-token") ?? null;
  if (bearerToken !== expectedToken && headerToken !== expectedToken) {
    return c.json({
      ok: false,
      code: "activity_hook_unauthorized",
      error: "智能体活动 hook 摄入需要已配置的本地 hook token。",
    }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json() as Record<string, unknown>;
  } catch {
    return c.json({ ok: false, code: "invalid_json", error: "请求 body 必须是 JSON。" }, 400);
  }

  if (body.eventFamily === "session_identity") {
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
    const sessionName = stringOrNull(body.sessionName);
    const runtime = stringOrNull(body.runtime);
    if (!sessionId || !sessionName) {
      return c.json({ ok: false, code: "missing_session_identity", error: "session_identity 需要 sessionId 和 sessionName" }, 400);
    }

    const sessionRegistry = c.get("sessionRegistry" as never) as SessionRegistry | undefined;
    const eventBus = c.get("eventBus" as never) as EventBus | undefined;
    if (!sessionRegistry || !eventBus) {
      return c.json({ ok: false, code: "identity_hook_unconfigured", error: "会话 registry 不可用" }, 503);
    }

    const nodeId = stringOrNull(body.nodeId);
    const resolved = store.resolveSession({ sessionName, nodeId, runtime });
    if (!resolved) {
      return c.json({ ok: false, code: "session_not_found", error: `未找到会话 ${sessionName}` }, 404);
    }

    // OPR.0.4.6.PI1 FR-5——Pi 会话身份来自 pi-runner 的 RPC get_state
    // （总线上 provenance 为 "rpc"，绝不抓取）。Pi 的 resume TOKEN 是会话文件
    // （body.sessionFile），不是会话 id；在持久化前做格式校验，失败时绝不回显。
    if (runtime === "pi") {
      // 来自已退役 runner 的迟到 get_state 绝不能替换继任者的 resume token，
      // 也不能发布当前身份。保持解析、此检查与两个副作用同步，
      // 使续期不能在 await 处交错。
      const generation = stringOrNull(body.generation);
      let reason: string | null = null;
      try {
        const current = sessionRegistry.currentOccupantTenure(resolved.nodeId);
        if (!generation) reason = "generation_unverifiable";
        else if (!current || !sessionRegistry.isOccupantGenerationRegistered(resolved.nodeId, generation)) {
          reason = "generation_unresolvable";
        } else if (current.generationUuid !== generation) reason = "generation_mismatch";
      } catch {
        return c.json({
          ok: false, code: "generation_resolver_error", tokenPersisted: false,
          error: "Pi 会话身份已忽略：占用者 generation 不可用。",
        }, 503);
      }
      if (reason) {
        return c.json({
          ok: false, code: reason, tokenPersisted: false,
          error: "Pi 会话身份已忽略：发射方不是已登记的当前占用者。",
        }, 409);
      }
      const sessionFile = stringOrNull(body.sessionFile);
      const validation = validateResumeToken("pi", sessionFile);
      if (validation.ok) {
        sessionRegistry.updateResumeToken(resolved.sessionId, "pi_session_file", validation.token, "hook");
      }
      eventBus.emit({
        type: "agent.session_identity",
        rigId: resolved.rigId,
        nodeId: resolved.nodeId,
        sessionName: resolved.sessionName,
        runtime: "pi",
        sessionId,
        provenance: "rpc",
      });
      return c.json({ ok: true, sessionId, provenance: "rpc", tokenPersisted: validation.ok });
    }

    // resume-type 标签派生自运行时，绝不是固定默认值：这行曾对每个非 pi 运行时都盖
    // "codex_id"，导致 claude-code 席位在正确的 token 值上带着 codex 类型标签——
    // 而按标签选择 resume MECHANISM 的 restore 路径会在看似健康时选错。
    // relay 只在有 runtime 时才发 session_identity；未映射的运行时跳过持久化
    // （tokenPersisted: false），而不是猜一个标签。
    const validation = validateResumeToken(runtime, sessionId);
    if (validation.ok) {
      sessionRegistry.updateResumeToken(resolved.sessionId, validation.resumeType, validation.token, "hook");
    }
    eventBus.emit({
      type: "agent.session_identity",
      rigId: resolved.rigId,
      nodeId: resolved.nodeId,
      sessionName: resolved.sessionName,
      runtime: runtime ?? "codex",
      sessionId,
      provenance: "hook",
    });

    return c.json({ ok: true, sessionId, provenance: "hook", tokenPersisted: validation.ok });
  }

  // OPR.0.4.3.06——startup proof 摄入。镜像 session_identity：复用上面的
  // Bearer 鉴权 + relay 传输。绑定身份 + 防重放 + 契约校验；只有校验通过的 proof
  // 才投影 `oriented`（绝不 `ready`）。裸 ACK / 错误 / 重放 / 身份不匹配的 proof
  // 一律只追加拒绝。
  if (body.eventFamily === "startup_proof") {
    const eventBus = c.get("eventBus" as never) as EventBus | undefined;
    if (!eventBus) {
      return c.json({ ok: false, code: "startup_proof_unconfigured", error: "事件总线不可用" }, 503);
    }
    const result = verifyStartupProof({ store, eventBus }, {
      sessionName: stringOrNull(body.sessionName),
      nodeId: stringOrNull(body.nodeId),
      runtime: stringOrNull(body.runtime),
      challengeId: stringOrNull(body.challengeId),
      answer: typeof body.answer === "string" ? body.answer : null,
    });
    if (!result.ok) {
      // 身份失败（未知身份，或 nodeId/sessionName 解析到不同席位）→ 404；
      // 校验失败 → 422。
      const status = result.code === "identity_unbound" || result.code === "identity_mismatch" ? 404 : 422;
      return c.json({ ok: false, code: result.code, error: result.error }, status);
    }
    return c.json({ ok: true, oriented: "verified", nodeId: result.nodeId, challengeId: result.challengeId });
  }

  const result = store.recordHookEvent({
    runtime: stringOrNull(body.runtime),
    sessionName: stringOrNull(body.sessionName),
    nodeId: stringOrNull(body.nodeId),
    hookEvent: typeof body.hookEvent === "string" ? body.hookEvent : "",
    subtype: stringOrNull(body.subtype),
    occurredAt: stringOrNull(body.occurredAt),
    // W2a-1——源绑定的发射 generation，由托管 launch/fresh-handover 生产者携带。
    // 遗留、被排除或无 tenure 的发射路径可省略它 ⇒ 盖 null ⇒ 读取时未解析
    // （按路径合理缺失；绝不 false-fresh）。
    generation: stringOrNull(body.generation),
  });

  if (!result.ok) {
    const status = result.code === "missing_session_identity" ? 400 : 404;
    return c.json({ ok: false, code: result.code, error: result.error }, status);
  }

  // S19 A4——经 adapter 接缝喂给唯一 oracle：已记录（store 归一化）的事件变为
  // lifecycle-hooks rung 上的阶梯证据。store 仍是原始事件记录器
  // （startup-proof、投递校验）；仲裁只在 SeatActivityService 发生。
  const oracle = c.get("seatActivityService" as never) as
    | import("../domain/seat-activity-service.js").SeatActivityService
    | undefined;
  const emitted = result.event as { nodeId?: string; sessionName?: string; runtime?: string } | undefined;
  if (oracle && emitted?.nodeId && emitted.sessionName) {
    const runtime = emitted.runtime ?? stringOrNull(body.runtime);
    // 首次 hook 证据时自动声明（以及 swap 清空 inventory 后）：
    // 运行时的 inventory 设定每个 rung 的初始信任（claude 常驻、codex 按 AM-2
    // hooks-at-trial）——继任者的 rung 始终从不带提升开始。
    if (!oracle.hasRungInventory(emitted.nodeId)) {
      oracle.declareRungInventory(
        { seatNodeId: emitted.nodeId, sessionName: emitted.sessionName },
        runtimeRungInventory(runtime),
      );
    }
    const evidence = evidenceFromHookActivity({
      seatNodeId: emitted.nodeId,
      sessionName: emitted.sessionName,
      runtime,
      activity: result.activity,
      seq: nextHookSeq(`${emitted.nodeId}:${runtime ?? "unknown-runtime"}:hooks`),
    });
    if (evidence) oracle.reportEvidence(evidence);
  }

  return c.json({ ok: true, activity: result.activity });
});

// ── S19 AM-R18——推送基底：GET /api/activity/events (SSE) ──
// Desk 接受的形状（裁定行 qitem-20260827001530）：仅变更通知——
// seat.activity_changed（身份 + seq）与 seat.rung_health 流式发给打开的视图；
// 视图从 /api/ps 重新水合。推送绝不携带派生词汇，因此「无第二个活动机制」
// 按构造成立。无定时器：纯总线中继；断开即退订。
activityRoutes.get("/events", (c) => {
  const eventBus = c.get("eventBus" as never) as
    | { subscribe: (cb: (event: unknown) => void) => () => void }
    | undefined;
  if (!eventBus?.subscribe) {
    return c.json({
      ok: false,
      code: "activity_events_unconfigured",
      error: "活动事件流需要事件总线——本后台服务未配置。",
    }, 503);
  }
  return streamSSE(c, async (stream) => {
    const unsubscribe = eventBus.subscribe((event) => {
      const type = (event as { type?: string }).type;
      if (type !== "seat.activity_changed" && type !== "seat.rung_health" && type !== "proof.judged" && type !== "proof.sources_changed") return;
      void stream.writeSSE({ event: type, data: JSON.stringify(event) });
    });
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        unsubscribe();
        resolve();
      });
    });
  });
});

// ── S19 A7——parked 查询表面：GET /api/activity/parked[?seat=] ──
// 挂载在既有 activity 路由组下（不新增顶层挂载）：parked 诊断属于活动域——
// oracle 与队列义务面的 JOIN，读取时派生、绝不存储。只读：本路由不做任何队列写，
// oracle 保持其非推断契约。
activityRoutes.get("/parked", (c) => {
  const oracle = c.get("seatActivityService" as never) as
    | import("../domain/seat-activity-service.js").SeatActivityService
    | undefined;
  const queueRepo = c.get("queueRepo" as never) as
    | {
        list: (opts: { destinationSession?: string; state?: string[]; limit?: number }) => Array<{ qitemId: string; state: string; summary?: string | null }>;
        getParkWakeStatus: (qitemId: string) => import("../domain/queue-wake-repository.js").ParkWakeStatus | null;
      }
    | undefined;
  const rigRepo = c.get("rigRepo" as never) as { db: import("better-sqlite3").Database } | undefined;
  if (!oracle || !queueRepo || !rigRepo) {
    return c.json({
      ok: false,
      code: "parked_query_unconfigured",
      error: "parked 查询需要活动 oracle、队列 repository 与 rig repository——本后台服务未配置其中之一。",
    }, 503);
  }

  const { diagnoseSeatParked, diagnoseRigParked, PARKED_OBLIGATION_LIMIT } = parkedQuery;
  const deps = {
    getSeatState: (id: string) => oracle.getSeatState(id),
    listOpenObligations: (destination: string, limit: number) => ({
      rows: queueRepo
        .list({ destinationSession: destination, state: ["pending", "in-progress", "blocked"], limit })
        .map((r) => ({ qitemId: r.qitemId, state: r.state as "pending" | "in-progress" | "blocked", summary: r.summary ?? null })),
      limit,
    }),
    getParkWake: (qitemId: string) => queueRepo.getParkWakeStatus(qitemId),
  };

  // WAVE-O B2 (R2 508e383d)：诊断是 rig 范围的，绝不是全 fleet。解析一个声明的
  // scope——携带 @rig 的显式 seat 坐标、显式 ?rig= 参数，或调用方自己的会话身份——
  // 并在响应中具名（AM-3：运行的 scope 是答案的一部分）。无可解析 scope 即诚实拒绝，
  // 绝不静默折叠后台服务上的每个 rig。
  const seatParam = c.req.query("seat") || undefined;
  const rigParam = c.req.query("rig") || undefined;
  const callerSession = c.req.header("x-openrig-session") || undefined;
  let scope: { rig: string; resolvedFrom: "seat-coordinate" | "query-param" | "caller-session" } | null = null;
  if (seatParam?.includes("@")) {
    scope = { rig: seatParam.split("@")[1]!, resolvedFrom: "seat-coordinate" };
  } else if (rigParam) {
    scope = { rig: rigParam, resolvedFrom: "query-param" };
  } else if (callerSession?.includes("@")) {
    // 规范本地形式 name@rig；跨 host 戳 name@rig@host 解析方式相同。
    scope = { rig: callerSession.split("@")[1]!, resolvedFrom: "caller-session" };
  }
  if (!scope) {
    return c.json({
      ok: false,
      code: "rig_scope_unresolvable",
      error: "parked 诊断是 rig 范围的，但无法解析出 rig 坐标——请传 ?rig=<name>（CLI：--rig）、用规范会话名指定席位（?seat=name@rig），或从席位 shell 调用使会话身份携带 rig。",
    }, 400);
  }
  const rigRow = rigRepo.db.prepare("SELECT id, name FROM rigs WHERE name = ?").get(scope.rig) as { id: string; name: string } | undefined;
  if (!rigRow) {
    const known = (rigRepo.db.prepare("SELECT name FROM rigs ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    return c.json({
      ok: false,
      code: "rig_not_found",
      error: `本后台服务没有名为 "${scope.rig}" 的 rig——已知 rig：${known.join(", ") || "（无）"}。`,
    }, 404);
  }

  const seats = rigRepo.db.prepare(`
    SELECT n.id AS node_id, s.session_name AS session_name
    FROM nodes n
    JOIN rigs r ON r.id = n.rig_id
    JOIN sessions s ON s.node_id = n.id
      AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
    WHERE s.status = 'running' AND s.session_name IS NOT NULL AND r.name = ?
  `).all(scope.rig) as Array<{ node_id: string; session_name: string }>;

  if (seatParam) {
    const match = seats.find((s) => s.node_id === seatParam || s.session_name === seatParam);
    if (!match) {
      return c.json({
        ok: false,
        code: "seat_not_found",
        error: `rig "${scope.rig}" 中没有运行中的席位匹配 "${seatParam}"——请传 node id 或规范会话名（范围内已知：${seats.map((s) => s.session_name).join(", ") || "（无运行中）"}）。`,
      }, 404);
    }
    return c.json({
      ok: true,
      seat: diagnoseSeatParked(deps, { seatNodeId: match.node_id, sessionName: match.session_name }),
      scope,
      limit: PARKED_OBLIGATION_LIMIT,
    });
  }
  return c.json({
    ok: true,
    rig: {
      ...diagnoseRigParked(deps, seats.map((s) => ({ seatNodeId: s.node_id, sessionName: s.session_name }))),
      scope,
    },
  });
});

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
