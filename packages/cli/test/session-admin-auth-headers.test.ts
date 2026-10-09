// OPR.0.4.3.02——session-admin mutation auth 守卫的 CLI 半边。
// 新受保护 mutation 路由的三个 CLI 调用者必须经 terminalAuthHeaders()
// 附 terminal bearer（如 `rig seat set-resume-token` 已做），否则
// `rig reconcile-session` / `rig unclaim` / `rig seat clear-attention`
// 会对非 loopback daemon 401——正是本 slice 保护的模式。镜像
// seat-set-resume-token.test.ts。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcileSessionCommand } from "../src/commands/reconcile-session.js";
import { unclaimCommand } from "../src/commands/unclaim.js";
import { seatCommand } from "../src/commands/seat.js";
import type { StatusDeps } from "../src/commands/status.js";

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

interface PostCall { path: string; body: unknown; options: unknown; }

function makeDeps(response: { status: number; data: Record<string, unknown> }, postCalls: PostCall[]): StatusDeps {
  return {
    lifecycleDeps: {} as StatusDeps["lifecycleDeps"],
    clientFactory: () => ({
      post: vi.fn(async (path: string, body: unknown, options: unknown) => {
        postCalls.push({ path, body, options });
        return response;
      }),
    }) as unknown as ReturnType<StatusDeps["clientFactory"]>,
  };
}

describe("session-admin CLI callers attach the terminal bearer header (OPR.0.4.3.02)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  it("rig reconcile-session posts with { headers } (terminalAuthHeaders)", async () => {
    const postCalls: PostCall[] = [];
    const deps = makeDeps({ status: 200, data: { ok: true, result: {} } }, postCalls);
    await reconcileSessionCommand(deps).parseAsync(["node", "rig", "dev-impl@my-rig", "--no-launch", "--json"]);

    expect(postCalls.length).toBe(1);
    expect(postCalls[0]!.path).toBe("/api/sessions/dev-impl%40my-rig/reconcile");
    expect(postCalls[0]!.options).toHaveProperty("headers");
  });

  it("rig unclaim posts with { headers } (terminalAuthHeaders)", async () => {
    const postCalls: PostCall[] = [];
    const deps = makeDeps({ status: 200, data: { sessionName: "dev-impl@my-rig", logicalId: "dev.impl", rigId: "rig-1" } }, postCalls);
    await unclaimCommand(deps).parseAsync(["node", "rig", "dev-impl@my-rig", "--json"]);

    expect(postCalls.length).toBe(1);
    expect(postCalls[0]!.path).toBe("/api/sessions/dev-impl%40my-rig/unclaim");
    expect(postCalls[0]!.options).toHaveProperty("headers");
  });

  it("rig seat clear-attention posts with { headers } (terminalAuthHeaders)", async () => {
    const postCalls: PostCall[] = [];
    const deps = makeDeps({ status: 200, data: { from: "attention_required", clearedBy: "evidence" } }, postCalls);
    await seatCommand(deps).parseAsync(["node", "rig", "clear-attention", "dev-impl@my-rig", "--json"]);

    expect(postCalls.length).toBe(1);
    expect(postCalls[0]!.path).toBe("/api/sessions/dev-impl%40my-rig/clear-attention");
    expect(postCalls[0]!.options).toHaveProperty("headers");
  });
});
