// OPR.0.5.3.5 Atom 3——组合代数（已锁定规范，创始人细化）：
//   FRESH           = 基础遍历（标记 fresh 的 atom）
//   HANDOVER        = FRESH + 交接材料（标记 handover 的 atom）
//   POST-COMPACTION = fresh 子集（标记 post-compaction 的 atom）+ 对 requires 闭合的交接材料
// 每个 profile 都对 requires 闭包；子集 profile 也必须闭合，这是接入规则。按 mini-req 3 做 runtime
// 过滤；claude 与 codex 会组合出不同 profile，绝不假设二者相同。Piece 通过 Atom-1 地址机制解析，
// 携带逐 piece 来源标签（Q2 修订 1 的多来源绑定契约）。预算在组合时评估，并报告超额值与按优先级
// 排序的丢弃候选；组合绝不静默截断（mini-req 9，D2：预算只提示，不支配）。

import { describe, it, expect } from "vitest";
import type { ContextPackAtom } from "../src/domain/context-packs/context-pack-types.js";
import { composeProfile, ProfileComposeError } from "../src/domain/context-packs/profile-composer.js";

const FILES: Record<string, string> = {
  "ontology.md": [
    "## Identity",
    "who you are",
    "## Affordances",
    "what you can do",
    "### Verbs",
    "send and capture",
  ].join("\n"),
  "recap.md": ["## Recent Decisions", "we chose X because Y"].join("\n"),
  "walk.md": ["## Welcome", "hello"].join("\n"),
};

const readFile = (ref: string): string => {
  const text = FILES[ref];
  if (text === undefined) throw new Error(`no such file ${ref}`);
  return text;
};

function atom(over: Partial<ContextPackAtom> & { id: string; address: string }): ContextPackAtom {
  return {
    taxonomy: "world",
    situations: ["fresh"],
    purpose: "depth",
    runtime: "any",
    order: 0,
    priority: "core",
    ...over,
  } as ContextPackAtom;
}

const GRAPH: ContextPackAtom[] = [
  atom({ id: "welcome", address: "walk.md#welcome", order: 1, situations: ["fresh"] }),
  atom({ id: "identity", address: "ontology.md#identity", order: 2, situations: ["fresh"] }),
  atom({ id: "affordances", address: "ontology.md#affordances", order: 3, purpose: "width", situations: ["fresh", "post-compaction"], requires: ["identity"] }),
  atom({ id: "recap", address: "recap.md#recent-decisions", order: 9, taxonomy: "lore", situations: ["handover"] }),
];

describe("composeProfile——单一 atom 图上的 situation 代数（mini-req 5）", () => {
  it("FRESH 是有序基础遍历；HANDOVER 是 FRESH + 交接材料", () => {
    const fresh = composeProfile({ atoms: GRAPH, situation: "fresh", runtime: "claude", readFile });
    expect(fresh.pieces.map((p) => p.atomId)).toEqual(["welcome", "identity", "affordances"]);
    const handover = composeProfile({ atoms: GRAPH, situation: "handover", runtime: "claude", readFile });
    expect(handover.pieces.map((p) => p.atomId)).toEqual(["welcome", "identity", "affordances", "recap"]);
  });

  it("POST-COMPACTION 是已标记子集 + 交接材料，并对 requires 闭包", () => {
    const pc = composeProfile({ atoms: GRAPH, situation: "post-compaction", runtime: "claude", readFile });
    // affordances 已标记；identity 只通过 requires 闭包加入；recap 是交接材料；
    // welcome 仅用于 fresh，因此缺失。
    expect(pc.pieces.map((p) => p.atomId)).toEqual(["identity", "affordances", "recap"]);
  });

  it("piece 携带已解析 span 与来源标签（Q2 修订 1 契约）", () => {
    const pc = composeProfile({ atoms: GRAPH, situation: "post-compaction", runtime: "claude", readFile });
    const aff = pc.pieces.find((p) => p.atomId === "affordances")!;
    expect(aff.text).toContain("what you can do");
    expect(aff.text).toContain("### Verbs"); // full span: children included (Q1)
    expect(aff.sourceKind).toBe("library"); // default; project/seat/mission label via sourceKindFor
    const labelled = composeProfile({
      atoms: GRAPH, situation: "post-compaction", runtime: "claude", readFile,
      sourceKindFor: (a) => (a.taxonomy === "lore" ? "seat" : "library"),
    });
    expect(labelled.pieces.find((p) => p.atomId === "recap")!.sourceKind).toBe("seat");
  });
});

