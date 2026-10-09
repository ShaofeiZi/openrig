// Slice-04（OPR.0.5.0.4）——signals[] 归一化（§2 检测设计的代码实现）。
// 权威来源：已锁定 packet 3ffa3c22 IMPLEMENTATION-PRD §2 与 2026-07-31 RESEARCH 裁定。
// 此处强制诚实规则：feature-probe-negative 与空读取变为明确的 `unknown` 行
//（绝不静默归零，也绝不缺行）；只有真实结构化读取才是 `allow_switch_decision`（BR-2）。

import { signalEligibleForAutomation } from "./provider-policy.js";
import type { ProviderBinding, ProviderKind, ProviderSignal } from "./provider-types.js";

/** Codex app-server `account/rateLimits/read` 返回的一个 provider 原生用量窗口。 */
export interface CodexWindowReading {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: string;
}

/** 本模块消费的 Codex app-server `account/rateLimits/read` 响应子集。 */
export interface CodexRateLimitReading {
  primary?: CodexWindowReading;
  secondary?: CodexWindowReading;
}

export interface CodexSignalInput {
  accountRef: string;
  /** 针对 app-server 生成 schema 中速率限制方法的功能探测结果。 */
  probe: { supported: boolean };
  /** 仅在探测受支持且读取确实返回时存在。 */
  reading?: CodexRateLimitReading;
  asOf: string;
  staleAfter?: string;
}

export const CODEX_UNKNOWN_REASON = {
  probe_unsupported: "codex_app_server_unavailable",
  empty_reading: "codex_read_returned_no_windows",
} as const;

function codexUnknownSignal(
  accountRef: string,
  asOf: string,
  unknownReason: string,
  supportsNotification: boolean,
  staleAfter?: string,
): ProviderSignal {
  return {
    provider: "codex",
    accountRef,
    sourceClass: "unknown",
    authority: "unknown",
    asOf,
    staleAfter,
    unknownReason,
    // 未知数据不能抹去已知 transport 能力：app-server 存在但返回空值时，
    // `account/rateLimits/updated` 仍存在，因此通知能力为 true；只有 app-server
    // 不存在（探测不支持）时才为 false。
    supportsNotification,
    automationUse: "do_not_automate",
    // 有意省略 usedPercent / resetsAt / window：unknown 行绝不携带伪造零值
    //（BR-2 静默归零陷阱）。真实的 0 只能来自实际读取。
  };
}

/**
 * 把 Codex app-server 速率限制读取归一化为 `signals[]` 行。
 * - 不支持探测 → 一条明确的 `unknown` 行。
 * - 支持但无窗口 → 一条明确的 `unknown` 行（绝不伪造零值）。
 * - 支持且有窗口 → 每个 provider 原生窗口一条 `provider_structured_read` 行，
 *   保留原生 primary/secondary 区别。
 */
export function codexRateLimitSignals(input: CodexSignalInput): ProviderSignal[] {
  const { accountRef, probe, reading, asOf, staleAfter } = input;

  if (!probe.supported) {
    // app-server 不存在时没有通知 transport。
    return [codexUnknownSignal(accountRef, asOf, CODEX_UNKNOWN_REASON.probe_unsupported, false, staleAfter)];
  }

  const windows: Array<[Extract<ProviderSignal["window"], "primary" | "secondary">, CodexWindowReading | undefined]> = [
    ["primary", reading?.primary],
    ["secondary", reading?.secondary],
  ];

  const rows: ProviderSignal[] = [];
  for (const [window, w] of windows) {
    if (!w) continue;
    rows.push({
      provider: "codex",
      accountRef,
      sourceClass: "provider_structured_read",
      authority: "account_cross_device",
      window,
      usedPercent: w.usedPercent,
      resetsAt: w.resetsAt,
      windowDurationMins: w.windowDurationMins,
      asOf,
      staleAfter,
      supportsNotification: true, // Codex app-server carries account/rateLimits/updated
      automationUse: "allow_switch_decision",
    });
  }

  if (rows.length === 0) {
    // app-server 存在但没有返回窗口 → 数据未知；但 transport 能力
    //（account/rateLimits/updated）已知存在，因此 supportsNotification 保持 true。
    return [codexUnknownSignal(accountRef, asOf, CODEX_UNKNOWN_REASON.empty_reading, true, staleAfter)];
  }
  return rows;
}

