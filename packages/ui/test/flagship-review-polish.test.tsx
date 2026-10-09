// @vitest-environment jsdom

// Flagship attempt-0003——在合规真实规模控件上第一手观察到的四个展示缺陷。
// 这些测试刻意演练真实 Review 组件；仅 network/router/terminal 边界被 stub。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentRow, ComposedMissionReview, ComposedSliceReview } from "../src/hooks/useReview.js";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...rest }: { children?: React.ReactNode; to?: string }) => (
    <a href={to ?? "#"} {...(rest as Record<string, unknown>)}>{children}</a>
  ),
}));
vi.mock("../src/components/terminal/ProgressiveTerminal.js", () => ({ ProgressiveTerminal: () => null }));
vi.mock("../src/components/review/TranscriptDrillPanel.js", () => ({ TranscriptDrillPanel: () => null }));

const sliceState: { data: ComposedSliceReview | null } = { data: null };
const missionState: { data: ComposedMissionReview | null } = { data: null };
vi.mock("../src/hooks/useReview.js", () => ({
  useSliceReview: () => ({ isLoading: false, isError: false, data: sliceState.data, error: null }),
  useMissionReview: () => ({ isLoading: false, isError: false, data: missionState.data, error: null }),
  useInvalidateReview: () => () => {},
}));
vi.mock("../src/hooks/useScopeMarkdown.js", () => ({
  useScopeMarkdown: () => ({ resolved: null, isLoading: false }),
}));

import { MissionReviewTab } from "../src/components/review/MissionReviewTab.js";
import { SliceReviewTab } from "../src/components/review/SliceReviewTab.js";

afterEach(() => {
  cleanup();
  sliceState.data = null;
  missionState.data = null;
});

