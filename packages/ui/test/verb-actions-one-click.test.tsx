// OPR.0.3.3.20——一键批准（AC-2/AC-3，仅 approve）。
//
// 单击“批准”即记录 verb=approve，不经过选择+确认步骤，并触发现有乐观即时回执。
// route/deny 仍走受控的选择+确认流程；需要输入的动词没有一键路径，这是结构守卫。
// 错误保留路径（不静默重置）同样覆盖一键路径。操作驱动：点击即触发变更，整条路径没有定时器。

import { describe, it, expect, vi, afterEach } from "vitest";
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

function stubActionFetch(opts?: { failAction?: boolean }) {
  const actionCalls: Array<Record<string, unknown>> = [];
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
        const input = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        actionCalls.push(input);
        if (opts?.failAction) {
          return new Response(
            JSON.stringify({ error: "act_failed", message: "approve refused by daemon" }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            actionId: "act-1",
            verb: input.verb,
            qitemId: input.qitemId,
            closedQitem: null,
            createdQitemId: null,
            notifyAttempted: false,
            notifyResult: null,
            auditedAt: "2026-06-11T00:00:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }),
  );
  return actionCalls;
}

describe("VerbActions — one-click approve (OPR.0.3.3.20)", () => {
  it("a single click on Approve records verb=approve with NO select+confirm step and fires the instant receipt", async () => {
    const actionCalls = stubActionFetch();
    const onOptimisticOutcome = vi.fn();
    const { getByTestId, queryByTestId } = renderVerbActions({
      qitemId: "qitem-one-click",
      actorSession: "human@host",
      enabledVerbs: ["approve", "deny", "route"],
      oneClickVerbs: ["approve"],
      onOptimisticOutcome,
    });

    fireEvent.click(getByTestId("mc-verb-approve"));

    // 未出现选择步骤，因此确认行从未渲染。
    expect(queryByTestId("mc-verb-submit")).toBeNull();

    await waitFor(() => expect(onOptimisticOutcome).toHaveBeenCalledTimes(1));
    const outcome = onOptimisticOutcome.mock.calls[0]![0] as FeedActionOutcome;
    expect(outcome.verb).toBe("approve");
    expect(actionCalls).toHaveLength(1);
    expect(actionCalls[0]!.verb).toBe("approve");
    expect(actionCalls[0]!.qitemId).toBe("qitem-one-click");
  });

  it("route and deny keep the controlled select+confirm flow (no one-click path)", async () => {
    const actionCalls = stubActionFetch();
    const { getByTestId, queryByTestId } = renderVerbActions({
      qitemId: "qitem-controlled",
      actorSession: "human@host",
      enabledVerbs: ["approve", "deny", "route"],
      oneClickVerbs: ["approve"],
    });

    // 点击 deny 只会选中它并显示确认行，不触发操作。
    fireEvent.click(getByTestId("mc-verb-deny"));
    expect(queryByTestId("mc-verb-submit")).not.toBeNull();
    expect(actionCalls).toHaveLength(0);

    // 点击 route 同样只会选中；它需要目标，因此不会触发操作。
    fireEvent.click(getByTestId("mc-verb-route"));
    expect(queryByTestId("mc-verb-submit")).not.toBeNull();
    expect(actionCalls).toHaveLength(0);
  });

  it("ALLOWLIST GUARD: route forced into oneClickVerbs is NOT one-clicked (runtime refusal)", async () => {
    const actionCalls = stubActionFetch();
    const { getByTestId, queryByTestId } = renderVerbActions({
      qitemId: "qitem-guard",
      actorSession: "human@host",
      enabledVerbs: ["approve", "deny", "route"],
      // 故意误用：属性类型只允许 approve，因此误用必须强制转换，运行时白名单仍必须拒绝它。
      oneClickVerbs: ["route"] as unknown as Parameters<typeof VerbActions>[0]["oneClickVerbs"],
    });

    fireEvent.click(getByTestId("mc-verb-route"));

    // 回退到受控流程：已选中，但未触发。
    expect(queryByTestId("mc-verb-submit")).not.toBeNull();
    expect(actionCalls).toHaveLength(0);
  });

  it("ALLOWLIST GUARD: deny forced into oneClickVerbs is NOT one-clicked (input-free is not sufficient)", async () => {
    const actionCalls = stubActionFetch();
    const { getByTestId, queryByTestId } = renderVerbActions({
      qitemId: "qitem-guard-deny",
      actorSession: "human@host",
      enabledVerbs: ["approve", "deny", "route"],
      // deny 不需要输入；必须由仅允许 approve 的白名单拒绝它，而非输入规则
      //（PRD 范围 + S 节：仅 approve）。
      oneClickVerbs: ["deny"] as unknown as Parameters<typeof VerbActions>[0]["oneClickVerbs"],
    });

    fireEvent.click(getByTestId("mc-verb-deny"));

    // 已出现受控选择+确认流程，但没有发出操作调用。
    expect(queryByTestId("mc-verb-submit")).not.toBeNull();
    expect(actionCalls).toHaveLength(0);
  });

  it("without oneClickVerbs, Approve keeps the existing select+confirm behavior", async () => {
    const actionCalls = stubActionFetch();
    const { getByTestId, queryByTestId } = renderVerbActions({
      qitemId: "qitem-legacy",
      actorSession: "human@host",
      enabledVerbs: ["approve", "deny", "route"],
    });

    fireEvent.click(getByTestId("mc-verb-approve"));
    expect(actionCalls).toHaveLength(0);
    expect(queryByTestId("mc-verb-submit")).not.toBeNull();
  });

  it("one-click approve error is HELD inline (no silent reset) — AC-3 on the new path", async () => {
    stubActionFetch({ failAction: true });
    const onOptimisticOutcome = vi.fn();
    const { getByTestId } = renderVerbActions({
      qitemId: "qitem-one-click-fail",
      actorSession: "human@host",
      enabledVerbs: ["approve", "deny", "route"],
      oneClickVerbs: ["approve"],
      onOptimisticOutcome,
    });

    fireEvent.click(getByTestId("mc-verb-approve"));

    await waitFor(() => getByTestId("mc-verb-error"));
    expect(getByTestId("mc-verb-error").textContent).toContain("approve refused by daemon");
    expect(onOptimisticOutcome).not.toHaveBeenCalled();
    // 动词按钮仍存在且可用，没有任何内容被静默重置。
    expect(getByTestId("mc-verb-approve")).not.toBeNull();
  });
});