// ── Claude statusline 通道 ──────────────────────────────────────────────────────────────
// Claude Code statusline sidecar 把文档化的 `rate_limits` 对象（Pro/Max 五小时与七天
// used_percentage 及重置时间戳）写入原子缓存，后台服务从中读取。`rate_limits` 仅适用于 Pro/Max，
// 首次 API 响应前不存在；这些缺失情况转为明确的 unknown 行，以满足诚实判定要求。
// Claude statusline 不带推送 transport，因此此处 supportsNotification 始终为 false。

/** statusline `rate_limits` 对象中的一个 Claude 订阅窗口。 */
export interface ClaudeStatuslineWindow {
  usedPercent: number;
  resetsAt: string;
}

export interface ClaudeStatuslineReading {
  five_hour?: ClaudeStatuslineWindow;
  seven_day?: ClaudeStatuslineWindow; // 归一化为 "weekly" 窗口
}

export interface ClaudeSignalInput {
  /** Claude statusline 携带会话身份，但没有可信的账户身份（Option A）。 */
  seatSession: string;
  /** false 表示 statusline 缓存尚未写入（首次 API 响应前）。 */
  cachePresent: boolean;
  /** 仅当缓存存在且携带 rate_limits 对象时存在。 */
  reading?: ClaudeStatuslineReading;
  asOf: string;
  staleAfter?: string;
}

export const CLAUDE_UNKNOWN_REASON = {
  no_statusline_cache_yet: "claude_no_statusline_cache_yet",
  empty_reading: "claude_statusline_cache_had_no_windows",
} as const;

function claudeUnknownSignal(
  seatSession: string,
  asOf: string,
  unknownReason: string,
  staleAfter?: string,
): ProviderSignal {
  return {
    provider: "claude",
    seatSession,
    sourceClass: "unknown",
    authority: "unknown",
    asOf,
    staleAfter,
    unknownReason,
    supportsNotification: false, // Claude statusline has no push transport
    automationUse: "do_not_automate",
    // 省略 usedPercent / resetsAt / window，绝不伪造零值。
  };
}

/**
 * 把 Claude statusline `rate_limits` 读取归一化为 `signals[]` 行。
 * - 首次响应前的席位（无缓存）→ 明确的 unknown 行。
 * - 带订阅窗口的席位 → 每个窗口一条 `provider_statusline` 行（five_hour，
 *   seven_day 归一化为 "weekly"）；真实的 0 保持为 0。
 * - 有缓存但无窗口的订阅 → 明确的 unknown 行（绝不伪造零值）。
 */
export function claudeStatuslineSignals(input: ClaudeSignalInput): ProviderSignal[] {
  const { seatSession, cachePresent, reading, asOf, staleAfter } = input;

  if (!cachePresent) {
    return [claudeUnknownSignal(seatSession, asOf, CLAUDE_UNKNOWN_REASON.no_statusline_cache_yet, staleAfter)];
  }

  const windows: Array<["five_hour" | "weekly", ClaudeStatuslineWindow | undefined]> = [
    ["five_hour", reading?.five_hour],
    ["weekly", reading?.seven_day],
  ];

  const rows: ProviderSignal[] = [];
  for (const [window, w] of windows) {
    if (!w) continue;
    rows.push({
      provider: "claude",
      seatSession,
      sourceClass: "provider_statusline",
      authority: "account_cross_device", // Claude.ai Pro/Max 订阅窗口属于账户级
      window,
      usedPercent: w.usedPercent,
      resetsAt: w.resetsAt,
      asOf,
      staleAfter,
      supportsNotification: false, // no push unless OpenRig later supplies a cache-update event
      automationUse: "allow_switch_decision",
    });
  }

  if (rows.length === 0) {
    return [claudeUnknownSignal(seatSession, asOf, CLAUDE_UNKNOWN_REASON.empty_reading, staleAfter)];
  }
  return rows;
}

// ── Reactive 通道（两个 provider）──────────────────────────────────────────────────────
// 到达上限错误、stream 失败与 stop-error 事件会立即作为 sourceClass=provider_event、
// authority=reactive_error 消费。它们是资源耗尽证据，不是剩余额度计量，因此绝不携带 usedPercent。
// at-limit 事件是真实的耗尽触发器（allow_switch_decision）；stream/stop 错误只提供建议上下文。

export type ReactiveEventKind = "at_limit" | "stream_failure" | "stop_error";

