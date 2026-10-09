import { readMissionReadiness, type MissionReadiness } from "./proof/judgments.js";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml, stringify } from "yaml";
import type { WorkflowSpec, WorkflowStepSpec } from "./workflow-types.js";
import { WorkflowSpecError, parseWorkflowSpec } from "./workflow-spec-cache.js";
import { WorkflowValidator } from "./workflow-validator.js";
import {
  LifecycleManifestValidationError,
  validateMissionComposition,
  type LifecycleMissionMember,
} from "./lifecycle-manifest.js";

export interface LifecycleSourceDigest {
  kind: "project" | "mission" | "slice";
  path: string;
  sha256: string;
}

export interface LifecycleGraphSource {
  mode: "project-profile" | "mission-extend" | "mission-override" | "legacy-mission" | "legacy-slices";
  profileSource: string | null;
  missionSource: string | null;
  requiredSteps: string[];
}

export interface LifecycleCompilation {
  readiness: MissionReadiness;
  version: 1;
  eligible: boolean;
  identity: {
    project: string;
    mission: string;
    lifecycleProfile: string | null;
  };
  operationKeyInput: string | null;
  compiledInputDigest: string;
  sources: LifecycleSourceDigest[];
  dependencies: Array<{ stepId: string; dependsOn: string[] }>;
  graphSource: LifecycleGraphSource;
  workflowSpec: WorkflowSpec | null;
  advisories: string[];
  unknowns: string[];
}

type Mapping = Record<string, unknown>;

/**
 * 读取并编译 project/mission/slice manifest，不写文件、cache row、workflow instance 或
 * qitem。生成的 spec 是输出，绝不是第二份 authored source。
 */
