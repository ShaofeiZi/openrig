import type { Migration } from "../migrate.js";

// S10（OPR.0.5.5.10）——thread↔seat 映射：单表，严格采用设计形态（FROM-SCRATCH §4.4）。
// thread 是一个人与一个席位之间的临时私信；映射由我方拥有；路由是基于 thread_ts 的确定性查询，
// 不做推断。该表是事实缓存，事实也标记在队列行上（`slack-posted thread_ts=… message_ts=…`
// transition notes），因此表丢失后可从队列行重建，绝不捏造映射。
export const threadSeatMapSchema: Migration = {
  name: "072_thread_seat_map.sql",
  sql: `
    CREATE TABLE thread_seat_map (
      thread_ts       TEXT PRIMARY KEY,
      channel         TEXT NOT NULL,
      human           TEXT NOT NULL,
      seat            TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      state           TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
      opened_at       TEXT NOT NULL,
      closed_at       TEXT
    );
    CREATE INDEX idx_thread_seat_map_pair ON thread_seat_map (human, seat, state);
  `,
};
