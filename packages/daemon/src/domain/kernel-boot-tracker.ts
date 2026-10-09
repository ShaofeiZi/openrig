// V0.3.1 分片 05 kernel-rig-as-default——前向修复 #3（架构）。
// 将 daemon 健康状态/监听与 kernel agent 就绪状态解耦。
//
// 先前行为：`bootKernelIfNeeded` 在 `createDaemon` 内等待
// `bootstrapOrchestrator.bootstrap(...)`，因此只有 kernel 工作组成员启动且启动投递完成后，
// daemon 进程才能执行到 `serve()`。损坏的 kernel agent（例如 Codex 启动期间未认证）也会阻塞
// healthz。于是 CLI 会报告“daemon 启动失败”，尽管 daemon 本身完全正常——只有 *kernel* 出了问题。
//
// 新行为：`bootKernelIfNeeded` 构建追踪器，在后台触发 bootstrap，并立即返回。
// `createDaemon` 完成后 daemon 随即绑定 healthz（HTTP 服务器随后在 server.ts 中绑定）。
// 追踪器状态通过 GET /api/kernel/status 发布，使操作人员（以及 `--wait-for-kernel` 等 CLI
// 标志）可以观察进度。
//
// 可配置的降级计时器（默认 90 秒）会在 kernel 未能及时达到 ready / partial_ready 状态时
// 发出一次 `kernel.agent.degraded` 事件，用遥测表明某个因素（认证 / spec / tmux 等）
// 正在阻塞 kernel。

import type { EventBus } from "./event-bus.js";
import type { SessionRegistry } from "./session-registry.js";
import type { RigRepository } from "./rig-repository.js";
import type { BootstrapResult } from "./bootstrap-orchestrator.js";

export type KernelState =
  | "skipped"           // OPENRIG_NO_KERNEL=1 / VITEST auto-skip / kernel already managed
  | "auth_blocked"      // Both Claude Code + Codex unauthenticated; cannot pick a variant
  | "spec_missing"      // Selected variant's rig.yaml not found on disk
  | "booting"           // Bootstrap fired; awaiting member startup_status
  | "partial_ready"     // Bootstrap done; some members ready, others still pending/failed
  | "ready"             // Bootstrap done; all members reached ready
  | "bootstrap_failed"  // Bootstrap promise rejected or returned errors
  | "degraded";         // Booting > degradedTimeoutMs without reaching ready/partial_ready

export interface KernelAgentStatus {
  /** 会话名（例如 `advisor-lead@kernel`）。 */
  sessionName: string;
  /** agent profile 中声明的 runtime（claude-code / codex / terminal）。 */
  runtime: string;
  /** sessions 表中的启动状态，与 session-registry 使用相同枚举。 */
  startupStatus: "pending" | "ready" | "attention_required" | "failed";
}

export interface KernelBootStatus {
  kernelState: KernelState;
  agents: KernelAgentStatus[];
  /** kernel 首次进入 booting 的 ISO 时间戳；处于终态或 skipped 时为 null。 */
  firstUnreadySince: string | null;
  /** 所选变体的文件名（rig.yaml / rig-claude-only.yaml / rig-codex-only.yaml）。
   *  未选择变体时为 null。 */
  variant: string | null;
  /** auth_blocked / spec_missing / bootstrap_failed / degraded 状态的人类可读详情；
   *  其他状态为 null。 */
  detail: string | null;
}

export interface KernelBootTrackerDeps {
  eventBus: EventBus;
  sessionRegistry: SessionRegistry;
  rigRepo: RigRepository;
  /** 追踪器在 `booting` 中等待多少毫秒后发出 `kernel.agent.degraded` 并转入 `degraded`。
   *  根据 IMPL-PRD §6.3 修订，默认值为 90_000（90 秒）。测试传入更短值；daemon 启动时
   *  遵循由 startup.ts 解析的 OPENRIG_KERNEL_DEGRADED_MS 环境变量覆盖值。 */
  degradedTimeoutMs?: number;
}

export class KernelBootTracker {
  private state: KernelState = "skipped";
  private variant: string | null = null;
  private detail: string | null = null;
  private firstUnreadySince: string | null = null;
  private degradedTimer: ReturnType<typeof setTimeout> | null = null;
  private degradedEmitted = false;
  private bootstrapInFlight = false;

  constructor(private readonly deps: KernelBootTrackerDeps) {}

  /** 将追踪器标记为有意不启动（--no-kernel、已托管短路、VITEST 自动跳过）。
   *  这是终态，不设降级计时器。 */
  setSkipped(detail: string): void {
    this.cancelTimer();
    this.state = "skipped";
    this.detail = detail;
    this.firstUnreadySince = null;
  }

  /** 认证阻塞终态。操作人员可在 detail 中看到三段式错误。 */
  setAuthBlocked(message: string): void {
    this.cancelTimer();
    this.state = "auth_blocked";
    this.detail = message;
    this.firstUnreadySince = null;
  }

  /** spec 缺失终态。路径置于 detail 中，便于运维分诊。 */
  setSpecMissing(specPath: string): void {
    this.cancelTimer();
    this.state = "spec_missing";
    this.detail = specPath;
    this.firstUnreadySince = null;
  }

