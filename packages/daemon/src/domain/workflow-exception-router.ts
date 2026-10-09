// OPR.0.4.6.WF5 FR-2：成熟度旋钮——异常路由（v1.3 创建者反转）。分类不等于路由：
// workflow-exception.ts 负责检测，本模块确定性地把类别映射到目标。
//
// 旋钮链（按架构裁决顺序）：
//   1. spec 声明的按类别位置（exception_routing.classes）
//   2. spec 声明的按工作流默认值（exception_routing.default）
//   3. 主机级旋钮默认值（设置键 `workflow.exception_routing`，采用 MH-1 动态键模式；
//      由调用方读取并传入）
//   4. 所有位置均缺失 → 优先 ORCHESTRATOR（v1.3 引擎默认值）
//
// 位置 → 目标：
//   orchestrator → spec 声明的 orchestrator 角色，通过步骤所有者使用的同一套已发布
//     role→preferred_targets 机制解析（调用方传入解析器，不新增解析机制，也不依赖 binding 层）。
//     无法解析 → 选择已注册人类；没有可选人类时显式报错。
//   human_only → 优先进入人类席位，并在此设门禁（orchestrator 永不自动处理）。类别 (c)
//     本质上只能由人类处理——它由 WF-2 编译出的 park 本身就是条目；FR-2 不再创建第二条，
//     因此类别 (c) 不会到达此处的条目创建逻辑。
//
// tier 分流（架构重新裁决后的收紧；guard 围栏）：已发布 attention 联合类型不看目标，
// 只按 tier 匹配，因此 `tier='human-gate'` 只用于人类路由位置（human_only、fallback、
// class-c）；路由到 orchestrator 的条目使用普通 workflow tier。结构在本模块分流；
// 此切片绝不修改已发布 attention 谓词。
//
// 旋钮语义：相同记录状态 + 相同配置，每次都得到相同目标。旋钮变更只影响未来条目——
// 解析仅在条目创建时执行一次，绝不重新路由现存条目。

import type { WorkflowExceptionClass } from "./workflow-exception.js";
import type { WorkflowExceptionDialPosition, WorkflowSpec } from "./workflow-types.js";
import { workflowHumanDestination, type WorkflowHumanDestination } from "./workflow-human-destination.js";

/** 普通工作流包 tier（已发布默认值；attention 联合类型刻意不匹配它）。 */
export const WORKFLOW_EXCEPTION_ORCHESTRATOR_TIER = "mode2";
/** 人类路由 tier——attention 联合类型的第一分支。 */
export const WORKFLOW_EXCEPTION_HUMAN_TIER = "human-gate";

export interface ExceptionRouteInput {
  exceptionClass: WorkflowExceptionClass;
  spec: Pick<WorkflowSpec, "exception_routing" | "roles">;
  /** 主机级旋钮默认值（设置 `workflow.exception_routing`），由调用方读取；null 表示未设置。 */
  hostDialDefault: WorkflowExceptionDialPosition | null;
  /** 已发布 role→preferred_targets 解析，由调用方包装（workflow-runtime 负责运行时匹配）。
   * null 表示无法解析。 */
  resolveRoleTarget: (roleName: string) => string | null;
  /** 惰性读取：有效的智能体路由不得要求人类配置。 */
  humanFallbackSeat?: WorkflowHumanDestination;
}

export interface ExceptionRoute {
  /** 链最终落点。`fallback` 表示 orchestrator 位置的角色目标无法解析。 */
  position: "orchestrator" | "human_only" | "fallback";
  destinationSession: string;
  /** tier 分流——当且仅当 humanRouted 时使用 human-gate。 */
  tier: string;
  humanRouted: boolean;
  /** 决定位置的链路环节；记录在条目证据中，旋钮遍历测试会断言它。 */
  resolvedVia: "class-intrinsic" | "class-declared" | "workflow-declared" | "host-default" | "engine-default";
}

export function exceptionPolicy(input: Pick<ExceptionRouteInput, "exceptionClass" | "spec" | "hostDialDefault">): Pick<ExceptionRoute, "resolvedVia"> & { position: WorkflowExceptionDialPosition } {
  // 类别 (c) 本质上只能由人类处理（异常本身就是人类决策）；旋钮不能改指其他目标。
  let position: WorkflowExceptionDialPosition;
  let resolvedVia: ExceptionRoute["resolvedVia"];
  const routing = input.spec.exception_routing;
  if (input.exceptionClass === "human_gate_trip") {
    position = "human_only";
    resolvedVia = "class-intrinsic";
  } else if (routing?.classes?.[input.exceptionClass]) {
    position = routing.classes[input.exceptionClass]!;
    resolvedVia = "class-declared";
  } else if (routing?.default) {
    position = routing.default;
    resolvedVia = "workflow-declared";
  } else if (input.hostDialDefault) {
    position = input.hostDialDefault;
    resolvedVia = "host-default";
  } else {
    position = "orchestrator";
    resolvedVia = "engine-default";
  }

  return { position, resolvedVia };
}

export function resolveExceptionRoute(input: ExceptionRouteInput): ExceptionRoute {
  const { position, resolvedVia } = exceptionPolicy(input);
  const routing = input.spec.exception_routing;
  if (position === "human_only") {
    return {
      position: "human_only",
      destinationSession: workflowHumanDestination(input.humanFallbackSeat),
      tier: WORKFLOW_EXCEPTION_HUMAN_TIER,
      humanRouted: true,
      resolvedVia,
    };
  }

  // orchestrator 位置：通过已发布机制解析声明的 orchestrator 角色；无法解析
  //（未声明角色、角色未知或没有目标）时选择已注册人类。
  const roleName = routing?.orchestrator_role;
  const target = roleName ? input.resolveRoleTarget(roleName) : null;
  if (!target) {
    return {
      position: "fallback",
      destinationSession: workflowHumanDestination(input.humanFallbackSeat),
      tier: WORKFLOW_EXCEPTION_HUMAN_TIER,
      humanRouted: true,
      resolvedVia,
    };
  }
  return {
    position: "orchestrator",
    destinationSession: target,
    tier: WORKFLOW_EXCEPTION_ORCHESTRATOR_TIER,
    humanRouted: false,
    resolvedVia,
  };
}
