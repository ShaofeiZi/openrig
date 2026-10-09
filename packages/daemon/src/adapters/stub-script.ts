// OPR.0.5.1.1——纯 stub 行为脚本模型（A5 第 6–8 项）。
//
// 逐席位脚本以确定方式驱动 pane 承载的 stub-runner：pane 输出行、具名 hook/行为触发，以及
//（以后支持的）逐步计时（PRD §4.2）。此模块无副作用——只含解析、验证和内置默认值——因此可以
// 隔离进行单元测试，runner（pane 进程）与 adapter（后台服务）也都能导入，而不会把后台服务依赖
// 带入 pane。stub 不包含断言逻辑；脚本只描述席位做什么，绝不自行断言。
//
// 孪生一致性：STUB_BEHAVIORS 是 canonical、由生产代码所有的行为集合。51-02 场景的 `emit`
// 动词（scenario-schema.ts EMIT_BEHAVIORS）是同一共享契约的副本；test/stub-script.test.ts
// 防止二者发生字节漂移。

/** 锁定的四行为集合（架构 A4 终端缩减范围）。与 51-02 的 EMIT_BEHAVIORS 逐字节共享。
 * usage_limit 有意缺失——仅真实 runtime 支持。 */
export const STUB_BEHAVIORS = ["compaction", "slow_output", "mid_turn_death", "restore"] as const;
export type StubBehavior = (typeof STUB_BEHAVIORS)[number];

/** 已知但仅限真实 runtime 的行为：stub 无法如实向 provider-usage lane 供数，因此脚本模型会
 * 明确拒绝，绝不接受后丢弃。镜像 51-02 的 REAL_RUNTIME_ONLY_EMIT_BEHAVIORS，使 stub 脚本
 * 与 stub 场景保持一致。 */
export const REAL_RUNTIME_ONLY_BEHAVIORS = ["usage_limit"] as const;

/** 单个确定性脚本步骤。 */
export type StubStep =
  | { kind: "say"; text: string }
  | { kind: "emit"; behavior: StubBehavior };

export interface StubScript {
  steps: StubStep[];
}

/** 明确的类型化拒绝——格式错误或不诚实的脚本必须失败，绝不能静默空操作。 */
export class StubScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StubScriptError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStep(raw: unknown, path: string): StubStep {
  if (!isPlainObject(raw)) throw new StubScriptError(`${path}：步骤必须是对象`);
  const kind = raw.kind;
  if (kind === "say") {
    const text = raw.text;
    if (typeof text !== "string" || text.length === 0) {
      throw new StubScriptError(`${path}.text：say 步骤需要非空字符串`);
    }
    return { kind: "say", text };
  }
  if (kind === "emit") {
    const behavior = raw.behavior;
    if (typeof behavior === "string" && (STUB_BEHAVIORS as readonly string[]).includes(behavior)) {
      return { kind: "emit", behavior: behavior as StubBehavior };
    }
    if (typeof behavior === "string" && (REAL_RUNTIME_ONLY_BEHAVIORS as readonly string[]).includes(behavior)) {
      throw new StubScriptError(
        `${path}.behavior："${behavior}" 仅限真实 runtime（stub 无法如实向 ` +
        `provider-usage lane 供数）——stub 脚本会拒绝它，绝不静默空操作`,
      );
    }
    throw new StubScriptError(
      `${path}.behavior：未知行为 ${JSON.stringify(behavior)}——stub 支持的行为为：${STUB_BEHAVIORS.join(", ")}`,
    );
  }
  throw new StubScriptError(`${path}.kind：未知步骤类型 ${JSON.stringify(kind)}——应为 "say" 或 "emit"`);
}

/** 从 JSON 字符串解析并验证 stub 脚本。任何格式错误都会抛出 StubScriptError，使错误脚本在
 * 加载时明确失败，而不是静默地部分运行。 */
export function parseStubScript(raw: string): StubScript {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StubScriptError("stub 脚本不是有效 JSON");
  }
  if (!isPlainObject(parsed)) throw new StubScriptError("stub 脚本必须是对象 { steps: [...] }");
  const steps = parsed.steps;
  if (!Array.isArray(steps)) throw new StubScriptError("stub 脚本需要 steps 数组");
  return { steps: steps.map((step, i) => parseStep(step, `steps[${i}]`)) };
}

/** 独立 stub 席位的内置默认脚本（没有场景解析出的脚本）：prompt + echo + 脚本化回复，
 * 使席位产生可观察的 pane 输出。 */
export const DEFAULT_STUB_SCRIPT: StubScript = {
  steps: [
    { kind: "say", text: "[stub] 已就绪——等待提示" },
    { kind: "say", text: "[stub] 脚本化回复：已确认" },
  ],
};
