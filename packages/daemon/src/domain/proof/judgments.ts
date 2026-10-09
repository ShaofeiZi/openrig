import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import YAML from "yaml";
import { parseAddress, resolveAddress } from "../markdown-address.js";
import { extractProofContractSelected, parseLogicalCheckboxes, proofItemIdentity } from "../review/compose.js";
import { validateMissionComposition } from "../lifecycle-manifest.js";
import type { ScopeFsDeps } from "../scope/scope-view-projection.js";

/** 带地址的 Markdown 持有判定；这些视图只会重建，绝不向上游写入。 */
export type JudgmentVerdict = "accept" | "reject" | "withdraw";
export interface Evidence { ref: string; sha256: string }
export interface Judgment {
  version: 1; sequence: number; scope: string; id: string; operationId: string;
  itemId: string; itemRevision: string; policyRevision: string; policySource: string;
  previous: string | null; actor: string; provenance: string; at: string;
  verdict: JudgmentVerdict; reason: string; evidence: Evidence[];
  subject: { kind: "artifact" | "commit" | "patch-equivalent"; ref: string; comparison?: string };
  intent: string;
}
export interface ItemReadiness {
  id: string; text: string; revision: string; index: number; source: { file: string; line: number };
  state: "accepted" | "pending" | "rejected" | "withdrawn" | "unknown";
  reason: string; judgment: Judgment | null;
}
export interface ScopeReadiness {
  configured: boolean; revision: string; state: "ready" | "not-ready" | "unknown" | "legacy";
  history: Array<{ ref: string; id: string; itemId: string; verdict: JudgmentVerdict; previous: string | null }>;
  items: ItemReadiness[]; issues: string[]; policy: { judges: string[]; source: string; revision: string } | null;
  /** 供 S04 attention 消费者使用的输入；不隐含定时器或投递。 */
  attention: { scope: string; revision: string };
}
export interface MissionReadiness {
  revision: string; state: ScopeReadiness["state"]; issues: string[];
  slices: Array<{ scope: string; id: string; readiness: ScopeReadiness; dependsOn: string[]; eligible: boolean | null }>;
  historicalStatus: string | null;
}
export class JudgmentError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const proofFs: ScopeFsDeps = {
  exists: fs.existsSync,
  readFile: p => { try { return fs.readFileSync(p, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } },
  readBytes: p => { try { return fs.readFileSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; } },
  listDir: p => fs.readdirSync(p),
  isDirectory: p => fs.statSync(p).isDirectory(),
};
type Mapping = Record<string, unknown>;
function mapping(value: unknown, source: string): Mapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new JudgmentError("invalid_record", `${source}：应为映射`);
  return value as Mapping;
}
function manifest(io: ScopeFsDeps, file: string): Mapping | null {
  const text = io.readFile(file);
  return text === null ? null : mapping(YAML.parse(text), file);
}
function workspaceOf(dir: string, io: ScopeFsDeps, required = true): string {
  for (let p = path.resolve(dir); ; p = path.dirname(p)) {
    if (io.exists(path.join(p, "project.yaml"))) return p;
    if (path.dirname(p) === p) {
      if (!required) return path.resolve(dir);
      throw new JudgmentError("project_missing", "记录判定前请先定位 project.yaml");
    }
  }
}
function policyOf(dir: string, io: ScopeFsDeps, readManifest = manifest): ScopeReadiness["policy"] {
  const root = workspaceOf(dir, io, false);
  for (let p = path.resolve(dir); ; p = path.dirname(p)) {
    for (const name of ["slice.yaml", "mission.yaml", "project.yaml"]) {
      const file = path.join(p, name), doc = readManifest(io, file);
      if (doc && Object.hasOwn(doc, "proofPolicy")) {
        const policy = mapping(doc.proofPolicy, `${file}: proofPolicy`);
        if (Object.keys(policy).some(k => k !== "judges")) throw new JudgmentError("policy_invalid", `${file}：proofPolicy 只支持 judges`);
        if (!Array.isArray(policy.judges) || !policy.judges.length || policy.judges.some(x => typeof x !== "string" || !x.trim())) throw new JudgmentError("policy_invalid", `${file}：proofPolicy.judges 必须列出获授权 actor`);
        const judges = [...new Set(policy.judges as string[])].sort();
        return { judges, source: file, revision: hash(judges) };
      }
    }
    if (p === root) return null;
  }
}
export type ProofPolicyRead = (dir: string, io: ScopeFsDeps) => ScopeReadiness["policy"];

