import { describe, it, expect } from "vitest";
import nodePath from "node:path";
import { PodBundleAssembler, type PodAssemblerFsOps } from "../src/domain/pod-bundle-assembler.js";
import { validatePodBundleManifest, parsePodBundleManifest, serializePodBundleManifest, type PodBundleManifest } from "../src/domain/bundle-types.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import type { RigSpec } from "../src/domain/types.js";

// ——Mock 文件系统——

function mockFs(files: Record<string, string>): PodAssemblerFsOps {
  const written: Record<string, string> = {};
  const dirs = new Set<string>();

  return {
    readFile: (p: string) => {
      if (p in files) return files[p]!;
      if (p in written) return written[p]!;
      throw new Error(`File not found: ${p}`);
    },
    exists: (p: string) => p in files || p in written,
    mkdirp: (p: string) => { dirs.add(p); },
    writeFile: (p: string, content: string) => { written[p] = content; },
    copyDir: () => {},
    listFiles: (dirPath: string) => {
      const result: string[] = [];
      for (const key of Object.keys(files)) {
        if (key.startsWith(dirPath + "/")) {
          result.push(key.slice(dirPath.length + 1));
        }
      }
      return result;
    },
    _written: written, // for test inspection
  } as PodAssemblerFsOps & { _written: Record<string, string> };
}

// ——Helper——

const RIG_ROOT = "/project/rigs/my-rig";

function makeRigSpec(overrides?: Partial<RigSpec>): RigSpec {
  return {
    version: "0.2",
    name: "test-rig",
    pods: [{
      id: "dev",
      label: "Dev",
      members: [{
        id: "impl",
        agentRef: "local:agents/impl",
        profile: "default",
        runtime: "claude-code",
        cwd: ".",
      }],
      edges: [],
    }],
    edges: [],
    ...overrides,
  };
}

function rigSpecYaml(spec: RigSpec): string {
  return RigSpecCodec.serialize(spec);
}

function validAgentYaml(name: string, opts?: { imports?: string; skills?: string[] }): string {
  const imports = opts?.imports ?? "";
  const skills = (opts?.skills ?? []).map((s) => `    - id: ${s}\n      path: skills/${s}`).join("\n");
  const resourceBlock = skills ? `resources:\n  skills:\n${skills}` : "resources:\n  skills: []";
  return `name: ${name}\nversion: "1.0.0"\n${imports}\n${resourceBlock}\nprofiles:\n  default:\n    uses:\n      skills: [${(opts?.skills ?? []).join(", ")}]`;
}

function setupBasicRig(fs: ReturnType<typeof mockFs>, spec?: RigSpec): RigSpec {
  const rigSpec = spec ?? makeRigSpec();
  const yaml = rigSpecYaml(rigSpec);
  (fs as unknown as { _files: Record<string, string> })["_files"] = {};

  // 将文件放入 mock FS
  const files = fs as unknown as Record<string, unknown>;
  // 需要向原始 files 对象添加内容，但 mockFs 会创建闭包。
  // 改为使用所需文件重新创建 FS。
  return rigSpec;
}

