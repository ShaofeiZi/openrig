// Slice 26.B HG-8 mobile-drawer 分层回归（OPT-B 修复）。
//
// 修复前：opaque 模式 Explorer mobile drawer 渲染于 z-20，
// 而 AppShell mobile-rail-tray 渲染于 z-30。两者在 mobile 上都附于
// left-0 且共享 `explorerOpen` 状态，故几何上重叠。rail-tray 盖住
// Explorer；点击命中登记在 rail 项，而非 Explorer 项。velocity-qa
// 在 Settings（第 5 个带 Explorer 的 destination）375px 抓到；
// slice 26 暴露的既有 bug。
//
// 修复：opaque 模式 Explorer 提到 z-40，使其在 mobile 上分层于
// rail-tray（z-30）之上。Overlay 模式（Topology graph）保持
// z-30——等于 rail-tray；DOM 渲染顺序使 Explorer 居上，因 AppShell
// 在 rail-tray 之后渲染 Explorer aside。
//
// 跨 destination 范围：Explorer.tsx 的改动应用于全部 5 个带 Explorer 的
// destination（Topology、Project、Library、For-You、Settings）。测试跨表面
// 验证 className 契约，使跨 destination 修复被行使。

import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Explorer, shouldSuppressExplorerMount } from "../src/components/Explorer.js";
import type { ExplorerSurface } from "../src/components/Explorer.js";
import { createAppTestRouter } from "./helpers/test-router.js";

afterEach(() => {
  cleanup();
});

function renderExplorerAt(surface: ExplorerSurface, initialPath: string) {
  return render(
    createAppTestRouter({
      initialPath,
      routes: [
        {
          path: initialPath,
          component: () => (
            <Explorer
              open={true}
              onClose={() => {}}
              selection={null}
              onSelect={() => {}}
              desktopMode="full"
              surface={surface}
              overlayMode="opaque"
            />
          ),
        },
      ],
    }),
  );
}

const MOBILE_RAIL_TRAY_Z = 30; // packages/ui/src/components/AppShell.tsx L560
const EXPLORER_REPAIRED_OPAQUE_Z = 40; // slice 26.B HG-8 OPT-B bumped value

describe("Explorer mobile drawer z-index layering (slice 26.B HG-8 OPT-B repair)", () => {
  // 跨 destination 断言：Explorer.tsx z-index 改动应用于全部带 Explorer
  // 表面——逐个验证证明修复是结构性的，非表面特定。
  const opaqueSurfaces: ExplorerSurface[] = ["project", "specs", "for-you", "settings"];

  for (const surface of opaqueSurfaces) {
    describe(`surface=${surface} (opaque-mode)`, () => {
      it(`Explorer aside has z-40 class (above mobile-rail-tray z-30) — POSITIVE assertion`, async () => {
        renderExplorerAt(surface, "/path-for-test");
        await waitFor(() => {
          expect(screen.getByTestId("explorer")).toBeTruthy();
        });
        const explorer = screen.getByTestId("explorer");
        // 修复后 class 契约：z-40 存在
        expect(explorer.className).toMatch(/\bz-40\b/);
      });

      it(`Explorer aside does NOT have z-20 class — NEGATIVE assertion (pre-repair broken value absent)`, async () => {
        renderExplorerAt(surface, "/path-for-test");
        await waitFor(() => {
          expect(screen.getByTestId("explorer")).toBeTruthy();
        });
        const explorer = screen.getByTestId("explorer");
        // 修复前坏值：z-20 绝不出现；否则会重新引入
        // rail-tray 盖 Explorer 的 bug
        expect(explorer.className).not.toMatch(/\bz-20\b/);
      });

      it(`Explorer aside z-index value is numerically greater than mobile-rail-tray z-index (${MOBILE_RAIL_TRAY_Z})`, async () => {
        renderExplorerAt(surface, "/path-for-test");
        await waitFor(() => {
          expect(screen.getByTestId("explorer")).toBeTruthy();
        });
        const explorer = screen.getByTestId("explorer");
        // 判别分层不变量：取 z-N class 并验证 N > rail-tray-z。
        // 无修复则此值为 20。
        const zMatch = explorer.className.match(/\bz-(\d+)\b/);
        expect(zMatch).toBeTruthy();
        const explorerZ = Number(zMatch![1]);
        expect(explorerZ).toBeGreaterThan(MOBILE_RAIL_TRAY_Z);
        expect(explorerZ).toBe(EXPLORER_REPAIRED_OPAQUE_Z);
      });
    });
  }

  describe("surface=topology (overlay-mode preserved)", () => {
    it("overlay-mode Explorer retains z-30 (Topology graph canvas float behavior)", async () => {
      render(
        createAppTestRouter({
          initialPath: "/topology",
          routes: [
            {
              path: "/topology",
              component: () => (
                <Explorer
                  open={true}
                  onClose={() => {}}
                  selection={null}
                  onSelect={() => {}}
                  desktopMode="full"
                  surface="topology"
                  overlayMode="overlay"
                />
              ),
            },
          ],
        }),
      );
      await waitFor(() => {
        expect(screen.getByTestId("explorer")).toBeTruthy();
      });
      const explorer = screen.getByTestId("explorer");
      expect(explorer.className).toMatch(/\bz-30\b/);
      // Overlay 模式：z-30 等于 mobile-rail-tray z-30——DOM 渲染顺序
      // 使 Explorer 居上（AppShell 在 rail-tray div 之后渲染 Explorer
      // aside）。这是 slice 26 前 Topology graph 正确工作的同层；
      // 本修复未改。
    });
  });

});

