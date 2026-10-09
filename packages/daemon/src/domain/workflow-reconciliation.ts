import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { compileProjectLifecycle, type LifecycleCompilation, type LifecycleSourceDigest } from "./project-lifecycle-compiler.js";
import { WorkflowInstanceStore, WorkflowInstanceError } from "./workflow-instance-store.js";
import { WorkflowSpecCache } from "./workflow-spec-cache.js";
import type { WorkflowInstance, WorkflowSpec } from "./workflow-types.js";
import type { EventBus } from "./event-bus.js";
import { shellQuote } from "../adapters/shell-quote.js";

export interface GraphReconciliation {
  status: "current" | "source-only" | "compatible" | "incompatible" | "unavailable" | "unbound";
  adopted: boolean | null;
  boundDigest: string | null;
  proposedDigest: string | null;
  boundVersion: string;
  proposedVersion: string | null;
  compatible: boolean;
  changes: Array<{ kind: string; ref: string; fields?: string[] }>;
  reasons: string[];
  composition: { mode: string; explanation: string; boundSlices: string[]; executableSteps: Array<{ id: string; dependsOn: string[] }> };
  nextAction: string;
  applyCommand?: string;
  operationKey?: string;
  expectedVersion: number;
}

const canonical = (v: unknown): string => JSON.stringify(v, (_key, value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const graph = ({ version: _version, ...spec }: WorkflowSpec) => ({ ...spec, coordination_terminal_turn_rule: spec.coordination_terminal_turn_rule ?? "hot_potato" });
const sourcesOf = (instance: WorkflowInstance): LifecycleSourceDigest[] => Array.isArray(instance.lifecycleBinding?.sources)
  ? instance.lifecycleBinding.sources.filter((s): s is LifecycleSourceDigest => !!s && typeof s.path === "string" && typeof s.sha256 === "string" && ["project", "mission", "slice"].includes(s.kind))
  : [];
const caches = new WeakMap<Database.Database, Map<string, { signature: string; result: ReturnType<typeof compare> }>>();

/** 供 CLI/TUI 使用的一份派生比较。输入未变时只 stat 已绑定输入，不重新编译每份 proof/manifest；
 * 替换、删除或 revision 变化都会使结果失效。 */
export function inspectGraph(db: Database.Database, instanceId: string): GraphReconciliation {
  return proposal(db, new WorkflowInstanceStore(db).getByIdOrThrow(instanceId)).view;
}

function proposal(db: Database.Database, instance: WorkflowInstance, fresh = false): ReturnType<typeof compare> {
  let cache = caches.get(db);
  if (!cache) { cache = new Map(); caches.set(db, cache); }
  const old = cache.get(instance.instanceId);
  const signatureFor = (extra: LifecycleSourceDigest[] = []) => canonical([instance.version, instance.status,
    [...new Set([...sourcesOf(instance), ...extra].map(source => source.path))].sort().map(path => {
      try {
        const s = lstatSync(path, { bigint: true });
        return [path, String(s.ino), String(s.size), String(s.mtimeNs), String(s.ctimeNs)];
      } catch { return [path, "unavailable"]; }
    })]);
  if (!fresh && old?.result.view.status !== "unavailable" && old?.signature === signatureFor(old?.result.compilation?.sources)) return old.result;
  const result = compare(db, instance);
  cache.set(instance.instanceId, { signature: signatureFor(result.compilation?.sources), result });
  return result;
}

function compare(db: Database.Database, instance: WorkflowInstance): { view: GraphReconciliation; compilation?: LifecycleCompilation } {
  const binding = instance.lifecycleBinding;
  const oldSpec = new WorkflowSpecCache(db).getByNameVersion(instance.workflowName, instance.workflowVersion)?.spec;
  const mode = String((binding?.graphSource as { mode?: string } | undefined)?.mode ?? "unbound");
  const view: GraphReconciliation = {
    status: "unbound", adopted: null, boundDigest: instance.compiledInputDigest, proposedDigest: null,
    boundVersion: instance.workflowVersion, proposedVersion: null, compatible: false,
    expectedVersion: instance.version, changes: [], reasons: [],
    composition: {
      mode,
      explanation: mode === "legacy-slices"
        ? "活动 slice 执行契约就是可执行 step；execution.depends_on 提供前置条件，成员顺序仅供参考。"
        : "项目 profile 与 mission extension/override 定义外层 step。Slice manifest 绑定来源和 proof，不会自动生成嵌套子项。Wave 用于组织智能体规划，不调度子工作。当前 packet 与 blocker 承载实际职责。",
      boundSlices: sourcesOf(instance).filter(s => s.kind === "slice").map(s => s.path),
      executableSteps: oldSpec?.steps.map(s => ({ id: s.id, dependsOn: s.depends_on ?? [] })) ?? [],
    },
    nextAction: "zrig workflow trace " + instance.instanceId,
  };
  if (!binding || !instance.lifecycleOperationKey) {
    view.reasons.push("这不是 manifest 绑定的生命周期。请检查其已创作 spec；生命周期修订不会迁移任意 workflow。");
    return { view };
  }
  if (!Array.isArray(binding.sources) || sourcesOf(instance).length !== binding.sources.length) {
    view.status = "unavailable"; view.reasons.push("保留的来源 binding 格式错误或不完整；修订前请恢复其 provenance。");
    return { view };
  }
  const missionPath = sourcesOf(instance).find(s => s.kind === "mission")?.path;
  if (!missionPath || !oldSpec) {
    view.status = "unavailable"; view.reasons.push("绑定的 mission 来源或保留的运行中 specification 不可用；修订前请恢复该证据。");
    return { view };
  }
  let compilation: LifecycleCompilation;
  try { compilation = compileProjectLifecycle({ missionPath, operationKey: instance.lifecycleOperationKey }); }
  catch (error) {
    view.status = "unavailable"; view.reasons.push(error instanceof Error ? error.message : String(error));
    view.nextAction = "修复指定的已创作输入，然后运行 zrig workflow revise " + instance.instanceId;
    return { view };
  }
  view.proposedDigest = compilation.compiledInputDigest;
  view.proposedVersion = compilation.workflowSpec?.version ?? null;
  for (const source of sourcesOf(instance)) {
    const current = compilation.sources.find(s => s.path === source.path);
    if (!current) view.changes.push({ kind: "source-removed", ref: source.path });
    else if (current.sha256 !== source.sha256) view.changes.push({ kind: "source-changed", ref: source.path });
  }
  for (const source of compilation.sources) if (!sourcesOf(instance).some(s => s.path === source.path))
    view.changes.push({ kind: "source-added", ref: source.path });
  const proposed = compilation.workflowSpec;
  if (!compilation.eligible || !proposed) {
    view.status = "incompatible"; view.reasons.push(...compilation.unknowns);
    return { view, compilation };
  }
  const completed = new Set((db.prepare(
    "SELECT step_id FROM workflow_step_trails WHERE instance_id = ? AND closure_reason IN ('done', 'handoff')",
  ).all(instance.instanceId) as Array<{ step_id: string }>).map(row => row.step_id));
  const store = new WorkflowInstanceStore(db);
  const live = store.listFrontierBindings(instance.instanceId);
  const protectedIds = new Set([...completed, ...live.map(row => row.stepId), ...store.listFailureOccurrences(instance.instanceId).map(row => row.stepId)]);
  if (live.length !== instance.currentFrontier.length) view.reasons.push("当前 frontier 存在缺失或有歧义的 step binding；修订前请先明确职责归属。");
  if (!["active", "waiting"].includes(instance.status)) view.reasons.push("Instance 状态为 " + instance.status + "；不修订保留的终态或失败历史。");
  if (oldSpec.steps.some(s => s.depends_on === undefined || s.next_hop?.on) || proposed.steps.some(s => s.depends_on === undefined || s.next_hop?.on))
    view.reasons.push("只有不含条件跳转的显式依赖图支持原地修订。");
  const { steps: _oldSteps, exception_routing: oldRouting, ...oldContract } = graph(oldSpec);
  const { steps: _newSteps, exception_routing: newRouting, ...newContract } = graph(proposed);
  if (!same(oldRouting, newRouting)) view.changes.push({ kind: "exception-routing-changed", ref: "exception_routing", fields: ["仅影响未来 occurrence；现有 obligation 保留其 owner"] });
  if (!same(oldContract, newContract)) view.reasons.push("Workflow 全局 routing、entry、policy 或 context 契约已变化；请恢复这些字段，并单独修订未来 step。");
  const oldRequired = (binding.graphSource as { requiredSteps?: string[] } | undefined)?.requiredSteps ?? [];
  for (const id of oldRequired) if (!compilation.graphSource.requiredSteps.includes(id))
    view.reasons.push("不能移除必需 obligation " + id + "。");
  const ancestors = (spec: WorkflowSpec, id: string, seen = new Set<string>()): Set<string> => {
    for (const parent of spec.steps.find(s => s.id === id)?.depends_on ?? []) {
      if (!seen.has(parent)) { seen.add(parent); ancestors(spec, parent, seen); }
    }
    return seen;
  };
  for (const id of oldRequired) {
    const before = ancestors(oldSpec, id), after = ancestors(proposed, id);
    for (const parent of oldRequired) if (before.has(parent) && !after.has(parent))
      view.reasons.push("不能移除必需顺序：" + parent + " 位于 " + id + " 之前。");
  }
  for (const step of proposed.steps) if (step.host && step.host !== "local")
    view.reasons.push("Step " + step.id + " 要求不受支持的远程执行；请保留受支持的本地 target。");
  for (const step of oldSpec.steps) {
    const next = proposed.steps.find(s => s.id === step.id);
    if (!next) {
      view.changes.push({ kind: "step-removed", ref: step.id });
      view.reasons.push("不能移除 step " + step.id + "；请保留其 obligation 并记录归属明确的 disposition。");
    } else if (!same(step, next)) {
      view.changes.push({ kind: "step-changed", ref: step.id, fields: [...new Set([...Object.keys(step), ...Object.keys(next)])].filter(key => !same((step as unknown as Record<string, unknown>)[key], (next as unknown as Record<string, unknown>)[key])) });
      if (protectedIds.has(step.id)) view.reasons.push("Step " + step.id + " 已有完成、运行中或失败的工作。其判断/职责归属需要显式重新考虑；请恢复此 step，并修订尚未开始的后继项。");
    }
  }
  for (const step of proposed.steps) if (!oldSpec.steps.some(s => s.id === step.id))
    view.changes.push({ kind: "step-added", ref: step.id });
  // 既有 projector 会在前置项关闭时创建继任者。拒绝新近符合条件的 root，
  // 而不是虚构第二条调度路径。
  for (const step of proposed.steps) if (!protectedIds.has(step.id) && (step.depends_on ?? []).every(id => completed.has(id)))
    view.reasons.push("尚未开始的 step " + step.id + " 没有未完成前置项可触发它。请让它继续依赖待完成工作；本次修订不会重放已完成的前置项。");
  view.adopted = instance.compiledInputDigest === compilation.compiledInputDigest;
  view.compatible = view.reasons.length === 0;
  view.status = view.adopted ? "current" : !view.compatible ? "incompatible" : same(graph(oldSpec), graph(proposed)) ? "source-only" : "compatible";
  view.nextAction = "zrig workflow revise " + instance.instanceId;
  if (!view.adopted && view.compatible) {
    view.operationKey = "revision-" + createHash("sha256").update(canonical([instance.instanceId, instance.version, compilation.compiledInputDigest])).digest("hex").slice(0, 24);
    view.applyCommand = "zrig workflow revise " + instance.instanceId + " --apply --expected-version " + instance.version + " --expected-digest " + compilation.compiledInputDigest + " --operation-key " + view.operationKey + " --actor-session <you> --reason <decision>";
  }
  return { view, compilation };
}

/** 原生 effect 回读能跨越响应丢失与之后的作者修改。回执存于既有 instance binding；
 * 之前的 spec、step 和 queue 历史保持不变。 */
export function recoverGraphOperation(db: Database.Database, key: string): { kind: string; receipt: Record<string, unknown>; instance: WorkflowInstance } | null {
  const store = new WorkflowInstanceStore(db);
  const created = store.getByLifecycleOperationKey(key);
  if (created) return { kind: "instantiate", instance: created, receipt: {
    operationKey: key, instanceId: created.instanceId, entryQitemId: created.lifecycleBinding?.entryQitemId,
    compiledInputDigest: created.lifecycleBinding?.initialInputDigest ?? created.compiledInputDigest,
    createdAt: created.createdAt, actorSession: created.createdBySession,
  } };
  const match = db.prepare("SELECT wi.instance_id, revision.value AS receipt FROM workflow_instances wi, json_each(wi.lifecycle_binding_json, '$.revisionHistory') revision WHERE json_extract(revision.value, '$.operationKey') = ?")
    .get(key) as { instance_id: string; receipt: string } | undefined;
  return match ? { kind: "revision", instance: store.getByIdOrThrow(match.instance_id), receipt: JSON.parse(match.receipt) } : null;
}

export function reviseGraph(db: Database.Database, bus: EventBus, input: {
  instanceId: string; operationKey: string; expectedVersion: number; expectedDigest: string; actorSession: string; reason: string;
}) {
  const fail = (message: string, details?: Record<string, unknown>): never => { throw new WorkflowInstanceError("lifecycle_revision_conflict", message, details); };
  if (typeof input.operationKey !== "string" || !input.operationKey.trim() || typeof input.actorSession !== "string" || !input.actorSession.trim() || typeof input.reason !== "string" || !input.reason.trim() || !Number.isSafeInteger(input.expectedVersion) || typeof input.expectedDigest !== "string" || !input.expectedDigest)
    fail("修订需要检查过的 version/digest、稳定 operation key、actor 和 decision。请运行 zrig workflow revise <instance>。");
  const prior = recoverGraphOperation(db, input.operationKey);
  if (prior) {
    if (prior.kind !== "revision" || prior.instance.instanceId !== input.instanceId ||
        prior.receipt.expectedVersion !== input.expectedVersion || prior.receipt.compiledInputDigest !== input.expectedDigest ||
        prior.receipt.actorSession !== input.actorSession || prior.receipt.reason !== input.reason)
      fail("此 operation key 已记录不同 decision。请检查 zrig workflow operation " + shellQuote(input.operationKey));
    return { ...prior, replayed: true };
  }
  let receipt!: Record<string, unknown>;
  bus.withNotifyEnvelope(register => {
    if (recoverGraphOperation(db, input.operationKey)) fail("Operation 已被并发提交；再次尝试前请恢复其精确 key。");
    const store = new WorkflowInstanceStore(db), instance = store.getByIdOrThrow(input.instanceId);
    if (instance.version !== input.expectedVersion) fail("Instance 在检查后已推进。选择修订前请重新检查。", { expectedVersion: input.expectedVersion, actualVersion: instance.version });
    const { view, compilation } = proposal(db, instance, true);
    if (view.proposedDigest !== input.expectedDigest) fail("已创作输入在检查后发生变化。应用前请检查新 proposal。", { expectedDigest: input.expectedDigest, actualDigest: view.proposedDigest });
    if (!view.compatible || view.adopted || !compilation?.workflowSpec) fail("修订被拒绝；现有工作已保留。", { reconciliation: view });
    const binding = instance.lifecycleBinding!;
    receipt = { operationKey: input.operationKey, instanceId: input.instanceId, expectedVersion: input.expectedVersion,
      previousDigest: instance.compiledInputDigest, previousVersion: instance.workflowVersion,
      previousSources: binding.sources, previousGraphSource: binding.graphSource,
      compiledInputDigest: compilation!.compiledInputDigest, workflowVersion: compilation!.workflowSpec!.version,
      actorSession: input.actorSession, reason: input.reason, at: new Date().toISOString(), sourceOnly: view.status === "source-only",
      preservedFrontier: instance.currentFrontier, changes: view.changes };
    new WorkflowSpecCache(db).putGenerated(compilation!.workflowSpec!, compilation!.sources.find(s => s.kind === "mission")!.path, compilation!.compiledInputDigest);
    store.reviseLifecycle(instance.instanceId, instance.version, compilation!.workflowSpec!.version, compilation!.compiledInputDigest, {
      ...binding, initialInputDigest: binding.initialInputDigest ?? instance.compiledInputDigest,
      sources: compilation!.sources, dependencies: compilation!.dependencies, graphSource: compilation!.graphSource,
      revisionHistory: [...(Array.isArray(binding.revisionHistory) ? binding.revisionHistory : []), receipt],
    });
    register(bus.persistWithinTransaction({ type: "workflow.revised", instanceId: instance.instanceId, workflowName: instance.workflowName, operationKey: input.operationKey, compiledInputDigest: compilation!.compiledInputDigest, revisedBy: input.actorSession }));
  });
  return { kind: "revision", receipt, instance: new WorkflowInstanceStore(db).getByIdOrThrow(input.instanceId), replayed: false };
}
