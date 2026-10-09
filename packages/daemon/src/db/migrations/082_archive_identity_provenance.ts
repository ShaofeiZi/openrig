import type { Migration } from "../migrate.js";

/** 在保留过程中携带审计身份。现有归档行保持未知；只有单独验证过的来源证据才能证明恢复缺失值
 * 是合理的。 */
export const archiveIdentityProvenanceSchema: Migration = {
  name: "082_archive_identity_provenance.sql",
  sql: "ALTER TABLE queue_transitions_archive ADD COLUMN identity_provenance TEXT;",
};
