// OPR.0.4.7.1 —— 拓扑页的工作组状态控件：一个紧凑的状态角标 + 启动按钮，
// 点击打开既有的 LaunchRecoveryModal。
//
// 取代原先内联挂载的 RigStatusCard——它曾是一张大型左对齐卡片，铺在拓扑 explorer 覆盖层下方
// （复现：卡片从 x335 开始，左半、文字和操作都被遮挡）。RigStatusCard 本身不动——
// 仪表盘内核卡片仍在使用它（OPR.0.4.3.22）。终端界面的操作（在终端中打开）仍单独放在
// 标签栏里，绝不做恢复或全新预热（guard 5）。
//
// 该控件在任何状态下都保持为一个按钮——status=up 时也打开弹窗：弹窗是“先规划后变更”
// （打开时是只读预测），所以 up 时打开是安全的；而一个有时不可点的控件看起来像坏了。
// 状态的一行含义挂在角标的 tooltip 上。

import { useState } from "react";
import { LaunchRecoveryModal } from "./LaunchRecoveryModal.js";
import { statusBadgeTone, statusHelp, statusToPip } from "./RigStatusCard.js";
import { StatusPip } from "./ui/status-pip.js";
import { Button } from "./ui/button.js";
import { cn } from "../lib/utils.js";
import { useRigStatus } from "../hooks/useRigStatus.js";

export function RigStatusControl({ rigId, rigName }: { rigId: string; rigName: string }) {
  const { data: status, isLoading } = useRigStatus(rigId);
  const [modalOpen, setModalOpen] = useState(false);

  // 防御：在拿到形态良好的状态对象之前渲染占位（畸形/空响应绝不能让拓扑页崩溃）。
  if (isLoading || !status || typeof status.rigName !== "string" || !Array.isArray(status.src)) {
    return (
      <div
        data-testid={`rig-status-control-${rigId}`}
        className="inline-flex items-center border border-stone-300 bg-white/60 px-3 py-1.5 font-mono text-[9px] text-secondary"
      >
        正在加载工作组状态…
      </div>
    );
  }

  const primaryLabel =
    status.status === "blocked"
      ? "解决并恢复 ▸"
      : status.status === "up"
        ? "运行中 ▸"
        : "恢复 / 启动 ▸";

  return (
    <div
      data-testid={`rig-status-control-${rigId}`}
      data-status={status.status}
      className="inline-flex items-center gap-2 border border-stone-900 bg-white hard-shadow px-2 py-1.5"
    >
      <span
        data-testid={`rig-status-badge-${rigId}`}
        title={statusHelp[status.status]}
        className={cn(
          "px-2 py-0.5 border font-mono text-[9px] uppercase tracking-wide inline-flex items-center gap-1.5",
          statusBadgeTone[status.status],
        )}
      >
        <StatusPip status={statusToPip[status.status]} />
        {status.status}
      </span>
      <span data-testid={`seats-${rigId}`} className="font-mono text-[9px] text-secondary">
        {status.seatsRunning}/{status.seatsTotal}
      </span>
      <Button
        variant={status.status === "blocked" ? "destructive" : "default"}
        size="sm"
        onClick={() => setModalOpen(true)}
        data-testid={`rig-primary-action-${rigId}`}
        className="font-mono text-[10px] tracking-widest"
      >
        {primaryLabel}
      </Button>
      <LaunchRecoveryModal rigId={rigId} rigName={rigName} open={modalOpen} onOpenChange={setModalOpen} />
    </div>
  );
}
