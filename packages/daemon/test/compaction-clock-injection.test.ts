// Slice 51-01 items 6-8——compaction assets 上的 A3-R3 CLOCK/STAMP 注入 seam。
//
// shipped compaction hook 脚本用 `new Date()` 在三个资产的四个站点盖 wall-clock 时间戳，
// 均不可注入：
//   * restore-from-jsonl.mjs:379   — packet output-dir 带时间戳的路径元素
//   * precompact-hook.mjs:66        — marker.createdAt（PreCompact writer）
//   * compaction-restore-bridge.cjs:145 — marker.postCompactAt（PostCompact reader）
//   * compaction-restore-bridge.cjs:154 — marker.deliveredAt（delivery reader）
//
// A5 裁决（sourcefit cbbb4903 → A3-R3）：本 slice 加一个有界可注入 clock——
// 默认真实 wall-clock（生产），共享 hermetic env 变量 OPENRIG_TEST_CLOCK_NOW 设置时确定性。
// 确定性钉死：同一注入 clock 下跑同一脚本序列两次，得到 byte 一致的 compaction-asset 时间戳
//（packet dir 路径 + 每个 marker 时间戳）。
//
// 这些测试把真实 asset 脚本作为子进程 spawn（class-fix 底线：real-spawn，绝不内存快捷——
// 与 precompact-hook.test.ts 完全一致的约定），用隔离 OPENRIG_HOME，使磁盘时间戳匹配 Claude
// 在 PreCompact/SessionStart/PostCompact 时刻观测到的内容。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSET_ROOT = resolve(HERE, "..", "assets", "plugins", "openrig-core");
const HOOK_SCRIPT = resolve(ASSET_ROOT, "skills", "claude-compaction-restore", "scripts", "precompact-hook.mjs");
const BRIDGE_SCRIPT = resolve(ASSET_ROOT, "hooks", "scripts", "compaction-restore-bridge.cjs");

// 一个独特的固定 ISO 时刻。`new Date().toISOString()` 真实 wall-clock （几乎）永远不等于它，
// 所以"时间戳等于它"的断言只有在注入 clock 被尊重时才能通过——对未开 seam 的代码是真 RED。
const INJECTED_ISO = "2021-06-06T06:06:06.000Z";
// packet-dir 时间戳是 ISO 把 ':' 和 '.' 换成 '-'（writeOutputs）。
const INJECTED_STAMP = INJECTED_ISO.replace(/[:.]/g, "-");
const SEAT = "clock-seat@kernel";

function assetEnv(openrigHome: string, injectClockNow?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENRIG_HOME: openrigHome,
    OPENRIG_SESSION_NAME: SEAT,
    RIGGED_HOME: undefined,
    // 缺席 => 生产实时回退；在场 => 确定性注入。
    OPENRIG_TEST_CLOCK_NOW: injectClockNow,
    // P6(C)：每个测试在自己的 tmp home 下拥有唯一 packet output-root，使两个并发 writer
    //（同注入 clock => 同时间戳）永不在共享 /tmp/claude-compaction-restore 路径上碰撞——
    // desk 裁决的 cross-writer flake，已杀。
    OPENRIG_COMPACTION_OUT_ROOT: join(dirname(openrigHome), "packets"),
  } as NodeJS.ProcessEnv;
}

function markerPathFor(openrigHome: string): string {
  return join(openrigHome, "compaction", "restore-pending", `${SEAT}.json`);
}

function readMarker(openrigHome: string): Record<string, unknown> {
  return JSON.parse(readFileSync(markerPathFor(openrigHome), "utf8"));
}

// 直接写 pending restore marker（仅 bridge 测试无需跑 writer）。
function seedMarker(openrigHome: string, overrides: Record<string, unknown> = {}): void {
  const p = markerPathFor(openrigHome);
  mkdirSync(dirname(p), { recursive: true });
  const data = {
    version: 1,
    createdAt: "2000-01-01T00:00:00.000Z",
    sessionName: SEAT,
    outputDir: "/tmp/claude-compaction-restore/seeded",
    expectedAck: "restored from packet at <path>; resumed at step <X>",
    deliveredAt: null,
    deliveryCount: 0,
    ...overrides,
  };
  writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

// 一份最小但真实的 Claude JSONL transcript，使 PreCompact writer 的
// restore-from-jsonl 子进程产出确定性 sessionId → 注入 clock 下确定性 packet dir。
function writeFixtureJsonl(dir: string): string {
  const p = join(dir, "transcript.jsonl");
  const line = JSON.stringify({
    sessionId: "fixture-sess",
    cwd: dir,
    message: { role: "user", content: "hello from the clock fixture" },
  });
  writeFileSync(p, `${line}\n`, "utf8");
  return p;
}

function runBridge(
  openrigHome: string,
  input: Record<string, unknown>,
  injectClockNow?: string,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [BRIDGE_SCRIPT], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: assetEnv(openrigHome, injectClockNow),
  });
  return { stdout: result.stdout || "", stderr: result.stderr || "", status: result.status };
}

