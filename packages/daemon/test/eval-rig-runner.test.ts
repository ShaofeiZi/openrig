// Test-A 阻断项 3 第 7 轮——入口级判别项 r2 第 6 轮 HIGH-1 要求：证明公开 runner
// 接缝（`run-evals.mjs --provider rig` 经 buildRigProviderSession）接入当前代记录读取器，
// 只提交一条自然提示并捕获当前代后缀；还要证明没有解析出记录时，权威默认读取器会
// 明确拒绝。已通过的辅助单元测试未覆盖此接缝，本测试负责覆盖。

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRigProviderSession, defaultRunnerGenerationReader } from "./helpers/eval-rig-runner.js";
import type { RigExec } from "./helpers/eval-rig-session.js";

const WHOAMI = JSON.stringify({ session: "ops-eval@evalrig", occupantGeneration: "gen-1", nodeId: "01N" });

function scriptedExec(script: (args: string[]) => string | undefined): { exec: RigExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: RigExec = async (args) => {
    calls.push(args);
    const out = script(args);
    if (out === undefined) throw new Error(`unscripted exec: ${args.join(" ")}`);
    return out;
  };
  return { exec, calls };
}

describe("run-evals --provider rig——已接线的 runner 接缝（r2 第 6 轮 HIGH-1）", () => {
  it("通过 runner 恰好提交一条自然提示，并捕获当前代后缀", async () => {
    // JSONL 形态的记录（harness 修正）：捕获过程感知 schema，并评估带终止
    // stop_reason 的智能体输出——类似 pane 的原始字符串不再视为可完成回合。
    const state = { generationId: "g1", content: '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"prior gen-1 record"}]}}\n' };
    let sent = false;
    const { exec, calls } = scriptedExec((args) => {
      if (args[0] === "whoami") return WHOAMI;
      if (args[0] === "send") { sent = true; state.content = state.content + '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"the case prompt"}]}}\n'; return "sent"; }
      return undefined;
    });
    // 用假的当前代读取器代替由 contextUsageStore 支持的默认实现：记录在多次读取间
    // 仅追加增长，随后保持静默。
    const readGenerationRecord = async () => {
      const out = { generationId: state.generationId, content: state.content };
      if (sent && !state.content.includes("DONE")) state.content = state.content + '{"type":"assistant","message":{"role":"assistant","model":"claude-x","stop_reason":"end_turn","content":[{"type":"text","text":"DONE rig context get skills/core/rig-lifecycle"}]}}\n{"type":"system","subtype":"turn_duration","isMeta":false}\n';
      return out;
    };
    const session = await buildRigProviderSession({
      seat: "ops-eval@evalrig",
      exec,
      readGenerationRecord,
      session: { pollMs: 1, stablePolls: 2, sleep: async () => {} },
    }).spawn();

    await session.sendPrompt("the case prompt");
    const since = await session.captureSince("the case prompt");

    // 只提交一次 send——自然提示（冻结的保管契约）通过 runner 接缝发出。
    const sends = calls.filter((c) => c[0] === "send");
    expect(sends).toEqual([["send", "--raw", "ops-eval@evalrig", "the case prompt"]]); // 根据 PIN 5 使用 raw——抑制信封，仍只发送一次。
    // 捕获当前代后缀（评估可看到席位回合），排除发送前内容。
    expect(since).toContain("DONE rig context get skills/core/rig-lifecycle");
    expect(since).not.toContain("prior gen-1 record");
  });

  it("席位没有当前代记录时权威默认读取器明确拒绝（不静默降级）", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-rig-runner-"));
    try {
      // <stateDir>/state/context-usage/<seat>.json 未写入 sidecar，readAndNormalize 无法解析。
      const reader = defaultRunnerGenerationReader({ stateDir });
      await expect(reader("dev-x@r")).rejects.toThrow(/no current-generation Claude conversation record|observation refused/);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("通过默认 sidecar 读取器建立会话生命周期绑定（r2 第 7 轮 HIGH-1）：用例间重新预热时只发出第一次 send", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-rig-runner-"));
    try {
      const ctxDir = path.join(stateDir, "state", "context-usage");
      fs.mkdirSync(ctxDir, { recursive: true });
      const sidecar = path.join(ctxDir, "s@r.json");
      const writeSidecar = (gen: string, jsonl: string) =>
        fs.writeFileSync(sidecar, JSON.stringify({ session_id: gen, transcript_path: jsonl, context_window: { used_percentage: 10 } }));
      const j1 = path.join(stateDir, "g1.jsonl");
      fs.writeFileSync(j1, "gen-1 prior\n");
      writeSidecar("g1", j1);
      let currentJsonl = j1;
      const { exec, calls } = scriptedExec((args) => {
        if (args[0] === "whoami") return WHOAMI;
        if (args[0] === "send") { fs.appendFileSync(currentJsonl, `{"type":"user","message":{"role":"user","content":[{"type":"text","text":${JSON.stringify(args[3])}}]}}\n{"type":"assistant","message":{"role":"assistant","model":"claude-x","stop_reason":"end_turn","content":[{"type":"text","text":"completed"}]}}\n{"type":"system","subtype":"turn_duration","isMeta":false}\n`); return "sent"; }
        return undefined;
      });
      const session = await buildRigProviderSession({ seat: "s@r", exec, stateDir, session: { pollMs: 1, stablePolls: 2, sleep: async () => {} } }).spawn();
      // 用例 1 绑定会话代 g1（通过真实的 ContextUsageStore sidecar 读取器）。
      await session.sendPrompt("case-1");
      expect(await session.captureSince("case-1")).toContain("completed");
      // 用例间的权威重新预热：席位 sidecar 现在指向 g2 和新的 JSONL。
      const j2 = path.join(stateDir, "g2.jsonl");
      fs.writeFileSync(j2, "gen-2 fresh\n");
      currentJsonl = j2;
      writeSidecar("g2", j2);
      // 用例 2 必须在 send 前拒绝——跨代运行无效。
      await expect(session.sendPrompt("case-2")).rejects.toThrow(/generation 在用例之间发生变化/);
      expect(calls.filter((c) => c[0] === "send").map((c) => c[3])).toEqual(["case-1"]); // argv：send --raw <seat> <prompt>
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("权威默认读取器将 sidecar 的会话 id 与 JSONL 解析为代记录", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-rig-runner-"));
    try {
      const jsonl = path.join(stateDir, "gen-abc.jsonl");
      fs.writeFileSync(jsonl, '{"role":"assistant","text":"rig context get skills/core/rig-lifecycle"}\n');
      const ctxDir = path.join(stateDir, "state", "context-usage");
      fs.mkdirSync(ctxDir, { recursive: true });
      // 最小 Claude 状态行 sidecar：会话 id + 转录路径（仅追加的 JSONL）。
      fs.writeFileSync(path.join(ctxDir, "dev-x@r.json"), JSON.stringify({ session_id: "gen-abc", transcript_path: jsonl, context_window: { used_percentage: 10 } }));
      const reader = defaultRunnerGenerationReader({ stateDir });
      const rec = await reader("dev-x@r");
      expect(rec.generationId).toBe("gen-abc");
      expect(rec.content).toContain("rig context get skills/core/rig-lifecycle");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
