import { describe, it, expect } from "vitest";
import { migrationsForFullTestDb, migrationsForFullTestDbExclusions } from "./helpers/test-app.js";
import { assertExplicitSubsetOfAllMigrations } from "./helpers/migration-subset-guard.js";

// P24——精选 fixture 列表必须是 ALL_MIGRATIONS 的已声明子集，而非偶然子集。若 migration 已加入
// ALL_MIGRATIONS 却遗漏在精选列表中，现在会明确失败并点名 migration 与修复方式，而不是在无关
// suite 深处表现为神秘缺列/缺表（064/066/067 成本）。可以刻意保持最小集合，但必须附可重新评估的
// 声明理由；exclusions map 与列表同在 test-app.ts，编辑列表时即可看到。

// 对 guard 而言，fake Migration 只需 `name`，因为它按名称比较。
const fake = (name: string) => ({ name } as unknown as import("../src/db/migrate.js").Migration);

describe("P24——migration fixture 一致性（精选列表是 ALL_MIGRATIONS 的已声明子集）", () => {
  it("migrationsForFullTestDb：每个已交付 migration 都已列出或声明排除", () => {
    assertExplicitSubsetOfAllMigrations({
      listName: "migrationsForFullTestDb (test/helpers/test-app.ts)",
      curatedList: migrationsForFullTestDb,
      exclusions: migrationsForFullTestDbExclusions,
    });
  });

  // 承重证明：未来 migration 加入 ALL_MIGRATIONS 却遗漏于精选列表（既未列出也未声明）时，
  // guard 会触发并在消息中点名 migration 与修复方式。
  it("新增 migration 既未列出也未声明时，guard 会点名触发", () => {
    expect(() =>
      assertExplicitSubsetOfAllMigrations({
        listName: "fixtureX",
        curatedList: [fake("001_a.sql")],
        exclusions: {},
        allMigrations: [fake("001_a.sql"), fake("068_brand_new.sql")],
      }),
    ).toThrowError(/068_brand_new\.sql[\s\S]*ADD it to fixtureX[\s\S]*DECLARE it/);
  });

  it("新 migration 被列出或单独声明排除时均通过", () => {
    // 已列出 → 通过。
    assertExplicitSubsetOfAllMigrations({
      listName: "fixtureX",
      curatedList: [fake("001_a.sql"), fake("068_brand_new.sql")],
      exclusions: {},
      allMigrations: [fake("001_a.sql"), fake("068_brand_new.sql")],
    });
    // 已声明排除 → 通过。
    assertExplicitSubsetOfAllMigrations({
      listName: "fixtureX",
      curatedList: [fake("001_a.sql")],
      exclusions: { "068_brand_new.sql": "subsystem table — not on this fixture's edge" },
      allMigrations: [fake("001_a.sql"), fake("068_brand_new.sql")],
    });
  });

  it("陈旧 exclusion（指向 ALL_MIGRATIONS 中不存在的 migration）会触发", () => {
    expect(() =>
      assertExplicitSubsetOfAllMigrations({
        listName: "fixtureX",
        curatedList: [fake("001_a.sql")],
        exclusions: { "999_ghost.sql": "reason" },
        allMigrations: [fake("001_a.sql")],
      }),
    ).toThrowError(/stale[\s\S]*999_ghost\.sql/);
  });

  it("冗余 exclusion（migration 同时列出且排除）会触发", () => {
    expect(() =>
      assertExplicitSubsetOfAllMigrations({
        listName: "fixtureX",
        curatedList: [fake("001_a.sql"), fake("002_b.sql")],
        exclusions: { "002_b.sql": "reason" },
        allMigrations: [fake("001_a.sql"), fake("002_b.sql")],
      }),
    ).toThrowError(/redundant[\s\S]*002_b\.sql/i);
  });
});
