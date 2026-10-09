// Preview Terminal v0（PL-018）——rate limiter 单元测试。

import { describe, it, expect } from "vitest";
import { PreviewRateLimiter } from "../src/domain/preview/preview-rate-limiter.js";

describe("PreviewRateLimiter (PL-018)", () => {
  it("首次查询未见过的 key 时返回 null", () => {
    const r = new PreviewRateLimiter<string>(1000);
    expect(r.get("velocity-driver@x")).toBeNull();
  });

  it("在 rate-limit 窗口内返回缓存 payload", () => {
    let now = 1000;
    const r = new PreviewRateLimiter<string>(500, () => now);
    r.set("k", "first");
    now = 1100;
    expect(r.get("k")?.payload).toBe("first");
    now = 1499;
    expect(r.get("k")?.payload).toBe("first");
  });

  it("窗口结束后返回 null", () => {
    let now = 1000;
    const r = new PreviewRateLimiter<string>(500, () => now);
    r.set("k", "first");
    now = 1501;
    expect(r.get("k")).toBeNull();
  });

  it("将同一 key 的并发请求合并为一次 cache hit", () => {
    let now = 1000;
    const r = new PreviewRateLimiter<string>(1000, () => now);
    r.set("k", "first");
    // 窗口内快速跟进的请求都看到缓存 payload。
    expect(r.get("k")?.payload).toBe("first");
    now = 1500;
    expect(r.get("k")?.payload).toBe("first");
  });

  it("clear 移除缓存条目", () => {
    let now = 1000;
    const r = new PreviewRateLimiter<string>(1000, () => now);
    r.set("k", "v");
    r.clear("k");
    expect(r.get("k")).toBeNull();
  });

  it("不同 key 拥有独立窗口", () => {
    let now = 1000;
    const r = new PreviewRateLimiter<string>(500, () => now);
    r.set("a", "alpha");
    now = 1100;
    r.set("b", "beta");
    now = 1499;
    expect(r.get("a")?.payload).toBe("alpha");
    expect(r.get("b")?.payload).toBe("beta");
    now = 1501;
    // a 已过期（始于 1000），但 b（始于 1100）仍 fresh。
    expect(r.get("a")).toBeNull();
    expect(r.get("b")?.payload).toBe("beta");
  });
});
