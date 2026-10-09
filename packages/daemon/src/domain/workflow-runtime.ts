import { readWorkflowGuidance, type GuidanceInput } from "./workflow-guidance.js";
import { exceptionConfigurationSource, inspectExceptionReadiness, type ExceptionReadiness } from "./workflow-exception-readiness.js";
import { inspectGraph, recoverGraphOperation, reviseGraph } from "./workflow-reconciliation.js";
import { lifecycleObligations, requiredLifecycleSteps, type LifecycleObligation } from "./lifecycle-obligations.js";
// PL-004 Phase D：工作流运行时 facade。
//
// 将 spec cache、validator、instance store、projector 和 trail log 协调为四个高层操作：
//   - validate(specPath)
//   - instantiate(specPath, rootObjective, createdBySession)
//   - project(...)（委托给 projector）
//   - continue(instanceId)（幂等推进；v1 为只读检查器）
//
// 该模式与 Phase B 的 ProjectClassifier facade 形状一致。

import type Database from "better-sqlite3";
import type { WorkflowSpec } from "./workflow-types.js";
import type { EventBus } from "./event-bus.js";
import type { PersistedEvent } from "./types.js";
import type { QueueRepository } from "./queue-repository.js";
import {
  type CreateWorkflowInstanceInput,
  WorkflowInstanceStore,
  WorkflowInstanceError,
} from "./workflow-instance-store.js";
import { resolveExceptionRoute, type ExceptionRoute } from "./workflow-exception-router.js";
import type { WorkflowHumanDestination } from "./workflow-human-destination.js";
import { classifyGateTrip, workflowExceptionTags } from "./workflow-exception.js";
import { newQitemId } from "./queue-repository.js";
import type { WorkflowExceptionClass } from "./workflow-exception.js";
import {
  WorkflowProjector,
  WorkflowProjectorError,
  compileGate,
  nodeRuntimeOf,
  reconcileExplicitOwnerHarness,
  resolveDefaultOwner,
  withWorkflowContinuation,
  workflowWaitWakeMessage,
  type GateCompileResult,
  type ProjectStepInput,
  type ProjectStepResult,
} from "./workflow-projector.js";
import { loadHostRegistry } from "./hosts/hosts-registry-reader.js";
import type { HostRegistryLookupFn } from "./workflow-validator.js";
import { WorkflowSpecCache, WorkflowSpecError } from "./workflow-spec-cache.js";
import { WorkflowStepTrailLog } from "./workflow-step-trail-log.js";
import {
  type SeatLivenessCheckFn,
  type ValidationResult,
  WorkflowValidator,
} from "./workflow-validator.js";
import type { WatchdogJobsRepository } from "./watchdog-jobs-repository.js";
import { disarmAllWorkflowKeepalives, disarmWorkflowKeepalive, ensureWorkflowKeepaliveArmed } from "./workflow-keepalive-arming.js";
import { evaluateStepDeadline, type WorkflowDeadlineVerdict } from "./workflow-deadline.js";
import {
  rigDeclaresRole,
  rigMemberExists,
  roleResolutionContext,
  tryResolveRoleByCapability,
} from "./workflow-role-context.js";
import { isHumanSeatSession } from "./human-route-enforcer.js";
import { parseSessionName } from "./session-name.js";
import type {
  WorkflowFailureOccurrence,
  WorkflowInstance,
  WorkflowSpecRow,
  WorkflowStepSpec,
  WorkflowStepTrailEntry,
} from "./workflow-types.js";
import { compileProjectLifecycle, type LifecycleCompilation } from "./project-lifecycle-compiler.js";

export interface WorkflowRuntimeDeps {
  guidanceLibrary?: GuidanceInput["library"];
  db: Database.Database;
  eventBus: EventBus;
  queueRepo: QueueRepository;
  now?: () => Date;
  /**
   * OPR.0.4.6.WF1 FR-3：提供后，instantiate + handoff 投影会在 scribe 事务内
   * 自动武装逐实例 workflow-keepalive watchdog job，终态退出则解除。此依赖可选，
   * 使没有 watchdog 子系统的测试/嵌入方仍可工作；startup 接入真实 repository。
   */
  watchdogJobsRepo?: WatchdogJobsRepository;
  /**
   * OPR.0.4.6.WF5 FR-2：成熟度旋钮输入在启动时注入，projector 自身从不读取配置。
   * 每次异常都实时读取 hostDefault；缺失时使用“orchestrator 优先”的引擎默认值，
   * 若无智能体路由可解析则选择已登记人类。
   */
  exceptionDial?: {
    hostDefault: () => "orchestrator" | "human_only" | null;
    humanFallbackSeat: WorkflowHumanDestination;
  };
}

export interface InstantiateInput {
  specPath: string;
  rootObjective: string;
  createdBySession: string;
  /**
   * 覆盖默认入口步骤 owner。v1 回退到入口步骤角色的 spec preferred_targets[0]。
   */
  entryOwnerSession?: string;
  /**
   * OPR.0.4.6.FAC1（AC-1）：此实例绑定的工作组。覆盖 spec 的 `target.rig` 默认值；
   * 生效绑定（`targetRig ?? spec.target.rig ?? null`）持久化为
   * `WorkflowInstance.boundRig`，并限定角色能力解析作用域。两者都缺失时为 unbound，
   * 与当前行为一致。
   */
  targetRig?: string;
  lifecycle?: {
    operationKey: string;
    compiledInputDigest: string;
    binding: Record<string, unknown>;
  };
  /** compileLifecycle 生成的内部输入；绝不从客户端接收。 */
  compiledLifecycle?: LifecycleCompilation;
}

export interface InstantiateResult {
  instance: WorkflowInstance;
  spec: WorkflowSpecRow;
  entryQitemId: string;
  entryOwnerSession: string;
  /**
   * OPR.0.4.6.FAC1（2026-07-07 架构裁决，target-rig 零回归）：instantiate 时的响亮建议。
   * 这是操作人员必须看到的非致命通知，列表有两个来源：(1) spec 默认值降级——若 spec 的
   * `target.rig` 默认值（出处是 spec 作者提示，不是操作人员的 `--rig` 要求）指向未登记工作组，
   * 实例降级为 UNBOUND（经 preferred_targets 路由，与 FAC-1 前字节一致），在此给出建议而非硬失败；
   * (2) OPR.0.4.6.FAC3 member-exists 探针——声明的 preferred_target 指向已登记工作组
   * 中不存在的成员。字段始终存在，无内容时为空；路由和 CLI 会响亮展示。
   */
  advisories: string[];
  replayed?: boolean;
}

export class WorkflowRuntime {
  readonly specCache: WorkflowSpecCache;
  readonly instanceStore: WorkflowInstanceStore;
  readonly trailLog: WorkflowStepTrailLog;
  readonly validator: WorkflowValidator;
  readonly projector: WorkflowProjector;

  private readonly guidanceLibrary?: GuidanceInput["library"];
  private readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly queueRepo: QueueRepository;
  private readonly now: () => Date;
  private readonly watchdogJobsRepo: WatchdogJobsRepository | undefined;
  private readonly exceptionDial?: WorkflowRuntimeDeps["exceptionDial"];

  constructor(deps: WorkflowRuntimeDeps) {
    this.guidanceLibrary = deps.guidanceLibrary;
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.queueRepo = deps.queueRepo;
    this.now = deps.now ?? (() => new Date());
    this.watchdogJobsRepo = deps.watchdogJobsRepo;
    this.exceptionDial = deps.exceptionDial;
    this.specCache = new WorkflowSpecCache(this.db, this.now);
    this.instanceStore = new WorkflowInstanceStore(this.db, this.now);
    this.trailLog = new WorkflowStepTrailLog(this.db);
    this.validator = new WorkflowValidator();
    this.projector = new WorkflowProjector(
      this.db,
      this.eventBus,
      this.queueRepo,
      this.instanceStore,
      this.trailLog,
      this.specCache,
      this.now,
      this.watchdogJobsRepo,
      deps.exceptionDial,
      deps.guidanceLibrary,
    );
    this.queueRepo.attachWorkflowGuidance(packetId => {
      const packet = this.queueRepo.getById(packetId);
      const instanceId = packet?.tags?.find(tag => tag.startsWith("instance:"))?.slice(9);
      if (!instanceId) return [];
      const guidance = this.guidance(instanceId, {packetId});
      return guidance.state === "unselected" ? [] : guidance.lines;
    });
  }

  inspectGraph(instanceId: string) { return inspectGraph(this.db, instanceId); }
  recoverOperation(key: string) { return recoverGraphOperation(this.db, key); }
  reviseGraph(input: Parameters<typeof reviseGraph>[2]) { return reviseGraph(this.db, this.eventBus, input); }

  compileLifecycle(missionPath: string, operationKey?: string): LifecycleCompilation & { exceptionReadiness?: ExceptionReadiness } {
    const compiled = compileProjectLifecycle({ missionPath, operationKey });
    return { ...compiled, ...(compiled.workflowSpec ? { exceptionReadiness: this.readExceptionReadiness(compiled.workflowSpec,
      exceptionConfigurationSource(compiled.sources.find(s => s.kind === "mission")!.path, compiled.graphSource)) } : {}) };
  }

  private readExceptionReadiness(spec: WorkflowSpec, source: string, boundRig?: string | null, instanceId?: string) {
    return inspectExceptionReadiness({ db: this.db, spec, source, boundRig, instanceId,
      hostDefault: () => this.exceptionDial?.hostDefault() ?? null, humanFallbackSeat: this.exceptionDial?.humanFallbackSeat });
  }

  guidance(instanceId: string, options: Pick<GuidanceInput, "packetId" | "component" | "full"> = {}) {
    const instance = this.instanceStore.getByIdOrThrow(instanceId);
    const spec = this.specCache.getByNameVersion(instance.workflowName, instance.workflowVersion)?.spec;
    const packetId = options.packetId ?? (instance.currentFrontier.length === 1 ? instance.currentFrontier[0] : undefined);
    if (packetId && !instance.currentFrontier.includes(packetId)) throw new WorkflowProjectorError("packet_not_on_frontier", "指导信息需要当前 frontier packet；请先检查 workflow show。");
    const packet = packetId ? this.queueRepo.getById(packetId) : null;
    const stepId = packetId ? this.instanceStore.getFrontierBinding(instanceId, packetId)?.stepId ?? (instance.currentFrontier.length === 1 ? instance.currentStepId : null) : null;
    return readWorkflowGuidance({instanceId, contextRefs: spec?.context_refs, binding: instance.lifecycleBinding,
      stepId: stepId ?? undefined, ownerSession: packet?.destinationSession, library: this.guidanceLibrary, ...options, packetId});
  }

  exceptionReadiness(instanceId: string): ExceptionReadiness | null {
    const instance = this.instanceStore.getByIdOrThrow(instanceId);
    const row = this.specCache.getByNameVersion(instance.workflowName, instance.workflowVersion);
    if (!row) return null;
    return this.readExceptionReadiness(row.spec, exceptionConfigurationSource(row.sourcePath,
      instance.lifecycleBinding?.graphSource as LifecycleCompilation["graphSource"] | undefined), instance.boundRig, instanceId);
  }

