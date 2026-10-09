import { healthDiagnosisRoutes } from "./routes/health-diagnosis.js";
import type { HealthDiagnosisService } from "./domain/health-diagnosis.js";
import type { HealthPolicyStore } from "./domain/health-policy.js";
import type { HealthCheckpointSource } from "./domain/health-checkpoints.js";
import { Hono } from "hono";
import fs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { stampFields } from "./build-info.js";
import type { RigRepository } from "./domain/rig-repository.js";
import type { SessionRegistry } from "./domain/session-registry.js";
import type { DaemonLifecycleStore } from "./domain/daemon-lifecycle-store.js";
import type { EventBus } from "./domain/event-bus.js";
import type { NodeLauncher } from "./domain/node-launcher.js";
import type { TmuxOptionDefaultsApplier } from "./domain/tmux-option-defaults.js";
import type { TmuxAdapter } from "./adapters/tmux.js";
import type { CmuxAdapter } from "./adapters/cmux.js";
import type { SnapshotCapture } from "./domain/snapshot-capture.js";
import type { SnapshotRepository } from "./domain/snapshot-repository.js";
import type { RestoreOrchestrator } from "./domain/restore-orchestrator.js";
import type { RigSpecExporter } from "./domain/rigspec-exporter.js";
import type { RigSpecPreflight } from "./domain/rigspec-preflight.js";
import type { RigInstantiator, PodRigInstantiator } from "./domain/rigspec-instantiator.js";
import type { PodBundleSourceResolver } from "./domain/bundle-source-resolver.js";
import type { PackageRepository } from "./domain/package-repository.js";
import type { InstallRepository } from "./domain/install-repository.js";
import type { InstallEngine } from "./domain/install-engine.js";
import type { InstallVerifier } from "./domain/install-verifier.js";
import type { BootstrapOrchestrator } from "./domain/bootstrap-orchestrator.js";
import type { BootstrapRepository } from "./domain/bootstrap-repository.js";
import type { DiscoveryCoordinator } from "./domain/discovery-coordinator.js";
import type { DiscoveryRepository } from "./domain/discovery-repository.js";
import type { ClaimService } from "./domain/claim-service.js";
import type { SelfAttachService } from "./domain/self-attach-service.js";
import { rigsRoutes } from "./routes/rigs.js";
import { sessionsRoutes, nodesRoutes, sessionAdminRoutes } from "./routes/sessions.js";
import { adaptersRoutes } from "./routes/adapters.js";
import { eventsRoute } from "./routes/events.js";
import { snapshotsRoutes, restoreRoutes } from "./routes/snapshots.js";
import { handleExportYaml, handleExportJson, rigspecImportRoutes } from "./routes/rigspec.js";
import { packagesRoutes } from "./routes/packages.js";
import { bootstrapRoutes } from "./routes/bootstrap.js";
import { discoveryRoutes } from "./routes/discovery.js";
import { bundleRoutes } from "./routes/bundles.js";
import { restoreCheckRoutes } from "./routes/restore-check.js";
import { crashCartRoutes } from "./routes/crash-cart.js";
import { agentsRoutes } from "./routes/agents.js";
import { psRoutes } from "./routes/ps.js";
import type { PsProjectionService } from "./domain/ps-projection.js";
import type { UpCommandRouter } from "./domain/up-command-router.js";
import type { RigTeardownOrchestrator } from "./domain/rig-teardown.js";
import { upRoutes } from "./routes/up.js";
import { infoRoutes } from "./routes/info.js";
import { downRoutes } from "./routes/down.js";
import { kernelStatusRoutes } from "./routes/kernel-status.js";
import { startupRoutes } from "./routes/startup.js";
import type { TranscriptStore } from "./domain/transcript-store.js";
import type { SessionTransport } from "./domain/session-transport.js";
import type { AgentActivityStore } from "./domain/agent-activity-store.js";
import { transcriptRoutes } from "./routes/transcripts.js";
import { transportRoutes } from "./routes/transport.js";
import { compactionRoutes } from "./routes/compaction.js";
import type { ClaudeCompactionEnforcer } from "./domain/claude-compaction-enforcer.js";
import { activityRoutes } from "./routes/activity.js";
import { askRoutes } from "./routes/ask.js";
import { wakeResolveRoutes } from "./routes/wake-resolve.js";
import type { AskService } from "./domain/ask-service.js";
import type { WakeResolveService } from "./domain/wake-resolve-service.js";
import { specReviewRoutes } from "./routes/spec-review.js";
import { specLibraryRoutes } from "./routes/spec-library.js";
// Phase 3a slice 3.3——plugin 发现路由（只读）。
// SC-29 例外 #8 原文：完整声明见 packages/daemon/src/routes/plugins.ts
// 头部。
import { pluginsRoutes } from "./routes/plugins.js";
import type { PluginDiscoveryService } from "./domain/plugin-discovery-service.js";
// Slice 28 Checkpoint C-3——skill-library 发现路由（只读）。
// SC-29 例外 #11 累计；完整声明见 routes/plugins.ts 头部。
import { skillsRoutes } from "./routes/skills.js";
import type { SkillLibraryDiscoveryService } from "./domain/skill-library-discovery.js";
import { configRoutes } from "./routes/config.js";
import { hostsRoutes } from "./routes/hosts.js";
import { hostReadThrough } from "./domain/hosts/read-through.js";
import { getSelfHostId, getSelfHostIdSource } from "./domain/hosts/fanout-contract.js";
import { contextPacksRoutes } from "./routes/context-packs.js";
import { agentImagesRoutes } from "./routes/agent-images.js";
import type { SpecReviewService } from "./domain/spec-review-service.js";
import type { SpecLibraryService } from "./domain/spec-library-service.js";
import type { ChatRepository } from "./domain/chat-repository.js";
import { whoamiRoutes } from "./routes/whoami.js";
import { providerRoutes } from "./routes/provider.js";
import type { ProviderService } from "./domain/provider/provider-service.js";
import type { WhoamiService } from "./domain/whoami-service.js";
import { PermissionDriftObserver, type PermissionDriftReader } from "./domain/permission-drift-observer.js";
import { chatRoutes } from "./routes/chat.js";
import { streamRoutes } from "./routes/stream.js";
import { queueRoutes } from "./routes/queue.js";
import { workspaceRoutes } from "./routes/workspace.js";
import { projectsRoutes } from "./routes/projects.js";
import { viewsRoutes } from "./routes/views.js";
import { watchdogRoutes } from "./routes/watchdog.js";
import { workflowRoutes } from "./routes/workflow.js";
import { missionControlRoutes } from "./routes/mission-control.js";
import { slicesRoutes } from "./routes/slices.js";
import { reviewRoutes } from "./routes/review.js";
import { rigModeRoutes } from "./routes/rig-mode.js";
import { missionsRoutes } from "./routes/missions.js";
import { rigCmuxRoutes } from "./routes/rig-cmux.js";
import { terminalRoutes, rigTerminalRoutes } from "./routes/terminal.js";
import { CmuxLayoutService } from "./domain/cmux-layout-service.js";
import { getNodeInventory } from "./domain/node-inventory.js";
import { filesRoutes } from "./routes/files.js";
import { progressRoutes } from "./routes/progress.js";
import { scopeAuditRoutes } from "./routes/scope-audit.js";
import { scopesRoutes } from "./routes/scopes.js";
import { telemetryRoutes } from "./routes/telemetry.js";
import { proofRoutes } from "./routes/proof.js";
import { scopeApproveRoutes } from "./routes/scope-approve.js";
import { registerTerminalWs } from "./routes/terminal-ws.js";
import { createNodeWebSocket } from "@hono/node-ws";
import { steeringRoutes } from "./routes/steering.js";
import { healthSummaryRoutes } from "./routes/health-summary.js";
import { attentionRoutes } from "./routes/attention.js";
import { healthRoutes } from "./routes/health.js";
import { gatewayRoutes } from "./routes/gateway.js";
import type { StreamStore } from "./domain/stream-store.js";
import { createSlowOpRequestMiddleware, type SlowOperationInstrumentation } from "./domain/slow-op-recorder.js";
import type { QueueRepository } from "./domain/queue-repository.js";
import type { InboxHandler } from "./domain/inbox-handler.js";
import type { OutboxHandler } from "./domain/outbox-handler.js";
import type { ProjectClassifier } from "./domain/project-classifier.js";
import type { ClassifierLeaseManager } from "./domain/classifier-lease-manager.js";
import type { ClassificationAttemptLedger } from "./domain/classification-attempts.js";
import type { ViewProjector } from "./domain/view-projector.js";
import type { WatchdogJobsRepository } from "./domain/watchdog-jobs-repository.js";
import type { WatchdogHistoryLog } from "./domain/watchdog-history-log.js";
import type { WatchdogPolicyEngine } from "./domain/watchdog-policy-engine.js";
import type { WatchdogScheduler } from "./domain/watchdog-scheduler.js";
import type { WorkflowRuntime } from "./domain/workflow-runtime.js";
import { envRoutes } from "./routes/env.js";
import type { RigLifecycleService } from "./domain/rig-lifecycle-service.js";
import { seatRoutes } from "./routes/seat.js";
import { createRouteTimingMiddleware } from "./domain/route-timing-recorder.js";

