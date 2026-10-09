// OPR.0.3.3.13.2——Skill <-> CLI 表面绑定索引查找测试。
//
// AC-3 分两部分：
//   (3a) 归一化——expandChangedSurface 对照 13.1 真实随附的样例 diff
//        （输入语法）校验，而非假设的语法。
//   (3b) affected-skill 输出——computeAffectedSkills 对照期望集校验。
//        此处用内联 skill fixture（确定性，与 corpus 变动解耦）；
//        corpus 派生的 v0.3.2-affected-skills 回归 fixture 在
//        affected-skills-corpus.test.ts 中待 backfill 落地后断言。
// 另加顾问打磨的匹配规则判别项（逐组件前缀、up-vs-update）与 AC-4 确定性。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import type { SurfaceDiff } from "../src/release-surface/surface-diff.js";
import {
  toSegments,
  pathsMatch,
  skillTokenMatches,
  expandChangedSurface,
  computeAffectedSkills,
  parseCliSurfaces,
  type SkillIndexEntry,
} from "../src/release-surface/affected-skills.js";

function repoPath(rel: string): string {
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}
function readYaml<T>(rel: string): T {
  return parseYaml(fs.readFileSync(repoPath(rel), "utf8")) as T;
}

const SAMPLE_DIFF = "src/release-surface/release-surface-diff.v0.3.1-v0.3.2.yaml";

describe("affected-skills - toSegments / pathsMatch (the ratified match rule)", () => {
  it("strips a leading `rig ` and splits on whitespace", () => {
    expect(toSegments("rig scope slice create")).toEqual(["scope", "slice", "create"]);
    expect(toSegments("queue create")).toEqual(["queue", "create"]);
    expect(toSegments("  rig   ps  ")).toEqual(["ps"]);
    expect(toSegments("")).toEqual([]);
  });

  it("component-wise prefix matches in EITHER direction (equal or path-prefix)", () => {
    // 较短者是较长者的组件前缀（双向）
    expect(pathsMatch(["scope"], ["scope", "slice", "create"])).toBe(true);
    expect(pathsMatch(["scope", "slice", "create"], ["scope"])).toBe(true);
    // exact equality
    expect(pathsMatch(["queue", "create"], ["queue", "create"])).toBe(true);
  });

  it("does NOT raw-string-prefix match (`up` vs `update` are distinct segments)", () => {
    expect(pathsMatch(["up"], ["update"])).toBe(false);
    expect(pathsMatch(["update"], ["up"])).toBe(false);
    // divergent later segment also fails
    expect(pathsMatch(["scope", "slice"], ["scope", "mission"])).toBe(false);
    // empty either side never matches
    expect(pathsMatch([], ["scope"])).toBe(false);
  });
});

describe("affected-skills - AC-3a normalization vs 13.1's shipped sample diff", () => {
  it("expandChangedSurface expands added_commands + added_flags to the full section-3 set", () => {
    const diff = readYaml<SurfaceDiff>(SAMPLE_DIFF);
    const got = [...expandChangedSurface(diff)].sort();
    const expected = [
      // added_commands: policy + subs
      "policy", "policy cite", "policy defaults", "policy effective",
      "policy set", "policy show", "policy unset",
      // added_commands: scope + subs
      "scope", "scope mission", "scope mission create", "scope mission ls",
      "scope mission show", "scope slice", "scope slice close", "scope slice create",
      "scope slice ls", "scope slice move", "scope slice ship", "scope slice show",
      // added_flags: command (+ subcommands)
      "bundle", "bundle create", "bundle history", "bundle install",
      "queue create", "workspace", "workspace doctor",
    ].sort();
    expect(got).toEqual(expected);
  });

  it("a deep skill token (scope slice create) matches the diff even though the diff also lists bare `scope`", () => {
    const diff = readYaml<SurfaceDiff>(SAMPLE_DIFF);
    const changed = expandChangedSurface(diff);
    // the exact deep path is present
    expect(skillTokenMatches("scope slice create", changed)).toBe(true);
    // a `rig `-prefixed skill token still matches (defensive strip)
    expect(skillTokenMatches("rig scope slice create", changed)).toBe(true);
    // a skill referencing only bare `scope` is over-included (conservative bias)
    expect(skillTokenMatches("scope", changed)).toBe(true);
    // an unrelated command is NOT matched
    expect(skillTokenMatches("send", changed)).toBe(false);
    expect(skillTokenMatches("whoami", changed)).toBe(false);
  });
});

describe("affected-skills - AC-3b output (inline fixtures) + AC-4 determinism", () => {
  const diff = (): SurfaceDiff => readYaml<SurfaceDiff>(SAMPLE_DIFF);
  const skills: SkillIndexEntry[] = [
    { name: "queue-handoff", cliSurfacesReferenced: ["queue create", "send"] },
    { name: "openrig-work-codemap", cliSurfacesReferenced: ["scope slice create", "scope mission show"] },
    { name: "rig-bundles-and-shareable-artifacts", cliSurfacesReferenced: ["bundle create", "bundle install"] },
    { name: "openrig-user", cliSurfacesReferenced: ["whoami", "ps", "send"] }, // none in v0.3.2 diff
    { name: "primitive-workspace", cliSurfacesReferenced: ["workspace doctor"] },
  ];

  it("computes the affected-skill set: only skills whose tokens hit the changed surface", () => {
    const affected = computeAffectedSkills(diff(), skills);
    expect(affected).toEqual([
      "openrig-work-codemap",
      "primitive-workspace",
      "queue-handoff",
      "rig-bundles-and-shareable-artifacts",
    ]);
    // openrig-user (whoami/ps/send) is NOT affected by the v0.3.2 surface set
    expect(affected).not.toContain("openrig-user");
  });

  it("AC-4: identical (diff, skills) produces identical output (deterministic, offline)", () => {
    const a = computeAffectedSkills(diff(), skills);
    const b = computeAffectedSkills(diff(), skills);
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort()); // stable sorted order
  });
});

describe("affected-skills - parseCliSurfaces (frontmatter loader)", () => {
  it("reads metadata.cli_surfaces_referenced from a SKILL.md frontmatter block", () => {
    const md = [
      "---",
      "name: demo",
      "description: x",
      "metadata:",
      "  cli_surfaces_referenced:",
      "    - queue create",
      "    - scope slice create",
      "---",
      "",
      "# Demo",
    ].join("\n");
    expect(parseCliSurfaces(md)).toEqual(["queue create", "scope slice create"]);
  });

  it("returns [] when frontmatter, metadata, or the field is absent/malformed", () => {
    expect(parseCliSurfaces("# no frontmatter")).toEqual([]);
    expect(parseCliSurfaces("---\nname: x\n---\nbody")).toEqual([]);
    expect(parseCliSurfaces("---\nname: x\nmetadata:\n  other: 1\n---\nbody")).toEqual([]);
  });
});
