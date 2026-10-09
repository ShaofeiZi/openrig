import { describe, it, expect, afterEach } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STUB_MID_TURN_DEATH_EXIT_CODE } from "../src/adapters/stub-runner.js";
import type { StubScript } from "../src/adapters/stub-script.js";

// Slice 51-01 条目 6-8——mid_turn_death 真实进程可观察性：已接线 runner 确实在轮次中途死亡。
// 与生产一致且可靠的死亡信号如下：activity POST 为发后即忘，process.exit 可能截断在途请求，
// 这符合真实情况，因为进程死亡确实会丢失在途 hook。进程以死亡码退出；同步记录 exited
// sidecar，使后台服务不会把过期 ready 错标为绿色；hooks 停止，因此绝不发送 Stop。隔离的
// 执行器测试确定性证明无 Stop / halt 派发，关闭“内存实现掩盖真实进程启动”的缺口。

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "../src/adapters/stub-runner.ts");
const SEAT = "dev-worker@death-e2e";

describe("stub-runner mid_turn_death（真实进程死亡）", () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;
  let server: Server | undefined;
  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child = undefined;
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("以死亡码退出、记录 exited sidecar，且绝不发送 Stop", async () => {
    dir = mkdtempSync(join(tmpdir(), "death-e2e-"));
    const home = join(dir, ".openrig");
    mkdirSync(join(dir, ".openrig", "stub"), { recursive: true });
    const script: StubScript = { steps: [{ kind: "emit", behavior: "mid_turn_death" }, { kind: "say", text: "unreachable" }] };
    writeFileSync(join(dir, ".openrig", "stub", "script.json"), JSON.stringify(script), "utf8");

    const events: string[] = [];
    server = createServer((req, res) => {
      let raw = ""; req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try { events.push(String((JSON.parse(raw) as Record<string, unknown>).hookEvent)); } catch { /* 忽略无效测试事件。 */ }
        res.writeHead(200); res.end("{}");
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server!.address() as { port: number }).port;

    const exitCode = await new Promise<number | null>((resolvePromise) => {
      child = execFile("node", ["--import", "tsx", RUNNER,
        "--session-name", SEAT, "--cwd", dir, "--launch-id", "death-1", "--posture", "floor"],
        { env: { ...process.env, OPENRIG_HOME: home, OPENRIG_URL: `http://127.0.0.1:${port}`, OPENRIG_ACTIVITY_HOOK_TOKEN: "t" } as NodeJS.ProcessEnv });
      child.on("exit", (code) => resolvePromise(code));
    });

    // 进程确实以死亡码退出。
    expect(exitCode).toBe(STUB_MID_TURN_DEATH_EXIT_CODE);
    // exited sidecar 已同步记录，后台服务不会把死亡席位错误标绿。
    const sidecar = JSON.parse(readFileSync(join(dir, ".openrig", "stub", "state.json"), "utf8"));
    expect(sidecar.ready).toBe(false);
    expect(sidecar.exited?.code).toBe(STUB_MID_TURN_DEATH_EXIT_CODE);
    // Hooks 已停止：绝不发送 Stop；宽限期已过，进程已退出。
    await new Promise((r) => setTimeout(r, 200));
    expect(events).not.toContain("Stop");
  }, 30_000);
});
