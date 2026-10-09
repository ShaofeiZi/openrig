// OPR.0.4.3.22 —— 可复用的工作组状态卡片。渲染后端组合出的聚合状态
// （up / partial / down / blocked / unknown），不从面板文本推断。用于两处：
// 仪表盘内核状态卡与拓扑工作组控制。卡片只暴露一个主要的恢复/启动动作
// （打开启动/恢复弹窗）；终端面的动作（打开拓扑 / CMUX）单独放置，
// 绝不在本卡片上（guard 5）。
//
// 状态徽章在渲染色调上直接消费后端判定——非 `up` 状态渲染为非绿色
// （19/21 教训：渲染真实判定，不要一边在数据里带着非 up、一边默认渲染成绿色）。

import { Hexagon, Server } from "lucide-react";
import { StatusPip, type StatusPipStatus } from "./ui/status-pip.js";
import { Button } from "./ui/button.js";
import { cn } from "../lib/utils.js";
import type { RigAggStatus } from "../hooks/useRigStatus.js";

// 共享状态词表——紧凑拓扑工作组状态控制（OPR.0.4.7.1）也消费它，
// 让两个界面用同一套判定语言。
export const statusToPip: Record<RigAggStatus, StatusPipStatus> = {
  up: "running",
  partial: "warning",
  down: "stopped",
  blocked: "error",
  unknown: "info",
};

export const statusBadgeTone: Record<RigAggStatus, string> = {
  up: "border-success text-success",
  partial: "border-warning text-warning",
  down: "border-stone-400 text-stone-500",
  blocked: "border-tertiary text-tertiary",
  unknown: "border-stone-300 text-stone-400",
};

// 徽章中展示的状态中文标签（data-status 属性仍保留原始枚举）。
export const statusBadgeLabel: Record<RigAggStatus, string> = {
  up: "运行中",
  partial: "部分",
  down: "已停止",
  blocked: "已阻塞",
  unknown: "未知",
};

export const statusHelp: Record<RigAggStatus, string> = {
  up: "所有受管席位均在运行。",
  partial: "部分席位运行中，部分已停止 / 已脱离 / 待关注。",
  down: "无席位运行——可从快照恢复。",
  blocked: "缺少操作员操作无法继续恢复（缺失 token / 鉴权 / 规格）。",
  unknown: "后台服务/API 无法可靠判定状态。",
};

export interface RigStatusCardProps {
  rigId: string;
  rigName: string;
  isKernel?: boolean;
  status: RigAggStatus;
  seatsRunning: number;
  seatsTotal: number;
  recoverable: boolean;
  /** 组合出的来源行——展示出来让状态可读，而不只是一个颜色。 */
  src: string[];
  primaryLabel: string;
  onPrimary?: () => void;
  /** 覆盖启用状态（例如内核卡片在没有内核工作组时禁用恢复——防重复实例化守卫）。
   *  默认仅在工作组已 `up` 时禁用。 */
  primaryDisabled?: boolean;
  testId?: string;
}

export function RigStatusCard({
  rigId,
  rigName,
  isKernel = false,
  status,
  seatsRunning,
  seatsTotal,
  recoverable,
  src,
  primaryLabel,
  onPrimary,
  primaryDisabled,
  testId,
}: RigStatusCardProps) {
  const pip = statusToPip[status];
  const disabled = primaryDisabled ?? status === "up";

  return (
    <div
      data-testid={testId ?? `rig-status-card-${rigId}`}
      data-status={status}
      className="bg-white border border-stone-900 hard-shadow relative"
    >
      {/* 深色头部条——羊皮纸语法（与 RigCard 一致）。 */}
      <div className="bg-stone-900 text-white px-4 py-1.5 font-mono text-[10px] flex justify-between items-center">
        <span>{isKernel ? "内核工作组" : `工作组：${rigName.toUpperCase()}`}</span>
        {isKernel ? <Hexagon className="h-3 w-3" /> : <Server className="h-3 w-3" />}
      </div>

      <div className="p-4 space-y-3">
        {/* 名称 + 聚合状态徽章（徽章色调消费真实判定）。 */}
        <div className="flex justify-between items-end border-b border-stone-100 pb-2">
          <span className="font-headline font-bold text-lg tracking-tight uppercase">{rigName}</span>
          <span
            data-testid={`rig-status-badge-${rigId}`}
            className={cn(
              "px-2 py-0.5 border font-mono text-[9px] uppercase tracking-wide inline-flex items-center gap-1.5",
              statusBadgeTone[status],
            )}
          >
            <StatusPip status={pip} />
            {statusBadgeLabel[status]}
          </span>
        </div>

        {/* 状态的单行含义。 */}
        <p className="font-mono text-[9px] leading-relaxed text-secondary">{statusHelp[status]}</p>

        {/* 遥测网格。 */}
        <div className="space-y-1">
          <div className="flex justify-between font-mono text-[9px] text-secondary">
            <span>运行中席位</span>
            <span data-testid={`seats-${rigId}`}>
              {seatsRunning}/{seatsTotal}
            </span>
          </div>
          <div className="flex justify-between font-mono text-[9px] text-secondary">
            <span>可恢复</span>
            <span>{recoverable ? "是" : "否——需要操作员"}</span>
          </div>
        </div>

        {/* 主要恢复/启动动作——本卡片唯一的动作。 */}
        <div className="pt-1">
          <Button
            variant={status === "blocked" ? "destructive" : "default"}
            size="sm"
            disabled={disabled}
            onClick={onPrimary}
            data-testid={`rig-primary-action-${rigId}`}
            className="w-full font-mono text-[10px] tracking-widest"
          >
            {status === "up" ? "运行中" : primaryLabel}
          </Button>
        </div>

        {/* 来源——组合出的信号（组合得到，非推断）。 */}
        <p
          data-testid={`rig-status-src-${rigId}`}
          className="font-mono text-[8px] leading-snug text-stone-400 border-t border-stone-100 pt-2"
        >
          来源：{src.join(" · ")}
        </p>
      </div>
    </div>
  );
}
