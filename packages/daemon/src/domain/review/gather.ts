// Living Notes Packet 2 —— 输入收集器（OPR.0.4.4.20）。
//
// 纯组合器外围的非纯外壳：从磁盘读取切片文档与证明制品，从 SQLite 读取关注事项和
// 智能体行，从 frontmatter 读取审批印章（并与 Packet-1 audit-target 契约交叉核对），
// 以及从工作区默认仓库读取 git 事实。无法读取的来源都会如实降级为 null/"unknown"；
// 组合器渲染明确命名的降级状态，绝不编造内容。

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import type Database from "better-sqlite3";
import { sessionMemberLabel } from "../session-name.js";
import type { SliceIndexer, SliceRecord } from "../slices/slice-indexer.js";
import { parseScopeTags } from "../slices/qitem-membership.js";
import {
  composeMissionReview,
  composeRecordedGreenForSlice,
  composeSliceReview,
  deriveCandidateSha,
  extractMediaRefs,
  extractSection,
  type AgentInput,
  type ApprovalFacts,
  type ApprovalStampFacts,
  type AttentionInput,
  type GitFacts,
  type MissionSliceEntry,
  type SliceComposeInputs,
  type WorkflowExceptionInput,
} from "./compose.js";
import type { AgentsBand, AgentsScope, ComposedMissionReview, ComposedRigAgents, ComposedSliceReview, LockedArtifact, SettledRow, WorkflowRowRef } from "./types.js";
import { composeAgentsBand, composeRigAgents } from "./compose.js";
import { runSyncSite } from "../sync-site-wrap.js";
import { readSliceReadiness, readMissionReadiness } from "../proof/judgments.js";
import { readProofArtifacts } from "./proof-io.js";
import { evaluateStepDeadline } from "../workflow-deadline.js";
import type { AgentActivityStore } from "../agent-activity-store.js";
import { isHumanSeatSession } from "../human-route-enforcer.js";
import { resolveNodeFileVia } from "../scope/node-file.js";

export interface ReviewGathererDeps {
  db: Database.Database;
  indexer: SliceIndexer;
  /** 获取 git 谱系事实的仓库路径（工作区默认仓库）；null 表示降级为 unknown。 */
  gitRepoPath?: string | null;
  /** OPR.0.4.4.22 —— 为智能体状态标记读取 hook 活动（FR-2）。可选；缺失时每个标记
   *  都如实降级为 `unknown`，绝不猜测。只同步读取 SQLite，不轮询也不联系智能体。 */
  activityStore?: AgentActivityStore | null;
  /** 注入时钟，使组合结果在测试中可复现。 */
  now?: () => string;
}

interface QitemRow {
  qitem_id: string;
  ts_created: string;
  destination_session: string;
  state: string;
  priority: string | null;
  tier: string | null;
  tags: string | null;
  summary: string | null;
  blocked_on: string | null;
  closure_required_at: string | null;
  ts_updated: string;
}

const ACTIVE_STATES = ["pending", "in-progress", "claimed", "blocked", "handed-off"];

/** OPR.0.4.6.WF4 Q6 —— ●（智能体环节）工作流身份印章，从条目自身的结构化标签
 *  `workflow:<name>` / `instance:<id>` / `step:<id>` 派生；这是 WF-5 批准的可查询身份，
 *  绝不从 summary/identity/evidenceRef 自然语言中推断。仅当两个必需键都存在时返回
 *  指针；非工作流行（没有 `instance:`/`workflow:` 标签）返回 `undefined`，使其
 *  AttentionInput 通过缺失时省略保持字节一致。指针只含三个身份键，不含
 *  status/deadline/class。 */
export function workflowRefFromTags(tagsJson: string | null): WorkflowRowRef | undefined {
  if (!tagsJson) return undefined;
  let tags: string[];
  try {
    tags = (JSON.parse(tagsJson) as string[]) ?? [];
  } catch {
    return undefined;
  }
  let instanceId: string | undefined;
  let workflowName: string | undefined;
  let stepId: string | undefined;
  for (const t of tags) {
    if (t.startsWith("instance:")) instanceId = t.slice("instance:".length);
    else if (t.startsWith("workflow:")) workflowName = t.slice("workflow:".length);
    else if (t.startsWith("step:")) stepId = t.slice("step:".length);
  }
  if (!instanceId || !workflowName) return undefined;
  return { instanceId, workflowName, ...(stepId ? { stepId } : {}) };
}

export class ReviewGatherer {
  private readonly db: Database.Database;
  private readonly indexer: SliceIndexer;
  private readonly gitRepoPath: string | null;
  private readonly activityStore: AgentActivityStore | null;
  private readonly now: () => string;

