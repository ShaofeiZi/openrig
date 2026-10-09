// OPR.0.4.1.21——Artifacts 高度范围文件 navigator。经既有 /api/files/* 端点的
// 只读投影。针对 7 个 AC 的 TDD；承重者为 AC-3（惰性加载边界——无 eager
// file-body fetch，无树预遍历）。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState, type ReactNode } from "react";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ArtifactsNavigator } from "../src/components/project/ArtifactsNavigator.js";
import { EvidenceOpener, type EvidenceContext } from "../src/components/review/EvidenceOpener.js";
import { DrawerSelectionContext } from "../src/components/AppShell.js";
import { SharedDetailDrawer, type DrawerSelection } from "../src/components/SharedDetailDrawer.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

let calls: string[] = [];

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

// allowlist root "work"（路径 "/ws"）下的 fixture 树。mission 高度 base 为
// missions/release-0.4.1；含一个 slice 子树用于 AC-4。
const TREE: Record<string, Array<{ name: string; type: "dir" | "file" | "other"; size: number | null; mtime: string | null }>> = {
  "missions/release-0.4.1": [
    { name: "README.md", type: "file", size: 4096, mtime: "2026-06-23T22:01:00.000Z" },
    { name: "PROGRESS.md", type: "file", size: 3170, mtime: "2026-06-23T05:00:00.000Z" },
    { name: "slices", type: "dir", size: null, mtime: "2026-06-23T22:52:00.000Z" },
    { name: "digital-twin", type: "dir", size: null, mtime: "2026-06-23T22:52:00.000Z" },
  ],
  "missions/release-0.4.1/slices": [
    { name: "09-seat-restore", type: "dir", size: null, mtime: "2026-06-22T10:00:00.000Z" },
    { name: "15-workspace-ux", type: "dir", size: null, mtime: "2026-06-23T22:52:00.000Z" },
  ],
  "missions/release-0.4.1/slices/15-workspace-ux": [
    { name: "README.md", type: "file", size: 4096, mtime: "2026-06-23T22:01:00.000Z" },
    { name: "batch-1.change.diff", type: "file", size: 12288, mtime: "2026-06-23T22:52:00.000Z" },
    { name: "03-story-dag.intent.png", type: "file", size: 129024, mtime: "2026-06-23T22:53:00.000Z" },
    { name: "proof", type: "dir", size: null, mtime: "2026-06-23T22:52:00.000Z" },
  ],
  // FOUNDER-FIX DELIVERED drill-in 目标——slice proof/ 文件夹 EvidenceOpener
  //（'proof/'）将 ArtifactsNavigator 范围限定到其 C1 文件必须在 drawer 打开。
  "missions/release-0.4.1/slices/15-workspace-ux/proof": [
    { name: "guard.md", type: "file", size: 480, mtime: "2026-06-23T22:52:00.000Z" },
  ],
};

function routeFiles({ rootsStatus = 200, rootsEmpty = false }: { rootsStatus?: number; rootsEmpty?: boolean } = {}) {
  return (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/api/files/roots")) {
      if (rootsStatus === 503) {
        return Promise.resolve(jsonResponse({ error: "files_routes_unavailable", hint: "Configure a workspace files root" }, 503));
      }
      if (rootsEmpty) {
        // files.ts 在未设置 allowlist 时返回 200 空列表 + hint。
        return Promise.resolve(jsonResponse({ roots: [], hint: "No allowlist roots configured. Set OPENRIG_FILES_ALLOWLIST=..." }, 200));
      }
      return Promise.resolve(jsonResponse({ roots: [{ name: "work", path: "/ws" }] }));
    }
    if (url.includes("/api/files/list")) {
      const u = new URL(url, "http://twin.local");
      const path = u.searchParams.get("path") ?? "";
      return Promise.resolve(jsonResponse({ root: "work", path, entries: TREE[path] ?? [] }));
    }
    // 文件 body——仅在文件打开时提供（landing 时绝不；AC-3 锁定此点）。
    if (url.includes("/api/files/read")) {
      const u = new URL(url, "http://twin.local");
      const path = u.searchParams.get("path") ?? "";
      const content = FILE_BODIES[path];
      if (content == null) return Promise.resolve(jsonResponse({ error: "not found" }, 404));
      return Promise.resolve(jsonResponse({ root: "work", path, absolutePath: `/ws/${path}`, content, mtime: "2026-06-23T22:01:00.000Z", contentHash: "h", size: content.length }));
    }
    return Promise.resolve(jsonResponse({}, 404));
  };
}

