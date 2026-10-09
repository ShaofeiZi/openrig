// B8 / slice-07 A3——模型偏差检测器 + 四通道公告（创始人裁定）。
//
// 检测偏差，而不是枚举原因（PM 裁定）：在最早的可靠读取点，只比较运行时的 EFFECTIVE model
// 与席位的 PINNED model。样本 #1 是 model-invalid（400 后静默降级），样本 #2 是 environment-invalid
//（缺少 --add-dir 导致 tier 降级）；400 handler 只能捕获前者，而该比较能捕获两者。已知的原因字符串
// 只作为 DIAGNOSIS 随公告传递，绝不作为触发条件。
//
// “AT READINESS”的运行语义：拥有 pin 的席位出现 occupant generation 时开始监测，在首次可靠读取
// effective model 时触发。Claude 席位在 ready 时还没有 assistant turn，因此 effective signal 尚不存在；
// 监控器会持续轮询，每个 generation 在运行时产生 signal 前保持 PENDING，之后每个 generation
// 恰好给出一个 verdict。every-occurrence 语义以 generation 为粒度：偏差席位的每个新 occupant 都会
// 再次公告（创始人将其归为 every-occurrence，而非 digest），同一 generation 则绝不刷屏。
//
// 四个通道遵循 desk 于 2026-08-21 的目标裁定：orchestrator = 席位所属工作组的 orch.* 席位；
// operator = 从工作区 operator 配置解析出的席位（派生而非硬编码，可能跨主机）；oversight = fleet
// oversight judgment 席位（通过已注册路由跨主机）；human-via-Slack = 在 M1 gateway 契约落地前的
// 具名延期（`deferred: M1 not landed`），不设影子路径。每个通道的投递 OUTCOME 都记录在公告事件上；
// 通道不可达时必须具名失败或延期，绝不静默。

import { createHash } from "node:crypto";
import { CANONICAL_MODEL_PINS } from "../spec-validation-advisory.js";

export interface PinnedSeat {
  nodeId: string;
  sessionName: string;
  rigId: string;
  rigName: string;
  runtime: string | null;
  pinnedModel: string;
  /** Occupant generation；null 表示未知，此时回退到 sessionName 粒度。 */
  generation: string | null;
}

export interface ChannelOutcome {
  channel: "orchestrator" | "operator" | "oversight" | "slack";
  target: string | null;
  status: "delivered" | "failed" | "deferred" | "retained";
  detail?: string;
}

export interface ModelDivergenceProclamation {
  nodeId: string;
  sessionName: string;
  rigId: string;
  rigName: string;
  runtime: string | null;
  pinnedModel: string;
  effectiveModel: string;
  diagnosis: string | null;
  detectedAt: string;
  channels: ChannelOutcome[];
}

/** D-a——effective read 的每种无结果 outcome 都携带具名原因，并且可以异步完成
 *  （current-generation join 会读取实时 process table）。 */
export type EffectiveModelRead = { ok: true; model: string } | { ok: false; reason: string };

export interface ModelDivergenceMonitorDeps {
  /** 所有携带 model pin 且正在运行的 canonical 席位，即检测器的完整总体。 */
  listPinnedSeats: () => PinnedSeat[];
  /** 通过 CURRENT GENERATION 自身记录执行逐运行时 effective read（D-a：绝不使用可能静默跨越
   *  generation 边界的 name/token lookup）。无结果 = 具名原因 = pending。OPR.0.5.3.10 mini-req 1：
   *  传入 `cycle` 时，它携带 POLL-SCOPED process lister；每轮为所有席位共享一次 census，
   *  绝不对每个席位单独执行 `ps`。 */
  readEffectiveModel: (
    seat: PinnedSeat,
    cycle?: { listProcesses: () => Promise<Array<{ pid: number; ppid: number; command: string }>> },
  ) => Promise<EffectiveModelRead> | EffectiveModelRead;
  /** OPR.0.5.3.10——共享 census。存在时，checkOnce() 将 cycle-scoped lister 传给每次
   *  readEffectiveModel 调用；采用惰性执行，若本轮所有席位均已 settled，则不会生成进程。 */
  processCensus?: { cycleLister(): () => Promise<Array<{ pid: number; ppid: number; command: string }>> };
  /** 后台服务内向会话发送消息，即 watchdog 投递接缝。 */
  sendToSession: (sessionName: string, message: string, occurrenceId?: string) => Promise<{ ok: boolean; error?: string; outcome?: string }>;
  /** 席位所属工作组的 orchestrator 席位（会话名）。 */
  resolveOrchSeats: (rigName: string) => string[];
  /** 已配置的 operator 席位；从配置派生，绝不硬编码。null 表示未配置。 */
  resolveOperatorSeat: () => string | null;
  /** fleet oversight judgment 席位（跨主机目标）；无法路由时为 null。 */
  resolveOversightSeat: () => string | null;
  /** 公告及其逐通道 outcome 的持久记录。 */
  recordProclamation: (p: ModelDivergenceProclamation) => void;
  /** 已知拒绝 signal 时的可选原因字符串；只用于 diagnosis，绝不是触发条件。 */
  diagnose?: (seat: PinnedSeat) => string | null;
  now?: () => Date;
  warn?: (message: string) => void;
}

