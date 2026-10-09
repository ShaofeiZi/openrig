// Founder 优先级热修（行 qitem-20260822230440-da0d2ad6，FIX 2；形状来自
// 行 9e0a051e）：createTestApp 留 `permissionDriftObserver` undefined，于是
// server.ts 的 createApp 构造了 PRODUCTION PermissionDriftObserver——其构造函数预热
// ClaudePermissionModeCache，后者 shell 出 `claude --help`。在 daemon 套件中那是 46 个
// 并发测试文件发起的 162 次真实 claude 启动：一个烧穿两台机器的 hermeticity 漏洞。
//
// 本钉死：构建测试 app 绝不能 exec 真实 runtime 二进制。drift-observer 自己的测试直接显式
// 构造该类——那仍是测试中通向生产 observer 的唯一认可路径。
import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";

const execFileCalls: unknown[][] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: ((...args: unknown[]) => {
      execFileCalls.push(args);
      const cb = args[args.length - 1];
      if (typeof cb === "function") (cb as (err: Error) => void)(new Error("hermetic-block"));
      return undefined as never;
    }) as typeof actual.execFile,
  };
});

import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("test-app hermeticity——测试工具自身不启动真实 runtime 二进制", () => {
  let db: Database.Database;

  beforeEach(() => {
    execFileCalls.length = 0;
    db = createFullTestDb();
  });

  it("createTestApp 仅被构造就绝不启动真实 `claude`（或任何）二进制", async () => {
    const { app } = createTestApp(db);
    // 一个普通请求，使懒构造的路由依赖也被走到。
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);

    const claudeCalls = execFileCalls.filter((args) => args[0] === "claude");
    expect(claudeCalls).toEqual([]);
    expect(execFileCalls).toEqual([]);
  });

  it("显式注入的 drift observer 仍能进 app（opt-in 路径保持开放）", async () => {
    const diagnose = vi.fn(() => null);
    const { app } = createTestApp(db, { permissionDriftObserver: { diagnose } });
    expect(app).toBeDefined();
    expect(execFileCalls).toEqual([]);
  });

  it("机制钉死（r1 Finding 1）：构造 PRODUCTION observer 本身不 exec 任何东西——恢复 eager warm 会在此转 RED", async () => {
    // r1 的三路判别证明上面那条钉死单靠任一修复机制就能过：回退构造函数的 eager cache-warm
    //（那个砍掉套件 162 次启动中约 92 次的改动）会在 createTestApp null-observer 安全带
    // 后面保持绿。本测试直接钉死根因改动：observer 唯一的 child_process 用途是 mode-cache
    // loader 里的 execFile("claude", ["--help"])，因此此处为零是机制本身，不是邻居。
    const { PermissionDriftObserver } = await import("../src/domain/permission-drift-observer.js");
    const observer = new PermissionDriftObserver({ db });
    expect(observer).toBeDefined();
    expect(execFileCalls).toEqual([]);
  });
});
