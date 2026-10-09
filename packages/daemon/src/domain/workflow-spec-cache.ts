// PL-004 阶段 D：工作流规范缓存（从 Markdown/YAML 直读到 SQLite
// workflow_specs）。
//
// 工作流规范属于工作区表层（磁盘上的 Markdown/YAML 文件，由人工编写）。
// 守护进程按需读取，并缓存在 workflow_specs 中以便快速查找。缓存失效依据
// 规范文件内容的 source_hash；下次读取时若哈希不同，则重新缓存。
//
// 工作区表层协调约定（依据 PRD 的“工作区表层协调”一节）：操作员对规范文件的
// 有效编辑在下次读取时优先；缓存永远不是真相来源。

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { parse as parseYaml } from "yaml";
import type { WorkflowSpec, WorkflowSpecRow } from "./workflow-types.js";
import { WORKFLOW_AGENT_HARNESSES, WORKFLOW_EXIT_KINDS } from "./workflow-types.js";

interface SpecRow {
  spec_id: string;
  name: string;
  version: string;
  purpose: string | null;
  target_rig: string | null;
  roles_json: string;
  steps_json: string;
  coordination_terminal_turn_rule: string;
  source_path: string;
  source_hash: string;
  cached_at: string;
  /**
   * OPR.0.4.6.WF1（迁移 050）：完整的解析后规范。旧行（050 之前的缓存写入）
   * 中为 NULL——这些行会降级为仅按列重建，并在下次 readThrough 时自愈。
   */
  spec_json?: string | null;
}

/** 防御性列探测（沿用 detectQueueColumn 的项目惯例）——较旧的测试夹具会绕过
 *  标准迁移列表，因此可能没有 spec_json（迁移 050）。 */
function detectSpecColumn(db: Database.Database, columnName: string): boolean {
  try {
    return db
      .prepare("PRAGMA table_info(workflow_specs)")
      .all()
      .some((row) => (row as { name?: string }).name === columnName);
  } catch {
    return false;
  }
}

export class WorkflowSpecError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WorkflowSpecError";
  }
}

/**
 * OPR.0.4.6.WF1 FR-7——封闭键集，以具名常量形式导出：parseWorkflowSpec
 * 是唯一能看到原始键的边界（校验器处理的是类型化规范，永远看不到已丢弃的键），
 * 因此未知键在此拒绝；WF-2 的新字段（next_hop.on / harness / host / gate）
 * 通过扩展这些常量加入，而不必重新接通解析器。
 */
export const WORKFLOW_TOP_LEVEL_KEYS = [
  "id",
  "version",
  "objective",
  "target",
  "entry",
  "roles",
  "steps",
  "invariants",
  "closure",
  "loop_guards",
  // OPR.0.4.6.WF5 FR-2：成熟度旋钮在规范中声明的路由表层。
  "exception_routing",
  "coordination_terminal_turn_rule",
  "context_refs",
] as const;
export const WORKFLOW_STEP_KEYS = [
  "id",
  "actor_role",
  "objective",
  "allowed_exits",
  "re_present_after_seconds",
  "re_present_max_seconds",
  "next_hop",
  // OPR.0.4.6.WF2：`gates` 被有意排除在此列表外——它已移除，并配有专门的
  // 迁移错误（在扫描未知键之前检查，让作者得到“是什么/为什么/如何修复”，
  // 而不是笼统的未知键拒绝）。
  "harness",
  "host",
  "gate",
  "depends_on",
  "acceptance",
] as const;
export const WORKFLOW_ROLE_KEYS = ["skill_refs", "preferred_targets"] as const;
export const WORKFLOW_NEXT_HOP_KEYS = ["mode", "suggested_roles", "on"] as const;
export const WORKFLOW_GATE_KEYS = ["target", "summary", "evidence_ref"] as const;
export const WORKFLOW_ACCEPTANCE_KEYS = ["candidate", "verdicts", "evidence_ref"] as const;
export const WORKFLOW_TARGET_KEYS = ["rig"] as const;
export const WORKFLOW_ENTRY_KEYS = ["role"] as const;
export const WORKFLOW_INVARIANTS_KEYS = [
  "continuation_required",
  "allowed_exits",
  "preserve_lineage",
  "closure_required",
] as const;
export const WORKFLOW_CLOSURE_KEYS = ["success", "degraded", "failed"] as const;
export const WORKFLOW_LOOP_GUARDS_KEYS = ["max_hops", "spawn_budget"] as const;
/** OPR.0.4.6.WF5 FR-2：旋钮语法键集（WF-2 严格性护栏——遇到未知键时
 *  明确报错并列出此键集）。 */
export const WORKFLOW_EXCEPTION_ROUTING_KEYS = [
  "default",
  "orchestrator_role",
  "classes",
] as const;

/** FR-7：明确拒绝未知键（说明是什么/为什么/如何修复），不再像 0.4.6 之前那样
 *  静默丢弃。仅应用于对象形态的节点；非对象的形态错误仍由现有检查负责。 */
function rejectUnknownKeys(
  node: unknown,
  allowed: readonly string[],
  path: string,
  sourcePath: string,
): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  for (const key of Object.keys(node as Record<string, unknown>)) {
    if (!allowed.includes(key)) {
      throw new WorkflowSpecError(
        "spec_unknown_key",
        `${sourcePath} 处的工作流规范：${path} 中存在未知键 "${key}"。允许的键：[${allowed.join(", ")}]. 在 0.4.6 之前，未知键会被静默丢弃（规范看似已接受，但字段不起作用）；现在会明确失败——请移除该键或修正拼写。`,
        { sourcePath, path, key, allowed: [...allowed] },
      );
    }
  }
}

