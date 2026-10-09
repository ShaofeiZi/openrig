// S19 ROUND-5（guard 在 b92c2a58 NOT-CLEAR，qitem e858ee70）：motion 骑其
// 真实生命周期/事件 owner。这些锚点穿过 refresh owner 本身——
// 组件 main.ts 接在 hydrateSnapshot 与 terminal 之间——证明
// start → in-flight → settle、rejection-release/retry，以及每席
// pane-output 事件身份（服务 terminalActive false→true），非
// 伪造的 render 选项。
import { describe, it, expect } from "vitest";
import { createLiveRefresh, FLASH_WINDOW_MS } from "../src/live.js";
import { demoSnapshot } from "../src/demo-data.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import type { FleetSnapshot } from "../src/types.js";

const DRIVER_KEY = "agent:vm-host/openrig-build/dev50/dev50.driver";

/** 带每 agent 服务 pane-activity 的 demo snapshot（terminalActive 逐字） */
function snapWithPanes(panes: Record<string, boolean | null>): FleetSnapshot {
  const snap = structuredClone(demoSnapshot());
  for (const host of snap.hosts)
    for (const rig of host.rigs)
      for (const pod of rig.pods)
        for (const agent of pod.agents)
          if (agent.name in panes) agent.paneActive = panes[agent.name];
  return snap;
}

function sequenced(snaps: FleetSnapshot[]): () => Promise<FleetSnapshot> {
  let i = 0;
  return () => Promise.resolve(snaps[Math.min(i++, snaps.length - 1)]!);
}

describe("refresh owner——加载生命周期（guard round-5 finding 1）", () => {
  it("refresh START 暴露 in-flight（立即绘制），SETTLE 清除并替换快照", async () => {
    let release!: (s: FleetSnapshot) => void;
    const gate = new Promise<FleetSnapshot>((r) => { release = r; });
    const frames: Array<{ inFlight: boolean; settled: boolean }> = [];
    const live = createLiveRefresh({ hydrate: () => gate, onFrame: () => frames.push(live.load()), now: () => 0 });
    // 任何 refresh 前：尚无应答——未 settle，也不在飞
    expect(live.load()).toEqual({ inFlight: false, settled: false });
    const done = live.refresh();
    expect(live.load()).toEqual({ inFlight: true, settled: false });
    expect(frames).toEqual([{ inFlight: true, settled: false }]); // the loading frame IS drawn
    release(demoSnapshot());
    await done;
    expect(live.load()).toEqual({ inFlight: false, settled: true, stale: false, lastSuccessAt: 0 });
    expect(frames).toHaveLength(2); // the settle frame is drawn too
    expect(live.snapshot().hosts.length).toBeGreaterThan(0);
  });

  it("被 REJECTED 的 hydrate 释放 in-flight、保留先前快照，后续刷新重试", async () => {
    let fail = true;
    const live = createLiveRefresh({
      hydrate: () => (fail ? Promise.reject(new Error("daemon unreachable")) : Promise.resolve(demoSnapshot())),
      onFrame: () => {},
      now: () => 0,
    });
    await live.refresh(); // must resolve — never an unhandled rejection
    expect(live.load()).toEqual({ inFlight: false, settled: true, stale: true });
    expect(live.snapshot().hosts).toEqual([]); // prior (empty) retained, nothing fabricated
    fail = false;
    await live.refresh(); // retry path works
    expect(live.snapshot().hosts.length).toBeGreaterThan(0);
  });
});

