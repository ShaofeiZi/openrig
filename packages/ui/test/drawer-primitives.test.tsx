// V1 第三次尝试阶段 4——抽屉原语可达性证明（约束流程 #6）。
//
// 阶段 4 P4-2 使用点触发器接线延后到阶段 5；在没有实时消费者时，4 个查看器与 4 个触发器
// 至少需要单元级证明，避免回归悄然混入。覆盖范围：
//
// - 每个查看器接收规范形态属性时均可无崩溃渲染。
// - 每个触发器点击后都以正确的 DrawerSelection 判别值
//   （`type: "qitem" | "file" | "sub-spec"`）及匹配 payload 调用 setSelection。
// - SharedDetailDrawer 根据 selection.type 路由到正确的查看器组件。
//
// V1 润色 slice 阶段 5.1 P5.1-D2：SeatDetailViewer 与 SeatDetailTrigger 已退役。
// seat-detail 导航改到 /topology/seat/$rigId/$logicalId 中心页（LiveNodeDetails）。
// DrawerSelection 联合类型中已移除 'seat-detail'；本文件现在只覆盖剩余 3 个抽屉表面
//（qitem/file/sub-spec）。退役回归守卫位于 test/node-selection-migration.test.tsx。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, cleanup, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import {
  DrawerSelectionContext,
  type DrawerSelection,
} from "../src/components/AppShell.js";
import { QueueItemViewer } from "../src/components/drawer-viewers/QueueItemViewer.js";
import { FileViewer } from "../src/components/drawer-viewers/FileViewer.js";
import { SubSpecPreview } from "../src/components/drawer-viewers/SubSpecPreview.js";
import { QueueItemTrigger } from "../src/components/drawer-triggers/QueueItemTrigger.js";
import { FileReferenceTrigger } from "../src/components/drawer-triggers/FileReferenceTrigger.js";
import { SubSpecTrigger } from "../src/components/drawer-triggers/SubSpecTrigger.js";
import { SharedDetailDrawer } from "../src/components/SharedDetailDrawer.js";

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderWithQuery(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// 查看器——使用规范形态属性时无崩溃渲染。
// ---------------------------------------------------------------------------

describe("Drawer viewers (P4-1) render with canonical props", () => {
  it("QueueItemViewer renders header + body preview given canonical qitem shape", () => {
    const { getByTestId } = render(
      <QueueItemViewer
        qitemId="qitem-20260506-test"
        source="orch-lead@openrig-velocity"
        destination="redo3-driver-3@openrig-velocity"
        state="pending"
        tags={["code-review"]}
        createdAt="2026-05-06T18:00:00Z"
        body={"line 1\nline 2\nline 3"}
        related={[{ kind: "file", label: "review-notes.md", href: "/files/review-notes.md" }]}
      />,
    );
    expect(getByTestId("queue-item-viewer")).toBeTruthy();
    expect(getByTestId("qitem-body").textContent).toContain("line 1");
    expect(getByTestId("queue-item-viewer").querySelector("li svg")).toBeTruthy();
  });

  it("QueueItemViewer empty-state when no qitemId", () => {
    const { getByTestId } = render(<QueueItemViewer qitemId="" />);
    expect(getByTestId("queue-item-viewer-empty")).toBeTruthy();
  });

  it("FileViewer renders markdown content when kind=markdown + content present", () => {
    const { getByTestId } = render(
      <FileViewer path="docs/guide.md" kind="markdown" content="# Hello" />,
    );
    const root = getByTestId("file-viewer");
    expect(root.getAttribute("data-file-kind")).toBe("markdown");
    expect(root.querySelector("header svg")).toBeTruthy();
  });

  it("FileViewer infers kind from path extension when kind omitted", () => {
    const { getByTestId } = render(
      <FileViewer path="config/agent.yaml" content="name: test" />,
    );
    expect(getByTestId("file-viewer").getAttribute("data-file-kind")).toBe("yaml");
  });

  it("FileViewer honest NOT-RESOLVABLE state when no content/imageUrl and no readable target", () => {
    // 追溯演示回修：既无 content 又无 root/absolutePath 时不可能加载；查看器现在会明确说明，
    // 不再永久停留在旧的空白/加载中状态。
    const { getByTestId } = render(<FileViewer path="missing.md" kind="markdown" />);
    expect(getByTestId("file-viewer-unresolvable")).toBeTruthy();
  });

  it("FileViewer reads drawer content from an explicit /api/files root + path", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("/api/files/read?root=workspace&path=docs%2Frole.md");
      return {
        ok: true,
        json: async () => ({
          root: "workspace",
          path: "docs/role.md",
          absolutePath: "/workspace/docs/role.md",
          content: "# Role\nLoaded from files API.",
          mtime: "2026-05-07T00:00:00.000Z",
          contentHash: "hash",
          size: 29,
          truncated: false,
          truncatedAtBytes: null,
          totalBytes: 29,
        }),
      };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderWithQuery(
      <FileViewer path="role.md" kind="markdown" root="workspace" readPath="docs/role.md" />,
    );

    expect(await screen.findByTestId("file-viewer")).toBeTruthy();
    expect(screen.getByText(/Loaded from files API/)).toBeTruthy();
    expect(screen.getByTestId("file-viewer-root-path").textContent).toBe("workspace/docs/role.md");
  });

  it("FileViewer resolves an absolute file path against /api/files roots", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/files/roots") {
        return {
          ok: true,
          json: async () => ({ roots: [{ name: "workspace", path: "/workspace" }] }),
        };
      }
      expect(url).toBe("/api/files/read?root=workspace&path=agents%2Frole.md");
      return {
        ok: true,
        json: async () => ({
          root: "workspace",
          path: "agents/role.md",
          absolutePath: "/workspace/agents/role.md",
          content: "# Agent Role",
          mtime: "2026-05-07T00:00:00.000Z",
          contentHash: "hash",
          size: 12,
          truncated: false,
          truncatedAtBytes: null,
          totalBytes: 12,
        }),
      };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderWithQuery(
      <FileViewer path="role.md" kind="markdown" absolutePath="/workspace/agents/role.md" />,
    );

    expect(await screen.findByTestId("file-viewer")).toBeTruthy();
    expect(screen.getByText(/Agent Role/)).toBeTruthy();
    expect(screen.getByTestId("file-viewer-root-path").textContent).toBe("workspace/agents/role.md");
  });

  // -------------------------------------------------------------------------
  // FOUNDER-FIX 阻断项（qitem-20260723002125-9e4526a0）：抽屉 FileViewer 的 Markdown
  // 分支必须传入 assetBasePath，使 C1 正文中的相对图片通过 /api/files/asset 解析
  //（取已解析 target.path 的 dirname），而不是形成损坏的 SPA 路由相对 URL。QA 实测发现
  // proof/qa.md 正文中的 ![](proof-image.png) 被解析成
  // http://host/project/slice/proof-image.png。该测试针对 FileViewer.tsx 为红；当时它渲染
  // <MarkdownViewer content={content}/> 却未传 assetBasePath。使用语义 URL 解析并解码参数，
  // 绝不依赖脆弱的编码字符串匹配。
  // -------------------------------------------------------------------------
  const C1_QA = [
    "---",
    "slice: fg1-09-locked-media",
    "candidate_sha: 44ef16c1b57fdf06f486a287bf9434b8971accf0",
    "artifact_type: qa",
    "verdict: PASS",
    "money_evidence: inline proof image resolves via /api/files/asset",
    "---",
    "",
    "# QA Verdict",
    "",
    "DISTINCTIVE-QA-BODY line.",
    "",
    "![proof](proof-image.png)",
  ].join("\n");

  function readContentMock(content: string, readPath: string, expectedRoot: string) {
    return vi.fn(async (url: string) => {
      // 语义锁定：FileViewer 读取已解析的 root/readPath，绝不读取展示路径。
      const u = new URL(String(url), "http://drawer.local");
      expect(u.pathname).toBe("/api/files/read");
      expect(u.searchParams.get("root")).toBe(expectedRoot);
      expect(u.searchParams.get("path")).toBe(readPath);
      return {
        ok: true,
        json: async () => ({
          root: expectedRoot,
          path: readPath,
          absolutePath: `/ws/${readPath}`,
          content,
          mtime: "2026-07-23T00:00:00.000Z",
          contentHash: "h",
          size: content.length,
          truncated: false,
          truncatedAtBytes: null,
          totalBytes: content.length,
        }),
      };
    });
  }

  // 把 Markdown 内联图片 src 解码为 {pathname, root, path}，用于语义断言。
  function assetParams(src: string) {
    const u = new URL(src, "http://drawer.local");
    return { pathname: u.pathname, root: u.searchParams.get("root"), path: u.searchParams.get("path") };
  }

  it("FileViewer RED-1: inline C1-body image resolves via /api/files/asset using dirname of the RESOLVED target.path (not the display path)", async () => {
    globalThis.fetch = readContentMock(C1_QA, "missions/m/slices/s/proof/qa.md", "workspace") as unknown as typeof fetch;
    // 展示路径故意与 readPath 不同；派生必须使用 target.path。
    renderWithQuery(
      <FileViewer path="proof/qa.md" kind="markdown" root="workspace" readPath="missions/m/slices/s/proof/qa.md" />,
    );
    // C1 五字段页头——标签和值（创建者契约是页头 + 正文，不是泛化键）——以及可区分的正文
    // 都必须继续渲染。
    const fm = await screen.findByTestId("markdown-frontmatter");
    const C1_FIELDS: Array<[string, string | RegExp]> = [
      ["slice", "fg1-09-locked-media"],
      ["candidate_sha", "44ef16c1b57fdf06f486a287bf9434b8971accf0"],
      ["artifact_type", "qa"],
      ["verdict", "PASS"],
      ["money_evidence", /inline proof image resolves/],
    ];
    for (const [key, value] of C1_FIELDS) {
      expect(within(fm).getByText(key)).toBeTruthy();
      expect(within(fm).getByText(value)).toBeTruthy();
    }
    expect(screen.getByText(/DISTINCTIVE-QA-BODY/)).toBeTruthy();
    // 内联图片通过规范资源 URL 解析：准确使用一次 readPath 的 dirname。
    const img = await screen.findByTestId("md-inline-image");
    const p = assetParams(img.getAttribute("src") ?? "");
    expect(p.pathname).toBe("/api/files/asset");
    expect(p.root).toBe("workspace");
    expect(p.path).toBe("missions/m/slices/s/proof/proof-image.png");
  });

  it("FileViewer RED-2: a root-file readPath (no directory) anchors the asset parent at '.', never a leading slash", async () => {
    globalThis.fetch = readContentMock(C1_QA, "qa.md", "slice-root") as unknown as typeof fetch;
    renderWithQuery(
      <FileViewer path="qa.md" kind="markdown" root="slice-root" readPath="qa.md" />,
    );
    const img = await screen.findByTestId("md-inline-image");
    const p = assetParams(img.getAttribute("src") ?? "");
    expect(p.pathname).toBe("/api/files/asset");
    expect(p.root).toBe("slice-root");
    expect(p.path).toBe("./proof-image.png");
    expect(p.path?.startsWith("/")).toBe(false);
  });

  it("FileViewer passthrough (GREEN preservation): absolute http(s)/data:/leading-slash image srcs pass through unchanged even with a derived asset base", async () => {
    const body = [
      "---",
      "slice: s",
      "candidate_sha: x",
      "artifact_type: qa",
      "verdict: PASS",
      "money_evidence: e",
      "---",
      "",
      "![remote](https://example.com/img.png)",
      "",
      "![data](data:image/png;base64,AAAA)",
      "",
      "![rooted](/already/absolute.png)",
    ].join("\n");
    globalThis.fetch = readContentMock(body, "missions/m/slices/s/proof/qa.md", "workspace") as unknown as typeof fetch;
    renderWithQuery(
      <FileViewer path="proof/qa.md" kind="markdown" root="workspace" readPath="missions/m/slices/s/proof/qa.md" />,
    );
    await screen.findByTestId("markdown-frontmatter");
    const imgs = screen.getAllByTestId("md-inline-image").map((i) => i.getAttribute("src"));
    // 每种绝对形式都逐字保留，派生基址绝不改写它们；此透传也由
    // markdown-viewer.test.tsx 第 85–89/92–96 行的单元测试锁定。
    expect(imgs).toContain("https://example.com/img.png");
    expect(imgs).toContain("data:image/png;base64,AAAA");
    expect(imgs).toContain("/already/absolute.png");
  });

  it("SubSpecPreview renders header + manifest excerpt; no Link when entryId omitted", () => {
    const { getByTestId, queryByTestId } = render(
      <SubSpecPreview
        specKind="rig"
        specName="openrig-velocity"
        version="0.2.0"
        source="builtin"
        manifestExcerpt="name: openrig-velocity\nversion: 0.2.0"
      />,
    );
    expect(getByTestId("sub-spec-preview")).toBeTruthy();
    // 省略 entryId 时不渲染在中心打开的 Link，以免依赖路由上下文。
    expect(queryByTestId("sub-spec-open-center")).toBeNull();
  });

  // V1 润色 slice 阶段 5.1 P5.1-D2：SeatDetailViewer 已退役。负向断言守卫位于
  // test/node-selection-migration.test.tsx。
});

