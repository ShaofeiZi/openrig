// V0.3.1 分片 05 kernel-rig-as-default——前向修复 #3（架构）。
//
// KernelBootTracker 单元测试。追踪器是后台 kernel 启动的可观察状态接口；getStatus() 从追踪器
// 自身状态机与 sessions 表投影 agents[]。bootstrap Promise 触发后即不等待；测试直接构造
// Promise，因此编排部分（探测 / 变体选择）不在此处范围内。

import { describe, expect, it, vi } from "vitest";
import { KernelBootTracker } from "../src/domain/kernel-boot-tracker.js";
import type { EventBus } from "../src/domain/event-bus.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { RigRepository } from "../src/domain/rig-repository.js";

function makeRigRepo(rigs: Array<{ id: string; name: string }>): RigRepository {
  return {
    listRigs: () => rigs,
    findRigsByName: (name: string) => rigs.filter((r) => r.name === name),
  } as unknown as RigRepository;
}

function makeSessionRegistry(
  sessionsByRig: Record<string, Array<{ sessionName: string; runtime?: string; startupStatus: string }>>,
): SessionRegistry {
  return {
    getSessionsForRig: (rigId: string) => sessionsByRig[rigId] ?? [],
  } as unknown as SessionRegistry;
}

function makeEventBus(): { bus: EventBus; emitted: Array<{ type: string }> } {
  const emitted: Array<{ type: string }> = [];
  const bus = {
    emit: (event: { type: string }) => {
      emitted.push(event);
      return event;
    },
  } as unknown as EventBus;
  return { bus, emitted };
}

async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r));
}

describe("KernelBootTracker——初始状态", () => {
  it("设置其他状态前，默认为 skipped 且 agents 为空", () => {
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: makeSessionRegistry({}),
      rigRepo: makeRigRepo([]),
    });
    const status = tracker.getStatus();
    expect(status.kernelState).toBe("skipped");
    expect(status.agents).toEqual([]);
    expect(status.firstUnreadySince).toBeNull();
    expect(status.variant).toBeNull();
    tracker.stop();
  });

  it("setSkipped 将原因记录到 detail", () => {
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: makeSessionRegistry({}),
      rigRepo: makeRigRepo([]),
    });
    tracker.setSkipped("OPENRIG_NO_KERNEL=1");
    const status = tracker.getStatus();
    expect(status.kernelState).toBe("skipped");
    expect(status.detail).toBe("OPENRIG_NO_KERNEL=1");
  });

  it("setAuthBlocked / setSpecMissing 转换到对应状态并记录 detail", () => {
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: makeSessionRegistry({}),
      rigRepo: makeRigRepo([]),
    });
    tracker.setAuthBlocked("Error: ...");
    expect(tracker.getStatus().kernelState).toBe("auth_blocked");
    expect(tracker.getStatus().detail).toBe("Error: ...");

    tracker.setSpecMissing("/fake/path");
    expect(tracker.getStatus().kernelState).toBe("spec_missing");
    expect(tracker.getStatus().detail).toBe("/fake/path");
  });
});

