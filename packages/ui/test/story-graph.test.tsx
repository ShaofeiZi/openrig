import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import storyGraphCss from "../src/components/project/StoryGraph.css?raw";
import { StoryGraph } from "../src/components/project/StoryGraph.js";
import { QueueItemViewer } from "../src/components/drawer-viewers/QueueItemViewer.js";
import { DrawerSelectionContext } from "../src/components/AppShell.js";
import { buildStoryForest, type StoryQitemInput } from "../src/lib/story-graph-model.js";

afterEach(cleanup);

function qitem(p: Partial<StoryQitemInput> & { qitemId: string }): StoryQitemInput {
  return {
    tsCreated: "2026-06-23T02:00:00.000Z",
    tsUpdated: "2026-06-23T02:00:00.000Z",
    sourceSession: "dev1-planner@openrig-delivery",
    destinationSession: "dev1-driver@openrig-delivery",
    state: "done",
    closureReason: "no-follow-on",
    tags: [],
    body: "agent-speak body\nmore detail",
    summary: null,
    chainOfRecord: null,
    handedOffFrom: null,
    handedOffTo: null,
    ...p,
  };
}

describe("StoryGraph", () => {
  it("renders the empty state when there are no nodes", () => {
    const { getByTestId } = render(<StoryGraph forest={buildStoryForest([])} />);
    expect(getByTestId("story-graph-empty")).toBeTruthy();
  });

  it("renders one clean row per node with the real state and a calendar date (not time-only)", () => {
    const forest = buildStoryForest([
      qitem({ qitemId: "root", chainOfRecord: null, body: "Mission kickoff (origin)" }),
      qitem({
        qitemId: "child",
        chainOfRecord: ["root"],
        state: "in-progress",
        body: "Building the harness",
        tsCreated: "2026-06-23T03:00:00.000Z",
      }),
    ]);
    const { getByTestId } = render(<StoryGraph forest={forest} />);
    const rootRow = getByTestId("story-row-root");
    const childRow = getByTestId("story-row-child");
    expect(within(rootRow).getByText("Mission kickoff (origin)")).toBeTruthy();
    // 真实 qitem 状态，绝不虚构 "merged" 数据状态
    expect(within(childRow).getByText("进行中")).toBeTruthy();
    // date cell 显示日历日期（月 + 日）+ 时间，绝不显示
    // 仅时间 / 相对 "Today"/"Yesterday" 标签（tz 鲁棒形状检查）
    expect(rootRow.textContent).toMatch(/[A-Za-z]{3}\s+\d{1,2}/);
    expect(rootRow.textContent).toMatch(/\d{1,2}:\d{2}/);
    expect(rootRow.textContent).not.toMatch(/today|yesterday/i);
  });

  it("marks the human-origin lane and expands a row into the full-width bands + drawer link", () => {
    const forest = buildStoryForest([
      qitem({ qitemId: "spine", chainOfRecord: null, sourceSession: "orch-advisor@openrig-delivery" }),
      qitem({
        qitemId: "human",
        chainOfRecord: null,
        sourceSession: "founder",
        destinationSession: "dev2-driver@openrig-delivery",
        tags: ["human-origin", "terminal-fix"],
        body: "Founder routed a terminal fix to dev2.",
        tsCreated: "2026-06-23T04:00:00.000Z",
      }),
    ]);
    const { getByTestId, queryByTestId } = render(<StoryGraph forest={forest} />);

    // human-origin 行带 lane 样式
    const humanRow = getByTestId("story-row-human").closest(".sg-trow");
    expect(humanRow?.className).toContain("sg-human");

    // 折叠：尚无 detail 面板
    expect(queryByTestId("story-detail-human")).toBeNull();

    // 展开 -> 全宽 band（lineage "◆ this"）+ Tier-3 drawer 链接
    fireEvent.click(getByTestId("story-row-human"));
    const detail = getByTestId("story-detail-human");
    expect(within(detail).getByText("◆ 本节点")).toBeTruthy();
    expect(getByTestId("story-open-human")).toBeTruthy();
    expect(within(detail).getByText("human-origin")).toBeTruthy();
  });

  // 守卫 B3——Tier-2 artifacts 在可看时必须是 OPEN 可点击项，而非 inert 文本。
  it("renders a viewable (absolute-path) artifact as an open affordance; relative refs stay inert", () => {
    const forest = buildStoryForest([
      qitem({
        qitemId: "art",
        chainOfRecord: null,
        body: "shipped /Users/x/proof.png alongside packages/ui/rel.ts",
      }),
    ]);
    const { getByTestId, queryByTestId } = render(<StoryGraph forest={forest} />);
    fireEvent.click(getByTestId("story-row-art"));
    // 绝对路径 -> 可点 FileLink 打开触发
    expect(getByTestId("story-artifact-/Users/x/proof.png")).toBeTruthy();
    // repo 相对路径 -> inert（无打开触发）
    expect(queryByTestId("story-artifact-packages/ui/rel.ts")).toBeNull();
  });

  // 守卫 B2（round 2）——经 DRAWER 路径："Open full queue item" 必须带
  // 完整 detail（chain + 省略的非行字段 claimedAt/targetRepo + fullDetail）。
  it("Open full queue item carries the full detail into the drawer selection", () => {
    const setSelection = vi.fn();
    const forest = buildStoryForest([
      qitem({
        qitemId: "full",
        chainOfRecord: ["root-q"],
        claimedAt: "2026-06-23T02:30:00.000Z",
        targetRepo: "openrig",
        body: "agent-speak body",
      }),
    ]);
    const { getByTestId } = render(
      <DrawerSelectionContext.Provider value={{ selection: null, setSelection }}>
        <StoryGraph forest={forest} />
      </DrawerSelectionContext.Provider>,
    );
    fireEvent.click(getByTestId("story-row-full"));
    fireEvent.click(getByTestId("story-open-full"));
    expect(setSelection).toHaveBeenCalledTimes(1);
    const arg = setSelection.mock.calls[0]![0] as { type: string; data: Record<string, unknown> };
    expect(arg.type).toBe("qitem");
    expect(arg.data.fullDetail).toBe(true);
    expect(arg.data.chain).toContain("root-q");
    expect(arg.data.claimedAt).toBe("2026-06-23T02:30:00.000Z");
    expect(arg.data.targetRepo).toBe("openrig");
  });
});

