// OPR.0.4.1.23 Part-3——PROOF tab。经既有 /api/files 端点（复用，如 slice-21
// Artifacts navigator）原样投影每个 slice 的 proof/ + PROOF.md。测试：verdict
// 解析（对含 scaffold 占位的 authored 形状健壮）、填充 card（badge + PROOF.md
// + gallery）、scaffolded 空状态，以及只读（无 /write）。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState, type ReactNode } from "react";
import { render, screen, cleanup, waitFor, within, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ScopeProofRollup, SliceProofTab } from "../src/components/project/ProofTab.js";
import { DrawerSelectionContext } from "../src/components/AppShell.js";
import { SharedDetailDrawer, type DrawerSelection } from "../src/components/SharedDetailDrawer.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

let calls: string[] = [];

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

// Slice relPath -> { proofMd?: string; proofEntries?: [...] }。缺 proofMd = 404。
const SLICES: Record<string, { proofMd?: string; proofEntries?: Array<{ name: string; type: "file" | "dir"; size: number | null; mtime: string | null }> }> = {
  // 填充 PASS——真实捕获形状（`**Verdict: PASS**`）+ 2 个捕获
  "missions/m/slices/16-brief": {
    // 在 Intent->Proof 表中含一张 INLINE 图（真实 PROOF.md 形状），
    // 故 markdown-image asset-resolution 路径被演练，而非仅 gallery。
    proofMd: "# OPR.0.4.1.16 Proof\n\n**Verdict: PASS** · 2026-06-23\n\n**Method.** Source-build daemon.\n\n**Result.** Brief projected.\n\n## Intent -> Proof\n\n![capture](proof/real-live-a.png)",
    proofEntries: [
      { name: "real-live-a.png", type: "file", size: 120000, mtime: "2026-06-23T22:01:00.000Z" },
      { name: "real-live-b.png", type: "file", size: 130000, mtime: "2026-06-23T22:02:00.000Z" },
    ],
  },
  // PARTIAL——裸 `Verdict: pass-with-residue`，一个捕获
  "missions/m/slices/17-steering": {
    proofMd: "Closed by: qa   Date: 2026-06-23   Verdict: pass-with-residue\n\n## What this proves\n\nSteering renders.",
    proofEntries: [{ name: "cap.png", type: "file", size: 99000, mtime: "2026-06-23T22:03:00.000Z" }],
  },
  // FAIL
  "missions/m/slices/19-story": {
    proofMd: "**Verdict: FAIL** · regression found",
    proofEntries: [{ name: "fail.png", type: "file", size: 1000, mtime: "2026-06-23T22:04:00.000Z" }],
  },
  // SCAFFOLDED 但未填充——rig-scope 模板带占位 verdict + 空 proof/
  "missions/m/slices/18-queue": {
    proofMd: "# PROOF — OPR.0.4.1.18 Queue summary\n\nClosed by: <seat>   Date: <date>   Verdict: <pass | pass-with-residue | ...>\n\n## What this proves\n\n<1-3 sentences>",
    proofEntries: [],
  },
  // FOUNDER-FIX drawer slice——一个 markdown proof-of-work 文件（guard.md），必须在
  // in-app drawer 打开，旁侧是留在 gallery 的图像捕获 + 一张 inline PROOF.md 图
  //（两者都在 /api/files/asset 路径上保留）。
  "missions/m/slices/20-drawer": {
    proofMd: "# OPR.0.4.1.20 Proof\n\n**Verdict: PASS** · 2026-07-22\n\n## Intent -> Proof\n\n![cap](proof/shot.png)",
    proofEntries: [
      { name: "guard.md", type: "file", size: 480, mtime: "2026-07-22T22:00:00.000Z" },
      { name: "shot.png", type: "file", size: 120000, mtime: "2026-07-22T22:01:00.000Z" },
    ],
  },
};

