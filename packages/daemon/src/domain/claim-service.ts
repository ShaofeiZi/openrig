import { OutboxHandler } from "./outbox-handler.js";
import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { DiscoveryRepository } from "./discovery-repository.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { TranscriptStore } from "./transcript-store.js";
import { startTmuxTranscriptCapture } from "./transcript-capture.js";
import { deriveResumeToken } from "./resume-token-capture.js";
import {
  observeSolePane,
  paneObservationVerdict,
  type PaneBindingObservation,
} from "./pane-binding-observation.js";
import { SeatIdentityStore } from "./seat-identity-store.js";

export type ClaimResult =
  | { ok: true; nodeId: string; sessionId: string }
  | { ok: false; code: string; error: string };

/**
 * OPR.0.3.4.3 — 无启动协调的结果（把手动恢复的规范会话重新接入其持久化节点）。
 * 如实区分两类信息：`projectionDrift` 列出协调过程无法从实时窗格证实的拓扑元数据；
 * `continuity` 始终为 "unverified"，重新连接投影并不代表提供方会话保持连续。
 */
export interface ReconcileSessionResult {
  rigId: string;
  rigName: string;
  nodeId: string;
  logicalId: string;
  sessionName: string;
  sessionId: string;
  /** 协调过程无法从实时窗格证实的拓扑元数据（例如：窗格命令无法确认声明的运行时）。 */
  projectionDrift: string[];
  /** 协调过程永远不会验证提供方会话的对话连续性。 */
  continuity: "unverified";
}

export type ReconcileSessionOutcome =
  | { ok: true; result: ReconcileSessionResult }
  | { ok: false; code: "session_not_found"; message: string }
  | { ok: false; code: "node_not_found"; message: string }
  | { ok: false; code: "rig_not_found"; message: string }
  | { ok: false; code: "node_mismatch"; message: string }
  | { ok: false; code: "reconcile_error"; message: string };

export interface ReconcileSessionOptions {
  sessionName: string;
  /** 可选的显式消歧参数；提供后将其视为权威值，并与会话名称映射交叉核对。 */
  rigId?: string;
  logicalId?: string;
}

interface ClaimServiceDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  discoveryRepo: DiscoveryRepository;
  eventBus: EventBus;
  tmuxAdapter?: TmuxAdapter;
  transcriptStore?: TranscriptStore;
  claudeContextProvisioner?: {
    ensureContextCollector(binding: { cwd?: string | null; tmuxSession?: string | null }): void;
  };
  // OPR.0.4.3.20 FR-3 — 在接入边界捕获恢复令牌。两项依赖均为可选并采用结构化类型，
  // 以避免领域层循环导入；旧版装配或测试未提供它们时，捕获会静默跳过。
  // contextUsageStore 读取 Claude 状态行 sidecar，resumeTokenCapturer 推导 Codex 线程 ID。
  contextUsageStore?: {
    readSidecar(sessionName: string): { ok: true; data: { session_id?: string } } | { ok: false; reason: string };
  };
  resumeTokenCapturer?: {
    captureCodexThreadId(sessionName: string): Promise<string | undefined>;
  };
  /** OPR.0.4.6.PI1 FR-6 — 用于捕获 Pi 恢复令牌的 pi-runner sidecar 读取器。 */
  piRunnerStateStore?: {
    readSessionFile(sessionName: string): { ok: true; sessionFile: string } | { ok: false; reason: string };
  };
}

interface BindOptions {
  discoveredId: string;
  rigId: string;
  logicalId: string;
}

interface CreateAndBindToPodOptions {
  discoveredId: string;
  rigId: string;
  podId: string;
  podNamespace: string;
  memberName: string;
}

/**
 * 将发现的会话接入受管工作组。
 * 以原子方式创建节点、绑定和会话记录。
 * 不安装软件包、不合并指引，也不安装 hook。
 */
export class ClaimService {
  readonly db: Database.Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private discoveryRepo: DiscoveryRepository;
  private eventBus: EventBus;
  private tmuxAdapter: TmuxAdapter | null;
  private transcriptStore: TranscriptStore | null;
  private claudeContextProvisioner: ClaimServiceDeps["claudeContextProvisioner"] | null;
  private contextUsageStore: ClaimServiceDeps["contextUsageStore"] | null;
  private resumeTokenCapturer: ClaimServiceDeps["resumeTokenCapturer"] | null;
  private piRunnerStateStore: ClaimServiceDeps["piRunnerStateStore"] | null;