// C1 proof 契约（docs/reference/sdlc-conventions.md §5）——五个有效字段
//（artifact_type 在闭集内）+ 独特 body，使 DELIVERED drawer 渲染对真实 proof
// 内容断言，绝不假绿。
const GUARD_C1 = [
  "---",
  "slice: slice-15-workspace-ux",
  "candidate_sha: 7d0997dddaab59f43bcc658fe2c0457128a64f53",
  "artifact_type: guard",
  "verdict: PASS",
  "money_evidence: delivered see-all proof/ drill-in opens guard.md in the drawer",
  "---",
  "",
  "# Guard Verdict",
  "",
  "DELIVERED-DRILL-IN-BODY: the proof file opened in the in-app drawer.",
].join("\n");

// 打开文件 body 以 slice 相对 read 路径为键（drawer 内容）。
const FILE_BODIES: Record<string, string> = {
  "missions/release-0.4.1/slices/15-workspace-ux/proof/guard.md": GUARD_C1,
};

function listedPaths(): string[] {
  return calls
    .filter((c) => c.includes("/api/files/list"))
    .map((c) => new URL(c, "http://twin.local").searchParams.get("path") ?? "");
}

function renderNav(scopePath: string | null = "/ws/missions/release-0.4.1", scopeLabel = "release-0.4.1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ArtifactsNavigator scopePath={scopePath} scopeLabel={scopeLabel} />
    </QueryClientProvider>,
  );
}

