// 5b82324b — 让 `zrig ps` 的 ACTIVITY 真正表达信息。RED 优先。
//
// 当前 attachAgentActivity 的低成本默认逻辑会为没有 hook 的席位生成 unknown/no_runtime_hook
//（node-inventory.ts:1100-1107），因此，即使 LIVE 席位的 pane 正在变化，ACTIVITY 仍显示为 unknown，
// 控制平面也不给出任何信息——这正是最初的停滞场景（8 个席位停在空提示符处，却没有任何提示）。
//
// 修复通过缓存的结构观察，将 STRUCTURAL 捕获标记判别提升为 ACTIVITY 信号。该缓存由后台 1Hz 服务填充，
// 因而请求路径仍保持 CAPTURE-FREE，也保留了 healthz 卡死风暴修复。attachAgentActivity 新增一个只读取、
// 从不执行捕获的 `structuralActivity` 依赖。优先级为：新鲜的 POSITIVE hook 优先；否则采用缓存的结构结论
//（agent_active→running / agent_idle→idle / attention→needs_input，evidenceSource 为 pane_heuristic）；
// 再否则如实返回 unknown/no_runtime_hook。结构信号会覆盖缺失或 stale/unknown 的 hook——
// 活跃性优先于 hook 到达时间（约束 2）。绝不使用动词允许列表，因为结构标记能识别允许列表会漏掉的
// "Drizzling" 类旋转指示器。

import { describe, it, expect } from "vitest";
import { attachAgentActivity } from "../src/domain/node-inventory.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import type { AgentActivity } from "../src/domain/types.js";

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
  return [{ canonicalSessionName: sessionName, runtime: "claude-code", attachmentType: "tmux", logicalId: "dev.impl" }] as never;
}

// 缓存结构观察读取器（即后台服务暴露的接口）。读取时不会捕获 tmux——捕获已按服务周期完成。
function mkStructural(
  state: "agent_active" | "agent_idle" | "attention" | "unknown" | null,
  observedAt = "2026-08-10T20:00:00.000Z",
) {
  return {
    getStructuralActivity: () =>
      state ? { state, reason: `structural_${state}`, evidence: "pane", observedAt } : null,
  } as never;
}

const staleHook: AgentActivity = {
  state: "unknown",
  reason: "stale_runtime_hook",
  evidenceSource: "runtime_hook",
  sampledAt: "2026-08-10T12:00:00.000Z",
  evidence: null,
  stale: true,
};

describe("5b — 结构化 ACTIVITY 信号（提升到默认推导逻辑，无捕获）", () => {
  it("无 hook + 缓存结构状态 agent_active → ACTIVITY running，且不捕获（读取缓存而非探测）", async () => {
    const counter = { captures: 0 };
    const out = (await attachAgentActivity(entries("s@rig"), {
      tmuxAdapter: mkTmux(counter),
      activityStore: { getLatestForNode: () => null } as never,
      structuralActivity: mkStructural("agent_active"),
    } as never)) as Array<{ agentActivity: AgentActivity }>;
    expect(counter.captures).toBe(0); // 不会引发风暴：结构读取只是读取缓存
    expect(out[0]!.agentActivity.state).toBe("running");
    expect(out[0]!.agentActivity.evidenceSource).toBe("pane_heuristic");
  });

  it("无 hook + 缓存结构状态 agent_idle → idle；attention → needs_input", async () => {
    const idle = (await attachAgentActivity(entries("s@rig"), {
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: { getLatestForNode: () => null } as never,
      structuralActivity: mkStructural("agent_idle"),
    } as never)) as Array<{ agentActivity: AgentActivity }>;
    expect(idle[0]!.agentActivity.state).toBe("idle");
    const attn = (await attachAgentActivity(entries("s@rig"), {
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: { getLatestForNode: () => null } as never,
      structuralActivity: mkStructural("attention"),
    } as never)) as Array<{ agentActivity: AgentActivity }>;
    expect(attn[0]!.agentActivity.state).toBe("needs_input");
  });

  it("STALE hook + 新鲜结构状态 agent_active → running（活跃性优先于 hook 到达时间；约束 2）", async () => {
    const out = (await attachAgentActivity(entries("s@rig"), {
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: { getLatestForNode: () => staleHook } as never,
      structuralActivity: mkStructural("agent_active"),
    } as never)) as Array<{ agentActivity: AgentActivity }>;
    expect(out[0]!.agentActivity.state).toBe("running");
    expect(out[0]!.agentActivity.evidenceSource).toBe("pane_heuristic");
  });

  it("新鲜的 POSITIVE hook 优先于结构信号（保留 hook 优先级）", async () => {
    const hook: AgentActivity = { state: "running", reason: "hook", evidenceSource: "runtime_hook", sampledAt: "2026-08-10T20:00:00.000Z", evidence: null };
    const out = (await attachAgentActivity(entries("s@rig"), {
      tmuxAdapter: mkTmux({ captures: 0 }),
      activityStore: { getLatestForNode: () => hook } as never,
      structuralActivity: mkStructural("agent_idle"), // 两者不一致；必须以 hook 为准
    } as never)) as Array<{ agentActivity: AgentActivity }>;
    expect(out[0]!.agentActivity.state).toBe("running");
    expect(out[0]!.agentActivity.evidenceSource).toBe("runtime_hook");
  });

  it("没有结构缓存（为空）→ 如实保留 unknown/no_runtime_hook，仍不捕获（healthz 卡死修复的默认行为）", async () => {
    const counter = { captures: 0 };
    const out = (await attachAgentActivity(entries("s@rig"), {
      tmuxAdapter: mkTmux(counter),
      activityStore: { getLatestForNode: () => null } as never,
      structuralActivity: mkStructural(null),
    } as never)) as Array<{ agentActivity: AgentActivity }>;
    expect(counter.captures).toBe(0);
    expect(out[0]!.agentActivity.state).toBe("unknown");
    expect(out[0]!.agentActivity.reason).toBe("no_runtime_hook");
  });

  it("MF1 聚合回退：真实服务因捕获中断使观察失效后，attachAgentActivity 回退到如实的 stale hook——不误报存活", async () => {
    let content: string | null = "⠋ Working… esc to interrupt";
    const svc = new SeatStructuralActivityService({ capturePaneContent: async () => content } as never);
    await svc.pollSeat("s@rig"); // 已缓存 agent_active
    const call = async () =>
      (await attachAgentActivity(entries("s@rig"), {
        tmuxAdapter: mkTmux({ captures: 0 }),
        activityStore: { getLatestForNode: () => staleHook } as never,
        structuralActivity: svc,
      } as never)) as Array<{ agentActivity: AgentActivity }>;
    const before = await call();
    expect(before[0]!.agentActivity.state).toBe("running"); // 结构信号覆盖 stale hook
    content = null; // 捕获中断
    await svc.pollSeat("s@rig"); // 使该行失效
    const after = await call();
    expect(after[0]!.agentActivity.state).toBe("unknown"); // 回退到如实的 stale hook
    expect(after[0]!.agentActivity.reason).toBe("stale_runtime_hook");
  });
});
