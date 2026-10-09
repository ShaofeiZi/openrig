import { describe, it, expect, vi } from "vitest";
import { detectConflicts, type GuidanceConflictMeta } from "../src/domain/conflict-detector.js";
import { InstallPlanner, type InstallPlanEntry } from "../src/domain/install-planner.js";
import { PackageResolver, type FsOps } from "../src/domain/package-resolver.js";

function mockFs(files: Record<string, string>): FsOps {
  return {
    readFile: vi.fn((p: string) => {
      if (files[p] !== undefined) return files[p]!;
      throw new Error(`ENOENT: ${p}`);
    }),
    exists: vi.fn((p: string) => p in files),
  };
}

const SKILL_CONTENT = "# Skill\nSome content";
const SKILL_CONTENT_DIFFERENT = "# Skill\nDifferent content";
const AGENT_CONTENT = "name: reviewer\nruntime: claude-code";
const AGENT_CONTENT_DIFFERENT = "name: reviewer\nruntime: codex";

const BASIC_MANIFEST = `
schema_version: 1
name: test-pkg
version: 1.0.0
summary: Test
compatibility:
  runtimes: [codex]
exports:
  skills:
    - source: skills/foo
      name: foo
  guidance:
    - source: guidance/AGENTS.md
      name: review-guide
      kind: agents_md
      merge_strategy: managed_block
  agents:
    - source: agents/reviewer.yaml
`;

function resolveAndPlan(manifestYaml: string, repoFiles: Record<string, string>, runtime: "claude-code" | "codex" = "codex") {
  const pkgFiles: Record<string, string> = { "/pkg/package.yaml": manifestYaml };
  // 添加包源文件。
  pkgFiles["/pkg/skills/foo/SKILL.md"] = SKILL_CONTENT;
  pkgFiles["/pkg/guidance/AGENTS.md"] = "# Guidance content";
  pkgFiles["/pkg/agents/reviewer.yaml"] = AGENT_CONTENT;

  const resolverFs = mockFs(pkgFiles);
  const resolved = new PackageResolver(resolverFs).resolve("/pkg");

  // 规划器需要读取仓库文件以执行 exists() 检查。
  const allFiles = { ...pkgFiles, ...repoFiles };
  const plannerFs = mockFs(allFiles);
  const plan = new InstallPlanner(plannerFs).plan(resolved, "/repo", runtime);

  // 检测器需要包源文件和仓库目标文件。
  const detectorFs = mockFs(allFiles);
  return detectConflicts(plan, detectorFs);
}

