// 切片故事视图 v1——workflow_spec → 各标签页载荷投影。
//
// 给定 SliceWorkflowBinding（解析后的实例）及其绑定的 WorkflowSpec（通过阶段 D 的
// WorkflowSpecCache 读取），投影 v1 基线的四个维度：
//
//   1. specGraph——节点（每步一个）+ 边（从各步骤的 next_hop.suggested_roles 指向后续
//      步骤 ID）。所有边都携带 routingType: "direct"，因为阶段 D 的 spec 格式尚无
//      routing_type 字段（按审计第 6 行的例外：维度 #4 只发布默认样式实线；路由类型元数据
//      留到 v2+）。
//   2. phaseDefinitions——step.id → { label, role }，使故事标签页可按 spec 声明的阶段 tag
//      对事件分组；用 spec 驱动映射替代 v0 硬编码的旧阶段分类法。
//   3. currentStep——按 spec 解析绑定实例的 current_step_id，返回 step.objective、
//      allowed_exits 及 next_hop 枚举的后续步骤目标。
//   4. eventPhaseFor(stepId)——SliceDetailProjector 使用的便捷函数；事件可通过
//      workflow_step_trails 联接映射到步骤时，为 StoryEvent 标记 spec 阶段 ID。无映射时
//      保持无 tag，由 UI 放入“其他”或“未标记”分组。

import type { WorkflowSpec, WorkflowStepSpec } from "../workflow-types.js";

export interface SpecGraphNode {
  /** step.id（例如 "discovery"）。 */
  stepId: string;
  /** 显示标签 = step.role 标题，缺失时回退到 id。 */
  label: string;
  /** step.actor_role（例如 "discovery-router"）。 */
  role: string;
  /** 此角色声明的第一个 preferred_target 席位。UI 用它在 spec 节点上组合 PL-019 活动指示。 */
  preferredTarget: string | null;
  /** 对 spec 入口步骤为 true，即 workflow_instance 的起始步骤。 */
  isEntry: boolean;
  /** 当它是绑定实例的活动步骤时为 true。 */
  isCurrent: boolean;
  /** 当该步骤没有指向后续的 next_hop 时为 true，表示可能的终态。 */
  isTerminal: boolean;
}

export interface SpecGraphEdge {
  fromStepId: string;
  toStepId: string;
  /** v1 仅支持 "direct"——阶段 D 的 spec 格式尚未携带 routing_type（审计第 6 行例外）。 */
  routingType: "direct";
  /** 当边为回环边时为 true，即目标步骤在声明顺序中早于源步骤。UI 可据此使用不同于
   * 前向边的曲线样式。 */
  isLoopBack: boolean;
}

export interface SpecGraphPayload {
  specName: string;
  specVersion: string;
  nodes: SpecGraphNode[];
  edges: SpecGraphEdge[];
}

export interface PhaseDefinition {
  /** step.id（规范阶段 tag）。 */
  id: string;
  /** 人类可读标签 = 角色标题，缺失时回退到 step.id。 */
  label: string;
  role: string;
}

export interface CurrentStepPayload {
  stepId: string;
  role: string;
  objective: string | null;
  /** 阶段 D 的 WorkflowStepSpec.allowed_exits 枚举子集。 */
  allowedExits: string[];
  /** 从 next_hop.suggested_roles 解析并映射回步骤 ID 的后续目标；没有 next_hop 或角色时为空。 */
  allowedNextSteps: Array<{ stepId: string; role: string; reason: "next_hop" }>;
  hopCount: number;
  instanceStatus: string;
}

/**
 * 为拓扑标签页投影 spec 图。节点按 spec 声明的步骤顺序排列；边由每个步骤的
 * next_hop.suggested_roles 列表解析回步骤 ID 后派生。
 */
