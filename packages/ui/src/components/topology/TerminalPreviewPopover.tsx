import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import { createPortal } from "react-dom";
import { FocusedTerminal } from "../terminal/FocusedTerminal.js";
import { ProgressiveTerminal } from "../terminal/ProgressiveTerminal.js";
import {
  LIVE_TERMINAL_COLS,
  LIVE_TERMINAL_FONT_FAMILY,
  LIVE_TERMINAL_FONT_SIZE,
} from "../terminal/terminal-geometry.js";
import { cn } from "../../lib/utils.js";
import { ToolMark } from "../graphics/RuntimeMark.js";

const TERMINAL_PREVIEW_EVENT = "openrig:topology-terminal-preview";
const POPOVER_GAP = 8;
const POPOVER_MARGIN = 8;
const FALLBACK_POPOVER_WIDTH = 408;
const FALLBACK_POPOVER_HEIGHT = 240;

interface TerminalPreviewEventDetail {
  key: string;
}

interface AnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface PopoverPosition {
  left: number;
  top: number;
}

interface ViewportSize {
  width: number;
  height: number;
}

interface TerminalPreviewPopoverProps {
  rigId: string | null | undefined;
  logicalId: string;
  sessionName: string | null | undefined;
  reducedMotion?: boolean;
  wrapperClassName?: string;
  buttonClassName?: string;
  popoverClassName?: string;
  testIdPrefix: string;
  /** V0.3.1 slice 14 前向修复 #1（无障碍）：为 false 时，popover 不渲染自己的触发按钮。
   *  由外部持有触发器的界面使用（例如 TerminalView 卡片，整卡即触发器），
   *  使 popover 不新增一个重复的键盘 tab 停靠点。默认 true 保留既有的
   *  graph-view + table-view 按钮渲染。 */
  renderTrigger?: boolean;
  /** OPR.0.4.0.1：为 true 时，popover 渲染渐进式的“默认静态 → 点击转实时”
   *  ProgressiveTerminal（拓扑 graph/table 界面）。默认 false 保持始终实时的
   *  FocusedTerminal，保留 feed-card 的实时钻取（不在本 slice 的 3 界面范围内）。 */
  progressive?: boolean;
}

