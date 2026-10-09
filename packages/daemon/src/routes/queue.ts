import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
import type {
  QueueRepository,
  QueuePriority,
  QueueState,
} from "../domain/queue-repository.js";
import { QueueRepositoryError, newQitemId, deriveCrossHostSuccessorId, stampSelfHostSuffix, classifyNudgeFailure } from "../domain/queue-repository.js";
import type { QueueItem } from "../domain/queue-repository.js";
import { parseSessionName, isHumanSeatSessionRef } from "../domain/session-name.js";
import { requireSenderIdentity, resolveRecordedProvenance, ORIGIN_UNKNOWN_HEADER } from "./require-sender-identity.js";
import { hostname as osHostname } from "node:os";
import type { InboxHandler } from "../domain/inbox-handler.js";
import { InboxHandlerError } from "../domain/inbox-handler.js";
import { type OutboxHandler } from "../domain/outbox-handler.js";
import { aggregateAttention } from "../domain/feed/attention-aggregator.js";
import type { AttentionItem } from "../domain/feed/attention-aggregator.js";
import { loadHostRegistry, resolveHost } from "../domain/hosts/hosts-registry-reader.js";
import { LOCAL_HOST_ID } from "../domain/hosts/fanout-contract.js";
import { remoteJsonRequest } from "../domain/hosts/remote-daemon-http.js";
import type { SettingsStore } from "../domain/user-settings/settings-store.js";
import { deriveCurrentWork } from "../domain/current-work.js";

/**
 * 协调层 L3——队列 HTTP 路由（PL-004 Phase A）。
 *
 * 按 host 范围。支撑 `zrig queue create|claim|update|handoff|show|list|inbox-*`。
 * Hot-potato 严格拒绝发生在 domain 层；路由用 validReasons 枚举呈现结构化错误，
 * 使 CLI 能渲染帮助。
 */

// OPR.0.4.6.MH3 D-5：跨 host FORWARD 写类超时，在 call site 命名（S15 规则）。
// 5s READ 预算不是写预算；转发的协调 WRITE 有自己宽裕但有界的窗口
// （与 mission-control 的 REMOTE_ACTION_TIMEOUT_MS 同类）。remoteJsonRequest
// 绝不挂起——超时呈现为结构化的 host 命名失败。
const QUEUE_FORWARD_TIMEOUT_MS = 10_000;

// OPR.0.4.6.MH3 D-4 (FR-2/R2a)：追加到 FORWARDED body tags 的跨 host
// provenance 形状——一个标记（`cross-host`）+ 转发 daemon 自声明名
// （`from-host:<name>`）。诚实的 best-effort provenance，不是认证身份
// （host id 是 per-registry 本地别名）。没有它，successor 的 source_session
// （按原样记录）与本地 session 无法区分。自声明名是 daemon 自己的 OS hostname——
// 已发布 registry 没有规范 own-alias reader，D-4 设计上把这个名框为自由文本 best-effort。
export const CROSS_HOST_TAG = "cross-host";
export function crossHostProvenanceTags(existing: string[] | undefined): string[] {
  const base = existing ?? [];
  const fromHost = `from-host:${osHostname()}`;
  const additions = [CROSS_HOST_TAG, fromHost].filter((t) => !base.includes(t));
  return [...base, ...additions];
}

/** 人工请求：规范人工目标或人工阻塞者，排除显式 update。
 * 仅 tier 标签绝不产生人工义务。同一谓词在 QueueRepository.listAttention
 * 的 LIMIT 之前在 SQL 中运行。 */
export function isAttentionItem(q: { tier: string | null; destinationSession: string; state?: string; blockedOn?: string | null; humanIntent?: string | null }): boolean {
  if (q.humanIntent === "update") return false;
  if (isHumanSeatSessionRef(q.destinationSession)) return true;
  return q.state === "blocked" && isHumanSeatSessionRef(q.blockedOn ?? "");
}


