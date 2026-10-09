// Slice 28 Checkpoint C——Index 页 rolled-up-rows 回归（HG-9 + HG-10）。
//
// slice 28 前，index 页经 LibraryTopLevelEntry 按 source 分组条目
//（skills 为 workspace / openrig-managed 桶；plugins 为
// vendored / claude-cache / codex-cache）。Founder-walk 反馈：rolled-up
// 扁平行一目了然显示全部条目 + per-row 元数据（skills 为 source / file-count；
// plugins 为 version / runtimes / source）+ 点击 -> detail。
//
// 判别：rolled-up testid 存在（`skills-index-row-<id>`、
// `plugins-index-row-<id>`）；legacy LibraryTopLevelEntry testid
//（`library-top-level-skills`、`library-folder-<source>`、
// `library-item-<id>`）在 DOM 中缺席。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SkillsIndexPage } from "../src/components/specs/SkillsIndexPage.js";
import { PluginsIndexPage } from "../src/components/specs/PluginsIndexPage.js";
import { createTestRouter } from "./helpers/test-router.js";

const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

function fileList(entries: Array<{ name: string; type: "dir" | "file" }>) {
  return {
    root: "workspace",
    path: "",
    entries: entries.map((entry) => ({
      ...entry,
      size: entry.type === "file" ? 42 : null,
      mtime: "2026-05-12T00:00:00.000Z",
    })),
  };
}

const NOT_FOUND = { status: 404, ok: false, json: async () => ({ error: "not_found" }) };

function renderSkillsIndex() {
  return render(
    createTestRouter({
      path: "/specs/skills",
      initialPath: "/specs/skills",
      component: () => <SkillsIndexPage />,
    }),
  );
}

function renderPluginsIndex() {
  return render(
    createTestRouter({
      path: "/specs/plugins",
      initialPath: "/specs/plugins",
      component: () => <PluginsIndexPage />,
    }),
  );
}

