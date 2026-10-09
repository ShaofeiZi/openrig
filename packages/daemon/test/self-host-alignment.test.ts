// 51-09 increment 2——self-host 解析约定（本地环节）。
//
// daemon 生成的 self-host id（increment 1）必须与 "local" 位置 sentinel 一样解析为 HOME，但不对
// 它进行 overload：selfId 与 'local' 是两个不同但都接受的拼写，路由到同一位置。这是 queue
// destination validator（increment 4）所消费的约定，使以本 host 自身 id 限定的 destination 在本地
// 通过校验，而不是以 unknown_destination_rig 失败（E1 / 389ec01d 类）。
//
// 注意：这里没有实现 registry-alignment 的 boot 时断言（计划 increment 2 leg b）——见 driver report：
// hosts registry 没有可用于比较的 self-row 标记（已路由到 arch，按 fence 不做 registry migration）。

import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import {
  LOCAL_HOST_ID,
  getSelfHostId,
  setSelfHostId,
  resolvesToLocalHost,
} from "../src/domain/hosts/fanout-contract.js";
import { hostReadThrough } from "../src/domain/hosts/read-through.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

// vps-a 不使用 token（bearer 可选），因此远端环节无需环境提供 bearer 即可拨号——这里只需证明
// 非 self host 会转发。
const REGISTRY: HostRegistry = {
  hosts: [{ id: "vps-a", transport: "http", url: "http://vps-a:7433" }],
};

function makeApp() {
  const fetchCalls: string[] = [];
  const localHits: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    return new Response(JSON.stringify({ rigs: ["remote-rig"] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (key: string, value: unknown) => void;
    set("hostRegistryLoader", () => ({ ok: true, registry: REGISTRY }));
    set("remoteFetchImpl", fakeFetch);
    await next();
  });
  app.use("/api/*", hostReadThrough());
  app.get("/api/rigs/summary", (c) => { localHits.push(c.req.path); return c.json({ rigs: ["local-rig"] }); });
  return { app, fetchCalls, localHits };
}

afterEach(() => setSelfHostId(null)); // 在测试间重置 boot 填充的 module accessor。

describe("51-09 increment 2——self-host 本地解析", () => {
  it("resolvesToLocalHost：缺失、空、'local' sentinel 与 self-id 都路由到本机", () => {
    const selfId = "mars-01";
    expect(resolvesToLocalHost(undefined, selfId)).toBe(true);
    expect(resolvesToLocalHost("", selfId)).toBe(true);
    expect(resolvesToLocalHost(LOCAL_HOST_ID, selfId)).toBe(true); // 'local'。
    expect(resolvesToLocalHost(selfId, selfId)).toBe(true);        // self-id。
  });

  it("self-id 与 'local' sentinel 是不同拼写（未 overload）", () => {
    expect("mars-01").not.toBe(LOCAL_HOST_ID);
    // 二者都路由到本机，但 token 不同——selfId 不会变成 'local'。
    expect(resolvesToLocalHost("mars-01", "mars-01")).toBe(true);
    expect(resolvesToLocalHost(LOCAL_HOST_ID, "mars-01")).toBe(true);
  });

  it("其他 host 以及大小写不同的 self-id 不会路由到本机", () => {
    expect(resolvesToLocalHost("vps-a", "mars-01")).toBe(false);
    expect(resolvesToLocalHost("Mars-01", "mars-01")).toBe(false); // 区分大小写（与 incr-1 candidate-vs-stored 一致）。
  });

  it("尚未解析 self-id 时，只有缺失/空/'local' 表示本机（null self-id 不是 wildcard）", () => {
    expect(resolvesToLocalHost(undefined, null)).toBe(true);
    expect(resolvesToLocalHost(LOCAL_HOST_ID, null)).toBe(true);
    expect(resolvesToLocalHost("mars-01", null)).toBe(false);
  });

  it("getSelfHostId 往返返回 boot 设置的值", () => {
    expect(getSelfHostId()).toBeNull();
    setSelfHostId("mars-01");
    expect(getSelfHostId()).toBe("mars-01");
  });

  it("E1：read-through 将 ?host==selfId 的读取路由到本机（不远端拨号），与 ?host=local 相同", async () => {
    setSelfHostId("mars-01");
    const { app, fetchCalls, localHits } = makeApp();

    // self-id 限定读取 → 本地 handler，不拨号（读取接缝上的 E1 unknown_destination_rig 修复点）。
    const selfRes = await app.request("/api/rigs/summary?host=mars-01");
    expect(selfRes.status).toBe(200);
    expect(await selfRes.json()).toEqual({ rigs: ["local-rig"] });

    // 'local' sentinel → 同样为本地。
    await app.request("/api/rigs/summary?host=local");

    expect(localHits).toEqual(["/api/rigs/summary", "/api/rigs/summary"]);
    expect(fetchCalls).toEqual([]); // self-id 与 'local' 都未向外拨号。

    // 真正的远端 host 仍会转发（不变）。
    await app.request("/api/rigs/summary?host=vps-a");
    expect(fetchCalls.length).toBe(1);
  });
});
