// 分片 24 检查点 A——为驱动布局流程的 CmuxAdapter RPC 方法扩展
//（splitSurface、createWorkspace、closeWorkspace、listPaneSurfaces）编写失败测试。
// 探索验证了 cmux RPC 提供这些原语；测试在实现落地前固定适配器契约。

import { describe, it, expect, vi } from "vitest";
import { CmuxAdapter } from "../src/adapters/cmux.js";
import type { CmuxTransport, CmuxTransportFactory } from "../src/adapters/cmux.js";

function adapterWithTransport(transport: CmuxTransport): CmuxAdapter {
  const factory: CmuxTransportFactory = async () => transport;
  return new CmuxAdapter(factory, { timeoutMs: 1000 });
}

async function connectAdapter(responses: Record<string, unknown>): Promise<CmuxAdapter> {
  const adapter = adapterWithTransport({
    request: async (method: string) => {
      if (method === "capabilities") return { capabilities: Object.keys(responses) };
      if (method === "workspace.current") return responses["workspace.current"] ?? { workspace_id: "workspace:1" };
      if (method in responses) return responses[method];
      return {};
    },
    close: () => {},
  });
  await adapter.connect();
  return adapter;
}

describe("CmuxAdapter——布局方法扩展（分片 24 检查点 A）", () => {
  describe("splitSurface", () => {
    it("成功时返回新 surface handle", async () => {
      const adapter = await connectAdapter({
        "surface.split": { created_surface_ref: "surface:42" },
      });
      const result = await adapter.splitSurface("surface:10", "right", "workspace:1");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toBe("surface:42");
    });

    it("向 RPC 传递 snake_case 参数（surface_id、direction、workspace_id）", async () => {
      const calls: Array<{ method: string; params?: unknown }> = [];
      const adapter = adapterWithTransport({
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === "capabilities") return { capabilities: ["surface.split"] };
          if (method === "workspace.current") return { workspace_id: "workspace:1" };
          if (method === "surface.split") return { created_surface_ref: "surface:99" };
          return {};
        },
        close: () => {},
      });
      await adapter.connect();
      await adapter.splitSurface("surface:10", "right", "workspace:1");
      const splitCall = calls.find((c) => c.method === "surface.split");
      expect(splitCall).toBeTruthy();
      const params = splitCall!.params as Record<string, unknown>;
      expect(params["surface_id"]).toBe("surface:10");
      expect(params["direction"]).toBe("right");
      expect(params["workspace_id"]).toBe("workspace:1");
    });

    it("传输未连接时返回 unavailable 错误", async () => {
      const adapter = new CmuxAdapter(
        async () => { throw new Error("nope"); },
        { timeoutMs: 100 },
      );
      const result = await adapter.splitSurface("surface:10", "right");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("unavailable");
    });

    it("RPC 抛错时返回 request_failed", async () => {
      const adapter = adapterWithTransport({
        request: async (method: string) => {
          if (method === "capabilities") return { capabilities: ["surface.split"] };
          if (method === "workspace.current") return { workspace_id: "workspace:1" };
          if (method === "surface.split") throw new Error("invalid direction");
          return {};
        },
        close: () => {},
      });
      await adapter.connect();
      const result = await adapter.splitSurface("surface:10", "bogus" as "right");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("request_failed");
        expect(result.message).toContain("invalid direction");
      }
    });

    it("RPC 未返回 surface handle 时返回 request_failed", async () => {
      const adapter = await connectAdapter({ "surface.split": {} });
      const result = await adapter.splitSurface("surface:10", "right");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("request_failed");
    });
  });

  describe("createWorkspace", () => {
    it("成功时返回新 workspace handle", async () => {
      const adapter = await connectAdapter({
        "workspace.create": { workspace_ref: "workspace:6" },
      });
      const result = await adapter.createWorkspace("my-rig");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toBe("workspace:6");
    });

    it("以 snake_case 参数传递可见 workspace 标题和可选 cwd", async () => {
      const calls: Array<{ method: string; params?: unknown }> = [];
      const adapter = adapterWithTransport({
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === "capabilities") return { capabilities: ["workspace.create"] };
          if (method === "workspace.current") return { workspace_id: "workspace:1" };
          if (method === "workspace.create") return { workspace_ref: "workspace:99" };
          return {};
        },
        close: () => {},
      });
      await adapter.connect();
      await adapter.createWorkspace("my-rig", "/path/to/cwd");
      const createCall = calls.find((c) => c.method === "workspace.create");
      const params = createCall!.params as Record<string, unknown>;
      expect(params["title"]).toBe("my-rig");
      expect("name" in params).toBe(false);
      expect(params["cwd"]).toBe("/path/to/cwd");
    });

    it("未提供 cwd 时省略该参数", async () => {
      const calls: Array<{ method: string; params?: unknown }> = [];
      const adapter = adapterWithTransport({
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === "capabilities") return { capabilities: ["workspace.create"] };
          if (method === "workspace.current") return { workspace_id: "workspace:1" };
          if (method === "workspace.create") return { workspace_ref: "workspace:99" };
          return {};
        },
        close: () => {},
      });
      await adapter.connect();
      await adapter.createWorkspace("my-rig");
      const createCall = calls.find((c) => c.method === "workspace.create");
      const params = createCall!.params as Record<string, unknown>;
      expect(params["title"]).toBe("my-rig");
      expect("name" in params).toBe(false);
      expect("cwd" in params).toBe(false);
    });

    it("传输层抛错时返回 request_failed", async () => {
      const adapter = adapterWithTransport({
        request: async (method: string) => {
          if (method === "capabilities") return { capabilities: [] };
          if (method === "workspace.current") return { workspace_id: "workspace:1" };
          if (method === "workspace.create") throw new Error("duplicate name");
          return {};
        },
        close: () => {},
      });
      await adapter.connect();
      const result = await adapter.createWorkspace("conflict");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("request_failed");
        expect(result.message).toContain("duplicate name");
      }
    });
  });

  describe("closeWorkspace", () => {
    it("workspace.close 成功时返回 ok", async () => {
      const adapter = await connectAdapter({ "workspace.close": { workspace_id: "..." } });
      const result = await adapter.closeWorkspace("workspace:6");
      expect(result.ok).toBe(true);
    });

    it("以 snake_case 参数传递 workspace_id", async () => {
      const calls: Array<{ method: string; params?: unknown }> = [];
      const adapter = adapterWithTransport({
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === "capabilities") return { capabilities: [] };
          if (method === "workspace.current") return { workspace_id: "workspace:1" };
          if (method === "workspace.close") return {};
          return {};
        },
        close: () => {},
      });
      await adapter.connect();
      await adapter.closeWorkspace("workspace:6");
      const closeCall = calls.find((c) => c.method === "workspace.close");
      const params = closeCall!.params as Record<string, unknown>;
      expect(params["workspace_id"]).toBe("workspace:6");
    });

    it("传输层抛错时返回 request_failed", async () => {
      const adapter = adapterWithTransport({
        request: async (method: string) => {
          if (method === "capabilities") return { capabilities: [] };
          if (method === "workspace.current") return { workspace_id: "workspace:1" };
          if (method === "workspace.close") throw new Error("not found");
          return {};
        },
        close: () => {},
      });
      await adapter.connect();
      const result = await adapter.closeWorkspace("workspace:99");
      expect(result.ok).toBe(false);
    });
  });

  describe("equalizeSplits", () => {
    it("以 snake_case 参数传递 workspace_id，并解析 cmux 的 equalized 结果", async () => {
      const calls: Array<{ method: string; params?: unknown }> = [];
      const adapter = adapterWithTransport({
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === "capabilities") return { capabilities: [] };
          if (method === "workspace.current") return { workspace_id: "workspace:1" };
          if (method === "workspace.equalize_splits") return { workspace_id: "workspace:6", equalized: true };
          return {};
        },
        close: () => {},
      });
      await adapter.connect();
      const result = await adapter.equalizeSplits("workspace:6");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.equalized).toBe(true);
      const eqCall = calls.find((c) => c.method === "workspace.equalize_splits");
      expect(eqCall).toBeTruthy();
      expect((eqCall!.params as Record<string, unknown>)["workspace_id"]).toBe("workspace:6");
    });

    it("cmux 表示未作更改（或省略字段）时报告 equalized:false", async () => {
      const adapter = adapterWithTransport({
        request: async (method: string) => {
          if (method === "capabilities") return { capabilities: [] };
          if (method === "workspace.current") return { workspace_id: "workspace:1" };
          if (method === "workspace.equalize_splits") return { workspace_id: "workspace:1", equalized: false };
          return {};
        },
        close: () => {},
      });
      await adapter.connect();
      const noChange = await adapter.equalizeSplits("workspace:1");
      expect(noChange.ok).toBe(true);
      if (noChange.ok) expect(noChange.data.equalized).toBe(false);

      const bare = adapterWithTransport({
        request: async (method: string) => {
          if (method === "capabilities") return { capabilities: [] };
          if (method === "workspace.current") return { workspace_id: "workspace:1" };
          return {}; // no equalized field at all → false, never assumed true
        },
        close: () => {},
      });
      await bare.connect();
      const absent = await bare.equalizeSplits("workspace:1");
      expect(absent.ok).toBe(true);
      if (absent.ok) expect(absent.data.equalized).toBe(false);
    });

    it("传输层抛错时返回 request_failed；未连接时返回 unavailable", async () => {
      const throwing = adapterWithTransport({
        request: async (method: string) => {
          if (method === "capabilities") return { capabilities: [] };
          if (method === "workspace.current") return { workspace_id: "workspace:1" };
          if (method === "workspace.equalize_splits") throw new Error("no such method");
          return {};
        },
        close: () => {},
      });
      await throwing.connect();
      const failed = await throwing.equalizeSplits("workspace:1");
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.code).toBe("request_failed");

      const disconnected = adapterWithTransport({ request: async () => ({}), close: () => {} });
      const refused = await disconnected.equalizeSplits("workspace:1");
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.code).toBe("unavailable");
    });
  });

  describe("listPaneSurfaces", () => {
    it("从 pane.surfaces 返回 surfaces 数组", async () => {
      const adapter = await connectAdapter({
        "pane.surfaces": {
          surfaces: [
            { id: "surface:1", title: "tab1", type: "terminal" },
            { id: "surface:2", title: "tab2", type: "terminal" },
          ],
        },
      });
      const result = await adapter.listPaneSurfaces("pane:3");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(2);
        expect(result.data[0]!.id).toBe("surface:1");
      }
    });

    it("缺少 surfaces 字段时返回空数组", async () => {
      const adapter = await connectAdapter({ "pane.surfaces": {} });
      const result = await adapter.listPaneSurfaces("pane:3");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data).toHaveLength(0);
    });

    it("以 snake_case 传递 pane_id 和可选 workspace_id", async () => {
      const calls: Array<{ method: string; params?: unknown }> = [];
      const adapter = adapterWithTransport({
        request: async (method, params) => {
          calls.push({ method, params });
          if (method === "capabilities") return { capabilities: [] };
          if (method === "workspace.current") return { workspace_id: "workspace:1" };
          if (method === "pane.surfaces") return { surfaces: [] };
          return {};
        },
        close: () => {},
      });
      await adapter.connect();
      await adapter.listPaneSurfaces("pane:3", "workspace:1");
      const call = calls.find((c) => c.method === "pane.surfaces");
      const params = call!.params as Record<string, unknown>;
      expect(params["pane_id"]).toBe("pane:3");
      expect(params["workspace_id"]).toBe("workspace:1");
    });
  });
});
