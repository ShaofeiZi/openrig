// @vitest-environment jsdom

// CORRECTIVE §7.1 + founder N-1（2026-07-05）——For-You 快捷操作
// 仅两个按钮：APPROVE（一键，同 verb 写路径）和 CHAT
//（共享 terminal，BR-12——绝非 chat panel）。表面任何处都无 deny、
// 无 route、无 "Choose response" / "Your turn" chrome。
//
// `bare` prop 契约上仅 JSX 用：mutation 请求在 bare 与带 chrome 间
// 必须字节相同（guard 的 write-path-identity cell）。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { readFileSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { VerbActions } from "../src/components/mission-control/components/VerbActions.js";
import { buildChatPreamble } from "../src/components/review/chat.js";
import type { FeedCard as FeedCardModel } from "../src/lib/feed-classifier.js";

// 共享 terminal 被 mock 为 marker，使 DOM 测试证明 CHAT
// 表面是 ProgressiveTerminal（BR-12），而不在 jsdom 启动 xterm。
const terminalMounts: Array<{ sessionName: string; initialText?: string }> = [];
vi.mock("../src/components/terminal/ProgressiveTerminal.js", () => ({
  ProgressiveTerminal: (props: { sessionName: string; initialText?: string }) => {
    terminalMounts.push({ sessionName: props.sessionName, initialText: props.initialText });
    return <div data-testid="shared-progressive-terminal" />;
  },
}));

import { FeedCard } from "../src/components/for-you/FeedCard.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  terminalMounts.length = 0;
});