export const SLACK_DEFERRAL_LINE = "human-via-Slack：已延期，M1 尚未落地";

/** 有 pin 的 generation 在被显著标记为“未检查”前，允许连续无 signal 的轮询次数。 */
export const PENDING_VISIBILITY_POLLS = 10;

export function formatProclamation(p: Omit<ModelDivergenceProclamation, "channels">): string {
  return [
    `${p.sessionName} 出现模型偏差：pinned=${p.pinnedModel} effective=${p.effectiveModel}`,
    `该席位仍在运行（保持优雅降级），但使用的是无人选择的模型。`,
    p.diagnosis ? `诊断（仅供参考）：${p.diagnosis}` : `诊断：未捕获原因；偏差本身就是触发条件。`,
    `检测时间 ${p.detectedAt}（runtime ${p.runtime ?? "unknown"}，node ${p.nodeId}）。`,
  ].join("\n");
}

export class ModelDivergenceMonitor {
  /** 已给出唯一 verdict 的 generation（匹配或已公告偏差）。 */
  private readonly settled = new Set<string>();
  /** r1 B8 finding——可观测 PENDING：每个 generation 连续无 signal 的轮询次数。检测静默是比
   *  channel 静默低一层的失败类别：始终无法读取 effective model 的席位必须显式显示为未检查，
   *  不能因裸 continue 而永久跳过。 */
  private readonly pendingPolls = new Map<string, number>();
  private readonly pendingReasons = new Map<string, string>();
  private readonly pendingWarned = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly warn: (message: string) => void;

  constructor(private readonly deps: ModelDivergenceMonitorDeps) {
    this.warn = deps.warn ?? ((m) => console.warn(m));
  }

