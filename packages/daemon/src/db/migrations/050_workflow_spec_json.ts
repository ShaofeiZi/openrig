import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.6.WF1 FR-6/FR-9（构建期间发现来源）——workflow_specs.spec_json 列。
 *
 * 在 ac75777a，缓存只保存 roles_json + steps_json（以及标量列），因此 `getByNameVersion`——
 * PROJECTOR 每次 project() 解析 spec 的路径——重建 spec 时会静默丢弃 `loop_guards`、
 * `invariants`、`closure` 和 `entry`（rowToWorkflowSpec 的仅列分支）。readThrough 通过用新鲜的
 * 文件解析 spec 覆盖来补偿验证，但投影时的执行逻辑（FR-6 max_hops）永远看不到声明的守卫。
 * 此列在缓存时保存完整解析后的 spec，使 runtime 即使在源文件移动或消失后仍精确执行作者声明
 *（缓存自身的生存契约）。
 *
 * 可空：legacy 行回退到仅列重建（诚实降级），并在下次 readThrough 时自愈。
 */
export const workflowSpecJsonSchema: Migration = {
  name: "050_workflow_spec_json.sql",
  sql: `
    ALTER TABLE workflow_specs ADD COLUMN spec_json TEXT;
  `,
};
