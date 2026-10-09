// OPR.0.4.1.31 part A——node open-in-cmux 绝不得只因无 cmux workspace 为 current
// 就失败。修复前 createAndBindSurface 只锚定 currentWorkspace()，故无 current 时
// 每个 unbound 行都失败。resolveWorkspaceAnchor 现仅用 transport 白名单方法：
// 有 current workspace 就用它，否则新建一个（cmux 打开新 workspace 作为
// active/visible 那个）。它刻意不调用 workspace.select（该
// cmux CLI exposes no select command + our transport does not allow that RPC —
// dev1-guard B1). A genuinely-unavailable cmux propagates honestly.

import { describe, it, expect, vi } from "vitest";
import { NodeCmuxService } from "../src/domain/node-cmux-service.js";

type Res<T> = { ok: true; data: T } | { ok: false; code: string; message: string };

function makeAdapter(overrides: Record<string, unknown>) {
  const base = {
    currentWorkspace: async (): Promise<Res<string>> => ({ ok: false, code: "request_failed", message: "cmux current-workspace returned no workspace handle" }),
    createWorkspace: vi.fn(async (): Promise<Res<string>> => ({ ok: true, data: "ws-new" })),
    createTerminalSurface: async (): Promise<Res<string>> => ({ ok: true, data: "surface-1" }),
    sendText: async (): Promise<Res<void>> => ({ ok: true, data: undefined }),
    focusSurface: async (): Promise<Res<void>> => ({ ok: true, data: undefined }),
  };
  return { ...base, ...overrides };
}

function makeService(adapter: Record<string, unknown>) {
  const rigRepo = { getRig: () => ({ nodes: [{ id: "n1", logicalId: "dev.impl", binding: null }] }) };
  const sessionRegistry = { updateBinding: vi.fn() };
  return new NodeCmuxService(rigRepo as never, sessionRegistry as never, adapter as never);
}

describe("OPR.0.4.1.31 A 部分——NodeCmuxService 无当前工作区处理（仅允许的方法）", () => {
  it("没有当前工作区时创建可见工作区并打开", async () => {
    const adapter = makeAdapter({});
    const svc = makeService(adapter);
    const result = await svc.openOrFocusNodeSurface("rig-1", "dev.impl");
    expect(result.ok).toBe(true);
    expect((adapter.createWorkspace as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it("cmux 不可用时传播真实错误且不创建工作区", async () => {
    const adapter = makeAdapter({
      currentWorkspace: async () => ({ ok: false, code: "unavailable", message: "cmux is not connected" }),
    });
    const svc = makeService(adapter);
    const result = await svc.openOrFocusNodeSurface("rig-1", "dev.impl");
    expect(result.ok).toBe(false);
    expect((result as { code?: string }).code).toBe("unavailable");
    expect((adapter.createWorkspace as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("已有当前工作区时直接使用，不走创建回退", async () => {
    const adapter = makeAdapter({
      currentWorkspace: async () => ({ ok: true, data: "ws-current" }),
    });
    const svc = makeService(adapter);
    const result = await svc.openOrFocusNodeSurface("rig-1", "dev.impl");
    expect(result.ok).toBe(true);
    expect((adapter.createWorkspace as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("没有当前工作区且创建失败时返回真实错误（操作员可回退到工作组级 Launch）", async () => {
    const adapter = makeAdapter({
      createWorkspace: vi.fn(async () => ({ ok: false, code: "request_failed", message: "cmux workspace.create failed" })),
    });
    const svc = makeService(adapter);
    const result = await svc.openOrFocusNodeSurface("rig-1", "dev.impl");
    expect(result.ok).toBe(false);
    expect((result as { error?: string }).error).toContain("cmux workspace.create failed");
  });
});
