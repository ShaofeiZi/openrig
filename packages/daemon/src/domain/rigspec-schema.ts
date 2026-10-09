import type {
  LegacyRigSpec,
  LegacyRigSpecNode,
  LegacyRigSpecEdge,
  RigSpec,
  RigSpecPod,
  RigServicesSpec,
  RigServicesWaitTarget,
  RigServicesSurface,
  RigServicesCheckpointHook,
  ValidationResult,
  WorkspaceSpec,
  WorkspaceRepoSpec,
} from "./types.js";
import { WORKSPACE_KINDS } from "./types.js";
import { validateSafePath } from "./path-safety.js";
import { CLAUDE_MANAGED_BLOCK_FILES } from "./managed-blocks.js";
import { canonicalCompactionStrategy, canonicalContinuityMechanic } from "./agent-manifest.js";
import { aliasModelPinAdvisory } from "./spec-validation-advisory.js";
import { validatePermissionPolicyRef } from "./permission-policy/policy-ref.js";
import { validateStartupBlock, normalizeStartupBlock } from "./startup-validation.js";
import { COMPOSE_PROJECT_NAME_PATTERN, deriveComposeProjectName } from "./compose-project-name.js";
import * as path from "node:path";

// -- 规范的 pod 感知 RigSpec 校验（AgentSpec 重启）--

// OPR.0.3.3.24：导出此集合，使 add_member 收敛操作按与 rigspec pod 本地边相同的
// 规范集合校验边类型（不再存在第二条更宽松的边输入路径）。
export const VALID_EDGE_KINDS = new Set(["delegates_to", "spawned_by", "can_observe", "collaborates_with", "escalates_to"]);

/** 规范校验能力注册表（B8 系列，由 r2 裁定的到期耦合）。这是行为哨兵而非文件名：
 *  其他代码必须响应的校验能力会在此注册自身，而消费者按能力进行门控。当前契约
 *  （05:03Z 案头裁定）：5.3 规范校验建议在落地 model-pin 规范化时，必须添加
 *  "model-pin-canonicalization"——这一行会在运行时自动终止 claude 别名迁移桥，
 *  并使其 pin 测试变红，直至删除桥接常量。 */
export const SPEC_VALIDATION_CAPABILITIES: ReadonlySet<string> = new Set(["model-pin-canonicalization"]);
const VALID_SYNC_TRIGGERS = new Set(["pre_compaction", "pre_shutdown", "manual", "milestone"]);
const VALID_RESTORE_POLICIES = new Set(["resume_if_possible", "relaunch_fresh", "checkpoint_only"]);
const VALID_IMPORT_PREFIXES = ["local:", "path:"];
const VALID_SERVICES_KIND = new Set(["compose"]);
const VALID_DOWN_POLICIES = new Set(["leave_running", "down", "down_and_volumes"]);
const VALID_WAIT_TARGET_CONDITIONS = new Set(["healthy"]);
const VALID_WORKSPACE_KINDS = new Set<string>(WORKSPACE_KINDS as readonly string[]);

const RIG_KEYS = new Set([
  "version", "name", "summary", "culture_file", "permission_policy", "managed_blocks", "docs",
  "startup", "services", "workspace", "pods", "edges",
]);
const POD_KEYS = new Set(["id", "label", "summary", "continuity_policy", "startup", "members", "edges"]);
const MEMBER_KEYS = new Set([
  "id", "label", "agent_ref", "profile", "runtime", "codex_config_profile",
  "model", "role", "permission_policy", "cwd", "restore_policy",
  "compaction_strategy", "mechanic", "startup", "session_source", "starter_ref",
]);
const EDGE_KEYS = new Set(["kind", "from", "to"]);

/** OPR.0.5.8.7 — 拓扑规范化器采用显式字面量。在该字面量让已接受输入消失之前，
 * 拒绝未知结构键。这里刻意保持精简：只检查四层拓扑对象，而不另建一套 schema 框架。 */
function validateManagedBlocks(raw: unknown): string[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return ['managed_blocks：必须是映射，例如 { claude-code: CLAUDE.local.md }'];
  }
  const errors: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key !== "claude-code") {
      errors.push(`managed_blocks.${key}：不支持运行时 "${key}"；仅可配置 "claude-code"`);
    } else if (!(CLAUDE_MANAGED_BLOCK_FILES as readonly unknown[]).includes(value)) {
      errors.push(`managed_blocks.claude-code：必须是 ${CLAUDE_MANAGED_BLOCK_FILES.join(", ")} 之一（收到 ${JSON.stringify(value)}）`);
    }
  }
  return errors;
}

function rejectUnknownTopologyKeys(
  raw: unknown,
  allowed: ReadonlySet<string>,
  prefix: string,
): string[] {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return [];
  return Object.keys(raw as Record<string, unknown>)
    .filter((key) => !allowed.has(key))
    .map((key) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return `${path}：未知键 "${key}"；拒绝该规范，因为规范化会丢弃此键并改变请求的拓扑`;
    });
}

/**
 * 支持 pod 的 RigSpec 校验器。AgentSpec 重启的规范契约。
 */