function withQuery(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

/** 捕获 RAW 请求体，使字节级身份可证。 */
function stubActionFetch() {
  const raw: Array<{ url: string; method: string; body: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/mission-control/action")) {
        raw.push({ url: String(url), method: String(init?.method ?? "GET"), body: String(init?.body ?? "") });
        return new Response(
          JSON.stringify({ actionId: "a-1", verb: "approve", qitemId: "q-1", closedQitem: null, createdQitemId: null, notifyAttempted: false, notifyResult: null, auditedAt: "t" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ destinations: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
  return raw;
}

function renderVerbActions(props: Parameters<typeof VerbActions>[0]) {
  return withQuery(<VerbActions {...props} />);
}

describe("VerbActions `bare` — write-path identity (JSX-only chrome skip)", () => {
  async function approveAndCapture(bare: boolean) {
    const raw = stubActionFetch();
    const view = renderVerbActions({
      qitemId: "q-identity",
      actorSession: "human@host",
      enabledVerbs: ["approve"],
      oneClickVerbs: ["approve"],
      ...(bare ? { bare: true } : {}),
    });
    fireEvent.click(view.getByTestId("mc-verb-approve"));
    await waitFor(() => expect(raw).toHaveLength(1));
    const call = raw[0]!;
    cleanup();
    vi.unstubAllGlobals();
    return call;
  }

  it("the mutation request is BYTE-IDENTICAL bare vs chromed (url + method + body)", async () => {
    const chromed = await approveAndCapture(false);
    const bare = await approveAndCapture(true);
    expect(bare.url).toBe(chromed.url);
    expect(bare.method).toBe(chromed.method);
    expect(bare.body).toBe(chromed.body); // byte-identical — `bare` touches JSX only
  });

  it("bare renders ONLY the verb button — no 'Choose response' chrome; chromed keeps it", () => {
    stubActionFetch();
    const chromed = renderVerbActions({ qitemId: "q-a", actorSession: "h@h", enabledVerbs: ["approve"], oneClickVerbs: ["approve"] });
    expect(chromed.queryByText("选择响应")).not.toBeNull();
    cleanup();
    const bare = renderVerbActions({ qitemId: "q-b", actorSession: "h@h", enabledVerbs: ["approve"], oneClickVerbs: ["approve"], bare: true });
    expect(bare.queryByText("选择响应")).toBeNull();
    expect(bare.getByTestId("mc-verb-approve")).toBeTruthy();
  });
});

describe("For-You quick actions — bare APPROVE + CHAT only (N-1, BR-12)", () => {
  function actionCard(): FeedCardModel {
    return {
      id: "queue.enqueued-7",
      kind: "action-required",
      title: "Approve the cut",
      body: "needs your call",
      receivedAt: 1234567890,
      createdAt: new Date(1234567890 * 1000).toISOString(),
      source: {
        seq: 7,
        type: "queue.enqueued",
        payload: { qitem_id: "q-chat-1", source_session: "dev-owner@rig" },
      } as unknown as FeedCardModel["source"],
    } as FeedCardModel;
  }

  it("renders exactly two actions — one-click APPROVE + one CHAT button; zero deny/route; zero chrome prose", () => {
    stubActionFetch();
    const view = withQuery(<FeedCard card={actionCard()} />);
    // APPROVE：同一个 VerbActions verb 按钮，bare。
    expect(view.getByTestId("mc-verb-approve")).toBeTruthy();
    // CHAT：恰好一个。
    expect(view.getByTestId("feed-card-chat-queue.enqueued-7")).toBeTruthy();
    // 退役 verb 已从表面消失。
    expect(view.queryByTestId("mc-verb-deny")).toBeNull();
    expect(view.queryByTestId("mc-verb-route")).toBeNull();
    // 两层 chrome 均移除（founder N-1）：card 散文和
    // VerbActions header。Guard fixback 2026-07-06：CARD 级 kind 标签
    // 是状态标签（kind 的规范名），绝非 "Your turn"。
    expect(view.queryByText("Choose response")).toBeNull();
    expect(view.queryByText("Your turn")).toBeNull();
    expect(view.getByText("需要处理")).toBeTruthy();
    // rev1-r2 B1：捕获退役 schema copy 的两种措辞。
    expect(view.queryByText(/approve,\s*deny,?\s*(?:and|or)\s*route/i)).toBeNull();
  });

  it("CHAT opens the SHARED ProgressiveTerminal seeded with the pinned preamble (BR-12: terminal, never a chat panel)", async () => {
    stubActionFetch();
    const view = withQuery(<FeedCard card={actionCard()} />);
    expect(view.queryByTestId("shared-progressive-terminal")).toBeNull();

    fireEvent.click(view.getByTestId("feed-card-chat-queue.enqueued-7"));
    await waitFor(() => expect(view.getByTestId("shared-progressive-terminal")).toBeTruthy());

    // Human-action 卡片与 SENDER（所属 agent）聊天。
    expect(terminalMounts).toHaveLength(1);
    expect(terminalMounts[0]).toEqual({
      sessionName: "dev-owner@rig",
      initialText: buildChatPreamble({ sessionName: "dev-owner@rig", itemRef: "q-chat-1" }),
    });

    // BR-12 死组件墙：无 chat panel、无 compose box、无气泡。
    expect(document.querySelector("textarea")).toBeNull();
    expect(screen.queryByPlaceholderText(/message/i)).toBeNull();
  });

  it("approving from the card fires the SAME mutation body as the chromed path (end-to-end identity)", async () => {
    const raw = stubActionFetch();
    const view = withQuery(<FeedCard card={actionCard()} />);
    fireEvent.click(view.getByTestId("mc-verb-approve"));
    await waitFor(() => expect(raw).toHaveLength(1));
    const body = JSON.parse(raw[0]!.body) as Record<string, unknown>;
    expect(body).toMatchObject({ verb: "approve", qitemId: "q-chat-1", actorSession: "human@host" });
    expect("hostId" in body).toBe(false); // local card — byte-parity with the local path
  });
});

// rev1-r2 B1（2026-07-06）：退役 deny/route schema 经 action-required lens 的
// EMPTY-STATE copy 泄漏——card 级 DOM 测试看不到的 chrome。对 For-You 表面文件
// 的源扫描守卫捕获文件中任何处 copy（无论是否渲染）的任一措辞
//（"approve, deny, or route" / "approve, deny, and route"）。
//（渲染记录历史动作的 audit-outcome verb SET 非 copy，不匹配。）
describe("For-You surface copy — no retired-schema leakage (rev1-r2 B1)", () => {
  const here = nodePath.dirname(fileURLToPath(import.meta.url));
  const packageRoot = nodePath.resolve(here, "..");
  const RETIRED_COPY = /approve,\s*deny,?\s*(?:and|or)\s*route/i;

  for (const rel of [
    "src/components/for-you/Feed.tsx",
    "src/components/for-you/FeedCard.tsx",
  ]) {
    it(`${rel} carries no 'approve, deny, and/or route' copy`, () => {
      const source = readFileSync(nodePath.join(packageRoot, rel), "utf-8");
      expect(source).not.toMatch(RETIRED_COPY);
    });
  }

  it("the action-required empty state speaks approve + chat", () => {
    const source = readFileSync(nodePath.join(packageRoot, "src/components/for-you/Feed.tsx"), "utf-8");
    expect(source).toContain("一键批准或与所属智能体聊天");
  });
});
