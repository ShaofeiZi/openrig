// @vitest-environment jsdom

// OPR.0.4.4.20 追溯演示回修——FileViewer 永久加载缺陷：演示证明发现，当
// /api/files/read 返回 200 时，PROOF.md 抽屉仍卡在“无内容/加载中…”。调用方（评审表面的
// SSOT 入口）既未传 root，也未传 absolutePath，因此查看器没有可获取目标。此处锁定三个环节
//（改为针对 CORRECTIVE 单一结构表面；旧比较列文件已删除）：
//  (1) 未提供 content 和可读目标时，FileViewer 如实显示“无法解析”，绝不永久加载。
//  (2) 显式 root 目标仍能由 FileViewer 获取并渲染内容，即回修要求的成功读取渲染回归。
//  (3) PLAN 分区的“完整 PRD →”入口根据 slice 上下文生成可解析数据结构
//      （root + readPath + absolutePath 回退），包括恰好等于白名单根目录（relPath ""）的情况。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FileViewer } from "../src/components/drawer-viewers/FileViewer.js";
import type { ComposedSliceReview } from "../src/hooks/useReview.js";

const captured: Array<Record<string, unknown>> = [];
vi.mock("../src/components/drawer-triggers/FileReferenceTrigger.js", () => ({
  FileReferenceTrigger: ({ data, children }: { data: Record<string, unknown>; children: React.ReactNode }) => {
    captured.push(data);
    return <button type="button">{children}</button>;
  },
}));

// PLAN 入口回归驱动真实 SliceReviewTab；无关条带与 Markdown 渲染器使用 stub，使测试聚焦于
// 入口数据结构。
vi.mock("../src/components/review/NeedsYouAccordion.js", () => ({ NeedsYouAccordion: () => null }));
vi.mock("../src/components/review/AgentsBandView.js", () => ({ AgentsBandView: () => null }));
vi.mock("../src/components/review/VerifyLineageCard.js", () => ({ VerifyLineageCard: () => null }));
// 透传渲染 stub：FileViewer 的已获取内容断言（环节 2）读取 Markdown 文本，因此 stub 必须
// 透传内容，不能将其置空。
vi.mock("../src/components/markdown/MarkdownViewer.js", () => ({
  MarkdownViewer: ({ content }: { content?: string }) => <div>{content}</div>,
}));

const reviewState: { data: ComposedSliceReview | null } = { data: null };
vi.mock("../src/hooks/useReview.js", () => ({
  useSliceReview: () => ({ isLoading: false, isError: false, data: reviewState.data, error: null }),
}));

const scopeState: { resolved: { rootName: string; relPath: string } | null } = { resolved: null };
vi.mock("../src/hooks/useScopeMarkdown.js", () => ({
  useScopeMarkdown: () => ({ resolved: scopeState.resolved, isLoading: false }),
}));

import { SliceReviewTab } from "../src/components/review/SliceReviewTab.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  captured.length = 0;
});

