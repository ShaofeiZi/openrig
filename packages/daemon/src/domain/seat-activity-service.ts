import type Database from "better-sqlite3";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { EventBus } from "./event-bus.js";
import type { SeatActivity } from "./types.js";
import type {
  ActivityEvidence,
  ActivityValue,
  AdapterRungInventory,
  ArbitratedSeatState,
  EvidenceRungId,
  RungHealthEvent,
  RungTrust,
} from "./activity-taxonomy.js";
import { EVIDENCE_RUNG_RANK, runtimeRungInventory } from "./activity-taxonomy.js";

/** 默认轮询频率为 1Hz。默认静默窗口为 3 秒，因此 1Hz 轮询使缓存观测最多滞后约 1 秒。 */
export const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * Slice 15——后台服务负责的 `terminal-active` 原语。
 *
 * 通过 TmuxAdapter.readPaneLastActivity 逐席位轮询 tmux 的 `#{window_activity}`
 * 最后活动时间戳，并按规范会话名称保存最新观测。将观测时间戳的年龄与静默窗口阈值比较，
 * 派生 active/idle。下游消费方（ps-projection、node-inventory、UI hook）通过
 * `getSeatActivity(canonicalSessionName)` 读取。
 *
 * 禁止推断契约（slice 15 IMPL-PRD §2.3，HG-4）：本服务绝不读取队列/分派状态。
 * 构造器表面有意拒绝任何队列/分派形态的依赖，使后续贡献者必须先修改设计才能接入。
 * 配套的 `hasAssignedWork` 原语位于 ps/queue 投影，也绝不导入本服务。
 */
export interface SeatActivityServiceDeps {
  tmux: Pick<TmuxAdapter, "readPaneLastActivity">;
  defaultWindowSeconds: number;
  eventBus?: EventBus;
  now?: () => Date;
  /** S19：self-report 层级生产者（Claude pid.json）。每次 sweep 时，对声明清单配备
   * self-report 的席位进行查询；缺失表示该层级不存在。 */
  selfReportReader?: (sessionName: string, seatNodeId: string) => ActivityEvidence | null;
}

export interface PollSeatOptions {
  silenceWindowSeconds?: number;
}

export class SeatActivityService {
  private readonly tmux: Pick<TmuxAdapter, "readPaneLastActivity">;
  private readonly defaultWindowSeconds: number;
  private readonly eventBus: EventBus | null;
  private readonly now: () => Date;
  private readonly latestByPaneId = new Map<string, SeatActivity>();
  // 单次飞行守卫：每次只执行一个全队列 window-activity sweep，对应
  // seat-structural-activity-service（MUST-FIX 2）。缓慢的 tmux 绝不会积累重叠的
  // 全队列 sweep；任一时刻最多有一次 sweep 在执行。
  private sweeping = false;

  private readonly selfReportReader: ((sessionName: string, seatNodeId: string) => ActivityEvidence | null) | null;

  constructor(deps: SeatActivityServiceDeps) {
    this.tmux = deps.tmux;
    this.defaultWindowSeconds = deps.defaultWindowSeconds;
    this.eventBus = deps.eventBus ?? null;
    this.now = deps.now ?? (() => new Date());
    this.selfReportReader = deps.selfReportReader ?? null;
  }

