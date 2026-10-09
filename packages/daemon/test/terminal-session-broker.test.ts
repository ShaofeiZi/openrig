import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import {
  TerminalSessionBroker,
  TerminalBrokerRegistry,
  screenSnapshotEscape,
  cursorPositionEscape,
  type BrokerTmux,
  type TerminalSubscriber,
} from "../src/terminal/TerminalSessionBroker.js";

// ---- 测试替身 ---------------------------------------------------------------

interface FakeSub extends TerminalSubscriber {
  received: string[];
  closed: { code: number; reason: string }[];
}

function makeSub(): FakeSub {
  const received: string[] = [];
  const closed: { code: number; reason: string }[] = [];
  return {
    received,
    closed,
    send: (d: string) => { received.push(d); },
    close: (code: number, reason: string) => { closed.push({ code, reason }); },
  };
}

function makeTmux(overrides: Partial<BrokerTmux> = {}): BrokerTmux {
  return {
    hasSession: async () => true,
    setWindowOption: async () => ({ ok: true }),
    resizeWindow: async () => ({ ok: true }),
    startPipePane: async () => ({ ok: true }),
    stopPipePane: async () => ({ ok: true }),
    sendKeys: async () => ({ ok: true }),
    sendText: async () => ({ ok: true }),
    capturePaneScreen: async () => null,
    getPaneCursorPosition: async () => null,
    capturePaneContent: async () => null,
    ...overrides,
  };
}

// 跟踪已创建的 broker，确保始终拆除（清除 interval 与临时文件）。
const liveBrokers: TerminalSessionBroker[] = [];
function track(b: TerminalSessionBroker): TerminalSessionBroker {
  liveBrokers.push(b);
  return b;
}
afterEach(() => {
  for (const b of liveBrokers.splice(0)) b.dispose();
});

// ---- 纯 cursor-safe seed helper（测试 #9 行漂移判别）------------------------

describe("cursor-safe seed helper", () => {
  it("cursorPositionEscape 发出从 1 开始的绝对光标移动", () => {
    expect(cursorPositionEscape(0, 0)).toBe("\x1b[1;1H");
    expect(cursorPositionEscape(4, 7)).toBe("\x1b[8;5H");
  });

  it("screenSnapshotEscape 用绝对移动绘制每一行（无行漂移）", () => {
    const out = screenSnapshotEscape("alpha\nbeta\ngamma", { x: 2, y: 1, height: 24 });
    expect(out.startsWith("\x1b[2J")).toBe(true);
    expect(out).toContain("\x1b[1;1Halpha");
    expect(out).toContain("\x1b[2;1Hbeta");
    expect(out).toContain("\x1b[3;1Hgamma");
    expect(out.endsWith(cursorPositionEscape(2, 1))).toBe(true);
  });

  it("行数超过 height 时只保留最后 `height` 行（滚动安全）", () => {
    const out = screenSnapshotEscape(["r1", "r2", "r3", "r4", "r5"].join("\n"), { x: 0, y: 0, height: 2 });
    expect(out).not.toContain("r1");
    expect(out).not.toContain("r3");
    expect(out).toContain("\x1b[1;1Hr4");
    expect(out).toContain("\x1b[2;1Hr5");
  });

  it("规范化 CRLF 并精确删除一个尾随换行，cursor 为 null 时回到原点", () => {
    expect(screenSnapshotEscape("a\r\nb\r\n", null)).toBe("\x1b[2J\x1b[1;1Ha\x1b[2;1Hb\x1b[H");
  });
});

// ---- broker 行为 ------------------------------------------------------------

