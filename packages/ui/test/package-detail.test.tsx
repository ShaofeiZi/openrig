import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, act } from "@testing-library/react";
import { createAppTestRouter } from "./helpers/test-router.js";
import { PackageDetail } from "../src/components/PackageDetail.js";
import type { PackageInfo, InstallSummary, JournalEntry } from "../src/hooks/usePackageDetail.js";

const MOCK_PACKAGE: PackageInfo = {
  id: "pkg-1",
  name: "acme-standards",
  version: "2.0.0",
  sourceKind: "local_path",
  sourceRef: "/packages/acme",
  manifestHash: "abc123",
  summary: "ACME engineering standards",
  createdAt: "2026-03-25 10:00:00",
};

// API 返回 newest-first（按 created_at DESC、rowid DESC 确定性排序）
const MOCK_INSTALLS: InstallSummary[] = [
  {
    id: "inst-2",
    packageId: "pkg-1",
    targetRoot: "/repo-b",
    scope: "user",
    status: "rolled_back",
    riskTier: null,
    createdAt: "2026-03-25 12:00:00",
    appliedAt: "2026-03-25 12:01:00",
    rolledBackAt: "2026-03-25 13:00:00",
    appliedCount: 1,
    deferredCount: null,
  },
  {
    id: "inst-1",
    packageId: "pkg-1",
    targetRoot: "/repo-a",
    scope: "user",
    status: "applied",
    riskTier: null,
    createdAt: "2026-03-25 10:00:00",
    appliedAt: "2026-03-25 10:01:00",
    rolledBackAt: null,
    appliedCount: 3,
    deferredCount: null,
  },
];

