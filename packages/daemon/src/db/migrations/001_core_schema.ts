import type { Migration } from "../migrate.js";

export const coreSchema: Migration = {
  name: "001_core_schema.sql",
  sql: `
    -- rigs：顶层拓扑容器。
    CREATE TABLE rigs (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- nodes：rig 内的逻辑身份。
    -- id = 不透明的数据库主键（ULID）。所有外键都引用它。
    -- logical_id = rig spec 中的逻辑名称（例如 "orchestrator"），面向人类。
    CREATE TABLE nodes (
      id          TEXT PRIMARY KEY,
      rig_id      TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      logical_id  TEXT NOT NULL,
      role        TEXT,
      runtime     TEXT,
      model       TEXT,
      cwd         TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(rig_id, logical_id)
    );

    -- edges：节点之间的关系。
    CREATE TABLE edges (
      id          TEXT PRIMARY KEY,
      rig_id      TEXT NOT NULL REFERENCES rigs(id) ON DELETE CASCADE,
      source_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      target_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 边完整性：源节点与目标节点必须属于同一个 rig。
    -- SQLite CHECK 无法跨表引用，因此使用触发器。
    CREATE TRIGGER edge_same_rig_insert
    BEFORE INSERT ON edges
    BEGIN
      SELECT RAISE(ABORT, '边的源节点和目标节点必须属于同一个 rig')
      WHERE (SELECT rig_id FROM nodes WHERE id = NEW.source_id)
         != (SELECT rig_id FROM nodes WHERE id = NEW.target_id);
      SELECT RAISE(ABORT, '边的 rig_id 必须与源节点的 rig_id 匹配')
      WHERE NEW.rig_id != (SELECT rig_id FROM nodes WHERE id = NEW.source_id);
    END;
  `,
};
