// V1 attempt-3 Phase 2——AppShell chrome 测试。
//
// 替换旧 655 行测试（演练 pre-Phase-2 shell：slices-link / specs-toggle /
// discovery-toggle / progress-link / steering-link / context-link /
// system-toggle）。Phase 2 删除这些 header 按钮；带 6+2 图标的 rail 接管
// 目标切换。
//
// 覆盖：
// - SC-1——desktop 上恰好 2 个左侧 chrome（rail + explore）；Sidebar.tsx 已移除
// - SC-2——rail 名册：按 spec 顺序的 6 个目标 + 2 个 chat 图标
// - SC-6——drawer 默认关闭（selection=null -> null render）
// - SC-7——Settings rail 图标链接到 /settings（居中，非 drawer）
// - SC-8——mobile rail 折叠为 top-bar 菜单（<lg 处有 hamburger）
// - Surface 路由——Explorer 为 tree/lens 目标渲染
//   以及 Settings（slice 26：settings 成为与 Topology / Project / Library /
//   For-You 并列的 4 目标 Explorer 同位）。仅 Dashboard 保持 surface=none（无
//   Explorer）。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";
import { createAppTestRouter } from "./helpers/test-router.js";
import { AppShell } from "../src/components/AppShell.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

let OriginalEventSource: typeof EventSource | undefined;

beforeEach(async () => {
  mockFetch.mockReset();
  // 默认 rig/ps mock 返回空，使 chrome 可渲染。
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/api/rigs/summary")) return new Response(JSON.stringify([]));
    if (url.includes("/api/rigs/ps")) return new Response(JSON.stringify([]));
    if (url.includes("/api/inventory")) return new Response(JSON.stringify([]));
    return new Response("[]");
  });
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  const { queryClient } = await import("../src/lib/query-client.js");
  queryClient.clear();
});

afterEach(() => {
  if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  window.localStorage.clear();
  cleanup();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
    writable: true,
  });
  window.dispatchEvent(new Event("resize"));
});

// Slice 52（UI wall-clock 加固）：计时 fixture 不再 import ../src/routes.js。
// 挂载整棵路由树（所有 lazy page 模块）是 wall-clock 重步骤，在 fleet 负载下
// 输掉与 5000ms waitFor 的竞速，误报 SC-1 严格计数。这些测试断言的 chrome
//（rail + Explorer + surface）由 AppShell 从 router PATHNAME（surfaceForPath）
// 计算，非路由树——故以 AppShell 为根 + catch-all stub 的最小 router 渲染
// 完全相同 chrome，无重 import 也无时钟竞速。
async function renderAt(initialPath: string, opts: { innerWidth?: number } = {}) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: opts.innerWidth ?? 1440, writable: true });
  window.dispatchEvent(new Event("resize"));
  const result = render(
    createAppTestRouter({
      routes: [{ path: "$", component: () => null }],
      rootComponent: ({ children }) => <AppShell>{children}</AppShell>,
      initialPath,
    }),
  );
  // TanStack Router 异步解析路由组件；等 chrome 落地。
  await waitFor(() => {
    expect(result.container.querySelector("[data-testid='app-rail']")).toBeTruthy();
  }, { timeout: 5000 });
  return result;
}

