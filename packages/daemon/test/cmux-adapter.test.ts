import { describe, it, expect, vi } from "vitest";
import { CmuxAdapter } from "../src/adapters/cmux.js";
import type {
  CmuxTransport,
  CmuxTransportFactory,
  CmuxStatus,
  CmuxResult,
  CmuxWorkspace,
  CmuxSurface,
} from "../src/adapters/cmux.js";

function workingFactory(capabilities: string[] = ["workspace.list", "surface.list", "surface.focus"]): CmuxTransportFactory {
  return async () => ({
    request: async (method: string) => {
      if (method === "capabilities") {
        return { capabilities };
      }
      if (method === "workspace.current") {
        return { workspace_id: "workspace:1" };
      }
      return {};
    },
    close: () => {},
  });
}

function failingFactory(code: string): CmuxTransportFactory {
  return async () => {
    const err = new Error(`connect failed`) as Error & { code?: string };
    err.code = code;
    throw err;
  };
}

function surfaceFactory(responses: Record<string, unknown>): CmuxTransportFactory {
  return async () => ({
    request: async (method: string) => {
      if (method === "capabilities") {
        return { capabilities: Object.keys(responses) };
      }
      if (method === "workspace.current" && !("workspace.current" in responses)) {
        return { workspace_id: "workspace:1" };
      }
      if (method in responses) {
        return responses[method];
      }
      return {};
    },
    close: () => {},
  });
}

function hangingFactory(): CmuxTransportFactory {
  return () => new Promise(() => {
    // Never resolves — simulates timeout
  });
}

