// V1 第 5 阶段 P5-7 —— 拓扑终端网格视图。
//
// 按 topology-terminal-view.md L13-L80：固定卡片网格，每张卡片是智能体
// 终端输出的转录尾部预览。V1 复用现有 SessionPreviewPane 原语
//（按代码映射在树后保留）。V2 发布交互式 xterm.js + tmux-attach（超出此处范围）。
//
// 关键行为（规范承重）：
//   - 智能体"运行中"（近期活跃）的卡片上脉冲环
//     （按 topology-terminal-view.md L47）——一眼扫描信号
//    （"人类必须能不读每张卡片就发现哪些智能体需要关注"）。
//     CSS 关键帧是伪元素绘制（jsdom 不兼容），因此 CSS 源码断言测试守卫它。
//   - 主机范围安全 N 分页（L70-L80）：默认 12 张卡片；
//     需要完整网格的操作者可"显示全部 N"切换。
//   - 轮询频率：SessionPreviewPane 使用 useSessionPreview，
//     遵循配置的 ui.preview.refresh_interval_seconds（默认 3s）。
//     按 L60-L65，更大范围 = 更低频率；现有配置覆盖它。

import { useMemo, useState } from "react";
import { useRigSummary, type RigSummary } from "../../hooks/useRigSummary.js";
import { useNodeInventory, type NodeInventoryEntry } from "../../hooks/useNodeInventory.js";
import { useSelectedHostId } from "../../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../../lib/host-param.js";
import { displayAgentName } from "../../lib/display-name.js";
import { ProgressiveTerminal } from "../terminal/ProgressiveTerminal.js";
import { EmptyState } from "../ui/empty-state.js";
import { SectionHeader } from "../ui/section-header.js";
import { cn } from "../../lib/utils.js";
import { RuntimeBadge } from "../graphics/RuntimeMark.js";
import { formatCompactTokenCount, formatTokenTotalTitle, sumTokenCounts } from "../../lib/token-format.js";
import { contextUsageTextClass } from "../ContextUsageRing.js";

const SAFE_N = 12;

interface TopologyTerminalViewProps {
  scope: "host" | "rig" | "pod";
  /** 工作组和 Pod 范围必填。 */
  rigId?: string;
  /** Pod 范围必填。 */
  podName?: string;
}

function isActiveRunning(seat: NodeInventoryEntry): boolean {
  // 按 topology-terminal-view.md L47："活跃"智能体卡片上的脉冲环
  //（轮询窗口内有输出）。PL-019 agentActivity 摘要的 "running" 状态是
  // 最接近的可用代理。
  return seat.agentActivity?.state === "running";
}

function ContextMetric({ seat }: { seat: NodeInventoryEntry }) {
  const usage = seat.contextUsage;
  const known = usage?.availability === "known" && typeof usage.usedPercentage === "number";
  return (
    <span
      data-testid={`terminal-card-context-${seat.rigId}-${seat.logicalId}`}
      className={`font-mono text-[8px] font-bold uppercase tracking-wide ${contextUsageTextClass(usage?.usedPercentage, usage?.fresh, usage?.availability)}`}
      title={
        known
          ? usage?.fresh === false
            ? "上下文用量（过期采样）"
            : "上下文用量（新鲜）"
          : "上下文采样不可用"
      }
    >
      {known ? `${usage.usedPercentage}%` : "--"}
    </span>
  );
}

function TokenMetric({ seat }: { seat: NodeInventoryEntry }) {
  const usage = seat.contextUsage;
  const total = sumTokenCounts(usage?.totalInputTokens, usage?.totalOutputTokens);
  const label = formatCompactTokenCount(total);
  const title = formatTokenTotalTitle(usage?.totalInputTokens, usage?.totalOutputTokens);
  return (
    <span
      data-testid={`terminal-card-tokens-${seat.rigId}-${seat.logicalId}`}
      className={`font-mono text-[8px] font-bold uppercase tracking-wide ${label ? "text-on-surface-variant" : "text-on-surface-variant"}`}
      title={title ?? "Token 采样不可用"}
    >
      {label ?? "--"}
    </span>
  );
}