describe("KernelBootTracker——agent 就绪状态聚合", () => {
  it("每个 kernel agent 都达到 startup_status=ready 时，getStatus 聚合为 ready", async () => {
    const rigId = "rig-kernel-1";
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: makeSessionRegistry({
        [rigId]: [
          { sessionName: "advisor-lead@kernel", runtime: "claude-code", startupStatus: "ready" },
          { sessionName: "operator-agent@kernel", runtime: "codex", startupStatus: "ready" },
          { sessionName: "queue-worker@kernel", runtime: "codex", startupStatus: "ready" },
        ],
      }),
      rigRepo: makeRigRepo([{ id: rigId, name: "kernel" }]),
      degradedTimeoutMs: 0,
    });
    tracker.startBooting("rig.yaml", Promise.resolve({
      runId: "t", status: "ok", stages: [], errors: [], warnings: [],
    } as never));
    await flush();
    const status = tracker.getStatus();
    expect(status.kernelState).toBe("ready");
    expect(status.agents).toHaveLength(3);
    expect(status.firstUnreadySince).toBeNull();
    tracker.stop();
  });

  it("部分 agent 就绪、其他仍 pending 时，getStatus 聚合为 partial_ready", async () => {
    const rigId = "rig-kernel-2";
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: makeSessionRegistry({
        [rigId]: [
          { sessionName: "advisor-lead@kernel", runtime: "claude-code", startupStatus: "ready" },
          { sessionName: "operator-agent@kernel", runtime: "codex", startupStatus: "pending" },
        ],
      }),
      rigRepo: makeRigRepo([{ id: rigId, name: "kernel" }]),
      degradedTimeoutMs: 0,
    });
    tracker.startBooting("rig.yaml", Promise.resolve({
      runId: "t", status: "ok", stages: [], errors: [], warnings: [],
    } as never));
    await flush();
    expect(tracker.getStatus().kernelState).toBe("partial_ready");
    tracker.stop();
  });

  it("bootstrap 完成后所有 agent 均 pending 时，getStatus 保持 booting", async () => {
    const rigId = "rig-kernel-3";
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: makeSessionRegistry({
        [rigId]: [
          { sessionName: "advisor-lead@kernel", runtime: "claude-code", startupStatus: "pending" },
        ],
      }),
      rigRepo: makeRigRepo([{ id: rigId, name: "kernel" }]),
      degradedTimeoutMs: 0,
    });
    tracker.startBooting("rig.yaml", Promise.resolve({
      runId: "t", status: "ok", stages: [], errors: [], warnings: [],
    } as never));
    await flush();
    expect(tracker.getStatus().kernelState).toBe("booting");
    tracker.stop();
  });

  it("将 sessions 表的 startup_status 传入 agents[]", async () => {
    const rigId = "rig-kernel-4";
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: makeSessionRegistry({
        [rigId]: [
          { sessionName: "operator-agent@kernel", runtime: "codex", startupStatus: "failed" },
          { sessionName: "advisor-lead@kernel", runtime: "claude-code", startupStatus: "attention_required" },
        ],
      }),
      rigRepo: makeRigRepo([{ id: rigId, name: "kernel" }]),
      degradedTimeoutMs: 0,
    });
    tracker.startBooting("rig.yaml", Promise.resolve({
      runId: "t", status: "ok", stages: [], errors: [], warnings: [],
    } as never));
    await flush();
    const agents = tracker.getStatus().agents;
    expect(agents).toHaveLength(2);
    expect(agents.find((a) => a.sessionName === "operator-agent@kernel")?.startupStatus).toBe("failed");
    expect(agents.find((a) => a.sessionName === "advisor-lead@kernel")?.startupStatus).toBe("attention_required");
    tracker.stop();
  });
});

describe("KernelBootTracker——bootstrap 结果转换", () => {
  it("onBootstrapComplete 收到错误时转换为 bootstrap_failed", async () => {
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: makeSessionRegistry({}),
      rigRepo: makeRigRepo([]),
      degradedTimeoutMs: 0,
    });
    tracker.startBooting("rig.yaml", Promise.resolve({
      runId: "t", status: "failed", stages: [], errors: ["preflight: tmux missing"], warnings: [],
    } as never));
    await flush();
    const status = tracker.getStatus();
    expect(status.kernelState).toBe("bootstrap_failed");
    expect(status.detail).toContain("tmux missing");
    tracker.stop();
  });

  it("onBootstrapError（Promise 拒绝）携带抛出消息转换为 bootstrap_failed", async () => {
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: makeSessionRegistry({}),
      rigRepo: makeRigRepo([]),
      degradedTimeoutMs: 0,
    });
    tracker.startBooting("rig.yaml", Promise.reject(new Error("network blip")));
    await flush();
    const status = tracker.getStatus();
    expect(status.kernelState).toBe("bootstrap_failed");
    expect(status.detail).toBe("network blip");
    tracker.stop();
  });
});

