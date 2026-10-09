// S10——thread↔seat MAP（FROM-SCRATCH §4.4）：确定性的 thread routing state。
// 每个 Slack thread root 一行：(thread_ts, channel, human, seat, conversation_id, state)。
// routing 周围不进行任何 LLM 推断——reply 要么通过精确 thread_ts 查询路由，要么就是 UNMAPPED
//（unmapped 是一等 outcome，会路由到 orchestrator 的 unrouted-signal row，绝不丢弃或猜测）。
//
// 可重建性：每个已发布 root 还会在其 queue row 上盖一条结构化 transition note
//（`slack-posted thread_ts=… message_ts=… channel=… human=… seat=…`——见下方 stampFormat/parse）。
// rebuildFromStamps() 从这些 stamp 重新派生 table，因此 map 是 queue-row truth 的 cache，
// 而非可能静默分歧的第二数据源。

import type Database from "better-sqlite3";

export interface ThreadMapping {
  threadTs: string;
  channel: string;
  human: string;
  seat: string;
  conversationId: string;
  state: "open" | "closed";
  openedAt: string;
  closedAt?: string | null;
}

export const SLACK_POSTED_STAMP_PREFIX = "slack-posted";

/** 已发布 thread root 的结构化 queue-row stamp（重建来源）。 */
export function formatPostedStamp(m: { threadTs: string; messageTs: string; channel: string; human: string; seat: string; conversationId: string }): string {
  return `${SLACK_POSTED_STAMP_PREFIX} thread_ts=${m.threadTs} message_ts=${m.messageTs} channel=${m.channel} human=${m.human} seat=${m.seat} conversation=${m.conversationId}`;
}

/** 解析 posted stamp（note 不是 stamp 时返回 null）。字段顺序无关紧要。 */
export function parsePostedStamp(note: string): { threadTs: string; messageTs: string; channel: string; human: string; seat: string; conversationId: string } | null {
  if (!note.startsWith(SLACK_POSTED_STAMP_PREFIX + " ")) return null;
  const fields = new Map<string, string>();
  for (const token of note.slice(SLACK_POSTED_STAMP_PREFIX.length + 1).split(/\s+/)) {
    const eq = token.indexOf("=");
    if (eq > 0) fields.set(token.slice(0, eq), token.slice(eq + 1));
  }
  const threadTs = fields.get("thread_ts");
  const messageTs = fields.get("message_ts");
  const channel = fields.get("channel");
  const human = fields.get("human");
  const seat = fields.get("seat");
  const conversationId = fields.get("conversation");
  if (!threadTs || !messageTs || !channel || !human || !seat || !conversationId) return null;
  return { threadTs, messageTs, channel, human, seat, conversationId };
}

export class ThreadSeatMap {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** 记录新的 thread root（按 thread_ts 幂等——重放 root 仍只保留一行）。 */
  open(m: { threadTs: string; channel: string; human: string; seat: string; conversationId: string }): void {
    this.db
      .prepare(
        `INSERT INTO thread_seat_map (thread_ts, channel, human, seat, conversation_id, state, opened_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?)
         ON CONFLICT(thread_ts) DO NOTHING`,
      )
      .run(m.threadTs, m.channel, m.human, m.seat, m.conversationId, this.now().toISOString());
  }

  /** 确定性 inbound 查询：返回 thread root 的 mapping，无论 open 还是 closed（closed thread 仍精确
   *  路由到其 mapped seat——类别 receipt）；null 表示 UNMAPPED。 */
  resolveByThread(threadTs: string): ThreadMapping | null {
    const row = this.db.prepare(`SELECT * FROM thread_seat_map WHERE thread_ts = ?`).get(threadTs) as
      | Record<string, unknown>
      | undefined;
    return row ? project(row) : null;
  }

  /** outbound thread 复用：查询（human、seat）的 open conversation，最新优先。 */
  resolveOpenForPair(human: string, seat: string): ThreadMapping | null {
    const row = this.db
      .prepare(`SELECT * FROM thread_seat_map WHERE human = ? AND seat = ? AND state = 'open' ORDER BY opened_at DESC LIMIT 1`)
      .get(human, seat) as Record<string, unknown> | undefined;
    return row ? project(row) : null;
  }

  /** outbound reply correlation 以 qitem 为 scope。仅同一持久 conversation 的另一 notification
   *  episode 才复用 thread；不同 human gate 获得新 root，使其 reply 无法解决更早或更新的 qitem。 */
  resolveOpenForConversation(human: string, seat: string, conversationId: string): ThreadMapping | null {
    const row = this.db
      .prepare(
        `SELECT * FROM thread_seat_map
          WHERE human = ? AND seat = ? AND conversation_id = ? AND state = 'open'
          ORDER BY opened_at DESC LIMIT 1`,
      )
      .get(human, seat, conversationId) as Record<string, unknown> | undefined;
    return row ? project(row) : null;
  }

  close(threadTs: string): void {
    this.db
      .prepare(`UPDATE thread_seat_map SET state = 'closed', closed_at = ? WHERE thread_ts = ?`)
      .run(this.now().toISOString(), threadTs);
  }

  /** 从 queue-row stamp（持久来源）重建 table：只 INSERT，绝不覆盖 live row——map 在不破坏 state
   *  的前提下向 stamp 收敛。 */
  rebuildFromStamps(stamps: string[]): { inserted: number; skipped: number } {
    let inserted = 0;
    let skipped = 0;
    for (const note of stamps) {
      const m = parsePostedStamp(note);
      if (!m) { skipped++; continue; }
      const before = this.db.prepare(`SELECT 1 FROM thread_seat_map WHERE thread_ts = ?`).get(m.threadTs);
      if (before) { skipped++; continue; }
      this.open({ threadTs: m.threadTs, channel: m.channel, human: m.human, seat: m.seat, conversationId: m.conversationId });
      inserted++;
    }
    return { inserted, skipped };
  }
}

function project(row: Record<string, unknown>): ThreadMapping {
  return {
    threadTs: String(row.thread_ts),
    channel: String(row.channel),
    human: String(row.human),
    seat: String(row.seat),
    conversationId: String(row.conversation_id),
    state: row.state === "closed" ? "closed" : "open",
    openedAt: String(row.opened_at),
    closedAt: (row.closed_at as string | null) ?? null,
  };
}