describe("TerminalSessionBroker", () => {
  it("测试 1：把输出字节扇出给所有订阅者", async () => {
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux(), { pollMs: 10 }));
    const a = makeSub();
    const b = makeSub();
    await broker.attach(a);
    await broker.attach(b);

    const path = broker.pipeOutputPath!;
    expect(path).toBeTruthy();
    fs.appendFileSync(path, "hello-world");

    await vi.waitFor(() => {
      expect(a.received.join("")).toContain("hello-world");
      expect(b.received.join("")).toContain("hello-world");
    }, { timeout: 1000 });
  });

  it("测试 2：第二个订阅者不会启动第二条 pipe-pane", async () => {
    const startPipePane = vi.fn(async () => ({ ok: true as const }));
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ startPipePane }), { pollMs: 10 }));
    await broker.attach(makeSub());
    await broker.attach(makeSub());
    expect(startPipePane).toHaveBeenCalledOnce();
    expect(broker.subscriberCount).toBe(2);
  });

  it("测试 3：把订阅者输入转发到 tmux sendText / sendKeys", async () => {
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const sendKeys = vi.fn(async () => ({ ok: true as const }));
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ sendText, sendKeys }), { pollMs: 10 }));
    await broker.attach(makeSub());

    await broker.input({ type: "text", text: "echo hi" });
    await broker.input({ type: "keys", keys: ["Enter"] });

    expect(sendText).toHaveBeenCalledWith("dev@rig", "echo hi");
    expect(sendKeys).toHaveBeenCalledWith("dev@rig", ["Enter"]);
  });

  it("测试 3b：调用 tmux 前串行化快速输入（保持顺序）", async () => {
    const order: string[] = [];
    const sendText = vi.fn(async (_n: string, t: string) => {
      await new Promise((r) => setTimeout(r, t === "e" ? 20 : 0));
      order.push(t);
      return { ok: true as const };
    });
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ sendText }), { pollMs: 10 }));
    await broker.attach(makeSub());

    void broker.input({ type: "text", text: "e" });
    void broker.input({ type: "text", text: "c" });
    void broker.input({ type: "text", text: "h" });
    await broker.input({ type: "text", text: "o" });

    expect(order.join("")).toBe("echo");
  });

  it("测试 4：一个订阅者断开后，broker 继续服务其他订阅者", async () => {
    const stopPipePane = vi.fn(async () => ({ ok: true as const }));
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ stopPipePane }), { pollMs: 10 }));
    const a = makeSub();
    const b = makeSub();
    await broker.attach(a);
    await broker.attach(b);

    broker.detach(a);
    expect(broker.subscriberCount).toBe(1);
    expect(stopPipePane).not.toHaveBeenCalled();

    fs.appendFileSync(broker.pipeOutputPath!, "still-live");
    await vi.waitFor(() => {
      expect(b.received.join("")).toContain("still-live");
    }, { timeout: 1000 });
    expect(a.received.join("")).not.toContain("still-live");
  });

  it("测试 5：最后一个订阅者断开时停止 pipe-pane 并删除临时文件", async () => {
    const stopPipePane = vi.fn(async () => ({ ok: true as const }));
    const broker = new TerminalSessionBroker("dev@rig", makeTmux({ stopPipePane }), { pollMs: 10 });
    const a = makeSub();
    await broker.attach(a);
    const path = broker.pipeOutputPath!;
    expect(fs.existsSync(path)).toBe(true);

    broker.detach(a);
    await vi.waitFor(() => {
      expect(stopPipePane).toHaveBeenCalledWith("dev@rig");
      expect(fs.existsSync(path)).toBe(false);
    }, { timeout: 1000 });
    expect(broker.subscriberCount).toBe(0);
  });

  it("测试 6：session 终止时如实关闭所有订阅者（1001），不静默保留过期 live 状态", async () => {
    let alive = true;
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ hasSession: async () => alive }), {
      pollMs: 10,
      livenessMs: 20,
    }));
    const a = makeSub();
    const b = makeSub();
    await broker.attach(a);
    await broker.attach(b);

    alive = false;
    await vi.waitFor(() => {
      expect(a.closed[0]?.code).toBe(1001);
      expect(b.closed[0]?.code).toBe(1001);
    }, { timeout: 1000 });
    expect(a.closed[0]?.reason).toContain("已终止");
  });

  it("测试 7（broker 侧）：input 无 resize 路径，resize 不会通过输入到达 tmux.resizeWindow", async () => {
    const resizeWindow = vi.fn(async () => ({ ok: true as const }));
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ resizeWindow }), { pollMs: 10 }));
    await broker.attach(makeSub());
    resizeWindow.mockClear(); // ignore the one canonical-geometry resize at open
    // broker 输入 API 只接受 keys/text，不存在客户端驱动的 resize。
    await broker.input({ type: "text", text: "x" });
    expect(resizeWindow).not.toHaveBeenCalled();
  });

  it("测试 7b：打开时只设置一次规范几何尺寸（window-size manual + 120xN，不做激进 resize）", async () => {
    const setWindowOption = vi.fn(async () => ({ ok: true as const }));
    const resizeWindow = vi.fn(async () => ({ ok: true as const }));
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ setWindowOption, resizeWindow }), {
      pollMs: 10,
      cols: 120,
      rows: 40,
    }));
    await broker.attach(makeSub());
    await broker.attach(makeSub());

    expect(resizeWindow).toHaveBeenCalledOnce();
    expect(resizeWindow).toHaveBeenCalledWith("dev@rig", 120, 40);
    expect(setWindowOption).toHaveBeenCalledWith("dev@rig", "window-size", "manual");
    // aggressive-resize 与固定几何冲突（收缩到最小 client）——绝不可设置。
    expect(setWindowOption).not.toHaveBeenCalledWith("dev@rig", "aggressive-resize", expect.anything());
  });

  it("测试 8：首次 attach 时无需 resize 消息即发送 seed，并成为订阅者看到的首批字节", async () => {
    const tmux = makeTmux({
      capturePaneScreen: async () => "line one\nline two",
      getPaneCursorPosition: async () => ({ x: 3, y: 1, width: 120, height: 40 }),
    });
    const broker = track(new TerminalSessionBroker("dev@rig", tmux, { pollMs: 10 }));
    const a = makeSub();
    await broker.attach(a);

    expect(a.received[0]).toBe(screenSnapshotEscape("line one\nline two", { x: 3, y: 1, height: 40 }));
    expect(a.received[0]!.startsWith("\x1b[2J")).toBe(true);
  });

  it("测试 8b：每个订阅者都获得自己的 seed（第二个也有，不共享 seed pipe）", async () => {
    const tmux = makeTmux({ capturePaneScreen: async () => "screen" });
    const broker = track(new TerminalSessionBroker("dev@rig", tmux, { pollMs: 10 }));
    const a = makeSub();
    const b = makeSub();
    await broker.attach(a);
    await broker.attach(b);
    expect(a.received[0]).toContain("screen");
    expect(b.received[0]).toContain("screen");
  });

  it("测试 9：seed 使用可见屏幕 capture + cursor（绝对绘制），绝不使用 scrollback", async () => {
    const capturePaneScreen = vi.fn(async () => "r1\nr2\nr3");
    const getPaneCursorPosition = vi.fn(async () => ({ x: 1, y: 2, width: 80, height: 24 }));
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ capturePaneScreen, getPaneCursorPosition }), {
      pollMs: 10,
    }));
    const a = makeSub();
    await broker.attach(a);

    expect(capturePaneScreen).toHaveBeenCalledWith("dev@rig");
    const seed = a.received[0]!;
    expect(seed).toContain("\x1b[1;1Hr1");
    expect(seed).toContain("\x1b[3;1Hr3");
    expect(seed.endsWith(cursorPositionEscape(1, 2))).toBe(true);
  });

  it("测试 11：pipe-pane 失败不泄漏临时文件，会关闭订阅者并驱逐 broker", async () => {
    let evicted: string | null = null;
    const broker = new TerminalSessionBroker("dev@rig", makeTmux({
      startPipePane: async () => ({ ok: false, code: "session_not_found", message: "gone" }),
    }), { pollMs: 10, onEmpty: (n) => { evicted = n; } });
    const a = makeSub();
    await broker.attach(a);

    const path = broker.pipeOutputPath;
    expect(a.closed[0]?.code).toBe(1011);
    expect(evicted).toBe("dev@rig");
    expect(broker.subscriberCount).toBe(0);
    if (path) expect(fs.existsSync(path)).toBe(false);
  });

  it("测试 11b：打开时 session 已终止会如实关闭订阅者（1008），且不启动 pipe", async () => {
    const startPipePane = vi.fn(async () => ({ ok: true as const }));
    const broker = new TerminalSessionBroker("dev@rig", makeTmux({ hasSession: async () => false, startPipePane }), {
      pollMs: 10,
    });
    const a = makeSub();
    await broker.attach(a);
    // 1008（policy / session 确实不存在）镜像 broker 前的 route，与下方 1011
    //（服务端 pipe 失败）区分。
    expect(a.closed[0]?.code).toBe(1008);
    expect(a.closed[0]?.reason).toContain("未找到 session");
    expect(startPipePane).not.toHaveBeenCalled();
  });
});

