// Phase 3a slice 3.3——AgentPluginsList 富化组件测试。
//
// 独立 helper，接收 plugin ID 列表（来自 agent.yaml 的
// resources.plugins[].id 字段）并渲染富化 chip：
//   - plugin 名 + 版本
//   - runtime 支持徽章（claude / codex）
//   - 来源标签溯源
//   - 到 /plugins/:pluginId 的 view-in-library 链接
//
// slice 3.3 收尾时此组件独立（未接入
// AgentSpecDisplay，因 batch 1 在 plugin-primitive-v0 分支拥有该文件）。
// 合并入 plugin-primitive-v0 时，AgentSpecDisplay Plugins 段（batch 1 加）将
// 消费此组件，从 string-list-of-ids 升级为富化 chip。
// 此前此组件可独立测试与发布。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { AgentPluginsList } from "../src/components/specs/AgentPluginsList.js";
import { createTestRouter } from "./helpers/test-router.js";

const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderList(pluginIds: string[]) {
  return render(
    createTestRouter({
      path: "/",
      component: () => <AgentPluginsList pluginIds={pluginIds} />,
    }),
  );
}

describe("AgentPluginsList", () => {
  it("renders empty state when agent has no plugin references", async () => {
    renderList([]);
    expect(await screen.findByTestId("agent-plugins-empty")).toBeDefined();
  });

  it("renders one chip per plugin id with name + version + runtime badges", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/plugins") {
        return {
          ok: true,
          json: async () => [
            {
              id: "openrig-core",
              name: "openrig-core",
              version: "0.1.0",
              description: null,
              source: "vendored",
              sourceLabel: "vendored:openrig-core",
              runtimes: ["claude", "codex"],
              path: "/x",
              lastSeenAt: null,
            },
            {
              id: "superpowers",
              name: "superpowers",
              version: "5.1.0",
              description: null,
              source: "claude-cache",
              sourceLabel: "claude-cache:obra/superpowers/5.1.0",
              runtimes: ["claude"],
              path: "/y",
              lastSeenAt: null,
            },
          ],
        };
      }
      throw new Error(`unexpected ${url}`);
    });
    renderList(["openrig-core", "superpowers"]);

    // 等 resolved chip（它们有 unresolved chip 所缺的版本 + 来源标签）。
    // 单靠 testid 不足以区分，因 unresolved fallback 用同一 testid。
    await waitFor(() => {
      expect(screen.getByText("vendored:openrig-core")).toBeDefined();
      expect(screen.getByText("claude-cache:obra/superpowers/5.1.0")).toBeDefined();
    });
    expect(screen.getByTestId("agent-plugin-chip-openrig-core")).toBeDefined();
    expect(screen.getByTestId("agent-plugin-chip-superpowers")).toBeDefined();

    // Plugin 名可见。
    expect(screen.getByText("openrig-core")).toBeDefined();
    expect(screen.getByText("superpowers")).toBeDefined();
    // 版本可见（跨可能的 text-node 拆分做 regex 匹配）。
    expect(screen.getByText(/v0\.1\.0/)).toBeDefined();
    expect(screen.getByText(/v5\.1\.0/)).toBeDefined();
    // Runtime 支持徽章（drift 判别：2-runtime + 1-runtime）。
    const claudeBadges = screen.getAllByText("claude");
    expect(claudeBadges.length).toBeGreaterThanOrEqual(2);
    const codexBadges = screen.getAllByText("codex");
    expect(codexBadges.length).toBeGreaterThanOrEqual(1);
    // 来源标签可见。
    expect(screen.getByText("vendored:openrig-core")).toBeDefined();
    expect(screen.getByText("claude-cache:obra/superpowers/5.1.0")).toBeDefined();
  });

  it("renders unresolved chip when plugin id not found in discovery", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/plugins") {
        return { ok: true, json: async () => [] };
      }
      throw new Error(`unexpected ${url}`);
    });
    renderList(["missing-plugin"]);
    await waitFor(() => {
      expect(screen.getByTestId("agent-plugin-chip-missing-plugin")).toBeDefined();
    });
    expect(screen.getByText("missing-plugin")).toBeDefined();
    expect(screen.getByTestId("agent-plugin-unresolved-missing-plugin")).toBeDefined();
  });

  it("each chip links to /plugins/:pluginId for viewer navigation", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/plugins") {
        return {
          ok: true,
          json: async () => [
            {
              id: "openrig-core",
              name: "openrig-core",
              version: "0.1.0",
              description: null,
              source: "vendored",
              sourceLabel: "vendored:openrig-core",
              runtimes: ["claude"],
              path: "/x",
              lastSeenAt: null,
            },
          ],
        };
      }
      throw new Error(`unexpected ${url}`);
    });
    renderList(["openrig-core"]);
    // 等 resolved chip（来源标签仅 resolved 有）。
    await waitFor(() => {
      expect(screen.getByText("vendored:openrig-core")).toBeDefined();
    });
    const chip = screen.getByTestId("agent-plugin-chip-openrig-core") as HTMLAnchorElement;
    expect(chip.tagName).toBe("A");
    expect(chip.getAttribute("href")).toBe("/plugins/openrig-core");
  });
});