describe("OPR.0.4.1.21 — Artifacts navigator", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    calls = [];
  });
  afterEach(() => cleanup());

  it("AC-1: renders the folder tree (left) + the selected folder's file list (right)", async () => {
    mockFetch.mockImplementation(routeFiles());
    renderNav();
    await waitFor(() => expect(screen.getByTestId("artifacts-navigator")).toBeTruthy());
    expect(screen.getByTestId("artifacts-tree")).toBeTruthy();
    expect(screen.getByTestId("artifacts-file-list")).toBeTruthy();
    // 右侧 pane 列出 base 文件夹的 FILES（非 dirs）；等 base /list resolve
    // 后再断言惰性渲染的树子节点。
    await waitFor(() => expect(screen.getByTestId("artifacts-file-row-README.md")).toBeTruthy());
    expect(screen.getByTestId("artifacts-file-row-PROGRESS.md")).toBeTruthy();
    // 树根展开显示 base 文件夹的子文件夹。
    expect(screen.getByTestId("artifacts-tree-folder-missions/release-0.4.1/slices")).toBeTruthy();
  });

  it("AC-2: each file row shows a type badge (from extension), size, and mtime", async () => {
    mockFetch.mockImplementation(routeFiles());
    renderNav();
    await waitFor(() => expect(screen.getByTestId("artifacts-file-row-README.md")).toBeTruthy());
    expect(screen.getByTestId("artifacts-file-badge-README.md").textContent).toBe("MD");
    expect(screen.getByTestId("artifacts-file-size-README.md").textContent).toBe("4.0 KB");
    // mtime 来自 /list 条目并按本地时区格式化，不是伪造值。
    const expectedMtime = new Date("2026-06-23T22:01:00.000Z");
    const expectedDate = `${String(expectedMtime.getMonth() + 1).padStart(2, "0")}-${String(expectedMtime.getDate()).padStart(2, "0")}`;
    expect(screen.getByTestId("artifacts-file-mtime-README.md").textContent).toContain(expectedDate);
  });

  it("AC-3: lazy-load boundary — landing fetches only /roots + /list(base); NO file bodies, NO tree pre-walk", async () => {
    mockFetch.mockImplementation(routeFiles());
    renderNav();
    await waitFor(() => expect(screen.getByTestId("artifacts-file-row-README.md")).toBeTruthy());

    // 仅 /roots + /list(base)。
    expect(calls.some((c) => c.includes("/api/files/roots"))).toBe(true);
    expect(listedPaths()).toContain("missions/release-0.4.1");
    // landing 时无 file body fetch（slice-17 over-fetch 教训）。
    expect(calls.some((c) => c.includes("/api/files/read"))).toBe(false);
    expect(calls.some((c) => c.includes("/api/files/asset"))).toBe(false);
    // 未预遍历：折叠子文件夹在展开前列出。
    expect(listedPaths()).not.toContain("missions/release-0.4.1/slices");
  });

  it("AC-3 (expand is lazy): expanding a folder fetches /list for THAT folder only", async () => {
    mockFetch.mockImplementation(routeFiles());
    renderNav();
    await waitFor(() => expect(screen.getByTestId("artifacts-tree-toggle-missions/release-0.4.1/slices")).toBeTruthy());
    expect(listedPaths()).not.toContain("missions/release-0.4.1/slices");

    fireEvent.click(screen.getByTestId("artifacts-tree-toggle-missions/release-0.4.1/slices"));
    await waitFor(() => expect(listedPaths()).toContain("missions/release-0.4.1/slices"));
    // 仍无 file body，且孙级 slice 未预遍历。
    expect(calls.some((c) => c.includes("/api/files/read"))).toBe(false);
    expect(listedPaths()).not.toContain("missions/release-0.4.1/slices/15-workspace-ux");
  });

  it("AC-4: altitude scoping — a slice scopePath roots the tree at the slice dir, no sibling slices", async () => {
    mockFetch.mockImplementation(routeFiles());
    renderNav("/ws/missions/release-0.4.1/slices/15-workspace-ux", "15-workspace-ux");
    await waitFor(() => expect(screen.getByTestId("artifacts-file-row-batch-1.change.diff")).toBeTruthy());
    // 右侧 pane 列出 slice 的文件。
    expect(screen.getByTestId("artifacts-file-badge-batch-1.change.diff").textContent).toBe("DIFF");
    expect(screen.getByTestId("artifacts-file-badge-03-story-dag.intent.png").textContent).toBe("PNG");
    // 树以 slice 为根；列出的 base 是 slice 目录，且 sibling slice
    //（09-seat-restore）绝不浮出。
    expect(listedPaths()).toContain("missions/release-0.4.1/slices/15-workspace-ux");
    expect(listedPaths()).not.toContain("missions/release-0.4.1/slices");
    expect(screen.queryByTestId("artifacts-tree-folder-missions/release-0.4.1/slices/09-seat-restore")).toBeNull();
  });

  it("AC-5: no allowlist root configured (503) renders a self-explanatory setup hint", async () => {
    mockFetch.mockImplementation(routeFiles({ rootsStatus: 503 }));
    renderNav();
    await waitFor(() => expect(screen.getByTestId("artifacts-navigator-unavailable")).toBeTruthy());
    expect(screen.getByTestId("artifacts-navigator-unavailable").textContent).toMatch(/files root/i);
    // 只读：从未写。
    expect(calls.some((c) => c.includes("/api/files/write"))).toBe(false);
  });

  // rev1-r2 回归：no-allowlist 情形非 503——files.ts 返回 200 带
  // { roots: [], hint }。必须显示同一 setup hint（优先 daemon 的 hint），
  // 而非误导性 "out of scope / no artifacts" 状态。
  it("AC-5 (empty roots): a 200 roots:[] + hint (no allowlist) renders the setup hint, not 'no artifacts'", async () => {
    mockFetch.mockImplementation(routeFiles({ rootsEmpty: true }));
    renderNav();
    await waitFor(() => expect(screen.getByTestId("artifacts-navigator-unavailable")).toBeTruthy());
    // daemon 自身 hint 浮出（可执行 setup 指令）。
    expect(screen.getByTestId("artifacts-navigator-unavailable").textContent).toMatch(/OPENRIG_FILES_ALLOWLIST/);
    // 非误导性 out-of-scope 状态。
    expect(screen.queryByTestId("artifacts-navigator-no-scope")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // FOUNDER FIX（qitem-20260722234754-e8db7111）——DELIVERED proof/ drill-in
  // 段。第二个 founder 命名站点：DELIVERED "see all proof" -> 真实
  // EvidenceOpener('proof/') 文件夹控件 -> ArtifactsNavigator 范围限定到 slice
  // proof/ 目录，其 C1 文件行经 FileLink -> drawer。
  // GREEN 保留：此调用方已 IN-APP 打开，故此处无需生产改动——经真实路径锁定
  // 防回归。
  // -------------------------------------------------------------------------
  it("DELIVERED preservation: delivered-see-all -> EvidenceOpener('proof/') opens a proof C1 file IN the drawer, not a full-page asset", async () => {
    mockFetch.mockImplementation(routeFiles());
    const ctx: EvidenceContext = {
      root: "work",
      relPath: "missions/release-0.4.1/slices/15-workspace-ux",
      slicePath: "/ws/missions/release-0.4.1/slices/15-workspace-ux",
    };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <DrawerHost>
          <EvidenceOpener evidenceRef="proof/" ctx={ctx} testId="delivered-see-all" />
        </DrawerHost>
      </QueryClientProvider>,
    );
    // 锁定精确 SPA location + history depth——raw-asset 导航会改变这些。
    const hrefBefore = window.location.href;
    const historyBefore = window.history.length;

    // DELIVERED "see all proof" 文件夹控件是真实 founder 命名调用方。
    const folderBtn = screen.getByTestId("delivered-see-all-folder");
    expect(calls.some((c) => c.includes("/api/files/read"))).toBe(false); // lazy: nothing read yet
    fireEvent.click(folderBtn);

    // proof/ 文件夹 drill 进 navigator；其 C1 文件行是 in-app 控件。
    const openCtrl = await screen.findByTestId("artifacts-file-open-guard.md");
    expect(openCtrl.closest("a")).toBeNull();
    expect(screen.queryByTestId("file-viewer")).toBeNull();

    fireEvent.click(openCtrl);

    const viewer = await screen.findByTestId("file-viewer");
    // 读 work root 下精确 slice proof 路径——绝不 /asset 逃出。
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.includes("/api/files/read") &&
            c.includes("root=work") &&
            c.includes("15-workspace-ux%2Fproof%2Fguard.md"),
        ),
      ).toBe(true),
    );
    expect(calls.some((c) => c.includes("/api/files/asset"))).toBe(false);
    // 有效 C1 header（五字段）+ 独特 body 在 drawer 渲染。
    const fm = within(viewer).getByTestId("markdown-frontmatter");
    for (const field of ["slice", "candidate_sha", "artifact_type", "verdict", "money_evidence"]) {
      expect(within(fm).getByText(field)).toBeTruthy();
    }
    expect(within(fm).getByText("guard")).toBeTruthy();
    expect(screen.getByText(/DELIVERED-DRILL-IN-BODY/)).toBeTruthy();

    // 原地关闭——opener + drilled 文件夹保留；location/history 未动。
    fireEvent.pointerDown(screen.getByTestId("shared-detail-drawer-outside"));
    await waitFor(() => expect(screen.queryByTestId("file-viewer")).toBeNull());
    expect(screen.getByTestId("delivered-see-all-folder")).toBeTruthy();
    expect(screen.getByTestId("artifacts-file-open-guard.md")).toBeTruthy();
    expect(window.location.href).toBe(hrefBefore);
    expect(window.history.length).toBe(historyBefore);
  });
});

