import type { Migration } from "../migrate.js";

export const agentspecRebootSchema: Migration = {
  name: "014_agentspec_reboot.sql",
  sql: `
    -- pods：rig 内的有界上下文域。
    CREATE TABLE pods (
      id                      TEXT PRIMARY KEY,
      rig_id                  TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      label                   TEXT NOT NULL,
      summary                 TEXT,
      continuity_policy_json  TEXT,
      created_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- continuity_state：逐节点的连续性运行状态。
    CREATE TABLE continuity_state (
      pod_id        TEXT NOT NULL REFERENCES pods(id) ON DELETE CASCADE,
      node_id       TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      status        TEXT NOT NULL DEFAULT 'healthy',
      artifacts_json TEXT,
      last_sync_at  TEXT,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (pod_id, node_id)
    );

    -- nodes：添加 pod 成员关系和 AgentSpec 身份。
    ALTER TABLE nodes ADD COLUMN pod_id TEXT REFERENCES pods(id) ON DELETE SET NULL;
    ALTER TABLE nodes ADD COLUMN agent_ref TEXT;
    ALTER TABLE nodes ADD COLUMN profile TEXT;
    ALTER TABLE nodes ADD COLUMN label TEXT;
    ALTER TABLE nodes ADD COLUMN resolved_spec_name TEXT;
    ALTER TABLE nodes ADD COLUMN resolved_spec_version TEXT;
    ALTER TABLE nodes ADD COLUMN resolved_spec_hash TEXT;

    -- sessions：添加启动状态跟踪。
    ALTER TABLE sessions ADD COLUMN startup_status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE sessions ADD COLUMN startup_completed_at TEXT;

    -- 回填：按定义，迁移前的所有 session 都已完成启动。
    UPDATE sessions SET startup_status = 'ready';

    -- checkpoints：添加 pod/continuity 元数据，以支持连续性感知恢复。
    ALTER TABLE checkpoints ADD COLUMN pod_id TEXT REFERENCES pods(id) ON DELETE SET NULL;
    ALTER TABLE checkpoints ADD COLUMN continuity_source TEXT;
    ALTER TABLE checkpoints ADD COLUMN continuity_artifacts_json TEXT;
  `,
};
