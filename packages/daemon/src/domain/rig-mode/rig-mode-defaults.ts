// Slice 09 —— 各模式的推荐默认值与默认工作范围。
//
// 组件 3 —— 各模式推荐默认值（6×7 矩阵）。
// 组件 4 —— 各模式推荐默认工作范围。
//
// “推荐值，操作员可逐字段覆盖”——当操作员调用裸模式（例如
// `zrig policy set debug`）而未指定各字段时，CLI/HTTP 设置路由会应用这些
// 回退值。操作员提供的逐字段覆盖值合并在默认值之上。

import type {
  AutonomyScope,
  ConcurrencyLimit,
  EscalationThreshold,
  HeartbeatCadence,
  InspectionDepth,
  OperatorContextMode,
  OperatorContextScope,
  PermissionPromptPosture,
  UpdateDetail,
} from "./rig-mode-types.js";

/**
 * 七种逐模式设置默认值（组件 3 §建议的逐模式默认值），逐字镜像约定表。
 *
 * 此处不包含 `scope`；各模式默认工作范围位于下方 RECOMMENDED_DEFAULT_SCOPE，
 * 因为约定将其单列为组件 4“各模式推荐默认工作范围”。
 *
 * `expiry_or_stale_rule` 和 `evidence_citation` 不属于 6×7 矩阵；后台服务为
 * 前者应用保守默认值（`re_confirm_on_long_gap`——约定 Q3 将 Mode 2 的数值留待
 * 后续，规则类型采用 v0 的保守选择），后者则由操作员在每次调用时提供。
 */
export interface RecommendedModeDefaults {
  autonomy_scope: AutonomyScope;
  heartbeat_cadence: HeartbeatCadence;
  inspection_depth: InspectionDepth;
  update_detail: UpdateDetail;
  escalation_threshold: EscalationThreshold;
  concurrency_limit: ConcurrencyLimit;
  permission_prompt_posture: PermissionPromptPosture;
}

export const RECOMMENDED_MODE_DEFAULTS: Record<OperatorContextMode, RecommendedModeDefaults> = {
  "human-led": {
    autonomy_scope: "pre_approved_only",
    heartbeat_cadence: "normal",
    inspection_depth: "normal",
    update_detail: "normal",
    escalation_threshold: "normal",
    concurrency_limit: "unlimited",
    permission_prompt_posture: "normal",
  },
  delegated: {
    autonomy_scope: "bounded_continuation",
    heartbeat_cadence: "normal",
    inspection_depth: "normal",
    update_detail: "normal",
    escalation_threshold: "normal",
    concurrency_limit: "unlimited",
    permission_prompt_posture: "normal",
  },
  sleep: {
    autonomy_scope: "pre_approved_only",
    heartbeat_cadence: "sparse",
    inspection_depth: "normal",
    update_detail: "compact",
    escalation_threshold: "blocker_only",
    concurrency_limit: "serial",
    permission_prompt_posture: "batch_for_human",
  },
  desk: {
    autonomy_scope: "full_autonomy_within_workstream",
    heartbeat_cadence: "normal",
    inspection_depth: "normal",
    update_detail: "normal",
    escalation_threshold: "normal",
    concurrency_limit: "unlimited", // 约定表中为 "normal"；v0 将其映射为 unlimited（现有 OpenRig 默认值，智能体按 workstream 模式纪律扇出）。
    permission_prompt_posture: "normal",
  },
  mobile: {
    autonomy_scope: "bounded_continuation",
    heartbeat_cadence: "normal",
    inspection_depth: "surface",
    update_detail: "compact",
    escalation_threshold: "low",
    concurrency_limit: "unlimited",
    permission_prompt_posture: "batch_for_human",
  },
  away: {
    autonomy_scope: "pre_approved_only",
    heartbeat_cadence: "sparse",
    inspection_depth: "normal",
    update_detail: "compact",
    escalation_threshold: "blocker_only",
    concurrency_limit: "serial",
    permission_prompt_posture: "batch_for_human",
  },
  focus: {
    autonomy_scope: "full_autonomy_within_workstream",
    heartbeat_cadence: "normal",
    inspection_depth: "normal",
    update_detail: "compact",
    escalation_threshold: "blocker_only",
    concurrency_limit: "unlimited",
    permission_prompt_posture: "batch_for_human",
  },
  debug: {
    autonomy_scope: "bounded_continuation",
    heartbeat_cadence: "fast",
    inspection_depth: "forensic",
    update_detail: "verbose",
    escalation_threshold: "low",
    concurrency_limit: "serial",
    permission_prompt_posture: "normal",
  },
};

/**
 * 组件 4 —— 各模式推荐默认工作范围。
 *
 * 用于复述确认：操作员调用未显式指定工作范围时，智能体按此建议复述，并等待
 * 确认或更正。操作员的确认具有最终权威性。
 */
export const RECOMMENDED_DEFAULT_SCOPE: Record<OperatorContextMode, OperatorContextScope> = {
  "human-led": "rig",
  delegated: "rig",
  sleep: "global_host",
  away: "global_host",
  desk: "global_host",
  mobile: "global_host",
  focus: "workstream",
  debug: "qitem",
};

/**
 * `expiry_or_stale_rule` 的保守默认值。依据约定 Q3，数值阈值延后到 Mode 2
 * 辅助切片处理；这里选择 `re_confirm_on_long_gap` 作为最安全的默认规则：操作员
 * 长时间离开后要求重新确认，而不是静默继续。
 *
 * 操作员可通过 OperatorContextModeRecord 的 `expiry_or_stale_rule` 字段按绑定
 * 覆盖；v0 不自动调节阈值。
 */
export const DEFAULT_STALE_RULE: "re_confirm_on_long_gap" = "re_confirm_on_long_gap";
