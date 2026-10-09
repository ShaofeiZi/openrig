import { configureShadowCapture } from "./domain/shadow-capture.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "./domain/seat-delivery-guard.js";
import { queueRecoveryOwnsWake } from "./domain/queue-wake-ladder.js";
import { HealthPolicyStore } from "./domain/health-policy.js";
import { HealthCheckpointSource } from "./domain/health-checkpoints.js";
import { PassiveCeremonySource } from "./domain/health-passive-ceremony.js";
import { HealthDiagnosisService } from "./domain/health-diagnosis.js";
import { readHealthArtifact, healthAuthority, healthHumanReadiness } from "./domain/health-context.js";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import type { ExecFn } from "./adapters/tmux.js";
import type { CmuxTransportFactory } from "./adapters/cmux.js";
import { createDb } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
// P8：应用规范迁移列表——唯一事实源是 db/all-migrations.ts，
// 绝不内联复制，以免与后台服务 schema 发生漂移。
import { ALL_MIGRATIONS } from "./db/all-migrations.js";
import { RigRepository } from "./domain/rig-repository.js";
import { SessionRegistry } from "./domain/session-registry.js";
import { isHumanSeatSessionRef, parseSessionName } from "./domain/session-name.js";
import { resolveExternal } from "./domain/gateway/external-admission.js";
import { loadHumanRegistry } from "./domain/gateway/human-registry.js";
import { EventBus } from "./domain/event-bus.js";
import { NodeLauncher } from "./domain/node-launcher.js";
import { TmuxOptionDefaultsApplier } from "./domain/tmux-option-defaults.js";
import { TmuxAdapter } from "./adapters/tmux.js";
import { CmuxAdapter } from "./adapters/cmux.js";
import { execCommand } from "./adapters/tmux-exec.js";
import { createCmuxCliTransport } from "./adapters/cmux-transport.js";
import { SnapshotRepository } from "./domain/snapshot-repository.js";
import { CheckpointStore } from "./domain/checkpoint-store.js";
import { SnapshotCapture } from "./domain/snapshot-capture.js";
import { RestoreOrchestrator } from "./domain/restore-orchestrator.js";
import { ClaudeManagedLaunch } from "./domain/claude-managed-launch.js";
import { ClaudeResumeAdapter } from "./adapters/claude-resume.js";
import { CodexResumeAdapter } from "./adapters/codex-resume.js";
import { codexDaemonSupportProbe } from "./domain/codex-daemon-support.js";
import { PiResumeAdapter } from "./adapters/pi-resume.js";
import { RigSpecExporter } from "./domain/rigspec-exporter.js";
import { PodRepository } from "./domain/pod-repository.js";
import { RigSpecPreflight } from "./domain/rigspec-preflight.js";
import { RigInstantiator } from "./domain/rigspec-instantiator.js";
import { Reconciler } from "./domain/reconciler.js";
import { PackageRepository } from "./domain/package-repository.js";
import { InstallRepository } from "./domain/install-repository.js";
import { InstallEngine } from "./domain/install-engine.js";
import { InstallVerifier } from "./domain/install-verifier.js";
import { BootstrapRepository } from "./domain/bootstrap-repository.js";
import { RuntimeVerifier } from "./domain/runtime-verifier.js";
import { RequirementsProbeRegistry } from "./domain/requirements-probe.js";
import { ExternalInstallPlanner } from "./domain/external-install-planner.js";
import { ExternalInstallExecutor } from "./domain/external-install-executor.js";
import { PackageInstallService } from "./domain/package-install-service.js";
import { BootstrapOrchestrator } from "./domain/bootstrap-orchestrator.js";
import { TmuxDiscoveryScanner } from "./domain/tmux-discovery-scanner.js";
import { SessionFingerprinter } from "./domain/session-fingerprinter.js";
import { SessionEnricher } from "./domain/session-enricher.js";
import { DiscoveryRepository } from "./domain/discovery-repository.js";
import { DiscoveryCoordinator } from "./domain/discovery-coordinator.js";
import { ClaimService } from "./domain/claim-service.js";
import { SelfAttachService } from "./domain/self-attach-service.js";
import { RigLifecycleService } from "./domain/rig-lifecycle-service.js";
import { RigExpansionService } from "./domain/rig-expansion-service.js";
// TODO：AS-T12——迁移到感知席位组的 bundle 来源解析器。
import { LegacyBundleSourceResolver as BundleSourceResolver } from "./domain/bundle-source-resolver.js";
import { PodBundleSourceResolver } from "./domain/bundle-source-resolver.js";
import { PsProjectionService } from "./domain/ps-projection.js";
import { SeatActivityService } from "./domain/seat-activity-service.js";
import { readClaudeSelfReportEvidence } from "./adapters/claude-code-adapter.js";
import { SeatStructuralActivityService } from "./domain/seat-structural-activity-service.js";
import { deriveSelfHostIdSource, SeatIdentityReconciler, reconcileSelfHostIdentity } from "./domain/seat-identity-reconciler.js";
import { SeatIdentityStore, SelfHostIdentityStore } from "./domain/seat-identity-store.js";
import { DaemonLifecycleStore } from "./domain/daemon-lifecycle-store.js";
import { randomUUID } from "node:crypto";
import { setSelfHostId, setSelfHostIdSource } from "./domain/hosts/fanout-contract.js";
import { UpCommandRouter } from "./domain/up-command-router.js";
import { RigTeardownOrchestrator } from "./domain/rig-teardown.js";
import { ResumeMetadataRefresher } from "./domain/resume-metadata-refresher.js";
import { TranscriptStore } from "./domain/transcript-store.js";
import { resumeRunningTranscriptCaptures } from "./domain/transcript-capture.js";
import { SessionTransport } from "./domain/session-transport.js";
import { AgentActivityStore } from "./domain/agent-activity-store.js";
import { HistoryQuery } from "./domain/history-query.js";
import { AskService } from "./domain/ask-service.js";
import { WakeResolveService } from "./domain/wake-resolve-service.js";
import type { WakeSessionRow } from "./domain/wake-resolver.js";
import { ChatRepository } from "./domain/chat-repository.js";
import { StreamStore } from "./domain/stream-store.js";
import { SlowOpRecorder, type SlowOperationInstrumentation } from "./domain/slow-op-recorder.js";
import { configureSyncSiteRecorder } from "./domain/sync-site-wrap.js";
import { QueueRepository, isBlockerLive } from "./domain/queue-repository.js";
import { createWorkflowFrontierPredicate } from "./domain/workflow-frontier-guard.js";
import { InboxHandler } from "./domain/inbox-handler.js";
import { OutboxHandler } from "./domain/outbox-handler.js";
import { ProjectClassifier } from "./domain/project-classifier.js";
import { ClassifierLeaseManager } from "./domain/classifier-lease-manager.js";
import { ClassificationAttemptLedger } from "./domain/classification-attempts.js";
import { ViewProjector } from "./domain/view-projector.js";
import { wireViewEventBridge } from "./domain/view-event-bridge.js";
import { WatchdogJobsRepository } from "./domain/watchdog-jobs-repository.js";
import { WatchdogAutoRegistration } from "./domain/watchdog-auto-registration.js";
import { WatchdogHistoryLog } from "./domain/watchdog-history-log.js";
import {
  formatWatchdogDeliveryMessage,
  WatchdogPolicyEngine,
} from "./domain/watchdog-policy-engine.js";
import { WatchdogScheduler } from "./domain/watchdog-scheduler.js";
import {
  ContinuityPolicyMaterializer,
  createContinuityCutoverBaton,
  findClaudeTranscriptByToken,
  recordManagedWidthReceipt,
} from "./domain/continuity-policy-materializer.js";
import { WorkflowRuntime } from "./domain/workflow-runtime.js";
import { resolveWorkflowHumanDestination } from "./domain/workflow-human-destination.js";
import { makeWorkflowKeepalivePolicy } from "./domain/policies/workflow-keepalive.js";
import { makeIdleGateQitemPolicy } from "./domain/policies/idle-gate-qitem.js";
import { makeParkedOwnerConsumerPolicy, makeRigAnchor, PARKED_OWNER_POLICY_NAME } from "./domain/policies/parked-owner-consumer.js";
import { diagnoseRigParked } from "./domain/parked-query.js";
import { SpecReviewService } from "./domain/spec-review-service.js";
import { SpecLibraryService } from "./domain/spec-library-service.js";
// 阶段 3a slice 3.3——插件发现服务。
import { PluginDiscoveryService } from "./domain/plugin-discovery-service.js";
// Slice 28 检查点 C-3——技能库发现（累计覆盖 SC-29 #11）。
import { SkillLibraryDiscoveryService } from "./domain/skill-library-discovery.js";
import { ContextPackLibraryService } from "./domain/context-packs/context-pack-library-service.js";
import { openRigContextLibraryRoots } from "./domain/instance-initialization.js";
import { resolveSystemWorld } from "./domain/system-world.js";
import { AgentImageLibraryService } from "./domain/agent-images/agent-image-library-service.js";
import { SnapshotCapturer } from "./domain/agent-images/snapshot-capturer.js";
import { SettingsStore as ContextPackSettingsStore } from "./domain/user-settings/settings-store.js";
import { WhoamiService } from "./domain/whoami-service.js";
import { NodeCmuxService } from "./domain/node-cmux-service.js";
import { createAppWithWebSocket, type AppDeps } from "./server.js";
import { ProviderServiceImpl } from "./domain/provider/provider-service-impl.js";
import { collectClaudeSignalsFromProviderUsageDirectory } from "./domain/provider/claude-usage-reader.js";
import { legacyProviderUsageDirectory, providerUsageDirectory } from "./domain/telemetry-state-paths.js";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
// Slice 11（release-0.3.1 workflow-spec-folder-discovery）——向 workflow_specs 添加
// status 与 error_message 列，使扫描器能够记录诊断行。SC-29 #10 在提交正文中逐字声明。
import { RigModeStore } from "./domain/rig-mode/rig-mode-store.js";
import { OperatingPostureService } from "./domain/rig-mode/operating-posture.js";
import { MissionControlActionLog } from "./domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "./domain/mission-control/mission-control-write-contract.js";
import { MissionControlReadLayer } from "./domain/mission-control/mission-control-read-layer.js";
import {
  MissionControlFleetCliCapability,
  makeLocalCliCapabilityProbe,
} from "./domain/mission-control/mission-control-fleet-cli-capability.js";
import { MissionControlAuditBrowse } from "./domain/mission-control/audit-browse.js";
import { MissionControlNotificationDispatcher } from "./domain/mission-control/notification-dispatcher.js";
import { NtfyNotificationAdapter } from "./domain/mission-control/notification-adapter-ntfy.js";
import { WebhookNotificationAdapter } from "./domain/mission-control/notification-adapter-webhook.js";
import type { NotificationAdapter } from "./domain/mission-control/notification-adapter-types.js";
import { OPENRIG_HOME } from "./openrig-compat.js";
import { materializeBuiltinPolicyReference } from "./domain/builtin-policy-reference.js";
import { ensureActivityHookToken, writeActivityEndpointFile, deriveActivityUrl, readActivityEndpointFile } from "./domain/activity-endpoint.js";
import {
  getCompatibleOpenRigPath,
  getDefaultOpenRigPath,
  readOpenRigEnv,
} from "./openrig-compat.js";

interface DaemonOptions {
  dbPath?: string;
  /** S20——有效绑定计划（mode/hosts/tailscaleDetected/ignoredRoutingHost），
   *  在 index.ts 中只计算一次，并通过 /healthz 暴露，使采用门禁能凭绑定证据验证监听器。
   *  缺失（测试/旧版）时 healthz 正文保持不变。 */
  bindPlan?: import("./domain/bind-plan.js").BindPlan;
  tmuxExec?: ExecFn;
  cmuxExec?: ExecFn;
  cmuxFactory?: CmuxTransportFactory;
  cmuxTimeoutMs?: number;
  tmuxOptionPlatform?: NodeJS.Platform;
  slowOpRecorder?: SlowOperationInstrumentation;
  /**
   * PL-005 阶段 B：任务控制写入动词的 bearer token。
   * 为 null 时，auth-bearer-token 中间件放行（index.ts 启动侧检查确保
   * 只有绑定到回环地址时才允许这样做）。设置后，中间件执行常量时间比较，
   * 缺失或不匹配时返回 401。
   */
  bearerToken?: string | null;
  /**
   * 实时终端路由的 bearer token。null 表示后台服务绑定姿态已受信任
   *（回环地址/tailnet），与任务控制鉴权边界一致。非 null 时，对终端
   * 预览、传输和 WebSocket 路由强制执行 bearer 鉴权。
   */
  terminalBearerToken?: string | null;
}

interface DaemonResult {
  app: Hono;
  db: Database.Database;
  deps: AppDeps;
  contextMonitor: import("./domain/context-monitor.js").ContextMonitor;
  // OPR.0.4.3.21——返回该对象，使 index.ts 可在优雅关闭时调用 stop()。
  eventLoopMonitor: import("./domain/event-loop-monitor.js").EventLoopMonitor;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  injectWebSocket: (server: any) => void;
}

const KNOWN_PROVIDER_AUTH_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT_ID",
  // OPR.0.4.6.PI1 FR-7——Pi 席位提供商。若不加入 KNOWN 集合，由后台服务启动的
  // Pi 席位就无法获得提供商密钥（pi-runner 默认拒绝的白名单将没有内容可传递）。
  // 仍保留双重选择加入：操作员必须在 recovery.provider_auth_env_allowlist 中明确列出
  // 每个变量。OpenRouter 是创建者在 2026-07-06 裁定的首选路径，zai/kimi-coding
  // 是次级原生路径。
  "OPENROUTER_API_KEY",
  "ZAI_API_KEY",
  "KIMI_API_KEY",
]);

export function collectAllowlistedProviderAuthEnv(
  raw: string | null | undefined,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of (raw ?? "").split(",")) {
    const name = item.trim();
    if (!name) continue;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;
    if (!KNOWN_PROVIDER_AUTH_ENV.has(name)) continue;
    const value = env[name];
    if (typeof value === "string" && value.length > 0) {
      out[name] = value;
    }
  }
  return out;
}

