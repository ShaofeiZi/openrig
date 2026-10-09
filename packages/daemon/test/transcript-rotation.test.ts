// V1 预发布 CLI/后台服务第 1 项——transcript 轮转契约。
//
// 覆盖替代旧版 pipe-pane 无限增长文件模式的新 capture-pane 周期覆盖机制。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  startTranscriptRotation,
  stopTranscriptRotation,
  getActiveRotationCount,
  getLastCaptureAt,
  getTranscriptRotationOptionsFromEnv,
  clearAllTranscriptRotationsForTest,
  DEFAULT_TRANSCRIPT_LINES,
  DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS,
} from "../src/domain/transcript-rotation.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

interface FakeAdapter {
  capturePaneContent: ReturnType<typeof vi.fn>;
  /** TmuxAdapter 其余部分不被轮转使用；在调用点做类型转换。 */
}

function makeFakeAdapter(captureValue: string | null = "captured-content"): FakeAdapter {
  return {
    capturePaneContent: vi.fn(async () => captureValue),
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-rotation-"));
});

afterEach(() => {
  clearAllTranscriptRotationsForTest();
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  // 清除各测试设置的环境变量覆盖值。
  delete process.env.OPENRIG_TRANSCRIPTS_LINES;
  delete process.env.OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS;
});

describe("startTranscriptRotation——capture-pane 调用契约", () => {
  it("首个 tick 使用 sessionName + lines 调用 tmuxAdapter.capturePaneContent", async () => {
    const adapter = makeFakeAdapter("hello\nworld\n");
    const outputPath = path.join(tmpDir, "rig", "session.log");
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 500, pollIntervalMs: 60_000 },
    );
    // 首个 tick 异步执行；等待 microtask 排空。
    await new Promise((r) => setImmediate(r));
    expect(adapter.capturePaneContent).toHaveBeenCalledWith("session@rig", 500);
    stopTranscriptRotation("session@rig");
  });

  it("把 capture 内容原子写入输出路径", async () => {
    const adapter = makeFakeAdapter("line1\nline2\nline3\n");
    const outputPath = path.join(tmpDir, "rig", "session.log");
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    await new Promise((r) => setImmediate(r));
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.readFileSync(outputPath, "utf8")).toBe("line1\nline2\nline3\n");
    // rename 后不得残留部分写入的临时文件。
    const dirEntries = fs.readdirSync(path.dirname(outputPath));
    expect(dirEntries.filter((e) => e.includes(".tmp."))).toEqual([]);
    stopTranscriptRotation("session@rig");
  });

  it("每个 tick 覆盖文件而非追加（大小有界）", async () => {
    const adapter = makeFakeAdapter("first-tick");
    const outputPath = path.join(tmpDir, "rig", "session.log");
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    await new Promise((r) => setImmediate(r));
    // 替换 adapter 返回值并触发新的 start（幂等替换）；重写路径必须替换而非追加。
    adapter.capturePaneContent.mockResolvedValueOnce("second-tick");
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    await new Promise((r) => setImmediate(r));
    // 文件只包含第二个 tick 的内容，不拼接第一与第二次结果。
    expect(fs.readFileSync(outputPath, "utf8")).toBe("second-tick");
    stopTranscriptRotation("session@rig");
  });

  it("capturePaneContent 返回 null 时静默跳过写入", async () => {
    const adapter = makeFakeAdapter(null);
    const outputPath = path.join(tmpDir, "rig", "session.log");
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    await new Promise((r) => setImmediate(r));
    expect(fs.existsSync(outputPath)).toBe(false);
    stopTranscriptRotation("session@rig");
  });
});

