// 裁定 1ae863d2（2026-08-06 线上假硬宕事故）——CLI 状态诚实：
// (1) 按 C3 检测器语义的三态 daemon 状态（canonical：
//     packages/daemon/src/domain/crash-cart-detect.ts——保持同步）：DOWN
//     ("stopped") 需确凿证据（连接被拒）；TIMEOUT 绝不提升为 stopped——它是
//     "unverified"。
// (2) HOME 解析诚实：已解析 OPENRIG_HOME 为空/陈旧且存在存活 sibling home
//     （或 HOME-MOVED 标记）时，必须浮出两条路径——绝不得从错误 home 断言 daemon 宕机。
import { describe, it, expect, vi } from "vitest";
import { getDaemonStatus, type LifecycleDeps } from "../src/daemon-lifecycle.js";

function baseDeps(over: Partial<LifecycleDeps> = {}): LifecycleDeps {
  return {
    spawn: vi.fn() as unknown as LifecycleDeps["spawn"],
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 0),
    isProcessAlive: vi.fn(() => false),
    sleep: async () => {},
    ...over,
  };
}

const HANG: LifecycleDeps["fetch"] = () => new Promise(() => {}); // probe timeout path
const REFUSED: LifecycleDeps["fetch"] = async () => {
  const err = new Error("fetch failed") as Error & { cause?: { code: string } };
  err.cause = { code: "ECONNREFUSED" };
  throw err;
};

describe("3-state daemon status (C3 semantics: DOWN on positive evidence only)", () => {
  it("env-URL path: probe TIMEOUT is UNVERIFIED, never stopped", async () => {
    process.env.OPENRIG_URL = "http://127.0.0.1:7433";
    try {
      const s = await getDaemonStatus(baseDeps({ fetch: HANG }));
      expect(s.state).toBe("unverified");
      expect(s.state).not.toBe("stopped");
    } finally {
      delete process.env.OPENRIG_URL;
    }
  });

  it("env-URL path: connection REFUSED is stopped (positive evidence)", async () => {
    process.env.OPENRIG_URL = "http://127.0.0.1:7433";
    try {
      const s = await getDaemonStatus(baseDeps({ fetch: REFUSED }));
      expect(s.state).toBe("stopped");
    } finally {
      delete process.env.OPENRIG_URL;
    }
  });

  it("no state file: TIMEOUT is UNVERIFIED, never stopped", async () => {
    const s = await getDaemonStatus(baseDeps({ fetch: HANG }));
    expect(s.state).toBe("unverified");
  });

  it("no state file: REFUSED with no live sibling is stopped", async () => {
    const s = await getDaemonStatus(baseDeps({ fetch: REFUSED }));
    expect(s.state).toBe("stopped");
  });
});

describe("home-resolution honesty (never daemon-down from the wrong home)", () => {
  it("empty resolved home + LIVE sibling home -> UNVERIFIED + both paths named", async () => {
    // resolved home has NO daemon.json; a sibling .openrig-build-vm home has one with a live pid.
    const deps = baseDeps({
      fetch: REFUSED,
      homeDir: "/fake/home/.openrig",
      listDir: vi.fn((p: string) => (p === "/fake/home" ? [".openrig", ".openrig-build-vm-x"] : [])),
      exists: vi.fn((p: string) => p === "/fake/home/.openrig-build-vm-x/daemon.json"),
      readFile: vi.fn((p: string) =>
        p === "/fake/home/.openrig-build-vm-x/daemon.json" ? JSON.stringify({ pid: 4242, port: 7433 }) : null,
      ),
      isProcessAlive: vi.fn((pid: number) => pid === 4242),
    });
    const s = await getDaemonStatus(deps);
    expect(s.state).toBe("unverified");
    expect(s.siblingHint?.resolvedHome).toBe("/fake/home/.openrig");
    expect(s.siblingHint?.siblingHome).toBe("/fake/home/.openrig-build-vm-x");
  });

  it("HOME-MOVED marker in the resolved home surfaces the moved-to path", async () => {
    const deps = baseDeps({
      fetch: REFUSED,
      homeDir: "/fake/home/.openrig",
      exists: vi.fn((p: string) => p === "/fake/home/.openrig/HOME-MOVED"),
      readFile: vi.fn((p: string) =>
        p === "/fake/home/.openrig/HOME-MOVED" ? "/fake/home/.openrig-build-vm-x\n" : null,
      ),
    });
    const s = await getDaemonStatus(deps);
    expect(s.state).toBe("unverified");
    expect(s.siblingHint?.siblingHome).toBe("/fake/home/.openrig-build-vm-x");
  });

  it("no sibling, no marker: refused still reports stopped (no false unverified)", async () => {
    const deps = baseDeps({
      fetch: REFUSED,
      homeDir: "/fake/home/.openrig",
      listDir: vi.fn(() => [".openrig"]),
    });
    const s = await getDaemonStatus(deps);
    expect(s.state).toBe("stopped");
    expect(s.siblingHint).toBeUndefined();
  });
});
