import { describe, it, expect, vi } from "vitest";
import { createCmuxCliTransport } from "../src/adapters/cmux-transport.js";
import type { ExecFn } from "../src/adapters/tmux.js";

/**
 * 合成一段 `cmux --help` 输出，供适配器探测。
 * cmux ≥0.63 提供 `list-panels` / `list-panes` / `list-pane-surfaces`，并且
 * 已移除旧的 `list-surfaces` 与 `agent-pids` 命令。cmux <0.63 则公开这两个旧命令。
 */
function helpText(opts: { modern?: boolean; legacy?: boolean; rpc?: boolean }): string {
  const lines = [
    "cmux - control cmux via Unix socket",
    "",
    "Commands:",
    "  version",
    "  capabilities",
    "  list-workspaces",
    "  current-workspace",
    "  new-surface [--type <terminal|browser>] [--workspace <id|ref>]",
    "  focus-panel --panel <id|ref> [--workspace <id|ref>]",
    "  send [--workspace <id|ref>] [--surface <id|ref>] <text>",
  ];
  if (opts.modern) {
    lines.push(
      "  list-panes [--workspace <id|ref>]",
      "  list-pane-surfaces [--workspace <id|ref>] [--pane <id|ref>]",
      "  list-panels [--workspace <id|ref>]"
    );
  }
  if (opts.legacy) {
    lines.push("  list-surfaces", "  agent-pids");
  }
  if (opts.rpc) {
    lines.push("  rpc <method> [json-params]");
  }
  return lines.join("\n") + "\n";
}

/**
 * 模拟 exec：用合成的 surface 回答 `cmux --help`，其他命令委托给 `overrides`；未匹配
 * 的命令返回空字符串。
 */
function mockExec(opts: {
  modern?: boolean;
  legacy?: boolean;
  rpc?: boolean;
  overrides?: Record<string, string | ((cmd: string) => string)>;
} = {}): ExecFn {
  const impl = async (cmd: string): Promise<string> => {
    if (cmd === "cmux --help") return helpText(opts);
    if (cmd === "cmux capabilities --json") return '{"capabilities":[]}';
    if (opts.overrides && cmd in opts.overrides) {
      const v = opts.overrides[cmd];
      return typeof v === "function" ? v(cmd) : v;
    }
    return "";
  };
  return vi.fn(impl) as unknown as ExecFn;
}

describe("cmux CLI transport——factory / surface 检测", () => {
  it("factory 在连接时探测 `cmux --help`", async () => {
    const exec = mockExec({ modern: true });
    const factory = createCmuxCliTransport(exec);

    await factory();

    expect(exec).toHaveBeenCalledWith("cmux --help");
  });

  it("`cmux --help` 报错时 factory 抛错（例如未安装 cmux）", async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error("command not found: cmux"), { code: "ENOENT" });
    }) as unknown as ExecFn;
    const factory = createCmuxCliTransport(exec);

    await expect(factory()).rejects.toThrow();
  });
});

