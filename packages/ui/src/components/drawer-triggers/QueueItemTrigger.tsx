// V1 attempt-3 Phase 4 —— QueueItemTrigger。
//
// 包裹可点击元素（qitem 行、feed 卡片上的“显示上下文”提示），点击时用
// QueueItemViewer 负载打开抽屉。

import { type ReactNode, type CSSProperties } from "react";
import { useDrawerSelection } from "../AppShell.js";
import type { QueueItemViewerData } from "../drawer-viewers/QueueItemViewer.js";

interface QueueItemTriggerProps {
  data: QueueItemViewerData;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  testId?: string;
}

export function QueueItemTrigger({ data, children, className, style, testId }: QueueItemTriggerProps) {
  const { setSelection } = useDrawerSelection();
  return (
    <button
      type="button"
      data-testid={testId ?? "queue-item-trigger"}
      onClick={() => setSelection({ type: "qitem", data })}
      className={className ?? "text-left"}
      style={style}
    >
      {children}
    </button>
  );
}
