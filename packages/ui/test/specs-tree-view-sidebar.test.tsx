import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SpecsTreeView } from "../src/components/specs/SpecsTreeView.js";
import { createTestRouter } from "./helpers/test-router.js";

// Slice 28——Library Explorer 收尾。
//
// Slice 18 最初落地 Library Explorer 时带顶层重复：`> Skills` 和
// `> Plugins` Link 作为独立 sidebar 条目位于分组树之上。Founder-walk
// 反馈标记此为重复 UI 可点击项——下面分组 section 已带这些条目。
// Slice 28 移除顶层重复，并把双动作行为（导航到 index + 展开子树）
// 迁移到 SKILLS + PLUGINS section 标签本身。同时重排底部 section，
// 使 PLUGINS 位于 SKILLS 之上。

const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  // 全部 Library 端点返回空，使 Section 展开时渲染其
  // "No skills yet." 占位——可见展开证明，无需真实 Library 数据。
  mockFetch.mockImplementation(async () => ({
    ok: true,
    json: async () => [],
  }));
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

function renderTree() {
  return render(
    createTestRouter({
      path: "/specs",
      initialPath: "/specs",
      component: () => <SpecsTreeView />,
    }),
  );
}

describe("SpecsTreeView — slice 28 HG-1 (top-level duplicates removed)", () => {
  it("does NOT render the legacy `sidebar-skills-top-level` link", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("specs-section-skills")).toBeTruthy();
    });
    // slice 28 前 testid；必须缺席。与 slice 18 形状的判别。
    expect(screen.queryByTestId("sidebar-skills-top-level")).toBeNull();
  });

  it("does NOT render the legacy `sidebar-plugins-top-level` link", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("specs-section-plugins")).toBeTruthy();
    });
    expect(screen.queryByTestId("sidebar-plugins-top-level")).toBeNull();
  });
});

describe("SpecsTreeView — slice 28 HG-4 (PLUGINS above SKILLS in section order)", () => {
  it("PLUGINS section appears before SKILLS section in DOM order", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("specs-section-plugins")).toBeTruthy();
      expect(screen.getByTestId("specs-section-skills")).toBeTruthy();
    });
    const plugins = screen.getByTestId("specs-section-plugins");
    const skills = screen.getByTestId("specs-section-skills");
    // DOCUMENT_POSITION_FOLLOWING = 4。若 plugins 在 skills 之前，
    // plugins.compareDocumentPosition(skills) 含该位。
    expect(plugins.compareDocumentPosition(skills) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("SpecsTreeView — slice 28 HG-2 (SKILLS section dual-action label)", () => {
  it("renders a navigable SKILLS section label (testid `specs-section-link-skills`)", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("specs-section-link-skills")).toBeTruthy();
    });
    // Anchor 元素（Link）——必须有到 /specs/skills 的 href。
    const link = screen.getByTestId("specs-section-link-skills") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/specs/skills");
  });

  it("SKILLS section is collapsed by default (placeholder absent)", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("specs-section-skills")).toBeTruthy();
    });
    expect(screen.queryByText(/尚无技能/)).toBeNull();
  });

  it("clicking the SKILLS section label expands the Skills section below (placeholder visible)", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("specs-section-link-skills")).toBeTruthy();
    });
    expect(screen.queryByText(/尚无技能/)).toBeNull();

    fireEvent.click(screen.getByTestId("specs-section-link-skills"));

    await waitFor(() => {
      // 点击后，section 展开 body 渲染。因 useLibrarySkills mock
      // 返回 []，Section 显示其 "No skills yet." 占位——展开证明。
      expect(screen.getByText(/尚无技能/)).toBeTruthy();
    });
  });

  it("chevron toggle still works independently of the label Link (expand-only side)", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("specs-section-toggle-skills")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("specs-section-toggle-skills"));
    await waitFor(() => {
      expect(screen.getByText(/尚无技能/)).toBeTruthy();
    });
  });
});

describe("SpecsTreeView — slice 28 HG-3 (PLUGINS section dual-action label)", () => {
  it("renders a navigable PLUGINS section label (testid `specs-section-link-plugins`)", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("specs-section-link-plugins")).toBeTruthy();
    });
    const link = screen.getByTestId("specs-section-link-plugins") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/specs/plugins");
  });

  it("PLUGINS section is collapsed by default (placeholder absent)", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("specs-section-plugins")).toBeTruthy();
    });
    expect(screen.queryByText(/尚无插件/)).toBeNull();
  });

  it("clicking the PLUGINS section label expands the Plugins section below (placeholder visible)", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("specs-section-link-plugins")).toBeTruthy();
    });
    expect(screen.queryByText(/尚无插件/)).toBeNull();

    fireEvent.click(screen.getByTestId("specs-section-link-plugins"));

    await waitFor(() => {
      expect(screen.getByText(/尚无插件/)).toBeTruthy();
    });
  });

  it("chevron toggle still works independently of the label Link (expand-only side)", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("specs-section-toggle-plugins")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("specs-section-toggle-plugins"));
    await waitFor(() => {
      expect(screen.getByText(/尚无插件/)).toBeTruthy();
    });
  });
});