describe("cmux CLI transport——跨版本不变的稳定命令", () => {
  it("request('capabilities') → 精确命令 cmux capabilities --json", async () => {
    const exec = mockExec({ modern: true, overrides: { "cmux capabilities --json": '{"capabilities":["workspace.list"]}' } });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("capabilities");

    expect(exec).toHaveBeenCalledWith("cmux capabilities --json");
  });

  it("request('workspace.list') 在可用时优先使用 rpc，并把 title 映射为 name", async () => {
    const exec = mockExec({
      modern: true,
      rpc: true,
      overrides: {
        "cmux rpc workspace.list":
          '{"workspaces":[{"ref":"workspace:7","title":"qa6-cmux"},{"id":"workspace-uuid","name":"manual-name"}]}',
      },
    });
    const transport = await createCmuxCliTransport(exec)();

    const result = await transport.request("workspace.list");

    expect(exec).toHaveBeenCalledWith("cmux rpc workspace.list");
    expect(result).toEqual({
      workspaces: [
        { id: "workspace:7", name: "qa6-cmux" },
        { id: "workspace-uuid", name: "manual-name" },
      ],
    });
  });

  it("request('workspace.list') 在 rpc 不可用时回退到 list-workspaces", async () => {
    const exec = mockExec({ modern: true, overrides: { "cmux list-workspaces --json": '{"workspaces":[]}' } });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("workspace.list");

    expect(exec).toHaveBeenCalledWith("cmux list-workspaces --json");
  });

  it("list-workspaces --json 输出文本时 request('workspace.list') 回退到纯文本行", async () => {
    const exec = mockExec({
      modern: true,
      overrides: {
        "cmux list-workspaces --json":
          "* workspace:1  qa-rig  [selected]\n  workspace:2  tmux attach -t qa-rig@openrig\n",
      },
    });
    const transport = await createCmuxCliTransport(exec)();

    const result = await transport.request("workspace.list");

    expect(result).toEqual({
      workspaces: [
        { id: "workspace:1", name: "qa-rig" },
        { id: "workspace:2", name: "tmux attach -t qa-rig@openrig" },
      ],
    });
  });

  it("request('workspace.current') → 精确命令 cmux current-workspace --json", async () => {
    const exec = mockExec({
      modern: true,
      overrides: { "cmux current-workspace --json": '{"workspace_id":"workspace:1"}' },
    });
    const transport = await createCmuxCliTransport(exec)();

    const result = await transport.request("workspace.current");
    expect(exec).toHaveBeenCalledWith("cmux current-workspace --json");
    expect(result).toEqual({ workspace_id: "workspace:1" });
  });

  it("request('workspace.current') 回退到裸旧式 handle 输出", async () => {
    const exec = mockExec({
      legacy: true,
      overrides: { "cmux current-workspace --json": "3FD8CF06-F6FD-451D-AC6B-1DF15BD0BECA\n" },
    });
    const transport = await createCmuxCliTransport(exec)();

    const result = await transport.request("workspace.current");
    expect(result).toEqual({ workspace_id: "3FD8CF06-F6FD-451D-AC6B-1DF15BD0BECA" });
  });

  it("request('surface.focus') → 精确命令 cmux focus-panel --panel 's-1'", async () => {
    const exec = mockExec({ modern: true });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("surface.focus", { surfaceId: "s-1" });

    expect(exec).toHaveBeenCalledWith("cmux focus-panel --panel 's-1'");
  });

  it("提供 workspace 时 request('surface.focus') 包含 --workspace", async () => {
    const exec = mockExec({ modern: true });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("surface.focus", { surfaceId: "surface:7", workspaceId: "workspace:2" });

    expect(exec).toHaveBeenCalledWith("cmux focus-panel --panel 'surface:7' --workspace 'workspace:2'");
  });

  it("request('surface.sendText') → 精确命令 cmux send --surface 's-1' 'hello'", async () => {
    const exec = mockExec({ modern: true });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("surface.sendText", { surfaceId: "s-1", text: "hello" });

    expect(exec).toHaveBeenCalledWith("cmux send --surface 's-1' 'hello'");
  });

  it("提供 workspace 时 request('surface.sendText') 包含 --workspace", async () => {
    const exec = mockExec({ modern: true });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("surface.sendText", {
      surfaceId: "surface:7",
      workspaceId: "workspace:2",
      text: "hello",
    });

    expect(exec).toHaveBeenCalledWith("cmux send --surface 'surface:7' --workspace 'workspace:2' 'hello'");
  });

  it("request('surface.create') → 精确命令 cmux new-surface --type terminal --workspace 'workspace:2' --json", async () => {
    const exec = mockExec({
      modern: true,
      overrides: {
        "cmux new-surface --type 'terminal' --workspace 'workspace:2' --json":
          '{"created_surface_ref":"surface:9","workspace_id":"workspace:2","pane_id":"pane:3"}',
      },
    });
    const transport = await createCmuxCliTransport(exec)();

    const result = await transport.request("surface.create", { workspaceId: "workspace:2", type: "terminal" });
    expect(exec).toHaveBeenCalledWith(
      "cmux new-surface --type 'terminal' --workspace 'workspace:2' --json"
    );
    expect(result).toEqual({
      created_surface_ref: "surface:9",
      workspace_id: "workspace:2",
      pane_id: "pane:3",
    });
  });

  it("request('surface.create') 回退到裸旧式 handle 输出", async () => {
    const exec = mockExec({
      legacy: true,
      overrides: { "cmux new-surface --type 'terminal' --workspace 'workspace:2' --json": "surface:9\n" },
    });
    const transport = await createCmuxCliTransport(exec)();

    const result = await transport.request("surface.create", { workspaceId: "workspace:2", type: "terminal" });
    expect(result).toEqual({ created_surface_ref: "surface:9" });
  });

  it("request('surface.create') 从旧式 OK summary 输出提取 surface ref", async () => {
    const exec = mockExec({
      legacy: true,
      overrides: {
        "cmux new-surface --type 'terminal' --workspace 'workspace:1' --json":
          "OK surface:78 pane:2 workspace:1\n",
      },
    });
    const transport = await createCmuxCliTransport(exec)();

    const result = await transport.request("surface.create", { workspaceId: "workspace:1", type: "terminal" });
    expect(result).toEqual({ created_surface_ref: "surface:78" });
  });

  it("surface.focus 使用现代 'cmux focus-panel --panel' 而非旧 'cmux focus-surface'", async () => {
    const exec = mockExec({ modern: true });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("surface.focus", { surfaceId: "surface:7" });

    const focusCall = (exec as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("focus") && (c[0] as string) !== "cmux --help"
    );
    expect(focusCall).toBeDefined();
    expect(focusCall![0]).toBe("cmux focus-panel --panel 'surface:7'");
    expect(focusCall![0]).not.toContain("focus-surface");
  });

  it("surface.sendText 使用现代 'cmux send --surface' 而非旧 'cmux send-surface'", async () => {
    const exec = mockExec({ modern: true });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("surface.sendText", { surfaceId: "surface:7", text: "hello" });

    const sendCall = (exec as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).startsWith("cmux send ")
    );
    expect(sendCall).toBeDefined();
    expect(sendCall![0]).toBe("cmux send --surface 'surface:7' 'hello'");
    expect(sendCall![0]).not.toContain("send-surface");
  });
});

