import { describe, it, expect } from "vitest";
import { resolveAgentRef, type AgentResolverFsOps } from "../src/domain/agent-resolver.js";

/** helper：创建最小有效 agent.yaml。 */
function validAgentYaml(overrides?: { name?: string; version?: string; imports?: string; resources?: string }): string {
  const name = overrides?.name ?? "test-agent";
  const version = overrides?.version ?? "1.0.0";
  const imports = overrides?.imports ?? "";
  const resources = overrides?.resources ?? "resources:\n  skills: []\n  guidance: []\n  subagents: []\n  plugins: []\n  runtime_resources: []";
  return `name: ${name}\nversion: "${version}"\n${imports}\n${resources}\nprofiles: {}`;
}

function validAgentYamlWithSkill(name: string, skillId: string): string {
  return `name: ${name}\nversion: "1.0.0"\nresources:\n  skills:\n    - id: ${skillId}\n      path: skills/${skillId}\nprofiles: {}`;
}

/** mock filesystem。 */
function mockFs(files: Record<string, string>): AgentResolverFsOps {
  return {
    readFile: (path: string) => {
      if (path in files) return files[path]!;
      throw new Error(`File not found: ${path}`);
    },
    exists: (path: string) => path in files,
  };
}

const RIG_ROOT = "/project/rigs/my-rig";