// C1 proof 契约（docs/reference/sdlc-conventions.md §5）：五个 frontmatter
// 字段 + 一个独特 body，使 drawer 渲染对真实 proof 内容（header 和 body）断言，
// 绝不假绿。
const GUARD_C1 = [
  "---",
  "slice: slice-04-review-tab-observability",
  "candidate_sha: 7d0997dddaab59f43bcc658fe2c0457128a64f53",
  "artifact_type: guard",
  "verdict: PASS",
  "money_evidence: proof/guard.md opens in the in-app drawer",
  "---",
  "",
  "# Guard Verdict — slice-04",
  "",
  "DISTINCTIVE-BODY-MARKER: the guard proof-of-work rendered inside the drawer.",
].join("\n");

// proof-of-work 文件 body（proof/<name>，非 PROOF.md）以 slice 相对 read 路径为
// 键——仅在打开时由下方 /api/files/read 路由提供。
const PROOF_FILES: Record<string, string> = {
  "missions/m/slices/20-drawer/proof/guard.md": GUARD_C1,
};

function routeFiles(input: unknown) {
  const url = String(input);
  calls.push(url);
  if (url.includes("/api/files/roots")) {
    return Promise.resolve(jsonResponse({ roots: [{ name: "work", path: "/ws" }] }));
  }
  if (url.includes("/api/files/read")) {
    const path = new URL(url, "http://t.local").searchParams.get("path") ?? "";
    // proof-of-work 文件读取（proof/<name>，非 PROOF.md）——drawer 内容。
    const proofFile = PROOF_FILES[path];
    if (proofFile != null) {
      return Promise.resolve(jsonResponse({ root: "work", path, absolutePath: `/ws/${path}`, content: proofFile, mtime: "2026-07-22T22:05:00.000Z", contentHash: "pf", size: proofFile.length }));
    }
    const slice = path.replace(/\/PROOF\.md$/, "");
    const md = SLICES[slice]?.proofMd;
    if (md == null) return Promise.resolve(jsonResponse({ error: "not found" }, 404));
    return Promise.resolve(jsonResponse({ root: "work", path, absolutePath: `/ws/${path}`, content: md, mtime: "2026-06-23T22:00:00.000Z", contentHash: "h", size: md.length }));
  }
  if (url.includes("/api/files/list")) {
    const path = new URL(url, "http://t.local").searchParams.get("path") ?? "";
    const slice = path.replace(/\/proof$/, "");
    return Promise.resolve(jsonResponse({ root: "work", path, entries: SLICES[slice]?.proofEntries ?? [] }));
  }
  return Promise.resolve(jsonResponse({}, 404));
}

function row(name: string, displayName: string, slice: string) {
  return { name, displayName, slicePath: `/ws/${slice}` };
}

function renderRollup(rows: ReturnType<typeof row>[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ScopeProofRollup rows={rows} />
    </QueryClientProvider>,
  );
}

