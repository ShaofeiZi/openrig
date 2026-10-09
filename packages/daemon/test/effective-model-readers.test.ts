// B8 / slice-07 A3——逐运行时读取有效模型：真实形状 fixture、有界尾读、诚实 null。
// 两个样本都证明 REQUESTED 回显不可信；这里读取运行时自身记录。

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readClaudeEffectiveModel,
  readCodexEffectiveModel,
  readTailLines,
} from "../src/domain/model-divergence/effective-model-readers.js";

const dirs: string[] = [];
function tmp(name: string, content: string): string {
  const d = mkdtempSync(join(tmpdir(), "emr-"));
  dirs.push(d);
  const p = join(d, name);
  writeFileSync(p, content);
  return p;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const claudeLine = (model: string) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", model, content: [{ type: "text", text: "hi" }] } });
const codexWorldState = (model: string) =>
  JSON.stringify({ timestamp: "t", ordinal: 4, type: "world_state", payload: { full: true, state: { collaboration_mode: { mode: "default", model } } } });

describe("readClaudeEffectiveModel", () => {
  it("返回最新 assistant 轮次的模型（API 响应点明实际回答者）", () => {
    const p = tmp("t.jsonl", [
      claudeLine("claude-opus-5"),
      JSON.stringify({ type: "user", message: { role: "user", content: "q" } }),
      claudeLine("claude-fable-5"),
      "",
    ].join("\n"));
    expect(readClaudeEffectiveModel(p)).toBe("claude-fable-5");
  });

  it("跳过较新的合成 harness 通知，返回最新真实 assistant 模型", () => {
    const p = tmp("t.jsonl", [
      claudeLine("claude-fable-5"),
      claudeLine("<synthetic>"),
      "",
    ].join("\n"));
    expect(readClaudeEffectiveModel(p)).toBe("claude-fable-5");
  });

  it("仅含合成消息的 assistant 历史返回 null，而不虚构有效模型", () => {
    const p = tmp("t.jsonl", claudeLine("<synthetic>") + "\n");
    expect(readClaudeEffectiveModel(p)).toBeNull();
  });

  it("没有 assistant 轮次的 transcript 返回 null（待定，绝不假设）", () => {
    const p = tmp("t.jsonl", JSON.stringify({ type: "user", message: { role: "user", content: "boot" } }) + "\n");
    expect(readClaudeEffectiveModel(p)).toBeNull();
  });

  it("文件缺失时返回 null，并跳过损坏行", () => {
    expect(readClaudeEffectiveModel("/nonexistent/t.jsonl")).toBeNull();
    const p = tmp("t.jsonl", "{not json \"assistant\" \"model\"\n" + claudeLine("claude-fable-5") + "\n");
    expect(readClaudeEffectiveModel(p)).toBe("claude-fable-5");
  });

  it("有界读取：只读取尾部窗口，大文件尾部范围内的信号仍可解析", () => {
    const p = tmp("t.jsonl", "");
    // 约 2MB 填充行后写入信号；512KB 尾部仍包含它。
    for (let i = 0; i < 2000; i++) appendFileSync(p, JSON.stringify({ type: "metadata", filler: "x".repeat(1000) }) + "\n");
    appendFileSync(p, claudeLine("claude-fable-5") + "\n");
    expect(readClaudeEffectiveModel(p)).toBe("claude-fable-5");
  });
});

describe("readCodexEffectiveModel", () => {
  it("返回最新 world_state 的 collaboration_mode.model", () => {
    const p = tmp("r.jsonl", [
      codexWorldState("gpt-5.6-luna"),
      JSON.stringify({ type: "turn_context", payload: {} }),
      codexWorldState("gpt-5.4-mini"), // the silent-degrade specimen: newest state wins
      "",
    ].join("\n"));
    expect(readCodexEffectiveModel(p)).toBe("gpt-5.4-mini");
  });

  it("尾部没有 world_state 时返回 null", () => {
    const p = tmp("r.jsonl", JSON.stringify({ type: "turn_context", payload: {} }) + "\n");
    expect(readCodexEffectiveModel(p)).toBeNull();
  });

  it("r1 发现：反向扫描能找到大型 rollout 深处的稀疏 world_state（实测距 65.9MB 线上文件 EOF 0.80MB）", () => {
    const p = tmp("r.jsonl", "");
    appendFileSync(p, codexWorldState("gpt-5.6-luna") + "\n");
    // 信号后约 1.5MB 噪声；信号距 EOF 约 3 个尾部窗口。
    for (let i = 0; i < 1500; i++) appendFileSync(p, JSON.stringify({ type: "event_msg", filler: "x".repeat(1000) }) + "\n");
    expect(readCodexEffectiveModel(p)).toBe("gpt-5.6-luna");
  });

  it("反向扫描有上限：超出 maxScanBytes 的信号返回 null（有界且明确 unknown，绝不卡死）", () => {
    const p = tmp("r.jsonl", "");
    appendFileSync(p, codexWorldState("gpt-5.6-luna") + "\n");
    for (let i = 0; i < 2000; i++) appendFileSync(p, JSON.stringify({ type: "event_msg", filler: "x".repeat(1000) }) + "\n");
    expect(readCodexEffectiveModel(p, 1024 * 1024)).toBeNull(); // 1MB cap; signal ~2MB deep
  });

  it("r1 构造案例：跨窗口边界的真实大小（20KB）唯一信号记录会被完整读取，不丢失", () => {
    // r1 证明旧版固定 4KB overlap 恰好会丢失这种形状（真实 world_state 记录可达约 22KB）；
    // 现在 overlap 根据被截断 fragment 定尺寸，记录大小无法击穿该机制。
    const bigRecord = JSON.stringify({
      timestamp: "t", ordinal: 4, type: "world_state",
      payload: { full: true, state: { collaboration_mode: { mode: "default", model: "gpt-5.6-luna" }, filler: "w".repeat(20_000) } },
    });
    for (const prePad of [500, 505, 510]) { // sweep the boundary so SOME run genuinely straddles
      const p = tmp("r.jsonl", "");
      for (let i = 0; i < prePad; i++) appendFileSync(p, JSON.stringify({ type: "event_msg", filler: "x".repeat(1000) }) + "\n");
      appendFileSync(p, bigRecord + "\n");
      for (let i = 0; i < 520; i++) appendFileSync(p, JSON.stringify({ type: "event_msg", filler: "x".repeat(1000) }) + "\n");
      expect(readCodexEffectiveModel(p), `prePad=${prePad}`).toBe("gpt-5.6-luna");
    }
  });

  it("较小的跨窗口记录仍可读取（原始 overlap 案例）", () => {
    const p = tmp("r.jsonl", "");
    for (let i = 0; i < 500; i++) appendFileSync(p, JSON.stringify({ type: "event_msg", filler: "x".repeat(1000) }) + "\n");
    appendFileSync(p, codexWorldState("gpt-5.6-luna") + "\n");
    for (let i = 0; i < 520; i++) appendFileSync(p, JSON.stringify({ type: "event_msg", filler: "x".repeat(1000) }) + "\n");
    expect(readCodexEffectiveModel(p)).toBe("gpt-5.6-luna");
  });
});

describe("readCodexEffectiveModel——宽于窗口的行", () => {
  it("r1 回归：单行宽于窗口时快速终止（整窗口步进），而非逐字节慢扫", () => {
    const p = tmp("r.jsonl", "");
    appendFileSync(p, codexWorldState("gpt-5.6-luna") + "\n");
    // 信号与 EOF 之间有一个 2MB 行（宽于 512KB 窗口）；该异常要求记录大于窗口，而非仅大于 overlap。
    appendFileSync(p, JSON.stringify({ type: "event_msg", filler: "x".repeat(2 * 1024 * 1024) }) + "\n");
    for (let i = 0; i < 300; i++) appendFileSync(p, JSON.stringify({ type: "event_msg", filler: "x".repeat(1000) }) + "\n");
    const t0 = Date.now();
    const model = readCodexEffectiveModel(p);
    const ms = Date.now() - t0;
    expect(model).toBe("gpt-5.6-luna"); // the signal beyond the giant line is still reached
    // 注意（r1）：若本测试挂起，就是回归已触发。慢扫是同步的，任何 timer（包括 vitest testTimeout）
    // 都无法中断，下方时间界限也永远到不了。本文件的 CI 卡住就是失败信号，不是基础设施抖动。
    expect(ms).toBeLessThan(2_000); // pre-fix this ground 1-byte steps (r1: >30s on a real 6MB file)
  });
});

describe("readTailLines", () => {
  it("读取从文件中部开始时丢弃可能被截断的首行", () => {
    const p = tmp("f.txt", "aaaa\nbbbb\ncccc\n");
    const lines = readTailLines(p, 7); // lands mid-"bbbb"
    expect(lines).not.toContain("aaaa");
    expect(lines).toContain("cccc");
  });
});
