import { readWorkflowGuidance, type GuidanceInput } from "./workflow-guidance.js";
// PL-004 阶段 D：工作流投影器——事务式记录器契约。
//
// 关键承重逻辑。这是阶段 D 最重要的一条契约。
//
// 根据 PRD § L4 与审计表第 16 行：任何关闭 `workflow_instances.current_frontier`
// qitem 的代码路径，以及任何创建下一步骤 qitem 的代码路径，都必须位于同一个由 daemon
// 管理的事务中。只要能观察到两个独立事务，就违反了契约；该设计从根本上避免交接丢失。
//
// 组成（单个 db.transaction）：
//   1. 验证规范、实例与当前 packet 一致。
//   2. 从规范解析下一步骤（按 PRD 默认为单跳）。
//   3. 更新 queue_items：关闭当前 packet（handoff/waiting/done）。
//   4. 通过 QueueRepository.createWithinTransaction 创建下一步骤 queue item。
//   5. 追加包含前后 ID 的 workflow_step_trails 条目。
//   6. 更新 workflow_instances 的 frontier 与 status。
//   7. 持久化 workflow.* 事件（step_closed、next_qitem_projected、completed）。
//
// 所有操作都在同一个 db.transaction 中。任一步骤抛错都会整体回滚；提交后再向订阅者
// 分发事件并提醒下一位 owner。

import { workflowPlanningContext } from "./workflow-planning-context.js";
import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import type { QueueRepository } from "./queue-repository.js";
import type { PersistedEvent } from "./types.js";
import type { WorkflowInstanceStore } from "./workflow-instance-store.js";
import type { WorkflowSpecCache } from "./workflow-spec-cache.js";
import type { WorkflowStepTrailLog } from "./workflow-step-trail-log.js";
import type {
  WorkflowExitKind,
  WorkflowInstance,
  WorkflowSpec,
  WorkflowStepSpec,
} from "./workflow-types.js";
import { exceedsMaxHops, MAX_HOPS_BASELINE_V1 } from "./workflow-deadline.js";
import { isHumanSeatSession } from "./human-route-enforcer.js";
import { selectRoleSeat } from "./workflow-role-resolver.js";
import {
  roleResolutionContext,
  tryResolveRoleByCapability,
  type RoleResolutionContext,
} from "./workflow-role-context.js";
import { classifyFailureOccurrence, classifyGateTrip, workflowExceptionTags } from "./workflow-exception.js";
import { newQitemId, QueueRepositoryError } from "./queue-repository.js";
import { resolveExceptionRoute } from "./workflow-exception-router.js";
import { workflowHumanDestination, type WorkflowHumanDestination } from "./workflow-human-destination.js";
import type { WatchdogJobsRepository } from "./watchdog-jobs-repository.js";
import {
  disarmWorkflowKeepalive,
  ensureWorkflowKeepaliveArmed,
} from "./workflow-keepalive-arming.js";
import { requiredLifecycleSteps } from "./lifecycle-obligations.js";
import { shellQuote } from "../adapters/shell-quote.js";

const LEGACY_WORKFLOW_CONTEXT_SHORTCUT =
  "Context: this workflow packet is a shortcut, not the whole story; inspect additional project, mission, and receipt evidence before choosing an authored exit.";
const WORKFLOW_CONTEXT_SHORTCUT =
  "上下文：此工作流 packet 只是捷径，并非全部信息；选择规范声明的 exit 前，请检查其他项目、任务和回执证据。";

/** 与单次 occurrence 绑定的操作，由 packet 正文和规范声明的 waiting 唤醒共同使用。 */
export function renderWorkflowProjectCommand(input: {
  instanceId: string;
  packetId: string;
  ownerSession: string;
  step?: Pick<WorkflowStepSpec, "acceptance">;
}): string {
  const base = `zrig workflow project --instance ${input.instanceId} --current-packet ${input.packetId} --exit <handoff|waiting|done|failed> --actor-session ${input.ownerSession}`;
  const acceptance = input.step?.acceptance;
  if (!acceptance) return base;
  const verdict = acceptance.verdicts.length === 1
    ? acceptance.verdicts[0]!
    : `<${acceptance.verdicts.join("|")}>`;
  return `${base} --acceptance-candidate ${shellQuote(acceptance.candidate)} --acceptance-verdict ${shellQuote(verdict)} --acceptance-evidence-ref ${shellQuote(acceptance.evidence_ref)}`;
}

function workflowMethodLines(input: GuidanceInput): string[] {
  const guidance = readWorkflowGuidance(input);
  return guidance.state === "unselected" ? [] : guidance.lines;
}

/** packet 因 route/resume 重建时刷新指引，避免从复制的正文中沿用过期 packet ID 或 owner。 */
export function withWorkflowContinuation(input: {
  body: string;
  contextRefs?: string[];
  binding?: GuidanceInput["binding"];
  library?: GuidanceInput["library"];
  instanceId: string;
  packetId: string;
  ownerSession: string;
  step?: Pick<WorkflowStepSpec, "acceptance"> & { id?: string };
}): string {
  const lines = input.body
    .split("\n")
    .filter((line) => !line.startsWith("Continuation: ") && !line.startsWith("Workflow plan: ") && !line.startsWith("工作流计划：") && !line.startsWith("Workflow method: ") && !line.startsWith("工作流方法：") && line !== WORKFLOW_CONTEXT_SHORTCUT && line !== LEGACY_WORKFLOW_CONTEXT_SHORTCUT && !(input.contextRefs && line.startsWith("Context reference: ")));
  while (lines.at(-1) === "") lines.pop();
  return [
    ...lines,
    "",
    ...workflowPlanningContext(input.contextRefs, input.instanceId),
    ...workflowMethodLines({...input, stepId: input.step?.id}),
    ...(input.contextRefs ?? []).map((ref) => `Context reference: ${ref}`),
    `Continuation: ${renderWorkflowProjectCommand(input)}`,
    WORKFLOW_CONTEXT_SHORTCUT,
  ].join("\n");
}

export function workflowWaitWakeMessage(input: {
  spec: WorkflowSpec;
  instance: WorkflowInstance;
  step: WorkflowStepSpec;
  packetId: string;
  ownerSession: string;
}): string {
  return [
    `工作流 waiting 再次提醒（阻塞项有进展或到达提醒时间）：${input.spec.id}@${input.spec.version}，实例 ${input.instance.instanceId}，步骤 ${input.step.id}。`,
    `你仍负责同一个 frontier packet ${input.packetId}。选择规范声明的 exit 前，请先阅读它并检查当前证据。`,
    ...(input.step.objective ? [`目标：${input.step.objective}`] : []),
    ...workflowPlanningContext(input.spec.context_refs, input.instance.instanceId),
    ...(input.spec.context_refs ?? []).map((ref) => `Context reference: ${ref}`),
    `Continuation: ${renderWorkflowProjectCommand({ ...input, instanceId: input.instance.instanceId })}`,
    WORKFLOW_CONTEXT_SHORTCUT,
  ].join("\n");
}

/**
 * OPR.0.4.6.WF2 FR-2：canonical-session → node runtime 列查询（harness pin 的校准
 * 数据源）。以最新 session 行为准（遵循 node-inventory 的 join 规则）；null 表示不是受管节点。
 * 投影器（投影期 pin）与 runtime facade（实体化期静态 pin 检查）共用该函数。
 */
export function nodeRuntimeOf(db: Database.Database, session: string): string | null {
  const row = db
    .prepare(
      `SELECT n.runtime FROM nodes n
         JOIN sessions s ON s.node_id = n.id
        WHERE s.session_name = ?
        ORDER BY s.id DESC LIMIT 1`,
    )
    .get(session) as { runtime: string | null } | undefined;
  return row?.runtime ?? null;
}

export class WorkflowProjectorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WorkflowProjectorError";
  }
}

export interface ProjectStepInput {
  instanceId: string;
  /** 要关闭的 qitem（必须位于 instance.currentFrontier 中）。 */
  currentPacketId: string;
  /** 关闭此 packet 的 exit 类型。 */
  exit: WorkflowExitKind;
  /** 自由格式的关闭结果文本（POC：--result）。 */
  resultNote?: string;
  /** waiting exit 使用的阻塞项引用（qitem ID 或 gate 名称）。 */
  blockedOn?: string;
  /** 操作员为关闭记录提供的证据（用于审计）。 */
  closureEvidence?: Record<string, unknown>;
  /** 关闭 packet 的 session（owner 即作者）。 */
  actorSession: string;
  /**
   * 可选的下一步骤目标 session 显式覆盖值。省略时，投影器根据下一步骤的 actor_role 与
   * role.preferred_targets[] 解析。未声明 preferred_targets 或其中没有操作员可解析的目标时，
   * 必须提供此值。
   */
  nextOwnerSession?: string;
}

export interface ProjectStepResult {
  instance: WorkflowInstance;
  closurePriorPacketId: string;
  closureReason: WorkflowExitKind;
  /** 终结式关闭（waiting / done / failed / 无后继）时为 null。 */
  nextQitemId: string | null;
  /** 终结式关闭时为 null。 */
  nextOwnerSession: string | null;
  /** 终结式关闭时为 null。 */
  nextStepId: string | null;
  /** 依赖图推进时投影出的全部 packet/step。 */
  nextQitemIds?: string[];
  nextStepIds?: string[];
  /** 发出的组合事件（step_closed + 可选 next_qitem_projected + 可选 completed）。 */
  emittedEventTypes: string[];
  /**
   * OPR.0.4.6.WF1 FR-5：本次调用是被吸收的 waiting replay 时为 true，即完整关闭意图
   * 与已存储决策完全重复。此时没有任何写入，结果反映首次存储的 outcome。
   */
  absorbedReplay?: boolean;
}

export class WorkflowProjector {
  constructor(
    private readonly db: Database.Database,
    private readonly eventBus: EventBus,
    private readonly queueRepo: QueueRepository,
    private readonly instanceStore: WorkflowInstanceStore,
    private readonly trailLog: WorkflowStepTrailLog,
    private readonly specCache: WorkflowSpecCache,
    private readonly now: () => Date = () => new Date(),
    /** OPR.0.4.6.WF1 FR-3：可选；在事务内启用/停用 packet 或旧实例的 keepalive。 */
    private readonly watchdogJobsRepo?: WatchdogJobsRepository,
    /** OPR.0.4.6.WF5 FR-2：成熟度旋钮输入，在启动时注入（沿用 validateRig 先例，投影器
     *  自身绝不读取配置）。每次异常都实时读取 hostDefault，因此切换旋钮只影响后续条目。
     *  未提供时使用引擎默认值（优先 orchestrator，并选择已注册 human 的链路）。 */
    private readonly exceptionDial?: {
      hostDefault: () => "orchestrator" | "human_only" | null;
      humanFallbackSeat: WorkflowHumanDestination;
    },
    private readonly guidanceLibrary?: GuidanceInput["library"],
  ) {}