describe("OPR.0.4.1.23 — PROOF tab", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(routeFiles);
    calls = [];
  });
  afterEach(() => cleanup());

  it("AC-1: a populated slice renders the verdict badge, PROOF.md, and the proof/ gallery", async () => {
    renderRollup([row("16-brief", "OPR.0.4.1.16", "missions/m/slices/16-brief")]);
    await waitFor(() => expect(screen.getByTestId("proof-verdict-OPR.0.4.1.16")).toBeTruthy());
    expect(screen.getByTestId("proof-verdict-OPR.0.4.1.16").textContent).toBe("通过");
    expect(screen.getByTestId("proof-slice-OPR.0.4.1.16")).toBeTruthy();
    expect(screen.getByTestId("proof-md-OPR.0.4.1.16")).toBeTruthy();
    // gallery 显示两个真实捕获（经 /api/files/asset src 可浏览器查看）。
    expect(screen.getByTestId("proof-gallery-OPR.0.4.1.16")).toBeTruthy();
    expect(screen.getByTestId("proof-thumb-real-live-a.png")).toBeTruthy();
    expect(screen.getByTestId("proof-thumb-real-live-b.png")).toBeTruthy();
  });

  it("AC-2: a scaffolded-but-unpopulated slice (placeholder verdict + empty proof/) renders the empty-state", async () => {
    renderRollup([row("18-queue", "OPR.0.4.1.18", "missions/m/slices/18-queue")]);
    await waitFor(() => expect(screen.getByTestId("proof-slice-empty-OPR.0.4.1.18")).toBeTruthy());
    expect(screen.getByTestId("proof-empty-state-OPR.0.4.1.18").textContent).toMatch(/尚无校验|脚手架|收尾/);
    // 占位 <pass|...> verdict 非真实 verdict——无 badge。
    expect(screen.queryByTestId("proof-verdict-OPR.0.4.1.18")).toBeNull();
  });

  it("AC-3: verdict parsing is robust — pass-with-residue → PARTIAL, FAIL → FAIL", async () => {
    renderRollup([
      row("17-steering", "OPR.0.4.1.17", "missions/m/slices/17-steering"),
      row("19-story", "OPR.0.4.1.19", "missions/m/slices/19-story"),
    ]);
    await waitFor(() => expect(screen.getByTestId("proof-verdict-OPR.0.4.1.17")).toBeTruthy());
    expect(screen.getByTestId("proof-verdict-OPR.0.4.1.17").textContent).toBe("部分");
    expect(screen.getByTestId("proof-verdict-OPR.0.4.1.19").textContent).toBe("失败");
  });

  it("AC-4: read-only — projects the location AS-IS, never POSTs /api/files/write", async () => {
    renderRollup([row("16-brief", "OPR.0.4.1.16", "missions/m/slices/16-brief")]);
    await waitFor(() => expect(screen.getByTestId("proof-verdict-OPR.0.4.1.16")).toBeTruthy());
    expect(calls.some((c) => c.includes("/api/files/write"))).toBe(false);
    // 它读 slice-root PROOF.md + proof/ 列表（AS-IS 投影）。
    expect(calls.some((c) => c.includes("/api/files/read") && c.includes("16-brief%2FPROOF.md"))).toBe(true);
    expect(calls.some((c) => c.includes("/api/files/list") && c.includes("16-brief%2Fproof"))).toBe(true);
  });

  it("AC-7 (guard fcf1126f regression): INLINE PROOF.md images resolve under /api/files/asset (assetBasePath), not broken route-relative", async () => {
    const { container } = renderRollup([row("16-brief", "OPR.0.4.1.16", "missions/m/slices/16-brief")]);
    await waitFor(() => expect(screen.getByTestId("proof-verdict-OPR.0.4.1.16")).toBeTruthy());
    // 渲染后 PROOF.md 内的 inline `![capture](proof/real-live-a.png)`
    const inline = container.querySelector('img[alt="capture"]') as HTMLImageElement | null;
    expect(inline).toBeTruthy();
    const src = inline!.getAttribute("src") ?? "";
    expect(src).toContain("/api/files/asset");
    // 相对 slice-root asset base 解析 -> proof/ 路径，绝非裸路由相对 "proof/..."
    expect(src).toContain("16-brief");
    expect(src).toContain("proof/real-live-a.png");
    expect(src.startsWith("proof/")).toBe(false);
  });

  it("AC-5: empty scope renders a self-explanatory empty-state (no slices indexed)", async () => {
    renderRollup([]);
    expect(screen.getByTestId("proof-rollup-empty")).toBeTruthy();
  });

  it("AC-6: slice-altitude SliceProofTab renders the single slice's proof card", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <SliceProofTab sliceId="OPR.0.4.1.16" title="brief" slicePath="/ws/missions/m/slices/16-brief" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("proof-verdict-OPR.0.4.1.16")).toBeTruthy());
    expect(screen.getByTestId("proof-verdict-OPR.0.4.1.16").textContent).toBe("通过");
  });
});

