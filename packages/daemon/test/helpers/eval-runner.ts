/**
 * slice-07 R6——eval 运行器。把每个 case 经 provider 驱动跑一遍，在确定性 DOOR 处给捕获的
 * transcript 打分，并产出记录的 grades + 汇总。对注入 provider 的纯编排——这里不访问模型。
 */

import { grade, type EvalCase, type GradeResult } from "./eval-grader.js";
import type { EvalProvider } from "./eval-provider.js";

export interface CaseOutcome {
  case: EvalCase;
  transcript: string;
  grade: GradeResult;
  /** provider 执行 case 失败时设置（与打分 FAIL 不同）。 */
  error?: string;
}

export interface EvalRunSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  byCategory: Record<string, { total: number; passed: number }>;
  outcomes: CaseOutcome[];
}

/** 把每个 case 经 provider + door 打分器跑一遍。记录的 grades 随每个 CaseOutcome 携带。 */
export async function runEvals(cases: EvalCase[], provider: EvalProvider): Promise<EvalRunSummary> {
  const outcomes: CaseOutcome[] = [];

  for (const evalCase of cases) {
    let transcript = "";
    let error: string | undefined;
    try {
      const result = await provider.run(evalCase.prompt);
      if (result.error) error = result.error;
      else transcript = result.transcript;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    if (error !== undefined) {
      outcomes.push({
        case: evalCase,
        transcript: "",
        grade: { caseId: evalCase.id, category: evalCase.category, pass: false, patternResults: [] },
        error,
      });
    } else {
      outcomes.push({ case: evalCase, transcript, grade: grade(evalCase, transcript) });
    }
  }

  const byCategory: Record<string, { total: number; passed: number }> = {};
  let passed = 0;
  let failed = 0;
  let errored = 0;
  for (const outcome of outcomes) {
    const cat = outcome.case.category;
    byCategory[cat] ??= { total: 0, passed: 0 };
    byCategory[cat].total += 1;
    if (outcome.error !== undefined) {
      errored += 1;
    } else if (outcome.grade.pass) {
      passed += 1;
      byCategory[cat].passed += 1;
    } else {
      failed += 1;
    }
  }

  return { total: outcomes.length, passed, failed, errored, byCategory, outcomes };
}
