import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalCase } from "./helpers/eval-grader.js";
import { resolveCaseRefs, unresolvedCases, buildProductionPackage } from "./helpers/eval-ref-resolution.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");

// slice-07 复审 HIGH-1——共享校验器会针对给定生产 package 目录逐用例解析，
// 因此无引用、引用缺失或非规范引用的用例会按名称失败。一个很小的伪生产目录足以测试
// 纯校验器；afterAll 会将其清理（复审 MEDIUM-2：无临时目录泄漏）。
const prod = mkdtempSync(join(tmpdir(), "eval-ref-res-"));
afterAll(() => rmSync(prod, { recursive: true, force: true }));
mkdirSync(join(prod, "skills/core/known"), { recursive: true });
writeFileSync(join(prod, "skills/core/known/manifest.yaml"), 'name: known\nversion: "1"\ntaxonomy: skills\nfiles: []\n');

const CASES: EvalCase[] = [
  { id: "good", name: "x", category: "selection", prompt: "p", expectedPatterns: ["rig context get\\s+skills/core/known"] },
  { id: "bad-absent", name: "x", category: "selection", prompt: "p", expectedPatterns: ["rig context get\\s+skills/core/absent"] },
  { id: "bad-bare", name: "x", category: "selection", prompt: "p", expectedPatterns: ["rig context get\\s+core/known"] },
  { id: "bad-noref", name: "x", category: "selection", prompt: "p", expectedPatterns: ["do the thing"] },
  // slice-05 Q3 行为用例——断言可观察行为，没有 context-pull 契约，
  // 因此生产引用预检绝不能拒绝它（复审 HIGH-1）。
  { id: "behavior-observable", name: "x", category: "behavior", prompt: "p", expectedPatterns: ["rig context (get|profile)"] },
];

describe("eval-ref-resolution — per-case, by name", () => {
  const res = resolveCaseRefs(CASES, prod);

  it("每个用例恰好产生一个解析结果", () => {
    expect(res).toHaveLength(CASES.length);
  });

  it("解析存在的规范引用", () => {
    expect(res.find((r) => r.caseId === "good")?.resolved).toBe(true);
  });

  it("仅标记 SELECTION/LOADING 用例（缺失、裸值、无引用），绝不标记行为用例", () => {
    // 行为用例没有 context-pull 契约，因此不属于被拒绝用例。
    expect(unresolvedCases(res).map((r) => r.caseId).sort()).toEqual(["bad-absent", "bad-bare", "bad-noref"]);
    expect(res.find((r) => r.caseId === "bad-noref")?.ref).toBeNull();
    expect(res.find((r) => r.caseId === "bad-bare")?.canonical).toBe(false);
  });

  it("不拒绝行为用例——它没有 context-pull 契约（复审 HIGH-1）", () => {
    const behavior = res.find((r) => r.caseId === "behavior-observable");
    expect(behavior?.requiresRef).toBe(false);
    // 当且仅当 `unresolvedCases(resolveCaseRefs(...))` 非空时，run-evals.mjs 才拒绝整次运行
    //（入口的 exit-2 预检）。在混合的选择和行为集合上固定该组合，证明入口绝不会拒绝
    // 合法行为用例，同时仍会拒绝真正损坏的选择用例。
    const refused = unresolvedCases(res);
    expect(refused.map((r) => r.caseId)).not.toContain("behavior-observable");
    expect(refused.every((r) => r.requiresRef)).toBe(true);
  });
});

describe("buildProductionPackage — cleans up its temp package (re-review MEDIUM-2)", () => {
  it("cleanup() 移除构建出的临时目录（成功后无泄漏）", () => {
    const built = buildProductionPackage(REPO);
    expect(existsSync(built.dir)).toBe(true);
    built.cleanup();
    expect(existsSync(built.dir)).toBe(false);
  });
});
