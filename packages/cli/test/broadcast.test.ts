import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { Command } from "commander";
import { allowFetchTarget } from "./fetch-guard.js";
import { broadcastCommand } from "../src/commands/broadcast.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(): LifecycleDeps {
  return { spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never), fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true), readFile: vi.fn(() => null), writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn(() => false), mkdirp: vi.fn(), openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true) };
}
function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; stdout: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = []; const stdout: string[] = []; const origLog = console.log; const origErr = console.error; const origExitCode = process.exitCode; process.exitCode = undefined;
    console.log = (...args: unknown[]) => { logs.push(args.join(" ")); stdout.push(args.join(" ")); }; console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try { await fn(); } finally { console.log = origLog; console.error = origErr; } const exitCode = process.exitCode; process.exitCode = origExitCode; resolve({ logs, stdout, exitCode });
  });
}
function runningDeps(port: number): StatusDeps {
  return { lifecycleDeps: { ...mockLifecycleDeps(), exists: vi.fn((p: string) => p === STATE_FILE), readFile: vi.fn((p: string) => { if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-01T00:00:00Z" } as DaemonState); return null; }), fetch: vi.fn(async () => ({ ok: true })) }, clientFactory: (baseUrl) => new DaemonClient(baseUrl) };
}

describe("Broadcast CLI", () => {
  let server: http.Server;
  let port: number;
  let broadcastPosts = 0;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/api/transport/broadcast") {
          broadcastPosts += 1;
          const parsed = JSON.parse(body);
          if (parsed.rig === "empty-rig") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              total: 0, sent: 0, failed: 0,
              results: [
                { ok: false, sessionName: "", error: "No running sessions found for rig 'empty-rig'. Check rig status with: rig ps" },
              ],
            }));
          } else
          if (parsed.rig === "fail-rig") {
            // 部分失败
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              total: 2, sent: 1, failed: 1,
              results: [
                { ok: true, sessionName: "dev-impl@fail-rig" },
                { ok: false, sessionName: "dev-qa@fail-rig", error: "send failed" },
              ],
            }));
          } else if (parsed.rig === "warn-rig") {
            // S2（OPR.0.5.4.3）：无归属 broadcast 的响应携带
            // sign-it 提示作为附加警告；渲染器必须浮出它。
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              total: 2, sent: 2, failed: 0,
              warning: "Delivered without sender identity: your recipients have no way of knowing who sent this. Follow up and sign it.",
              results: [
                { ok: true, sessionName: "dev-impl@warn-rig" },
                { ok: true, sessionName: "dev-qa@warn-rig" },
              ],
            }));
          } else {
            // 成功（覆盖 rig-scoped 与 global）
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              total: 2, sent: 2, failed: 0,
              results: [
                { ok: true, sessionName: "dev-impl@my-rig" },
                { ok: true, sessionName: "dev-qa@my-rig" },
              ],
            }));
          }
        } else { res.writeHead(404).end(); }
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  // P18：为每个测试建立已解析 seat，使标记渲染为真实发送方
  // ("broadcaster@my-rig"); the deliver-and-label test below overrides it to empty to exercise the
  // `<unknown sender>` fall-open. (Hermetic-gate default is env-UNSET, so without this every broadcast
  // would render the unknown marker.) Restored by afterEach so no stub leaks across tests.
  beforeEach(() => {
    broadcastPosts = 0;
    vi.stubEnv("OPENRIG_SESSION_NAME", "broadcaster@my-rig");
    vi.stubEnv("RIGGED_SESSION_NAME", "");
    // broadcast 泄漏遏制：把本文件每个 broadcast 显式绑到进程内 fixture daemon，
    // 使未作用域化的 broadcast 无法经任何代码路径（环境 env 或 STATE_FILE 回落）
    // 到达 live topology——在 setup 级 fixture-home 守卫之上再加双保险。测试中
    // 未作用域化的 broadcast 是与路由无关的 bug；这使 fixture 成为唯一可达目标。
    vi.stubEnv("OPENRIG_URL", `http://127.0.0.1:${port}`);
    vi.stubEnv("OPENRIG_PORT", String(port));
    // P37：把这个进程内 fixture 注册到请求层守卫，使其真实请求被许可
    //（守卫对未注册目标失败关闭）。
    allowFetchTarget(`http://127.0.0.1:${port}`);
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  function makeCmd(): Command {
    const prog = new Command(); prog.exitOverride();
    prog.addCommand(broadcastCommand(runningDeps(port)));
    return prog;
  }

  // S2 (OPR.0.5.4.3): the broadcast renderer must SURFACE an additive warning.
  it("broadcast renderer surfaces the unknown-sender notice from the response warning", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "--rig", "warn-rig", "hello"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("dev-impl@warn-rig：已发送");
    expect(output).toContain("提示：");
    expect(output).toMatch(/no way of knowing who sent/i);
    expect(output).toMatch(/sign/i);
  });

  it("broadcast --rig prints per-target summary", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "--rig", "my-rig", "hello"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("dev-impl@my-rig：已发送");
    expect(output).toContain("dev-qa@my-rig：已发送");
    expect(output).toContain("已投递 2/2");
  });

  it.each(["", " \t\n"])("broadcast refuses empty or whitespace-only content before transport", async (message) => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "--rig", "my-rig", message]);
    });
    const output = logs.join("\n");
    expect(exitCode).toBe(1);
    expect(broadcastPosts).toBe(0);
    expect(output).toMatch(/消息为空或仅空白/);
    expect(output).toMatch(/backtick|\$\(\)/i);
    expect(output).toMatch(/--body-file|stdin/i);
  });

  it("broadcast refuses an empty resolved context before fan-out transport", async () => {
    const posts: unknown[] = [];
    const client = {
      get: async () => ({ status: 200, data: { ref: "packs/empty", text: " \n", bytes: 2, missingFiles: [] } }),
      post: async (_path: string, body: unknown) => { posts.push(body); return { status: 200, data: {} }; },
    } as unknown as DaemonClient;
    const prog = new Command(); prog.exitOverride();
    prog.addCommand(broadcastCommand({ ...runningDeps(port), clientFactory: () => client }));
    const { logs, exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "broadcast", "--rig", "my-rig", "--context", "packs/empty"]);
    });
    expect(exitCode).toBe(1);
    expect(posts).toEqual([]);
    expect(logs.join("\n")).toMatch(/消息为空或仅空白/);
  });

  it("broadcast without --rig/--pod sends globally", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "System maintenance"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("已投递 2/2");
  });

  // Slice-03 Atom 6b — --context delivery flag on broadcast.
  it("broadcast --context resolves a ref and fans out the whole content", async () => {
    const posts: Array<{ body: Record<string, unknown> }> = []; const gets: string[] = [];
    const client = {
      get: async (p: string) => { gets.push(p); return { status: 200, data: { ref: "packs/fleet", text: "FLEET-UPDATE", bytes: 12, missingFiles: [] } }; },
      post: async (_p: string, b: unknown) => { posts.push({ body: b as Record<string, unknown> }); return { status: 200, data: { results: [{ sessionName: "a@rig", ok: true }], sent: 1, total: 1, failed: 0 } }; },
    } as unknown as DaemonClient;
    const prog = new Command(); prog.exitOverride();
    prog.addCommand(broadcastCommand({ ...runningDeps(port), clientFactory: () => client }));
    const { exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "broadcast", "--rig", "my-rig", "--context", "packs/fleet"]);
    });
    expect(exitCode).toBeUndefined();
    expect(gets.some((g) => g.includes("/api/context-packs/library/by-ref/pieces?ref=") && g.includes(encodeURIComponent("packs/fleet")))).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body["text"]).toBe("FLEET-UPDATE");
  });

  it("broadcast --context ABORTS (no fan-out) when the pack has a missing member", async () => {
    // 缺失成员消息（点名该成员）钉在 context-resolve.test.ts；此处断言
    // broadcast 级契约：以非零退出，零扇出（绝不发出部分 context）。
    const posts: unknown[] = [];
    const client = {
      get: async () => ({ status: 200, data: { ref: "packs/broken", text: "X", bytes: 1, missingFiles: [{ path: "gone.md" }] } }),
      post: async (_p: string, b: unknown) => { posts.push(b); return { status: 200, data: {} }; },
    } as unknown as DaemonClient;
    const prog = new Command(); prog.exitOverride();
    prog.addCommand(broadcastCommand({ ...runningDeps(port), clientFactory: () => client }));
    const { exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "broadcast", "--rig", "my-rig", "--context", "packs/broken"]);
    });
    expect(exitCode).toBe(1);
    expect(posts).toEqual([]);
  });

  // P21 跨 host broadcast 修复（203078d7 的死亡条件）：runCrossHostBroadcast
  // 重建 body，曾会丢弃 enveloped-fan-out 标记，使远端渲染为 RAW（无 From:），
  // 而本地路径——同一个 helper——却包装了。修复经单源 helper 补加
  // body.envelopeSender。DaemonClient 在 POST 上自动盖 X-OpenRig-Session=origin
  // env（client.ts:171），故远端从 transport 派生 From:；标记值被忽略。
  function crossHostBcast(): { posts: Array<{ path: string; body: Record<string, unknown> }>; deps: Parameters<typeof broadcastCommand>[0] } {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const client = {
      get: async (p: string) => { posts.push({ path: p, body: {} }); return { status: 200, data: {} }; },
      post: async (p: string, b: unknown) => { posts.push({ path: p, body: (b ?? {}) as Record<string, unknown> }); return { status: 200, data: { results: [{ sessionName: "a@rig", ok: true }], sent: 1, total: 1, failed: 0 } }; },
    } as unknown as DaemonClient;
    const hostRegistryLoader = () => ({ ok: true as const, registry: { hosts: [{ id: "vm-a", transport: "http" as const, url: "http://vm-a:7433" }] } });
    return { posts, deps: { ...runningDeps(port), clientFactory: () => client, hostRegistryLoader } };
  }

  it("P21: cross-host broadcast CARRIES the enveloped marker (was dropped → remote rendered raw); value = the seat, but the daemon derives the From: from the auto-stamped X-OpenRig-Session", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "orch@rig-a");
    vi.stubEnv("RIGGED_SESSION_NAME", "");
    const { posts, deps } = crossHostBcast();
    const prog = new Command(); prog.exitOverride();
    prog.addCommand(broadcastCommand(deps));
    await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "broadcast", "--host", "vm-a", "--rig", "my-rig", "hi team"]);
    });
    const bcast = posts.find((p) => p.path.includes("/api/transport/broadcast"));
    expect(bcast).toBeDefined();
    expect(bcast!.body["envelopeSender"]).toBe("orch@rig-a"); // marker PRESENT (the fix) — value ignored daemon-side
    expect(bcast!.body["text"]).toBe("hi team");
  });

  // P18 DELIVER-AND-LABEL (deletion atom; REVERSES A1, supersedes the P21 session-less pin): an env-less
  // 跨 host broadcast 现在带诚实的 `<unknown sender>` 标记交付，而非拒绝。
  // 标记的存在（而非其值）是抗风暴信号，故无会话的 broadcast 仍包装每个
  // 接收者（无无会话风暴）；daemon 半交付并标注 header 缺失的写入
  //（无下游 401）。承载要点：确实发生了一次 dispatch，线上的标记是诚实回落——
  // 绝不是伪造的 sender。
  it("P18: an env-less cross-host broadcast DELIVERS with the honest `<unknown sender>` marker on the wire", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "");
    vi.stubEnv("RIGGED_SESSION_NAME", "");
    const { posts, deps } = crossHostBcast();
    const prog = new Command(); prog.exitOverride();
    prog.addCommand(broadcastCommand(deps));
    const { exitCode } = await captureLogs(async () => {
      await prog.parseAsync(["node", "rig", "broadcast", "--host", "vm-a", "--rig", "my-rig", "hi team"]);
    });
    expect(exitCode).toBeFalsy(); // DELIVERED, not refused
    const bcast = posts.find((p) => p.path.includes("/api/transport/broadcast"));
    expect(bcast).toBeDefined(); // dispatch reached the wire
    expect(bcast!.body["envelopeSender"]).toBe("<unknown sender>"); // honest marker present (anti-storm), never forged
  });

  it("broadcast --json prints raw JSON", async () => {
    const { stdout } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "--rig", "my-rig", "hello", "--json"]);
    });
    const parsed = JSON.parse(stdout.join("\n"));
    expect(parsed.total).toBe(2);
    expect(parsed.sent).toBe(2);
  });

  it("broadcast exits nonzero when no targets resolve", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "broadcast", "--rig", "empty-rig", "hello"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("No running sessions found");
    expect(output).toContain("已投递 0/0");
    expect(exitCode).toBe(1);
  });
});
