import * as React from "react";
import { cn } from "@/lib/utils";

export type StatusPipStatus =
  | "active"
  | "running"
  | "stopped"
  | "warning"
  | "error"
  | "info";

export type StatusPipVariant = "dot" | "pill";

export interface StatusPipProps {
  status: StatusPipStatus;
  label?: string;
  variant?: StatusPipVariant;
  className?: string;
  /** V0.3.1 slice 14 walk-item 15 —— 仅作用于标签文本（不作用于圆点）的可选类名。
   *  TopologyTableView 用它给活动行加微光动画，同时保持绿点静止。
   *  把它挂在 StatusPip 内部（而非外部包裹），可让各变体的标签标记保持一致。 */
  labelClassName?: string;
  testId?: string;
}

const toneDot: Record<StatusPipStatus, string> = {
  active: "bg-success",
  running: "bg-success",
  stopped: "bg-outline-variant",
  warning: "bg-warning",
  error: "bg-tertiary",
  info: "bg-secondary",
};

const tonePill: Record<StatusPipStatus, string> = {
  active: "border-success text-success",
  running: "border-success text-success",
  stopped: "border-outline text-on-surface-variant",
  warning: "border-warning text-warning",
  error: "border-tertiary text-tertiary",
  info: "border-secondary text-secondary",
};

export function StatusPip({
  status,
  label,
  variant = "dot",
  className,
  labelClassName,
  testId,
}: StatusPipProps) {
  const labelText = label ?? status;
  if (variant === "pill") {
    return (
      <span
        data-testid={testId}
        className={cn(
          "inline-flex items-center gap-1 px-1.5 py-0.5 border font-mono text-[9px] uppercase tracking-wide",
          tonePill[status],
          className,
        )}
        role="status"
        aria-label={labelText}
      >
        <span className={cn("w-1.5 h-1.5 rounded-full", toneDot[status])} aria-hidden="true" />
        <span className={labelClassName}>{labelText}</span>
      </span>
    );
  }
  return (
    <span
      data-testid={testId}
      className={cn("inline-flex items-center gap-1.5", className)}
      role="status"
      aria-label={labelText}
    >
      <span className={cn("w-2 h-2 rounded-full", toneDot[status])} aria-hidden="true" />
      {label ? (
        <span className={cn("font-mono text-[9px] uppercase tracking-wide text-on-surface-variant", labelClassName)}>
          {label}
        </span>
      ) : null}
    </span>
  );
}
