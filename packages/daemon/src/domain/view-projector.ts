import type { ProjectRead } from "./workspace/project-read.js";
import type Database from "better-sqlite3";
import { lastMeaningfulTransition } from "./queue-waiting.js";
import { derivePickup } from "./queue-pickup.js";
import { ulid } from "ulid";
import type { EventBus } from "./event-bus.js";
import { buildExecutionView, type ExecutionViewDeps } from "./execution-view.js";

/**
 * View projector（PL-004 Phase B；L5 View——只读 projection）。
 *
 * 按 PRD § L5 + slice IMPL § Guard Checkpoint Focus item 5+6：
 * - 基于 Phase A queue_items + queue_transitions 表提供 6 个 built-in view。
 * - 通过 views_custom 表注册 custom view。
 * - 只读 Phase A + Phase B state；本模块绝不写 queue_items 或 queue_transitions。
 * - 按 PRD § Acceptance Criteria，延迟目标低于 100ms；依靠 Phase A 现有索引实现。
 * - 默认排除 fixture 工作组：名称匹配 `^test-` 或 `^fixture-`；可通过
 *   OPENRIG_VIEW_INCLUDE_FIXTURES=1 选择包含。
 *
 * views_custom 中的 custom view 保存 projector 逐字执行的 SQL 字符串（`definition`）。它由
 * 操作员定义，不强制 taxonomy。
 *
 * 模式镜像 Phase A queue-repository.ts 的 read API 结构。
 */

export const BUILT_IN_VIEW_NAMES = [
  "recently-active",
  "founder",
  "pod-load",
  "escalations",
  "held",
  "activity",
  // S04（OPR.0.5.5.4）——pickup lens：带 DERIVED receipt 的 claimed row。
  "pickup",
  // S27（OPR.0.5.6.27）——execution view：一份回答六个执行问题的派生 JSON 文档；
  // 需要 setExecutionDeps 接线。
  "execution",
] as const;

export type BuiltInViewName = (typeof BUILT_IN_VIEW_NAMES)[number];

export interface ViewQueryResult {
  viewName: string;
  generatedAt: string;
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface CustomView {
  viewId: string;
  viewName: string;
  definition: string;
  registeredBySession: string;
  registeredAt: string;
  lastEvaluatedAt: string | null;
}

interface CustomViewRow {
  view_id: string;
  view_name: string;
  definition: string;
  registered_by_session: string;
  registered_at: string;
  last_evaluated_at: string | null;
}

export class ViewProjectorError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * 通过 session name 后缀 `@<rig>` 检测 fixture 工作组，其中 <rig> 以 `test-` 或
 * `fixture-` 开头。默认用于过滤 view；可通过 OPENRIG_VIEW_INCLUDE_FIXTURES=1 选择包含。
 */
function fixtureExclusionClause(): string {
  if (process.env.OPENRIG_VIEW_INCLUDE_FIXTURES === "1") return "1=1";
  // 排除 source_session 或 destination_session 的工作组名称以 test-/fixture- 开头的 qitem。
  return `(
    destination_session NOT LIKE '%@test-%' AND
    destination_session NOT LIKE '%@fixture-%' AND
    source_session NOT LIKE '%@test-%' AND
    source_session NOT LIKE '%@fixture-%'
  )`;
}

export class ViewProjector {
  readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly now: () => Date;

  constructor(
    db: Database.Database,
    eventBus: EventBus,
    opts?: { now?: () => Date },
  ) {
    this.db = db;
    this.eventBus = eventBus;
    this.now = opts?.now ?? (() => new Date());
  }

  // S27——execution-view 接线。startup 在 slices root 解析后调用一次；测试注入 fixture root
  // 和固定时钟。
  private executionDeps: ExecutionViewDeps | null = null;
  setExecutionDeps(deps: ExecutionViewDeps): void {
    this.executionDeps = deps;
  }

