import { describe, it, expect } from "vitest";
import { TerminalAdapter } from "../src/adapters/terminal-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const MOCK_BINDING: NodeBinding = {
  id: "bind-1",
  nodeId: "node-1",
  tmuxSession: "infra-server@test-rig",
  tmuxWindow: null,
  tmuxPane: null,
  cmuxWorkspace: null,
  cmuxSurface: null,
  updatedAt: "",
  cwd: "/project",
};

describe("TerminalAdapter", () => {
  const adapter = new TerminalAdapter();

  // 测试 1
  it("project 返回空成功结果", async () => {
    const result = await adapter.project(
      { entries: [], diagnostics: [], conflicts: [], noOps: [], runtime: "terminal", cwd: "/project" } as any,
      MOCK_BINDING,
    );
    expect(result).toEqual({ projected: [], skipped: [], failed: [] });
  });

  // 测试 2
  it("deliverStartup 返回空成功结果", async () => {
    const result = await adapter.deliverStartup([], MOCK_BINDING);
    expect(result).toEqual({ delivered: 0, failed: [] });
  });

  // 测试 3
  it("checkReady 立即返回 { ready: true }", async () => {
    const result = await adapter.checkReady(MOCK_BINDING);
    expect(result).toEqual({ ready: true });
  });

  it("runtime 为 'terminal'", () => {
    expect(adapter.runtime).toBe("terminal");
  });

  it("listInstalled 返回空数组", async () => {
    const result = await adapter.listInstalled(MOCK_BINDING);
    expect(result).toEqual([]);
  });

  // NS-T04
  it("launchHarness 为返回 ok 的 no-op", async () => {
    const result = await adapter.launchHarness(MOCK_BINDING, { name: "infra-server@test-rig" });
    expect(result).toEqual({ ok: true });
  });
});
