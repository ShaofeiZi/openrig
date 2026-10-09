import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import type { AgentActivity, PersistedEvent } from "./types.js";

export const AGENT_ACTIVITY_FRESHNESS_MS = 5 * 60 * 1000;

export interface HookActivityInput {
  runtime: string | null;
  sessionName?: string | null;
  nodeId?: string | null;
  hookEvent: string;
  subtype?: string | null;
  occurredAt?: string | null;
  /** W2a-1——发出事件的 occupant generation 随 hook 携带并绑定来源（producer/relay 在触发时
   *  提供，route 负责摄入），绝不从记录时状态推断——那会把延迟到达的前任 occupant hook
   *  错归给当前 occupant。旧版、被排除或没有 tenure 的发出路径缺失该值 ⇒ 记录 null ⇒
   *  读取时为 unresolved（绝不假新鲜）。 */
  generation?: string | null;
}

export type RecordHookActivityResult =
  | { ok: true; activity: AgentActivity; event: PersistedEvent }
  | { ok: false; code: "missing_session_identity" | "session_not_found"; error: string };

interface AgentActivityStoreDeps {
  db: Database.Database;
  eventBus: EventBus;
  now?: () => Date;
  freshnessMs?: number;
  /** W2a-1——解析节点当前 occupant 的 generation（已交付 occupant-tenure generation_uuid），
   *  未知时返回 null。通过注入而非内部构造，使 store 与 SessionRegistry 解耦，并可用 fake
   *  做单元测试。缺失时 store 不应用 generation 门禁——沿用旧版仅按时钟判断新鲜度——因此在
   *  producer 接线注入真实解析器之前，现有调用方保持不变。解析是同步的（better-sqlite3 读取），
   *  所以门禁内联在同步读取路径中，不改动 9 个调用方的签名。 */
  resolveOccupantGeneration?: (nodeId: string) => string | null;
  /** 确认携带的 generation 已为该节点登记。未提交且无副作用的 reservation 必须保持
   *  unresolvable，不能成为肯定的 mismatch 证据。 */
  isRegisteredOccupantGeneration?: (nodeId: string, generation: string) => boolean;
}

interface SessionLookupRow {
  rig_id: string;
  node_id: string;
  session_name: string;
  runtime: string | null;
}

interface EventPayloadRow {
  payload: string;
}

export class AgentActivityStore {
  readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly now: () => Date;
  private readonly freshnessMs: number;
  private readonly resolveOccupantGeneration?: (nodeId: string) => string | null;
  private readonly isRegisteredOccupantGeneration?: (nodeId: string, generation: string) => boolean;

  constructor(deps: AgentActivityStoreDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.now = deps.now ?? (() => new Date());
    this.freshnessMs = deps.freshnessMs ?? AGENT_ACTIVITY_FRESHNESS_MS;
    this.resolveOccupantGeneration = deps.resolveOccupantGeneration;
    this.isRegisteredOccupantGeneration = deps.isRegisteredOccupantGeneration;
  }

  recordHookEvent(input: HookActivityInput): RecordHookActivityResult {
    if (!input.sessionName && !input.nodeId) {
      return {
        ok: false,
        code: "missing_session_identity",
        error: "Hook 活动需要受管的 sessionName 或 nodeId",
      };
    }

    const session = this._resolveSession(input);
    if (!session) {
      return {
        ok: false,
        code: "session_not_found",
        error: "Hook 活动未匹配到受管会话。请运行 zrig ps --nodes 列出席位",
      };
    }

    const sampledAt = this.now().toISOString();
    const eventAt = parseTimestamp(input.occurredAt) ?? sampledAt;
    // W2a-1——绑定来源的标记：发出事件的 occupant generation 随 hook 携带（producer/relay
    // 在触发时提供，由 route 摄入），绝不从记录时状态推断。前任 occupant 的延迟 hook 在新 tenure
    // 生成后才被记录时，仍携带自己的旧 generation，因此读取会检测到不匹配，而不是误归给当前
    // occupant；由于不依赖时间，此逻辑不受 boot_at 精度或时钟偏移影响。旧版、被排除或无 tenure
    // 的发出路径缺失该值 ⇒ null ⇒ 读取时 unresolved（P21 claimed-era 模式：缺失本身被记录为
    // 一种状态，绝不假新鲜）。记录时不调用 resolver——live-gen resolver 只在读取时用于比较。
    const generation = input.generation ?? null;
    const activity = normalizeHookActivity({
      runtime: input.runtime ?? session.runtime,
      hookEvent: input.hookEvent,
      subtype: input.subtype ?? null,
      sampledAt,
      eventAt,
      generation,
    });

    const event = this.eventBus.emit({
      type: "agent.activity",
      rigId: session.rig_id,
      nodeId: session.node_id,
      sessionName: session.session_name,
      runtime: activity.runtime ?? session.runtime,
      activity,
    });

    return { ok: true, activity, event };
  }