describe("AgentSpec source resolver + import resolver", () => {
  // T1：local: ref 相对于 rig root 解析
  it("local: ref 相对于工作组 root 解析", () => {
    const fs = mockFs({
      "/project/rigs/my-rig/agents/impl/agent.yaml": validAgentYaml(),
    });
    const result = resolveAgentRef("local:agents/impl", RIG_ROOT, fs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.spec.name).toBe("test-agent");
      expect(result.resolved.sourcePath).toBe("/project/rigs/my-rig/agents/impl");
    }
  });

  // T2：path: ref 解析为绝对路径
  it("path: ref 解析为绝对路径", () => {
    const fs = mockFs({
      "/abs/agents/impl/agent.yaml": validAgentYaml({ name: "abs-agent" }),
    });
    const result = resolveAgentRef("path:/abs/agents/impl", RIG_ROOT, fs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved.spec.name).toBe("abs-agent");
      expect(result.resolved.sourcePath).toBe("/abs/agents/impl");
    }
  });

  // T3：缺失 agent.yaml 以 code not_found 失败
  it("缺失 agent.yaml 时以 not_found 失败", () => {
    const fs = mockFs({});
    const result = resolveAgentRef("local:agents/missing", RIG_ROOT, fs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("not_found");
      expect(result.error).toContain("agent.yaml");
    }
  });

  // T4：无效 AgentSpec 以 validation_failed 失败
  it("无效 AgentSpec 以 validation error 失败", () => {
    const fs = mockFs({
      "/project/rigs/my-rig/agents/bad/agent.yaml": "summary: no name or version",
    });
    const result = resolveAgentRef("local:agents/bad", RIG_ROOT, fs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("validation_failed");
      expect((result as { errors: string[] }).errors.length).toBeGreaterThan(0);
    }
  });

  // T5：精确 version 匹配通过
  it("精确 version 匹配时通过", () => {
    const fs = mockFs({
      "/project/rigs/my-rig/agents/impl/agent.yaml": validAgentYaml({
        imports: 'imports:\n  - ref: local:../lib\n    version: "1.0.0"',
      }),
      "/project/rigs/my-rig/agents/lib/agent.yaml": validAgentYaml({ name: "lib", version: "1.0.0" }),
    });
    const result = resolveAgentRef("local:agents/impl", RIG_ROOT, fs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.imports).toHaveLength(1);
      expect(result.imports[0]!.spec.version).toBe("1.0.0");
    }
  });

  // T6：精确 version 不匹配时失败
  it("精确 version 不匹配时失败", () => {
    const fs = mockFs({
      "/project/rigs/my-rig/agents/impl/agent.yaml": validAgentYaml({
        imports: 'imports:\n  - ref: local:../lib\n    version: "2.0.0"',
      }),
      "/project/rigs/my-rig/agents/lib/agent.yaml": validAgentYaml({ name: "lib", version: "1.0.0" }),
    });
    const result = resolveAgentRef("local:agents/impl", RIG_ROOT, fs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("version_mismatch");
      expect(result.error).toContain("2.0.0");
      expect(result.error).toContain("1.0.0");
    }
  });

  // T7：remote import source 明确失败
  it("remote import source 在 resolve 时失败", () => {
    // Remote source 会被 AS-T01 validation 拒绝，resolver 也会拒绝
    const fs = mockFs({
      "/project/rigs/my-rig/agents/impl/agent.yaml":
        'name: impl\nversion: "1.0.0"\nimports:\n  - ref: "github:foo/bar"\nprofiles: {}',
    });
    const result = resolveAgentRef("local:agents/impl", RIG_ROOT, fs);
    // validator 在 parse 时拒绝 github:，因此这里应在 validation 阶段失败
    expect(result.ok).toBe(false);
  });

  // T8：base/import collision 生成 diagnostic
  it("base/import collision 生成 diagnostic", () => {
    const fs = mockFs({
      "/project/rigs/my-rig/agents/impl/agent.yaml": validAgentYaml({
        name: "impl",
        imports: "imports:\n  - ref: local:../lib",
        resources: "resources:\n  skills:\n    - id: shared-skill\n      path: skills/shared",
      }),
      "/project/rigs/my-rig/agents/lib/agent.yaml": validAgentYamlWithSkill("lib", "shared-skill"),
    });
    const result = resolveAgentRef("local:agents/impl", RIG_ROOT, fs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.collisions.length).toBeGreaterThan(0);
      const collision = result.collisions.find((c) => c.resourceId === "shared-skill");
      expect(collision).toBeDefined();
      expect(collision!.sources).toHaveLength(2);
    }
  });

  // T9：imported resource 可通过 qualified id 寻址
  it("collision diagnostic 包含 qualified id", () => {
    const fs = mockFs({
      "/project/rigs/my-rig/agents/impl/agent.yaml": validAgentYaml({
        name: "impl",
        imports: "imports:\n  - ref: local:../lib",
        resources: "resources:\n  skills:\n    - id: foo\n      path: skills/foo",
      }),
      "/project/rigs/my-rig/agents/lib/agent.yaml": validAgentYamlWithSkill("lib", "foo"),
    });
    const result = resolveAgentRef("local:agents/impl", RIG_ROOT, fs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const collision = result.collisions.find((c) => c.resourceId === "foo");
      expect(collision).toBeDefined();
      const libSource = collision!.sources.find((s) => s.specName === "lib");
      expect(libSource!.qualifiedId).toBe("lib:foo");
    }
  });

  // T10：拒绝 self-import
  it("拒绝 self-import（cycle）", () => {
    const fs = mockFs({
      "/project/rigs/my-rig/agents/impl/agent.yaml": validAgentYaml({
        name: "impl",
        imports: "imports:\n  - ref: local:.",
      }),
    });
    const result = resolveAgentRef("local:agents/impl", RIG_ROOT, fs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("cycle_detected");
    }
  });

  // T11：resolved spec hash 具有确定性
  it("resolved spec hash 具有确定性", () => {
    const yaml = validAgentYaml({ name: "stable" });
    const fs = mockFs({
      "/project/rigs/my-rig/agents/stable/agent.yaml": yaml,
    });
    const r1 = resolveAgentRef("local:agents/stable", RIG_ROOT, fs);
    const r2 = resolveAgentRef("local:agents/stable", RIG_ROOT, fs);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.resolved.hash).toBe(r2.resolved.hash);
      expect(r1.resolved.hash.length).toBe(64); // SHA-256 hex
    }
  });

  // T12：带非空 imports 的 imported spec -> 拒绝
  it("拒绝带 nested import 的 imported spec", () => {
    const fs = mockFs({
      "/project/rigs/my-rig/agents/impl/agent.yaml": validAgentYaml({
        name: "impl",
        imports: "imports:\n  - ref: local:../lib",
      }),
      "/project/rigs/my-rig/agents/lib/agent.yaml": validAgentYaml({
        name: "lib",
        imports: "imports:\n  - ref: local:agents/nested",
      }),
      "/project/rigs/my-rig/agents/nested/agent.yaml": validAgentYaml({ name: "nested" }),
    });
    const result = resolveAgentRef("local:agents/impl", RIG_ROOT, fs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("import_error");
      expect(result.error).toContain("嵌套导入");
      expect(result.error).toContain("v1 不支持");
    }
  });

  // T13：import/import collision -> 带两个 source 的 ResourceCollision
  it("import/import collision 生成包含两个 qualified id 的 diagnostic", () => {
    const fs = mockFs({
      "/project/rigs/my-rig/agents/impl/agent.yaml": validAgentYaml({
        name: "impl",
        imports: "imports:\n  - ref: local:../lib-a\n  - ref: local:../lib-b",
      }),
      "/project/rigs/my-rig/agents/lib-a/agent.yaml": validAgentYamlWithSkill("lib-a", "shared"),
      "/project/rigs/my-rig/agents/lib-b/agent.yaml": validAgentYamlWithSkill("lib-b", "shared"),
    });
    const result = resolveAgentRef("local:agents/impl", RIG_ROOT, fs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const collision = result.collisions.find((c) => c.resourceId === "shared");
      expect(collision).toBeDefined();
      expect(collision!.sources).toHaveLength(2);
      expect(collision!.sources.map((s) => s.qualifiedId).sort()).toEqual(["lib-a:shared", "lib-b:shared"]);
    }
  });

  // T14：两个 import 解析为相同 spec name -> 拒绝
  it("拒绝 spec name 相同的两个 import", () => {
    const fs = mockFs({
      "/project/rigs/my-rig/agents/impl/agent.yaml": validAgentYaml({
        name: "impl",
        imports: "imports:\n  - ref: local:../lib-v1\n  - ref: local:../lib-v2",
      }),
      "/project/rigs/my-rig/agents/lib-v1/agent.yaml": validAgentYaml({ name: "lib" }),
      "/project/rigs/my-rig/agents/lib-v2/agent.yaml": validAgentYaml({ name: "lib" }),
    });
    const result = resolveAgentRef("local:agents/impl", RIG_ROOT, fs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("import_error");
      expect(result.error).toContain("导入名称重复");
      expect(result.error).toContain("lib");
    }
  });

  // T15：imported spec name 含 colon -> 拒绝
  it("拒绝名称含 colon 的 imported spec", () => {
    const fs = mockFs({
      "/project/rigs/my-rig/agents/impl/agent.yaml": validAgentYaml({
        name: "impl",
        imports: "imports:\n  - ref: local:../lib",
      }),
      "/project/rigs/my-rig/agents/lib/agent.yaml": validAgentYaml({ name: "has:colon" }),
    });
    const result = resolveAgentRef("local:agents/impl", RIG_ROOT, fs);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("import_error");
      expect(result.error).toContain("冒号");
      expect(result.error).toContain("限定引用语法");
    }
  });
});
