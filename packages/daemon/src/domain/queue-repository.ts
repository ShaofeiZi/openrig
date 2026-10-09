import { readWakeLadderBackstop } from "./queue-wake-ladder.js";
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { EventBus } from "./event-bus.js";
import { loadHumanRegistry, resolveRegisteredHumanAddress, type LoadResult } from "./gateway/human-registry.js";
import { resolveExternal } from "./gateway/external-admission.js";
import type { PersistedEvent } from "./types.js";
import { QueueTransitionLog, type OwnerNotificationLevel, type RecentQueueTransitionScope } from "./queue-transition-log.js";
import { WAKE_INTENT_PREFIX, type OutboxHandler } from "./outbox-handler.js";
import { derivePickup, type PickupReceipt } from "./queue-pickup.js";
import { lastMeaningfulTransition, readWaitingView, type WaitingView, type WaitingActivityReader } from "./queue-waiting.js";
import { wrapPaneEnvelope } from "../lib/pane-envelope.js";
import { getSelfHostId } from "./hosts/fanout-contract.js";
import { parseSessionName, isHumanSeatSessionRef } from "./session-name.js";
import { classifyDestination } from "./gateway/destination-resolver.js";
import {
  computeClosureRequiredAt,
  validateClosure,
  type ClosureReason,
} from "./hot-potato-enforcer.js";
import { isHumanSeatSession, validateHumanPark, validateHumanRoute } from "./human-route-enforcer.js";
import {
  QueueWakeRepository,
  USAGE_LIMIT_BLOCKER_TAG,
  type ParkWakeStatus,
} from "./queue-wake-repository.js";
import { WatchdogJobsRepository } from "./watchdog-jobs-repository.js";
import { armQueueWait, backOffQueueWait, refreshQueueWaits, evaluateQueueWait, retargetQueueWait } from "./queue-wait-backoff.js";

export const QUEUE_STATES = [
  "pending",
  "in-progress",
  "done",
  "blocked",
  "failed",
  "denied",
  "canceled",
  "handed-off",
] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

/** OPR.0.4.6.FS-1（W2 P1）：queue terminal 状态集合，仅命名一次。archiver
 *（queue-retention.ts）与下方行内 closure guard 都使用此 predicate，因此未来新增 terminal 状态时，
 * archiver 与 queue 绝不会静默分歧（arch D3-REFINEMENT P1；只扩宽，不另建同级项）。
 * `['done','handed-off']` 是完整 terminal 集合——workflow step closure 从
 * `handoff -> state=handed-off` 退出，这是数量最多的 terminal 类别。`satisfies` 子句是编译守卫：
 * 从 QUEUE_STATES 删除状态会在此失败。 */
export const TERMINAL_QUEUE_STATES = ["done", "handed-off"] as const satisfies readonly QueueState[];
export function isTerminalState(state: string): boolean {
  return (TERMINAL_QUEUE_STATES as readonly string[]).includes(state);
}

/** 0.5.1-53——active（仍在推进）状态。blocker 当且仅当 active 时才“存活”；其他状态
 *（done/handed-off/canceled/denied/failed）表示阻塞永远不会解除。该概念与 archiver 的
 * TERMINAL_QUEUE_STATES（done/handed-off）不同且更窄，因此单独命名并从 QUEUE_STATES 派生
 *（若删除状态，`satisfies` 守卫会失败）。 */
export const ACTIVE_QUEUE_STATES = ["pending", "in-progress", "blocked"] as const satisfies readonly QueueState[];
export function isBlockerLive(state: string): boolean {
  return (ACTIVE_QUEUE_STATES as readonly string[]).includes(state);
}

const AUTO_UNPARK_WAKE_TAG = "queue:auto-unpark:blocker";
const AUTO_UNPARK_BLOCKER_TAG_PREFIX = "queue:auto-unpark:blocker-ref:";

/** 0.5.1-53 Atom 1a——类型化非 qitem gate blocker 前缀。park 可能受 fold/auth/external 条件
 * 门控，这类条件既不是 qitem 也不是 human seat；这些前缀使 gate 成为一等、compact 可见且下游
 * 可分类的 blocker（裁定详情随 transition 传递）。 */
export const TYPED_GATE_BLOCKER_PREFIXES = ["fold:", "auth:", "external:"] as const;
export function typedGateBlockerPrefix(value: string): string | null {
  return TYPED_GATE_BLOCKER_PREFIXES.find((p) => value.startsWith(p)) ?? null;
}
/** 格式正确的类型化 gate blocker：已识别前缀并且 gate body 非空。 */
export function isTypedGateBlocker(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const p = typedGateBlockerPrefix(value);
  return p != null && value.slice(p.length).trim().length > 0;
}

/**
 * 0.5.1-54 DR-1（classifier fold，PM 裁定 qitem-20260811163927-74493d76）——分类 create-path
 * nudge 失败，使展示的计数可执行（约束 iii）。三个类别：
 *   - "permanent-topology"：destination 在当前后台服务上无法解析（nudge 在此绝不可能成功——本地
 *     registry 查询对位于另一后台服务的 seat 报 "not found"）。定时重试只会重复永久失败，因此
 *     不可重试；这属于 ADDRESSING 家族，而非重试机制。（线上语料：9/10 strands。）
 *   - "transient"：可解析的 live seat 拒绝本次尝试（正忙于交互提示），或本次尝试超时——未来有界
 *     重试（DR-2，暂定 n=1）唯一会处理的类别。
 *   - "unknown"：失败文本不匹配任何已知模式。不静默默认为 transient（ship-block 裁定
 *     qitem-20260811170941-5eadb968）；默认行为会把“未匹配永久模式”误称为“live seat 拒绝本次
 *     尝试”，这是两种不同主张。unknown 必须显示为 unknown（与 ACTIVITY hookless=unknown 裁定
 *     相同）；将未知折叠到已知类别正是应避免的问题。
 * 当 `lastNudgeResult` 不是已记录失败（`failed:%`）时返回 null。
 *
 * 每个类别都必须正向匹配，不存在默认类别。DR-2（重试）继续保持 n=1；此处只做 READ 侧标记，
 * 使 strand 性质清晰可见（addressing-fix、retry 或 triage-the-unknown）。
 */
export function classifyNudgeFailure(lastNudgeResult: string | null | undefined): "permanent-topology" | "transient" | "unknown" | null {
  if (typeof lastNudgeResult !== "string" || !lastNudgeResult.startsWith("failed:")) return null;
  // permanent-topology：本地 registry "not found"——destination 在当前后台服务上无法解析。
  if (/\bnot found\b/i.test(lastNudgeResult)) return "permanent-topology";
  // transient：live seat 拒绝本次尝试（正忙于 prompt），或本次尝试超时。
  if (/interactive prompt|\btimed?\s?out\b/i.test(lastNudgeResult)) return "transient";
  // unknown：两者都不匹配；不得折叠为 transient。如实标记优先于方便的默认值。
  return "unknown";
}

export const QUEUE_PRIORITIES = ["routine", "urgent", "critical"] as const;
export type QueuePriority = (typeof QUEUE_PRIORITIES)[number];

export interface QueueItem {
  qitemId: string;
  tsCreated: string;
  tsUpdated: string;
  sourceSession: string;
  destinationSession: string;
  state: QueueState;
  priority: QueuePriority;
  tier: string | null;
  /** OPR.0.5.6.14——gateway-routed 行的 delivery LEDGER verdict
   *（posted / transport-failed / never-posted），从该行自身 transition 派生。pane-bound 行为 null，
   * 此字段绝不对不归其管理的类别撒谎。在 getById 和 findUndelivered 时填充。 */
  deliveryOutcome?: "posted" | "transport-failed" | "never-posted" | null;
  /** ledger 派生 entry 在 undelivered surface 上的类别（存在时，route 优先于 nudge literal regex）。 */
  deliveryFailureClass?: string;
  /** undelivered ledger verdict 的精确 gateway receipt/error evidence。 */
  deliveryFailureDetail?: string;
  tags: string[] | null;
  blockedOn: string | null;
  /** S04——派生 pickup receipt（unclaimed/working/stalled-after-claim/parked）。绝不存储：投影时从
   * claimed_at + transition log + heartbeat 计算。 */
  pickup?: PickupReceipt;
  waiting?: WaitingView;
  handedOffTo: string | null;
  handedOffFrom: string | null;
  expiresAt: string | null;
  chainOfRecord: string[] | null;
  body: string;
  /** 显式人工投递 intent；null/省略时保留旧版 decision。 */
  humanIntent?: "decision" | "update" | null;
  /** 一条编写的补充 thread 回复；body 仍是完整 brief。 */
  humanDetail?: string | null;
  /** 简短的人类可读 subject；调用方省略时为 null。 */
  summary: string | null;
  /** OPR.0.4.4.19 FR-5——指向供人工判断的持久 artifact 的 pointer（约定 C3）。所有非 human-routed
   * item 均为 null（BR-1）；仅当 §5 predicate 为 true 时，domain 写入路径才要求该值。 */
  evidenceRef: string | null;
  /** 只出现在 compact list 行，避免把省略内容误认为作者提供的空值。完整读取绝不携带此 marker。 */
  fieldsElided?: Array<"body" | "summary" | "evidenceRef" | "humanDetail" | "waiting">;
  closureReason: ClosureReason | null;
  closureTarget: string | null;
  closureRequiredAt: string | null;
  claimedAt: string | null;
  lastNudgeAttempt: string | null;
  lastNudgeResult: string | null;
  lastHeartbeat: string | null;
  resolution: string | null;
  /** PL-007 Workspace Primitive——qitem 的类型化 repo scope。route 层依据 source rig 的
   * RigSpec.workspace.repos[] 校验。任务明确属于 rig default_repo 或不存在歧义时为 null。
   * 存储在专用 TEXT 列中（migration 038）。 */
  targetRepo: string | null;
}

interface QueueItemRow {
  qitem_id: string;
  ts_created: string;
  ts_updated: string;
  source_session: string;
  destination_session: string;
  state: string;
  priority: string;
  tier: string | null;
  tags: string | null;
  blocked_on: string | null;
  handed_off_to: string | null;
  handed_off_from: string | null;
  expires_at: string | null;
  chain_of_record: string | null;
  body: string;
  human_intent?: "decision" | "update" | null;
  human_detail?: string | null;
  summary: string | null;
  evidence_ref: string | null;
  closure_reason: string | null;
  closure_target: string | null;
  closure_required_at: string | null;
  claimed_at: string | null;
  last_nudge_attempt: string | null;
  last_nudge_result: string | null;
  last_heartbeat: string | null;
  resolution: string | null;
  target_repo: string | null;
}

/**
 * 异步 transport 契约——位于此 domain 模块，使 QueueRepository 可执行持久且会 wake 的 handoff
 *（阶段 A 契约：除非调用方退出，否则 queue create / handoff / handoff-and-complete 默认 nudge）。
 *
 * 接线实现是 `SessionTransport`（packages/daemon/src/domain/session-transport.ts），但 repository
 * 只依赖此最小结构，使测试代码可提供 stub。
 */
export interface QueueNudgeTransport {
  deliveryTarget?(session: string): import("./seat-delivery-guard.js").GuardTarget | null;
  retentionTarget?(session: string): import("./seat-delivery-guard.js").GuardTarget | null;
  send(
    sessionName: string,
    // (h)：stampISO 传递 nudge 的组合时间，使 transport 的 delivered-latency 计算也能测量 handoff
    // nudge 等待时间（真实实现 SessionTransport 接受该字段）。
    text: string,
    opts?: { verify?: boolean; stampISO?: string; actorSession?: string; committedOutboxIds?: string[]; deliveryId?: string; auditPointer?: string }
  ): Promise<{ ok: boolean; verified?: boolean; error?: string; reason?: string; outcome?: string }>;
}

export interface QueueCreateInput {
  qitemId?: string;
  sourceSession: string;
  destinationSession: string;
  body: string;
  priority?: QueuePriority;
  tier?: string;
  tags?: string[];
  expiresAt?: string;
  chainOfRecord?: string[];
  /** 0.5.1-53 Atom 2b——supersession back-link。当此 qitem 是 cancel-and-replace 的 successor
   *（原项记录 state=canceled + closure_reason=superseded + closure_target=<this>）时，
   * handedOffFrom 记录原项，使 successor 可追溯到被替换项。这与 handoff-and-complete 已设置的
   * lineage primitive 相同，现在 raw create 路径也可使用，避免 supersession 成为无链接的孤立对。 */
  handedOffFrom?: string | null;
  /** PL-007——此 qitem 的类型化 repo scope。Route 依据 source rig 的 workspace.repos[] 校验；
   * 上游拒绝未知名称。 */
  targetRepo?: string | null;
  /** 显式人工投递 intent；省略时保留旧版 decision。 */
  humanIntent?: "decision" | "update" | null;
  /** 显式补充 thread 内容，绝不是主 body 的自动拆分。 */
  humanDetail?: string | null;
  summary?: string | null;
  /** OPR.0.4.4.19 FR-5——可选持久 artifact pointer。存在时持久化；仅 human-routed item 在
   * domain 层要求该值。 */
  evidenceRef?: string | null;
  /**
   * R1 修复（PL-004 阶段 A 修订）：阶段 A 默认持久且会 wake。为 true（或省略）时，repository
   * 在 create transaction 提交后 nudge destination，并持久化 last_nudge_attempt +
   * last_nudge_result。操作员可在 cold-queue 场景用 `nudge: false` 退出。
   */
  nudge?: boolean;
  /** P21 §4 era-stamp：route 传入 `transport:v1`（sourceSession 从 transport header chokepoint
   * 派生）。串接到 'created' transition；缺席 = claimed-era。 */
  identityProvenance?: string | null;
}

export interface QueueUpdateInput {
  qitemId: string;
  actorSession: string;
  state?: QueueState;
  /** 对有意 terminal → active 修复的显式确认。 */
  reopen?: boolean;
  /**
   * OPR.0.4.6.WF3 FR-6——仅由 workflow domain 自身写入路径设置（projector close、route close）：
   * 它们维持 frontier 不变量，因此 close-path guard 豁免这些路径。它不是安全边界，而是防止误用的
   * 正确性守卫（PM 裁定：预防）。
   */
  viaWorkflowVerb?: boolean;
  transitionNote?: string;
  closureReason?: string;
  closureTarget?: string;
  /**
   * PL-004 阶段 D 扩展：设置时持久化 queue_items.handed_off_to 列。workflow-projector 在
   * state=handed-off transition 中使用，使 canonical“下一 owner”pointer 仅凭 queue state 即可恢复。
   * 为保持与现有 update() 调用方的向后兼容，此字段可选。
   */
  handedOffTo?: string;
  /**
   * PL-004 阶段 D 扩展：设置时持久化 queue_items.blocked_on 列。workflow-projector 在
   * state=blocked transition 中使用，使 blocker 引用（qitem id、gate 名）可从 queue state 恢复。
   */
  blockedOn?: string;
  /** OPR.0.5.5.03——park continuation。一个 blocked transition 只能携带一种显式 wake 形式；
   * live qitem blocker 会被推断。 */
  wakeWatchdogId?: string;
  wakeAfterSeconds?: number;
  /** 内部选择启用重复、event-first 的 park reminder。按结构比较 evidence；确认 note 从不算 progress。 */
  wakeMaxSeconds?: number;
  wakeProgressEvidence?: Record<string, unknown>;
  /** 内部调用方为原子 timer 提供的文本。公共 queue route 不公开它；workflow projection 用它重新
   * 展示与确切 occurrence 绑定的 continuation action，而非通用 reminder。 */
  wakeMessage?: string;
  /**
   * OPR.0.4.4.19 FR-6——park 时输入。summary + evidence_ref 可在 park 时刻更新
   *（state=blocked 且 blocker 为 human-seat），而非仅创建时：`zrig queue block --summary
   * --evidence-ref` 会将其持久化到现有 item，使 attention query + Packet 2 可读取。OPR.0.5.1
   * slice-51-06 D2：在非 park transition 上提供它们会在任何修改前被拒绝（QueueRepositoryError
   * "summary_evidence_not_persistable"），而非静默忽略，避免调用方误以为不可持久化 metadata 已保存。
   */
  summary?: string | null;
  evidenceRef?: string | null;
  /** P21 §4 era-stamp：route 传入 `transport:v1`（actorSession 从 transport header chokepoint
   * 派生）。串接到 transition；缺席 = claimed-era。 */
  identityProvenance?: string | null;
  /** 系统所有的 ceremony kind。绝不作为自由格式 route 字段公开。 */
  ownerNotificationKind?: "human-decision-resolved";
}

export interface QueueHandoffInput {
  qitemId: string;
  fromSession: string;
  toSession: string;
  body?: string;
  transitionNote?: string;
  priority?: QueuePriority;
  tier?: string;
  tags?: string[];
  /** 默认为 true；在 close+create transaction 后 nudge destination。 */
  nudge?: boolean;
  /** PL-007——新 qitem 的类型化 repo scope。省略时新 qitem 继承 source 的 targetRepo。 */
  targetRepo?: string | null;
  /** OPR.0.4.1.18——新 qitem 可选的约 1–2 句 summary。不从 source 继承（handoff 编写自己的
   * summary）；省略 → null → Story 降级。 */
  summary?: string | null;
  /** OPR.0.4.4.19 FR-5——新 qitem 的可选持久 artifact pointer。不从 source 继承（与 summary
   * 采用相同 authorship 语义）。 */
  evidenceRef?: string | null;
  /** P21 §4 era-stamp：route 传入 `transport:v1`（fromSession 从 transport header chokepoint
   * 派生）。串接到 source-close 与 new-item 两个 transition。 */
  identityProvenance?: string | null;
}

/**
 * 与 {@link QueueHandoffInput} 类似，但 source qitem 关闭为 `done`（terminal）而非 `handed-off`
 *（中间状态）。用于 source seat 已完全完成工作且新 qitem 是 canonical 后续项的情况。
 * Closure_reason 记录为 `handed_off_to`，新 qitem 在同一原子事务中创建。
 */
export interface QueueHandoffAndCompleteInput extends QueueHandoffInput {}

export interface QueueClaimInput {
  qitemId: string;
  destinationSession: string;
  /** P21 §4 era-stamp：route 传入 `transport:v1`（destinationSession 从 transport header
   * chokepoint 派生）。串接到 claim transition；缺席 = claimed-era。 */
  identityProvenance?: string | null;
}

export interface QueueListOptions {
  /** 在结果边界前精确选择 tag（用于 diagnostic occurrence）。 */
  tag?: string;
  destinationSession?: string;
  sourceSession?: string;
  state?: QueueState | QueueState[];
  /** PL-007——按 target_repo 过滤 qitem，精确匹配。 */
  targetRepo?: string;
  limit?: number;
  asSession?: string;
  compact?: boolean;
  rig?: string;
  activeOnly?: boolean;
}

export class QueueRepositoryError extends Error {
  readonly code: string;
  readonly meta: Record<string, unknown> | undefined;
  constructor(code: string, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.meta = meta;
  }
}

/** OPR.0.4.6.WF5（guard 命名的修复结构）：导出此函数，使 workflow domain 可预分配 gate packet
 * id——类别 (c) exception identity tag 要求在创建时就把 occurrence:<gatePacketId> 放在 packet 上
 *（一个 item，在自身 create 中打 tag；绝不创建第二个 item，也绝不在创建后重写 tag）。queue 仍为
 * 所有未预分配的调用方生成 id。 */
export function newQitemId(): string {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const hex = Math.floor(Math.random() * 0xffffffff)
    .toString(16)
    .padStart(8, "0");
  return `qitem-${ts}-${hex}`;
}

/**
 * OPR.0.4.6.MH3 Q-a：这是否为 queue_items.qitem_id 上的 SQLite PRIMARY KEY 冲突？
 * better-sqlite3 会在 SqliteError 上设置 `.code`；消息检查是防御性镜像，避免 driver 名称变化将
 * 幂等吸收静默变成 500。
 */
export function isQitemPrimaryKeyConflict(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code ?? "";
  if (code === "SQLITE_CONSTRAINT_PRIMARYKEY" || code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  return /UNIQUE constraint failed: queue_items\.qitem_id/.test(err.message);
}

/**
 * OPR.0.4.6.MH3 D-1（FR-4/FR-5）：确定性跨 host SUCCESSOR id。
 *
 * 跨 host handoff 不公开调用方 `--id`，因此 successor 去重 identity 必须来自操作本身：id 是
 *（source qitemId、destination session、destination host）的纯无状态函数。参数相同则每次重新驱动
 * 都得到相同 id，跨后台服务重启且无需本地状态，因此来源侧 PRIMARY KEY 吸收（Q-a）可收敛每次
 * 被中断 close 的重新驱动。Source→successor 按构造为 1:1（已关闭 source 是 terminal，不会重开）。
 * `qitem-xh-` 命名空间从结构上排除与自然 `qitem-<ts>-<hex>` id 冲突（plan R-2）。复合 key
 * 使用 JSON 编码，不手写分隔符。
 *
 * n1 残留（架构命名，是已批准至少一次/无 2PC 边界的固有结果，不是去重 bug）：source close 落地前，
 * 指向不同 destination 的重新驱动属于新的 handoff 决策，会派生不同 id，因此无法吸收先前 successor；
 * 先前 successor 可能继续存活在目标 host。chain_of_record + 跨 host provenance tag 让此类孤儿
 * 保持可见/可追踪；source-close 冲突检查会展示分歧，而非覆盖。
 */
export function deriveCrossHostSuccessorId(
  sourceQitemId: string,
  destinationSession: string,
  hostId: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([sourceQitemId, destinationSession, hostId]))
    .digest("hex")
    .slice(0, 16);
  return `qitem-xh-${digest}`;
}

