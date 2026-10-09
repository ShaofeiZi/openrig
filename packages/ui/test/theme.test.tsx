// OPR.0.4.3.29——dashboard 主题：注册表 + 解析 + 持久化 + no-FOUC
// 契约 + provider/selector 行为。证明 AC 级保证：
//  - 切换生效（.dark 类在 <html> 上切换）并跨 reload 持久
//  - light 为默认外观；dark 为可选新主题
//  - 无存储选择的首载跟随 OS（system）——pre-paint 路径
//  - 显式选择胜过 OS
//  - 可扩展：selector 由注册表驱动（加主题仅改数据）

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import {
  THEME_STORAGE_KEY,
  THEMES,
  DEFAULT_THEME,
  readStoredTheme,
  writeStoredTheme,
  resolveTheme,
  applyTheme,
} from "../src/lib/theme.js";
import { ThemeProvider, useTheme } from "../src/components/ThemeProvider.js";
import { ThemeSelector } from "../src/components/ThemeSelector.js";

/** 覆写 window.matchMedia，使 `(prefers-color-scheme: dark)` 报告 `osDark`。 */
function mockOsDark(osDark: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("dark") ? osDark : false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe("theme lib — registry + resolution", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    mockOsDark(false);
  });
  afterEach(cleanup);

  it("registry ships light + dark + system", () => {
    const ids = THEMES.map((t) => t.id);
    expect(ids).toEqual(["light", "dark", "system"]);
  });

  it("default is `system` when nothing is stored", () => {
    expect(readStoredTheme()).toBe(DEFAULT_THEME);
    expect(DEFAULT_THEME).toBe("system");
  });

  it("reads an explicit stored choice; ignores malformed values", () => {
    writeStoredTheme("dark");
    expect(readStoredTheme()).toBe("dark");
    localStorage.setItem(THEME_STORAGE_KEY, "chartreuse");
    expect(readStoredTheme()).toBe("system"); // falls back to default
  });

  it("`system` follows the OS; explicit light/dark ignore it", () => {
    mockOsDark(true);
    expect(resolveTheme("system")).toBe("dark");
    expect(resolveTheme("light")).toBe("light"); // explicit wins over OS-dark
    mockOsDark(false);
    expect(resolveTheme("system")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark"); // explicit wins over OS-light
  });

  it("applyTheme toggles the .dark class on <html>", () => {
    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    applyTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    mockOsDark(true);
    applyTheme("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});

function Probe() {
  const { theme, resolved } = useTheme();
  return (
    <span data-testid="probe">
      {theme}:{resolved}
    </span>
  );
}

describe("ThemeProvider + ThemeSelector", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    mockOsDark(false);
  });
  afterEach(cleanup);

  it("first load with no stored choice + OS dark → renders dark (no explicit choice)", () => {
    mockOsDark(true);
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("probe").textContent).toBe("system:dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("an explicit stored choice wins over the OS", () => {
    writeStoredTheme("light");
    mockOsDark(true); // OS says dark, stored says light
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("probe").textContent).toBe("light:light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("selecting dark applies it and persists across a reload (remount)", () => {
    const { unmount } = render(
      <ThemeProvider>
        <ThemeSelector />
        <Probe />
      </ThemeProvider>,
    );
    act(() => {
      fireEvent.change(screen.getByTestId("theme-selector"), { target: { value: "dark" } });
    });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    // 模拟 reload：卸载 + 重挂载读取持久化选择。
    unmount();
    document.documentElement.classList.remove("dark");
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId("probe").textContent).toBe("dark:dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("the selector is registry-driven — one <option> per registered theme (extensibility)", () => {
    render(
      <ThemeProvider>
        <ThemeSelector />
      </ThemeProvider>,
    );
    const options = screen.getByTestId("theme-selector").querySelectorAll("option");
    expect(options).toHaveLength(THEMES.length);
    expect(Array.from(options).map((o) => o.getAttribute("value"))).toEqual(
      THEMES.map((t) => t.id),
    );
  });
});
