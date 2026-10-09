import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import {
  resolveDaemonDbPath,
  snapshotDaemonDb,
  openDaemonDbReadonly,
  CrashCartReadError,
} from "../src/domain/crash-cart-discovery.js";

// Crash-cart C2 关键证明（架构 a1344201 Q1 + PM 门禁）：把 {db,-wal,-shm} 三件套复制到 scratch，
// 打开副本后由 SQLite 在副本上重放 WAL，得到包含崩溃前最后 frame 的新鲜视图，并且完全不干扰
// 重启后台服务将重新打开的原文件。使用真实 better-sqlite3 与真实文件；这是“已证明在副本上重放
// WAL”的证据，不是 mock。

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratch(prefix = "cc-cr-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
const sha = (p: string): string =>
  existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "ABSENT";

describe("先复制再读取——在副本上重放 WAL，原文件不受影响", () => {
  it("副本可见 WAL 最后提交行，单独 main 文件不可见，读取后原文件逐字节一致", () => {
    const dir = scratch();
    const dbPath = join(dir, "openrig.sqlite");
    // WAL 模式 DB 含一条已提交但未 checkpoint 的行；writer 保持打开，使 frame 留在 -wal，
    // 模拟崩溃时最后 frame 尚未重放进 main.db。
    const writer = createDb(dbPath);
    writer.exec("CREATE TABLE t (x INTEGER)");
    writer.prepare("INSERT INTO t (x) VALUES (7)").run();
    expect(existsSync(dbPath + "-wal")).toBe(true);
    expect(existsSync(dbPath + "-shm")).toBe(true);

    const originals = [dbPath, dbPath + "-wal", dbPath + "-shm"];
    const before = originals.map(sha);

    // (A) 复制完整三件套并打开副本，WAL frame 重放后该行存在且新鲜。
    const scratchDir = scratch("cc-copy-");
    const copyDb = snapshotDaemonDb(dbPath, scratchDir, { copyFile: copyFileSync, exists: existsSync });
    const ro = openDaemonDbReadonly(copyDb);
    expect(ro.prepare("SELECT x FROM t").get()).toEqual({ x: 7 });
    ro.close();

    // (B) 单独 main.db（无 -wal）不含这些 frame，证明它们位于 WAL 而非 main.db。
    const mainOnly = join(scratch("cc-main-"), "openrig.sqlite");
    copyFileSync(dbPath, mainOnly);
    const roMain = new Database(mainOnly, { readonly: true });
    expect(() => roMain.prepare("SELECT x FROM t").get()).toThrow(); // 表本身也只存在于 WAL。
    roMain.close();

    // (C) 读取只接触副本；原文件逐字节一致（只读、无干扰）。
    const afterReads = originals.map(sha);
    expect(afterReads).toEqual(before);

    writer.close(); // only now may the originals legitimately change (checkpoint on close)
  });

  it("snapshotDaemonDb 只复制存在的 sidecar，DB 缺失时明确失败", () => {
    const dir = scratch();
    const dbPath = join(dir, "openrig.sqlite");
    const w = createDb(dbPath);
    w.exec("CREATE TABLE t (x INTEGER)");
    w.pragma("wal_checkpoint(TRUNCATE)"); // flush + truncate the -wal so it is empty/absent-ish
    w.close();

    const out = scratch("cc-copy2-");
    const copyDb = snapshotDaemonDb(dbPath, out, { copyFile: copyFileSync, exists: existsSync });
    expect(existsSync(copyDb)).toBe(true); // DB 始终会被复制。
    const ro = openDaemonDbReadonly(copyDb);
    expect(ro.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 0 });
    ro.close();

    expect(() =>
      snapshotDaemonDb(join(dir, "nope.sqlite"), out, { copyFile: copyFileSync, exists: existsSync }),
    ).toThrow(CrashCartReadError);
  });
});

describe("resolveDaemonDbPath——优先 daemon.json.db，并标记相对路径", () => {
  it("状态文件含绝对 DB 路径时使用该路径", () => {
    const r = resolveDaemonDbPath("/home/.openrig", () => ({
      pid: 1,
      port: 7433,
      db: "/home/.openrig/openrig.sqlite",
    }));
    expect(r).toEqual({ path: "/home/.openrig/openrig.sqlite", fromStateFile: true, relative: false });
  });

  it("标记状态文件中的相对 DB 路径（后台服务 CWD 未知，调用方必须处理）", () => {
    const r = resolveDaemonDbPath("/home/.openrig", () => ({ pid: 1, port: 7433, db: "openrig.sqlite" }));
    expect(r.fromStateFile).toBe(true);
    expect(r.relative).toBe(true);
  });

  it("没有状态文件时回退到 $OPENRIG_HOME/openrig.sqlite", () => {
    const r = resolveDaemonDbPath("/home/.openrig", () => undefined);
    expect(r).toEqual({ path: "/home/.openrig/openrig.sqlite", fromStateFile: false, relative: false });
  });
});
