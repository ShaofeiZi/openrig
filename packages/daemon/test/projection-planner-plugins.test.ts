// plugin-primitive Phase 3a slice 3.1 测试套件——projection planner plugin path 语义。
// 按 velocity-guard cadence boundary（b）2026-05-10：在此 surface 上进一步实现前，
// 测试 ~、absolute 与 relative path 解析。
//
// Plugin source.path 可采用三种 shape（参见 DESIGN.md §5.2 示例）：
//   1. absolute system path，例如 /Users/op/.openrig/plugins/openrig-core
//   2. tilde-home-prefixed，例如 ~/.openrig/plugins/openrig-core
//   3. relative to spec dir，例如 ./plugins/openrig-core
//
// 每种形式都必须解析为单一、具体的 absolute entry.absolutePath，供 adapter 复制 plugin tree。
// tilde expansion 是必需的，因为按约定 vendored plugin 位于 ~/.openrig/plugins/<id>/，
// 用户会在 agent.yaml resource 中写入该字面路径。

import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as nodePath from "node:path";
import { planProjection, type ProjectionInput, type ProjectionFsOps } from "../src/domain/projection-planner.js";
import type { ResolvedNodeConfig, QualifiedResource, ResolvedResources } from "../src/domain/profile-resolver.js";

function emptyResources(): ResolvedResources {
  return { skills: [], guidance: [], subagents: [], plugins: [], runtimeResources: [] };
}

function makePluginQR(id: string, path: string, sourcePath = "/specs/test-agent"): QualifiedResource {
  return {
    effectiveId: id,
    sourceSpec: "test-agent",
    sourcePath,
    resource: { id, source: { kind: "local", path } } as QualifiedResource["resource"],
  };
}

function makeConfig(plugins: QualifiedResource[]): ResolvedNodeConfig {
  return {
    runtime: "claude-code",
    model: undefined,
    cwd: "/runtime/agent-cwd",
    restorePolicy: "resume_if_possible",
    lifecycle: undefined,
    selectedResources: { ...emptyResources(), plugins },
    startup: { files: [], actions: [] },
    resolvedSpecName: "test-agent",
    resolvedSpecVersion: "1.0",
    resolvedSpecHash: "deadbeef",
  };
}

function mockFs(): ProjectionFsOps {
  return {
    readFile: () => { throw new Error("not used"); },
    exists: () => false,
  };
}

