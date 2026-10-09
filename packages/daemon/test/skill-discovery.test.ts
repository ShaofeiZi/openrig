// V0.3.0 daemon-skill-discovery——skill 发现模块的 TDD-first 契约，给 profile resolver
// 一个 user-library / rig-bundled 路径上现存 skill 的 runtime-truth 视图。
//
// Skill 发现按生效 spec（status.md 2026-05-10）扫 5 类路径：
//   1. ~/.openrig/skills/                                     （per-runtime user-spec 库）
//   2. ~/.claude/skills/                                      （Claude-runtime 用户库）
//   3. ~/.agents/skills/                                      （Codex-runtime 用户库）
//   4. <cwd>/.claude/skills/<name>/ + <cwd>/.agents/skills/<name>/   （cwd 处 rig-bundled）
//   5. <spec-install-dir>/skills/<name>/                     （rig-spec 安装目录）
//
// Per-runtime 过滤：claude-code 瞄准 Claude 路径；codex 瞄准 Codex 路径；
// ~/.openrig/skills/ 共享。
//
// Per-skill 结构校验：解析 SKILL.md frontmatter；要求 `name` + `description` 字段；
// 其余拒为"并非 Claude Code 或 Codex 会加载的 skill"。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverSkillsForRuntime,
  parseSkillFrontmatter,
  type SkillDiscoveryPaths,
} from "../src/domain/skill-discovery.js";

let tmpRoot: string;
let homedir: string;
let cwd: string;
let specInstallDir: string;

function writeSkill(dir: string, frontmatter: Record<string, string>, body: string = "Body content."): void {
  mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const content = `---\n${fm}\n---\n\n${body}\n`;
  writeFileSync(join(dir, "SKILL.md"), content, "utf-8");
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "skill-discovery-"));
  homedir = join(tmpRoot, "home");
  cwd = join(tmpRoot, "rig-cwd");
  specInstallDir = join(tmpRoot, "spec-install");
  mkdirSync(homedir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(specInstallDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function pathsFor(runtime: "claude-code" | "codex"): SkillDiscoveryPaths {
  return { runtime, homedir, cwd, specInstallDir };
}

describe("parseSkillFrontmatter——结构校验", () => {
  it("接受带 name + description + body 的 SKILL.md 并返回解析后的 frontmatter", () => {
    const content = "---\nname: my-skill\ndescription: Does a thing.\n---\n\nBody.\n";
    const result = parseSkillFrontmatter(content);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.frontmatter.name).toBe("my-skill");
      expect(result.frontmatter.description).toBe("Does a thing.");
    }
  });

  it("把无 frontmatter 的文件拒为结构非法", () => {
    const content = "Just a regular markdown file.\n\nNo frontmatter at all.\n";
    const result = parseSkillFrontmatter(content);
    expect(result.ok).toBe(false);
  });

  it("拒绝缺 `name` 字段的 SKILL.md", () => {
    const content = "---\ndescription: Does a thing.\n---\n\nBody.\n";
    const result = parseSkillFrontmatter(content);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/name/);
  });

  it("拒绝缺 `description` 字段的 SKILL.md", () => {
    const content = "---\nname: my-skill\n---\n\nBody.\n";
    const result = parseSkillFrontmatter(content);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/description/);
  });

  it("拒绝空 body 的 SKILL.md（runtime 将无内容可加载）", () => {
    const content = "---\nname: my-skill\ndescription: Does a thing.\n---\n";
    const result = parseSkillFrontmatter(content);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/正文/);
  });

  it("把畸形 YAML frontmatter 块拒为结构非法", () => {
    const content = "---\nname: [broken\ndescription: Does a thing.\n---\n\nBody.\n";
    const result = parseSkillFrontmatter(content);
    expect(result.ok).toBe(false);
  });
});