/**
 * 从原始 YAML 内容解析工作流规范。POC 夹具结构将所有内容包在顶层
 * `workflow:` 键下：
 *
 *   workflow:
 *     id: ...
 *     version: ...
 *     roles: { ... }
 *     steps: [ ... ]
 *
 * 返回解析后的规范；若 YAML 格式错误或缺少必填字段，则抛出 WorkflowSpecError。
 * FR-7：每一层的未知键都会依据上面导出的封闭键集被明确拒绝。
 */
export function parseWorkflowSpec(rawYaml: string, sourcePath: string): WorkflowSpec {
  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml);
  } catch (err) {
    throw new WorkflowSpecError(
      "spec_yaml_invalid",
      `${sourcePath} 处的工作流规范无法解析为 YAML：${err instanceof Error ? err.message : err}`,
      { sourcePath },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowSpecError(
      "spec_shape_invalid",
      `${sourcePath} 处的工作流规范必须是带有顶层 'workflow:' 键的 YAML 映射`,
      { sourcePath },
    );
  }
  const root = parsed as Record<string, unknown>;
  const wf = root.workflow as Record<string, unknown> | undefined;
  if (!wf || typeof wf !== "object" || Array.isArray(wf)) {
    throw new WorkflowSpecError(
      "spec_shape_invalid",
      `${sourcePath} 处的工作流规范缺少顶层 'workflow:' 键`,
      { sourcePath },
    );
  }
  if (typeof wf.id !== "string" || wf.id.length === 0) {
    throw new WorkflowSpecError(
      "spec_field_missing",
      `${sourcePath} 处的工作流规范缺少必填字段 workflow.id`,
      { sourcePath, field: "workflow.id" },
    );
  }
  if (wf.version === undefined || wf.version === null) {
    throw new WorkflowSpecError(
      "spec_field_missing",
      `${sourcePath} 处的工作流规范缺少必填字段 workflow.version`,
      { sourcePath, field: "workflow.version" },
    );
  }
  if (!Array.isArray(wf.steps) || wf.steps.length === 0) {
    throw new WorkflowSpecError(
      "spec_field_missing",
      `${sourcePath} 处的工作流规范要求 workflow.steps[] 中至少包含一个步骤`,
      { sourcePath, field: "workflow.steps" },
    );
  }
  if (!wf.roles || typeof wf.roles !== "object" || Array.isArray(wf.roles)) {
    throw new WorkflowSpecError(
      "spec_field_missing",
      `${sourcePath} 处的工作流规范要求提供 workflow.roles 映射`,
      { sourcePath, field: "workflow.roles" },
    );
  }

  // FR-7：在每一层严格拒绝未知键——包括文档根节点（护栏阻塞项 2 的方案）：
  // YAML 根节点只能有 `workflow:`；过去多余的同级根键会被静默忽略。
  rejectUnknownKeys(root, ["workflow"], "(document root)", sourcePath);
  rejectUnknownKeys(wf, WORKFLOW_TOP_LEVEL_KEYS, "workflow", sourcePath);

  // FR-6/FR-7（护栏阻塞项 2）：在原始数据边界校验 loop_guards 的形态。
  // 非数字的 max_hops 会让循环通过校验，但运行时比较会被转换成 NaN，因而永远
  // 不会触发——这会重新引入无限循环问题。此处是唯一能看到原始值的位置，必须明确拒绝。
  if (wf.loop_guards && typeof wf.loop_guards === "object" && !Array.isArray(wf.loop_guards)) {
    const lg = wf.loop_guards as Record<string, unknown>;
    // 将 YAML 的 `key: null` 规范化为“缺省”——如果 null 进入类型化规范，
    // 在投影比较中会被转换为 0，导致每次第一次交接都触发限制。
    if (lg.max_hops === null) delete lg.max_hops;
    if (lg.spawn_budget === null) delete lg.spawn_budget;
    if (lg.max_hops !== undefined) {
      if (typeof lg.max_hops !== "number" || !Number.isInteger(lg.max_hops) || lg.max_hops < 1) {
        throw new WorkflowSpecError(
          "spec_field_invalid",
          `${sourcePath} 处的工作流规范：workflow.loop_guards.max_hops 必须是 >= 1 的整数（收到 ${JSON.stringify(lg.max_hops)}）。非数字或非正数的护栏在投影时永远不会触发，因此无法约束循环——请修正该值或移除该键。`,
          { sourcePath, field: "workflow.loop_guards.max_hops", value: lg.max_hops },
        );
      }
    }
    if (lg.spawn_budget !== undefined) {
      if (typeof lg.spawn_budget !== "number" || !Number.isInteger(lg.spawn_budget) || lg.spawn_budget < 0) {
        throw new WorkflowSpecError(
          "spec_field_invalid",
          `${sourcePath} 处的工作流规范：workflow.loop_guards.spawn_budget 必须是 >= 0 的整数（收到 ${JSON.stringify(lg.spawn_budget)}）。`,
          { sourcePath, field: "workflow.loop_guards.spawn_budget", value: lg.spawn_budget },
        );
      }
    }
  }
  // OPR.0.4.6.WF5 FR-2：在原始数据边界校验旋钮语法。position 是封闭值空间；
  // classes 键来自 FR-1 的封闭类别集，但不包含 human_gate_trip（它本质上只属于
  // 人工处理——声称并非如此的配置会造成静默误导，因此明确拒绝）。
  if (wf.exception_routing !== undefined) {
    const er = wf.exception_routing;
    if (!er || typeof er !== "object" || Array.isArray(er)) {
      throw new WorkflowSpecError(
        "spec_field_invalid",
        `${sourcePath} 处的工作流规范：workflow.exception_routing 必须是映射（收到 ${JSON.stringify(er)}）。请声明 default / orchestrator_role / classes；若要使用“主机默认 → 编排者优先”链路，则移除此键。`,
        { sourcePath, field: "workflow.exception_routing" },
      );
    }
    rejectUnknownKeys(er, WORKFLOW_EXCEPTION_ROUTING_KEYS, "workflow.exception_routing", sourcePath);
    const erm = er as Record<string, unknown>;
    const validPosition = (v: unknown): boolean => v === "orchestrator" || v === "human_only";
    if (erm.default !== undefined && !validPosition(erm.default)) {
      throw new WorkflowSpecError(
        "spec_field_invalid",
        `${sourcePath} 处的工作流规范：workflow.exception_routing.default 必须是 "orchestrator" 或 "human_only"（收到 ${JSON.stringify(erm.default)}）。`,
        { sourcePath, field: "workflow.exception_routing.default", value: erm.default },
      );
    }
    if (erm.orchestrator_role !== undefined && (typeof erm.orchestrator_role !== "string" || erm.orchestrator_role.length === 0)) {
      throw new WorkflowSpecError(
        "spec_field_invalid",
        `${sourcePath} 处的工作流规范：workflow.exception_routing.orchestrator_role 必须是已声明且非空的角色名（收到 ${JSON.stringify(erm.orchestrator_role)}）。角色是否存在由校验器进行图检查。`,
        { sourcePath, field: "workflow.exception_routing.orchestrator_role", value: erm.orchestrator_role },
      );
    }
    if (erm.classes !== undefined) {
      const cls = erm.classes;
      if (!cls || typeof cls !== "object" || Array.isArray(cls)) {
        throw new WorkflowSpecError(
          "spec_field_invalid",
          `${sourcePath} 处的工作流规范：workflow.exception_routing.classes 必须是“异常类别 → 处理位置”的映射（收到 ${JSON.stringify(cls)}）。`,
          { sourcePath, field: "workflow.exception_routing.classes" },
        );
      }
      for (const [k, v] of Object.entries(cls as Record<string, unknown>)) {
        if (k === "human_gate_trip") {
          throw new WorkflowSpecError(
            "spec_field_invalid",
            `${sourcePath} 处的工作流规范：workflow.exception_routing.classes.human_gate_trip 不可配置——人工门禁本质上只能由人工处理（人工决策本身就是异常）；旋钮不能改变其指向。请移除此行。`,
            { sourcePath, field: "workflow.exception_routing.classes.human_gate_trip" },
          );
        }
        if (k !== "unmapped_failed" && k !== "stuck_overdue") {
          throw new WorkflowSpecError(
            "spec_unknown_key",
            `${sourcePath} 处的工作流规范：workflow.exception_routing.classes.${k} 不是已知异常类别。允许值：unmapped_failed、stuck_overdue。`,
            { sourcePath, field: `workflow.exception_routing.classes.${k}` },
          );
        }
        if (!validPosition(v)) {
          throw new WorkflowSpecError(
            "spec_field_invalid",
            `${sourcePath} 处的工作流规范：workflow.exception_routing.classes.${k} 必须是 "orchestrator" 或 "human_only"（收到 ${JSON.stringify(v)}）。`,
            { sourcePath, field: `workflow.exception_routing.classes.${k}`, value: v },
          );
        }
      }
    }
  }
  rejectUnknownKeys(wf.target, WORKFLOW_TARGET_KEYS, "workflow.target", sourcePath);
  rejectUnknownKeys(wf.entry, WORKFLOW_ENTRY_KEYS, "workflow.entry", sourcePath);
  rejectUnknownKeys(
    wf.invariants,
    WORKFLOW_INVARIANTS_KEYS,
    "workflow.invariants",
    sourcePath,
  );
  rejectUnknownKeys(wf.closure, WORKFLOW_CLOSURE_KEYS, "workflow.closure", sourcePath);
  rejectUnknownKeys(
    wf.loop_guards,
    WORKFLOW_LOOP_GUARDS_KEYS,
    "workflow.loop_guards",
    sourcePath,
  );
  for (const [roleName, role] of Object.entries(
    wf.roles as Record<string, unknown>,
  )) {
    rejectUnknownKeys(role, WORKFLOW_ROLE_KEYS, `workflow.roles.${roleName}`, sourcePath);
  }
  if (wf.context_refs !== undefined && (!Array.isArray(wf.context_refs) || wf.context_refs.some((ref) => typeof ref !== "string" || !ref.trim()))) {
    throw new WorkflowSpecError("spec_field_invalid", `${sourcePath} 处的工作流规范：context_refs 必须是由非空字符串地址组成的列表。`);
  }
  (wf.steps as unknown[]).forEach((step, idx) => {
    if (step && typeof step === "object" && !Array.isArray(step)) {
      const s = step as Record<string, unknown>;
      if (
        s.re_present_after_seconds !== undefined &&
        (!Number.isInteger(s.re_present_after_seconds) || (s.re_present_after_seconds as number) <= 0)
      ) {
        throw new WorkflowSpecError(
          "spec_field_invalid",
          `${sourcePath} 处的工作流规范：workflow.steps[${idx}].re_present_after_seconds 必须是正整数（收到 ${JSON.stringify(s.re_present_after_seconds)}）。它表示有意等待的数据包再次呈现给其所有者之前的一次性延迟。`,
          { sourcePath, path: `workflow.steps[${idx}].re_present_after_seconds` },
        );
      }
      if (s.re_present_max_seconds !== undefined && (
        !Number.isInteger(s.re_present_max_seconds) ||
        s.re_present_after_seconds === undefined ||
        (s.re_present_max_seconds as number) < (s.re_present_after_seconds as number)
      )) {
        throw new WorkflowSpecError("spec_field_invalid", `${sourcePath} 处的工作流规范：re_present_max_seconds 需要同时设置 re_present_after_seconds，且必须是不小于该初始延迟的整数。`);
      }
      // OPR.0.4.6.WF2 FR-5：旧版 `gates: [...]` 字符串列表已在解析阶段移除——
      // 在扫描未知键之前检查，使作者获得具体迁移方案，而非笼统拒绝。依据 FR-6 的
      // 如实版本控制，对已固定且正在运行的实例是安全的（它们可正常完成；重新校验
      // 文件时会提示新结构）。
      if (s.gates !== undefined) {
        throw new WorkflowSpecError(
          "spec_gates_removed",
          `${sourcePath} 处的工作流规范：workflow.steps[${idx}].gates 已在 0.4.6 中移除。字符串列表若要承载目标、摘要和证据，就只能演变成魔法字符串微语法，而且它从未被强制执行。请改为声明结构化的步骤级 gate：\n  gate:\n    target: <人工席位会话或已声明的角色名>\n    summary: <直白描述的请求>             # 人工目标必填\n    evidence_ref: <持久化制品路径>         # 人工目标必填`,
          { sourcePath, path: `workflow.steps[${idx}].gates` },
        );
      }
      // OPR.0.4.6.WF2 FR-4：`next_hop.mode: prefer` 已移除——它从未有过独立行为
      //（与省略 mode 完全相同），因此删除这个不起作用的第三状态。在下面的形态检查
      // 之前给出专门的迁移错误。
      const nh = s.next_hop as Record<string, unknown> | undefined;
      if (nh && typeof nh === "object" && !Array.isArray(nh) && nh.mode === "prefer") {
        throw new WorkflowSpecError(
          "spec_prefer_mode_removed",
          `${sourcePath} 处的工作流规范：workflow.steps[${idx}].next_hop.mode 的 "prefer" 已在 0.4.6 中移除。它从未有过独立行为——路由对它的处理与省略 mode 完全相同。请删除 mode 行（路由不变），或使用 "require"（仅通过 suggested_roles 路由，不按声明顺序回退）/ "forbid"（终止步骤）。`,
          { sourcePath, path: `workflow.steps[${idx}].next_hop.mode` },
        );
      }
    }
    rejectUnknownKeys(step, WORKFLOW_STEP_KEYS, `workflow.steps[${idx}]`, sourcePath);
    if (step && typeof step === "object" && !Array.isArray(step)) {
      const s = step as Record<string, unknown>;
      rejectUnknownKeys(
        s.next_hop,
        WORKFLOW_NEXT_HOP_KEYS,
        `workflow.steps[${idx}].next_hop`,
        sourcePath,
      );
      // OPR.0.4.6.WF2 FR-1：在原始数据边界校验分支键形态——next_hop.on 的键
      // 只能取封闭的退出枚举（BR-1）；值必须是非空步骤 ID 字符串（目标是否存在由
      // 校验器进行图检查）。
      const nh = s.next_hop as Record<string, unknown> | undefined;
      const on = nh?.on;
      if (on !== undefined) {
        if (!on || typeof on !== "object" || Array.isArray(on)) {
          throw new WorkflowSpecError(
            "spec_field_invalid",
            `${sourcePath} 处的工作流规范：workflow.steps[${idx}].next_hop.on 必须是“已记录退出 → 步骤 ID”的映射（收到 ${JSON.stringify(on)}）。`,
            { sourcePath, path: `workflow.steps[${idx}].next_hop.on` },
          );
        }
        for (const [exitKey, target] of Object.entries(on as Record<string, unknown>)) {
          if (!(WORKFLOW_EXIT_KINDS as readonly string[]).includes(exitKey)) {
            throw new WorkflowSpecError(
              "spec_branch_key_invalid",
              `${sourcePath} 处的工作流规范：workflow.steps[${idx}].next_hop.on 的键 "${exitKey}" 不是已记录退出。分支键只能取封闭退出枚举：[${WORKFLOW_EXIT_KINDS.join(", ")}]——有意不支持根据其他内容（自由文本、身份、证据 JSON）分支，以保证分支纯净性。`,
              { sourcePath, path: `workflow.steps[${idx}].next_hop.on.${exitKey}`, allowed: [...WORKFLOW_EXIT_KINDS] },
            );
          }
          if (typeof target !== "string" || target.length === 0) {
            throw new WorkflowSpecError(
              "spec_field_invalid",
              `${sourcePath} 处的工作流规范：workflow.steps[${idx}].next_hop.on.${exitKey} 必须是步骤 ID 字符串（收到 ${JSON.stringify(target)}）。`,
              { sourcePath, path: `workflow.steps[${idx}].next_hop.on.${exitKey}` },
            );
          }
        }
      }
      // OPR.0.4.6.WF2 FR-2：在原始数据边界校验 harness 值空间——只允许智能体
      // harness；`terminal` 会得到专门的说明错误（它是真实运行时值，但不能固定）。
      if (s.harness !== undefined) {
        if (
          typeof s.harness !== "string" ||
          !(WORKFLOW_AGENT_HARNESSES as readonly string[]).includes(s.harness)
        ) {
          throw new WorkflowSpecError(
            "spec_harness_invalid",
            `${sourcePath} 处的工作流规范：workflow.steps[${idx}].harness 必须是智能体 harness [${WORKFLOW_AGENT_HARNESSES.join(", ")}] 之一（收到 ${JSON.stringify(s.harness)}）。${s.harness === "terminal" ? " terminal 节点不是智能体 harness——工作流步骤不能固定到它。" : ""} Pi Agent 将在其适配器落地的 0.4.7 版本加入此值空间。`,
            { sourcePath, path: `workflow.steps[${idx}].harness`, allowed: [...WORKFLOW_AGENT_HARNESSES] },
          );
        }
      }
      // OPR.0.4.6.WF2 FR-3：主机固定值的形态必须是非空字符串。是否属于注册表由
      // 能看到注册表的校验器检查；解析器只约束形态。
      if (s.host !== undefined && (typeof s.host !== "string" || s.host.length === 0)) {
        throw new WorkflowSpecError(
          "spec_field_invalid",
          `${sourcePath} 处的工作流规范：workflow.steps[${idx}].host 必须是 "local" 或已注册的主机 ID 字符串（收到 ${JSON.stringify(s.host)}）。`,
          { sourcePath, path: `workflow.steps[${idx}].host` },
        );
      }
      // OPR.0.4.6.WF2 FR-5：gate 对象结构采用封闭键集且为单数形式，并要求 target。
      // 目标类型解析（人工席位或已声明角色）属于校验器的语义检查。
      if (s.gate !== undefined) {
        if (!s.gate || typeof s.gate !== "object" || Array.isArray(s.gate)) {
          throw new WorkflowSpecError(
            "spec_field_invalid",
            `${sourcePath} 处的工作流规范：workflow.steps[${idx}].gate 必须是包含 target 的映射（人工目标还需 summary/evidence_ref）。旧版 gates: [...] 字符串列表已移除。`,
            { sourcePath, path: `workflow.steps[${idx}].gate` },
          );
        }
        rejectUnknownKeys(s.gate, WORKFLOW_GATE_KEYS, `workflow.steps[${idx}].gate`, sourcePath);
        const g = s.gate as Record<string, unknown>;
        if (typeof g.target !== "string" || g.target.length === 0) {
          throw new WorkflowSpecError(
            "spec_field_missing",
            `${sourcePath} 处的工作流规范：workflow.steps[${idx}].gate.target 为必填项——应为人工席位会话或已声明的角色名。`,
            { sourcePath, field: `workflow.steps[${idx}].gate.target` },
          );
        }
        for (const optional of ["summary", "evidence_ref"] as const) {
          if (g[optional] !== undefined && (typeof g[optional] !== "string" || (g[optional] as string).length === 0)) {
            throw new WorkflowSpecError(
              "spec_field_invalid",
              `${sourcePath} 处的工作流规范：workflow.steps[${idx}].gate.${optional} 如有提供，必须是非空字符串（收到 ${JSON.stringify(g[optional])}）。`,
              { sourcePath, path: `workflow.steps[${idx}].gate.${optional}` },
            );
          }
        }
      }
      if (s.depends_on !== undefined) {
        if (!Array.isArray(s.depends_on) || s.depends_on.some((value) => typeof value !== "string" || value.length === 0)) {
          throw new WorkflowSpecError(
            "spec_field_invalid",
            `${sourcePath} 处的工作流规范：workflow.steps[${idx}].depends_on 必须是由非空步骤 ID 组成的列表。`,
            { sourcePath, path: `workflow.steps[${idx}].depends_on`, value: s.depends_on },
          );
        }
        if (new Set(s.depends_on).size !== s.depends_on.length) {
          throw new WorkflowSpecError(
            "spec_field_invalid",
            `${sourcePath} 处的工作流规范：workflow.steps[${idx}].depends_on 包含重复的前置步骤。`,
            { sourcePath, path: `workflow.steps[${idx}].depends_on`, value: s.depends_on },
          );
        }
      }
      if (s.acceptance !== undefined) {
        if (!s.acceptance || typeof s.acceptance !== "object" || Array.isArray(s.acceptance)) {
          throw new WorkflowSpecError(
            "spec_field_invalid",
            `${sourcePath} 处的工作流规范：workflow.steps[${idx}].acceptance 必须是包含 candidate、verdicts 和 evidence_ref 的映射。`,
            { sourcePath, path: `workflow.steps[${idx}].acceptance` },
          );
        }
        rejectUnknownKeys(s.acceptance, WORKFLOW_ACCEPTANCE_KEYS, `workflow.steps[${idx}].acceptance`, sourcePath);
        const acceptance = s.acceptance as Record<string, unknown>;
        if (typeof acceptance.candidate !== "string" || acceptance.candidate.length === 0) {
          throw new WorkflowSpecError("spec_field_missing", `${sourcePath} 处的工作流规范：workflow.steps[${idx}].acceptance.candidate 为必填项。`, { sourcePath, field: `workflow.steps[${idx}].acceptance.candidate` });
        }
        if (!Array.isArray(acceptance.verdicts) || acceptance.verdicts.length === 0 || acceptance.verdicts.some((value) => typeof value !== "string" || value.length === 0)) {
          throw new WorkflowSpecError("spec_field_invalid", `${sourcePath} 处的工作流规范：workflow.steps[${idx}].acceptance.verdicts 必须是由非空裁决字符串组成的列表。`, { sourcePath, field: `workflow.steps[${idx}].acceptance.verdicts` });
        }
        if (typeof acceptance.evidence_ref !== "string" || acceptance.evidence_ref.length === 0) {
          throw new WorkflowSpecError("spec_field_missing", `${sourcePath} 处的工作流规范：workflow.steps[${idx}].acceptance.evidence_ref 为必填项。`, { sourcePath, field: `workflow.steps[${idx}].acceptance.evidence_ref` });
        }
      }
    }
  });

  return {
    id: wf.id,
    version: String(wf.version),
    objective: typeof wf.objective === "string" ? wf.objective : undefined,
    context_refs: wf.context_refs as string[] | undefined,
    target: wf.target as WorkflowSpec["target"],
    entry: wf.entry as WorkflowSpec["entry"],
    roles: wf.roles as WorkflowSpec["roles"],
    steps: wf.steps as WorkflowSpec["steps"],
    invariants: wf.invariants as WorkflowSpec["invariants"],
    closure: wf.closure as WorkflowSpec["closure"],
    loop_guards: wf.loop_guards as WorkflowSpec["loop_guards"],
    // OPR.0.4.6.WF5 FR-2：已在上方校验，并在此复制（这正是 WF-1 迁移 050 的
    // 教训：已校验的键若在组装时丢失，会静默失效；虚拟机在首次执行时发现了它）。
    exception_routing: wf.exception_routing as WorkflowSpec["exception_routing"],
    coordination_terminal_turn_rule:
      typeof wf.coordination_terminal_turn_rule === "string"
        ? wf.coordination_terminal_turn_rule
        : undefined,
  };
}

