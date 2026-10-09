import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { RuntimeVerifier } from "../src/domain/runtime-verifier.js";
import type { ExecFn } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


function createMockExec(responses: Record<string, string | Error>): ExecFn {
  return vi.fn(async (cmd: string) => {
    for (const [pattern, response] of Object.entries(responses)) {
      if (cmd.includes(pattern)) {
        if (response instanceof Error) throw response;
        return response;
      }
    }
    throw new Error("command not found");
  }) as unknown as ExecFn;
}

describe("RuntimeVerifier", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
  });

  afterEach(() => {
    db.close();
  });

  // T1：tmux 存在 + 版本可解析 -> verified
  it("tmux 存在且版本可解析 -> verified", async () => {
    const exec = createMockExec({ "tmux -V": "tmux 3.4" });
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyTmux();

    expect(result.status).toBe("verified");
    expect(result.version).toBe("3.4");
    expect(result.runtime).toBe("tmux");
  });

  // T2：tmux 缺失 -> not_found
  it("tmux 缺失 -> not_found", async () => {
    const exec = createMockExec({});
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyTmux();

    expect(result.status).toBe("not_found");
    expect(result.error).toBeTruthy();
  });

  // T3：cmux capabilities --json 成功 -> verified，并包含 capabilities_json
  it("cmux capabilities 成功 -> verified，capabilities_json 为有效 JSON 字符串", async () => {
    const capsOutput = JSON.stringify({ workspaces: true, surfaces: true, notifications: false });
    const exec = createMockExec({ "cmux capabilities --json": capsOutput });
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyCmux();

    expect(result.status).toBe("verified");
    expect(result.runtime).toBe("cmux");
    // capabilities_json 是有效 JSON 字符串
    expect(result.capabilitiesJson).toBeTruthy();
    const parsed = JSON.parse(result.capabilitiesJson!);
    expect(parsed.workspaces).toBe(true);
    expect(parsed.surfaces).toBe(true);
  });

  // T4：cmux 缺失 -> degraded
  it("cmux 缺失 -> degraded（不阻塞）", async () => {
    const exec = createMockExec({});
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyCmux();

    expect(result.status).toBe("degraded");
    expect(result.runtime).toBe("cmux");
  });

  // T5：claude --version 成功 -> verified
  it("claude --version 成功 -> verified", async () => {
    const exec = createMockExec({ "claude --version": "claude 1.0.23" });
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyClaude();

    expect(result.status).toBe("verified");
    expect(result.version).toBe("1.0.23");
    expect(result.runtime).toBe("claude-code");
  });

  // T6：codex --version 成功 -> verified
  it("codex --version 成功 -> verified", async () => {
    const exec = createMockExec({ "codex --version": "codex 0.5.1" });
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyCodex();

    expect(result.status).toBe("verified");
    expect(result.version).toBe("0.5.1");
    expect(result.runtime).toBe("codex");
  });

  // T7：verifyTmux 自动持久化到 DB
  it("verification 自动持久化到 runtime_verifications 表", async () => {
    const exec = createMockExec({ "tmux -V": "tmux 3.4" });
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyTmux();

    const row = db.prepare("SELECT * FROM runtime_verifications WHERE runtime = ?")
      .get("tmux") as { id: string; runtime: string; version: string; status: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.runtime).toBe("tmux");
    expect(row!.version).toBe("3.4");
    expect(row!.status).toBe("verified");
    expect(row!.id).toBe(result.id);
  });

  // T8：重复验证 tmux 两次 -> 只有 1 行
  it("重复 verification 更新现有记录（每个 runtime 1 行）", async () => {
    const exec = createMockExec({ "tmux -V": "tmux 3.4" });
    const verifier = new RuntimeVerifier({ exec, db });

    await verifier.verifyTmux();
    await verifier.verifyTmux();

    const rows = db.prepare("SELECT * FROM runtime_verifications WHERE runtime = ?")
      .all("tmux") as Array<{ id: string }>;

    expect(rows).toHaveLength(1);
  });

  // T9：claude --version 失败、--help 成功 -> verified，version=null
  it("claude --version 失败但 --help 成功 -> verified，version 为 null", async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (cmd === "claude --version") throw new Error("not found");
      if (cmd === "claude --help") return "Claude Code CLI\nUsage: claude [options]";
      throw new Error("unknown command");
    }) as unknown as ExecFn;
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyClaude();

    expect(result.status).toBe("verified");
    expect(result.version).toBeNull();
    expect(result.runtime).toBe("claude-code");
  });

  // T10：持久化的 runtime 字段为规范名称 'claude-code'
  it("持久化的 runtime 字段匹配规范名称 'claude-code'", async () => {
    const exec = createMockExec({ "claude --version": "claude 1.0.0" });
    const verifier = new RuntimeVerifier({ exec, db });

    await verifier.verifyClaude();

    const row = db.prepare("SELECT * FROM runtime_verifications WHERE runtime = ?")
      .get("claude-code") as { runtime: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.runtime).toBe("claude-code");
  });

  // T11：codex --version 失败、--help 成功 -> verified，version=null
  it("codex --version 失败但 --help 成功 -> verified，version 为 null", async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (cmd === "codex --version") throw new Error("not found");
      if (cmd === "codex --help") return "Codex CLI\nUsage: codex [options]";
      throw new Error("unknown command");
    }) as unknown as ExecFn;
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyCodex();

    expect(result.status).toBe("verified");
    expect(result.version).toBeNull();
    expect(result.runtime).toBe("codex");
  });

  // T12：tmux -V 输出乱码 -> status='error'
  it("tmux -V 输出无法解析 -> error 状态", async () => {
    const exec = createMockExec({ "tmux -V": "some garbage with no version" });
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyTmux();

    expect(result.status).toBe("error");
    expect(result.error).toContain("unparseable");
    expect(result.version).toBeNull();
  });

  // T13：cmux 返回无效 JSON -> status='error'
  it("cmux capabilities 返回无效 JSON -> error 状态", async () => {
    const exec = createMockExec({ "cmux capabilities --json": "not valid json {{{" });
    const verifier = new RuntimeVerifier({ exec, db });

    const result = await verifier.verifyCmux();

    expect(result.status).toBe("error");
    expect(result.error).toContain("无效");
    expect(result.capabilitiesJson).toBeNull();
  });

  // T14：verifyAll 保留输入顺序 + 持久化规范名称
  it("verifyAll 保留输入顺序并持久化规范 runtime 名称", async () => {
    const exec = createMockExec({
      "codex --version": "codex 0.5.0",
      "claude --version": "claude 1.2.3",
      "tmux -V": "tmux 3.4",
    });
    const verifier = new RuntimeVerifier({ exec, db });

    const results = await verifier.verifyAll(["codex", "claude-code", "tmux"]);

    // 保留输入顺序
    expect(results).toHaveLength(3);
    expect(results[0]!.runtime).toBe("codex");
    expect(results[1]!.runtime).toBe("claude-code");
    expect(results[2]!.runtime).toBe("tmux");

    // 全部以规范名称持久化
    const rows = db.prepare("SELECT runtime FROM runtime_verifications ORDER BY runtime")
      .all() as Array<{ runtime: string }>;
    const names = rows.map((r) => r.runtime).sort();
    expect(names).toEqual(["claude-code", "codex", "tmux"]);
  });
});
