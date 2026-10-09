import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, act } from "@testing-library/react";
import { createAppTestRouter } from "./helpers/test-router.js";
import { BundleInstallFlow } from "../src/components/BundleInstallFlow.js";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderFlow() {
  return render(
    createAppTestRouter({
      routes: [
        { path: "/bundles/install", component: BundleInstallFlow },
        { path: "/rigs/$rigId", component: () => <div data-testid="rig-page">Rig</div> },
      ],
      initialPath: "/bundles/install",
    })
  );
}

describe("BundleInstallFlow", () => {
  it("renders inside the shared workspace page shell", async () => {
    renderFlow();

    await waitFor(() => {
      expect(screen.getByTestId("workspace-page")).toBeDefined();
      expect(screen.getByTestId("workspace-page-inner")).toBeDefined();
    });
  });

  // T10-AS-T14：resolve_spec detail.source === "pod_bundle" 时显示 "Pod-aware" 标签
  it("shows Pod-aware label when stage detail source is pod_bundle", async () => {
    // Plan mock
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        runId: "run-1",
        status: "planned",
        stages: [{ stage: "resolve_spec", status: "ok", detail: { source: "pod_bundle" } }],
        errors: [],
      }),
    });

    renderFlow();
    await waitFor(() => expect(screen.getByTestId("bundle-install-flow")).toBeTruthy());

    act(() => {
      fireEvent.change(screen.getByTestId("bundle-input"), { target: { value: "/tmp/pod.rigbundle" } });
      fireEvent.change(screen.getByTestId("target-input"), { target: { value: "/tmp/target" } });
    });

    act(() => { fireEvent.click(screen.getByTestId("plan-btn")); });
    await waitFor(() => expect(screen.getByTestId("step-planned")).toBeTruthy());

    // 应用带 pod_bundle 源的 mock
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 201,
      json: async () => ({
        runId: "run-2",
        status: "completed",
        rigId: "rig-abc",
        stages: [
          { stage: "resolve_spec", status: "ok", detail: { source: "pod_bundle" } },
          { stage: "instantiate", status: "ok" },
        ],
        errors: [],
      }),
    });

    act(() => { fireEvent.click(screen.getByTestId("apply-btn")); });
    await waitFor(() => expect(screen.getByTestId("step-done")).toBeTruthy());

    const label = screen.getByTestId("bundle-type-label");
    expect(label.textContent).toContain("支持 Pod 的安装包");
  });

  // 无 pod_bundle 源时显示 "Legacy bundle" 标签
  it("shows Legacy label when no pod_bundle source", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        runId: "run-1",
        status: "planned",
        stages: [{ stage: "resolve_spec", status: "ok" }],
        errors: [],
      }),
    });

    renderFlow();
    await waitFor(() => expect(screen.getByTestId("bundle-install-flow")).toBeTruthy());

    act(() => {
      fireEvent.change(screen.getByTestId("bundle-input"), { target: { value: "/tmp/legacy.rigbundle" } });
      fireEvent.change(screen.getByTestId("target-input"), { target: { value: "/tmp/target" } });
    });

    act(() => { fireEvent.click(screen.getByTestId("plan-btn")); });
    await waitFor(() => expect(screen.getByTestId("step-planned")).toBeTruthy());

    fetchMock.mockResolvedValueOnce({
      ok: true, status: 201,
      json: async () => ({
        runId: "run-2",
        status: "completed",
        rigId: "rig-legacy",
        stages: [{ stage: "resolve_spec", status: "ok" }, { stage: "instantiate", status: "ok" }],
        errors: [],
      }),
    });

    act(() => { fireEvent.click(screen.getByTestId("apply-btn")); });
    await waitFor(() => expect(screen.getByTestId("step-done")).toBeTruthy());

    const label = screen.getByTestId("bundle-type-label");
    expect(label.textContent).toContain("旧版安装包");
  });
});
