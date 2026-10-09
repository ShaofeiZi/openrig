import type { QueueItem, QueueRepository } from "./queue-repository.js";
import type { HealthProjectionService } from "./health-detectors.js";
import { healthHash, object, type HealthPolicyStore } from "./health-policy.js";
import { HEALTH_RECORD_SCHEMA, type HealthRecord, type CeremonyProgressAssessment } from "./health-projection.js";

export const DIAGNOSIS_VERDICTS = ["false positive", "early real condition", "established pathology", "insufficient evidence", "resolved"] as const;
export interface HealthDisposition {
  verdict: typeof DIAGNOSIS_VERDICTS[number]; causalStart: string | null;
  steering: string; uncertainty: string; evidenceRefs: string[];
  progress?: CeremonyProgressAssessment;
  correction?: {
    applicability: string; causalJudgment: string;
    action: { state: "proposed" | "taken"; summary: string; evidenceRefs: string[] };
    effect: { state: "unobserved" | "observed"; summary: string; evidenceRefs: string[] };
  };
}
export interface AuthorityReference { level?: "project" | "mission" | "slice"; path: string; state: "available" | "unavailable"; sha256?: string; content?: string; role?: string; selectedBy?: string; reason?: string; }
interface Packet { schema: "openrig.health-diagnosis/v0alpha1"; finding: HealthRecord; policyVersion: string; authority: AuthorityReference[]; presentedAt: string; instructions: string; }
interface Receipt { kind: "health-diagnosis"; at: string; action: "presented" | "observed" | "disposition" | "notification-readiness"; finding?: HealthRecord; disposition?: HealthDisposition; authority?: AuthorityReference[]; episodeCleared?: boolean; progressEvidence?: AuthorityReference[]; correctionEvidence?: AuthorityReference[]; actor?: string; transitionId?: number; notificationReadiness?: { ready: boolean; reason: string }; }
interface DiagnosisAction { qitemId: string; findingId: string; action: "create" | "represent" | "observe" | "retained" | "deferred" | "notify" | "notification-deferred"; reason?: string; operatingPosture?: HealthRecord["operatingPosture"]; }
const instructions = "此工作包是快捷入口，并非事情的全貌。请先查看下方确切证据以及当前项目、任务目标和切片的权威资料；采取行动前重新读取这些来源。你可以扩展调查。确定性信号不是心理或认识论诊断。支持自查：追溯最早因果点，检查自己的影响，区分其他席位或过期控制平面来源，只在有帮助时请求第二个智能体。记录一次有界处置，包括因果起点（或未知）、最小纠正指导、证据和剩余不确定性。建议不代表有权取消工作、改变工作范围/严谨度/所有权/生命周期、重启智能体或放宽安全要求。升级给人类需要显式策略和已验证的交付就绪状态。";
const correctionGuidance = "检查当前选定上下文及其来源，包括尚无后继任务目标时的项目规划。即使限制已经授权，其前提仍可能被证伪或力度不相称；对完整工作流结果清单存在不确定性，不足以证明应保留该限制。请在权限范围内应用当前纠正，并保留无关但有效的边界，包括发布边界。正常的交互式规划本身不是病理。把自动唤醒/回执记录与所有者的有效工作分开；评估调查的相关性与打断成本。需要时采用一次有界纠正，而不是反复自审或设置通用评审者。可选纠正中，应分别记录 applicability 和带归因的 causalJudgment，以及 action {state: proposed|taken, summary, evidenceRefs} 和后续 effect {state: unobserved|observed, summary, evidenceRefs}。处置、关闭队列、编辑提示词或数值清零都不等于观察到行为改善。若之后没有自然观察机会，请让 effect 保持 unobserved；保留案例回放只能证明机制。绝不能根据此建议推断其他席位的上下文或重新启用实时诊断。";