  constructor(deps: ClaimServiceDeps) {
    if (deps.db !== deps.rigRepo.db) throw new Error("ClaimService：rigRepo 必须共享同一个数据库句柄");
    if (deps.db !== deps.sessionRegistry.db) throw new Error("ClaimService：sessionRegistry 必须共享同一个数据库句柄");
    if (deps.db !== deps.discoveryRepo.db) throw new Error("ClaimService：discoveryRepo 必须共享同一个数据库句柄");
    if (deps.db !== deps.eventBus.db) throw new Error("ClaimService：eventBus 必须共享同一个数据库句柄");
    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.discoveryRepo = deps.discoveryRepo;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter ?? null;
    this.transcriptStore = deps.transcriptStore ?? null;
    this.claudeContextProvisioner = deps.claudeContextProvisioner ?? null;
    this.contextUsageStore = deps.contextUsageStore ?? null;
    this.resumeTokenCapturer = deps.resumeTokenCapturer ?? null;
    this.piRunnerStateStore = deps.piRunnerStateStore ?? null;
  }

  private async observeBindingPane(
    sessionName: string,
    knownPane?: string | null,
  ): Promise<PaneBindingObservation> {
    if (knownPane) return { ok: true, pane: knownPane };
    if (!this.tmuxAdapter) {
      return { ok: false, code: "tmux_unavailable", detail: "tmux 适配器不可用" };
    }
    return observeSolePane(this.tmuxAdapter, sessionName);
  }

  private persistPaneBinding(
    nodeId: string,
    sessionName: string,
    observation: PaneBindingObservation,
    tmuxWindow?: string | null,
  ): void {
    this.sessionRegistry.updateBinding(nodeId, {
      tmuxSession: sessionName,
      ...(tmuxWindow ? { tmuxWindow } : {}),
      ...(observation.ok ? { tmuxPane: observation.pane } : {}),
    });
    if (!observation.ok) {
      new SeatIdentityStore(this.db).upsert(paneObservationVerdict({
        nodeId,
        sessionName,
        observation,
      }));
    }
  }

  /** 尽力而为：为接入的会话设置 zrig 所有的 tmux 元数据。 */
  private async setRiggedMetadata(tmuxSession: string, meta: {
    nodeId: string; sessionName: string; rigId: string; rigName: string; logicalId: string;
  }): Promise<void> {
    if (!this.tmuxAdapter) return;
    const entries: [string, string][] = [
      ["@rigged_node_id", meta.nodeId],
      ["@rigged_session_name", meta.sessionName],
      ["@rigged_rig_id", meta.rigId],
      ["@rigged_rig_name", meta.rigName],
      ["@rigged_logical_id", meta.logicalId],
    ];
    for (const [key, value] of entries) {
      await this.tmuxAdapter.setSessionOption(tmuxSession, key, value);
    }
  }

  /** 尽力而为：认领后向接入的会话发送简短的身份提示。 */
  private async deliverClaimHint(tmuxSession: string, meta: {
    rigName: string; logicalId: string;
  }): Promise<void> {
    if (!this.tmuxAdapter) return;
    const hint = `--- zrig：你已作为 ${meta.logicalId} 接入工作组 "${meta.rigName}"。请运行：zrig whoami --json ---`;
    const write = async () => {
      const sent = await this.tmuxAdapter!.sendText(tmuxSession, hint);
      if (sent.ok) await this.tmuxAdapter!.sendKeys(tmuxSession, ["C-m"]);
    };
    const guard = this.tmuxAdapter.deliveryGuard;
    if (guard) await guard.operation(tmuxSession, write, async target => {
      new OutboxHandler(this.db).retain({ outboxId: `guard-claim-${target.nodeId}-${target.occupant ?? "unknown"}`,
        senderSession: "claim@system", destinationSession: tmuxSession, body: hint }, target);
    });
    else await write();
  }

