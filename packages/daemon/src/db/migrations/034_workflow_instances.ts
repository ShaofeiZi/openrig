import type { Migration } from "../migrate.js";

/**
 * Workflow 实例（PL-004 阶段 D；实时 workflow 状态）。
 *
 * 根据 PRD § L4 Workflow Runtime：workflow 实例是运行中 workflow 的 SQLite-canonical
 * 记录，无需文件系统协调即可跨后台服务重启保留。current_frontier_json 列保存任意时刻作为
 * 活跃步骤包的 qitem_id 数组。
 *
 * R2 修复（守卫 blocker 1）：通过 `current_step_id` 持久绑定当前步骤。替代基于轨迹的
 * “last_step + 1”推断；后者对复用 frontier 的包会产生错误结果（例如同一包从 waiting → resume
 * 会跳过一步）。这与 POC 一致：从当前包绑定提取 step_id，而非根据轨迹顺序推断。v1 支持一个
 * 活跃 frontier 包；多 frontier（并行分支）属于后续升级，需要 packet→step 映射。
 *
 * 状态枚举（与 POC + PRD 一致）：
 *   - active：实例至少有一个在途 frontier 包
 *   - waiting：实例有一个被外部门禁阻塞的 frontier 包
 *   - completed：终态成功；current_frontier_json 为 []
 *   - failed：终态失败
 *
 * fallback_synthesis：可空文本，记录 peer continuity relay 不可用时使用的智能体判断综合结果
 *（已关闭但未识别继任者）。这是可选审计上下文。
 *
 * hop_count：已执行步骤转换次数；投影时检查 PRD 不变量 `loop_guards.max_hops`。
 *
 * last_continuation_decision_json：最近一次继续/闭环决策的可选结构化记录（POC 中的
 * `handoff_decision`、`wait_decision` 或 `close_decision` 结构），用于追踪和调试。
 *
 * 索引：
 *   - (status, workflow_name)——快速“查找 workflow X 的活跃实例”
 *   - (created_by_session, status)——快速“查找我的实时 workflow”
 */
export const workflowInstancesSchema: Migration = {
  name: "034_workflow_instances.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS workflow_instances (
      instance_id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      workflow_version TEXT NOT NULL,
      created_by_session TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      current_frontier_json TEXT NOT NULL DEFAULT '[]',
      current_step_id TEXT,
      hop_count INTEGER NOT NULL DEFAULT 0,
      fallback_synthesis TEXT,
      last_continuation_decision_json TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_instances_status_name
      ON workflow_instances(status, workflow_name);
    CREATE INDEX IF NOT EXISTS idx_workflow_instances_creator_status
      ON workflow_instances(created_by_session, status);
  `,
};
