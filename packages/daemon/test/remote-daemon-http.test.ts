// OPR.0.4.4.15——共享 daemon→daemon transport core（arch cell 1）。
//
// bounded-abort 纪律现在位于此处（一个 deadline 贯穿 request 与 body——为每个 consumer 从结构上
// 封闭 G-R2B1-1 类）；remote-up-leaf 自身测试继续固定其已交付 error string，证明 consumer
// formatting；这些测试固定 structured result。

import { describe, it, expect } from "vitest";
import { remoteJsonRequest, remoteRawRequest } from "../src/domain/hosts/remote-daemon-http.js";
import { LOCAL_HOST_ID, hostsCovered } from "../src/domain/hosts/fanout-contract.js";
import type { AggregatedPayload } from "../src/domain/hosts/fanout-contract.js";
import type { HttpHostEntry } from "../src/domain/hosts/hosts-registry-reader.js";

const HOST: HttpHostEntry = { id: "vps-b", transport: "http", url: "http://vps-b:7433/", bearer_env: "T" };
const ENV = { T: "tok-1" };

function fetchStub(status: number, payload?: unknown, capture?: { url?: string; init?: RequestInit }) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (capture) {
      capture.url = String(url);
      capture.init = init;
    }
    return new Response(payload === undefined ? "not-json" : JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("remoteJsonRequest——结构化 outcome（永不挂起、永不抛错）", () => {
  it("bearer 失败以 kind=bearer 短路；不发送 request", async () => {
    let called = false;
    const res = await remoteJsonRequest(HOST, "/api/x", {
      method: "GET",
      timeoutMs: 1000,
      env: {},
      fetchImpl: (async () => {
        called = true;
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });
    expect(res).toMatchObject({ ok: false, kind: "bearer" });
    if (!res.ok) expect(res.detail).toContain("bearer 环境变量 T");
    expect(called).toBe(false);
  });

  it("GET 携带 bearer，不带 Content-Type/body；尾部斜杠 URL 正确拼接；2xx 返回已解析 payload", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const res = await remoteJsonRequest(HOST, "/api/queue/list?attention=1", {
      method: "GET",
      timeoutMs: 1000,
      env: ENV,
      fetchImpl: fetchStub(200, { items: [1, 2] }, capture),
    });
    expect(res).toEqual({ ok: true, status: 200, payload: { items: [1, 2] } });
    expect(capture.url).toBe("http://vps-b:7433/api/queue/list?attention=1");
    expect(capture.init?.method).toBe("GET");
    const headers = capture.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-1");
    expect(headers["Content-Type"]).toBeUndefined();
    expect(capture.init?.body).toBeUndefined();
    expect(capture.init?.signal).toBeInstanceOf(AbortSignal); // deadline 已接入 request
  });

  it("POST 序列化 body 并携带 Content-Type", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    await remoteJsonRequest(HOST, "/api/up", {
      method: "POST",
      body: { sourceRef: "r" },
      timeoutMs: 1000,
      env: ENV,
      fetchImpl: fetchStub(201, {}, capture),
    });
    expect((capture.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(capture.init?.body))).toEqual({ sourceRef: "r" });
  });

  it("永不 settle 的 request → 在 caller deadline 内返回 kind=timeout phase=request", async () => {
    const neverSettling = ((_u: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_res, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const res = await remoteJsonRequest(HOST, "/api/x", { method: "GET", timeoutMs: 20, env: ENV, fetchImpl: neverSettling });
    expect(res).toMatchObject({ ok: false, kind: "timeout", phase: "request" });
  });

  it("收到 header 后 body 停滞 → 返回携带 status 的 kind=timeout phase=body（G-R2B1-1 类现由结构保证）", async () => {
    const stalled = (async () =>
      new Response(new ReadableStream({ start() {} }), { status: 500, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const res = await remoteJsonRequest(HOST, "/api/x", { method: "GET", timeoutMs: 20, env: ENV, fetchImpl: stalled });
    expect(res).toMatchObject({ ok: false, kind: "timeout", phase: "body", status: 500 });
  });

  it("带 JSON error body 的非 2xx → kind=http 并带 remote text；非 JSON body → 空 detail（status 是诚实事实）", async () => {
    const withText = await remoteJsonRequest(HOST, "/api/x", { method: "GET", timeoutMs: 1000, env: ENV, fetchImpl: fetchStub(409, { error: "conflict!" }) });
    expect(withText).toMatchObject({ ok: false, kind: "http", status: 409, detail: "conflict!" });
    const nonJson = await remoteJsonRequest(HOST, "/api/x", { method: "GET", timeoutMs: 1000, env: ENV, fetchImpl: fetchStub(500) });
    expect(nonJson).toMatchObject({ ok: false, kind: "http", status: 500, detail: "" });
  });

  it("network failure → kind=network 并携带 error message", async () => {
    const res = await remoteJsonRequest(HOST, "/api/x", {
      method: "GET",
      timeoutMs: 1000,
      env: ENV,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    expect(res).toMatchObject({ ok: false, kind: "network", detail: "ECONNREFUSED" });
  });
});

describe("fanout-contract——共享 intra-P4 payload（arch adjudication：15 定义，21 import）", () => {
  it("LOCAL_HOST_ID 是与 S11 匹配且只定义一次的 literal", () => {
    expect(LOCAL_HOST_ID).toBe("local");
  });

  it("hostsCovered：仅当每个预期 host 恰好出现一次时为 true（防遗漏，按 arch pin B 靠近契约）", () => {
    const payload: AggregatedPayload<number> = {
      items: [1],
      hosts: [
        { hostId: LOCAL_HOST_ID, status: "ok" },
        { hostId: "vps-b", status: "unreachable", error: "timeout", failedStep: "remote-daemon-unreachable" },
        { hostId: "ssh-1", status: "unsupported-transport", error: "ssh transport cannot carry the read" },
      ],
    };
    expect(hostsCovered(payload, [LOCAL_HOST_ID, "vps-b", "ssh-1"])).toBe(true);
    expect(hostsCovered(payload, [LOCAL_HOST_ID, "vps-b", "ssh-1", "missing"])).toBe(false); // 捕获静默删减
    expect(hostsCovered({ items: [], hosts: [...payload.hosts, { hostId: "vps-b", status: "ok" }] }, [LOCAL_HOST_ID, "vps-b", "ssh-1"])).toBe(false); // 捕获重复项
  });
});

describe("anonymous（仅 URL）HTTP host——无 Authorization header，不短路 request", () => {
  const ANON: HttpHostEntry = { id: "anon-b", transport: "http", url: "http://anon-b:7433/" };

  it("remoteJsonRequest：仅 URL host 不发送 Authorization header；2xx 仍返回 payload", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const res = await remoteJsonRequest(ANON, "/api/queue/list", {
      method: "GET",
      timeoutMs: 1000,
      env: {},
      fetchImpl: fetchStub(200, { items: [] }, capture),
    });
    expect(res).toMatchObject({ ok: true, status: 200 });
    const headers = capture.init?.headers as Record<string, string>;
    expect("Authorization" in headers).toBe(false);
  });

  it("remoteRawRequest：仅 URL host 不发送 Authorization header；origin answer 为 ok:true", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const res = await remoteRawRequest(ANON, "/api/ps", {
      timeoutMs: 1000,
      env: {},
      fetchImpl: fetchStub(200, { rigs: [] }, capture),
    });
    expect(res).toMatchObject({ ok: true, status: 200 });
    const headers = capture.init?.headers as Record<string, string>;
    expect("Authorization" in headers).toBe(false);
  });

  it("已配置 bearer_env 的 host 仍携带 Authorization（fail-closed 路径不变）", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    await remoteJsonRequest(HOST, "/api/x", {
      method: "GET",
      timeoutMs: 1000,
      env: ENV,
      fetchImpl: fetchStub(200, {}, capture),
    });
    const headers = capture.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-1");
  });
});
