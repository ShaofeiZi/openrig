import { describe, it, expect, vi } from "vitest";
import { SessionEnricher } from "../src/domain/session-enricher.js";

function mockFs(structure: Record<string, string[] | true>): { fsExists: (p: string) => boolean; fsReaddir: (p: string) => string[] } {
  return {
    fsExists: (p: string) => p in structure,
    fsReaddir: (p: string) => {
      const val = structure[p];
      if (Array.isArray(val)) return val;
      throw new Error(`不是目录：${p}`);
    },
  };
}

describe("SessionEnricher 会话增强器", () => {
  // T1：.claude/skills/ -> 列出技能目录名
  it("从 .claude/skills/ 列出技能名称", () => {
    const enricher = new SessionEnricher(mockFs({
      "/projects": true,
      "/projects/.claude/skills": ["helper", "reviewer"],
    }));

    const result = enricher.enrich("/projects");

    expect(result.claudeSkills).toEqual(["helper", "reviewer"]);
    expect(result.skills).toContain("helper");
    expect(result.skills).toContain("reviewer");
  });

  // T2：.agents/skills/ -> 列出技能目录名
  it("从 .agents/skills/ 列出技能名称", () => {
    const enricher = new SessionEnricher(mockFs({
      "/projects": true,
      "/projects/.agents/skills": ["codex-tool"],
    }));

    const result = enricher.enrich("/projects");

    expect(result.agentsSkills).toEqual(["codex-tool"]);
    expect(result.skills).toContain("codex-tool");
  });

  // T3：CLAUDE.md -> hasClaudeMd=true
  it("检测 CLAUDE.md 是否存在", () => {
    const enricher = new SessionEnricher(mockFs({
      "/projects": true,
      "/projects/CLAUDE.md": true,
    }));

    const result = enricher.enrich("/projects");

    expect(result.hasClaudeMd).toBe(true);
    expect(result.hasAgentsMd).toBe(false);
  });

  // T4：无智能体配置 -> 全为空/false
  it("不存在智能体配置时返回空结果", () => {
    const enricher = new SessionEnricher(mockFs({
      "/projects": true,
    }));

    const result = enricher.enrich("/projects");

    expect(result.skills).toEqual([]);
    expect(result.hasClaudeMd).toBe(false);
    expect(result.hasAgentsMd).toBe(false);
    expect(result.hasPackageYaml).toBe(false);
  });

  // T5：cwd 为 null -> 平稳返回空结果
  it("cwd 为 null 时返回空结果", () => {
    const enricher = new SessionEnricher(mockFs({}));

    const result = enricher.enrich(null);

    expect(result.skills).toEqual([]);
    expect(result.hasClaudeMd).toBe(false);
  });

  // T6：资源丰富夹具 -> 返回所有字段，包括合并后的技能、AGENTS.md、package.yaml
  it("资源丰富的 cwd 正确返回所有字段", () => {
    const enricher = new SessionEnricher(mockFs({
      "/projects": true,
      "/projects/.claude/skills": ["skill-a", "skill-b"],
      "/projects/.agents/skills": ["skill-c"],
      "/projects/CLAUDE.md": true,
      "/projects/AGENTS.md": true,
      "/projects/package.yaml": true,
    }));

    const result = enricher.enrich("/projects");

    expect(result.claudeSkills).toEqual(["skill-a", "skill-b"]);
    expect(result.agentsSkills).toEqual(["skill-c"]);
    expect(result.skills).toEqual(["skill-a", "skill-b", "skill-c"]);
    expect(result.hasClaudeMd).toBe(true);
    expect(result.hasAgentsMd).toBe(true);
    expect(result.hasPackageYaml).toBe(true);
    expect(result.raw).toEqual({
      hasClaudeMd: true,
      hasAgentsMd: true,
      hasPackageYaml: true,
      claudeSkills: ["skill-a", "skill-b"],
      agentsSkills: ["skill-c"],
      skills: ["skill-a", "skill-b", "skill-c"],
    });
  });

  // T7：cwd 路径不存在 -> 空结果
  it("cwd 不存在时返回空结果", () => {
    const enricher = new SessionEnricher(mockFs({}));

    const result = enricher.enrich("/nonexistent/path");

    expect(result.skills).toEqual([]);
    expect(result.hasClaudeMd).toBe(false);
  });

  // T8：fsReaddir 抛错 -> 平稳返回空技能列表
  it("fsReaddir 错误时返回空技能列表且不向外抛出", () => {
    const enricher = new SessionEnricher({
      fsExists: (p) => p === "/projects" || p === "/projects/.claude/skills",
      fsReaddir: vi.fn(() => { throw new Error("EACCES: permission denied"); }),
    });

    const result = enricher.enrich("/projects");

    expect(result.claudeSkills).toEqual([]);
    expect(result.skills).toEqual([]);
  });
});