// ---- registry：不存在时创建 + 驱逐 ----------------------------------------

describe("TerminalBrokerRegistry", () => {
  it("不存在时创建：同一 session 的两个订阅者共享一个 broker 与一条 pipe", async () => {
    const startPipePane = vi.fn(async () => ({ ok: true as const }));
    const reg = new TerminalBrokerRegistry(makeTmux({ startPipePane }), { pollMs: 10 });
    const b1 = await reg.attach("dev@rig", makeSub());
    const b2 = await reg.attach("dev@rig", makeSub());
    expect(b1).toBe(b2);
    expect(reg.size).toBe(1);
    expect(startPipePane).toHaveBeenCalledOnce();
    b1.dispose();
  });

  it("不同 session 使用不同 broker", async () => {
    const reg = new TerminalBrokerRegistry(makeTmux(), { pollMs: 10 });
    const b1 = await reg.attach("a@rig", makeSub());
    const b2 = await reg.attach("b@rig", makeSub());
    expect(b1).not.toBe(b2);
    expect(reg.size).toBe(2);
    b1.dispose();
    b2.dispose();
  });

  it("最后一个订阅者 detach 后从 registry 驱逐 broker", async () => {
    const reg = new TerminalBrokerRegistry(makeTmux(), { pollMs: 10 });
    const sub = makeSub();
    const broker = await reg.attach("dev@rig", sub);
    expect(reg.size).toBe(1);
    broker.detach(sub);
    await vi.waitFor(() => {
      expect(reg.size).toBe(0);
    }, { timeout: 1000 });
  });
});