describe("startTranscriptRotation——抑制未变化内容写入（hotfix qitem-20260822222746-3a64ae43）", () => {
  // 每 2 秒的 tick 曾无条件重写 transcript 文件；数百实时席位下，macOS 会通过 fseventsd 放大
  // 每次 rename，造成主机 CPU/RSS 风暴。两次逐字节相同的 capture 不得再次临时写入/rename。
  // 通过 inode 稳定性观测：原子 rename 会替换 inode，因此 inode 不变证明没有重写，无需 mock fs。
  it("连续两次 capture 逐字节相同时不临时写入/rename（inode 稳定）", async () => {
    const adapter = makeFakeAdapter("stable-1\nstable-2\n");
    const outputPath = path.join(tmpDir, "rig", "session.log");

    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    await new Promise((r) => setImmediate(r));
    expect(fs.readFileSync(outputPath, "utf8")).toBe("stable-1\nstable-2\n");
    const inoAfterFirst = fs.statSync(outputPath).ino;

    // 紧接的第二 tick capture 相同内容（幂等替换）。
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    await new Promise((r) => setImmediate(r));

    // 有界输出得到保留……
    expect(fs.readFileSync(outputPath, "utf8")).toBe("stable-1\nstable-2\n");
    // ……且未发生第二次临时写入/rename（inode 不变，无临时文件残留）。
    expect(fs.statSync(outputPath).ino).toBe(inoAfterFirst);
    expect(
      fs.readdirSync(path.dirname(outputPath)).filter((e) => e.includes(".tmp.")),
    ).toEqual([]);

    stopTranscriptRotation("session@rig");
  });

  it("capture 内容确实变化时仍会重写（不过度抑制）", async () => {
    const adapter = makeFakeAdapter("first\n");
    const outputPath = path.join(tmpDir, "rig", "session.log");
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    await new Promise((r) => setImmediate(r));
    const inoAfterFirst = fs.statSync(outputPath).ino;

    adapter.capturePaneContent.mockResolvedValue("second\n");
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    await new Promise((r) => setImmediate(r));

    expect(fs.readFileSync(outputPath, "utf8")).toBe("second\n");
    expect(fs.statSync(outputPath).ino).not.toBe(inoAfterFirst);
    stopTranscriptRotation("session@rig");
  });

  it("抑制未变化重写时保留 SESSION BOUNDARY header", async () => {
    const adapter = makeFakeAdapter("scrollback-A\n");
    const outputPath = path.join(tmpDir, "rig", "session.log");
    // Restore orchestrator 在启动前写入 boundary 行。
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, "--- SESSION BOUNDARY: 2026-08-22 restore\n");

    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    await new Promise((r) => setImmediate(r));
    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "--- SESSION BOUNDARY: 2026-08-22 restore\nscrollback-A\n",
    );
    const inoAfterFirst = fs.statSync(outputPath).ino;

    // 第二 tick 相同：boundary + body 逐字节一致 → 抑制。
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    await new Promise((r) => setImmediate(r));
    expect(fs.readFileSync(outputPath, "utf8")).toBe(
      "--- SESSION BOUNDARY: 2026-08-22 restore\nscrollback-A\n",
    );
    expect(fs.statSync(outputPath).ino).toBe(inoAfterFirst);
    stopTranscriptRotation("session@rig");
  });
});

describe("startTranscriptRotation——timer 生命周期", () => {
  it("每个会话只登记一个活动 timer，第二次 start 会替换", () => {
    const adapter = makeFakeAdapter();
    const outputPath = path.join(tmpDir, "rig", "session.log");
    expect(getActiveRotationCount()).toBe(0);
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    expect(getActiveRotationCount()).toBe(1);
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "session@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    expect(getActiveRotationCount()).toBe(1);
    stopTranscriptRotation("session@rig");
    expect(getActiveRotationCount()).toBe(0);
  });

  it("未登记 timer 时 stopTranscriptRotation 是安全 no-op", () => {
    expect(getActiveRotationCount()).toBe(0);
    stopTranscriptRotation("never-started@rig");
    expect(getActiveRotationCount()).toBe(0);
  });

  it("为不同会话分别跟踪 timer", () => {
    const adapter = makeFakeAdapter();
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "a@rig",
      path.join(tmpDir, "a.log"),
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "b@rig",
      path.join(tmpDir, "b.log"),
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    expect(getActiveRotationCount()).toBe(2);
    stopTranscriptRotation("a@rig");
    expect(getActiveRotationCount()).toBe(1);
    stopTranscriptRotation("b@rig");
    expect(getActiveRotationCount()).toBe(0);
  });
});

