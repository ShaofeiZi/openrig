import type { Migration } from "../migrate.js";

// 撤销 W4 压缩执行套件（创始人裁定，过度工程审计）。
//
// 按裁定只能前进：068_enforcer_decisions 已应用于实时数据库，069/070 位于其后，因此其迁移
// 文件必须作为历史保留，不得删除——删除会留下一个没有对应迁移的已应用台账行，且缺口之后还有
// 两个迁移。这里改为删除表，使 schema_migrations 如实记录创建与删除。
//
// IF EXISTS 承担实际语义，不是防御性噪声：068 被排除在共享完整测试数据库 fixture 之外
//（test-app.ts migrationsForFullTestDbExclusions），因此在该 fixture 中，此迁移会对从未创建
// enforcer_decisions 的数据库运行。SQLite 会随表一起删除索引。
export const dropEnforcerDecisionsSchema: Migration = {
  name: "071_drop_enforcer_decisions.sql",
  sql: `
    DROP TABLE IF EXISTS enforcer_decisions;
  `,
};
