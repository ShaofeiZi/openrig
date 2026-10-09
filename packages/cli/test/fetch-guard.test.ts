// P37——globalThis.fetch 上的请求层封闭守卫。许可规则是一个
// 形状（shape），而非注册表：临时高位端口上的回环
//（127.0.0.1 / ::1 / localhost）——正是 server.listen(0) 产出的——
// 零注册即许可；其余一切拒绝（失败关闭默认）。allowFetchTarget 作为
// 需要固定低位端口的 fixture 的逃生舱保留。
//
// 三个已知负例（dev50-planner pin + 机器边界臂）——一个只证明会拒绝的守卫，
// 与一个在安全方向坏掉的全拒器无法区分：拒绝 canonical daemon；
// 许可回环临时 fixture；拒绝非回环目标。
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { allowFetchTarget, resetFetchAllowlist } from "./fetch-guard.js";

// guard 由共享 setup（hermetic-env.setup.ts）为每个文件安装。
describe("fetch guard — allowlist by shape, fail-closed, three-sided", () => {
  afterEach(() => resetFetchAllowlist());

  it("REFUSES the canonical daemon target (:7433, both host forms) — the escape", async () => {
    await expect(fetch("http://localhost:7433/api/queue/x/update")).rejects.toThrow(/FETCH GUARD|daemon/i);
    await expect(fetch("http://127.0.0.1:7433/healthz")).rejects.toThrow(/FETCH GUARD|daemon/i);
  });

  it("PERMITS a loopback-ephemeral fixture BY SHAPE (server.listen(0), no registration)", async () => {
    const server = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}'); });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ping`); // NOT registered — permitted by shape
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      server.close();
    }
  });

  it("REFUSES a NON-LOOPBACK target (the machine-boundary arm — hosts.yaml's real remote)", async () => {
    await expect(fetch("http://100.95.124.51:7433/api/x")).rejects.toThrow(/FETCH GUARD|non-loopback/i);
  });

  it("FAILS CLOSED on a loopback WELL-KNOWN/low port (< ephemeral) that is not registered", async () => {
    await expect(fetch("http://127.0.0.1:8080/anything")).rejects.toThrow(/FETCH GUARD/i);
  });

  it("ESCAPE HATCH: allowFetchTarget PERMITS a fixed low-port fixture (the guard delegates; a real ECONNREFUSED is NOT the guard)", async () => {
    allowFetchTarget("http://127.0.0.1:8123");
    const err = await fetch("http://127.0.0.1:8123/x").then(() => null).catch((e) => e as Error);
    expect(err).not.toBeNull();
    expect(String(err?.message ?? "")).not.toMatch(/FETCH GUARD/); // permitted → real fetch's connection error, not the guard
  });

  it("a registered / loopback-ephemeral fixture does NOT widen the allowlist to the daemon", async () => {
    allowFetchTarget("http://127.0.0.1:8123");
    await expect(fetch("http://localhost:7433/api/x")).rejects.toThrow(/FETCH GUARD|daemon/i);
  });
});
