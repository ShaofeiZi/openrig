import { describe, it, expect } from "vitest";
import { resolveExports } from "../src/domain/role-resolver.js";
import { normalizeManifest, parseManifest } from "../src/domain/package-manifest.js";

function makeManifest(yaml: string) {
  return normalizeManifest(parseManifest(yaml));
}

const FULL_MANIFEST = makeManifest(`
schema_version: 1
name: test-pkg
version: 1.0.0
summary: Test
compatibility:
  runtimes: [claude-code, codex]
exports:
  skills:
    - source: skills/foo
      name: foo
    - source: skills/bar
      name: bar
  guidance:
    - source: guidance/AGENTS.md
      name: review-guidelines
      kind: agents_md
      merge_strategy: managed_block
  agents:
    - source: agents/reviewer.yaml
  hooks:
    - source: hooks/checkpoint.yaml
      supported_runtimes: [claude-code]
  mcp:
    - source: mcp/context7.yaml
      supported_runtimes: [claude-code]
roles:
  - name: reviewer
    skills: [foo]
    guidance: [review-guidelines]
    hooks: [hooks/checkpoint.yaml]
    context: [docs/workflow-guide.md]
  - name: full-stack
    skills: [foo, bar]
`);

describe("RoleResolver", () => {
  // 测试 1：仅包含 skill 的 role -> 输出引用的 skill
  it("仅包含 skill 的 role -> 输出引用的 skill", () => {
    const result = resolveExports(FULL_MANIFEST, "full-stack");
    expect(result.skills).toHaveLength(2);
    expect(result.skills.map((s) => s.name).sort()).toEqual(["bar", "foo"]);
  });

  // 测试 2：包含 hook 的 role -> hook 延后，skill 仍可操作
  it("包含 hook 的 role -> hook 延后，skill 仍可操作", () => {
    const result = resolveExports(FULL_MANIFEST, "reviewer");
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.name).toBe("foo");
    expect(result.deferred.some((d) => d.exportType === "hook")).toBe(true);
  });

  // 测试 3：role 引用不存在的 skill -> error
  it("role 引用不存在的 skill -> 抛错", () => {
    const manifest = makeManifest(`
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/foo
      name: foo
roles:
  - name: broken
    skills: [nonexistent]
`);
    expect(() => resolveExports(manifest, "broken")).toThrow(/不存在/);
  });

  // 测试 4：无 role -> 完整 package export
  it("无 role -> 完整 package export，并延后 hook/mcp", () => {
    const result = resolveExports(FULL_MANIFEST);
    expect(result.skills).toHaveLength(2);
    expect(result.guidance).toHaveLength(1);
    expect(result.agents).toHaveLength(1);
    expect(result.deferred).toHaveLength(2); // 1 个 hook + 1 个 mcp
  });

  // 测试 5：deferred item 包含 reason string
  it("deferred item 包含 reason string", () => {
    const result = resolveExports(FULL_MANIFEST);
    const hook = result.deferred.find((d) => d.exportType === "hook");
    expect(hook).toBeDefined();
    expect(hook!.reason).toContain("Phase 5");

    const mcp = result.deferred.find((d) => d.exportType === "mcp");
    expect(mcp).toBeDefined();
    expect(mcp!.reason).toContain("Phase 5");
  });

  // 测试 6：混合 role -> 正确拆分
  it("混合 role（skill + guidance + hook）-> 正确拆分 actionable/deferred", () => {
    const result = resolveExports(FULL_MANIFEST, "reviewer");
    // Actionable：1 个 skill + 1 个 guidance + 1 个 agent（始终包含全部 agent）
    expect(result.skills).toHaveLength(1);
    expect(result.guidance).toHaveLength(1);
    expect(result.agents).toHaveLength(1);
    // Deferred：hook + mcp
    expect(result.deferred.length).toBeGreaterThanOrEqual(1);
  });

  // 测试 7：找不到 role -> 抛错
  it("找不到 roleName -> 抛错", () => {
    expect(() => resolveExports(FULL_MANIFEST, "nonexistent-role")).toThrow(/未找到/);
  });

  // 测试 8：role filter 保留全部 agent export
  it("role filter 原样保留全部 agent export", () => {
    const result = resolveExports(FULL_MANIFEST, "reviewer");
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.source).toBe("agents/reviewer.yaml");
  });

  // 测试 9：role 包含 context -> 忽略 context
  it("role 包含 context reference -> 输出中没有 context", () => {
    const result = resolveExports(FULL_MANIFEST, "reviewer");
    // context 不应出现在 skill、guidance、agent 或 deferred 中
    const allSources = [
      ...result.skills.map((s) => s.source),
      ...result.guidance.map((g) => g.source),
      ...result.agents.map((a) => a.source),
      ...result.deferred.map((d) => d.source),
    ];
    expect(allSources).not.toContain("docs/workflow-guide.md");
  });

  // 测试 10：role 指定 hook -> 仅延后选中的 hook
  it("按 role 过滤的 resolve 仅延后 role 选中的 hook", () => {
    const manifest = makeManifest(`
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/foo
      name: foo
  hooks:
    - source: hooks/checkpoint.yaml
      supported_runtimes: [claude-code]
    - source: hooks/other.yaml
      supported_runtimes: [claude-code]
roles:
  - name: selective
    skills: [foo]
    hooks: [hooks/checkpoint.yaml]
`);
    const result = resolveExports(manifest, "selective");
    const hookSources = result.deferred.filter((d) => d.exportType === "hook").map((d) => d.source);
    expect(hookSources).toEqual(["hooks/checkpoint.yaml"]);
    expect(hookSources).not.toContain("hooks/other.yaml");
  });
});