// Slice 26.D OPT-D3 Topology mobile Explorer mount 抑制。
//
// OPT-C3 z-index carve-out 被 velocity-qa 复查作废：z-index 抑制可见性，
// 但不抑制 React MOUNT。peg 触发是 hamburger 点击时 Explorer drawer
// MOUNTING，它引发相邻 Topology 重渲染级联——与 drawer 是否可见无关。
// OPT-D3 在窄 viewport 为 Topology 抑制 mount 本身。纯谓词；易测。

describe("shouldSuppressExplorerMount (slice 26.D OPT-D3 mount-suppression predicate)", () => {
  it("Topology + narrow viewport (isWideLayout=false) → SUPPRESS mount (true)", () => {
    expect(shouldSuppressExplorerMount("topology", false)).toBe(true);
  });

  it("Topology + wide viewport (isWideLayout=true) → mount normally (false)", () => {
    expect(shouldSuppressExplorerMount("topology", true)).toBe(false);
  });

  // 跨 destination 保持：其他 4 个带 Explorer 表面无论 viewport 都 mount。
  // carve-out 是 Topology 特定。
  const otherSurfaces: ExplorerSurface[] = ["settings", "project", "specs", "for-you"];
  for (const surface of otherSurfaces) {
    it(`${surface} + narrow viewport → mount normally (false)`, () => {
      expect(shouldSuppressExplorerMount(surface, false)).toBe(false);
    });
    it(`${surface} + wide viewport → mount normally (false)`, () => {
      expect(shouldSuppressExplorerMount(surface, true)).toBe(false);
    });
  }

  it("'none' surface → never suppressed (consistent with Explorer not mounting anyway via explorerVisible gate)", () => {
    expect(shouldSuppressExplorerMount("none", false)).toBe(false);
    expect(shouldSuppressExplorerMount("none", true)).toBe(false);
  });
});

// Slice 26.E OPT-E Topology mobile menu-toggle carve-out。
//
// OPT-D3（mount 抑制）被 velocity-qa 复查作废：peg 触发不是 Explorer
// mount，而是 mobile-menu-toggle 本身的点击 handler。setExplorerOpen
// 翻转状态，重渲染 AppShellInner 子节点（含 Topology mobile 渲染路径）。
// OPT-E 在 Topology mobile 表面抑制 toggle 按钮，使状态翻转级联永不触发。
// 复用 shouldSuppressExplorerMount 谓词（同底层 carve-out 条件）。
// 0.3.2 将修 Topology render-path；届时本 carve-out 回退。
//
// JSX 形状判别：镜像 AppShell.tsx 对 toggle 按钮的条件渲染。谓词逻辑
// 已由上面 OPT-D3 测试覆盖；这些测试验证 JSX 接线正确使用谓词
//（每表面负面 + 正面断言）。

function MenuToggleProbe({
  surface,
  isWideLayout,
}: {
  surface: ExplorerSurface;
  isWideLayout: boolean;
}) {
  return (
    <div>
      {!shouldSuppressExplorerMount(surface, isWideLayout) && (
        <button data-testid="mobile-menu-toggle" type="button" aria-label="Toggle navigation" />
      )}
    </div>
  );
}

describe("OPT-E mobile-menu-toggle conditional render (slice 26.E)", () => {
  it("Topology + narrow viewport → toggle button is ABSENT (peg-trigger entry suppressed)", () => {
    render(<MenuToggleProbe surface="topology" isWideLayout={false} />);
    expect(screen.queryByTestId("mobile-menu-toggle")).toBeNull();
  });

  it("Topology + wide viewport → toggle button is PRESENT (lg:hidden handles visibility; no peg path on desktop)", () => {
    render(<MenuToggleProbe surface="topology" isWideLayout={true} />);
    expect(screen.queryByTestId("mobile-menu-toggle")).not.toBeNull();
  });

  // 跨 destination 保持：其他 4 个带 Explorer 表面在窄 viewport 保留
  // toggle 按钮，使用户能打开 Explorer drawer（OPT-B + OPT-D3 修复正常应用）。
  const otherSurfaces: ExplorerSurface[] = ["settings", "project", "specs", "for-you"];
  for (const surface of otherSurfaces) {
    it(`${surface} + narrow viewport → toggle button is PRESENT (cross-destination preservation)`, () => {
      render(<MenuToggleProbe surface={surface} isWideLayout={false} />);
      expect(screen.queryByTestId("mobile-menu-toggle")).not.toBeNull();
    });
  }

  it("'none' surface + narrow viewport → toggle button is PRESENT (no Explorer-bearing carve-out applies)", () => {
    render(<MenuToggleProbe surface="none" isWideLayout={false} />);
    expect(screen.queryByTestId("mobile-menu-toggle")).not.toBeNull();
  });
});