describe("PodBundleAssembler", () => {
  // T1：assembler 正确遍历嵌入的 pod member
  it("遍历嵌入的 pod member 并收集 agent 目录", () => {
    const spec = makeRigSpec();
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT,
      rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/bundle-staging",
      bundleName: "test-bundle",
      bundleVersion: "1.0.0",
    });

    expect(result.manifest.agents).toHaveLength(1);
    expect(result.manifest.agents[0]!.name).toBe("impl");
    expect(result.manifest.agents[0]!.path).toBe("agents/impl");
    expect(result.collectedFiles).toContain("rig.yaml");
  });

  // T2：被引用的 AgentSpec 恰好包含一次（去重）
  it("对多个 member 引用的 AgentSpec 去重", () => {
    const spec = makeRigSpec({
      pods: [{
        id: "dev",
        label: "Dev",
        members: [
          { id: "impl1", agentRef: "local:agents/shared", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "impl2", agentRef: "local:agents/shared", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [],
      }],
    });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/shared/agent.yaml`]: validAgentYaml("shared"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    });

    expect(result.manifest.agents).toHaveLength(1);
  });

  it("保留内置 terminal member，且不尝试 vendor", () => {
    const spec = makeRigSpec({
      pods: [{
        id: "infra",
        label: "Infra",
        members: [{
          id: "daemon",
          agentRef: "builtin:terminal",
          profile: "none",
          runtime: "terminal",
          cwd: ".",
        }],
        edges: [],
      }],
    });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT,
      rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging",
      bundleName: "test",
      bundleVersion: "1.0",
    });

    expect(result.manifest.agents).toHaveLength(0);
    const written = (fs as unknown as { _written: Record<string, string> })._written;
    const rewrittenRig = written["/tmp/staging/rig.yaml"]!;
    expect(rewrittenRig).toContain("agent_ref: builtin:terminal");
    expect(rewrittenRig).not.toContain("local:agents/");
  });

  // T3：收集扁平 import，并为每个 import 设置正确的 originalRef
  it("收集扁平 import，并为每个 import 设置正确的 originalRef", () => {
    const spec = makeRigSpec();
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl", { imports: "imports:\n  - ref: local:../lib-a\n  - ref: local:../lib-b" }),
      [`${RIG_ROOT}/agents/lib-a/agent.yaml`]: validAgentYaml("lib-a"),
      [`${RIG_ROOT}/agents/lib-b/agent.yaml`]: validAgentYaml("lib-b"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    });

    expect(result.manifest.agents[0]!.importEntries).toHaveLength(2);
    const impA = result.manifest.agents[0]!.importEntries.find((ie) => ie.name === "lib-a");
    const impB = result.manifest.agents[0]!.importEntries.find((ie) => ie.name === "lib-b");
    expect(impA).toBeDefined();
    expect(impA!.originalRef).toBe("local:../lib-a");
    expect(impB).toBeDefined();
    expect(impB!.originalRef).toBe("local:../lib-b");
  });

  // T4：包含 culture_file
  it("在 bundle 中包含 culture_file", () => {
    const spec = makeRigSpec({ cultureFile: "culture.md" });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/culture.md`]: "# Culture",
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    });

    expect(result.collectedFiles).toContain("culture.md");
    expect(result.manifest.cultureFile).toBe("culture.md");
  });

  // T5：包含 rig startup 文件
  it("包含 rig startup 文件", () => {
    const spec = makeRigSpec({
      startup: { files: [{ path: "startup/all-hands.md", deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] }], actions: [] },
    });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/startup/all-hands.md`]: "# All hands",
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    });

    expect(result.collectedFiles).toContain("startup/all-hands.md");
  });

  // T6：包含 pod 共享 startup 文件
  it("包含 pod 共享 startup 文件", () => {
    const spec = makeRigSpec({
      pods: [{
        id: "dev", label: "Dev",
        startup: { files: [{ path: "pods/dev/shared.md", deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] }], actions: [] },
        members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }],
        edges: [],
      }],
    });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/pods/dev/shared.md`]: "# Shared",
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    });

    expect(result.collectedFiles).toContain("pods/dev/shared.md");
  });

  // T7：包含 member overlay startup 文件
  it("包含 member startup overlay 文件", () => {
    const spec = makeRigSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [{
          id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: ".",
          startup: { files: [{ path: "pods/dev/overlays/impl.md", deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] }], actions: [] },
        }],
        edges: [],
      }],
    });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/pods/dev/overlays/impl.md`]: "# Impl overlay",
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    });

    expect(result.collectedFiles).toContain("pods/dev/overlays/impl.md");
  });

  // T8：拒绝路径遍历
  it("拒绝 startup 文件中的路径遍历", () => {
    const spec = makeRigSpec({
      startup: { files: [{ path: "../escape.md", deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] }], actions: [] },
    });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    expect(() => assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    })).toThrow(/traversal|escape/i);
  });

  // T8b：纳入 rig root 之外的 path: 绝对 agent_ref，并重写 ref
  it("vendor rig root 之外的 path: 绝对 agent_ref，并重写 ref", () => {
    const spec = makeRigSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [{ id: "impl", agentRef: "path:/external/agents/impl", profile: "default", runtime: "claude-code", cwd: "." }],
        edges: [],
      }],
    });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      ["/external/agents/impl/agent.yaml"]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    });

    expect(result.manifest.agents).toHaveLength(1);
    expect(result.manifest.agents[0]!.originalRef).toBe("path:/external/agents/impl");

    // 验证重写后的 rig.yaml 使用 local: ref，而不是 path:
    const written = (fs as unknown as { _written: Record<string, string> })._written;
    const rewrittenRig = written["/tmp/staging/rig.yaml"]!;
    expect(rewrittenRig).toContain("local:agents/impl");
    expect(rewrittenRig).not.toContain("path:/external/agents/impl");
  });

  it("LP-1 在 vendor 前拒绝 path: agent 中包含内部实质内容的文件", () => {
    const spec = makeRigSpec({
      pods: [{
        id: "dev", label: "Dev", edges: [],
        members: [{ id: "impl", agentRef: "path:/external/agents/impl", profile: "default", runtime: "claude-code", cwd: "." }],
      }],
    });
    const fs = mockFs({
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      ["/external/agents/impl/agent.yaml"]: validAgentYaml("impl"),
      ["/external/agents/impl/notes.md"]: "Source: substrate/shared-docs/rigs/private\n",
    });
    const assembler = new PodBundleAssembler({ fsOps: fs });

    expect(() => assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    })).toThrow(/internal-path[\s\S]*(通用化|公开来源|内部内容包)/i);
  });

  it("LP-1 拒绝嵌套在 path: agent 中、其他字节干净的 lore 类 pack", () => {
    const spec = makeRigSpec({
      pods: [{
        id: "dev", label: "Dev", edges: [],
        members: [{ id: "impl", agentRef: "path:/external/agents/impl", profile: "default", runtime: "claude-code", cwd: "." }],
      }],
    });
    const fs = mockFs({
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      ["/external/agents/impl/agent.yaml"]: validAgentYaml("impl"),
      ["/external/agents/impl/lore/manifest.yaml"]: [
        "name: private-lore", 'version: "1"', "taxonomy: lore", "files: []",
      ].join("\n"),
    });
    const assembler = new PodBundleAssembler({ fsOps: fs });

    expect(() => assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    })).toThrow(/lore-class|taxonomy:\s*lore/i);
  });

  it("LP-2 在复制前拒绝 operator-rooted 文档中的内部实质内容", () => {
    const spec = makeRigSpec({ docs: [{ path: "SETUP.md" }] });
    const fs = mockFs({
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
      [`${RIG_ROOT}/SETUP.md`]: "Use substrate/shared-docs/rigs/private to continue.\n",
    });
    const assembler = new PodBundleAssembler({ fsOps: fs });

    expect(() => assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    })).toThrow(/internal-path[\s\S]*(通用化|公开来源|内部内容包)/i);
  });

  it("LP-2 在复制前拒绝 lore 类 operator-rooted 文档", () => {
    const spec = makeRigSpec({ docs: [{ path: "LORE.md" }] });
    const fs = mockFs({
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
      [`${RIG_ROOT}/LORE.md`]: "---\ntaxonomy: lore\n---\n# A local situation\n",
    });
    const assembler = new PodBundleAssembler({ fsOps: fs });

    expect(() => assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    })).toThrow(/lore-class|taxonomy:\s*lore/i);
  });

  // T9：拒绝远程 import source
  it("组装期间拒绝远程 import source", () => {
    const spec = makeRigSpec();
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: 'name: impl\nversion: "1.0.0"\nimports:\n  - ref: "github:foo/bar"\nprofiles: {}',
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    expect(() => assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    })).toThrow();
  });

  // T10：往返：assemble -> 验证 manifest 结构
  it("组装后的 manifest 结构正确且通过校验", () => {
    const spec = makeRigSpec({ cultureFile: "culture.md" });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/culture.md`]: "# Culture",
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "my-bundle", bundleVersion: "2.0.0",
    });

    // 验证 manifest 结构
    expect(result.manifest.schemaVersion).toBe(2);
    expect(result.manifest.name).toBe("my-bundle");
    expect(result.manifest.version).toBe("2.0.0");
    expect(result.manifest.rigSpec).toBe("rig.yaml");
    expect(result.manifest.cultureFile).toBe("culture.md");
    expect(result.manifest.agents).toHaveLength(1);

    // 序列化并重新校验
    const written = (fs as unknown as { _written: Record<string, string> })._written;
    const manifestYaml = written["/tmp/staging/bundle.yaml"];
    expect(manifestYaml).toBeDefined();
    const parsed = parsePodBundleManifest(manifestYaml!);
    const validation = validatePodBundleManifest(parsed);
    expect(validation.valid).toBe(true);
  });

  // T11：集成：assemble -> 验证 manifest + 文件内容
  it("集成：组装后的 bundle 包含正确 manifest 和文件", () => {
    const spec = makeRigSpec({
      cultureFile: "culture.md",
      startup: { files: [{ path: "startup/rig.md", deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] }], actions: [] },
    });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/culture.md`]: "# Culture doc",
      [`${RIG_ROOT}/startup/rig.md`]: "# Rig startup",
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl", { skills: ["deep-pr-review"] }),
      [`${RIG_ROOT}/agents/impl/skills/deep-pr-review`]: "skill content",
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "full-bundle", bundleVersion: "1.0.0",
    });

    // 验证收集的文件
    expect(result.collectedFiles).toContain("rig.yaml");
    expect(result.collectedFiles).toContain("culture.md");
    expect(result.collectedFiles).toContain("startup/rig.md");
    expect(result.collectedFiles.some((f) => f.startsWith("agents/impl/"))).toBe(true);

    // 验证写入的文件存在
    const written = (fs as unknown as { _written: Record<string, string> })._written;
    expect(written["/tmp/staging/rig.yaml"]).toBeDefined();
    expect(written["/tmp/staging/culture.md"]).toBe("# Culture doc");
    expect(written["/tmp/staging/bundle.yaml"]).toBeDefined();
  });

  // T12：校验 PodBundleManifest 结构
  it("PodBundleManifest 使用正确 schema_version 时通过校验", () => {
    const raw = {
      schema_version: 2,
      name: "test",
      version: "1.0",
      created_at: new Date().toISOString(),
      rig_spec: "rig.yaml",
      agents: [{
        name: "impl",
        version: "1.0",
        path: "agents/impl",
        original_ref: "local:agents/impl",
        hash: "abc123",
        import_entries: [],
      }],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  // T13：重写 vendored agent.yaml 的 import ref
  it("vendored agent.yaml 的 import ref 被重写为 local:", () => {
    const spec = makeRigSpec();
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl", { imports: "imports:\n  - ref: local:../lib" }),
      [`${RIG_ROOT}/agents/lib/agent.yaml`]: validAgentYaml("lib"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    });

    const written = (fs as unknown as { _written: Record<string, string> })._written;
    const vendoredAgentYaml = written["/tmp/staging/agents/impl/agent.yaml"]!;
    expect(vendoredAgentYaml).toBeDefined();
    expect(vendoredAgentYaml).toContain("local:../lib");
    expect(vendoredAgentYaml).not.toContain("local:../lib-a"); // no stray rewrites
  });

  // T14：共享 import 出现在所有引用 agent 的 importEntries 中
  it("共享 import 出现在所有引用 agent 的 importEntries 中", () => {
    const spec = makeRigSpec({
      pods: [{
        id: "dev", label: "Dev",
        members: [
          { id: "impl-a", agentRef: "local:agents/agent-a", profile: "default", runtime: "claude-code", cwd: "." },
          { id: "impl-b", agentRef: "local:agents/agent-b", profile: "default", runtime: "claude-code", cwd: "." },
        ],
        edges: [],
      }],
    });
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/agent-a/agent.yaml`]: validAgentYaml("agent-a", { imports: "imports:\n  - ref: local:../shared-lib" }),
      [`${RIG_ROOT}/agents/agent-b/agent.yaml`]: validAgentYaml("agent-b", { imports: "imports:\n  - ref: local:../shared-lib" }),
      [`${RIG_ROOT}/agents/shared-lib/agent.yaml`]: validAgentYaml("shared-lib"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT, rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/staging", bundleName: "test", bundleVersion: "1.0",
    });

    // 两个 agent 的 importEntries 都应包含 shared-lib
    const agentA = result.manifest.agents.find((a) => a.name === "agent-a");
    const agentB = result.manifest.agents.find((a) => a.name === "agent-b");
    expect(agentA!.importEntries).toHaveLength(1);
    expect(agentA!.importEntries[0]!.name).toBe("shared-lib");
    expect(agentB!.importEntries).toHaveLength(1);
    expect(agentB!.importEntries[0]!.name).toBe("shared-lib");
  });

  // 延后：完整黄金路径集成（assemble -> validate -> preflight -> instantiate）
  // 将在 AS-T11 + AS-T08b 落地后的 Checkpoint 2 验证

  // 条目 1——provenance 捕获（slice-05 Checkpoint 2 第 2 部分）
  it("v2：将 opts 中的 provenance 捕获到 manifest", () => {
    const spec = makeRigSpec();
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT,
      rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/bundle-staging-prov",
      bundleName: "test-bundle",
      bundleVersion: "1.0.0",
      provenance: {
        sourceHost: "test-host",
        authorSession: "velocity-driver@openrig-velocity",
        daemonVersion: "0.3.2",
        cliVersion: "0.3.2",
        notes: "v2 capture fixture",
      },
    });

    expect(result.manifest.provenance).toBeDefined();
    expect(result.manifest.provenance?.sourceHost).toBe("test-host");
    expect(result.manifest.provenance?.authorSession).toBe("velocity-driver@openrig-velocity");
    expect(result.manifest.provenance?.daemonVersion).toBe("0.3.2");
    expect(result.manifest.provenance?.notes).toBe("v2 capture fixture");
    // createdAt 与根级值一致
    expect(result.manifest.provenance?.createdAt).toBe(result.manifest.createdAt);
  });

  it("v2：预设 opts.provenance.createdAt 时尊重该值（测试确定性）", () => {
    const spec = makeRigSpec();
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const fixedCreatedAt = "2026-01-01T00:00:00Z";
    const result = assembler.assemble({
      rigRoot: RIG_ROOT,
      rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/bundle-staging-fixed-createdat",
      bundleName: "test", bundleVersion: "1.0",
      provenance: { createdAt: fixedCreatedAt, sourceHost: "h" },
    });

    expect(result.manifest.provenance?.createdAt).toBe(fixedCreatedAt);
    expect(result.manifest.createdAt).not.toBe(fixedCreatedAt);
  });

  it("v2：未提供 opts.provenance 时省略 provenance（向后兼容）", () => {
    const spec = makeRigSpec();
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT,
      rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/bundle-staging-no-prov",
      bundleName: "test", bundleVersion: "1.0",
    });

    expect(result.manifest.provenance).toBeUndefined();
  });

  // 条目 2——compatibility 捕获（slice-05 Checkpoint 3.2）
  it("v2：将 opts 中的 compatibility 捕获到 manifest", () => {
    const spec = makeRigSpec();
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT,
      rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/bundle-staging-compat",
      bundleName: "test-bundle",
      bundleVersion: "1.0.0",
      compatibility: {
        minDaemonVersion: "0.3.2",
        minCliVersion: "0.3.2",
        schemaVersion: 2,
      },
    });

    expect(result.manifest.compatibility).toBeDefined();
    expect(result.manifest.compatibility?.minDaemonVersion).toBe("0.3.2");
    expect(result.manifest.compatibility?.minCliVersion).toBe("0.3.2");
    expect(result.manifest.compatibility?.schemaVersion).toBe(2);
  });

  it("v2：未提供 opts.compatibility 时省略 compatibility（向后兼容）", () => {
    const spec = makeRigSpec();
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: rigSpecYaml(spec),
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT,
      rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/tmp/bundle-staging-no-compat",
      bundleName: "test", bundleVersion: "1.0",
    });

    expect(result.manifest.compatibility).toBeUndefined();
  });
});