  private nodeRuntimeOf(session: string): string | null {
    return nodeRuntimeOf(this.db, session);
  }

  /**
   * 在同一个事务中关闭当前 packet，并创建/投影下一步骤 packet。这是关键承重的事务式
   * 记录器调用点。
   */
  async project(input: ProjectStepInput): Promise<ProjectStepResult> {
    const instance = this.instanceStore.getByIdOrThrow(input.instanceId);
    if (instance.status !== "active" && instance.status !== "waiting") {
      throw new WorkflowProjectorError(
        "instance_not_active",
        `工作流实例 ${instance.instanceId} 当前状态为 ${instance.status}；只有 active|waiting 实例接受 project 操作`,
        { instanceId: instance.instanceId, status: instance.status },
      );
    }
    if (!instance.currentFrontier.includes(input.currentPacketId)) {
      throw new WorkflowProjectorError(
        "packet_not_on_frontier",
        `qitem ${input.currentPacketId} 不在工作流实例 ${instance.instanceId} 的 frontier ${JSON.stringify(instance.currentFrontier)} 中；该 packet 可能已关闭或属于其他实例`,
        { instanceId: instance.instanceId, currentPacketId: input.currentPacketId, frontier: instance.currentFrontier },
      );
    }
    const specRow = this.specCache.getByNameVersion(instance.workflowName, instance.workflowVersion);
    if (!specRow) {
      throw new WorkflowProjectorError(
        "spec_not_cached",
        `工作流规范 ${instance.workflowName}@${instance.workflowVersion} 不在规范缓存中。请重新运行 validate 刷新缓存。`,
        { workflowName: instance.workflowName, workflowVersion: instance.workflowVersion },
      );
    }
    const spec = specRow.spec;

    // 查找要关闭的 qitem，以确定当前步骤。
    const currentPacket = this.queueRepo.getById(input.currentPacketId);
    if (!currentPacket) {
      throw new WorkflowProjectorError(
        "packet_not_found",
        `在 queue_items 中找不到 qitem ${input.currentPacketId}`,
        { currentPacketId: input.currentPacketId },
      );
    }
    // R2 修复（guard blocker 1）：从实例读取持久化的 current_step_id，而不是推断
    // "last_trail_step + 1"。复用 frontier 的 packet（waiting 后 resume）现在会正确恢复
    // 同一个步骤。
    const packetBinding = this.instanceStore.getFrontierBinding(instance.instanceId, input.currentPacketId);
    const currentStep = packetBinding
      ? spec.steps.find((step) => step.id === packetBinding.stepId) ?? null
      : instance.currentFrontier.length === 1
        ? resolveCurrentStep(spec, instance)
        : null;
    if (!currentStep) {
      throw new WorkflowProjectorError(
        "current_step_unknown",
        `工作流实例 ${instance.instanceId} 没有可解析的当前步骤（current_step_id=${JSON.stringify(instance.currentStepId)}）。实例可能已处于终态，或规范 ${spec.id}@${spec.version} 在实例运行期间改变了结构。`,
        { instanceId: instance.instanceId, currentStepId: instance.currentStepId, frontier: instance.currentFrontier },
      );
    }

    // R2 修复（guard blocker 2）：在投影时强制执行 currentStep.allowed_exits。POC 契约：
    // 不在步骤 allowed_exits 中的 exit 必须以结构化错误拒绝，且不能改变任何状态。验证发生在
    // 所有副作用（关闭队列、追加 trail、更新 frontier、持久化事件）之前。步骤省略
    // allowed_exits 时不强制执行（操作员在编写规范时选择退出该约束）。
    if (
      currentStep.allowed_exits &&
      currentStep.allowed_exits.length > 0 &&
      !currentStep.allowed_exits.includes(input.exit)
    ) {
      throw new WorkflowProjectorError(
        "exit_not_allowed",
        `步骤 "${currentStep.id}" 允许的 exit 为 ${JSON.stringify(currentStep.allowed_exits)}，实际收到 "${input.exit}"。请使用允许的 exit 关闭，或修改规范。`,
        {
          instanceId: instance.instanceId,
          stepId: currentStep.id,
          attemptedExit: input.exit,
          allowedExits: currentStep.allowed_exits,
        },
      );
    }

    // Project profile 回执是 agent 编写的引用。系统只机械检查它是否存在；daemon 既不读取
    // 被引用的正文，也不判断其内容。
    if (requiredLifecycleSteps(instance.lifecycleBinding).includes(currentStep.id) &&
        (input.exit === "done" || input.exit === "handoff")) {
      const receipt = input.closureEvidence?.evidence_ref;
      if (typeof receipt !== "string" || receipt.trim() === "") {
        throw new WorkflowProjectorError("lifecycle_receipt_required",
          `边界步骤 "${currentStep.id}" 需要由 agent 判断的回执。请提供 --evidence-ref；终态 queue 行不代表验收通过。`,
          { stepId: currentStep.id, instanceId: instance.instanceId });
      }
    }

    validateAcceptance(currentStep, input, instance);

    // 声明依赖图即选择 S06 packet-addressed executor；旧规范则原样保留下方成熟的串行记录器。
    if (spec.steps.some((step) => step.depends_on !== undefined)) {
      if (!packetBinding) {
        throw new WorkflowProjectorError(
          "frontier_binding_indeterminate",
          `工作流实例 ${instance.instanceId} 包含依赖图，但 frontier packet ${input.currentPacketId} 没有唯一的步骤绑定；拒绝根据 current_step_id 推断`,
          { instanceId: instance.instanceId, currentPacketId: input.currentPacketId },
        );
      }
      return this.projectDependencyGraph({
        input,
        instance,
        spec,
        currentStep,
        packetBinding,
        currentOwnerSession: currentPacket.destinationSession,
      });
    }

    // 确定下一步骤（默认为单跳；多跳留待后续演进）。OPR.0.4.6.WF2 FR-1：已记录的
    // exit 参与解析——有映射的 exit 解析为其分支目标（确定性：相同 (spec, step, exit)
    // 始终得到相同目标）；未映射的 exit 则沿用当前已发布的结构语义。
    const branchTargetId = currentStep.next_hop?.on?.[input.exit];
    const branchRouted = branchTargetId !== undefined;
    const nextStep = resolveNextStep(spec, currentStep, input.exit);
    if (branchRouted && !nextStep) {
      // validator 保证分支目标在 validate/instantiate 时存在；这里防御运行中实例所用的
      // 缓存规范已经过期并发生漂移。
      throw new WorkflowProjectorError(
        "branch_target_missing",
        `步骤 "${currentStep.id}" 将 exit "${input.exit}" 映射到步骤 "${branchTargetId}"，但规范 ${spec.id}@${spec.version} 中不存在该步骤。请重新验证规范文件。`,
        { instanceId: instance.instanceId, stepId: currentStep.id, exit: input.exit, branchTargetId },
      );
    }
    // 结构化 handoff 或任何已映射到分支的 exit 都会触发路由（这是 WF-2 唯一的引擎扩展：
    // 语言驱动的路由仍经过同一个事务式记录器）。
    const willRoute = branchRouted || input.exit === "handoff";

    // FR-5 (G3)：waiting replay 的吸收检查。`waiting` 会特意把已关闭 packet 保留在
    // frontier 上，因此重放 waiting project 能通过 frontier guard；在本切片之前，这会重复
    // 写入 trail。吸收逻辑按 guard 批准的完整关闭意图标识（G-WF1-1）堵住这个缺口：只有
    // 所有会改变可观察 queue/trail/decision 状态的字段都与已存储决策完全一致时，才吸收
    // replay（零写入，并返回首次存储的 outcome）。任何不一致都表示新的合法决策
    //（使用新原因再次 park），应由下方普通写入路径如实记录，既不吸收也不拒绝。终态 exit
    // 的 replay 仍由上方独立的 frontier 409 处理（FR-1c）。
    if (input.exit === "waiting" && instance.status === "waiting") {
      const absorbed = matchesStoredWaitingDecision(
        instance,
        input,
        currentStep.id,
        this.trailLog,
      );
      if (absorbed) {
        return {
          instance,
          closurePriorPacketId: input.currentPacketId,
          closureReason: "waiting",
          nextQitemId: null,
          nextOwnerSession: null,
          nextStepId: null,
          emittedEventTypes: [],
          absorbedReplay: true,
        };
      }
    }

    // FR-6 (G4)：在投影时强制执行 loop_guards.max_hops，使迁移 034 中“在投影时执行”的
    // 注释名副其实。会超过 guard 的 handoff 转为如实的结构化失败：packet 仍会关闭
    //（BR-3 形状），实例失败且 trail 与事件证据都会记录 guard，不创建下一个 qitem；绝不
    // 形成无限跳转、静默停止或搁置的烫手山芋。owner 请求的 exit 已在上方按
    // allowed_exits 验证；下方转换由引擎生成（执行 guard），不是 owner exit，因此刻意绕过
    // allowed_exits。比较使用有效 baseline（arch N1）：v1 固定 baseline =
    // MAX_HOPS_BASELINE_V1 (0)；WF-5 FR-4 的 resume 后续会调整 baseline，让每次重新驱动
    // 都有一个有界窗口。OPR.0.4.6.WF2：任何路由（结构化 handoff 或映射到分支的 exit）
    // 都会触发 guard——分支边会形成规范的修复循环，而推进就是推进。guard 优先于分支
    // 解析生效：触发 guard 后得到终结且如实的失败，绝不会再路由到分支。
    const maxHops = spec.loop_guards?.max_hops;
    // OPR.0.4.6.WF5 FR-4（活锁护栏）：baseline 取实例记录的 hops_baseline——从未
    // resume 的实例为 0（与 v1 常量逐字节一致），重新驱动后则为 resume 时的 hopCount，
    // 因此每次获准的驱动都恰好得到一个有界窗口。
    const maxHopsTripped =
      willRoute &&
      exceedsMaxHops(instance.hopCount, instance.hopsBaseline ?? MAX_HOPS_BASELINE_V1, maxHops);
    const effectiveExit: WorkflowExitKind = maxHopsTripped ? "failed" : input.exit;
    const effectiveResultNote = maxHopsTripped
      ? `max_hops_exceeded: 第 ${instance.hopCount + 1} 跳将超过 loop_guards.max_hops=${maxHops}`
      : input.resultNote;
    // 只有未触发 guard 时才真正执行路由。
    const routes = willRoute && !maxHopsTripped;
    let effectiveClosureEvidence = maxHopsTripped
      ? {
          ...(input.closureEvidence ?? {}),
          max_hops_guard: {
            code: "max_hops_exceeded",
            maxHops,
            hopCount: instance.hopCount,
            attemptedHop: instance.hopCount + 1,
          },
        }
      : input.closureEvidence;
    // OPR.0.4.6.WF2 FR-1（arch PIN 1）：所选分支以增量方式记录在 trail 行的结构化
    // evidence JSON（以及下方 last_continuation_decision）中，绝不写入 closure_reason
    //（它是封闭的阶段 A 枚举，并维持 hot-potato 契约）。
    if (routes && branchRouted && nextStep) {
      effectiveClosureEvidence = {
        ...(effectiveClosureEvidence ?? {}),
        branch_taken: { exit: input.exit, target: nextStep.id },
      };
    }

    const evaluatedAt = this.now().toISOString();

    // OPR.0.4.6.FAC1：绑定工作组的解析上下文采用惰性求值（构建时不读取任何内容；只有
    // tier-3 role 解析实际执行时才实体化快照，而这严格晚于上方 frontier 与吸收 guard
    // 对 replay 的返回/抛错，因此从结构上保证 guard B1 的 replay 零 inventory 读取约束）。
    // 未绑定实例为 undefined（它们不存在 tier 3）。
    const roleCtx = roleResolutionContext(this.db, instance.boundRig);

    let nextQitemId: string | null = null;
    let nextOwnerSession: string | null = null;
    let nextStepId: string | null = null;
    type PostCommitNudge = { destinationSession: string; nudge: boolean | undefined };
    let nextQitemCreatePostCommit: PostCommitNudge | null = null;
    // OPR.0.4.6.WF5 FR-2 class (a)：异常条目的提交后提醒（交付采用尽力而为策略，
    // 持久条目才是保证）。
    let exceptionItemPostCommit: (PostCommitNudge & { qitemId: string }) | null = null;
    const persistedEvents: PersistedEvent[] = [];
    this.eventBus.withNotifyEnvelope((register) => {
      const registerEvent = (event: PersistedEvent): void => {
        persistedEvents.push(event);
        register(event);
      };
      // 1. 在关闭旧 packet 前解析下一位 owner，以便设置 closure_target。
      // OPR.0.4.6.WF2：任何路由（结构化 handoff 或映射到分支的 exit）都会解析 owner。
      // 带 gate 的目标步骤编译为 gate 目标，而不是步骤的 role owner（FR-5）。
      let resolvedNextOwner: string | null = null;
      let gateCompile: GateCompileResult | null = null;
      if (routes) {
        if (!nextStep) {
          throw new WorkflowProjectorError(
            "no_next_step",
            `工作流实例 ${instance.instanceId} 已到达终结步骤 "${currentStep.id}"，但 exit 为 handoff；终结步骤请使用 exit=done，或在规范中添加下一步骤`,
            { instanceId: instance.instanceId, currentStepId: currentStep.id },
          );
        }
        if (nextStep.gate) {
          gateCompile = compileGate(spec, nextStep, (s) => this.nodeRuntimeOf(s), roleCtx);
          resolvedNextOwner = gateCompile.destinationSession;
        } else if (input.nextOwnerSession) {
          reconcileExplicitOwnerHarness(nextStep, input.nextOwnerSession, (s) =>
            this.nodeRuntimeOf(s),
          );
          resolvedNextOwner = input.nextOwnerSession;
        } else {
          const owner = resolveDefaultOwner(spec, nextStep, (s) => this.nodeRuntimeOf(s), roleCtx);
          if (!owner) {
            throw new WorkflowProjectorError(
              "next_owner_unresolved",
              `无法解析步骤 "${nextStep.id}"（role "${nextStep.actor_role}"）的下一位 owner；请显式提供 nextOwnerSession，或在规范中为该 role 添加 preferred_targets`,
              { instanceId: instance.instanceId, nextStepId: nextStep.id, nextRole: nextStep.actor_role },
            );
          }
          resolvedNextOwner = owner;
        }
      }

      // 2. R1 修复（guard blocker 1）：通过阶段 A 的 QueueRepository.updateWithinTransaction
      // 关闭当前 packet。它会验证关闭操作（阶段 A hot-potato 严格拒绝不变量）、持久化关闭
      // 元数据（closure_reason、closure_target、handed_off_to / blocked_on）、追加
      // queue_transitions 并发出 queue.updated；所有操作都在此外层事务中，阶段 A 的关闭
      // 权限保持不变。
      const closure = workflowExitToQueueClosure(
        { ...input, exit: effectiveExit, resultNote: effectiveResultNote },
        resolvedNextOwner,
      );
      const queueUpdate = this.queueRepo.updateWithinTransaction({
        qitemId: input.currentPacketId,
        actorSession: input.actorSession,
        viaWorkflowVerb: true,
        state: closure.state,
        closureReason: closure.closureReason,
        closureTarget: closure.closureTarget ?? undefined,
        handedOffTo: closure.handedOffTo,
        blockedOn: closure.blockedOn,
        transitionNote: closure.transitionNote,
        wakeMaxSeconds: effectiveExit === "waiting" && !routes ? currentStep.re_present_max_seconds : undefined,
        wakeProgressEvidence: input.closureEvidence,
        wakeAfterSeconds:
          effectiveExit === "waiting" && !routes
            ? currentStep.re_present_after_seconds
            : undefined,
        wakeMessage:
          effectiveExit === "waiting" && !routes && currentStep.re_present_after_seconds !== undefined
            ? workflowWaitWakeMessage({
                spec,
                instance,
                step: currentStep,
                packetId: input.currentPacketId,
                ownerSession: currentPacket.destinationSession,
              })
            : undefined,
      });
      registerEvent(queueUpdate.persistedEvent);

      // 3. 若本次关闭会路由（结构化 handoff 或映射到分支的 exit），则在同一事务中创建
      // 下一步骤 qitem。带 gate 的目标会编译为 gate 条目（FR-5），走已经发布的写入路径
      //（tier/summary/evidence_ref），而不是普通步骤 packet；随后实例进入 park 状态
      //（见下方状态阶梯）。
      let createdNext: { qitemId: string; persistedEvent: PersistedEvent; destinationSession: string; nudge: boolean | undefined } | null = null;
      if (routes && nextStep && resolvedNextOwner) {
        nextOwnerSession = resolvedNextOwner;
        nextStepId = nextStep.id;
        // OPR.0.4.6.FAC1（架构认可）：增量 owner_resolution trail 证据记录由哪个 tier
        // 解析本次路由决策（沿用 branch_taken 先例；写入结构化 evidence JSON，绝不写入
        // closure_reason），让确定性证明可读，并为 trace 提供展示单元。
        effectiveClosureEvidence = {
          ...(effectiveClosureEvidence ?? {}),
          owner_resolution: {
            mode: gateCompile
              ? "gate"
              : input.nextOwnerSession
                ? "explicit"
                : (spec.roles?.[nextStep.actor_role]?.preferred_targets ?? []).length > 0
                  ? "preferred_targets"
                  : "role",
            role: nextStep.actor_role,
            ...(instance.boundRig ? { boundRig: instance.boundRig } : {}),
            seat: resolvedNextOwner,
          },
        };
        // OPR.0.4.6.WF5 FR-1 class (c)（guard code-review fold）：到达 HUMAN gate 本身
        // 就是异常，而 WF-2 编译出的条目就是 attention item（绝不再创建第二个条目），因此
        // class-(c) 异常身份随此 packet 的 tags 一并保存。packet ID 预先分配，使
        // occurrence:<gatePacketId> 从创建时就存在（出生即可查询身份——arch cell-2）。
        // handler-role gate 保持反例语义（确定性交接，而非异常）。
        const nextPacketId = newQitemId();
        const gateException =
          gateCompile
            ? classifyGateTrip({
                workflowName: instance.workflowName,
                instanceId: instance.instanceId,
                gatedStepId: nextStep.id,
                gateKind: gateCompile.kind,
                gatePacketId: nextPacketId,
                parkOn: gateCompile.parkOn,
              })
            : null;
        // P34（site :466，ROUTES 分支）：stage 调用紧跟在下方 create 之后；参见事务末尾
        // 的 seam 断言。
        createdNext = this.queueRepo.createWithinTransaction({
          qitemId: nextPacketId,
          sourceSession: input.actorSession,
          destinationSession: resolvedNextOwner,
          body: workflowHandoffBody({
            library: this.guidanceLibrary,
            spec,
            instance,
            currentStep,
            nextStep,
            actorSession: input.actorSession,
            resultNote: effectiveResultNote,
            gate: gateCompile,
            packetId: nextPacketId,
            ownerSession: resolvedNextOwner,
          }),
          priority: "routine",
          tier: gateCompile?.tier ?? "mode2",
          tags: [
            "workflow",
            gateCompile ? "gate" : "handoff",
            `workflow:${spec.id}`,
            `instance:${instance.instanceId}`,
            ...(gateException ? workflowExceptionTags(gateException.identity).filter((t) => !t.startsWith("workflow:") && !t.startsWith("instance:")) : []),
          ],
          summary: gateCompile?.summary ?? undefined,
          evidenceRef: gateCompile?.evidenceRef ?? undefined,
          chainOfRecord: [input.currentPacketId],
        });
        nextQitemId = createdNext.qitemId;
        nextQitemCreatePostCommit = {
          destinationSession: createdNext.destinationSession,
          nudge: createdNext.nudge,
        };
        // P34：在本事务中暂存下一步骤 packet 的 wake intent，使关闭与持久唤醒要么同时
        // 发生，要么都不发生。
        this.queueRepo.stageWakeIntent(
          createdNext.qitemId,
          input.actorSession,
          createdNext.destinationSession,
          null,
          createdNext.nudge,
        );
        // OPR.0.4.6.WF2 FR-5（guard blocker 1）：HUMAN gate packet 在同一事务中
        // park——state=blocked、blocked_on=<human seat>——这正是已发布的
        // `zrig queue resolve` 动词操作的第一段形状（validateHumanPark 在此再次强制执行
        // create 所携带的 summary + evidence_ref）。resolve 后解除 park，让步骤 owner 恢复。
        if (gateCompile?.parkOn) {
          const parked = this.queueRepo.updateWithinTransaction({
            qitemId: createdNext.qitemId,
            actorSession: input.actorSession,
            state: "blocked",
            closureReason: "blocked_on",
            closureTarget: gateCompile.parkOn,
            blockedOn: gateCompile.parkOn,
            transitionNote: `工作流 gate：已停放到 ${gateCompile.parkOn}，等待确认`,
          });
          registerEvent(parked.persistedEvent);
        }
      }

      // OPR.0.4.6.WF1 FR-1 证明接缝（ACK Rev-2，经 reviewer 认可的形状）：在事务内部，
      // queue 关闭/创建下一 qitem 与追加 trail 之间设置一个由环境变量控制的暂停，为
      // fr1-midtxn-process-kill VM 证明提供确定性的窗口，使其能在事务中途 SIGKILL daemon。
      // 默认关闭/缺失时零影响（仅供测试，生产环境绝不设置）。按设计同步执行，因为
      // better-sqlite3 事务是同步的。
      const holdMs = Number(process.env.OPENRIG_TEST_WF_TXN_HOLD_MS ?? 0);
      if (holdMs > 0) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
      }

      // 4. 追加步骤 trail 条目（前一个和下一个 ID）。
      this.trailLog.record({
        instanceId: instance.instanceId,
        stepId: currentStep.id,
        stepRole: currentStep.actor_role,
        closedAt: evaluatedAt,
        closureReason: effectiveExit,
        closureEvidence: effectiveClosureEvidence ?? null,
        actorSession: input.actorSession,
        nextQitemId,
        priorQitemId: input.currentPacketId,
      });

      // 5. 更新实例 frontier 与 status。
      // R1 修复（guard blocker 2b）：exit=waiting 时，把已关闭 packet 保留在 frontier。
      // workflow-keepalive 会把 waiting 视为 eligible，并根据 current_frontier_json 解析
      // owner；移除 packet 会让只有一个 packet 的 waiting 工作流没有可唤醒的 owner。
      const remainingFrontier = instance.currentFrontier.filter(
        (id) => id !== input.currentPacketId,
      );
      let nextFrontier: string[];
      if (nextQitemId) {
        // OPR.0.4.6.WF2：已路由的关闭（结构化 handoff 或映射到分支的 exit，包括映射后的
        // `waiting`）会把 frontier 移到新 packet。此分支优先检查，使映射后的 waiting 执行
        // 路由，而不是再次 park 已关闭 packet。
        nextFrontier = [...remainingFrontier, nextQitemId];
      } else if (effectiveExit === "waiting") {
        // 未路由的 waiting：把已关闭 packet 留在 frontier，watchdog 据此唤醒 owner。
        nextFrontier = [...remainingFrontier, input.currentPacketId];
      } else {
        nextFrontier = remainingFrontier;
      }
      // R1 修复（guard blocker 2a）：exit=failed 时设置 status=failed，而不是 completed；
      // 发出 workflow.failed，而非 workflow.completed。OPR.0.4.6.WF2：已路由的关闭会让实例
      // 保持 ACTIVE 并绑定到路由目标（分支执行契约）；若目标步骤带 GATE，则实例如实停放在
      // gate 条目的 `waiting` 状态，直到 resolve/close 使其继续。未路由的 exit 与当前已发布
      // 的状态阶梯逐字节一致。
      let nextStatus: WorkflowInstance["status"];
      let completedAt: string | null = null;
      if (routes) {
        nextStatus = gateCompile ? "waiting" : "active";
      } else if (effectiveExit === "waiting") {
        nextStatus = "waiting";
      } else if (effectiveExit === "failed") {
        nextStatus = "failed";
        completedAt = evaluatedAt;
      } else if (nextFrontier.length === 0) {
        nextStatus = "completed";
        completedAt = evaluatedAt;
      } else {
        nextStatus = "active";
      }
      // R2 修复：设置持久化的 current_step_id 转换。
      //   已路由（handoff 或 branch）→ 路由目标步骤
      //   waiting（未路由）         → 保留（在相同 packet/step 上 resume）
      //   done / failed（未路由）   → 清除（终态）
      let currentStepIdUpdate: "preserve" | "clear" | string;
      if (routes && nextStep) {
        currentStepIdUpdate = nextStep.id;
      } else if (effectiveExit === "waiting") {
        currentStepIdUpdate = "preserve";
      } else {
        // done 或 failed
        currentStepIdUpdate = "clear";
      }
      this.instanceStore.updateFrontier(instance.instanceId, nextFrontier, nextStatus, {
        // 分支路由就是一次推进（arch PIN 2）：与线性路径遵循相同规则，递增 hop count
        // 和 FR-5 version guard。
        bumpHopCount: routes,
        lastContinuationDecision: {
          exit: effectiveExit,
          actorSession: input.actorSession,
          closedPacket: input.currentPacketId,
          nextPacket: nextQitemId,
          resultNote: effectiveResultNote ?? null,
          blockedOn: input.blockedOn ?? null,
          currentStep: currentStep.id,
          // OPR.0.4.6.WF2 FR-1（arch PIN 1）：增量 branch-taken 记录；所有非分支关闭
          // 都为 null。
          branchTaken: routes && branchRouted && nextStep ? nextStep.id : null,
        },
        completedAt,
        currentStepId: currentStepIdUpdate,
        // FR-5：乐观并发 guard——只有从本次读取后没有其他 writer 推进实例时才提交写入；
        // 过期 writer 会抛出 instance_version_conflict，并回滚整个记录器事务。
        expectedVersion: instance.version,
      });

      // 5b. OPR.0.4.6.WF1 FR-3：在记录器事务内启用/停用 keepalive。handoff 保证
      // per-instance job 已启用（幂等，并在升级后的第一次 hop 修复 WF-1 之前的实例）；终态
      // 会将其停用，避免孤立 watchdog 噪声。waiting 在阻塞期间让 deadline-gated job 保持
      // 启用但静默；规范声明的再次提醒规则使用上方独立的一次性 park timer。这里只执行
      // 普通 INSERT/UPDATE，已经验证可以组合进事务。
      if (this.watchdogJobsRepo) {
        if (routes && resolvedNextOwner) {
          // 任何路由都会为新 owner 启用 keepalive，包括 gate park；其交付提醒由 queue wake
          // intent 处理。
          ensureWorkflowKeepaliveArmed(this.watchdogJobsRepo, {
            instanceId: instance.instanceId,
            targetSession: resolvedNextOwner,
            registeredBySession: input.actorSession,
          });
        } else if (nextStatus === "completed" || nextStatus === "failed") {
          disarmWorkflowKeepalive(
            this.watchdogJobsRepo,
            instance.instanceId,
            `workflow_${nextStatus}`,
          );
        }
      }

      // 6. 在同一事务内持久化工作流事件。
      registerEvent(
        this.eventBus.persistWithinTransaction({
          type: "workflow.step_closed",
          instanceId: instance.instanceId,
          stepId: currentStep.id,
          closureReason: effectiveExit,
          actorSession: input.actorSession,
          priorQitemId: input.currentPacketId,
        }),
      );
      if (createdNext && nextStep && resolvedNextOwner) {
        registerEvent(createdNext.persistedEvent);
        registerEvent(
          this.eventBus.persistWithinTransaction({
            type: "workflow.next_qitem_projected",
            instanceId: instance.instanceId,
            nextQitemId: createdNext.qitemId,
            nextOwner: createdNext.destinationSession,
            nextStepId: nextStep.id,
          }),
        );
      }
      if (nextStatus === "completed") {
        registerEvent(
          this.eventBus.persistWithinTransaction({
            type: "workflow.completed",
            instanceId: instance.instanceId,
            workflowName: instance.workflowName,
          }),
        );
      } else if (nextStatus === "failed") {
        registerEvent(
          this.eventBus.persistWithinTransaction({
            type: "workflow.failed",
            instanceId: instance.instanceId,
            workflowName: instance.workflowName,
            reason: effectiveResultNote ?? "workflow_step_failed",
          }),
        );
        exceptionItemPostCommit = this.admitFailureException(
          input, instance, spec, currentStep, effectiveResultNote ?? null, registerEvent,
        );
      }

      // P34：W1 接缝，也是本事务的最后一条语句。两个后继分支互斥：
      // nextStatus==="failed" 要求 routes===false（参见上方状态阶梯），因此 :466 与 :729
      // 在同一次执行中是二选一，而不是两个后继；每个分支都单独断言。park（`waiting`）或无
      // 后继的关闭不会进入任一分支：原语本身会在非终态 source 上提前返回，而无后继的关闭
      // 也没有需要持久化的 wake。
      const excStaged = exceptionItemPostCommit as (PostCommitNudge & { qitemId: string }) | null;
      if (createdNext) {
        this.queueRepo.assertTerminalClosureHasIntent(
          input.currentPacketId,
          createdNext.qitemId,
          createdNext.nudge,
        );
      } else if (excStaged) {
        this.queueRepo.assertTerminalClosureHasIntent(
          input.currentPacketId,
          excStaged.qitemId,
          excStaged.nudge,
        );
      }
    });

