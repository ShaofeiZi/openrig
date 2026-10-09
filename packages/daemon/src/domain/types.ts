export interface Rig {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pod {
  id: string;
  rigId: string;
  namespace: string;
  label: string;
  summary: string | null;
  continuityPolicyJson: string | null;
  createdAt: string;
}

export interface ContinuityState {
  podId: string;
  nodeId: string;
  status: "healthy" | "degraded" | "restoring";
  artifactsJson: string | null;
  lastSyncAt: string | null;
  updatedAt: string;
}

export interface Node {
  id: string;
  rigId: string;
  logicalId: string;
  role: string | null;
  runtime: string | null;
  model: string | null;
  codexConfigProfile?: string | null;
  /** OPR.0.4.8.3 接缝 B：附加的 permission_policy 引用（builtin:<name> 或相对
   * 规范的自定义路径）；未附加时为 null（即采用下限）。 */
  permissionPolicy?: string | null;
  cwd: string | null;
  surfaceHint: string | null;
  workspace: string | null;
  restorePolicy: string | null;
  packageRefs: string[];
  podId: string | null;
  agentRef: string | null;
  profile: string | null;
  label: string | null;
  /** 保留经过校验的精确 RigSpec 声明，确保导出/重建保真。 */
  sessionSource?: SessionSourceSpec | null;
  resolvedSpecName: string | null;
  resolvedSpecVersion: string | null;
  resolvedSpecHash: string | null;
  occupantLifecycle: OccupantLifecycle | null;
  continuityOutcome: ContinuityOutcome | null;
  handoverResult: HandoverResult;
  previousOccupant: string | null;
  handoverAt: string | null;
  createdAt: string;
}

export interface Edge {
  id: string;
  rigId: string;
  sourceId: string;
  targetId: string;
  kind: string;
  createdAt: string;
}

export interface Binding {
  id: string;
  nodeId: string;
  attachmentType?: "tmux" | "external_cli";
  tmuxSession: string | null;
  tmuxWindow: string | null;
  tmuxPane: string | null;
  externalSessionName?: string | null;
  cmuxWorkspace: string | null;
  cmuxSurface: string | null;
  updatedAt: string;
}

export interface Session {
  id: string;
  nodeId: string;
  sessionName: string;
  status: string;
  resumeType: string | null;
  resumeToken: string | null;
  // OPR.0.4.3.20 FR-3/FR-6——恢复台账来源与验证新鲜度。
  // 字段可选，使迁移 45 前的记录和旧序列化快照安全降级（undefined 在恢复计划中
  // 视为缺失/未验证），绝不崩溃。
  resumeProvenance?: string | null;
  resumeLastVerified?: string | null;
  resumeLastProbeStatus?: string | null;
  restorePolicy: string;
  lastSeenAt: string | null;
  createdAt: string;
  origin: "launched" | "claimed";
  startupStatus: "pending" | "ready" | "attention_required" | "failed";
  startupCompletedAt: string | null;
}

// -- 事件类型 --

export type RigEvent =
  | { type: "proof.judged" | "proof.sources_changed"; scope: string; revision: string }
  | { type: "event.delivery_poisoned"; poisonedSeq: number; error: string; payloadSha: string }
  | { type: "rig.created"; rigId: string }
  // B8 / slice-07 A3——持久化的模型偏差声明记录：在最早可靠读取时对比实际模型与固定模型，
  // 并明确记录每个通道的投递结果（delivered/failed/deferred）。
  | {
      type: "seat.model_divergence";
      rigId: string;
      nodeId: string;
      sessionName: string;
      runtime: string | null;
      pinnedModel: string;
      effectiveModel: string;
      diagnosis: string | null;
      channels: Array<{ channel: string; target: string | null; status: string; detail?: string }>;
    }
  | { type: "rig.deleted"; rigId: string }
  | { type: "node.added"; rigId: string; nodeId: string; logicalId: string }
  | { type: "node.removed"; rigId: string; nodeId: string }
  | { type: "binding.updated"; rigId: string; nodeId: string }
  | { type: "session.status_changed"; rigId: string; nodeId: string; status: string }
  | { type: "session.detached"; rigId: string; nodeId: string; sessionName: string }
  // S5（OPR.0.5.4.7）——席位生命周期审计轨迹：三个受支持的席位动作都在执行
  // 修改的同一事务中持久化 actor 与 reason。
  | { type: "node.model_changed"; rigId: string; nodeId: string; logicalId: string; from: string | null; to: string; reason: string; operator: string | null }
  | { type: "node.permissions_changed"; rigId: string; nodeId: string; from: unknown; to: unknown; actor: string; reason: string; source: "seat_selection"; effect: "future_launches_only" }
  | { type: "session.stopped"; rigId: string; nodeId: string; sessionName: string; reason: string; operator: string | null }
  | { type: "session.cleaned"; rigId: string; nodeId: string; sessionName: string | null; reason: string; operator: string | null; actions: { sessionsExited: string[]; bindingCleared: boolean } }
  | { type: "node.launched"; rigId: string; nodeId: string; logicalId: string; sessionName: string }
  | { type: "topology.roster_recorded"; rigId: string; intendedNodeIds: string[]; source: "materialized_topology" }
  | { type: "seat.fresh_launched"; rigId: string; nodeId: string; logicalId: string; sessionName: string; sessionId: string; supersededSessionIds: string[]; retiringGeneration: string | null; newGeneration: string; nativeSessionId: string | null; nativeSessionIdReason?: string; model: string | null; startupPolicyHash: string; reason: string; operator: string | null; status: "ready" | "attention_required" }
  | { type: "seat.fresh_launch_failed"; rigId: string; nodeId: string; logicalId: string; sessionName: string; sessionId: string; supersededSessionIds: string[]; retiringGeneration: string | null; newGeneration: string | null; model: string | null; startupPolicyHash: string; reason: string; operator: string | null; errors: string[] }
  | { type: "snapshot.created"; rigId: string; snapshotId: string; kind: string }
  | { type: "restore.started"; rigId: string; snapshotId: string; snapshotSelection?: RestoreSnapshotSelection; intendedRoster?: Array<{ nodeId: string; logicalId: string }>; excludedNodes?: RestoreExcludedNode[] }
  | { type: "restore.completed"; rigId: string; snapshotId: string; result: RestoreResult }
  | { type: "restore.subset_completed"; rigId: string; snapshotId: string; result: RestoreResult }
  | { type: "node.held"; rigId: string; nodeId: string; logicalId: string; reason: string }
  // L3：reconcileNodeRuntimeTruth 在可见运行时证据前提成立后，将 failed/
  // attention_required 的 restoreOutcome 升级为 operator_recovered 时追加此事件
  // （绝不替换）。原失败事件保留在日志中；本事件记录升级审计轨迹。
  | { type: "restore.outcome_reconciled"; rigId: string; nodeId: string; attemptId: number; from: "failed" | "attention_required"; to: "operator_recovered"; evidence: { tmux: boolean; fgProcess: "claude" | "codex" | string; resumeTokenUsed: boolean; paneState: "usable" } | { source: string; reason?: string; kind?: string; state?: string; runtimeCwdVerified?: boolean } }
  | { type: "agent.activity"; rigId: string; nodeId: string; sessionName: string; runtime: string | null; activity: AgentActivity }
  // OPR.0.4.1.10 —— --dangerously-interact 发送触发目标交互提示/权限阻塞时的审计记录。
  // overrideReason = 调用方的 --reason；detectedReason/evidenceSource = 分类器观察结果。
  // 二者保持分离，使 permission_prompt、selection_prompt 与 unknown 的差异可见。
  | { type: "transport.prompt_override"; rigId: string; nodeId: string; sessionName: string; actorSession: string | null; detectedState: string; detectedReason: string; evidenceSource: string; overrideReason: string | null }
  // OPR.0.4.6.PI1 FR-5 —— "rpc" 来源是加法字段：Pi 会话身份来自 pi-runner 的
  // RPC get_state/类型化事件，绝不来自 pane 抓取。
  | { type: "agent.session_identity"; rigId: string; nodeId: string; sessionName: string; runtime: string; sessionId: string; provenance: "hook" | "scrape" | "rpc" }
  // OPR.0.4.0.22 —— 托管恢复令牌写入的仅追加审计。操作员设置（`operator_set`）
  // 和对账时的接管捕获（`reconcile_capture`）都会发送。绝不携带凭据级原始令牌；
  // `redacted: true` 表示令牌值被有意省略。
  | { type: "session.resume_token_set"; rigId: string; nodeId: string; sessionName: string; sessionId: string; resumeType: string; previousProvenance: "hook" | "scrape" | "operator" | null; newProvenance: "operator" | "scrape"; source: "operator_set" | "reconcile_capture"; reason?: string; operator?: string; redacted: true }
  // OPR.0.4.3.20 FR-3 —— 接管边界恢复令牌捕获（reconcile/adopt/bind）的仅追加
  // 可观测记录。`captured` 表示成功持久化（来源为 "adoption"）；`preserved` 表示
  // 已派生有效令牌，但来源守卫因已有更高等级令牌（hook/operator）拒绝写入，台账
  // 被正确保留，事件不能谎称发生了接管写入；`skipped` 以明确原因记录如实失败：
  // 席位本应恢复，但无法派生令牌，对应“明确呈现、无静默缺口”的验收标准。
  // terminal/unknown 运行时免于处理且不发事件。事件携带 resumeType/provenance，
  // 绝不携带原始令牌；`redacted: true` 表示有意省略令牌值。这属于可观测性，
  // 不是密钥边界控制；依据 2026-07-02 创始人裁定，恢复令牌不按密钥处理。
  | { type: "session.resume_token_captured"; rigId: string; nodeId: string; sessionName: string; sessionId: string; runtime: string; outcome: "captured" | "preserved" | "skipped"; resumeType?: string; provenance?: "adoption"; reason?: "missing_sidecar" | "parse_error" | "probe_timeout" | "invalid_token" | "higher_rank_present"; redacted: true }
  | { type: "seat.attention_cleared"; rigId: string; nodeId: string; sessionName: string; from: string; to: "ready"; clearedBy: "evidence" | "operator_attestation"; evidence?: { kind: string; state?: string; reason?: string }; reason?: string; previousError: string | null }
  | { type: "rig.imported"; rigId: string; specName: string; specVersion: string }
  // 包事件（跨工作组，无 rigId）。
  | { type: "package.validated"; packageName: string; valid: boolean }
  | { type: "package.planned"; packageName: string; actionable: number; deferred: number; conflicts: number }
  | { type: "package.installed"; packageName: string; packageVersion: string; installId: string; applied: number; deferred: number }
  | { type: "package.rolledback"; installId: string; restored: number }
  | { type: "package.install_failed"; packageName: string; code: string; message: string }
  // 引导事件（跨工作组，无 rigId）。
  | { type: "bootstrap.planned"; runId: string; sourceRef: string; stages: number }
  | { type: "bootstrap.started"; runId: string; sourceRef: string }
  | { type: "bootstrap.completed"; runId: string; rigId: string; sourceRef: string }
  | { type: "bootstrap.partial"; runId: string; sourceRef: string; rigId?: string; completed: number; failed: number }
  | { type: "bootstrap.failed"; runId: string; sourceRef: string; error: string }
  // 发现事件（跨工作组，无 rigId）。
  | { type: "session.discovered"; discoveredId: string; tmuxSession: string; tmuxPane: string; runtimeHint: string; confidence: string }
  | { type: "session.vanished"; tmuxSession: string; tmuxPane: string }
  | { type: "node.claimed"; rigId: string; nodeId: string; logicalId: string; discoveredId: string }
  // OPR.0.3.4.3——将一个实时（手动恢复的）规范会话重新采纳到其持久化节点中，
  // 不启动、不重新启动，也不输入。与 node.claimed 区分，避免误导操作者实际执行了哪种操作。
  | { type: "node.reconciled"; rigId: string; nodeId: string; logicalId: string; sessionName: string }
  | { type: "seat.handover_completed"; rigId: string; nodeId: string; logicalId: string; previousOccupant: string; currentOccupant: string; source: string; reason: string; operator: string | null;
      /** OPR.0.5.5.5（修复 B2）——已执行的来源结果。持久化后，持久记录（不仅是命令响应）
       *  会携带用于预热后继者的内容：fork 来源，或 rebuild 的精确预热集合、缺口与空链原因。 */
      sourceOutcome?:
        | { mode: "fork"; forkedFrom: string }
        | { mode: "rebuild"; primedArtifacts: Array<{ address: string; label: string }>; gaps: string[]; emptyChainReason?: string } }
  // Bundle 事件（跨工作组）。
  | { type: "bundle.created"; bundleName: string; bundleVersion: string; archiveHash: string }
  // 拆除事件。
  | { type: "rig.stopped"; rigId: string }
  // OPR.0.3.3.19 —— 工作组归档能力（软操作、可逆，并非删除）。
  | { type: "rig.archived"; rigId: string }
  | { type: "rig.unarchived"; rigId: string }
  // AgentSpec 重启事件——pod、启动和连续性。
  | { type: "pod.created"; rigId: string; podId: string; namespace: string; label: string }
  | { type: "pod.deleted"; rigId: string; podId: string }
  | { type: "node.startup_pending"; rigId: string; nodeId: string; startupProof?: StartupProofSelection }
  | { type: "node.startup_ready"; rigId: string; nodeId: string }
  | { type: "node.startup_failed"; rigId: string; nodeId: string; error: string; sessionId?: string; freshContextPending?: boolean }
  // OPR.0.4.3.06——启动证明（经挑战验证的定向），仅追加。
  // `node.startup_challenged` 冻结本次启动的挑战真相（challengeId + contractHash；
  // 预期答案每次重算，从不存储）。`node.startup_proof_verified`/`_rejected` 是已验证/
  // 已拒绝证据；`node.startup_proof_skipped` 在精简启动时退役此前挑战。它们都不经过
  // updateStartupStatus；`ready` 从不表示已完成定向。
  | { type: "node.startup_challenged"; rigId: string; nodeId: string; challengeId: string; contractHash: string }
  | { type: "node.startup_proof_skipped"; rigId: string; nodeId: string; reason: "not_selected" | "terminal" }
  | { type: "node.startup_proof_verified"; rigId: string; nodeId: string; sessionId: string; challengeId: string; contractHash: string }
  | { type: "node.startup_proof_rejected"; rigId: string; nodeId: string; challengeId: string | null; reason: "identity_unbound" | "identity_mismatch" | "challenge_stale" | "contract_mismatch" | "bare_ack" }
  | { type: "continuity.sync"; rigId: string; podId: string; nodeId: string }
  | { type: "continuity.degraded"; rigId: string; podId: string; nodeId: string; reason: string }
  // V0.3.1 slice 05 kernel-rig-as-default —— 前向修复 #3 的架构事件。
  // kernel 工作组未能在可配置的降级计时窗口（默认 90 秒）内达到 ready/
  // partial_ready 时，由 KernelBootTracker 恰好发送一次。该可观测信号表示 healthz
  // 已成功绑定，但 kernel 自身卡住；操作员可用 `zrig ps --rig kernel` 排查。
  | { type: "kernel.agent.degraded"; agents: Array<{ sessionName: string; runtime: string; startupStatus: string }>; firstUnreadySince: string | null; detail: string | null }
  // 聊天事件。
  | { type: "chat.message"; rigId: string; messageId: string; sender: string; kind: string; body: string; topic?: string }
  // 扩展事件。
  | { type: "rig.expanded"; rigId: string; podId: string; podNamespace: string; nodes: Array<{ logicalId: string; status: string }>; status: string }
  // 协同原语（PL-004 Phase A）——stream/queue/inbox。
  // 范围按主机限定；rigId 保持 null，因为条目用字符串（`<member>@<rig>`）引用
  // 席位，并且可能跨工作组。
  | { type: "stream.emitted"; streamItemId: string; sourceSession: string; hintDestination: string | null; hintType: string | null; hintUrgency: string | null; interrupt: boolean }
  // OPR.0.4.4.19 FR-1：每个 queue.* 负载都携带 qitem 摘要。旧版或省略时为 null，
  // 但字段始终存在，使消费者无需二次获取即可为动态卡片设置标题。
  | { type: "queue.created"; qitemId: string; sourceSession: string; destinationSession: string; priority: string; tier: string | null; summary: string | null }
  | { type: "queue.handed_off"; qitemId: string; fromSession: string; toSession: string; closureReason: "handed_off_to"; summary: string | null }
  | { type: "queue.claimed"; qitemId: string; destinationSession: string; claimedAt: string; closureRequiredAt: string | null; summary: string | null }
  | { type: "queue.unclaimed"; qitemId: string; destinationSession: string; reason: string; summary: string | null }
  | { type: "qitem.fallback_routed"; qitemId: string; originalDestination: string; rerouteDestination: string; reason: string }
  | { type: "qitem.closure_overdue"; qitemId: string; destinationSession: string; closureRequiredAt: string; overdueSince: string }
  | { type: "inbox.absorbed"; inboxId: string; destinationSession: string; senderSession: string; promotedQitemId: string }
  | { type: "inbox.denied"; inboxId: string; destinationSession: string; senderSession: string; reason: string }
  // PL-004 Phase B R2：QueueRepository.update() 在一般状态变更（pending → blocked、
  // in-progress → done、关闭转换等）时发送 queue.updated。任何队列状态变更导致视图
  // 结果集变化时，view-event-bridge 都可唤醒 /api/views/:name/sse 的 SSE 消费者，
  // 而不只限于 create/handoff/claim/unclaim。
  | { type: "queue.updated"; qitemId: string; fromState: string; toState: string; closureReason: string | null; closureTarget: string | null; actorSession: string; summary: string | null }
  // 协同原语（PL-004 Phase B）——project（classifier）/view。
  // project.classified：stream 条目成功投影时发送。
  // classifier.lease_*：后台服务强制单写者租约的生命周期。
  // classifier.dead：检测到心跳缺失超过 TTL（失活推断）。
  // classifier.reclaimed：操作员命令已回收租约。
  // view.changed：视图投影结果集变化（SSE 消费者可见增量）。
  | { type: "project.classified"; projectId: string; streamItemId: string; classifierSession: string; classificationType: string | null; classificationDestination: string | null }
  | { type: "classifier.lease_acquired"; leaseId: string; classifierSession: string; acquiredAt: string; expiresAt: string }
  | { type: "classifier.lease_expired"; leaseId: string; classifierSession: string; expiredAt: string }
  | { type: "classifier.dead"; leaseId: string; classifierSession: string; lastHeartbeat: string; detectedAt: string }
  | { type: "classifier.reclaimed"; leaseId: string; previousClassifierSession: string; reclaimedBySession: string; reason: string; reclaimedAt: string }
  | { type: "view.changed"; viewName: string; cause: string }
  // PL-004 Phase C：后台服务原生看门狗监管树事件。
  // 范围内含三种策略（periodic-reminder、artifact-pool-ready、
  // edge-artifact-required）；workflow-keepalive 延后到 Phase D。纯 `not_due` 轮询
  // 不写入历史，也不作为事件发送；只记录有意义的评估与生命周期转换。
  | { type: "watchdog.evaluation_fired"; jobId: string; policy: string; targetSession: string; deliveryStatus: string }
  | { type: "watchdog.evaluation_skipped"; jobId: string; policy: string; skipReason: string }
  | { type: "watchdog.evaluation_terminal"; jobId: string; policy: string; terminalReason: string }
  | { type: "watchdog.job_registered"; jobId: string; policy: string; targetSession: string; registeredBy: string }
  | { type: "watchdog.job_stopped"; jobId: string; reason: string }
  // PL-004 Phase D：后台服务原生工作流运行时事件。步骤关闭与下一个 qitem 投影在
  // 同一个后台服务事务中发送（事务式记录契约），订阅方以原子方式观察二者。
  | { type: "workflow.revised"; instanceId: string; workflowName: string; operationKey: string; compiledInputDigest: string; revisedBy: string }
  | { type: "workflow.instantiated"; instanceId: string; workflowName: string; workflowVersion: string; createdBy: string }
  | { type: "workflow.step_closed"; instanceId: string; stepId: string; closureReason: string; actorSession: string; priorQitemId: string }
  | { type: "workflow.next_qitem_projected"; instanceId: string; nextQitemId: string; nextOwner: string; nextStepId: string }
  | { type: "workflow.completed"; instanceId: string; workflowName: string }
  | { type: "workflow.failed"; instanceId: string; workflowName: string; reason: string }
  | { type: "workflow.resumed"; instanceId: string; workflowName: string; stepId: string; occurrenceId?: string; resumedBy: string; decision: string | null; resumeCount: number }
  // OPR.0.4.6.WF3 FR-4（架构 R1）：为 route 动作做增量扩展；已交付的 {rigName, cause}
  // 使用方不受影响，route 事件通过可选字段携带重路由详情。
  | { type: "workflow.routing_table_changed"; rigName: string; cause: string; instanceId?: string; stepId?: string | null; from?: string; to?: string }
  // Slice 11 (release-0.3.1 workflow-spec-folder-discovery): folder-scan
  // 删除路径。当源文件从已扫描 workflows 目录消失而移除 workflow_specs 缓存行时，每行发送一次。
  // 为 OQ-4 提供可追踪的审计日志条目：“文件消失时移除缓存行并记录审计日志；资料库整洁且可追踪。”
  | { type: "workflow_spec.removed"; sourcePath: string; specId: string | null; specName: string | null; specVersion: string | null; reason: "file_disappeared" }
  // PL-005 阶段 A：任务控制台/队列可观测性事件。用于操作审计和跨 CLI 版本漂移检测。
  // 重新计算任务控制台视图时发送 view_refreshed，SSE 使用方可自行决定是否重新获取。
  | { type: "mission_control.action_executed"; actionId: string; actionVerb: string; qitemId: string | null; actorSession: string }
  | { type: "mission_control.cli_drift_detected"; rigName: string; missingField: string; observedAt: string }
  | { type: "mission_control.view_refreshed"; viewName: string; cause: string }
  // PL-005 Phase B：通知分发事件。尽力交付；失败不会中断被通知的底层动作。
  | { type: "mission_control.notification_sent"; mechanism: string; target: string; qitemId: string | null; sentAt: string }
  | { type: "mission_control.notification_failed"; mechanism: string; target: string; qitemId: string | null; error: string; failedAt: string };

export type PersistedEvent = RigEvent & {
  seq: number;
  createdAt: string;
};

// -- 复合类型 --

export interface NodeWithBinding extends Node {
  binding: Binding | null;
}

export interface RigWithRelations {
  rig: Rig;
  nodes: NodeWithBinding[];
  edges: Edge[];
}

export interface PersistedProjectionEntry {
  category: string;
  effectiveId: string;
  sourceSpec: string;
  sourcePath: string;
  resourcePath: string;
  absolutePath: string;
  resourceType?: string;
  mergeStrategy?: string;
  target?: string;
}

export interface NodeStartupSnapshot {
  projectionEntries: PersistedProjectionEntry[];
  resolvedStartupFiles: import("./runtime-adapter.js").ResolvedStartupFile[];
  startupActions: StartupAction[];
  runtime: string;
}

export interface SnapshotData {
  rig: Rig;
  nodes: NodeWithBinding[];
  edges: Edge[];
  sessions: Session[];
  /** OPR.0.5.7.1 D1——快照时显式捕获的活跃占用者关系：nodeId 映射到当时作为
   *  节点实时占用者的会话行 ID；若捕获时不存在唯一占用者（零个或多个运行行）则为 null。
   *  恢复直接消费此字段，从不根据行顺序推断占用者。旧快照中缺失时，恢复回退到唯一运行
   *  不变量；若存在歧义，该席位在解决前不可恢复，绝不采用“最新行胜出”。 */
  activeSessionIdByNode?: Record<string, string | null>;
  /** OPR.0.5.9.14——显式占用者真相。与旧关系映射不同，此处不复用 null：
   *  零候选为 absent，一个实时候选为 resolved，多个候选保留其精确 ID。 */
  activeOccupantsByNode?: Record<string, SnapshotOccupantState>;
  /** 此快照恢复尝试不可变的预期成员集合。历史节点记录仍保留在 `nodes` 中，但不在
   * 本名册内。 */
  topologyRoster?: SnapshotTopologyRoster;
  checkpoints: Record<string, Checkpoint | null>;
  pods?: Pod[];
  continuityStates?: ContinuityState[];
  nodeStartupContext?: Record<string, NodeStartupSnapshot | null>;
  envReceipt?: EnvReceipt | null;
}

export type SnapshotOccupantState =
  | { kind: "resolved"; sessionId: string }
  | { kind: "absent" }
  | { kind: "ambiguous"; candidateIds: string[] };

export interface SnapshotTopologyRoster {
  version: 1;
  source: "materialized_topology" | "operator_explicit" | "legacy_current_nodes";
  intendedNodeIds: string[];
}

export interface RestoreSnapshotSummary {
  snapshotId: string;
  kind: string;
  createdAt: string;
  ageMs: number;
}

export interface RestoreSnapshotSelection extends RestoreSnapshotSummary {
  mode: "explicit" | "automatic";
  rationale: string;
  newerUsableAlternative: RestoreSnapshotSummary | null;
}

export interface RestoreExcludedNode {
  nodeId: string;
  logicalId: string;
  reason: "historical_not_in_intended_roster";
}

export interface Snapshot {
  id: string;
  rigId: string;
  kind: string;
  status: string;
  data: SnapshotData;
  createdAt: string;
}

export interface Checkpoint {
  id: string;
  nodeId: string;
  summary: string;
  currentTask: string | null;
  nextStep: string | null;
  blockedOn: string | null;
  keyArtifacts: string[];
  confidence: string | null;
  podId: string | null;
  continuitySource: string | null;
  continuityArtifactsJson: string | null;
  createdAt: string;
}

export interface RestoreResult {
  snapshotId: string;
  preRestoreSnapshotId: string | null;
  rigResult: RestoreRigResult;
  nodes: RestoreNodeResult[];
  warnings: string[];
  blockers?: RestoreValidationBlocker[];
  snapshotSelection?: RestoreSnapshotSelection;
  intendedRoster?: Array<{ nodeId: string; logicalId: string }>;
  excludedNodes?: RestoreExcludedNode[];
}

export type RestoreRigResult = "fully_restored" | "partially_restored" | "failed" | "not_attempted";

export interface RestoreValidationBlocker {
  code: string;
  severity: "critical";
  nodeId?: string;
  logicalId?: string;
  target?: string;
  path?: string;
  message: string;
  remediation: string;
}

export interface RestoreNodeResult {
  nodeId: string;
  logicalId: string;
  // L3：启动后探针检测到 Claude 恢复选择提示时设置 `attention_required`。
  // `operator_recovered` 是 `restore.outcome_reconciled` 之后的终态结果；恢复编排器
  // 流水线从不直接产生，只能由 reconcileNodeRuntimeTruth 产生。
  //
  // OPR.0.3.4.2——获准的五词恢复词汇：`resumed`（恢复原会话）；`fresh-primed`
  //（有意从空白状态启动，由策略或 --fresh 驱动，取代旧启动结果 `fresh`）；
  // `awaiting-decision`（原会话不可恢复且无 --fresh：已停止且运行会话为零，必须由操作者选择）；
  // `attention_required`（实时会话停在运行时提示处）；`failed`（仅真实 harness 错误）。
  // 会话仍在运行时绝不发出 `awaiting-decision`。`fresh` 只保留给旧连续性恢复跳过路径；
  // `rebuilt`/`operator_recovered` 不属于这五词划分。
  status: "resumed" | "rebuilt" | "fresh" | "fresh-primed" | "awaiting-decision" | "failed" | "attention_required" | "operator_recovered";
  error?: string;
  /** status 为 `attention_required` 时捕获的 pane 证据（L3，可选）。 */
  attentionEvidence?: string | null;
}

export type RestoreOutcome =
  | { ok: true; result: RestoreResult }
  | { ok: false; code: "snapshot_not_found"; message: string }
  | { ok: false; code: "snapshot_wrong_rig"; message: string }
  | { ok: false; code: "snapshot_unusable"; message: string }
  | { ok: false; code: "no_usable_snapshot"; message: string }
  | { ok: false; code: "rig_not_found"; message: string }
  | { ok: false; code: "rig_not_stopped"; message: string }
  | { ok: false; code: "restore_error"; message: string }
  | { ok: false; code: "restore_in_progress"; message: string }
  | { ok: false; code: "service_boot_failed"; message: string }
  | { ok: false; code: "pre_restore_validation_failed"; message: string; result: RestoreResult };

// -- 节点清单投影（NS-T02）--

// L3 增加 `attention_required`（Claude 恢复选择提示的代理）与 `operator_recovered`
//（终端对账后的结果；恢复过程从不直接产生，只通过 `restore.outcome_reconciled` 发出）。
// OPR.0.3.4.2——把五词恢复词汇带入 `rig ps`。
export type NodeRestoreOutcome = "resumed" | "rebuilt" | "fresh" | "fresh-primed" | "awaiting-decision" | "failed" | "attention_required" | "operator_recovered" | "n-a";

// OPR.0.4.3.06——经挑战验证的启动定向，与 startupStatus 不同（`ready` 只表示
// 已投递/可交互）。`verified` 表示回答本次启动挑战的证明已接受；`missing` 表示已挑战
// 但尚未证明；`rejected` 表示本挑战的最新证明被拒绝；`n-a` 表示从未挑战
//（恢复式续接、非智能体或跳过 harness）。
export type NodeOriented = "verified" | "missing" | "rejected" | "n-a";
export type OccupantLifecycle = "active" | "retiring" | "retired" | "context_walled" | "compacted" | "crashed" | "unknown";
export type ContinuityOutcome = "resumed" | "rebuilt" | "forked" | "fresh" | "failed";
export type HandoverResult = "complete" | "unchanged" | "partial" | "failed" | null;
export type AgentActivityState = "running" | "needs_input" | "idle" | "unknown";
export type AgentActivityEvidenceSource =
  | "runtime_hook"
  | "pane_heuristic"
  /** ACTIVITY D1+D2——tmux `#{window_activity}` 动态（SeatActivityService）。这是关于窗格字节的
   * 事实，因此与运行时无关：正在生成内容的 Codex 席位和 Claude 席位表现相同；基于 TUI 字符串
   * 的匹配器则会在每次提供方换肤时重新学习。自 slice 15 起，UI 将此来源称为
   * `terminal_activity`（activity-visuals.ts）；后台服务沿用同一名称，不为同一信号另造词汇。 */
  | "terminal_activity"
  | "tmux_session"
  | "external_cli"
  | "session_registry";

export interface AgentActivity {
  state: AgentActivityState;
  reason: string;
  evidenceSource: AgentActivityEvidenceSource;
  sampledAt: string;
  evidence: string | null;
  eventAt?: string | null;
  rawEvent?: string | null;
  rawSubtype?: string | null;
  runtime?: string | null;
  fallback?: boolean;
  stale?: boolean;
  /** W2a-1——记录此声明时生效的占用任期 generation_uuid。它是逐任期的占用者身份：
   *  新占用者会改变该值（交接/替换到不同占用者会生成新代），并且只在单次任期内保持
   *  不变（同一原生会话重新启动属于延续，代次不变）。null 表示记录时未知。跨交接保持
   *  稳定的是 node_id 而不是本字段，这正是比较 generation 能发现死亡任期的原因。 */
  generation?: string | null;
  /** W2a-1——占用者代次的读取侧来源判定（仅在读取经注入的代次解析器完成时存在）。
   *  `resolved` 表示记录代次和实时代次都已知且在此相等；已知但不相等时会改为返回
   *  state:"unknown"。`unresolved` 表示任一侧为 null，此时声明仍会投递并带上诚实标签，
   *  而非被丢弃或无来源归因（PM 裁定 2026-08-08，P21 已认领时期模式）。未接入解析器
   *  时缺失（旧版仅时钟路径）。 */
  generationProvenance?: "resolved" | "unresolved";
}

export interface NodeRecoveryGuidance {
  summary: string;
  commands: string[];
  notes: string[];
}

// 从会话/恢复状态和快照恢复元数据派生的逐节点生命周期投影。
// L2 冷启动真相模型：区分可恢复的分离节点与需要全新启动的节点，并为 L3 后的 Claude
// 恢复提示代理展示“需要关注”。
export type NodeLifecycleState = "running" | "detached" | "recoverable" | "attention_required";

/**
 * OPR.0.4.3.19——托管席位的存活身份判定。
 *
 * 它是第三条轴，与 slice-15 的 `terminalActive`（tmux 输出新鲜度）和
 * `hasAssignedWork`（队列派生）正交。它回答：席位已登记 tmux pane 中当前进程是否与
 * 我们正在报告的席位匹配？周期性 SeatIdentityReconciler 通过 pane PID/命令与已登记的
 * `bindings.tmux_pane` 计算，绝不来自队列、分类器或 hook 心跳。只有 `mismatch` 与
 * `pane_missing` 会把 `running` 投影降级；`verified`、`binding_absent`、
 * `tmux_unavailable` 以及无判定都保持原状。
 */
export type SeatIdentityVerdictKind = "verified" | "mismatch" | "pane_missing" | "binding_absent" | "tmux_unavailable";

export interface SeatIdentityVerdict {
  nodeId: string;
  verdict: SeatIdentityVerdictKind;
  /** 产生判定的观察维度；`verified` 时为 null。 */
  evidenceSource: "pane_process" | "tmux_session" | null;
  /** 非 verified 判定的具体原因；`verified` 时为 null。 */
  reason:
    | "process_identity_mismatch"
    | "process_identity_ambiguous"
    | "pane_ambiguous"
    | "pane_pid_gone"
    | "binding_pane_missing"
    | "session_missing"
    | "tmux_unavailable"
    | null;
  evidence: {
    registeredPane: string | null;
    observedPid: number | null;
    observedCommand: string | null;
    matchedLayer: number | null;
  };
  sessionName: string | null;
  observedAt: string;
}

/**
 * OPR.0.4.3.19——会把 `running`/`active` 投影降为非绿色状态的两类判定。
 * `verified`、`tmux_unavailable` 和缺失判定都保持投影不变（未知时开放失败）。
 */
export function identityVerdictDownranksRunning(
  verdict: SeatIdentityVerdictKind | null | undefined,
): boolean {
  return verdict === "mismatch" || verdict === "pane_missing";
}

// 根据逐节点状态折叠出的逐工作组生命周期聚合。
//   running            —— 所有节点都在运行。
//   recoverable        —— 所有节点均未运行，且至少一个节点有可用快照令牌。
//   stopped            —— 所有节点均未运行，且没有节点有可用快照令牌。
//   degraded           —— 同一工作组内同时存在运行和未运行节点。
//   attention_required —— 任一节点需要关注（优先级高于上述状态）。
export type RigLifecycleState = "running" | "recoverable" | "stopped" | "degraded" | "attention_required";

export interface NodeInventoryEntry {
  /** 稳定的后台服务节点身份。健康范围和其他规范记录用此值标识席位；logicalId
   * 仍是面向人的地址。 */
  nodeId: string;
  rigId: string;
  rigName: string;
  logicalId: string;
  podId: string | null;
  podNamespace?: string | null;
  /**
   * OPR.0.4.6.FAC1：席位声明的角色（`nodes.role`，由 pod-member 路径写入）。
   * 工作流绑定层的角色→席位候选筛选器精确读取此字段。null 表示无角色。
   */
  role: string | null;
  canonicalSessionName: string | null;
  attachmentType?: "tmux" | "external_cli" | null;
  nodeKind: "agent" | "infrastructure";
  runtime: string | null;
  sessionStatus: string | null;
  startupStatus: "pending" | "ready" | "attention_required" | "failed" | null;
  restoreOutcome: NodeRestoreOutcome;
  // OPR.0.4.3.06——经挑战验证的定向，与 startupStatus 并列展示，绝不折叠进去。
  oriented: NodeOriented;
  lifecycleState: NodeLifecycleState;
  occupantLifecycle: OccupantLifecycle;
  continuityOutcome: ContinuityOutcome | null;
  handoverResult: HandoverResult;
  previousOccupant: string | null;
  handoverAt: string | null;
  tmuxAttachCommand: string | null;
  resumeCommand: string | null;
  recoveryGuidance: NodeRecoveryGuidance | null;
  latestError: string | null;
  // 扩展字段。
  model: string | null;
  agentRef: string | null;
  profile: string | null;
  codexConfigProfile?: string | null;
  /** OPR.0.4.8.3 接缝 B：附加的 permission_policy 引用；未附加时为 null。 */
  permissionPolicy?: string | null;
  resolvedSpecName: string | null;
  resolvedSpecVersion: string | null;
  resolvedSpecHash: string | null;
  cwd: string | null;
  restorePolicy: string | null;
  resumeType: string | null;
  resumeToken: string | null;
  startupCompletedAt: string | null;
  agentActivity?: AgentActivity;
  contextUsage?: ContextUsage;
  /** 后台服务所拥有的该席位 transcript 捕获健康状态。 */
  transcriptIngest?: import("./transcript-store.js").TranscriptIngestHealth & {
    runtime: string | null;
  };
  /**
   * Slice 15——`terminal-active` 原语（tmux 字节流）。
   *
   *   true  → 席位当前正在产生 tmux 输出（window_activity 时间戳位于静默窗口内）；
   *   false → 席位静默时间已超过阈值；
   *   null  → 无信号（未绑定 tmux，或出现瞬时读取错误）。它与 `false` 不同：
   *           消费者将 `null` 视为“当前没有观察结果”，而非“确定空闲”。
   *
   * 绝不能从 `hasAssignedWork` 或队列/分配状态派生。非推断契约（slice 15 README +
   * IMPL-PRD §2.3）是核心正确性要求：本字段独立于 `hasAssignedWork` 计算。
   */
  terminalActive?: boolean | null;
  /** S19——由唯一判定源（SeatActivityService 阶梯）提供的仲裁后三轴分类状态。
   *  `display` 由服务端通过唯一 deriveDisplayActivity 桥计算，消费者无需重新派生词汇。
   *  字段缺失表示旧增强路径；null 表示判定源没有该席位状态（如实呈现）。 */
  activityState?: {
    activity: string;
    display: string;
    needsInput: { count: number; reason: string | null };
    decidedBy: string | null;
    seq: number;
    lastSwap: { generation: string; at: string } | null;
  } | null;
  /**
   * 架构裁定 3a947fb1（FR-7 加法变更）——席位原始 `lastActivityAt` 事实
   *（SeatActivity.lastActivityAt），与 `terminalActive` 一起逐席位投影。有观察时为 ISO
   * 字符串；从未轮询或非 tmux 席位无观察时为 null；未接入 SeatActivityService 时为
   * undefined，与 `terminalActive` 使用的诚实缺失阶梯完全一致。不提供 `ageSeconds`
   * 同级字段：时长是视图层根据该事实和读取者时钟派生的值（C3）。
   */
  lastActivityAt?: string | null;
  /**
   * Slice 15——`has-work-to-do` 原语。由队列/分配投影派生：状态为 pending、
   * in-progress 或 blocked，且 `destination_session` 与本席位规范坐标匹配的 qitem。
   *
   * 绝不能从 `terminalActive` 或 tmux 输出派生。二者是正交原语，不得相互推断。
   */
  hasAssignedWork?: boolean;
  /** 分配给此席位的 active qitem 总数（pending + in-progress + blocked）。 */
  assignedWorkCount?: number;
  /** 分配给此席位的 pending qitem 数（可选的低成本聚合）。 */
  pendingWorkCount?: number;
  /** 分配给此席位且已领取的 in-progress qitem 数（可选）。 */
  inProgressWorkCount?: number;
  /** 仍分配给此席位的 blocked qitem 数（可选）。 */
  blockedWorkCount?: number;
  /**
   * OPR.0.4.3.19——存活身份判定（第三条轴）。SeatIdentityReconciler 为节点记录过
   * 判定时存在；从未轮询时缺失（undefined）。`mismatch`/`pane_missing` 判定会把节点
   * `lifecycleState`/`occupantLifecycle` 从 running/active 降级并携带证据。绝不能从
   * `terminalActive`、`hasAssignedWork` 或任何队列/分类器/hook 心跳派生，只看进程身份。
   */
  identityVerdict?: SeatIdentityVerdict | null;
  /** OPR.0.3.4.11——从最新 `node.held` 事件派生的暂停原因。没有暂停事件，或被运行中
   *  会话/后续启动取代时为 null。 */
  heldReason?: string | null;
  /** PL-007：工作组声明工作区时的逐节点工作区块。workspaceRoot 镜像
   *  RigSpec.workspace.workspaceRoot。activeRepo 是路径包含节点 cwd 的仓库；若无匹配仓库，
   *  则采用 RigSpec.workspace.defaultRepo。kind 是活跃仓库类型；cwd 位于 knowledgeRoot
   *  下时为 `knowledge`。工作组未声明工作区时为 null。 */
  workspace?: NodeWorkspaceInfo | null;
}

/**
 * Slice 15——单席位 pane 的 `terminal-active` 观察。
 *
 * 来源为 tmux 的 `#{window_activity}` 格式，即窗口最后一次输出的 Unix 秒时间戳。
 * 生产服务按可配置频率轮询时间戳并与静默窗口阈值比较；最近活动仍在窗口内时，
 * `isActiveWithinWindow` 为 true。后台服务启动时不再配置 tmux 的 `monitor-silence`
 * 选项（已在 OPR.0.4.0.18 移除）；`window_activity` 是唯一来源。
 */
export interface SeatActivity {
  /** tmux pane ID 或规范会话名，以后台服务实际绑定者为准。 */
  paneId: string;
  /** true 当且仅当 pane 在 `silenceWindowSeconds` 内产生过输出。 */
  isActiveWithinWindow: boolean;
  /** 观察时生效的配置阈值。 */
  silenceWindowSeconds: number;
  /** 最近一次观察的 ISO 时间戳。 */
  lastObservedAt: string;
  /**
   * 架构裁定 3a947fb1（FR-7 加法变更）——原始 `window_activity` 时间戳，即 pane
   * 最后输出时间，以 ISO 表示。服务已用它派生 active/idle；此处逐字公开，使消费者能
   * 计算新鲜的 idle-age = f(fact, reader-clock)。
   *
   * 这是从不钳制的原始事实：时钟偏差可能使其略晚于 `lastObservedAt`（服务把负时长
   * 视为活跃）；存储观察原值，渲染器只为展示而钳制。它不同于表示“我们何时观察”的
   * `lastObservedAt`，此字段表示 pane 何时最后产生输出。只有 tmux 返回信号时才有记录，
   * 因而记录存在时本字段必定存在；缺失即无记录。
   */
  lastActivityAt: string;
}

export interface NodeWorkspaceInfo {
  workspaceRoot: string;
  activeRepo: string | null;
  kind: WorkspaceKind | null;
}

export interface NodeDetailPeer {
  logicalId: string;
  canonicalSessionName: string | null;
  attachmentType?: "tmux" | "external_cli" | null;
  runtime: string | null;
}

export interface NodeDetailEdge {
  kind: string;
  to?: { logicalId: string; sessionName: string | null };
  from?: { logicalId: string; sessionName: string | null };
}

export interface NodeDetailTranscript {
  enabled: boolean;
  path: string | null;
  tailCommand: string | null;
}

export interface NodeDetailCompactSpec {
  name: string | null;
  version: string | null;
  profile: string | null;
  skillCount: number;
  guidanceCount: number;
}

export interface NodeDetailEntry extends NodeInventoryEntry {
  /** W3 可选单席位诊断；绝不填充到清单列表中。 */
  permissionDrift?: import("./permission-drift.js").PermissionDriftDiagnostic | null;
  binding: Binding | null;
  startupFiles: Array<{ path: string; deliveryHint: string; required: boolean }>;
  startupActions: Array<{ type: string; value: string }>;
  installedResources: Array<{ id: string; category: string; targetPath: string }>;
  recentEvents: Array<{ type: string; createdAt: string; payload: Record<string, unknown> }>;
  infrastructureStartupCommand: string | null;
  peers: NodeDetailPeer[];
  edges: { outgoing: NodeDetailEdge[]; incoming: NodeDetailEdge[] };
  transcript: NodeDetailTranscript;
  compactSpec: NodeDetailCompactSpec;
}

// -- AgentSpec 类型（AgentSpec 重启）--

export interface ImportSpec {
  ref: string;
  version?: string;
}

export interface StartupFile {
  /** 启动产物是文件；上下文包另行组合。 */
  kind?: "file";
  path: string;
  deliveryHint: "auto" | "guidance_merge" | "skill_install" | "send_text";
  required: boolean;
  appliesOn: ("fresh_start" | "restore")[];
}

export interface StartupProofSelection {
  mode: "authenticated" | "none";
  source: "authored" | "default";
  /** 在组合后的启动动作序列中的索引。 */
  actionIndex?: number;
}

export interface StartupAction {
  type: "slash_command" | "send_text" | "startup_proof";
  value: string;
  phase: "after_files" | "after_ready";
  appliesOn: ("fresh_start" | "restore")[];
  idempotent: boolean;
  builtin?: "session_identity";
}

export interface StartupBlock {
  files: StartupFile[];
  actions: StartupAction[];
}

export interface LifecycleDefaults {
  executionMode: "interactive_resident";
  // OPR.0.5.6.20 B-3/B-4：设为可选，使省略字段的 lifecycle 块在规范化后仍保留
  // “缺失”；未指定该字段的层级不参与优先级。defaults 层负责实体化默认值
  //（按 F-6 使用 default-compaction；恢复使用 resume_if_possible）。
  compactionStrategy?: "default-compaction" | "managed-compaction" | "handover" | "apprentice-handover";
  /** 执行 apprentice 切换的规范 seat@rig 地址。无默认值：缺失会使 apprentice-handover
   *  在实体化时被拒绝。 */
  mechanic?: string;
  restorePolicy?: "resume_if_possible" | "relaunch_fresh" | "checkpoint_only";
}

export interface SkillResource { id: string; path: string; }
export interface GuidanceResource { id: string; path: string; target: string; merge: "managed_block" | "append"; }
export interface SubagentResource { id: string; path: string; }
export interface RuntimeResource { id: string; path: string; runtime: string; type: string; }

export type PluginSource =
  | { kind: "local"; path: string };

export interface PluginResource {
  id: string;
  source: PluginSource;
  pluginType?: "claude" | "codex" | "auto";
}

export interface AgentResources {
  skills: SkillResource[];
  guidance: GuidanceResource[];
  subagents: SubagentResource[];
  plugins: PluginResource[];
  runtimeResources: RuntimeResource[];
}

export interface ProfileSpec {
  summary?: string;
  preferences?: { runtime?: string; model?: string };
  startup?: StartupBlock;
  lifecycle?: LifecycleDefaults;
  uses: {
    skills: string[];
    guidance: string[];
    subagents: string[];
    plugins: string[];
    runtimeResources: string[];
  };
  /**
   * 逐席位活动检测调优。`silenceWindowSeconds` 是终端输出被判定为
   * “terminal-active”的时间阈值。当前尚未启用：实时 SeatActivityService 轮询器使用
   * 全局 3 秒默认值，不读取逐席位窗口。该字段保留给未来的逐席位轮询决策；无效值在
   * 规范化时丢弃。
   */
  activity?: {
    silenceWindowSeconds?: number;
  };
}

export interface AgentSpec {
  version: string;
  name: string;
  summary?: string;
  imports: ImportSpec[];
  defaults?: {
    runtime?: string;
    model?: string;
    lifecycle?: LifecycleDefaults;
  };
  startup: StartupBlock;
  resources: AgentResources;
  profiles: Record<string, ProfileSpec>;
}

// -- 旧版 RigSpec 类型（Phase 3，重启前的扁平契约）--
// TODO：AS-T08b/AS-T12 将所有消费者迁移到 pod-aware RigSpec 后删除。

export interface LegacyRigSpec {
  schemaVersion: number;
  name: string;
  version: string;
  nodes: LegacyRigSpecNode[];
  edges: LegacyRigSpecEdge[];
}

export interface LegacyRigSpecNode {
  id: string;
  runtime: string;
  role?: string;
  model?: string;
  cwd?: string;
  surfaceHint?: string;
  workspace?: string;
  restorePolicy?: string;
  packageRefs?: string[];
}

export interface LegacyRigSpecEdge {
  from: string;
  to: string;
  kind: string;
}

// -- RigSpec 类型（感知 pod，AgentSpec 重启）--

export interface ContinuityPolicySpec {
  enabled: boolean;
  syncTriggers?: string[];
  artifacts?: { sessionLog?: boolean; restoreBrief?: boolean; quiz?: boolean };
  restoreProtocol?: { peerDriven?: boolean; verifyViaQuiz?: boolean };
}

/**
 * 成员级启动输入，用于声明新托管席位如何派生初始上下文。按 `mode` 区分联合类型：
 *
 * - `fork`——从既有原生运行时对话来源启动（Claude `--fork-session` / Codex `fork`）；
 *   持久化一个新的 fork 后令牌；身份如实（父令牌绝不写入新席位）。v1 只支持
 *   `ref.kind: "native_id"`。
 *
 * - `rebuild`——用操作者声明的产物（CULTURE、角色文档、交接包、队列文件、会话日志）
 *   预热并全新启动席位。不执行原生运行时 resume 或 fork；结果席位没有 `resumeToken`；
 *   `continuityOutcome` 为 `"rebuilt"`，绝不是 `"fresh"`、`"resumed"` 或 `"forked"`。
 *   v1 只支持 `ref.kind: "artifact_set"`，其中 `ref.value` 是按操作者声明信任优先级
 *   排列的非空文件路径数组。
 */
export type SessionSourceSpec =
  | SessionSourceForkSpec
  | SessionSourceRebuildSpec
  | SessionSourceAgentImageSpec;

export interface SessionSourceForkSpec {
  mode: "fork";
  ref: {
    kind: "native_id" | "artifact_path" | "name" | "last";
    value?: string;
  };
}

export interface SessionSourceRebuildSpec {
  mode: "rebuild";
  ref: {
    kind: "artifact_set";
    value: string[];
  };
}

/**
 * PL-016 第 4 项——agent_image 会话来源。实例化器在 AgentImageLibraryService 中
 * 查找具名镜像，从 manifest 捕获运行时恢复令牌，并通过现有 fork 代码路径
 *（forkSource: { kind: "native_id", value: <resumeToken> }）派发启动，从而保留
 * `nativeResumeProbe` 语义。
 *
 * v0 只支持 `ref.kind: "image_name"`；按 PRD § v0 Out，`image_id` 和
 * `image_hash` 是已具名的 v1+ 触发项。
 */
export interface SessionSourceAgentImageSpec {
  mode: "agent_image";
  ref: {
    kind: "image_name";
    value: string;
    /** 可选版本选择器；消费时默认为 "1"，与 manifest 约定一致。 */
    version?: string;
  };
}

/**
 * 对具名 agent-starter 注册表条目的引用。它提供产物预热的全新启动上下文：启动时把
 * starter 精选产物加入成员启动文件链。它与 `sessionSource` 做加法组合，二者语义独立：
 * starter_ref 预热上下文，session_source 声明运行时来源模式。v0 schema 约束允许
 * `starter_ref` 与 `session_source.mode: "rebuild"` 组合（两者都在 `fresh_start` 应用），
 * 但禁止与 `session_source.mode: "fork"` 组合；v1+ 的“从已登记线程 ID 做真实原生 fork
 * 的 starter 证明”触发项负责覆盖该组合。
 */
export interface StarterRefSpec {
  /** 注册表键，对应 `<registryRoot>/<name>.yaml` 中的条目。 */
  name: string;
}

export interface RigSpecPodMember {
  id: string;
  label?: string;
  agentRef: string;
  profile: string;
  runtime: string;
  codexConfigProfile?: string;
  model?: string;
  /**
   * OPR.0.4.6.FAC1：可选的席位侧角色声明，通过 createMemberNode → addNode 写入
   * 现有 `nodes.role` 列。工作流绑定层据此维度把工作流角色解析为席位。此能力选择加入：
   * 无角色成员从不参与角色解析，只能通过显式 preferred_targets 到达。
   */
  role?: string;
  /** OPR.0.4.8.3 接缝 B：可选的逐席位 permission_policy 引用（builtin:<name> 或
   *  相对规范的自定义路径）。缺失表示采用下限；覆盖工作组级引用。 */
  permissionPolicy?: string;
  cwd: string;
  restorePolicy?: string;
  /** OPR.0.5.6.20——逐成员连续性覆盖（最具体者优先；解析时规范化规范拼写或弃用别名）。
   *  缺失表示继承。 */
  compactionStrategy?: string;
  /** 逐成员连续性机制覆盖值，与 compactionStrategy 一同解析。 */
  mechanic?: string;
  startup?: StartupBlock;
  /**
   * 可选的 fork 来源声明。v1 MVP 为 mode="fork" 且 ref.kind="native_id"。
   * 由 `rigspec-schema.ts` 校验，并在启动时转换为运行时适配器的 `forkSource` 选项。
   */
  sessionSource?: SessionSourceSpec;
  /**
   * 对具名 starter 注册表条目的可选引用，见 {@link StarterRefSpec}。启动时由
   * `AgentStarterResolver` 解析；解析后的产物用于预热成员启动文件链的 STARTER 层。
   * 按 v0 schema（validateStarterRef），它与 `sessionSource.mode: "fork"` 互斥。
   */
  starterRef?: StarterRefSpec;
}

export interface RigSpecPodEdge {
  kind: string;
  from: string;
  to: string;
}

export interface RigSpecCrossPodEdge {
  kind: string;
  from: string;
  to: string;
}

export interface RigSpecPod {
  id: string;
  label: string;
  summary?: string;
  continuityPolicy?: ContinuityPolicySpec;
  startup?: StartupBlock;
  members: RigSpecPodMember[];
  edges: RigSpecPodEdge[];
}

export interface RigSpecDoc {
  path: string;
}

/**
 * PL-007 工作区原语——类型化工作区种类枚举。v0 保留该集合；按 PL-007 产品规范，
 * 增加第六种属于 v1+ 修订。每种都有文件夹形态、frontmatter 契约和所有权规则；
 * 各类型必填字段映射见 `frontmatter-validator.ts`。
 */
export const WORKSPACE_KINDS = ["user", "project", "knowledge", "lab", "delivery"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

/** PL-007——类型化的 RigSpec.workspace.repos[] 条目。 */
export interface WorkspaceRepoSpec {
  name: string;
  /** 规范化后的绝对路径。作者可在 YAML 中声明相对于 `workspaceRoot` 的路径；
   * codec 在解析时将其转换为绝对路径。 */
  path: string;
  kind: WorkspaceKind;
}

/** PL-007——可选 RigSpec.workspace 块。未声明它的工作组仍然有效；此时 whoami /
 *  node-inventory 返回 null 工作区块。 */
export interface WorkspaceSpec {
  workspaceRoot: string;
  repos: WorkspaceRepoSpec[];
  defaultRepo?: string;
  /** 可选的知识规范根目录（例如共享文档仓库路径）。通过 whoami/UI 呈现时视为
   * kind=knowledge。 */
  knowledgeRoot?: string;
}

export interface RigSpec {
  version: string;
  name: string;
  summary?: string;
  cultureFile?: string;
  /** OPR.0.4.8.3 接缝 B：可选的工作组级 permission_policy 引用（builtin:<name>
   *  或相对规范的自定义路径）。缺失表示采用下限；逐成员引用会覆盖它。 */
  permissionPolicy?: string;
  /** #25：逐运行时的托管块目标；缺失时为 CLAUDE.md。 */
  managedBlocks?: { "claude-code"?: import("./managed-blocks.js").ClaudeManagedBlockFile };
  docs?: RigSpecDoc[];
  startup?: StartupBlock;
  services?: RigServicesSpec;
  /** PL-007 工作区原语——可选的类型化工作区声明。 */
  workspace?: WorkspaceSpec;
  pods: RigSpecPod[];
  edges: RigSpecCrossPodEdge[];
}

export interface RigServicesWaitTarget {
  service?: string;
  condition?: "healthy";
  url?: string;
  tcp?: string;
}

export interface RigServicesSurfaceUrl {
  name: string;
  url: string;
}

export interface RigServicesSurfaceCommand {
  name: string;
  command: string;
}

export interface RigServicesSurface {
  urls?: RigServicesSurfaceUrl[];
  commands?: RigServicesSurfaceCommand[];
}

export interface RigServicesCheckpointHook {
  id: string;
  exportCommand: string;
  importCommand?: string;
}

export interface RigServicesSpec {
  kind: "compose";
  composeFile: string;
  projectName?: string;
  profiles?: string[];
  downPolicy?: "leave_running" | "down" | "down_and_volumes";
  waitFor?: RigServicesWaitTarget[];
  surfaces?: RigServicesSurface;
  checkpoints?: RigServicesCheckpointHook[];
}

export interface EnvReceipt {
  kind: "compose";
  composeFile: string;
  projectName: string;
  services: Array<{ name: string; status: string; health?: string | null }>;
  waitFor: Array<{ target: RigServicesWaitTarget; status: "healthy" | "unhealthy" | "pending"; detail?: string | null }>;
  capturedAt: string;
}

export interface EnvCheckpoint {
  kind: "compose";
  capturedAt: string;
  artifactsJson: string;
}

export interface RigServicesRecordInput {
  kind: "compose";
  specJson: string;
  rigRoot: string;
  composeFile: string;
  projectName?: string;
  latestReceiptJson?: string | null;
}

export interface RigServicesRecord {
  rigId: string;
  kind: "compose";
  specJson: string;
  rigRoot: string;
  composeFile: string;
  projectName: string;
  latestReceiptJson: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  /** OPR.0.5.3.3 —— 非阻塞建议（例如别名形式的模型固定）。失败开放：建议绝不影响
   * `valid`；没有建议时缺失或为空。 */
  advisories?: string[];
}

export interface PreflightResult {
  ready: boolean;
  warnings: string[];
  errors: string[];
}

export type InstantiateOutcome =
  | { ok: true; result: InstantiateResult }
  | { ok: false; code: "validation_failed"; errors: string[] }
  | { ok: false; code: "preflight_failed"; errors: string[]; warnings: string[] }
  | { ok: false; code: "instantiate_error"; message: string }
  | { ok: false; code: "cycle_error"; message: string }
  | { ok: false; code: "service_boot_failed"; message: string }
  // S5b（OPR.0.5.4.11）——运行中同名守卫拒绝：同名工作组正在运行，因此实例化会在
  // 任何创建/启动前拒绝。消息会说明该运行中工作组的身份和受支持的替代方案。
  //（按 r054-s5b-build 行的 orch-lead 领域裁定添加的变体。）
  | { ok: false; code: "rig_name_running"; message: string; runningRig: { id: string; name: string; runningSessionCount: number } }
  // OPR.0.3.2.CT（conveyor-trust-minimal-fix）：当每个已启动节点都进入可恢复的
  // attention_required 状态（例如工作区信任提示）时，不拆除工作组。工作组与会话会保留，
  // 可列出、可批准；操作者路径为“批准信任 → 恢复”。`attentionNodes` 携带可操作的逐节点
  // 详情，供路由的三段式错误响应使用。
  | {
      ok: false;
      code: "attention_required";
      message: string;
      rigId: string;
      attentionNodes: AttentionNode[];
    };

export interface AttentionNode {
  logicalId: string;
  sessionName: string;
  evidence?: string;
  reason: string;
}

export interface InstantiateResult {
  rigId: string;
  specName: string;
  specVersion: string;
  // 逐节点启动状态：`launched` 与 `failed` 是旧终态；`attention_required`
  //（OPR.0.3.2.CT）标记等待操作者操作（例如批准信任）的可恢复停放节点。会话行的
  // startup_status 携带相同信号，使 `rig ps` 能展示它。
  //
  // `sessionName` 与 `evidence` 携带 BootstrapOrchestrator 为 launched +
  // attention_required 混合路径构造 AttentionNode[] 所需的运行时详情；路由三段式错误响应
  // 需要 sessionName 生成 tmux-attach 提示。设为可选，因为旧调用方在仅终端路径中不提供它们。
  nodes: {
    logicalId: string;
    status: "launched" | "failed" | "attention_required";
    error?: string;
    sessionName?: string;
    evidence?: string;
  }[];
  warnings?: string[];
}

// -- 扩展类型 --

export interface ExpansionPodFragment {
  id: string;
  label: string;
  summary?: string;
  members: Array<{
    id: string;
    runtime: string;
    agentRef?: string;
    profile?: string;
    cwd?: string;
    model?: string;
    codexConfigProfile?: string;
    /** OPR.0.4.8.3 接缝 B：逐席位 permission_policy 引用，像 role 一样贯穿扩展入口，
     *  绝不静默丢弃。类型为 unknown（4ac243c3 的 R2）：入口保留原始“存在”事实，包括 null
     *  与其他无效形态，让唯一规范 RigSpec 校验器拒绝“存在但无效”的值；规范化器绝不能
     *  把存在抹成缺失/下限。 */
    permissionPolicy?: unknown;
    restorePolicy?: string;
    label?: string;
    /**
     * OPR.0.4.6.FAC1：可选席位侧角色，沿 buildExpansionSpecObject → pod-member
     * schema → nodes.role 传递；已提供的角色绝不静默丢弃，这是同级层规则。
     */
    role?: string;
    /** 可选的会话来源声明，贯穿传递到启动阶段。 */
    sessionSource?: SessionSourceSpec;
    /**
     * 对具名 starter 注册表条目的可选引用；沿 expansion → buildSyntheticSpec →
     * 后台服务实例化传递，与 `sessionSource` 的透传形态一致。
     */
    starterRef?: StarterRefSpec;
  }>;
  edges: Array<{ from: string; to: string; kind: string }>;
}

export interface ExpansionRequest {
  rigId: string;
  pod: ExpansionPodFragment;
  crossPodEdges?: Array<{ from: string; to: string; kind: string }>;
  rigRoot?: string;
}

export interface ExpansionNodeOutcome {
  logicalId: string;
  nodeId: string;
  // OPR.0.3.2.CT——`attention_required` 是可恢复的停放状态，例如等待操作者操作的
  // 工作区信任提示。会话行 startup_status 携带同一信号，使 `rig ps` 展示它。
  // 该状态与终态 `failed` 不同。
  status: "launched" | "failed" | "attention_required";
  error?: string;
  sessionName?: string;
}

export type ExpansionResult =
  | { ok: true; status: "ok" | "partial" | "failed"; podId: string; podNamespace: string; nodes: ExpansionNodeOutcome[]; warnings: string[]; retryTargets: string[] }
  | { ok: false; code: string; error: string };

// -- 上下文用量类型 --

export type ContextAvailability = "known" | "unknown";

export type ContextUnknownReason =
  | "unsupported_runtime"
  | "not_managed"
  | "missing_sidecar"
  | "parse_error"
  | "stale"
  | "session_mismatch"
  | "stale_generation"
  | "no_data";

export interface ContextUsage {
  availability: ContextAvailability;
  reason: ContextUnknownReason | null;
  source: "claude_statusline_json" | "codex_token_count_jsonl" | null;
  usedPercentage: number | null;
  remainingPercentage: number | null;
  contextWindowSize: number | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  currentUsage: string | null;
  transcriptPath: string | null;
  sessionId: string | null;
  sessionName: string | null;
  sampledAt: string | null;
  fresh: boolean;
}
