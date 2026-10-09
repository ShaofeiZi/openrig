import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvalCasesFromDir } from "./helpers/eval-cases.js";

// slice-07 R6——一致性防护：编写的用例集通过 schema 校验，并覆盖两个类别。这是防护测试
//（并非逻辑上的先红后绿），用于防止编写的数据发生漂移。
const HERE = dirname(fileURLToPath(import.meta.url));
// packages/daemon/test → packages/test-system/evals/cases
const CASES_DIR = resolve(HERE, "..", "..", "test-system", "evals", "cases");

describe("评估用例——编写的用例集符合要求", () => {
  const { cases, errors } = loadEvalCasesFromDir(CASES_DIR);

  it("每个编写的用例都通过 schema 校验", () => {
    expect(errors).toEqual([]);
  });

  it("覆盖选择与加载类别", () => {
    const selection = cases.filter((c) => c.category === "selection");
    const loading = cases.filter((c) => c.category === "loading");
    expect(selection.length).toBeGreaterThanOrEqual(10);
    expect(loading.length).toBeGreaterThanOrEqual(4);
  });

  it("用例 id 唯一", () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每个加载用例都包含先 get 后操作的顺序要求", () => {
    const loadingWithoutOrder = cases.filter((c) => c.category === "loading" && !c.order);
    expect(loadingWithoutOrder).toEqual([]);
  });
});