    // OPR.0.4.6.WF5 FR-2：异常条目使用尽力而为的提醒（已发布的非致命交付模式——持久
    // 条目才是保证，提醒只是辅助）。P34：两种交付都经过共享的 staged-intent 路径，由它
    // 认领并完成上方事务暂存的行。maybeNudge 只会发送而不完成，使 intent 保持 `pending`，
    // 启动恢复扫描随后会重复交付。若未挂接 intent store，共享路径回退到之前相同的尽力而为
    // 提醒。
    const excPost = exceptionItemPostCommit as (PostCommitNudge & { qitemId: string }) | null;
    if (excPost) {
      await this.queueRepo.deliverWakeForSuccessor(
        excPost.qitemId,
        excPost.destinationSession,
        excPost.nudge,
        input.actorSession,
      );
    }
    const postCommit = nextQitemCreatePostCommit as PostCommitNudge | null;
    if (nextQitemId && postCommit) {
      await this.queueRepo.deliverWakeForSuccessor(
        nextQitemId,
        postCommit.destinationSession,
        postCommit.nudge,
        input.actorSession,
      );
    }

    const updatedInstance = this.instanceStore.getByIdOrThrow(instance.instanceId);
    return {
      instance: updatedInstance,
      closurePriorPacketId: input.currentPacketId,
      closureReason: effectiveExit,
      nextQitemId,
      nextOwnerSession,
      nextStepId,
      emittedEventTypes: persistedEvents.map((e) => e.type),
    };
  }

  /** 两条 executor 路径都会一起提交失败、负责该失败的任务与 wake。调用方仅对未处理失败
   * 调用，绝不用于已映射的 remediation。 */
  private admitFailureException(
    input: ProjectStepInput,
    instance: WorkflowInstance,
    spec: WorkflowSpec,
    currentStep: WorkflowStepSpec,
    failureReason: string | null,
    registerEvent: (event: PersistedEvent) => void,
    occurrenceId?: string,
  ): { qitemId: string; destinationSession: string; nudge: boolean | undefined } {
    const exception = classifyFailureOccurrence({
      instance, failedStepId: currentStep.id, failedPacketId: input.currentPacketId, failureReason,
    });
    const route = resolveExceptionRoute({
      exceptionClass: exception.identity.exceptionClass,
      spec,
      hostDialDefault: this.exceptionDial?.hostDefault() ?? null,
      // FAC-1（arch Q3——有界的路由一致性）：声明的 preferred_targets 仍是覆盖值；绑定
      // 实例的 orchestrator-role 旋钮位置回退到在绑定工作组上按能力选择（有证据的无匹配
      // → 选择已注册 human；无法选择 human 时给出明确错误）。证据读取失败会继续传播并回滚
      // 关闭操作；每次 episode 都重新决策。
      resolveRoleTarget: (role) =>
        spec.roles?.[role]?.preferred_targets?.[0] ??
        tryResolveRoleByCapability(roleResolutionContext(this.db, instance.boundRig), role),
      humanFallbackSeat: this.exceptionDial?.humanFallbackSeat,
    });
    const evidenceRef = `zrig workflow trace ${instance.instanceId}`;
    const itemBody =
      `工作流异常（${exception.identity.exceptionClass}）\n` +
      `工作流：${instance.workflowName} v${instance.workflowVersion}\n` +
      `实例：${instance.instanceId}\n` +
      `步骤：${currentStep.id}（role ${currentStep.actor_role}）\n` +
      `发生项：${input.currentPacketId}\n` +
      `原因：${exception.reason}\n` +
      `证据：${evidenceRef}\n` +
      `解决：先根据上述 trace 诊断，再运行 \`zrig workflow resume ${instance.instanceId}${occurrenceId ? ` --occurrence ${occurrenceId}` : ""} [--decision <text>]\` 从本步骤重新驱动（已完成步骤不会重跑）。`;
    const createExceptionItem = (destination: string, tier: string) =>
      this.queueRepo.createWithinTransaction({
        sourceSession: input.actorSession,
        destinationSession: destination,
        body: itemBody,
        priority: "urgent",
        tier,
        tags: workflowExceptionTags(exception.identity),
        summary: exception.reason,
        evidenceRef,
        chainOfRecord: [input.currentPacketId],
      });
    let createdException;
    try {
      createdException = createExceptionItem(route.destinationSession, route.tier);
    } catch (error) {
      if (!(error instanceof QueueRepositoryError) || error.code !== "unknown_destination_rig" || route.humanRouted) throw error;
      // 只有 agent 工作组不可用时才选择 human；其他 admission/storage 失败原样传播并回滚
      // 关闭操作，保留 failure + attention-item 的原子契约。
      createdException = createExceptionItem(
        workflowHumanDestination(this.exceptionDial?.humanFallbackSeat),
        "human-gate",
      );
    }
    registerEvent(createdException.persistedEvent);
    this.queueRepo.stageWakeIntent(createdException.qitemId, input.actorSession,
      createdException.destinationSession, null, createdException.nudge);
    return { qitemId: createdException.qitemId, destinationSession: createdException.destinationSession, nudge: createdException.nudge };
  }

  private async projectDependencyGraph(args: {
    input: ProjectStepInput;
    instance: WorkflowInstance;
    spec: WorkflowSpec;
    currentStep: WorkflowStepSpec;
    packetBinding: import("./workflow-types.js").WorkflowFrontierBinding;
    currentOwnerSession: string;
  }): Promise<ProjectStepResult> {
    const { input, instance, spec, currentStep, packetBinding, currentOwnerSession } = args;
    if (input.exit === "waiting" && instance.status === "waiting" && matchesStoredWaitingDecision(instance, input, currentStep.id, this.trailLog)) {
      return {
        instance,
        closurePriorPacketId: input.currentPacketId,
        closureReason: "waiting",
        nextQitemId: null,
        nextOwnerSession: null,
        nextStepId: null,
        nextQitemIds: [],
        nextStepIds: [],
        emittedEventTypes: [],
        absorbedReplay: true,
      };
    }

    const mappedTarget = currentStep.next_hop?.on?.[input.exit];
    const completesPrerequisite = input.exit === "done" || input.exit === "handoff";
    const trail = this.trailLog.listForInstance(instance.instanceId, 100_000);
    const completed = new Set(
      trail
        .filter((entry) => entry.closureReason === "done" || entry.closureReason === "handoff")
        .map((entry) => entry.stepId),
    );
    if (completesPrerequisite) completed.add(currentStep.id);

    const liveBindings = this.instanceStore.listFrontierBindings(instance.instanceId);
    const liveStepIds = new Set(liveBindings.map((binding) => binding.stepId));
    const unresolved = this.instanceStore.listFailureOccurrences(instance.instanceId, "unresolved");
    const unresolvedStepIds = new Set(unresolved.map((occurrence) => occurrence.stepId));
    let nextSteps: WorkflowStepSpec[] = [];
    if (mappedTarget) {
      const target = spec.steps.find((step) => step.id === mappedTarget);
      if (!target) {
        throw new WorkflowProjectorError("branch_target_missing", `步骤 "${currentStep.id}" 将 ${input.exit} 映射到不存在的步骤 "${mappedTarget}"`, { instanceId: instance.instanceId, stepId: currentStep.id, mappedTarget });
      }
      nextSteps = [target];
    } else if (completesPrerequisite) {
      nextSteps = spec.steps.filter((candidate) => {
        const dependencies = candidate.depends_on;
        if (!dependencies || dependencies.length === 0) return false;
        if (!dependencies.includes(currentStep.id)) return false;
        if (!dependencies.every((dependency) => completed.has(dependency))) return false;
        if (completed.has(candidate.id) || liveStepIds.has(candidate.id) || unresolvedStepIds.has(candidate.id)) return false;
        return true;
      });
    }

    // 依赖图从每个分支自己的持久绑定推进，因此也必须从该绑定评估活锁窗口；串行路径则对
    // 实例级字段执行相同比较。把触发 guard 的推进转换成普通的分支局部失败形状：如实关闭
    // 本 packet，记录一次可 resume 的 occurrence，不创建后继，并保持无关 frontier packet
    // 不变。
    const maxHops = spec.loop_guards?.max_hops;
    const maxHopsTripped =
      nextSteps.length > 0 &&
      exceedsMaxHops(packetBinding.hopCount, packetBinding.hopsBaseline, maxHops);
    const effectiveExit: WorkflowExitKind = maxHopsTripped ? "failed" : input.exit;
    const effectiveResultNote = maxHopsTripped
      ? `max_hops_exceeded: 第 ${packetBinding.hopCount + 1} 跳将超过 loop_guards.max_hops=${maxHops}`
      : input.resultNote;
    const effectiveClosureEvidence = maxHopsTripped
      ? {
          ...(input.closureEvidence ?? {}),
          max_hops_guard: {
            code: "max_hops_exceeded",
            maxHops,
            hopCount: packetBinding.hopCount,
            attemptedHop: packetBinding.hopCount + 1,
          },
        }
      : input.closureEvidence;
    if (maxHopsTripped) nextSteps = [];
    const isFailureOccurrence = effectiveExit === "failed" && (!mappedTarget || maxHopsTripped);

    const evaluatedAt = this.now().toISOString();
    const emitted: PersistedEvent[] = [];
    let exceptionWake: ReturnType<WorkflowProjector["admitFailureException"]> | null = null;
    const createdPackets: Array<{ qitemId: string; step: WorkflowStepSpec; owner: string; nudge: boolean | undefined; blocked: boolean }> = [];
    this.eventBus.withNotifyEnvelope((register) => {
      const addEvent = (event: PersistedEvent): void => { emitted.push(event); register(event); };
      const ownerPlans = nextSteps.map((step) => {
        const gate = step.gate
          ? compileGate(spec, step, (session) => this.nodeRuntimeOf(session), roleResolutionContext(this.db, instance.boundRig))
          : null;
        const owner = gate?.destinationSession ?? resolveDefaultOwner(spec, step, (session) => this.nodeRuntimeOf(session), roleResolutionContext(this.db, instance.boundRig));
        if (!owner) {
          throw new WorkflowProjectorError("next_owner_unresolved", `无法解析依赖步骤 "${step.id}" 的下一位 owner`, { instanceId: instance.instanceId, stepId: step.id });
        }
        return { step, gate, owner, packetId: newQitemId() };
      });

      const closureOwner = ownerPlans.length === 1 ? ownerPlans[0]!.owner : null;
      const closure = effectiveExit === "handoff" && ownerPlans.length !== 1
        ? {
            state: "done" as const,
            closureReason: "no-follow-on",
            closureTarget: null,
            transitionNote: `工作流图：${input.actorSession} 已完成 ${currentStep.id}；以事务方式投影了 ${ownerPlans.length} 个后继`,
          }
        : workflowExitToQueueClosure(
            { ...input, exit: effectiveExit, resultNote: effectiveResultNote },
            closureOwner,
          );
      const updated = this.queueRepo.updateWithinTransaction({
        qitemId: input.currentPacketId,
        actorSession: input.actorSession,
        viaWorkflowVerb: true,
        state: closure.state,
        closureReason: closure.closureReason,
        closureTarget: closure.closureTarget ?? undefined,
        handedOffTo: closure.handedOffTo,
        blockedOn: closure.blockedOn,
        transitionNote: closure.transitionNote,
        wakeMaxSeconds: effectiveExit === "waiting" && ownerPlans.length === 0 ? currentStep.re_present_max_seconds : undefined,
        wakeProgressEvidence: input.closureEvidence,
        wakeAfterSeconds:
          effectiveExit === "waiting" && ownerPlans.length === 0
            ? currentStep.re_present_after_seconds
            : undefined,
        wakeMessage:
          effectiveExit === "waiting" && ownerPlans.length === 0 && currentStep.re_present_after_seconds !== undefined
            ? workflowWaitWakeMessage({
                spec,
                instance,
                step: currentStep,
                packetId: input.currentPacketId,
                ownerSession: currentOwnerSession,
              })
            : undefined,
      });
      addEvent(updated.persistedEvent);

      if (effectiveExit !== "waiting") {
        this.instanceStore.removeFrontierBinding(instance.instanceId, input.currentPacketId);
        if (this.watchdogJobsRepo) {
          disarmWorkflowKeepalive(
            this.watchdogJobsRepo,
            instance.instanceId,
            `workflow_packet_${effectiveExit}`,
            input.currentPacketId,
          );
        }
      }

      for (const plan of ownerPlans) {
        const created = this.queueRepo.createWithinTransaction({
          qitemId: plan.packetId,
          sourceSession: input.actorSession,
          destinationSession: plan.owner,
          body: workflowHandoffBody({
            library: this.guidanceLibrary,
            spec,
            instance,
            currentStep,
            nextStep: plan.step,
            actorSession: input.actorSession,
            resultNote: effectiveResultNote,
            gate: plan.gate,
            packetId: plan.packetId,
            ownerSession: plan.owner,
          }),
          priority: "routine",
          tier: plan.gate?.tier ?? "mode2",
          tags: ["workflow", plan.gate ? "gate" : "handoff", `workflow:${spec.id}`, `instance:${instance.instanceId}`, `step:${plan.step.id}`],
          summary: plan.gate?.summary ?? undefined,
          evidenceRef: plan.gate?.evidenceRef ?? undefined,
          chainOfRecord: [input.currentPacketId],
        });
        addEvent(created.persistedEvent);
        this.queueRepo.stageWakeIntent(created.qitemId, input.actorSession, created.destinationSession, null, created.nudge);
        if (plan.gate?.parkOn) {
          const parked = this.queueRepo.updateWithinTransaction({
            qitemId: created.qitemId,
            actorSession: input.actorSession,
            state: "blocked",
            closureReason: "blocked_on",
            closureTarget: plan.gate.parkOn,
            blockedOn: plan.gate.parkOn,
            transitionNote: `工作流 gate：已停放到 ${plan.gate.parkOn}，等待确认`,
          });
          addEvent(parked.persistedEvent);
        }
        this.instanceStore.bindFrontierPacket({
          instanceId: instance.instanceId,
          packetId: created.qitemId,
          stepId: plan.step.id,
          branchDrive: packetBinding.branchDrive + (ownerPlans.length > 1 ? 1 : 0),
          hopCount: packetBinding.hopCount + 1,
          hopsBaseline: packetBinding.hopsBaseline,
        });
        if (this.watchdogJobsRepo) {
          ensureWorkflowKeepaliveArmed(this.watchdogJobsRepo, {
            instanceId: instance.instanceId,
            packetId: created.qitemId,
            targetSession: plan.owner,
            registeredBySession: input.actorSession,
          });
        }
        createdPackets.push({ qitemId: created.qitemId, step: plan.step, owner: plan.owner, nudge: created.nudge, blocked: Boolean(plan.gate?.parkOn) });
        addEvent(this.eventBus.persistWithinTransaction({ type: "workflow.next_qitem_projected", instanceId: instance.instanceId, nextQitemId: created.qitemId, nextOwner: plan.owner, nextStepId: plan.step.id }));
      }

      if (isFailureOccurrence) {
        this.instanceStore.recordFailureOccurrence({
          instanceId: instance.instanceId,
          failedPacketId: input.currentPacketId,
          stepId: currentStep.id,
          branchDrive: packetBinding.branchDrive,
          hopCount: packetBinding.hopCount,
          hopsBaseline: packetBinding.hopsBaseline,
          failureReason: effectiveResultNote ?? null,
        });
        exceptionWake = this.admitFailureException(
          input, instance, spec, currentStep, effectiveResultNote ?? null, addEvent, input.currentPacketId,
        );
      }

      const remainingFrontier = instance.currentFrontier.filter((packetId) => packetId !== input.currentPacketId);
      const nextFrontier = effectiveExit === "waiting"
        ? [...remainingFrontier, input.currentPacketId]
        : [...remainingFrontier, ...createdPackets.map((packet) => packet.qitemId)];
      const unresolvedCount = this.instanceStore.listFailureOccurrences(instance.instanceId, "unresolved").length;
      const packetRows = nextFrontier.map((packetId) => this.queueRepo.getById(packetId));
      const nextStatus: WorkflowInstance["status"] = nextFrontier.length > 0
        ? packetRows.every((packet) => packet?.state === "blocked") ? "waiting" : "active"
        : unresolvedCount > 0 ? "failed" : "completed";
      const nextBindings = this.instanceStore.listFrontierBindings(instance.instanceId);
      const singletonStep = nextBindings.length === 1 ? nextBindings[0]!.stepId : null;
      this.instanceStore.updateFrontier(instance.instanceId, nextFrontier, nextStatus, {
        bumpHopCount: createdPackets.length > 0,
        currentStepId: singletonStep ?? "clear",
        expectedVersion: instance.version,
        completedAt: nextStatus === "completed" || nextStatus === "failed" ? evaluatedAt : null,
        lastContinuationDecision: {
          exit: effectiveExit,
          actorSession: input.actorSession,
          closedPacket: input.currentPacketId,
          currentStep: currentStep.id,
          nextPackets: createdPackets.map((packet) => packet.qitemId),
        },
      });
      this.trailLog.record({
        instanceId: instance.instanceId,
        stepId: currentStep.id,
        stepRole: currentStep.actor_role,
        closedAt: evaluatedAt,
        closureReason: effectiveExit,
        closureEvidence: { ...(effectiveClosureEvidence ?? {}), next_qitem_ids: createdPackets.map((packet) => packet.qitemId) },
        actorSession: input.actorSession,
        nextQitemId: createdPackets[0]?.qitemId ?? null,
        priorQitemId: input.currentPacketId,
      });
      addEvent(this.eventBus.persistWithinTransaction({ type: "workflow.step_closed", instanceId: instance.instanceId, stepId: currentStep.id, closureReason: effectiveExit, actorSession: input.actorSession, priorQitemId: input.currentPacketId }));
      if (nextStatus === "completed") {
        addEvent(this.eventBus.persistWithinTransaction({ type: "workflow.completed", instanceId: instance.instanceId, workflowName: instance.workflowName }));
      } else if (nextStatus === "failed") {
        addEvent(this.eventBus.persistWithinTransaction({ type: "workflow.failed", instanceId: instance.instanceId, workflowName: instance.workflowName, reason: effectiveResultNote ?? "workflow_step_failed" }));
      }
      if (exceptionWake) this.queueRepo.assertTerminalClosureHasIntent(
        input.currentPacketId, exceptionWake.qitemId, exceptionWake.nudge,
      );
    });

    const failureWake = exceptionWake as ReturnType<WorkflowProjector["admitFailureException"]> | null;
    if (failureWake) await this.queueRepo.deliverWakeForSuccessor(
      failureWake.qitemId, failureWake.destinationSession, failureWake.nudge, input.actorSession,
    );
    for (const created of createdPackets) {
      await this.queueRepo.deliverWakeForSuccessor(created.qitemId, created.owner, created.nudge, input.actorSession);
    }
    return {
      instance: this.instanceStore.getByIdOrThrow(instance.instanceId),
      closurePriorPacketId: input.currentPacketId,
      closureReason: effectiveExit,
      nextQitemId: createdPackets[0]?.qitemId ?? null,
      nextOwnerSession: createdPackets[0]?.owner ?? null,
      nextStepId: createdPackets[0]?.step.id ?? null,
      nextQitemIds: createdPackets.map((packet) => packet.qitemId),
      nextStepIds: createdPackets.map((packet) => packet.step.id),
      emittedEventTypes: emitted.map((event) => event.type),
    };
  }
}

