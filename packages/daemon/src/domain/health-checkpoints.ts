import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readHealthArtifact } from "./health-context.js";
import type { QueueRepository } from "./queue-repository.js";
import { healthHash, object, type HealthPolicyStore } from "./health-policy.js";
import { adaptQueueTransitionEvidence, adaptLifecycleReceiptEvidence, boundHealthEvidence, deriveHealthSourceFreshness, type HealthScope } from "./health-projection.js";
import type { HealthDetectorObservation, HealthObservationSource } from "./health-detectors.js";

/** authored outcome-boundary census，而非逐次编辑的 event feed。queue reference 在本地验证；
 * product/authority 含义仍属于带归因的陈述。 */
export interface HealthCheckpoint {
  schema: "openrig.health-checkpoint/v0alpha1";
  lineageQitemId: string;
  includeHandoffs?: boolean;
  scope: HealthScope;
  startedAt: string;
  observedAt: string;
  transitionIds: number[];
  productOutcomes: Array<{ id: string; observedAt: string; evidenceRef: string }>;
  productCensusRef: string;
  boundedAuthority: { applies: boolean | null; evidenceRef: string };
  sdlc?: { expectation: string; evidenceRef: string };
  authorityPaths: { project: string[]; mission: string[]; slice: string[] };
}
interface StoredCheckpoint { actor: string; checkpoint: HealthCheckpoint; episodeStartedAt: string; active: boolean; qualifying: HealthCheckpoint | null; }
function text(value: unknown): asserts value is string { if (typeof value !== "string" || !value.trim() || value.length > 4096) throw new Error("应为非空且长度受限的字符串"); }
function timestamp(value: unknown): number { text(value); const time = Date.parse(value); if (!Number.isFinite(time)) throw new Error("checkpoint timestamp 无效"); return time; }
function scope(value: unknown): asserts value is HealthScope {
  const type = (value as HealthScope)?.type;
  const fields = { instance: ["instanceId"], rig: ["rigId"], seat: ["rigId", "seatId"], mission: ["projectId", "missionId"], slice: ["projectId", "missionId", "sliceId"] }[type];
  if (!fields) throw new Error("未知 health scope");
  const s = object(value, ["type", ...fields]); fields.forEach((f) => text(s[f]));
}
export class HealthCheckpointSource implements HealthObservationSource {
  private readonly dir: string;
  constructor(home: string, private readonly queue: QueueRepository, private readonly policy: HealthPolicyStore, private readonly now = () => new Date().toISOString(), private readonly workspace = join(home, "workspace")) {
    this.dir = join(home, "health", "checkpoints");
  }
  private validate(value: unknown, allowDerive = false): HealthCheckpoint {
    const c = object(value, ["schema", "lineageQitemId", "scope", "startedAt", "observedAt", "transitionIds", "productOutcomes", "productCensusRef", "boundedAuthority", "authorityPaths", ...["includeHandoffs", "sdlc"].filter((key) => Object.hasOwn(value ?? {}, key))]);
    if (c.schema !== "openrig.health-checkpoint/v0alpha1") throw new Error("不支持的 checkpoint schema");
    text(c.lineageQitemId); text(c.productCensusRef); scope(c.scope);
    const start = timestamp(c.startedAt); const end = timestamp(c.observedAt);
    if (end < start || end > Date.parse(this.now())) throw new Error("Checkpoint window 顺序颠倒或位于未来");
    // 显式提交时解析一次，随后在 audit 中保留精确 ID。读取与已存 checkpoint 绝不静默获取后续流量。
    if (allowDerive && c.transitionIds === "derive") c.transitionIds = this.transitions(c as unknown as HealthCheckpoint).map((t) => t.transitionId);
    if (!Array.isArray(c.transitionIds) || c.transitionIds.length > 10000 || c.transitionIds.some((x) => !Number.isInteger(x) || x < 1) || new Set(c.transitionIds).size !== c.transitionIds.length) throw new Error("transition ID 无效、重复或过多");
    if (!Array.isArray(c.productOutcomes) || c.productOutcomes.length > 1000) throw new Error("product outcome 无效");
    const ids = new Set();
    for (const outcome of c.productOutcomes) {
      const o = object(outcome, ["id", "observedAt", "evidenceRef"]); text(o.id); text(o.evidenceRef);
      const at = timestamp(o.observedAt); if (at < start || at > end || ids.has(o.id)) throw new Error("product outcome 重复或位于 lineage window 外"); ids.add(o.id);
    }
    const authority = object(c.boundedAuthority, ["applies", "evidenceRef"]); text(authority.evidenceRef);
    if (authority.applies !== null && typeof authority.applies !== "boolean") throw new Error("Authority 必须为 true、false 或 unknown");
    if (c.includeHandoffs !== undefined && typeof c.includeHandoffs !== "boolean") throw new Error("includeHandoffs 必须为 boolean");
    if (c.sdlc !== undefined) {
      const sdlc = object(c.sdlc, ["expectation", "evidenceRef"]); text(sdlc.expectation); text(sdlc.evidenceRef);
    }
    const paths = object(c.authorityPaths, ["project", "mission", "slice"]);
    for (const list of Object.values(paths)) {
      if (!Array.isArray(list) || list.length > 10) throw new Error("authority path list 无效"); list.forEach(text);
    }
    const row = this.queue.getById(c.lineageQitemId);
    if (!row || row.tags?.some((t) => t === "health-diagnosis" || t === "health-human")) throw new Error("Checkpoint 必须指向现有 product work，而非 health traffic");
    const transitions = this.transitions(value as HealthCheckpoint);
    const members = [...new Set(transitions.map((t) => t.qitemId))].map((id) => this.queue.getById(id)!);
    if (members.some((member) => member.tags?.some((tag) => tag === "health-diagnosis" || tag === "health-human"))) throw new Error("Checkpoint 不得包含 health traffic");
    if (c.includeHandoffs) {
      const expected = c.scope.type === "slice" ? { "mission:": c.scope.missionId, "slice:": c.scope.sliceId }
        : c.scope.type === "mission" ? { "mission:": c.scope.missionId } : {};
      if (members.some((member) => member.tags?.some((tag) => Object.entries(expected).some(([prefix, id]) => tag.startsWith(prefix) && tag !== `${prefix}${id}`)))) throw new Error("Handoff lineage 超出声明的 checkpoint scope");
    }
    const actual = new Set(transitions.map((t) => t.transitionId));
    if (actual.size !== c.transitionIds.length || c.transitionIds.some((id) => !actual.has(id))) throw new Error("Checkpoint transition census 与此精确 lineage/window 不匹配");
    return structuredClone(c as unknown as HealthCheckpoint);
  }
  private transitions(c: HealthCheckpoint) {
    const log = this.queue.transitionLog;
    return c.includeHandoffs ? log.listForHandoffWindow(c.lineageQitemId, c.startedAt, c.observedAt, 10001)
      : log.listForQitemWindow(c.lineageQitemId, c.startedAt, c.observedAt, 10001);
  }
  private file(lineage: string): string { return join(this.dir, `${healthHash(lineage)}.json`); }
  submit(value: unknown, actor: string) {
    const checkpoint = this.validate(structuredClone(value), true);
    text(actor);
    const file = this.file(checkpoint.lineageQitemId);
    if (!existsSync(file) && existsSync(this.dir) && readdirSync(this.dir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length >= 200) throw new Error("health_checkpoint_source_limit");
    const previous = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as StoredCheckpoint : null;
    if (previous && healthHash(previous.checkpoint) === healthHash(checkpoint)) return previous;
    if (previous && Date.parse(checkpoint.observedAt) <= Date.parse(previous.checkpoint.observedAt)) throw new Error("Checkpoint 必须推进 observation time");
    const p = this.policy.read().policy.thresholds;
    const active = checkpoint.boundedAuthority.applies !== true && checkpoint.transitionIds.length >= p.ceremonyTransitions
      && checkpoint.transitionIds.length / Math.max(checkpoint.productOutcomes.length, 1) >= p.ceremonyRatio;
    const stored: StoredCheckpoint = { actor, checkpoint, active,
      episodeStartedAt: previous?.active ? previous.episodeStartedAt : checkpoint.startedAt,
      qualifying: active ? checkpoint : previous?.active ? previous.qualifying : null };
    // recurrence 从第一个新的 qualifying checkpoint 开始，而非上一个 episode 的 window。
    if (active && previous && !previous.active) stored.episodeStartedAt = checkpoint.observedAt;
    if (Buffer.byteLength(JSON.stringify(stored)) > 1048576) throw new Error("health_checkpoint_too_large");
    mkdirSync(join(this.dir, "history"), { recursive: true });
    const id = randomUUID();
    writeFileSync(join(this.dir, "history", `${id}.json`), JSON.stringify({ previous, current: stored }, null, 2), { flag: "wx" });
    const tmp = join(this.dir, `${id}.tmp`); writeFileSync(tmp, JSON.stringify(stored, null, 2)); renameSync(tmp, file);
    return stored;
  }
  entries(): StoredCheckpoint[] {
    if (!existsSync(this.dir)) return [];
    const names = readdirSync(this.dir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    if (names.length > 200) throw new Error("health_checkpoint_source_limit");
    return names.map((name) => {
      const bytes = readFileSync(join(this.dir, name), "utf8");
      if (Buffer.byteLength(bytes) > 1048576) throw new Error("health_checkpoint_too_large");
      const stored = JSON.parse(bytes) as StoredCheckpoint;
      this.validate(stored.checkpoint);
      text(stored.actor); timestamp(stored.episodeStartedAt);
      if (stored.qualifying) this.validate(stored.qualifying);
      return stored;
    });
  }
  read(): HealthDetectorObservation[] {
    const policy = this.policy.read().policy; const now = this.now();
    return this.entries().flatMap((stored) => {
      const current = stored.checkpoint;
      const thresholds = policy.thresholds;
      const active = current.boundedAuthority.applies !== true && current.transitionIds.length >= thresholds.ceremonyTransitions
        && current.transitionIds.length / Math.max(current.productOutcomes.length, 1) >= thresholds.ceremonyRatio;
      // 缺失 counter-signal 表示 unknown，即使 authored value 本会抑制规则也是如此。
      // 在 ref 解析前保留 potential observation。
      const c = active ? current : stored.qualifying ?? (current.transitionIds.length >= thresholds.ceremonyTransitions ? current : null);
      if (!c) return [];
      const ids = new Set(c.transitionIds);
      const transitions = this.transitions(c).filter((t) => ids.has(t.transitionId));
      const evidence = transitions.map(adaptQueueTransitionEvidence);
      const refs = [...c.productOutcomes.map((p) => ({ id: p.evidenceRef, at: p.observedAt, outcome: p.id })),
        { id: current.productCensusRef, at: current.observedAt, outcome: `product census by ${stored.actor}: ${current.productOutcomes.length} outcomes` },
        { id: current.boundedAuthority.evidenceRef, at: current.observedAt, outcome: `bounded authority: ${String(current.boundedAuthority.applies)}` },
        ...(current.sdlc ? [{ id: current.sdlc.evidenceRef, at: current.observedAt, outcome: `selected SDLC expectation: ${current.sdlc.expectation}` }] : [])];
      const resolved = new Map([...new Set([...c.productOutcomes, ...current.productOutcomes].map((p) => p.evidenceRef)
        .concat(c.productCensusRef, c.boundedAuthority.evidenceRef, current.productCensusRef, current.boundedAuthority.evidenceRef, current.sdlc?.evidenceRef ?? ""))]
        .map((ref) => [ref, readHealthArtifact(this.workspace, ref)]));
      const missing = [...resolved].filter(([, result]) => result.state !== "available").map(([ref]) => ref);
      const outcomeCount = resolved.get(c.productCensusRef)?.state === "available"
        && c.productOutcomes.every((p) => resolved.get(p.evidenceRef)?.state === "available") ? c.productOutcomes.length : null;
      const receipts = refs.flatMap((r, i) => {
        const result = resolved.get(r.id)!;
        return result.state === "available" ? [adaptLifecycleReceiptEvidence({ receiptId: r.id, operation: "health-outcome-checkpoint", outcome: `${r.outcome}; sha256:${result.sha256}`, observedAt: r.at, sourceOrder: evidence.length + i })] : [];
      });
      const available = transitions.length === ids.size && current.boundedAuthority.applies !== null && !!current.sdlc && missing.length === 0;
      const gateCounts = new Map<string, number>();
      const rows = new Map([...new Set(transitions.map((t) => t.qitemId))].map((id) => [id, this.queue.getById(id)]));
      for (const t of transitions) {
        const tags = rows.get(t.qitemId)?.tags?.filter((tag) => tag.startsWith("gate:")).sort().join("+") || "untagged";
        gateCounts.set(tags, (gateCounts.get(tags) ?? 0) + 1);
      }
      const breakdown = [...gateCounts].sort(([a], [b]) => a.localeCompare(b, "en-US")).map(([tag, count]) => `${tag}=${count}`).join(", ");
      return [{ kind: "coordination-lineage" as const, scope: current.scope, episodeStartedAt: stored.episodeStartedAt,
        lastObservedAt: current.observedAt, conditionCleared: !active && stored.qualifying !== null, confidence: "medium" as const, sourceDescription: `结果 census 归因于 ${stored.actor}；最新 authored census：${current.transitionIds.length} 个 transition、${current.productOutcomes.length} 个已列出的 product outcome，bounded authority 为 ${String(current.boundedAuthority.applies)}。观测 census：${rows.size} 个 qitem；按字面 gate tag 统计的 transition：${breakdown}。选定的 SDLC 预期：${current.sdlc?.expectation ?? "SDLC 预期不可用"}。product、authority 与 expectation 的含义是 authored evidence，并非 daemon 推断。已知 ratio 表示应对照该 expectation 检查比例是否合理，而不是判定 review 没有必要。不可用 reference：${missing.length ? missing.map((ref) => ref || "SDLC 预期不可用").join(", ") : "无"}。`, lineageId: c.lineageQitemId,
        coordinationTransitions: c.transitionIds.length, productStateChanges: outcomeCount,
        boundedAuthority: available && c.boundedAuthority.applies === true,
        reviewReturns: 0, candidateChanges: 0, newRiskClasses: 0,
        source: boundHealthEvidence([...evidence, ...receipts], { source: "mixed", startedAt: new Date(Math.max(Date.parse(c.startedAt), Date.parse(now) - policy.observationWindowSeconds * 1000)).toISOString(), endedAt: now, limit: 11003, retentionSeconds: policy.observationWindowSeconds }, deriveHealthSourceFreshness({ evaluatedAt: now, newestSourceAt: current.observedAt, maxAgeSeconds: policy.freshnessSeconds, available })) }];
    });
  }
}
