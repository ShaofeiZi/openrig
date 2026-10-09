import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScenarioFile } from "./helpers/scenario-pipeline.js";
import type { RunRecord } from "./helpers/scenario-run-record.js";

// 51-02 delta D8（guard binding）——SCENARIO-LEVEL determinism。
//
// Guard 认为第一版 shape 是空洞的：PASS result 及其 run-record row 只携带 scenario name +
// verdict，因此将同一 passing scenario 运行两次并比较，无法证明任何 scenario-controlled
// observable 稳定。discriminator 因而运行一个故意 stable-failing 的 expect，其 DIFF 嵌入最后的
// observed value——scenario 所控制的内容只要有一个 byte 不同，就会改变比较结果。

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const INJECTED_CLOCK = "2026-08-11T00:00:00.000Z";

/** 从 byte comparison 中排除且明确点名的 runner-local field（绝不 blanket strip）：
 *  wall-clock 时长为机器计时，非 scenario 可控可观测。 */
const RUNNER_LOCAL_RECORD_FIELDS = ["durationMs"] as const;

function normalizeRecord(rec: RunRecord): Record<string, unknown> {
  const copy = { ...(rec as unknown as Record<string, unknown>) };
  for (const f of RUNNER_LOCAL_RECORD_FIELDS) delete copy[f];
  return copy;
}

function scenarioDir(): string {
  const d = mkdtempSync(join(tmpdir(), "determinism-"));
  dirs.push(d);
  writeFileSync(join(d, "topo.yaml"), [
    'version: "0.2"', "name: scn-det", "pods:", "  - id: dev", "    label: Dev",
    "    members:", "      - id: worker", '        agent_ref: "local:agents/worker"',
    "        profile: default", "        runtime: stub", "        cwd: .", "    edges: []", "",
  ].join("\n"));
  // observable output 固定的 rig bin——因此任何 run-to-run 差异都来自 runner，这正是此测试固定的内容。
  writeFileSync(join(d, "rig.mjs"), [
    'import { appendFileSync } from "node:fs";',
    'const args = process.argv.slice(2);',
    // 记录 pipeline 实际传给 child 的 clock——用于捕获 pipeline 丢弃该 option 的 caller-boundary
    // pin（此前 false-green guard 所发现的问题）
    `appendFileSync(${JSON.stringify(join(d, "clock.log"))}, String(process.env.OPENRIG_TEST_CLOCK_NOW) + "\\n");`,
    'if (args[0] === "up") { process.stdout.write(JSON.stringify({ rigId: "r1", rigName: "scn-det" })); }',
    'else if (args[0] === "queue") { process.stdout.write(JSON.stringify([{ qitemId: "fixed-1", state: "pending" }])); }',
    'else { process.stdout.write("{}"); }',
    "",
  ].join("\n"));
  // stable-FAILING expect：observed value 固定且永不匹配，因此 DIFF 携带真实 observable，
  // 而不是空 PASS row。
  writeFileSync(join(d, "s.yaml"), [
    "scenario: determinism-discriminator",
    "topology: ./topo.yaml",
    "steps:",
    "  - up: {}",
    "  - expect:",
    "      surface: queue",
    "      within: 0ms",
    "      match:",
    "        - qitemId: never-present",
    "          state: in-progress",
    "",
  ].join("\n"));
  // 对同一固定 observable 运行 passing scenario——已批准的 secondary leg（rev-2）：验证两次运行
  // 的 verdict + normalized run-record 稳定性。
  writeFileSync(join(d, "pass.yaml"), [
    "scenario: determinism-pass-twice",
    "topology: ./topo.yaml",
    "steps:",
    "  - up: {}",
    "  - expect:",
    "      surface: queue",
    "      within: 2s",
    "      match:",
    "        - qitemId: fixed-1",
    "          state: pending",
    "",
  ].join("\n"));
  return d;
}

async function runOnce(d: string, records: RunRecord[], file = "s.yaml") {
  return runScenarioFile(join(d, file), {
    rigBin: join(d, "rig.mjs"),
    baseEnv: { HOME: d, PATH: process.env.PATH, TERM: "xterm" },
    // 声明是“在 injected clock 下”——因此真正注入它
    injectClockNow: INJECTED_CLOCK,
    // 镜像真实 spawner：readEnv 从 pipeline 构建的 scaffold 派生
    //（scenario-daemon.ts:155 = {...scaffold.env, OPENRIG_URL}）。自行伪造 env 的 fake 固定的是
    // fake 而非 pipeline——这正是被丢弃 clock 此前一直不可见的原因。
    daemon: (async (scaffold: { env: Record<string, string | undefined> }) => ({
      readEnv: { ...scaffold.env, OPENRIG_URL: "http://127.0.0.1:1" },
      baseUrl: "http://127.0.0.1:1",
      sigterm: async () => {}, restart: async () => {}, stop: async () => {},
    })) as never,
    deps: {
      defaults: { withinMs: 0, pollIntervalMs: 1 },
      appendRecord: (r: RunRecord) => records.push(r),
    },
  });
}

