import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import React from "react";

const instances: MockWS[] = [];

class MockWS {
  url: string;
  readyState = 1;
  onopen: ((evt?: unknown) => void) | null = null;
  onclose: ((evt: { code: number; reason: string }) => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalled = false;

  constructor(url: string) {
    this.url = url;
    instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }
  send() {}
  close() { this.closeCalled = true; this.readyState = 3; }
  static OPEN = 1;
}

const terminalWrites: string[] = [];
let terminalDisposeCount = 0;

vi.stubGlobal("WebSocket", MockWS);

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    child: HTMLElement | null = null;
    open(el: HTMLElement) {
      this.child = document.createElement("div");
      this.child.className = "xterm";
      this.child.textContent = "xterm child";
      el.appendChild(this.child);
    }
    write(data: string) { terminalWrites.push(data); }
    onData(_cb: (data: string) => void) {}
    onResize(_cb: (size: { cols: number; rows: number }) => void) {}
    // 真实 xterm Terminal 暴露 focus() + scrollToBottom()；FocusedTerminal
    // 两者都调（open 时 focus，scroll-to-prompt 路径 scrollToBottom）。
    // stub 它们，使组件 setup 在 mock 中不抛错。
    focus() {}
    scrollToBottom() {}
    // OPR.0.4.0.39：FocusedTerminal 为 tmux scroll-back 挂 wheel handler。
    attachCustomWheelEventHandler(_h: (ev: WheelEvent) => boolean) {}
    dispose() {
      terminalDisposeCount++;
      this.child?.remove();
      this.child = null;
    }
    loadAddon() {}
    cols = 80;
    rows = 24;
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class { fit() {} },
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

beforeEach(() => {
  instances.length = 0;
  terminalWrites.length = 0;
  terminalDisposeCount = 0;
  window.localStorage.setItem("openrig.terminalBearerToken", "test-tok");
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.removeItem("openrig.terminalBearerToken");
});

describe("FocusedTerminal reconnect behavior", () => {
  it("close triggers reconnecting message + new WebSocket after 3s", async () => {
    const { FocusedTerminal } = await import("../src/components/terminal/FocusedTerminal.js");

    render(React.createElement(FocusedTerminal, { sessionName: "dev-impl@test-rig" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    expect(instances.length).toBe(1);
    expect(instances[0]!.url).toContain("/api/terminal/dev-impl%40test-rig");
    expect(instances[0]!.url).toContain("token=test-tok");

    // 模拟 session 死亡 -> onclose
    await act(async () => {
      instances[0]!.onclose?.({ code: 1006, reason: "connection lost" });
    });

    expect(terminalWrites.some((w) => w.includes("[disconnected - reconnecting...]"))).toBe(true);

    // 前进 3s -> 重连
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

    expect(instances.length).toBe(2);
    expect(instances[1]!.url).toContain("/api/terminal/dev-impl%40test-rig");
    expect(instances[1]!.url).toContain("token=test-tok");
  });

  it("unmount after reconnect closes the reconnected socket", async () => {
    const { FocusedTerminal } = await import("../src/components/terminal/FocusedTerminal.js");

    const { unmount } = render(React.createElement(FocusedTerminal, { sessionName: "cleanup-test" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    // 触发 close + 重连
    await act(async () => { instances[0]!.onclose?.({ code: 1006, reason: "connection lost" }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

    expect(instances.length).toBe(2);

    unmount();

    expect(instances[1]!.closeCalled).toBe(true);

    // 卸载后无第三个 socket
    const countAfterUnmount = instances.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(instances.length).toBe(countAfterUnmount);
  });

  it("unmount before reconnect timer fires prevents new socket", async () => {
    const { FocusedTerminal } = await import("../src/components/terminal/FocusedTerminal.js");

    const { unmount } = render(React.createElement(FocusedTerminal, { sessionName: "early-unmount" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    // 触发 close 以调度重连
    await act(async () => { instances[0]!.onclose?.({ code: 1006, reason: "connection lost" }); });

    // 3s 前卸载
    unmount();

    // 前进过重连计时器
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    // 未创建第二个 socket
    expect(instances.length).toBe(1);
  });

  it("session change invalidates old socket's reconnect (no stale reconnect)", async () => {
    const { FocusedTerminal } = await import("../src/components/terminal/FocusedTerminal.js");

    const { rerender } = render(
      React.createElement(FocusedTerminal, { sessionName: "old-session" }),
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    expect(instances.length).toBe(1);
    const oldSocket = instances[0]!;
    expect(oldSocket.url).toContain("old-session");

    // 用新 session 重渲染（触发清理 + 新 effect）
    rerender(React.createElement(FocusedTerminal, { sessionName: "new-session" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    // 新 session socket 应被创建
    const newSessionSockets = instances.filter((i) => i.url.includes("new-session"));
    expect(newSessionSockets.length).toBeGreaterThanOrEqual(1);

    // 旧 socket 的 onclose 触发（清理来的陈旧 close）
    await act(async () => { oldSocket.onclose?.({ code: 1006, reason: "cleanup" }); });

    // 前进过重连计时器
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });

    // 无到旧 session 的陈旧重连
    const oldSessionSockets = instances.filter((i) => i.url.includes("old-session"));
    expect(oldSessionSockets.length).toBe(1);
  });

  it("definitive close (code 1008 session not found) shows unavailable and does NOT reconnect", async () => {
    const { FocusedTerminal } = await import("../src/components/terminal/FocusedTerminal.js");

    const { container } = render(
      React.createElement(FocusedTerminal, { sessionName: "missing-session" }),
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    expect(instances.length).toBe(1);

    await act(async () => {
      instances[0]!.onclose?.({ code: 1008, reason: "session not found: missing-session" });
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(container.textContent).toContain("终端不可用");
    expect(container.textContent).toContain("session not found");
    expect(container.querySelector(".xterm")).toBeNull();
    expect(terminalDisposeCount).toBe(1);

    const countBefore = instances.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(instances.length).toBe(countBefore);
  });

  it("transient close (code 1006) still reconnects", async () => {
    const { FocusedTerminal } = await import("../src/components/terminal/FocusedTerminal.js");

    render(React.createElement(FocusedTerminal, { sessionName: "transient-test" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    await act(async () => {
      instances[0]!.onclose?.({ code: 1006, reason: "" });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });

    expect(instances.length).toBe(2);
  });
});