  private maybeProvisionContextCollector(runtime: string | null | undefined, cwd: string | null | undefined, tmuxSession: string): void {
    if (runtime !== "claude-code") return;
    try {
      this.claudeContextProvisioner?.ensureContextCollector({
        cwd: cwd ?? undefined,
        tmuxSession,
      });
    } catch { /* 尽力而为 */ }
  }

  /**
   * OPR.0.4.3.20 FR-3 — 在接入边界（reconcile / adopt / bind）尽力捕获席位的恢复令牌。
   * ClaimService 的三条接入路径都会在事务完成后、返回前调用此方法；此时操作员刚刚
   * 重新建立实时会话，并期望它能在下次崩溃后继续恢复。
   *
   * 推导过程只复用已有信息且完全只读，不写入窗格也不启动进程，因此符合协调操作
   * “不启动、不输入”的安全契约：
   *   claude-code → 读取状态行 sidecar 中的 session_id
   *   codex       → 从按实时 PID 索引的日志中推导线程 ID
   * 通过 updateResumeToken 持久化并记录 provenance "adoption"；等级保护负责防止覆盖
   * （绝不降级 operator/hook 来源，合法性保护阻止写入空值）。失败时如实保持不写入
   * （null 令牌表示确实缺失或未经验证），并发出注明原因且已脱敏的跳过事件。
   * terminal/unknown 运行时不适用（不捕获、不发事件，也不算失败）。任何异常都会被
   * 吞掉，捕获操作绝不会导致接入失败或阻塞接入（PRD 规则 7）。
   */
  private async captureResumeTokenOnAdoption(input: {
    rigId: string; nodeId: string; sessionId: string; sessionName: string; runtime: string | null;
  }): Promise<void> {
    try {
      // 推导使用共享的纯函数辅助逻辑（OPR.0.4.3.04 B2，也供席位交接的发现模式捕获复用）；
      // 持久化和事件仍留在此处，以保持 FR-3 的接入来源与审计语义不变。
      const derived = await deriveResumeToken(
        { runtime: input.runtime, sessionName: input.sessionName },
        { contextUsageStore: this.contextUsageStore, resumeTokenCapturer: this.resumeTokenCapturer, piRunnerStateStore: this.piRunnerStateStore },
      );
      if (derived.outcome === "exempt" || derived.outcome === "noop") return;
      const runtime = input.runtime as string; // 排除不适用分支后必定非 null
      if (derived.outcome === "skipped") {
        this.emitCaptureSkip(input, runtime, derived.reason);
        return;
      }
      const validation = { resumeType: derived.resumeType, token: derived.token };

      // 仅在确实写入时发出 "captured"。如果来源等级保护拒绝写入（已有更高等级的
      // hook/operator 令牌，例如 hook 在异步探测窗口内触发），台账会被正确保留；事件也
      // 必须如实说明，而不能误称在 FR-3 规定的权威边界完成了接入写入。
      const wrote = this.sessionRegistry.updateResumeToken(input.sessionId, validation.resumeType, validation.token, "adoption");
      try {
        this.eventBus.emit(wrote
          ? {
              type: "session.resume_token_captured",
              rigId: input.rigId, nodeId: input.nodeId, sessionName: input.sessionName, sessionId: input.sessionId,
              runtime, outcome: "captured", resumeType: validation.resumeType, provenance: "adoption", redacted: true,
            }
          : {
              type: "session.resume_token_captured",
              rigId: input.rigId, nodeId: input.nodeId, sessionName: input.sessionName, sessionId: input.sessionId,
              runtime, outcome: "preserved", resumeType: validation.resumeType, reason: "higher_rank_present", redacted: true,
            });
      } catch { /* 尽力而为 */ }
    } catch {
      // 尽力而为：捕获绝不会导致接入失败或阻塞接入（PRD 规则 7）
    }
  }

  private emitCaptureSkip(
    input: { rigId: string; nodeId: string; sessionId: string; sessionName: string },
    runtime: string,
    reason: "missing_sidecar" | "parse_error" | "probe_timeout" | "invalid_token",
  ): void {
    try {
      this.eventBus.emit({
        type: "session.resume_token_captured",
        rigId: input.rigId, nodeId: input.nodeId, sessionName: input.sessionName, sessionId: input.sessionId,
        runtime, outcome: "skipped", reason, redacted: true,
      });
    } catch { /* 尽力而为 */ }
  }