  startPolling(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.checkOnce().catch((err) => this.warn(`[model-divergence] 检查失败：${err instanceof Error ? err.message : String(err)}`));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 当前 pending 的 pinned generation（尚无 effective read）及其轮询次数；这是 detection-pending
   *  面向测试和未来状态界面的可观测形态。 */
  pendingSeats(): Array<{ key: string; polls: number; reason: string | null }> {
    return [...this.pendingPolls.entries()].map(([key, polls]) => ({ key, polls, reason: this.pendingReasons.get(key) ?? null }));
  }

  /** 遍历一次 pinned 总体；返回本轮触发的公告，供测试使用。 */
  async checkOnce(): Promise<ModelDivergenceProclamation[]> {
    const fired: ModelDivergenceProclamation[] = [];
    // OPR.0.5.3.10 mini-req 1——整轮最多执行一次 process census。
    const cycleList = this.deps.processCensus?.cycleLister();
    const cycle = cycleList ? { listProcesses: cycleList } : undefined;
    for (const seat of this.deps.listPinnedSeats()) {
      try {
        await this.checkSeat(seat, cycle, fired);
      } catch (err) {
        // 纵深防御（row 3f66664a）：单个席位抛错绝不能截断整轮。blocked sha 上的一次比较异常曾
        // 静默终止整个检测器。现在显著报告当前席位的检测错误并继续，确保剩余 pinned 席位仍被检查。
        // 该席位不会 settled，因此瞬时异常会在下一轮自愈，持续异常则会持续呈现，而不是静默结束检测。
        this.warn(
          `[model-divergence] 检查 ${seat.sessionName}（pin ${seat.pinnedModel}）时抛错，` +
          `本轮已跳过该席位；其余 pinned 席位仍会继续检查：` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return fired;
  }

  /** 单个席位的检查。抽取此方法，使 checkOnce 可隔离逐席位异常（纵深防御）：这里的异常按席位
   *  捕获，绝不会中止整轮；产生的公告会写入 `fired`。 */
  private async checkSeat(
    seat: PinnedSeat,
    cycle: Parameters<ModelDivergenceMonitorDeps["readEffectiveModel"]>[1],
    fired: ModelDivergenceProclamation[],
  ): Promise<void> {
    const key = `${seat.nodeId}:${seat.generation ?? seat.sessionName}`;
    if (this.settled.has(key)) return;
    const read = await this.deps.readEffectiveModel(seat, cycle);
    if (!read.ok) {
      // 保持 PENDING，绝不猜测，也绝不不可见。超过阈值后，此 generation 会被一次性具名标记为
      // 未检查（r1 实测 Codex rollout 的 signal 可能落在有界读取之外；若无此行，该席位会永久静默跳过）。
      const polls = (this.pendingPolls.get(key) ?? 0) + 1;
      this.pendingPolls.set(key, polls);
      this.pendingReasons.set(key, read.reason);
      if (polls >= PENDING_VISIBILITY_POLLS && !this.pendingWarned.has(key)) {
        this.pendingWarned.add(key);
        this.warn(
          `[model-divergence] ${seat.sessionName}（pin ${seat.pinnedModel}）经过 ${polls} 次轮询后仍无 ` +
          `effective-model 读取结果；该席位已有 pin，但尚未检查（${read.reason}）。` +
          `此处的偏差当前将不可见。`,
        );
      }
      return;
    }
    this.pendingPolls.delete(key);
    this.pendingReasons.delete(key);
    if (modelsMatch(seat.pinnedModel, read.model)) {
      this.settled.add(key);
      return;
    }
    const proclamation = await this.proclaim(seat, read.model);
    this.settled.add(key);
    fired.push(proclamation);
  }

  private async proclaim(seat: PinnedSeat, effectiveModel: string): Promise<ModelDivergenceProclamation> {
    const detectedAt = (this.deps.now?.() ?? new Date()).toISOString();
    const base = {
      nodeId: seat.nodeId,
      sessionName: seat.sessionName,
      rigId: seat.rigId,
      rigName: seat.rigName,
      runtime: seat.runtime,
      pinnedModel: seat.pinnedModel,
      effectiveModel,
      diagnosis: this.deps.diagnose?.(seat) ?? null,
      detectedAt,
    };
    const message = formatProclamation(base);
    const occurrenceId = createHash("sha256").update(JSON.stringify([seat.nodeId, seat.generation ?? seat.sessionName, seat.pinnedModel, effectiveModel])).digest("hex");
    const channels: ChannelOutcome[] = [];

    const orchSeats = this.deps.resolveOrchSeats(seat.rigName);
    if (orchSeats.length === 0) {
      channels.push({ channel: "orchestrator", target: null, status: "failed", detail: `工作组 ${seat.rigName} 中未找到 orch 席位` });
    } else {
      for (const target of orchSeats) channels.push(await this.deliver("orchestrator", target, message, occurrenceId));
    }

    const operator = this.deps.resolveOperatorSeat();
    channels.push(operator
      ? await this.deliver("operator", operator, message, occurrenceId)
      : { channel: "operator", target: null, status: "failed", detail: "未配置 operator 席位" });

    const oversight = this.deps.resolveOversightSeat();
    channels.push(oversight
      ? await this.deliver("oversight", oversight, message, occurrenceId)
      : { channel: "oversight", target: null, status: "deferred", detail: "已延期：当前主机未注册 oversight 路由" });

    // DS2（创始人锁定的 transport）：Slack 只能使用 M1 gateway 契约。M1 落地前，该通道通过具名延期
    // 显著拒绝，绝不临时拼出影子路径。
    channels.push({ channel: "slack", target: null, status: "deferred", detail: SLACK_DEFERRAL_LINE });

    const proclamation: ModelDivergenceProclamation = { ...base, channels };
    try {
      this.deps.recordProclamation(proclamation);
    } catch (err) {
      this.warn(`[model-divergence] 记录 ${seat.sessionName} 的公告失败：${err instanceof Error ? err.message : String(err)}`);
    }
    return proclamation;
  }

  private async deliver(channel: ChannelOutcome["channel"], target: string, message: string, occurrenceId: string): Promise<ChannelOutcome> {
    try {
      const res = await this.deps.sendToSession(target, message, `guard-model-${occurrenceId}-${target}`);
      if (res.outcome === "retained") return { channel, target, status: "retained", detail: "输入保护：已保留，未投递。" };
      return res.ok
        ? { channel, target, status: "delivered" }
        : { channel, target, status: "failed", detail: res.error ?? "发送失败" };
    } catch (err) {
      return { channel, target, status: "failed", detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Pin 比较：先通过唯一已交付 alias map 规范化 PIN，再 trim 后执行不区分大小写的精确比较
 *  （f7dfca0c，创始人指导）。历史记录：构建时裁定为精确比较；之后某席位改为完整 token alias
 *  匹配；r2 又将其改回，因为通用 token 包含会让一个 pin 同时放行多个不同模型（`codex` 同时匹配
 *  gpt-5.6-codex 与 gpt-5.1-codex-mini）。最终修复是 r2 裁定允许的显式、provider-aware mapping：
 *  CANONICAL_MODEL_PINS（spec-validation-advisory.ts）是唯一映射归属。spec validation 用它提示 pin
 *  采用 canonical ID，本检测器比较前也通过同一数据规范化 pinned 字符串。绝不能在此新增第二张 map，
 *  也不能使用 token 包含；未知 alias 或 fallback model 规范化为自身后仍会产生偏差。公告中的原始
 *  pinned/effective 字符串始终原样传递。 */
export function modelsMatch(pinned: string, effective: string): boolean {
  const pin = pinned.trim().toLowerCase();
  const eff = effective.trim().toLowerCase();
  const canonicalPin = (CANONICAL_MODEL_PINS[pin] ?? pin).toLowerCase();
  return canonicalPin === eff;
}
// 自到期 CLAUDE_ALIAS_MIGRATION_BRIDGE 及其 SPEC_VALIDATION_CAPABILITIES sentinel gate 已完成使命，
// 按 bridge 自身删除契约移除：5.3 advisory 已落地，bridge 已清空，f7dfca0c 用基于已交付 advisory map
// 的规范化替代了零容忍状态。
