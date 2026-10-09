/**
 * slice-07 R6（F1 修复）——eval 报告器。把打分结果转成一条记录项，让它自己解释自己的判定：
 * 模式结果与加载顺序诊断随记录携带，FAIL 携带人类可读原因。一个只发 pass/fail 而无原因的
 * gate，正是本版本反复击杀的那类（CE-08 消费这些 grade——它必须能区分"什么都没拉"、
 * "拉晚了"、"拉错条目"）。
 */

import type { EvalCategory, GradeResult, OrderResult, PatternResult } from "./eval-grader.js";
import type { CaseOutcome } from "./eval-runner.js";

export interface RecordedGrade {
  id: string;
  category: EvalCategory;
  pass: boolean;
  patternResults: PatternResult[];
  order: OrderResult | null;
  /** FAIL 失败的原因（pass 时为 null；provider 错误改带 `error`）。 */
  reason: string | null;
  error: string | null;
}

/** grade() 已算出的诊断中，FAIL 失败的人类可读原因。 */
export function failReason(grade: GradeResult): string {
  if (grade.order && !grade.order.ok && grade.order.reason) return grade.order.reason;
  const missing = grade.patternResults
    .filter((p) => p.type === "expected" && !p.matched)
    .map((p) => p.pattern);
  const forbidden = grade.patternResults
    .filter((p) => p.type === "forbidden" && p.matched)
    .map((p) => p.pattern);
  const parts: string[] = [];
  if (missing.length) parts.push(`未匹配 expected：${missing.join(", ")}`);
  if (forbidden.length) parts.push(`命中 forbidden：${forbidden.join(", ")}`);
  return parts.join("; ") || "打分失败";
}

/** 为一次 outcome 构建记录 grade 项——它自带支撑自己判定的证据。 */
export function recordedGrade(outcome: CaseOutcome): RecordedGrade {
  const g = outcome.grade;
  const isError = outcome.error !== undefined;
  return {
    id: outcome.case.id,
    category: outcome.case.category,
    pass: g.pass,
    patternResults: g.patternResults,
    order: g.order ?? null,
    reason: isError || g.pass ? null : failReason(g),
    error: outcome.error ?? null,
  };
}
