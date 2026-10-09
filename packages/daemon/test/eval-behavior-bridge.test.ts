// OPR.0.5.3.5 Q3 harness bridge（mini-req 8，已修订）——slice-05 behavior probe 与
// slice-07 selection case 在同一个 live-model eval harness 中运行，使用独立 case category；
// 不设第二套 runner。另含已处置的 Atom-2 probe key-gate note（r1）：atom probe shape 与
// EvalCase 对齐——`rubric` 与 `expectedPatterns` 成为 closed set 内的合法 probe key，
// 避免自然误写被静默丢弃。

import { describe, it, expect } from "vitest";
import { validateEvalCase } from "./helpers/eval-schema.js";
import { loadEvalCasesFromDir } from "./helpers/eval-cases.js";
import { runEvals } from "./helpers/eval-runner.js";
import { FakeProvider } from "./helpers/eval-provider.js";
import { parseManifest } from "../src/domain/context-packs/manifest-parser.js";
import { compileAtomProbesToEvalCases } from "../src/domain/context-packs/probe-eval-bridge.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MANIFEST = `
name: world-install
version: "1"
taxonomy: world
files:
  - { path: walk.md, role: world }
atoms:
  - id: affordance-width
    address: "walk.md#affordances"
    taxonomy: world
    situations: [fresh, post-compaction]
    purpose: width
    order: 20
    priority: core
    probe:
      prompt: "What can I do here?"
      expect: "Names the profile route and source-labelled pieces."
      expectedPatterns: ['rig context (get|profile)']
      rubric: |
        1 - names nothing
        5 - names the verb family and the labels
  - id: no-probe
    address: walk.md
    taxonomy: world
    situations: [fresh]
    purpose: depth
    order: 1
    priority: optional
`;

describe("behavior category——schema 接纳 slice-05 case kind（mini-req 8）", () => {
  it("behavior case 通过校验；behavior case 上的 order 被拒绝（order 仅适用于 loading）", () => {
    const ok = validateEvalCase({
      id: "beh-01", name: "affordance width returns", category: "behavior",
      prompt: "What can I do here?", expectedPatterns: ["rig context (get|profile)"], rubric: "1-5",
    });
    expect(ok.ok).toBe(true);
    const withOrder = validateEvalCase({
      id: "beh-02", name: "x", category: "behavior", prompt: "p",
      expectedPatterns: ["a"], order: { before: "a", after: "b" },
    });
    expect(withOrder.ok).toBe(false);
  });
});

describe("probe key-gate reconciliation（已处置的 Atom-2 note）", () => {
  it("expectedPatterns 与 rubric 是合法 probe key；pattern 必须可编译；未知 probe key 会明确拒绝", () => {
    const m = parseManifest(MANIFEST, "m.yaml");
    const probe = m.atoms![0]!.probe!;
    expect(probe.expectedPatterns).toEqual(["rig context (get|profile)"]);
    expect(probe.rubric).toContain("names the verb family");
    expect(() => parseManifest(MANIFEST.replace("expectedPatterns: ['rig context (get|profile)']", "expectedPatterns: ['(unclosed']"), "m.yaml"))
      .toThrow(/正则表达式源码/);
    expect(() => parseManifest(MANIFEST.replace("rubric:", "rubrics:"), "m.yaml"))
      .toThrow(/未知字段.*rubrics|rubrics.*未知字段/);
  });
});

describe("compileAtomProbesToEvalCases——atom 作为数据送入唯一 harness，不设第二套 runner", () => {
  it("已 probe atom 编译为 behavior-category case 数据，并通过 harness 自身 schema 校验", () => {
    const m = parseManifest(MANIFEST, "m.yaml");
    const { cases, skipped } = compileAtomProbesToEvalCases(m, "packs/world");
    expect(cases).toHaveLength(1); // no-probe atom absent entirely
    expect(skipped).toEqual([]);
    const c = cases[0]! as Record<string, unknown>;
    expect(c["category"]).toBe("behavior");
    expect(c["id"]).toBe("packs/world/affordance-width");
    expect(c["prompt"]).toBe("What can I do here?");
    const validated = validateEvalCase(c);
    expect(validated.ok).toBe(true);
  });

  it("缺少 expectedPatterns 的 probe 没有 deterministic-door 分支：带报告跳过，不产生无效 case，也不静默", () => {
    // harness schema 要求非空 expectedPatterns——编译空 array 会发出下游 schema 拒绝的 case。
    // bridge 拒绝从 prose 伪造 pattern，也拒绝静默丢失 atom：skip 会具名并说明原因。
    const patternless = MANIFEST
      .replace("      expectedPatterns: ['rig context (get|profile)']\n", "")
      .replace(/      rubric: \|\n        1 - names nothing\n        5 - names the verb family and the labels\n/, "");
    const m = parseManifest(patternless, "m.yaml");
    const { cases, skipped } = compileAtomProbesToEvalCases(m, "packs/world");
    expect(cases).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.atomId).toBe("affordance-width");
    expect(skipped[0]!.reason).toMatch(/expectedPatterns/);
  });
});

describe("单一 HARNESS（door shape）：同一次调用评估 behavior + selection", () => {
  it("loadEvalCasesFromDir + runEvals 对混合目录一次记录两个 category 的 grade", async () => {
    const dir = mkdtempSync(join(tmpdir(), "s05-evals-"));
    try {
      writeFileSync(join(dir, "selection.yaml"), [
        "- id: sel-x",
        "  name: selects the entry",
        "  category: selection",
        "  prompt: \"bring the fleet back\"",
        "  expectedPatterns: ['rig context get\\s+core/rig-lifecycle']",
      ].join("\n"));
      writeFileSync(join(dir, "behavior.yaml"), [
        "- id: beh-x",
        "  name: affordance width returns",
        "  category: behavior",
        "  prompt: \"What can I do here?\"",
        "  expectedPatterns: ['rig context (get|profile)']",
      ].join("\n"));
      const { cases, errors } = loadEvalCasesFromDir(dir);
      expect(errors).toEqual([]);
      expect(cases.map((c) => c.category).sort()).toEqual(["behavior", "selection"]);
      const provider = new FakeProvider({
        "bring the fleet back": "I'll run rig context get core/rig-lifecycle first",
        "What can I do here?": "rig context profile serves labelled pieces",
      });
      const summary = await runEvals(cases, provider);
      expect(summary.total).toBe(2);
      expect(Object.keys(summary.byCategory).sort()).toEqual(["behavior", "selection"]);
      expect(summary.passed).toBe(2); // both transcripts match their patterns
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
