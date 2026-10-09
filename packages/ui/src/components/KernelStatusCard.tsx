// OPR.0.4.3.22 —— 仪表盘内核状态卡片。
//
// 内核健康状态来自 /api/kernel/status（启动跟踪 surface），绝不从后台服务的
// /healthz 检查推断（guard 4）。卡片直接消费 kernel_state 的判定结果来决定徽章
// 色调——未就绪的内核渲染为非绿色（19/21 教训：渲染真实判定，不要一边在数据里
// 带着未就绪、一边默认渲染成绿色）。
//
// "恢复内核"会针对内核工作组打开同一个启动/恢复弹窗。防重复实例化守卫：除非存在
// 内核工作组（通过 rig summary 找到）且内核尚未起来，否则该动作为禁用；恢复本身
// 走 /api/rigs/:id/up，其 `rig_not_stopped` 守卫会拒绝恢复正在运行的内核
// （因此不会再起第二个内核/顾问/操作员）。

import { useState } from "react";
import { RigStatusCard } from "./RigStatusCard.js";
import { LaunchRecoveryModal } from "./LaunchRecoveryModal.js";
import { useKernelStatus, isKernelUnavailable, type KernelState } from "../hooks/useKernelStatus.js";
import { useRigSummary } from "../hooks/useRigSummary.js";
import type { RigAggStatus } from "../hooks/useRigStatus.js";

function kernelToAggregate(state: KernelState | undefined): RigAggStatus {
  switch (state) {
    case "ready":
      return "up";
    case "booting":
    case "partial_ready":
    case "degraded":
      return "partial";
    case "auth_blocked":
    case "spec_missing":
    case "bootstrap_failed":
      return "blocked";
    default:
      return "unknown";
  }
}

export function KernelStatusCard() {
  const { data: kernel, isLoading } = useKernelStatus();
  const { data: rigs } = useRigSummary();
  const [modalOpen, setModalOpen] = useState(false);

  const kernelRig = rigs?.find((r) => r.name === "kernel");

  if (isLoading || !kernel) {
    return (
      <RigStatusCard
        rigId="kernel"
        rigName="kernel"
        isKernel
        status="unknown"
        seatsRunning={0}
        seatsTotal={0}
        recoverable={false}
        src={["kernel-status: 加载中…"]}
        primaryLabel="恢复内核 ▸"
        primaryDisabled
        testId="kernel-status-card"
      />
    );
  }

  // 503 —— 启动跟踪未接入本后台服务。按 `unknown` 消费（绝不变绿）；
  // 不提供恢复（没有可观察、可恢复的对象）。
  if (isKernelUnavailable(kernel)) {
    return (
      <RigStatusCard
        rigId={kernelRig?.id ?? "kernel"}
        rigName="kernel"
        isKernel
        status="unknown"
        seatsRunning={0}
        seatsTotal={0}
        recoverable={false}
        src={[`kernel-status: 不可用（${kernel.error}）`]}
        primaryLabel="恢复内核 ▸"
        primaryDisabled
        testId="kernel-status-card"
      />
    );
  }

  // 防御：畸形信封（缺少 kernel_state / agents）读作 `unknown`——绝不崩溃，也绝不误报绿色。
  const status = kernelToAggregate(kernel.kernel_state);
  const agents = Array.isArray(kernel.agents) ? kernel.agents : [];
  const readyAgents = agents.filter((a) => a.startup_status === "ready").length;
  const src = [
    `kernel-status.kernel_state=${kernel.kernel_state ?? "unknown"}`,
    ...(kernel.variant ? [`variant=${kernel.variant}`] : []),
    `智能体 ${readyAgents}/${agents.length} 就绪`,
    ...(kernel.detail ? [kernel.detail] : []),
  ];

  // 防重复实例化守卫：仅当存在内核工作组且内核尚未起来时才允许恢复。
  const restoreDisabled = !kernelRig || status === "up";

  return (
    <>
      <RigStatusCard
        rigId={kernelRig?.id ?? "kernel"}
        rigName="kernel"
        isKernel
        status={status}
        seatsRunning={readyAgents}
        seatsTotal={agents.length}
        recoverable={status === "down" || status === "partial"}
        src={src}
        primaryLabel="恢复内核 ▸"
        primaryDisabled={restoreDisabled}
        onPrimary={() => setModalOpen(true)}
        testId="kernel-status-card"
      />
      {kernelRig ? (
        <LaunchRecoveryModal
          rigId={kernelRig.id}
          rigName="kernel"
          open={modalOpen}
          onOpenChange={setModalOpen}
        />
      ) : null}
    </>
  );
}