/**
 * OPR.0.4.6.WF1 FR-5（G-WF1-1，经 guard 批准）：用于吸收 waiting replay 的完整
 * 关闭意图标识谓词。每个可能改变可观察 queue/trail/decision 状态的字段都必须与已存储
 * 决策完全一致：
 *   exit=waiting · closedPacket · currentStep · actorSession ·
 *   resultNote（null 等同缺失）· blockedOn（比较前规范化为有效 blocker，即应用已发布的
 *   `external-gate` 默认值，见 workflowExitToQueueClosure:waiting）·
 *   closureEvidence（与已存储 TRAIL 行中的 evidence 深度相等，因为证据写在那里）。
 * 另外还要求 instance.status === waiting（由调用方检查）。
 */
function matchesStoredWaitingDecision(
  instance: WorkflowInstance,
  input: ProjectStepInput,
  currentStepId: string,
  trailLog: WorkflowStepTrailLog,
): boolean {
  const stored = instance.lastContinuationDecision;
  if (!stored) return false;
  if (stored.exit !== "waiting") return false;
  if (stored.closedPacket !== input.currentPacketId) return false;
  if (stored.currentStep !== currentStepId) return false;
  if (stored.actorSession !== input.actorSession) return false;
  const storedNote = (stored.resultNote as string | null | undefined) ?? null;
  const inputNote = input.resultNote ?? null;
  if (storedNote !== inputNote) return false;
  const storedBlocker =
    ((stored.blockedOn as string | null | undefined) ?? null) ?? "external-gate";
  const inputBlocker = input.blockedOn ?? "external-gate";
  if (storedBlocker !== inputBlocker) return false;
  // closureEvidence 写入 trail 行，而不是 decision；应与此 packet 最近一次 waiting 关闭比较。
  const trail = trailLog.listForInstance(instance.instanceId);
  const storedRow = trail.find(
    (t) => t.priorQitemId === input.currentPacketId && t.closureReason === "waiting",
  );
  if (!storedRow) return false;
  return isDeepEqual(storedRow.closureEvidence ?? null, input.closureEvidence ?? null);
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) =>
    isDeepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ),
  );
}

