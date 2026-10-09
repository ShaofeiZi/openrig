import { serve, type ServerType } from "@hono/node-server";
import path from "node:path";
import { createDaemonShutdown, DAEMON_SHUTDOWN_RECEIPT } from "./daemon-shutdown.js";
import { readOpenRigEnv, OPENRIG_HOME } from "./openrig-compat.js";
import { makeOperatorDeliveryEngine } from "./domain/gateway/operator-delivery-engine.js";
import { resolveDaemonDbPath } from "./daemon-db-path.js";
import { createDaemon } from "./startup.js";
import { resolveBindPlan } from "./domain/bind-plan.js";
import { runQueueRetentionSweep, RETENTION_DEFAULTS } from "./domain/queue-retention.js";
import {
  createStuckSweepStatus,
  resolveStuckSweepIntervalSeconds,
  runStuckSweep,
} from "./domain/queue-stuck-sweep.js";
import {
  createWakeLadderStatus,
  resolveWakeRetryIntervalSeconds,
  runWakeLadderTick,
  WakeLadderScheduler,
} from "./domain/queue-wake-ladder.js";
import {
  assertBindAuthInvariant,
  detectTailscaleInterface,
  isLoopbackBind,
  isTailscaleBind,
  resolveToIpOrNull,
} from "./middleware/auth-bearer-token.js";
import type { SlowOperationInstrumentation } from "./domain/slow-op-recorder.js";
import type { ProviderService } from "./domain/provider/provider-service.js";
import { SettingsStore } from "./domain/user-settings/settings-store.js";
import {
  ensureOpenRigInstance,
  formatInstanceInitializationConflicts,
} from "./domain/instance-initialization.js";

/** OPR.0.4.3.21 (51elv2)——限制优雅关闭时 recorder drain 的时长。 */
export const SLOW_OP_SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;
/** P7——生命周期心跳节拍；last-seen 粒度 = 此间隔。 */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * OPR.0.4.3.21 (51elv2)——在优雅关闭时 drain + close 慢操作 recorder 并报告进程
 * 退出码。recorder 干净关闭（或缺省）时返回 0；drain reject、超时或 recorder 处于
 * 终态失败时返回 1——未证实/丢失的 drain 绝不能看起来像干净退出。由一个有限计时器
 * 限住，它保持被引用直到 drain 结算或超时——一旦 servers 和 recorder Worker 都不再
 * 被引用，它是唯一能强制边界的句柄——结算后清除；不引入 retry、队列修复、迁移或
 * supervisor 机制。
 */
export async function drainSlowOpRecorderOnShutdown(
  recorder: Pick<SlowOperationInstrumentation, "flush" | "close"> | undefined,
  opts?: { timeoutMs?: number; log?: (message: string, error?: unknown) => void },
): Promise<number> {
  const drain = recorder?.close ?? recorder?.flush;
  if (!recorder || !drain) return 0;
  const log = opts?.log ?? ((message: string, error?: unknown) => console.error(message, error));
  const timeoutMs = opts?.timeoutMs ?? SLOW_OP_SHUTDOWN_DRAIN_TIMEOUT_MS;

  let drainError: unknown;
  // 独立于值追踪 reject：Promise 可能用 falsy 值 reject（undefined / null / false
  // / 0 / ""），那仍是失败。
  let rejected = false;
  let settled = false;
  const drainPromise = Promise.resolve()
    .then(() => drain.call(recorder))
    .then(
      () => { settled = true; },
      (error) => { drainError = error; rejected = true; settled = true; },
    );

  // 一旦 servers + recorder Worker 不再被引用，这个有限计时器是唯一让关闭保持存活
  // 足够久以强制边界的东西，因此必须保持被引用（绝不 unref）；结算后清除。
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });

  await Promise.race([drainPromise, timeoutPromise]);
  if (timer) clearTimeout(timer);

  if (!settled) {
    log("[slow-operation] 关闭 drain 超时；instrumentation 记录可能丢失");
    return 1;
  }
  if (rejected) {
    log("[slow-operation] 关闭 drain 失败；instrumentation 记录可能丢失", drainError);
    return 1;
  }
  return 0;
}

/** OPR.0.3.4.9——为可测试性抽出。启动定期 snapshot 调度器，并在启用时更新
 *  ps-projection 状态。 */
