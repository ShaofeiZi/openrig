import { describe, it, expect, vi } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ExecFn, TmuxResult } from "../src/adapters/tmux.js";

const NO_SERVER_ERROR = new Error("no server running on /tmp/tmux-1000/default");

function mockExec(responses: Record<string, { stdout?: string; error?: Error }>): ExecFn {
  return (cmd: string) => {
    for (const [pattern, response] of Object.entries(responses)) {
      if (cmd.includes(pattern)) {
        if (response.error) {
          return Promise.reject(response.error);
        }
        return Promise.resolve(response.stdout ?? "");
      }
    }
    return Promise.resolve("");
  };
}

describe("TmuxAdapter", () => {
  it("只启动空 terminal server，并协调重复请求", async () => {
    let live = false;
    const exec = vi.fn(async (command: string) => {
      if (command.startsWith("tmux -D")) { live = true; return ""; }
      throw live ? new Error("no current target") : NO_SERVER_ERROR;
    });
    const adapter = new TmuxAdapter(exec);
    expect(await adapter.startServer()).toEqual({ ok: true });
    expect(await adapter.startServer()).toEqual({ ok: true });
    expect(exec.mock.calls.filter(([command]) => command.startsWith("tmux -D"))).toHaveLength(1);
    expect(exec.mock.calls.some(([command]) => command.includes("new-session"))).toBe(false);
  });
  it("socket 观察因权限错误失败时不启动 server", async () => {
    const exec = vi.fn(async () => { throw new Error("permission denied"); });
    expect(await new TmuxAdapter(exec).startServer()).toMatchObject({ ok: false, code: "tmux_unavailable" });
    expect(exec).toHaveBeenCalledOnce();
  });
  describe("listSessions", () => {
    it("使用精确 tmux list-sessions 命令与格式字符串调用 exec", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.listSessions();

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        'tmux list-sessions -F "#{session_name}|#{session_windows}|#{session_created}|#{session_attached}"'
      );
    });

    it("把输出解析为类型化 TmuxSession 对象", async () => {
      const output = [
        "my-session|1|2026-03-23T01:00:00|1",
        "other-sess|3|2026-03-23T02:00:00|0",
      ].join("\n");

      const adapter = new TmuxAdapter(mockExec({ "list-sessions": { stdout: output } }));
      const sessions = await adapter.listSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions[0]!.name).toBe("my-session");
      expect(sessions[0]!.windows).toBe(1);
      expect(sessions[0]!.attached).toBe(true);
      expect(sessions[1]!.name).toBe("other-sess");
      expect(sessions[1]!.windows).toBe(3);
      expect(sessions[1]!.attached).toBe(false);
    });

    it("遇到 'no server running' 错误时返回空数组", async () => {
      const adapter = new TmuxAdapter(mockExec({ "list-sessions": { error: NO_SERVER_ERROR } }));
      const sessions = await adapter.listSessions();
      expect(sessions).toEqual([]);
    });
  });

  describe("listWindows", () => {
    it("使用精确 tmux list-windows 命令与格式字符串调用 exec", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.listWindows("my-session");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        'tmux list-windows -t \'my-session\' -F "#{window_index}\t#{window_name}\t#{window_panes}\t#{window_active}"'
      );
    });

    it("list-windows 中引用 shell 敏感的 session 名称", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.listWindows("my session's name");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        'tmux list-windows -t \'my session\'\"\'\"\'s name\' -F "#{window_index}\t#{window_name}\t#{window_panes}\t#{window_active}"'
      );
    });

    it("把输出解析为类型化 TmuxWindow 对象", async () => {
      const output = [
        "0\tmain\t1\t1",
        "1\twork\t2\t0",
      ].join("\n");

      const adapter = new TmuxAdapter(mockExec({ "list-windows": { stdout: output } }));
      const windows = await adapter.listWindows("my-session");

      expect(windows).toHaveLength(2);
      expect(windows[0]!.index).toBe(0);
      expect(windows[0]!.name).toBe("main");
      expect(windows[0]!.panes).toBe(1);
      expect(windows[0]!.active).toBe(true);
      expect(windows[1]!.index).toBe(1);
      expect(windows[1]!.active).toBe(false);
    });

    it("遇到 'no server running' 错误时返回空数组", async () => {
      const adapter = new TmuxAdapter(mockExec({ "list-windows": { error: NO_SERVER_ERROR } }));
      const windows = await adapter.listWindows("my-session");
      expect(windows).toEqual([]);
    });
  });

  describe("listPanes", () => {
    it("使用精确 tmux list-panes 命令与格式字符串调用 exec", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.listPanes("my-session:0");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        'tmux list-panes -t \'my-session:0\' -F "#{pane_id}|#{pane_index}|#{pane_current_path}|#{pane_width}|#{pane_height}|#{pane_active}"'
      );
    });

    it("list-panes 中引用 shell 敏感的 target", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.listPanes("my session's:0");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        'tmux list-panes -t \'my session\'\"\'\"\'s:0\' -F "#{pane_id}|#{pane_index}|#{pane_current_path}|#{pane_width}|#{pane_height}|#{pane_active}"'
      );
    });

    it("把输出解析为类型化 TmuxPane 对象", async () => {
      const output = [
        "%1|0|/home/user/code|180|40|1",
        "%2|1|/tmp|180|40|0",
      ].join("\n");

      const adapter = new TmuxAdapter(mockExec({ "list-panes": { stdout: output } }));
      const panes = await adapter.listPanes("my-session:0");

      expect(panes).toHaveLength(2);
      expect(panes[0]!.id).toBe("%1");
      expect(panes[0]!.index).toBe(0);
      expect(panes[0]!.cwd).toBe("/home/user/code");
      expect(panes[0]!.active).toBe(true);
      expect(panes[1]!.id).toBe("%2");
      expect(panes[1]!.active).toBe(false);
    });

    it("遇到 'no server running' 错误时返回空数组", async () => {
      const adapter = new TmuxAdapter(mockExec({ "list-panes": { error: NO_SERVER_ERROR } }));
      const panes = await adapter.listPanes("my-session:0");
      expect(panes).toEqual([]);
    });
  });

  describe("hasSession", () => {
    it("tmux has-session 以 0 退出时返回 true", async () => {
      const adapter = new TmuxAdapter(mockExec({ "has-session": { stdout: "" } }));
      expect(await adapter.hasSession("target-session")).toBe(true);
    });

    it("找不到 session 时返回 false", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "has-session": { error: new Error("session not found: missing-session") },
      }));
      expect(await adapter.hasSession("missing-session")).toBe(false);
    });

    it("无法找到 session 时返回 false", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "has-session": { error: new Error("can't find session: old-session") },
      }));
      expect(await adapter.hasSession("old-session")).toBe(false);
    });

    it("遇到 'no server running' 错误时返回 false", async () => {
      const adapter = new TmuxAdapter(mockExec({ "has-session": { error: NO_SERVER_ERROR } }));
      expect(await adapter.hasSession("any-session")).toBe(false);
    });

    it("遇到意外 probe 错误（permission denied / socket failure）时抛错", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "has-session": { error: new Error("error connecting to /tmp/tmux-501/default (Permission denied)") },
      }));
      await expect(adapter.hasSession("any-session")).rejects.toThrow("Permission denied");
    });

    it("遇到无法识别的通用 exec 错误时抛错", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "has-session": { error: new Error("Command failed with exit code 127") },
      }));
      await expect(adapter.hasSession("any-session")).rejects.toThrow("exit code 127");
    });

    // L1 冷启动 tmux 真相修复：重启后 socket 缺失必须分类为“无 session”，使 reconciler
    // 无需手动修复即可 detach 陈旧行。
    it("重启后 tmux socket 消失（No such file or directory）时返回 false", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "has-session": { error: new Error("error connecting to /private/tmp/tmux-501/default (No such file or directory)") },
      }));
      expect(await adapter.hasSession("any-session")).toBe(false);
    });

    it("tmux socket 路径返回 Connection refused 时返回 false", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "has-session": { error: new Error("error connecting to /private/tmp/tmux-501/default (Connection refused)") },
      }));
      expect(await adapter.hasSession("any-session")).toBe(false);
    });

    it("遇到 'Operation not permitted' 时重新抛出（权限必须保持关闭式失败）", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "has-session": { error: new Error("error connecting to /private/tmp/tmux-501/default (Operation not permitted)") },
      }));
      await expect(adapter.hasSession("any-session")).rejects.toThrow("Operation not permitted");
    });

    it("遇到 EACCES 时重新抛出（权限必须保持关闭式失败）", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "has-session": { error: new Error("EACCES: permission denied, /private/tmp/tmux-501/default") },
      }));
      await expect(adapter.hasSession("any-session")).rejects.toThrow("EACCES");
    });
  });

  describe("hasSessionEnv", () => {
    it("区分可用变量与缺失或空白值", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue([
        "OPENRIG_URL=http://127.0.0.1:7433",
        "OPENRIG_ACTIVITY_HOOK_TOKEN=",
        "RIGGED_URL=   ",
        "-RIGGED_ACTIVITY_HOOK_TOKEN",
      ].join("\n"));
      const adapter = new TmuxAdapter(exec);

      expect(await adapter.hasSessionEnv("seat@rig", "OPENRIG_URL")).toBe(true);
      expect(await adapter.hasSessionEnv("seat@rig", "OPENRIG_ACTIVITY_HOOK_TOKEN")).toBe(false);
      expect(await adapter.hasSessionEnv("seat@rig", "RIGGED_URL")).toBe(false);
      expect(await adapter.hasSessionEnv("seat@rig", "RIGGED_ACTIVITY_HOOK_TOKEN")).toBe(false);
      expect(exec).toHaveBeenCalledWith("tmux show-environment -t 'seat@rig'");
    });

    it("无法检查 session 环境时返回 unknown", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "show-environment": { error: new Error("can't find session: missing") },
      }));

      expect(await adapter.hasSessionEnv("missing", "OPENRIG_URL")).toBeNull();
    });
  });

  describe("createSession", () => {
    it("使用精确命令调用 exec（name + cwd 均引用）", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.createSession("r01-dev1-impl", "/home/user/code");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux new-session -d -s 'r01-dev1-impl' -c '/home/user/code'"
      );
    });

    it("cwd 包含空格时引用路径", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.createSession("r01-dev1-impl", "/home/user/my project/code");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux new-session -d -s 'r01-dev1-impl' -c '/home/user/my project/code'"
      );
    });

    it("session 名称对 shell 敏感时引用名称", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.createSession("r01-dev's session", "/tmp");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux new-session -d -s 'r01-dev'\"'\"'s session' -c '/tmp'"
      );
    });

    it("没有 cwd 时省略 -c flag", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.createSession("r01-dev1-impl");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux new-session -d -s 'r01-dev1-impl'"
      );
    });

    it("成功时返回 { ok: true }", async () => {
      const adapter = new TmuxAdapter(mockExec({ "new-session": { stdout: "" } }));
      const result: TmuxResult = await adapter.createSession("r01-dev1-impl");
      expect(result).toEqual({ ok: true });
    });

    it("提供 env map 时为每个 key=value 构建 -e flag", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.createSession("dev-impl@rig", "/tmp", {
        OPENRIG_NODE_ID: "node123",
        OPENRIG_SESSION_NAME: "dev-impl@rig",
      });

      const cmd = exec.mock.calls[0]![0] as string;
      expect(cmd).toContain("-e 'OPENRIG_NODE_ID=node123'");
      expect(cmd).toContain("-e 'OPENRIG_SESSION_NAME=dev-impl@rig'");
      expect(cmd).toContain("-s 'dev-impl@rig'");
      expect(cmd).toContain("-c '/tmp'");
    });

    it("没有 env 时仍与此前一样工作", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.createSession("r01-test", "/tmp");

      const cmd = exec.mock.calls[0]![0] as string;
      expect(cmd).not.toContain("-e ");
      expect(cmd).toBe("tmux new-session -d -s 'r01-test' -c '/tmp'");
    });

    it("重复时返回 { ok: false, code: 'duplicate_session' }", async () => {
      const err = new Error("duplicate session: r01-dev1-impl");
      const adapter = new TmuxAdapter(mockExec({ "new-session": { error: err } }));
      const result = await adapter.createSession("r01-dev1-impl");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("duplicate_session");
      }
    });
  });

  describe("sendText", () => {
    it.each([
      "hello world",
      "echo \"hello\" && $HOME's dir; `literal` $(literal)",
      "---\ntitle: pack\n---",
      "é🙂\n".repeat(752) + "end",
      "x".repeat(8191),
      "x".repeat(8192),
      "x".repeat(8193),
    ])("pastes text without embedding it in shell argv or submitting it (%#)", async (text) => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const writeFile = vi.fn(async () => {});
      const unlink = vi.fn(async () => {});
      const adapter = new TmuxAdapter(exec, {
        writeFile, unlink, tmpName: () => "/tmp/text.txt", bufferName: () => "fixture",
      });
      expect(await adapter.sendText("dev'qa@rig", text)).toEqual({ ok: true });
      expect(writeFile).toHaveBeenCalledWith("/tmp/text.txt", text);
      expect(exec.mock.calls.map(([cmd]) => cmd)).toEqual([
        "tmux load-buffer -b 'fixture' '/tmp/text.txt'",
        "tmux paste-buffer -t 'dev'\"'\"'qa@rig' -b 'fixture' -d -r -p",
      ]);
      expect(unlink).toHaveBeenCalledWith("/tmp/text.txt");
    });

    it("成功时返回 { ok: true }", async () => {
      const adapter = new TmuxAdapter(mockExec({ "paste-buffer": { stdout: "" } }));
      const result: TmuxResult = await adapter.sendText("r01-dev1-impl", "test");
      expect(result).toEqual({ ok: true });
    });

    it("target 缺失时返回 { ok: false, code: 'session_not_found' }", async () => {
      const err = new Error("can't find session: r01-dev1-impl");
      const adapter = new TmuxAdapter(mockExec({ "paste-buffer": { error: err } }));
      const result = await adapter.sendText("r01-dev1-impl", "test");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("session_not_found");
      }
    });
  });

  describe("sendKeys", () => {
    it("使用精确命令调用 exec（引用 target，并逐个引用 key 名称）", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.sendKeys("r01-dev1-impl", ["C-c", "Enter"]);

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux send-keys -t 'r01-dev1-impl' 'C-c' 'Enter'"
      );
    });

    it("逐个引用 shell 敏感的 key 名称", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.sendKeys("r01-dev1-impl", ["Enter; rm -rf /", "C-c"]);

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux send-keys -t 'r01-dev1-impl' 'Enter; rm -rf /' 'C-c'"
      );
    });

    it("成功时返回 { ok: true }", async () => {
      const adapter = new TmuxAdapter(mockExec({ "send-keys": { stdout: "" } }));
      const result: TmuxResult = await adapter.sendKeys("r01-dev1-impl", ["Enter"]);
      expect(result).toEqual({ ok: true });
    });

    it("target 缺失时返回 { ok: false, code: 'session_not_found' }", async () => {
      const err = new Error("can't find session: r01-dev1-impl");
      const adapter = new TmuxAdapter(mockExec({ "send-keys": { error: err } }));
      const result = await adapter.sendKeys("r01-dev1-impl", ["Enter"]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("session_not_found");
      }
    });
  });

  describe("killSession", () => {
    it("使用精确引用命令调用 exec", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.killSession("r01-dev1-impl");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux kill-session -t 'r01-dev1-impl'"
      );
    });

    it("成功时返回 { ok: true }", async () => {
      const adapter = new TmuxAdapter(mockExec({ "kill-session": { stdout: "" } }));
      const result: TmuxResult = await adapter.killSession("r01-dev1-impl");
      expect(result).toEqual({ ok: true });
    });

    it("session 缺失时返回 { ok: false, code: 'session_not_found' }", async () => {
      const err = new Error("can't find session: r01-dev1-impl");
      const adapter = new TmuxAdapter(mockExec({ "kill-session": { error: err } }));
      const result = await adapter.killSession("r01-dev1-impl");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("session_not_found");
      }
    });

    it("名称对 shell 敏感时使用精确引用命令", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.killSession("r01-dev's session");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux kill-session -t 'r01-dev'\"'\"'s session'"
      );
    });
  });

  describe("setSessionOption", () => {
    it("使用精确 tmux set-option 命令调用 exec（引用 session 与 key/value）", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.setSessionOption("organic-session", "@rigged_node_id", "node-abc123");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux set-option -t 'organic-session' '@rigged_node_id' 'node-abc123'"
      );
    });

    it("成功时返回 { ok: true }", async () => {
      const adapter = new TmuxAdapter(mockExec({ "set-option": { stdout: "" } }));
      const result = await adapter.setSessionOption("s", "@k", "v");
      expect(result).toEqual({ ok: true });
    });

    it("session 缺失时返回 { ok: false, code: 'session_not_found' }", async () => {
      const err = new Error("can't find session: ghost");
      const adapter = new TmuxAdapter(mockExec({ "set-option": { error: err } }));
      const result = await adapter.setSessionOption("ghost", "@k", "v");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("session_not_found");
    });
  });

  // OPR.0.4.6.02 S1（guard b2）——SERVER-scope writer/reader + scope 纪律约束：server option
  // 使用 `-s`，绝不使用 `-t` session target；session option 使用 `-t`，绝不使用 `-s`。
  // 两者绝不交叉。
  describe("setServerOption / showServerOption (OPR.0.4.6.02 S1)", () => {
    it("setServerOption 发出引用 option 的 `set-option -s`——有 -s，无 -t", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.setServerOption("set-clipboard", "on");

      expect(exec).toHaveBeenCalledOnce();
      const cmd = exec.mock.calls[0]![0];
      expect(cmd).toBe("tmux set-option -s 'set-clipboard' 'on'");
      expect(cmd).toContain(" -s ");
      expect(cmd).not.toContain(" -t ");
    });

    it("setServerOption 安全引用含空格的 copy-command 值", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);
      await adapter.setServerOption("copy-command", "xclip -selection clipboard -i");
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux set-option -s 'copy-command' 'xclip -selection clipboard -i'"
      );
    });

    it("setServerOption 通过 classifyWriteError 返回 ok:false（不抛错）", async () => {
      const adapter = new TmuxAdapter(mockExec({ "set-option": { error: new Error("no server running") } }));
      const result = await adapter.setServerOption("set-clipboard", "on");
      expect(result.ok).toBe(false);
    });

    it("showServerOption 通过 `show-options -sv` 读取", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("on\n");
      const adapter = new TmuxAdapter(exec);
      const v = await adapter.showServerOption("set-clipboard");
      expect(exec.mock.calls[0]![0]).toBe("tmux show-options -sv 'set-clipboard'");
      expect(v).toBe("on");
    });

    it("未设置、为空或出错时 showServerOption 返回 null", async () => {
      const empty = new TmuxAdapter(vi.fn<ExecFn>().mockResolvedValue("  \n"));
      expect(await empty.showServerOption("copy-command")).toBeNull();
      const errored = new TmuxAdapter(mockExec({ "show-options": { error: new Error("no server running") } }));
      expect(await errored.showServerOption("copy-command")).toBeNull();
    });

    it("SCOPE 交叉检查：session writer 使用 -t（无 -s）；server writer 使用 -s（无 -t）", async () => {
      const sessExec = vi.fn<ExecFn>().mockResolvedValue("");
      await new TmuxAdapter(sessExec).setSessionOption("sess", "mouse", "on");
      const sessCmd = sessExec.mock.calls[0]![0];
      expect(sessCmd).toContain(" -t ");
      expect(sessCmd).not.toContain(" -s ");

      const srvExec = vi.fn<ExecFn>().mockResolvedValue("");
      await new TmuxAdapter(srvExec).setServerOption("mouse", "on");
      const srvCmd = srvExec.mock.calls[0]![0];
      expect(srvCmd).toContain(" -s ");
      expect(srvCmd).not.toContain(" -t ");
    });
  });

  describe("getSessionOption", () => {
    it("使用精确 tmux show-option -v 命令调用 exec", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("node-abc123\n");
      const adapter = new TmuxAdapter(exec);

      const val = await adapter.getSessionOption("organic-session", "@rigged_node_id");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux show-option -v -t 'organic-session' '@rigged_node_id'"
      );
      expect(val).toBe("node-abc123");
    });

    it("出错时返回 null（找不到 session、无 server 等）", async () => {
      const err = new Error("can't find session: ghost");
      const adapter = new TmuxAdapter(mockExec({ "show-option": { error: err } }));
      const val = await adapter.getSessionOption("ghost", "@rigged_node_id");
      expect(val).toBeNull();
    });

    it("输出为空时返回 null", async () => {
      const adapter = new TmuxAdapter(mockExec({ "show-option": { stdout: "\n" } }));
      const val = await adapter.getSessionOption("s", "@k");
      expect(val).toBeNull();
    });
  });

  describe("包含 @ 的规范 session 名称", () => {
    it("createSession + sendKeys 处理含 @ 名称时生成正确引用命令", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      // 使用规范名称 createSession。
      await adapter.createSession("dev-impl@auth-feats", "/home/user/code");
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux new-session -d -s 'dev-impl@auth-feats' -c '/home/user/code'"
      );

      // sendKeys 指向规范名称。
      await adapter.sendKeys("dev-impl@auth-feats", ["Enter"]);
      expect(exec.mock.calls[1]![0]).toBe(
        "tmux send-keys -t 'dev-impl@auth-feats' 'Enter'"
      );

      // sendText 指向规范名称。
      await adapter.sendText("dev-impl@auth-feats", "hello");
      expect(exec.mock.calls[3]![0]).toMatch(
        /^tmux paste-buffer -t 'dev-impl@auth-feats' -b '[^']+' -d -r -p$/
      );
    });
  });

  describe("格式错误的输出", () => {
    it("跳过无效行，返回有效行", async () => {
      const output = [
        "good-session|2|2026-03-23T01:00:00|1",
        "this is garbage",
        "",
        "another-good|1|2026-03-23T02:00:00|0",
      ].join("\n");

      const adapter = new TmuxAdapter(mockExec({ "list-sessions": { stdout: output } }));
      const sessions = await adapter.listSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions[0]!.name).toBe("good-session");
      expect(sessions[1]!.name).toBe("another-good");
    });
  });

  // Discovery adapter 扩展。
  describe("getPanePid", () => {
    it("从 tmux 输出返回解析后的整数 PID", async () => {
      const exec: ExecFn = async () => "1234\n";
      const adapter = new TmuxAdapter(exec);
      const pid = await adapter.getPanePid("%0");
      expect(pid).toBe(1234);
    });

    it("输出为空或非数值时返回 null", async () => {
      const exec: ExecFn = async () => "\n";
      const adapter = new TmuxAdapter(exec);
      expect(await adapter.getPanePid("%0")).toBeNull();

      const exec2: ExecFn = async () => "not-a-pid";
      const adapter2 = new TmuxAdapter(exec2);
      expect(await adapter2.getPanePid("%0")).toBeNull();
    });
  });

  describe("getPaneCommand", () => {
    it("从 tmux 输出返回命令字符串", async () => {
      const exec: ExecFn = async () => "claude\n";
      const adapter = new TmuxAdapter(exec);
      const cmd = await adapter.getPaneCommand("%0");
      expect(cmd).toBe("claude");
    });

    it("输出为空时返回 null", async () => {
      const exec: ExecFn = async () => "\n";
      const adapter = new TmuxAdapter(exec);
      expect(await adapter.getPaneCommand("%0")).toBeNull();
    });
  });

  describe("capturePaneContent", () => {
    it("使用 shell 引用调用精确 tmux capture-pane 命令", async () => {
      const exec: ExecFn = vi.fn(async () => "line 1\nline 2\n") as unknown as ExecFn;
      const adapter = new TmuxAdapter(exec);

      const content = await adapter.capturePaneContent("%0");

      expect(content).toBe("line 1\nline 2\n");
      expect(exec).toHaveBeenCalledWith("tmux capture-pane -p -t '%0' -S -20");
    });

    it("出错时返回 null", async () => {
      const exec: ExecFn = async () => { throw new Error("pane gone"); };
      const adapter = new TmuxAdapter(exec);

      expect(await adapter.capturePaneContent("%0")).toBeNull();
    });

    it("使用自定义行数", async () => {
      const exec: ExecFn = vi.fn(async () => "output") as unknown as ExecFn;
      const adapter = new TmuxAdapter(exec);

      await adapter.capturePaneContent("%5", 50);

      expect(exec).toHaveBeenCalledWith("tmux capture-pane -p -t '%5' -S -50");
    });
  });

  describe("startPipePane", () => {
    it("使用已引用的 session 名称和路径构建 shell-safe 命令", async () => {
      const exec: ExecFn = vi.fn(async () => "") as unknown as ExecFn;
      const adapter = new TmuxAdapter(exec);

      await adapter.startPipePane("dev-impl@my-rig", "/home/user/.openrig/transcripts/my-rig/dev-impl@my-rig.log");

      // 命令为：tmux pipe-pane -t <quoted session> <quoted 'cat >> <quoted path>'>
      const cmd = (exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(cmd).toContain("tmux pipe-pane -t 'dev-impl@my-rig'");
      expect(cmd).toContain("cat >>");
      expect(cmd).toContain("dev-impl@my-rig.log");
    });

    it("在 pipe 命令内安全引用含空格路径", async () => {
      const exec: ExecFn = vi.fn(async () => "") as unknown as ExecFn;
      const adapter = new TmuxAdapter(exec);

      await adapter.startPipePane("dev@rig", "/path/with spaces/transcript.log");

      const cmd = (exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(cmd).toContain("tmux pipe-pane -t 'dev@rig'");
      expect(cmd).toContain("cat >>");
      expect(cmd).toContain("with spaces");
    });

    it("安全处理路径中的单引号", async () => {
      const exec: ExecFn = vi.fn(async () => "") as unknown as ExecFn;
      const adapter = new TmuxAdapter(exec);

      await adapter.startPipePane("dev@rig", "/path/it's/transcript.log");

      const cmd = (exec as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(cmd).toContain("tmux pipe-pane -t 'dev@rig'");
      // 单引号应被转义，不应原样保留。
      expect(cmd).not.toContain("it's/");
    });

    it("遇到 session not found 错误时返回 { ok: false }", async () => {
      const exec: ExecFn = vi.fn(async () => { throw new Error("can't find session: dev@rig"); }) as unknown as ExecFn;
      const adapter = new TmuxAdapter(exec);

      const result = await adapter.startPipePane("dev@rig", "/tmp/test.log");
      expect(result).toEqual({ ok: false, code: "session_not_found", message: "can't find session: dev@rig" });
    });
  });

  describe("stopPipePane", () => {
    it("构建正确的空 pipe-pane 命令", async () => {
      const exec: ExecFn = vi.fn(async () => "") as unknown as ExecFn;
      const adapter = new TmuxAdapter(exec);

      await adapter.stopPipePane("dev-impl@my-rig");

      expect(exec).toHaveBeenCalledWith("tmux pipe-pane -t 'dev-impl@my-rig'");
    });
  });

  describe("readPaneLastActivity", () => {
    it("构建 `tmux display-message -p -t <pane> '#{window_activity}'`", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("1716000000\n");
      const adapter = new TmuxAdapter(exec);

      await adapter.readPaneLastActivity("dev@rig");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux display-message -p -t 'dev@rig' '#{window_activity}'",
      );
    });

    it("tmux 返回数值时返回 Unix epoch 秒整数", async () => {
      const adapter = new TmuxAdapter(mockExec({ "display-message": { stdout: "1716000000\n" } }));
      expect(await adapter.readPaneLastActivity("dev@rig")).toBe(1716000000);
    });

    it("读取错误/session 缺失（无信号）时返回 null", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "display-message": { error: new Error("can't find session: dev@rig") },
      }));
      expect(await adapter.readPaneLastActivity("dev@rig")).toBe(null);
    });

    it("tmux 返回空白值时返回 null（slice 15 BLOCKING 修复判别项——在 tmux 3.6a 上观察到）", async () => {
      const adapter = new TmuxAdapter(mockExec({ "display-message": { stdout: "" } }));
      expect(await adapter.readPaneLastActivity("dev@rig")).toBe(null);
    });

    it("输出无法解析时返回 null（防御性处理——daemon 不应因 tmux 异常而崩溃）", async () => {
      const adapter = new TmuxAdapter(mockExec({ "display-message": { stdout: "garbage" } }));
      expect(await adapter.readPaneLastActivity("dev@rig")).toBe(null);
    });

    it("零/负整数时返回 null（未初始化 window_activity 的 sentinel）", async () => {
      const a = new TmuxAdapter(mockExec({ "display-message": { stdout: "0\n" } }));
      expect(await a.readPaneLastActivity("dev@rig")).toBe(null);
      const b = new TmuxAdapter(mockExec({ "display-message": { stdout: "-5\n" } }));
      expect(await b.readPaneLastActivity("dev@rig")).toBe(null);
    });
  });

  // OPR.0.3.3.16——大 payload transport。把大于 100KB 的启动包嵌入单个 tmux/shell argv
  // 会超过操作系统单参数限制并导致启动静默失败，因此 sendText 通过临时文件 + tmux buffer
  // 路由大文本。`paste-buffer -d -r -p`：`-r` 保留原始 LF（tmux 默认粘贴把 LF→CR = Enter，
  // 会在 Claude/Codex TUI 中灾难性地逐行提交）；`-d` 在粘贴成功后删除 buffer。
  describe("sendText 大 payload buffer 路径", () => {
    // 刚刚超过 100KB 字节阈值（ASCII => 1 字节/字符）。
    const BIG = "x".repeat(100 * 1024 + 1);

    function fixedFileOps() {
      const writeFile = vi.fn(async () => {});
      const unlink = vi.fn(async () => {});
      return {
        ops: {
          writeFile,
          unlink,
          tmpName: () => "/tmp/openrig-tmux-send-FIXED.txt",
          bufferName: () => "openrig_FIXED",
        },
        writeFile,
        unlink,
      };
    }

    it("通过 fs 写临时文件并粘贴；payload 永不进入任何 exec 命令", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const { ops, writeFile, unlink } = fixedFileOps();
      const adapter = new TmuxAdapter(exec, ops);

      const result: TmuxResult = await adapter.sendText("dev@rig", BIG);

      expect(result).toEqual({ ok: true });
      // 原始 payload 通过 fs 写入磁盘，不嵌入 shell 命令。
      expect(writeFile).toHaveBeenCalledWith("/tmp/openrig-tmux-send-FIXED.txt", BIG);
      const cmds = exec.mock.calls.map((c) => c[0] as string);
      expect(cmds).toEqual([
        "tmux load-buffer -b 'openrig_FIXED' '/tmp/openrig-tmux-send-FIXED.txt'",
        "tmux paste-buffer -t 'dev@rig' -b 'openrig_FIXED' -d -r -p",
      ]);
      // argv 大小回归：payload 绝不能进入 exec 命令。
      for (const cmd of cmds) expect(cmd).not.toContain(BIG);
      // finally 中清理临时文件。
      expect(unlink).toHaveBeenCalledWith("/tmp/openrig-tmux-send-FIXED.txt");
    });

    it("超过 tmux INLINE 命令上限但低于旧 100KB 边界的 payload 走 buffer 路径（world-install walk specimen）", async () => {
      // Test-A preflight 修复（row 0ac358a9）：19.8KB 片段在线上遇到 tmux 自身的
      // "command too long"；tmux 的 inline 命令行上限远低于操作系统单参数限制（实测约
      // 9.4KB）。超过 inline 上限的内容必须通过 load-buffer/paste-buffer 路由。
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const { ops, writeFile } = fixedFileOps();
      const adapter = new TmuxAdapter(exec, ops);
      const MID = "y".repeat(20 * 1024);

      const result: TmuxResult = await adapter.sendText("dev@rig", MID);

      expect(result).toEqual({ ok: true });
      expect(writeFile).toHaveBeenCalledWith("/tmp/openrig-tmux-send-FIXED.txt", MID);
      for (const cmd of exec.mock.calls.map((c) => c[0] as string)) expect(cmd).not.toContain(MID);
    });

    it("大 payload 路径 target 缺失时返回 session_not_found，且不泄漏临时文件或 buffer", async () => {
      // load-buffer 成功（buffer 为全局）；paste-buffer 因 target 缺失而失败。
      const exec = vi.fn<ExecFn>(async (cmd: string) => {
        if (cmd.includes("paste-buffer")) throw new Error("can't find session: dev@rig");
        return "";
      });
      const { ops, unlink } = fixedFileOps();
      const adapter = new TmuxAdapter(exec, ops);

      const result = await adapter.sendText("dev@rig", BIG);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("session_not_found");
      const cmds = exec.mock.calls.map((c) => c[0] as string);
      // buffer 已加载，随后在错误路径显式删除（无泄漏）。
      expect(cmds).toContain("tmux delete-buffer -b 'openrig_FIXED'");
      // 无论成功失败都 unlink 临时文件（无泄漏）。
      expect(unlink).toHaveBeenCalledWith("/tmp/openrig-tmux-send-FIXED.txt");
    });

    it("每次调用生成唯一临时文件和 buffer 名称（并行 zrig up 时并发安全）", async () => {
      // 默认（生产）fileOps——证明真实生成器具有唯一性。exec 已 mock，不运行真实 tmux；
      // 临时文件写入操作系统 tmpdir，并在 finally 中移除。
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.sendText("dev@rig", BIG);
      await adapter.sendText("dev@rig", BIG);

      const loadCmds = exec.mock.calls
        .map((c) => c[0] as string)
        .filter((cmd) => cmd.startsWith("tmux load-buffer"));
      expect(loadCmds).toHaveLength(2);
      expect(loadCmds[0]).not.toBe(loadCmds[1]);
    });
  });

  // OPR.0.4.0.38——从 FR-4 seed 工作（.worktrees/opr-0.4.0.1-ff-interaction-model，
  // 仅磁盘）提升的全新 live-seed primitive。broker 用当前可见屏幕 + cursor 初始化新 subscriber，
  // 使实时 terminal 立即绘制，不必保持空白直到下一次输出。
  describe("capturePaneScreen（可见屏幕，不含 scrollback）", () => {
    it("调用 `tmux capture-pane -p -t <pane>` 且无 -S flag（scrollback 会重新引入行漂移）", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("row a\nrow b\n");
      const adapter = new TmuxAdapter(exec);

      const out = await adapter.capturePaneScreen("%0");

      expect(out).toBe("row a\nrow b\n");
      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe("tmux capture-pane -p -t '%0'");
    });

    it("安全地对 session-name target 做 shell 引用", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("x");
      const adapter = new TmuxAdapter(exec);

      await adapter.capturePaneScreen("dev-impl@my-rig");

      expect(exec.mock.calls[0]![0]).toBe("tmux capture-pane -p -t 'dev-impl@my-rig'");
    });

    it("出错（pane 消失）时返回 null", async () => {
      const adapter = new TmuxAdapter(async () => { throw new Error("can't find pane"); });
      expect(await adapter.capturePaneScreen("%0")).toBeNull();
    });

    it("输出为空（无内容可 seed）时返回 null", async () => {
      const adapter = new TmuxAdapter(mockExec({ "capture-pane": { stdout: "" } }));
      expect(await adapter.capturePaneScreen("%0")).toBeNull();
    });
  });

  describe("getPaneCursorPosition", () => {
    const EXPECTED_CMD =
      `tmux display-message -p -t '%0' "#{cursor_x}\t#{cursor_y}\t#{pane_width}\t#{pane_height}"`;

    it("构建 tab 分隔的 display-message 命令并解析 {x,y,width,height}", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("4\t7\t120\t40\n");
      const adapter = new TmuxAdapter(exec);

      const pos = await adapter.getPaneCursorPosition("%0");

      expect(exec.mock.calls[0]![0]).toBe(EXPECTED_CMD);
      expect(pos).toEqual({ x: 4, y: 7, width: 120, height: 40 });
    });

    it("接受零 cursor 原点（x=0、y=0 有效）", async () => {
      const adapter = new TmuxAdapter(mockExec({ "display-message": { stdout: "0\t0\t80\t24\n" } }));
      expect(await adapter.getPaneCursorPosition("%0")).toEqual({ x: 0, y: 0, width: 80, height: 24 });
    });

    it("出错时返回 null", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "display-message": { error: new Error("can't find session") },
      }));
      expect(await adapter.getPaneCursorPosition("%0")).toBeNull();
    });

    it("输出无法解析/非有限值时返回 null", async () => {
      const adapter = new TmuxAdapter(mockExec({ "display-message": { stdout: "garbage\n" } }));
      expect(await adapter.getPaneCursorPosition("%0")).toBeNull();
    });

    it("geometry 越界（width<1 / 坐标为负）时返回 null", async () => {
      const zeroWidth = new TmuxAdapter(mockExec({ "display-message": { stdout: "1\t1\t0\t40\n" } }));
      expect(await zeroWidth.getPaneCursorPosition("%0")).toBeNull();
      const negX = new TmuxAdapter(mockExec({ "display-message": { stdout: "-1\t1\t80\t24\n" } }));
      expect(await negX.getPaneCursorPosition("%0")).toBeNull();
    });
  });

  // OPR.0.4.3.26——seat-recovery switch-client view 重定向。两个新的 read/switch seam；
  // 仅 view（不修改 session，不改变 routing/identity）。
  describe("listClients", () => {
    it("使用精确 tmux list-clients 命令与格式字符串调用 exec", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.listClients();

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        'tmux list-clients -F "#{client_name}\t#{client_session}"'
      );
    });

    it("把输出解析为类型化 TmuxClient 对象（name + session）", async () => {
      const output = [
        "/dev/ttys003\tdev-impl@my-rig",
        "/dev/ttys007\tother-session",
      ].join("\n");

      const adapter = new TmuxAdapter(mockExec({ "list-clients": { stdout: output } }));
      const clients = await adapter.listClients();

      expect(clients).toHaveLength(2);
      expect(clients[0]).toEqual({ name: "/dev/ttys003", session: "dev-impl@my-rig" });
      expect(clients[1]).toEqual({ name: "/dev/ttys007", session: "other-session" });
    });

    it("遇到 'no server running' 错误（无可 attach client）时返回空数组", async () => {
      const adapter = new TmuxAdapter(mockExec({ "list-clients": { error: NO_SERVER_ERROR } }));
      expect(await adapter.listClients()).toEqual([]);
    });

    it("重启后 tmux socket 消失时返回空数组", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "list-clients": { error: new Error("error connecting to /private/tmp/tmux-501/default (No such file or directory)") },
      }));
      expect(await adapter.listClients()).toEqual([]);
    });

    it("重新抛出意外错误（权限），而非报告无 client", async () => {
      const adapter = new TmuxAdapter(mockExec({
        "list-clients": { error: new Error("error connecting to /private/tmp/tmux-501/default (Permission denied)") },
      }));
      await expect(adapter.listClients()).rejects.toThrow("Permission denied");
    });

    it("跳过格式错误（单字段）的行", async () => {
      const output = ["garbage-no-tab", "/dev/ttys003\tdev-impl@my-rig", ""].join("\n");
      const adapter = new TmuxAdapter(mockExec({ "list-clients": { stdout: output } }));
      const clients = await adapter.listClients();
      expect(clients).toEqual([{ name: "/dev/ttys003", session: "dev-impl@my-rig" }]);
    });
  });

  describe("switchClient", () => {
    it("使用精确 `switch-client -c <client> -t <session>:<window>` 命令调用 exec", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      const result: TmuxResult = await adapter.switchClient("/dev/ttys003", "dev-impl@my-rig:0");

      expect(result).toEqual({ ok: true });
      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux switch-client -c '/dev/ttys003' -t 'dev-impl@my-rig:0'"
      );
    });

    it("对含敏感字符的 client 与 target 做 shell 引用", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.switchClient("client's tty", "dev's-rig:1");

      expect(exec.mock.calls[0]![0]).toBe(
        "tmux switch-client -c 'client'\"'\"'s tty' -t 'dev'\"'\"'s-rig:1'"
      );
    });

    it("target session 消失时返回 { ok: false, code: 'session_not_found' }", async () => {
      const err = new Error("can't find session: dev-impl@my-rig");
      const adapter = new TmuxAdapter(mockExec({ "switch-client": { error: err } }));
      const result = await adapter.switchClient("/dev/ttys003", "dev-impl@my-rig:0");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("session_not_found");
    });
  });

  // Seat-handover 切换（plan 411c43de）：successor 通过 respawn-pane 在同一 pane 中恢复，因此
  // 原生 scrollback 得以保留（predecessor 历史位于 successor 启动内容上方）。
  describe("respawnPane", () => {
    it("原地 respawn pane 且不使用 -k（retiree 已退出；-k 会清除 scrollback）", async () => {
      // 实测（tmux 3.6a）：respawn-pane -k 会清除 pane scrollback，破坏关键证明。切换先终止
      // retiree（优雅退出 + remain-on-exit），再以无 -k 方式 respawn 已失活 pane，从而保留
      // successor 启动内容上方的 predecessor 历史。
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.respawnPane("%3", "openrig-agent --resume tok");

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe("tmux respawn-pane -t '%3' 'openrig-agent --resume tok'");
      expect(exec.mock.calls[0]![0]).not.toContain(" -k"); // -k clears scrollback — never used
    });

    it("提供 env + cwd 时注入 -c 与 -e flag（successor 在复用 pane 中自我标识），命令保持最后", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.respawnPane("%3", "openrig-agent --resume tok", {
        cwd: "/w",
        env: { OPENRIG_NODE_ID: "node123", OPENRIG_SESSION_NAME: "dev-impl@rig" },
      });

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux respawn-pane -t '%3' -c '/w' -e 'OPENRIG_NODE_ID=node123' -e 'OPENRIG_SESSION_NAME=dev-impl@rig' 'openrig-agent --resume tok'",
      );
    });

    it("无命令时重新运行 pane 默认 login shell（省略末尾 command 参数）", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);

      await adapter.respawnPane("%3", undefined, {
        cwd: "/w",
        env: { OPENRIG_SESSION_NAME: "dev-impl@rig" },
      });

      expect(exec).toHaveBeenCalledOnce();
      expect(exec.mock.calls[0]![0]).toBe(
        "tmux respawn-pane -t '%3' -c '/w' -e 'OPENRIG_SESSION_NAME=dev-impl@rig'",
      );
    });

    it("把写入错误（无 server）分类为失败", async () => {
      const adapter = new TmuxAdapter(mockExec({ "respawn-pane": { error: NO_SERVER_ERROR } }));
      const result = await adapter.respawnPane("%3", "cmd");
      expect(result.ok).toBe(false);
    });
  });

  describe("setRemainOnExit", () => {
    it("设置 pane-scoped remain-on-exit option，使 pane 在 retiree 退出后保留（供 respawn）", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);
      await adapter.setRemainOnExit("%3", true);
      expect(exec.mock.calls[0]![0]).toBe("tmux set-option -p -t '%3' remain-on-exit on");
    });
    it("使用 off 清除该选项", async () => {
      const exec = vi.fn<ExecFn>().mockResolvedValue("");
      const adapter = new TmuxAdapter(exec);
      await adapter.setRemainOnExit("%3", false);
      expect(exec.mock.calls[0]![0]).toBe("tmux set-option -p -t '%3' remain-on-exit off");
    });
  });

  describe("isPaneDead", () => {
    it("pane_dead 为 1 时返回 true（retiree 已退出；pane 由 remain-on-exit 保留）", async () => {
      const adapter = new TmuxAdapter(mockExec({ "display-message": { stdout: "1\n" } }));
      expect(await adapter.isPaneDead("%3")).toBe(true);
    });
    it("pane_dead 为 0 时返回 false（retiree 仍存活）", async () => {
      const adapter = new TmuxAdapter(mockExec({ "display-message": { stdout: "0\n" } }));
      expect(await adapter.isPaneDead("%3")).toBe(false);
    });
    it("tmux 证明 pane 在 TERM 后消失时返回 true", async () => {
      const adapter = new TmuxAdapter(async () => { throw new Error("can't find pane: %3"); });
      expect(await adapter.isPaneDead("%3")).toBe(true);
    });
    it("唯一 pane 退出导致 tmux server 移除时返回 true", async () => {
      const adapter = new TmuxAdapter(mockExec({ "display-message": { error: NO_SERVER_ERROR } }));
      expect(await adapter.isPaneDead("%3")).toBe(true);
    });
    it.each(["permission denied", "unrecognized tmux probe failure"])(
      "returns false (never throws) for unproven probe failure: %s",
      async (message) => {
        const adapter = new TmuxAdapter(async () => { throw new Error(message); });
        expect(await adapter.isPaneDead("%3")).toBe(false);
      },
    );
  });

  describe("signalPaneProcess", () => {
    it("向 pane 前台 pid 发送指定 signal（优雅 TERM / 回退 KILL）", async () => {
      const calls: string[] = [];
      const exec = vi.fn<ExecFn>(async (cmd: string) => { calls.push(cmd); return cmd.includes("pane_pid") ? "4242\n" : ""; });
      const adapter = new TmuxAdapter(exec);
      const res = await adapter.signalPaneProcess("%3", "TERM");
      expect(res.ok).toBe(true);
      expect(calls.some((c) => c.includes("#{pane_pid}") && c.includes("'%3'"))).toBe(true);
      expect(calls).toContain("kill -TERM 4242");
    });
    it("pane pid 不可用时返回失败（不抛错）", async () => {
      const adapter = new TmuxAdapter(mockExec({ "display-message": { stdout: "\n" } }));
      const res = await adapter.signalPaneProcess("%3", "KILL");
      expect(res.ok).toBe(false);
    });
  });
});
