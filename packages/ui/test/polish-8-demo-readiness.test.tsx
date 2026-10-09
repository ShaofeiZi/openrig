import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("polish-8 demo-readiness source guards", () => {
  it("LiveNodeDetails uses tab-owned body content and compact terminal preview", () => {
    const src = read("../src/components/LiveNodeDetails.tsx");
    expect(src).not.toContain("LiveIdentityDisplay");
    expect(src).toContain("data-testid=\"live-node-tab-body\"");
    // OPR.0.4.0.1：内联终端使用可复用渐进组件（默认静态，在全局上限内点击转实时），
    // 而不是直接使用始终在线的 FocusedTerminal。
    expect(src).toContain("ProgressiveTerminal");
    expect(src).toContain("bg-stone-950/65");
  });

  it("TimelineTab renders a newest-first connected step tree", () => {
    const src = read("../src/components/slices/tabs/TimelineTab.tsx");
    expect(src).toContain("data-testid=\"story-step-tree\"");
    expect(src).toContain("data-order=\"newest-first\"");
    expect(src).toContain("story-step-connector");
    expect(src).toContain("timestampSortValue(b.ts) - timestampSortValue(a.ts)");
  });

  it("Slice Overview and Artifacts are distinct surfaces", () => {
    const src = read("../src/components/project/ScopePages.tsx");
    // OPR.0.4.6.MH2 守卫 B1：签名新增 remoteGated 门禁。
    expect(src).toContain("function SliceOverviewTab({ detail, remoteGated }");
    expect(src).toContain("slice-overview-summary");
    // OPR.0.4.1 AC-4-FF：slice 的产物表面就是 ArtifactsNavigator（slice 高度的文件导航器）；
    // 原有文件/提交/文档/决策卡片墙（SliceArtifactsTab）已移除——提交标记为 0.4.2，
    // 决策放在故事中。OPR.0.4.6.MH2 守卫 B1：挂载新增“选择已知”文件门禁。
    expect(src).toContain("<ArtifactsNavigator scopePath={filesAllowed ? detail.slicePath : null}");
    expect(src).not.toContain("function SliceArtifactsTab");
    expect(src).not.toContain("slice-artifacts-commits");
  });

  it("TopologyTab reaches the React Flow workflow graph instead of the adjacency panel", () => {
    const topologySrc = read("../src/components/slices/tabs/TopologyTab.tsx");
    const graphSrc = read("../src/components/slices/tabs/SliceWorkflowGraph.tsx");
    expect(topologySrc).toContain("const runtimeGraph = specGraph ?? deriveRuntimeGraph(affectedRigs);");
    expect(topologySrc).toContain("{runtimeGraph && <SliceWorkflowGraph specGraph={runtimeGraph} />}");
    expect(topologySrc).toContain("function deriveRuntimeGraph");
    expect(topologySrc).not.toContain("function SpecGraphPanel");
    expect(graphSrc).toContain("ReactFlow");
    expect(graphSrc).toContain("dagre.layout");
    expect(graphSrc).toContain("RegistrationMarks");
  });

  it("SliceWorkflowGraph single-sources rendered node dimensions with dagre layout dimensions", () => {
    const graphSrc = read("../src/components/slices/tabs/SliceWorkflowGraph.tsx");
    expect(graphSrc.match(/\b200\b/g) ?? []).toHaveLength(1);
    expect(graphSrc.match(/\b112\b/g) ?? []).toHaveLength(1);
    expect(graphSrc).toContain("style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}");
    expect(graphSrc).not.toContain("w-[200px]");
    expect(graphSrc).not.toContain("h-[112px]");
  });
});