  async bind(opts: BindOptions): Promise<ClaimResult> {
    const discovered = this.discoveryRepo.getDiscoveredSession(opts.discoveredId);
    if (!discovered) {
      return { ok: false, code: "not_found", error: "未找到发现记录" };
    }
    if (discovered.status !== "active") {
      return { ok: false, code: "not_active", error: `发现记录状态为 ${discovered.status}，并非 active` };
    }

    const rig = this.rigRepo.getRig(opts.rigId);
    if (!rig) {
      return { ok: false, code: "rig_not_found", error: "未找到目标工作组" };
    }

    const node = rig.nodes.find((candidate) => candidate.logicalId === opts.logicalId);
    if (!node) {
      return { ok: false, code: "node_not_found", error: `工作组中不存在逻辑 ID '${opts.logicalId}'` };
    }

    const guard = this.tmuxAdapter?.deliveryGuard;
    if (guard && !guard.ownsLifecycle(node.id)) return guard.lifecycle([node.id], () => this.bind(opts));
    const existingBinding = this.sessionRegistry.getBindingForNode(node.id);
    if (existingBinding?.tmuxSession) {
      return { ok: false, code: "already_bound", error: `逻辑 ID '${opts.logicalId}' 已绑定` };
    }

    const discoveredRuntime = discovered.runtimeHint === "unknown" || discovered.runtimeHint === "terminal"
      ? null
      : discovered.runtimeHint;
    if (node.runtime && discoveredRuntime && node.runtime !== discoveredRuntime) {
      return {
        ok: false,
        code: "runtime_mismatch",
        error: `逻辑 ID '${opts.logicalId}' 需要运行时 '${node.runtime}'，但发现结果解析为 '${discoveredRuntime}'`,
      };
    }

    const paneObservation = await this.observeBindingPane(
      discovered.tmuxSession,
      discovered.tmuxPane,
    );

    const bindTx = this.db.transaction(() => {
      this.persistPaneBinding(
        node.id,
        discovered.tmuxSession,
        paneObservation,
        discovered.tmuxWindow,
      );

      const session = this.sessionRegistry.registerClaimedSession(node.id, discovered.tmuxSession);
      this.discoveryRepo.markClaimed(discovered.id, node.id);
      this.eventBus.persistWithinTransaction({
        type: "node.claimed",
        rigId: opts.rigId,
        nodeId: node.id,
        logicalId: opts.logicalId,
        discoveredId: discovered.id,
      });

      return { nodeId: node.id, sessionId: session.id };
    });

    try {
      const { nodeId, sessionId } = bindTx();
      this.tmuxAdapter?.deliveryGuard?.rebindLifecycle(nodeId);
      const event = this.db.prepare("SELECT * FROM events ORDER BY seq DESC LIMIT 1").get() as { seq: number; type: string; rig_id: string; node_id: string; payload: string; created_at: string };
      if (event) {
        this.eventBus.notifySubscribers({
          type: "node.claimed",
          rigId: opts.rigId,
          nodeId,
          logicalId: opts.logicalId,
          discoveredId: discovered.id,
          seq: event.seq,
          createdAt: event.created_at,
        });
      }
      // 尽力而为：设置 zrig 所有的 tmux 元数据。
      try {
        await this.setRiggedMetadata(discovered.tmuxSession, {
          nodeId, sessionName: discovered.tmuxSession,
          rigId: opts.rigId, rigName: rig!.rig.name, logicalId: opts.logicalId,
        });
      } catch { /* 尽力而为 */ }
      this.maybeProvisionContextCollector(node.runtime ?? discoveredRuntime, node.cwd ?? discovered.cwd, discovered.tmuxSession);
      try {
        await startTmuxTranscriptCapture(this.tmuxAdapter, this.transcriptStore, rig!.rig.name, discovered.tmuxSession);
      } catch { /* 尽力而为 */ }
      // 尽力而为：发送认领后的身份提示。
      try {
        await this.deliverClaimHint(discovered.tmuxSession, { rigName: rig!.rig.name, logicalId: opts.logicalId });
      } catch { /* 尽力而为 */ }
      // OPR.0.4.3.20 FR-3 — 在接入边界捕获恢复令牌。
      await this.captureResumeTokenOnAdoption({
        rigId: opts.rigId, nodeId, sessionId, sessionName: discovered.tmuxSession,
        runtime: node.runtime ?? discoveredRuntime ?? null,
      });

      return { ok: true, nodeId, sessionId };
    } catch (err) {
      return { ok: false, code: "claim_error", error: (err as Error).message };
    }
  }