// ---- 生命周期加固（dev1-guard watchpoint）----------------------------------

describe("TerminalSessionBroker——生命周期加固", () => {
  it("singleflight：并发的首次 attach 不会竞态创建两条 pipe", async () => {
    // 延迟 startPipePane 以扩大竞态窗口，使三个 attach 同时进行；同步 started-guard 仍必须
    // 只产生一条 pipe。
    const startPipePane = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true as const };
    });
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ startPipePane }), { pollMs: 10 }));
    await Promise.all([broker.attach(makeSub()), broker.attach(makeSub()), broker.attach(makeSub())]);
    expect(startPipePane).toHaveBeenCalledOnce();
    expect(broker.subscriberCount).toBe(3);
  });

  it("扇出隔离：抛错的订阅者不会破坏其他订阅者，且会被 detach", async () => {
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux(), { pollMs: 10 }));
    const good = makeSub();
    const bad: FakeSub = {
      received: [],
      closed: [],
      send: () => { throw new Error("dead socket"); },
      close: () => {},
    };
    await broker.attach(good);
    await broker.attach(bad);
    expect(broker.subscriberCount).toBe(2);

    fs.appendFileSync(broker.pipeOutputPath!, "ISOLATION-DATA");
    await vi.waitFor(() => {
      expect(good.received.join("")).toContain("ISOLATION-DATA");
      expect(broker.subscriberCount).toBe(1); // the throwing subscriber was detached
    }, { timeout: 1000 });
  });

  it("最后一次 detach 连非空 pipe 文件也会 unlink（AC-7 不泄漏临时文件）", async () => {
    const broker = new TerminalSessionBroker("dev@rig", makeTmux(), { pollMs: 10 });
    const a = makeSub();
    await broker.attach(a);
    const path = broker.pipeOutputPath!;
    fs.appendFileSync(path, "real accumulated terminal output bytes");
    expect(fs.statSync(path).size).toBeGreaterThan(0);

    broker.detach(a);
    await vi.waitFor(() => {
      expect(fs.existsSync(path)).toBe(false);
    }, { timeout: 1000 });
  });

  it("registry：同一 session 的并发 attach 共享一个 broker 与一条 pipe", async () => {
    const startPipePane = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true as const };
    });
    const reg = new TerminalBrokerRegistry(makeTmux({ startPipePane }), { pollMs: 10 });
    const [b1, b2] = await Promise.all([
      reg.attach("dev@rig", makeSub()),
      reg.attach("dev@rig", makeSub()),
    ]);
    expect(b1).toBe(b2);
    expect(reg.size).toBe(1);
    expect(startPipePane).toHaveBeenCalledOnce();
    b1.dispose();
  });

  it("registry：最终关闭后的 attach 创建新 broker，不复用过期实例", async () => {
    const reg = new TerminalBrokerRegistry(makeTmux(), { pollMs: 10 });
    const sub1 = makeSub();
    const first = await reg.attach("dev@rig", sub1);
    first.detach(sub1);
    await vi.waitFor(() => { expect(reg.size).toBe(0); }, { timeout: 1000 });

    const sub2 = makeSub();
    const second = await reg.attach("dev@rig", sub2);
    expect(second).not.toBe(first);
    expect(reg.size).toBe(1);
    second.dispose();
  });
});

