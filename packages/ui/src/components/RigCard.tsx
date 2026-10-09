import { useCountUp } from "../hooks/useCountUp.js";
import type { PsEntry } from "../hooks/usePsEntries.js";

export interface RigSummary {
  id: string;
  name: string;
  nodeCount: number;
  hasServices?: boolean;
  latestSnapshotAt: string | null;
  latestSnapshotId: string | null;
}

interface RigCardProps {
  rig: RigSummary;
  psEntry?: PsEntry;
  onSelect: (rigId: string) => void;
  onSnapshot: () => void;
  onExport: () => void;
  onDown: () => void;
}

function formatAge(timestamp: string | null): string {
  if (!timestamp) return "无";
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} 小时前`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay} 天前`;
}

export function RigCard({ rig, psEntry, onSelect, onSnapshot, onExport, onDown }: RigCardProps) {
  const animatedCount = useCountUp(rig.nodeCount);
  const isRunning = psEntry && psEntry.runningCount > 0;
  const statusLabel = isRunning ? "运行中" : "已停止";

  return (
    <div
      data-testid={`rig-card-${rig.id}`}
      className="bg-surface-lowest border border-on-surface hard-shadow mb-spacing-4 cursor-pointer hover:hard-shadow-hover transition-all relative"
      role="button"
      tabIndex={0}
      onClick={() => onSelect(rig.id)}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) { e.preventDefault(); onSelect(rig.id); } }}
    >
      {/* 深色头部条 */}
      <div className="bg-inverse-surface text-background px-4 py-1.5 font-mono text-[10px] flex justify-between items-center">
        <span>工作组：{rig.name.toUpperCase()}</span>
        <span className="material-symbols-outlined text-[12px]" style={{ fontVariationSettings: "'FILL' 0, 'wght' 300" }}>
          settings
        </span>
      </div>

      {/* 主体 */}
      <div className="p-4 space-y-3">
        {/* 名称 + 状态 */}
        <div className="flex justify-between items-end border-b border-outline-variant pb-2">
          <span className="font-headline font-bold text-lg tracking-tight uppercase">{rig.name}</span>
          <span className={`px-2 py-0.5 border font-mono text-[8px] uppercase ${
            isRunning ? "border-on-surface" : "border-outline text-on-surface-variant"
          }`}>
            {statusLabel}
          </span>
        </div>

        {/* 遥测网格 */}
        <div className="space-y-1">
          <div className="flex justify-between font-mono text-[9px] text-secondary">
            <span>节点</span>
            <span data-testid={`node-count-${rig.id}`}>{animatedCount}</span>
          </div>
          <div className="flex justify-between font-mono text-[9px] text-secondary">
            <span>快照</span>
            <span data-testid={`snapshot-age-${rig.id}`}>{formatAge(rig.latestSnapshotAt)}</span>
          </div>
          {psEntry && psEntry.uptime != null && (
            <div className="flex justify-between font-mono text-[9px] text-secondary">
              <span>运行时长</span>
              <span>{psEntry.uptime}</span>
            </div>
          )}
        </div>

        {/* 状态指示 */}
        {isRunning && (
          <div className="bg-success/10 border border-success/20 px-2 py-1 flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-success" />
            <span className="font-mono text-[9px] text-success font-bold">活动中</span>
          </div>
        )}

        {/* 操作按钮 */}
        <div className="flex gap-spacing-2 pt-1">
          <button
            className="px-2 py-0.5 border border-outline font-mono text-[9px] text-secondary hover:border-on-surface hover:text-on-surface transition-colors"
            onClick={(e) => { e.stopPropagation(); onSnapshot(); }}
          >
            快照
          </button>
          <button
            className="px-2 py-0.5 border border-outline font-mono text-[9px] text-secondary hover:border-on-surface hover:text-on-surface transition-colors"
            onClick={(e) => { e.stopPropagation(); onExport(); }}
          >
            导出
          </button>
          {isRunning && (
            <button
              className="px-2 py-0.5 border border-tertiary/30 font-mono text-[9px] text-tertiary hover:bg-tertiary hover:text-white transition-colors"
              onClick={(e) => { e.stopPropagation(); onDown(); }}
            >
              下线
            </button>
          )}
          <button
            className="px-2 py-0.5 bg-inverse-surface text-background font-mono text-[9px] hover:bg-inverse-surface transition-colors ml-auto"
            onClick={(e) => { e.stopPropagation(); onSelect(rig.id); }}
          >
            拓扑图 &rarr;
          </button>
        </div>
      </div>
    </div>
  );
}
