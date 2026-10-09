import { describe, it, expect, afterEach } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Slice 51-01 items 6-8 — F1 keep-alive PIN (RED-first, ratified).
//
// 由 pane 承载的 stub-runner 在打印 READY 之后,必须作为该席位的存活前台进程
// 保持空闲(后台服务的存活交叉校验要求该 pane 不得回落到 shell)。
// 仅靠 `await new Promise(()=>{})` 并不能让 Node 事件循环保持存活——它没有
// 被引用的 libuv 句柄——因此该 runner 会立刻退出,导致所有 stub `up` 都无法
// 通过就绪检查。本 pin 会拉起真实的 runner,断言它在 t=5s 之后仍然存活,
// 随后在收到 SIGTERM 时干净退出。

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "../src/adapters/stub-runner.ts");

describe("stub-runner 存活检查(F1 保活 pin)", () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;
  afterEach(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("作为存活的前台进程空闲超过 t=5s,并在收到 SIGTERM 时干净退出", async () => {
    dir = mkdtempSync(join(tmpdir(), "stub-live-"));
    child = execFile("node", ["--import", "tsx", RUNNER,
      "--session-name", "dev-worker@t", "--cwd", dir, "--launch-id", "pin-1", "--posture", "floor"]);

    let exited = false;
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.on("exit", (code, signal) => { exited = true; exitInfo = { code, signal }; });

    // 此时早已越过未修复 runner(事件循环被抽干)退出的时间点(约 t=1s),它应当仍然存活。
    await new Promise((r) => setTimeout(r, 5500));
    expect(exited, "stub-runner 必须作为 pane 的前台进程保持空闲,而不是在 READY 之后退出").toBe(false);

    // 并且在收到信号时干净终止(退出路径仍然可用)。
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    expect(exited, "stub-runner 必须在收到 SIGTERM 时退出").toBe(true);
    expect(exitInfo?.code === 0 || exitInfo?.signal === "SIGTERM").toBe(true);
  }, 20_000);
});