// 守卫 B2——Tier-3 drawer 必须渲染完整 queue-item detail：所有字段 + 完整 chain。
describe("Story Tier-3 drawer (QueueItemViewer full detail)", () => {
  it("renders all fields + the full chain, with labeled empty-states for nulls", () => {
    const { getByTestId } = render(
      <QueueItemViewer
        qitemId="qitem-Z"
        source="dev1-driver@openrig-delivery"
        destination="dev1-guard@openrig-delivery"
        state="handed-off"
        tags={["slice-19"]}
        createdAt="2026-06-23T02:00:00.000Z"
        updatedAt="2026-06-23T03:00:00.000Z"
        priority="urgent"
        tier="fast"
        closureReason="handed_off_to"
        closureTarget="dev1-guard@openrig-delivery"
        handedOffFrom="qitem-Y"
        targetRepo="openrig"
        chain={["qitem-W", "qitem-Y"]}
        body="full agent-speak body"
        fullDetail
      />,
    );
    expect(getByTestId("qitem-priority").textContent).toContain("urgent");
    expect(getByTestId("qitem-closure").textContent).toContain("handed_off_to");
    expect(getByTestId("qitem-targetrepo").textContent).toContain("openrig");
    const chain = getByTestId("qitem-chain");
    expect(chain.textContent).toContain("qitem-W");
    expect(chain.textContent).toContain("qitem-Y");
    // null 字段在 full-item 视图中显示为 LABELED-EMPTY（"—"），而非隐藏
    expect(getByTestId("qitem-claimed").textContent).toBe("—");
  });
});

// QA 布局阻塞（round）——Tier-2 展开 detail 必须是全宽 band，
// 而非自动放入网格列。jsdom 无法测量布局，故这是 source/CSS 守卫
//（guard 接受）：行必须是块容器（topline 拥有 5 列网格），绝不是把
// detail 自动放入的多列网格。
describe("StoryGraph expanded-detail layout contract (CSS guard)", () => {
  const css = storyGraphCss;
  it(".sg-trow is a block container, not a multi-column grid", () => {
    expect(/\.sg-trow\s*\{[^}]*display:\s*block/.test(css)).toBe(true);
    expect(/\.sg-trow\s*\{[^}]*display:\s*grid/.test(css)).toBe(false);
  });
  it(".sg-topline keeps the 5-column grid (so row cells still lay out across full width)", () => {
    expect(/\.sg-topline\s*\{[^}]*display:\s*grid/.test(css)).toBe(true);
    expect(/\.sg-topline\s*\{[^}]*grid-template-columns:\s*1fr 132px 96px 104px 132px/.test(css)).toBe(true);
  });
});
