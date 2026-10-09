// Slice 09——工作组策略原语（OPR.0.3.2.9）。
//
// operator-context-mode-system v0 原则的类型化升级。
// conventions/operator-context-mode-system/README.md 中的约定是旧规格；S07 新增显式运行姿态
// 与项目/任务目标范围。类型仍保持为封闭枚举 + 10 字段 schema。任何字段都不得静默合并或丢弃，
// 校验器会强制字段集合完整性。
//
// GATE-ZERO（HG-SAFE）：此原语与权限相邻，但绝不修改权限。
// `permission_prompt_posture` 是由操作员设置的描述性易用性提示。下方枚举从结构上无法表达
// auto-accept：联合类型中没有 auto-accept 成员，校验器还会拒绝未知值。未来若有人尝试在此
// 添加 auto-accept 值，必须同时修订 FROZEN 契约中的 permission-posture 约定与安全策略，
// 否则评审应予拒绝。

/**
 * 组件 2——六种旧模式，加上 human-led/delegated 运行姿态。旧模式是小写单个英文词；
 * 约定明确禁止同义词和数字别名（`L0`–`L3`、`operator:L<n>`）。
 * `conventions/operator-context-mode-system/README.md` 中
 * §"L0–L3 Collision Warning" 的冲突警告是承重约束。
 */
export type OperatorContextMode = "sleep" | "desk" | "mobile" | "away" | "focus" | "debug" | "human-led" | "delegated";

export const OPERATOR_CONTEXT_MODES = [
  "sleep",
  "desk",
  "mobile",
  "away",
  "focus",
  "debug",
  "human-led",
  "delegated",
] as const satisfies readonly OperatorContextMode[];

/**
 * 组件 4——六种范围。多个模式共存时，更具体的范围覆盖较不具体的范围
 *（层级：qitem > workstream > mission > project > rig > global_host）。
 */
export type OperatorContextScope = "global_host" | "rig" | "project" | "mission" | "workstream" | "qitem";

export const OPERATOR_CONTEXT_SCOPES = [
  "global_host",
  "rig",
  "project",
  "mission",
  "workstream",
  "qitem",
] as const satisfies readonly OperatorContextScope[];

/**
 * 范围具体性等级；数值越高越具体。供存储的有效模式解析器使用，不面向操作员。
 */
export const SCOPE_SPECIFICITY: Record<OperatorContextScope, number> = {
  global_host: 0,
  rig: 1,
  project: 2,
  mission: 3,
  workstream: 4,
  qitem: 5,
};

// --- 10 字段 schema 枚举 ---

export type AutonomyScope =
  | "pre_approved_only"
  | "bounded_continuation"
  | "full_autonomy_within_workstream"
  | "full_autonomy";

export type HeartbeatCadence = "sparse" | "normal" | "fast";

export type InspectionDepth = "surface" | "normal" | "forensic";

export type UpdateDetail = "compact" | "normal" | "verbose";

export type EscalationThreshold = "low" | "normal" | "high" | "blocker_only";

/**
 * 组件 3——concurrency_limit。建议值包含下方枚举形式与结构化整数（1..N）。
 * v0 为简化只交付枚举子集；出现 fixture 支撑的证据后，可通过 Mode 1.5 修订升级整数特化。
 */
export type ConcurrencyLimit = "serial" | "2" | "4" | "unlimited";

/**
 * 组件 6——安全策略承重规则：
 *   v0 及其任何后代中的 `permission_prompt_posture` 都不得包含 auto-accept。
 *   安全值严格限定为以下三个。
 *
 * 该枚举从结构上封闭：联合类型中不存在 auto-accept 字面量。贡献者无法设置
 * `permissionPromptPosture = 'auto_accept'`，因为该字面量不是成员，TypeScript 会在编译时拒绝。
 * 校验器还会在运行时拒绝任何非成员字符串，对绕过类型系统的输入（JSON 文件、环境变量等）
 * 实施纵深防御。
 *
 * 若未来修订提议 auto-accept，必须先修订 `conventions/permission-posture/README.md`
 * 中的 permission-posture 规范以及 FROZEN operator-context-mode 安全策略。
 * 无论调用方意图如何，本 slice 及其后代都会独立拒绝 auto-accept。
 */
export type PermissionPromptPosture =
  | "normal"
  | "batch_for_human"
  | "do_not_prompt_unless_blocked";

export const SAFE_PERMISSION_PROMPT_POSTURES = [
  "normal",
  "batch_for_human",
  "do_not_prompt_unless_blocked",
] as const satisfies readonly PermissionPromptPosture[];

