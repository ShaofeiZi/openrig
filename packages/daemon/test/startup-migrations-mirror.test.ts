// P8——启动时遵循 ALL_MIGRATIONS 镜像规则（0.5.2 发布 gate）。daemon 启动路径必须应用
// 规范迁移列表（db/all-migrations.ts 的 ALL_MIGRATIONS），绝不能使用可能悄然漂移的内联副本；
// 漂移的启动列表会让 daemon 在代码预期之外的 schema 上启动。生产代码导入单一来源，本测试
// 用于在重新引入副本时明确失败。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTUP_SRC = readFileSync(resolve(HERE, "..", "src", "startup.ts"), "utf8");

describe("P8——启动迁移与规范 ALL_MIGRATIONS 保持一致", () => {
  it("startup 应用导入的 ALL_MIGRATIONS，而不是内联副本", () => {
    // 单一来源：startup 使用规范列表执行迁移……
    expect(STARTUP_SRC).toContain("migrate(db, ALL_MIGRATIONS)");
    // ……绝不使用可能漂移的内联数组字面量。
    expect(STARTUP_SRC).not.toMatch(/migrate\(db,\s*\[/);
  });

  it("规范列表从单一来源导入且不是空壳", () => {
    expect(STARTUP_SRC).toMatch(/import\s*\{\s*ALL_MIGRATIONS\s*\}\s*from\s*["'][^"']*db\/all-migrations\.js["']/);
    expect(ALL_MIGRATIONS.length).toBeGreaterThan(50);
  });
});
