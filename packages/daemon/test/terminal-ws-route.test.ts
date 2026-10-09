import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { Hono } from "hono";
import { createNodeWebSocket } from "@hono/node-ws";
import { serve, type ServerType } from "@hono/node-server";
import http from "node:http";
import * as fs from "node:fs";
import { registerTerminalWs } from "../src/routes/terminal-ws.js";

const TOKEN = "test-ws-route-token";
const PORT = 19876;

let server: ServerType;

beforeAll(async () => {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tmuxAdapter" as never, {
      hasSession: async () => true,
      setWindowOption: async () => ({ ok: true }),
      startPipePane: async () => ({ ok: true }),
      stopPipePane: async () => ({ ok: true }),
      sendKeys: async () => ({ ok: true }),
      sendText: async () => ({ ok: true }),
      resizeWindow: async () => ({ ok: true }),
    });
    await next();
  });
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  registerTerminalWs(app, upgradeWebSocket as never, { bearerToken: TOKEN });
  server = serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" });
  injectWebSocket(server);
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
});

afterAll(() => {
  server?.close();
});

function rawUpgrade(path: string, extraHeaders?: Record<string, string>): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: PORT,
      path,
      method: "GET",
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": Buffer.from("test-key-12345678").toString("base64"),
        "Sec-WebSocket-Version": "13",
        ...extraHeaders,
      },
    });
    req.on("response", (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body }));
    });
    req.on("upgrade", (_res, _socket, _head) => {
      resolve({ statusCode: 101, body: "" });
      _socket.destroy();
    });
    req.on("error", reject);
    req.end();
  });
}

describe("terminal WebSocket route（生产路径）", () => {
  it("有效 token 的 WS upgrade 不返回 404（QA blocker 回归）", async () => {
    const result = await rawUpgrade(
      `/api/terminal/test-session?token=${TOKEN}`,
      { Origin: "http://127.0.0.1" },
    );
    expect(result.statusCode, `预期非 404，实际为 ${result.statusCode}：${result.body}`).not.toBe(404);
  });

  it("缺少 token 时返回 401", async () => {
    const result = await rawUpgrade(
      "/api/terminal/test-session",
      { Origin: "http://127.0.0.1" },
    );
    expect(result.statusCode).toBe(401);
  });

  it("Origin 无效时返回 403", async () => {
    const result = await rawUpgrade(
      `/api/terminal/test-session?token=${TOKEN}`,
      { Origin: "http://evil.example.com" },
    );
    expect(result.statusCode).toBe(403);
  });

  it("token 错误时返回 401", async () => {
    const result = await rawUpgrade(
      `/api/terminal/test-session?token=wrong`,
      { Origin: "http://127.0.0.1" },
    );
    expect(result.statusCode).toBe(401);
  });
});

describe("terminal WebSocket 输入顺序", () => {
  const ORDER_PORT = 19878;
  const ORDER_TOKEN = "order-test-token";
  let orderServer: ServerType;
  const textCompletions: string[] = [];

  beforeAll(async () => {
    const app3 = new Hono();
    app3.use("*", async (c, next) => {
      c.set("tmuxAdapter" as never, {
        hasSession: async () => true,
        setWindowOption: async () => ({ ok: true }),
        startPipePane: async () => ({ ok: true }),
        stopPipePane: async () => ({ ok: true }),
        sendKeys: async () => ({ ok: true }),
        sendText: async (_name: string, text: string) => {
          await new Promise((resolve) => setTimeout(resolve, text === "e" ? 30 : 0));
          textCompletions.push(text);
          return { ok: true };
        },
        resizeWindow: async () => ({ ok: true }),
      });
      await next();
    });
    const { injectWebSocket: inject3, upgradeWebSocket: upgrade3 } = createNodeWebSocket({ app: app3 });
    registerTerminalWs(app3, upgrade3 as never, { bearerToken: ORDER_TOKEN });
    orderServer = serve({ fetch: app3.fetch, port: ORDER_PORT, hostname: "127.0.0.1" });
    inject3(orderServer);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  });

  afterAll(() => {
    orderServer?.close();
  });

  it("调用 tmux 前按顺序串行化快速到达的文本消息", async () => {
    textCompletions.length = 0;
    const ws = new WebSocket(`ws://127.0.0.1:${ORDER_PORT}/api/terminal/order-test?token=${ORDER_TOKEN}`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("WebSocket 打开失败"));
    });

    for (const text of ["e", "c", "h", "o"]) {
      ws.send(JSON.stringify({ type: "text", text }));
    }

    await vi.waitFor(() => {
      expect(textCompletions.join("")).toBe("echo");
    }, { timeout: 1000 });
    ws.close();
  });
});