  /**
   * 读取一次 `paneId` 所在窗口的最后活动时间戳，并与配置的静默窗口比较，
   * 记录一条 `isActiveWithinWindow` 观测。
   *
   * 返回新的 SeatActivity 记录；没有可用信号（tmux 瞬时错误、时间戳为空或不可解析）时返回 null。
   *
   * Slice 15 阻塞修复：从读取运行时 `pane_silence_flag`（在 tmux 3.6a 上观测为空，
   * 在其他版本上会粘住警报）改为根据 `window_activity` 自行计算 active/idle；
   * tmux 自身状态栏的活动指示器也读取同一时间戳。
   */
  async pollSeat(paneId: string, opts?: PollSeatOptions): Promise<SeatActivity | null> {
    const silenceWindowSeconds = opts?.silenceWindowSeconds ?? this.defaultWindowSeconds;
    let lastActivityEpochSeconds: number | null = null;
    try {
      lastActivityEpochSeconds = await this.tmux.readPaneLastActivity(paneId);
    } catch {
      lastActivityEpochSeconds = null;
    }
    if (lastActivityEpochSeconds === null) return null;

    const observedAt = this.now();
    const ageSeconds = observedAt.getTime() / 1000 - lastActivityEpochSeconds;
    // 最近活动落在静默窗口内时判为活跃。ageSeconds 为负数（时钟偏移）时也防御性地判为活跃；
    // 这表示 tmux 报告的活动时间处于很近的未来，可能是后台服务单调时钟短暂落后所致。
    const isActiveWithinWindow = ageSeconds < silenceWindowSeconds;

    const record: SeatActivity = {
      paneId,
      isActiveWithinWindow,
      silenceWindowSeconds,
      lastObservedAt: observedAt.toISOString(),
      // 架构裁定 3a947fb1（FR-7 追加）：以 ISO 暴露原始 window_activity 时间戳，
      // 即刚才计算 `ageSeconds` 使用的同一 epoch，不再丢弃。保持原值，绝不钳制
      //（时钟偏移可能使其晚于 lastObservedAt）；消费方结合读取时钟派生展示年龄。
      lastActivityAt: new Date(lastActivityEpochSeconds * 1000).toISOString(),
    };
    this.latestByPaneId.set(paneId, record);

    // S19：sampler 就是 window-sampling 层级；为已绑定席位填充证据阶梯，
    // 并在同一次遍历中查询声明过的 self-report 层级。
    const seatNodeId = this.sessionToSeat.get(paneId);
    if (seatNodeId) {
      const seq = (this.samplerSeqBySession.get(paneId) ?? 0) + 1;
      this.samplerSeqBySession.set(paneId, seq);
      this.reportEvidence({
        seatNodeId,
        sessionName: paneId,
        rung: "window-sampling",
        sourceId: "tmux:window-activity",
        seq,
        observedAt: record.lastObservedAt,
        activity: isActiveWithinWindow ? "working" : "idle-at-prompt",
      });
      const seat = this.ladder.get(seatNodeId);
      if (this.selfReportReader && seat?.inventory?.rungs.some((r) => r.rung === "self-report")) {
        const evd = this.selfReportReader(paneId, seatNodeId);
        if (evd) this.reportEvidence(evd); // null = unreadable ⇒ the rung simply stales
      }
    }
    return record;
  }

  /**
   * 返回席位最新存储的观测；尚未记录观测时（例如服务尚未轮询该席位）返回 null。
   * 这与 `isActiveWithinWindow: false` 不同。
   */
  getSeatActivity(paneId: string): SeatActivity | null {
    return this.latestByPaneId.get(paneId) ?? null;
  }

  /** 删除席位最新存储的观测（用于席位拆除）。 */
  forgetSeat(paneId: string): void {
    this.latestByPaneId.delete(paneId);
  }

