import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.6.WF1 FR-5——workflow_instances.version 列。
 *
 * 实例推进的乐观并发守卫：每次 project() 都把读取到的 version 带入事务；updateFrontier 的
 * UPDATE 以 `WHERE version = ?` 限定，并执行 `version = version + 1`。变更零行表示并发写入者
 * 已先推进实例 → 结构化 `instance_version_conflict`（整个 scribe 事务回滚）。SQLite 的单写入者
 * 串行化负责排序写操作；version 守卫阻止第二个写入者基于第一个写入者提交前读到的陈旧实例状态
 * 继续操作。
 *
 * 增量添加、NOT NULL 且 DEFAULT 0，使现有在途实例采用版本 0，并在下一次投影时正常递增——
 * 无需回填。
 */
export const workflowInstanceVersionSchema: Migration = {
  name: "049_workflow_instance_version.sql",
  sql: `
    ALTER TABLE workflow_instances ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
  `,
};
