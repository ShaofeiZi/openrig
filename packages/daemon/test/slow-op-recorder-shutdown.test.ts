import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-slow-op-shutdown-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function loadIndex(): Promise<Record<string, any>> {
  return import("../src/index.js");
}
async function loadRecorder(): Promise<Record<string, any>> {
  return import("../src/domain/slow-op-recorder.js");
}
async function readRecords(logPath: string): Promise<Array<Record<string, unknown>>> {
  const text = await fs.promises.readFile(logPath, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("drainSlowOpRecorderOnShutdown — bounded shutdown drain", () => {
  it("真实记录器干净排空时返回退出码 0 并持久化排队记录", async () => {
    const { drainSlowOpRecorderOnShutdown } = await loadIndex();
    const { SlowOpRecorder } = await loadRecorder();
    const logPath = path.join(tempDir(), "drain.jsonl");
    const recorder = new SlowOpRecorder({ logPath });
    recorder.recordMeasurement("test.drain.a", 300);
    recorder.recordMeasurement("test.drain.b", 300);
  // 宽松的显式边界：排空本身干净，但在 vitest 高并发下记录器 Worker 往返可能得不到调度；
  // 此处断言干净排空成功，而非墙上时间预算（生产仍使用 5 秒默认值）。下方 close 挂起测试
  // 证明边界本身会触发。
    const code = await drainSlowOpRecorderOnShutdown(recorder, { timeoutMs: 20_000 });
    expect(code).toBe(0);
    const records = await readRecords(logPath);
    expect(records.map((r) => r.site)).toEqual(["test.drain.a", "test.drain.b"]);
  }, 30_000);

  it("未接入记录器时返回 0", async () => {
    const { drainSlowOpRecorderOnShutdown } = await loadIndex();
    expect(await drainSlowOpRecorderOnShutdown(undefined)).toBe(0);
  });

  it("排空被拒绝（持久性未证明）时返回非零并记录日志", async () => {
    const { drainSlowOpRecorderOnShutdown } = await loadIndex();
    const logs: string[] = [];
    const recorder = { close: async () => { throw new Error("terminal drain failure"); } };
    const code = await drainSlowOpRecorderOnShutdown(recorder, { log: (m: string) => logs.push(m) });
    expect(code).toBe(1);
    expect(logs.join(" ")).toMatch(/slow-operation/);
  });

  it("记录器确认写入丢失（持久性不干净）时返回非零并记录日志", async () => {
    const { drainSlowOpRecorderOnShutdown } = await loadIndex();
    const { SlowOpRecorder } = await loadRecorder();
  // 确定性的真实 Worker ok:false——日志父路径是普通文件（ENOTDIR）。
    const dir = tempDir();
    const notADir = path.join(dir, "regular-file");
    fs.writeFileSync(notADir, "x");
    const recorder = new SlowOpRecorder({ logPath: path.join(notADir, "slow-operations.jsonl") });
    recorder.recordMeasurement("test.write.fail", 300);
    const logs: string[] = [];
    const code = await drainSlowOpRecorderOnShutdown(recorder, { timeoutMs: 20_000, log: (m: string) => logs.push(m) });
    expect(code).toBe(1);
    expect(logs.join(" ")).toMatch(/slow-operation/);
  }, 30_000);

  it("将假值 Promise rejection 视为失败（记录日志并返回非零），不静默成功", async () => {
    const { drainSlowOpRecorderOnShutdown } = await loadIndex();
    for (const value of [undefined, null, false, 0, ""]) {
      const logs: string[] = [];
      const recorder = { close: () => Promise.reject(value) };
      const code = await drainSlowOpRecorderOnShutdown(recorder, { log: (m: string) => logs.push(m) });
      expect(code, `rejection with ${JSON.stringify(value)} must be a failure`).toBe(1);
      expect(logs.join(" ")).toMatch(/slow-operation/);
    }
  });

  it("保持有界：排空挂起时在超时内返回非零", async () => {
    const { drainSlowOpRecorderOnShutdown } = await loadIndex();
    const logs: string[] = [];
    const recorder = { close: () => new Promise<void>(() => {}) }; // never resolves
    const started = process.hrtime.bigint();
    const code = await drainSlowOpRecorderOnShutdown(recorder, { timeoutMs: 50, log: (m: string) => logs.push(m) });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(code).toBe(1);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(logs.join(" ")).toMatch(/slow-operation/);
  });

  it("真实 SIGINT 经过实际 startServer 关闭处理器，排空后以 0 退出", async () => {
  // 直接运行生产入口（isDirectRun → startServer()）；它在 index.ts 注册真实 SIGINT 处理器，
  // 并构建真实文件记录器。真实信号经过该处理器而非测试处理器，干净排空必须以 0 退出。
    const home = tempDir();
    const port = await getFreePort();
    const indexPath = path.resolve(import.meta.dirname, "../src/index.ts");
    const child = spawn(process.execPath, ["--import", "tsx", indexPath], {
      env: {
        ...process.env,
        OPENRIG_NO_KERNEL: "1",
        OPENRIG_HOME: home,
        OPENRIG_DB: path.join(home, "openrig.sqlite"),
        OPENRIG_PORT: String(port),
        OPENRIG_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (c: string) => { stderr += c; });
    try {
      await waitForHealthz(port, child, () => stderr);
      child.kill("SIGINT");
      const [code] = (await once(child, "exit")) as [number | null];
      expect(code, `daemon should exit 0 after a clean drain; stderr=${stderr}`).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 30_000);

  it("无其他引用句柄时仍保持有界：close 挂起会记录日志并以非零退出", async () => {
  // 没有 setInterval，也没有 server；唯一可让进程保持存活并执行边界的是排空自身的已引用
  // 超时计时器。若计时器被 unref，进程会在边界触发前以 0 退出。
    const indexUrl = pathToFileURL(path.resolve(import.meta.dirname, "../src/index.ts")).href;
    const childSource = `
      const { drainSlowOpRecorderOnShutdown } = await import(process.env.INDEX_URL);
      const recorder = { close: () => new Promise(() => {}) }; // never resolves
      const code = await drainSlowOpRecorderOnShutdown(recorder, {
        timeoutMs: 150,
        log: (m) => console.error(m),
      });
      process.exit(code);
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", childSource],
      { env: { ...process.env, INDEX_URL: indexUrl }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (c: string) => { stderr += c; });
    try {
      const [code] = (await once(child, "exit")) as [number | null];
      expect(code, "a hanging close must exit nonzero within the bound").not.toBe(0);
      expect(stderr).toMatch(/slow-operation/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 20_000);
});

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealthz(port: number, child: ReturnType<typeof spawn>, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let exited = false;
  child.once("exit", () => { exited = true; });
  while (Date.now() < deadline) {
    if (exited) throw new Error(`daemon exited before ready: ${stderr()}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.status === 200) return;
    } catch {
    // 尚未启动。
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`daemon never became healthy: ${stderr()}`);
}
