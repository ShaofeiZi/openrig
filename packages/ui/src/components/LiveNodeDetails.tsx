// V1 智能体详情规范表面。
//
// V0.3.1 切片 25 将席位详情页重塑为 2 标签页
// 概览 + 详情 布局。概览是默认，回答最常见的一眼问题：顶部密集 9 字段信息表，
// 下方内联黑玻璃烟熏终端，然后是活动 + 最近事件卡片。详情持有其他一切
//（边、对等节点、智能体规格、启动内容无预览、转录）。
//
// 先前的 5 标签页结构（身份 / 智能体规格 / 启动 /
// 转录 / 终端）折叠为 2 个新标签页。终端不再在自己的标签页中——
// 它内联在概览中。详情中的启动部分不再显示预览窗格（因为
// 终端移到了概览）。

import { useMemo, useState } from "react";
import { CirclePlay } from "lucide-react";
import { useNodeDetail, type NodeDetailData } from "../hooks/useNodeDetail.js";
import { useTopologyActivity } from "../hooks/useTopologyActivity.js";
import { useSpecLibrary, useLibraryReview } from "../hooks/useSpecLibrary.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { WorkflowHeader } from "./WorkflowScaffold.js";
import { AgentSpecDisplay } from "./AgentSpecDisplay.js";
// 切片 3.3 fix-B —— 按调度 §3.2 / velocity-qa 的插件部分
// VM 验证失败 #2。防御性地从智能体规格审阅读取插件 ID
//（resources.plugins 字段由 plugin-primitive-v0 上的批次 1 所有；
// 在 main 上它缺失，我们渲染空态）。
import { AgentPluginsList } from "./specs/AgentPluginsList.js";
// V0.3.1 切片 25 —— 不再渲染 PreviewPane（详情标签页中的启动部分
// 去掉预览；终端通过 SessionPreviewPane 移到概览）。PreviewPane 仍由
// 代码库中其他表面所有；此文件只是不引用它。
import { SessionPreviewPane } from "./preview/SessionPreviewPane.js";
import { ProgressiveTerminal } from "./terminal/ProgressiveTerminal.js";
import { SeatOverviewTable } from "./SeatOverviewTable.js";
import { SeatOverviewSecondary } from "./SeatOverviewSecondary.js";
import { SeatNotificationBanner } from "./SeatNotificationBanner.js";
import { FileReferenceTrigger } from "./drawer-triggers/FileReferenceTrigger.js";
import { displayPodName, inferPodName } from "../lib/display-name.js";
import { copyText } from "../lib/copy-text.js";
import { useSelectedHostId } from "../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../lib/host-param.js";
// V0.3.1 切片 25 后续 —— 此处不再导入活动辅助函数
//（LiveNodeCurrentState 已移除；SeatOverviewTable + StatusSection
// 拥有自己的活动渲染路径）。
import {
  buildTopologySessionIndex,
  type TopologyActivityVisual,
} from "../lib/topology-activity.js";
import { getRestoreStatusColorClass } from "../lib/restore-status-colors.js";
import type { AgentSpecReview } from "../hooks/useSpecReview.js";
import { RuntimeBadge, ToolMark } from "./graphics/RuntimeMark.js";
import { postOpenCmux } from "../hooks/useCmuxLaunch.js";

type Tab = "overview" | "details";

interface LiveNodeDetailsProps {
  rigId: string;
  logicalId: string;
}

const SECTION_CLASS = "border border-outline-variant bg-surface-lowest/30 p-3";

function statusColor(status: string | null): string {
  switch (status) {
    case "ready": return "text-green-600";
    case "pending": return "text-amber-600";
    case "attention_required": return "text-orange-600";
    case "failed": return "text-red-600";
    default: return "text-on-surface-variant";
  }
}

function startupStatusLabel(status: string | null): string {
  switch (status) {
    case "attention_required": return "需要关注";
    default: return status ?? "已停止";
  }
}

function resolveAgentName(agentRef: string | null): string | null {
  if (!agentRef) return null;
  const match = agentRef.match(/^local:agents\/([^/]+)$/);
  return match?.[1] ?? null;
}

function InfoRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="flex justify-between gap-3 font-mono text-[10px]">
      <span className="text-on-surface-variant">{label}</span>
      <span className="truncate text-right text-on-surface">{value}</span>
    </div>
  );
}