// ---------------------------------------------------------------------------
// 触发器——点击后以正确的 DrawerSelection 结构调用 setSelection。
// ---------------------------------------------------------------------------

function renderWithDrawerCtx(
  ui: React.ReactNode,
): { setSelection: ReturnType<typeof vi.fn> } & ReturnType<typeof render> {
  const setSelection = vi.fn();
  const utils = render(
    <DrawerSelectionContext.Provider value={{ selection: null, setSelection }}>
      {ui}
    </DrawerSelectionContext.Provider>,
  );
  return { setSelection, ...utils };
}

describe("Drawer triggers (P4-2) fire setSelection with correct kind on click", () => {
  it("QueueItemTrigger click → setSelection({ type: 'qitem', data })", () => {
    const data = { qitemId: "qitem-T", body: "preview" };
    const { setSelection, getByTestId } = renderWithDrawerCtx(
      <QueueItemTrigger data={data}>open</QueueItemTrigger>,
    );
    fireEvent.click(getByTestId("queue-item-trigger"));
    expect(setSelection).toHaveBeenCalledOnce();
    expect(setSelection).toHaveBeenCalledWith({ type: "qitem", data });
  });

  it("FileReferenceTrigger click → setSelection({ type: 'file', data })", () => {
    const data = { path: "notes.md", kind: "markdown" as const, content: "# h" };
    const { setSelection, getByTestId } = renderWithDrawerCtx(
      <FileReferenceTrigger data={data}>open</FileReferenceTrigger>,
    );
    fireEvent.click(getByTestId("file-reference-trigger"));
    expect(setSelection).toHaveBeenCalledWith({ type: "file", data });
  });

  it("SubSpecTrigger click → setSelection({ type: 'sub-spec', data })", () => {
    const data = { specKind: "rig", specName: "openrig-velocity" };
    const { setSelection, getByTestId } = renderWithDrawerCtx(
      <SubSpecTrigger data={data}>open</SubSpecTrigger>,
    );
    fireEvent.click(getByTestId("sub-spec-trigger"));
    expect(setSelection).toHaveBeenCalledWith({ type: "sub-spec", data });
  });

  // V1 润色 slice 阶段 5.1 P5.1-D2：SeatDetailTrigger 已退役。该已删除原语的点击契约
  // 由 node-selection-migration.test.tsx 中的“文件不存在”负向断言守卫。

  it("trigger custom testId override is respected (predicate-consistency probe)", () => {
    const data = { qitemId: "q", body: "b" };
    const { setSelection, getByTestId } = renderWithDrawerCtx(
      <QueueItemTrigger data={data} testId="custom-q-trigger">x</QueueItemTrigger>,
    );
    fireEvent.click(getByTestId("custom-q-trigger"));
    expect(setSelection).toHaveBeenCalledWith({ type: "qitem", data });
  });
});