describe("terminal WebSocket 生命周期（session 终止）", () => {
  const LIFECYCLE_PORT = 19877;
  const LIFECYCLE_TOKEN = "lifecycle-test-token";
  let lifecycleServer: ServerType;
  let sessionAlive = true;
  const stopPipePaneCalls: string[] = [];

  beforeAll(async () => {
    const app2 = new Hono();
    app2.use("*", async (c, next) => {
      c.set("tmuxAdapter" as never, {
        hasSession: async () => sessionAlive,
        setWindowOption: async () => ({ ok: true }),
        startPipePane: async () => ({ ok: true }),
        stopPipePane: async (name: string) => { stopPipePaneCalls.push(name); return { ok: true }; },
        sendKeys: async () => ({ ok: true }),
        sendText: async () => ({ ok: true }),
        resizeWindow: async () => ({ ok: true }),
      });
      await next();
    });
    const { injectWebSocket: inject2, upgradeWebSocket: upgrade2 } = createNodeWebSocket({ app: app2 });
    registerTerminalWs(app2, upgrade2 as never, { bearerToken: LIFECYCLE_TOKEN, livenessIntervalMs: 100 });
    lifecycleServer = serve({ fetch: app2.fetch, port: LIFECYCLE_PORT, hostname: "127.0.0.1" });
    inject2(lifecycleServer);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  });

  afterAll(() => {
    lifecycleServer?.close();
  });

  it("session 终止时以 code 1001 关闭 WebSocket", async () => {
    sessionAlive = true;
    stopPipePaneCalls.length = 0;

    const closePromise = new Promise<{ code: number; reason: string }>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${LIFECYCLE_PORT}/api/terminal/death-test?token=${LIFECYCLE_TOKEN}`);
      ws.onopen = () => {
        sessionAlive = false;
      };
      ws.onclose = (evt) => {
        resolve({ code: evt.code, reason: evt.reason });
      };
      ws.onerror = () => {
        resolve({ code: 0, reason: "error" });
      };
    });

    const result = await closePromise;
    expect(result.code).toBe(1001);
    expect(result.reason).toContain("tmux session 已终止");
    await vi.waitFor(() => {
      expect(stopPipePaneCalls).toContain("death-test");
    }, { timeout: 2000 });
  }, 10000);
});

// OPR.0.4.0.38——真实 WebSocket route 上的 broker 行为：同一 session 的多个订阅者共享
// 一条 pipe 和扇出 stream，客户端 resize 消息绝不会到达 pane（FR-7 固定几何尺寸）。
describe("terminal WebSocket broker（多订阅者 route）", () => {
  const BROKER_PORT = 19879;
  const BROKER_TOKEN = "broker-test-token";
  let brokerServer: ServerType;
  const startPipePaneCalls: string[] = [];
  const resizeWindowCalls: Array<{ cols: number; rows: number }> = [];
  let capturedOutputPath: string | null = null;

  beforeAll(async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("tmuxAdapter" as never, {
        hasSession: async () => true,
        setWindowOption: async () => ({ ok: true }),
        resizeWindow: async (_n: string, cols: number, rows: number) => {
          resizeWindowCalls.push({ cols, rows });
          return { ok: true };
        },
        startPipePane: async (name: string, outputPath: string) => {
          startPipePaneCalls.push(name);
          capturedOutputPath = outputPath;
          return { ok: true };
        },
        stopPipePane: async () => ({ ok: true }),
        sendKeys: async () => ({ ok: true }),
        sendText: async () => ({ ok: true }),
        capturePaneScreen: async () => null,
        getPaneCursorPosition: async () => null,
      });
      await next();
    });
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
    registerTerminalWs(app, upgradeWebSocket as never, { bearerToken: BROKER_TOKEN });
    brokerServer = serve({ fetch: app.fetch, port: BROKER_PORT, hostname: "127.0.0.1" });
    injectWebSocket(brokerServer);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  });

  afterAll(() => {
    brokerServer?.close();
  });

  function openWs(session: string): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${BROKER_PORT}/api/terminal/${session}?token=${BROKER_TOKEN}`);
    return new Promise((resolve, reject) => {
      ws.onopen = () => resolve(ws);
      ws.onerror = () => reject(new Error("WebSocket 打开失败"));
    });
  }

  it("同一 session 的两个订阅者共享一条 pipe-pane，且都收到扇出输出", async () => {
    startPipePaneCalls.length = 0;
    capturedOutputPath = null;
    const aRecv: string[] = [];
    const bRecv: string[] = [];

    const a = await openWs("fanout-session");
    a.onmessage = (e) => { if (typeof e.data === "string") aRecv.push(e.data); };
    const b = await openWs("fanout-session");
    b.onmessage = (e) => { if (typeof e.data === "string") bRecv.push(e.data); };

    // 给第二次 attach 留出片刻，使其注册到已有 broker。
    await new Promise<void>((r) => setTimeout(r, 80));
    expect(startPipePaneCalls.filter((n) => n === "fanout-session")).toHaveLength(1);
    expect(capturedOutputPath).toBeTruthy();

    fs.appendFileSync(capturedOutputPath!, "FANOUT-BYTES");
    await vi.waitFor(() => {
      expect(aRecv.join("")).toContain("FANOUT-BYTES");
      expect(bRecv.join("")).toContain("FANOUT-BYTES");
    }, { timeout: 1500 });

    a.close();
    b.close();
  }, 10000);

  it("客户端 resize 消息绝不调整 pane 大小（FR-7），只执行一次规范几何尺寸调用", async () => {
    resizeWindowCalls.length = 0;
    const ws = await openWs("resize-session");
    // broker 打开时执行一次规范几何尺寸调整。
    await vi.waitFor(() => {
      expect(resizeWindowCalls).toHaveLength(1);
    }, { timeout: 1000 });
    expect(resizeWindowCalls[0]).toEqual({ cols: 90, rows: 27 });

    ws.send(JSON.stringify({ type: "resize", cols: 200, rows: 9 }));
    // 留出时间，验证消息未被处理。
    await new Promise<void>((r) => setTimeout(r, 120));
    expect(resizeWindowCalls).toHaveLength(1); // 保持不变，resize 已被忽略。

    ws.close();
  }, 10000);
});