// 最小真实 drawer host——镜像 AppShell 的 DrawerSelection provider +
// SharedDetailDrawer，使 FileLink 点击端到端真正打开 drawer。
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

// ---------------------------------------------------------------------------
// PM HALF-PASS（qitem-20260723005752-5ee2eea4）：在 proof-directory 浏览器中，
// 文件 HIT TARGET 仅为嵌套 FileLink 文件名按钮；row/tree WRAPPER 表面
//（右侧 pane 带 badge/size/mtime 的 <li>；tree-item 缩进 <li>）是 INERT
//（无 onClick）。用户点 row/item（PM）得不到 selection/read/drawer；点精确
// 文件名按钮（QA-local）有效。两个 RED 在真实 drawer host 下点 inert wrapper；
// GREEN 控件证明嵌套文件名按钮对右侧和树路径都仍有效。
// ---------------------------------------------------------------------------
const PROOF_SCOPE = "/ws/missions/release-0.4.1/slices/15-workspace-ux/proof";
const PROOF_READ_PATH = "missions/release-0.4.1/slices/15-workspace-ux/proof/guard.md";
const TREE_FILE_TID = `artifacts-tree-file-${PROOF_READ_PATH}`;

function renderProofNavInDrawer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DrawerHost>
        <ArtifactsNavigator scopePath={PROOF_SCOPE} scopeLabel="proof" />
      </DrawerHost>
    </QueryClientProvider>,
  );
}

