import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PassThrough } from "node:stream";
import type { QueueDeps } from "../src/commands/queue.js";
import { resolveQueueBody, previewBody, waitForDeliveryOutcome } from "../src/commands/queue.js";
import { createProgram } from "../src/index.js";

/**
 * `rig queue` CLI 测试 — PL-004 Phase A 修订（R1）。
 *
 * 模式仿 compact-plan.test.ts：mock daemon-lifecycle 伪装成运行中的 daemon，
 * 注入一个返回 stubbed HTTP client 的 clientFactory。测试断言：命令解析、
 * HTTP 请求形状、非 2xx 退出处理、hot-potato 错误渲染。无真实 daemon、无 DB、无网络。
 */

vi.mock("../src/daemon-lifecycle.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../src/daemon-lifecycle.js");
  return {
    ...actual,
    getDaemonStatus: vi.fn(async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 })),
    getDaemonUrl: vi.fn(() => "http://localhost:7433"),
  };
});

interface StubResponse {
  status: number;
  data: unknown;
}

function makeDeps(opts?: {
  routes?: Record<string, StubResponse | StubResponse[]>;
}): { deps: QueueDeps; calls: Array<{ method: string; path: string; body?: unknown }> } {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const routes = opts?.routes ?? {};
  return {
    calls,
    deps: {
      lifecycleDeps: {} as QueueDeps["lifecycleDeps"],
      clientFactory: () => ({
        get: vi.fn(async (path: string) => {
          calls.push({ method: "GET", path });
          const route = routes[`GET ${path}`];
          return (Array.isArray(route) ? route.shift() : route) ?? { status: 200, data: {} };
        }),
        getText: vi.fn(async (path: string) => {
          calls.push({ method: "GET", path });
          return { status: 200, data: "" };
        }),
        post: vi.fn(async (path: string, body: unknown) => {
          calls.push({ method: "POST", path, body });
          const route = routes[`POST ${path}`];
          return (Array.isArray(route) ? route.shift() : route) ?? { status: 201, data: { qitemId: "qitem-test-1" } };
        }),
        delete: vi.fn(async (path: string) => {
          calls.push({ method: "DELETE", path });
          return { status: 204, data: null };
        }),
        postText: vi.fn(async (path: string) => {
          calls.push({ method: "POST", path });
          return { status: 200, data: "" };
        }),
        postExpectText: vi.fn(async (path: string) => {
          calls.push({ method: "POST", path });
          return { status: 200, data: "" };
        }),
      }) as unknown as ReturnType<QueueDeps["clientFactory"]>,
    },
  };
}

