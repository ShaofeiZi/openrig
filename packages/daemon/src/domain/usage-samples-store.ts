// 51-08 A1——按席位记录的仅追加使用量序列写入器（迁移 062）。
//
// 只前进是承重属性：若样本与同一泳道中该席位的最新行逐字节相同（provider 泳道还要求
// 窗口相同），则拒绝写入。因此空闲席位不会增加记录，序列长度反映真实变化。历史永不
// 修改；context_usage（018）通过破坏性 upsert 保留时点状态，本存储则是其时间序列对应物。
//
// OPTION-A 约束：输入只携带席位/节点身份。schema 中不存在账号身份，本接口也不接受。
import type { Database } from "better-sqlite3";
import type { ProviderSignal } from "./provider/provider-types.js";

export interface ContextSampleInput {
  nodeId: string;
  seatSession: string;
  source: string | null;
  sampledAt: string | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  usedPercentage: number | null;
}

export interface ProviderWindowSampleInput {
  seatSession: string;
  window: "five_hour" | "weekly";
  usedPercent: number | null;
  resetsAt: string | null;
  asOf: string;
}

interface LastContextRow {
  sampled_at: string | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  used_percentage: number | null;
}

interface LastWindowRow {
  sampled_at: string | null;
  window_used_percent: number | null;
  resets_at: string | null;
}

export class UsageSamplesStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** 仅当上下文泳道样本相对该席位最新行发生变化时才追加。 */
  appendContextSample(s: ContextSampleInput, capturedAt: string): boolean {
    const last = this.db
      .prepare(
        `SELECT sampled_at, total_input_tokens, total_output_tokens, used_percentage
         FROM usage_samples
         WHERE lane = 'context' AND seat_session = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(s.seatSession) as LastContextRow | undefined;
    if (
      last &&
      last.sampled_at === s.sampledAt &&
      last.total_input_tokens === s.totalInputTokens &&
      last.total_output_tokens === s.totalOutputTokens &&
      last.used_percentage === s.usedPercentage
    ) {
      return false;
    }
    this.db
      .prepare(
        `INSERT INTO usage_samples
           (lane, seat_session, node_id, source, sampled_at, captured_at,
            total_input_tokens, total_output_tokens, used_percentage)
         VALUES ('context', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.seatSession,
        s.nodeId,
        s.source,
        s.sampledAt,
        capturedAt,
        s.totalInputTokens,
        s.totalOutputTokens,
        s.usedPercentage,
      );
    return true;
  }

  /** 仅当 provider 窗口样本相对该席位在该窗口的最新行发生变化时才追加。 */
  appendProviderWindowSample(s: ProviderWindowSampleInput, capturedAt: string): boolean {
    const last = this.db
      .prepare(
        `SELECT sampled_at, window_used_percent, resets_at
         FROM usage_samples
         WHERE lane = 'provider_window' AND seat_session = ? AND window = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(s.seatSession, s.window) as LastWindowRow | undefined;
    if (
      last &&
      last.sampled_at === s.asOf &&
      last.window_used_percent === s.usedPercent &&
      last.resets_at === s.resetsAt
    ) {
      return false;
    }
    this.db
      .prepare(
        `INSERT INTO usage_samples
           (lane, seat_session, source, sampled_at, captured_at,
            window, window_used_percent, resets_at)
         VALUES ('provider_window', ?, 'claude_statusline_json', ?, ?, ?, ?, ?)`,
      )
      .run(s.seatSession, s.asOf, capturedAt, s.window, s.usedPercent, s.resetsAt);
    return true;
  }
}

/** 将读取模型的状态栏信号映射为窗口样本输入。只有两个规范化订阅窗口进入序列；
 * 缺少席位身份或 asOf 时间戳的行会被跳过（绝不伪造——遵守 Option-A 约束）。 */
export function providerWindowSamplesFromSignals(signals: ProviderSignal[]): ProviderWindowSampleInput[] {
  const out: ProviderWindowSampleInput[] = [];
  for (const sig of signals) {
    if (!sig.seatSession || !sig.asOf) continue;
    // SignalWindow 接受 provider 原生字符串；只有两个规范化窗口进入序列
    //（显式重新字面量化以收窄开放联合类型）。
    const window = sig.window === "five_hour" ? "five_hour" : sig.window === "weekly" ? "weekly" : null;
    if (!window) continue;
    out.push({
      seatSession: sig.seatSession,
      window,
      usedPercent: typeof sig.usedPercent === "number" ? sig.usedPercent : null,
      resetsAt: sig.resetsAt ?? null,
      asOf: sig.asOf,
    });
  }
  return out;
}
