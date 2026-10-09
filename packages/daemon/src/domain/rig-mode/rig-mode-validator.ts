// 分片 09——OperatorContextModeRecord 输入的运行时校验器。
//
// 调用方通过类型化接口时，类型系统（rig-mode-types.ts）会在编译期阻止无效值。
// 此校验器用于防御绕过类型的输入：JSON 文件读取、HTTP 请求正文、从环境变量派生的配置、
// CLI 参数解析，以及旧记录结构的迁移。
//
// HG-2：每条记录必须携带全部 10 个字段，拒绝缺失或多余字段。
// HG-1 / HG-SAFE / HG-8：封闭枚举；拒绝自动接受；不存在静默切换值。
//
// 错误格式遵循 velocity 团队的三段式约定：
//   失败内容 / 允许内容 / 处理方式
// 从而向操作人员提供有用的 CLI 消息。

import {
  type AutonomyScope,
  type ConcurrencyLimit,
  type EscalationThreshold,
  type ExpiryOrStaleRule,
  type HeartbeatCadence,
  type InspectionDepth,
  type OperatorContextMode,
  type OperatorContextModeRecord,
  type OperatorContextScope,
  type PermissionPromptPosture,
  type UpdateDetail,
  OPERATOR_CONTEXT_MODES,
  OPERATOR_CONTEXT_SCOPES,
  SAFE_PERMISSION_PROMPT_POSTURES,
  STALE_RULES,
} from "./rig-mode-types.js";

const ALLOWED_AUTONOMY_SCOPES: readonly AutonomyScope[] = [
  "pre_approved_only",
  "bounded_continuation",
  "full_autonomy_within_workstream",
  "full_autonomy",
];

const ALLOWED_HEARTBEAT_CADENCES: readonly HeartbeatCadence[] = ["sparse", "normal", "fast"];

const ALLOWED_INSPECTION_DEPTHS: readonly InspectionDepth[] = ["surface", "normal", "forensic"];

const ALLOWED_UPDATE_DETAILS: readonly UpdateDetail[] = ["compact", "normal", "verbose"];

const ALLOWED_ESCALATION_THRESHOLDS: readonly EscalationThreshold[] = [
  "low",
  "normal",
  "high",
  "blocker_only",
];

const ALLOWED_CONCURRENCY_LIMITS: readonly ConcurrencyLimit[] = ["serial", "2", "4", "unlimited"];

/**
 * OperatorContextModeRecord 的 10 个必填字段。validateRecord 用它枚举字段集完整性
 * （HG-2）——同时检查存在性和穷尽性。
 *
 * 注意：`mode` 不在此列表中。模式是绑定选择器（组件 2 词汇），并非组件 3 设置记录的
 * 一部分。store/route 在绑定边界单独校验 mode；此校验器只强制执行组件 3 的 10 个字段。
 */
export const REQUIRED_RECORD_FIELDS: readonly (keyof OperatorContextModeRecord)[] = [
  "autonomy_scope",
  "heartbeat_cadence",
  "inspection_depth",
  "update_detail",
  "escalation_threshold",
  "concurrency_limit",
  "permission_prompt_posture",
  "scope",
  "expiry_or_stale_rule",
  "evidence_citation",
];

export interface ValidationOk {
  ok: true;
  record: OperatorContextModeRecord;
}

export interface ValidationError {
  ok: false;
  errors: string[];
}

export type ValidationResult = ValidationOk | ValidationError;