  /** 开始追踪进行中的 bootstrap。bootstrap Promise 在内部等待，调用方不会被其阻塞。 */
  startBooting(variant: string, bootstrapPromise: Promise<BootstrapResult>): void {
    if (this.bootstrapInFlight) return;
    this.bootstrapInFlight = true;
    this.state = "booting";
    this.variant = variant;
    this.detail = null;
    this.firstUnreadySince = new Date().toISOString();
    this.degradedEmitted = false;
    this.scheduleDegradedTimer();

    bootstrapPromise
      .then((result) => this.onBootstrapComplete(result))
      .catch((err) => this.onBootstrapError(err));
  }

  /** 读取当前状态。根据 sessions 表实时计算 agents[]，使响应始终反映最新 startup_status。 */
  getStatus(): KernelBootStatus {
    const agents = this.computeAgents();
    let kernelState = this.state;
    // bootstrap 完成后（此前 state == 'booting'），根据 agent startup_status
    // 提升为 ready / partial_ready。
    if (this.state === "booting" && !this.bootstrapInFlight) {
      kernelState = this.aggregateReadinessFromAgents(agents);
    }
    return {
      kernelState,
      agents,
      firstUnreadySince:
        kernelState === "ready" || kernelState === "skipped"
          ? null
          : this.firstUnreadySince,
      variant: this.variant,
      detail: this.detail,
    };
  }

  /** 停止降级计时器。可从任何位置安全调用（幂等）。生产调用方无需调用；
   *  测试和 daemon 优雅关闭需要调用。 */
  stop(): void {
    this.cancelTimer();
  }

  private onBootstrapComplete(result: BootstrapResult): void {
    this.bootstrapInFlight = false;
    if (result.errors && result.errors.length > 0) {
      this.cancelTimer();
      this.state = "bootstrap_failed";
      this.detail = result.errors.join("; ");
      return;
    }
    // Bootstrap 正常返回。读取时根据 agents[] 计算到 ready / partial_ready 的状态转换。
    // 只有至少一个 agent 就绪时才取消降级计时器——在此之前 kernel 实际仍在启动；若始终没有
    // agent 就绪，操作人员需要看到降级遥测。
    const agents = this.computeAgents();
    const aggregated = this.aggregateReadinessFromAgents(agents);
    if (aggregated === "ready" || aggregated === "partial_ready") {
      this.cancelTimer();
    }
  }

  private onBootstrapError(err: unknown): void {
    this.bootstrapInFlight = false;
    this.cancelTimer();
    this.state = "bootstrap_failed";
    this.detail = err instanceof Error ? err.message : String(err);
  }

  private aggregateReadinessFromAgents(
    agents: KernelAgentStatus[],
  ): KernelState {
    if (agents.length === 0) {
      // Bootstrap 已完成，但尚无已注册 agent（会话插入与状态更新之间的竞争窗口）。
      // 保持 booting，使操作人员看到实际进度而非虚假 ready。
      return "booting";
    }
    const readyCount = agents.filter((a) => a.startupStatus === "ready").length;
    if (readyCount === agents.length) return "ready";
    if (readyCount === 0) return "booting";
    return "partial_ready";
  }

  private computeAgents(): KernelAgentStatus[] {
    try {
      const kernelRigs = this.deps.rigRepo.findRigsByName("kernel");
      if (kernelRigs.length === 0) return [];
      const out: KernelAgentStatus[] = [];
      for (const rig of kernelRigs) {
        const sessions = this.deps.sessionRegistry.getSessionsForRig(rig.id);
        for (const s of sessions) {
          // session-registry 的 Session 结构携带 startupStatus + sessionName；runtime 来自 node 行。
          // 此处只读取最少字段，避免追踪器引入 node-repository。
          out.push({
            sessionName: s.sessionName,
            runtime: (s as { runtime?: string }).runtime ?? "unknown",
            startupStatus: s.startupStatus,
          });
        }
      }
      return out;
    } catch {
      // 追踪器绝不能抛错——数据库短暂异常时，/api/kernel/status 返回 agents[] 为空的有效信封，
      // 比返回 500 更有用。
      return [];
    }
  }

  private scheduleDegradedTimer(): void {
    const ms = this.deps.degradedTimeoutMs ?? 90_000;
    if (ms <= 0) return;
    this.cancelTimer();
    this.degradedTimer = setTimeout(() => this.checkDegraded(), ms);
    // 允许 daemon 无需等待计时器即可干净退出。
    if (typeof this.degradedTimer === "object" && "unref" in this.degradedTimer) {
      (this.degradedTimer as unknown as { unref(): void }).unref();
    }
  }

  private cancelTimer(): void {
    if (this.degradedTimer !== null) {
      clearTimeout(this.degradedTimer);
      this.degradedTimer = null;
    }
  }

  private checkDegraded(): void {
    const agents = this.computeAgents();
    const aggregated =
      this.state === "booting"
        ? this.aggregateReadinessFromAgents(agents)
        : this.state;
    if (aggregated === "ready" || aggregated === "partial_ready") {
      // 在截止时间前就绪，不发出降级事件。
      return;
    }
    // 提升为 degraded，并且只发出一次遥测。
    if (this.degradedEmitted) return;
    this.degradedEmitted = true;
    this.state = "degraded";
    try {
      this.deps.eventBus.emit({
        type: "kernel.agent.degraded",
        agents: agents.map((a) => ({
          sessionName: a.sessionName,
          runtime: a.runtime,
          startupStatus: a.startupStatus,
        })),
        firstUnreadySince: this.firstUnreadySince,
        detail: this.detail,
      });
    } catch {
      // 尽力而为的遥测；追踪器不得抛错。
    }
  }
}
