import { describe, it, expect, afterEach } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StubScript } from "../src/adapters/stub-script.js";

// 切片 51-01 第 6-8 项——恢复真实启动的可观察性：已接线 runner 触发真实恢复读取器
//（compaction-restore-bridge.cjs）——架构 R3：触发，绝不伪造。先压缩再恢复的脚本通过
// 真实 precompact 接缝写入以 seat 为键的 restore-pending 标记，然后投递它：桥接器注入一条
// additionalContext 恢复指令（镜像到 pane），并在标记上写入 deliveredAt/deliveryCount=1
//（一次性，在注入时钟下结果确定）。这弥合最终行为中“内存隐藏真实启动”的缺口，并点亮
// #2 的 seat-relaunch。

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "../src/adapters/stub-runner.ts");
const SEAT = "dev-worker@restore-e2e";
const CLOCK = "2026-08-06T12:00:00.000Z";
const sanitize = (v: string) => v.replace(/[^a-zA-Z0-9_.@-]/g, "_");

async function waitFor(pred: () => boolean, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`条件未在 ${timeoutMs}ms 内满足`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("stub-runner 恢复（真实启动可观察）", () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;
  afterEach(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("先 compaction 再 restore：向 pane 投递真实 additionalContext 指令，并标记 deliveredAt（一次性）", async () => {
    dir = mkdtempSync(join(tmpdir(), "restore-e2e-"));
    const home = join(dir, ".openrig");
    mkdirSync(join(dir, ".openrig", "stub"), { recursive: true });
    // 最终行为需要一个 pending 标记：compaction（真实 precompact 接缝）写入它，
    // restore（真实桥接器）投递它——均在一个脚本轮次内。
    const script: StubScript = { steps: [{ kind: "emit", behavior: "compaction" }, { kind: "emit", behavior: "restore" }] };
    writeFileSync(join(dir, ".openrig", "stub", "script.json"), JSON.stringify(script), "utf8");

    let pane = "";
    child = execFile("node", ["--import", "tsx", RUNNER,
      "--session-name", SEAT, "--cwd", dir, "--launch-id", "restore-1", "--posture", "floor"],
      { env: { ...process.env, OPENRIG_HOME: home, OPENRIG_TEST_CLOCK_NOW: CLOCK } as NodeJS.ProcessEnv });
    child.stdout?.on("data", (d) => { pane += String(d); });

    // 等待注入的恢复指令渲染到 pane（证明真实桥接器投递了 additionalContext，
    // 而不是伪造的 stub 字符串）。
    await waitFor(() => pane.includes("此 Claude 会话已有 OpenRig 压缩恢复包可用"));

    // precompact 接缝写入的标记（以 seat 为键）已由桥接器盖章：deliveredAt 使用注入时钟，
    // deliveryCount 严格为 1（一次性）。
    const markerPath = join(home, "compaction", "restore-pending", `${sanitize(SEAT)}.json`);
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    expect(marker.deliveredAt).toBe(CLOCK);
    expect(marker.deliveryCount).toBe(1);
  }, 30_000);
});