// ---------------------------------------------------------------------------
// FOUNDER FIX（qitem-20260722234754-e8db7111）：proof-of-work 文件链接必须在
// SharedDetailDrawer 内 IN-APP 打开——渲染 C1 proof 内容——而非把整个浏览器导航到
// 原始 /api/files/asset（整页逃出 SPA）。这些测试挂载真实 drawer 栈
//（DrawerSelection + SharedDetailDrawer + FileViewer），使点击演练真正 in-app
// 路径，并锁定 images/lightbox + inline PROOF.md 的保留以及点击前不读的惰性边界。
// 对 ProofTab.tsx 的原始 <a target=_blank> 为 RED。
// ---------------------------------------------------------------------------

// 最小真实 drawer host——镜像 AppShell 的 DrawerSelection provider +
// SharedDetailDrawer，使 FileReferenceTrigger 点击真正打开 drawer。
function DrawerHost({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<DrawerSelection>(null);
  return (
    <DrawerSelectionContext.Provider value={{ selection, setSelection }}>
      {children}
      <SharedDetailDrawer
        selection={selection}
        onClose={() => setSelection(null)}
        events={[]}
        selectedDiscoveredId={null}
        onSelectDiscoveredId={() => {}}
        placementTarget={null}
        onClearPlacement={() => {}}
      />
    </DrawerSelectionContext.Provider>
  );
}

const DRAWER_SLICE = { id: "OPR.0.4.1.20", path: "/ws/missions/m/slices/20-drawer" };
// drawer 必须读的规范 slice 相对 proof 路径（URL 编码）。
const GUARD_READ = "missions%2Fm%2Fslices%2F20-drawer%2Fproof%2Fguard.md";

function renderSliceInDrawer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DrawerHost>
        <SliceProofTab sliceId={DRAWER_SLICE.id} title="brief" slicePath={DRAWER_SLICE.path} />
      </DrawerHost>
    </QueryClientProvider>,
  );
}

