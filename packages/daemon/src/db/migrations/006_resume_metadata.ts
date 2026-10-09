import type { Migration } from "../migrate.js";

export const resumeMetadataSchema: Migration = {
  name: "006_resume_metadata.sql",
  sql: `
    -- session 上的 resume 与 restore 元数据（从第 1 阶段延后）。
    -- 以下三个字段驱动恢复决策树（PRD:472-474）：
    --   resume_type：如何恢复（使用哪个 CLI 命令/标志）。
    --   resume_token：实际传入的值。
    --   restore_policy：是否尝试恢复。
    ALTER TABLE sessions ADD COLUMN resume_type TEXT;
    ALTER TABLE sessions ADD COLUMN resume_token TEXT;
    ALTER TABLE sessions ADD COLUMN restore_policy TEXT NOT NULL DEFAULT 'resume_if_possible';
  `,
};
