// 预览终端 v0（PL-018）——单席位实时终端预览面板。
//
// 通过 /api/.../preview 渲染该席位最近 N 行，按操作者配置的间隔自动刷新。
// 含固定/取消固定按钮，以及当后台服务没有该路由或会话未绑定时的诚实
// “预览不可用”兜底。

import { useNodePreview, isNodePreviewUnavailable } from "../../hooks/useNodePreview.js";
import { usePreviewPins } from "./usePreviewPins.js";

interface PreviewPaneProps {
  rigId: string;
  rigName?: string;
  logicalId: string;
  /** 可选：覆盖设置中的行数。 */
  lines?: number;
  /** 暂停轮询——父级折叠/隐藏时有用。 */
  paused?: boolean;
  /** 不显示固定按钮（例如展示在已固定堆叠内部时）。 */
  hidePinButton?: boolean;
  /** 设置后，预览收缩为紧凑密度。 */
  compact?: boolean;
  testIdPrefix?: string;
}

export function PreviewPane({
  rigId,
  rigName,
  logicalId,
  lines,
  paused,
  hidePinButton,
  compact,
  testIdPrefix = "preview",
}: PreviewPaneProps) {
  const preview = useNodePreview({ rigId, logicalId, lines, paused });
  const { isPinned, pin, unpin } = usePreviewPins();

  const pinned = isPinned(rigId, logicalId);
  const onTogglePin = () => {
    if (pinned) {
      unpin(rigId, logicalId);
    } else {
      const sessionName = !isNodePreviewUnavailable(preview.data) ? preview.data?.sessionName ?? "" : "";
      pin({ rigId, rigName: rigName ?? rigId, logicalId, sessionName });
    }
  };

  const heightClass = compact ? "max-h-32" : "max-h-64";

  return (
    <div
      data-testid={`${testIdPrefix}-pane`}
      data-rig-id={rigId}
      data-logical-id={logicalId}
      data-paused={paused ? "true" : "false"}
      className="border border-outline-variant/40 bg-surface-lowest/[0.08] px-3 py-2 space-y-1"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[9px] uppercase tracking-[0.10em] text-on-surface-variant truncate">
          实时预览 · {logicalId}
        </span>
        {!hidePinButton && (
          <button
            type="button"
            data-testid={`${testIdPrefix}-pin-toggle`}
            data-pinned={pinned ? "true" : "false"}
            onClick={onTogglePin}
            className="font-mono text-[8px] uppercase border border-outline-variant px-1 py-0.5 hover:bg-surface-high shrink-0"
          >
            {pinned ? "取消固定" : "固定"}
          </button>
        )}
      </div>

      {preview.isLoading && (
        <div data-testid={`${testIdPrefix}-loading`} className="font-mono text-[9px] text-on-surface-variant">正在加载…</div>
      )}
      {preview.isError && (
        <div data-testid={`${testIdPrefix}-error`} className="font-mono text-[9px] text-red-600">
          {(preview.error as Error)?.message ?? "预览失败。"}
        </div>
      )}
      {isNodePreviewUnavailable(preview.data) && (
        <div data-testid={`${testIdPrefix}-unavailable`} className="font-mono text-[9px] text-on-surface-variant space-y-0.5">
          <div>预览不可用：{preview.data.reason}。</div>
          {preview.data.hint && <div className="text-on-surface-variant">{preview.data.hint}</div>}
          <div className="text-on-surface-variant">可在终端用 <code>zrig capture {logicalId}</code> 作为回退。</div>
        </div>
      )}
      {!isNodePreviewUnavailable(preview.data) && preview.data && (
        <>
          <pre
            data-testid={`${testIdPrefix}-content`}
            className={`font-mono text-[9px] text-on-surface bg-background px-2 py-1 ${heightClass} overflow-y-auto whitespace-pre-wrap break-all`}
          >
            {preview.data.content || "（空面板）"}
          </pre>
          <div className="font-mono text-[8px] text-on-surface-variant flex justify-between">
            <span>捕获于 {new Date(preview.data.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <span>{preview.data.lines} 行</span>
          </div>
        </>
      )}
    </div>
  );
}
