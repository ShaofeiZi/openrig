/**
 * Slice 51-02（L2 测试系统）—— runner 核心（无判断执行器）。
 *
 * 按顺序执行已校验场景的步骤：动作动词通过注入的 `runAction`（已发布的 `zrig`
 * 写入/生命周期调用）执行，`expect` 则对注入的 `observe`（已发布表面读取）轮询直至
 * 匹配。首个步骤失败时生成“预期值与最后观测值”差异，追加 FAIL 运行记录并停止。
 * 所有步骤通过时生成 PASS 和一条 PASS 记录。不作判断、不用启发式；一切可观测
 * 结果都由确定性逻辑判断（智能体判断属于 L3，绝不在此执行）。
 *
 * 依赖均可注入，使编排无需实时后台服务即可单元测试；真实接线提供
 * runRig/readSurface 与场景本地时钟。
 */

import type { ExpectSurface, ValidatedScenario } from "./scenario-schema.js";
import { structuralSubsetMatch, containsMatch, pollUntilMatch } from "./scenario-expect.js";
import type { RunRecord } from "./scenario-run-record.js";
import { buildDeclarativeNormalizer, isEqualsMapping } from "./scenario-normalizer.js";

export interface ActionResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ScenarioRunnerDeps {
  /** 运行动作动词（up/down/send/restart/restore/emit/mutate/policy/seed_regression/daemon）。 */
  runAction: (verb: string, payload: unknown, seat?: string) => Promise<ActionResult>;
  /** 为 `expect` 读取已发布表面。 */
  observe: (surface: ExpectSurface, opts: { seat?: string }) => Promise<unknown>;
  /** 为轮询边界注入的单调时钟（毫秒）。 */
  now: () => number;
  /** 注入的轮询间休眠函数。 */
  sleep: (ms: number) => Promise<void>;
  /** 可选的运行记录接收端（仅追加台账）。 */
  appendRecord?: (rec: RunRecord) => void;
  /** 唯一默认 within/poll 参数对（每个 expect 均可覆盖）。 */
  defaults: { withinMs: number; pollIntervalMs: number };
  /**
   * `equals` 模式的声明式跨 surface 规范化器（其最终形态
   * 随 51-03 shaping；v1 接受接口）。给定 surface + 其观测值，
   * 返回规范化比较形式。
   */
  normalizer?: (surface: ExpectSurface, value: unknown) => unknown;
}

export interface RunScenarioResult {
  scenario: string;
  verdict: "PASS" | "FAIL";
  /** 失败步骤的从零开始索引（仅 FAIL 时存在）。 */
  failedStep?: number;
  diff?: string;
}

const DURATION_RE = /^(\d+)(ms|s|m|h)?$/;

/** 将相对轮询时长解析为毫秒；裸数字表示毫秒。 */
export function parseDuration(d: string): number {
  const m = DURATION_RE.exec(d);
  if (!m) throw new Error(`invalid duration: ${JSON.stringify(d)}`);
  const n = Number(m[1]);
  switch (m[2] ?? "ms") {
    case "ms": return n;
    case "s": return n * 1000;
    case "m": return n * 60_000;
    default: return n * 3_600_000; // h
  }
}

/** 运行已校验场景的步骤，返回 PASS/FAIL 并追加运行记录。 */
export async function runValidatedScenario(
  scenario: ValidatedScenario,
  deps: ScenarioRunnerDeps,
): Promise<RunScenarioResult> {
  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i]!;
    const verb = Object.keys(step)[0]!;
    const value = step[verb];

    if (verb === "expect") {
      const failDiff = await runExpect(value as Record<string, unknown>, deps);
      if (failDiff !== null) return fail(scenario.scenario, i, failDiff, deps);
      continue;
    }

    // 动作动词。
    const seat = typeof value === "string" ? value : (value as { seat?: string } | null)?.seat;
    const res = await deps.runAction(verb, value, seat);
    if (res.code !== 0) {
      return fail(scenario.scenario, i, `action \`${verb}\` failed (exit ${res.code}): ${res.stderr || res.stdout}`, deps);
    }
  }

  const rec: RunRecord = { scenario: scenario.scenario, verdict: "PASS" };
  deps.appendRecord?.(rec);
  return { scenario: scenario.scenario, verdict: "PASS" };
}

