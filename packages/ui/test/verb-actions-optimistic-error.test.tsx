// 0.3.1 demo-bug 修复验证：VerbActions 乐观 outcome + 内联错误表面。
//
// Founder VM walk 回归：在 queue-item 卡片点 Route 静默回退——成功无确认，
// 失败无错误。修复拆分 onSuccess/onError；onSuccess 触发 onOptimisticOutcome
//（parent 即时渲染 ActionOutcomePanel），onError 显示内联错误块，
// 同时保留所选 verb。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VerbActions } from "../src/components/mission-control/components/VerbActions.js";
import type { FeedActionOutcome } from "../src/components/for-you/FeedCard.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderVerbActions(props: Parameters<typeof VerbActions>[0]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <VerbActions {...props} />
    </QueryClientProvider>,
  );
}

describe("VerbActions — optimistic outcome (demo-bug fix #1)", () => {
  beforeEach(() => {
    // stub /api/mission-control/destinations + action endpoint。
    // Approve 不需要 destinations，故 destination 拉取
    // 仅由下面 Route 测试行使。
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/api/mission-control/destinations")) {
          return new Response(
            JSON.stringify({ destinations: [{ sessionName: "orch-lead@rig", label: "orch-lead" }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("/api/mission-control/action")) {
          const input = JSON.parse(String(init?.body ?? "{}"));
          return new Response(
            JSON.stringify({
              actionId: "act-1",
              verb: input.verb,
              qitemId: input.qitemId,
              closedQitem: null,
              createdQitemId: null,
              notifyAttempted: false,
              notifyResult: null,
              auditedAt: "2026-05-15T04:35:00.000Z",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );
  });

  it("fires onOptimisticOutcome on Approve success with the correct shape", async () => {
    const onOptimisticOutcome = vi.fn();
    const { getByTestId } = renderVerbActions({
      qitemId: "qitem-abc",
      actorSession: "human@host",
      onOptimisticOutcome,
    });

    fireEvent.click(getByTestId("mc-verb-approve"));
    fireEvent.click(getByTestId("mc-verb-submit"));

    await waitFor(() => expect(onOptimisticOutcome).toHaveBeenCalledTimes(1));
    const outcome = onOptimisticOutcome.mock.calls[0]![0] as FeedActionOutcome;
    expect(outcome.verb).toBe("approve");
    expect(outcome.actorSession).toBe("human@host");
    expect(outcome.destinationSession).toBeNull();
    expect(outcome.reason).toBeNull();
    expect(typeof outcome.actedAt).toBe("string");
    expect(outcome.actedAt.length).toBeGreaterThan(0);
  });

  it("fires onOptimisticOutcome on Route success with destinationSession populated", async () => {
    const onOptimisticOutcome = vi.fn();
    // 覆盖 destinations 拉取返回空列表，使组件落入手动输入模式
    //（在 jsdom 中比受控 <select> 易驱动得多）。
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes("/api/mission-control/destinations")) {
          return new Response(JSON.stringify({ destinations: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("/api/mission-control/action")) {
          const input = JSON.parse(String(init?.body ?? "{}"));
          return new Response(
            JSON.stringify({
              actionId: "act-2",
              verb: input.verb,
              qitemId: input.qitemId,
              closedQitem: null,
              createdQitemId: null,
              notifyAttempted: false,
              notifyResult: null,
              auditedAt: "2026-05-15T04:35:00.000Z",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const { getByTestId } = renderVerbActions({
      qitemId: "qitem-xyz",
      actorSession: "human@host",
      onOptimisticOutcome,
    });

    fireEvent.click(getByTestId("mc-verb-route"));
    const input = (await waitFor(() => getByTestId("mc-verb-destination-input"))) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "orch-lead@rig" } });
    fireEvent.click(getByTestId("mc-verb-submit"));

    await waitFor(() => expect(onOptimisticOutcome).toHaveBeenCalledTimes(1));
    const outcome = onOptimisticOutcome.mock.calls[0]![0] as FeedActionOutcome;
    expect(outcome.verb).toBe("route");
    expect(outcome.destinationSession).toBe("orch-lead@rig");
  });

  it("resets selection after a successful mutation", async () => {
    const onOptimisticOutcome = vi.fn();
    const { getByTestId, queryByTestId } = renderVerbActions({
      qitemId: "qitem-q1",
      actorSession: "human@host",
      onOptimisticOutcome,
    });
    fireEvent.click(getByTestId("mc-verb-approve"));
    fireEvent.click(getByTestId("mc-verb-submit"));
    await waitFor(() => expect(onOptimisticOutcome).toHaveBeenCalled());
    // 成功后，verb-detail 面板（Cancel/Confirm 行）消失。
    expect(queryByTestId("mc-verb-submit")).toBeNull();
    expect(queryByTestId("mc-verb-error")).toBeNull();
  });
});

describe("VerbActions — inline error surface (demo-bug fix #2)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/mission-control/destinations")) {
          return new Response(
            JSON.stringify({ destinations: [{ sessionName: "ghost@nowhere", label: "ghost" }] }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.includes("/api/mission-control/action")) {
          return new Response(
            JSON.stringify({ error: "destination_unreachable", message: "ghost@nowhere is not bound" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );
  });

  it("renders mc-verb-error with the server error message on failure", async () => {
    const onOptimisticOutcome = vi.fn();
    const { getByTestId } = renderVerbActions({
      qitemId: "qitem-fail",
      actorSession: "human@host",
      onOptimisticOutcome,
    });

    fireEvent.click(getByTestId("mc-verb-approve"));
    fireEvent.click(getByTestId("mc-verb-submit"));

    await waitFor(() => getByTestId("mc-verb-error"));
    const err = getByTestId("mc-verb-error");
    expect(err.textContent).toContain("ghost@nowhere is not bound");
    expect(err.getAttribute("role")).toBe("alert");
    expect(onOptimisticOutcome).not.toHaveBeenCalled();
  });

  it("does NOT reset the verb selection on error (silent-revert regression guard)", async () => {
    const { getByTestId, queryByTestId } = renderVerbActions({
      qitemId: "qitem-fail-2",
      actorSession: "human@host",
    });

    fireEvent.click(getByTestId("mc-verb-approve"));
    fireEvent.click(getByTestId("mc-verb-submit"));

    await waitFor(() => getByTestId("mc-verb-error"));
    // Confirm/Cancel 行仍在——选择存活。
    expect(queryByTestId("mc-verb-submit")).not.toBeNull();
    expect(queryByTestId("mc-verb-cancel")).not.toBeNull();
  });

  it("clears the error message when the operator picks a different verb", async () => {
    const { getByTestId, queryByTestId } = renderVerbActions({
      qitemId: "qitem-fail-3",
      actorSession: "human@host",
    });
    fireEvent.click(getByTestId("mc-verb-approve"));
    fireEvent.click(getByTestId("mc-verb-submit"));
    await waitFor(() => getByTestId("mc-verb-error"));
    fireEvent.click(getByTestId("mc-verb-deny"));
    expect(queryByTestId("mc-verb-error")).toBeNull();
  });

  it("clears the error message when Cancel is clicked", async () => {
    const { getByTestId, queryByTestId } = renderVerbActions({
      qitemId: "qitem-fail-4",
      actorSession: "human@host",
    });
    fireEvent.click(getByTestId("mc-verb-approve"));
    fireEvent.click(getByTestId("mc-verb-submit"));
    await waitFor(() => getByTestId("mc-verb-error"));
    fireEvent.click(getByTestId("mc-verb-cancel"));
    expect(queryByTestId("mc-verb-error")).toBeNull();
  });
});
