import type Database from "better-sqlite3";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { StartupAction, StartupProofSelection } from "./types.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  ProjectionResult, StartupDeliveryResult, ForkSource,
} from "./runtime-adapter.js";
import { isAttentionRequiredReadinessCode, resolveConcreteHint } from "./runtime-adapter.js";
import type { ProjectionPlan } from "./projection-planner.js";
import { issueStartupChallenge } from "./startup-proof.js";
import { resolveStartupProof } from "./startup-resolver.js";
import { AppliedLaunchObservationStore } from "./applied-launch-observation-store.js";
import { NativePermissionStore } from "./native-permission-store.js";
import { RigRepository } from "./rig-repository.js";
import type { AppliedLaunchObservation } from "./permission-drift.js";

// -- 类型 --

export interface StartupInput {
  rigId: string;
  nodeId: string;
  sessionId: string;
  binding: NodeBinding;
  adapter: RuntimeAdapter;
  plan: ProjectionPlan;
  resolvedStartupFiles: ResolvedStartupFile[];
  startupActions: StartupAction[];
  isRestore: boolean;
  /** 运行环境启动使用的会话名称（用作 --name 参数）。 */
  sessionName?: string;
  /** 恢复路径使用的恢复令牌，与 forkSource 互斥。 */
  resumeToken?: string;
  /** resumeToken 的运行时原生类型，例如 claude_id 或 codex_id。 */
  resumeType?: string;
  /**
   * 从旧对话创建新席位路径所用的分叉来源，与 resumeToken 互斥。v1 只支持
   * kind="native_id"。新席位持久化的是适配器返回的分叉后令牌，绝不持久化父令牌。
   */
  forkSource?: ForkSource;
  /**
   * 重建模式制品集合，由操作员通过 `session_source.mode: rebuild` 声明。设置后，编排器
   * 会把这些制品合并到启动后交付路径，不带 `resumeToken` 或 `forkSource` 全新启动
   * 运行环境，并在席位上记录 `continuityOutcome: "rebuilt"`。绝不与 `resumeToken` 或
   * `forkSource` 搭配；rebuild 是独立的创建路径。
   */
  rebuildArtifacts?: ResolvedStartupFile[];
  /** 跳过运行环境启动，用于已通过旧辅助逻辑恢复的旧式节点。 */
  skipHarnessLaunch?: boolean;
  /** 原生恢复数据过期时，允许运行时适配器回退到 retry_fresh。 */
  allowFreshFallback?: boolean;
  /** 精确恢复不得用空重放计划覆盖用户编写的全新启动上下文。 */
  preserveStartupContext?: boolean;
  /** 前置条件满足后继续使用同一全新使用者，不再次启动运行环境。 */
  continueFreshStartup?: boolean;
  /** 主动全新替换会保留席位的持久目标义务。 */
  includeDurableObligations?: boolean;
  /** 就绪超时，单位毫秒，默认 30000。 */
  readinessTimeoutMs?: number;
}

export type StartupResult =
  | { ok: true; startupStatus: "ready"; continuityOutcome: "resumed" | "fresh" | "forked" | "rebuilt" }
  // `evidence` 为 `attention_required` 结果携带窗格末尾 N 行，使 restore-orchestrator
  // 的逐节点映射能填充 RestoreNodeResult.attentionEvidence。它只属于内部类型，不会
  // 持久化到失败事件。
  | { ok: false; startupStatus: "attention_required" | "failed"; errors: string[]; evidence?: string };

interface StartupOrchestratorDeps {
  db: Database.Database;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  tmuxAdapter: TmuxAdapter;
  /** 读取文件内容，用于解析具体交付提示。 */
  readFile?: (path: string) => string;
  /** 在由 tmux 驱动的 TUI 中，粘贴与提交之间等待。 */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 驱动单个节点从资源投影走到 startup_status: ready。
 *
 * 执行顺序（NS-T05）：
 * 1. 标记 pending，发出 node.startup_pending
 * 2. 投影资源（文件系统）
 * 3. 交付启动前文件（guidance_merge、skill_install → 文件系统）
 * 4. 通过 adapter.launchHarness() 启动运行环境
 * 5. 等待运行环境就绪（指数退避重试，30 秒超时）
 * 6. 对全新会话，将内置身份锚点作为首条提示注入，并交付剩余启动后文件
 *    （send_text → TUI）
 * 7. 执行 after_files 操作
 * 8. 执行 after_ready 操作
 * 9. 持久化启动上下文与恢复令牌
 * 10. 标记 ready，发出 node.startup_ready
 *
 * 失败时保留 startup_status: failed，节点仍可见。调用方先通过 NodeLauncher 创建
 * 会话和绑定，再以完整启动载荷调用 startNode()。
 */
export class StartupOrchestrator {
  readonly db: Database.Database;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private tmuxAdapter: TmuxAdapter;
  private sleep: (ms: number) => Promise<void>;
  private appliedLaunchStore: AppliedLaunchObservationStore;

