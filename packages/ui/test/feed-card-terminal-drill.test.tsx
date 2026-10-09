// OPR.0.3.3.20 + OPR.0.4.0.24——卡级钻取到 live 终端。
//
// 判别 A（scope 围栏）：钻取经 session 名接缝解析并挂载 FocusedTerminal
//（live xterm/WebSocket）——不发 /preview fetch。
// 判别 B（诚实）：无解析 session -> DISABLED 并带诚实 title。
// AC-3（降级）：live 终端连不上时，FocusedTerminal
// 如实显示”终端不可用”状态——不回退 /preview，
// 无伪造 captured promise。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";
import { FeedCardTerminalDrill } from "../src/components/for-you/FeedCardTerminalDrill.js";

const mockFetch = vi.fn();

function withQueryClient(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function settingsResponse() {
  return {
    settings: {
      "ui.preview.refresh_interval_seconds": { value: 60, source: "default", defaultValue: 3 },
      "ui.preview.default_lines": { value: 50, source: "default", defaultValue: 50 },
    },
  };
}

describe("FeedCardTerminalDrill (AC-4)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/config") return new Response(JSON.stringify(settingsResponse()));
      if (url.includes("/api/sessions/")) {
        return new Response(JSON.stringify({
          sessionName: "dev-impl@my-rig",
          content: "agent output line",
          lines: 1,
          capturedAt: "2026-06-11T00:00:00Z",
        }));
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("clicking the drill opens the terminal preview for the resolved session via the session-name seam", async () => {
    const { getByTestId } = withQueryClient(
      <FeedCardTerminalDrill cardId="card-1" sessionName="dev-impl@my-rig" />,
    );

    fireEvent.click(getByTestId("feed-card-drill-card-1"));

    await waitFor(() => getByTestId("feed-card-drill-card-1-terminal-popover"));
    await waitFor(() => {
      expect(getByTestId("focused-terminal-dev-impl@my-rig")).toBeTruthy();
    });
    const previewCalls = mockFetch.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/preview"));
    expect(previewCalls).toHaveLength(0);
  });

  it("DISCRIMINATOR A: no topology resolution — no /api/rigs/ or agent-activity call is made", async () => {
    const { getByTestId } = withQueryClient(
      <FeedCardTerminalDrill cardId="card-2" sessionName="dev-impl@my-rig" />,
    );

    fireEvent.click(getByTestId("feed-card-drill-card-2"));
    await waitFor(() => getByTestId("feed-card-drill-card-2-terminal-popover"));

    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/api/rigs/"))).toBe(false);
    expect(urls.some((u) => u.includes("agent-activity"))).toBe(false);
  });

  it("DISCRIMINATOR B: no resolved session -> disabled drill with an honest title, no popover", () => {
    const { getByTestId, queryByTestId } = withQueryClient(
      <FeedCardTerminalDrill cardId="card-3" sessionName={undefined} />,
    );

    const drill = getByTestId("feed-card-drill-card-3") as HTMLButtonElement;
    expect(drill.disabled).toBe(true);
    expect(drill.title).toContain("本卡片未解析到会话");

    fireEvent.click(drill);
    expect(queryByTestId("feed-card-drill-card-3-terminal-popover")).toBeNull();
    // 未 fetch 任何东西——未打开空/错终端。
    const previewCalls = mockFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes("/api/sessions/"));
    expect(previewCalls).toHaveLength(0);
  });

  it("the drill label says live terminal (converged from captured preview)", () => {
    const { getByTestId } = withQueryClient(
      <FeedCardTerminalDrill cardId="card-4" sessionName="dev-impl@my-rig" />,
    );

    const drill = getByTestId("feed-card-drill-card-4") as HTMLButtonElement;
    expect(drill.textContent).toContain("实时终端");
    expect(drill.title).toContain("实时终端");
    expect(drill.textContent).not.toContain("captured");
    expect(drill.textContent).not.toContain("preview");
    expect(drill.title).not.toContain("captured");
    expect(drill.title).not.toContain("snapshot");
  });

  it("AC-3: drill mounts FocusedTerminal (live path), no /preview fallback, no captured copy", async () => {
    const { getByTestId } = withQueryClient(
      <FeedCardTerminalDrill cardId="card-5" sessionName="dev-impl@my-rig" />,
    );

    fireEvent.click(getByTestId("feed-card-drill-card-5"));
    await waitFor(() => getByTestId("feed-card-drill-card-5-terminal-popover"));

    await waitFor(() => {
      expect(getByTestId("focused-terminal-dev-impl@my-rig")).toBeTruthy();
    });

    const previewCalls = mockFetch.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/preview"));
    expect(previewCalls).toHaveLength(0);

    const popoverEl = getByTestId("feed-card-drill-card-5-terminal-popover");
    expect(popoverEl.innerHTML).not.toContain("captured");
    expect(popoverEl.innerHTML).not.toContain("snapshot");
  });

  it("AC-3 source guard: FocusedTerminal has explicit terminal-unavailable error branch", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, "../src/components/terminal/FocusedTerminal.tsx"),
      "utf-8",
    );
    expect(src).toContain("终端不可用");
    expect(src).toContain("setError");
    expect(src).toContain("[disconnected - reconnecting...]");
  });
});
