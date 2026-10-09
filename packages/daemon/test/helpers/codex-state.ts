import Database from "better-sqlite3";
import { join } from "node:path";

/** 原生日志标识进程；保留的 CLI 记录标识可恢复的对话。 */
export function seedCodexThreads(home: string, ids: string[]): void {
  const db = new Database(join(home, ".codex", "state_5.sqlite"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, source TEXT, rollout_path TEXT)");
    const insert = db.prepare("INSERT OR REPLACE INTO threads VALUES (?, 'cli', ?)");
    for (const id of ids) insert.run(id, join(home, `${id}.jsonl`));
  } finally { db.close(); }
}
