import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SpecTopologyPreview } from "./SpecTopologyPreview.js";
import { WorkflowCodePreview } from "./WorkflowScaffold.js";
import type { RigSpecReview } from "../hooks/useSpecReview.js";
import { RuntimeBadge } from "./graphics/RuntimeMark.js";
// V1 attempt-3 Phase 5 P5-1：pod 成员的 agentRef 单元格改为用 SubSpecTrigger
// 包裹——点击 → 抽屉中打开 SubSpecPreview（被引用的 agent 规格）。遵循
// content-drawer.md L31 的子规格自动打开触发器约定。
import { SubSpecTrigger } from "./drawer-triggers/SubSpecTrigger.js";

// agentRef 形态示例："local:agents/impl"、"local:agents/orch-lead"、
// "fork:agents/qa@0.2.0"、"builtin:agents/driver"。agents/ 之后的一段是规格名；
// agents/ 之前的全部内容是来源限定符。
function parseAgentRef(agentRef: string): { specName: string; source: "builtin" | "user_file" | "fork" } {
  const trimmed = agentRef.startsWith("local:") ? agentRef.slice("local:".length) : agentRef;
  const stripQual = trimmed.replace(/^(builtin|user|fork):/, "");
  const after = stripQual.startsWith("agents/") ? stripQual.slice("agents/".length) : stripQual;
  const specName = after.split("@")[0] ?? after;
  const source = agentRef.startsWith("fork:")
    ? "fork"
    : agentRef.startsWith("builtin:")
      ? "builtin"
      : "user_file";
  return { specName, source };
}

type Tab = "topology" | "configuration" | "environment" | "yaml";

// 标签页展示文案（Tab 枚举本身与 testid 保留英文）。
const TAB_LABELS: Record<Tab, string> = {
  topology: "拓扑",
  configuration: "配置",
  environment: "环境",
  yaml: "YAML",
};

interface MemberInfo {
  id: string;
  agentRef: string;
  runtime: string;
  profile?: string;
}

interface RigSpecDisplayProps {
  review?: RigSpecReview | null;
  yaml: string;
  testIdPrefix?: string;
  yamlTestId?: string;
  showEnvironmentTab?: boolean;
  onMemberClick?: (podId: string, member: MemberInfo) => void;
}

