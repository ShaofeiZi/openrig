import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { TranscriptDrillPanel } from "../src/components/review/TranscriptDrillPanel.js";

// s_000cae46wD0 2026-10-08：加载态把机器枚举 tail/grep/full 映射为中文
// 尾部/搜索/全文。这里锁定“面向用户的词是中文”，同时不改变 drill URL 的机器枚举
// （tail/grep/full 仍体现在请求路径上）。

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TranscriptDrillPanel 加载态中文标签", () => {
  it("tail/grep/full 加载态分别显示中文标签，不外露英文枚举", async () => {
    // 永不 resolve，使组件停留在加载态。
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<TranscriptDrillPanel sessionName="sess1" />);

    // 默认 tail → 尾部
    await waitFor(() => expect(screen.getByText(/正在加载尾部…/)).toBeTruthy());
    expect(screen.queryByText(/正在加载tail…/)).toBeNull();

    // grep：输入 pattern 后回车
    fireEvent.change(screen.getByTestId("drill-grep-input"), { target: { value: "error" } });
    fireEvent.keyDown(screen.getByTestId("drill-grep-input"), { key: "Enter" });
    await waitFor(() => expect(screen.getByText(/正在加载搜索…/)).toBeTruthy());

    // full
    fireEvent.click(screen.getByTestId("drill-full"));
    await waitFor(() => expect(screen.getByText(/正在加载全文…/)).toBeTruthy());
  });

  it("grep 无匹配时如实显示中文空态", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ matches: [] }),
    });
    render(<TranscriptDrillPanel sessionName="sess1" />);
    fireEvent.change(screen.getByTestId("drill-grep-input"), { target: { value: "x" } });
    fireEvent.keyDown(screen.getByTestId("drill-grep-input"), { key: "Enter" });
    await waitFor(() => expect(screen.getByText("（无匹配）")).toBeTruthy());
  });
});
