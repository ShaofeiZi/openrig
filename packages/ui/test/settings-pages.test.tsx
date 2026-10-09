// Slice 26 Checkpoint B——Settings 页测试。
// 覆盖 PoliciesPage（HG-5 empty-state）+ SettingsCenter 重构
//（HG-7 顶行 tabs 去除判别器）。LogPage + StatusPage
// 路由挂载由 routes.tsx 静态路由注册 + 结构检查验证；其组件级渲染属 QA
// walk 范围（operator 在 founder-walk VM 上点 /settings/log + /settings/status）。

import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { PoliciesPage } from "../src/components/system/PoliciesPage.js";
import { SettingsCenter } from "../src/components/system/SettingsCenter.js";

function Wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
});

// useActivityFeed + useSettings 有 hook 表面，我们不想为这些聚焦页渲染测试接线。
// stub 它们。
vi.mock("../src/hooks/useActivityFeed.js", () => ({
  useActivityFeed: () => ({ events: [] }),
}));
vi.mock("../src/hooks/useSettings.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useSettings: () => ({ data: undefined, isLoading: false }),
  };
});
vi.mock("../src/hooks/useConfig.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useConfig: () => ({ data: { keys: [] }, isLoading: false }),
  };
});

describe("PoliciesPage (Claude auto-compaction form)", () => {
  it("renders Policies title chrome", () => {
    render(
      <Wrapper>
        <PoliciesPage />
      </Wrapper>,
    );
    expect(screen.getByTestId("settings-page-policies")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "策略" })).toBeTruthy();
  });

  it("renders operator-facing intro copy (no slice/release internals)", () => {
    render(
      <Wrapper>
        <PoliciesPage />
      </Wrapper>,
    );
    const page = screen.getByTestId("settings-page-policies");
    // 简介同时说明策略用途与默认关闭、按需启用的规则。
    expect(page.textContent).toContain("影响智能体运行时行为的可选策略");
    expect(page.textContent).toContain("每条策略默认关闭，可独立开启");
    // 面向用户的 UI 文案不得包含内部发布引用（沿用 velocity-guard 26.B 的关注点：
    // slice 编号属于实现细节，不应泄漏到产品 UI）。
    expect(page.textContent).not.toMatch(/slice\s*\d+/i);
  });
});

describe("SettingsCenter refactor (HG-7: top-row tabs removed)", () => {
  it("renders Settings page chrome", () => {
    render(
      <Wrapper>
        <SettingsCenter />
      </Wrapper>,
    );
    expect(screen.getByTestId("settings-center")).toBeTruthy();
  });

  it("does NOT render the legacy top-row tab navigation (HG-7 discriminator)", () => {
    render(
      <Wrapper>
        <SettingsCenter />
      </Wrapper>,
    );
    // 顶行 tab nav 曾有 testid="settings-tab-nav"；重构后必须消失。
    expect(screen.queryByTestId("settings-tab-nav")).toBeNull();
    // 每 tab 的 testid 也必须消失。
    expect(screen.queryByTestId("settings-tab-settings")).toBeNull();
    expect(screen.queryByTestId("settings-tab-log")).toBeNull();
    expect(screen.queryByTestId("settings-tab-status")).toBeNull();
    // 页级 chrome 上的 role=tablist 也消失。
    const tablists = screen.queryAllByRole("tablist");
    // SettingsTab（config keys 表单）自身可能含子 tablist；
    // 把断言门控为"无标为 'Settings sections' 的 tablist"，
    // 那是旧顶行标签。
    for (const tl of tablists) {
      expect(tl.getAttribute("aria-label")).not.toBe("Settings sections");
    }
  });
});
