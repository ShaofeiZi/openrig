// OPR.0.4.6.02 S1——共享 tmux option-defaults applier（由 NodeLauncher 与
// SuccessorSessionLauncher 使用）及纯逐平台 copy-command 表的单元覆盖。工作范围纪律约束
//（guard b2）：mouse/status 属于 SESSION scope（setSessionOption）；set-clipboard/copy-command
// 属于 SERVER scope（setServerOption），两者绝不交叉。
import { describe, it, expect, vi } from "vitest";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import {
  TmuxOptionDefaultsApplier,
  resolveCopyCommand,
} from "../src/domain/tmux-option-defaults.js";

const OK: TmuxResult = { ok: true };

function mockAdapter(overrides?: {
  setSessionOption?: (s: string, k: string, v: string) => Promise<TmuxResult>;
  setServerOption?: (o: string, v: string) => Promise<TmuxResult>;
}) {
  const setSessionOption = vi.fn(overrides?.setSessionOption ?? (async () => OK));
  const setServerOption = vi.fn(overrides?.setServerOption ?? (async () => OK));
  const adapter = { setSessionOption, setServerOption } as unknown as TmuxAdapter;
  return { adapter, setSessionOption, setServerOption };
}

describe("TmuxOptionDefaultsApplier", () => {
  it("只通过 SESSION scope 为指定会话设置 mouse on + 默认 status off", async () => {
    const { adapter, setSessionOption, setServerOption } = mockAdapter();
    // 默认 reader（省略）→ statusBar false。
    const warnings = await new TmuxOptionDefaultsApplier({ tmuxAdapter: adapter, platform: "darwin", hasCommand: () => true })
      .applyToFreshSession("r01-dev1@rig");

    expect(warnings).toEqual([]);
    // mouse + status 以精确会话名应用于 SESSION scope。
    expect(setSessionOption).toHaveBeenCalledWith("r01-dev1@rig", "mouse", "on");
    expect(setSessionOption).toHaveBeenCalledWith("r01-dev1@rig", "status", "off");
    // set-clipboard + copy-command 属于 SERVER scope，绝不通过 setSessionOption。
    const sessionKeys = setSessionOption.mock.calls.map((c) => c[1]);
    expect(sessionKeys).not.toContain("set-clipboard");
    expect(sessionKeys).not.toContain("copy-command");
    expect(setServerOption).toHaveBeenCalledWith("set-clipboard", "on");
  });

  it("配置 reader 返回 statusBar=true 时开启 status（未来启动在应用时读取）", async () => {
    const { adapter, setSessionOption } = mockAdapter();
    const applier = new TmuxOptionDefaultsApplier({
      tmuxAdapter: adapter,
      readTmuxOptionDefaults: () => ({ statusBar: true }),
      platform: "linux",
      hasCommand: () => false,
    });
    await applier.applyToFreshSession("r01-dev1@rig");
    expect(setSessionOption).toHaveBeenCalledWith("r01-dev1@rig", "status", "on");
  });

  it("reader 抛错时回退为 status off", async () => {
    const { adapter, setSessionOption } = mockAdapter();
    const applier = new TmuxOptionDefaultsApplier({
      tmuxAdapter: adapter,
      readTmuxOptionDefaults: () => { throw new Error("settings unavailable"); },
      platform: "darwin",
      hasCommand: () => false,
    });
    await applier.applyToFreshSession("r01-dev1@rig");
    expect(setSessionOption).toHaveBeenCalledWith("r01-dev1@rig", "status", "off");
  });

  it("每个 applier 只断言一次 server 默认值（memoized），但每次调用都重新应用 session options", async () => {
    const { adapter, setSessionOption, setServerOption } = mockAdapter();
    const applier = new TmuxOptionDefaultsApplier({ tmuxAdapter: adapter, platform: "darwin", hasCommand: () => true });

    await applier.applyToFreshSession("sess-a");
    await applier.applyToFreshSession("sess-b");

    // 两次 launch 中 set-clipboard 恰好断言一次（共享 memo）。
    const clipCalls = setServerOption.mock.calls.filter((c) => c[0] === "set-clipboard");
    expect(clipCalls).toHaveLength(1);
    // 但每个新会话仍获得自己的 mouse+status。
    expect(setSessionOption).toHaveBeenCalledWith("sess-a", "mouse", "on");
    expect(setSessionOption).toHaveBeenCalledWith("sess-b", "mouse", "on");
  });

  it("darwin 通过 SERVER scope 设置 copy-command=pbcopy", async () => {
    const { adapter, setServerOption } = mockAdapter();
    await new TmuxOptionDefaultsApplier({ tmuxAdapter: adapter, platform: "darwin" }).applyToFreshSession("s");
    expect(setServerOption).toHaveBeenCalledWith("copy-command", "pbcopy");
  });

  it("linux 缺少 wl-copy/xclip 时跳过 copy-command（回退到 set-clipboard OSC 52）", async () => {
    const { adapter, setServerOption } = mockAdapter();
    await new TmuxOptionDefaultsApplier({ tmuxAdapter: adapter, platform: "linux", hasCommand: () => false }).applyToFreshSession("s");
    const copyCalls = setServerOption.mock.calls.filter((c) => c[0] === "copy-command");
    expect(copyCalls).toHaveLength(0);
    // set-clipboard 仍会断言。
    expect(setServerOption).toHaveBeenCalledWith("set-clipboard", "on");
  });

  it("option set 失败时收集非致命 warning，绝不抛错", async () => {
    const { adapter } = mockAdapter({
      setSessionOption: async (_s, k) =>
        k === "mouse" ? { ok: false, code: "unknown", message: "boom" } : OK,
      setServerOption: async (o) =>
        o === "set-clipboard" ? { ok: false, code: "unknown", message: "no server" } : OK,
    });
    const applier = new TmuxOptionDefaultsApplier({ tmuxAdapter: adapter, platform: "linux", hasCommand: () => false });
    const warnings = await applier.applyToFreshSession("sess-x");
    expect(warnings.some((w) => w.includes("mouse") && w.includes("boom"))).toBe(true);
    expect(warnings.some((w) => w.includes("set-clipboard") && w.includes("no server"))).toBe(true);
  });
});

describe("resolveCopyCommand（纯逐平台表）", () => {
  it("darwin → pbcopy", () => {
    expect(resolveCopyCommand("darwin", () => false)).toBe("pbcopy");
  });
  it("linux 存在 wl-copy 时 → wl-copy", () => {
    expect(resolveCopyCommand("linux", (b) => b === "wl-copy")).toBe("wl-copy");
  });
  it("linux 缺少 wl-copy 但存在 xclip 时 → xclip", () => {
    expect(resolveCopyCommand("linux", (b) => b === "xclip")).toBe("xclip -selection clipboard -i");
  });
  it("linux 两者都缺失时 → null（OSC 52 回退）", () => {
    expect(resolveCopyCommand("linux", () => false)).toBeNull();
  });
  it("其他平台 → null", () => {
    expect(resolveCopyCommand("win32", () => true)).toBeNull();
  });
});
