import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fireCompaction, StubCompactionError } from "../src/adapters/stub-compaction.js";

// Slice 51-01 items 6-8——stub COMPACTION 行为触发准确的已发布接缝。
//
// PRD §4.3/§4.4（arch R3）：stub 不伪造 compaction output——它触发真实 precompact-hook.mjs，
// 后者写入按 seat 为 key 的 restore-pending marker，再由真实 compaction-restore-bridge 投递。
// 这是与生产环境一致的 observable：磁盘上以 seat 为 key 的真实 marker，在注入 clock 下保持确定。
// runner（真实 spawn caller）在 `emit compaction` step 上调用 fireCompaction。
//
// 这些测试使用隔离 OPENRIG_HOME + 受控 transcript 启动真实随附 hook（class-fix floor），使 packet
// 与 stamp 保持确定。

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = resolve(
  HERE, "..", "assets", "plugins", "openrig-core",
  "skills", "claude-compaction-restore", "scripts", "precompact-hook.mjs",
);
const SEAT = "dev-worker@compaction-scn";
const INJECTED_ISO = "2021-06-06T06:06:06.000Z";

function writeFixtureJsonl(dir: string): string {
  const p = join(dir, "transcript.jsonl");
  writeFileSync(p, `${JSON.stringify({
    sessionId: "fixture-sess",
    cwd: dir,
    message: { role: "user", content: "hello from the compaction fixture" },
  })}\n`, "utf8");
  return p;
}

describe("stub compaction 行为触发真实 precompact 接缝", () => {
  let tmpDir: string;
  let openrigHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "stub-compaction-"));
    openrigHome = join(tmpDir, ".openrig");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("写入真实且以 seat 为 key 的 restore-pending marker（绝非伪造 output）", () => {
    const jsonl = writeFixtureJsonl(tmpDir);
    const result = fireCompaction({
      hookScriptPath: HOOK_SCRIPT,
      sessionName: SEAT,
      openrigHome,
      cwd: tmpDir,
      transcriptPath: jsonl,
    });
    expect(existsSync(result.markerPath)).toBe(true);
    // 位于随附 restore-pending 目录下，以此 seat（已 sanitize）为 key。
    expect(result.markerPath).toBe(join(openrigHome, "compaction", "restore-pending", `${SEAT}.json`));
    const marker = JSON.parse(readFileSync(result.markerPath, "utf8"));
    expect(marker.sessionName).toBe(SEAT);
    // 真实接缝生成的 packet 确实存在（restore-from-jsonl 已运行）。
    expect(existsSync(marker.outputDir)).toBe(true);
  });

  it("在注入 clock 下保持确定（两次运行的 stamp 字节级一致）", () => {
    const readStamps = (): { createdAt: unknown; outStamp: string | undefined } => {
      const dir = mkdtempSync(join(tmpdir(), "stub-compaction-det-"));
      const home = join(dir, ".openrig");
      const jsonl = writeFixtureJsonl(dir);
      const result = fireCompaction({
        hookScriptPath: HOOK_SCRIPT, sessionName: SEAT, openrigHome: home, cwd: dir,
        transcriptPath: jsonl, injectClockNow: INJECTED_ISO,
      });
      const marker = JSON.parse(readFileSync(result.markerPath, "utf8"));
      const out = { createdAt: marker.createdAt, outStamp: String(marker.outputDir).split("/").pop() };
      rmSync(dir, { recursive: true, force: true });
      return out;
    };
    const a = readStamps();
    const b = readStamps();
    expect(a).toEqual(b);
    expect(a.createdAt).toBe(INJECTED_ISO);
    expect(String(a.outStamp)).toContain(INJECTED_ISO.replace(/[:.]/g, "-"));
  });

  it("随附 hook script 缺失时快速失败（HIGH-6 existence contract，绝不静默跳过）", () => {
    expect(() => fireCompaction({
      hookScriptPath: join(tmpDir, "no-such-precompact-hook.mjs"),
      sessionName: SEAT,
      openrigHome,
      cwd: tmpDir,
    })).toThrow(StubCompactionError);
  });
});
