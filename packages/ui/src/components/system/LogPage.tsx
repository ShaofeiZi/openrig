// 切片 26 —— 日志目标页面（路由驱动）。
//
// 将原本内联在 SettingsCenter 标签页中的 LogPanel 内容提升为独立页面。
// 现在通过自身路由挂载到 /settings/log。

import { SettingsPageShell } from "./SettingsPageShell.js";
import { EmptyState } from "../ui/empty-state.js";
import { useActivityFeed } from "../../hooks/useActivityFeed.js";
import { formatEventPayload } from "../../lib/format-event-payload.js";

export function LogPage() {
  const { events } = useActivityFeed();
  return (
    <SettingsPageShell testId="settings-page-log" title="日志">
      {events.length === 0 ? (
        <EmptyState
          label="日志安静"
          description="来自工作组的活动事件将在此流式显示。"
          variant="card"
          testId="settings-log-empty"
        />
      ) : (
        <ul
          data-testid="settings-log-stream"
          className="divide-y divide-outline-variant border border-outline-variant max-h-[60vh] overflow-y-auto"
        >
          {events.slice(0, 100).map((evt) => (
            <li
              key={evt.seq}
              className="px-3 py-2 flex items-baseline gap-3 font-mono text-xs"
            >
              <span className="text-on-surface-variant text-[10px] uppercase tracking-wide w-32 shrink-0 truncate">
                {evt.type}
              </span>
              <span className="text-on-surface truncate" title={formatEventPayload(evt.payload)}>
                {formatEventPayload(evt.payload)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SettingsPageShell>
  );
}