  getLatestForNode(input: {
    nodeId?: string | null;
    sessionName?: string | null;
    now?: Date;
  }): AgentActivity | null {
    const nodeId = input.nodeId ?? (input.sessionName ? this._resolveSession({ sessionName: input.sessionName })?.node_id : null);
    if (!nodeId) return null;

    const row = this.db.prepare(
      "SELECT payload FROM events WHERE node_id = ? AND type = 'agent.activity' ORDER BY seq DESC LIMIT 1"
    ).get(nodeId) as EventPayloadRow | undefined;
    if (!row) return null;

    const payload = parseActivityPayload(row.payload);
    if (!payload?.activity) return null;

    const activity = payload.activity;
    if (input.sessionName && payload.sessionName !== input.sessionName) return null;

    const referenceTime = input.now ?? this.now();

    // W2a-1——读取时与已交付 occupant-tenure generation_uuid 比较（PM 于 2026-08-08 裁定的
    // 完整变体 C）：
    //  (1) 携带的 generation 已为此节点登记且不同于当前值 ⇒ MISMATCH：这是认领属于已终止
    //      前任 tenure 的肯定证据 ⇒ unknown + `generation_mismatch`、stale:true、provenance
    //      RESOLVED。未登记的启动前 reservation 是证据缺失，保持 UNRESOLVABLE，绝非 mismatch。
    //  (2) 两者均已知且相同（包括相同原生会话的重新启动——台账将其视为延续，不产生新
    //      generation）⇒ provenance RESOLVED，正常投递（fresh）。
    //  (3) 任一侧为 null ⇒ UNRESOLVABLE：这是证据缺失，而非前任 tenure 判定。状态 UNKNOWN +
    //      独立 reason、stale:true——绝不 fresh（fresh 是该席位尚未赢得的肯定存活声明；将 null
    //      tenure 标为 fresh 会越过裸归因边界）。STORE 在 ACTIVITY 层交付带
    //      generationProvenance='unresolved' 的行。让此标签成为仍流向消费者的行，需要修改 tap
    //      的丢弃条件，属于后续项（qitem-20260808183747-f7f04662，verify-demotion），不属于本次
    //      fold；过渡期内未变的 tap 仍会丢弃它（这是暴露于 mint-race 瞬间的有界回归；mm2 在
    //      0.5.1 前没有 occupant_tenures 表，不受影响）。未知与证据必须得到不同判定，不能合并。
    // 仅在注入 resolver 时运行门禁（否则沿用仅按时钟判断、无标签的旧行为）。
    let generationProvenance: "resolved" | "unresolved" | undefined;
    if (this.resolveOccupantGeneration) {
      let liveGeneration: string | null;
      try {
        liveGeneration = this.resolveOccupantGeneration(nodeId);
      } catch {
        // Resolver 异常（例如瞬时台账/数据库故障）⇒ 降级到独立 unknown 分支：
        // 读取绝不崩溃，也绝不渲染为 fresh。与正常 null（unresolvable）区分。
        return this.generationDegraded(activity, referenceTime);
      }
      const recordedGeneration = activity.generation ?? null;
      if (liveGeneration !== null && recordedGeneration !== null) {
        if (this.isRegisteredOccupantGeneration) {
          let registered: boolean;
          try {
            registered = this.isRegisteredOccupantGeneration(nodeId, recordedGeneration);
          } catch {
            return this.generationDegraded(activity, referenceTime);
          }
          if (!registered) {
            return this.generationUnresolved(activity, referenceTime, "generation_unresolvable");
          }
        }
        if (recordedGeneration !== liveGeneration) {
          return this.generationMismatch(activity, referenceTime);
        }
        generationProvenance = "resolved";
      } else {
        return this.generationUnresolved(
          activity,
          referenceTime,
          liveGeneration === null ? "generation_unresolvable" : "generation_unverifiable",
        );
      }
    }

    const eventTime = activity.eventAt ? Date.parse(activity.eventAt) : NaN;
    if (Number.isFinite(eventTime) && referenceTime.getTime() - eventTime > this.freshnessMs) {
      return {
        ...activity,
        state: "unknown",
        reason: "stale_runtime_hook",
        evidenceSource: "runtime_hook",
        sampledAt: referenceTime.toISOString(),
        fallback: false,
        stale: true,
        generationProvenance,
      };
    }

    return {
      ...activity,
      sampledAt: referenceTime.toISOString(),
      fallback: false,
      stale: false,
      generationProvenance,
    };
  }