export class RigSpecSchema {
  /**
   * 校验已解析的 rig 规范对象。收集所有错误。
   * @param raw - 已解析的 YAML 对象
   * @returns 校验结果
   */
  static validate(raw: unknown, opts?: { externalQualifiedIds?: Iterable<string> }): ValidationResult {
    const errors: string[] = [];
    // OPR.0.5.3.3 — 开放失败式建议（绝不影响 `valid`），例如别名形式的模型固定值。
    const advisories: string[] = [];

    if (!raw || typeof raw !== "object") {
      return { valid: false, errors: ["rig 规范必须是对象"] };
    }

    const obj = raw as Record<string, unknown>;
    errors.push(...rejectUnknownTopologyKeys(obj, RIG_KEYS, ""));

    // 必填字段
    if (!obj["name"] || typeof obj["name"] !== "string") errors.push("name：必填的非空字符串");
    if (!obj["version"] || typeof obj["version"] !== "string") errors.push("version：必填的非空字符串");

    // culture_file 路径安全性
    if (obj["culture_file"] !== undefined && obj["culture_file"] !== null) {
      if (typeof obj["culture_file"] !== "string") {
        errors.push("culture_file：必须是字符串");
      } else {
        const pathErr = validateSafePath(obj["culture_file"] as string, "culture_file");
        if (pathErr) errors.push(pathErr);
      }
    }

    // docs：可选的文档文件路径数组
    if (obj["docs"] !== undefined) {
      if (!Array.isArray(obj["docs"])) {
        errors.push("docs：必须是数组");
      } else {
        for (let i = 0; i < (obj["docs"] as unknown[]).length; i++) {
          const entry = (obj["docs"] as unknown[])[i];
          if (!entry || typeof entry !== "object") {
            errors.push(`docs[${i}]：必须是带 path 字段的对象`);
            continue;
          }
          const doc = entry as Record<string, unknown>;
          if (!doc["path"] || typeof doc["path"] !== "string") {
            errors.push(`docs[${i}].path：必填的非空字符串`);
          } else {
            const pathErr = validateSafePath(doc["path"] as string, `docs[${i}].path`);
            if (pathErr) errors.push(pathErr);
          }
        }
      }
    }

    // rig 级 startup
    if (obj["startup"] !== undefined) {
      errors.push(...validateStartupBlock(obj["startup"], "startup"));
    }

    // services：与 pods 同级的可选顶层字段
    if (obj["services"] !== undefined) {
      errors.push(...validateServicesBlock(obj["services"], "services"));
    }

    // PL-007：可选的 workspace 块（类型化原语）。为保持向后兼容，缺少该字段的 rig
    // 仍然有效；未声明时，whoami/node-inventory 返回 null workspace。
    if (obj["workspace"] !== undefined && obj["workspace"] !== null) {
      errors.push(...this.validateWorkspace(obj["workspace"]).errors);
    }

    // OPR.0.4.8.3 接缝 B：可选的 rig 级 permission_policy 引用（builtin:<name> 或相对于
    // 规范的自定义路径）。缺失 = 下限（如实缺失）。显式提供的值——包括 null（R2 HIGH-3）——
    // 必须通过校验：已提供但无效属于结构化规范错误，绝不能静默折叠为缺失/下限。与 member 级一致。
    if (obj["permission_policy"] !== undefined) {
      const refErr = validatePermissionPolicyRef(obj["permission_policy"], "permission_policy");
      if (refErr) errors.push(refErr);
    }

    // #25：可选的逐运行时托管块目标。本版本仅可配置 claude-code；Codex 仍使用 AGENTS.md。
    if (obj["managed_blocks"] !== undefined) {
      errors.push(...validateManagedBlocks(obj["managed_blocks"]));
    }

    // pods：必填数组
    if (!obj["pods"] || !Array.isArray(obj["pods"])) {
      errors.push("pods：必填的非空数组");
    } else {
      const pods = obj["pods"] as Record<string, unknown>[];
      if (pods.length === 0) errors.push("pods：必须至少包含一个 pod");

      const podIds = new Set<string>();
      for (let pi = 0; pi < pods.length; pi++) {
        const pod = pods[pi]!;
        errors.push(...validatePod(pod, pi, podIds, advisories));
      }

      // 跨 pod 边校验
      const allQualifiedIds = new Set<string>(opts?.externalQualifiedIds ?? []);
      for (const pod of pods) {
        const podId = pod["id"] as string;
        const members = pod["members"] as Record<string, unknown>[] | undefined;
        if (podId && Array.isArray(members)) {
          for (const m of members) {
            if (m["id"]) allQualifiedIds.add(`${podId}.${m["id"]}`);
            const pinAdvisory = aliasModelPinAdvisory(m["model"], `pods.${podId}.members.${m["id"] ?? "?"}`);
            if (pinAdvisory) advisories.push(pinAdvisory);
          }
        }
      }

      if (obj["edges"] !== undefined) {
        if (!Array.isArray(obj["edges"])) {
          errors.push("edges：必须是数组");
        } else {
          for (let ei = 0; ei < (obj["edges"] as unknown[]).length; ei++) {
            const edge = (obj["edges"] as Record<string, unknown>[])[ei]!;
            errors.push(...validateCrossPodEdge(edge, ei, allQualifiedIds));
          }
        }
      }
    }

    return { valid: errors.length === 0, errors, ...(advisories.length ? { advisories } : {}) };
  }

  /**
   * 将已校验的 rig 规范规范化为标准类型结构。
   * @param raw - 已解析的 YAML 对象（必须先通过校验）
   * @returns 规范化后的 RigSpec
   */
  static normalize(raw: Record<string, unknown>): RigSpec {
    const pods = (raw["pods"] as Record<string, unknown>[]).map(normalizePod);
    const edges = Array.isArray(raw["edges"])
      ? (raw["edges"] as Record<string, unknown>[]).map((e) => ({
          kind: e["kind"] as string,
          from: e["from"] as string,
          to: e["to"] as string,
        }))
      : [];

    const docs = Array.isArray(raw["docs"])
      ? (raw["docs"] as Record<string, unknown>[]).map((d) => ({ path: d["path"] as string }))
      : undefined;

    return {
      version: raw["version"] as string,
      name: raw["name"] as string,
      summary: raw["summary"] as string | undefined,
      cultureFile: raw["culture_file"] as string | undefined,
      permissionPolicy: raw["permission_policy"] as string | undefined,
      managedBlocks: raw["managed_blocks"] as RigSpec["managedBlocks"],
      docs,
      startup: raw["startup"] ? normalizeStartupBlock(raw["startup"]) : undefined,
      services: raw["services"] ? normalizeServicesBlock(raw["services"], raw["name"] as string) : undefined,
      workspace: raw["workspace"] ? this.normalizeWorkspace(raw["workspace"]) : undefined,
      pods,
      edges,
    };
  }

  /** 仅通过规范 schema 校验 RigSpec workspace 块。 */
  static validateWorkspace(raw: unknown): ValidationResult {
    const errors = validateWorkspaceBlock(raw, "workspace");
    return { valid: errors.length === 0, errors };
  }

  /** 仅规范化已校验的 RigSpec workspace 块。 */
  static normalizeWorkspace(raw: unknown): WorkspaceSpec | undefined {
    return normalizeWorkspaceBlock(raw);
  }
}

/** PL-007 Workspace 原语——校验可选的 rig 级 workspace 块。必填：workspace_root
 *  （非空字符串）、repos（{name, path, kind} 数组）。可选：default_repo、knowledge_root。
 *  约束：kind 限于 5 个保留值；repo 名称唯一；default_repo 必须引用已声明的 repo；
 *  路径必须是非空字符串（根据 PL-007 PRD，校验时不检查是否存在——schema 仅检查声明，
 *  实时文件系统检查在预检阶段执行）。 */
function validateWorkspaceBlock(raw: unknown, prefix: string): string[] {
  if (typeof raw !== "object" || Array.isArray(raw)) return [`${prefix}：必须是对象`];
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];

  const wr = obj["workspace_root"];
  if (typeof wr !== "string" || wr.trim() === "") {
    errors.push(`${prefix}.workspace_root：必填的非空字符串`);
  }

  const rawRepos = obj["repos"];
  const repoNames = new Set<string>();
  if (!Array.isArray(rawRepos)) {
    errors.push(`${prefix}.repos：必填数组`);
  } else {
    for (let i = 0; i < rawRepos.length; i++) {
      const repo = rawRepos[i];
      const repoPrefix = `${prefix}.repos[${i}]`;
      if (typeof repo !== "object" || repo === null || Array.isArray(repo)) {
        errors.push(`${repoPrefix}：必须是带有 name、path、kind 的对象`);
        continue;
      }
      const r = repo as Record<string, unknown>;
      const name = r["name"];
      if (typeof name !== "string" || name.trim() === "") {
        errors.push(`${repoPrefix}.name：必填的非空字符串`);
      } else if (repoNames.has(name)) {
        errors.push(`${repoPrefix}.name：repo 名称 "${name}" 重复`);
      } else {
        repoNames.add(name);
      }
      const repoPath = r["path"];
      if (typeof repoPath !== "string" || repoPath.trim() === "") {
        errors.push(`${repoPrefix}.path：必填的非空字符串`);
      }
      const kind = r["kind"];
      if (typeof kind !== "string" || !VALID_WORKSPACE_KINDS.has(kind)) {
        errors.push(`${repoPrefix}.kind：必须是 ${[...VALID_WORKSPACE_KINDS].join(", ")} 之一（收到 ${JSON.stringify(kind)}）`);
      }
    }
  }

  const defaultRepo = obj["default_repo"];
  if (defaultRepo !== undefined && defaultRepo !== null) {
    if (typeof defaultRepo !== "string" || defaultRepo.trim() === "") {
      errors.push(`${prefix}.default_repo：提供时必须是非空字符串`);
    } else if (repoNames.size > 0 && !repoNames.has(defaultRepo)) {
      errors.push(`${prefix}.default_repo："${defaultRepo}" 与 repos[] 中的任何 repo 均不匹配`);
    }
  }

  const knowledgeRoot = obj["knowledge_root"];
  if (knowledgeRoot !== undefined && knowledgeRoot !== null) {
    if (typeof knowledgeRoot !== "string" || knowledgeRoot.trim() === "") {
      errors.push(`${prefix}.knowledge_root：提供时必须是非空字符串`);
    }
  }

  return errors;
}

