import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  executeStubScript,
  resolveStubScript,
  STUB_MID_TURN_DEATH_EXIT_CODE,
  type StubRunnerIO,
} from "../src/adapters/stub-runner.js";
import { DEFAULT_STUB_SCRIPT, StubScriptError, type StubScript, type StubBehavior } from "../src/adapters/stub-script.js";
import { stubSeatScriptPath } from "../src/adapters/stub-runner-protocol.js";
import type { CompactionResult } from "../src/adapters/stub-compaction.js";
import type { RestoreResult } from "../src/adapters/stub-restore.js";

// Slice 51-01 第 6–8 项——R1：runner 的脚本执行循环与 StubRunnerIO 接缝。
//
// runner 不再只保持空闲：它会加载脚本（cwd 中由场景解析出的路径，否则使用
// DEFAULT_STUB_SCRIPT），并针对注入的 IO 接缝执行步骤（镜像 pi-runner 的 RunnerIo）：
// `say` → 一行 pane 镜像；`emit compaction` → 通过 io.fireCompaction 进入真实 precompact
// 接缝（arch R3：只触发，绝不伪造）。executor 只负责向注入接缝分派，因此可用 fake IO 做
// 密闭单元测试；真实 spawn 接线由 stub-runner-compaction e2e 另行证明。

const IDENTITY = { sessionName: "dev-worker@exec", nodeId: "exec-node" };

/** 用于记录 StubRunnerIO 接缝调用的 fake。 */
function fakeIo(): StubRunnerIO & { lines: string[]; fireCount: number; restoreCount: number; activities: Record<string, unknown>[]; died: boolean; diedCode: number | undefined } {
  const state = {
    lines: [] as string[],
    fireCount: 0,
    restoreCount: 0,
    activities: [] as Record<string, unknown>[],
    died: false,
    diedCode: undefined as number | undefined,
    mirrorLine(line: string) { this.lines.push(line); },
    fireCompaction(): CompactionResult {
      this.fireCount++;
      return { markerPath: "/fake/restore-pending/seat.json" };
    },
    fireRestore(): RestoreResult {
      this.restoreCount++;
      return {
        additionalContext: "OpenRig compaction restore packet is available for this Claude session.\n[fake restore directive]",
        markerPath: "/fake/restore-pending/seat.json",
        delivered: true,
      };
    },
    postActivity(payload: Record<string, unknown>) { this.activities.push(payload); },
    // 真实 runner 的 die() 会退出进程；fake 只记录调用，使分派可测试。
    die(code: number) { this.died = true; this.diedCode = code; },
    now() { return "2021-06-06T06:06:06.000Z"; },
  };
  return state;
}