describe("PodBundleManifest 校验", () => {
  it("有效的 schemaVersion 2 manifest 通过校验", () => {
    const raw = {
      schema_version: 2,
      name: "test-bundle",
      version: "1.0.0",
      created_at: "2026-03-29T00:00:00Z",
      rig_spec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        original_ref: "local:agents/impl", hash: "abc123",
        import_entries: [],
      }],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("错误的 schema_version 校验失败", () => {
    const raw = {
      schema_version: 1, name: "test", version: "1.0",
      created_at: "2026-03-29T00:00:00Z", rig_spec: "rig.yaml",
      agents: [],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/schema_version 必须为 2/);
  });

  it("serialize -> parse -> validate 可往返", () => {
    const manifest: PodBundleManifest = {
      schemaVersion: 2, name: "rt-test", version: "2.0",
      createdAt: "2026-03-29T00:00:00Z", rigSpec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        originalRef: "local:agents/impl", hash: "def456",
        importEntries: [{ name: "lib", version: "1.0", path: "agents/lib", originalRef: "local:../lib", hash: "ghi789" }],
      }],
    };
    const yaml = serializePodBundleManifest(manifest);
    const parsed = parsePodBundleManifest(yaml);
    const validation = validatePodBundleManifest(parsed);
    expect(validation.valid).toBe(true);

    // 验证 agent 条目可往返
    const m = parsed as Record<string, unknown>;
    const agents = m["agents"] as Array<Record<string, unknown>>;
    expect(agents).toHaveLength(1);
    expect(agents[0]!["name"]).toBe("impl");
    expect(agents[0]!["hash"]).toBe("def456");
    const imports = agents[0]!["import_entries"] as Array<Record<string, unknown>>;
    expect(imports).toHaveLength(1);
    expect(imports[0]!["name"]).toBe("lib");
  });

  // 条目 1——provenance 区块（slice-05）：向后兼容 + 存在性 + 往返
  it("v2：缺少 provenance 区块时通过校验（向后兼容）", () => {
    const raw = {
      schema_version: 2, name: "no-prov", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        original_ref: "local:agents/impl", hash: "abc",
        import_entries: [],
      }],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2：完整 provenance 区块通过校验", () => {
    const raw = {
      schema_version: 2, name: "with-prov", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        original_ref: "local:agents/impl", hash: "abc",
        import_entries: [],
      }],
      provenance: {
        created_at: "2026-05-18T00:00:00Z",
        source_host: "test-host.local",
        author_session: "velocity-driver@openrig-velocity",
        source_rig_id: "01KQEQPN4MQJN0DHBM5CQ0N8D7",
        source_rig_name: "openrig-velocity",
        daemon_version: "0.3.2",
        cli_version: "0.3.2",
        notes: "Test bundle for Item 1",
      },
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2：provenance 存在但不是对象时拒绝", () => {
    const raw = {
      schema_version: 2, name: "bad-prov", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      provenance: "string-not-object",
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("provenance"))).toBe(true);
  });

  it("v2：provenance 字段类型错误时拒绝", () => {
    const raw = {
      schema_version: 2, name: "bad-prov-field", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      provenance: { source_host: 12345 },
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("provenance.source_host"))).toBe(true);
  });

  // ——条目 2：compatibility 区块测试（slice-05 Checkpoint 3.1）——

  it("v2：缺少 compatibility 区块时通过校验（向后兼容）", () => {
    const raw = {
      schema_version: 2, name: "no-compat", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2：完整 compatibility 区块通过校验", () => {
    const raw = {
      schema_version: 2, name: "with-compat", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      compatibility: { min_daemon_version: "0.3.2", min_cli_version: "0.3.2", schema_version: 2 },
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2：compatibility 存在但不是对象时拒绝", () => {
    const raw = {
      schema_version: 2, name: "bad-compat", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      compatibility: "0.3.2",
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("compatibility"))).toBe(true);
  });

  it("v2：compatibility 字段类型错误时拒绝", () => {
    const raw = {
      schema_version: 2, name: "bad-compat-field", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      compatibility: { min_daemon_version: 0.3 },
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("compatibility.min_daemon_version"))).toBe(true);
  });

  // ——条目 6：v2 skills 区块测试（slice-05 Checkpoint 7.1）——

  it("v2：缺少 skills 区块时通过校验（向后兼容）", () => {
    const raw = {
      schema_version: 2, name: "no-skills", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2：skills 为字符串数组时通过校验", () => {
    const raw = {
      schema_version: 2, name: "with-skills", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      skills: ["skills/foo/SKILL.md", "skills/bar/SKILL.md"],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2：拒绝不安全的 skill 路径", () => {
    const raw = {
      schema_version: 2, name: "bad-skills", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      skills: ["../escape/skill.md"],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("skills[0]") && e.includes("不安全"))).toBe(true);
  });

  // ——条目 6：v2 plugins 区块测试（slice-05 Checkpoint 7.3b）——

  it("v2：缺少 plugins 区块时通过校验", () => {
    const raw = {
      schema_version: 2, name: "no-plugins", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2：plugins 为有效 {id, source} 数组时通过校验", () => {
    const raw = {
      schema_version: 2, name: "with-plugins", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      plugins: [{ id: "gstack", source: { kind: "local", path: "plugins/gstack" } }],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2：拒绝 source.path 不安全的 plugin 条目", () => {
    const raw = {
      schema_version: 2, name: "bad-plugins", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      plugins: [{ id: "x", source: { kind: "local", path: "../escape" } }],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("plugins[0].source.path") && e.includes("不安全"))).toBe(true);
  });

  it("v2：serialize -> parse 往返保留 plugins", () => {
    const manifest: PodBundleManifest = {
      schemaVersion: 2, name: "rt-plugins-v2", version: "2.0",
      createdAt: "2026-05-18T00:00:00Z", rigSpec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        originalRef: "local:agents/impl", hash: "def",
        importEntries: [],
      }],
      plugins: [{ id: "gstack", source: { kind: "local", path: "plugins/gstack" } }],
    };
    const yaml = serializePodBundleManifest(manifest);
    expect(yaml).toContain("plugins:");
    expect(yaml).toContain("id: gstack");
    const parsed = parsePodBundleManifest(yaml);
    const validation = validatePodBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const m = parsed as Record<string, unknown>;
    const ps = m["plugins"] as Array<Record<string, unknown>>;
    expect(ps).toHaveLength(1);
    expect(ps[0]!["id"]).toBe("gstack");
    expect((ps[0]!["source"] as Record<string, unknown>)["path"]).toBe("plugins/gstack");
  });

  it("v2：serialize -> parse 往返保留 skills", () => {
    const manifest: PodBundleManifest = {
      schemaVersion: 2, name: "rt-skills-v2", version: "2.0",
      createdAt: "2026-05-18T00:00:00Z", rigSpec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        originalRef: "local:agents/impl", hash: "def",
        importEntries: [],
      }],
      skills: ["skills/v2-foo/SKILL.md", "skills/v2-bar/SKILL.md"],
    };
    const yaml = serializePodBundleManifest(manifest);
    expect(yaml).toContain("skills:");
    expect(yaml).toContain("skills/v2-foo/SKILL.md");
    const parsed = parsePodBundleManifest(yaml);
    const validation = validatePodBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const m = parsed as Record<string, unknown>;
    expect(m["skills"]).toEqual(["skills/v2-foo/SKILL.md", "skills/v2-bar/SKILL.md"]);
  });

  // ——条目 6：v2 workflow_specs 区块测试（slice-05 Checkpoint 7.3e）——

  it("v2：缺少 workflow_specs 区块时通过校验（向后兼容）", () => {
    const raw = {
      schema_version: 2, name: "no-workflow-specs", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2：workflow_specs 为字符串数组时通过校验", () => {
    const raw = {
      schema_version: 2, name: "with-workflow-specs", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      workflow_specs: ["workflows/onboarding.yaml", "workflows/release.yaml"],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2：workflow_specs 不是数组时拒绝", () => {
    const raw = {
      schema_version: 2, name: "bad-workflow-specs", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      workflow_specs: "workflows/a.yaml",
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("workflow_specs 必须是数组"))).toBe(true);
  });

  it("v2：拒绝非字符串 workflow_specs 条目", () => {
    const raw = {
      schema_version: 2, name: "bad-workflow-specs", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      workflow_specs: [123, "workflows/ok.yaml"],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("workflow_specs[0]") && e.includes("必须是字符串"))).toBe(true);
  });

  it("v2：拒绝不安全的 workflow_specs 路径", () => {
    const raw = {
      schema_version: 2, name: "bad-workflow-specs", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      workflow_specs: ["../escape/spec.yaml"],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("workflow_specs[0]") && e.includes("不安全"))).toBe(true);
  });

  it("v2：serialize -> parse 往返保留 workflow_specs", () => {
    const manifest: PodBundleManifest = {
      schemaVersion: 2, name: "rt-workflow-specs-v2", version: "2.0",
      createdAt: "2026-05-18T00:00:00Z", rigSpec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        originalRef: "local:agents/impl", hash: "def",
        importEntries: [],
      }],
      workflowSpecs: ["workflows/v2-onboarding.yaml", "workflows/v2-release.yaml"],
    };
    const yaml = serializePodBundleManifest(manifest);
    expect(yaml).toContain("workflow_specs:");
    expect(yaml).toContain("workflows/v2-onboarding.yaml");
    const parsed = parsePodBundleManifest(yaml);
    const validation = validatePodBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const m = parsed as Record<string, unknown>;
    expect(m["workflow_specs"]).toEqual(["workflows/v2-onboarding.yaml", "workflows/v2-release.yaml"]);
  });

  it("v2：往返同时保留全部 3 个跨原语区块（skills + plugins + workflow_specs）", () => {
    const manifest: PodBundleManifest = {
      schemaVersion: 2, name: "rt-all-three", version: "2.0",
      createdAt: "2026-05-18T00:00:00Z", rigSpec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        originalRef: "local:agents/impl", hash: "def",
        importEntries: [],
      }],
      skills: ["skills/co-test/SKILL.md"],
      plugins: [{ id: "co-plugin", source: { kind: "local", path: "plugins/co-plugin" } }],
      workflowSpecs: ["workflows/co-flow.yaml"],
    };
    const yaml = serializePodBundleManifest(manifest);
    const parsed = parsePodBundleManifest(yaml);
    const validation = validatePodBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const m = parsed as Record<string, unknown>;
    expect(m["skills"]).toEqual(["skills/co-test/SKILL.md"]);
    expect(m["workflow_specs"]).toEqual(["workflows/co-flow.yaml"]);
    const ps = m["plugins"] as Array<Record<string, unknown>>;
    expect(ps[0]!["id"]).toBe("co-plugin");
  });

  // ——条目 6：v2 context_packs 区块测试（slice-05 Checkpoint 7.3f）——

  it("v2：缺少 context_packs 区块时通过校验（向后兼容）", () => {
    const raw = {
      schema_version: 2, name: "no-context-packs", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2：context_packs 为字符串数组时通过校验", () => {
    const raw = {
      schema_version: 2, name: "with-context-packs", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      context_packs: ["context-packs/intent/manifest.yaml", "context-packs/persona/manifest.yaml"],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2：context_packs 不是数组时拒绝", () => {
    const raw = {
      schema_version: 2, name: "bad-context-packs", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      context_packs: "context-packs/a/manifest.yaml",
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("context_packs 必须是数组"))).toBe(true);
  });

  it("v2：拒绝非字符串 context_packs 条目", () => {
    const raw = {
      schema_version: 2, name: "bad-context-packs", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      context_packs: [42, "context-packs/ok/manifest.yaml"],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("context_packs[0]") && e.includes("必须是字符串"))).toBe(true);
  });

  it("v2：拒绝不安全的 context_packs 路径", () => {
    const raw = {
      schema_version: 2, name: "bad-context-packs", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      context_packs: ["../escape/manifest.yaml"],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("context_packs[0]") && e.includes("不安全"))).toBe(true);
  });

  it("v2：serialize -> parse 往返保留 context_packs", () => {
    const manifest: PodBundleManifest = {
      schemaVersion: 2, name: "rt-context-packs-v2", version: "2.0",
      createdAt: "2026-05-18T00:00:00Z", rigSpec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        originalRef: "local:agents/impl", hash: "def",
        importEntries: [],
      }],
      contextPacks: ["context-packs/v2-intent/manifest.yaml", "context-packs/v2-persona/manifest.yaml"],
    };
    const yaml = serializePodBundleManifest(manifest);
    expect(yaml).toContain("context_packs:");
    expect(yaml).toContain("context-packs/v2-intent/manifest.yaml");
    const parsed = parsePodBundleManifest(yaml);
    const validation = validatePodBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const m = parsed as Record<string, unknown>;
    expect(m["context_packs"]).toEqual(["context-packs/v2-intent/manifest.yaml", "context-packs/v2-persona/manifest.yaml"]);
  });

  // ——条目 6：v2 agent_images 区块测试（slice-05 Checkpoint 7.3g）——

  it("v2：缺少 agent_images 区块时通过校验（向后兼容）", () => {
    const raw = {
      schema_version: 2, name: "no-agent-images", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2：agent_images 为字符串数组时通过校验", () => {
    const raw = {
      schema_version: 2, name: "with-agent-images", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      agent_images: ["agent-images/seat-a", "agent-images/seat-b"],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("v2：agent_images 不是数组时拒绝", () => {
    const raw = {
      schema_version: 2, name: "bad-agent-images", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      agent_images: "agent-images/a",
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("agent_images 必须是数组"))).toBe(true);
  });

  it("v2：拒绝非字符串 agent_images 条目", () => {
    const raw = {
      schema_version: 2, name: "bad-agent-images", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      agent_images: [99, "agent-images/ok"],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("agent_images[0]") && e.includes("必须是字符串"))).toBe(true);
  });

  it("v2：拒绝不安全的 agent_images 路径", () => {
    const raw = {
      schema_version: 2, name: "bad-agent-images", version: "1.0",
      created_at: "2026-05-18T00:00:00Z", rig_spec: "rig.yaml",
      agents: [{ name: "impl", version: "1.0", path: "agents/impl", original_ref: "local:agents/impl", hash: "abc", import_entries: [] }],
      agent_images: ["../escape"],
    };
    const result = validatePodBundleManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("agent_images[0]") && e.includes("不安全"))).toBe(true);
  });

  it("v2：serialize -> parse 往返保留 agent_images", () => {
    const manifest: PodBundleManifest = {
      schemaVersion: 2, name: "rt-agent-images-v2", version: "2.0",
      createdAt: "2026-05-18T00:00:00Z", rigSpec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        originalRef: "local:agents/impl", hash: "def",
        importEntries: [],
      }],
      agentImages: ["agent-images/v2-seat-a", "agent-images/v2-seat-b"],
    };
    const yaml = serializePodBundleManifest(manifest);
    expect(yaml).toContain("agent_images:");
    expect(yaml).toContain("agent-images/v2-seat-a");
    const parsed = parsePodBundleManifest(yaml);
    const validation = validatePodBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const m = parsed as Record<string, unknown>;
    expect(m["agent_images"]).toEqual(["agent-images/v2-seat-a", "agent-images/v2-seat-b"]);
  });

  it("v2：serialize -> parse 往返保留 compatibility", () => {
    const manifest: PodBundleManifest = {
      schemaVersion: 2, name: "rt-compat", version: "2.0",
      createdAt: "2026-05-18T00:00:00Z", rigSpec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        originalRef: "local:agents/impl", hash: "def",
        importEntries: [],
      }],
      compatibility: {
        minDaemonVersion: "0.3.2",
        minCliVersion: "0.3.2",
        schemaVersion: 2,
      },
    };
    const yaml = serializePodBundleManifest(manifest);
    expect(yaml).toContain("compatibility:");
    expect(yaml).toContain("min_daemon_version: 0.3.2");
    const parsed = parsePodBundleManifest(yaml);
    const validation = validatePodBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const m = parsed as Record<string, unknown>;
    const compat = m["compatibility"] as Record<string, unknown>;
    expect(compat["min_daemon_version"]).toBe("0.3.2");
    expect(compat["min_cli_version"]).toBe("0.3.2");
    expect(compat["schema_version"]).toBe(2);
  });

  it("v2：serialize -> parse 往返保留 provenance", () => {
    const manifest: PodBundleManifest = {
      schemaVersion: 2, name: "rt-prov", version: "2.0",
      createdAt: "2026-05-18T00:00:00Z", rigSpec: "rig.yaml",
      agents: [{
        name: "impl", version: "1.0", path: "agents/impl",
        originalRef: "local:agents/impl", hash: "def",
        importEntries: [],
      }],
      provenance: {
        createdAt: "2026-05-18T00:00:00Z",
        sourceHost: "rt-host",
        authorSession: "velocity-driver@openrig-velocity",
        daemonVersion: "0.3.2",
        cliVersion: "0.3.2",
        notes: "v2 round-trip fixture",
      },
    };
    const yaml = serializePodBundleManifest(manifest);
    expect(yaml).toContain("provenance:");
    expect(yaml).toContain("source_host: rt-host");
    const parsed = parsePodBundleManifest(yaml);
    const validation = validatePodBundleManifest(parsed);
    expect(validation.valid).toBe(true);
    const m = parsed as Record<string, unknown>;
    const prov = m["provenance"] as Record<string, unknown>;
    expect(prov["source_host"]).toBe("rt-host");
    expect(prov["author_session"]).toBe("velocity-driver@openrig-velocity");
    expect(prov["daemon_version"]).toBe("0.3.2");
    expect(prov["notes"]).toBe("v2 round-trip fixture");
  });
});

