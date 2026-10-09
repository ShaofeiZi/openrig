// S16 实测 RED（23 live rigs，2026-08-26）：16 秒内 167 次直连 HTTP 读，
// 含一个 117 读的五秒 bin；daemon CPU 在 TUI 窗口为 15.5%，
// 相邻对照为 2.125%。此探针
// 驱动生产入口点，使节奏不能躲在 mock 后。
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const children: ChildProcessWithoutNullStreams[] = [];
const tempDirs: string[] = [];

function responseFor(route: string): unknown {
  if (route === "/api/scopes?detail=1") return { missions: [] };
  if (route === "/api/review/fleet") return { needsYou: { items: [] }, hosts: [] };
  if (route === "/api/queue/attention-aggregate") return { hosts: [] };
  return [];
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for TUI requests");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode != null) return;
  child.stdin.write("q");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((resolve) => setTimeout(() => {
      child.kill("SIGTERM");
      resolve();
    }, 2_000)),
  ]);
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stop));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("生产 TUI 刷新节奏", () => {
  it("不恢复五秒读取序列，仍在操作者活动时刷新", async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responseFor(req.url ?? "")));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const root = await mkdtemp(path.join(tmpdir(), "openrig-tui-refresh-"));
    tempDirs.push(root);
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const rigStub = path.join(bin, "rig");
    await writeFile(rigStub, `#!/bin/sh
case "$1" in
  crash-cart) printf '%s\\n' '{"state":"up"}' ;;
  config) printf '%s\\n' '{"value":"UTC"}' ;;
  *) exit 1 ;;
esac
`);
    await chmod(rigStub, 0o755);

    const viteNode = fileURLToPath(new URL("../../../node_modules/vite-node/vite-node.mjs", import.meta.url));
    const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");

    const child = spawn(process.execPath, [viteNode, "--script", entry, "--instance", "refresh-policy-test", "--no-color", "--url", `http://127.0.0.1:${address.port}`], {
      env: {
        ...process.env,
        OPENRIG_HOME: root,
        OPENRIG_TUI_SOCKET: path.join(root, "t.sock"),
        PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    try {
      await until(() => stdout.includes("后台服务已连接。") || child.exitCode != null);
      expect(child.exitCode, stderr).toBeNull();
      expect(stdout).toContain("后台服务已连接。");
      // S05 先开 startup。测其节奏前进入普通工作。
      const startupReads = requests.length;
      child.stdin.write("w");
      await until(() => requests.length > startupReads || child.exitCode != null);
      expect(child.exitCode, stderr).toBeNull();
      // 取空闲样本前等初始 hydration 完成。
      await new Promise((resolve) => setTimeout(resolve, 100));
      const initialReads = requests.length;

      await new Promise((resolve) => setTimeout(resolve, 5_300));
      const idleReads = requests.length;

      child.stdin.write("\x1b[B");
      await until(() => requests.length > idleReads || child.exitCode != null, 1_500).catch(() => {});
      const activeReads = requests.length;

      expect(idleReads, "an unchanged open TUI must not rebuild the fleet in a five-second series").toBe(initialReads);
      expect(activeReads, "operator input must request fresh data").toBeGreaterThan(idleReads);
    } finally {
      await stop(child);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 12_000);
});