// ---- AC-5 / FR-4：broker 拥有的共享历史环 ----------------------------------
// dev1-guard code-review BLOCKING：较晚加入的订阅者必须获得 broker 拥有的近期输出共享历史
//（已经滚出第一个订阅者的字节），不能只获得自身的可见屏幕 capture 与后续扇出。
describe("TerminalSessionBroker——共享历史环（AC-5）", () => {
  it("较晚加入的订阅者收到已滚出第一个订阅者视图的 broker 历史", async () => {
    const startPipePane = vi.fn(async () => ({ ok: true as const }));
    // capturePaneScreen 返回 null，因此 B 看到已滚出输出的唯一路径是 broker 历史环，
    // 而不是它自己的可见 seed。
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ startPipePane }), { pollMs: 10 }));
    const a = makeSub();
    await broker.attach(a);

    fs.appendFileSync(broker.pipeOutputPath!, "HISTORY-A-SAW-THEN-SCROLLED-OFF");
    await vi.waitFor(() => {
      expect(a.received.join("")).toContain("HISTORY-A-SAW-THEN-SCROLLED-OFF");
    }, { timeout: 1000 });

    const b = makeSub();
    await broker.attach(b);

    // 即使 B 的 capturePaneScreen 为 null，也必须收到 broker 拥有的历史。
    expect(b.received.join("")).toContain("HISTORY-A-SAW-THEN-SCROLLED-OFF");
    // ……且仍不创建第二条 pipe（保持 FR-1）。
    expect(startPipePane).toHaveBeenCalledOnce();
  });

  it("较晚加入的订阅者跳过不安全的 TUI 重绘历史，并收到当前屏幕快照", async () => {
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({
      capturePaneScreen: async () => "CURRENT SCREEN",
      getPaneCursorPosition: async () => ({ x: 0, y: 0, width: 120, height: 40 }),
    }), { pollMs: 10 }));
    const a = makeSub();
    await broker.attach(a);

    fs.appendFileSync(
      broker.pipeOutputPath!,
      "\x1b[2J\x1b[12;1HSTALE TUI PROMPT\x1b[13;1Hoverpainted status",
    );
    await vi.waitFor(() => {
      expect(a.received.join("")).toContain("STALE TUI PROMPT");
    }, { timeout: 1000 });

    const b = makeSub();
    await broker.attach(b);
    const bSeed = b.received.join("");

    expect(bSeed).not.toContain("STALE TUI PROMPT");
    expect(bSeed).not.toContain("overpainted status");
    expect(bSeed).toContain("CURRENT SCREEN");
  });

  it("持续输出时历史环保持有界", async () => {
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux(), { pollMs: 5, maxHistoryBytes: 2048 }));
    await broker.attach(makeSub());
    const path = broker.pipeOutputPath!;
    for (let i = 0; i < 20; i++) {
      fs.appendFileSync(path, "Y".repeat(300)); // 300-byte chunks, each < the 2048 cap
      await new Promise((r) => setTimeout(r, 8));
    }
    expect(broker.historyByteLength).toBeGreaterThan(0);
    expect(broker.historyByteLength).toBeLessThanOrEqual(2048);
  });

  it("最终 detach 时清空历史环（不跨会话遗留或泄漏）", async () => {
    const broker = new TerminalSessionBroker("dev@rig", makeTmux(), { pollMs: 10 });
    const a = makeSub();
    await broker.attach(a);
    fs.appendFileSync(broker.pipeOutputPath!, "transient history");
    await vi.waitFor(() => { expect(broker.historyByteLength).toBeGreaterThan(0); }, { timeout: 1000 });

    broker.detach(a);
    await vi.waitFor(() => { expect(broker.historyByteLength).toBe(0); }, { timeout: 1000 });
  });
});

