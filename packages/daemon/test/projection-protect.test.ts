import { describe, it, expect } from "vitest";
import {
  filterProtectedProjections,
  projectionConflictWarnings,
  type ProjectionEntry,
} from "../src/domain/projection-planner.js";
import type { ResolvedStartupFile } from "../src/domain/runtime-adapter.js";

// P20 atom-4——PROTECT + 真实 warning。atom-2 分类 operator_conflict（target 同时偏离上次
// 写入与 source），atom-3 记录最后一次写入。本 atom 让 warning 声称的“不覆盖”真正成立：
// operator_conflict skill 文件会从 delivery 中扣留，因此除非 --force，adapter 绝不会覆盖操作员
// 编辑。hash_conflict（尚无 manifest）继续作为 P17 overwrite-with-warning fallback；没有记录的
// last hash 时，无法区分 operator 与 stale。

function skillEntry(over: Partial<ProjectionEntry> = {}): ProjectionEntry {
  return {
    category: "skill",
    effectiveId: "my-skill",
    sourceSpec: "spec",
    sourcePath: "/src",
    resourcePath: "skills/my-skill",
    absolutePath: "/src/skills/my-skill",
    classification: "operator_conflict",
    conflictDetail: {
      reason:
        'skill "my-skill" was modified after OpenRig last projected it (operator edit?) — not overwriting; move it aside or fold it into the spec, then re-project',
    },
    ...over,
  };
}

function skillFile(dir = "/src/skills/my-skill"): ResolvedStartupFile {
  return {
    path: "SKILL.md",
    absolutePath: `${dir}/SKILL.md`,
    ownerRoot: "/src",
    deliveryHint: "skill_install",
    required: true,
    appliesOn: ["fresh_start"],
    kind: "file",
  };
}

describe("P20 atom-4 protect——从 delivery 扣留 operator_conflict skill", () => {
  it("扣留目录为 operator_conflict 的 skill 文件（force=false）", () => {
    const plan = { conflicts: [skillEntry()] };
    const files = [skillFile("/src/skills/my-skill"), skillFile("/src/skills/other")];
    const { delivered, protected: held } = filterProtectedProjections(files, plan, { force: false });
    expect(held.map((f) => f.absolutePath)).toEqual(["/src/skills/my-skill/SKILL.md"]);
    expect(delivered.map((f) => f.absolutePath)).toEqual(["/src/skills/other/SKILL.md"]);
  });

  it("force=true 覆盖 protect，全部 delivery，不扣留任何内容", () => {
    const plan = { conflicts: [skillEntry()] };
    const files = [skillFile("/src/skills/my-skill")];
    const { delivered, protected: held } = filterProtectedProjections(files, plan, { force: true });
    expect(held).toEqual([]);
    expect(delivered).toHaveLength(1);
  });

  it("hash_conflict（无 manifest fallback）不执行 protect，保持 overwrite-with-warning", () => {
    const plan = { conflicts: [skillEntry({ classification: "hash_conflict" })] };
    const files = [skillFile("/src/skills/my-skill")];
    const { delivered, protected: held } = filterProtectedProjections(files, plan, { force: false });
    expect(held).toEqual([]);
    expect(delivered).toHaveLength(1);
  });

  it("无 conflict → 全部 delivery，无扣留", () => {
    const { delivered, protected: held } = filterProtectedProjections([skillFile()], { conflicts: [] }, {});
    expect(held).toEqual([]);
    expect(delivered).toHaveLength(1);
  });
});

describe("P20 atom-4 warning 分支——按 classification 区分 protect 与弱化 overwrite 尾部", () => {
  it("operator_conflict warning 表明已 PROTECTED 并提示 --force，而非将被覆盖", () => {
    const [w] = projectionConflictWarnings({ conflicts: [skillEntry({ classification: "operator_conflict" })] });
    expect(w).toMatch(/not overwrit|protected/i);
    expect(w).toMatch(/--force/);
    expect(w).not.toMatch(/will be overwritten by re-projection/);
  });

  it("hash_conflict warning 是弱化的无 manifest overwrite 通知，不声称 protect/--force", () => {
    const [w] = projectionConflictWarnings({
      conflicts: [
        skillEntry({
          classification: "hash_conflict",
          conflictDetail: { reason: 'skill "my-skill" exists at target with different content' },
        }),
      ],
    });
    expect(w).toMatch(/manifest/i);
    expect(w).not.toMatch(/--force/);
  });
});