// V0.3.1 切片 14 walk-item 17 —— TerminalView 卡片。
// OPR.0.4.0.39（FR-1/FR-3/FR-4/FR-6 创始者规格修正）：每个网格单元格是
// 智能体名称 + Claude/Codex 统计，位于全宽 ProgressiveTerminal 上方的头部
//（默认静态 → 点击 → 就地转实时）。静态就是点击转实时目标——无单独的展开弹出
// 触发器，无白色卡片包装（与终端对比太强）。静态渲染半透明烟熏玻璃；点击翻转为
// 不透明 #0c0a09 实时 xterm 就地（激活控件）。实时 xterm 在单元格内滚动/平移
//（38 引脚 90x27 + overflow-auto）——可以；网格是扫描-点击干预视图，
// 不用于长会话。全局实时上限在转实时时绑定（共享 LiveTerminalProvider）。
// FR-3：原点左上 + 每断点 CSS 缩小（xl:scale-90 起始值；QA 测量可读性下限
// 并前瞻修正值）将完整终端宽度装入最密的 3 列单元格——宁可太小不裁剪，
// 绝不切掉右边缘（无 overflow-hidden；静态 <pre> 平移更宽行）。
// 脉冲环活跃处理保留为一眼扫描信号。

function SeatTerminalCard({ seat }: { seat: NodeInventoryEntry }) {
  const sessionName = seat.canonicalSessionName ?? seat.logicalId;
  const active = isActiveRunning(seat);
  const memberName = displayAgentName(seat.logicalId);
  return (
    <div
      data-testid={`terminal-card-${seat.rigId}-${seat.logicalId}`}
      data-active={active ? "true" : "false"}
      className={cn(
        // OPR.0.4.0.39 FR-4：无白色卡片包装（bg-surface-lowest/40 对比太强）；
        // 紧凑 p-1.5/gap-1.5 使网格不浪费边缘空间。活跃脉冲环边框保留为扫描信号；
        // 非活跃无边框。
        "relative flex flex-col gap-1.5 p-1.5",
        active ? "terminal-card-active border border-secondary" : "border border-transparent",
      )}
    >
      <header className="flex items-center justify-between gap-2">
        <span className="font-mono text-[8px] font-semibold uppercase tracking-[0.10em] text-on-surface-variant truncate">
          {memberName}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1">
          <RuntimeBadge runtime={seat.runtime} size="xs" compact variant="inline" />
          <ContextMetric seat={seat} />
          <TokenMetric seat={seat} />
        </span>
      </header>
      {/* OPR.0.4.0.39 FR-1/FR-3/FR-6（创始者规格）：ProgressiveTerminal 就是
          就地点击转实时目标（静态烟熏玻璃 → 点击 → 不透明实时 xterm 在相同
          90x27 几何、相同位置）。它在共享 ScaleToFitTerminal 中包装两个状态，
          后者测量固定 90 列块并缩放以适应单元格宽度（fit-width，不裁剪——
          无硬编码每断点缩放）。无单独弹出触发器。 */}
      <ProgressiveTerminal
        sessionName={sessionName}
        terminalKey={`${seat.rigId}:${seat.logicalId}`}
        testIdPrefix={`terminal-grid-${seat.rigId}-${seat.logicalId}`}
      />
    </div>
  );
}