/** 一次同步读取组合独占此读取器，随后丢弃。仅按绝对路径和精确 I/O provider
 * 复用 policy manifest 输入（包括缺失）。绝不跨请求保留，也不穿过修改操作。
 * 解析对象保持私有；policyOf 每次返回新的 policy/judges。错误仍带原始来源抛出。
 * 这不是原子快照。 */
export function createProofPolicyRead(): ProofPolicyRead {
  const inputs = new WeakMap<ScopeFsDeps, Map<string, Mapping | null>>();
  return (dir, io) => policyOf(dir, io, (provider, file) => {
    let files = inputs.get(provider);
    if (!files) { files = new Map(); inputs.set(provider, files); }
    if (!files.has(file)) files.set(file, manifest(provider, file));
    return files.get(file)!;
  });
}
export function readProofContract(dir: string, io: ScopeFsDeps) {
  const files = { prd: "IMPLEMENTATION-PRD.md", readme: "README.md", spec: "SPEC.md" };
  const contents = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, io.readFile(path.join(dir, file))]));
  const selected = extractProofContractSelected(contents.prd ?? null, contents.readme ?? null, contents.spec ?? null);
  if (!selected.source || !selected.items.length) return [];
  const file = files[selected.source], section = resolveAddress(contents[selected.source]!, ["proof-contract"]);
  const logical = parseLogicalCheckboxes(section.text);
  return selected.items.map((item, index) => {
    const line = section.headerLine + (logical.find(row => row.rawText === item.rawText)?.sourceLine ?? 1);
    return { ...proofItemIdentity(item.rawText), index: index + 1, source: { file, line } };
  });
}

