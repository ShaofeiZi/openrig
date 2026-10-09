import { describe, it, expect } from "vitest";
import {
  parseManifest,
  validateManifest,
  normalizeManifest,
  serializeManifest,
} from "../src/domain/package-manifest.js";

const VALID_YAML = `
schema_version: 1
name: com.example.review-stack
version: 0.1.0
summary: Multi-agent review package
compatibility:
  runtimes:
    - claude-code
    - codex
exports:
  skills:
    - source: skills/deep-pr-review
      name: deep-pr-review
      supported_scopes: [project_shared]
      default_scope: project_shared
  guidance:
    - source: guidance/AGENTS.md
      kind: agents_md
      supported_scopes: [project_shared]
      default_scope: project_shared
      merge_strategy: managed_block
`;

function validRaw() {
  return parseManifest(VALID_YAML);
}

describe("PackageManifest", () => {
  // 测试 1：有效 manifest 通过校验。
  it("有效 manifest 通过校验", () => {
    const result = validateManifest(validRaw());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  // 测试 2：缺少 name → 错误。
  it("缺少 name 时返回错误", () => {
    const raw = parseManifest(VALID_YAML.replace("name: com.example.review-stack", ""));
    const result = validateManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
  });

  // 测试 3：缺少 version → 错误。
  it("缺少 version 时返回错误", () => {
    const raw = parseManifest(VALID_YAML.replace("version: 0.1.0", ""));
    const result = validateManifest(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("version"))).toBe(true);
  });

  // 测试 4：未知 runtime → 错误。
  it("未知 runtime 返回错误", () => {
    const yaml = VALID_YAML.replace("- claude-code", "- unknown-runtime");
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("unknown-runtime"))).toBe(true);
  });

  // 测试 5：未知 guidance kind → 错误。
  it("未知 guidance kind 返回错误", () => {
    const yaml = VALID_YAML.replace("kind: agents_md", "kind: invalid_kind");
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("invalid_kind"))).toBe(true);
  });

  // 测试 6：未知 merge strategy → 错误。
  it("未知 merge strategy 返回错误", () => {
    const yaml = VALID_YAML.replace("merge_strategy: managed_block", "merge_strategy: yolo");
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("yolo"))).toBe(true);
  });

  // 测试 7：路径穿越 → 错误。
  it("包含路径穿越的 export source 返回错误", () => {
    const yaml = VALID_YAML.replace("source: skills/deep-pr-review", "source: ../../../etc/passwd");
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("路径穿越"))).toBe(true);
  });

  // 测试 8：Role 引用不存在的 skill → 错误。
  it("role 引用不存在的 skill 时返回错误", () => {
    const yaml = VALID_YAML + `
roles:
  - name: reviewer
    skills:
      - nonexistent-skill
`;
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("nonexistent-skill"))).toBe(true);
  });

  // 测试 9：报告多个错误（不短路）。
  it("报告多个错误而不短路", () => {
    const yaml = `
schema_version: 1
compatibility:
  runtimes: []
exports:
  skills: []
`;
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    // 应包含 name、version、summary 和 runtimes 为空的错误。
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });

  // 测试 10：normalize 应用默认值（schemaVersion + defaultScope + supportedScopes）。
  it("normalize 为 schemaVersion、defaultScope 和 supportedScopes 应用默认值", () => {
    const yaml = `
name: test
version: 1.0.0
summary: Test package
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/foo
      name: foo
  guidance:
    - source: guidance/AGENTS.md
      kind: agents_md
      merge_strategy: managed_block
`;
    const manifest = normalizeManifest(parseManifest(yaml));

    // schemaVersion 默认为 1。
    expect(manifest.schemaVersion).toBe(1);

    // skill defaultScope 默认为 project_shared。
    expect(manifest.exports.skills![0]!.defaultScope).toBe("project_shared");
    // skill supportedScopes 默认为 ['project_shared']。
    expect(manifest.exports.skills![0]!.supportedScopes).toEqual(["project_shared"]);

    // guidance 默认值。
    expect(manifest.exports.guidance![0]!.defaultScope).toBe("project_shared");
    expect(manifest.exports.guidance![0]!.supportedScopes).toEqual(["project_shared"]);
  });

  // 测试 11：Hooks 和 MCP 正确解析，不被拒绝。
  it("正确解析 hooks 和 MCP，不予拒绝", () => {
    const yaml = VALID_YAML + `
  hooks:
    - source: hooks/checkpoint.yaml
      supported_runtimes: [claude-code]
  mcp:
    - source: mcp/context7.yaml
      supported_runtimes: [claude-code, codex]
`;
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(true);

    const manifest = normalizeManifest(parseManifest(yaml));
    expect(manifest.exports.hooks).toHaveLength(1);
    expect(manifest.exports.hooks![0]!.source).toBe("hooks/checkpoint.yaml");
    expect(manifest.exports.mcp).toHaveLength(1);
    expect(manifest.exports.mcp![0]!.source).toBe("mcp/context7.yaml");
  });

  // 测试 12：使用完整 fixture 往返。
  it("往返：parse → validate → normalize → serialize → re-parse（所有 section）", () => {
    const comprehensiveYaml = `
schema_version: 1
name: com.example.full
version: 2.0.0
summary: Comprehensive test
compatibility:
  runtimes: [claude-code, codex]
exports:
  skills:
    - source: skills/foo
      name: foo
      supported_scopes: [project_shared]
      default_scope: project_shared
  guidance:
    - source: guidance/AGENTS.md
      kind: agents_md
      supported_scopes: [project_shared]
      default_scope: project_shared
      merge_strategy: managed_block
  hooks:
    - source: hooks/check.yaml
      supported_runtimes: [claude-code]
  mcp:
    - source: mcp/ctx.yaml
      supported_runtimes: [codex]
requirements:
  cli_tools:
    - name: agent-browser
      required_for: [qa-browser]
      install_hints:
        macos: brew install agent-browser
  system_packages:
    - name: ripgrep
install_policy:
  require_review_for_external_installs: true
  allow_user_global_writes: false
verification:
  checks:
    - type: skill_present
      name: foo
    - type: cli_exists
      command: agent-browser --help
roles:
  - name: reviewer
    skills: [foo]
    guidance: [AGENTS.md]
`;

    const raw = parseManifest(comprehensiveYaml);
    const result = validateManifest(raw);
    expect(result.valid).toBe(true);

    const manifest = normalizeManifest(raw);
    const yaml = serializeManifest(manifest);
    const reManifest = normalizeManifest(parseManifest(yaml));

    // 核心字段。
    expect(reManifest.name).toBe("com.example.full");
    expect(reManifest.version).toBe("2.0.0");
    expect(reManifest.exports.skills).toHaveLength(1);
    expect(reManifest.exports.guidance).toHaveLength(1);
    expect(reManifest.exports.hooks).toHaveLength(1);
    expect(reManifest.exports.mcp).toHaveLength(1);

    // Requirements 得以保留。
    expect(reManifest.requirements?.cliTools).toHaveLength(1);
    expect(reManifest.requirements!.cliTools![0]!.name).toBe("agent-browser");
    expect(reManifest.requirements!.cliTools![0]!.requiredFor).toEqual(["qa-browser"]);
    expect(reManifest.requirements?.systemPackages).toHaveLength(1);

    // InstallPolicy 得以保留。
    expect(reManifest.installPolicy?.requireReviewForExternalInstalls).toBe(true);
    expect(reManifest.installPolicy?.allowUserGlobalWrites).toBe(false);

    // Verification 得以保留。
    expect(reManifest.verification?.checks).toHaveLength(2);
    expect(reManifest.verification!.checks[0]!.type).toBe("skill_present");
    expect(reManifest.verification!.checks[0]!.name).toBe("foo");
    expect(reManifest.verification!.checks[1]!.command).toBe("agent-browser --help");

    // Roles 得以保留。
    expect(reManifest.roles).toHaveLength(1);
    expect(reManifest.roles![0]!.skills).toEqual(["foo"]);
  });

  // 测试 13：无效 version 格式 → 错误。
  it("无效 version 格式返回错误", () => {
    const yaml = VALID_YAML.replace("version: 0.1.0", "version: not-a-version");
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("semver"))).toBe(true);
  });

  // 测试 14：缺少 summary → 错误。
  it("缺少 summary 时返回错误", () => {
    const yaml = VALID_YAML.replace("summary: Multi-agent review package", "");
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("summary"))).toBe(true);
  });

  // 测试 15：缺少 exports → 错误。
  it("缺少 exports 时返回错误", () => {
    const yaml = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [claude-code]
`;
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("exports"))).toBe(true);
  });

  // 测试 16：Role 引用不存在的 guidance → 错误。
  it("role 引用不存在的 guidance 时返回错误", () => {
    const yaml = VALID_YAML + `
roles:
  - name: reviewer
    guidance:
      - nonexistent-guidance.md
`;
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("nonexistent-guidance.md"))).toBe(true);
  });

  // 测试 17：guidance 名称重复 → 错误。
  it("guidance 名称重复时返回错误", () => {
    const yaml = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  guidance:
    - source: guidance/AGENTS.md
      kind: agents_md
      merge_strategy: managed_block
    - source: other/AGENTS.md
      kind: agents_md
      merge_strategy: append
`;
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Guidance 名称重复"))).toBe(true);
  });

  // 测试 19：无效 scope 值 → 错误。
  it("supported_scopes 值无效时返回错误", () => {
    const yaml = `
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
      supported_scopes: [totally_invalid_scope]
      default_scope: totally_invalid_scope
`;
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("totally_invalid_scope"))).toBe(true);
  });

  // 测试 20：拒绝 skill 中裸露的 '..' 路径穿越。
  it("拒绝 skill 中裸露的 '..' 路径穿越", () => {
    const yaml = VALID_YAML.replace("source: skills/deep-pr-review", "source: ..");
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("路径穿越"))).toBe(true);
  });

  // 测试 21：拒绝包含路径穿越的 hook。
  it("拒绝包含路径穿越的 hook", () => {
    const yaml = `
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
    - source: ../../../etc/shadow
`;
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Hook export source 不得包含路径穿越"))).toBe(true);
  });

  // 测试 22：拒绝包含路径穿越的 MCP。
  it("拒绝包含路径穿越的 MCP", () => {
    const yaml = `
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
  mcp:
    - source: ../../../etc/shadow
`;
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("MCP export source 不得包含路径穿越"))).toBe(true);
  });

  // 测试 23：拒绝重复 agent 名称。
  it("拒绝重复 agent 名称", () => {
    const yaml = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  agents:
    - source: agents/review.md
      name: review
    - source: agents/other.md
      name: review
`;
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Agent 名称重复"))).toBe(true);
  });

  // 测试 24：拒绝包含无效字符的 package 名称。
  it("拒绝包含无效字符的 package 名称", () => {
    const yaml = VALID_YAML.replace("name: com.example.review-stack", "name: bad-->name");
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name 必须匹配"))).toBe(true);
  });

  // 测试 25：包含有效字符的 package 名称通过。
  it("包含有效字符的 package 名称通过", () => {
    const yaml = VALID_YAML.replace("name: com.example.review-stack", "name: my-package.v2");
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(true);
  });

  // 测试 18：skill 名称重复 → 错误。
  it("skill 名称重复时返回错误", () => {
    const yaml = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/foo
      name: my-skill
    - source: skills/bar
      name: my-skill
`;
    const result = validateManifest(parseManifest(yaml));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Skill 名称重复"))).toBe(true);
  });
});