function TerminalGrid({
  seats,
  emptyLabel,
  emptyDescription,
}: {
  seats: NodeInventoryEntry[];
  emptyLabel: string;
  emptyDescription: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? seats : seats.slice(0, SAFE_N);
  const hasMore = seats.length > SAFE_N;

  if (seats.length === 0) {
    return (
      <EmptyState
        label={emptyLabel}
        description={emptyDescription}
        variant="card"
        testId="topology-terminal-empty"
      />
    );
  }

  return (
    <div data-testid="topology-terminal-grid" className="space-y-3">
      <div className="font-mono text-[9px] text-on-surface-variant flex items-center justify-between">
        <span data-testid="topology-terminal-count">
          显示 {visible.length}/{seats.length} 个终端
        </span>
        {hasMore ? (
          <button
            type="button"
            data-testid="topology-terminal-show-toggle"
            onClick={() => setShowAll((s) => !s)}
            className="px-2 py-0.5 border border-outline-variant font-mono text-[9px] uppercase tracking-wide text-on-surface hover:bg-surface-low/60"
          >
            {showAll ? `显示前 ${SAFE_N} 个` : `显示全部 ${seats.length} 个`}
          </button>
        ) : null}
      </div>
      {/* OPR.0.4.0.39 FR-2（创始者：最多 2 列）：窄屏 1 列 / 宽屏 2 列。
          3 列已弃用——3 列并排时缩放的 90 列终端太小无法阅读；
          2 列保持每个单元格足够宽以可读终端。 */}
      <div className="grid gap-2 grid-cols-1 md:grid-cols-2">
        {visible.map((seat) => (
          <SeatTerminalCard
            key={`${seat.rigId}-${seat.logicalId}`}
            seat={seat}
          />
        ))}
      </div>
    </div>
  );
}

function RigTerminalSection({ rigId, rigName }: { rigId: string; rigName: string }) {
  const { data: nodes } = useNodeInventory(rigId);
  const seats = useMemo(
    () => (nodes ?? []).filter((n) => n.nodeKind !== "infrastructure"),
    [nodes],
  );
  if (seats.length === 0) return null;
  return (
    <section
      data-testid={`topology-terminal-rig-${rigId}`}
      className="border-t border-outline-variant pt-4 first:border-t-0 first:pt-0"
    >
      <SectionHeader tone="muted">{rigName}</SectionHeader>
      <div className="mt-2">
        <TerminalGrid
          seats={seats}
          emptyLabel="无席位"
          emptyDescription={`${rigName} 中无智能体席位。`}
        />
      </div>
    </section>
  );
}

function HostRigPicker({
  rigs,
  onSelectRig,
}: {
  rigs: RigSummary[];
  onSelectRig: (rigId: string) => void;
}) {
  return (
    <div data-testid="topology-terminal-host-picker" className="space-y-3">
      <SectionHeader tone="muted">工作组终端</SectionHeader>
      <div className="grid gap-2 grid-cols-1 md:grid-cols-2">
        {rigs.map((rig) => (
          <button
            key={rig.id}
            type="button"
            data-testid={`topology-terminal-host-rig-${rig.id}`}
            onClick={() => onSelectRig(rig.id)}
            className="flex items-center justify-between gap-2 border border-outline-variant bg-surface/70 px-3 py-2 text-left hover:bg-surface-low/70"
          >
            <span className="min-w-0">
              <span className="block truncate font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-on-surface">
                {rig.name}
              </span>
              <span className="block font-mono text-[9px] uppercase tracking-[0.10em] text-on-surface-variant">
                {rig.nodeCount} 个节点
              </span>
            </span>
            <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.12em] text-on-surface-variant">
              打开
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function TopologyTerminalView({ scope, rigId, podName }: TopologyTerminalViewProps) {
  const [selectedHostRigId, setSelectedHostRigId] = useState<string | null>(null);
  const { data: rigs } = useRigSummary();
  const { data: rigNodes } = useNodeInventory(scope !== "host" ? (rigId ?? null) : null);
  const selectedHostRig = useMemo(
    () => rigs?.find((rig) => rig.id === selectedHostRigId) ?? null,
    [rigs, selectedHostRigId],
  );
  // OPR.0.4.6.MH2 rev1-r2 B1：每个终端卡片是本地会话表面
  //（会话名预览读取 + 点击转实时可输入 xterm）——在远端选择下它们都不可挂载。
  // 上方的列表 hooks 是重定向读取（无害）；诚实门控替换网格。
  const terminalsAreRemote = useSelectedHostId() !== LOCAL_HOST_ID;

  if (terminalsAreRemote) {
    return (
      <div className="p-6">
        <EmptyState
          label="远端主机不提供终端"
          description="终端流是此主机的本地会话。查看远端主机是只读的；对其操作随 MH-3/MH-4 到达。"
          variant="card"
          testId="topology-terminal-remote-gated"
        />
      </div>
    );
  }

  if (scope === "host") {
    if (!rigs || rigs.length === 0) {
      return (
        <div className="p-6">
          <EmptyState
            label="无工作组"
            description="无已注册工作组。注册一个工作组以在主机范围查看终端。"
            variant="card"
            testId="topology-terminal-empty"
          />
        </div>
      );
    }
    if (selectedHostRig) {
      return (
        <div data-testid="topology-terminal-host" className="p-6 space-y-4">
          <button
            type="button"
            data-testid="topology-terminal-host-back"
            onClick={() => setSelectedHostRigId(null)}
            className="font-mono text-[9px] uppercase tracking-[0.14em] text-on-surface-variant hover:text-on-surface"
          >
            返回工作组列表
          </button>
          <RigTerminalSection rigId={selectedHostRig.id} rigName={selectedHostRig.name} />
        </div>
      );
    }
    return (
      <div data-testid="topology-terminal-host" className="p-6 space-y-6">
        <HostRigPicker rigs={rigs} onSelectRig={setSelectedHostRigId} />
      </div>
    );
  }

  // 工作组 + Pod 范围共享相同的单工作组数据源；pod 按 podName 过滤。
  const seatsAll = (rigNodes ?? []).filter((n) => n.nodeKind !== "infrastructure");
  const seats =
    scope === "pod" && podName
      ? seatsAll.filter((s) => (s.podNamespace ?? s.podId) === podName)
      : seatsAll;

  return (
    <div data-testid={`topology-terminal-${scope}`} className="p-6">
      <TerminalGrid
        seats={seats}
        emptyLabel="无席位"
        emptyDescription={
          scope === "pod"
            ? `Pod ${podName} 中无智能体席位。`
            : "此工作组中无智能体席位。"
        }
      />
    </div>
  );
}
