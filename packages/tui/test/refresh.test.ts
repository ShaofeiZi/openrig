import { describe, expect, it } from "vitest";
import { singleFlight } from "../src/refresh.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("单飞快照刷新", () => {
  it("把重叠 tick 合并为一次尾随遍次，提交更新真相（Wave-O B3, R2 508e383d——旧 join-the-flight 语义丢了事件）", async () => {
    const firstRead = deferred<string>();
    const commits: string[] = [];
    let hydrateCalls = 0;
    const refresh = singleFlight(async () => {
      hydrateCalls++;
      const snapshot = hydrateCalls === 1 ? await firstRead.promise : "item-6";
      commits.push(snapshot);
    });

    const first = refresh();
    const overlap = refresh();
    expect(overlap).toBe(first); // the caller still shares the flight's settlement…
    expect(hydrateCalls).toBe(1);

    firstRead.resolve("item-7");
    await Promise.all([first, overlap]);
    // …但重叠被表示：恰有一次尾部 pass 提交更新的真值。
    expect(hydrateCalls).toBe(2);
    expect(commits).toEqual(["item-7", "item-6"]);

    await refresh();
    expect(hydrateCalls).toBe(3); // a fresh quiet tick runs exactly once — no residual dirt
  });

  it("拒绝后释放守卫，下次 tick 重试", async () => {
    let attempts = 0;
    const refresh = singleFlight(async () => {
      attempts++;
      if (attempts === 1) throw new Error("hydrate failed");
    });

    await expect(refresh()).rejects.toThrow("hydrate failed");
    await expect(refresh()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});
