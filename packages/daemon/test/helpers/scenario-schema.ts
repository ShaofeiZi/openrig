/**
 * Slice 51-02（L2 测试系统）——场景格式与校验器。
 *
 * 逐字绑定的架构形状（ARCH-SHAPE-scenario-format-and-runner，sha256 fc30a736）：
 * 场景为 `{scenario, topology, env?, steps[]}`；每个步骤都是单 key 对象，key 是动作动词
 * 或唯一的断言动词 `expect`。校验器是纯函数（处理已解析对象），会用明确命名的错误
 * 响亮拒绝，绝不静默空操作，使作者准确看到问题。
 *
 * proof-item-1 的三种拒绝：未知 expect 表面、未知 emit 行为，以及在 stub 拓扑中 emit
 * `usage_limit`（这是已知仅限真实 runtime 的行为；stub 无法如实向 provider-usage 通道供数，
 * 因此应响亮失败而非假装成功）。此外还校验结构保真和墙上时钟守卫
 *（`within` 是相对轮询边界，绝不是断言输入）。
 */

/** 动作动词（架构形状）。`daemon` 来自 A1 修订，与席位 `restart` 不同。 */
export const ACTION_VERBS = [
  "up",
  "down",
  "send",
  "restart",
  "restore",
  "emit",
  "mutate",
  "policy",
  "seed_regression",
  "daemon",
] as const;

/** 已交付且可观察的表面集合——`expect` 只能指定这些表面。 */
export const EXPECT_SURFACES = [
  "ps",
  "queue",
  "stream",
  "scope",
  "pane",
  "transcript",
  "tui_socket",
  "policy_provenance",
] as const;

/**
 * 保留表面——架构形状中已命名，但当前没有已交付的读取动词支撑，因此格式不能承诺产品
 * 无法回答的内容。根据产品锁定修订（裁决记录 qitem-20260811092250-a80735bc），
 * `proof` 移到这里：`zrig proof` 只交付了 `add`；读取动词交付后，解除保留即可重新加入
 * EXPECT_SURFACES。
 */
export const RESERVED_SURFACES = ["proof"] as const;

/** stub 锁定的四种 emit 行为集合（与 51-01 共享词汇）。 */
export const EMIT_BEHAVIORS = ["compaction", "slow_output", "mid_turn_death", "restore"] as const;

/** 已知但仅限真实 runtime 的 emit 行为：只在真实拓扑中合法。 */
export const REAL_RUNTIME_ONLY_EMIT_BEHAVIORS = ["usage_limit"] as const;

/** 三种 `expect` 匹配模式（每条断言恰好一种）。 */
export const EXPECT_MATCH_MODES = ["match", "contains", "equals"] as const;

/** 后台服务生命周期动词操作（A1）。 */
export const DAEMON_OPS = ["sigterm", "restart"] as const;

export type ActionVerb = (typeof ACTION_VERBS)[number];
export type ExpectSurface = (typeof EXPECT_SURFACES)[number];
export type EmitBehavior = (typeof EMIT_BEHAVIORS)[number];

export type ValidationErrorCode =
  | "SCENARIO_NOT_OBJECT"
  | "SCENARIO_NAME_MISSING"
  | "TOPOLOGY_MISSING"
  | "ENV_NOT_OBJECT"
  | "STEPS_MISSING"
  | "STEP_NOT_OBJECT"
  | "STEP_NOT_SINGLE_KEY"
  | "UNKNOWN_STEP_VERB"
  | "EXPECT_NOT_OBJECT"
  | "UNKNOWN_EXPECT_SURFACE"
  | "RESERVED_EXPECT_SURFACE"
  | "STUB_SCRIPTS_NOT_A_MAP"
  | "STUB_SCRIPT_PATH_INVALID"
  | "SCOPE_MISSION_MISSING"
  | "TUI_NOT_DECLARED"
  | "ENV_TUI_NOT_BOOLEAN"
  | "EXPECT_MATCH_MODE_MISSING"
  | "EXPECT_MATCH_MODE_AMBIGUOUS"
  | "WITHIN_NOT_A_DURATION"
  | "EQUALS_PROJECTION_INVALID"
  | "EQUALS_SURFACE_UNKNOWN"
  | "EQUALS_NOT_DECLARATIVE"
  | "EQUALS_TOO_FEW_SURFACES"
  | "EMIT_NOT_OBJECT"
  | "UNKNOWN_EMIT_BEHAVIOR"
  | "USAGE_LIMIT_IN_STUB_TOPOLOGY"
  | "UNKNOWN_DAEMON_OP";

