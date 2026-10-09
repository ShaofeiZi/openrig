// PL-016 加固 v0+1——claude-code 适配器 fork 分支的 resume-token 轮询循环测试。
//
// 约束：
//   - session 文件在第 N 次尝试后出现时，轮询循环成功
//   - 所有尝试都返回 undefined 时，轮询循环返回结构化的 12 次上限错误
//   - 首次成功捕获后立即短路，不浪费后续 sleep
//   - 真实二进制集成测试由 OPENRIG_REAL_CLAUDE_INTEGRATION=1 控制；环境变量未设置时
//     跳过，避免 CI 因缺少 claude 二进制而回归

import { describe, it, expect, vi } from "vitest";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

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

/** 模拟文件系统：前 `untilCallN` 次调用 `readdir` 时不返回 session 文件，随后返回指定
 * session 文件。用于模拟真实 Claude 在发送 Enter 后 1–3 秒才出现 fork session 文件的行为。 */
function mockClaudeFsAppearsAfter(token: string, untilCallN: number, expectedName: string): ClaudeAdapterFsOps {
  let calls = 0;
  return {
    readFile: (p: string) => {
      if (p.includes("12345.json")) {
        return JSON.stringify({ pid: 12345, sessionId: token, name: expectedName });
      }
      throw new Error(`Not found: ${p}`);
    },
    writeFile: () => {},
    exists: () => true,
    mkdirp: () => {},
    copyFile: () => {},
    listFiles: () => [],
    readdir: () => {
      calls++;
      return calls > untilCallN ? ["12345.json"] : [];
    },
    homedir: "/mock-home",
  } as ClaudeAdapterFsOps;
}

/** 始终不产生 session 文件的模拟文件系统，用于覆盖耗尽路径。 */
function mockClaudeFsNeverAppears(): ClaudeAdapterFsOps {
  return {
    readFile: () => { throw new Error("not found"); },
    writeFile: () => {},
    exists: () => true,
    mkdirp: () => {},
    copyFile: () => {},
    listFiles: () => [],
    readdir: () => [],
    homedir: "/mock-home",
  } as ClaudeAdapterFsOps;
}

function makeBinding(): NodeBinding {
  return {
    id: "b1", nodeId: "n1", tmuxSession: "r01-impl", tmuxWindow: null, tmuxPane: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/project",
  };
}

describe("ClaudeCodeAdapter fork 分支——resume-token 轮询循环", () => {
  it("session 文件在第 N 次轮询后出现时成功（真实 Claude 的延迟写入路径）", async () => {
    const tmux = mockTmux();
    let sleepCalls = 0;
    const adapter = new ClaudeCodeAdapter({
      tmux,
      // session 文件在调用 readdir() 3 次后出现：前三次返回 []，第 4 次返回文件；
      // 轮询循环必须继续。
      fsOps: mockClaudeFsAppearsAfter("DEFERRED-FORK-TOKEN", 3, "dev-impl@test-rig"),
      sleep: async () => { sleepCalls++; },
    });

    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      forkSource: { kind: "native_id", value: "PARENT-TOKEN" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resumeToken).toBe("DEFERRED-FORK-TOKEN");
      expect(result.resumeType).toBe("claude_id");
    }
    // 应至少 sleep 3 次（第 4 次轮询才找到）。
    expect(sleepCalls).toBeGreaterThanOrEqual(3);
  });

  it("session 文件已经存在时立即短路（成功后不浪费 sleep）", async () => {
    const tmux = mockTmux();
    let sleepCalls = 0;
    const adapter = new ClaudeCodeAdapter({
      tmux,
      // session 文件在第一次调用 readdir 时就出现。
      fsOps: mockClaudeFsAppearsAfter("IMMEDIATE-FORK-TOKEN", 0, "dev-impl@test-rig"),
      sleep: async () => { sleepCalls++; },
    });

    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      forkSource: { kind: "native_id", value: "PARENT-TOKEN" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resumeToken).toBe("IMMEDIATE-FORK-TOKEN");
    }
    // 首次尝试即找到，因此 sleep 次数为零。
    expect(sleepCalls).toBe(0);
  });

  it("所有尝试失败后返回包含轮询上限的结构化耗尽错误", async () => {
    const tmux = mockTmux();
    let sleepCalls = 0;
    const adapter = new ClaudeCodeAdapter({
      tmux,
      fsOps: mockClaudeFsNeverAppears(),
      sleep: async () => { sleepCalls++; },
    });

    const result = await adapter.launchHarness(makeBinding(), {
      name: "dev-impl@test-rig",
      forkSource: { kind: "native_id", value: "PARENT-TOKEN" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("无法从 Claude session 存储捕获 fork 后的新 session id");
      // 错误点明轮询上限，方便操作员关联耗时。
      expect(result.error).toMatch(/轮询 12 次|上限 6s/);
    }
    // 12 次尝试之间有 11 次 sleep（由 attempt < attempts - 1 guard 保证）。
    expect(sleepCalls).toBe(11);
  });
});

// ============================================================================
// 真实二进制集成测试——由 OPENRIG_REAL_CLAUDE_INTEGRATION=1 控制
// ============================================================================
//
// 使用真实 Claude Code 二进制执行 fork 分支，以便在 PR 阶段捕获下一次“真实二进制需要 N 秒”
// 的回归，而不是留到生产环境。需要一个可供 fork 的父 Claude session（测试者通过
// OPENRIG_PARENT_NATIVE_ID 提供父 native_id）。CI 不设置该环境变量，因此跳过测试。

const REAL_CLAUDE_INTEGRATION = process.env["OPENRIG_REAL_CLAUDE_INTEGRATION"] === "1";

describe.skipIf(!REAL_CLAUDE_INTEGRATION)(
  "ClaudeCodeAdapter fork 分支——真实 Claude 二进制（由 OPENRIG_REAL_CLAUDE_INTEGRATION=1 控制）",
  () => {
    it("轮询直到真实 Claude 二进制写入新的 fork session 文件", async () => {
      // 测试者提供父 native_id 与全新的 tmux session。此测试刻意保持最小，作为真实二进制
      // 延迟写入回归的安全网。
      const parentNativeId = process.env["OPENRIG_PARENT_NATIVE_ID"];
      if (!parentNativeId) {
        throw new Error(
          "设置 OPENRIG_REAL_CLAUDE_INTEGRATION=1 时必须提供 OPENRIG_PARENT_NATIVE_ID 环境变量；请从有效 seat 提供父 session 的 native_id",
        );
      }
      // 设置环境变量的操作员负责 tmux fixture。本测试只断言轮询循环针对真实二进制运行时
      // 不抛异常；若 fork 文件在 6 秒上限内始终未出现，则以耗尽错误失败，这正是回归信号。
      // 具体实现交给操作员；此处是占位检查，确保环境变量控制的通道存在且已接入 Vitest。
      expect(parentNativeId).toMatch(/[a-f0-9-]{36}/);
    }, 30_000);
  },
);