  exceptionObligations(instanceId: string) {
    return (this.db.prepare(`SELECT qitem_id FROM queue_items WHERE json_valid(tags)
      AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'workflow-exception')
      AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?) ORDER BY ts_created, qitem_id`)
      .all(`instance:${instanceId}`) as Array<{ qitem_id: string }>).map(row => {
        const q = this.queueRepo.getById(row.qitem_id)!;
        return { qitemId: q.qitemId, ownerSession: q.destinationSession, state: q.state,
          evidenceRef: q.evidenceRef, tags: q.tags, handedOffFrom: q.handedOffFrom,
          inspectCommand: "zrig queue show " + q.qitemId + " --full --json" };
      });
  }

  async instantiateLifecycle(input: {
    missionPath: string;
    operationKey: string;
    rootObjective: string;
    createdBySession: string;
    entryOwnerSession?: string;
    targetRig?: string;
  }): Promise<InstantiateResult & { compilation: LifecycleCompilation }> {
    if (this.recoverOperation(input.operationKey)?.kind === "revision") {
      throw new WorkflowProjectorError("lifecycle_operation_conflict", "此 key 已记录一次图修订；请选择新的创建 key 前先检查 workflow operation。");
    }
    const compilation = this.compileLifecycle(input.missionPath, input.operationKey);
    if (!compilation.eligible || !compilation.workflowSpec) {
      throw new WorkflowProjectorError(
        "lifecycle_not_eligible",
        "已编译的生命周期可检查，但不符合实例化条件",
        { missionPath: input.missionPath, unknowns: compilation.unknowns },
      );
    }
    const result = await this.instantiate({
      specPath: input.missionPath,
      rootObjective: input.rootObjective,
      createdBySession: input.createdBySession,
      entryOwnerSession: input.entryOwnerSession,
      targetRig: input.targetRig,
      compiledLifecycle: compilation,
      lifecycle: {
        operationKey: input.operationKey,
        compiledInputDigest: compilation.compiledInputDigest,
        binding: {
          identity: compilation.identity,
          sources: compilation.sources,
          dependencies: compilation.dependencies,
          graphSource: compilation.graphSource,
          initialInputDigest: compilation.compiledInputDigest,
        },
      },
    });
    return { ...result, compilation };
  }

  /**
   * OPR.0.4.6.WF5 FR-2：为已缓存 spec 解析成熟度旋钮。类别 (b) 检测路径
   *（sweep/keepalive）通过启动时注入的闭包调用这里。null 表示 spec 未缓存，
   * 此时应用调用方的已登记人类选择。与步骤 owner 解析使用相同的
   * preferred_targets[0] 字符串选择（架构接缝 A 一致性）。
   */
  resolveExceptionRouteFor(
    workflowName: string,
    workflowVersion: string,
    exceptionClass: WorkflowExceptionClass,
    /** OPR.0.4.6.FAC1（arch Q3）：实例绑定的工作组。旋钮位置 3
     *（orchestrator-role）在角色未声明 preferred_targets 时，会在该工作组上按能力解析。
     * 缺失/null 表示只用现有的不感知舰队的字符串选择。 */
    boundRig?: string | null,
  ): ExceptionRoute | null {
    const specRow = this.specCache.getByNameVersion(workflowName, workflowVersion);
    if (!specRow) return null;
    const spec = specRow.spec;
    const roleCtx = roleResolutionContext(this.db, boundRig ?? null);
    return resolveExceptionRoute({
      exceptionClass,
      spec,
      hostDialDefault: this.exceptionDial?.hostDefault() ?? null,
      resolveRoleTarget: (role) =>
        spec.roles?.[role]?.preferred_targets?.[0] ??
        tryResolveRoleByCapability(roleCtx, role),
      humanFallbackSeat: this.exceptionDial?.humanFallbackSeat,
    });
  }

  /**
   * OPR.0.4.6.WF2 FR-3：validator 的生产 host-registry 探针，构建在后台服务
   * hosts-registry reader（CLI 注册表的只读孪生）之上。注册表不可读/缺失时，
   * 以空 id 列表把每个 id 报为未登记，在 validator 的 host_not_registered 问题处
   * 响亮失败，绝不静默通过。
   */
  private hostRegistryLookup: HostRegistryLookupFn = (hostId: string) => {
    const loaded = loadHostRegistry();
    if (!loaded.ok) return { registered: false, registeredIds: [] };
    const ids = loaded.registry.hosts.map((h) => h.id);
    return { registered: ids.includes(hostId), registeredIds: ids };
  };

  /** P19 A4（发现项已毕业）：runtime 持有默认存活探针，沿用 hostRegistryLookup 同级先例。
   *  当且仅当后台服务数据库中同名会话当前为 `running`，preferred target 才存活。
   *  调用方仍可注入自定义检查（测试、未来远程感知）。 */
  private seatLivenessCheck: SeatLivenessCheckFn = (sessionRef: string) => {
    // 建议绝不抛错（member-advisory 先例）：部分 schema 数据库（没有 sessions 表的裸 fixture）
    // 意味着探针无法证明任一方向——报告 alive 以避免告警，且绝不能让建议路径使
    // validate/instantiate 失败。
    try {
      const row = this.db
        .prepare(
          `SELECT s.status AS status FROM sessions s WHERE s.session_name = ? ORDER BY s.created_at DESC LIMIT 1`,
        )
        .get(sessionRef) as { status: string } | undefined;
      if (!row) return { alive: false, reason: "no_session_with_this_name" };
      return row.status === "running" ? { alive: true } : { alive: false, reason: `session_status_${row.status}` };
    } catch {
      return { alive: true };
    }
  };

  validate(specPath: string, seatLivenessCheck?: SeatLivenessCheckFn): ValidationResult & { exceptionReadiness: ExceptionReadiness } {
    const specRow = this.specCache.readThrough(specPath);
    return { ...this.validator.validate(specRow.spec, seatLivenessCheck ?? this.seatLivenessCheck, this.hostRegistryLookup),
      exceptionReadiness: this.readExceptionReadiness(specRow.spec, exceptionConfigurationSource(specRow.sourcePath)) };
  }

