import { describe, it, expect } from "vitest";
import { resolveWakeTarget, type WakeSessionRow } from "../src/domain/wake-resolver.js";

// rows 是最新在前（id DESC），按 sessions 查询返回的顺序。
function rows(...rs: Partial<WakeSessionRow>[]): WakeSessionRow[] {
  return rs.map((r, i) => ({
    id: r.id ?? 100 - i,
    sessionName: r.sessionName ?? "dev-planner@my-rig",
    // 尊重显式提供的 null（不要合并成默认 token）
    resumeToken: "resumeToken" in r ? (r.resumeToken ?? null) : `tok-${100 - i}`,
    runtime: r.runtime ?? "claude",
    createdAt: r.createdAt ?? `2026-08-0${i + 1}T00:00:00Z`,
  }));
}

describe("resolveWakeTarget——L3b seat[@gen] -> token（裁决 A：在既有 store 上解析）", () => {
  it("默认解析最新任期（省略 generation）", () => {
    const res = resolveWakeTarget(rows({ resumeToken: "newest" }, { resumeToken: "older" }), { seat: "dev-planner@my-rig" });
    expect(res.resolved).toBe(true);
    if (res.resolved) {
      expect(res.token).toBe("newest");
      expect(res.runtime).toBe("claude");
    }
  });

  it("解析显式 generation（1 = 最新，2 = 次新）", () => {
    const res = resolveWakeTarget(rows({ resumeToken: "gen1" }, { resumeToken: "gen2" }), { seat: "dev-planner@my-rig", generation: 2 });
    expect(res.resolved).toBe(true);
    if (res.resolved) expect(res.token).toBe("gen2");
  });

  it("拒绝未知 seat（无行）且不列出任何项——绝不猜测 wake", () => {
    const res = resolveWakeTarget([], { seat: "ghost@my-rig" });
    expect(res.resolved).toBe(false);
    if (!res.resolved) {
      expect(res.reason).toMatch(/没有已知会话|未知|未找到/i);
      expect(res.known).toHaveLength(0);
    }
  });

  it("拒绝越界 generation 并告知存在哪些任期", () => {
    const res = resolveWakeTarget(rows({ resumeToken: "g1" }, { resumeToken: "g2" }), { seat: "dev-planner@my-rig", generation: 5 });
    expect(res.resolved).toBe(false);
    if (!res.resolved) {
      expect(res.reason).toMatch(/代|仅记录了 2 个任期/i);
      expect(res.known).toHaveLength(2);
      expect(res.known[0]!.generation).toBe(1);
      expect(res.known[1]!.generation).toBe(2);
    }
  });

  it("当解析到的任期无捕获的 resume token 时拒绝（将其列为 token 缺失）", () => {
    const res = resolveWakeTarget(rows({ resumeToken: null }), { seat: "dev-planner@my-rig" });
    expect(res.resolved).toBe(false);
    if (!res.resolved) {
      expect(res.reason).toMatch(/没有捕获到恢复 token/i);
      expect(res.known[0]!.tokenPresent).toBe(false);
    }
  });
});
