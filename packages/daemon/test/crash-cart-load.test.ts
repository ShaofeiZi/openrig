import { describe, it, expect, vi } from "vitest";
import type BetterSqlite3 from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import {
  loadCrashCartDiscovery,
  DaemonLiveError,
  CrashCartReadError,
} from "../src/domain/crash-cart-discovery.js";

// 故障诊断 C2——组合编排器：先执行失败关闭防护，再复制后读取 discovery 视图，并且始终
// 清理临时副本。所有 IO 均通过注入提供 → 测试完全隔离。

function seededDb(): BetterSqlite3.Database {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  db.prepare("INSERT INTO rigs (id, name) VALUES ('r1','alpha')").run();
  db.prepare("INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n1','r1','worker')").run();
  return db;
}

function baseDeps(over: Record<string, unknown> = {}) {
  return {
    openrigHome: "/scratch/.openrig",
    readDaemonJson: () => ({ pid: 9, port: 7433, db: "/scratch/.openrig/openrig.sqlite" }),
    isProcessAlive: () => false,
    probeHealthz: async () => false,
    openrigUrl: undefined as string | undefined,
    copyFile: vi.fn(),
    exists: () => true,
    makeScratchDir: vi.fn(() => "/scratch/tmp/cc-xyz"),
    removeScratchDir: vi.fn(),
    openDb: vi.fn(() => seededDb()),
    ...over,
  };
}

describe("loadCrashCartDiscovery——优先失败关闭，并始终清理", () => {
  it("空的私有实例不会借用无关默认后台服务的身份", async () => {
    const probeHealthz = vi.fn(async (url: string) => url.includes(":7433/"));
    const deps = baseDeps({ readDaemonJson: () => undefined, exists: () => false,
      openrigUrl: "http://127.0.0.1:17433", probeHealthz });
    const result = await loadCrashCartDiscovery(deps);
    expect(result.discovery.foundOnHost).toEqual([]);
    expect(result.discovery.header.hostId).toBeNull();
    expect(probeHealthz).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:17433/healthz");
    expect(deps.makeScratchDir).not.toHaveBeenCalled();
  });
  it("显式目标不会覆盖本地数据库中记录的存活所有者", async () => {
    const deps = baseDeps({ openrigUrl: "http://127.0.0.1:17433", isProcessAlive: () => true });
    await expect(loadCrashCartDiscovery(deps)).rejects.toBeInstanceOf(DaemonLiveError);
    expect(deps.makeScratchDir).not.toHaveBeenCalled();
  });
  it("后台服务首次留下启动记录前使用已配置的数据库", async () => {
    const deps = baseDeps({ readDaemonJson: () => undefined, configuredDbPath: "/private/custom.sqlite" });
    const result = await loadCrashCartDiscovery(deps);
    expect(result.dbPath.path).toBe("/private/custom.sqlite");
    expect(deps.copyFile).toHaveBeenCalledWith("/private/custom.sqlite", "/scratch/tmp/cc-xyz/custom.sqlite");
  });
  it("不会把权限失败解释为空实例", async () => {
    const deps = baseDeps({ readDaemonJson: () => undefined, exists: () => { throw new Error("EACCES"); } });
    await expect(loadCrashCartDiscovery(deps)).rejects.toThrow("EACCES");
    expect(deps.makeScratchDir).not.toHaveBeenCalled();
  });
  it("记录的数据库缺失时仍视为读取失败，而非首次设置", async () => {
    const deps = baseDeps({ exists: () => false });
    await expect(loadCrashCartDiscovery(deps)).rejects.toBeInstanceOf(CrashCartReadError);
  });
  it("后台服务存活时，在创建临时目录或副本前以 DaemonLiveError 拒绝", async () => {
    const deps = baseDeps({ isProcessAlive: () => true });
    await expect(loadCrashCartDiscovery(deps)).rejects.toBeInstanceOf(DaemonLiveError);
    expect(deps.makeScratchDir).not.toHaveBeenCalled();
    expect(deps.copyFile).not.toHaveBeenCalled();
    expect(deps.removeScratchDir).not.toHaveBeenCalled();
  });

  it("正常路径：返回 discovery 视图并清理临时目录", async () => {
    const deps = baseDeps();
    const { discovery, dbPath } = await loadCrashCartDiscovery(deps);
    expect(dbPath.path).toBe("/scratch/.openrig/openrig.sqlite");
    expect(discovery.foundOnHost).toHaveLength(1);
    expect(discovery.foundOnHost[0].rigId).toBe("r1");
    expect(discovery.header.stopReason).toBeNull();
    expect(deps.makeScratchDir).toHaveBeenCalledTimes(1);
    expect(deps.removeScratchDir).toHaveBeenCalledWith("/scratch/tmp/cc-xyz");
  });

  it("即使读取抛出异常也清理临时目录", async () => {
    const deps = baseDeps({
      openDb: () => {
        throw new Error("open failed");
      },
    });
    await expect(loadCrashCartDiscovery(deps)).rejects.toThrow("open failed");
    expect(deps.removeScratchDir).toHaveBeenCalledWith("/scratch/tmp/cc-xyz");
  });

  it("拒绝 daemon.json 中的相对数据库路径（无法定位已停止的后台服务）", async () => {
    const deps = baseDeps({ readDaemonJson: () => ({ pid: 9, port: 7433, db: "openrig.sqlite" }) });
    await expect(loadCrashCartDiscovery(deps)).rejects.toBeInstanceOf(CrashCartReadError);
    expect(deps.makeScratchDir).not.toHaveBeenCalled();
  });
});