  /**
   * 创建工作流实例和首步骤 qitem。入口 qitem 与实例行在同一事务中创建；
   * 订阅者会一起看到 workflow.instantiated 与 queue.created 事件。
   */
  async instantiate(input: InstantiateInput): Promise<InstantiateResult> {
    // replay/conflict 分类必须先于任何缓存或队列写入。operation key 是持久外层身份；
    // 精确重放读取已缓存 spec 和入口行，字节变更则零修改拒绝。
    if (input.lifecycle) {
      if (!input.lifecycle.operationKey || !input.lifecycle.compiledInputDigest) {
        throw new WorkflowProjectorError(
          "lifecycle_identity_invalid",
          "生命周期实例化要求 operationKey 和 compiledInputDigest 均非空",
        );
      }
      const existing = this.instanceStore.getByLifecycleOperationKey(input.lifecycle.operationKey);
      if (existing) {
        if ((existing.lifecycleBinding?.initialInputDigest ?? existing.compiledInputDigest) !== input.lifecycle.compiledInputDigest) {
          throw new WorkflowProjectorError(
            "lifecycle_operation_conflict",
            `生命周期 operation key ${input.lifecycle.operationKey} 已绑定不同的编译输入字节`,
            {
              operationKey: input.lifecycle.operationKey,
              expectedDigest: existing.lifecycleBinding?.initialInputDigest ?? existing.compiledInputDigest,
              attemptedDigest: input.lifecycle.compiledInputDigest,
              instanceId: existing.instanceId,
            },
          );
        }
        const spec = this.specCache.getByNameVersion(existing.workflowName, existing.workflowVersion);
        const entryQitemId = typeof existing.lifecycleBinding?.entryQitemId === "string"
          ? existing.lifecycleBinding.entryQitemId
          : null;
        const entryPacket = entryQitemId ? this.queueRepo.getById(entryQitemId) : null;
        if (!spec || !entryQitemId || !entryPacket) {
          throw new WorkflowProjectorError(
            "lifecycle_replay_indeterminate",
            `生命周期 operation ${input.lifecycle.operationKey} 已存在，但无法解析其缓存 spec 或入口 packet`,
            { operationKey: input.lifecycle.operationKey, instanceId: existing.instanceId, entryQitemId },
          );
        }
        return {
          instance: existing,
          spec,
          entryQitemId,
          entryOwnerSession: entryPacket.destinationSession,
          advisories: [],
          replayed: true,
        };
      }
    }
    // OPR.0.3.3.04.1（AC-3 可达性）：新操作人员运行
    // `workflow instantiate <discovered-name>`（如 `conveyor`），而不是隐藏文件路径。
    // 先按名称在已播种 spec 缓存中解析标识符（使用缓存中已解析的 sourcePath）；
    // 只有无同名 spec 时才回退为字面 sourcePath，即显式路径上的人工 spec。此前 instantiate
    // 会把裸名称直接交给 readThrough，导致 spec_file_missing。
    const resolvedSpecPath = this.specCache.resolveSourcePathByName(input.specPath) ?? input.specPath;
    const generatedSpec = input.compiledLifecycle?.workflowSpec;
    const specRow = generatedSpec
      ? this.specCache.putGenerated(
          generatedSpec,
          input.compiledLifecycle!.sources.find((source) => source.kind === "mission")?.path ?? resolvedSpecPath,
          input.compiledLifecycle!.compiledInputDigest,
        )
      : this.specCache.readThrough(resolvedSpecPath);
    const validation = this.validator.validate(specRow.spec, this.seatLivenessCheck, this.hostRegistryLookup);
    if (!validation.ok) {
      throw new WorkflowProjectorError(
        "spec_invalid",
        `无法实例化：spec ${specRow.name}@${specRow.version} 有 ${validation.issues.filter((i) => i.severity === "error").length} 个校验错误；请运行 validate 检查`,
        { specPath: input.specPath, issues: validation.issues },
      );
    }
    const entryStep = specRow.spec.steps[0];
    if (!entryStep) {
      throw new WorkflowProjectorError(
        "spec_no_steps",
        `无法实例化：spec ${specRow.name}@${specRow.version} 没有 steps[]`,
        { specPath: input.specPath },
      );
    }


    // OPR.0.4.6.WF2 FR-3：v1 执行边界（slice-11 模式）。远程 host pin 在语言层合法
    //（已在上方校验），但在此响亮失败——队列在 MH-3 跨主机队列路由前仅支持本地。
    // 禁止把 qitem 写进无法路由它的队列，也禁止静默在本地运行步骤。instantiate 时为每个步骤
    // 检查，这是最早可知时刻；运行中途才发现会搁浅实例。
    for (const step of specRow.spec.steps) {
      if (step.host && step.host !== "local") {
        throw new WorkflowProjectorError(
          "host_pin_remote_unsupported",
          `无法实例化：步骤 "${step.id}" 固定到主机 "${step.host}"。远程步骤执行需要尚未交付的 MH-3（跨主机队列路由）；当前队列仅支持本机。临时方案：在本机运行该步骤的席位（host: local 或移除 pin），或等待 MH-3。`,
          { specPath: input.specPath, stepId: step.id, host: step.host, boundary: "MH-3" },
        );
      }
    }

    // OPR.0.4.6.FAC1（AC-1）+ 2026-07-07 架构裁决（target-rig 零回归，
    // “按出处细化方案 A”）：按工作组名称的出处分流解析实例绑定，
    // 因为两个来源表达不同意图：
    //
    //   - 操作人员 `input.targetRig`（显式 `--rig X`）具有权威性：这是显式实例化要求。
    //     未知 X → 在任何修改前以 `bound_rig_unknown` 响亮硬失败，保持既有行为。
    //   - spec 默认 `spec.target.rig` 仅为建议：它是 spec 作者在 FAC-1 前字段运行时被忽略
    //     （仅展示）的制度下写出的默认提示。未知值 → 降级为 UNBOUND + 响亮建议，
    //     既不静默也不硬失败。这为随包/示例 spec 保持 AC-1 零回归；例如 `conveyor` 声明
    //     `target.rig: conveyor`，且每步经 preferred_targets 路由，降级为 unbound 后与 FAC-1 前
    //     路由完全一致。真正需要绑定工作组的 spec 仍会按步骤在正确粒度响亮失败：入口在
    //     instantiate 时为 `entry_owner_unresolved`，后续仅角色步骤在投影时为
    //     `next_owner_unresolved`。没有任何东西静默降级，只会降为带预警的逐步骤诚实失败。
    //   - 二者均未设置 → unbound，与当前行为字节一致。
    //
    // 后续每个解析点都重新执行 name→id，因此运行中消失的工作组会在当地响亮失败，
    // 由 WF-5 捕获。
    const registeredRigNames = (): string[] =>
      (this.db.prepare(`SELECT DISTINCT name FROM rigs ORDER BY name`).all() as Array<{ name: string }>).map(
        (r) => r.name,
      );
    const rigIsRegistered = (name: string): boolean =>
      this.db.prepare(`SELECT id FROM rigs WHERE name = ? LIMIT 1`).get(name) !== undefined;

    const advisories: string[] = [];
    let boundRig: string | null;
    if (input.targetRig != null) {
      // 权威路径：满足操作人员的显式要求，否则响亮失败。
      if (!rigIsRegistered(input.targetRig)) {
        const registered = registeredRigNames();
        throw new WorkflowProjectorError(
          "bound_rig_unknown",
          `无法实例化：目标工作组 "${input.targetRig}" 未在此后台服务登记。已登记工作组：${
            registered.length > 0 ? registered.join(", ") : "（无）"
          }。请检查 \`zrig ps\`，先创建或导入工作组，或改用其他 --rig 实例化。`,
          { specPath: input.specPath, targetRig: input.targetRig, registeredRigs: registered },
        );
      }
      boundRig = input.targetRig;
    } else if (specRow.spec.target?.rig != null) {
      // 建议路径：spec 作者的默认提示。未知值降级为 unbound 并响亮提示，
      // 绝不因默认值硬失败。
      const specDefaultRig = specRow.spec.target.rig;
      if (!rigIsRegistered(specDefaultRig)) {
        const registered = registeredRigNames();
        boundRig = null;
        advisories.push(
          `工作流 spec 的默认 target.rig "${specDefaultRig}" 未在此后台服务登记——将以 UNBOUND 状态实例化。` +
            `步骤通过其声明的 preferred_targets 路由；任何仅声明角色的步骤（无 preferred_targets）都会在恰当时机按角色失败` +
            `（入口在实例化时，后续步骤在投影时）。传入 --rig <name> 可显式绑定。` +
            `已登记工作组：${registered.length > 0 ? registered.join(", ") : "（无）"}。`,
        );
      } else {
        boundRig = specDefaultRig;
      }
    } else {
      boundRig = null;
    }

    // OPR.0.4.6.WF2 FR-2：instantiate 时为每个固定步骤做静态 harness-pin 对账，
    // 这是相对当前 inventory 的最早可知时刻；投影在每次路由时重查，因为 runtime 可在途中变化。
    //
    // OPR.0.4.6.FAC1（ARCH Q2 = GUARD B1，强约束）：此预先循环不做实时角色解析，
    // 也不记录任何内容。对角色已声明 target 的步骤，保留已交付的 harness/preferred-target
    // 对账（仅依赖 spec 事实，此刻检查可靠）；绑定实例中仅角色且零声明 target 的步骤在此刻意跳过——
    // 工厂工作组需要预热，其存活性应在该步骤投影时处理，届时由带候选响亮失败 + WF-5 负责。
    // 下方结构化零角色覆盖检查，是仅角色步骤在 instantiate 时唯一的硬失败。未绑定 spec
    // 与当前行为字节一致；固定了 harness 却无 target 的步骤仍在 instantiate 时以
    // "(none declared)" 失败，因为它永远不可能解析。
    const runtimeOf = (session: string) => nodeRuntimeOf(this.db, session);
    const declaredTargetsOf = (roleName: string): number =>
      (specRow.spec.roles?.[roleName]?.preferred_targets ?? []).length;
    for (const step of specRow.spec.steps) {
      if (step.harness) {
        // rev1-r2 阻断修复：不排除 gated 步骤——固定了 harness 的 gated 步骤通过
        // gate compile 对账；human gate 感知 pin 地解析步骤 owner，handler gate 则把 pin
        // 与 handler 角色的 target 匹配。无候选匹配时二者都抛 harness_pin_unsatisfied。
        if (step.gate) {
          const gateIsHuman = isHumanSeatSession(step.gate.target);
          const gateRoleTargets = gateIsHuman
            ? declaredTargetsOf(step.actor_role)
            : declaredTargetsOf(step.gate.target);
          if (boundRig !== null && gateRoleTargets === 0) continue; // role-only on a bound rig: projection resolves
          compileGate(specRow.spec, step, runtimeOf);
        } else if (!(step === entryStep && input.entryOwnerSession)) {
          if (boundRig !== null && declaredTargetsOf(step.actor_role) === 0) continue;
          resolveDefaultOwner(specRow.spec, step, runtimeOf);
        }
      }
    }

    // OPR.0.4.6.FAC1（ARCH Q2）：绑定实例的结构化角色覆盖检查。仅当步骤角色
    //（或 handler gate 的目标角色）未声明 preferred_targets，且绑定工作组上任意生命周期
    // 状态的席位都未声明该角色时硬失败。检查存在性而非存活性：不做预先实时解析，
    // 但在 instantiate 时抓住拼写错误和缺失 role 属性。入口步骤也包括在内；
    // 它虽会在下方实时解析，但结构缺失用此具名错误表达更清楚。
    if (boundRig !== null) {
      for (const step of specRow.spec.steps) {
        const rolesToCover: string[] = [];
        if (declaredTargetsOf(step.actor_role) === 0) rolesToCover.push(step.actor_role);
        if (step.gate && !isHumanSeatSession(step.gate.target) && declaredTargetsOf(step.gate.target) === 0) {
          rolesToCover.push(step.gate.target);
        }
        for (const roleName of rolesToCover) {
          if (!rigDeclaresRole(this.db, boundRig, roleName)) {
            throw new WorkflowProjectorError(
              "bound_rig_role_uncovered",
              `无法实例化：步骤 "${step.id}" 需要角色 "${roleName}"，但工作组 "${boundRig}" 中没有任何席位（无论生命周期状态）声明该角色。请用 zrig rig add 向工作组 ${boundRig} 添加角色为 ${roleName} 的成员、在现有成员上声明 role: ${roleName}，或在 spec 中为该角色添加 preferred_targets。（允许席位已声明但尚未运行——步骤投影时才检查存活性。）`,
              { specPath: input.specPath, stepId: step.id, role: roleName, boundRig },
            );
          }
        }
      }
    }

    // OPR.0.4.6.FAC3（FR-5）：instantiate 时的 member-exists 建议——在最早可知时刻
    // 响亮抓住错误路由的目标（本后台服务确知工作组中的拼错/陈旧成员），绝不静默孤立。
    // 建议绝不拒绝：instantiate 始终继续，队列 transport 门仍只检查工作组存在；
    // 若强化为 member-exists，会门控每次队列写入并破坏合法非受管目标
    //（已采纳席位、人类席位、MH-3 转发条目）。事务前只读扫描 spec 声明的 target，
    // 且只用同步 SQL。
    //
    // 作用域 = 步骤引用的角色（actor_role + handler gate 目标角色，与上方结构覆盖检查
    // 遍历同一引用集）：建议必须点名声明步骤，未引用角色的 target 永不路由。跳过顺序沿用
    // queue-gate 原型：先按 transport 所用同一谓词判断 human-seat → 跳过非 canonical
    //（原始/已采纳目标合法，inventory 无法为其担保）→ 跳过未登记工作组
    //（transport 已在队列写入时响亮拒绝，不重复建议）→ member 探针（任意生命周期/种类下
    // 的存在性；存活性归投影负责）。每个唯一未知 target 只生成一条聚合建议，
    // 点名每个声明它的步骤/角色对。
    {
      const unknownTargets = new Map<
        string,
        { rig: string; declaredBy: Array<{ stepId: string; role: string }> }
      >();
      const seenPairs = new Set<string>();
      const probeRoleTargets = (roleName: string, stepId: string): void => {
        for (const target of specRow.spec.roles?.[roleName]?.preferred_targets ?? []) {
          if (isHumanSeatSession(target)) continue;
          const parsed = parseSessionName(target);
          if (parsed.kind !== "canonical") continue;
          if (!rigIsRegistered(parsed.rig)) continue;
          let memberExists: boolean;
          try {
            memberExists = rigMemberExists(this.db, parsed.rig, target);
          } catch {
            // 建议绝不抛错（VM run-1 捕获）：探针依赖完整 inventory 投影，后者在部分 schema
            // 数据库（如缺 snapshots 表的测试 fixture）上可能出错。探针错误意味着 inventory
            // 无法证明任一方向——静默跳过；建议路径绝不能使 instantiate 失败。
            continue;
          }
          if (memberExists) continue;
          const pairKey = JSON.stringify([target, stepId, roleName]);
          if (seenPairs.has(pairKey)) continue;
          seenPairs.add(pairKey);
          const entry = unknownTargets.get(target) ?? { rig: parsed.rig, declaredBy: [] };
          entry.declaredBy.push({ stepId, role: roleName });
          unknownTargets.set(target, entry);
        }
      };
      for (const step of specRow.spec.steps) {
        probeRoleTargets(step.actor_role, step.id);
        if (step.gate && !isHumanSeatSession(step.gate.target)) {
          probeRoleTargets(step.gate.target, step.id);
        }
      }
      for (const [target, { rig, declaredBy }] of unknownTargets) {
        const declares = declaredBy
          .map((d) => `步骤 "${d.stepId}"（角色 "${d.role}"）`)
          .join(", ");
        advisories.push(
          `preferred target "${target}" 指向已登记工作组 "${rig}"，但其中没有成员使用该坐标——声明位置：${declares}。` +
            `路由到此处的工作不会被认领，并会表现为卡住异常。` +
            `请用 \`zrig ps\` 核对成员名称，或将该成员添加到工作组 "${rig}"。`,
        );
      }
    }

    // OPR.0.4.6.WF2 FR-5：带 gate 的入口步骤编译为 gate 条目（路由到 human 或 handler），
    // 实例从诞生起就停驻等待，与流程中途 gate 使用同一接口。
    // OPR.0.4.6.FAC1（ARCH Q2/调用点第 3 行）：入口步骤在 instantiate 时进行完整实时解析
    // 并记录；入口 packet 此刻实际创建，是第一次路由决策。因此这是一次性解析，
    // 不是预先解析。此处第 3 层失败会以入口错误码重新抛出，并保留 candidates。
    const entryRoleCtx = roleResolutionContext(this.db, boundRig);
    let entryGate: GateCompileResult | null;
    let entryOwner: string | null;
    try {
      entryGate = entryStep.gate
        ? compileGate(specRow.spec, entryStep, runtimeOf, entryRoleCtx)
        : null;
      if (entryGate) {
        entryOwner = entryGate.destinationSession;
      } else if (input.entryOwnerSession) {
        reconcileExplicitOwnerHarness(entryStep, input.entryOwnerSession, runtimeOf);
        entryOwner = input.entryOwnerSession;
      } else {
        entryOwner = resolveDefaultOwner(specRow.spec, entryStep, runtimeOf, entryRoleCtx);
      }
    } catch (err) {
      if (err instanceof WorkflowProjectorError && err.code === "next_owner_unresolved") {
        // entry_owner_unresolved 会列出候选：保留相同结构化详情和入口点错误码契约。
        throw new WorkflowProjectorError(
          "entry_owner_unresolved",
          `无法实例化：${err.message}`,
          { specPath: input.specPath, entryStepId: entryStep.id, entryRole: entryStep.actor_role, ...(err.details ?? {}) },
        );
      }
      throw err;
    }
    if (!entryOwner) {
      throw new WorkflowProjectorError(
        "entry_owner_unresolved",
        `无法实例化：入口步骤 "${entryStep.id}"（角色 "${entryStep.actor_role}"）没有 preferred_targets，也未提供 entryOwnerSession`,
        { specPath: input.specPath, entryStepId: entryStep.id, entryRole: entryStep.actor_role },
      );
    }

    const createdAt = this.now().toISOString();
    const preallocatedEntryQitemId = newQitemId();
    let entryQitemId: string | undefined;
    let entryQitemDestinationSession: string | undefined;
    let entryQitemNudge: boolean | undefined;
    let instanceId: string | undefined;
    this.eventBus.withNotifyEnvelope((register) => {
      const instance = this.instanceStore.create({
        workflowName: specRow.name,
        workflowVersion: specRow.version,
        createdBySession: input.createdBySession,
        initialFrontier: [],
        // R2 修复：instantiate 时设置持久 current_step_id，使 projector 首次调用
        // project() 时无需基于 trail 推断即可解析正确步骤。
        currentStepId: entryStep.id,
        // OPR.0.4.6.FAC1：已解析工作组绑定随实例行持久化，与入口 packet 同一事务。
        boundRig,
        lifecycle: input.lifecycle
          ? {
              ...input.lifecycle,
              binding: { ...input.lifecycle.binding, entryQitemId: preallocatedEntryQitemId },
            }
          : undefined,
      });
      instanceId = instance.instanceId;

      // 在同一事务中创建入口 qitem；它感知 gate，带 gate 的入口复用已交付的
      // human-route / handler-route 写路径。
      // OPR.0.4.6.WF5 FR-1 类别 (c)（guard code-review 折叠；projector 流程中途
      // 戳记的入口孪生）：由 HUMAN 门控的 ENTRY 在 WF-2 条目自身携带类别 (c) 异常身份，
      // occurrence = 预分配 packet id。handler-role 入口保持反例。
      const entryGateQitemId = preallocatedEntryQitemId;
      const entryGateException =
        entryGate && entryGateQitemId
          ? classifyGateTrip({
              workflowName: specRow.name,
              instanceId: instance.instanceId,
              gatedStepId: entryStep.id,
              gateKind: entryGate.kind,
              gatePacketId: entryGateQitemId,
              parkOn: entryGate.parkOn,
            })
          : null;
      const created = this.queueRepo.createWithinTransaction({
        qitemId: entryGateQitemId,
        sourceSession: input.createdBySession,
        destinationSession: entryOwner,
        body: workflowInstantiateBody({
          binding: instance.lifecycleBinding,
          library: this.guidanceLibrary,
          spec: specRow.spec,
          instanceId: instance.instanceId,
          entryStep,
          rootObjective: input.rootObjective,
          gate: entryGate,
          packetId: entryGateQitemId,
          ownerSession: entryOwner,
        }),
        priority: "routine",
        tier: entryGate?.tier ?? "mode2",
        tags: [
          "workflow",
          entryGate ? "gate" : "entry",
          `workflow:${specRow.name}`,
          `instance:${instance.instanceId}`,
          ...(entryGateException ? workflowExceptionTags(entryGateException.identity).filter((t) => !t.startsWith("workflow:") && !t.startsWith("instance:")) : []),
        ],
        summary: entryGate?.summary ?? undefined,
        evidenceRef: entryGate?.evidenceRef ?? undefined,
      });
      entryQitemId = created.qitemId;
      entryQitemDestinationSession = created.destinationSession;
      entryQitemNudge = created.nudge;
      register(created.persistedEvent);

      const packetAddressed = specRow.spec.steps.some((step) => step.depends_on !== undefined);
      if (packetAddressed) {
        this.instanceStore.bindFrontierPacket({
          instanceId: instance.instanceId,
          packetId: created.qitemId,
          stepId: entryStep.id,
        });
      }

      // OPR.0.4.6.WF2 FR-5（guard blocker 1）：HUMAN 门控入口在同一事务中停驻——
      // 这是已交付 resolve 动词所操作的 leg-1 blocked_on human-seat 形状，
      // 与 projector 的流程中途 gate park 相同。
      if (entryGate?.parkOn) {
        const parked = this.queueRepo.updateWithinTransaction({
          qitemId: created.qitemId,
          actorSession: input.createdBySession,
          state: "blocked",
          closureReason: "blocked_on",
          closureTarget: entryGate.parkOn,
          blockedOn: entryGate.parkOn,
          transitionNote: `工作流门控：停驻在 ${entryGate.parkOn}，等待确认`,
        });
        register(parked.persistedEvent);
      }

      this.instanceStore.updateFrontier(instance.instanceId, [created.qitemId], entryGate ? "waiting" : "active", {
        // FR-5：即便此处也要守卫——实例在本事务中以 version 0 创建；
        // 一致性要求每次推进都受守卫。
        expectedVersion: instance.version,
      });

      // FR-3：在创建入口 packet 的同一事务内武装 packet 寻址 keepalive
      //（或旧版 instance job）。从第一步起覆盖“提交后、nudge 前崩溃”的窗口。
      if (this.watchdogJobsRepo) {
        ensureWorkflowKeepaliveArmed(this.watchdogJobsRepo, {
          instanceId: instance.instanceId,
          targetSession: entryOwner,
          registeredBySession: input.createdBySession,
          packetId: packetAddressed ? created.qitemId : undefined,
        });
      }

      register(
        this.eventBus.persistWithinTransaction({
          type: "workflow.instantiated",
          instanceId: instance.instanceId,
          workflowName: specRow.name,
          workflowVersion: specRow.version,
          createdBy: input.createdBySession,
        }),
      );
    });
    if (entryQitemId && entryQitemDestinationSession) {
      await this.queueRepo.maybeNudge(entryQitemId, entryQitemDestinationSession, entryQitemNudge);
    }

    const finalInstance = this.instanceStore.getByIdOrThrow(instanceId!);
    return {
      instance: finalInstance,
      spec: specRow,
      entryQitemId: entryQitemId!,
      entryOwnerSession: entryOwner,
      advisories,
      replayed: false,
    };
  }

