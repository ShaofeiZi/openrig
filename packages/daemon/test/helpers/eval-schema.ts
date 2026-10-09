/**
 * slice-07 R6——eval-case 格式与验证器（镜像 scenario-schema 明确、具名的错误纪律）。Eval case
 * 是声明式数据（YAML/JSON），因此保持人类可读且不携带跨包 TS import；此纯验证器将解析后的 case
 * 对象转换为类型化 EvalCase 或完整的具名错误列表，绝不静默为空操作。
 */

import type { EvalCase, EvalCategory } from "./eval-grader.js";

const CATEGORIES: readonly EvalCategory[] = ["selection", "loading", "behavior"];

export type EvalCaseErrorCode =
  | "EVAL_NOT_OBJECT"
  | "ID_MISSING"
  | "NAME_MISSING"
  | "UNKNOWN_CATEGORY"
  | "PROMPT_MISSING"
  | "EXPECTED_PATTERNS_MISSING"
  | "PATTERN_NOT_REGEX"
  | "FORBIDDEN_NOT_ARRAY"
  | "ORDER_MISSING_FOR_LOADING"
  | "ORDER_ON_SELECTION"
  | "ORDER_PATTERN_INVALID"
  | "RUBRIC_NOT_STRING";

export interface EvalCaseError {
  code: EvalCaseErrorCode;
  message: string;
  path: string;
}

export type ValidateEvalCaseResult =
  | { ok: true; case: EvalCase }
  | { ok: false; errors: EvalCaseError[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCompilableRegex(source: unknown): boolean {
  if (typeof source !== "string") return false;
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/**
 * 验证解析后的 eval-case 对象。收集全部错误（明确、完整）。纯函数，无 I/O。
 */
export function validateEvalCase(doc: unknown): ValidateEvalCaseResult {
  if (!isPlainObject(doc)) {
    return { ok: false, errors: [{ code: "EVAL_NOT_OBJECT", message: "eval case 必须是 mapping/object", path: "" }] };
  }
  const errors: EvalCaseError[] = [];
  const push = (code: EvalCaseErrorCode, message: string, path: string) => errors.push({ code, message, path });

  if (typeof doc.id !== "string" || doc.id.length === 0) push("ID_MISSING", "id：必须是非空字符串", "id");
  if (typeof doc.name !== "string" || doc.name.length === 0) push("NAME_MISSING", "name：必须是非空字符串", "name");

  const category = doc.category;
  const knownCategory = typeof category === "string" && (CATEGORIES as readonly string[]).includes(category);
  if (!knownCategory) push("UNKNOWN_CATEGORY", `category：必须是 ${CATEGORIES.join(", ")} 之一`, "category");

  if (typeof doc.prompt !== "string" || doc.prompt.length === 0) push("PROMPT_MISSING", "prompt：必须提供非空的自然语言 prompt", "prompt");

  if (!Array.isArray(doc.expectedPatterns) || doc.expectedPatterns.length === 0) {
    push("EXPECTED_PATTERNS_MISSING", "expectedPatterns：必须是非空正则源码数组", "expectedPatterns");
  } else {
    doc.expectedPatterns.forEach((p, i) => {
      if (!isCompilableRegex(p)) push("PATTERN_NOT_REGEX", `expectedPatterns[${i}]：不是可编译的正则源码`, `expectedPatterns[${i}]`);
    });
  }

  if (doc.forbiddenPatterns !== undefined) {
    if (!Array.isArray(doc.forbiddenPatterns)) {
      push("FORBIDDEN_NOT_ARRAY", "forbiddenPatterns：存在时必须是正则源码数组", "forbiddenPatterns");
    } else {
      doc.forbiddenPatterns.forEach((p, i) => {
        if (!isCompilableRegex(p)) push("PATTERN_NOT_REGEX", `forbiddenPatterns[${i}]：不是可编译的正则源码`, `forbiddenPatterns[${i}]`);
      });
    }
  }

  const hasOrder = doc.order !== undefined;
  if (knownCategory && category === "loading" && !hasOrder) {
    push("ORDER_MISSING_FOR_LOADING", "order：loading case 需要 {getPattern, actionPattern}（get 必须先于 action）", "order");
  }
  if (knownCategory && category !== "loading" && hasOrder) {
    push("ORDER_ON_SELECTION", `order：${category} case 不得携带 order 块——get-before-action 仅适用于 loading`, "order");
  }
  if (hasOrder) {
    if (!isPlainObject(doc.order)) {
      push("ORDER_PATTERN_INVALID", "order：必须是 mapping {getPattern, actionPattern}", "order");
    } else {
      for (const key of ["getPattern", "actionPattern"] as const) {
        if (!isCompilableRegex(doc.order[key])) {
          push("ORDER_PATTERN_INVALID", `order.${key}：必须提供可编译的正则源码`, `order.${key}`);
        }
      }
    }
  }

  if (doc.rubric !== undefined && typeof doc.rubric !== "string") push("RUBRIC_NOT_STRING", "rubric：存在时必须是字符串", "rubric");

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, case: doc as unknown as EvalCase };
}
