import { belongsToProject } from "./workspace/project-catalog.js";
import { inspectGraph } from "./workflow-reconciliation.js";
import { createProofPolicyRead, readMissionReadiness, readProjectReadiness } from "./proof/judgments.js";
import { lifecycleObligations, requiredLifecycleSteps } from "./lifecycle-obligations.js";
import { QueueWakeRepository } from "./queue-wake-repository.js";
// S27（OPR.0.5.6.27）——执行视图：用一个 JSON 文档回答六个执行问题（谁在哪里、顺序、
// 关注旋钮、各层完成度、暂存真实性、并行健康状态），每个字段都在读取时派生。
//
// 本模块遵循的规则（设计契约 DESIGN-execution-view-data-contract）：
// - 只派生，绝不采信人工状态文案：字段不会从人类编写的状态标签复制；易变事实来自数据库、
//   切片 frontmatter、git、statfs 和后台服务自身构建戳，每次调用时读取；无缓存、无调度器。
// - INDETERMINATE 底线：不可达或未配置的来源渲染字符串 "INDETERMINATE" 并说明依据，
//   绝不渲染为 idle/dead/done/false。
// - 阶梯即 schema：完成度由五个命名层级表示（locked/built/reviewed/folded/adopted），
//   不存在单一 "done" 布尔值。
// - 这是投影，不是权威源：每个单元格都携带对应行、产物或命令，距事实源只需一次命令。
//
// 消费的数据约定（随此切片落地）：
// - EC-1：切片 frontmatter 的 `depends_on:`，以及 Territory 分区中的
//   `SOFT-AFTER: [ids] — reason` 行。下方使用精确正则；这是指定机器行，不是散文抓取。
// - EC-2：带 `format:wave-map-v1` tag 的最新队列行携带 fenced ```json 块，结构为
//   {waves:[{id,slices,serialized_order?,review_model?}]}；旋钮来自 frontmatter
//   `approved-spec-dial`。
// - EC-3：派发接力棒正文携带 `worktree_path=<path>` 行；缺失时只能按名称联接，并标记
//   fragile_join。

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import type Database from "better-sqlite3";
import { shellQuote } from "../adapters/shell-quote.js";
import { parseFrontmatter } from "./slices/slice-indexer.js";
import { lastMeaningfulTransition } from "./queue-waiting.js";
import { derivePickup } from "./queue-pickup.js";
import { resolveWorkNodeDirs } from "./current-work.js";
import { resolveLegacyTopologyRigsRoot } from "./user-settings/settings-store.js";
import { BUILD_INFO, type BuildInfo } from "../build-info.js";
import { validateMissionComposition } from "./lifecycle-manifest.js";

export const INDETERMINATE = "INDETERMINATE" as const;
export type Indeterminate = typeof INDETERMINATE;

export interface ExecutionViewDeps {
  db: Database.Database;
  /** 任务目标根目录（workspace.slices_root）。为 null 时，文件系统派生分区降为
   * INDETERMINATE；队列派生分区仍正常返回。 */
  slicesRoot: () => string | null;
  /** 唯一活动事实源（S19 锁定契约）：SeatActivityService 按席位仲裁后的读取，也是 zrig ps、
   * 节点清单和暂存查询消费的同一来源。词汇（working | idle-at-prompt | unknown）及独立的
   * needsInput {count, reason} 原样透传，本模块绝不重新仲裁。sessions.status 和平行的
   * AgentActivityStore 摄取不能替代它（真实样本中工作泳道被标为 `superseded`）。缺失时降为
   * INDETERMINATE。 */
  seatActivity?: {
    getSeatStateBySession(sessionName: string): {
      activity: "working" | "idle-at-prompt" | "unknown";
      needsInput: { count: number; reason: string | null };
      decidedBy: string | null;
      changedAt: string;
    } | null;
  };
  now?: () => Date;
  buildInfo?: BuildInfo;
  /** 测试可注入；签名是 Node execFileSync 的同一子集。 */
  exec?: (cmd: string, args: string[]) => string;
  /** 扫描评审产物时可注入的工作组根目录（用于测试）。 */
  rigsRoot?: () => string;
}

interface QueueRowLite {
  summary?: string | null;
  qitem_id: string;
  source_session: string;
  destination_session: string;
  state: string;
  tags: string | null;
  body: string | null;
  claimed_at: string | null;
  last_heartbeat: string | null;
  blocked_on: string | null;
  ts_created: string;
  ts_updated: string;
  post_claim_motion?: number;
}

function defaultExec(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
}

/** EC-3——指定机器行，必须精确匹配。 */
const WORKTREE_LINE = /^worktree_path=(\S+)$/m;
/** EC-1——指定软边机器行，必须精确匹配。 */
const SOFT_AFTER_LINE = /^SOFT-AFTER:\s*\[([^\]]*)\]/m;
/** EC-2——wave-map 行正文中的 fenced JSON 块。 */
const WAVE_MAP_BLOCK = /```json\s*\n([\s\S]*?)\n```/;

/** frontmatter 值由 parseFrontmatter 以原始字符串形式返回；EC-1 写入内联 JSON 数组
 *（`depends_on: ["OPR..."]`），因此在此解析该结构。 */
function parseArrayField(v: unknown): string[] | Indeterminate {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string" && v.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(v.trim());
      return Array.isArray(parsed) ? parsed.map(String) : INDETERMINATE;
    } catch {
      return INDETERMINATE;
    }
  }
  return INDETERMINATE;
}

const SLICE_TAG = /^slice:(.+)$/;
const CANDIDATE_TAG = /^candidate:(.+)$/;

/** 候选身份是 commit，而不是普通字符串。生产数据包含混合形式：缩写 tag（`dced9edb0`）、
 * 完整 40 位十六进制产物字段，以及带注释字段（`dced9edb0 (exact tip over base …)`）。
 * 提取开头的十六进制 token；不含 token 的值视为格式错误并从底线中排除，绝不匹配。 */
const SHA_TOKEN = /^([0-9a-fA-F]{7,40})(?:\b|$)/;
function extractShaToken(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.trim().match(SHA_TOKEN);
  return m?.[1] ? m[1].toLowerCase() : null;
}

/** 通过仓库上下文将可能缩写的 SHA token 解析为完整 commit ID。歧义或无法解析时返回
 * null；绝不把原始前缀字符串相等视为 commit 身份相等。 */
function resolveCommit(
  exec: (cmd: string, args: string[]) => string,
  repoCtx: string,
  token: string,
  cache: Map<string, string | null>,
): string | null {
  if (cache.has(token)) return cache.get(token) ?? null;
  let full: string | null = null;
  try {
    full = exec("git", ["-C", repoCtx, "rev-parse", "--verify", `${token}^{commit}`]).toLowerCase();
  } catch {
    full = null; // 对象存储中歧义、未知或格式错误——如实降到底线。
  }
  cache.set(token, full);
  return full;
}

