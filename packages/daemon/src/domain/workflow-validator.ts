// PL-004 阶段 D：工作流校验器。
//
// 按以下规则验证 workflow spec：
//   - role 解析：每个 step 的 actor_role 必须引用 `roles` 中声明的 role。
//   - entry 解析：workflow.entry.role（若存在）必须引用已声明 role。
//   - exit 一致性：每个 step 的 allowed_exits[] 必须是 workflow.invariants.allowed_exits[]
//     的子集（若存在 invariants）。
//   - step ID 唯一性。
//
// seat-liveness check 是可选的 v1 graduation；PRD § L4 要求它们，但 v1 最小版本可在没有它们时
// 交付。validator 暴露 `seatLivenessCheck` callback，使 caller（CLI / route）可注入 liveness
// probe；缺失时跳过检查。
//
// 返回结构化 ValidationResult——按 PRD § 诚实错误报告说明“哪里失败 + 为何重要 + 如何处理”。

import type { WorkflowSpec, WorkflowStepSpec } from "./workflow-types.js";
import { resolveNextStep } from "./workflow-projector.js";
import { isHumanSeatSession } from "./human-route-enforcer.js";

export interface ValidationIssue {
  code: string;
  /** 人类可读的“问题 + 影响 + 处理方式”。 */
  message: string;
  /** 字段路径（例如 "workflow.steps[1].actor_role"）。 */
  field?: string;
  /** 严重程度：error 会阻塞；warning 仅提供信息。 */
  severity: "error" | "warning";
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  summary: {
    workflowId: string;
    workflowVersion: string;
    targetRig: string | null;
    entryRole: string | null;
    stepCount: number;
  };
}

export interface SeatLivenessCheckFn {
  (sessionRef: string): { alive: boolean; reason?: string };
}

/** OPR.0.4.6.WF2 FR-3：host-registry membership probe。由 runtime 注入（基于 daemon
 *  hosts-registry reader 构建），使 validator 保持纯函数；缺失时（裸 unit test）跳过 membership
 *  check——production validate/instantiate 路径始终注入它。 */
export interface HostRegistryLookupFn {
  (hostId: string): { registered: boolean; registeredIds: string[] };
}