describe("getTranscriptRotationOptionsFromEnv——env 覆盖 + 默认值", () => {
  it("未设置环境变量时返回文档化默认值", () => {
    const opts = getTranscriptRotationOptionsFromEnv();
    expect(opts.lines).toBe(DEFAULT_TRANSCRIPT_LINES);
    expect(opts.pollIntervalMs).toBe(DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS);
    expect(opts.lines).toBe(1000);
    expect(opts.pollIntervalMs).toBe(2000);
  });

  it("遵循 OPENRIG_TRANSCRIPTS_LINES 与 OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS 覆盖值", () => {
    process.env.OPENRIG_TRANSCRIPTS_LINES = "500";
    process.env.OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS = "5";
    const opts = getTranscriptRotationOptionsFromEnv();
    expect(opts.lines).toBe(500);
    expect(opts.pollIntervalMs).toBe(5000);
  });

  it("拒绝非正数/非数值并使用默认值", () => {
    process.env.OPENRIG_TRANSCRIPTS_LINES = "0";
    process.env.OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS = "not-a-number";
    const opts = getTranscriptRotationOptionsFromEnv();
    expect(opts.lines).toBe(DEFAULT_TRANSCRIPT_LINES);
    expect(opts.pollIntervalMs).toBe(DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS);
  });
});

describe("startTranscriptRotation——generation 守卫（r2 HIGH-2：stop 时 tick 仍在途）", () => {
  it("stop 时存在在途 tick，不会复活存活性或写入", async () => {
    let resolveCapture!: (v: string) => void;
    const deferred = new Promise<string>((res) => {
      resolveCapture = res;
    });
    const adapter = { capturePaneContent: vi.fn(() => deferred) };
    const outputPath = path.join(tmpDir, "rig", "session.log");

    startTranscriptRotation(
      adapter as unknown as TmuxAdapter,
      "s@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    // 立即执行的首个 tick 正在等待延迟 capture。
    stopTranscriptRotation("s@rig"); // invalidates the generation
    resolveCapture("late-content\n"); // capture resolves AFTER stop
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(getLastCaptureAt("s@rig")).toBeUndefined(); // no resurrection
    expect(fs.existsSync(outputPath)).toBe(false); // no write after stop
  });

  it("已替换 start 的陈旧在途 tick 不会覆盖较新的轮转", async () => {
    let resolveFirst!: (v: string) => void;
    const firstCapture = new Promise<string>((res) => {
      resolveFirst = res;
    });
    const adapterA = { capturePaneContent: vi.fn(() => firstCapture) };
    const outputPath = path.join(tmpDir, "rig", "s.log");

    startTranscriptRotation(
      adapterA as unknown as TmuxAdapter,
      "s@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    // 首个 tick 在途；用 capture 立即完成的新 start 替换。
    const adapterB = { capturePaneContent: vi.fn(async () => "new-gen\n") };
    startTranscriptRotation(
      adapterB as unknown as TmuxAdapter,
      "s@rig",
      outputPath,
      { lines: 1000, pollIntervalMs: 60_000 },
    );
    await new Promise((r) => setImmediate(r));
    expect(getLastCaptureAt("s@rig")).toBeDefined();
    expect(fs.readFileSync(outputPath, "utf8")).toBe("new-gen\n");

    // 现在完成 A 的陈旧 capture；它不得覆盖 B 的文件或记录。
    resolveFirst("old-gen\n");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(fs.readFileSync(outputPath, "utf8")).toBe("new-gen\n");

    stopTranscriptRotation("s@rig");
  });
});
