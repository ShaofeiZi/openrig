// B1 ROUND 2——TUI 自有生命周期。对 r2 探针的判别器：
//  HIGH-3：MID-RUN 帧可观察（onFrame 在未完成 poll 上触发，带渐进计数），
//          非仅完成时。
//  HIGH-1：操作者请求时 cancel 带保留的 attempt id 到达端点。
import { describe, it, expect, vi } from "vitest";
import { driveRestoreLifecycle, type RestoreLifecycleClient } from "../src/crash-cart/restore-lifecycle.js";
import type { RestoreFleetStatus } from "../src/daemon-client.js";

function status(over: Partial<RestoreFleetStatus> & { counts?: Partial<RestoreFleetStatus["rollup"]["counts"]> }): RestoreFleetStatus {
  return {
    done: over.done ?? false,
    cancelled: over.cancelled ?? false,
    verdict: over.verdict ?? "none_attempted",
    rollup: {
      counts: { fully_restored: 0, partially_restored: 0, failed: 0, not_attempted: 0, ...(over.counts ?? {}) },
      sequence: over.rollup?.sequence ?? [],
      attention_required: over.rollup?.attention_required ?? [],
    },
  };
}

function scriptedClient(statuses: RestoreFleetStatus[]): { client: RestoreLifecycleClient; cancelled: string[]; gets: number } {
  const cancelled: string[] = [];
  let i = 0;
  const box = { gets: 0 };
  const client: RestoreLifecycleClient = {
    restoreFleet: async () => ({ fleetAttemptId: "fleet-xyz" }),
    restoreFleetStatus: async () => {
      const s = statuses[Math.min(i, statuses.length - 1)]!;
      i++;
      box.gets++;
      return s;
    },
    cancelRestoreFleet: async (id: string) => {
      cancelled.push(id);
      return { ok: true, cancelled: true };
    },
  };
  return { client, cancelled, get gets() { return box.gets; } };
}