export function RigSpecDisplay({ review, yaml, testIdPrefix = "", yamlTestId, showEnvironmentTab, onMemberClick }: RigSpecDisplayProps) {
  const showEnv = showEnvironmentTab && !!review?.services;
  const tabs: Tab[] = showEnv
    ? ["topology", "configuration", "environment", "yaml"]
    : ["topology", "configuration", "yaml"];
  const [activeTab, setActiveTab] = useState<Tab>("topology");
  const reviewPods = review?.pods ?? [];
  const reviewNodes = review?.nodes ?? [];
  const reviewEdges = review?.edges ?? [];
  const prefix = testIdPrefix ? `${testIdPrefix}-` : "";

  return (
    <>
      {/* 标签页 */}
      <div className="flex gap-1 border-b border-outline-variant">
        {tabs.map((tab) => (
          <button
            key={tab}
            data-testid={`${prefix}tab-${tab}`}
            onClick={() => setActiveTab(tab)}
            className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
              activeTab === tab
                ? "border-b-2 border-on-surface text-on-surface font-bold"
                : "text-on-surface-variant hover:text-on-surface"
            }`}
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </div>

      {/* 标签页内容 */}
      {activeTab === "topology" && review && (
        <SpecTopologyPreview graph={review.graph} testId={`${prefix}topology-preview`} />
      )}

      {activeTab === "configuration" && review && (
        <div data-testid={`${prefix}config-tables`} className="space-y-4">
          {review.format === "pod_aware" && reviewPods.map((pod) => (
            <div key={pod.id} className="border border-outline-variant p-3">
              <div className="font-mono text-xs font-bold mb-2">{pod.label ?? pod.id}</div>
              <table className="w-full font-mono text-[10px]">
                <thead>
                  <tr className="border-b border-outline-variant text-on-surface-variant">
                    <th className="text-left py-1">成员</th>
                    <th className="text-left py-1">智能体引用</th>
                    <th className="text-left py-1">运行时</th>
                    <th className="text-left py-1">档案</th>
                  </tr>
                </thead>
                <tbody>
                  {pod.members.map((m) => (
                    <tr key={m.id} className="border-b border-outline-variant">
                      <td className="py-1">
                        <div className="flex items-center gap-2">
                          <span>{m.id}</span>
                          {onMemberClick && (
                            <Button
                              variant="outline"
                              size="sm"
                              data-testid={`${prefix}member-open-agent-${pod.id}-${m.id}`}
                              className="h-6 px-2 font-mono text-[9px] uppercase tracking-[0.12em]"
                              onClick={() => onMemberClick(pod.id, m)}
                            >
                              智能体规格
                            </Button>
                          )}
                        </div>
                      </td>
                      <td className="py-1 text-on-surface-variant">
                        {(() => {
                          const parsed = parseAgentRef(m.agentRef);
                          return (
                            <SubSpecTrigger
                              data={{
                                specKind: "agent",
                                specName: parsed.specName,
                                source: parsed.source,
                              }}
                              testId={`${prefix}member-sub-spec-${pod.id}-${m.id}`}
                              className="text-on-surface-variant underline decoration-dotted decoration-outline hover:text-on-surface hover:decoration-on-surface"
                            >
                              {m.agentRef}
                            </SubSpecTrigger>
                          );
                        })()}
                      </td>
                      <td className="py-1">
                        <RuntimeBadge runtime={m.runtime} size="xs" compact variant="inline" />
                      </td>
                      <td className="py-1 text-on-surface-variant">{m.profile ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          {review.format === "legacy" && reviewNodes.length > 0 && (
            <div className="border border-outline-variant p-3">
              <div className="font-mono text-xs font-bold mb-2">节点</div>
              <table className="w-full font-mono text-[10px]">
                <thead>
                  <tr className="border-b border-outline-variant text-on-surface-variant">
                    <th className="text-left py-1">ID</th>
                    <th className="text-left py-1">运行时</th>
                    <th className="text-left py-1">角色</th>
                  </tr>
                </thead>
                <tbody>
                  {reviewNodes.map((n) => (
                    <tr key={n.id} className="border-b border-outline-variant">
                      <td className="py-1">{n.id}</td>
                      <td className="py-1">
                        <RuntimeBadge runtime={n.runtime} size="xs" compact variant="inline" />
                      </td>
                      <td className="py-1 text-on-surface-variant">{n.role ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {reviewEdges.length > 0 && (
            <div className="border border-outline-variant p-3">
              <div className="font-mono text-xs font-bold mb-2">
                {review.format === "pod_aware" ? "跨 Pod 边" : "边"}
              </div>
              <table className="w-full font-mono text-[10px]">
                <thead>
                  <tr className="border-b border-outline-variant text-on-surface-variant">
                    <th className="text-left py-1">起点</th>
                    <th className="text-left py-1">终点</th>
                    <th className="text-left py-1">类型</th>
                  </tr>
                </thead>
                <tbody>
                  {reviewEdges.map((e, i) => (
                    <tr key={i} className="border-b border-outline-variant">
                      <td className="py-1">{e.from}</td>
                      <td className="py-1">{e.to}</td>
                      <td className="py-1 text-on-surface-variant">{e.kind}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === "environment" && showEnv && review?.services && (
        <div className="space-y-4" data-testid={`${prefix}env-details`}>
          <div className="space-y-2">
            <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-on-surface-variant">服务</div>
            {review.services.composePreview?.services.map((svc) => (
              <div key={svc.name} className="flex items-center justify-between border border-outline-variant px-3 py-2">
                <span className="font-mono text-[11px] text-on-surface">{svc.name}</span>
                {svc.image && <span className="font-mono text-[9px] text-on-surface-variant">{svc.image}</span>}
              </div>
            ))}
          </div>

          {review.services.waitFor.length > 0 && (
            <div className="space-y-2">
              <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-on-surface-variant">健康检查门</div>
              {review.services.waitFor.map((w, i) => (
                <div key={i} className="font-mono text-[10px] text-on-surface-variant border border-outline-variant px-3 py-2">
                  {w.url && <span>{w.url}</span>}
                  {w.tcp && <span>tcp: {w.tcp}</span>}
                  {w.service && <span>service: {w.service}{w.condition ? ` (${w.condition})` : ""}</span>}
                </div>
              ))}
            </div>
          )}

          {review.services.surfaces && (
            <div className="space-y-2">
              <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-on-surface-variant">界面入口</div>
              {review.services.surfaces.urls?.map((u) => (
                <div key={u.name} className="flex items-center justify-between border border-outline-variant px-3 py-2">
                  <span className="text-[11px] text-on-surface">{u.name}</span>
                  <span className="font-mono text-[9px] text-on-surface-variant">{u.url}</span>
                </div>
              ))}
              {review.services.surfaces.commands?.map((cmd) => (
                <div key={cmd.name} className="flex items-center justify-between border border-outline-variant px-3 py-2">
                  <span className="text-[11px] text-on-surface">{cmd.name}</span>
                  <span className="font-mono text-[9px] text-on-surface-variant">{cmd.command}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "yaml" && (
        <WorkflowCodePreview title="YAML 预览" testId={yamlTestId ?? `${prefix}spec-yaml`}>
          {yaml}
        </WorkflowCodePreview>
      )}
    </>
  );
}