// 断言 guard.md C1 文件 drawer 已打开：精确 read、一个 file viewer、五个 C1
// labels+values，以及独特 body。
async function assertGuardC1Drawer() {
  await screen.findByTestId("file-viewer");
  // guard.md 恰好一次 /api/files/read——解析（非子串）：pathname
  // /api/files/read，root=work，path 精确为 slice 相对 proof 路径。
  await waitFor(() => {
    const guardReads = calls
      .map((c) => new URL(c, "http://nav.local"))
      .filter(
        (u) =>
          u.pathname === "/api/files/read" &&
          u.searchParams.get("root") === "work" &&
          u.searchParams.get("path") === PROOF_READ_PATH,
      );
    expect(guardReads.length).toBe(1);
  });
  // 恰好打开一个 file viewer。
  expect(screen.getAllByTestId("file-viewer").length).toBe(1);
  const fm = within(screen.getByTestId("file-viewer")).getByTestId("markdown-frontmatter");
  const C1: Array<[string, string | RegExp]> = [
    ["slice", "slice-15-workspace-ux"],
    ["candidate_sha", "7d0997dddaab59f43bcc658fe2c0457128a64f53"],
    ["artifact_type", "guard"],
    ["verdict", "PASS"],
    ["money_evidence", /delivered see-all proof/],
  ];
  for (const [k, v] of C1) {
    expect(within(fm).getByText(k)).toBeTruthy();
    expect(within(fm).getByText(v)).toBeTruthy();
  }
  expect(screen.getByText(/DELIVERED-DRILL-IN-BODY/)).toBeTruthy();
}

describe("Artifacts navigator — proof-file hit target (PM half-pass 5ee2eea4)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(routeFiles());
    calls = [];
  });
  afterEach(() => cleanup());

  it("R-right (RED): clicking a REAL inert visible right-row child (the size cell, not artifacts-file-open) opens the file drawer with C1", async () => {
    renderProofNavInDrawer();
    await screen.findByTestId("artifacts-file-row-guard.md");
    // 用户目标的真实可见 row 子节点——当前是文件名按钮的 sibling，故 inert。
    // 把全部 row 内容包进 FileLink 使其 green（click 冒泡到按钮）；非合成
    // wrapper click。
    const sizeCell = screen.getByTestId("artifacts-file-size-guard.md");
    expect(calls.some((c) => c.includes("/api/files/read"))).toBe(false);
    expect(screen.queryByTestId("file-viewer")).toBeNull();
    const hrefBefore = window.location.href;
    const historyBefore = window.history.length;
    fireEvent.click(sizeCell);
    await assertGuardC1Drawer();
    // in-app：无导航。
    expect(window.location.href).toBe(hrefBefore);
    expect(window.history.length).toBe(historyBefore);
  });

  it("R-tree (RED, structural hitbox): the noninteractive <li> owns no indentation; the artifacts-tree-file button owns the depth indentation + full-width hit area", async () => {
    renderProofNavInDrawer();
    // artifacts-tree-file-* 是可用 FileLink 按钮（见下方 GREEN 控件）；此 RED
    // 锁定 HITBOX 结构，非合成 li click。
    const treeBtn = await screen.findByTestId(TREE_FILE_TID);
    const treeLi = treeBtn.closest("li");
    expect(treeLi).toBeTruthy();
    // 期望：非交互 wrapper <li> 不带缩进 padding……
    expect(treeLi!.style.paddingLeft).toBe("");
    // ……交互 FileLink 按钮持有深度缩进 + 全宽，使整个缩进 row（不仅文件名字形）
    // 是真实 hit target。
    expect(treeBtn.style.paddingLeft).not.toBe("");
    expect(treeBtn.className).toContain("w-full");
  });

  it("GREEN control (right): clicking the nested right-pane filename button opens the file drawer with C1", async () => {
    renderProofNavInDrawer();
    const btn = await screen.findByTestId("artifacts-file-open-guard.md");
    expect(screen.queryByTestId("file-viewer")).toBeNull();
    fireEvent.click(btn);
    await assertGuardC1Drawer();
  });

  it("GREEN control (tree): clicking the nested tree filename button opens the file drawer with C1", async () => {
    renderProofNavInDrawer();
    const btn = await screen.findByTestId(TREE_FILE_TID);
    expect(screen.queryByTestId("file-viewer")).toBeNull();
    fireEvent.click(btn);
    await assertGuardC1Drawer();
  });
});