function runHook(
  openrigHome: string,
  input: Record<string, unknown>,
  injectClockNow?: string,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: assetEnv(openrigHome, injectClockNow),
  });
  return { stdout: result.stdout || "", stderr: result.stderr || "", status: result.status };
}

describe("A3-R3 compaction-asset clock/stamp 注入（real-spawn）", () => {
  let tmpDir: string;
  let openrigHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "compaction-clock-"));
    openrigHome = join(tmpDir, ".openrig");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("bridge 从 OPENRIG_TEST_CLOCK_NOW 盖 marker.deliveredAt（delivery 路径）", () => {
    seedMarker(openrigHome);
    const bridge = runBridge(openrigHome, { hook_event_name: "UserPromptSubmit" }, INJECTED_ISO);
    expect(bridge.status).toBe(0);
    const marker = readMarker(openrigHome);
    expect(marker["deliveryCount"]).toBe(1);
    expect(marker["deliveredAt"]).toBe(INJECTED_ISO);
  });

  it("bridge 从 OPENRIG_TEST_CLOCK_NOW 盖 marker.postCompactAt（PostCompact 路径）", () => {
    seedMarker(openrigHome);
    const bridge = runBridge(openrigHome, { hook_event_name: "PostCompact" }, INJECTED_ISO);
    expect(bridge.status).toBe(0);
    const marker = readMarker(openrigHome);
    expect(marker["postCompactAt"]).toBe(INJECTED_ISO);
  });

  it("PreCompact writer 从注入 clock 盖 marker.createdAt + packet-dir 路径", () => {
    const jsonl = writeFixtureJsonl(tmpDir);
    const hook = runHook(openrigHome, { transcript_path: jsonl, cwd: tmpDir }, INJECTED_ISO);
    expect(hook.status).toBe(0);
    const marker = readMarker(openrigHome);
    expect(marker["createdAt"]).toBe(INJECTED_ISO);
    // packet output dir 带注入的带时间戳路径元素。
    expect(String(marker["outputDir"])).toContain(INJECTED_STAMP);
    expect(existsSync(String(marker["outputDir"]))).toBe(true);
  });

  it("确定性钉死：同 clock 下完整 writer→bridge 序列两次 → byte 一致 asset 时间戳", () => {
    const runOnce = (): { createdAt: unknown; outputDir: unknown; deliveredAt: unknown; postCompactAt: unknown } => {
      const home = join(mkdtempSync(join(tmpdir(), "compaction-clock-run-")), ".openrig");
      const jsonl = writeFixtureJsonl(dirname(home));
      expect(runHook(home, { transcript_path: jsonl, cwd: dirname(home) }, INJECTED_ISO).status).toBe(0);
      // delivery 事件携带 marker 记录的同一 transcript identity（真实
      // SessionStart/UserPromptSubmit 事件形状）。bridge 的 R5 premise 门只对匹配的
      // compaction 投递——裸、无 identity 的 payload 被（正确地）挡在 no-deliver，
      // 故要走到 deliveredAt 时间戳必须通过真实 identity。
      expect(runBridge(home, { hook_event_name: "UserPromptSubmit", transcript_path: jsonl }, INJECTED_ISO).status).toBe(0);
      expect(runBridge(home, { hook_event_name: "PostCompact" }, INJECTED_ISO).status).toBe(0);
      const m = readMarker(home);
      // 从 outputDir 中规范化掉每跑一次的临时 tmp 前缀——带时间戳的 STAMP 元素
      //（clock 派生部分）才是钉死证明确定性的对象。
      const outStamp = String(m["outputDir"]).split("/").pop();
      return { createdAt: m["createdAt"], outputDir: outStamp, deliveredAt: m["deliveredAt"], postCompactAt: m["postCompactAt"] };
    };
    const run1 = runOnce();
    const run2 = runOnce();
    expect(run1).toEqual(run2);
    // 且每个时间戳都是注入时刻，不是 wall-clock。
    expect(run1.createdAt).toBe(INJECTED_ISO);
    expect(run1.deliveredAt).toBe(INJECTED_ISO);
    expect(run1.postCompactAt).toBe(INJECTED_ISO);
    expect(String(run1.outputDir)).toContain(INJECTED_STAMP);
  });

  it("保留：缺 clock 变量 → 真实 wall-clock 时间戳（生产回退完好，绝非 sentinel）", () => {
    seedMarker(openrigHome);
    const bridge = runBridge(openrigHome, { hook_event_name: "UserPromptSubmit" });
    expect(bridge.status).toBe(0);
    const marker = readMarker(openrigHome);
    const deliveredAt = String(marker["deliveredAt"]);
    // 一个有效 ISO 时刻且不是注入 sentinel——回退已跑。
    expect(deliveredAt).not.toBe(INJECTED_ISO);
    expect(Number.isNaN(Date.parse(deliveredAt))).toBe(false);
  });
});