  constructor(deps: StartupOrchestratorDeps) {
    if (deps.db !== deps.sessionRegistry.db) throw new Error("StartupOrchestrator：sessionRegistry 必须共享同一个数据库句柄");
    if (deps.db !== deps.eventBus.db) throw new Error("StartupOrchestrator：eventBus 必须共享同一个数据库句柄");
    this.db = deps.db;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.readFile = deps.readFile ?? (() => "");
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.appliedLaunchStore = new AppliedLaunchObservationStore(deps.db);
  }

  private readFile: (path: string) => string;

  async startNode(input: StartupInput): Promise<StartupResult> {
    const guard = this.tmuxAdapter.deliveryGuard;
    if (guard && !guard.ownsLifecycle(input.nodeId)) {
      return guard.lifecycle([input.nodeId], () => this.startNode(input));
    }
    try {
      input = { ...input, binding: new NativePermissionStore(this.db).apply(input.binding, input.adapter.runtime) };
    } catch (error) {
      return this.fail(input, "failed", [`权限选择：${(error as Error).message}`]);
    }
    // #25：启动、恢复重放、重新启动、继续以及新增成员都从这里交付指引，因此工作组的
    // 受管区块目标只需为适配器绑定一次。交接不经过这里：后继者直接启动，并读取已写入
    // 其 cwd 的文件。
    const claudeManagedBlockFile = new RigRepository(this.db).getRigClaudeManagedBlockFile(input.rigId);
    if (claudeManagedBlockFile) input = { ...input, binding: { ...input.binding, claudeManagedBlockFile } };
    const errors: string[] = [];
    let continuityOutcome: "resumed" | "fresh" | "forked" | "rebuilt" = input.resumeToken
      ? "resumed"
      : input.forkSource
        ? "forked"
        : input.rebuildArtifacts && input.rebuildArtifacts.length > 0
          ? "rebuilt"
          : "fresh";
    let appliedLaunch: AppliedLaunchObservation | undefined;
    const launchGeneration = this.sessionRegistry.currentOccupantTenure(input.nodeId)?.generationUuid;

    // 1. 标记为 pending。
    this.sessionRegistry.updateStartupStatus(input.sessionId, "pending");
    const context = input.isRestore ? "restore" : "fresh_start";
    let startupProof: StartupProofSelection;
    try {
      startupProof = resolveStartupProof(input.startupActions, context);
    } catch (err) {
      return this.fail(input, "failed", [`启动证明选择：${(err as Error).message}`]);
    }
    this.eventBus.emit({ type: "node.startup_pending", rigId: input.rigId, nodeId: input.nodeId, startupProof });

    // 2. 投影资源。
    let projectionResult: ProjectionResult;
    try {
      projectionResult = await input.adapter.project(input.plan, input.binding);
      if (projectionResult.failed.length > 0) {
        for (const f of projectionResult.failed) {
          // 保留英文前缀：retry-first-start 会用它识别首次启动在原生运行环境启动前失败的
          // 持久事件。前缀之后的说明可以本地化，但 marker 本身属于兼容协议。
          errors.push(`Projection failed for ${f.effectiveId}: 投影失败：${f.error}`);
        }
        return this.fail(input, "failed", errors);
      }
    } catch (err) {
      // 与上面的失败前缀相同，这是 retry-first-start 识别旧事件所需的稳定 marker。
      errors.push(`Projection error: 投影错误：${(err as Error).message}`);
      return this.fail(input, "failed", errors);
    }

    // 3. 按具体提示划分启动文件：启动前（文件系统）与启动后（TUI）。注意：新的文件构建
    // 路径（NS-T05+）只生成具体提示；auto 回退仅用于兼容 node_startup_context 中 NS-T05
    // 之前持久化的启动上下文。
    //
    // 设置重建模式制品后，将其合并到 resolvedStartupFiles 前面，使启动后交付循环遍历数组
    // 时保留操作员信任优先顺序。解析器会把重建制品标记为 appliesOn: ["fresh_start"]，
    // 与重建上下文一致。
    const sourceFiles = input.rebuildArtifacts && input.rebuildArtifacts.length > 0
      ? [...input.rebuildArtifacts, ...input.resolvedStartupFiles]
      : input.resolvedStartupFiles;
    const applicableFiles = sourceFiles.filter((f) => f.appliesOn.includes(context));
    const preLaunchFiles: ResolvedStartupFile[] = [];
    let postLaunchFiles: ResolvedStartupFile[] = [];
    for (const f of applicableFiles) {
      const hint = f.deliveryHint === "auto"
        ? resolveConcreteHint(f.path, this.safeReadFile(f.absolutePath))
        : f.deliveryHint;
      if (hint === "send_text") {
        postLaunchFiles.push(f);
      } else {
        preLaunchFiles.push(f);
      }
    }

    // 4. 交付启动前文件（文件系统：guidance_merge、skill_install）。即使列表为空也始终调用，
    // 使适配器可以配置运行时专用设置，例如上下文收集器。
    try {
      const deliveryResult = await input.adapter.deliverStartup(preLaunchFiles, input.binding);
      if (deliveryResult.failed.length > 0) {
        for (const f of deliveryResult.failed) {
          errors.push(`启动前文件交付失败：${f.path}：${f.error}`);
        }
        return this.fail(input, "failed", errors);
      }
    } catch (err) {
      errors.push(`启动前交付错误：${(err as Error).message}`);
      return this.fail(input, "failed", errors);
    }

    // 7. 持久化启动上下文，供恢复时重放。
    if (!input.preserveStartupContext) try {
      this.db.prepare(
        "INSERT OR REPLACE INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
      ).run(
        input.nodeId,
        JSON.stringify(input.plan.entries.map((e) => ({ category: e.category, effectiveId: e.effectiveId, sourceSpec: e.sourceSpec, sourcePath: e.sourcePath, resourcePath: e.resourcePath, absolutePath: e.absolutePath, resourceType: e.resourceType, mergeStrategy: e.mergeStrategy, target: e.target }))),
        JSON.stringify(input.resolvedStartupFiles),
        JSON.stringify(input.startupActions),
        input.adapter.runtime,
      );
    } catch (error) {
      return this.fail(input, "failed", [`启动上下文持久化失败：${String(error)}`]);
    }

    // 5. 启动运行环境，旧式节点明确跳过时除外。
    if (!input.skipHarnessLaunch) {
      try {
        let launchResumeToken = input.resumeToken;
        let attemptedFreshFallback = false;

        while (true) {
          const launchResult = await input.adapter.launchHarness(input.binding, {
            name: input.sessionName ?? input.binding.tmuxSession ?? "",
            resumeToken: launchResumeToken,
            ...(input.forkSource && !launchResumeToken ? { forkSource: input.forkSource } : {}),
          });
          if (launchResult.ok) {
            appliedLaunch = launchResult.appliedLaunch;
            const normalizedResumeToken = launchResult.resumeToken?.trim();
            if (normalizedResumeToken) {
              try {
                this.sessionRegistry.updateResumeToken(input.sessionId, launchResult.resumeType ?? "", normalizedResumeToken, "scrape");
              } catch { /* best-effort */ }
            }
            break;
          }

          const shouldRetryFresh =
            !!launchResumeToken
            && input.allowFreshFallback !== false
            && launchResult.recovery === "retry_fresh"
            && !attemptedFreshFallback;

          if (shouldRetryFresh) {
            launchResumeToken = undefined;
            continuityOutcome = "fresh";
            attemptedFreshFallback = true;
            continue;
          }

          // pod 感知的 Codex 认证拒绝（probe → verifyResumeLaunch → recovery:
          // "attention_required"）。将其显示为带证据的 attention_required startup_status，
          // 使 restore-orchestrator 的逐节点映射能返回 status: "attention_required" 与
          // attentionEvidence，与旧式映射保持一致。
          if (launchResult.recovery === "attention_required") {
            // 保留本次尝试的谱系，供之后无输入协调使用，但不认证它；attention 也涵盖 runner
            // 退出或超时。retry_fresh 已清除 launchResumeToken；普通失败不会进入此分支。
            const normalizedResumeToken = launchResumeToken?.trim();
            const normalizedResumeType = input.resumeType?.trim();
            if (normalizedResumeToken && normalizedResumeType) {
              try {
                this.sessionRegistry.recordResumeAttempt(
                  input.sessionId,
                  normalizedResumeType,
                  normalizedResumeToken,
                );
              } catch { /* 尽力而为 */ }
            }
            errors.push(`运行环境启动需要处理：${launchResult.error}`);
            // isRestore 选择上下文而非原生连续性；pod 感知的精确恢复也使用 false。只有真正的
            // 全新启动才能重新预热。
            return this.fail(input, "attention_required", errors, launchResult.evidence, continuityOutcome === "fresh");
          }

          errors.push(`运行环境启动失败：${launchResult.error}`);
          return this.fail(input, "failed", errors);
        }
      } catch (err) {
        errors.push(`运行环境启动错误：${(err as Error).message}`);
        return this.fail(input, "failed", errors);
      }
    }

    // 新精简启动成功后，即使后续就绪检查失败，也会替换使用者的证明边界。启动失败以及
    // resume/adopt 会保留历史。
    const isFreshLaunch = continuityOutcome === "fresh" && (!input.skipHarnessLaunch || input.continueFreshStartup === true);
    const shouldChallenge = isFreshLaunch
      && input.adapter.runtime !== "terminal" && startupProof.mode === "authenticated";
    if (isFreshLaunch && !shouldChallenge) {
      this.eventBus.emit({
        type: "node.startup_proof_skipped", rigId: input.rigId, nodeId: input.nodeId,
        reason: input.adapter.runtime === "terminal" ? "terminal" : "not_selected",
      });
    }

    // 6. 等待运行环境就绪，使用指数退避重试，默认 30 秒超时。
    try {
      const readiness = await this.waitForReady(input.adapter, input.binding, input.readinessTimeoutMs ?? 30_000);
      if (!readiness.ready) {
        if (isAttentionRequiredReadinessCode(readiness.code)) {
          errors.push(`启动需要处理：${readiness.reason ?? "unknown"}`);
          return this.fail(input, "attention_required", errors, undefined, isFreshLaunch);
        }
        errors.push(`就绪检查在 30 秒后超时——运行环境未进入可交互状态：${readiness.reason ?? "unknown"}`);
        return this.fail(input, "failed", errors);
      }
    } catch (err) {
      errors.push(`就绪检查错误：${(err as Error).message}`);
      return this.fail(input, "failed", errors);
    }

    // 适配器返回它实际插入的强制值，且就绪检查证明本次受管启动已存活。持久化刻意采用
    // 尽力而为策略：观测失败会得到 UNKNOWN，绝不会让启动失败。
    if (appliedLaunch && launchGeneration) {
      this.appliedLaunchStore.recordGeneration(launchGeneration, appliedLaunch);
    }

    // 只有运行时能够接收提示后才发出所选证明；在交付任何证明提示前持久化事实。
    const identityAction = this.extractSessionIdentityAction(input.startupActions, context);
    const challenge = shouldChallenge
      ? issueStartupChallenge(this.eventBus, {
          rigId: input.rigId,
          nodeId: input.nodeId,
          contractSource: JSON.stringify(input.resolvedStartupFiles),
        })
      : null;

    // 即使没有 session_identity 操作，所选证明仍然有效：在下方启动后契约文件之后交付其
    // 独立提示。
    const consumedActions = new Set<StartupAction>();
    let challengeOnlyPrompt: string | null = null;
    if (continuityOutcome === "fresh" && identityAction) {
      const initialPrompt = await this.deliverInitialSessionPrompt(input.binding, identityAction, postLaunchFiles, challenge?.promptBlock ?? null, input.includeDurableObligations);
      if (!initialPrompt.ok) {
        errors.push(initialPrompt.error);
        return this.fail(input, "failed", errors);
      }
      postLaunchFiles = initialPrompt.remainingFiles;
    } else if (challenge) {
      challengeOnlyPrompt = challenge.promptBlock;
    }

    // OPR.0.4.7.17 恢复顺序修正（qitem-e99624f7）。恢复已有会话时，触发工作的
    // guidance/role.md 作为启动后 send_text 文件交付（下方步骤 7），会立即开启席位第一轮。
    // 如果之后才在步骤 9 交付 after_ready send_text 的“先加载 Skill 再做其他事”预载，
    // 它会落在工作开始之后，违反已锁定的“操作先于工作”契约。修复必须基于因果顺序，
    // 而不是延长发送等待：恢复时，把适用的 after_ready send_text 预载操作放在第一个
    // 启动后 send_text 文件前，一并作为首轮交付。这相当于全新启动中的
    // deliverInitialSessionPrompt 身份 + role.md 组合。顺序而非时间保证预载先于角色触发的
    // 工作轮次；组合后的操作标记为已消费，步骤 9 不再重复发送。
    if (continuityOutcome !== "fresh") {
      const preloadActions = input.startupActions.filter(
        (a) =>
          !isSessionIdentityAction(a) &&
          a.type === "send_text" &&
          a.phase === "after_ready" &&
          a.appliesOn.includes(context) &&
          !(input.isRestore && !a.idempotent),
      );
      if (preloadActions.length > 0) {
        const preload = await this.deliverRestorePreloadPrompt(input.binding, preloadActions, postLaunchFiles);
        if (!preload.ok) {
          errors.push(preload.error);
          return this.fail(input, "failed", errors);
        }
        postLaunchFiles = preload.remainingFiles;
        for (const a of preloadActions) consumedActions.add(a);
      }
    }

    // 7. 运行环境就绪后交付启动后文件（send_text → TUI）。
    if (postLaunchFiles.length > 0) {
      try {
        const deliveryResult = await input.adapter.deliverStartup(postLaunchFiles, input.binding);
        if (deliveryResult.failed.length > 0) {
          for (const f of deliveryResult.failed) {
            errors.push(`启动后文件交付失败：${f.path}：${f.error}`);
          }
          return this.fail(input, "failed", errors);
        }
      } catch (err) {
        errors.push(`启动后交付错误：${(err as Error).message}`);
        return this.fail(input, "failed", errors);
      }
    }

    // OPR.0.4.3.06 —— 在契约文件之后交付合成的纯 challenge 提示。采用尽力而为策略：
    // 发送失败会让 oriented 如实保持 `missing`，但不会让原本正常的启动失败。
    if (challengeOnlyPrompt && input.binding.tmuxSession) {
      await this.sendInteractiveText(input.binding.tmuxSession, challengeOnlyPrompt);
    }

    // 8. 执行 after_files 操作。
    const afterFilesResult = await this.executeActions(input, "after_files");
    if (!afterFilesResult.ok) {
      return this.fail(input, "failed", afterFilesResult.errors);
    }

    // 9. 执行 after_ready 操作，跳过上方恢复顺序组合中已在 role.md 前交付的预载操作。
    const afterReadyResult = await this.executeActions(input, "after_ready", consumedActions);
    if (!afterReadyResult.ok) {
      return this.fail(input, "failed", afterReadyResult.errors);
    }

    // 交付首个原生提示可能暴露提供方拒绝或交互门禁；明确需要处理并不等于就绪。
    if (postLaunchFiles.length > 0) {
      try {
        const readiness = await input.adapter.checkReady(input.binding);
        if (!readiness.ready && isAttentionRequiredReadinessCode(readiness.code)) {
          return this.fail(input, "attention_required", [readiness.reason ?? "上下文交付后，原生提供方前置条件失败。"]);
        }
      } catch (error) {
        return this.fail(input, "attention_required", [`交付后的运行时状态不可用：${(error as Error).message}`]);
      }
    }

    // 10. 标记为 ready。
    this.sessionRegistry.updateStartupStatus(input.sessionId, "ready", new Date().toISOString());
    this.eventBus.emit({ type: "node.startup_ready", rigId: input.rigId, nodeId: input.nodeId });

    return { ok: true, startupStatus: "ready", continuityOutcome };
  }

