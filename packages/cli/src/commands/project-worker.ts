import { createHash } from "node:crypto";
import fs from "node:fs";
import { parse } from "yaml";
import { StreamClassificationWorker, ClassifierLeaseError, ClassificationAttemptError, ProjectClassifierError,
  LABEL_FIELDS, type WorkerOptions, type ClassificationCandidates, type ClassificationDecision } from "@openrig/daemon/stream-classifier";
import type { DaemonClient } from "../client.js";

type Client = Pick<DaemonClient, "get" | "post">;
export interface WakeOptions { project: string; taxonomy: string; classifierVersion: string; evidenceEpoch: string; decisions?: string; limit?: string }
type SourceSnapshot = {
  occupant: { session: string; nodeId: string; generation: string; rigId: string };
  version: string; observedAt: string; unavailable: string[];
  sources: { project: unknown; scopes: {id: string; source: string; hash: string}[];
    roster: {session: string; nodeId: string; generation: string}[];
    recent: {streamItemId: string; body: string; evidenceRef: string}[] };
};
const hash = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
function localText(file: string): string {
  if (fs.statSync(file).size > 1024 * 1024) throw Error("worker 输入超过 1 MiB");
  const text = fs.readFileSync(file, "utf8");
  if (Buffer.byteLength(text) > 1024 * 1024) throw Error("worker 输入超过 1 MiB");
  return text;
}
function response<T>(r: {status: number; data: T}): T {
  if (r.status < 400) return r.data;
  const body = r.data as {error?: string; message?: string};
  const code = body?.error ?? "http_error", message = body?.message ?? code;
  if (code.startsWith("lease_") || ["no_active_lease", "occupant_changed", "occupant_unavailable"].includes(code)) throw new ClassifierLeaseError(code, message);
  if (code.startsWith("attempt_") || code === "already_classified") throw new ClassificationAttemptError(code, message);
  if (code === "idempotency_violation") throw new ProjectClassifierError(code, message);
  throw Error(`${code}: ${message}`);
}

export async function prepareWorker(client: Client, opts: WakeOptions, read = localText) {
  const limit = Number(opts.limit ?? 20);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Error("limit 必须是 1..100 之间的整数");
  const text = read(opts.taxonomy), taxonomy = parse(text);
  if (!taxonomy || typeof taxonomy.version !== "string" || !taxonomy.version.trim()) throw Error("taxonomy version 为必填项");
  const snapshot = response(await client.get<SourceSnapshot>(`/api/projects/worker-sources?project=${encodeURIComponent(opts.project)}`));
  const occupant = snapshot.occupant;
  if (!occupant?.session || !occupant.generation || !occupant.nodeId) throw Error("真实分类器占用者不可用");
  const values: ClassificationCandidates["values"] = {classificationType: [], classificationUrgency: [], classificationMaturity: [], classificationConfidence: [], classificationDestination: [], area: [], scopeRef: []};
  for (const [input, output] of [["kind","classificationType"],["urgency","classificationUrgency"],["maturity","classificationMaturity"],["area","area"]] as const) {
    const field = taxonomy.fields?.[input];
    if (typeof field?.question !== "string" || !field.values || Array.isArray(field.values) || typeof field.values !== "object") throw Error(`taxonomy ${input} 的 question/values 不可用`);
    values[output] = Object.keys(field.values);
  }
  values.scopeRef = snapshot.sources.scopes.map(x => x.id);
  values.classificationDestination = [...snapshot.sources.roster.map(x => x.session), "pool"];
  const candidates: ClassificationCandidates = {
    version: hash(JSON.stringify({sourceVersion: snapshot.version, taxonomyHash: hash(text), values})), values,
    duplicateCandidates: snapshot.sources.recent.map(x => ({streamItemId: x.streamItemId, evidenceRef: x.evidenceRef})), relatedRefs: [],
  };
  const query = new URLSearchParams({classifierVersion: opts.classifierVersion, taxonomyVersion: taxonomy.version, evidenceEpoch: opts.evidenceEpoch, limit: opts.limit ?? "20", expectedOccupant: occupant.generation});
  const eligible = response(await client.get<{items: {streamItemId: string}[]; nextAfterSortKey: string | null}>(`/api/projects/eligible?${query}`));
  return {snapshot, candidates, taxonomy: {version: taxonomy.version, source: opts.taxonomy, hash: hash(text), questions: taxonomy.fields}, eligible};
}

