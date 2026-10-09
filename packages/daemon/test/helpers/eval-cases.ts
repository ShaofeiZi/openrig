/**
 * slice-07 R6——eval case loader。读取声明式 YAML case 文件、解析每个列表，并通过共享 schema
 * 校验所有 case。无效 case 会被明确收集，绝不静默丢弃；runner 与一致性 guard 共用此路径。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateEvalCase } from "./eval-schema.js";
import type { EvalCase } from "./eval-grader.js";

export interface CaseLoadError {
  file: string;
  index: number;
  codes: string[];
}

export interface LoadedEvalCases {
  cases: EvalCase[];
  errors: CaseLoadError[];
}

/** 加载并校验 `dir` 下所有 eval case；每个 `*.yaml` 文件都是 case 列表。 */
export function loadEvalCasesFromDir(dir: string): LoadedEvalCases {
  const cases: EvalCase[] = [];
  const errors: CaseLoadError[] = [];
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  for (const file of files) {
    const doc = parseYaml(readFileSync(join(dir, file), "utf-8"));
    const list = Array.isArray(doc) ? doc : [doc];
    list.forEach((raw, index) => {
      const result = validateEvalCase(raw);
      if (result.ok) cases.push(result.case);
      else errors.push({ file, index, codes: result.errors.map((e) => e.code) });
    });
  }
  return { cases, errors };
}