// ---- 并发 attach 失败（dev1-guard 复审 watchpoint）-------------------------
// 共享 open 失败时，后续并发 attach 不得在已拆除 broker 上保持 live。所有并发 attach
// 等待同一个 open 结果，每个订阅者都如实关闭（不谎报 live terminal）。
describe("TerminalSessionBroker——并发 attach 失败（如实关闭）", () => {
  it("DEAD session 上的并发首次 attach 会如实关闭全部订阅者（1008），不留 live 状态", async () => {
    let evicted = 0;
    const broker = new TerminalSessionBroker("dead@rig", makeTmux({
      hasSession: async () => { await new Promise((r) => setTimeout(r, 20)); return false; },
    }), { pollMs: 10, onEmpty: () => { evicted += 1; } });
    const a = makeSub();
    const b = makeSub();

    await Promise.all([broker.attach(a), broker.attach(b)]);

    expect(a.closed[0]?.code).toBe(1008);
    expect(b.closed[0]?.code).toBe(1008); // the co-waiter is NOT left live
    expect(broker.subscriberCount).toBe(0);
    expect(evicted).toBe(1); // evicted exactly once
  });

  it("PIPE-START 失败时并发首次 attach 会关闭全部订阅者（1011），且无临时文件泄漏", async () => {
    let capturedPath: string | null = null;
    const broker = new TerminalSessionBroker("dev@rig", makeTmux({
      startPipePane: async (_n: string, p: string) => {
        capturedPath = p;
        await new Promise((r) => setTimeout(r, 20));
        return { ok: false as const, code: "pipe_fail", message: "pipe boom" };
      },
    }), { pollMs: 10 });
    const a = makeSub();
    const b = makeSub();

    await Promise.all([broker.attach(a), broker.attach(b)]);

    expect(a.closed[0]?.code).toBe(1011);
    expect(b.closed[0]?.code).toBe(1011);
    expect(broker.subscriberCount).toBe(0);
    if (capturedPath) expect(fs.existsSync(capturedPath)).toBe(false);
  });

  it("registry：向已终止 session 并发 attach 时全部关闭并驱逐 broker（size 0）", async () => {
    const reg = new TerminalBrokerRegistry(makeTmux({
      hasSession: async () => { await new Promise((r) => setTimeout(r, 20)); return false; },
    }), { pollMs: 10 });
    const a = makeSub();
    const b = makeSub();

    await Promise.all([reg.attach("dead@rig", a), reg.attach("dead@rig", b)]);

    expect(a.closed[0]?.code).toBe(1008);
    expect(b.closed[0]?.code).toBe(1008);
    await vi.waitFor(() => { expect(reg.size).toBe(0); }, { timeout: 1000 });
  });
});

