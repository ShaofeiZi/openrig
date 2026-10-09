import type Database from "better-sqlite3";
import { TERMINAL_QUEUE_STATES } from "./queue-repository.js";

/**
 * OPR.0.4.6 FS-1（后台服务读取路径加固）—— W2 保留/清理执行器。
 *
 * 两张表、两份契约（架构 D3——绝不合并为一个策略）：
 *
 *  1. `queue_transitions` 是具有产品含义的审计表面（记录链；`zrig queue resolve`
 *     决策文本）。契约要求归档而非直接删除。若终态 qitem 的最后一次转换早于保留
 *     窗口，则在同一事务中通过 INSERT..SELECT + DELETE 移入同级
 *     `queue_transitions_archive`（迁移 054）；轨迹得以保留、原位可查、绝不丢失。
 *     ACTIVE-FRONTIER 不变量（有约束且可测试）：任何非终态 qitem 的转换无论多旧都
 *     不得触碰。结构上只选择 `queue_items.state` 为终态的 qitem。
 *
 *  2b. `usage_samples`（51-08 A2）是遥测数据，与 watchdog_history 契约相同：
 *     超过 PM 裁定的默认 14 天（`retention.usage_samples_days`）后做有界直接删除。
 *  2. `watchdog_history` 是遥测数据，没有审计契约。窗口外记录直接删除，但无论
 *     时长如何始终保留每个 job 最近 K 条（符合逐 job 最近记录读取索引
 *     `idx_watchdog_history_job_recent`）。
 *
 * 执行机制：启动时扫描一次，之后由后台服务每日维护 tick 执行（不是看门狗策略）。
 * 每次数据库处理都是带 LIMIT 的有界批次，异步编排器在批次间让出事件循环，因此
 * 清理本身绝不会卡死循环。`nowIso` 可注入，以便 VM 确定性播种。
 *
 * 真实性边界（架构 F3）：它限制数据库增长、备份大小及任何读取转换的表面，但不会
 * 改善 `/api/ps` 延迟（后者由 W1 的 sessions 索引与 N+1 消除负责）。二者分离，
 * 使发布门禁准确归因修复。
 *
 * ── REBASE 协调（本模块在工作树 384e60f1 中从零编写；按计划 §J/§K，以下内容应落到合并后的
 *    最新提交，而不是这个陈旧检出）──
 *  • P1——唯一共享的终态谓词。`queue-repository.ts` 当时只以内联字面量保存终态集合
 *   （此处 :522/:663 的 `state === "done" || state === "handed-off"`；架构说明引用合并后
 *    a6c27e74 的 :550/:691/:1058）。rebase 时，从 queue-repository 导出唯一具名
 *    `TERMINAL_QUEUE_STATES`，重构这些内联位置使其复用，并用该导入替换本模块本地的
 *    `DEFAULT_TERMINAL_STATES`。这是纯命名且字节行为一致的变更，应按函数而非行号扫查。
 *    在此之前，本地默认值就是代码的终态集合 `['done','handed-off']`，所以行为一致，
 *    只是唯一事实来源接线延后。
 *  • P2——前沿存活排除。增加一条 WHERE 子句和一个具名测试，无论状态和时长如何，排除任何
 *    仍被非终态工作流实例当前前沿引用的 qitem。这会主动保护按 packet 寻址的并行前沿；
 *    串行关闭机制仍由同一谓词覆盖。
 *  • 接线——在 `SETTINGS_VALID_KEYS`（settings-store）登记保留设置键，并在启动时及每日 tick
 *    从后台服务维护调度器（启动 watchdog runner 的 index.ts/server.ts）调用
 *    `runQueueRetentionSweep`。两个集成点都位于合并后最新提交，已在那里接线。
 */

/**
 * 队列终态集合——P1 已落地：来自 queue-repository 导出的唯一共享真源
 * `TERMINAL_QUEUE_STATES`（队列自身关闭守卫通过 `isTerminalState` 使用同一谓词），
 * 因此未来新增终态时，归档器不会静默偏离队列（架构 D3-REFINEMENT P1）。完整终态
 * 集合为 `['done','handed-off']`；仅保留 done 会漏掉量最大的工作流步骤关闭类别。
 */