function withQuery(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

function fixtureReview(): ComposedSliceReview {
  return {
    slice: "s",
    sliceId: null,
    title: "s",
    missionId: "m",
    phase: "spec",
    laneLabel: "PLAN",
    intent: { text: "i", media: [], ssotPath: "m/slices/s/README.md", degrade: null },
    plan: { concise: { text: "1. m", media: [] }, lockedArtifacts: [], lock: null, ssotPath: "m/slices/s/IMPLEMENTATION-PRD.md" },
    delivered: { items: [], extraProof: [], lock: null, proofDirPath: null },
    needsYou: { items: [], provenance: "0" },
    agents: { scope: "slice:s", rows: [], provenance: "0", coordinationHealth: null },
    lineage: { candidateSha: null, mergeSha: null, mainTip: "tip", freshness: "unknown", staleBehind: null, gateCells: [] },
    defects: [],
    composedAt: "2026-07-06T00:00:00.000Z",
  };
}

describe("FileViewer — resolvable-target honesty (retro-demo fixback)", () => {
  it("renders NOT RESOLVABLE (never eternal Loading) when given no content and no target", () => {
    render(withQuery(<FileViewer path="missions/m/slices/s/PROOF.md" kind="markdown" absolutePath={null} />));
    expect(screen.getByTestId("file-viewer-unresolvable")).toBeTruthy();
    expect(screen.queryByText(/Loading/)).toBeNull();
  });

  it("still renders inline content without any target (inline callers unaffected)", () => {
    render(withQuery(<FileViewer path="x.md" kind="markdown" content="# hello inline" />));
    expect(screen.queryByTestId("file-viewer-unresolvable")).toBeNull();
    expect(screen.getByTestId("file-viewer")).toBeTruthy();
  });

  it("fetches and RENDERS the 200 /api/files/read content for an explicit root target", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).startsWith("/api/files/read")) {
        return new Response(JSON.stringify({ content: "# Proof body from read API", truncated: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    render(withQuery(<FileViewer path="PROOF.md" kind="markdown" root="workspace" readPath="missions/m/slices/s/PROOF.md" />));
    await waitFor(() => {
      // 抽屉必须显示实际获取的内容——验收锁定项。
      expect(document.body.textContent).toContain("Proof body from read API");
    });
    expect(screen.queryByTestId("file-viewer-unresolvable")).toBeNull();
    expect(screen.queryByTestId("file-viewer-error")).toBeNull();
  });
});

describe("PLAN 'full PRD →' door — emits a resolvable FileViewer target", () => {
  it("joins the resolved root relPath with the slice-dir FILENAME (never the workspace-relative ssotPath)", () => {
    reviewState.data = fixtureReview();
    scopeState.resolved = { rootName: "workspace", relPath: "missions/m/slices/s" };
    render(withQuery(<SliceReviewTab sliceName="s" slicePath="/abs/m/slices/s" />));
    const door = captured.find((d) => d["path"] === "m/slices/s/IMPLEMENTATION-PRD.md");
    expect(door).toBeDefined();
    expect(door).toMatchObject({
      root: "workspace",
      readPath: "missions/m/slices/s/IMPLEMENTATION-PRD.md", // relPath + FILE，不重复添加前缀。
      absolutePath: "/abs/m/slices/s/IMPLEMENTATION-PRD.md",
    });
  });

  it("exact-allowlist-root ctx (relPath = '') yields the BARE filename readPath, never a dropped or over-prefixed one", () => {
    // 守卫代码评审折叠（23ca5031 类）：useScopeMarkdown 精确根目录解析可以合法返回
    // relPath ""，因为 slice 目录本身就是白名单根目录。此时 readPath 必须只含文件名；
    // 若使用该根目录下带任务目标前缀的 ssotPath，会获取前缀重复的错误路径。
    reviewState.data = fixtureReview();
    scopeState.resolved = { rootName: "slice-root", relPath: "" };
    render(withQuery(<SliceReviewTab sliceName="s" slicePath="/abs/m/slices/s" />));
    const door = captured.find((d) => d["path"] === "m/slices/s/IMPLEMENTATION-PRD.md");
    expect(door).toMatchObject({ root: "slice-root", readPath: "IMPLEMENTATION-PRD.md" });
  });

  it("unresolved root (relPath null) keeps the absolutePath fallback — never the dead {no root, null absolutePath} shape", () => {
    reviewState.data = fixtureReview();
    scopeState.resolved = null;
    render(withQuery(<SliceReviewTab sliceName="s" slicePath="/abs/m/slices/s" />));
    const door = captured.find((d) => d["path"] === "m/slices/s/IMPLEMENTATION-PRD.md");
    expect(door).toBeDefined();
    expect(door!["readPath"]).toBeUndefined();
    expect(door).toMatchObject({ absolutePath: "/abs/m/slices/s/IMPLEMENTATION-PRD.md" });
    // 可获取目标不变量：必须有 root+readPath 对，或 absolutePath。
    for (const d of captured) {
      expect(d["root"] !== undefined || d["absolutePath"] !== null).toBe(true);
    }
  });
});
