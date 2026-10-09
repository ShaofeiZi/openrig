import { describe, it, expect, vi } from "vitest";
import { WakeResolveService } from "../src/domain/wake-resolve-service.js";
import type { WakeSessionRow } from "../src/domain/wake-resolver.js";

function row(id: number, token: string | null, runtime = "claude-code"): WakeSessionRow {
  return { id, sessionName: "dev-planner@my-rig", resumeToken: token, runtime, createdAt: `t${id}` };
}

describe("WakeResolveService——L3b route service（query + resolve）", () => {
  it("查询 seat 的 session（最新优先）并解析最新 token", () => {
    const listSessionsBySeat = vi.fn((seat: string): WakeSessionRow[] =>
      seat === "dev-planner@my-rig" ? [row(2, "tok2"), row(1, "tok1")] : [],
    );
    const svc = new WakeResolveService({ listSessionsBySeat });
    const res = svc.resolve("dev-planner@my-rig");
    expect(listSessionsBySeat).toHaveBeenCalledWith("dev-planner@my-rig");
    expect(res.resolved).toBe(true);
    if (res.resolved) {
      expect(res.token).toBe("tok2");
      expect(res.runtime).toBe("claude"); // claude-code 映射为 claude
    }
  });

  it("透传 codex runtime 映射", () => {
    const svc = new WakeResolveService({ listSessionsBySeat: () => [row(1, "tok", "codex")] });
    const res = svc.resolve("dev-planner@my-rig");
    expect(res.resolved && res.runtime).toBe("codex");
  });

  it("以空 teaching list 拒绝未知 seat", () => {
    const svc = new WakeResolveService({ listSessionsBySeat: () => [] });
    const res = svc.resolve("ghost@my-rig");
    expect(res.resolved).toBe(false);
    if (!res.resolved) expect(res.known).toHaveLength(0);
  });

  it("将显式 generation 透传至 resolver", () => {
    const svc = new WakeResolveService({ listSessionsBySeat: () => [row(2, "tok2"), row(1, "tok1")] });
    const res = svc.resolve("dev-planner@my-rig", 2);
    expect(res.resolved && res.token).toBe("tok1");
  });
});
