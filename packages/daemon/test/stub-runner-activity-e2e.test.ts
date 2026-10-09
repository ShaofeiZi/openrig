import { describe, it, expect, afterEach } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Slice 51-01 第 6-8 项——R2 真实进程证明：已接线 runner 确实经线上向
// /api/activity/hooks POST 权威 activity 事件集合。封闭执行器测试证明发出顺序；这里弥合
// 内存测试掩盖真实进程的缺口——mock 接缝无法证明真实进程从 env 解析端点、完成认证并命中
// 真实路径。使用一次性 HTTP sink，无需完整后台服务即可证明传输契约。

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "../src/adapters/stub-runner.ts");
const SEAT = "dev-worker@activity-e2e";
const TOKEN = "test-activity-token-r2";
const INJECTED_ISO = "2021-06-06T06:06:06.000Z";

interface Captured { body: Record<string, unknown>; auth: string | undefined; url: string | undefined }

async function waitFor(pred: () => boolean, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (pred()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("stub-runner activity POST (real-spawn wire proof, R2)", () => {
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

  it("携带 runtime=stub 和 Bearer 认证向 /api/activity/hooks 依次 POST SessionStart → UserPromptSubmit → Stop", async () => {
    dir = mkdtempSync(join(tmpdir(), "stub-activity-e2e-"));
    const captured: Captured[] = [];
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try { captured.push({ body: JSON.parse(raw), auth: req.headers.authorization, url: req.url }); }
        catch { /* ignore non-JSON */ }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server!.address() as { port: number }).port;

  // 没有 script.json 时使用默认的仅 say 脚本（一个 turn，不压缩）；该 turn 仍包住
  // UserPromptSubmit … Stop，因此三个生命周期事件都会触发。
    child = execFile("node", ["--import", "tsx", RUNNER,
      "--session-name", SEAT, "--cwd", dir, "--launch-id", "act-1", "--posture", "floor"],
      { env: {
        ...process.env,
        OPENRIG_HOME: join(dir, ".openrig"),
        OPENRIG_URL: `http://127.0.0.1:${port}`,
        OPENRIG_ACTIVITY_HOOK_TOKEN: TOKEN,
        OPENRIG_NODE_ID: "node-xyz",
        OPENRIG_TEST_CLOCK_NOW: INJECTED_ISO,
      } as NodeJS.ProcessEnv });

    const events = () => captured.map((c) => String(c.body.hookEvent));
    await waitFor(() => events().includes("SessionStart") && events().includes("UserPromptSubmit") && events().includes("Stop"));

    // 每个 POST 都命中权威路径，完成认证，带 runtime 标签并按席位区分。
    for (const c of captured) {
      expect(c.url).toBe("/api/activity/hooks");
      expect(c.auth).toBe(`Bearer ${TOKEN}`);
      expect(c.body.runtime).toBe("stub");
      expect(c.body.sessionName).toBe(SEAT);
      expect(c.body.nodeId).toBe("node-xyz");
      expect(c.body.occurredAt).toBe(INJECTED_ISO);
    }
    // turn 顺序：SessionStart 先于本 turn 的 UserPromptSubmit，后者先于 Stop。
    expect(events().indexOf("SessionStart")).toBeLessThan(events().indexOf("UserPromptSubmit"));
    expect(events().indexOf("UserPromptSubmit")).toBeLessThan(events().indexOf("Stop"));
  }, 30_000);
});