  constructor(deps: ReviewGathererDeps) {
    this.db = deps.db;
    this.indexer = deps.indexer;
    this.gitRepoPath = deps.gitRepoPath ?? null;
    this.activityStore = deps.activityStore ?? null;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  composeSlice(name: string): ComposedSliceReview | null {
    const inputs = this.gatherSlice(name);
    return inputs ? composeSliceReview(inputs) : null;
  }

  /** 组合结果以及 freeze 渲染器所需的磁盘上下文（FR-6）。 */
  composeSliceWithContext(name: string): { composed: ComposedSliceReview; sliceDir: string; mediaRefs: string[] } | null {
    const slice = this.indexer.get(name);
    const inputs = this.gatherSlice(name);
    if (!slice || !inputs) return null;
    return { composed: composeSliceReview(inputs), sliceDir: slice.slicePath, mediaRefs: inputs.mediaRefs };
  }

  composeMission(mission: string): ComposedMissionReview | null {
    // qitem-ccf87c0d 纠偏：一次任务目标组合是一个复合操作。冷启动 list() 与每个任务
    // 目标切片的 gatherSlice()->indexer.get() 共享同一成员关系批次；修复前，每次未缓存
    // get 都建立自己的双扫描批次，导致 2+2N 次成员扫描，40 个切片时为 82 次。
    return this.indexer.withMembershipBatch(() => this.composeMissionInBatch(mission));
  }

  private composeMissionInBatch(mission: string): ComposedMissionReview | null {
    const slices = this.indexer.list().filter((s) => s.missionId === mission);
    if (slices.length === 0 && !this.missionDirExists(mission)) return null;
    const nowIso = this.now();
    // 台账中基于已记录判定的 green 与每个组合评审一起传递（FR-7）：收集器持有制品，
    // 因而由它派生切片契约已不再携带的任务目标层级完成事实（§11）。
    const composed = slices
      .map((s): MissionSliceEntry | null => {
        const inputs = this.gatherSlice(s.name);
        if (!inputs) return null;
        return {
          review: composeSliceReview(inputs),
          green: composeRecordedGreenForSlice(inputs.artifacts).green,
        };
      })
      .filter((s): s is MissionSliceEntry => s !== null);
    const missionMeta = this.readMissionMeta(mission);
    return composeMissionReview({
      readiness: readMissionReadiness(path.join(this.indexer.slicesRoot, mission)),
      mission: { name: mission, id: missionMeta.id, title: missionMeta.title, intent: missionMeta.intent },
      slices: composed,
      missionAttention: this.attentionForTag(`mission:${mission}`, `slice:`),
      agents: this.agentsForSlices(slices.map((s) => s.name), { missionName: mission }),
      nowIso,
    });
  }

  /**
   * OPR.0.4.4.22 —— 组合后的工作组智能体读取根（FR-1..FR-4）：工作组 scope 下的
   * 需要你处理 + 智能体（健康状态行）+ 已完成。它是队列与 hook 活动的纯投影，不联系
   * 任何智能体。名单由当前持有者与近期持有者取并集；“当天发生 scope 转换”是 plan-review
   * 裁定的展示窗口，并会在溯源信息中注明。
   */
  composeRig(): ComposedRigAgents {
    const nowIso = this.now();
    const todayStart = `${nowIso.slice(0, 10)}T00:00:00.000Z`;
    const agents = this.withTelemetry(this.rigRoster(todayStart), nowIso);
    const attention = this.attentionAll();
    const overdue = this.overdueWork(nowIso);
    const { settled, handoffsToday } = this.settledToday(todayStart);
    return composeRigAgents({
      agents,
      overdue,
      attention,
      settled,
      handoffsToday,
      overdueCount: overdue.length,
      rosterWindow: "today",
      workflows: this.gatherWorkflowExceptions(nowIso),
      nowIso,
    });
  }

  /** 按 scope 参数化的智能体投影；所有消费者共用一份契约。 */
  composeAgents(scope: AgentsScope): AgentsBand | null {
    const nowIso = this.now();
    if (scope === "rig") {
      return composeAgentsBand(this.agentsForSlices(null), scope, [], nowIso);
    }
    if (scope.startsWith("slice:")) {
      const name = scope.slice("slice:".length);
      if (!this.indexer.get(name)) return null;
      return composeAgentsBand(this.agentsForSlices([name]), scope, [], nowIso);
    }
    const mission = scope.slice("mission:".length);
    const slices = this.indexer.list().filter((s) => s.missionId === mission);
    if (slices.length === 0 && !this.missionDirExists(mission)) return null;
    // C3（PM 裁定 i）：直接按任务目标标签判断成员关系。即使切片标签未建立索引，带
    // `mission:X` 标签的活动工作也会计入；这样，目录存在但索引切片为零的任务目标不会
    // 再根据始终为空的名称列表组合出看似确定的空白区域。
    return composeAgentsBand(
      this.agentsForSlices(slices.map((s) => s.name), { missionName: mission }),
      scope,
      [],
      nowIso,
    );
  }

  // -------------------------------------------------------------------------

  gatherSlice(name: string): SliceComposeInputs | null {
    const slice = this.indexer.get(name);
    if (!slice) return null;

    const nodeFile = resolveNodeFileVia(slice.slicePath, (p) => this.readFile(p));
    const readme = nodeFile?.content ?? null;
    const prd = this.readFile(path.join(slice.slicePath, "IMPLEMENTATION-PRD.md"));
    const proofMd = this.readFile(path.join(slice.slicePath, "PROOF.md"));

    const artifacts = readProofArtifacts(slice.slicePath);
    const attention = this.attentionForTag(`slice:${name}`);
    const agents = this.agentsForSlices([name]);
    const frontmatter = this.parseFrontmatter(readme);
    const approval = this.gatherApproval(slice, frontmatter);
    const candidateRef = deriveCandidateSha(artifacts);

    return {
      slice: {
        name: slice.name,
        id: typeof frontmatter["id"] === "string" ? (frontmatter["id"] as string) : null,
        title: slice.displayName,
        missionId: slice.missionId,
      },
      readme,
      nodeFileName: nodeFile ? path.basename(nodeFile.path) as "SPEC.md" | "README.md" : undefined,
      prd,
      proofMd,
      artifacts,
      readiness: readSliceReadiness(slice.slicePath),
      lockedArtifacts: this.parseLockedArtifacts(frontmatter),
      mediaRefs: this.collectMediaRefs([readme, prd, proofMd]),
      proofDirExists: fs.existsSync(path.join(slice.slicePath, "proof")),
      attention,
      agents,
      workflows: this.gatherWorkflowExceptions(this.now()),
      activeQitemPresent: this.hasActiveQitem(name),
      git: this.gatherGitFacts(frontmatter, candidateRef),
      approval,
      nowIso: this.now(),
    };
  }

  /** §3.1 唯一真正新增的数据：固定的计划集合。它来自 frontmatter 读取，即切片 README
   *  中的 `locked-artifacts:` 列表，沿用 scope-fs 模式，不增加文件类型或写入机制。
   *  格式错误的条目会被跳过，绝不编造。 */
  private parseLockedArtifacts(fm: Record<string, unknown>): LockedArtifact[] {
    const raw = fm["locked-artifacts"];
    if (!Array.isArray(raw)) return [];
    const out: LockedArtifact[] = [];
    for (const entry of raw) {
      if (entry === null || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const p = typeof e["path"] === "string" ? e["path"].trim() : "";
      if (!p) continue;
      out.push({
        name: typeof e["name"] === "string" && e["name"].trim() ? e["name"].trim() : p,
        path: p,
        kind: typeof e["kind"] === "string" && e["kind"].trim() ? e["kind"].trim() : "artifact",
      });
    }
    return out;
  }

  private readFile(p: string): string | null {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      return null;
    }
  }

  private missionDirExists(mission: string): boolean {
    // 索引器只知道切片；没有切片的任务目标仍可组合为空面板。
    return this.indexer.list().some((s) => s.missionId === mission);
  }

  private readMissionMeta(mission: string): { id: string | null; title: string; intent: string | null; missionDir: string | null } {
    const anySlice = this.indexer.list().find((s) => s.missionId === mission);
    if (anySlice) {
      const missionDir = path.dirname(path.dirname(anySlice.slicePath));
      const readme = resolveNodeFileVia(missionDir, (p) => this.readFile(p))?.content ?? null;
      const fm = this.parseFrontmatter(readme);
      // FR-8：brief 的 "What & why" 按原样投影为意图开篇。
      const brief = this.readFile(path.join(missionDir, "MISSION_BRIEF.md"));
      return {
        id: typeof fm["id"] === "string" ? (fm["id"] as string) : null,
        title: typeof fm["title"] === "string" ? (fm["title"] as string) : mission,
        intent: extractSection(brief, "What & why"),
        missionDir,
      };
    }
    return { id: null, title: mission, intent: null, missionDir: null };
  }

  /** FR-8 freeze 时刻的 brief 写入目标：绝对路径与当前内容。 */
  missionBriefTarget(mission: string): { briefPath: string; content: string } | null {
    const meta = this.readMissionMeta(mission);
    if (!meta.missionDir) return null;
    const briefPath = path.join(meta.missionDir, "MISSION_BRIEF.md");
    const content = this.readFile(briefPath);
    return content === null ? null : { briefPath, content };
  }

  private parseFrontmatter(content: string | null): Record<string, unknown> {
    if (!content) return {};
    const m = content.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return {};
    try {
      return (YAML.parse(m[1]!) ?? {}) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  // VM-006（A1）：readProofArtifacts 已原样迁移到 ./proof-io.ts，作为与切片详情投影器
  // 共用的唯一归属位置；gather 委托给它。

  /** 从所有组合来源收集 Markdown 图片/视频引用，用于 FR-5 缺陷扫描。 */
  private collectMediaRefs(sources: Array<string | null>): string[] {
    return sources.flatMap((s) => extractMediaRefs(s));
  }

  private tableExists(name: string): boolean {
    try {
      const row = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
      return row !== undefined;
    } catch {
      return false;
    }
  }

  private columnExists(table: string, column: string): boolean {
    try {
      const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return rows.some((r) => r.name === column);
    } catch {
      return false;
    }
  }

  /** 携带指定标签且路由给人类的关注行。§5 谓词来自 Packet 1；在它落地前，以相同结构
   *  选择 human-tier/human-dest/park-on-human 行。 */
  /** OPR.0.4.6.WF5 FR-3 —— ▲ 区的已记录工作流实例视图：失败与处理中实例、WF-1
   *  求值器判定（只消费而不重新计算，导入模块就是唯一归属位置）、通过标签查询获得的
   *  开放异常项（绝不解析摘要），以及非开放 frontier 异常检查。全程只读；表不存在时
   *  （工作流功能加入前的数据库）返回空数组。 */
  private gatherWorkflowExceptions(nowIso: string): WorkflowExceptionInput[] {
    try {
      const instances = this.db
        .prepare(
          `SELECT instance_id, workflow_name, status, current_step_id, current_frontier_json
           FROM workflow_instances WHERE status IN ('failed','active','waiting')`,
        )
        .all() as Array<{
        instance_id: string;
        workflow_name: string;
        status: string;
        current_step_id: string | null;
        current_frontier_json: string;
      }>;
      const now = new Date(nowIso);
      const out: WorkflowExceptionInput[] = [];
      for (const row of instances) {
        let frontier: string[] = [];
        try {
          frontier = (JSON.parse(row.current_frontier_json) as string[]) ?? [];
        } catch {
          frontier = [];
        }
        const packets = frontier.map(
          (id) =>
            this.db
              .prepare(
                `SELECT qitem_id, state, destination_session, ts_created, claimed_at, closure_required_at
                 FROM queue_items WHERE qitem_id = ?`,
              )
              .get(id) as
              | { qitem_id: string; state: string; destination_session: string; ts_created: string; claimed_at: string | null; closure_required_at: string | null }
              | undefined,
        );
        const frontierRefsNonOpenPacket =
          (row.status === "active" || row.status === "waiting") &&
          packets.some((p) => p && !["pending", "in-progress", "blocked"].includes(p.state));
        const verdict = evaluateStepDeadline(
          {
            instanceId: row.instance_id,
            status: row.status,
            currentFrontier: frontier,
            currentStepId: row.current_step_id,
          },
          packets.map((p) =>
            p
              ? {
                  qitemId: p.qitem_id,
                  state: p.state,
                  destinationSession: p.destination_session,
                  tsCreated: p.ts_created,
                  claimedAt: p.claimed_at,
                  closureRequiredAt: p.closure_required_at,
                }
              : null,
          ),
          now,
        );
        const item = this.db
          .prepare(
            `SELECT qitem_id, destination_session, tier, ts_created, summary
             FROM queue_items
             WHERE state IN ('pending','in-progress','blocked')
               AND tags LIKE ? AND tags LIKE ?
             ORDER BY ts_created DESC LIMIT 1`,
          )
          .get(`%"instance:${row.instance_id}"%`, `%"workflow-exception"%`) as
          | { qitem_id: string; destination_session: string; tier: string | null; ts_created: string; summary: string | null }
          | undefined;
        out.push({
          instanceId: row.instance_id,
          workflowName: row.workflow_name,
          status: row.status,
          currentStepId: row.current_step_id,
          deadlineState: verdict.state,
          deadlineEvidence: verdict.evidence
            ? `步骤 ${verdict.evidence.stepId ?? "?"} 的 packet ${verdict.evidence.packetId} 由 ${verdict.evidence.ownerSession} 持有——已超过 ${verdict.evidence.anchor} 锚点 ${verdict.evidence.overdueBySeconds} 秒`
            : null,
          frontierRefsNonOpenPacket,
          openItem: item
            ? {
                qitemId: item.qitem_id,
                destinationSession: item.destination_session,
                humanRouted:
                  item.tier === "human-gate" || /^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/.test(item.destination_session),
                createdAtIso: item.ts_created,
                summary: item.summary,
              }
            : null,
        });
      }
      return out;
    } catch (err) {
      // 工作流功能加入前且没有相关表的数据库应与 WF-5 前的结果保持字节一致；其他错误
      // 必须醒目失败。此处遵循 WF-3 收窄 catch 的经验，宽泛捕获会让该区域静默失明。
      if (err instanceof Error && /no such table/i.test(err.message)) return [];
      throw err;
    }
  }

  private attentionForTag(tag: string, excludeTagPrefix?: string): AttentionInput[] {
    if (!this.tableExists("queue_items")) return [];
    // 规范成员关系：查询标签只解析一次。SQL LIKE 是不带引号的预过滤器，现在可捕获旧式
    // 逗号分隔行；parseScopeTags 是权威的逐行确认，会拒绝预过滤器产生的子串/后缀误匹配。
    // attentionForTag 的真实缺陷是漏匹配旧式逗号格式：旧 JSON 引号模式 `%"slice:X"%`
    // 永远不会出现在逗号拼接元素中。
    const tagIsSlice = tag.startsWith("slice:");
    const tagIsMission = tag.startsWith("mission:");
    const tagName = tagIsSlice
      ? tag.slice("slice:".length)
      : tagIsMission
        ? tag.slice("mission:".length)
        : null;
    const hasEvidenceRef = this.columnExists("queue_items", "evidence_ref");
    const summaryCol = this.columnExists("queue_items", "summary") ? "summary" : "NULL AS summary";
    const rows = this.db
      .prepare(
        `SELECT qitem_id, ts_created, ts_updated, destination_session, state, priority, tier, tags, ${summaryCol},
                blocked_on, closure_required_at${hasEvidenceRef ? ", evidence_ref" : ""}
         FROM queue_items
         WHERE state IN (${ACTIVE_STATES.map(() => "?").join(",")})
           AND tags LIKE ?
           AND (tier = 'human-gate'
                OR destination_session LIKE 'human%'
                OR (state = 'blocked' AND blocked_on LIKE 'human%'))`,
      )
      .all(...ACTIVE_STATES, `%${tag}%`) as Array<QitemRow & { evidence_ref?: string | null }>;
    return rows
      .filter((r) => {
        // 逐行规范确认，其权威性高于预过滤器。
        const scopes = parseScopeTags(r.tags);
        if (tagIsSlice && !scopes.slices.has(tagName!)) return false;
        if (tagIsMission && !scopes.missions.has(tagName!)) return false;
        // d2：让 excludeTagPrefix 与规范集合对齐（其文档意图是“携带切片标签的行”），
        // 使旧式逗号行与规范行一样被排除；未知前缀保持原始语义。
        if (excludeTagPrefix === "slice:") return scopes.slices.size === 0;
        if (excludeTagPrefix) {
          try {
            const tags = (JSON.parse(r.tags ?? "[]") as string[]) ?? [];
            return !tags.some((t) => t.startsWith(excludeTagPrefix));
          } catch {
            return true;
          }
        }
        return true;
      })
      .map((r) => {
        // OPR.0.4.6.WF4 Q6 —— 从条目自身标签写入 ● 工作流指针；非工作流行省略该字段，
        // 通过省略保证字节一致性。
        const workflow = workflowRefFromTags(r.tags);
        return {
          qitemId: r.qitem_id,
          summary: r.summary,
          leg: r.state === "blocked" ? "park-on-human" : "human-routed",
          where: r.destination_session,
          createdAtIso: r.ts_created,
          priority: r.priority,
          tier: r.tier,
          evidenceRef: r.evidence_ref ?? null,
          unblocks: r.state === "blocked" ? r.qitem_id : null,
          destinationSession: r.destination_session,
          closureRequiredAtIso: r.closure_required_at,
          ...(workflow ? { workflow } : {}),
        };
      });
  }

  /** 持有指定切片活动工作的会话；null 表示整个工作组。区域成员关系来自 scope 上的工作，
   *  绝不根据同属一个工作组推断。v1 中运行时/空闲遥测只来自队列，无法证实时如实为 unknown。 */
  private agentsForSlices(
    sliceNames: string[] | null,
    opts: { missionName?: string | null } = {},
  ): AgentInput[] {
    const missionName = opts.missionName ?? null;
    if (!this.tableExists("queue_items")) return [];
    const summaryCol = this.columnExists("queue_items", "summary") ? "summary" : "NULL AS summary";
    const rows = this.db
      .prepare(
        `SELECT qitem_id, ts_created, ts_updated, destination_session, state, priority, tier, tags, ${summaryCol},
                blocked_on, closure_required_at
         FROM queue_items
         WHERE state IN (${ACTIVE_STATES.map(() => "?").join(",")})`,
      )
      .all(...ACTIVE_STATES) as QitemRow[];
    const bySession = new Map<string, { rows: QitemRow[]; slices: Set<string> }>();
    for (const r of rows) {
      if (isHumanSeatSession(r.destination_session)) continue;
      const scopes = parseScopeTags(r.tags);
      const rowSlices = [...scopes.slices];
      // 规范成员关系：行带有任一指定切片时属于该区域；对任务目标区（C3，PM 裁定 i），
      // 直接带任务目标标签也算成员，因此即使切片标签未建立索引，`mission:X` 工作仍会
      // 计入。工作组/切片流程中的 missionName 为 null，与修复前保持字节一致。
      if (
        sliceNames !== null &&
        !rowSlices.some((s) => sliceNames.includes(s)) &&
        !(missionName !== null && scopes.missions.has(missionName))
      )
        continue;
      const entry = bySession.get(r.destination_session) ?? { rows: [], slices: new Set<string>() };
      entry.rows.push(r);
      for (const s of rowSlices) entry.slices.add(s);
      bySession.set(r.destination_session, entry);
    }
    return [...bySession.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([session, e]) => {
        const latest = e.rows.reduce((acc, r) => (r.ts_updated > acc.ts_updated ? r : acc), e.rows[0]!);
        const parked = e.rows
          .filter((r) => !!r.blocked_on)
          .reduce<QitemRow | null>((acc, r) => (!acc || r.ts_updated > acc.ts_updated ? r : acc), null);
        return {
          agentName: sessionMemberLabel(session), // OPR.0.4.6.MH1 FR-8：共享契约
          sessionName: session,
          runtime: "unknown" as const,
          parkedOn: parked?.blocked_on ?? null,
          idle: null, // 如实为 unknown：仅凭队列行无法证明存活性
          idleSinceIso: null,
          doing: parked?.summary ?? latest.summary,
          holdsCount: e.rows.length,
          lastTransitionIso: (parked ?? latest).ts_updated,
          slices: [...e.slices].sort(),
        };
      });
  }

  // --- OPR.0.4.4.22 工作组 scope 辅助逻辑（全部为同步 SQLite 读取）---

  /** FR-1 名单：当前持有任意带切片标签活动工作的智能体，与近期持有者取并集；后者的
   *  带切片标签条目在当天发生过转换，这是已裁定的展示窗口。成员关系来自 scope 上的工作，
   *  绝不根据同属一个工作组推断。 */
  private rigRoster(todayStartIso: string): AgentInput[] {
    const holders = this.agentsForSlices(null);
    if (!this.tableExists("queue_items")) return holders;
    const summaryCol = this.columnExists("queue_items", "summary") ? "summary" : "NULL AS summary";
    // 近期持有者：带切片标签、最新更新发生在当天、但已不处于活动状态的 qitem 目标。
    const rows = this.db
      .prepare(
        `SELECT qitem_id, ts_created, ts_updated, destination_session, state, priority, tier, tags, ${summaryCol},
                blocked_on, closure_required_at
         FROM queue_items
         WHERE ts_updated >= ?
           AND state NOT IN (${ACTIVE_STATES.map(() => "?").join(",")})
           AND tags LIKE '%"slice:%'`,
      )
      .all(todayStartIso, ...ACTIVE_STATES) as QitemRow[];
    const known = new Set(holders.map((h) => h.sessionName));
    const recent = new Map<string, { latest: QitemRow; slices: Set<string> }>();
    for (const r of rows) {
      if (isHumanSeatSession(r.destination_session)) continue;
      if (known.has(r.destination_session)) continue;
      let tags: string[] = [];
      try {
        tags = (JSON.parse(r.tags ?? "[]") as string[]) ?? [];
      } catch {
        tags = [];
      }
      const rowSlices = tags.filter((t) => t.startsWith("slice:")).map((t) => t.slice("slice:".length));
      if (rowSlices.length === 0) continue;
      const entry = recent.get(r.destination_session) ?? { latest: r, slices: new Set<string>() };
      if (r.ts_updated > entry.latest.ts_updated) entry.latest = r;
      for (const s of rowSlices) entry.slices.add(s);
      recent.set(r.destination_session, entry);
    }
    const recentInputs: AgentInput[] = [...recent.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([session, e]) => ({
        agentName: sessionMemberLabel(session), // OPR.0.4.6.MH1 FR-8：共享契约
        sessionName: session,
        runtime: "unknown" as const,
        parkedOn: null,
        idle: null,
        idleSinceIso: null,
        // FR-1：没有已跟踪活动条目的智能体应如实显示，这本身就是协调信号，绝不编造。
        doing: "没有已跟踪的工作项",
        holdsCount: 0,
        lastTransitionIso: e.latest.ts_updated,
        slices: [...e.slices].sort(),
      }));
    return [...holders, ...recentInputs].sort((a, b) => a.sessionName.localeCompare(b.sessionName));
  }

  /** FR-2 遥测补充：运行时来自 sessions/nodes 表，active/idle 指示来自已记录的 hook
   *  活动（AgentActivityStore）。无法证实的信息如实保持 unknown，绝不猜测。 */
  private withTelemetry(agents: AgentInput[], nowIso: string): AgentInput[] {
    const runtimes = this.sessionRuntimes();
    return agents.map((a) => {
      const runtime = runtimes.get(a.sessionName) ?? "unknown";
      let idle: boolean | null = a.idle;
      let idleSinceIso: string | null = a.idleSinceIso;
      if (this.activityStore) {
        try {
          const activity = this.activityStore.getLatestForNode({ sessionName: a.sessionName, now: new Date(nowIso) });
          if (activity?.state === "running") {
            idle = false;
            idleSinceIso = null;
          } else if (activity?.state === "idle") {
            idle = true;
            idleSinceIso = activity.eventAt ?? activity.sampledAt ?? null;
          }
          // needs_input / unknown / null 均如实保持 unknown。
        } catch {
          // 遥测读取失败即为 unknown，绝不猜测。
        }
      }
      const normalizedRuntime =
        runtime === "claude-code" || runtime === "codex" || runtime === "terminal" ? runtime : ("unknown" as const);
      return { ...a, runtime: normalizedRuntime, idle, idleSinceIso };
    });
  }

  private sessionRuntimes(): Map<string, string> {
    const out = new Map<string, string>();
    if (!this.tableExists("sessions") || !this.tableExists("nodes")) return out;
    try {
      const rows = this.db
        .prepare(
          `SELECT s.session_name AS session_name, n.runtime AS runtime
           FROM sessions s JOIN nodes n ON n.id = s.node_id
           WHERE s.session_name IS NOT NULL`,
        )
        .all() as Array<{ session_name: string; runtime: string | null }>;
      for (const r of rows) if (r.runtime) out.set(r.session_name, r.runtime);
    } catch {
      /* 降级为 unknown 运行时 */
    }
    return out;
  }

  /** 工作组 scope 的需要你处理：所有路由给人类的活动条目，不过滤标签。 */
  private attentionAll(): AttentionInput[] {
    if (!this.tableExists("queue_items")) return [];
    const hasEvidenceRef = this.columnExists("queue_items", "evidence_ref");
    const summaryCol = this.columnExists("queue_items", "summary") ? "summary" : "NULL AS summary";
    const rows = this.db
      .prepare(
        `SELECT qitem_id, ts_created, ts_updated, destination_session, state, priority, tier, tags, ${summaryCol},
                blocked_on, closure_required_at${hasEvidenceRef ? ", evidence_ref" : ""}
         FROM queue_items
         WHERE state IN (${ACTIVE_STATES.map(() => "?").join(",")})
           AND (tier = 'human-gate'
                OR destination_session LIKE 'human%'
                OR (state = 'blocked' AND blocked_on LIKE 'human%'))`,
      )
      .all(...ACTIVE_STATES) as Array<QitemRow & { evidence_ref?: string | null }>;
    return rows.map((r) => {
      // OPR.0.4.6.WF4 Q6 —— 从条目自身标签写入 ● 工作流指针；非工作流行省略该字段，
      // 通过省略保证字节一致性。
      const workflow = workflowRefFromTags(r.tags);
      return {
        qitemId: r.qitem_id,
        summary: r.summary,
        leg: r.state === "blocked" ? "park-on-human" : "human-routed",
        where: r.destination_session,
        createdAtIso: r.ts_created,
        priority: r.priority,
        tier: r.tier,
        evidenceRef: r.evidence_ref ?? null,
        unblocks: r.state === "blocked" ? r.qitem_id : null,
        destinationSession: r.destination_session,
        closureRequiredAtIso: r.closure_required_at,
        ...(workflow ? { workflow } : {}),
      };
    });
  }

  /** FR-4：从转换日志读取当天关闭的交接。已完成区与健康状态行中的交接计数来自同一
   *  查询，即两处渲染、一次计算。 */
  private settledToday(todayStartIso: string): { settled: SettledRow[]; handoffsToday: number } {
    if (!this.tableExists("queue_transitions")) return { settled: [], handoffsToday: 0 };
    const summaryJoin = this.tableExists("queue_items") && this.columnExists("queue_items", "summary")
      ? "LEFT JOIN queue_items q ON q.qitem_id = t.qitem_id"
      : null;
    try {
      const rows = this.db
        .prepare(
          `SELECT t.qitem_id AS qitem_id, t.ts AS ts, t.actor_session AS actor_session,
                  t.closure_target AS closure_target${summaryJoin ? ", q.summary AS summary" : ", NULL AS summary"}
           FROM queue_transitions t
           ${summaryJoin ?? ""}
           WHERE t.closure_reason = 'handed_off_to' AND t.ts >= ?
           ORDER BY t.ts DESC`,
        )
        .all(todayStartIso) as Array<{ qitem_id: string; ts: string; actor_session: string; closure_target: string | null; summary: string | null }>;
      const settled: SettledRow[] = rows.map((r) => ({
        fromSession: r.actor_session,
        toSession: r.closure_target ?? "unknown",
        summary: r.summary,
        closedAtIso: r.ts,
        qitemId: r.qitem_id,
      }));
      return { settled, handoffsToday: settled.length };
    } catch {
      return { settled: [], handoffsToday: 0 };
    }
  }

  /** FR-3/FR-4：整个工作组内已超过 closure_required_at 的处理中切片工作，同时供派生的
   *  需要你处理异常和健康状态计数使用。 */
  private overdueWork(nowIso: string): AttentionInput[] {
    if (!this.tableExists("queue_items")) return [];
    try {
      const summaryCol = this.columnExists("queue_items", "summary") ? "summary" : "NULL AS summary";
      const rows = this.db
        .prepare(
          `SELECT qitem_id, ts_created, ts_updated, destination_session, state, priority, tier, tags, ${summaryCol},
                  blocked_on, closure_required_at
           FROM queue_items
           WHERE state = 'in-progress'
             AND closure_required_at IS NOT NULL
             AND closure_required_at < ?
             AND tags LIKE '%"slice:%'`,
        )
        .all(nowIso) as QitemRow[];
      return rows.map((r) => {
        // OPR.0.4.6.WF4 Q6 —— 从条目自身标签写入 ● 工作流指针；非工作流行省略该字段，
        // 通过省略保证字节一致性。
        const workflow = workflowRefFromTags(r.tags);
        return {
          qitemId: r.qitem_id,
          summary: r.summary,
          leg: "overdue",
          where: r.destination_session,
          createdAtIso: r.ts_created,
          priority: r.priority,
          tier: r.tier,
          evidenceRef: null,
          unblocks: null,
          destinationSession: r.destination_session,
          closureRequiredAtIso: r.closure_required_at,
          ...(workflow ? { workflow } : {}),
        };
      });
    } catch {
      return [];
    }
  }

  private hasActiveQitem(name: string): boolean {
    if (!this.tableExists("queue_items")) return false;
    // 双层原则：这是信号层答案（phase / band / attention），只依据规范成员关系。展示层
    //（队列标签页的 qitemIds）可以使用受门控的旧式子串回退，但绝不能把展示层匹配提升
    // 为信号（P3）。
    //
    // B1 修复：移除 qitemIds（第 2 环节）的成员关系检查。它继承了 matchQitems 获准使用的
    // 旧式子串/正文回退，导致在没有类型信息的语料中，仅正文提及的行也会把
    // activeQitemPresent 提升为 true（phase BUILD），而严格区域却为空；这正是本切片要消除的
    // “一次组合、两个答案”偏差。等价性依据：任何可由规范规则确认的行一定包含字面子串
    // `slice:<name>`（P1 构造），因此第 1 环节不截断的预过滤能找到所有规范成员；第 2 环节
    // 只能增加非规范的展示层 ID，而这类 ID 恰恰不能进入阶段信号。
    //
    // 第 1 环节采用流式处理：iterate() 并在首次规范确认时 break。不使用 SQL LIMIT，
    // 因为确认前截断会在此重现 B2：大量后缀匹配可能遮住真实成员并翻转阶段信号。
    // 流式处理加 break 在成本同样有界的同时不会留下截断漏洞。
    const stmt = this.db.prepare(
      `SELECT tags FROM queue_items WHERE state IN (${ACTIVE_STATES.map(() => "?").join(",")}) AND tags LIKE ?`,
    );
    for (const r of stmt.iterate(...ACTIVE_STATES, `%slice:${name}%`) as Iterable<{ tags: string | null }>) {
      if (parseScopeTags(r.tags).slices.has(name)) return true;
    }
    return false;
  }

  /** §4 —— 两个分阶段审批印章（架构 F-A：已发布动词对应的 frontmatter 字段），每个都
   *  与固定的 scope 审批审计结构交叉核对，即 audit_notes_json 内的 `approval_scope`。
   *  印章没有匹配行时 auditVerified 为 false，并醒目渲染为 UNVERIFIED，但绝不阻塞。 */
  private gatherApproval(slice: SliceRecord, fm: Record<string, unknown>): ApprovalFacts {
    const str = (k: string): string | null => {
      const v = fm[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (v instanceof Date) return v.toISOString();
      return null;
    };
    const sliceId = str("id");

    const auditRowPresent = (approvalScope: "spec" | "delivery"): boolean => {
      if (!this.tableExists("mission_control_actions")) return false;
      try {
        return (
          this.db
            .prepare(
              `SELECT 1 FROM mission_control_actions
               WHERE action_verb='approve'
                 AND audit_notes_json LIKE ?
                 AND (audit_notes_json LIKE ? OR audit_notes_json LIKE ?)
               LIMIT 1`,
            )
            .get(
              `%"approval_scope":"${approvalScope}"%`,
              // null 切片 ID 绝不能匹配空 scope_id 行。
              sliceId ? `%"scope_id":"${sliceId}"%` : `%"scope_id":"${slice.name}"%`,
              `%${slice.name}%`,
            ) !== undefined
        );
      } catch {
        return false;
      }
    };

    const stamp = (byKey: string, atKey: string, approvalScope: "spec" | "delivery"): ApprovalStampFacts | null => {
      const by = str(byKey);
      const at = str(atKey);
      if (!by || !at) return null;
      return { by, at, auditRowPresent: auditRowPresent(approvalScope) };
    };

    return {
      spec: stamp("approved-spec-by", "approved-spec-at", "spec"),
      delivery: stamp("approved-by", "approved-at", "delivery"),
    };
  }

  private git(args: string[]): string | null {
    const gitRepoPath = this.gitRepoPath;
    if (!gitRepoPath) return null;
    try {
      return runSyncSite("review.gather.git", () =>
        execFileSync("git", args, { cwd: gitRepoPath, timeout: 4000, encoding: "utf8" })
      ).trim();
    } catch {
      return null;
    }
  }

  private gatherGitFacts(fm: Record<string, unknown>, candidateSha: string | null): GitFacts {
    const mainTip = this.git(["rev-parse", "--short", "HEAD"]) ?? "unknown";
    const sliceId = typeof fm["id"] === "string" ? (fm["id"] as string) : null;
    let mergeSha: string | null = null;
    if (sliceId) {
      const found = this.git(["log", "--fixed-strings", `--grep=Merge ${sliceId}`, "--format=%h", "-1"]);
      mergeSha = found && found.length > 0 ? found : null;
    }
    let mergeIsAncestorOfTip: boolean | null = null;
    if (mergeSha) {
      const out = this.git(["merge-base", "--is-ancestor", mergeSha, "HEAD"]);
      // 非祖先关系退出码为 1 时 exec 抛出异常并返回 null；成功时返回空字符串。
      mergeIsAncestorOfTip = out !== null;
    }
    let candidateBehindTip: number | null = null;
    if (!mergeSha && candidateSha) {
      const base = this.git(["merge-base", candidateSha, "HEAD"]);
      if (base) {
        const count = this.git(["rev-list", "--count", `${base}..HEAD`]);
        candidateBehindTip = count !== null && /^\d+$/.test(count) ? Number(count) : null;
      }
    }
    return { mainTip, mergeSha, mergeIsAncestorOfTip, candidateBehindTip };
  }
}