function withQuery(node: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

function agents(count: number): AgentRow[] {
  return Array.from({ length: count }, (_, i) => ({
    agentName: `Agent ${i + 1}`,
    runtime: "codex",
    stateGlyph: "unknown",
    doing: `owns item ${i + 1}`,
    holdsCount: 1,
    lastTransitionIso: null,
    exception: null,
    sessionName: `agent-${i + 1}@rig`,
    slices: ["04-review-tab-observability"],
  }));
}

function missionReview(over: Partial<ComposedMissionReview> = {}): ComposedMissionReview {
  return {
    mission: "release-0.4.7",
    missionId: "OPR.0.4.7",
    title: "Release 0.4.7",
    intent: "Ship a professional Review surface.",
    briefSpine: {
      building: "BUILDING machine dump",
      progress: "PROGRESS machine dump",
      proven: "PROVEN machine dump",
      needsYou: "NEEDS YOU machine dump",
    },
    board: [],
    ledger: [],
    cutComplete: false,
    cutCompleteBasis: "not complete",
    needsYou: { items: [], provenance: "none" },
    agents: { scope: "mission:release-0.4.7", rows: [], provenance: "queue scoped", coordinationHealth: null },
    composedAt: "2026-07-22T07:00:00.000Z",
    ...over,
  } as ComposedMissionReview;
}

function sliceReview(over: Partial<ComposedSliceReview> = {}): ComposedSliceReview {
  return {
    slice: "04-review-tab-observability",
    sliceId: "OPR.0.4.7.4",
    title: "Review tab observability",
    missionId: "OPR.0.4.7",
    phase: "locked",
    laneLabel: "LOCKED",
    intent: { text: "Intent", media: [], ssotPath: null, degrade: null },
    plan: { concise: { text: "1. Plan", media: [] }, lockedArtifacts: [], lock: null, ssotPath: null },
    delivered: { items: [], extraProof: [], lock: null, proofDirPath: null },
    needsYou: { items: [], provenance: "none" },
    agents: { scope: "slice:04-review-tab-observability", rows: [], provenance: "none", coordinationHealth: null },
    lineage: { candidateSha: "e103d470", mergeSha: null, mainTip: "e103d470", freshness: "fresh", staleBehind: 0, gateCells: [] },
    defects: [],
    composedAt: "2026-07-22T07:00:00.000Z",
    ...over,
  } as ComposedSliceReview;
}

describe("flagship attempt-0003 Review polish", () => {
  it("R1 removes the duplicate generated Brief Spine while preserving the structured board and ledger", () => {
    missionState.data = missionReview();
    render(withQuery(<MissionReviewTab missionId="release-0.4.7" />));

    expect(screen.queryByTestId("brief-spine")).toBeNull();
    expect(screen.getByTestId("mission-board")).toBeTruthy();
    expect(screen.getByTestId("mission-ledger")).toBeTruthy();
  });

  it("R2 removes the orphan lane/composed debug line while lock and status truth remain in their designed regions", () => {
    sliceState.data = sliceReview();
    render(withQuery(<SliceReviewTab sliceName="04-review-tab-observability" slicePath={null} />));

    expect(screen.queryByText("lane LOCKED · composed 2026-07-22T07:00:00.000Z")).toBeNull();
  });

  it("R3 renders honest artifact-only evidence for a verified item instead of contradicting it", () => {
    sliceState.data = sliceReview({
      delivered: {
        items: [{
          promised: { text: "The six accepted outcomes are recorded." },
          proof: [],
          verified: "verified",
          note: "qa-PASS-attempt-0002.md records the comparison.",
        }],
        extraProof: [],
        lock: null,
        proofDirPath: null,
      },
    });
    render(withQuery(<SliceReviewTab sliceName="04-review-tab-observability" slicePath={null} />));
    fireEvent.click(screen.getByTestId("delivered-item-0"));
    const open = screen.getByTestId("delivered-item-open-0");

    expect(within(open).getByText(/已由产物校验；未附媒体/)).toBeTruthy();
    expect(open.textContent).toContain("qa-PASS-attempt-0002.md records the comparison.");
    expect(open.textContent).not.toMatch(/尚无交付内容/);
  });

  // slice-04 REV6（qitem-20260722121455-3f43040c）——render honesty。按
  // composeDelivered，`unverified` = covering.length>0 且无记录的 PASSING
  // comparison，故即使 proof=[] 且 note 缺省，artifact 仍被 DELIVERED。展开
  // fallback 必须读作 "artifact recorded / no media"，绝不能是 "nothing
  // delivered"（仅 `missing` 保留该短语）；unverified BADGE 必须说
  // "no PASSING QA comparison"，而非 "no recorded QA comparison"（可能存在
  // 非 passing comparison 并产生 note）。
  const deliveredUnverified = (note?: string) => ({
    delivered: {
      items: [{ promised: { text: "Blocked outcome" }, proof: [], verified: "unverified" as const, ...(note ? { note } : {}) }],
      extraProof: [], lock: null, proofDirPath: null,
    },
  });

  it("REV6 RED: unverified + real non-passing note renders artifact-recorded/no-media (never 'nothing delivered'), keeps the note, badge says no PASSING comparison", () => {
    sliceState.data = sliceReview(deliveredUnverified("The comparison was kicked back; remediation is required."));
    render(withQuery(<SliceReviewTab sliceName="04-review-tab-observability" slicePath={null} />));
    fireEvent.click(screen.getByTestId("delivered-item-0"));
    const open = screen.getByTestId("delivered-item-open-0");
    expect(open.textContent).toMatch(/已记录产物/);
    expect(open.textContent).toMatch(/未附媒体/);
    expect(open.textContent).not.toMatch(/尚无交付内容/);
    expect(open.textContent).toContain("The comparison was kicked back; remediation is required.");
    const badge = screen.getByTestId("delivered-item-0").textContent ?? "";
    expect(badge).toMatch(/无通过的 QA 对比/);
    expect(badge).not.toMatch(/no recorded QA comparison/i);
  });

  it("REV6 RED: unverified with NO note still renders artifact-recorded/no-media, never 'nothing delivered'", () => {
    sliceState.data = sliceReview(deliveredUnverified());
    render(withQuery(<SliceReviewTab sliceName="04-review-tab-observability" slicePath={null} />));
    fireEvent.click(screen.getByTestId("delivered-item-0"));
    const open = screen.getByTestId("delivered-item-open-0");
    expect(open.textContent).toMatch(/已记录产物/);
    expect(open.textContent).toMatch(/未附媒体/);
    expect(open.textContent).not.toMatch(/尚无交付内容/);
  });

  it("REV6 pin (GREEN): `missing` proof=[] is the ONLY 'nothing delivered' branch (not artifact-recorded)", () => {
    sliceState.data = sliceReview({
      delivered: { items: [{ promised: { text: "Promised but absent" }, proof: [], verified: "missing" as const }], extraProof: [], lock: null, proofDirPath: null },
    });
    render(withQuery(<SliceReviewTab sliceName="04-review-tab-observability" slicePath={null} />));
    fireEvent.click(screen.getByTestId("delivered-item-0"));
    const open = screen.getByTestId("delivered-item-open-0");
    expect(open.textContent).toMatch(/此项尚无交付内容/);
    expect(open.textContent).not.toMatch(/已记录产物/);
  });

  it("R4 keeps six owners visible and owns the all-agents action inside the shared footer", () => {
    missionState.data = missionReview({
      agents: {
        scope: "mission:release-0.4.7",
        rows: agents(18),
        provenance: "18 queue-scoped agents",
        coordinationHealth: null,
      },
    });
    render(withQuery(<MissionReviewTab missionId="release-0.4.7" />));
    const band = screen.getByTestId("agents-band");
    const visible = within(band).getByTestId("agents-visible");
    const overflow = within(band).getByTestId("agents-overflow");

    expect(within(visible).getAllByTestId(/^agent-drill-/)).toHaveLength(6);
    expect(within(overflow).getAllByTestId(/^agent-drill-/)).toHaveLength(12);
    expect(within(overflow).getByText("+12 个更多队列范围智能体")).toBeTruthy();
    expect(overflow.hasAttribute("open")).toBe(false);
    const footer = within(band).getByTestId("agents-footer");
    expect(footer.textContent).toContain("18 queue-scoped agents");
    expect(within(footer).getByRole("link", { name: /全部智能体/i }).getAttribute("href")).toBe("/agents");
    expect(screen.getByTestId("mission-agents-preview").lastElementChild).toBe(band);
  });

  it("R5 composes nonempty phase lanes as vellum cards and compresses all empty lanes into one line", () => {
    missionState.data = missionReview({
      board: [
        {
          slice: "01-foundation",
          title: "Foundation",
          phase: "planned",
          laneLabel: "PLAN",
          agentsCount: 2,
          stageCell: "planned",
          changedSinceStamp: false,
          attentionWorthy: false,
        },
        {
          slice: "04-review-tab-observability",
          title: "Review tab observability",
          phase: "locked",
          laneLabel: "LOCKED",
          agentsCount: 3,
          stageCell: "locked",
          changedSinceStamp: false,
          attentionWorthy: false,
        },
      ],
    });
    render(withQuery(<MissionReviewTab missionId="release-0.4.7" />));

    const plan = screen.getByTestId("board-lane-card-PLAN");
    expect(plan.className).toContain("backdrop-blur");
    const planHeader = within(plan).getByTestId("board-lane-header-PLAN");
    expect(within(planHeader).getByText("计划")).toBeTruthy();
    expect(within(planHeader).getByText("1")).toBeTruthy();
    const locked = screen.getByTestId("board-lane-card-LOCKED");
    const lockedHeader = within(locked).getByTestId("board-lane-header-LOCKED");
    expect(within(lockedHeader).getByText("已锁定")).toBeTruthy();
    expect(within(lockedHeader).getByText("1")).toBeTruthy();
    expect(screen.getByTestId("board-empty-lanes").textContent).toBe("意图 0 · 构建 0 · 评审 0");
  });

  it("R6 gives SETTLED a vellum card header with cut status inside its hierarchy", () => {
    missionState.data = missionReview({
      ledger: [{
        slice: "04-review-tab-observability",
        candidateSha: "85e67f0",
        gateCells: [],
        mergeSha: null,
        needsHumanCount: 0,
        green: true,
      }],
      cutComplete: true,
      cutCompleteBasis: "all slices settled",
    });
    render(withQuery(<MissionReviewTab missionId="release-0.4.7" />));

    const ledger = screen.getByTestId("mission-ledger");
    expect(ledger.className).toContain("backdrop-blur");
    const header = within(ledger).getByTestId("ledger-header");
    expect(header.textContent).toContain("已定稿");
    expect(header.textContent).toContain("完成台账");
    expect(within(header).getByTestId("cut-complete").textContent).toContain("交付门控 完成");
  });

  // ===================================================================
  // STAGE-3 LEVER C（Stage-1）——"not compliant: mini-reqs" render marker。
  // REV3 d9fa8a2e §5。仅测试：RED-1/RED-2/RED-3 失败因 marker 元素
  //（testid plan-mini-reqs-noncompliant）尚不存在；合规伴随项今日 GREEN。
  // marker 在 data.plan.concise.text === null 时渲染，在每个 phase
  //（D1：无 phase gate），仅展示；copy 已冻结（D2）。它们在 marker 落地时成为
  // 回归锁（SliceReviewTab 上一次独立 Guard-gated GREEN 派发）。
  // ===================================================================
  const MARKER_TID = "plan-mini-reqs-noncompliant";
  const MARKER_COPY = "不合规 · 尚未编写最小需求";
  const planNull = { concise: { text: null, media: [] }, lockedArtifacts: [], lock: null, ssotPath: null };
  const renderSlice = () => render(withQuery(<SliceReviewTab sliceName="04-review-tab-observability" slicePath={null} />));

  it("LeverC RED-1 (post-intent non-compliance): phase=spec + plan.concise.text===null renders the frozen marker with exact copy", () => {
    sliceState.data = sliceReview({ phase: "spec", plan: planNull } as Partial<ComposedSliceReview>);
    renderSlice();
    const marker = screen.getByTestId(MARKER_TID); // <-- RED: marker element absent (writer unbuilt)
    expect(marker.textContent).toBe(MARKER_COPY);
  });

  it("LeverC RED-2 (intent no-gate PIN, D1): phase=intent + text===null renders the SAME marker — no phase gate suppresses it", () => {
    sliceState.data = sliceReview({ phase: "intent", plan: planNull } as Partial<ComposedSliceReview>);
    renderSlice();
    const marker = screen.getByTestId(MARKER_TID); // <-- RED: marker element absent
    expect(marker.textContent).toBe(MARKER_COPY);
  });

  it("LeverC GREEN companion (compliant): authored plan text renders Markdown and NO marker", () => {
    sliceState.data = sliceReview({
      phase: "spec",
      plan: { concise: { text: "1. Author the mini-requirements", media: [] }, lockedArtifacts: [], lock: null, ssotPath: null },
    } as Partial<ComposedSliceReview>);
    renderSlice();
    const planSection = screen.getByTestId("plan-section");
    expect(within(planSection).queryByTestId(MARKER_TID)).toBeNull(); // compliant -> no marker
    expect(within(planSection).getByTestId("markdown-viewer")).toBeTruthy(); // the authored plan renders
  });

  it("LeverC RED-3 (preservation + MARKER-SCOPED non-interactive): text===null WITH media + locked siblings renders the marker AND both siblings; the marker element itself is non-interactive", () => {
    sliceState.data = sliceReview({
      plan: {
        concise: { text: null, media: [{ kind: "video", src: "data:video/mp4;base64,AAAA", caption: "plan clip" }] },
        lockedArtifacts: [{ name: "Implementation PRD", path: "IMPLEMENTATION-PRD.md", kind: "spec" }],
        lock: null,
        ssotPath: null,
      },
    } as Partial<ComposedSliceReview>);
    renderSlice();
    const marker = screen.getByTestId(MARKER_TID); // <-- RED: marker element absent
    expect(marker.textContent).toBe(MARKER_COPY);
    // 两个 plan-section 兄弟仍渲染（marker 不抑制任何东西）。
    expect(screen.getByTestId("review-inline-video")).toBeTruthy(); // media sibling
    expect(screen.getByTestId("plan-locked-set")).toBeTruthy(); // locked-set sibling
    // 非交互 oracle 仅作用于 marker 元素（locked-set EvidenceOpeners 是有效控件）。
    expect(["A", "BUTTON"]).not.toContain(marker.tagName);
    expect(marker.getAttribute("role")).not.toBe("button");
    expect(marker.getAttribute("role")).not.toBe("link");
    expect(marker.querySelectorAll("a, button, input, select, textarea, [role='button'], [role='link']").length).toBe(0);
  });
});