// ---- seed 期间 teardown 的竞态（dev1-guard 第三轮 watchpoint）--------------
// 较晚加入的 attach 若阻塞在异步 seed 中，而 broker 在等待期间因 session 终止/dispose 被拆除，
// 就不得再把它加入 broker；必须使用记住的拆除原因如实关闭，绝不静默转为 live。
describe("TerminalSessionBroker——seed 期间 teardown（如实关闭）", () => {
  it("session 终止时仍阻塞在 seed 中的晚到 attach 会如实关闭（1001）且不会加入", async () => {
    let releaseCapture!: () => void;
    const blocked = new Promise<string | null>((res) => { releaseCapture = () => res("late-screen"); });
    let captureCalls = 0;
    let alive = true;
    let evicted = 0;
    const broker = new TerminalSessionBroker("dev@rig", makeTmux({
      hasSession: async () => alive,
      capturePaneScreen: async () => {
        captureCalls += 1;
        // 第一个订阅者的 seed 立即完成；晚到订阅者的 seed 会阻塞到测试主动放行。
        return captureCalls === 1 ? "first-screen" : blocked;
      },
    }), { pollMs: 10, livenessMs: 15, onEmpty: () => { evicted += 1; } });

    const a = makeSub();
    await broker.attach(a); // first subscriber attached, broker live + liveness running

    const b = makeSub();
    const bAttach = broker.attach(b); // blocks inside seed (capturePaneScreen)

    // B 仍在 seed 中时 session 终止，liveness 触发并拆除 broker。
    alive = false;
    await vi.waitFor(() => { expect(a.closed[0]?.code).toBe(1001); }, { timeout: 1000 });

    releaseCapture(); // B's seed now resolves
    await bAttach;

    expect(b.closed[0]?.code).toBe(1001); // honest close with the remembered death reason
    expect(broker.subscriberCount).toBe(0); // B was NOT added to the dead broker
    expect(evicted).toBe(1);
  });
});