/** PL-007——将 YAML workspace 块规范化为类型化 WorkspaceSpec。相对 repo 路径以
 *  workspace_root 为基准解析（遵循示例约定：作者填写相对于 hub 的 `path: openrig`）。 */
function normalizeWorkspaceBlock(raw: unknown): WorkspaceSpec | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const workspaceRoot = obj["workspace_root"] as string;
  const rawRepos = obj["repos"];
  const repos: WorkspaceRepoSpec[] = [];
  if (Array.isArray(rawRepos)) {
    for (const r of rawRepos as Record<string, unknown>[]) {
      const declaredPath = r["path"] as string;
      const absolute = path.isAbsolute(declaredPath)
        ? declaredPath
        : path.resolve(workspaceRoot, declaredPath);
      repos.push({
        name: r["name"] as string,
        path: absolute,
        kind: r["kind"] as WorkspaceRepoSpec["kind"],
      });
    }
  }
  return {
    workspaceRoot,
    repos,
    defaultRepo: typeof obj["default_repo"] === "string" ? (obj["default_repo"] as string) : undefined,
    knowledgeRoot: typeof obj["knowledge_root"] === "string" ? (obj["knowledge_root"] as string) : undefined,
  };
}

// -- Pod 校验 --

function validatePod(pod: Record<string, unknown>, index: number, podIds: Set<string>, advisories: string[]): string[] {
  const errors: string[] = [];
  const prefix = `pods[${index}]`;
  errors.push(...rejectUnknownTopologyKeys(pod, POD_KEYS, prefix));

  // id
  if (!pod["id"] || typeof pod["id"] !== "string") {
    errors.push(`${prefix}.id：必填的非空字符串`);
  } else {
    const id = pod["id"] as string;
    if (id.includes(".")) errors.push(`${prefix}.id：不得包含点号（收到 "${id}"）`);
    if (podIds.has(id)) errors.push(`${prefix}.id：pod id "${id}" 重复`);
    podIds.add(id);
  }

  // label
  if (!pod["label"] || typeof pod["label"] !== "string") {
    errors.push(`${prefix}.label：必填的非空字符串`);
  }

  // continuity_policy
  if (pod["continuity_policy"] !== undefined) {
    errors.push(...validateContinuityPolicy(pod["continuity_policy"], `${prefix}.continuity_policy`));
  }

  // pod 的 startup
  if (pod["startup"] !== undefined) {
    errors.push(...validateStartupBlock(pod["startup"], `${prefix}.startup`));
  }

  // members
  if (!pod["members"] || !Array.isArray(pod["members"])) {
    errors.push(`${prefix}.members：必填数组`);
  } else {
    const members = pod["members"] as Record<string, unknown>[];
    const memberIds = new Set<string>();
    for (let mi = 0; mi < members.length; mi++) {
      errors.push(...validateMember(members[mi]!, mi, `${prefix}`, memberIds, advisories));
    }

    // Pod 本地边
    if (pod["edges"] !== undefined) {
      if (!Array.isArray(pod["edges"])) {
        errors.push(`${prefix}.edges：必须是数组`);
      } else {
        for (let ei = 0; ei < (pod["edges"] as unknown[]).length; ei++) {
          const edge = (pod["edges"] as Record<string, unknown>[])[ei]!;
          errors.push(...validatePodLocalEdge(edge, ei, `${prefix}`, memberIds));
        }
      }
    }
  }

  return errors;
}