/** PL-007——防御性 column probe。旧测试 fixture 绕过 canonical migration 列表，因此可能缺少
 * target_repo。与 rig-repository.ts 中的 `hasNodeColumn` 模式一致。 */
function detectQueueColumn(db: Database.Database, columnName: string): boolean {
  try {
    return db.prepare("PRAGMA table_info(queue_items)").all()
      .some((row) => (row as { name?: string }).name === columnName);
  } catch {
    return false;
  }
}

function detectTable(db: Database.Database, tableName: string): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  } catch {
    return false;
  }
}

/**
 * L3——Queue repository。拥有 `queue_items` CRUD、已接线的仅追加 transition log，以及
 * hot-potato 严格拒绝契约。
 *
 * 模式与 `chat-repository.ts` 对应（单一 class、原子 transaction、先持久化事件再通知）。跨 rig
 * 校验 hook 是 `validateRig`——阶段 A 接线为 no-op；阶段 B 可接入 rig registry 拒绝 phantom-rig
 * destination。兼容 POC：保留 `qitem_id` 结构。
 */
// compact list 行的精简列集合（省略 body/summary/evidence_ref → rowToItem 回填为空）。由 `list` 与
// `findOverdue`（Slice 15）共享，使两者的 compact 投影不会漂移。
const COMPACT_QUEUE_COLUMNS =
  "qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, blocked_on, handed_off_to, handed_off_from, expires_at, closure_reason, closure_target, closure_required_at, claimed_at, last_nudge_attempt, last_nudge_result, last_heartbeat, resolution, target_repo";

/**
 * 仅在 FORWARD 时盖章（founder 根不变量 2026-08-27，取代 51-09 增量 4 的写入时盖章）：本地写入
 * 从不调用此函数，本地行存储裸 member@rig。跨 host 转发 route（routes/queue.ts）调用它，使转发
 * 后台服务在远程 create 前以自身 id 盖章为 origin；远端的非裸值守卫随后原样存储收到的三元组
 *（绝不伪造 origin）。FAIL-OPEN：无已协调 self-id，或值不是裸 member@rig（已经是三元组/畸形）时，
 * 原样通过。
 */
export function stampSelfHostSuffix(session: string): string;
export function stampSelfHostSuffix(session: undefined): undefined;
export function stampSelfHostSuffix(session: string | undefined): string | undefined;
export function stampSelfHostSuffix(session: string | undefined): string | undefined {
  if (session === undefined) return undefined;
  const selfId = getSelfHostId();
  if (!selfId) return session;
  if (session.split("@").length !== 2) return session; // 不是裸 member@rig——保持不变。
  return `${session}@${selfId}`;
}

/**
 * 51-09 增量 4b——为 unknown_destination_rig 拒绝增加教学信息（架构裁定 c9964404，机制 ii）。
 * 三段 destination 已经会拒绝（BR-1：member@rig@host 贪婪折叠为 rig "rig@host"，未命中后
 * 拒绝），代码保持不变（C1）。当被拒绝 destination 的贪婪解析 rig token 包含 '@' 时，返回增量
 * 结构化字段（FR-7 先例），说明带外路径：分段回显 + 点名 `--host` 的 hint。C4：带 self 后缀的
 * destination 会点明 self 情形，绝不自动剥离/路由回本机（self-strip 是送交架构的方案 (i)）。
 * 对两段/非 canonical token 返回 undefined（其拒绝字节保持不变）。一个 helper 覆盖全部四个拒绝
 * 位置（C2）。读取 FR-8 解析契约；parse 家族保持字节一致（C3）。
 */
export function destinationRigTeaching(session: string): Record<string, unknown> | undefined {
  const parsed = parseSessionName(session);
  if (parsed.kind !== "canonical" || !parsed.rig.includes("@")) return undefined;
  const at = parsed.rig.lastIndexOf("@");
  const rig = parsed.rig.slice(0, at);
  const host = parsed.rig.slice(at + 1);
  const bare = `${parsed.member}@${rig}`;
  const selfId = getSelfHostId();
  const selfHost = !!selfId && host === selfId;
  return {
    destinationSplit: { member: parsed.member, rig, host },
    selfHost,
    hint: selfHost
      ? `host 后缀 '@${host}' 就是当前 host——host 绝不放入 session 字符串；请将 destination 改为 ${bare} 后重新发送`
      : `host 不放入 session 字符串；请对 destination ${bare} 使用 --host ${host}`,
  };
}

/**
 * M1 A4b——针对未注册 <local>@external destination 的 entity 级教学信息（proof-2 的 ENTITY
 * 部分；DOMAIN 部分是封闭集合回退到 unknown_destination_rig，A1/A2）。若行指向有效 @external
 * domain 但 entity 未在 registry 中，会使用 gateway resolver 的结构化教学信息（如何注册 +
 * “不是 agent seat”）显著拒绝。只在少见的 @external 拒绝路径加载 registry。对非 @external、
 * 已注册或 scheme 返回 undefined。
 */
export function externalAdmissionTeaching(
  session: string,
  loadRegistry: () => LoadResult = loadHumanRegistry,
): Record<string, unknown> | undefined {
  const parsed = parseSessionName(session);
  if (parsed.kind !== "external") return undefined;
  if (resolveExternal(parsed.local, []).kind === "scheme") return undefined;
  const reg = loadRegistry();
  if (!reg.ok) {
    return {
      externalDomain: parsed.domain,
      registryLoadError: true,
      registryError: reg.error,
      ...(/projection|投影/i.test(reg.error) ? { registryProjectionError: true } : {}),
      hint:
        `human registry admission 不可用，因为 registry/projection 加载失败：${reg.error}。` +
        "请从 fragment 修复现有 registry projection；不要重新添加 human，也不要将 destination 降级为 agent seat。",
    };
  }
  const entities = reg.entities.map((e) => ({ entityId: e.entityId, address: e.address }));
  const res = resolveExternal(parsed.local, entities);
  if (res.kind !== "unregistered") return undefined; // registered/scheme 已在上游准入。
  return { externalDomain: parsed.domain, unregisteredEntity: parsed.local, hint: res.error };
}

/** 任何被拒绝 destination 的教学信息：@external entity 教学（A4b）或 host-suffix 教学（4b）。
 * 一个 helper 覆盖全部四个拒绝位置。 */
export function destinationRefusalTeaching(
  session: string,
  loadRegistry: () => LoadResult = loadHumanRegistry,
): Record<string, unknown> | undefined {
  return externalAdmissionTeaching(session, loadRegistry) ?? destinationRigTeaching(session);
}

function destinationValidationError(
  field: "destination_session" | "to_session",
  session: string,
  loadRegistry: () => LoadResult,
): QueueRepositoryError {
  const teaching = destinationRefusalTeaching(session, loadRegistry);
  if (teaching?.registryLoadError === true) {
    return new QueueRepositoryError(
      "human_registry_unavailable",
      `${field} ${session} 无法准入，因为 human registry 加载失败：${String(teaching.registryError)}`,
      teaching,
    );
  }
  return new QueueRepositoryError(
    "unknown_destination_rig",
    `${field} ${session} 引用了未知 rig`,
    teaching,
  );
}

/**
 * MF6：transport error/reason 字符串是否表示超时（有歧义，send 可能已落地），而非确定失败？
 * 用于将 wake delivery 分类为 `indeterminate` 或 `failed`。
 */
function isWakeTimeoutSignal(s: string | undefined): boolean {
  return !!s && /timeout|timed\s*out|etimedout/i.test(s);
}

export class QueueRepository {
  readonly db: Database.Database;
  readonly transitionLog: QueueTransitionLog;
  private readonly eventBus: EventBus;
  private readonly validateRig: (sessionRef: string) => boolean;
  private transport: QueueNudgeTransport | undefined;
  /** W1（transactional closure）：持久 wake-intent store。terminal 操作（handoff /
   * handoff-and-complete）在自身 db.transaction 内暂存 outbox intent 行，使 close + transition +
   * intent 要么作为一个操作提交，要么全不提交；随后从已提交 intent 排空投递。由 startup 在构造后
   * 接线（依赖图顺序，与 transport 相同）。
   *
   * 缺席 = test/bootstrap 路径，具体含义因调用方而异，并非一概 best-effort fallback：
   *   • 旨在 nudge 的 terminal close+successor 操作采用 fail-closed（MF2）：
   *     {@link assertTerminalClosureHasIntent} 抛出 `wake_intent_store_unavailable`，而不是生成已执行
   *     但未 wake 的 item（无需 wake 的 close 请传 `nudge:false`）；
   *   • 只有 {@link deliverWakeForSuccessor} 在未附加 store 时回退到 W1 前的 best-effort
   *     {@link maybeNudge}（P34 将该 fallback 从注释承诺变成了真实代码）。 */
  private outbox: OutboxHandler | undefined;
  private resolveOccupantGeneration?: (sessionName: string) => string | null;
  private readonly wakeRepo: QueueWakeRepository;
  private watchdogJobsRepo: WatchdogJobsRepository | undefined;
  /** PL-007 Workspace Primitive——migration 038 已应用 queue_items.target_repo 列时为 true。绕过
   * canonical migration 列表的旧测试 fixture 没有该列；INSERT 会降级为 PL-007 前的 statement，
   * target_repo 输入会被静默丢弃。生产后台服务始终有此列（migration 位于 startup.ts）。 */
  private readonly hasTargetRepoColumn: boolean;
  private readonly hasSummaryColumn: boolean;
  private readonly hasHumanIntentColumn: boolean;
  private readonly hasEvidenceRefColumn: boolean;
  private readonly hasMintingGenColumn: boolean;
  private readonly hasClaimedGenColumn: boolean;
  private readonly hasQueueTransitionsTable: boolean;
  private readonly hasOwnerNotificationColumns: boolean;
  private readonly loadHumanRegistryFn: () => LoadResult;
  /** OPR.0.4.6.WF3 FR-6——由 startup 注入（绝不 import）：workflow domain 的
   * is-live-frontier-packet 谓词。 */
  private readonly workflowFrontierPredicate:
    | ((qitemId: string) => { instanceId: string; workflowName: string } | null)
    | undefined;

  constructor(
    db: Database.Database,
    eventBus: EventBus,
    opts?: {
      validateRig?: (sessionRef: string) => boolean;
      /**
       * R1 修复（PL-004 阶段 A 修订）：create / handoff / handoff-and-complete 使用默认持久且会
       * wake 的 transport。提供时，repository 在对应 transaction 提交后 nudge destination，并通过
       * recordNudgeAttempt() 记录 last_nudge_attempt + last_nudge_result。缺席时不发 nudge
       *（调用方位于 transport 尚未接线的测试或 daemon-bootstrap 路径）。
       */
      transport?: QueueNudgeTransport;
      /**
       * OPR.0.4.6.WF3 FR-6——frontier close-path guard 的注入 predicate（沿用 validateRig 注入
       * 先例：queue 是较低层 primitive，绝不 import workflow domain；startup 接入 workflow domain
       * 导出的 predicate）。缺席（测试、bootstrap、workflow 前 schema）= 无新增行为。
       */
      workflowFrontierPredicate?: (qitemId: string) => { instanceId: string; workflowName: string } | null;
      /**
       * GHOST-STAGE (h)：解析 SOURCE seat 的 atom-B occupant generation-uuid，使 handoff nudge
       * 在 Sent: 行携带进行组合的 generation（沿用注入 predicate 先例；queue 是较低层 primitive，
       * 从不 import session domain；startup 接入 SessionRegistry.currentOccupantGenerationForSession）。
       * 缺席 ⇒ UNKNOWN ⇒ 省略 gen 后缀（绝不伪造）。
       */
      resolveOccupantGeneration?: (sessionName: string) => string | null;
      loadHumanRegistry?: () => LoadResult;
    }
  ) {
    this.db = db;
    this.eventBus = eventBus;
    this.transitionLog = new QueueTransitionLog(db);
    this.wakeRepo = new QueueWakeRepository(db);
    this.validateRig = opts?.validateRig ?? (() => true);
    this.transport = opts?.transport;
    this.workflowFrontierPredicate = opts?.workflowFrontierPredicate;
    this.resolveOccupantGeneration = opts?.resolveOccupantGeneration;
    this.loadHumanRegistryFn = opts?.loadHumanRegistry ?? (() => loadHumanRegistry());
    this.hasTargetRepoColumn = detectQueueColumn(db, "target_repo");
    this.hasSummaryColumn = detectQueueColumn(db, "summary");
    this.hasHumanIntentColumn = detectQueueColumn(db, "human_intent");
    this.hasEvidenceRefColumn = detectQueueColumn(db, "evidence_ref");
    this.hasQueueTransitionsTable = detectTable(db, "queue_transitions");
    const transitionColumns = this.hasQueueTransitionsTable
      ? new Set((db.prepare("PRAGMA table_info(queue_transitions)").all() as Array<{ name: string }>).map((column) => column.name))
      : new Set<string>();
    this.hasOwnerNotificationColumns = transitionColumns.has("owner_notification_kind")
      && transitionColumns.has("owner_notification_level");
    // GHOST-STAGE（e/Class-B）：generation stamp（migration 063）。防御性检测使 063 前 harness
    // 降级（writer 跳过这些列；release predicate 永不匹配无 stamp 行）。
    this.hasMintingGenColumn = detectQueueColumn(db, "minting_generation_uuid");
    this.hasClaimedGenColumn = detectQueueColumn(db, "claimed_by_generation_uuid");

    // OPR.0.3.2.20——将精确 human-seat regex predicate 注册为 SQLite function，使 attention query
    // 可在 LIMIT 前应用严格检查。LIKE/GLOB pattern 是超集，会让畸形行（例如 'human-@kernel'，名称
    // segment 为空）占用 LIMIT 窗口，并隐藏其后的有效 attention item（guard re-verify-3
    // qitem-20260518193005 BLOCKER 1）。better-sqlite3 db.function 幂等，可在构造时安全调用一次。
    // OPR.0.4.4.19：单一 source regex——SQL function 委托 session-name 的 canonical predicate
    //（legacy 与 external），使 SQL 侧与 TS 侧检查无法漂移。
    db.function("is_human_seat_session", { deterministic: true }, (value: unknown) =>
      typeof value === "string" && isHumanSeatSessionRef(value) ? 1 : 0
    );
  }

  /** Startup 附加识别 generation 的共享 repository。隔离 domain fixture 回退到同一 SQLite
   * connection 上的 repository。 */
  attachWatchdogJobsRepository(repo: WatchdogJobsRepository): void {
    this.watchdogJobsRepo = repo;
  }

  /** Startup 在 queue/watchdog 组合后接线。测试也可在重建后调用；它只协调 queue 所有的重复 timer。 */
  reconcileWaitReminders(changedQitem?: string, proofChanged = false): void {
    refreshQueueWaits(this.db, this.watchdogJobsRepo ?? new WatchdogJobsRepository(this.db), changedQitem, proofChanged);
  }

  startWaitReminders(): () => void {
    this.reconcileWaitReminders();
    return this.eventBus.subscribe((event) => {
      if (event.type.startsWith("queue.") && "qitemId" in event && typeof event.qitemId === "string") {
        this.reconcileWaitReminders(event.qitemId);
      } else if (event.type === "proof.judged" || event.type === "proof.sources_changed") {
        this.reconcileWaitReminders(undefined, true);
      }
    });
  }

  /**
   * 构造后附加 wake-path transport。用于后台服务启动；SessionTransport 在依赖图中晚于
   * QueueRepository 构造，因为 SessionTransport 需要 agentActivityStore，后者又需要 eventBus。
   * 任何时候调用都安全；create / handoff / handoff-and-complete 会从下一次调用开始 nudge。
   */
  attachTransport(transport: QueueNudgeTransport): void {
    this.transport = transport;
  }

  /**
   * W1（transactional closure）：构造后附加持久 wake-intent store（依赖图原因与
   * {@link attachTransport} 相同）。附加后，handoff / handoff-and-complete 会在 terminal transaction
   * 内暂存 outbox intent 行，使 close 与 wake intent 在一次提交中完成。
   */
  attachOutbox(outbox: OutboxHandler): void {
    // MF2：wake intent 必须在 terminal transaction 内提交，只有 outbox 写入同一 connection 时才成立。
    // 由不同数据库支撑的 outbox 会让 intent 在 close 回滚后存活（反之亦然），破坏“一个操作或全无”。
    // 在接线时拒绝 split-DB outbox。
    if (outbox.db !== this.db) {
      throw new QueueRepositoryError(
        "outbox_db_mismatch",
        "attachOutbox 要求 OutboxHandler 与 queue repository 绑定到同一数据库 connection——拆分数据库会破坏原子 close+intent 接缝",
      );
    }
    this.outbox = outbox;
  }

  /** 唯一的 transition-write classifier，只消费结构化 state/action 事实。 */
  private classifyOwnerNotification(input: {
    action: "create" | "update";
    destinationSession: string;
    previousState?: QueueState;
    previousBlockedOn?: string | null;
    nextState: QueueState;
    nextBlockedOn?: string | null;
    explicitKind?: QueueUpdateInput["ownerNotificationKind"];
    humanIntent?: "decision" | "update" | null;
  }): { kind: string; level: OwnerNotificationLevel } | null {
    if (input.explicitKind === "human-decision-resolved") {
      return { kind: input.explicitKind, level: "NOTICE" };
    }
    const registry = this.loadHumanRegistryFn();
    if (!registry.ok) return null;
    const blockedHuman = resolveRegisteredHumanAddress(input.nextBlockedOn, registry.entities);
    const previousBlockedHuman = resolveRegisteredHumanAddress(input.previousBlockedOn, registry.entities);
    const enteredHumanPark = input.nextState === "blocked" && blockedHuman !== null &&
      (input.previousState !== "blocked" || previousBlockedHuman !== blockedHuman);
    if (enteredHumanPark) return { kind: "human-required", level: "ALERT" };

    const destinationHuman = resolveRegisteredHumanAddress(input.destinationSession, registry.entities);
    if (input.action === "create" && destinationHuman !== null) {
      return input.humanIntent === "update"
        ? { kind: "human-update", level: "NOTICE" }
        : { kind: "human-required", level: "ALERT" };
    }
    return null;
  }

  /**
   * W1（transactional closure）——公共可组合 primitive（stage 半边）。从 terminal 操作自己的
   * `db.transaction`（queue 自身 connection）内为 successor qitem 暂存持久 WAKE INTENT，使 intent
   * 与 close + transition 原子提交。它公开且可组合，因此任何 close+successor writer——当前的
   * handoff / handoff-and-complete，以及通过 P34 后续接线的 Mission Control / Workflow——都可在
   * 自身事务内调用（沿用 `createWithinTransaction` 先例），使接线只是扩展而非返工。与
   * {@link assertTerminalClosureHasIntent} 配对，后者作为同一事务最后一条语句运行。
   *
   * pane nudge 本身是提交后副作用（绝不反转；事务内写 pane 会让 transaction 撒谎）；持久的是 intent
   * 行，投递随后将其排空。冻结发送 envelope（MF4）；以 successor 为 key 的确定性 outbox id 保证
   * 幂等。`nudge:false` 表示不 wake ⇒ 无 intent。缺少 outbox 由 guard 以 fail-closed（MF2）强制，
   * 不在此处静默跳过。
   */
  stageWakeIntent(
    successorQitemId: string,
    fromSession: string,
    toSession: string,
    identityProvenance: string | null,
    nudge: boolean | undefined,
  ): void {
    // 不打算 wake（nudge:false）⇒ 无需持久化 intent。W1-c guard 同样识别 nudge：只有本应 wake 时
    // 缺少 intent 才是缺陷。
    if (nudge === false) return;
    this.recordWakeIntent({
      outboxId: `${WAKE_INTENT_PREFIX}${successorQitemId}`,
      auditPointer: successorQitemId,
      fromSession,
      toSession,
      identityProvenance,
      bareBody: `Queue handoff：${successorQitemId} - 请检查你的 queue。`,
      tags: this.getById(successorQitemId)?.handedOffFrom
        ? [`queue:return:${this.getByIdOrThrow(successorQitemId).handedOffFrom}`] : undefined,
    });
  }

