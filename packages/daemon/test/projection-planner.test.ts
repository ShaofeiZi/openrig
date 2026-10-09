import { describe, it, expect } from "vitest";
import { planProjection, type ProjectionFsOps, type ProjectionInput } from "../src/domain/projection-planner.js";
import { hashContent } from "../src/domain/conflict-detector.js";
import type { ResolvedNodeConfig, QualifiedResource, ResolvedResources } from "../src/domain/profile-resolver.js";
import type { ResourceCollision } from "../src/domain/agent-resolver.js";
import type { StartupBlock, StartupFile } from "../src/domain/types.js";

function makeFile(path: string): StartupFile {
  return { path, deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] };
}

function makeQR(id: string, path: string, sourceSpec = "base", sourcePath = "/agents/base"): QualifiedResource {
  return { effectiveId: id, sourceSpec, sourcePath, resource: { id, path } as QualifiedResource["resource"] };
}

function makeGuidanceQR(id: string, path: string, target: string, merge: "managed_block" | "append"): QualifiedResource {
  return { effectiveId: id, sourceSpec: "base", sourcePath: "/agents/base", resource: { id, path, target, merge } as QualifiedResource["resource"] };
}

function makeRuntimeResourceQR(id: string, path: string, runtime: string, type = "plugin"): QualifiedResource {
  return { effectiveId: id, sourceSpec: "base", sourcePath: "/agents/base", resource: { id, path, runtime, type } as QualifiedResource["resource"] };
}

function makePluginQR(id: string, path: string, sourceSpec = "base", sourcePath = "/agents/base"): QualifiedResource {
  return { effectiveId: id, sourceSpec, sourcePath, resource: { id, source: { kind: "local", path } } as QualifiedResource["resource"] };
}

function emptyResources(): ResolvedResources {
  return { skills: [], guidance: [], subagents: [], plugins: [], runtimeResources: [] };
}

function makeConfig(overrides?: Partial<ResolvedNodeConfig>): ResolvedNodeConfig {
  return {
    runtime: "claude-code",
    model: undefined,
    cwd: ".",
    restorePolicy: "resume_if_possible",
    lifecycle: undefined,
    selectedResources: emptyResources(),
    startup: { files: [], actions: [] },
    resolvedSpecName: "test",
    resolvedSpecVersion: "1.0",
    resolvedSpecHash: "abc",
    ...overrides,
  };
}

function mockFs(files?: Record<string, string>): ProjectionFsOps {
  const store = files ?? {};
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    exists: (p: string) => p in store,
  };
}