  async project(input: ProjectStepInput): Promise<ProjectStepResult> {
    const result = await this.projector.project(input);
    this.reconcileStuckExceptions(input.instanceId);
    return result;
  }

  /** 重新检查每个已记录逾期 packet，绝不借用同级项裁决。决定与关闭共享事务；
   * 启动扫描修复 project 后崩溃。 */
  reconcileStuckExceptions(instanceId?: string): number {
    let closed = 0;
    this.eventBus.withNotifyEnvelope((register) => {
      const rows = this.db.prepare(`SELECT qitem_id, tags FROM queue_items
        WHERE state IN ('pending','in-progress','blocked') AND json_valid(tags)
          AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'workflow-exception')
          AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'exception:stuck_overdue')
          AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?))`
      ).all(instanceId ?? null, `instance:${instanceId}`) as Array<{ qitem_id: string; tags: string }>;
      for (const row of rows) {
        const tags: unknown = JSON.parse(row.tags);
        if (!Array.isArray(tags)) continue;
        const one = (prefix: string): string | undefined => {
          const values = tags.filter((tag) => typeof tag === "string" && tag.startsWith(prefix));
          return values.length === 1 ? values[0]!.slice(prefix.length) : undefined;
        };
        const id = one("instance:");
        const packetId = one("occurrence:");
        if (!id || !packetId) continue;
        const instance = this.instanceStore.getById(id);
        const packet = this.queueRepo.getById(packetId);
        // 未知或冲突的出处不能证明已恢复。
        if (!instance || !packet || one("workflow:") !== instance.workflowName
          || !packet.tags?.includes(`instance:${id}`)
          || !packet.tags?.includes(`workflow:${instance.workflowName}`)) continue;
        if (!["active", "waiting", "completed", "failed", "aborted"].includes(instance.status)) continue;
        const live = instance.currentFrontier.includes(packetId)
          && (instance.status === "active" || instance.status === "waiting");
        if (live) {
          const anchor = packet.state === "in-progress"
            ? packet.closureRequiredAt ?? packet.claimedAt ?? packet.tsCreated : packet.tsCreated;
          if (!Number.isFinite(Date.parse(anchor))) continue;
          const binding = this.instanceStore.getFrontierBinding(id, packetId);
          const verdict = evaluateStepDeadline({ ...instance, currentFrontier: [packetId],
            currentStepId: binding?.stepId ?? instance.currentStepId }, [packet], this.now());
          if (verdict.state !== "healthy") continue;
        }
        const updated = this.queueRepo.updateWithinTransaction({
          qitemId: row.qitem_id, actorSession: instance.createdBySession,
          state: "done", closureReason: "no-follow-on",
          transitionNote: `工作流逾期事件已解决：实例 ${id}，packet ${packetId}；${live ? `packet 状态为 ${packet.state}，且已不再逾期` : "packet 已不再是活动 frontier 义务"}`,
        });
        register(updated.persistedEvent);
        closed += 1;
      }
    });
    return closed;
  }