export interface ValidationError {
  code: ValidationErrorCode;
  message: string;
  /** 指向问题节点的类 JSON 路径，例如 `steps[2].expect.surface`。 */
  path: string;
}

export interface ValidatedScenario {
  scenario: string;
  topology: string;
  env?: Record<string, unknown>;
  steps: Array<Record<string, unknown>>;
}

export type ValidationResult =
  | { ok: true; scenario: ValidatedScenario }
  | { ok: false; errors: ValidationError[] };

export interface ValidateScenarioOptions {
  /**
   * 拓扑的 runtime 种类。51-02 v1 场景是 stub 拓扑（整个测试系统启动 runtime:stub 席位），
   * 因此默认值为 "stub"。只有此值为 "real" 时才允许 emit `usage_limit`。
   */
  topologyKind?: "stub" | "real";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 相对轮询时长：裸毫秒整数，或带 ms/s/m/h 的整数。 */
const DURATION_RE = /^\d+(ms|s|m|h)?$/;

/**
 * 按架构形状校验已解析的场景对象。收集全部错误（响亮且完整），而非遇到第一个就停止。
 * 纯函数，不执行 I/O。
 */
export function validateScenario(
  doc: unknown,
  opts: ValidateScenarioOptions = {},
): ValidationResult {
  const topologyKind = opts.topologyKind ?? "stub";
  const errors: ValidationError[] = [];
  const push = (code: ValidationErrorCode, message: string, path: string) =>
    errors.push({ code, message, path });

  if (!isPlainObject(doc)) {
    return { ok: false, errors: [{ code: "SCENARIO_NOT_OBJECT", message: "scenario 必须是 YAML 映射或对象", path: "" }] };
  }

  if (typeof doc.scenario !== "string" || doc.scenario.length === 0) {
    push("SCENARIO_NAME_MISSING", "scenario：必须提供非空名称（它命名被固定的缺陷类别）", "scenario");
  }
  if (typeof doc.topology !== "string" || doc.topology.length === 0) {
    push("TOPOLOGY_MISSING", "topology：必须提供非空 rig-spec 路径", "topology");
  }
  if (doc.env !== undefined && !isPlainObject(doc.env)) {
    push("ENV_NOT_OBJECT", "env：存在时必须是前置条件映射", "env");
  }

  if (isPlainObject(doc.env)) validateEnvBlock(doc.env, push);

  if (!Array.isArray(doc.steps)) {
    push("STEPS_MISSING", "steps：必须是步骤对象组成的非空有序列表", "steps");
  } else {
    doc.steps.forEach((step, i) => validateStep(step, i, topologyKind, push));
    validateEnvStepCrossRequirements(
      isPlainObject(doc.env) ? doc.env : undefined,
      doc.steps,
      push,
    );
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    scenario: {
      scenario: doc.scenario as string,
      topology: doc.topology as string,
      env: doc.env as Record<string, unknown> | undefined,
      steps: doc.steps as Array<Record<string, unknown>>,
    },
  };
}

/** 检查增量 env 字段的形状（D1 stub_scripts、D7 tui）。此处只检查形状；
 *  stub_scripts 的 key 契约（每个 key 恰好解析到一个 runtime:stub 成员）需要已解析拓扑，
 *  因此在管线边界强制执行。 */
function validateEnvBlock(
  env: Record<string, unknown>,
  push: (code: ValidationErrorCode, message: string, path: string) => void,
): void {
  const scripts = env.stub_scripts;
  if (scripts !== undefined) {
    if (!isPlainObject(scripts)) {
      push(
        "STUB_SCRIPTS_NOT_A_MAP",
        "env.stub_scripts：必须是 <席位成员> → <相对于场景文件的脚本路径> 映射",
        "env.stub_scripts",
      );
    } else {
      for (const [seat, p] of Object.entries(scripts)) {
        if (typeof p !== "string" || p.length === 0) {
          push(
            "STUB_SCRIPT_PATH_INVALID",
            `env.stub_scripts.${seat}：必须提供非空脚本路径字符串`,
            `env.stub_scripts.${seat}`,
          );
        }
      }
    }
  }
  if (env.tui !== undefined && typeof env.tui !== "boolean") {
    push("ENV_TUI_NOT_BOOLEAN", "env.tui：必须是布尔值（true 表示场景选择启用 TUI 配置）", "env.tui");
  }
}

/** 声明的 env 与步骤读取表面之间的教学性交叉要求：scope expect 需要
 *  env.scope_mission（已交付的 `zrig scope audit` 读取将 --mission 设为必填选项）；
 *  tui_socket expect 需要 env.tui:true（控制 socket 只存在于已配置的 TUI 中；未选择启用时，
 *  读取会与一个永不监听的 socket 竞争）。加载时教学优于运行时惊讶。 */
function validateEnvStepCrossRequirements(
  env: Record<string, unknown> | undefined,
  steps: unknown[],
  push: (code: ValidationErrorCode, message: string, path: string) => void,
): void {
  const surfacesRead = new Set<string>();
  steps.forEach((step) => {
    if (!isPlainObject(step)) return;
    const ex = step.expect;
    if (isPlainObject(ex) && typeof ex.surface === "string") surfacesRead.add(ex.surface);
  });

  if (surfacesRead.has("scope")) {
    const mission = env?.scope_mission;
    if (typeof mission !== "string" || mission.length === 0) {
      push(
        "SCOPE_MISSION_MISSING",
        "任一步骤期望 scope 表面时，env.scope_mission 为必填非空字符串——已交付读取命令是 `zrig scope audit --mission <name> --json`，其中 --mission 为必填选项",
        "env.scope_mission",
      );
    }
  }
  if (surfacesRead.has("tui_socket") && env?.tui !== true) {
    push(
      "TUI_NOT_DECLARED",
      "任一步骤期望 tui_socket 表面时必须设置 env.tui: true——控制 socket 只存在于管线按选择启用而配置的 TUI 内",
      "env.tui",
    );
  }
}

function validateStep(
  step: unknown,
  i: number,
  topologyKind: "stub" | "real",
  push: (code: ValidationErrorCode, message: string, path: string) => void,
): void {
  const base = `steps[${i}]`;
  if (!isPlainObject(step)) {
    push("STEP_NOT_OBJECT", `${base}：每个步骤必须是单 key 映射`, base);
    return;
  }
  const keys = Object.keys(step);
  if (keys.length !== 1) {
    push(
      "STEP_NOT_SINGLE_KEY",
      `${base}：步骤必须恰好有一个动词 key，实际为 [${keys.join(", ")}]`,
      base,
    );
    return;
  }
  const verb = keys[0]!;
  const value = step[verb];
  const isAction = (ACTION_VERBS as readonly string[]).includes(verb);
  if (verb !== "expect" && !isAction) {
    push(
      "UNKNOWN_STEP_VERB",
      `${base}：未知步骤动词 "${verb}"——允许：${[...ACTION_VERBS, "expect"].join(", ")}`,
      `${base}.${verb}`,
    );
    return;
  }

  if (verb === "expect") validateExpect(value, `${base}.expect`, push);
  else if (verb === "emit") validateEmit(value, `${base}.emit`, topologyKind, push);
  else if (verb === "daemon") validateDaemon(value, `${base}.daemon`, push);
  // 其他动作动词（up/down/send/restart/restore/mutate/policy/seed_regression）携带由 runner
  // 解释的自由形状 payload；v1 不设 schema 门。
}

function validateExpect(
  value: unknown,
  path: string,
  push: (code: ValidationErrorCode, message: string, p: string) => void,
): void {
  if (!isPlainObject(value)) {
    push("EXPECT_NOT_OBJECT", `${path}：必须是映射 {surface, within?, seat?, match|contains|equals}`, path);
    return;
  }
  const surface = value.surface;
  if (typeof surface === "string" && (RESERVED_SURFACES as readonly string[]).includes(surface)) {
    push(
      "RESERVED_EXPECT_SURFACE",
      `${path}.surface："${surface}" 已保留且不可读——没有已交付的读取动词` +
        `（\`zrig proof\` 只交付 \`add\`），因此格式不能承诺产品无法回答的内容。` +
        `在读取动词交付前保持保留（产品裁决 qitem-20260811092250-a80735bc）；届时解除保留即可重新加入可读集合。`,
      `${path}.surface`,
    );
  } else if (typeof surface !== "string" || !(EXPECT_SURFACES as readonly string[]).includes(surface)) {
    push(
      "UNKNOWN_EXPECT_SURFACE",
      `${path}.surface：未知表面 ${JSON.stringify(surface)}——已交付可观察集合为：${EXPECT_SURFACES.join(", ")}`,
      `${path}.surface`,
    );
  }
  const modes = EXPECT_MATCH_MODES.filter((m) => value[m] !== undefined);
  if (modes.length === 0) {
    push("EXPECT_MATCH_MODE_MISSING", `${path}：match | contains | equals 必须且只能提供一个`, path);
  } else if (modes.length > 1) {
    push("EXPECT_MATCH_MODE_AMBIGUOUS", `${path}：match | contains | equals 只允许一个，实际为 [${modes.join(", ")}]`, path);
  }
  // 51-03：声明式 `equals` 映射（surface → projection）。在此校验，使编写错误成为加载时
  // 的教学失败，而不是一个运行后什么也不比较的场景。
  if (value.equals !== undefined && !isPlainObject(value.equals)) {
    // 守卫发现：旧版列表形式仍能解析，因此场景可只命名表面，却不声明如何比较，
    // 导致比较被交给注入的占位符。A-N1 将声明式映射设为唯一面向场景的形式；
    // 其他形式均在加载时拒绝并给出教学信息。
    push(
      "EQUALS_NOT_DECLARATIVE",
      `${path}.equals：必须是 surface → projection 的声明式映射，例如 ` +
        `{ ps: { pluck: name }, queue: { pluck: destinationSession, rig: true } }。` +
        `裸表面列表只说明比较什么，却不声明如何比较，因此无法进行诚实比较。`,
      `${path}.equals`,
    );
  }
  if (isPlainObject(value.equals)) {
    // 比较至少需要两侧。只有一个表面（或没有表面）在构造上为空真，无论数据如何都会通过。
    const declaredSurfaces = Object.keys(value.equals);
    if (declaredSurfaces.length < 2) {
      push(
        "EQUALS_TOO_FEW_SURFACES",
        `${path}.equals：至少需要两个表面进行比较，实际为 ${declaredSurfaces.length}` +
          `${declaredSurfaces.length ? `（${declaredSurfaces.join(", ")}）` : ""}——单侧等式无论数据如何都会通过，无法证明任何内容。`,
        `${path}.equals`,
      );
    }
    for (const [surf, spec] of Object.entries(value.equals)) {
      if (!(EXPECT_SURFACES as readonly string[]).includes(surf)) {
        push(
          "EQUALS_SURFACE_UNKNOWN",
          `${path}.equals.${surf}：不是可读表面——已交付可观察集合为：${EXPECT_SURFACES.join(", ")}`,
          `${path}.equals.${surf}`,
        );
        continue;
      }
      if (!isPlainObject(spec)) {
        push("EQUALS_PROJECTION_INVALID", `${path}.equals.${surf}：必须是 projection 映射，例如 { pluck: name }`, `${path}.equals.${surf}`);
        continue;
      }
      for (const key of Object.keys(spec)) {
        if (!["pluck", "rig", "path"].includes(key)) {
          push("EQUALS_PROJECTION_INVALID", `${path}.equals.${surf}.${key}：未知 projection key——允许：pluck、rig、path`, `${path}.equals.${surf}.${key}`);
        }
      }
      if (spec.pluck !== undefined && typeof spec.pluck !== "string") {
        push("EQUALS_PROJECTION_INVALID", `${path}.equals.${surf}.pluck：必须是字段名字符串`, `${path}.equals.${surf}.pluck`);
      }
      if (spec.path !== undefined && typeof spec.path !== "string") {
        // 过去加载时会接受，运行时才抛出 `path.split is not a function`；TypeError 绝不能成为首个信号。
        push("EQUALS_PROJECTION_INVALID", `${path}.equals.${surf}.path：必须是点分路径字符串`, `${path}.equals.${surf}.path`);
      }
      if (spec.rig !== undefined && typeof spec.rig !== "boolean") {
        push("EQUALS_PROJECTION_INVALID", `${path}.equals.${surf}.rig：必须是布尔值`, `${path}.equals.${surf}.rig`);
      }
    }
  }

  if (value.within !== undefined) {
    if (typeof value.within !== "string" || !DURATION_RE.test(value.within)) {
      push(
        "WITHIN_NOT_A_DURATION",
        `${path}.within：必须是相对轮询时长（如 "5s"、"500ms"）——墙上时钟或绝对值绝不是断言输入`,
        `${path}.within`,
      );
    }
  }
}

function validateEmit(
  value: unknown,
  path: string,
  topologyKind: "stub" | "real",
  push: (code: ValidationErrorCode, message: string, p: string) => void,
): void {
  if (!isPlainObject(value)) {
    push("EMIT_NOT_OBJECT", `${path}：必须是映射 {seat, behavior, ...}`, path);
    return;
  }
  const behavior = value.behavior;
  if (typeof behavior === "string" && (EMIT_BEHAVIORS as readonly string[]).includes(behavior)) return;
  if (
    typeof behavior === "string" &&
    (REAL_RUNTIME_ONLY_EMIT_BEHAVIORS as readonly string[]).includes(behavior)
  ) {
    if (topologyKind === "stub") {
      push(
        "USAGE_LIMIT_IN_STUB_TOPOLOGY",
        `${path}.behavior："${behavior}" 仅限真实 runtime（provider-usage 通道受 provider 身份门控，stub 无法如实供数）——它在 stub 拓扑中会失败，绝不静默空操作`,
        `${path}.behavior`,
      );
    }
    return; // 真实拓扑中允许。
  }
  push(
    "UNKNOWN_EMIT_BEHAVIOR",
    `${path}.behavior：未知行为 ${JSON.stringify(behavior)}——stub 行为集合为：${EMIT_BEHAVIORS.join(", ")}`,
    `${path}.behavior`,
  );
}

function validateDaemon(
  value: unknown,
  path: string,
  push: (code: ValidationErrorCode, message: string, p: string) => void,
): void {
  const op = isPlainObject(value) ? value.op : undefined;
  if (typeof op !== "string" || !(DAEMON_OPS as readonly string[]).includes(op)) {
    push(
      "UNKNOWN_DAEMON_OP",
      `${path}.op：未知后台服务操作 ${JSON.stringify(op)}——允许：${DAEMON_OPS.join(", ")}（场景局部后台服务的生命周期，与席位级 restart 动词不同）`,
      `${path}.op`,
    );
  }
}