/** 按数字比较 release 任务目标目录名（release-0.5.10 > release-0.5.6）。 */
function compareReleaseDirs(a: string, b: string): number {
  const nums = (s: string) => (s.match(/\d+/g) ?? []).map(Number);
  const na = nums(a);
  const nb = nums(b);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? -1) - (nb[i] ?? -1);
    if (d !== 0) return d;
  }
  return a.localeCompare(b);
}

function missionReferences(missionsRoot: string | null, mission: string): string[] {
  const references = new Set([mission]);
  if (!missionsRoot) return [...references];
  try {
    const fm = parseFrontmatter(fs.readFileSync(path.join(missionsRoot, mission, "SPEC.md"), "utf8"));
    if (typeof fm["id"] === "string") references.add(fm["id"] as string);
  } catch {
    // 任务目标 SPEC 缺失是有效旧状态；目录名仍用于绑定。
  }
  return [...references];
}

interface SliceFacts {
  dir: string;
  specPath: string;
  id: string | Indeterminate;
  frontmatter: Record<string, unknown>;
  body: string;
}

function readMissionSlices(missionsRoot: string, mission: string): SliceFacts[] {
  const slicesDir = path.join(missionsRoot, mission, "slices");
  let entries: string[];
  try {
    entries = fs.readdirSync(slicesDir);
  } catch {
    return [];
  }
  const out: SliceFacts[] = [];
  for (const dir of entries.sort()) {
    const specPath = path.join(slicesDir, dir, "SPEC.md");
    let raw: string;
    try {
      raw = fs.readFileSync(specPath, "utf8");
    } catch {
      continue;
    }
    const fm = parseFrontmatter(raw);
    out.push({
      dir,
      specPath,
      id: typeof fm["id"] === "string" ? (fm["id"] as string) : INDETERMINATE,
      frontmatter: fm,
      body: raw.replace(/^---\n[\s\S]*?\n---\n?/, ""),
    });
  }
  return out;
}

/** 查找依赖 ID 的切片事实；任务目标外依赖按 ID 前缀解析到各自 release 目录
 *（OPR.0.5.5.x → release-0.5.5）。 */
function resolveDep(
  depId: string,
  current: SliceFacts[],
  missionsRoot: string | null,
  cache: Map<string, SliceFacts | null>,
): SliceFacts | null {
  const inMission = current.find((s) => s.id === depId);
  if (inMission) return inMission;
  if (cache.has(depId)) return cache.get(depId) ?? null;
  let found: SliceFacts | null = null;
  const m = depId.match(/^OPR\.(\d+\.\d+\.\d+)\.\d+$/);
  if (m && missionsRoot) {
    const releaseDir = `release-${m[1]}`;
    for (const s of readMissionSlices(missionsRoot, releaseDir)) {
      if (s.id === depId) {
        found = s;
        break;
      }
    }
  }
  cache.set(depId, found);
  return found;
}

interface WaveMapData {
  rowId: string | Indeterminate;
  waves: { id: string; slices: string[]; serialized_order?: string[]; review_model?: string }[];
}

interface ArrangementSlice {
  plannedOwners: Array<{ component: string; owner: string; source: string }>;
  path: string;
  order: number;
  wave?: string;
  reviewModel?: string;
  dependsOn?: string[];
}

type ArrangementData =
  | { state: "missing"; missionPath: string }
  | { state: "malformed"; missionPath: string; warning: string }
  | {
      state: "valid";
      missionPath: string;
      byId: Map<string, ArrangementSlice>;
      byDir: Map<string, ArrangementSlice>;
      guidance: Array<{ label: string; text: string; source: string; wave?: string }>;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasTable(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table));
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  if (!hasTable(db, table)) return false;
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => (row as { name?: string }).name === column);
}

function lifecycleProjectAction(input: {
  instanceId: string;
  packetId: string;
  owner: string;
  acceptance: Record<string, unknown> | null;
  receiptRequired?: boolean;
}): string {
  const base = `zrig workflow project --instance ${input.instanceId} --current-packet ${input.packetId} --exit <handoff|waiting|done|failed> --actor-session ${input.owner}${input.receiptRequired ? " --evidence-ref <agent-judged-receipt>" : ""}`;
  if (!input.acceptance) return base;
  const verdicts = Array.isArray(input.acceptance["verdicts"])
    ? input.acceptance["verdicts"].filter((value): value is string => typeof value === "string")
    : [];
  const verdict = verdicts.length === 1 ? verdicts[0]! : `<${verdicts.join("|")}>`;
  return `${base} --acceptance-candidate ${shellQuote(String(input.acceptance["candidate"]))} --acceptance-verdict ${shellQuote(verdict)} --acceptance-evidence-ref ${shellQuote(String(input.acceptance["evidence_ref"]))}`;
}

/**
 * 既有执行视图的 S06 生命周期投影。可变的所有者、队列状态和阻塞事实在读取时从
 * queue_items 联接；lifecycle_binding_json 只携带身份/来源信息。旧数据库没有迁移 079
 * 列，因此如实返回空列表。
 */
