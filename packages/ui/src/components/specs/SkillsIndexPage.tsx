import { Link } from "@tanstack/react-router";
import { SectionHeader } from "../ui/section-header.js";
import { ToolMark } from "../graphics/RuntimeMark.js";
import { useLibrarySkills, type LibrarySkillEntry } from "../../hooks/useLibrarySkills.js";
import { librarySkillToken } from "../../lib/library-skills-routing.js";

function formatSkillSource(source: LibrarySkillEntry["source"]): string {
  if (source === "workspace") return "工作区";
  if (source === "openrig-managed") return "zrig 托管";
  return source;
}

export function SkillsIndexPage() {
  const { data: skills = [], isLoading } = useLibrarySkills();
  const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div
      data-testid="skills-index-page"
      className="mx-auto w-full max-w-[960px] px-6 py-8"
    >
      <header className="border-b border-outline-variant pb-4 mb-4">
        <SectionHeader tone="muted">资料库</SectionHeader>
        <div className="mt-1 flex items-baseline justify-between">
          <h1 className="font-headline text-headline-md font-bold tracking-tight uppercase text-on-surface">
            技能
          </h1>
          <span data-testid="skills-index-count" className="font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant">
            {isLoading ? "加载中" : `${sorted.length} 个技能`}
          </span>
        </div>
      </header>

      {isLoading && sorted.length === 0 ? (
        <div data-testid="skills-index-loading" className="font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant">
          正在加载技能…
        </div>
      ) : sorted.length === 0 ? (
        <div
          data-testid="skills-index-empty"
          className="border border-outline-variant bg-surface-lowest/25 px-4 py-6 font-mono text-xs leading-relaxed text-on-surface"
        >
          <p className="font-bold uppercase tracking-wide text-on-surface">无可见技能</p>
          <p className="mt-2">
            技能位于工作区的 <code className="font-mono text-on-surface">.openrig/skills/</code> 目录下，
            外加 zrig 内置集。如果此列表为空，说明后台服务通过配置的文件根目录未能看到任一来源。
          </p>
        </div>
      ) : (
        <ul data-testid="skills-index-rows" className="border border-outline-variant bg-surface-lowest/25 hard-shadow divide-y divide-outline-variant">
          {sorted.map((skill) => (
            <li key={skill.id}>
              <Link
                to="/specs/skills/$skillToken"
                params={{ skillToken: librarySkillToken(skill.id) }}
                data-testid={`skills-index-row-${skill.id}`}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 font-mono text-left hover:bg-surface-low/60 focus:outline-none focus:bg-surface-low/80"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ToolMark tool="skill" title={`${skill.name} 技能`} size="xs" decorative />
                  <span className="truncate text-xs font-bold text-on-surface">{skill.name}</span>
                </span>
                <span className="flex shrink-0 items-center gap-3 font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">
                  <span data-testid={`skills-index-row-${skill.id}-source`}>{formatSkillSource(skill.source)}</span>
                  <span data-testid={`skills-index-row-${skill.id}-filecount`}>
                    {skill.files.length} 个文件
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
