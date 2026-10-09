// PluginDetailPage 状态 + 内容测试。
//
// Slice 28 Checkpoint C-2 重构 PluginDetailPage 以用新
// daemon 端点 /api/plugins/:id/files/{list,read}（SC-29 EXCEPTION
// #11）渲染 plugin 文件夹的真实 file-browser 树。C-shell 的
// 虚拟 structured-data 树消失；structured data（manifest 字段、hook
// 事件、MCP servers、used-by 列表）经直接文件查看或 header strip
// 元数据（skillCount + usedBy 计数）呈现。
//
// Loading + not-found 测试保留。内容测试为 real-file-tree 形状重写。
// 综合 docs-browser 覆盖（folder 导航、viewer 内容）在
// slice-28-detail-pages.test.tsx。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PluginDetailPage } from "../src/components/specs/PluginDetailPage.js";
import { createTestRouter } from "./helpers/test-router.js";

const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPluginDetail(pluginId: string) {
  return render(
    createTestRouter({
      path: "/",
      component: () => <PluginDetailPage pluginId={pluginId} />,
    }),
  );
}

function fileList(entries: Array<{ name: string; type: "dir" | "file" }>) {
  return {
    entries: entries.map((entry) => ({
      ...entry,
      size: entry.type === "file" ? 42 : null,
      mtime: "2026-05-12T00:00:00.000Z",
    })),
  };
}