function readLifecycleExecutions(db: Database.Database, mission: string, project?: string): Array<Record<string, unknown>> {
  if (!hasColumn(db, "workflow_instances", "lifecycle_binding_json")) return [];
  const rows = db.prepare(
    `SELECT wi.*, ws.spec_json
       FROM workflow_instances wi
       LEFT JOIN workflow_specs ws
         ON ws.name = wi.workflow_name AND ws.version = wi.workflow_version
      WHERE wi.lifecycle_binding_json IS NOT NULL
      ORDER BY wi.created_at, wi.instance_id`,
  ).all() as Array<Record<string, unknown>>;
  const hasBindings = hasTable(db, "workflow_frontier_bindings");
  const hasFailures = hasTable(db, "workflow_failure_occurrences");
  const wakes = new QueueWakeRepository(db);
  const output: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const binding = parseJsonRecord(row["lifecycle_binding_json"]);
    const identity = isRecord(binding["identity"]) ? binding["identity"] as Record<string, unknown> : {};
    if (identity["mission"] !== mission || (project && identity["project"] !== project)) continue;
    const instanceId = String(row["instance_id"]);
    const frontier = parseJsonStringList(row["current_frontier_json"]);
    const specRoot = parseJsonRecord(row["spec_json"]);
    const steps = Array.isArray(specRoot["steps"])
      ? (specRoot["steps"] as unknown[]).filter(isRecord)
      : [];
    const unknowns: string[] = [];
    const packets = frontier.map((packetId) => {
      const matches = hasBindings
        ? db.prepare(`SELECT * FROM workflow_frontier_bindings WHERE instance_id = ? AND packet_id = ?`).all(instanceId, packetId) as Array<Record<string, unknown>>
        : [];
      const packet = db.prepare(
        `SELECT * FROM queue_items WHERE qitem_id = ?`,
      ).get(packetId) as Record<string, unknown> | undefined;
      const transition = hasTable(db, "queue_transitions") ? db.prepare(
        `SELECT ts, state, transition_note, actor_session FROM queue_transitions
          WHERE qitem_id = ? ORDER BY transition_id DESC LIMIT 1`,
      ).get(packetId) ?? null : null;
      const wake = wakes.getStatus(packetId);
      const blocker = typeof packet?.blocked_on === "string" ? db.prepare(
        `SELECT qitem_id, summary, destination_session, state, evidence_ref FROM queue_items WHERE qitem_id = ?`,
      ).get(packet.blocked_on) ?? null : null;
      const schedule = wake && wake.kind !== "blocker" && hasTable(db, "watchdog_jobs") ? db.prepare(
        `SELECT policy, interval_seconds, last_evaluation_at FROM watchdog_jobs WHERE job_id = ?`,
      ).get(wake.ref) ?? null : null;
      if (matches.length !== 1) unknowns.push(`前沿包 ${packetId} 有 ${matches.length} 个步骤绑定`);
      if (!packet) unknowns.push(`前沿包 ${packetId} 没有队列行`);
      const stepId = matches.length === 1 ? String(matches[0]!["step_id"]) : null;
      const step = stepId ? steps.find((candidate) => candidate["id"] === stepId) : undefined;
      const acceptance = step && isRecord(step["acceptance"]) ? step["acceptance"] : null;
      return {
        packet_id: packetId,
        step_id: stepId ?? INDETERMINATE,
        owner: packet?.destination_session ?? INDETERMINATE,
        queue_state: packet?.state ?? INDETERMINATE,
        blocked_on: packet?.blocked_on ?? null,
        blocker,
        summary: packet?.summary ?? null,
        evidence_ref: packet?.evidence_ref ?? null,
        objective: step?.["objective"] ?? null,
        latest_transition: transition,
        wake,
        wake_schedule: schedule,
        depends_on: step && Array.isArray(step["depends_on"]) ? step["depends_on"] : [],
        gate: step && isRecord(step["gate"]) ? step["gate"] : null,
        acceptance,
        targeted_action: matches.length === 1 && packet
          ? lifecycleProjectAction({ instanceId, packetId, owner: String(packet.destination_session), acceptance, receiptRequired: stepId !== null && requiredLifecycleSteps(binding).includes(stepId) })
          : INDETERMINATE,
      };
    });
    const failures = hasFailures
      ? (db.prepare(
          `SELECT occurrence_id, step_id, failure_reason, status, redrive_packet_id, failed_at, resolved_at
             FROM workflow_failure_occurrences WHERE instance_id = ? ORDER BY failed_at, occurrence_id`,
        ).all(instanceId) as Array<Record<string, unknown>>).map((failure) => ({
          occurrence_id: failure["occurrence_id"],
          step_id: failure["step_id"],
          status: failure["status"],
          failure_reason: failure["failure_reason"],
          redrive_packet_id: failure["redrive_packet_id"],
          failed_at: failure["failed_at"],
          resolved_at: failure["resolved_at"],
          targeted_action:
            failure["status"] === "unresolved" &&
            row["status"] !== "completed" &&
            row["status"] !== "aborted"
            ? `zrig workflow resume ${instanceId} --occurrence ${String(failure["occurrence_id"])} --actor-session <you>`
            : null,
        }))
      : [];
    output.push({
      instance_id: instanceId,
      workflow_name: row["workflow_name"],
      workflow_version: row["workflow_version"],
      description: specRoot["description"] ?? null,
      steps: steps.map((step) => ({ id: step["id"], objective: step["objective"] ?? null, next_hop: step["next_hop"] ?? null })),
      status: row["status"],
      operation_key: row["lifecycle_operation_key"],
      compiled_input_digest: row["compiled_input_digest"],
      identity,
      sources: Array.isArray(binding["sources"]) ? binding["sources"] : [],
      dependencies: Array.isArray(binding["dependencies"]) ? binding["dependencies"] : [],
      graph_source: binding["graphSource"] ?? null,
      reconciliation: inspectGraph(db, instanceId),
      boundary_obligations: lifecycleObligations(db, instanceId, binding,
        steps.filter((step) => typeof step["id"] === "string").map((step) => ({ id: String(step["id"]) })), frontier),
      frontier_packets: packets,
      failure_occurrences: failures,
      unknowns,
    });
  }
  return output;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonStringList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}

/** manifest arrangement 可选。缺失时使用兼容回退；格式错误时使用同一回退，并在
 * `sources` 中增加一个明确警告单元格。有效 manifest 是顺序、wave 和依赖的权威来源。 */
function readArrangement(missionsRoot: string, mission: string, slices: SliceFacts[]): ArrangementData {
  const missionRoot = path.join(missionsRoot, mission);
  const missionPath = path.join(missionRoot, "mission.yaml");
  if (!fs.existsSync(missionPath)) return { state: "missing", missionPath };
  try {
    const manifest = parseYaml(fs.readFileSync(missionPath, "utf8")) as unknown;
    if (!isRecord(manifest)) throw new Error("根节点不是映射");
    const compositionMembers = validateMissionComposition(manifest, missionPath);
    const waveReview = new Map<string, string>();
    const waveBySlice = new Map<string, string>();
    const guidance: Array<{ label: string; text: string; source: string; wave?: string }> = [];
    const addGuidance = (label: string, value: unknown, field: string, wave?: string) => {
      if (typeof value === "string" && value.trim()) guidance.push({
        label, text: value.trim().replace(/\s+/g, " "), source: `${missionPath}#arrangement.${field}`,
        ...(wave ? { wave } : {}),
      });
    };
    const arrangement = manifest["arrangement"];
    if (isRecord(arrangement)) for (const [field, label, key] of [
      ["source", "集成决策", "rule"],
      ["planning_posture", "规划姿态", "rule"],
      ["execution_posture", "执行姿态", "parallelism"],
      ["integration_exit", "共享验收", "rule"],
    ] as const) {
      const value = arrangement[field];
      if (isRecord(value)) addGuidance(label, value[key], `${field}.${key}`);
    }
    if (isRecord(arrangement) && arrangement["waves"] != null) {
      if (!Array.isArray(arrangement["waves"])) throw new Error("arrangement.waves 不是列表");
      for (const [index, rawWave] of arrangement["waves"].entries()) {
        if (!isRecord(rawWave) || typeof rawWave["id"] !== "string") {
          throw new Error("arrangement.waves 包含无效条目");
        }
        let waveSlices: unknown[];
        if (Array.isArray(rawWave["slices"])) {
          waveSlices = rawWave["slices"];
        } else if (isRecord(rawWave["lanes"])) {
          const lanes = Object.values(rawWave["lanes"]);
          if (lanes.some((value) => !Array.isArray(value))) throw new Error("arrangement.waves 中的 lanes 不是列表");
          waveSlices = lanes.flatMap((value) => value as unknown[]);
        } else {
          throw new Error("arrangement.waves 条目既没有 slices 也没有 lanes");
        }
        if (waveSlices.some((value) => typeof value !== "string")) {
          throw new Error("arrangement.waves 包含非字符串切片 ID");
        }
        for (const sliceId of waveSlices as string[]) waveBySlice.set(sliceId, rawWave["id"]);
        if (typeof rawWave["review_model"] === "string") waveReview.set(rawWave["id"], rawWave["review_model"]);
        for (const [key, label] of [["admission", "准入"], ["review", "评审"], ["exit", "退出"]] as const)
          addGuidance(label, rawWave[key], `waves[${index}].${key}`, rawWave["id"]);
      }
    }
    const byId = new Map<string, ArrangementSlice>();
    const byDir = new Map<string, ArrangementSlice>();
    for (const member of compositionMembers) {
      if (!member.active) continue;
      const ref = member.ref;
      const resolved = member.path;
      if (path.basename(resolved) !== "slice.yaml") throw new Error(`切片引用必须指向 slice.yaml：${ref}`);
      const relative = path.relative(fs.realpathSync(path.join(missionRoot, "slices")), resolved);
      const dir = relative.split(path.sep)[0];
      if (!dir || dir === "..") throw new Error(`切片引用位于 slices/ 之外：${ref}`);
      const sliceManifest = parseYaml(fs.readFileSync(resolved, "utf8")) as unknown;
      if (!isRecord(sliceManifest)) throw new Error(`${ref} 的根节点不是映射`);
      const execution = sliceManifest["execution"];
      if (execution != null && !isRecord(execution)) throw new Error(`${ref} 的 execution 不是映射`);
      const dependsRaw = isRecord(execution) ? execution["depends_on"] : undefined;
      if (dependsRaw != null && (!Array.isArray(dependsRaw) || dependsRaw.some((v) => typeof v !== "string"))) {
        throw new Error(`${ref} 的 execution.depends_on 不是字符串列表`);
      }
      const facts = slices.find((slice) => slice.dir === dir);
      const wave = isRecord(execution) && typeof execution["wave"] === "string"
        ? execution["wave"]
        : facts && facts.id !== INDETERMINATE
          ? waveBySlice.get(facts.id)
          : undefined;
      const entry: ArrangementSlice = {
        plannedOwners: (() => {
          const sdlc = sliceManifest["sdlc"];
          const components = isRecord(sdlc) ? sdlc["components"] : null;
          return Array.isArray(components) ? components.flatMap((component, index) =>
            isRecord(component) && typeof component["id"] === "string" && typeof component["owner"] === "string"
              ? [{ component: component["id"], owner: component["owner"], source: `${resolved}#sdlc.components[${index}].owner` }] : []) : [];
        })(),
        path: resolved,
        order: member.order,
        ...(wave ? { wave } : {}),
        ...(wave && waveReview.has(wave) ? { reviewModel: waveReview.get(wave)! } : {}),
        ...(dependsRaw ? { dependsOn: dependsRaw as string[] } : {}),
      };
      byDir.set(dir, entry);
      if (facts && facts.id !== INDETERMINATE) byId.set(facts.id, entry);
    }
    return { state: "valid", missionPath, byId, byDir, guidance };
  } catch (err) {
    return {
      state: "malformed",
      missionPath,
      warning: err instanceof Error ? err.message : String(err),
    };
  }
}

