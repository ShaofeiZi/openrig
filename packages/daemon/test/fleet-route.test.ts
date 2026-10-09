// OPR.0.4.6.MH5 C2 — GET /api/review/fleet（同级聚合路由）。
//
// 扇出深度由 fleet-compose.test.ts 负责；本文件固定路由接线与载荷契约：gatherer
// 不可用时返回 503、注册表依赖注入（与 /api/queue/attention-aggregate 风格一致）、
// 注册表缺失 = 干净的仅本地 fleet、通过路由且无需网络逐主机如实呈现（ssh + 未设置
// bearer 的支路）、响应体不含 bearer 材料（根据 QA2 绑定检查，完整的浏览器绑定哨兵证明
// 位于 VM 支路 7），以及同级纯度零回归固定点（新增 fleet 后 /rig 和 /agents 字节不变）。

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { reviewRoutes } from "../src/routes/review.js";
import { LOCAL_HOST_ID } from "../src/domain/hosts/fanout-contract.js";
import type { PerHostStatusKind } from "../src/domain/hosts/fanout-contract.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";
import type { ComposedFleet, ComposedRigAgents, NeedsYouItem } from "../src/domain/review/types.js";

// 类型级固定点（§0.4）：PerHostStatusKind 保持为封闭的四值枚举。联合类型新增值会因缺少键
// 破坏此字面量；减少值会因多余键破坏它——MH-5 只聚合可达性轴，绝不扩展它。
const CLOSED_PER_HOST_KINDS: Record<PerHostStatusKind, true> = {
  ok: true,
  unreachable: true,
  "unsupported-transport": true,
  "auth-failed": true,
};

const NOW = "2026-07-08T14:00:00.000Z";

const LOCAL_ITEM: NeedsYouItem = {
  source: "agent",
  identity: "qi-local-1",
  summary: "需要签字确认",
  leg: "human-gate",
  where: "rig",
  ageIso: "2026-07-08T13:00:00.000Z",
  priority: "urgent",
  tier: "human-gate",
  evidenceRef: null,
  unblocks: null,
  qitemId: "qi-local-1",
  destinationSession: "human@host",
  derived: null,
};

const LOCAL_COMPOSED: ComposedRigAgents = {
  scope: "rig",
  needsYou: { items: [LOCAL_ITEM], provenance: "从 rig 读取根组合" },
  agents: {
    scope: "rig",
    rows: [
      { agentName: "lead", runtime: "claude-code", stateGlyph: "active", doing: null, holdsCount: 1, lastTransitionIso: null, exception: null, sessionName: "lead@acme-build", slices: [] },
    ],
    provenance: "seats",
    coordinationHealth: null,
  },
  settled: [],
  settledProvenance: "今日已关闭的 handover",
  composedAt: NOW,
};

function makeApp(opts: {
  withGatherer?: boolean;
  registry?: HostRegistry;
  registryExists?: boolean;
} = {}) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (key: string, value: unknown) => void;
    if (opts.withGatherer !== false) {
      set("reviewGatherer", { composeRig: () => LOCAL_COMPOSED });
    }
    set("hostRegistryExists", () => opts.registryExists ?? opts.registry !== undefined);
    if (opts.registry) set("hostRegistryLoader", () => ({ ok: true, registry: opts.registry }));
    await next();
  });
  app.route("/api/review", reviewRoutes());
  return app;
}

