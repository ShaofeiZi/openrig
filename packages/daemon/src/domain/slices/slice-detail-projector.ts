// 切片故事视图 v0 + v1——逐页签载荷投影器。
//
// 给定 SliceRecord（来自 SliceIndexer），组装覆盖全部六个 tab 的完整 per-slice payload：故事、验收、
// 决策、文档、测试/验证、拓扑。只读，不执行 mutation。组合已交付 table（queue_items、
// queue_transitions、mission_control_actions、workflow_specs、workflow_instances、
// workflow_step_trails）+ 磁盘上的 slice doc + dogfood-evidence。
//
// v1 enrichment（见 slices/slice-story-view-v1/IMPLEMENTATION-PRD.md）：workflow_instance
// 绑定到切片时启用四个维度——规格图拓扑、规格驱动的阶段标记、验收中的当前步骤与允许出口、
// 路由类型边元数据（按 audit-row-6 例外规则，v1 仅默认
// `direct`）。
//
// 按 PRD § 写集草图，v1 已移除 v0 硬编码的旧阶段分类
//（"discovery"/"product-lab"/"delivery"/"lifecycle"/"qa"/"other"）。StoryEvent.phase
// 现在是开放 string 或 null：绑定 workflow_instance 时值为 spec 定义的 step.id；否则为 null
//（UI 归入“未标记”）。

import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3";
import type { SliceIndexer, SliceRecord, SliceProofPacket } from "./slice-indexer.js";
import type { WorkflowSpecCache } from "../workflow-spec-cache.js";
import { sessionRigOf } from "../session-name.js";
import {
  findSliceWorkflowBinding,
  type SliceWorkflowBinding,
} from "../workflow/slice-workflow-binding.js";
import {
  isScaffoldPlaceholderText,
  GENERIC_SCAFFOLD_ACCEPTANCE,
  LEGACY_GENERIC_SCAFFOLD_ACCEPTANCE,
} from "../scope/scaffold-placeholder.js";
// VM-006（progress-review-done-coherence）：QA-verdict union 复用 Review 自己导出的 derivation pair
// + 唯一 proof-artifact reader（arch A1 one-home）——绝不二次派生。无 cycle：compose 是纯函数，
// proof-io 只 import compose + node；review 中没有内容 import slices。
import {
  extractProofContractSelected,
  composeDelivered,
  parseLogicalCheckboxes,
} from "../review/compose.js";
import { readSliceReadiness, type ScopeReadiness } from "../proof/judgments.js";
import { readProofArtifacts } from "../review/proof-io.js";
import { isNodeFile, resolveNodeFile } from "../scope/node-file.js";
import {
  projectSpecGraph,
  projectPhaseDefinitions,
  projectCurrentStep,
  type SpecGraphPayload,
  type PhaseDefinition,
  type CurrentStepPayload,
} from "../workflow/slice-workflow-projection.js";

export interface StoryEvent {
  ts: string;
  /** 事件通过工作流步骤轨迹追溯时的规格定义 step.id；事件未标记时为 null
   *（无轨迹映射，或切片未绑定 workflow_instance）。v1 已移除 v0 硬编码的旧 phase 枚举。 */
  phase: string | null;
  kind: string;
  actorSession: string | null;
  qitemId: string | null;
  summary: string;
  detail: Record<string, unknown> | null;
}

export interface AcceptanceItem {
  text: string;
  done: boolean;
  source: { file: string; line: number };
  /** VM-006（FR-4，增量）：有已编写证明契约的切片如何派生 `done`——作者勾选与 QA 判定提升。
   * 切片无已编写契约或行非 done 时完全省略；不要求使用方读取。 */
  doneVia?: "checkbox" | "qa-verdict";
}

/** VM-006（arch PIN-C）：acceptance dedup、Progress↔Review join 与 FS-1 guard 背后的唯一 key。
 *  逐字沿用历史 dedup expression——trim + casefold，并且刻意不折叠 whitespace。
 *
 * 三处共享同一个辅助函数，才能让“联结关系等于去重关系”成为代码事实，而非口头声明。
 * 若联结键比去重键更粗（例如移除行内图片，使 `X ![shot](a.png)` 与纯文本 `X` 折叠到一起），
 * 就会把两条不同验收行映射到同一义务，并静默提升错误的行；后继实现正是为了消除这种
 * B1 冲突。 */
function textKey(text: string): string {
  return text.trim().toLowerCase();
}

