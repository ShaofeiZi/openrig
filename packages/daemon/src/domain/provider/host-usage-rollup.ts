// Slice-04 S-A（OPR.0.5.0.4，创始人重新聚焦修订 A2）——主机级用量汇总。
//
// usage 按 account 计量，且此 deployment 每个 host 运行一个 account，因此 usage-limit park 是
// host-level event。本模块将 seat-sourced signal row（C3 Claude statusline lane，sealed
// 5b56a2a4；C4 Codex reactive lane，sealed 6508330d）聚合为每个（host、provider）一条诚实
// 状态行：
//
//   ok | nearing | limited（已知 resets_at 时持续至该时刻）| explicit_unknown
//
// 三个 BINDING 诚实条件（PM pattern check，verbatim-class）：
//   (i)  host==account 是 deployment invariant，每个 row 都在 provenance 中明确说明——绝不把它
//        呈现为 source-derived account classification（C3 Option-A 标准不变：statusline 不携带
//        account identity，此处也不伪造）。Rollup key 仅为（host、provider）；row 中绝不出现
//        account id/ref。
//   (ii) 同一 host 上冲突的 seat window 会证伪该 host 的 invariant：以一等
//        `conflicting_seat_windows` anomaly + explicit_unknown host state 呈现——绝不静默 merge，
//        也绝不平均或伪造数值。冲突事实保持可见。
//   (iii) usage-limit 粒度只使用 C3 row 已携带的数据（window / usedPercent / resetsAt / asOf）——
//        不强制转换，也不虚构。Codex 尚无 remaining-meter lane（C2 是后续 seam），因此 codex
//        state 只从 fresh reactive EXHAUSTION evidence 派生；缺失时明确 unknown，绝不因静默而“ok”。
//
// single-daemon scope 就是 host scope：row 携带 host="local"（保留的 local host id）。
// multi-host aggregation 明确不在 scope 内（PRD 的后续 MH lane）。

import type { ProviderKind, ProviderSignal, SignalWindow } from "./provider-types.js";

/** Nearing = 对 C3 所携带百分比使用已交付的默认 advisory threshold。 */
export const NEARING_THRESHOLD_PERCENT = 80;

/** same-window resets_at spread 在判为 CONFLICT 前允许作为 sampling skew。一个 account 上的两个
 *  seat 可能相隔数秒读取同一 window；两个不同 account 的 reset schedule 差异远大于此。 */
export const CONFLICTING_RESETS_EPSILON_MS = 120_000;

export type HostUsageState = "ok" | "nearing" | "limited" | "explicit_unknown";

export interface HostUsageWindowFact {
  window: SignalWindow | "unknown";
  usedPercent?: number;
  resetsAt?: string;
  asOf: string;
  /** 贡献数据的 seat（topology identity，绝不是 account identity）。 */
  seatSession?: string;
}

export interface HostUsageConflictAnomaly {
  kind: "conflicting_seat_windows";
  window: SignalWindow | "unknown";
  seats: string[];
  evidence: string;
  asOf: string;
}

export interface HostUsageRow {
  /** 保留的 LOCAL host id——此 daemon 自身 scope（MH aggregation 不在 scope 内）。 */
  host: "local";
  provider: ProviderKind;
  state: HostUsageState;
  /** 对 `limited`：source 携带时表示 limit 解除时间；否则诚实缺失。 */
  resetsAt?: string;
  /** (iii) 精确保留 C3 携带的粒度——绝不 normalize 掉，也绝不虚构。 */
  windows: HostUsageWindowFact[];
  provenance: {
    basis: "one_account_per_host_deployment_invariant";
    note: string;
  };
  anomalies: HostUsageConflictAnomaly[];
  /** 贡献数据的 evidence ref：seat session（C3）/ 带 label 的 reactive event（C4）。 */
  evidenceSeats: string[];
  unknownReason?: string;
  asOf: string;
}

const PROVENANCE_NOTE =
  "host==account is a deployment invariant of this rig (one account per host), declared by the operator — " +
  "it is not source-derived account classification, and no account identity is read or emitted.";

export interface HostUsageRollupInput {
  signals: ProviderSignal[];
  /** codex 的 deployment presence（磁盘上的 auth profile）——存在但无 meter 时为显式 unknown，
   *  绝不省略 row（blindside 必须可见）。 */
  codexProfilesPresent: boolean;
  now: string;
}

export function rollupHostUsage(input: HostUsageRollupInput): HostUsageRow[] {
  const rows: HostUsageRow[] = [];

  const claude = rollupClaude(input);
  if (claude) rows.push(claude);

  const codex = rollupCodex(input);
  if (codex) rows.push(codex);

  return rows;
}

// ——— Claude：C3 按 seat 索引的 statusline lane（meter row + explicit-unknown row）——————