export function projectSpecGraph(
  spec: WorkflowSpec,
  currentStepId: string | null,
): SpecGraphPayload {
  const declaredOrder = spec.steps.map((s) => s.id);
  const stepByRole = new Map<string, WorkflowStepSpec>();
  for (const step of spec.steps) {
    if (!stepByRole.has(step.actor_role)) stepByRole.set(step.actor_role, step);
  }

  // OPR.0.4.6.WF1（guard blocker 3）：steps[0] 是权威入口——运行时从这里实例化
  //（workflow-runtime.ts），校验器会拒绝不一致的 entry.role。图必须标记运行时最先
  // 路由到的同一节点，绝不能采信 entry.role 的声明；修复前的 spec 可能使投影失真。
  const entryStepId = spec.steps[0]?.id;

  const nodes: SpecGraphNode[] = spec.steps.map((step) => {
    const roleSpec = (spec.roles as Record<string, { preferred_targets?: string[] }>)[step.actor_role] ?? {};
    const firstTarget = roleSpec.preferred_targets?.[0] ?? null;
    return {
      stepId: step.id,
      label: step.actor_role,
      role: step.actor_role,
      preferredTarget: firstTarget,
      isEntry: step.id === entryStepId,
      isCurrent: step.id === currentStepId,
      isTerminal: !hasNextHop(step),
    };
  });

  const edges: SpecGraphEdge[] = [];
  for (const step of spec.steps) {
    const suggestedRoles = step.next_hop?.suggested_roles ?? [];
    for (const role of suggestedRoles) {
      const target = stepByRole.get(role);
      if (!target) continue;
      const fromIdx = declaredOrder.indexOf(step.id);
      const toIdx = declaredOrder.indexOf(target.id);
      edges.push({
        fromStepId: step.id,
        toStepId: target.id,
        routingType: "direct",
        isLoopBack: toIdx >= 0 && fromIdx >= 0 && toIdx <= fromIdx,
      });
    }
  }

  return {
    specName: spec.id,
    specVersion: spec.version,
    nodes,
    edges,
  };
}

/**
 * 投影 spec 的阶段定义。每个步骤贡献一个阶段（规范 tag = step.id；标签 = step.actor_role）。
 * 当事件的 qitem 存在步骤轨迹时，故事标签页按阶段 ID 对事件分组；没有轨迹映射的事件
 * 渲染到“未标记”分组，具体显示文案由 UI 决定。
 */
export function projectPhaseDefinitions(spec: WorkflowSpec): PhaseDefinition[] {
  return spec.steps.map((step) => ({
    id: step.id,
    label: step.actor_role,
    role: step.actor_role,
  }));
}

/**
 * 根据 spec 和绑定实例的 current_step_id 投影当前步骤载荷。当 current_step_id 为 null
 *（实例已终止），或无法按 spec 解析时返回 null。后一情况表示实例基于另一版 spec 创建，
 * 而该 spec 后来改变了结构；UI 会显示“当前步骤未知”。
 */
export function projectCurrentStep(
  spec: WorkflowSpec,
  currentStepId: string | null,
  hopCount: number,
  instanceStatus: string,
): CurrentStepPayload | null {
  if (!currentStepId) return null;
  const step = spec.steps.find((s) => s.id === currentStepId);
  if (!step) return null;
  const stepByRole = new Map<string, WorkflowStepSpec>();
  for (const s of spec.steps) {
    if (!stepByRole.has(s.actor_role)) stepByRole.set(s.actor_role, s);
  }
  const allowedNextSteps: CurrentStepPayload["allowedNextSteps"] = [];
  for (const role of step.next_hop?.suggested_roles ?? []) {
    const target = stepByRole.get(role);
    if (!target) continue;
    allowedNextSteps.push({ stepId: target.id, role, reason: "next_hop" });
  }
  return {
    stepId: step.id,
    role: step.actor_role,
    objective: step.objective ?? null,
    allowedExits: [...(step.allowed_exits ?? [])],
    allowedNextSteps,
    hopCount,
    instanceStatus,
  };
}

function hasNextHop(step: WorkflowStepSpec): boolean {
  return (step.next_hop?.suggested_roles ?? []).length > 0;
}
