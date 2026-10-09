import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDaemon } from "../src/startup.js";
import { createSlowOpRequestMiddleware } from "../src/domain/slow-op-recorder.js";

const expectedSites = new Map<string, string[]>([
  ["adapters/codex-resume.ts", ["codex.resume.profile_preflight"]],
  ["adapters/codex-runtime-adapter.ts", ["codex.runtime.profile_preflight"]],
  // Codex 进程表读取已移入共享 lineage 模块；保留 site 名称。
  ["domain/native-process-lineage.ts", ["codex.runtime.list_processes"]],
  ["routes/rigspec.ts", ["rigspec.import.preflight"]],
  ["domain/bootstrap-orchestrator.ts", ["bootstrap.plan.preflight"]],
  ["domain/resume-metadata-refresher.ts", ["resume_metadata.list_processes"]],
  ["domain/codex-thread-id.ts", ["codex_thread_id.resolve_home"]],
  ["domain/review/gather.ts", ["review.gather.git"]],
  ["domain/tmux-option-defaults.ts", ["tmux_options.command_v"]],
]);

const pluginVendorUrl = "https://github.com/mvschwarz/openrig-plugins/releases/latest/download/openrig-core.tar.gz";

async function createTestDaemon(
  options: Parameters<typeof createDaemon>[0],
): Promise<Awaited<ReturnType<typeof createDaemon>>> {
  const originalFetch = globalThis.fetch;
  const fetchedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchedUrls.push(url);
    if (url !== pluginVendorUrl) throw new Error(`意外的启动 fetch：${url}`);
    return new Response(null, { status: 404 });
  };
  try {
    const daemon = await createDaemon(options);
    expect(fetchedUrls).toEqual([pluginVendorUrl]);
    return daemon;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-slow-op-"));
  tempDirs.push(dir);
  return dir;
}

async function loadRecorderModule(): Promise<Record<string, any> | null> {
  return import("../src/domain/slow-op-recorder.js").catch(() => null);
}