  inspect(instanceId: string): {
    instance: WorkflowInstance;
    frontier: Array<{
      packetId: string;
      stepId: string | null;
      ownerSession: string | null;
      queueState: string | null;
      blockedOn: string | null;
      targetedAction: "project" | "route" | "indeterminate";
      dependsOn: string[];
      gate: WorkflowStepSpec["gate"] | null;
      acceptance: WorkflowStepSpec["acceptance"] | null;
      receiptRequired: boolean;
      deadline: WorkflowDeadlineVerdict;
      waiting: import("./queue-waiting.js").WaitingView | null;
    }>;
    failures: Array<WorkflowFailureOccurrence & { targetedAction: "resume" | "none" }>;
    unknowns: string[];
    boundaryObligations: LifecycleObligation[];
  } {
    const instance = this.instanceStore.getByIdOrThrow(instanceId);
    const unknowns: string[] = [];
    const spec = this.specCache.getByNameVersion(instance.workflowName, instance.workflowVersion)?.spec;
    const frontier = instance.currentFrontier.map((packetId) => {
      const binding = this.instanceStore.getFrontierBinding(instanceId, packetId);
      const packet = this.queueRepo.getById(packetId);
      const stepId = binding?.stepId ?? (instance.currentFrontier.length === 1 ? instance.currentStepId : null);
      const step = stepId ? spec?.steps.find((candidate) => candidate.id === stepId) : undefined;
      if (!binding && instance.currentFrontier.length > 1) unknowns.push(`frontier packet ${packetId} 没有唯一的步骤绑定`);
      if (!packet) unknowns.push(`frontier packet ${packetId} 没有队列记录`);
      return {
        packetId,
        stepId,
        ownerSession: packet?.destinationSession ?? null,
        queueState: packet?.state ?? null,
        blockedOn: packet?.blockedOn ?? null,
        waiting: packet?.waiting ?? null,
        targetedAction: stepId && packet ? "project" as const : "indeterminate" as const,
        dependsOn: step?.depends_on ?? [],
        gate: step?.gate ?? null,
        acceptance: step?.acceptance ?? null,
        receiptRequired: stepId !== null && requiredLifecycleSteps(instance.lifecycleBinding).includes(stepId),
        deadline: evaluateStepDeadline(
          { ...instance, currentFrontier: [packetId], currentStepId: stepId },
          packet ? [packet] : [],
          this.now(),
        ),
      };
    });
    const failureResumeAvailable = instance.status !== "completed" && instance.status !== "aborted";
    const failures = this.instanceStore.listFailureOccurrences(instanceId).map((failure) => ({
      ...failure,
      targetedAction: failure.status === "unresolved" && failureResumeAvailable
        ? "resume" as const
        : "none" as const,
    }));
    return { instance, frontier, failures, unknowns, boundaryObligations: lifecycleObligations(this.db, instanceId, instance.lifecycleBinding, spec?.steps ?? [], instance.currentFrontier) };
  }

  async abort(input: { instanceId: string; reason: string; actorSession: string }): Promise<{
    instanceId: string;
    closedPacketIds: string[];
    status: "aborted";
  }> {
    if (!input.reason.trim()) {
      throw new WorkflowProjectorError("abort_reason_required", "中止工作流需要非空原因");
    }
    const closedPacketIds: string[] = [];
    this.eventBus.withNotifyEnvelope((register) => {
      const instance = this.instanceStore.getByIdOrThrow(input.instanceId);
      if (instance.status === "completed" || instance.status === "aborted") {
        throw new WorkflowProjectorError("instance_not_abortable", `实例 ${instance.instanceId} 当前状态为 ${instance.status}`, { instanceId: instance.instanceId, status: instance.status });
      }
      const spec = this.specCache.getByNameVersion(instance.workflowName, instance.workflowVersion)?.spec;
      const bindingByPacket = new Map(this.instanceStore.listFrontierBindings(instance.instanceId).map((binding) => [binding.packetId, binding]));
      const closedAt = this.now().toISOString();
      for (const packetId of instance.currentFrontier) {
        const packet = this.queueRepo.getById(packetId);
        if (!packet) throw new WorkflowProjectorError("packet_not_found", `未找到 frontier packet ${packetId}`, { instanceId: instance.instanceId, packetId });
        const binding = bindingByPacket.get(packetId);
        const stepId = binding?.stepId ?? (instance.currentFrontier.length === 1 ? instance.currentStepId : null);
        if (!stepId) throw new WorkflowProjectorError("frontier_binding_indeterminate", `无法中止：packet ${packetId} 没有步骤绑定`, { instanceId: instance.instanceId, packetId });
        const step = spec?.steps.find((candidate) => candidate.id === stepId);
        const closed = this.queueRepo.updateWithinTransaction({
          qitemId: packetId,
          actorSession: input.actorSession,
          viaWorkflowVerb: true,
          state: "canceled",
          transitionNote: `工作流由 ${input.actorSession} 中止：${input.reason}`,
        });
        register(closed.persistedEvent);
        this.trailLog.record({
          instanceId: instance.instanceId,
          stepId,
          stepRole: step?.actor_role ?? "unknown",
          closedAt,
          closureReason: "failed",
          closureEvidence: { abort: { reason: input.reason, actorSession: input.actorSession } },
          actorSession: input.actorSession,
          nextQitemId: null,
          priorQitemId: packetId,
        });
        this.instanceStore.removeFrontierBinding(instance.instanceId, packetId);
        closedPacketIds.push(packetId);
      }
      this.instanceStore.updateFrontier(instance.instanceId, [], "aborted", {
        currentStepId: "clear",
        completedAt: closedAt,
        expectedVersion: instance.version,
        lastContinuationDecision: { action: "abort", actorSession: input.actorSession, reason: input.reason, closedPacketIds },
      });
      if (this.watchdogJobsRepo) disarmAllWorkflowKeepalives(this.watchdogJobsRepo, instance.instanceId, `workflow_aborted: ${input.reason}`);
      register(this.eventBus.persistWithinTransaction({ type: "workflow.failed", instanceId: instance.instanceId, workflowName: instance.workflowName, reason: `已中止：${input.reason}` }));
    });
    return { instanceId: input.instanceId, closedPacketIds, status: "aborted" };
  }

