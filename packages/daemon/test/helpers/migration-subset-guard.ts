import { expect } from "vitest";
import type { Migration } from "../../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../src/db/all-migrations.js";

/**
 * P24——精心选择的 test-fixture migration list 是 ALL_MIGRATIONS 的显式、已声明 subset。
 *
 * 消除静默遗漏成本：过去加入 ALL_MIGRATIONS 却忘记加入精简 fixture list 的 migration，会以令人
 * 困惑的方式失败（缺少 column/table，却在无关测试深处呈现——desk 在 064/066/067 fold 遇到过）。
 * 此 helper 断言每个已发布 migration 要么位于精简列表中，要么位于具名 exclusions map 中且附带
 * 可重新评估的原因。精简列表的有意最小化仍是设计选择——但必须明确声明，绝不能偶然。应断言，
 * 不应派生（派生会自动加入未来每个 migration，并静默破坏这种最小化）。
 */
export function assertExplicitSubsetOfAllMigrations(opts: {
  /** 精简列表的人类可读名称，用于教学错误消息。 */
  listName: string;
  curatedList: readonly Migration[];
  /** migration `name` → 有意省略它的可重新评估原因（未来 reader 可复查）。
   * "migrationsForFullTestDb 对 core edge 保持 schema-minimal；这里未使用 <table>" 优于
   * "not needed"——无法复查的原因会成为下一项陈旧声明。 */
  exclusions: Record<string, string>;
  /** 用于对照检查的随附列表。默认为真实 ALL_MIGRATIONS；可注入，使 guard 自身的负向控制测试
   *  能模拟新添加的 migration。 */
  allMigrations?: readonly Migration[];
}): void {
  const listed = new Set(opts.curatedList.map((m) => m.name));
  const excluded = new Set(Object.keys(opts.exclusions));
  const allNames = (opts.allMigrations ?? ALL_MIGRATIONS).map((m) => m.name);

  // (1) 核心——每个随附 migration 都已列出或声明排除。message 不只说明 fault，还提供 FIX：它可能
  // 在从未见过此 guard 的人手中触发，因此必须具备教学性。
  const undeclared = allNames.filter((n) => !listed.has(n) && !excluded.has(n));
  expect(
    undeclared,
    undeclared.length === 0
      ? ""
      : `P24 migration-fixture parity — ${undeclared.length} shipped migration(s) are in ALL_MIGRATIONS ` +
        `but NEITHER in the curated list "${opts.listName}" NOR its declared exclusions:\n  ` +
        `${undeclared.join("\n  ")}\n` +
        `This is the silent-omission tax: without this guard each would surface later as a mystery ` +
        `missing column/table in some unrelated test. FIX — for EACH migration above pick one:\n` +
        `  (a) ADD it to ${opts.listName} (its tests need the schema), or\n` +
        `  (b) DECLARE it in that list's exclusions map with a re-evaluable reason (e.g. ` +
        `"${opts.listName} is deliberately schema-minimal for <edge>; <table> is unused here").`,
  ).toEqual([]);

  // (2) 无陈旧 exclusion——若 exclusion 点名已不再属于 ALL_MIGRATIONS 的 migration，它本身就是
  // 陈旧声明，应删除。
  const stale = [...excluded].filter((n) => !allNames.includes(n));
  expect(
    stale,
    stale.length === 0
      ? ""
      : `P24 — "${opts.listName}" exclusions name migration(s) absent from ALL_MIGRATIONS (stale, remove ` +
        `them): ${stale.join(", ")}`,
  ).toEqual([]);

  // (3) 无冗余 exclusion——migration 同时 listed 与 excluded 是矛盾的；该 exclusion 已失效。
  // 保持列表权威。
  const redundant = [...excluded].filter((n) => listed.has(n));
  expect(
    redundant,
    redundant.length === 0
      ? ""
      : `P24 — "${opts.listName}" exclusions redundantly name migration(s) that ARE in the list (remove ` +
        `from exclusions): ${redundant.join(", ")}`,
  ).toEqual([]);
}