export function compileProjectLifecycle(input: {
  missionPath: string;
  operationKey?: string;
}): LifecycleCompilation {
  const missionPath = resolveManifest(input.missionPath, "mission.yaml");
  const missionDir = dirname(missionPath);
  const workspaceRoot = dirname(dirname(missionDir));
  const projectPath = join(workspaceRoot, "project.yaml");
  const project = readManifest(projectPath, "project");
  const mission = readManifest(missionPath, "mission");
  const projectId = requiredString(asMapping(project.metadata, `${projectPath}: metadata`).id, `${projectPath}: metadata.id`);
  const missionName = requiredString(asMapping(mission.metadata, `${missionPath}: metadata`).name, `${missionPath}: metadata.name`);
  const lifecycle = asMapping(project.lifecycle, `${projectPath}: lifecycle`, true);
  if (lifecycle) knownKeys(lifecycle, ["profile", "profiles", "public_owner", "retention"], `${projectPath}: lifecycle`);
  const lifecycleProfile = optionalString(lifecycle?.profile, `${projectPath}: lifecycle.profile`);
  let members: LifecycleMissionMember[];
  try {
    members = validateMissionComposition(mission, missionPath);
  } catch (error) {
    if (error instanceof LifecycleManifestValidationError) throw manifestError(error.code, error.message, error.details);
    throw error;
  }

  const sources: LifecycleSourceDigest[] = [digestSource("project", projectPath), digestSource("mission", missionPath)];
  const steps: WorkflowStepSpec[] = [];
  const roles: WorkflowSpec["roles"] = {};
  const unknowns: string[] = [];
  const advisories: string[] = [];
  const boundary = asMapping(mission.lifecycle, `${missionPath}: lifecycle`, true);
  if (boundary) {
    knownKeys(boundary, ["profile", "mode", "workflow"], `${missionPath}: lifecycle`);
    if (requiredString(boundary.profile, `${missionPath}: lifecycle.profile`) !== lifecycleProfile) {
      throw manifestError("lifecycle_profile_mismatch", "任务目标的 lifecycle.profile 必须与 project.yaml 选择的 profile 一致");
    }
  }
  const projectRefs = stringList(asMapping(project.install, `${projectPath}: install`, true)?.context, `${projectPath}: install.context`, true);
  const commonRefs = [projectPath, missionPath, ...projectRefs.map((ref) => address(workspaceRoot, ref))];
  const parseBoundary = (workflow: Mapping, path: string, root: string): WorkflowSpec => parseWorkflowSpec(stringify({ workflow: {
    id: `lifecycle-${projectId}-${missionName}`, version: "1", ...workflow,
    steps: Array.isArray(workflow.steps) ? workflow.steps.map((step: Mapping) => {
      if (!step || !Array.isArray(step.allowed_exits) || !step.allowed_exits.includes("waiting")) return step;
      const initial = step.re_present_after_seconds ?? 300;
      return { ...step, re_present_after_seconds: initial,
        re_present_max_seconds: step.re_present_max_seconds ?? Math.max(3600, typeof initial === "number" ? initial : 300) };
    }) : workflow.steps,
    context_refs: [...new Set([...commonRefs, ...stringList(workflow.context_refs, `${path}.context_refs`, true).map((ref) => address(root, ref))])],
  } }), path);

  const graphSource: LifecycleGraphSource = {
    mode: "legacy-slices", profileSource: null, missionSource: null, requiredSteps: [],
  };
  let authoredBoundary: WorkflowSpec | null = null;
  if (lifecycle && Object.hasOwn(lifecycle, "profiles")) {
    const profiles = asMapping(lifecycle.profiles, `${projectPath}: lifecycle.profiles`);
    if (!lifecycleProfile || !Object.hasOwn(profiles, lifecycleProfile)) {
      throw manifestError("lifecycle_profile_not_found", "project.lifecycle.profile 必须选择现有的 lifecycle.profiles entry");
    }
    const source = `${projectPath}#lifecycle.profiles.${lifecycleProfile}`;
    const profile = asMapping(profiles[lifecycleProfile], source);
    knownKeys(profile, ["required_steps", "workflow"], source);
    const required = stringList(profile.required_steps, `${source}.required_steps`);
    if (required.length === 0) throw manifestError("lifecycle_required_steps_empty", `${source}：required_steps 必须点名 boundary obligation`);
    const base = parseBoundary(asMapping(profile.workflow, `${source}.workflow`), `${source}.workflow`, workspaceRoot);
    validateObligations(base, required);
    authoredBoundary = base;
    Object.assign(graphSource, { mode: "project-profile", profileSource: source, requiredSteps: required });
    if (boundary && (Object.hasOwn(boundary, "workflow") || Object.hasOwn(boundary, "mode"))) {
      if (boundary.mode !== "extend" && boundary.mode !== "override") {
        throw manifestError("lifecycle_override_ambiguous", "任务目标在项目 profile 上声明 lifecycle.workflow 时，必须指定 mode: extend 或 override");
      }
      const addition = asMapping(boundary.workflow, `${missionPath}: lifecycle.workflow`);
      const missionSource = `${missionPath}#lifecycle.workflow`;
      if (boundary.mode === "extend") {
        knownKeys(addition, ["steps", "roles", "context_refs"], missionSource);
        if (!Array.isArray(addition.steps)) throw manifestError("lifecycle_extension_invalid", "extension 必须声明 steps 列表");
        const ids = new Set(base.steps.map((step) => step.id));
        if (addition.steps.some((step) => ids.has(asMapping(step, missionSource).id as string))) {
          throw manifestError("lifecycle_extension_collision", "extension 不能替换继承的 step；请显式使用 mode: override");
        }
        authoredBoundary = parseBoundary({ ...base, ...addition,
          roles: { ...base.roles, ...asMapping(addition.roles, `${missionSource}.roles`, true) },
          steps: [...base.steps, ...addition.steps],
          context_refs: [...new Set([...(base.context_refs ?? []), ...stringList(addition.context_refs, `${missionSource}.context_refs`, true).map((ref) => address(missionDir, ref))])],
        }, missionSource, missionDir);
      } else {
        authoredBoundary = parseBoundary({ ...addition,
          context_refs: [...new Set([...(base.context_refs ?? []), ...stringList(addition.context_refs, `${missionSource}.context_refs`, true).map((ref) => address(missionDir, ref))])],
        }, missionSource, missionDir);
      }
      validateObligations(authoredBoundary, required, base);
      Object.assign(graphSource, { mode: `mission-${boundary.mode}`, missionSource });
    }
  } else if (boundary) {
    if (Object.hasOwn(boundary, "mode")) throw manifestError("lifecycle_override_without_profile", "任务目标 mode 需要项目拥有的 profile graph");
    authoredBoundary = parseBoundary(asMapping(boundary.workflow, `${missionPath}: lifecycle.workflow`), `${missionPath}#lifecycle.workflow`, missionDir);
    Object.assign(graphSource, { mode: "legacy-mission", missionSource: `${missionPath}#lifecycle.workflow` });
  }
  if (!graphSource.profileSource) advisories.push("Legacy lifecycle：未选择项目拥有的 profile graph；只应用用户编写的任务目标或 slice graph。");

  members.forEach((member) => {
    const { ref, normalizedRef, path: slicePath } = member;
    const slice = readManifest(slicePath, "slice");
    sources.push(digestSource("slice", slicePath));
    const sliceComposition = asMapping(slice.composition, `${slicePath}: composition`);
    const missionRef = requiredString(sliceComposition.mission, `${slicePath}: composition.mission`);
    if (isAbsolute(missionRef)) {
      throw manifestError("lifecycle_path_escape", `${slicePath}：composition.mission 必须使用相对路径`, { slicePath, missionRef });
    }
    const resolvedMissionRef = resolve(dirname(slicePath), missionRef);
    if (!existsSync(resolvedMissionRef) || realpathSync(resolvedMissionRef) !== realpathSync(missionPath)) {
      throw manifestError("lifecycle_slice_mission_mismatch", `${slicePath}：composition.mission 无法解析到 ${missionPath}`, { slicePath, missionRef, missionPath });
    }

    // 任务目标 boundary 已由用户显式编写；slice SDLC 绝不凭空生成其中的 step。
    if (authoredBoundary || !member.active) return;
    const execution = asMapping(slice.execution, `${slicePath}: execution`, true);
    if (!execution) {
      unknowns.push(`${normalizedRef}：缺少 execution contract`);
      return;
    }
    const stepId = optionalString(asMapping(slice.metadata, `${slicePath}: metadata`, true)?.id, `${slicePath}: metadata.id`) ?? basename(dirname(slicePath));
    const actorRole = requiredString(execution.actor_role, `${slicePath}: execution.actor_role`);
    const preferredTargets = stringList(execution.preferred_targets, `${slicePath}: execution.preferred_targets`, true);
    roles[actorRole] ??= preferredTargets.length > 0 ? { preferred_targets: preferredTargets } : {};
    const dependsOn = stringList(execution.depends_on, `${slicePath}: execution.depends_on`, true);
    const allowedExits = stringList(execution.allowed_exits, `${slicePath}: execution.allowed_exits`, true);
    const step: WorkflowStepSpec = {
      id: stepId,
      actor_role: actorRole,
      ...(optionalString(execution.objective, `${slicePath}: execution.objective`) ? { objective: String(execution.objective) } : {}),
      ...(allowedExits.length > 0 ? { allowed_exits: allowedExits as WorkflowStepSpec["allowed_exits"] } : {}),
      depends_on: dependsOn,
      ...(optionalString(execution.harness, `${slicePath}: execution.harness`) ? { harness: execution.harness as WorkflowStepSpec["harness"] } : {}),
      ...(optionalString(execution.host, `${slicePath}: execution.host`) ? { host: String(execution.host) } : {}),
      ...(execution.gate ? { gate: asMapping(execution.gate, `${slicePath}: execution.gate`) as unknown as WorkflowStepSpec["gate"] } : {}),
      ...(execution.acceptance ? { acceptance: asMapping(execution.acceptance, `${slicePath}: execution.acceptance`) as unknown as WorkflowStepSpec["acceptance"] } : {}),
    };
    steps.push(step);
  });

  if (!input.operationKey) unknowns.push("未提供 opaque lifecycle operation key");
  if (!lifecycleProfile) unknowns.push("缺少项目 lifecycle profile");
  if (authoredBoundary) steps.push(...authoredBoundary.steps);
  if (steps.length === 0) unknowns.push("没有 active slice 声明 execution contract；请为独立任务目标 boundary 编写 mission.lifecycle");
  if (steps.length > 0 && steps.every((step) => (step.depends_on ?? []).length > 0)) {
    unknowns.push("execution graph 没有 root step");
  }
  const draftWorkflowSpec: WorkflowSpec | null = authoredBoundary ?? (steps.length > 0
    ? {
        id: `lifecycle-${projectId}-${missionName}`,
        version: "1",
        objective: `${projectId}/${missionName} 的已编译 lifecycle`,
        entry: { role: steps.find((step) => (step.depends_on ?? []).length === 0)?.actor_role },
        roles,
        steps,
      }
    : null);
  const compiledInputDigest = sha256(stableJson({
    version: 1,
    identity: { project: projectId, mission: missionName, lifecycleProfile },
    sources: sources.map(({ kind, path, sha256 }) => ({ kind, path, sha256 })),
    workflowSpec: draftWorkflowSpec,
  }));
  const workflowSpec = draftWorkflowSpec
    ? { ...draftWorkflowSpec, version: `1-${compiledInputDigest.slice(0, 16)}` }
    : null;
  if (workflowSpec) {
    const validation = new WorkflowValidator().validate(workflowSpec);
    for (const issue of validation.issues) {
      const rendered = `已编译工作流 [${issue.code}]：${issue.message}`;
      if (issue.severity === "error") unknowns.push(rendered);
      else advisories.push(rendered);
    }
  }
  if (unknowns.length > 0) advisories.push("编译结果可供检查，但在解决每个已点名的 unknown 之前不能实例化。");
  return {
    readiness: readMissionReadiness(missionDir),
    version: 1,
    eligible: workflowSpec !== null && unknowns.length === 0,
    identity: { project: projectId, mission: missionName, lifecycleProfile },
    operationKeyInput: input.operationKey ?? null,
    compiledInputDigest,
    sources,
    graphSource,
    dependencies: steps.map((step) => ({ stepId: step.id, dependsOn: step.depends_on ?? [] })),
    workflowSpec,
    advisories,
    unknowns,
  };
}

