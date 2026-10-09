// @vitest-environment jsdom

// qitem-render-driver D3 + #5a——mission NEEDS-YOU slice 归属与
// VERIFY LINEAGE token 标签。
//
// D3 根（MissionReviewTab.tsx:320）：mission 带逐字合并 slice 派生
// 异常，故 item.where 已带 `<mission>/slices/<name>`
//（compose.ts:1070/1150）。tab 从该 ref 计算 sliceName，但仅作
// Link target——渲染行（:322-327）只显示 summary + leg +
// priority。因 insufficient-proof summary 与 slice 无关
//（"insufficient proof: N/M promised items missing"，compose.ts:670-676），
// 两个 slice 产出视觉相同的行，无归属。诚实修复是
// 呈现 payload 中已有的 ref；绝不臆造。
//
// #5a 根（VerifyLineageCard.tsx:29-33，据 QA 证据）：最终 token
// `lineage.freshness` 无标签渲染——故 payload freshness 为
// "unknown" 时读作 "main tip unknown" 后悬空裸 token。
// 兄弟 proven-at / merged-at / main-tip 标签正确，须保留。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComposedMissionReview, VerifyLineage } from "../src/hooks/useReview.js";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children?: React.ReactNode }) => <a {...(rest as Record<string, unknown>)}>{children}</a>,
}));
vi.mock("../src/components/review/AgentsBandView.js", () => ({ AgentsBandView: () => null }));
vi.mock("../src/components/terminal/ProgressiveTerminal.js", () => ({ ProgressiveTerminal: () => null }));

const missionState: { data: ComposedMissionReview | null } = { data: null };
vi.mock("../src/hooks/useReview.js", () => ({
  useMissionReview: () => ({ isLoading: false, isError: false, data: missionState.data, error: null }),
  useSliceReview: () => ({ isLoading: false, isError: false, data: null, error: null }),
  useInvalidateReview: () => () => {},
}));

import { MissionReviewTab } from "../src/components/review/MissionReviewTab.js";
import { VerifyLineageCard } from "../src/components/review/VerifyLineageCard.js";

afterEach(() => {
  cleanup();
  missionState.data = null;
});

function withQuery(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

/** 一个 compose.ts 原样发出的 slice 派生 insufficient-proof 项。 */
function insufficientProof(slice: string) {
  return {
    source: "derived",
    identity: `m/slices/${slice}|insufficient-proof|1`,
    summary: "insufficient proof: 1/2 promised items missing",
    leg: "insufficient-proof",
    where: `m/slices/${slice}`,
    ageIso: null,
    priority: null,
    tier: null,
    evidenceRef: null,
    unblocks: null,
    qitemId: null,
    destinationSession: null,
    derived: {
      kind: "insufficient-proof",
      evidence: "1 of 2 promised deliverables have no delivered evidence",
      threshold: "delivered.items MISSING count > 0",
    },
  };
}

/** 一个 MISSION 作用域项——其 `where` 不含 /slices/ 段。 */
function missionScopeItem() {
  return {
    source: "agent",
    identity: "q-mission-1|overdue|x",
    summary: "a mission-scope attention item",
    leg: "overdue",
    where: "mission queue+slice unions",
    ageIso: null,
    priority: null,
    tier: null,
    evidenceRef: null,
    unblocks: null,
    qitemId: "q-mission-1",
    destinationSession: null,
    derived: null,
  };
}

function missionReview(items: unknown[]): ComposedMissionReview {
  return {
    mission: "m",
    missionId: "OPR.M",
    title: "m",
    intent: null,
    briefSpine: { building: "", progress: "", proven: "", needsYou: "" },
    board: [],
    ledger: [],
    cutComplete: false,
    cutCompleteBasis: "basis",
    needsYou: { items, provenance: "union" },
    agents: { scope: "mission:m", rows: [], provenance: "0", coordinationHealth: null },
    composedAt: "2026-07-20T00:00:00.000Z",
  } as unknown as ComposedMissionReview;
}

describe("qitem-render-driver D3 — mission NEEDS-YOU shows which slice each item belongs to", () => {
  it("RED: two slice-derived insufficient-proof rows VISIBLY carry their own slice refs (not just distinct hrefs)", () => {
    missionState.data = missionReview([insufficientProof("alpha"), insufficientProof("beta")]);
    render(withQuery(<MissionReviewTab missionId="m" />));
    const alphaRow = screen.getByTestId("mission-needs-you-m/slices/alpha|insufficient-proof|1");
    const betaRow = screen.getByTestId("mission-needs-you-m/slices/beta|insufficient-proof|1");
    // 每行必须在可见文本中点名自己的 slice——今日两行
    // 渲染相同的 slice 无关 summary。
    expect(alphaRow.textContent, "alpha row must name its slice").toContain("alpha");
    expect(betaRow.textContent, "beta row must name its slice").toContain("beta");
    expect(alphaRow.textContent, "alpha row must not claim beta").not.toContain("beta");
  });

  it("GREEN pin (no fabrication): a mission-scope item whose `where` lacks /slices/ invents no slice ref", () => {
    missionState.data = missionReview([missionScopeItem()]);
    const { container } = render(withQuery(<MissionReviewTab missionId="m" />));
    const band = container.textContent ?? "";
    expect(band).toContain("a mission-scope attention item");
    expect(band, "no slices/ token may be fabricated for a mission-scope item").not.toContain("slices/");
    expect(band, "no alpha/beta slice name may leak onto a mission-scope row").not.toMatch(/\b(alpha|beta)\b/);
  });
});

describe("qitem-render-driver #5a — VERIFY LINEAGE tokens are all labelled", () => {
  const lineage = (over: Partial<VerifyLineage> = {}): VerifyLineage => ({
    candidateSha: null,
    mergeSha: null,
    mainTip: "unknown",
    freshness: "unknown",
    staleBehind: null,
    gateCells: [],
    ...over,
  } as VerifyLineage);

  it("RED: the trailing freshness token is LABELLED (not a bare dangling 'unknown')", () => {
    render(<VerifyLineageCard lineage={lineage()} />);
    const token = screen.getByTestId("lineage-freshness");
    // freshness 值不得孤立：其自身元素（或紧邻标签）
    // 必须点名该值描述什么。
    const own = (token.textContent ?? "").trim();
    expect(
      /新鲜度/.test(own),
      `freshness token must be labelled; rendered bare as "${own}"`,
    ).toBe(true);
  });

  it("GREEN pin: proven-at / merged-at / main tip labels are preserved verbatim", () => {
    const { container } = render(<VerifyLineageCard lineage={lineage({ candidateSha: "cafe1234", mergeSha: null, mainTip: "tip99" })} />);
    const text = container.textContent ?? "";
    expect(text).toContain("验证于");
    expect(text).toContain("cafe1234");
    expect(text).toContain("合并于");
    expect(text).toContain("未合并");
    expect(text).toContain("main 尖端");
    expect(text).toContain("tip99");
  });
});
