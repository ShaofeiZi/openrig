import { describe, it, expect, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { subscribeActivityEvents } from "../src/live-events.js";
import { createLiveRefresh } from "../src/live.js";
import { emptySnapshot } from "../src/state.js";
import type { FleetSnapshot } from "../src/types.js";

// OPR.0.5.5.19 AM-R18——打开的视图自更新：oracle SSE
// 流的 push 驱动 refresh owner；零点击、零手动刷新、零空闲轮询。

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function sseServer(): Promise<{ server: Server; url: string; push: (data: unknown) => void; connections: () => number }> {
  return new Promise((resolve) => {
    const sockets = new Set<import("node:http").ServerResponse>();
    const server = createServer((req, res) => {
      if (!req.url!.endsWith("/api/activity/events")) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": connected\n\n");
      sockets.add(res);
      req.on("close", () => sockets.delete(res));
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        push: (data) => { for (const s of sockets) s.write(`data: ${JSON.stringify(data)}\n\n`); },
        connections: () => sockets.size,
      });
    });
  });
}

function until(cond: () => boolean, ms = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error("condition not reached"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("S19 AM-R18——订阅路径", () => {
  it("每个推送的 oracle 变更以通知 payload 触发 onEvent（不消费活动字段）", async () => {
    const { server, url, push, connections } = await sseServer();
    const events: Array<{ type: string; seq?: number }> = [];
    const sub = subscribeActivityEvents({ open: () => fetch(`${url}/api/activity/events`), onEvent: (e) => events.push(e) });
    try {
      await until(() => connections() === 1);
      push({ type: "seat.activity_changed", seatNodeId: "node-1", seq: 7 });
      push({ type: "seat.activity_changed", seatNodeId: "node-1", seq: 8 });
      await until(() => events.length === 2);
      expect(events[0]).toMatchObject({ type: "seat.activity_changed", seq: 7 });
    } finally {
      sub.close();
      server.close();
    }
  });

  it("打开的视图自更新（by effect）：推送变更以零手动刷新重渲染 refresh owner 快照", async () => {
    const { server, url, push, connections } = await sseServer();
    let served = 1;
    const hydrate = vi.fn(async (): Promise<FleetSnapshot> => ({ ...emptySnapshot(), generatedAt: `snap-${served++}` } as unknown as FleetSnapshot));
    const frames: string[] = [];
    const live = createLiveRefresh({ hydrate, onFrame: () => frames.push("frame"), now: () => Date.now() });
    const sub = subscribeActivityEvents({ open: () => fetch(`${url}/api/activity/events`), onEvent: () => { void live.refresh(); } });
    try {
      await until(() => connections() === 1);
      expect(hydrate).not.toHaveBeenCalled(); // ZERO idle polling: nothing fires without a push
      push({ type: "seat.activity_changed", seatNodeId: "node-1", seq: 1 });
      await until(() => hydrate.mock.calls.length === 1);
      await until(() => (live.snapshot() as unknown as { generatedAt?: string }).generatedAt === "snap-1");
      // 第二次驱动变更再次更新——founder 在桌前，它跟得上：
      push({ type: "seat.activity_changed", seatNodeId: "node-1", seq: 2 });
      await until(() => hydrate.mock.calls.length === 2);
    } finally {
      sub.close();
      server.close();
    }
  });

  it("零空闲轮询回归：订阅打开且无推送时，绝不触发 hydrate", async () => {
    const { server, url, connections } = await sseServer();
    const hydrate = vi.fn(async () => emptySnapshot());
    const sub = subscribeActivityEvents({ open: () => fetch(`${url}/api/activity/events`), onEvent: () => { void hydrate(); } });
    try {
      await until(() => connections() === 1);
      await new Promise((r) => setTimeout(r, 300)); // a quiet window
      expect(hydrate).not.toHaveBeenCalled();
    } finally {
      sub.close();
      server.close();
    }
  });

  it("断线重连（连接维护，非数据轮询），推送恢复", async () => {
    const first = await sseServer();
    const events: unknown[] = [];
    const sub = subscribeActivityEvents({ open: () => fetch(`${first.url}/api/activity/events`), onEvent: (e) => events.push(e), reconnectDelayMs: 30 });
    try {
      await until(() => first.connections() === 1);
      // 丢弃所有 socket（服务器关闭连接）——订阅必须恢复。
      first.push({ type: "seat.activity_changed", seq: 1 });
      await until(() => events.length === 1);
      for (const res of [] as never[]) void res;
      await new Promise<void>((r) => { first.server.closeAllConnections(); r(); });
      await until(() => first.connections() === 0);
      // 服务器仍在监听；重连应落地一个新连接
      await until(() => first.connections() === 1, 3_000);
      first.push({ type: "seat.activity_changed", seq: 2 });
      await until(() => events.length === 2, 3_000);
    } finally {
      sub.close();
      first.server.close();
    }
  });

  it("S16 节奏对非 SSE 服务器保持：JSON 回答永久禁用该腿——一次探测，零重试", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const statuses: string[] = [];
    const open = async () => {
      const res = await fetch(`${url}/api/activity/events`, { headers: { accept: "text/event-stream" } });
      return (res.headers.get("content-type") ?? "").includes("text/event-stream") ? res : null;
    };
    const sub = subscribeActivityEvents({ open, onEvent: () => {}, onStatus: (s) => statuses.push(s), reconnectDelayMs: 20 });
    try {
      await until(() => statuses.includes("unavailable"));
      await new Promise((r) => setTimeout(r, 200)); // plenty of reconnect windows
      expect(hits).toBe(1); // exactly the feature-detect probe — never polled
    } finally {
      sub.close();
      server.close();
    }
  });

  it("无第二活动机制（trace）：main 把 pushes 接到 live.refresh，订阅模块不派生活动", () => {
    const main = readFileSync(join(repoRoot, "packages", "tui", "src", "main.ts"), "utf8");
    expect(main).toContain("subscribeActivityEvents");
    const mod = readFileSync(join(repoRoot, "packages", "tui", "src", "live-events.ts"), "utf8");
    expect(mod).not.toMatch(/working|idle-at-prompt|terminalActive/); // notification-only: no vocabulary
    expect(mod).not.toMatch(/setInterval/); // no idle timers on the data path
  });
});