function readWaveMap(db: Database.Database, missions: string[], project?: string): WaveMapData {
  const missionWhere = missions.map(() => "tags LIKE ?").join(" OR ");
  const row = db
    .prepare(
      `SELECT qitem_id, body, tags FROM queue_items
        WHERE tags LIKE '%format:wave-map-v1%' AND (${missionWhere})
        ORDER BY ts_created DESC`,
    )
    .all(...missions.map((mission) => `%mission:${mission}%`)) as Array<{ qitem_id: string; body: string | null; tags: string | null }>;
  const selectedRow = row.find(r => !project || belongsToProject(r.tags, project));
  if (!selectedRow?.body) return { rowId: INDETERMINATE, waves: [] };
  const block = selectedRow.body.match(WAVE_MAP_BLOCK);
  if (!block) return { rowId: INDETERMINATE, waves: [] };
  try {
    const parsed = JSON.parse(block[1] ?? "");
    if (parsed?.format !== "wave-map-v1" || !Array.isArray(parsed.waves)) {
      return { rowId: INDETERMINATE, waves: [] };
    }
    return { rowId: selectedRow.qitem_id, waves: parsed.waves };
  } catch {
    return { rowId: INDETERMINATE, waves: [] };
  }
}

interface ReviewArtifactFact {
  path: string;
  verdict: string;
  candidateSha: string | null;
  artifactType: string | null;
}

/** 扫描 rigs/<rig>/state/review… 目录，查找命名此切片的评审产物。根目录解析遵循已发布的
 * shared-docs 先例。 */
function scanReviewArtifacts(rigsRoot: string, sliceDirOrId: string[]): ReviewArtifactFact[] | Indeterminate {
  let rigs: string[];
  try {
    rigs = fs.readdirSync(rigsRoot);
  } catch {
    return INDETERMINATE;
  }
  const out: ReviewArtifactFact[] = [];
  for (const rig of rigs) {
    const stateDir = path.join(rigsRoot, rig, "state");
    let stateEntries: string[];
    try {
      stateEntries = fs.readdirSync(stateDir);
    } catch {
      continue;
    }
    for (const entry of stateEntries.filter((e) => e.startsWith("review"))) {
      const dir = path.join(stateDir, entry);
      let files: string[];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
      } catch {
        continue;
      }
      for (const f of files) {
        let raw: string;
        try {
          raw = fs.readFileSync(path.join(dir, f), "utf8");
        } catch {
          continue;
        }
        const fm = parseFrontmatter(raw);
        const sliceVal = typeof fm["slice"] === "string" ? (fm["slice"] as string) : null;
        if (!sliceVal || !sliceDirOrId.includes(sliceVal)) continue;
        out.push({
          path: path.join(dir, f),
          verdict: typeof fm["verdict"] === "string" ? (fm["verdict"] as string) : INDETERMINATE,
          candidateSha: typeof fm["candidate_sha"] === "string" ? (fm["candidate_sha"] as string) : null,
          artifactType: typeof fm["artifact_type"] === "string" ? (fm["artifact_type"] as string) : null,
        });
      }
    }
  }
  return out;
}

type Rung =
  | { value: boolean; basis: string }
  | { value: Indeterminate; basis: string };

function gitAncestor(exec: ExecutionViewDeps["exec"], repoCtx: string, sha: string, ref: string): Rung {
  const run = exec ?? defaultExec;
  try {
    run("git", ["-C", repoCtx, "merge-base", "--is-ancestor", sha, ref]);
    return { value: true, basis: `git -C ${repoCtx} merge-base --is-ancestor ${sha} ${ref} (exit 0)` };
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 1) {
      return { value: false, basis: `git -C ${repoCtx} merge-base --is-ancestor ${sha} ${ref} (exit 1)` };
    }
    return { value: INDETERMINATE, basis: `${repoCtx} 中的 merge-base 失败：${(err as Error).message?.slice(0, 120)}` };
  }
}