/**
 * R2 修复（guard blocker 1）：从持久化的 instance.currentStepId 解析当前步骤，而不是
 * 根据 trail 顺序推断。此前基于 trail 的推断会对复用 frontier 的 packet 产生错误结果：
 * waiting → 在同一 packet 上 resume 会跳过一个步骤，因为 waiting 关闭写入的 trail 行会被
 * 下一次推断视为“最后步骤 + 1”。
 *
 * 仅在 current_step_id 为 null 时回退到入口步骤（instantiate 未设置它；这是纵深防御，
 * 不是生产路径）。
 *
 * 多活动 frontier 实例（并行步骤）留待后续演进；v1 只支持一个活动 frontier packet，
 * 因而一个 current_step_id 列已经足够。
 */
function resolveCurrentStep(
  spec: WorkflowSpec,
  instance: WorkflowInstance,
): WorkflowStepSpec | null {
  if (instance.currentStepId) {
    return spec.steps.find((s) => s.id === instance.currentStepId) ?? null;
  }
  // 纵深防御：实例缺少 current_step_id，回退到入口步骤（与可能残留的 R2 之前实例一致）。
  const entryRole = spec.entry?.role;
  return (
    spec.steps[0] ??
    (entryRole ? spec.steps.find((s) => s.actor_role === entryRole) ?? null : null) ??
    null
  );
}

