import { describe, it, expect, afterEach } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SLOW_OUTPUT_CHUNKS } from "../src/adapters/stub-runner.js";
import type { StubScript } from "../src/adapters/stub-script.js";

// Slice 51-01 第 6–8 项——slow_output 的真实 spawn 可观测性：已接线的 runner 会把
// 确定性的多段 chunk 序列渲染到真实 pane（与生产一致的“节奏化输出”可观测行为；orch
// 裁定为确定性分块，不依赖 wall-clock）。密闭 executor 测试已经证明分派；这里确认真实进程
// 会把 chunk 输出到 stdout，从而补上此路径中“内存测试掩盖真实 spawn”的缺口。

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "../src/adapters/stub-runner.ts");
const SEAT = "dev-worker@slow-output-e2e";

async function waitFor(pred: () => boolean, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`条件未在 ${timeoutMs}ms 内满足`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("stub-runner slow_output（真实 spawn 可观测性）", () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;
  afterEach(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("按顺序把完整的确定性 chunk 序列渲染到 pane", async () => {
    dir = mkdtempSync(join(tmpdir(), "slow-output-e2e-"));
    mkdirSync(join(dir, ".openrig", "stub"), { recursive: true });
    const script: StubScript = { steps: [{ kind: "emit", behavior: "slow_output" }] };
    writeFileSync(join(dir, ".openrig", "stub", "script.json"), JSON.stringify(script), "utf8");

    let pane = "";
    child = execFile("node", ["--import", "tsx", RUNNER,
      "--session-name", SEAT, "--cwd", dir, "--launch-id", "slow-1", "--posture", "floor"],
      { env: { ...process.env, OPENRIG_HOME: join(dir, ".openrig") } as NodeJS.ProcessEnv });
    child.stdout?.on("data", (d) => { pane += String(d); });

    // 等待最后一个 chunk 完成渲染，以证明整个序列都到达 pane。
    await waitFor(() => pane.includes(`slow_output 分块 ${SLOW_OUTPUT_CHUNKS}/${SLOW_OUTPUT_CHUNKS}`));

    const indices = Array.from({ length: SLOW_OUTPUT_CHUNKS }, (_, i) =>
      pane.indexOf(`slow_output 分块 ${i + 1}/${SLOW_OUTPUT_CHUNKS}`));
    for (const idx of indices) expect(idx).toBeGreaterThanOrEqual(0); // 每个 chunk 都存在。
    // 在真实 pane transcript 中按升序出现。
    for (let i = 1; i < indices.length; i++) expect(indices[i]).toBeGreaterThan(indices[i - 1]!);
  }, 30_000);
});
