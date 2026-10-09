import { describe, it, expect } from "vitest";
import { attachAgentActivity } from "../src/domain/node-inventory.js";
import type { AgentActivity } from "../src/domain/types.js";

/**
 * OPR.0.4.3 healthz-wedge amplification 修复——证明 attachAgentActivity 默认成本低（没有 per-node
 * tmux capture），且只在请求 captureFallback:true（?full/?refresh）时运行高成本
 * probeSessionActivity fallback。CLI `rig ps --nodes` fan-out 与 graph/nodes poll 下的 per-node tmux
 * capture 曾是 fleet-scale storm；cheap-default 将其移出 hot path，同时由 SeatActivityService
 * snapshot 提供 running/idle、getLatestForNode 提供 hook activity。
 */

// 统计 capture 次数的 tmux adapter——capturePaneContent 是高成本调用。
function mkTmux(counter: { captures: number }) {
  return {
    hasSession: async () => true,
    getPaneCommand: async () => "claude",
    capturePaneContent: async () => {
      counter.captures++;
      return "some pane output\n> awaiting input";
    },
  } as never;
}

function entries(sessionName: string) {
  return [
    {
      canonicalSessionName: sessionName,
      runtime: "claude-code",
      attachmentType: "tmux",
      logicalId: "dev.impl",
    },
  ] as never;
}

describe("OPR.0.4.3 healthz-wedge——attachAgentActivity 低成本默认值", () => {
  it("低成本默认值（无 captureFallback）：无 hook seat 获得诚实 unknown/no_runtime_hook placeholder，且无 per-node tmux capture", async () => {
    const counter = { captures: 0 };
    const store = { getLatestForNode: () => null } as never; // 无 runtime hook。
    const out = (await attachAgentActivity(entries("dev.impl@rig"), {
      tmuxAdapter: mkTmux(counter),
      activityStore: store,
    })) as Array<{ agentActivity: AgentActivity }>;

    expect(counter.captures).toBe(0); // 核心修复：hot path 上无 per-node tmux capture。
    expect(out[0]!.agentActivity.state).toBe("unknown");
    expect(out[0]!.agentActivity.reason).toBe("no_runtime_hook");
    expect(out[0]!.agentActivity.evidenceSource).toBe("session_registry");
    expect(out[0]!.agentActivity.fallback).toBe(true);
  });

  it("captureFallback:true：无 hook seat 运行 per-node tmux capture（通过 ?full/?refresh opt-in freshness）", async () => {
    const counter = { captures: 0 };
    const store = { getLatestForNode: () => null } as never;
    await attachAgentActivity(entries("dev.impl@rig"), {
      tmuxAdapter: mkTmux(counter),
      activityStore: store,
      captureFallback: true,
    });
    expect(counter.captures).toBeGreaterThan(0); // full 模式确实 capture。
  });

  it("存在 hook：两种模式都使用 store snapshot，绝不 capture tmux", async () => {
    const counter = { captures: 0 };
    const hook: AgentActivity = {
      state: "running",
      reason: "hook",
      evidenceSource: "runtime_hook",
      sampledAt: "2026-07-03T00:00:00.000Z",
      evidence: null,
    };
    const store = { getLatestForNode: () => hook } as never;

    const cheap = (await attachAgentActivity(entries("s@rig"), {
      tmuxAdapter: mkTmux(counter),
      activityStore: store,
    })) as Array<{ agentActivity: AgentActivity }>;
    const full = (await attachAgentActivity(entries("s@rig"), {
      tmuxAdapter: mkTmux(counter),
      activityStore: store,
      captureFallback: true,
    })) as Array<{ agentActivity: AgentActivity }>;

    expect(counter.captures).toBe(0);
    expect(cheap[0]!.agentActivity).toEqual(hook);
    expect(full[0]!.agentActivity).toEqual(hook);
  });
});
