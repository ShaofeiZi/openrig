// Slice-04（OPR.0.5.0.4）提供方中断自动化——§1 四区块读取模型。
// Schema 权威来源：已锁定 packet 3ffa3c22 IMPLEMENTATION-PRD §1 + 2026-07-31 RESEARCH verdict
// 的 signals[] normalization（逐字采纳）。字段名就是契约——schema lock 后只能增量演进。
// BR-6：accountId/profileRef 是不透明 ref，绝不是 token/header/auth-file 内容。

export type ProviderKind = "codex" | "claude";
export type AccountAuthState = "active" | "needs_reauth" | "unknown";

/** accounts[]——每个已知 provider account 一行。 */
export interface ProviderAccount {
  accountId: string; // 稳定的不透明 ref——绝不是 secret 或 token
  label: string; // 面向人类，且稳定
  provider: ProviderKind;
  authState: AccountAuthState;
  profileRef: string | null; // 若存在则为 `rig auth` profile name；unmanaged 时为 null
  asOf: string; // ISO-8601
}

import type { HostUsageRow } from "./host-usage-rollup.js";

export type BindingAnomalyKind = "same_account_on_n_seats" | "seat_with_no_account";

/**
 * 一等 binding anomaly——由 server 计算，而非 client-side 派生。discriminated union 为每个 variant
 * 精确携带锁定的 §1 字段（不添加任何字段）。
 */
export type SameAccountOnNSeatsAnomaly = {
  kind: "same_account_on_n_seats";
  count: number;
  seats: string[];
  evidence: string;
  asOf: string;
};
export type SeatWithNoAccountAnomaly = {
  kind: "seat_with_no_account";
  seat: string;
  evidence: string;
  asOf: string;
};
export type BindingAnomaly = SameAccountOnNSeatsAnomaly | SeatWithNoAccountAnomaly;

/**
 * `bindings[]` row——基于相同锁定 §1 字段名（`accountId`、`seatSession`、`rigName`、`boundAt`、
 * `bindingSource`、`anomalies`）的 discriminated bound/unbound union。bound row 的 `accountId`
 * 非 null（同时有 `boundAt`/`bindingSource`）；unbound seat 保留相同字段名，但缺失的 binding data
 * 为 `null`，且必须携带 `seat_with_no_account` anomaly——绝不伪造或使用 sentinel account。
 * discriminant 为 `accountId`（string 与 null）。
 */
export type ProviderBinding =
  | {
      accountId: string;
      seatSession: string;
      rigName: string;
      boundAt: string;
      bindingSource: string;
      anomalies: BindingAnomaly[];
    }
  | {
      accountId: null;
      seatSession: string;
      rigName: string;
      boundAt: null;
      bindingSource: null;
      // unbound seat 必须携带 seat_with_no_account anomaly——在类型层强制为非空 tuple，且首元素
      // 就是该 anomaly，使不诚实的“anomaly list 为空或只有 same-account 的 unbound row”无法编译。
      anomalies: [SeatWithNoAccountAnomaly, ...BindingAnomaly[]];
    };

export type SignalSourceClass =
  | "provider_structured_read"
  | "provider_statusline"
  | "provider_event"
  | "local_usage_attribution"
  | "community_probe"
  | "capture_fallback"
  | "unknown";

export type SignalAuthority =
  | "account_cross_device"
  | "device_local"
  | "api_workspace"
  | "reactive_error"
  | "unknown";

// 标准化 window；也允许 provider-native enum 值（诚实规则——绝不强迫 Codex/Claude 使用相同字段）。
export type SignalWindow =
  | "five_hour"
  | "weekly"
  | "primary"
  | "secondary"
  | "monthly_credit"
  | (string & {}); // provider-native

export type AutomationUse = "allow_switch_decision" | "advisory_only" | "do_not_automate";

/**
 * signals[]——research verdict 的 normalization。缺失/未知 reading 必须是显式 row
 *（`sourceClass`/`authority` = "unknown"，并设置 `unknownReason`），绝不是缺失 row，也绝不伪造
 * 为零（未知时省略 `usedPercent`）。
 */
export interface ProviderSignal {
  provider: ProviderKind;
  /** 不透明 account ref（BR-6）。Claude statusline row 省略此项：该 surface 不暴露 account identity。 */
  accountRef?: string;
  /** Claude statusline provider_usage 等以 seat 为 key 的 lane 所用 runtime seat identity。 */
  seatSession?: string;
  sourceClass: SignalSourceClass;
  authority: SignalAuthority;
  window?: SignalWindow;
  usedPercent?: number; // 未知时省略——绝不强制转成 0（BR-2 silent-zero 陷阱）
  remaining?: number; // provider 以此形式表达时的 native remaining
  resetsAt?: string;
  windowDurationMins?: number;
  asOf: string;
  staleAfter?: string;
  unknownReason?: string;
  supportsNotification?: boolean;
  automationUse: AutomationUse; // BR-2：unknown/stale/advisory 绝不为 allow_switch_decision
}

// precheck / switch（§1 + §3）
export type PrecheckReason =
  | "would_strand_live_conversation"
  | "target_needs_reauth" // target authState === "needs_reauth"
  | "target_auth_unknown" // target authState === "unknown"——fail closed，不重标为 re-auth
  | "signal_unknown_or_stale"
  | "rebind_unsupported_for_runtime";

export type PrecheckResult = { safe: true } | { safe: false; reasons: PrecheckReason[] };

export type SwitchOutcome = "succeeded" | "rebind_in_progress" | "failed_safely";

/** `rig provider status --json` 输出的完整 four-block read model。 */
export interface FourBlockReadModel {
  accounts: ProviderAccount[];
  bindings: ProviderBinding[];
  signals: ProviderSignal[];
  asOf: string;
  /** Slice-04 S-A（A2 amendment）——host-level usage rollup，增量字段：从 seat-sourced signal row
   *  聚合得到每个（host、provider）一条诚实 state row。设为 optional 以保持 sealed assembler 不变；
   *  collect layer 总会填充它。 */
  hostUsage?: HostUsageRow[];
}