  /** 失败尝试只有在发送上下文前停止时才能继续。任何更新的 pending/ready/failure 事件都会
   *  消耗该许可，包括交付期间后台服务中断；绝不盲目重放状态不确定的交付。 */
  canContinueFresh(nodeId: string, sessionId: string): boolean {
    const row = this.db.prepare("SELECT payload FROM events WHERE node_id = ? AND type IN ('node.startup_pending', 'node.startup_ready', 'node.startup_failed') ORDER BY seq DESC LIMIT 1").get(nodeId) as { payload: string } | undefined;
    if (!row) return false;
    const event = JSON.parse(row.payload);
    return event.type === "node.startup_failed" && event.sessionId === sessionId && event.freshContextPending === true;
  }

  /**
   * 使用指数退避等待运行环境就绪。退避间隔为 1 秒 → 2 秒 → 4 秒 → 8 秒 → 16 秒
   *（封顶），总超时默认 30 秒。
   */
  private async waitForReady(
    adapter: RuntimeAdapter,
    binding: NodeBinding,
    timeoutMs: number = 30_000,
  ): Promise<import("./runtime-adapter.js").ReadinessResult> {
    const startTime = Date.now();
    let delay = 1000; // 从 1 秒开始。
    const maxDelay = 16_000;

    while (true) {
      const result = await adapter.checkReady(binding);
      if (result.ready) return result;
      if (isAttentionRequiredReadinessCode(result.code)) {
        return result;
      }

      const elapsed = Date.now() - startTime;
      if (elapsed + delay > timeoutMs) {
        // 超时前再检查最后一次。
        const finalResult = await adapter.checkReady(binding);
        if (finalResult.ready) return finalResult;
        return { ready: false, reason: result.reason ?? "就绪检查超时" };
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  private safeReadFile(path: string): string {
    try { return this.readFile(path); } catch { return ""; }
  }

  private fail(
    input: StartupInput,
    status: "attention_required" | "failed",
    errors: string[],
    evidence?: string,
    freshContextPending = false,
  ): StartupResult {
    this.sessionRegistry.updateStartupStatus(input.sessionId, status);
    this.eventBus.emit({
      type: "node.startup_failed",
      rigId: input.rigId,
      nodeId: input.nodeId,
      error: errors.join("; "),
      sessionId: input.sessionId,
      ...(freshContextPending ? { freshContextPending: true } : {}),
    });
    return { ok: false, startupStatus: status, errors, evidence };
  }

  private async executeActions(
    input: StartupInput,
    phase: "after_files" | "after_ready",
    skip?: Set<StartupAction>,
  ): Promise<{ ok: true } | { ok: false; errors: string[] }> {
    const errors: string[] = [];
    const context = input.isRestore ? "restore" : "fresh_start";

    for (const action of input.startupActions) {
      if (action.type === "startup_proof") continue; // 仅为声明，绝不作为终端输入
      if (isSessionIdentityAction(action)) continue;
      if (skip?.has(action)) continue;

      // 阶段过滤。
      if (action.phase !== phase) continue;

      // appliesOn 过滤。
      if (!action.appliesOn.includes(context)) continue;

      // 恢复时跳过非幂等操作，确保以恢复方式重试的安全性。
      if (input.isRestore && !action.idempotent) continue;

      // 通过 tmux 执行。
      try {
        if (!input.binding.tmuxSession) {
          errors.push(`操作没有对应的 tmux 会话：${action.value}`);
          continue;
        }

        const sendError = await this.sendInteractiveText(input.binding.tmuxSession, action.value);
        if (sendError) {
          errors.push(`操作失败（${action.type}）：${sendError}`);
        }
      } catch (err) {
        errors.push(`操作出错（${action.type}）：${(err as Error).message}`);
      }
    }

    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  }

  private extractSessionIdentityAction(
    actions: StartupAction[],
    context: "fresh_start" | "restore",
  ): StartupAction | null {
    return actions.find((action) => isSessionIdentityAction(action) && action.appliesOn.includes(context)) ?? null;
  }

  private async deliverInitialSessionPrompt(
    binding: NodeBinding,
    identityAction: StartupAction,
    postLaunchFiles: ResolvedStartupFile[],
    challengeBlock: string | null,
    includeDurableObligations = false,
  ): Promise<{ ok: true; remainingFiles: ResolvedStartupFile[] } | { ok: false; error: string }> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "初始 session 身份提示没有对应的 tmux session" };
    }

    const firstSendTextIndex = postLaunchFiles.findIndex((file) => file.deliveryHint === "send_text");
    let prompt = identityAction.value;
    let remainingFiles = postLaunchFiles;

    if (firstSendTextIndex !== -1) {
      const firstSendText = postLaunchFiles[firstSendTextIndex]!;
      try {
        const content = this.readFile(firstSendText.absolutePath);
        if (content.length > 0) {
          prompt = `${identityAction.value}\n\n${content}`;
          remainingFiles = postLaunchFiles.filter((_, index) => index !== firstSendTextIndex);
        }
      } catch {
        // 回退到独立 identity prompt，并让 adapter 按正常失败语义处理原始 startup file。
      }
    }

    if (includeDurableObligations) prompt += `\n\n这是一个全新会话。选择工作前，请运行 zrig whoami --json 确认身份，并运行 zrig queue list --destination ${binding.tmuxSession} --state pending,in-progress,blocked --limit 10000 --full --json 读取持久义务。若结果达到上限，请报告截断情况；目标指向你的记录不代表你有权认领无关工作。`;

    // OPR.0.4.3.06——每次启动的 orientation challenge 会随 identity prompt 一并发送
    //（位于 contract 后），因此不增加额外发送。
    if (challengeBlock) {
      prompt = `${prompt}\n\n${challengeBlock}`;
    }

    const sendError = await this.sendInteractiveText(binding.tmuxSession, prompt);
    if (sendError) {
      return { ok: false, error: `初始 session 身份提示发送失败：${sendError}` };
    }

    return { ok: true, remainingFiles };
  }