/**
 * 解析下一步骤。OPR.0.4.6.WF2 FR-1：提供 `recordedExit` 且步骤的 `next_hop.on`
 * 映射该值时，以映射目标为准（确定性分支——相同 (spec, step, exit) 每次得到相同目标）。
 * 否则使用结构默认值：先取规范声明的 `next_hop.suggested_roles` 边，再按声明顺序。
 *
 * 导出此函数（OPR.0.4.6.WF1 FR-7）：这是唯一的路由接缝，validator 的可达性/环路分析
 * 直接运行这些语义，绝不平行重写一套。validator 在结构默认路径中不传 exit 调用它，
 * 再显式合并分支边；只有一个路由事实，不产生语义分叉。
 */
export function resolveNextStep(
  spec: WorkflowSpec,
  currentStep: WorkflowStepSpec,
  recordedExit?: WorkflowExitKind,
): WorkflowStepSpec | null {
  const mappedTargetId = recordedExit
    ? currentStep.next_hop?.on?.[recordedExit]
    : undefined;
  if (mappedTargetId !== undefined) {
    return spec.steps.find((s) => s.id === mappedTargetId) ?? null;
  }
  if (currentStep.next_hop?.mode === "forbid") return null;
  for (const role of currentStep.next_hop?.suggested_roles ?? []) {
    const target = spec.steps.find((s) => s.actor_role === role);
    if (target) return target;
  }
  if (currentStep.next_hop?.mode === "require") return null;
  const idx = spec.steps.findIndex((s) => s.id === currentStep.id);
  if (idx === -1) return null;
  return spec.steps[idx + 1] ?? null;
}

