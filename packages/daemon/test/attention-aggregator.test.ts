// OPR.0.4.4.15 FR-1 — daemon 端注意事项聚合器。
//
// 如实呈现支路承担关键语义：每次调用时，每个已订阅主机都会出现在 hosts[] 中
//（通过契约的 hostsCovered 断言——架构固定点 B）；故障以逐主机结构化状态呈现
//（绝非全有或全无，也不静默删减）；注册表延迟加载；本地支路会调用注入的查询
//（复用，而非重新实现）。

import { describe, it, expect } from "vitest";
import { aggregateAttention, ATTENTION_READ_TIMEOUT_MS } from "../src/domain/feed/attention-aggregator.js";
import type { AttentionAggregatorDeps } from "../src/domain/feed/attention-aggregator.js";
import { LOCAL_HOST_ID, hostsCovered } from "../src/domain/hosts/fanout-contract.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

const REGISTRY: HostRegistry = {
  hosts: [
    { id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "B" },
    { id: "vps-c", transport: "http", url: "http://vps-c:7433", bearer_env: "C" },
    { id: "ssh-1", transport: "ssh", target: "x.local" },
  ],
};

function attentionResponse(items: unknown[]): Response {
  return new Response(JSON.stringify(items), { status: 200, headers: { "Content-Type": "application/json" } });
}

function deps(overrides: Partial<AttentionAggregatorDeps> = {}): AttentionAggregatorDeps {
  return {
    listLocalAttention: () => [{ qitemId: "local-1" }],
    listSubscriptions: () => [],
    loadRegistry: () => ({ ok: true, registry: REGISTRY }),
    env: { B: "tb", C: "tc" },
    ...overrides,
  };
}

describe("aggregateAttention——零配置与本地支路", () => {
  it("没有已启用订阅时：本地条目标记 LOCAL_HOST_ID，绝不读取注册表", async () => {
    const res = await aggregateAttention(
      deps({
        listSubscriptions: () => [{ hostId: "vps-b", enabled: false }],
        loadRegistry: () => {
          throw new Error("没有已启用的远程订阅时，不得读取注册表");
        },
      }),
    );
    expect(res.items).toEqual([{ qitemId: "local-1", hostId: LOCAL_HOST_ID }]);
    expect(res.hosts).toEqual([{ hostId: LOCAL_HOST_ID, status: "ok" }]);
  });

  it("本地条目来自注入的查询（与路由执行的 repo 查询相同）", async () => {
    let invoked = 0;
    await aggregateAttention(
      deps({
        listLocalAttention: () => {
          invoked += 1;
          return [];
        },
      }),
    );
    expect(invoked).toBe(1);
  });
});