export class WorkflowValidator {
  validate(
    spec: WorkflowSpec,
    seatLivenessCheck?: SeatLivenessCheckFn,
    hostRegistryLookup?: HostRegistryLookupFn,
  ): ValidationResult {
    const issues: ValidationIssue[] = [];
    const declaredRoles = new Set(Object.keys(spec.roles ?? {}));

    if (spec.entry?.role && !declaredRoles.has(spec.entry.role)) {
      issues.push({
        code: "entry_role_not_declared",
        message: `entry role "${spec.entry.role}" 未在 workflow.roles 中声明。请将该 role 加入 workflow.roles，或将 entry 改为已声明 role。`,
        field: "workflow.entry.role",
        severity: "error",
      });
    }

    // OPR.0.4.6.WF1（guard blocker 3）：steps[0] 是权威 entry（已批准的 WF-2 grounding：
    // entry.role 只做 cross-check，不用于解析——workflow-runtime.ts 从 steps[0] 实例化）。若声明的
    // entry.role 与 steps[0].actor_role 不一致，会让 validation/graph surface 声称 entry 为 B，
    // 而 runtime 将首个 packet 路由给 A——显著拒绝，确保契约绝不静默分叉。
    if (
      spec.entry?.role &&
      spec.steps[0]?.actor_role &&
      spec.entry.role !== spec.steps[0].actor_role
    ) {
      issues.push({
        code: "entry_role_mismatch",
        message: `workflow.entry.role 为 "${spec.entry.role}"，但权威 entry 是 steps[0]（"${spec.steps[0].id}"，actor_role "${spec.steps[0].actor_role}"）——runtime 从 steps[0] 实例化，因此不同的 entry.role 会让所有报告它的 surface 失真。请重新排序 step，使目标 entry step 位于首位，或修正/移除 entry.role。`,
        field: "workflow.entry.role",
        severity: "error",
      });
    }

    const seenStepIds = new Set<string>();
    const allowedExitsInvariant = spec.invariants?.allowed_exits;
    spec.steps.forEach((step, idx) => {
      const fieldBase = `workflow.steps[${idx}]`;
      if (!step.id) {
        issues.push({
          code: "step_id_missing",
          message: `${fieldBase} 处的 step 缺少 id。每个 step 都必须有稳定 id，供 next_hop hint 与 step trail 引用。`,
          field: `${fieldBase}.id`,
          severity: "error",
        });
        return;
      }
      if (seenStepIds.has(step.id)) {
        issues.push({
          code: "step_id_duplicate",
          message: `${fieldBase} 处存在重复 step id "${step.id}"。workflow 内的 step id 必须唯一。`,
          field: `${fieldBase}.id`,
          severity: "error",
        });
      }
      seenStepIds.add(step.id);

      if (!step.actor_role) {
        issues.push({
          code: "step_actor_role_missing",
          message: `step "${step.id}" 缺少 actor_role。请声明驱动此 step 的 role，使 projector 能派生 next-step owner。`,
          field: `${fieldBase}.actor_role`,
          severity: "error",
        });
      } else if (!declaredRoles.has(step.actor_role)) {
        issues.push({
          code: "step_actor_role_not_declared",
          message: `step "${step.id}" 引用了 workflow.roles 中未声明的 role "${step.actor_role}"。请添加该 role 或修改 step。`,
          field: `${fieldBase}.actor_role`,
          severity: "error",
        });
      }

      if (step.allowed_exits && allowedExitsInvariant) {
        for (const exit of step.allowed_exits) {
          if (!allowedExitsInvariant.includes(exit)) {
            issues.push({
              code: "step_exit_not_allowed",
              message: `step "${step.id}" 允许的 exit "${exit}" 不在 workflow.invariants.allowed_exits 中。请从 step 移除该 exit，或扩展 invariant。`,
              field: `${fieldBase}.allowed_exits`,
              severity: "error",
            });
          }
        }
      }
      if (
        step.re_present_after_seconds !== undefined &&
        step.allowed_exits?.length &&
        !step.allowed_exits.includes("waiting")
      ) {
        issues.push({
          code: "waiting_re_presentation_unreachable",
          message: `step "${step.id}" 声明了 re_present_after_seconds，但不允许 waiting exit。请将 "waiting" 加入 allowed_exits，或移除无效 deadline。`,
          field: `${fieldBase}.re_present_after_seconds`,
          severity: "error",
        });
      }
      if (step.re_present_after_seconds !== undefined && step.next_hop?.on?.waiting) {
        issues.push({
          code: "waiting_re_presentation_unreachable",
          message: `step "${step.id}" 将 waiting exit 映射到 "${step.next_hop.on.waiting}"，因此 waiting 会立即路由而不会 park。请移除 re_present_after_seconds 或 waiting branch。`,
          field: `${fieldBase}.re_present_after_seconds`,
          severity: "error",
        });
      }
      for (const dependency of step.depends_on ?? []) {
        if (dependency === step.id) {
          issues.push({ code: "dependency_self_reference", message: `step "${step.id}" 不能依赖自身。`, field: `${fieldBase}.depends_on`, severity: "error" });
        } else if (!spec.steps.some((candidate) => candidate.id === dependency)) {
          issues.push({ code: "dependency_step_not_found", message: `step "${step.id}" 依赖缺失的 step "${dependency}"。请修正 id 或移除无效 prerequisite。`, field: `${fieldBase}.depends_on`, severity: "error" });
        }
      }
    });

    // ── OPR.0.4.6.WF1 FR-7（G7）：按真实 resolution semantics 验证 graph——下方 walk 调用
    // projector 自己导出的 resolveNextStep（suggested_roles edge ∪ declaration-order fallback，
    // 遵守 forbid/require cut），绝不并行重新实现。────────────────────────────────────────────

    // next_hop.suggested_roles target 检查：每个 suggested role 都必须已声明，且可解析到至少一个
    // step（resolveNextStep 正是如此匹配——没有任何 step 满足的 suggestion 是 author 几乎肯定拼错的
    // 死边）。
    spec.steps.forEach((step, idx) => {
      for (const role of step.next_hop?.suggested_roles ?? []) {
        const fieldBase = `workflow.steps[${idx}].next_hop.suggested_roles`;
        if (!declaredRoles.has(role)) {
          issues.push({
            code: "next_hop_role_not_declared",
            message: `step "${step.id}" 建议的 next-hop role "${role}" 未在 workflow.roles 中声明。请声明该 role 或修正拼写——此 edge 永远无法路由。`,
            field: fieldBase,
            severity: "error",
          });
        } else if (!spec.steps.some((s) => s.actor_role === role)) {
          issues.push({
            code: "next_hop_role_has_no_step",
            message: `step "${step.id}" 建议 next-hop role "${role}"，但没有 step 声明 actor_role "${role}"——resolveNextStep 根据 step actor_role 匹配 suggestion，因此此 edge 永远无法路由。请为该 role 添加 step 或修正 suggestion。`,
            field: fieldBase,
            severity: "error",
          });
        }
      }
    });

    // OPR.0.4.6.WF2 FR-1：branch-edge 检查——每个 next_hop.on target 都必须是现有 step id
    //（branch key set 本身在 parse 时封闭）。dead branch edge 永远无法路由。
    spec.steps.forEach((step, idx) => {
      for (const [exitKey, targetId] of Object.entries(step.next_hop?.on ?? {})) {
        if (targetId && !spec.steps.some((s) => s.id === targetId)) {
          issues.push({
            code: "branch_target_not_found",
            message: `step "${step.id}" 将 exit "${exitKey}" 分支到不存在的 step "${targetId}"。请修正 step id 或移除 branch——此 edge 永远无法路由。`,
            field: `workflow.steps[${idx}].next_hop.on.${exitKey}`,
            severity: "error",
          });
        }
      }
    });

    // 对完整 successor graph 执行 reachability + cycle detection：structural edge（projector 自己
    // 导出的 resolveNextStep——绝不并行重新实现）与 WF-2 branch edge 的并集（arch composition
    // note：branch edge 会创建 cycle——failed → remediate → verify → failed 是 canonical
    // remediation loop）。routing cycle 要求可执行的 max_hops。prerequisite cycle 无论是否有 hop
    // guard 都不可调度，因此在应用 routing-loop exception 前单独检查其 edge。
    if (spec.steps.length > 0 && spec.steps.every((s) => s.id)) {
      const stepById = new Map(spec.steps.map((s) => [s.id, s]));
      const dependencyGraph = spec.steps.some((step) => step.depends_on !== undefined);
      const successorsOf = (step: WorkflowStepSpec): string[] => {
        const out: string[] = [];
        if (dependencyGraph) {
          for (const candidate of spec.steps) {
            if ((candidate.depends_on ?? []).includes(step.id)) out.push(candidate.id);
          }
        } else {
          const structural = resolveNextStep(spec, step);
          if (structural) out.push(structural.id);
        }
        for (const targetId of Object.values(step.next_hop?.on ?? {})) {
          if (targetId && stepById.has(targetId) && !out.includes(targetId)) {
            out.push(targetId);
          }
        }
        return out;
      };
      // Reachability：从权威 entry（steps[0]）开始 BFS。
      const reachable = new Set<string>();
      const queue: string[] = [spec.steps[0]!.id];
      while (queue.length > 0) {
        const id = queue.shift()!;
        if (reachable.has(id)) continue;
        reachable.add(id);
        const step = stepById.get(id);
        if (step) queue.push(...successorsOf(step));
      }
      const findCycle = (successors: (step: WorkflowStepSpec) => string[], roots: string[]): string[] | null => {
        let cyclePath: string[] | null = null;
        const color = new Map<string, "gray" | "black">();
        const stack: string[] = [];
        const dfs = (id: string): boolean => {
          color.set(id, "gray");
          stack.push(id);
          const step = stepById.get(id);
          for (const succ of step ? successors(step) : []) {
            const c = color.get(succ);
            if (c === "gray") {
              cyclePath = [...stack.slice(stack.indexOf(succ)), succ];
              return true;
            }
            if (c !== "black" && dfs(succ)) return true;
          }
          stack.pop();
          color.set(id, "black");
          return false;
        };
        for (const id of roots) {
          if (!color.has(id) && dfs(id)) break;
        }
        return cyclePath;
      };
      const dependencyCycle = dependencyGraph
        ? findCycle((step) => step.depends_on ?? [], [...stepById.keys()]) : null;
      if (dependencyCycle) {
        issues.push({
          code: "dependency_cycle",
          message: `prerequisite graph 存在环（${dependencyCycle.join(" → ")}）。这些 step 无法 ready；请移除形成环的 depends_on edge。loop_guards.max_hops 约束 routing loop，而非 prerequisite cycle。`,
          field: "workflow.steps",
          severity: "error",
        });
      }
      const cyclePath = findCycle(successorsOf, [spec.steps[0]!.id]);
      // Guard blocker 2：只有可执行 guard 才允许 cycle——非整数或非正 max_hops（可能存在于修复前
      // cached spec_json blob；parser 现在会拒绝新值）永远无法在 projection 时触发，因此不构成授权。
      const enforceableMaxHops =
        typeof spec.loop_guards?.max_hops === "number" &&
        Number.isInteger(spec.loop_guards.max_hops) &&
        spec.loop_guards.max_hops >= 1;
      if (cyclePath && !dependencyCycle && !enforceableMaxHops) {
        issues.push({
          code: "cycle_without_max_hops",
          message: `routing graph 存在环（${(cyclePath as string[]).join(" → ")}），且未声明 workflow.loop_guards.max_hops——instance 将无限 hop。只有受强制 guard 约束时，loop（包括 branch 创建的 remediation loop）才合法：请声明 loop_guards.max_hops 以允许该 cycle。`,
          field: "workflow.loop_guards.max_hops",
          severity: "error",
        });
      }
      for (const step of spec.steps) {
        if (step.id && !reachable.has(step.id)) {
          issues.push({
            code: "step_unreachable",
            message: `step "${step.id}" 不可达：从 entry step（"${spec.steps[0]!.id}"）开始的 structural routing walk 与任何 branch edge 都无法到达它。请修正 next_hop edge/branch 或移除 dead step。`,
            field: `workflow.steps`,
            severity: "error",
          });
        }
      }
    }

    // OPR.0.4.6.WF2 FR-3：对照 live registry 检查 host-pin membership（注入 production lookup
    // 时）。"local" 与缺失值始终合法；未知 id 永远无法路由。
    if (hostRegistryLookup) {
      spec.steps.forEach((step, idx) => {
        if (step.host && step.host !== "local") {
          const probe = hostRegistryLookup(step.host);
          if (!probe.registered) {
            issues.push({
              code: "host_not_registered",
              message: `step "${step.id}" 固定到 hosts registry（~/.openrig/hosts.yaml）中不存在的 host "${step.host}"。已注册 id：${probe.registeredIds.length > 0 ? `[${probe.registeredIds.join(", ")}]` : "（无）"}。请使用 zrig host add 注册 host、改用 "local" 或移除 pin。`,
              field: `workflow.steps[${idx}].host`,
              severity: "error",
            });
          }
        }
      });
    }

    // OPR.0.4.6.WF2 FR-5：gate target semantics——HUMAN-seat target 要求 summary +
    // evidence_ref（已交付 human-route write 路径在 create 时强制；在这里失败就是
    // fail-at-author-time mini-req）；其他 target 必须是已声明 role。没有 preferred_targets 的
    // handler role 会得到 warning（若触发时仍无法解析，gate compile 会显著失败）。
    spec.steps.forEach((step, idx) => {
      const gate = step.gate;
      if (!gate) return;
      const fieldBase = `workflow.steps[${idx}].gate`;
      if (isHumanSeatSession(gate.target)) {
        if (!gate.summary || !gate.evidence_ref) {
          issues.push({
            code: "gate_human_fields_missing",
            message: `step "${step.id}" 以 human seat ${gate.target} 为 gate，但缺少 ${!gate.summary ? "summary" : "evidence_ref"}。human-routed gate item 必须同时携带 plain-language summary 与持久 evidence pointer（已交付 human-route contract）——请补齐两者。`,
            field: fieldBase,
            severity: "error",
          });
        }
      } else if (!declaredRoles.has(gate.target)) {
        issues.push({
          code: "gate_target_unresolved",
          message: `step "${step.id}" 以 "${gate.target}" 为 gate，但它既不是 human seat session（human@kernel 形式），也不是 workflow.roles 中声明的 role。请声明 handler role 或使用 human seat session。`,
          field: `${fieldBase}.target`,
          severity: "error",
        });
      } else if ((spec.roles?.[gate.target]?.preferred_targets ?? []).length === 0) {
        issues.push({
          code: "gate_handler_no_targets",
          message: `step "${step.id}" 以 handler role "${gate.target}" 为 gate，但该 role 未声明 preferred_targets——gate item 触发时没有可路由 seat。请在实例化前为该 role 添加 preferred_targets。`,
          field: `${fieldBase}.target`,
          severity: "warning",
        });
      }
    });

    // ── OPR.0.4.6.WF1 FR-9（G8）：inert-config sweep——每个已声明但未执行的 key 都以 machine-
    // readable 方式明确标为 V2：使用它会产生 fail-open advisory（warning，exit 0），点明该 key
    // 已声明但 v1 未执行。任何 key 都不能处于静默第三状态。已使用 key 不发 advisory：
    // invariants.allowed_exits（投影器出口强制）、loop_guards.max_hops（FR-6）、
    // roles.*.preferred_targets（所有者解析）。────────────────────────────────────────────
    const v2Advisory = (key: string, field: string, extra?: string) => {
      issues.push({
        code: "declared_not_enforced_v1",
        message: `"${key}" 已声明，但 v1 不会执行——engine 会记录它，却不会采取行动${extra ? `（${extra}）` : ""}。可保留以便 forward compatibility，也可移除；它目前不会改变任何行为。`,
        field,
        severity: "warning",
      });
    };
    if (spec.invariants?.continuation_required !== undefined) {
      v2Advisory("invariants.continuation_required", "workflow.invariants.continuation_required");
    }
    if (spec.invariants?.preserve_lineage !== undefined) {
      v2Advisory("invariants.preserve_lineage", "workflow.invariants.preserve_lineage",
        "lineage 始终通过 chain_of_record 保留；flag 本身不控制任何行为");
    }
    if (spec.invariants?.closure_required !== undefined) {
      v2Advisory("invariants.closure_required", "workflow.invariants.closure_required",
        "hot-potato contract 始终要求 closure；flag 本身不控制任何行为");
    }
    if (spec.closure) {
      v2Advisory("closure.{success,degraded,failed}", "workflow.closure",
        "仅展示消息；尚无 consumer 渲染它们");
    }
    if (spec.loop_guards?.spawn_budget !== undefined) {
      v2Advisory("loop_guards.spawn_budget", "workflow.loop_guards.spawn_budget",
        "它保护 SPAWN 机制，而 single-frontier model 中不存在 spawn/fan-out seam；执行此约束是 WF-2/WF-6 parallel-frontier fan-out 工作的具名 acceptance item（arch ruling 2026-07-06）");
    }
    // OPR.0.4.6.WF2 FR-4：`gates[]` 与 `next_hop.mode: prefer` advisory 已移除——两种形式
    // 现在都会在 parse 时以具体 what/why/fix migration error（spec_gates_removed /
    // spec_prefer_mode_removed）移除，因此携带它们的 spec 永远无法到达此 validator。inert
    // 第三状态已在 parser 中消失。
    for (const [roleName, role] of Object.entries(spec.roles ?? {})) {
      if (role?.skill_refs && role.skill_refs.length > 0) {
        v2Advisory("skill_refs", `workflow.roles.${roleName}.skill_refs`,
          "仅用于文档；owner resolution 使用 preferred_targets");
        break; // 整份 spec 一个 advisory，而非每个 role 一个
      }
    }

    if (seatLivenessCheck) {
      // probe 每个 role 的 preferred_targets[]。没有 live preferred target 的 role 会产生 warning
      //（不是 error）——agent 仍可在 runtime 通过 runtime-adapter / claim 解析。
      for (const [roleName, role] of Object.entries(spec.roles ?? {})) {
        const targets = role?.preferred_targets ?? [];
        if (targets.length === 0) continue;
        const liveAny = targets.some((t) => seatLivenessCheck(t).alive);
        if (!liveAny) {
          issues.push({
            code: "role_no_live_preferred_target",
            message: `role "${roleName}" 的 preferred_targets 为 ${JSON.stringify(targets)}，但没有 live target。instance 可能停在首个需要此 role 的 step；请在实例化前确保至少一个 target 已启动，或依赖 runtime 的动态解析。`,
            field: `workflow.roles.${roleName}.preferred_targets`,
            severity: "warning",
          });
        }
      }
    }

    const errors = issues.filter((i) => i.severity === "error");
    return {
      ok: errors.length === 0,
      issues,
      summary: {
        workflowId: spec.id,
        workflowVersion: spec.version,
        targetRig: spec.target?.rig ?? null,
        entryRole: spec.entry?.role ?? null,
        stepCount: spec.steps.length,
      },
    };
  }
}
