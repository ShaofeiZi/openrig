// OPR.0.4.1.29 — command-level `rig auth` surface: --runtime axis + structured output wiring.
//（secret-leak 覆盖见 codex-auth-leakhunt.test.ts；lib 语义见其他 suite。）
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authCommand } from "../src/commands/auth.js";

const NOW = () => "2026-06-26T00:00:00Z";
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "codexauth-cmd-"));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

// 捕获一次调用的 stdout/stderr 及结果 process.exitCode，绝不污染 runner。
async function run(subArgs: string[]): Promise<{ out: string; code: number | undefined }> {
  const chunks: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origExit = process.exitCode;
  process.exitCode = undefined;
  console.log = (...a: unknown[]) => void chunks.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void chunks.push(a.map(String).join(" "));
  let code: number | undefined;
  try {
    const cmd = authCommand({ env: { CODEX_HOME: home, HOME: home }, loginStatus: () => "unavailable", now: NOW });
    await cmd.parseAsync(subArgs, { from: "user" });
    code = process.exitCode as number | undefined;
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.exitCode = origExit;
  }
  return { out: chunks.join("\n"), code };
}

describe("rig auth command surface (OPR.0.4.1.29)", () => {
  it("--runtime non-codex is rejected on every verb (harness = flag, MVP codex only)", async () => {
    for (const v of [["status"], ["list"], ["save", "p"], ["switch", "p"], ["validate", "p"], ["seats", "list"]]) {
      const { out, code } = await run([...v, "--runtime", "claude-code"]);
      expect(out).toContain("unsupported_runtime");
      expect(code).toBe(1);
    }
  });

  it("status reports structured presence fields (no secrets) on an empty CODEX_HOME", async () => {
    const { out } = await run(["status"]);
    expect(out).toContain(`Codex 主目录：${home}`);
    expect(out).toContain("当前认证存在：否");
    expect(out).toContain("已保存档案：0");
    expect(out).toContain("登录状态：unavailable");
  });

  it("save without an active auth.json fails with a structured reason + exit 1", async () => {
    const { out, code } = await run(["save", "work"]);
    expect(out).toContain("not_configured");
    expect(code).toBe(1);
  });

  it("seats output carries the labels-are-not-proof-of-live-account disclaimer", async () => {
    await run(["seats", "set", "--seat", "a@r", "--rig", "r", "--profile", "work"]);
    const { out } = await run(["seats", "list"]);
    expect(out).toMatch(/不.*(证明)|元数据/);
    const report = await run(["seats", "report"]);
    expect(report.out).toMatch(/不.*(证明)|元数据/);
  });

  it("invalid profile name fails closed (whitelist)", async () => {
    const { out, code } = await run(["validate", "../escape"]);
    expect(out).toContain("invalid_profile");
    expect(code).toBe(1);
  });
});