/** 单个占用者所属的有界唤醒接收入口。不做自动注册。 */
export async function runProjectWake(client: Client, opts: WakeOptions, read = localText, experiment?: {
  decide: (prepared: Awaited<ReturnType<typeof prepareWorker>>) => WorkerOptions["classify"];
  signal: AbortSignal; shouldStop: () => boolean; timeoutMs: number;
}) {
  const prepared = await prepareWorker(client, opts, read);
  const {snapshot, candidates, taxonomy} = prepared;
  const {session, generation} = snapshot.occupant;
  const suffix = (url: string) => `${url}${url.includes("?") ? "&" : "?"}expectedOccupant=${encodeURIComponent(generation)}`;
  const get = async <T>(url: string): Promise<T> => response(await client.get<T>(suffix(url)));
  const post = async <T>(url: string, body: unknown): Promise<T> => response(await client.post<T>(suffix(url), body));
  const packet = opts.decisions ? JSON.parse(read(opts.decisions)) as {
    candidateSetVersion: string; decisions: {streamItemId: string; bodyHash: string; decision: ClassificationDecision}[];
  } : null;
  if (packet && (!Array.isArray(packet.decisions) || packet.decisions.length > 100 || new Set(packet.decisions.map(x => x.streamItemId)).size !== packet.decisions.length)) throw Error("decisions 最多包含 100 个不重复的流条目 ID");
  if (!experiment && (!packet || packet.candidateSetVersion !== candidates.version)) throw Error("必须提供绑定当前 candidateSetVersion 的新 decisions；尚未开始任何 attempt");
  if (experiment && packet) throw Error("decisions 只能选择一个来源");
  const worker = new StreamClassificationWorker({
    session, classifierVersion: opts.classifierVersion, taxonomyVersion: taxonomy.version, evidenceEpoch: opts.evidenceEpoch,
    candidates, pageSize: Number(opts.limit ?? 20),
    ...(experiment ? {signal: experiment.signal, shouldStop: experiment.shouldStop, requestTimeoutMs: experiment.timeoutMs} : {}),
    leases: {
      evaluateDeadness: () => null, // acquire 走既有的"先评估再获取"事务路径。
      acquire: actor => post("/api/projects/lease/acquire", {classifierSession: actor, evaluateDeadnessFirst: true}),
      requireActiveHolder: (_actor, id) => get(`/api/projects/lease?expectedLeaseId=${encodeURIComponent(id ?? "")}`),
      heartbeat: (id, actor) => post("/api/projects/lease/heartbeat", {leaseId: id, classifierSession: actor}),
    },
    attempts: {
      eligible: input => get(`/api/projects/eligible?${new URLSearchParams(Object.entries(input).filter(([,v]) => v !== undefined).map(([k,v]): [string, string] => [k,String(v)]))}`),
      begin: input => post("/api/projects/attempts/begin", input),
      abstain: input => post(`/api/projects/attempts/${encodeURIComponent(input.attemptId)}/abstain`, input),
      fail: input => post(`/api/projects/attempts/${encodeURIComponent(input.attemptId)}/fail`, input),
    },
    classifier: {classify: input => post("/api/projects/project", input)},
    stream: {getById: id => get(`/api/stream/${encodeURIComponent(id)}`)},
    classify: experiment ? experiment.decide(prepared) : async request => {
      if (snapshot.unavailable.length) return {kind: "abstain", reason: `候选源不可用：${snapshot.unavailable.join("; ")}`};
      if (!packet || packet.candidateSetVersion !== candidates.version) return {kind: "abstain", reason: "该候选快照的 decisions 不可用"};
      const selected = packet.decisions.find(x => x.streamItemId === request.item.streamItemId && x.bodyHash === hash(request.item.body));
      if (!selected) return {kind: "abstain", reason: "该流条目精确字节对应的 decision 不可用"};
      if (selected.decision?.kind === "classify") {
        const labels = selected.decision.labels;
        if (!labels || LABEL_FIELDS.some(field => labels[field] != null && !candidates.values[field].includes(labels[field]!))) return {kind: "abstain", reason: "所选标签候选不可用"};
        if (labels.duplicateOfStreamItemId != null && !candidates.duplicateCandidates.some(x => x.streamItemId === labels.duplicateOfStreamItemId && x.evidenceRef === labels.duplicateEvidenceRef)) return {kind: "abstain", reason: "正向重复证据不可用"};
      }
      return selected.decision;
    },
  } satisfies WorkerOptions);
  const result = await worker.wake();
  // 仅为描述符。由消息请求此入口；它自身从不执行唤醒。
  let wakeRequest: unknown = null;
  // 复制而来的参数向量，绝不拼接 shell 命令。判断权仍归占用者。
  const nextCommand = ["rig", "project", "candidates", "--project", opts.project, "--taxonomy", opts.taxonomy,
    "--classifier-version", opts.classifierVersion, "--evidence-epoch", opts.evidenceEpoch, "--limit", opts.limit ?? "20", "--json"];
  try {
    if (experiment) return {occupant: snapshot.occupant, candidateSetVersion: candidates.version, evidenceEpoch: opts.evidenceEpoch,
      result, nextCommand: null, wakeRequest: null, registered: false, sourceSnapshot: snapshot,
      continuation: "仅前台实验；不自动重试或注册唤醒。再次显式运行前请检查本结果。"};
    const descriptor = worker.wakeRegistration(session, generation);
    descriptor.specYaml = JSON.stringify({target: {session}, message: `以参数向量形式运行 ${JSON.stringify(nextCommand)}，用 zrig stream show 读取确切的合格流条目，然后用相同选项加 --decisions 把绑定到源的 decisions 交给 zrig project wake。只做一次有界唤醒；遵从返回的 nextWakeAt。未经所有者授权不得更改 evidence epoch。`});
    wakeRequest = descriptor;
  } catch { /* 未获取到租约 */ }
  return {occupant: snapshot.occupant, candidateSetVersion: candidates.version, evidenceEpoch: opts.evidenceEpoch,
    result, nextCommand, wakeRequest, registered: false, sourceSnapshot: snapshot};
}