function ledger(dir: string, io: ScopeFsDeps): Judgment[] {
  const home = path.join(dir, "proof", "judgments");
  if (!io.exists(home)) return [];
  const names = io.listDir(home).filter(f => !f.startsWith(".")).sort();
  const receipts: Judgment[] = [];
  for (const name of names) {
    const expected = `${String(receipts.length + 1).padStart(8, "0")}.md`;
    if (name !== expected) throw new JudgmentError("journal_conflict", `${home}：期望 ${expected}，实际发现 ${name}；请检查保留的回执`);
    const raw = io.readFile(path.join(home, name));
    const fm = raw && /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(raw);
    if (!fm) throw new JudgmentError("journal_invalid", `${home}/${name}：判定不完整`);
    const obj = mapping(YAML.parse(fm[1]!), name), { id, ...payload } = obj;
    if (id !== hash(payload) || obj.version !== 1 || obj.sequence !== receipts.length + 1 || typeof obj.itemId !== "string" || typeof obj.itemRevision !== "string" || typeof obj.policyRevision !== "string" || typeof obj.actor !== "string" || typeof obj.operationId !== "string" || typeof obj.intent !== "string" || !["accept", "reject", "withdraw"].includes(String(obj.verdict)) || !Array.isArray(obj.evidence)) throw new JudgmentError("journal_invalid", `${home}/${name}：判定畸形或已变更；请检查历史`);
    const subject = mapping(obj.subject, name);
    if ([obj.scope, obj.itemId, obj.itemRevision, obj.policyRevision, obj.policySource, obj.actor, obj.operationId, obj.intent, obj.reason, obj.provenance, obj.at].some(v => typeof v !== "string" || !v.trim()) || !Number.isFinite(Date.parse(String(obj.at))) || !["artifact", "commit", "patch-equivalent"].includes(String(subject.kind)) || typeof subject.ref !== "string" || !subject.ref.trim() || (subject.comparison !== undefined && typeof subject.comparison !== "string") || obj.evidence.some(e => !e || typeof e !== "object" || typeof e.ref !== "string" || !e.ref || typeof e.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(e.sha256))) throw new JudgmentError("journal_invalid", `${home}/${name}：判定字段畸形`);
    if (receipts.some(r => r.operationId === obj.operationId)) throw new JudgmentError("journal_conflict", `${home}/${name}：操作身份重复`);
    const prior = receipts.filter(r => r.itemId === obj.itemId).at(-1);
    if (obj.previous !== (prior?.id ?? null)) throw new JudgmentError("journal_conflict", `${home}/${name}：修正谱系冲突`);
    receipts.push(obj as unknown as Judgment);
  }
  return receipts;
}
function contained(root: string, target: string): string {
  const base = fs.realpathSync(root), requested = path.resolve(root, target);
  // 解析最近的已存在祖先，使平台别名和符号链接父目录都按真实边界判断，
  // 包括尚未创建的回执叶子。
  let existing = requested;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const full = path.resolve(fs.realpathSync(existing), path.relative(existing, requested));
  if (full !== base && !full.startsWith(base + path.sep)) throw new JudgmentError("path_escape", `路径逃出 ${base}；路径必须留在所选工作区内`);
  return full;
}
export function evidenceAt(root: string, dir: string, ref: string): Evidence {
  if (!ref || typeof ref !== "string") throw new JudgmentError("evidence_required", "请引用项目工作区下可读取的证据");
  const { ref: file, headerPath } = parseAddress(ref);
  const fragment = headerPath.join("/");
  const target = contained(root, path.isAbsolute(file!) ? file! : file!.startsWith("missions/") ? file! : path.resolve(dir, file!));
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new JudgmentError("evidence_missing", `证据不可用：${ref}`);
  const bytes = fs.readFileSync(target);
  let addressed: Buffer | string = bytes;
  if (headerPath.length) {
    try { addressed = resolveAddress(bytes.toString("utf8"), headerPath).text; }
    catch (e) { throw new JudgmentError("evidence_address", (e as Error).message); }
  }
  return { ref: path.relative(fs.realpathSync(root), target).split(path.sep).join("/") + (fragment ? `#${fragment}` : ""), sha256: createHash("sha256").update(addressed).digest("hex") };
}

