// Slice 11（workflow-spec-folder-discovery）——当 daemon 从 folder-scan walk
// 呈现 status='error' + errorMessage 时，UI Library 渲染诊断 workflow 行。
// 诊断行不可导航（不可解析 YAML 无 review payload）；错误消息内联呈现，
// 使 operator 就地修文件。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { SpecsLibraryPage } from "../src/components/specs/SpecsLibraryPage.js";
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

function emptyAux(url: string): { ok: true; json: () => Promise<unknown> } | null {
  if (url === "/api/context-packs/library" || url === "/api/agent-images/library") {
    return { ok: true, json: async () => [] };
  }
  if (url === "/api/files/roots") {
    return { ok: true, json: async () => ({ roots: [] }) };
  }
  if (url.startsWith("/api/files/list?")) {
    return { ok: true, json: async () => ({ root: "workspace", path: "", entries: [] }) };
  }
  return null;
}

function renderPage() {
  return render(
    createTestRouter({ path: "/specs", component: () => <SpecsLibraryPage /> }),
  );
}

describe("Library workflow diagnostic rows (slice 11)", () => {
  it("renders a diagnostic workflow row with error styling + errorMessage", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      const aux = emptyAux(url);
      if (aux) return aux;
      if (url === "/api/specs/library") {
        return {
          ok: true,
          json: async () => [
            {
              id: "workflow:good:1",
              kind: "workflow",
              name: "good-spec",
              version: "1",
              sourceType: "user_file",
              sourcePath: "/ws/specs/workflows/good.yaml",
              relativePath: "workflows/good.yaml",
              updatedAt: "2026-05-09T00:00:00.000Z",
              status: "valid",
              errorMessage: null,
            },
            {
              id: "workflow:error:/ws/specs/workflows/broken.yaml",
              kind: "workflow",
              name: "broken.yaml",
              version: "",
              sourceType: "user_file",
              sourcePath: "/ws/specs/workflows/broken.yaml",
              relativePath: "workflows/broken.yaml",
              updatedAt: "2026-05-09T00:00:00.000Z",
              status: "error",
              errorMessage: "missing required version, roles, steps",
            },
          ],
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    renderPage();

    const section = await waitFor(() =>
      screen.getByTestId("library-section-workflow-specs"),
    );
    // 有效行可点击（渲染为 Link）。
    const goodRow = await within(section).findByTestId("library-row-workflow-specs-workflow:good:1");
    expect(goodRow.tagName.toLowerCase()).toBe("a");
    // Router 把 `:` URL 编码为 %3A。
    expect(goodRow.getAttribute("href")).toContain("workflow%3Agood%3A1");

    // 诊断行用不同 testid 模式并内联渲染
    // errorMessage，而非可导航链接（不可解析 spec 无 review
    // payload）。
    const diagRow = await within(section).findByTestId(
      "library-row-workflow-specs-workflow:error:/ws/specs/workflows/broken.yaml",
    );
    expect(diagRow.tagName.toLowerCase()).not.toBe("a");
    expect(diagRow.getAttribute("data-status")).toBe("error");
    expect(within(diagRow).getByText(/missing required version, roles, steps/)).toBeDefined();
    expect(within(diagRow).getByText(/broken\.yaml/)).toBeDefined();
  });

  it("still navigates valid workflow rows to /specs/library/$entryId", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      const aux = emptyAux(url);
      if (aux) return aux;
      if (url === "/api/specs/library") {
        return {
          ok: true,
          json: async () => [
            {
              id: "workflow:nav:1",
              kind: "workflow",
              name: "nav-spec",
              version: "1",
              sourceType: "user_file",
              sourcePath: "/ws/specs/workflows/nav.yaml",
              relativePath: "workflows/nav.yaml",
              updatedAt: "2026-05-09T00:00:00.000Z",
              status: "valid",
              errorMessage: null,
            },
          ],
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    renderPage();
    const section = await waitFor(() => screen.getByTestId("library-section-workflow-specs"));
    const link = await within(section).findByTestId("library-row-workflow-specs-workflow:nav:1");
    expect(link.tagName.toLowerCase()).toBe("a");
    expect(link.getAttribute("href")).toMatch(/workflow%3Anav%3A1/);
  });
});