describe("Projection planner——plugin path 语义", () => {
  // ============================================================
  // absolute path——精确保留
  // ============================================================

  it("absolute plugin source.path 产生相同绝对路径的 entry.absolutePath", () => {
    const config = makeConfig([makePluginQR("openrig-core", "/Users/op/.openrig/plugins/openrig-core")]);
    const input: ProjectionInput = { config, collisions: [], fsOps: mockFs() };
    const result = planProjection(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const pluginEntry = result.plan.entries.find((e) => e.category === "plugin");
      expect(pluginEntry).toBeDefined();
      expect(pluginEntry!.absolutePath).toBe("/Users/op/.openrig/plugins/openrig-core");
      expect(pluginEntry!.resourcePath).toBe("/Users/op/.openrig/plugins/openrig-core");
    }
  });

  it("absolute path 不会相对 spec sourcePath 再次解析", () => {
    const config = makeConfig([makePluginQR("p", "/abs/plugin", "/some/other/spec/dir")]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const entry = result.plan.entries[0]!;
      expect(entry.absolutePath).toBe("/abs/plugin");
      // 明确不应为 /some/other/spec/dir/abs/plugin
      expect(entry.absolutePath).not.toMatch(/^\/some\/other\/spec\/dir/);
    }
  });

  // ============================================================
  // tilde-home-prefixed path——展开到 $HOME
  // ============================================================

  it("带 tilde prefix 的 plugin source.path 展开为 $HOME 绝对路径", () => {
    const config = makeConfig([makePluginQR("openrig-core", "~/.openrig/plugins/openrig-core")]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const entry = result.plan.entries[0]!;
      const expectedAbs = nodePath.join(os.homedir(), ".openrig/plugins/openrig-core");
      expect(entry.absolutePath).toBe(expectedAbs);
      expect(entry.absolutePath).not.toMatch(/^~/);
    }
  });

  it("裸 tilde plugin source.path 精确展开到 $HOME", () => {
    const config = makeConfig([makePluginQR("home-plugin", "~")]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0]!.absolutePath).toBe(os.homedir());
    }
  });

  it("带用户名的 tilde（~user/...）原样保留（不展开——用户路径）", () => {
    // 按 Node nodePath 行为：只有 ~/（带 slash）会展开，~user/ 不会。遵循同一约定，
    // 避免隐式 lookup 给用户造成意外。
    const config = makeConfig([makePluginQR("p", "~bob/plugins/p")]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // ~bob 视为 relative path component → 与 sourcePath 拼接
      const entry = result.plan.entries[0]!;
      expect(entry.absolutePath).toContain("~bob");
    }
  });

  // ============================================================
  // relative path——相对 spec sourcePath 解析
  // ============================================================

  it("relative plugin source.path 相对 qr.sourcePath 解析", () => {
    const config = makeConfig([makePluginQR("local-plugin", "plugins/local-plugin", "/specs/my-agent")]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0]!.absolutePath).toBe("/specs/my-agent/plugins/local-plugin");
    }
  });

  it("以 ./ 开头的 relative plugin source.path 可正确解析", () => {
    const config = makeConfig([makePluginQR("local", "./plugins/local", "/specs/my-agent")]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0]!.absolutePath).toBe("/specs/my-agent/plugins/local");
    }
  });

  // ============================================================
  // drift discriminator——每层使用不同值（遵循已沉淀的
  // feedback_poc_regression_must_discriminate）
  // ============================================================

  it("三个不同 path shape 的 plugin 产生不同 absolutePath（drift discriminator）", () => {
    const config = makeConfig([
      makePluginQR("abs-plugin", "/abs/plugins/abs-plugin", "/specs/agent-X"),
      makePluginQR("home-plugin", "~/.openrig/plugins/home-plugin", "/specs/agent-X"),
      makePluginQR("rel-plugin", "plugins/rel-plugin", "/specs/agent-X"),
    ]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const byId = new Map(result.plan.entries.map((e) => [e.effectiveId, e.absolutePath]));
      expect(byId.get("abs-plugin")).toBe("/abs/plugins/abs-plugin");
      expect(byId.get("home-plugin")).toBe(nodePath.join(os.homedir(), ".openrig/plugins/home-plugin"));
      expect(byId.get("rel-plugin")).toBe("/specs/agent-X/plugins/rel-plugin");
      // 三者互不相同
      expect(new Set(Array.from(byId.values())).size).toBe(3);
    }
  });

  // ============================================================
  // planner 保留 plugin entry shape
  // ============================================================

  it("plugin entry 经过 planner 后保留 category 'plugin' 与 effectiveId", () => {
    const config = makeConfig([makePluginQR("openrig-core", "/p/openrig-core")]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const entry = result.plan.entries.find((e) => e.category === "plugin");
      expect(entry).toBeDefined();
      expect(entry!.effectiveId).toBe("openrig-core");
      expect(entry!.sourceSpec).toBe("test-agent");
    }
  });

  it("entry 确定性排序：plugin（p）排在 skill（s）前", () => {
    const config: ResolvedNodeConfig = {
      ...makeConfig([makePluginQR("z-plugin", "/p/z")]),
      selectedResources: {
        ...emptyResources(),
        skills: [{
          effectiveId: "a-skill",
          sourceSpec: "test-agent",
          sourcePath: "/specs/test-agent",
          resource: { id: "a-skill", path: "skills/a" } as QualifiedResource["resource"],
        }],
        plugins: [makePluginQR("z-plugin", "/p/z")],
      },
    };
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 按字母顺序 p < s；plugin entry 在前
      expect(result.plan.entries[0]!.category).toBe("plugin");
      expect(result.plan.entries[1]!.category).toBe("skill");
    }
  });
});