async function readRecords(logPath: string): Promise<Array<Record<string, unknown>>> {
  const text = await fs.promises.readFile(logPath, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("SlowOpRecorder 锁定的 instrumentation 契约", () => {
  it("固定绝对边界、轮转、文件名与敏感信息安全的记录契约", async () => {
    const mod = await loadRecorderModule();
    expect(mod, "缺少 slow-op-recorder 生产模块").not.toBeNull();
    if (!mod) return;

    expect(mod.SLOW_OPERATION_BARRIER_TIMEOUT_MS).toBe(250);
    expect(mod.SLOW_OPERATION_THRESHOLD_MS).toBe(250);
    expect(mod.SLOW_OPERATION_ROTATION_BYTES).toBe(1024 * 1024);
    expect(mod.SLOW_OPERATION_ROTATION_COUNT).toBe(3);
    expect(mod.SLOW_OPERATION_LOG_BASENAME).toBe("slow-operations.jsonl");

    const dir = tempDir();
    const logPath = path.join(dir, "slow-operations.jsonl");
    const recorder = new mod.SlowOpRecorder({ logPath });
    const secret = "OPENRIG_TEST_SECRET_DO_NOT_RECORD";
    process.env.OPENRIG_TEST_SECRET = secret;
    try {
      const value = recorder.runSync("test.sync.boundary", () => {
        const records = fs.readFileSync(logPath, "utf8");
        expect(records).toContain('"phase":"begin"');
        expect(records).toContain('"site":"test.sync.boundary"');
        return 41;
      });
      expect(value).toBe(41);
      await recorder.flush();
      const records = await readRecords(logPath);
      expect(records.map((r) => r.phase)).toEqual(["begin", "end"]);
      expect(records.every((r) => r.v === 1 && typeof r.ts === "string" && typeof r.spanId === "string")).toBe(true);
      expect(records[0]).not.toHaveProperty("durationMs");
      expect(records[0]).not.toHaveProperty("outcome");
      expect(records[1]).toMatchObject({ site: "test.sync.boundary", outcome: "ok" });
      expect(typeof records[1]!.durationMs).toBe("number");
      expect(fs.readFileSync(logPath, "utf8")).not.toContain(secret);
      expect(fs.statSync(logPath).mode & 0o777).toBe(0o600);
    } finally {
      delete process.env.OPENRIG_TEST_SECRET;
      await recorder.close();
    }
  });

  it("begin barrier 后留下持久 open span，并暴露可见失败的降级", async () => {
    const mod = await loadRecorderModule();
    expect(mod, "缺少 slow-op-recorder 生产模块").not.toBeNull();
    if (!mod) return;

    const dir = tempDir();
    const logPath = path.join(dir, "slow-operations.jsonl");
    const recorder = new mod.SlowOpRecorder({ logPath });
    const span = recorder.beginSyncSpan("test.sync.wedge");
    expect(span).toBeTruthy();
    const records = await readRecords(logPath);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ phase: "begin", site: "test.sync.wedge" });
    expect(recorder.snapshot()).toMatchObject({ healthy: true });
    await recorder.close();

    const degraded = new mod.SlowOpRecorder({
      logPath: path.join(dir, "degraded.jsonl"),
      barrierTimeoutMs: 0,
    });
    const oldNoKernel = process.env.OPENRIG_NO_KERNEL;
    process.env.OPENRIG_NO_KERNEL = "1";
    const daemon = await createTestDaemon({
      dbPath: ":memory:",
      tmuxExec: async () => "",
      cmuxExec: async () => "",
      slowOpRecorder: degraded,
    } as never);
    try {
      expect(degraded.runSync("test.sync.degraded", () => "继续")).toBe("继续");
      expect(degraded.snapshot()).toMatchObject({
        healthy: false,
        reason: "begin_barrier_timeout",
      });

      const healthResponse = await daemon.app.request("/healthz");
      expect(await healthResponse.json()).toMatchObject({
        status: "ok",
        slowOperations: {
          healthy: false,
          reason: "begin_barrier_timeout",
        },
      });
      const observations = daemon.deps.streamStore!.list();
      expect(observations).toHaveLength(1);
      expect(observations[0]!.body).toContain("begin_barrier_timeout");
      expect(observations[0]!.body).toContain("test.sync.degraded");
    } finally {
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
      await degraded.close();
      if (oldNoKernel === undefined) delete process.env.OPENRIG_NO_KERNEL;
      else process.env.OPENRIG_NO_KERNEL = oldNoKernel;
    }
  });

  it("隔离抛错的 degradation observer，使包装的工作仍可继续", async () => {
    const mod = await loadRecorderModule();
    expect(mod, "缺少 slow-op-recorder 生产模块").not.toBeNull();
    if (!mod) return;

    const recorder = new mod.SlowOpRecorder({ logPath: tempDir() });
    recorder.setDegradedHandler(() => {
      throw new Error("stream sink 失败");
    });
    let ran = false;
    try {
      const value = recorder.runSync("test.sync.observer_failure", () => {
        ran = true;
        return "继续";
      });
      expect(value).toBe("继续");
      expect(ran).toBe(true);
      expect(recorder.snapshot()).toEqual({
        healthy: false,
        reason: "begin_barrier_failed",
        site: "test.sync.observer_failure",
      });
    } finally {
      // 此 recorder 的日志路径故意不可写（强制触发上面的 begin-barrier 失败），因此 close()
      // 会针对已锁存的写入丢失持久性正确拒绝；teardown 中允许该失败。
      await recorder.close().catch(() => {});
    }
  });

  it("主线程同步阻塞被终止前持久记录 open span", async () => {
    const dir = tempDir();
    const logPath = path.join(dir, "crash.jsonl");
    fs.writeFileSync(logPath, "", { mode: 0o600 });
    const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../src/domain/slow-op-recorder.ts")).href;
    const childSource = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      import { isMainThread, threadId } from "node:worker_threads";
      for (const name of [
        "appendFileSync", "chmodSync", "fchmodSync", "fdatasyncSync", "fsyncSync",
        "ftruncateSync", "mkdirSync", "openSync", "renameSync", "rmSync", "rmdirSync",
        "truncateSync", "unlinkSync", "writeFileSync", "writeSync",
      ]) {
        fs[name] = () => { throw new Error("主线程同步 recorder I/O：" + name); };
      }
      syncBuiltinESMExports();
      const mod = await import(process.env.RECORDER_MODULE_URL);
      const recorder = new mod.SlowOpRecorder({ logPath: process.env.RECORDER_LOG_PATH });
      recorder.runSync("test.sync.crash", () => {
        process.stdout.write(JSON.stringify({ isMainThread, threadId }) + "\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      });
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childSource], {
      env: {
        ...process.env,
        RECORDER_LOG_PATH: logPath,
        RECORDER_MODULE_URL: moduleUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });

    try {
      const callbackEvidence = await new Promise<{ isMainThread: boolean; threadId: number }>((resolve, reject) => {
        let stdout = "";
        const timeout = setTimeout(() => reject(new Error(`子进程 callback 未开始：${stderr}`)), 5_000);
        child.stdout!.setEncoding("utf8");
        child.stdout!.on("data", (chunk: string) => {
          stdout += chunk;
          const newline = stdout.indexOf("\n");
          if (newline < 0) return;
          clearTimeout(timeout);
          resolve(JSON.parse(stdout.slice(0, newline)) as { isMainThread: boolean; threadId: number });
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          reject(new Error(`子进程在 callback 前退出（code=${code}）：${stderr}`));
        });
      });
      expect(callbackEvidence).toEqual({ isMainThread: true, threadId: 0 });
      child.kill("SIGKILL");
      await once(child, "exit");

      const records = await readRecords(logPath);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ phase: "begin", site: "test.sync.crash" });
      expect(records[0]).not.toHaveProperty("durationMs");
      expect(records[0]).not.toHaveProperty("outcome");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 10_000);

  it("在精确上限处轮转，并记录包含边界值的慢请求", async () => {
    const mod = await loadRecorderModule();
    expect(mod, "缺少 slow-op-recorder 生产模块").not.toBeNull();
    if (!mod) return;

    const dir = tempDir();
    const logPath = path.join(dir, "slow-operations.jsonl");
    const recorder = new mod.SlowOpRecorder({
      logPath,
      maxBytes: 512,
      rotationCount: 3,
      slowThresholdMs: 250,
    });
    for (let i = 0; i < 30; i += 1) recorder.recordMeasurement(`test.measure.${i}`, 300);
    recorder.recordRequest("GET /api/queue/:qitemId", 249);
    recorder.recordRequest("GET /api/queue/:qitemId", 250);
    await recorder.flush();
    const retained = [logPath, `${logPath}.1`, `${logPath}.2`, `${logPath}.3`];
    for (const retainedPath of retained) {
      expect(fs.existsSync(retainedPath), `${retainedPath} 应存在`).toBe(true);
      expect(fs.statSync(retainedPath).mode & 0o777).toBe(0o600);
    }
    expect(fs.existsSync(`${logPath}.4`)).toBe(false);
    const all = retained
      .filter((p) => fs.existsSync(p))
      .map((p) => fs.readFileSync(p, "utf8"))
      .join("\n");
    expect(all).toContain('"site":"request:GET /api/queue/:qitemId"');
    expect(all).not.toContain('"durationMs":249');
    expect(all).toContain('"durationMs":250');
    await recorder.close();
  });

  // request-timing 中间件契约，隔离且确定。此前的“真实 server”形式运行完整 daemon（event-loop
  // monitor + globalThis.fetch monkey-patch），在 concurrent-workspace gate 下结构性依赖环境：
  // 未匹配 route 偶尔返回 200（完整 daemon/全局变更的并发产物，并非仅做测量的 middleware）。
  // 这里直接测试抽取出的 seam，并注入 clock 使时长确定（可注入 clock 纪律，继 P6-C + VM-005
  // 后第三个实例）。“真实 server 确实使用该 middleware”的启用路径移至 startup-wiring 固定点。
  it("跨 health 与未匹配 route 组合请求计时（隔离 middleware 契约）", async () => {
    const requests: Array<{ site: string; durationMs: number }> = [];
    const recorder = { recordRequest(site: string, durationMs: number): void { requests.push({ site, durationMs }); } };
    let clock = 1000;
    const now = (): number => (clock += 5); // 每次 now() 前进 5ms → 每个请求由一个 5ms tick 包围

    const app = new Hono();
    app.use("*", createSlowOpRequestMiddleware(recorder, now));
    app.get("/healthz", (c) => c.json({ status: "ok" }));
    // 没有 /definitely-missing route → 确定返回 404（Hono 默认），绝不返回依赖负载的 200。

    expect((await app.request("/healthz?probe=1")).status).toBe(200);
    expect((await app.request("/definitely-missing?token=must-not-appear")).status).toBe(404);
    expect(requests.map((request) => request.site)).toEqual(["GET /healthz", "GET /definitely-missing"]);
    // 注入 clock 后时长确定（start + end = 一个 5ms tick），不使用真实 timer。
    expect(requests.map((request) => request.durationMs)).toEqual([5, 5]);
    // observer 只记录 site + duration，不泄漏 query 参数。
    expect(JSON.stringify(requests)).not.toContain("must-not-appear");
  });

  it("包装全部九个已接受的同步调用，不把它们移出主线程", () => {
    const srcRoot = path.resolve(import.meta.dirname, "../src");
    for (const [relativePath, sites] of expectedSites) {
      const source = fs.readFileSync(path.join(srcRoot, relativePath), "utf8");
      for (const site of sites) expect(source, `${relativePath} 缺少 ${site}`).toContain(site);
    }
  });

  it("worker 意外退出时只降级一次并释放所有 pending waiter（code 0 也算）", async () => {
    const mod = await loadRecorderModule();
    expect(mod, "缺少 slow-op-recorder 生产模块").not.toBeNull();
    if (!mod) return;

    const dir = tempDir();
    const recorder = new mod.SlowOpRecorder({ logPath: path.join(dir, "exit.jsonl") });
    let highUrgencyEmissions = 0;
    recorder.setDegradedHandler(() => { highUrgencyEmissions += 1; });
    const worker = (recorder as any).worker;
    // 阻塞 worker，使已发送记录保持 pending（没有响应到达）。
    worker.postMessage = () => {};
    const inflightFlush = recorder.flush();
    recorder.recordMeasurement("test.pending.a", 300);
    recorder.recordMeasurement("test.pending.b", 300);
    expect((recorder as any).pending.size).toBeGreaterThan(0);

    // worker 意外退出——即使退出码为 0，在打开期间也属于丢失。
    worker.emit("exit", 0);

    await expect(inflightFlush).rejects.toBeInstanceOf(mod.SlowOpRecorderTerminatedError);
    expect((recorder as any).pending.size).toBe(0);
    expect(recorder.snapshot()).toMatchObject({ healthy: false });
    // 第二次终态触发不得再次发出一次性高紧急度信号。
    worker.emit("error", new Error("second"));
    expect(highUrgencyEmissions).toBe(1);
    await recorder.close().catch(() => {});
  });

  it("让 error、messageerror 与同步 post 失败经过同一终态转换", async () => {
    const mod = await loadRecorderModule();
    if (!mod) return;
    const dir = tempDir();

    for (const trigger of ["error", "messageerror"] as const) {
      const recorder = new mod.SlowOpRecorder({ logPath: path.join(dir, `${trigger}.jsonl`) });
      (recorder as any).worker.postMessage = () => {};
      const pending = recorder.flush();
      (recorder as any).worker.emit(trigger, new Error(trigger));
      await expect(pending).rejects.toBeInstanceOf(mod.SlowOpRecorderTerminatedError);
      expect(recorder.snapshot()).toMatchObject({ healthy: false });
      await recorder.close().catch(() => {});
    }

    // 同步 worker.postMessage 失败属于相同终态转换；fire-and-forget 测量必须内部消化它
    //（不产生 unhandled rejection）。
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const recorder = new mod.SlowOpRecorder({ logPath: path.join(dir, "syncpost.jsonl") });
      (recorder as any).worker.postMessage = () => { throw new Error("向已终止 worker 发送消息"); };
      expect(() => recorder.recordMeasurement("test.syncpost", 300)).not.toThrow();
      await expect(recorder.flush()).rejects.toBeInstanceOf(mod.SlowOpRecorderTerminatedError);
      expect(recorder.snapshot()).toMatchObject({ healthy: false });
      await recorder.close().catch(() => {});
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("真实 worker 终止后，让未来 flush 有限完成并明确失败", async () => {
    const mod = await loadRecorderModule();
    if (!mod) return;
    const recorder = new mod.SlowOpRecorder({ logPath: path.join(tempDir(), "realterm.jsonl") });
    await (recorder as any).worker.terminate(); // 真实且意外（不经 close()）
    await new Promise((r) => setImmediate(r));   // 让 'exit' handler 运行
    expect(recorder.snapshot()).toMatchObject({ healthy: false });
    await expect(recorder.flush()).rejects.toBeInstanceOf(mod.SlowOpRecorderTerminatedError);
    // 即使终态失败，包装值 identity 仍是权威。
    expect(recorder.runSync("test.after.terminal", () => 7)).toBe(7);
    await expect(recorder.runStage("test.after.stage", async () => "ok")).resolves.toBe("ok");
    const boom = new Error("wrapped");
    await expect(recorder.runStage("test.after.throw", async () => { throw boom; })).rejects.toBe(boom);
    await recorder.close().catch(() => {});
  });

  it("把正常 close() 视为预期终止——无降级、无高紧急度事件", async () => {
    const mod = await loadRecorderModule();
    if (!mod) return;
    const recorder = new mod.SlowOpRecorder({ logPath: path.join(tempDir(), "normalclose.jsonl") });
    let emissions = 0;
    recorder.setDegradedHandler(() => { emissions += 1; });
    recorder.recordMeasurement("test.normal", 300);
    await recorder.close();
    expect(recorder.snapshot()).toMatchObject({ healthy: true });
    expect(emissions).toBe(0);
  });

  it("锁存已确认的 Worker 写入失败，使 flush/close 无法报告干净持久排空", async () => {
    const mod = await loadRecorderModule();
    expect(mod, "缺少 slow-op-recorder 生产模块").not.toBeNull();
    if (!mod) return;

    // 确定性触发真实 Worker append 拒绝：日志父级是普通文件，因此 Worker 的
    // mkdirSync(dirname) 以 ENOTDIR 类失败 → ok:false。
    const dir = tempDir();
    const notADir = path.join(dir, "regular-file");
    fs.writeFileSync(notADir, "x");
    const recorder = new mod.SlowOpRecorder({ logPath: path.join(notADir, "slow-operations.jsonl") });
    let emissions = 0;
    recorder.setDegradedHandler(() => { emissions += 1; });
    recorder.recordMeasurement("test.write.fail", 300);

    // 已知丢失的写入必须使排空不干净：flush 以写入失败错误拒绝（区别于 worker 终态错误）。
    await expect(recorder.flush()).rejects.toBeInstanceOf(mod.SlowOpRecorderWriteError);
    expect(recorder.snapshot()).toMatchObject({
      healthy: false,
      reason: "recorder_write_failed",
      site: "recorder.worker",
    });
    expect(emissions).toBe(1);
    // 写入失败后，包装操作 identity 仍是权威。
    expect(recorder.runSync("test.after.write", () => 7)).toBe(7);
    // close() 保留排空失败（拒绝），但仍有限完成 teardown。
    await expect(recorder.close()).rejects.toBeInstanceOf(mod.SlowOpRecorderWriteError);
    expect(emissions).toBe(1);
  });

  // 抛错 observer 绝不能替换 route 的真实 status/body（它在 finally 中隔离）。
  // 隔离且确定——相同契约，不启动完整 daemon。
  it("隔离抛错的 request observer，使 route 保持精确成功 status 与 body（隔离）", async () => {
    const recorder = { recordRequest(): void { throw new Error("request observer sink 失败"); } };
    const app = new Hono();
    app.use("*", createSlowOpRequestMiddleware(recorder, () => 0));
    app.get("/healthz", (c) => c.json({ status: "ok" }));

    const res = await app.request("/healthz");
    expect(res.status).toBe(200); // 错误在边界被消化，不暴露为 500
    expect(await res.json()).toMatchObject({ status: "ok" });
    // 即使 observer 也对此抛错，未匹配 route 仍保持精确的 404。
    expect((await app.request("/definitely-missing")).status).toBe(404);
  });

  it("通过隔离 daemon 驱动真实 tmux command-v spawnSync site", async () => {
    const mod = await loadRecorderModule();
    expect(mod, "缺少 slow-op-recorder 生产模块").not.toBeNull();
    if (!mod) return;

    const dir = tempDir();
    const logPath = path.join(dir, "slow-operations.jsonl");
    const recorder = new mod.SlowOpRecorder({ logPath });
    const oldNoKernel = process.env.OPENRIG_NO_KERNEL;
    process.env.OPENRIG_NO_KERNEL = "1";
    const daemon = await createTestDaemon({
      dbPath: ":memory:",
      tmuxExec: async () => "",
      cmuxExec: async () => "",
      slowOpRecorder: recorder,
      tmuxOptionPlatform: "linux",
    } as never);
    try {
      await daemon.deps.tmuxOptionDefaults!.applyToFreshSession("instrumentation-control");
      await recorder.flush();
      const records = await readRecords(logPath);
      expect(records.some((r) => r.site === "tmux_options.command_v" && r.phase === "end")).toBe(true);
    } finally {
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
      await recorder.close();
      if (oldNoKernel === undefined) delete process.env.OPENRIG_NO_KERNEL;
      else process.env.OPENRIG_NO_KERNEL = oldNoKernel;
    }
  });
});