function validateMember(member: Record<string, unknown>, index: number, podPrefix: string, memberIds: Set<string>, advisories: string[]): string[] {
  const errors: string[] = [];
  const prefix = `${podPrefix}.members[${index}]`;
  errors.push(...rejectUnknownTopologyKeys(member, MEMBER_KEYS, prefix));

  // OPR.0.5.6.20 A5 — member 级 compaction_strategy：所有词汇决策都经过 manifest
  // 中唯一的规范位置；此处只对结果分类。
  if (member["compaction_strategy"] !== undefined) {
    const strategyValue = member["compaction_strategy"] as string;
    const canonical = typeof strategyValue === "string" ? canonicalCompactionStrategy(strategyValue) : null;
    if (strategyValue === "custom_prompt") {
      errors.push(`${prefix}.compaction_strategy：v1 不支持 "custom_prompt"；请使用 "harness_native" 或 "pod_continuity"`);
    } else if (canonical === null) {
      errors.push(`${prefix}.compaction_strategy：不是有效的压缩策略（收到 "${strategyValue}"）——请参阅 agent-spec 的 compaction_strategy 词汇表`);
    } else if (canonical !== strategyValue) {
      advisories.push(`${prefix}.compaction_strategy："${strategyValue}" 已弃用，现会规范化为 "${canonical}"——请更新为当前词汇`);
    }
  }
  if (
    member["mechanic"] !== undefined &&
    canonicalContinuityMechanic(member["mechanic"]) === null
  ) {
    errors.push(`${prefix}.mechanic：必须是规范的 seat@rig 会话地址`);
  }

  if (!member["id"] || typeof member["id"] !== "string") {
    errors.push(`${prefix}.id：必填的非空字符串`);
  } else {
    const id = member["id"] as string;
    if (id.includes(".")) errors.push(`${prefix}.id：不得包含点号（收到 "${id}"）`);
    if (memberIds.has(id)) errors.push(`${prefix}.id：member id "${id}" 重复`);
    memberIds.add(id);
  }

  if (!member["agent_ref"] || typeof member["agent_ref"] !== "string") {
    errors.push(`${prefix}.agent_ref：必填的非空字符串`);
  }
  if (!member["profile"] || typeof member["profile"] !== "string") {
    errors.push(`${prefix}.profile：必填的非空字符串`);
  }
  if (!member["runtime"] || typeof member["runtime"] !== "string") {
    errors.push(`${prefix}.runtime：必填的非空字符串`);
  }
  if (member["codex_config_profile"] !== undefined) {
    if (typeof member["codex_config_profile"] !== "string" || !member["codex_config_profile"].trim()) {
      errors.push(`${prefix}.codex_config_profile：必须是非空字符串`);
    } else if (!/^[A-Za-z0-9_.-]+$/.test(member["codex_config_profile"])) {
      errors.push(`${prefix}.codex_config_profile：只能包含字母、数字、下划线、点号或连字符`);
    } else if (member["runtime"] !== "codex") {
      errors.push(`${prefix}.codex_config_profile：仅当 runtime 为 "codex" 时有效`);
    }
  }
  if (!member["cwd"] || typeof member["cwd"] !== "string") {
    errors.push(`${prefix}.cwd：必填的非空字符串`);
  }

  // OPR.0.4.6.FAC1：可选的 seat 端 role 声明——工作流绑定层的候选维度
  //（role 绑定到 SEAT；没有 role 的 member 永远不会按角色解析，只能显式寻址）。
  // 每个 seat 自愿启用：任何位置都可合法缺失。已提供的 role 必须通过校验——
  // 绝不静默丢弃。terminal 运行时会拒绝：terminal 节点不是 agent seat
  //（与对 session_source/starter_ref 的 terminal 拒绝一致）。
  if (member["role"] !== undefined) {
    if (typeof member["role"] !== "string" || !member["role"].trim()) {
      errors.push(`${prefix}.role：必须是非空字符串`);
    } else if (!/^[A-Za-z0-9_.-]+$/.test(member["role"])) {
      errors.push(`${prefix}.role：只能包含字母、数字、下划线、点号或连字符`);
    } else if (member["runtime"] === "terminal") {
      errors.push(`${prefix}.role：对 terminal member 无效（terminal 节点不是 agent seat，无法按角色解析）`);
    }
  }

  // OPR.0.4.8.3 接缝 B：可选的逐 seat permission_policy 引用（builtin:<name> 或相对于规范的
  // 自定义路径；按 README v4 A1/A2/A3 校验——不能使用 role 字符集，因为引用包含 ':' 和 '/'）。
  // 每个 seat 自愿启用；缺失 = 下限。terminal 运行时会拒绝（terminal 节点不是 agent seat——
  // 与 role 拒绝一致）。member 级引用会覆盖 rig 级引用。
  if (member["permission_policy"] !== undefined) {
    const refErr = validatePermissionPolicyRef(member["permission_policy"], `${prefix}.permission_policy`);
    if (refErr) {
      errors.push(refErr);
    } else if (member["runtime"] === "terminal") {
      errors.push(`${prefix}.permission_policy：对 terminal member 无效（terminal 节点不是 agent seat）`);
    }
  }

  // Terminal 哨兵校验：要求精确三元组
  const isTerminalRuntime = member["runtime"] === "terminal";
  const isTerminalRef = member["agent_ref"] === "builtin:terminal";
  const isNoneProfile = member["profile"] === "none";

  if (isTerminalRuntime) {
    if (!isTerminalRef) {
      errors.push(`${prefix}：terminal 运行时要求 agent_ref 为 "builtin:terminal"（收到 "${member["agent_ref"]}"）`);
    }
    if (!isNoneProfile) {
      errors.push(`${prefix}：terminal 运行时要求 profile 为 "none"（收到 "${member["profile"]}"）`);
    }
  } else {
    if (isTerminalRef) {
      errors.push(`${prefix}：agent_ref "builtin:terminal" 仅在 runtime 为 "terminal" 时有效（收到 runtime "${member["runtime"]}"）`);
    }
    if (isNoneProfile && typeof member["profile"] === "string") {
      errors.push(`${prefix}：profile "none" 仅在 runtime 为 "terminal" 时有效（收到 runtime "${member["runtime"]}"）`);
    }
  }

  // restore_policy：封闭集合
  if (member["restore_policy"] !== undefined && member["restore_policy"] !== null) {
    if (!VALID_RESTORE_POLICIES.has(member["restore_policy"] as string)) {
      errors.push(`${prefix}.restore_policy：必须是 ${[...VALID_RESTORE_POLICIES].join(", ")} 之一（收到 "${member["restore_policy"]}"）`);
    }
  }

  // agent_ref：必须是格式正确的 local: 或 path:（terminal 哨兵除外）
  if (typeof member["agent_ref"] === "string" && !isTerminalRef) {
    const ref = member["agent_ref"] as string;
    const hasValidPrefix = VALID_IMPORT_PREFIXES.some((p) => ref.startsWith(p));
    if (!hasValidPrefix) {
      errors.push(`${prefix}.agent_ref：必须以 "local:" 或 "path:" 开头（收到 "${ref}"）`);
    } else if (ref.startsWith("local:")) {
      const path = ref.slice("local:".length);
      if (!path) errors.push(`${prefix}.agent_ref：local: 引用必须包含路径`);
      else if (path.startsWith("/")) errors.push(`${prefix}.agent_ref：local: 引用必须是相对路径（收到 "${ref}"）`);
    } else if (ref.startsWith("path:")) {
      const path = ref.slice("path:".length);
      if (!path) errors.push(`${prefix}.agent_ref：path: 引用必须包含路径`);
      else if (!path.startsWith("/")) errors.push(`${prefix}.agent_ref：path: 引用必须是绝对路径（收到 "${ref}"）`);
    }
  }

  // Member startup 块校验
  if (member["startup"] !== undefined) {
    errors.push(...validateStartupBlock(member["startup"], `${prefix}.startup`));
  }

  // session_source 校验（v1 精简 MVP：mode=fork + ref.kind=native_id）
  if (member["session_source"] !== undefined) {
    errors.push(...validateSessionSource(member["session_source"], `${prefix}.session_source`, isTerminalRuntime));
  }

  // starter_ref 校验（Agent Starter v1 垂直切片 M1）。
  // - 拒绝格式错误的名称。
  // - 拒绝 terminal 运行时（类似于拒绝 terminal session_source；terminal 的
  //   `deliverStartup` 是空操作，因此 starter 没有可注入的目标）。
  // - 拒绝 starter_ref + session_source.mode=fork 组合；v1+ 的
  //   "Real native-fork-from-registered-thread-id starter proof" 触发器涵盖该场景。
  // - 接受 starter_ref + session_source.mode=rebuild（加法组合：两者都在 fresh_start
  //   时应用；rebuild 工件与 starter 工件在启动流水线中独立组合）。
  // - 接受单独的 starter_ref。
  if (member["starter_ref"] !== undefined) {
    errors.push(...validateStarterRef(
      member["starter_ref"],
      member["session_source"],
      isTerminalRuntime,
      `${prefix}.starter_ref`,
    ));
  }

  return errors;
}

function validateStarterRef(
  raw: unknown,
  sessionSourceRaw: unknown,
  isTerminalRuntime: boolean,
  prefix: string,
): string[] {
  const errors: string[] = [];
  if (raw === null || typeof raw !== "object") {
    errors.push(`${prefix}：必须是带有非空 "name" 字符串的对象`);
    return errors;
  }
  if (isTerminalRuntime) {
    errors.push(`${prefix}：terminal 运行时没有可注入的 agent 上下文；starter_ref 对 terminal member 没有意义，因此被拒绝（与现有的 terminal session_source 拒绝一致）`);
    return errors;
  }
  const sr = raw as Record<string, unknown>;
  const name = sr["name"];
  if (typeof name !== "string" || name.trim() === "") {
    errors.push(`${prefix}.name：必填的非空字符串`);
    return errors;
  }
  // 允许的字符集：注册表键使用小写字母数字、连字符、下划线及作为分隔符的双连字符。
  // 拒绝任何会产生不安全文件系统路径的内容（不得含 `/`、`..` 或前导点号）。
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
    errors.push(`${prefix}.name：必须由字母数字以及可选的 "_" 或 "-" 组成（收到 ${JSON.stringify(name)}）`);
    return errors;
  }
  // 跨字段拒绝：starter_ref + session_source.mode=fork 是 v1+ 的命名触发器
  //（“从已登记线程 ID 进行真实原生分叉的 starter 证明”）。v0 规范
  // 会拒绝该组合，而不是静默混合两种语义。允许 rebuild 组合，并按加法方式落地。
  if (sessionSourceRaw !== null && typeof sessionSourceRaw === "object") {
    const ssRec = sessionSourceRaw as Record<string, unknown>;
    if (ssRec["mode"] === "fork") {
      errors.push(`${prefix}：v0 拒绝 starter_ref + session_source.mode="fork" 组合（v1+ 的 "Real native-fork-from-registered-thread-id starter proof" 触发器涵盖该组合）；请单独使用 starter_ref，或使用 session_source.mode="rebuild" 进行工件加法组合`);
    }
  }
  return errors;
}

