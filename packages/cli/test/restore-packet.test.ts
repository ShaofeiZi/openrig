// M2 恢复包纵向——Tier 1 测试。
//
// M2a 重点：schema-validator + restore-packet 命令外壳 + 互斥。
// M2b 新增：codex-jsonl-parser + claude-transcript-parser + runtime-detect +
//           redaction + omitted-records（含 Velocity 往返）。
// M2c 新增：packet-writer 原子发射 + daemon 路由集成。
//
// TDD 纪律（据 memory feedback_tdd_scope）：每个测试先写成失败，再写实现使其转绿。
// 提交状态即绿/通过状态。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";

// daemon-lifecycle 的模块级 mock，使 M2c-CLI mock-daemon 往返测试能驱动伪造的
// "daemon running" 状态，而不触碰宿主机真实 daemon。本文件其他测试不调用
// daemon-lifecycle（它们只跑纯 parser / packet-writer），故不受影响。
vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  validateRestoreSummary,
  RESTORE_SUMMARY_SCHEMA,
  type ValidationResult,
} from "../src/restore-packet/schema-validator.js";
import { restorePacketCommand } from "../src/commands/restore-packet.js";
import { redact, hasSecretPattern, SECRET_PATTERNS } from "../src/restore-packet/redaction.js";
import {
  classifyCodexRecord,
  classifyClaudeRecord,
  OmittedCounter,
} from "../src/restore-packet/omitted-records.js";
import { detectRuntime } from "../src/restore-packet/runtime-detect.js";
import { parseCodexJsonl } from "../src/restore-packet/codex-jsonl-parser.js";
import { parseClaudeTranscript } from "../src/restore-packet/claude-transcript-parser.js";

// 最小合法 summary 夹具，逐字对齐 M1 契约（§ 2.1）的必需字段集。
// 测试以该基线为基础，每次改一个字段来驱动接受/拒绝矩阵。
function validSummary(): Record<string, unknown> {
  return {
    source_session_id: "velocity-driver@openrig-velocity",
    source_rig: "openrig-velocity",
    source_runtime: "claude-code",
    source_cwd: "/Users/example/code/projects/openrig-hub",
    target_rig: "openrig-velocity",
    target_runtime: "claude-code",
    target_workspace_root: "/Users/example/code/projects/openrig-hub",
    default_target_repo: null,
    role_pointer: "rigs/openrig-velocity/state/velocity/driver-role.md",
    bounded_latest_transcript: {
      path: "transcript-latest.md",
      message_count: 87,
      bound: 120,
    },
    touched_files: {
      path: "touched-files.md",
      top_paths: [{ path: "packages/cli/src/commands/restore-packet.ts", count: 14 }],
    },
    durable_pointers: {
      queue_pointers: [],
      progress_pointers: [],
      field_note_pointers: [],
      artifact_pointers: [],
    },
    current_work_summary: "Working on M2a chunk of restore-packet vertical.",
    next_owner: "self",
    caveats: [],
    authority_boundaries: "Implement M2a only; do not touch M3+ surfaces.",
    omitted_classes: ["reasoning_records"],
    redaction_policy_id: "openrig-v0",
    source_trust_ranking: ["rig_whoami", "bounded_latest_transcript"],
    generator_version: "rig-restore-packet@0.1.0",
    generated_at: "2026-05-01T23:30:00Z",
  };
}

describe("M2 restore-packet schema-validator", () => {
  it("接受符合契约 § 2.1 的合法 summary", () => {
    const result: ValidationResult = validateRestoreSummary(validSummary());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("缺 source_session_id 时拒绝", () => {
    const summary = validSummary();
    delete (summary as Record<string, unknown>)["source_session_id"];
    const result = validateRestoreSummary(summary);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /source_session_id|required/.test(e.field) || /source_session_id|required/i.test(e.rule))).toBe(true);
  });

  it("source_runtime 不在枚举值内时拒绝", () => {
    const summary = validSummary();
    summary["source_runtime"] = "bash";
    const result = validateRestoreSummary(summary);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /source_runtime/.test(e.field))).toBe(true);
  });

  it("source_cwd 非绝对路径时拒绝", () => {
    const summary = validSummary();
    summary["source_cwd"] = "relative/path";
    const result = validateRestoreSummary(summary);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /source_cwd/.test(e.field))).toBe(true);
  });

  it("bounded_latest_transcript.bound 不为 120 时拒绝", () => {
    const summary = validSummary();
    (summary["bounded_latest_transcript"] as Record<string, unknown>)["bound"] = 100;
    const result = validateRestoreSummary(summary);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /bound/.test(e.field))).toBe(true);
  });

  it("durable_pointers 缺必需数组时拒绝", () => {
    const summary = validSummary();
    summary["durable_pointers"] = { queue_pointers: [] };
    const result = validateRestoreSummary(summary);
    expect(result.valid).toBe(false);
    // Missing progress_pointers / field_note_pointers / artifact_pointers
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("redaction_policy_id 非已知策略时拒绝", () => {
    const summary = validSummary();
    summary["redaction_policy_id"] = "custom-policy";
    const result = validateRestoreSummary(summary);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /redaction_policy_id/.test(e.field))).toBe(true);
  });

  it("source_trust_ranking 为空时拒绝", () => {
    const summary = validSummary();
    summary["source_trust_ranking"] = [];
    const result = validateRestoreSummary(summary);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /source_trust_ranking/.test(e.field))).toBe(true);
  });

  it("generated_at 非 ISO-8601 时拒绝", () => {
    const summary = validSummary();
    summary["generated_at"] = "yesterday";
    const result = validateRestoreSummary(summary);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /generated_at/.test(e.field))).toBe(true);
  });

  it("出现未知顶层字段时拒绝（additionalProperties: false）", () => {
    const summary = validSummary();
    (summary as Record<string, unknown>)["new_field"] = "leaked";
    const result = validateRestoreSummary(summary);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /new_field|additional/.test(e.field) || /additional/i.test(e.rule))).toBe(true);
  });

  it("接受带可选 full_transcript 的 summary", () => {
    const summary = validSummary();
    summary["full_transcript"] = { path: "transcript.md", line_count: 4321 };
    const result = validateRestoreSummary(summary);
    expect(result.valid).toBe(true);
  });

  // M2a R2 drift-catcher：canonical JSON Schema 文件
  // src/schemas/restore-summary.schema.json 与内嵌 TS 常量
  // RESTORE_SUMMARY_SCHEMA 必须保持字节等价。把 schema 内嵌进 validator 是
  // M2a R2 打包修复（tsc 把该 const  emit 进 dist/restore-packet/schema-validator.js，
  // 使 validator 在裸 `tsc` emit 后即可用，无需额外 build-script 拷贝步骤）。
  // JSON 文件仍是下游直接读 JSON Schema 的工具的 canonical 来源。任一方漂移时本测试响亮失败。
  it("M2a R2 drift-catcher：TS 常量 RESTORE_SUMMARY_SCHEMA 等于 canonical JSON schema 文件", () => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const schemaJsonPath = resolve(
      __dirname,
      "..",
      "src",
      "schemas",
      "restore-summary.schema.json",
    );
    const jsonForm: unknown = JSON.parse(readFileSync(schemaJsonPath, "utf-8"));
    expect(RESTORE_SUMMARY_SCHEMA).toEqual(jsonForm);
  });
});