/**
 * 组件 4——引用来源。v0 使用自由文本；操作员可引用 `current-mode.md`、qitem ID、
 * 聊天室主题或仅约定声明。按约定，结构化引用属于 Mode 1.5 修订。
 */
export type EvidenceCitation = string;

/**
 * 组件 4——expiry_or_stale_rule。v0 使用保守默认值 "re_confirm_on_long_gap" 声明该字段；
 * 按约定 Q3，数值阈值延后到 Mode 2 辅助 slice。下方规则值枚举受支持的重新确认触发器。
 * 不存在静默切换值——漂移始终需要询问，绝不自动更改模式。
 */
export type ExpiryOrStaleRule =
  | "none"
  | "re_confirm_on_long_gap"
  | "re_confirm_on_day_boundary"
  | "re_confirm_on_observed_conflict";

export const STALE_RULES = [
  "none",
  "re_confirm_on_long_gap",
  "re_confirm_on_day_boundary",
  "re_confirm_on_observed_conflict",
] as const satisfies readonly ExpiryOrStaleRule[];

/**
 * 组件 3——10 字段 SETTINGS schema。校验器要求全部字段，任何字段都不得合并或丢弃。
 * 评审方字段集合完整性检查（HG-2）。
 *
 * **此记录不含 `mode`。** Mode 是绑定的身份（组件 2——具名 bundle 的名称）；
 * 此记录参数化该具名模式如何塑造易用性。绑定包装器 OperatorContextModeBinding
 * 在顶层携带 `mode`，使冻结的 10 字段设置记录严格保持 10 个字段，
 * 与约定 §Component 3 表声明一致。
 */
export interface OperatorContextModeRecord {
  autonomy_scope: AutonomyScope;
  heartbeat_cadence: HeartbeatCadence;
  inspection_depth: InspectionDepth;
  update_detail: UpdateDetail;
  escalation_threshold: EscalationThreshold;
  concurrency_limit: ConcurrencyLimit;
  permission_prompt_posture: PermissionPromptPosture;
  scope: OperatorContextScope;
  expiry_or_stale_rule: ExpiryOrStaleRule;
  evidence_citation: EvidenceCitation;
}

/**
 * 模式到目标上下文的范围化绑定。存储按 (scope, qualifier) 为行建键，因此同一 scope
 * 可包含多个绑定（例如多个工作组范围模式）；有效模式解析器会为
 * (rig, workstream, qitem) 读取上下文选择正确绑定。
 *
 * - `global_host` 绑定的 qualifier 为 null。
 * - `rig` 绑定以工作组 ID 作为 qualifier。
 * - `workstream` 绑定以 workstream ID 作为 qualifier。
 * - `qitem` 绑定以 qitem ID 作为 qualifier。
 */
export interface OperatorContextModeBinding {
  /** 稳定标识符——v0 使用 `${scope}:${qualifier ?? "host"}`。 */
  id: string;
  /** 组件 2——此绑定选择的具名模式。该值位于绑定层而不是 10 字段设置记录中，
   *  使冻结的组件 3 记录严格保持 10 个字段。 */
  mode: OperatorContextMode;
  record: OperatorContextModeRecord;
  /** qualifier 值（rigId、workstreamId、qitemId）；scope 为 global_host 时是 null。 */
  qualifier: string | null;
  /** 最近设置时间的 ISO 时间戳，供漂移规则消费者使用。 */
  setAt: string;
  /** 设置者。契约规定仅限操作员，见更新权限。 */
  setBy: "operator";
}

/**
 * 有效模式读取结果。解析器返回 (rig?, workstream?, qitem?) 上下文中最具体的绑定；
 * 所有匹配范围都没有绑定时返回 `null`。
 *
 * 按约定 §"Q6 — Absent mode is unknown_posture, NOT desk"：调用方必须把 null 有效模式
 * 视为 `unknown_posture`，并显式重新确认真实模式。解析器不会默认为 `desk`，也绝不虚构绑定。
 */
export interface EffectiveOperatorContextMode {
  binding: OperatorContextModeBinding;
  /** 此绑定胜出的原因（具体 scope；用于调试与 UI 展示）。 */
  resolvedScope: OperatorContextScope;
}

/**
 * 解析器的读取上下文。所有字段都可选；解析器选择最具体的适用绑定。
 */
export interface OperatorContextReadContext {
  rigId?: string;
  projectId?: string;
  missionId?: string;
  workstreamId?: string;
  qitemId?: string;
}

/** 任务目标 ID 带项目限定；同名任务目标绝不共享绑定。 */
export function missionModeQualifier(projectId: string, missionId: string): string {
  return `${projectId}/${missionId}`;
}
