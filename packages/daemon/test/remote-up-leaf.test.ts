// OPR.0.4.4.11——daemon 侧 remote single-rig leaf（FR-4）。
//
// 此 leaf 镜像 CLI transport shape（bearer 解析 + status classification vocabulary）——
// 这些测试固定镜像语义，并确保失败呈现既有 class，而非新 taxonomy。

import { describe, it, expect } from "vitest";
import { remoteUpLeaf } from "../src/domain/topology/remote-up-leaf.js";
import type { HttpHostEntry } from "../src/domain/hosts/hosts-registry-reader.js";

const HOST_ENV: HttpHostEntry = { id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "VPS_B_TOKEN" };
const HOST_FILE: HttpHostEntry = { id: "vps-f", transport: "http", url: "http://vps-f:7433/", bearer_file: "/tok/f" };

function fetchStub(status: number, payload?: unknown, capture?: { url?: string; init?: RequestInit }) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (capture) {
      capture.url = String(url);
      capture.init = init;
    }
    return new Response(payload === undefined ? null : JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("remoteUpLeaf——bearer 解析（镜像 CLI resolveRemoteBearer）", () => {
  it("bearer_env：缺失/空 env 是 permission-gate failure，且不发送请求", async () => {
    let called = false;
    const res = await remoteUpLeaf({ sourceRef: "r" }, HOST_ENV, {
      env: {},
      fetchImpl: (async () => {
        called = true;
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("[permission-gate]");
    expect(res.error).toContain("VPS_B_TOKEN");
    expect(called).toBe(false);
  });

  it("bearer_file：不可读文件与空文件都是 permission-gate failure", async () => {
    const unreadable = await remoteUpLeaf({ sourceRef: "r" }, HOST_FILE, {
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(unreadable.error).toContain("[permission-gate]");
    expect(unreadable.error).toContain("无法读取");

    const empty = await remoteUpLeaf({ sourceRef: "r" }, HOST_FILE, { readFile: () => "  " });
    expect(empty.error).toContain("[permission-gate]");
    expect(empty.error).toContain("为空");
  });
});

describe("remoteUpLeaf——已交付的 POST /api/up transport", () => {
  it("使用已解析 bearer 将 body POST 到 {url}/api/up；2xx 为成功", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const res = await remoteUpLeaf(
      { sourceRef: "specs/factory.yaml", autoApprove: true },
      HOST_FILE, // trailing-slash URL——会被 normalize
      { readFile: () => "tok-123\n", fetchImpl: fetchStub(200, { status: "completed" }, capture) },
    );
    expect(res).toEqual({ ok: true });
    expect(capture.url).toBe("http://vps-f:7433/api/up");
    expect(capture.init?.method).toBe("POST");
    expect((capture.init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok-123");
    expect(JSON.parse(String(capture.init?.body))).toEqual({ sourceRef: "specs/factory.yaml", autoApprove: true });
  });

  it("401/403 归类为 permission-gate；4xx/5xx 归类为 remote-command-failed，并逐字保留 remote error text", async () => {
    const auth = await remoteUpLeaf({ sourceRef: "r" }, HOST_ENV, {
      env: { VPS_B_TOKEN: "t" },
      fetchImpl: fetchStub(401),
    });
    expect(auth.error).toContain("[permission-gate]");

    const failed = await remoteUpLeaf({ sourceRef: "r" }, HOST_ENV, {
      env: { VPS_B_TOKEN: "t" },
      fetchImpl: fetchStub(409, { error: "Already in progress for this source" }),
    });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("[remote-command-failed]");
    expect(failed.error).toContain("HTTP 409: Already in progress for this source");
  });

  it("R2-B1：永不结束的 remote /api/up 返回结构化 timeout failure，而非挂起遍历", async () => {
    // fetch stub 与真实 fetch 一样遵循 AbortSignal：自身永不 resolve，signal 触发时以 AbortError reject。
    let sawSignal = false;
    const neverSettling = ((url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        sawSignal = init?.signal instanceof AbortSignal;
        init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
      })) as typeof fetch;
    const res = await remoteUpLeaf({ sourceRef: "r" }, HOST_ENV, {
      env: { VPS_B_TOKEN: "t" },
      fetchImpl: neverSettling,
      timeoutMs: 25,
    });
    expect(sawSignal).toBe(true); // abort 路径确实接入 request
    expect(res.ok).toBe(false);
    expect(res.error).toContain("[remote-daemon-unreachable]");
    expect(res.error).toContain("在 25ms 后超时");
    expect(res.error).toContain("vps-b");
  });

  it("G-R2B1-1：失败 header 后跟永不完成的 error body 时仍返回结构化 timeout（deadline 覆盖 body parse）", async () => {
    // Guard 的精确复现方法：response 以 500 header resolve，但 body stream 永不产生 byte——
    // 除非 leaf 自身限制 parse，否则 Response.json() 会永久 pending。
    const stalledBody = ((_url: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(
        new Response(new ReadableStream({ start() {} }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      )) as typeof fetch;
    const res = await remoteUpLeaf({ sourceRef: "r" }, HOST_ENV, {
      env: { VPS_B_TOKEN: "t" },
      fetchImpl: stalledBody,
      timeoutMs: 25,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("[remote-daemon-unreachable]");
    expect(res.error).toContain("在 25ms 后超时");
    expect(res.error).toContain("response header 已到达（HTTP 500）");
    expect(res.error).toContain("vps-b");
  });

  it("G-R2B1-1：deadline 内完成的 error body 仍产生已分类 failure，并逐字保留 remote text", async () => {
    const res = await remoteUpLeaf({ sourceRef: "r" }, HOST_ENV, {
      env: { VPS_B_TOKEN: "t" },
      fetchImpl: fetchStub(500, { error: "boom from remote" }),
      timeoutMs: 5_000,
    });
    expect(res.error).toContain("[remote-command-failed]");
    expect(res.error).toContain("HTTP 500: boom from remote");
  });

  it("R2-B1：默认 deadline 使用长时 rig-up budget，而非通用 metadata 默认值", async () => {
    const { REMOTE_UP_TIMEOUT_MS } = await import("../src/domain/topology/remote-up-leaf.js");
    expect(REMOTE_UP_TIMEOUT_MS).toBe(120_000);
  });

  it("network failure 归类为 remote-daemon-unreachable，并指出 host + URL", async () => {
    const res = await remoteUpLeaf({ sourceRef: "r" }, HOST_ENV, {
      env: { VPS_B_TOKEN: "t" },
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("[remote-daemon-unreachable]");
    expect(res.error).toContain("vps-b");
    expect(res.error).toContain("ECONNREFUSED");
  });
});
