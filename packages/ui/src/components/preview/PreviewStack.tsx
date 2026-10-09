// 预览终端 v0（PL-018）——堆叠的已固定预览面板。
//
// 渲染当前所有已固定的预览面板。与既有的拓扑 + slice 界面组合——操作者从
// 节点详情抽屉 / loop-state 行 / 拓扑标签页固定，本堆叠把它们全局铺在一条
// 始终可见的侧栏里。

import { PreviewPane } from "./PreviewPane.js";
import { usePreviewPins } from "./usePreviewPins.js";

export function PreviewStack({ testIdPrefix = "preview-stack" }: { testIdPrefix?: string }) {
  const { pins } = usePreviewPins();

  if (pins.length === 0) return null;

  return (
    <aside
      data-testid={testIdPrefix}
      className="absolute inset-y-0 right-0 z-10 w-72 border-l border-outline-variant/25 bg-[hsl(var(--background)/0.04)] supports-[backdrop-filter]:bg-[hsl(var(--background)/0.02)] backdrop-blur-[12px] shadow-[-6px_0_14px_rgba(46,52,46,0.04)] flex flex-col overflow-y-auto pointer-events-auto"
    >
      <header className="px-3 py-2 border-b border-outline-variant/35 shrink-0">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-on-surface">
          已固定的预览
        </span>
        <span className="ml-2 font-mono text-[9px] text-on-surface-variant">
          已固定 {pins.length} 个
        </span>
      </header>
      <div className="flex-1 px-2 py-2 space-y-2">
        {pins.map((p) => (
          <PreviewPane
            key={`${p.rigId}:${p.logicalId}`}
            rigId={p.rigId}
            rigName={p.rigName}
            logicalId={p.logicalId}
            compact
            testIdPrefix={`pinned-preview-${p.logicalId}`}
          />
        ))}
      </div>
    </aside>
  );
}