export function startPeriodicSnapshotScheduler(deps: {
  periodicSnapshotScheduler?: { start(intervalMs: number, retentionKeep: number): void };
  psProjectionService: { setPeriodicSnapshotState(active: boolean, intervalSeconds: number): void };
  settingsStore?: { resolveOne(key: string): { value: unknown } };
}): void {
  if (!deps.periodicSnapshotScheduler) return;
  const settingsStore = deps.settingsStore;
  const enabled = settingsStore ? settingsStore.resolveOne("snapshots.periodic.enabled").value === true : true;
  if (!enabled) return;
  const intervalS = settingsStore ? (settingsStore.resolveOne("snapshots.periodic.interval_seconds").value as number) : 300;
  const retentionKeep = settingsStore ? (settingsStore.resolveOne("snapshots.periodic.retention_keep").value as number) : 10;
  deps.periodicSnapshotScheduler.start(intervalS * 1000, retentionKeep);
  deps.psProjectionService.setPeriodicSnapshotState(true, intervalS);
}

/** OPR.0.4.6.FS-1 W2——启动队列保留维护 sweep（arch D3）：一次 boot sweep + 每日
 *  tick，归档超龄终态 `queue_transitions`（绝不删除）并修剪 `watchdog_history`，
 *  都在有界批次中进行并让出事件循环。读 `retention.*` 设置（经 RETENTION_DEFAULTS
 *  烘焙默认值）。fire-and-forget 带错误日志——sweep 失败绝不能 crash daemon。
 *  返回每日 interval 句柄（关闭时清除），禁用时返回 null。 */
export function startQueueRetentionScheduler(deps: {
  rigRepo: { db: import("better-sqlite3").Database };
  settingsStore?: { resolveOne(key: string): { value: unknown } };
}): ReturnType<typeof setInterval> | null {
  const store = deps.settingsStore;
  const enabled = store ? store.resolveOne("retention.enabled").value === true : true;
  if (!enabled) return null;
  const db = deps.rigRepo.db;
  const num = (key: string, fallback: number): number => {
    const v = store ? store.resolveOne(key).value : fallback;
    return typeof v === "number" ? v : fallback;
  };
  const runOnce = (): void => {
    void runQueueRetentionSweep(db, {
      nowIso: new Date().toISOString(),
      transitionsRetentionDays: num("retention.transitions_days", RETENTION_DEFAULTS.transitionsRetentionDays),
      watchdogRetentionDays: num("retention.watchdog_days", RETENTION_DEFAULTS.watchdogRetentionDays),
      watchdogKeepPerJob: num("retention.watchdog_keep_per_job", RETENTION_DEFAULTS.watchdogKeepPerJob),
      usageSamplesRetentionDays: num("retention.usage_samples_days", RETENTION_DEFAULTS.usageSamplesRetentionDays),
      batchSize: num("retention.batch_size", RETENTION_DEFAULTS.batchSize),
    }).catch((err: unknown) => {
      console.error(`[queue-retention] sweep 错误：${err instanceof Error ? err.message : String(err)}`);
    });
  };
  runOnce(); // boot sweep（fire-and-forget）
  const DAILY_MS = 24 * 60 * 60 * 1000;
  return setInterval(runOnce, DAILY_MS);
}

/** S02 (OPR.0.5.5.2)——启动常驻 STUCK SWEEP："是否有东西静默卡住"的两半
 *  （claimed-never-closed；sender-believed-delivered-never-woken）加上
 *  unclaimed-obligation 网和 dangling-closure custody 类，按 config keyed 节拍
 *  （`queue.stuck_sweep_interval_seconds`）。发现作为持久行路由到归属席位；干净
 *  sweep 只记 healthz 心跳；失败 sweep 在该面和日志上大声报，绝不静默跳过。
 *  Boot sweep + interval，retention 模式。返回 interval 句柄（关闭时清除），队列
 *  repository 缺省（直接构造 harness）时返回 null。 */
export function startStuckSweepScheduler(deps: {
  rigRepo: { db: import("better-sqlite3").Database };
  queueRepo?: import("./domain/queue-repository.js").QueueRepository;
  stuckSweepStatus?: import("./domain/queue-stuck-sweep.js").StuckSweepStatus;
}): ReturnType<typeof setInterval> | null {
  const queueRepo = deps.queueRepo;
  if (!queueRepo) return null;
  const status = createStuckSweepStatus();
  deps.stuckSweepStatus = status; // healthz 读此快照
  const db = deps.rigRepo.db;
  const runOnce = (): void => {
    // runStuckSweep 绝不 throw（失败在 status 面上大声记录）；catch 是 promise 链本身的
    // never-crash-the-daemon 腰带。
    void runStuckSweep({ db, queueRepo, status }).catch((err: unknown) => {
      console.error(`[stuck-sweep] 调度器错误：${err instanceof Error ? err.message : String(err)}`);
    });
  };
  runOnce(); // boot sweep（fire-and-forget）
  return setInterval(runOnce, resolveStuckSweepIntervalSeconds() * 1000);
}

