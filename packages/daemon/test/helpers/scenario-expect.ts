/**
 * Slice 51-02（L2 test-system）——runner 无判断的 `expect` 核心。
 *
 * runner 是无判断执行器：对 `expect` step，轮询具名已发布 surface，直到结构匹配、子串匹配或跨
 * surface 相等成立，或 `within` 边界耗尽；届时输出 expected-vs-last-observed DIFF 并使 scenario
 * 失败（证明项 3，失败真实性）。不使用启发式，也不判断“看起来是否正确”（那属于 L3，经 agent
 * 完成，绝不由 runner 处理）。
 *
 * `within` 是唯一时间依赖，且是 poll 边界，绝不是断言输入。clock + sleep 可注入，使循环在测试中
 * 确定。
 */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `match` 模式：`expected` 是否为 `actual` 的深层结构子集？
 * - 对象：每个 expected key 都存在于 actual 且满足子集匹配；
 * - 数组：每个 expected 元素都与某个 actual 元素满足子集匹配（contains 语义，即 `queue` 之类
 *   裸数组 surface“含有结构类似 X 的 item”）；
 * - 原始值：严格相等。
 */
export function structuralSubsetMatch(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    return expected.every((exp) => actual.some((act) => structuralSubsetMatch(act, exp)));
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.keys(expected).every(
      (k) => k in actual && structuralSubsetMatch(actual[k], expected[k]),
    );
  }
  return actual === expected;
}

/**
 * `contains` 模式：在文本 surface（pane/transcript）上做子串匹配。
 *
 * 两种已发布文本读取都返回在 `content` 中携带文本的对象：`rig capture --json` 返回
 * {ok, sessionName, content, lines}，`rig transcript --json` 返回
 * {session, lines, content, ingestHealth}；所以纯字符串 matcher 无法匹配此模式所服务的两个 surface。
 * 只接受裸字符串（unit/e2e 对称）或该具名字段，其他一律不接受；盲目 stringify 会错误匹配
 * `sessionName` 或 JSON key 中的 needle，并报告假绿。
 */
export function containsMatch(actual: unknown, needle: string): boolean {
  if (typeof actual === "string") return actual.includes(needle);
  if (isPlainObject(actual) && typeof actual.content === "string") {
    return actual.content.includes(needle);
  }
  return false;
}

/** 为失败断言渲染可读的 expected-vs-observed DIFF。 */
export function formatDiff(expected: unknown, lastObserved: unknown): string {
  const j = (v: unknown) => {
    try {
      return JSON.stringify(v, null, 2);
    } catch {
      return String(v);
    }
  };
  return `断言未在时限内满足\n  预期：${j(expected)}\n  最后观察值：${j(lastObserved)}`;
}

export interface PollUntilMatchOptions {
  /** 读取一次已发布 surface（异步，真实 CLI/socket 读取）。 */
  observe: () => Promise<unknown>;
  /** 观察值是否满足断言？ */
  predicate: (observed: unknown) => boolean;
  /** 预期值，只用于在超时时渲染 DIFF。 */
  expected?: unknown;
  /** poll 边界，单位 ms（由 runner 把 `within` 时长解析为 ms）。 */
  withinMs: number;
  /** poll 间隔，单位 ms。 */
  pollIntervalMs: number;
  /** 注入的单调时钟（ms）。 */
  now: () => number;
  /** 注入的 sleep。 */
  sleep: (ms: number) => Promise<void>;
}

export type PollResult =
  | { ok: true; lastObserved: unknown }
  | { ok: false; lastObserved: unknown; diff: string };

/**
 * 轮询 `observe`，直到 `predicate` 成立或 `withinMs` 耗尽。至少轮询一次，使零边界仍能产生真实的
 * last-observed。超时时返回最后观察值和 DIFF。在注入的 clock/sleep 下具有确定性。
 */
export async function pollUntilMatch(opts: PollUntilMatchOptions): Promise<PollResult> {
  const { observe, predicate, expected, withinMs, pollIntervalMs, now, sleep } = opts;
  const start = now();
  let lastObserved: unknown;
  for (;;) {
    lastObserved = await observe();
    if (predicate(lastObserved)) return { ok: true, lastObserved };
    if (now() - start >= withinMs) {
      return { ok: false, lastObserved, diff: formatDiff(expected, lastObserved) };
    }
    await sleep(pollIntervalMs);
  }
}