export interface AcceptancePayload {
  totalItems: number;
  doneItems: number;
  percentage: number;
  items: AcceptanceItem[];
  closureCallout: string | null;
  /** v1 维度 #3：已绑定 workflow_instance 的当前步骤和规格声明的允许下一步。
   * 切片无绑定实例时为 null（UI 只回退到 PROGRESS.md 复选框视图）。 */
  currentStep: CurrentStepPayload | null;
}

export interface DecisionRow {
  actionId: string;
  ts: string;
  actor: string;
  verb: string;
  qitemId: string;
  reason: string | null;
  beforeState: string | null;
  afterState: string | null;
}

export interface DocsTreeEntry {
  name: string;
  type: "file" | "dir";
  size: number | null;
  mtime: string | null;
  /** 切片目录下的相对路径。 */
  relPath: string;
}

export interface ProofPacketRendered {
  dirName: string;
  /** 主 Markdown 文件（mtime 最新）。 */
  primaryMarkdown: { relPath: string; content: string } | null;
  /** 证明包目录中的所有其他 Markdown 文件（最新优先）。 */
  additionalMarkdown: Array<{ relPath: string; content: string }>;
  /** 适合由 /api/slices/:name/proof-asset/<path> 提供的截图相对路径。 */
  screenshots: string[];
  /** 适合 <video> 播放器的视频相对路径。 */
  videos: string[];
  /** 追踪 zip 相对路径（仅提供下载链接，不自动渲染）。 */
  traces: string[];
  /** 从主 Markdown 内容启发式派生的通过/失败徽标。 */
  passFailBadge: "pass" | "fail" | "partial" | "unknown";
}

export interface TopologyRigEntry {
  rigId: string;
  rigName: string;
  sessionNames: string[];
}

export interface TopologyPayload {
  affectedRigs: TopologyRigEntry[];
  /** 跨所有工作组触及此切片的唯一席位总数。 */
  totalSeats: number;
  /** v1 维度 #1：切片绑定 workflow_instance 时的 workflow_spec 图（节点和边）。
   * 未绑定时为 null（UI 回退到 v0 逐工作组会话列表）。 */
  specGraph: SpecGraphPayload | null;
}

export interface WorkflowBindingPayload {
  instanceId: string;
  workflowName: string;
  workflowVersion: string;
  status: string;
  currentStepId: string | null;
  currentFrontier: string[];
  hopCount: number;
  createdAt: string;
  completedAt: string | null;
  /** 同样触及此切片 qitem 集合的其他 workflow_instance；v1 按 PRD 选择最新项作为主绑定，
   * 并在此暴露其余项，使 UI 可渲染“还有 N 个”指示器。 */
  additionalInstanceIds: string[];
}

export interface SliceDetailPayload {
  readiness: ScopeReadiness;
  name: string;
  missionId: string | null;
  slicePath: string;
  displayName: string;
  railItem: string | null;
  status: string;
  rawStatus: string | null;
  qitemIds: string[];
  commitRefs: string[];
  lastActivityAt: string | null;
  /** v1：bound workflow_instance metadata（多个时取最新）；没有 workflow_instance 触及此 slice
   *  qitem 时为 null。 */
  workflowBinding: WorkflowBindingPayload | null;
  story: {
    events: StoryEvent[];
    /** v1 dimension #2：bound 时为 spec 声明的 phase definition；unbound 时为 null
     *  （UI 回退到不分组的时间顺序）。 */
    phaseDefinitions: PhaseDefinition[] | null;
  };
  acceptance: AcceptancePayload;
  decisions: { rows: DecisionRow[] };
  docs: { tree: DocsTreeEntry[] };
  tests: { proofPackets: ProofPacketRendered[]; aggregate: { passCount: number; failCount: number } };
  topology: TopologyPayload;
}

export interface SliceDetailProjectorOpts {
  db: Database.Database;
  indexer: SliceIndexer;
  /** v1：可选 WorkflowSpecCache，用于解析 bound workflow_instance spec，以供 spec-graph + phase +
   *  current-step projection。省略时 projector 静默降级为 v0 行为（所有内容照旧渲染；v1 字段为 null）。 */
  workflowSpecCache?: WorkflowSpecCache;
}

export class SliceDetailProjector {
  private readonly db: Database.Database;
  private readonly indexer: SliceIndexer;
  private readonly workflowSpecCache: WorkflowSpecCache | undefined;

  constructor(opts: SliceDetailProjectorOpts) {
    this.db = opts.db;
    this.indexer = opts.indexer;
    this.workflowSpecCache = opts.workflowSpecCache;
  }

  withIndexer(indexer: SliceIndexer): SliceDetailProjector {
    return new SliceDetailProjector({ db: this.db, indexer, workflowSpecCache: this.workflowSpecCache });
  }

