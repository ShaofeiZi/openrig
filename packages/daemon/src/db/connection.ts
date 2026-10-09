import Database from "better-sqlite3";

/**
 * 创建 SQLite 数据库连接。
 * 测试默认使用内存数据库；传入文件路径可持久化。
 */
export function createDb(filePath?: string): Database.Database {
  const db = new Database(filePath ?? ":memory:");

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  return db;
}
