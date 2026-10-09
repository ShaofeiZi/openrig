// Slice 24 Checkpoint A 修复——四种 layout RPC method（surface.split / workspace.create /
// workspace.close / pane.surfaces）的 transport 层测试。8f13174 的 velocity-guard 24.A
// BLOCKING-CONCERN：由于 buildCommand 没有 mapping，无法通过具体 CLI transport 访问 adapter
// method。修复后四种 method 均通过 `cmux rpc <method> '<json-params>'` 路由；这是 cmux 提供的
// 通用 CLI 子命令，可直接透传 RPC（已通过 slice 24 预搭建 spike 验证）。测试固定精确命令结构、
// JSON 序列化与 snake_case 参数保留。

import { describe, it, expect, vi } from "vitest";
import { createCmuxCliTransport } from "../src/adapters/cmux-transport.js";
import type { ExecFn } from "../src/adapters/tmux.js";

function helpText(): string {
  return [
    "cmux - control cmux via Unix socket",
    "",
    "Commands:",
    "  version",
    "  capabilities",
    "  list-workspaces",
    "  current-workspace",
    "  rpc <method> [json-params]",
    "",
  ].join("\n");
}

function mockExec(captured: Array<string>, responses: Record<string, string> = {}): ExecFn {
  const impl = async (cmd: string): Promise<string> => {
    captured.push(cmd);
    if (cmd === "cmux --help") return helpText();
    if (cmd === "cmux capabilities --json") return '{"capabilities":[]}';
    if (cmd in responses) return responses[cmd]!;
    return "{}";
  };
  return vi.fn(impl) as unknown as ExecFn;
}