  project(slice: SliceRecord): SliceDetailPayload {
    // v1：只解析一次 workflow_instance 绑定；已绑定规格驱动四个下游维度
    //（故事阶段标记、规格图、当前步骤、阶段定义）。未绑定或规格不再缓存
    //（例如操作人员删除规格文件）时，所有 v1 字段返回 null，并应用 v0 兜底。
    const bindingResult = findSliceWorkflowBinding(this.db, slice.qitemIds);
    const binding = bindingResult.primary;
    const spec = binding && this.workflowSpecCache
      ? this.tryGetSpec(binding.workflowName, binding.workflowVersion)
      : null;
    const trailQitemToStep = binding ? this.buildTrailQitemToStepMap(binding.instanceId) : new Map<string, string>();

    const readiness = readSliceReadiness(slice.slicePath);
    return {
      readiness,
      name: slice.name,
      missionId: slice.missionId,
      slicePath: slice.slicePath,
      displayName: slice.displayName,
      railItem: slice.railItem,
      status: slice.status,
      rawStatus: slice.rawStatus,
      qitemIds: slice.qitemIds,
      commitRefs: slice.commitRefs,
      lastActivityAt: slice.lastActivityAt,
      workflowBinding: binding ? {
        instanceId: binding.instanceId,
        workflowName: binding.workflowName,
        workflowVersion: binding.workflowVersion,
        status: binding.status,
        currentStepId: binding.currentStepId,
        currentFrontier: binding.currentFrontier,
        hopCount: binding.hopCount,
        createdAt: binding.createdAt,
        completedAt: binding.completedAt,
        additionalInstanceIds: bindingResult.additionalInstanceIds,
      } : null,
      story: {
        events: this.buildStory(slice, trailQitemToStep),
        phaseDefinitions: spec ? projectPhaseDefinitions(spec) : null,
      },
      acceptance: {
        ...this.buildAcceptance(slice, readiness),
        currentStep: spec && binding
          ? projectCurrentStep(spec, binding.currentStepId, binding.hopCount, binding.status)
          : null,
      },
      decisions: { rows: this.buildDecisions(slice) },
      docs: { tree: this.buildDocsTree(slice) },
      tests: this.buildTests(slice.proofPacket),
      topology: {
        ...this.buildTopology(slice),
        specGraph: spec && binding ? projectSpecGraph(spec, binding.currentStepId) : null,
      },
    };
  }

  // --- v1 helper ---

