/** 使用 config context 补充已发现 session 后的结果 */
export interface EnrichmentResult {
  skills: string[];
  claudeSkills: string[];
  agentsSkills: string[];
  hasClaudeMd: boolean;
  hasAgentsMd: boolean;
  hasPackageYaml: boolean;
  raw: Record<string, unknown>;
}

interface EnricherDeps {
  fsExists: (path: string) => boolean;
  fsReaddir: (path: string) => string[];
}

const EMPTY_RESULT: EnrichmentResult = {
  skills: [],
  claudeSkills: [],
  agentsSkills: [],
  hasClaudeMd: false,
  hasAgentsMd: false,
  hasPackageYaml: false,
  raw: {},
};

/**
 * 从 session 的 cwd 探测 config。检查 agent config directory、guidance file、skill 与
 * package manifest。只读取 filesystem——不执行命令，不调用 adapter。
 */
export class SessionEnricher {
  private fsExists: (path: string) => boolean;
  private fsReaddir: (path: string) => string[];

  constructor(deps: EnricherDeps) {
    this.fsExists = deps.fsExists;
    this.fsReaddir = deps.fsReaddir;
  }

  /** 通过探测 cwd 中的 config 补充 session 信息。 */
  enrich(cwd: string | null): EnrichmentResult {
    if (!cwd || !this.fsExists(cwd)) {
      return { ...EMPTY_RESULT, raw: {} };
    }

    const hasClaudeMd = this.fsExists(`${cwd}/CLAUDE.md`);
    const hasAgentsMd = this.fsExists(`${cwd}/AGENTS.md`);
    const hasPackageYaml = this.fsExists(`${cwd}/package.yaml`);

    const claudeSkills = this.safeReaddir(`${cwd}/.claude/skills`);
    const agentsSkills = this.safeReaddir(`${cwd}/.agents/skills`);
    const skills = [...claudeSkills, ...agentsSkills];

    const raw: Record<string, unknown> = {
      hasClaudeMd,
      hasAgentsMd,
      hasPackageYaml,
      claudeSkills,
      agentsSkills,
      skills,
    };

    return { skills, claudeSkills, agentsSkills, hasClaudeMd, hasAgentsMd, hasPackageYaml, raw };
  }

  private safeReaddir(path: string): string[] {
    if (!this.fsExists(path)) return [];
    try {
      return this.fsReaddir(path);
    } catch {
      return [];
    }
  }
}