  /**
   * 按名称运行 view。built-in 名称（BUILT_IN_VIEW_NAMES）派发到硬编码 SQL；其他名称派发到
   * custom-view 查询。
   */
  show(viewName: string, opts?: { rig?: string; limit?: number; mission?: string; project?: ProjectRead | null }): ViewQueryResult {
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 1000));
    // S27——execution view 呈文档结构（rows = [一份 JSON 文档]），还需要从本 class SQL 之外的
    // fs/git/build-info 分支派生，因此通过已接线 deps 派发到独立模块。
    if (viewName === "execution") {
      if (!this.executionDeps) {
        throw new ViewProjectorError(
          "view_query_failed",
          "execution view deps are not wired on this daemon (setExecutionDeps was never called)",
        );
      }
      const doc = buildExecutionView(opts?.project ? { ...this.executionDeps, slicesRoot: () => opts.project!.missionsRoot } : this.executionDeps, { mission: opts?.mission, rig: opts?.rig, project: opts?.project?.id });
      return { viewName: "execution", generatedAt: this.now().toISOString(), rows: [doc], rowCount: 1 };
    }
    if ((BUILT_IN_VIEW_NAMES as readonly string[]).includes(viewName)) {
      return this.runBuiltIn(viewName as BuiltInViewName, opts?.rig, limit);
    }
    const custom = this.getCustomView(viewName);
    if (!custom) {
      throw new ViewProjectorError("view_not_found", `view '${viewName}' is not registered (built-in or custom)`);
    }
    return this.runCustom(custom, limit);
  }

  list(): { builtIn: BuiltInViewName[]; custom: CustomView[] } {
    return { builtIn: [...BUILT_IN_VIEW_NAMES], custom: this.listCustomViews() };
  }

  private runBuiltIn(name: BuiltInViewName, rig: string | undefined, limit: number): ViewQueryResult {
    const fixtureClause = fixtureExclusionClause();
    const rigClause = rig ? `AND (destination_session LIKE ? OR source_session LIKE ?)` : "";
    const rigParams: unknown[] = rig ? [`%@${rig}`, `%@${rig}`] : [];

    // S04——pickup lens 通过唯一共享派生规则 derivePickup 做后处理，绝不复制第二份 SQL：
    // claimed live row 按最早 claim 优先，每项携带 pickup_state，stalled 时还携带具名
    // pickup_evidence。
    if (name === "pickup") {
      const rows = this.db
        .prepare(
          `SELECT qitem_id, source_session, destination_session, state, claimed_at, last_heartbeat, ts_updated,
                  (SELECT COUNT(*) FROM queue_transitions t
                     WHERE t.qitem_id = queue_items.qitem_id
                       AND t.ts > queue_items.claimed_at
                       AND t.transition_note IS NOT 'claimed') AS post_claim_motion
             FROM queue_items
            WHERE claimed_at IS NOT NULL
              AND state IN ('in-progress', 'blocked')
              AND ${fixtureClause}
              ${rigClause}
            ORDER BY claimed_at ASC
            LIMIT ?`,
        )
        .all(...rigParams, limit) as Record<string, unknown>[];
      const projected = rows.map((r) => {
        const activity = this.executionDeps?.seatActivity?.getSeatStateBySession(String(r.destination_session));
        const receipt = derivePickup({
          lastMeaningfulAt: lastMeaningfulTransition(this.db, String(r.qitem_id))?.at,
          activity: activity?.activity, needsInput: activity?.needsInput.count,
          state: String(r.state),
          claimedAt: (r.claimed_at as string | null) ?? null,
          lastHeartbeat: (r.last_heartbeat as string | null) ?? null,
          postClaimMotionCount: Number(r.post_claim_motion ?? 0),
        });
        return {
          ...r,
          pickup_state: receipt.state,
          ...(receipt.evidence ? { pickup_evidence: receipt.evidence } : {}),
        };
      });
      return { viewName: name, generatedAt: this.now().toISOString(), rows: projected, rowCount: projected.length };
    }

    let sql: string;
    let params: unknown[] = [];
    switch (name) {
      case "recently-active":
        // qitem 按 ts_updated DESC 排序；只含 live state（pending/in-progress/blocked）。
        sql = `
          SELECT qitem_id, source_session, destination_session, state, priority, tier, ts_updated, body
          FROM queue_items
          WHERE state IN ('pending', 'in-progress', 'blocked')
            AND ${fixtureClause}
            ${rigClause}
          ORDER BY ts_updated DESC
          LIMIT ?
        `;
        params = [...rigParams, limit];
        break;
      case "founder":
        // priority='critical' OR tier='critical' OR tier='fast'。
        sql = `
          SELECT qitem_id, source_session, destination_session, state, priority, tier, ts_updated
          FROM queue_items
          WHERE (priority = 'critical' OR tier IN ('critical', 'fast'))
            AND state IN ('pending', 'in-progress', 'blocked')
            AND ${fixtureClause}
            ${rigClause}
          ORDER BY ts_updated DESC
          LIMIT ?
        `;
        params = [...rigParams, limit];
        break;
      case "pod-load":
        // R1 NOTE 4：PRD § L5 把此 view 称为“逐 pod queue-item 计数”，但 Phase A queue_items
        // 表没有 pod metadata；destination_session 形如 `<member>@<rig>`，且没有 pod_id 列。
        // v0 按 destination_session 分组，即逐席位计数。Phase D workflow runtime 或更晚版本
        // 提供 pod metadata 后，应升级为 GROUP BY pod_id，并以 destination_session 聚合作为
        // 子分组。已记录的 v0 行为保留 view 名称，但缩小 grouping key。
        sql = `
          SELECT destination_session AS pod, COUNT(*) AS active_count
          FROM queue_items
          WHERE state IN ('pending', 'in-progress', 'blocked')
            AND ${fixtureClause}
            ${rigClause}
          GROUP BY destination_session
          ORDER BY active_count DESC
          LIMIT ?
        `;
        params = [...rigParams, limit];
        break;
      case "escalations":
        // closure_reason = 'escalation'，或 OPEN S01 wake-escalation aggregate——操作员 rung 的
        // delivery 下限（AM-R25）。ladder 聚合的 escalation row 在此呈现，使 dead-seat storm
        // 无需人类 sweep 也可见。
        sql = `
          SELECT qitem_id, source_session, destination_session, state, closure_reason, closure_target, ts_updated
          FROM queue_items
          WHERE (closure_reason = 'escalation'
                 OR (state IN ('pending', 'in-progress', 'blocked') AND tags LIKE '%"wake-escalation"%'))
            AND ${fixtureClause}
            ${rigClause}
          ORDER BY ts_updated DESC
          LIMIT ?
        `;
        params = [...rigParams, limit];
        break;
      case "held":
        // state = 'blocked' 或 blocked_on 非 null。
        sql = `
          SELECT qitem_id, source_session, destination_session, state, blocked_on, ts_updated, body
          FROM queue_items
          WHERE (state = 'blocked' OR blocked_on IS NOT NULL)
            AND ${fixtureClause}
            ${rigClause}
          ORDER BY ts_updated DESC
          LIMIT ?
        `;
        params = [...rigParams, limit];
        break;
      case "activity": {
        // recent transition 与 qitem state 连接。fixture clause 必须引用 queue_items 列，因此
        // 使用带前缀的 clause。
        const fixtureClauseQI = fixtureClause === "1=1"
          ? "1=1"
          : `(
              q.destination_session NOT LIKE '%@test-%' AND
              q.destination_session NOT LIKE '%@fixture-%' AND
              q.source_session NOT LIKE '%@test-%' AND
              q.source_session NOT LIKE '%@fixture-%'
            )`;
        const rigClauseQI = rig
          ? `AND (q.destination_session LIKE ? OR q.source_session LIKE ?)`
          : "";
        sql = `
          SELECT t.transition_id, t.qitem_id, t.ts, t.state, t.actor_session, t.transition_note,
                 q.destination_session, q.source_session
          FROM queue_transitions t
          JOIN queue_items q ON t.qitem_id = q.qitem_id
          WHERE ${fixtureClauseQI}
            ${rigClauseQI}
          ORDER BY t.ts DESC
          LIMIT ?
        `;
        params = [...rigParams, limit];
        break;
      }
      default:
        // "execution" 在此次 dispatch 前已由 show() 截获；走到这里说明有名称加入
        // BUILT_IN_VIEW_NAMES，却没有对应 case。
        throw new ViewProjectorError("view_query_failed", `built-in view '${name}' has no SQL dispatch case`);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return {
      viewName: name,
      generatedAt: this.now().toISOString(),
      rows,
      rowCount: rows.length,
    };
  }

  private runCustom(view: CustomView, limit: number): ViewQueryResult {
    // Custom view definition 是操作员提供的 SQL；若 SQL 没有 LIMIT，则追加一个。本模块不解析
    // SQL，definition 正确性由操作员负责。
    const sql = view.definition.toLowerCase().includes("limit")
      ? view.definition
      : `${view.definition.trim().replace(/;$/, "")} LIMIT ${limit}`;
    let rows: Record<string, unknown>[];
    try {
      rows = this.db.prepare(sql).all() as Record<string, unknown>[];
    } catch (err) {
      throw new ViewProjectorError(
        "view_query_failed",
        `custom view '${view.viewName}' query failed: ${(err as Error).message}`,
      );
    }
    // 更新 last_evaluated_at，尽力而为且不在事务中。
    this.db
      .prepare(`UPDATE views_custom SET last_evaluated_at = ? WHERE view_id = ?`)
      .run(this.now().toISOString(), view.viewId);
    return {
      viewName: view.viewName,
      generatedAt: this.now().toISOString(),
      rows,
      rowCount: rows.length,
    };
  }

  /**
   * 注册 custom view。view_name 唯一；重复注册同名 view 会更新 definition，方便操作员编辑
   * views.yaml 后重新注册以获得新查询。
   */
  registerCustomView(input: {
    viewName: string;
    definition: string;
    registeredBySession: string;
  }): CustomView {
    if ((BUILT_IN_VIEW_NAMES as readonly string[]).includes(input.viewName)) {
      throw new ViewProjectorError(
        "view_name_reserved",
        `view name '${input.viewName}' is a reserved built-in name; choose a different name`,
      );
    }
    const existing = this.db
      .prepare(`SELECT * FROM views_custom WHERE view_name = ?`)
      .get(input.viewName) as CustomViewRow | undefined;
    const registeredAt = this.now().toISOString();
    if (existing) {
      this.db
        .prepare(
          `UPDATE views_custom
             SET definition = ?, registered_by_session = ?, registered_at = ?
           WHERE view_id = ?`,
        )
        .run(input.definition, input.registeredBySession, registeredAt, existing.view_id);
      return this.getCustomViewByIdOrThrow(existing.view_id);
    }
    const viewId = ulid();
    this.db
      .prepare(
        `INSERT INTO views_custom (
          view_id, view_name, definition, registered_by_session, registered_at
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(viewId, input.viewName, input.definition, input.registeredBySession, registeredAt);
    return this.getCustomViewByIdOrThrow(viewId);
  }

  getCustomView(viewName: string): CustomView | null {
    const row = this.db
      .prepare(`SELECT * FROM views_custom WHERE view_name = ?`)
      .get(viewName) as CustomViewRow | undefined;
    return row ? this.rowToCustomView(row) : null;
  }

  listCustomViews(): CustomView[] {
    const rows = this.db
      .prepare(`SELECT * FROM views_custom ORDER BY view_name ASC`)
      .all() as CustomViewRow[];
    return rows.map((r) => this.rowToCustomView(r));
  }

  /**
   * 底层 state 变化时由 routes/views.ts 用来发出 view.changed。Phase B 不自动 evaluate；
   * 调用方（route SSE handler）订阅 event-bus event 并触发此 notify。
   */
  notifyViewChanged(viewName: string, cause: string): void {
    this.eventBus.persistWithinTransaction({
      type: "view.changed",
      viewName,
      cause,
    });
  }

  private getCustomViewByIdOrThrow(viewId: string): CustomView {
    const row = this.db
      .prepare(`SELECT * FROM views_custom WHERE view_id = ?`)
      .get(viewId) as CustomViewRow | undefined;
    if (!row) {
      throw new ViewProjectorError("view_not_found", `custom view ${viewId} not found after write`);
    }
    return this.rowToCustomView(row);
  }

  private rowToCustomView(row: CustomViewRow): CustomView {
    return {
      viewId: row.view_id,
      viewName: row.view_name,
      definition: row.definition,
      registeredBySession: row.registered_by_session,
      registeredAt: row.registered_at,
      lastEvaluatedAt: row.last_evaluated_at,
    };
  }
}