describe("M2 restore-packet CLI command shell + mutual-exclusion", () => {
  function runRestorePacket(argv: string[]): { exitCode: number | undefined; stderr: string[]; stdout: string[] } {
    const stderr: string[] = [];
    const stdout: string[] = [];
    const origExitCode = process.exitCode;
    const origConsoleLog = console.log;
    const origConsoleError = console.error;
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => stdout.push(args.join(" "));
    console.error = (...args: unknown[]) => stderr.push(args.join(" "));
    try {
      const program = new Command();
      program.exitOverride();
      // 把 commander 的 writeErr（用于缺失必填选项消息）
      // 路由进我们的 stderr 捕获，便于测试断言匹配。
      program.configureOutput({ writeOut: (s) => stdout.push(s), writeErr: (s) => stderr.push(s) });
      const sub = restorePacketCommand();
      sub.exitOverride();
      sub.configureOutput({ writeOut: (s) => stdout.push(s), writeErr: (s) => stderr.push(s) });
      sub.commands.forEach((c) => {
        c.exitOverride();
        c.configureOutput({ writeOut: (s) => stdout.push(s), writeErr: (s) => stderr.push(s) });
      });
      program.addCommand(sub);
      try {
        program.parse(["node", "rig", ...argv]);
      } catch (err) {
        // commander 在 exitOverride + 非零退出时抛出。把抛出的 CommanderError 消息
        // 捕获进 stderr，便于调用方据此匹配（部分 commander 错误路径走 err.message，
        // 而非 configureOutput 的 writeErr）。
        if (err instanceof Error && err.message) {
          stderr.push(err.message);
        }
        if (process.exitCode === undefined || process.exitCode === 0) {
          process.exitCode = 2;
        }
      }
    } finally {
      console.log = origConsoleLog;
      console.error = origConsoleError;
    }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    return { exitCode, stderr, stdout };
  }

  it("注册 `restore-packet` 命令及其子命令 write / read / validate", () => {
    const cmd = restorePacketCommand();
    expect(cmd.name()).toBe("restore-packet");
    const subs = cmd.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(["read", "validate", "write"]);
  });

  it("同时传 --source-session 与 --source-jsonl 时 write 以显式错误失败", () => {
    const { exitCode, stderr } = runRestorePacket([
      "restore-packet", "write",
      "--source-session", "fake@kernel",
      "--source-jsonl", "/tmp/fake.jsonl",
      "--target", "/tmp/out",
    ]);
    expect(exitCode).not.toBe(0);
    const errStr = stderr.join("\n");
    expect(errStr).toMatch(/互斥|恰好提供一个/);
  });

  it("既不传 --source-session 也不传 --source-jsonl 时 write 以显式错误失败", () => {
    const { exitCode, stderr } = runRestorePacket([
      "restore-packet", "write",
      "--target", "/tmp/out",
    ]);
    expect(exitCode).not.toBe(0);
    const errStr = stderr.join("\n");
    expect(errStr).toMatch(/--source-session|--source-jsonl|exactly one/i);
  });

  it("缺 --target 时 write 失败（commander requiredOption 检查）", () => {
    const { exitCode, stderr } = runRestorePacket([
      "restore-packet", "write",
      "--source-jsonl", "/tmp/fake.jsonl",
    ]);
    expect(exitCode).not.toBe(0);
    const errStr = stderr.join("\n");
    expect(errStr).toMatch(/--target|required/i);
  });

  it("read 子命令作为 M2a stub 存在（完整实现于 M3）", () => {
    const cmd = restorePacketCommand();
    const readCmd = cmd.commands.find((c) => c.name() === "read");
    expect(readCmd).toBeDefined();
    expect(readCmd!.description()).toMatch(/渲染|恢复包/);
  });

  it("validate 子命令作为 M2a stub 存在（完整实现于 M3）", () => {
    const cmd = restorePacketCommand();
    const validateCmd = cmd.commands.find((c) => c.name() === "validate");
    expect(validateCmd).toBeDefined();
    expect(validateCmd!.description()).toMatch(/validate|schema/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
// M2b 子模块测试（codex-jsonl-parser、claude-transcript-parser、
// runtime-detect、redaction、omitted-records）。所有夹具均为合成数据；
// 不导入真实 transcript 内容。不含 auth token 或设备码（Quality Lesson v9）。
// ─────────────────────────────────────────────────────────────────────

describe("M2b redaction (openrig-v0 / velocity-v1 patterns)", () => {
  it("脱敏 sk-* token", () => {
    const text = "Some leaked sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ pattern here.";
    const redacted = redact(text);
    expect(redacted).not.toContain("sk-aBcDeFgHiJkLmNoPqRsTuVwXyZ");
    expect(redacted).toContain("[REDACTED]");
  });

  it("脱敏 ghp_/ghs_/gho_ GitHub token", () => {
    const text = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123 was leaked.";
    const redacted = redact(text);
    expect(redacted).not.toContain("ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123");
    expect(redacted).toContain("[REDACTED]");
  });

  it("脱敏 github_pat_ 细粒度 token", () => {
    const text = "Token: github_pat_AbCdEfGh01234567890123456789";
    const redacted = redact(text);
    expect(redacted).not.toContain("github_pat_AbCdEfGh01234567890123456789");
    expect(redacted).toContain("[REDACTED]");
  });

  it("脱敏 Bearer token", () => {
    const text = "Authorization: Bearer aBcD1234.eFgH5678.iJkL9012-mNoP";
    const redacted = redact(text);
    expect(redacted).not.toContain("Bearer aBcD1234.eFgH5678.iJkL9012-mNoP");
    expect(redacted).toContain("[REDACTED]");
  });

  it("脱敏长 base64 形状字符串", () => {
    const text = "Encoded: aGVsbG93b3JsZGFlaW91YWVpb3VhZWlvdWFlaW91YWVpb3U=";
    const redacted = redact(text);
    expect(redacted).toContain("[REDACTED]");
  });

  it("逐字节保持非凭据内容不变", () => {
    const text = "Normal message: visit https://example.com for docs.";
    const redacted = redact(text);
    expect(redacted).toBe(text);
  });

  it("hasSecretPattern 检测每一类已知凭据", () => {
    expect(hasSecretPattern("sk-AbCdEfGhIjKlMnOpQ")).toBe(true);
    expect(hasSecretPattern("normal text without secrets")).toBe(false);
    expect(hasSecretPattern("")).toBe(false);
  });

  it("暴露 pattern 列表（据 Velocity 先例 5 个 pattern）", () => {
    expect(SECRET_PATTERNS.length).toBe(5);
  });
});

describe("M2b omitted-records classifier", () => {
  it("把 Codex function_call 归类为 function_call_output", () => {
    const result = classifyCodexRecord({ payload: { type: "function_call" } });
    expect(result.kind).toBe("omitted");
    if (result.kind === "omitted") {
      expect(result.reason).toBe("function_call_output");
    }
  });

  it("把 Codex custom_tool_call 归类为 raw_tool_outputs", () => {
    const result = classifyCodexRecord({ payload: { type: "custom_tool_call" } });
    expect(result.kind).toBe("omitted");
    if (result.kind === "omitted") {
      expect(result.reason).toBe("raw_tool_outputs");
    }
  });

  it("把 Codex reasoning 归类为 reasoning_records", () => {
    const result = classifyCodexRecord({ payload: { type: "reasoning" } });
    expect(result.kind).toBe("omitted");
    if (result.kind === "omitted") {
      expect(result.reason).toBe("reasoning_records");
    }
  });

  it("把 Codex message+user-role 归类为 kept", () => {
    const result = classifyCodexRecord({ payload: { type: "message", role: "user" } });
    expect(result.kind).toBe("kept");
  });

  it("把 Codex message+unknown-role 归类为 omitted（reasoning）", () => {
    const result = classifyCodexRecord({ payload: { type: "message", role: "system" } });
    expect(result.kind).toBe("omitted");
  });

  it("把 Claude attachment 归类为 raw_tool_outputs", () => {
    const result = classifyClaudeRecord({ type: "attachment" });
    expect(result.kind).toBe("omitted");
    if (result.kind === "omitted") {
      expect(result.reason).toBe("raw_tool_outputs");
    }
  });

  it("把 Claude user|assistant 归类为 kept", () => {
    expect(classifyClaudeRecord({ type: "user" }).kind).toBe("kept");
    expect(classifyClaudeRecord({ type: "assistant" }).kind).toBe("kept");
  });

  it("把 Claude summary 归类为 reasoning_records", () => {
    const result = classifyClaudeRecord({ type: "summary" });
    expect(result.kind).toBe("omitted");
    if (result.kind === "omitted") {
      expect(result.reason).toBe("reasoning_records");
    }
  });

  it("OmittedCounter 按类累计计数并给出 active-classes 列表", () => {
    const counter = new OmittedCounter();
    counter.recordOmission("reasoning_records");
    counter.recordOmission("reasoning_records");
    counter.recordOmission("function_call_output");
    counter.recordRedaction();

    expect(counter.counts.reasoning_records).toBe(2);
    expect(counter.counts.function_call_output).toBe(1);
    expect(counter.counts.redacted_secrets).toBe(1);
    expect(counter.counts.raw_tool_outputs).toBe(0);

    expect(counter.activeClasses()).toEqual([
      "reasoning_records",
      "function_call_output",
      "redacted_secrets",
    ]);
  });
});

describe("M2b runtime-detect", () => {
  it("经 response_item 类型标记检测 Codex JSONL", () => {
    const content = `{"type":"session_meta","payload":{"cwd":"/x"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":"hi"}}`;
    expect(detectRuntime(content)).toBe("codex");
  });

  it("仅凭 session_meta 检测 Codex", () => {
    const content = `{"type":"session_meta","payload":{"cwd":"/x"}}`;
    expect(detectRuntime(content)).toBe("codex");
  });

  it("经顶层 user/assistant 类型检测 Claude", () => {
    const content = `{"type":"customTitle","customTitle":"x","sessionId":"s"}
{"type":"user","message":{"role":"user","content":"hi"},"sessionId":"s"}`;
    expect(detectRuntime(content)).toBe("claude-code");
  });

  it("空输入返回 null", () => {
    expect(detectRuntime("")).toBe(null);
  });

  it("非 JSONL 垃圾输入返回 null", () => {
    expect(detectRuntime("hello world\nfoo bar")).toBe(null);
  });

  it("无运行时标记的 JSONL（歧义）返回 null", () => {
    const content = `{"foo":"bar"}
{"baz":"qux"}`;
    expect(detectRuntime(content)).toBe(null);
  });

  it("不使用文件扩展名或文件名——纯内容形状判断", () => {
    // 传入看似文件名的字符串仍应返回 null。
    expect(detectRuntime("/tmp/fake.jsonl")).toBe(null);
    expect(detectRuntime("rollout-2026-04-23.jsonl")).toBe(null);
  });
});

describe("M2b codex-jsonl-parser", () => {
  it("把 session_meta + response_item 消息解析进 StructuredTranscript", () => {
    const content = `{"type":"session_meta","payload":{"cwd":"/Users/example/code/projects/openrig-hub","id":"abc-123"}}
{"type":"response_item","timestamp":"2026-05-02T01:00:00Z","payload":{"type":"message","role":"user","content":"Hello world"}}
{"type":"response_item","timestamp":"2026-05-02T01:00:01Z","payload":{"type":"message","role":"assistant","content":[{"type":"text","text":"Hi back"}]}}`;
    const result = parseCodexJsonl(content);
    expect(result.sessionMeta?.cwd).toBe("/Users/example/code/projects/openrig-hub");
    expect(result.sessionMeta?.sessionId).toBe("abc-123");
    expect(result.messageCount).toBe(2);
    expect(result.messages[0]!.role).toBe("user");
    expect(result.messages[0]!.text).toBe("Hello world");
    expect(result.messages[1]!.role).toBe("assistant");
    expect(result.messages[1]!.text).toBe("Hi back");
    expect(result.lineCount).toBe(3);
  });

  it("过滤 reasoning + function_call + custom_tool_call 记录并计数", () => {
    const content = `{"type":"response_item","payload":{"type":"reasoning","content":"<thinking>"}}
{"type":"response_item","payload":{"type":"function_call","arguments":"{\\"path\\":\\"/Users/example/x.txt\\"}"}}
{"type":"response_item","payload":{"type":"custom_tool_call","input":"some input"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":"kept"}}`;
    const result = parseCodexJsonl(content);
    expect(result.messageCount).toBe(1);
    expect(result.omittedCounts.reasoning_records).toBeGreaterThanOrEqual(1);
    expect(result.omittedCounts.function_call_output).toBe(1);
    expect(result.omittedCounts.raw_tool_outputs).toBe(1);
  });

  it("单独计数 compacted 记录，并把它们从 messages 跳过", () => {
    const content = `{"type":"compacted","payload":{}}
{"type":"compacted","payload":{}}
{"type":"response_item","payload":{"type":"message","role":"user","content":"msg"}}`;
    const result = parseCodexJsonl(content);
    expect(result.compactedCount).toBe(2);
    expect(result.messageCount).toBe(1);
  });

  it("脱敏消息内容中的凭据 pattern", () => {
    const content = `{"type":"response_item","payload":{"type":"message","role":"user","content":"my token is sk-AbCdEfGhIjKlMnOpQrStUv now"}}`;
    const result = parseCodexJsonl(content);
    expect(result.messages[0]!.text).toContain("[REDACTED]");
    expect(result.messages[0]!.text).not.toContain("sk-AbCdEfGhIjKlMnOpQrStUv");
    expect(result.omittedCounts.redacted_secrets).toBe(1);
  });

  it("静默跳过畸形 JSONL 行（据 Velocity 先例）", () => {
    const content = `{"type":"response_item","payload":{"type":"message","role":"user","content":"first"}}
not valid json garbage line
{"type":"response_item","payload":{"type":"message","role":"user","content":"second"}}`;
    const result = parseCodexJsonl(content);
    expect(result.messageCount).toBe(2);
    expect(result.lineCount).toBe(3);
  });

  it("从消息内容与 tool 参数提取路径；按频率排序", () => {
    const content = `{"type":"response_item","payload":{"type":"message","role":"user","content":"see packages/cli/src/index.ts and packages/cli/src/index.ts again"}}
{"type":"response_item","payload":{"type":"function_call","arguments":"{\\"path\\":\\"/Users/example/code/projects/openrig-hub/README.md\\"}"}}`;
    const result = parseCodexJsonl(content);
    expect(result.paths.length).toBeGreaterThan(0);
    const indexEntry = result.paths.find((p) => p.path === "packages/cli/src/index.ts");
    expect(indexEntry?.count).toBeGreaterThanOrEqual(2);
  });
});

describe("M2b claude-transcript-parser", () => {
  it("把 Claude user + assistant 消息解析进 StructuredTranscript", () => {
    const content = `{"type":"customTitle","customTitle":"M2b test","sessionId":"sess-1"}
{"type":"user","message":{"role":"user","content":"hello"},"cwd":"/x","sessionId":"sess-1","timestamp":"2026-05-02T01:00:00Z"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi back"}]},"cwd":"/x","sessionId":"sess-1","timestamp":"2026-05-02T01:00:01Z"}`;
    const result = parseClaudeTranscript(content);
    expect(result.messageCount).toBe(2);
    expect(result.messages[0]!.role).toBe("user");
    expect(result.messages[0]!.text).toBe("hello");
    expect(result.messages[1]!.role).toBe("assistant");
    expect(result.messages[1]!.text).toBe("hi back");
  });

  it("从首个携带 cwd + sessionId 的记录捕获 sessionMeta", () => {
    const content = `{"type":"customTitle","customTitle":"x","sessionId":"sess-2"}
{"type":"user","message":{"role":"user","content":"first"},"cwd":"/Users/example/code","sessionId":"sess-2"}`;
    const result = parseClaudeTranscript(content);
    expect(result.sessionMeta?.cwd).toBe("/Users/example/code");
    expect(result.sessionMeta?.sessionId).toBe("sess-2");
  });

  it("把 attachments 归入 raw_tool_outputs 计数", () => {
    const content = `{"type":"user","message":{"role":"user","content":"see attached"},"cwd":"/x","sessionId":"s"}
{"type":"attachment","attachment":{"path":"/Users/example/x.txt","content":"file body"},"cwd":"/x","sessionId":"s"}`;
    const result = parseClaudeTranscript(content);
    expect(result.messageCount).toBe(1);
    expect(result.omittedCounts.raw_tool_outputs).toBe(1);
  });

  it("脱敏消息内容中的凭据 pattern", () => {
    const content = `{"type":"user","message":{"role":"user","content":"my token is ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0 now"},"cwd":"/x","sessionId":"s"}`;
    const result = parseClaudeTranscript(content);
    expect(result.messages[0]!.text).toContain("[REDACTED]");
    expect(result.omittedCounts.redacted_secrets).toBe(1);
  });

  it("compactedCount 恒为 0（Claude transcript 不发出 compaction 记录）", () => {
    const content = `{"type":"user","message":{"role":"user","content":"x"},"cwd":"/x","sessionId":"s"}`;
    const result = parseClaudeTranscript(content);
    expect(result.compactedCount).toBe(0);
  });

  it("产出与 Codex parser 相同的 StructuredTranscript 形状（接口一致性）", () => {
    const codex = parseCodexJsonl(`{"type":"response_item","payload":{"type":"message","role":"user","content":"x"}}`);
    const claude = parseClaudeTranscript(`{"type":"user","message":{"role":"user","content":"x"},"cwd":"/x","sessionId":"s"}`);
    // 逐字段检查两者暴露相同的顶层键。
    const codexKeys = Object.keys(codex).sort();
    const claudeKeys = Object.keys(claude).sort();
    expect(codexKeys).toEqual(claudeKeys);
    // 两者都必须暴露 omittedCounts，含全部 4 个枚举键。
    expect(Object.keys(codex.omittedCounts).sort()).toEqual([
      "function_call_output",
      "raw_tool_outputs",
      "reasoning_records",
      "redacted_secrets",
    ]);
    expect(Object.keys(claude.omittedCounts).sort()).toEqual([
      "function_call_output",
      "raw_tool_outputs",
      "reasoning_records",
      "redacted_secrets",
    ]);
  });
});

describe("M2b interaction: parse → redact → omitted-records counter chain", () => {
  it("一次解析中同时计数 redacted_secrets 并过滤全部 3 类 codex omitted", () => {
    const content = `{"type":"session_meta","payload":{"cwd":"/x"}}
{"type":"response_item","payload":{"type":"reasoning"}}
{"type":"response_item","payload":{"type":"function_call","arguments":"{}"}}
{"type":"response_item","payload":{"type":"custom_tool_call","input":"{}"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":"my token sk-AbCdEfGhIjKlMnOpQrSt and more text"}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":"clean reply"}}`;
    const result = parseCodexJsonl(content);
    expect(result.messageCount).toBe(2);
    expect(result.omittedCounts.reasoning_records).toBeGreaterThanOrEqual(1);
    expect(result.omittedCounts.function_call_output).toBe(1);
    expect(result.omittedCounts.raw_tool_outputs).toBe(1);
    expect(result.omittedCounts.redacted_secrets).toBe(1);
    // user 消息被脱敏但保留。
    expect(result.messages[0]!.text).toContain("[REDACTED]");
    // assistant 消息保持不变。
    expect(result.messages[1]!.text).toBe("clean reply");
  });
});

// ─────────────────────────────────────────────────────────────────────
// M2b R2：Claude parser 嵌套 tool_use / tool_result 处理。
//
// 据 guard 的 M2b BLOCK：parser 此前静默丢弃了 tool_use part（在 assistant content 内）
// 与 tool_result part（在 user content 内），而未把它们计入 omitted 类。真实 Claude
// transcript 几乎每轮都有这些；上一个 M2b 提交产出的 omittedCounts 全为零，有误导性。
//
// R2 修复：在保留的 user/assistant 记录内遍历 message.content parts；把 tool_use 计入
// function_call_output、tool_result 计入 raw_tool_outputs；从 omitted parts 提取路径
//（对齐 Codex parser 在 codex-jsonl-parser.ts 的行为：function_call args 与
// custom_tool_call input 也会被遍历提取路径，尽管记录本身从消息流中省略）。
// ─────────────────────────────────────────────────────────────────────

describe("M2b R2 Claude parser nested-content-part handling", () => {
  it("护栏复现夹具：tool_use + tool_result 均被计数；提取路径", () => {
    const content = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { cmd: "pwd" } },
          { type: "text", text: "done" },
        ],
      },
      cwd: "/x",
      sessionId: "s",
    }) + "\n" + JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "/Users/example/code/projects/openrig-hub",
          },
        ],
      },
      cwd: "/x",
      sessionId: "s",
    });
    const r = parseClaudeTranscript(content);
    // 两个顶层记录都被保留（parser 仍发出 assistant turn 的可见文本 "done"；
    // user turn 只有 tool_result content，无可见文本——但记录被归类为 kept；
    // 无可见文本时它会从 messages 丢弃，但嵌套的 tool_result 仍必须被计数）。
    expect(r.omittedCounts.function_call_output).toBe(1);
    expect(r.omittedCounts.raw_tool_outputs).toBe(1);
    expect(r.paths.some((p) => p.path === "/Users/example/code/projects/openrig-hub")).toBe(true);
  });

  it("多 tool 的 assistant turn 中每个 tool_use part 都被计数", () => {
    const content = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "ls" } },
          { type: "tool_use", id: "t2", name: "Read", input: { path: "/Users/example/code/x.md" } },
          { type: "text", text: "running both" },
        ],
      },
      cwd: "/x",
      sessionId: "s",
    });
    const r = parseClaudeTranscript(content);
    expect(r.omittedCounts.function_call_output).toBe(2);
    expect(r.paths.some((p) => p.path === "/Users/example/code/x.md")).toBe(true);
  });

  it("多结果的 user turn 中每个 tool_result part 都被计数", () => {
    // 注意：Velocity 先例的路径 pattern 对 /Users/example 前缀是贪婪的，
    // 会吞到行尾的尾随空白与单词字符；这里用 \n 分隔，使每个路径干净匹配。
    const content = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "/Users/example/code/a.md\nrunning" },
          { type: "tool_result", tool_use_id: "t2", content: "/Users/example/code/b.md\nrunning" },
        ],
      },
      cwd: "/x",
      sessionId: "s",
    });
    const r = parseClaudeTranscript(content);
    expect(r.omittedCounts.raw_tool_outputs).toBe(2);
    expect(r.paths.some((p) => p.path === "/Users/example/code/a.md")).toBe(true);
    expect(r.paths.some((p) => p.path === "/Users/example/code/b.md")).toBe(true);
  });

  it("混合 text + tool_use：可见文本保留；tool_use 被计数", () => {
    const content = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I'll run a command:" },
          { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "pwd" } },
          { type: "text", text: "and report back" },
        ],
      },
      cwd: "/x",
      sessionId: "s",
    });
    const r = parseClaudeTranscript(content);
    expect(r.messageCount).toBe(1);
    expect(r.messages[0]!.text).toContain("I'll run a command:");
    expect(r.messages[0]!.text).toContain("and report back");
    expect(r.omittedCounts.function_call_output).toBe(1);
  });

  it("非路径输入的 tool_use：被计数但不贡献路径", () => {
    const content = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { cmd: "echo hello" } },
          { type: "text", text: "done" },
        ],
      },
      cwd: "/x",
      sessionId: "s",
    });
    const r = parseClaudeTranscript(content);
    expect(r.omittedCounts.function_call_output).toBe(1);
    // 输入中无 /Users/example 或可识别前缀路径。
    expect(r.paths.length).toBe(0);
  });

  it("非路径内容的 tool_result：被计数但不贡献路径", () => {
    const content = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "command exited with status 0" },
        ],
      },
      cwd: "/x",
      sessionId: "s",
    });
    const r = parseClaudeTranscript(content);
    expect(r.omittedCounts.raw_tool_outputs).toBe(1);
    expect(r.paths.length).toBe(0);
  });

  it("数组形状内容的 tool_result：遍历数组提取路径", () => {
    // Claude tool_result content 可以是字符串，也可以是
    // { type: "text", text } part 数组（与 message content 同形）。
    const content = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [
              { type: "text", text: "found at /Users/example/code/projects/openrig-hub/README.md" },
            ],
          },
        ],
      },
      cwd: "/x",
      sessionId: "s",
    });
    const r = parseClaudeTranscript(content);
    expect(r.omittedCounts.raw_tool_outputs).toBe(1);
    expect(r.paths.some((p) => p.path === "/Users/example/code/projects/openrig-hub/README.md")).toBe(true);
  });

  it("纯文本 assistant turn（无工具）：计数保持为零", () => {
    const content = JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      cwd: "/x",
      sessionId: "s",
    });
    const r = parseClaudeTranscript(content);
    expect(r.messageCount).toBe(1);
    expect(r.omittedCounts.function_call_output).toBe(0);
    expect(r.omittedCounts.raw_tool_outputs).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// M2c-CLI：packet-writer 原子化产出 + 往返测试。
