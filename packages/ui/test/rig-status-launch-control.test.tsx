import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { RigStatusCard } from "../src/components/RigStatusCard.js";
import { RigStatusControl } from "../src/components/RigStatusControl.js";
import { LaunchRecoveryModal } from "../src/components/LaunchRecoveryModal.js";
import { KernelStatusCard } from "../src/components/KernelStatusCard.js";
import { useStartRig, useLaunchRig } from "../src/hooks/mutations.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

function wrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function renderWithClient(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body });
}

// 混合 restore-original plan：2 resumable + 1 missing-token
//（awaiting-decision）+ 1 stale-token resumable——故 LOCK + honesty +
// stale-vs-missing 均可证明。
const MIXED_PLAN = {
  status: "plan",
  mode: "restore",
  rigId: "rig1",
  rigName: "openrig-delivery",
  snapshot: null,
  wouldCaptureCurrentState: true,
  mutated: false,
  nodes: [
    { logicalId: "orch.advisor", intendedAction: "resume-original", tokenState: "present", freshRequired: false },
    { logicalId: "dev2.driver", intendedAction: "resume-original", tokenState: "stale", freshRequired: false },
    { logicalId: "dev1.guard", intendedAction: "awaiting-decision", tokenState: "missing", freshRequired: true, reason: "no token recorded" },
  ],
};

const ALL_FRESH_PLAN = {
  ...MIXED_PLAN,
  nodes: MIXED_PLAN.nodes.map((n) => ({ ...n, intendedAction: "fresh-primed" })),
};

describe("RigStatusCard — consumes the backend verdict in the render (19/21 lesson)", () => {
  afterEach(cleanup);

  it("renders a non-green verdict for a blocked rig (does not default to green)", () => {
    renderWithClient(
      <RigStatusCard
        rigId="rig1"
        rigName="openrig-delivery"
        status="blocked"
        seatsRunning={0}
        seatsTotal={5}
        recoverable={false}
        src={["ps: 0/5 running · lifecycle=recoverable", "restore-check: blocked"]}
        primaryLabel="Resolve & restore ▸"
      />,
    );
    const card = screen.getByTestId("rig-status-card-rig1");
    expect(card.getAttribute("data-status")).toBe("blocked");
    const badge = screen.getByTestId("rig-status-badge-rig1");
    expect(badge.textContent).toContain("已阻塞");
    // verdict 色调是 tertiary（error）色调，绝非 success/green 色调。
    expect(badge.className).toContain("text-tertiary");
    expect(badge.className).not.toContain("text-success");
    // 组合 provenance 可见。
    expect(screen.getByTestId("rig-status-src-rig1").textContent).toContain("restore-check: blocked");
  });

  it("an up rig disables the primary and shows RUNNING", () => {
    renderWithClient(
      <RigStatusCard
        rigId="rig1"
        rigName="r1"
        status="up"
        seatsRunning={3}
        seatsTotal={3}
        recoverable={false}
        src={["ps: 3/3 running · lifecycle=running"]}
        primaryLabel="Restore / launch ▸"
      />,
    );
    const primary = screen.getByTestId("rig-primary-action-rig1") as HTMLButtonElement;
    expect(primary.disabled).toBe(true);
    expect(primary.textContent).toContain("运行中");
  });
});