function validateSessionSource(raw: unknown, prefix: string, isTerminalRuntime: boolean): string[] {
  const errors: string[] = [];
  if (raw === null || typeof raw !== "object") {
    errors.push(`${prefix}：必须是对象`);
    return errors;
  }
  if (isTerminalRuntime) {
    errors.push(`${prefix}：terminal 运行时没有原生 fork 原语，也没有可重建的 agent 上下文；请移除 terminal member 的 session_source`);
    return errors;
  }
  const ss = raw as Record<string, unknown>;
  const mode = ss["mode"];
  if (mode === "fork") {
    return validateForkSessionSource(ss, prefix);
  }
  if (mode === "rebuild") {
    return validateRebuildSessionSource(ss, prefix);
  }
  // PL-016 第 4 项：agent_image 会话源——引用 AgentImageLibraryService 中的命名镜像。
  // 实例化器携带该镜像的恢复令牌，通过 fork 代码路径分派。
  if (mode === "agent_image") {
    return validateAgentImageSessionSource(ss, prefix);
  }
  errors.push(`${prefix}.mode：支持 "fork"、"rebuild" 或 "agent_image"（收到 ${JSON.stringify(mode)}）`);
  return errors;
}

/** PL-016 第 4 项——校验 session_source: mode: agent_image。 */
function validateAgentImageSessionSource(ss: Record<string, unknown>, prefix: string): string[] {
  const errors: string[] = [];
  const ref = ss["ref"];
  if (ref === null || typeof ref !== "object") {
    errors.push(`${prefix}.ref：agent_image 模式要求对象包含 "kind: image_name" 和 "value: <name>"`);
    return errors;
  }
  const refRec = ref as Record<string, unknown>;
  const kind = refRec["kind"];
  if (kind !== "image_name") {
    errors.push(`${prefix}.ref.kind：v0 的 agent_image 模式仅支持 "image_name"（收到 ${JSON.stringify(kind)}）`);
    return errors;
  }
  const value = refRec["value"];
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${prefix}.ref.value：ref.kind 为 "image_name" 时，必须提供非空字符串`);
  }
  // 可选 version：字符串或数字会在解析时转换为字符串。
  const version = refRec["version"];
  if (version !== undefined && typeof version !== "string" && typeof version !== "number") {
    errors.push(`${prefix}.ref.version：可选；提供时必须是字符串或数字`);
  }
  return errors;
}

function validateForkSessionSource(ss: Record<string, unknown>, prefix: string): string[] {
  const errors: string[] = [];
  const ref = ss["ref"];
  if (ref === null || typeof ref !== "object") {
    errors.push(`${prefix}.ref：必填对象，需包含 "kind"，且 kind=native_id 时还需包含 "value"`);
    return errors;
  }
  const refRec = ref as Record<string, unknown>;
  const kind = refRec["kind"];
  if (kind !== "native_id") {
    if (kind === "artifact_path") {
      errors.push(`${prefix}.ref.kind："artifact_path" 延后到后续切片；v1 fork 模式仅支持 "native_id"`);
    } else if (kind === "name" || kind === "last") {
      errors.push(`${prefix}.ref.kind："${kind}" 弱于 "native_id"；v1 fork 模式仅支持 "native_id"`);
    } else if (kind === "artifact_set") {
      errors.push(`${prefix}.ref.kind："artifact_set" 属于 "rebuild" 模式；fork 模式请使用 ref.kind: "native_id"`);
    } else {
      errors.push(`${prefix}.ref.kind：必填；v1 fork 模式仅支持 "native_id"（收到 ${JSON.stringify(kind)}）`);
    }
    return errors;
  }
  const value = refRec["value"];
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${prefix}.ref.value：ref.kind 为 "native_id" 时，必须提供非空字符串`);
  }
  return errors;
}

function validateRebuildSessionSource(ss: Record<string, unknown>, prefix: string): string[] {
  const errors: string[] = [];
  const ref = ss["ref"];
  if (ref === null || typeof ref !== "object") {
    errors.push(`${prefix}.ref：rebuild 模式要求对象包含 "kind: artifact_set" 和 "value: [paths...]"`);
    return errors;
  }
  const refRec = ref as Record<string, unknown>;
  const kind = refRec["kind"];
  if (kind !== "artifact_set") {
    if (kind === "native_id" || kind === "artifact_path" || kind === "name" || kind === "last") {
      errors.push(`${prefix}.ref.kind：rebuild 模式要求 ref.kind: "artifact_set"；指定的 kind（${JSON.stringify(kind)}）属于 "fork" 模式`);
    } else {
      errors.push(`${prefix}.ref.kind：必填；v1 rebuild 模式仅支持 "artifact_set"（收到 ${JSON.stringify(kind)}）`);
    }
    return errors;
  }
  const value = refRec["value"];
  if (!Array.isArray(value)) {
    errors.push(`${prefix}.ref.value：必须按信任优先级提供非空工件路径数组（最高信任在前：rig CULTURE、role 文档、handover 数据包、队列文件、pod 共享会话日志、member 会话日志）`);
    return errors;
  }
  if (value.length === 0) {
    errors.push(`${prefix}.ref.value：rebuild 至少需要一个工件路径；请按信任优先级声明路径（最高信任在前）`);
    return errors;
  }
  for (let i = 0; i < value.length; i++) {
    const p = value[i];
    if (typeof p !== "string" || p.trim() === "") {
      errors.push(`${prefix}.ref.value[${i}]：每一项都必须是非空字符串（文件路径）`);
    }
  }
  return errors;
}

function validatePodLocalEdge(edge: Record<string, unknown>, index: number, podPrefix: string, memberIds: Set<string>): string[] {
  const errors: string[] = [];
  const prefix = `${podPrefix}.edges[${index}]`;
  errors.push(...rejectUnknownTopologyKeys(edge, EDGE_KEYS, prefix));
  const from = edge["from"] as string;
  const to = edge["to"] as string;
  const kind = edge["kind"] as string;

  if (!kind || !VALID_EDGE_KINDS.has(kind)) {
    errors.push(`${prefix}.kind：必须是 ${[...VALID_EDGE_KINDS].join(", ")} 之一（收到 "${kind}"）`);
  }
  if (!from || typeof from !== "string") {
    errors.push(`${prefix}.from：必填字符串`);
  } else if (from.includes(".")) {
    errors.push(`${prefix}.from：pod 本地边必须使用非限定 member id，而不是完全限定 id（收到 "${from}"）`);
  } else if (!memberIds.has(from)) {
    errors.push(`${prefix}.from：pod 中未找到 member "${from}"`);
  }
  if (!to || typeof to !== "string") {
    errors.push(`${prefix}.to：必填字符串`);
  } else if (to.includes(".")) {
    errors.push(`${prefix}.to：pod 本地边必须使用非限定 member id，而不是完全限定 id（收到 "${to}"）`);
  } else if (!memberIds.has(to)) {
    errors.push(`${prefix}.to：pod 中未找到 member "${to}"`);
  }

  return errors;
}

function validateCrossPodEdge(edge: Record<string, unknown>, index: number, allQualifiedIds: Set<string>): string[] {
  const errors: string[] = [];
  const prefix = `edges[${index}]`;
  errors.push(...rejectUnknownTopologyKeys(edge, EDGE_KEYS, prefix));
  const from = edge["from"] as string;
  const to = edge["to"] as string;
  const kind = edge["kind"] as string;

  if (!kind || !VALID_EDGE_KINDS.has(kind)) {
    errors.push(`${prefix}.kind：必须是 ${[...VALID_EDGE_KINDS].join(", ")} 之一（收到 "${kind}"）`);
  }
  if (!from || typeof from !== "string") {
    errors.push(`${prefix}.from：必填字符串`);
  } else if (!from.includes(".")) {
    errors.push(`${prefix}.from：跨 pod 边必须使用完全限定的 pod.member id（收到 "${from}"）`);
  } else if (!allQualifiedIds.has(from)) {
    errors.push(`${prefix}.from："${from}" 无法解析到 pod member`);
  }
  if (!to || typeof to !== "string") {
    errors.push(`${prefix}.to：必填字符串`);
  } else if (!to.includes(".")) {
    errors.push(`${prefix}.to：跨 pod 边必须使用完全限定的 pod.member id（收到 "${to}"）`);
  } else if (!allQualifiedIds.has(to)) {
    errors.push(`${prefix}.to："${to}" 无法解析到 pod member`);
  }

  // 同 pod 检查：跨 pod 边必须引用不同的 pod
  if (from && to && from.includes(".") && to.includes(".")) {
    const fromPod = from.split(".")[0];
    const toPod = to.split(".")[0];
    if (fromPod === toPod) {
      errors.push(`${prefix}：跨 pod 边必须引用不同的 pod（两端都引用 "${fromPod}"）；请改用 pod 本地边`);
    }
  }

  return errors;
}