  /**
   * Slice 15——刷新每个运行中、绑定 tmux 的席位观测。
   * 由 `start(intervalMs, db)` 按 tick 驱动；调用方也可在测试或单次刷新时直接调用。
   */
  async pollAllRunningTmuxSeats(db: Database.Database): Promise<void> {
    // 单次飞行，并保持到读取结算：已有 sweep 执行时绝不启动新 sweep，因此缓慢/卡住的 tmux
    // 不会积累重叠的全队列 window-activity sweep，任一时刻最多执行一次。这里只抑制重叠；
    // 不重叠的 tick 照常运行，不改变频率与活动新鲜度语义。
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const rows = db.prepare(`
        SELECT s.session_name as session_name, n.id as node_id, n.runtime as runtime
        FROM nodes n
        JOIN sessions s ON s.node_id = n.id
          AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
        LEFT JOIN bindings b ON b.node_id = n.id
        WHERE s.status = 'running'
          AND s.session_name IS NOT NULL
          AND COALESCE(b.attachment_type, 'tmux') = 'tmux'
      `).all() as Array<{ session_name: string; node_id: string; runtime: string | null }>;

      // S19：每个运行中的 tmux 席位都会获得阶梯绑定；未声明席位根据其运行时清单自动声明
      //（claude 为 authoritative standing、codex hooks 为 trial、通用 sampling 为底线），
      // 不修改启动机制即可达到生产完整性。
      for (const r of rows) {
        const known = this.ladder.get(r.node_id);
        if (!known || known.inventory === null) {
          this.declareRungInventory(
            { seatNodeId: r.node_id, sessionName: r.session_name },
            runtimeRungInventory(r.runtime),
          );
        }
      }

      // 删除不再运行席位的观测，以释放内存并避免 `getSeatActivity` 读取陈旧数据。
      const live = new Set(rows.map((r) => r.session_name));
      for (const pane of Array.from(this.latestByPaneId.keys())) {
        if (!live.has(pane)) this.latestByPaneId.delete(pane);
      }

      // 尽力而为：单个席位失败不会使循环崩溃。
      await Promise.all(rows.map(async (r) => {
        try { await this.pollSeat(r.session_name); } catch { /* swallow */ }
      }));
    } finally {
      this.sweeping = false;
    }
  }

  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * 启动调度器。每隔 `intervalMs` 轮询一次每个运行中、绑定 tmux 的席位。
   * 此操作幂等，调用两次不会重复启动。
   */
  start(db: Database.Database, intervalMs: number = DEFAULT_POLL_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollAllRunningTmuxSeats(db);
    }, intervalMs);
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  /** 停止调度器；可在启动前调用，也可重复调用。 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── S19（OPR.0.5.5.19）：sampler 之上的分级证据阶梯 ──
  // 禁止推断契约保持不变：下方逻辑均不读取队列/分派状态；parked join 位于
  // parked-query 表面，绝不在此实现。

  private readonly ladder = new Map<string, SeatLadderState>();
  private readonly sessionToSeat = new Map<string, string>();
  private readonly healthListeners: Array<(event: RungHealthEvent) => void> = [];
  private readonly samplerSeqBySession = new Map<string, number>();

  /** 适配器（或占用者切换）声明此席位的来源负责哪些层级。绑定把持久席位 nodeId
   * 与当前窗格/会话名称关联，使内部 sampler 可为该席位填充 window-sampling 层级。 */
  declareRungInventory(
    binding: { seatNodeId: string; sessionName: string },
    inventory: AdapterRungInventory,
  ): void {
    const seat = this.seatLadder(binding.seatNodeId, binding.sessionName);
    seat.sessionName = binding.sessionName;
    this.sessionToSeat.set(binding.sessionName, binding.seatNodeId);
    seat.inventory = inventory;
    seat.trust.clear();
    for (const decl of inventory.rungs) seat.trust.set(decl.rung, decl.initialTrust);
    seat.promotion.clear();
    this.arbitrate(seat);
  }

  /** 适配器推送层级证据（hooks、self-report、chrome、sampling）。每个来源使用单调 seq：
   * 陈旧或乱序报告会被丢弃；迟到的低 seq 事件绝不会重新激活空闲席位
   *（服务层的 SubagentStop 类问题）。 */
  reportEvidence(evidence: ActivityEvidence): void {
    const seat = this.seatLadder(evidence.seatNodeId, evidence.sessionName);
    this.sessionToSeat.set(evidence.sessionName, evidence.seatNodeId);
    const prior = seat.sources.get(evidence.sourceId);
    if (prior && evidence.seq <= prior.latest.seq) return; // stale/reordered — dropped
    seat.sources.set(evidence.sourceId, {
      latest: evidence,
      latestActivity: evidence.activity !== undefined ? evidence : prior?.latestActivity ?? null,
    });
    this.measureTrialAgreement(seat, evidence);
    this.arbitrate(seat);
  }

  /** 交接/代际切换：它拥有独立的可见事件，绝不是活动转换。证据、去抖、矛盾与提升状态
   * 都会清除；每个已知层级的信任度降为 `absent`，直到继任者适配器重新声明其清单
   *（AM-1 推论：继任者绝不继承层级权威）。 */
  declareOccupantSwap(seatNodeId: string, generation: string): void {
    const seat = this.ladder.get(seatNodeId);
    if (!seat) return;
    seat.sources.clear();
    seat.pendingIdle = null;
    seat.contradictionSinceMs = null;
    seat.promotion.clear();
    for (const rung of seat.trust.keys()) seat.trust.set(rung, "absent");
    seat.inventory = null;
    const at = this.now().toISOString();
    seat.arbitrated = {
      ...seat.arbitrated,
      activity: "unknown",
      needsInput: { count: 0, reason: null },
      decidedBy: null,
      seq: seat.arbitrated.seq + 1, // the swap IS a visible event
      changedAt: at,
      rungs: this.rungsView(seat),
      lastSwap: { generation, at },
    };
    this.resolveWaiters(seat);
    this.emitActivityChanged(seat); // the swap is a visible push too
  }

  /** 此席位当前是否有已声明的层级清单。切换会清除它；继任者必须重新声明，
   * 各层级才能恢复任何信任。 */
  hasRungInventory(seatNodeId: string): boolean {
    return this.ladder.get(seatNodeId)?.inventory != null;
  }

  /** 按当前会话名称解析（便于投影）；状态本身仍按持久席位 nodeId 索引。 */
  getSeatStateBySession(sessionName: string): ArbitratedSeatState | null {
    const seatNodeId = this.sessionToSeat.get(sessionName);
    return seatNodeId ? this.getSeatState(seatNodeId) : null;
  }

  /** 所有表面用于渲染的、已仲裁且按席位索引的状态。 */
  getSeatState(seatNodeId: string): ArbitratedSeatState | null {
    const seat = this.ladder.get(seatNodeId);
    if (!seat) return null;
    this.arbitrate(seat); // lazy re-evaluation picks up time-based expiry/caps
    return seat.arbitrated;
  }

  /** wait-after-seq 读取原语（T1 接缝，只在此暴露而不消费）：仲裁 seq 超过 `afterSeq` 时完成；
   * 快速穿过的转换仍满足等待，这是防丢唤醒守卫。超时返回 null，绝不抛错。 */
  waitForSeatState(
    seatNodeId: string,
    opts: { afterSeq: number; timeoutMs: number },
  ): Promise<ArbitratedSeatState | null> {
    const seat = this.ladder.get(seatNodeId);
    if (!seat) return Promise.resolve(null);
    if (seat.arbitrated.seq > opts.afterSeq) return Promise.resolve(seat.arbitrated);
    return new Promise((resolve) => {
      const waiter: SeatWaiter = {
        afterSeq: opts.afterSeq,
        resolve,
        timer: setTimeout(() => {
          seat.waiters = seat.waiters.filter((w) => w !== waiter);
          resolve(null);
        }, opts.timeoutMs),
      };
      if (typeof waiter.timer === "object" && "unref" in waiter.timer) waiter.timer.unref();
      seat.waiters.push(waiter);
    });
  }

  /** 层级健康转换（AM-1）：降级与提升均明确可见，绝不静默。 */
  onRungHealth(listener: (event: RungHealthEvent) => void): void {
    this.healthListeners.push(listener);
  }

  private seatLadder(seatNodeId: string, sessionName: string): SeatLadderState {
    let seat = this.ladder.get(seatNodeId);
    if (!seat) {
      seat = {
        sessionName,
        inventory: null,
        sources: new Map(),
        trust: new Map(),
        promotion: new Map(),
        contradictionSinceMs: null,
        pendingIdle: null,
        waiters: [],
        arbitrated: {
          seatNodeId,
          activity: "unknown",
          needsInput: { count: 0, reason: null },
          decidedBy: null,
          seq: 0,
          changedAt: this.now().toISOString(),
          rungs: [],
          lastSwap: null,
        },
      };
      this.ladder.set(seatNodeId, seat);
    }
    return seat;
  }

  /** 层级信任：存在清单时采用声明的信任级别；没有声明时，通用 tmux 底线
   *（window-sampling）具有权威性，其他来源仅用于身份识别；默认如实反映部分覆盖。 */
  private rungTrust(seat: SeatLadderState, rung: EvidenceRungId): RungTrust {
    const declared = seat.trust.get(rung);
    if (declared) return declared;
    if (seat.inventory) return "absent"; // declared inventory, undeclared rung
    return rung === "window-sampling" ? "authoritative" : "identity-only";
  }

  /** 某层级的最新证据。kind "activity" 返回最新携带活动状态的证据；同一来源仅含 needs-input
   * 的事件（例如 turn 中途的 PermissionRequest）不得抹去该来源最近报告的 working/idle。 */
  private latestByRung(
    seat: SeatLadderState,
    rung: EvidenceRungId,
    kind: "any" | "activity" = "any",
  ): ActivityEvidence | null {
    let best: ActivityEvidence | null = null;
    for (const entry of seat.sources.values()) {
      const evd = kind === "activity" ? entry.latestActivity : entry.latest;
      if (!evd || evd.rung !== rung) continue;
      if (!best || evd.seq > best.seq) best = evd;
    }
    return best;
  }

  /** AM-2：TRIAL 层级的证据与当前权威候选值（原始阶梯判定、去抖前）比较，即证据对证据，
   * 绝不与去抖后的展示比较。在至少最小窗口内达到足够一致次数后，层级会明确提升为 authoritative。 */
  private measureTrialAgreement(seat: SeatLadderState, evidence: ActivityEvidence): void {
    if (evidence.activity === undefined) return;
    if (this.rungTrust(seat, evidence.rung) !== "trial") return;
    const authority = this.rawCandidate(seat, { excludeRung: evidence.rung });
    if (!authority || authority.activity === undefined) return;
    const entry = seat.promotion.get(evidence.rung) ?? { agreements: 0, firstAgreementAtMs: null };
    if (authority.activity === evidence.activity) {
      entry.agreements += 1;
      if (entry.firstAgreementAtMs === null) entry.firstAgreementAtMs = this.now().getTime();
      const spanMs = this.now().getTime() - (entry.firstAgreementAtMs ?? 0);
      if (entry.agreements >= RUNG_PROMOTION_AGREEMENT_COUNT && spanMs >= RUNG_PROMOTION_MIN_WINDOW_MS) {
        seat.trust.set(evidence.rung, "authoritative");
        this.emitRungHealth(seat, evidence.rung, evidence.sourceId, "trial", "authoritative",
          `promoted: ${entry.agreements} agreeing observations over ${Math.round(spanMs / 60000)}min (threshold ${RUNG_PROMOTION_AGREEMENT_COUNT} over ${Math.round(RUNG_PROMOTION_MIN_WINDOW_MS / 60000)}min)`);
        seat.promotion.delete(evidence.rung);
        return;
      }
    } else {
      entry.agreements = 0; // agreement must be consecutive within the measured window
      entry.firstAgreementAtMs = null;
    }
    seat.promotion.set(evidence.rung, entry);
  }

  /** working/idle 的原始阶梯判定：选择具备窗口内可用证据的最高权威层级。
   * hook 证据有时间边界（唯一不会自行记录生命周期日期的层级）；过期 hook 证据向下回退，绝不报错。 */
  private rawCandidate(seat: SeatLadderState, opts: { excludeRung?: EvidenceRungId } = {}): ActivityEvidence | null {
    const nowMs = this.now().getTime();
    for (const rung of EVIDENCE_RUNG_RANK) {
      if (rung === opts.excludeRung) continue;
      if (this.rungTrust(seat, rung) !== "authoritative") continue;
      const evd = this.latestByRung(seat, rung, "activity");
      if (!evd || evd.activity === undefined) continue;
      if (rung === "lifecycle-hooks" && nowMs - Date.parse(evd.observedAt) > HOOK_AUTHORITY_WINDOW_MS) continue;
      return evd;
    }
    return null;
  }

  private emitRungHealth(
    seat: SeatLadderState,
    rung: EvidenceRungId,
    sourceId: string,
    from: RungTrust,
    to: RungTrust,
    reason: string,
  ): void {
    const event: RungHealthEvent = {
      seatNodeId: seat.arbitrated.seatNodeId,
      rung,
      sourceId,
      from,
      to,
      reason,
      at: this.now().toISOString(),
    };
    for (const listener of this.healthListeners) listener(event);
    this.eventBus?.emit({ type: "seat.rung_health", ...event } as never);
  }

  /** AM-1：持续的跨层级矛盾（hook 声称 working，而更低的权威层级在规定窗口之外观测到
   * idle-at-prompt）会明确把 hook 层级降为 identity-only；仲裁绝不能让静默失效的来源保持权威。 */
  private checkContradiction(seat: SeatLadderState): void {
    if (this.rungTrust(seat, "lifecycle-hooks") !== "authoritative") return;
    const hook = this.latestByRung(seat, "lifecycle-hooks", "activity");
    const sampler = this.latestByRung(seat, "window-sampling", "activity");
    const nowMs = this.now().getTime();
    const hookFresh = hook && hook.activity !== undefined
      && nowMs - Date.parse(hook.observedAt) <= HOOK_AUTHORITY_WINDOW_MS;
    const contradicts = hookFresh && hook!.activity === "working"
      && sampler?.activity === "idle-at-prompt"
      && this.rungTrust(seat, "window-sampling") === "authoritative";
    if (!contradicts) {
      seat.contradictionSinceMs = null;
      return;
    }
    if (seat.contradictionSinceMs === null) {
      seat.contradictionSinceMs = nowMs;
      return;
    }
    if (nowMs - seat.contradictionSinceMs > CROSS_RUNG_CONTRADICTION_WINDOW_MS) {
      seat.trust.set("lifecycle-hooks", "identity-only");
      seat.contradictionSinceMs = null;
      this.emitRungHealth(seat, "lifecycle-hooks", hook!.sourceId, "authoritative", "identity-only",
        `cross-rung contradiction: hook claims working while window-sampling sees idle-at-prompt beyond ${CROSS_RUNG_CONTRADICTION_WINDOW_MS / 1000}s — degraded to identity-only (a silently-dropping source can never stay authoritative)`);
    }
  }

  private rungsView(seat: SeatLadderState): ArbitratedSeatState["rungs"] {
    const rungIds = new Set<EvidenceRungId>();
    if (seat.inventory) for (const d of seat.inventory.rungs) rungIds.add(d.rung);
    for (const r of seat.trust.keys()) rungIds.add(r);
    return [...rungIds].map((rung) => {
      const evd = this.latestByRung(seat, rung);
      return {
        rung,
        sourceId: evd?.sourceId ?? `${seat.inventory?.adapterId ?? "undeclared"}:${rung}`,
        trust: this.rungTrust(seat, rung),
        lastEvidenceAt: evd?.observedAt ?? null,
      };
    });
  }

  /** 重新计算仲裁状态。去抖规则：由 sampling 判定的 working→idle 转换会保持到达到规定的
   * 连续 idle 观测数或硬上限；权威 turn 边界（hooks/self-report idle）或 idle chrome 立即发布。
   * 该规则依据 1Hz/3s 频率选择：3 秒静默窗口已吸收小于 3 秒的停顿，2 tick 仲裁去抖再吸收
   * 窗口边界抖动。 */
  private arbitrate(seat: SeatLadderState): void {
    this.checkContradiction(seat);
    const candidate = this.rawCandidate(seat);
    let nextActivity: ActivityValue = candidate?.activity ?? "unknown";
    let decidedBy: EvidenceRungId | null = candidate?.rung ?? null;

    // 去抖计数直接基于 sampling 观测运行，与当前由哪个层级决策无关：仲裁状态为 working 时，
    // 连续 idle 观测会累积；任何 sampling `working` 都会重置。保持只在 sampling 将决定翻转时生效；
    // 权威 turn 边界（hooks 或 self-report idle）以及 idle chrome 会立即绕过。
    const nowMs = this.now().getTime();
    const sampling = this.latestByRung(seat, "window-sampling");
    if (seat.arbitrated.activity === "working" && sampling?.activity === "idle-at-prompt") {
      if (!seat.pendingIdle) {
        seat.pendingIdle = { sinceMs: nowMs, ticks: 1, lastSeq: sampling.seq };
      } else if (sampling.seq > seat.pendingIdle.lastSeq) {
        seat.pendingIdle.ticks += 1;
        seat.pendingIdle.lastSeq = sampling.seq;
      }
    } else if (sampling?.activity === "working" || seat.arbitrated.activity !== "working") {
      seat.pendingIdle = null;
    }
    if (candidate?.rung === "window-sampling" && candidate.activity === "idle-at-prompt"
        && seat.arbitrated.activity === "working" && seat.pendingIdle) {
      const capped = nowMs - seat.pendingIdle.sinceMs >= SAMPLING_IDLE_DEBOUNCE_CAP_MS;
      if (seat.pendingIdle.ticks < SAMPLING_IDLE_DEBOUNCE_TICKS && !capped) {
        nextActivity = "working"; // held — the mid-turn lull must not flip the state
        decidedBy = seat.arbitrated.decidedBy;
      } else {
        seat.pendingIdle = null;
      }
    }

    // needs-input：可见 chrome 优先于 hook 携带的证据；PermissionRequest 类事件触发时 hook 携带它，
    // 下一个 turn 边界清除。它不像 working/idle 的 hook 权威那样受时间限制；未回答的阻塞持续存在，
    // 正是创始人观察到的 park 原因，必须保持可见。
    const chrome = this.latestByRung(seat, "needs-input-chrome");
    const hooksEv = this.latestByRung(seat, "lifecycle-hooks");
    const selfEv = this.latestByRung(seat, "self-report");
    const needsInput: NeedsInputShape =
      chrome?.needsInput && this.rungTrust(seat, "needs-input-chrome") === "authoritative"
        ? chrome.needsInput
        : hooksEv?.needsInput && this.rungTrust(seat, "lifecycle-hooks") === "authoritative"
          ? hooksEv.needsInput
          : selfEv?.needsInput && this.rungTrust(seat, "self-report") === "authoritative"
            ? selfEv.needsInput
            : { count: 0, reason: null };

    const changed = nextActivity !== seat.arbitrated.activity
      || needsInput.count !== seat.arbitrated.needsInput.count
      || needsInput.reason !== seat.arbitrated.needsInput.reason;
    seat.arbitrated = {
      ...seat.arbitrated,
      activity: nextActivity,
      needsInput,
      decidedBy,
      seq: changed ? seat.arbitrated.seq + 1 : seat.arbitrated.seq,
      changedAt: changed ? this.now().toISOString() : seat.arbitrated.changedAt,
      rungs: this.rungsView(seat),
    };
    if (changed) {
      this.resolveWaiters(seat);
      this.emitActivityChanged(seat);
    }
  }

  /** AM-R18 推送底座：把变更通知（identity + seq）发送到总线，由 SSE stream 转发；
   * 消费方从投影重新获取，因此推送本身绝不携带派生词汇（结构上不存在第二套活动机制）。 */
  private emitActivityChanged(seat: SeatLadderState): void {
    this.eventBus?.emit({
      type: "seat.activity_changed",
      seatNodeId: seat.arbitrated.seatNodeId,
      sessionName: seat.sessionName,
      seq: seat.arbitrated.seq,
      at: seat.arbitrated.changedAt,
    } as never);
  }

  private resolveWaiters(seat: SeatLadderState): void {
    const ready = seat.waiters.filter((w) => seat.arbitrated.seq > w.afterSeq);
    seat.waiters = seat.waiters.filter((w) => seat.arbitrated.seq <= w.afterSeq);
    for (const w of ready) {
      clearTimeout(w.timer);
      w.resolve(seat.arbitrated);
    }
  }
}