// ---------------------------------------------------------------------------
// SharedDetailDrawer 路由——selection.type → 正确的查看器组件。
// ---------------------------------------------------------------------------

const NOOP_PROPS = {
  events: [],
  selectedDiscoveredId: null as string | null,
  onSelectDiscoveredId: () => {},
  placementTarget: null,
  onClearPlacement: () => {},
};

describe("SharedDetailDrawer (Phase 4) routes selection.type to the correct viewer", () => {
  it("selection=null renders nothing (default-closed contract — SC-6)", () => {
    const { container } = render(
      <SharedDetailDrawer selection={null} onClose={() => {}} {...NOOP_PROPS} />,
    );
    expect(container.querySelector("[data-testid='shared-detail-drawer']")).toBeNull();
  });

  it("selection.type='qitem' → QueueItemViewer mounts in drawer", () => {
    const selection: DrawerSelection = {
      type: "qitem",
      data: { qitemId: "qitem-routing-test", body: "x" },
    };
    const { getByTestId } = render(
      <SharedDetailDrawer selection={selection} onClose={() => {}} {...NOOP_PROPS} />,
    );
    expect(getByTestId("queue-item-viewer")).toBeTruthy();
  });

  it("selection.type='file' → FileViewer mounts in drawer", () => {
    const selection: DrawerSelection = {
      type: "file",
      data: { path: "x.md", kind: "markdown", content: "# h" },
    };
    const { getByTestId } = render(
      <SharedDetailDrawer selection={selection} onClose={() => {}} {...NOOP_PROPS} />,
    );
    expect(getByTestId("file-viewer")).toBeTruthy();
  });

  it("selection.type='sub-spec' → SubSpecPreview mounts in drawer", () => {
    const selection: DrawerSelection = {
      type: "sub-spec",
      data: { specKind: "rig", specName: "openrig-velocity" },
    };
    const { getByTestId } = render(
      <SharedDetailDrawer selection={selection} onClose={() => {}} {...NOOP_PROPS} />,
    );
    expect(getByTestId("sub-spec-preview")).toBeTruthy();
  });

  it("outside click closes the drawer, while inside click keeps it open", () => {
    const onClose = vi.fn();
    const selection: DrawerSelection = {
      type: "qitem",
      data: { qitemId: "qitem-routing-test", body: "x" },
    };
    const { getByTestId } = render(
      <SharedDetailDrawer selection={selection} onClose={onClose} {...NOOP_PROPS} />,
    );

    fireEvent.pointerDown(getByTestId("shared-detail-drawer"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.pointerDown(getByTestId("shared-detail-drawer-outside"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // CORRECTIVE §7.2（创建者，2026-07-05）——从三个 token 上撤销左侧重制：edge 属性改回
  // RIGHT（边框侧）、定位器使用 right-0 锚点类，并移除 FR-11.1 的 z-50 提升
  //（右边缘从未与侧栏的 z-40 冲突）。
  it("the shared drawer anchors to the RIGHT edge with the pre-flip z (three-token revert)", () => {
    const selection: DrawerSelection = {
      type: "file",
      data: { path: "x.md", kind: "markdown", content: "# h" },
    };
    const { getByTestId } = render(
      <SharedDetailDrawer selection={selection} onClose={() => {}} {...NOOP_PROPS} />,
    );
    const layer = getByTestId("shared-detail-drawer-layer");
    expect(layer.className).toContain("z-30");
    expect(layer.className).not.toContain("z-50");
    const sheet = getByTestId("shared-detail-drawer");
    expect(sheet.className).toContain("right-0");
    expect(sheet.className).not.toContain("left-0");
  });

  // V1 润色 slice 阶段 5.1 P5.1-D2：DrawerSelection 联合类型中的 'seat-detail' 已退役；
  // 导航到 /topology/seat/$rigId/$logicalId 中心页（LiveNodeDetails）取代了抽屉挂载变体。
  // 'seat-detail' 的按类型路由测试也随该类别一并移除。
});
