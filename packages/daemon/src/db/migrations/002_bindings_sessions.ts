import type { Migration } from "../migrate.js";

export const bindingsSessionsSchema: Migration = {
  name: "002_bindings_sessions.sql",
  sql: `
    -- bindings：节点如何连接到物理界面。
    -- 一个节点可以有零个或一个绑定（未绑定 = 尚未实体化）。
    CREATE TABLE bindings (
      id              TEXT PRIMARY KEY,
      node_id         TEXT NOT NULL UNIQUE REFERENCES nodes(id) ON DELETE CASCADE,
      tmux_session    TEXT,
      tmux_window     TEXT,
      tmux_pane       TEXT,
      cmux_workspace  TEXT,
      cmux_surface    TEXT,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- sessions：实时 harness 执行状态。
    -- 注意：resume_token 延后到第 2 阶段迁移。
    CREATE TABLE sessions (
      id              TEXT PRIMARY KEY,
      node_id         TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      session_name    TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'unknown',
      last_seen_at    TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `,
};