describe("投影规划器", () => {
  // T1：已解析 node 只为所选资源生成计划。
  it("只为所选资源生成计划", () => {
    const config = makeConfig({
      selectedResources: { ...emptyResources(), skills: [makeQR("skill-a", "skills/a")] },
    });
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries).toHaveLength(1);
      expect(result.plan.entries[0]!.effectiveId).toBe("skill-a");
      expect(result.plan.entries[0]!.category).toBe("skill");
    }
  });

  // T2：排除不匹配的 runtime_resources。
  it("排除不匹配的 runtime_resources", () => {
    const config = makeConfig({
      runtime: "claude-code",
      selectedResources: { ...emptyResources(), runtimeResources: [makeRuntimeResourceQR("codex-ext", "extensions/codex", "codex")] },
    });
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries).toHaveLength(0);
    }
  });

  // T3：包含匹配的 runtime_resources。
  it("包含匹配的 runtime_resources", () => {
    const config = makeConfig({
      runtime: "claude-code",
      selectedResources: { ...emptyResources(), runtimeResources: [makeRuntimeResourceQR("claude-ext", "runtime/claude-settings.json", "claude-code", "claude_settings_fragment")] },
    });
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries).toHaveLength(1);
      expect(result.plan.entries[0]!.effectiveId).toBe("claude-ext");
      expect(result.plan.entries[0]!.resourceType).toBe("claude_settings_fragment");
    }
  });

  // T4：按顺序保留重复 startup 文件投递。
  it("按顺序保留重复 startup 文件", () => {
    const startup: StartupBlock = {
      files: [makeFile("base.md"), makeFile("profile.md"), makeFile("base.md")],
      actions: [],
    };
    const config = makeConfig({ startup });
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.startup.files).toHaveLength(3);
      expect(result.plan.startup.files[0]!.path).toBe("base.md");
      expect(result.plan.startup.files[2]!.path).toBe("base.md");
    }
  });

  // T5：将 managed-block guidance 分类为 managed_merge。
  it("通过 classifyResourceProjection 将 managed-block guidance 分类为 managed_merge", () => {
    const config = makeConfig({
      selectedResources: { ...emptyResources(), guidance: [makeGuidanceQR("tdd-rules", "guidance/tdd.md", "claude_md", "managed_block")] },
    });
    const result = planProjection({
      config, collisions: [], fsOps: mockFs(),
      resolveTargetPath: () => "/project/CLAUDE.md",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries).toHaveLength(1);
      expect(result.plan.entries[0]!.classification).toBe("managed_merge");
      expect(result.plan.entries[0]!.mergeStrategy).toBe("managed_block");
    }
  });

  // T6：将 hash 不匹配分类为 hash_conflict。
  it("通过 classifyResourceProjection 将 hash 不匹配分类为 hash_conflict", () => {
    const config = makeConfig({
      selectedResources: { ...emptyResources(), skills: [makeQR("skill-a", "skills/a")] },
    });
    const fs = mockFs({
      "/agents/base/skills/a": "source content",
      "/project/.claude/skills/skill-a/SKILL.md": "different target content",
    });
    const result = planProjection({
      config, collisions: [], fsOps: fs,
      resolveTargetPath: () => "/project/.claude/skills/skill-a/SKILL.md",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0]!.classification).toBe("hash_conflict");
      expect(result.plan.conflicts).toHaveLength(1);
    }
  });

  it("P20：target == manifest 中的上次投影（source 已前进）→ stale_overwrite，安全（0 冲突）", () => {
    const config = makeConfig({
      selectedResources: { ...emptyResources(), skills: [makeQR("skill-a", "skills/a")] },
    });
    const fs = mockFs({
      "/agents/base/skills/a": "source content NEW",
      "/project/.claude/skills/skill-a/SKILL.md": "old projected content",
    });
    const result = planProjection({
      config, collisions: [], fsOps: fs,
      resolveTargetPath: () => "/project/.claude/skills/skill-a/SKILL.md",
      lastHashLookup: () => hashContent("old projected content"), // manifest：这正是我们写入的内容。
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0]!.classification).toBe("stale_overwrite");
      expect(result.plan.conflicts).toHaveLength(0); // 安全刷新——不受保护。
    }
  });

  it("P20：target 同时偏离 manifest 和 source → operator_conflict，受保护（一个冲突）", () => {
    const config = makeConfig({
      selectedResources: { ...emptyResources(), skills: [makeQR("skill-a", "skills/a")] },
    });
    const fs = mockFs({
      "/agents/base/skills/a": "source content NEW",
      "/project/.claude/skills/skill-a/SKILL.md": "OPERATOR HAND EDIT",
    });
    const result = planProjection({
      config, collisions: [], fsOps: fs,
      resolveTargetPath: () => "/project/.claude/skills/skill-a/SKILL.md",
      lastHashLookup: () => hashContent("what we projected before"), // ≠ 当前 target → 操作员编辑过。
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0]!.classification).toBe("operator_conflict");
      expect(result.plan.conflicts).toHaveLength(1); // 受保护（不覆盖）。
      expect(result.plan.conflicts[0]!.conflictDetail?.reason).toMatch(/上次投影后被修改/i);
    }
  });

  // T7：拒绝 selectedResources 中因 import/import 冲突而产生歧义的资源。
  it("拒绝 import/import 冲突中有歧义的未限定资源", () => {
    const config = makeConfig({
      selectedResources: { ...emptyResources(), skills: [makeQR("shared", "skills/shared", "lib-a", "/agents/lib-a")] },
    });
    const collisions: ResourceCollision[] = [{
      category: "skills",
      resourceId: "shared",
      sources: [
        { specName: "lib-a", qualifiedId: "lib-a:shared" },
        { specName: "lib-b", qualifiedId: "lib-b:shared" },
      ],
    }];
    const result = planProjection({ config, collisions, fsOps: mockFs() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/shared.*存在歧义/);
    }
  });

  // T7b：接受 base owner 拥有未限定 id 的 base/import 冲突（无歧义）。
  it("接受 base 拥有未限定 id 的 base/import 冲突", () => {
    const config = makeConfig({
      selectedResources: { ...emptyResources(), skills: [makeQR("foo", "skills/foo", "base", "/agents/base")] },
    });
    const collisions: ResourceCollision[] = [{
      category: "skills",
      resourceId: "foo",
      sources: [
        { specName: "base", qualifiedId: "foo" }, // base 拥有它。
        { specName: "lib", qualifiedId: "lib:foo" },
      ],
    }];
    const result = planProjection({ config, collisions, fsOps: mockFs() });
    expect(result.ok).toBe(true);
  });

  // T8：出现冲突时限定引用成功。
  it("出现冲突时限定引用成功", () => {
    const config = makeConfig({
      selectedResources: { ...emptyResources(), skills: [makeQR("lib-a:shared", "skills/shared", "lib-a", "/agents/lib-a")] },
    });
    const collisions: ResourceCollision[] = [{
      category: "skills",
      resourceId: "shared",
      sources: [
        { specName: "lib-a", qualifiedId: "lib-a:shared" },
        { specName: "lib-b", qualifiedId: "lib-b:shared" },
      ],
    }];
    const result = planProjection({ config, collisions, fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries).toHaveLength(1);
      expect(result.plan.entries[0]!.effectiveId).toBe("lib-a:shared");
    }
  });

  // T9：相同内容 = no_op（通过 classifyResourceProjection）。
  it("通过 conflict-detector 将相同内容分类为 no_op", async () => {
    const { classifyResourceProjection } = await import("../src/domain/conflict-detector.js");
    const fs = {
      readFile: () => "same content",
      exists: () => true,
    };
    const result = classifyResourceProjection("/src/skill", "/target/skill", "skill", undefined, fs);
    expect(result).toBe("no_op");
  });

  // T8c：跨类别冲突不会误拒绝。
  it("guidance 中的 'shared' 冲突不会拒绝所选 skill 'shared'", () => {
    const config = makeConfig({
      selectedResources: { ...emptyResources(), skills: [makeQR("shared", "skills/shared")] },
    });
    // 冲突位于 guidance 类别，而非 skills。
    const collisions: ResourceCollision[] = [{
      category: "guidance",
      resourceId: "shared",
      sources: [
        { specName: "lib-a", qualifiedId: "lib-a:shared" },
        { specName: "lib-b", qualifiedId: "lib-b:shared" },
      ],
    }];
    const result = planProjection({ config, collisions, fsOps: mockFs() });
    expect(result.ok).toBe(true); // 不应被拒绝。
    if (result.ok) {
      expect(result.plan.entries).toHaveLength(1);
      expect(result.plan.entries[0]!.effectiveId).toBe("shared");
    }
  });

  // T10：相同输入产生确定性输出。
  it("为相同输入生成确定性输出", () => {
    const config = makeConfig({
      selectedResources: {
        ...emptyResources(),
        skills: [makeQR("b-skill", "skills/b"), makeQR("a-skill", "skills/a")],
        plugins: [makePluginQR("plugin-z", "/abs/plugins/z")],
      },
    });
    const input: ProjectionInput = { config, collisions: [], fsOps: mockFs() };
    const r1 = planProjection(input);
    const r2 = planProjection(input);
    expect(r1).toEqual(r2);
    if (r1.ok && r2.ok) {
      // 验证排序顺序：按字母顺序 plugin（p）< skill（s）。
      expect(r1.plan.entries[0]!.category).toBe("plugin");
      expect(r1.plan.entries[1]!.effectiveId).toBe("a-skill");
      expect(r1.plan.entries[2]!.effectiveId).toBe("b-skill");
    }
  });
});

