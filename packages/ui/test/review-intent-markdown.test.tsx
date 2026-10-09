// @vitest-environment jsdom

// qitem-render-driver D1——INTENT / WHAT & WHY 必须以与 PLAN 相同的
// 语义渲染 markdown。
//
// Live-ledger 症状：PLAN 正确渲染 `**bold**` / `[link](url)`（经
// SliceReviewTab.tsx:303-304 的 MarkdownViewer 路由），而每个
// INTENT 类表面插值原始字符串，故 operator 读到字面 markdown 标记。
// 三个确认根因：
//   root-1 SliceReviewTab.tsx:290       slice INTENT           <p>{text}</p>
//   root-2 MissionReviewTab.tsx:306     mission WHAT & WHY     <pre>{text}</pre>
//   root-3 MissionReviewTab.tsx:74      BoardRowExpansion INTENT <pre>{text}</pre>
//
// 每条腿断言与 PLAN 等价的语义（渲染 <strong> + <a>，无字面标记）
// 加 PLAN 用的 hideFrontmatter/hideRawToggle 对等。degrade 锁保持
// 缺 intent 的诚实：null intent 仍须逐字呈现其既有 degrade 串，
// 绝不被 markdown 管线吞掉。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComposedSliceReview, ComposedMissionReview } from "../src/hooks/useReview.js";

// 与 intent 表面无关的 band 被 stub，使每条腿隔离被测 render 根。
// Router Link 需要 RouterProvider；普通 anchor 保持 DOM 形状，
// 而不把 router 上下文拉进 render-semantics 测试。
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children?: React.ReactNode }) => <a {...(rest as Record<string, unknown>)}>{children}</a>,
}));
vi.mock("../src/components/review/NeedsYouAccordion.js", () => ({ NeedsYouAccordion: () => null }));
vi.mock("../src/components/review/AgentsBandView.js", () => ({ AgentsBandView: () => null }));
vi.mock("../src/components/review/VerifyLineageCard.js", () => ({ VerifyLineageCard: () => null }));

const sliceState: { data: ComposedSliceReview | null } = { data: null };
const missionState: { data: ComposedMissionReview | null } = { data: null };
vi.mock("../src/hooks/useReview.js", () => ({
  useSliceReview: () => ({ isLoading: false, isError: false, data: sliceState.data, error: null }),
  useMissionReview: () => ({ isLoading: false, isError: false, data: missionState.data, error: null }),
  useInvalidateReview: () => () => {},
}));
// board expansion 内的 Terminal/chat chrome 与 intent-render
// 断言无关。
vi.mock("../src/components/terminal/ProgressiveTerminal.js", () => ({ ProgressiveTerminal: () => null }));
vi.mock("../src/hooks/useScopeMarkdown.js", () => ({
  useScopeMarkdown: () => ({ resolved: null, isLoading: false }),
}));

import { SliceReviewTab } from "../src/components/review/SliceReviewTab.js";
import { MissionReviewTab } from "../src/components/review/MissionReviewTab.js";

afterEach(() => {
  cleanup();
  sliceState.data = null;
  missionState.data = null;
});

