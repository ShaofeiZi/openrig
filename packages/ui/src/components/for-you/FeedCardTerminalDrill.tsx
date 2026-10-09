// OPR.0.3.3.20 + OPR.0.4.0.24 —— For-You 卡片级下钻到来源/作者席位的
// 实时终端（按异常管理，视频 B6）。
//
// 仅按会话名寻址：下钻复用 TerminalPreviewPopover，后者挂载 FocusedTerminal
// （一个实时 xterm/WebSocket 终端）。它不做任何 rigId/logicalId/agentActivity
// 拓扑解析——卡片上已解析好的来源会话字符串就是全部地址。
//
// 诚实呈现：当实时终端连不上时，FocusedTerminal 会诚实地呈现不可用/断开状态。
// 当卡片解析不到任何会话时，下钻按钮以禁用态渲染，并带诚实的 title。

import { TerminalPreviewPopover } from "../topology/TerminalPreviewPopover.js";

const TERMINAL_PREVIEW_EVENT = "openrig:topology-terminal-preview";

interface FeedCardTerminalDrillProps {
  cardId: string;
  sessionName: string | undefined;
}

export function FeedCardTerminalDrill({ cardId, sessionName }: FeedCardTerminalDrillProps) {
  if (!sessionName) {
    return (
      <button
        type="button"
        disabled
        data-testid={`feed-card-drill-${cardId}`}
        title="本卡片未解析到会话——实时终端不可用"
        className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-on-surface-variant cursor-not-allowed"
      >
        实时终端
      </button>
    );
  }

  const previewKey = `${cardId}:${sessionName}`;

  const openPreview = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    window.dispatchEvent(new CustomEvent(TERMINAL_PREVIEW_EVENT, { detail: { key: previewKey } }));
  };

  return (
    <span className="inline-flex items-center">
      <button
        type="button"
        data-testid={`feed-card-drill-${cardId}`}
        onClick={openPreview}
        title={`为 ${sessionName} 打开实时终端`}
        className="font-mono text-[10px] uppercase tracking-wide text-on-surface hover:text-on-surface underline"
      >
        实时终端
      </button>
      <TerminalPreviewPopover
        rigId={cardId}
        logicalId={sessionName}
        sessionName={sessionName}
        renderTrigger={false}
        testIdPrefix={`feed-card-drill-${cardId}`}
      />
    </span>
  );
}
