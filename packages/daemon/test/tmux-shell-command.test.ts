import { describe, it, expect, vi } from "vitest";
import { TmuxAdapter, type TmuxFileOps } from "../src/adapters/tmux.js";

function fixture(fail?: string, scriptPath = "/tmp/launch 'quoted'.sh") {
  const files = new Map<string, string>();
  let names = 0;
  const fileOps: TmuxFileOps = {
    tmpName: () => names++ === 0 ? scriptPath : "/tmp/paste.txt",
    bufferName: () => "buffer",
    writeFile: vi.fn(async (path, text) => { files.set(path, text); }),
    unlink: vi.fn(async path => { files.delete(path); }),
  };
  const commands: string[] = [];
  const exec = vi.fn(async (command: string) => {
    commands.push(command);
    if (fail && command.includes(fail)) throw new Error("传输被拒绝");
    return "";
  });
  return { adapter: new TmuxAdapter(exec, fileOps), fileOps, files, commands, scriptPath };
}

describe("shell 启动传输", () => {
  it("避免将长 PATH/带引号参数写入终端输入，并保留脚本直至被消费", async () => {
    const f = fixture();
    const command = `env PATH='${"p".repeat(4096)}' codex -s workspace-write resume 'same-native-id' -m 'chosen-model'`;
    expect(await f.adapter.sendShellCommand("pane", command)).toEqual({ ok: true });
    expect(f.fileOps.writeFile).toHaveBeenNthCalledWith(1, f.scriptPath,
      `/bin/rm -f -- '/tmp/launch '\"'\"'quoted'\"'\"'.sh'\n${command}\n`, { mode: 0o600, flag: "wx" });
    const invocation = vi.mocked(f.fileOps.writeFile).mock.calls[1]![1];
    expect(Buffer.byteLength(invocation)).toBeLessThan(512);
    expect(invocation).toBe(`/bin/sh '/tmp/launch '\"'\"'quoted'\"'\"'.sh'`);
    expect(f.files.get(f.scriptPath)).toContain(command);
    expect(f.files.has("/tmp/paste.txt")).toBe(false);
    expect(f.commands.at(-1)).toBe("tmux send-keys -t 'pane' 'Enter'");
  });

  it.each(["load-buffer", "paste-buffer", "'Enter'"])("%s 失败时移除未消费脚本", async failure => {
    const f = fixture(failure);
    expect(await f.adapter.sendShellCommand("pane", "codex resume 'same-id'")).toMatchObject({ ok: false });
    expect(f.files.size).toBe(0);
    expect(f.commands.some(command => command.endsWith("'C-c'"))).toBe(failure === "'Enter'");
    expect(f.commands.some(command => command.endsWith("'Enter'"))).toBe(failure === "'Enter'");
  });

  it("在写入或发送前拒绝过长的引导路径", async () => {
    const f = fixture(undefined, "/tmp/" + "a".repeat(512));
    expect(await f.adapter.sendShellCommand("pane", "codex")).toMatchObject({ ok: false, code: "launch_path_too_long" });
    expect(f.fileOps.writeFile).not.toHaveBeenCalled();
    expect(f.commands).toEqual([]);
  });

  it("独占创建失败时不移除预先存在的文件", async () => {
    const f = fixture();
    f.files.set(f.scriptPath, "保留的字节");
    vi.mocked(f.fileOps.writeFile).mockRejectedValueOnce(new Error("EEXIST"));
    expect(await f.adapter.sendShellCommand("pane", "codex")).toMatchObject({ ok: false });
    expect(f.files.get(f.scriptPath)).toBe("保留的字节");
    expect(f.fileOps.unlink).not.toHaveBeenCalled();
    expect(f.commands).toEqual([]);
  });
});
