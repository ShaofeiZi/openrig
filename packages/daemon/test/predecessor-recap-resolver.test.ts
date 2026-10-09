import { describe, it, expect, vi } from "vitest";
import { makePredecessorRecapResolver } from "../src/domain/predecessor-recap-resolver.js";

// seat-handover boot recap 的 production resolver（scrollback preservation 的永久 claude-runtime
// 环节）：给定 departing seat 的 node/runtime/session，解析其 provider record path
//（Claude transcript_path / Codex rollout_path）及最后 N 次 exchange。纯函数 + 注入依赖，因此无需
// live daemon 即可进行 unit test。

describe("makePredecessorRecapResolver 前任摘要解析", () => {
  it("Claude：读取 sidecar record 并解析最后 N 次 exchange（不执行 Codex probe）", () => {
    const readClaudeRecord = vi.fn(() => ({ transcriptPath: "/home/.claude/projects/x/abc.jsonl", sessionId: "sid-1" }));
    const readCodexTranscriptPath = vi.fn(() => null);
    const lookupResumeToken = vi.fn(() => "sid-1"); // predecessor token 与 sidecar owner 匹配
    const parseExchanges = vi.fn(() => [
      { role: "user", content: "finish the atom" },
      { role: "assistant", content: "done" },
    ]);

    const resolve = makePredecessorRecapResolver({
      readClaudeRecord,
      readCodexTranscriptPath,
      lookupResumeToken,
      parseExchanges,
      maxExchanges: 6,
    });

    const out = resolve({ nodeId: "n1", runtime: "claude-code", sessionName: "dev-impl@rig" });

    expect(readClaudeRecord).toHaveBeenCalledWith("dev-impl@rig");
    expect(readCodexTranscriptPath).not.toHaveBeenCalled();
    expect(parseExchanges).toHaveBeenCalledWith("/home/.claude/projects/x/abc.jsonl", 6);
    expect(out).toEqual({
      recap: [
        { role: "user", content: "finish the atom" },
        { role: "assistant", content: "done" },
      ],
      recordPath: "/home/.claude/projects/x/abc.jsonl",
    });
  });

  it("B16 ownership guard：session_id 不属于 predecessor 的 sidecar 返回具名 unavailable（绝不返回另一 tenure 的 recap）", () => {
    const parseExchanges = vi.fn(() => [{ role: "user", content: "successor boot noise" }]);
    const resolve = makePredecessorRecapResolver({
      readClaudeRecord: () => ({ transcriptPath: "/p/successor.jsonl", sessionId: "successor-id" }),
      readCodexTranscriptPath: () => null,
      lookupResumeToken: () => "predecessor-id",
      parseExchanges,
    });

    const out = resolve({ nodeId: "n", runtime: "claude-code", sessionName: "s" });

    expect("unavailableReason" in out).toBe(true);
    if ("unavailableReason" in out) {
      expect(out.unavailableReason).toContain("successo"); // 点名冲突 session id prefix
      expect(out.unavailableReason).toContain("predeces");
    }
    expect(parseExchanges).not.toHaveBeenCalled(); // 绝不解析错误 tenure 的 record
  });

  it("B16 fail-open：缺少 session_id 或 predecessor token 时跳过 guard，并按 path 解析", () => {
    const resolve = makePredecessorRecapResolver({
      readClaudeRecord: () => ({ transcriptPath: "/p/abc.jsonl", sessionId: null }),
      readCodexTranscriptPath: () => null,
      lookupResumeToken: () => null,
      parseExchanges: () => [{ role: "user", content: "hello" }],
    });
    const out = resolve({ nodeId: "n", runtime: "claude-code", sessionName: "s" });
    expect("recap" in out).toBe(true);
  });

  it("Codex：查询 departing resume token，读取 Codex rollout_path 并解析", () => {
    const readClaudeRecord = vi.fn(() => ({ transcriptPath: null, sessionId: null }));
    const readCodexTranscriptPath = vi.fn(() => "/home/.codex/sessions/roll.jsonl");
    const lookupResumeToken = vi.fn(() => "codex-thread-xyz");
    const parseExchanges = vi.fn(() => [{ role: "assistant", content: "handing over" }]);

    const resolve = makePredecessorRecapResolver({
      readClaudeRecord,
      readCodexTranscriptPath,
      lookupResumeToken,
      parseExchanges,
    });

    const out = resolve({ nodeId: "n2", runtime: "codex", sessionName: "dev-impl@rig" });

    expect(lookupResumeToken).toHaveBeenCalledWith("n2", "dev-impl@rig");
    expect(readCodexTranscriptPath).toHaveBeenCalledWith({ threadId: "codex-thread-xyz", sessionName: "dev-impl@rig" });
    expect(readClaudeRecord).not.toHaveBeenCalled();
    expect(out).toEqual({ recap: [{ role: "assistant", content: "handing over" }], recordPath: "/home/.codex/sessions/roll.jsonl" });
  });

  it("无 record path 时解析为具名 unavailable（不尝试 parse）", () => {
    const parseExchanges = vi.fn(() => []);
    const resolve = makePredecessorRecapResolver({
      readClaudeRecord: () => ({ transcriptPath: null, sessionId: null }),
      readCodexTranscriptPath: () => null,
      lookupResumeToken: () => null,
      parseExchanges,
    });

    const out = resolve({ nodeId: "n", runtime: "claude-code", sessionName: "s" });
    expect("unavailableReason" in out && out.unavailableReason).toContain("sidecar");
    expect(parseExchanges).not.toHaveBeenCalled();
  });

  it("将每次 exchange content 限制在 maxCharsPerExchange，并显示 truncation marker", () => {
    const long = "x".repeat(800);
    const resolve = makePredecessorRecapResolver({
      readClaudeRecord: () => ({ transcriptPath: "/p/abc.jsonl", sessionId: null }),
      readCodexTranscriptPath: () => null,
      lookupResumeToken: () => null,
      parseExchanges: () => [
        { role: "user", content: "short" },
        { role: "assistant", content: long },
      ],
      maxCharsPerExchange: 100,
    });

    const out = resolve({ nodeId: "n", runtime: "claude-code", sessionName: "s" });
    if (!("recap" in out)) throw new Error("expected recap");
    expect(out.recap[0]).toEqual({ role: "user", content: "short" });
    expect(out.recap[1]!.content).toHaveLength(100 + "… [已截断；完整文本见前任记录]".length);
    expect(out.recap[1]!.content.startsWith("x".repeat(100))).toBe(true);
    expect(out.recap[1]!.content).toContain("[已截断；完整文本见前任记录]");
  });

  it("默认将每次 exchange content 限制在 500 字符（粘贴文件的 exchange 不得淹没 successor pane）", () => {
    const resolve = makePredecessorRecapResolver({
      readClaudeRecord: () => ({ transcriptPath: "/p/abc.jsonl", sessionId: null }),
      readCodexTranscriptPath: () => null,
      lookupResumeToken: () => null,
      parseExchanges: () => [{ role: "user", content: "y".repeat(10_000) }],
    });

    const out = resolve({ nodeId: "n", runtime: "claude-code", sessionName: "s" });
    if (!("recap" in out)) throw new Error("expected recap");
    expect(out.recap[0]!.content.startsWith("y".repeat(500))).toBe(true);
    expect(out.recap[0]!.content).toContain("[已截断；完整文本见前任记录]");
    expect(out.recap[0]!.content.length).toBeLessThan(600);
  });

  it("零 exchange record 解析为引用 path 的具名 unavailable（不伪造）", () => {
    const resolve = makePredecessorRecapResolver({
      readClaudeRecord: () => ({ transcriptPath: "/p/empty.jsonl", sessionId: null }),
      readCodexTranscriptPath: () => null,
      lookupResumeToken: () => null,
      parseExchanges: () => [],
    });

    const out = resolve({ nodeId: "n", runtime: "claude-code", sessionName: "s" });
    expect("unavailableReason" in out && out.unavailableReason).toContain("/p/empty.jsonl");
  });
});
