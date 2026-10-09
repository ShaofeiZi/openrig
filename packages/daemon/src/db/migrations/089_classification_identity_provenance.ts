import type { Migration } from "../migrate.js";

// S02 P3 分配：允许为空，使历史上未标记的行仍可区分。
export const classificationIdentityProvenanceSchema: Migration = {
  name: "089_classification_identity_provenance.sql",
  sql: "ALTER TABLE project_classifications ADD COLUMN identity_provenance TEXT;",
};
