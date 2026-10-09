import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMockEventSourceClass, instances } from "./helpers/mock-event-source.js";
import { RigChatPanel } from "../src/components/RigChatPanel.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

let OriginalEventSource: typeof EventSource | undefined;

function renderPanel(rigId: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RigChatPanel rigId={rigId} />
    </QueryClientProvider>
  );
}

describe("RigChatPanel", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    OriginalEventSource = globalThis.EventSource;
    globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  });

  afterEach(() => {
    if (OriginalEventSource) {
      globalThis.EventSource = OriginalEventSource;
    }
    cleanup();
  });

  const chatMessages = [
    { id: "msg-1", rigId: "rig-1", sender: "alice", kind: "message", body: "hello", topic: null, createdAt: "2026-03-31T10:00:00Z" },
    { id: "msg-2", rigId: "rig-1", sender: "bob", kind: "message", body: "world", topic: null, createdAt: "2026-03-31T10:01:00Z" },
  ];

  it("renders message history with sender labels", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/chat/history")) {
        return Promise.resolve({
          ok: true,
          json: async () => chatMessages,
        });
      }
      if (typeof url === "string" && url.includes("/chat/send")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ id: "msg-new", rigId: "rig-1", sender: "ui", kind: "message", body: "test", topic: null, createdAt: "2026-03-31T10:02:00Z" }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    renderPanel("rig-1");

    // 等待消息渲染；发送者现在独占一行。
    expect(await screen.findByText("alice")).toBeTruthy();
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.getByText("bob")).toBeTruthy();
    expect(screen.getByText("world")).toBeTruthy();
  });

  it("send form submits message", async () => {
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (typeof url === "string" && url.includes("/chat/history")) {
        return Promise.resolve({
          ok: true,
          json: async () => [],
        });
      }
      if (typeof url === "string" && url.includes("/chat/send") && opts?.method === "POST") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ id: "msg-new", rigId: "rig-1", sender: "ui", kind: "message", body: "hello world", topic: null, createdAt: "2026-03-31T10:00:00Z" }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    renderPanel("rig-1");

    // 等待面板加载。
    await screen.findByTestId("chat-send-form");

    const input = screen.getByTestId("chat-input");
    const sendBtn = screen.getByTestId("chat-send-btn");

    // 输入并发送。
    fireEvent.change(input, { target: { value: "hello world" } });
    fireEvent.click(sendBtn);

    // 验证 fetch 收到了消息。
    await waitFor(() => {
      const sendCalls = mockFetch.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("/chat/send")
      );
      expect(sendCalls.length).toBeGreaterThan(0);
    });
  });

  it("renders topic markers as visually distinct blocks", async () => {
    const messagesWithTopic = [
      { id: "msg-t1", rigId: "rig-1", sender: "host", kind: "topic", body: "", topic: "review", createdAt: "2026-03-31T10:00:00Z" },
      { id: "msg-1", rigId: "rig-1", sender: "alice", kind: "message", body: "review comment", topic: null, createdAt: "2026-03-31T10:01:00Z" },
    ];
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/chat/history")) {
        return Promise.resolve({ ok: true, json: async () => messagesWithTopic });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    renderPanel("rig-1");

    // 主题标记应使用独立 testId 渲染。
    const topicEl = await screen.findByTestId("chat-topic-msg-t1");
    expect(topicEl.textContent).toContain("review");
    // 普通消息应有发送者标题。
    expect(screen.getByText("alice")).toBeTruthy();
    expect(screen.getByText("review comment")).toBeTruthy();
  });

  it("renders sender as header separated from body", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/chat/history")) {
        return Promise.resolve({ ok: true, json: async () => chatMessages });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    renderPanel("rig-1");

    // 发送者应位于独立元素中，而不是与正文内联。
    const senderEl = await screen.findByTestId("chat-sender-msg-1");
    expect(senderEl.textContent).toBe("alice");
    // 正文应位于独立元素中。
    expect(screen.getByText("hello")).toBeTruthy();
  });

  it("updates when new message event arrives", async () => {
    let callCount = 0;
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/chat/history")) {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            json: async () => chatMessages,
          });
        }
        // SSE 事件触发重新获取后，返回新增消息。
        return Promise.resolve({
          ok: true,
          json: async () => [
            ...chatMessages,
            { id: "msg-3", rigId: "rig-1", sender: "charlie", kind: "message", body: "new message", topic: null, createdAt: "2026-03-31T10:02:00Z" },
          ],
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    renderPanel("rig-1");

    // 等待首次渲染。
    await screen.findByText("alice");

    // 模拟 SSE 消息事件。
    const esInstance = instances[0]!;
    esInstance.simulateMessage(JSON.stringify({ id: "msg-3", sender: "charlie", body: "new message" }));

    // 等待重新获取结果包含新消息。
    await waitFor(() => {
      expect(screen.getByText("new message")).toBeTruthy();
    });
  });
});