interface SeatWaiter {
  afterSeq: number;
  resolve: (s: ArbitratedSeatState | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface NeedsInputShape {
  count: number;
  reason: string | null;
}

interface SeatLadderState {
  sessionName: string;
  inventory: AdapterRungInventory | null;
  sources: Map<string, { latest: ActivityEvidence; latestActivity: ActivityEvidence | null }>;
  trust: Map<EvidenceRungId, RungTrust>;
  promotion: Map<EvidenceRungId, { agreements: number; firstAgreementAtMs: number | null }>;
  contradictionSinceMs: number | null;
  pendingIdle: { sinceMs: number; ticks: number; lastSeq: number } | null;
  waiters: SeatWaiter[];
  arbitrated: ArbitratedSeatState;
}

// S19 仲裁常量——依据 1Hz 轮询/3 秒静默窗口选取（SPEC 要求记录数值；理由见 GREEN commit 与参考文档）：
/** 早于此时长的 hook 证据不再决定 working/idle（有时间边界的权威）。 */
export const HOOK_AUTHORITY_WINDOW_MS = 15_000;
/** hook 与 sampler 的持续矛盾超过此窗口后，降低 hook 层级。 */
export const CROSS_RUNG_CONTRADICTION_WINDOW_MS = 10_000;
/** sampling 决定的 working→idle 需要达到此数量的连续 idle 评估…… */
export const SAMPLING_IDLE_DEBOUNCE_TICKS = 2;
/** ……并受此硬上限约束；权威 turn 边界与 idle chrome 会立即绕过。 */
export const SAMPLING_IDLE_DEBOUNCE_CAP_MS = 2_500;
/** AM-2 提升：trial 层级在达到此数量的一致观测后获得权威…… */
export const RUNG_PROMOTION_AGREEMENT_COUNT = 50;
/** ……且这些观测至少分布在此生产时间窗口内。 */
export const RUNG_PROMOTION_MIN_WINDOW_MS = 60 * 60 * 1000;