// P6(C)——compaction PACKET output-root 隔离 seam。shipped 脚本把 packet base 硬编码到
// 固定 /tmp/claude-compaction-restore（precompact-hook.mjs + restore-from-jsonl 子进程）。
// 注入 clock 下时间戳 STAMP 固定，故两个同 sessionId 并发 writer 落到同一
// `${sessionId}-${stamp}` 目录，竞争同一 restore-summary.json——desk 裁决的 cross-writer
// 干扰，在 fleet 负载下 flake 了套件。修复镜像可注入 clock seam：一个有界可注入 output-root
//（OPENRIG_COMPACTION_OUT_ROOT）——生产默认真实 /tmp，hermetic env 变量设置时按跑隔离，
// 使每个测试拥有唯一 outputDir。
describe("P6(C) compaction packet output-root 注入（按跑隔离）", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "compaction-outroot-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runHookWithRoot(
    openrigHome: string,
    outRoot: string,
    input: Record<string, unknown>,
  ): { stdout: string; stderr: string; status: number | null } {
    const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { ...assetEnv(openrigHome, INJECTED_ISO), OPENRIG_COMPACTION_OUT_ROOT: outRoot } as NodeJS.ProcessEnv,
    });
    return { stdout: result.stdout || "", stderr: result.stderr || "", status: result.status };
  }

  it("SEAM：hook 把 packet 写到注入的 OPENRIG_COMPACTION_OUT_ROOT 下，绝不共享 /tmp 默认", () => {
    const home = join(tmpDir, ".openrig");
    const outRoot = join(tmpDir, "packets");
    const jsonl = writeFixtureJsonl(tmpDir);
    const hook = runHookWithRoot(home, outRoot, { transcript_path: jsonl, cwd: tmpDir });
    expect(hook.status).toBe(0);
    const marker = readMarker(home);
    // 隔离两个并发 writer（同 clock => 同时间戳）在固定
    // /tmp/claude-compaction-restore 路径上碰撞。
    expect(String(marker["outputDir"]).startsWith(outRoot)).toBe(true);
    expect(String(marker["outputDir"]).startsWith("/tmp/claude-compaction-restore")).toBe(false);
    expect(existsSync(String(marker["outputDir"]))).toBe(true);
  });

  it("隔离钉死：DISTINCT root 下两个并发 writer（同注入 clock + 同 sessionId）产出独立、未损坏 packet——无共享路径碰撞", async () => {
    const mk = (tag: string) => {
      const cwd = join(tmpDir, tag);
      mkdirSync(cwd, { recursive: true });
      return { home: join(cwd, ".openrig"), outRoot: join(cwd, "packets"), cwd, jsonl: writeFixtureJsonl(cwd) };
    };
    const a = mk("w-a");
    const b = mk("w-b");
    const spawnOne = (w: ReturnType<typeof mk>): Promise<number | null> =>
      new Promise((res) => {
        const cp = spawn(process.execPath, [HOOK_SCRIPT], {
          env: { ...assetEnv(w.home, INJECTED_ISO), OPENRIG_COMPACTION_OUT_ROOT: w.outRoot } as NodeJS.ProcessEnv,
        });
        cp.stdin.end(JSON.stringify({ transcript_path: w.jsonl, cwd: w.cwd }));
        cp.on("close", (code) => res(code));
      });
    const [ca, cb] = await Promise.all([spawnOne(a), spawnOne(b)]);
    expect(ca).toBe(0);
    expect(cb).toBe(0);
    const ma = readMarker(a.home);
    const mb = readMarker(b.home);
    // 每个 marker 的 createdAt 是注入 clock，未被兄弟 writer 损坏……
    expect(ma["createdAt"]).toBe(INJECTED_ISO);
    expect(mb["createdAt"]).toBe(INJECTED_ISO);
    // ……且每个 packet 在自己的 root 下（绝不对方的，绝不共享 /tmp）……
    expect(String(ma["outputDir"]).startsWith(a.outRoot)).toBe(true);
    expect(String(mb["outputDir"]).startsWith(b.outRoot)).toBe(true);
    // ……且每个磁盘上的 restore-summary.json 完好（谁也没覆盖谁）。
    const sa = JSON.parse(readFileSync(join(String(ma["outputDir"]), "restore-summary.json"), "utf8"));
    const sb = JSON.parse(readFileSync(join(String(mb["outputDir"]), "restore-summary.json"), "utf8"));
    expect(sa.sessionId).toBe("fixture-sess");
    expect(sb.sessionId).toBe("fixture-sess");
  });
});