/** S01 (OPR.0.5.5.1)——启动 WAKE-OR-ESCALATE 阶梯：wake 失败的接力棒按 config keyed
 *  节拍重试到上限，然后沿记录的 rung 升级（destination 的 orchestrator——按 destination
 *  聚合——再到 operator 面）。阶梯状态完全从行的 transitions 派生，所以 daemon 重启在
 *  确切位置恢复每个阶梯，无需恢复步骤。返回调度器（关闭时停止），队列 repository
 *  缺省时返回 null。 */
export function startWakeLadderScheduler(deps: {
  rigRepo: { db: import("better-sqlite3").Database };
  queueRepo?: import("./domain/queue-repository.js").QueueRepository;
  wakeLadderStatus?: import("./domain/queue-wake-ladder.js").WakeLadderStatus;
  providerService?: Pick<ProviderService, "getReadModel">;
  usageLimitJitterSeconds?: number;
  gatewaySubsystem?: { dispatch: (op: string, entityBindingRef: string, payload: unknown) => { ok: boolean; error?: string } };
}): WakeLadderScheduler | null {
  const queueRepo = deps.queueRepo;
  if (!queueRepo) return null;
  const status = createWakeLadderStatus();
  deps.wakeLadderStatus = status; // healthz 读此快照
  const db = deps.rigRepo.db;
  // OPR.0.5.6.1 (R2/R1 B-2)：PRODUCTION operator rung 通过 engine 派发——port 从
  // live gateway subsystem 构建，它在调度器启动时（post-bind）已存在。缺省
  // （无 gateway 的 daemon 变体）保持诚实的未接线 floor，绝不静默绿灯。
  const deliveryEngine = deps.gatewaySubsystem
    ? makeOperatorDeliveryEngine({
        home: OPENRIG_HOME,
        queueRepo,
        dispatch: (op, ref, payload) => deps.gatewaySubsystem!.dispatch(op, ref, payload),
      })
    : undefined;
  const scheduler = new WakeLadderScheduler({
    runTick: () => runWakeLadderTick({
      db,
      queueRepo,
      status,
      ...(deliveryEngine ? { deliveryEngine } : {}),
      ...(deps.providerService
        ? { getProviderReadModel: () => deps.providerService!.getReadModel() }
        : {}),
      ...(deps.usageLimitJitterSeconds !== undefined
        ? { usageLimitJitterSeconds: deps.usageLimitJitterSeconds }
        : {}),
    }),
    tickIntervalMs: resolveWakeRetryIntervalSeconds() * 1000,
  });
  scheduler.start();
  return scheduler;
}

async function isTrustedLocalOrTailnetBind(host: string): Promise<boolean> {
  if (isLoopbackBind(host)) return true;
  if (isTailscaleBind(host)) return true;
  if (!/^[\d.]+$/.test(host) && !host.includes(":")) {
    const resolvedIp = await resolveToIpOrNull(host);
    if (resolvedIp) return isLoopbackBind(resolvedIp) || isTailscaleBind(resolvedIp);
  }
  return false;
}

