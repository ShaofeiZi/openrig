// OPR.0.4.4.15 S15-3 — GET /api/queue/attention-aggregate（FR-1 路由支路）。
//
// 零配置负例是这里的关键固定点（架构裁定 3）：聚合功能位于新的同级端点，现有
// /list?attention=1 线路保持逐字节不变——使用相同 repo 查询、相同裸数组，不含 hostId，
// 也不含 hosts[]。扇出深度由聚合器单元测试负责；本文件固定路由接线和载荷契约结构。

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { queueRoutes } from "../src/routes/queue.js";
import { LOCAL_HOST_ID } from "../src/domain/hosts/fanout-contract.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

const REGISTRY: HostRegistry = {
  hosts: [{ id: "vps-b", transport: "ssh", target: "b.local" }], // ssh → unsupported-transport，无需网络
};

const LOCAL_ATTENTION_ROW = { qitemId: "q-1", priority: "urgent", tier: "human-gate", destinationSession: "human-founder@external" };

function makeApp(opts: { subscriptions?: Array<{ hostId: string; enabled: boolean }>; withStore?: boolean } = {}) {
  const attentionCalls: unknown[] = [];
  const repo = {
    listAttention: (query: unknown) => {
      attentionCalls.push(query);
      return [LOCAL_ATTENTION_ROW];
    },
  };
  const store = {
    listFeedHostSubscriptions: () => opts.subscriptions ?? [],
  };
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (key: string, value: unknown) => void;
    set("queueRepo", repo);
    if (opts.withStore !== false) set("settingsStore", store);
    set("hostRegistryLoader", () => ({ ok: true, registry: REGISTRY }));
    await next();
  });
  app.route("/api/queue", queueRoutes());
  return { app, attentionCalls };
}

describe("GET /api/queue/attention-aggregate", () => {
  it("零配置：本地条目带标记并包含 [local ok] 主机行；使用与 /list 相同的 repo 查询和开放状态默认值", async () => {
    const { app, attentionCalls } = makeApp({ subscriptions: [] });
    const res = await app.request("/api/queue/attention-aggregate");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [{ ...LOCAL_ATTENTION_ROW, hostId: LOCAL_HOST_ID }],
      hosts: [{ hostId: LOCAL_HOST_ID, status: "ok" }],
    });
    expect(attentionCalls).toEqual([{ state: ["pending", "in-progress", "blocked"] }]);
  });

  it("缺少设置存储时降级为零配置（不抛错，仅返回本地载荷）", async () => {
    const { app } = makeApp({ withStore: false });
    const res = await app.request("/api/queue/attention-aggregate");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { hosts: unknown[] };
    expect(data.hosts).toEqual([{ hostId: LOCAL_HOST_ID, status: "ok" }]);
  });

  it("已订阅主机流经聚合器（ssh 条目 → 结构化 unsupported-transport，本地数据保持完整）", async () => {
    const { app } = makeApp({ subscriptions: [{ hostId: "vps-b", enabled: true }] });
    const res = await app.request("/api/queue/attention-aggregate");
    const data = (await res.json()) as { items: Array<Record<string, unknown>>; hosts: Array<Record<string, unknown>> };
    expect(data.items.map((i) => i["qitemId"])).toEqual(["q-1"]);
    expect(data.hosts).toHaveLength(2);
    expect(data.hosts[1]).toMatchObject({ hostId: "vps-b", status: "unsupported-transport" });
  });

  it("零配置线路一致性：/list?attention=1 保持裸数组——无 hostId、无 hosts[]（路由逐字节保持）", async () => {
    const { app } = makeApp({ subscriptions: [] });
    const res = await app.request("/api/queue/list?attention=1");
    expect(res.status).toBe(200);
    const data = (await res.json()) as unknown;
    expect(data).toEqual([LOCAL_ATTENTION_ROW]); // 与 repo 行完全一致，未包装、未添加标记
  });
});
