import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonlExchanges } from "../src/domain/session-jsonl.js";

// 席位移交启动回顾：读取 PROVIDER 会话 JSONL（Claude sidecar transcript_path / Codex
// rollout_path），为启动回顾提取最后 N 条 {role, content} 对话。防御性/诚实降级：元数据及
// 仅含 thinking/tool_use 的行没有用户文本，会被跳过；不可解析的行也会被跳过（损坏的尾部
// 绝不抛出异常）。依据真实 claude-projects 行结构（{type,message:{role,content}}；content
// 可以是字符串或 [{type,text}] 块）。

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fixture(lines: unknown[]): string {
  const d = mkdtempSync(join(tmpdir(), "sj-"));
  dirs.push(d);
  const p = join(d, "transcript.jsonl");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return p;
}

describe("parseJsonlExchanges——claude-projects role/content 结构", () => {
  it("从用户字符串与智能体文本行提取 {role, content}，最新项在末尾", () => {
    const p = fixture([
      { type: "custom-title", customTitle: "x" }, // 元数据——跳过。
      { type: "user", message: { role: "user", content: "do the thing" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", text: "hmm" }] } }, // 仅 thinking——跳过。
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done the thing" }] } },
    ]);
    expect(parseJsonlExchanges(p, 10)).toEqual([
      { role: "user", content: "do the thing" },
      { role: "assistant", content: "done the thing" },
    ]);
  });

  it("拼接多个文本块，并跳过智能体数组中的 tool_use 块", () => {
    const p = fixture([
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "part A" }, { type: "tool_use", name: "x" }, { type: "text", text: "part B" }] } },
    ]);
    expect(parseJsonlExchanges(p, 10)).toEqual([{ role: "assistant", content: "part A\npart B" }]);
  });

  it("限制为最后 N 条对话", () => {
    const p = fixture([
      { type: "user", message: { role: "user", content: "1" } },
      { type: "user", message: { role: "user", content: "2" } },
      { type: "user", message: { role: "user", content: "3" } },
    ]);
    expect(parseJsonlExchanges(p, 2)).toEqual([
      { role: "user", content: "2" },
      { role: "user", content: "3" },
    ]);
  });

  it("跳过不可解析行（损坏尾部绝不抛出异常）和空文本消息", () => {
    const d = mkdtempSync(join(tmpdir(), "sj-"));
    dirs.push(d);
    const p = join(d, "t.jsonl");
    writeFileSync(p, [
      JSON.stringify({ type: "user", message: { role: "user", content: "good" } }),
      "{ this is not json",
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "x" }] } }), // 无文本 → 跳过。
    ].join("\n") + "\n");
    expect(parseJsonlExchanges(p, 10)).toEqual([{ role: "user", content: "good" }]);
  });

  it("文件缺失时返回 []（诚实降级，绝不抛出异常）", () => {
    expect(parseJsonlExchanges(join(tmpdir(), "does-not-exist-xyz.jsonl"), 5)).toEqual([]);
  });

  it("也可读取 Codex rollout 结构（payload.type=message，包含 role/content）", () => {
    const p = fixture([
      { payload: { type: "message", role: "user", content: "codex hello" } },
      { payload: { type: "token_count", info: {} } }, // 非消息——跳过。
    ]);
    expect(parseJsonlExchanges(p, 10)).toEqual([{ role: "user", content: "codex hello" }]);
  });
});
