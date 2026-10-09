import { describe, it, expect, vi } from "vitest";
import { DefaultOccupantInvalidator } from "../src/domain/occupant-invalidator.js";

// GHOST-STAGE (e)——cutover slice 在 SeatHandoverService.commit() 调用的 OccupantInvalidator 接缝。
// Class-A 硬删除退役 occupant 的 name-keyed 状态（在 commit 时按时序安全）。Class-B 按 generation
// 定界：给定 retiringGeneration（atom-B）时停止该 generation 的 armed watchdog job；没有
// generation 时保持明确空操作（按名称删除会中和继任者自身 item）。

describe("GHOST-STAGE (e) DefaultOccupantInvalidator", () => {
  it("Class-A：按名称硬删除退役 occupant 的 enforcer 状态和 context sidecar", () => {
    const enforcer = { invalidateOccupant: vi.fn() };
    const contextUsage = { invalidateOccupantSidecar: vi.fn() };
    const inv = new DefaultOccupantInvalidator({ enforcer, contextUsage });

    // 切换时继任者复用名称，即 retiring === successor；Class-A 按 RETIRING 定键。
    inv.invalidateRetiringOccupant({ retiringSessionName: "seat@rig", successorSessionName: "seat@rig" });

    expect(enforcer.invalidateOccupant).toHaveBeenCalledWith("seat@rig");
    expect(contextUsage.invalidateOccupantSidecar).toHaveBeenCalledWith("seat@rig");
  });

  it("Class-B：没有 retiringGeneration 时记录明确 atom-B-pending 标记，且绝不按名称定界", () => {
    const logs: string[] = [];
    const inv = new DefaultOccupantInvalidator({
      enforcer: { invalidateOccupant: () => {} },
      contextUsage: { invalidateOccupantSidecar: () => {} },
      log: (m) => logs.push(m),
    });
    inv.invalidateRetiringOccupant({ retiringSessionName: "seat@rig", successorSessionName: "seat@rig" });
    expect(logs.some((l) => /等待 atom-B/.test(l) && /不会按名称处理/.test(l))).toBe(true);
  });

  it("即使 Class-B pending，Class-A 也始终运行（现已关闭内存/sidecar ghost）", () => {
    const enforcer = { invalidateOccupant: vi.fn() };
    const contextUsage = { invalidateOccupantSidecar: vi.fn() };
    new DefaultOccupantInvalidator({ enforcer, contextUsage })
      .invalidateRetiringOccupant({ retiringSessionName: "s@r", successorSessionName: "s@r" });
    expect(enforcer.invalidateOccupant).toHaveBeenCalledTimes(1);
    expect(contextUsage.invalidateOccupantSidecar).toHaveBeenCalledTimes(1);
  });

  it("Class-B：存在 retiringGeneration 时停止退役 generation 的 armed watchdog job（按 generation 定界）", () => {
    const dropArmedByRegisteringGeneration = vi.fn(() => 2);
    const logs: string[] = [];
    new DefaultOccupantInvalidator({
      enforcer: { invalidateOccupant: () => {} },
      contextUsage: { invalidateOccupantSidecar: () => {} },
      watchdog: { dropArmedByRegisteringGeneration },
      log: (m) => logs.push(m),
    }).invalidateRetiringOccupant({ retiringSessionName: "seat@rig", successorSessionName: "seat@rig", retiringGeneration: "gen-retired" });
    expect(dropArmedByRegisteringGeneration).toHaveBeenCalledWith("gen-retired");
    expect(logs.some((l) => /已停止.*2 个已武装 watchdog 任务/.test(l))).toBe(true);
  });

  it("Class-B：有 retiringGeneration 但未接线 watchdog 依赖时跳过，绝不抛错", () => {
    const inv = new DefaultOccupantInvalidator({
      enforcer: { invalidateOccupant: () => {} },
      contextUsage: { invalidateOccupantSidecar: () => {} },
    });
    expect(() =>
      inv.invalidateRetiringOccupant({ retiringSessionName: "s@r", successorSessionName: "s@r", retiringGeneration: "gen-x" }),
    ).not.toThrow();
  });

  it("Class-B：存在 retiringGeneration 时释放退役 generation 已 claim 的 queue item（按 generation 定界）", () => {
    const releaseClaimsByGeneration = vi.fn(() => 3);
    const logs: string[] = [];
    new DefaultOccupantInvalidator({
      enforcer: { invalidateOccupant: () => {} },
      contextUsage: { invalidateOccupantSidecar: () => {} },
      queue: { releaseClaimsByGeneration },
      log: (m) => logs.push(m),
    }).invalidateRetiringOccupant({ retiringSessionName: "seat@rig", successorSessionName: "seat@rig", retiringGeneration: "gen-retired" });
    expect(releaseClaimsByGeneration).toHaveBeenCalledWith("gen-retired");
    expect(logs.some((l) => /3 个进行中队列条目释放回 pending/.test(l))).toBe(true);
  });
});