describe("driveRestoreLifecycle", () => {
  it("HIGH-3：每次轮询都发一帧——运行中途的 running 帧被观测到，不止完成时", async () => {
    const frames: Array<{ phase: string; done: boolean; fully: number }> = [];
    const { client } = scriptedClient([
      status({ done: false, counts: { fully_restored: 1 } }), // 1 rig done, fleet still running
      status({ done: false, counts: { fully_restored: 2 } }), // 2 rigs done, still running
      status({ done: true, verdict: "all_fully_restored", counts: { fully_restored: 3 } }),
    ]);
    const final = await driveRestoreLifecycle({
      client,
      onFrame: (f) => frames.push({ phase: f.phase, done: f.done, fully: f.rollup.counts.fully_restored }),
      isCancelRequested: () => false,
      sleep: async () => {},
    });
    // 三帧——其中两帧 mid-run（running），在 done 帧前带渐进计数
    expect(frames).toEqual([
      { phase: "running", done: false, fully: 1 },
      { phase: "running", done: false, fully: 2 },
      { phase: "done", done: true, fully: 3 },
    ]);
    expect(final.phase).toBe("done");
    expect(final.attemptId).toBe("fleet-xyz");
  });

  it("HIGH-1：cancel 带保留的 attempt id 到达端点，恰好一次", async () => {
    const { client, cancelled } = scriptedClient([
      status({ done: false, counts: { fully_restored: 1 } }),
      status({ done: false, cancelled: true, counts: { fully_restored: 1, not_attempted: 1 } }),
      status({ done: true, cancelled: true, verdict: "mixed", counts: { fully_restored: 1, not_attempted: 1 } }),
    ]);
    let asked = false;
    const cancelSpy = vi.spyOn(client, "cancelRestoreFleet");
    const final = await driveRestoreLifecycle({
      client,
      onFrame: () => { asked = true; }, // after the first frame renders, the operator hits cancel
      isCancelRequested: () => asked,
      sleep: async () => {},
    });
    expect(cancelled).toEqual(["fleet-xyz"]); // reached the endpoint with the retained id
    expect(cancelSpy).toHaveBeenCalledTimes(1); // once, not every tick
    expect(final.cancelled).toBe(true);
  });

  it("HIGH-1 (r2 probe)：轮询上限会脱附——绝不冻结在 running 帧", async () => {
    // r2 的 maxPolls:2 判别器：永久运行状态。driver 绝不返回
    // 一个调用方会渲染为 live-with-a-dead-cancel 的 running 帧；它返回 DETACHED。
    const frames: string[] = [];
    const { client } = scriptedClient([status({ done: false, counts: { fully_restored: 1 } })]);
    const final = await driveRestoreLifecycle({
      client,
      onFrame: (f) => frames.push(f.phase),
      isCancelRequested: () => false,
      sleep: async () => {},
      maxPolls: 2,
    });
    expect(final.done).toBe(false);
    expect(final.phase).toBe("detached"); // NOT "running" — the fix
    expect(frames[frames.length - 1]).toBe("detached"); // the last rendered frame is detached, honest
  });

  it("HIGH-1 (r1 refinement 2)：容忍一次瞬时轮询错误——生命周期不结束", async () => {
    let n = 0;
    const client: RestoreLifecycleClient = {
      restoreFleet: async () => ({ fleetAttemptId: "fleet-t" }),
      restoreFleetStatus: async () => {
        n++;
        if (n === 1) throw new Error("ECONNRESET"); // a single blip
        return status({ done: true, verdict: "all_fully_restored", counts: { fully_restored: 2 } });
      },
      cancelRestoreFleet: async () => ({}),
    };
    const final = await driveRestoreLifecycle({ client, onFrame: () => {}, isCancelRequested: () => false, sleep: async () => {} });
    expect(final.phase).toBe("done"); // survived the blip and reached done — not detached, not thrown
    expect(final.done).toBe(true);
  });

  it("HIGH-1 (r1 q2)：好轮询后错误计数清零——零星抖动不累积到脱附", async () => {
    // error, ok, error, ok, error, done——共 3 错但绝不连续 2 次；maxConsecutiveErrors:2。
    const seq: Array<"err" | "ok" | "done"> = ["err", "ok", "err", "ok", "err", "done"];
    let i = 0;
    const client: RestoreLifecycleClient = {
      restoreFleet: async () => ({ fleetAttemptId: "fleet-s" }),
      restoreFleetStatus: async () => {
        const step = seq[Math.min(i, seq.length - 1)]!;
        i++;
        if (step === "err") throw new Error("blip");
        return status({ done: step === "done", verdict: "all_fully_restored", counts: { fully_restored: 1 } });
      },
      cancelRestoreFleet: async () => ({}),
    };
    const final = await driveRestoreLifecycle({ client, onFrame: () => {}, isCancelRequested: () => false, sleep: async () => {}, maxConsecutiveErrors: 2, maxPolls: 50 });
    expect(final.phase).toBe("done"); // reset-on-success: no 2-in-a-row streak, so never detaches
  });

  it("HIGH-1：持续错误连串会脱附（daemon 真的不可达）", async () => {
    const client: RestoreLifecycleClient = {
      restoreFleet: async () => ({ fleetAttemptId: "fleet-d" }),
      restoreFleetStatus: async () => {
        throw new Error("daemon gone");
      },
      cancelRestoreFleet: async () => ({}),
    };
    const final = await driveRestoreLifecycle({ client, onFrame: () => {}, isCancelRequested: () => false, sleep: async () => {}, maxConsecutiveErrors: 3, maxPolls: 50 });
    expect(final.phase).toBe("detached");
  });

  it("HIGH-1 (r1 q1)：reattach+cancel 既 POST cancel 又发帧——可观测确认，非静默 POST", async () => {
    const frames: Array<{ cancelled: boolean }> = [];
    let cancelCalled = false;
    const client: RestoreLifecycleClient = {
      restoreFleet: async () => ({ fleetAttemptId: "unused" }),
      restoreFleetStatus: async () => status({ done: true, cancelled: true, verdict: "mixed", counts: { fully_restored: 1, not_attempted: 1 } }),
      cancelRestoreFleet: async () => {
        cancelCalled = true;
        return {};
      },
    };
    await driveRestoreLifecycle({ client, attemptId: "fleet-existing", onFrame: (f) => frames.push({ cancelled: f.cancelled }), isCancelRequested: () => true, sleep: async () => {} });
    expect(cancelCalled).toBe(true); // the cancel POST reaches the endpoint on reattach
    expect(frames.length).toBeGreaterThan(0); // AND the resumed poll renders a frame — the operator SEES it
    expect(frames[frames.length - 1]!.cancelled).toBe(true); // the frame shows the cancel took effect
  });

  it("reattach（已设 attemptId）：跳过 kick，轮询既有 attempt", async () => {
    const kickSpy = vi.fn(async () => ({ fleetAttemptId: "SHOULD-NOT-BE-USED" }));
    let polledId = "";
    const client: RestoreLifecycleClient = {
      restoreFleet: kickSpy,
      restoreFleetStatus: async () => {
        polledId = "polled";
        return status({ done: true, verdict: "mixed", counts: { fully_restored: 1 } });
      },
      cancelRestoreFleet: async () => ({}),
    };
    const final = await driveRestoreLifecycle({ client, attemptId: "fleet-existing", onFrame: () => {}, isCancelRequested: () => false, sleep: async () => {} });
    expect(kickSpy).not.toHaveBeenCalled(); // reattach never re-kicks
    expect(final.attemptId).toBe("fleet-existing");
    expect(polledId).toBe("polled");
  });
});