function rollupClaude(input: HostUsageRollupInput): HostUsageRow | null {
  const lane = input.signals.filter((s) => s.provider === "claude");
  if (lane.length === 0) return null; // 无 claude deployment presence → 无 row

  const meterRows = lane.filter(
    (s) => s.sourceClass === "provider_statusline" && typeof s.usedPercent === "number",
  );

  const windows: HostUsageWindowFact[] = meterRows.map((s) => ({
    window: s.window ?? "unknown",
    usedPercent: s.usedPercent,
    resetsAt: s.resetsAt,
    asOf: s.asOf,
    seatSession: s.seatSession,
  }));
  const evidenceSeats = [...new Set(lane.map((s) => s.seatSession).filter((x): x is string => typeof x === "string"))];

  const base: Omit<HostUsageRow, "state"> = {
    host: "local",
    provider: "claude",
    windows,
    provenance: { basis: "one_account_per_host_deployment_invariant", note: PROVENANCE_NOTE },
    anomalies: [],
    evidenceSeats,
    asOf: input.now,
  };

  if (meterRows.length === 0) {
    // 只有 explicit-unknown seat row（cache 缺失 / 首次 response 前 / api-key）：host state 诚实地
    // 为 unknown，并携带 lane 自身原因。
    const reason = lane.find((s) => s.unknownReason)?.unknownReason ?? "no_usable_claude_usage_rows";
    return { ...base, state: "explicit_unknown", unknownReason: reason };
  }

  // (ii) 按 window 检测 conflict：在 host==account 下，每个 seat 读取同一 window 时必须看到相同
  // reset schedule（允许 sampling skew）。更大的 spread 表示 seat 正在观察不同 account——该 host
  // 的 invariant 被证伪。
  const anomalies: HostUsageConflictAnomaly[] = [];
  const byWindow = new Map<string, ProviderSignal[]>();
  for (const s of meterRows) {
    const key = s.window ?? "unknown";
    byWindow.set(key, [...(byWindow.get(key) ?? []), s]);
  }
  for (const [windowKey, group] of byWindow) {
    const withResets = group.filter((s) => typeof s.resetsAt === "string");
    if (withResets.length < 2) continue;
    const times = withResets.map((s) => Date.parse(s.resetsAt!)).filter(Number.isFinite);
    if (times.length < 2) continue;
    if (Math.max(...times) - Math.min(...times) > CONFLICTING_RESETS_EPSILON_MS) {
      anomalies.push({
        kind: "conflicting_seat_windows",
        window: windowKey as SignalWindow | "unknown",
        seats: [...new Set(withResets.map((s) => s.seatSession).filter((x): x is string => typeof x === "string"))],
        evidence:
          `seats report divergent ${windowKey} reset schedules on one host: ` +
          withResets.map((s) => `${s.seatSession ?? "?"} resets_at=${s.resetsAt}`).join(" vs "),
        asOf: input.now,
      });
    }
  }
  if (anomalies.length > 0) {
    return {
      ...base,
      state: "explicit_unknown",
      anomalies,
      unknownReason:
        "conflicting_seat_windows: divergent reset schedules falsify the one-account-per-host invariant for this host",
    };
  }

  const maxUsed = Math.max(...meterRows.map((s) => s.usedPercent!));
  if (maxUsed >= 100) {
    const exhausted = meterRows.filter((s) => s.usedPercent! >= 100);
    const resets = exhausted
      .map((s) => s.resetsAt)
      .filter((x): x is string => typeof x === "string")
      .sort();
    return { ...base, state: "limited", ...(resets[0] !== undefined ? { resetsAt: resets[0] } : {}) };
  }
  if (maxUsed >= NEARING_THRESHOLD_PERCENT) return { ...base, state: "nearing" };
  return { ...base, state: "ok" };
}

// ——— Codex：C4 reactive lane（仅 exhaustion evidence——C2 前无 meter）———————————

function rollupCodex(input: HostUsageRollupInput): HostUsageRow | null {
  const lane = input.signals.filter((s) => s.provider === "codex");
  if (lane.length === 0 && !input.codexProfilesPresent) return null; // 无 deployment presence

  const nowMs = Date.parse(input.now);
  // at-limit exhaustion evidence = C4 tap 标记为 actionable switch trigger 的 reactive_error
  // event row（at_limit → allow_switch_decision；stream/stop error 是 advisory，不是 usage
  // evidence）。Freshness 采用 inclusive-expiry（BR-2 类）。
  const freshAtLimit = lane.filter(
    (s) =>
      s.sourceClass === "provider_event" &&
      s.authority === "reactive_error" &&
      s.automationUse === "allow_switch_decision" &&
      typeof s.staleAfter === "string" &&
      Number.isFinite(Date.parse(s.staleAfter)) &&
      Number.isFinite(nowMs) &&
      nowMs < Date.parse(s.staleAfter),
  );

  const base: Omit<HostUsageRow, "state"> = {
    host: "local",
    provider: "codex",
    windows: [], // (iii)：codex 尚无 remaining-meter 粒度——不虚构任何数据
    provenance: { basis: "one_account_per_host_deployment_invariant", note: PROVENANCE_NOTE },
    anomalies: [],
    evidenceSeats: freshAtLimit.map((s) => `reactive_event asOf=${s.asOf}`),
    asOf: input.now,
  };

  if (freshAtLimit.length > 0) {
    const resets = freshAtLimit
      .map((s) => s.resetsAt)
      .filter((x): x is string => typeof x === "string")
      .sort();
    return { ...base, state: "limited", ...(resets[0] !== undefined ? { resetsAt: resets[0] } : {}) };
  }

  return {
    ...base,
    state: "explicit_unknown",
    unknownReason:
      "no usage meter for codex on this host yet (the app-server read lane is a later seam); no fresh at-limit evidence either way",
  };
}