export interface AppDeps {
  proofSourceWatch?: import("./domain/proof/source-watch.js").ProofSourceWatch;
  /** S20——health 表面的生效 bind 计划（缺 = legacy body）。 */
  bindPlan?: { mode: "explicit" | "default"; hosts: string[]; tailscaleDetected: boolean; ignoredRoutingHost?: string };
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  /** P7——daemon 生命周期记录存储 + 本次启动的 epoch（heartbeat + 干净关闭）。 */
  daemonLifecycleStore: DaemonLifecycleStore;
  daemonBootEpoch: string;
  eventBus: EventBus;
  nodeLauncher: NodeLauncher;
  /** 席位范围的显式全新启动与工作组启动组合同一 startup owner。 */
  startupOrchestrator?: import("./domain/startup-orchestrator.js").StartupOrchestrator;
  tmuxAdapter: TmuxAdapter;
  /** OPR.0.4.6.02 S1——共享的 tmux option-defaults applier，暴露给席位交接路由，
   *  使全新继任者获得仅启动默认值。 */
  tmuxOptionDefaults?: TmuxOptionDefaultsApplier;
  cmuxAdapter: CmuxAdapter;
  snapshotCapture: SnapshotCapture;
  snapshotRepo: SnapshotRepository;
  /** Slice-04 OPR.0.5.0.4：provider read-model/precheck/switch 服务。缺时路由诚实返回 503。 */
  providerService?: ProviderService;
  restoreOrchestrator: RestoreOrchestrator;
  // OPR.0.4.3.20 FR-4——手动快照路由上的"序列化前刷新"用。
  resumeMetadataRefresher?: import("./domain/resume-metadata-refresher.js").ResumeMetadataRefresher;
  rigSpecExporter: RigSpecExporter;
  rigSpecPreflight: RigSpecPreflight;
  rigInstantiator: RigInstantiator;
  packageRepo: PackageRepository;
  installRepo: InstallRepository;
  installEngine: InstallEngine;
  installVerifier: InstallVerifier;
  bootstrapOrchestrator: BootstrapOrchestrator;
  bootstrapRepo: BootstrapRepository;
  discoveryCoordinator: DiscoveryCoordinator;
  discoveryRepo: DiscoveryRepository;
  claimService: ClaimService;
  selfAttachService?: SelfAttachService;
  rigExpansionService?: import("./domain/rig-expansion-service.js").RigExpansionService;
  rigLifecycleService?: RigLifecycleService;
  /**
   * Slice 15——席位活动服务（terminal-active 原语）。daemon 拥有一个实例并把它接到
   * PsProjectionService 和 per-node 增强。可选，使直接构造 AppDeps 的既有测试工具
   * 无需提供。
   */
  seatActivityService?: import("./domain/seat-activity-service.js").SeatActivityService;
  /** 5b82324b——结构性 pane 活动缓存；喂给 attachAgentActivity 使 ACTIVITY 真实。 */
  seatStructuralActivityService?: import("./domain/seat-structural-activity-service.js").SeatStructuralActivityService;
  /** OPR.0.4.3.19——定期 liveness 身份对账器（bind 后启动）。 */
  seatIdentityReconciler?: import("./domain/seat-identity-reconciler.js").SeatIdentityReconciler;
  psProjectionService: PsProjectionService;
  upRouter: UpCommandRouter;
  teardownOrchestrator: RigTeardownOrchestrator;
  podInstantiator: PodRigInstantiator;
  podBundleSourceResolver: PodBundleSourceResolver | null;
  runtimeAdapters?: Record<string, import("./domain/runtime-adapter.js").RuntimeAdapter>;
  transcriptStore?: TranscriptStore;
  sessionTransport?: SessionTransport;
  askService?: AskService;
  wakeResolveService?: WakeResolveService;
  chatRepo?: ChatRepository;
  streamStore?: StreamStore;
  slowOpRecorder?: SlowOperationInstrumentation;
  queueRepo?: QueueRepository;
  /** S02——常驻 stuck sweep 的可观测 heartbeat（healthz 上 ADDITIVE；缺 = legacy body）。
   *  由 index.ts 调度器在循环启动时设置。 */
  stuckSweepStatus?: import("./domain/queue-stuck-sweep.js").StuckSweepStatus;
  /** S01——wake-or-escalate 阶梯的 heartbeat + 未决 escalations 计数（healthz 上 ADDITIVE；
   *  缺 = legacy body）。operator rung 所述交付下限的一部分。 */
  wakeLadderStatus?: import("./domain/queue-wake-ladder.js").WakeLadderStatus;
  inboxHandler?: InboxHandler;
  outboxHandler?: OutboxHandler;
  shadowCapture?: import("./domain/shadow-capture.js").ShadowCapture;
  shadowCaptureError?: string;
  projectClassifier?: ProjectClassifier;
  classifierLeaseManager?: ClassifierLeaseManager;
  /** 0.6.0 S02 P1：持久化分类尝试台账。 */
  classificationAttemptLedger?: ClassificationAttemptLedger;
  viewProjector?: ViewProjector;
  watchdogJobsRepo?: WatchdogJobsRepository;
  watchdogHistoryLog?: WatchdogHistoryLog;
  watchdogPolicyEngine?: WatchdogPolicyEngine;
  watchdogScheduler?: WatchdogScheduler;
  /** B8 / slice-07 A3——模型分歧监视器（effective-vs-pinned，四通道 proclaim）。 */
  modelDivergenceMonitor?: import("./domain/model-divergence/model-divergence-monitor.js").ModelDivergenceMonitor;
  /** S10——daemon 内 gateway 子系统（修订 M1 §3：进程内，无第二个 deployable）。
   *  可选，使直接构造 AppDeps 的测试工具无需提供；health 路由在缺时诚实报告。 */
  gatewaySubsystem?: import("./domain/gateway/gateway-subsystem.js").GatewaySubsystem;
  periodicSnapshotScheduler?: import("./domain/periodic-snapshot-scheduler.js").PeriodicSnapshotScheduler;
  workflowRuntime?: WorkflowRuntime;
  /**
   * daemon 内置 workflow-specs 目录的绝对路径。`GET /api/workflow/specs` 用它
   * 计算每行 `isBuiltIn` 标志（source_path 在此目录下 → 内置；否则 → operator 编写）。
   * 可选：未设置时路由对每个 spec 返回 isBuiltIn=false（优雅——表面仍工作，只是无指示）。
   */
  workflowBuiltinSpecsDir?: string;
  /** Slice 11（工作流规格目录发现）——工作区 workflows
   *  目录绝对路径（通常 `<workspace.specs_root>/workflows`）。设置时 GET
   *  /api/specs/library 在每次 list 请求时机会式扫描此目录并呈现有效 + 诊断行。未设
   *  → 不扫描目录（仅 cache 行为）。 */
  workflowsFolderDir?: string;
  /** Slice 11——供 folder scanner 使用的 WorkflowSpecCache 实例，对有效 YAML
   *  read-through、对无效 YAML writeDiagnostic。与 workflowRuntime.specCache 同一
   *  singleton。 */
  workflowSpecCache?: import("./domain/workflow-spec-cache.js").WorkflowSpecCache;
  missionControlReadLayer?: import("./domain/mission-control/mission-control-read-layer.js").MissionControlReadLayer;
  missionControlWriteContract?: import("./domain/mission-control/mission-control-write-contract.js").MissionControlWriteContract;
  missionControlActionLog?: import("./domain/mission-control/mission-control-action-log.js").MissionControlActionLog;
  missionControlFleetCliCapability?: import("./domain/mission-control/mission-control-fleet-cli-capability.js").MissionControlFleetCliCapability;
  // Slice Story View v0——slice indexer + per-tab projector。两者都可选：slicesRoot
  // 未设置时路由返回清晰的 "slices_root_not_configured" 503，使 UI 可呈现设置提示。
  sliceIndexer?: import("./domain/slices/slice-indexer.js").SliceIndexer;
  reviewGatherer?: import("./domain/review/gather.js").ReviewGatherer;
  // OPR.0.4.6.02 C3——terminal-provider-ride composer（herdr/cmux 视图）。
  terminalService?: import("./domain/terminal/terminal-service.js").TerminalService;
  sliceDetailProjector?: import("./domain/slices/slice-detail-projector.js").SliceDetailProjector;
  /** User Settings v0——daemon 侧 settings 存储（env > file > default）。 */
  settingsStore?: import("./domain/user-settings/settings-store.js").SettingsStore;
  /** Preview Terminal v0（PL-018）——/preview 的 per-session 限流器。 */
  previewRateLimiter?: import("./domain/preview/preview-rate-limiter.js").PreviewRateLimiter<{
    content: string;
    lines: number;
    sessionName: string;
    capturedAt: string;
  }>;
  /** UI Enhancement Pack v0——文件 allowlist + 浏览器路由（item 3）。 */
  filesAllowlist?: import("./domain/files/path-safety.js").AllowlistRoot[];
  /** UI Enhancement Pack v0——原子写服务（item 4）。 */
  fileWriteService?: import("./domain/files/file-write-service.js").FileWriteService | null;
  /** UI 增强包 v0——工作区 PROGRESS.md 索引器（第 1B 项）。 */
  progressIndexer?: import("./domain/progress/progress-indexer.js").ProgressIndexer;
  /** 操作界面协调 v0——引导组合器（第 1 项）。 */
  steeringComposer?: import("./domain/steering/steering-composer.js").SteeringComposer;
  missionControlAuditBrowse?: import("./domain/mission-control/audit-browse.js").MissionControlAuditBrowse;
  missionControlNotificationDispatcher?: import("./domain/mission-control/notification-dispatcher.js").MissionControlNotificationDispatcher;
  /**
   * PL-005 Phase B：bearer token（或 loopback-only 模式下为 null）。
   * mission-control 路由用它在写动词上接 authBearerTokenMiddleware。
   */
  missionControlBearerToken?: string | null;
  terminalBearerToken?: string | null;
  enableNodeWebSocket?: boolean;
  specReviewService?: SpecReviewService;
  specLibraryService?: SpecLibraryService;
  /**
   * Phase 3a slice 3.3——plugin 发现服务（对 vendored + claude-cache + codex-cache 做
   * filesystem 扫描；读 agent.yaml 取 used-by）。只读；无 SQL。SC-29 #8 声明原文见
   * routes/plugins.ts。
   */
  pluginDiscoveryService?: PluginDiscoveryService;
  /**
   * Slice 28 Checkpoint C-3——skill-library 发现服务。合并 workspace + openrig 托管的
   * skill 源；经 daemon 安装路径解析 shared-skills（独立于 operator 的
   * OPENRIG_FILES_ALLOWLIST）。只读；无 SQL。SC-29 #11。
   */
  skillLibraryDiscoveryService?: SkillLibraryDiscoveryService;
  /** Workflows in Spec Library v0——active workflow lens 持久化。 */
  activeLensStore?: import("./domain/active-lens-store.js").ActiveLensStore;
  /** Rig Context / Composable Context Injection v0（PL-014）——context_packs 库服务。 */
  contextPackLibrary?: import("./domain/context-packs/context-pack-library-service.js").ContextPackLibraryService;
  /** Fork Primitive + Starter Agent Images v0（PL-016）——agent_images 库服务。 */
  agentImageLibrary?: import("./domain/agent-images/agent-image-library-service.js").AgentImageLibraryService;
  /** Fork Primitive + Starter Agent Images v0（PL-016）——snapshot 捕获器。 */
  snapshotCapturer?: import("./domain/agent-images/snapshot-capturer.js").SnapshotCapturer;
  /** PL-016 evidence-guard spec-roots（lazy supplier——每次扫描重算，使新安装的 spec
   *  被拾取）。 */
  agentImageSpecRoots?: () => readonly string[];
  whoamiService?: WhoamiService;
  /** W3 单席位、只读 runtime-policy 观察者。 */
  permissionDriftObserver?: PermissionDriftReader;
  contextUsageStore?: import("./domain/context-usage-store.js").ContextUsageStore;
  /** 0.5.10 S04——一个按需、只读 health projection，由各消费者共享。 */
  healthProjection?: import("./domain/health-detectors.js").HealthProjectionService;
  healthDiagnosis?: HealthDiagnosisService;
  healthPolicy?: HealthPolicyStore;
  healthCheckpoints?: HealthCheckpointSource;
  contextMonitor?: { pollOnce(): Promise<void> };
  /**
   * OPR.0.4.3.14——Claude compaction enforcer，暴露给路由用于手动 compaction 触发
   * （POST /api/compaction/trigger）。在 startup.ts 构造一次并与 ContextMonitor 共享
   * （同一实例，使手动 + 自动共享一个后半状态机——无第二条 restore 路径）。
   */
  compactionEnforcer?: ClaudeCompactionEnforcer;
  /**
   * GHOST-STAGE（e/Class-B）——规范的 OccupantInvalidator，在 startup 构造一次并注入，
   * 使 SeatHandoverService.commit() 的 re-key 调用真正触发（dev-driver 的 fold 加了可选调用
   * 但未接具体 impl——在此之前失效一直是死的）。
   */
  occupantInvalidator?: import("./domain/occupant-invalidator.js").OccupantInvalidator;
  nodeCmuxService?: import("./domain/node-cmux-service.js").NodeCmuxService;
  agentActivityStore?: AgentActivityStore;
  seatAttentionReconciler?: import("./domain/seat-attention-reconciler.js").SeatAttentionReconciler;
  activityHookToken?: string;
  serviceOrchestrator?: import("./domain/service-orchestrator.js").ServiceOrchestrator;
  composeAdapter?: import("./adapters/compose-services-adapter.js").ComposeServicesAdapter;
  uiDistDir?: string | null;
  /** V0.3.1 slice 05 kernel-rig-as-default——forward-fix #3 架构性。
   *  Tracker 经 GET /api/kernel/status 暴露。可选，因为测试 + 自定义 daemon 组装可能
   *  在不自动启动 kernel 的情况下构造 AppDeps；tracker 未接时路由带清晰消息返回 503。 */
  kernelBootTracker?: import("./domain/kernel-boot-tracker.js").KernelBootTracker;
  /** Slice 09（OPR.0.3.2.9）——operator-context-mode 绑定存储。
   *  可选：缺时 rig-policy 路由返回 503。 */
  rigModeStore?: import("./domain/rig-mode/rig-mode-store.js").RigModeStore;
  operatingPosture?: import("./domain/rig-mode/operating-posture.js").OperatingPostureService;
  /**
   * OPR.0.4.3.21——daemon event-loop 健康监视器。可选：缺时（例如直接构造的测试工具）
   * `/healthz` 保持其精确 `{ status: "ok" }` body。在 startup.ts 每个 daemon 构造一次，
   * 作为 wedge-detection 证据（loop lag / last-tick age / utilization / healthy 判定）
   * 呈现在富化的 `/healthz` payload 上。
   */
  eventLoopMonitor?: import("./domain/event-loop-monitor.js").EventLoopMonitor;
  /**
   * OPR.0.4.3.21——昂贵拓扑路由的请求时长记录器。可选（同理由）。存在时注册一个 timing
   * middleware，per-route 的滚动 last/max 呈现在 `/healthz` 上。
   */
  routeTimingRecorder?: import("./domain/route-timing-recorder.js").RouteTimingRecorder;
  /**
   * OPR.0.4.3.04——OpenRig 身份/活动 env，盖在席位交接全周期 composer 创建的继任 tmux
   * session 上，镜像 NodeLauncher 启动时用的 env。可选；三个核心身份变量始终由 composer
   * 内部派生。
   */
  sessionEnv?: Record<string, string | undefined>;
}

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function resolveDefaultUiDistDir(): string {
  return nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), "..", "..", "ui", "dist");
}