export async function createDaemon(opts?: DaemonOptions): Promise<DaemonResult> {
  const daemonHome = os.homedir();
  const configuredCodexHome = process.env.CODEX_HOME;
  if (configuredCodexHome && !nodePath.isAbsolute(configuredCodexHome)) {
    throw new Error(`托管席位的 CODEX_HOME 必须是绝对路径：${configuredCodexHome}`);
  }
  const codexHome = configuredCodexHome || nodePath.join(daemonHome, ".codex");
  const dbPath = opts?.dbPath ?? ":memory:";
  const db = createDb(dbPath);
  migrate(db, ALL_MIGRATIONS);

  // 51-09 增量 1——启动时建立后台服务持久化的本机身份（首次启动创建，之后协调）。
  // host.name 只是用于显示的候选种子（架构裁决 cb19867f / DP4）。host.name 冲突时
  // 仍继续启动（保留已存储 id，并明确暴露冲突）。
  const hostNameCandidate = new ContextPackSettingsStore().resolveOne("host.name").value as string;
  const selfHost = reconcileSelfHostIdentity(new SelfHostIdentityStore(db), {
    nowIso: new Date().toISOString(),
    hostNameCandidate,
  });
  // 51-09 增量 2——发布解析后的本机 id，使透传读取（以及增量 4 的队列目标校验器）
  // 能在本机 id 对应的 HOME 中解析请求，而不是将其作为远程/未知主机拨号或校验。
  // 其拼写与 `local` 哨兵值不同。
  setSelfHostId(selfHost.hostId);
  // Slice 14 §2c——从协调过程刚使用的同一候选值派生，因此两者不会分歧；
  // 在此处一次性计算，而非逐请求计算（见 fanout-contract）。
  setSelfHostIdSource(deriveSelfHostIdSource(selfHost.hostId, hostNameCandidate));

  // P7——后台服务生命周期记录（不同于 059 身份记录）。新启动会创建新纪元、写入
  // started_at，并清除上次运行的 stopped_at/heartbeat。运行期间心跳（index.ts 绑定后）
  // 推进 last-seen；干净关闭时（index.ts 停止计时器之后）为本纪元写入 stopped_at。
  const daemonLifecycleStore = new DaemonLifecycleStore(db);
  const daemonBootEpoch = randomUUID();
  daemonLifecycleStore.recordBoot(daemonBootEpoch, new Date().toISOString());

  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const streamStore = new StreamStore(db, eventBus);
  // 仅显式选择加入来源；在单独的 drain 请求前不进行接收端 I/O。
  const shadow = configureShadowCapture(process.env.OPENRIG_SHADOW_CAPTURE);
  const slowOpRecorder = opts?.slowOpRecorder ?? (dbPath === ":memory:"
    ? undefined
    : new SlowOpRecorder({
        logPath: nodePath.join(OPENRIG_HOME, "logs", "slow-operations.jsonl"),
      }));
  configureSyncSiteRecorder(slowOpRecorder);
  // 监测接线仅用于观察：注册调用抛错或回调正文（streamStore.emit）抛错都不得中止
  // createDaemon 或后续包装工作，因此同时防护两个边界。
  try {
    slowOpRecorder?.setDegradedHandler?.(({ reason, site }) => {
      try {
        streamStore.emit({
          sourceSession: "daemon@kernel",
          body: `慢操作监测已降级：${site}，原因：${reason}`,
          hintType: "observation",
          hintUrgency: "high",
          hintTags: ["daemon", "slow-operation", "observability-degraded"],
        });
      } catch (error) {
        console.error("[slow-operation] 降级通知失败", error);
      }
    });
  } catch (error) {
    console.error("[slow-operation] setDegradedHandler 注册失败", error);
  }
  // PL-004 阶段 A 修订（R1）：由拓扑支撑的 validateRig。通过工作组注册表检查
  // 工作组部分，拒绝 `<member>@<unknown-rig>` 形态；不含 `@` 的裸 id 也会被拒绝
  //（没有规范工作组绑定）。OPR.0.4.6.MH1 FR-8：此门禁是共享解析契约的典型消费者——
  // 先进行人类席位分类，再按首个 @ 贪婪解析工作组（所以 "member@rig@x" 会查找
  // "rig@x"，查找失败，并继续返回同一 unknown_destination_rig——BR-1）。
  const topologyValidateRig = (sessionRef: string): boolean => {
    const parsed = parseSessionName(sessionRef);
    // M1 A4b——@external 实体准入（在人类类别裸准入之前检查；A2 也会让
    // <local>@external 满足后者）：目标为 <local>@external 的队列行仅在人类已注册
    //（或它是字面 scheme 地址）时准入；未注册实体会被拒绝（4b 位置通过
    // externalAdmissionTeaching 提供实体级说明）。准入属于网关职责，绝非分类器职责
    //（架构 8cd30094）。
    if (parsed.kind === "external") {
      const reg = loadHumanRegistry();
      const entities = reg.ok ? reg.entities.map((e) => ({ entityId: e.entityId, address: e.address })) : [];
      return resolveExternal(parsed.local, entities).kind !== "unregistered";
    }
    if (isHumanSeatSessionRef(sessionRef)) return true;
    if (parsed.kind !== "canonical") return false;
    return rigRepo.findRigsByName(parsed.rig).length > 0;
  };
  // PL-004 阶段 A——共享协调服务。提前构造，使 queueRepo 依赖槽与 inboxHandler
  // 可以共享同一实例。下面实例化 SessionTransport 后再通过 attachTransport() 接入传输层。
  const queueRepoInstance = new QueueRepository(db, eventBus, {
    validateRig: topologyValidateRig,
    // OPR.0.4.6.WF3 FR-6——在此注入前沿关闭路径守卫的谓词（架构分层锚点：
    // 队列绝不导入工作流领域；由启动过程接线——沿用 validateRig 先例）。
    workflowFrontierPredicate: createWorkflowFrontierPredicate(db),
    // GHOST-STAGE (h)：为交接提醒的 Sent 行解析来源席位的 atom-B 代数
    //（同一注入谓词分层；队列绝不导入会话领域）。
    resolveOccupantGeneration: (sessionName) => sessionRegistry.currentOccupantGenerationForSession(sessionName),
  });
  // W1（事务闭合）：deps 槽（发送端审计面）与队列仓库的持久唤醒意图暂存共享唯一
  // OutboxHandler。两者使用同一个 `db`，因此终态 db.transaction 内的
  // stageWakeIntent() 会与关闭及后继创建原子提交。
  const outboxHandlerInstance = new OutboxHandler(db);
  queueRepoInstance.attachOutbox(outboxHandlerInstance);
  // PL-004 阶段 B——分类器租约管理器。提前构造，使 leaseManager 依赖槽与
  // project-classifier 共享同一实例；whoami-service 构造后再挂接 isAlive。
  const classifierLeaseManagerInstance = new ClassifierLeaseManager(db, eventBus);
  // PL-004 阶段 B——视图投影器。提前构造，使 viewProjector 依赖槽与
  // view-event-bridge 共享同一实例。
  const viewProjectorInstance = new ViewProjector(db, eventBus);
  // PL-004 阶段 B R1（关闭守卫 BLOCKER 2）：连接视图事件桥，使 queue/inbox/project
  // 变更为受影响的内置视图发出 view.changed。底层状态变更时，
  // /api/views/:name/sse 的 SSE 消费者会收到变更事件。
  wireViewEventBridge(eventBus, viewProjectorInstance);

  // PL-004 阶段 C——看守器监督树。仓库与历史日志提前构造；策略引擎和调度器则在
  // SessionTransport 可用后构造，以便引擎接入投递。
  const watchdogJobsRepoInstance = new WatchdogJobsRepository(
    db,
    undefined, // now（默认时钟）
    // GHOST-STAGE（e/Class-B）：记录武装时占位者的代数，使换代时可丢弃其已武装任务。
    (sessionName) => sessionRegistry.currentOccupantGenerationForSession(sessionName),
  );
  queueRepoInstance.attachWatchdogJobsRepository(watchdogJobsRepoInstance);
  const watchdogAutoRegistration = new WatchdogAutoRegistration({
    db,
    jobsRepo: watchdogJobsRepoInstance,
    settingsStore: new ContextPackSettingsStore(),
    warn: (message) => console.warn(message),
  });
  sessionRegistry.setWatchdogRegistrationObserver(watchdogAutoRegistration);
  // 现有会话早于结构化创建钩子。每次启动时审计它们但不创建任务：
  // 增量覆盖保持显式，核心启动保持可用。
  watchdogAutoRegistration.assertLiveSeatCoverage();
  const watchdogHistoryLogInstance = new WatchdogHistoryLog(db);

  const tmuxAdapter = new TmuxAdapter(opts?.tmuxExec ?? execCommand);
  const deliveryGuard = new SeatDeliveryGuard(db, target => resolveGuardTarget(db, target));
  deliveryGuard.recoverActivation();
  tmuxAdapter.deliveryGuard = deliveryGuard;

  // Slice 15——`terminal-active` 原语的席位活动服务。它位于模块作用域，
  // 使投影链（PsProjectionService、节点清单丰富）读取同一来源。默认静默窗口为
  // slice 15 README 规定的 3 秒。AgentSpec.profile.activity 中的逐席位
  // silenceWindowSeconds 当前尚未生效（轮询器使用全局默认值，尚未接入逐席位窗口）。
  const seatActivityService = new SeatActivityService({
    tmux: tmuxAdapter,
    defaultWindowSeconds: 3,
    eventBus,
    // S19——Claude 自报告梯级（pid.json）；每轮扫描时为清单中声明的席位读取。
    // 不可读时为 null，继续降级到下一梯级，而不抛错。
    selfReportReader: (sessionName, seatNodeId) => {
      const sessionsDir = nodePath.join(process.env.CLAUDE_CONFIG_DIR ?? nodePath.join(os.homedir(), ".claude"), "sessions");
      return readClaudeSelfReportEvidence({ sessionsDir, sessionName, seatNodeId });
    },
  });
  // 5b82324b——结构化活动缓存（SeatActivityService 的同级组件）。每个 tick 为每个运行中
  // 席位捕获一次窗格文本，并按结构分类活动，使 `rig ps` 的 ACTIVITY 列能反映无钩子、
  // 钩子过期或轮次边界席位的真实活性，又不会形成逐请求捕获风暴。
  const seatStructuralActivityService = new SeatStructuralActivityService(tmuxAdapter);
  // OPR.0.4.3.19——SeatIdentityReconciler 拥有活性身份裁决（第三轴）。它把每个
  // 运行中席位的窗格 PID/命令与已注册绑定协调，并持久化裁决，使节点清单可以门控
  // running/active 的绿色派生；由 index.ts 在绑定后启动。
  const seatIdentityReconciler = new SeatIdentityReconciler({
    db,
    tmux: tmuxAdapter,
  });
  // cmuxFactory（用于测试）优先，其次是基于 cmuxExec 的 CLI 传输，最后使用默认值。
  const cmuxFactory = opts?.cmuxFactory
    ?? createCmuxCliTransport(opts?.cmuxExec ?? execCommand);
  const cmuxAdapter = new CmuxAdapter(
    cmuxFactory,
    { timeoutMs: opts?.cmuxTimeoutMs ?? 5000 }
  );

  // 从环境读取转录配置（CLI 通过 PNS-T02 配置面传入）。
  const transcriptsEnabled = readOpenRigEnv("OPENRIG_TRANSCRIPTS_ENABLED", "RIGGED_TRANSCRIPTS_ENABLED") !== "false";
  const transcriptsPath = readOpenRigEnv("OPENRIG_TRANSCRIPTS_PATH", "RIGGED_TRANSCRIPTS_PATH") || undefined;
  const activityHookToken = readOpenRigEnv("OPENRIG_ACTIVITY_HOOK_TOKEN", "RIGGED_ACTIVITY_HOOK_TOKEN") || undefined;
  const activityHookUrl = readOpenRigEnv("OPENRIG_URL", "RIGGED_URL") || undefined;
  const openRigPort = readOpenRigEnv("OPENRIG_PORT", "RIGGED_PORT") || undefined;
  const openRigHost = readOpenRigEnv("OPENRIG_HOST", "RIGGED_HOST") || undefined;
  // OPR.0.4.3.28 B2——自动配置稳定的活动 URL 与 token，使启动后的席位无需操作员
  // 预先设置 shell 即可访问摄取端点（已确认的线上断点）。token 跨后台服务重启持久化，
  // 与已启动席位冻结的环境一致；URL 由后台服务的回环地址和端口派生（回退到 DEFAULT_PORT 7433）。
  // 同一个 token 同时作为摄取端预期值（见下方 server 依赖）和席位环境值，使钩子 POST 可鉴权。
  // 同时快照到 activity-endpoint.json，供协调/恢复席位使用文件发现的中继回退（B3）。
  const resolvedActivityHookToken = activityHookToken ?? ensureActivityHookToken(OPENRIG_HOME);
  // 从后台服务自身绑定的主机与端口派生（尊重显式 OPENRIG_HOST 单主机绑定；通配/缺失则回环），
  // 使席位向可达地址发送请求；硬编码 127.0.0.1 会破坏显式 tailnet/主机名绑定。
  const resolvedActivityHookUrl = activityHookUrl ?? deriveActivityUrl(openRigHost, openRigPort);
  writeActivityEndpointFile(OPENRIG_HOME, { baseUrl: resolvedActivityHookUrl, token: resolvedActivityHookToken });
  const startupSettings = new ContextPackSettingsStore().resolveConfig();
  const providerAuthEnv = collectAllowlistedProviderAuthEnv(
    startupSettings.recoveryProviderAuthEnvAllowlistRaw,
    process.env,
  );
  const transcriptStore = new TranscriptStore({
    enabled: transcriptsEnabled,
    transcriptsRoot: transcriptsPath,
  });

  // 共享启动身份/活动环境——NodeLauncher 启动时使用，席位交接全周期组合器创建后继会话时
  // 也使用（OPR.0.4.3.04），因此交接后的后继与正常启动席位一样自报身份和活动。
  const launchSessionEnv: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    OPENRIG_HOME,
    OPENRIG_PORT: openRigPort,
    OPENRIG_HOST: openRigHost,
    OPENRIG_URL: resolvedActivityHookUrl,
    OPENRIG_ACTIVITY_HOOK_TOKEN: resolvedActivityHookToken,
    ...providerAuthEnv,
    HOME: daemonHome,
    CODEX_HOME: codexHome,
  };
  // OPR.0.4.6.02 S1——唯一共享的 tmux 选项默认值应用器，同时注入 NodeLauncher，
  // 以及通过 AppDeps → 席位交接路由注入新的后继启动器。这样每个新席位获得相同的
  // 鼠标、状态栏和剪贴板默认值，服务端范围默认值在每个后台服务生命周期中只断言一次
  //（共享记忆）。每次启动都重新解析 `terminal.status_bar`（resolveOne 重读配置文件），
  // 因而操作员的切换无需重启后台服务即可作用于下一次启动；解析失败时回退为关闭状态栏。
  const tmuxOptionSettings = new ContextPackSettingsStore();
  const tmuxOptionDefaults = new TmuxOptionDefaultsApplier({
    tmuxAdapter,
    platform: opts?.tmuxOptionPlatform,
    readTmuxOptionDefaults: () => {
      try {
        return { statusBar: tmuxOptionSettings.resolveOne("terminal.status_bar").value === true };
      } catch {
        return { statusBar: false };
      }
    },
  });
  const nodeLauncher = new NodeLauncher({
    db,
    rigRepo,
    sessionRegistry,
    eventBus,
    tmuxAdapter,
    transcriptStore,
    sessionEnv: launchSessionEnv,
    tmuxOptionDefaults,
  });

  const snapshotRepo = new SnapshotRepository(db);
  const checkpointStore = new CheckpointStore(db);
  const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  const claudeManagedLaunch = new ClaudeManagedLaunch(db, { ...launchSessionEnv, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }, {
    OPENRIG_CLAUDE_DISABLE_ALTERNATE_SCREEN: process.env.OPENRIG_CLAUDE_DISABLE_ALTERNATE_SCREEN,
  });
  const claudeResume = new ClaudeResumeAdapter(tmuxAdapter, { claudeManagedLaunch });
  const codexResume = new CodexResumeAdapter(tmuxAdapter, { launchPath: process.env.PATH, detectDaemonSupport: codexDaemonSupportProbe(process.env.PATH) });
  // OPR.0.4.6.PI1——Pi 席位状态根目录与编译后的 runner 入口（后台服务 dist）。
  // 由 Pi 运行时适配器、恢复适配器和恢复 token 捕获 sidecar 读取器共享。
  const piStateRoot = nodePath.join(OPENRIG_HOME, "state", "pi");
  const piRunnerEntryPath = nodePath.resolve(import.meta.dirname, "./adapters/pi-runner.js");
  const piResume = new PiResumeAdapter(
    tmuxAdapter,
    { readFile: (p: string) => fs.readFileSync(p, "utf-8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"), exists: (p: string) => fs.existsSync(p), mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }) },
    { stateRoot: piStateRoot, runnerEntryPath: piRunnerEntryPath },
  );
  // 服务基础设施（RigEnv）——提前创建，供恢复与引导流程使用。
  const { ComposeServicesAdapter } = await import("./adapters/compose-services-adapter.js");
  const { ServiceOrchestrator } = await import("./domain/service-orchestrator.js");
  const composeAdapter = new ComposeServicesAdapter(opts?.tmuxExec ?? execCommand);
  const serviceOrchestrator = new ServiceOrchestrator({ rigRepo, composeAdapter });

  const restoreOrchestrator = new RestoreOrchestrator({
    db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
    checkpointStore, nodeLauncher, tmuxAdapter, claudeResume, codexResume, piResume,
    transcriptStore, serviceOrchestrator,
  });

  // 启动时连接 cmux；缺失时优雅降级。
  await cmuxAdapter.connect();

  // 协调所有托管工作组——把过期会话标记为已分离。汇总计数并记录紧凑摘要，
  // 让冷启动事实修复在后台服务输出中可见，而不是被静默吞掉。
  const reconciler = new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter });
  const rigs = rigRepo.listRigs();
  let reconcileChecked = 0;
  let reconcileDetached = 0;
  let reconcileErrors = 0;
  for (const rig of rigs) {
    try {
      const result = await reconciler.reconcile(rig.id);
      reconcileChecked += result.checked;
      reconcileDetached += result.detached;
      reconcileErrors += result.errors.length;
      for (const e of result.errors) {
        try {
          // eslint-disable-next-line no-console
          console.warn(`启动协调警告：rig=${rig.id} session=${e.sessionId} error=${e.error}`);
        } catch { /* 日志不得抛错 */ }
      }
    } catch (err) {
      reconcileErrors += 1;
      try {
        // eslint-disable-next-line no-console
        console.warn(`启动协调警告：rig=${rig.id} error=${err instanceof Error ? err.message : String(err)}`);
      } catch { /* 日志不得抛错 */ }
    }
  }
  try {
    // eslint-disable-next-line no-console
    console.log(`启动协调：rigs=${rigs.length} checked=${reconcileChecked} detached=${reconcileDetached} errors=${reconcileErrors}`);
  } catch { /* 日志不得抛错 */ }

  // 转录轮转器只存在于当前进程。生命周期协调后重新挂接，使存活的 tmux 会话跨后台服务
  // 重启继续摄取，而真正已分离的会话仍被排除。
  try {
    await resumeRunningTranscriptCaptures(db, tmuxAdapter, transcriptStore);
  } catch (err) {
    try {
      // eslint-disable-next-line no-console
      console.warn(`启动转录捕获警告：${err instanceof Error ? err.message : String(err)}`);
    } catch { /* 日志不得抛错 */ }
  }

  const podRepo = new PodRepository(db);
  const rigSpecExporter = new RigSpecExporter({ rigRepo, sessionRegistry, podRepo });
  const rigSpecPreflight = new RigSpecPreflight({
    rigRepo, tmuxAdapter, exec: opts?.tmuxExec ?? execCommand, cmuxExec: opts?.cmuxExec ?? execCommand,
  });
  const rigInstantiator = new RigInstantiator({
    db, rigRepo, sessionRegistry, eventBus, nodeLauncher, preflight: rigSpecPreflight, tmuxAdapter,
  });

  // 阶段 4：包安装服务。
  const packageRepo = new PackageRepository(db);
  const installRepo = new InstallRepository(db);
  const engineFsOps = {
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    writeFile: (p: string, content: string) => fs.writeFileSync(p, content, "utf-8"),
    exists: (p: string) => fs.existsSync(p),
    mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
    copyFile: (src: string, dest: string) => fs.copyFileSync(src, dest),
    deleteFile: (p: string) => fs.unlinkSync(p),
  };
  const installEngine = new InstallEngine(installRepo, engineFsOps);
  const verifierFsOps = {
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    exists: (p: string) => fs.existsSync(p),
  };
  const installVerifier = new InstallVerifier(installRepo, packageRepo, verifierFsOps);

  // 阶段 5：引导服务。
  const bootstrapRepo = new BootstrapRepository(db);
  const exec = opts?.tmuxExec ?? execCommand;
  const runtimeVerifier = new RuntimeVerifier({ exec, db });
  const probeRegistry = new RequirementsProbeRegistry(exec);
  const externalInstallPlanner = new ExternalInstallPlanner();
  const externalInstallExecutor = new ExternalInstallExecutor({ exec, db });
  const packageInstallService = new PackageInstallService({ packageRepo, installRepo, installEngine, installVerifier });
  const resolverFsOps = {
    readFile: (p: string) => fs.readFileSync(p, "utf-8"),
    exists: (p: string) => fs.existsSync(p),
    listFiles: (dirPath: string) => {
      const results: string[] = [];
      function walk(dir: string, prefix: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(nodePath.join(dir, entry.name), nodePath.join(prefix, entry.name));
          else results.push(prefix ? nodePath.join(prefix, entry.name) : entry.name);
        }
      }
      walk(dirPath, "");
      return results;
    },
  };
  const bundleSourceResolver = new BundleSourceResolver({ fsOps: resolverFsOps });
  // 感知席位组的实例化器（AgentSpec 重启）。
  const { PodRigInstantiator } = await import("./domain/rigspec-instantiator.js");
  const { reconcileSkillLoadout } = await import("./domain/skill-catalog.js");
  const { StartupOrchestrator } = await import("./domain/startup-orchestrator.js");
  const { ClaudeCodeAdapter } = await import("./adapters/claude-code-adapter.js");
  // P20——投影清单：应用时记录，使投影器之后能区分过期重投影（可安全覆盖）
  // 与操作员编辑（应保护）。
  const { ProjectionManifestStore } = await import("./domain/projection-manifest-store.js");
  const { hashContent } = await import("./domain/conflict-detector.js");
  const projectionManifestStore = new ProjectionManifestStore(db);
  // atom-4b——启动时探测清单可读性。罕见的逐次查找异常会保护单个目标
  //（conflict-detector：broken≠absent → operator_conflict）；但整表不可读会让所有投影
  // 降级为保护状态，任何覆盖都不会执行。这很安全却可能静默，因此启动时明确警告，
  // 告知操作员投影正等待数据库修复，而不是静默表现为没有任何投影。
  if (!projectionManifestStore.isReadable()) {
    console.warn(
      "启动时无法读取 projection-manifest——数据库修复前，所有投影都会降级为 PROTECT（不会应用覆盖）；请检查 projection_manifest（迁移 064）。",
    );
  }
  const { CodexRuntimeAdapter } = await import("./adapters/codex-runtime-adapter.js");
  const { PiRuntimeAdapter } = await import("./adapters/pi-runtime-adapter.js");

  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter, readFile: (p: string) => fs.readFileSync(p, "utf-8") });
  const runtimeSettings = new ContextPackSettingsStore().resolveConfig();
  const claudeAdapter = new ClaudeCodeAdapter({ tmux: tmuxAdapter, claudeManagedLaunch, fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf-8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"), exists: (p: string) => fs.existsSync(p), mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }), copyFile: (src: string, dest: string) => fs.copyFileSync(src, dest), listFiles: (dir: string) => { const r: string[] = []; function w(d: string, pre: string) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) w(nodePath.join(d, e.name), nodePath.join(pre, e.name)); else r.push(pre ? nodePath.join(pre, e.name) : e.name); } } w(dir, ""); return r; }, readdir: (dir: string) => fs.readdirSync(dir), statMode: (p: string) => fs.statSync(p).mode, chmod: (p: string, m: number) => fs.chmodSync(p, m), homedir: os.homedir() }, stateDir: OPENRIG_HOME, collectorAssetPath: nodePath.resolve(import.meta.dirname, "../assets/claude-statusline-context.cjs"), autoDriveProviderPrompts: runtimeSettings.recoveryAutoDriveProviderPrompts, activityRelayPath: nodePath.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs"), claudeHooksManifestPath: nodePath.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/claude.json"), recordProjection: (targetPath: string, content: string) => projectionManifestStore.record({ targetPath, lastHash: hashContent(content), writtenAt: new Date().toISOString() }) });
  const codexAdapter = new CodexRuntimeAdapter({ tmux: tmuxAdapter, fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf-8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"), exists: (p: string) => fs.existsSync(p), mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }), listFiles: (dir: string) => { const r: string[] = []; function w(d: string, pre: string) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) w(nodePath.join(d, e.name), nodePath.join(pre, e.name)); else r.push(pre ? nodePath.join(pre, e.name) : e.name); } } w(dir, ""); return r; }, statMode: (p: string) => fs.statSync(p).mode, chmod: (p: string, m: number) => fs.chmodSync(p, m), homedir: daemonHome }, codexHome, launchPath: process.env.PATH, detectDaemonSupport: codexDaemonSupportProbe(process.env.PATH), activityRelayPath: nodePath.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs") });
  // OPR.0.4.6.PI1——RPC 优先的 Pi 适配器（窗格内 runner）。fsOps 形态与
  // Codex 适配器相同；席位隔离根目录位于 piStateRoot 下。
  const piAdapter = new PiRuntimeAdapter({ tmux: tmuxAdapter, fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf-8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"), exists: (p: string) => fs.existsSync(p), mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }), listFiles: (dir: string) => { const r: string[] = []; function w(d: string, pre: string) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) w(nodePath.join(d, e.name), nodePath.join(pre, e.name)); else r.push(pre ? nodePath.join(pre, e.name) : e.name); } } w(dir, ""); return r; } }, stateRoot: piStateRoot, runnerEntryPath: piRunnerEntryPath });
  // OPR.0.5.1.1——stub 运行时适配器（窗格中、Pi 形态的 Node 脚本 runner）。
  // fsOps 形态与 Pi 相同；编译后的 runner 入口位于后台服务 dist。
  const { StubRuntimeAdapter } = await import("./adapters/stub-runtime-adapter.js");
  const stubRunnerEntryPath = nodePath.resolve(import.meta.dirname, "./adapters/stub-runner.js");
  const stubAdapter = new StubRuntimeAdapter({ tmux: tmuxAdapter, fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf-8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"), exists: (p: string) => fs.existsSync(p), mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }), listFiles: (dir: string) => { const r: string[] = []; function w(d: string, pre: string) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) w(nodePath.join(d, e.name), nodePath.join(pre, e.name)); else r.push(pre ? nodePath.join(pre, e.name) : e.name); } } w(dir, ""); return r; } }, runnerEntryPath: stubRunnerEntryPath });

  // plugin-primitive 阶段 3a slice 3.5——确保 ~/.codex/config.toml 中设置
  // Codex 特性开关 codex_hooks = true，使插件随附钩子在 Codex 运行时触发。
  // Slice 27 还会创建默认、由用户拥有的 Claude 压缩额外指令占位文件。操作员可通过
  // OPENRIG_RUNTIME_CODEX_HOOKS_ENABLED 或 `zrig config set runtime.codex.hooks_enabled false`
  // 禁用 Codex 钩子。
  try {
    const {
      SettingsStore,
      ensureDefaultClaudeCompactionFiles,
    } = await import("./domain/user-settings/settings-store.js");
    ensureDefaultClaudeCompactionFiles(OPENRIG_HOME);
    const settingsStore = new SettingsStore();
    const enabled = settingsStore.resolveOne("runtime.codex.hooks_enabled").value as boolean;
    let codexVersion: string | undefined;
    const codexVersionRow = db.prepare(
      "SELECT version FROM runtime_verifications WHERE runtime = 'codex' ORDER BY verified_at DESC LIMIT 1"
    ).get() as { version: string | null } | undefined;
    if (codexVersionRow?.version) {
      codexVersion = codexVersionRow.version;
    } else {
      try {
        const verifyResult = await runtimeVerifier.verifyCodex();
        codexVersion = verifyResult.version ?? undefined;
      } catch { /* Codex 不可用——跳过特性开关 */ }
    }
    codexAdapter.ensureCodexFeatureFlag(enabled, { codexVersion });
    // OPR.0.4.1.10 FR-A——把 OpenRig 活动钩子投影到 Codex 配置层，使 Codex 席位在
    // 干净发布配置下成为 rig-send 提示守卫的钩子主路径，并获得
    // SessionStart/UserPromptSubmit/Stop 可观测性。启用门禁与特性开关相同；启动时自动清除 trust。
    if (enabled) {
      codexAdapter.ensureCodexActivityHooks();
    } else {
      // OPR.0.4.1.10 B3——持久禁用：移除此前写入的托管 [hooks] 块。
      codexAdapter.removeCodexActivityHooks();
    }
  } catch (err) {
    console.error(`[openrig] 运行时设置警告：${(err as Error).message}`);
  }

  // plugin-primitive 阶段 3a slice 3.2——首次启动时把 openrig-core 插件复制到
  // ~/.openrig/plugins/openrig-core/。从 github.com/mvschwarz/openrig-plugins 自动获取
  // 采用尽力而为策略并容忍 404（截至 2026-05-10 仓库为空；v0 以随附副本为事实源）。
  try {
    const { PluginVendorService } = await import("./domain/plugin-vendor-service.js");
    const vendoredAssetsDir = nodePath.resolve(import.meta.dirname, "../assets/plugins");
    const userPluginsDir = getDefaultOpenRigPath("plugins");
    const realFs = {
      readFile: (p: string) => fs.readFileSync(p, "utf-8"),
      writeFile: (p: string, c: string) => fs.writeFileSync(p, c, "utf-8"),
      exists: (p: string) => fs.existsSync(p),
      mkdirp: (p: string) => fs.mkdirSync(p, { recursive: true }),
      listFiles: (dir: string) => {
        const r: string[] = [];
        function w(d: string, pre: string) {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory()) w(nodePath.join(d, e.name), nodePath.join(pre, e.name));
            else r.push(pre ? nodePath.join(pre, e.name) : e.name);
          }
        }
        w(dir, "");
        return r;
      },
      statMode: (p: string) => fs.statSync(p).mode,
      chmod: (p: string, m: number) => fs.chmodSync(p, m),
    };
    const httpClient = async (url: string, opts?: { timeoutMs?: number }) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 5000);
      try {
        const resp = await fetch(url, { signal: ctrl.signal });
        return { ok: resp.ok, status: resp.status };
      } finally {
        clearTimeout(timer);
      }
    };
    const vendorService = new PluginVendorService({
      vendoredAssetsDir,
      userPluginsDir,
      fs: realFs,
      httpClient,
      logger: (...args) => console.log("[openrig]", ...args),
    });
    await vendorService.ensureLatest("openrig-core");
    vendorService.ensureSkillGlobally("openrig-core", "openrig-skills", [
      nodePath.join(os.homedir(), ".claude", "skills"),
      nodePath.join(os.homedir(), ".agents", "skills"),
    ]);
  } catch (err) {
    console.error(`[openrig] 插件随附设置警告：${(err as Error).message}`);
  }

  // PL-014：一个后台服务范围的 ContextPackLibraryService 支撑无需投递的
  // /api/context-packs list/sync/compose/read/delete/preview/pieces 路由。
  // 有意不支持启动时展开上下文包；投递由专用 send/broadcast/walk/queue 动词负责。
  const contextPackLibrary = (() => {
    // OPR.0.5.9.5 Wave B——由配置解析的规范上下文库。共享实例初始化器通常会创建
    // 两个根目录；这里的 mkdir 用于保持直接调用 createDaemon 的测试夹具兼容。
    const userPacksRoot = new ContextPackSettingsStore().resolveOne("context.root").value as string;
    const [contextRoot, systemPacksRoot] = openRigContextLibraryRoots(userPacksRoot);
    try { fs.mkdirSync(systemPacksRoot, { recursive: true }); } catch { /* 尽力而为 */ }
    const roots: Array<{ path: string; sourceType: "builtin" | "user_file" | "workspace" }> = [
      { path: contextRoot, sourceType: "user_file" },
      { path: systemPacksRoot, sourceType: "user_file" },
    ];
    try {
      const settingsStore = new ContextPackSettingsStore();
      const cfg = settingsStore.resolveConfig();
      const workspacePacksRoot = nodePath.join(cfg.workspaceRoot, ".openrig", "context-packs");
      if (workspacePacksRoot !== userPacksRoot && workspacePacksRoot !== systemPacksRoot && fs.existsSync(workspacePacksRoot)) {
        roots.push({ path: workspacePacksRoot, sourceType: "workspace" });
      }
    } catch { /* 设置不可用；仅使用用户文件根目录继续 */ }
    const builtinPacksRoot = nodePath.resolve(import.meta.dirname, "../context-packs");
    if (fs.existsSync(builtinPacksRoot)) {
      roots.unshift({ path: builtinPacksRoot, sourceType: "builtin" });
    }
    const lib = new ContextPackLibraryService({ roots });
    lib.scan();
    return lib;
  })();

  // PL-016 第 2、4 项：提升 AgentImageLibraryService 的构造位置，使 PodRigInstantiator
  // 能在实体化时解析 `session_source: mode: agent_image`。下方把同一实例返回到 deps，
  // 供 /api/agent-images/* 与 SnapshotCapturer 共享。
  const agentImageRootBuilder = () => {
    const userImagesRoot = getDefaultOpenRigPath("agent-images");
    try { fs.mkdirSync(userImagesRoot, { recursive: true }); } catch { /* 尽力而为 */ }
    const roots: Array<{ path: string; sourceType: "builtin" | "user_file" | "workspace" }> = [
      { path: userImagesRoot, sourceType: "user_file" },
    ];
    try {
      const settingsStore = new ContextPackSettingsStore();
      const cfg = settingsStore.resolveConfig();
      const workspaceImagesRoot = nodePath.join(cfg.workspaceRoot, ".openrig", "agent-images");
      if (workspaceImagesRoot !== userImagesRoot && fs.existsSync(workspaceImagesRoot)) {
        roots.push({ path: workspaceImagesRoot, sourceType: "workspace" });
      }
    } catch { /* 设置不可用 */ }
    return { userImagesRoot, roots };
  };
  const agentImageLibrary = (() => {
    const { roots } = agentImageRootBuilder();
    const lib = new AgentImageLibraryService({ roots });
    lib.scan();
    return lib;
  })();
  const snapshotCapturer = new SnapshotCapturer({
    db,
    rigRepo,
    sessionRegistry,
    agentImageLibrary,
    targetRoot: getDefaultOpenRigPath("agent-images"),
  });

  const continuityPolicyMaterializer = new ContinuityPolicyMaterializer(
    watchdogJobsRepoInstance,
    ({ sessionId }) => {
      const row = db.prepare("SELECT resume_token FROM sessions WHERE id = ?").get(sessionId) as
        | { resume_token: string | null }
        | undefined;
      const token = row?.resume_token;
      if (!token) return null;
      const claudeRoot = process.env.CLAUDE_CONFIG_DIR ?? nodePath.join(os.homedir(), ".claude");
      return findClaudeTranscriptByToken(nodePath.join(claudeRoot, "projects"), token);
    },
  );

  const podInstantiator = new PodRigInstantiator({
    db, rigRepo, podRepo,
    sessionRegistry, eventBus, nodeLauncher, startupOrchestrator,
    fsOps: { readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) },
    adapters: { "claude-code": claudeAdapter, "codex": codexAdapter, "pi": piAdapter, "stub": stubAdapter, "terminal": new (await import("./adapters/terminal-adapter.js")).TerminalAdapter() },
    tmuxAdapter,
    agentImageLibrary,
    continuityPolicyMaterializer,
    exec,
    // OPR.0.5.3.6——实体化时把随附拓扑链文件默认值安装到类型化 topology.root 下
    //（不存在时复制）。
    topologyRootResolver: () => String(new ContextPackSettingsStore().resolveOne("topology.root").value),
    onboardingEnabledResolver: () =>
      new ContextPackSettingsStore().resolveOne("onboarding.default_pack.enabled").value === true,
    skillsRootResolver: () =>
      String(new ContextPackSettingsStore().resolveOne("skills.root").value),
    systemWorldResolver: () => {
      const settings = new ContextPackSettingsStore();
      const cfg = settings.resolveConfig();
      const selected = settings.resolveOne("context.system_world");
      return resolveSystemWorld({
        contextRoot: cfg.contextRoot,
        selection: String(selected.value),
        source: selected.source,
      });
    },
    skillReconciler: reconcileSkillLoadout,
  });

  const podBundleSourceResolver = new PodBundleSourceResolver();

  const bootstrapOrchestrator = new BootstrapOrchestrator({
    db, bootstrapRepo, runtimeVerifier, probeRegistry,
    installPlanner: externalInstallPlanner, installExecutor: externalInstallExecutor,
    packageInstallService, rigInstantiator, fsOps: resolverFsOps,
    bundleSourceResolver, podInstantiator, podBundleSourceResolver,
    serviceOrchestrator, rigRepo,
  });

  // V0.3.1 slice 05 kernel-rig-as-default——后台服务启动时自动引导 kernel 工作组。
  // Forward-fix #3 架构要求：引导在后台触发而不等待。跟踪器创建后 createDaemon
  // 即完成，使 server.ts 可独立于 kernel 智能体就绪状态绑定 healthz。损坏的 kernel
  // 智能体不再阻止后台服务 HTTP 表面启动。
  //
  // 跟踪器状态通过 /api/kernel/status（见下方路由）暴露，CLI 的
  // `zrig daemon start --wait-for-kernel` 标志会轮询该状态。经过可配置的降级计时窗口
  //（默认 90 秒；运维与测试夹具可用 OPENRIG_KERNEL_DEGRADED_MS 覆盖）后，跟踪器发出
  // 单个 `kernel.agent.degraded` 事件用于观测。kernel 工作组仍是后台服务唯一自动引导的
  // 工作组；按修订后的 IMPL-PRD §16.2，其他工作组需操作员显式执行 `zrig up` / `zrig restore`。
  let kernelBootTracker: import("./domain/kernel-boot-tracker.js").KernelBootTracker | undefined;
  try {
    const { bootKernelIfNeeded } = await import("./domain/kernel-boot.js");
    const degradedRaw = readOpenRigEnv("OPENRIG_KERNEL_DEGRADED_MS");
    const degradedTimeoutMs = degradedRaw && /^\d+$/.test(degradedRaw)
      ? parseInt(degradedRaw, 10)
      : undefined;
    kernelBootTracker = await bootKernelIfNeeded({
      rigRepo,
      sessionRegistry,
      eventBus,
      bootstrapOrchestrator,
      specsDir: nodePath.resolve(nodePath.dirname(new URL(import.meta.url).pathname), "..", "specs"),
      // V0.3.1 slice 05——kernel 成员在操作员工作区而非后台服务安装树中运行。
      // 缺少此 cwdOverride 时，BootstrapOrchestrator 会以
      // “cwd 位于 zrig 安装目录内”拒绝。使用解析后的 workspace.root
      // 设置作为每位操作员的默认值。
      cwdOverride: runtimeSettings.workspaceRoot,
      degradedTimeoutMs,
    });
    try {
      // eslint-disable-next-line no-console
      console.log(`kernel-boot：tracker-state=${kernelBootTracker.getStatus().kernelState}`);
    } catch { /* 日志不得抛错 */ }
  } catch (err) {
    try {
      // eslint-disable-next-line no-console
      console.warn(`kernel-boot：因错误跳过：${err instanceof Error ? err.message : String(err)}`);
    } catch { /* 日志不得抛错 */ }
  }

  // 发现服务。
  const tmuxScanner = new TmuxDiscoveryScanner({ tmuxAdapter });
  const sessionFingerprinter = new SessionFingerprinter({
    cmuxAdapter, tmuxAdapter, fsExists: (p: string) => fs.existsSync(p),
  });
  const sessionEnricher = new SessionEnricher({
    fsExists: (p: string) => fs.existsSync(p),
    fsReaddir: (p: string) => fs.readdirSync(p),
  });
  const discoveryRepo = new DiscoveryRepository(db);
  const discoveryCoordinator = new DiscoveryCoordinator({
    scanner: tmuxScanner, fingerprinter: sessionFingerprinter, enricher: sessionEnricher,
    discoveryRepo, sessionRegistry, eventBus,
  });
  // 上下文用量存储——在刷新器与 ClaimService 前构造，使 Claude 状态栏 sidecar 读取器
  // 能同时注入 FR-3 采用边界捕获（ClaimService）和 FR-4 快照空值补全（刷新器）。
  // 下方 WhoamiService 与路由也复用同一实例。
  const { ContextUsageStore } = await import("./domain/context-usage-store.js");
  const contextUsageStore = new ContextUsageStore(db, {
    stateDir: OPENRIG_HOME,
    // GHOST-STAGE（c-id）：拒绝当前占位者启动前（前一代）的上下文读数，
    // 避免交接前冻结样本驱动阈值。null = UNKNOWN（不生效）。
    resolveOccupantBootAt: (nodeId) => sessionRegistry.currentOccupantTenure(nodeId)?.bootAt ?? null,
  });
  const { HealthProjectionService, LiveContextHealthSource } = await import("./domain/health-detectors.js");
  const healthSettingsStore = new ContextPackSettingsStore();
  const contextHealthSource = new LiveContextHealthSource({
    db,
    rigRepo,
    sessionRegistry,
    contextUsageStore,
    resolveContextPressurePolicy: () => healthSettingsStore.resolveContextPressurePolicy(),
  });
  const healthPolicy = new HealthPolicyStore(OPENRIG_HOME, () => healthSettingsStore.resolveContextPressurePolicy());
  const healthCheckpoints = new HealthCheckpointSource(OPENRIG_HOME, queueRepoInstance, healthPolicy, undefined, healthSettingsStore.resolveOne("workspace.root").value as string);
  const rigModeStore = new RigModeStore(db);
  const operatingPosture = new OperatingPostureService(db, rigModeStore, () => healthSettingsStore.resolveOne("workspace.root").value as string);
  const passiveCeremony = new PassiveCeremonySource(healthSettingsStore.resolveOne("workspace.root").value as string, queueRepoInstance, healthPolicy, undefined, healthCheckpoints, { reader: operatingPosture, instanceId: OPENRIG_HOME });
  const healthProjection = new HealthProjectionService({ read: () => [...contextHealthSource.read(), ...healthCheckpoints.read(), ...passiveCeremony.read()] }, () => healthPolicy.read(), (record) => operatingPosture.forHealth(record));
  const healthDiagnosis = new HealthDiagnosisService({ queue: queueRepoInstance, projection: healthProjection, policy: healthPolicy,
    authority: (record) => healthAuthority(healthSettingsStore.resolveOne("workspace.root").value as string, healthCheckpoints, record),
    resolveEvidence: (path, finding) => readHealthArtifact(finding.operatingPosture?.context?.paths?.project ?? healthSettingsStore.resolveOne("workspace.root").value as string, path),
    humanReadiness: (address) => healthHumanReadiness(OPENRIG_HOME, address, deps.gatewaySubsystem?.status().state === "active"),
  });
  // OPR.0.4.3.20 FR-4——注入 contextUsageStore，使 refresh() 在周期/手动快照刷新时
  // 可从 sidecar 补全空的 Claude token。
  const resumeMetadataRefresher = new ResumeMetadataRefresher({ sessionRegistry, tmuxAdapter, contextUsageStore });
  const claimService = new ClaimService({
    db, rigRepo, sessionRegistry, discoveryRepo, eventBus, tmuxAdapter, transcriptStore,
    claudeContextProvisioner: claudeAdapter,
    // OPR.0.4.3.20 FR-3——采用边界恢复 token 捕获依赖
    //（Claude sidecar 读取器与 Codex thread-id 捕获器，二者复用）。
    contextUsageStore,
    resumeTokenCapturer: resumeMetadataRefresher,
    // OPR.0.4.6.PI1 FR-6——pi-runner sidecar 读取器（由适配器暴露）。
    piRunnerStateStore: piAdapter,
  });
  const selfAttachService = new SelfAttachService({
    db, rigRepo, podRepo, sessionRegistry, eventBus, tmuxAdapter, transcriptStore,
    claudeContextProvisioner: claudeAdapter,
    // OPR.0.4.3.28 B3——把解析后的活动 URL 与 token 回显到 self-attach 响应环境，
    // 使调用方 shell 能产生活动信号。
    activityEnv: { url: resolvedActivityHookUrl, token: resolvedActivityHookToken },
  });
  const rigLifecycleService = new RigLifecycleService({
    db, rigRepo, sessionRegistry, discoveryRepo, eventBus, queueRepo: queueRepoInstance, tmuxAdapter,
  });
  const rigExpansionService = new RigExpansionService({ db, rigRepo, eventBus, nodeLauncher, podInstantiator, sessionRegistry });

  const specReviewService = new SpecReviewService();

  //（为满足 FR-3，ContextUsageStore 已在上方先于 ClaimService 构造。）
  const whoamiService = new WhoamiService({ db, rigRepo, sessionRegistry, transcriptStore, contextUsageStore });
  const nodeCmuxService = new NodeCmuxService(rigRepo, sessionRegistry, cmuxAdapter, tmuxAdapter);
  // W2a-1——生产者接线：当前占位者代数从发布的 occupant-tenure 台账同步解析。新占位者会
  // 更换 generation_uuid，且该值只在一次任期内持久化（同会话重启属于延续，不创建新代数）；
  // 跨交接稳定键是 node_id，而不是 generation_uuid。null = UNKNOWN，存储会据此弃权
  //（绝不把过期声明实时渲染）。热路径只读 better-sqlite3，不执行 tmux。
  const agentActivityStore = new AgentActivityStore({
    db,
    eventBus,
    resolveOccupantGeneration: (nodeId) => sessionRegistry.currentOccupantTenure(nodeId)?.generationUuid ?? null,
    isRegisteredOccupantGeneration: (nodeId, generation) =>
      sessionRegistry.isOccupantGenerationRegistered(nodeId, generation),
  });
  const { SeatAttentionReconciler } = await import("./domain/seat-attention-reconciler.js");
  const seatAttentionReconciler = new SeatAttentionReconciler({
    sessionRegistry, eventBus, agentActivityStore, db, tmux: tmuxAdapter,
    reconcileRestoreOutcome: (rigId, nodeId) => restoreOrchestrator.reconcileNodeRuntimeTruth(rigId, nodeId),
    sendVerify: async (session, text, opts) => {
      const transport = deps.sessionTransport;
      if (!transport) return { ok: false, outcome: "failed" };
      return transport.send(session, text, { verify: opts?.verify });
    },
    capture: async (session, opts) => {
      const transport = deps.sessionTransport;
      if (!transport) return { ok: false, sessionName: session, error: "transport_unavailable" };
      return transport.capture(session, opts);
    },
  });

  const deps: AppDeps = {
    rigRepo,
    sessionRegistry,
    daemonLifecycleStore,
    daemonBootEpoch,
    eventBus,
    nodeLauncher,
    startupOrchestrator,
    tmuxAdapter,
    tmuxOptionDefaults,
    sessionEnv: launchSessionEnv,
    cmuxAdapter,
    snapshotCapture,
    snapshotRepo,
    // Slice-04 OPR.0.5.0.4：生产 provider 服务——在 codex-auth 读取器与跨工作组
    // node-inventory 之上提供 getReadModel；通过纯门禁预检；切换时如实呈现过渡态（D 接缝）。
    // C3：Claude 状态栏的 provider_usage 缓存通道。缓存文件以席位为键，读取器会规范化
    // 有效订阅窗口；实时席位回退由 provider-collect 负责。
    providerService: new ProviderServiceImpl({
      db,
      listRigs: () => rigRepo.listRigs(),
      collectClaudeSignals: () => collectClaudeSignalsFromProviderUsageDirectory(
        providerUsageDirectory(OPENRIG_HOME),
        undefined,
        legacyProviderUsageDirectory(OPENRIG_HOME),
      ),
      agentActivityStore,
    }),
    restoreOrchestrator,
    resumeMetadataRefresher, // OPR.0.4.3.20 FR-4——手动快照在序列化前刷新
    rigSpecExporter,
    rigSpecPreflight,
    rigInstantiator,
    packageRepo,
    installRepo,
    installEngine,
    installVerifier,
    bootstrapOrchestrator,
    bootstrapRepo,
    discoveryCoordinator,
    discoveryRepo,
    claimService,
    selfAttachService,
    rigLifecycleService,
    rigExpansionService,
    // Slice 15——SeatActivityService 拥有 `terminal-active` 原语（tmux 字节流）。
    // 将其接入 PsProjectionService，使 `rig ps` 与 UI 表面读取各席位的最新观测。
    // 绝不读取队列/分配状态（非推断契约；见 slice 15 IMPL-PRD §2.3）。
    seatActivityService,
    seatStructuralActivityService,
    seatIdentityReconciler,
    // OPR.0.4.4.21——agentActivity 为工作组汇总的待关注谓词提供 needs_input 信号
    //（仅同步查询事件）。
    psProjectionService: new PsProjectionService({ db, seatActivity: seatActivityService, agentActivity: agentActivityStore }),
    upRouter: new UpCommandRouter({
      fsOps: {
        exists: (p: string) => fs.existsSync(p),
        readFile: (p: string) => fs.readFileSync(p, "utf-8"),
        readHead: (p: string, bytes: number) => { const fd = fs.openSync(p, "r"); const buf = Buffer.alloc(bytes); fs.readSync(fd, buf, 0, bytes, 0); fs.closeSync(fd); return buf; },
      },
    }),
    teardownOrchestrator: new RigTeardownOrchestrator({
      db, rigRepo, sessionRegistry, tmuxAdapter, snapshotCapture, eventBus, resumeMetadataRefresher, serviceOrchestrator,
    }),
    podInstantiator,
    podBundleSourceResolver,
    runtimeAdapters: { "claude-code": claudeAdapter, "codex": codexAdapter, "pi": piAdapter, "stub": stubAdapter, "terminal": new (await import("./adapters/terminal-adapter.js")).TerminalAdapter() },
    transcriptStore,
    sessionTransport: (() => {
      const t = new SessionTransport({
        db,
        rigRepo,
        sessionRegistry,
        tmuxAdapter,
        agentActivityStore,
        eventBus,
        slowOpRecorder,
        activityEndpointFile: () => readActivityEndpointFile(OPENRIG_HOME),
        captureObserver: shadow.capture?.observer,
      });
      // PL-004 阶段 A 修订（R1）：接入 QueueRepository 的唤醒路径，使 create / handoff /
      // handoff-and-complete 默认都会发出提醒。
      queueRepoInstance.attachTransport(t);
      // PL-004 阶段 B：从 sessions 表接入 classifier-lease-manager 活性检查。仅当
      // `sessions` 至少存在一行 session_name == classifierSession 且 status == 'running' 时，
      // 才视租约持有者为“存活”。
      classifierLeaseManagerInstance.attachIsAlive((classifierSession: string): boolean => {
        try {
          const row = db
            .prepare(
              `SELECT 1 FROM sessions WHERE session_name = ? AND status = 'running' LIMIT 1`,
            )
            .get(classifierSession) as { 1: number } | undefined;
          return row !== undefined;
        } catch {
          // 保守处理：查询出错时视为存活，避免误触发基于死亡状态的租约过期。
          return true;
        }
      });
      return t;
    })(),
    chatRepo: new ChatRepository(db),
    streamStore,
    slowOpRecorder,
    queueRepo: queueRepoInstance,
    inboxHandler: new InboxHandler(db, eventBus, queueRepoInstance),
    outboxHandler: outboxHandlerInstance,
    shadowCapture: shadow.capture,
    shadowCaptureError: shadow.error,
    classifierLeaseManager: classifierLeaseManagerInstance,
    projectClassifier: new ProjectClassifier(db, eventBus, classifierLeaseManagerInstance),
    classificationAttemptLedger: new ClassificationAttemptLedger(db, classifierLeaseManagerInstance),
    viewProjector: viewProjectorInstance,
    watchdogJobsRepo: watchdogJobsRepoInstance,
    watchdogHistoryLog: watchdogHistoryLogInstance,
    wakeResolveService: new WakeResolveService({
      listSessionsBySeat: (seat: string) =>
        db
          .prepare(
            `SELECT s.id AS id, s.session_name AS sessionName, s.resume_token AS resumeToken,
                    n.runtime AS runtime, s.created_at AS createdAt
               FROM sessions s JOIN nodes n ON s.node_id = n.id
              WHERE s.session_name = ? ORDER BY s.id DESC`,
          )
          .all(seat) as WakeSessionRow[],
    }),
    askService: (() => {
      // P19 A5（发现项已转正）：像待关注路径（约第 919 行）一样注入 seatActivity——
      // terminalActive 只有一个事实源，绝不维护两套可能分歧的投影。
      const psProjectionService = new PsProjectionService({ db, seatActivity: seatActivityService, agentActivity: agentActivityStore });
      const execDep = (cmd: string, args: string[]): Promise<{ stdout: string; exitCode: number }> =>
        new Promise((resolve) => {
          execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
            if (err && typeof (err as NodeJS.ErrnoException).code === "string" && (err as NodeJS.ErrnoException).code === "ENOENT") {
              resolve({ stdout: "", exitCode: 2 });
              return;
            }
            const exitCode = err ? (err as { code?: number }).code ?? 1 : 0;
            resolve({ stdout: stdout ?? "", exitCode: typeof exitCode === "number" ? exitCode : 1 });
          });
        });
      const chatRepoForAsk = new ChatRepository(db);
      const historyQuery = new HistoryQuery({
        transcriptsRoot: transcriptStore.enabled
          ? (transcriptsPath ?? getCompatibleOpenRigPath("transcripts"))
          : getCompatibleOpenRigPath("transcripts"),
        exec: execDep,
        chatSearchFn: (rigId: string, pattern: string) =>
          chatRepoForAsk.searchChat(rigId, pattern).map((m) => ({
            sender: m.sender,
            body: m.body,
            createdAt: m.createdAt,
          })),
      });
      return new AskService({
        psProjectionService,
        rigRepo,
        historyQuery,
        transcriptsEnabled: transcriptStore.enabled,
        whoamiService,
      });
    })(),
    whoamiService,
    nodeCmuxService,
    agentActivityStore,
    seatAttentionReconciler,
    activityHookToken: resolvedActivityHookToken,
    contextUsageStore,
    healthProjection,
    healthDiagnosis,
    healthPolicy,
    healthCheckpoints,
    serviceOrchestrator,
    composeAdapter,
    kernelBootTracker,
    specReviewService,
    specLibraryService: (() => {
      const userSpecsRoot = getDefaultOpenRigPath("specs");
      const legacySpecsRoot = getCompatibleOpenRigPath("specs");
      try { fs.mkdirSync(userSpecsRoot, { recursive: true }); } catch { /* 尽力而为 */ }
      // 无论从 src/ 还是 dist/ 解析，../specs 都指向 packages/daemon/specs/。
      const builtinSpecsRoot = nodePath.resolve(import.meta.dirname, "../specs");
      const roots: Array<{ path: string; sourceType: "builtin" | "user_file" }> = [
        { path: userSpecsRoot, sourceType: "user_file" },
      ];
      if (legacySpecsRoot !== userSpecsRoot && fs.existsSync(legacySpecsRoot)) {
        roots.push({ path: legacySpecsRoot, sourceType: "user_file" });
      }
      // 仅在内置根目录存在时加入。
      if (fs.existsSync(builtinSpecsRoot)) {
        roots.unshift({ path: builtinSpecsRoot, sourceType: "builtin" });
      }
      const lib = new SpecLibraryService({ roots, specReviewService });
      lib.scan();
      return lib;
    })(),
    // 阶段 3a slice 3.3——插件发现服务。
    // SC-29 EXCEPTION #8 原文见 packages/daemon/src/routes/plugins.ts 文件头。
    // 对三个来源根目录做文件系统扫描，并解析 agent.yaml，以支持 used-by 反向查询；
    // 不使用 SQL，也不产生变更。used-by 的规范库目录与上方 SpecLibraryService 使用同一
    // 默认用户规范根目录；v0 仅支持一个根目录（待后续 slice 将规范库的完整根目录列表
    // 接入发现服务后再扩展为多根目录）。
    // 修复 slice plugin-discovery-respects-openrig-home：让 openrigPluginsDir 通过感知
    // OPENRIG_HOME 的解析器，使 discovery 与 vendor（已在第 428 行使用该辅助函数）解析到
    // 同一根目录。操作员级测试隔离与 slice 22 的 populated-VM-env 场景都依赖这种对称性。
    // claudeCacheDir / codexCacheDir 仍锚定 homedir，因为这些缓存位置属于运行时工具，
    // 而非 OpenRig 状态根目录。
    pluginDiscoveryService: new PluginDiscoveryService({
      openrigPluginsDir: getDefaultOpenRigPath("plugins"),
      claudeCacheDir: nodePath.join(os.homedir(), ".claude", "plugins", "cache"),
      codexCacheDir: nodePath.join(os.homedir(), ".codex", "plugins", "cache"),
      specLibraryDir: getDefaultOpenRigPath("specs"),
    }),
    // Slice 28 检查点 C-3——skillLibraryDiscoveryService 在下方解析 filesAllowlist 后构造
    //（deps.skillLibraryDiscoveryService 的赋值紧邻 filesAllowlist 绑定）。
    // 支撑无投递上下文路由的共享上下文库。
    contextPackLibrary,
    // PL-016——agent_image 类型化原语。/api/agent-images/* 与 PodRigInstantiator 的
    // session_source: mode: agent_image 分派共享库、捕获器和规范根目录提供器。
    agentImageLibrary,
    snapshotCapturer,
    // Slice 09（OPR.0.3.2.9）——operator-context-mode 绑定存储
    //（共享 db 句柄上的类型化原语；HG-5：不另建并行存储）。
    rigModeStore,
    operatingPosture,
    agentImageSpecRoots: () => {
      // 证据守卫扫描的规范库根目录。v0 包含 ~/.openrig/specs 下的用户规范，以及
      // 工作区本地规范根目录（来自 SettingsStore 解析的 workspace.specsRoot）。
      const userSpecsRoot = getDefaultOpenRigPath("specs");
      const roots: string[] = [userSpecsRoot];
      try {
        const settingsStore = new ContextPackSettingsStore();
        const cfg = settingsStore.resolveConfig();
        if (cfg.workspaceSpecsRoot && cfg.workspaceSpecsRoot !== userSpecsRoot) {
          roots.push(cfg.workspaceSpecsRoot);
        }
      } catch { /* 设置不可用 */ }
      return roots;
    },
  };
  Object.assign(deps, { watchdogAutoRegistration });

  // 把随附参考文档复制到 ~/.openrig/reference/，使智能体可通过稳定路径找到它们。
  try {
    const bundledDocsDir = nodePath.resolve(import.meta.dirname, "../docs/reference");
    if (fs.existsSync(bundledDocsDir)) {
      const referenceDir = getDefaultOpenRigPath("reference");
      fs.mkdirSync(referenceDir, { recursive: true });
      for (const file of fs.readdirSync(bundledDocsDir)) {
        if (file.endsWith(".md")) {
          fs.copyFileSync(nodePath.join(bundledDocsDir, file), nodePath.join(referenceDir, file));
        }
      }
    }
  } catch { /* 尽力而为——参考文档不影响后台服务运行 */ }

  // OPR.0.4.8.3——把打包的内置策略实体化为只读检查副本，存放在
  // $OPENRIG_HOME/reference/policies/builtin/（与上方参考文档一样尽力而为；
  // ../policies/builtin 在仓库运行和组装布局中都从编译后的 dist 解析）。
  try {
    materializeBuiltinPolicyReference({
      bundledDir: nodePath.resolve(import.meta.dirname, "../policies/builtin"),
      targetDir: getDefaultOpenRigPath(nodePath.join("reference", "policies", "builtin")),
    });
  } catch { /* 尽力而为——检查副本不影响后台服务运行 */ }

  // PL-004 阶段 C——看守器策略引擎与调度器。在 deps 构造后于此接线，使引擎可通过
  // 实时 SessionTransport 投递。index.ts 在 listen() 后启动调度器，确保首次 tick 前
  // 后台服务 HTTP 表面已就绪。PL-004 阶段 D——工作流运行时与 workflow-keepalive 策略。
  // 先构造工作流运行时，再通过 additionalPolicies 向看守器策略引擎注入 workflow-keepalive
  //（按 slice IMPL 的 Write Set / Driver Handoff Contract，这是编排方批准的阶段 D 扩展点）。
  const queueRepoForWorkflow = deps.queueRepo;
  let workflowRuntime: WorkflowRuntime | undefined;
  let workflowExceptionEnsurer:
    | import("./domain/workflow-exception-escalation.js").EnsureStuckExceptionItem
    | undefined;
  if (queueRepoForWorkflow) {
    workflowRuntime = new WorkflowRuntime({
      guidanceLibrary: contextPackLibrary,
      db,
      eventBus,
      queueRepo: queueRepoForWorkflow,
      // OPR.0.4.6.WF1 FR-3：实例化/交接在事务内自动武装逐实例 workflow-keepalive 任务；终态解除武装。
      watchdogJobsRepo: watchdogJobsRepoInstance,
      // OPR.0.4.6.WF5 FR-2：成熟度旋钮——每次异常都实时读取设置镜像中的主机默认值；
      // 旋钮变化只影响未来条目，绝不追溯重路由。
      exceptionDial: {
        hostDefault: () => {
          const v = new ContextPackSettingsStore().resolveOne("workflow.exception_routing")
            .value as string | undefined;
          return v === "orchestrator" || v === "human_only" ? v : null;
        },
        humanFallbackSeat: resolveWorkflowHumanDestination,
      },
    });
    deps.workflowRuntime = workflowRuntime;

    // OPR.0.4.6.WF5 FR-2 类别 (b)：共享的检测时异常确保器；扫描与 keepalive 均调用，
    // 并按发生标签去重。
    {
      const { makeEnsureStuckExceptionItem } = await import(
        "./domain/workflow-exception-escalation.js"
      );
      workflowExceptionEnsurer = makeEnsureStuckExceptionItem({
        db,
        queueRepo: queueRepoForWorkflow,
        resolveRoute: (name, version, cls, boundRig) =>
          workflowRuntime!.resolveExceptionRouteFor(name, version, cls, boundRig),
        humanFallbackSeat: resolveWorkflowHumanDestination,
        log: (line) => console.log(line),
      });
    }

    // 把内置 starter workflow_specs 注入缓存。操作幂等且尊重工作区表面；保留工作区路径中的
    // 操作员覆盖（已缓存则跳过）。错误收集到结果中用于诊断日志，但不阻止启动；
    // 损坏的随附规范不应拖垮后台服务。
    const { loadStarterWorkflowSpecs, defaultBuiltinSpecsDir } = await import(
      "./domain/workflow/starter-spec-loader.js"
    );
    const builtinSpecsDir = defaultBuiltinSpecsDir();
    const starterResult = loadStarterWorkflowSpecs({
      cache: workflowRuntime.specCache,
      builtinDir: builtinSpecsDir,
    });
    // 将解析后的路径暴露给路由层，使 GET /api/workflow/specs 能计算逐行 isBuiltIn 标志。
    deps.workflowBuiltinSpecsDir = builtinSpecsDir;

    // Slice 11（workflow-spec-folder-discovery）——暴露共享 WorkflowSpecCache 与解析后的
    // 工作区 workflows 目录，使 GET /api/specs/library 每次列表请求都能择机发现操作员放入的
    // YAML。目录为 `<workspace.specs_root>/workflows`；SettingsStore 按
    // env > config > workspace-default 解析 workspaceSpecsRoot。
    deps.workflowSpecCache = workflowRuntime.specCache;

    // OPR.0.3.2.22 Bug 4——一次性清理 source_path 位于噪声目录（.worktrees、
    // node_modules 等）的缓存行。Bug 4 后的 walkYamlFiles SKIP_DIRS 守卫会阻止新行
    // 来自这些位置；但若无此清理，旧版后台服务遗留的行（或 SKIP_DIRS 发布前由操作员
    // 通过路径形式手动导入的规范）会继续存在。该操作成本低（单条带有界 LIKE 模式的 DELETE）
    // 且安全（只匹配 walker 现在拒绝进入的相同目录）。
    //
    // installRoot 守卫：生产环境随附的内置工作流规范位于
    // `<pkg>/dist/builtins/workflow-specs/`。若没有安装根保留条款，`%/dist/%` 模式会
    // 每次启动都删除它们，随后再由 loadStarterWorkflowSpecs 重建；轻则浪费，若加载器
    // 某次跳过重建则会损坏。传入解析后的安装根，保留其下的行。
    const { getOpenRigInstallRoot } = await import("./domain/cwd-resolution.js");
    workflowRuntime.specCache.pruneNoiseDirRows(getOpenRigInstallRoot());

    try {
      const settingsStore = new ContextPackSettingsStore();
      const cfg = settingsStore.resolveConfig();
      if (cfg.workspaceSpecsRoot) {
        deps.workflowsFolderDir = nodePath.join(cfg.workspaceSpecsRoot, "workflows");
      }
    } catch { /* 设置不可用——目录扫描保持禁用 */ }

    if (starterResult.errors.length > 0) {
      console.warn(
        `[starter-spec-loader] ${starterResult.errors.length} 个规范加载失败：`,
        starterResult.errors,
      );
    }
  }

  // PL-005 阶段 A：任务控制 / 队列可观测性服务。在 WorkflowRuntime 之后接线，
  // 使所有由 PL-004 后台服务支撑的协调表面都可用。任务控制从 queue/view/stream
  // 表面读取，并通过原子的 7 动词契约写入。
  if (deps.queueRepo && deps.viewProjector) {
    const mcActionLog = new MissionControlActionLog(db);
    const mcWriteContract = new MissionControlWriteContract({
      db,
      eventBus,
      queueRepo: deps.queueRepo,
      actionLog: mcActionLog,
    });
    const mcFleetCliCapability = new MissionControlFleetCliCapability({
      db,
      eventBus,
      rigRepo,
      // 按守卫 PL-005 阶段 A 评审的 R1 修复：接入生产能力探针，使
      // /api/mission-control/cli-capabilities 在本地 CLI 白名单缺失
      // MISSION_CONTROL_DESIRED_FIELDS 时如实报告漂移。若不注入该探针，生产路径会
      // 默认使用空操作，即使存在审计第 5 行情形（recoveryGuidance 不在 CLI 白名单中），
      // 也总是报告 staleCliCount=0。
      probeRig: makeLocalCliCapabilityProbe(),
    });
    // V0.3.1 slice 05 kernel-rig-as-default——把解析后的 workspace.operator_seat_name
    // 设置级联到任务控制读取层，使 my-queue 路由到操作员配置的席位
    //（默认 `operator-${USER}@kernel`），而非旧硬编码常量。该设置依次读取
    // OPENRIG_WORKSPACE_OPERATOR_SEAT_NAME 环境变量、~/.openrig/config.json 和派生默认值，
    // 与其他类型化设置使用相同级联。
    const mcReadLayer = new MissionControlReadLayer({
      db,
      queueRepo: deps.queueRepo,
      viewProjector: deps.viewProjector,
      streamStore: deps.streamStore,
      fleetCliCapability: mcFleetCliCapability,
      defaultOperatorSession: runtimeSettings.workspaceOperatorSeatName,
    });
    deps.missionControlActionLog = mcActionLog;
    deps.missionControlWriteContract = mcWriteContract;
    deps.missionControlFleetCliCapability = mcFleetCliCapability;
    deps.missionControlReadLayer = mcReadLayer;

    // PL-005 阶段 B：审计历史浏览层（只读）、通知分发器与 bearer-token 接线。
    const mcAuditBrowse = new MissionControlAuditBrowse(db);
    deps.missionControlAuditBrowse = mcAuditBrowse;

    // 将 createDaemon 选项中的 bearer token 通过 deps 传给路由构造器，
    // 使鉴权中间件在挂载路由时安装，而不是逐请求安装。
    deps.missionControlBearerToken = opts?.bearerToken ?? null;

    const terminalTokenEnv = process.env.OPENRIG_TERMINAL_BEARER_TOKEN?.trim();
    deps.terminalBearerToken =
      opts && Object.prototype.hasOwnProperty.call(opts, "terminalBearerToken")
        ? opts.terminalBearerToken ?? null
        : terminalTokenEnv || null;

    // 通知分发器：通过环境配置选择机制。
    // OPENRIG_NOTIFICATIONS_MECHANISM=ntfy|webhook|none（默认 none）。
    // OPENRIG_NOTIFICATIONS_TARGET=<主题 URL | webhook URL>。
    // 设置 OPENRIG_NOTIFICATIONS_INCLUDE_VERB_COMPLETION=1 可选择启用
    // verb-completion 触发器（默认关闭；按规划简报，默认只有 human-gate 到达会触发）。
    // 这些环境变量在阶段 B 新增，没有旧版别名。
    const mechanism = process.env.OPENRIG_NOTIFICATIONS_MECHANISM ?? "none";
    const target = process.env.OPENRIG_NOTIFICATIONS_TARGET ?? "";
    const missionControlBaseUrl =
      process.env.OPENRIG_MISSION_CONTROL_BASE_URL ??
      process.env.OPENRIG_URL ??
      process.env.RIGGED_URL;
    const includeVerbCompletion =
      process.env.OPENRIG_NOTIFICATIONS_INCLUDE_VERB_COMPLETION === "1";
    if (mechanism !== "none" && target.length > 0) {
      let adapter: NotificationAdapter;
      if (mechanism === "ntfy") {
        adapter = new NtfyNotificationAdapter({ topicUrl: target });
      } else if (mechanism === "webhook") {
        adapter = new WebhookNotificationAdapter({ endpointUrl: target });
      } else {
        throw new Error(
          `无法识别 OPENRIG_NOTIFICATIONS_MECHANISM='${mechanism}'；支持：ntfy | webhook | none`,
        );
      }
      const dispatcher = new MissionControlNotificationDispatcher({
        db,
        eventBus,
        adapter,
        includeVerbCompletion,
        missionControlBaseUrl,
      });
      dispatcher.start();
      deps.missionControlNotificationDispatcher = dispatcher;
    }
  }

  // Slice Story View v0——slice 索引器与逐标签页投影器。
  //
  // User Settings v0 将 `OPENRIG_SLICES_ROOT` 环境变量提升为类型化设置
  // `workspace.slices_root`（解析链：环境变量 > 配置文件 > 默认
  // `<workspace.root>/missions`）。为保持向后兼容，已设置 OPENRIG_SLICES_ROOT
  // 的操作员仍可照常使用，因为设置存储会在同一解析层级读取环境变量。现在，通过
  // `zrig config set workspace.slices_root <path>` 或系统抽屉的“设置”面板配置后，
  // 数据也会进入索引器，从而补齐 v0 未接线的 PRD § Scenario B 要求。
  //
  //   OPENRIG_SLICES_ROOT             旧版短环境变量（若已设置仍然生效；建议改用设置）
  //   OPENRIG_WORKSPACE_SLICES_ROOT   类型化键的环境变量覆盖值
  //   workspace.slices_root           ~/.openrig/config.json 中的类型化设置
  //   workspace.root                  级联回退值（默认 ~/.openrig/workspace）
  //   OPENRIG_DOGFOOD_EVIDENCE_ROOT   旧版证明包迁移位置覆盖值
  //
  // 当解析出的 slicesRoot 路径在磁盘上不存在时，仍会构造索引器，但 isReady() 返回 false；
  // 路由会返回明确的 "slices_root_not_configured" 503 和设置提示。
  {
    // 若显式设置了旧版短环境变量，则优先使用它（现有 dogfood/测试后台服务依赖此行为）。
    // 否则回退到设置解析出的路径（SettingsStore 内部按环境变量 > 文件 > 默认值级联）。
    // SettingsStore 在此局部构造，使 slices 代码块不依赖下方 User Settings v0 接线块的顺序。
    const legacyEnvSlicesRoot = readOpenRigEnv("OPENRIG_SLICES_ROOT", "RIGGED_SLICES_ROOT") ?? "";
    let resolvedSlicesRoot = "";
    let resolvedWorkspaceRoot = "";
    try {
      const { SettingsStore: SettingsStoreCtor } = await import("./domain/user-settings/settings-store.js");
      const resolvedConfig = new SettingsStoreCtor().resolveConfig();
      if (!legacyEnvSlicesRoot) {
        resolvedSlicesRoot = resolvedConfig.workspaceSlicesRoot;
      }
      resolvedWorkspaceRoot = resolvedConfig.workspaceRoot;
    } catch {
      // SettingsStore 不可用——保持根目录为空，由路由返回 503。
    }
    const slicesRoot = legacyEnvSlicesRoot || resolvedSlicesRoot;
    // `workspace.dogfood_evidence_root` 已随旧版预创建脚手架退役。继续让现有证明包读取器
    // 支持旧工作区和显式旧版迁移位置，但不再暴露第二个项目工作区设置。
    const resolvedDogfoodRoot = readOpenRigEnv("OPENRIG_DOGFOOD_EVIDENCE_ROOT")
      || (resolvedWorkspaceRoot ? nodePath.join(resolvedWorkspaceRoot, "dogfood-evidence") : "");
    const additionalSliceRoots = resolvedWorkspaceRoot
      ? [
          nodePath.join(resolvedWorkspaceRoot, "missions"),
          nodePath.join(resolvedWorkspaceRoot, "slices"),
        ].filter((root) => root !== slicesRoot)
      : [];
    // S27（OPR.0.5.6.27）——解析 slices 根目录后接入执行视图；thunk 不会重新读取任何内容
    //（路径解析仍由启动过程负责）。
    viewProjectorInstance.setExecutionDeps({
      db,
      slicesRoot: () => slicesRoot || null,
      // S19 锁定的单一判定源契约：所有表面（rig ps、节点清单、parked-query）都消费这份
      // 以席位为键的 ARBITRATED 读数；绝不读取 sessions.status，也绝不使用并行的
      // AgentActivityStore 摄取通道。
      seatActivity: seatActivityService,
    });
    const { SliceIndexer } = await import("./domain/slices/slice-indexer.js");
    const { SliceDetailProjector } = await import("./domain/slices/slice-detail-projector.js");
    const sliceIndexer = new SliceIndexer({
      slicesRoot,
      additionalSliceRoots,
      dogfoodEvidenceRoot: resolvedDogfoodRoot || null,
      db,
    });
    // Slice Story View v1：传入 workflowRuntime.specCache，使投影器能够解析已绑定
    // workflow_instance 的规范，用于 spec-graph、phase 和 current-step 投影。若未构造
    // 工作流运行时（queueRepo 缺失——上方 workflowRuntime 块使用同一条件守卫），
    // 投影器会静默降级为 v0 行为（workflowBinding=null、specGraph=null、
    // phaseDefinitions=null、currentStep=null）。
    const sliceDetailProjector = new SliceDetailProjector({
      db,
      indexer: sliceIndexer,
      workflowSpecCache: workflowRuntime?.specCache,
    });
    deps.sliceIndexer = sliceIndexer;
    if (sliceIndexer.isReady()) {
      const { watchProofSources } = await import("./domain/proof/source-watch.js");
      deps.proofSourceWatch = watchProofSources(sliceIndexer.slicesRoot, () => sliceIndexer.invalidate(), eventBus);
    }
    deps.sliceDetailProjector = sliceDetailProjector;
    // Living Notes Packet 2（OPR.0.4.4.20）：组合评审收集器。设置
    // OPENRIG_REVIEW_GIT_REPO 时从中读取 Git 血缘事实；否则如实降级为未知。
    const { ReviewGatherer } = await import("./domain/review/gather.js");
    deps.reviewGatherer = new ReviewGatherer({
      db,
      indexer: sliceIndexer,
      gitRepoPath: process.env["OPENRIG_REVIEW_GIT_REPO"] ?? null,
      // OPR.0.4.4.22 FR-2：智能体状态图标读取已记录的钩子活动；缺失时如实显示未知。
      // 此过程同步执行，绝不轮询。
      activityStore: agentActivityStore,
    });
  }

  // OPR.0.4.6.02 C3——terminal-provider-ride 服务（所有视图类型共用一个组合器）。
  // 在此处后置构造，使其能为派生的 mission/slice 视图读取延迟构建的 reviewGatherer；
  // 若收集器从未构建，这些工作范围会如实返回 not-found，而不是抛错。
  {
    const { TerminalService } = await import("./domain/terminal/terminal-service.js");
    const { HerdrAdapter } = await import("./domain/terminal/herdr-adapter.js");
    const { createHerdrSocketRpc, createHerdrSocketTransport } = await import(
      "./domain/terminal/herdr-transport.js"
    );
    const { CmuxProviderAdapter } = await import("./domain/terminal/cmux-provider-adapter.js");
    const { CmuxLayoutService } = await import("./domain/cmux-layout-service.js");
    const { TerminalViewsStore } = await import("./domain/terminal/terminal-views-store.js");
    const { getNodeInventory, getNodeInventoryForRigs } = await import("./domain/node-inventory.js");
    const { loadHostRegistry, resolveHost: resolveHostInRegistry } = await import(
      "./domain/hosts/hosts-registry-reader.js"
    );

    // NodeInventoryEntry → 组合器所需的最小 LiveSeatRow（单主机清单：规范会话名就是
    // tmux 会话名，不含 host 字段）。
    const toLiveSeatRow = (e: {
      canonicalSessionName: string | null;
      attachmentType?: "tmux" | "external_cli" | null;
      rigName: string;
      logicalId: string;
    }) => ({
      canonicalSessionName: e.canonicalSessionName,
      attachmentType: e.attachmentType ?? null,
      tmuxSession: e.canonicalSessionName,
      rigName: e.rigName,
      logicalId: e.logicalId,
    });

    const herdrProvider = new HerdrAdapter({
      // FB4：herdr 通过 Unix 控制 socket 通信（不存在 `layout` CLI）。
      transportFactory: createHerdrSocketTransport(createHerdrSocketRpc()),
    });
    const cmuxProvider = new CmuxProviderAdapter({
      cmuxAdapter,
      // 每个组合页面只使用一个网格化工作区——与工作组工作范围的 /cmux/launch 端点
      // 复用同一网格机制，绝不为每个席位单独创建窗口。
      layoutService: new CmuxLayoutService(cmuxAdapter),
    });
    const providerMap: Record<string, typeof herdrProvider | typeof cmuxProvider> = {
      herdr: herdrProvider,
      cmux: cmuxProvider,
    };

    deps.terminalService = new TerminalService({
      resolveProvider: (name) => providerMap[name] ?? null,
      viewsStore: new TerminalViewsStore(),
      listRigSeatsBatch: (names) => {
        const rigs = rigRepo.listRigs();
        // 与 listRigSeats 的首个名称解析规则一致，包括重名情况。
        const selected = new Map(names.flatMap(name => {
          const rig = rigs.find(rig => rig.name === name);
          return rig ? [[name, rig] as const] : [];
        }));
        const inventory = getNodeInventoryForRigs(db, new Set([...selected.values()].map(rig => rig.id)));
        return new Map([...selected].map(([name, rig]) => [name, (inventory.get(rig.id) ?? []).map(toLiveSeatRow)]));
      },
      listRigSeats: (rigArg) => {
        const rigs = rigRepo.listRigs();
        const rig = rigs.find((r) => r.name === rigArg) ?? rigs.find((r) => r.id === rigArg);
        if (!rig) return null;
        return getNodeInventory(db, rig.id).map(toLiveSeatRow);
      },
      listPodSeats: (rigArg, pod) => {
        const rigs = rigRepo.listRigs();
        const rig = rigs.find((r) => r.name === rigArg) ?? rigs.find((r) => r.id === rigArg);
        if (!rig) return null;
        const rows = getNodeInventory(db, rig.id)
          .filter((e) => e.podNamespace === pod)
          .map(toLiveSeatRow);
        // 没有节点携带该 pod 命名空间时，表示 pod 未知，而不是空视图。
        return rows.length > 0 ? rows : null;
      },
      listScopeSeats: (scope) => {
        const gatherer = deps.reviewGatherer;
        if (!gatherer) return null;
        // N1（dev44-driver2 前置守卫）：转换为真实的 AgentsScope 联合类型（而非 `never`），
        // 从而恢复工作范围语法的编译期守卫。
        const band = gatherer.composeAgents(scope as import("./domain/review/types.js").AgentsScope);
        if (!band) return null;
        const wanted = new Set(band.rows.map((r) => r.sessionName));
        const rows: ReturnType<typeof toLiveSeatRow>[] = [];
        for (const rig of rigRepo.listRigs()) {
          for (const e of getNodeInventory(db, rig.id)) {
            if (e.canonicalSessionName && wanted.has(e.canonicalSessionName)) rows.push(toLiveSeatRow(e));
          }
        }
        return rows;
      },
      listRigNames: () => rigRepo.listRigs().map((r) => r.name),
      resolveHost: (id) => {
        const res = loadHostRegistry();
        if (!res.ok) return null;
        const r = resolveHostInRegistry(res.registry, id);
        return r.ok ? r.host : null;
      },
      hasSession: (session) => tmuxAdapter.hasSession(session),
    });
  }

  // UI 增强包 v0：
  //   - 从 OPENRIG_FILES_ALLOWLIST 读取文件白名单（第 3 项）
  //   - 仅在白名单非空时接入原子写入服务（第 4 项）
  //   - 从 OPENRIG_PROGRESS_SCAN_ROOTS 读取进度扫描根目录（第 1B 项）
  //
  // 环境变量为空时得到空白名单/无根目录索引器；路由返回带结构化配置提示的 503，
  // 使 UI 能显示设置说明，而不是笼统错误。
  {
    const { decodeAllowlist } = await import("./domain/files/path-safety.js");
    const { FileWriteService } = await import("./domain/files/file-write-service.js");
    const { ProgressIndexer, decodeProgressScanRoots } = await import("./domain/progress/progress-indexer.js");
    // User Settings v0——UEP 环境变量已提升为类型化设置。解析顺序：环境变量 > 设置文件 > 空。
    // SettingsStore 负责环境变量 > 文件 > 默认值的优先级；此处只把原始字符串解码为结构化根目录。
    const { SettingsStore } = await import("./domain/user-settings/settings-store.js");
    const settingsStore = new SettingsStore();
    deps.settingsStore = settingsStore;
    const cfg = settingsStore.resolveConfig();

    // Preview Terminal v0（PL-018）——/preview 路由的逐会话限速器。每个
    // (session, lines) 缓存键使用 1 秒窗口：窗口足够短，按操作员刷新间隔
    //（`ui.preview.refresh_interval_seconds`，默认 3 秒）进行的正常轮询总能看到新内容；
    // 同一秒内针对同一席位的多个固定窗格请求则会合并为一次 tmux 捕获。
    const { PreviewRateLimiter } = await import("./domain/preview/preview-rate-limiter.js");
    deps.previewRateLimiter = new PreviewRateLimiter(1000);
    const filesAllowlist = decodeAllowlist(cfg.filesAllowlistRaw);
    deps.filesAllowlist = filesAllowlist;
    deps.fileWriteService = filesAllowlist.length > 0
      ? new FileWriteService({
          allowlist: filesAllowlist,
          auditFilePath: nodePath.join(OPENRIG_HOME, "file-edit-audit.jsonl"),
        })
      : null;
    // Slice 28 检查点 C-3——SkillLibraryDiscoveryService。sharedSkillsDir 通过
    // import.meta.url 解析到后台服务随附的 `specs/agents/shared/skills/` 目录，与操作员白名单
    // 配置无关；这补齐了 founder-walk VM 上的 HG-5，因为其操作员白名单不含后台服务源码树。
    // 同时传入 filesAllowlist，使工作区 `.openrig/skills/` 中的技能也通过同一后台服务端点呈现。
    deps.skillLibraryDiscoveryService = new SkillLibraryDiscoveryService({
      sharedSkillsDir: nodePath.resolve(
        nodePath.dirname(new URL(import.meta.url).pathname),
        "..",
        "specs",
        "agents",
        "shared",
        "skills",
      ),
      filesAllowlist,
    });
    deps.progressIndexer = new ProgressIndexer({ roots: decodeProgressScanRoots(cfg.progressScanRootsRaw) });

    // Operator Surface Reconciliation v0——引导内容组合器（第 1 项）。默认读取类型化工作区设置，
    // 同时为非规范布局保留 OPENRIG_STEERING_* 环境变量覆盖族。
    const { SteeringComposer, steeringOptsFromSettings } = await import("./domain/steering/steering-composer.js");
    deps.steeringComposer = new SteeringComposer(steeringOptsFromSettings({
      workspaceRoot: cfg.workspaceRoot,
      workspaceSteeringPath: cfg.workspaceSteeringPath,
    }));

    // Workflows in Spec Library + Activation Lens v0——活动透镜状态持久化到
    // OPENRIG_HOME/active-workflow-lens.json。它与 UI Enhancement Pack v0 的审计 JSONL
    // 使用相同的文件后端模式，并尊重 OPENRIG_HOME，使隔离的测试/dogfood 后台服务各自保存
    // 透镜状态，不会污染操作员主机。
    const { ActiveLensStore } = await import("./domain/active-lens-store.js");
    deps.activeLensStore = new ActiveLensStore({
      filePath: nodePath.join(OPENRIG_HOME, "active-workflow-lens.json"),
    });
  }

  // OPR.0.5.6.1——投递策略使用延迟绑定的 gateway 分派。gateway 子系统在看守器引擎之后
  // 构造，该引用会在下方激活时填充；激活位置位于 sessionTransport 块之外，因此引用声明在
  // 函数作用域。注册表通过随附加载器读取。
  const lateGatewayDispatch: { fn?: (op: string, ref: string, payload: unknown, opts?: { decisionId?: string }) => { ok: boolean; error?: string } } = {};
  const { loadHumanRegistry: loadHumanRegistryForDelivery } = await import("./domain/gateway/human-registry.js");
  void loadHumanRegistryForDelivery; // 由下方 sessionTransport 块使用

  const sessionTransport = deps.sessionTransport;
  if (sessionTransport) {
    queueRepoInstance.attachActivityReader((session) => {
      const node = db.prepare("SELECT node_id FROM sessions WHERE session_name = ? ORDER BY id DESC LIMIT 1").get(session) as { node_id: string } | undefined;
      return node ? seatActivityService.getSeatState(node.node_id) : null;
    });
    const watchdogPolicyEngine = new WatchdogPolicyEngine({
      jobsRepo: watchdogJobsRepoInstance,
      historyLog: watchdogHistoryLogInstance,
      eventBus,
      deliver: async ({ targetSession, message, continuityAction }, source) => {
        let continuityActionCompleted = false;
        try {
          if (continuityAction) {
            await createContinuityCutoverBaton(continuityAction, queueRepoInstance);
            continuityActionCompleted = true;
          }
          const deliveryId = `guard-watchdog-${source.occurrenceId ?? source.jobId}`;
          const previous = outboxHandlerInstance.getById(deliveryId);
          const payload = previous?.guardBinding ? previous.body : formatWatchdogDeliveryMessage(source, message);
          const result = await sessionTransport.send(targetSession, payload,
            { deliveryId, actorSession: "watchdog@system", auditPointer: source.jobId });
          if (result.outcome === "retained") return { status: "retained", outboxIds: result.outboxIds, continuityActionCompleted };
          return result.ok
            ? { status: "ok", continuityActionCompleted }
            : { status: "failed", error: result.error, continuityActionCompleted };
        } catch (err) {
          return {
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
            continuityActionCompleted,
          };
        }
      },
      // (i-c) 触发时的目标代数门禁：解析目标的实时占位者代数（P12 occupant_tenures），
      // 使目标完成交接后，绑定旧代数的唤醒会被拒绝。UNKNOWN（null）采用开放式失败并继续投递。
      // 删除此行会静默禁用门禁，使代数绑定唤醒误发给后继；
      // watchdog-target-gen-wiring.test.ts 已锁定这条接线。
      resolveTargetGeneration: (s) => sessionRegistry.currentOccupantGenerationForSession(s),
      resolvePreDeliveryTerminalReason: ({ jobId }) =>
        queueRepoInstance.resolveWatchdogPreDeliveryTerminalReason(jobId),
      resolveQueueWait: (input) => queueRepoInstance.evaluateWaitReminder(input),
      onWakeAttempt: ({ jobId, deliveryStatus }) => {
        queueRepoInstance.recordWatchdogWakeAttempt(jobId, deliveryStatus);
      },
      // PL-004 阶段 D：在阶段 C 的三个内置策略旁注册 workflow-keepalive 策略。
      // workflow-keepalive 通过新增的阶段 D 表直接读取 SQLite workflow_instances
      //（审计第 18 行：仅以 SQLite 为来源，不读取 Markdown）。
      // OPR.0.4.3.16：注册 idle-gate-qitem——把待处理的 gate:* qitem（queue_items）与
      // 公共表面展示的共享仲裁活动裁决合并成一次有界唤醒。只做唤醒/标记；冷却由引擎节流负责。
      additionalPolicies: [
        makeWorkflowKeepalivePolicy({
          db,
          // OPR.0.4.6.WF5 FR-2 类别 (b)：检测时异常条目，按发生实例去重；旋钮通过运行时
          // 缓存的规范解析（registered-human 选择在辅助函数内完成）。
          ensureStuckExceptionItem: workflowExceptionEnsurer,
          reconcileStuckExceptions: (id) => workflowRuntime?.reconcileStuckExceptions(id) ?? 0,
        }),
        makeIdleGateQitemPolicy({ db, seatActivity: seatActivityService }),
        // OPR.0.5.6.24 F-14：parked-owner 消费者——由一个工作组级监管任务消费完整的随附
        // 停滞诊断（diagnoseRigParked 基于仲裁判定源、目标范围义务和唤醒状态；与
        // `rig parked` 使用同一推导）。回合回执是义务行上的 TRANSITIONS，按先预留后投递写入
        //（保留活动前沿不变量即持久性证明）；看守器历史仅用于遥测。
        makeParkedOwnerConsumerPolicy({
          diagnoseRig: (rigName) => {
            const seats = db
              .prepare(
                `SELECT n.id AS node_id, s.session_name AS session_name
                   FROM nodes n
                   JOIN rigs r ON r.id = n.rig_id
                   JOIN sessions s ON s.node_id = n.id
                    AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
                  WHERE s.status = 'running' AND s.session_name IS NOT NULL AND r.name = ?`,
              )
              .all(rigName) as Array<{ node_id: string; session_name: string }>;
            const parkedDeps = {
              getSeatState: (seatNodeId: string) => seatActivityService.getSeatState(seatNodeId),
              listOpenObligations: (destinationSession: string, limit: number) => ({
                rows: queueRepoInstance
                  .list({ destinationSession, state: ["pending", "in-progress", "blocked"], limit })
                  .map((r) => ({
                    qitemId: r.qitemId,
                    state: r.state as "pending" | "in-progress" | "blocked",
                    summary: r.summary ?? null,
                  })),
                limit,
              }),
              getParkWake: (qitemId: string) => queueRepoInstance.getParkWakeStatus(qitemId),
            };
            return diagnoseRigParked(
              parkedDeps,
              seats.map((s) => ({ seatNodeId: s.node_id, sessionName: s.session_name })),
            ) as never;
          },
          history: {
            listForJob: (jobId, limit) => watchdogHistoryLogInstance.listForJob(jobId, limit),
            countForJob: (jobId) => watchdogHistoryLogInstance.countForJob(jobId),
          },
          // R2 修复：行侧持久表面。回执是义务行上的状态转换（先预留后投递）；失败写入
          // 阶梯原生的 last_nudge_result 词汇。
          rows: {
            recoveryOwnsWake: (qitemId) => queueRecoveryOwnsWake(db, queueRepoInstance.getById(qitemId)),
            listTransitions: (qitemId: string) =>
              queueRepoInstance
                .listTransitions(qitemId)
                .map((t) => ({ ts: t.ts, transitionNote: t.transitionNote ?? null })),
            appendNote: (qitemId: string, note: string) => {
              const row = queueRepoInstance.getById(qitemId);
              if (!row || !isBlockerLive(row.state)) return { ok: false };
              queueRepoInstance.update({
                qitemId,
                actorSession: "watchdog@system",
                transitionNote: note,
              });
              return { ok: true };
            },
            recordNudgeResult: (qitemId: string, result: string) =>
              queueRepoInstance.recordNudgeAttempt(qitemId, result),
            listOpenIds: (destinationSession: string) =>
              queueRepoInstance
                .list({ destinationSession, state: ["pending", "in-progress", "blocked"], limit: 500 })
                .map((r) => r.qitemId),
          },
        }),
        // OPR.0.5.6.1 AM-F1——投递引擎在此基础上的两个计时分支。gateway 分派采用延迟绑定
        //（子系统在本引擎之后构建）：下方引用会在 gateway 激活时填充。
        (await import("./domain/policies/delivery-deferral.js")).makeDeliveryDeferralPolicy({
          jobsRepo: watchdogJobsRepoInstance,
          queueRepo: queueRepoInstance,
          deliverInterrupt: async (qitemId: string, notificationKey: string) => {
            const dispatch = lateGatewayDispatch.fn;
            const row = queueRepoInstance.getById(qitemId);
            if (!dispatch || !row) return { ok: false };
            // R2/R1 B-1+B-3：使用已声明的操作、共享 payload 构建器，并让 EPISODE 键
            // 一路传递到 Slice 14 回执。
            const { buildDeferralFirePayload } = await import("./domain/gateway/operator-delivery-engine.js");
            const { OUTBOUND_OP } = await import("./domain/gateway/slack/outbound-driver.js");
            const payload = buildDeferralFirePayload(row, notificationKey);
            // v3：持久且回合稳定的标识——重放与再次分派会收敛。
            const res = dispatch(OUTBOUND_OP, String(payload["destinationSession"] ?? ""), payload, { decisionId: `deferral:${notificationKey}` });
            return { ok: res.ok };
          },
        }),
        (await import("./domain/policies/delivery-digest-flush.js")).makeDeliveryDigestFlushPolicy({
          queueRepo: queueRepoInstance,
          registry: { loadHumanRegistry: (home: string) => loadHumanRegistryForDelivery(home) },
          home: OPENRIG_HOME,
          // v3：摘要使用稳定 decision id 经由 gateway 发布——统一传输、统一重驱动/协调机制，
          // 并在事实成立后写入回执。
          dispatch: (op: string, ref: string, payload: unknown, opts?: { decisionId?: string }) => {
            const fn = lateGatewayDispatch.fn;
            if (!fn) return { ok: false, error: "gateway 尚未激活" };
            return fn(op, ref, payload, opts);
          },
        }),
      ],
    });
    queueRepoInstance.startWaitReminders();
    const watchdogScheduler = new WatchdogScheduler({
      jobsRepo: watchdogJobsRepoInstance,
      policyEngine: watchdogPolicyEngine,
      beforeTick: () => queueRepoInstance.reconcileWaitReminders(),
    });
    deps.watchdogPolicyEngine = watchdogPolicyEngine;
    deps.watchdogScheduler = watchdogScheduler;

    // OPR.0.5.6.24 F-14——每个工作组恰有一个 parked-owner 监管任务（迷你要求 1）：
    // 按 (policy, target_session) 元组幂等确保；锚点为
    // `parked-owner-consumer@<rigName>`（member@rig 形态，以策略名作为成员 slug）。
    // activeWakeIntervalSeconds 保持 NULL，避免某席位触发后引擎节流另一席位的唤醒；
    // 逐席位去重由持久回合回执承担。启动后新建的工作组天生已武装：下方接线的
    // rigRepo.onRigCreated 会在创建动作本身执行同一 ensure，无需等待重启或观察器。
    {
      const ensureParkedOwnerJob = (rigName: string) => {
        const anchor = makeRigAnchor(rigName);
        watchdogJobsRepoInstance.ensureAutoRegistration({
          policy: PARKED_OWNER_POLICY_NAME,
          targetSession: anchor,
          registeredBySession: "daemon@kernel",
          intervalSeconds: 120,
          activeWakeIntervalSeconds: null,
          scanIntervalSeconds: null,
          specYaml: `policy: ${PARKED_OWNER_POLICY_NAME}\ntarget:\n  session: ${anchor}\ncontext:\n  rig: ${rigName}\n`,
        });
      };
      const rigRows = db.prepare("SELECT name FROM rigs ORDER BY name").all() as Array<{ name: string }>;
      for (const r of rigRows) ensureParkedOwnerJob(r.name);
      // R2 修复——天生已武装（顾问裁决）：启动后新建的工作组会在同一创建动作中获得
      // 监管任务，绝不推迟到下次后台服务重启。
      rigRepo.onRigCreated = (rig) => ensureParkedOwnerJob(rig.name);
    }

    // OPR.0.5.6.1——两个摘要窗口均实现为幂等看守器任务（AM-F1：刷新使用同一命名基础；
    // 借助同一 SQLite 调度在重启后保持；若后台服务跨越一个窗口停机，则在下一 tick 刷新）。
    {
      const ensureDigestJob = (window: "4h" | "daily", intervalSeconds: number) => {
        watchdogJobsRepoInstance.ensureAutoRegistration({
          policy: "delivery-digest-flush",
          targetSession: `delivery-digest-${window}@kernel`,
          registeredBySession: "daemon@kernel",
          intervalSeconds,
          activeWakeIntervalSeconds: null,
          scanIntervalSeconds: null,
          specYaml: `policy: delivery-digest-flush\ntarget:\n  session: delivery-digest-${window}@kernel\ncontext:\n  window: ${window}\n`,
        });
      };
      ensureDigestJob("4h", 4 * 60 * 60);
      ensureDigestJob("daily", 24 * 60 * 60);
    }

    // B8 / slice-07 A3——模型分歧监视器：在各运行时最早可靠的读取点，对有效模型与固定模型
    // 做不依赖原因的比较；每个占位者代数只生成一次裁决；发现分歧时通过四个渠道高声公告
    //（编排席位、操作员、监督席位，以及 DS2 指定的 Slack 延迟投递）。渠道目标遵循
    // 2026-08-21 桌面裁决：orch = 席位所属工作组的 orch.* 席位；operator 从
    // workspace.operator_seat_name 派生，绝不硬编码；oversight = 全局判断席位，可在本地解析，
    // 否则生成具名延迟项（当前尚无后台服务侧跨主机发送接缝，因此必须明确延迟，绝不静默）。
    {
      const { ModelDivergenceMonitor } = await import("./domain/model-divergence/model-divergence-monitor.js");
      const { readClaudeEffectiveModel, readCodexEffectiveModel } = await import("./domain/model-divergence/effective-model-readers.js");
      const { resolveIdentityVerifiedClaudeRecord, resolveLiveCodexThreadId } = await import("./domain/model-divergence/current-generation-record.js");
      const { defaultListProcesses } = await import("./domain/resume-metadata-refresher.js");
      const { readCodexThreadIdFromCandidateHomes, defaultResolveHomeDirByPid } = await import("./domain/codex-thread-id.js");
      const nodeOs = await import("node:os");
      const nodeFs = await import("node:fs");
      const seatIdentityStore = new SeatIdentityStore(db);
      // OPR.0.5.3.10——整个分歧表面共享一份进程普查和一个 PID-home 解析器：不再对每个席位
      // 每轮执行 `ps -Ao`，也不再对每个 PID 执行 `ps eww`（优先默认 home，并使用有界 PID 缓存）。
      const { ProcessCensus } = await import("./domain/process-census.js");
      const { CodexThreadIdResolver } = await import("./domain/codex-thread-id.js");
      const divergenceCensus = new ProcessCensus();
      const codexThreadIdResolver = new CodexThreadIdResolver({ defaultHome: nodeOs.homedir() });
      const currentGenDeps = {
        getPanePid: async (sessionTarget: string) => tmuxAdapter.getPanePid ? tmuxAdapter.getPanePid(sessionTarget) : null,
        listProcesses: () => divergenceCensus.list(),
        // S10 后续：resolve() 必须提供 identity；缺少 identity 时显式走具名的无门禁逃生口，
        // 绝不静默回退（r1 欠项 3）。
        readThreadIdByPid: (pid: number, identity?: string) =>
          identity === undefined ? codexThreadIdResolver.resolveUngatedLegacy(pid) : codexThreadIdResolver.resolve(pid, identity),
      };
      const OVERSIGHT_SEAT = "watch-lead@oversight";
      const modelDivergenceMonitor = new ModelDivergenceMonitor({
        processCensus: divergenceCensus,
        listPinnedSeats: () => {
          const rows = db.prepare(`
            SELECT n.id AS nodeId, r.id AS rigId, r.name AS rigName, n.runtime AS runtime, n.model AS pinnedModel,
                   (SELECT s.session_name FROM sessions s
                     WHERE s.node_id = n.id AND s.status = 'running'
                     ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS sessionName
              FROM nodes n JOIN rigs r ON r.id = n.rig_id
             WHERE n.model IS NOT NULL AND n.model <> ''
          `).all() as Array<{ nodeId: string; rigId: string; rigName: string; runtime: string | null; pinnedModel: string; sessionName: string | null }>;
          return rows
            .filter((row): row is typeof row & { sessionName: string } => row.sessionName !== null)
            .map((row) => ({ ...row, generation: sessionRegistry.currentOccupantGenerationForSession(row.sessionName) }));
        },
        // D-a / OPR.0.5.9.13——通过规范绑定与已验证窗格身份读取当前代数的记录；绝不根据
        // 名称、注册表 token 或转录新旧程度查询。被保留的前任可能一直以规范启动名继续写入。
        // 身份关联缺失或有歧义时一律明确返回无答案。
        readEffectiveModel: async (seat, cycle) => {
          // OPR.0.5.3.10 迷你要求 1——监视器传入轮询上下文时使用该轮范围的普查
          //（每轮只执行一次 ps）；否则使用共享合并普查。
          const genDeps = cycle ? { ...currentGenDeps, listProcesses: cycle.listProcesses } : currentGenDeps;
          if (seat.runtime === "codex") {
            const live = await resolveLiveCodexThreadId(seat.sessionName, genDeps);
            if (!live.ok) return { ok: false as const, reason: live.reason };
            const rollout = contextUsageStore.readCodexAndNormalize({ threadId: live.id, sessionName: seat.sessionName }).transcriptPath;
            if (!rollout) return { ok: false as const, reason: `实时线程 ${live.id.slice(0, 8)}… 没有可读的 rollout` };
            const model = readCodexEffectiveModel(rollout);
            return model ? { ok: true as const, model } : { ok: false as const, reason: `对 ${rollout} 的有界读取中没有模型信号` };
          }
          if (seat.runtime === "claude-code") {
            const tenure = sessionRegistry.currentOccupantTenure(seat.nodeId);
            const sidecar = contextUsageStore.readSidecar(seat.sessionName);
            const binding = sessionRegistry.getBindingForNode(seat.nodeId);
            const selection = await resolveIdentityVerifiedClaudeRecord({
              sessionName: seat.sessionName,
              generation: seat.generation,
              occupantBootAt: tenure?.bootAt ?? null,
              binding: binding ? { tmuxSession: binding.tmuxSession, tmuxPane: binding.tmuxPane } : null,
              identity: seatIdentityStore.getForNode(seat.nodeId),
              sidecar: sidecar.ok ? sidecar.data : null,
            }, genDeps, (path) => {
              try { return nodeFs.statSync(path).isFile(); } catch { return false; }
            });
            if (!selection.ok) return { ok: false as const, reason: selection.reason };
            const model = readClaudeEffectiveModel(selection.path);
            return model
              ? { ok: true as const, model }
              : { ok: false as const, reason: `当前占位者记录 ${selection.path} 中尚无助手轮次（来源：${selection.source}）` };
          }
          return { ok: false as const, reason: `运行时 ${seat.runtime ?? "unknown"} 尚无有效模型读取器` };
        },
        sendToSession: async (target, message, deliveryId) => {
          try {
            const previous = deliveryId ? outboxHandlerInstance.getById(deliveryId) : null;
            const payload = previous?.guardBinding ? previous.body : message;
            const result = await sessionTransport.send(target, payload, { deliveryId, actorSession: "model-monitor@system", auditPointer: deliveryId });
            return result.ok ? { ok: true, outcome: result.outcome } : { ok: false, error: result.error };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        },
        resolveOrchSeats: (rigName) => (db.prepare(`
          SELECT s.session_name AS sessionName
            FROM sessions s JOIN nodes n ON n.id = s.node_id JOIN rigs r ON r.id = n.rig_id
           WHERE r.name = ? AND s.status = 'running' AND n.logical_id LIKE 'orch.%'
        `).all(rigName) as Array<{ sessionName: string }>).map((row) => row.sessionName),
        resolveOperatorSeat: () => {
          const value = deps.settingsStore?.resolveOne("workspace.operator_seat_name").value;
          return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
        },
        resolveOversightSeat: () => {
          const row = db.prepare("SELECT session_name FROM sessions WHERE session_name = ? AND status = 'running' LIMIT 1").get(OVERSIGHT_SEAT);
          return row ? OVERSIGHT_SEAT : null;
        },
        recordProclamation: (proclamation) => {
          eventBus.emit({
            type: "seat.model_divergence",
            rigId: proclamation.rigId,
            nodeId: proclamation.nodeId,
            sessionName: proclamation.sessionName,
            runtime: proclamation.runtime,
            pinnedModel: proclamation.pinnedModel,
            effectiveModel: proclamation.effectiveModel,
            diagnosis: proclamation.diagnosis,
            channels: proclamation.channels,
          });
        },
      });
      modelDivergenceMonitor.startPolling(60_000);
      deps.modelDivergenceMonitor = modelDivergenceMonitor;
    }

    // OPR.0.4.6.WF1 FR-4：工作流启动恢复扫描——重新武装 keepalive、补发丢失的提交后提醒
    //（尚未提醒的待处理前沿包），并呈现卡住的实例。它在看守器和传输接线完成后运行，
    // 使补发提醒能够真正投递。失败只记日志，绝不致命：扫描问题不得拖垮后台服务。
    if (workflowRuntime && queueRepoForWorkflow) {
      try {
        const { runWorkflowBootSweep } = await import("./domain/workflow-boot-sweep.js");
        await runWorkflowBootSweep({
          instanceStore: workflowRuntime.instanceStore,
          queueRepo: queueRepoForWorkflow,
          watchdogJobsRepo: watchdogJobsRepoInstance,
          log: (line) => console.log(line),
          // OPR.0.4.6.WF5 FR-2 类别 (b)：检测的扫描分支。
          ensureStuckExceptionItem: workflowExceptionEnsurer,
          reconcileStuckExceptions: () => workflowRuntime?.reconcileStuckExceptions() ?? 0,
        });
      } catch (err) {
        console.warn(
          `工作流启动扫描失败（非致命）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // W1（事务闭合）FR——唤醒意图恢复扫描。投递崩溃后遗留的已提交但未投递唤醒意图
    //（终态事务已经提交，因此意图持久存在，但进程在提交后投递前退出）。它在传输接线完成后
    // 运行，使补投真正送达。扫描失败非致命，不得拖垮后台服务。不设周期定时器（已裁定
    // 不在范围内）：瞬时失败会让该行进入可见状态，并在下次启动时重试。
    try {
      // BLOCKING 1：先协调先前崩溃遗留的 `sending` 认领，再排空已提交的 `pending` 意图。
      // 协调是一次性边界步骤，与排空操作分离。
      const reconciled = queueRepoInstance.reconcileAbandonedWakeIntents();
      const drained = await queueRepoInstance.drainPendingWakeIntents();
      if (drained.delivered || drained.indeterminate || drained.failed || reconciled) {
        console.log(
          `唤醒意图恢复扫描：已投递=${drained.delivered} 结果不确定=${drained.indeterminate} 失败=${drained.failed} 已协调=${reconciled}`,
        );
      }
    } catch (err) {
      console.warn(
        `唤醒意图恢复扫描失败（非致命）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 上下文监视器——在 createApp 前构造，使路由能调用 pollOnce 刷新。调用方（index.ts）
  // 在 listen 后启动轮询。Slice 27：sessionTransport 可用时接入 ClaudeCompactionEnforcer
  //（组装后的 deps 中始终可用；条件判断用于让下游消费者获得更窄的类型）。
  const { ContextMonitor } = await import("./domain/context-monitor.js");
  const { ClaudeCompactionEnforcer } = await import("./domain/claude-compaction-enforcer.js");
  const compactionEnforcer = deps.sessionTransport
    ? new ClaudeCompactionEnforcer(
        new ContextPackSettingsStore(),
        deps.sessionTransport,
        // GHOST-STAGE (b)：为会话解析实时占位者代数（atom-B 任期台账），使退役代数创建的
        // stage 不会应用到后继。null = UNKNOWN，此时门禁不生效，绝不把过期代数当作实时值比较。
        {
          resolveOccupantGeneration: (sessionName) =>
            sessionRegistry.currentOccupantGenerationForSession(sessionName),
          onPostRestoreComplete: (receipt) => {
            recordManagedWidthReceipt(
              receipt,
              watchdogJobsRepoInstance,
              watchdogHistoryLogInstance,
            );
          },
        },
      )
    : undefined;
  // 51-08 A1——时间序列复用同一个 30 秒 tick（PM 决策 1）：上下文通道在现有持久化旁追加；
  // provider-window 通道排空读取模型扫描的同一状态栏缓存目录。
  const { UsageSamplesStore, providerWindowSamplesFromSignals } = await import("./domain/usage-samples-store.js");
  const usageSamplesStore = new UsageSamplesStore(db);
  const contextMonitor = new ContextMonitor(db, contextUsageStore, claudeAdapter, compactionEnforcer, {
    "claude-code": claudeAdapter,
    codex: codexAdapter,
    pi: piAdapter,
  }, usageSamplesStore, () => providerWindowSamplesFromSignals(
    collectClaudeSignalsFromProviderUsageDirectory(
      providerUsageDirectory(OPENRIG_HOME),
      undefined,
      legacyProviderUsageDirectory(OPENRIG_HOME),
    ),
  ));
  deps.contextMonitor = contextMonitor;
  // OPR.0.4.3.14——向路由暴露同一个 enforcer 实例，用于手动压缩触发。与 ContextMonitor
  // 共享一个实例，才能让手动流程后半段通过自动轮询循环排空，而不产生第二条路径。
  deps.compactionEnforcer = compactionEnforcer;

  // GHOST-STAGE (e/Class-B)——两个 Class-A 依赖均已存在（enforcer 的内存映射 1a-1f 与
  // 上下文 sidecar 2a），此时构造规范 OccupantInvalidator。它通过应用上下文注入
  // SeatHandoverService，使 commit() 的重新键控调用真正执行（接线前是空操作）。若 enforcer
  // 缺失（降级启动、无 sessionTransport），则回退为仅处理 sidecar 的失效器，绝不抛错。
  const { DefaultOccupantInvalidator } = await import("./domain/occupant-invalidator.js");
  deps.occupantInvalidator = new DefaultOccupantInvalidator({
    enforcer: compactionEnforcer ?? { invalidateOccupant: () => {} },
    contextUsage: contextUsageStore,
    // (e/Class-B) 看守器存储——退役代数注册的已武装任务在换代时停止。
    watchdog: watchdogJobsRepoInstance,
    // (e/Class-B) 队列存储——退役代数认领的进行中条目会释放回待处理状态。
    queue: queueRepoInstance,
    log: (msg) => console.warn(msg),
  });

  // OPR.0.3.4.9——周期快照调度器（崩溃保险底线）。
  const { PeriodicSnapshotScheduler } = await import("./domain/periodic-snapshot-scheduler.js");
  // OPR.0.5.3.10——一次快照 tick 在所有工作组/席位之间共享同一份进程普查。
  const { ProcessCensus: SnapshotProcessCensus } = await import("./domain/process-census.js");
  const snapshotProcessCensus = new SnapshotProcessCensus();
  const periodicSnapshotScheduler = new PeriodicSnapshotScheduler({
    db, snapshotCapture, snapshotRepo,
    // OPR.0.4.3.20 FR-4——每次周期快照序列化前刷新实时 token。
    sessionRegistry, resumeMetadataRefresher,
    processCensus: snapshotProcessCensus,
  });
  deps.periodicSnapshotScheduler = periodicSnapshotScheduler;

  // OPR.0.4.3.21——后台服务事件循环健康检测。每个后台服务仅构造一次并接入 deps，使
  // `/healthz` 能呈现卡死证据（循环延迟/距上次 tick 的时长），并统计高成本拓扑路由耗时。
  const { EventLoopMonitor } = await import("./domain/event-loop-monitor.js");
  const { RouteTimingRecorder } = await import("./domain/route-timing-recorder.js");
  const eventLoopMonitor = new EventLoopMonitor();
  const routeTimingRecorder = new RouteTimingRecorder();
  deps.eventLoopMonitor = eventLoopMonitor;
  deps.routeTimingRecorder = routeTimingRecorder;
  // S20——绑定来源随健康表面返回；缺失时保持旧版 healthz 响应体。
  deps.bindPlan = opts?.bindPlan;

  // 隔离性（热修 qitem-20260822230440-da0d2ad6 FIX 2）：真实后台服务在此构造漂移观察器，
  // 并主动预热模式缓存；过去由观察器构造函数在启动时预热。把它放在启动边界而非 createApp
  // 内部，才能确保测试构造的应用永远不会调用 shell 执行 `claude --help`。
  const { PermissionDriftObserver, ClaudePermissionModeCache } = await import("./domain/permission-drift-observer.js");
  const permissionModes = new ClaudePermissionModeCache();
  permissionModes.warm();
  deps.permissionDriftObserver = new PermissionDriftObserver({ db, permissionModes });

  // S10（OPR.0.5.5.10）——启动时把 gateway 激活为后台服务内子系统（修订后的 M1 §3：
  // 无子进程、无 connector 线缆；随附分派器和持久缓冲区在进程内组合，Slack 投递/入站服务
  // 从配置与密钥接线）。start() 永不抛错：接线失败会在健康表面呈现 state=failed，启动继续。
  // 未配置的 connector 是静默线路（如实拒绝，无操作、无驱动）；`zrig slack status` 会指出缺失项。
  const { GatewaySubsystem } = await import("./domain/gateway/gateway-subsystem.js");
  const { buildSlackGatewayWire, makeHumanReplyResolver } = await import("./domain/gateway/slack/slack-subsystem.js");
  const gatewaySubsystem = new GatewaySubsystem({
    home: OPENRIG_HOME,
    wire: () => buildSlackGatewayWire({
      home: OPENRIG_HOME,
      queueRepo: queueRepoInstance,
      resolveHumanReply: makeHumanReplyResolver(queueRepoInstance, deps.missionControlWriteContract),
      log: (m) => console.log(`[gateway] ${m}`),
    }),
    log: (m) => console.log(`[gateway] ${m}`),
  });
  gatewaySubsystem.start();
  deps.gatewaySubsystem = gatewaySubsystem;
  // OPR.0.5.6.1——绑定投递策略延迟解析的 gateway 引用。
  lateGatewayDispatch.fn = (op, ref, payload, opts) => gatewaySubsystem.dispatch(op, ref, payload, opts);

  const { app, injectWebSocket } = createAppWithWebSocket(deps);

  return { app, db, deps, contextMonitor, eventLoopMonitor, injectWebSocket };
}