/**
 * OPR.0.4.6.FAC1——把一个 ROLE 解析为绑定工作组中存活且具备能力的 seat，否则抛出
 * LOUD-WITH-CANDIDATES（BR-5）。结构化详情携带每个评估过的候选及其命名的不合格原因
 *（`not_live(lifecycleState=x)` / `runtime_mismatch(has≠needs)` /
 * `role_not_declared` / `adopted_seat_not_role_resolvable_v1`），使操作员或 WF-5 异常
 * 编排器能够采取行动；零候选场景有单独命名的消息。在任何副作用之前抛出（:199-221
 * 先验证后变更的规则）；绝不 spawn，绝不 auto-add_member，也绝不路由到 dead seat。
 */
function resolveRoleOnBoundRig(
  roleName: string,
  harness: string | undefined,
  roleCtx: RoleResolutionContext,
  stepId: string,
): string {
  const candidates = roleCtx.candidatesForRig();
  if (candidates === null) {
    throw new WorkflowProjectorError(
      "bound_rig_not_found",
      `无法为步骤 "${stepId}" 解析 role "${roleName}"：实例绑定的工作组 "${roleCtx.boundRig}" 已无法解析为注册工作组（可能在运行中被拆除）。请使用相同名称重新创建/导入工作组，或实体化一个绑定到其他位置的新运行。`,
      { stepId, role: roleName, boundRig: roleCtx.boundRig },
    );
  }
  const result = selectRoleSeat({ role: roleName, harness, candidates });
  if (result.seat) return result.seat;
  const declaring = result.disqualified.filter((c) => c.facts.role === roleName);
  if (declaring.length === 0) {
    throw new WorkflowProjectorError(
      "next_owner_unresolved",
      `无法为步骤 "${stepId}" 解析 role "${roleName}"（工作组 "${roleCtx.boundRig}" 中没有 seat 声明 role "${roleName}"）。请通过 zrig add 为工作组 ${roleCtx.boundRig} 添加 role 为 ${roleName} 的成员，在已有成员上声明该 role，或在规范中为该 role 添加 preferred_targets。`,
      {
        stepId,
        role: roleName,
        boundRig: roleCtx.boundRig,
        candidates: result.disqualified,
      },
    );
  }
  throw new WorkflowProjectorError(
    "next_owner_unresolved",
    `无法为工作组 "${roleCtx.boundRig}" 上步骤 "${stepId}" 的 role "${roleName}" 解析存活且具备能力的 seat。候选：${declaring
      .map((c) => `${c.coordinate ?? c.logicalId} → ${c.disqualifier}`)
      .join(", ")}。请启动/修复 role seat（参见 zrig ps），通过 zrig add 添加 role 为 ${roleName} 的成员，或为该 role 添加 preferred_targets。`,
    {
      stepId,
      role: roleName,
      boundRig: roleCtx.boundRig,
      candidates: result.disqualified,
    },
  );
}

/**
 * 解析步骤的默认 owner。v1 选择首个声明的 preferred_target。OPR.0.4.6.WF2 FR-2：
 * 带 `harness:` pin 的步骤改为选择节点 runtime 与 pin 匹配的首个 preferred_target；
 * 无匹配时返回结构化路由失败，列出 pin 与每个候选的实际 runtime，绝不静默误路由到错误
 * harness。`runtimeOf` 将规范 session 名解析为节点的 runtime 列（null 表示非受管节点或
 * 未知）。
 *
 * OPR.0.4.6.FAC1：新增可选的绑定工作组上下文，参见函数体内的 tier 注释。tier 顺序
 *（P2-6，偏离时 guard-BLOCKING）：
 *   1. 显式 input.nextOwnerSession（调用方已校准）
 *   2. 编译 gate（调用方先在该处分支）
 *   3. 声明的 preferred_targets——与当前路径逐字节一致
 *   4. 新增：绑定工作组上的 role 能力（仅限无 target 且已绑定）
 *   5. null → 调用方中已发布的 next_owner_unresolved。
 *
 * 仅对未 pin、无 target 且未绑定的场景返回 null（调用方必须显式提供
 * nextOwnerSession，保持 v1 行为不变）。
 */
export function resolveDefaultOwner(
  spec: WorkflowSpec,
  step: WorkflowStepSpec,
  runtimeOf?: (session: string) => string | null,
  /** OPR.0.4.6.FAC1：绑定工作组的解析上下文。仅在已绑定实例的实时解析点（投影下一
   *  步骤、编译 gate、entry、resume）存在，绝不用于 eager instantiate loop
   *  （guard B1：不得提前实时解析未来步骤）。 */
  roleCtx?: RoleResolutionContext,
): string | null {
  const role = spec.roles?.[step.actor_role];
  const targets = role?.preferred_targets ?? [];
  // OPR.0.4.6.FAC1 TIER 3（唯一新增的 tier；顺序不可改变——P2-6）：上方声明的
  // preferred_targets 与当前代码路径逐字节一致，绝不按 liveness/inventory 过滤。仅当
  // role 声明零 target 且实例已绑定到工作组时才启用能力解析。下方未绑定且无 target 的
  // 行为保持逐字节一致（null / "(none declared)"）。
  if (targets.length === 0 && roleCtx) {
    return resolveRoleOnBoundRig(step.actor_role, step.harness, roleCtx, step.id);
  }
  if (!step.harness) return targets[0] ?? null;
  if (!runtimeOf) {
    // 纵深防御：带 pin 的步骤绝不能在不了解 runtime 的情况下解析，否则正是 FR-2 禁止的
    // 静默误路由。生产调用点始终提供 runtimeOf。
    throw new WorkflowProjectorError(
      "harness_pin_unverifiable",
      `步骤 "${step.id}" 固定使用 harness "${step.harness}"，但没有可用于校准的 runtime 查询；拒绝盲目解析 owner。`,
      { stepId: step.id, harness: step.harness },
    );
  }
  const candidates = targets.map((t) => ({ session: t, runtime: runtimeOf(t) }));
  const match = candidates.find((c) => c.runtime === step.harness);
  if (match) return match.session;
  throw new WorkflowProjectorError(
    "harness_pin_unsatisfied",
    `步骤 "${step.id}" 固定使用 harness "${step.harness}"，但 role "${step.actor_role}" 的 preferred_target 均未运行该 harness。候选：${
      candidates.length === 0
        ? "(none declared)"
        : candidates.map((c) => `${c.session} → ${c.runtime ?? "unknown"}`).join(", ")
    }。请向该 role 的 preferred_targets 添加 ${step.harness} seat，或修改/移除 pin。`,
    {
      stepId: step.id,
      harness: step.harness,
      candidates: candidates.map((c) => ({ session: c.session, runtime: c.runtime })),
    },
  );
}

/**
 * OPR.0.4.6.WF2 FR-2：根据步骤的 harness pin 校准显式 owner 覆盖值。若操作员提供的
 * owner 所用 runtime 与 pin 不匹配，则明确拒绝；显式覆盖绝不能静默绕过声明的 pin。
 */
export function reconcileExplicitOwnerHarness(
  step: WorkflowStepSpec,
  explicitOwner: string,
  runtimeOf: (session: string) => string | null,
): void {
  if (!step.harness) return;
  const actual = runtimeOf(explicitOwner);
  if (actual !== step.harness) {
    throw new WorkflowProjectorError(
      "harness_pin_unsatisfied",
      `步骤 "${step.id}" 固定使用 harness "${step.harness}"，但显式提供的 owner ${explicitOwner} 运行 ${actual ?? "未知（非受管节点）"}。请提供 ${step.harness} seat，或修改/移除 pin。`,
      { stepId: step.id, harness: step.harness, explicitOwner, actualRuntime: actual },
    );
  }
}

/**
 * R1 修复（guard blocker 1）：把工作流 exit 转换为阶段 A 的队列关闭形状
 *（state + closure_reason + closure_target + handed_off_to / blocked_on 元数据）。
 * 阶段 A 的 hot-potato 关闭验证会强制执行以下规则：
 *   - state=done 要求 closure_reason 来自 CLOSURE_REASONS
 *   - handed_off_to / blocked_on / escalation 还要求 closure_target
 *
 * 映射：
 *   handoff → state=handed-off，closure_reason=handed_off_to，
 *             closure_target+handed_off_to=<next-owner>
 *   waiting → state=blocked，closure_reason=blocked_on，
 *             closure_target+blocked_on=<blocker>
 *   done    → state=done，closure_reason=no-follow-on
 *   failed  → state=done，closure_reason=denied（工作流 status=failed
 *             单独设置在实例行上）
 */
function workflowExitToQueueClosure(
  input: ProjectStepInput,
  resolvedNextOwner: string | null,
): {
  state: "handed-off" | "blocked" | "done";
  closureReason: string;
  closureTarget: string | null;
  handedOffTo?: string;
  blockedOn?: string;
  transitionNote: string;
} {
  switch (input.exit) {
    case "handoff": {
      if (!resolvedNextOwner) {
        // 纵深防御——投影器会在更早处验证并抛出 next_owner_unresolved，因此实践中不可达。
        throw new WorkflowProjectorError(
          "next_owner_unresolved",
          "handoff exit 要求在关闭队列前解析出下一位 owner",
        );
      }
      return {
        state: "handed-off",
        closureReason: "handed_off_to",
        closureTarget: resolvedNextOwner,
        handedOffTo: resolvedNextOwner,
        transitionNote: `工作流交接给 ${resolvedNextOwner}`,
      };
    }
    case "waiting": {
      const blocker = input.blockedOn ?? "external-gate";
      return {
        state: "blocked",
        closureReason: "blocked_on",
        closureTarget: blocker,
        blockedOn: blocker,
        transitionNote: `工作流等待 ${blocker}`,
      };
    }
    case "done": {
      return {
        state: "done",
        closureReason: "no-follow-on",
        closureTarget: null,
        transitionNote: input.resultNote
          ? `工作流完成：${input.resultNote}`
          : "工作流完成",
      };
    }
    case "failed": {
      return {
        state: "done",
        closureReason: "denied",
        closureTarget: input.resultNote ?? "workflow_step_failed",
        transitionNote: input.resultNote
          ? `工作流失败：${input.resultNote}`
          : "工作流失败",
      };
    }
  }
}

