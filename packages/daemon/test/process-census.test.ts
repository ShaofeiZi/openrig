// OPR.0.5.3.10 mini-req 3——普查契约：合并、新鲜度复用与诚实失败。
// 通过注入 lister 与 clock 保持确定性。
import { describe, it, expect, vi } from "vitest";
import { ProcessCensus } from "../src/domain/process-census.js";

const ROWS = [{ pid: 1, ppid: 0, command: "init" }];

describe("ProcessCensus", () => {
  it("把并发调用方合并到同一个在途枚举", async () => {
    let release!: (rows: typeof ROWS) => void;
    const list = vi.fn(() => new Promise<typeof ROWS>((r) => { release = r; }));
    const census = new ProcessCensus({ list, now: () => 0 });
    const a = census.list();
    const b = census.list();
    release(ROWS);
    expect(await a).toBe(ROWS);
    expect(await b).toBe(ROWS);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("在新鲜度窗口内复用最近成功的普查，窗口后重新获取", async () => {
    let t = 0;
    const list = vi.fn(async () => ROWS);
    const census = new ProcessCensus({ list, freshnessMs: 1000, now: () => t });
    await census.list();
    t = 900;
    await census.list();
    expect(list).toHaveBeenCalledTimes(1);
    t = 1001;
    await census.list();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("枚举失败会拒绝所有合并调用方、不缓存结果，下一次调用重试", async () => {
    let calls = 0;
    const list = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("ps ENOMEM");
      return ROWS;
    });
    const census = new ProcessCensus({ list, freshnessMs: 60_000, now: () => 0 });
    const a = census.list();
    const b = census.list();
    await expect(a).rejects.toThrow("ps ENOMEM");
    await expect(b).rejects.toThrow("ps ENOMEM");
    // 失败没有被缓存成成功；下一次调用会真实重试。
    expect(await census.list()).toBe(ROWS);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("cycleLister：每轮最多一次底层普查且延迟执行；空闲轮次不 spawn 任何内容", async () => {
    const list = vi.fn(async () => ROWS);
    const census = new ProcessCensus({ list, freshnessMs: 0, now: (() => { let t = 0; return () => (t += 10_000); })() });
    const idle = census.cycleLister();
    void idle; // never invoked — no census
    expect(list).toHaveBeenCalledTimes(0);
    const cycle = census.cycleLister();
    await cycle();
    await cycle();
    await cycle();
    // 时钟前进会使新鲜度窗口失效，但本轮 memo 仍保持一次 fetch。
    expect(list).toHaveBeenCalledTimes(1);
    // 新一轮会再次 fetch，因为窗口已陈旧。
    await census.cycleLister()();
    expect(list).toHaveBeenCalledTimes(2);
  });
});
