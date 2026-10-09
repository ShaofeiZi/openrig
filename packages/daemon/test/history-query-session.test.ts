import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryQuery } from "../src/domain/history-query.js";

const throwExec = async () => {
  throw new Error("会话文件缺失时不得调用 shell");
};

describe("HistoryQuery.searchSession——按令牌查询逐会话 JSONL（L2）", () => {
  let projectsRoot: string;
  beforeEach(() => {
    projectsRoot = mkdtempSync(join(tmpdir(), "rigask-proj-"));
  });
  afterEach(() => {
    rmSync(projectsRoot, { recursive: true, force: true });
  });

  function writeSessionJsonl(encodedCwd: string, token: string, lines: string[]): void {
    const dir = join(projectsRoot, encodedCwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${token}.jsonl`), lines.join("\n") + "\n", "utf-8");
  }

  it("按令牌定位任意编码 cwd 目录下的会话 JSONL，并返回内容命中", async () => {
    const token = "abc-123-session";
    writeSessionJsonl("-Users-me-proj", token, [
      JSON.stringify({ type: "user", text: "部署网关" }),
      JSON.stringify({ type: "assistant", text: "SECRET_MARKER 位于此处" }),
    ]);

    // exec 代替 rg/grep——断言它针对已定位文件调用，且其输出被解析为摘录。
    const execSpy = vi.fn(async () => ({
      stdout: '{"type":"assistant","text":"SECRET_MARKER 位于此处"}\n',
      exitCode: 0,
    }));

    const hq = new HistoryQuery({ transcriptsRoot: "/unused", exec: execSpy, claudeProjectsRoot: projectsRoot });
    const res = await hq.searchSession(token, "SECRET_MARKER");

    expect(res.found).toBe(true);
    expect(res.token).toBe(token);
    expect(res.excerpts.some((e) => e.includes("SECRET_MARKER"))).toBe(true);
    expect(res.insufficient).toBe(false);
    // exec 针对已定位的 <token>.jsonl 文件运行
    expect(execSpy).toHaveBeenCalled();
    const argv = execSpy.mock.calls[0]![1] as string[];
    expect(argv.some((a) => a.endsWith(`${token}.jsonl`))).toBe(true);
  });

  it("令牌没有会话文件时如实返回未找到（session_not_found）", async () => {
    const hq = new HistoryQuery({ transcriptsRoot: "/unused", exec: throwExec, claudeProjectsRoot: projectsRoot });
    const res = await hq.searchSession("nonexistent-token", "anything");

    expect(res.found).toBe(false);
    expect(res.degraded?.reason).toBe("session_not_found");
    expect(res.degraded?.message).toMatch(/token/i);
    expect(res.insufficient).toBe(true);
  });
});
