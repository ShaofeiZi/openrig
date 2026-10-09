import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { sendCommand, type SendDeps } from "../src/commands/send.js";
import { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";

function mockLifecycleDeps(): LifecycleDeps {
  return {
    spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(() => true),
    readFile: vi.fn(() => null),
    writeFile: vi.fn(),
    removeFile: vi.fn(),
    exists: vi.fn(() => false),
    mkdirp: vi.fn(),
    openForAppend: vi.fn(() => 3),
    isProcessAlive: vi.fn(() => true),
  };
}

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try { await fn(); } finally { console.log = origLog; console.error = origErr; }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    resolve({ logs, exitCode });
  });
}

// 按通道分离捕获：证明一行落在哪个流。captureLogs 合并了 stdout+stderr，故无法显示
// --json 信封落在 stdout、而人类文案落在 stderr（且两者互不串流）。
function captureChannels(
  fn: () => Promise<void>,
): Promise<{ stdout: string[]; stderr: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => stdout.push(args.join(" "));
    console.error = (...args: unknown[]) => stderr.push(args.join(" "));
    try { await fn(); } finally { console.log = origLog; console.error = origErr; }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    resolve({ stdout, stderr, exitCode });
  });
}

function runningDeps(port: number, clientFactory?: StatusDeps["clientFactory"]): StatusDeps {
  return {
    lifecycleDeps: {
      ...mockLifecycleDeps(),
      exists: vi.fn((p: string) => p === STATE_FILE),
      readFile: vi.fn((p: string) => {
        if (p === STATE_FILE) return JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-01T00:00:00Z" } as DaemonState);
        return null;
      }),
      fetch: vi.fn(async () => ({ ok: true })),
    },
    clientFactory: clientFactory ?? ((baseUrl) => new DaemonClient(baseUrl)),
  };
}