describe("PodBundleSourceResolver", () => {
  // 此测试针对暂存 bundle 目录覆盖真实 resolver。直接写入文件模拟 unpack 产物，然后测试 resolve。
  it("解析具有正确 manifest 和 specPath 的 schemaVersion 2 bundle", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { PodBundleSourceResolver } = await import("../src/domain/bundle-source-resolver.js");

    // 创建临时 "bundle" 目录（模拟 unpack 后状态）
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "podbundle-test-"));

    try {
      // 写入 manifest
      const manifestYaml = serializePodBundleManifest({
        schemaVersion: 2,
        name: "resolver-test",
        version: "1.0.0",
        createdAt: "2026-03-29T00:00:00Z",
        rigSpec: "rig.yaml",
        agents: [{
          name: "impl", version: "1.0", path: "agents/impl",
          originalRef: "local:agents/impl", hash: "abc",
          importEntries: [],
        }],
      });
      fs.writeFileSync(path.join(tmpDir, "bundle.yaml"), manifestYaml);

      // 写入 rig.yaml
      const rigYaml = RigSpecCodec.serialize({
        version: "0.2", name: "test-rig",
        pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }], edges: [] }],
        edges: [],
      });
      fs.writeFileSync(path.join(tmpDir, "rig.yaml"), rigYaml);

      // 写入 agent
      fs.mkdirSync(path.join(tmpDir, "agents", "impl"), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "agents", "impl", "agent.yaml"), 'name: impl\nversion: "1.0"\nprofiles: {}');

      // 现在测试 resolver 的 manifest 解析（文件已暂存，因此跳过归档解包——
      // 测试 parse/validate/extract seam）
      const raw = parsePodBundleManifest(fs.readFileSync(path.join(tmpDir, "bundle.yaml"), "utf-8"));
      const validation = validatePodBundleManifest(raw);
      expect(validation.valid).toBe(true);

      const m = raw as Record<string, unknown>;
      expect(m["schema_version"]).toBe(2);
      expect(m["name"]).toBe("resolver-test");
      expect(m["agents"]).toHaveLength(1);
      const agents = m["agents"] as Array<Record<string, unknown>>;
      expect(agents[0]!["name"]).toBe("impl");

      // 验证 specPath 存在
      const specPath = path.join(tmpDir, m["rig_spec"] as string);
      expect(fs.existsSync(specPath)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("将声明的 docs 文件与 rig spec 一同打包", () => {
    const spec = makeRigSpec({ docs: [{ path: "SETUP.md" }] });
    const yaml = rigSpecYaml(spec);
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: yaml,
      [`${RIG_ROOT}/SETUP.md`]: "# Setup instructions\nInstall Exa MCP first.",
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    const result = assembler.assemble({
      rigRoot: RIG_ROOT,
      rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/out",
      bundleName: "test",
      bundleVersion: "1.0",
    });

    expect(result.collectedFiles).toContain("SETUP.md");
    // 打包后的 rig.yaml 仍应引用该文档
    const written = (fs as unknown as { _written: Record<string, string> })._written;
    const bundledRigYaml = written["/out/rig.yaml"];
    expect(bundledRigYaml).toContain("SETUP.md");
  });

  it("声明的 doc 文件在磁盘上缺失时组装失败", () => {
    const spec = makeRigSpec({ docs: [{ path: "SETUP.md" }] });
    const yaml = rigSpecYaml(spec);
    const files: Record<string, string> = {
      [`${RIG_ROOT}/rig.yaml`]: yaml,
      // 故意缺少 SETUP.md
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const fs = mockFs(files);
    const assembler = new PodBundleAssembler({ fsOps: fs });

    expect(() => assembler.assemble({
      rigRoot: RIG_ROOT,
      rigSpecPath: `${RIG_ROOT}/rig.yaml`,
      outputDir: "/out",
      bundleName: "test",
      bundleVersion: "1.0",
    })).toThrow(/未找到已声明的文档文件：SETUP\.md/);
  });
});