function AgentSpecSection({ data }: { data: NodeDetailData }) {
  const agentName = resolveAgentName(data.agentRef);
  const { data: agentEntries = [], isLoading: entriesLoading } = useSpecLibrary("agent");

  const matches = agentName
    ? agentEntries.filter((entry) => entry.name === agentName)
    : [];

  const entryId = matches.length === 1 ? matches[0]!.id : null;
  const { data: review, isLoading: reviewLoading } = useLibraryReview(entryId);

  return (
    <div data-testid="live-agent-spec-section" className="space-y-4">
      {data.compactSpec.name && (
        <section data-testid="detail-compact-spec" className={SECTION_CLASS}>
          <div className="mb-2 font-mono text-[8px] uppercase tracking-wider text-on-surface-variant">已解析智能体规格</div>
          <div className="space-y-0.5">
            <InfoRow label="规格" value={data.compactSpec.name} />
            <InfoRow label="版本" value={data.compactSpec.version} />
            <InfoRow label="配置" value={data.compactSpec.profile} />
            <InfoRow label="技能" value={data.compactSpec.skillCount} />
            <InfoRow label="指引" value={data.compactSpec.guidanceCount} />
          </div>
        </section>
      )}

      {!agentName ? (
        <div data-testid="agent-spec-unavailable" className="p-4 font-mono text-[10px] text-on-surface-variant">无可用智能体规格</div>
      ) : entriesLoading || reviewLoading ? (
        <div className="p-4 font-mono text-[10px] text-on-surface-variant">正在加载智能体规格…</div>
      ) : matches.length === 0 ? (
        <div data-testid="agent-spec-unavailable" className="p-4 font-mono text-[10px] text-on-surface-variant">无可用智能体规格</div>
      ) : matches.length > 1 ? (
        <div data-testid="agent-spec-ambiguous" className="p-4 font-mono text-[10px] text-amber-600">
          智能体规格不明确（{agentName} 有 {matches.length} 个匹配）
        </div>
      ) : !review || review.kind !== "agent" ? (
        <div data-testid="agent-spec-unavailable" className="p-4 font-mono text-[10px] text-on-surface-variant">无可用智能体规格</div>
      ) : (
        <>
          <AgentSpecDisplay
            review={review as AgentSpecReview}
            yaml={review.raw}
            testIdPrefix="live-agent"
            sourcePath={review.sourcePath}
          />
          {/* 切片 3.3 fix-B —— 插件部分位于 AgentSpecDisplay
             （其中渲染技能等）和周围标签页的启动文件块之间。
              防御性地从审阅提取插件 ID：该字段由 plugin-primitive-v0
              上的批次 1 所有；在 main 上渲染空态，合并后渲染填充态。 */}
          <section
            data-testid="live-agent-plugins-section"
            className="border border-outline-variant bg-surface-lowest/30 p-3"
          >
            <div className="mb-2 font-mono text-[8px] uppercase tracking-wider text-on-surface-variant">
              插件
            </div>
            <AgentPluginsList pluginIds={extractAgentPluginIds(review)} />
          </section>
        </>
      )}
    </div>
  );
}

// 切片 3.3 fix-B —— 防御性地从智能体审阅读取插件 ID。
// 在 main 上未合并批次 1 时，AgentSpecReview 没有
// resources.plugins；我们通过鸭子类型 any-cast 读取，使该字段可选。
// 合并入 plugin-primitive-v0 后，类型化的
// resources.plugins[] 自然填充。该函数也容忍简写字符串形式，
// 以向前兼容未来的 agent.yaml 形状。
function extractAgentPluginIds(review: unknown): string[] {
  if (!review || typeof review !== "object") return [];
  const resources = (review as Record<string, unknown>)["resources"];
  if (!resources || typeof resources !== "object") return [];
  const plugins = (resources as Record<string, unknown>)["plugins"];
  if (!Array.isArray(plugins)) return [];
  const ids: string[] = [];
  for (const p of plugins) {
    if (p && typeof p === "object" && typeof (p as Record<string, unknown>).id === "string") {
      ids.push((p as Record<string, unknown>).id as string);
    } else if (typeof p === "string") {
      ids.push(p);
    }
  }
  return ids;
}

