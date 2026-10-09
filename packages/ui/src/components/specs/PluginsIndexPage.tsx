import { Link } from "@tanstack/react-router";
import { SectionHeader } from "../ui/section-header.js";
import { ToolMark } from "../graphics/RuntimeMark.js";
import { usePlugins } from "../../hooks/usePlugins.js";

export function PluginsIndexPage() {
  const { data: plugins = [], isLoading } = usePlugins();
  const sorted = [...plugins].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div
      data-testid="plugins-index-page"
      className="mx-auto w-full max-w-[960px] px-6 py-8"
    >
      <header className="border-b border-outline-variant pb-4 mb-4">
        <SectionHeader tone="muted">资料库</SectionHeader>
        <div className="mt-1 flex items-baseline justify-between">
          <h1 className="font-headline text-headline-md font-bold tracking-tight uppercase text-on-surface">
            插件
          </h1>
          <span data-testid="plugins-index-count" className="font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant">
            {isLoading ? "加载中" : `${sorted.length} 个插件`}
          </span>
        </div>
      </header>

      {isLoading && sorted.length === 0 ? (
        <div data-testid="plugins-index-loading" className="font-mono text-[10px] uppercase tracking-[0.12em] text-on-surface-variant">
          正在加载插件…
        </div>
      ) : sorted.length === 0 ? (
        <div
          data-testid="plugins-index-empty"
          className="border border-outline-variant bg-surface-lowest/25 px-4 py-6 font-mono text-xs leading-relaxed text-on-surface"
        >
          <p className="font-bold uppercase tracking-wide text-on-surface">无可见插件</p>
          <p className="mt-2">
            插件从 Claude Code 的全局插件缓存、Codex 的插件缓存或 zrig 内置集
            （openrig-core 随后台服务发布）中发现。
          </p>
        </div>
      ) : (
        <ul data-testid="plugins-index-rows" className="border border-outline-variant bg-surface-lowest/25 hard-shadow divide-y divide-outline-variant">
          {sorted.map((plugin) => (
            <li key={plugin.id}>
              <Link
                to="/plugins/$pluginId"
                params={{ pluginId: plugin.id }}
                data-testid={`plugins-index-row-${plugin.id}`}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 font-mono text-left hover:bg-surface-low/60 focus:outline-none focus:bg-surface-low/80"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <ToolMark tool="plugin" title={`${plugin.name} 插件`} size="xs" decorative />
                  <span className="truncate text-xs font-bold text-on-surface">{plugin.name}</span>
                </span>
                <span className="flex shrink-0 items-center gap-3 font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">
                  <span data-testid={`plugins-index-row-${plugin.id}-version`}>v{plugin.version}</span>
                  <span data-testid={`plugins-index-row-${plugin.id}-runtimes`} className="flex gap-1">
                    {plugin.runtimes.map((rt) => (
                      <span key={rt} className="border border-outline-variant px-1.5 py-0.5">
                        {rt}
                      </span>
                    ))}
                  </span>
                  <span data-testid={`plugins-index-row-${plugin.id}-skillcount`}>
                    {plugin.skillCount} 个技能
                  </span>
                  <span data-testid={`plugins-index-row-${plugin.id}-source`}>
                    {plugin.sourceLabel}
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