  private recordWakeIntent(input: {
    outboxId: string;
    auditPointer: string;
    fromSession: string;
    toSession: string;
    identityProvenance: string | null;
    bareBody: string;
    tags?: string[];
  }): string | null {
    if (!this.outbox) return null;
    // MF4：在 stage 时冻结发送 envelope。投递和崩溃恢复会重放这些精确字节，不重新解析 occupant。
    const stampISO = new Date().toISOString();
    const genUuid = this.resolveOccupantGeneration?.(input.fromSession) ?? undefined;
    const frozenEnvelope = wrapPaneEnvelope(
      input.fromSession,
      input.toSession,
      input.bareBody,
      { stampISO, genUuid },
    );
    const record = {
      outboxId: input.outboxId, senderSession: input.fromSession, destinationSession: input.toSession,
      body: frozenEnvelope, tags: input.tags, auditPointer: input.auditPointer, identityProvenance: input.identityProvenance,
    };
    const target = this.transport?.retentionTarget?.(input.toSession);
    if (target) this.outbox.retain(record, target);
    else {
      this.outbox.record(record);
      const binding = this.transport?.deliveryTarget?.(input.toSession);
      if (binding) this.db.prepare("UPDATE outbox_entries SET guard_binding=? WHERE outbox_id=? AND guard_binding IS NULL")
        .run(JSON.stringify(binding), input.outboxId);
    }
    return input.outboxId;
  }

  private stageAutoUnparkWakeIntent(input: {
    qitemId: string;
    destinationSession: string;
    fromSession: string;
    identityProvenance: string | null;
    blockerQitemId: string;
    resumeTransitionId: number;
  }): string | null {
    return this.recordWakeIntent({
      outboxId: `${WAKE_INTENT_PREFIX}blocker-${input.resumeTransitionId}`,
      auditPointer: input.qitemId,
      fromSession: input.fromSession,
      toSession: input.destinationSession,
      identityProvenance: input.identityProvenance,
      bareBody: `Blocker ${input.blockerQitemId} 已解决；parked qitem ${input.qitemId} 已进入 pending。请恢复已记录的 continuation 并更新该行。`,
      tags: [AUTO_UNPARK_WAKE_TAG, `${AUTO_UNPARK_BLOCKER_TAG_PREFIX}${input.blockerQitemId}`, `queue:return:${input.blockerQitemId}`],
    });
  }

  private deliverWakeIntentAfterCommit(outboxId: string): void {
    queueMicrotask(() => {
      void this.deliverWakeIntent(outboxId).catch((err) => {
        console.error(`${outboxId} 的自动 unpark wake 投递失败：`, err);
      });
    });
  }

  /**
   * W1-c（transactional closure）：runtime 接缝守卫。作为 terminal 操作 db.transaction 内的最后
   * 一条语句调用，使“已执行但未 wake”的 close 不可写：若该事务写入 terminal close 且本应 wake，
   * 则 successor 的持久 wake intent 必须存在于同一事务中；否则抛错，整个操作在接缝处回滚，而不是
   * 等到 review。
   *
   * 识别 Nudge：nudge:false 表示不 wake，因此无需 intent。MF2：本应 wake 但未附加 intent store 时
   * fail-closed（此时无法保证）。公共可组合 primitive（guard 半边）：任何 close+successor writer
   * 都将其作为自身事务的最后一条语句运行——当前为 handoff / handoff-and-complete，未来由 P34
   * 接入 Mission Control / Workflow。
   */
  assertTerminalClosureHasIntent(
    sourceQitemId: string,
    successorQitemId: string,
    nudge: boolean | undefined,
  ): void {
    if (nudge === false) return; // 不打算 wake ⇒ 无需 intent。
    // MF2：fail-closed。旨在 nudge 的 terminal 操作若没有 intent store，就无法持久化 wake，因而
    // 无法提供保证；拒绝 close，而不是静默产生已执行但未 wake 的 item（W1 使其不可写的确切类别）。
    // 生产环境始终在启动时附加 outbox。
    if (!this.outbox) {
      throw new QueueRepositoryError(
        "wake_intent_store_unavailable",
        "旨在 nudge 的 terminal 操作需要附加 wake-intent store 才能持久化 wake——当前未附加（无需 wake 的 close 请传 nudge:false，或附加 outbox）",
      );
    }
    // 在此 connection 上读取事务可见但尚未提交的状态。
    const src = this.getById(sourceQitemId);
    if (!src || !isTerminalState(src.state)) return; // 不是 terminal close。
    const intent = this.outbox.getById(`${WAKE_INTENT_PREFIX}${successorQitemId}`);
    if (!intent) {
      throw new QueueRepositoryError(
        "terminal_close_without_wake_intent",
        `${sourceQitemId} 的 terminal closure 在未暂存 ${successorQitemId} wake intent 的情况下提交——违反“一个操作或全无”`,
      );
    }
  }

  /**
   * W1-b：投递一个已提交 wake intent。MF3：外部发送前先 CLAIM（pending→sending），之后再 finalize
   *（sending→outcome），使重叠 drain 恰好发送一次 wake（保证副作用而不只是状态），第二次 drain
   * 会跳过已 claim/resolved intent。返回实际结果供 drain 计数。
   *
   *   verified          → delivered
   *   ok, unverified    → indeterminate   （有歧义；绝不静默视为 delivered/failed）
   *   timeout (MF6)     → indeterminate   （可能已落地，不是确定失败）
   *   other not-ok/throw→ failed          （可见 terminal 状态）
   */
  private async deliverWakeIntent(
    outboxId: string,
  ): Promise<"delivered" | "indeterminate" | "failed" | "skipped" | "retained"> {
    if (!this.outbox) return "skipped";
    if (!this.transport) return "skipped"; // 无 transport → 保持 pending，等待后续 drain。
    const alreadyHeld = this.outbox.getById(outboxId);
    if (alreadyHeld?.deliveryState === "retained" || alreadyHeld?.deliveryState === "retired") {
      if (alreadyHeld.auditPointer) this.recordNudgeAttempt(alreadyHeld.auditPointer, "retained:typing_guard");
      return "retained";
    }
    // MF3：外部发送前先 CLAIM（pending→sending），使重叠 drain 无法同时发送。claim 失败表示该行已不再
    // `pending`（已经 resolved、由其他 drainer 处理，或已 claim），直接跳过，不发送也不计数。这样保证
    // 外部副作用恰好一次，而不只是状态一次。原子 claim 精确 return 的到达和 dependent resume。每个
    // 原始冻结 intent 与 audit pointer 都保留，只有 transport 合并。
    let superseded = false;
    const actionable = (entry: import("./outbox-handler.js").OutboxEntry): boolean => {
      const row = entry.auditPointer ? this.db.prepare("SELECT state FROM queue_items WHERE qitem_id = ?").get(entry.auditPointer) as { state: string } | undefined : undefined;
      let current = row?.state === "pending";
      const resumePrefix = `${WAKE_INTENT_PREFIX}blocker-`;
      if (current && entry.outboxId.startsWith(resumePrefix)) {
        const expected = Number(entry.outboxId.slice(resumePrefix.length));
        const latest = this.db.prepare(`SELECT transition_id FROM (
          SELECT transition_id, state, LAG(state) OVER (ORDER BY transition_id) AS previous_state
          FROM queue_transitions WHERE qitem_id = ?)
          WHERE state = 'pending' AND previous_state IS NOT 'pending' ORDER BY transition_id DESC LIMIT 1`)
          .get(entry.auditPointer) as { transition_id: number } | undefined;
        current = expected === latest?.transition_id;
      }
      if (!current) {
        // 现有 failed 状态表示所请求旧投递已被拒绝；显式 tag 将 supersession 与 transport 尝试区分。
        // 不写 last_nudge_result 或 delivered_at，因为两者均未发生。
        const changed = this.db.prepare("UPDATE outbox_entries SET delivery_state = 'failed', tags = ? WHERE outbox_id = ? AND delivery_state = 'pending'")
          .run(JSON.stringify([...(entry.tags ?? []), "queue:wake-superseded"]), entry.outboxId);
        superseded ||= changed.changes > 0;
      }
      return current;
    };
    const group = this.db.transaction(() => {
      const candidate = this.outbox!.getById(outboxId);
      if (!candidate || candidate.deliveryState !== "pending" || !actionable(candidate)) return [];
      if (!this.outbox!.claimForDelivery(outboxId)) return [];
      const first = this.outbox!.getById(outboxId)!;
      const intents = [first];
      const correlation = first.tags?.find(tag => tag.startsWith("queue:return:"));
      if (correlation) {
        const peers = this.db.prepare(`SELECT outbox_id FROM outbox_entries
          WHERE delivery_state = 'pending' AND destination_session = ? AND substr(outbox_id, 1, ?) = ?
          AND EXISTS (SELECT 1 FROM json_each(outbox_entries.tags) WHERE value = ?)
          ORDER BY outbox_id`).all(first.destinationSession, WAKE_INTENT_PREFIX.length, WAKE_INTENT_PREFIX, correlation) as Array<{ outbox_id: string }>;
        for (const peer of peers) if (actionable(this.outbox!.getById(peer.outbox_id)!) && this.outbox!.claimForDelivery(peer.outbox_id)) intents.push(this.outbox!.getById(peer.outbox_id)!);
      }
      return intents;
    })();
    const intent = group[0];
    if (!intent) return superseded ? "failed" : "skipped";
    // 只为实际存在的 qitem 投递 wake。若 wake intent 的 target qitem 缺失——调用方在此前缀下记录的 id
    //（route 已不再拒绝），或 successor 已被 sweep——则 finalize 为 `failed`，绝不实际发送 wake。
    if (!intent.auditPointer || !this.getById(intent.auditPointer)) {
      this.outbox.finalizeDelivery(outboxId, "failed");
      return "failed";
    }
    const qitemId = intent.auditPointer ?? outboxId;
    // MF4：逐字发送 intent 中存储的冻结 envelope（不重新解析）。
    const outcome = await this.performWakeSend(
      qitemId, intent.destinationSession, intent.senderSession, undefined, group.map(entry => entry.body).join("\n"), group.map(entry => entry.outboxId),
    );
    const finalState = outcome.classified === "verified" ? "delivered" : outcome.classified;
    for (const member of group) {
      const intent = member;
      const qitemId = intent.auditPointer!;
      const blockerRef = intent.tags?.includes(AUTO_UNPARK_WAKE_TAG)
        ? intent.tags
            .find((tag) => tag.startsWith(AUTO_UNPARK_BLOCKER_TAG_PREFIX))
            ?.slice(AUTO_UNPARK_BLOCKER_TAG_PREFIX.length)
        : undefined;
      const wakeEvent = this.db.transaction(() => {
        this.recordNudgeAttempt(qitemId, outcome.nudgeResult);
        this.outbox!.finalizeDelivery(intent.outboxId, finalState);
        if (!blockerRef) return null;

        const item = this.getByIdOrThrow(qitemId);
        const transition = this.transitionLog.append({
          qitemId,
          state: item.state,
          actorSession: "queue@system",
          transitionNote: `blocker ${blockerRef} wake attempted; delivery=${outcome.nudgeResult}`,
        });
        this.wakeRepo.record({
          transitionId: transition.transitionId,
          qitemId,
          phase: "fired",
          kind: "blocker",
          ref: blockerRef,
          deliveryStatus: outcome.nudgeResult,
        });
        return this.eventBus.persistWithinTransaction({
          type: "queue.updated",
          qitemId,
          fromState: item.state,
          toState: item.state,
          closureReason: null,
          closureTarget: null,
          actorSession: "queue@system",
          summary: item.summary ?? null,
        });
      })();
      if (wakeEvent) this.eventBus.notifySubscribers(wakeEvent);
    }
    return finalState;
  }

  /**
   * W1-b：successor wake 的提交后投递，也是唯一共享 staged-intent 投递路径。持久 intent store
   * 存在（生产环境）时，投递刚提交的 intent，并 CLAIM 与 FINALIZE 该行，使后续 recovery sweep
   * 无法再次发送。缺席（test/bootstrap）时，回退到 W1 前的 best-effort nudge，使无 intent 可持久化
   * 的路径保持原行为。在 terminal transaction 提交后调用（绝不反转：pane 写入不得加入数据库事务）。
   *
   * 自 P34 起公开：每个暂存 intent 的 terminal-closing writer 都必须通过此路径投递，而不是
   * {@link maybeNudge}。`maybeNudge` 发送时不 claim 或 finalize，因此 staged intent 会保持
   * `pending`，启动 recovery sweep 会再次投递同一 wake。一个 staged intent、一次投递、一条
   * finalized 行。
   *
   * P34 修正：上方无 outbox fallback 只写在文档中，从未实现；未附加 outbox 时
   * `deliverWakeIntent` 只返回 "skipped"，nudge 因而静默消失（skip 不是错误，无法暴露）。W1 前的
   * 调用方只有在 MF2 guard 已证明附加 outbox 后才到达此路径，所以问题未显现。P34 将未附加 outbox
   * 的 harness writer 路由到此，因此 fallback 现已成为真实代码，而非注释承诺。
   */
  async deliverWakeForSuccessor(
    successorQitemId: string,
    destinationSession: string,
    nudge: boolean | undefined,
    sourceSession?: string,
  ): Promise<void> {
    if (nudge === false) return;
    // 无持久 intent store ⇒ 无 intent 可 claim/finalize。回退到 W1 前的 best-effort nudge，使 wake
    // 仍会发生（文档契约），而非静默跳过。
    if (!this.outbox) {
      await this.maybeNudge(successorQitemId, destinationSession, nudge, sourceSession);
      return;
    }
    await this.deliverWakeIntent(`${WAKE_INTENT_PREFIX}${successorQitemId}`);
  }

  /**
   * W1-b：启动 recovery sweep。投递因崩溃而处于已提交但未投递状态的 wake intent（terminal txn
   * 已提交，进程在提交后投递前退出）。以有界 batch 分页，在返回短 batch 或无进展轮次时终止
   *（抖动 transport 会将行标为 failed，因此仍算有进展）；绝不静默截断，也不空转。
   *
   * MF6（如实重试策略）：sweep 只重试 `pending` 行，即崩溃留下的已提交但未投递 wake intent。
   * 不重新驱动 terminal `failed` 和 `indeterminate` 行：failed 行可能复活已死亡 wake；
   * indeterminate 行可能已经落地（导致重复发送）。两者都保留为可见 terminal 状态，供带外协调。
   * 不设周期 timer（已裁定超出范围）；failed 行的有界重试是具名残留，而非静默保证。
   */
  /**
   * BLOCKING 1（guard 重新封闭）：recovery 边界协调，在启动时调用一次（不在可并发调用的 drain
   * 内）。将任何遗留 `sending` wake intent——此前崩溃进程的 claim——移到 `indeterminate`，不重新发送：
   * 留在 `sending` 的 claim 有歧义（send 可能已落地，也可能没有）。与 drainPendingWakeIntents 分离，
   * 使重叠 drain 绝不会协调其他 drain 的 in-flight claim。返回已协调数量。
   */
  reconcileAbandonedWakeIntents(): number {
    if (!this.outbox) return 0;
    return this.outbox.reconcileAbandonedSending(WAKE_INTENT_PREFIX);
  }

  async drainPendingWakeIntents(): Promise<{ delivered: number; indeterminate: number; failed: number; retained: number }> {
    const tally = { delivered: 0, indeterminate: 0, failed: 0, retained: 0 };
    if (!this.outbox || !this.transport) return tally;
    const BATCH = 200;
    for (;;) {
      const pending = this.outbox.listPending(WAKE_INTENT_PREFIX, BATCH);
      if (pending.length === 0) break;
      let progressed = 0;
      for (const intent of pending) {
        const outcome = await this.deliverWakeIntent(intent.outboxId);
        if (outcome === "delivered") { tally.delivered++; progressed++; }
        else if (outcome === "indeterminate") { tally.indeterminate++; progressed++; }
        else if (outcome === "failed") { tally.failed++; progressed++; }
        else if (outcome === "retained") { tally.retained++; progressed++; }
      }
      // 本轮剩余 pending 项均未改变状态（例如 transport 在 sweep 途中消失）；停止而非空转，下次后台
      // 服务启动时重试。
      if (progressed === 0) break;
      if (pending.length < BATCH) break; // 返回短 batch ⇒ 已排空。
    }
    return tally;
  }

  /**
   * 在 create / handoff / handoff-and-complete 提交后向 destination 发出默认 nudge。通过
   * recordNudgeAttempt 记录结果。捕获错误并作为 nudge_result 字符串展示，不展开底层 queue 修改。
   *
   * 阶段 D 扩展点（orch 已批准）：公开此方法，使 workflow-projector 可在外层 transaction 提交后
   * 调用，完成 createWithinTransaction() 推迟的提交后副作用。
   *
   * V0.3.1 slice 23 queue-handoff-envelope：nudge body 现在使用与 `rig send` 相同的
   * From/To/---/body/---/↩ Reply envelope 包装。`sourceSession` 是触发 create/handoff 的 seat，
   * 因此接收 pane 可显示 nudge 来源和回复提示。queue nudge 是唯一不可拒绝的 sender——没有 seat
   * 可供回传错误——所以 `sourceSession` 为 undefined 时，`wrapPaneEnvelope` 会在内部应用自己的
   * `<unknown sender>` fallback（`pane-envelope.ts`）。A1 后，这是树中 marker 的唯一实现（CLI
   * 副本已删除，改在 seat 边界拒绝）；此处没有自己的副本。
   */
  async maybeNudge(
    qitemId: string,
    destinationSession: string,
    nudgeOpt: boolean | undefined,
    sourceSession?: string,
    bodyOverride?: string,
  ): Promise<void> {
    if (nudgeOpt === false) return;
    if (!this.transport) return;
    const outcome = await this.performWakeSend(qitemId, destinationSession, sourceSession, bodyOverride);
    this.recordNudgeAttempt(qitemId, outcome.nudgeResult);
  }