describe("KernelBootTracker——降级计时器遥测", () => {
  it("启动超过计时器仍未就绪时仅发出一次 kernel.agent.degraded", async () => {
    const { bus, emitted } = makeEventBus();
    const tracker = new KernelBootTracker({
      eventBus: bus,
      sessionRegistry: makeSessionRegistry({}),
      rigRepo: makeRigRepo([]),
      degradedTimeoutMs: 10,
    });
    // 永不解决的 Promise 使追踪器在计时器到期后仍处于 booting。
    const blocked = new Promise<never>(() => {});
    tracker.startBooting("rig.yaml", blocked as never);
    expect(tracker.getStatus().kernelState).toBe("booting");

    await new Promise((r) => setTimeout(r, 30));
    const degraded = emitted.filter((e) => e.type === "kernel.agent.degraded");
    expect(degraded).toHaveLength(1);
    expect(tracker.getStatus().kernelState).toBe("degraded");

    // 即使 checkDegraded 再次运行，后续读取也不应重复发出。
    await new Promise((r) => setTimeout(r, 30));
    expect(emitted.filter((e) => e.type === "kernel.agent.degraded")).toHaveLength(1);
    tracker.stop();
  });

  it("计时器触发前至少一个 agent 就绪时不发出 degraded", async () => {
    const { bus, emitted } = makeEventBus();
    const rigId = "rig-kernel-fast";
    const tracker = new KernelBootTracker({
      eventBus: bus,
      sessionRegistry: makeSessionRegistry({
        [rigId]: [{ sessionName: "advisor-lead@kernel", runtime: "claude-code", startupStatus: "ready" }],
      }),
      rigRepo: makeRigRepo([{ id: rigId, name: "kernel" }]),
      degradedTimeoutMs: 50,
    });
    tracker.startBooting("rig.yaml", Promise.resolve({
      runId: "t", status: "ok", stages: [], errors: [], warnings: [],
    } as never));
    await flush();
    expect(tracker.getStatus().kernelState).toBe("ready");

    await new Promise((r) => setTimeout(r, 80));
    expect(emitted.filter((e) => e.type === "kernel.agent.degraded")).toHaveLength(0);
    tracker.stop();
  });

  it("stop() 取消降级计时器（幂等）", async () => {
    const { bus, emitted } = makeEventBus();
    const tracker = new KernelBootTracker({
      eventBus: bus,
      sessionRegistry: makeSessionRegistry({}),
      rigRepo: makeRigRepo([]),
      degradedTimeoutMs: 10,
    });
    const blocked = new Promise<never>(() => {});
    tracker.startBooting("rig.yaml", blocked as never);
    tracker.stop();
    tracker.stop(); // 幂等
    await new Promise((r) => setTimeout(r, 30));
    expect(emitted.filter((e) => e.type === "kernel.agent.degraded")).toHaveLength(0);
  });
});

describe("KernelBootTracker——sessionRegistry 错误处理", () => {
  it("sessionRegistry 抛错时 getStatus 返回空 agents[]（不会返回 500）", () => {
    const throwingRegistry: SessionRegistry = {
      getSessionsForRig: vi.fn(() => {
        throw new Error("DB connection lost");
      }),
    } as unknown as SessionRegistry;
    const rigId = "rig-kernel-broken";
    const tracker = new KernelBootTracker({
      eventBus: makeEventBus().bus,
      sessionRegistry: throwingRegistry,
      rigRepo: makeRigRepo([{ id: rigId, name: "kernel" }]),
      degradedTimeoutMs: 0,
    });
    const status = tracker.getStatus();
    expect(status.agents).toEqual([]);
    expect(status.kernelState).toBe("skipped");
    tracker.stop();
  });
});