export function readSliceReadiness(dir: string, io: ScopeFsDeps = proofFs, readPolicy: ProofPolicyRead = policyOf): ScopeReadiness {
  let policy: ScopeReadiness["policy"] = null, receipts: Judgment[] = [], items: ItemReadiness[] = [];
  const issues: string[] = [];
  let policyRead = false;
  try {
    policy = readPolicy(dir, io); policyRead = true;
    receipts = ledger(dir, io);
    const root = workspaceOf(dir, io, false), promises = readProofContract(dir, io);
    if (new Set(promises.map(p => p.id)).size !== promises.length) throw new JudgmentError("item_ambiguous", "条目身份重复；请为不同承诺显式添加 <!-- proof-item: id --> 标记");
    items = promises.map(p => {
      const scope = path.relative(root, dir).split(path.sep).join("/");
      const revision = hash([scope, p.id, p.text, policy?.revision ?? null]);
      const judgment = receipts.filter(r => r.itemId === p.id).at(-1) ?? null;
      let state: ItemReadiness["state"] = "pending", reason = "当前没有可归属的判定";
      if (judgment) {
        if (!policy || judgment.scope !== scope || judgment.itemRevision !== revision || judgment.policyRevision !== policy.revision) { state = "unknown"; reason = "scope、条目或策略已变更；请在当前修订上记录判定"; }
        else if (judgment.verdict !== "accept") { state = judgment.verdict === "reject" ? "rejected" : "withdrawn"; reason = judgment.reason; }
        else if (!policy.judges.includes(judgment.actor)) { state = "unknown"; reason = "判定 actor 不在所选策略内"; }
        else {
          const valid = judgment.evidence.length > 0 && judgment.evidence.every(e => {
            if (!e || typeof e.ref !== "string" || typeof e.sha256 !== "string") return false;
            try {
              const address = parseAddress(e.ref), file = path.resolve(root, address.ref);
              if (io.readBytes) contained(root, file);
              const bytes = io.readBytes ? io.readBytes(file) : io.readFile(file);
              if (bytes === null) return false;
              const addressed = address.headerPath.length ? resolveAddress(typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8"), address.headerPath).text : bytes;
              return createHash("sha256").update(addressed).digest("hex") === e.sha256;
            } catch { return false; }
          });
          state = valid ? "accepted" : "unknown"; reason = valid ? judgment.reason : "证据缺失或已变更；请检查保留的判定";
        }
      }
      return { ...p, revision, state, reason, judgment };
    });
    if (policy && !items.length) issues.push("没有人工编写的 proof contract");
  } catch (e) { issues.push(e instanceof Error ? e.message : String(e)); }
  const configured = policy !== null || io.exists(path.join(dir, "proof", "judgments")) || (!policyRead && issues.length > 0);
  const state = issues.length ? "unknown" : !configured ? "legacy" : items.some(i => i.state === "unknown") ? "unknown" : items.length && items.every(i => i.state === "accepted") ? "ready" : "not-ready";
  const revision = hash([policy?.revision, items, issues]);
  const history = receipts.map(r => ({ ref: `${r.scope}/proof/judgments/${String(r.sequence).padStart(8, "0")}.md`, id: r.id, itemId: r.itemId, verdict: r.verdict, previous: r.previous }));
  return { configured, revision, state, history, items, issues, policy, attention: { scope: dir, revision } };
}

export function resolveProofScope(root: string, scope: string): string {
  const dir = contained(root, scope);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new JudgmentError("scope_missing", "请选择已有 mission 或 slice 目录", 404);
  return dir;
}

export interface JudgeInput {
  scope: string; item: string; verdict: JudgmentVerdict; evidence?: string[];
  subject?: Judgment["subject"]; expectedEvidence?: Evidence[]; reason: string; expectedRevision: string;
  expectedPrevious: string | null; operationId?: string; replace?: boolean;
}
/**
 * 将 slice 条目的可验证 proof 判定记录到 judgments 台账。
 *
 * @param missionsRoot - 用于解析 scope 的工作区根路径。
 * @param input - 判定详情，包括 scope、item、verdict 和 evidence。
 * @param actor - proof 策略授权的判定 actor 标识。
 * @param provenance - 记录在台账中的 attestation 出处字符串。
 * @returns 已记录的判定回执、当前 slice 就绪度和重放状态。
 */
export function recordJudgment(missionsRoot: string, input: JudgeInput, actor: string, provenance: string): { judgment: Judgment; readiness: ScopeReadiness; replayed: boolean } {
  const dir = resolveProofScope(missionsRoot, input.scope), root = workspaceOf(dir, proofFs);
  if (path.basename(path.dirname(dir)) !== "slices") throw new JudgmentError("slice_required", "条目判定属于 slice；更高层结果判定仍是 workflow 决策");
  if (!fs.statSync(dir).isDirectory()) throw new JudgmentError("scope_missing", "请选择 slice 目录");
  const current = readSliceReadiness(dir);
  if (!current.policy) throw new JudgmentError("policy_required", "判定前请在 slice、mission 或 project 中编写 proofPolicy.judges");
  if (!current.policy.judges.includes(actor)) throw new JudgmentError("actor_not_authorized", `${actor} 不是 ${current.policy.source} 授权的 judge`, 403);
  if (current.issues.length) throw new JudgmentError("readiness_unavailable", current.issues.join("; "), 409);
  const item = current.items.find(i => i.id === input.item || String(i.index) === input.item || i.text === input.item);
  if (!item) throw new JudgmentError("item_missing", "请从 zrig proof show 中选择一个当前条目");
  if (!["accept", "reject", "withdraw"].includes(input.verdict) || !input.reason?.trim()) throw new JudgmentError("judgment_invalid", "请提供 accept、reject 或 withdraw，并说明判定原因");
  const evidence = input.evidence?.map(ref => evidenceAt(root, dir, ref)) ?? (input.verdict !== "accept" ? item.judgment?.evidence ?? [] : []);
  if (input.verdict === "accept" && !evidence.length) throw new JudgmentError("evidence_required", "accept 需要可读取证据；仅 capture 或 queue done 都不构成验收");
  let subject = input.subject ?? item.judgment?.subject ?? { kind: "artifact", ref: evidence[0]?.ref ?? item.id };
  if (!["artifact", "commit", "patch-equivalent"].includes(subject.kind) || !subject.ref?.trim()) throw new JudgmentError("subject_invalid", "请指定 artifact、commit 或 patch-equivalent 主体");
  if (subject.kind === "patch-equivalent" && input.verdict === "accept") {
    if (!subject.comparison) throw new JudgmentError("comparison_required", "除结果证据外，patch 等价还需要 --comparison 指向实际比较/采纳回执");
    const comparison = evidenceAt(root, dir, subject.comparison);
    if (!evidence.some(e => e.ref !== comparison.ref)) throw new JudgmentError("comparison_required", "请分别引用结果证据与比较/采纳回执");
    if (!evidence.some(e => e.ref === comparison.ref)) evidence.push(comparison);
    subject = { ...subject, comparison: comparison.ref };
  }
  if (input.expectedEvidence && hash(input.expectedEvidence) !== hash(evidence)) throw new JudgmentError("evidence_conflict", "证据自准备后已变更；判定前请检查当前字节", 409);
  const receipts = ledger(dir, proofFs);
  const intent = hash([item.id, input.expectedRevision, actor, input.verdict, input.reason, evidence, subject]);
  const operationId = input.operationId ?? hash([intent, input.replace ? input.expectedPrevious : null]);
  const priorOperation = receipts.find(r => r.operationId === operationId);
  if (priorOperation) {
    if (priorOperation.intent !== intent) throw new JudgmentError("operation_conflict", "该操作身份已记录不同内容", 409);
    return { judgment: priorOperation, readiness: readSliceReadiness(dir), replayed: true };
  }
  const latest = receipts.filter(r => r.itemId === item.id).at(-1);
  if (input.expectedRevision !== item.revision || input.expectedPrevious !== (latest?.id ?? null)) throw new JudgmentError("revision_conflict", "条目或修正已变更；请检查 zrig proof show 并判定当前证据", 409);
  const payload = { version: 1 as const, scope: path.relative(root, dir).split(path.sep).join("/"), sequence: receipts.length + 1, operationId, itemId: item.id, itemRevision: item.revision, policyRevision: current.policy.revision, policySource: path.relative(root, current.policy.source), previous: latest?.id ?? null, actor, provenance, at: new Date().toISOString(), verdict: input.verdict, reason: input.reason, evidence, subject, intent };
  const judgment: Judgment = { ...payload, id: hash(payload) };
  const home = contained(root, path.join(dir, "proof", "judgments"));
  fs.mkdirSync(home, { recursive: true });
  const temporary = path.join(home, `.write-${randomUUID()}`), target = path.join(home, `${String(payload.sequence).padStart(8, "0")}.md`);
  // 同目录 temp+fsync 遵循 FileWriteService；link 发布而不替换回执。受支持后台服务写入器
  // 同步执行，竞争进程会失去独占发布权。
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, `---\n${YAML.stringify(judgment)}---\n\n${input.reason}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    fs.linkSync(temporary, target);
    const directory = fs.openSync(home, "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new JudgmentError("revision_conflict", "另一个写入方已先提交；请检查当前就绪度", 409);
    throw e;
  } finally { fs.unlinkSync(temporary); }
  return { judgment, readiness: readSliceReadiness(dir), replayed: false };
}

/**
 * 读取 mission composition 并解析成员 slice，以评估 mission 就绪度。
 *
 * @param missionDir - 包含 mission.yaml 的 mission 目录路径。
 * @param readPolicy - 用于确定适用 proof 策略的读取函数。
 * @returns 评估后的 mission 就绪度，包括 revision、state、slices 和问题。
 */
export function readMissionReadiness(missionDir: string, readPolicy: ProofPolicyRead = policyOf): MissionReadiness {
  const issues: string[] = [], slices: MissionReadiness["slices"] = [];
  let historicalStatus: string | null = null;
  try {
    const doc = manifest(proofFs, path.join(missionDir, "mission.yaml"));
    if (!doc) return { revision: hash("legacy"), state: "legacy", slices, issues, historicalStatus };
    const metadata = doc.metadata != null ? mapping(doc.metadata, "mission metadata") : {};
    historicalStatus = typeof metadata.status === "string" ? metadata.status : null;
    const members = validateMissionComposition(doc, path.join(missionDir, "mission.yaml")).filter(m => m.active);
    for (const member of members) {
      const dir = path.dirname(member.path), data = manifest(proofFs, member.path);
      const execution = data?.execution as { depends_on?: unknown } | undefined;
      const depends = execution?.depends_on ?? [];
      if (!Array.isArray(depends) || depends.some(x => typeof x !== "string")) throw new JudgmentError("dependencies_invalid", `${member.path}：execution.depends_on 必须是列表`);
      const id = (data?.metadata as { id?: unknown } | undefined)?.id ?? path.basename(dir);
      if (typeof id !== "string" || !id || slices.some(s => s.id === id)) throw new JudgmentError("dependency_identity", `${member.path}：slice 身份缺失或重复`);
      slices.push({ scope: path.basename(dir), id, readiness: readSliceReadiness(dir, proofFs, readPolicy), dependsOn: depends as string[], eligible: null });
    }
    const memo = new Map<string, boolean | null>();
    const visit = (s: MissionReadiness["slices"][number], visiting = new Set<string>()): boolean | null => {
      if (visiting.has(s.id)) throw new JudgmentError("dependency_cycle", `存在涉及 ${s.scope} 的环`);
      if (memo.has(s.id)) return memo.get(s.id)!;
      const next = new Set(visiting).add(s.id);
      const dependencies = s.dependsOn.map(name => {
        const dep = slices.find(x => x.id === name);
        if (!dep) throw new JudgmentError("dependency_missing", `${s.scope}：未知依赖 ${name}`);
        const upstream = visit(dep, next);
        return upstream === null || ["unknown", "legacy"].includes(dep.readiness.state) ? null : upstream && dep.readiness.state === "ready";
      });
      const eligible = ["unknown", "legacy"].includes(s.readiness.state) || dependencies.includes(null) ? null : dependencies.every(Boolean);
      memo.set(s.id, eligible);
      return eligible;
    };
    for (const s of slices) s.eligible = visit(s);
  } catch (e) { issues.push(e instanceof Error ? e.message : String(e)); for (const s of slices) s.eligible = null; }
  const state = issues.length || slices.some(s => ["unknown", "legacy"].includes(s.readiness.state)) ? "unknown" : slices.length && slices.every(s => s.readiness.state === "ready") ? "ready" : "not-ready";
  return { revision: hash([slices, issues]), state, slices, issues, historicalStatus };
}

export function readProjectReadiness(missionsRoot: string, readPolicy: ProofPolicyRead = policyOf) {
  const missions = fs.readdirSync(missionsRoot).filter(n => fs.statSync(path.join(missionsRoot, n)).isDirectory()).map(name => ({ name, ...readMissionReadiness(contained(missionsRoot, path.join(missionsRoot, name)), readPolicy) }));
  const active = missions.filter(m => ["active", "release-candidate"].includes(m.historicalStatus ?? ""));
  return { revision: hash(active), state: active.length && active.every(m => m.state === "ready") ? "ready" : active.some(m => m.state === "unknown") ? "unknown" : "not-ready", missions, basis: "活动 mission 就绪度；独立的结果判定与发布仍彼此分离" };
}
