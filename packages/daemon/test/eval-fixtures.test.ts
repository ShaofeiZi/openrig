import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../src/domain/context-packs/manifest-parser.js";
import { loadEvalCasesFromDir } from "./helpers/eval-cases.js";

// slice-07 R6——种子 fixture 库必须是 daemon 可提供的有效 pack，并覆盖 eval 用例预期
// seat 拉取的每个引用。通过 daemon 自身的 parseManifest（而非第二个解析器）验证，
// 使格式错误的 fixture 在此失败，而不是在实时提供时失败。
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "..", "..", "test-system", "evals", "fixtures");
const CASES_DIR = resolve(HERE, "..", "..", "test-system", "evals", "cases");

/** fixtures/ 下每个包含 manifest.yaml 的目录，表示为相对于 fixtures/ 的引用路径。 */
function fixtureRefs(): string[] {
  const refs: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const abs = join(dir, entry.name);
      const ref = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (existsSync(join(abs, "manifest.yaml"))) refs.push(ref);
      else walk(abs, ref);
    }
  };
  walk(FIXTURES, "");
  return refs;
}

describe("eval 种子 fixture——覆盖用例引用的有效 pack", () => {
  const refs = fixtureRefs();

  it("每个 fixture manifest 都可通过 daemon 解析器解析", () => {
    for (const ref of refs) {
      const p = join(FIXTURES, ref, "manifest.yaml");
      expect(() => parseManifest(readFileSync(p, "utf-8"), p)).not.toThrow();
    }
  });

  it("覆盖用例预期 seat 拉取的每个引用", () => {
    const { cases } = loadEvalCasesFromDir(CASES_DIR);
    // 每个 expectedPattern 都是 `rig context get\s+<ref>`；提取尾部引用。
    const wanted = new Set<string>();
    for (const c of cases) {
      for (const p of c.expectedPatterns) {
        const m = /rig context get\\s\+(\S+)/.exec(p);
        if (m) wanted.add(m[1]!);
      }
    }
    const have = new Set(refs);
    const missing = [...wanted].filter((r) => !have.has(r));
    expect(missing).toEqual([]);
  });
});