describe("AppShell — Phase 2 chrome", () => {
  describe("SC-1: exactly 2 left chromes on desktop (rail + explore)", () => {
    it("renders exactly 2 left chromes at /topology desktop (rail + explore) — SC-1 strict count", async () => {
      const { container } = await renderAt("/topology");
      // SC-1：仅数 desktop 可见 nav/aside 元素。Phase 5 P5-9 MobileBottomNav
      // 用 <nav lg:hidden>——它在 DOM 中但 desktop（lg 断点）display:none。
      // SC-1 的 "desktop 上恰好 2 个左侧 chrome" 指可见 chrome，非原始元素数——
      // 按 lg:hidden 过滤。
      const chromeCount = Array.from(
        container.querySelectorAll("nav, aside"),
      ).filter((el) => !(el as HTMLElement).className.includes("lg:hidden")).length;
      expect(chromeCount).toBe(2);
      // 任何处都无旧 Sidebar.tsx——文件已删。
      expect(container.querySelector("[data-testid='sidebar']")).toBeNull();
    });

    it("Dashboard surface (/) renders rail but NO Explorer (surface=none)", async () => {
      const { container } = await renderAt("/");
      expect(container.querySelector("[data-testid='app-rail']")).toBeTruthy();
      expect(container.querySelector("[data-testid='explorer']")).toBeNull();
    });

    // Slice 26——Settings 现为 Explorer 目标（与 Topology / Project / Library /
    // For-You 同位）。Explorer 与 rail 并列渲染，含 4 项 SettingsExplorer
    //（Settings / Policies / Log / Status）。
    it("Settings surface (/settings) renders rail AND Explorer (surface=settings)", async () => {
      const { container } = await renderAt("/settings");
      expect(container.querySelector("[data-testid='app-rail']")).toBeTruthy();
      expect(container.querySelector("[data-testid='explorer']")).toBeTruthy();
      expect(container.querySelector("[data-testid='settings-explorer']")).toBeTruthy();
    });
  });

  describe("SC-2: rail roster — 6 destinations + 2 chat icons", () => {
    it("rail renders 6 destination icons in canonical order: Dashboard, Topology, For You, Project, Specs, Settings", async () => {
      const { container } = await renderAt("/");
      const expectedDestinations = [
        "rail-dashboard",
        "rail-topology",
        "rail-for-you",
        "rail-project",
        "rail-specs",
        "rail-settings",
      ];
      for (const id of expectedDestinations) {
        expect(container.querySelector(`[data-testid='${id}']`)).toBeTruthy();
      }
    });

    it("rail renders 2 chat icons (Advisor + Operator) per agent-chat-surface.md V1 placeholder", async () => {
      const { container } = await renderAt("/");
      expect(container.querySelector("[data-testid='rail-advisor']")).toBeTruthy();
      expect(container.querySelector("[data-testid='rail-operator']")).toBeTruthy();
    });

    it("rail does NOT include a Discovery icon (legacy header pattern removed)", async () => {
      const { container } = await renderAt("/");
      expect(container.querySelector("[data-testid='rail-discovery']")).toBeNull();
      expect(container.querySelector("[data-testid='discovery-toggle']")).toBeNull();
    });

    it("Settings rail icon points to /settings (SC-7: Settings in center, NOT drawer)", async () => {
      const { container } = await renderAt("/");
      const settingsIcon = container.querySelector("[data-testid='rail-settings']") as HTMLAnchorElement | null;
      expect(settingsIcon).toBeTruthy();
      expect(settingsIcon?.getAttribute("href")).toBe("/settings");
    });
  });

  describe("Active rail state", () => {
    it("Topology rail icon active at /topology", async () => {
      const { container } = await renderAt("/topology");
      const icon = container.querySelector("[data-testid='rail-topology']") as HTMLElement;
      expect(icon.getAttribute("data-active")).toBe("true");
    });

    it("Topology rail icon active at /rigs/$rigId (legacy graph route)", async () => {
      const { container } = await renderAt("/rigs/abc");
      const icon = container.querySelector("[data-testid='rail-topology']") as HTMLElement;
      expect(icon.getAttribute("data-active")).toBe("true");
    });

    it("Project rail icon active at /project", async () => {
      const { container } = await renderAt("/project");
      const icon = container.querySelector("[data-testid='rail-project']") as HTMLElement;
      expect(icon.getAttribute("data-active")).toBe("true");
    });

    it("For You rail icon active at /for-you", async () => {
      const { container } = await renderAt("/for-you");
      const icon = container.querySelector("[data-testid='rail-for-you']") as HTMLElement;
      expect(icon.getAttribute("data-active")).toBe("true");
    });
  });

  describe("SC-6: drawer default-closed", () => {
    it.each([
      ["/", "Dashboard"],
      ["/topology", "Topology host"],
      ["/for-you", "For You"],
      ["/project", "Project workspace"],
      ["/specs", "Specs library"],
      ["/settings", "Settings"],
    ])("SharedDetailDrawer NOT rendered at %s (%s)", async (path) => {
      const { container } = await renderAt(path);
      expect(container.querySelector("[data-testid='shared-detail-drawer']")).toBeNull();
    }, 15000);
  });

  describe("Surface routing — Explorer surface union", () => {
    it("Topology routes set surface=topology", async () => {
      const { container } = await renderAt("/topology");
      const explorer = container.querySelector("[data-testid='explorer']") as HTMLElement;
      expect(explorer?.getAttribute("data-surface")).toBe("topology");
    });

    it("Project routes set surface=project", async () => {
      const { container } = await renderAt("/project");
      const explorer = container.querySelector("[data-testid='explorer']") as HTMLElement;
      expect(explorer?.getAttribute("data-surface")).toBe("project");
    });

    it("Specs routes set surface=specs", async () => {
      const { container } = await renderAt("/specs");
      const explorer = container.querySelector("[data-testid='explorer']") as HTMLElement;
      expect(explorer?.getAttribute("data-surface")).toBe("specs");
    });

    it("Plugin detail routes keep the Library Explorer mounted", async () => {
      const { container } = await renderAt("/plugins/openrig-core");
      const explorer = container.querySelector("[data-testid='explorer']") as HTMLElement;
      const railSpecs = container.querySelector("[data-testid='rail-specs']") as HTMLAnchorElement;
      expect(explorer?.getAttribute("data-surface")).toBe("specs");
      expect(railSpecs?.getAttribute("data-active")).toBe("true");
    });

    it("For You route sets surface=for-you", async () => {
      const { container } = await renderAt("/for-you");
      const explorer = container.querySelector("[data-testid='explorer']") as HTMLElement;
      expect(explorer?.getAttribute("data-surface")).toBe("for-you");
    });
  });

  describe("Top bar — universal-shell.md L40–L53 (Phase 2 bounce-fix)", () => {
    it("top bar renders at desktop (single source of truth — no lg:hidden)", async () => {
      const { container } = await renderAt("/");
      const topbar = container.querySelector("[data-testid='app-topbar']") as HTMLElement;
      expect(topbar).toBeTruthy();
      // 单一事实源——top bar 通用，非 lg:hidden。
      expect(topbar.className).not.toContain("lg:hidden");
      expect(topbar.className).toContain("h-14");
    });

    it("brand link visible at desktop and links to / (Dashboard)", async () => {
      const { container } = await renderAt("/topology");
      const brand = container.querySelector("[data-testid='brand-home-link']") as HTMLAnchorElement;
      expect(brand).toBeTruthy();
      expect(brand.getAttribute("href")).toBe("/");
      expect(brand.textContent).toContain("zrig");
    });

    it("right-slot carries the MH-2 host indicator (quiet local register, defaults to 'localhost')", async () => {
      // OPR.0.4.6.MH2 FR-3——预留 V2 slot 现在渲染 HostIndicator；
      // 无 hosts payload 时如实默认 local 状态。
      const { container } = await renderAt("/");
      const indicator = container.querySelector(
        "[data-testid='host-indicator']",
      ) as HTMLElement;
      expect(indicator).toBeTruthy();
      expect(indicator.getAttribute("data-state")).toBe("local");
      expect(indicator.textContent?.toLowerCase()).toContain("localhost");
    });

    it("hamburger button is mobile-only (lg:hidden) — preserved Phase 2 behavior", async () => {
      const { container } = await renderAt("/");
      const hamburger = container.querySelector(
        "[data-testid='mobile-menu-toggle']",
      ) as HTMLElement;
      expect(hamburger).toBeTruthy();
      expect(hamburger.className).toContain("lg:hidden");
    });

    it("legacy app-mobile-topbar testid is GONE (renamed to app-topbar)", async () => {
      const { container } = await renderAt("/");
      expect(container.querySelector("[data-testid='app-mobile-topbar']")).toBeNull();
      expect(container.querySelector("[data-testid='brand-home-link-mobile']")).toBeNull();
    });
  });

  describe("SC-8: mobile rail collapses to slide-over tray", () => {
    it("mobile rail tray renders only at narrow viewport (conditional)", async () => {
      const { container } = await renderAt("/", { innerWidth: 375 });
      const topbar = container.querySelector("[data-testid='app-topbar']") as HTMLElement;
      expect(topbar).toBeTruthy();
      const tray = container.querySelector("[data-testid='mobile-rail-tray']") as HTMLElement;
      expect(tray).toBeTruthy();
      expect(tray.className).toContain("-translate-x-full");
    });

    // Slice 20 mobile：hamburger 菜单项纵向堆叠（非横向），使每条路由是
    // 拇指可点行。mobile slide-over 内 Rail 现在以 `vertical=true` 渲染。
    // slide-over tray 默认关闭；我们对渲染 DOM 断言，不论 open 状态
    //（className 在 mount 时固定）。
    it("slice 20: mobile slide-over Rail renders vertical (flex-col) — not horizontal scroll", async () => {
      const { container } = await renderAt("/", { innerWidth: 375 });
      const tray = container.querySelector("[data-testid='mobile-rail-tray']") as HTMLElement;
      const rail = tray.querySelector("[data-testid='app-rail']") as HTMLElement;
      expect(rail, "rail nav inside mobile slide-over tray").toBeTruthy();
      // 纵向 Rail 模式加 flex-col + w-12 + border-r；横向模式加
      // flex-row + w-full + border-b + overflow-x-auto。
      expect(rail.className).toMatch(/\bflex-col\b/);
      expect(rail.className).not.toMatch(/\bflex-row\b/);
      expect(rail.className).not.toMatch(/\boverflow-x-auto\b/);
    });

    // Slice 20 mobile：rail 图标 tap target 在 mobile 满足 iOS HIG 最小值
    //（44px），且在 lg: 宽度恢复既有 40px hitbox，保留 desktop hover 精度。
    // className 携带两种形状：`h-11 w-11`（mobile 默认）+ `lg:h-10 lg:w-10`
    //（desktop 覆盖）。Tailwind mobile-first 级联确保更大方形仅在 < lg:
    // viewport 绘制。
    it("slice 20: rail icon tap targets are ≥44px on mobile + restored to 40px at lg:", async () => {
      const { container } = await renderAt("/");
      const dashIcon = container.querySelector(
        "[data-testid='rail-dashboard']",
      ) as HTMLElement;
      expect(dashIcon, "rail dashboard icon link").toBeTruthy();
      // Mobile 默认：44px 方形。
      expect(dashIcon.className).toMatch(/\bh-11\b/);
      expect(dashIcon.className).toMatch(/\bw-11\b/);
      // Desktop 覆盖：lg: 前缀恢复 40px hitbox。
      expect(dashIcon.className).toMatch(/\blg:h-10\b/);
      expect(dashIcon.className).toMatch(/\blg:w-10\b/);
    });
  });

  // Phase 2 BOUNCE-FIX #3——宽度耦合回归（guard-3 捕获）。
  // 中央 workspace 的 --workspace-right-offset CSS 变量在 drawer 打开时必须等于
  // VellumSheet wide preset 宽度。Bounce-fix #2 把 VellumSheet 45rem 校准为
  // 38rem 但漏了此消费者；净效果是 drawer 与预留 padding 间 7rem（112px）缝隙。
  // 按 pseudo-element-paint 测试契约（discipline ritual #7），经 CSS 源码而非
  // runtime 断言（jsdom 中 CSS var 的 computed style 脆弱）。
  describe("Drawer width / right-offset coupling (bounce-fix #3 regression)", () => {
    const APP_SHELL_SRC = readFileSync(
      path.resolve(__dirname, "../src/components/AppShell.tsx"),
      "utf8",
    );
    const VELLUM_SHEET_SRC = readFileSync(
      path.resolve(__dirname, "../src/components/ui/vellum-sheet.tsx"),
      "utf8",
    );
    const SHARED_DRAWER_SRC = readFileSync(
      path.resolve(__dirname, "../src/components/SharedDetailDrawer.tsx"),
      "utf8",
    );

    it("VellumSheet wide preset and AppShell workspaceRightOffset use the SAME literal", () => {
      // 从 VellumSheet 源码提取 wide-preset 宽度。
      const vellumMatch = VELLUM_SHEET_SRC.match(
        /wide:\s*"w-full\s+lg:w-\[(\d+rem)\]/,
      );
      expect(vellumMatch, "VellumSheet wide preset must declare lg:w-[Xrem]").toBeTruthy();
      const vellumWide = vellumMatch![1];

      // 从 AppShell 源码提取 open-drawer offset。
      const offsetMatch = APP_SHELL_SRC.match(
        /workspaceRightOffset\s*=\s*[^?]*\?\s*"(\d+rem)"\s*:/,
      );
      expect(offsetMatch, "AppShell workspaceRightOffset must declare ternary 'Xrem' : '0rem'")
        .toBeTruthy();
      const offsetOpen = offsetMatch![1];

      expect(offsetOpen, "AppShell workspaceRightOffset must equal VellumSheet wide preset width")
        .toBe(vellumWide);
    });

    it("no live 45rem string in chrome source (only historical calibration comments are allowed)", () => {
      // 提取每行含 "45rem" 并验证每行都在注释内（校准历史）。Chrome 源码
      // 不得携带 45rem 作为 live class 或值。
      const checkSource = (src: string, label: string) => {
        const lines = src.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.includes("45rem")) continue;
          // 仅在行是 JS/TS 行注释（"//"）或活动块注释上下文（"/*"、"*"）时
          // 允许。此行无 "//" 时向后扫最近的 /* opener。
          const trimmed = line.trim();
          const isLineComment = trimmed.startsWith("//") || trimmed.startsWith("*");
          let isInsideBlockComment = false;
          if (!isLineComment) {
            // 向后看最多 30 行，找无中间 */ 的 /*。
            for (let j = i - 1; j >= Math.max(0, i - 30); j--) {
              if (lines[j].includes("*/")) break;
              if (lines[j].includes("/*")) {
                isInsideBlockComment = true;
                break;
              }
            }
          }
          expect(
            isLineComment || isInsideBlockComment,
            `${label}:${i + 1} contains live (non-comment) "45rem" — bounce-fix #3 width-coupling regression`,
          ).toBe(true);
        }
      };
      checkSource(APP_SHELL_SRC, "AppShell.tsx");
      checkSource(SHARED_DRAWER_SRC, "SharedDetailDrawer.tsx");
      // VellumSheet 保留含 45rem 的历史校准注释；它在 // 注释内，故同一
      // checker 在那里也通过。
      checkSource(VELLUM_SHEET_SRC, "vellum-sheet.tsx");
    });
  });

  describe("Legacy buttons removed (Phase 2 deleted Sidebar + header toggle pattern)", () => {
    it("specs-toggle button does NOT exist", async () => {
      const { container } = await renderAt("/");
      expect(container.querySelector("[data-testid='specs-toggle']")).toBeNull();
    });

    it("system-toggle button does NOT exist", async () => {
      const { container } = await renderAt("/");
      expect(container.querySelector("[data-testid='system-toggle']")).toBeNull();
    });

    it("slices-link button does NOT exist", async () => {
      const { container } = await renderAt("/");
      expect(container.querySelector("[data-testid='slices-link']")).toBeNull();
    });

    it("steering-link button does NOT exist", async () => {
      const { container } = await renderAt("/");
      expect(container.querySelector("[data-testid='steering-link']")).toBeNull();
    });

    it("context-link button does NOT exist", async () => {
      const { container } = await renderAt("/");
      expect(container.querySelector("[data-testid='context-link']")).toBeNull();
    });

    it("progress-link button does NOT exist", async () => {
      const { container } = await renderAt("/");
      expect(container.querySelector("[data-testid='progress-link']")).toBeNull();
    });
  });
});