function safeResolveUiPath(uiDistDir: string, requestPath: string): string | null {
  const relativePath = requestPath.replace(/^\/+/, "") || "index.html";
  const resolvedPath = nodePath.resolve(uiDistDir, relativePath);
  const normalizedRoot = uiDistDir.endsWith(nodePath.sep) ? uiDistDir : `${uiDistDir}${nodePath.sep}`;
  if (resolvedPath !== uiDistDir && !resolvedPath.startsWith(normalizedRoot)) {
    return null;
  }
  return resolvedPath;
}

function fileResponse(filePath: string): Response {
  const ext = nodePath.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  const body = fs.readFileSync(filePath);
  return new Response(body, {
    headers: {
      "content-type": contentType,
    },
  });
}

function isUiAssetRequestPath(requestPath: string): boolean {
  const relativePath = requestPath.replace(/^\/+/, "");
  return relativePath.startsWith("assets/")
    || relativePath === "favicon.ico"
    || relativePath === "robots.txt"
    || relativePath === "manifest.webmanifest";
}

export function createApp(deps: AppDeps): Hono {
  // 硬性运行时不变量：所有 domain 服务必须共享同一数据库句柄。
  if (deps.rigRepo.db !== deps.eventBus.db) {
    throw new Error("createApp：rigRepo 与 eventBus 必须共享同一个数据库句柄");
  }
  if (deps.rigRepo.db !== deps.sessionRegistry.db) {
    throw new Error("createApp：rigRepo 与 sessionRegistry 必须共享同一个数据库句柄");
  }
  if (deps.rigRepo.db !== deps.snapshotRepo.db) {
    throw new Error("createApp：snapshotRepo 必须共享同一个数据库句柄");
  }
  if (deps.rigRepo.db !== deps.snapshotCapture.db) {
    throw new Error("createApp：snapshotCapture 必须共享同一个数据库句柄");
  }
  if (deps.rigRepo.db !== deps.restoreOrchestrator.db) {
    throw new Error("createApp：restoreOrchestrator 必须共享同一个数据库句柄");
  }
  if (deps.rigRepo.db !== deps.rigSpecExporter.db) {
    throw new Error("createApp：rigSpecExporter 必须共享同一个数据库句柄");
  }
  if (deps.rigRepo.db !== deps.rigSpecPreflight.db) {
    throw new Error("createApp：rigSpecPreflight 必须共享同一个数据库句柄");
  }
  if (deps.rigRepo.db !== deps.rigInstantiator.db) {
    throw new Error("createApp：rigInstantiator 必须共享同一个数据库句柄");
  }
  if (deps.rigRepo.db !== deps.packageRepo.db) {
    throw new Error("createApp：packageRepo 必须共享同一个数据库句柄");
  }
  if (deps.rigRepo.db !== deps.installRepo.db) {
    throw new Error("createApp：installRepo 必须共享同一个数据库句柄");
  }
  if (deps.rigRepo.db !== deps.bootstrapRepo.db) {
    throw new Error("createApp：bootstrapRepo 必须共享同一个数据库句柄");
  }
  if (deps.rigRepo.db !== deps.discoveryRepo.db) {
    throw new Error("createApp：discoveryRepo 必须共享同一个数据库句柄");
  }
  if (deps.rigRepo.db !== deps.claimService.db) {
    throw new Error("createApp：claimService 必须共享同一个数据库句柄");
  }
  if (deps.selfAttachService && deps.rigRepo.db !== deps.selfAttachService.db) {
    throw new Error("createApp：selfAttachService 必须共享同一个数据库句柄");
  }
  if (deps.rigRepo.db !== deps.psProjectionService.db) {
    throw new Error("createApp：psProjectionService 必须共享同一个数据库句柄");
  }
  if (deps.rigRepo.db !== deps.teardownOrchestrator.db) {
    throw new Error("createApp：teardownOrchestrator 必须共享同一个数据库句柄");
  }
  if (deps.rigRepo.db !== deps.podInstantiator.db) {
    throw new Error("createApp：podInstantiator 必须共享同一个数据库句柄");
  }

  const app = new Hono();
  const permissionDriftObserver = deps.permissionDriftObserver
    ?? new PermissionDriftObserver({ db: deps.rigRepo.db });

  // 为所有路由把依赖注入 context
  app.use("*", async (c, next) => {
    c.set("rigRepo" as never, deps.rigRepo);
    c.set("sessionRegistry" as never, deps.sessionRegistry);
    c.set("eventBus" as never, deps.eventBus);
    c.set("nodeLauncher" as never, deps.nodeLauncher);
    c.set("startupOrchestrator" as never, deps.startupOrchestrator);
    c.set("tmuxAdapter" as never, deps.tmuxAdapter);
    c.set("tmuxOptionDefaults" as never, deps.tmuxOptionDefaults);
    c.set("sessionEnv" as never, deps.sessionEnv);
    c.set("cmuxAdapter" as never, deps.cmuxAdapter);
    // S10——daemon 内 gateway 子系统句柄（health 表面 + dispatch seam）。
    c.set("gatewaySubsystem" as never, deps.gatewaySubsystem);
    // Slice 24——per-rig CMUX workspace launcher 接线。
    c.set(
      "cmuxLayoutService" as never,
      new CmuxLayoutService(deps.cmuxAdapter),
    );
    c.set(
      "nodeInventoryFn" as never,
      (rigId: string) => getNodeInventory(deps.rigRepo.db, rigId),
    );
    c.set("snapshotCapture" as never, deps.snapshotCapture);
    c.set("snapshotRepo" as never, deps.snapshotRepo);
    c.set("providerService" as never, deps.providerService);
    c.set("restoreOrchestrator" as never, deps.restoreOrchestrator);
    c.set("resumeMetadataRefresher" as never, deps.resumeMetadataRefresher);
    c.set("rigSpecExporter" as never, deps.rigSpecExporter);
    c.set("rigSpecPreflight" as never, deps.rigSpecPreflight);
    c.set("rigInstantiator" as never, deps.rigInstantiator);
    c.set("packageRepo" as never, deps.packageRepo);
    c.set("installRepo" as never, deps.installRepo);
    c.set("installEngine" as never, deps.installEngine);
    c.set("installVerifier" as never, deps.installVerifier);
    c.set("bootstrapOrchestrator" as never, deps.bootstrapOrchestrator);
    c.set("bootstrapRepo" as never, deps.bootstrapRepo);
    c.set("discoveryCoordinator" as never, deps.discoveryCoordinator);
    c.set("discoveryRepo" as never, deps.discoveryRepo);
    c.set("claimService" as never, deps.claimService);
    c.set("selfAttachService" as never, deps.selfAttachService);
    c.set("rigExpansionService" as never, deps.rigExpansionService);
    c.set("rigLifecycleService" as never, deps.rigLifecycleService);
    c.set("psProjectionService" as never, deps.psProjectionService);
    c.set("upRouter" as never, deps.upRouter);
    c.set("teardownOrchestrator" as never, deps.teardownOrchestrator);
    c.set("podInstantiator" as never, deps.podInstantiator);
    c.set("podBundleSourceResolver" as never, deps.podBundleSourceResolver);
    c.set("runtimeAdapters" as never, deps.runtimeAdapters ?? {});
    c.set("transcriptStore" as never, deps.transcriptStore);
    c.set("sessionTransport" as never, deps.sessionTransport);
    c.set("askService" as never, deps.askService);
    c.set("wakeResolveService" as never, deps.wakeResolveService);
    c.set("chatRepo" as never, deps.chatRepo);
    c.set("streamStore" as never, deps.streamStore);
    c.set("queueRepo" as never, deps.queueRepo);
    c.set("inboxHandler" as never, deps.inboxHandler);
    c.set("outboxHandler" as never, deps.outboxHandler);
    c.set("shadowCapture" as never, deps.shadowCapture);
    c.set("shadowCaptureError" as never, deps.shadowCaptureError);
    c.set("projectClassifier" as never, deps.projectClassifier);
    c.set("classifierLeaseManager" as never, deps.classifierLeaseManager);
    c.set("classificationAttemptLedger" as never, deps.classificationAttemptLedger);
    c.set("viewProjector" as never, deps.viewProjector);
    c.set("watchdogJobsRepo" as never, deps.watchdogJobsRepo);
    c.set("watchdogHistoryLog" as never, deps.watchdogHistoryLog);
    c.set("watchdogPolicyEngine" as never, deps.watchdogPolicyEngine);
    c.set("watchdogScheduler" as never, deps.watchdogScheduler);
    c.set("workflowRuntime" as never, deps.workflowRuntime);
    c.set("workflowBuiltinSpecsDir" as never, deps.workflowBuiltinSpecsDir);
    c.set("workflowsFolderDir" as never, deps.workflowsFolderDir);
    c.set("workflowSpecCache" as never, deps.workflowSpecCache);
    c.set("missionControlReadLayer" as never, deps.missionControlReadLayer);
    c.set("missionControlWriteContract" as never, deps.missionControlWriteContract);
    c.set("missionControlActionLog" as never, deps.missionControlActionLog);
    c.set("missionControlFleetCliCapability" as never, deps.missionControlFleetCliCapability);
    c.set("sliceIndexer" as never, deps.sliceIndexer);
    c.set("proofSourceWatch" as never, deps.proofSourceWatch);
    c.set("sliceDetailProjector" as never, deps.sliceDetailProjector);
    c.set("reviewGatherer" as never, deps.reviewGatherer);
    c.set("terminalService" as never, deps.terminalService);
    c.set("filesAllowlist" as never, deps.filesAllowlist);
    c.set("settingsStore" as never, deps.settingsStore);
    c.set("previewRateLimiter" as never, deps.previewRateLimiter);
    c.set("fileWriteService" as never, deps.fileWriteService);
    c.set("progressIndexer" as never, deps.progressIndexer);
    c.set("steeringComposer" as never, deps.steeringComposer);
    c.set("missionControlAuditBrowse" as never, deps.missionControlAuditBrowse);
    c.set("missionControlNotificationDispatcher" as never, deps.missionControlNotificationDispatcher);
    c.set("specReviewService" as never, deps.specReviewService);
    c.set("specLibraryService" as never, deps.specLibraryService);
    c.set("pluginDiscoveryService" as never, deps.pluginDiscoveryService);
    c.set("skillLibraryDiscoveryService" as never, deps.skillLibraryDiscoveryService);
    c.set("activeLensStore" as never, deps.activeLensStore);
    c.set("contextPackLibrary" as never, deps.contextPackLibrary);
    c.set("agentImageLibrary" as never, deps.agentImageLibrary);
    c.set("snapshotCapturer" as never, deps.snapshotCapturer);
    c.set("whoamiService" as never, deps.whoamiService);
    c.set("permissionDriftObserver" as never, permissionDriftObserver);
    c.set("contextUsageStore" as never, deps.contextUsageStore);
    c.set("healthProjection" as never, deps.healthProjection);
    c.set("healthDiagnosis" as never, deps.healthDiagnosis);
    c.set("healthPolicy" as never, deps.healthPolicy);
    c.set("healthCheckpoints" as never, deps.healthCheckpoints);
    c.set("contextMonitor" as never, deps.contextMonitor);
    c.set("compactionEnforcer" as never, deps.compactionEnforcer);
    c.set("occupantInvalidator" as never, deps.occupantInvalidator);
    c.set("nodeCmuxService" as never, deps.nodeCmuxService);
    c.set("agentActivityStore" as never, deps.agentActivityStore);
    c.set("seatAttentionReconciler" as never, deps.seatAttentionReconciler);
    // Slice 15——把 seatActivityService 接进 request context，使 /api/rigs/:id/nodes
    // 路由能经 attachTerminalActivityAndWork 用 terminalActive + hasAssignedWork 增强条目。
    c.set("seatActivityService" as never, deps.seatActivityService);
    c.set("seatStructuralActivityService" as never, deps.seatStructuralActivityService);
    c.set("activityHookToken" as never, deps.activityHookToken);
    c.set("serviceOrchestrator" as never, deps.serviceOrchestrator);
    c.set("composeAdapter" as never, deps.composeAdapter);
    c.set("kernelBootTracker" as never, deps.kernelBootTracker);
    c.set("rigModeStore" as never, deps.rigModeStore);
    c.set("operatingPosture" as never, deps.operatingPosture);
    c.set("db" as never, deps.rigRepo.db);
    c.set("terminalBearerToken" as never, deps.terminalBearerToken ?? null);
    await next();
  });

  // OPR.0.4.3.21——一个 request-duration middleware，用于昂贵拓扑路由（rigs summary/graph、
  // nodes、ps）。仅在接了 recorder 时注册（生产）；内部 expensiveRouteLabel 门使它对其他
  // 路径 no-op，便宜路由零代价。
  if (deps.routeTimingRecorder) {
    app.use("*", createRouteTimingMiddleware(deps.routeTimingRecorder));
  }

  // request-timing 观察者，经导出 seam（createSlowOpRequestMiddleware）接线，使 middleware
  // 契约可被 hermetic 单测，而这一行是钉死的 enable 路径。仅在接了 recorder 时注册（生产）；
  // 仅测量 + 隔离（throw 永不变成 500）。
  if (deps.slowOpRecorder?.recordRequest) {
    app.use("*", createSlowOpRequestMiddleware(deps.slowOpRecorder));
  }

  // OPR.0.4.6.MH2 FR-2/FR-7——单主机 READ-THROUGH 边（mission-control remote-forward 的
  // read 孪生）。对 allowlisted GET 读消费 `?host=<id>` 信封；拒绝携带远程信封的非 GET /
  // 非 allowlisted 请求，返回结构化 MH-3-boundary 错误，绝不转发它们。缺/本地 host 参数
  // 原样落到既有 handler（FR-2 零回归负向）。
  app.use("/api/*", hostReadThrough());

  app.get("/healthz", (c) => {
    // OPR.0.4.3.21——接了 monitor 时用 event-loop wedge 证据富化 health 表面。monitor
    // 缺时保持精确 legacy body，使断言 `{ status: "ok" }` 的既有探针 / 测试不变。
    // OPR.0.4.4.11 FR-7——STAMPED build 额外携带 {semver, commit, dirty, builtAt}；
    // dev 运行不加任何东西（无 stamp 时 stampFields 是 {}——无编造身份，legacy body 保留）。
    const stamp = stampFields();
    // 51-09 increment 3（arch 裁决 2e1b737f；local always-suffix 渲染已被 2026-08-27
    // root invariant 取代）——暴露 daemon 经 boot 对账的 self-host id，使 CLI 边能检测
    // cross-host 目标、自解析 self-suffixed 回复提示，并在 FORWARDING 边界构造 origin
    // triple（单一身份源）。在 FR-7 stamp 先例上 ADDITIVE：boot 对账前 ABSENT
    // （getSelfHostId 为 null → {} → 无编造身份，legacy body 字节保留）。绝不
    // ownName/host.name（仅显示，DP4——本 slice 消除的混淆）。
    const self = getSelfHostId();
    // Slice 14 §2c——在跨机器失败之前先可读。运行生成 id 的主机与运行其注册名的主机处于
    // 实质不同的状态（远程调用方无法解析它），而直到现在没有任何东西在消息失败之前告诉你
    // 处于哪个状态。
    const selfHost = self
      ? {
          selfHostId: self,
          selfHostIdSource: getSelfHostIdSource(),
        }
      : {};
    const monitor = deps.eventLoopMonitor;
    const slowOperations = deps.slowOpRecorder?.snapshot
      ? { slowOperations: deps.slowOpRecorder.snapshot() }
      : {};
    // S20——health 表面上的 bind 来源（ADDITIVE；缺 = legacy body）：adoption 门从此派生
    // REQUIRED listener 集，然后经探测证明每个主机——绑定证据，绝不 config 回显。
    const bind = deps.bindPlan ? { bind: deps.bindPlan } : {};
    // S02——安静便宜但可观测：常驻 stuck sweep 的 heartbeat 骑在 healthz 上（ADDITIVE；
    // 缺 = legacy body），使干净 sweep 无需行而失败 sweep 没有行也响亮。
    const stuckSweep = deps.stuckSweepStatus ? { stuckSweep: deps.stuckSweepStatus.snapshot() } : {};
    // S01——wake ladder 的 heartbeat 是 operator rung 诚实交付下限的一半（escalation 视图
    // + daemon-health）；同 additive 契约。
    const wakeLadder = deps.wakeLadderStatus ? { wakeLadder: deps.wakeLadderStatus.snapshot() } : {};
    if (!monitor) {
      return c.json({ status: "ok", pid: process.pid, ...stamp, ...selfHost, ...slowOperations, ...bind, ...stuckSweep, ...wakeLadder });
    }
    const eventLoop = monitor.snapshot();
    return c.json({
      status: "ok",
      pid: process.pid,
      ...stamp,
      ...selfHost,
      eventLoop,
      routeTimings: deps.routeTimingRecorder?.snapshot() ?? {},
      ...slowOperations,
      ...bind,
      ...stuckSweep,
      ...wakeLadder,
    });
  });

  app.route("/api/rigs", rigsRoutes);
  app.route("/api/rigs/:rigId/sessions", sessionsRoutes);
  // Slice 24——逐工作组 CMUX 工作区启动器。
  app.route("/api/rigs/:rigId/cmux", rigCmuxRoutes);
  app.route("/api/rigs/:rigId/nodes", nodesRoutes);
  app.route("/api/sessions", sessionAdminRoutes);
  app.route("/api/adapters", adaptersRoutes);
  app.route("/api/events", eventsRoute);
  app.route("/api/rigs/:rigId/snapshots", snapshotsRoutes);
  app.route("/api/rigs/:rigId/restore", restoreRoutes);
  app.route("/api/crash-cart", crashCartRoutes);
  app.route("/api/rigs/import", rigspecImportRoutes);
  app.get("/api/rigs/:rigId/spec", handleExportYaml);
  app.get("/api/rigs/:rigId/spec.json", handleExportJson);
  app.route("/api/packages", packagesRoutes);
  app.route("/api/agents", agentsRoutes);
  app.route("/api/bootstrap", bootstrapRoutes);
  app.route("/api/discovery", discoveryRoutes);
  app.route("/api/bundles", bundleRoutes);
  app.route("/api/ps", psRoutes);
  app.route("/api/up", upRoutes);
  app.route("/api/info", infoRoutes());
  app.route("/api/down", downRoutes);
  app.route("/api/kernel", kernelStatusRoutes);
  app.route("/api/startup", startupRoutes);
  app.route("/api/transcripts", transcriptRoutes());
  app.route("/api/transport", transportRoutes({ bearerToken: deps.terminalBearerToken ?? null }));
  // OPR.0.4.3.14——手动 compaction 触发（与 transport 同 terminal-bearer 姿态，因为它
  // 驱动向目标席位的发送）。
  app.route("/api/compaction", compactionRoutes({ bearerToken: deps.terminalBearerToken ?? null }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let injectWebSocket: (server: any) => void = () => {};
  if (deps.enableNodeWebSocket) {
    const ws = createNodeWebSocket({ app });
    injectWebSocket = ws.injectWebSocket as never;
    _lastInjectWebSocket = injectWebSocket;
    registerTerminalWs(app, ws.upgradeWebSocket as never, { bearerToken: deps.terminalBearerToken ?? null });
  }
  app.route("/api/activity", activityRoutes);
  app.route("/api/ask", askRoutes);
  app.route("/api/wake-resolve", wakeResolveRoutes);
  app.route("/api/specs/review", specReviewRoutes());
  app.route("/api/specs/library", specLibraryRoutes());
  app.route("/api/plugins", pluginsRoutes());
  // Slice 28 C-3——skill-library + per-skill 文件端点（SC-29 #11）。
  app.route("/api/skills", skillsRoutes());
  app.route("/api/config", configRoutes());
  app.route("/api/context-packs", contextPacksRoutes());
  app.route("/api/agent-images", agentImagesRoutes({
    specRoots: deps.agentImageSpecRoots ?? (() => []),
  }));
  app.route("/api/whoami", whoamiRoutes());
  // Slice-04 OPR.0.5.0.4：注册使端点存在并诚实返回 503；providerService 在 collection/service
  // seam（C）接线前不进 context（在那之前 -> 503）。
  app.route("/api/provider", providerRoutes());
  app.route("/api/seat", seatRoutes);
  app.route("/api/rigs/:rigId/chat", chatRoutes());
  app.route("/api/stream", streamRoutes());
  app.route("/api/queue", queueRoutes());
  app.route("/api/workspace", workspaceRoutes());
  app.route("/api/projects", projectsRoutes());
  app.route("/api/views", viewsRoutes());
  app.route("/api/watchdog", watchdogRoutes());
  app.route("/api/workflow", workflowRoutes());
  app.route(
    "/api/mission-control",
    missionControlRoutes({ bearerToken: deps.missionControlBearerToken ?? null }),
  );
  // OPR.0.4.6.MH1 FR-5/FR-6——狭窄的命名主机 add/pair 路由族（arch P1：仅 add + pair
  // 握手）。写 seam 与 mission-control 同 operator-bearer 姿态；pair-request 签发腿刻意
  // 开放（pre-token bootstrap）。
  app.route(
    "/api/hosts",
    hostsRoutes({ bearerToken: deps.missionControlBearerToken ?? null }),
  );
  // Slice Story View v0——slice indexer + per-tab payload 路由。
  app.route("/api/slices", slicesRoutes());
  // Living Notes Packet 2（OPR.0.4.4.20）——composed-review 读契约。
  app.route("/api/review", reviewRoutes());
  // OPR.0.4.6.02 C3——规范的非工作组范围 terminal composer + 工作组范围薄别名（组合
  // view=rig:<rigId>，委托给同一 TerminalService；arch R1 / guard b1）。
  app.route("/api/terminal", terminalRoutes());
  app.route("/api/rigs/:rigId/terminal", rigTerminalRoutes);
  // V0.3.1 slice 12 walk-item 1——mission scope 数据层（聚合 mission 元数据 + slices
  // 过滤；与 useScopeMarkdown 配对，经 /api/files/read 取 README / PROGRESS 内容）。
  app.route("/api/missions", missionsRoutes());
  // UI Enhancement Pack v0——files（item 3 + item 4）+ progress（item 1B）路由。
  app.route("/api/files", filesRoutes());
  app.route("/api/progress", progressRoutes());
  app.route("/api/scope/audit", scopeAuditRoutes());
  // SCOPES VIEW（d64d2f5c）：store 直读 TUI。
  app.route("/api/scopes", scopesRoutes());
  // 51-08 A3——usage_samples 上的 usage series + top-N burn（一个 projection，CLI+HTTP）。
  app.route("/api/telemetry", telemetryRoutes({ db: () => deps.rigRepo.db }));
  // OPR.0.4.4.19 FR-9——scope approve：frontmatter 盖印 + 审计行。
  app.route("/api/scope/approve", scopeApproveRoutes());
  app.route("/api/proof", proofRoutes());
  // Operator Surface Reconciliation v0——steering 组合 + health summary。
  app.route("/api/steering", steeringRoutes());
  app.route("/api/health-summary", healthSummaryRoutes());
  app.route("/api/health", healthRoutes());
  app.route("/api/attention", attentionRoutes());
  app.route("/api/health-diagnosis", healthDiagnosisRoutes());
  // S10——gateway 子系统 admin（slack enable/disable，保留 seeding 规则）。
  app.route("/api/gateway", gatewayRoutes());
  app.route("/api/rigs/:rigId/env", envRoutes());
  app.route("/api/restore-check", restoreCheckRoutes);
  // Slice 09（OPR.0.3.2.9）——rig-policy 绑定（operator context mode）。与
  // mission-control 同 operator-bearer 姿态；HG-SAFE 保留。
  app.route(
    "/api/rig-mode",
    rigModeRoutes({ bearerToken: deps.missionControlBearerToken ?? null }),
  );

  app.all("/api/*", async (c, next) => {
    if (c.req.path === "/api") return next();
    return c.json({ error: "not_found", path: c.req.path }, 404);
  });

  const uiDistDir = deps.uiDistDir ?? resolveDefaultUiDistDir();
  const uiIndexPath = nodePath.join(uiDistDir, "index.html");
  const hasUiBundle = !!uiDistDir && fs.existsSync(uiIndexPath);

  app.get("*", (c) => {
    const requestPath = c.req.path;

    if (requestPath === "/healthz" || requestPath.startsWith("/api/")) {
      return c.notFound();
    }

    if (!hasUiBundle) {
      return c.notFound();
    }

    const requestedFile = safeResolveUiPath(uiDistDir, requestPath);
    if (requestedFile && fs.existsSync(requestedFile) && fs.statSync(requestedFile).isFile()) {
      return fileResponse(requestedFile);
    }

    if (isUiAssetRequestPath(requestPath)) {
      return c.notFound();
    }

    const indexHtml = fs.readFileSync(uiIndexPath, "utf-8");
    const tokenScript = deps.terminalBearerToken
      ? `<script>if(!window.localStorage.getItem("openrig.terminalBearerToken"))window.localStorage.setItem("openrig.terminalBearerToken",${JSON.stringify(deps.terminalBearerToken)})</script>`
      : "";
    const injected = tokenScript ? indexHtml.replace("</head>", `${tokenScript}</head>`) : indexHtml;
    return c.html(injected);
  });

  return app;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _lastInjectWebSocket: ((server: any) => void) | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAppWithWebSocket(deps: AppDeps): { app: Hono; injectWebSocket: (server: any) => void } {
  deps.enableNodeWebSocket = true;
  _lastInjectWebSocket = null;
  const app = createApp(deps);
  return { app, injectWebSocket: _lastInjectWebSocket ?? (() => {}) };
}