  /**
   * OPR.0.4.7.17 恢复顺序修正。恢复已有会话时，把 after_ready send_text 预载操作作为
   * 唯一首轮交付，并把第一个会触发工作的启动后 send_text 文件（guidance/role.md）组合
   * 在其后，使“先加载 Skill 再做其他事”在同一次提交中因果先于角色内容。返回仍需正常
   * 交付的启动后文件；role.md 一旦被组合就从中移除。
   */
  private async deliverRestorePreloadPrompt(
    binding: NodeBinding,
    preloadActions: StartupAction[],
    postLaunchFiles: ResolvedStartupFile[],
  ): Promise<{ ok: true; remainingFiles: ResolvedStartupFile[] } | { ok: false; error: string }> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "恢复预载提示没有对应的 tmux 会话" };
    }

    const parts = preloadActions.map((a) => a.value);
    let remainingFiles = postLaunchFiles;

    const firstSendTextIndex = postLaunchFiles.findIndex((file) => file.deliveryHint === "send_text");
    if (firstSendTextIndex !== -1) {
      const firstSendText = postLaunchFiles[firstSendTextIndex]!;
      try {
        const content = this.readFile(firstSendText.absolutePath);
        if (content.length > 0) {
          parts.push(content);
          remainingFiles = postLaunchFiles.filter((_, index) => index !== firstSendTextIndex);
        }
      } catch {
        // 将 role.md 留在 postLaunchFiles 中正常交付；预载仍作为独立的首轮内容。
      }
    }

    const sendError = await this.sendInteractiveText(binding.tmuxSession, parts.join("\n\n"));
    if (sendError) {
      return { ok: false, error: `恢复预载提示发送失败：${sendError}` };
    }

    return { ok: true, remainingFiles };
  }

  private async sendInteractiveText(tmuxSession: string, text: string): Promise<string | null> {
    const textResult = await this.tmuxAdapter.sendText(tmuxSession, text);
    if (!textResult.ok) {
      return (textResult as { message?: string }).message ?? "unknown";
    }

    await this.sleep(200);
    const submitResult = await this.tmuxAdapter.sendKeys(tmuxSession, ["C-m"]);
    if (!submitResult.ok) {
      return (submitResult as { message?: string }).message ?? "unknown";
    }

    return null;
  }
}

function isSessionIdentityAction(action: StartupAction): boolean {
  if (action.builtin === "session_identity") return true;
  return action.type === "send_text" && action.value.startsWith("OpenRig session identity:");
}