// ── P17（发现 A2，finder 所有）：已接线的失效 hash-conflict detector ──
// planner 的冲突通道已经存在，但生产代码从未注入 resolveTargetPath（在 4.8 restack 中丢失；
// instantiator 自身的 §6 注释记录了 warnings-site 串接丢失），因此所有 entry 都被分类为
// safe_projection，操作员修改的 target 也被静默覆盖。RED-first 针对：(1) 缺失的生产 resolver；
// (2) dir-shaped skill 的真实性（真实 skill source 是目录；classifier 必须比较代表文件 SKILL.md，
// 而不是因 readFile(dir) 抛错得出错误 verdict）；(3) conflicts->warnings 展示 helper。
import {
  claudeConflictTargetPath,
  projectionConflictWarnings,
} from "../src/domain/projection-planner.js";

describe("P17——生产 conflict-target resolver（claudeConflictTargetPath）", () => {
  it("将 skill 映射到投影的 SKILL.md、subagent 映射到 agents/<source basename>、guidance 映射到 CLAUDE.md", () => {
    expect(claudeConflictTargetPath("skill", "skill-a", "/w", "/agents/base/skills/a")).toBe(
      "/w/.claude/skills/skill-a/SKILL.md",
    );
    expect(claudeConflictTargetPath("subagent", "rev", "/w", "/agents/base/subagents/reviewer.md")).toBe(
      "/w/.claude/agents/reviewer.md",
    );
    expect(claudeConflictTargetPath("guidance", "tdd", "/w", "/agents/base/guidance/tdd.md")).toBe("/w/CLAUDE.md");
  });

  it("对 merge/复杂类别（plugin、runtime_resource）返回 null，分类继续推迟", () => {
    expect(claudeConflictTargetPath("plugin", "p", "/w", "/agents/base/plugins/p")).toBeNull();
    expect(claudeConflictTargetPath("runtime_resource", "r", "/w", "/agents/base/rr/r")).toBeNull();
  });
});