//
// packet-writer.ts 以原子方式组装 v0 restore packet 目录：先写到 tempdir，
// 再据内嵌 JSON Schema 校验产出的 restore-summary.json，然后把 tempdir 重命名为 target。
// 任一步校验失败即删除 tempdir；operator 文件系统中不留残缺 packet。
//
// 据 M1 契约 § 1：目录含 4 个必需文件
//（restore-instructions.md、transcript-latest.md、touched-files.md、
// restore-summary.json）加可选的 transcript.md。
// ─────────────────────────────────────────────────────────────────────

describe("M2c-CLI packet-writer atomic emission", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "restore-packet-test-"));
  });

  afterEach(async () => {
    const fs = await import("node:fs");
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function buildBaselineOpts(targetDir: string): Record<string, unknown> {
    return {
      targetDir,
      structured: parseCodexJsonl(`{"type":"session_meta","payload":{"cwd":"/Users/example/code/projects/openrig-hub","id":"src-session-id"}}
{"type":"response_item","timestamp":"2026-05-02T01:00:00Z","payload":{"type":"message","role":"user","content":"Walk through the M1 contract"}}
{"type":"response_item","timestamp":"2026-05-02T01:00:01Z","payload":{"type":"message","role":"assistant","content":[{"type":"text","text":"Per § 2.1 the schema requires 21 fields"}]}}`),
      sourceRuntime: "codex" as const,
      targetRig: "openrig-velocity-claude",
      targetRuntime: "claude-code" as const,
      targetWorkspaceRoot: "/Users/example/code/projects/openrig-hub",
      defaultTargetRepo: "/Users/example/code/projects/openrig-hub/openrig",
      rolePointer: "rigs/openrig-velocity-claude/state/velocity/driver-role.md",
      currentWorkSummary: "Working on Restore-Packet vertical M2c-CLI chunk.",
      nextOwner: "self",
      caveats: ["Cross-runtime restore from Codex JSONL to Claude Code seat."],
      authorityBoundaries: "May edit packages/cli/ and packages/daemon/ within M2c boundary; no M3+ surfaces.",
      sourceTrustRanking: ["rig_whoami", "bounded_latest_transcript"],
      sourceSessionId: "velocity-driver@openrig-velocity",
      sourceRig: "openrig-velocity",
      sourceCwd: "/Users/example/code/projects/openrig-hub",
      generatorVersion: "rig-restore-packet@0.1.0",
      includeFullTranscript: false,
    };
  }

  it("产出 4 个必需文件 + restore-summary.json 符合 schema", async () => {
    const { writePacket } = await import("../src/restore-packet/packet-writer.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const targetDir = path.join(tmpRoot, "packet-1");
    const result = await writePacket(buildBaselineOpts(targetDir) as Parameters<typeof writePacket>[0]);

    expect(result.targetDir).toBe(targetDir);
    for (const required of ["restore-instructions.md", "transcript-latest.md", "touched-files.md", "restore-summary.json"]) {
      expect(fs.existsSync(path.join(targetDir, required)), `missing ${required}`).toBe(true);
    }
    // includeFullTranscript=false 时不应出现可选的 transcript.md。
    expect(fs.existsSync(path.join(targetDir, "transcript.md"))).toBe(false);

    // Summary 可解析并通过 schema 校验。
    const summary = JSON.parse(fs.readFileSync(path.join(targetDir, "restore-summary.json"), "utf-8"));
    const validation = validateRestoreSummary(summary);
    expect(validation.valid, JSON.stringify(validation.errors)).toBe(true);
  });

  it("includeFullTranscript=true 时产出 transcript.md；summary 中含 full_transcript 键", async () => {
    const { writePacket } = await import("../src/restore-packet/packet-writer.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const targetDir = path.join(tmpRoot, "packet-full");
    const opts = buildBaselineOpts(targetDir);
    (opts as Record<string, unknown>)["includeFullTranscript"] = true;
    await writePacket(opts as Parameters<typeof writePacket>[0]);

    expect(fs.existsSync(path.join(targetDir, "transcript.md"))).toBe(true);
    const summary = JSON.parse(fs.readFileSync(path.join(targetDir, "restore-summary.json"), "utf-8"));
    expect(summary.full_transcript).toBeDefined();
    expect(typeof summary.full_transcript.path).toBe("string");
    expect(typeof summary.full_transcript.line_count).toBe("number");
  });

  it("按 operator 提供的选项逐字填充契约 § 2.1 必需字段", async () => {
    const { writePacket } = await import("../src/restore-packet/packet-writer.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const targetDir = path.join(tmpRoot, "packet-fields");
    await writePacket(buildBaselineOpts(targetDir) as Parameters<typeof writePacket>[0]);

    const summary = JSON.parse(fs.readFileSync(path.join(targetDir, "restore-summary.json"), "utf-8"));
    expect(summary.target_rig).toBe("openrig-velocity-claude");
    expect(summary.target_runtime).toBe("claude-code");
    expect(summary.role_pointer).toBe("rigs/openrig-velocity-claude/state/velocity/driver-role.md");
    expect(summary.bounded_latest_transcript.bound).toBe(120);
    expect(summary.redaction_policy_id).toBe("openrig-v0");
    expect(summary.generator_version).toBe("rig-restore-packet@0.1.0");
    expect(summary.source_runtime).toBe("codex");
    expect(summary.source_session_id).toBe("velocity-driver@openrig-velocity");
    expect(Array.isArray(summary.touched_files.top_paths)).toBe(true);
    expect(summary.durable_pointers.queue_pointers).toBeDefined();
    expect(summary.durable_pointers.progress_pointers).toBeDefined();
    expect(summary.durable_pointers.field_note_pointers).toBeDefined();
    expect(summary.durable_pointers.artifact_pointers).toBeDefined();
  });

  it("target 目录已存在时拒绝", async () => {
    const { writePacket } = await import("../src/restore-packet/packet-writer.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const targetDir = path.join(tmpRoot, "preexisting");
    fs.mkdirSync(targetDir);
    fs.writeFileSync(path.join(targetDir, "marker.txt"), "do not overwrite");

    const opts = buildBaselineOpts(targetDir) as Parameters<typeof writePacket>[0];
    await expect(writePacket(opts)).rejects.toThrow(/已存在/);
    // Marker 保留（无部分覆盖）。
    expect(fs.readFileSync(path.join(targetDir, "marker.txt"), "utf-8")).toBe("do not overwrite");
  });

  it("原子化产出：写入中途 schema 校验失败时不留 target 目录并清理 tempdir", async () => {
    const { writePacket } = await import("../src/restore-packet/packet-writer.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const targetDir = path.join(tmpRoot, "packet-fail");
    const opts = buildBaselineOpts(targetDir) as Record<string, unknown>;
    // 注入一个契约违反：空 current_work_summary 应使
    // schema 校验失败（minLength: 1）。
    opts["currentWorkSummary"] = "";

    await expect(
      writePacket(opts as Parameters<typeof writePacket>[0]),
    ).rejects.toThrow(/schema|valid|current_work_summary/i);

    // target 目录从未被创建（原子重命名语义）。
    expect(fs.existsSync(targetDir)).toBe(false);
    // tmpRoot 中无残留 .tmp- 前缀目录。
    const tmpRootContents = fs.readdirSync(tmpRoot);
    const leftovers = tmpRootContents.filter((name) => name.includes(".tmp-restore-packet-"));
    expect(leftovers).toEqual([]);
  });

  it("transcript-latest.md 按 120 条消息截断；message_count 反映真实条数", async () => {
    const { writePacket } = await import("../src/restore-packet/packet-writer.js");
    const fs = await import("node:fs");
    const path = await import("node:path");

    // 构造 150 条 user 消息（超过 120 上限）。
    const lines: string[] = [`{"type":"session_meta","payload":{"cwd":"/x"}}`];
    for (let i = 0; i < 150; i++) {
      lines.push(`{"type":"response_item","payload":{"type":"message","role":"user","content":"msg ${i}"}}`);
    }
    const opts = buildBaselineOpts(path.join(tmpRoot, "packet-bound")) as Record<string, unknown>;
    opts["structured"] = parseCodexJsonl(lines.join("\n"));
    await writePacket(opts as Parameters<typeof writePacket>[0]);

    const summary = JSON.parse(fs.readFileSync(path.join(tmpRoot, "packet-bound", "restore-summary.json"), "utf-8"));
    expect(summary.bounded_latest_transcript.bound).toBe(120);
    expect(summary.bounded_latest_transcript.message_count).toBe(120);

    // Latest transcript file contains exactly 120 sectioned messages.
    const latest = fs.readFileSync(path.join(tmpRoot, "packet-bound", "transcript-latest.md"), "utf-8");
    const sectionCount = (latest.match(/^## \d+\. /gm) ?? []).length;
    expect(sectionCount).toBe(120);
  });
});

describe("M2c-CLI Velocity-shape round-trip (synthetic 4-role fixtures)", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "restore-packet-rt-"));
  });

  afterEach(async () => {
    const fs = await import("node:fs");
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // 构造一个合成 Codex JSONL，结构同 Velocity 既有实践：
  // session_meta + response_item 消息 + tool_calls + reasoning 记录，
  // 外加一个供 redaction 用的凭证模式探针。
  function syntheticCodexJsonlFor(role: string): string {
    return [
      `{"type":"session_meta","payload":{"cwd":"/Users/example/code/projects/openrig-hub","id":"velocity-${role}@openrig-velocity-code"}}`,
      `{"type":"response_item","payload":{"type":"reasoning","content":"<thinking>"}}`,
      `{"type":"response_item","payload":{"type":"function_call","arguments":"{\\"path\\":\\"packages/cli/src/index.ts\\"}"}}`,
      `{"type":"response_item","timestamp":"2026-04-23T18:08:00Z","payload":{"type":"message","role":"user","content":"${role}: please review the diff"}}`,
      `{"type":"response_item","timestamp":"2026-04-23T18:08:30Z","payload":{"type":"message","role":"assistant","content":[{"type":"text","text":"${role}: token sk-FakeAbCdEfGhIjKlMn was visible in logs"}]}}`,
      `{"type":"compacted","payload":{}}`,
    ].join("\n");
  }

  for (const role of ["driver", "guard", "planner", "tester"]) {
    it(`Velocity-shape ${role} round-trip: parser → packet-writer → schema-valid; counts + redaction preserved`, async () => {
      const { writePacket } = await import("../src/restore-packet/packet-writer.js");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const structured = parseCodexJsonl(syntheticCodexJsonlFor(role));

      // writer 往返前先做 parser 输出的健全性检查。
      expect(structured.messageCount).toBe(2);
      expect(structured.compactedCount).toBe(1);
      expect(structured.omittedCounts.reasoning_records).toBeGreaterThanOrEqual(1);
      expect(structured.omittedCounts.function_call_output).toBe(1);
      expect(structured.omittedCounts.redacted_secrets).toBe(1);

      const targetDir = path.join(tmpRoot, `packet-${role}`);
      await writePacket({
        targetDir,
        structured,
        sourceRuntime: "codex",
        targetRig: "openrig-velocity-claude",
        targetRuntime: "claude-code",
        targetWorkspaceRoot: "/Users/example/code/projects/openrig-hub",
        defaultTargetRepo: "/Users/example/code/projects/openrig-hub/openrig",
        rolePointer: `rigs/openrig-velocity-claude/state/velocity/${role}-role.md`,
        currentWorkSummary: `Synthetic ${role} round-trip for Velocity-shape parity.`,
        nextOwner: "self",
        caveats: [],
        authorityBoundaries: `${role} authority for Velocity-replay context.`,
        sourceTrustRanking: ["rig_whoami", "bounded_latest_transcript"],
        sourceSessionId: `velocity-${role}@openrig-velocity-code`,
        sourceRig: "openrig-velocity-code",
        sourceCwd: "/Users/example/code/projects/openrig-hub",
        generatorVersion: "rig-restore-packet@0.1.0",
        includeFullTranscript: true,
      });

      const summary = JSON.parse(fs.readFileSync(path.join(targetDir, "restore-summary.json"), "utf-8"));
      const validation = validateRestoreSummary(summary);
      expect(validation.valid, JSON.stringify(validation.errors)).toBe(true);
      // 来源信息在相关字段保留：
      expect(summary.source_session_id).toBe(`velocity-${role}@openrig-velocity-code`);
      expect(summary.source_cwd).toBe("/Users/example/code/projects/openrig-hub");
      expect(summary.bounded_latest_transcript.message_count).toBe(2);
      // omitted 类枚举与 parser 计数一致：
      expect(summary.omitted_classes).toContain("reasoning_records");
      expect(summary.omitted_classes).toContain("function_call_output");
      expect(summary.omitted_classes).toContain("redacted_secrets");
      // 脱敏输出：assistant 的 "sk-FakeAbCdEfGhIjKlMn" 不得出现在 transcript.md 中。
      const fullT = fs.readFileSync(path.join(targetDir, "transcript.md"), "utf-8");
      expect(fullT).not.toContain("sk-FakeAbCdEfGhIjKlMn");
      expect(fullT).toContain("[REDACTED]");
    });
  }
});

describe("M2c-CLI redaction + omitted-record round-trip end-to-end", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "restore-packet-er-"));
  });

  afterEach(async () => {
    const fs = await import("node:fs");
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("mock-daemon --source-session 往返写入 packet 且不转发任何 mutation", async () => {
    const { restorePacketCommand } = await import("../src/commands/restore-packet.js");
    const { createProgram } = await import("../src/index.js");
    const fs = await import("node:fs");
    const path = await import("node:path");

    const requestedPaths: string[] = [];
    const mutationMethods = {
      post: vi.fn(async () => { throw new Error("mock-daemon: post should not be called by restore-packet write"); }),
      delete: vi.fn(async () => { throw new Error("mock-daemon: delete should not be called by restore-packet write"); }),
      postText: vi.fn(async () => { throw new Error("mock-daemon: postText should not be called"); }),
      postExpectText: vi.fn(async () => { throw new Error("mock-daemon: postExpectText should not be called"); }),
    };
    // mock-daemon 在新 full-read 路由上提供的合成 Codex JSONL。
    const fixtureContent = `{"type":"session_meta","payload":{"cwd":"/Users/example/code/x","id":"src-session"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":"hello from session"}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"text","text":"reply"}]}}`;

    const deps = {
      lifecycleDeps: {} as Parameters<typeof restorePacketCommand>[0] extends undefined ? never : NonNullable<Parameters<typeof restorePacketCommand>[0]>["lifecycleDeps"],
      clientFactory: () => ({
        get: vi.fn(async (p: string) => {
          requestedPaths.push(p);
          if (p === "/api/transcripts/src-session/full") {
            return { status: 200, data: { content: fixtureContent, cwd: "/Users/example/code/x" } };
          }
          return { status: 404, data: { error: "not found" } };
        }),
        getText: vi.fn(async () => ({ status: 200, data: "" })),
        ...mutationMethods,
      }),
    };

    const targetDir = path.join(tmpRoot, "via-daemon");
    const program = createProgram({ restorePacketDeps: deps as unknown as Parameters<typeof createProgram>[0]["restorePacketDeps"] });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "restore-packet", "write",
      "--source-session", "src-session",
      "--target", targetDir,
      "--target-rig", "openrig-velocity-claude",
      "--target-runtime", "claude-code",
      // src-session 是裸的（无 @）；操作者必须按 R2 诚实回退策略
      // 提供 --source-rig-override。
      "--source-rig-override", "openrig-test",
      "--current-work-summary", "mock-daemon round-trip with bare session id + rig override.",
      "--authority-boundaries", "test-only.",
    ]);

    // daemon 经新的 full-read 路由被查询；未调用任何 mutation 方法。
    expect(requestedPaths).toContain("/api/transcripts/src-session/full");
    expect(mutationMethods.post).not.toHaveBeenCalled();
    expect(mutationMethods.delete).not.toHaveBeenCalled();
    // Packet emitted.
    expect(fs.existsSync(targetDir)).toBe(true);
    const summary = JSON.parse(fs.readFileSync(path.join(targetDir, "restore-summary.json"), "utf-8"));
    const validation = validateRestoreSummary(summary);
    expect(validation.valid, JSON.stringify(validation.errors)).toBe(true);
    expect(summary.source_session_id).toBe("src-session");
    // R2：操作者提供的 --source-rig-override 被采纳。
    expect(summary.source_rig).toBe("openrig-test");
  });

  it("M2b R2 嵌套 Claude 内容夹具：往返且 summary 中 omittedCounts 非零", async () => {
    const { writePacket } = await import("../src/restore-packet/packet-writer.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const content = JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { cmd: "pwd" } },
          { type: "text", text: "checking now" },
        ],
      },
      cwd: "/Users/example/code/projects/openrig-hub",
      sessionId: "claude-session-id",
    }) + "\n" + JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "/Users/example/code/projects/openrig-hub" },
        ],
      },
      cwd: "/Users/example/code/projects/openrig-hub",
      sessionId: "claude-session-id",
    });
    const structured = parseClaudeTranscript(content);

    const targetDir = path.join(tmpRoot, "claude-nested");
    await writePacket({
      targetDir,
      structured,
      sourceRuntime: "claude-code",
      targetRig: "openrig-velocity-claude",
      targetRuntime: "claude-code",
      targetWorkspaceRoot: "/Users/example/code/projects/openrig-hub",
      defaultTargetRepo: null,
      rolePointer: "rigs/openrig-velocity-claude/state/velocity/driver-role.md",
      currentWorkSummary: "Nested-content round-trip for M2c-CLI.",
      nextOwner: "self",
      caveats: [],
      authorityBoundaries: "Velocity authority.",
      sourceTrustRanking: ["rig_whoami"],
      sourceSessionId: "claude-session-id",
      sourceRig: "openrig-velocity-claude",
      sourceCwd: "/Users/example/code/projects/openrig-hub",
      generatorVersion: "rig-restore-packet@0.1.0",
      includeFullTranscript: false,
    });

    const summary = JSON.parse(fs.readFileSync(path.join(targetDir, "restore-summary.json"), "utf-8"));
    expect(summary.omitted_classes).toContain("function_call_output");
    expect(summary.omitted_classes).toContain("raw_tool_outputs");
    // Touched-files 清单捕获了被省略 tool_result 中的路径。
    expect(summary.touched_files.top_paths.some((p: { path: string }) =>
      p.path === "/Users/example/code/projects/openrig-hub")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// M2c-CLI R2 — `--source-jsonl` provenance fix.
//
// Guard 在 openrig e5de3ab 处 BLOCKED 了 M2c-CLI：`--source-jsonl` 适配器把 JSONL
// 文件路径写进 `restore-summary.json.source_session_id`，并强制 `source_rig: "unknown"`，
// 即使解析出的 Codex JSONL 中本有 `session_meta.payload.id = "<seat>@<rig>"` 可用。
//
// 这些测试端到端跑 CLI 命令面（Quality Lesson v12 候选）——经 createProgram() 对带
// 真实 session_meta 记录的合成 JSONL 夹具做 parseAsync，从而覆盖 parse 与 writePacket
// 调用之间的 bug。writer 内部测试通过传入手工构造的 sourceSessionId 绕过这条路径。
// ─────────────────────────────────────────────────────────────────────

describe("M2c-CLI R2 --source-jsonl provenance from parsed session_meta", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "restore-packet-r2-"));
  });

  afterEach(async () => {
    const fs = await import("node:fs");
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // The exact reproducer fixture from the guard's BLOCK artifact.
  function jsonlWithSessionMeta(): string {
    return [
      JSON.stringify({
        type: "session_meta",
        payload: {
          cwd: "/Users/example/code/projects/openrig-hub",
          id: "velocity-driver@openrig-velocity",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: "hello direct source",
        },
      }),
    ].join("\n");
  }

  function jsonlWithoutSessionMeta(): string {
    return [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: "no session_meta in this JSONL",
        },
      }),
    ].join("\n");
  }

  function jsonlWithBareSessionMetaId(): string {
    // session_meta exists but the id is a bare token, not <seat>@<rig> shape.
    return [
      JSON.stringify({
        type: "session_meta",
        payload: { cwd: "/x", id: "bare-id-no-at" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: "hi" },
      }),
    ].join("\n");
  }

  it("护栏复现：--source-jsonl 带 session_meta 时，从解析 id 设置 source_session_id，从 <seat>@<rig> 拆分设置 source_rig", async () => {
    const { createProgram } = await import("../src/index.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = path.join(tmpRoot, "source.jsonl");
    fs.writeFileSync(src, jsonlWithSessionMeta(), "utf8");
    const target = path.join(tmpRoot, "packet");

    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "restore-packet", "write",
      "--source-jsonl", src,
      "--target", target,
      "--target-rig", "openrig-velocity-claude",
      "--target-runtime", "claude-code",
      "--current-work-summary", "R2 guard reproducer: provenance from parsed session_meta.",
      "--authority-boundaries", "R2 provenance check only.",
    ]);

    expect(fs.existsSync(target)).toBe(true);
    const summary = JSON.parse(fs.readFileSync(path.join(target, "restore-summary.json"), "utf-8"));
    const validation = validateRestoreSummary(summary);
    expect(validation.valid, JSON.stringify(validation.errors)).toBe(true);
    // bug 复现：据 BLOCK 产物的期望值：
    expect(summary.source_session_id).toBe("velocity-driver@openrig-velocity");
    expect(summary.source_rig).toBe("openrig-velocity");
    expect(summary.source_cwd).toBe("/Users/example/code/projects/openrig-hub");
    // session_session_id 绝不能是文件路径。
    expect(summary.source_session_id).not.toContain("/source.jsonl");
    expect(summary.source_session_id).not.toContain(tmpRoot);
    // 产出 transcript.md（messageCount > 0 → includeFullTranscript 为 true）。
    expect(fs.existsSync(path.join(target, "transcript.md"))).toBe(true);
  });

  // OPR.0.4.6.MH1 rev1-r2 B2：parse 契约的贪婪 rig 是队列闸门的形状（未知 rig 在该处
  // 查找失败）；本处持久化来源信息时不做查找，故多 @ 的会话 id 必须被拒绝并给出显式
  // override 指引——绝不能静默记为 source_rig="rig@host"（BR-1：host 保持带外）。
  it("B2 (rev1-r2)：member@rig@host 会话 id 被拒绝，绝不静默落为 source_rig", async () => {
    // JSONL 路径在无 daemon 的情况下到达 deriveProvenance
    //（--source-session 路径会先经 daemon 取 transcript，并非 B2 所指）。
    // 解析出的 session_meta id 携带带内 host，正是静默错误来源的风险点。
    const { createProgram } = await import("../src/index.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = path.join(tmpRoot, "b2-multi-at.jsonl");
    fs.writeFileSync(src, [
      JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp", id: "member@rig@host" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "hi" } }),
    ].join("\n"), "utf8");
    const target = path.join(tmpRoot, "packet-b2");

    const stderr: string[] = [];
    const origConsoleError = console.error;
    const origExitCode = process.exitCode;
    console.error = (...args: unknown[]) => stderr.push(args.join(" "));
    process.exitCode = undefined;
    try {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "restore-packet", "write",
        "--source-jsonl", src,
        "--target", target,
        "--target-rig", "openrig-velocity-claude",
        "--target-runtime", "codex",
        "--current-work-summary", "B2 provenance strictness check.",
        "--authority-boundaries", "B2 check only.",
      ]);
    } finally {
      console.error = origConsoleError;
    }
    expect(process.exitCode).not.toBe(0);
    process.exitCode = origExitCode;
    const errStr = stderr.join("\n");
    expect(errStr).toMatch(/source-rig-override|could not derive source_rig/);
    // Never silently persisted: no packet written, no rig@host value.
    expect(fs.existsSync(target)).toBe(false);
  });

  it("--source-jsonl 无 session_meta 且无 override flag 时失败并给出显式指引", async () => {
    const { createProgram } = await import("../src/index.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = path.join(tmpRoot, "no-session.jsonl");
    fs.writeFileSync(src, jsonlWithoutSessionMeta(), "utf8");
    const target = path.join(tmpRoot, "packet-no-session");

    const stderr: string[] = [];
    const origConsoleError = console.error;
    const origExitCode = process.exitCode;
    console.error = (...args: unknown[]) => stderr.push(args.join(" "));
    process.exitCode = undefined;
    try {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "restore-packet", "write",
        "--source-jsonl", src,
        "--target", target,
        "--target-rig", "openrig-velocity-claude",
        "--target-runtime", "claude-code",
        "--current-work-summary", "no-session-meta error path.",
        "--authority-boundaries", "R2 provenance check only.",
      ]);
    } finally {
      console.error = origConsoleError;
    }
    expect(process.exitCode).not.toBe(0);
    process.exitCode = origExitCode;
    const errStr = stderr.join("\n");
    expect(errStr).toMatch(/session.meta|--source-session-id-override|--source-rig-override|provenance/i);
    // 未写出残缺 packet。
    expect(fs.existsSync(target)).toBe(false);
  });

  it("--source-jsonl 无 session_meta + 两个 override 均设置时以覆盖后的来源成功", async () => {
    const { createProgram } = await import("../src/index.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = path.join(tmpRoot, "no-session-with-overrides.jsonl");
    fs.writeFileSync(src, jsonlWithoutSessionMeta(), "utf8");
    const target = path.join(tmpRoot, "packet-overrides");

    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "restore-packet", "write",
      "--source-jsonl", src,
      "--target", target,
      "--target-rig", "openrig-velocity-claude",
      "--target-runtime", "claude-code",
      "--source-session-id-override", "manual-driver@manual-rig",
      "--source-rig-override", "manual-rig",
      "--current-work-summary", "override path; honest provenance.",
      "--authority-boundaries", "R2 override path.",
    ]);

    const summary = JSON.parse(fs.readFileSync(path.join(target, "restore-summary.json"), "utf-8"));
    expect(summary.source_session_id).toBe("manual-driver@manual-rig");
    expect(summary.source_rig).toBe("manual-rig");
    const validation = validateRestoreSummary(summary);
    expect(validation.valid, JSON.stringify(validation.errors)).toBe(true);
  });

  it("--source-jsonl 带裸 id 的 session_meta 时，无 --source-rig-override 则失败（不静默 unknown）", async () => {
    const { createProgram } = await import("../src/index.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = path.join(tmpRoot, "bare-id.jsonl");
    fs.writeFileSync(src, jsonlWithBareSessionMetaId(), "utf8");
    const target = path.join(tmpRoot, "packet-bare");

    const stderr: string[] = [];
    const origConsoleError = console.error;
    const origExitCode = process.exitCode;
    console.error = (...args: unknown[]) => stderr.push(args.join(" "));
    process.exitCode = undefined;
    try {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "restore-packet", "write",
        "--source-jsonl", src,
        "--target", target,
        "--target-rig", "openrig-velocity-claude",
        "--target-runtime", "claude-code",
        "--current-work-summary", "bare-id no-rig-override path.",
        "--authority-boundaries", "R2 honest fallback.",
      ]);
    } finally {
      console.error = origConsoleError;
    }
    expect(process.exitCode).not.toBe(0);
    process.exitCode = origExitCode;
    const errStr = stderr.join("\n");
    expect(errStr).toMatch(/source.rig|--source-rig-override|<seat>@<rig>|derive/i);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("--source-jsonl 带 --source-session-id-override 时覆盖解析出的 session_meta id", async () => {
    const { createProgram } = await import("../src/index.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    // JSONL has session_meta.id = velocity-driver@openrig-velocity
    const src = path.join(tmpRoot, "override-wins.jsonl");
    fs.writeFileSync(src, jsonlWithSessionMeta(), "utf8");
    const target = path.join(tmpRoot, "packet-override-wins");

    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "restore-packet", "write",
      "--source-jsonl", src,
      "--target", target,
      "--target-rig", "openrig-velocity-claude",
      "--target-runtime", "claude-code",
      "--source-session-id-override", "operator-renamed@operator-rig",
      "--source-rig-override", "operator-rig",
      "--current-work-summary", "override-wins path.",
      "--authority-boundaries", "operator-supplied provenance.",
    ]);

    const summary = JSON.parse(fs.readFileSync(path.join(target, "restore-summary.json"), "utf-8"));
    expect(summary.source_session_id).toBe("operator-renamed@operator-rig");
    expect(summary.source_rig).toBe("operator-rig");
  });
});