describe("D8——同一 scenario 在 injected clock 下运行两次，关键部分逐字一致", () => {
  it("verdict、failed step 与 DIFF 的 observed value 在两次运行中一致", async () => {
    const d = scenarioDir();

    const recordsA: RunRecord[] = [];
    const recordsB: RunRecord[] = [];
    const a = await runOnce(d, recordsA);
    const b = await runOnce(d, recordsB);

    // discriminator 是携带 observed value 的真实 FAIL……
    expect(a.verdict).toBe("FAIL");
    expect(a.diff).toContain("never-present");   // expected 侧
    expect(a.diff).toContain("fixed-1");         // observed 侧——实际 byte payload
    // ……且每次运行都相同
    expect(b.verdict).toBe(a.verdict);
    expect(b.failedStep).toBe(a.failedStep);
    expect(b.diff).toBe(a.diff);
    expect(recordsB.map(normalizeRecord)).toEqual(recordsA.map(normalizeRecord));
    expect(recordsA.length).toBeGreaterThan(0);

    // CALLER-BOUNDARY PIN（guard finding 2）：pipeline 不得丢弃 injected clock。两次运行中的每次
    // child invocation 都看到相同的 injected instant——根据 child 实际收到的内容断言，而非根据我们
    // 传入的 option。
    const seen = readFileSync(join(d, "clock.log"), "utf-8").trim().split("\n");
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen)).toEqual(new Set([INJECTED_CLOCK]));
  });

  // Guard finding（fresh gate）：已批准的 rev-2 contract 在 stable-FAIL discriminator 旁指定了
  // PASS-twice secondary leg。FAIL leg 证明 observed byte 稳定；这里证明 GREEN verdict 及其 ledger
  // row 也稳定——即 scenario author 实际会重跑的日常场景。
  it("SECONDARY LEG：passing scenario 运行两次会产生相同 verdict 与 normalized record", async () => {
    const d = scenarioDir();
    const recordsA: RunRecord[] = [];
    const recordsB: RunRecord[] = [];
    const a = await runOnce(d, recordsA, "pass.yaml");
    const b = await runOnce(d, recordsB, "pass.yaml");

    expect(a.verdict).toBe("PASS");
    expect(b.verdict).toBe(a.verdict);
    expect(b.failedStep).toBe(a.failedStep); // both undefined on PASS
    expect(recordsA.length).toBeGreaterThan(0);
    expect(recordsB.map(normalizeRecord)).toEqual(recordsA.map(normalizeRecord));

    // 且两次 PASS run 看到同一 injected clock（无 wall-clock 泄漏）
    const seen = readFileSync(join(d, "clock.log"), "utf-8").trim().split("\n");
    expect(new Set(seen)).toEqual(new Set([INJECTED_CLOCK]));
  });

  it("clock 与 scenario 固定但一个 observed byte 不同时失败（pin 确实有效）", async () => {
    const d = scenarioDir();
    const recordsA: RunRecord[] = [];
    const a = await runOnce(d, recordsA);

    // 只改变 scenario 读取的 observable
    writeFileSync(join(d, "rig.mjs"), [
      'const args = process.argv.slice(2);',
      'if (args[0] === "up") { process.stdout.write(JSON.stringify({ rigId: "r1", rigName: "scn-det" })); }',
      'else if (args[0] === "queue") { process.stdout.write(JSON.stringify([{ qitemId: "fixed-2", state: "pending" }])); }',
      'else { process.stdout.write("{}"); }',
      "",
    ].join("\n"));
    const recordsB: RunRecord[] = [];
    const b = await runOnce(d, recordsB);

    expect(b.verdict).toBe(a.verdict);   // still a FAIL...
    expect(b.diff).not.toBe(a.diff);     // ...but the pin CATCHES the one-byte drift
  });

  it("injected clock 属于 scaffold 自身（拒绝 ambient clock，因此 run 不会继承时间）", async () => {
    const d = scenarioDir();
    const { prepareHermeticEnv, AmbientClockHazardError } = await import("./helpers/hermetic-env.js");
    expect(() =>
      prepareHermeticEnv({ baseEnv: { HOME: d, PATH: process.env.PATH, OPENRIG_TEST_CLOCK_NOW: INJECTED_CLOCK } }),
    ).toThrow(AmbientClockHazardError);
    const s = prepareHermeticEnv({ baseEnv: { HOME: d, PATH: process.env.PATH }, injectClockNow: INJECTED_CLOCK });
    expect(s.env.OPENRIG_TEST_CLOCK_NOW).toBe(INJECTED_CLOCK);
    s.cleanup();
  });
});
