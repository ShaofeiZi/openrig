// OPR.0.5.9.13——任何按名称索引的指针或转录新旧信号都不是占用者身份。应通过绑定
// 以及已验证的 pane/进程解析规范的当前代。

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  paneClaudeSessionIdArgument,
  resolveIdentityVerifiedClaudeRecord,
  resolveLiveCodexThreadId,
  type ProcessRow,
} from "../src/domain/model-divergence/current-generation-record.js";

describe("resolveIdentityVerifiedClaudeRecord——规范的占用者身份", () => {
  const canonicalId = "f16594c5-179a-4be7-bf5e-fd759b2b87a3";
  const reserveId = "9e1ac0df-505a-4050-857b-a494b46dabc6";
  const bootAt = "2026-09-04T02:00:00.000Z";
  const canonicalSession = "orch-advisor@v-openrig-build";
  const processes: ProcessRow[] = [
    { pid: 10, ppid: 1, command: "-zsh" },
    { pid: 20, ppid: 10, command: `claude --model claude-fable-5-1 --resume ${canonicalId} --name ${canonicalSession}` },
    { pid: 30, ppid: 1, command: "-zsh" },
    { pid: 40, ppid: 30, command: `claude --model claude-fable-5 --resume ${reserveId} --name ${canonicalSession}` },
  ];

  function input(transcriptPath: string) {
    return {
      sessionName: canonicalSession,
      generation: "generation-current",
      occupantBootAt: bootAt,
      binding: { tmuxSession: canonicalSession, tmuxPane: "%156" },
      identity: {
        verdict: "verified",
        sessionName: canonicalSession,
        observedAt: "2026-09-04T02:30:00.000Z",
        evidence: { registeredPane: "%156", observedPid: 10 },
      },
      sidecar: {
        session_id: canonicalId,
        session_name: canonicalSession,
        transcript_path: transcriptPath,
        sampled_at: "2026-09-04T02:31:00.000Z",
      },
    } as const;
  }

  it("保留的别名候选继续推进时，以已验证的规范 pane 为准", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openrig-current-occupant-"));
    try {
      const canonicalPath = join(dir, `${canonicalId}.jsonl`);
      const reservePath = join(dir, `${reserveId}.jsonl`);
      writeFileSync(canonicalPath, '{"model":"claude-fable-5-1"}\n');
      writeFileSync(reservePath, '{"model":"claude-opus-5"}\n');
      utimesSync(canonicalPath, new Date("2026-09-04T02:20:00Z"), new Date("2026-09-04T02:20:00Z"));
      utimesSync(reservePath, new Date("2026-09-04T02:40:00Z"), new Date("2026-09-04T02:40:00Z"));

      const base = input(reservePath);
      const out = await resolveIdentityVerifiedClaudeRecord(
        {
          ...base,
          sidecar: {
            ...base.sidecar,
            session_id: reserveId,
            occupant_generation: "generation-retained-predecessor",
          },
        },
        {
          getPanePid: async (target) => target === "%156" ? 10 : null,
          listProcesses: async () => processes,
          readThreadIdByPid: () => undefined,
        },
        (path) => { try { return statSync(path).isFile(); } catch { return false; } },
      );

      expect(out).toEqual({
        ok: true,
        id: canonicalId,
        path: canonicalPath,
        source: "verified-pane-argument",
      });
      expect(statSync(reservePath).mtimeMs).toBeGreaterThan(statSync(canonicalPath).mtimeMs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pane 身份缺失、过期、变化或有歧义时给出明确结果，绝不按转录新旧选择", async () => {
    const readable = () => true;
    const base = input(`/tmp/${canonicalId}.jsonl`);
    const cases = [
      { value: { ...base, generation: null }, reason: "当前占用者代次未知" },
      { value: { ...base, identity: null }, reason: "没有已验证窗格身份" },
      { value: { ...base, identity: { ...base.identity, observedAt: "2026-09-04T01:59:59.000Z" } }, reason: "早于占用者代次" },
      { value: { ...base, identity: { ...base.identity, evidence: { ...base.identity.evidence, registeredPane: "%6" } } }, reason: "登记的窗格与绑定" },
    ];
    for (const testCase of cases) {
      const out = await resolveIdentityVerifiedClaudeRecord(testCase.value, {
        getPanePid: async () => 10,
        listProcesses: async () => processes,
        readThreadIdByPid: () => undefined,
      }, readable);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toContain(testCase.reason);
    }

    const changed = await resolveIdentityVerifiedClaudeRecord(base, {
      getPanePid: async () => 999,
      listProcesses: async () => processes,
      readThreadIdByPid: () => undefined,
    }, readable);
    expect(!changed.ok && changed.reason).toContain("身份验证后");

    const ambiguous = await resolveIdentityVerifiedClaudeRecord(base, {
      getPanePid: async () => 10,
      listProcesses: async () => [...processes, {
        pid: 21,
        ppid: 10,
        command: "claude --resume 11111111-1111-4111-8111-111111111111",
      }],
      readThreadIdByPid: () => undefined,
    }, readable);
    expect(!ambiguous.ok && ambiguous.reason).toContain("多个 Claude 会话 ID");
  });

  it("带代标记的 sidecar 可指明已验证占用者内的 provider rollover", async () => {
    const rolledId = "22222222-2222-4222-8222-222222222222";
    const base = input(`/tmp/${rolledId}.jsonl`);
    const out = await resolveIdentityVerifiedClaudeRecord({
      ...base,
      sidecar: { ...base.sidecar, session_id: rolledId, occupant_generation: "generation-current" },
    }, {
      getPanePid: async () => 10,
      listProcesses: async () => processes,
      readThreadIdByPid: () => undefined,
    }, () => true);
    expect(out).toMatchObject({ ok: true, id: rolledId, source: "generation-sidecar" });
  });
});

const TABLE: ProcessRow[] = [
  { pid: 10, ppid: 1, command: "-zsh" },
  { pid: 20, ppid: 10, command: "claude --permission-mode acceptEdits --session-id daaeb7b4-841b-45cb-8a33-b062e0ce8296 --name dev-planner@r" },
  { pid: 30, ppid: 10, command: "/usr/local/bin/codex --yolo resume 019f6343-aaaa-bbbb-cccc-ddddeeeeffff" },
  { pid: 40, ppid: 20, command: "node some-child" },
];

const deps = {
  getPanePid: async () => 10,
  listProcesses: async () => TABLE,
  readThreadIdByPid: (pid: number) => (pid === 30 ? "thread-live-123" : undefined),
};

describe("paneClaudeSessionIdArgument（候选来源，绝不能单独作为答案）", () => {
  it("读取启动参数中的会话 uuid（样本形态）", async () => {
    const out = await paneClaudeSessionIdArgument("dev-planner@r", deps);
    expect(out).toEqual({ ok: true, id: "daaeb7b4-841b-45cb-8a33-b062e0ce8296" });
  });

  it("没有 pane pid、Claude 进程或 id 参数时均给出具名原因，绝不静默返回 null", async () => {
    const none = await paneClaudeSessionIdArgument("s", { ...deps, getPanePid: async () => null });
    expect(!none.ok && none.reason).toContain("没有存活的窗格 PID");
    const noClaude = await paneClaudeSessionIdArgument("s", { ...deps, listProcesses: async () => [{ pid: 10, ppid: 1, command: "-zsh" }] });
    expect(!noClaude.ok && noClaude.reason).toContain("没有 Claude 进程");
    const noArg = await paneClaudeSessionIdArgument("s", { ...deps, listProcesses: async () => [{ pid: 20, ppid: 10, command: "claude --name x" }, { pid: 10, ppid: 1, command: "-zsh" }] });
    expect(!noArg.ok && noArg.reason).toContain("没有 --session-id/--resume 参数");
  });
});

describe("resolveLiveCodexThreadId", () => {
  it("通过存活 Codex pid 的日志联接，并绕过所有已存储 token", async () => {
    const out = await resolveLiveCodexThreadId("s", deps);
    expect(out).toEqual({ ok: true, id: "thread-live-123" });
  });

  it("Codex 进程的日志没有产出时给出具名原因", async () => {
    const out = await resolveLiveCodexThreadId("s", { ...deps, readThreadIdByPid: () => undefined });
    expect(!out.ok && out.reason).toContain("未解析出线程 ID");
  });
});