  /**
   * OPR.0.3.4.3 — 无启动协调：把手动恢复的实时规范会话重新接入其持久化节点。
   * 最安全的故障恢复方式（在规范 tmux 名称下手动执行 `claude --resume` /
   * `codex resume`）会让后台服务投影仍把席位显示为离线；此方法只把实时进程绑定回
   * 它自己的节点并翻转投影，不做其他事情。
   *
   * 安全边界（guard rev1）：只复用 bind 中的数据库绑定、投影和元数据部分，绝不进入
   * 认领后的输入路径。不会调用 launchNode / createSession / killSession / sendText /
   * sendKeys / deliverClaimHint，也不会发送启动或恢复内容、执行 compact 菜单自动化。
   * 允许的目标操作只有：hasSession 检查、读取窗格元数据/PID、更新或插入绑定/会话/
   * 投影、设置非输入型 tmux 元数据（setSessionOption）、发出事件和记录转录。
   *
   * 身份边界：绑定到现有节点，保持同一个节点 ID，不重新分配标识，也不迁移。
   * projectionDrift（无法证实的拓扑元数据）单独报告；continuity 始终为 "unverified"。
   */
  async reconcileSession(opts: ReconcileSessionOptions): Promise<ReconcileSessionOutcome> {
    const sessionName = opts.sessionName.trim();
    if (!sessionName) {
      return { ok: false, code: "session_not_found", message: "必须提供 sessionName。" };
    }

    // 1. 根据规范会话名称解析持久化节点。会话名称映射来自后台服务自身的历史记录
    //（绑定与会话行）；显式提供的 --rig/--node 是权威参数，并会与映射交叉核对。
    let nodeRow: { id: string; rig_id: string; logical_id: string; runtime: string | null; cwd: string | null } | undefined;
    if (opts.rigId && opts.logicalId) {
      const rig = this.rigRepo.getRig(opts.rigId);
      if (!rig) {
        return { ok: false, code: "rig_not_found", message: `未找到工作组 "${opts.rigId}"。` };
      }
      const node = rig.nodes.find((candidate) => candidate.logicalId === opts.logicalId);
      if (!node) {
        return { ok: false, code: "node_not_found", message: `工作组 "${rig.rig.name}" 中不存在逻辑 ID "${opts.logicalId}"。` };
      }
      nodeRow = { id: node.id, rig_id: opts.rigId, logical_id: node.logicalId, runtime: node.runtime ?? null, cwd: node.cwd ?? null };
      // 交叉核对：如果后台服务历史记录把此会话名称映射到了其他节点，应如实拒绝，
      // 而不是静默重定向。
      const mapped = this.resolveNodeIdForSessionName(sessionName);
      if (mapped && mapped !== node.id) {
        return {
          ok: false,
          code: "node_mismatch",
          message: `会话 "${sessionName}" 映射到的持久化节点并非 ${opts.logicalId}。请重新检查 --rig/--node，或省略它们以使用后台服务的映射。`,
        };
      }
      // 身份边界（guard 复审）：没有后台服务历史映射时，显式 --rig/--node 只能接入
      // 该节点自己的规范受管会话名称。把任意从未受管的名称绑定到节点属于接入/重新
      // 分配标识路径，而不是协调；这种情况应使用 zrig discover + zrig bind。
      if (!mapped) {
        const expected = await this.expectedManagedSessionName(node.logicalId, node.podId ?? null, rig.rig.name);
        if (sessionName !== expected) {
          return {
            ok: false,
            code: "node_mismatch",
            message: `会话 "${sessionName}" 不是 ${opts.logicalId} 的受管会话名称（应为 "${expected}"），且后台服务没有将其映射到该节点的历史记录。协调操作只能重新接入节点自己的规范会话；如需管理新的或未受管的会话，请使用 zrig discover + zrig bind。`,
          };
        }
      }
    } else {
      const mappedNodeId = this.resolveNodeIdForSessionName(sessionName);
      if (!mappedNodeId) {
        return {
          ok: false,
          code: "node_not_found",
          message: `没有持久化节点映射到会话 "${sessionName}"。如果该席位从未受管，请使用 zrig discover + zrig bind；协调操作只能重新接入曾经受管的席位。可使用 --rig <rig> --node <logicalId> 消除歧义。`,
        };
      }
      const row = this.db
        .prepare("SELECT id, rig_id, logical_id, runtime, cwd FROM nodes WHERE id = ?")
        .get(mappedNodeId) as { id: string; rig_id: string; logical_id: string; runtime: string | null; cwd: string | null } | undefined;
      if (!row) {
        return { ok: false, code: "node_not_found", message: `会话 "${sessionName}" 对应的持久化节点已不存在。` };
      }
      nodeRow = row;
    }

    const rig = this.rigRepo.getRig(nodeRow.rig_id);
    if (!rig) {
      return { ok: false, code: "rig_not_found", message: `节点 "${nodeRow.logical_id}" 所属的工作组已不存在。` };
    }

    // 2. 以只读方式确认使用规范名称的实时 tmux 会话存在。
    if (!this.tmuxAdapter) {
      return { ok: false, code: "reconcile_error", message: "tmux 适配器不可用，无法验证实时会话。" };
    }
    const guard = this.tmuxAdapter.deliveryGuard;
    const observedTarget = guard?.target(nodeRow.id);
    const alive = await this.tmuxAdapter.hasSession(sessionName);
    if (!alive) {
      return {
        ok: false,
        code: "session_not_found",
        message: `没有名为 "${sessionName}" 的实时 tmux 会话。协调操作只接入正在运行的会话；如需启动席位，请改用启动流程。`,
      };
    }

    // 3. 以只读方式获取窗格事实，用于如实生成漂移报告。读取绝不会注入输入；
    // 失败会降级为漂移条目，而不是错误。
    const projectionDrift: string[] = [];
    const paneObservation = await this.observeBindingPane(sessionName);
    if (!paneObservation.ok) projectionDrift.push(paneObservation.detail);
    let paneCommand: string | null = null;
    try {
      paneCommand = await this.tmuxAdapter.getPaneCommand(
        paneObservation.ok ? paneObservation.pane : sessionName,
      );
    } catch { paneCommand = null; }
    if (nodeRow.runtime) {
      const expectation: Record<string, string[]> = {
        "claude-code": ["claude", "node"],
        codex: ["codex", "node"],
        terminal: [],
      };
      const expected = expectation[nodeRow.runtime];
      if (!paneCommand) {
        projectionDrift.push(`运行时未经验证：无法读取窗格命令；节点声明的运行时为 "${nodeRow.runtime}"`);
      } else if (expected && expected.length > 0 && !expected.includes(paneCommand)) {
        projectionDrift.push(`运行时未经验证：窗格命令 "${paneCommand}" 无法确认运行时 "${nodeRow.runtime}"`);
      }
    }
    if (nodeRow.cwd) {
      projectionDrift.push(`cwd 未经验证：节点声明为 "${nodeRow.cwd}"；不注入输入就无法证实实时窗格的 cwd`);
    }

    // 4. 执行按协调场景裁剪后的 bind 数据库部分：将该节点的旧会话行标记为已取代，
    // 更新或插入指向实时会话的绑定，注册新的已认领会话行（状态为 running），并在
    // 同一个事务中发出 node.reconciled。
    try {
      let sessionId = "";
      let persistedEvent: ReturnType<EventBus["persistWithinTransaction"]> | undefined;
      const tx = this.db.transaction(() => {
        const stale = this.db
          .prepare("SELECT id FROM sessions WHERE node_id = ? AND status = 'running'")
          .all(nodeRow!.id) as Array<{ id: string }>;
        for (const row of stale) {
          this.sessionRegistry.markSuperseded(row.id);
        }
        this.persistPaneBinding(nodeRow!.id, sessionName, paneObservation);
        const session = this.sessionRegistry.registerClaimedSession(nodeRow!.id, sessionName);
        sessionId = session.id;
        persistedEvent = this.eventBus.persistWithinTransaction({
          type: "node.reconciled",
          rigId: nodeRow!.rig_id,
          nodeId: nodeRow!.id,
          logicalId: nodeRow!.logical_id,
          sessionName,
        });
      });
      if (guard && observedTarget) guard.reconcileBinding(observedTarget, tx);
      else tx();
      if (persistedEvent) this.eventBus.notifySubscribers(persistedEvent);

      // 5. 尽力执行不涉及输入的收尾工作：设置 zrig 所有的 tmux 元数据
      //（仅 setSessionOption），并启动转录捕获（pipe-pane 记录）。这里刻意不调用
      // deliverClaimHint，也不配置上下文收集器，确保不会写入实时窗格或席位工作区。
      try {
        await this.setRiggedMetadata(sessionName, {
          nodeId: nodeRow.id,
          sessionName,
          rigId: nodeRow.rig_id,
          rigName: rig.rig.name,
          logicalId: nodeRow.logical_id,
        });
      } catch { /* 尽力而为 */ }
      try {
        await startTmuxTranscriptCapture(this.tmuxAdapter, this.transcriptStore, rig.rig.name, sessionName);
      } catch { /* 尽力而为 */ }
      // OPR.0.4.3.20 FR-3 — 在接入边界捕获恢复令牌。只读取 sidecar 文件或按 PID
      // 索引的日志，符合上述“不启动、不输入”契约；不触碰 `continuity`，因为 FR-3
      // 只捕获令牌，并不声称对话保持连续。
      await this.captureResumeTokenOnAdoption({
        rigId: nodeRow.rig_id, nodeId: nodeRow.id, sessionId, sessionName,
        runtime: nodeRow.runtime,
      });

      return {
        ok: true,
        result: {
          rigId: nodeRow.rig_id,
          rigName: rig.rig.name,
          nodeId: nodeRow.id,
          logicalId: nodeRow.logical_id,
          sessionName,
          sessionId,
          projectionDrift,
          continuity: "unverified",
        },
      };
    } catch (err) {
      return { ok: false, code: "reconcile_error", message: (err as Error).message };
    }
  }