// ─────────────────────────────────────────────────────────────────────
// M2c-Daemon final M2 regression — Velocity 4-pack round-trip via CLI.
//
// 据 dispatch qitem-20260502020626-8cd2b7a6（item 4）：加载 4 个 Velocity 先例角色 packet，
// 定位其原始 Codex JSONL，经 v0 generator 跑 --source-jsonl，并断言来源字段保留 +
// schema 合法 + 脱敏策略生效。
//
// 测试以文件存在为闸门：原始 JSONL 在宿主机 ~/.codex/sessions/2026/04/23/。缺失时
//（其他开发者 / CI），用例以 guard 消息跳过——上面的合成 Velocity 往返已覆盖结构形状；
// 本套件在可用时补充真实数据校验（dispatch-condition）。
// ─────────────────────────────────────────────────────────────────────

describe("M2c-Daemon final regression — Velocity 4-pack round-trip via CLI", () => {
  let tmpRoot: string;
  const VELOCITY_ROOT = "/Users/example/.openrig/shared-docs/internal-docs/field-notes/2026-04-27-velocity-claude-from-codex-restore";

  beforeEach(async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "restore-packet-velocity-cli-"));
  });

  afterEach(async () => {
    const fs = await import("node:fs");
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  for (const role of ["driver", "guard", "planner", "tester"]) {
    it(`Velocity ${role} packet: --source-jsonl round-trip yields v0 packet with preserved provenance`, async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const refSummaryPath = path.join(VELOCITY_ROOT, role, "restore-summary.json");
      if (!fs.existsSync(refSummaryPath)) {
        console.warn(`SKIP: Velocity reference packet absent at ${refSummaryPath}`);
        return;
      }
      const refSummary = JSON.parse(fs.readFileSync(refSummaryPath, "utf-8")) as {
        source_jsonl?: string;
        source_session?: string;
        source_cwd?: string;
      };
      const sourceJsonl = refSummary.source_jsonl ?? "";
      if (!sourceJsonl || !fs.existsSync(sourceJsonl)) {
        console.warn(`SKIP: Velocity ${role} source JSONL absent at ${sourceJsonl}`);
        return;
      }

      const { createProgram } = await import("../src/index.js");
      const target = path.join(tmpRoot, `packet-${role}`);

      // Codex JSONL session_meta 携带 UUID 形状的 rollout id，而非 <seat>@<rig> 名。
      // Velocity 先例的 .mjs 从 CLI 参数取 canonical 名；v0 往返中我们以传入
      // --source-session-id-override + --source-rig-override（对齐参考 packet 的
      // source_session 值）来镜像该行为。
      const canonicalSessionId = refSummary.source_session ?? "";
      const canonicalRig = canonicalSessionId.split("@")[1] ?? "openrig-velocity-code";

      const program = createProgram();
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "restore-packet", "write",
        "--source-jsonl", sourceJsonl,
        "--target", target,
        "--target-rig", "openrig-velocity-claude",
        "--target-runtime", "claude-code",
        "--source-session-id-override", canonicalSessionId,
        "--source-rig-override", canonicalRig,
        "--current-work-summary", `Velocity ${role} round-trip via M2c-Daemon final regression.`,
        "--authority-boundaries", `Restored ${role} authority for Velocity-replay context.`,
      ]);

      // v0 packet structure check.
      expect(fs.existsSync(target)).toBe(true);
      const summary = JSON.parse(fs.readFileSync(path.join(target, "restore-summary.json"), "utf-8"));
      const validation = validateRestoreSummary(summary);
      expect(validation.valid, JSON.stringify(validation.errors)).toBe(true);

      // Provenance fields preserved (Velocity prior-art -> v0 mapping).
      expect(summary.source_session_id).toBe(refSummary.source_session);
      // source_rig derived from <seat>@<rig> split of source_session.
      const expectedRig = refSummary.source_session?.split("@")[1];
      expect(summary.source_rig).toBe(expectedRig);
      expect(summary.source_cwd).toBe(refSummary.source_cwd);

      // 脱敏策略已生效。
      expect(summary.redaction_policy_id).toBe("openrig-v0");

      // omitted 记录计数合理（Velocity packet 由完整 Codex session 生成，
      // 应含大量 reasoning_records 与 function_call_output 记录）。
      expect(Array.isArray(summary.omitted_classes)).toBe(true);
      expect(summary.omitted_classes.length).toBeGreaterThan(0);

      // bounded_latest_transcript 文件已写出。
      expect(fs.existsSync(path.join(target, "transcript-latest.md"))).toBe(true);
    }, 90000); // Velocity JSONLs are 22-37MB; allow generous timeout.
  }
});