/** 执行一个 `expect`；匹配时返回 null，失败时返回差异字符串。 */
async function runExpect(
  exp: Record<string, unknown>,
  deps: ScenarioRunnerDeps,
): Promise<string | null> {
  const surface = exp.surface as ExpectSurface;
  const seat = exp.seat as string | undefined;
  const withinMs = exp.within !== undefined ? parseDuration(String(exp.within)) : deps.defaults.withinMs;
  const pollIntervalMs = deps.defaults.pollIntervalMs;

  // `equals` 比较多个规范化后的表面，结构与单表面匹配不同。
  if ("equals" in exp) {
    return runEqualsExpect(exp.equals, { withinMs, pollIntervalMs }, deps);
  }

  const { predicate, expected } = buildSingleSurfacePredicate(exp);
  const res = await pollUntilMatch({
    observe: () => deps.observe(surface, { seat }),
    predicate,
    expected,
    withinMs,
    pollIntervalMs,
    now: deps.now,
    sleep: deps.sleep,
  });
  return res.ok ? null : res.diff;
}

function buildSingleSurfacePredicate(exp: Record<string, unknown>): {
  predicate: (o: unknown) => boolean;
  expected: unknown;
} {
  if ("match" in exp) {
    return { predicate: (o) => structuralSubsetMatch(o, exp.match), expected: exp.match };
  }
  if ("contains" in exp) {
    const needle = String(exp.contains);
    return { predicate: (o) => containsMatch(o, needle), expected: exp.contains };
  }
  // 校验器保证恰好存在一种匹配模式，因此此分支不可达。
  throw new Error("expect 没有匹配模式");
}

/**
 * `equals` 跨表面执行器（声明式规范化器接口）。读取每个命名表面，通过注入的
 * 规范化器处理；所有规范化形式深度相等时通过。规范化器的最终结构随 51-03 落地。
 */
async function runEqualsExpect(
  equalsPayload: unknown,
  bounds: { withinMs: number; pollIntervalMs: number },
  deps: ScenarioRunnerDeps,
): Promise<string | null> {
  const surfaces = extractEqualsSurfaces(equalsPayload);
  // 51-03：声明式映射是面向场景的形式，并降级到 runner 内部接缝（A-N1）。接缝
  // 签名保持不变；声明映射的场景不再依赖注入的规范化器。
  const declared = isEqualsMapping(equalsPayload) ? buildDeclarativeNormalizer(equalsPayload) : undefined;
  const normalizer = declared ?? deps.normalizer;
  if (!normalizer) {
    throw new Error(
      "`equals` 需要声明式跨表面映射（surface -> projection）或注入的规范化器",
    );
  }
  const observeAllEqual = async (): Promise<{ equal: boolean; snapshot: unknown[] }> => {
    const snapshot = await Promise.all(
      surfaces.map(async (s) => normalizer(s, await deps.observe(s, {}))),
    );
    const first = JSON.stringify(snapshot[0]);
    return { equal: snapshot.every((v) => JSON.stringify(v) === first), snapshot };
  };

  const start = deps.now();
  let last: unknown[] = [];
  for (;;) {
    const { equal, snapshot } = await observeAllEqual();
    last = snapshot;
    if (equal) return null;
    if (deps.now() - start >= bounds.withinMs) {
      return `cross-surface equality unmet for [${surfaces.join(", ")}]\n  normalized: ${JSON.stringify(last, null, 2)}`;
    }
    await deps.sleep(bounds.pollIntervalMs);
  }
}

function extractEqualsSurfaces(payload: unknown): ExpectSurface[] {
  if (Array.isArray(payload)) return payload as ExpectSurface[];
  if (payload && typeof payload === "object") return Object.keys(payload) as ExpectSurface[];
  throw new Error("`equals` 载荷必须指定要比较的表面");
}

function fail(
  scenario: string,
  failedStep: number,
  diff: string,
  deps: ScenarioRunnerDeps,
): RunScenarioResult {
  const rec: RunRecord = { scenario, verdict: "FAIL", failedStep, diff };
  deps.appendRecord?.(rec);
  return { scenario, verdict: "FAIL", failedStep, diff };
}