  /**
   * W1（transactional closure）：共享 wake-send 核心。构建 pane envelope、带 verify 发送，并将
   * transport 结果分类到 W1 delivery 词汇（verified | indeterminate | failed）。它不触碰持久化；
   * 调用方决定记录内容：{@link maybeNudge} 记录 nudge 尝试；{@link deliverWakeIntent} 还会 CAS 标记
   * 持久 intent 行。仅在已设置 `this.transport` 时调用（由调用方守卫）。
   *
   * `indeterminate` 分类表示有歧义：`res.ok && !res.verified`——投递已进入 wire，但无法确认 render
   *（`delivered-ack-pending` nudge literal）。绝不提升为 delivered，也不降级为 failed。
   */
  private async performWakeSend(
    qitemId: string,
    destinationSession: string,
    sourceSession?: string,
    bodyOverride?: string,
    prebuiltText?: string,
    committedOutboxIds?: string[],
  ): Promise<{ classified: "verified" | "indeterminate" | "failed" | "retained"; nudgeResult: string }> {
    // 缺陷修复 qitem-20260827065907-b9ae334c（S1 类，3 个线上样本）：虚拟 @external destination
    // 没有 pane，queue 行本身就是 gateway 子系统输入（Slack connector 轮询 human-destined 行，
    // 自身 ledger 即投递记录）。此处回落到 tmux 会记录“failed: … tmux reports no session”，即使
    // founder 已明确收到消息，该 failed: literal 仍会污染 undelivered surface。
    // OPR.0.5.6.14——行内 @external 分支成为唯一 RESOLVER 接缝
    //（gateway/destination-resolver.ts）：pane-bound 保持 terminal transport；gateway-routable
    //（@external，以及 registry 解析的别名，如无 pane 的 human-*@kernel 虚拟 identity——线上 4 行
    // 样本类别）归 GATEWAY 所有（从不查询 tmux；connector 行轮询即 dispatch，自身 ledger 即投递
    // 记录）；二者都不是如实的结构化教学拒绝（tmux 不应查询它永远无法持有的地址）。gateway
    // 分类为 indeterminate（已落到所属子系统，但此处无法确认 render），绝非 verified 或 failed。
    const destClass = classifyDestination(destinationSession, {
      entities: (() => {
        const loaded = this.loadHumanRegistryFn();
        return loaded.ok ? loaded.entities : null;
      })(),
      hasTerminalTransport: (dest) => this.hasTerminalTransport(dest),
    });
    if (destClass.class === "gateway-routable") {
      const resolvedNote = destClass.via === "registry-alias" && destClass.resolvedHuman
        ? `——human registry 将其解析为已注册 human '${destClass.resolvedHuman}'`
        : "";
      return {
        classified: "indeterminate",
        nudgeResult:
          `gateway-owned: '${destinationSession}' 是虚拟 ${destClass.via === "registry-alias" ? "无 pane human" : "@external"} destination${resolvedNote}——投递由 gateway 子系统（Slack connector）负责，其自身 ledger 即投递记录；未查询 tmux（它永远无法持有此类地址）`,
      };
    }
    if (destClass.class === "unroutable") {
      return { classified: "failed", nudgeResult: destClass.teaching };
    }
    const stampISO = new Date().toISOString();
    let text: string;
    if (prebuiltText !== undefined) {
      // MF4：持久 wake intent 携带冻结的 envelope（generation 在 STAGE 时解析）。逐字投递，绝不
      // 重建，使 tenure 交换后的崩溃恢复重放发送时 generation，而非当前 generation。
      text = prebuiltText;
    } else {
      // OPR.0.4.4.19 FR-7：bodyOverride 让 resolve 动词把 decision 文本传给 parked owner；默认仍为
      // 交接提醒。
      const bareBody = bodyOverride ?? `Queue handoff：${qitemId} - 请检查你的 queue。`;
      // GHOST-STAGE (h)：从 g 推迟的唯一 HG-5 基线变更——handoff nudge 现在携带 Sent: stamp
      //（与 rig send 按字节一致渲染），以及 SOURCE seat 的 occupant generation（g 已接线的 render，
      // 在此解析；缺席=UNKNOWN=省略，绝不伪造）。stampISO 也传给 transport 的 delivered-latency flag，
      // 使等待 busy / mid-handover successor 的 nudge 自动显示 ' · delivered +Ns'。
      const genUuid = sourceSession
        ? (this.resolveOccupantGeneration?.(sourceSession) ?? undefined)
        : undefined;
      text = wrapPaneEnvelope(sourceSession, destinationSession, bareBody, { stampISO, genUuid });
    }
    const deliveryId = `guard-nudge-${qitemId}-${createHash("sha256").update(JSON.stringify([sourceSession, destinationSession, bodyOverride ?? null])).digest("hex")}`;
    const held = !committedOutboxIds ? this.outbox?.getById(deliveryId) : null;
    if (held?.deliveryState === "retained" || held?.deliveryState === "retired") {
      // 相同逻辑 nudge 复用原冻结 envelope，而非新时间戳。
      text = held.body;
    }
    try {
      const res = await this.transport!.send(destinationSession, text, { verify: true, stampISO, actorSession: sourceSession, committedOutboxIds, deliveryId: committedOutboxIds ? undefined : deliveryId, auditPointer: qitemId });
      // OPR.0.3.2.21.FR-4(c)——措辞重命名：旧 literal `sent-unverified` 即使在常见情况下也看似失败
      //（已确认投递，但同步 ack 窗口过期；这对任务中的 codex seat 很正常）。新 literal
      // `delivered-ack-pending` 表示健康。旧 `verified` 情形不变，以向后兼容已消费该正向 literal
      // 的工具。
      if (res.outcome === "retained") return { classified: "retained", nudgeResult: "retained:typing_guard" };
      if (res.ok) {
        return res.verified
          ? { classified: "verified", nudgeResult: "verified" }
          : { classified: "indeterminate", nudgeResult: "delivered-ack-pending" };
      }
      // MF6：超时有歧义——send 可能已经落地，只是 ack 窗口过期——因此记录 `indeterminate`
      //（绝不静默标为 delivered，也不标为确定 `failed`）。明确的非超时失败（不可达、未知 session）
      // 保持 `failed`。
      const detail = res.error ?? res.reason ?? "unknown";
      if (isWakeTimeoutSignal(res.reason) || isWakeTimeoutSignal(res.error)) {
        return { classified: "indeterminate", nudgeResult: `indeterminate:${detail}` };
      }
      return { classified: "failed", nudgeResult: `failed:${detail}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 抛出的超时同样有歧义（见上方）。
      if (isWakeTimeoutSignal(msg)) {
        return { classified: "indeterminate", nudgeResult: `indeterminate:${msg}` };
      }
      return { classified: "failed", nudgeResult: `failed:${msg}` };
    }
  }

  async create(input: QueueCreateInput): Promise<QueueItem> {
    // FOUNDER 根不变量（2026-08-27，取代 51-09 增量 4 / 裁定 cb19867f Q2）：本地写入存储裸
    // transport identity，同一 instance 内不加 self-host 后缀。host identity 只在跨 host 转发边界
    // 添加（routes/queue.ts 的 forward 时盖章）；从 forward 到达的真实 origin 三元组逐字存储
    //（不重新盖章，也不剥离）。
    if (!this.validateRig(input.destinationSession)) {
      throw destinationValidationError("destination_session", input.destinationSession, this.loadHumanRegistryFn);
    }

    const txn = this.db.transaction(() => this.createInTransactionalContext(input));
    let id: string;
    let persistedEvent: PersistedEvent;
    try {
      ({ qitemId: id, persistedEvent } = txn());
    } catch (err) {
      // OPR.0.4.6.MH3 Q-a（FR-5）：至少一次的跨 host forward 使用同一已生成 qitemId 重试，因此
      // 现有行上的 PK 冲突在 identity 字段匹配时属于幂等重新投递——返回已存储行（不二次插入，也不
      // 产生第二个 event/nudge）。identity 字段不同的冲突（相同 id，不同 destination/source）是调用方
      // id 复用 bug——返回结构化错误，绝不静默覆盖。本地（非 forward）create 传显式 --id 时也自然
      // 获得同等安全性。
      if (input.qitemId && isQitemPrimaryKeyConflict(err)) {
        const existing = this.getById(input.qitemId);
        if (existing) {
          if (
            existing.destinationSession === input.destinationSession &&
            existing.sourceSession === input.sourceSession
          ) {
            return existing;
          }
          throw new QueueRepositoryError(
            "qitem_id_reuse",
            `qitem ${input.qitemId} 已存在，但 destination/source 不同——id 复用是调用方 bug，不是幂等重试`,
            {
              qitemId: input.qitemId,
              existingDestination: existing.destinationSession,
              existingSource: existing.sourceSession,
            },
          );
        }
      }
      throw err;
    }
    this.eventBus.notifySubscribers(persistedEvent);
    await this.maybeNudge(id, input.destinationSession, input.nudge, input.sourceSession);
    return this.getByIdOrThrow(id);
  }

  /**
   * PL-004 阶段 D 扩展点（orch 按 slice IMPL § Driver Handoff Contract 批准）。使用调用方管理的
   * 同一 db.transaction 创建 queue item，以获得 transactional-scribe 语义（workflow-projector
   * 将 step closure + next-qitem create 合并为一个原子单元）。返回已持久化 event 和 qitem id，使
   * 调用方可将 notifySubscribers/maybeNudge 推迟到外层 transaction 提交后。
   *
   * 调用方必须：
   *   1. 从 `db.transaction(() => {...})` block 内调用。
   *   2. 外层 transaction 提交后调用：
   *        - eventBus.notifySubscribers(persistedEvent)
   *        - this.maybeNudge(qitemId, destinationSession, input.nudge)
   *   3. 不得在 transaction 外调用（调用方提交前出错会产生半状态）。
   *
   * 这项拆分只因 notifySubscribers + maybeNudge 是提交后副作用而存在（订阅者不应看到可能回滚
   * 数据的 event；也不应为可能回滚的 handoff 触发 nudge）。无需与外层 transaction 组合的独立
   * create() 应改用 create()。
   */
  createWithinTransaction(input: QueueCreateInput): {
    qitemId: string;
    persistedEvent: PersistedEvent;
    destinationSession: string;
    nudge: boolean | undefined;
  } {
    if (!this.validateRig(input.destinationSession)) {
      throw destinationValidationError("destination_session", input.destinationSession, this.loadHumanRegistryFn);
    }
    const result = this.createInTransactionalContext(input);
    return {
      qitemId: result.qitemId,
      persistedEvent: result.persistedEvent,
      destinationSession: input.destinationSession,
      nudge: input.nudge,
    };
  }

  /**
   * 内部：insert + transition + emit event。调用方负责包裹 transaction（公共 create() 会包裹；公共
   * createWithinTransaction() 不会——调用方外层 transaction 提供原子边界）。
   */
  private createInTransactionalContext(input: QueueCreateInput): {
    qitemId: string;
    persistedEvent: PersistedEvent;
  } {
    // OPR.0.4.4.19 FR-4/FR-5——human-routed item 在 domain 写入路径要求 summary + evidence_ref
    //（validateClosure 模式）。validator 对非 human-routed item 为 no-op（BR-1）。
    const humanRoute = validateHumanRoute({
      tier: input.tier ?? null,
      destinationSession: input.destinationSession,
      summary: input.summary ?? null,
      evidenceRef: input.evidenceRef ?? null,
    });
    if (!humanRoute.ok) {
      throw new QueueRepositoryError(humanRoute.code, humanRoute.message, {
        missingFields: humanRoute.missingFields,
      });
    }
    if (input.humanIntent != null && input.humanIntent !== "decision" && input.humanIntent !== "update") {
      throw new QueueRepositoryError("invalid_human_notification", "humanIntent 必须是 decision 或 update；省略时保留旧版 decision 行为。");
    }
    if (input.humanDetail != null && (typeof input.humanDetail !== "string" || !input.humanDetail.trim())) {
      throw new QueueRepositoryError("invalid_human_notification", "humanDetail 必须是非空补充文本，或省略。");
    }
    if (input.humanIntent != null || input.humanDetail != null) {
      if (!isHumanSeatSessionRef(input.destinationSession)) {
        throw new QueueRepositoryError("invalid_human_notification", "humanIntent/humanDetail 要求 human destination；agent continuation 应放在自己的 qitem 中。");
      }
      if (!this.hasHumanIntentColumn) throw new QueueRepositoryError("invalid_human_notification", "人工通知字段要求当前 queue schema；这些字段未保存。");
    }
    const id = input.qitemId ?? newQitemId();
    const ts = new Date().toISOString();
    const priority = input.priority ?? "routine";
    const tier = input.tier ?? null;
    const tags = input.tags ? JSON.stringify(input.tags) : null;
    const chain = input.chainOfRecord ? JSON.stringify(input.chainOfRecord) : null;
    const expiresAt = input.expiresAt ?? null;
    const targetRepo = input.targetRepo ?? null;
    // 0.5.1-53 Atom 2b——supersession back-link（successor → 被替换行）。普通 create 时缺席。
    const handedOffFrom = input.handedOffFrom ?? null;

    if (this.hasTargetRepoColumn) {
      this.db
        .prepare(
          `INSERT INTO queue_items (
            qitem_id, ts_created, ts_updated, source_session, destination_session,
            state, priority, tier, tags, expires_at, chain_of_record, handed_off_from, body, target_repo
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, ts, ts, input.sourceSession, input.destinationSession, priority, tier, tags, expiresAt, chain, handedOffFrom, input.body, targetRepo);
    } else {
      this.db
        .prepare(
          `INSERT INTO queue_items (
            qitem_id, ts_created, ts_updated, source_session, destination_session,
            state, priority, tier, tags, expires_at, chain_of_record, handed_off_from, body
          ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, ts, ts, input.sourceSession, input.destinationSession, priority, tier, tags, expiresAt, chain, handedOffFrom, input.body);
    }
    this.persistSummary(id, input.summary ?? null);
    this.persistEvidenceRef(id, input.evidenceRef ?? null);
    if (this.hasHumanIntentColumn) {
      this.db.prepare("UPDATE queue_items SET human_intent = ?, human_detail = ? WHERE qitem_id = ?")
        .run(input.humanIntent ?? null, input.humanDetail ?? null, id);
    }
    this.persistMintingGeneration(id, input.sourceSession);
    const notification = this.classifyOwnerNotification({
      action: "create",
      humanIntent: input.humanIntent,
      destinationSession: input.destinationSession,
      nextState: "pending",
    });
    this.transitionLog.append({
      qitemId: id,
      state: "pending",
      actorSession: input.sourceSession,
      transitionNote: "created",
      identityProvenance: input.identityProvenance ?? null, // P21 §4 era-stamp
      ownerNotificationKind: notification?.kind,
      ownerNotificationLevel: notification?.level,
    });
    const persistedEvent = this.eventBus.persistWithinTransaction({
      type: "queue.created",
      qitemId: id,
      sourceSession: input.sourceSession,
      destinationSession: input.destinationSession,
      priority,
      tier,
      summary: input.summary ?? null,
    });
    return { qitemId: id, persistedEvent };
  }

  /**
   * 事务式 handoff：关闭 source qitem（state=done、closure_reason=handed_off_to），并创建由
   * `toSession` 拥有的新 qitem，以 `handed_off_from` 记录链路。一个原子事务。
   */
  async handoff(input: QueueHandoffInput): Promise<{ closed: QueueItem; created: QueueItem }> {
    const source = this.getById(input.qitemId);
    if (!source) {
      throw new QueueRepositoryError(
        "qitem_not_found",
        `找不到 qitem ${input.qitemId}`
      );
    }
    if (isTerminalState(source.state)) {
      throw new QueueRepositoryError(
        "qitem_already_terminal",
        `qitem ${input.qitemId} 已处于 terminal 状态 ${source.state}`
      );
    }
    if (!this.validateRig(input.toSession)) {
      throw destinationValidationError("to_session", input.toSession, this.loadHumanRegistryFn);
    }

    const newId = newQitemId();
    const ts = new Date().toISOString();
    const body = input.body ?? source.body;
    const priority = input.priority ?? source.priority;
    const tier = input.tier ?? source.tier;
    const tags = input.tags ? JSON.stringify(input.tags) : (source.tags ? JSON.stringify(source.tags) : null);
    const chain = JSON.stringify([...(source.chainOfRecord ?? []), source.qitemId]);
    const targetRepo = input.targetRepo === undefined ? source.targetRepo : input.targetRepo;

    // OPR.0.4.4.19 FR-4/FR-5——handoff 编写一个新 qitem；新 item 为 human-routed 时要求自身的
    // summary + evidence_ref（两者都不从 source 继承——保留 044 语义）。
    const humanRoute = validateHumanRoute({
      tier,
      destinationSession: input.toSession,
      summary: input.summary ?? null,
      evidenceRef: input.evidenceRef ?? null,
    });
    if (!humanRoute.ok) {
      throw new QueueRepositoryError(humanRoute.code, humanRoute.message, {
        missingFields: humanRoute.missingFields,
      });
    }

    const events: Array<{ name: string; payload: import("./types.js").RigEvent }> = [];

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE queue_items
             SET state = 'handed-off',
                 ts_updated = ?,
                 handed_off_to = ?,
                 closure_reason = 'handed_off_to',
                 closure_target = ?
           WHERE qitem_id = ?`
        )
        .run(ts, input.toSession, input.toSession, source.qitemId);

      this.transitionLog.append({
        qitemId: source.qitemId,
        state: "handed-off",
        actorSession: input.fromSession,
        transitionNote: input.transitionNote ?? `handed off to ${input.toSession}`,
        closureReason: "handed_off_to",
        closureTarget: input.toSession,
        identityProvenance: input.identityProvenance ?? null, // P21 §4 era-stamp。
      });

      // OPR.0.5.8.1 S1b——创始样本经过的实际路线。行 b7a70333 于 10:02:03Z 进入 handed-off，
      // 其 timer 仍在 10:18:07Z 触发，因为 handoff() 使用自身事务，绝不经过 update()。
      this.retireParkGeneratedTimer(source.qitemId, "park_ended:handed-off");

      if (this.hasTargetRepoColumn) {
        this.db
          .prepare(
            `INSERT INTO queue_items (
              qitem_id, ts_created, ts_updated, source_session, destination_session,
              state, priority, tier, tags, handed_off_from, chain_of_record, body, target_repo
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(newId, ts, ts, input.fromSession, input.toSession, priority, tier, tags, source.qitemId, chain, body, targetRepo);
      } else {
        this.db
          .prepare(
            `INSERT INTO queue_items (
              qitem_id, ts_created, ts_updated, source_session, destination_session,
              state, priority, tier, tags, handed_off_from, chain_of_record, body
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
          )
          .run(newId, ts, ts, input.fromSession, input.toSession, priority, tier, tags, source.qitemId, chain, body);
      }

      this.persistSummary(newId, input.summary ?? null);
      this.persistEvidenceRef(newId, input.evidenceRef ?? null);
      this.persistMintingGeneration(newId, input.fromSession);

      const successorNotification = this.classifyOwnerNotification({
        action: "create",
        destinationSession: input.toSession,
        nextState: "pending",
      });
      this.transitionLog.append({
        qitemId: newId,
        state: "pending",
        actorSession: input.fromSession,
        transitionNote: `handoff from ${source.qitemId}`,
        identityProvenance: input.identityProvenance ?? null, // P21 §4 era-stamp。
        ownerNotificationKind: successorNotification?.kind,
        ownerNotificationLevel: successorNotification?.level,
      });

      // W1-a：持久 wake intent 加入 close + successor create 的同一事务。此处或上方任一步骤抛错，
      // 整个操作回滚——一个操作或全无。
      this.stageWakeIntent(newId, input.fromSession, input.toSession, input.identityProvenance ?? null, input.nudge);

      const handoffEvent = this.eventBus.persistWithinTransaction({
        type: "queue.handed_off",
        qitemId: source.qitemId,
        fromSession: input.fromSession,
        toSession: input.toSession,
        closureReason: "handed_off_to",
        summary: source.summary ?? null,
      });
      events.push({ name: "queue.handed_off", payload: handoffEvent });

      // OPR.0.5.6.26——handed-off blocker 通过唯一 propagation 位置驱动其附属行，使用与 update
      // 路径完全相同的 effect set。
      for (const dependentEvent of this.propagateBlockerCompletion({
        qitemId: source.qitemId,
        terminalState: "handed-off",
        actorSession: input.fromSession,
        identityProvenance: input.identityProvenance ?? null,
        ts,
      })) {
        events.push({ name: "queue.updated", payload: dependentEvent });
      }

      const createdEvent = this.eventBus.persistWithinTransaction({
        type: "queue.created",
        qitemId: newId,
        sourceSession: input.fromSession,
        destinationSession: input.toSession,
        priority,
        tier,
        summary: input.summary ?? null,
      });
      events.push({ name: "queue.created", payload: createdEvent });

      // W1-c：接缝守卫——terminal transaction 的最后一条语句。本应 wake 的 close 若无持久 intent
      // 就无法提交；此处抛错会在接缝回滚整个操作。
      this.assertTerminalClosureHasIntent(source.qitemId, newId, input.nudge);
    });

    txn();
    for (const e of events) {
      this.eventBus.notifySubscribers(e.payload as import("./types.js").PersistedEvent);
    }

    // W1-b：投递刚提交的 wake intent（并标记），或在未附加 intent store 时使用 W1 前的
    // best-effort nudge。仅在提交后执行。
    await this.deliverWakeForSuccessor(newId, input.toSession, input.nudge, input.fromSession);

    return {
      closed: this.getByIdOrThrow(source.qitemId),
      created: this.getByIdOrThrow(newId),
    };
  }

  /**
   * {@link handoff} 的变体：将 source qitem 关闭为 `done`（terminal closure），而不是
   * `handed-off`（中间状态）。保持相同的原子 close+create、chain_of_record 语义和默认 nudge 行为。
   * 用于 source seat 已完全完成工作，不再需要针对 source qitem 追踪后续项的情况。
   */
  async handoffAndComplete(input: QueueHandoffAndCompleteInput): Promise<{ closed: QueueItem; created: QueueItem }> {
    const source = this.getById(input.qitemId);
    if (!source) {
      throw new QueueRepositoryError(
        "qitem_not_found",
        `找不到 qitem ${input.qitemId}`
      );
    }
    if (isTerminalState(source.state)) {
      throw new QueueRepositoryError(
        "qitem_already_terminal",
        `qitem ${input.qitemId} 已处于 terminal 状态 ${source.state}`
      );
    }
    if (!this.validateRig(input.toSession)) {
      throw destinationValidationError("to_session", input.toSession, this.loadHumanRegistryFn);
    }

    const newId = newQitemId();
    const ts = new Date().toISOString();
    const body = input.body ?? source.body;
    const priority = input.priority ?? source.priority;
    const tier = input.tier ?? source.tier;
    const tags = input.tags ? JSON.stringify(input.tags) : (source.tags ? JSON.stringify(source.tags) : null);
    const chain = JSON.stringify([...(source.chainOfRecord ?? []), source.qitemId]);
    const targetRepo = input.targetRepo === undefined ? source.targetRepo : input.targetRepo;

    // OPR.0.4.4.19 FR-4/FR-5——与 handoff() 相同的新 item 强制规则。
    const humanRoute = validateHumanRoute({
      tier,
      destinationSession: input.toSession,
      summary: input.summary ?? null,
      evidenceRef: input.evidenceRef ?? null,
    });
    if (!humanRoute.ok) {
      throw new QueueRepositoryError(humanRoute.code, humanRoute.message, {
        missingFields: humanRoute.missingFields,
      });
    }

    const events: Array<{ name: string; payload: import("./types.js").RigEvent }> = [];

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE queue_items
             SET state = 'done',
                 ts_updated = ?,
                 handed_off_to = ?,
                 closure_reason = 'handed_off_to',
                 closure_target = ?
           WHERE qitem_id = ?`
        )
        .run(ts, input.toSession, input.toSession, source.qitemId);

      this.transitionLog.append({
        qitemId: source.qitemId,
        state: "done",
        actorSession: input.fromSession,
        transitionNote: input.transitionNote ?? `handoff-and-complete to ${input.toSession}`,
        closureReason: "handed_off_to",
        closureTarget: input.toSession,
        identityProvenance: input.identityProvenance ?? null, // P21 §4 era-stamp。
      });

      // OPR.0.5.8.1 S1b——与 handoff() 相同的结构性旁路：使用自身事务，绝不经过 update()。
      this.retireParkGeneratedTimer(source.qitemId, "park_ended:done");

      if (this.hasTargetRepoColumn) {
        this.db
          .prepare(
            `INSERT INTO queue_items (
              qitem_id, ts_created, ts_updated, source_session, destination_session,
              state, priority, tier, tags, handed_off_from, chain_of_record, body, target_repo
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(newId, ts, ts, input.fromSession, input.toSession, priority, tier, tags, source.qitemId, chain, body, targetRepo);
      } else {
        this.db
          .prepare(
            `INSERT INTO queue_items (
              qitem_id, ts_created, ts_updated, source_session, destination_session,
              state, priority, tier, tags, handed_off_from, chain_of_record, body
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`
          )
          .run(newId, ts, ts, input.fromSession, input.toSession, priority, tier, tags, source.qitemId, chain, body);
      }

      this.persistSummary(newId, input.summary ?? null);
      this.persistEvidenceRef(newId, input.evidenceRef ?? null);
      this.persistMintingGeneration(newId, input.fromSession);

      const successorNotification = this.classifyOwnerNotification({
        action: "create",
        destinationSession: input.toSession,
        nextState: "pending",
      });
      this.transitionLog.append({
        qitemId: newId,
        state: "pending",
        actorSession: input.fromSession,
        transitionNote: `handoff-and-complete from ${source.qitemId}`,
        ownerNotificationKind: successorNotification?.kind,
        ownerNotificationLevel: successorNotification?.level,
      });

      // W1-a：持久 wake intent 加入 close + successor create 的同一事务——一个操作或全无
      //（与 handoff() 对称）。
      this.stageWakeIntent(newId, input.fromSession, input.toSession, input.identityProvenance ?? null, input.nudge);

      const handoffEvent = this.eventBus.persistWithinTransaction({
        type: "queue.handed_off",
        qitemId: source.qitemId,
        fromSession: input.fromSession,
        toSession: input.toSession,
        closureReason: "handed_off_to",
        summary: source.summary ?? null,
      });
      events.push({ name: "queue.handed_off", payload: handoffEvent });

      // OPR.0.5.6.26——经 handoff-and-complete 进入 done 的 blocker 通过唯一 propagation 位置
      // 驱动其附属行，使用与 update 路径完全相同的 effect set（已确认的 R-2 预测）。
      for (const dependentEvent of this.propagateBlockerCompletion({
        qitemId: source.qitemId,
        terminalState: "done",
        actorSession: input.fromSession,
        identityProvenance: input.identityProvenance ?? null,
        ts,
      })) {
        events.push({ name: "queue.updated", payload: dependentEvent });
      }

      const createdEvent = this.eventBus.persistWithinTransaction({
        type: "queue.created",
        qitemId: newId,
        sourceSession: input.fromSession,
        destinationSession: input.toSession,
        priority,
        tier,
        summary: input.summary ?? null,
      });
      events.push({ name: "queue.created", payload: createdEvent });

      // W1-c：接缝守卫——terminal transaction 的最后一条语句。本应 wake 的 close 若无持久 intent
      // 就无法提交；此处抛错会在接缝回滚整个操作。
      this.assertTerminalClosureHasIntent(source.qitemId, newId, input.nudge);
    });