export class HealthDiagnosisService {
  private pending: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastEvaluation: { at: string; error: string | null } | null = null;
  status() { return { scheduled: this.timer !== undefined, lastEvaluation: this.lastEvaluation }; }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.evaluate("system:health", true).then(() => { this.lastEvaluation = { at: this.now(), error: null }; }, (error: unknown) => { this.lastEvaluation = { at: this.now(), error: String(error) }; });
    }, 60000);
    this.timer.unref();
  }
  async stop(): Promise<void> { clearInterval(this.timer); this.timer = undefined; await this.pending; }
  constructor(private readonly deps: {
    queue: QueueRepository; projection: HealthProjectionService; policy: HealthPolicyStore;
    now?: () => string; authority: (record: HealthRecord) => AuthorityReference[];
    resolveEvidence?: (path: string, finding: HealthRecord) => AuthorityReference;
    humanReadiness?: (address: string) => Promise<{ ready: boolean; reason: string }>;
  }) {}
  private now(): string { return this.deps.now?.() ?? new Date().toISOString(); }
  private id(findingId: string): string { return `qitem-health-diagnosis-${findingId}`; }
  private owns(row: QueueItem): boolean {
    // 该 tag 也用于主题分类；只有本服务既有的 ID 命名空间才表示诊断事件。
    return row.qitemId.startsWith(this.id("")) && row.tags?.includes("health-diagnosis") === true;
  }
  private missingCurrent(finding: HealthRecord): HealthRecord {
    if (finding.category !== "process") return finding;
    return { ...finding, operatingPosture: { posture: "unknown", source: "unknown", context: null, binding: null,
      reason: "当前发现不可用；保留的工作姿态不能授权新的打断。", grantsAuthority: false } };
  }
  private receipt(qitemId: string, actor: string, value: Omit<Receipt, "kind" | "at">, identityProvenance: string | null = null): void {
    this.deps.queue.update({ qitemId, actorSession: actor, identityProvenance, transitionNote: JSON.stringify({ kind: "health-diagnosis", at: this.now(), ...value }) });
  }
  show(qitemId: string, refresh = true) {
    const row = this.deps.queue.getById(qitemId);
    if (!row || !this.owns(row)) throw new Error("health_diagnosis_not_found");
    const invalid = () => new Error(`health_diagnosis_invalid_packet: ${qitemId}`);
    let packet: Packet;
    try { packet = JSON.parse(row.body) as Packet; } catch { throw invalid(); }
    if (packet?.schema !== "openrig.health-diagnosis/v0alpha1" || packet.finding?.schema !== HEALTH_RECORD_SCHEMA
      || typeof packet.finding.id !== "string" || qitemId !== this.id(packet.finding.id)
      || typeof packet.policyVersion !== "string" || !packet.policyVersion || !Array.isArray(packet.authority)
      || typeof packet.instructions !== "string" || !packet.instructions
      || typeof packet.presentedAt !== "string" || !Number.isFinite(Date.parse(packet.presentedAt))) throw invalid();
    const human = this.deps.queue.getById(`qitem-health-human-${packet.finding.id}`);
    const receipts: Receipt[] = this.deps.queue.listTransitions(qitemId).flatMap((t) => {
      try { const value = JSON.parse(t.transitionNote ?? "null") as Receipt | null; return value?.kind === "health-diagnosis" ? [{ ...value, actor: t.actorSession, transitionId: t.transitionId }] : []; } catch { return []; }
    });
    const finding = refresh && (packet.finding.ceremony || packet.finding.category === "process")
      ? this.deps.projection.get(packet.finding.id) ?? this.missingCurrent(receipts.filter((r) => r.finding).at(-1)?.finding ?? packet.finding)
      : receipts.filter((r) => r.finding).at(-1)?.finding ?? packet.finding;
    const last = receipts.filter((r) => r.disposition).at(-1);
    return { row, packet, receipts, notificationReadiness: receipts.filter((r) => r.notificationReadiness).at(-1)?.notificationReadiness ?? null, humanDelivery: human ? { qitemId: human.qitemId, outcome: human.deliveryOutcome ?? "pending" } : null,
      finding, authority: refresh ? this.deps.authority(finding) : receipts.filter((r) => r.authority).at(-1)?.authority ?? packet.authority,
      authorityReadAt: refresh ? this.now() : null, guidance: correctionGuidance,
      disposition: last?.disposition ?? null,
      assessment: last ? { actor: last.actor, at: last.at, transitionId: last.transitionId } : null,
      correctionEvidence: last?.correctionEvidence ?? [],
      behavioralEffect: last?.disposition?.correction?.effect.state ?? "unobserved" };
  }
  list(refresh = true) {
    // 拒绝使用被截断的所有权清单，不能把隐藏事件误认为不存在。
    const rows = this.deps.queue.list({ tag: "health-diagnosis", limit: 10000 });
    if (rows.length === 10000) throw new Error("health_diagnosis_census_truncated");
    const occurrences = rows.filter((r) => this.owns(r)).map((r) => this.show(r.qitemId, false));
    if (!refresh) return occurrences;
    const current = new Map(this.deps.projection.records().map((finding) => [finding.id, finding]));
    return occurrences.map((o) => {
      const finding = current.get(o.finding.id) ?? this.missingCurrent(o.finding);
      return { ...o, finding, authority: this.deps.authority(finding), authorityReadAt: this.now() };
    });
  }
  evaluate(actor: string, apply: boolean): Promise<{ policyVersion: string; enabled: boolean; actions: DiagnosisAction[] }> {
    const work = this.pending.then(() => this.evaluateOnce(actor, apply));
    this.pending = work.catch(() => undefined);
    return work;
  }
  private async evaluateOnce(actor: string, apply: boolean) {
    const effective = this.deps.policy.read();
    const policy = effective.policy.diagnosis;
    const actions: DiagnosisAction[] = [];
    if (!policy.enabled || !policy.owner) return { policyVersion: effective.version, enabled: false, actions };
    const now = Date.parse(this.now());
    const occurrences = this.list(false);
    let latestOwnerPresentation = Math.max(0, ...occurrences.filter((x) => x.row.destinationSession === policy.owner).flatMap((x) => [Date.parse(x.packet.presentedAt), ...x.receipts.filter((r) => r.action === "presented").map((r) => Date.parse(r.at))]));
    const records = this.deps.projection.records().sort((a, b) => Number(b.detector === "process.ceremony-amplification") - Number(a.detector === "process.ceremony-amplification") || a.id.localeCompare(b.id));
    for (const finding of records) {
      const qitemId = this.id(finding.id);
      const old = occurrences.find((o) => o.row.qitemId === qitemId);
      const base = { qitemId, findingId: finding.id };
      const suspected = finding.ceremony?.stage === "needs-diagnosis" && finding.freshness.state === "fresh";
      if (old && finding.status !== "active" && !suspected) {
        if (old.finding.status !== finding.status) {
          actions.push({ ...base, action: "observe" });
          if (apply) this.receipt(qitemId, actor, { action: "observed", finding });
        }
        continue;
      }
      if ((finding.status !== "active" && !suspected) || !policy.detectors.includes(finding.detector)) continue;
      // 流程偏好只影响呈现，绝不改变运行健康状态或工作流提醒。
      if (finding.category === "process" && finding.operatingPosture?.posture !== "delegated") {
        actions.push({ ...base, action: "deferred", operatingPosture: finding.operatingPosture,
          reason: finding.operatingPosture?.posture === "human-led"
            ? "人类主导的工作范围：仅流程类打断保持静默；该发现仍可检查。"
            : "工作姿态未知：不推断存在已委派的流程打断。" });
        continue;
      }
      const age = now - Date.parse(finding.lastObservedAt ?? "");
      if (!Number.isFinite(age) || age < 0 || age > effective.policy.freshnessSeconds * 1000) {
        actions.push({ ...base, action: "deferred", reason: "来源过期或相互矛盾" }); continue;
      }
      if (old && finding.ceremony?.stage === "confirmed" && old.row.destinationSession === policy.owner
        && effective.policy.human.address && effective.policy.human.conditions.includes("confirmed ceremony")
        && !this.deps.queue.getById(`qitem-health-human-${finding.id}`)) {
        if (!apply) actions.push({ ...base, action: "notify" });
        else {
          try { await this.notifyOccurrence(qitemId, actor, null, true); actions.push({ ...base, action: "notify" }); }
          catch (error) { actions.push({ ...base, action: "notification-deferred", reason: String(error) }); }
        }
      }
      if (old && (old.disposition || old.row.destinationSession !== policy.owner || !["pending", "in-progress"].includes(old.row.state)
        || old.receipts.filter((r) => r.action === "presented").length >= policy.maxRepresentations)) {
        actions.push({ ...base, action: "retained", reason: "已有处置、托管关系或复发次数限制" }); continue;
      }
      if (now - latestOwnerPresentation < policy.cooldownSeconds * 1000) {
        actions.push({ ...base, action: "deferred", reason: "所有者处于冷却期" }); continue;
      }
      actions.push({ ...base, action: old ? "represent" : "create" });
      latestOwnerPresentation = now;
      if (!apply) continue;
      if (old) {
        // 等待传输前先预留：重启或另一轮评估不能盲目重发。
        this.receipt(qitemId, actor, { action: "presented", finding, authority: this.deps.authority(finding) });
        await this.deps.queue.maybeNudge(qitemId, old.row.destinationSession, true, actor);
      } else {
        const packet: Packet = { schema: "openrig.health-diagnosis/v0alpha1", finding, policyVersion: effective.version,
          authority: this.deps.authority(finding), presentedAt: this.now(), instructions: `${instructions} ${correctionGuidance}${finding.ceremony ? " 这是暂定怀疑，并非已确认警告。请根据正常的工作范围、证明、工作流证据及选定的 SDLC 边界判断产品进展；不要把审批、C1 配对、证明文件、提交、测试或一般关闭动作计为结果。在现有处置中，可选包含 progress: {basis, conclusion: established|false-positive|indeterminate, outcomes: [{id, observedAt, evidenceRefs}], boundedAuthority: boolean|null, boundary, evidenceRefs, missingFacts}。basis 必须绑定 diagnosis show 返回的当前 finding.ceremony.basis；为确切转换窗口建立完整结果清单，否则返回 indeterminate 并指出缺失事实。该清单评估的是此窗口，并非某条受质疑规则是否仍有用；记录纠正不以完成该清单为前提。结果和 bounded-authority 语义属于你的带归因判断。空 outcomes 列表表示你确认没有结果，绝不表示无法找到结果。不需要单独检查点。" : ""} 使用 zrig health diagnosis show ${qitemId} --full --json 读取当前上下文和处置（包含完整保留证据，内容可能较大）。` };
        await this.deps.queue.create({ qitemId, sourceSession: actor, destinationSession: policy.owner, body: JSON.stringify(packet, null, 2),
          tags: ["health-diagnosis", finding.id, `policy:${effective.version}`, ...(finding.ceremony ? [`health-lineage:${finding.ceremony.lineageId}`] : [])], summary: `系统健康状态：检查 ${finding.detector}`, evidenceRef: finding.id });
      }
    }
    return { policyVersion: effective.version, enabled: true, actions };
  }
  private requireOwner(qitemId: string, actor: string) {
    const diagnosis = this.show(qitemId);
    if (diagnosis.row.destinationSession !== actor) throw new Error("health_diagnosis_owner_required");
    return diagnosis;
  }
  dispose(qitemId: string, actor: string, value: unknown, identityProvenance: string | null = null) {
    const diagnosis = this.requireOwner(qitemId, actor);
    const d = object(value, ["verdict", "causalStart", "steering", "uncertainty", "evidenceRefs", ...["progress", "correction"].filter(k => Object.hasOwn(value ?? {}, k))]);
    if (!DIAGNOSIS_VERDICTS.includes(d.verdict as HealthDisposition["verdict"]) || (d.causalStart !== null && typeof d.causalStart !== "string")
      || typeof d.steering !== "string" || !d.steering.trim() || typeof d.uncertainty !== "string" || !d.uncertainty.trim()
      || !Array.isArray(d.evidenceRefs) || !d.evidenceRefs.length || d.evidenceRefs.some((r) => typeof r !== "string" || !r.trim())) throw new Error("健康状态处置无效或不完整");
    if (healthHash(this.show(qitemId).disposition) === healthHash(d)) return this.show(qitemId);
    const progressEvidence = d.progress === undefined ? undefined : this.validateProgress(d.progress, diagnosis.finding);
    const correctionEvidence = d.correction === undefined ? undefined : this.validateCorrection(d.correction, diagnosis.finding);
    const progress = d.progress as CeremonyProgressAssessment | undefined;
    const episodeCleared = progress && progress.missingFacts.length === 0 && (progress.conclusion === "false-positive" || (progress.conclusion === "established"
      && (progress.boundedAuthority === true || diagnosis.finding.ceremony!.transitionIds.length / Math.max(progress.outcomes.length, 1) < this.deps.policy.read().policy.thresholds.ceremonyRatio)));
    if (progress?.conclusion === "established" && !episodeCleared && ["false positive", "insufficient evidence", "resolved"].includes(String(d.verdict))) throw new Error("health_progress_contradicts_disposition");
    this.receipt(qitemId, actor, { action: "disposition", disposition: d as unknown as HealthDisposition,
      ...(correctionEvidence ? { correctionEvidence } : {}),
      ...(progressEvidence ? { progressEvidence, finding: diagnosis.finding, episodeCleared } : {}) }, identityProvenance);
    return this.show(qitemId);
  }
  private validateCorrection(value: unknown, finding: HealthRecord): AuthorityReference[] {
    const c = object(value, ["applicability", "causalJudgment", "action", "effect"]);
    const text = (v: unknown): v is string => typeof v === "string" && !!v.trim() && v.length <= 4096;
    if (!text(c.applicability) || !text(c.causalJudgment)) throw Error("纠正必须包含适用性和带归因的因果判断");
    const refs: string[] = [];
    for (const [key, states, evidenced] of [["action", ["proposed", "taken"], "taken"], ["effect", ["unobserved", "observed"], "observed"]] as const) {
      const claim = object(c[key], ["state", "summary", "evidenceRefs"]);
      if (!(states as readonly unknown[]).includes(claim.state) || !text(claim.summary) || !Array.isArray(claim.evidenceRefs)
        || claim.evidenceRefs.length > 32 || !claim.evidenceRefs.every(text)
        || (claim.state === evidenced && !claim.evidenceRefs.length)) throw Error("纠正内容无效：" + key + "；taken/observed 声明必须提供证据");
      refs.push(...claim.evidenceRefs as string[]);
    }
    const evidence = [...new Set(refs)].map(path => this.deps.resolveEvidence?.(path, finding) ?? { path, state: "unavailable" as const });
    if (evidence.some(e => e.state !== "available")) throw Error("health_correction_evidence_unavailable");
    // 证据是否存在及其归因可以校验；因果是否成立仍由所有者判断。
    return evidence;
  }
  private validateProgress(value: unknown, finding: HealthRecord): AuthorityReference[] {
    const p = object(value, ["basis", "conclusion", "outcomes", "boundedAuthority", "boundary", "evidenceRefs", "missingFacts"]);
    const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 4096;
    const refs = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 100 && v.every(text);
    if (!finding.ceremony || p.basis !== finding.ceremony.basis) throw new Error("health_progress_basis_changed_or_unavailable");
    if (!["established", "false-positive", "indeterminate"].includes(String(p.conclusion)) || !text(p.boundary)
      || !refs(p.evidenceRefs) || !p.evidenceRefs.length || !refs(p.missingFacts)
      || (p.boundedAuthority !== null && typeof p.boundedAuthority !== "boolean")
      || !Array.isArray(p.outcomes) || p.outcomes.length > 100) throw new Error("进度评估无效");
    if (p.conclusion === "established" && (p.boundedAuthority === null || p.missingFacts.length)) throw new Error("已建立的进度必须有已知边界且不存在缺失事实");
    if (p.conclusion === "indeterminate" && !p.missingFacts.length) throw new Error("不确定的进度必须指出缺失事实");
    if (p.conclusion !== "established" && p.outcomes.length) throw new Error("只有已建立的进度才能提供结果");
    const evidenceRefs = [...p.evidenceRefs]; const ids = new Set();
    for (const raw of p.outcomes) {
      const o = object(raw, ["id", "observedAt", "evidenceRefs"]);
      const at = Date.parse(String(o.observedAt));
      if (!text(o.id) || ids.has(o.id) || !Number.isFinite(at) || at < Date.parse(finding.window.startedAt)
        || at > Date.parse(finding.window.endedAt) || !refs(o.evidenceRefs) || !o.evidenceRefs.length) throw new Error("结果必须唯一、有证据支持，并位于所评估的转换窗口内");
      ids.add(o.id); evidenceRefs.push(...o.evidenceRefs);
    }
    const evidence = [...new Set(evidenceRefs)].map((path) => this.deps.resolveEvidence?.(path, finding) ?? { path, state: "unavailable" as const });
    if (evidence.some((e) => e.state !== "available")) throw new Error("health_progress_evidence_unavailable");
    return evidence;
  }
  async notify(qitemId: string, actor: string, identityProvenance: string | null = null) {
    return this.notifyOccurrence(qitemId, actor, identityProvenance, false);
  }
  private async notifyOccurrence(qitemId: string, actor: string, identityProvenance: string | null, automatic: boolean) {
    const diagnosis = automatic ? this.show(qitemId) : this.requireOwner(qitemId, actor);
    if (diagnosis.finding.category === "process" && diagnosis.finding.operatingPosture?.posture !== "delegated") throw new Error("health_process_posture_does_not_admit");
    if (automatic && diagnosis.row.destinationSession !== this.deps.policy.read().policy.diagnosis.owner) throw new Error("health_diagnosis_owner_required");
    if (diagnosis.finding.ceremony && (diagnosis.finding.status !== "active" || diagnosis.finding.ceremony.stage !== "confirmed")) throw new Error("health_human_requires_confirmed_active_episode");
    const { human } = this.deps.policy.read().policy;
    const allowed = (human.conditions.includes("critical") && diagnosis.finding.severity === "critical" && diagnosis.finding.status === "active")
      || (human.conditions.includes("established pathology") && diagnosis.disposition?.verdict === "established pathology")
      || (human.conditions.includes("confirmed ceremony") && diagnosis.finding.status === "active" && diagnosis.finding.ceremony?.stage === "confirmed");
    if (!human.address || !allowed) throw new Error("health_human_policy_does_not_admit");
    const id = `qitem-health-human-${diagnosis.packet.finding.id}`;
    const existing = this.deps.queue.getById(id);
    if (existing) return { qitemId: existing.qitemId, deliveryOutcome: existing.deliveryOutcome ?? "pending", nextInspection: `zrig queue transitions ${id}` };
    const ready = await this.deps.humanReadiness?.(human.address) ?? { ready: false, reason: "没有已验证的交付就绪状态" };
    if (healthHash(diagnosis.notificationReadiness) !== healthHash(ready)) this.receipt(qitemId, actor, { action: "notification-readiness", notificationReadiness: ready }, identityProvenance);
    if (!ready?.ready) throw new Error(`health_human_readiness_unavailable: ${ready?.reason ?? "没有已验证的交付就绪状态"}`);
    // 就绪状态 I/O 后重新检查实时发现和托管权；不得发布过期确认。
    const current = automatic ? this.show(qitemId) : this.requireOwner(qitemId, actor);
    if (current.finding.category === "process" && current.finding.operatingPosture?.posture !== "delegated") throw new Error("health_process_posture_changed_or_unknown");
    if (automatic && current.row.destinationSession !== this.deps.policy.read().policy.diagnosis.owner) throw new Error("health_diagnosis_owner_required");
    if (current.finding.ceremony && (current.finding.status !== "active" || current.finding.ceremony.stage !== "confirmed")) throw new Error("health_human_requires_confirmed_active_episode");
    if (healthHash(this.deps.policy.read().policy.human) !== healthHash(human)) throw new Error("health_human_policy_changed");
    const row = this.deps.queue.getById(id) ?? await this.deps.queue.create({ qitemId: id, sourceSession: actor, destinationSession: human.address, identityProvenance,
      body: JSON.stringify({ diagnosis: qitemId, finding: diagnosis.finding, disposition: diagnosis.disposition }, null, 2),
      summary: `系统健康状态：${diagnosis.finding.summary}`, evidenceRef: qitemId, tags: ["health-human", diagnosis.finding.id] });
    return { qitemId: row.qitemId, deliveryOutcome: row.deliveryOutcome ?? "pending", nextInspection: `zrig queue transitions ${row.qitemId}` };
  }
}