export function queueRoutes(): Hono {
  const app = new Hono();

  function getRepo(c: { get: (key: string) => unknown }): QueueRepository {
    return c.get("queueRepo" as never) as QueueRepository;
  }
  function getInbox(c: { get: (key: string) => unknown }): InboxHandler {
    return c.get("inboxHandler" as never) as InboxHandler;
  }
  function getOutbox(c: { get: (key: string) => unknown }): OutboxHandler {
    return c.get("outboxHandler" as never) as OutboxHandler;
  }
  function getEventBus(c: { get: (key: string) => unknown }): EventBus {
    return c.get("eventBus" as never) as EventBus;
  }

  /** PL-007：按源工作组的类型化 workspace 块校验 `target_repo`。
   *  当 repo 名不匹配源工作组 RigSpec.workspace.repos[] 时返回三段式结构化错误。
   *  不关联带 workspace 工作组的 session 放行（target_repo 作为自由格式 tag
   *  为向后兼容保留）。 */
  function validateTargetRepo(
    c: { get: (key: string) => unknown },
    sourceSession: string,
    targetRepo: string,
  ): { ok: true } | { ok: false; error: string; message: string; meta?: Record<string, unknown> } {
    const rigRepo = c.get("rigRepo" as never) as import("../domain/rig-repository.js").RigRepository | undefined;
    if (!rigRepo) return { ok: true };
    // OPR.0.4.6.MH1 FR-8：共享 parse 契约（此 regex 曾是契约的规范形状——
    // 对每个输入行为一致）。
    const parsedSource = parseSessionName(sourceSession);
    if (parsedSource.kind !== "canonical") return { ok: true };
    const rigName = parsedSource.rig;
    const rigs = rigRepo.findRigsByName(rigName);
    if (rigs.length === 0) return { ok: true };
    const rigId = rigs[0]!.id;
    const ws = rigRepo.getRigWorkspace(rigId);
    if (!ws) return { ok: true };
    const known = ws.repos.map((r) => r.name);
    if (!known.includes(targetRepo)) {
      return {
        ok: false,
        error: "unknown_target_repo",
        message: `target_repo "${targetRepo}" 与工作组 ${rigName} 工作区中的任何 repo 都不匹配；运行 rig whoami --json | jq .workspace.repos 查看已声明的 repos`,
        meta: { rigName, knownRepos: known },
      };
    }
    return { ok: true };
  }

  function errorResponse(c: { json: (body: unknown, status?: number) => Response }, err: unknown): Response {
    if (err instanceof QueueRepositoryError) {
      const status = err.code === "qitem_not_found" ? 404
        : err.code === "missing_closure_reason" ? 400
        : err.code === "invalid_closure_reason" ? 400
        : err.code === "missing_closure_target" ? 400
        : err.code === "invalid_state" ? 400
        : err.code === "state_or_note_required" ? 400
        : err.code === "note_append_fields_not_admitted" ? 400
        : err.code === "terminal_reopen_requires_ack" ? 409
        : err.code === "terminal_reopen_target_invalid" ? 400
        : err.code === "reopen_note_required" ? 400
        : err.code === "reopen_not_applicable" ? 400
        : err.code === "claim_destination_mismatch" ? 403
        : err.code === "qitem_not_claimable" ? 409
        : err.code === "qitem_not_in_progress" ? 409
        : err.code === "qitem_already_terminal" ? 409
        // OPR.0.4.6.MH3 Q-a：同一 minted id、不同 destination/source =
        // 调用方 id 复用（bug，不是幂等重试）——呈现为冲突，绝不覆盖。
        : err.code === "qitem_id_reuse" ? 409
        // OPR.0.4.6.MH3 FR-4 (C2)：跨 host source-close re-drive 命名了与已记录
        // 不同的 closure_target——期间别人已关闭 source；呈现，绝不覆盖。
        : err.code === "cross_host_close_conflict" ? 409
        : err.code === "unknown_destination_rig" ? 400
        : err.code === "human_registry_unavailable" ? 400
        : err.code === "human_route_fields_required" ? 400
        : err.code === "invalid_human_notification" ? 400
        // OPR.0.5.1 slice-51-06 D2：非 park 迁移上的 summary/evidence_ref——客户端
        // 输入错误呈现为结构化 400（daemon 在任何 mutation 前拒绝）。
        : err.code === "summary_evidence_not_persistable" ? 400
        // OPR.0.4.6.WF3 FR-6：frontier close-path 守卫——操作员对 live workflow
        // packet 误用 queue verb；带 what/why/fix 消息的结构化 400，绝不 500。
        : err.code === "workflow_frontier_packet" ? 400
        : 500;
      return c.json({ error: err.code, message: err.message, ...(err.meta ?? {}) }, status as 200);
    }
    if (err instanceof InboxHandlerError) {
      const status = err.code === "inbox_not_found" ? 404
        : err.code === "auth_failed" ? 401
        : err.code === "absorb_destination_mismatch" ? 403
        : err.code === "deny_destination_mismatch" ? 403
        : err.code === "inbox_already_denied" ? 409
        : err.code === "inbox_not_pending" ? 409
        : 500;
      return c.json({ error: err.code, message: err.message }, status as 200);
    }
    const message = err instanceof Error ? err.message : "内部错误";
    return c.json({ error: "internal_error", message }, 500);
  }

  // OPR.0.4.6.MH3 (FR-2, C1；返回形状在 C2 泛化)：队列跨 host 协调写的唯一共享
  // forward-then-strip 助手（create + handoff 都走它——一个机制，不是两个）。
  // 泛化自已发布的 mission-control 写模板（routes/mission-control.ts:340-388）：
  // daemon 侧解析 registry，拒绝 ssh/不支持的 transport，把整个 body
  // （调用方已 minted + provenance-tagged + hostId-stripped）通过 bearer 转发给
  // origin daemon，并把 transport 失败映射为结构化的 host 命名分类。
  // Bearer 在 server 侧解析，绝不回到调用方（已发布姿态）。
  //
  // 返回 discriminated union 而非 Response，使 HANDOFF 编排（C2）可组合：成功时
  // 需要 origin 的逐字 payload 与本地 source-close 结果配对；/create 直接解包。
  // 无论如何 origin 的行是 THE record——这里绝不写本地。
  async function forwardQueueWrite(
    c: {
      get: (key: string) => unknown;
      json: (body: unknown, status?: number) => Response;
      req: { header: (name: string) => string | undefined };
    },
    hostId: string,
    path: string,
    forwardBody: Record<string, unknown>,
  ): Promise<
    | { ok: true; payload: unknown; status: number }
    | { ok: false; response: Response }
  > {
    const registryLoader =
      (c.get("hostRegistryLoader" as never) as (() => ReturnType<typeof loadHostRegistry>) | undefined) ??
      loadHostRegistry;
    const fetchImpl = c.get("remoteFetchImpl" as never) as typeof fetch | undefined;
    const fail = (detail: string, failureClass: string, remoteStatus?: number): { ok: false; response: Response } => ({
      ok: false,
      response: c.json(
        { error: "remote_queue_write_failed", hostId, failureClass, ...(remoteStatus !== undefined ? { remoteStatus } : {}), detail },
        502,
      ),
    });
    const reg = registryLoader();
    if (!reg.ok) return fail(reg.error, "registry");
    const resolved = resolveHost(reg.registry, hostId);
    if (!resolved.ok) return fail(resolved.error, "unknown-host");
    if (resolved.host.transport !== "http") {
      return fail(
        `host '${hostId}' 声明为 SSH；跨 host 队列写需要 http-transport registry 条目（url；bearer 可选）`,
        "unsupported-transport",
      );
    }
    const res = await remoteJsonRequest(resolved.host, path, {
      method: "POST",
      body: forwardBody,
      timeoutMs: QUEUE_FORWARD_TIMEOUT_MS,
      fetchImpl,
      headers: c.req.header(ORIGIN_UNKNOWN_HEADER) === "true" ? { [ORIGIN_UNKNOWN_HEADER]: "true" } : undefined,
    });
    if (res.ok) {
      // origin daemon 的结构化响应，逐字——它的行是 record；不做乐观本地
      // 重塑形，不写本地。
      return { ok: true, payload: res.payload, status: res.status ?? 200 };
    }
    switch (res.kind) {
      case "bearer":
        return fail(res.detail, "auth-failed");
      case "timeout":
        return fail(
          res.phase === "body"
            ? `远程队列写超时：响应头已到（HTTP ${res.status}）但 body 一直未完成`
            : `远程队列写在 ${QUEUE_FORWARD_TIMEOUT_MS}ms 后超时`,
          "unreachable",
          res.status,
        );
      case "network":
        return fail(res.detail, "unreachable");
      case "http":
        // origin 拒绝了（自己的 validation/auth/conflict）——它的结构化错误
        // 透传；绝不伪造成功。
        return fail(
          res.detail || `HTTP ${res.status}`,
          res.status === 401 || res.status === 403 ? "auth-failed" : "remote-error",
          res.status,
        );
    }
  }

  /**
   * OPR.0.4.6.MH3 FR-4 (C2)：跨 host HANDOFF 编排——/handoff（source 关闭为
   * `handed-off`）与 /handoff-and-complete（source 关闭为 `done`）共享；
   * 唯一区别是终态。
   *
   * 本地原子 close+create 不能跨两个 DB，因此边界用 arch 规则的 Q-c 顺序
   * 消息传递桥接：
   *
   *   (1) 读本地 source 行 + pre-flight re-drive 状态——已朝不同
   *       closure_target 关闭的 source 在任何 forward 前冲突
   *       （绝不为无法完成的 re-drive 在 target host 制造孤儿）；
   *   (2) 派生 successor id（D-1——同 source+destination+host → 同 id，无状态）
   *       并构建 successor-create body：本地 handoff 的继承规则
   *       （body/priority/tier/tags 来自 input ?? source），
   *       `chainOfRecord = [...source.chain, source.id]`（target 上的不透明
   *       lineage id——arch R2b），D-4 provenance tags，转发的 `nudge` 标志；
   *   (3) 先通过唯一 forwardQueueWrite 助手 forward successor-create——
   *       forward 失败返回结构化 host 命名错误，source 不动
   *       （never-drop：potato 保持 live）；re-driven forward 在 target 的 PK 上
   *       absorb（Q-a + D-1）；
   *   (4) 第二步用有界 repo 方法关闭本地 source——
   *       `closure_target` = host 限定的 successor `<qitem-id>@<host>`，
   *       `handed_off_to` = 两段式 session（BR-1）；已关闭且 target 匹配的
   *       source 幂等 absorb。
   *
   * 注意（已披露）：target 侧 successor 通过 `chain_of_record` + provenance tags
   * 携带 lineage；仅本地的 `handed_off_from` 列不是 create body 的一部分，在
   * target 上保持 NULL——这是 R2b 的不透明 lineage 契约，不是缺口。
   */
  async function crossHostHandoff(
    c: {
      get: (key: string) => unknown;
      json: (body: unknown, status?: number) => Response;
      req: { header: (name: string) => string | undefined };
    },
    qitemId: string,
    hostId: string,
    terminalState: "handed-off" | "done",
    body: {
      fromSession: string;
      toSession: string;
      body?: string;
      transitionNote?: string;
      priority?: QueuePriority;
      tier?: string;
      tags?: string[];
      targetRepo?: string;
      summary?: string | null;
      evidenceRef?: string | null;
      nudge?: boolean;
    },
  ): Promise<Response> {
    const repo = getRepo(c);
    const source = repo.getById(qitemId);
    if (!source) return c.json({ error: "qitem_not_found", message: `未找到 qitem ${qitemId}` }, 404);

    // 确定性 successor 身份也是本地 custody key。必须在 re-drive preflight 前
    // 派生，使比较器和最终 close 使用同一 host 限定 target。已终态的 pre-convention
    // 行在 re-drive 时保留其存储的 member@rig@host key；新 key 是前瞻性的，
    // 历史 custody 绝不重写。
    const successorId = deriveCrossHostSuccessorId(source.qitemId, body.toSession, hostId);
    const closureTarget = `${successorId}@${hostId}`;
    const legacyClosureTarget = `${body.toSession}@${hostId}`;
    const sourceTerminal = source.state === "done" || source.state === "handed-off";
    const closeTarget = sourceTerminal && source.closureTarget === legacyClosureTarget
      ? legacyClosureTarget
      : closureTarget;

    // (1) 在任何 forward 前 pre-flight re-drive 状态。
    if (sourceTerminal && source.closureTarget !== closeTarget) {
      return c.json(
        {
          error: "cross_host_close_conflict",
          message: `qitem ${qitemId} 已朝 ${source.closureTarget ?? "<无 closure_target>"} 关闭——本次 re-drive 命名为 ${closureTarget}；呈现冲突，绝不覆盖`,
          existingClosureTarget: source.closureTarget,
          attemptedClosureTarget: closureTarget,
        },
        409,
      );
    }

    // (2) 确定性 successor 身份 + 转发 body。
    const effectiveTags = body.tags ?? source.tags ?? undefined;
    const forwardBody: Record<string, unknown> = {
      qitemId: successorId,
      // 51-09 incr 4a——stamp-at-FORWARD：本转发 daemon 就是 origin，因此在
      // 转发前把自己的 self-id 盖到 sender identity 上（remote create() 的
      // not-bare 守卫随后保留它——origin 绝不伪造）。
      sourceSession: c.req.header(ORIGIN_UNKNOWN_HEADER) === "true" ? body.fromSession : stampSelfHostSuffix(body.fromSession),
      destinationSession: body.toSession,
      body: body.body ?? source.body,
      priority: body.priority ?? source.priority,
      ...(body.tier ?? source.tier ? { tier: body.tier ?? source.tier } : {}),
      tags: crossHostProvenanceTags(effectiveTags),
      chainOfRecord: [...(source.chainOfRecord ?? []), source.qitemId],
      ...(body.targetRepo !== undefined
        ? { targetRepo: body.targetRepo }
        : source.targetRepo
          ? { targetRepo: source.targetRepo }
          : {}),
      ...(body.summary !== undefined ? { summary: body.summary } : {}),
      ...(body.evidenceRef !== undefined ? { evidenceRef: body.evidenceRef } : {}),
      ...(body.nudge !== undefined ? { nudge: body.nudge } : {}),
    };

    // (3) 先 successor-create——origin 拥有 record；失败让 source 不动
    // （never-drop）。
    const fwd = await forwardQueueWrite(c, hostId, "/api/queue/create", forwardBody);
    if (!fwd.ok) return fwd.response;

    // (4) 第二步 source-close（幂等 absorb / 结构化冲突）。
    let closed: { item: QueueItem; absorbed: boolean };
    try {
      closed = repo.closeCrossHostHandoffSource({
        qitemId: source.qitemId,
        fromSession: body.fromSession,
        toSession: body.toSession,
        closureTarget: closeTarget,
        terminalState,
        transitionNote: body.transitionNote,
      });
    } catch (err) {
      return errorResponse(c, err);
    }

    // 与本地事务性 handoff 相同的 {closed, created} 形状；`created` 是
    // origin daemon 的行，逐字。
    return c.json({ closed: closed.item, created: fwd.payload }, 201);
  }

  // POST /create
  app.post("/create", async (c) => {
    const body = await c.req.json<{
      qitemId?: string;
      sourceSession?: string;
      destinationSession?: string;
      body?: string;
      priority?: QueuePriority;
      tier?: string;
      tags?: string[];
      expiresAt?: string;
      chainOfRecord?: string[];
      targetRepo?: string;
      humanIntent?: "decision" | "update" | null;
      humanDetail?: string | null;
      summary?: string | null;
      evidenceRef?: string | null;
      nudge?: boolean;
      // OPR.0.4.6.MH3 FR-1：带外 host envelope（BR-1——session 字符串保持
      // member@rig；host 绝不在字符串内）。缺省 / "" / "local" = 今天的本地路径，
      // 字节一致。
      hostId?: string;
    }>().catch(() => ({} as never));

    // P21 I3——source 是 transport 派生的 sender（X-OpenRig-Session），绝不取 body claim。
    // P18 deliver-and-label：缺 header + 有 body sourceSession → 记录为 claimed 时代戳
    // claimed:v1；缺 header + 无 body → 400 actor_required；body sourceSession 与 header
    // 不同 → 线上值覆盖它（transport:v1），不是 409。下面的 `sourceSession` 是权威。
    const identity = requireSenderIdentity(c, { verb: "queue create", bodyClaim: body.sourceSession });
    if (!identity.ok) return identity.response;
    const sourceSession = identity.session;
    if (!body.destinationSession) return c.json({ error: "destinationSession 为必填项" }, 400);
    if (!body.body) return c.json({ error: "body 为必填项" }, 400);

    // OPR.0.4.6.MH3 FR-2 (C1)：跨 host CREATE。注册的远程 host id 把写转发到该 host
    // 的 daemon；qitem 存在 origin host 的 DB（origin 拥有 record），它自己的
    // maybeNudge 在本地 tmux 触发（FR-3——转发整个 body 含 nudge）。投递是
    // at-least-once + 幂等：转发 daemon 在首次 forward 前 mint qitemId（Q-a），
    // 使每次重试携带同一 id。跨 host 路径绝不写本地行。
    // PL-007：按源工作组的 workspace.repos[] 校验 target_repo。
    // GUARD FIXBACK（OPR.0.4.6.MH3 对 86ba8b42 的评审，Finding 1）：这在跨 host
    // 分支前运行——校验权威是 SOURCE 工作组的类型化 workspace，住在本 host；
    // target daemon 不认识源工作组时放行，所以 post-forward 检查无法恢复它。
    // 本地顺序不变（无 hostId 时跨 host 分支是 no-op）。
    if (body.targetRepo) {
      const validation = validateTargetRepo(c, sourceSession, body.targetRepo);
      if (!validation.ok) return c.json({ error: validation.error, message: validation.message, ...(validation.meta ?? {}) }, 400);
    }

    if (typeof body.hostId === "string" && body.hostId !== "" && body.hostId !== LOCAL_HOST_ID) {
      const mintedId = body.qitemId ?? newQitemId();
      const { hostId: _dropped, ...rest } = body;
      const forwardBody: Record<string, unknown> = {
        ...rest,
        qitemId: mintedId,
        // 51-09 incr 4a——stamp-at-FORWARD：本转发 daemon 就是 origin，因此在
        // remote create() 运行前盖自己的 self-id（覆盖裸 spread）——否则 remote 会
        // 伪造 member@rig@RECEIVER。
        sourceSession: c.req.header(ORIGIN_UNKNOWN_HEADER) === "true" ? sourceSession : stampSelfHostSuffix(sourceSession),
        tags: crossHostProvenanceTags(body.tags),
      };
      const fwd = await forwardQueueWrite(c, body.hostId, "/api/queue/create", forwardBody);
      return fwd.ok ? c.json(fwd.payload as Record<string, unknown>, fwd.status as 200) : fwd.response;
    }

    try {
      const item = await getRepo(c).create({
        qitemId: body.qitemId,
        sourceSession,
        destinationSession: body.destinationSession,
        body: body.body,
        priority: body.priority,
        tier: body.tier,
        tags: body.tags,
        expiresAt: body.expiresAt,
        chainOfRecord: body.chainOfRecord,
        targetRepo: body.targetRepo,
        humanIntent: body.humanIntent,
        humanDetail: body.humanDetail,
        summary: body.summary,
        evidenceRef: body.evidenceRef,
        nudge: (body as { nudge?: boolean }).nudge,
        identityProvenance: resolveRecordedProvenance(c, identity), // P21 §4 era-stamp: transport:v1 if the header proved it here, else claimed:v1 (resolveRecordedProvenance degrades)
      });
      return c.json(item, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /:qitemId/claim
  app.post("/:qitemId/claim", async (c) => {
    const qitemId = c.req.param("qitemId");
    const body = await c.req.json<{ destinationSession?: string }>().catch(() => ({} as never));
    // P21 I3：claimant 是 transport 派生的 sender，绝不取 body.destinationSession。
    const identity = requireSenderIdentity(c, { verb: "queue claim", bodyClaim: body.destinationSession });
    if (!identity.ok) return identity.response;
    const destinationSession = identity.session;
    try {
      const item = getRepo(c).claim({ qitemId, destinationSession, identityProvenance: resolveRecordedProvenance(c, identity) });
      return c.json(item);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /:qitemId/unclaim
  app.post("/:qitemId/unclaim", async (c) => {
    const qitemId = c.req.param("qitemId");
    const body = await c.req.json<{ destinationSession?: string; reason?: string }>().catch(() => ({} as never));
    // P21 I3：claimant 是 transport 派生的 sender，绝不取 body.destinationSession。
    const identity = requireSenderIdentity(c, { verb: "queue unclaim", bodyClaim: body.destinationSession });
    if (!identity.ok) return identity.response;
    const destinationSession = identity.session;
    try {
      const item = getRepo(c).unclaim(qitemId, destinationSession, body.reason ?? "manual", resolveRecordedProvenance(c, identity));
      return c.json(item);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /:qitemId/update——通用状态变更器（含 done）。
  //
  // OPR.0.3.2.21.FR-4(d-docs)——关闭 ≠ 接受。
  //
  // `state=done` 带 `closure_reason=handed_off_to` 记录源席位已把工作
  // 投递给下一阶段。它不记录下一阶段已接受工作——那是下一阶段对自己
  // qitem 的裁决（通常是带自己 closure_reason 的单独 close）。
  //
  // 关闭词汇：
  //   - handed_off_to    已投递到下一阶段；接受等待该阶段对自己 qitem 的裁决
  //   - blocked_on       等待具名阻塞者（closureTarget）
  //   - denied           源席位拒绝该工作
  //   - canceled         工作不再需要（无 follow-on）
  //   - no-follow-on     就地完成；无进一步路由
  //   - escalation       路由到更高权限席位
  //
  // "accepted" 状态在 v0.3.x 不是队列状态——qitem 模型捕获投递，接收阶段
  // 作为单独事务拥有接受。（新增独立 "accepted" 状态的 FR-4d-state schema
  // 变更推迟到 release-0.3.3。）
  app.post("/:qitemId/update", async (c) => {
    const qitemId = c.req.param("qitemId");
    const body = await c.req.json<{
      actorSession?: string;
      state?: QueueState;
      reopen?: boolean;
      transitionNote?: string;
      closureReason?: string;
      closureTarget?: string;
      blockedOn?: string;
      wakeWatchdogId?: string;
      wakeAfterSeconds?: number;
      summary?: string | null;
      evidenceRef?: string | null;
    }>().catch(() => ({} as never));
    // P21 I3——actor 是 transport 派生的 sender（X-OpenRig-Session），绝不取 body claim。
    // P18 deliver-and-label：缺 header + 有 body actor → claimed:v1；缺 + 无 body → 400
    // actor_required；body actorSession 不同 → 线上值覆盖它（transport:v1），不是 409；
    // 相同 body claim 是 no-op。
    const identity = requireSenderIdentity(c, { verb: "queue update", bodyClaim: body.actorSession });
    if (!identity.ok) return identity.response;
    const actorSession = identity.session;

    try {
      const item = getRepo(c).update({
        qitemId,
        actorSession,
        state: body.state,
        reopen: body.reopen,
        transitionNote: body.transitionNote,
        closureReason: body.closureReason,
        closureTarget: body.closureTarget,
        // OPR.0.4.4.19 FR-6——leg-1 park 面：blockedOn 加上 park 时的
        // summary/evidence_ref 持久化输入。
        blockedOn: body.blockedOn,
        wakeWatchdogId: body.wakeWatchdogId,
        wakeAfterSeconds: body.wakeAfterSeconds,
        summary: body.summary,
        evidenceRef: body.evidenceRef,
        identityProvenance: resolveRecordedProvenance(c, identity), // P21 §4 era-stamp: transport:v1 if the header proved it here, else claimed:v1 (resolveRecordedProvenance degrades)
      });
      return c.json(item);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /:qitemId/handoff——事务性 close+create（本地）；当注册 hostId 被
  // 封装时跨 host 消息传递编排（OPR.0.4.6.MH3 FR-4, C2）。
  app.post("/:qitemId/handoff", async (c) => {
    const qitemId = c.req.param("qitemId");
    const body = await c.req.json<{
      fromSession?: string;
      toSession?: string;
      body?: string;
      transitionNote?: string;
      priority?: QueuePriority;
      tier?: string;
      tags?: string[];
      targetRepo?: string;
      summary?: string | null;
      evidenceRef?: string | null;
      nudge?: boolean;
      // OPR.0.4.6.MH3 FR-1：带外 host envelope（BR-1）。缺省 / "" / "local" =
      // 今天的本地事务路径，字节一致。
      hostId?: string;
    }>().catch(() => ({} as never));
    // P21 I3：handoff actor 是 transport header，绝不取 body.fromSession。
    const identity = requireSenderIdentity(c, { verb: "queue handoff", bodyClaim: body.fromSession });
    if (!identity.ok) return identity.response;
    const fromSession = identity.session;
    if (!body.toSession) return c.json({ error: "toSession 为必填项" }, 400);

    // PL-007——GUARD FIXBACK (Finding 1)：显式 targetRepo 在跨 host 分支前按
    // SOURCE host 权威校验（见 create 路由注释）。继承的 source.targetRepo
    // （无 override）不重新校验——它已在 source 行被接受。
    if (body.targetRepo) {
      const validation = validateTargetRepo(c, fromSession, body.targetRepo);
      if (!validation.ok) return c.json({ error: validation.error, message: validation.message, ...(validation.meta ?? {}) }, 400);
    }

    if (typeof body.hostId === "string" && body.hostId !== "" && body.hostId !== LOCAL_HOST_ID) {
      return crossHostHandoff(c, qitemId, body.hostId, "handed-off", {
        fromSession,
        toSession: body.toSession,
        body: body.body,
        transitionNote: body.transitionNote,
        priority: body.priority,
        tier: body.tier,
        tags: body.tags,
        targetRepo: body.targetRepo,
        summary: body.summary,
        evidenceRef: body.evidenceRef,
        nudge: body.nudge,
      });
    }

    try {
      const result = await getRepo(c).handoff({
        qitemId,
        fromSession,
        toSession: body.toSession,
        body: body.body,
        transitionNote: body.transitionNote,
        priority: body.priority,
        tier: body.tier,
        tags: body.tags,
        targetRepo: body.targetRepo,
        summary: body.summary,
        evidenceRef: body.evidenceRef,
        nudge: (body as { nudge?: boolean }).nudge,
        identityProvenance: resolveRecordedProvenance(c, identity), // P21 §4 era-stamp: transport:v1 if the header proved it here, else claimed:v1 (resolveRecordedProvenance degrades)
      });
      return c.json(result, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /:qitemId/handoff-and-complete——handoff 的变体，把 source 关闭为
  // `done`（终态）而非 `handed-off`（中间态）。相同原子 close+create +
  // chain_of_record + default-nudge 契约。跨 host：相同 C2 编排，终态为 `done`。
  app.post("/:qitemId/handoff-and-complete", async (c) => {
    const qitemId = c.req.param("qitemId");
    const body = await c.req.json<{
      fromSession?: string;
      toSession?: string;
      body?: string;
      transitionNote?: string;
      priority?: QueuePriority;
      tier?: string;
      tags?: string[];
      nudge?: boolean;
      targetRepo?: string;
      summary?: string | null;
      evidenceRef?: string | null;
      // OPR.0.4.6.MH3 FR-1：带外 host envelope（BR-1）。
      hostId?: string;
    }>().catch(() => ({} as never));
    // P21 I3：handoff-and-complete actor 是 transport header，绝不取 body.fromSession。
    const identity = requireSenderIdentity(c, { verb: "queue handoff-and-complete", bodyClaim: body.fromSession });
    if (!identity.ok) return identity.response;
    const fromSession = identity.session;
    if (!body.toSession) return c.json({ error: "toSession 为必填项" }, 400);

    // PL-007——GUARD FIXBACK (Finding 1)：与 handoff 相同的 source-host 权威
    // 顺序——显式 targetRepo 在跨 host 分支前校验。
    if (body.targetRepo) {
      const validation = validateTargetRepo(c, fromSession, body.targetRepo);
      if (!validation.ok) return c.json({ error: validation.error, message: validation.message, ...(validation.meta ?? {}) }, 400);
    }

    if (typeof body.hostId === "string" && body.hostId !== "" && body.hostId !== LOCAL_HOST_ID) {
      return crossHostHandoff(c, qitemId, body.hostId, "done", {
        fromSession,
        toSession: body.toSession,
        body: body.body,
        transitionNote: body.transitionNote,
        priority: body.priority,
        tier: body.tier,
        tags: body.tags,
        targetRepo: body.targetRepo,
        summary: body.summary,
        evidenceRef: body.evidenceRef,
        nudge: body.nudge,
      });
    }

    try {
      const result = await getRepo(c).handoffAndComplete({
        qitemId,
        fromSession,
        toSession: body.toSession,
        body: body.body,
        transitionNote: body.transitionNote,
        priority: body.priority,
        tier: body.tier,
        tags: body.tags,
        targetRepo: body.targetRepo,
        summary: body.summary,
        evidenceRef: body.evidenceRef,
        nudge: body.nudge,
        identityProvenance: resolveRecordedProvenance(c, identity), // P21 §4 era-stamp: transport:v1 if the header proved it here, else claimed:v1 (resolveRecordedProvenance degrades)
      });
      return c.json(result, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /:qitemId/fallback
  app.post("/:qitemId/fallback", async (c) => {
    const qitemId = c.req.param("qitemId");
    const body = await c.req.json<{ fallbackDestination?: string; reason?: string }>().catch(() => ({} as never));
    if (!body.fallbackDestination) return c.json({ error: "fallbackDestination 为必填项" }, 400);
    try {
      const item = getRepo(c).routeToFallback(qitemId, body.fallbackDestination, body.reason ?? "manual");
      return c.json(item);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // GET /whoami——从 daemon 视角看调用方的队列位置。必须在 /:qitemId 前注册，
  // 使字面路径胜出。
  app.get("/whoami", (c) => {
    const session = c.req.query("session");
    if (!session) return c.json({ error: "session 为必填项" }, 400);
    const recentLimit = c.req.query("recentLimit")
      ? Number.parseInt(c.req.query("recentLimit")!, 10)
      : undefined;
    const repo = getRepo(c);
    const position = repo.whoami(session, { recentLimit });
    // OPR.0.5.8.14：派生工作节点搭在已回答"daemon 认为我持有什么"的动词上。
    // 与兄弟路由相同的 DI 风格；缺 store 意味着无配置 root，派生把它报告为拒绝
    // 而非猜测。
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    let missionsRoot: string | null = null;
    try {
      const value = store?.resolveOne("workspace.slices_root").value;
      missionsRoot = value ? String(value) : null;
    } catch {
      missionsRoot = null;
    }
    // 刻意不用 position.asDestination.recent：那是有上限、混合态的展示投影，
    // 超过上限的第二个 in-progress 接力棒会不可见，歧义拒绝会退化为自信的错误答案。
    // 派生读无界 in-progress 集合，使其独立于 recentLimit。
    const derived = deriveCurrentWork(repo.listInProgressForDestination(session), missionsRoot);
    return c.json({ ...position, ...derived });
  });

  // GET /list——带过滤器的列表。必须在 /:qitemId 前注册，使字面路径胜出。
  //
  // OPR.0.3.2.20——For You 优先窗口化切片的 `?attention=1` 过滤器。返回 OPEN
  // attention 类 qitem（UI Action-required + Approval 透镜的持久事实源），使这些
  // 面不依赖有损的临时客户端事件 FIFO。类成员匹配 mission-control 读层语义：
  // tier='human-gate' 或唯一契约谓词 isHumanSeatSessionRef
  // （human-seat /^human…@(kernel|host)$/ 或 A2 虚拟域 leg <local>@external）。
  // Open 状态默认为 pending|in-progress|blocked（调用方仍可经 `state=...` 覆盖）。
  // 可与 destinationSession/sourceSession/targetRepo/limit 组合。
  // OPR.0.4.4.15 FR-1——聚合 attention 读：共享 P4 fanout 契约
  // （{items, hosts}）中的一个 payload，本地始终包含，订阅的远程 host 在
  // daemon 侧 fan-out（bearer 绝不出现在浏览器）。按 arch ruling 3 的新兄弟端点——
  // 下面既有的 /list?attention=1 线上保持字节不变（零配置负向 AC 的最强形式）。
  app.get("/attention-aggregate", async (c) => {
    const repo = getRepo(c);
    const store = c.get("settingsStore" as never) as SettingsStore | undefined;
    // 与其他 context 依赖相同的 DI 风格——测试/QA 注入 loader；生产回退到操作员
    // 真实 hosts.yaml 上的共享 S11 reader。
    const registryLoader = (c.get("hostRegistryLoader" as never) as (() => ReturnType<typeof loadHostRegistry>) | undefined) ?? loadHostRegistry;
    const payload = await aggregateAttention({
      // /list attention 路径运行的同一 repo 查询，相同 open 状态默认——调用，
      // 不重复。
      listLocalAttention: () => repo.listAttention({ state: ["pending", "in-progress", "blocked"] }) as unknown as AttentionItem[],
      listSubscriptions: () => (store ? store.listFeedHostSubscriptions() : []),
      loadRegistry: registryLoader,
    });
    return c.json(payload);
  });

  app.get("/human-updates", (c) => {
    const raw = Number(c.req.query("limit") ?? 20);
    if (!Number.isInteger(raw) || raw < 1 || raw > 100) return c.json({ error: "limit 必须是 1 到 100 的整数" }, 400);
    const rows = getRepo(c).listDeliveredHumanUpdates({ limit: raw + 1 });
    return c.json({ items: rows.slice(0, raw), limit: raw, truncated: rows.length > raw });
  });

  app.get("/list", (c) => {
    const destinationSession = c.req.query("destinationSession") || undefined;
    const sourceSession = c.req.query("sourceSession") || undefined;
    const stateRaw = c.req.query("state") || undefined;
    const targetRepo = c.req.query("targetRepo") || undefined;
    const userLimit = c.req.query("limit") ? Number.parseInt(c.req.query("limit")!, 10) : undefined;
    const asSession = c.req.query("as") || undefined;
    const compact = c.req.query("compact") === "1";
    const rig = c.req.query("rig") || undefined;
    const activeOnly = c.req.query("activeOnly") === "1";
    const attention = c.req.query("attention") === "1";

    const state: QueueState[] | undefined = stateRaw
      ? (stateRaw.split(",") as QueueState[])
      : attention
        ? ["pending", "in-progress", "blocked"]
        : undefined;

    if (!attention) {
      const items = getRepo(c).list({
        destinationSession,
        sourceSession,
        state,
        targetRepo,
        limit: userLimit,
        asSession,
        compact,
        rig,
        activeOnly,
      });
      return c.json(items);
    }

    // OPR.0.3.2.20——attention 路径走 QueueRepository.listAttention，它把
    // attention 谓词推入 SQL WHERE 子句，使 LIMIT 在 attention 过滤后应用。
    // 构造上与窗口无关：旧 human-gate 项绝不会被常规 open qitem 驱逐，无论其后
    // 落多少（guard 复验 qitem-20260518190827 BLOCKER 1）。早先 fetch-then-filter
    // 形状（ATTENTION_FETCH_BOUND）已消失——LIMIT 边界只是用户面的，在 SQL 层
    // post-predicate 应用。
    //
    // destinationSession/sourceSession/targetRepo 在 SQL 层与 attention 谓词
    // 可组合（guard 复验 qitem-20260518192210 BLOCKER 1——之前 forward-fix
    // 丢了组合）。带范围 attention 查询（如 attention=1&destinationSession=...）
    // 只返回匹配的 attention 项。
    const items = getRepo(c).listAttention({
      limit: userLimit,
      state,
      destinationSession,
      sourceSession,
      targetRepo,
    });
    // 纵深防御：用 JS 谓词精炼，使 SQL LIKE 超集不会泄漏畸形 destination。
    const filtered = items.filter(isAttentionItem);
    return c.json(filtered);
  });

  // GET /overdue——呈现超过 closure_required_at 的 in-progress qitem。
  // 必须在 /:qitemId 前注册。
  app.get("/overdue", (c) => {
    // Slice 15 (finding 2)：按工作组范围 + 有界 + 默认 compact，镜像 /list——
    // 使 `zrig queue overdue` 不再 dump 每个工作组的完整 body。
    const q = c.req.query();
    const rig = q.rig || undefined;
    const limitRaw = q.limit !== undefined ? Number.parseInt(q.limit, 10) : undefined;
    const limit = limitRaw !== undefined && Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
    const compact = q.compact === "1" || q.compact === "true";
    const items = getRepo(c).findOverdue({ rig, limit, compact });
    return c.json(items);
  });

  // GET /undelivered——呈现 pending create-path nudge 失败加上 gateway 投递 ledger
  // 失败或从未 post 的 active human-notification 事件。按工作组范围 + 有界 +
  // 默认 compact，镜像 /overdue。必须在 /:qitemId 前注册。只读（无 retry——
  // DR-2 由 PM 基于该面的测量把关）。
  app.get("/undelivered", (c) => {
    const q = c.req.query();
    const rig = q.rig || undefined;
    const limitRaw = q.limit !== undefined ? Number.parseInt(q.limit, 10) : undefined;
    const limit = limitRaw !== undefined && Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
    const compact = q.compact === "1" || q.compact === "true";
    const items = getRepo(c).findUndelivered({ rig, limit, compact });
    // 0.5.1-54 分类器 fold（PM 裁决）：给每条 strand 标 transient vs permanent-topology，
    // 使计数可行动——permanent-topology（本 daemon 上 destination 不可解析）路由到
    // addressing 族，不 retry；transient 是未来 DR-2（held n=1）唯一会碰的类。
    // OPR.0.5.6.14——repo 派生出 LEDGER 类时（transport-failed / never-posted）它胜出；
    // nudge-literal regex 只分类 legacy pane-bound strands。
    const classified = items.map((it) => ({ ...it, deliveryFailureClass: it.deliveryFailureClass ?? classifyNudgeFailure(it.lastNudgeResult) }));
    return c.json(classified);
  });

  // GET /recent-transitions——在类型化队列 state/closure 事实上的一条有界、只读
  // 拓扑时间线。`scope=instance` 一次读跨本地工作组；工作组查询保持向后兼容。
  // 必须在 /:qitemId 前注册。
  app.get("/recent-transitions", (c) => {
    const scopeKind = c.req.query("scope")?.trim();
    const rig = c.req.query("rig")?.trim();
    if (scopeKind && scopeKind !== "instance" && scopeKind !== "rig") {
      return c.json({ error: "invalid_scope", message: "scope 必须是 instance 或 rig" }, 400);
    }
    if (scopeKind !== "instance" && !rig) {
      return c.json({ error: "rig_required", message: "rig RECENT 读取需要 rig" }, 400);
    }
    const raw = c.req.query("limit");
    const parsed = raw == null ? 20 : Number.parseInt(raw, 10);
    const limit = Number.isInteger(parsed) && parsed > 0 ? parsed : 20;
    const scope = scopeKind === "instance"
      ? { kind: "instance" } as const
      : { kind: "rig", rig: rig! } as const;
    return c.json(getRepo(c).listRecentTransitions(scope, limit));
  });

  // ---- 协调事件的 SSE watch ----
  // 必须在 /:qitemId 前注册，使字面 `watch` 和 `sse` 路径胜过裸参数路由
  // （否则 GET /api/queue/sse 解析为 /:qitemId 且 qitemId="sse"，返回 404
  // qitem_not_found）。同时挂在 /watch（legacy 别名）和 /sse（按 IMPL 的 Phase A
  // 契约）。同一 handler；任一路径发出相同事件流。
  const sseHandler = (c: Parameters<typeof streamSSE>[0]) => {
    const eventBus = getEventBus(c);
    return streamSSE(c, async (stream) => {
      const unsubscribe = eventBus.subscribe((event) => {
        if (
          event.type !== "queue.created" &&
          event.type !== "queue.handed_off" &&
          event.type !== "queue.claimed" &&
          event.type !== "queue.unclaimed" &&
          event.type !== "qitem.fallback_routed" &&
          event.type !== "qitem.closure_overdue" &&
          event.type !== "inbox.absorbed" &&
          event.type !== "inbox.denied"
        ) return;
        const sse = { id: String(event.seq), data: JSON.stringify(event) };
        stream.writeSSE(sse).catch(() => {});
      });

      try {
        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve());
        });
      } finally {
        unsubscribe();
      }
    });
  };

  app.get("/watch", sseHandler);
  app.get("/sse", sseHandler);

  // GET /:qitemId/transitions——在 /:qitemId 前注册，使字面前缀胜过裸参数路由。
  app.get("/:qitemId/transitions", (c) => {
    const qitemId = c.req.param("qitemId");
    const repo = getRepo(c);
    if (!repo.getById(qitemId)) return c.json({ error: "qitem_not_found" }, 404);
    return c.json(repo.listTransitions(qitemId));
  });

  // GET /:qitemId——显示单项。
  app.get("/:qitemId", (c) => {
    const qitemId = c.req.param("qitemId");
    const item = getRepo(c).getById(qitemId);
    if (!item) return c.json({ error: "qitem_not_found" }, 404);
    return c.json(item);
  });

  // ---- 收件箱路由 ----

  app.post("/inbox/drop", async (c) => {
    // P18 sender provenance：sender 从认证 transport header 派生（CLI 从席位 env
    // 盖一次），绝不取自请求 body。senderSession/authenticatedSender 刻意不从 body
    // 读——body 提供的身份在记录通道（inbox_entries.sender_session → absorb →
    // 接收方队列）中是可伪造的假历史。
    const body = await c.req.json<{
      inboxId?: string;
      destinationSession?: string;
      body?: string;
      tags?: string[];
      urgency?: string;
      auditPointer?: string;
    }>().catch(() => ({} as never));
    // P18 SWEEP（actor-to-label 测试）：sender 从 transport header 派生，绝不取 body——
    // body 提供的身份是可伪造的假历史。不读 body claim，所以无 header 时根本没有
    // actor 可标 → 400 actor_required（参数完整性，queue.ts:215 类），不是已废弃的
    // 401 拒绝不可认证 sender。收敛到 resolveActorWithDeferral 对 nothing-to-record
    // 已用的形状。
    const identity = requireSenderIdentity(c, { verb: "inbox drop" });
    if (!identity.ok) return identity.response;
    const senderSession = identity.session; // transport-derived, authoritative
    if (!body.destinationSession) return c.json({ error: "destinationSession 为必填项" }, 400);
    if (!body.body) return c.json({ error: "body 为必填项" }, 400);

    try {
      const entry = getInbox(c).drop({
        inboxId: body.inboxId,
        destinationSession: body.destinationSession,
        senderSession, // transport-derived, authoritative
        body: body.body,
        tags: body.tags,
        urgency: body.urgency,
        auditPointer: body.auditPointer,
        identityProvenance: resolveRecordedProvenance(c, identity), // P21 §4 era-stamp: transport:v1 (or relay:v1 on a relayed hop) — no body sender is read, so claimed:v1 cannot arise here
      });
      return c.json(entry, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/inbox/:inboxId/absorb", async (c) => {
    const inboxId = c.req.param("inboxId");
    const body = await c.req.json<{ receiverSession?: string }>().catch(() => ({} as never));
    // P21 I3：receiver 是 transport 派生的 sender，绝不取 body.receiverSession。
    const identity = requireSenderIdentity(c, { verb: "inbox absorb", bodyClaim: body.receiverSession });
    if (!identity.ok) return identity.response;
    try {
      const result = await getInbox(c).absorb(inboxId, identity.session, resolveRecordedProvenance(c, identity));
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/inbox/:inboxId/deny", async (c) => {
    const inboxId = c.req.param("inboxId");
    const body = await c.req.json<{ receiverSession?: string; reason?: string }>().catch(() => ({} as never));
    // P21 I3：receiver 是 transport 派生的 sender，绝不取 body.receiverSession。
    const identity = requireSenderIdentity(c, { verb: "inbox deny", bodyClaim: body.receiverSession });
    if (!identity.ok) return identity.response;
    if (!body.reason) return c.json({ error: "reason 为必填项" }, 400);
    try {
      const entry = getInbox(c).deny(inboxId, identity.session, body.reason);
      return c.json(entry);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get("/inbox/pending", (c) => {
    const destinationSession = c.req.query("destinationSession");
    if (!destinationSession) return c.json({ error: "destinationSession 为必填项" }, 400);
    return c.json(getInbox(c).listPending(destinationSession));
  });

  app.get("/inbox/list", (c) => {
    const destinationSession = c.req.query("destinationSession");
    if (!destinationSession) return c.json({ error: "destinationSession 为必填项" }, 400);
    const limit = c.req.query("limit") ? Number.parseInt(c.req.query("limit")!, 10) : undefined;
    return c.json(getInbox(c).listForDestination(destinationSession, limit));
  });

  // ---- 发件箱路由 ----

  app.post("/outbox/record", async (c) => {
    const body = await c.req.json<{
      outboxId?: string;
      senderSession?: string;
      destinationSession?: string;
      body?: string;
      tags?: string[];
      urgency?: string;
      auditPointer?: string;
    }>().catch(() => ({} as never));
    // P21 I3：outbox sender 是 transport 派生的身份，绝不取 body.senderSession。
    const identity = requireSenderIdentity(c, { verb: "outbox record", bodyClaim: body.senderSession });
    if (!identity.ok) return identity.response;
    if (!body.destinationSession) return c.json({ error: "destinationSession 为必填项" }, 400);
    if (!body.body) return c.json({ error: "body 为必填项" }, 400);

    const entry = getOutbox(c).record({
      outboxId: body.outboxId,
      senderSession: identity.session,
      destinationSession: body.destinationSession,
      body: body.body,
      tags: body.tags,
      urgency: body.urgency,
      auditPointer: body.auditPointer,
      identityProvenance: resolveRecordedProvenance(c, identity), // P21 §4 era-stamp: transport:v1 if the header proved it here, else claimed:v1 (resolveRecordedProvenance degrades)
    });
    return c.json(entry, 201);
  });

  app.get("/outbox/list", (c) => {
    const senderSession = c.req.query("senderSession");
    if (!senderSession) return c.json({ error: "senderSession 为必填项" }, 400);
    const limit = c.req.query("limit") ? Number.parseInt(c.req.query("limit")!, 10) : undefined;
    return c.json(getOutbox(c).listForSender(senderSession, limit));
  });

  return app;
}