  private tryGetSpec(name: string, version: string) {
    if (!this.workflowSpecCache) return null;
    try {
      const row = this.workflowSpecCache.getByNameVersion(name, version);
      return row?.spec ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 读取 bound instance 的 workflow_step_trails，构建 qitem_id → step_id map。每个 trail row 的
   * prior_qitem_id 映射到关闭它的 step（`step_id`），next_qitem_id 映射到后续 step 的首个 packet。
   * buildStory 用它为每个 StoryEvent 标记 qitem 可追溯到的 spec-defined phase。
   */
  private buildTrailQitemToStepMap(instanceId: string): Map<string, string> {
    const map = new Map<string, string>();
    try {
      const trails = this.db.prepare(
        `SELECT step_id, prior_qitem_id, next_qitem_id
           FROM workflow_step_trails
           WHERE instance_id = ?`
      ).all(instanceId) as Array<{
        step_id: string;
        prior_qitem_id: string;
        next_qitem_id: string | null;
      }>;
      for (const t of trails) {
        // prior_qitem_id 是在 step_id 处关闭的 qitem——该 qitem 的 event 属于 step_id phase。
        map.set(t.prior_qitem_id, t.step_id);
      }
    } catch {
      // workflow_step_trails 缺失——空 map（event 未标记）。
    }
    return map;
  }

  // --- 故事 tab ---

  private buildStory(slice: SliceRecord, trailQitemToStep: Map<string, string>): StoryEvent[] {
    const events: StoryEvent[] = [];
    // v1：已绑定时，阶段标记等于轨迹映射中的规格 step.id，否则为 null。
    // v0 硬编码的旧阶段分类已移除。
    const phaseFor = (qitemId: string | null): string | null =>
      qitemId ? trailQitemToStep.get(qitemId) ?? null : null;

    if (slice.qitemIds.length > 0) {
      const placeholders = slice.qitemIds.map(() => "?").join(",");

      // queue_items 创建/交接快照行。使用行自身作为按 ts_created 索引的“创建”事件，
      // 并在 ts_updated 加入逐行状态字段。queue_transitions 提供逐次转换历史。
      try {
        // OPR.0.4.1.18：使用 SELECT *（而非显式列清单），使迁移 044 之前的 queue_items 规范
        //（没有 `summary` 列，例如最小测试夹具）不会在此抛错；此时 r.summary 为 undefined，
        // 下方降级逻辑生效。行类型中的 summary 也因此为可选。
        const qrows = this.db.prepare(
          `SELECT * FROM queue_items WHERE qitem_id IN (${placeholders})`
        ).all(...slice.qitemIds) as Array<{
          qitem_id: string; ts_created: string; source_session: string;
          destination_session: string; state: string; body: string; tier: string | null;
          summary?: string | null;
        }>;
        for (const r of qrows) {
          events.push({
            ts: r.ts_created,
            phase: phaseFor(r.qitem_id),
            kind: "queue.created",
            actorSession: r.source_session,
            qitemId: r.qitem_id,
            // OPR.0.4.1.18（兼容修复）：优先使用人工编写的摘要；为 null/缺失时
            //（版本 18 之前的 qitem 或作者遗漏项）降级为来源→目标加正文截断。保持
            // StoryEvent.summary 非 null。
            summary: r.summary ?? `${r.source_session} → ${r.destination_session}: ${truncate(r.body, 100)}`,
            detail: { tier: r.tier, state: r.state },
          });
        }
      } catch {
        // queue_items 缺失——跳过
      }

      // queue_transitions（per-state-change log；按 PL-004 Phase A schema append-only）。
      try {
        const trows = this.db.prepare(
          `SELECT qitem_id, ts, state, transition_note, actor_session, closure_reason
             FROM queue_transitions WHERE qitem_id IN (${placeholders})
             ORDER BY ts, transition_id`
        ).all(...slice.qitemIds) as Array<{
          qitem_id: string; ts: string; state: string;
          transition_note: string | null; actor_session: string;
          closure_reason: string | null;
        }>;
        for (const t of trows) {
          const note = t.transition_note ?? t.closure_reason;
          events.push({
            ts: t.ts,
            phase: phaseFor(t.qitem_id),
            kind: `transition.${t.state}`,
            actorSession: t.actor_session,
            qitemId: t.qitem_id,
            summary: `→ ${t.state}${note ? ` (${truncate(note, 60)})` : ""}`,
            detail: null,
          });
        }
      } catch {
        // queue_transitions 缺失——跳过
      }

      // mission_control_actions（操作人员动作；PL-005 阶段 A 迁移 037）。
      try {
        const arows = this.db.prepare(
          `SELECT action_id, acted_at, qitem_id, action_verb, actor_session,
                  before_state_json, after_state_json, reason, annotation
             FROM mission_control_actions WHERE qitem_id IN (${placeholders})
             ORDER BY acted_at, rowid`
        ).all(...slice.qitemIds) as Array<{
          action_id: string; acted_at: string; qitem_id: string;
          action_verb: string; actor_session: string;
          before_state_json: string | null; after_state_json: string | null;
          reason: string | null; annotation: string | null;
        }>;
        for (const a of arows) {
          const note = a.annotation ?? a.reason;
          events.push({
            ts: a.acted_at,
            phase: phaseFor(a.qitem_id),
            kind: `mission_control.${a.action_verb}`,
            actorSession: a.actor_session,
            qitemId: a.qitem_id,
            summary: `${a.actor_session} ${a.action_verb}${note ? `: ${truncate(note, 60)}` : ""}`,
            detail: { before: a.before_state_json, after: a.after_state_json },
          });
        }
      } catch {
        // mission_control_actions 缺失——跳过
      }
    }

    // 切片文档编辑（切片目录内的 mtime）。v1：无阶段标记，因为它们不与 qitem 绑定，无法追溯到
    // 规格步骤。UI 会将其归入“未标记”，或不带标记渲染。
    try {
      const sliceDir = slice.slicePath;
      const docEntries = fs.readdirSync(sliceDir, { withFileTypes: true });
      for (const entry of docEntries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const st = fs.statSync(path.join(sliceDir, entry.name));
        events.push({
          ts: st.mtime.toISOString(),
          phase: null,
          kind: "doc.edited",
          actorSession: null,
          qitemId: null,
          summary: `文档已编辑：${entry.name}`,
          detail: null,
        });
      }
    } catch {
      // slice folder 不可读——跳过
    }

    // proof packet 发出——每个 packet 一条 event，使用 directory mtime。v1：同样未标记
    //（不与 qitem 绑定）。
    if (slice.proofPacket) {
      events.push({
        ts: slice.proofPacket.mtime,
        phase: null,
        kind: "proof_packet.emitted",
        actorSession: null,
        qitemId: null,
        summary: `Proof packet 已发出：${slice.proofPacket.dirName}`,
        detail: {
          markdownCount: slice.proofPacket.markdownFiles.length,
          screenshotCount: slice.proofPacket.screenshots.length,
          videoCount: slice.proofPacket.videos.length,
        },
      });
    }

    events.sort((a, b) => a.ts.localeCompare(b.ts));
    return events;
  }

  // --- 验收 tab ---

  private buildAcceptance(slice: SliceRecord, readiness: ScopeReadiness): Omit<AcceptancePayload, "currentStep"> {
    const items: AcceptanceItem[] = [];
    // 从 README、IMPLEMENTATION-PRD 和 PROGRESS.md 解析 [ ]/[x] 复选框行。来源引用由文件名和
    // 从 1 开始的行号组成，使操作人员可直接跳转。
    const sliceDir = slice.slicePath;
    // 只扫描一次已选择的节点文件。若同时扫描并存的 SPEC.md 与 README.md，会连被遮蔽文件也解析，
    // 使它与当前文件共享的每个复选框都变成第二条验收行，把重复或陈旧契约呈现为切片自身内容。
    const selectedNode = resolveNodeFile(sliceDir);
    const candidateFiles = [
      ...(selectedNode ? [path.basename(selectedNode)] : []),
      "IMPLEMENTATION-PRD.md",
      "PROGRESS.md",
      "IMPLEMENTATION.md",
    ];
    // VM-006：在现有扫描中捕获 PRD 字节，下方证明契约提取不新增 IO。
    // PM 自用验证 #1：以相同方式捕获 README 字节（本次扫描已读取），使契约提取可应用逐章节选择。
    let prdContent: string | null = null;
    let readmeContent: string | null = null;
    let specContent: string | null = null;
    let readmeFileContent: string | null = null;
    for (const fname of candidateFiles) {
      const full = path.join(sliceDir, fname);
      if (!fs.existsSync(full)) continue;
      const content = fs.readFileSync(full, "utf8");
      if (fname === "IMPLEMENTATION-PRD.md") prdContent = content;
      // SPEC.md 与旧 README.md 承担同一角色；存在的文件承载下方契约提取所读取的节点正文。
      if (isNodeFile(fname) && readmeContent === null) readmeContent = content;
      // KI-5.3-2 第二面：分别捕获 SPEC 与 README，使单一归属的来源选择如实标注
      //（spec 与 readme），同时由选择顺序保留节点文件优先级（SPEC 优先）。
      if (fname === "SPEC.md") specContent = content;
      if (fname === "README.md") readmeFileContent = content;
      // qitem-render-driver B——共享逻辑复选框关系（评审证明契约使用的同一解析器）。rawText
      // 携带所有拼接的续行，且正是 VM-006 联结键，因此验收行与承诺项在结构上按相同字节索引；
      // 此处若使用第二个解析器，会静默破坏 QA 判定提升的同步。
      for (const logical of parseLogicalCheckboxes(content)) {
        // release-0.4.7 意图阶段（编辑 1）：脚手架模板占位行不是验收项
        //（共享语法：../scope/scaffold-placeholder.ts）。
        if (isScaffoldPlaceholderText(logical.rawText)) continue;
        items.push({
          // rawText 保持不变：带图片的行保留作者字节，从而维持联结关系。
          text: logical.rawText,
          done: logical.checked,
          source: { file: fname, line: logical.sourceLine },
        });
      }
    }
    // release-0.4.7 意图阶段（编辑 2）：按规范化文本（大小写折叠 + trim）去重。来源跳转链接与
    // 完成状态均以首次出现项为准，由 candidateFiles 扫描顺序确定
    //（README > IMPLEMENTATION-PRD > PROGRESS > IMPLEMENTATION）。
    const seenText = new Set<string>();
    const deduped: AcceptanceItem[] = [];
    for (const item of items) {
      const key = textKey(item.text);
      if (seenText.has(key)) continue;
      seenText.add(key);
      deduped.push(item);
    }
    // release-0.4.7 意图阶段（编辑 3）：仅在原封未动时跳过通用脚手架三项，即三个
    // slice-progress.md 字面量都存在、均未勾选，且是 PROGRESS.md 唯一的复选框行。任意勾选、
    // 文本编辑或新增 PROGRESS 行都会使它们成为真实项（架构 AR-6：最严格初始态；多计噪声优于
    // 静默少计有意保留项，勾选或编辑任一项仍可表达有意保留）。
    const progressRows = deduped.filter((i) => i.source.file === "PROGRESS.md");
    const pristineTriples = [
      GENERIC_SCAFFOLD_ACCEPTANCE,
      LEGACY_GENERIC_SCAFFOLD_ACCEPTANCE,
    ];
    const pristineTriple = progressRows.every((i) => !i.done)
      && pristineTriples.some((triple) =>
        progressRows.length === triple.length
        && triple.every((lit) => progressRows.some((i) => i.text === lit)),
      );
    let finalItems = pristineTriple
      ? deduped.filter((i) => i.source.file !== "PROGRESS.md")
      : deduped;
    // VM-006（进度、评审与完成一致性）：合并证明契约行的完成状态，即 done =
    // checkboxTicked OR qaVerified。评审从 QA 通过判定派生 `verified`，而这里的勾选状态
    // 永远不动（`zrig proof add` 不会勾选作者复选框），因此两个页签曾对同一义务得出
    // 不同结论。
    //
    // 联结是在 `textKey` 上受多重性守卫控制的 1:1 关联，取自两侧原始作者文本
    //（`promised.rawText` 与 `item.text`）。两侧都使用原始文本，正是保证联结关系与上方去重关系
    // 相同的原因。若用剥离后的承诺文本与原始行文本联结，就需要更粗粒度的比较器，而更粗的关系
    // 会把两个不同行折叠到一个义务，并错误提升非契约行；这就是前代 0ec6411c 的守卫 BLOCKING
    // 所指出的 B1 冲突。
    //
    // 1:1 守卫：键对应多个义务或多行时不提升任何内容，从结构上保证 PM 的 FR-2 不变量，而非
    // 依赖论证：(1) 仅通过与单个已验证义务的 1:1 关联提升；(2) 进度中的验证提升数量绝不超过
    // 评审验证数量。使用原始键时，两种冲突彼此区分，因此守卫在真实切片上启用但不动作；
    // 它实际用于两条逐字相同作者契约行的退化情况，此时失败关闭（保持 ACTIVE）优于随机提升
    //（arch AR-6）。
    //
    // 永不设置 done=false，绝不逆转作者记录（FR-3）。PM 自用验证 #1：使用 Review compose
    // 的同一逐章节选择（一个选择规则、一个语法归属）：已编写 README 契约优先于仍为初始脚手架的
    // PRD 契约，因此 VM-006 提升会与作者实际编写的契约联结。
    const promised = extractProofContractSelected(prdContent, readmeFileContent, specContent).items;
    if (promised.length > 0) {
      const promisedByKey = new Map<string, number[]>();
      promised.forEach((p, i) => {
        const k = textKey(p.rawText);
        const at = promisedByKey.get(k);
        if (at) at.push(i);
        else promisedByKey.set(k, [i]);
      });
      const rowsByKey = new Map<string, AcceptanceItem[]>();
      for (const item of finalItems) {
        const k = textKey(item.text);
        const at = rowsByKey.get(k);
        if (at) at.push(item);
        else rowsByKey.set(k, [item]);
      }
      // FS-1 guard（arch-endorsed）：buildAcceptance 在“进度”tab 上跨整个 mission 按 slice 运行，
      // 因此只有 authored contract 仍有 unticked row 时才读取 proof-dir——union 只能 lift，所以
      // all-ticked 与 contract-free slice 不产生额外 IO。使用与 join 相同的 textKey：若 guard 使用
      // 不同 relation，可能跳过 join 原本会 lift 的 row。
      const hasUntickedContractRow = finalItems.some(
        (i) => !i.done && promisedByKey.has(textKey(i.text)),
      );
      if (hasUntickedContractRow) {
        // Review 使用的唯一 reader（arch A1 one-home）+ Review 自己的 join：composeDelivered 将
        // `verified` 绑定到 promised index，这里读取 items[i].verified——绝不再次派生 verdict。
        const delivered = composeDelivered(promised, readProofArtifacts(sliceDir));
        for (const item of finalItems) {
          if (item.done) continue;
          const k = textKey(item.text);
          const at = promisedByKey.get(k);
          if (!at || at.length !== 1) continue;
          if (rowsByKey.get(k)?.length !== 1) continue;
          if (delivered.items[at[0]!]!.verified !== "verified") continue;
          item.done = true;
          item.doneVia = "qa-verdict";
        }
      }
      for (const item of finalItems) {
        if (item.done && item.doneVia === undefined) item.doneVia = "checkbox";
      }
    }
    if (readiness.configured) {
      // 当前 acceptance 是已选择 contract。其他 checkbox row 保持为 historical source。
      finalItems = readiness.items.map(item => ({ text: item.text, done: !readiness.issues.length && item.state === "accepted", source: item.source }));
    }
    const total = finalItems.length;
    const done = finalItems.filter((i) => i.done).length;
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);
    const closureCallout = readiness.configured ? `当前 proof readiness：${readiness.state} · ${readiness.revision.slice(0, 12)}` : slice.status === "done"
      ? `目标已达成（status：${slice.rawStatus ?? "done"}）`
      : null;
    return {
      totalItems: total,
      doneItems: done,
      percentage: pct,
      items: finalItems,
      closureCallout,
    };
  }

  // --- 决策 tab ---

  private buildDecisions(slice: SliceRecord): DecisionRow[] {
    if (slice.qitemIds.length === 0) return [];
    try {
      const placeholders = slice.qitemIds.map(() => "?").join(",");
      const rows = this.db.prepare(
        `SELECT action_id, acted_at, actor_session, action_verb, qitem_id,
                before_state_json, after_state_json, reason, annotation
           FROM mission_control_actions
           WHERE qitem_id IN (${placeholders})
           ORDER BY acted_at DESC, rowid DESC`
      ).all(...slice.qitemIds) as Array<{
        action_id: string; acted_at: string; actor_session: string;
        action_verb: string; qitem_id: string;
        before_state_json: string | null; after_state_json: string | null;
        reason: string | null; annotation: string | null;
      }>;
      return rows.map((r) => ({
        actionId: r.action_id,
        ts: r.acted_at,
        actor: r.actor_session,
        verb: r.action_verb,
        qitemId: r.qitem_id,
        reason: r.annotation ?? r.reason,
        beforeState: r.before_state_json,
        afterState: r.after_state_json,
      }));
    } catch {
      return [];
    }
  }

  // --- 文档 tab ---

  private buildDocsTree(slice: SliceRecord): DocsTreeEntry[] {
    const sliceDir = slice.slicePath;
    const out: DocsTreeEntry[] = [];
    const walk = (dir: string, relPrefix: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          out.push({ name: entry.name, type: "dir", size: null, mtime: null, relPath: rel });
          walk(full, rel);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const st = fs.statSync(full);
          out.push({
            name: entry.name,
            type: "file",
            size: st.size,
            mtime: st.mtime.toISOString(),
            relPath: rel,
          });
        } catch {
          // 跳过
        }
      }
    };
    walk(sliceDir, "");
    out.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return out;
  }

  /** 从 slice folder 读取单个 doc 文件供文档 tab 使用。文件缺失或超出 slice folder 时返回 null。 */
  readDoc(sliceName: string, relPath: string): string | null {
    const slice = this.indexer.get(sliceName);
    if (!slice) return null;
    const sliceDir = slice.slicePath;
    const resolved = path.resolve(sliceDir, relPath);
    if (!resolved.startsWith(`${path.resolve(sliceDir)}${path.sep}`) && resolved !== path.resolve(sliceDir)) {
      // 路径穿越守卫。
      return null;
    }
    try {
      return fs.readFileSync(resolved, "utf8");
    } catch {
      return null;
    }
  }

  // --- 测试 / 验证 tab ---

  private buildTests(proofPacket: SliceProofPacket | null): SliceDetailPayload["tests"] {
    if (!proofPacket) {
      return { proofPackets: [], aggregate: { passCount: 0, failCount: 0 } };
    }
    const additionalMarkdown: ProofPacketRendered["additionalMarkdown"] = [];
    let primaryMarkdown: ProofPacketRendered["primaryMarkdown"] = null;
    for (let i = 0; i < proofPacket.markdownFiles.length; i++) {
      const rel = proofPacket.markdownFiles[i]!;
      const content = this.readProofAsset(proofPacket, rel) ?? "";
      if (i === 0) {
        primaryMarkdown = { relPath: rel, content };
      } else {
        additionalMarkdown.push({ relPath: rel, content });
      }
    }
    const passFailBadge = inferPassFailBadge(primaryMarkdown?.content ?? "");
    const rendered: ProofPacketRendered = {
      dirName: proofPacket.dirName,
      primaryMarkdown,
      additionalMarkdown,
      screenshots: proofPacket.screenshots,
      videos: proofPacket.videos,
      traces: proofPacket.traces,
      passFailBadge,
    };
    return {
      proofPackets: [rendered],
      aggregate: {
        passCount: passFailBadge === "pass" ? 1 : 0,
        failCount: passFailBadge === "fail" ? 1 : 0,
      },
    };
  }

  /**
   * 读取 proof-packet asset（Markdown content，或检查 screenshot/video 等 binary file 是否
   * 存在）。通过 absPath prefix 检查防止 path traversal。
   */
  readProofAsset(proofPacket: SliceProofPacket, relPath: string): string | null {
    const resolved = path.resolve(proofPacket.absPath, relPath);
    if (!resolved.startsWith(`${path.resolve(proofPacket.absPath)}${path.sep}`)) {
      return null;
    }
    try {
      return fs.readFileSync(resolved, "utf8");
    } catch {
      return null;
    }
  }

  /** 返回 proof asset 的磁盘绝对路径以提供 binary serving。带 path-traversal guard。 */
  resolveProofAssetPath(proofPacket: SliceProofPacket, relPath: string): string | null {
    const resolved = path.resolve(proofPacket.absPath, relPath);
    if (!resolved.startsWith(`${path.resolve(proofPacket.absPath)}${path.sep}`)) {
      return null;
    }
    try {
      const st = fs.statSync(resolved);
      if (!st.isFile()) return null;
      return resolved;
    } catch {
      return null;
    }
  }

  // --- 拓扑 tab ---

  private buildTopology(slice: SliceRecord): Omit<TopologyPayload, "specGraph"> {
    if (slice.qitemIds.length === 0) {
      return { affectedRigs: [], totalSeats: 0 };
    }
    try {
      const placeholders = slice.qitemIds.map(() => "?").join(",");
      const rows = this.db.prepare(
        `SELECT DISTINCT source_session, destination_session
           FROM queue_items WHERE qitem_id IN (${placeholders})`
      ).all(...slice.qitemIds) as Array<{ source_session: string; destination_session: string }>;

      const sessionsByRig = new Map<string, Set<string>>();
      for (const r of rows) {
        for (const s of [r.source_session, r.destination_session]) {
          if (!s) continue;
          const rig = sessionRigKey(s);
          const set = sessionsByRig.get(rig) ?? new Set<string>();
          set.add(s);
          sessionsByRig.set(rig, set);
        }
      }

      // 尽可能从 rigs table 解析工作组 display name。若工作组未在本地注册（例如来自其他 host 的
      // session name），则保留 parsed key 作为 placeholder rigId。
      const rigNames = new Map<string, string>();
      try {
        const rigRows = this.db.prepare(
          `SELECT id, name FROM rigs`
        ).all() as Array<{ id: string; name: string }>;
        for (const r of rigRows) rigNames.set(r.name, r.id);
      } catch {
        // rigs table 不可用——回退为将 parsed key 同时用作 id 与 name。
      }

      const affectedRigs: TopologyRigEntry[] = [];
      for (const [rigKey, sessionSet] of sessionsByRig) {
        affectedRigs.push({
          rigId: rigNames.get(rigKey) ?? rigKey,
          rigName: rigKey,
          sessionNames: Array.from(sessionSet).sort(),
        });
      }
      affectedRigs.sort((a, b) => a.rigName.localeCompare(b.rigName));

      const totalSeats = Array.from(sessionsByRig.values()).reduce((sum, set) => sum + set.size, 0);
      return { affectedRigs, totalSeats };
    } catch {
      return { affectedRigs: [], totalSeats: 0 };
    }
  }

  // v1：已移除 classifyPhase() heuristic——phase tagging 现在由 spec 驱动（通过
  // buildTrailQitemToStepMap 中的 workflow_step_trails join）；未绑定 workflow_instance 时为 null
  //（未标记）。v0 硬编码的旧阶段分类（根据会话名子串推断的
  // "discovery"/"product-lab"/"delivery"/"lifecycle"/"qa"/"other"）已移除。遵循
  // slices/slice-story-view-v1/IMPLEMENTATION-PRD.md § 写集草图，提交消息已明确
  // 记录删除。
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

function sessionRigKey(session: string): string {
  // Session 通常为 "<member>@<rig>"——rig 部分是 key。non-canonical name（无 @、legacy、
  // malformed）自身作为 rig key。OPR.0.4.6.MH1 FR-8：共享 parse contract（从首个 @ 贪婪取 rig）。
  return sessionRigOf(session) ?? session;
}

function inferPassFailBadge(content: string): "pass" | "fail" | "partial" | "unknown" {
  if (!content) return "unknown";
  const lower = content.toLowerCase();
  if (/\b(accept|accepted|passed|all green|all pass|fully green|green after fix|complete|✅|🟢)/.test(lower)) return "pass";
  if (/\b(blocker|blocked|fail|red|🔴|❌)/.test(lower)) return "fail";
  if (/\b(partial|partially|in progress|standing by)/.test(lower)) return "partial";
  return "unknown";
}