describe("PluginDetailPage", () => {
  it("shows loading state while plugin detail is fetching", async () => {
    mockFetch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { ok: true, json: async () => null };
    });
    renderPluginDetail("openrig-core");
    expect(await screen.findByTestId("plugin-detail-loading")).toBeDefined();
  });

  it("shows not-found state when plugin id missing", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/plugins/missing")) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      throw new Error(`unexpected ${url}`);
    });
    renderPluginDetail("missing");
    expect(await screen.findByTestId("plugin-detail-not-found")).toBeDefined();
  });

  it("renders header (name + version + runtime badges + source + skill-count + used-by-count) and surfaces plugin folder files via real file-browser tree", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/plugins/openrig-core") {
        return {
          ok: true,
          json: async () => ({
            entry: {
              id: "openrig-core",
              name: "openrig-core",
              version: "0.1.0",
              description: "Canonical OpenRig content",
              source: "vendored",
              sourceLabel: "vendored:openrig-core",
              runtimes: ["claude", "codex"],
              path: "/x/openrig-core",
              lastSeenAt: "2026-05-10T00:00:00.000Z",
              skillCount: 2,
            },
            claudeManifest: null,
            codexManifest: null,
            skills: [
              { name: "openrig-user", relativePath: "skills/openrig-user" },
              { name: "queue-handoff", relativePath: "skills/queue-handoff" },
            ],
            hooks: [{ runtime: "claude", relativePath: "hooks/claude.json", events: ["SessionStart"] }],
            mcpServers: [],
          }),
        };
      }
      if (url === "/api/plugins/openrig-core/used-by") {
        return {
          ok: true,
          json: async () => [
            { agentName: "advisor-lead", sourcePath: "/x/agent.yaml", profiles: ["default"] },
            { agentName: "velocity-driver", sourcePath: "/y/agent.yaml", profiles: ["default", "review"] },
          ],
        };
      }
      if (url === "/api/plugins/openrig-core/files/list?path=") {
        return {
          ok: true,
          json: async () => ({
            pluginId: "openrig-core",
            path: "",
            ...fileList([
              { name: ".claude-plugin", type: "dir" },
              { name: "hooks", type: "dir" },
              { name: "skills", type: "dir" },
              { name: "README.md", type: "file" },
            ]),
          }),
        };
      }
      if (url === "/api/plugins/openrig-core/files/read?path=README.md") {
        return {
          ok: true,
          json: async () => ({
            pluginId: "openrig-core",
            path: "README.md",
            absolutePath: "/x/openrig-core/README.md",
            content: "# OpenRig Core\nCanonical content.",
            mtime: "2026-05-10T00:00:00.000Z",
            contentHash: "h",
            size: 30,
          }),
        };
      }
      throw new Error(`unexpected ${url}`);
    });
    renderPluginDetail("openrig-core");

    expect(await screen.findByTestId("plugin-detail-page")).toBeDefined();
    // Header 内容跨 C-2 重构保留。
    expect(screen.getByRole("heading", { name: "openrig-core" })).toBeDefined();
    expect(screen.getByText("v0.1.0")).toBeDefined();
    expect(screen.getByText("Canonical OpenRig content")).toBeDefined();
    expect(screen.getByTestId("plugin-detail-runtime-claude")).toBeDefined();
    expect(screen.getByTestId("plugin-detail-runtime-codex")).toBeDefined();
    expect(screen.getByText("vendored:openrig-core")).toBeDefined();
    expect(screen.getByTestId("plugin-detail-skill-count").textContent).toBe("2 个技能");
    expect(screen.getByTestId("plugin-detail-used-by-count").textContent).toBe("被 2 个智能体使用");

    // 真实 file-browser 树从 daemon 列出 plugin 根 files/dirs。
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-entry-README.md")).toBeDefined();
    });
    expect(screen.getByTestId("plugin-detail-tree-entry-skills")).toBeDefined();
    expect(screen.getByTestId("plugin-detail-tree-entry-hooks")).toBeDefined();
    expect(screen.getByTestId("plugin-detail-tree-entry-.claude-plugin")).toBeDefined();

    // 进入时 README.md 自动选中；markdown body 可见。
    await waitFor(() => {
      expect(screen.getByText(/Canonical content/)).toBeDefined();
    });
  });

  it("renders empty plugin folder gracefully", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/plugins/skinny") {
        return {
          ok: true,
          json: async () => ({
            entry: {
              id: "skinny",
              name: "skinny",
              version: "0.0.1",
              description: null,
              source: "claude-cache",
              sourceLabel: "claude-cache:other/skinny/0.0.1",
              runtimes: ["claude"],
              path: "/x/skinny",
              lastSeenAt: null,
              skillCount: 0,
            },
            claudeManifest: null,
            codexManifest: null,
            skills: [],
            hooks: [],
            mcpServers: [],
          }),
        };
      }
      if (url === "/api/plugins/skinny/used-by") {
        return { ok: true, json: async () => [] };
      }
      if (url === "/api/plugins/skinny/files/list?path=") {
        return { ok: true, json: async () => ({ pluginId: "skinny", path: "", entries: [] }) };
      }
      throw new Error(`unexpected ${url}`);
    });
    renderPluginDetail("skinny");
    expect(await screen.findByTestId("plugin-detail-page")).toBeDefined();
    expect(screen.getByTestId("plugin-detail-skill-count").textContent).toBe("0 个技能");
    expect(screen.getByTestId("plugin-detail-used-by-count").textContent).toBe("被 0 个智能体使用");
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-empty")).toBeDefined();
    });
    expect(screen.getByTestId("plugin-detail-viewer-no-selection")).toBeDefined();
  });

  it("folder navigation: clicking a directory enters it; '..' returns to parent", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/plugins/openrig-core") {
        return {
          ok: true,
          json: async () => ({
            entry: {
              id: "openrig-core",
              name: "openrig-core",
              version: "0.1.0",
              description: null,
              source: "vendored",
              sourceLabel: "vendored:openrig-core",
              runtimes: ["claude"],
              path: "/x/openrig-core",
              lastSeenAt: null,
              skillCount: 1,
            },
            claudeManifest: null,
            codexManifest: null,
            skills: [],
            hooks: [],
            mcpServers: [],
          }),
        };
      }
      if (url === "/api/plugins/openrig-core/used-by") return { ok: true, json: async () => [] };
      if (url === "/api/plugins/openrig-core/files/list?path=") {
        return {
          ok: true,
          json: async () => ({ pluginId: "openrig-core", path: "", ...fileList([{ name: "skills", type: "dir" }]) }),
        };
      }
      if (url === "/api/plugins/openrig-core/files/list?path=skills") {
        return {
          ok: true,
          json: async () => ({ pluginId: "openrig-core", path: "skills", ...fileList([{ name: "openrig-user", type: "dir" }]) }),
        };
      }
      throw new Error(`unexpected ${url}`);
    });
    renderPluginDetail("openrig-core");
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-entry-skills")).toBeDefined();
    });
    fireEvent.click(screen.getByTestId("plugin-detail-tree-entry-skills"));
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-entry-skills/openrig-user")).toBeDefined();
    });
    expect(screen.getByTestId("plugin-detail-tree-up")).toBeDefined();
    fireEvent.click(screen.getByTestId("plugin-detail-tree-up"));
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-entry-skills")).toBeDefined();
    });
  });
});