// ---- OPR.0.4.0.39：逐订阅者 scroll-back（tmux capture-pane 窗口）------------
// live xterm 屏幕只包含当前 `rows`；向上滚动必须显示 tmux SCROLLBACK。broker 把一条 pipe
// 扇出给多个 viewer，因此 scroll-back 必须逐订阅者维护，且对 pane 只读（capture-pane 历史
// 窗口），不能使用会冻结所有 viewer 的 pane 全局 copy-mode。滚离底部的订阅者会收到静态历史
// 窗口，并被 live 扇出跳过，直到它返回底部（offset 0），此时重绘 live 屏幕并重新加入扇出。
describe("TerminalSessionBroker——逐订阅者 scroll-back（OPR.0.4.0.39）", () => {
  it("scroll(offset>0) 只向该订阅者绘制以底部为锚点的 tmux 历史窗口", async () => {
    // 模拟真实 tmux：`capture-pane -p -S -N` 返回以 live 底部结束的缓冲区，其中包含可见
    // 屏幕上方约 N 行历史以及屏幕本身，总计约 N + rows 行。L1..L200 中 L200 是 live 底行。
    const BUF = Array.from({ length: 200 }, (_, i) => `L${i + 1}`);
    const ROWS = 3;
    const capturePaneContent = vi.fn(async (_n: string, n: number) => {
      const count = Math.min(BUF.length, n + ROWS); // -S -N => ~N + rows lines, bottom-anchored
      return BUF.slice(BUF.length - count).join("\n");
    });
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({ capturePaneContent }), { pollMs: 10, rows: ROWS }));
    const a = makeSub();
    const b = makeSub();
    await broker.attach(a);
    await broker.attach(b);
    const aBefore = a.received.length;
    const bBefore = b.received.length;

    await broker.scroll(a, 3); // wheel up 3 lines from the live bottom (L200)

    // capture 回溯 (offset + rows) = 3 + 3 = 6 行；绘制窗口包含 `rows`（3）行，结束于
    // live 底部上方 `offset`（3）行处：底行为 L200 - 3 = L197，因此窗口为 L195..L197，
    // 既不是 capture 更旧的顶部，也不是 live tail。
    expect(capturePaneContent).toHaveBeenCalledWith("dev@rig", 6);
    expect(a.received.length).toBe(aBefore + 1);
    const painted = a.received[a.received.length - 1]!;
    expect(painted.startsWith("\x1b[2J")).toBe(true);
    expect(painted).toContain("\x1b[1;1HL195");
    expect(painted).toContain("\x1b[2;1HL196");
    expect(painted).toContain("\x1b[3;1HL197");
    expect(painted).not.toContain("L198"); // L198..L200 are within the offset (toward live)
    expect(painted).not.toContain("L194"); // above the rows-tall window
    // b 保持 live 且从未滚动，不受 a 滚动影响，证明状态按订阅者隔离。
    expect(b.received.length).toBe(bBefore);
  });

  it("滚回历史的订阅者被 live 扇出跳过，live viewer 仍持续接收", async () => {
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({
      capturePaneContent: async () => "x1\nx2\nx3\nx4",
    }), { pollMs: 10, rows: 3 }));
    const a = makeSub();
    const b = makeSub();
    await broker.attach(a);
    await broker.attach(b);

    await broker.scroll(a, 2); // a is now viewing a static history window
    const aAfterScroll = a.received.length;

    fs.appendFileSync(broker.pipeOutputPath!, "LIVE-AFTER-SCROLL");
    await vi.waitFor(() => {
      expect(b.received.join("")).toContain("LIVE-AFTER-SCROLL");
    }, { timeout: 1000 });
    // a 已滚回历史，live 字节不得覆盖其历史视图。
    expect(a.received.length).toBe(aAfterScroll);
    expect(a.received.join("")).not.toContain("LIVE-AFTER-SCROLL");
  });

  it("scroll(offset 0) 重绘 live 屏幕，并让订阅者重新加入扇出", async () => {
    const capturePaneScreen = vi.fn(async () => "LIVE SCREEN");
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux({
      capturePaneContent: async () => "g1\ng2\ng3\ng4",
      capturePaneScreen,
      getPaneCursorPosition: async () => ({ x: 0, y: 0, width: 90, height: 3 }),
    }), { pollMs: 10, rows: 3 }));
    const a = makeSub();
    await broker.attach(a);

    await broker.scroll(a, 2); // into history (skipped by fanout)
    capturePaneScreen.mockClear();
    const beforeReturn = a.received.length;

    await broker.scroll(a, 0); // back to the live bottom

    expect(capturePaneScreen).toHaveBeenCalledWith("dev@rig");
    expect(a.received.length).toBe(beforeReturn + 1);
    expect(a.received[a.received.length - 1]!).toContain("LIVE SCREEN");

    // ……并重新加入 live 扇出，不再被跳过。
    fs.appendFileSync(broker.pipeOutputPath!, "BACK-TO-LIVE-STREAM");
    await vi.waitFor(() => {
      expect(a.received.join("")).toContain("BACK-TO-LIVE-STREAM");
    }, { timeout: 1000 });
  });

  it("对未知订阅者执行 scroll 时不做任何操作（不抛错、不发送）", async () => {
    const broker = track(new TerminalSessionBroker("dev@rig", makeTmux(), { pollMs: 10, rows: 3 }));
    await broker.attach(makeSub());
    const ghost = makeSub(); // never attached
    await broker.scroll(ghost, 5);
    expect(ghost.received.length).toBe(0);
    expect(ghost.closed.length).toBe(0);
  });
});