describe("ConflictDetector", () => {
  // 测试 1：新技能 → safe_projection。
  it("新技能 → safe_projection 保持不变", () => {
    const result = resolveAndPlan(BASIC_MANIFEST, {});
    const skill = result.actionable.find((e) => e.exportType === "skill");
    expect(skill).toBeDefined();
    expect(skill!.classification).toBe("safe_projection");
    expect(result.noOps).toHaveLength(0);
  });

  // 测试 2：技能已存在且内容不同 → 冲突并携带哈希。
  it("技能已存在且内容不同 → 冲突并携带哈希", () => {
    const result = resolveAndPlan(BASIC_MANIFEST, {
      "/repo/.agents/skills/foo/SKILL.md": SKILL_CONTENT_DIFFERENT,
    });
    const conflict = result.conflicts.find((e) => e.exportName === "foo/SKILL.md");
    expect(conflict).toBeDefined();
    expect(conflict!.conflict!.existingHash).toBeDefined();
    expect(conflict!.conflict!.sourceHash).toBeDefined();
    expect(conflict!.conflict!.existingHash).not.toBe(conflict!.conflict!.sourceHash);
  });

  // 测试 3：技能已存在且内容相同 → 不操作。
  it("技能已存在且内容相同 → 不操作", () => {
    const result = resolveAndPlan(BASIC_MANIFEST, {
      "/repo/.agents/skills/foo/SKILL.md": SKILL_CONTENT,
    });
    expect(result.noOps).toHaveLength(1);
    expect(result.noOps[0]!.exportName).toBe("foo/SKILL.md");
    expect(result.conflicts).toHaveLength(0);
  });

  // 测试 4：新指导文件 → safe_projection。
  it("新指导文件 → safe_projection", () => {
    const result = resolveAndPlan(BASIC_MANIFEST, {});
    const guidance = result.actionable.find((e) => e.exportType === "guidance");
    expect(guidance).toBeDefined();
    expect(guidance!.classification).toBe("safe_projection");
  });

  // 测试 5：指导文件已存在但没有托管块 → managed_merge，hasExistingBlock=false。
  it("指导文件已存在但没有托管块 → managed_merge，hasExistingBlock=false", () => {
    const result = resolveAndPlan(BASIC_MANIFEST, {
      "/repo/AGENTS.md": "# Some existing content\nNo managed blocks here.",
    });
    const guidance = result.actionable.find((e) => e.exportType === "guidance") as InstallPlanEntry & { guidanceMeta?: GuidanceConflictMeta };
    expect(guidance).toBeDefined();
    expect(guidance!.classification).toBe("managed_merge");
    expect(guidance!.guidanceMeta?.hasExistingBlock).toBe(false);
  });

  // 测试 6：指导文件已存在且有托管块 → managed_merge，hasExistingBlock=true。
  it("指导文件已存在且有托管块 → managed_merge，hasExistingBlock=true", () => {
    const result = resolveAndPlan(BASIC_MANIFEST, {
      "/repo/AGENTS.md": "# Header\n<!-- BEGIN OpenRig MANAGED BLOCK: test-pkg -->\nold content\n<!-- END OpenRig MANAGED BLOCK: test-pkg -->\n# Footer",
    });
    const guidance = result.actionable.find((e) => e.exportType === "guidance") as InstallPlanEntry & { guidanceMeta?: GuidanceConflictMeta };
    expect(guidance).toBeDefined();
    expect(guidance!.classification).toBe("managed_merge");
    expect(guidance!.guidanceMeta?.hasExistingBlock).toBe(true);
  });

  // 测试 7：Hook → 延后透传。
  it("hook → config_mutation，延后透传", () => {
    const manifest = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [codex]
exports:
  skills:
    - source: skills/foo
      name: foo
  hooks:
    - source: hooks/check.yaml
`;
    const pkgFiles: Record<string, string> = {
      "/pkg/package.yaml": manifest,
      "/pkg/skills/foo/SKILL.md": SKILL_CONTENT,
    };
    const resolverFs = mockFs(pkgFiles);
    const resolved = new PackageResolver(resolverFs).resolve("/pkg");
    const plannerFs = mockFs(pkgFiles);
    const plan = new InstallPlanner(plannerFs).plan(resolved, "/repo", "codex");
    const result = detectConflicts(plan, plannerFs);

    const hook = result.deferred.find((e) => e.exportType === "hook");
    expect(hook).toBeDefined();
    expect(hook!.deferred).toBe(true);
  });

  // 测试 8：MCP → 延后透传。
  it("MCP → config_mutation，延后透传", () => {
    const manifest = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [codex]
exports:
  skills:
    - source: skills/foo
      name: foo
  mcp:
    - source: mcp/ctx.yaml
`;
    const pkgFiles: Record<string, string> = {
      "/pkg/package.yaml": manifest,
      "/pkg/skills/foo/SKILL.md": SKILL_CONTENT,
    };
    const resolverFs = mockFs(pkgFiles);
    const resolved = new PackageResolver(resolverFs).resolve("/pkg");
    const plannerFs = mockFs(pkgFiles);
    const plan = new InstallPlanner(plannerFs).plan(resolved, "/repo", "codex");
    const result = detectConflicts(plan, plannerFs);

    const mcp = result.deferred.find((e) => e.exportType === "mcp");
    expect(mcp).toBeDefined();
    expect(mcp!.deferred).toBe(true);
  });

  // 测试 9：Requirement → external_install，延后透传。
  it("requirement → external_install，延后透传", () => {
    const manifest = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [codex]
exports:
  skills:
    - source: skills/foo
      name: foo
requirements:
  cli_tools:
    - name: ripgrep
`;
    const pkgFiles: Record<string, string> = {
      "/pkg/package.yaml": manifest,
      "/pkg/skills/foo/SKILL.md": SKILL_CONTENT,
    };
    const resolverFs = mockFs(pkgFiles);
    const resolved = new PackageResolver(resolverFs).resolve("/pkg");
    const plannerFs = mockFs(pkgFiles);
    const plan = new InstallPlanner(plannerFs).plan(resolved, "/repo", "codex");
    const result = detectConflicts(plan, plannerFs);

    const req = result.deferred.find((e) => e.exportType === "requirement");
    expect(req).toBeDefined();
    expect(req!.classification).toBe("external_install");
  });

  // 测试 10：同时报告多个冲突。
  it("同时报告多个冲突", () => {
    const manifest = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [codex]
exports:
  skills:
    - source: skills/foo
      name: foo
    - source: skills/bar
      name: bar
`;
    const pkgFiles: Record<string, string> = {
      "/pkg/package.yaml": manifest,
      "/pkg/skills/foo/SKILL.md": SKILL_CONTENT,
      "/pkg/skills/bar/SKILL.md": "# Bar skill",
    };
    const repoFiles: Record<string, string> = {
      "/repo/.agents/skills/foo/SKILL.md": SKILL_CONTENT_DIFFERENT,
      "/repo/.agents/skills/bar/SKILL.md": "# Bar different",
    };
    const allFiles = { ...pkgFiles, ...repoFiles };
    const resolverFs = mockFs(pkgFiles);
    const resolved = new PackageResolver(resolverFs).resolve("/pkg");
    const plannerFs = mockFs(allFiles);
    const plan = new InstallPlanner(plannerFs).plan(resolved, "/repo", "codex");
    const result = detectConflicts(plan, mockFs(allFiles));

    expect(result.conflicts).toHaveLength(2);
  });

  // 测试 11：托管块属于另一个包 → hasExistingBlock=false。
  it("现有指导文件的托管块属于另一个包 → hasExistingBlock=false", () => {
    const result = resolveAndPlan(BASIC_MANIFEST, {
      "/repo/AGENTS.md": "# Header\n<!-- BEGIN OpenRig MANAGED BLOCK: other-package -->\nother content\n<!-- END OpenRig MANAGED BLOCK: other-package -->\n",
    });
    const guidance = result.actionable.find((e) => e.exportType === "guidance") as InstallPlanEntry & { guidanceMeta?: GuidanceConflictMeta };
    expect(guidance).toBeDefined();
    expect(guidance!.guidanceMeta?.hasExistingBlock).toBe(false);
  });

  // 测试 12：智能体已存在且内容相同 → 不操作。
  it("智能体已存在且内容相同 → 不操作", () => {
    const result = resolveAndPlan(BASIC_MANIFEST, {
      "/repo/.agents/reviewer.yaml": AGENT_CONTENT,
    });
    const agentNoOp = result.noOps.find((e) => e.exportType === "agent");
    expect(agentNoOp).toBeDefined();
    expect(agentNoOp!.exportName).toBe("reviewer");
  });

  // 测试 13：智能体已存在且内容不同 → 冲突。
  it("智能体已存在且内容不同 → 冲突", () => {
    const result = resolveAndPlan(BASIC_MANIFEST, {
      "/repo/.agents/reviewer.yaml": AGENT_CONTENT_DIFFERENT,
    });
    const conflict = result.conflicts.find((e) => e.exportType === "agent");
    expect(conflict).toBeDefined();
    expect(conflict!.conflict!.existingHash).toBeDefined();
    expect(conflict!.conflict!.sourceHash).toBeDefined();
  });

  // 测试 14：智能体目标路径是 YAML 文件。
  it("智能体目标路径是 .yaml 文件而非目录", () => {
    const result = resolveAndPlan(BASIC_MANIFEST, {});
    const agent = result.entries.find((e) => e.exportType === "agent");
    expect(agent).toBeDefined();
    expect(agent!.targetPath).toMatch(/\.yaml$/);
    expect(agent!.targetPath).toContain("reviewer.yaml");
  });

  // 测试 15：Requirement 条目的 sourcePath 为 undefined。
  it("requirement 条目的 sourcePath 为 undefined 时原样透传", () => {
    const manifest = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [codex]
exports:
  skills:
    - source: skills/foo
      name: foo
requirements:
  cli_tools:
    - name: ripgrep
`;
    const pkgFiles: Record<string, string> = {
      "/pkg/package.yaml": manifest,
      "/pkg/skills/foo/SKILL.md": SKILL_CONTENT,
    };
    const resolverFs = mockFs(pkgFiles);
    const resolved = new PackageResolver(resolverFs).resolve("/pkg");
    const plannerFs = mockFs(pkgFiles);
    const plan = new InstallPlanner(plannerFs).plan(resolved, "/repo", "codex");

    const reqEntry = plan.entries.find((e) => e.exportType === "requirement");
    expect(reqEntry).toBeDefined();
    expect(reqEntry!.sourcePath).toBeUndefined();

    const result = detectConflicts(plan, plannerFs);
    const refinedReq = result.deferred.find((e) => e.exportType === "requirement");
    expect(refinedReq).toBeDefined();
    expect(refinedReq!.sourcePath).toBeUndefined();
  });
});