  /** 受管节点预期使用的会话名称：pod 感知节点推导为 `{pod}-{member}@{rigName}`，
   *  旧式扁平节点沿用旧推导方式。当后台服务没有所给名称的历史映射时，此结果用于
   *  限制显式 --rig/--node 协调分支。 */
  private async expectedManagedSessionName(logicalId: string, podId: string | null, rigName: string): Promise<string> {
    const { deriveCanonicalSessionName, deriveSessionName } = await import("./session-name.js");
    if (podId) {
      const parts = logicalId.split(".");
      if (parts.length >= 2) {
        return deriveCanonicalSessionName(parts[0]!, parts.slice(1).join("."), rigName);
      }
    }
    return deriveSessionName(rigName, logicalId);
  }

  /** 通过后台服务自身的历史记录，把规范会话名称映射到持久化节点：
   *  优先当前绑定，其次使用最近的会话行。 */
  private resolveNodeIdForSessionName(sessionName: string): string | null {
    const bound = this.db
      .prepare("SELECT node_id FROM bindings WHERE tmux_session = ?")
      .get(sessionName) as { node_id: string } | undefined;
    if (bound) return bound.node_id;
    const recent = this.db
      .prepare("SELECT node_id FROM sessions WHERE session_name = ? ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(sessionName) as { node_id: string } | undefined;
    return recent?.node_id ?? null;
  }

  async createAndBindToPod(opts: CreateAndBindToPodOptions): Promise<ClaimResult> {
    const discovered = this.discoveryRepo.getDiscoveredSession(opts.discoveredId);
    if (!discovered) {
      return { ok: false, code: "not_found", error: "未找到发现记录" };
    }
    if (discovered.status !== "active") {
      return { ok: false, code: "not_active", error: `发现记录状态为 ${discovered.status}，并非 active` };
    }

    const rig = this.rigRepo.getRig(opts.rigId);
    if (!rig) {
      return { ok: false, code: "rig_not_found", error: "未找到目标工作组" };
    }

    const podRow = this.db
      .prepare("SELECT rig_id, namespace FROM pods WHERE id = ?")
      .get(opts.podId) as { rig_id: string; namespace: string } | undefined;
    if (!podRow || podRow.rig_id !== opts.rigId) {
      return { ok: false, code: "pod_not_found", error: "目标 pod 不在该工作组中" };
    }

    const memberName = opts.memberName.trim();
    const podNamespace = opts.podNamespace.trim();
    if (!memberName) {
      return { ok: false, code: "invalid_member_name", error: "必须提供 memberName" };
    }
    if (!podNamespace) {
      return { ok: false, code: "invalid_pod_namespace", error: "必须提供 podNamespace" };
    }
    if (podRow.namespace !== podNamespace) {
      return { ok: false, code: "invalid_pod_namespace", error: "podNamespace 与目标 pod 不匹配" };
    }

    const logicalId = `${podNamespace}.${memberName}`;
    if (rig.nodes.some((n) => n.logicalId === logicalId)) {
      return { ok: false, code: "duplicate_logical_id", error: `工作组中已存在逻辑 ID '${logicalId}'` };
    }

    const discoveredRuntime = discovered.runtimeHint === "unknown" || discovered.runtimeHint === "terminal"
      ? undefined
      : discovered.runtimeHint;

    const paneObservation = await this.observeBindingPane(
      discovered.tmuxSession,
      discovered.tmuxPane,
    );

    const claimTx = this.db.transaction(() => {
      const node = this.rigRepo.addNode(opts.rigId, logicalId, {
        runtime: discoveredRuntime,
        cwd: discovered.cwd ?? undefined,
        podId: opts.podId,
      });

      this.persistPaneBinding(
        node.id,
        discovered.tmuxSession,
        paneObservation,
        discovered.tmuxWindow,
      );

      const session = this.sessionRegistry.registerClaimedSession(node.id, discovered.tmuxSession);
      this.discoveryRepo.markClaimed(discovered.id, node.id);
      this.eventBus.persistWithinTransaction({
        type: "node.claimed",
        rigId: opts.rigId,
        nodeId: node.id,
        logicalId,
        discoveredId: discovered.id,
      });

      return { nodeId: node.id, sessionId: session.id };
    });

    try {
      const { nodeId, sessionId } = claimTx();
      const event = this.db.prepare("SELECT * FROM events ORDER BY seq DESC LIMIT 1").get() as { seq: number; type: string; rig_id: string; node_id: string; payload: string; created_at: string };
      if (event) {
        this.eventBus.notifySubscribers({
          type: "node.claimed",
          rigId: opts.rigId,
          nodeId,
          logicalId,
          discoveredId: discovered.id,
          seq: event.seq,
          createdAt: event.created_at,
        });
      }
      // 尽力而为：设置 zrig 所有的 tmux 元数据。
      try {
        await this.setRiggedMetadata(discovered.tmuxSession, {
          nodeId, sessionName: discovered.tmuxSession,
          rigId: opts.rigId, rigName: rig!.rig.name, logicalId,
        });
      } catch { /* 尽力而为 */ }
      this.maybeProvisionContextCollector(discoveredRuntime, discovered.cwd, discovered.tmuxSession);
      try {
        await startTmuxTranscriptCapture(this.tmuxAdapter, this.transcriptStore, rig!.rig.name, discovered.tmuxSession);
      } catch { /* 尽力而为 */ }
      // 尽力而为：发送认领后的身份提示。
      try {
        await this.deliverClaimHint(discovered.tmuxSession, { rigName: rig!.rig.name, logicalId });
      } catch { /* 尽力而为 */ }
      // OPR.0.4.3.20 FR-3 — 在接入边界捕获恢复令牌。
      await this.captureResumeTokenOnAdoption({
        rigId: opts.rigId, nodeId, sessionId, sessionName: discovered.tmuxSession,
        runtime: discoveredRuntime ?? null,
      });

      return { ok: true, nodeId, sessionId };
    } catch (err) {
      return { ok: false, code: "claim_error", error: (err as Error).message };
    }
  }
}
