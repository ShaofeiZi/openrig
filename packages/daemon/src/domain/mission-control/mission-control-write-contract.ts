// PL-005 Phase A：Mission Control 写契约——7 个原子动词动作。
//
// 承重。按 PRD 验收标准及 slice IMPL 的 Guard Checkpoint Focus 第 2 项，7 个动词各自都是
// 一次原子事务。四步 `handoff` 形状（更新来源 + 创建目标 + 可选尽力通知 + 追加审计记录）
// 是规范证明案例；其余 6 个动词遵循相同的原子更新 + 审计形状，并携带各自动词的 metadata。
//
// 组合方式（每次动词调用使用一个 db.transaction）：
//   1. 验证目标 qitem 存在且尚未终结。
//   2. 通过 Phase D 的 QueueRepository.updateWithinTransaction 计算该动词对应的队列变更，
//      保留 Phase A hot-potato 闭合校验，并发出 queue.updated 事件。
//   3. 对 handoff：在同一外层事务中调用 QueueRepository.createWithinTransaction 创建目标 packet。
//   4. 追加 mission_control_actions 审计记录，包含变更前后状态快照。
//   5. 持久化 mission_control.action_executed 事件。
//
// 提交后（事务外）：先向 subscriber 排空事件 envelope，再执行可选的尽力传输通知。
// 通知失败不会回滚持久变更（PRD 不变量："notify failure does NOT roll back durable mutations"）。
//
// 动词映射：
//   approve   → state="done",        closure_reason="no-follow-on"
//   deny      → state="done",        closure_reason="denied"
//   route     → state="done",        closure_reason="handed_off_to",
//                closure_target+handed_off_to=<路由目标>;
//                在 route 目标创建新 qitem（单跳）
//   annotate  → 不修改队列；只写审计记录（annotation 字段附在 mission_control_actions）
//   hold      → state="blocked",     closure_reason="blocked_on",
//                closure_target+blocked_on=<原因文本>
//   drop      → state="done",        closure_reason="canceled",
//                closure_target=<reason>
//   handoff   → state="handed-off",  closure_reason="handed_off_to",
//                closure_target+handed_off_to=<destination>;
//                在目标处创建新 qitem（规范四步流程）

import type Database from "better-sqlite3";
import type { EventBus } from "../event-bus.js";
import type { QueueRepository, QueueItem } from "../queue-repository.js";
import type { PersistedEvent } from "../types.js";
import {
  MissionControlActionLog,
  MissionControlActionLogError,
  type MissionControlVerb,
} from "./mission-control-action-log.js";
import { isHumanSeatSession } from "../human-route-enforcer.js";

export class MissionControlWriteContractError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MissionControlWriteContractError";
  }
}

export interface MissionControlActionInput {
  verb: MissionControlVerb;
  qitemId: string;
  actorSession: string;
  /** P21 纪元戳：说明 actorSession 如何建立。路由传入从传输瓶颈点派生的 `transport:v1`；
   * 省略/null 表示 claimed 纪元，绝不重新标记。该值记录在审计行上。 */
  identityProvenance?: string | null;
  /** `route` 与 `handoff` 必填。 */
  destinationSession?: string;
  /** `route`/`handoff` 新 packet 的正文；默认使用来源正文。 */
  body?: string;
  /** `annotate` 必填。 */
  annotation?: string;
  /** `hold` 与 `drop` 必填；其他动词中为可选提示文本。 */
  reason?: string;
  /** OPR.0.4.4.19 FR-7——`resolve` 必填：人工给出的非空决策文本，
   * 持久写入 queue_transitions.transition_note。 */
  decision?: string;
  /** 操作者提供的审计上下文。 */
  auditNotes?: Record<string, unknown>;
  /**
   * handoff 可选择执行尽力唤醒，默认为 true（PL-004 Phase A R1 模式：默认持久化并唤醒；
   * 操作者可为冷队列关闭）。notify 失败不会回滚持久状态。
   */
  notify?: boolean;
}

export interface MissionControlActionResult {
  actionId: string;
  verb: MissionControlVerb;
  qitemId: string;
  closedQitem: QueueItem | null;
  createdQitemId: string | null;
  notifyAttempted: boolean;
  notifyResult: string | null;
  auditedAt: string;
}