export function buildExecutionView(deps: ExecutionViewDeps, opts?: { mission?: string; rig?: string; project?: string }): Record<string, unknown> {
  const now = deps.now ?? (() => new Date());
  const exec = deps.exec ?? defaultExec;
  const buildInfo = deps.buildInfo ?? BUILD_INFO;
  const derivedAt = now().toISOString();
  const asof = () => now().toISOString();

  const missionsRoot = deps.slicesRoot();

  // 默认任务目标：看板上最新、真实进行中的任务目标。TUI 在自身尚无任务目标状态时会发起
  // 无 mission 请求；若按字典序选择最新目录，可能显示计划中的未来 release，而不是人们
  // 实际执行的任务目标。显式 `?mission=` 仍优先，历史上的最新目录行为保留为回退。
  let mission: string | Indeterminate = opts?.mission ?? INDETERMINATE;
  if (mission !== INDETERMINATE && missionsRoot) {
    const matches = resolveWorkNodeDirs(missionsRoot, mission);
    if (matches.length === 1) mission = matches[0]!.dir;
  }
  if (mission === INDETERMINATE && missionsRoot) {
    const active = deps.db
      .prepare(`SELECT tags, body FROM queue_items WHERE state = 'in-progress' ORDER BY ts_updated DESC`)
      .all() as Array<{ tags: string | null; body: string | null }>;
    for (const row of active) {
      if (opts?.project && !belongsToProject(row.tags, opts.project)) continue;
      const tag = parseTags(row.tags).find((value) => value.startsWith("mission:"));
      // 规范 tag 优先；约定的交接行使旧版或仅正文的接力棒仍然可见。
      const bodyMissions = [...new Set(
        [...(row.body?.matchAll(/^Mission:[ \t]+(\S+)[ \t]*$/gm) ?? [])].map((match) => match[1]!),
      )];
      const candidate = tag?.slice("mission:".length) ?? (bodyMissions.length === 1 ? bodyMissions[0] : undefined);
      const matches = candidate ? resolveWorkNodeDirs(missionsRoot, candidate) : [];
      if (matches.length === 1) {
        mission = matches[0]!.dir;
        break;
      }
    }
  }
  if (mission === INDETERMINATE && missionsRoot) {
    try {
      const releases = fs.readdirSync(missionsRoot).filter((d) => /^release-\d/.test(d));
      const newest = releases.sort(compareReleaseDirs)[releases.length - 1];
      if (newest) mission = newest;
    } catch {
      /* 保持 INDETERMINATE。 */
    }
  }

  const slices = missionsRoot && mission !== INDETERMINATE ? readMissionSlices(missionsRoot, mission) : [];
  const sliceIds = slices.map((s) => s.id).filter((x): x is string => x !== INDETERMINATE);
  const depCache = new Map<string, SliceFacts | null>();

  // ---- 绑定到此任务目标的队列行（按绑定规则，由 tag 或正文提及决定）----
  const missionLikes = mission === INDETERMINATE
    ? ["%"]
    : missionReferences(missionsRoot, mission).map((reference) => `%${reference}%`);
  const missionWhere = missionLikes.map(() => "(tags LIKE ? OR body LIKE ?)").join(" OR ");
  const candidateRows = deps.db
    .prepare(
      `SELECT qitem_id, source_session, destination_session, state, tags, body, summary, claimed_at,
              last_heartbeat, blocked_on, ts_created, ts_updated,
              (SELECT COUNT(*) FROM queue_transitions t
                 WHERE t.qitem_id = queue_items.qitem_id
                   AND t.ts > queue_items.claimed_at
                   AND t.transition_note IS NOT 'claimed') AS post_claim_motion
         FROM queue_items
        WHERE (${missionWhere})`,
    )
    .all(...missionLikes.flatMap((like) => [like, like])) as QueueRowLite[];

  const rows = candidateRows.filter(row => !opts?.project || belongsToProject(row.tags, opts.project));

  const sliceOfRow = (r: QueueRowLite): string | null => {
    for (const t of parseTags(r.tags)) {
      const m = t.match(SLICE_TAG);
      if (m?.[1]) return m[1];
    }
    const bodySlices = [...new Set(
      [...(r.body?.matchAll(/^Slice:[ \t]+(\S+)[ \t]*$/gm) ?? [])].map((match) => match[1]!),
    )];
    return bodySlices.length === 1 ? bodySlices[0]! : null;
  };

  // ---- Q1：谁在何处处理什么 ----
  const lanes: Record<string, unknown>[] = [];
  // 阶梯 git 分支的仓库上下文：绑定到此任务目标的任意行所携带的第一个可达
  // worktree_path（各 worktree 共享仓库 refs）。下方优先尝试进行中泳道；借助此回退扫描，
  // 一条历史 EC-3 行就足以让 folded 可派生。
  let repoCtx: string | null = null;
  for (const r of rows) {
    const m = r.body?.match(WORKTREE_LINE);
    if (!m?.[1]) continue;
    try {
      exec("git", ["-C", m[1], "rev-parse", "--git-dir"]);
      repoCtx = m[1];
      break;
    } catch {
      /* 候选不可达——继续扫描。 */
    }
  }
  for (const r of rows.filter((r) => r.state === "in-progress")) {
    const slice = sliceOfRow(r);
    if (!slice) continue;
    const wtMatch = r.body?.match(WORKTREE_LINE);
    let worktreePath: string | Indeterminate = INDETERMINATE;
    let branch: string | Indeterminate = INDETERMINATE;
    let headSha: string | Indeterminate = INDETERMINATE;
    let fragileJoin = false;
    let joinBasis: string;
    if (wtMatch?.[1]) {
      worktreePath = wtMatch[1];
      joinBasis = "行正文中的 EC-3 worktree_path 字段";
      try {
        branch = exec("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"]);
        headSha = exec("git", ["-C", worktreePath, "rev-parse", "HEAD"]);
        if (!repoCtx) repoCtx = worktreePath;
      } catch {
        branch = INDETERMINATE;
        headSha = INDETERMINATE;
        joinBasis += "（读取时路径不可达）";
      }
    } else {
      fragileJoin = true;
      joinBasis = "仅按行/分支名称联接（缺少 EC-3 字段——旧版接力棒）";
    }
    const arbitrated = deps.seatActivity?.getSeatStateBySession(r.destination_session) ?? null;
    const pickup = derivePickup({
      state: r.state,
      lastMeaningfulAt: lastMeaningfulTransition(deps.db, r.qitem_id)?.at,
      activity: arbitrated?.activity, needsInput: arbitrated?.needsInput.count,
      claimedAt: r.claimed_at,
      lastHeartbeat: r.last_heartbeat,
      postClaimMotionCount: Number(r.post_claim_motion ?? 0),
      now: now(),
    });
    lanes.push({
      qitem_id: r.qitem_id,
      slice,
      seat: r.destination_session,
      worktree_path: worktreePath,
      branch,
      head_sha: headSha,
      fragile_join: fragileJoin,
      join_basis: joinBasis,
      activity: arbitrated
        ? {
            activity: arbitrated.activity,
            needs_input: arbitrated.needsInput,
            decided_by: arbitrated.decidedBy,
            changed_at: arbitrated.changedAt,
            source: "SeatActivityService 仲裁的席位状态（唯一事实源；状态词汇原样透传）",
          }
        : {
            activity: INDETERMINATE,
            basis: deps.seatActivity ? "此席位没有仲裁状态" : "此依赖集合未接入 seat-activity 事实源",
            source: "SeatActivityService 仲裁的席位状态（无结果时降为 INDETERMINATE，绝非 idle/dead）",
          },
      pickup,
      source: { qitem_id: r.qitem_id },
    });
  }

  // ---- arrangement 权威来源：mission/slice YAML，并以旧版 EC-2 回退 ----
  const waveMap = mission === INDETERMINATE
    ? { rowId: INDETERMINATE as Indeterminate, waves: [] }
    : readWaveMap(deps.db, missionReferences(missionsRoot, mission), opts?.project);
  const arrangement = missionsRoot && mission !== INDETERMINATE
    ? readArrangement(missionsRoot, mission, slices)
    : null;
  const lifecycleExecutions = mission === INDETERMINATE ? [] : readLifecycleExecutions(deps.db, mission, opts?.project);
  const arrangementSlice = (id: string, dir?: string): ArrangementSlice | null => {
    if (arrangement?.state !== "valid") return null;
    return arrangement.byId.get(id) ?? (dir ? arrangement.byDir.get(dir) : undefined) ?? null;
  };
  const waveOfSlice = (id: string): { wave: string; rank: number; review_model?: string } | null => {
    if (arrangement?.state === "valid") {
      const facts = slices.find((slice) => slice.id === id);
      const item = arrangementSlice(id, facts?.dir);
      if (!item?.wave) return null;
      return {
        wave: item.wave,
        rank: item.order,
        ...(item.reviewModel ? { review_model: item.reviewModel } : {}),
      };
    }
    for (let wi = 0; wi < waveMap.waves.length; wi++) {
      const w = waveMap.waves[wi];
      if (!w) continue;
      const order = w.serialized_order ?? w.slices;
      const si = order.indexOf(id);
      if (si >= 0 || w.slices.includes(id)) {
        return { wave: w.id, rank: wi * 100 + (si >= 0 ? si : 50), review_model: w.review_model };
      }
    }
    return null;
  };

  // ---- Q4 阶梯（也为 Q2 的 deps-folded 提供数据）----
  const rigsRoot = (deps.rigsRoot ?? resolveLegacyTopologyRigsRoot)();
  const commitCache = new Map<string, string | null>();
  const ladderOf = (facts: SliceFacts): Record<string, unknown> => {
    const fm = facts.frontmatter;
    const locked: Rung = typeof fm["approved-spec-at"] === "string"
      ? { value: true, basis: `frontmatter approved-spec-at=${fm["approved-spec-at"]}` }
      : { value: false, basis: "frontmatter 中没有 approved-spec-at" };
    // built：绑定到此切片的行上最新的 candidate:<sha> tag。
    const candRows = rows
      .filter((r) => sliceOfRow(r) === facts.id || sliceOfRow(r) === facts.dir)
      .sort((a, b) => (a.ts_created < b.ts_created ? 1 : -1));
    let candidateSha: string | null = null;
    let candidateRow: string | null = null;
    for (const r of candRows) {
      for (const t of parseTags(r.tags)) {
        const m = t.match(CANDIDATE_TAG);
        if (m?.[1]) {
          candidateSha = m[1];
          candidateRow = r.qitem_id;
          break;
        }
      }
      if (candidateSha) break;
    }
    // 候选身份感知 commit：tag token 通过仓库上下文解析为完整 commit ID；原始前缀字符串
    // 相等绝不能视为 commit 身份相等。
    const builtToken = extractShaToken(candidateSha);
    const builtResolved = builtToken && repoCtx ? resolveCommit(exec, repoCtx, builtToken, commitCache) : null;
    const built = candidateSha
      ? {
          candidate_sha: builtToken ?? candidateSha,
          resolved_commit: builtResolved ?? INDETERMINATE,
          basis: `行 ${candidateRow} 上的 candidate:* tag${builtResolved ? "（已通过仓库上下文解析为完整 commit）" : repoCtx ? "（token 未解析为 commit）" : "（没有可用于解析的仓库上下文）"}`,
        }
      : { candidate_sha: INDETERMINATE, basis: "绑定到此切片的任何行上都没有 candidate:* tag（此处无法区分未构建与未记录）" };
    // reviewed：注册表中命名此切片、且限定到已构建 commit 的产物；契约为某 SHA 上的
    // {legs+verdicts}。生产中的混合形式（缩写 tag、完整 SHA、带注释字段）按解析后的 commit
    // 联接；格式错误、有歧义或无法解析的输入会附原因排除，既不放行也不污染结果。
    const artifacts = opts?.project ? INDETERMINATE : scanReviewArtifacts(rigsRoot, [facts.dir, ...(typeof facts.id === "string" ? [facts.id] : [])]);
    let reviewed: Record<string, unknown>;
    if (artifacts === INDETERMINATE) {
      reviewed = { value: INDETERMINATE, basis: opts?.project ? "全局评审产物没有项目身份绑定" : `评审产物根目录不可读（${rigsRoot}）`, legs: [] };
    } else if (!candidateSha || !builtToken) {
      reviewed = { value: INDETERMINATE, basis: "没有可用于限定评审分支的已构建候选 token", legs: [] };
    } else if (!builtResolved) {
      reviewed = {
        value: INDETERMINATE,
        basis: repoCtx
          ? `已构建 token ${builtToken} 未解析为 commit——无法联接身份`
          : "没有可用于解析候选身份的仓库上下文",
        legs: [],
      };
    } else {
      const excluded: { path: string; reason: string }[] = [];
      const atCommit = artifacts.filter((a) => {
        const token = extractShaToken(a.candidateSha);
        if (!token) {
          excluded.push({ path: a.path, reason: "candidate_sha 格式错误（没有 SHA token）" });
          return false;
        }
        const resolved = resolveCommit(exec, repoCtx!, token, commitCache);
        if (!resolved) {
          excluded.push({ path: a.path, reason: `token ${token} 未解析为 commit` });
          return false;
        }
        return resolved === builtResolved;
      });
      reviewed = atCommit.length === 0
        ? { value: INDETERMINATE, basis: `在已检查的注册表界面上，没有评审产物解析到已构建 commit ${builtResolved.slice(0, 9)}`, legs: [], excluded }
        : {
            value: atCommit.every((a) => ["CLEAR", "PASS"].includes(a.verdict)),
            basis: `${atCommit.length} 个产物上的 frontmatter verdict 通过解析后的 commit ${builtResolved.slice(0, 9)} 联接` ,
            legs: atCommit.map((a) => ({ path: a.path, verdict: a.verdict, candidate_sha: a.candidateSha, artifact_type: a.artifactType })),
            excluded,
          };
    }
    // folded / adopted 需要仓库上下文；任意可达 EC-3 worktree 都共享 refs。
    let folded: Rung;
    let adopted: Rung;
    if (!candidateSha) {
      folded = { value: INDETERMINATE, basis: "没有可供检查的候选 SHA" };
      adopted = { value: INDETERMINATE, basis: "没有可供检查的候选 SHA" };
    } else if (!repoCtx) {
      folded = { value: INDETERMINATE, basis: "没有可达仓库上下文（看板上没有 EC-3 worktree）" };
      adopted = { value: INDETERMINATE, basis: "没有可达仓库上下文（看板上没有 EC-3 worktree）" };
    } else {
      folded = gitAncestor(exec, repoCtx, builtResolved ?? candidateSha, "main");
      adopted = buildInfo.commit
        ? gitAncestor(exec, repoCtx, builtResolved ?? candidateSha, buildInfo.commit)
        : { value: INDETERMINATE, basis: "后台服务构建戳缺失（开发运行）——无法派生 adopted 层级" };
    }
    return { slice_id: facts.id, dir: facts.dir, locked, built, reviewed, folded, adopted };
  };

  const ladderCache = new Map<string, Record<string, unknown>>();
  const ladderFor = (facts: SliceFacts): Record<string, unknown> => {
    const key = facts.specPath;
    if (!ladderCache.has(key)) ladderCache.set(key, ladderOf(facts));
    return ladderCache.get(key)!;
  };

  const q4 = slices.map((s) => ladderFor(s));

  // ---- Q2 顺序 ----
  const q2 = slices.map((s) => {
    const fm = s.frontmatter;
    const arranged = typeof s.id === "string" ? arrangementSlice(s.id, s.dir) : null;
    const dependsOn = arranged?.dependsOn ?? parseArrayField(fm["depends_on"]);
    const softMatch = s.body.match(SOFT_AFTER_LINE);
    const softAfter = softMatch?.[1] ? softMatch[1].split(",").map((x) => x.trim()).filter(Boolean) : [];
    // 只有实时行才能表示工作受阻：终态行上过期的 blockedOn 是历史记录而不是当前状态，
    // 不能决定是否可派发。
    const blockedRows = rows
      .filter((r) => (sliceOfRow(r) === s.id || sliceOfRow(r) === s.dir) && r.blocked_on
        && ["pending", "in-progress", "blocked"].includes(r.state))
      .map((r) => ({ qitem_id: r.qitem_id, blocked_on: r.blocked_on }));
    const claimedLane = lanes.some((l) => l.slice === s.id || l.slice === s.dir);
    let nextUp: boolean | Indeterminate;
    let nextUpBasis: string;
    if (dependsOn === INDETERMINATE) {
      nextUp = INDETERMINATE;
      nextUpBasis = "frontmatter 中缺少 depends_on（此处未应用 EC-1）";
    } else if (blockedRows.length > 0) {
      nextUp = false;
      nextUpBasis = `存在阻塞行（${blockedRows.map((b) => b.qitem_id).join(", ")}）`;
    } else if (claimedLane) {
      nextUp = false;
      nextUpBasis = "已认领且正在进行";
    } else if ((ladderFor(s)["folded"] as Rung).value === true) {
      nextUp = false;
      nextUpBasis = "自身候选已合并到 main——没有剩余内容可派发";
    } else if ((ladderFor(s)["folded"] as Rung).value === INDETERMINATE) {
      // 自身完成状态未知时绝不能显示为可派发；诚实判决是 INDETERMINATE，而不是 true
      //（S24/S25 实时假绿类别）。
      nextUp = INDETERMINATE;
      nextUpBasis = `自身完成层级为 INDETERMINATE（${(ladderFor(s)["folded"] as Rung).basis}）`;
    } else {
      nextUp = true;
      nextUpBasis = "未阻塞且未认领";
      for (const dep of dependsOn) {
        const depFacts = resolveDep(dep, slices, missionsRoot, depCache);
        if (!depFacts) {
          nextUp = INDETERMINATE;
          nextUpBasis = `依赖 ${dep} 无法在此任务目标根目录解析`;
          break;
        }
        const depLadder = ladderFor(depFacts);
        const foldedRung = depLadder["folded"] as Rung;
        if (foldedRung.value === INDETERMINATE) {
          nextUp = INDETERMINATE;
          nextUpBasis = `依赖 ${dep} 的 folded 层级为 INDETERMINATE（${foldedRung.basis}）`;
          break;
        }
        if (foldedRung.value === false) {
          nextUp = false;
          nextUpBasis = `依赖 ${dep} 尚未合并`;
          break;
        }
      }
    }
    const wave = typeof s.id === "string" ? waveOfSlice(s.id) : null;
    return {
      slice_id: s.id,
      dir: s.dir,
      planned_owners: arranged?.plannedOwners ?? [],
      work_rows: rows.filter(r => (sliceOfRow(r) === s.id || sliceOfRow(r) === s.dir)
        && ["pending", "in-progress", "blocked"].includes(r.state))
        .sort((a, b) => b.ts_updated.localeCompare(a.ts_updated))
        .map(r => ({ qitem_id: r.qitem_id, seat: r.destination_session, state: r.state,
          summary: r.summary ?? null, blocked_on: r.blocked_on, claimed_at: r.claimed_at })),
      depends_on: dependsOn,
      soft_after: softAfter,
      blocked_on_rows: blockedRows,
      next_up: nextUp,
      next_up_basis: nextUpBasis,
      next_up_rank: nextUp === true && wave ? wave.rank : null,
      source: {
        spec_path: s.specPath,
        wave_map_row: waveMap.rowId,
        ...(arranged ? { arrangement_path: arranged.path } : {}),
      },
    };
  });

  // ---- Q3 关注旋钮 ----
  const q3 = slices.map((s) => {
    const wave = typeof s.id === "string" ? waveOfSlice(s.id) : null;
    const dial = typeof s.frontmatter["approved-spec-dial"] === "string"
      ? (s.frontmatter["approved-spec-dial"] as string)
      : INDETERMINATE;
    return {
      slice_id: s.id,
      build_wave: wave?.wave ?? INDETERMINATE,
      review_model: wave?.review_model ?? INDETERMINATE,
      planning_dial: dial,
      source: {
        wave_map_row: waveMap.rowId,
        ...(typeof s.id === "string" && arrangementSlice(s.id, s.dir)
          ? { arrangement_path: arrangementSlice(s.id, s.dir)!.path }
          : {}),
        dial: dial === INDETERMINATE ? "frontmatter 中没有 approved-spec-dial 字段" : `${s.specPath} 中的 frontmatter approved-spec-dial` ,
      },
    };
  });

  // ---- Q5 暂存真实性 ----
  const q5 = rows
    .filter((r) => r.state === "blocked" || (r.claimed_at && ["in-progress", "pending"].includes(r.state)))
    .map((r) => {
      const activity = deps.seatActivity?.getSeatStateBySession(r.destination_session);
      const pickup = derivePickup({
        lastMeaningfulAt: lastMeaningfulTransition(deps.db, r.qitem_id)?.at,
        activity: activity?.activity, needsInput: activity?.needsInput.count,
        state: r.state,
        claimedAt: r.claimed_at,
        lastHeartbeat: r.last_heartbeat,
        postClaimMotionCount: Number(r.post_claim_motion ?? 0),
        now: now(),
      });
      const wake = deps.db
        .prepare(`SELECT wake_ref, phase FROM queue_transition_wakes WHERE qitem_id = ? AND phase = 'armed' LIMIT 1`)
        .get(r.qitem_id) as { wake_ref: string; phase: string } | undefined;
      // park_kind 是 DESIGN 定义的封闭枚举：deliberate-with-wake | stalled | indeterminate。
      // 不得泄漏其他值；实时产物曾在此错误发出 'working'。枚举成员必须为小写。
      let parkKind: "deliberate-with-wake" | "stalled" | "indeterminate";
      if (pickup.state === "parked" && wake) {
        parkKind = "deliberate-with-wake";
      } else if (pickup.state === "stalled-after-claim") {
        parkKind = "stalled";
      } else {
        parkKind = "indeterminate";
      }
      const ageMinutes = r.claimed_at ? Math.floor((now().getTime() - Date.parse(r.claimed_at)) / 60_000) : null;
      return {
        qitem_id: r.qitem_id,
        pickup_state: pickup.state,
        ...(pickup.evidence ? { pickup_evidence: pickup.evidence } : {}),
        park_kind: parkKind,
        park_kind_basis: wake
          ? `queue_transition_wakes 上已武装唤醒 ${wake.wake_ref}`
          : "没有已武装唤醒行（此处无法区分无唤醒的主动暂存与搁浅；工作组暂存逻辑负责唤醒诊断）",
        wake_target: wake?.wake_ref ?? null,
        age_minutes: ageMinutes,
        source: { qitem_id: r.qitem_id },
      };
    });

  // ---- Q6 并行健康状态 ----
  const inProgressSeats = new Set(rows.filter((r) => r.state === "in-progress").map((r) => r.destination_session));
  // 空闲容量：名册来自 sessions（只取名称），空闲状态来自活动事实源；不读取 sessions.status
  //（真实看板中它曾把实时工作泳道标为 `superseded`）。
  let idleSeats: number | Indeterminate = INDETERMINATE;
  let idleBasis = "此依赖集合未接入 seat-activity 事实源";
  if (deps.seatActivity) {
    try {
      const roster = deps.db
        .prepare(`SELECT DISTINCT session_name FROM sessions`)
        .all() as { session_name: string }[];
      idleSeats = roster.filter((s) => {
        if (inProgressSeats.has(s.session_name)) return false;
        const a = deps.seatActivity!.getSeatStateBySession(s.session_name);
        // 容量 = 仲裁状态为 idle-at-prompt 且没有任何输入需求；needs-input 席位在等待他人，
        // 不属于可用容量。
        return !!a && a.activity === "idle-at-prompt" && a.needsInput.count === 0;
      }).length;
      idleBasis = "在仅含名称的 sessions 名册中，仲裁席位状态为 idle-at-prompt 且 needsInput.count=0，并扣除持有进行中行的席位";
    } catch {
      idleSeats = INDETERMINATE;
      idleBasis = "sessions 名册不可读";
    }
  }
  const heavyRow = rows.find((r) => r.state === "in-progress" && parseTags(r.tags).includes("heavy-slot"));
  let dfMargin: Record<string, unknown> = { available_kib: INDETERMINATE, basis: "没有可供 statfs 读取的路径" };
  const dfPath = repoCtx ?? missionsRoot;
  if (dfPath) {
    try {
      const st = fs.statfsSync(dfPath);
      dfMargin = {
        available_kib: Math.floor((st.bavail * st.bsize) / 1024),
        path: dfPath,
        basis: "读取时调用 fs.statfsSync",
      };
    } catch {
      dfMargin = { available_kib: INDETERMINATE, path: dfPath, basis: "statfs 失败" };
    }
  }
  const readPolicy = createProofPolicyRead();
  const readiness = missionsRoot && mission !== INDETERMINATE ? readMissionReadiness(path.join(missionsRoot, mission), readPolicy) : null;
  for (const sequenced of q2) {
    const derived = readiness?.slices.find(s => s.scope === sequenced.dir);
    if (!derived?.readiness.configured) continue;
    sequenced.next_up = derived.eligible === null ? INDETERMINATE : derived.eligible && derived.readiness.state !== "ready" && sequenced.work_rows.length === 0;
    sequenced.next_up_basis = `带归因的证明就绪状态 ${readiness!.revision}；依赖资格 ${derived.eligible}`;
  }
  const q6 = {
    lanes_live: lanes.length,
    lanes_possible: q2.filter((s) => s.next_up === true).length,
    idle_seats_with_capacity: { value: idleSeats, basis: idleBasis },
    heavy_slot_holder: heavyRow
      ? { value: heavyRow.qitem_id, basis: "带 heavy-slot tag 的进行中行" }
      : { value: null, basis: "没有带 heavy-slot tag 的进行中行——tag 缺失并不能证明泳道空闲" },
    df_margin: dfMargin,
  };

  return {
    ...(opts?.project ? { project: opts.project, membership: "精确匹配 project:<id> 队列 tag 和生命周期身份；排除无工作范围行" } : {}),
    view: "execution",
    readiness,
    project_readiness: missionsRoot ? readProjectReadiness(missionsRoot, readPolicy) : null,
    // 编写的指导按原意携带，绝不解析为边或验收结果。
    planning_guidance: arrangement?.state === "valid" ? arrangement.guidance : [],
    mission,
    derived_at: derivedAt,
    sources: {
      queue_db: { asof: asof(), basis: "读取时的 queue_items/queue_transitions/queue_transition_wakes/sessions" },
      slice_frontmatter: { root: missionsRoot ?? INDETERMINATE, asof: asof() },
      wave_map: {
        row: waveMap.rowId,
        asof: asof(),
        ...(arrangement?.state === "valid" ? { superseded_by: `${arrangement.missionPath} + referenced slice.yaml files` } : {}),
      },
      ...(arrangement?.state === "valid"
        ? {
            arrangement: {
              manifest: arrangement.missionPath,
              asof: asof(),
              basis: "mission.yaml 组合顺序 + 引用的 slice.yaml execution 字段",
            },
          }
        : arrangement?.state === "malformed"
          ? {
              arrangement: {
                value: INDETERMINATE,
                manifest: arrangement.missionPath,
                asof: asof(),
                basis: `mission.yaml arrangement 格式错误（${arrangement.warning}）；回退到旧版 format:wave-map-v1 和 SPEC frontmatter`,
              },
            }
          : {}),
      git: { basis: repoCtx ? `逐泳道 git -C；仓库上下文 ${repoCtx}` : "没有可达仓库上下文", asof: asof() },
      build_info: { commit: buildInfo.commit ?? INDETERMINATE, asof: asof() },
      review_artifacts: { root: rigsRoot, asof: asof() },
      disk: { asof: asof() },
      workflow_lifecycle: {
        asof: asof(),
        basis: "读取时将 workflow_instances 身份与包绑定、失败事件、工作流 spec 及当前队列行联接",
      },
    },
    lifecycle_instances: lifecycleExecutions,
    q1_lanes: lanes,
    q2_sequencing: q2,
    q3_care: q3,
    q4_ladder: q4,
    q5_park: q5,
    q6_parallelism: q6,
  };
}