describe("SkillsIndexPage — slice 28 HG-9 (rolled-up flat rows)", () => {
  // C-4：mock 新 /api/skills/library 端点（daemon 拥有的发现）。
  function mockSkillsFetch(skillNames: string[]) {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/skills/library") {
        return {
          ok: true,
          json: async () =>
            skillNames.map((name) => ({
              id: `openrig-managed:${name}`,
              name,
              source: "openrig-managed",
              files: [{ name: "SKILL.md", path: "SKILL.md", size: 42, mtime: "2026-05-12T00:00:00.000Z" }],
            })),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  it("renders each skill as a flat row with stable testid", async () => {
    mockSkillsFetch(["alpha-skill", "beta-skill"]);
    renderSkillsIndex();
    await waitFor(() => {
      expect(screen.getByTestId("skills-index-rows")).toBeTruthy();
    });
    expect(screen.getByTestId("skills-index-row-openrig-managed:alpha-skill")).toBeTruthy();
    expect(screen.getByTestId("skills-index-row-openrig-managed:beta-skill")).toBeTruthy();
  });

  it("each row navigates to /specs/skills/$skillToken (anchor with correct href)", async () => {
    mockSkillsFetch(["alpha-skill"]);
    renderSkillsIndex();
    const id = "openrig-managed:alpha-skill";
    await waitFor(() => {
      expect(screen.getByTestId(`skills-index-row-${id}`)).toBeTruthy();
    });
    const row = screen.getByTestId(`skills-index-row-${id}`) as HTMLAnchorElement;
    expect(row.tagName).toBe("A");
    expect(row.getAttribute("href")).toMatch(/^\/specs\/skills\//);
  });

  it("each row includes source label + file-count columns", async () => {
    mockSkillsFetch(["alpha-skill"]);
    renderSkillsIndex();
    const id = "openrig-managed:alpha-skill";
    await waitFor(() => {
      expect(screen.getByTestId(`skills-index-row-${id}-source`)).toBeTruthy();
    });
    expect(screen.getByTestId(`skills-index-row-${id}-source`).textContent).toContain("zrig 托管");
    expect(screen.getByTestId(`skills-index-row-${id}-filecount`).textContent).toMatch(/1 个文件/);
  });

  it("DISCRIMINATOR: legacy LibraryTopLevelEntry testids ABSENT in DOM", async () => {
    mockSkillsFetch(["alpha-skill"]);
    renderSkillsIndex();
    await waitFor(() => {
      expect(screen.getByTestId("skills-index-rows")).toBeTruthy();
    });
    expect(screen.queryByTestId("library-top-level-skills")).toBeNull();
    expect(screen.queryByTestId("library-folder-workspace")).toBeNull();
    expect(screen.queryByTestId("library-folder-openrig-managed")).toBeNull();
  });

  it("empty state renders when no skills present", async () => {
    mockSkillsFetch([]);
    renderSkillsIndex();
    await waitFor(() => {
      expect(screen.getByTestId("skills-index-empty")).toBeTruthy();
    });
  });
});

describe("PluginsIndexPage — slice 28 HG-10 (rolled-up flat rows)", () => {
  function mockPluginsFetch(plugins: Array<{ id: string; name: string; version: string; runtimes: ("claude" | "codex")[]; source?: string; sourceLabel?: string; skillCount?: number }>) {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/plugins") {
        return {
          ok: true,
          json: async () =>
            plugins.map((p) => ({
              id: p.id,
              name: p.name,
              version: p.version,
              description: null,
              source: p.source ?? "vendored",
              sourceLabel: p.sourceLabel ?? `vendored:${p.name}`,
              runtimes: p.runtimes,
              path: `/plugins/${p.id}`,
              lastSeenAt: null,
              skillCount: p.skillCount ?? 0,
            })),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  it("renders each plugin as a flat row with stable testid", async () => {
    mockPluginsFetch([
      { id: "openrig-core", name: "openrig-core", version: "0.1.0", runtimes: ["claude", "codex"] },
      { id: "gstack", name: "gstack", version: "0.5.0", runtimes: ["claude"] },
    ]);
    renderPluginsIndex();
    await waitFor(() => {
      expect(screen.getByTestId("plugins-index-rows")).toBeTruthy();
    });
    expect(screen.getByTestId("plugins-index-row-openrig-core")).toBeTruthy();
    expect(screen.getByTestId("plugins-index-row-gstack")).toBeTruthy();
  });

  it("each row navigates to /plugins/$pluginId (anchor with correct href)", async () => {
    mockPluginsFetch([{ id: "openrig-core", name: "openrig-core", version: "0.1.0", runtimes: ["claude"] }]);
    renderPluginsIndex();
    await waitFor(() => {
      expect(screen.getByTestId("plugins-index-row-openrig-core")).toBeTruthy();
    });
    const row = screen.getByTestId("plugins-index-row-openrig-core") as HTMLAnchorElement;
    expect(row.tagName).toBe("A");
    expect(row.getAttribute("href")).toBe("/plugins/openrig-core");
  });

  it("each row includes version + runtimes + skill-count + source columns (HG-10)", async () => {
    mockPluginsFetch([
      {
        id: "openrig-core",
        name: "openrig-core",
        version: "0.1.0",
        runtimes: ["claude", "codex"],
        source: "vendored",
        sourceLabel: "vendored:openrig-core",
        skillCount: 5,
      },
    ]);
    renderPluginsIndex();
    await waitFor(() => {
      expect(screen.getByTestId("plugins-index-row-openrig-core-version")).toBeTruthy();
    });
    expect(screen.getByTestId("plugins-index-row-openrig-core-version").textContent).toBe("v0.1.0");
    const runtimesEl = screen.getByTestId("plugins-index-row-openrig-core-runtimes");
    expect(runtimesEl.textContent).toContain("claude");
    expect(runtimesEl.textContent).toContain("codex");
    expect(screen.getByTestId("plugins-index-row-openrig-core-skillcount").textContent).toBe("5 个技能");
    expect(screen.getByTestId("plugins-index-row-openrig-core-source").textContent).toContain("vendored");
  });

  it("HG-10 skill-count column singular/plural pluralization", async () => {
    mockPluginsFetch([
      { id: "single", name: "single", version: "1.0.0", runtimes: ["claude"], skillCount: 1 },
      { id: "zero", name: "zero", version: "1.0.0", runtimes: ["claude"], skillCount: 0 },
    ]);
    renderPluginsIndex();
    await waitFor(() => {
      expect(screen.getByTestId("plugins-index-row-single-skillcount")).toBeTruthy();
    });
    expect(screen.getByTestId("plugins-index-row-single-skillcount").textContent).toBe("1 个技能");
    expect(screen.getByTestId("plugins-index-row-zero-skillcount").textContent).toBe("0 个技能");
  });

  it("DISCRIMINATOR: legacy LibraryTopLevelEntry testids ABSENT in DOM", async () => {
    mockPluginsFetch([{ id: "openrig-core", name: "openrig-core", version: "0.1.0", runtimes: ["claude"] }]);
    renderPluginsIndex();
    await waitFor(() => {
      expect(screen.getByTestId("plugins-index-rows")).toBeTruthy();
    });
    expect(screen.queryByTestId("library-top-level-plugins")).toBeNull();
    expect(screen.queryByTestId("library-folder-vendored")).toBeNull();
    expect(screen.queryByTestId("library-folder-claude-cache")).toBeNull();
  });

  it("empty state renders when no plugins present", async () => {
    mockPluginsFetch([]);
    renderPluginsIndex();
    await waitFor(() => {
      expect(screen.getByTestId("plugins-index-empty")).toBeTruthy();
    });
  });

  it("count badge reflects number of plugins", async () => {
    mockPluginsFetch([
      { id: "openrig-core", name: "openrig-core", version: "0.1.0", runtimes: ["claude"] },
      { id: "gstack", name: "gstack", version: "0.5.0", runtimes: ["claude"] },
      { id: "obra-superpowers", name: "obra-superpowers", version: "1.0.0", runtimes: ["claude"] },
    ]);
    renderPluginsIndex();
    await waitFor(() => {
      expect(screen.getByTestId("plugins-index-count").textContent).toBe("3 个插件");
    });
  });
});