interface WriteContractDeps {
  db: Database.Database;
  eventBus: EventBus;
  queueRepo: QueueRepository;
  actionLog: MissionControlActionLog;
  now?: () => Date;
}

export class MissionControlWriteContract {
  private readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly queueRepo: QueueRepository;
  private readonly actionLog: MissionControlActionLog;
  private readonly now: () => Date;

  constructor(deps: WriteContractDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.queueRepo = deps.queueRepo;
    this.actionLog = deps.actionLog;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * 执行一个动词。持久层保持原子性：队列变更、审计记录与事件持久化位于同一事务。
   * 提交后通知 subscriber，并按需执行传输唤醒（仅 handoff）。
   */
  async act(input: MissionControlActionInput): Promise<MissionControlActionResult> {
    if (input.verb === "annotate") {
      return this.annotateOnly(input);
    }
    if (input.verb === "resolve") {
      return this.resolveParked(input);
    }

    const source = this.requireMutableQitem(input.qitemId);

    if ((input.verb === "route" || input.verb === "handoff") && !input.destinationSession) {
      throw new MissionControlWriteContractError(
        "destination_required",
        `verb=${input.verb} 需要 destinationSession`,
        { verb: input.verb },
      );
    }

    const evaluatedAt = this.now().toISOString();
    const closure = verbToClosure(input);
    const beforeSnapshot = snapshotQitem(source);
    let createdQitemId: string | null = null;
    let createdDestination: string | undefined;
    let createdNudge: boolean | undefined;
    let actionEntry: ReturnType<MissionControlActionLog["record"]> | null = null;
    try {
      this.eventBus.withNotifyEnvelope((register) => {
        // 1. 通过 Phase A 队列闭合原语关闭/迁移来源。
        const closeResult = this.queueRepo.updateWithinTransaction({
          qitemId: input.qitemId,
          actorSession: input.actorSession,
          state: closure.state,
          closureReason: closure.closureReason,
          closureTarget: closure.closureTarget ?? undefined,
          handedOffTo: closure.handedOffTo,
          blockedOn: closure.blockedOn,
          transitionNote: `mission-control:${input.verb}${input.reason ? ` (${input.reason})` : ""}`,
        });
        register(closeResult.persistedEvent);

        // 2. 对 route/handoff：在同一事务中创建目标 packet。
        if ((input.verb === "route" || input.verb === "handoff") && input.destinationSession) {
          const created = this.queueRepo.createWithinTransaction({
            sourceSession: input.actorSession,
            destinationSession: input.destinationSession,
            body: input.body ?? source.body,
            priority: source.priority,
            tier: source.tier ?? undefined,
            summary: source.summary,
            evidenceRef: source.evidenceRef,
            tags: source.tags
              ? [...source.tags, `mission-control:${input.verb}`]
              : [`mission-control:${input.verb}`],
            chainOfRecord: [...(source.chainOfRecord ?? []), input.qitemId],
            // 默认 nudge 按 Phase D 模式在提交后处理。
            nudge: input.notify,
          });
          createdQitemId = created.qitemId;
          createdDestination = created.destinationSession;
          createdNudge = created.nudge;
          register(created.persistedEvent);
          // P34：在本事务中暂存继任者的 WAKE INTENT，使 close 与持久 wake 要么作为一个动作
          // 一起提交，要么都不提交。pane 写入本身仍在提交后执行（绝不反序）。
          this.queueRepo.stageWakeIntent(
            created.qitemId,
            input.actorSession,
            created.destinationSession,
            input.identityProvenance ?? null,
            created.nudge,
          );
        }

        // 3. 追加审计记录，并快照已关闭 qitem 的状态。
        const closedQitem = this.queueRepo.getById(input.qitemId);
        const afterSnapshot = closedQitem ? snapshotQitem(closedQitem) : null;
        actionEntry = this.actionLog.record({
          actionVerb: input.verb,
          qitemId: input.qitemId,
          actorSession: input.actorSession,
          actedAt: evaluatedAt,
          beforeState: beforeSnapshot,
          afterState: afterSnapshot,
          reason: input.reason ?? null,
          annotation: input.annotation ?? null,
          notifyAttempted: false,
          notifyResult: null,
          auditNotes: input.auditNotes ?? null,
          identityProvenance: input.identityProvenance ?? null, // 审计行上的 P21 纪元戳。
        });

        // 4. 在同一事务中持久化 mission_control.action_executed 事件。
        register(
          this.eventBus.persistWithinTransaction({
            type: "mission_control.action_executed",
            actionId: actionEntry.actionId,
            actionVerb: input.verb,
            qitemId: input.qitemId,
            actorSession: input.actorSession,
          }),
        );

        // P34：W1 接缝，作为本事务最后一条语句执行。若此动作终结来源并创建继任者，继任者的
        // wake intent 必须在同一事务内持久化；否则在此回滚整个动作，而不是提交一个已执行但未唤醒的
        // 条目。非终结迁移（`hold` park）会在原语内部提前返回（queue-repository.ts 的
        // isTerminalState），因此 park 调用方按构造不受影响；没有继任者的终结 close 无需唤醒，
        // 也不会在此配对。
        if (createdQitemId && createdDestination) {
          this.queueRepo.assertTerminalClosureHasIntent(input.qitemId, createdQitemId, createdNudge);
        }
      });
    } catch (err) {
      if (err instanceof MissionControlActionLogError) {
        throw new MissionControlWriteContractError(err.code, err.message, err.details);
      }
      throw err;
    }

    // handoff/route 提交后执行尽力通知。按 PL-004 R1 模式默认为 true；失败不会回滚持久变更。
    let notifyAttempted = false;
    let notifyResult: string | null = null;
    if (createdQitemId && createdDestination && (input.verb === "route" || input.verb === "handoff")) {
      try {
        // V0.3.1 slice 23：将 actorSession 作为来源贯穿传递，使 nudge envelope 显示
        // route/handoff 的来源。P34：通过共享 staged-intent 路径投递，而非 maybeNudge；
        // 它认领并终结本事务暂存的 intent 行，使启动恢复扫描无法重复发送同一 wake。
        // 未挂载 intent store 时，回退到 W1 前的尽力 nudge。
        await this.queueRepo.deliverWakeForSuccessor(
          createdQitemId,
          createdDestination,
          createdNudge,
          input.actorSession,
        );
        notifyAttempted = createdNudge !== false;
        notifyResult = notifyAttempted ? "attempted-best-effort" : "skipped";
      } catch (err) {
        notifyAttempted = true;
        notifyResult = `failed:${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return {
      actionId: actionEntry!.actionId,
      verb: input.verb,
      qitemId: input.qitemId,
      closedQitem: this.queueRepo.getById(input.qitemId),
      createdQitemId,
      notifyAttempted,
      notifyResult,
      auditedAt: evaluatedAt,
    };
  }

  /**
   * Annotate 不修改队列，只记录审计与事件；仍包在事务内，以保证审计与事件原子提交。
   */
  private async annotateOnly(input: MissionControlActionInput): Promise<MissionControlActionResult> {
    if (!input.annotation) {
      throw new MissionControlWriteContractError(
        "annotation_required",
        `verb=annotate 需要 annotation`,
        { verb: input.verb },
      );
    }
    const source = this.requireMutableQitem(input.qitemId);
    const snapshot = snapshotQitem(source);
    const evaluatedAt = this.now().toISOString();
    let actionEntry: ReturnType<MissionControlActionLog["record"]> | null = null;
    const persistedEvents: PersistedEvent[] = [];

    const txn = this.db.transaction(() => {
      actionEntry = this.actionLog.record({
        actionVerb: "annotate",
        qitemId: input.qitemId,
        actorSession: input.actorSession,
        actedAt: evaluatedAt,
        beforeState: snapshot,
        afterState: snapshot,
        annotation: input.annotation!,
        auditNotes: input.auditNotes ?? null,
        identityProvenance: input.identityProvenance ?? null, // 审计行上的 P21 纪元戳。
      });
      persistedEvents.push(
        this.eventBus.persistWithinTransaction({
          type: "mission_control.action_executed",
          actionId: actionEntry.actionId,
          actionVerb: "annotate",
          qitemId: input.qitemId,
          actorSession: input.actorSession,
        }),
      );
    });
    txn();
    for (const e of persistedEvents) this.eventBus.notifySubscribers(e);

    return {
      actionId: actionEntry!.actionId,
      verb: "annotate",
      qitemId: input.qitemId,
      closedQitem: this.queueRepo.getById(input.qitemId),
      createdQitemId: null,
      notifyAttempted: false,
      notifyResult: null,
      auditedAt: evaluatedAt,
    };
  }

  /**
   * OPR.0.4.4.19 FR-7——resolve + unpark（编码全部六条架构约束）：
   *
   *   1. 它是 mission-control 家族的独立动词（本方法），不是 annotate/route 的重载。
   *   2. 决策文本以可查询形式持久写入 queue_transitions.transition_note，且 actor_session
   *      等于执行 resolve 的会话；composer 此后始终从这里读取。
   *   3. Unpark 通过 Phase A 枚举校验的 update 将 blocked 变为 in-progress，不修改状态机，
   *      并复用现有 nudge 机制。
   *   4. Resolution 路由回停驻 owner；qitem 保持原 destination，此处绝不创建新的传递 owner。
   *   5. 强制对称：park 需要 summary + evidence_ref；resolve 需要非空决策文本，由后台服务强制。
   *   6. 人工在 surface/feed 卡片上操作；唯一写路径是
   *      POST /api/mission-control/action verb=resolve，CLI 包装器只是同一端点的薄客户端。
   *
   * 按契约不闭合：verbToClosure 不提供 resolve 映射；已 resolve 的 qitem 为 state=in-progress，
   * closure_reason 仍为 null。单个事务包含 transition + 决策备注 + 审计行 + 事件。携带决策文本的
   * owner nudge 在提交后尽力执行；unpark 绝不会因传输失败丢失（BR-8）。
   */
  private async resolveParked(input: MissionControlActionInput): Promise<MissionControlActionResult> {
    const decision = input.decision?.trim();
    if (!decision) {
      throw new MissionControlWriteContractError(
        "decision_required",
        "verb=resolve 需要非空决策文本；本原语正是为了消除未记录决策的 park",
        { verb: input.verb },
      );
    }
    const source = this.queueRepo.getById(input.qitemId);
    if (!source) {
      throw new MissionControlWriteContractError(
        "qitem_not_found",
        `未找到 qitem ${input.qitemId}`,
        { qitemId: input.qitemId },
      );
    }
    if (source.state !== "blocked" || !isHumanSeatSession(source.blockedOn)) {
      throw new MissionControlWriteContractError(
        "qitem_not_leg1_parked",
        `verb=resolve 需要 leg-1 parked qitem（state=blocked 且 blocked_on 为人工席位）；` +
          `qitem ${input.qitemId} 当前 state=${source.state}、blocked_on=${source.blockedOn ?? "null"}。` +
          `再次 resolve 已解决条目会返回无操作错误，而不会产生双重 transition。`,
        { qitemId: input.qitemId, state: source.state, blockedOn: source.blockedOn },
      );
    }

    const evaluatedAt = this.now().toISOString();
    const beforeSnapshot = snapshotQitem(source);
    let actionEntry: ReturnType<MissionControlActionLog["record"]> | null = null;
    try {
      this.eventBus.withNotifyEnvelope((register) => {
        // 约束 2+3：blocked → in-progress；决策文本写入 transition_note，actor_session 等于
        // 执行 resolve 的人工/relay 会话。发出 queue.updated（P2 动作后刷新契约）。刻意保留
        // blocked_on 作为原停驻对象的溯源；attention 查询以 state='blocked' 为条件，
        // 所以条目解决后仍会退出 attention。
        const updateResult = this.queueRepo.updateWithinTransaction({
          qitemId: input.qitemId,
          actorSession: input.actorSession,
          state: "in-progress",
          transitionNote: decision,
          ownerNotificationKind: "human-decision-resolved",
        });
        register(updateResult.persistedEvent);

        const resolvedQitem = this.queueRepo.getById(input.qitemId);
        actionEntry = this.actionLog.record({
          actionVerb: "resolve",
          qitemId: input.qitemId,
          actorSession: input.actorSession,
          actedAt: evaluatedAt,
          beforeState: beforeSnapshot,
          afterState: resolvedQitem ? snapshotQitem(resolvedQitem) : null,
          reason: decision,
          auditNotes: input.auditNotes ?? null,
          identityProvenance: input.identityProvenance ?? null, // 审计行上的 P21 纪元戳。
        });

        register(
          this.eventBus.persistWithinTransaction({
            type: "mission_control.action_executed",
            actionId: actionEntry.actionId,
            actionVerb: "resolve",
            qitemId: input.qitemId,
            actorSession: input.actorSession,
          }),
        );
      });
    } catch (err) {
      if (err instanceof MissionControlActionLogError) {
        throw new MissionControlWriteContractError(err.code, err.message, err.details);
      }
      throw err;
    }

    // 约束 3 + BR-8：提交后向停驻 owner 尽力发送携带决策文本的 nudge。Nudge 结果经现有
    // last_nudge_* 机制记录；失败绝不会撤销 unpark。
    let notifyAttempted = false;
    let notifyResult: string | null = null;
    if (input.notify !== false) {
      try {
        await this.queueRepo.maybeNudge(
          input.qitemId,
          source.destinationSession,
          input.notify,
          input.actorSession,
          `${input.qitemId} 的决策已解决：${decision}——已解除停驻（blocked → in-progress）；该事项仍归你负责，请检查队列。`,
        );
        notifyAttempted = true;
        notifyResult = "attempted-best-effort";
      } catch (err) {
        notifyAttempted = true;
        notifyResult = `failed:${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return {
      actionId: actionEntry!.actionId,
      verb: "resolve",
      qitemId: input.qitemId,
      closedQitem: this.queueRepo.getById(input.qitemId),
      createdQitemId: null,
      notifyAttempted,
      notifyResult,
      auditedAt: evaluatedAt,
    };
  }

  private requireMutableQitem(qitemId: string): QueueItem {
    const source = this.queueRepo.getById(qitemId);
    if (!source) {
      throw new MissionControlWriteContractError(
        "qitem_not_found",
        `未找到 qitem ${qitemId}`,
        { qitemId },
      );
    }
    if (source.state === "done" || source.state === "handed-off") {
      throw new MissionControlWriteContractError(
        "qitem_already_terminal",
        `qitem ${qitemId} 已处于终态（state=${source.state}）；Mission Control 不能修改终态条目`,
        { qitemId, state: source.state },
      );
    }
    return source;
  }
}

interface ClosureMapping {
  state: "handed-off" | "blocked" | "done";
  closureReason: string;
  closureTarget: string | null;
  handedOffTo?: string;
  blockedOn?: string;
}

function verbToClosure(input: MissionControlActionInput): ClosureMapping {
  switch (input.verb) {
    case "approve":
      return {
        state: "done",
        closureReason: "no-follow-on",
        closureTarget: input.reason ?? null,
      };
    case "deny":
      return {
        state: "done",
        closureReason: "denied",
        closureTarget: input.reason ?? "操作者已拒绝",
      };
    case "route":
      return {
        state: "handed-off",
        closureReason: "handed_off_to",
        closureTarget: input.destinationSession!,
        handedOffTo: input.destinationSession!,
      };
    case "hold":
      return {
        state: "blocked",
        closureReason: "blocked_on",
        closureTarget: input.reason!,
        blockedOn: input.reason!,
      };
    case "drop":
      return {
        state: "done",
        closureReason: "canceled",
        closureTarget: input.reason!,
      };
    case "handoff":
      return {
        state: "handed-off",
        closureReason: "handed_off_to",
        closureTarget: input.destinationSession!,
        handedOffTo: input.destinationSession!,
      };
    case "annotate":
      // 不应到达此处；annotate 由 annotateOnly() 处理。
      throw new MissionControlWriteContractError(
        "internal_invariant",
        "annotate 动词本应路由到 annotateOnly",
      );
    case "resolve":
      // OPR.0.4.4.19 FR-7——resolve 刻意没有 closure 映射；已 resolve 的 qitem 为
      // state=in-progress 且 closure_reason 为 null。该动词由 resolveParked() 处理；
      // 到达此处表示违反契约。
      throw new MissionControlWriteContractError(
        "internal_invariant",
        "resolve 是非闭合动词，本应路由到 resolveParked",
      );
  }
}

function snapshotQitem(q: QueueItem): Record<string, unknown> {
  return {
    qitemId: q.qitemId,
    state: q.state,
    sourceSession: q.sourceSession,
    destinationSession: q.destinationSession,
    priority: q.priority,
    tier: q.tier,
    closureReason: q.closureReason,
    closureTarget: q.closureTarget,
    handedOffTo: q.handedOffTo,
    blockedOn: q.blockedOn,
    tsUpdated: q.tsUpdated,
  };
}
