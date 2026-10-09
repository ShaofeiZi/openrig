import type Database from "better-sqlite3";

export interface ProjectionManifestEntry {
  targetPath: string;
  lastHash: string;
  writtenAt: string;
  sourceSpec: string | null;
  category: string | null;
}

interface Row {
  target_path: string;
  last_hash: string;
  written_at: string;
  source_spec: string | null;
  category: string | null;
}

/**
 * P20——projection_manifest 访问器。`record` 在真正写入时调用（projector 确实向 targetPath
 * 写了内容）；分类时查询 `get`，用于区分 stale-projection（target == last_hash，可安全覆盖）
 * 与 operator-modified（target 同时偏离 last_hash 和新 source，必须保护）。按 target_path
 * upsert，只保留最后一次写入。
 */
export class ProjectionManifestStore {
  constructor(private readonly db: Database.Database) {}

  record(entry: {
    targetPath: string;
    lastHash: string;
    writtenAt: string;
    sourceSpec?: string | null;
    category?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO projection_manifest (target_path, last_hash, written_at, source_spec, category)
           VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(target_path) DO UPDATE SET
           last_hash = excluded.last_hash,
           written_at = excluded.written_at,
           source_spec = excluded.source_spec,
           category = excluded.category`,
      )
      .run(entry.targetPath, entry.lastHash, entry.writtenAt, entry.sourceSpec ?? null, entry.category ?? null);
  }

  get(targetPath: string): ProjectionManifestEntry | null {
    const row = this.db
      .prepare(`SELECT target_path, last_hash, written_at, source_spec, category FROM projection_manifest WHERE target_path = ?`)
      .get(targetPath) as Row | undefined;
    if (!row) return null;
    return {
      targetPath: row.target_path,
      lastHash: row.last_hash,
      writtenAt: row.written_at,
      sourceSpec: row.source_spec ?? null,
      category: row.category ?? null,
    };
  }

  /** 判别规则的便捷接口：返回最后写入的 hash，不存在时返回 null。 */
  lastHash(targetPath: string): string | null {
    return this.get(targetPath)?.lastHash ?? null;
  }

  /**
   * atom-4b——启动时探测整表可读性，这与单次 lookup 抛错不同。projection_manifest 不可读
   *（缺失、迁移失败或损坏）时，每次 `lastHash` 查询都会抛错，导致
   * `classifyResourceProjection` 把每个有差异的 projection 都判为 `operator_conflict`，最终
   * 静默退化成 protect-ALL，任何 projection 都无法应用。此系统性退化不会丢数据，因此安全，
   * 但必须可见：启动时调用本探针并明确告警，让操作员知道 projection 被暂扣，而不是无声发现
   * 所有应用都未生效。本探针开销低且绝不抛错。
   */
  isReadable(): boolean {
    try {
      this.db.prepare(`SELECT target_path FROM projection_manifest LIMIT 1`).get();
      return true;
    } catch {
      return false;
    }
  }
}
