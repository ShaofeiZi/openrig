import type { Migration } from "../migrate.js";

/**
 * 0.6.0 S02 P1：分类字段、结果绑定和尝试台账。
 *
 * project_classifications（028）新增：
 * - 四个可空标签字段：area、scope_ref、duplicate_of_stream_item_id、needs_human
 *   （0/1；NULL = 未知，绝不表示 false）
 * - 结果绑定：lease_id，以及生成标签时使用的 classifier、taxonomy 和 candidate-set 版本
 * 086 之前写入的行在所有新列中保持 NULL；首次写入胜出（UNIQUE stream_item_id）保持不变。
 *
 * classification_attempts 是不应写入不可变 classification 行的工作的持久台账：弃权、错误和
 * 在途尝试。身份为 (stream_item_id, classifier_version, taxonomy_version, evidence_epoch)。
 * 弃权只对该身份是终态；版本或 evidence epoch 变化即形成新身份，使条目重新符合条件。错误和被
 * 放弃的在途尝试会在有限预算内重试，随后以 `exhausted` 结束。
 *
 * execution_id 隔离每次执行：每次 begin（首次尝试、超时重发或错误重试）都会铸造新值，只有当前
 * execution_id 可以完成尝试。可续租租约永远不能证明旧执行已死亡。
 */
export const classificationFieldsAndAttemptsSchema: Migration = {
  name: "086_classification_fields_and_attempts.sql",
  sql: `
    ALTER TABLE project_classifications ADD COLUMN area TEXT;
    ALTER TABLE project_classifications ADD COLUMN scope_ref TEXT;
    ALTER TABLE project_classifications ADD COLUMN duplicate_of_stream_item_id TEXT
      REFERENCES stream_items(stream_item_id);
    ALTER TABLE project_classifications ADD COLUMN needs_human INTEGER
      CHECK (needs_human IS NULL OR needs_human IN (0, 1));
    ALTER TABLE project_classifications ADD COLUMN lease_id TEXT;
    ALTER TABLE project_classifications ADD COLUMN classifier_version TEXT;
    ALTER TABLE project_classifications ADD COLUMN taxonomy_version TEXT;
    ALTER TABLE project_classifications ADD COLUMN candidate_set_version TEXT;

    CREATE INDEX IF NOT EXISTS idx_project_classifications_area
      ON project_classifications(area);
    CREATE INDEX IF NOT EXISTS idx_project_classifications_scope_ref
      ON project_classifications(scope_ref);

    CREATE TABLE IF NOT EXISTS classification_attempts (
      attempt_id TEXT PRIMARY KEY,
      stream_item_id TEXT NOT NULL REFERENCES stream_items(stream_item_id),
      classifier_version TEXT NOT NULL,
      taxonomy_version TEXT NOT NULL,
      evidence_epoch TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('in_flight', 'abstained', 'written', 'error', 'exhausted')),
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1),
      execution_id TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      classifier_session TEXT NOT NULL,
      retry_after TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (stream_item_id, classifier_version, taxonomy_version, evidence_epoch)
    );

    CREATE INDEX IF NOT EXISTS idx_classification_attempts_status_retry
      ON classification_attempts(status, retry_after);
  `,
};
