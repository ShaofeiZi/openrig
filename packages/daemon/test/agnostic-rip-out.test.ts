import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// OPR.0.4.8.2——agnostic permission RIP-OUT（founder 锁定；rip-list = ASSESSMENT sha 5d450fdd）。
// 移除 floor 之外三项由 OpenRig 内置的 CONFIG-FILE policy 写入：C1b（fragment permissions.allow）、
// C1c（fragment permissions.ask）、C2（provisionRigPermissions 全局 allow）。逐字节保留 usability
// floor（fragment defaultMode=acceptEdits + `--permission-mode acceptEdits` 启动参数）。双 surface
// 规则：移除 config-file 写入，保留 launch-flag floor。RED-first：rip 断言在发布 allow/ask + rig
// allow 的 f81018fb 上失败。

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRAGMENT_PATH = path.join(__dirname, "../specs/agents/shared/runtime/claude-settings.fragment.json");

function mockTmux(): TmuxAdapter {
  return {
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
  } as unknown as TmuxAdapter;
}

function mockFs(files?: Record<string, string>): ClaudeAdapterFsOps & { _store: Record<string, string> } {
  const store: Record<string, string> = { ...files };
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
    listFiles: (dir: string) => Object.keys(store).filter((k) => k.startsWith(dir + "/")).map((k) => k.slice(dir.length + 1)),
    _store: store,
  } as ClaudeAdapterFsOps & { _store: Record<string, string> };
}

function makeBinding(cwd = "/project"): NodeBinding {
  return {
    id: "b1",
    nodeId: "n1",
    tmuxSession: "r01-impl",
    tmuxWindow: null,
    tmuxPane: null,
    cmuxWorkspace: null,
    cmuxSurface: null,
    updatedAt: "",
    cwd,
  };
}

describe("OPR.0.4.8.2 agnostic rip-out——移除 config-file policy 写入，保留 launch-flag floor", () => {
  it("C1b/C1c：已发布 fragment 不含 permissions.allow / ask / deny", () => {
    const frag = JSON.parse(fs.readFileSync(FRAGMENT_PATH, "utf8"));
    expect(frag.permissions.allow).toBeUndefined();
    expect(frag.permissions.ask).toBeUndefined();
    expect(frag.permissions.deny).toBeUndefined();
  });

  it("保留 floor：fragment permissions.defaultMode 恰为 acceptEdits，且 mcp server 不变", () => {
    const frag = JSON.parse(fs.readFileSync(FRAGMENT_PATH, "utf8"));
    expect(Object.keys(frag.permissions)).toEqual(["defaultMode"]); // 只保留 floor key。
    expect(frag.permissions.defaultMode).toBe("acceptEdits");
    expect(frag.enabledMcpjsonServers).toEqual(["exa", "context7"]);
  });

  it("C2：fresh startup 不为 permission 编写 ~/.claude/settings.json", async () => {
    const fsm = mockFs({});
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: { ...fsm, homedir: "/home/test" } });
    await adapter.deliverStartup([], makeBinding());
    // rip 后不再仅为 permission 编写任何内容。（Trust/onboarding 写 ~/.claude.json，而非 settings.json。）
    expect(fsm._store["/home/test/.claude/settings.json"]).toBeUndefined();
  });

  it("不做 retro-scrub：预先存在且带 provenance 标记的 settings.json 保持逐字节一致", async () => {
    // 注意：此处没有 Bash(rig:*)，因此 rip 前代码会添加并重写它（这就是 RED）。
    const existing = JSON.stringify(
      { permissions: { allow: ["Bash(npm:*)"] }, _openrig_provenance: { author: "openrig-at-spawn", baseline: "convenience" } },
      null,
      2,
    );
    const fsm = mockFs({ "/home/test/.claude/settings.json": existing });
    const adapter = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: { ...fsm, homedir: "/home/test" } });
    await adapter.deliverStartup([], makeBinding());
    expect(fsm._store["/home/test/.claude/settings.json"]).toBe(existing); // 逐字节一致，未触碰。
  });

  it("逐字节保留 floor launch flag：启动命令仍包含 --permission-mode acceptEdits", async () => {
    const tmux = mockTmux();
    const adapter = new ClaudeCodeAdapter({
      tmux,
      fsOps: mockFs(),
      sessionIdFactory: () => "11111111-1111-4111-8111-111111111111",
    });
    const result = await adapter.launchHarness(makeBinding(), { name: "dev-impl@test-rig" });
    expect(result.ok).toBe(true);
    const sendText = tmux.sendText as ReturnType<typeof vi.fn>;
    const cmd = sendText.mock.calls[0]?.[1] as string;
    expect(cmd).toContain("--permission-mode acceptEdits");
  });
});
