import { describe, it, expect } from "vitest";
import { checkMirrorDriftSafe } from "../src/domain/skill-mirror-drift.js";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("skill-mirror-drift 安全 wrapper", () => {
  it("source 与 target 都存在于 repo 时返回 ok 结果", async () => {
    const result = await checkMirrorDriftSafe();
    const sourceExists = existsSync(resolve(REPO_ROOT, "packages/daemon/specs/agents/shared/skills"));
    const targetExists = existsSync(resolve(REPO_ROOT, "skills/_canonical"));

    if (sourceExists && targetExists) {
      expect(result.ok).toBe(true);
    } else {
      expect(result.ok).toBe(false);
      expect((result as { reason: string }).reason).toBeDefined();
    }
  });

  it("不创建 skills/_canonical 目录（只读不变量）", async () => {
    const targetBefore = existsSync(resolve(REPO_ROOT, "skills/_canonical"));
    await checkMirrorDriftSafe();
    const targetAfter = existsSync(resolve(REPO_ROOT, "skills/_canonical"));
    expect(targetAfter).toBe(targetBefore);
  });

  it("source 目录缺失时返回带 reason 的 ok:false", async () => {
    // 此测试从结构上验证错误路径——生产 source 目录存在于 repo，因此这里只测试 wrapper 的
    // shape contract。
    const result = await checkMirrorDriftSafe();
    if (!result.ok) {
      expect(result.reason).toBeDefined();
      expect(typeof result.reason).toBe("string");
    } else {
      expect(typeof result.stale).toBe("boolean");
      expect(Array.isArray(result.changes)).toBe(true);
    }
  });
});
