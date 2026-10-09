import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { spawnGatewayProcess } from "../src/domain/gateway/spawn-gateway.js";
import { encodeGatewayMessage, type CapabilityDescriptor } from "../src/domain/gateway/protocol.js";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";

// M1 A4a——真实 spawn 的 liveness proof。明确两点教训：idle process 需要 ref'd handle；
// in-memory test path 会掩盖真实 spawn bug。进程内测试无法证明 spawned process 会保持存活
//（vitest 自身 event loop 会掩盖缺失的 ref'd handle），因此我们启动实际编译后的 gateway process，
// 并证明：1. 它向外连接 connector（stub 观察到连接）；2. 它在 connector 中断时仍存活
//（socket 断开但 process 不退出——ref'd heartbeat 维持 event loop）；3. connector 恢复时它会重新
// 拨号（stub 观察到新连接）；4. 它收到 SIGTERM 后干净退出。
//
// child 从已构建 dist（tsc emit）运行，因此此 suite 要求先运行 `tsc`。

const CAP: CapabilityDescriptor = {
  kind: "capability", connectorId: "slack-1", platform: "slack", protocolVersion: 1, ops: ["post_message"],
};

// dist entry，相对此测试文件解析：<pkg>/test/.. -> <pkg>/dist/...
const DIST_ENTRY = fileURLToPath(new URL("../dist/domain/gateway/gateway-process-main.js", import.meta.url));

interface Stub { server: Server; connections: number; sockets: Socket[]; }
function startStub(path: string): Promise<Stub> {
  const stub: Stub = { server: undefined as unknown as Server, connections: 0, sockets: [] };
  try { if (existsSync(path)) unlinkSync(path); } catch { /* 全新状态 */ }
  const server = createServer((sock) => {
    stub.connections += 1;
    stub.sockets.push(sock);
    sock.on("error", () => { /* client teardown race */ });
    sock.write(encodeGatewayMessage(CAP)); // 连接时问候
  });
  stub.server = server;
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(path, () => resolve(stub));
  });
}
const closeStub = (s: Stub): Promise<void> => new Promise((res) => {
  for (const sk of s.sockets) { try { sk.destroy(); } catch { /* 尽力而为 */ } }
  s.server.close(() => res());
});
function waitFor(pred: () => boolean, ms = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); resolve(); }
      else if (Date.now() - start > ms) { clearInterval(iv); reject(new Error("waitFor 超时")); }
    }, 25);
  });
}
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("A4a gateway spawn wrapper e2e（真实 spawned process）", () => {
  let home: string;
  let child: ChildProcess | undefined;
  afterEach(async () => {
    if (child && child.exitCode === null && !child.killed) { child.kill("SIGKILL"); }
    child = undefined;
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("dist entry 已构建（tsc emit 已运行）", () => {
    expect(existsSync(DIST_ENTRY)).toBe(true);
  });

  it("完成 spawn、连接，在 connector 中断时存活，随后重新拨号并在 SIGTERM 时关闭", async () => {
    home = mkdtempSync(join(tmpdir(), "a4a-spawn-"));
    const sockPath = join(home, "g.sock");
    expect(sockPath.length).toBeLessThan(104); // sun_path guard

    // 1. connector 启动；生成指向它的真实 gateway process（测试使用快速重连）。
    const stub1 = await startStub(sockPath);
    let exited = false;
    // entryPath = 已构建的 dist entry（在 vitest 下，source module 将 ./*.js 解析到不存在的 sibling；
    // production 会通过 import.meta.url 从 dist 正确解析）。
    child = spawnGatewayProcess({ socketPath: sockPath, home, entryPath: DIST_ENTRY, env: { ...process.env, OPENRIG_GATEWAY_RECONNECT_MS: "300" } });
    child.on("exit", () => { exited = true; });

    await waitFor(() => stub1.connections >= 1); // 已向外连接 connector
    expect(exited).toBe(false);

    // 2. 中断：关闭 connector。socket 断开，但 process 不得退出。
    await closeStub(stub1);
    await delay(1200); // connector 不可拨号期间经过数次重连 tick
    expect(exited).toBe(false); // <-- liveness proof：ref'd heartbeat 使其保持存活
    expect(child.exitCode).toBeNull();

    // 3. connector 在同一路径恢复；heartbeat 重新拨号 -> 新连接。
    const stub2 = await startStub(sockPath);
    await waitFor(() => stub2.connections >= 1); // 中断后重新拨号（无丢失恢复路径）

    // 4. 收到 SIGTERM 后干净关闭。
    child.kill("SIGTERM");
    await waitFor(() => exited === true, 5000);
    expect(child.exitCode === 0 || child.signalCode === "SIGTERM").toBe(true);
    await closeStub(stub2);
  });
});