describe("SpecsTreeView — slice 19 sidebar density follow-up", () => {
  it("renders Library Explorer spec/plugin entries as single-row name-only leaves with metadata kept out of visible text", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/specs/library") {
        return {
          ok: true,
          json: async () => [
            { id: "rig:adversarial-review:0.2", kind: "rig", name: "adversarial-review", version: "0.2", sourceType: "builtin", sourcePath: "/pkg/rig.yaml", relativePath: "rig.yaml" },
            { id: "workflow:conveyor:1", kind: "workflow", name: "conveyor", version: "1", sourceType: "builtin", sourcePath: "/pkg/workflow.yaml", relativePath: "workflow.yaml" },
            { id: "agent:driver:1", kind: "agent", name: "driver", version: "1", sourceType: "builtin", sourcePath: "/pkg/agent.yaml", relativePath: "agent.yaml" },
            { id: "app:vault:3", kind: "rig", name: "vault-app", version: "3", sourceType: "builtin", sourcePath: "/pkg/app/rig.yaml", relativePath: "apps/vault/rig.yaml", hasServices: true },
          ],
        };
      }
      if (url === "/api/context-packs/library") {
        return {
          ok: true,
          json: async () => [
            { id: "context-pack:demo:1", kind: "context-pack", name: "demo-pack", version: "1", sourceType: "workspace", sourcePath: "/workspace/.openrig/context-packs/demo", relativePath: "demo", updatedAt: "2026-05-07T00:00:00.000Z", manifestEstimatedTokens: null, derivedEstimatedTokens: 120, files: [] },
          ],
        };
      }
      if (url === "/api/agent-images/library") {
        return {
          ok: true,
          json: async () => [
            { id: "agent-image:driver:1", kind: "agent-image", name: "driver-image", version: "1", runtime: "claude-code", sourceSeat: "driver", sourceSessionId: "s", sourceCwd: null, notes: null, createdAt: "2026-05-07T00:00:00.000Z", sourceType: "workspace", sourcePath: "/workspace/.openrig/agent-images/driver", relativePath: "driver", updatedAt: "2026-05-07T00:00:00.000Z", manifestEstimatedTokens: null, derivedEstimatedTokens: 200, files: [], sourceResumeToken: "(redacted)", stats: { forkCount: 0, lastUsedAt: null, estimatedSizeBytes: 0, lineage: [] }, lineage: [], pinned: false },
          ],
        };
      }
      if (url === "/api/plugins") {
        return {
          ok: true,
          json: async () => [
            { id: "openrig-core", name: "openrig-core", version: "0.1.0", description: "Core plugin", source: "vendored", sourceLabel: "vendored:openrig-core", runtimes: ["claude", "codex"], path: "/plugins/openrig-core", lastSeenAt: null, skillCount: 0 },
          ],
        };
      }
      // C-4：useLibrarySkills 消费 /api/skills/library（daemon 拥有）。
      if (url === "/api/skills/library") {
        return { ok: true, json: async () => [] };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    renderTree();

    const entries = [
      { section: "rig-specs", leaf: "rig:adversarial-review:0.2", meta: "0.2" },
      { section: "workflow-specs", leaf: "workflow:conveyor:1", meta: "1" },
      { section: "context-packs", leaf: "context-pack:demo:1", meta: "1 · workspace" },
      { section: "agent-specs", leaf: "agent:driver:1", meta: "1" },
      { section: "agent-images", leaf: "agent-image:driver:1", meta: "1" },
      { section: "applications", leaf: "app:vault:3", meta: "3" },
      { section: "plugins", leaf: "openrig-core", meta: "0.1.0" },
    ];

    for (const entry of entries) {
      const section = await screen.findByTestId(`specs-section-${entry.section}`);
      const leafAlreadyVisible = within(section).queryByTestId(`specs-leaf-${entry.leaf}`);
      if (!leafAlreadyVisible) {
        fireEvent.click(await screen.findByTestId(`specs-section-toggle-${entry.section}`));
      }
      const leaf = await within(section).findByTestId(`specs-leaf-${entry.leaf}`);

      expect(leaf.parentElement?.children).toHaveLength(1);
      expect(leaf.className).toMatch(/\bflex\b/);
      expect(leaf.className).not.toMatch(/\bblock\b/);
      expect(within(section).queryByTestId(`specs-leaf-${entry.leaf}-meta`)).toBeNull();
      expect(leaf.textContent).not.toContain(entry.meta);
      expect(leaf.getAttribute("title")).toContain(entry.meta);
      expect(leaf.getAttribute("aria-label")).toContain(entry.meta);
    }
  });
});