function rectFromElement(el: HTMLElement | null): AnchorRect {
  const rect = el?.getBoundingClientRect();
  return {
    left: rect?.left ?? POPOVER_MARGIN,
    right: rect?.right ?? POPOVER_MARGIN,
    top: rect?.top ?? POPOVER_MARGIN,
    bottom: rect?.bottom ?? POPOVER_MARGIN,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function computeTerminalPopoverPosition(
  anchor: AnchorRect,
  width: number,
  height: number,
  viewport?: ViewportSize,
): PopoverPosition {
  const viewportWidth = viewport?.width ?? (typeof window === "undefined" ? width + POPOVER_MARGIN * 2 : window.innerWidth);
  const viewportHeight = viewport?.height ?? (typeof window === "undefined" ? height + POPOVER_MARGIN * 2 : window.innerHeight);
  const rightSideLeft = anchor.right + POPOVER_GAP;
  const leftSideLeft = anchor.left - width - POPOVER_GAP;
  const left = rightSideLeft + width <= viewportWidth - POPOVER_MARGIN ? rightSideLeft : leftSideLeft;
  const preferredTop = anchor.top;
  const aboveTop = anchor.top - height - POPOVER_GAP;
  const top = preferredTop + height <= viewportHeight - POPOVER_MARGIN
    ? preferredTop
    : aboveTop >= POPOVER_MARGIN
      ? aboveTop
      : viewportHeight - height - POPOVER_MARGIN;
  return {
    left: clamp(left, POPOVER_MARGIN, Math.max(POPOVER_MARGIN, viewportWidth - width - POPOVER_MARGIN)),
    top: clamp(top, POPOVER_MARGIN, Math.max(POPOVER_MARGIN, viewportHeight - height - POPOVER_MARGIN)),
  };
}

export function TerminalPreviewPopover({
  rigId,
  logicalId,
  sessionName,
  reducedMotion,
  wrapperClassName,
  buttonClassName,
  popoverClassName,
  testIdPrefix,
  renderTrigger = true,
  progressive = false,
}: TerminalPreviewPopoverProps) {
  const key = `${rigId ?? "unknown"}:${logicalId}`;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  // OPR.0.4.0.39（创始人规格）：静态与实时是同一个 90x27 镜像（同尺寸、同位置），
  // 经 ProgressiveTerminal -> ScaleToFitTerminal，因此 popover 在转实时时不再变形。
  // 旧的 compact-static -> wide-live 长大就是创始人指出的“形状不同、位置不同”；
  // 现在外壳对两种状态都保持全终端宽度，静态只是原地从玻璃态翻成不透明（对齐网格）。

  const updatePosition = useCallback(() => {
    if (!open) return;
    const nextAnchor = rectFromElement(rootRef.current);
    const width = popoverRef.current?.offsetWidth || FALLBACK_POPOVER_WIDTH;
    const height = popoverRef.current?.offsetHeight || FALLBACK_POPOVER_HEIGHT;
    setPosition(computeTerminalPopoverPosition(nextAnchor, width, height));
  }, [open]);

  useEffect(() => {
    // OPR.0.4.0.1（rev1-r2 修复）：渐进式 popover 经本地状态打开，
    // 并在全局 LiveTerminalRegistry 上限下共存，因此它们不参与单开的
    // TERMINAL_PREVIEW_EVENT——后者会强制关闭每个兄弟 popover，把 popover 界面
    // 限制为一个实时终端。只有非渐进的 feed-card 钻取保持一次一个覆盖层的单开行为。
    if (progressive) return undefined;
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<TerminalPreviewEventDetail>).detail;
      const nextOpen = detail?.key === key;
      setOpen(nextOpen);
      if (nextOpen) {
        const nextAnchor = rectFromElement(rootRef.current);
        setPosition(computeTerminalPopoverPosition(nextAnchor, FALLBACK_POPOVER_WIDTH, FALLBACK_POPOVER_HEIGHT));
      }
    };
    window.addEventListener(TERMINAL_PREVIEW_EVENT, handleOpen);
    return () => window.removeEventListener(TERMINAL_PREVIEW_EVENT, handleOpen);
  }, [key, progressive]);

  useLayoutEffect(() => {
    if (!open || !popoverRef.current) return;
    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    return () => window.cancelAnimationFrame(frame);
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return undefined;
    const handleViewportChange = () => updatePosition();
    const observer = typeof ResizeObserver === "undefined" || !popoverRef.current
      ? null
      : new ResizeObserver(handleViewportChange);
    if (popoverRef.current) observer?.observe(popoverRef.current);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      // OPR.0.4.0.1（rev1-r2 修复）：当 pointerdown 落在任一终端预览界面内（兄弟 popover
      // 或触发器）时，渐进式 popover 不得关闭——否则与 B 交互会关掉 A，破坏多实时。
      // 只有完全点在终端预览系统之外才关闭它。
      if (progressive) {
        const el = target instanceof Element ? target : target.parentElement;
        if (el?.closest("[data-terminal-preview-surface]")) return;
      }
      setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  if (!sessionName) return null;

  const openPreview = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (progressive) {
      // 切换本 popover 自己的开合状态；不动兄弟——在全局上限下多个渐进 popover 可同时打开/实时。
      if (open) {
        setOpen(false);
        return;
      }
      const nextAnchor = rectFromElement(rootRef.current);
      setPosition(computeTerminalPopoverPosition(nextAnchor, FALLBACK_POPOVER_WIDTH, FALLBACK_POPOVER_HEIGHT));
      setOpen(true);
      return;
    }
    window.dispatchEvent(new CustomEvent<TerminalPreviewEventDetail>(TERMINAL_PREVIEW_EVENT, { detail: { key } }));
  };

  const popover = open && position ? createPortal(
    <div
      ref={popoverRef}
      data-testid={`${testIdPrefix}-terminal-popover`}
      data-terminal-preview-surface=""
      data-reduced-motion={reducedMotion ? "true" : "false"}
      className={cn(
        // OPR.0.4.0.1（FR-4 去重）：终端外壳/静态板承载烟熏玻璃表面，而 xterm 渲染器本身保持不透明，
        // 以保证擦除/重绘可靠。popover 去掉多余背景，使外壳成为唯一的终端板。
        "nodrag nopan fixed z-[1000] max-h-[calc(100vh-1rem)] max-w-[calc(100vw-1rem)] overflow-hidden p-1.5 backdrop-blur-sm",
        // OPR.0.4.0.39：静态 + 实时两种状态外壳都按终端尺寸（w-max）——转实时不变形，不留空宽度。
        // 内层是规范几何宽度，使外壳自动跟踪列数。
        "w-max",
        "cursor-default select-text font-mono text-[8px] text-stone-50",
        popoverClassName,
      )}
      style={{ left: position.left, top: position.top }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {/* OPR.0.4.0.39：popover 对静态和实时两种状态都保持全 90 列终端宽度
          （fontSize 12 ui-monospace 下约 650px，即代理的规范几何）。
          ProgressiveTerminal 在同一尺寸原地渲染静态烟熏玻璃镜像或不透明实时 xterm（不变形）。
          网格每格用更小的缩放镜像；本 popover（graph/table）有空间放下近全尺寸终端。 */}
      <div
        // OPR.0.4.0.39：内层是规范几何宽度（实时字体下 90ch），使静态/实时镜像精确贴合；
        // 高度由内容驱动（渐进用 ScaleToFitTerminal，feed 用自然 xterm），
        // 因此底部永不被裁。
        className="max-w-[calc(100vw-2rem)]"
        style={{
          width: `${LIVE_TERMINAL_COLS}ch`,
          fontFamily: LIVE_TERMINAL_FONT_FAMILY,
          fontSize: `${LIVE_TERMINAL_FONT_SIZE}px`,
        }}
      >
        {progressive ? (
          <ProgressiveTerminal
            sessionName={sessionName}
            terminalKey={key}
            testIdPrefix={testIdPrefix}
          />
        ) : (
          <FocusedTerminal sessionName={sessionName} />
        )}
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <div ref={rootRef} data-terminal-preview-surface="" className={cn("relative inline-flex", wrapperClassName)}>
      {renderTrigger ? (
        <button
          type="button"
          data-testid={`${testIdPrefix}-terminal-open`}
          aria-label={`查看 ${logicalId} 终端`}
          title="查看终端"
          onClick={openPreview}
          className={buttonClassName}
        >
          <ToolMark tool="terminal" size="sm" />
        </button>
      ) : null}
      {popover}
    </div>
  );
}