describe("rig queue CLI", () => {
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    vi.unstubAllEnvs();
    // P21 HERMETIC：queue 动词从席位 env（X-OpenRig-Session）派生 source/actor，因此无 env 的
    // 夹具会在 POST 之前中止。stub 一个确定性席位，使这些测试永不依赖环境里的
    // OPENRIG_SESSION_NAME（它曾在受管 runner 中掩盖无 env 破坏）。需要特定席位的逐用例 stub 覆盖此项。
    vi.stubEnv("OPENRIG_SESSION_NAME", "seat@rig");
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    process.exitCode = undefined;
  });

  it("createProgram 注册 queue 及其全部 R1 子命令", async () => {
    const { deps } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    const queueCmd = program.commands.find((c) => c.name() === "queue");
    expect(queueCmd).toBeDefined();
    const subs = queueCmd!.commands.map((c) => c.name()).sort();
    // R1 已批准契约：handoff-and-complete + whoami 与原命令并存。
    expect(subs).toContain("create");
    expect(subs).toContain("handoff");
    expect(subs).toContain("handoff-and-complete");
    expect(subs).toContain("whoami");
    expect(subs).toContain("update");
    expect(subs).toContain("inbox-drop");
    expect(subs).toContain("inbox-absorb");
    expect(subs).toContain("inbox-deny");
    expect(subs).toContain("list");
    expect(subs).toContain("show");
  });

  it("create 不带 body sourceSession——来源派生自传输头（X-OpenRig-Session）；显式 --source 被丢弃，绝不作为 body 声明转发", async () => {
    const saved = process.env["OPENRIG_SESSION_NAME"];
    process.env["OPENRIG_SESSION_NAME"] = "alice@rig"; // the seat env == the X-OpenRig-Session the DaemonClient stamps
    try {
      const { deps, calls } = makeDeps({
        routes: { "POST /api/queue/create": { status: 201, data: { qitemId: "qitem-x", state: "pending" } } },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "queue", "create",
        "--source", "forged@evil", // P21: IGNORED — must not ride the body
        "--destination", "bob@rig",
        "--body", "do thing",
        "--json",
      ]);
      const create = calls.find((c) => c.path === "/api/queue/create");
      expect(create).toBeDefined();
      const body = create!.body as Record<string, unknown>;
      // P21 I3 调和：不带 body 身份声明——daemon 从 header 派生 source，伪造的 --source 被丢弃（不转发）。destination 是 TARGET，属合法 body 字段。
      expect(body.sourceSession).toBeUndefined();
      expect(body.destinationSession).toBe("bob@rig");
      expect(body.body).toBe("do thing");
      // R1：commander 的 --no-nudge 默认把 opts.nudge 置 true。CLI 发送 nudge: true，daemon 把 nudge !== false 视为 nudging。
      expect(body.nudge).toBe(true);
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_SESSION_NAME"];
      else process.env["OPENRIG_SESSION_NAME"] = saved;
    }
  });

  // Slice-03 Atom 6b — --body-context snapshot + provenance rule.
  it("create 保留显式人工意图与 authored 补充文件字节", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "queue-human-detail-"));
    const file = path.join(directory, "detail.txt");
    const detail = "Supporting context.\nEmoji: 😀; symbols: < & >.\n";
    fs.writeFileSync(file, detail);
    try {
      const { deps, calls } = makeDeps();
      await createProgram({ queueDeps: deps }).parseAsync(["node", "rig", "queue", "create", "--destination", "human-founder@external", "--body", "No action needed.", "--human-intent", "update", "--human-detail-file", file, "--json"]);
      expect(calls.find((c) => c.path === "/api/queue/create")?.body).toMatchObject({ humanIntent: "update", humanDetail: detail, body: "No action needed." });
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it("create --body-context 把已解析内容快照为 body + 来源标签", async () => {
    const { deps, calls } = makeDeps({
      routes: {
        "GET /api/context-packs/library/by-ref/pieces?ref=packs%2Fbrief": { status: 200, data: { ref: "packs/brief", text: "BRIEF-BODY", bytes: 10, missingFiles: [] } },
        "POST /api/queue/create": { status: 201, data: { qitemId: "qitem-y", state: "pending" } },
      },
    });
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "create",
      "--source", "alice@rig", "--destination", "bob@rig",
      "--body-context", "packs/brief", "--summary", "onboarding",
    ]);
    const create = calls.find((c) => c.path === "/api/queue/create");
    expect(create, "expected the qitem to be created").toBeDefined();
    const body = create!.body as { body: string; tags?: string[] };
    // 快照：已解析内容即 body（而非引用 ref）；后续库编辑永远无法改写这次 handoff 的历史。
    expect(body.body).toBe("BRIEF-BODY");
    // 来源溯源：ref 作为标签携带，以便「这个 agent 当时拿到了什么上下文？」始终可审计。
    expect(body.tags).toContain("body-context:packs/brief");
  });

  it("create --body-context 在 pack 缺成员时中止（不创建 qitem）", async () => {
    const { deps, calls } = makeDeps({
      routes: {
        "GET /api/context-packs/library/by-ref/pieces?ref=packs%2Fbroken": { status: 200, data: { ref: "packs/broken", text: "X", missingFiles: [{ path: "gone.md" }] } },
      },
    });
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "create",
      "--source", "alice@rig", "--destination", "bob@rig",
      "--body-context", "packs/broken", "--summary", "x",
    ]);
    expect(calls.find((c) => c.path === "/api/queue/create"), "no qitem created on a broken pack").toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/gone\.md/);
  });

  it("create --body-context 与 --body 互斥", async () => {
    const { deps, calls } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "create",
      "--source", "alice@rig", "--destination", "bob@rig",
      "--body", "x", "--body-context", "packs/brief", "--summary", "x",
    ]);
    expect(calls.find((c) => c.path === "/api/queue/create")).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/互斥/);
  });

  it("create --no-nudge 向 daemon 传 nudge: false（冷队列退出）", async () => {
    const { deps, calls } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "create",
      "--source", "alice@rig",
      "--destination", "bob@rig",
      "--body", "cold",
      "--no-nudge",
    ]);
    const create = calls.find((c) => c.path === "/api/queue/create");
    expect((create!.body as { nudge: boolean }).nudge).toBe(false);
  });

  it("create --verify 等待既有网关回执，并保持持久化、连接器验收与读取者彼此区分", async () => {
    const id = "qitem-human-verify";
    const { deps, calls } = makeDeps({
      routes: {
        "POST /api/queue/create": { status: 201, data: { qitemId: id, state: "pending", destinationSession: "founder@external" } },
        [`GET /api/queue/${id}`]: [
          { status: 200, data: { qitemId: id, deliveryOutcome: null } },
          { status: 200, data: { qitemId: id, deliveryOutcome: "posted" } },
        ],
      },
    });
    deps.deliveryVerify = { timeoutMs: 50, intervalMs: 0, sleep: async () => {} };
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "create",
      "--destination", "founder@external",
      "--body", "Please decide",
      "--summary", "Founder decision",
      "--evidence-ref", "proof/decision.md",
      "--verify",
      "--json",
    ]);
    const out = JSON.parse(logs.at(-1)!) as Record<string, unknown>;
    expect(out).toMatchObject({
      qitemId: id,
      persisted: true,
      delivery: {
        outcome: "posted",
        connectorAccepted: true,
        humanReadership: "unknown",
      },
    });
    expect(calls.filter((call) => call.method === "POST" && call.path === "/api/queue/create")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "GET" && call.path === `/api/queue/${id}`)).toHaveLength(2);
  });

  it("create --verify 不确定即超时，不重试也不削弱持久化的 create", async () => {
    const id = "qitem-human-pending";
    const { deps, calls } = makeDeps({
      routes: {
        "POST /api/queue/create": { status: 201, data: { qitemId: id, state: "pending" } },
        [`GET /api/queue/${id}`]: { status: 200, data: { qitemId: id, deliveryOutcome: null } },
      },
    });
    let now = 0;
    deps.deliveryVerify = { timeoutMs: 2, intervalMs: 0, sleep: async () => { now += 2; }, now: () => now };
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "create",
      "--destination", "founder@external", "--body", "Please decide", "--summary", "Founder decision", "--evidence-ref", "proof/decision.md", "--verify", "--json",
    ]);
    const out = JSON.parse(logs.at(-1)!) as Record<string, unknown>;
    expect(out).toMatchObject({
      qitemId: id,
      persisted: true,
      delivery: {
        outcome: "still-pending",
        connectorAccepted: null,
        humanReadership: "unknown",
        nextAction: `zrig queue show ${id} --json`,
      },
    });
    expect(calls.filter((call) => call.method === "POST" && call.path === "/api/queue/create")).toHaveLength(1);
  });

  it.each(["transport-failed", "never-posted"] as const)(
    "create --verify returns the terminal %s receipt without retrying",
    async (outcome) => {
      const id = `qitem-human-${outcome}`;
      const { deps, calls } = makeDeps({
        routes: {
          "POST /api/queue/create": { status: 201, data: { qitemId: id, state: "pending" } },
          [`GET /api/queue/${id}`]: { status: 200, data: { qitemId: id, deliveryOutcome: outcome, deliveryFailureDetail: `${outcome} detail` } },
        },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "queue", "create",
        "--destination", "founder@external", "--body", "Please decide", "--summary", "Founder decision", "--evidence-ref", "proof/decision.md", "--verify", "--json",
      ]);
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({
        persisted: true,
        delivery: { outcome, connectorAccepted: false, humanReadership: "unknown", detail: `${outcome} detail` },
      });
      expect(calls.filter((call) => call.method === "POST" && call.path === "/api/queue/create")).toHaveLength(1);
    },
  );

  it("投递校验把 HTTP 拒绝保留为 indeterminate", async () => {
    const result = await waitForDeliveryOutcome({ get: async <T>() => ({ status: 503, data: { error: "projection unavailable" } as T }) }, "qitem-human-http");
    expect(result).toMatchObject({ outcome: "indeterminate", connectorAccepted: null, humanReadership: "unknown" });
    expect(result.detail).toContain("HTTP 503");
  });

  it("投递校验把不可读回执报为 indeterminate，而非 rejected", async () => {
    const result = await waitForDeliveryOutcome(
      { get: async () => { throw new Error("daemon read timed out"); } } as never,
      "qitem-human-indeterminate",
    );
    expect(result).toMatchObject({
      outcome: "indeterminate",
      connectorAccepted: null,
      humanReadership: "unknown",
    });
  });

  // OPR.0.3.2.21.FR-4(a) — body 输入解析终结对
  // backtick 损坏类。三种可接受形状：--body 内联、
  // --body-file <path>、--body / --body-file - 表示 stdin。
  // --body / --body-file 必须二选一；互斥校验。
  describe("FR-4(a) — --body-file + stdin support", () => {
    it("resolveQueueBody：传 --body 时返回内联 body", async () => {
      const out = await resolveQueueBody({ body: "inline value" });
      expect(out).toBe("inline value");
    });

    it("resolveQueueBody：传 --body-file 时从文件路径读取", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-body-"));
      const bodyPath = path.join(tmp, "body.txt");
      const content = "Multi-line body with `raw backticks` and\nliteral newlines\n— this is the corruption class --body-file kills.";
      fs.writeFileSync(bodyPath, content, "utf8");
      try {
        const out = await resolveQueueBody({ bodyFile: bodyPath });
        expect(out).toBe(content);
        // 判别点：反引号损坏的 shell 类别被完全绕过，因为文件内容不发生任何 shell 替换。
        expect(out).toMatch(/`raw backticks`/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("resolveQueueBody：同时传 --body 与 --body-file 时抛三段式错误", async () => {
      await expect(resolveQueueBody({ body: "inline", bodyFile: "/tmp/x" })).rejects.toMatchObject({
        fact: expect.stringMatching(/互斥|歧义/),
        consequence: expect.stringMatching(/未执行/),
        action: expect.stringMatching(/只传一个/),
      });
    });

    it("resolveQueueBody：既不传 --body 也不传 --body-file 时抛三段式错误", async () => {
      await expect(resolveQueueBody({})).rejects.toMatchObject({
        fact: expect.stringMatching(/既没传/),
        consequence: expect.stringMatching(/未执行/),
        action: expect.stringMatching(/--body|--body-file/),
      });
    });

    it("resolveQueueBody：--body-file 路径不存在时抛三段式错误", async () => {
      await expect(resolveQueueBody({ bodyFile: "/tmp/this-path-does-not-exist-fr4a-test.md" })).rejects.toMatchObject({
        fact: expect.stringMatching(/不存在/),
        consequence: expect.stringMatching(/未执行/),
        action: expect.stringMatching(/检查路径/),
      });
    });

    // OPR.0.3.2.21.FR-4 清理（FR-4a CLEAR 上的非阻塞说明）：传给 --body-file 的目录过去会落到 fs.readFileSync，
    // 并浮出裸 Error("EISDIR: illegal operation on a directory")，consequence/action 为空。清理提交显式发出三段式形状，使该错误与其他 body 解析错误读数一致。
    // failure modes.
    it("resolveQueueBody：--body-file 路径是目录（非普通文件）时抛三段式错误", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-body-isdir-"));
      try {
        await expect(resolveQueueBody({ bodyFile: tmp })).rejects.toMatchObject({
          fact: expect.stringMatching(/不是普通文件/),
          consequence: expect.stringMatching(/未执行/),
          action: expect.stringMatching(/可读文件/),
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("resolveQueueBody：--body 为 - 时调用注入的 stdin 读取器", async () => {
      const stdinReader = vi.fn(async () => "from stdin\n");
      const out = await resolveQueueBody({ body: "-" }, stdinReader);
      expect(out).toBe("from stdin\n");
      expect(stdinReader).toHaveBeenCalledTimes(1);
    });

    it("resolveQueueBody：--body-file 为 - 时调用注入的 stdin 读取器", async () => {
      const stdinReader = vi.fn(async () => "from stdin file dash\n");
      const out = await resolveQueueBody({ bodyFile: "-" }, stdinReader);
      expect(out).toBe("from stdin file dash\n");
      expect(stdinReader).toHaveBeenCalledTimes(1);
    });

    it("S4b RED：以来源感知的三段式指引拒绝空 --body-file", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-body-empty-"));
      const bodyPath = path.join(tmp, "empty.md");
      fs.writeFileSync(bodyPath, "", "utf8");
      try {
        await expect(resolveQueueBody({ bodyFile: bodyPath })).rejects.toMatchObject({
          fact: expect.stringMatching(new RegExp(`0 字节|空正文.*${path.basename(bodyPath)}`, "i")),
          consequence: expect.stringMatching(/未持久化|未联系后台服务/i),
          action: expect.stringMatching(/加上内容|非空/i),
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("S4b RED：拒绝空 stdin，并在任何队列持久化之前点名 stdin", async () => {
      await expect(resolveQueueBody({ bodyFile: "-" }, async () => "")).rejects.toMatchObject({
        fact: expect.stringMatching(/0 字节|空.*stdin/i),
        consequence: expect.stringMatching(/未持久化|未联系后台服务/i),
        action: expect.stringMatching(/送入|非空/i),
      });
    });

    it("S4b RED：空文件在 daemon 持久化行之前中止队列 create", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-create-empty-"));
      const bodyPath = path.join(tmp, "empty.md");
      fs.writeFileSync(bodyPath, "", "utf8");
      try {
        const { deps, calls } = makeDeps();
        const program = createProgram({ queueDeps: deps });
        program.exitOverride();
        await program.parseAsync([
          "node", "rig", "queue", "create",
          "--destination", "bob@rig",
          "--body-file", bodyPath,
          "--json",
        ]);
        expect(process.exitCode).toBe(1);
        expect(calls.some((call) => call.method === "POST" && call.path === "/api/queue/create")).toBe(false);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("create --body-file <含反引号文件> 把文件内容作为 body POST（操作者复制粘贴安全）", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-create-body-file-"));
      const bodyPath = path.join(tmp, "body.txt");
      const content = "Per-commit handoff for OPR.X.Y.Z\n\n```bash\nrig queue handoff qitem-1 --to next@rig\n```\n\nDone.";
      fs.writeFileSync(bodyPath, content, "utf8");
      try {
        const { deps, calls } = makeDeps({
          routes: { "POST /api/queue/create": { status: 201, data: { qitemId: "qitem-fr4a-1", state: "pending" } } },
        });
        const program = createProgram({ queueDeps: deps });
        program.exitOverride();
        await program.parseAsync([
          "node", "rig", "queue", "create",
          "--source", "alice@rig",
          "--destination", "bob@rig",
          "--body-file", bodyPath,
          "--json",
        ]);
        const create = calls.find((c) => c.path === "/api/queue/create");
        expect(create, "expected POST /api/queue/create to fire").toBeDefined();
        const body = create!.body as Record<string, unknown>;
        expect(body.body).toBe(content);
        // 判别点：反引号围栏完好无损，证明 shell 替换类别从未触及内容。
        expect((body.body as string)).toMatch(/```bash[\s\S]*?```/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("同时传 --body 与 --body-file 的 create 以退出 1 + 三段式错误失败，且不联系 daemon", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-create-conflict-"));
      const bodyPath = path.join(tmp, "body.txt");
      fs.writeFileSync(bodyPath, "x", "utf8");
      try {
        const { deps, calls } = makeDeps();
        const program = createProgram({ queueDeps: deps });
        program.exitOverride();
        const prevExit = process.exitCode;
        process.exitCode = undefined;
        try {
          await program.parseAsync([
            "node", "rig", "queue", "create",
            "--source", "alice@rig",
            "--destination", "bob@rig",
            "--body", "inline",
            "--body-file", bodyPath,
            "--json",
          ]);
          expect(process.exitCode).toBe(1);
          expect(calls.find((c) => c.path === "/api/queue/create")).toBeUndefined();
        } finally {
          process.exitCode = prevExit;
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("既不传 --body 也不传 --body-file 的 create 以退出 1 失败，且不联系 daemon", async () => {
      const { deps, calls } = makeDeps();
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      const prevExit = process.exitCode;
      process.exitCode = undefined;
      try {
        await program.parseAsync([
          "node", "rig", "queue", "create",
          "--source", "alice@rig",
          "--destination", "bob@rig",
          "--json",
        ]);
        expect(process.exitCode).toBe(1);
        expect(calls.find((c) => c.path === "/api/queue/create")).toBeUndefined();
      } finally {
        process.exitCode = prevExit;
      }
    });
  });

  // OPR.0.3.2.21.FR-4(b) — --mission / --slice 一等 flag
  // 译为 mission:<id> / slice:<id> 标签，并与 --tags 组合。
  // 这只是标签形式化——无 schema 变更；qitem 仍以扁平列表存储 tags。
  describe("FR-4(b) — --mission / --slice first-class flag-formalization", () => {
    it("--mission 译为 mission:<id> 标签", async () => {
      const { deps, calls } = makeDeps({
        routes: { "POST /api/queue/create": { status: 201, data: { qitemId: "q-fr4b-1" } } },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "queue", "create",
        "--source", "alice@rig",
        "--destination", "bob@rig",
        "--body", "x",
        "--mission", "release-0.3.2",
        "--json",
      ]);
      const create = calls.find((c) => c.path === "/api/queue/create");
      expect((create!.body as { tags: string[] }).tags).toEqual(["mission:release-0.3.2"]);
    });

    it("--slice 译为 slice:<id> 标签", async () => {
      const { deps, calls } = makeDeps({
        routes: { "POST /api/queue/create": { status: 201, data: { qitemId: "q-fr4b-2" } } },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "queue", "create",
        "--source", "alice@rig",
        "--destination", "bob@rig",
        "--body", "x",
        "--slice", "21-fr-4-queue-ergonomics",
        "--json",
      ]);
      const create = calls.find((c) => c.path === "/api/queue/create");
      expect((create!.body as { tags: string[] }).tags).toEqual(["slice:21-fr-4-queue-ergonomics"]);
    });

    it("--mission + --slice + --tags 合并三者（mission/slice 在前，--tags 追加）并去重", async () => {
      const { deps, calls } = makeDeps({
        routes: { "POST /api/queue/create": { status: 201, data: { qitemId: "q-fr4b-3" } } },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "queue", "create",
        "--source", "alice@rig",
        "--destination", "bob@rig",
        "--body", "x",
        "--mission", "release-0.3.2",
        "--slice", "21-fr-4-queue-ergonomics",
        "--tags", "gate:guard,handoff:per-commit",
        "--json",
      ]);
      const create = calls.find((c) => c.path === "/api/queue/create");
      expect((create!.body as { tags: string[] }).tags).toEqual([
        "mission:release-0.3.2",
        "slice:21-fr-4-queue-ergonomics",
        "gate:guard",
        "handoff:per-commit",
      ]);
    });

    it("--mission release-0.3.2 + --tags mission:release-0.3.2 去重冗余标签（保留一个 mission:X）", async () => {
      const { deps, calls } = makeDeps({
        routes: { "POST /api/queue/create": { status: 201, data: { qitemId: "q-fr4b-4" } } },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "queue", "create",
        "--source", "alice@rig",
        "--destination", "bob@rig",
        "--body", "x",
        "--mission", "release-0.3.2",
        "--tags", "mission:release-0.3.2,gate:guard",
        "--json",
      ]);
      const create = calls.find((c) => c.path === "/api/queue/create");
      const tags = (create!.body as { tags: string[] }).tags;
      expect(tags.filter((t) => t === "mission:release-0.3.2")).toHaveLength(1);
      expect(tags).toContain("gate:guard");
    });

    it("无 --mission/--slice/--tags → 线上 tags 为 undefined（保留旧行为）", async () => {
      const { deps, calls } = makeDeps({
        routes: { "POST /api/queue/create": { status: 201, data: { qitemId: "q-fr4b-5" } } },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "queue", "create",
        "--source", "alice@rig",
        "--destination", "bob@rig",
        "--body", "x",
        "--json",
      ]);
      const create = calls.find((c) => c.path === "/api/queue/create");
      expect((create!.body as { tags?: string[] }).tags).toBeUndefined();
    });
  });

  // OPR.0.4.3.16 — --gate <role> 一等 flag 盖一个 gate:<role> 标签，即 idle-gate watchdog 的集中谓词读取的生产者。
  describe("OPR.0.4.3.16 — --gate <role> gate-predicate producer", () => {
    it("create --gate guard 译为 gate:guard 标签", async () => {
      const { deps, calls } = makeDeps({
        routes: { "POST /api/queue/create": { status: 201, data: { qitemId: "q-gate-1" } } },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "queue", "create",
        "--source", "dev@rig",
        "--destination", "dev-guard@rig",
        "--body", "review this diff",
        "--gate", "guard",
        "--json",
      ]);
      const create = calls.find((c) => c.path === "/api/queue/create");
      expect((create!.body as { tags: string[] }).tags).toEqual(["gate:guard"]);
    });

    it("create --gate 与 --slice/--tags 组合并去重", async () => {
      const { deps, calls } = makeDeps({
        routes: { "POST /api/queue/create": { status: 201, data: { qitemId: "q-gate-2" } } },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "queue", "create",
        "--source", "dev@rig",
        "--destination", "spec-guard@rig",
        "--body", "x",
        "--slice", "16",
        "--gate", "spec-review",
        "--tags", "gate:spec-review,handoff:per-commit",
        "--json",
      ]);
      const create = calls.find((c) => c.path === "/api/queue/create");
      expect((create!.body as { tags: string[] }).tags).toEqual([
        "slice:16",
        "gate:spec-review",
        "handoff:per-commit",
      ]);
    });

    it("handoff --gate guard 在新 qitem 上译为 gate:guard 标签", async () => {
      const { deps, calls } = makeDeps({
        routes: { "POST /api/queue/q-src/handoff": { status: 201, data: { qitemId: "q-new" } } },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "queue", "handoff", "q-src",
        "--from", "dev@rig",
        "--to", "dev-guard@rig",
        "--gate", "guard",
        "--summary", "code review",
        "--json",
      ]);
      const handoff = calls.find((c) => c.path === "/api/queue/q-src/handoff");
      expect((handoff!.body as { tags: string[] }).tags).toEqual(["gate:guard"]);
    });
  });

  it("update --state done 不带 --closure-reason 时给出结构化 hot-potato 错误并不零退出", async () => {
    const { deps } = makeDeps({
      routes: {
        "POST /api/queue/qitem-x/update": {
          status: 400,
          data: {
            error: "missing_closure_reason",
            message: "state=done requires closure_reason; valid values: handed_off_to, blocked_on, denied, canceled, no-follow-on, escalation",
            validReasons: ["handed_off_to", "blocked_on", "denied", "canceled", "no-follow-on", "escalation"],
          },
        },
      },
    });
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "update", "qitem-x",
      "--actor", "bob@rig",
      "--state", "done",
      "--json",
    ]);
    expect(process.exitCode).toBe(1);
    const out = logs.join("\n");
    expect(out).toContain("missing_closure_reason");
    expect(out).toContain("validReasons");
  });

  it("update 可只带 note 不带 state", async () => {
    const { deps, calls } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();

    await program.parseAsync([
      "node", "rig", "queue", "update", "qitem-note",
      "--note", "audit bytes",
      "--json",
    ]);

    expect(calls.find((c) => c.path === "/api/queue/qitem-note/update")?.body).toEqual({
      state: undefined,
      reopen: undefined,
      closureReason: undefined,
      closureTarget: undefined,
      blockedOn: undefined,
      summary: undefined,
      evidenceRef: undefined,
      transitionNote: "audit bytes",
    });
  });

  it("update 转发显式 reopen 确认", async () => {
    const { deps, calls } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();

    await program.parseAsync([
      "node", "rig", "queue", "update", "qitem-reopen",
      "--state", "pending",
      "--note", "repair",
      "--reopen",
      "--json",
    ]);

    expect(calls.find((c) => c.path === "/api/queue/qitem-reopen/update")?.body).toMatchObject({
      state: "pending",
      reopen: true,
      transitionNote: "repair",
    });
  });

  it("S03：block 转发续接与一个原子计时器唤醒", async () => {
    const { deps, calls } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "block", "qitem-park",
      "--on", "external:cooldown",
      "--continuation", "resume after the cooldown",
      "--wake-after", "90s",
      "--json",
    ]);
    expect(calls.find((c) => c.path === "/api/queue/qitem-park/update")?.body).toMatchObject({
      state: "blocked",
      blockedOn: "external:cooldown",
      transitionNote: "continuation: resume after the cooldown",
      wakeAfterSeconds: 90,
    });
  });

  it("S03：block help 讲清所有唤醒路径与 workspace 规则", () => {
    const { deps } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    const block = program.commands.find((c) => c.name() === "queue")?.commands.find((c) => c.name() === "block");
    const help = block?.helpInformation() ?? "";
    expect(help).toMatch(/watchdog id/i);
    expect(help).toMatch(/定时器/);
    expect(help).toMatch(/存活阻塞者/);
    expect(help).toMatch(/被推迟.*不紧迫/);
  });

  it("handoff-and-complete 不带 body fromSession——交出席位派生自传输头（X-OpenRig-Session）；--from 被丢弃，--to 仍为目标", async () => {
    const saved = process.env["OPENRIG_SESSION_NAME"];
    process.env["OPENRIG_SESSION_NAME"] = "bob@rig"; // the seat env == the X-OpenRig-Session the DaemonClient stamps
    try {
      const { deps, calls } = makeDeps({
        routes: {
          "POST /api/queue/qitem-src/handoff-and-complete": {
            status: 201,
            data: {
              closed: { state: "done", closureReason: "handed_off_to" },
              created: { state: "pending", qitemId: "qitem-new" },
            },
          },
        },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "queue", "handoff-and-complete", "qitem-src",
        "--from", "forged@evil", // P21: IGNORED — must not ride the body
        "--to", "carol@rig",
        "--body", "carol's piece",
        "--json",
      ]);
      const call = calls.find((c) => c.path === "/api/queue/qitem-src/handoff-and-complete");
      expect(call).toBeDefined();
      const body = call!.body as Record<string, unknown>;
      // P21 I3 调和：不带 body 身份声明——daemon 从 header 派生 fromSession，伪造的 --from 被丢弃。toSession 是 TARGET，属合法 body 字段。
      expect(body.fromSession).toBeUndefined();
      expect(body.toSession).toBe("carol@rig");
      expect(body.body).toBe("carol's piece");
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_SESSION_NAME"];
      else process.env["OPENRIG_SESSION_NAME"] = saved;
    }
  });

  it("whoami 带 session + recentLimit 查询参数 GET /api/queue/whoami", async () => {
    const { deps, calls } = makeDeps({
      routes: {
        "GET /api/queue/whoami?session=bob%40rig&recentLimit=10": {
          status: 200,
          data: {
            session: "bob@rig",
            asDestination: { pending: 2, inProgress: 1, blocked: 0, recent: [] },
            asSource: { total: 5 },
          },
        },
      },
    });
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "whoami",
      "--session", "bob@rig",
      "--recent-limit", "10",
      "--json",
    ]);
    const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/queue/whoami"));
    expect(call).toBeDefined();
    expect(call!.path).toContain("session=bob%40rig");
    expect(call!.path).toContain("recentLimit=10");
  });

  it("whoami 在省略 --session 时从 OPENRIG_SESSION_NAME 默认会话", async () => {
    const saved = process.env["OPENRIG_SESSION_NAME"];
    process.env["OPENRIG_SESSION_NAME"] = "bob@rig";
    try {
      const { deps, calls } = makeDeps({
        routes: {
          "GET /api/queue/whoami?session=bob%40rig&recentLimit=25": {
            status: 200,
            data: {
              session: "bob@rig",
              asDestination: { pending: 1, inProgress: 0, blocked: 0, recent: [] },
              asSource: { total: 0 },
            },
          },
        },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "whoami", "--json"]);

      const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/queue/whoami"));
      expect(call).toBeDefined();
      expect(call!.path).toContain("session=bob%40rig");
      expect(call!.path).toContain("recentLimit=25");
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_SESSION_NAME"];
      else process.env["OPENRIG_SESSION_NAME"] = saved;
    }
  });

  it("claim 不带 body destinationSession——认领者派生自传输头（X-OpenRig-Session）；env 存在 ⇒ 触发 POST", async () => {
    const saved = process.env["OPENRIG_SESSION_NAME"];
    process.env["OPENRIG_SESSION_NAME"] = "bob@rig";
    try {
      const { deps, calls } = makeDeps({
        routes: {
          "POST /api/queue/qitem-x/claim": {
            status: 200,
            data: { qitemId: "qitem-x", destinationSession: "bob@rig", state: "in-progress" },
          },
        },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "claim", "qitem-x", "--json"]);

      const call = calls.find((c) => c.path === "/api/queue/qitem-x/claim");
      expect(call).toBeDefined();
      // P21 I3 调和：认领者不是 body 声明——daemon 从 header 派生它。
      // X-OpenRig-Session header（env 存在 ⇒ 预检通过 ⇒ POST 触发）。无可伪造的 body 字段。
      expect((call!.body as Record<string, unknown>).destinationSession).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_SESSION_NAME"];
      else process.env["OPENRIG_SESSION_NAME"] = saved;
    }
  });

  it("update 不带 body actorSession——执行者派生自传输头（X-OpenRig-Session）；env 存在 ⇒ 触发 POST", async () => {
    const saved = process.env["OPENRIG_SESSION_NAME"];
    process.env["OPENRIG_SESSION_NAME"] = "bob@rig";
    try {
      const { deps, calls } = makeDeps({
        routes: {
          "POST /api/queue/qitem-x/update": {
            status: 200,
            data: { qitemId: "qitem-x", state: "done", closureReason: "no-follow-on" },
          },
        },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "queue", "update", "qitem-x",
        "--state", "done",
        "--closure-reason", "no-follow-on",
        "--json",
      ]);

      const call = calls.find((c) => c.path === "/api/queue/qitem-x/update");
      expect(call).toBeDefined();
      // P21 I3 调和：执行者不是 body 声明——daemon 从 header 派生它。
      expect((call!.body as Record<string, unknown>).actorSession).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_SESSION_NAME"];
      else process.env["OPENRIG_SESSION_NAME"] = saved;
    }
  });

  it("handoff 不带 body fromSession——交出席位派生自传输头（X-OpenRig-Session）；env 存在 ⇒ 触发 POST", async () => {
    const saved = process.env["OPENRIG_SESSION_NAME"];
    process.env["OPENRIG_SESSION_NAME"] = "bob@rig";
    try {
      const { deps, calls } = makeDeps({
        routes: {
          "POST /api/queue/qitem-x/handoff": {
            status: 201,
            data: { closed: { state: "handed-off" }, created: { qitemId: "qitem-new" } },
          },
        },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync([
        "node", "rig", "queue", "handoff", "qitem-x",
        "--to", "carol@rig",
        "--json",
      ]);

      const call = calls.find((c) => c.path === "/api/queue/qitem-x/handoff");
      expect(call).toBeDefined();
      // P21 I3 调和：交出席位不是 body 声明——daemon 从 header 派生它。
      expect((call!.body as Record<string, unknown>).fromSession).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env["OPENRIG_SESSION_NAME"];
      else process.env["OPENRIG_SESSION_NAME"] = saved;
    }
  });

  it("向未知目标 rig 的 create 浮出 400 错误并不零退出", async () => {
    const { deps } = makeDeps({
      routes: {
        "POST /api/queue/create": {
          status: 400,
          data: {
            error: "unknown_destination_rig",
            message: "destination_session bob@phantom-rig references an unknown rig",
          },
        },
      },
    });
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "create",
      "--source", "alice@known-rig",
      "--destination", "bob@phantom-rig",
      "--body", "x",
      "--json",
    ]);
    expect(process.exitCode).toBe(1);
    const out = logs.join("\n");
    expect(out).toContain("unknown_destination_rig");
  });

  it("本地 health probe 不结论时，queue create --host 仍尝试真实写入并浮出 daemon 响应", async () => {
    vi.stubEnv("OPENRIG_URL", "http://127.0.0.1:7766");
    const { getDaemonStatus } = await import("../src/daemon-lifecycle.js");
    vi.mocked(getDaemonStatus).mockResolvedValueOnce({ state: "stopped" });
    const { deps, calls } = makeDeps({
      routes: {
        "POST /api/queue/create": {
          status: 400,
          data: {
            error: "unknown_destination_rig",
            message: "destination_session bob@phantom-rig references an unknown rig",
          },
        },
      },
    });
    const clientUrls: string[] = [];
    const clientFactory = deps.clientFactory;
    deps.clientFactory = (baseUrl) => {
      clientUrls.push(baseUrl);
      return clientFactory(baseUrl);
    };
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "create",
      "--source", "alice@known-rig",
      "--destination", "bob@phantom-rig",
      "--host", "remote-a",
      "--body", "x",
      "--json",
    ]);

    expect(calls).toContainEqual({
      method: "POST",
      path: "/api/queue/create",
      body: expect.objectContaining({ hostId: "remote-a" }),
    });
    expect(clientUrls).toEqual(["http://127.0.0.1:7766"]);
    expect(logs.join("\n")).toContain("unknown_destination_rig");
    expect(errors.join("\n")).not.toContain("后台服务未运行");
    expect(process.exitCode).toBe(1);
  });

  it("daemon probe 确认无可达操作目标时，普通本地 queue create 仍被阻止", async () => {
    const { getDaemonStatus } = await import("../src/daemon-lifecycle.js");
    vi.mocked(getDaemonStatus).mockResolvedValueOnce({ state: "stopped" });
    const { deps, calls } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();

    await program.parseAsync([
      "node", "rig", "queue", "create",
      "--source", "alice@known-rig",
      "--destination", "bob@known-rig",
      "--body", "x",
      "--json",
    ]);

    expect(calls).toEqual([]);
    expect(errors.join("\n")).toContain("后台服务未运行");
    expect(process.exitCode).toBe(1);
  });

  it("handoff --no-nudge 向 daemon 传 nudge: false", async () => {
    const { deps, calls } = makeDeps({
      routes: {
        "POST /api/queue/qitem-x/handoff": {
          status: 201,
          data: { closed: {}, created: {} },
        },
      },
    });
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "handoff", "qitem-x",
      "--from", "bob@rig",
      "--to", "carol@rig",
      "--no-nudge",
    ]);
    const call = calls.find((c) => c.path === "/api/queue/qitem-x/handoff");
    expect((call!.body as { nudge: boolean }).nudge).toBe(false);
  });

  it("list 构造带过滤参数的 /api/queue/list", async () => {
    const { deps, calls } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "list",
      "--destination", "bob@rig",
      "--state", "pending",
      "--limit", "50",
      "--json",
    ]);
    const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/queue/list"));
    expect(call).toBeDefined();
    expect(call!.path).toContain("destinationSession=bob%40rig");
    expect(call!.path).toContain("state=pending");
    expect(call!.path).toContain("limit=50");
    expect(call!.path).toContain("compact=1");
    expect(call!.path).not.toContain("as=");
    expect(call!.path).not.toContain("rig=");
  });

  it("list -a 含历史（无 activeOnly 参数）", async () => {
    const saved = process.env.OPENRIG_SESSION_NAME;
    process.env.OPENRIG_SESSION_NAME = "dev1@my-rig";
    try {
      const { deps, calls } = makeDeps();
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "list", "-a", "--json"]);
      const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/queue/list"));
      expect(call).toBeDefined();
      expect(call!.path).not.toContain("activeOnly=");
      expect(call!.path).toContain("rig=my-rig");
      expect(call!.path).toContain("compact=1");
    } finally {
      if (saved === undefined) delete process.env.OPENRIG_SESSION_NAME;
      else process.env.OPENRIG_SESSION_NAME = saved;
    }
  });

  it("list -A is cross-rig (no rig param)", async () => {
    const saved = process.env.OPENRIG_SESSION_NAME;
    process.env.OPENRIG_SESSION_NAME = "dev1@my-rig";
    try {
      const { deps, calls } = makeDeps();
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "list", "-A", "--json"]);
      const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/queue/list"));
      expect(call).toBeDefined();
      expect(call!.path).not.toContain("rig=");
      expect(call!.path).toContain("activeOnly=1");
      expect(call!.path).toContain("compact=1");
    } finally {
      if (saved === undefined) delete process.env.OPENRIG_SESSION_NAME;
      else process.env.OPENRIG_SESSION_NAME = saved;
    }
  });

  it("list --full --all --all-rigs = firehose (no compact, no active, no rig)", async () => {
    const { deps, calls } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync(["node", "rig", "queue", "list", "--full", "--all", "--all-rigs", "--json"]);
    const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/queue/list"));
    expect(call).toBeDefined();
    expect(call!.path).not.toContain("compact=");
    expect(call!.path).not.toContain("activeOnly=");
    expect(call!.path).not.toContain("rig=");
    expect(call!.path).not.toContain("as=");
  });

  it("list 带 --destination 时不注入隐式 rig 范围", async () => {
    const saved = process.env.OPENRIG_SESSION_NAME;
    process.env.OPENRIG_SESSION_NAME = "my-seat@my-rig";
    try {
      const { deps, calls } = makeDeps();
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "list", "--destination", "bob@rig", "--json"]);
      const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/queue/list"));
      expect(call).toBeDefined();
      expect(call!.path).toContain("destinationSession=bob%40rig");
      expect(call!.path).toContain("compact=1");
      expect(call!.path).not.toContain("rig=");
      expect(call!.path).not.toContain("as=");
    } finally {
      if (saved === undefined) delete process.env.OPENRIG_SESSION_NAME;
      else process.env.OPENRIG_SESSION_NAME = saved;
    }
  });

  it("list --mine 限定为调用者会话", async () => {
    const saved = process.env.OPENRIG_SESSION_NAME;
    process.env.OPENRIG_SESSION_NAME = "dev1-driver@openrig-delivery";
    try {
      const { deps, calls } = makeDeps();
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "list", "--mine", "--json"]);
      const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/queue/list"));
      expect(call).toBeDefined();
      expect(call!.path).toContain("as=dev1-driver%40openrig-delivery");
      expect(call!.path).not.toContain("rig=");
    } finally {
      if (saved === undefined) delete process.env.OPENRIG_SESSION_NAME;
      else process.env.OPENRIG_SESSION_NAME = saved;
    }
  });

  it("S4b RED：list --owned 只限定 destination 为调用者的行", async () => {
    const saved = process.env.OPENRIG_SESSION_NAME;
    process.env.OPENRIG_SESSION_NAME = "dev1-driver@openrig-delivery";
    try {
      const { deps, calls } = makeDeps();
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "list", "--owned", "--json"]);
      const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/queue/list"));
      expect(call).toBeDefined();
      expect(call!.path).toContain("destinationSession=dev1-driver%40openrig-delivery");
      expect(call!.path).not.toContain("as=");
      expect(call!.path).not.toContain("sourceSession=");
      expect(call!.path).not.toContain("rig=");
    } finally {
      if (saved === undefined) delete process.env.OPENRIG_SESSION_NAME;
      else process.env.OPENRIG_SESSION_NAME = saved;
    }
  });

  it("S4b final RED：list --owned 缺任一席位身份时在任何 GET 之前拒绝", async () => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "");
    vi.stubEnv("RIGGED_SESSION_NAME", "");
    const { deps, calls } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();

    await program.parseAsync(["node", "rig", "queue", "list", "--owned", "--json"]);

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/--owned.*OPENRIG_SESSION_NAME.*RIGGED_SESSION_NAME/i);
    expect(calls.some((call) => call.method === "GET" && call.path.startsWith("/api/queue/list"))).toBe(false);
  });

  it("S4b RED：list help 区分 destination 所属义务与 --mine 的 authored 并集", () => {
    const { deps } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    const queue = program.commands.find((command) => command.name() === "queue")!;
    const list = queue.commands.find((command) => command.name() === "list")!;
    const help = list.helpInformation();
    expect(help).toMatch(/--owned[^\n]*(指派|义务|destination)/);
    expect(help).toMatch(/--mine[^\n]*(source 或 destination|撰写但不拥有)/);
  });

  it("list 默认注入 rig=<rigName> + activeOnly=1 + compact=1", async () => {
    const saved = process.env.OPENRIG_SESSION_NAME;
    process.env.OPENRIG_SESSION_NAME = "dev1-driver@openrig-delivery";
    try {
      const { deps, calls } = makeDeps();
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "list", "--json"]);
      const call = calls.find((c) => c.method === "GET" && c.path.startsWith("/api/queue/list"));
      expect(call).toBeDefined();
      expect(call!.path).toContain("rig=openrig-delivery");
      expect(call!.path).toContain("activeOnly=1");
      expect(call!.path).toContain("compact=1");
      expect(call!.path).not.toContain("as=");
    } finally {
      if (saved === undefined) delete process.env.OPENRIG_SESSION_NAME;
      else process.env.OPENRIG_SESSION_NAME = saved;
    }
  });

  // OPR.0.4.3.03 — `rig queue show` body preview + `--full` compatibility.
  // Bound + bodyTruncated 基于码点计数（IMPL-SPEC §2.3-2.4）；
  // bodyBytes 是诚实的真实 UTF-8 总字节数。
  describe("queue show body preview (OPR.0.4.3.03)", () => {
    const PREVIEW_MAX_CODEPOINTS = 512;

    function showRoute(item: unknown, id = "qitem-1") {
      return makeDeps({ routes: { [`GET /api/queue/${id}`]: { status: 200, data: item } } });
    }

    // --- previewBody helper (unit) ---

    it("previewBody: empty body → preview '', 0 bytes, not truncated", () => {
      expect(previewBody("")).toEqual({ preview: "", bodyBytes: 0, bodyTruncated: false });
    });

    it("previewBody：低于上限的小 body → 完整 body、诚实字节数，不截断", () => {
      const small = "hello world";
      expect(previewBody(small)).toEqual({
        preview: small,
        bodyBytes: Buffer.byteLength(small, "utf8"),
        bodyTruncated: false,
      });
    });

    it("previewBody：恰为 512 code point 的 body → 不截断（边界含端点）", () => {
      const exact = "z".repeat(512);
      expect(previewBody(exact)).toEqual({ preview: exact, bodyBytes: 512, bodyTruncated: false });
    });

    it("previewBody：超大 body（>512 code point）→ 截断，诚实 bodyBytes=真实总数，preview=前 512 code point", () => {
      const body = "x".repeat(1000);
      const out = previewBody(body);
      expect(out.bodyTruncated).toBe(true);
      expect(out.bodyBytes).toBe(1000); // honest total, not the preview length
      expect(Array.from(out.preview).length).toBe(PREVIEW_MAX_CODEPOINTS);
      expect(out.preview).toBe("x".repeat(512));
    });

    it("previewBody：多字节 body >512 code point → 在干净 code point 边界切 512 code point（合法 UTF-8，不劈代理对）", () => {
      // 4 字节 emoji（astral，UTF-16 中为代理对）。600 个 = 600 code point。
      // 码点 / 2400 字节 → 超过 512 码点上限。
      const emoji = "😀"; // 4 UTF-8 bytes, 1 code point, 2 UTF-16 units
      const body = emoji.repeat(600);
      const out = previewBody(body);
      expect(out.bodyTruncated).toBe(true); // 600 code points > 512
      expect(out.bodyBytes).toBe(2400); // honest total byte size
      // preview 恰为前 512 code point（每个都是完整 emoji）……
      expect(Array.from(out.preview).length).toBe(512);
      expect([...out.preview].every((ch) => ch === emoji)).toBe(true);
      // ……并在干净 code point 边界结束：重编码往返一致，不会因劈开序列产生孤立代理对 / U+FFFD 替换符。
      expect(Buffer.byteLength(out.preview, "utf8")).toBe(512 * 4);
      const roundTrip = Buffer.from(out.preview, "utf8").toString("utf8");
      expect(roundTrip).toBe(out.preview);
      expect(roundTrip).not.toContain("�");
    });

    // --- show 命令（经 program 端到端）---

    it("show 默认：超大 body → preview + 标记行 + 诚实 bodyBytes + bodyTruncated=true（人类可读）", async () => {
      const full = "A".repeat(1000);
      const { deps } = showRoute({ qitemId: "qitem-1", state: "pending", body: full });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "show", "qitem-1"]);
      const printed = JSON.parse(logs[0]);
      expect(printed.bodyTruncated).toBe(true);
      expect(printed.bodyBytes).toBe(1000);
      expect(Array.from(printed.body).length).toBe(512);
      // 标记行单独占一行，并给出诚实的总字节大小
      expect(logs.join("\n")).toContain("有界预览——完整正文 1000 字节；完整记录");
      expect(logs.join("\n")).toContain("rig queue show 'qitem-1' --full --json");
      expect(logs.join("\n")).not.toMatch(/\btruncated\b/i);
    });

    it("show default: small body → full body, NO marker, bodyTruncated=false", async () => {
      const { deps } = showRoute({ qitemId: "qitem-1", body: "short body" });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "show", "qitem-1"]);
      const printed = JSON.parse(logs[0]);
      expect(printed.body).toBe("short body");
      expect(printed.bodyTruncated).toBe(false);
      expect(printed.bodyBytes).toBe(10);
      expect(logs.join("\n")).not.toContain("truncated");
    });

    it("show default: empty body → bodyBytes 0, bodyTruncated=false, no marker, no crash", async () => {
      const { deps } = showRoute({ qitemId: "qitem-1", body: "" });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "show", "qitem-1"]);
      const printed = JSON.parse(logs[0]);
      expect(printed.body).toBe("");
      expect(printed.bodyBytes).toBe(0);
      expect(printed.bodyTruncated).toBe(false);
      expect(logs.join("\n")).not.toContain("truncated");
      expect(process.exitCode).not.toBe(1);
    });

    it("show 默认 --json：携带 preview + bodyBytes + bodyTruncated（JSON 对齐）", async () => {
      const full = "B".repeat(1000);
      const { deps } = showRoute({ qitemId: "qitem-1", body: full });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "show", "qitem-1", "--json"]);
      expect(logs.length).toBe(1); // compact single-line JSON, no separate marker line
      const printed = JSON.parse(logs[0]);
      expect(printed.bodyTruncated).toBe(true);
      expect(printed.bodyBytes).toBe(1000);
      expect(Array.from(printed.body).length).toBe(PREVIEW_MAX_CODEPOINTS);
    });

    it("show --full --json：字节级一致的完整 item body（兼容性契约——无 preview 字段）", async () => {
      const item = { qitemId: "qitem-1", state: "pending", body: "C".repeat(1000), chain_of_record: [{ a: 1 }] };
      const { deps } = showRoute(item);
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "show", "qitem-1", "--full", "--json"]);
      // 与 item 的原始 JSON.stringify 字节级一致（当前形状）。
      expect(logs[0]).toBe(JSON.stringify(item));
      const printed = JSON.parse(logs[0]);
      expect(printed.body).toBe("C".repeat(1000)); // complete, untruncated
      expect(printed).not.toHaveProperty("bodyBytes");
      expect(printed).not.toHaveProperty("bodyTruncated");
    });

    it("show --full (human): complete body, no preview fields, no marker", async () => {
      const full = "D".repeat(1000);
      const item = { qitemId: "qitem-1", body: full, chain_of_record: [] };
      const { deps } = showRoute(item);
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await program.parseAsync(["node", "rig", "queue", "show", "qitem-1", "--full"]);
      const printed = JSON.parse(logs[0]);
      expect(printed.body).toBe(full);
      expect(printed).not.toHaveProperty("bodyBytes");
      expect(printed).not.toHaveProperty("bodyTruncated");
      expect(logs.join("\n")).not.toContain("truncated");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // slice-08 OPR.0.4.7.8 — queue verb-surface body-input parity (TEST-ONLY RED).
  // 生产 queue.ts 尚未改；这些钉住 atomic-A 契约，使其今日失败、四动词走通发货路径后通过。
  // resolveQueueBody。锚点基于 4b05f970；锁定 spec sha b2db0f2b。
  //
  // 按 guard 规则分类（诚实，逐输入）：
  //   GENUINE RED（今日失败）：--body-file 精确 POST ×4；--body - stdin 精确
  //     POST ×4；--help 记载 --body-file + stdin '-' ×4；命令中立的
  //     resolver 错误措辞。
  //   PRESERVATION GREEN（不得回归）：handoff/handoff-and-complete 二者皆无
  //     → POST body undefined（source-body 默认）；inbox-drop/outbox-record
  //     二者皆无 → 报错 + 无 POST（机制中立：今日 Commander requiredOption，
  //     明日 resolver 拒绝）。
  //   NEW-CAPABILITY GREEN：两源皆给 → 报错 + 无 POST（今日未知选项）。
  // 仅对全部 8 种 body 传输做精确相等；绝不用 length/contains。
  // ───────────────────────────────────────────────────────────────────────────
  describe("slice-08 OPR.0.4.7.8 — queue body-input parity", () => {
    // 字节可区分的 body：多行 + Unicode + 反引号——正是
    // file/stdin 输入会触发的损坏类。
    const DISCRIMINATOR =
      "line-1 `raw backticks`\nlíne-2 ünïcode ☑\n```bash\nrig queue handoff q --to x\n```\n";

    // 命令级 stdin 支架（Guard 指定）：把 process.stdin 换成携带精确字节的
    // 已结束 PassThrough；在 finally 中恢复原始描述符。Node22 process.stdin
    // 是 getter-only 但可配置，故 defineProperty 可行；PassThrough 不是 TTY，
    // 故 defaultStdinReader 会把它读到 EOF 而非短路空。
    // 把它读到 EOF 而非短路空。
    async function withStdin(bytes: string, fn: () => Promise<void>): Promise<void> {
      const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
      const prevExit = process.exitCode;
      const fake = new PassThrough();
      fake.end(bytes);
      Object.defineProperty(process, "stdin", { value: fake, configurable: true });
      try {
        await fn();
      } finally {
        // 恢复这个 helper 拥有的两个全局：stdin 描述符与 process.exitCode。若 process 原本没有自己的 stdin 描述符，则删除临时自有属性而非留装。
        if (originalStdin) Object.defineProperty(process, "stdin", originalStdin);
        else delete (process as unknown as Record<string, unknown>).stdin;
        process.exitCode = prevExit;
        fake.destroy();
      }
    }

    function verbSubcommand(program: ReturnType<typeof createProgram>, name: string) {
      const queue = program.commands.find((c) => c.name() === "queue")!;
      return queue.commands.find((c) => c.name() === name)!;
    }

    // 端点 + 必填 flag 锚定在 4b05f970。`argv` 是 `rig` 之后除 body flag 外的全部；`neither` 是该动词的无 body 契约。
    const VERBS = [
      {
        name: "handoff",
        argv: ["queue", "handoff", "q1", "--from", "a@rig", "--to", "b@rig"],
        pathMatch: (p: string) => p === "/api/queue/q1/handoff",
        neither: "undefined-body" as const,
      },
      {
        name: "handoff-and-complete",
        argv: ["queue", "handoff-and-complete", "q1", "--from", "a@rig", "--to", "b@rig"],
        pathMatch: (p: string) => p === "/api/queue/q1/handoff-and-complete",
        neither: "undefined-body" as const,
      },
      {
        name: "inbox-drop",
        argv: ["queue", "inbox-drop", "b@rig", "--sender", "a@rig"],
        pathMatch: (p: string) => p === "/api/queue/inbox/drop",
        neither: "reject" as const,
      },
      {
        name: "outbox-record",
        argv: ["queue", "outbox-record", "--sender", "a@rig", "--destination", "b@rig"],
        pathMatch: (p: string) => p === "/api/queue/outbox/record",
        neither: "reject" as const,
      },
    ];

    // ── 步骤 1：在既有 create --body - 上做夹具校准（今日为绿）。
    // 先证明 process.stdin 交换技术可行，再让它承载任何 RED。
    it("校准（绿）：create --body - 把 stdin PassThrough 当作精确 POST body 消费", async () => {
      const { deps, calls } = makeDeps({
        routes: { "POST /api/queue/create": { status: 201, data: { qitemId: "q-cal", state: "pending" } } },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      await withStdin(DISCRIMINATOR, async () => {
        await program.parseAsync(["node", "rig", "queue", "create", "--source", "a@rig", "--destination", "b@rig", "--body", "-", "--json"]);
      });
      const post = calls.find((c) => c.path === "/api/queue/create");
      expect(post, "create should POST after consuming stdin").toBeDefined();
      expect((post!.body as Record<string, unknown>).body).toBe(DISCRIMINATOR);
    });

    // ── 真 RED ×4：--body-file 精确 POST body。
    for (const v of VERBS) {
      it(`RED: ${v.name} --body-file <path> POSTs the exact file bytes`, async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `s08-${v.name}-file-`));
        const bodyPath = path.join(tmp, "body.txt");
        fs.writeFileSync(bodyPath, DISCRIMINATOR, "utf8");
        const { deps, calls } = makeDeps();
        const program = createProgram({ queueDeps: deps });
        program.exitOverride();
        try {
          // 今日 --body-file 在这些动词上是未知选项；捕获 Commander 拒绝，使判别点是缺失/错误的 POST body，而非未捕获的解析器抛错。
          try {
            await program.parseAsync(["node", "rig", ...v.argv, "--body-file", bodyPath, "--json"]);
          } catch {
            /* expected Commander unknown-option today */
          }
          const post = calls.find((c) => v.pathMatch(c.path));
          expect(post, `${v.name} should POST the file body`).toBeDefined();
          expect((post!.body as Record<string, unknown>).body).toBe(DISCRIMINATOR);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      });
    }

    // ── 真 RED ×4：--body - stdin 精确 POST body。
    for (const v of VERBS) {
      it(`RED: ${v.name} --body - consumes stdin as the exact POST body`, async () => {
        const { deps, calls } = makeDeps();
        const program = createProgram({ queueDeps: deps });
        program.exitOverride();
        await withStdin(DISCRIMINATOR, async () => {
          try {
            await program.parseAsync(["node", "rig", ...v.argv, "--body", "-", "--json"]);
          } catch {
            /* 今日不期待抛错（--body 已存在）；为对称而守护 */
          }
        });
        const post = calls.find((c) => v.pathMatch(c.path));
        expect(post, `${v.name} should POST after consuming stdin`).toBeDefined();
        // 今日它是字面量 "-"（bodyBytes:1）——正是静默短横 bug。
        expect((post!.body as Record<string, unknown>).body).toBe(DISCRIMINATOR);
      });
    }

    // ── GENUINE RED ×4: help documents --body-file + stdin '-'.
    for (const v of VERBS) {
      it(`RED: ${v.name} --help documents --body-file and stdin '-'`, () => {
        const { deps } = makeDeps();
        const program = createProgram({ queueDeps: deps });
        const help = verbSubcommand(program, v.name).helpInformation();
        expect(help, `${v.name} help should teach --body-file`).toContain("--body-file");
        expect(help, `${v.name} help should teach stdin '-'`).toMatch(/stdin|read from stdin|use -/i);
      });
    }

    // ── PRESERVATION GREEN ×2: handoff pair, neither → POST body undefined.
    for (const v of VERBS.filter((x) => x.neither === "undefined-body")) {
      it(`PRESERVE (green): ${v.name} with no body POSTs body undefined (source-body default)`, async () => {
        const { deps, calls } = makeDeps();
        const program = createProgram({ queueDeps: deps });
        program.exitOverride();
        try {
          await program.parseAsync(["node", "rig", ...v.argv, "--json"]);
        } catch {
          /* not expected */
        }
        const post = calls.find((c) => v.pathMatch(c.path));
        expect(post, `${v.name} should still POST with the source-body default`).toBeDefined();
        expect((post!.body as Record<string, unknown>).body).toBeUndefined();
      });
    }

    // ── PRESERVATION GREEN ×2: inbox/outbox, neither → error + no POST
    //（机制中立，跨今日 Commander requiredOption 与后续 resolver 拒绝）。
    for (const v of VERBS.filter((x) => x.neither === "reject")) {
      it(`PRESERVE (green): ${v.name} with no body errors and does NOT contact the daemon`, async () => {
        const { deps, calls } = makeDeps();
        const program = createProgram({ queueDeps: deps });
        program.exitOverride();
        const prevExit = process.exitCode;
        process.exitCode = undefined;
        let errored = false;
        try {
          await program.parseAsync(["node", "rig", ...v.argv, "--json"]);
        } catch {
          errored = true; // Commander requiredOption throws today
        }
        try {
          expect(errored || process.exitCode === 1, `${v.name} should signal an error`).toBe(true);
          expect(calls.find((c) => v.pathMatch(c.path)), `${v.name} must not POST`).toBeUndefined();
        } finally {
          process.exitCode = prevExit;
        }
      });
    }

    // ── NEW-CAPABILITY GREEN ×4: both sources → error + no POST
    //（今日未知选项；A 之后 resolver 互斥——两种情况都不联系 daemon）。
    for (const v of VERBS) {
      it(`NEW-CAP (green): ${v.name} with both --body and --body-file errors and does NOT POST`, async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `s08-${v.name}-both-`));
        const bodyPath = path.join(tmp, "body.txt");
        fs.writeFileSync(bodyPath, "x", "utf8");
        const { deps, calls } = makeDeps();
        const program = createProgram({ queueDeps: deps });
        program.exitOverride();
        const prevExit = process.exitCode;
        process.exitCode = undefined;
        let errored = false;
        try {
          await program.parseAsync(["node", "rig", ...v.argv, "--body", "inline", "--body-file", bodyPath, "--json"]);
        } catch {
          errored = true;
        }
        try {
          expect(errored || process.exitCode === 1, `${v.name} should reject dual sources`).toBe(true);
          expect(calls.find((c) => v.pathMatch(c.path)), `${v.name} must not POST`).toBeUndefined();
        } finally {
          process.exitCode = prevExit;
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      });
    }

    // ── 真 RED：共享 resolver 错误必须与命令中立。
    // 今日四者都写 "rig queue create did not run"——一旦 handoff/inbox/outbox 共享该 helper 即失真。钉住通用措辞；不留过时的 "queue create"。
    it("RED：resolveQueueBody「两者皆无」错误措辞与命令无关（不含 'queue create'）", async () => {
      await expect(resolveQueueBody({})).rejects.toMatchObject({
        consequence: expect.not.stringMatching(/queue create/i),
      });
    });

    it("RED：resolveQueueBody「两者同传」错误措辞与命令无关（不含 'queue create'）", async () => {
      await expect(resolveQueueBody({ body: "x", bodyFile: "/tmp/y" })).rejects.toMatchObject({
        consequence: expect.not.stringMatching(/queue create/i),
      });
    });

    it("RED：resolveQueueBody 缺文件错误措辞与命令无关（不含 'queue create'）", async () => {
      await expect(
        resolveQueueBody({ bodyFile: "/tmp/s08-does-not-exist-neutral-wording.md" }),
      ).rejects.toMatchObject({
        consequence: expect.not.stringMatching(/queue create/i),
      });
    });

    // BLOCKER-1 修复：第四个过时 consequence——not-a-regular-file / 目录分支——此前未守护。一次反向搜索发现四处 'rig queue create did not run'；该 packet 必须钉住全部四处，而非三处。
    it("RED：resolveQueueBody 非普通文件错误措辞与命令无关（不含 'queue create'）", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "s08-notregular-wording-"));
      try {
        await expect(resolveQueueBody({ bodyFile: tmp })).rejects.toMatchObject({
          consequence: expect.not.stringMatching(/queue create/i),
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    // BLOCKER-2 修复：该闸门需要通用 body 指引，而不止 consequence。今日 neither 动作是 "Pass the qitem body via …"，对 inbox/outbox 记录是失真的。它必须教 --body/--body-file。
    // 并保持通用——无 'qitem'。措辞容忍（无逐字 prose 锁定）。
    it("RED：resolveQueueBody「两者皆无」动作给出通用 body 指引（不含 'qitem'）", async () => {
      await expect(resolveQueueBody({})).rejects.toMatchObject({
        action: expect.stringMatching(/--body\b|--body-file/),
      });
      await expect(resolveQueueBody({})).rejects.toMatchObject({
        action: expect.not.stringMatching(/qitem/i),
      });
    });
  });
});