export class WorkflowSpecCache {
  private readonly hasSpecJsonColumn: boolean;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.hasSpecJsonColumn = detectSpecColumn(db, "spec_json");
  }

  /**
   * 通过缓存从磁盘读取工作流规范。返回缓存行；如果 source_hash 不同，或此前
   * 未缓存该规范，则重新缓存。
   */
  readThrough(sourcePath: string): WorkflowSpecRow {
    if (!existsSync(sourcePath)) {
      throw new WorkflowSpecError(
        "spec_file_missing",
        `在 ${sourcePath} 未找到工作流规范文件`,
        { sourcePath },
      );
    }
    const raw = readFileSync(sourcePath, "utf-8");
    const sourceHash = createHash("sha256").update(raw).digest("hex");
    const spec = parseWorkflowSpec(raw, sourcePath);
    const existing = this.db
      .prepare(
        `SELECT * FROM workflow_specs WHERE name = ? AND version = ?`,
      )
      .get(spec.id, spec.version) as SpecRow | undefined;
    if (existing && existing.source_hash === sourceHash) {
      // readThrough 以文件为准：返回刚解析的文件规范，使校验能看到 workflow.entry
      // 和 workflow.invariants 等未存入独立列的元数据。
      // OPR.0.4.6.WF1：让旧行自愈——回填 spec_json，使投影阶段的使用方
      //（getByNameVersion）也能看到完整规范（迁移 050 前，仅按列重建会丢失
      // loop_guards/invariants/closure/entry）。
      if (this.hasSpecJsonColumn && !existing.spec_json) {
        this.db
          .prepare(`UPDATE workflow_specs SET spec_json = ? WHERE spec_id = ?`)
          .run(JSON.stringify(spec), existing.spec_id);
      }
      return rowToWorkflowSpec(existing, spec);
    }
    const cachedAt = this.now().toISOString();
    const purpose = spec.objective ?? null;
    const targetRig = spec.target?.rig ?? null;
    const rolesJson = JSON.stringify(spec.roles);
    const stepsJson = JSON.stringify(spec.steps);
    const coordinationTerminalTurnRule = spec.coordination_terminal_turn_rule ?? "hot_potato";
    if (existing) {
      // 原地更新（名称和版本相同，但内容已变化）。
      const specJsonSet = this.hasSpecJsonColumn ? ", spec_json = ?" : "";
      const updateParams: unknown[] = [
        purpose,
        targetRig,
        rolesJson,
        stepsJson,
        coordinationTerminalTurnRule,
        sourcePath,
        sourceHash,
        cachedAt,
      ];
      if (this.hasSpecJsonColumn) updateParams.push(JSON.stringify(spec));
      updateParams.push(existing.spec_id);
      this.db
        .prepare(
          `UPDATE workflow_specs SET
             purpose = ?, target_rig = ?, roles_json = ?, steps_json = ?,
             coordination_terminal_turn_rule = ?, source_path = ?,
             source_hash = ?, cached_at = ?${specJsonSet}
           WHERE spec_id = ?`,
        )
        .run(...(updateParams as never[]));
      return rowToWorkflowSpec({
        ...existing,
        purpose,
        target_rig: targetRig,
        roles_json: rolesJson,
        steps_json: stepsJson,
        coordination_terminal_turn_rule: coordinationTerminalTurnRule,
        source_path: sourcePath,
        source_hash: sourceHash,
        cached_at: cachedAt,
      }, spec);
    }
    const specId = ulid();
    const insertCols = this.hasSpecJsonColumn ? ", spec_json" : "";
    const insertPlaceholder = this.hasSpecJsonColumn ? ", ?" : "";
    const insertParams: unknown[] = [
      specId,
      spec.id,
      spec.version,
      purpose,
      targetRig,
      rolesJson,
      stepsJson,
      coordinationTerminalTurnRule,
      sourcePath,
      sourceHash,
      cachedAt,
    ];
    if (this.hasSpecJsonColumn) insertParams.push(JSON.stringify(spec));
    this.db
      .prepare(
        `INSERT INTO workflow_specs (
           spec_id, name, version, purpose, target_rig,
           roles_json, steps_json, coordination_terminal_turn_rule,
           source_path, source_hash, cached_at${insertCols}
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${insertPlaceholder})`,
      )
      .run(...(insertParams as never[]));
    return rowToWorkflowSpec({
      spec_id: specId,
      name: spec.id,
      version: spec.version,
      purpose,
      target_rig: targetRig,
      roles_json: rolesJson,
      steps_json: stepsJson,
      coordination_terminal_turn_rule: coordinationTerminalTurnRule,
      source_path: sourcePath,
      source_hash: sourceHash,
      cached_at: cachedAt,
    }, spec);
  }

  /**
   * 缓存确定性生成的规范，而不伪造人工编写的工作流文件。生命周期编译是只读的；
   * 只有后续的实例化边界会调用此方法，届时运行时需要常规规范缓存行来进行投影和
   * 重启恢复。
   */
  putGenerated(spec: WorkflowSpec, sourcePath: string, sourceHash: string): WorkflowSpecRow {
    const existing = this.db
      .prepare(`SELECT * FROM workflow_specs WHERE name = ? AND version = ?`)
      .get(spec.id, spec.version) as SpecRow | undefined;
    const cachedAt = this.now().toISOString();
    const purpose = spec.objective ?? null;
    const targetRig = spec.target?.rig ?? null;
    const rolesJson = JSON.stringify(spec.roles);
    const stepsJson = JSON.stringify(spec.steps);
    const coordinationTerminalTurnRule = spec.coordination_terminal_turn_rule ?? "hot_potato";
    if (existing) {
      if (existing.source_hash !== sourceHash) {
        throw new WorkflowSpecError(
          "generated_spec_identity_collision",
          `生成的工作流 ${spec.id}@${spec.version} 已指向不同的源字节`,
          { sourcePath, sourceHash, cachedSourcePath: existing.source_path, cachedSourceHash: existing.source_hash },
        );
      }
      return rowToWorkflowSpec(existing, spec);
    }
    const specId = ulid();
    const extraCols = this.hasSpecJsonColumn ? ", spec_json" : "";
    const extraValue = this.hasSpecJsonColumn ? ", ?" : "";
    const params: unknown[] = [
      specId,
      spec.id,
      spec.version,
      purpose,
      targetRig,
      rolesJson,
      stepsJson,
      coordinationTerminalTurnRule,
      sourcePath,
      sourceHash,
      cachedAt,
    ];
    if (this.hasSpecJsonColumn) params.push(JSON.stringify(spec));
    this.db.prepare(
      `INSERT INTO workflow_specs (
         spec_id, name, version, purpose, target_rig, roles_json, steps_json,
         coordination_terminal_turn_rule, source_path, source_hash, cached_at${extraCols}
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${extraValue})`,
    ).run(...(params as never[]));
    return rowToWorkflowSpec({
      spec_id: specId,
      name: spec.id,
      version: spec.version,
      purpose,
      target_rig: targetRig,
      roles_json: rolesJson,
      steps_json: stepsJson,
      coordination_terminal_turn_rule: coordinationTerminalTurnRule,
      source_path: sourcePath,
      source_hash: sourceHash,
      cached_at: cachedAt,
    }, spec);
  }

  getByNameVersion(name: string, version: string): WorkflowSpecRow | null {
    const row = this.db
      .prepare(`SELECT * FROM workflow_specs WHERE name = ? AND version = ?`)
      .get(name, version) as SpecRow | undefined;
    return row ? rowToWorkflowSpec(row) : null;
  }

  /**
   * OPR.0.3.3.04.1：按名称/缓存键将传入标识符解析为缓存规范中存储的
   *（已解析）sourcePath。返回指定有效规范的 source_path（存在多个版本时取最新），
   * 若缓存中没有该名称，则返回 null。
   *
   * 这样，新操作员无需知道隐藏文件路径，也能使用 `workflow instantiate
   * <discovered-name>`：预置内建规范按名称缓存，其 sourcePath 已由
   * starter-spec-loader 在植入时解析（例如发行安装中的
   * `dist/builtins/workflow-specs/...`）。解析会原样返回这个已存储路径，不会根据
   * 源码树假设重新推导，因此在生产目录布局中仍然安全（参见 slice-16 的源码树与
   * dist 差异教训）。`version != ''` 护栏会排除 slice-11 诊断行（以文件基本名作为键，
   * 版本为空）；有效规范始终带版本（parseWorkflowSpec 要求 workflow.version）。
   * 此处按 `version` 而不是 slice-11 的 `status` 列筛选，因此解析不依赖后续迁移。
   */
  resolveSourcePathByName(name: string): string | null {
    const row = this.db
      .prepare(
        `SELECT source_path FROM workflow_specs
           WHERE name = ? AND version != ''
           ORDER BY version DESC LIMIT 1`,
      )
      .get(name) as { source_path: string } | undefined;
    return row?.source_path ?? null;
  }

  /**
   * 列出所有缓存规范，先按名称、再按版本排序。供 `GET /api/workflow/specs` 端点
   * 使用。开销很小——workflow_specs 表的规模受人工编写规范与内建起始规范的数量
   * 限制（单主机 MVP）。
   */
  listAll(): WorkflowSpecRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM workflow_specs ORDER BY name, version`)
      .all() as SpecRow[];
    return rows.map((row) => rowToWorkflowSpec(row));
  }

  /**
   * Slice 11（工作流规范文件夹发现）——诊断行写入器。当 YAML 解析或校验失败时，
   * scanWorkflowSpecFolder 使用它，使 Library UI 能在用户放置错误工作流 YAML 的
   * 同一路径显示错误行。该行的 name 字段回退为源文件基本名，因此即使 YAML 无法
   * 解析，Library 也有稳定标签。
   *
   * 每个 source_path 仅一行：对已有行（有效行或诊断行）的路径调用 writeDiagnostic，
   * 会把该行的 status 更新为 'error'，更新 error_message、source_hash、cached_at，
   * 并将解析后的载荷字段重置为空（不再信任先前 YAML）。同一路径支持在 'valid' 与
   * 'error' 间往返：readThrough 成功后会将该行恢复为 'valid'，并还原解析后的载荷。
   */
  writeDiagnostic(opts: {
    sourcePath: string;
    sourceHash: string;
    errorMessage: string;
  }): void {
    const cachedAt = this.now().toISOString();
    const fallbackName = opts.sourcePath.split("/").pop() ?? opts.sourcePath;
    const existing = this.db
      .prepare(`SELECT spec_id FROM workflow_specs WHERE source_path = ?`)
      .get(opts.sourcePath) as { spec_id: string } | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE workflow_specs SET
             status = 'error',
             error_message = ?,
             name = ?,
             version = '',
             purpose = NULL,
             target_rig = NULL,
             roles_json = '{}',
             steps_json = '[]',
             coordination_terminal_turn_rule = 'hot_potato',
             source_hash = ?,
             cached_at = ?
           WHERE spec_id = ?`,
        )
        .run(opts.errorMessage, fallbackName, opts.sourceHash, cachedAt, existing.spec_id);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO workflow_specs (
           spec_id, name, version, purpose, target_rig,
           roles_json, steps_json, coordination_terminal_turn_rule,
           source_path, source_hash, cached_at, status, error_message
         ) VALUES (?, ?, '', NULL, NULL, '{}', '[]', 'hot_potato', ?, ?, ?, 'error', ?)`,
      )
      .run(ulid(), fallbackName, opts.sourcePath, opts.sourceHash, cachedAt, opts.errorMessage);
  }

  /**
   * Slice 11——按 source_path 删除缓存行（扫描器检测到磁盘上的工作流 YAML 已删除时
   * 使用）。返回删除的行数（该路径不存在行时为 0）。
   */
  removeBySourcePath(sourcePath: string): number {
    const result = this.db
      .prepare(`DELETE FROM workflow_specs WHERE source_path = ?`)
      .run(sourcePath);
    return result.changes;
  }

  /**
   * OPR.0.3.2.22 Bug 4——清理 source_path 位于噪声目录中的缓存行；Bug 4 修复后的
   * walkYamlFiles SKIP_DIRS 护栏已拒绝扫描这些目录。若不清理，在 SKIP_DIRS 护栏
   * 落地前插入的行会永久残留（spec-library-workflow-scanner.ts 中的扫描器清理只会
   * 作用于以工作区 `workflows/` 文件夹前缀开头的路径）。启动时调用一次。返回删除行数。
   *
   * installRoot 护栏（Bug 4 后续修复）：若提供此参数，即便行匹配噪声模式，只要其
   * source_path 以安装根目录开头，就会被保留。这是保护发行内建工作流规范的关键安全
   * 机制；这些规范在发布到 npm 的生产守护进程中位于
   * `<pkg>/dist/builtins/workflow-specs/`。没有此护栏，无范围限制的 DELETE 会在每次
   * 启动时清空所有发行内建规范。调用点应从 cwd-resolution 传入
   * `getOpenRigInstallRoot()`。省略时不保留安装根目录（仅便于完全在任何安装之外运行的测试）。
   */
  pruneNoiseDirRows(installRoot?: string): number {
    const guardClause = installRoot ? ` AND source_path NOT LIKE ? || '%'` : "";
    const params: string[] = installRoot ? [installRoot] : [];
    const result = this.db
      .prepare(
        `DELETE FROM workflow_specs WHERE (
           source_path LIKE '%/.worktrees/%'
           OR source_path LIKE '%/node_modules/%'
           OR source_path LIKE '%/.git/%'
           OR source_path LIKE '%/dist/%'
           OR source_path LIKE '%/build/%'
           OR source_path LIKE '%/.turbo/%'
           OR source_path LIKE '%/.next/%'
         )${guardClause}`,
      )
      .run(...params);
    return result.changes;
  }

  getByIdOrThrow(specId: string): WorkflowSpecRow {
    const row = this.db
      .prepare(`SELECT * FROM workflow_specs WHERE spec_id = ?`)
      .get(specId) as SpecRow | undefined;
    if (!row) {
      throw new WorkflowSpecError(
        "spec_not_found",
        `缓存中未找到工作流规范 ${specId}`,
        { specId },
      );
    }
    return rowToWorkflowSpec(row);
  }
}

const warnedLegacyRehydrations = new Set<string>();

/** 仅为具名的如实降级测试导出。 */
export function resetLegacyRehydrationWarnings(): void {
  warnedLegacyRehydrations.clear();
}

function warnLegacyRehydrationOnce(name: string, version: string): void {
  const key = `${name}@${version}`;
  if (warnedLegacyRehydrations.has(key)) return;
  warnedLegacyRehydrations.add(key);
  console.warn(
    `工作流规范 ${key} 在无法完整还原的情况下完成重建（050 之前的缓存行：投影时无法取得 loop_guards/invariants/closure/entry）。请重新校验规范文件（zrig workflow validate <path>）以修复该缓存行。`,
  );
}

function rowToWorkflowSpec(row: SpecRow, parsedSpec?: WorkflowSpec): WorkflowSpecRow {
  // OPR.0.4.6.WF1：依次优先使用——刚从文件解析的规范（readThrough 以文件为准的
  // 覆盖值），然后是存储的完整规范（迁移 050 的 spec_json，使 getByNameVersion
  // 能在投影时看到 loop_guards/invariants/closure/entry），最后才是旧版仅按列重建
  //（050 之前的行；这些字段确实缺失，直到下次 readThrough 让该行自愈）。
  const storedSpec: WorkflowSpec | undefined =
    !parsedSpec && row.spec_json
      ? (JSON.parse(row.spec_json) as WorkflowSpec)
      : undefined;
  const hydrated = parsedSpec ?? storedSpec;
  if (!hydrated) {
    // 剩余的最坏情况（架构折叠、构建中期约定）：在投影时解析一个 050 之前的旧行，
    // 其源文件可能已经消失——下面的重建不含 loop_guards/invariants/closure/entry。
    // 降级必须可见，绝不能静默地在无护栏状态下运行。每个进程对每份规范仅提示一次
    //（限制噪声；在修复前此条件会一直成立）。
    warnLegacyRehydrationOnce(row.name, row.version);
  }
  const spec: WorkflowSpec = hydrated
    ? {
        ...hydrated,
        coordination_terminal_turn_rule:
          hydrated.coordination_terminal_turn_rule ?? row.coordination_terminal_turn_rule,
      }
    : {
        id: row.name,
        version: row.version,
        objective: row.purpose ?? undefined,
        target: row.target_rig ? { rig: row.target_rig } : undefined,
        roles: JSON.parse(row.roles_json) as WorkflowSpec["roles"],
        steps: JSON.parse(row.steps_json) as WorkflowSpec["steps"],
        coordination_terminal_turn_rule: row.coordination_terminal_turn_rule,
      };
  return {
    specId: row.spec_id,
    name: row.name,
    version: row.version,
    purpose: row.purpose,
    targetRig: row.target_rig,
    spec,
    coordinationTerminalTurnRule: row.coordination_terminal_turn_rule,
    sourcePath: row.source_path,
    sourceHash: row.source_hash,
    cachedAt: row.cached_at,
  };
}