export interface ReactiveEventInput {
  provider: ProviderKind;
  accountRef: string;
  kind: ReactiveEventKind;
  asOf: string;
  // 必填：没有新鲜度边界的 reactive 事件永远无法通过 BR-2，瞬时事件必须携带过期时间。
  // 是否陈旧仍由共享谓词判断。
  staleAfter: string;
}

export function reactiveEventSignal(input: ReactiveEventInput): ProviderSignal {
  return {
    provider: input.provider,
    accountRef: input.accountRef,
    sourceClass: "provider_event",
    authority: "reactive_error",
    asOf: input.asOf,
    staleAfter: input.staleAfter,
    // 省略 supportsNotification：它描述逐账户 transport 能力（Codex
    // account/rateLimits/updated 为 true，Claude statusline 为 false/unknown）。通用 reactive
    // 事件无法证明该能力，硬编码 false 会造成伪造。at-limit 耗尽可触发切换；stream/stop 错误只作建议。
    automationUse: input.kind === "at_limit" ? "allow_switch_decision" : "advisory_only",
    // 不提供 usedPercent：reactive 事件是耗尽证据，不是剩余额度计量。
  };
}

// ── 用量限制池投影 ────────────────────────────────────────────────────────────────────

export interface UsageLimitPool {
  poolKey: string;
  provider: ProviderKind;
  seatSessions: string[];
  expiresAt: string;
  source: "provider-reset" | "config-fallback";
}

/**
 * 根据新鲜的结构化耗尽证据派生 provider/account 池。Claude statusline 没有账户引用，
 * 因此其已交付的“每主机一个账户”不变量形成一个本地池；Codex 使用现有账户绑定。
 * unknown、陈旧、建议性、未绑定或已过期的证据都不能创建 park。
 */
export function deriveUsageLimitPools(input: {
  signals: ProviderSignal[];
  bindings: ProviderBinding[];
  now: Date;
  fallbackSeconds: number;
}): UsageLimitPool[] {
  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs)) return [];

  const eligible = input.signals.filter(
    (signal) => signalEligibleForAutomation(signal, input.now.toISOString()).eligible,
  );
  const exhausted = eligible.filter(
    (signal) =>
      (typeof signal.usedPercent === "number" && signal.usedPercent >= 100) ||
      (signal.sourceClass === "provider_event" && signal.authority === "reactive_error"),
  );

  const pools = new Map<string, { provider: ProviderKind; signals: ProviderSignal[] }>();
  for (const signal of exhausted) {
    const poolKey = signal.provider === "claude"
      ? "claude:local"
      : signal.accountRef
        ? `codex:${signal.accountRef}`
        : null;
    if (!poolKey) continue;
    const pool = pools.get(poolKey) ?? { provider: signal.provider, signals: [] };
    pool.signals.push(signal);
    pools.set(poolKey, pool);
  }

  const result: UsageLimitPool[] = [];
  for (const [poolKey, pool] of pools) {
    const statedResets = pool.signals
      .map((signal) => Date.parse(signal.resetsAt ?? ""))
      .filter((value) => Number.isFinite(value) && value > nowMs);
    const fallbackResets = pool.provider === "codex"
      ? pool.signals
          .map((signal) => Date.parse(signal.asOf) + input.fallbackSeconds * 1000)
          .filter((value) => Number.isFinite(value) && value > nowMs)
      : [];
    const expiryMs = statedResets.length > 0
      ? Math.max(...statedResets)
      : fallbackResets.length > 0
        ? Math.max(...fallbackResets)
        : null;
    if (expiryMs === null) continue;

    const seatSessions = pool.provider === "claude"
      ? input.signals
          .filter((signal) => signal.provider === "claude" && typeof signal.seatSession === "string")
          .map((signal) => signal.seatSession!)
      : input.bindings
          .filter((binding) => binding.accountId === pool.signals[0]!.accountRef)
          .map((binding) => binding.seatSession);
    const uniqueSeats = [...new Set(seatSessions)].sort();
    if (uniqueSeats.length === 0) continue;
    result.push({
      poolKey,
      provider: pool.provider,
      seatSessions: uniqueSeats,
      expiresAt: new Date(expiryMs).toISOString(),
      source: statedResets.length > 0 ? "provider-reset" : "config-fallback",
    });
  }
  return result.sort((a, b) => a.poolKey.localeCompare(b.poolKey));
}