describe("cmux CLI transport——layout RPC method 透传（slice 24.A 修复）", () => {
  describe("surface.split", () => {
    it("以 snake_case JSON 参数发出 `cmux rpc surface.split`", async () => {
      const captured: string[] = [];
      const exec = mockExec(captured, {});
      const factory = createCmuxCliTransport(exec);
      const transport = await factory();

      await transport.request("surface.split", {
        surface_id: "surface:10",
        direction: "right",
        workspace_id: "workspace:1",
      });

      const splitCmd = captured.find((c) => c.startsWith("cmux rpc surface.split"));
      expect(splitCmd).toBeTruthy();
      expect(splitCmd).toContain("surface.split");
      // 参数经过 JSON 编码和 shell 引号处理。
      expect(splitCmd).toMatch(/surface_id/);
      expect(splitCmd).toMatch(/"surface:10"/);
      expect(splitCmd).toMatch(/direction/);
      expect(splitCmd).toMatch(/"right"/);
      expect(splitCmd).toMatch(/workspace_id/);
    });

    it("解析 cmux rpc 输出中的 JSON 响应", async () => {
      const captured: string[] = [];
      const exec = mockExec(captured, {});
      // 覆盖 surface.split 的 rpc 响应。
      const customExec = vi.fn(async (cmd: string) => {
        captured.push(cmd);
        if (cmd === "cmux --help") return helpText();
        if (cmd === "cmux capabilities --json") return '{"capabilities":[]}';
        if (cmd.startsWith("cmux rpc surface.split")) {
          return '{"created_surface_ref":"surface:42","workspace_ref":"workspace:1"}';
        }
        return "{}";
      }) as unknown as ExecFn;
      const factory = createCmuxCliTransport(customExec);
      const transport = await factory();

      const result = (await transport.request("surface.split", {
        surface_id: "surface:10",
        direction: "right",
      })) as Record<string, unknown>;

      expect(result["created_surface_ref"]).toBe("surface:42");
    });
  });

  describe("workspace.create", () => {
    it("以 snake_case JSON 发出带可见 title 和可选 cwd 的 `cmux rpc workspace.create`", async () => {
      const captured: string[] = [];
      const exec = mockExec(captured, {});
      const factory = createCmuxCliTransport(exec);
      const transport = await factory();

      await transport.request("workspace.create", {
        title: "my-rig",
        cwd: "/path/to/cwd",
      });

      const cmd = captured.find((c) => c.startsWith("cmux rpc workspace.create"));
      expect(cmd).toBeTruthy();
      expect(cmd).toMatch(/"title"/);
      expect(cmd).toMatch(/"my-rig"/);
      expect(cmd).toMatch(/"cwd"/);
      expect(cmd).toMatch(/"\/path\/to\/cwd"/);
    });

    it("处理只有 title 而没有 cwd 的 workspace.create", async () => {
      const captured: string[] = [];
      const exec = mockExec(captured, {});
      const factory = createCmuxCliTransport(exec);
      const transport = await factory();

      await transport.request("workspace.create", { title: "my-rig" });

      const cmd = captured.find((c) => c.startsWith("cmux rpc workspace.create"));
      expect(cmd).toBeTruthy();
      expect(cmd).toMatch(/"title"/);
      expect(cmd).not.toMatch(/"name"/);
      expect(cmd).not.toMatch(/"cwd"/);
    });
  });

  describe("workspace.close", () => {
    it("发出带 workspace_id（snake_case）的 `cmux rpc workspace.close`", async () => {
      const captured: string[] = [];
      const exec = mockExec(captured, {});
      const factory = createCmuxCliTransport(exec);
      const transport = await factory();

      await transport.request("workspace.close", { workspace_id: "workspace:6" });

      const cmd = captured.find((c) => c.startsWith("cmux rpc workspace.close"));
      expect(cmd).toBeTruthy();
      expect(cmd).toMatch(/"workspace_id"/);
      expect(cmd).toMatch(/"workspace:6"/);
    });
  });

  describe("pane.surfaces", () => {
    it("发出带 pane_id（snake_case）的 `cmux rpc pane.surfaces`", async () => {
      const captured: string[] = [];
      const exec = mockExec(captured, {});
      const factory = createCmuxCliTransport(exec);
      const transport = await factory();

      await transport.request("pane.surfaces", {
        pane_id: "pane:3",
        workspace_id: "workspace:1",
      });

      const cmd = captured.find((c) => c.startsWith("cmux rpc pane.surfaces"));
      expect(cmd).toBeTruthy();
      expect(cmd).toMatch(/"pane_id"/);
      expect(cmd).toMatch(/"pane:3"/);
      expect(cmd).toMatch(/"workspace_id"/);
    });

    it("解析 cmux rpc 响应中的 surfaces 数组", async () => {
      const customExec = vi.fn(async (cmd: string) => {
        if (cmd === "cmux --help") return helpText();
        if (cmd === "cmux capabilities --json") return '{"capabilities":[]}';
        if (cmd.startsWith("cmux rpc pane.surfaces")) {
          return '{"surfaces":[{"id":"surface:1","title":"tab1","type":"terminal"}]}';
        }
        return "{}";
      }) as unknown as ExecFn;
      const factory = createCmuxCliTransport(customExec);
      const transport = await factory();

      const result = (await transport.request("pane.surfaces", { pane_id: "pane:3" })) as Record<string, unknown>;
      expect(Array.isArray(result["surfaces"])).toBe(true);
    });
  });

  // OPR.0.4.7.1 回归——equalize 缺失：adapter 已提供 equalizeSplits，但此 allowlist 漏掉 RPC 名，
  // 因而每次生产调用都抛出 Unknown cmux method（request_failed，被非致命 layout 路径静默吸收，
  // 导致 2:1:1 网格）；而 adapter 单元测试使用虚假 transport，未能发现。本测试固定生产命令路径。
  describe("workspace.equalize_splits", () => {
    it("以 workspace_id（snake_case JSON）发出 `cmux rpc workspace.equalize_splits`", async () => {
      const captured: string[] = [];
      const exec = mockExec(captured, {});
      const factory = createCmuxCliTransport(exec);
      const transport = await factory();

      await transport.request("workspace.equalize_splits", { workspace_id: "workspace:3" });

      const cmd = captured.find((c) => c.startsWith("cmux rpc workspace.equalize_splits"));
      expect(cmd).toBeTruthy();
      expect(cmd).toMatch(/"workspace_id"/);
      expect(cmd).toMatch(/"workspace:3"/);
    });

    it("解析 cmux rpc JSON 响应中的 equalized 结果", async () => {
      const customExec = vi.fn(async (cmd: string) => {
        if (cmd === "cmux --help") return helpText();
        if (cmd === "cmux capabilities --json") return '{"capabilities":[]}';
        if (cmd.startsWith("cmux rpc workspace.equalize_splits")) {
          return '{"workspace_id":"workspace:3","equalized":true}';
        }
        return "{}";
      }) as unknown as ExecFn;
      const factory = createCmuxCliTransport(customExec);
      const transport = await factory();

      const result = (await transport.request("workspace.equalize_splits", {
        workspace_id: "workspace:3",
      })) as Record<string, unknown>;
      expect(result["equalized"]).toBe(true);
    });
  });

  describe("未知 method 仍抛错（回归守卫）", () => {
    it("未映射 method 名会抛出 Unknown cmux method", async () => {
      const captured: string[] = [];
      const exec = mockExec(captured, {});
      const factory = createCmuxCliTransport(exec);
      const transport = await factory();

      await expect(transport.request("totally.bogus.method", {})).rejects.toThrow(/未知 cmux 方法/);
    });
  });
});