  /** W2a-1——已终止 tenure 判定：认领的 occupant generation 已为此节点登记，且与当前
   *  generation 不同。成员门禁先于此辅助函数运行，所以未提交的 reservation 绝不能伪造
   *  肯定的已终止 tenure 结论。不得把它当成当前席位。返回 unknown +
   *  `generation_mismatch`、stale:true（触发检测）、provenance `resolved`（两个 generation
   *  均已解析，只是不同）。这是唯一会放弃投递的 generation 情况；任一侧为 null 都属于
   *  UNRESOLVED provenance，并带标签交付，绝不进入此路径。 */
  private generationMismatch(activity: AgentActivity, referenceTime: Date): AgentActivity {
    return {
      ...activity,
      state: "unknown",
      reason: "generation_mismatch",
      generationProvenance: "resolved",
      evidenceSource: "runtime_hook",
      sampledAt: referenceTime.toISOString(),
      fallback: false,
      stale: true,
    };
  }

  /** W2a-1——UNRESOLVABLE provenance 判定（缺乏证据，而非已终止 tenure 结论）。状态为
   *  UNKNOWN + 独立 reason + stale:true，使消费者不会将其读作已验证存活（fresh 是肯定的存活
   *  声明）。STORE 在 ACTIVITY 层交付带 generationProvenance:"unresolved" 的行；把此标签改为
   *  仍可流向消费者的行属于 tap 的后续项（verify-demotion，qitem-20260808183747-f7f04662）。
   *  过渡期内未变的 tap 仍会丢弃它（有界回归，仅暴露于 mint-race 瞬间；mm2 在 0.5.1 前
   *  没有 occupant_tenures 表）。它与 generationMismatch 保持区分：未知和证据得到不同判定，
   *  在当前 store 以及后续 tap 中都不能合并。 */
  private generationUnresolved(
    activity: AgentActivity,
    referenceTime: Date,
    reason: "generation_unresolvable" | "generation_unverifiable",
  ): AgentActivity {
    return {
      ...activity,
      state: "unknown",
      reason,
      generationProvenance: "unresolved",
      evidenceSource: "runtime_hook",
      sampledAt: referenceTime.toISOString(),
      fallback: false,
      stale: true,
    };
  }

  /** W2a-1——resolver 异常判定：live-generation resolver 抛错（瞬时台账/数据库故障）。
   *  降级为 unknown + 独立 reason（`generation_resolver_error`）+ stale:true，使读取不崩溃且
   *  认领绝不渲染为 fresh；provenance 为 `unresolved`。与正常 null（unresolvable）分开，
   *  从而区分 resolver 故障与真实缺失。 */
  private generationDegraded(activity: AgentActivity, referenceTime: Date): AgentActivity {
    return {
      ...activity,
      state: "unknown",
      reason: "generation_resolver_error",
      generationProvenance: "unresolved",
      evidenceSource: "runtime_hook",
      sampledAt: referenceTime.toISOString(),
      fallback: false,
      stale: true,
    };
  }

