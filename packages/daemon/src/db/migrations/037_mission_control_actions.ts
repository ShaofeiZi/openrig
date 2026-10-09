import type { Migration } from "../migrate.js";

/**
 * Mission Control 操作（PL-005 阶段 A；后台服务支持的操作审计）。
 *
 * 根据 PRD § Q5 与 slice IMPL § Write Set：通过 Mission Control 执行的每个操作员操作都会
 * 写入 SQLite-canonical 只追加审计日志。记录阶段 A 七个动词的每次调用及操作前后快照，
 * 用于取证重建。
 *
 * 只追加契约：写入方只能 INSERT。MissionControlActionLog API 不公开 UPDATE/DELETE；
 * 直接 SQL UPDATE/DELETE 会在数据库层成功（SQLite 没有视图/角色层），但属于由领域层 API
 * 边界强制执行的契约违规。
 *
 * 操作动词枚举（阶段 A v1；7 个值）：
 *   - approve     ——操作员批准需要人工把关的条目
 *   - deny        ——操作员拒绝需要人工把关的条目
 *   - route       ——操作员将条目路由到其他目标
 *   - annotate    ——操作员添加注释（必须提供 annotation 字段）
 *   - hold        ——操作员附原因暂停条目（必须提供 reason）
 *   - drop        ——操作员附原因丢弃条目（必须提供 reason）
 *   - handoff     ——原子四步操作（更新来源 + 创建目标 + 可选尽力通知 + 追加审计）
 *
 * 列：
 *   - action_id（ULID 主键）
 *   - action_verb（TEXT，应用层枚举校验）
 *   - qitem_id（TEXT，适用时为指向 queue_items 的外键；未来的观察/非队列操作可为空）
 *   - actor_session（TEXT NOT NULL）——触发该动词的操作员 session
 *   - acted_at（TEXT NOT NULL）——ISO 时间戳
 *   - before_state_json（TEXT）——操作前 qitem 状态快照
 *   - after_state_json（TEXT）——操作后 qitem 状态快照
 *   - reason（TEXT）——hold + drop 时必需
 *   - annotation（TEXT）——annotate 时必需
 *   - notify_attempted（INTEGER 0|1）——用于 handoff
 *   - notify_result（TEXT）——verified | delivered-ack-pending | failed:<reason>
 *     （OPR.0.3.2.21.FR-4(c) 后的措辞："sent-unverified" 容易误导，因为即使投递正常也像
 *     部分失败；对因繁忙导致同步 ack 窗口过期的 codex 席位，"delivered-ack-pending"
 *     表达的是正常且符合预期的情况）
 *   - audit_notes_json（TEXT）——操作员提供的证据映射
 *
 * 索引：
 *   - (acted_at DESC, action_verb)——近期操作和逐动词扫描
 *   - (qitem_id, acted_at DESC)——逐 qitem 审计轨迹
 *   - (actor_session, acted_at DESC)——逐操作员审计
 *
 * 归档策略钩子：v1 未实现自动归档；此表只追加且会无限增长。未来可将超过 N 天的行移动到同级
 * 归档表，或导出到文件系统。除非出现明确持久性需求，否则延后 JSONL 镜像。
 */
export const missionControlActionsSchema: Migration = {
  name: "037_mission_control_actions.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS mission_control_actions (
      action_id TEXT PRIMARY KEY,
      action_verb TEXT NOT NULL,
      qitem_id TEXT REFERENCES queue_items(qitem_id),
      actor_session TEXT NOT NULL,
      acted_at TEXT NOT NULL,
      before_state_json TEXT,
      after_state_json TEXT,
      reason TEXT,
      annotation TEXT,
      notify_attempted INTEGER NOT NULL DEFAULT 0,
      notify_result TEXT,
      audit_notes_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mc_actions_recent
      ON mission_control_actions(acted_at DESC, action_verb);
    CREATE INDEX IF NOT EXISTS idx_mc_actions_qitem
      ON mission_control_actions(qitem_id, acted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mc_actions_actor
      ON mission_control_actions(actor_session, acted_at DESC);
  `,
};
