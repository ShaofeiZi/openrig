// Slice 24.D BLOCKING-CONCERN 修复（次要）：trailing 槽
//（如"Launch in CMUX"按钮）必须是 tablist 的兄弟，
// 而非子。Tablist 子应只含 tab；按 ARIA，混入
// 非 tab 交互子会扰乱键盘导航 +
// 屏幕阅读器。测试锚定结构契约。

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TopologyViewModeTabs } from "../src/components/topology/TopologyViewModeTabs.js";

afterEach(() => {
  cleanup();
});

describe("TopologyViewModeTabs trailing slot — a11y structure", () => {
  const tabs = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ];

  it("without trailing: renders just the tablist (no outer wrapper)", () => {
    render(
      <TopologyViewModeTabs
        tabs={tabs}
        active="a"
        onSelect={() => {}}
        testIdPrefix="t1"
      />,
    );
    expect(screen.getByTestId("t1-tabs")).toBeTruthy();
    expect(screen.queryByTestId("t1-tab-bar")).toBeNull();
    expect(screen.queryByTestId("t1-trailing")).toBeNull();
  });

  it("with trailing: tablist is INSIDE the outer tab-bar but trailing slot is OUTSIDE the tablist", () => {
    render(
      <TopologyViewModeTabs
        tabs={tabs}
        active="a"
        onSelect={() => {}}
        testIdPrefix="t2"
        trailing={<button data-testid="my-action">Action</button>}
      />,
    );
    const tabBar = screen.getByTestId("t2-tab-bar");
    const tablist = screen.getByTestId("t2-tabs");
    const trailing = screen.getByTestId("t2-trailing");
    const action = screen.getByTestId("my-action");

    // Tablist 嵌套于外层 tab-bar 下
    expect(tabBar.contains(tablist)).toBe(true);
    // Trailing 槽嵌套于外层 tab-bar 下
    expect(tabBar.contains(trailing)).toBe(true);
    // 关键 a11y 断言：trailing 不是 tablist 的后代。
    // Tablist 应只含 tab；trailing 动作应是
    // 外层 tab-bar 包装内 tablist 的兄弟。
    expect(tablist.contains(trailing)).toBe(false);
    // 渲染在 trailing 槽内的动作按钮
    expect(trailing.contains(action)).toBe(true);
  });

  it("trailing slot has ml-auto class (placement: tab-bar far right per README §Button placement Option C)", () => {
    render(
      <TopologyViewModeTabs
        tabs={tabs}
        active="a"
        onSelect={() => {}}
        testIdPrefix="t3"
        trailing={<span data-testid="placement-marker">x</span>}
      />,
    );
    const trailing = screen.getByTestId("t3-trailing");
    expect(trailing.className).toMatch(/\bml-auto\b/);
  });

  it("tablist contains ONLY the tab buttons (no non-tab role=tab children)", () => {
    render(
      <TopologyViewModeTabs
        tabs={tabs}
        active="a"
        onSelect={() => {}}
        testIdPrefix="t4"
        trailing={<button data-testid="trailing-button">Trailing</button>}
      />,
    );
    const tablist = screen.getByTestId("t4-tabs");
    // Tablist 子是 2 个 tab 按钮；trailing 按钮不在其中。
    const tabButtons = tablist.querySelectorAll('[role="tab"]');
    expect(tabButtons).toHaveLength(2);
    // Trailing 按钮无 role=tab 且不在 tablist 内。
    const trailingButton = screen.getByTestId("trailing-button");
    expect(trailingButton.getAttribute("role")).not.toBe("tab");
    expect(tablist.contains(trailingButton)).toBe(false);
  });
});
