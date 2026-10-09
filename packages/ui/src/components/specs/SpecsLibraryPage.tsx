import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { SectionHeader } from "../ui/section-header.js";
import { EmptyState } from "../ui/empty-state.js";
import { useSpecLibrary, type SpecLibraryEntry } from "../../hooks/useSpecLibrary.js";
import { useContextPackLibrary, type ContextPackEntry } from "../../hooks/useContextPackLibrary.js";
import { useAgentImageLibrary, type AgentImageEntry } from "../../hooks/useAgentImageLibrary.js";
import { useLibrarySkills, type LibrarySkillEntry } from "../../hooks/useLibrarySkills.js";
import { librarySkillHref } from "../../lib/library-skills-routing.js";
import { ToolMark } from "../graphics/RuntimeMark.js";
// 第 3a 阶段 slice 3.3——插件资料库类别。
import { usePlugins, type PluginEntry } from "../../hooks/usePlugins.js";

const TOOLBAR_ACTIONS = [
  { label: "+ 添加规格", to: "/specs/rig", testId: "specs-toolbar-add" },
  { label: "导入", to: "/import", testId: "specs-toolbar-import" },
  { label: "发现", to: "/search", testId: "specs-toolbar-discover" },
  { label: "创建工作组", to: "/specs/rig", testId: "specs-toolbar-create-rig" },
  { label: "生成工作流", to: "/specs/agent", testId: "specs-toolbar-gen-workflow" },
] as const;

interface LibraryRow {
  id: string;
  label: string;
  meta?: string;
  entryId?: string;
  /** Slice 11——workflows 目录中不可解析 YAML 的诊断状态。"error" 行不可导航，并行内显示
   * 解析器/校验器消息，让操作人员可就地修复文件。 */
  status?: "valid" | "error";
}

function specRow(entry: SpecLibraryEntry): LibraryRow {
  if (entry.status === "error") {
    // 诊断行没有 entryId，因此不可导航；meta 携带解析/校验原因，供操作人员行内查看。
    return {
      id: entry.id,
      label: entry.name,
      meta: entry.errorMessage ?? "无效的工作流 YAML",
      status: "error",
    };
  }
  return {
    id: entry.id,
    label: entry.name,
    entryId: entry.id,
  };
}

function contextPackRow(entry: ContextPackEntry): LibraryRow {
  return {
    id: entry.id,
    label: entry.name,
    entryId: entry.id,
  };
}

function agentImageRow(entry: AgentImageEntry): LibraryRow {
  const parts: string[] = [`v${entry.version}`];
  if (entry.derivedEstimatedTokens > 0) parts.push(`约 ${entry.derivedEstimatedTokens} token`);
  if (entry.stats.forkCount > 0) parts.push(`分叉：${entry.stats.forkCount}`);
  if (entry.stats.lastUsedAt) parts.push(`最近使用：${formatRelativeAge(entry.stats.lastUsedAt)}`);
  return {
    id: entry.id,
    label: entry.name,
    meta: parts.join(" · "),
    entryId: entry.id,
  };
}

function formatRelativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "刚刚";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} 小时前`;
  const days = Math.floor(hrs / 24);
  return `${days} 天前`;
}

function LibrarySection({
  id,
  title,
  rows,
  isLoading,
  emptyLabel,
  badge,
}: {
  id: string;
  title: string;
  rows: LibraryRow[];
  isLoading?: boolean;
  emptyLabel?: string;
  /** 可选的聚合徽标，显示在标题右侧槽位并替代默认项目数，例如 agent-images 的
   *“3 个镜像 · 128 MB”。 */
  badge?: string;
}) {
  return (
    <section data-testid={`library-section-${id}`} className="border border-outline-variant bg-surface-lowest/25 hard-shadow">
      <header className="flex items-baseline justify-between border-b border-outline-variant bg-surface-lowest/30 px-3 py-2">
        <SectionHeader tone="default">{title}</SectionHeader>
        <span
          data-testid={`library-section-${id}-badge`}
          className="shrink-0 font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant"
        >
          {isLoading ? "加载中" : badge ?? `${rows.length} 项`}
        </span>
      </header>
      {rows.length > 0 ? (
        <ul className="divide-y divide-outline-variant">
          {rows.map((row) => (
            <li key={row.id}>
              {row.entryId ? (
                <Link
                  to="/specs/library/$entryId"
                  params={{ entryId: row.entryId }}
                  data-testid={`library-row-${id}-${row.id}`}
                  className="block px-3 py-2 hover:bg-surface-low/50"
                >
                  <LibraryRowContent row={row} />
                </Link>
              ) : (
                <div
                  data-testid={`library-row-${id}-${row.id}`}
                  data-status={row.status}
                  className={`px-3 py-2 ${row.status === "error" ? "bg-red-50/40 text-red-900" : ""}`}
                >
                  <LibraryRowContent row={row} />
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="px-3 py-4 font-mono text-[10px] text-on-surface-variant">
          {isLoading ? "加载中…" : emptyLabel ?? "暂无条目。"}
        </div>
      )}
    </section>
  );
}

/** 智能体镜像聚合徽标所用的紧凑人类可读字节大小。 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${i === 0 ? value : value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function LibraryRowContent({ row }: { row: LibraryRow }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 font-mono">
      <span className="truncate text-xs font-bold text-on-surface">{row.label}</span>
      {row.meta ? (
        <span className="shrink-0 text-[9px] uppercase tracking-[0.08em] text-on-surface-variant">
          {row.meta}
        </span>
      ) : null}
    </div>
  );
}

// 第 3a 阶段 slice 3.3——插件资料库区段。
//
// 镜像 SkillsSection 的外观（边框、硬阴影、带数量的标题），每个已发现插件渲染一行，
// 显示名称、版本、运行时支持徽标（Claude/Codex）和来源标签。每行链接到
// /plugins/:id 的插件详情查看器。
function PluginsSection({
  plugins,
  isLoading,
}: {
  plugins: PluginEntry[];
  isLoading: boolean;
}) {
  return (
    <section
      id="library-plugins"
      data-testid="library-section-plugins"
      className="border border-outline-variant bg-surface-lowest/25 hard-shadow"
    >
      <header className="flex items-baseline justify-between border-b border-outline-variant bg-surface-lowest/30 px-3 py-2">
        <SectionHeader tone="default">插件</SectionHeader>
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">
          {isLoading ? "加载中" : `${plugins.length} 个插件`}
        </span>
      </header>
      {plugins.length === 0 ? (
        <div className="px-3 py-4">
          <EmptyState
            label={isLoading ? "加载中" : "未发现插件"}
            description={isLoading
              ? "正在加载插件…"
              : "安装一个 Claude Code 或 Codex 插件（或等待 openrig-core 内置）后，它会出现在这里。"}
            variant="card"
            testId="library-plugins-empty"
          />
        </div>
      ) : (
        <ul className="divide-y divide-outline-variant">
          {plugins.map((plugin) => (
            <li key={plugin.id}>
              <Link
                to="/plugins/$pluginId"
                params={{ pluginId: plugin.id }}
                data-testid={`library-plugin-${plugin.id}`}
                className="flex items-center gap-3 px-3 py-2 font-mono hover:bg-surface-low/50"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ToolMark tool="skill" title={`${plugin.name} plugin`} size="xs" decorative />
                  <span className="truncate text-xs font-bold text-on-surface">{plugin.name}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SkillsSection({
  skills,
  isLoading,
}: {
  skills: LibrarySkillEntry[];
  isLoading: boolean;
}) {
  return (
    <section
      id="library-skills"
      data-testid="library-section-skills"
      className="border border-outline-variant bg-surface-lowest/25 hard-shadow"
    >
      <header className="flex items-baseline justify-between border-b border-outline-variant bg-surface-lowest/30 px-3 py-2">
        <SectionHeader tone="default">技能</SectionHeader>
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">
          {isLoading ? "加载中" : `${skills.length} 个文件夹`}
        </span>
      </header>
      {skills.length === 0 ? (
        <div className="px-3 py-4">
          <EmptyState
            label={isLoading ? "加载中" : "未找到技能"}
            description={isLoading
              ? "正在加载技能文件夹…"
              : "当前配置的文件根下看不到任何 .openrig/skills 或打包的 zrig 技能文件夹。"}
            variant="card"
            testId="library-skills-empty"
          />
        </div>
      ) : (
        <ul className="divide-y divide-outline-variant">
          {skills.map((skill) => (
            <li key={skill.id}>
              <a
                href={librarySkillHref(skill.id)}
                data-testid={`library-skill-${skill.name}`}
                className="flex items-center justify-between gap-3 px-3 py-2 font-mono hover:bg-surface-low/50"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ToolMark tool="skill" title={`${skill.name} skill`} size="xs" decorative />
                  <span className="truncate text-xs font-bold text-on-surface">{skill.name}</span>
                </span>
                <span className="shrink-0 text-[9px] uppercase tracking-[0.08em] text-on-surface-variant">
                  {skill.files.length} 个文件
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function SpecsLibraryPage() {
  const { data: specs = [], isLoading: specsLoading } = useSpecLibrary();
  const { data: contextPacks = [], isLoading: contextPacksLoading } = useContextPackLibrary();
  const { data: agentImages = [], isLoading: agentImagesLoading } = useAgentImageLibrary();
  const { data: skills = [], isLoading: skillsLoading } = useLibrarySkills();
  // 第 3a 阶段 slice 3.3——插件类别。
  const { data: plugins = [], isLoading: pluginsLoading } = usePlugins();

  const sections = useMemo(() => {
    const rigSpecs = specs.filter((entry) => entry.kind === "rig" && !entry.hasServices).map(specRow);
    const workflowSpecs = specs.filter((entry) => entry.kind === "workflow").map(specRow);
    const agentSpecs = specs.filter((entry) => entry.kind === "agent").map(specRow);
    const applications = specs.filter((entry) => entry.kind === "rig" && entry.hasServices).map(specRow);
    return { rigSpecs, workflowSpecs, agentSpecs, applications };
  }, [specs]);

  // OPR.0.4.3.05——基于已在范围内的资料库数组生成智能体镜像聚合状态徽标，显示数量和
  // 估算总大小。渲染到现有智能体镜像区段标题中；不新增数据接线，也不虚构引导面板。
  const agentImageBadge = useMemo(() => {
    const count = agentImages.length;
    const totalBytes = agentImages.reduce((sum, e) => sum + (e.stats?.estimatedSizeBytes ?? 0), 0);
    return `${count} ${count === 1 ? "个镜像" : "个镜像"} · ${formatBytes(totalBytes)}`;
  }, [agentImages]);

  const total =
    sections.rigSpecs.length
    + sections.workflowSpecs.length
    + sections.agentSpecs.length
    + sections.applications.length
    + contextPacks.length
    + agentImages.length
    + skills.length;

  return (
    <div
      data-testid="specs-library-page"
      className="h-full overflow-y-auto bg-paper-grid px-6 py-5 lg:pl-[var(--workspace-left-offset,0px)] lg:pr-[var(--workspace-right-offset,0px)]"
    >
      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <SectionHeader tone="muted">库</SectionHeader>
          <h1 className="mt-1 font-headline text-2xl font-bold tracking-tight text-on-surface">
            库
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-on-surface-variant">
            规格、上下文包、智能体镜像、应用与技能文件夹。
          </p>
        </div>
        <nav
          aria-label="库操作"
          className="flex flex-wrap justify-end gap-2"
        >
          {TOOLBAR_ACTIONS.map((a) => (
            <Link
              key={a.testId}
              to={a.to}
              data-testid={a.testId}
              className="border border-outline-variant bg-surface-lowest/25 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface hard-shadow hover:bg-surface-lowest/40"
            >
              {a.label}
            </Link>
          ))}
        </nav>
      </header>

      <div className="mb-4 font-mono text-[10px] uppercase tracking-[0.14em] text-on-surface-variant">
        {total} 个库条目通过当前来源可见
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <LibrarySection
          id="rig-specs"
          title="工作组规格"
          rows={sections.rigSpecs}
          isLoading={specsLoading}
          emptyLabel="未找到工作组规格。"
        />
        <LibrarySection
          id="workspace-specs"
          title="工作区规格"
          rows={[]}
          emptyLabel="工作区规格来源尚未接入。"
        />
        <LibrarySection
          id="workflow-specs"
          title="工作流规格"
          rows={sections.workflowSpecs}
          isLoading={specsLoading}
          emptyLabel="未找到工作流规格。"
        />
        <LibrarySection
          id="context-packs"
          title="上下文包"
          rows={contextPacks.map(contextPackRow)}
          isLoading={contextPacksLoading}
          emptyLabel="未找到上下文包。"
        />
        <LibrarySection
          id="agent-specs"
          title="智能体规格"
          rows={sections.agentSpecs}
          isLoading={specsLoading}
          emptyLabel="未找到智能体规格。"
        />
        <LibrarySection
          id="agent-images"
          title="智能体镜像"
          rows={agentImages.map(agentImageRow)}
          isLoading={agentImagesLoading}
          emptyLabel="未找到智能体镜像。"
          badge={agentImageBadge}
        />
        <LibrarySection
          id="applications"
          title="应用"
          rows={sections.applications}
          isLoading={specsLoading}
          emptyLabel="未找到应用规格。"
        />
      </div>

      <div className="mt-4 space-y-4">
        {/* Phase 3a slice 3.3 — Plugins category sits between the spec
            grid and the Skills folder roundup; both are wide single-
            column sections rather than grid columns because their row
            count varies more dramatically than the spec categories. */}
        <PluginsSection plugins={plugins} isLoading={pluginsLoading} />
        <SkillsSection skills={skills} isLoading={skillsLoading} />
      </div>
    </div>
  );
}