function threePart(failed: string, allowed: string, recovery: string): string {
  return `${failed}。允许值：${allowed}。${recovery}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkEnum<T extends string>(
  fieldName: string,
  value: unknown,
  allowed: readonly T[],
  errors: string[],
): T | null {
  if (typeof value !== "string") {
    errors.push(
      threePart(
        `${fieldName} 不是字符串（收到 ${typeof value}）`,
        allowed.join(", "),
        `请将 ${fieldName} 设为允许值之一。`,
      ),
    );
    return null;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    errors.push(
      threePart(
        `${fieldName}="${value}" 不是可识别的值`,
        allowed.join(", "),
        `请将 ${fieldName} 设为允许值之一。`,
      ),
    );
    return null;
  }
  return value as T;
}

/**
 * 按冻结契约校验候选记录。成功时返回类型化记录，失败时返回三段式错误消息列表
 * （每个违规字段一条；一次性报告全部问题，避免操作人员逐个错误重试）。
 *
 * 严格模式：拒绝 REQUIRED_RECORD_FIELDS 之外的任何字段
 * （HG-2——字段集完整性；“不合并或丢弃字段”）。
 */
export function validateRecord(raw: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: [
        threePart(
          "记录不是对象",
          "包含 10 个必填字段的对象",
          "请参阅 conventions/operator-context-mode-system/README.md 的组件 3 了解 schema。",
        ),
      ],
    };
  }

  // HG-2——字段集完整性。同时拒绝缺失和多余字段。约定规定：“发布当前模式工件的任何
  // 后代记录都必须包含全部十个字段，任何字段都不得被静默合并或丢弃。”
  for (const field of REQUIRED_RECORD_FIELDS) {
    if (!(field in raw)) {
      errors.push(
        threePart(
          `缺少必填字段 "${field}"`,
          REQUIRED_RECORD_FIELDS.join(", "),
          `请将该字段添加到记录中。参见约定的组件 3。`,
        ),
      );
    }
  }
  const requiredSet = new Set<string>(REQUIRED_RECORD_FIELDS);
  for (const key of Object.keys(raw)) {
    if (!requiredSet.has(key)) {
      errors.push(
        threePart(
          `未知字段 "${key}"`,
          REQUIRED_RECORD_FIELDS.join(", "),
          `请删除未知字段。v0 的 schema 是封闭的；扩展需要 Mode 1.5 修订。`,
        ),
      );
    }
  }
  // 若字段集完整性已失败，则提前返回，使操作人员只看到结构错误，而不会看到连锁产生的
  // 逐字段噪声。
  if (errors.length > 0) return { ok: false, errors };

  const autonomy_scope = checkEnum<AutonomyScope>(
    "autonomy_scope",
    raw["autonomy_scope"],
    ALLOWED_AUTONOMY_SCOPES,
    errors,
  );
  const heartbeat_cadence = checkEnum<HeartbeatCadence>(
    "heartbeat_cadence",
    raw["heartbeat_cadence"],
    ALLOWED_HEARTBEAT_CADENCES,
    errors,
  );
  const inspection_depth = checkEnum<InspectionDepth>(
    "inspection_depth",
    raw["inspection_depth"],
    ALLOWED_INSPECTION_DEPTHS,
    errors,
  );
  const update_detail = checkEnum<UpdateDetail>(
    "update_detail",
    raw["update_detail"],
    ALLOWED_UPDATE_DETAILS,
    errors,
  );
  const escalation_threshold = checkEnum<EscalationThreshold>(
    "escalation_threshold",
    raw["escalation_threshold"],
    ALLOWED_ESCALATION_THRESHOLDS,
    errors,
  );
  const concurrency_limit = checkEnum<ConcurrencyLimit>(
    "concurrency_limit",
    raw["concurrency_limit"],
    ALLOWED_CONCURRENCY_LIMITS,
    errors,
  );

  // HG-SAFE（运行时）——类型系统在编译期阻止自动接受；此分支则在运行时拒绝绕过类型的
  // 输入（JSON / 环境变量 / HTTP 正文）。校验器不容许任何 "auto*" / "yes_to_all" 等值；
  // 它只接受三个 SAFE 值。
  const permission_prompt_posture = checkEnum<PermissionPromptPosture>(
    "permission_prompt_posture",
    raw["permission_prompt_posture"],
    SAFE_PERMISSION_PROMPT_POSTURES,
    errors,
  );

  const scope = checkEnum<OperatorContextScope>(
    "scope",
    raw["scope"],
    OPERATOR_CONTEXT_SCOPES,
    errors,
  );

  const expiry_or_stale_rule = checkEnum<ExpiryOrStaleRule>(
    "expiry_or_stale_rule",
    raw["expiry_or_stale_rule"],
    STALE_RULES,
    errors,
  );

  const evidence_citation_raw = raw["evidence_citation"];
  if (typeof evidence_citation_raw !== "string") {
    errors.push(
      threePart(
        `evidence_citation 不是字符串（收到 ${typeof evidence_citation_raw}）`,
        "非空来源引用字符串（例如 qitem 标识、文件路径、聊天室主题）",
        "请按约定的“引用规则”提供简短引用。",
      ),
    );
  } else if (evidence_citation_raw.trim().length === 0) {
    errors.push(
      threePart(
        "evidence_citation 为空",
        "非空来源引用字符串",
        "请按约定的“引用规则”提供简短引用。",
      ),
    );
  }

  if (
    errors.length > 0
    || autonomy_scope === null
    || heartbeat_cadence === null
    || inspection_depth === null
    || update_detail === null
    || escalation_threshold === null
    || concurrency_limit === null
    || permission_prompt_posture === null
    || scope === null
    || expiry_or_stale_rule === null
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    record: {
      autonomy_scope,
      heartbeat_cadence,
      inspection_depth,
      update_detail,
      escalation_threshold,
      concurrency_limit,
      permission_prompt_posture,
      scope,
      expiry_or_stale_rule,
      evidence_citation: (evidence_citation_raw as string).trim(),
    },
  };
}

/**
 * 校验操作人员提供的模式名。模式位于 10 字段记录之外（属于组件 2 词汇，而非组件 3 设置）。
 * route 与 store 在绑定边界调用它；下方用于调用解析的消歧器与其分离。
 */
export function validateModeName(raw: unknown): { ok: true; mode: OperatorContextMode } | { ok: false; error: string } {
  if (typeof raw !== "string") {
    return { ok: false, error: threePart(`mode 不是字符串（收到 ${typeof raw}）`, OPERATOR_CONTEXT_MODES.join(", "), "请提供六个保留模式名之一。") };
  }
  if (!(OPERATOR_CONTEXT_MODES as readonly string[]).includes(raw)) {
    return { ok: false, error: threePart(`mode="${raw}" 不是可识别的模式名`, OPERATOR_CONTEXT_MODES.join(", "), "请提供六个保留模式名之一。参见约定的组件 2。") };
  }
  return { ok: true, mode: raw as OperatorContextMode };
}

/**
 * 对操作人员提供的模式输入消歧。根据约定的组件 4“裸词消歧”：
 *
 * - 属于六个保留模式之一的裸词 → 调用
 * - 带显式 `mode:` 前缀 → 调用
 * - 嵌入句子中的词 → 不是调用（调用方将其视为主题）
 *
 * 输入可明确判定为调用时返回规范模式名，否则返回 null。对于 null + 裸多词输入，调用方
 * 按“一次询问”约定发出澄清问题。
 */
export function disambiguateModeInvocation(rawInput: string): OperatorContextMode | null {
  const trimmed = rawInput.trim();
  if (trimmed.length === 0) return null;

  // 显式前缀优先。
  const prefixMatch = trimmed.match(/^mode\s*:\s*(\S+)/i);
  if (prefixMatch) {
    const candidate = prefixMatch[1]!.toLowerCase();
    if ((OPERATOR_CONTEXT_MODES as readonly string[]).includes(candidate)) {
      return candidate as OperatorContextMode;
    }
    return null;
  }

  // 裸词：恰好一个词，且是保留模式。
  if (/^\S+$/.test(trimmed)) {
    const lower = trimmed.toLowerCase();
    if ((OPERATOR_CONTEXT_MODES as readonly string[]).includes(lower)) {
      return lower as OperatorContextMode;
    }
    return null;
  }

  // 嵌入句子——由调用方询问。
  return null;
}