function ActionButtonsRow({ rigId, logicalId, data }: { rigId: string; logicalId: string; data: NodeDetailData }) {
  // OPR.0.4.6.MH2 rev1-r2 B1：这里的每个按钮都是本地操作（cmux-open
  // POST，以及本主机会话的 tmux-attach / resume 命令）。选择远端主机时，
  // 这一行会如实显示只读标记；对远端主机执行操作属于 MH-3/MH-4。
  const actionsAreRemote = useSelectedHostId() !== LOCAL_HOST_ID;
  const handleCopyAttach = async () => {
    if (data.tmuxAttachCommand) await copyText(data.tmuxAttachCommand);
  };
  const handleOpenCmux = async () => {
    try {
      await postOpenCmux({ rigId, logicalId });
    } catch {
      // 尽力执行即可；失败状态由现有连接状态提示承担。
    }
  };
  const handleCopyResume = async () => {
    if (data.resumeCommand) await copyText(data.resumeCommand);
  };
  if (actionsAreRemote) {
    return (
      <div
        data-testid="live-node-actions-remote-readonly"
        data-remote-readonly="true"
        className="font-mono text-[9px] uppercase tracking-wide text-on-surface-variant"
      >
        只读——远端主机
      </div>
    );
  }
  return (
    <div data-testid="live-node-actions" className="flex flex-wrap gap-2">
      <button
        onClick={handleOpenCmux}
        data-testid="detail-cmux-open"
        className="inline-flex min-h-11 items-center gap-1.5 px-3 py-2 border border-outline-variant bg-surface-lowest/30 font-mono text-[10px] uppercase tracking-wide text-on-surface hover:bg-surface-low/60"
      >
        <ToolMark tool="cmux" size="sm" />
        打开 CMUX
      </button>
      {data.tmuxAttachCommand && (
        <button
          onClick={handleCopyAttach}
          data-testid="detail-copy-attach"
          className="inline-flex min-h-11 items-center gap-1.5 px-3 py-2 border border-outline-variant bg-surface-lowest/30 font-mono text-[10px] uppercase tracking-wide text-on-surface hover:bg-surface-low/60"
        >
          <ToolMark tool="tmux" size="sm" />
          复制 tmux attach 命令
        </button>
      )}
      {data.resumeCommand && (
        <button
          onClick={handleCopyResume}
          data-testid="detail-copy-resume"
          className="inline-flex min-h-11 items-center gap-1.5 px-3 py-2 border border-outline-variant bg-surface-lowest/30 font-mono text-[10px] uppercase tracking-wide text-on-surface hover:bg-surface-low/60"
        >
          <CirclePlay aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={1.5} />
          复制恢复命令
        </button>
      )}
    </div>
  );
}