function address(root: string, ref: string): string {
  return /^(?:[a-z]+:|\$|\/)/i.test(ref) ? ref : resolve(root, ref);
}

function knownKeys(mapping: Mapping, allowed: string[], source: string): void {
  for (const key of Object.keys(mapping)) {
    if (!allowed.includes(key)) throw manifestError("lifecycle_boundary_unknown_key", `${source}：未知 key ${key}`);
  }
}

/** 必需 ID 及其顺序属于 authored policy，不由后台服务解释 receipt。 */
function validateObligations(spec: WorkflowSpec, required: string[], base?: WorkflowSpec): void {
  const byId = new Map(spec.steps.map((step) => [step.id, step]));
  const missing = required.filter((id) => !byId.has(id));
  if (missing.length) throw manifestError("lifecycle_required_step_missing", `缺少必需的 boundary step：${missing.join(", ")}`, { missing });
  // dependency graph 不能通过条件跳转绕过必需 obligation。
  for (const step of spec.steps) {
    if (step.depends_on === undefined || step.next_hop?.on) {
      throw manifestError("lifecycle_boundary_graph_invalid", `Boundary step ${step.id} 必须使用 depends_on，不能带条件 next_hop.on edge`);
    }
  }
  const ancestors = (steps: WorkflowStepSpec[], id: string, seen = new Set<string>()): Set<string> => {
    for (const parent of steps.find((step) => step.id === id)?.depends_on ?? []) {
      if (!seen.has(parent)) { seen.add(parent); ancestors(steps, parent, seen); }
    }
    return seen;
  };
  if (base) for (const id of required) {
    const before = ancestors(base.steps, id);
    const after = ancestors(spec.steps, id);
    const lost = required.filter((parent) => before.has(parent) && !after.has(parent));
    if (lost.length) throw manifestError("lifecycle_required_order_changed", `必需 step ${id} 丢失 prerequisite：${lost.join(", ")}`, { stepId: id, missing: lost });
  }
}