  /**
   * OPR.0.4.6.WF3 FR-4——`route`：把存活实例的当前 frontier 步骤重新指向新 owner。
   * 经裁决的机制（架构正式决定，基于推进权威）：在一个 scribe 事务中完成
   * CLOSE + RECREATE + FRONTIER REBIND。撤销是结构性的：旧 packet 在事务内离开 frontier，
   * 因此僵尸旧 owner 的陈旧 `project` 会命中已交付的 `packet_not_on_frontier` 409；
   * 热推进路径不增加任何新校验机制，这是权衡后否决的替代方案。
   *
   * 可观察契约（PRD FR-4 第 1-8 条）：
   *   (1) route 后 owner = target          (5) frontier 不悬空
   *   (2) current_step_id 不变             (6) 增量事件详情
   *   (3) actor+reason+old→new 持久化      (7) pin + version 守卫成立
   *   (4) 不伪造完成 closure               (8) 僵尸从结构上得到 409
   * Route 不是推进：hop_count 不增加（max_hops 统计步骤而非重定向）；
   * BR-3——`project` 仍是唯一推进操作。
   */
  /**
   * OPR.0.4.6.WF5 FR-4——从停止位置 RESUME（redrive 语义，唯一的引擎扩展）。
   * 一个 scribe 事务完成：failed → active，反弹到失败步骤；向重新解析的步骤 owner
   * 创建新 frontier packet；保留并扩展 trail（已完成步骤绝不重跑）；重新设定 livelock
   * 基线（resume 后 hop，恰好再给一个有界窗口）；记录 redrive 次数；关闭本次 occurrence
   * 的开放异常条目（resolve+resume 关闭该 occurrence，后续再失败是新 occurrence）；
   * 重新武装 keepalive，并发出增量 workflow.resumed 事件。
   *
   * 架构固定点（计划 Rev-2，强约束）：owner 必须通过投影所用的同一解析路径重新解析
   *（resolveDefaultOwner——preferred_targets + harness 对账），绝不从已关闭 packet
   * 的记录目标复制。已死席位常常正是异常原因，而 resume 是唯一获准的重新解析点
   *（FAC-1 R1），绑定层以后可统一升级它。
   */
  async resume(input: {
    instanceId: string;
    occurrenceId?: string;
    decision?: string;
    actorSession: string;
  }): Promise<{
    instanceId: string;
    stepId: string;
    newPacketId: string;
    ownerSession: string;
    resumeCount: number;
    exceptionItemsClosed: number;
    absorbedReplay?: boolean;
  }> {
    const occurrences = this.instanceStore.listFailureOccurrences(input.instanceId);
    if (input.occurrenceId || occurrences.length > 0) {
      return this.resumeFailureOccurrence(input);
    }
    let result!: {
      instanceId: string;
      stepId: string;
      newPacketId: string;
      ownerSession: string;
      resumeCount: number;
      exceptionItemsClosed: number;
    };
    let nudgeTo: { qitemId: string; session: string; nudge: boolean | undefined } | null = null;

    this.eventBus.withNotifyEnvelope((register) => {
      const instance = this.instanceStore.getByIdOrThrow(input.instanceId);
      if (instance.status !== "failed") {
        throw new WorkflowProjectorError(
          "instance_not_failed",
          `实例 ${instance.instanceId} 当前状态为 ${instance.status}；resume 只能重新驱动 FAILED 实例（waiting 实例通过已交付的 project 路径恢复，active 实例无需 resume）` ,
          { instanceId: instance.instanceId, status: instance.status, expectedStatus: "failed" },
        );
      }
      const specRow = this.specCache.getByNameVersion(instance.workflowName, instance.workflowVersion);
      if (!specRow) {
        throw new WorkflowProjectorError(
          "spec_not_cached",
          `工作流 spec ${instance.workflowName}@${instance.workflowVersion} 不在 spec 缓存中；恢复前请重新运行 validate 刷新`,
          { workflowName: instance.workflowName, workflowVersion: instance.workflowVersion },
        );
      }
      const spec = specRow.spec;
      const decision = (instance.lastContinuationDecision ?? {}) as {
        currentStep?: string;
        closedPacket?: string;
      };
      const failedStepId = decision.currentStep;
      const failedPacketId = decision.closedPacket;
      if (!failedStepId) {
        throw new WorkflowProjectorError(
          "resume_step_unrecoverable",
          `实例 ${instance.instanceId} 没有记录失败步骤（R2 前记录缺少 lastContinuationDecision.currentStep）；无法重新绑定——请实例化一次新运行`,
          { instanceId: instance.instanceId },
        );
      }
      const step = spec.steps.find((st) => st.id === failedStepId);
      if (!step) {
        throw new WorkflowProjectorError(
          "resume_step_missing_from_spec",
          `失败步骤 "${failedStepId}" 已不在 ${instance.workflowName}@${instance.workflowVersion} 中；请修复 spec（对运行中实例以缓存版本为准）或实例化一次新运行`,
          { instanceId: instance.instanceId, stepId: failedStepId },
        );
      }

      // 架构固定点：重新解析，绝不复制。OPR.0.4.6.FAC1（调用点第 5 行）：resume 是唯一
      // 获准的重新解析点，现在运行完整层级栈——绑定实例中仅角色的失败步骤会基于当前 inventory
      // 感知能力地重新解析；已死席位常是异常原因，redrive 应选择现在合格的席位。
      const owner = resolveDefaultOwner(
        spec,
        step,
        (session) => nodeRuntimeOf(this.db, session),
        roleResolutionContext(this.db, instance.boundRig),
      );
      if (!owner) {
        throw new WorkflowProjectorError(
          "next_owner_unresolved",
          `无法为失败步骤 "${step.id}"（角色 "${step.actor_role}"）解析 owner；恢复前请为该角色添加 preferred_targets`,
          { instanceId: instance.instanceId, stepId: step.id, role: step.actor_role },
        );
      }

      // 新 frontier packet——redrive 投递。--decision 文本持久写入 packet body，
      // 使恢复者指令到达步骤 owner。
      const redrivePacketId = newQitemId();
      const created = this.queueRepo.createWithinTransaction({
        qitemId: redrivePacketId,
        sourceSession: input.actorSession,
        destinationSession: owner,
        body: withWorkflowContinuation({
          binding: instance.lifecycleBinding,
          library: this.guidanceLibrary,
          body:
            `工作流恢复（重新驱动）\n` +
            `工作流：${instance.workflowName} v${instance.workflowVersion}\n` +
            `实例：${instance.instanceId}\n` +
            `步骤：${step.id}（角色 ${step.actor_role}）——从已记录失败处重新驱动；已完成步骤不会重跑\n` +
            `恢复者：${input.actorSession}（第 ${(instance.resumeCount ?? 0) + 1} 次重新驱动）\n` +
            (input.decision ? `决策：${input.decision}\n` : "") +
            `历史：zrig workflow trace ${instance.instanceId}`,
          instanceId: instance.instanceId,
          packetId: redrivePacketId,
          ownerSession: owner,
          step,
          contextRefs: specRow.spec.context_refs,
        }),
        priority: "routine",
        tier: "mode2",
        tags: [
          "workflow",
          "resume",
          `workflow:${instance.workflowName}`,
          `instance:${instance.instanceId}`,
        ],
        chainOfRecord: failedPacketId ? [failedPacketId] : undefined,
      });
      register(created.persistedEvent);
      nudgeTo = { qitemId: created.qitemId, session: created.destinationSession, nudge: created.nudge };
      // P34：在此事务内暂存 redrive packet 的唤醒意图。
      this.queueRepo.stageWakeIntent(
        created.qitemId,
        input.actorSession,
        created.destinationSession,
        null,
        created.nudge,
      );

      // resolve+resume 会关闭 occurrence：本 episode 的开放异常条目带 resume 出处诚实关闭。
      // 后续再次失败会生成新 packet id，即新 occurrence，绝不藏在已解决历史之后。
      const exceptionItemsClosed = failedPacketId
        ? this.closeFailureExceptions(instance.instanceId, failedPacketId, step.id, input, register)
        : 0;

      // frontier 重绑 + status + 活锁护栏：hops_baseline = resume 时的 hopCount
      //（相同 max_hops 下再给一个新有界窗口），记录 resume_count，并保持版本守卫；
      // 并发 resume 中恰有一个提交。
      this.instanceStore.updateFrontier(instance.instanceId, [created.qitemId], "active", {
        currentStepId: step.id,
        expectedVersion: instance.version,
        resumeStamp: {
          resumeCount: (instance.resumeCount ?? 0) + 1,
          hopsBaseline: instance.hopCount,
        },
      });

      // 为 redrive 后的 owner 重新武装 keepalive（事务内，WF-1 FR-3）。
      if (this.watchdogJobsRepo) {
        ensureWorkflowKeepaliveArmed(this.watchdogJobsRepo, {
          instanceId: instance.instanceId,
          targetSession: owner,
          registeredBySession: input.actorSession,
        });
      }

      register(
        this.eventBus.persistWithinTransaction({
          type: "workflow.resumed",
          instanceId: instance.instanceId,
          workflowName: instance.workflowName,
          stepId: step.id,
          resumedBy: input.actorSession,
          decision: input.decision ?? null,
          resumeCount: (instance.resumeCount ?? 0) + 1,
        }),
      );

      result = {
        instanceId: instance.instanceId,
        stepId: step.id,
        newPacketId: created.qitemId,
        ownerSession: owner,
        resumeCount: (instance.resumeCount ?? 0) + 1,
        exceptionItemsClosed,
      };

      // P34（位置 :791）——这里刻意不做接缝断言。
      //
      // 权威修正，qitem-20260809175537-8e25384f 上的 transition 5764：
      // “意图放在 :791；仅在真实 source->successor 对存在时运行断言。”本事务没有这种配对。
      // 上方 N 个异常关闭都是没有自身 successor 的终态关闭（`no-follow-on`）；
      // redrive packet 自己的 predecessor——失败 packet——在更早事务中关闭，不在本事务。
      //
      // 若把接缝锚定在那些 close 中任一项并对照本 packet，就会把 close 与不属于它的 successor
      // 配成一对；断言会因无关 successor 的意图存在而通过，从而永远不可能失败。
      // 这正是 5764 禁止的配对；本文件旧修订曾只做一次而不是 N 次，同样空洞。
      //
      // redrive packet 的 wake 仍然持久——上方 stageWakeIntent 与本事务原子提交。
      // 缺少的是供接缝回滚核对的配对 close；臆造一个只会换来不验证任何事实的绿色检查。
    });
    // 闭包赋值断言（已交付的提交后惯用法）：TS 无法跟踪事务闭包写入，因此通过断言缩窄。
    const resumeNudge = nudgeTo as { qitemId: string; session: string; nudge: boolean | undefined } | null;
    if (resumeNudge) {
      // P34：经共享 staged-intent 路径投递（认领并完成事务中暂存的行，使恢复不能重发）；
      // 未接入 intent store 时回退到尽力 nudge。
      await this.queueRepo.deliverWakeForSuccessor(
        resumeNudge.qitemId,
        resumeNudge.session,
        resumeNudge.nudge,
        input.actorSession,
      );
    }
    return result;
  }

  /** 在 redrive 事务内调用；只解决此实例的失败 packet。 */
  private closeFailureExceptions(
    instanceId: string,
    failedPacketId: string,
    stepId: string,
    input: { actorSession: string; decision?: string },
    register: (event: PersistedEvent) => void,
  ): number {
    const openItems = this.db.prepare(
      `SELECT qitem_id FROM queue_items
       WHERE state IN ('pending','in-progress','blocked')
         AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'workflow-exception')
         AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)
         AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)`,
    ).all(`instance:${instanceId}`, `occurrence:${failedPacketId}`) as Array<{ qitem_id: string }>;
    for (const row of openItems) {
      const closed = this.queueRepo.updateWithinTransaction({
        qitemId: row.qitem_id,
        actorSession: input.actorSession,
        state: "done",
        closureReason: "no-follow-on",
        transitionNote: `工作流恢复：${input.actorSession} 重新驱动步骤 ${stepId}，事件已解决${input.decision ? `——${input.decision}` : ""}`,
      });
      register(closed.persistedEvent);
    }
    return openItems.length;
  }

