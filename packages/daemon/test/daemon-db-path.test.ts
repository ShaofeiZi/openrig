import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { resolveDaemonDbPath } from "../src/daemon-db-path.js";

describe("resolveDaemonDbPath——D15：db 从 OPENRIG_HOME 派生，绝不相对于 CWD", () => {
  it("OPENRIG_DB 未设置时在 OPENRIG_HOME 下派生 db，而不是裸 CWD 相对文件名", () => {
    const p = resolveDaemonDbPath(undefined, "/scratch/home");
    // 事故复盘：裸 'openrig.sqlite' 会相对进程 CWD 解析，可能落到共享机队 db。默认路径必须
    // 锚定 home。
    expect(p).toBe("/scratch/home/openrig.sqlite");
    expect(p).not.toBe("openrig.sqlite");
    expect(p.startsWith("/")).toBe(true); // 绝对路径，不依赖 CWD。
  });

  it("即使 CWD 相同，不同 OPENRIG_HOME 也会隔离两个后台服务", () => {
    expect(resolveDaemonDbPath(undefined, "/tmp/iso-a")).toBe("/tmp/iso-a/openrig.sqlite");
    expect(resolveDaemonDbPath(undefined, "/home/fleet")).toBe("/home/fleet/openrig.sqlite");
  });

  it("逐字遵循显式 OPENRIG_DB 路径", () => {
    expect(resolveDaemonDbPath("/iso/custom.sqlite", "/scratch/home")).toBe("/iso/custom.sqlite");
  });

  it("把空 OPENRIG_DB 视为未设置，并回退到锚定 home 的默认值", () => {
    expect(resolveDaemonDbPath("", "/scratch/home")).toBe("/scratch/home/openrig.sqlite");
  });

  it("隐式数据库经 symlink 解析到 OPENRIG_HOME 外时明确失败", () => {
    const root = mkdtempSync(join(tmpdir(), "openrig-db-home-guard-"));
    const home = join(root, "home");
    const outsideDb = join(root, "shared.sqlite");
    try {
      // home 内文件名只在词法上位于本地；跟随它会到达共享状态。环境隐式路径绝不能获得该权限。
      mkdirSync(home);
      writeFileSync(outsideDb, "shared fleet sentinel");
      symlinkSync(outsideDb, join(home, "openrig.sqlite"));
      let message = "";
      try {
        resolveDaemonDbPath(undefined, home);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toMatch(/outside|escape|OPENRIG_HOME/i);
      expect(message).toContain(realpathSync(home));
      expect(message).toContain(realpathSync(outsideDb));
      expect(readFileSync(outsideDb, "utf-8")).toBe("shared fleet sentinel");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("把显式的外部 OPENRIG_DB 保留为有意的 split-path 覆盖", () => {
    const root = mkdtempSync(join(tmpdir(), "openrig-db-explicit-"));
    const home = join(root, "home");
    const explicitDb = join(root, "shared", "fleet.sqlite");
    try {
      mkdirSync(home);
      mkdirSync(join(root, "shared"));
      const resolved = resolveDaemonDbPath(explicitDb, home);
      const db = new Database(resolved);
      db.exec("CREATE TABLE effect_evidence (value TEXT NOT NULL); INSERT INTO effect_evidence VALUES ('split path used')");
      db.close();

      expect(resolved).toBe(explicitDb);
      expect(existsSync(explicitDb)).toBe(true);
      const verify = new Database(explicitDb, { readonly: true });
      expect(verify.prepare("SELECT value FROM effect_evidence").pluck().get()).toBe("split path used");
      verify.close();
      expect(existsSync(join(home, "openrig.sqlite"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("不会把非目录路径组件重新解释为缺失尾部", () => {
    const root = mkdtempSync(join(tmpdir(), "openrig-db-nondir-"));
    const notAHome = join(root, "not-a-directory");
    try {
      writeFileSync(notAHome, "not a directory");
      expect(() => resolveDaemonDbPath(undefined, notAHome)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
