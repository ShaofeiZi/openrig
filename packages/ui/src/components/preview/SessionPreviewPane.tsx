// 预览终端 v0（PL-018）—— 会话键控预览窗格。
//
// 与 PreviewPane 形状相同，但按 sessionName 寻址。被持有 sessionName
// 但没有 (rigId, logicalId) 对的表面使用——Steering Loop 状态面板、
// 切片故事视图拓扑标签页。
//
// v0 阶段话键控变体无固定按钮：固定属于拓扑抽屉流程，操作者可在其中
// 导航到节点详情上下文。操作者内部试用报告需要从 Loop 状态/拓扑标签页
// 固定 → 触发 NAMED v0+1。

import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { useSessionPreview, isNodePreviewUnavailable } from "../../hooks/useNodePreview.js";
import { cn } from "../../lib/utils.js";
import {
  LIVE_TERMINAL_COLS,
  LIVE_TERMINAL_FONT_FAMILY,
  LIVE_TERMINAL_FONT_SIZE,
  LIVE_TERMINAL_LINE_HEIGHT,
} from "../terminal/terminal-geometry.js";

// OPR.0.4.0.39：紧凑静态终端精确镜像 LIVE xterm 几何（同字号 + 90 列宽），
// 使静态和实时在共享 ScaleToFitTerminal 缩放下形状相同——仅玻璃态（静态）
// 与不透明（实时）不同。宽度固定 90ch（实时 90 列网格），因此无论捕获行多短，
// 框宽始终为终端宽度——就像真正的 90 列终端。
const STATIC_TERMINAL_GEOMETRY: CSSProperties = {
  fontFamily: LIVE_TERMINAL_FONT_FAMILY,
  fontSize: `${LIVE_TERMINAL_FONT_SIZE}px`,
  lineHeight: LIVE_TERMINAL_LINE_HEIGHT,
  width: `${LIVE_TERMINAL_COLS}ch`,
};

interface SessionPreviewPaneProps {
  sessionName: string;
  lines?: number;
  paused?: boolean;
  testIdPrefix?: string;
  variant?: "default" | "compact-terminal";
}

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 4;
}

export function SessionPreviewPane({
  sessionName,
  lines,
  paused,
  testIdPrefix = "session-preview",
  variant = "default",
}: SessionPreviewPaneProps) {
  const preview = useSessionPreview({ sessionName, lines, paused });
  const contentRef = useRef<HTMLPreElement | null>(null);
  const shouldFollowTailRef = useRef(true);
  const content = !isNodePreviewUnavailable(preview.data) ? preview.data?.content : undefined;
  const compactTerminal = variant === "compact-terminal";

  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el || !preview.data || isNodePreviewUnavailable(preview.data)) return;
    if (shouldFollowTailRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [content, preview.data]);

  const handleScroll = () => {
    const el = contentRef.current;
    if (!el) return;
    shouldFollowTailRef.current = isNearBottom(el);
  };

  return (
    <div
      data-testid={`${testIdPrefix}-pane`}
      data-session-name={sessionName}
      data-variant={variant}
      className={cn(
        "space-y-1",
        // OPR.0.4.0.39 FR-1（创始者规格修正）：紧凑静态内容是
        // 半透明烟熏玻璃——它让调用者的 SMOKED_STATIC_PLATE_CLASS
        //（bg-stone-950/85 backdrop-blur）透过来（bg-transparent），而非不透明。
        // 静态 <pre> 不是 xterm，因此没有光标安全理由要不透明；
        // 不透明 #0c0a09 仅用于 LIVE xterm，点击转实时时玻璃→不透明的翻转
        // 是有意的静态-vs-实时激活控件。
        compactTerminal
          ? "border-0 bg-transparent p-0 text-stone-50"
          : "border border-outline-variant/40 bg-surface-lowest/[0.08] px-3 py-2",
      )}
    >
      {!compactTerminal && (
        <div className="font-mono text-[9px] uppercase tracking-[0.10em] text-on-surface-variant truncate">
          实时预览 · {sessionName}
        </div>
      )}
      {preview.isLoading && (
        <div data-testid={`${testIdPrefix}-loading`} className="font-mono text-[9px] text-on-surface-variant">加载中…</div>
      )}
      {preview.isError && (
        <div
          data-testid={`${testIdPrefix}-error`}
          className={cn("font-mono text-[9px]", compactTerminal ? "text-red-200" : "text-red-600")}
        >
          {(preview.error as Error)?.message ?? "预览失败。"}
        </div>
      )}
      {isNodePreviewUnavailable(preview.data) && (
        <div
          data-testid={`${testIdPrefix}-unavailable`}
          className={cn(
            "font-mono space-y-0.5",
            compactTerminal ? "text-[10px] text-stone-50" : "text-[9px] text-on-surface-variant",
          )}
        >
          {compactTerminal ? (
            <>
              <div>预览不可用。</div>
              <div className="text-stone-400">$ 等待终端输出</div>
            </>
          ) : (
            <>
              <div>预览不可用：{preview.data.reason}.</div>
              {preview.data.hint && (
                <div className="text-on-surface-variant">{preview.data.hint}</div>
              )}
              <div className="text-on-surface-variant">
                可在终端使用 <code>zrig capture {sessionName}</code> 作为回退。
              </div>
            </>
          )}
        </div>
      )}
      {!isNodePreviewUnavailable(preview.data) && preview.data && (
        <>
          <pre
            ref={contentRef}
            data-testid={`${testIdPrefix}-content`}
            onScroll={handleScroll}
            style={compactTerminal ? STATIC_TERMINAL_GEOMETRY : undefined}
            className={cn(
              "font-mono",
              // OPR.0.4.0.39 FR-1/FR-4/FR-5（创始者规格）：紧凑静态以
              // LIVE xterm 几何渲染（STATIC_TERMINAL_GEOMETRY：同字号、固定
              // 90 列宽），使静态和实时形状相同——共享 ScaleToFitTerminal
              // 将整个固定块缩放到列宽（fit-width，不裁剪；无 overflow-x
              // 平移/截断）。whitespace-pre 按原样渲染捕获行
              //（不重换行 = 正确行返回；FR-5）。bg-transparent = 烟熏玻璃
              // 板透过来（FR-2）；不透明 #0c0a09 仅用于 LIVE xterm——
              // 玻璃→不透明翻转是激活控件。
              compactTerminal
                ? "scrollbar-none max-h-[420px] overflow-y-auto whitespace-pre bg-transparent text-stone-50"
                : "max-h-32 overflow-y-auto whitespace-pre-wrap break-all bg-background px-2 py-1 text-[9px] text-on-surface",
            )}
          >
            {preview.data.content || "（空窗格）"}
          </pre>
          {!compactTerminal && (
            <div className="font-mono text-[8px] text-on-surface-variant flex justify-between">
              <span>
                捕获{" "}
                {new Date(preview.data.capturedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
              <span>{preview.data.lines} 行</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