describe("PROOF tab — proof file opens in the in-app drawer (founder fix e8db7111)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(routeFiles);
    calls = [];
  });
  afterEach(() => cleanup());

  it("FX-1 (RED): a markdown proof link is an in-app control, not a full-page raw-asset anchor", async () => {
    renderSliceInDrawer();
    const list = await screen.findByTestId(`proof-files-${DRAWER_SLICE.id}`);
    const label = within(list).getByText("proof/guard.md");
    // 期望：in-app 按钮（FileReferenceTrigger），非逃出 SPA 的 <a>。
    expect(label.closest("button")).toBeTruthy();
    expect(label.closest("a")).toBeNull();
    // proof-files 列表任何处都无整页 raw-asset 逃出。
    expect(list.querySelector('a[target="_blank"]')).toBeNull();
    expect(list.querySelector('a[href*="/api/files/asset"]')).toBeNull();
  });

  it("FX-2 (RED): the read is LAZY — clicking opens the drawer and reads the slice-relative proof path exactly", async () => {
    renderSliceInDrawer();
    const list = await screen.findByTestId(`proof-files-${DRAWER_SLICE.id}`);
    // 惰性：点击前不读 guard.md（目前仅 PROOF.md + proof/ 列表）。
    expect(calls.some((c) => c.includes("/api/files/read") && c.includes("guard.md"))).toBe(false);
    expect(screen.queryByTestId("file-viewer")).toBeNull();

    fireEvent.click(within(list).getByText("proof/guard.md"));

    const viewer = await screen.findByTestId("file-viewer");
    // 读 work root 下规范 slice 相对 proof 路径——核心断言。
    await waitFor(() =>
      expect(
        calls.some((c) => c.includes("/api/files/read") && c.includes("root=work") && c.includes(GUARD_READ)),
      ).toBe(true),
    );
    expect(within(viewer).getByTestId("file-viewer-root-path").textContent).toContain(
      "missions/m/slices/20-drawer/proof/guard.md",
    );
    // DISPLAY 路径保持友好 slice 相对标签 proof/guard.md（drawer header），
    // 与上方解析 read 路径有别——锁定 FileLink 显示。
    expect(within(viewer).getByText("proof/guard.md")).toBeTruthy();
  });

  it("FX-3 (RED): the drawer renders the C1 proof contract — five frontmatter fields + the distinctive body", async () => {
    renderSliceInDrawer();
    const list = await screen.findByTestId(`proof-files-${DRAWER_SLICE.id}`);
    fireEvent.click(within(list).getByText("proof/guard.md"));
    await screen.findByTestId("file-viewer");

    const fm = await screen.findByTestId("markdown-frontmatter");
    for (const field of ["slice", "candidate_sha", "artifact_type", "verdict", "money_evidence"]) {
      expect(within(fm).getByText(field)).toBeTruthy();
    }
    // 独特字段 VALUE（不仅 key）——防止空 header 上的假绿。
    expect(within(fm).getByText("guard")).toBeTruthy();
    expect(within(fm).getByText("7d0997dddaab59f43bcc658fe2c0457128a64f53")).toBeTruthy();
    // BODY（不仅 header）在 drawer 内渲染。
    expect(screen.getByText(/DISTINCTIVE-BODY-MARKER/)).toBeTruthy();
  });

  it("FX-4 (RED): the drawer closes in place — same PROOF surface, location/history unchanged (no navigation)", async () => {
    renderSliceInDrawer();
    const list = await screen.findByTestId(`proof-files-${DRAWER_SLICE.id}`);
    // 交互前锁定精确 SPA location + history depth——整页 raw-asset 导航
    //（该缺陷）正是改变这些的东西。
    const hrefBefore = window.location.href;
    const historyBefore = window.history.length;

    fireEvent.click(within(list).getByText("proof/guard.md"));
    await screen.findByTestId("file-viewer");
    // 打开 drawer 是 in-app：无导航，无 history push。
    expect(window.location.href).toBe(hrefBefore);
    expect(window.history.length).toBe(historyBefore);

    fireEvent.pointerDown(screen.getByTestId("shared-detail-drawer-outside"));
    await waitFor(() => expect(screen.queryByTestId("file-viewer")).toBeNull());
    // 仍在同一 slice proof card，location/history 从未移动。
    expect(screen.getByTestId(`proof-slice-${DRAWER_SLICE.id}`)).toBeTruthy();
    expect(screen.getByTestId(`proof-files-${DRAWER_SLICE.id}`)).toBeTruthy();
    expect(window.location.href).toBe(hrefBefore);
    expect(window.history.length).toBe(historyBefore);
  });

  it("FX-5 (GREEN preservation): image captures + inline PROOF.md images still resolve via /api/files/asset (drawer is markdown-only)", async () => {
    const { container } = renderSliceInDrawer();
    await screen.findByTestId(`proof-slice-${DRAWER_SLICE.id}`);
    // proof/ 图像捕获留在 gallery/lightbox 路径（浏览器可见 asset），非 drawer。
    expect(screen.getByTestId(`proof-gallery-${DRAWER_SLICE.id}`)).toBeTruthy();
    expect(screen.getByTestId("proof-thumb-shot.png")).toBeTruthy();
    // inline PROOF.md 图仍在 /api/files/asset 下解析（guard fcf1126f 不变量）。
    const inline = container.querySelector('img[alt="cap"]') as HTMLImageElement | null;
    expect(inline).toBeTruthy();
    expect(inline!.getAttribute("src") ?? "").toContain("/api/files/asset");
    // 且 guard.md 控件从未触发读取（此处 drawer 保持关闭）。
    expect(calls.some((c) => c.includes("/api/files/read") && c.includes("guard.md"))).toBe(false);
  });
});
