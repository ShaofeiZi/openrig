import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SpecLibraryService } from "../src/domain/spec-library-service.js";
import { SpecReviewService } from "../src/domain/spec-review-service.js";

const VALID_RIG_YAML = `
version: "0.2"
name: test-rig
pods:
  - id: dev
    label: Dev
    members:
      - id: impl
        agent_ref: "local:agents/impl"
        runtime: claude-code
        profile: default
        cwd: /tmp
    edges: []
edges: []
`;

const VALID_AGENT_YAML = `
name: test-agent
version: "1.0"
defaults:
  runtime: claude-code
profiles:
  default:
    uses: []
resources:
  skills: []
startup:
  files: []
  actions: []
`;

const INVALID_YAML = `
this is not: a valid spec
at all:
  - just random keys
`;

describe("SpecLibraryService 规范库服务", () => {
  let tmpDir: string;
  let specReviewService: SpecReviewService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "spec-lib-"));
    specReviewService = new SpecReviewService();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createLibrary(roots?: Array<{ path: string; sourceType: "builtin" | "user_file" }>) {
    return new SpecLibraryService({
      roots: roots ?? [{ path: tmpDir, sourceType: "user_file" }],
      specReviewService,
    });
  }

  it("scan 发现经 SpecReviewService 验证的工作组 spec", () => {
    writeFileSync(join(tmpDir, "my-rig.yaml"), VALID_RIG_YAML);

    const lib = createLibrary();
    lib.scan();

    const entries = lib.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("rig");
    expect(entries[0]!.name).toBe("test-rig");
    expect(entries[0]!.sourceType).toBe("user_file");
    expect(entries[0]!.sourcePath).toContain("my-rig.yaml");
  });

  it("scan 发现经 SpecReviewService 验证的 agent spec", () => {
    writeFileSync(join(tmpDir, "my-agent.yaml"), VALID_AGENT_YAML);

    const lib = createLibrary();
    lib.scan();

    const entries = lib.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("agent");
    expect(entries[0]!.name).toBe("test-agent");
  });

  it("scan 跳过同时未通过工作组与 agent validation 的文件", () => {
    writeFileSync(join(tmpDir, "valid.yaml"), VALID_RIG_YAML);
    writeFileSync(join(tmpDir, "invalid.yaml"), INVALID_YAML);
    writeFileSync(join(tmpDir, "not-yaml.txt"), "just text");

    const lib = createLibrary();
    lib.scan();

    const entries = lib.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("test-rig");
  });

  it("带 kind filter 的 list 只返回匹配 entry", () => {
    writeFileSync(join(tmpDir, "rig.yaml"), VALID_RIG_YAML);
    writeFileSync(join(tmpDir, "agent.yaml"), VALID_AGENT_YAML);

    const lib = createLibrary();
    lib.scan();

    expect(lib.list({ kind: "rig" })).toHaveLength(1);
    expect(lib.list({ kind: "agent" })).toHaveLength(1);
    expect(lib.list()).toHaveLength(2);
  });

  it("get 返回 entry 及磁盘中的 YAML content", () => {
    writeFileSync(join(tmpDir, "rig.yaml"), VALID_RIG_YAML);

    const lib = createLibrary();
    lib.scan();

    const entries = lib.list();
    const result = lib.get(entries[0]!.id);
    expect(result).not.toBeNull();
    expect(result!.entry.name).toBe("test-rig");
    expect(result!.yaml).toContain("test-rig");
  });

  it("ID 在重复 scan 间保持确定性", () => {
    writeFileSync(join(tmpDir, "rig.yaml"), VALID_RIG_YAML);

    const lib = createLibrary();
    lib.scan();
    const id1 = lib.list()[0]!.id;
    lib.scan();
    const id2 = lib.list()[0]!.id;
    expect(id1).toBe(id2);
  });

  it("scan 发现 nested spec，并在 ID 中保留 relative path", () => {
    mkdirSync(join(tmpDir, "agents", "development", "implementer"), { recursive: true });
    writeFileSync(join(tmpDir, "agents", "development", "implementer", "agent.yaml"), VALID_AGENT_YAML);

    const lib = createLibrary([{ path: tmpDir, sourceType: "builtin" }]);
    lib.scan();

    const entries = lib.list({ kind: "agent" });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("test-agent");
    expect(entries[0]!.relativePath).toBe("agents/development/implementer/agent.yaml");

    lib.scan();
    expect(lib.list({ kind: "agent" })[0]!.id).toBe(entries[0]!.id);
  });

  it("builtin scan 忽略不是工作组或 agent entrypoint 的 nested template YAML", () => {
    mkdirSync(join(tmpDir, "rigs", "launch", "demo"), { recursive: true });
    mkdirSync(join(tmpDir, "agents", "shared", "skills", "process", "containerized-e2e", "templates"), { recursive: true });
    writeFileSync(join(tmpDir, "rigs", "launch", "demo", "rig.yaml"), VALID_RIG_YAML);
    writeFileSync(
      join(tmpDir, "agents", "shared", "skills", "process", "containerized-e2e", "templates", "control-plane-test.yaml"),
      VALID_RIG_YAML,
    );

    const lib = createLibrary([{ path: tmpDir, sourceType: "builtin" }]);
    lib.scan();

    const rigs = lib.list({ kind: "rig" });
    expect(rigs).toHaveLength(1);
    expect(rigs[0]!.relativePath).toBe("rigs/launch/demo/rig.yaml");
  });

  // OPR.0.3.2.22 Bug 4——walkYamlFiles 现在跳过 noise directory（.worktrees、node_modules、
  // .git、dist、build、.turbo、.next）。.worktrees/release-0.3.0-... 下的 conveyor.yaml 是
  // openrig-comms paper-cut report 中的关键 case；这里在 SpecLibraryService.scan() seam 固定
  // SKIP_DIRS guard。
  it("scan 跳过 noise directory 内的 YAML 文件（SKIP_DIRS）", () => {
    writeFileSync(join(tmpDir, "canonical.yaml"), VALID_RIG_YAML);

    const NOISE_DIRS = [".worktrees", "node_modules", ".git", "dist", "build", ".turbo", ".next"];
    for (const dir of NOISE_DIRS) {
      mkdirSync(join(tmpDir, dir, "deeper"), { recursive: true });
      writeFileSync(join(tmpDir, dir, "deeper", "noise.yaml"), VALID_RIG_YAML.replace("test-rig", `noise-${dir}`));
    }

    const lib = createLibrary();
    lib.scan();

    const entries = lib.list();
    expect(entries, `expected only canonical rig (got ${JSON.stringify(entries.map((e) => e.relativePath))})`).toHaveLength(1);
    expect(entries[0]!.sourcePath).toContain("canonical.yaml");
    for (const dir of NOISE_DIRS) {
      expect(entries.every((e) => !e.sourcePath.includes(`/${dir}/`)), `entry from ${dir} leaked through SKIP_DIRS`).toBe(true);
    }
  });
});
