import type { Migration } from "../migrate.js";

/**
 * Workflow spec（PL-004 阶段 D；后台服务原生 Workflow Runtime）。
 *
 * 根据 PRD § L4 Workflow Runtime：workflow spec 以 Markdown/YAML 为权威；后台服务在此缓存
 * 直读副本，以便快速查询，并使实例在源文件移动后仍能在运行时解析 spec。source_hash 在下次读取时
 * 使缓存失效；操作员对 spec 文件的有效编辑优先（workspace-surface 协调契约）。
 *
 * 列：
 *   - spec_id（ULID 主键）
 *   - name（来自 spec YAML 的 workflow.id）
 *   - version (workflow.version)
 *   - purpose (workflow.objective)
 *   - target_rig (workflow.target.rig)
 *   - roles_json（序列化的 roles[] 映射）
 *   - steps_json（序列化的 steps[] 数组）
 *   - coordination_terminal_turn_rule（默认 `hot_potato`）
 *   - source_path（磁盘上的 Markdown/YAML spec 文件路径）
 *   - source_hash（用于失效检测的内容哈希）
 *   - cached_at（ISO 时间戳；最近一次直读缓存标记）
 *
 * (name, version) 上的唯一约束——给定版本的 workflow spec 是 canonical；重新缓存相同 spec
 * 内容时只更新 cached_at + source_hash，不插入重复行。
 */
export const workflowSpecsSchema: Migration = {
  name: "033_workflow_specs.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS workflow_specs (
      spec_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      purpose TEXT,
      target_rig TEXT,
      roles_json TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      coordination_terminal_turn_rule TEXT NOT NULL DEFAULT 'hot_potato',
      source_path TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      cached_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_specs_name_version
      ON workflow_specs(name, version);
    CREATE INDEX IF NOT EXISTS idx_workflow_specs_target_rig
      ON workflow_specs(target_rig);
  `,
};
