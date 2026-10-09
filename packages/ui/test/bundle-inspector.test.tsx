import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BundleInspector } from "../src/components/BundleInspector.js";
import { eventColor, eventSummary, type ActivityEvent } from "../src/hooks/useActivityFeed.js";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => { fetchMock = vi.fn(); globalThis.fetch = fetchMock; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const INSPECT_RESPONSE = {
  manifest: {
    name: "test-bundle", version: "0.1.0", rigSpec: "rig.yaml",
    packages: [{ name: "review-kit", version: "1.0.0", path: "packages/review-kit" }],
    integrity: { algorithm: "sha256", files: { "rig.yaml": "abc", "packages/review-kit/SKILL.md": "def" } },
  },
  digestValid: true,
  integrityResult: { passed: true, mismatches: [], missing: [], extra: [], errors: [] },
};

describe("BundleInspector", () => {
  // T1：显示清单详情
  it("显示清单名称、版本与 rig_spec", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => INSPECT_RESPONSE });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><BundleInspector /></QueryClientProvider>);

    act(() => { fireEvent.change(screen.getByTestId("bundle-path-input"), { target: { value: "/tmp/test.rigbundle" } }); });
    act(() => { fireEvent.click(screen.getByTestId("inspect-btn")); });

    await waitFor(() => {
      expect(screen.getByTestId("manifest-summary")).toBeTruthy();
      expect(screen.getByTestId("manifest-summary").textContent).toContain("test-bundle");
      expect(screen.getByTestId("manifest-summary").textContent).toContain("v0.1.0");
    });
  });

  // T2：完整性状态（绿/红）
  it("完整性状态显示为通过或失败", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => INSPECT_RESPONSE });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><BundleInspector /></QueryClientProvider>);

    act(() => { fireEvent.change(screen.getByTestId("bundle-path-input"), { target: { value: "/tmp/test.rigbundle" } }); });
    act(() => { fireEvent.click(screen.getByTestId("inspect-btn")); });

    await waitFor(() => {
      expect(screen.getByTestId("integrity-status").textContent).toContain("通过");
    });
  });

  // T3：渲染包列表
  it("渲染包列表", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => INSPECT_RESPONSE });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><BundleInspector /></QueryClientProvider>);

    act(() => { fireEvent.change(screen.getByTestId("bundle-path-input"), { target: { value: "/tmp/x.rigbundle" } }); });
    act(() => { fireEvent.click(screen.getByTestId("inspect-btn")); });

    await waitFor(() => {
      const entries = screen.getAllByTestId("package-entry");
      expect(entries).toHaveLength(1);
      expect(entries[0]!.textContent).toContain("review-kit");
    });
  });

  // T4：检查后出现安装按钮
  it("检查后显示安装按钮", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => INSPECT_RESPONSE });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><BundleInspector /></QueryClientProvider>);

    act(() => { fireEvent.change(screen.getByTestId("bundle-path-input"), { target: { value: "/tmp/x.rigbundle" } }); });
    act(() => { fireEvent.click(screen.getByTestId("inspect-btn")); });

    await waitFor(() => {
      expect(screen.getByTestId("install-btn")).toBeTruthy();
    });
  });

  // T6-AS-T14：v2 清单渲染智能体列表而非包列表
  it("v2 清单渲染智能体列表而非包列表", async () => {
    const v2Response = {
      manifest: {
        schemaVersion: 2,
        name: "pod-bundle",
        version: "0.2.0",
        rigSpec: "rig.yaml",
        agents: [
          { name: "impl-agent", version: "1.0.0", path: "agents/impl" },
          { name: "review-agent", version: "1.1.0", path: "agents/review" },
        ],
      },
      digestValid: true,
      integrityResult: { passed: true, mismatches: [], missing: [], extra: [], errors: [] },
    };
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => v2Response });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><BundleInspector /></QueryClientProvider>);

    act(() => { fireEvent.change(screen.getByTestId("bundle-path-input"), { target: { value: "/tmp/v2.rigbundle" } }); });
    act(() => { fireEvent.click(screen.getByTestId("inspect-btn")); });

    await waitFor(() => {
      // 应显示智能体而非包
      expect(screen.getByTestId("agent-list")).toBeTruthy();
      const entries = screen.getAllByTestId("agent-entry");
      expect(entries).toHaveLength(2);
      expect(entries[0]!.textContent).toContain("impl-agent");
      expect(entries[1]!.textContent).toContain("review-agent");
      // 不应显示包列表
      expect(screen.queryByTestId("package-list")).toBeNull();
      // 模式徽标应显示 v2
      expect(screen.getByTestId("schema-badge").textContent).toContain("v2");
    });
  });

  // 项 5 / slice-05 检查点 6.1 / 守卫 B1 修复：清单携带来源块时渲染它。
  // 判别条件：false && result.manifest.provenance 闸门必须使本测试失败。
  it("清单携带来源时渲染含全部字段的来源块", async () => {
    const responseWithProvenance = {
      manifest: {
        name: "with-prov",
        version: "0.1.0",
        rigSpec: "rig.yaml",
        packages: [{ name: "pkg", version: "1.0", path: "packages/pkg" }],
        provenance: {
          createdAt: "2026-05-18T12:00:00Z",
          sourceHost: "test-host.local",
          authorSession: "velocity-driver@openrig-velocity",
          sourceRigId: "01H000000000000000PROV001",
          sourceRigName: "openrig-velocity",
          daemonVersion: "0.3.2",
          cliVersion: "0.3.2",
          notes: "fixture for B1 repair",
        },
      },
      digestValid: true,
      integrityResult: { passed: true, mismatches: [], missing: [], extra: [], errors: [] },
    };
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => responseWithProvenance });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><BundleInspector /></QueryClientProvider>);

    act(() => { fireEvent.change(screen.getByTestId("bundle-path-input"), { target: { value: "/tmp/with-prov.rigbundle" } }); });
    act(() => { fireEvent.click(screen.getByTestId("inspect-btn")); });

    await waitFor(() => {
      expect(screen.getByTestId("provenance-block")).toBeTruthy();
      expect(screen.getByTestId("provenance-createdAt").textContent).toContain("2026-05-18T12:00:00Z");
      expect(screen.getByTestId("provenance-sourceHost").textContent).toContain("test-host.local");
      expect(screen.getByTestId("provenance-authorSession").textContent).toContain("velocity-driver@openrig-velocity");
      expect(screen.getByTestId("provenance-sourceRigName").textContent).toContain("openrig-velocity");
      expect(screen.getByTestId("provenance-sourceRigName").textContent).toContain("01H000000000000000PROV001");
      expect(screen.getByTestId("provenance-versions").textContent).toContain("后台服务 0.3.2");
      expect(screen.getByTestId("provenance-versions").textContent).toContain("CLI 0.3.2");
      expect(screen.getByTestId("provenance-notes").textContent).toContain("fixture for B1 repair");
    });
  });

  // 项 5 / slice-05 检查点 6.1 / 守卫 B1 修复：清单携带兼容性块时渲染它。
  // 判别条件：false && result.manifest.compatibility 闸门必须使本测试失败。
  it("清单携带兼容性时渲染含全部字段的兼容性块", async () => {
    const responseWithCompat = {
      manifest: {
        name: "with-compat",
        version: "0.1.0",
        rigSpec: "rig.yaml",
        packages: [{ name: "pkg", version: "1.0", path: "packages/pkg" }],
        compatibility: {
          minDaemonVersion: "0.3.2",
          minCliVersion: "0.3.2",
          schemaVersion: 1,
        },
      },
      digestValid: true,
      integrityResult: { passed: true, mismatches: [], missing: [], extra: [], errors: [] },
    };
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => responseWithCompat });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><BundleInspector /></QueryClientProvider>);

    act(() => { fireEvent.change(screen.getByTestId("bundle-path-input"), { target: { value: "/tmp/with-compat.rigbundle" } }); });
    act(() => { fireEvent.click(screen.getByTestId("inspect-btn")); });

    await waitFor(() => {
      expect(screen.getByTestId("compatibility-block")).toBeTruthy();
      expect(screen.getByTestId("compatibility-minDaemonVersion").textContent).toContain("0.3.2");
      expect(screen.getByTestId("compatibility-minCliVersion").textContent).toContain("0.3.2");
      expect(screen.getByTestId("compatibility-schemaVersion").textContent).toContain("v1");
    });
  });

  // 项 5 / slice-05 检查点 6.1 / 守卫 B1 修复：向后兼容——清单不带来源/兼容性
  // 块时不渲染这些段落。项 1/项 2 之前的旧包安装/检查行为不变。
  it("清单省略来源/兼容性块时不渲染它们（向后兼容）", async () => {
    // INSPECT_RESPONSE 无来源 + 无兼容性——直接复用它
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => INSPECT_RESPONSE });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><BundleInspector /></QueryClientProvider>);

    act(() => { fireEvent.change(screen.getByTestId("bundle-path-input"), { target: { value: "/tmp/bc.rigbundle" } }); });
    act(() => { fireEvent.click(screen.getByTestId("inspect-btn")); });

    await waitFor(() => {
      // 清单摘要仍渲染（回归基线）
      expect(screen.getByTestId("manifest-summary")).toBeTruthy();
    });
    // 新块绝不能出现
    expect(screen.queryByTestId("provenance-block")).toBeNull();
    expect(screen.queryByTestId("compatibility-block")).toBeNull();
  });

  // T6：错误态
  it("检查失败时显示错误", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network error"));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={qc}><BundleInspector /></QueryClientProvider>);

    act(() => { fireEvent.change(screen.getByTestId("bundle-path-input"), { target: { value: "/tmp/bad.rigbundle" } }); });
    act(() => { fireEvent.click(screen.getByTestId("inspect-btn")); });

    await waitFor(() => {
      expect(screen.getByTestId("inspect-error")).toBeTruthy();
    });
    // 中文诊断前缀 + 原错误内容完整保留（前缀仅为上下文，不替代 error.message）
    const inspectError = screen.getByTestId("inspect-error");
    expect(inspectError.textContent).toContain("检查失败：");
    expect(inspectError.textContent).toContain("network error");
  });
});

// T5：活动 feed 的 bundle.created 事件
describe("BundleInspector 活动 feed 事件", () => {
  function makeEvent(overrides: { type: string; payload?: Record<string, unknown> }): ActivityEvent {
    return { seq: 1, type: overrides.type, payload: { type: overrides.type, ...overrides.payload }, createdAt: new Date().toISOString(), receivedAt: Date.now() };
  }

  it("bundle.created 使用 bg-accent 颜色与正确摘要", () => {
    expect(eventColor("bundle.created")).toBe("bg-accent");
    const event = makeEvent({ type: "bundle.created", payload: { bundleName: "my-bundle", bundleVersion: "1.0.0" } });
    expect(eventSummary(event)).toContain("my-bundle");
    expect(eventSummary(event)).toContain("v1.0.0");
    expect(eventSummary(event)).toContain("已生成");
  });
});
