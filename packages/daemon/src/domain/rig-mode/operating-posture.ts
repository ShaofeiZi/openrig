import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type Database from "better-sqlite3";
import { resolveWorkNodeDirs } from "../current-work.js";
import { parseFrontmatter } from "../slices/slice-indexer.js";
import type { HealthRecord } from "../health-projection.js";
import type { RigModeStore } from "./rig-mode-store.js";
import { missionModeQualifier, type OperatorContextReadContext, type OperatorContextScope } from "./rig-mode-types.js";
import { validateModeName, validateRecord } from "./rig-mode-validator.js";

export interface OperatingContext extends OperatorContextReadContext {
  phase: { value: string | null; source: string | null };
  sources: string[];
  paths?: { project: string; mission?: string; workstream?: string };
}
export interface OperatingPosture {
  posture: "human-led" | "delegated" | "unknown";
  source: "product-default" | "binding" | "unknown";
  context: OperatingContext | null;
  binding: { id: string; scope: OperatorContextScope; setAt: string; evidence: string } | null;
  reason: string;
  grantsAuthority: false;
  members?: Array<{ qitemId: string; posture: string; source: string; bindingId: string | null }>;
}

const segment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function requiredSegment(value: string, label: string): string {
  if (!segment.test(value)) throw new Error(label + " 必须是一个长度受限的身份片段");
  return value;
}
function yamlFile(path: string, optional = false): Record<string, any> | null {
  let bytes: Buffer;
  try { bytes = readFileSync(path); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (bytes.length > 65536) throw new Error("工作范围源超过 64 KiB：" + path);
  const data = parseYaml(bytes.toString());
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("工作范围源无效：" + path);
  return data;
}
function inside(root: string, path: string): string {
  const actual = realpathSync(path), rel = relative(realpathSync(root), actual);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("工作范围逃逸所属项目：" + path);
  return actual;
}
function unknown(reason: string, context: OperatingContext | null = null): OperatingPosture {
  return { posture: "unknown", source: "unknown", context, binding: null, reason, grantsAuthority: false };
}

/** 统一读取现有模式绑定、队列/工作流身份及作者定义的工作节点。
 * 偏好设置绝不创建权限、改写阶段或修改健康策略。 */
export class OperatingPostureService {
  constructor(private readonly db: Database.Database, private readonly modes: RigModeStore,
    private readonly workspaceRoot: () => string) {}

  context(input: OperatorContextReadContext): OperatingContext {
    const ctx: OperatingContext = { ...input, phase: { value: null, source: null }, sources: [] };
    const rigIdentity = (value: string) => {
      const rigs = this.db.prepare("SELECT id FROM rigs WHERE id = ? OR name = ?").all(value, value) as Array<{ id: string }>;
      if (rigs.length !== 1) throw new Error("工作组身份缺失或有歧义：" + value);
      return rigs[0]!.id;
    };
    for (const value of Object.values(input)) if (value !== undefined && !value.trim()) throw new Error("工作范围身份为空");
    if (ctx.rigId) ctx.rigId = rigIdentity(ctx.rigId);
    const merge = (key: keyof OperatorContextReadContext, value: unknown, source: string) => {
      if (value === undefined || value === null) return;
      if (typeof value !== "string" || !value.trim()) throw new Error("来自 " + source + " 的 " + key + " 无效");
      if (key === "rigId") value = rigIdentity(value);
      if (ctx[key] && ctx[key] !== value) throw new Error("来自 " + source + " 的 " + key + " 存在冲突");
      ctx[key] = value as string; ctx.sources.push(source);
    };
    if (ctx.workstreamId?.includes("/")) {
      const parts = ctx.workstreamId.split("/");
      if (parts.length !== 3) throw new Error("请使用 project/mission/slice-id 工作流身份");
      merge("projectId", parts[0], "workstream qualifier"); merge("missionId", parts[1], "workstream qualifier");
      ctx.workstreamId = parts[2];
    }
    if (ctx.qitemId) {
      const row = this.db.prepare("SELECT tags, destination_session FROM queue_items WHERE qitem_id = ?").get(ctx.qitemId) as { tags: string | null; destination_session: string } | undefined;
      if (!row) throw new Error("未找到 qitem：" + ctx.qitemId);
      const tags: unknown = JSON.parse(row.tags ?? "[]");
      if (!Array.isArray(tags) || tags.some(t => typeof t !== "string")) throw new Error("qitem 标签无效");
      for (const [prefix, key] of [["project:", "projectId"], ["mission:", "missionId"], ["slice:", "workstreamId"], ["workstream:", "workstreamId"]] as const) {
        for (const tag of tags.filter((t: string) => t.startsWith(prefix))) merge(key, tag.slice(prefix.length), "queue:" + ctx.qitemId + "/" + prefix);
      }
      const workflows = this.db.prepare("SELECT f.step_id, i.instance_id, i.bound_rig, i.lifecycle_binding_json FROM workflow_frontier_bindings f JOIN workflow_instances i ON i.instance_id = f.instance_id WHERE f.packet_id = ?")
        .all(ctx.qitemId) as Array<{ step_id: string; instance_id: string; bound_rig: string | null; lifecycle_binding_json: string | null }>;
      if (workflows.length > 1) throw new Error("工作流成员关系有歧义");
      const workflow = workflows[0];
      if (workflow) {
        const binding = JSON.parse(workflow.lifecycle_binding_json ?? "null");
        merge("projectId", binding?.identity?.project, "workflow:" + workflow.instance_id);
        merge("missionId", binding?.identity?.mission, "workflow:" + workflow.instance_id);
        merge("rigId", workflow.bound_rig, "workflow:" + workflow.instance_id);
        ctx.phase = { value: workflow.step_id, source: "workflow:" + workflow.instance_id + "/frontier/" + ctx.qitemId };
      }
      if (row.destination_session.includes("@")) merge("rigId", row.destination_session.slice(row.destination_session.lastIndexOf("@") + 1), "queue:" + ctx.qitemId + "/destination");
      if (!ctx.projectId && !ctx.missionId) throw new Error("qitem 缺少项目/任务目标关联");
    }
    if (ctx.rigId) {
      ctx.sources.push("rig:" + ctx.rigId);
    }
    if (ctx.projectId || ctx.missionId || ctx.workstreamId) {
      const workspace = realpathSync(this.workspaceRoot());
      const catalogPath = join(workspace, "workspace.yaml");
      const catalog = yamlFile(catalogPath, true);
      let projectRoot = workspace;
      if (catalog) {
        if (!Array.isArray(catalog.projects) || catalog.projects.some((p: any) => !p || typeof p.id !== "string" || typeof p.root !== "string")) throw new Error("工作区项目目录无效");
        const projects = catalog.projects as Array<{ id: string; root: string }>;
        if (new Set(projects.map(p => p.id)).size !== projects.length) throw new Error("项目目录身份有歧义");
        if (!ctx.projectId && projects.length === 1) ctx.projectId = projects[0]!.id;
        const selected = projects.filter(p => p.id === ctx.projectId);
        if (selected.length !== 1) throw new Error("请选择一个已声明项目");
        projectRoot = realpathSync(resolve(dirname(catalogPath), selected[0]!.root));
        ctx.sources.push(catalogPath);
      }
      const projectPath = join(projectRoot, "project.yaml");
      const project = yamlFile(projectPath)!;
      const projectId = project.metadata?.id ?? project.metadata?.name ?? project.project;
      merge("projectId", projectId, projectPath);
      if (!ctx.projectId) throw new Error("项目身份缺失");
      requiredSegment(ctx.projectId, "project");
      ctx.paths = { project: projectRoot };
      if (ctx.workstreamId && !ctx.missionId) throw new Error("工作流需要项目/任务目标身份");
      if (ctx.missionId) {
        requiredSegment(ctx.missionId, "mission");
        const missions = inside(projectRoot, resolve(projectRoot, project.missions?.root ?? "missions"));
        const matches = resolveWorkNodeDirs(missions, ctx.missionId);
        if (matches.length !== 1) throw new Error("任务目标身份缺失或有歧义：" + ctx.missionId);
        ctx.missionId = matches[0]!.dir;
        const missionRoot = inside(projectRoot, join(missions, ctx.missionId));
        ctx.paths.mission = missionRoot;
        const missionPath = join(missionRoot, "mission.yaml");
        const mission = yamlFile(missionPath)!;
        if (mission.metadata?.name && mission.metadata.name !== ctx.missionId) throw new Error("任务目标清单身份与目录冲突");
        const phase = mission.release?.phase ?? mission.metadata?.status;
        if (typeof phase !== "string" || !phase) throw new Error("任务目标的 phase/status 缺失");
        if (!ctx.phase.value) ctx.phase = { value: phase, source: missionPath };
        ctx.sources.push(missionPath);
        if (ctx.workstreamId) {
          requiredSegment(ctx.workstreamId, "workstream");
          const slices = inside(projectRoot, join(missionRoot, "slices"));
          const matches = resolveWorkNodeDirs(slices, ctx.workstreamId);
          if (matches.length !== 1) throw new Error("工作流必须解析到一个作者定义的切片");
          const specPath = join(inside(projectRoot, join(slices, matches[0]!.dir)), "SPEC.md");
          ctx.paths.workstream = dirname(specPath);
          const spec = readFileSync(specPath, "utf8");
          if (Buffer.byteLength(spec) > 65536) throw new Error("切片源超过 64 KiB");
          const fm = parseFrontmatter(spec);
          if (typeof fm.id !== "string" || !fm.id) throw new Error("切片身份缺失");
          requiredSegment(fm.id, "slice");
          if (fm.mission && fm.mission !== ctx.missionId) throw new Error("切片与任务目标身份冲突");
          // 工作流是已有的作者定义工作节点，并由其项目与任务目标限定。
          ctx.workstreamId = ctx.projectId + "/" + ctx.missionId + "/" + fm.id;
          if (!ctx.phase.source?.startsWith("workflow:")) ctx.phase = { value: typeof fm.stage === "string" ? fm.stage : typeof fm.status === "string" ? fm.status : null, source: specPath };
          ctx.sources.push(specPath);
        }
      }
    }
    if (!ctx.rigId && !ctx.projectId) throw new Error("请选择明确的工作组或项目/工作范围");
    return ctx;
  }

  resolve(input: OperatorContextReadContext): OperatingPosture {
    let context: OperatingContext | null = null;
    try {
      context = this.context(input);
      const resolved = this.modes.resolveEffective(context, ["human-led", "delegated"]);
      if (!resolved) return { posture: "human-led", source: "product-default", context, binding: null,
        reason: "解析出的工作范围未设置显式运行姿态；产品默认为 human-led。", grantsAuthority: false };
      const b = resolved.binding;
      if (!validateModeName(b.mode).ok || !validateRecord(b.record).ok) throw new Error("存储的模式绑定无效");
      return { posture: b.mode as "human-led" | "delegated", source: "binding", context,
        binding: { id: b.id, scope: resolved.resolvedScope, setAt: b.setAt, evidence: b.record.evidence_citation },
        reason: "采用最具体适用工作范围上的显式运行姿态。", grantsAuthority: false };
    } catch (error) { return unknown(String(error), context); }
  }

  /** 仅规范化明确的运行姿态写入；旧版人体工学模式保持原契约。 */
  target(scope: OperatorContextScope, qualifier: string | null): string | null {
    if (scope === "global_host") return null;
    const parts = (qualifier ?? "").split("/");
    const input: OperatorContextReadContext = scope === "rig" ? { rigId: qualifier! }
      : scope === "project" ? { projectId: qualifier! }
      : scope === "qitem" ? { qitemId: qualifier! }
      : { projectId: parts[0], missionId: parts[1], ...(scope === "workstream" ? { workstreamId: parts[2] } : {}) };
    if (scope === "mission" && parts.length !== 2 || scope === "workstream" && parts.length !== 3) throw new Error("请使用 project/mission[/slice-id] 限定符");
    const ctx = this.context(input);
    if (scope === "rig") return ctx.rigId!;
    if (scope === "project") return ctx.projectId!;
    if (scope === "mission") return missionModeQualifier(ctx.projectId!, ctx.missionId!);
    if (scope === "workstream") return ctx.workstreamId!;
    return ctx.qitemId!;
  }

  forHealth(record: HealthRecord): OperatingPosture {
    const scope = record.scope;
    const input: OperatorContextReadContext = scope.type === "mission" || scope.type === "slice"
      ? { projectId: scope.projectId, missionId: scope.missionId, ...(scope.type === "slice" ? { workstreamId: scope.sliceId } : {}) }
      : scope.type === "rig" || scope.type === "seat" ? { rigId: scope.rigId } : {};
    const ids = [...new Set(record.evidence.flatMap(e => e.type === "queue-transition" ? [e.qitemId] : []))];
    if (record.ceremony?.lineageId && !ids.includes(record.ceremony.lineageId)) ids.push(record.ceremony.lineageId);
    if (!ids.length) return this.resolve(input);
    const results = ids.map(qitemId => ({ qitemId, result: this.resolve({ ...input, qitemId }) }));
    const members = results.map(({ qitemId, result }) => ({ qitemId, posture: result.posture, source: result.source, bindingId: result.binding?.id ?? null }));
    const unresolved = results.find(r => r.result.posture === "unknown");
    if (unresolved) return { ...unknown(unresolved.qitemId + ": " + unresolved.result.reason, unresolved.result.context), members };
    if (new Set(results.map(r => r.result.posture)).size !== 1) return { ...unknown("发现项跨越不同运行姿态；请检查其具体成员。"), members };
    if (new Set(results.map(r => JSON.stringify([r.result.context?.projectId, r.result.context?.missionId, r.result.context?.workstreamId]))).size !== 1)
      return { ...unknown("发现项跨越不同工作上下文；无法选择单一项目权限。"), members };
    return { ...results[0]!.result, members, reason: "所有发现项成员均解析为 " + results[0]!.result.posture + "；上方绑定/来源描述第一个成员，请逐一检查各成员来源。" };
  }
}