export const DEFAULT_TERMINAL_STATES = TERMINAL_QUEUE_STATES;

/** 保留策略默认值（架构 D3）。内置闭集参数，在 rebase 时登记为设置键，不接受自由配置。 */
export const RETENTION_DEFAULTS = {
  /** 归档最后一次转换早于此时长的终态转换。 */
  transitionsRetentionDays: 30,
  /** 删除早于此时长的 watchdog_history…… */
  watchdogRetentionDays: 14,
  /** ……但始终保留每个 job 最近的这些记录。 */
  watchdogKeepPerJob: 50,
  /** 删除早于此时长的 usage_samples 遥测（51-08 A2，PM 决策 2）。 */
  usageSamplesRetentionDays: 14,
  /** 每个有界批次处理的记录/qitem 数（防卡死边界）。 */
  batchSize: 500,
  /** 每次扫描中每张表的批次数安全上限（纵深防御失控循环）。 */
  maxBatchesPerTable: 10_000,
} as const;

export interface RetentionOptions {
  /** 注入时钟（ISO-8601），供 VM 确定性播种。 */
  nowIso: string;
  terminalStates?: readonly string[];
  transitionsRetentionDays?: number;
  watchdogRetentionDays?: number;
  watchdogKeepPerJob?: number;
  usageSamplesRetentionDays?: number;
  batchSize?: number;
  maxBatchesPerTable?: number;
}

/** ISO 截止时间 = 当前时间减 `days`。这是纯函数，由注入的 `nowIso` 派生，
 * 因此同一播种值始终得到同一边界，不依赖环境 Date。 */
function cutoffIso(nowIso: string, days: number): string {
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) {
    throw new Error(`queue-retention：nowIso 无效：${JSON.stringify(nowIso)}`);
  }
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** 在有界批次之间协作让出执行权，避免大规模清理饿死事件循环。better-sqlite3
 * 同步执行，每批都会跑完；批次间让出才能保持事件循环响应。 */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface ArchiveBatchResult {
  /** 本批次已归档转换的不同终态 qitem 数。 */
  archivedQitems: number;
  /** 本批次移动的转换记录数。 */
  archivedRows: number;
}

/**
 * 一个有界批次：移动最多 `batchSize` 个终态 qitem 的转换，这些 qitem 的最后一次
 * 转换早于截止时间。每个 qitem 在单一事务中先归档再删除。返回数量，供编排器循环
 * 直到批次为空。非终态 qitem 永不被选择，这是结构化的 active-frontier 不变量。
 */
