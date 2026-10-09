// PL-005 阶段 A：一等人工席位渲染。
//
// 人工队列是一等产品概念，而不是不可见的配置层约定。任务控制台使用独立卡片渲染操作人员的
// 人工席位，显示身份、负载和能力。默认名称为 `operator-${USER}@kernel`，其中 ${USER}
// 是通过 `workspace.operator_seat_name` 设置取得的操作系统用户名（V0.3.1 slice 05）。
//
// V1 第三次尝试第 5 阶段 P5-8：重构为组合第 1 阶段的 VellumCard 原语，以规范 vellum 美学
//（奶油纸背景、1px outline-variant 边框、RegistrationMarks 和硬阴影）替代临时的
// `border border-outline-variant bg-background` 外观。使 HumanSeatCard 与 V1 战术档案视觉语言
// 对齐，满足设计评审“达到专业级”的 V1 交付门禁裁定。

import { VellumCard } from "../../ui/vellum-card.js";
import { SectionHeader } from "../../ui/section-header.js";
import { StatusPip } from "../../ui/status-pip.js";
import type { CompactStatusRow } from "../hooks/useMissionControlView.js";

export interface HumanSeatCardProps {
  /** 规范会话标签，例如 `operator-alex@kernel`；默认通过
   * `workspace.operator_seat_name` 设置从操作系统用户名派生（V0.3.1 slice 05）。 */
  session: string;
  /** 待处理的 human-gate 项，用于负载指示。 */
  rows: CompactStatusRow[];
  /** 可选能力标签，说明此席位可触发哪些动作。 */
  capabilities?: string[];
}

export function HumanSeatCard({
  session,
  rows,
  capabilities = ["approve", "deny", "route", "annotate", "hold", "drop", "handoff"],
}: HumanSeatCardProps) {
  const pendingCount = rows.filter(
    (r) => r.state === "idle" || r.state === "attention" || r.state === "blocked",
  ).length;
  const blockedCount = rows.filter((r) => r.state === "blocked").length;
  // 使用其他位置相同的 StatusPip 分类反映注意力级别：blocked 为 warning，普通 pending 为 info。
  // 使卡片的语义色板与 V1 其余部分保持一致。
  const pendingTone =
    blockedCount > 0 ? "warning" : pendingCount > 0 ? "info" : "active";
  return (
    <VellumCard
      testId="mc-human-seat-card"
      data-session={session}
    >
      <div className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <SectionHeader tone="muted">人工席位</SectionHeader>
            <div
              data-testid="mc-human-seat-session"
              className="mt-1 font-mono text-sm text-on-surface truncate"
            >
              {session}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div
              data-testid="mc-human-seat-pending"
              className="font-mono text-2xl font-bold text-on-surface leading-none"
            >
              {pendingCount}
            </div>
            <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant mt-1">
              待处理
            </div>
          </div>
        </div>
        {blockedCount > 0 ? (
          <div className="mt-3 flex items-center gap-2">
            <StatusPip
              status="warning"
              label={`${blockedCount} 个已阻塞`}
              variant="pill"
              testId="mc-human-seat-blocked"
            />
          </div>
        ) : (
          <div className="mt-3">
            <StatusPip
              status={pendingTone}
              label={pendingCount === 0 ? "一切正常" : `${pendingCount} 个待处理`}
              variant="pill"
            />
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-1">
          {capabilities.map((cap) => (
            <span
              key={cap}
              className="border border-outline-variant px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.1em] text-on-surface-variant bg-surface-lowest/30"
            >
              {cap}
            </span>
          ))}
        </div>
      </div>
    </VellumCard>
  );
}