    txn();
    for (const e of events) {
      this.eventBus.notifySubscribers(e.payload as import("./types.js").PersistedEvent);
    }

    // W1-b：投递刚提交的 wake intent（并标记），或在未附加 intent store 时使用 W1 前的
    // best-effort nudge。仅在提交后执行。
    await this.deliverWakeForSuccessor(newId, input.toSession, input.nudge, input.fromSession);

    return {
      closed: this.getByIdOrThrow(source.qitemId),
      created: this.getByIdOrThrow(newId),
    };
  }

  /**
   * OPR.0.4.6.MH3 FR-4（C2，arch Q-c）：跨 host handoff 的本地半边——successor-create 已转发到
   * 目标 host 并被接受后，才关闭 source 行。两侧位于两个数据库中，因此刻意不采用 {@link handoff}
   * 的原子 close+create；通过消息传递跨越边界（先在 origin host 执行 successor-create，再执行此
   * source-close，绝不反转。因此两者之间崩溃会留下 live 副本，可由幂等重新驱动收敛，而不会丢失
   * 烫手山芋）。
   *
   * 重新驱动语义（FR-4/FR-5，被中断 close 情形）：
   *   - source 已 terminal 且 closureTarget 匹配 → 幂等吸收：原样返回已存储行（`absorbed: true`），
   *     不二次 close，也不产生第二个 event。
   *   - source 已 terminal 但 closureTarget 不匹配 → 结构化 `cross_host_close_conflict`
   *     （其间被其他方关闭；展示冲突，绝不覆盖）。
   *   - 否则 → 与本地 handoff close 分支完全相同：`closure_reason=handed_off_to`；
   *     `closure_target` 携带带 host 限定的 successor key `<qitem-id>@<host>`（custody metadata，
   *     绝非本地 lookup key）；`handed_off_to` 保持两段 `member@rig`（BR-1——session-string carrier
   *     永不增加 `@host`）。
   */
  closeCrossHostHandoffSource(input: {
    qitemId: string;
    fromSession: string;
    /** 两段 `member@rig` destination——session-string carrier（BR-1）。 */
    toSession: string;
    /** 带 host 限定的 successor `<qitem-id>@<host>` closure target。 */
    closureTarget: string;
    /** /handoff 使用 `handed-off`；/handoff-and-complete 使用 `done`。 */
    terminalState: "handed-off" | "done";
    transitionNote?: string;
  }): { item: QueueItem; absorbed: boolean } {
    const source = this.getById(input.qitemId);
    if (!source) {
      throw new QueueRepositoryError(
        "qitem_not_found",
        `找不到 qitem ${input.qitemId}`
      );
    }
    if (isTerminalState(source.state)) {
      if (source.closureTarget === input.closureTarget) {
        return { item: source, absorbed: true };
      }
      throw new QueueRepositoryError(
        "cross_host_close_conflict",
        `qitem ${input.qitemId} 已向 ${source.closureTarget ?? "<无 closure_target>"} 关闭——本次重新驱动指定 ${input.closureTarget}；展示冲突，绝不覆盖`,
        {
          qitemId: input.qitemId,
          existingClosureTarget: source.closureTarget,
          attemptedClosureTarget: input.closureTarget,
        },
      );
    }

    const ts = new Date().toISOString();
    const events: Array<import("./types.js").RigEvent> = [];

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE queue_items
             SET state = ?,
                 ts_updated = ?,
                 handed_off_to = ?,
                 closure_reason = 'handed_off_to',
                 closure_target = ?
           WHERE qitem_id = ?`
        )
        .run(input.terminalState, ts, input.toSession, input.closureTarget, input.qitemId);

      this.transitionLog.append({
        qitemId: input.qitemId,
        state: input.terminalState,
        actorSession: input.fromSession,
        // BR-1：生成的 note 只携带两段 toSession；带 host 限定的 successor key 只允许出现在
        // closure_target，transition_note 是持久 carrier。
        transitionNote: input.transitionNote ?? `cross-host handoff to ${input.toSession}`,
        closureReason: "handed_off_to",
        closureTarget: input.closureTarget,
      });

      // OPR.0.5.8.1 S1b——handoff 家族第三个成员，使用相同旁路。
      this.retireParkGeneratedTimer(input.qitemId, `park_ended:${input.terminalState}`);

      const handoffEvent = this.eventBus.persistWithinTransaction({
        type: "queue.handed_off",
        qitemId: input.qitemId,
        fromSession: input.fromSession,
        // event body 是 session-string carrier——仅允许两段（BR-1）。
        toSession: input.toSession,
        closureReason: "handed_off_to",
        summary: source.summary ?? null,
      });
      events.push(handoffEvent);

      // OPR.0.5.6.26（R2 B-1）——跨 host terminal close 是唯一 propagation 位置的第三个 handoff
      // 家族调用方：附属行在此次 close 的实际 terminal 状态下，使用与 update 路径完全相同的 effect
      // set 驱动。被吸收的重新驱动会在此事务上方返回，绝不重跑。
      for (const dependentEvent of this.propagateBlockerCompletion({
        qitemId: input.qitemId,
        terminalState: input.terminalState,
        actorSession: input.fromSession,
        identityProvenance: null,
        ts,
      })) {
        events.push(dependentEvent);
      }
    });

    txn();
    for (const e of events) {
      this.eventBus.notifySubscribers(e as PersistedEvent);
    }

    return { item: this.getByIdOrThrow(input.qitemId), absorbed: false };
  }

  /**
   * `whoami`——从后台服务视角返回 seat 的 queue 位置。统计指向调用方的 active qitem
   *（pending + in-progress + blocked），列出最近 active qitem，并报告调用方作为 outgoing source
   * 的计数。只读，不修改。
   *
   * 依据 PL-004 阶段 A § Routes：GET /api/queue/whoami。
   */
  whoami(session: string, opts?: { recentLimit?: number }): {
    session: string;
    asDestination: { pending: number; inProgress: number; blocked: number; recent: QueueItem[] };
    asSource: { total: number };
  } {
    const limit = Math.max(1, Math.min(opts?.recentLimit ?? 25, 200));
    const countByState = (state: string): number => {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM queue_items WHERE destination_session = ? AND state = ?`
        )
        .get(session, state) as { n: number };
      return row.n;
    };
    const recent = this.db
      .prepare(
        `SELECT * FROM queue_items
          WHERE destination_session = ?
            AND state IN ('pending','in-progress','blocked')
          ORDER BY ts_updated DESC
          LIMIT ?`
      )
      .all(session, limit) as QueueItemRow[];
    const sourceTotalRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM queue_items WHERE source_session = ?`)
      .get(session) as { n: number };
    return {
      session,
      asDestination: {
        pending: countByState("pending"),
        inProgress: countByState("in-progress"),
        blocked: countByState("blocked"),
        recent: recent.map((r) => this.rowToItem(r)),
      },
      asSource: { total: sourceTotalRow.n },
    };
  }

  /**
   * 所有指向 `session` 的 in-progress 行，无上限且只含单一状态。
   *
   * `whoami` 的 `recent` 是展示投影：有上限（默认 25，最大 200），且混合
   * pending/in-progress/blocked。任何必须判断 seat 实际持有多少 baton 的逻辑——尤其是因歧义而触发
   * 的拒绝——都不能读取它，因为超过上限的第二个 in-progress 行不可见，拒绝会静默退化成确定答案。
   * 这才是权威输入。
   */
  listInProgressForDestination(session: string): QueueItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM queue_items WHERE destination_session = ? AND state = 'in-progress'`
      )
      .all(session) as QueueItemRow[];
    return rows.map((r) => this.rowToItem(r));
  }

  /**
   * 将 qitem 标为 `in-progress`（claim），并根据 tier 计算 closure_required_at。
   */
  claim(input: QueueClaimInput): QueueItem {
    const qitem = this.getById(input.qitemId);
    if (!qitem) {
      throw new QueueRepositoryError(
        "qitem_not_found",
        `找不到 qitem ${input.qitemId}`
      );
    }
    if (qitem.destinationSession !== input.destinationSession) {
      throw new QueueRepositoryError(
        "claim_destination_mismatch",
        `qitem ${input.qitemId} 的 destination 是 ${qitem.destinationSession}，而不是 ${input.destinationSession}`
      );
    }
    if (qitem.state !== "pending" && qitem.state !== "blocked") {
      throw new QueueRepositoryError(
        "qitem_not_claimable",
        `qitem ${input.qitemId} 处于 ${qitem.state} 状态；只有 pending/blocked 可 claim`
      );
    }

    const ts = new Date().toISOString();
    const closureRequiredAt = computeClosureRequiredAt(ts, qitem.tier);

    // GHOST-STAGE（e/Class-B）：盖上 CLAIMANT 的 occupant generation。这是 ghost 判别器——handover
    // 中 successor 复用 seat 名，因此按名称范围释放会中和 successor 自己的 claim；retiring generation
    // 的 claim 按 gen 释放。
    const claimedByGeneration = this.hasClaimedGenColumn
      ? (this.resolveOccupantGeneration?.(input.destinationSession) ?? null)
      : null;

    const txn = this.db.transaction(() => {
      if (this.hasClaimedGenColumn) {
        this.db
          .prepare(
            `UPDATE queue_items
               SET state = 'in-progress', ts_updated = ?, claimed_at = ?, closure_required_at = ?,
                   claimed_by_generation_uuid = ?
             WHERE qitem_id = ?`
          )
          .run(ts, ts, closureRequiredAt, claimedByGeneration, input.qitemId);
      } else {
        this.db
          .prepare(
            `UPDATE queue_items
               SET state = 'in-progress', ts_updated = ?, claimed_at = ?, closure_required_at = ?
             WHERE qitem_id = ?`
          )
          .run(ts, ts, closureRequiredAt, input.qitemId);
      }

      this.transitionLog.append({
        qitemId: input.qitemId,
        state: "in-progress",
        actorSession: input.destinationSession,
        transitionNote: "claimed",
        identityProvenance: input.identityProvenance ?? null, // P21 §4 era-stamp。
      });

      // OPR.0.5.8.1 S1b——CLAIM-RESUME。blocked 行可 claim（“只有 pending/blocked 可 claim”），
      // 因此 claiming 是真正离开 park，并直接写 state，而非经过 update()。这正是 story 契约点名的
      // transition；首次修复通过 `update()` 钉扎了相同结果的另一种写法，所以看起来像已覆盖。
      this.retireParkGeneratedTimer(input.qitemId, "park_ended:claimed");

      return this.eventBus.persistWithinTransaction({
        type: "queue.claimed",
        qitemId: input.qitemId,
        destinationSession: input.destinationSession,
        claimedAt: ts,
        closureRequiredAt,
        summary: qitem.summary ?? null,
      });
    });

    const persistedEvent = txn();
    this.eventBus.notifySubscribers(persistedEvent);
    return this.getByIdOrThrow(input.qitemId);
  }

  unclaim(qitemId: string, destinationSession: string, reason: string, identityProvenance?: string | null): QueueItem {
    const qitem = this.getById(qitemId);
    if (!qitem) {
      throw new QueueRepositoryError("qitem_not_found", `找不到 qitem ${qitemId}`);
    }
    if (qitem.state !== "in-progress") {
      throw new QueueRepositoryError(
        "qitem_not_in_progress",
        `qitem ${qitemId} 处于 ${qitem.state} 状态；只有 in-progress 可 unclaim`
      );
    }
    const ts = new Date().toISOString();

    const txn = this.db.transaction(() => {
      // (e/Class-B)：返回 pending 会释放 claim，因此清除 claimant-generation stamp（item 现在未被
      // claim；新的 claimant 会重新盖上自己的 generation）。
      const clearGen = this.hasClaimedGenColumn ? ", claimed_by_generation_uuid = NULL" : "";
      this.db
        .prepare(
          `UPDATE queue_items
             SET state = 'pending',
                 ts_updated = ?,
                 claimed_at = NULL,
                 closure_required_at = NULL${clearGen}
           WHERE qitem_id = ?`
        )
        .run(ts, qitemId);

      this.transitionLog.append({
        qitemId,
        state: "pending",
        actorSession: destinationSession,
        transitionNote: `unclaimed: ${reason}`,
        identityProvenance: identityProvenance ?? null, // P21 §4 era-stamp。
      });

      return this.eventBus.persistWithinTransaction({
        type: "queue.unclaimed",
        qitemId,
        destinationSession,
        reason,
        summary: qitem.summary ?? null,
      });
    });

    const persistedEvent = txn();
    this.eventBus.notifySubscribers(persistedEvent);
    return this.getByIdOrThrow(qitemId);
  }

  /**
   * 通用状态修改器。`done` transition 经过 hot-potato 严格拒绝。所有 transition 都追加到日志。
   *
   * 阶段 B R2：将 queue.updated event 与 UPDATE + transition log append 原子发出，使
   * view-event-bridge 可在 /api/views/:name/sse 上为普通状态 transition（pending → blocked、
   * in-progress → done、closure、escalation）唤醒 SSE consumer。阶段 A 写入语义不变，只是在现有
   * transaction 中新增 event 发出。这是对阶段 A 写入 surface 的显式窄幅 event-only 扩展，使 update
   * 路径修改对 view bridge 可见。
   */
  update(input: QueueUpdateInput): QueueItem {
    const txn = this.db.transaction(() => this.updateInTransactionalContext(input));
    const result = txn();
    for (const event of result.persistedEvents) this.eventBus.notifySubscribers(event);
    return this.getByIdOrThrow(input.qitemId);
  }

  /**
   * PL-004 阶段 D 扩展点（orch 按 slice IMPL Driver Handoff Contract / Guard R1 修复批准）。
   * 与 update() 使用相同的 closure 校验 + UPDATE + transition log + queue.updated event，但在
   * 调用方外层 db.transaction 内运行，以便与 workflow-projector 的 transactional-scribe 契约组合。
   *
   * 调用方必须：
   *   1. 从 `db.transaction(() => {...})` block 内调用。
   *   2. 外层 transaction 提交后调用：
   *        eventBus.notifySubscribers(persistedEvent)
   *   3. 不得在 transaction 外调用（调用方提交前出错会产生半状态）。
   *
   * Closure 校验在调用时（UPDATE 前）运行，因此阶段 A 不变量违规（例如 state=done 但无
   * closure_reason）会在 workflow projector 外层 transaction 可提交任何部分状态前抛错。阶段 A
   * hot-potato 严格拒绝规则由此原样应用到 workflow projection。
   */
  updateWithinTransaction(input: QueueUpdateInput): {
    qitemId: string;
    persistedEvent: PersistedEvent;
    persistedEvents: PersistedEvent[];
  } {
    const result = this.updateInTransactionalContext(input);
    return { qitemId: input.qitemId, ...result };
  }

  /**
   * 内部：closure 校验 + UPDATE + transition log + 发出 queue.updated event。调用方负责包裹
   * transaction（公共 update() 会包裹；公共 updateWithinTransaction() 在调用方外层事务内组合）。
   */
  private updateInTransactionalContext(input: QueueUpdateInput): {
    persistedEvent: PersistedEvent;
    persistedEvents: PersistedEvent[];
  } {
    const qitem = this.getById(input.qitemId);
    if (!qitem) {
      throw new QueueRepositoryError(
        "qitem_not_found",
        `找不到 qitem ${input.qitemId}`
      );
    }
    const hasNote = typeof input.transitionNote === "string" && input.transitionNote.trim().length > 0;
    const isGuardedTerminal = (["done", "canceled", "handed-off"] as const).includes(
      qitem.state as "done" | "canceled" | "handed-off",
    );
    const isStatePreservingAppend = input.state === undefined || (isGuardedTerminal && input.state === qitem.state);

    if (isStatePreservingAppend) {
      if (input.state === undefined && !hasNote) {
        throw new QueueRepositoryError(
          "state_or_note_required",
          "queue update 要求 --state 或非空 --note；未写入任何内容",
        );
      }
      const disallowed = input.reopen === true
        || input.closureReason != null
        || input.closureTarget != null
        || input.handedOffTo != null
        || input.blockedOn != null
        || input.wakeWatchdogId != null
        || input.wakeAfterSeconds != null
        || input.wakeMaxSeconds != null
        || input.wakeProgressEvidence != null
        || input.wakeMessage != null
        || input.summary != null
        || input.evidenceRef != null;
      if (disallowed) {
        throw new QueueRepositoryError(
          "note_append_fields_not_admitted",
          "保持状态的 note append 只接受 --note（以及可选的相同 --state）；提供了状态写入字段，因此未写入任何内容",
        );
      }

      this.transitionLog.append({
        qitemId: input.qitemId,
        state: qitem.state,
        actorSession: input.actorSession,
        transitionNote: input.transitionNote,
        identityProvenance: input.identityProvenance ?? null,
      });
      const persistedEvent = this.eventBus.persistWithinTransaction({
        type: "queue.updated",
        qitemId: input.qitemId,
        fromState: qitem.state,
        toState: qitem.state,
        closureReason: null,
        closureTarget: null,
        actorSession: input.actorSession,
        summary: qitem.summary ?? null,
      });
      return { persistedEvent, persistedEvents: [persistedEvent] };
    }
    if (!isQueueState(input.state)) {
      throw new QueueRepositoryError(
        "invalid_state",
        `state=${input.state} 无效；有效值：${QUEUE_STATES.join(", ")}`
      );
    }
    if ((input.wakeWatchdogId != null || input.wakeAfterSeconds != null) && input.state !== "blocked") {
      throw new QueueRepositoryError(
        "wake_not_admitted",
        "park wake 只能随 state=blocked 持久化；请 park 该行或移除 wake 选项",
      );
    }
    if (input.wakeWatchdogId != null && input.wakeAfterSeconds != null) {
      throw new QueueRepositoryError(
        "wake_ambiguous",
        "请选择一种显式 park wake：现有 watchdog id 或原子 timer",
      );
    }
    if (input.wakeAfterSeconds != null && (!Number.isInteger(input.wakeAfterSeconds) || input.wakeAfterSeconds <= 0)) {
      throw new QueueRepositoryError(
        "wake_after_invalid",
        `wakeAfterSeconds 必须是正整数（收到 ${input.wakeAfterSeconds}）`,
      );
    }
    if (input.wakeMessage != null && input.wakeAfterSeconds == null) {
      throw new QueueRepositoryError(
        "wake_message_not_admitted",
        "wakeMessage 是内部 timer 内容，要求同时提供 wakeAfterSeconds",
      );
    }
    if (input.wakeMaxSeconds != null && (input.wakeAfterSeconds == null || !Number.isInteger(input.wakeMaxSeconds) || input.wakeMaxSeconds < input.wakeAfterSeconds)) {
      throw new QueueRepositoryError("wake_max_invalid", "wakeMaxSeconds 要求初始 delay，且必须是大于等于该值的整数");
    }
    if (input.wakeMessage != null && input.wakeMessage.trim().length === 0) {
      throw new QueueRepositoryError(
        "wake_message_invalid",
        "提供 wakeMessage 时不得为空",
      );
    }

    const isReopen = isGuardedTerminal && input.state !== qitem.state;
    if (isReopen && !input.reopen) {
      throw new QueueRepositoryError(
        "terminal_reopen_requires_ack",
        `qitem ${input.qitemId} 当前处于 '${qitem.state}'；state='${input.state}' 会重新打开 terminal 行。请有意使用 --reopen --note <reason> 重新运行。`,
        { currentState: qitem.state, requestedState: input.state },
      );
    }
    if (isReopen && !isBlockerLive(input.state)) {
      throw new QueueRepositoryError(
        "terminal_reopen_target_invalid",
        `qitem ${input.qitemId} 当前处于 '${qitem.state}'；--reopen 要求 active target 状态（pending、in-progress 或 blocked），而不是 '${input.state}'。`,
        { currentState: qitem.state, requestedState: input.state },
      );
    }
    if (isReopen && !hasNote) {
      throw new QueueRepositoryError(
        "reopen_note_required",
        `qitem ${input.qitemId} 当前处于 '${qitem.state}'；有意 reopen 要求 --note <reason>，使修复可审计。`,
        { currentState: qitem.state, requestedState: input.state },
      );
    }
    if (input.reopen && !isReopen) {
      throw new QueueRepositoryError(
        "reopen_not_applicable",
        `--reopen 仅适用于将 terminal 行移到 active 状态；qitem ${input.qitemId} 当前处于 '${qitem.state}'。`,
        { currentState: qitem.state, requestedState: input.state },
      );
    }

    const validation = validateClosure({
      state: input.state,
      closureReason: input.closureReason ?? null,
      closureTarget: input.closureTarget ?? null,
    });
    if (!validation.ok) {
      throw new QueueRepositoryError(validation.code, validation.message, {
        validReasons: "validReasons" in validation ? validation.validReasons : undefined,
      });
    }

    // OPR.0.4.6.WF3 FR-6——frontier close-path guard（PM 裁定：预防优先于检测）。从非 workflow
    // 动词对 live workflow-frontier packet 执行 terminal closure（done/handed-off）会使 instance
    // 搁浅：frontier 将引用已关闭 packet，且 workflow 自身 bookkeeping（trail、rebind、event）不会
    // 发生。以点明 what/why/fix 和 workflow 动词的方式显著拒绝。workflow domain 自身 writer 传入
    // viaWorkflowVerb（它们维持不变量）；非 workflow qitem 从 predicate 返回 null，closure 行为按字节
    // 不变（零摩擦负例）。
    const isTerminalClosure = isTerminalState(input.state);
    if (isTerminalClosure && !input.viaWorkflowVerb && this.workflowFrontierPredicate) {
      const binding = this.workflowFrontierPredicate(input.qitemId);
      if (binding) {
        throw new QueueRepositoryError(
          "workflow_frontier_packet",
          `qitem ${input.qitemId} 是 workflow instance ${binding.instanceId}（${binding.workflowName}）的 live frontier packet。带外关闭会使 workflow 搁浅。请改用 workflow 动词：zrig workflow project（推进）| zrig workflow route（重新指定 owner）。`,
          { instanceId: binding.instanceId, workflowName: binding.workflowName, qitemId: input.qitemId },
        );
      }
    }

    // OPR.0.4.4.19 FR-6——第 1 分支 park（state=blocked，blocker 为 human-seat）：在 park 时刻
    // 强制要求 summary + evidence_ref，并针对有效值评估（本次调用提供，否则使用 item 已有值），使
    // create 时已携带这些值的 item 无需重新输入即可 park。强制逻辑位于写入路径；`zrig queue block`
    // 动词和原始 `update --state blocked` 使用同一 validator（无仅动词强制）。阻塞于另一 qitem
    // 不增加要求（BR-1）。
    const effectiveBlockedOn = input.blockedOn ?? qitem.blockedOn;
    if (input.state === "blocked" && effectiveBlockedOn && this.getById(effectiveBlockedOn)?.humanIntent === "update") {
      throw new QueueRepositoryError("invalid_human_notification", "信息性 update 不是审批依赖。若需要人工决策，请创建独立的 decision request。");
    }
    if (qitem.humanIntent === "update" && input.state === "blocked" && isHumanSeatSessionRef(effectiveBlockedOn ?? "")) {
      throw new QueueRepositoryError("invalid_human_notification", "信息性投递不能转为人工审批 park；请编写独立的 decision request。");
    }
    const isHumanPark = input.state === "blocked" && isHumanSeatSession(effectiveBlockedOn);

    // OPR.0.5.1 slice-51-06 D2——summary/evidence_ref 只能在 human-seat park 时持久化（见下方
    // FR-6 note）。在其他 transition 上静默忽略会造成数据丢失陷阱（操作员误以为 metadata 已保存）。
    // 在任何 UPDATE/log/event 前强制拒绝，使调用方立即得知且不留下半应用。null/undefined = 缺席
    //（允许）；空字符串 = 存在（有意值，在非 park transition 上拒绝）。
    if (!isHumanPark) {
      const invalidFields: Array<"summary" | "evidenceRef"> = [];
      if (input.summary != null) invalidFields.push("summary");
      if (input.evidenceRef != null) invalidFields.push("evidenceRef");
      if (invalidFields.length > 0) {
        const flags = invalidFields.map((f) => (f === "summary" ? "--summary" : "--evidence-ref")).join(" / ");
        throw new QueueRepositoryError(
          "summary_evidence_not_persistable",
          `${invalidFields.join(" + ")} 只能在 human-seat park（state=blocked 且 blocker 为 human seat）时持久化；'${input.state}' transition 无法存储它们。请移除 ${flags}，或 park item（zrig queue block --on <human-seat> --summary … --evidence-ref …）。`,
          { invalidFields },
        );
      }
    }

    // SWEEP-a（结构 f2576102）——closure/blocked 字段一致性，与上方 reference 拒绝并列：不一致字段
    // 绝不能静默持久化（比丢失更糟，下方 COALESCE 会写入它）。从 live schema 用法派生准入映射：
    //   closure_reason/closure_target → state "done"，或 PARK-RECORD 形式
    //     （state "blocked" 且 closureReason "blocked_on"——workflow gate/park writer 的既有结构，
    //     workflow-runtime.ts:587/1013）；
    //   blocked_on → 仅 state "blocked"。
    const isParkRecord = input.state === "blocked" && input.closureReason === "blocked_on";
    // 第三种 live 形式（由邻近测试发现）：事务式 handoff 将 source 关闭为 state "handed-off"，
    // closureReason 为 "handed_off_to"。
    const isHandoffClose = input.state === "handed-off" && input.closureReason === "handed_off_to";
    // 0.5.1-53 Atom 2a——第四种允许形式：supersession-cancel。由 cancel-and-replace 修正的行记录
    // state=canceled + closureReason=superseded + closureTarget=<successor>，使 superseded 可与
    // abandoned 区分（普通 cancel 保持 closureReason=null）。
    const isSupersedeCancel = input.state === "canceled" && input.closureReason === "superseded";
    if (input.state !== "done" && !isParkRecord && !isHandoffClose && !isSupersedeCancel && (input.closureReason != null || input.closureTarget != null)) {
      throw new QueueRepositoryError(
        "closure_fields_not_admitted",
        `closure_reason/closure_target 只能持久化到 state=done、blocked park-record、handoff close 或 superseded cancel；'${input.state}' transition 无法存储它们。请关闭 item（--state done --closure-reason …）或移除这些 flag。`,
        {},
      );
    }
    // supersession 必须点名替换该行的对象——任何写入前显著失败（绝不静默 no-op 并留下 stale 行，
    // 即 dead-signal 类别），与 handed_off_to 的 target 规则对称。
    if (isSupersedeCancel && !input.closureTarget) {
      throw new QueueRepositoryError(
        "missing_closure_target",
        `closure_reason=superseded 要求 closure_target（替换该行的 successor qitem）。`,
        {},
      );
    }
    if (input.blockedOn != null && input.state !== "blocked") {
      throw new QueueRepositoryError(
        "blocked_on_not_admitted",
        `blocked_on 只能持久化到 state=blocked；'${input.state}' transition 无法存储它。请 park item（zrig queue block --on …）或移除 --blocked-on。`,
        {},
      );
    }

    // 0.5.1-53 Atom 1b(ii) + 1a——park 时校验 blocker。非 human blocker 类别：
    //   qitem-ref（"qitem-…"）      → 必须存在且 live（1b-ii）；ghost 或 dead blocker 永不解除。
    //   typed gate（fold:/auth:/…） → 一等对象（1a），但只有前缀、无 gate body 时为畸形
    //                                  （拼写错误不得伪装成 gate）。
    //   其他（旧版 gate-name）      → 保持原样；超出本 slice 范围。
    // Human-seat park（isHumanPark）执行上方自身 FR-6 契约。
    if (input.state === "blocked" && !isHumanPark && typeof effectiveBlockedOn === "string") {
      if (effectiveBlockedOn.startsWith("qitem-")) {
        const blocker = this.getById(effectiveBlockedOn);
        if (!blocker) {
          throw new QueueRepositoryError(
            "blocker_not_found",
            `blocked_on 指向不存在的 qitem：${effectiveBlockedOn}。park 必须指向真实、live 的 blocker；不存在的 blocker 永远无法完成，因此该行永远无法 unpark。`,
            // F1（错误诚实性）：被拒绝值命名为 rejectedBlocker；错误 payload 绝不携带成功结构的
            // blockedOn 字段（字段过滤误读类别）。
            { rejectedBlocker: effectiveBlockedOn },
          );
        }
        if (!isBlockerLive(blocker.state)) {
          throw new QueueRepositoryError(
            "blocker_not_live",
            `blocked_on 指向已 resolved qitem：${effectiveBlockedOn} 为 '${blocker.state}'。park 必须指向 live blocker；park 在已完成/关闭行上会形成永不自清除的 dead-blocker park。`,
            { rejectedBlocker: effectiveBlockedOn, blockerState: blocker.state },
          );
        }
      } else {
        const typedPrefix = typedGateBlockerPrefix(effectiveBlockedOn);
        if (typedPrefix && !isTypedGateBlocker(effectiveBlockedOn)) {
          throw new QueueRepositoryError(
            "blocker_malformed",
            `blocked_on '${effectiveBlockedOn}' 是不含 gate body 的裸 '${typedPrefix}' 前缀。类型化 gate blocker 必须点名 gate（例如 fold:one-home+attestation）。`,
            { rejectedBlocker: effectiveBlockedOn },
          );
        }
      }
    }

    let effectiveSummary = qitem.summary;
    let effectiveEvidenceRef = qitem.evidenceRef;
    if (isHumanPark) {
      effectiveSummary = input.summary ?? qitem.summary;
      effectiveEvidenceRef = input.evidenceRef ?? qitem.evidenceRef;
      const park = validateHumanPark({
        blockedOn: effectiveBlockedOn,
        summary: effectiveSummary,
        evidenceRef: effectiveEvidenceRef,
      });
      if (!park.ok) {
        throw new QueueRepositoryError(park.code, park.message, {
          missingFields: park.missingFields,
        });
      }
    }

    let parkWake: { kind: "watchdog" | "timer" | "blocker"; ref: string } | null = null;
    const jobsRepo = this.watchdogJobsRepo ?? new WatchdogJobsRepository(this.db);
    if (input.wakeWatchdogId != null) {
      const job = jobsRepo.getById(input.wakeWatchdogId);
      if (!job || job.state !== "active") {
        throw new QueueRepositoryError(
          "wake_watchdog_not_live",
          `watchdog ${input.wakeWatchdogId} 不是 active job；请附加 live watchdog 或 arm 原子 timer`,
          { wakeWatchdogId: input.wakeWatchdogId },
        );
      }
      if (job.targetSession !== qitem.destinationSession) {
        throw new QueueRepositoryError(
          "wake_watchdog_target_mismatch",
          `watchdog ${job.jobId} 指向 ${job.targetSession}，而不是 parked owner ${qitem.destinationSession}`,
          { wakeWatchdogId: job.jobId, targetSession: job.targetSession, destinationSession: qitem.destinationSession },
        );
      }
      parkWake = { kind: "watchdog", ref: job.jobId };
    } else if (input.wakeAfterSeconds != null && input.wakeMaxSeconds != null) {
      if (effectiveBlockedOn === input.qitemId) {
        throw new QueueRepositoryError("wake_self_blocker", "重复 wait 必须指向上游 blocker，而不是自身 packet");
      }
      const oldWake = this.wakeRepo.getStatus(input.qitemId);
      const job = armQueueWait(this.db, jobsRepo, {
        previousJobId: oldWake?.kind === "timer" ? oldWake.ref : undefined,
        qitemId: input.qitemId, blocker: effectiveBlockedOn,
        evidence: input.wakeProgressEvidence,
        initialSeconds: input.wakeAfterSeconds, maxSeconds: input.wakeMaxSeconds,
        message: input.wakeMessage ?? `请恢复 parked qitem ${input.qitemId} 并检查当前 evidence。`,
        owner: qitem.destinationSession, actor: input.actorSession,
      });
      parkWake = { kind: "timer", ref: job.jobId };
    } else if (input.wakeAfterSeconds != null) {
      const job = jobsRepo.register({
        policy: "periodic-reminder",
        specYaml: [
          "policy: periodic-reminder",
          "target:",
          `  session: ${JSON.stringify(qitem.destinationSession)}`,
          `message: ${JSON.stringify(input.wakeMessage ?? `Parked qitem ${qitem.qitemId} 的 wake timer 已触发。请恢复已记录的 continuation 并更新该行。`)}`,
          "",
        ].join("\n"),
        targetSession: qitem.destinationSession,
        intervalSeconds: input.wakeAfterSeconds,
        registeredBySession: input.actorSession,
      });
      // OPR.0.5.8.1 S1——每个显式 `--wake-after` timer 都在注册时开始计时，而不只是
      // 提供方限制计时器。
      //
      // `isDue` 会把没有 `last_evaluation_at` 的 job 视为立即到期，因此未初始化 timer 无论 interval
      // 多长，都会在 scheduler 首轮触发：请求 20m 时实测 0.69s，请求 2h 时实测 0.77s。duration
      // 从未丢失——`interval_seconds` 正确保存了 1200 和 7200——只是没有以它为比较基准。
      //
      // S16 只为 provider-limit park 引入此初始化，并明确记录窄范围是有意设计。将其扩宽就是完整修复：
      // 机制不变，且已由 provider-limit 路径证明，因此不新增 scheduler 或逐 wake bookkeeping。
      jobsRepo.recordEvaluation(job.jobId, job.registeredAt, false);
      parkWake = { kind: "timer", ref: job.jobId };
    } else if (input.state === "blocked" && effectiveBlockedOn?.startsWith("qitem-")) {
      parkWake = { kind: "blocker", ref: effectiveBlockedOn };
    }

    const ts = new Date().toISOString();
    const fromState = qitem.state;

    // 0.5.1-53 Atom 1b(i)——退出时清除。显式设置 blocked_on，而非 COALESCE：行只在
    // `state=blocked` 时保留 blocker（effectiveBlockedOn = 新 blocker，否则为已有 blocker），任何离开
    // blocked 的 transition 都将其清为 null。旧 `COALESCE(?, blocked_on)` 会在每个非 blocked
    // transition 中保留 blocker，留下无人审计的 dead blocker（根因 strand）。
    const nextBlockedOn = input.state === "blocked" ? effectiveBlockedOn : null;
    const notification = this.classifyOwnerNotification({
      action: "update",
      destinationSession: qitem.destinationSession,
      previousState: qitem.state,
      previousBlockedOn: qitem.blockedOn,
      nextState: input.state,
      nextBlockedOn,
      explicitKind: input.ownerNotificationKind,
    });

    this.db
      .prepare(
        `UPDATE queue_items
           SET state = ?,
               ts_updated = ?,
               closure_reason = COALESCE(?, closure_reason),
               closure_target = COALESCE(?, closure_target),
               handed_off_to = COALESCE(?, handed_off_to),
               blocked_on = ?
         WHERE qitem_id = ?`
      )
      .run(
        input.state,
        ts,
        validation.closureReason,
        validation.closureTarget,
        input.handedOffTo ?? null,
        nextBlockedOn,
        input.qitemId
      );

    // FR-6：park 时的 summary/evidence_ref 会持久化到现有 item（不只是校验后丢弃），对 attention
    // query 和 Packet 2 可见。只有 park 路径写入。
    if (isHumanPark) {
      this.persistSummary(input.qitemId, input.summary ?? null);
      this.persistEvidenceRef(input.qitemId, input.evidenceRef ?? null);
    }

    const transition = this.transitionLog.append({
      qitemId: input.qitemId,
      state: input.state,
      actorSession: input.actorSession,
      transitionNote: isReopen ? `已确认 reopen：${input.transitionNote}` : input.transitionNote,
      closureReason: validation.closureReason ?? undefined,
      closureTarget: validation.closureTarget ?? undefined,
      identityProvenance: input.identityProvenance ?? null, // P21 §4 era-stamp。
      ownerNotificationKind: notification?.kind,
      ownerNotificationLevel: notification?.level,
    });
    if (parkWake) {
      // OPR.0.5.8.1 S1b 补充——新 PARK EPISODE 取代旧 episode。重新 park（blocked -> blocked，
      // 带新 --wake-after）曾在首个 job 仍 active 时 arm 第二个 job，使一行上留下两个 live timer：
      // 除永不停止 fire 与超出行寿命 timer 外的第三条重复 fire 路径。
      //
      // 在记录新 armed 行之前读取：getStatus 返回最近的 armed wake；若在下方记录后读取，会返回当前
      // 正在 arm 的项，而不是被取代项。
      //
      // 有意不以先前状态门控。live+timer 测试才是真正安全条件；不加门控还能清理任何未干净 unpark
      // 路径留下的 stale park-generated timer。它不会越界：已 terminal job 无法通过 `live`，操作员
      // 附加的 watchdog 无法通过 kind 测试。
      if (this.wakeRepo.getStatus(input.qitemId)?.ref !== parkWake.ref) {
        this.retireParkGeneratedTimer(input.qitemId, "park_superseded");
      }
      this.wakeRepo.record({
        transitionId: transition.transitionId,
        qitemId: input.qitemId,
        phase: "armed",
        kind: parkWake.kind,
        ref: parkWake.ref,
        deliveryStatus: null,
      });
    } else if (fromState === "blocked" && input.state !== "blocked") {
      // OPR.0.5.8.1 S1b——park-generated timer 绑定到 PARK EPISODE。离开 `blocked` 即结束它，
      // 避免 wake 通知 seat 恢复已不再 parked 的行。样本：job 01M1E6F3QG41N76Y1CDX48P766
      // 于 10:18:07Z 为一条 10:02:03Z 已 handed-off 的行触发；该行 terminal 已 16 分钟，wake
      // 仍写着“恢复已记录的 continuation”。
      //
      // 在 TRANSITION 时停止，而不是 fire 时检查行状态，因为 fire 路径在查询 queue 前就已投递：
      // `recordWatchdogWakeAttempt` 在投递后运行，行消失时只会提前返回，因此在那检查只能审计一条
      // 已发送的 wake。
      //
      // 只停止 kind === "timer"。这些 job 由此 park 生成并拥有。操作员通过 --wake-watchdog 附加的
      // watchdog（kind "watchdog"）归操作员所有，可能指向其他行，必须保留。
      this.retireParkGeneratedTimer(input.qitemId, `park_ended:${input.state}`);
    }

    // 0.5.1-53 Atom 1b(iii)——propagate-completion。blocked_on 承诺“A 等待 B 完成”；该承诺在此
    // runtime 从未触发（行会阻塞于已 done/canceled 的 blocker 数天）。当当前 qitem 到达 terminal
    // 状态时，将所有 park 在其上的行（blocked_on = this、state='blocked'）自动 unpark 为 pending，
    // 清除现已 resolved 的 blocker，记录 transition 并发出 event，使 watcher/sweep 无需 fetch 即可
    // 看到 unblock。
    const dependentEvents: PersistedEvent[] = !isBlockerLive(input.state)
      ? this.propagateBlockerCompletion({
          qitemId: input.qitemId,
          terminalState: input.state,
          actorSession: input.actorSession,
          identityProvenance: input.identityProvenance ?? null,
          ts,
        })
      : [];

    const persistedEvent = this.eventBus.persistWithinTransaction({
      type: "queue.updated",
      qitemId: input.qitemId,
      fromState,
      toState: input.state,
      closureReason: validation.closureReason ?? null,
      closureTarget: validation.closureTarget ?? null,
      actorSession: input.actorSession,
      // FR-1 × FR-6：event 携带本次修改时的 summary（包含 park 时 summary），使 surface 无需 fetch
      // 即可刷新。
      summary: effectiveSummary ?? null,
    });
    return { persistedEvent, persistedEvents: [...dependentEvents, persistedEvent] };
  }

  /** OPR.0.5.6.26——唯一 PROPAGATION 位置。blocked_on 承诺“A 等待 B 完成”；blocker 的每次
   * terminal closure 都通过此 helper 驱动附属行自动 unpark——update 路径与 handoff 家族都在各自
   * 事务内调用。它消除的是按代码路径分裂的类别：handoff 动词通过直接 SQL 写 terminal 状态，导致
   * 承诺从未为它们触发。此逻辑绝不出现第二份副本。 */
  /**
   * OPR.0.5.8.1 S1b——终止 park 为此行生成的 timer。
   *
   * 这是作出该决定的唯一位置。`queue_items.state` 由六个方法写入，而非一个；首版修复只挂接通用
   * `updateInTransactionalContext`。其他 writer 都静默保留 timer，包括正好产生动机样本的
   * `handoff()`（review50-r2 找到该路径；枚举其余路径又找到 `claim()` 与
   * `propagateBlockerCompletion()`，而 `claim()` 正是 story 契约明确点名的“claim-resume”）。
   *
   * 调用方必须在自己的状态 transition transaction 内调用，使人永远无法观察到已离开 park、但仍有
   * live park timer 的行。
   *
   * 只终止 park 生成的 timer。操作员通过 `--wake-watchdog` 附加的 watchdog 归其所有，可能指向其他
   * 行，始终保留。非 live job 保持不变，因此重复调用无害。
   */
  private retireParkGeneratedTimer(qitemId: string, reason: string): void {
    const armed = this.wakeRepo.getStatus(qitemId);
    if (armed?.kind !== "timer" || !armed.live) return;
    (this.watchdogJobsRepo ?? new WatchdogJobsRepository(this.db)).markTerminal(armed.ref, reason);
  }

  private propagateBlockerCompletion(input: {
    qitemId: string;
    terminalState: string;
    actorSession: string;
    identityProvenance: string | null;
    ts: string;
  }): PersistedEvent[] {
    const dependentEvents: PersistedEvent[] = [];
    const blockedRows = this.db
      .prepare("SELECT qitem_id, destination_session FROM queue_items WHERE blocked_on = ? AND state = 'blocked'")
      .all(input.qitemId) as Array<{ qitem_id: string; destination_session: string }>;
    for (const r of blockedRows) {
      const closed = this.getById(input.qitemId);
      const successors = input.terminalState === "handed-off" ? this.db.prepare(
        "SELECT qitem_id FROM queue_items WHERE handed_off_from = ? AND destination_session = ?",
      ).all(input.qitemId, closed?.handedOffTo ?? "") as Array<{ qitem_id: string }> : [];
      const successor = successors.length === 1 ? this.getById(successors[0]!.qitem_id) : null;
      if (successor && isBlockerLive(successor.state) && successor.destinationSession !== r.destination_session) {
        // 后续 custody 是已变化的 blocker。下方返回给等待 owner 才是实际恢复其 continuation 的
        // 结果到达。
        const oldWake = this.wakeRepo.getStatus(r.qitem_id);
        this.db.prepare("UPDATE queue_items SET blocked_on = ?, ts_updated = ? WHERE qitem_id = ?")
          .run(successor.qitemId, input.ts, r.qitem_id);
        const rebound = this.transitionLog.append({ qitemId: r.qitem_id, state: "blocked", actorSession: input.actorSession,
          transitionNote: `blocker custody 从 ${input.qitemId} 移到 ${successor.qitemId}`,
          identityProvenance: input.identityProvenance });
        const jobs = this.watchdogJobsRepo ?? new WatchdogJobsRepository(this.db);
        const retainedTimer = oldWake?.kind === "timer" && retargetQueueWait(this.db, jobs, oldWake.ref, successor.qitemId);
        if (!retainedTimer) this.retireParkGeneratedTimer(r.qitem_id, "blocker_custody_moved");
        this.wakeRepo.record({ transitionId: rebound.transitionId, qitemId: r.qitem_id, phase: "armed",
          kind: retainedTimer ? "timer" : "blocker", ref: retainedTimer ? oldWake!.ref : successor.qitemId, deliveryStatus: null });
        const event = this.eventBus.persistWithinTransaction({ type: "queue.updated", qitemId: r.qitem_id,
          fromState: "blocked", toState: "blocked", closureReason: null, closureTarget: null,
          actorSession: input.actorSession, summary: this.getById(r.qitem_id)?.summary ?? null });
        this.eventBus.registerPersistedWithinActiveEnvelope(event);
        dependentEvents.push(event);
        continue;
      }
      this.db
        .prepare("UPDATE queue_items SET state = 'pending', blocked_on = NULL, ts_updated = ? WHERE qitem_id = ?")
        .run(input.ts, r.qitem_id);
      const resumeTransition = this.transitionLog.append({
        qitemId: r.qitem_id,
        state: "pending",
        actorSession: input.actorSession,
        transitionNote: `auto-unparked：blocker ${input.qitemId} 到达 terminal 状态 '${input.terminalState}'`,
      });

      // OPR.0.5.8.1 S1b——自动 UNPARK。以 `--on X --wake-after 20m` park 的行同时携带 blocker
      // 和 timer；X 完成时会直接 unpark 该行，因此若无此逻辑，blocker 已完成职责后，timer 仍会对已不再
      // parked 的行触发。
      this.retireParkGeneratedTimer(r.qitem_id, "park_ended:auto-unparked");
      const wakeIntentId = this.stageAutoUnparkWakeIntent({
        qitemId: r.qitem_id,
        destinationSession: r.destination_session,
        fromSession: input.actorSession,
        identityProvenance: input.identityProvenance,
        blockerQitemId: input.qitemId,
        resumeTransitionId: resumeTransition.transitionId,
      });
      if (wakeIntentId) this.deliverWakeIntentAfterCommit(wakeIntentId);
      const dependentEvent = this.eventBus.persistWithinTransaction({
        type: "queue.updated",
        qitemId: r.qitem_id,
        fromState: "blocked",
        toState: "pending",
        closureReason: null,
        closureTarget: null,
        actorSession: input.actorSession,
        summary: this.getById(r.qitem_id)?.summary ?? null,
      });
      this.eventBus.registerPersistedWithinActiveEnvelope(dependentEvent);
      dependentEvents.push(dependentEvent);
    }
    return dependentEvents;
  }

  getParkWakeStatus(qitemId: string): ParkWakeStatus | null {
    return this.wakeRepo.getStatus(qitemId);
  }

  /** 仅当绑定到旧版 park-generated timer 的每一行都已 terminal 时才拒绝它。当前退出会在事务内
   * 终止这些 timer；这里是旧后台服务所持久化残留的 delivery-seam backstop。仍绑定任何 actionable
   * 行的 timer，以及操作员附加的每个 watchdog，都保持可投递。 */
  resolveWatchdogPreDeliveryTerminalReason(jobId: string): string | null {
    const targets = this.wakeRepo.findQitemsByGeneratedTimer(jobId);
    if (targets.length === 0 || targets.some(({ state }) => !isTerminalState(state))) return null;
    // 依据 ownership，而不只是 staleness。只有 job 单纯是 park-generated timer 时，此 backstop
    // 才可终止它。`--wake-watchdog` 可将操作员行附加到另一行的 `--wake-after` 所生成的同一 job，
    // 这是受支持路径；因此共享 job 会有第二个 watchdog-kind binding，本 reason 无权处理。timer 行
    // 已 terminal 并不能说明 attachment 状态；若仍 claim 该 job，会在 transport 前将其 terminal，
    // attachment 将永远无法 wake。
    if (this.wakeRepo.findQitemsByAttachedWatchdog(jobId).length > 0) return null;
    return "park_timer_target_terminal";
  }

  listTransitions(qitemId: string): Array<ReturnType<QueueTransitionLog["listForQitem"]>[number] & { wake?: ReturnType<QueueWakeRepository["getForTransition"]> }> {
    return this.transitionLog.listForQitem(qitemId).map((transition) => {
      const wake = this.wakeRepo.getForTransition(transition.transitionId);
      return wake ? { ...transition, wake } : transition;
    });
  }

  /** 只读且识别 scope 的 RECENT 投影。规范化及硬上限位于仅追加 transition log；repository 拥有
   * 公共 queue-domain 入口。 */
  listRecentTransitions(scope: RecentQueueTransitionScope | string, limit = 20): ReturnType<QueueTransitionLog["listRecent"]> {
    return this.transitionLog.listRecent(typeof scope === "string" ? { kind: "rig", rig: scope } : scope, limit);
  }

  /** 投递尝试被持久审计后由 watchdog engine 调用。queue transition 独立记录该尝试，不论 HELD 行的
   * owner 是否消费。 */
  recordWatchdogWakeAttempt(jobId: string, deliveryStatus: string): void {
    const targets = this.wakeRepo.findBlockedQitemsByWatchdog(jobId);
    if (targets.length === 0) return;
    const recordFired = ({ qitemId, kind }: (typeof targets)[number]): PersistedEvent => {
      const transition = this.transitionLog.append({
        qitemId,
        state: "blocked",
        actorSession: "watchdog@system",
        transitionNote: deliveryStatus === "retained"
          ? `park wake 已保留：watchdog ${jobId}；未投递；blocked work 不变`
          : `park wake 已触发：watchdog ${jobId}；delivery=${deliveryStatus}；等待 owner 消费`,
      });
      this.wakeRepo.record({
        transitionId: transition.transitionId,
        qitemId,
        phase: "fired",
        kind,
        ref: jobId,
        deliveryStatus,
      });
      return this.eventBus.persistWithinTransaction({
        type: "queue.updated",
        qitemId,
        fromState: "blocked",
        toState: "blocked",
        closureReason: null,
        closureTarget: null,
        actorSession: "watchdog@system",
        summary: this.getById(qitemId)?.summary ?? null,
      });
    };
    const usageLimitBlockers = targets.filter(({ qitemId }) =>
      this.getById(qitemId)?.tags?.includes(USAGE_LIMIT_BLOCKER_TAG),
    );
    // OPR.0.5.8.1 S1b——park-generated timer 是一次性的。`periodic-reminder` 会永远按
    // intervalSeconds 重复，因此未停止的 park timer 会在 +2、+3 个 interval 时继续无限唤醒 owner。
    //
    // 下方 provider-limit 路径已在触发后结束 job；本修复不改变该行为，并将其锁定为不变。这里将相同
    // 操作扩宽到普通 park timer，但不解析其 blocker；解析 blocker 是 provider-limit outcome，
    // 而非 timer outcome。
    const parkGeneratedTimer = targets.some(({ kind }) => kind === "timer");
    const events = this.db.transaction(() => {
      const firedEvents = targets.map(recordFired);
      if (deliveryStatus === "retained") return firedEvents;
      if (usageLimitBlockers.length === 0) {
        if (parkGeneratedTimer && !backOffQueueWait(this.watchdogJobsRepo ?? new WatchdogJobsRepository(this.db), jobId, deliveryStatus)) {
          (this.watchdogJobsRepo ?? new WatchdogJobsRepository(this.db)).markTerminal(
            jobId,
            "park_timer_fired_once",
          );
        }
        return firedEvents;
      }

      (this.watchdogJobsRepo ?? new WatchdogJobsRepository(this.db)).markTerminal(
        jobId,
        "usage_limit_expiry_fired",
      );
      const resolutionEvents = usageLimitBlockers.flatMap(({ qitemId }) =>
        this.updateInTransactionalContext({
          qitemId,
          actorSession: "watchdog@system",
          state: "done",
          closureReason: "no-follow-on",
          transitionNote: `provider-limit timer ${jobId} 已到期；一次性解析共享 blocker`,
        }).persistedEvents,
      );
      return [...firedEvents, ...resolutionEvents];
    })();
    for (const event of events) this.eventBus.notifySubscribers(event);
  }

  getById(qitemId: string): QueueItem | null {
    const row = this.db
      .prepare("SELECT * FROM queue_items WHERE qitem_id = ?")
      .get(qitemId) as QueueItemRow | undefined;
    if (!row) return null;
    const item = this.rowToItem(row);
    // OPR.0.5.6.14——对 gateway-routed 行，行 FACE 在一次读取中回答“是否已到达”；pane-bound
    // 返回 null（由缺席决定，不用 key 撒谎）。
    const ledger = this.deliveryOutcomeFor(item.qitemId);
    return {
      ...item,
      deliveryOutcome: ledger?.outcome ?? null,
      ...(ledger && ledger.outcome !== "posted" ? { deliveryFailureDetail: ledger.detail } : {}),
    };
  }

  list(opts?: QueueListOptions): QueueItem[] {
    const limit = opts?.limit ?? 100;
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (opts?.tag) {
      conditions.push("EXISTS (SELECT 1 FROM json_each(queue_items.tags) WHERE value = ?)");
      params.push(opts.tag);
    }

    if (opts?.rig) {
      const escaped = opts.rig.replace(/%/g, "\\%").replace(/_/g, "\\_");
      conditions.push("(destination_session LIKE ? ESCAPE '\\' OR source_session LIKE ? ESCAPE '\\')");
      params.push(`%@${escaped}`, `%@${escaped}`);
    }
    if (opts?.asSession) {
      conditions.push("(destination_session = ? OR source_session = ?)");
      params.push(opts.asSession, opts.asSession);
    }
    if (opts?.activeOnly && !opts?.state) {
      conditions.push("state IN ('pending', 'in-progress', 'blocked')");
    }
    if (opts?.destinationSession) {
      conditions.push("destination_session = ?");
      params.push(opts.destinationSession);
    }
    if (opts?.sourceSession) {
      conditions.push("source_session = ?");
      params.push(opts.sourceSession);
    }
    if (opts?.state) {
      const states = Array.isArray(opts.state) ? opts.state : [opts.state];
      const placeholders = states.map(() => "?").join(", ");
      conditions.push(`state IN (${placeholders})`);
      params.push(...states);
    }
    if (opts?.targetRepo && this.hasTargetRepoColumn) {
      conditions.push("target_repo = ?");
      params.push(opts.targetRepo);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const columns = opts?.compact ? COMPACT_QUEUE_COLUMNS + (this.hasHumanIntentColumn ? ", human_intent" : "") : "*";
    const useActiveFirst = !!(opts?.rig || opts?.asSession || opts?.activeOnly);
    const orderBy = useActiveFirst
      ? "CASE WHEN state IN ('pending', 'in-progress', 'blocked') THEN 0 ELSE 1 END, ts_created DESC"
      : "ts_created DESC";
    params.push(limit);

    const rows = this.db
      .prepare(
        `SELECT ${columns} FROM queue_items ${where} ORDER BY ${orderBy} LIMIT ?`
      )
      .all(...params) as QueueItemRow[];
    const items = rows.map((r) => {
      const item = this.rowToItem(r, !opts?.compact);
      const ledger = this.deliveryOutcomeFor(item.qitemId);
      return {
        ...item,
        deliveryOutcome: ledger?.outcome ?? null,
        ...(ledger && ledger.outcome !== "posted" ? { deliveryFailureDetail: ledger.detail } : {}),
      };
    });
    return opts?.compact
      ? items.map((item) => ({
          ...item,
          fieldsElided: ["body", "summary", "evidenceRef", "humanDetail", "waiting"],
        }))
      : items;
  }

  /**
   * OPR.0.3.2.20——持久 attention-class 查询。
   *
   * 返回 open attention-class qitem（“为你推荐”的待操作 + 审批 lens 的事实来源），方法是将
   * attention predicate 下推到 SQL WHERE 子句，使 LIMIT 在 attention 过滤后应用。这按构造令结果
   * 与窗口无关：即使 routine open qitem 数量远大于 LIMIT，旧 human-gate item 也不会被挤到 LIMIT
   * 之外。（Guard verdict qitem-20260518190827 BLOCKER 1——route 中先 fetch 后 filter 的旧方式仍可能
   * 把 attention item 隐藏在 ATTENTION_FETCH_BOUND 个更新的 routine open qitem 后。）
   *
   * SQL 中的 attention predicate（mission-control 读取层 + route 级 `isAttentionItem` 的镜像）：
   *   tier = 'human-gate'                              （审批）
   *   OR destination_session matches human-seat regex  （待操作）
   *
   * SQLite 没有原生 regex；使用 LIKE pattern 作为超集（每个 regex 匹配也会匹配某个 LIKE pattern）。
   * 若调用方需要严格 regex 语义，可在 JS 中用 isAttentionItem 细化；但对 LIMIT 下推保证而言，
   * SQL 超集才是关键：SQL 阶段不会过滤掉任何 attention item。
   *
   * 默认 open 状态集合：pending|in-progress|blocked。调用方可通过 `state` 覆盖。
   */
  /** 已投递信息记录在 closure 后仍可查询。receipt 过滤发生在 LIMIT 前；没有 prose/tier classifier，
   * 也没有第二个 event store。 */
  listDeliveredHumanUpdates(opts: { limit?: number } = {}): Array<QueueItem & { deliveredAt: string; deliveryReceipt: string }> {
    if (!this.hasHumanIntentColumn) return [];
    const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(101, Math.floor(opts.limit!))) : 20;
    const receipts = `SELECT qitem_id, ts, transition_note FROM queue_transitions` +
      (detectTable(this.db, "queue_transitions_archive") ? ` UNION ALL SELECT qitem_id, ts, transition_note FROM queue_transitions_archive` : "");
    const rows = this.db.prepare(`
      SELECT q.*, r.ts AS delivered_at, r.transition_note AS delivery_receipt
      FROM queue_items q JOIN (${receipts}) r ON r.qitem_id = q.qitem_id
      WHERE q.human_intent = 'update' AND is_human_seat_session(q.destination_session) = 1
        AND r.transition_note LIKE 'slack-owner-notification-posted %'
      ORDER BY r.ts DESC, q.qitem_id DESC LIMIT ?
    `).all(limit) as Array<QueueItemRow & { delivered_at: string; delivery_receipt: string }>;
    return rows.map((row) => ({ ...this.rowToItem(row), deliveredAt: row.delivered_at, deliveryReceipt: row.delivery_receipt }));
  }

  listAttention(opts?: {
    limit?: number;
    state?: QueueState | QueueState[];
    destinationSession?: string;
    sourceSession?: string;
    targetRepo?: string;
  }): QueueItem[] {
    const limit = opts?.limit ?? 100;
    const states = opts?.state
      ? Array.isArray(opts.state) ? opts.state : [opts.state]
      : ["pending" as QueueState, "in-progress" as QueueState, "blocked" as QueueState];

    // 组合 WHERE 子句：state 集合 + attention predicate + 可选 scope filter（与 list() 组合方式一致，
    // 使 `attention=1` query 参数仍可与 destinationSession/sourceSession/targetRepo 组合——guard
    // 重新验证 qitem-20260518192210 BLOCKER 1）。
    const statePlaceholders = states.map(() => "?").join(", ");
    // attention predicate 在 SQL 中精确匹配（guard re-verify-3 qitem-20260518193005 BLOCKER 1）：
    // is_human_seat_session 计算 QueueRepository constructor 注册的严格 regex。可能从 LIKE 超集漏过的
    // 畸形行（例如 'human-@kernel'，名称 segment 为空）会在 SQL 阶段、LIMIT 前被拒绝，因此无法占满
    // LIMIT 窗口并隐藏有效 attention item。
    // OPR.0.4.4.19 FR-6——attention predicate 增加第 1 分支 park 子句：state=blocked 且 blocker 为
    // human-seat 的 qitem 是 human 应作出的决定。阻塞于另一 qitem（当前已发布用法）不匹配，因为
    // is_human_seat_session 拒绝 qitem id。
    const conditions: string[] = [
      `state IN (${statePlaceholders})`,
      `(
        is_human_seat_session(destination_session) = 1
        OR (state = 'blocked' AND is_human_seat_session(blocked_on) = 1)
      )`,
    ];
    if (this.hasHumanIntentColumn) conditions.push("COALESCE(human_intent, 'decision') <> 'update'");
    const params: unknown[] = [...states];
    if (opts?.destinationSession) {
      conditions.push("destination_session = ?");
      params.push(opts.destinationSession);
    }
    if (opts?.sourceSession) {
      conditions.push("source_session = ?");
      params.push(opts.sourceSession);
    }
    if (opts?.targetRepo && this.hasTargetRepoColumn) {
      conditions.push("target_repo = ?");
      params.push(opts.targetRepo);
    }
    params.push(limit);

    const sql = `
      SELECT * FROM queue_items
      WHERE ${conditions.join(" AND ")}
      ORDER BY ts_created DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...params) as QueueItemRow[];
    return rows.map((r) => this.rowToItem(r));
  }

  /**
   * 查找 `closure_required_at` 已过期的 qitem。供 watchdog 使用；自身不发 event，由调用方决定 nudge
   * 或 escalate。
   *
   * Slice 15（发现 2）：可选 rig scope、limit 和 compact，与 `list` 对应，使 `zrig queue overdue`
   * 默认有界且不含 body，而不是把每个 rig 的完整 qitem body 倾倒给单一调用方。无参数时保留
   * watchdog 的旧行为（所有 overdue、完整行）。
   */
  findOverdue(opts?: { now?: string; rig?: string; limit?: number; compact?: boolean }): QueueItem[] {
    const cutoff = opts?.now ?? new Date().toISOString();
    const conditions = ["state = 'in-progress'", "closure_required_at IS NOT NULL", "closure_required_at <= ?"];
    const params: unknown[] = [cutoff];
    if (opts?.rig) {
      const escaped = opts.rig.replace(/%/g, "\\%").replace(/_/g, "\\_");
      conditions.push("(destination_session LIKE ? ESCAPE '\\' OR source_session LIKE ? ESCAPE '\\')");
      params.push(`%@${escaped}`, `%@${escaped}`);
    }
    const columns = opts?.compact ? COMPACT_QUEUE_COLUMNS + (this.hasHumanIntentColumn ? ", human_intent" : "") : "*";
    let sql = `SELECT ${columns} FROM queue_items WHERE ${conditions.join(" AND ")} ORDER BY closure_required_at ASC`;
    if (opts?.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as QueueItemRow[];
    return rows.map((r) => this.rowToItem(r, !opts?.compact));
  }

  /**
   * 展示两类有 evidence 支撑的 undelivered：原始 pending create-path nudge 失败，以及 gateway
   * ledger 标为 transport-failed 或超过 post 窗口仍无 receipt 的 active human-notification episode。
   * 通用 null nudge 仍排除；只有结构化 OWNER episode 才让该缺席有意义。只读，不 retry 或 unwind。
   */
  findUndelivered(opts?: { rig?: string; limit?: number; compact?: boolean }): QueueItem[] {
    // OPR.0.5.6.14——delivery 事实属于当前 human-notification episode，而非整行历史。取出可携带
    // 当前 episode 或旧版 nudge/receipt 的每个 active 行，再在 JS 中派生/过滤。LIMIT 在过滤后应用，
    // 避免历史 POSTED episode 占用窗口并隐藏后续失败。
    const ownerEpisodeCandidate = this.hasOwnerNotificationColumns
      ? `EXISTS (SELECT 1 FROM queue_transitions owner_episode
                   WHERE owner_episode.qitem_id = queue_items.qitem_id
                     AND owner_episode.owner_notification_level IS NOT NULL)`
      : "0";
    const conditions = [
      "state IN ('pending', 'in-progress', 'blocked')",
      `((state = 'pending' AND (last_nudge_result LIKE 'failed:%'
                             OR last_nudge_result LIKE 'unroutable:%'
                             OR last_nudge_result LIKE 'gateway-owned%'))
         OR ${ownerEpisodeCandidate}
         OR EXISTS (SELECT 1 FROM queue_transitions receipt
                      WHERE receipt.qitem_id = queue_items.qitem_id
                        AND (receipt.transition_note LIKE 'slack-owner-notification-posted %'
                          OR receipt.transition_note LIKE 'slack-owner-notification-transport-failed %')))`,
    ];
    const params: unknown[] = [];
    if (opts?.rig) {
      const escaped = opts.rig.replace(/%/g, "\\%").replace(/_/g, "\\_");
      conditions.push("(destination_session LIKE ? ESCAPE '\\' OR source_session LIKE ? ESCAPE '\\')");
      params.push(`%@${escaped}`, `%@${escaped}`);
    }
    const columns = opts?.compact ? COMPACT_QUEUE_COLUMNS + (this.hasHumanIntentColumn ? ", human_intent" : "") : "*";
    const sql = `SELECT ${columns} FROM queue_items WHERE ${conditions.join(" AND ")} ORDER BY ts_created ASC`;
    const rows = this.db.prepare(sql).all(...params) as QueueItemRow[];
    const out: QueueItem[] = [];
    for (const r of rows) {
      const item = this.rowToItem(r, !opts?.compact);
      const ledger = this.deliveryOutcomeFor(item.qitemId);
      if (ledger?.outcome === "posted") continue; // receipt 始终优先。
      if (ledger?.outcome === "transport-failed") {
        out.push({
          ...item,
          deliveryOutcome: "transport-failed",
          deliveryFailureClass: "transport-failed",
          deliveryFailureDetail: ledger.detail,
        });
      } else if (ledger?.outcome === "never-posted") {
        out.push({
          ...item,
          deliveryOutcome: "never-posted",
          deliveryFailureClass: "never-posted",
          deliveryFailureDetail: ledger.detail,
        });
      } else {
        // 无 ledger verdict：只有旧版 pending failed/unroutable 类别属于 undelivered。active 非 human
        // 行仍可能有旧 OWNER transition；该历史 episode 不是当前义务。
        const lastNudge = item.lastNudgeResult ?? "";
        if (item.state === "pending" && (lastNudge.startsWith("failed:") || lastNudge.startsWith("unroutable:"))) {
          out.push(item);
        }
      }
      if (opts?.limit !== undefined && out.length >= opts.limit) break;
    }
    return out;
  }

  /** OPR.0.5.6.14——terminal transport 是能力，而非 topology presence。精确 session 或组合的
   * canonical seat 仅在其 node 携带显式 tmux binding 时才是 pane-bound。external_cli 无 pane，
   * 必须继续走 human-registry/gateway 分支。只有数据库无法携带分类 evidence（空/部分 bootstrap
   * schema）时才 fail-open。 */
  private hasTerminalTransport(dest: string): boolean {
    try {
      const anyTopology = this.db.prepare("SELECT 1 FROM sessions LIMIT 1").get()
        ?? this.db.prepare("SELECT 1 FROM nodes LIMIT 1").get();
      if (!anyTopology) return true;
      if (this.db.prepare(
        `SELECT 1 FROM sessions s JOIN bindings b ON b.node_id = s.node_id
          WHERE s.session_name = ?
            AND COALESCE(b.attachment_type, 'tmux') = 'tmux'
            AND b.tmux_session IS NOT NULL LIMIT 1`,
      ).get(dest)) return true;
      const at = dest.lastIndexOf("@");
      if (at <= 0) return true; // 非 canonical 结构保持在旧路径。
      const seat = dest.slice(0, at);
      const rig = dest.slice(at + 1);
      const composed = this.db.prepare(
        `SELECT 1 FROM nodes n
          JOIN rigs r ON r.id = n.rig_id
          JOIN bindings b ON b.node_id = n.id
          WHERE r.name = ? AND REPLACE(n.logical_id, '.', '-') = ?
            AND COALESCE(b.attachment_type, 'tmux') = 'tmux'
            AND b.tmux_session IS NOT NULL LIMIT 1`,
      ).get(rig, seat);
      return !!composed;
    } catch {
      return true; // schema 不完整的 fixture 数据库：无 evidence 时绝不判别。
    }
  }

  /** null 表示旧版/无 OWNER 历史；inactive 表示 OWNER 历史存在，但该行已不再投影当前
   * 人工通知阶段。 */
  private currentDeliveryEpisode(item: QueueItem): { notificationKey: string; startedAt: string } | "inactive" | null {
    const transition = this.transitionLog.latestOwnerNotificationForQitem(item.qitemId);
    if (!transition) return null;
    const registry = this.loadHumanRegistryFn();
    if (!registry.ok) return "inactive";
    const humanAddress = transition.ownerNotificationKind === "human-decision-resolved"
      ? resolveRegisteredHumanAddress(transition.actorSession, registry.entities)
      : item.state === "blocked"
        ? resolveRegisteredHumanAddress(item.blockedOn, registry.entities)
        : resolveRegisteredHumanAddress(item.destinationSession, registry.entities);
    return humanAddress
      ? { notificationKey: `${item.qitemId}:${transition.transitionId}`, startedAt: transition.ts }
      : "inactive";
  }

  /** OPR.0.5.6.14——派生当前 episode 的 delivery ledger。receipt transition 与 item 同行，但以
   * qitemId:OWNER-transitionId 定键；旧 posted receipt 无法遮蔽后续 human park。旧版 OWNER 前或
   * 字面 external 行保留行范围 fallback。 */
  deliveryOutcomeFor(qitemId: string): { outcome: "posted" | "transport-failed" | "never-posted"; detail: string } | null {
    // 某些仅 repository fixture 有意模拟 transition 前 schema。此时 delivery projection 是增量的：
    // 缺席表示无 verdict，绝不导致 list 失败。
    if (!this.hasQueueTransitionsTable) return null;
    const row = this.db.prepare("SELECT * FROM queue_items WHERE qitem_id = ?")
      .get(qitemId) as QueueItemRow | undefined;
    if (!row) return null;
    // delivery episode 使用行字段，而非 waiting/backstop view。保持本次读取新鲜，同时不重复调用方的
    // recovery-tag 扫描。
    const item = this.rowToItem(row, false);
    const episodeState = this.currentDeliveryEpisode(item);
    if (episodeState === "inactive") return null;
    const episode = episodeState;
    const notes = this.db.prepare(
      `SELECT transition_note FROM queue_transitions
        WHERE qitem_id = ? AND (transition_note LIKE 'slack-owner-notification-posted %'
                             OR transition_note LIKE 'slack-owner-notification-transport-failed %')
        ORDER BY transition_id DESC`,
    ).all(qitemId) as Array<{ transition_note: string }>;
    const currentNotes = episode
      ? notes.filter((note) => note.transition_note.split(/\s+/).includes(`notification_key=${episode.notificationKey}`))
      : notes;
    const posted = currentNotes.find((note) => note.transition_note.startsWith("slack-owner-notification-posted "));
    if (posted) return { outcome: "posted", detail: posted.transition_note };
    const failed = currentNotes.find((note) => note.transition_note.startsWith("slack-owner-notification-transport-failed "));
    if (failed) return { outcome: "transport-failed", detail: failed.transition_note };
    const startedAt = episode?.startedAt ?? item.tsCreated;
    const gatewayRouted = episode !== null || item.lastNudgeResult?.startsWith("gateway-owned") === true;
    if (gatewayRouted) {
      const ageMs = Date.now() - new Date(startedAt.includes("T") ? startedAt : startedAt + "Z").getTime();
      if (ageMs > QueueRepository.NEVER_POSTED_WINDOW_MS) {
        const key = episode ? `，notification_key=${episode.notificationKey}` : "";
        return { outcome: "never-posted", detail: `gateway-routed 行超过 post 窗口仍无 delivery receipt${key}` };
      }
    }
    return null;
  }

  /** 无 receipt 的 gateway-routed 行如实显示 never-posted 前的宽限窗口（connector sweep cadence
   * 限定正常 posting 延迟）。 */
  static readonly NEVER_POSTED_WINDOW_MS = 120_000;

  recordNudgeAttempt(qitemId: string, result: string): void {
    const ts = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE queue_items
           SET last_nudge_attempt = ?, last_nudge_result = ?
         WHERE qitem_id = ?`
      )
      .run(ts, result, qitemId);
  }

  /**
   * Pod fallback：将 qitem 重定向到 fallback destination（例如 seat 不可达时）。发出
   * qitem.fallback_routed；保留 chain_of_record。
   */
  routeToFallback(qitemId: string, fallbackDestination: string, reason: string): QueueItem {
    const qitem = this.getById(qitemId);
    if (!qitem) {
      throw new QueueRepositoryError("qitem_not_found", `找不到 qitem ${qitemId}`);
    }
    const ts = new Date().toISOString();
    const originalDestination = qitem.destinationSession;
    const newChain = JSON.stringify([...(qitem.chainOfRecord ?? []), `fallback-from:${originalDestination}`]);

    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE queue_items
             SET destination_session = ?,
                 ts_updated = ?,
                 chain_of_record = ?,
                 resolution = ?
           WHERE qitem_id = ?`
        )
        .run(fallbackDestination, ts, newChain, `fallback: ${reason}`, qitemId);

      this.transitionLog.append({
        qitemId,
        state: qitem.state,
        actorSession: "system:queue-fallback",
        transitionNote: `fallback-routed: ${originalDestination} → ${fallbackDestination} (${reason})`,
      });

      return this.eventBus.persistWithinTransaction({
        type: "qitem.fallback_routed",
        qitemId,
        originalDestination,
        rerouteDestination: fallbackDestination,
        reason,
      });
    });

    const persistedEvent = txn();
    this.eventBus.notifySubscribers(persistedEvent);
    return this.getByIdOrThrow(qitemId);
  }

  private getByIdOrThrow(qitemId: string): QueueItem {
    const item = this.getById(qitemId);
    if (!item) {
      throw new QueueRepositoryError("qitem_not_found", `写入后找不到 qitem ${qitemId}`);
    }
    return item;
  }

  /** OPR.0.4.1.18——增量持久化可选的人类可读 summary。由 detectQueueColumn 守卫，使使用 044
   * 前 schema（无 summary 列）的 fixture 不受影响；只在值存在时写入（null 为默认值，并在 Story
   * consumer 中降级）。在调用方 transaction（create / handoff / handoff-and-complete）内运行。 */
  private persistSummary(qitemId: string, summary: string | null): void {
    if (this.hasSummaryColumn && summary !== null) {
      this.db.prepare("UPDATE queue_items SET summary = ? WHERE qitem_id = ?").run(summary, qitemId);
    }
  }

  /** OPR.0.4.4.19 FR-5——增量持久化可选 evidence_ref，与 persistSummary 契约相同
   *（048 前 fixture 降级；默认为 null）。 */
  private persistEvidenceRef(qitemId: string, evidenceRef: string | null): void {
    if (this.hasEvidenceRefColumn && evidenceRef !== null) {
      this.db.prepare("UPDATE queue_items SET evidence_ref = ? WHERE qitem_id = ?").run(evidenceRef, qitemId);
    }
  }

  /** GHOST-STAGE（e/Class-B）——增量持久化 MINTING occupant-generation（与 persistSummary
   * 使用相同降级契约；无法解析/063 前为 null）。这是 creator 的取证 provenance；RELEASE 判别器
   * 是 claimed_by_generation_uuid（claim 时盖章），而非此字段。 */
  private persistMintingGeneration(qitemId: string, sourceSession: string): void {
    if (!this.hasMintingGenColumn) return;
    const gen = this.resolveOccupantGeneration?.(sourceSession) ?? null;
    if (gen === null) return;
    this.db.prepare("UPDATE queue_items SET minting_generation_uuid = ? WHERE qitem_id = ?").run(gen, qitemId);
  }

  /**
   * GHOST-STAGE（e/Class-B）——seat 交换时，将由 retiring generation claim 的每个 in-progress item
   * 释放（绝不硬删除）回 pending：role work 是持久的，successor 会重新 claim；ghost 只有 retiree 的
   * stale claim。通过 claimed_by_generation_uuid 按 gen 限定（而非 seat 名；successor 共享该名称，
   * 按名称释放会夺走 successor 自己的 claim）。null/空 generation 永不匹配（UNKNOWN != retired）。
   * 清除 claim stamp + claimed_at，并为每个 item 追加 audit transition。返回释放数量。063 前数据库
   * 为 no-op。
   */
  releaseClaimsByGeneration(retiringGeneration: string): number {
    if (!this.hasClaimedGenColumn || !retiringGeneration) return 0;
    const rows = this.db
      .prepare(`SELECT qitem_id FROM queue_items WHERE state = 'in-progress' AND claimed_by_generation_uuid = ?`)
      .all(retiringGeneration) as Array<{ qitem_id: string }>;
    if (rows.length === 0) return 0;
    const ts = new Date().toISOString();
    const txn = this.db.transaction(() => {
      for (const { qitem_id } of rows) {
        this.db
          .prepare(
            `UPDATE queue_items
               SET state = 'pending', ts_updated = ?, claimed_at = NULL, closure_required_at = NULL,
                   claimed_by_generation_uuid = NULL
             WHERE qitem_id = ?`
          )
          .run(ts, qitem_id);
        this.transitionLog.append({
          qitemId: qitem_id,
          state: "pending",
          actorSession: "system",
          transitionNote: "已释放：claimant generation 已退役（seat handover）",
        });
      }
    });
    txn();
    return rows.length;
  }

  private activityReader?: WaitingActivityReader;
  attachActivityReader(reader: WaitingActivityReader): void { this.activityReader = reader; }

  private workflowGuidance?: (packetId: string) => string[];
  attachWorkflowGuidance(reader: (packetId: string) => string[]): void { this.workflowGuidance = reader; }

  evaluateWaitReminder(input: { jobId: string }) {
    if (this.wakeRepo.findQitemsByAttachedWatchdog(input.jobId).length > 0
      && this.wakeRepo.findQitemsByGeneratedTimer(input.jobId).every(row => row.state !== "blocked")) return null;
    const binding = this.wakeRepo.findBlockedQitemsByWatchdog(input.jobId).find(row => row.kind === "timer");
    const result = evaluateQueueWait(this.watchdogJobsRepo ?? new WatchdogJobsRepository(this.db), input.jobId, binding ? this.waitingView(binding.qitemId) : null);
    // 只有已准入 send 才读取 prose：healthy 静默、receipt 和 failed-delivery retry 继续由现有 wait
    // evaluator 所有。
    if (result?.action === "send" && binding && this.workflowGuidance) {
      try { result.message += "\n" + this.workflowGuidance(binding.qitemId).join("\n"); }
      catch (error) { result.message += "\nWorkflow 方法：UNKNOWN：当前 guidance 不可用：" + String(error); }
    }
    return result;
  }

  ownerActivity(session: string): ReturnType<WaitingActivityReader> {
    try { return this.activityReader?.(session) ?? null; } catch { return null; }
  }

  waitingView(qitemId: string): WaitingView | null {
    const view = readWaitingView(this.db, qitemId, this.activityReader);
    if (view && ["pending", "in-progress"].includes(view.state)) {
      const recovery = readWakeLadderBackstop(this.db, qitemId);
      if (recovery) {
        view.laterBackstop = { ...view.nextBackstop, note: "条件式安全网；先评估当前 delivery/recovery ownership。" };
        view.nextBackstop = recovery;
      }
    }
    return view;
  }

  private rowToItem(row: QueueItemRow, includeWaiting = true): QueueItem {
    // S04——在唯一共享投影点派生 pickup receipt（list/show/overdue 都经过此处），使行本身即可回答
    // park-vs-strand 问题。
    const meaningful = lastMeaningfulTransition(this.db, row.qitem_id);
    const waiting = includeWaiting ? this.waitingView(row.qitem_id) : null;
    const activity = this.ownerActivity(row.destination_session);
    const pickup = derivePickup({
      state: row.state,
      lastMeaningfulAt: meaningful?.at,
      activity: activity?.activity,
      needsInput: activity?.needsInput.count,
      claimedAt: row.claimed_at,
      lastHeartbeat: row.last_heartbeat,
      postClaimMotionCount: 0, // 此 reader 提供当前 meaningful timestamp。
    });
    return {
      pickup,
      ...(waiting ? { waiting } : {}),
      qitemId: row.qitem_id,
      tsCreated: row.ts_created,
      tsUpdated: row.ts_updated,
      sourceSession: row.source_session,
      destinationSession: row.destination_session,
      state: row.state as QueueState,
      priority: row.priority as QueuePriority,
      tier: row.tier,
      tags: row.tags ? (JSON.parse(row.tags) as string[]) : null,
      blockedOn: row.blocked_on,
      handedOffTo: row.handed_off_to,
      handedOffFrom: row.handed_off_from,
      expiresAt: row.expires_at,
      chainOfRecord: row.chain_of_record ? (JSON.parse(row.chain_of_record) as string[]) : null,
      body: row.body ?? "",
      // OPR.0.4.1.18：summary 仅在 migration 044 已应用时存在；旧版/最小 fixture 提供 summary
      // 为 undefined 的行 → null。
      summary: row.summary ?? null,
      // OPR.0.4.4.19 FR-5：evidence_ref 仅在 migration 048 已应用时存在；旧 fixture 降级为 null。
      evidenceRef: row.evidence_ref ?? null,
      humanIntent: row.human_intent ?? null,
      humanDetail: row.human_detail ?? null,
      closureReason: row.closure_reason as ClosureReason | null,
      closureTarget: row.closure_target,
      closureRequiredAt: row.closure_required_at,
      claimedAt: row.claimed_at,
      lastNudgeAttempt: row.last_nudge_attempt,
      lastNudgeResult: row.last_nudge_result,
      lastHeartbeat: row.last_heartbeat,
      resolution: row.resolution,
      // PL-007：target_repo 仅在 migration 038 已应用时存在；旧测试 fixture 提供 target_repo 为
      // undefined 的旧版行。
      targetRepo: row.target_repo ?? null,
    };
  }
}

function isQueueState(value: unknown): value is QueueState {
  return typeof value === "string" && (QUEUE_STATES as readonly string[]).includes(value);
}