  private async resumeFailureOccurrence(input: {
    instanceId: string;
    occurrenceId?: string;
    decision?: string;
    actorSession: string;
  }): Promise<{
    instanceId: string;
    stepId: string;
    newPacketId: string;
    ownerSession: string;
    resumeCount: number;
    exceptionItemsClosed: number;
    absorbedReplay?: boolean;
  }> {
    const all = this.instanceStore.listFailureOccurrences(input.instanceId);
    const selected = input.occurrenceId
      ? all.find((occurrence) => occurrence.occurrenceId === input.occurrenceId)
      : undefined;
    if (selected?.status === "resolved" && selected.redrivePacketId) {
      if (selected.resumeDecision !== (input.decision ?? null)) {
        throw new WorkflowProjectorError(
          "failure_occurrence_replay_conflict",
          `失败事件 ${selected.occurrenceId} 已用不同的决策字节恢复`,
          {
            instanceId: input.instanceId,
            occurrenceId: selected.occurrenceId,
            expectedDecision: selected.resumeDecision,
            attemptedDecision: input.decision ?? null,
          },
        );
      }
      const packet = this.queueRepo.getById(selected.redrivePacketId);
      if (!packet) {
        throw new WorkflowProjectorError("failure_occurrence_replay_indeterminate", `已解决事件 ${selected.occurrenceId} 指向缺失的重新驱动 packet ${selected.redrivePacketId}`, { instanceId: input.instanceId, occurrenceId: selected.occurrenceId });
      }
      const instance = this.instanceStore.getByIdOrThrow(input.instanceId);
      return { instanceId: input.instanceId, stepId: selected.stepId, newPacketId: selected.redrivePacketId, ownerSession: packet.destinationSession, resumeCount: instance.resumeCount, exceptionItemsClosed: 0, absorbedReplay: true };
    }
    const unresolved = all.filter((occurrence) => occurrence.status === "unresolved");
    if (!input.occurrenceId && unresolved.length !== 1) {
      throw new WorkflowProjectorError("failure_occurrence_required", `实例 ${input.instanceId} 有 ${unresolved.length} 个未解决的失败事件；必须提供 --occurrence`, { instanceId: input.instanceId, candidates: unresolved });
    }
    const occurrence = selected ?? unresolved[0];
    if (!occurrence || occurrence.status !== "unresolved") {
      throw new WorkflowProjectorError("failure_occurrence_not_unresolved", `失败事件 ${input.occurrenceId ?? "（未指定）"} 并非未解决状态`, { instanceId: input.instanceId, occurrenceId: input.occurrenceId ?? null });
    }

    let output!: {
      instanceId: string;
      stepId: string;
      newPacketId: string;
      ownerSession: string;
      resumeCount: number;
      exceptionItemsClosed: number;
    };
    let wake: { qitemId: string; session: string; nudge: boolean | undefined } | null = null;
    this.eventBus.withNotifyEnvelope((register) => {
      const instance = this.instanceStore.getByIdOrThrow(input.instanceId);
      if (instance.status === "completed" || instance.status === "aborted") {
        throw new WorkflowProjectorError("instance_not_resumable", `实例 ${instance.instanceId} 当前状态为 ${instance.status}`, { instanceId: instance.instanceId, status: instance.status });
      }
      const specRow = this.specCache.getByNameVersion(instance.workflowName, instance.workflowVersion);
      if (!specRow) throw new WorkflowProjectorError("spec_not_cached", `工作流 spec ${instance.workflowName}@${instance.workflowVersion} 未缓存`);
      const step = specRow.spec.steps.find((candidate) => candidate.id === occurrence.stepId);
      if (!step) throw new WorkflowProjectorError("resume_step_missing_from_spec", `失败步骤 "${occurrence.stepId}" 已不存在`, { instanceId: instance.instanceId, stepId: occurrence.stepId });
      const owner = resolveDefaultOwner(specRow.spec, step, (session) => nodeRuntimeOf(this.db, session), roleResolutionContext(this.db, instance.boundRig));
      if (!owner) throw new WorkflowProjectorError("next_owner_unresolved", `无法为失败步骤 "${step.id}" 解析 owner`);
      const redrivePacketId = newQitemId();
      const created = this.queueRepo.createWithinTransaction({
        qitemId: redrivePacketId,
        sourceSession: input.actorSession,
        destinationSession: owner,
        body: withWorkflowContinuation({
          binding: instance.lifecycleBinding,
          library: this.guidanceLibrary,
          body: `工作流恢复（packet 重新驱动）\n工作流：${instance.workflowName} v${instance.workflowVersion}\n实例：${instance.instanceId}\n事件：${occurrence.occurrenceId}\n步骤：${step.id}\n${input.decision ? `决策：${input.decision}\n` : ""}`,
          instanceId: instance.instanceId,
          packetId: redrivePacketId,
          ownerSession: owner,
          step,
          contextRefs: specRow.spec.context_refs,
        }),
        priority: "routine",
        tier: "mode2",
        tags: ["workflow", "resume", `workflow:${instance.workflowName}`, `instance:${instance.instanceId}`, `occurrence:${occurrence.occurrenceId}`],
        chainOfRecord: [occurrence.failedPacketId],
      });
      register(created.persistedEvent);
      this.queueRepo.stageWakeIntent(created.qitemId, input.actorSession, created.destinationSession, null, created.nudge);
      this.instanceStore.bindFrontierPacket({
        instanceId: instance.instanceId,
        packetId: created.qitemId,
        stepId: occurrence.stepId,
        branchDrive: occurrence.branchDrive + 1,
        hopCount: occurrence.hopCount,
        hopsBaseline: occurrence.hopCount,
      });
      this.instanceStore.resolveFailureOccurrence(instance.instanceId, occurrence.occurrenceId, created.qitemId, input.decision);
      const exceptionItemsClosed = this.closeFailureExceptions(instance.instanceId, occurrence.failedPacketId, step.id, input, register);
      const nextFrontier = [...instance.currentFrontier, created.qitemId];
      const bindings = this.instanceStore.listFrontierBindings(instance.instanceId);
      this.instanceStore.updateFrontier(instance.instanceId, nextFrontier, "active", {
        currentStepId: bindings.length === 1 ? bindings[0]!.stepId : "clear",
        expectedVersion: instance.version,
        resumeStamp: { resumeCount: instance.resumeCount + 1, hopsBaseline: instance.hopCount },
        lastContinuationDecision: { action: "resume_occurrence", occurrenceId: occurrence.occurrenceId, redrivePacketId: created.qitemId, actorSession: input.actorSession, decision: input.decision ?? null },
      });
      if (this.watchdogJobsRepo) ensureWorkflowKeepaliveArmed(this.watchdogJobsRepo, {
        instanceId: instance.instanceId,
        packetId: created.qitemId,
        targetSession: owner,
        registeredBySession: input.actorSession,
      });
      register(this.eventBus.persistWithinTransaction({ type: "workflow.resumed", instanceId: instance.instanceId, workflowName: instance.workflowName, stepId: step.id, occurrenceId: occurrence.occurrenceId, resumedBy: input.actorSession, decision: input.decision ?? null, resumeCount: instance.resumeCount + 1 }));
      wake = { qitemId: created.qitemId, session: created.destinationSession, nudge: created.nudge };
      output = { instanceId: instance.instanceId, stepId: step.id, newPacketId: created.qitemId, ownerSession: owner, resumeCount: instance.resumeCount + 1, exceptionItemsClosed };
    });
    const nudge = wake as { qitemId: string; session: string; nudge: boolean | undefined } | null;
    if (nudge) await this.queueRepo.deliverWakeForSuccessor(nudge.qitemId, nudge.session, nudge.nudge, input.actorSession);
    return output;
  }

  async route(input: {
    instanceId: string;
    packetId?: string;
    toSession: string;
    actorSession: string;
    reason?: string;
  }): Promise<{
    instanceId: string;
    stepId: string | null;
    closedPacketId: string;
    newPacketId: string;
    fromSession: string;
    toSession: string;
    instanceStatus: WorkflowInstance["status"];
  }> {
    let result!: {
      instanceId: string;
      stepId: string | null;
      closedPacketId: string;
      newPacketId: string;
      fromSession: string;
      toSession: string;
      instanceStatus: WorkflowInstance["status"];
    };
    let nudgeTo: { qitemId: string; session: string; nudge: boolean | undefined } | null = null;

    this.eventBus.withNotifyEnvelope((register) => {
      const instance = this.instanceStore.getByIdOrThrow(input.instanceId);
      if (instance.status !== "active" && instance.status !== "waiting") {
        throw new WorkflowProjectorError(
          "instance_not_active",
          `实例 ${instance.instanceId} 当前状态为 ${instance.status}；只有存活的（active|waiting）实例才能重路由`,
          { instanceId: instance.instanceId, status: instance.status },
        );
      }
      let oldPacketId = input.packetId;
      if (!oldPacketId) {
        if (instance.currentFrontier.length !== 1) {
          if (instance.currentFrontier.length === 0) {
            throw new WorkflowProjectorError(
              "packet_not_found",
              `实例 ${instance.instanceId} 的 frontier 为空；没有可重路由的内容`,
              { instanceId: instance.instanceId },
            );
          }
          const candidates = instance.currentFrontier.map((packetId) => {
            const binding = this.instanceStore.getFrontierBinding(instance.instanceId, packetId);
            const packet = this.queueRepo.getById(packetId);
            return { packetId, stepId: binding?.stepId ?? null, ownerSession: packet?.destinationSession ?? null };
          });
          throw new WorkflowProjectorError(
            "frontier_packet_required",
            `实例 ${instance.instanceId} 有 ${instance.currentFrontier.length} 个活动 packet；必须提供 --packet`,
            { instanceId: instance.instanceId, candidates },
          );
        }
        [oldPacketId] = instance.currentFrontier;
      }
      if (!oldPacketId) {
        throw new WorkflowProjectorError(
          "packet_not_found",
          `实例 ${instance.instanceId} 没有可选择的 frontier packet`,
          { instanceId: instance.instanceId },
        );
      }
      if (!instance.currentFrontier.includes(oldPacketId)) {
        throw new WorkflowProjectorError(
          "packet_not_on_frontier",
          `qitem ${oldPacketId} 不在工作流实例 ${instance.instanceId} 的 frontier 中`,
          { instanceId: instance.instanceId, packetId: oldPacketId, frontier: instance.currentFrontier },
        );
      }
      const oldPacket = this.queueRepo.getById(oldPacketId);
      if (!oldPacket) {
        throw new WorkflowProjectorError(
          "packet_not_found",
          `未找到 frontier packet ${oldPacketId}`,
          { instanceId: instance.instanceId, packetId: oldPacketId },
        );
      }
      const fromSession = oldPacket.destinationSession;

      // (7) harness pin：与 projector 对显式 --next-owner 覆盖执行相同对账——
      // 显式 route 目标绝不能静默绕过声明的 pin。
      const specRow = this.specCache.getByNameVersion(instance.workflowName, instance.workflowVersion);
      const oldBinding = this.instanceStore.getFrontierBinding(instance.instanceId, oldPacketId);
      const selectedStepId = oldBinding?.stepId ?? (instance.currentFrontier.length === 1 ? instance.currentStepId : null);
      const step =
        selectedStepId && specRow
          ? specRow.spec.steps.find((s) => s.id === selectedStepId) ?? null
          : null;
      if (step) {
        reconcileExplicitOwnerHarness(step, input.toSession, (session) =>
          nodeRuntimeOf(this.db, session),
        );
      }

      // (3)+(4) 诚实关闭旧 packet：迁移中记录完整出处的 handed_off_to，绝不伪造完成。
      const closed = this.queueRepo.updateWithinTransaction({
        qitemId: oldPacketId,
        actorSession: input.actorSession,
        viaWorkflowVerb: true,
        state: "handed-off",
        closureReason: "handed_off_to",
        closureTarget: input.toSession,
        handedOffTo: input.toSession,
        transitionNote: `工作流路由：${input.actorSession} 将步骤 ${selectedStepId ?? "?"} 从 ${fromSession} 重路由到 ${input.toSession}${input.reason ? `——${input.reason}` : ""}`,
      });
      register(closed.persistedEvent);

      // 为新 owner 重建同一步骤。步骤身份代表工作连续性；qitem id 只是只追加设计的
      // 存储产物。chainOfRecord 串起谱系。
      // 全保真字段携带（rev1-r2 BLOCKING 折叠）：successor 就是同一工作条目，因此保留
      // source packet 的 priority/tier/summary/evidenceRef/targetRepo。由人类门控的 packet
      //（阻塞在人类席位）必须保留 summary + evidence_ref，否则已交付 human-park validator
      // 会以 human_route_fields_required 拒绝下方再次 park，使最需要 route 的 waiting-on-human
      // 类别无法路由。
      const routedPacketId = newQitemId();
      const created = this.queueRepo.createWithinTransaction({
        qitemId: routedPacketId,
        sourceSession: input.actorSession,
        destinationSession: input.toSession,
        body: withWorkflowContinuation({
          binding: instance.lifecycleBinding,
          library: this.guidanceLibrary,
          body: oldPacket.body,
          instanceId: instance.instanceId,
          packetId: routedPacketId,
          ownerSession: input.toSession,
          step: step ?? undefined,
          contextRefs: specRow?.spec.context_refs,
        }),
        priority: oldPacket.priority ?? "routine",
        tier: oldPacket.tier ?? "mode2",
        // OPR.0.4.6.WF5（rev1-r2 B1 折叠）：successor 就是同一工作条目——tags 原样携带
        //（再加 re-route），使已路由的类别 (c) gate 条目在实时 frontier packet 上保留异常身份：
        // workflow-exception/step:/exception:human_gate_trip/occurrence:<原 gate packet id>。
        // occurrence 是 episode，route 不会结束它；chainOfRecord 连接 packet 谱系。
        // 这是 WF-3 全保真携带经验向 tag 维度的扩展。
        tags: Array.from(
          new Set([
            ...(oldPacket.tags ?? []),
            "workflow",
            "re-route",
            `workflow:${instance.workflowName}`,
            `instance:${instance.instanceId}`,
          ]),
        ),
        chainOfRecord: [oldPacketId],
        summary: oldPacket.summary ?? undefined,
        evidenceRef: oldPacket.evidenceRef ?? undefined,
        targetRepo: oldPacket.targetRepo ?? undefined,
      });
      register(created.persistedEvent);
      nudgeTo = { qitemId: created.qitemId, session: created.destinationSession, nudge: created.nudge };
      // P34（位置 :992）：在关闭旧 frontier packet 的同一事务中暂存重路由 packet 的唤醒意图。
      this.queueRepo.stageWakeIntent(
        created.qitemId,
        input.actorSession,
        created.destinationSession,
        null,
        created.nudge,
      );

      // 已停驻（waiting）的 frontier packet 在 successor 上保持停驻；route 只换 owner，
      // 不改记录状态。OPR.0.5.1 slice-51-06 D2：此处不重复提供 summary/evidenceRef。
      // 上方 create（创建侧携带）已把它们放到 successor，validateHumanPark 校验生效值
      //（input ?? item），因此 human re-park 仍可凭携带字段通过。重复提交会使它成为非 park
      // 元数据更新，被 D2 守卫针对非人类 blocker 拒绝，并以 HTTP 500 回滚有效 route。
      // 去掉冗余重提后既保留 create 携带的元数据，也不会触发 D2。
      if (oldPacket.state === "blocked" && oldPacket.blockedOn) {
        const reparked = this.queueRepo.updateWithinTransaction({
          qitemId: created.qitemId,
          actorSession: input.actorSession,
          state: "blocked",
          closureReason: "blocked_on",
          closureTarget: oldPacket.blockedOn,
          blockedOn: oldPacket.blockedOn,
          transitionNote: `工作流路由：保留停驻状态（${oldPacket.blockedOn}）`,
          wakeAfterSeconds: step?.re_present_after_seconds,
          wakeMaxSeconds: step?.re_present_max_seconds,
          wakeMessage:
            step?.re_present_after_seconds !== undefined
              ? workflowWaitWakeMessage({
                  spec: specRow!.spec,
                  instance,
                  step,
                  packetId: routedPacketId,
                  ownerSession: input.toSession,
                })
              : undefined,
        });
        register(reparked.persistedEvent);
      }

      // (2)+(5)+(7) frontier 重绑：同一步骤、新 packet、版本守卫成立；
      // 不增加 hop，因为这不是推进。
      const nextFrontier = instance.currentFrontier.map((packetId) => packetId === oldPacketId ? created.qitemId : packetId);
      if (oldBinding) {
        this.instanceStore.removeFrontierBinding(instance.instanceId, oldPacketId);
        this.instanceStore.bindFrontierPacket({
          instanceId: instance.instanceId,
          packetId: created.qitemId,
          stepId: oldBinding.stepId,
          branchDrive: oldBinding.branchDrive,
          hopCount: oldBinding.hopCount,
          hopsBaseline: oldBinding.hopsBaseline,
        });
      }
      const rebound = this.instanceStore.listFrontierBindings(instance.instanceId);
      this.instanceStore.updateFrontier(instance.instanceId, nextFrontier, instance.status, {
        currentStepId: rebound.length === 1 ? rebound[0]!.stepId : rebound.length > 1 ? "clear" : "preserve",
        expectedVersion: instance.version,
      });

      // 在事务内重定向 keepalive（arch n3：覆盖 route 的 lost-nudge 窗口；
      // 已武装 job 会再次 nudge 新 owner）。
      if (this.watchdogJobsRepo) {
        disarmWorkflowKeepalive(
          this.watchdogJobsRepo,
          instance.instanceId,
          `工作流路由：目标已改为 ${input.toSession}`,
          oldBinding ? oldPacketId : undefined,
        );
        ensureWorkflowKeepaliveArmed(this.watchdogJobsRepo, {
          instanceId: instance.instanceId,
          packetId: oldBinding ? created.qitemId : undefined,
          targetSession: input.toSession,
          registeredBySession: input.actorSession,
        });
      }

      // (6) 对已交付事件形状 {rigName, cause} 做增量扩展。
      register(
        this.eventBus.persistWithinTransaction({
          type: "workflow.routing_table_changed",
          // OPR.0.4.6.FAC1（仅展示）：实例实际绑定的工作组优先于 spec 默认标签。
          rigName: instance.boundRig ?? specRow?.targetRig ?? "",
          cause: "workflow_route",
          instanceId: instance.instanceId,
          stepId: selectedStepId,
          from: fromSession,
          to: input.toSession,
        }),
      );

      result = {
        instanceId: instance.instanceId,
        stepId: selectedStepId,
        closedPacketId: oldPacketId,
        newPacketId: created.qitemId,
        fromSession,
        toSession: input.toSession,
        instanceStatus: instance.status,
      };

      // P34（位置 :992）：W1 接缝，本事务最后一条语句。Route 始终以 handed-off
      // 终态关闭旧 frontier packet，并始终创建 successor，因此这里无条件配对。
      this.queueRepo.assertTerminalClosureHasIntent(oldPacketId, created.qitemId, created.nudge);
    });
    if (nudgeTo) {
      const n = nudgeTo as { qitemId: string; session: string; nudge: boolean | undefined };
      // P34：共享 staged-intent 投递，见上方 resume 路径。
      await this.queueRepo.deliverWakeForSuccessor(n.qitemId, n.session, n.nudge, input.actorSession);
    }
    return result;
  }

