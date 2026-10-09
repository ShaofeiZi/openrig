import { describe, it, expect, vi } from "vitest";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// P20 atom 3b——应用时记录。除非 projector 实际记录其写入内容，否则 discrimination
//（conflict-detector）与 enable path（rigspec-instantiator wiring pin）都不起作用。这里固定 WRITE
// 侧：adapter 安装 skill file 时，必须将所写的精确 target + content 提交给 manifest，使后续
// projection 能区分 stale_overwrite 与 operator_conflict。若漏掉 recordProjection 调用，每个 target
// 都会回退到 P17 永久 fallback（lookup null → hash_conflict），形成静默失效器——因此这里会变 RED。

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
      throw new Error(`Not found: ${p}`);
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
  } as NodeBinding;
}

function skillFile(): ResolvedStartupFile {
  return {
    path: "SKILL.md",
    absolutePath: "/src/skills/my-skill/SKILL.md",
    ownerRoot: "/src",
    deliveryHint: "skill_install",
    required: true,
    appliesOn: ["fresh_start"],
    kind: "file",
  };
}

describe("P20 record-at-apply——adapter 在 skill_install 时记录 manifest", () => {
  it("记录其写入的精确 target path + content", async () => {
    const CONTENT = "# my-skill\nprojected body v1\n";
    const recorded: Array<{ target: string; content: string }> = [];
    const adapter = new ClaudeCodeAdapter({
      tmux: mockTmux(),
      fsOps: mockFs({ "/src/skills/my-skill/SKILL.md": CONTENT }),
      recordProjection: (target: string, content: string) => recorded.push({ target, content }),
    });

    await adapter.deliverStartup([skillFile()], makeBinding("/project"));

    expect(recorded).toHaveLength(1);
    // target == 实际写入路径（cwd/.claude/skills/<skill-dir>/SKILL.md），也正是后续
    // projection 将分类的路径。
    expect(recorded[0]!.target).toBe("/project/.claude/skills/my-skill/SKILL.md");
    // content == 写入的 byte（因此 hashContent(recorded) == target 未来的 hash）。
    expect(recorded[0]!.content).toBe(CONTENT);
  });

  it("没有 skill 可安装时不记录（send_text 不是 projection）", async () => {
    const recorded: Array<{ target: string; content: string }> = [];
    const adapter = new ClaudeCodeAdapter({
      tmux: mockTmux(),
      fsOps: mockFs({ "/src/prompt.txt": "hello" }),
      recordProjection: (target: string, content: string) => recorded.push({ target, content }),
    });

    await adapter.deliverStartup(
      [{
        path: "prompt.txt",
        absolutePath: "/src/prompt.txt",
        ownerRoot: "/src",
        deliveryHint: "send_text",
        required: false,
        appliesOn: ["fresh_start"],
        kind: "file",
      }],
      makeBinding("/project"),
    );

    expect(recorded).toHaveLength(0);
  });
});