  resolveSession(input: { sessionName?: string | null; nodeId?: string | null; runtime?: string | null }): { sessionId: string; rigId: string; nodeId: string; sessionName: string } | null {
    const row = this._resolveSession(input);
    if (!row) return null;
    const sessionRow = this.db.prepare(
      "SELECT id FROM sessions WHERE session_name = ? ORDER BY id DESC LIMIT 1"
    ).get(row.session_name) as { id: string } | undefined;
    if (!sessionRow) return null;
    return { sessionId: sessionRow.id, rigId: row.rig_id, nodeId: row.node_id, sessionName: row.session_name };
  }

  private _resolveSession(input: { sessionName?: string | null; nodeId?: string | null }): SessionLookupRow | null {
    if (input.nodeId) {
      const row = this.db.prepare(`
        SELECT n.rig_id, n.id AS node_id, s.session_name, n.runtime
        FROM nodes n
        LEFT JOIN sessions s ON s.node_id = n.id
          AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
        WHERE n.id = ?
        LIMIT 1
      `).get(input.nodeId) as SessionLookupRow | undefined;
      if (row?.session_name) return row;
    }

    if (!input.sessionName) return null;
    const row = this.db.prepare(`
      SELECT n.rig_id, n.id AS node_id, s.session_name, n.runtime
      FROM sessions s
      JOIN nodes n ON n.id = s.node_id
      WHERE s.session_name = ?
      ORDER BY s.id DESC
      LIMIT 1
    `).get(input.sessionName) as SessionLookupRow | undefined;
    return row ?? null;
  }
}

function normalizeHookActivity(input: {
  runtime: string | null;
  hookEvent: string;
  subtype: string | null;
  sampledAt: string;
  eventAt: string;
  generation?: string | null;
}): AgentActivity {
  const rawEvent = input.hookEvent;
  const rawSubtype = input.subtype;
  const reason = normalizeReason(rawSubtype ?? rawEvent);
  const runtime = input.runtime;
  let state: AgentActivity["state"] = "unknown";
  let normalizedReason = reason;

  if (rawEvent === "UserPromptSubmit" || rawEvent === "PreToolUse" || rawEvent === "active") {
    state = "running";
  } else if (rawEvent === "PermissionRequest") {
    // OPR.0.4.1.10——Codex 官方批准 hook（openai/codex PR #17563）。PermissionRequest 表示
    // agent 正因等待命令 / 补丁 / 网络批准而阻塞，即 needs_input。这是 Codex 的 hook-primary
    // 信号；Codex 不发出 Claude 风格的 Notification。classifySendReadiness 已能跨 runtime 优先
    // 采用新鲜的 runtime_hook needs_input，因此接入该事件即可让 Codex rig-send guard 在结构上
    // 以 hook 为主（capture-pane 扫描仍是回退）。官方 payload 携带
    // session_id/turn_id/cwd/model/permission_mode/tool_name/tool_input；relay 将 tool_name 转发为
    // subtype，因此 `evidence` 会指出正在审批的工具。
    state = "needs_input";
    normalizedReason = "permission_request";
  } else if (rawEvent === "Notification") {
    if (rawSubtype === "permission_prompt" || rawSubtype === "elicitation_dialog") {
      state = "needs_input";
    } else if (rawSubtype === "idle_prompt") {
      state = "idle";
    } else {
      state = "unknown";
      normalizedReason = rawSubtype ? reason : "notification";
    }
  } else if (rawEvent === "Stop" || rawEvent === "SessionEnd" || rawEvent === "stop" || rawEvent === "idle") {
    state = "idle";
  } else if (rawEvent === "SessionStart") {
    state = "unknown";
    normalizedReason = "session_start_observed";
  } else {
    state = "unknown";
    normalizedReason = "unmapped_runtime_hook";
  }

  return {
    state,
    reason: normalizedReason,
    evidenceSource: "runtime_hook",
    sampledAt: input.sampledAt,
    evidence: rawSubtype ?? rawEvent,
    eventAt: input.eventAt,
    rawEvent,
    rawSubtype,
    runtime,
    fallback: false,
    stale: false,
    generation: input.generation ?? null,
  };
}

function normalizeReason(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function parseTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function parseActivityPayload(payload: string): { sessionName?: string; activity?: AgentActivity } | null {
  try {
    return JSON.parse(payload) as { sessionName?: string; activity?: AgentActivity };
  } catch {
    return null;
  }
}
