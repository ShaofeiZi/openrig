import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.6 FS-1（后台服务读取路径加固，W2）——queue_transitions ARCHIVE 同级表
 *（架构 D3：审计界面只能归档，绝不直接删除）。
 *
 * `queue_transitions` 是具有产品含义的审计界面（记录链；`rig queue resolve` 在此记录决策
 * 文本）——目前只能 INSERT，没有清理路径，因此会无限增长（事故 fixture 中有 13691 行），
 * 并放大备份及所有读取 transition 的界面。架构 D3 裁定：绝不直接删除；在同一事务中将已终结
 * 且达到年龄的 transition 移入此同级表，使审计轨迹得以保留并可原地查询，而非丢失。
 *
 * Schema 逐列镜像 `queue_transitions`（025），因此移动只需在一个事务中执行一次
 * `INSERT INTO queue_transitions_archive (...) SELECT ... FROM queue_transitions WHERE ...`
 * 加 `DELETE`。`transition_id` 是普通 PRIMARY KEY（不是 AUTOINCREMENT），使归档行保留原始
 * id，审计引用跨移动仍可解析。`archived_at` 记录归档时间（来源）；源 `ts` 原样保留。
 *
 * 活跃 FRONTIER 不变量（由 W2 runner 而非本迁移执行）：只移动终态 qitem 且最后一次 transition
 * 早于保留窗口（默认 30 天）的记录；非终态 qitem 的完整 transition 历史无论多旧都绝不触碰。
 * 移动 runner 与保留参数在 W2 maintenance-tick 变更中落地；本迁移只添加同级表及其读取索引
 *（增量；不改 `queue_transitions` 数据）。
 *
 * 编号 054：051_workflow_resume 发布且 FAC-1 预留 052 后，与 FS-1 索引（053）一起从 052
 * 重编号为 054（编排去冲突 2026-07-06；rebase/验证时需根据最终合并树复核）。归档表和索引
 * 名称不变。
 */
export const queueTransitionsArchiveSchema: Migration = {
  name: "054_queue_transitions_archive.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS queue_transitions_archive (
      transition_id INTEGER PRIMARY KEY,
      qitem_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      state TEXT NOT NULL,
      transition_note TEXT,
      actor_session TEXT NOT NULL,
      closure_reason TEXT,
      closure_target TEXT,
      archived_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_queue_transitions_archive_qitem ON queue_transitions_archive(qitem_id, ts);
  `,
};