describe("P17——dir-shaped skill source 比较代表文件 SKILL.md", () => {
  it("操作员修改的已投影 SKILL.md 分类为 hash_conflict，未修改项分类为 no_op", () => {
    const config = makeConfig({
      selectedResources: { ...emptyResources(), skills: [makeQR("skill-a", "skills/a")] },
    });
    // dir-shaped source：未定义对目录路径的 readFile（真实 fs 会抛错）；实际存在的是代表文件。
    const fs = mockFs({
      "/agents/base/skills/a/SKILL.md": "shipped content",
      "/w/.claude/skills/skill-a/SKILL.md": "OPERATOR EDITED",
    });
    const result = planProjection({
      config, collisions: [], fsOps: fs,
      resolveTargetPath: (cat, id, _cwd, src) => claudeConflictTargetPath(cat, id, "/w", src),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0]!.classification).toBe("hash_conflict");
      expect(result.plan.conflicts).toHaveLength(1);
    }
    const clean = planProjection({
      config, collisions: [],
      fsOps: mockFs({
        "/agents/base/skills/a/SKILL.md": "shipped content",
        "/w/.claude/skills/skill-a/SKILL.md": "shipped content",
      }),
      resolveTargetPath: (cat, id, _cwd, src) => claudeConflictTargetPath(cat, id, "/w", src),
    });
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.plan.entries[0]!.classification).toBe("no_op");
  });
});

describe("P17——显著展示冲突（绝不静默覆盖）", () => {
  it("projectionConflictWarnings 点明文件、原因与解决路径", () => {
    const warnings = projectionConflictWarnings({
      conflicts: [
        {
          category: "skill", effectiveId: "skill-a",
          absolutePath: "/agents/base/skills/a",
          classification: "hash_conflict",
          conflictDetail: { reason: 'skill "skill-a" exists at target with different content' },
        },
      ],
    } as never);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/skill-a/);
    expect(warnings[0]).toMatch(/different content/);
    expect(warnings[0]).toMatch(/会覆盖/); // 明确说明后果，而非暗示。
  });

  it("接线钉扎（P16 类别）：生产 planProjection 调用注入 resolver 并串接冲突警告", () => {
    const fsMod = require("node:fs") as typeof import("node:fs");
    const src = fsMod.readFileSync(new URL("../src/domain/rigspec-instantiator.ts", import.meta.url), "utf8");
    const callBlock = /planProjection\(\{[\s\S]{0,1000}?\}\);/.exec(src)?.[0] ?? "";
    // #25：resolver 可包一层以传递 rig 的 managed-block 文件。
    expect(callBlock, "planProjection 调用必须注入 resolveTargetPath").toMatch(
      /resolveTargetPath: (claudeConflictTargetPath\b|\([^)]*\) => claudeConflictTargetPath\()/,
    );
    expect(src, "冲突警告必须串接到 warnings surface").toContain("projectionConflictWarnings(planResult.plan)");
  });
});