// OPR.0.4.0.38——attach 期间 detach 的竞态（dev1-guard watchpoint #4）：WebSocket
// 在异步 broker attach 仍进行时关闭，不得留下持有 pipe 的幽灵订阅者。
describe("terminal WebSocket attach 期间 detach 的竞态", () => {
  const RACE_PORT = 19880;
  const RACE_TOKEN = "race-test-token";
  let raceServer: ServerType;
  const stopPipePaneCalls: string[] = [];
  let capturedOutputPath: string | null = null;

  beforeAll(async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("tmuxAdapter" as never, {
        hasSession: async () => true,
        setWindowOption: async () => ({ ok: true }),
        resizeWindow: async () => ({ ok: true }),
        // 缓慢启动 pipe 以扩大 attach 窗口，确保客户端关闭发生在 attach 仍 pending 时。
        startPipePane: async (_name: string, outputPath: string) => {
          capturedOutputPath = outputPath;
          await new Promise((r) => setTimeout(r, 120));
          return { ok: true };
        },
        stopPipePane: async (name: string) => { stopPipePaneCalls.push(name); return { ok: true }; },
        sendKeys: async () => ({ ok: true }),
        sendText: async () => ({ ok: true }),
        capturePaneScreen: async () => null,
        getPaneCursorPosition: async () => null,
      });
      await next();
    });
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
    registerTerminalWs(app, upgradeWebSocket as never, { bearerToken: RACE_TOKEN });
    raceServer = serve({ fetch: app.fetch, port: RACE_PORT, hostname: "127.0.0.1" });
    injectWebSocket(raceServer);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  });

  afterAll(() => {
    raceServer?.close();
  });

  it("attach 中途关闭 WS 仍会拆除 broker（停止 pipe、删除临时文件且无泄漏）", async () => {
    stopPipePaneCalls.length = 0;
    capturedOutputPath = null;

    const ws = new WebSocket(`ws://127.0.0.1:${RACE_PORT}/api/terminal/race-session?token=${RACE_TOKEN}`);
    // 打开后立即关闭，此时服务端 attach 仍在等待 120ms 的 startPipePane。
    ws.onopen = () => { ws.close(); };
    await new Promise<void>((resolve) => { ws.onclose = () => resolve(); });

    // attach 完成后，route 必须再次 detach 已关闭的订阅者；由于它是最后/唯一订阅者，
    // broker 随之拆除：停止 pipe 并 unlink 临时文件。
    await vi.waitFor(() => {
      expect(stopPipePaneCalls).toContain("race-session");
      expect(capturedOutputPath).toBeTruthy();
      expect(fs.existsSync(capturedOutputPath!)).toBe(false);
    }, { timeout: 2000 });
  }, 10000);
});