export function archiveAgedTerminalTransitions(
  db: Database.Database,
  opts: RetentionOptions,
): ArchiveBatchResult {
  const terminalStates = opts.terminalStates ?? DEFAULT_TERMINAL_STATES;
  const batchSize = opts.batchSize ?? RETENTION_DEFAULTS.batchSize;
  const cutoff = cutoffIso(
    opts.nowIso,
    opts.transitionsRetentionDays ?? RETENTION_DEFAULTS.transitionsRetentionDays,
  );

  // 合格项是最新转换早于截止时间的终态 qitem。从 queue_items 进行终态筛选，并用
  // 可利用 idx_queue_transitions_qitem (qitem_id, ts) 的相关 MAX(ts)；LIMIT 限制批次。
  //
  // P2（架构，前沿存活排除）：下方 AND NOT EXISTS 绝不会归档仍被存活（active/waiting）
  // 工作流实例当前前沿引用的终态 qitem。它镜像队列关闭路径的同级函数
  // `createWorkflowFrontierPredicate`（workflow-frontier-guard.ts，WF3 FR-6），保持同一不变量：
  // `status IN ('active','waiting')` 加
  // `current_frontier_json LIKE '%"<qitemId>"%'`。区别是这里在归档选择接缝强制执行，
  // 而非关闭接缝；编排裁定要求维护模块保持独立且限定于 DB，不传递注入谓词。现在它同时保护
  // 按 packet 寻址的并行前沿和旧版串行情形。`workflow_instances` 是核心迁移表，迁移后的
  // tick 运行时始终存在。
  const placeholders = terminalStates.map(() => "?").join(", ");
  const eligible = db
    .prepare(
      `SELECT q.qitem_id AS qitemId
         FROM queue_items q
        WHERE q.state IN (${placeholders})
          AND (
            SELECT MAX(t.ts) FROM queue_transitions t WHERE t.qitem_id = q.qitem_id
          ) < ?
          AND NOT EXISTS (
            SELECT 1 FROM workflow_instances wi
             WHERE wi.status IN ('active','waiting')
               AND wi.current_frontier_json LIKE '%"' || q.qitem_id || '"%'
          )
        LIMIT ?`,
    )
    .all(...terminalStates, cutoff, batchSize) as Array<{ qitemId: string }>;

  if (eligible.length === 0) {
    return { archivedQitems: 0, archivedRows: 0 };
  }

  const activeColumns = new Set(
    (db.prepare("PRAGMA table_info(queue_transitions)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  const archiveColumns = new Set(
    (db.prepare("PRAGMA table_info(queue_transitions_archive)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  if (activeColumns.has("identity_provenance") && !archiveColumns.has("identity_provenance")) {
    throw new Error("queue-retention：归档缺少 identity_provenance；请先应用迁移再归档");
  }
  const identityColumn = activeColumns.has("identity_provenance") ? ", identity_provenance" : "";
  const carriesOwnerNotification = ["owner_notification_kind", "owner_notification_level"]
    .every((column) => activeColumns.has(column) && archiveColumns.has(column));
  const ownerInsert = carriesOwnerNotification ? ", owner_notification_kind, owner_notification_level" : "";
  const ownerSelect = carriesOwnerNotification ? ", owner_notification_kind, owner_notification_level" : "";
  const selectRows = db.prepare(
    `INSERT INTO queue_transitions_archive (
       transition_id, qitem_id, ts, state, transition_note,
       actor_session, closure_reason, closure_target${identityColumn}${ownerInsert}, archived_at
     )
     SELECT transition_id, qitem_id, ts, state, transition_note,
            actor_session, closure_reason, closure_target${identityColumn}${ownerSelect}, ?
       FROM queue_transitions
      WHERE qitem_id = ?`,
  );
  const deleteRows = db.prepare(`DELETE FROM queue_transitions WHERE qitem_id = ?`);

  // 每个 qitem 使用一个事务：单个 qitem 的移动要么全部成功，要么完全不发生；
  // 批次中途失败时，之前已移动的 qitem 保持持久归档。
  const moveOne = db.transaction((qitemId: string): number => {
    const inserted = selectRows.run(opts.nowIso, qitemId).changes;
    deleteRows.run(qitemId);
    return inserted;
  });

  let archivedRows = 0;
  for (const { qitemId } of eligible) {
    archivedRows += moveOne(qitemId);
  }
  return { archivedQitems: eligible.length, archivedRows };
}

export interface PruneBatchResult {
  /** 本批次删除的 watchdog_history 记录数。 */
  deletedRows: number;
}

/**
 * 一个有界批次：删除最多 `batchSize` 条早于截止时间，且不属于每个 job 最近 K 条的
 * watchdog_history 记录。逐 job 新旧排序利用 idx_watchdog_history_job_recent
 * (job_id, evaluated_at DESC)。排序子查询中的 `>=` 会在时间戳相同时多保留而非
 * 多删除，这是安全方向。
 */
export function pruneWatchdogHistory(
  db: Database.Database,
  opts: RetentionOptions,
): PruneBatchResult {
  const batchSize = opts.batchSize ?? RETENTION_DEFAULTS.batchSize;
  const keepPerJob = opts.watchdogKeepPerJob ?? RETENTION_DEFAULTS.watchdogKeepPerJob;
  const cutoff = cutoffIso(
    opts.nowIso,
    opts.watchdogRetentionDays ?? RETENTION_DEFAULTS.watchdogRetentionDays,
  );

  const result = db
    .prepare(
      `DELETE FROM watchdog_history
        WHERE history_id IN (
          SELECT wh.history_id
            FROM watchdog_history wh
           WHERE wh.evaluated_at < ?
             AND (
               SELECT COUNT(*) FROM watchdog_history w2
                WHERE w2.job_id = wh.job_id
                  AND w2.evaluated_at >= wh.evaluated_at
             ) > ?
           LIMIT ?
        )`,
    )
    .run(cutoff, keepPerJob, batchSize);

  return { deletedRows: result.changes };
}

/**
 * 51-08 A2 —— 一个有界批次：删除最多 `batchSize` 条 captured_at 早于保留截止时间
 * 的 usage_samples 记录（PM 裁定默认 14 天，可调）。usage_samples 按
 * watchdog_history 契约属于遥测数据，直接删除且不做审计归档。席位闲置超过窗口后
 * 会失去这些记录，查询表面应如实显示 unknown，而不保留陈旧值。`<` 语义使恰好
 * 等于截止时间的记录继续保留，这是安全方向。
 */
export function pruneUsageSamples(
  db: Database.Database,
  opts: RetentionOptions,
): PruneBatchResult {
  const batchSize = opts.batchSize ?? RETENTION_DEFAULTS.batchSize;
  const cutoff = cutoffIso(
    opts.nowIso,
    opts.usageSamplesRetentionDays ?? RETENTION_DEFAULTS.usageSamplesRetentionDays,
  );
  const result = db
    .prepare(
      `DELETE FROM usage_samples
        WHERE id IN (
          SELECT id FROM usage_samples WHERE captured_at < ? LIMIT ?
        )`,
    )
    .run(cutoff, batchSize);
  return { deletedRows: result.changes };
}

export interface RetentionSweepSummary {
  archivedQitems: number;
  archivedRows: number;
  watchdogDeleted: number;
  usageSamplesDeleted: number;
  transitionBatches: number;
  watchdogBatches: number;
  usageSamplesBatches: number;
}

/**
 * 启动扫描/每日 tick 的入口：以有界批次排空各项保留处理，并在批次间让出事件循环，
 * 避免大量积压卡死后台服务。操作幂等，每次启动都可安全运行。每项处理在批次为空
 * 或达到安全批次数上限时停止。
 */
export async function runQueueRetentionSweep(
  db: Database.Database,
  opts: RetentionOptions,
): Promise<RetentionSweepSummary> {
  const maxBatches = opts.maxBatchesPerTable ?? RETENTION_DEFAULTS.maxBatchesPerTable;
  const summary: RetentionSweepSummary = {
    archivedQitems: 0,
    archivedRows: 0,
    watchdogDeleted: 0,
    usageSamplesDeleted: 0,
    transitionBatches: 0,
    watchdogBatches: 0,
    usageSamplesBatches: 0,
  };

  for (let i = 0; i < maxBatches; i++) {
    const batch = archiveAgedTerminalTransitions(db, opts);
    if (batch.archivedQitems === 0) break;
    summary.archivedQitems += batch.archivedQitems;
    summary.archivedRows += batch.archivedRows;
    summary.transitionBatches++;
    await yieldToLoop();
  }

  for (let i = 0; i < maxBatches; i++) {
    const batch = pruneWatchdogHistory(db, opts);
    if (batch.deletedRows === 0) break;
    summary.watchdogDeleted += batch.deletedRows;
    summary.watchdogBatches++;
    await yieldToLoop();
  }

  for (let i = 0; i < maxBatches; i++) {
    const batch = pruneUsageSamples(db, opts);
    if (batch.deletedRows === 0) break;
    summary.usageSamplesDeleted += batch.deletedRows;
    summary.usageSamplesBatches++;
    await yieldToLoop();
  }

  return summary;
}