function validateServicesBlock(raw: unknown, prefix: string): string[] {
  if (!raw || typeof raw !== "object") return [`${prefix}：必须是对象`];

  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (!obj["kind"] || typeof obj["kind"] !== "string" || !VALID_SERVICES_KIND.has(obj["kind"] as string)) {
    errors.push(`${prefix}.kind：必须是 ${[...VALID_SERVICES_KIND].join(", ")} 之一（收到 "${obj["kind"]}"）`);
  }

  if (!obj["compose_file"] || typeof obj["compose_file"] !== "string") {
    errors.push(`${prefix}.compose_file：必填的非空字符串`);
  } else {
    const pathErr = validateSafePath(obj["compose_file"] as string, `${prefix}.compose_file`);
    if (pathErr) errors.push(pathErr);
  }

  if (obj["project_name"] !== undefined) {
    if (typeof obj["project_name"] !== "string") {
      errors.push(`${prefix}.project_name：必须是字符串`);
    } else if (!COMPOSE_PROJECT_NAME_PATTERN.test(obj["project_name"] as string)) {
      errors.push(`${prefix}.project_name：必须匹配 ${COMPOSE_PROJECT_NAME_PATTERN.source}（收到 "${obj["project_name"]}"）`);
    }
  }

  if (obj["profiles"] !== undefined) {
    if (!Array.isArray(obj["profiles"])) {
      errors.push(`${prefix}.profiles：必须是数组`);
    } else {
      obj["profiles"].forEach((p, index) => {
        if (typeof p !== "string" || !p) errors.push(`${prefix}.profiles[${index}]：必须是非空字符串`);
      });
    }
  }

  if (obj["down_policy"] !== undefined && !VALID_DOWN_POLICIES.has(obj["down_policy"] as string)) {
    errors.push(`${prefix}.down_policy：必须是 ${[...VALID_DOWN_POLICIES].join(", ")} 之一（收到 "${obj["down_policy"]}"）`);
  }

  if (obj["wait_for"] !== undefined) {
    if (!Array.isArray(obj["wait_for"])) {
      errors.push(`${prefix}.wait_for：必须是数组`);
    } else {
      for (let i = 0; i < (obj["wait_for"] as unknown[]).length; i++) {
        errors.push(...validateWaitTarget((obj["wait_for"] as Record<string, unknown>[])[i]!, i, prefix));
      }
    }
  }

  if (obj["surfaces"] !== undefined) {
    errors.push(...validateSurfaces(obj["surfaces"], prefix));
  }

  if (obj["checkpoints"] !== undefined) {
    errors.push(...validateCheckpointHooks(obj["checkpoints"], prefix));
  }

  return errors;
}

function validateWaitTarget(raw: Record<string, unknown>, index: number, prefix: string): string[] {
  const errors: string[] = [];
  const targetPrefix = `${prefix}.wait_for[${index}]`;
  const hasService = typeof raw["service"] === "string" && raw["service"];
  const hasUrl = typeof raw["url"] === "string" && raw["url"];
  const hasTcp = typeof raw["tcp"] === "string" && raw["tcp"];
  const targetCount = [hasService, hasUrl, hasTcp].filter(Boolean).length;

  if (targetCount === 0) {
    errors.push(`${targetPrefix}：必须且只能定义 service、url 或 tcp 中的一项`);
  } else if (targetCount > 1) {
    errors.push(`${targetPrefix}：必须且只能定义 service、url 或 tcp 中的一项`);
  }

  if (hasService) {
    if (!raw["condition"] || raw["condition"] !== "healthy") {
      errors.push(`${targetPrefix}.condition：service 目标必须使用条件 "healthy"`);
    }
  }

  if (raw["condition"] !== undefined && !VALID_WAIT_TARGET_CONDITIONS.has(raw["condition"] as string)) {
    errors.push(`${targetPrefix}.condition：必须是 ${[...VALID_WAIT_TARGET_CONDITIONS].join(", ")} 之一（收到 "${raw["condition"]}"）`);
  } else if (!hasService && raw["condition"] !== undefined) {
    errors.push(`${targetPrefix}.condition：只有 service 目标可以指定 condition`);
  }

  return errors;
}

function validateSurfaces(raw: unknown, prefix: string): string[] {
  if (!raw || typeof raw !== "object") return [`${prefix}.surfaces：必须是对象`];
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (obj["urls"] !== undefined) {
    if (!Array.isArray(obj["urls"])) {
      errors.push(`${prefix}.surfaces.urls：必须是数组`);
    } else {
      for (let i = 0; i < (obj["urls"] as unknown[]).length; i++) {
        const url = (obj["urls"] as Record<string, unknown>[])[i]!;
        if (!url["name"] || typeof url["name"] !== "string") {
          errors.push(`${prefix}.surfaces.urls[${i}].name：必填的非空字符串`);
        }
        if (!url["url"] || typeof url["url"] !== "string") {
          errors.push(`${prefix}.surfaces.urls[${i}].url：必填的非空字符串`);
        }
      }
    }
  }

  if (obj["commands"] !== undefined) {
    if (!Array.isArray(obj["commands"])) {
      errors.push(`${prefix}.surfaces.commands：必须是数组`);
    } else {
      for (let i = 0; i < (obj["commands"] as unknown[]).length; i++) {
        const command = (obj["commands"] as Record<string, unknown>[])[i]!;
        if (!command["name"] || typeof command["name"] !== "string") {
          errors.push(`${prefix}.surfaces.commands[${i}].name：必填的非空字符串`);
        }
        if (!command["command"] || typeof command["command"] !== "string") {
          errors.push(`${prefix}.surfaces.commands[${i}].command：必填的非空字符串`);
        }
      }
    }
  }

  return errors;
}

function validateCheckpointHooks(raw: unknown, prefix: string): string[] {
  if (!raw || typeof raw !== "object") return [`${prefix}.checkpoints：必须是数组`];
  if (!Array.isArray(raw)) return [`${prefix}.checkpoints：必须是数组`];

  const errors: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const hook = raw[i] as Record<string, unknown>;
    if (!hook["id"] || typeof hook["id"] !== "string") {
      errors.push(`${prefix}.checkpoints[${i}].id：必填的非空字符串`);
    }
    if (!hook["export"] || typeof hook["export"] !== "string") {
      errors.push(`${prefix}.checkpoints[${i}].export：必填的非空字符串`);
    }
    if (hook["import"] !== undefined && typeof hook["import"] !== "string") {
      errors.push(`${prefix}.checkpoints[${i}].import：必须是字符串`);
    }
  }

  return errors;
}

