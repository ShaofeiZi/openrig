// 规范库中的工作流 + 激活透镜 v0——活跃透镜存储测试。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActiveLensStore } from "../src/domain/active-lens-store.js";

describe("ActiveLensStore（规范库中的工作流 v0）", () => {
  let tmp: string;
  let filePath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "active-lens-"));
    filePath = join(tmp, "active-workflow-lens.json");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("透镜文件不存在时返回 null", () => {
    const store = new ActiveLensStore({ filePath });
    expect(store.get()).toBeNull();
  });

  it("set 会持久化名称、版本和 activatedAt 时间戳", () => {
    const store = new ActiveLensStore({
      filePath,
      now: () => new Date("2026-05-04T12:34:56Z"),
    });
    const lens = store.set("conveyor", "1");
    expect(lens.specName).toBe("conveyor");
    expect(lens.specVersion).toBe("1");
    expect(lens.activatedAt).toBe("2026-05-04T12:34:56.000Z");

    const re = store.get();
    expect(re).toEqual(lens);
  });

  it("set 会替换现有透镜（单活不变量）", () => {
    const store = new ActiveLensStore({ filePath });
    store.set("first", "1");
    store.set("second", "2");
    const lens = store.get();
    expect(lens?.specName).toBe("second");
    expect(lens?.specVersion).toBe("2");
  });

  it("clear 会删除透镜文件", () => {
    const store = new ActiveLensStore({ filePath });
    store.set("foo", "1");
    expect(existsSync(filePath)).toBe(true);
    store.clear();
    expect(existsSync(filePath)).toBe(false);
    expect(store.get()).toBeNull();
  });

  it("文件不存在时 clear 为空操作", () => {
    const store = new ActiveLensStore({ filePath });
    expect(() => store.clear()).not.toThrow();
  });

  it("JSON 格式错误时返回 null", () => {
    writeFileSync(filePath, "{not-json", "utf-8");
    const store = new ActiveLensStore({ filePath });
    expect(store.get()).toBeNull();
  });

  it("存储对象缺少 specName/specVersion 时返回 null", () => {
    writeFileSync(filePath, JSON.stringify({ activatedAt: "2026-01-01T00:00:00Z" }), "utf-8");
    const store = new ActiveLensStore({ filePath });
    expect(store.get()).toBeNull();
  });

  it("首次 set 时延迟创建父目录", () => {
    const nested = join(tmp, "does", "not", "exist", "lens.json");
    const store = new ActiveLensStore({ filePath: nested });
    store.set("foo", "1");
    expect(existsSync(nested)).toBe(true);
  });
});