  /**
   * Continue：实例当前 frontier 的幂等检查器。v1 只读并返回当前状态。
   * POC 的机械推进已在 v1 折入 project()；continue() 是审计/检查入口。
   */
  continue(instanceId: string): {
    instance: WorkflowInstanceWithDeadline;
    trail: WorkflowStepTrailEntry[];
    guidance: ReturnType<WorkflowRuntime["guidance"]>;
    reconciliation: ReturnType<typeof inspectGraph>;
    frontier: ReturnType<WorkflowRuntime["inspect"]>["frontier"];
    failures: ReturnType<WorkflowRuntime["inspect"]>["failures"];
    unknowns: string[];
    boundaryObligations: LifecycleObligation[];
  } {
    const instance = this.instanceStore.getByIdOrThrow(instanceId);
    const trail = this.trailLog.listForInstance(instanceId);
    const inspected = this.inspect(instanceId);
    return {
      instance: this.withDeadline(instance),
      trail,
      guidance: this.guidance(instanceId),
      reconciliation: this.inspectGraph(instanceId),
      frontier: inspected.frontier,
      failures: inspected.failures,
      unknowns: inspected.unknowns,
      boundaryObligations: inspected.boundaryObligations,
    };
  }

  /**
   * OPR.0.4.6.WF1 FR-2 完成态回补（构建结果与已批准 AC 之间的技术债，
   * qitem-20260706211220-279039f5）：已批准的 FR-2 AC 要求卡住分类能够
   * “通过 list/show/trace 查询……并附带证据（step、owner、deadline、age）”。
   * 合并后的 WF-1 构建只通过启动扫描和 keepalive nudge 暴露该信息；这里在读取时
   * 推导同一个 evaluator 裁决（阈值唯一来源为 workflow-deadline.ts），补齐可查询性条款。
   *
   * 只推导，绝不存储：每次读取都根据（instance、frontier packets、now）重新计算；
   * 正常重新投影会自动清除该状态，与其他 evaluator 使用方完全一致。公开完整分类元组
   *（state + evidence{step, owner, anchor, anchorAt, overdueBySeconds, ageSeconds}），
   * 让两个使用方（WF-3 状态汇总和 WF-5 FR-3 ▲ 来源）读取同一种结构——
   * 不压平成布尔值，也不引入第二条路径。
   */
  deadlineFor(instance: WorkflowInstance): WorkflowDeadlineVerdict {
    const packets = instance.currentFrontier
      .map((id) => this.queueRepo.getById(id))
      .filter((p): p is NonNullable<typeof p> => p != null);
    return evaluateStepDeadline(instance, packets, this.now());
  }

  /** 供 list/show/trace 路由使用的增量读取信息。 */
  withDeadline(instance: WorkflowInstance): WorkflowInstanceWithDeadline {
    return { ...instance, deadline: this.deadlineFor(instance) };
  }

  /** 列出实例（可选过滤），并附加 deadline 裁决。 */
  listInstancesWithDeadline(
    status?: "active" | "waiting" | "completed" | "failed" | "aborted",
  ): WorkflowInstanceWithInspection[] {
    const rows = status ? this.instanceStore.listByStatus(status) : this.instanceStore.listAll();
    return rows.map((row) => {
      const inspected = this.inspect(row.instanceId);
      return {
        ...this.withDeadline(row),
        frontierPackets: inspected.frontier,
        failureOccurrences: inspected.failures,
        unknowns: inspected.unknowns,
        boundaryObligations: inspected.boundaryObligations,
      };
    });
  }
}

/** WorkflowInstance 加推导出的 FR-2 deadline 裁决（增量读取结构）。 */
export type WorkflowInstanceWithDeadline = WorkflowInstance & {
  deadline: WorkflowDeadlineVerdict;
};

export type WorkflowInstanceWithInspection = WorkflowInstanceWithDeadline & {
  frontierPackets: ReturnType<WorkflowRuntime["inspect"]>["frontier"];
  failureOccurrences: ReturnType<WorkflowRuntime["inspect"]>["failures"];
  boundaryObligations: LifecycleObligation[];
  unknowns: string[];
};

function workflowInstantiateBody(input: {
  binding?: GuidanceInput["binding"];
  library?: GuidanceInput["library"];
  spec: Pick<WorkflowSpec, "id" | "version" | "context_refs">;
  instanceId: string;
  entryStep: WorkflowStepSpec;
  rootObjective: string;
  gate?: GateCompileResult | null;
  packetId: string;
  ownerSession: string;
}): string {
  const lines = [
    `### 工作流入口：${input.spec.id}@${input.spec.version} 步骤 ${input.entryStep.id}`,
    "",
    `工作流实例：${input.instanceId}`,
    `入口步骤：${input.entryStep.id} (${input.entryStep.actor_role})`,
    "",
    `根目标：${input.rootObjective}`,
  ];
  if (input.gate) {
    lines.push(
      "",
      `门控：${input.gate.kind === "human" ? "人工确认" : "处理角色检查"}——在此事项解决或关闭前，工作流将保持停驻（等待）状态；之后从本步骤继续。`,
    );
    if (input.gate.summary) lines.push(`请求：${input.gate.summary}`);
    if (input.gate.evidenceRef) lines.push(`证据：${input.gate.evidenceRef}`);
  }
  if (input.entryStep.objective) {
    lines.push("", `步骤目标：${input.entryStep.objective}`);
  }
  return withWorkflowContinuation({
    body: lines.join("\n"),
    contextRefs: input.spec.context_refs,
    binding: input.binding,
    library: input.library,
    instanceId: input.instanceId,
    packetId: input.packetId,
    ownerSession: input.ownerSession,
    step: input.entryStep,
  });
}

export {
  WorkflowInstanceError,
  WorkflowProjectorError,
  WorkflowSpecError,
};