function normalizeServicesBlock(raw: unknown, rigName: string): RigServicesSpec | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  const waitFor = Array.isArray(obj["wait_for"])
    ? (obj["wait_for"] as Record<string, unknown>[]).map((target) => normalizeWaitTarget(target))
    : undefined;
  const surfaces = obj["surfaces"] ? normalizeSurfaces(obj["surfaces"]) : undefined;
  const checkpoints = Array.isArray(obj["checkpoints"])
    ? (obj["checkpoints"] as Record<string, unknown>[]).map((hook) => normalizeCheckpointHook(hook))
    : undefined;

  return {
    kind: obj["kind"] as "compose",
    composeFile: obj["compose_file"] as string,
    projectName: obj["project_name"] as string | undefined ?? deriveComposeProjectName(rigName),
    profiles: Array.isArray(obj["profiles"]) ? (obj["profiles"] as string[]) : undefined,
    downPolicy: obj["down_policy"] as RigServicesSpec["downPolicy"] | undefined,
    waitFor,
    surfaces,
    checkpoints,
  };
}

function normalizeWaitTarget(raw: Record<string, unknown>): RigServicesWaitTarget {
  return {
    service: raw["service"] as string | undefined,
    condition: raw["condition"] as RigServicesWaitTarget["condition"] | undefined,
    url: raw["url"] as string | undefined,
    tcp: raw["tcp"] as string | undefined,
  };
}

function normalizeSurfaces(raw: unknown): RigServicesSurface | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  return {
    urls: Array.isArray(obj["urls"])
      ? (obj["urls"] as Record<string, unknown>[]).map((u) => ({ name: u["name"] as string, url: u["url"] as string }))
      : undefined,
    commands: Array.isArray(obj["commands"])
      ? (obj["commands"] as Record<string, unknown>[]).map((c) => ({ name: c["name"] as string, command: c["command"] as string }))
      : undefined,
  };
}

function normalizeCheckpointHook(raw: Record<string, unknown>): RigServicesCheckpointHook {
  return {
    id: raw["id"] as string,
    exportCommand: raw["export"] as string,
    importCommand: raw["import"] as string | undefined,
  };
}

function validateContinuityPolicy(raw: unknown, prefix: string): string[] {
  if (typeof raw !== "object" || raw === null) return [`${prefix}：必须是对象`];
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof obj["enabled"] !== "boolean") {
    errors.push(`${prefix}.enabled：必填布尔值`);
  }
  if (obj["sync_triggers"] !== undefined) {
    if (!Array.isArray(obj["sync_triggers"])) {
      errors.push(`${prefix}.sync_triggers：必须是数组`);
    } else {
      for (const t of obj["sync_triggers"] as string[]) {
        if (!VALID_SYNC_TRIGGERS.has(t)) {
          errors.push(`${prefix}.sync_triggers：无效触发器 "${t}"；必须是 ${[...VALID_SYNC_TRIGGERS].join(", ")} 之一`);
        }
      }
    }
  }

  if (obj["artifacts"] !== undefined) {
    if (typeof obj["artifacts"] !== "object" || obj["artifacts"] === null || Array.isArray(obj["artifacts"])) {
      errors.push(`${prefix}.artifacts：必须是对象`);
    } else {
      const art = obj["artifacts"] as Record<string, unknown>;
      for (const key of ["session_log", "restore_brief", "quiz"]) {
        if (art[key] !== undefined && typeof art[key] !== "boolean") {
          errors.push(`${prefix}.artifacts.${key}：必须是布尔值`);
        }
      }
    }
  }

  if (obj["restore_protocol"] !== undefined) {
    if (typeof obj["restore_protocol"] !== "object" || obj["restore_protocol"] === null || Array.isArray(obj["restore_protocol"])) {
      errors.push(`${prefix}.restore_protocol：必须是对象`);
    } else {
      const rp = obj["restore_protocol"] as Record<string, unknown>;
      for (const key of ["peer_driven", "verify_via_quiz"]) {
        if (rp[key] !== undefined && typeof rp[key] !== "boolean") {
          errors.push(`${prefix}.restore_protocol.${key}：必须是布尔值`);
        }
      }
    }
  }

  return errors;
}

// -- 规范化辅助函数 --

function normalizeStarterRef(raw: unknown): import("./types.js").StarterRefSpec | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const sr = raw as Record<string, unknown>;
  const name = sr["name"];
  if (typeof name !== "string" || name.trim() === "") return undefined;
  return { name };
}

function normalizeSessionSource(raw: unknown): import("./types.js").SessionSourceSpec | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const ss = raw as Record<string, unknown>;
  const mode = ss["mode"];
  const ref = ss["ref"];
  if (ref === null || typeof ref !== "object") return undefined;
  const refRec = ref as Record<string, unknown>;
  if (mode === "fork") {
    const kind = refRec["kind"];
    if (kind !== "native_id" && kind !== "artifact_path" && kind !== "name" && kind !== "last") return undefined;
    const value = typeof refRec["value"] === "string" ? (refRec["value"] as string) : undefined;
    return { mode: "fork", ref: { kind, ...(value !== undefined ? { value } : {}) } };
  }
  if (mode === "rebuild") {
    const kind = refRec["kind"];
    if (kind !== "artifact_set") return undefined;
    const value = refRec["value"];
    if (!Array.isArray(value)) return undefined;
    const paths: string[] = [];
    for (const p of value) {
      if (typeof p === "string" && p.trim() !== "") paths.push(p);
    }
    if (paths.length === 0) return undefined;
    return { mode: "rebuild", ref: { kind: "artifact_set", value: paths } };
  }
  // PL-016 第 4 项：agent_image 会话源。
  if (mode === "agent_image") {
    const kind = refRec["kind"];
    if (kind !== "image_name") return undefined;
    const value = refRec["value"];
    if (typeof value !== "string" || value.trim() === "") return undefined;
    const versionRaw = refRec["version"];
    const version = versionRaw === undefined ? undefined : String(versionRaw);
    return {
      mode: "agent_image",
      ref: { kind: "image_name", value, ...(version !== undefined ? { version } : {}) },
    };
  }
  return undefined;
}

function normalizePod(raw: Record<string, unknown>): RigSpecPod {
  const members = (raw["members"] as Record<string, unknown>[]).map((m) => ({
    id: m["id"] as string,
    label: m["label"] as string | undefined,
    agentRef: m["agent_ref"] as string,
    profile: m["profile"] as string,
    runtime: m["runtime"] as string,
    codexConfigProfile: m["codex_config_profile"] as string | undefined,
    model: m["model"] as string | undefined,
    role: m["role"] as string | undefined,
    permissionPolicy: m["permission_policy"] as string | undefined,
    cwd: m["cwd"] as string,
    restorePolicy: m["restore_policy"] as string | undefined,
    // OPR.0.5.6.20 A5 — 别名在摄取时规范化；缺失值保持 undefined，
    // 使解析器的 F-6 默认值仍是处理缺失的唯一权威。
    compactionStrategy: m["compaction_strategy"] !== undefined
      ? (canonicalCompactionStrategy(m["compaction_strategy"] as string) ?? undefined)
      : undefined,
    mechanic: m["mechanic"] !== undefined
      ? (canonicalContinuityMechanic(m["mechanic"]) ?? undefined)
      : undefined,
    startup: m["startup"] ? normalizeStartupBlock(m["startup"]) : undefined,
    sessionSource: normalizeSessionSource(m["session_source"]),
    starterRef: normalizeStarterRef(m["starter_ref"]),
  }));

  const edges = Array.isArray(raw["edges"])
    ? (raw["edges"] as Record<string, unknown>[]).map((e) => ({
        kind: e["kind"] as string,
        from: e["from"] as string,
        to: e["to"] as string,
      }))
    : [];

  const cp = raw["continuity_policy"] as Record<string, unknown> | undefined;

  return {
    id: raw["id"] as string,
    label: raw["label"] as string,
    summary: raw["summary"] as string | undefined,
    continuityPolicy: cp ? {
      enabled: cp["enabled"] as boolean,
      syncTriggers: cp["sync_triggers"] as string[] | undefined,
      artifacts: cp["artifacts"] && typeof cp["artifacts"] === "object" ? {
        sessionLog: (cp["artifacts"] as Record<string, unknown>)["session_log"] as boolean | undefined,
        restoreBrief: (cp["artifacts"] as Record<string, unknown>)["restore_brief"] as boolean | undefined,
        quiz: (cp["artifacts"] as Record<string, unknown>)["quiz"] as boolean | undefined,
      } : undefined,
      restoreProtocol: cp["restore_protocol"] && typeof cp["restore_protocol"] === "object" ? {
        peerDriven: (cp["restore_protocol"] as Record<string, unknown>)["peer_driven"] as boolean | undefined,
        verifyViaQuiz: (cp["restore_protocol"] as Record<string, unknown>)["verify_via_quiz"] as boolean | undefined,
      } : undefined,
    } : undefined,
    startup: raw["startup"] ? normalizeStartupBlock(raw["startup"]) : undefined,
    members,
    edges,
  };
}