describe("cmux CLI transport——适应版本的 surface 列表", () => {
  it("现代 cmux 的 surface.list 使用 `list-panels --json`（旧 `list-surfaces` 已移除）", async () => {
    const exec = mockExec({
      modern: true,
      overrides: { "cmux list-panels --json": '{"panels":[{"id":"surface:1","title":"term","type":"terminal"}]}' },
    });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("surface.list");

    const listCall = (exec as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("list-")
        && (c[0] as string) !== "cmux --help"
    );
    expect(listCall![0]).toBe("cmux list-panels --json");
    expect(listCall![0]).not.toContain("list-surfaces");
  });

  it("现代 cmux 的 surface.list 把 `panels` payload 规范化为 `surfaces`", async () => {
    const exec = mockExec({
      modern: true,
      overrides: {
        "cmux list-panels --json":
          '{"panels":[{"id":"surface:1","title":"term","type":"terminal"}]}',
      },
    });
    const transport = await createCmuxCliTransport(exec)();

    const result = (await transport.request("surface.list")) as { surfaces: unknown };
    expect(result).toEqual({ surfaces: [{ id: "surface:1", title: "term", type: "terminal" }] });
  });

  // OPR.0.3.3.18——锁定的破坏点：cmux 0.64.x 的 `list-panels --json` 行携带 `ref`，
  // 但没有 `id`。修复前，下游 `result.data[0].id` 为 undefined → surfaceId undefined →
  // `surface.sendText` 无法映射 → 抛出 "Unknown cmux method"。行 handle 必须从 `ref` 解析。
  it("cmux 0.64.x 的 surface.list 把无 id 的 `panels[].ref` 规范化为 `surfaces[].id`", async () => {
    const exec = mockExec({
      modern: true,
      overrides: {
        "cmux list-panels --json":
          '{"panels":[{"ref":"surface:1","title":"term","type":"terminal"},{"ref":"surface:2","title":"t2","type":"terminal"}]}',
      },
    });
    const transport = await createCmuxCliTransport(exec)();

    const result = (await transport.request("surface.list")) as { surfaces: unknown };
    expect(result).toEqual({
      surfaces: [
        { id: "surface:1", title: "term", type: "terminal" },
        { id: "surface:2", title: "t2", type: "terminal" },
      ],
    });
  });

  // OPR.0.3.3.18——early-return-raw 路径的回归防线：即使 cmux 已用 `surfaces` 作为数组
  // key，只要行携带 `ref` 而非 `id`，仍必须规范化（修复前此分支直接返回原值，导致 `id`
  // 始终为 undefined）。
  it("数组已经以 `surfaces` 为 key 时仍规范化仅含 `ref` 的行", async () => {
    const exec = mockExec({
      modern: true,
      overrides: {
        "cmux list-panels --json":
          '{"surfaces":[{"ref":"surface:9","title":"x","type":"terminal"}]}',
      },
    });
    const transport = await createCmuxCliTransport(exec)();

    const result = (await transport.request("surface.list")) as { surfaces: unknown };
    expect(result).toEqual({ surfaces: [{ id: "surface:9", title: "x", type: "terminal" }] });
  });

  // OPR.0.3.3.18——0.63.2 无回归判别：携带 `id` 而无 `ref` 的行保持原样解析。一套
  // 规范化同时支持两个 cmux 版本，证明修复是适配而非版本协商 shim。
  it("surface.list 保持 `id` 形状的行（cmux 0.63.x）正常工作，无回归", async () => {
    const exec = mockExec({
      modern: true,
      overrides: {
        "cmux list-panels --json":
          '{"panels":[{"id":"surface:63","title":"legacy","type":"terminal"}]}',
      },
    });
    const transport = await createCmuxCliTransport(exec)();

    const result = (await transport.request("surface.list")) as { surfaces: unknown };
    expect(result).toEqual({ surfaces: [{ id: "surface:63", title: "legacy", type: "terminal" }] });
  });

  it("现代 cmux 的 surface.list 通过 --workspace 使用 workspaceId", async () => {
    const exec = mockExec({
      modern: true,
      overrides: { "cmux list-panels --workspace 'workspace:2' --json": '{"panels":[]}' },
    });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("surface.list", { workspaceId: "workspace:2" });

    expect(exec).toHaveBeenCalledWith("cmux list-panels --workspace 'workspace:2' --json");
  });

  it("现代 cmux 的 `--json` 仍输出文本时，surface.list 回退到纯文本 panel 行", async () => {
    const exec = mockExec({
      modern: true,
      overrides: {
        "cmux list-panels --workspace 'workspace:1' --json":
          '  surface:1  terminal  "~"\n* surface:2  terminal  [focused]  "tmux attach -t backend-api@control-plane-test"\n',
      },
    });
    const transport = await createCmuxCliTransport(exec)();

    const result = (await transport.request("surface.list", { workspaceId: "workspace:1" })) as {
      surfaces: unknown;
    };

    expect(result).toEqual({
      surfaces: [
        { id: "surface:1", title: "~", type: "terminal" },
        { id: "surface:2", title: "tmux attach -t backend-api@control-plane-test", type: "terminal" },
      ],
    });
  });

  it("现代 cmux 的 surface.list 把空纯文本输出视为空 surface 列表", async () => {
    const exec = mockExec({
      modern: true,
      overrides: { "cmux list-panels --workspace 'workspace:1' --json": "\n" },
    });
    const transport = await createCmuxCliTransport(exec)();

    const result = (await transport.request("surface.list", { workspaceId: "workspace:1" })) as {
      surfaces: unknown;
    };

    expect(result).toEqual({ surfaces: [] });
  });

  it("现代 cmux 的 surface.list 拒绝仅提及 surface ID 的纯文本错误输出", async () => {
    const exec = mockExec({
      modern: true,
      overrides: {
        "cmux list-panels --workspace 'workspace:1' --json":
          "error: workspace contains stale binding for surface:1 not found\n",
      },
    });
    const transport = await createCmuxCliTransport(exec)();

    await expect(
      transport.request("surface.list", { workspaceId: "workspace:1" })
    ).rejects.toThrow(/无法解析 cmux 命令.*返回的 JSON/);
  });

  it("旧版 cmux 的 surface.list 回退到 `list-surfaces --json`", async () => {
    const exec = mockExec({
      legacy: true,
      overrides: { "cmux list-surfaces --json": '{"surfaces":[]}' },
    });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("surface.list");

    expect(exec).toHaveBeenCalledWith("cmux list-surfaces --json");
  });

  it("两个命令都不存在时 surface.list 抛出结构化 `unavailable` 错误", async () => {
    // Help 中既没有 list-panels 也没有 list-surfaces——adapter 无法实现该方法。
    const exec = mockExec({});
    const transport = await createCmuxCliTransport(exec)();

    await expect(transport.request("surface.list")).rejects.toMatchObject({
      code: "unavailable",
      method: "surface.list",
    });
  });
});

