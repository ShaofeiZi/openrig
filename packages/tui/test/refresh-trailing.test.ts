import { describe, it, expect, vi } from "vitest";
import { createLiveRefresh } from "../src/live.js";
import { emptySnapshot } from "../src/state.js";
import type { FleetSnapshot } from "../src/types.js";

// WAVE O FIX R1——B3（R2 裁决 508e383d）：singleFlight 对重叠请求返回在飞 promise，
// 故 oracle push 在 hydrate 1 读其快照后、
// 但在它 settle 前到达时直接消失——打开的视图保持陈旧直到无关
// 活动，违反 AM-R18 自动更新。保留 R2 的判别器：阻塞
// hydrate 1，注入 push 回调调用的同一 live.refresh()，释放，该
// 事件必由恰一次尾部 hydrate 表示——至多一次，绝不零次。

function snap(tag: string): FleetSnapshot {
  return { ...emptySnapshot(), generatedAt: tag } as unknown as FleetSnapshot;
}

function tag(live: ReturnType<typeof createLiveRefresh>): string | undefined {
  return (live.snapshot() as unknown as { generatedAt?: string }).generatedAt;
}

describe("Wave-O B3——重叠刷新合并为一次尾随 hydrate，绝非零次", () => {
  it("R2 判别：in-flight hydrate 期间 push 落地一次带新快照的尾随 hydrate", async () => {
    let release!: () => void;
    let calls = 0;
    const hydrate = vi.fn((): Promise<FleetSnapshot> => {
      calls += 1;
      if (calls === 1) return new Promise<FleetSnapshot>((r) => { release = () => r(snap("snapshot-1")); });
      return Promise.resolve(snap(`snapshot-${calls}`));
    });
    const live = createLiveRefresh({ hydrate, onFrame: () => {}, now: () => Date.now() });

    const first = live.refresh();
    await vi.waitFor(() => expect(calls).toBe(1)); // hydrate 1 is in flight, snapshot already read
    const pushed = live.refresh();                 // the oracle push's exact call path
    release();
    await Promise.all([first, pushed]);

    expect(calls).toBe(2); // candidate: 1 — the push joined hydrate 1 and disappeared
    expect(tag(live)).toBe("snapshot-2"); // the trailing read represents the event
  });

  it("有界：一次飞行中多次 push 恰好合并为一次尾随 hydrate", async () => {
    let release!: () => void;
    let calls = 0;
    const hydrate = vi.fn((): Promise<FleetSnapshot> => {
      calls += 1;
      if (calls === 1) return new Promise<FleetSnapshot>((r) => { release = () => r(snap("snapshot-1")); });
      return Promise.resolve(snap(`snapshot-${calls}`));
    });
    const live = createLiveRefresh({ hydrate, onFrame: () => {}, now: () => Date.now() });
    const first = live.refresh();
    await vi.waitFor(() => expect(calls).toBe(1));
    const pushes = [live.refresh(), live.refresh(), live.refresh()];
    release();
    await Promise.all([first, ...pushes]);
    expect(calls).toBe(2); // one trailing run absorbs them all — bounded work
  });

  it("飞行中途无到达则无尾随 hydrate（保留零空闲工作）", async () => {
    const hydrate = vi.fn(async () => snap("only"));
    const live = createLiveRefresh({ hydrate, onFrame: () => {}, now: () => Date.now() });
    await live.refresh();
    await new Promise((r) => setTimeout(r, 50));
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  it("错误恢复经得住尾随路径：首次 hydrate 失败仍跑尾随 hydrate 且保持先前快照诚实", async () => {
    let reject!: (e: Error) => void;
    let calls = 0;
    const hydrate = vi.fn((): Promise<FleetSnapshot> => {
      calls += 1;
      if (calls === 1) return new Promise<FleetSnapshot>((_r, rej) => { reject = () => rej(new Error("boom")); });
      return Promise.resolve(snap("recovered"));
    });
    const live = createLiveRefresh({ hydrate, onFrame: () => {}, now: () => Date.now() });
    const first = live.refresh();
    await vi.waitFor(() => expect(calls).toBe(1));
    const pushed = live.refresh();
    reject(new Error("boom"));
    await Promise.all([first, pushed]); // never rejects (owner contract)
    expect(calls).toBe(2);
    expect(tag(live)).toBe("recovered");
  });
});