describe("executeStubScript（通过 StubRunnerIO 接缝进行 R1 分派）", () => {
  it("把 `say` 步骤文本逐字镜像到 pane", () => {
    const io = fakeIo();
    executeStubScript({ steps: [{ kind: "say", text: "hello from the stub" }] }, io, IDENTITY);
    expect(io.lines).toContain("hello from the stub");
    expect(io.fireCount).toBe(0);
  });

  it("遇到 `emit compaction` 步骤时触发真实 compaction 接缝（绝不伪造）", () => {
    const io = fakeIo();
    executeStubScript({ steps: [{ kind: "emit", behavior: "compaction" }] }, io, IDENTITY);
    expect(io.fireCount).toBe(1);
    // runner 镜像接缝实际写入的 marker，保证可观察且诚实。
    expect(io.lines.some((l) => l.includes("/fake/restore-pending/seat.json"))).toBe(true);
  });

  it("按顺序执行多步骤脚本", () => {
    const io = fakeIo();
    executeStubScript({
      steps: [
        { kind: "say", text: "first" },
        { kind: "emit", behavior: "compaction" },
        { kind: "say", text: "third" },
      ],
    }, io, IDENTITY);
    expect(io.fireCount).toBe(1);
    expect(io.lines[0]).toBe("first");
    expect(io.lines.at(-1)).toBe("third");
  });

  it("用规范 activity event（UserPromptSubmit … Stop）界定脚本轮次，runtime=stub", () => {
    const io = fakeIo();
    executeStubScript({ steps: [{ kind: "say", text: "reply" }] }, io, IDENTITY);
    // 一份脚本就是一轮：以 UserPromptSubmit（running）开始，以 Stop（idle）结束；这是
    // 51-02 场景运行环境读取的可观察状态转换。
    expect(io.activities.at(0)).toMatchObject({
      hookEvent: "UserPromptSubmit", runtime: "stub", sessionName: IDENTITY.sessionName, nodeId: IDENTITY.nodeId,
    });
    expect(io.activities.at(-1)).toMatchObject({ hookEvent: "Stop", runtime: "stub" });
    // 每个 payload 都采用规范字段形状（occurredAt 来自注入的时钟）。
    for (const a of io.activities) {
      expect(a.occurredAt).toBe("2021-06-06T06:06:06.000Z");
      expect(a.sessionName).toBe(IDENTITY.sessionName);
    }
  });

  it("把 slow_output 模拟为确定性分块 pane 输出（节奏可观察、无真实延迟、不伪造）", () => {
    const io = fakeIo();
    executeStubScript({ steps: [{ kind: "emit", behavior: "slow_output" }] }, io, IDENTITY);
    expect(io.fireCount).toBe(0); // 不是 compaction，不触发接缝。
    // “按脚本速率输出”（PRD §4.2）确定性实现为固定的多段 chunk 序列，这是可断言的
    // 可观察信号（场景动词集没有时间断言，因此分块本身就是节奏信号）；符合 §5 与 R3。
    const chunks = io.lines.filter((l) => /slow_output 分块 \d+\/\d+/.test(l));
    expect(chunks.length).toBeGreaterThanOrEqual(2); // 多段即表示有节奏。
    // 确定性地按升序发出。
    expect(io.lines.indexOf(chunks[0]!)).toBeLessThan(io.lines.indexOf(chunks[chunks.length - 1]!));
    expect(chunks[0]).toContain("1/");
    expect(chunks[chunks.length - 1]).toContain(`${chunks.length}/${chunks.length}`);
  });

  it("模拟 mid_turn_death：轮次中途死亡，hook 停止（无 Stop）且后续步骤不运行", () => {
    const io = fakeIo();
    executeStubScript({
      steps: [
        { kind: "emit", behavior: "mid_turn_death" },
        { kind: "say", text: "SHOULD NOT RUN — the seat is dead" },
      ],
    }, io, IDENTITY);
    // 轮次已开始（UserPromptSubmit），但在完成前死亡，因此没有发出 Stop。
    const events = io.activities.map((a) => a.hookEvent);
    expect(events).toContain("UserPromptSubmit");
    expect(events).not.toContain("Stop"); // hook 已停止。
    // 进程收到死亡指令（真实 runner 会在此退出），后续步骤不会运行。
    expect(io.died).toBe(true);
    expect(io.diedCode).toBe(STUB_MID_TURN_DEATH_EXIT_CODE);
    expect(io.lines).not.toContain("SHOULD NOT RUN — the seat is dead");
  });

  it("遇到 `emit restore` 步骤时触发真实 restore 接缝并镜像注入指令（绝不伪造）", () => {
    const io = fakeIo();
    executeStubScript({ steps: [{ kind: "emit", behavior: "restore" }] }, io, IDENTITY);
    // restore reader（compaction-restore-bridge.cjs）恰好被触发一次……
    expect(io.restoreCount).toBe(1);
    // ……restore 不是 compaction，因此此路径不得触发 precompact 接缝……
    expect(io.fireCount).toBe(0);
    // ……runner 还会镜像 bridge 注入的 additionalContext restore 指令（可观察且诚实，
    // 是实际交付的上下文，绝非伪造）。
    expect(io.lines.some((l) => l.includes("OpenRig compaction restore packet is available"))).toBe(true);
  });

  it("遇到封闭行为集之外的值时明确抛错（防御性穷尽），绝不静默跳过", () => {
    // 四种预置行为均已接线；STUB_BEHAVIORS 之外的值只有绕过 parseStubScript 才能进入
    // executor，这属于编程错误，executor 必须明确失败，不能静默丢弃步骤。
    const io = fakeIo();
    expect(() => executeStubScript(
      { steps: [{ kind: "emit", behavior: "totally-unknown" as unknown as StubBehavior }] }, io, IDENTITY,
    )).toThrow();
  });
});

describe("resolveStubScript（优先使用 cwd 中场景解析出的路径，否则使用内置默认值）", () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "stub-resolve-")); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  const fsLike = () => ({
    readFile: (p: string) => readFileSync(p, "utf8"),
    exists: (p: string) => existsSync(p),
  });

  it("cwd 中没有场景脚本时返回 DEFAULT_STUB_SCRIPT", () => {
    expect(resolveStubScript(cwd, fsLike())).toEqual(DEFAULT_STUB_SCRIPT);
  });

  it("存在 <cwd>/.openrig/stub/script.json 时解析场景脚本", () => {
    const scriptPath = stubSeatScriptPath(cwd);
    mkdirSync(join(cwd, ".openrig", "stub"), { recursive: true });
    const script: StubScript = { steps: [{ kind: "emit", behavior: "compaction" }] };
    writeFileSync(scriptPath, JSON.stringify(script), "utf8");
    expect(resolveStubScript(cwd, fsLike())).toEqual(script);
  });

  it("场景脚本格式错误时明确失败，绝不静默回退到默认值", () => {
    const scriptPath = stubSeatScriptPath(cwd);
    mkdirSync(join(cwd, ".openrig", "stub"), { recursive: true });
    writeFileSync(scriptPath, "{not json", "utf8");
    expect(() => resolveStubScript(cwd, fsLike())).toThrow(StubScriptError);
  });
});