describe("cmux CLI transport——agent-pids 表面（仅旧版）", () => {
  it("旧版 cmux 的 workspace.agentPIDs 映射到 `cmux agent-pids --json`", async () => {
    const exec = mockExec({
      legacy: true,
      overrides: { "cmux agent-pids --json": '{"agents":[{"pid":1234,"runtime":"claude_code"}]}' },
    });
    const transport = await createCmuxCliTransport(exec)();

    const result = await transport.request("workspace.agentPIDs");

    expect(result).toEqual({ agents: [{ pid: 1234, runtime: "claude_code" }] });
    expect(exec).toHaveBeenCalledWith("cmux agent-pids --json");
  });

  it("现代 cmux 的 workspace.agentPIDs 抛出结构化 `unavailable`（命令已移除）", async () => {
    const exec = mockExec({ modern: true });
    const transport = await createCmuxCliTransport(exec)();

    await expect(transport.request("workspace.agentPIDs")).rejects.toMatchObject({
      code: "unavailable",
      method: "workspace.agentPIDs",
    });
  });

  it("cmux 为现代版本时 workspace.agentPIDs 绝不调用已移除命令", async () => {
    const exec = mockExec({ modern: true });
    const transport = await createCmuxCliTransport(exec)();

    await transport.request("workspace.agentPIDs").catch(() => undefined);

    expect(exec).not.toHaveBeenCalledWith("cmux agent-pids --json");
  });
});

describe("cmux CLI transport——JSON 解析诚实性", () => {
  it("cmux 对 --json 命令返回无效 JSON 时拒绝 request", async () => {
    const exec = mockExec({
      modern: true,
      overrides: { "cmux list-workspaces --json": "this is not json {{{" },
    });
    const transport = await createCmuxCliTransport(exec)();

    await expect(transport.request("workspace.list")).rejects.toThrow(/JSON/i);
  });
});
