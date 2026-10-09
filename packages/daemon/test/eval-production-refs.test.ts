import { describe, it, expect, afterAll } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvalCasesFromDir } from "./helpers/eval-cases.js";
import {
  resolveCaseRefs,
  unresolvedCases,
  buildProductionPackage,
} from "./helpers/eval-ref-resolution.js";

// slice-07 修复 1+2 复审（HIGH-1）——密闭：把精确生产 package 构建到临时目录（绝不读取被
// gitignore 的 packages/daemon/context-packs 残留），并逐 case 断言每个 case 都产生可在已构建
// package 中解析的 canonical ref。Fixture 与生产漂移或 case 没有 canonical ref 时，会按名称发生
// 结构性失败。（需要先构建后台服务：generator 通过已编译 manifest parser 验证。）
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const CASES_DIR = resolve(HERE, "..", "..", "test-system", "evals", "cases");

describe("修复（复审 HIGH-1）——ref 可在新构建的生产 package 中解析", () => {
  const { cases } = loadEvalCasesFromDir(CASES_DIR);
  const built = buildProductionPackage(REPO);
  afterAll(built.cleanup);
  const resolutions = resolveCaseRefs(cases, built.dir);

  it("为每个带 ref 的 case 产生 canonical ref（逐 case，而非整套计数）", () => {
    expect(resolutions).toHaveLength(cases.length);
    // 只有 selection/loading case 的契约要求拉取 context；behavior case（slice-05 Q3）不携带 ref，
    // 因此豁免。只在契约要求的位置强制 canonicality。
    const bad = resolutions.filter((r) => r.requiresRef && (r.ref === null || !r.canonical)).map((r) => r.caseId);
    expect(bad).toEqual([]);
  });

  it("每个 case ref 都能在已构建生产 package 中解析", () => {
    const missing = unresolvedCases(resolutions).map((r) => `${r.caseId}:${r.ref ?? "<none>"}`);
    expect(missing).toEqual([]);
  });
});
