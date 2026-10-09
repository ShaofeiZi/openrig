// 切片故事视图 v0 + v1 —— 拓扑标签页。
//
// v0：按工作组分组的每工作组会话名列表，可点击跳转到主拓扑表面。
// 该标签页保持只读当前状态视图，链接到规范拓扑表面以进行更深入操作。
//
// v1 维度 #1：当 workflow_instance 绑定到切片时，渲染规格图
//（每个规格步骤一个节点；边来自每个步骤的 next_hop.suggested_roles）。
// 与 v0 每工作组列表组合。当前步骤高亮，入口步骤标记，
// 终止步骤标记，回路边与前向边样式不同。
//
// v1 维度 #4：边携带 routingType 字段。D 阶段规格格式尚无 routing_type
// 元数据字段（按 PRD 的 audit-row-6 carve-out），因此 v1 时所有边为
// routingType=`direct`。样式区分回环 vs 前向；更丰富的路由类型样式
//（artifact-pool、async、fan-out 等）是 v2+ 的领域。

import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { SliceDetail, SpecGraphPayload } from "../../../hooks/useSlices.js";
import { ProgressiveTerminal } from "../../terminal/ProgressiveTerminal.js";
import { SliceWorkflowGraph } from "./SliceWorkflowGraph.js";
import { useSelectedHostId } from "../../../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../../../lib/host-param.js";

export function TopologyTab({ topology }: { topology: SliceDetail["topology"] }) {
  const { affectedRigs, totalSeats, specGraph } = topology;
  const runtimeGraph = specGraph ?? deriveRuntimeGraph(affectedRigs);
  const hasAnything = affectedRigs.length > 0 || specGraph !== null;
  if (!hasAnything) {
    return (
      <div className="p-4 font-mono text-[10px] text-on-surface-variant" data-testid="topology-empty">
        此切片的 qitem 链未找到席位。
      </div>
    );
  }
  return (
    <div data-testid="topology-tab" className="p-4 space-y-4">
      <header className="flex items-center justify-between border-b border-outline-variant pb-2">
        <div className="font-mono text-[11px] uppercase tracking-[0.12em] text-on-surface">
          工作流
        </div>
        <div className="font-mono text-[10px] text-on-surface-variant" data-testid="topology-aggregate">
          {totalSeats} 个席位
          {" · "}{affectedRigs.length} 个工作组
          {specGraph && (
            <>
              {" · 规格 "}
              <span data-testid="topology-spec-name">{specGraph.specName}</span>
              {" v"}{specGraph.specVersion}
            </>
          )}
        </div>
      </header>

      {runtimeGraph && <SliceWorkflowGraph specGraph={runtimeGraph} />}

      {affectedRigs.length > 0 && (
        <div data-testid="topology-rig-listing" className="space-y-3">
          {runtimeGraph && (
            <div className="font-mono text-[10px] uppercase tracking-[0.10em] text-on-surface-variant">
              活跃席位
            </div>
          )}
          {affectedRigs.map((rig) => (
            <section
              key={rig.rigName}
              data-testid={`topology-rig-${rig.rigName}`}
              className="border border-outline-variant bg-surface-lowest"
            >
              <header className="flex items-center justify-between border-b border-outline-variant bg-background px-3 py-2">
                <div className="font-mono text-[10px] font-bold text-on-surface">{rig.rigName}</div>
                <Link
                  to="/rigs/$rigId"
                  params={{ rigId: rig.rigId }}
                  data-testid={`topology-rig-${rig.rigName}-open`}
                  className="font-mono text-[9px] uppercase tracking-[0.10em] text-blue-700 hover:underline"
                >
                  打开拓扑 →
                </Link>
              </header>
              <ul className="divide-y divide-outline-variant">
                {rig.sessionNames.map((session) => (
                  <SeatRow key={session} session={session} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function deriveRuntimeGraph(affectedRigs: SliceDetail["topology"]["affectedRigs"]): SpecGraphPayload | null {
  if (affectedRigs.length === 0) return null;
  const nodes = affectedRigs.map((rig, index) => ({
    stepId: rig.rigName || rig.rigId || `rig-${index + 1}`,
    label: rig.rigName || rig.rigId || `Rig ${index + 1}`,
    role: `${rig.sessionNames.length} 个席位`,
    preferredTarget: rig.sessionNames[0] ?? null,
    isEntry: index === 0,
    isCurrent: index === affectedRigs.length - 1,
    isTerminal: index === affectedRigs.length - 1,
  }));
  return {
    specName: "runtime-handoff-map",
    specVersion: "derived",
    nodes,
    edges: nodes.slice(0, -1).map((node, index) => ({
      fromStepId: node.stepId,
      toStepId: nodes[index + 1]!.stepId,
      routingType: "direct",
      isLoopBack: false,
    })),
  };
}

// 预览终端 v0（PL-018）—— 可点击的席位行。
// 点击切换席位的内联预览，使用会话键控预览别名。需要持久/多固定行为的
// 操作者从节点详情抽屉固定（独立流程）。
function SeatRow({ session }: { session: string }) {
  const [open, setOpen] = useState(false);
  // OPR.0.4.6.MH2 rev1-r2 B1：内联预览是本地会话名读取
  //（ProgressiveTerminal，点击转实时可输入）——在远端选择下，
  // 席位渲染为纯只读数据，无预览控件，使同名本地会话永不渲染在
  // 远端标签下。
  const seatIsRemote = useSelectedHostId() !== LOCAL_HOST_ID;
  if (seatIsRemote) {
    return (
      <li
        data-testid={`topology-seat-${session}`}
        data-remote-readonly="true"
        className="px-3 py-1"
      >
        <span className="flex w-full items-baseline gap-2 font-mono text-[10px] text-on-surface">
          <span className="flex-1 truncate">{session}</span>
        </span>
      </li>
    );
  }
  return (
    <li
      data-testid={`topology-seat-${session}`}
      data-open={open ? "true" : "false"}
      className="px-3 py-1"
    >
      <button
        type="button"
        data-testid={`topology-seat-${session}-toggle`}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-baseline gap-2 text-left font-mono text-[10px] text-on-surface hover:bg-background -mx-3 px-3 py-0.5"
      >
        <span className="flex-1 truncate">{session}</span>
        <span className="text-on-surface-variant shrink-0">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div data-testid={`topology-seat-${session}-preview`} className="mt-1">
          {/* OPR.0.4.0.1 前瞻修复：共享渐进终端（默认静态 → 点击内部转实时）
              在全局上限下，替代原始静态 SessionPreviewPane。terminalKey 在
              topology-tab 命名空间中是会话范围的，使同一席位在另一表面是
              独立注册表条目（匹配 node-detail:/topology-grid: 模式）。 */}
          <ProgressiveTerminal
            sessionName={session}
            terminalKey={`topology-tab:${session}`}
            testIdPrefix={`topology-preview-${session}`}
          />
        </div>
      )}
    </li>
  );
}
