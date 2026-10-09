// OPR.0.4.6.WF4（C3b）——形状渲染器的绑定锁定项：
//  - Q-B：handle 分配是边记录的纯函数，通过集合决定的最短路径深度计算；重排 edges 数组
//    得到完全相同的分配（置换不变“单位向量”），双向边对停靠在不同通道，绝不重叠（WF4-F4）。
//  - 零实例：抽取出的组件仍会渲染；缺少叠层属性即基础渲染，增量叠层是唯一依赖实例的表面。

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import {
  WorkflowTopologyGraph,
  computeStepDepths,
  assignEdgeHandles,
} from "../src/components/workflow/WorkflowTopologyGraph.js";
import type { LibraryWorkflowReview } from "../src/hooks/useSpecLibrary.js";

type Topology = LibraryWorkflowReview["topology"];

const node = (stepId: string, over: Partial<Topology["nodes"][number]> = {}): Topology["nodes"][number] => ({
  stepId,
  role: `${stepId}-role`,
  objective: null,
  preferredTarget: null,
  isEntry: false,
  isTerminal: false,
  ...over,
});

// A → B 带一条 B → A 反向分支（修复循环形状，WF4-F4），另有 B → C 正向边；
// B → A 是回边。
const RECIPROCAL: Topology = {
  nodes: [node("A", { isEntry: true }), node("B"), node("C", { isTerminal: true })],
  edges: [
    { fromStepId: "A", toStepId: "B", routingType: "direct" },
    { fromStepId: "B", toStepId: "A", routingType: "branch", branchOn: "failed" },
    { fromStepId: "B", toStepId: "C", routingType: "direct" },
  ],
};

function handleVector(topology: Topology): Record<string, string> {
  const depth = computeStepDepths(topology);
  const vec: Record<string, string> = {};
  for (const e of topology.edges) {
    const { sourceHandle, targetHandle } = assignEdgeHandles(e.fromStepId, e.toStepId, depth);
    vec[`${e.fromStepId}→${e.toStepId}`] = `${sourceHandle}|${targetHandle}`;
  }
  return vec;
}

afterEach(() => cleanup());

describe("WF-4 Q-B: pure handle assignment", () => {
  it("computeStepDepths is shortest-path from entry (A=0, B=1, C=2)", () => {
    const d = computeStepDepths(RECIPROCAL);
    expect(d.get("A")).toBe(0);
    expect(d.get("B")).toBe(1);
    expect(d.get("C")).toBe(2);
  });

  it("a forward edge docks the top/bottom lane; a back-edge docks the side lane", () => {
    const d = computeStepDepths(RECIPROCAL);
    expect(assignEdgeHandles("A", "B", d)).toEqual({ sourceHandle: "out-bottom", targetHandle: "in-top" });
    // B → A 向上（A 深度小于 B），因此走侧通道而非正向通道。
    expect(assignEdgeHandles("B", "A", d)).toEqual({ sourceHandle: "out-side", targetHandle: "in-side" });
  });

  it("a reciprocal pair docks DISTINCT lanes (WF4-F4: no overlap into one line)", () => {
    const d = computeStepDepths(RECIPROCAL);
    const forward = assignEdgeHandles("A", "B", d);
    const back = assignEdgeHandles("B", "A", d);
    expect(forward).not.toEqual(back);
  });

  it("PERMUTATION-INVARIANT — the full handle vector is identical for any edge ORDER (same edge SET)", () => {
    const original = handleVector(RECIPROCAL);
    // 反转 edges 数组，集合保持不变。
    const permuted: Topology = { nodes: RECIPROCAL.nodes, edges: [...RECIPROCAL.edges].reverse() };
    expect(handleVector(permuted)).toEqual(original);
    // 再做一次轮换。
    const rotated: Topology = {
      nodes: RECIPROCAL.nodes,
      edges: [RECIPROCAL.edges[2]!, RECIPROCAL.edges[0]!, RECIPROCAL.edges[1]!],
    };
    expect(handleVector(rotated)).toEqual(original);
  });

  it("computeStepDepths itself is edge-order-independent", () => {
    const a = computeStepDepths(RECIPROCAL);
    const b = computeStepDepths({ nodes: RECIPROCAL.nodes, edges: [...RECIPROCAL.edges].reverse() });
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });
});

describe("WF-4: the extracted renderer", () => {
  it("renders the shape canvas with ZERO instance-overlay props (the base/zero-instance render)", () => {
    const { getByTestId } = render(<WorkflowTopologyGraph topology={RECIPROCAL} />);
    expect(getByTestId("workflow-topology-graph")).toBeTruthy();
  });

  it("renders with instance-overlay props (current/visited/taken) without crashing", () => {
    const { getByTestId } = render(
      <WorkflowTopologyGraph
        topology={RECIPROCAL}
        currentStepId="B"
        visitedStepIds={["A"]}
        takenEdgeKeys={["A→B"]}
      />,
    );
    expect(getByTestId("workflow-topology-graph")).toBeTruthy();
  });
});