/**
 * OPR.0.4.6.WF2 FR-5：gate 编译器——按目标类型把声明的步骤级 gate 解析到实时 0.4.4
 * 机制。HUMAN 目标（已发布的 human-seat 谓词）→ 携带已发布写入路径强制要求的 summary +
 * evidence_ref 的 human 路由条目（tier `human-gate`），由已发布的 `resolve` 动词解决。
 * HANDLER-ROLE 目标 → 路由到声明 role 所解析 seat 的普通 agent 条目（不强加仅限 human
 * 的字段）。WF-2 构建接口，WF-5 负责 gate 语义。
 */
export interface GateCompileResult {
  destinationSession: string;
  /** 为未来 tier 覆盖预留；undefined 表示调用方的默认 tier。 */
  tier: string | undefined;
  summary: string | null;
  evidenceRef: string | null;
  kind: "human" | "handler-role";
  /** HUMAN 目标：packet 以 blocked_on 停放到的 human seat（已发布的 `zrig queue resolve`
   *  动词操作的第一段 park——guard blocker 1：resolve 要求 state=blocked + human-seat
   *  blocked_on，因此 gate 条目为 STEP OWNER 创建并停放到 human，而不是创建无法解析的
   *  pending human 目标条目）。handler-role gate 为 null（普通 agent 路由，不在 human 上
   *  park）。 */
  parkOn: string | null;
}

export function compileGate(
  spec: WorkflowSpec,
  gatedStep: WorkflowStepSpec,
  runtimeOf: (session: string) => string | null,
  /** OPR.0.4.6.FAC1：绑定工作组上下文——把能力解析同时传入两条 gate 路径（guard B3：
   *  human-gate OWNER 路径与 handler-role DESTINATION 分支是不同代码路径，两者都必须携带
   *  上下文）。缺失时与已发布行为逐字节一致。 */
  roleCtx?: RoleResolutionContext,
): GateCompileResult {
  const gate = gatedStep.gate;
  if (!gate) {
    throw new WorkflowProjectorError(
      "gate_missing",
      `为未声明 gate 的步骤 "${gatedStep.id}" 调用了 compileGate`,
      { stepId: gatedStep.id },
    );
  }
  if (isHumanSeatSession(gate.target)) {
    // 纵深防御：validator 在 validate 时要求这些字段；已发布的 human-park 写入路径会在
    // blocked_on 转换时通过 validateHumanPark 再次强制执行。
    if (!gate.summary || !gate.evidence_ref) {
      throw new WorkflowProjectorError(
        "gate_human_fields_missing",
        `步骤 "${gatedStep.id}" gate 到 human seat ${gate.target}，但缺少 ${!gate.summary ? "summary" : "evidence_ref"}；停放到 human 的条目同时需要这两个字段（已发布的 human-route 契约）。`,
        { stepId: gatedStep.id, target: gate.target },
      );
    }
    // packet 属于带 gate 步骤的 ROLE OWNER（human 确认后实际执行工作的 seat），并以
    // blocked_on 停放在 human seat；这正是 `zrig queue resolve` 会解除的第一段形状。
    // FAC-1（guard B3 row 2a）：owner 经过完整 tier 栈解析；绑定实例中仅声明 role 的
    // gated step 会按能力获得工作组本地 owner。
    const owner = resolveDefaultOwner(spec, gatedStep, runtimeOf, roleCtx);
    if (!owner) {
      throw new WorkflowProjectorError(
        "gate_owner_unresolved",
        `步骤 "${gatedStep.id}" gate 到 human seat ${gate.target}，但其 role "${gatedStep.actor_role}" 未声明 preferred_targets；停放的 packet 在 resolve 后没有可恢复的 owner。请为该 role 添加 preferred_targets。`,
        { stepId: gatedStep.id, target: gate.target, role: gatedStep.actor_role },
      );
    }
    return {
      destinationSession: owner,
      tier: undefined,
      summary: gate.summary,
      evidenceRef: gate.evidence_ref,
      kind: "human",
      parkOn: gate.target,
    };
  }
  const role = spec.roles?.[gate.target];
  if (!role) {
    throw new WorkflowProjectorError(
      "gate_target_unresolved",
      `步骤 "${gatedStep.id}" gate 到 "${gate.target}"，但它既不是 human seat session，也不是 workflow.roles 中声明的 role。请声明该 role，或使用 human seat session（human@kernel 形式）。`,
      { stepId: gatedStep.id, target: gate.target },
    );
  }
  const handlerTargets = role.preferred_targets ?? [];
  if (handlerTargets.length === 0) {
    // OPR.0.4.6.FAC1（guard B3 row 2b——若未传递上下文就会静默保留旧行为的分支）：
    // 已声明的 preferred_targets 继续作为逐字节一致的覆盖 tier；当 handler role 没有
    // target 且实例已绑定时，handler seat 根据绑定工作组的能力解析（步骤的 harness pin
    // 约束实际路由目标——WF-2 rev1-r2 契约）；否则保留已发布的明确失败。
    if (roleCtx) {
      const seat = resolveRoleOnBoundRig(gate.target, gatedStep.harness, roleCtx, gatedStep.id);
      return {
        destinationSession: seat,
        tier: undefined,
        summary: gate.summary ?? null,
        evidenceRef: gate.evidence_ref ?? null,
        kind: "handler-role",
        parkOn: null,
      };
    }
    throw new WorkflowProjectorError(
      "gate_handler_unresolved",
      `步骤 "${gatedStep.id}" gate 到 handler role "${gate.target}"，但该 role 未声明 preferred_targets；gate 条目没有可路由的 seat。请为该 role 添加 preferred_targets。`,
      { stepId: gatedStep.id, target: gate.target },
    );
  }
  // OPR.0.4.6.WF2（rev1-r2 blocker）：步骤的 harness pin 约束 packet 的实际路由目标；
  // 对 handler gate 而言就是 handler seat。FR-2 的“绝不静默误路由到错误 harness”契约
  // 不允许 gate 绕过：带 pin 的 gated step 路由到节点 runtime 匹配的首个 handler
  // preferred_target，否则以结构化失败列出 pin 和每个候选的 runtime。
  let seat: string;
  if (gatedStep.harness) {
    const candidates = handlerTargets.map((t) => ({ session: t, runtime: runtimeOf(t) }));
    const match = candidates.find((c) => c.runtime === gatedStep.harness);
    if (!match) {
      throw new WorkflowProjectorError(
        "harness_pin_unsatisfied",
        `步骤 "${gatedStep.id}" 固定使用 harness "${gatedStep.harness}"，并 gate 到 handler role "${gate.target}"，但该 role 的 preferred_target 均未运行此 harness。候选：${candidates.map((c) => `${c.session} → ${c.runtime ?? "unknown"}`).join(", ")}。请向 handler role 的 preferred_targets 添加 ${gatedStep.harness} seat，或修改/移除 pin。`,
        {
          stepId: gatedStep.id,
          harness: gatedStep.harness,
          gateTarget: gate.target,
          candidates: candidates.map((c) => ({ session: c.session, runtime: c.runtime })),
        },
      );
    }
    seat = match.session;
  } else {
    seat = handlerTargets[0]!;
  }
  return {
    destinationSession: seat,
    tier: undefined,
    summary: gate.summary ?? null,
    evidenceRef: gate.evidence_ref ?? null,
    kind: "handler-role",
    parkOn: null,
  };
}

function workflowHandoffBody(input: {
  library?: GuidanceInput["library"];
  spec: WorkflowSpec;
  instance: WorkflowInstance;
  currentStep: WorkflowStepSpec;
  nextStep: WorkflowStepSpec;
  actorSession: string;
  resultNote: string | undefined;
  gate?: GateCompileResult | null;
  packetId: string;
  ownerSession: string;
}): string {
  const lines = [
    input.gate
      ? `### 工作流 gate：${input.spec.id}@${input.spec.version}，步骤 ${input.nextStep.id}`
      : `### 工作流交接：${input.spec.id}@${input.spec.version}，步骤 ${input.nextStep.id}`,
    "",
    `工作流实例：${input.instance.instanceId}`,
    `上一步骤：${input.currentStep.id}（${input.currentStep.actor_role}），由 ${input.actorSession} 关闭`,
    `当前步骤：${input.nextStep.id}（${input.nextStep.actor_role}）`,
  ];
  if (input.gate) {
    lines.push(
      `Gate：${input.gate.kind === "human" ? "human 确认" : "handler-role 检查"}——工作流会保持 PARKED（waiting），直到此条目被 resolve/close；之后流程从本步骤继续。`,
    );
    if (input.gate.summary) lines.push(`请求：${input.gate.summary}`);
    if (input.gate.evidenceRef) lines.push(`证据：${input.gate.evidenceRef}`);
  }
  if (input.nextStep.objective) {
    lines.push(`目标：${input.nextStep.objective}`);
  }
  if (input.resultNote) {
    lines.push("", `上一步骤备注：${input.resultNote}`);
  }
  return withWorkflowContinuation({
    body: lines.join("\n"),
    contextRefs: input.spec.context_refs,
    binding: input.instance.lifecycleBinding,
    library: input.library,
    instanceId: input.instance.instanceId,
    packetId: input.packetId,
    ownerSession: input.ownerSession,
    step: input.nextStep,
  });
}

function validateAcceptance(
  step: WorkflowStepSpec,
  input: ProjectStepInput,
  instance: WorkflowInstance,
): void {
  if (!step.acceptance || input.exit === "waiting") return;
  const raw = input.closureEvidence?.acceptance;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkflowProjectorError(
      "acceptance_payload_required",
      `步骤 "${step.id}" 是 acceptance gate；交付、终态 producer 行或 liveness wake 都不能推进它。请提供包含 candidate、verdict 和 evidence_ref 的 closureEvidence.acceptance。`,
      { instanceId: instance.instanceId, stepId: step.id },
    );
  }
  const payload = raw as Record<string, unknown>;
  const mismatches: Record<string, { expected: unknown; actual: unknown }> = {};
  if (payload.candidate !== step.acceptance.candidate) {
    mismatches.candidate = { expected: step.acceptance.candidate, actual: payload.candidate ?? null };
  }
  if (typeof payload.verdict !== "string" || !step.acceptance.verdicts.includes(payload.verdict)) {
    mismatches.verdict = { expected: step.acceptance.verdicts, actual: payload.verdict ?? null };
  }
  if (payload.evidence_ref !== step.acceptance.evidence_ref) {
    mismatches.evidence_ref = { expected: step.acceptance.evidence_ref, actual: payload.evidence_ref ?? null };
  }
  if (Object.keys(mismatches).length > 0) {
    throw new WorkflowProjectorError(
      "acceptance_payload_mismatch",
      `步骤 "${step.id}" 的 acceptance payload 与声明的 candidate/verdict/evidence 契约不匹配`,
      { instanceId: instance.instanceId, stepId: step.id, mismatches },
    );
  }
}