function resolveManifest(input: string, file: string): string {
  const candidate = resolve(input);
  const path = existsSync(candidate) && lstatSync(candidate).isDirectory() ? join(candidate, file) : candidate;
  // 规范化 parent alias（例如 macOS /var -> /private/var），但不能抹掉对 manifest 本身为
  // symlink 的现有拒绝。
  return existsSync(path) && !lstatSync(path).isSymbolicLink() ? realpathSync(path) : path;
}

function readManifest(path: string, kind: string): Mapping {
  if (!existsSync(path)) throw manifestError("lifecycle_manifest_missing", `${path} 中未找到 ${kind} manifest`, { path, kind });
  if (lstatSync(path).isSymbolicLink()) throw manifestError("lifecycle_manifest_symlink", `${kind} manifest 不能是 symlink：${path}`, { path, kind });
  let parsed: unknown;
  try { parsed = parseYaml(readFileSync(path, "utf8")); }
  catch (error) { throw manifestError("lifecycle_manifest_invalid", `${path} 中的 ${kind} manifest 不是有效 YAML：${error instanceof Error ? error.message : String(error)}`, { path, kind }); }
  const mapping = asMapping(parsed, path);
  if (mapping.kind !== kind) throw manifestError("lifecycle_manifest_kind_mismatch", `${path}：预期 kind ${kind}，实际 ${JSON.stringify(mapping.kind)}`, { path, expected: kind, actual: mapping.kind });
  return mapping;
}

function asMapping(value: unknown, label: string, optional?: false): Mapping;
function asMapping(value: unknown, label: string, optional: true): Mapping | null;
function asMapping(value: unknown, label: string, optional = false): Mapping | null {
  if ((value === undefined || value === null) && optional) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw manifestError("lifecycle_manifest_shape_invalid", `${label} 必须是 mapping`, { label, value });
  return value as Mapping;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw manifestError("lifecycle_field_missing", `${label} 必须是非空字符串`, { label, value });
  return value;
}

function optionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value, label);
}

function stringList(value: unknown, label: string, optional = false): string[] {
  if ((value === undefined || value === null) && optional) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) throw manifestError("lifecycle_field_invalid", `${label} 必须是非空字符串列表`, { label, value });
  if (new Set(value).size !== value.length) throw manifestError("lifecycle_field_duplicate", `${label} 包含重复项`, { label, value });
  return value as string[];
}

function digestSource(kind: LifecycleSourceDigest["kind"], path: string): LifecycleSourceDigest {
  return { kind, path, sha256: sha256(readFileSync(path)) };
}

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Mapping).sort(([a], [b]) => a.localeCompare(b, "en-US")).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function manifestError(code: string, message: string, details?: Record<string, unknown>): WorkflowSpecError {
  return new WorkflowSpecError(code, message, details);
}
