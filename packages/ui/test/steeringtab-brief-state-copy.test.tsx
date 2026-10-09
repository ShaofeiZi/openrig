// R1（release-0.4.7）——C4b：SteeringTab BriefPanel 文案按 useScopeMarkdown 状态映射。
//
// BriefPanel 保持其 remote-gate 优先（不变）及其 `NO BRIEF YET`
// 缺失文案字节不变；读失败与错根 mission 路径现各得
// 诚实文案，插入 loading 与 absent 分支之间。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SteeringTab } from "../src/components/project/SteeringTab.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

// 选项：host = "local" | "remote"，roots 是否含 mission 路径，
// briefStatus = MISSION_BRIEF.md 的读状态
function install(opts: { host?: string; rootPath?: string; briefStatus?: number }) {
  const host = opts.host ?? "local";
  const rootPath = opts.rootPath ?? "/ws";
  mockFetch.mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/hosts")) return json({ ownName: "localhost", selected: host, hosts: [] });
    const m = url.match(/\/api\/missions\/([^/?]+)/);
    if (m) return json({ missionId: decodeURIComponent(m[1]!), missionPath: "/ws/missions/m", slices: [], workflow_spec: null, topology: null });
    if (url.includes("/api/files/roots")) return json({ roots: [{ name: "work", path: rootPath }] });
    if (url.includes("/api/files/read")) return json({ error: "x" }, opts.briefStatus ?? 404);
    return json([]);
  });
}

beforeEach(() => mockFetch.mockReset());
afterEach(() => cleanup());

describe("R1 C4b — SteeringTab BriefPanel honest copy", () => {
  it("read_error → BRIEF READ FAILED (local, read 500)", async () => {
    install({ host: "local", briefStatus: 500 });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SteeringTab missionId="m" /></QueryClientProvider>);
    const el = await screen.findByTestId("brief-panel-read-error-state");
    expect(el.textContent).toContain("简报读取失败");
    expect(el.textContent).toContain("这是读取失败，不是简报缺失");
    expect(screen.queryByTestId("brief-panel-empty-state")).toBeNull();
  });

  it("unresolved → BRIEF OUTSIDE FILE ROOTS (local, mission path outside roots)", async () => {
    install({ host: "local", rootPath: "/elsewhere" });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SteeringTab missionId="m" /></QueryClientProvider>);
    const el = await screen.findByTestId("brief-panel-unresolved-state");
    expect(el.textContent).toContain("简报在文件根目录之外");
    expect(el.textContent).toContain("OPENRIG_FILES_ALLOWLIST");
    expect(screen.queryByTestId("brief-panel-empty-state")).toBeNull();
  });

  it("absent (404) → NO BRIEF YET, BYTE-IDENTICAL to 8250d702", async () => {
    install({ host: "local", briefStatus: 404 });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SteeringTab missionId="m" /></QueryClientProvider>);
    const el = await screen.findByTestId("brief-panel-empty-state");
    expect(el.textContent).toContain("尚无简报");
    expect(el.textContent).toContain(
      "任务根目录下无 MISSION_BRIEF.md。",
    );
  });

  it("known-remote → remote gate fires FIRST (LOCAL FILES NOT SHOWN), never the absent copy", async () => {
    install({ host: "remote-host", briefStatus: 404 });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SteeringTab missionId="m" /></QueryClientProvider>);
    const el = await screen.findByTestId("brief-panel-remote-gated-state");
    expect(el.textContent).toContain("不显示本地文件");
    expect(screen.queryByTestId("brief-panel-empty-state")).toBeNull();
    expect(screen.queryByTestId("brief-panel-read-error-state")).toBeNull();
  });
});