// P3—— authored-summary 教学层。已交付 warn-then-require 轨道（OPR.0.4.1.18
// FR-7）告诉调用者：缺失 --summary 会回退到有界 body preview；教学层还额外教约定（什么是好 summary + 人在哪里读它），使人略读的 needs-you 行确实是 authored 出来的，而非只是被期待。保留的护栏：
// warn → stderr（json stdout 干净），warn 非硬中断，两个 handoff 提示保持
// 逐字节一致，不编造事实（教学，绝不杜撰）。
describe("P3 — authored-summary teaching layer (advisory + --summary hint)", () => {
  let stderrOut: string[];
  const TEACHES_WHERE = /needs-you/;      // teaches WHERE the summary is read
  const TEACHES_WHY = /为什么需要这个 seat/; // teaches the WHAT+WHY convention

  beforeEach(() => {
    stderrOut = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderrOut.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    });
    process.exitCode = undefined;
  });

  it("不带 --summary 的 create 给出同样如实的有界 preview 兜底，且不硬崩", async () => {
    const { deps, calls } = makeDeps({
      routes: { "POST /api/queue/create": { status: 201, data: { qitemId: "q1", state: "pending" } } },
    });
    const program = createProgram({ queueDeps: deps });
    program.exitOverride();
    await program.parseAsync([
      "node", "rig", "queue", "create",
      "--source", "a@rig", "--destination", "b@rig", "--body", "x", "--json",
    ]);
    const warn = stderrOut.join("");
    expect(warn).toMatch(TEACHES_WHERE);
    expect(warn).toMatch(TEACHES_WHY);
    expect(warn).toMatch(/传 --summary <文本>/);
    expect(warn).toMatch(/有界正文预览/);
    expect(warn).not.toMatch(/body truncation/i);
    // warn-not-require 护栏：qitem 仍被创建（省略时不硬崩）。
    expect(calls.find((c) => c.path === "/api/queue/create")).toBeDefined();
  });

  it("不带 --summary 的 handoff 与 handoff-and-complete 携带同样的教学提示（字节级一致）", async () => {
    async function warnFor(sub: "handoff" | "handoff-and-complete"): Promise<string> {
      stderrOut = [];
      const { deps } = makeDeps({
        routes: {
          "POST /api/queue/handoff": { status: 201, data: { qitemId: "q2" } },
          "POST /api/queue/handoff-and-complete": { status: 201, data: { qitemId: "q3" } },
        },
      });
      const program = createProgram({ queueDeps: deps });
      program.exitOverride();
      try {
        await program.parseAsync([
          "node", "rig", "queue", sub, "qitem-src-1",
          "--from", "a@rig", "--to", "b@rig", "--body", "y", "--json",
        ]);
      } catch { /* exitOverride / downstream mock — the warn fires before the daemon call */ }
      return stderrOut.join("");
    }
    const h = await warnFor("handoff");
    const hc = await warnFor("handoff-and-complete");
    expect(h).toMatch(TEACHES_WHERE);
    expect(h).toMatch(TEACHES_WHY);
    expect(h).toMatch(/传 --summary <文本>/);
    expect(h).toMatch(/有界正文预览/);
    expect(h).not.toMatch(/body truncation/i);
    expect(hc).toBe(h); // parity rail: the two handoff advisories are byte-identical
  });

  it("create --summary 选项提示讲清 summary 从哪里读取（不止讲成本）", () => {
    const { deps } = makeDeps();
    const program = createProgram({ queueDeps: deps });
    const queueCmd = program.commands.find((c) => c.name() === "queue")!;
    const createCmd = queueCmd.commands.find((c) => c.name() === "create")!;
    const summaryOpt = createCmd.options.find((o) => o.long === "--summary")!;
    expect(summaryOpt.description).toMatch(TEACHES_WHERE);
  });
});
