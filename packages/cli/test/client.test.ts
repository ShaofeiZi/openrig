import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { DaemonClient, DaemonConnectionError } from "../src/client.js";

// 轻量测试服务器，以 JSON 回显请求信息。
function createEchoServer(): { server: http.Server; port: number; close: () => Promise<void> } {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url!, `http://localhost`);

    // POST /api/conflict -> 409（用于非 2xx 测试）
    if (req.method === "POST" && url.pathname === "/api/conflict") {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "already exists" }));
      return;
    }

    // GET /api/rigs/:id/spec -> text/yaml（用于 getText 测试）
    if (req.method === "GET" && url.pathname.endsWith("/spec")) {
      res.writeHead(200, { "Content-Type": "text/yaml" });
      res.end("schema_version: 1\nname: test-rig\n");
      return;
    }

    // POST /api/echo-raw -> 回显 content-type 和原始正文（用于 postText 测试）
    if (req.method === "POST" && url.pathname === "/api/echo-raw") {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ contentType: req.headers["content-type"], body }));
      });
      return;
    }

    // 收集 POST 正文。
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        method: req.method,
        path: url.pathname,
        body: body || null,
      }));
    });
  });

  return {
    server,
    port: 0,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("DaemonClient", () => {
  let echoServer: ReturnType<typeof createEchoServer>;
  let baseUrl: string;

  beforeAll(async () => {
    echoServer = createEchoServer();
    await new Promise<void>((resolve) => {
      echoServer.server.listen(0, () => {
        const addr = echoServer.server.address();
        if (addr && typeof addr === "object") {
          echoServer.port = addr.port;
          baseUrl = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await echoServer.close();
  });

  // 测试 1：客户端根据 base 构造正确 URL。
  it("根据 base 构造正确 URL", () => {
    const client = new DaemonClient("http://localhost:9999");
    expect(client.baseUrl).toBe("http://localhost:9999");
  });

  // 测试 2：客户端 GET 返回包含已解析 JSON 的 { status, data }。
  it("GET 返回包含已解析 JSON 的 { status, data }", async () => {
    const client = new DaemonClient(baseUrl);
    const res = await client.get("/api/rigs");

    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      method: "GET",
      path: "/api/rigs",
      body: null,
    });
  });

  // 测试 3：客户端 POST 发送正文并返回 { status, data }。
  it("POST 发送正文并返回 { status, data }", async () => {
    const client = new DaemonClient(baseUrl);
    const res = await client.post("/api/rigs", { name: "test-rig" });

    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      method: "POST",
      path: "/api/rigs",
      body: JSON.stringify({ name: "test-rig" }),
    });
  });

  // 测试 4：客户端在连接被拒绝时抛出 DaemonConnectionError。
  it("连接被拒绝时抛出 DaemonConnectionError", async () => {
    const client = new DaemonClient("http://localhost:1");
    await expect(client.get("/api/rigs")).rejects.toThrow(DaemonConnectionError);
  });

  it("有界超时会抛出 DaemonConnectionError，而不是永久挂起", async () => {
    const neverFetch: typeof fetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason ?? new Error("aborted"));
      }, { once: true });
    })) as typeof fetch;
    const client = new DaemonClient("http://localhost:9999", { fetchImpl: neverFetch, timeoutMs: 20 });

    await expect(client.get("/api/rigs")).rejects.toThrow(DaemonConnectionError);
    await expect(client.get("/api/rigs")).rejects.toThrow(/超时/);
  });

  it("逐请求超时覆盖可以延长耗时调用的等待时间", async () => {
    const delayedFetch: typeof fetch = ((url: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(new Response(JSON.stringify({ ok: true, url: String(url) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }, 40);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal?.reason ?? new Error("aborted"));
      }, { once: true });
    })) as typeof fetch;
    const client = new DaemonClient("http://localhost:9999", { fetchImpl: delayedFetch, timeoutMs: 20 });

    await expect(client.get("/api/rigs")).rejects.toThrow(/超时/);

    const res = await client.get<{ ok: boolean; url: string }>("/api/rigs", { timeoutMs: 100 });
    expect(res.status).toBe(200);
    expect(res.data.ok).toBe(true);
    expect(res.data.url).toContain("/api/rigs");
  });

  // 测试 5：设置时使用 OPENRIG_URL，否则回退到 http://127.0.0.1:7433。
  it("设置时使用 OPENRIG_URL，否则回退到 http://127.0.0.1:7433", () => {
    // 默认情况（无环境变量）
    const saved = process.env["OPENRIG_URL"];
    delete process.env["OPENRIG_URL"];
    const defaultClient = new DaemonClient();
    expect(defaultClient.baseUrl).toBe("http://127.0.0.1:7433");

    // 设置环境变量。
    process.env["OPENRIG_URL"] = "http://custom:9000";
    const envClient = new DaemonClient();
    expect(envClient.baseUrl).toBe("http://custom:9000");

    // 清理。
    if (saved !== undefined) {
      process.env["OPENRIG_URL"] = saved;
    } else {
      delete process.env["OPENRIG_URL"];
    }
  });

  // 测试 6：CLI --version 输出版本字符串。
  it("CLI --version 输出版本字符串", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { resolve } = await import("node:path");

    const cliEntry = resolve(import.meta.dirname, "../dist/index.js");
    const result = await execFileAsync("node", [cliEntry, "--version"], {
      cwd: resolve(import.meta.dirname, ".."),
    });

    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+(?: \([0-9a-f]{8}(?:, dirty)?\))?$/);
  });

  // 测试 7：客户端收到非 2xx（409）时返回 { status: 409, data: errorBody }。
  it("非 2xx 响应返回 { status, data }，且不抛出异常", async () => {
    const client = new DaemonClient(baseUrl);
    const res = await client.post("/api/conflict", {});

    expect(res.status).toBe(409);
    expect(res.data).toEqual({ error: "already exists" });
  });

  // 测试 8：postText 使用正确 Content-Type 发送原始文本正文。
  it("postText 以 text/yaml Content-Type 发送原始文本正文", async () => {
    const client = new DaemonClient(baseUrl);
    const yaml = "schema_version: 1\nname: test\n";
    const res = await client.postText<{ contentType: string; body: string }>("/api/echo-raw", yaml);

    expect(res.status).toBe(200);
    expect(res.data.contentType).toBe("text/yaml");
    expect(res.data.body).toBe(yaml); // 原始文本，不做 JSON 字符串化。
  });

  // 测试 9：getText 对非 JSON 内容（YAML 导出）返回原始文本正文。
  it("getText 对 text/yaml 响应返回原始文本正文", async () => {
    const client = new DaemonClient(baseUrl);
    const res = await client.getText("/api/rigs/r1/spec");

    expect(res.status).toBe(200);
    expect(res.data).toBe("schema_version: 1\nname: test-rig\n");
  });
});