describe("aggregateAttention——扇出与逐主机如实呈现（FR-1/R15-2）", () => {
  it("合并多主机条目并标记来源；hosts[] 按契约谓词保持完整", async () => {
    const res = await aggregateAttention(
      deps({
        listSubscriptions: () => [
          { hostId: "vps-b", enabled: true },
          { hostId: "vps-c", enabled: true },
        ],
        fetchImpl: (async (url: string | URL | Request) =>
          String(url).includes("vps-b")
            ? attentionResponse([{ qitemId: "b-1" }, { qitemId: "b-2" }])
            : attentionResponse([{ qitemId: "c-1" }])) as typeof fetch,
      }),
    );
    expect(res.items).toEqual([
      { qitemId: "local-1", hostId: LOCAL_HOST_ID },
      { qitemId: "b-1", hostId: "vps-b" },
      { qitemId: "b-2", hostId: "vps-b" },
      { qitemId: "c-1", hostId: "vps-c" },
    ]);
    expect(hostsCovered(res, [LOCAL_HOST_ID, "vps-b", "vps-c"])).toBe(true); // 架构固定点 B——位于契约层
  });

  it("一个主机不可达时降级为结构化状态；其他主机的条目仍会返回（绝非全有或全无）", async () => {
    const res = await aggregateAttention(
      deps({
        listSubscriptions: () => [
          { hostId: "vps-b", enabled: true },
          { hostId: "vps-c", enabled: true },
        ],
        fetchImpl: (async (url: string | URL | Request) => {
          if (String(url).includes("vps-b")) throw new Error("ECONNREFUSED");
          return attentionResponse([{ qitemId: "c-1" }]);
        }) as typeof fetch,
      }),
    );
    expect(res.hosts).toEqual([
      { hostId: LOCAL_HOST_ID, status: "ok" },
      { hostId: "vps-b", status: "unreachable", error: "ECONNREFUSED", failedStep: "remote-daemon-unreachable" },
      { hostId: "vps-c", status: "ok" },
    ]);
    expect(res.items.map((i) => i["qitemId"])).toEqual(["local-1", "c-1"]);
  });

  it("声明为 SSH 的主机 → unsupported-transport（R15-2）；未知主机 id 与注册表故障 → 逐主机 unreachable 并携带读取器错误", async () => {
    const res = await aggregateAttention(
      deps({
        listSubscriptions: () => [
          { hostId: "ssh-1", enabled: true },
          { hostId: "ghost", enabled: true },
        ],
        fetchImpl: (async () => attentionResponse([])) as typeof fetch,
      }),
    );
    expect(res.hosts[1]).toMatchObject({ hostId: "ssh-1", status: "unsupported-transport" });
    expect(res.hosts[1]!.error).toContain("http transport");
    expect(res.hosts[2]!.status).toBe("unreachable");
    expect(res.hosts[2]!.error).toContain("未知主机 ID 'ghost'");
    expect(hostsCovered(res, [LOCAL_HOST_ID, "ssh-1", "ghost"])).toBe(true);
  });

  it("认证失败归类为 auth-failed（缺少 bearer 以及远端 401），并附加携带 FailedStep 详情", async () => {
    const res = await aggregateAttention(
      deps({
        env: { C: "tc" }, // 缺少 B → vps-b 的 bearer 失败
        listSubscriptions: () => [
          { hostId: "vps-b", enabled: true },
          { hostId: "vps-c", enabled: true },
        ],
        fetchImpl: (async () => new Response("{}", { status: 401 })) as typeof fetch, // vps-c 到达线路 → 401
      }),
    );
    expect(res.hosts[1]).toMatchObject({ hostId: "vps-b", status: "auth-failed", failedStep: "permission-gate" });
    expect(res.hosts[1]!.error).toContain("bearer 环境变量 B");
    expect(res.hosts[2]).toMatchObject({ hostId: "vps-c", status: "auth-failed", failedStep: "permission-gate" });
  });

  it("停滞的远程读取会在 READ 截止时间内超时并报告 unreachable（遍历绝不挂起）", async () => {
    const res = await aggregateAttention(
      deps({
        listSubscriptions: () => [{ hostId: "vps-b", enabled: true }],
        timeoutMs: 20,
        fetchImpl: ((_u: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_r, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          })) as typeof fetch,
      }),
    );
    expect(res.hosts[1]).toMatchObject({ hostId: "vps-b", status: "unreachable", failedStep: "remote-daemon-unreachable" });
    expect(res.hosts[1]!.error).toContain("超时");
  });

  it("读取截止时间为 5 秒轮询上限，而非 up-leaf 预算", () => {
    expect(ATTENTION_READ_TIMEOUT_MS).toBe(5_000);
  });

  it("扇出上限：同时最多进行 `concurrency` 个远程读取；载荷中保留订阅顺序", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const res = await aggregateAttention(
      deps({
        listSubscriptions: () => [
          { hostId: "vps-b", enabled: true },
          { hostId: "vps-c", enabled: true },
        ],
        concurrency: 1,
        fetchImpl: (async (url: string | URL | Request) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
          return attentionResponse([{ qitemId: String(url).includes("vps-b") ? "b-1" : "c-1" }]);
        }) as typeof fetch,
      }),
    );
    expect(maxInFlight).toBe(1);
    expect(res.hosts.map((h) => h.hostId)).toEqual([LOCAL_HOST_ID, "vps-b", "vps-c"]);
    expect(res.items.map((i) => i["qitemId"])).toEqual(["local-1", "b-1", "c-1"]);
  });
});
