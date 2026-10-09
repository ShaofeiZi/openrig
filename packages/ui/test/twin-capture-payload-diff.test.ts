// OPR.0.4.1.11.2（FR-4）——data-medium 捕获：非视觉/data-shape slice 的确定性 payload before/after 产物
//（intent.png 的 data-medium 等价物）。纯函数 + 确定性
//（稳定键序、已排序变更路径），使同一 before/after 总产出同一产物。
import { describe, it, expect } from "vitest";
import { canonicalJson, diffPaths, buildPayloadDiff } from "../twin/capture/payload-diff.js";

describe("payload-diff (OPR.0.4.1.11.2 FR-4: data-medium before/after artifact)", () => {
  it("canonicalJson is stable regardless of key insertion order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{\n  "a": 2,\n  "b": 1\n}');
  });

  it("diffPaths reports added / removed / changed leaf paths (sorted, deterministic, deep)", () => {
    const before = { keep: 1, change: "old", gone: true, nested: { x: 1 } };
    const after = { keep: 1, change: "new", added: 5, nested: { x: 2 } };
    expect(diffPaths(before, after)).toEqual([
      "added (+): added",
      "changed (~): change",
      "changed (~): nested.x",
      "removed (-): gone",
    ]);
  });

  it("buildPayloadDiff assembles BEFORE / AFTER canonical + CHANGED sections", () => {
    const art = buildPayloadDiff({ before: { a: 1 }, after: { a: 2 } });
    expect(art).toContain("# 之前");
    expect(art).toContain("# 之后");
    expect(art).toContain("# 变更");
    expect(art).toContain("changed (~): a");
  });
});