describe("发送 CLI", () => {
  let server: http.Server;
  let port: number;
  let lastSendBody: Record<string, unknown> | null = null;
  let lastBroadcastBody: Record<string, unknown> | null = null;
  // S3（OPR.0.5.4.6）：按顺序记录每个 /send 请求体，使 no-double-delivery
  // 证明能统计纯文本发送数与 submit 路径请求数之比。
  let sendBodies: Array<Record<string, unknown>> = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url ?? "");
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk; });
      req.on("end", () => {
        if (req.method === "POST" && url === "/api/transport/broadcast") {
          const parsed = JSON.parse(body);
          lastBroadcastBody = parsed;
          const sessions: string[] = (parsed.sessions as string[] | undefined)
            ?? ["seat-a@my-rig", "seat-b@my-rig"]; // pod/rig/global resolve to a fixed pair
          if (parsed.text === "partial") {
            const results = [
              { ok: true, sessionName: sessions[0] },
              { ok: false, sessionName: sessions[1], error: "target needs input" },
            ];
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ total: 2, sent: 1, failed: 1, results }));
            return;
          }
          const results = sessions.map((s) => ({ ok: true, sessionName: s }));
          res.writeHead(200, { "Content-Type": "application/json" });
          // S2（OPR.0.5.4.3）：无归属扇出的响应携带 sign-it 提示；桩在触发时返回它，
          // 以便渲染测试断言它被浮出（SURFACED）而非丢弃。
          // 测试可断言它被浮出（SURFACED），而非丢弃。
          const warning = parsed.text === "warn-notice"
            ? "Delivered without sender identity: your recipient has no way of knowing who sent this. Follow up and sign it."
            : undefined;
          res.end(JSON.stringify({ total: results.length, sent: results.length, failed: 0, results, ...(warning ? { warning } : {}) }));
          return;
        }
        if (req.method === "POST" && url === "/api/transport/capture") {
          // S3（OPR.0.5.4.6）夹具：pane 效果是关于"是否消费"的唯一真相。
          // staged-session 把已发送文本留在提示处；consumed-session 显示它已离开输入框。
          const parsed = JSON.parse(body);
          const panes: Record<string, string> = {
            "staged-session": "❯ hello there\n  ⏵⏵ accept edits on (shift+tab to cycle)",
            "consumed-session": "· processing: hello there\n❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)",
            // r2 F3 负例：SCROLLBACK 中一个 STALE 的粘贴文本占位符，且
            // 当前提示为空——这是历史，绝不是 staged 证据。
            "stale-scroll-session": "[Pasted text #3 +12 lines]\nolder scrollback output\n❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)",
            // round-2 F2 负例：位于当前输入区、但与本次发送身份不匹配的占位符
            //（+100 行对 1 行负载）——是别人 staged 的内容；不可验证，绝不属本次发送。
            "unrelated-paste-session": "❯ [Pasted text #7 +100 lines]\n  ⏵⏵ accept edits on (shift+tab to cycle)",
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, sessionName: parsed.session, content: panes[parsed.session as string] ?? "❯ " }));
          return;
        }
        if (req.method === "POST" && url === "/api/transport/send") {
          const parsed = JSON.parse(body);
          lastSendBody = parsed;
          sendBodies.push(parsed);
          if (parsed.session === "staged-session" || parsed.session === "consumed-session" || parsed.session === "stale-scroll-session" || parsed.session === "unrelated-paste-session") {
            // S3 RED fixture: the TRANSPORT believes it delivered (its verify
            // 被测得在该方向不可靠）——staged 真相只能通过 pane 效果看见。
            // 真相只能经 pane 效应可见。
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, sessionName: parsed.session, verified: true, outcome: "delivered" }));
            return;
          }
          if (parsed.session === "dev-impl@my-rig") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, sessionName: "dev-impl@my-rig" }));
          } else if (parsed.session === "verified-session") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, sessionName: "verified-session", verified: true, outcome: "delivered" }));
          } else if (parsed.session === "racy-session") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, sessionName: "racy-session", verified: false, outcome: "rendered-unconfirmed" }));
          } else if (parsed.session === "dead-session") {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, sessionName: "dead-session", reason: "submit_failed", outcome: "failed", error: "Text is visible in 'dead-session' but was not submitted (Enter failed)." }));
          } else if (parsed.session === "busy-session") {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, sessionName: "busy-session", reason: "mid_work", error: "Target pane appears mid-task. Use force: true to send anyway." }));
          } else if (parsed.session === "unknown-advisory") {
            // OPR.0.4.3.28——未知遥测现在带非阻塞 advisory（warning）继续进行。
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, sessionName: "unknown-advisory", warning: "producer-link: daemon-ingest link DOWN — activity could not be determined (no_activity_signal); sent anyway (telemetry is advisory)." }));
          } else {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "not found" }));
          }
        } else {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, resolve); });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => { server.close(); });

  function makeCmd(deps: StatusDeps = runningDeps(port)): Command {
    const prog = new Command();
    prog.exitOverride();
    prog.addCommand(sendCommand(deps));
    return prog;
  }

  beforeEach(() => {
    lastSendBody = null;
    lastBroadcastBody = null;
    sendBodies = [];
    // P18：为每个测试建立一个 RESOLVED 席位，使 dispatch 渲染真实发送者；
    // deliver-and-label 测试把它覆盖为空，以演练 `<unknown sender>` 的 fall-open。
    //（Hermetic-gate 默认 env 未设，故无此 env 时投递会渲染 unknown 标记。）
    // 各自 stub env 的嵌套 describe 在此之后重跑；块级 afterEach 恢复。
    vi.stubEnv("OPENRIG_SESSION_NAME", "sender@my-rig");
    vi.stubEnv("RIGGED_SESSION_NAME", "");
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("send 打印成功输出", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello world"]);
    });
    expect(logs.join("\n")).toContain("已发送给 dev-impl@my-rig");
  });

  it.each(["", "  \t\n"])("refuses an empty or whitespace-only direct message before transport", async (message) => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", message]);
    });
    const output = logs.join("\n");
    expect(exitCode).toBe(1);
    expect(lastSendBody).toBeNull();
    expect(output).toMatch(/消息为空或仅空白/);
    expect(output).toMatch(/backtick|\$\(\)/i);
    expect(output).toMatch(/--body-file|stdin/i);
  });

  it("在发送传输前拒绝空的已解析上下文", async () => {
    const posts: unknown[] = [];
    const client = {
      get: async () => ({ status: 200, data: { ref: "packs/empty", text: " \n\t", bytes: 3, missingFiles: [] } }),
      post: async (_path: string, body: unknown) => { posts.push(body); return { status: 200, data: {} }; },
    } as unknown as DaemonClient;
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd({ ...runningDeps(port), clientFactory: () => client }).parseAsync([
        "node", "rig", "send", "dev-impl@my-rig", "--context", "packs/empty",
      ]);
    });
    expect(exitCode).toBe(1);
    expect(posts).toEqual([]);
    expect(logs.join("\n")).toMatch(/消息为空或仅空白/);
  });

  // P18 投递并打标（删除原子）：无 env 的 send——无 --from（已弃用+忽略）且无
  // 可解析的 OPENRIG_SESSION_NAME/RIGGED_SESSION_NAME——如今投递，携带诚实的 `<unknown sender>`
  // 标签而非拒绝。本次 reset 的北极星：删除一个拒绝不得制造洗白路径，
  // 故无归属的发送以诚实标记和 NULL actorSession 被派发——绝不伪造 actor。
  // 这反转了 A1 的席位边界拒绝；daemon 半边已对 header 缺失写入 deliver-and-label（无下游 401），
  // 故标记到达 pane 而非被拒绝。
  it("P18：无环境的发送带诚实的 `<unknown sender>` 标签完成投递——已派发，actorSession 为 null", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", ""); // override the block seat-stub → unresolvable
    vi.stubEnv("RIGGED_SESSION_NAME", "");
    const { exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello world"]);
    });
    expect(exitCode).toBeFalsy(); // DELIVERED, not refused
    expect(lastSendBody).not.toBeNull(); // dispatch reached the wire
    // 渲染出的信封上的诚实标签；记录中无伪造 actor 身份。
    expect((lastSendBody as Record<string, unknown>).text).toContain("From: <unknown sender>");
    expect((lastSendBody as Record<string, unknown>).actorSession).toBeNull();
  });

  it("P18：可解析席位以其归属身份发送——actorSession 派生自席位环境，绝不伪造", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "driver@my-rig");
    vi.stubEnv("RIGGED_SESSION_NAME", "");
    const { exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello world"]);
    });
    expect(exitCode).toBeFalsy(); // sent (not refused)
    expect(lastSendBody).not.toBeNull(); // dispatch reached the wire
    expect((lastSendBody as Record<string, unknown>)["actorSession"]).toBe("driver@my-rig");
  });

  // P18 一致性护栏（重做 A1 负对照）。两个意图拆开，使仍成立的那个不能搭在已不成立的那个之上：
  //   存活——无散落回退：`<unknown sender>` 字面量只在其合法的
  //     两个孪生点定义；src 中任何第三处定义正是 lockstep 注释抓不到的漂移。
  //   消亡——"因 A1 删除了 CLI 回退而恰好一次"：P18（删除原子）反转 A1。
  //     无 env 的发送现在带诚实 `<unknown sender>` 标记投递（daemon 半边对 header 缺失写入
  //     deliver-and-label），故 CLI 重新获得唯一来源——sender-identity.ts，
  //     被 send.ts + broadcast.ts import（绝不重新声明）。该字面量如今恰在两个逐字节相同的
  //     孪生点：CLI 信封来源与 daemon 的 pane-envelope.ts。
  // 以精确集合成员断言，两个孪生都点名——不是计数/上界。第三个文件按名失败（打印违规者），
  // 缺一个孪生也失败。cwd 无关：repoRoot 由本文件自身位置推导
  //（向上走到 packages 根），绝不取 process.cwd()——故无论 vitest 从 packages/cli
  // 还是仓库根运行，护栏都正确。
  it("P18 一致性：'<unknown sender>' 恰在两个命名孪生点定义——第三个按名失败", () => {
    const findRepoRoot = (start: string): string => {
      let dir = start;
      for (let i = 0; i < 25; i++) {
        if (
          fs.existsSync(path.join(dir, "packages", "cli", "src")) &&
          fs.existsSync(path.join(dir, "packages", "daemon", "src"))
        ) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      throw new Error(`repo root (with packages/cli/src + packages/daemon/src) not found upward from ${start}`);
    };
    const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
    const packagesDir = path.join(repoRoot, "packages");
    const LITERAL = '"<unknown sender>"'; // the double-quoted string-literal token (a definition, not prose)

    // 两个合法的孪生定义点，点名（逐字节相同的信封孪生）：
    const EXPECTED_TWINS = [
      "packages/cli/src/sender-identity.ts",       // the SOLE CLI origin — send.ts + broadcast.ts IMPORT it
      "packages/daemon/src/lib/pane-envelope.ts",  // the daemon origin — wrapPaneEnvelope + non-refusable nudge
    ].sort();

    const srcFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "test") continue;
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") && full.includes(`${path.sep}src${path.sep}`)) {
          srcFiles.push(full);
        }
      }
    };
    for (const pkg of fs.readdirSync(packagesDir)) {
      const srcDir = path.join(packagesDir, pkg, "src");
      if (fs.existsSync(srcDir)) walk(srcDir);
    }

    const hits: string[] = [];
    for (const file of srcFiles) {
      const rel = path.relative(repoRoot, file).split(path.sep).join("/"); // normalized, forward-slash
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        // 跳过注释行（行注释、JSDoc/块注释体）——散文提及不计。
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
        if (line.includes(LITERAL)) hits.push(`${rel}:${i + 1}`);
      });
    }

    // (1) 定义该字面量文件的精确集合——第三个文件（或缺一个孪生）按名失败。
    const filesWithDef = [...new Set(hits.map((h) => h.slice(0, h.lastIndexOf(":"))))].sort();
    expect(
      filesWithDef,
      `expected '<unknown sender>' DEFINED at EXACTLY: ${EXPECTED_TWINS.join(", ")} — found definitions: ${hits.join(", ") || "(none)"}`,
    ).toEqual(EXPECTED_TWINS);

    // (2) 每个孪生恰好一处定义（而非一个命名文件里藏两个字面量）。
    for (const twin of EXPECTED_TWINS) {
      const perTwin = hits.filter((h) => h.startsWith(`${twin}:`));
      expect(perTwin.length, `expected exactly ONE definition in ${twin}, found ${perTwin.length}: ${perTwin.join(", ")}`).toBe(1);
    }
  });

  it("send 中途 409 打印错误并不零退出码退出", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "busy-session", "hello"]);
    });
    expect(logs.join("\n")).toContain("mid-task");
    expect(exitCode).toBe(1);
  });

  // OPR.0.4.3.28 修正——未知遥测的发送继续进行，并在人类输出上打印 advisory（不只在 --json 里）。
  it("在未知即继续的发送上打印 Advisory（人类输出）", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "unknown-advisory", "hello"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("已发送给 unknown-advisory");
    expect(output).toContain("建议：");
    expect(output).toContain("daemon-ingest link DOWN");
    expect(exitCode).toBeUndefined();
  });

  it("在 --json 输出中以 `warning` 携带该 advisory", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "unknown-advisory", "hello", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.warning).toContain("daemon-ingest link DOWN");
  });

  // OPR.99.0.6.3 — honest delivery-outcome vocabulary; legacy Verified: line preserved.
  it("verify confirmed 打印 Delivery: delivered 及遗留 Verified: yes", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "verified-session", "hello", "--verify"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("已发送给 verified-session");
    expect(output).toContain("验证：是");
    expect(output).toContain("投递：delivered");
  });

  it("verify redraw-race 打印 Delivery: rendered-unconfirmed（已落地，附采集引导）及遗留 Verified: no", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "racy-session", "hello", "--verify"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("已发送给 racy-session");
    expect(output).toContain("验证：否");
    expect(output).toContain("投递：rendered-unconfirmed");
    expect(output).toContain("已落地");
    expect(output).toContain("rig capture racy-session");
    // 中间态不被包装成失败：退出保持干净。
    expect(exitCode).toBeUndefined();
  });

  it("verify 真实传输失败保持错误路径，与中间态可区分（判别符）", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dead-session", "hello", "--verify"]);
    });
    const output = logs.join("\n");
    // HTTP 502 -> error branch; no success lines, exit non-zero.
    expect(output).not.toContain("已发送给 dead-session");
    expect(output).not.toContain("投递：rendered-unconfirmed");
    expect(output).toContain("not submitted");
    expect(exitCode).toBe(2);
  });

  it("verify --json 透传附加的 outcome 字段", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "racy-session", "hello", "--verify", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.verified).toBe(false);
    expect(parsed.outcome).toBe("rendered-unconfirmed");
  });

  it("send --json 打印原始 JSON", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(parsed.sessionName).toBe("dev-impl@my-rig");
  });

  it("send --wait-for-idle 提交 waitForIdleMs 并延长请求超时", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: { ok: true, sessionName: "dev-impl@my-rig" },
    }));
    const deps = runningDeps(port, () => ({ post: postFn } as unknown as DaemonClient));
    const { logs } = await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--wait-for-idle", "30", "--json"]);
    });
    const parsed = JSON.parse(logs.join("\n"));
    expect(parsed.ok).toBe(true);
    expect(postFn).toHaveBeenCalledWith(
      "/api/transport/send",
      expect.objectContaining({
        session: "dev-impl@my-rig",
        text: expect.stringContaining("hello"),
        waitForIdleMs: 30000,
      }),
      { timeoutMs: 35000 },
    );
    const sentText = postFn.mock.calls[0]?.[1] as { text: string } | undefined;
    expect(sentText?.text).toContain("To: dev-impl@my-rig");
    expect(sentText?.text).toContain("---\nhello\n---");
    expect(sentText?.text).toContain('↩ 回复：zrig send');
  });

  it("不带 wait-for-idle 的 send 走默认客户端超时路径", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: { ok: true, sessionName: "dev-impl@my-rig" },
    }));
    const deps = runningDeps(port, () => ({ post: postFn } as unknown as DaemonClient));
    await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
    });
    expect(postFn.mock.calls[0]?.[2]).toBeUndefined();
  });

  // Slice-03 Atom 6b——--context 投递标志。
  it("send --context 将 ref 解析为其完整内容并发送（单席位本地）", async () => {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const gets: string[] = [];
    const client = {
      get: async (path: string) => { gets.push(path); return { status: 200, data: { ref: "packs/brief", text: "BRIEF-CONTENT", bytes: 13, missingFiles: [] } }; },
      post: async (path: string, body: unknown) => { posts.push({ path, body: body as Record<string, unknown> }); return { status: 200, data: { ok: true, sessionName: "dev@rig" } }; },
    } as unknown as DaemonClient;
    const { exitCode } = await captureChannels(async () => {
      await makeCmd(runningDeps(port, () => client)).parseAsync(["node", "rig", "send", "dev@rig", "--context", "packs/brief", "--raw"]);
    });
    expect(exitCode).toBeUndefined();
    expect(gets.some((g) => g.includes("/api/context-packs/library/by-ref/pieces?ref=") && g.includes(encodeURIComponent("packs/brief")))).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body["session"]).toBe("dev@rig");
    expect(posts[0]!.body["text"]).toBe("BRIEF-CONTENT"); // --raw → no From/To envelope
  });

  it("当 pack 缺失/不可读成员时 send --context 中止（不发送）", async () => {
    const posts: unknown[] = [];
    const client = {
      get: async () => ({ status: 200, data: { ref: "packs/broken", text: "X", bytes: 1, missingFiles: [{ path: "gone.md" }] } }),
      post: async (_p: string, b: unknown) => { posts.push(b); return { status: 200, data: {} }; },
    } as unknown as DaemonClient;
    const { stderr, exitCode } = await captureChannels(async () => {
      await makeCmd(runningDeps(port, () => client)).parseAsync(["node", "rig", "send", "dev@rig", "--context", "packs/broken", "--raw"]);
    });
    expect(exitCode).toBe(1);
    expect(posts).toEqual([]); // no partial context ever sent
    expect(stderr.join("\n")).toMatch(/gone\.md/);
  });

  it("send 在联系 daemon 前拒绝非法 wait-for-idle 值", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--wait-for-idle", "0"]);
    });
    expect(logs.join("\n")).toContain("正数秒数");
    expect(exitCode).toBe(1);
    expect(lastSendBody).toBeNull();
  });

  it("send 在联系 daemon 前拒绝带 force 的 wait-for-idle", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--wait-for-idle", "30", "--force"]);
    });
    expect(logs.join("\n")).toContain("不能与");
    expect(exitCode).toBe(1);
    expect(lastSendBody).toBeNull();
  });

  // OPR.0.4.1.10——--raw 发送精确文本，不带消息信封（服务端仍有护栏）。
  it("send --raw 提交精确文本，不带 From/To 信封", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "/compact", "--raw"]);
    });
    expect(lastSendBody?.text).toBe("/compact");
    expect(String(lastSendBody?.text)).not.toContain("To: dev-impl@my-rig");
    expect(String(lastSendBody?.text)).not.toContain("↩ Reply");
  });

  it("默认 send（无 --raw）包裹 From/To 消息信封", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
    });
    expect(String(lastSendBody?.text)).toContain("To: dev-impl@my-rig");
    expect(String(lastSendBody?.text)).toContain("---\nhello\n---");
  });

  // P21 I4（specimen-5 安全修复，反转 ba41fea2）：--from 已弃用+忽略。渲染的
  // From: 与 actorSession 派生自传输身份（$OPENRIG_SESSION_NAME，盖成 X-OpenRig-Session），
  // 绝不取调用方给的 --from 字符串（线上事故所针对的可伪造 "From: pm-lead" 面）。
  // 伪造的 --from 不得出现在外发信封任何位置。
  it("send --from <origin> 被忽略——From:/actor 派生自环境传输身份，而非 --from", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "seat@my-rig");
    vi.stubEnv("RIGGED_SESSION_NAME", "");
    try {
      await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--from", "orch-lead@rig-a"]);
      });
      expect(String(lastSendBody?.text)).toContain("From: seat@my-rig");
      expect(String(lastSendBody?.text)).not.toContain("orch-lead@rig-a"); // the forged origin never renders
      expect(lastSendBody?.actorSession).toBe("seat@my-rig");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("send --dangerously-interact --reason 以 raw（精确）文本提交覆盖字段", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "1", "--dangerously-interact", "--reason", "unblock stuck prompt"]);
    });
    expect(lastSendBody?.dangerouslyInteract).toBe(true);
    expect(lastSendBody?.reason).toBe("unblock stuck prompt");
    expect(lastSendBody?.text).toBe("1"); // implies --raw: no envelope
    expect("actorSession" in (lastSendBody ?? {})).toBe(true);
  });

  it("send --dangerously-interact 不带 --reason 在联系 daemon 前被拒绝", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "1", "--dangerously-interact"]);
    });
    expect(logs.join("\n")).toContain("需要 --reason");
    expect(exitCode).toBe(1);
    expect(lastSendBody).toBeNull();
  });

  it("send --dangerously-interact + --wait-for-idle 在联系 daemon 前被拒绝", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "1", "--dangerously-interact", "--reason", "x", "--wait-for-idle", "30"]);
    });
    expect(logs.join("\n")).toContain("不能与 --wait-for-idle 组合");
    expect(exitCode).toBe(1);
    expect(lastSendBody).toBeNull();
  });

  // OPR.0.4.1.10——跨主机 argv 必须转发新标志，使远端 rig 应用同样的护栏。
  it("send --host 在重建的远端 argv 中转发 --raw/--dangerously-interact/--reason", async () => {
    let captured: readonly string[] | null = null;
    const deps: SendDeps = {
      ...runningDeps(port),
      hostRegistryLoader: () => ({ ok: true, registry: { hosts: [{ id: "vm-test", transport: "ssh", target: "vm.local" }] } }),
      crossHostRun: async (_host, argv) => { captured = argv; return { ok: true, stdout: "remote ok", stderr: "" }; },
    };
    await captureLogs(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "1", "--host", "vm-test", "--raw", "--dangerously-interact", "--reason", "why now"]);
    });
    expect(captured).not.toBeNull();
    const argv = captured as unknown as string[];
    expect(argv).toContain("--raw");
    expect(argv).toContain("--dangerously-interact");
    const ri = argv.indexOf("--reason");
    expect(ri).toBeGreaterThan(-1);
    expect(argv[ri + 1]).toBe("why now");
  });

  // Slice-03 Atom 6b QA 修复——agent@rig@host SUGAR 主机是在早期 --context 护栏
  // 之后才折叠进来的，故 --context 必须在折叠后被再次拒绝：它绝不能到达跨主机 argv
  //（否则会带着字面 null 且无消息发出，或带消息时静默丢弃 context）。两种形态都钉住。
  it("send --context 拒绝 agent@rig@host sugar 跨主机形态（无 message）——绝不进入远端 argv", async () => {
    let captured: readonly string[] | null = null;
    const deps: SendDeps = {
      ...runningDeps(port),
      hostRegistryLoader: () => ({ ok: true, registry: { hosts: [{ id: "vm-test", transport: "ssh", target: "vm.local" }] } }),
      crossHostRun: async (_host, argv) => { captured = argv; return { ok: true, stdout: "", stderr: "" }; },
    };
    const { stderr, exitCode } = await captureChannels(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "send", "dev-impl@my-rig@vm-test", "--context", "packs/x"]);
    });
    expect(exitCode).toBe(1);
    expect(captured).toBeNull(); // never reached cross-host → no null shipped
    expect(stderr.join("\n")).toMatch(/--host|agent@rig@host/);
  });

  it("send --context 拒绝 sugar 跨主机形态（带 message）——context 不被静默丢弃", async () => {
    let captured: readonly string[] | null = null;
    const deps: SendDeps = {
      ...runningDeps(port),
      hostRegistryLoader: () => ({ ok: true, registry: { hosts: [{ id: "vm-test", transport: "ssh", target: "vm.local" }] } }),
      crossHostRun: async (_host, argv) => { captured = argv; return { ok: true, stdout: "", stderr: "" }; },
    };
    const { exitCode } = await captureChannels(async () => {
      await makeCmd(deps).parseAsync(["node", "rig", "send", "dev-impl@my-rig@vm-test", "msg", "--context", "packs/x"]);
    });
    expect(exitCode).toBe(1);
    expect(captured).toBeNull(); // rejected before cross-host → context never dropped
  });

  // OPR.0.4.3.30 — `rig send` fan-out targeting (--to / --pod / --rig).
  it("send --to a,b 以 sessions 列表扇出到 /broadcast 并打印逐接收者摘要", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig,dev-qa@my-rig", "hello team"]);
    });
    expect(lastSendBody).toBeNull(); // NOT the single-seat path
    expect(lastBroadcastBody?.sessions).toEqual(["dev-impl@my-rig", "dev-qa@my-rig"]);
    expect(lastBroadcastBody?.text).toBe("hello team"); // bare — daemon wraps per recipient
    const output = logs.join("\n");
    expect(output).toContain("dev-impl@my-rig：已发送");
    expect(output).toContain("dev-qa@my-rig：已发送");
    expect(output).toContain("2/2 已投递");
    expect(exitCode).toBeUndefined();
  });

  it("send 扇出在广播传输前拒绝纯空白内容", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig", " \t"]);
    });
    expect(exitCode).toBe(1);
    expect(lastBroadcastBody).toBeNull();
    expect(logs.join("\n")).toMatch(/消息为空或仅空白/);
  });

  it("send --to 接受重复（--to a --to b）并设置 daemon 侧 envelopeSender", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig", "--to", "dev-qa@my-rig", "hi"]);
    });
    expect(lastBroadcastBody?.sessions).toEqual(["dev-impl@my-rig", "dev-qa@my-rig"]);
    // 非 raw 扇出：daemon 逐接收者包裹，故 CLI 传一个 sender + 裸文本。
    expect(typeof lastBroadcastBody?.envelopeSender).toBe("string");
    expect(String(lastBroadcastBody?.text)).not.toContain("To:");
  });

  it("send --pod 提交 pod 目标到 /broadcast", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--pod", "dev", "pod message"]);
    });
    expect(lastBroadcastBody?.pod).toBe("dev");
    expect(lastBroadcastBody?.text).toBe("pod message");
    expect(logs.join("\n")).toContain("2/2 已投递");
  });

  it("send --rig 提交 rig 目标到 /broadcast", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--rig", "my-rig", "rig message"]);
    });
    expect(lastBroadcastBody?.rig).toBe("my-rig");
    expect(logs.join("\n")).toContain("2/2 已投递");
  });

  it("扇出中一个接收者失败时打印失败项、摘要并以非零退出", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--to", "seat-a@my-rig,seat-b@my-rig", "partial"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("seat-a@my-rig：已发送");
    expect(output).toContain("seat-b@my-rig：失败——");
    expect(output).toContain("1/2 已投递");
    expect(exitCode).toBe(1);
  });

  // ── S3（OPR.0.5.4.6）——投递诚实性："sent" 必须意味着已消费（CONSUMED），
  // 绝不只是敲了字。RED-first 证明资产位于 proof-item 高度（锁可优化措辞；此处断言的
  // 结果是已锁契约）：staged 与 consumed 按 pane 效果（walk 模式推广）区分，
  // staged 报告点名其证据，补救是单一 submit 路径——绝不盲目重发。
  describe("S3 — 投递诚实性（OPR.0.5.4.6）：按 pane 效果区分 staged 与 consumed", () => {
    it("PROOF-1：文本停在提示处的发送按 pane 效果报告为 STAGED——而非传输层的 verified:true", async () => {
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "send", "staged-session", "hello there", "--verify"]);
      });
      const output = logs.join("\n");
      // 当前字节下的 RED：传输层假报的 "delivered" 被回显为
      // 传输层假报的 "delivered" 被回显为 "Verified: yes"，且无 staged 报告。
      expect(output).toMatch(/staged/i);
      expect(output).toMatch(/未消费|staged，未消费/);
    });

    it("PROOF-2：真正被消费的发送正向 verify，绝不报告为 staged", async () => {
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "send", "consumed-session", "hello there", "--verify"]);
      });
      const output = logs.join("\n");
      expect(output).not.toMatch(/staged/i);
      expect(output).toContain("验证：是");
    });

    it("PROOF-3：staged 的补救是单一 submit 路径——恰好一次纯文本发送，不建议也不执行盲目重发", async () => {
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "send", "staged-session", "hello there", "--verify"]);
      });
      const output = logs.join("\n");
      // 这些字节恰好一次纯文本投递触网
      //（非 raw 发送会包裹负载，故按包含匹配；submit 路径请求完全不带文本）
      const plainSends = sendBodies.filter((b) => !b["submitOnly"] && String(b["text"] ?? "").includes("hello there"));
      expect(plainSends).toHaveLength(1);
      const submits = sendBodies.filter((b) => b["submitOnly"]);
      expect(submits.length).toBeLessThanOrEqual(1); // one guarded Enter, never more
      for (const s of submits) expect(s["text"] ?? "").toBeFalsy(); // the submit path types nothing
      // 报告指向 submit 路径，绝非重发
      expect(output).toMatch(/submit|Enter/i);
      expect(output).not.toMatch(/re-?send|send again/i);
    });

    // ── Wave-1 修复第 1 轮（r2 BLOCKING row 91b29490） ──
    it("F3：SCROLLBACK 中陈旧粘贴占位符不是 staged 证据——无 staged 报告、不触发受保护 submit", async () => {
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "send", "stale-scroll-session", "hello there", "--verify"]);
      });
      const output = logs.join("\n");
      expect(output).not.toMatch(/staged/i);
      // 且 submit 路径绝不在历史上触发
      expect(sendBodies.filter((b) => b["submitOnly"])).toHaveLength(0);
      expect(output).toContain("验证：是"); // the transport verdict stands
    });

    it("F2：--json 带 --verify 在信封中携带效果分类（staged 情形）", async () => {
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "send", "staged-session", "hello there", "--verify", "--json"]);
      });
      const envelope = JSON.parse(logs.find((l) => l.trim().startsWith("{")) ?? "{}") as Record<string, unknown>;
      const effect = envelope["effectCheck"] as Record<string, unknown> | undefined;
      expect(effect).toBeDefined();
      expect(effect!["state"]).toBe("staged");
      expect(exitCode).toBe(1); // staged-not-cleared is not a silent success in JSON either
    });

    it("F2：带 --verify 的扇出按接收者报告效果——staged 被点名，consumed 绝不被报为 staged", async () => {
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "send", "--to", "staged-session,consumed-session", "hello there", "--verify"]);
      });
      // 匹配前剥掉席位名，使 "staged-session: sent" 不能仅凭名字
      // 满足 staged 效果断言（本测试首个 RED 跑抓到的修复前稻草人）。
      const scrub = (l: string) => l.replace(/staged-session|consumed-session/g, "SEAT");
      const lines = logs.join("\n").split("\n");
      const stagedEffectLines = lines.filter((l) => l.includes("staged-session") && /staged/i.test(scrub(l)));
      expect(stagedEffectLines.length).toBeGreaterThan(0); // RED pre-fix: no effect line exists
      const consumedEffectClaims = lines.filter((l) => l.includes("consumed-session") && /staged/i.test(scrub(l)));
      expect(consumedEffectClaims).toHaveLength(0);
    });

    // ── Wave-1 修复第 2 轮（r2 BLOCKING row b5ad5131；桌面细化：逐接收者一条
    // verdict，身份先于占位符归属）──
    it("R2-F1 人类：staged-unresolved 接收者无 sent 行且不计入 delivered——仅一条 verdict", async () => {
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "send", "--to", "staged-session,consumed-session", "hello there", "--verify"]);
      });
      const lines = logs.join("\n").split("\n");
      // 假报行必须缺席（桌面绑定）：无未限定的 sent，无含它的 delivered 计数
      expect(lines.some((l) => /^staged-session: sent\b/.test(l))).toBe(false);
      expect(lines.join("\n")).toContain("1/2 已投递");
      expect(lines.join("\n")).not.toContain("2/2 已投递");
      // 且 staged 接收者恰好一条 verdict 行
      expect(lines.filter((l) => l.startsWith("staged-session："))).toHaveLength(1);
      expect(exitCode).toBe(1);
    });

    it("R2-F1 json：同一接收者在信封中绝不可能同时 delivered 与 staged-not-consumed", async () => {
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "send", "--to", "staged-session,consumed-session", "hello there", "--verify", "--json"]);
      });
      const envelope = JSON.parse(logs.find((l) => l.trim().startsWith("{")) ?? "{}") as Record<string, unknown>;
      const results = (envelope["results"] as Array<Record<string, unknown>>) ?? [];
      const stagedRow = results.find((r) => r["sessionName"] === "staged-session");
      expect(stagedRow).toBeDefined();
      // 唯一判定：staged-unresolved 行不是投递主张
      expect(stagedRow!["ok"]).toBe(false);
      expect(stagedRow!["outcome"]).toBe("staged-not-consumed");
      expect(stagedRow!["verified"]).not.toBe(true);
      // Round-3（r2 row 00fb3a68）：聚合由已分类的编码结果派生——
      // staged-unresolved 接收者绝不计入 sent。
      expect(envelope["sent"]).toBe(1); // RED at 57b69e405: raw transport sent:2
      expect(envelope["failed"]).toBe(1);
    });

    it("R2-F1 json 单发：staged-unresolved 信封在 staged 效果旁不带 delivered 声明", async () => {
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "send", "staged-session", "hello there", "--verify", "--json"]);
      });
      const envelope = JSON.parse(logs.find((l) => l.trim().startsWith("{")) ?? "{}") as Record<string, unknown>;
      expect((envelope["effectCheck"] as Record<string, unknown>)["state"]).toBe("staged");
      expect(envelope["verified"]).not.toBe(true);
      expect(envelope["outcome"]).toBe("staged-not-consumed");
    });

    it("R2-F2：无关、大小不匹配的占位符 UNVERIFIABLE——绝不当作本发送 staged，也绝不触发受保护 submit", async () => {
      const { logs } = await captureLogs(async () => {
        await makeCmd().parseAsync(["node", "rig", "send", "unrelated-paste-session", "hello there", "--verify"]);
      });
      const output = logs.join("\n");
      expect(output).not.toMatch(/staged, not consumed/i); // no staged-as-this-send claim
      expect(sendBodies.filter((b) => b["submitOnly"])).toHaveLength(0); // the submit path never fires on foreign content
      expect(output).toMatch(/unverifiable|not .{0,20}this send|does not match this send/i);
      expect(output).toContain("验证：是"); // the transport verdict stands, honestly qualified
    });
  });

  // S2（OPR.0.5.4.3）：扇出渲染器必须浮出附加 warning——
  // 无 env 的操作者看到提示，绝不只有 "sent" 行。
  it("扇出渲染器从响应 warning 浮出 unknown-sender 提示", async () => {
    const { logs } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig,dev-qa@my-rig", "warn-notice"]);
    });
    const output = logs.join("\n");
    expect(output).toContain("dev-impl@my-rig：已发送");
    expect(output).toContain("建议：");
    expect(output).toMatch(/no way of knowing who sent/i);
    expect(output).toMatch(/sign/i);
  });

  it("扇出 --raw 发送裸精确文本，无 envelopeSender（无逐接收者包裹）", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig,dev-qa@my-rig", "/compact", "--raw"]);
    });
    expect(lastBroadcastBody?.text).toBe("/compact");
    expect("envelopeSender" in (lastBroadcastBody ?? {})).toBe(false);
  });

  it("扇出 --dangerously-interact --reason 贯通 danger 字段（裸文本，无信封）", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig,dev-qa@my-rig", "1", "--dangerously-interact", "--reason", "drive stuck prompts"]);
    });
    expect(lastBroadcastBody?.dangerouslyInteract).toBe(true);
    expect(lastBroadcastBody?.reason).toBe("drive stuck prompts");
    expect(lastBroadcastBody?.text).toBe("1");
    expect("envelopeSender" in (lastBroadcastBody ?? {})).toBe(false);
  });

  it("拒绝把裸席位与扇出标志组合", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--pod", "dev"]);
    });
    expect(logs.join("\n")).toContain("不能与 --to/--pod/--rig 组合");
    expect(exitCode).toBe(1);
    expect(lastBroadcastBody).toBeNull();
    expect(lastSendBody).toBeNull();
  });

  it("拒绝同时使用多个扇出模式", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--pod", "dev", "--rig", "my-rig", "hello"]);
    });
    expect(logs.join("\n")).toContain("恰好选一个目标");
    expect(exitCode).toBe(1);
    expect(lastBroadcastBody).toBeNull();
  });

  it("拒绝 --wait-for-idle 与 multi/pod/rig 目标组合", async () => {
    const { logs, exitCode } = await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "--rig", "my-rig", "hello", "--wait-for-idle", "30"]);
    });
    expect(logs.join("\n")).toContain("不支持多/pod/rig 目标");
    expect(exitCode).toBe(1);
    expect(lastBroadcastBody).toBeNull();
  });

  it("单席位 send 保持不变——仍 POST 到 /send，信封逐字节一致，无 /broadcast", async () => {
    await captureLogs(async () => {
      await makeCmd().parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
    });
    expect(lastBroadcastBody).toBeNull();
    expect(lastSendBody?.session).toBe("dev-impl@my-rig");
    expect(String(lastSendBody?.text)).toContain("To: dev-impl@my-rig");
  });

  it("send --help 包含重发现示例与新增护栏标志", () => {
    const cmd = sendCommand(runningDeps(port));
    const helpText = cmd.helpInformation();
    expect(helpText).toContain("--verify");
    expect(helpText).toContain("--force");
    expect(helpText).toContain("--wait-for-idle");
    expect(helpText).toContain("--raw");
    expect(helpText).toContain("--dangerously-interact");
    expect(helpText).toContain("仅面板");
    expect(helpText).toContain("dev-impl@my-rig");
  });

  // OPR.0.4.3.28 B1 code-review 修复——帮助文本必须反映已修正的
  // proceed-with-advisory 行为，而非过时的 unknown 即 fail-closed 契约
  //（后者会继续把操作者引向已弃用的 --dangerously-interact 桥）。
  // 叙事契约在 addHelpText("after") 里，helpInformation() 会略过它——
  // 故经 configureOutput + exitOverride 捕获完整 `--help` 渲染。
  it("send --help 把未知遥测文档为 proceed-with-advisory，而非 fail-closed", () => {
    const cmd = sendCommand(runningDeps(port));
    let helpText = "";
    cmd.configureOutput({ writeOut: (s) => { helpText += s; }, writeErr: (s) => { helpText += s; } });
    cmd.exitOverride();
    try { cmd.parse(["node", "send", "--help"]); } catch { /* exitOverride throws on --help */ }
    expect(helpText.toLowerCase()).not.toContain("fails closed");
    expect(helpText).toContain("建议");
    expect(helpText).toMatch(/建议发送/); // \s+ tolerates the help line-wrap
    // 正向选择器拒绝契约仍有文档记录。
    expect(helpText.toLowerCase()).toContain("拒绝");
  });

  // -------------------------------------------------------------------------
  // qitem-c113bd41——本地 send 诚实性：实际传输才是权威。preflight（getDaemonStatus）
  // 可提示目标回退，但绝不自行拒绝发送：繁忙/楔住的 daemon（probe 超时或
  // running/unhealthy）仍须收到 POST/broadcast；真实宕机则从实际连接错误如实失败，
  // 点名目标——绝不出现裸 preflight 重启行。护栏矩阵：单席位 + 扇出；
  // stopped + running/unhealthy；OPENRIG_URL/RIGGED_URL 自定义端口 + 优先级；
  // 诚实失败；跨主机不动（在跨主机套件中钉住）。
  // -------------------------------------------------------------------------

  describe("qitem-c113bd41——传输权威的本地 send（相对 preflight 拒绝为 RED）", () => {
    afterEach(() => { vi.unstubAllEnvs(); });

    /** lifecycleDeps，其 PROBE 恒失败（瞬时，注入 sleep）且不带任何 daemon 状态——
     *  env-URL/stopped 形态。 */
    function probeFailNoStateDeps(clientFactory: StatusDeps["clientFactory"]): StatusDeps {
      return {
        lifecycleDeps: {
          ...mockLifecycleDeps(),
          exists: vi.fn(() => false),
          readFile: vi.fn(() => null),
          fetch: vi.fn(async () => { throw new Error("probe timed out"); }),
          sleep: async () => {},
        } as LifecycleDeps,
        clientFactory,
      };
    }

    /** ff13bcdf finding 2——把每个 daemon host/port 别名 stub 为空，使配置目标判别符
     *  读配置文件，而非周围托管席位碰巧导出的值。配合块级 afterEach(vi.unstubAllEnvs) 恢复。 */
    function scrubDaemonHostPortAliases(): void {
      vi.stubEnv("OPENRIG_HOST", "");
      vi.stubEnv("OPENRIG_PORT", "");
      vi.stubEnv("RIGGED_HOST", "");
      vi.stubEnv("RIGGED_PORT", "");
    }

    /** ff13bcdf finding 1——deps，其 lifecycle probe 可计数。probe 抛错，
     *  使任何误调也显式是无用功。  */
    function probeCountingDeps(clientFactory: StatusDeps["clientFactory"]): {
      deps: StatusDeps; probeCalls: () => number; probeUrls: () => string[];
    } {
      const fetchSpy = vi.fn(async (): Promise<{ ok: boolean }> => { throw new Error("probe should not be needed"); });
      return {
        deps: {
          lifecycleDeps: {
            ...mockLifecycleDeps(),
            exists: vi.fn(() => false),
            readFile: vi.fn(() => null),
            fetch: fetchSpy,
            sleep: async () => {},
          } as LifecycleDeps,
          clientFactory,
        },
        probeCalls: () => fetchSpy.mock.calls.length,
        // 51-09 incr-3（R8 取代）：URL 使 R8 能按路径（而非仅按计数）把唯一允许的
        // fetch 判别为自标识 /healthz GET。
        probeUrls: () => fetchSpy.mock.calls.map((c) => String(c[0])),
      };
    }

    function recordingRealClient(): { factory: StatusDeps["clientFactory"]; seen: () => string | null } {
      let seenUrl: string | null = null;
      return {
        factory: (baseUrl: string) => { seenUrl = baseUrl; return new DaemonClient(baseUrl); },
        seen: () => seenUrl,
      };
    }

    it("R1 RED：单席位 + OPENRIG_URL 自定义端口 + probe-stopped -> 实际 POST 落地，精确 env 目标传给 clientFactory", async () => {
      vi.stubEnv("OPENRIG_URL", `http://127.0.0.1:${port}`);
      vi.stubEnv("RIGGED_URL", "");
      lastSendBody = null;
      const rc = recordingRealClient();
      const { logs } = await captureLogs(async () => {
        await makeCmd(probeFailNoStateDeps(rc.factory)).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
      });
      expect(logs.join("\n")).toContain("已发送给 dev-impl@my-rig");
      expect(rc.seen()).toBe(`http://127.0.0.1:${port}`);
      expect(String(lastSendBody?.text)).toContain("To: dev-impl@my-rig");
    });

    it("R2 RED：扇出 --to + OPENRIG_URL + probe-stopped -> 实际 /broadcast 落地并带逐接收者结果", async () => {
      vi.stubEnv("OPENRIG_URL", `http://127.0.0.1:${port}`);
      vi.stubEnv("RIGGED_URL", "");
      lastBroadcastBody = null;
      const rc = recordingRealClient();
      const { logs } = await captureLogs(async () => {
        await makeCmd(probeFailNoStateDeps(rc.factory)).parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig,dev-qa@my-rig", "hi team"]);
      });
      expect(lastBroadcastBody).not.toBeNull();
      expect(logs.join("\n")).toContain("dev-impl@my-rig");
      expect(rc.seen()).toBe(`http://127.0.0.1:${port}`);
    });

    it("R3 RED：OPENRIG_URL 未设时沿用旧 RIGGED_URL 自定义端口（probe-stopped）", async () => {
      vi.stubEnv("OPENRIG_URL", "");
      vi.stubEnv("RIGGED_URL", `http://127.0.0.1:${port}`);
      const rc = recordingRealClient();
      const { logs } = await captureLogs(async () => {
        await makeCmd(probeFailNoStateDeps(rc.factory)).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
      });
      expect(logs.join("\n")).toContain("已发送给 dev-impl@my-rig");
      expect(rc.seen()).toBe(`http://127.0.0.1:${port}`);
    });

    it("R4 RED：优先级——传输权威路径上 OPENRIG_URL 胜 RIGGED_URL", async () => {
      vi.stubEnv("OPENRIG_URL", `http://127.0.0.1:${port}`);
      vi.stubEnv("RIGGED_URL", "http://127.0.0.1:59999");
      const rc = recordingRealClient();
      const { logs } = await captureLogs(async () => {
        await makeCmd(probeFailNoStateDeps(rc.factory)).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
      });
      expect(rc.seen()).toBe(`http://127.0.0.1:${port}`);
      expect(logs.join("\n")).toContain("已发送给 dev-impl@my-rig");
    });

    it("R5 RED：RUNNING 但 UNHEALTHY（event-loop-starved 的 healthz 体）仍须发送（单席位 + 扇出）", async () => {
      vi.stubEnv("OPENRIG_URL", `http://127.0.0.1:${port}`);
      vi.stubEnv("RIGGED_URL", "");
      const unhealthyProbeDeps = (clientFactory: StatusDeps["clientFactory"]): StatusDeps => ({
        lifecycleDeps: {
          ...mockLifecycleDeps(),
          fetch: vi.fn(async () => ({
            ok: true,
            json: async () => ({ eventLoop: { healthy: false, lagMeanMs: 9000, lagP99Ms: 9000, utilization: 1, lastTickAgeMs: 9000 } }),
          })),
          sleep: async () => {},
        } as LifecycleDeps,
        clientFactory,
      });
      const rc = recordingRealClient();
      const { logs } = await captureLogs(async () => {
        await makeCmd(unhealthyProbeDeps(rc.factory)).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
      });
      expect(logs.join("\n")).toContain("已发送给 dev-impl@my-rig");
      const rc2 = recordingRealClient();
      lastBroadcastBody = null;
      await captureLogs(async () => {
        await makeCmd(unhealthyProbeDeps(rc2.factory)).parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig,dev-qa@my-rig", "hi"]);
      });
      expect(lastBroadcastBody).not.toBeNull();
    });

    const rcHolder = { seenUrl: null as string | null, factory: ((baseUrl: string) => { rcHolder.seenUrl = baseUrl; return new DaemonClient(baseUrl); }) as StatusDeps["clientFactory"], seen: () => rcHolder.seenUrl };

    it("R6 RED：无 env + live-pid 状态文件（自定义端口）+ healthz probe 失败 -> 对状态派生目标发起 POST", async () => {
      vi.stubEnv("OPENRIG_URL", "");
      vi.stubEnv("RIGGED_URL", "");
      const deps: StatusDeps = {
        lifecycleDeps: {
          ...mockLifecycleDeps(),
          exists: vi.fn((p: string) => p === STATE_FILE),
          readFile: vi.fn((p: string) => p === STATE_FILE
            ? JSON.stringify({ pid: 123, port, db: "test.sqlite", startedAt: "2026-04-01T00:00:00Z" } as DaemonState)
            : null),
          fetch: vi.fn(async () => { throw new Error("healthz timed out"); }),
          sleep: async () => {},
          isProcessAlive: vi.fn(() => true),
        } as LifecycleDeps,
        clientFactory: rcHolder.factory,
      };
      const { logs } = await captureLogs(async () => {
        await makeCmd(deps).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
      });
      expect(logs.join("\n")).toContain("已发送给 dev-impl@my-rig");
      expect(rcHolder.seen()).toBe(`http://127.0.0.1:${port}`);
    });

    it("R6b RED：无 env + 无 daemon 状态 + probe-stopped -> 对配置默认目标发起 POST（注入 client 成功）", async () => {
      vi.stubEnv("OPENRIG_URL", "");
      vi.stubEnv("RIGGED_URL", "");
      // ff13bcdf finding 2——ConfigStore 把这些别名映射到
      // daemon.host/daemon.port，env 胜 file（config-store.ts :343,349）。托管席位携带环境
      // OPENRIG_PORT，故不做此 scrub，本测试测的就是环境，而非……
      // 契约。由该块的 afterEach(vi.unstubAllEnvs) 恢复。
      scrubDaemonHostPortAliases();
      // 不触盘的配置隔离：不存在的 home 意味着无 daemon 配置，
      // 故配置目标解析为默认。
      vi.stubEnv("OPENRIG_HOME", "/nonexistent/send-r6b-home");
      let seenUrl: string | null = null;
      const postFn = vi.fn(async () => ({ status: 200, data: { ok: true, sessionName: "dev-impl@my-rig" } }));
      const stubFactory = ((baseUrl: string) => { seenUrl = baseUrl; return { post: postFn } as unknown as DaemonClient; }) as StatusDeps["clientFactory"];
      const { logs } = await captureLogs(async () => {
        await makeCmd(probeFailNoStateDeps(stubFactory)).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
      });
      expect(logs.join("\n")).toContain("已发送给 dev-impl@my-rig");
      expect(seenUrl).toBe("http://127.0.0.1:7433");
      expect(postFn).toHaveBeenCalledTimes(1);
    });

    it("R6c RED：无 env + 无状态 + probe-stopped + ConfigStore 自定义 daemon host/port -> 对配置文件精确目标发起 POST（无硬编码默认）", async () => {
      vi.stubEnv("OPENRIG_URL", "");
      vi.stubEnv("RIGGED_URL", "");
      // ff13bcdf finding 2——不做此 scrub，环境 OPENRIG_PORT
      //（如托管席位里的 7433）会经 ConfigStore env 盖过 file 的优先级覆盖配置文件的 7599，
      // 本测试就会静默断言 127.0.0.9:7433——正是 R2 观察到的泄漏。
      scrubDaemonHostPortAliases();
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "send-r6c-home-"));
      try {
        fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ daemon: { host: "127.0.0.9", port: 7599 } }));
        vi.stubEnv("OPENRIG_HOME", home);
        let seenUrl: string | null = null;
        const postFn = vi.fn(async () => ({ status: 200, data: { ok: true, sessionName: "dev-impl@my-rig" } }));
        const stubFactory = ((baseUrl: string) => { seenUrl = baseUrl; return { post: postFn } as unknown as DaemonClient; }) as StatusDeps["clientFactory"];
        const { logs } = await captureLogs(async () => {
          await makeCmd(probeFailNoStateDeps(stubFactory)).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
        });
        expect(logs.join("\n")).toContain("已发送给 dev-impl@my-rig");
        // 配置文件目标，逐字节精确——字面默认回退
        //（http://127.0.0.1:7433）在此是违约。
        expect(seenUrl).toBe("http://127.0.0.9:7599");
        expect(postFn).toHaveBeenCalledTimes(1);
      } finally {
        // 异常安全：失败的断言不得留下临时状态。
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it("R7 RED：真实宕机如实失败——实际连接错误点名目标；绝不出现裸 preflight 重启行", async () => {
      vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:1");
      vi.stubEnv("RIGGED_URL", "");
      const rc = recordingRealClient();
      const { logs, exitCode } = await captureLogs(async () => {
        await makeCmd(probeFailNoStateDeps(rc.factory)).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
      });
      const out = logs.join("\n");
      expect(exitCode).toBe(1);
      // 必须浮出实际传输失败——DaemonClient 自己的连接错误前缀，点名配置目标——
      // 而非 preflight 猜的。（也覆盖 1b45cf21 的显式/自定义目标保留钉：解析出的目标
      // 逐字进入 fact 行，而非被摊平成通用消息。）
      expect(out).toContain("无法连接到位于 http://127.0.0.1:1 的 zrig 后台服务");
      expect(out).not.toContain("Daemon not running. Start it with: rig daemon start");
      // 1b45cf21——真实传输失败还须携带仓库的 fact/consequence/action 补救。
      // 上面 fact 行是实际原因；这两条是 consequence 与 action。
      expect(out).toContain("消息未发送。");
      expect(out).toContain("用 'zrig status' 检查配置的目标；健康探测失败不证明后台服务已停。");
      expect(out).toContain("如果目标错了，查 OPENRIG_URL / RIGGED_URL 或 daemon.host + daemon.port。");
      expect(out).toContain("如果确认后台服务已停，跑 'zrig daemon start'.");
      // 缺席钉：补救绝不得断言由失败发送或 advisory 探测推出的 daemon 状态。
      // 连接失败只证明目标不可达——不证明为何。
      expect(out).not.toContain("Daemon not running");
      expect(out).not.toContain("unhealthy");
    });

    // 历史（ff13bcdf finding 3）：本测试以 GREEN 表征进入套件——扇出 catch 本就行为正确，
    // R7 只是从未断言它，故它钉住既有行为而无编造失败。
    // 现在（1b45cf21）：它是刻意的 RED。本泳道要求扇出携带与单席位相同的
    // fact/consequence/action 补救，而该补救尚不存在，故下列补救断言按设计失败，直到 helper 落地。
    // 据此改标题——一个被标为"表征"实则刻意 RED 的测试，正是本切片在别处反复发现的陈旧标签。
    it("R7b RED：扇出真实宕机也如实失败——目标特定连接错误、退出 1、无重启行，且补救与单席位一致", async () => {
      vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:1");
      vi.stubEnv("RIGGED_URL", "");
      const rc = recordingRealClient();
      const { logs, exitCode } = await captureLogs(async () => {
        // 注意：带 --to 时第一个位置参数就是消息（--to 旁的裸席位名会被拒）——
        // 搞错会产生假 RED，而非真正演练扇出 catch。
        await makeCmd(probeFailNoStateDeps(rc.factory)).parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig", "hello"]);
      });
      const out = logs.join("\n");
      expect(exitCode).toBe(1);
      expect(out).toContain("无法连接到位于 http://127.0.0.1:1 的 zrig 后台服务");
      expect(out).not.toContain("Daemon not running. Start it with: rig daemon start");
      // 1b45cf21——对称钉。扇出必须携带与单席位逐字节相同的补救；
      // 两路径之间的分歧正是本断言防范的回归。
      expect(out).toContain("消息未发送。");
      expect(out).toContain("用 'zrig status' 检查配置的目标；健康探测失败不证明后台服务已停。");
      expect(out).toContain("如果目标错了，查 OPENRIG_URL / RIGGED_URL 或 daemon.host + daemon.port。");
      expect(out).toContain("如果确认后台服务已停，跑 'zrig daemon start'.");
      expect(out).not.toContain("Daemon not running");
      expect(out).not.toContain("unhealthy");
    });

    // send-json-error-envelope-gap 后续：在 --json 路径上，真实传输失败须交给 agent
    // 一条可解析记录，而非空 stdout + stderr 上的人类散文。镜像 printDaemonNotRunning 的
    // {error:{fact,consequence,action}} 信封。按通道分离使判别无歧义：stdout 恰好一条 JSON 记录、
    // stderr 为空（人类路径是镜像）。
    it("R7c RED：单席位 --json 传输失败恰好输出一条可解析 stdout JSON 信封，stderr 为空，退出 1", async () => {
      vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:1");
      vi.stubEnv("RIGGED_URL", "");
      const rc = recordingRealClient();
      const { stdout, stderr, exitCode } = await captureChannels(async () => {
        await makeCmd(probeFailNoStateDeps(rc.factory)).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello", "--json"]);
      });
      expect(exitCode).toBe(1);
      // 恰好一条 stdout 记录、可解析、结构信封形状精确
      //（无顶层 ok、无独立 target 字段——只有 error:{f,c,a}）。
      expect(stdout).toHaveLength(1);
      expect(JSON.parse(stdout[0])).toEqual({
        error: {
          fact: expect.stringContaining("无法连接到位于 http://127.0.0.1:1 的 zrig 后台服务"),
          consequence: "消息未发送。",
          action: expect.stringContaining("用 'zrig status' 检查配置的目标；健康探测失败不证明后台服务已停。"),
        },
      });
      // --json 路径不得把人类散文泄漏到 stderr
      expect(stderr).toEqual([]);
    });

    it("R7d RED：扇出 --json 传输失败恰好输出一条可解析 stdout JSON 信封，stderr 为空，退出 1", async () => {
      vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:1");
      vi.stubEnv("RIGGED_URL", "");
      const rc = recordingRealClient();
      const { stdout, stderr, exitCode } = await captureChannels(async () => {
        // 用 --to 时，第一个位置参数即消息（裸 seat + --to 被拒绝）
        await makeCmd(probeFailNoStateDeps(rc.factory)).parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig", "hello", "--json"]);
      });
      expect(exitCode).toBe(1);
      expect(stdout).toHaveLength(1);
      expect(JSON.parse(stdout[0])).toEqual({
        error: {
          fact: expect.stringContaining("无法连接到位于 http://127.0.0.1:1 的 zrig 后台服务"),
          consequence: "消息未发送。",
          action: expect.stringContaining("用 'zrig status' 检查配置的目标；健康探测失败不证明后台服务已停。"),
        },
      });
      expect(stderr).toEqual([]);
    });

    it("R7e：单席位人类输出传输失败保持 stdout 为空（R7c 的镜像）——3 行补救仅在 stderr，退出 1", async () => {
      vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:1");
      vi.stubEnv("RIGGED_URL", "");
      const rc = recordingRealClient();
      const { stdout, stderr, exitCode } = await captureChannels(async () => {
        await makeCmd(probeFailNoStateDeps(rc.factory)).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
      });
      expect(exitCode).toBe(1);
      expect(stdout).toEqual([]); // human path must never write to stdout
      const err = stderr.join("\n");
      expect(err).toContain("无法连接到位于 http://127.0.0.1:1 的 zrig 后台服务");
      expect(err).toContain("消息未发送。");
      expect(err).toContain("用 'zrig status' 检查配置的目标；健康探测失败不证明后台服务已停。");
    });

    it("R7f：扇出人类输出传输失败保持 stdout 为空（R7d 的镜像）——补救仅在 stderr，退出 1", async () => {
      vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:1");
      vi.stubEnv("RIGGED_URL", "");
      const rc = recordingRealClient();
      const { stdout, stderr, exitCode } = await captureChannels(async () => {
        await makeCmd(probeFailNoStateDeps(rc.factory)).parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig", "hello"]);
      });
      expect(exitCode).toBe(1);
      expect(stdout).toEqual([]);
      const err = stderr.join("\n");
      expect(err).toContain("无法连接到位于 http://127.0.0.1:1 的 zrig 后台服务");
      expect(err).toContain("消息未发送。");
    });

    // ff13bcdf finding 1——承重的延迟判别符。显式 URL 别名本就决定目标，故 advisory
    // probe 在事故路径上纯属成本（818ms 失败 / ~2.05s 超时成形）。无调用计数断言的延迟主张
    // 不可证伪，故这里直接断言 probe 计数。
    // 在本父测试上为 RED：getDaemonStatus 走 openrigUrl 分支，在 resolver 读取同一别名前
    // 先烧掉 STATUS_PROBE_MAX_ATTEMPTS(5) 次 fetch。POST 断言今日通过；只有计数失败。
    it("R8：显式 OPENRIG_URL（单席位）-> 精确目标被 POST + 恰好一次自标识 /healthz GET，无状态探测消耗", async () => {
      vi.stubEnv("OPENRIG_URL", `http://127.0.0.1:${port}`);
      vi.stubEnv("RIGGED_URL", "");
      lastSendBody = null;
      const rc = recordingRealClient();
      const { deps, probeCalls, probeUrls } = probeCountingDeps(rc.factory);
      const { logs } = await captureLogs(async () => {
        await makeCmd(deps).parseAsync(["node", "rig", "send", "dev-impl@my-rig", "hello"]);
      });
      expect(logs.join("\n")).toContain("已发送给 dev-impl@my-rig");
      expect(rc.seen()).toBe(`http://127.0.0.1:${port}`);
      expect(lastSendBody).not.toBeNull();
      // 已废弃 2026-08-06（merge-desk 批准 + arch/planner 1-GET 权衡裁定，
      // 51-09 incr-3）：ff13bcdf 的零 probe 保证针对的是昂贵的 5 次 STATUS-PROBE 消耗，
      // 而非单次有界的自标识读取。单席位 send 如今在 CLI 侧渲染 From: 来源三元组，需经一次尽力而为的
      // loopback /healthz GET（rider-b 单一来源；C1 失败开放；CEILING=1、无重试——
      // fetchSelfHostId 是单次 fetchDaemonProbe，失败开放为 undefined）。本钉机械判别：
      // 它既仍抓它诞生时防范的 probe 消耗，又抓混入的第二次自标识 GET 或重试：
      expect(probeCalls()).toBe(1); // ceiling: exactly ONE attempt — never the 5-attempt burn, never a retry
      expect(String(probeUrls()[0] ?? "")).toContain("/healthz"); // the one allowed call IS the self-id GET (path, not just count)
    });

    it("R8b RED：显式 OPENRIG_URL（扇出）-> 精确目标广播且零次 lifecycle probe 调用", async () => {
      vi.stubEnv("OPENRIG_URL", `http://127.0.0.1:${port}`);
      vi.stubEnv("RIGGED_URL", "");
      lastBroadcastBody = null;
      const rc = recordingRealClient();
      const { deps, probeCalls } = probeCountingDeps(rc.factory);
      await captureLogs(async () => {
        await makeCmd(deps).parseAsync(["node", "rig", "send", "--to", "dev-impl@my-rig,dev-qa@my-rig", "hi team"]);
      });
      expect(lastBroadcastBody).not.toBeNull();
      expect(rc.seen()).toBe(`http://127.0.0.1:${port}`);
      expect(probeCalls()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // ba41fea2——扇出来源。`--from` 是全局选项，到达 action 的 opts，但 runFanOutSend 的本地
  // 参数类型不含它，故扇出路径解析环境身份并写入两者：actorSession（审计归属）与
  // envelopeSender（各接收者所见）。显式操作者指令被静默丢弃——而兄弟路径
  //（单席位、跨主机 ssh、跨主机 http）都尊重它。
  //
  // 清理说明：这些测试刻意放在上面 qitem-c113bd41 describe 块之外，故其
  // afterEach(vi.unstubAllEnvs) 不覆盖它们。每个测试在本地 try/finally 恢复自己的 env——
  // 未恢复的 vi.stubEnv 会泄漏到本文件后续每个测试（即 ff13bcdf finding 2 修复的环境 env 同类问题）。
  // -------------------------------------------------------------------------
  describe("P21 I4——扇出忽略 --from；身份派生自传输（反转 ba41fea2）", () => {
    it("--from 在扇出中被忽略——envelopeSender 与 actorSession 都命名环境传输身份，绝不伪造 --from 来源", async () => {
      vi.stubEnv("OPENRIG_URL", `http://127.0.0.1:${port}`);
      vi.stubEnv("RIGGED_URL", "");
      // 环境身份是 stub 的，绝不继承自周围托管席位——否则判别符会静默
      // 对照运行器碰巧导出的值。
      vi.stubEnv("OPENRIG_SESSION_NAME", "ambient-relay@my-rig");
      vi.stubEnv("RIGGED_SESSION_NAME", "");
      try {
        lastBroadcastBody = null;
        await captureLogs(async () => {
          await makeCmd().parseAsync([
            "node", "rig", "send", "--from", "origin@my-rig",
            "--to", "dev-impl@my-rig,dev-qa@my-rig", "hi team",
          ]);
        });
        expect(lastBroadcastBody).not.toBeNull();
        // P21 I4：--from（"origin@my-rig"）是可伪造面——它被忽略。两个归属
        // 字段都解析为环境传输身份；daemon 随后一律从 X-OpenRig-Session 头重新派生，
        // 故伪造的 --from 绝不可能点名 From:。
        expect(lastBroadcastBody?.actorSession).toBe("ambient-relay@my-rig");
        expect(lastBroadcastBody?.envelopeSender).toBe("ambient-relay@my-rig");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("F2 GREEN 表征：无 --from 时扇出仍回退到环境身份（该标志是附加的，不改变行为）", async () => {
      vi.stubEnv("OPENRIG_URL", `http://127.0.0.1:${port}`);
      vi.stubEnv("RIGGED_URL", "");
      vi.stubEnv("OPENRIG_SESSION_NAME", "ambient-relay@my-rig");
      vi.stubEnv("RIGGED_SESSION_NAME", "");
      try {
        lastBroadcastBody = null;
        await captureLogs(async () => {
          await makeCmd().parseAsync([
            "node", "rig", "send", "--to", "dev-impl@my-rig,dev-qa@my-rig", "hi team",
          ]);
        });
        expect(lastBroadcastBody).not.toBeNull();
        expect(lastBroadcastBody?.actorSession).toBe("ambient-relay@my-rig");
        expect(lastBroadcastBody?.envelopeSender).toBe("ambient-relay@my-rig");
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

});