describe("composeProfile——runtime 分流（mini-req 3）", () => {
  it("claude 与 codex 从同一图组合出可测量的不同 profile", () => {
    const graph = [
      ...GRAPH,
      atom({ id: "claude-only", address: "walk.md", order: 4, runtime: "claude", situations: ["fresh"] }),
      atom({ id: "codex-only", address: "walk.md", order: 5, runtime: "codex", situations: ["fresh"] }),
    ];
    const claude = composeProfile({ atoms: graph, situation: "fresh", runtime: "claude", readFile });
    const codex = composeProfile({ atoms: graph, situation: "fresh", runtime: "codex", readFile });
    expect(claude.pieces.map((p) => p.atomId)).toContain("claude-only");
    expect(claude.pieces.map((p) => p.atomId)).not.toContain("codex-only");
    expect(codex.pieces.map((p) => p.atomId)).toContain("codex-only");
    expect(codex.pieces.map((p) => p.atomId)).not.toContain("claude-only");
  });

  it("跨越 runtime 过滤器的 requires 闭包会明确失败（绝不削薄遍历）", () => {
    const graph = [
      atom({ id: "base", address: "walk.md", order: 1, runtime: "codex", situations: ["fresh"] }),
      atom({ id: "top", address: "ontology.md#identity", order: 2, runtime: "any", situations: ["fresh"], requires: ["base"] }),
    ];
    expect(() => composeProfile({ atoms: graph, situation: "fresh", runtime: "claude", readFile }))
      .toThrow(ProfileComposeError);
    expect(() => composeProfile({ atoms: graph, situation: "fresh", runtime: "claude", readFile }))
      .toThrow(/base.*runtime|runtime.*base/);
  });
});

describe("composeProfile——明确失败的解析（贯穿 Atom-1 契约）", () => {
  it("文件缺失会停止组合并点名 atom", () => {
    const graph = [atom({ id: "ghosty", address: "ghost.md#nope", order: 1 })];
    expect(() => composeProfile({ atoms: graph, situation: "fresh", runtime: "claude", readFile }))
      .toThrow(/ghosty/);
  });

  it("地址无匹配项时停止组合（绝不削薄遍历）", () => {
    const graph = [atom({ id: "misaddressed", address: "walk.md#not-there", order: 1 })];
    expect(() => composeProfile({ atoms: graph, situation: "fresh", runtime: "claude", readFile }))
      .toThrow(/misaddressed|not-there/);
  });
});

describe("composeProfile——组合时预算（mini-req 9，D2）", () => {
  it("超预算时报告超额量和按优先级排序的丢弃候选，不截断任何内容", () => {
    const graph = [
      atom({ id: "must", address: "ontology.md#identity", order: 1, priority: "core" }),
      atom({ id: "nice", address: "ontology.md#affordances", order: 2, priority: "recommended" }),
      atom({ id: "extra", address: "recap.md#recent-decisions", order: 3, priority: "optional", situations: ["fresh"] }),
    ];
    const composed = composeProfile({ atoms: graph, situation: "fresh", runtime: "claude", readFile, budgetTokens: 1 });
    expect(composed.pieces).toHaveLength(3); // never silently truncated
    expect(composed.budget).toBeDefined();
    expect(composed.budget!.limitTokens).toBe(1);
    expect(composed.budget!.overageTokens).toBeGreaterThan(0);
    // 丢弃候选：optional 优先，其次 recommended，最后 core。
    expect(composed.budget!.dropCandidates.map((d) => d.atomId)).toEqual(["extra", "nice", "must"]);
  });

  it("预算内不生成预算报告", () => {
    const graph = [atom({ id: "small", address: "walk.md#welcome", order: 1 })];
    const composed = composeProfile({ atoms: graph, situation: "fresh", runtime: "claude", readFile, budgetTokens: 100000 });
    expect(composed.budget).toBeUndefined();
    expect(composed.totalEstimatedTokens).toBeGreaterThan(0);
  });
});
