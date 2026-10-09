import { describe, it, expect, vi } from "vitest";
import { validateScenario } from "./helpers/scenario-schema.js";
import {
  runValidatedScenario,
  parseDuration,
  type ScenarioRunnerDeps,
} from "./helpers/scenario-runner.js";
import type { RunRecord } from "./helpers/scenario-run-record.js";

// Slice 51-02——runner CORE（无判断执行器）。上游完成 parse+validate；本模块按顺序运行已验证
// scenario step：action 使用注入的 runAction，`expect` 在注入的 observe 上 poll-until-match。
// 第一个失败 step 会输出 expected-vs-last-observed DIFF，追加 FAIL run-record row，并停止。
// 全部通过则输出 PASS + 一条 PASS row。不使用启发式。

function clock(stepMs = 1000) {
  let t = 0;
  return () => (t += stepMs);
}

function makeDeps(over: Partial<ScenarioRunnerDeps> & { records?: RunRecord[] } = {}): ScenarioRunnerDeps & { records: RunRecord[] } {
  const records: RunRecord[] = over.records ?? [];
  return {
    runAction: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    observe: vi.fn(async () => ({})),
    now: clock(),
    sleep: async () => {},
    appendRecord: (r: RunRecord) => records.push(r),
    defaults: { withinMs: 1000, pollIntervalMs: 100 },
    ...over,
    records,
  };
}

const scenario = (steps: unknown[], name = "s") =>
  (validateScenario({ scenario: name, topology: "fixtures/t.yaml", steps }) as { ok: true; scenario: never }).scenario;

describe("parseDuration", () => {
  it("把相对 duration 解析为毫秒", () => {
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("5s")).toBe(5000);
    expect(parseDuration("2m")).toBe(120000);
    expect(parseDuration("1h")).toBe(3600000);
    expect(parseDuration("1500")).toBe(1500); // bare = ms
  });
});

describe("runValidatedScenario", () => {
  it("按顺序运行 action，并在每个 expect 匹配时通过", async () => {
    const deps = makeDeps({
      observe: vi.fn(async () => ({ state: "in-progress" })),
    });
    const sc = scenario([
      { up: {} },
      { send: { to: "a@r", text: "x" } },
      { expect: { surface: "queue", match: { state: "in-progress" } } },
      { down: {} },
    ]);
    const r = await runValidatedScenario(sc, deps);
    expect(r.verdict).toBe("PASS");
    // action 按顺序运行。
    expect((deps.runAction as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(["up", "send", "down"]);
    expect(deps.records.at(-1)?.verdict).toBe("PASS");
  });

  it("首个始终不匹配的 expect 处失败，并输出 DIFF、追加 FAIL record", async () => {
    const deps = makeDeps({
      observe: vi.fn(async () => ({ state: "pending" })),
      now: clock(600), // elapses the 1000ms default after ~2 polls
    });
    const sc = scenario([
      { up: {} },
      { expect: { surface: "queue", match: { state: "in-progress" } } },
      { down: {} },
    ]);
    const r = await runValidatedScenario(sc, deps);
    expect(r.verdict).toBe("FAIL");
    expect(r.failedStep).toBe(1);
    expect(r.diff).toContain("in-progress");
    expect(r.diff).toContain("pending");
    // 在 `down` 前停止。
    expect((deps.runAction as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(["up"]);
    const rec = deps.records.at(-1)!;
    expect(rec.verdict).toBe("FAIL");
    expect(rec.failedStep).toBe(1);
    expect(rec.diff).toContain("pending");
  });

  it("action 返回非零 exit 时失败", async () => {
    const deps = makeDeps({
      runAction: vi.fn(async (verb: string) => (verb === "send" ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: "", stderr: "" })),
    });
    const sc = scenario([{ up: {} }, { send: { to: "a@r", text: "x" } }, { down: {} }]);
    const r = await runValidatedScenario(sc, deps);
    expect(r.verdict).toBe("FAIL");
    expect(r.failedStep).toBe(1);
    expect(r.diff).toContain("boom");
  });

  it("支持字符串 surface 上的 contains 模式", async () => {
    const deps = makeDeps({ observe: vi.fn(async () => "...seat restored...") });
    const sc = scenario([{ expect: { surface: "pane", seat: "a@r", contains: "restored" } }]);
    expect((await runValidatedScenario(sc, deps)).verdict).toBe("PASS");
    const deps2 = makeDeps({ observe: vi.fn(async () => "nothing"), now: clock(600) });
    expect((await runValidatedScenario(sc, deps2)).verdict).toBe("FAIL");
  });

  it("遵循逐 expect 的 within 覆盖", async () => {
    let polls = 0;
    const deps = makeDeps({
      observe: vi.fn(async () => { polls++; return { state: "pending" }; }),
      now: clock(100),
    });
    const sc = scenario([{ expect: { surface: "queue", within: "250ms", match: { state: "x" } } }]);
    await runValidatedScenario(sc, deps);
    // 250ms 边界、100ms/tick，大约轮询 3 次，远少于默认 1000ms。
    expect(polls).toBeLessThanOrEqual(4);
  });
});
