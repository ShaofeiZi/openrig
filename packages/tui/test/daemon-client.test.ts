import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DaemonClient, launchNodeNotice } from "../src/daemon-client.js";

// FR-8 / R7 no-new-data：TUI 整个 daemon 面就是这一个模块，
// 它能发出的每条路由都在 §4.A 既有 web 消费
// 读表上。此测试钉住审计：走每个 wrapper，收集每个 URL。

const SPEC_4A_ROUTES = [
  "/api/rigs/openrig-build/graph",
  "/api/ps",
  "/api/rigs/summary",
  "/api/rigs/openrig-build/nodes",
  "/api/review/agents?scope=rig",
  "/api/specs/library?kind=rig",
  "/api/rigs/openrig-build/spec.json",
  "/api/specs/library/a2/review",
  "/api/queue/list?attention=1",
  "/api/review/rig",
  "/api/review/fleet",
  "/api/queue/attention-aggregate",
  "/api/rigs/openrig-build/status",
  "/api/stream/list?limit=100",
  "/api/stream/list?limit=100&afterSortKey=k1",
  "/api/stream/list?limit=5&direction=latest",
  "/api/views/execution",
  "/api/views/execution?mission=release-0.5.8",
  "/api/slices/11-production-tui-composed-system",
  "/healthz",
  "/api/queue/recent-transitions?scope=rig&rig=openrig-build&limit=20",
  "/api/queue/recent-transitions?scope=instance&limit=20",
  "/api/health?limit=200",
];

describe("daemon client = §4.A 表，单模块，别无其他 (FR-8/FR-9)", () => {
  it("每个 wrapper 恰好发出一条 §4.A 路由", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      seen.push(String(url).replace("http://x", ""));
      return { ok: true, json: async () => ({}) } as Response;
    }) as typeof fetch;
    const c = new DaemonClient({ baseUrl: "http://x", fetchImpl });

    await c.health();
    await c.rigGraph("openrig-build");
    await c.ps();
    await c.rigsSummary();
    await c.rigNodes("openrig-build");
    await c.reviewAgents("rig");
    await c.specsLibrary("rig");
    await c.rigSpec("openrig-build");
    await c.specLibraryReview("a2");
    await c.queueAttention();
    await c.reviewRig();
    await c.reviewFleet();
    await c.attentionAggregate();
    await c.rigStatus("openrig-build");
    await c.streamList();
    await c.streamList(100, "k1");
    await c.streamLatest();
    await c.execution();
    await c.execution("release-0.5.8");
    await c.sliceDetail("11-production-tui-composed-system");
    await c.queueRecentTransitions({ kind: "rig", rig: "openrig-build" });
    await c.queueRecentTransitions({ kind: "instance" });
    await (c as unknown as { healthFindings(): Promise<unknown> }).healthFindings();

    expect(seen.sort()).toEqual([...SPEC_4A_ROUTES].sort());
  });

  it("是唯一与 HTTP 通信的模块（单文件源检查保持单文件）", () => {
    const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
    const files = ["state.ts", "render.ts", "grammar.ts", "input.ts", "socket-server.ts", "main.ts", "types.ts", "demo-data.ts", "index.ts", "hydrate.ts"];
    for (const file of files) {
      const text = readFileSync(path.join(srcDir, file), "utf8");
      expect(text, `${file} must not fetch`).not.toMatch(/fetch\(/);
      // state.ts 在 section 注册表带 §4.A 来源注
      //（sourceRead 元数据）——那些是文档，非请求路径。
      if (file !== "state.ts") expect(text, `${file} must not carry routes`).not.toMatch(/\/api\//);
    }
  });

  it("写面 = 恰好两个 BR-8 驱动结构契约（terminal-open, seat-launch）", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      if (init?.method === "POST") seen.push(String(url).replace("http://x", ""));
      return {
        ok: true,
        json: async () => String(url).endsWith("/api/terminal/open")
          ? { provider: "herdr", ok: true, opened: ["dev.qa"], absent: [], degraded: [], pages: 1 }
          : {},
      } as Response;
    }) as typeof fetch;
    const c = new DaemonClient({ baseUrl: "http://x", fetchImpl });
    await c.openTerminal("pod:dev");
    await c.launchNode("myrig", "dev.qa");
    expect(seen).toEqual(["/api/terminal/open", "/api/rigs/myrig/nodes/dev.qa/launch"]);
    // 且 client 上无其他方法 POST
    const postCalls = Object.getOwnPropertyNames(Object.getPrototypeOf(c)).filter((m) =>
      ["openTerminal", "launchNode"].includes(m),
    );
    expect(postCalls).toHaveLength(2);
  });

  it("诚实报告已在运行的 launch 响应", () => {
    expect(launchNodeNotice("dev.qa", { ok: true, code: "already_running", alreadyRunning: [{ logicalId: "dev.qa" }] }))
      .toBe("智能体已在运行: dev.qa");
    expect(launchNodeNotice("dev.qa", { ok: true, launched: [{ logicalId: "dev.qa" }] }))
      .toBe("已请求运行智能体: dev.qa");
  });

  it("不把零窗格 HTTP 200 终端结果报告为已打开", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({
        provider: "herdr",
        ok: false,
        opened: [],
        absent: [],
        degraded: [],
        pages: 0,
        code: "herdr_unavailable",
        error: "herdr control socket is not answering ping",
      }),
    }) as Response) as typeof fetch;
    const c = new DaemonClient({ baseUrl: "http://x", fetchImpl });
    await expect(c.openTerminal("pod:dev")).rejects.toThrow(/herdr control socket is not answering ping/);
  });

  it("把失败读取呈现为具名错误（路由 + 状态），绝不静默", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 503, json: async () => ({}) }) as Response) as typeof fetch;
    const c = new DaemonClient({ baseUrl: "http://x", fetchImpl });
    await expect(c.ps()).rejects.toThrow(/GET \/api\/ps → 503/);
  });
  it("首次 daemon 启动后读取当前终端凭证", async () => {
    let headers: Record<string, string> = {};
    const seen: unknown[] = [];
    const c = new DaemonClient({ baseUrl: "http://x", headers: () => headers,
      fetchImpl: (async (_url, init) => { seen.push(init?.headers); return new Response("{}"); }) as typeof fetch });
    await c.startupRequest("/r1");
    headers = { Authorization: "Bearer newly-created-test-token" };
    await c.startupRequest("/r1");
    expect(seen).toEqual([{ "Content-Type": "application/json" },
      { Authorization: "Bearer newly-created-test-token", "Content-Type": "application/json" }]);
  });
});