// ─────────────────────────────────────────────────────────────────────
// M2c-Daemon 最终 M2 回归——CLI 面脱敏 + omitted 往返。据 dispatch items 7 + 8：
// 经 createProgram() 跑 parse-to-write 路径（Quality Lesson v12 沿用），覆盖
// (a) 经 --source-jsonl 的凭据 pattern 脱敏，(b) M2b R2 嵌套内容 omitted-record
// 计数（Quality Lesson v11 沿用）。
// ─────────────────────────────────────────────────────────────────────

describe("M2c-Daemon final regression — CLI-surface redaction + omitted round-trips", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "restore-packet-final-cli-"));
  });

  afterEach(async () => {
    const fs = await import("node:fs");
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("--source-jsonl 带凭据 pattern 夹具：产出的 transcript 在传输层已脱敏", async () => {
    const { createProgram } = await import("../src/index.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    // 合成凭据，非真实 token。据 Quality Lesson v9。
    const src = path.join(tmpRoot, "with-creds.jsonl");
    fs.writeFileSync(src, [
      JSON.stringify({
        type: "session_meta",
        payload: { cwd: "/x", id: "creds-driver@creds-rig" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "saw token sk-FakeAbCdEfGhIjKlMnOpQr in logs" }],
        },
      }),
    ].join("\n"), "utf8");

    const target = path.join(tmpRoot, "packet-creds");
    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "restore-packet", "write",
      "--source-jsonl", src,
      "--target", target,
      "--target-rig", "openrig-velocity-claude",
      "--target-runtime", "claude-code",
      "--current-work-summary", "redaction CLI round-trip.",
      "--authority-boundaries", "redaction proof.",
    ]);

    const transcriptLatest = fs.readFileSync(path.join(target, "transcript-latest.md"), "utf-8");
    expect(transcriptLatest).not.toContain("sk-FakeAbCdEfGhIjKlMnOpQr");
    expect(transcriptLatest).toContain("[REDACTED]");

    // summary 的 omitted_classes 记录脱敏发生次数。
    const summary = JSON.parse(fs.readFileSync(path.join(target, "restore-summary.json"), "utf-8"));
    expect(summary.omitted_classes).toContain("redacted_secrets");
    expect(summary.redaction_policy_id).toBe("openrig-v0");
  });

  it("--source-jsonl 带 M2b R2 嵌套 Claude 内容（tool_use + tool_result）：经 CLI 面填充 omitted 计数", async () => {
    const { createProgram } = await import("../src/index.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    // Claude transcript with nested tool_use + tool_result inside top-level
    // assistant/user records (the M2b R2 reproducer shape per Quality
    // Lesson v11 carry-forward).
    const src = path.join(tmpRoot, "claude-nested.jsonl");
    fs.writeFileSync(src, [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { cmd: "pwd" } },
            { type: "text", text: "checking now" },
          ],
        },
        cwd: "/Users/example/code/projects/openrig-hub",
        sessionId: "claude-final@openrig-velocity-claude",
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "/Users/example/code/projects/openrig-hub" },
          ],
        },
        cwd: "/Users/example/code/projects/openrig-hub",
        sessionId: "claude-final@openrig-velocity-claude",
      }),
    ].join("\n"), "utf8");

    const target = path.join(tmpRoot, "packet-claude-nested");
    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "restore-packet", "write",
      "--source-jsonl", src,
      "--target", target,
      "--target-rig", "openrig-velocity-claude",
      "--target-runtime", "claude-code",
      "--source-runtime", "claude-code",
      "--current-work-summary", "M2b R2 nested-content via CLI surface.",
      "--authority-boundaries", "Quality Lesson v11 carry-forward.",
    ]);

    const summary = JSON.parse(fs.readFileSync(path.join(target, "restore-summary.json"), "utf-8"));
    const validation = validateRestoreSummary(summary);
    expect(validation.valid, JSON.stringify(validation.errors)).toBe(true);
    expect(summary.omitted_classes).toContain("function_call_output");
    expect(summary.omitted_classes).toContain("raw_tool_outputs");
    // Provenance from session_meta-equivalent (Claude per-record sessionId).
    expect(summary.source_session_id).toBe("claude-final@openrig-velocity-claude");
    expect(summary.source_rig).toBe("openrig-velocity-claude");
    expect(summary.source_cwd).toBe("/Users/example/code/projects/openrig-hub");
    // Touched-files 清单捕获了被省略 tool_result 中的路径。
    expect(summary.touched_files.top_paths.some((p: { path: string }) =>
      p.path === "/Users/example/code/projects/openrig-hub")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// M3 — `rig restore-packet read` + `validate` actual implementations.
//
// 据 dispatch qitem-20260502023319-d997e182 + IMPL § M3 line 154-191 +
// M1 契约 § 1（packet 形状）+ § 4（脱敏仅枚举）+ § 8（validate 行为 + 退出码矩阵）。
// 前驱：M2c-Daemon 在 openrig c7b74fa 处 ACCEPTED。
// ─────────────────────────────────────────────────────────────────────

describe("M3 restore-packet read + validate", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "restore-packet-m3-"));
  });

  afterEach(async () => {
    const fs = await import("node:fs");
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function buildValidPacket(targetDir: string): Promise<void> {
    const { createProgram } = await import("../src/index.js");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = path.join(tmpRoot, `src-${path.basename(targetDir)}.jsonl`);
    fs.writeFileSync(src, [
      JSON.stringify({
        type: "session_meta",
        payload: { cwd: "/Users/example/code/projects/openrig-hub", id: "m3-driver@m3-rig" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "user", content: "M3 fixture packet" },
      }),
    ].join("\n"), "utf8");

    const program = createProgram();
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "restore-packet", "write",
      "--source-jsonl", src,
      "--target", targetDir,
      "--target-rig", "openrig-velocity-claude",
      "--target-runtime", "claude-code",
      "--current-work-summary", "M3 fixture packet for read/validate tests.",
      "--authority-boundaries", "M3 test fixture only.",
    ]);
  }

  async function captureCli(argv: string[]): Promise<{ exitCode: number | undefined; stdout: string[]; stderr: string[] }> {
    const { createProgram } = await import("../src/index.js");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExit = process.exitCode;
    console.log = (...args: unknown[]) => stdout.push(args.join(" "));
    console.error = (...args: unknown[]) => stderr.push(args.join(" "));
    process.exitCode = undefined;
    try {
      const program = createProgram();
      program.exitOverride();
      try {
        await program.parseAsync(argv);
      } catch (err) {
        if (err instanceof Error && process.exitCode === undefined) {
          process.exitCode = 2;
        }
        if (err instanceof Error) stderr.push(err.message);
      }
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    const exitCode = process.exitCode;
    process.exitCode = origExit;
    return { exitCode, stdout, stderr };
  }

  it("read：人类可读输出打印 restore-instructions 正文 + summary 元数据 + transcript 摘要", async () => {
    const path = await import("node:path");
    const target = path.join(tmpRoot, "packet-read-human");
    await buildValidPacket(target);

    const { exitCode, stdout } = await captureCli([
      "node", "rig", "restore-packet", "read", target,
    ]);
    expect(exitCode === undefined || exitCode === 0).toBe(true);
    const out = stdout.join("\n");
    expect(out).toContain("# 恢复说明");
    expect(out).toContain("source_session_id");
    expect(out).toContain("m3-driver@m3-rig");
    expect(out).toContain("source_rig");
    expect(out).toContain("m3-rig");
    expect(out).toContain("target_rig");
    expect(out).toContain("openrig-velocity-claude");
    expect(out).toContain("generator_version");
    expect(out).toContain("rig-restore-packet@0.1.0");
    expect(out).toMatch(/transcript\.md/);
  });

  it("read --json：stdout 可往返还原为 restore-summary.json", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const target = path.join(tmpRoot, "packet-read-json");
    await buildValidPacket(target);

    const { exitCode, stdout } = await captureCli([
      "node", "rig", "restore-packet", "read", target, "--json",
    ]);
    expect(exitCode === undefined || exitCode === 0).toBe(true);
    const stdoutSummary = JSON.parse(stdout.join("\n"));
    const onDisk = JSON.parse(fs.readFileSync(path.join(target, "restore-summary.json"), "utf-8"));
    expect(stdoutSummary).toEqual(onDisk);
  });

  it("read：缺 restore-summary.json 时以显式错误失败", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const target = path.join(tmpRoot, "packet-read-missing-summary");
    await buildValidPacket(target);
    fs.rmSync(path.join(target, "restore-summary.json"));

    const { exitCode, stderr } = await captureCli([
      "node", "rig", "restore-packet", "read", target,
    ]);
    expect(exitCode).not.toBe(0);
    const errText = stderr.join("\n");
    expect(errText).toMatch(/restore-summary\.json|missing|not found/i);
  });

  it("read：既无 transcript.md 又无 full_transcript summary 键的 packet 打印缺失行", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const target = path.join(tmpRoot, "packet-read-no-transcript");
    await buildValidPacket(target);
    fs.rmSync(path.join(target, "transcript.md"));
    const summary = JSON.parse(fs.readFileSync(path.join(target, "restore-summary.json"), "utf-8"));
    delete summary.full_transcript;
    fs.writeFileSync(path.join(target, "restore-summary.json"), JSON.stringify(summary, null, 2));

    const { exitCode, stdout } = await captureCli([
      "node", "rig", "restore-packet", "read", target,
    ]);
    expect(exitCode === undefined || exitCode === 0).toBe(true);
    expect(stdout.join("\n")).toMatch(/缺 transcript\.md/);
  });

  it("validate：接受带 transcript.md + full_transcript 键的规范 packet（奇偶性一致）", async () => {
    const path = await import("node:path");
    const target = path.join(tmpRoot, "packet-validate-with-transcript");
    await buildValidPacket(target);

    const { exitCode, stdout } = await captureCli([
      "node", "rig", "restore-packet", "validate", target,
    ]);
    expect(exitCode === undefined || exitCode === 0).toBe(true);
    expect(stdout.join("\n")).toMatch(/valid|ok|pass/i);
  });

  it("validate：接受既无 transcript.md 又无 full_transcript 键的规范 packet（经缺失判定的奇偶性）", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const target = path.join(tmpRoot, "packet-validate-no-transcript");
    await buildValidPacket(target);
    fs.rmSync(path.join(target, "transcript.md"));
    const summary = JSON.parse(fs.readFileSync(path.join(target, "restore-summary.json"), "utf-8"));
    delete summary.full_transcript;
    fs.writeFileSync(path.join(target, "restore-summary.json"), JSON.stringify(summary, null, 2));

    const { exitCode } = await captureCli([
      "node", "rig", "restore-packet", "validate", target,
    ]);
    expect(exitCode === undefined || exitCode === 0).toBe(true);
  });

  it("validate：拒绝有 full_transcript 键但缺 transcript.md 的 packet（奇偶性违例）", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const target = path.join(tmpRoot, "packet-validate-parity-1");
    await buildValidPacket(target);
    fs.rmSync(path.join(target, "transcript.md"));

    const { exitCode, stdout, stderr } = await captureCli([
      "node", "rig", "restore-packet", "validate", target,
    ]);
    expect(exitCode).not.toBe(0);
    const out = stdout.concat(stderr).join("\n");
    expect(out).toMatch(/parity|transcript\.md|full_transcript/i);
  });

  it("validate：拒绝有 transcript.md 但缺 full_transcript 键的 packet（奇偶性违例）", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const target = path.join(tmpRoot, "packet-validate-parity-2");
    await buildValidPacket(target);
    const summary = JSON.parse(fs.readFileSync(path.join(target, "restore-summary.json"), "utf-8"));
    delete summary.full_transcript;
    fs.writeFileSync(path.join(target, "restore-summary.json"), JSON.stringify(summary, null, 2));

    const { exitCode, stdout, stderr } = await captureCli([
      "node", "rig", "restore-packet", "validate", target,
    ]);
    expect(exitCode).not.toBe(0);
    const out = stdout.concat(stderr).join("\n");
    expect(out).toMatch(/parity|transcript\.md|full_transcript/i);
  });

  it("validate：拒绝缺必需字段的 packet（逐字段报错）", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const target = path.join(tmpRoot, "packet-validate-missing-field");
    await buildValidPacket(target);
    const summary = JSON.parse(fs.readFileSync(path.join(target, "restore-summary.json"), "utf-8"));
    delete summary.source_session_id;
    fs.writeFileSync(path.join(target, "restore-summary.json"), JSON.stringify(summary, null, 2));

    const { exitCode, stdout, stderr } = await captureCli([
      "node", "rig", "restore-packet", "validate", target,
    ]);
    expect(exitCode).not.toBe(0);
    const out = stdout.concat(stderr).join("\n");
    expect(out).toMatch(/source_session_id/);
  });

  it("validate：拒绝缺 4 个必需文件之一的 packet", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const target = path.join(tmpRoot, "packet-validate-missing-file");
    await buildValidPacket(target);
    fs.rmSync(path.join(target, "touched-files.md"));

    const { exitCode, stdout, stderr } = await captureCli([
      "node", "rig", "restore-packet", "validate", target,
    ]);
    expect(exitCode).not.toBe(0);
    const out = stdout.concat(stderr).join("\n");
    expect(out).toMatch(/touched-files\.md|required file|missing/i);
  });

  it("validate --json：机器可读形状 { valid: boolean, errors: [...] }", async () => {
    const path = await import("node:path");
    const target = path.join(tmpRoot, "packet-validate-json");
    await buildValidPacket(target);

    const { exitCode, stdout } = await captureCli([
      "node", "rig", "restore-packet", "validate", target, "--json",
    ]);
    expect(exitCode === undefined || exitCode === 0).toBe(true);
    const report = JSON.parse(stdout.join("\n"));
    expect(report).toHaveProperty("valid");
    expect(report).toHaveProperty("errors");
    expect(report.valid).toBe(true);
    expect(Array.isArray(report.errors)).toBe(true);
  });

  it("validate：可选字段畸形（full_transcript 类型错误）-> exit 0 带 WARNING（据契约 § 8）", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const target = path.join(tmpRoot, "packet-validate-warning");
    await buildValidPacket(target);
    const summary = JSON.parse(fs.readFileSync(path.join(target, "restore-summary.json"), "utf-8"));
    summary.full_transcript = { path: "transcript.md", line_count: "not-an-integer" };
    fs.writeFileSync(path.join(target, "restore-summary.json"), JSON.stringify(summary, null, 2));

    const { exitCode, stdout, stderr } = await captureCli([
      "node", "rig", "restore-packet", "validate", target,
    ]);
    expect(exitCode === undefined || exitCode === 0).toBe(true);
    const out = stdout.concat(stderr).join("\n");
    expect(out).toMatch(/warning|warn/i);
    expect(out).toMatch(/full_transcript|line_count/i);
  });

  it("validate：redaction_policy_id 仅做枚举检查（刻意的 v0 行为；据契约 § 4 + § 8 对齐 Velocity 先例）", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const target = path.join(tmpRoot, "packet-validate-enum-only");
    await buildValidPacket(target);
    fs.writeFileSync(
      path.join(target, "transcript.md"),
      "# Transcript\n\ntoken FAKETESTSTRING-NOT-A-REAL-CREDENTIAL-x123 was visible in logs\n",
    );

    const { exitCode } = await captureCli([
      "node", "rig", "restore-packet", "validate", target,
    ]);
    expect(exitCode === undefined || exitCode === 0).toBe(true);
  });

  // ─── M4 ───
  // 据 dispatch qitem-20260502024605-55720e41 + IMPL § M4 line 193-207：
  // 命令注册元测试。捕获未来 `restore-packet` 被 import 但未注册（createProgram 链路接线断裂）的回归。
  // 参考先例：compact-plan.test.ts:166-176。

  it("M4：createProgram 将 restore-packet 注册为顶层命令", async () => {
    const { createProgram } = await import("../src/index.js");
    const program = createProgram();
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("restore-packet");
  });

  it("M4：rig --help 在帮助输出中可发现 restore-packet", async () => {
    const { createProgram } = await import("../src/index.js");
    const program = createProgram();
    const helpText = program.helpInformation();
    expect(helpText).toContain("restore-packet");
  });

  it("M4：rig restore-packet --help 可发现全部 3 个子命令（write, read, validate）", async () => {
    const { createProgram } = await import("../src/index.js");
    const program = createProgram();
    const restorePacket = program.commands.find((c) => c.name() === "restore-packet");
    expect(restorePacket).toBeDefined();
    const helpText = restorePacket!.helpInformation();
    expect(helpText).toContain("write");
    expect(helpText).toContain("read");
    expect(helpText).toContain("validate");
  });

  it("validate：redaction_policy_id 错误枚举值 -> REJECT", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const target = path.join(tmpRoot, "packet-validate-bad-enum");
    await buildValidPacket(target);
    const summary = JSON.parse(fs.readFileSync(path.join(target, "restore-summary.json"), "utf-8"));
    summary.redaction_policy_id = "not-a-real-policy";
    fs.writeFileSync(path.join(target, "restore-summary.json"), JSON.stringify(summary, null, 2));

    const { exitCode, stdout, stderr } = await captureCli([
      "node", "rig", "restore-packet", "validate", target,
    ]);
    expect(exitCode).not.toBe(0);
    const out = stdout.concat(stderr).join("\n");
    expect(out).toMatch(/redaction_policy_id|enum/i);
  });
});
