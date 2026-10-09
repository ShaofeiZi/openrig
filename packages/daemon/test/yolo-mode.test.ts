import { mockShellCommand } from "./helpers/shell-command-mock.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { yoloEnabled, codexPostureArg, piTrust } from "../src/adapters/yolo-mode.js";
import { buildCodexResumeCore } from "../src/domain/native-resume-probe.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// OPR.0.4.8.2 接缝 3——OpenRig YOLO 模式（可选启用，默认关闭；仅影响启动标志，不写配置）。
// RED 优先：在 f81018fb 上，yoloEnabled/绕过标志尚不存在。

afterEach(() => {
  delete process.env.OPENRIG_YOLO;
});

function mockTmux(): TmuxAdapter {
  return mockShellCommand({
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => ""),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter);
}
function mockFs(): ClaudeAdapterFsOps {
  const store: Record<string, string> = {};
  return {
    readFile: (p: string) => {
      if (p in store) return store[p]!;
      throw new Error(`未找到：${p}`);
    },
    writeFile: (p: string, c: string) => {
      store[p] = c;
    },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    copyFile: () => {},
    listFiles: () => [],
  } as ClaudeAdapterFsOps;
}
function makeBinding(cwd = "/project"): NodeBinding {
  return { id: "b1", nodeId: "n1", tmuxSession: "r01-impl", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd };
}
async function claudeLaunchCmd(): Promise<string> {
  const tmux = mockTmux();
  const adapter = new ClaudeCodeAdapter({ tmux, fsOps: mockFs(), sessionIdFactory: () => "11111111-1111-4111-8111-111111111111" });
  await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig" });
  return (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
}

describe("OPR.0.4.8.2 YOLO 模式——可选启用、默认关闭、仅影响启动标志", () => {
  it("yoloEnabled：除非 OPENRIG_YOLO 显式为 1/true，否则关闭", () => {
    expect(yoloEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(yoloEnabled({ OPENRIG_YOLO: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(yoloEnabled({ OPENRIG_YOLO: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(yoloEnabled({ OPENRIG_YOLO: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(yoloEnabled({ OPENRIG_YOLO: "yes" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("Claude：关闭 -> floor --permission-mode acceptEdits；开启 -> --dangerously-skip-permissions", async () => {
    delete process.env.OPENRIG_YOLO;
    const off = await claudeLaunchCmd();
    expect(off).toContain("--permission-mode acceptEdits");
    expect(off).not.toContain("--dangerously-skip-permissions");

    process.env.OPENRIG_YOLO = "1";
    const on = await claudeLaunchCmd();
    expect(on).toContain("--dangerously-skip-permissions");
    expect(on).not.toContain("--permission-mode acceptEdits");
  });

  it("Codex resume：关闭 -> 显式 -s workspace-write floor 标志；开启 -> -s danger-full-access", () => {
    delete process.env.OPENRIG_YOLO;
    const off = buildCodexResumeCore("tok-1", null, false);
    expect(off).toBe("codex -s workspace-write resume 'tok-1'");

    process.env.OPENRIG_YOLO = "1";
    const on = buildCodexResumeCore("tok-1", null, false);
    expect(on).toContain("-s danger-full-access");
  });

  it("Codex resume 开启时连命名配置 profile 也会被覆盖（每个 seat 均为 -s danger-full-access）", () => {
    process.env.OPENRIG_YOLO = "1";
    const on = buildCodexResumeCore("tok-1", "my-profile", false);
    expect(on).toContain("-s danger-full-access");
    expect(on).not.toContain("-p 'my-profile'");
  });

  // ── 仅接线 fresh 时遗漏的三条托管启动路径（守卫发现）──

  it("Claude RESTORE（ClaudeResumeAdapter）携带姿态标志：关闭为 floor / 开启为 bypass", async () => {
    delete process.env.OPENRIG_YOLO;
    const tmuxOff = mockTmux();
    await new ClaudeResumeAdapter(tmuxOff).resume("r01-impl", "claude_name", "my-session", "/repo");
    const off = (tmuxOff.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(off).toContain("--permission-mode acceptEdits");
    expect(off).toContain("--resume 'my-session'");

    process.env.OPENRIG_YOLO = "1";
    const tmuxOn = mockTmux();
    await new ClaudeResumeAdapter(tmuxOn).resume("r01-impl", "claude_name", "my-session", "/repo");
    const on = (tmuxOn.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(on).toContain("--dangerously-skip-permissions");
    expect(on).not.toContain("--permission-mode acceptEdits");
  });

  it("Codex 原生 FORK 携带姿态：关闭为 -s workspace-write / 开启为 -s danger-full-access", async () => {
    const codexFs = {
      readFile: () => { throw new Error("nf"); },
      writeFile: () => {},
      exists: () => false,
      mkdirp: () => {},
      copyFile: () => {},
      listFiles: () => [],
    } as unknown as ConstructorParameters<typeof CodexRuntimeAdapter>[0]["fsOps"];
    const forkOpts = { name: "dev-impl@test-rig", forkSource: { kind: "native_id" as const, value: "parent-123" } };

    delete process.env.OPENRIG_YOLO;
    const tmuxOff = mockTmux();
    await new CodexRuntimeAdapter({ tmux: tmuxOff, fsOps: codexFs }).launchHarness(makeBinding(), forkOpts);
    const off = (tmuxOff.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(off).toContain("fork");
    expect(off).toContain("-s workspace-write");
    expect(off).not.toContain("-s danger-full-access");

    process.env.OPENRIG_YOLO = "1";
    const tmuxOn = mockTmux();
    await new CodexRuntimeAdapter({ tmux: tmuxOn, fsOps: codexFs }).launchHarness(makeBinding(), forkOpts);
    const on = (tmuxOn.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(on).toContain("-s danger-full-access");
    expect(on).toContain("fork");
  });

  it("codexPostureArg：关闭且无 profile -> 显式 -s workspace-write floor；关闭且有 profile -> 原样传递；开启 -> -s danger-full-access", () => {
    expect(codexPostureArg(" -p 'x'", {} as NodeJS.ProcessEnv)).toBe(" -p 'x'");
    expect(codexPostureArg("", {} as NodeJS.ProcessEnv)).toBe(" -s workspace-write");
    expect(codexPostureArg(" -p 'x'", { OPENRIG_YOLO: "1" } as NodeJS.ProcessEnv)).toBe(" -s danger-full-access");
  });

  it("piTrust（资源信任，而非权限策略）：关闭时保留配置值/no-approve；开启时强制 approve", () => {
    expect(piTrust("no-approve", {} as NodeJS.ProcessEnv)).toBe("no-approve");
    expect(piTrust(undefined, {} as NodeJS.ProcessEnv)).toBe("no-approve");
    expect(piTrust("approve", {} as NodeJS.ProcessEnv)).toBe("approve");
    expect(piTrust("no-approve", { OPENRIG_YOLO: "1" } as NodeJS.ProcessEnv)).toBe("approve");
  });
});
