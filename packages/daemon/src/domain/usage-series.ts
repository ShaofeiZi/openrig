// 51-08 A3——usage_samples 的时序 query + top-N burn projection。
//
// 同一个 projection 服务 HTTP route 与 CLI（PM 决策 3+4）：工作组提供事实——raw row、token delta、
// per-window velocity、sample span——detector/edge 负责 threshold 与 judgment（提供事实，在边缘
// 推导；不复制第五份 tier constant）。
//
// 诚实性边界（contract 第 5 项）：窗口内 sample 不足的 seat 是带 reason 的显式 `unknown` entry，
// 绝不是伪造的零值 row。total reset（session restart）绝不会产生负 burn：累加连续正 delta，
// reset 次数作为事实计数并报告。
//
// OPTION-A 边界：row 只携带 seat/node identity；所有服务 shape 均无 account field。
import type { Database } from "better-sqlite3";

export interface UsageSeriesQuery {
  seatSession?: string;
  lane?: "context" | "provider_window";
  sinceIso?: string;
  untilIso?: string;
  limit?: number;
}

export interface UsageSeriesRow {
  id: number;
  lane: string;
  seatSession: string;
  nodeId: string | null;
  source: string | null;
  sampledAt: string | null;
  capturedAt: string;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  usedPercentage: number | null;
  window: string | null;
  windowUsedPercent: number | null;
  resetsAt: string | null;
}

/** 提供原始存储 row，最旧项优先。边界绝对作用于 captured_at
 *  （since 包含等于及之后，即 `>=`；until 不含等于，即 `<`）。 */
export function queryUsageSeries(db: Database, q: UsageSeriesQuery): UsageSeriesRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.seatSession) { where.push("seat_session = ?"); params.push(q.seatSession); }
  if (q.lane) { where.push("lane = ?"); params.push(q.lane); }
  if (q.sinceIso) { where.push("captured_at >= ?"); params.push(q.sinceIso); }
  if (q.untilIso) { where.push("captured_at < ?"); params.push(q.untilIso); }
  const limit = q.limit && q.limit > 0 ? Math.floor(q.limit) : 10_000;
  const rows = db
    .prepare(
      `SELECT id, lane, seat_session, node_id, source, sampled_at, captured_at,
              total_input_tokens, total_output_tokens, used_percentage,
              window, window_used_percent, resets_at
         FROM usage_samples
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY captured_at ASC, id ASC
        LIMIT ?`,
    )
    .all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number,
    lane: r.lane as string,
    seatSession: r.seat_session as string,
    nodeId: (r.node_id as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    sampledAt: (r.sampled_at as string | null) ?? null,
    capturedAt: r.captured_at as string,
    totalInputTokens: (r.total_input_tokens as number | null) ?? null,
    totalOutputTokens: (r.total_output_tokens as number | null) ?? null,
    usedPercentage: (r.used_percentage as number | null) ?? null,
    window: (r.window as string | null) ?? null,
    windowUsedPercent: (r.window_used_percent as number | null) ?? null,
    resetsAt: (r.resets_at as string | null) ?? null,
  }));
}

export interface TopBurnQuery {
  windowHours: number;
  nowIso: string;
  topN?: number;
}

export interface WindowVelocity {
  window: string;
  usedPercentFirst: number | null;
  usedPercentLast: number | null;
  /** 实际 sample span 上的每小时百分点；无法测量时为 null */
  percentPerHour: number | null;
  resetsAt: string | null;
}

export interface SeatBurn {
  seatSession: string;
  /** 实际 sample span 内连续正 token delta 的总和，按小时折算 */
  tokensPerHour: number;
  /** window 内正 token delta 总量 */
  tokensDelta: number;
  /** window 内 total-token 负向 transition（session restart）的数量 */
  resets: number;
  /** window 内首尾 context sample 的实际间隔，单位为小时 */
  spanHours: number;
  samples: number;
  windows: WindowVelocity[];
}

export interface UnknownSeat {
  seatSession: string;
  reason: "no_fresh_samples" | "insufficient_samples";
}

export interface TopBurnResult {
  windowHours: number;
  sinceIso: string;
  ranked: SeatBurn[];
  unknown: UnknownSeat[];
  /** 应用 topN 上限前参与排名的 seat 总数——截断绝不静默 */
  totalRankedSeats: number;
}

function hoursBetween(aIso: string, bIso: string): number {
  return (new Date(bIso).getTime() - new Date(aIso).getTime()) / 3_600_000;
}

/** 核心问题：过去 H 小时内按 token burn 排名前 N 的 seat。 */
export function computeTopBurn(db: Database, q: TopBurnQuery): TopBurnResult {
  const sinceIso = new Date(new Date(q.nowIso).getTime() - q.windowHours * 3_600_000).toISOString();

  const seats = (
    db.prepare(`SELECT DISTINCT seat_session AS s FROM usage_samples`).all() as Array<{ s: string }>
  ).map((r) => r.s);

  const ranked: SeatBurn[] = [];
  const unknown: UnknownSeat[] = [];

  for (const seat of seats) {
    const ctx = queryUsageSeries(db, { seatSession: seat, lane: "context", sinceIso });
    if (ctx.length === 0) {
      // history 存在（seat 曾出现在 census 中），但没有新鲜数据
      unknown.push({ seatSession: seat, reason: "no_fresh_samples" });
      continue;
    }
    if (ctx.length < 2) {
      unknown.push({ seatSession: seat, reason: "insufficient_samples" });
      continue;
    }
    let tokensDelta = 0;
    let resets = 0;
    for (let i = 1; i < ctx.length; i += 1) {
      const prev = (ctx[i - 1]!.totalInputTokens ?? 0) + (ctx[i - 1]!.totalOutputTokens ?? 0);
      const cur = (ctx[i]!.totalInputTokens ?? 0) + (ctx[i]!.totalOutputTokens ?? 0);
      const delta = cur - prev;
      if (delta >= 0) tokensDelta += delta;
      else resets += 1; // restart 使 total 下降——绝不产生负 burn
    }
    const spanHours = hoursBetween(ctx[0]!.capturedAt, ctx[ctx.length - 1]!.capturedAt);
    const tokensPerHour = spanHours > 0 ? tokensDelta / spanHours : 0;

    const windows: WindowVelocity[] = [];
    for (const w of ["five_hour", "weekly"] as const) {
      const rows = queryUsageSeries(db, { seatSession: seat, lane: "provider_window", sinceIso }).filter(
        (r) => r.window === w,
      );
      if (rows.length === 0) continue;
      const first = rows[0]!;
      const last = rows[rows.length - 1]!;
      const wSpan = hoursBetween(first.capturedAt, last.capturedAt);
      const measurable =
        rows.length >= 2 && wSpan > 0 && first.windowUsedPercent !== null && last.windowUsedPercent !== null;
      windows.push({
        window: w,
        usedPercentFirst: first.windowUsedPercent,
        usedPercentLast: last.windowUsedPercent,
        percentPerHour: measurable ? (last.windowUsedPercent! - first.windowUsedPercent!) / wSpan : null,
        resetsAt: last.resetsAt,
      });
    }

    ranked.push({ seatSession: seat, tokensPerHour, tokensDelta, resets, spanHours, samples: ctx.length, windows });
  }

  ranked.sort((a, b) => b.tokensPerHour - a.tokensPerHour);
  const totalRankedSeats = ranked.length;
  const capped = q.topN && q.topN > 0 ? ranked.slice(0, q.topN) : ranked;
  return { windowHours: q.windowHours, sinceIso, ranked: capped, unknown, totalRankedSeats };
}