// OPR.0.4.7.1——topology 控件是一个 COMPACT badge + 按钮，打开
// launch/recovery modal；巨大 inline card（在 /topology/rig/* 被 explorer
// overlay 遮挡）从此表面消失。RigStatusCard 本身不变（dashboard kernel card
// 仍用它——上文已覆盖）。
describe("RigStatusControl — compact modal-launch button (no inline card)", () => {
  beforeEach(() => mockFetch.mockReset());
  afterEach(cleanup);

  const RIG_STATUS_UP = {
    rigId: "r9",
    rigName: "demo",
    isKernel: false,
    status: "up",
    seatsTotal: 7,
    seatsRunning: 7,
    recoverable: false,
    perSeat: [],
    src: ["ps: 7/7 running · lifecycle=running"],
  };

  function routeFetch(status: unknown) {
    mockFetch.mockImplementation((url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/launch-plan")) return jsonResponse(MIXED_PLAN);
      if (u.includes("/status")) return jsonResponse(status);
      if (u.endsWith("/up") && init?.method === "POST") return jsonResponse({ status: "restored" });
      return jsonResponse({});
    });
  }

  it("renders compact (no rig-status-card) with the verdict badge + seats + primary button", async () => {
    routeFetch({ ...RIG_STATUS_UP, status: "partial", seatsRunning: 5 });
    renderWithClient(<RigStatusControl rigId="r9" rigName="demo" />);

    await waitFor(() => expect(screen.getByTestId("rig-primary-action-r9")).toBeTruthy());
    // compact 契约：巨大 card 从此表面消失。
    expect(screen.queryByTestId("rig-status-card-r9")).toBeNull();
    const control = screen.getByTestId("rig-status-control-r9");
    expect(control.getAttribute("data-status")).toBe("partial");
    expect(screen.getByTestId("rig-status-badge-r9").textContent).toContain("partial");
    expect(screen.getByTestId("seats-r9").textContent).toBe("5/7");
  });

  it("clicking the primary action opens LaunchRecoveryModal (plan-before-mutation fetch fires)", async () => {
    routeFetch({ ...RIG_STATUS_UP, status: "down", seatsRunning: 0, recoverable: true });
    renderWithClient(<RigStatusControl rigId="r9" rigName="demo" />);

    await waitFor(() => expect(screen.getByTestId("rig-primary-action-r9")).toBeTruthy());
    fireEvent.click(screen.getByTestId("rig-primary-action-r9"));

    await waitFor(() => expect(screen.getByTestId("launch-recovery-modal")).toBeTruthy());
    const planCalls = mockFetch.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/launch-plan"));
    expect(planCalls.length).toBeGreaterThan(0);
  });

  it("stays a live button when status is up (opens the read-only modal, never a disabled RUNNING)", async () => {
    routeFetch(RIG_STATUS_UP);
    renderWithClient(<RigStatusControl rigId="r9" rigName="demo" />);

    await waitFor(() => expect(screen.getByTestId("rig-primary-action-r9")).toBeTruthy());
    const primary = screen.getByTestId("rig-primary-action-r9") as HTMLButtonElement;
    expect(primary.disabled).toBe(false);
    fireEvent.click(primary);
    await waitFor(() => expect(screen.getByTestId("launch-recovery-modal")).toBeTruthy());
  });
});

describe("LaunchRecoveryModal — plan-before-mutation + the LOCK + honesty", () => {
  beforeEach(() => mockFetch.mockReset());
  afterEach(cleanup);

  it("fetches the read-only plan on open; resumable seats stay resume-original while a missing-token seat is awaiting-decision + BLOCKS restore-original", async () => {
    mockFetch.mockImplementation((rawUrl?: unknown) => {
      const url = typeof rawUrl === "string" ? rawUrl : String((rawUrl as { url?: string })?.url ?? "");
      if (url.includes("/launch-plan")) return jsonResponse(MIXED_PLAN);
      return jsonResponse({});
    });

    renderWithClient(<LaunchRecoveryModal rigId="rig1" rigName="openrig-delivery" open onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByTestId("launch-plan-table")).toBeTruthy());

    // 先 plan 后 action：fetch 命中只读 launch-plan 路由。
    expect(mockFetch.mock.calls.some((c) => String(c[0]).includes("/launch-plan"))).toBe(true);

    // LOCK：resumable seats 保持 resume-original（不重绘为 fresh）。
    expect(screen.getByTestId("plan-verdict-orch.advisor").textContent).toContain("resume-original");
    expect(screen.getByTestId("plan-verdict-dev2.driver").textContent).toContain("resume-original");
    // missing-token seat 是 awaiting-decision（非 fresh）。
    expect(screen.getByTestId("plan-verdict-dev1.guard").textContent).toContain("awaiting-decision");
    expect(screen.getByTestId("plan-verdict-dev1.guard").textContent).not.toContain("fresh");

    // stale token 与 missing 有别（FR-6）。
    expect(screen.getByTestId("plan-token-dev2.driver").textContent).toContain("stale");
    expect(screen.getByTestId("plan-token-dev1.guard").textContent).toContain("missing");

    // restore-original 被阻塞（honesty 契约）——primary 禁用。
    expect(screen.getByTestId("launch-blocked-banner")).toBeTruthy();
    const execute = screen.getByTestId("launch-execute") as HTMLButtonElement;
    expect(execute.disabled).toBe(true);
    expect(execute.textContent).toContain("请先解决阻塞项再恢复");

    // preview 期间未发 restore mutation（只读）。
    expect(mockFetch.mock.calls.some((c) => String(c[0]).endsWith("/up"))).toBe(false);
  });

  it("choosing fresh re-fetches the forecast, labels it identity-changing, enables execute, and posts freshLogicalIds to /up", async () => {
    mockFetch.mockImplementation((rawUrl?: unknown, init?: RequestInit) => {
      const url = typeof rawUrl === "string" ? rawUrl : String((rawUrl as { url?: string })?.url ?? "");
      if (url.includes("/launch-plan")) {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        return jsonResponse(body.freshLogicalIds ? ALL_FRESH_PLAN : MIXED_PLAN);
      }
      if (url.endsWith("/up")) return jsonResponse({ status: "restored" });
      return jsonResponse({});
    });

    renderWithClient(<LaunchRecoveryModal rigId="rig1" rigName="openrig-delivery" open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("launch-plan-table")).toBeTruthy());

    // 切到 fresh policy（显式、带标签的 identity 变更选择）。
    fireEvent.click(screen.getByTestId("launch-policy-fresh"));

    await waitFor(() => {
      const execute = screen.getByTestId("launch-execute") as HTMLButtonElement;
      expect(execute.disabled).toBe(false);
      expect(execute.textContent).toContain("为所有席位全新启动");
    });

    // Execute -> 以 per-seat freshLogicalIds POST 到 /up（绝非全局翻转）。
    fireEvent.click(screen.getByTestId("launch-execute"));
    await waitFor(() => {
      const upCall = mockFetch.mock.calls.find((c) => String(c[0]).endsWith("/up"));
      expect(upCall).toBeTruthy();
      const body = JSON.parse((upCall![1] as RequestInit).body as string);
      expect(body.freshLogicalIds).toEqual(["orch.advisor", "dev2.driver", "dev1.guard"]);
    });
  });
});

