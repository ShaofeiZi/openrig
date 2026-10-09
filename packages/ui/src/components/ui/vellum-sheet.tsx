import * as React from "react";
import { cn } from "@/lib/utils";
import { RegistrationMarks } from "./registration-marks";

export type VellumSheetEdge = "left" | "right";
export type VellumSheetWidth = "wide" | "narrow";

export interface VellumSheetProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
  edge?: VellumSheetEdge;
  width?: VellumSheetWidth;
  onClose?: () => void;
  testId?: string;
}

const widthClass: Record<VellumSheetWidth, string> = {
  // V1 校准 2026-05-06（universal-shell.md L36 + content-drawer.md L9）：
  // 38rem（约 608px）= iPad 竖屏阅读宽度。对 markdown / spec 文档足够宽，
  // 又足够窄，使后方中心工作区仍可见。原规格为 45rem；后校准为当前 shell 宽度。
  wide: "w-full lg:w-[38rem] lg:max-w-[80vw]",
  narrow: "w-full lg:w-[22rem] lg:max-w-[60vw]",
};

const edgeClass: Record<VellumSheetEdge, string> = {
  // V1 边框粗细准则（universal-shell.md L39–L48）：区域间边界用 1px outline-variant 细线。
  // 不用 2px stone-900（那会显得像“装在盒子里的 UI”；战术档案要的是纸张分层感）。
  left: "border-r border-outline-variant",
  right: "border-l border-outline-variant",
};

export function VellumSheet({
  children,
  edge = "right",
  width = "wide",
  onClose,
  className,
  testId,
  ...rest
}: VellumSheetProps) {
  return (
    <div
      className={cn(
        "vellum-heavy relative flex flex-col h-full shadow-[0_0_24px_rgba(0,0,0,0.08)]",
        widthClass[width],
        edgeClass[edge],
        className,
      )}
      data-testid={testId}
      role="dialog"
      aria-modal="false"
      {...rest}
    >
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭面板"
          className="absolute top-2 right-2 z-10 px-2 py-0.5 border border-on-surface bg-surface-lowest font-mono text-[10px] hover:bg-surface-low"
          data-testid={testId ? `${testId}-close` : undefined}
        >
          ×
        </button>
      ) : null}
      <div className="flex-1 overflow-auto">{children}</div>
      <RegistrationMarks testIdPrefix={testId} />
    </div>
  );
}
