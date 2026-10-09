import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { CmuxAdapter } from "../src/adapters/cmux.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("Adapter 路由", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createFullTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("GET /api/adapters/tmux/sessions → tmux session 列表", async () => {
    const tmuxExec: ExecFn = async () => "my-session|2|2026-03-23|1\n";
    const tmux = new TmuxAdapter(tmuxExec);

    const { app } = createTestApp(db, { tmux });
    const res = await app.request("/api/adapters/tmux/sessions");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("my-session");
  });

  it("connect() 后 GET /api/adapters/cmux/status → capabilities", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => ({
      request: async (method: string) => {
        if (method === "capabilities") return { capabilities: ["workspace.list", "surface.focus"] };
        return {};
      },
      close: () => {},
    });
    const cmux = new CmuxAdapter(cmuxFactory, { timeoutMs: 1000 });
    await cmux.connect();

    const { app } = createTestApp(db, { cmux });
    const res = await app.request("/api/adapters/cmux/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(true);
    expect(body.capabilities["workspace.list"]).toBe(true);
  });

  it("GET /api/adapters/cmux/status 每个请求都 live-probe，不缓存", async () => {
    let callCount = 0;
    const cmuxFactory: CmuxTransportFactory = async () => {
      callCount++;
      if (callCount <= 2) {
        // 前两次调用成功（初始 connect + 第一次 status 请求 probe）
        return {
          request: async (method: string) => {
            if (method === "capabilities") return { capabilities: ["surface.focus"] };
            return {};
          },
          close: () => {},
        };
      }
      // 后续调用失败（模拟 cmux 离开）
      throw new Error("cmux socket gone");
    };
    const cmux = new CmuxAdapter(cmuxFactory, { timeoutMs: 1000 });
    await cmux.connect(); // callCount = 1

    const { app } = createTestApp(db, { cmux });

    // 第一次 status 请求——应 live-probe 并返回 available=true
    const res1 = await app.request("/api/adapters/cmux/status");
    expect(res1.status).toBe(200);
    const body1 = await res1.json() as Record<string, unknown>;
    expect(body1["available"]).toBe(true);

    // 第二次 status 请求——factory 现在失败，live probe 应检测到 unavailable
    const res2 = await app.request("/api/adapters/cmux/status");
    expect(res2.status).toBe(200); // 即便 probe 失败也 HTTP 200
    const body2 = await res2.json() as Record<string, unknown>;
    expect(body2["available"]).toBe(false);
  });

  it("GET /api/adapters/cmux/status cmux 不可用 → { available: false }", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const cmux = new CmuxAdapter(cmuxFactory, { timeoutMs: 50 });
    await cmux.connect();

    const { app } = createTestApp(db, { cmux });
    const res = await app.request("/api/adapters/cmux/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(false);
    expect(body.capabilities).toEqual({});
  });
});