function withQuery(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

/** 每条腿渲染的唯一 authored fixture——bold + link，PLAN 已处理的两种内联形式。 */
const MD = "**bold** and [link](https://x)";

function sliceReview(over: Partial<ComposedSliceReview> = {}): ComposedSliceReview {
  return {
    slice: "s",
    sliceId: null,
    title: "s",
    missionId: "m",
    phase: "spec",
    laneLabel: "PLAN",
    intent: { text: MD, media: [], ssotPath: "m/slices/s/README.md", degrade: null },
    plan: { concise: { text: "1. m", media: [] }, lockedArtifacts: [], lock: null, ssotPath: "m/slices/s/IMPLEMENTATION-PRD.md" },
    delivered: { items: [], extraProof: [], lock: null, proofDirPath: null },
    needsYou: { items: [], provenance: "0" },
    agents: { scope: "slice:s", rows: [], provenance: "0", coordinationHealth: null },
    lineage: { candidateSha: null, mergeSha: null, mainTip: "tip", freshness: "unknown", staleBehind: null, gateCells: [] },
    defects: [],
    composedAt: "2026-07-20T00:00:00.000Z",
    ...over,
  } as ComposedSliceReview;
}

function missionReview(over: Partial<ComposedMissionReview> = {}): ComposedMissionReview {
  return {
    mission: "m",
    missionId: "OPR.M",
    title: "m",
    intent: MD,
    briefSpine: { building: "", progress: "", proven: "", needsYou: "" },
    board: [],
    ledger: [],
    cutComplete: false,
    cutCompleteBasis: "basis",
    needsYou: { items: [], provenance: "0" },
    agents: { scope: "mission:m", rows: [], provenance: "0", coordinationHealth: null },
    composedAt: "2026-07-20T00:00:00.000Z",
    ...over,
  } as ComposedMissionReview;
}

/** 与 PLAN 等价的 markdown 语义，结构化断言。 */
function expectRenderedMarkdown(container: HTMLElement, label: string) {
  expect(container.querySelector("strong"), `${label}: **bold** must render a <strong>`).toBeTruthy();
  const link = container.querySelector('a[href="https://x"]');
  expect(link, `${label}: [link](url) must render an anchor`).toBeTruthy();
  const text = container.textContent ?? "";
  expect(text.includes("**"), `${label}: no literal ** marker may survive`).toBe(false);
  expect(text.includes("]("), `${label}: no literal ]( marker may survive`).toBe(false);
}

/** PLAN 传 hideFrontmatter + hideRawToggle；intent 表面必须匹配。 */
function expectPlanParityChrome(container: HTMLElement, label: string) {
  const raw = container.textContent ?? "";
  expect(/\bRAW\b/i.test(raw), `${label}: no raw-toggle control (hideRawToggle parity)`).toBe(false);
  expect(container.querySelector("[data-testid='markdown-frontmatter']"), `${label}: no frontmatter block (hideFrontmatter parity)`).toBeNull();
}

describe("qitem-render-driver D1 — INTENT surfaces render markdown like PLAN", () => {
  it("root-1 RED: slice INTENT renders markdown (SliceReviewTab)", () => {
    sliceState.data = sliceReview();
    const { container } = render(withQuery(<SliceReviewTab sliceName="s" slicePath="/abs/m/slices/s" />));
    expectRenderedMarkdown(container, "slice INTENT");
    expectPlanParityChrome(container, "slice INTENT");
  });

  it("root-2 RED: mission WHAT & WHY renders markdown (MissionReviewTab)", () => {
    missionState.data = missionReview();
    const { container } = render(withQuery(<MissionReviewTab missionId="m" />));
    expectRenderedMarkdown(container, "mission WHAT & WHY");
    expectPlanParityChrome(container, "mission WHAT & WHY");
  });

  it("root-3 RED: expanded board-row INTENT renders markdown (BoardRowExpansion)", () => {
    // expansion 为其行拉 SLICE 评审，故两个 fixture
    // 带相同 authored markdown。
    sliceState.data = sliceReview();
    missionState.data = missionReview({
      board: [{
        slice: "s",
        title: "s",
        phase: "spec",
        laneLabel: "PLAN",
        agentsCount: 0,
        stageCell: "",
        changedSinceStamp: false,
        attentionWorthy: false,
      }],
    });
    render(withQuery(<MissionReviewTab missionId="m" />));
    fireEvent.click(screen.getByTestId("board-row-s"));
    const row = screen.getByTestId("board-expansion-s") as HTMLElement;
    expectRenderedMarkdown(row, "board-row INTENT");
    expectPlanParityChrome(row, "board-row INTENT");
  });

  it("GREEN pin (missing-intent honesty): a null intent still surfaces its degrade string verbatim", () => {
    sliceState.data = sliceReview({
      intent: { text: null, media: [], ssotPath: "m/slices/s/README.md", degrade: "no intent recorded" },
    } as Partial<ComposedSliceReview>);
    const { container } = render(withQuery(<SliceReviewTab sliceName="s" slicePath="/abs/m/slices/s" />));
    expect(container.textContent).toContain("no intent recorded");
  });
});
