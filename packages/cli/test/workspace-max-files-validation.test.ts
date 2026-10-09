// release-0.3.2 slice 01 BC 修复——HG-6 判别式。
// 验证 `rig workspace validate --max-files <garbage>` 在 CLI 侧以三段错误拒绝，
// 且不调用 daemon。匹配守卫 BC-1 修复配方。

import { describe, expect, it, vi } from "vitest";
import { workspaceCommand, parseMaxFilesStrict, type WorkspaceDeps } from "../src/commands/workspace.js";
import type { LifecycleDeps } from "../src/daemon-lifecycle.js";

function captureStdout(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  return { logs, restore: () => { console.log = original; } };
}

function captureStderr(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => { logs.push(String(chunk)); return true; }) as typeof process.stderr.write;
  return { logs, restore: () => { process.stderr.write = original; } };
}

function fakeRunningDeps(post: ReturnType<typeof vi.fn>): WorkspaceDeps {
  return {
    lifecycleDeps: {} as LifecycleDeps,
    clientFactory: () => ({
      post,
      get: vi.fn(),
      postText: vi.fn(),
    }) as unknown as ReturnType<WorkspaceDeps["clientFactory"]>,
  };
}

describe("parseMaxFilesStrict — pure helper", () => {
  it("accepts positive integers", () => {
    expect(parseMaxFilesStrict("1")).toBe(1);
    expect(parseMaxFilesStrict("12")).toBe(12);
    expect(parseMaxFilesStrict("10000")).toBe(10000);
  });
  it("rejects garbage tails (BC-1 root cause)", () => {
    expect(() => parseMaxFilesStrict("12abc")).toThrow(/正整数/);
  });
  it("rejects non-numeric input", () => {
    expect(() => parseMaxFilesStrict("abc")).toThrow(/正整数/);
    expect(() => parseMaxFilesStrict("")).toThrow(/正整数/);
  });
  it("rejects zero and negatives", () => {
    expect(() => parseMaxFilesStrict("0")).toThrow(/正整数/);
    expect(() => parseMaxFilesStrict("-1")).toThrow(/正整数/);
  });
  it("3-part error carries fact + consequence + action fields", () => {
    try {
      parseMaxFilesStrict("12abc");
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as Error & { fact?: string; consequence?: string; action?: string };
      expect(e.fact).toMatch(/正整数/);
      expect(e.consequence).toMatch(/未运行/);
      expect(e.action).toMatch(/请传一个正整数/);
    }
  });
});

describe("rig workspace validate --max-files — CLI-side discriminator (BLOCK 1)", () => {
  it("rejects '12abc' with --json: exit=1, body.error has fact/consequence/action, client.post NOT called", async () => {
    const post = vi.fn();
    const deps = fakeRunningDeps(post);
    const out = captureStdout();
    const originalExitCode = process.exitCode;
    process.exitCode = 0;
    const root = workspaceCommand(deps);
    await root.parseAsync(["node", "rig", "validate", "/tmp/ws", "--max-files", "12abc", "--json"]);
    out.restore();
    const exitCode = process.exitCode;
    process.exitCode = originalExitCode;
    expect(exitCode).toBe(1);
    expect(post).not.toHaveBeenCalled();
    const joined = out.logs.join("\n");
    const parsed = JSON.parse(joined);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.fact).toMatch(/正整数/);
    expect(parsed.error.consequence).toMatch(/未运行/);
    expect(parsed.error.action).toMatch(/--max-files/);
  });

  it("rejects 'abc', '0', '-1' equivalently", async () => {
    for (const bad of ["abc", "0", "-1"]) {
      const post = vi.fn();
      const deps = fakeRunningDeps(post);
      const out = captureStdout();
      const root = workspaceCommand(deps);
      const originalExitCode = process.exitCode;
      process.exitCode = 0;
      await root.parseAsync(["node", "rig", "validate", "/tmp/ws", "--max-files", bad, "--json"]);
      out.restore();
      const exitCode = process.exitCode;
      process.exitCode = originalExitCode;
      expect(exitCode, `--max-files ${bad} should fail`).toBe(1);
      expect(post, `--max-files ${bad} must not call the daemon`).not.toHaveBeenCalled();
    }
  });

  it("emits 3-part error to stderr in human mode (no --json)", async () => {
    const post = vi.fn();
    const deps = fakeRunningDeps(post);
    const err = captureStderr();
    const originalExitCode = process.exitCode;
    process.exitCode = 0;
    const root = workspaceCommand(deps);
    await root.parseAsync(["node", "rig", "validate", "/tmp/ws", "--max-files", "12abc"]);
    err.restore();
    const exitCode = process.exitCode;
    process.exitCode = originalExitCode;
    expect(exitCode).toBe(1);
    expect(post).not.toHaveBeenCalled();
    const joined = err.logs.join("");
    expect(joined).toMatch(/错误：.*正整数/);
    expect(joined).toMatch(/未运行/);
    expect(joined).toMatch(/请传一个正整数/);
  });

  // 正向用例已由上方 parseMaxFilesStrict 纯 helper 测试
  // （"accepts positive integers"）覆盖；此处端到端驱动
  // 还需 stub daemon-status 检查，而那已被覆盖
  // by the daemon-lifecycle adopt/expand test pattern (out of scope
  // for this BC discriminator).
});
