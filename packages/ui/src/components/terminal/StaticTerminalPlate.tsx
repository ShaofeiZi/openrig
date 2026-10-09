// OPR.0.4.0.39——唯一共享的静态终端组件。
//
// 每个静态轮询预览终端（拓扑网格卡片和 ProgressiveTerminal 的静态模式）都使用同一块
// 无边框烟熏玻璃面板（SMOKED_STATIC_PLATE_CLASS = bg-stone-950/60 backdrop-blur），
// 内含紧凑的 SessionPreviewPane。静态内容是半透明玻璃态（bg-transparent，面板透出），
// 表示未激活。按创始人规格修正，实时 xterm 使用不透明 #0c0a09；点击进入实时后从玻璃态切到
// 不透明态，是有意设计的静态/实时激活提示（玻璃 = 未激活，不透明 = 实时），并非“镜像实时外观”。
// 该组件收拢重复的面板加预览模式，使每个静态终端保持一致并可原地升级为实时终端。

import { SessionPreviewPane } from "../preview/SessionPreviewPane.js";
import { cn } from "../../lib/utils.js";

/** 每个静态终端预览使用的无边框烟熏玻璃面板，使其在真正裸露的界面（拓扑页签/网格）上
 * 呈现为悬浮玻璃，并与实时外观协调。这里是共享静态终端的归属位置；
 * ProgressiveTerminal 为现有导入方重新导出它。 */
// OPR.0.4.0.39（创始人规格修正）：静态面板在浅色拓扑页面上呈现为烟熏黑玻璃。stone-950
// 以 60% 叠在奶油色纸张上时会变成褪色浅灰，创始人认为“太褪色”；85% 则呈现浓郁烟熏黑，
// 与调校后的图弹窗外观一致，同时保留玻璃透明度和背景模糊。实时 xterm 完全不透明（#0c0a09），
// 因而玻璃态到不透明态的切换仍是清晰可见的激活提示。
export const SMOKED_STATIC_PLATE_CLASS = "bg-stone-950/85 backdrop-blur-sm";

interface StaticTerminalPlateProps {
  sessionName: string;
  lines?: number;
  /** 面板元素的 data-testid；提供 onClick 时为按钮，否则为 div。 */
  plateTestId?: string;
  /** 传递给内部 SessionPreviewPane 的 testIdPrefix。 */
  previewTestIdPrefix?: string;
  className?: string;
  /** 提供后，面板自身成为点击进入实时模式的目标（按钮）。 */
  onClick?: () => void;
  ariaLabel?: string;
  title?: string;
}

/**
 * 共享静态终端面板。提供 `onClick` 时渲染为点击进入实时模式的按钮
 *（ProgressiveTerminal 静态模式）；未提供时渲染为普通面板（拓扑网格缩略图，
 * 其点击进入实时模式由独立的 TerminalPreviewPopover 触发器负责）。
 */
export function StaticTerminalPlate({
  sessionName,
  lines,
  plateTestId,
  previewTestIdPrefix,
  className,
  onClick,
  ariaLabel,
  title,
}: StaticTerminalPlateProps) {
  const preview = (
    <SessionPreviewPane
      sessionName={sessionName}
      lines={lines}
      variant="compact-terminal"
      testIdPrefix={previewTestIdPrefix}
    />
  );

  if (onClick) {
    return (
      <button
        type="button"
        data-testid={plateTestId}
        aria-label={ariaLabel}
        title={title}
        onClick={onClick}
        // OPR.0.4.0.39：w-max 使面板按固定 90 列内容确定尺寸而非填满容器，供共享的
        // ScaleToFitTerminal 测量自然宽度并将整个内容块缩放到列宽，保持静态/实时几何镜像。
        className={cn("block w-max cursor-pointer text-left", SMOKED_STATIC_PLATE_CLASS, className)}
      >
        {preview}
      </button>
    );
  }

  return (
    <div data-testid={plateTestId} className={cn("w-max", SMOKED_STATIC_PLATE_CLASS, className)}>
      {preview}
    </div>
  );
}
