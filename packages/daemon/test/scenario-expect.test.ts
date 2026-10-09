import { describe, it, expect } from "vitest";
import {
  structuralSubsetMatch,
  containsMatch,
  pollUntilMatch,
  formatDiff,
} from "./helpers/scenario-expect.js";

// Slice 51-02——runner 无判断的 `expect` 核心：轮询已发布 surface，直到匹配成立或 `within` 耗尽；
// 超时时输出 expected-vs-last-observed DIFF 并失败（证明项 3，失败真实性）。不使用启发式。

describe("structuralSubsetMatch（`match` 模式）", () => {
  it("expected 是 actual 的深层子集时匹配", () => {
    expect(structuralSubsetMatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 2 } })).toBe(true);
    expect(structuralSubsetMatch({ a: 1 }, {})).toBe(true);
  });
  it("值不匹配或缺少 key 时失败", () => {
    expect(structuralSubsetMatch({ a: 1 }, { a: 2 })).toBe(false);
    expect(structuralSubsetMatch({ a: 1 }, { b: 1 })).toBe(false);
  });
  it("expected 数组的每个元素都与某个 actual 元素满足子集匹配时成功", () => {
    // queue list 是裸数组；“预期一个 state 为 in-progress 的 item”即 contains 语义。
    const actual = [{ id: "q1", state: "pending" }, { id: "q2", state: "in-progress", owner: "dev" }];
    expect(structuralSubsetMatch(actual, [{ state: "in-progress" }])).toBe(true);
    expect(structuralSubsetMatch(actual, [{ state: "done" }])).toBe(false);
    expect(structuralSubsetMatch(actual, [{ state: "in-progress", owner: "dev" }])).toBe(true);
  });
});

describe("containsMatch（`contains` 模式）", () => {
  it("在字符串 surface（pane/transcript）上做子串匹配", () => {
    expect(containsMatch("...seat restored and reprimed...", "restored")).toBe(true);
    expect(containsMatch("nothing here", "restored")).toBe(false);
  });
});

describe("pollUntilMatch", () => {
  const immediateSleep = async () => {};

  it("首次 observation 匹配时返回 ok", async () => {
    let calls = 0;
    const r = await pollUntilMatch({
      observe: async () => { calls++; return { state: "in-progress" }; },
      predicate: (o) => structuralSubsetMatch(o, { state: "in-progress" }),
      withinMs: 1000,
      pollIntervalMs: 100,
      now: () => 0,
      sleep: immediateSleep,
    });
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("在边界内轮询，直到后续 observation 匹配", async () => {
    const seq = [{ state: "pending" }, { state: "pending" }, { state: "in-progress" }];
    let i = 0;
    let t = 0;
    const r = await pollUntilMatch({
      observe: async () => seq[Math.min(i++, seq.length - 1)],
      predicate: (o) => structuralSubsetMatch(o, { state: "in-progress" }),
      withinMs: 1000,
      pollIntervalMs: 100,
      now: () => (t += 100),
      sleep: immediateSleep,
    });
    expect(r.ok).toBe(true);
    expect(i).toBe(3);
  });

  it("`within` 耗尽时以最后观察值和 DIFF 失败", async () => {
    let t = 0;
    const r = await pollUntilMatch({
      observe: async () => ({ state: "pending" }),
      predicate: (o) => structuralSubsetMatch(o, { state: "in-progress" }),
      expected: { state: "in-progress" }, // 只用于在超时时渲染 DIFF。
      withinMs: 300,
      pollIntervalMs: 100,
      now: () => (t += 150), // 约 2 次轮询后耗尽。
      sleep: immediateSleep,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.lastObserved).toEqual({ state: "pending" });
      expect(r.diff).toContain("预期");
      expect(r.diff).toContain("in-progress"); // 未满足的预期。
      expect(r.diff).toContain("pending"); // 最后观察值。
    }
  });

  it("即使边界为零也至少轮询一次（真实 last-observed）", async () => {
    let calls = 0;
    const r = await pollUntilMatch({
      observe: async () => { calls++; return { state: "x" }; },
      predicate: () => false,
      withinMs: 0,
      pollIntervalMs: 100,
      now: () => 0,
      sleep: immediateSleep,
    });
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(r.ok).toBe(false);
  });
});

describe("formatDiff", () => {
  it("以可读方式同时渲染 expected 与 last-observed", () => {
    const d = formatDiff({ state: "in-progress" }, { state: "pending" });
    expect(d).toContain("预期");
    expect(d).toContain("最后观察值");
    expect(d).toContain("in-progress");
    expect(d).toContain("pending");
  });
});

describe("D11——contains 匹配已发布文本 surface 结构，而不只匹配裸字符串", () => {
  it("在 capture payload {ok, sessionName, content, lines} 内匹配", () => {
    const capture = {
      ok: true,
      sessionName: "dev-alpha@scn-scripts",
      content: "[stub-runner] READY\n[alpha-script] per-seat delivery reached alpha\n",
      lines: 20,
    };
    expect(containsMatch(capture, "[alpha-script]")).toBe(true);
    expect(containsMatch(capture, "[beta-script]")).toBe(false);
  });

  it("在 transcript payload {session, lines, content, ingestHealth} 内匹配", () => {
    const transcript = { session: "dev-alpha@r", lines: 3, content: "restored\n", ingestHealth: "ok" };
    expect(containsMatch(transcript, "restored")).toBe(true);
  });

  it("仍匹配裸字符串，且绝不匹配没有文本字段的结构", () => {
    expect(containsMatch("plain text here", "text")).toBe(true);
    expect(containsMatch({ sessionName: "needle-in-the-name" }, "needle")).toBe(false);
    expect(containsMatch(null, "x")).toBe(false);
    expect(containsMatch({ content: 42 }, "42")).toBe(false);
  });
});
