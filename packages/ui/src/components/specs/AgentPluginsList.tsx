// 第 3a 阶段 slice 3.3——AgentPluginsList 充实组件。
//
// 独立辅助组件：接收插件 ID 列表（来自 plugin-primitive-v0 分支 agent.yaml 的
// resources.plugins[].id 字段），并渲染包含以下信息的增强标签：
//   - 插件名称和版本
//   - 运行时支持徽标（Claude / Codex）
//   - 来源标签
//   - 指向 /plugins/:pluginId 的资料库查看链接
//
// slice 3.3 收尾时，此组件仍独立存在，尚未接入 AgentSpecDisplay，因为 plugin-primitive
// 任务的第 1 批在 plugin-primitive-v0 分支拥有该文件；按调度，slice 3.3 从 main 分出的
// plugin-primitive-3-3-ui 分支交付。
//
// 合并回 plugin-primitive-v0 时，第 1 批的 AgentSpecDisplay 插件区块会使用此组件。该区块当前
// 按其 ACK §2 将插件 ID 渲染为静态标签；接入后升级为带清单数据和资料库导航的增强标签。
// 接线只需用 `<AgentPluginsList pluginIds={profile.uses.plugins} />` 一行替换内联标签区块。

import { Link } from "@tanstack/react-router";
import { ToolMark } from "../graphics/RuntimeMark.js";
import { EmptyState } from "../ui/empty-state.js";
import { usePlugins, type PluginEntry } from "../../hooks/usePlugins.js";

interface AgentPluginsListProps {
  /** 来自智能体 resources.plugins[].id 的插件 ID，或来自 profile.uses.plugins[] 的已解析集合；
   * 由调用方选择。 */
  pluginIds: string[];
}

export function AgentPluginsList({ pluginIds }: AgentPluginsListProps) {
  const { data: discovered = [] } = usePlugins();

  if (pluginIds.length === 0) {
    return (
      <div className="px-3 py-4">
        <EmptyState
          label="无插件"
          description="此智能体的配置未声明任何插件。"
          variant="card"
          testId="agent-plugins-empty"
        />
      </div>
    );
  }

  const lookup = new Map<string, PluginEntry>();
  for (const entry of discovered) lookup.set(entry.id, entry);

  return (
    <ul
      data-testid="agent-plugins-list"
      className="flex flex-col gap-2"
    >
      {pluginIds.map((id) => {
        const entry = lookup.get(id);
        return (
          <li key={id}>
            {entry ? (
              <ResolvedChip entry={entry} />
            ) : (
              <UnresolvedChip pluginId={id} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ResolvedChip({ entry }: { entry: PluginEntry }) {
  return (
    <Link
      to="/plugins/$pluginId"
      params={{ pluginId: entry.id }}
      data-testid={`agent-plugin-chip-${entry.id}`}
      className="flex items-center justify-between gap-3 border border-outline-variant bg-surface-lowest/30 px-3 py-2 font-mono text-[11px] hover:bg-surface-low/50"
    >
      <span className="flex min-w-0 items-center gap-2">
        <ToolMark tool="skill" title={`${entry.name} 插件`} size="xs" decorative />
        <span className="truncate text-xs font-bold text-on-surface">{entry.name}</span>
        <span className="shrink-0 text-[9px] uppercase tracking-[0.08em] text-on-surface-variant">
          {`v${entry.version}`}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2 text-[9px] uppercase tracking-[0.08em] text-on-surface-variant">
        {entry.runtimes.map((rt) => (
          <span
            key={rt}
            className="inline-block border border-outline-variant px-1.5 py-0.5 font-mono"
          >
            {rt}
          </span>
        ))}
        <span title={entry.path}>{entry.sourceLabel}</span>
      </span>
    </Link>
  );
}

function UnresolvedChip({ pluginId }: { pluginId: string }) {
  return (
    <Link
      to="/plugins/$pluginId"
      params={{ pluginId }}
      data-testid={`agent-plugin-chip-${pluginId}`}
      className="flex items-center justify-between gap-3 border border-dashed border-outline-variant bg-surface-lowest/20 px-3 py-2 font-mono text-[11px] hover:bg-surface-low/50"
    >
      <span className="flex min-w-0 items-center gap-2">
        <ToolMark tool="skill" title={`${pluginId} 插件（未解析）`} size="xs" decorative />
        <span className="truncate text-xs font-bold text-on-surface">{pluginId}</span>
      </span>
      <span
        data-testid={`agent-plugin-unresolved-${pluginId}`}
        className="shrink-0 text-[9px] uppercase tracking-[0.08em] text-on-surface-variant"
      >
        未发现
      </span>
    </Link>
  );
}