export async function startServer(port?: number) {
  const p = port ?? parseInt(readOpenRigEnv("OPENRIG_PORT", "RIGGED_PORT") ?? "7433", 10);
  // D15——把默认 db 锚定在 OPENRIG_HOME 下，绝不用裸 CWD 相对文件名（那可能打开共享
  // fleet db）。显式 OPENRIG_DB 优先。
  const dbPath = resolveDaemonDbPath(readOpenRigEnv("OPENRIG_DB", "RIGGED_DB"), OPENRIG_HOME);
  const instanceConfig = new SettingsStore().resolveConfig();
  const initialization = ensureOpenRigInstance({
    home: OPENRIG_HOME,
    workspaceRoot: instanceConfig.workspaceRoot,
    contextRoot: instanceConfig.contextRoot,
    skillsRoot: instanceConfig.skillsRoot,
    topologyRoot: instanceConfig.topologyRoot,
  });
  if (!initialization.ok) {
    throw new Error(`zrig 实例初始化被阻止：${formatInstanceInitializationConflicts(initialization)}`);
  }

  // bug-fix slice auth-bearer-tailscale-trust：把 undefined env 视为 default，区分
  // "显式 operator opt-in" 与 "default"。显式时 operator 承担责任（bearer 不变式
  // 应用到他们选的 host）。default 时 daemon 始终 bind loopback 且 ALSO bind 活跃
  // tailscale 接口（若存在）——两条都是不变式接受的路径。
  // OPR.0.5.5.20——bind 意图只走专用 OPENRIG_BIND_HOST 面。重载的 routing env
  // （OPENRIG_HOST/RIGGED_HOST）仅用于下面的 provenance 行观测，绝不选 bind 分支：
  // 托管环境注入的 endpoint 与 opt-in 字节不可区分，parent daemon 曾正因它静默丢了
  // Tailscale listener（operator 接力棒 qitem-20260827070400）。
  // auth-bearer-tailscale-trust 裁决原样走新面。
  const bindPlan = resolveBindPlan({
    bindHostEnv: process.env.OPENRIG_BIND_HOST,
    routingHostEnv: readOpenRigEnv("OPENRIG_HOST", "RIGGED_HOST"),
    tailscaleIp: detectTailscaleInterface(),
  });
  if (bindPlan.ignoredRoutingHost) {
    console.error(
      `[bind-provenance] OPENRIG_HOST=${bindPlan.ignoredRoutingHost} 是 ROUTING env，bind 策略已忽略——` +
      `bind 默认 ${bindPlan.hosts.join(" + ")}。用 --host、daemon.host 配置键（文件）或 OPENRIG_BIND_HOST 声明 bind 意图。`,
    );
  }
  const explicitHost = bindPlan.mode === "explicit" ? bindPlan.hosts[0] : undefined;
  // PL-005 Phase B：Mission Control 写动词的 bearer token。
  // 无 legacy 别名（此 env var 是 Phase B 新增）。
  const bearerToken = process.env.OPENRIG_AUTH_BEARER_TOKEN ?? null;

  let bindHosts: string[];
  const terminalTokenEnv = process.env.OPENRIG_TERMINAL_BEARER_TOKEN?.trim();
  let terminalBearerToken: string | null = terminalTokenEnv || null;
  if (explicitHost) {
    // Operator opt-in 路径——不变式对真正 public/LAN bind 强制 bearer；loopback/tailscale
    // bind 短路。
    await assertBindAuthInvariant({ host: explicitHost, bearerToken });
    if (!terminalBearerToken && !(await isTrustedLocalOrTailnetBind(explicitHost))) {
      terminalBearerToken = bearerToken;
    }
    bindHosts = [explicitHost];
  } else {
    // 默认路径——plan 已算好 loopback + tailscale（活跃时）。
    bindHosts = bindPlan.hosts;
  }

  const { app, contextMonitor, deps, eventLoopMonitor, injectWebSocket } = await createDaemon({
    dbPath,
    bearerToken,
    terminalBearerToken,
    // S20——有效 bind plan 走 health 面，使 adoption gate 从 BINDING 证据（探测每个 host）
    // 而非 config echo 验证 listener。
    bindPlan,
  });

  // 多 bind：N 个 serve() 实例共享同一 Hono app。Hono 的 serve() 针对单个 host:port；
  // 多 bind 时我们为每个 host spawn 一个。contextMonitor + watchdog 调度器只在首次
  // 成功 bind 回调触发后启动一次。
  let monitorsStarted = false;
  let retentionTimer: ReturnType<typeof setInterval> | null = null;
  let stuckSweepTimer: ReturnType<typeof setInterval> | null = null;
  let wakeLadderScheduler: WakeLadderScheduler | null = null;
  // P7——生命周期心跳：运行时每 tick 推进 last-seen。
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  const servers: ServerType[] = [];
  for (const host of bindHosts) {
    const srv = serve({ fetch: app.fetch, port: p, hostname: host }, (info) => {
      console.log(`zrig 后台服务监听 http://${host}:${info.port}`);
      if (!monitorsStarted) {
        monitorsStarted = true;
        contextMonitor.start();
        // PL-004 Phase C：启动 watchdog 调度器。post-bind 加入 supervision 树，使
        // HTTP 面在首个 tick 前就绪（匹配 contextMonitor 模式）。
        deps.watchdogScheduler?.start();
        // S10——post-bind 启动 gateway 子系统的 NETWORK 服务（replay、outbound poll、
        // Socket Mode inbound），contextMonitor 模式：组合 wire 已 active；只有 dial-out
        // 半等 supervision 树。
        deps.gatewaySubsystem?.startServices();
        // Slice 15——启动 seat-activity 调度器（默认 1Hz）。轮询每个运行中 tmux 绑定席位
        // 的 window_activity 时间戳，使 PsProjectionService + node-inventory enrichment
        // 每次请求都服务新鲜数据。
        deps.seatActivityService?.start(deps.rigRepo.db);
        // 5b82324b——structural pane-activity 缓存，同一 1Hz 节拍。
        deps.seatStructuralActivityService?.start(deps.rigRepo.db);
        // OPR.0.4.3.19——启动 liveness identity reconciler（默认 5s）。持久化每席位 pane
        // PID/command 裁决，使 node-inventory 按已验证进程 identity 门控 running/active
        // 投影。
        deps.seatIdentityReconciler?.start();
        startPeriodicSnapshotScheduler(deps);
        // OPR.0.4.6.FS-1 W2——boot sweep + 每日 retention tick（有界，批次间让出；
        // sweep 失败记日志，绝不致命）。
        retentionTimer = startQueueRetentionScheduler(deps);
        // S02——常驻 stuck sweep：没人需要记得跑那些动词。
        stuckSweepTimer = startStuckSweepScheduler(deps);
        // S01——接力棒 wake-or-escalate：失败的接力棒 wake 按计划重试，然后沿记录 rung
        // 升级；绝不静默 park。
        wakeLadderScheduler = startWakeLadderScheduler(deps);
        // P7——生命周期心跳（推进 last-seen）。写失败记日志并继续（渲染诚实地降级到更旧
        // last-seen）；store 守卫 not-stopped，使 tick 永远不会越过 stopped_at。
        heartbeatTimer = setInterval(() => {
          try {
            deps.daemonLifecycleStore.recordHeartbeat(new Date().toISOString());
          } catch (err) {
            console.error("[lifecycle-heartbeat] 写失败（非致命）", err);
          }
        }, HEARTBEAT_INTERVAL_MS);
      }
    });
    injectWebSocket(srv);
    servers.push(srv);
  }

  // PL-004 Phase C：优雅关闭——在进程退出前停调度器，使任何 in-flight 策略评估完成
  // （或被 await）。多 bind：并行关闭每个 serve() 实例。
  deps.healthDiagnosis?.start();
  const shutdown = createDaemonShutdown({
    receiptPath: path.join(OPENRIG_HOME, DAEMON_SHUTDOWN_RECEIPT),
    phases: [
      ["timers", () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (retentionTimer) clearInterval(retentionTimer);
        if (stuckSweepTimer) clearInterval(stuckSweepTimer);
      }],
      ["proof-source-watch", () => deps.proofSourceWatch?.close()],
      ["health-diagnosis", () => deps.healthDiagnosis?.stop()],
      ["watchdog", () => deps.watchdogScheduler?.stop()],
      ["seat-activity", () => deps.seatActivityService?.stop()],
      ["seat-structural-activity", () => deps.seatStructuralActivityService?.stop()],
      ["seat-identity", () => deps.seatIdentityReconciler?.stop()],
      ["periodic-snapshot", () => deps.periodicSnapshotScheduler?.stop()],
      ["gateway", () => deps.gatewaySubsystem?.stop()],
      ["wake-ladder", () => wakeLadderScheduler?.stop()],
      ["event-loop-monitor", () => eventLoopMonitor.stop()],
      ["connections", () => Promise.all(servers.map((srv) => new Promise<void>((resolve, reject) => {
        srv.close((error) => error ? reject(error) : resolve());
      })))],
      ["recorder", async () => {
        if (await drainSlowOpRecorderOnShutdown(deps.slowOpRecorder) !== 0) {
          throw new Error("slow-operation recorder drain 未完成；记录可能丢失");
        }
      }],
    ],
    // 服务失败、开放连接或丢失的 recorder drain 都不算干净。
    markClean: () => deps.daemonLifecycleStore.recordStop(deps.daemonBootEpoch, new Date().toISOString()),
  });
  // 重复信号加入首次关闭，而非绕过其证据。
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // 向后兼容的单 server 返回（只需 handle 引用的调用方；多 bind 关闭经信号处理器接线）。
  return servers[0]!;
}

// 仅当本文件被直接执行（而非 import）时才启动 server。
const isDirectRun =
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  startServer();
}
