import { describe, it, expect, vi } from "vitest";

describe("FocusedTerminal lifecycle", () => {
  it("source guard: FocusedTerminal imports @xterm/xterm/css/xterm.css", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, "../src/components/terminal/FocusedTerminal.tsx"),
      "utf-8",
    );
    expect(src).toContain('@xterm/xterm/css/xterm.css');
  });

  it("source guard: OPR.0.4.0.38 FR-7 - no client resize-send to the daemon", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, "../src/components/terminal/FocusedTerminal.tsx"),
      "utf-8",
    );
    // broker 拥有固定的规范几何尺寸；客户端不得发送 resize，否则会缩小所有其他查看者
    // 共用的窗格。
    expect(src).not.toMatch(/type:\s*["']resize["']/);
    // OPR.0.4.0.38 前向修复：客户端现在固定为 broker 的规范几何尺寸
    //（cols=100、rows=40），并在容器中滚动/平移；FitAddon 已完全移除，不再因适配容器而
    // 争抢 resize。这是更强的固定几何镜像形式。
    expect(src).not.toContain("FitAddon");
    expect(src).toContain("cols: LIVE_TERMINAL_COLS");
  });

  it("source guard: cleanup closes wsRef.current not local ws", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, "../src/components/terminal/FocusedTerminal.tsx"),
      "utf-8",
    );
    expect(src).toContain("const activeWs = wsRef.current");
    expect(src).toContain("activeWs.close()");
    expect(src).not.toMatch(/\bws\?\.close\(\)/);
  });

  it("source guard: onclose schedules reconnect via connect()", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, "../src/components/terminal/FocusedTerminal.tsx"),
      "utf-8",
    );
    expect(src).toContain("[disconnected - reconnecting...]");
    expect(src).toContain("mountedRef.current");
    expect(src).toMatch(/setTimeout\(\s*\(\)\s*=>\s*\{/);
    // 重连会调度 connectForGeneration(gen)。先前的 toContain("connect()") 会误匹配
    // resizeObs.disconnect()；该调用已随 FitAddon 移除，因此改为检查真实重连调用。
    expect(src).toContain("connectForGeneration(gen)");
  });

  it("source guard: cleanup sets mountedRef false and clears reconnect timer", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(import.meta.dirname, "../src/components/terminal/FocusedTerminal.tsx"),
      "utf-8",
    );
    expect(src).toContain("mountedRef.current = false");
    expect(src).toContain("clearTimeout(reconnectTimerRef.current)");
  });

  it("mapXtermInput is exported for direct testing", async () => {
    const { mapXtermInput } = await import("../src/components/terminal/FocusedTerminal.js");
    expect(typeof mapXtermInput).toBe("function");
  });
});