describe("KernelStatusCard — kernel-status not /healthz; consumes the kernel verdict", () => {
  beforeEach(() => mockFetch.mockReset());
  afterEach(cleanup);

  it("reads /api/kernel/status, renders a down kernel non-green, and NEVER calls /healthz", async () => {
    mockFetch.mockImplementation((rawUrl?: unknown) => {
      const url = typeof rawUrl === "string" ? rawUrl : String((rawUrl as { url?: string })?.url ?? "");
      if (url.includes("/api/kernel/status")) {
        return jsonResponse({
          kernel_state: "auth_blocked",
          agents: [{ session_name: "advisor.lead@kernel", runtime: "claude-code", startup_status: "pending" }],
          first_unready_since: null,
          variant: "rig.yaml",
          detail: "both runtimes unauthenticated",
        });
      }
      if (url.includes("/api/rigs/summary")) {
        return jsonResponse([{ id: "rig_kernel", name: "kernel", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }]);
      }
      return jsonResponse({});
    });

    renderWithClient(<KernelStatusCard />);

    await waitFor(() => {
      const card = screen.getByTestId("kernel-status-card");
      expect(card.getAttribute("data-status")).toBe("blocked");
    });
    // verdict 已渲染（非 green），source 引用 kernel_state（非 /healthz）。
    expect(screen.getByTestId("rig-status-src-rig_kernel").textContent).toContain("kernel-status.kernel_state=auth_blocked");
    // 绝不从 daemon /healthz 推断。
    expect(mockFetch.mock.calls.some((c) => String(c[0]).includes("/healthz"))).toBe(false);
  });

  it("a 503 (tracker unavailable) renders unknown, never green", async () => {
    mockFetch.mockImplementation((rawUrl?: unknown) => {
      const url = typeof rawUrl === "string" ? rawUrl : String((rawUrl as { url?: string })?.url ?? "");
      if (url.includes("/api/kernel/status")) {
        return jsonResponse({ error: "kernel_boot_tracker_unavailable", message: "not wired" }, 503);
      }
      if (url.includes("/api/rigs/summary")) return jsonResponse([]);
      return jsonResponse({});
    });

    renderWithClient(<KernelStatusCard />);
    await waitFor(() => {
      const card = screen.getByTestId("kernel-status-card");
      expect(card.getAttribute("data-status")).toBe("unknown");
    });
  });
});

describe("mutations — no useStartRig regression; useLaunchRig carries policy", () => {
  beforeEach(() => mockFetch.mockReset());

  it("useStartRig still POSTs a BODYLESS /up (default restore behavior unchanged)", async () => {
    mockFetch.mockImplementation(() => jsonResponse({ status: "restored" }));
    const { result } = renderHook(() => useStartRig("rig1"), { wrapper: wrapper() });
    await act(async () => {
      await result.current.mutateAsync();
    });
    const upCall = mockFetch.mock.calls.find((c) => String(c[0]).endsWith("/up"));
    expect(upCall).toBeTruthy();
    const init = (upCall![1] ?? {}) as RequestInit;
    expect(init.method).toBe("POST");
    // 回归守卫：useStartRig 不发 body。
    expect(init.body).toBeUndefined();
  });

  it("useLaunchRig POSTs /up WITH freshLogicalIds (the policy-carrying path, distinct from useStartRig)", async () => {
    mockFetch.mockImplementation(() => jsonResponse({ status: "restored" }));
    const { result } = renderHook(() => useLaunchRig("rig1"), { wrapper: wrapper() });
    await act(async () => {
      await result.current.mutateAsync(["a", "b"]);
    });
    const upCall = mockFetch.mock.calls.find((c) => String(c[0]).endsWith("/up"));
    expect(upCall).toBeTruthy();
    const init = (upCall![1] ?? {}) as RequestInit;
    expect(JSON.parse(init.body as string).freshLogicalIds).toEqual(["a", "b"]);
  });
});