describe("GET /api/review/fleet——路由接线 + 载荷契约", () => {
  it("gatherer 不可用 → 返回该系列的 503 词汇", async () => {
    const app = makeApp({ withGatherer: false });
    const res = await app.request("/api/review/fleet");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "review_composer_unavailable" });
  });

  it("没有注册表 = 干净的仅本地 fleet（单主机操作者；无 registryError）", async () => {
    const app = makeApp({ registryExists: false });
    const res = await app.request("/api/review/fleet");
    expect(res.status).toBe(200);
    const fleet = (await res.json()) as ComposedFleet;
    expect(fleet.hosts).toHaveLength(1);
    expect(fleet.hosts[0]).toMatchObject({ hostId: LOCAL_HOST_ID, kind: "local", status: { hostId: LOCAL_HOST_ID, status: "ok" } });
    expect("registryError" in fleet).toBe(false);
    // 本地组合集合通过进程内 gatherer 流转（D-1）。
    expect(fleet.needsYou.items).toHaveLength(1);
    expect(fleet.needsYou.items[0]).toMatchObject({ fleetKey: `${LOCAL_HOST_ID}|qi-local-1`, hostId: LOCAL_HOST_ID, seenFrom: ["rig"] });
    expect(fleet.rollup).toEqual({ needsYouCount: 1, exceptionCount: 0, exceptionsByKind: [], hostCount: 1, unreachableCount: 0 });
  });

  it("声明为 ssh 的主机通过路由降级为 unsupported-transport（零网络）；其行中不存在计数", async () => {
    const app = makeApp({ registry: { hosts: [{ id: "vps-b", transport: "ssh", target: "b.local" }] } });
    const res = await app.request("/api/review/fleet");
    const fleet = (await res.json()) as ComposedFleet;
    expect(fleet.hosts.map((h) => [h.hostId, h.status.status])).toEqual([
      [LOCAL_HOST_ID, "ok"],
      ["vps-b", "unsupported-transport"],
    ]);
    const b = fleet.hosts[1]!;
    expect("needsYouCount" in b).toBe(false);
    expect("seatCount" in b).toBe(false);
    expect(fleet.rollup.unreachableCount).toBe(1);
    expect(fleet.needsYou.provenance).toContain("1/2 台主机完成组合");
  });

  it("http 主机的 bearer 环境变量未设置时 → auth-failed 并带环境变量名；正文不含 bearer/Authorization 材料", async () => {
    const app = makeApp({
      registry: { hosts: [{ id: "vps-a", transport: "http", url: "http://vps-a.invalid:7433", bearer_env: "MH5_ROUTE_TEST_BEARER_DELIBERATELY_UNSET" }] },
    });
    const res = await app.request("/api/review/fleet");
    const fleet = (await res.json()) as ComposedFleet;
    const a = fleet.hosts.find((h) => h.hostId === "vps-a")!;
    expect(a.status.status).toBe("auth-failed");
    expect(a.status.error).toContain("MH5_ROUTE_TEST_BEARER_DELIBERATELY_UNSET");
    // 响应体携带环境变量名称（操作者修复提示），绝不携带 header/token 材料。
    // 浏览器绑定的哨兵 grep 位于 VM 支路 7。
    const body = JSON.stringify(fleet);
    expect(body).not.toContain("Authorization");
    expect(body).not.toContain("Bearer ");
  });

  it("载荷携带完整的 ComposedFleet 契约成员", async () => {
    const app = makeApp({ registryExists: false });
    const fleet = (await (await app.request("/api/review/fleet")).json()) as ComposedFleet;
    for (const key of ["rollup", "needsYou", "hosts", "settled", "settledProvenance", "composedAt"]) {
      expect(Object.keys(fleet)).toContain(key);
    }
    expect(typeof fleet.composedAt).toBe("string");
  });
});

describe("同级纯度——现有端点系列不受 fleet 新增功能影响（零回归固定点）", () => {
  it("GET /rig 仍逐字返回 gatherer 的 composeRig()", async () => {
    const app = makeApp({ registryExists: false });
    const res = await app.request("/api/review/rig");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(LOCAL_COMPOSED)));
  });

  it("GET /agents scope 语法仍严格只有三个值（'fleet' scope 无效——架构 Q2）", async () => {
    const app = makeApp({ registryExists: false });
    const res = await app.request("/api/review/agents?scope=fleet");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toBe("scope_invalid");
    expect(body.hint).toContain("slice:<id> | mission:<id> | rig");
  });

  it("逐主机可达性枚举保持封闭（由上方编译时固定点保证）", () => {
    expect(Object.keys(CLOSED_PER_HOST_KINDS)).toHaveLength(4);
  });
});