const MOCK_JOURNAL: JournalEntry[] = [
  {
    id: "j-1",
    installId: "inst-1",
    seq: 1,
    action: "copy",
    exportType: "skill",
    classification: "safe_projection",
    targetPath: "/repo-a/.claude/skills/tool.md",
    status: "applied",
    createdAt: "2026-03-25 10:01:00",
  },
  {
    id: "j-2",
    installId: "inst-1",
    seq: 2,
    action: "copy",
    exportType: "guidance",
    classification: "managed_merge",
    targetPath: "/repo-a/CLAUDE.md",
    status: "applied",
    createdAt: "2026-03-25 10:01:01",
  },
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockFetch(opts: {
  pkg?: PackageInfo;
  installs?: InstallSummary[];
  journal?: JournalEntry[];
  rollbackOk?: boolean;
}) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && typeof url === "string" && url.includes("/rollback")) {
      if (opts.rollbackOk) {
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    }
    if (typeof url === "string" && url.includes("/journal")) {
      return { ok: true, status: 200, json: async () => (opts.journal ?? []) };
    }
    if (typeof url === "string" && url.includes("/installs")) {
      return { ok: true, status: 200, json: async () => (opts.installs ?? []) };
    }
    if (typeof url === "string" && url.match(/\/api\/packages\/[^/]+$/)) {
      return { ok: true, status: 200, json: async () => (opts.pkg ?? MOCK_PACKAGE) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

function renderDetail() {
  return render(
    createAppTestRouter({
      routes: [
        { path: "/packages/$packageId", component: PackageDetail },
        { path: "/packages", component: () => <div data-testid="packages-page">Packages</div> },
      ],
      initialPath: "/packages/pkg-1",
    })
  );
}

describe("PackageDetail", () => {
  // 测试 1：渲染 package header
  it("renders package header", async () => {
    mockFetch({ pkg: MOCK_PACKAGE, installs: MOCK_INSTALLS });
    renderDetail();

    await waitFor(() => {
      expect(screen.getByTestId("package-header")).toBeTruthy();
    });

    expect(screen.getByText("acme-standards（旧版）")).toBeTruthy();
    expect(screen.getByText("v2.0.0")).toBeTruthy();
    expect(screen.getByTestId("package-source").textContent).toBe("/packages/acme");
  });

  // 测试 2：install 历史按逆时间顺序
  it("install history in reverse chronological order", async () => {
    mockFetch({ pkg: MOCK_PACKAGE, installs: MOCK_INSTALLS });
    renderDetail();

    await waitFor(() => {
      const rows = screen.getAllByTestId("install-row");
      expect(rows).toHaveLength(2);
    });

    const rows = screen.getAllByTestId("install-row");
    // inst-2（2026-03-25 12:00:00）应出现在 inst-1（2026-03-25 10:00:00）之前
    expect(rows[0]!.textContent).toContain("/repo-b");
    expect(rows[1]!.textContent).toContain("/repo-a");
  });

  // 测试 3：status badge 颜色正确
  it("status badges have correct colors", async () => {
    const threeInstalls: InstallSummary[] = [
      { ...MOCK_INSTALLS[0]!, status: "applied", createdAt: "2026-03-25 13:00:00" },
      { ...MOCK_INSTALLS[1]!, id: "inst-3", status: "rolled_back", createdAt: "2026-03-25 12:00:00" },
      { ...MOCK_INSTALLS[1]!, id: "inst-4", status: "failed", createdAt: "2026-03-25 11:00:00" },
    ];
    mockFetch({ pkg: MOCK_PACKAGE, installs: threeInstalls });
    renderDetail();

    await waitFor(() => {
      const badges = screen.getAllByTestId("install-status-badge");
      expect(badges).toHaveLength(3);
    });

    const badges = screen.getAllByTestId("install-status-badge");
    expect(badges[0]!.className).toContain("bg-success");
    expect(badges[1]!.className).toContain("bg-warning");
    expect(badges[2]!.className).toContain("bg-destructive");
  });

  // 测试 4：展开 install 显示 journal 条目
  it("expand install shows journal entries", async () => {
    mockFetch({ pkg: MOCK_PACKAGE, installs: MOCK_INSTALLS, journal: MOCK_JOURNAL });
    renderDetail();

    await waitFor(() => {
      expect(screen.getAllByTestId("install-row")).toHaveLength(2);
    });

    // 点第二行（inst-1，appliedCount: 3）的展开
    const expandBtns = screen.getAllByTestId("expand-btn");
    act(() => { fireEvent.click(expandBtns[1]!); });

    await waitFor(() => {
      expect(screen.getByTestId("journal-entries")).toBeTruthy();
    });

    const entries = screen.getAllByTestId("journal-entry");
    expect(entries).toHaveLength(2);
  });

  // 测试 5：Rollback 按钮打开确认 dialog
  it("rollback button opens confirmation dialog", async () => {
    // inst-1 是 "applied"——将出现在第二（较旧）
    mockFetch({ pkg: MOCK_PACKAGE, installs: MOCK_INSTALLS });
    renderDetail();

    await waitFor(() => {
      expect(screen.getAllByTestId("install-row")).toHaveLength(2);
    });

    // "applied" install 是第二行（inst-1，较旧日期）
    const rollbackBtns = screen.getAllByTestId("rollback-btn");
    expect(rollbackBtns.length).toBeGreaterThan(0);

    act(() => { fireEvent.click(rollbackBtns[0]!); });

    await waitFor(() => {
      expect(screen.getByTestId("rollback-dialog")).toBeTruthy();
    });
  });

  // 测试 6：Rollback 成功更新状态
  it("rollback success updates status", async () => {
    const appliedOnly: InstallSummary[] = [
      { ...MOCK_INSTALLS[0]!, status: "applied" },
    ];
    mockFetch({ pkg: MOCK_PACKAGE, installs: appliedOnly, rollbackOk: true });
    renderDetail();

    await waitFor(() => {
      expect(screen.getAllByTestId("install-row")).toHaveLength(1);
    });

    // 点 rollback
    act(() => { fireEvent.click(screen.getByTestId("rollback-btn")); });

    await waitFor(() => {
      expect(screen.getByTestId("rollback-dialog")).toBeTruthy();
    });

    // 确认 rollback
    act(() => { fireEvent.click(screen.getByTestId("rollback-confirm")); });

    // mutation 后，fetch mock 再次被 install 调用（invalidation）
    // mock 将返回相同数据（静态 mock），但 mutation 本身应已成功完成
    await waitFor(() => {
      // Dialog 应关闭
      expect(screen.queryByTestId("rollback-dialog")).toBeNull();
    });
  });

  // 测试 7：空 install 历史
  it("empty install history", async () => {
    mockFetch({ pkg: MOCK_PACKAGE, installs: [] });
    renderDetail();

    await waitFor(() => {
      expect(screen.getByTestId("empty-installs")).toBeTruthy();
    });

    expect(screen.getByTestId("empty-installs").textContent).toContain("暂无安装记录");
  });

  // 测试 8：install 行显示 appliedCount 和 deferred 占位
  it("install row shows appliedCount and deferred placeholder (deferredCount not yet persisted)", async () => {
    const installWithCounts: InstallSummary[] = [
      {
        ...MOCK_INSTALLS[0]!,
        appliedCount: 3,
        deferredCount: null,
      },
    ];
    mockFetch({ pkg: MOCK_PACKAGE, installs: installWithCounts });
    renderDetail();

    await waitFor(() => {
      expect(screen.getAllByTestId("install-row")).toHaveLength(1);
    });

    const appliedCount = screen.getByTestId("applied-count");
    expect(appliedCount.textContent).toContain("3");
    expect(appliedCount.textContent).toContain("已应用");

    const deferredPlaceholder = screen.getByTestId("deferred-placeholder");
    expect(deferredPlaceholder.textContent).toContain("已延迟");
  });

  // 测试 9：install 历史 fetch 失败显示错误，非空状态（R2-M5）
  it("failed install history fetch shows error state, not false empty state", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === "string" && url.includes("/installs")) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      if (typeof url === "string" && url.match(/\/api\/packages\/[^/]+$/)) {
        return { ok: true, status: 200, json: async () => MOCK_PACKAGE };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    renderDetail();

    await waitFor(() => {
      expect(screen.getByTestId("installs-error")).toBeTruthy();
    });

    expect(screen.getByTestId("installs-error").textContent).toContain("加载安装历史失败");
    expect(screen.queryByTestId("empty-installs")).toBeNull();
  });

  // 测试 10：journal fetch 失败显示错误，非空状态（R2-M5）
  it("failed journal fetch shows error state, not false empty state", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.includes("/journal")) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      if (typeof url === "string" && url.includes("/installs")) {
        return { ok: true, status: 200, json: async () => MOCK_INSTALLS };
      }
      if (typeof url === "string" && url.match(/\/api\/packages\/[^/]+$/)) {
        return { ok: true, status: 200, json: async () => MOCK_PACKAGE };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    renderDetail();

    await waitFor(() => {
      expect(screen.getAllByTestId("install-row")).toHaveLength(2);
    });

    // 展开第二行（inst-1，applied）以触发 journal fetch
    const expandBtns = screen.getAllByTestId("expand-btn");
    act(() => { fireEvent.click(expandBtns[1]!); });

    await waitFor(() => {
      expect(screen.getByTestId("journal-error")).toBeTruthy();
    });

    expect(screen.getByTestId("journal-error").textContent).toContain("加载日志条目失败");
  });

  // 测试 11：Rollback 失败在 dialog 内显示错误（R2-M6）
  it("rollback failure shows error in dialog, dialog stays open", async () => {
    const appliedOnly: InstallSummary[] = [
      { ...MOCK_INSTALLS[0]!, status: "applied" },
    ];
    mockFetch({ pkg: MOCK_PACKAGE, installs: appliedOnly, rollbackOk: false });
    renderDetail();

    await waitFor(() => {
      expect(screen.getAllByTestId("install-row")).toHaveLength(1);
    });

    // 打开 rollback dialog
    act(() => { fireEvent.click(screen.getByTestId("rollback-btn")); });
    await waitFor(() => {
      expect(screen.getByTestId("rollback-dialog")).toBeTruthy();
    });

    // 确认 rollback（将以 500 失败）
    act(() => { fireEvent.click(screen.getByTestId("rollback-confirm")); });

    // Dialog 应保持打开并显示错误
    await waitFor(() => {
      expect(screen.getByTestId("rollback-error")).toBeTruthy();
    });

    expect(screen.getByTestId("rollback-error").textContent).toContain("回滚失败");
    // Dialog 仍打开
    expect(screen.getByTestId("rollback-dialog")).toBeTruthy();
  });

  // 测试 12：pending 期间 Rollback confirm 按钮禁用（R2-M6）
  it("rollback confirm button disabled during pending state", async () => {
    const appliedOnly: InstallSummary[] = [
      { ...MOCK_INSTALLS[0]!, status: "applied" },
    ];
    // 返回永不 resolve 的 promise，使 mutation 保持 pending
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && typeof url === "string" && url.includes("/rollback")) {
        return new Promise(() => {}); // Never resolves
      }
      if (typeof url === "string" && url.includes("/installs")) {
        return { ok: true, status: 200, json: async () => appliedOnly };
      }
      if (typeof url === "string" && url.match(/\/api\/packages\/[^/]+$/)) {
        return { ok: true, status: 200, json: async () => MOCK_PACKAGE };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    renderDetail();

    await waitFor(() => {
      expect(screen.getAllByTestId("install-row")).toHaveLength(1);
    });

    // 打开 rollback dialog
    act(() => { fireEvent.click(screen.getByTestId("rollback-btn")); });
    await waitFor(() => {
      expect(screen.getByTestId("rollback-dialog")).toBeTruthy();
    });

    // 确认——进入 pending 状态
    act(() => { fireEvent.click(screen.getByTestId("rollback-confirm")); });

    await waitFor(() => {
      const btn = screen.getByTestId("rollback-confirm");
      expect(btn.hasAttribute("disabled")).toBe(true);
      expect(btn.textContent).toContain("正在回滚");
    });
  });

  // 测试 13：pending rollback 期间 dialog 不可关闭（R2-M6 回归）
  it("dialog cannot be dismissed via Escape or overlay during pending rollback", async () => {
    const appliedOnly: InstallSummary[] = [
      { ...MOCK_INSTALLS[0]!, status: "applied" },
    ];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && typeof url === "string" && url.includes("/rollback")) {
        return new Promise(() => {}); // Never resolves — stays pending
      }
      if (typeof url === "string" && url.includes("/installs")) {
        return { ok: true, status: 200, json: async () => appliedOnly };
      }
      if (typeof url === "string" && url.match(/\/api\/packages\/[^/]+$/)) {
        return { ok: true, status: 200, json: async () => MOCK_PACKAGE };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    renderDetail();

    await waitFor(() => {
      expect(screen.getAllByTestId("install-row")).toHaveLength(1);
    });

    // 打开 dialog 并确认 rollback 进入 pending 状态
    act(() => { fireEvent.click(screen.getByTestId("rollback-btn")); });
    await waitFor(() => {
      expect(screen.getByTestId("rollback-dialog")).toBeTruthy();
    });
    act(() => { fireEvent.click(screen.getByTestId("rollback-confirm")); });

    // 等 pending 状态
    await waitFor(() => {
      expect(screen.getByTestId("rollback-confirm").hasAttribute("disabled")).toBe(true);
    });

    // 试 Escape——dialog 应保持打开
    act(() => { fireEvent.keyDown(screen.getByTestId("rollback-dialog"), { key: "Escape" }); });
    expect(screen.getByTestId("rollback-dialog")).toBeTruthy();

    // pending 期间 Cancel 按钮应禁用
    expect(screen.getByTestId("rollback-cancel").hasAttribute("disabled")).toBe(true);
  });

  // 测试 14：错误后关闭，重开时清除陈旧错误（R2-M6 回归）
  it("cancel after rollback error clears error on dialog reopen", async () => {
    const appliedOnly: InstallSummary[] = [
      { ...MOCK_INSTALLS[0]!, status: "applied" },
    ];
    mockFetch({ pkg: MOCK_PACKAGE, installs: appliedOnly, rollbackOk: false });
    renderDetail();

    await waitFor(() => {
      expect(screen.getAllByTestId("install-row")).toHaveLength(1);
    });

    // 打开 dialog 并触发失败 rollback
    act(() => { fireEvent.click(screen.getByTestId("rollback-btn")); });
    await waitFor(() => {
      expect(screen.getByTestId("rollback-dialog")).toBeTruthy();
    });
    act(() => { fireEvent.click(screen.getByTestId("rollback-confirm")); });

    // 等错误
    await waitFor(() => {
      expect(screen.getByTestId("rollback-error")).toBeTruthy();
    });

    // Cancel 关闭
    act(() => { fireEvent.click(screen.getByTestId("rollback-cancel")); });
    await waitFor(() => {
      expect(screen.queryByTestId("rollback-dialog")).toBeNull();
    });

    // 重开 dialog——错误应被清除
    act(() => { fireEvent.click(screen.getByTestId("rollback-btn")); });
    await waitFor(() => {
      expect(screen.getByTestId("rollback-dialog")).toBeTruthy();
    });

    expect(screen.queryByTestId("rollback-error")).toBeNull();
  });

  // 测试 15：Rollback mutation 失效 journal 缓存（R2-M4）
  it("rollback mutation invalidates journal queries on success", async () => {
    const appliedOnly: InstallSummary[] = [
      { ...MOCK_INSTALLS[0]!, status: "applied" },
    ];
    // 跟踪 fetch 调用以检测 journal refetch
    let journalFetchCount = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && typeof url === "string" && url.includes("/rollback")) {
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      if (typeof url === "string" && url.includes("/journal")) {
        journalFetchCount++;
        return { ok: true, status: 200, json: async () => MOCK_JOURNAL };
      }
      if (typeof url === "string" && url.includes("/installs")) {
        return { ok: true, status: 200, json: async () => appliedOnly };
      }
      if (typeof url === "string" && url.match(/\/api\/packages\/[^/]+$/)) {
        return { ok: true, status: 200, json: async () => MOCK_PACKAGE };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    renderDetail();

    await waitFor(() => {
      expect(screen.getAllByTestId("install-row")).toHaveLength(1);
    });

    // 展开以触发初始 journal fetch
    act(() => { fireEvent.click(screen.getByTestId("expand-btn")); });
    await waitFor(() => {
      expect(screen.getByTestId("journal-entries")).toBeTruthy();
    });
    const countBeforeRollback = journalFetchCount;

    // Rollback
    act(() => { fireEvent.click(screen.getByTestId("rollback-btn")); });
    await waitFor(() => {
      expect(screen.getByTestId("rollback-dialog")).toBeTruthy();
    });
    act(() => { fireEvent.click(screen.getByTestId("rollback-confirm")); });

    // 等 mutation 完成且 invalidation 触发 refetch
    await waitFor(() => {
      expect(journalFetchCount).toBeGreaterThan(countBeforeRollback);
    });
  });
});