// -- 旧版扁平节点 RigSpec 校验（重启前）--
// TODO：AS-T08b/AS-T12 迁移所有消费者后移除

const LEGACY_KNOWN_RUNTIMES = new Set(["claude-code", "codex", "pi"]);
const LEGACY_KNOWN_RESTORE_POLICIES = new Set(["resume_if_possible", "relaunch_fresh", "checkpoint_only"]);
const LEGACY_KNOWN_EDGE_KINDS = new Set(["delegates_to", "spawned_by", "can_observe"]);

export class LegacyRigSpecSchema {
  static validate(raw: unknown): ValidationResult {
    const errors: string[] = [];
    // OPR.0.5.3.3（r2 HIGH-1）：旧版自动检测路径也必须呈现别名固定建议——
    // 开放失败，绝不影响 valid/errors（支持 pod 的路径已如此处理）。
    const advisories: string[] = [];

    if (!raw || typeof raw !== "object") {
      return { valid: false, errors: ["规范必须是对象"] };
    }

    const obj = raw as Record<string, unknown>;

    if (obj["schema_version"] != null && obj["schema_version"] !== 1) {
      errors.push(`schema_version 必须为 1，收到 ${obj["schema_version"]}`);
    }

    if (!obj["name"] || typeof obj["name"] !== "string") {
      errors.push("name 为必填项，且必须是字符串");
    }
    if (!obj["version"] || typeof obj["version"] !== "string") {
      errors.push("version 为必填项，且必须是字符串");
    }

    if (!obj["nodes"] || !Array.isArray(obj["nodes"])) {
      errors.push("nodes 为必填项，且必须是数组");
    }

    if (obj["edges"] !== undefined && !Array.isArray(obj["edges"])) {
      errors.push("edges 提供时必须是数组");
    }

    const nodeIds = new Set<string>();
    if (Array.isArray(obj["nodes"])) {
      for (const node of obj["nodes"] as Record<string, unknown>[]) {
        // OPR.0.5.3.3（r2 HIGH-1，第 2 轮）：别名建议独立于 id 有效性——即使固定到 fable
        // 的节点未通过下方 id 守卫，仍需收到迁移提示。应在提前 continue 之前收集该建议，
        // 并以 `?` 作为回退位置（与支持 pod 的路径一致）。
        const nodeWhere = typeof node["id"] === "string" && node["id"] ? (node["id"] as string) : "?";
        const pinAdvisory = aliasModelPinAdvisory(node["model"], `nodes.${nodeWhere}`);
        if (pinAdvisory) advisories.push(pinAdvisory);

        if (!node["id"] || typeof node["id"] !== "string") {
          errors.push("每个节点都必须有字符串 id");
          continue;
        }

        if (nodeIds.has(node["id"] as string)) {
          errors.push(`节点 id 重复：${node["id"]}`);
        }
        nodeIds.add(node["id"] as string);

        if (!node["runtime"] || typeof node["runtime"] !== "string") {
          errors.push(`节点 ${node["id"]}：runtime 为必填项`);
        } else if (!LEGACY_KNOWN_RUNTIMES.has(node["runtime"] as string)) {
          errors.push(`节点 ${node["id"]}：未知运行时 '${node["runtime"]}'`);
        }

        if (node["restore_policy"] != null && !LEGACY_KNOWN_RESTORE_POLICIES.has(node["restore_policy"] as string)) {
          errors.push(`节点 ${node["id"]}：未知 restorePolicy '${node["restore_policy"]}'`);
        }

        if (node["package_refs"] != null) {
          if (!Array.isArray(node["package_refs"])) {
            errors.push(`节点 ${node["id"]}：package_refs 必须是数组`);
          } else if (!(node["package_refs"] as unknown[]).every((r) => typeof r === "string")) {
            errors.push(`节点 ${node["id"]}：package_refs 只能包含字符串`);
          }
        }
      }
    }

    if (Array.isArray(obj["edges"])) {
      for (const edge of obj["edges"] as Record<string, unknown>[]) {
        const from = edge["from"] as string | undefined;
        const to = edge["to"] as string | undefined;
        const kind = edge["kind"] as string | undefined;

        if (!from || typeof from !== "string") { errors.push("每条边都必须有字符串 'from' 字段"); continue; }
        if (!to || typeof to !== "string") { errors.push("每条边都必须有字符串 'to' 字段"); continue; }
        if (!kind || typeof kind !== "string") { errors.push("每条边都必须有字符串 'kind' 字段"); continue; }

        if (from === to) errors.push(`不允许自环边：${from} -> ${to}`);
        if (from && !nodeIds.has(from)) errors.push(`边引用了不存在的节点：'${from}'`);
        if (to && !nodeIds.has(to)) errors.push(`边引用了不存在的节点：'${to}'`);
        if (kind && !LEGACY_KNOWN_EDGE_KINDS.has(kind)) errors.push(`未知边类型：'${kind}'`);
      }
    }

    return { valid: errors.length === 0, errors, ...(advisories.length ? { advisories } : {}) };
  }

  static normalize(raw: unknown): LegacyRigSpec {
    const result = this.validate(raw);
    if (!result.valid) {
      throw new Error(`RigSpec 校验失败：${result.errors.join("; ")}`);
    }

    const obj = raw as Record<string, unknown>;
    const rawNodes = obj["nodes"] as Record<string, unknown>[];
    const rawEdges = (obj["edges"] as Record<string, unknown>[] | undefined) ?? [];

    const nodes: LegacyRigSpecNode[] = rawNodes.map((n) => ({
      id: n["id"] as string,
      runtime: n["runtime"] as string,
      role: (n["role"] as string) ?? undefined,
      model: (n["model"] as string) ?? undefined,
      cwd: (n["cwd"] as string) ?? undefined,
      surfaceHint: (n["surface_hint"] as string) ?? undefined,
      workspace: (n["workspace"] as string) ?? undefined,
      restorePolicy: (n["restore_policy"] as string) ?? "resume_if_possible",
      packageRefs: (n["package_refs"] as string[]) ?? [],
    }));

    const edges: LegacyRigSpecEdge[] = rawEdges.map((e) => ({
      from: e["from"] as string,
      to: e["to"] as string,
      kind: e["kind"] as string,
    }));

    return {
      schemaVersion: (obj["schema_version"] as number) ?? 1,
      name: obj["name"] as string,
      version: obj["version"] as string,
      nodes,
      edges,
    };
  }
}