describe("经 OWNER 的 COLD START 根 topology——guard round-6 finding 1（无 rig 分支消费加载真相）", () => {
  const BRAILLE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] 拓扑 读取挂起/;
  function composed(live: ReturnType<typeof createLiveRefresh>, opts?: { colorMode?: "truecolor" | "16" }) {
    // 应用真实默认入口：空 snapshot，默认 Topology
    // 视图——正是首次 hydrate settle 前 main.ts 所绘
    const s = createViewState({ instanceId: "cold", getSnapshot: () => live.snapshot() });
    return (nowMs: number) =>
      renderScreen(s.get(), live.snapshot(), { cols: 140, rows: 34, nowMs, colorMode: opts?.colorMode ?? "truecolor", load: live.load() });
  }

  it("真实 in-flight cold start 在根渲染 braille spinner、跨帧动画，并标 motion-active", async () => {
    let release!: (s: FleetSnapshot) => void;
    const gate = new Promise<FleetSnapshot>((r) => { release = r; });
    const live = createLiveRefresh({ hydrate: () => gate, onFrame: () => {}, now: () => 0 });
    const done = live.refresh();
    const frame = composed(live);
    const f0 = frame(0);
    const l0 = f0.lines.find((l) => l.includes("读取挂起"))!;
    expect(l0).toMatch(BRAILLE);
    expect(frame(500).lines.find((l) => l.includes("读取挂起"))!).not.toBe(l0); // approved 2 fps frame phase
    expect(f0.motionActive).toBe(true);
    // 16 色回退在同一真实路径渲染 LINE spinner
    expect(composed(live, { colorMode: "16" })(0).lines.find((l) => l.includes("读取挂起"))!).toMatch(/[|/\-\\] 拓扑 读取挂起/);
    release(demoSnapshot());
    await done;
    expect(frame(0).lines.join("\n")).not.toMatch(/读取挂起/); // settled rigs render, no pending claim
  });

  it("settle-success-EMPTY renders the static proven-no-rigs truth — never '等待中', never a spinner", async () => {
    const live = createLiveRefresh({ hydrate: () => Promise.resolve(emptySnapshot()), onFrame: () => {}, now: () => 0 });
    await live.refresh();
    const screen = composed(live)(0);
    const line = screen.lines.find((l) => l.includes("未服务工作组"))!;
    expect(line).toMatch(/未服务工作组 — 已证明为空/);
    expect(screen.lines.join("\n")).not.toMatch(/读取挂起|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(screen.motionActive).toBeFalsy();
  });

  it("settle-NAMED-FAILURE renders the static rigs-summary failure — never '等待中', never a spinner", async () => {
    const failed = emptySnapshot();
    failed.readErrors.push("rigs-summary: connect ECONNREFUSED");
    const live = createLiveRefresh({ hydrate: () => Promise.resolve(failed), onFrame: () => {}, now: () => 0 });
    await live.refresh();
    const screen = composed(live)(0);
    expect(screen.lines.find((l) => l.includes("工作组读取"))!).toMatch(/✕ 工作组读取失败/);
    expect(screen.lines.join("\n")).not.toMatch(/读取挂起|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(screen.motionActive).toBeFalsy();
  });

  it("reduced motion 在 in-flight cold start 渲染诚实静态加载标记，无 motion-active", async () => {
    let release!: (s: FleetSnapshot) => void;
    const gate = new Promise<FleetSnapshot>((r) => { release = r; });
    const live = createLiveRefresh({ hydrate: () => gate, onFrame: () => {}, now: () => 0 });
    const done = live.refresh();
    process.env["OPENRIG_REDUCED_MOTION"] = "1";
    try {
      const screen = composed(live)(0);
      expect(screen.lines.find((l) => l.includes("读取挂起"))!).toMatch(/· 拓扑 读取挂起/);
      expect(screen.motionActive).toBeFalsy();
    } finally {
      delete process.env["OPENRIG_REDUCED_MOTION"];
    }
    release(demoSnapshot());
    await done;
  });
});

describe("refresh owner——新鲜 pane-output 事件身份（guard round-5 finding 2）", () => {
  it("首次 hydrate 绝不闪烁：加载不是新鲜输出", async () => {
    const live = createLiveRefresh({
      hydrate: () => Promise.resolve(snapWithPanes({ "dev50.driver": true, "dev50.guard": true })),
      onFrame: () => {},
      now: () => 1000,
    });
    await live.refresh();
    expect(live.flashes()).toEqual([]);
  });

  it("served terminalActive false→true 恰好闪烁该 agent 的行键；true→true 与 null→true 绝不闪烁", async () => {
    const live = createLiveRefresh({
      hydrate: sequenced([
        snapWithPanes({ "dev50.driver": false, "dev50.guard": true, "dev50.qa": null }),
        snapWithPanes({ "dev50.driver": true, "dev50.guard": true, "dev50.qa": true }),
      ]),
      onFrame: () => {},
      now: () => 5000,
    });
    await live.refresh();
    await live.refresh();
    expect(live.flashes()).toEqual([{ key: DRIVER_KEY, at: 5000 }]);
  });

  it("环境 rig-stream 尾部不是闪烁源（round-4 接线已拒绝：事件身份）", async () => {
    const base = snapWithPanes({ "dev50.driver": true });
    const streamed = structuredClone(base);
    streamed.stream.push({ tsEmitted: "2026-08-04T09:00:00Z", sourceSession: "someone@somewhere", body: "ambient chatter" });
    const live = createLiveRefresh({ hydrate: sequenced([base, streamed]), onFrame: () => {}, now: () => 5000 });
    await live.refresh();
    await live.refresh();
    expect(live.flashes()).toEqual([]);
  });

  it("过期闪烁在下次刷新被修剪（一次性，绝不增长列表）", async () => {
    let now = 0;
    const live = createLiveRefresh({
      hydrate: sequenced([
        snapWithPanes({ "dev50.driver": false }),
        snapWithPanes({ "dev50.driver": true }),
        snapWithPanes({ "dev50.driver": true }),
      ]),
      onFrame: () => {},
      now: () => now,
    });
    await live.refresh();
    now = 100;
    await live.refresh();
    expect(live.flashes()).toEqual([{ key: DRIVER_KEY, at: 100 }]);
    now = 100 + FLASH_WINDOW_MS + 1;
    await live.refresh();
    expect(live.flashes()).toEqual([]);
  });
});
