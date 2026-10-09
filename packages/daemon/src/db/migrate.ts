import type Database from "better-sqlite3";

export interface Migration {
  name: string;
  sql: string;
}

/**
 * 对数据库运行迁移。
 * 在 schema_migrations 表中跟踪已应用的迁移，跳过已应用项，并按顺序应用新迁移。
 */
export function migrate(db: Database.Database, migrations: Migration[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    (
      db
        .prepare("SELECT name FROM schema_migrations")
        .all() as { name: string }[]
    ).map((r) => r.name)
  );

  const sorted = [...migrations].sort((a, b) => a.name.localeCompare(b.name));

  const applyOne = db.transaction((migration: Migration) => {
    db.exec(migration.sql);
    db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(
      migration.name
    );
  });

  for (const migration of sorted) {
    if (!applied.has(migration.name)) {
      applyOne(migration);
    }
  }
}