function StatusSection({ data }: { data: NodeDetailData }) {
  const showFailure =
    data.startupStatus === "failed" ||
    data.startupStatus === "attention_required" ||
    !!data.latestError;
  return (
    <section
      data-testid="live-node-status"
      className="grid gap-2 border border-outline-variant bg-surface-lowest/30 p-3 sm:grid-cols-2"
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[8px] uppercase tracking-wider text-on-surface-variant">启动</span>
        <span className={statusColor(data.startupStatus)} data-testid="detail-startup-status">
          {startupStatusLabel(data.startupStatus)}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[8px] uppercase tracking-wider text-on-surface-variant">恢复</span>
        <span
          className={`font-mono text-xs font-bold ${getRestoreStatusColorClass(data.restoreOutcome)}`}
          data-testid="detail-restore-outcome"
        >
          {data.restoreOutcome}
        </span>
      </div>
      {showFailure && (
        <div
          className={`sm:col-span-2 mt-1 p-2 border ${
            data.startupStatus === "attention_required"
              ? "bg-orange-50 border-orange-200"
              : "bg-red-50 border-red-200"
          }`}
          data-testid="detail-failure-banner"
        >
          <div
            className={`font-mono text-[9px] font-bold mb-1 ${
              data.startupStatus === "attention_required" ? "text-orange-700" : "text-red-700"
            }`}
          >
            {data.startupStatus === "attention_required"
              ? "需要关注"
              : data.startupStatus === "failed"
                ? "启动失败"
                : "错误"}
          </div>
          {data.latestError && (
            <div
              className={`font-mono text-[9px] mb-1 ${
                data.startupStatus === "attention_required" ? "text-orange-700" : "text-red-600"
              }`}
            >
              {data.latestError}
            </div>
          )}
          <div className="font-mono text-[8px] text-on-surface-variant">
            {data.startupStatus === "attention_required"
              ? `使用 zrig capture ${data.canonicalSessionName ?? "<session>"} 检查提示，然后 zrig send ${data.canonicalSessionName ?? "<session>"} 清除它。`
              : data.startupStatus === "failed"
                ? "用 zrig ps --nodes --rig <name> 检查日志，或用 zrig up 重启"
                : "尝试：zrig restore <snapshotId>"}
          </div>
          {data.recoveryGuidance && (
            <div className="mt-2 border-t border-outline-variant pt-2" data-testid="detail-recovery-guidance">
              <div className="font-mono text-[8px] font-bold text-on-surface mb-1">恢复</div>
              <div className="font-mono text-[8px] text-on-surface-variant mb-1">{data.recoveryGuidance.summary}</div>
              <div className="space-y-0.5 mb-1">
                {data.recoveryGuidance.commands.map((command, index) => (
                  <code key={`${command}-${index}`} className="font-mono text-[8px] text-on-surface bg-surface-low px-1 py-0.5 block">
                    {command}
                  </code>
                ))}
              </div>
              <div className="space-y-0.5">
                {data.recoveryGuidance.notes.map((note, index) => (
                  <div key={`${note}-${index}`} className="font-mono text-[8px] text-on-surface-variant">
                    {note}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// V0.3.1 切片 25 后续 —— LiveNodeCurrentState 已移除。
// 活动现在作为 SeatOverviewTable 中的列；当前工作作为同一表中的全宽行。
// 独立卡片冗余，已从概览标签页移除。移除时 grep 确认
// packages/ui/src/ 中无外部调用者。

function RecentEventsSection({ data }: { data: NodeDetailData }) {
  if (!data.recentEvents || data.recentEvents.length === 0) return null;
  return (
    <section data-testid="live-node-recent-events" className={SECTION_CLASS}>
      <div className="font-mono text-[8px] uppercase tracking-wider text-on-surface-variant mb-2">
        最近事件
      </div>
      <div className="space-y-0.5">
        {data.recentEvents.slice(0, 10).map((e, i) => (
          <div key={`${e.type}-${i}`} className="font-mono text-[9px] flex justify-between gap-3">
            <span className="text-on-surface truncate">{e.type}</span>
            <span className="text-on-surface-variant ml-2 shrink-0">{e.createdAt}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// V0.3.1 切片 25 —— IdentitySummary 卡片由 SeatOverviewTable 替换
//（概览顶部密集 9 字段信息表；按切片 25 范围修订 7 紧凑行
// + 2 全宽行）。

function EdgesSection({ data }: { data: NodeDetailData }) {
  const { outgoing, incoming } = data.edges;
  if (outgoing.length === 0 && incoming.length === 0) return null;
  return (
    <section data-testid="detail-edges" className={SECTION_CLASS}>
      <div className="font-mono text-[8px] text-on-surface-variant uppercase tracking-wider mb-2">边</div>
      <div className="space-y-0.5 font-mono text-[10px]">
        {outgoing.map((e, i) => (
          <div key={`out-${i}`} className="flex gap-1">
            <span className="text-on-surface-variant">-&gt;</span>
            <span className="text-on-surface-variant">{e.kind}</span>
            <span className="text-on-surface">{e.to?.logicalId ?? "?"}</span>
          </div>
        ))}
        {incoming.map((e, i) => (
          <div key={`in-${i}`} className="flex gap-1">
            <span className="text-on-surface-variant">&lt;-</span>
            <span className="text-on-surface-variant">{e.kind}</span>
            <span className="text-on-surface">{e.from?.logicalId ?? "?"}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function PeersSection({ data }: { data: NodeDetailData }) {
  if (data.peers.length === 0) return null;
  return (
    <section data-testid="detail-peers" className={SECTION_CLASS}>
      <div className="font-mono text-[8px] text-on-surface-variant uppercase tracking-wider mb-2">对等节点</div>
      <div className="space-y-1 font-mono text-[10px]">
        {data.peers.map((p) => (
          <div key={p.logicalId} className="space-y-0">
            <div className="flex justify-between gap-3">
              <span className="text-on-surface">{p.logicalId}</span>
              <span className="text-on-surface-variant">{p.runtime ?? "-"}</span>
            </div>
            {p.canonicalSessionName && (
              <div className="text-[9px] text-on-surface-variant truncate">{p.canonicalSessionName}</div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function ContextUsageSection({ data }: { data: NodeDetailData }) {
  const contextUsage = data.contextUsage;
  return (
    <section data-testid="detail-context-usage" className={SECTION_CLASS}>
      <div className="font-mono text-[8px] text-on-surface-variant uppercase tracking-wider mb-2">上下文</div>
      {contextUsage?.availability === "known" ? (
        <div className="space-y-0.5 font-mono text-[10px]">
          <InfoRow label="已用" value={contextUsage.usedPercentage != null ? `${contextUsage.usedPercentage}%` : null} />
          <InfoRow label="剩余" value={contextUsage.remainingPercentage != null ? `${contextUsage.remainingPercentage}%` : null} />
          <InfoRow label="窗口" value={contextUsage.contextWindowSize?.toLocaleString()} />
          <InfoRow label="输入 token" value={contextUsage.totalInputTokens?.toLocaleString()} />
          <InfoRow label="输出 token" value={contextUsage.totalOutputTokens?.toLocaleString()} />
          <InfoRow label="采样时间" value={contextUsage.sampledAt} />
          {contextUsage.fresh === false && (
            <div className="font-mono text-[9px] text-amber-600 mt-1">过期采样</div>
          )}
        </div>
      ) : (
        <div className="font-mono text-[10px] text-on-surface-variant">
          未知{contextUsage?.reason ? `（${contextUsage.reason}）` : ""}
        </div>
      )}
    </section>
  );
}

// V0.3.1 切片 25 后续 —— 概览标签页。堆叠顺序：
//   1. 通知横幅（仅当存在活跃消息时渲染）
//   2. 信息表（列导向；cwd + 当前工作全宽）
//   3. 内联黑玻璃终端
//   4. 最近事件卡片（底部）
//
// V0.3.1 切片 25 后续-2 —— 概览堆叠：
//   1. SeatNotificationBanner（仅真实告警；普通席位隐藏）
//   2. SeatOverviewTable（列头 + 数据行；垂直网格线）
//   3. SeatOverviewSecondary（cwd + 当前工作，与上方列表视觉分离）
//   4. InlineTerminal（黑玻璃）
//   5. RecentEventsSection（底部）
function OverviewTab({ data, activityVisual }: { data: NodeDetailData; activityVisual?: TopologyActivityVisual | null }) {
  return (
    <div data-testid="live-overview-section" className="space-y-4">
      <SeatNotificationBanner data={data} />
      <SeatOverviewTable data={data} activityVisual={activityVisual} />
      <SeatOverviewSecondary data={data} />
      <InlineTerminal data={data} />
      <RecentEventsSection data={data} />
    </div>
  );
}

// V0.3.1 切片 25 后续 —— 详情标签页。重排为先放
// 启动（操作者首选分流视图），然后
// 规格/拓扑组（AgentSpec + 边 + 对等节点 + 上下文用量
// 详情），最后转录在底部。
function DetailsTab({
  rigId,
  logicalId,
  data,
  isAgent,
}: {
  rigId: string;
  logicalId: string;
  data: NodeDetailData;
  isAgent: boolean;
}) {
  return (
    <div data-testid="live-details-section" className="space-y-4">
      <StartupContent rigId={rigId} logicalId={logicalId} data={data} />
      {isAgent ? <AgentSpecSection data={data} /> : null}
      <EdgesSection data={data} />
      <PeersSection data={data} />
      <ContextUsageSection data={data} />
      <TranscriptContent data={data} />
    </div>
  );
}

// V0.3.1 切片 25 —— 内联黑玻璃终端。渲染与旧终端标签页相同的
// SessionPreviewPane，但直接嵌入概览而非标签页后。黑玻璃
// chrome 类逐字保留，使视觉感受匹配切片 25 前的终端标签页。
function InlineTerminal({ data }: { data: NodeDetailData }) {
  // OPR.0.4.6.MH2 rev1-r2 B1：内联终端是本地会话表面
  //（会话名预览 + 点击转实时可输入 xterm）。在远端选择下，同名本地会话
  // 绝不能渲染在远端席位标签下——改为诚实门控。
  const terminalIsRemote = useSelectedHostId() !== LOCAL_HOST_ID;
  if (terminalIsRemote) {
    return (
      <div
        data-testid="node-detail-terminal-remote-gated"
        className="font-mono text-[10px] text-on-surface-variant p-4"
      >
        远端主机不提供终端——终端流是此主机的本地会话。
        查看远端主机是只读的。
      </div>
    );
  }
  if (!data.canonicalSessionName) {
    return (
      <div className="font-mono text-[10px] text-on-surface-variant p-4">
        无规范会话名；终端预览不可用。
      </div>
    );
  }
  return (
    <div data-testid="live-terminal-shell" className="bg-stone-950/65 text-stone-50 backdrop-blur-sm h-[500px]">
      {/* OPR.0.4.0.1（二轮 QA 裁定）：节点详情内联终端加入
          可复用的渐进式默认静态 → 内部点击转实时模型
          在全局实时终端上限下，而非始终实时无上限的
          FocusedTerminal。terminalKey 是会话范围的，因此注册表跟踪它。
          OPR.0.4.0.39：fit="contain"——此面板给终端一个大的专用
          500px 区域，因此 90x27 镜像放大（有上限）以填充它，居中，
          而非小停在左上角（网格单元格保持默认
          fit-width）。 */}
      <ProgressiveTerminal
        sessionName={data.canonicalSessionName}
        terminalKey={`node-detail:${data.canonicalSessionName}`}
        testIdPrefix="node-detail-terminal"
        fit="contain"
      />
    </div>
  );
}

function StartupContent({ rigId: _rigId, logicalId: _logicalId, data }: { rigId: string; logicalId: string; data: NodeDetailData }) {
  void _rigId; void _logicalId;
  return (
    <div data-testid="live-startup-section" className="space-y-4">
      <StatusSection data={data} />

      {data.infrastructureStartupCommand && (
        <section data-testid="live-node-infra-startup" className={SECTION_CLASS}>
          <div className="font-mono text-[8px] uppercase tracking-wider text-on-surface-variant mb-2">
            启动命令
          </div>
          <code className="font-mono text-[9px] text-on-surface bg-surface-low px-2 py-1 block">
            {data.infrastructureStartupCommand}
          </code>
        </section>
      )}

      {data.startupActions.length > 0 && (
        <section data-testid="live-startup-actions" className={SECTION_CLASS}>
          <div className="font-mono text-[8px] uppercase tracking-wider text-on-surface-variant mb-2">启动操作</div>
          <div className="space-y-1">
            {data.startupActions.map((action, index) => (
              <div key={`${action.type}-${action.value}-${index}`} className="font-mono text-[10px] text-on-surface">
                <span className="text-on-surface-variant">{action.type}:</span> {action.value}
              </div>
            ))}
          </div>
        </section>
      )}

      {data.startupFiles.length > 0 ? (
        <section className="border border-outline-variant bg-surface-lowest/30">
          <div className="px-3 py-2 border-b border-outline-variant font-mono text-xs font-bold">
            启动文件
          </div>
          <ul className="divide-y divide-outline-variant">
            {data.startupFiles.map((f, i) => (
              <li
                key={`${f.path}-${i}`}
                data-testid={`live-startup-file-${f.path}`}
              >
                <FileReferenceTrigger
                  data={{ path: f.path, absolutePath: f.absolutePath }}
                  testId={`live-startup-file-trigger-${f.path}`}
                  className="block w-full px-3 py-2 text-left hover:bg-surface-low/60 transition-colors font-mono text-[10px]"
                >
                  <span className="font-bold underline decoration-dotted decoration-outline">
                    {f.path}
                  </span>
                  <span className="text-on-surface-variant ml-2">({f.deliveryHint})</span>
                  {f.required && (
                    <span className="text-red-500 text-[8px] ml-1">必需</span>
                  )}
                </FileReferenceTrigger>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <div className="font-mono text-[10px] text-on-surface-variant p-4">
          未声明启动文件
        </div>
      )}
    </div>
  );
}

function TranscriptContent({ data }: { data: NodeDetailData }) {
  if (!data.transcript.enabled) {
    return (
      <div data-testid="live-transcript-section" className="font-mono text-[10px] text-on-surface-variant p-4">
        未启用转录捕获
      </div>
    );
  }

  return (
    <div data-testid="live-transcript-section" className="space-y-4">
      <section data-testid="detail-transcript" className={SECTION_CLASS}>
        <div className="font-mono text-xs font-bold mb-2">转录</div>
        <div className="font-mono text-[10px] text-on-surface">{data.transcript.path ?? "已启用"}</div>
        {data.transcript.tailCommand && (
          <button
            type="button"
            onClick={() => copyText(data.transcript.tailCommand!)}
            className="mt-2 w-full border border-outline-variant bg-surface-lowest/40 px-2 py-1 text-left font-mono text-[8px] uppercase text-on-surface hover:bg-surface-low"
          >
            复制 tail 命令
          </button>
        )}
      </section>
    </div>
  );
}

function TabNav({
  tabs,
  activeTab,
  onSelect,
}: {
  tabs: Tab[];
  activeTab: Tab;
  onSelect: (tab: Tab) => void;
}) {
  return (
    <div className="flex gap-1 border-b border-outline-variant" role="tablist" data-testid="live-node-tabs">
      {tabs.map((tab) => (
        <button
          key={tab}
          role="tab"
          aria-selected={activeTab === tab}
          data-testid={`live-tab-${tab}`}
          onClick={() => onSelect(tab)}
          className={`min-h-11 px-3 py-2 font-mono text-[10px] uppercase tracking-wider transition-colors ${
            activeTab === tab
              ? "border-b-2 border-on-surface text-on-surface font-bold -mb-px"
              : "text-on-surface-variant hover:text-on-surface"
          }`}
        >
          {tab.replace("-", " ")}
        </button>
      ))}
    </div>
  );
}

export function LiveNodeDetails({ rigId, logicalId }: LiveNodeDetailsProps) {
  const { data, isLoading, error } = useNodeDetail(rigId, logicalId);
  const sessionIndex = useMemo(() => buildTopologySessionIndex(data ? [{
    nodeId: `${data.rigId}::${data.logicalId}`,
    rigId: data.rigId,
    rigName: data.rigName,
    logicalId: data.logicalId,
    canonicalSessionName: data.canonicalSessionName,
    agentActivity: data.agentActivity ?? null,
    currentQitems: data.currentQitems ?? null,
    startupStatus: data.startupStatus,
    terminalActive: data.terminalActive,
    hasAssignedWork: data.hasAssignedWork ?? false,
    pendingWorkCount: data.pendingWorkCount ?? 0,
  }] : []), [data]);
  const topologyActivity = useTopologyActivity(sessionIndex);
  const activityVisual = data
    ? topologyActivity.getNodeActivity(`${data.rigId}::${data.logicalId}`, {
      agentActivity: data.agentActivity ?? null,
      currentQitems: data.currentQitems ?? null,
      startupStatus: data.startupStatus,
      terminalActive: data.terminalActive,
      hasAssignedWork: data.hasAssignedWork ?? false,
      pendingWorkCount: data.pendingWorkCount ?? 0,
    })
    : null;
  // V0.3.1 切片 25 —— 2 标签页概览/详情重构。默认
  // 标签页是概览，使从拓扑落地的操作者无需切换标签页即可看到
  // 一眼信息表 + 内联终端。
  // 类似切片 12 的项目范围默认标签页翻转
  //（story → overview）。
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const isAgent = data ? data.nodeKind !== "infrastructure" : true;
  const tabs: Tab[] = ["overview", "details"];

  return (
    <WorkspacePage>
      <div data-testid="live-node-details" className="space-y-4">
        <WorkflowHeader
          eyebrow="实时节点详情"
          title={data?.canonicalSessionName ?? logicalId}
          description={`${data?.rigName ?? rigId} / ${data?.podNamespace ?? inferPodName(logicalId) ?? displayPodName(data?.podId ?? null)} / ${logicalId}`}
          actions={data ? (
            <RuntimeBadge
              runtime={data.runtime}
              model={data.model}
              size="sm"
              compact
              className="bg-surface-lowest/40 backdrop-blur-sm"
            />
          ) : null}
        />

        {isLoading && <div className="font-mono text-[10px] text-on-surface-variant">正在加载…</div>}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 font-mono text-[10px] text-red-700">
            {(error as Error).message}
          </div>
        )}

        {data && (
          <>
            <ActionButtonsRow rigId={rigId} logicalId={logicalId} data={data} />
            <TabNav tabs={tabs} activeTab={activeTab} onSelect={setActiveTab} />
            <div data-testid="live-node-tab-body" className="space-y-4">
              {activeTab === "overview" && <OverviewTab data={data} activityVisual={activityVisual} />}
              {activeTab === "details" && (
                <DetailsTab rigId={rigId} logicalId={logicalId} data={data} isAgent={isAgent} />
              )}
            </div>
          </>
        )}
      </div>
    </WorkspacePage>
  );
}
