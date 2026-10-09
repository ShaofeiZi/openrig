import { describe, it, expect, afterEach } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StubScript } from "../src/adapters/stub-script.js";

// Slice 51-01 items 6-8 —— R3:桩层完整确定性锚定。PRD §5 保证
// “桩自身行为中不含挂钟/RNG”:在同一个注入时钟下运行同一份脚本两次,
// 必须产出逐字节一致的可观测结果——窗格转录、活动事件序列、压缩素材时间戳。
// 素材时间戳本身已被锚定(compaction-clock-injection);这里锚定桩自身
// 发出的整份脚本表面,防止后续增量中任何裸 new Date()/Math.random()
// 泄漏进运行器行为。

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "../src/adapters/stub-runner.ts");
const SEAT = "dev-worker@determinism";
const INJECTED_ISO = "2021-06-06T06:06:06.000Z";
const LAUNCH_ID = "det-fixed";
const SANITIZED = SEAT.replace(/[^a-zA-Z0-9_.@-]/g, "_");

const SCRIPT: StubScript = {
  steps: [
    { kind: "say", text: "[stub] scripted turn one" },
    { kind: "emit", behavior: "compaction" },
    { kind: "say", text: "[stub] scripted turn two" },
  ],
};

interface RunResult { pane: string; events: Record<string, unknown>[]; markerCreatedAt: unknown; outStamp: string }

async function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`条件在 ${timeoutMs}ms 内未满足`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("stub-runner 完整确定性锚定(PRD §5、R3)", () => {
  const children: ChildProcess[] = [];
  const dirs: string[] = [];
  let server: Server | undefined;
  afterEach(async () => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    children.length = 0;
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  async function runOnce(port: number, sink: { run: number; body: Record<string, unknown> }[], run: number): Promise<RunResult> {
    const dir = mkdtempSync(join(tmpdir(), `stub-det-${run}-`));
    dirs.push(dir);
    const home = join(dir, ".openrig");
    mkdirSync(join(dir, ".openrig", "stub"), { recursive: true });
    writeFileSync(join(dir, ".openrig", "stub", "script.json"), JSON.stringify(SCRIPT), "utf8");

    let pane = "";
    const child = execFile("node", ["--import", "tsx", RUNNER,
      "--session-name", SEAT, "--cwd", dir, "--launch-id", LAUNCH_ID, "--posture", "floor"],
      { env: {
        ...process.env,
        OPENRIG_HOME: home,
        OPENRIG_URL: `http://127.0.0.1:${port}`,
        OPENRIG_ACTIVITY_HOOK_TOKEN: "det-token",
        OPENRIG_NODE_ID: "det-node",
        OPENRIG_TEST_CLOCK_NOW: INJECTED_ISO,
      } as NodeJS.ProcessEnv });
    children.push(child);
    child.stdout?.on("data", (d) => { pane += String(d); });

    const markerPath = join(home, "compaction", "restore-pending", `${SANITIZED}.json`);
    await waitFor(() => existsSync(markerPath));
    await waitFor(() => sink.filter((c) => c.run === run).some((c) => c.body.hookEvent === "Stop"));

    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    // 归一化每次运行产生的临时路径,使由时钟派生的内容可按字节比较。
    const paneNorm = pane.split(dir).join("<DIR>");
    return {
      pane: paneNorm,
      events: sink.filter((c) => c.run === run).map((c) => c.body),
      markerCreatedAt: marker.createdAt,
      outStamp: String(marker.outputDir).split("/").pop() ?? "",
    };
  }

  it("双次运行产出逐字节一致的窗格转录 + 活动事件序列 + 素材时间戳", async () => {
    // 各次运行顺序执行;单个 sink 把每个 POST 路由到当前正在运行的那一次。
    const sink: { run: number; body: Record<string, unknown> }[] = [];
    const live = { run: 0 };
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try { sink.push({ run: live.run, body: JSON.parse(raw) as Record<string, unknown> }); }
        catch { /* 忽略非 JSON 内容 */ }
        res.writeHead(200); res.end("{}");
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server!.address() as { port: number }).port;

    live.run = 1;
    const r1 = await runOnce(port, sink, 1);
    live.run = 2;
    const r2 = await runOnce(port, sink, 2);

    // (1) 窗格转录逐字节一致(已归一化每次运行的临时路径)。
    expect(r1.pane).toBe(r2.pane);
    expect(r1.pane).toContain("[stub] scripted turn one");
    // (2) 活动事件序列逐字节一致(hookEvents、occurredAt=时钟、身份)。
    expect(r1.events.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(r1.events)).toBe(JSON.stringify(r2.events));
    // (3) 压缩素材时间戳逐字节一致且遵循时钟。
    expect(r1.markerCreatedAt).toBe(INJECTED_ISO);
    expect(r2.markerCreatedAt).toBe(INJECTED_ISO);
    expect(r1.outStamp).toBe(r2.outStamp);
    expect(r1.outStamp).toContain(INJECTED_ISO.replace(/[:.]/g, "-"));
  }, 60_000);
});