describe("discoverSkillsForRuntime——Claude-runtime 路径扫描", () => {
  it("从 ~/.claude/skills/<name>/ 发现 skill", () => {
    writeSkill(join(homedir, ".claude/skills/openrig-architect"), {
      name: "openrig-architect",
      description: "Architect rigs",
    });
    const result = discoverSkillsForRuntime(pathsFor("claude-code"));
    const ids = result.skills.map((s) => s.id);
    expect(ids).toContain("openrig-architect");
  });

  it("从 ~/.openrig/skills/<name>/（共享 user-spec 库）发现 skill", () => {
    writeSkill(join(homedir, ".openrig/skills/alignment-trace"), {
      name: "alignment-trace",
      description: "Trace alignment",
    });
    const result = discoverSkillsForRuntime(pathsFor("claude-code"));
    const ids = result.skills.map((s) => s.id);
    expect(ids).toContain("alignment-trace");
  });

  it("从 rig-bundled <cwd>/.claude/skills/<name>/ 发现 skill", () => {
    writeSkill(join(cwd, ".claude/skills/web-design-guidelines"), {
      name: "web-design-guidelines",
      description: "Web design checks",
    });
    const result = discoverSkillsForRuntime(pathsFor("claude-code"));
    const ids = result.skills.map((s) => s.id);
    expect(ids).toContain("web-design-guidelines");
  });

  it("从 <spec-install-dir>/skills/<name>/ 发现 skill", () => {
    writeSkill(join(specInstallDir, "skills/remotion-best-practices"), {
      name: "remotion-best-practices",
      description: "Remotion patterns",
    });
    const result = discoverSkillsForRuntime(pathsFor("claude-code"));
    const ids = result.skills.map((s) => s.id);
    expect(ids).toContain("remotion-best-practices");
  });

  it("对 claude-code runtime 不扫 ~/.agents/skills/", () => {
    writeSkill(join(homedir, ".agents/skills/codex-only"), {
      name: "codex-only",
      description: "Codex thing",
    });
    const result = discoverSkillsForRuntime(pathsFor("claude-code"));
    const ids = result.skills.map((s) => s.id);
    expect(ids).not.toContain("codex-only");
  });
});

describe("discoverSkillsForRuntime——Codex-runtime 路径扫描", () => {
  it("从 ~/.agents/skills/<name>/ 发现 skill", () => {
    writeSkill(join(homedir, ".agents/skills/openrig-architect"), {
      name: "openrig-architect",
      description: "Architect rigs",
    });
    const result = discoverSkillsForRuntime(pathsFor("codex"));
    const ids = result.skills.map((s) => s.id);
    expect(ids).toContain("openrig-architect");
  });

  it("从 rig-bundled <cwd>/.agents/skills/<name>/ 发现 skill", () => {
    writeSkill(join(cwd, ".agents/skills/alignment-trace"), {
      name: "alignment-trace",
      description: "Trace alignment",
    });
    const result = discoverSkillsForRuntime(pathsFor("codex"));
    const ids = result.skills.map((s) => s.id);
    expect(ids).toContain("alignment-trace");
  });

  it("对 codex runtime 不扫 ~/.claude/skills/", () => {
    writeSkill(join(homedir, ".claude/skills/claude-only"), {
      name: "claude-only",
      description: "Claude thing",
    });
    const result = discoverSkillsForRuntime(pathsFor("codex"));
    const ids = result.skills.map((s) => s.id);
    expect(ids).not.toContain("claude-only");
  });
});

describe("discoverSkillsForRuntime——扫描时结构拒绝", () => {
  it("跳过无 SKILL.md 的目录（不是 skill）", () => {
    mkdirSync(join(homedir, ".claude/skills/junk-dir"), { recursive: true });
    writeFileSync(join(homedir, ".claude/skills/junk-dir/README.md"), "Not a skill.", "utf-8");
    const result = discoverSkillsForRuntime(pathsFor("claude-code"));
    const ids = result.skills.map((s) => s.id);
    expect(ids).not.toContain("junk-dir");
  });

  it("跳过 frontmatter 校验失败的 SKILL.md 并呈现结构化拒绝", () => {
    const dir = join(homedir, ".claude/skills/broken-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "no frontmatter\n", "utf-8");
    const result = discoverSkillsForRuntime(pathsFor("claude-code"));
    const ids = result.skills.map((s) => s.id);
    expect(ids).not.toContain("broken-skill");
    expect(result.rejected.some((r) => r.path.includes("broken-skill"))).toBe(true);
  });
});

describe("discoverSkillsForRuntime——SkillResource 形状", () => {
  it("把每个发现的 skill 返回为 { id, path }，id 取自 frontmatter，path 指向 skill 目录", () => {
    writeSkill(join(homedir, ".claude/skills/openrig-architect"), {
      name: "openrig-architect",
      description: "Architect rigs",
    });
    const result = discoverSkillsForRuntime(pathsFor("claude-code"));
    const found = result.skills.find((s) => s.id === "openrig-architect");
    expect(found).toBeDefined();
    expect(found!.path).toBe(join(homedir, ".claude/skills/openrig-architect"));
  });

  it("对缺失顶层扫描目录健壮（返回空列表，而非 throw）", () => {
    // homedir + cwd + specInstallDir 都存在，但 .claude/skills /
    // .agents/skills / .openrig/skills / skills 子目录不存在。
    const result = discoverSkillsForRuntime(pathsFor("claude-code"));
    expect(result.skills).toEqual([]);
    expect(result.rejected).toEqual([]);
  });
});
