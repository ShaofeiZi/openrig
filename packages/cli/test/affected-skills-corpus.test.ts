// OPR.0.3.3.13.2 AC-3b——affected-skill 输出对照新签入的
// v0.3.2-affected-skills 期望集 fixture 校验（backfill + 期望查找输出的冻结快照）。
// 自包含：从 fixture 的 `skills` map 重算，故确定性 + 可移植，且不读取
// 线上 substrate corpus。证明零漏报（所有 affected 都在）且零误报
//（其余都不在）。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { computeAffectedSkills, type SkillIndexEntry } from "../src/release-surface/affected-skills.js";
import type { SurfaceDiff } from "../src/release-surface/surface-diff.js";

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
function readYaml<T>(rel: string): T {
  return parseYaml(fs.readFileSync(repoPath(rel), "utf8")) as T;
}

interface AffectedFixture {
  release_from: string;
  release_to: string;
  affected_skills: string[];
  skills: Record<string, string[]>;
}

describe("affected-skills AC-3b - v0.3.2 expected affected-skills fixture", () => {
  const fixture = readYaml<AffectedFixture>("src/release-surface/v0.3.2-affected-skills.fixture.yaml");
  const diff = readYaml<SurfaceDiff>("src/release-surface/release-surface-diff.v0.3.1-v0.3.2.yaml");
  const skills: SkillIndexEntry[] = Object.entries(fixture.skills).map(
    ([name, cliSurfacesReferenced]) => ({ name, cliSurfacesReferenced }),
  );

  it("computeAffectedSkills over the frozen v0.3.2 backfill equals the expected affected_skills", () => {
    const got = computeAffectedSkills(diff, skills);
    // zero false-negative AND zero false-positive vs the expected set
    expect(got).toEqual([...fixture.affected_skills].sort());
  });

  it("the non-affected remainder stays out (false-positive floor)", () => {
    const affected = new Set(fixture.affected_skills);
    const notAffected = skills.map((s) => s.name).filter((n) => !affected.has(n));
    expect(skills.length).toBe(45);
    expect(fixture.affected_skills.length).toBe(11);
    expect(notAffected.length).toBe(34);
    // 代表性未受影响 skill（无 queue-create / bundle / workspace token）
    for (const n of ["openrig-upgrade", "rig-lifecycle", "feature-rollout", "openrig-architect"]) {
      expect(fixture.affected_skills).not.toContain(n);
    }
  });

  it("every affected skill is explained by a v0.3.2 added surface (queue create / bundle* / workspace)", () => {
    // 每个 affected skill 必须至少携带一个 token，其首段是 v0.3.2 实际新增的
    // 命令根之一——无无理由的纳入。
    const roots = new Set(["queue", "bundle", "workspace", "scope", "policy"]);
    for (const name of fixture.affected_skills) {
      const tokens = fixture.skills[name] ?? [];
      const explained = tokens.some((t) => roots.has(t.replace(/^rig\s+/, "").split(/\s+/)[0]!));
      expect(explained, `${name} should carry a v0.3.2-root token`).toBe(true);
    }
  });
});