// OPR.0.4.4.20 delta-C——open 时发送的竞态（由 slice-20 P2 VM 证明流程发现）：CHAT 的
// initialText frame 在客户端 ws.onopen 中发出，此时服务端 onOpen 仍等待异步 broker attach。
// 修复前，onMessage 看到 broker===null 后会静默丢弃；只要 attach 比客户端慢，预填的唯一
// CHAT frame 就会丢失。route 必须缓冲早到的 frame，并在 attach 后排空。
describe("terminal WebSocket open 时发送的缓冲（initialText 竞态）", () => {
  const EARLY_PORT = 19881;
  const EARLY_TOKEN = "early-frame-test-token";
  let earlyServer: ServerType;
  const sentTexts: string[] = [];

  beforeAll(async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("tmuxAdapter" as never, {
        hasSession: async () => true,
        setWindowOption: async () => ({ ok: true }),
        resizeWindow: async () => ({ ok: true }),
        // 缓慢启动 pipe 以扩大 attach 窗口，确保客户端在 open 时发送的文本 frame 会在
        // attach 仍 pending 时到达。
        startPipePane: async () => {
          await new Promise((r) => setTimeout(r, 120));
          return { ok: true };
        },
        stopPipePane: async () => ({ ok: true }),
        sendKeys: async () => ({ ok: true }),
        sendText: async (_name: string, text: string) => { sentTexts.push(text); return { ok: true }; },
        capturePaneScreen: async () => null,
        getPaneCursorPosition: async () => null,
      });
      await next();
    });
    const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
    registerTerminalWs(app, upgradeWebSocket as never, { bearerToken: EARLY_TOKEN });
    earlyServer = serve({ fetch: app.fetch, port: EARLY_PORT, hostname: "127.0.0.1" });
    injectWebSocket(earlyServer);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  });

  afterAll(() => {
    earlyServer?.close();
  });

  it("ws-open 时发送的文本 frame（attach 进行中）会被缓冲并交付，不会丢失", async () => {
    sentTexts.length = 0;
    const ws = new WebSocket(`ws://127.0.0.1:${EARLY_PORT}/api/terminal/early-session?token=${EARLY_TOKEN}`);
    const preamble = "[review fixture] Standing contract … user message begins here: ";
    ws.onopen = () => {
      // 与 FocusedTerminal 完全一致：打开后立即发送一个文本 frame。
      ws.send(JSON.stringify({ type: "text", text: preamble }));
    };
    await vi.waitFor(() => {
      expect(sentTexts).toEqual([preamble]);
    }, { timeout: 2000 });
    ws.close();
  }, 10000);

  it("限制 attach 前缓冲区，不接受无限量的早到 frame", async () => {
    sentTexts.length = 0;
    const ws = new WebSocket(`ws://127.0.0.1:${EARLY_PORT}/api/terminal/early-overflow?token=${EARLY_TOKEN}`);
    const closed = new Promise<{ code: number }>((resolve) => { ws.onclose = (evt) => resolve({ code: evt.code }); });
    ws.onopen = () => {
      for (let i = 0; i < 40; i++) {
        ws.send(JSON.stringify({ type: "text", text: `early-${i}` }));
      }
    };
    const evt = await closed;
    expect(evt.code).toBe(1009);
    expect(sentTexts).toEqual([]);
  }, 10000);
});