describe("CmuxAdapter", () => {
  it("连接可用 factory 时 available=true 且填充 capabilities", async () => {
    const adapter = new CmuxAdapter(workingFactory(), { timeoutMs: 1000 });
    await adapter.connect();

    const status = adapter.getStatus();
    expect(status.available).toBe(true);
    expect(status.capabilities["workspace.list"]).toBe(true);
    expect(status.capabilities["surface.list"]).toBe(true);
    expect(status.capabilities["surface.focus"]).toBe(true);
  });

  it("连接时规范化 system.capabilities 返回的 capability map payload", async () => {
    const factory: CmuxTransportFactory = async () => ({
      request: async (method: string) => {
        if (method === "capabilities") {
          return {
            "workspace.list": true,
            "surface.list": true,
            "surface.focus": true,
          };
        }
        if (method === "workspace.current") {
          return { workspace_id: "workspace:1" };
        }
        return {};
      },
      close: () => {},
    });
    const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
    await adapter.connect();

    expect(adapter.isAvailable()).toBe(true);
    expect(adapter.getStatus().capabilities["workspace.list"]).toBe(true);
    expect(adapter.getStatus().capabilities["surface.list"]).toBe(true);
    expect(adapter.getStatus().capabilities["surface.focus"]).toBe(true);
  });

  it("factory 抛出 ENOENT 时连接结果为 available=false、capabilities={}", async () => {
    const adapter = new CmuxAdapter(failingFactory("ENOENT"), { timeoutMs: 1000 });
    await adapter.connect();

    const status = adapter.getStatus();
    expect(status.available).toBe(false);
    expect(status.capabilities).toEqual({});
  });

  it("factory 抛出 ECONNREFUSED 时连接结果为 available=false、capabilities={}", async () => {
    const adapter = new CmuxAdapter(failingFactory("ECONNREFUSED"), { timeoutMs: 1000 });
    await adapter.connect();

    const status = adapter.getStatus();
    expect(status.available).toBe(false);
    expect(status.capabilities).toEqual({});
  });

  it("factory 超时时连接结果为 available=false、capabilities={}", async () => {
    const adapter = new CmuxAdapter(hangingFactory(), { timeoutMs: 50 });
    await adapter.connect();

    const status = adapter.getStatus();
    expect(status.available).toBe(false);
    expect(status.capabilities).toEqual({});
  });

  it("factory 成功但 capabilities 挂起时连接结果为 available=false", async () => {
    // factory 连接正常，但 request("capabilities") 永不返回。
    const closeSpy = vi.fn();
    const factory: CmuxTransportFactory = async () => ({
      request: () => new Promise(() => {
        // 永不返回。
      }),
      close: closeSpy,
    });

    const adapter = new CmuxAdapter(factory, { timeoutMs: 50 });
    await adapter.connect();

    const status = adapter.getStatus();
    expect(status.available).toBe(false);
    expect(status.capabilities).toEqual({});
  });

  it("factory 成功但 capabilities 挂起时关闭 transport", async () => {
    const closeSpy = vi.fn();
    const factory: CmuxTransportFactory = async () => ({
      request: () => new Promise(() => {
        // Never resolves — capabilities hang
      }),
      close: closeSpy,
    });

    const adapter = new CmuxAdapter(factory, { timeoutMs: 50 });
    await adapter.connect();

    // factory 已打开 transport，但 capabilities 超时；适配器必须关闭临时 transport，避免泄漏。
    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it("factory 成功但 capabilities 抛错时关闭 transport", async () => {
    const closeSpy = vi.fn();
    const factory: CmuxTransportFactory = async () => ({
      request: async () => {
        throw new Error("capabilities request failed");
      },
      close: closeSpy,
    });

    const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
    await adapter.connect();

    expect(adapter.isAvailable()).toBe(false);
    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it("capabilities 成功后 workspace.current 失败时 connect 报告 unavailable", async () => {
    const closeSpy = vi.fn();
    const factory: CmuxTransportFactory = async () => ({
      request: async (method: string) => {
        if (method === "capabilities") {
          return { capabilities: ["workspace.current"] };
        }
        if (method === "workspace.current") {
          throw new Error("Broken pipe, errno 32");
        }
        return {};
      },
      close: closeSpy,
    });

    const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
    await adapter.connect();

    expect(adapter.isAvailable()).toBe(false);
    expect(adapter.getStatus()).toEqual({ available: false, capabilities: {} });
    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it("getStatus 返回类型化的 CmuxStatus", async () => {
    const adapter = new CmuxAdapter(workingFactory(["workspace.list"]), { timeoutMs: 1000 });
    await adapter.connect();

    const status: CmuxStatus = adapter.getStatus();
    expect(status).toHaveProperty("available");
    expect(status).toHaveProperty("capabilities");
    expect(typeof status.available).toBe("boolean");
    expect(typeof status.capabilities).toBe("object");
  });

  it("未连接时 isAvailable 返回 false", () => {
    const adapter = new CmuxAdapter(workingFactory(), { timeoutMs: 1000 });
    // 未调用 connect()。
    expect(adapter.isAvailable()).toBe(false);
  });

  it("能力检测：transport 返回 feature 列表并映射为 capability record", async () => {
    const features = ["workspace.list", "workspace.create", "surface.focus", "sidebar.metadata"];
    const adapter = new CmuxAdapter(workingFactory(features), { timeoutMs: 1000 });
    await adapter.connect();

    const status = adapter.getStatus();
    expect(status.available).toBe(true);
    for (const f of features) {
      expect(status.capabilities[f]).toBe(true);
    }
    // 列表中没有的 capability 应为 undefined/falsy。
    expect(status.capabilities["nonexistent.capability"]).toBeFalsy();
  });

  it("失败后重连：第二次 connect() 使用可用 factory 时成功", async () => {
    let callCount = 0;
    const factory: CmuxTransportFactory = async () => {
      callCount++;
      if (callCount === 1) {
        const err = new Error("connect failed") as Error & { code?: string };
        err.code = "ECONNREFUSED";
        throw err;
      }
      return {
        request: async (method: string) => {
          if (method === "capabilities") {
            return { capabilities: ["workspace.list"] };
          }
          return {};
        },
        close: () => {},
      };
    };

    const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });

    // 第一次连接失败。
    await adapter.connect();
    expect(adapter.isAvailable()).toBe(false);

    // Second connect succeeds (factory called again — real reconnect)
    await adapter.connect();
    expect(adapter.isAvailable()).toBe(true);
    expect(adapter.getStatus().capabilities["workspace.list"]).toBe(true);
    expect(callCount).toBe(2);
  });

  // -- Surface 操作（T14）--

  describe("listWorkspaces", () => {
    it("从 transport 返回类型化的 workspace 列表", async () => {
      const factory = surfaceFactory({
        "workspace.list": { workspaces: [{ id: "ws-1", name: "review" }, { id: "ws-2", name: "dev" }] },
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      const result: CmuxResult<CmuxWorkspace[]> = await adapter.listWorkspaces();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(2);
        expect(result.data[0]!.id).toBe("ws-1");
        expect(result.data[0]!.name).toBe("review");
        expect(result.data[1]!.id).toBe("ws-2");
      }
    });

    it("未连接时返回 { ok: false, code: 'unavailable' }", async () => {
      const adapter = new CmuxAdapter(workingFactory(), { timeoutMs: 1000 });
      // 未调用 connect()。
      const result = await adapter.listWorkspaces();
      expect(result).toEqual({ ok: false, code: "unavailable", message: "cmux 未连接" });
    });
  });

  describe("listSurfaces", () => {
    it("从 transport 返回类型化的 surface 列表", async () => {
      const factory = surfaceFactory({
        "surface.list": { surfaces: [{ id: "s-1", title: "orchestrator", type: "terminal" }] },
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      const result: CmuxResult<CmuxSurface[]> = await adapter.listSurfaces();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0]!.id).toBe("s-1");
        expect(result.data[0]!.title).toBe("orchestrator");
      }
    });

    it("提供 workspaceId 时把过滤参数转发给 transport", async () => {
      const requestSpy = vi.fn().mockImplementation(async (method: string) => {
        if (method === "capabilities") return { capabilities: ["surface.list"] };
        if (method === "surface.list") return { surfaces: [] };
        return {};
      });
      const factory: CmuxTransportFactory = async () => ({
        request: requestSpy,
        close: () => {},
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      await adapter.listSurfaces("ws-1");

      // 查找 surface.list 调用，而不是 capabilities 调用。
      const surfaceCall = requestSpy.mock.calls.find((c: unknown[]) => c[0] === "surface.list");
      expect(surfaceCall).toBeDefined();
      expect(surfaceCall![1]).toEqual({ workspaceId: "ws-1" });
    });

    it("未连接时返回 { ok: false, code: 'unavailable' }", async () => {
      const adapter = new CmuxAdapter(workingFactory(), { timeoutMs: 1000 });
      const result = await adapter.listSurfaces();
      expect(result).toEqual({ ok: false, code: "unavailable", message: "cmux 未连接" });
    });
  });

  describe("focusSurface", () => {
    it("使用正确 method 与参数调用 transport", async () => {
      const requestSpy = vi.fn().mockImplementation(async (method: string) => {
        if (method === "capabilities") return { capabilities: ["surface.focus"] };
        return {};
      });
      const factory: CmuxTransportFactory = async () => ({
        request: requestSpy,
        close: () => {},
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      await adapter.focusSurface("s-1");

      const focusCall = requestSpy.mock.calls.find((c: unknown[]) => c[0] === "surface.focus");
      expect(focusCall).toBeDefined();
      expect(focusCall![1]).toEqual({ surfaceId: "s-1" });
    });

    it("成功时返回 { ok: true, data: undefined }", async () => {
      const factory = surfaceFactory({ "surface.focus": {} });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      const result: CmuxResult<void> = await adapter.focusSurface("s-1");
      expect(result).toEqual({ ok: true, data: undefined });
    });

    it("未连接时返回 { ok: false, code: 'unavailable' }", async () => {
      const adapter = new CmuxAdapter(workingFactory(), { timeoutMs: 1000 });
      const result = await adapter.focusSurface("s-1");
      expect(result).toEqual({ ok: false, code: "unavailable", message: "cmux 未连接" });
    });
  });

  describe("sendText (cmux)", () => {
    it("使用正确 method 与参数调用 transport", async () => {
      const requestSpy = vi.fn().mockImplementation(async (method: string) => {
        if (method === "capabilities") return { capabilities: ["surface.sendText"] };
        return {};
      });
      const factory: CmuxTransportFactory = async () => ({
        request: requestSpy,
        close: () => {},
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      await adapter.sendText("s-1", "hello world");

      const sendCall = requestSpy.mock.calls.find((c: unknown[]) => c[0] === "surface.sendText");
      expect(sendCall).toBeDefined();
      expect(sendCall![1]).toEqual({ surfaceId: "s-1", text: "hello world" });
    });

    it("成功时返回 { ok: true, data: undefined }", async () => {
      const factory = surfaceFactory({ "surface.sendText": {} });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      const result: CmuxResult<void> = await adapter.sendText("s-1", "test");
      expect(result).toEqual({ ok: true, data: undefined });
    });

    it("未连接时返回 { ok: false, code: 'unavailable' }", async () => {
      const adapter = new CmuxAdapter(workingFactory(), { timeoutMs: 1000 });
      const result = await adapter.sendText("s-1", "test");
      expect(result).toEqual({ ok: false, code: "unavailable", message: "cmux 未连接" });
    });
  });

  describe("currentWorkspace", () => {
    it("把真实 cmux workspace_id payload 规范化为 handle 字符串", async () => {
      // 真实 cmux CLI 输出：{ "workspace_id": "workspace:1" }。
      const factory = surfaceFactory({
        "workspace.current": { workspace_id: "workspace:1" },
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      const result = await adapter.currentWorkspace();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toBe("workspace:1");
      }
    });

    it("未连接时返回 { ok: false, code: 'unavailable' }", async () => {
      const adapter = new CmuxAdapter(workingFactory(), { timeoutMs: 1000 });
      const result = await adapter.currentWorkspace();
      expect(result).toEqual({ ok: false, code: "unavailable", message: "cmux 未连接" });
    });
  });

  describe("createTerminalSurface", () => {
    it("把真实 cmux created_surface_id payload 规范化为 handle 字符串", async () => {
      // 真实 cmux CLI 输出包含 created_surface_id / surface_id。
      const requestSpy = vi.fn().mockImplementation(async (method: string) => {
        if (method === "capabilities") return { capabilities: ["surface.create"] };
        if (method === "surface.create") return { created_surface_id: "surface:9", workspace_id: "workspace:2", pane_id: "pane:3" };
        return {};
      });
      const factory: CmuxTransportFactory = async () => ({
        request: requestSpy,
        close: () => {},
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      const result = await adapter.createTerminalSurface("workspace:2");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toBe("surface:9");
      }

      const createCall = requestSpy.mock.calls.find((c: unknown[]) => c[0] === "surface.create");
      expect(createCall).toBeDefined();
      expect(createCall![1]).toEqual({ workspaceId: "workspace:2", type: "terminal" });
    });

    it("优先使用 created_surface_ref 而非 created_surface_id（refs idFormat 默认值）", async () => {
      const factory = surfaceFactory({
        "surface.create": { created_surface_ref: "surface:9", created_surface_id: "abc-uuid-123" },
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      const result = await adapter.createTerminalSurface("workspace:1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toBe("surface:9");
      }
    });

    it("从旧式 summary 字符串提取 surface ref", async () => {
      const factory = surfaceFactory({
        "surface.create": { created_surface_ref: "OK surface:78 pane:2 workspace:1" },
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      const result = await adapter.createTerminalSurface("workspace:1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toBe("surface:78");
      }
    });

    it("created_surface_ref 缺失时回退到 surface_ref", async () => {
      const factory = surfaceFactory({
        "surface.create": { surface_ref: "surface:5" },
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      const result = await adapter.createTerminalSurface("workspace:1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toBe("surface:5");
      }
    });

    it("沿 ID 链回退：created_surface_id → surface_id", async () => {
      const factory = surfaceFactory({
        "surface.create": { surface_id: "surface:3" },
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      const result = await adapter.createTerminalSurface("workspace:1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toBe("surface:3");
      }
    });

    it("未连接时返回 { ok: false, code: 'unavailable' }", async () => {
      const adapter = new CmuxAdapter(workingFactory(), { timeoutMs: 1000 });
      const result = await adapter.createTerminalSurface("workspace:1");
      expect(result).toEqual({ ok: false, code: "unavailable", message: "cmux 未连接" });
    });
  });

  describe("transport 请求失败", () => {
    it("返回 { ok: false, code: 'request_failed' }", async () => {
      const requestSpy = vi.fn().mockImplementation(async (method: string) => {
        if (method === "capabilities") return { capabilities: ["workspace.list"] };
        if (method === "workspace.current") return { workspace_id: "workspace:1" };
        throw new Error("socket closed unexpectedly");
      });
      const factory: CmuxTransportFactory = async () => ({
        request: requestSpy,
        close: () => {},
      });
      const adapter = new CmuxAdapter(factory, { timeoutMs: 1000 });
      await adapter.connect();

      const result = await adapter.listWorkspaces();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("request_failed");
        expect(result.message).toContain("socket closed unexpectedly");
      }
    });
  });
});
