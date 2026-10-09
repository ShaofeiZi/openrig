// OPR.0.4.6.MH5——fleet composer 的正确性核心（计划 C5、C1 固定子集）：Q4 单次计数 Set
//（`hostId|identity`，唯一位置）、排列稳定 union、与 kind 无关的携带、WF-4 Q6 workflow-pointer
// 透传、按 host 的“缺失而非零”真实性，以及无时钟/无随机的纯度固定项。fan-out shell 向量镜像
// 已发布 attention-aggregator 的逐 host 结果纪律。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  composeFleet,
  unionFleet,
  FLEET_READ_TIMEOUT_MS,
} from "../src/domain/review/fleet-compose.js";
import type { FleetComposeDeps, FleetHostInput } from "../src/domain/review/fleet-compose.js";
import { LOCAL_HOST_ID } from "../src/domain/hosts/fanout-contract.js";
import type { PerHostStatus } from "../src/domain/hosts/fanout-contract.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";
import type { ComposedRigAgents, NeedsYouItem } from "../src/domain/review/types.js";

const NOW = "2026-07-08T14:00:00.000Z";

function item(overrides: Partial<NeedsYouItem> & { identity: string }): NeedsYouItem {
  return {
    source: "agent",
    summary: `summary ${overrides.identity}`,
    leg: "human-gate",
    where: "rig",
    ageIso: "2026-07-08T13:00:00.000Z",
    priority: null,
    tier: null,
    evidenceRef: null,
    unblocks: null,
    qitemId: overrides.identity,
    destinationSession: null,
    derived: null,
    ...overrides,
  };
}

function hostInput(hostId: string, overrides: Partial<FleetHostInput> = {}): FleetHostInput {
  return {
    hostId,
    kind: hostId === LOCAL_HOST_ID ? "local" : "remote",
    scopedNeedsYou: [],
    agents: [],
    settled: [],
    ...overrides,
  };
}

const OK = (hostId: string): PerHostStatus => ({ hostId, status: "ok" });

describe("unionFleet——Q4 单次计数 key（hostId|identity）", () => {
  it("同一 host 上来自 slice+mission+rig 的相同 identity 合并为一行并带三层 provenance", () => {
    const shared = item({ identity: "qi-1" });
    const fleet = unionFleet(
      [
        hostInput("vps-a", {
          scopedNeedsYou: [
            { scope: "slice", items: [shared] },
            { scope: "mission", items: [shared] },
            { scope: "rig", items: [shared] },
          ],
        }),
      ],
      [OK(LOCAL_HOST_ID), OK("vps-a")],
      NOW,
    );
    expect(fleet.needsYou.items).toHaveLength(1);
    expect(fleet.needsYou.items[0]!.fleetKey).toBe("vps-a|qi-1");
    expect(fleet.needsYou.items[0]!.seenFrom).toEqual(["slice", "mission", "rig"]);
    expect(fleet.rollup.needsYouCount).toBe(1);
  });

  it("相同 identity 字符串位于两个 host 时仍为两行（由 host 维度区分）", () => {
    const fleet = unionFleet(
      [
        hostInput("vps-a", { scopedNeedsYou: [{ scope: "rig", items: [item({ identity: "qi-same" })] }] }),
        hostInput("vps-b", { scopedNeedsYou: [{ scope: "rig", items: [item({ identity: "qi-same" })] }] }),
      ],
      [OK(LOCAL_HOST_ID), OK("vps-a"), OK("vps-b")],
      NOW,
    );
    expect(fleet.needsYou.items).toHaveLength(2);
    expect(fleet.needsYou.items.map((r) => r.fleetKey).sort()).toEqual(["vps-a|qi-same", "vps-b|qi-same"]);
  });

  it("MH-3 转发项：origin 拥有 record 意味着 id 只出现在一个 host 集合中，因此只有一条 fleet 行", () => {
    // 转发 qitem 只存在于其 ORIGIN host 的 DB 中（source 在 handoff 时关闭），fixture 镜像该构造。
    const fleet = unionFleet(
      [
        hostInput("vps-a", { scopedNeedsYou: [{ scope: "rig", items: [item({ identity: "qi-forwarded" })] }] }),
        hostInput("vps-b", { scopedNeedsYou: [{ scope: "rig", items: [] }] }),
      ],
      [OK(LOCAL_HOST_ID), OK("vps-a"), OK("vps-b")],
      NOW,
    );
    expect(fleet.needsYou.items).toHaveLength(1);
    expect(fleet.needsYou.items[0]!.fleetKey).toBe("vps-a|qi-forwarded");
  });
});

describe("unionFleet——排列稳定（输入顺序绝不改变行或计数）", () => {
  const inputs: FleetHostInput[] = [
    hostInput(LOCAL_HOST_ID, {
      scopedNeedsYou: [{ scope: "rig", items: [item({ identity: "qi-l1", priority: "urgent" })] }],
    }),
    hostInput("vps-a", {
      scopedNeedsYou: [
        { scope: "rig", items: [item({ identity: "qi-a1" }), item({ identity: "qi-a2", source: "derived", derived: { kind: "stuck", evidence: "idle 47m >= 30m", threshold: "stuck >= 30m idle" } })] },
        { scope: "slice", items: [item({ identity: "qi-a1" })] },
      ],
    }),
    hostInput("vps-b", {
      scopedNeedsYou: [{ scope: "rig", items: [item({ identity: "qi-b1", priority: "low" })] }],
    }),
  ];
  const statuses = [OK(LOCAL_HOST_ID), OK("vps-a"), OK("vps-b")];

  it("反转和轮转 host 输入（及 scoped-set 顺序）会产生逐字节相同的 payload", () => {
    const base = unionFleet(inputs, statuses, NOW);
    const reversed = unionFleet([...inputs].reverse(), statuses, NOW);
    const rotated = unionFleet([inputs[2]!, inputs[0]!, inputs[1]!], statuses, NOW);
    const scopedReversed = unionFleet(
      inputs.map((h) => ({ ...h, scopedNeedsYou: [...h.scopedNeedsYou].reverse() })),
      statuses,
      NOW,
    );
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(base));
    expect(JSON.stringify(rotated)).toBe(JSON.stringify(base));
    // 行集合和计数与顺序无关；seenFrom 以集合等价方式记录 scope（顺序可能反映读取顺序，因此排序后比较）。
    expect(scopedReversed.needsYou.items.map((r) => ({ ...r, seenFrom: [...r.seenFrom].sort() }))).toEqual(
      base.needsYou.items.map((r) => ({ ...r, seenFrom: [...r.seenFrom].sort() })),
    );
    expect(scopedReversed.rollup).toEqual(base.rollup);
  });

  it("相同输入执行两次产生逐字节相同 payload（纯函数，无时钟/随机）", () => {
    expect(JSON.stringify(unionFleet(inputs, statuses, NOW))).toBe(JSON.stringify(unionFleet(inputs, statuses, NOW)));
  });
});

describe("unionFleet——与 kind 无关的携带 + workflow 透传（D-2）", () => {
  it("合成的第 8 种 exception kind 原样流过（只 union，绝不筛选）", () => {
    const synthetic = item({
      identity: "qi-x|future-kind|2026-07-08",
      source: "derived",
      // 刻意位于当前封闭的 7-kind union 之外；fleet 层必须携带逐 host composer 产生的任何内容。
      derived: { kind: "future-kind" as never, evidence: "synthetic evidence", threshold: "synthetic threshold" },
    });
    const fleet = unionFleet(
      [hostInput("vps-a", { scopedNeedsYou: [{ scope: "rig", items: [synthetic] }] })],
      [OK(LOCAL_HOST_ID), OK("vps-a")],
      NOW,
    );
    expect(fleet.needsYou.items[0]!.derived).toEqual({ kind: "future-kind", evidence: "synthetic evidence", threshold: "synthetic threshold" });
    expect(fleet.rollup.exceptionsByKind).toEqual([{ kind: "future-kind", count: 1 }]);
  });

  it("row.workflow 只透传 pointer，缺失时省略（通过省略保持字节一致）", () => {
    const withPointer = item({
      identity: "qi-wf",
      workflow: { instanceId: "wfi-1", workflowName: "acme-factory", stepId: "assemble" },
    });
    const without = item({ identity: "qi-plain" });
    const fleet = unionFleet(
      [hostInput("vps-a", { scopedNeedsYou: [{ scope: "rig", items: [withPointer, without] }] })],
      [OK(LOCAL_HOST_ID), OK("vps-a")],
      NOW,
    );
    const wf = fleet.needsYou.items.find((r) => r.identity === "qi-wf")!;
    const plain = fleet.needsYou.items.find((r) => r.identity === "qi-plain")!;
    expect(wf.workflow).toEqual({ instanceId: "wfi-1", workflowName: "acme-factory", stepId: "assemble" });
    expect("workflow" in plain).toBe(false);
  });
});

describe("unionFleet——逐 host 真实性与 rollup 计算", () => {
  it("不可达 host 的 status 存在、counts 缺失而非零，rollup 如实反映", () => {
    const down: PerHostStatus = { hostId: "vps-b", status: "unreachable", error: "ECONNREFUSED", failedStep: "remote-daemon-unreachable" };
    const fleet = unionFleet(
      [hostInput("vps-a", { scopedNeedsYou: [{ scope: "rig", items: [item({ identity: "qi-a1" })] }] })],
      [OK(LOCAL_HOST_ID), OK("vps-a"), down],
      NOW,
    );
    const bRow = fleet.hosts.find((h) => h.hostId === "vps-b")!;
    expect(bRow.status).toEqual(down);
    expect("needsYouCount" in bRow).toBe(false);
    expect("exceptionsByKind" in bRow).toBe(false);
    expect("topLine" in bRow).toBe(false);
    expect(fleet.rollup.hostCount).toBe(3);
    expect(fleet.rollup.unreachableCount).toBe(1);
    expect(fleet.needsYou.provenance).toContain("2/3 台主机完成组合");
    expect(fleet.needsYou.provenance).toContain("缺失，而不是零");
  });

  it("header 计算源自去重后的行，并等于 HOSTS-band 逐 host 求和", () => {
    const fleet = unionFleet(
      [
        hostInput(LOCAL_HOST_ID, {
          scopedNeedsYou: [{ scope: "rig", items: [item({ identity: "qi-l1" })] }],
          agents: [
            { agentName: "lead", runtime: "claude-code", stateGlyph: "active", doing: null, holdsCount: 1, lastTransitionIso: null, exception: null, sessionName: "lead@acme-build", slices: [] },
            { agentName: "builder", runtime: "codex", stateGlyph: "idle", doing: null, holdsCount: 0, lastTransitionIso: null, exception: null, sessionName: "builder@acme-web", slices: [] },
          ],
        }),
        hostInput("vps-a", {
          scopedNeedsYou: [
            {
              scope: "rig",
              items: [
                item({ identity: "qi-a1" }),
                item({ identity: "qi-a2|stuck|t0", source: "derived", derived: { kind: "stuck", evidence: "idle 47m >= 30m", threshold: "stuck >= 30m idle" } }),
                item({ identity: "qi-a3|overdue|t0", source: "derived", derived: { kind: "overdue", evidence: "2d >= 24h window", threshold: "overdue >= 24h" } }),
              ],
            },
          ],
        }),
      ],
      [OK(LOCAL_HOST_ID), OK("vps-a")],
      NOW,
    );
    expect(fleet.rollup).toEqual({
      needsYouCount: 2,
      exceptionCount: 2,
      exceptionsByKind: [
        { kind: "overdue", count: 1 },
        { kind: "stuck", count: 1 },
      ],
      hostCount: 2,
      unreachableCount: 0,
    });
    const perHostNeedsYou = fleet.hosts.reduce((n, h) => n + (h.needsYouCount ?? 0), 0);
    const perHostExceptions = fleet.hosts.flatMap((h) => h.exceptionsByKind ?? []).reduce((n, k) => n + k.count, 0);
    expect(perHostNeedsYou).toBe(fleet.rollup.needsYouCount);
    expect(perHostExceptions).toBe(fleet.rollup.exceptionCount);
    // seat/rig 计数来自 host 自身 agents band（BR-1 grammar）。
    const localRow = fleet.hosts.find((h) => h.hostId === LOCAL_HOST_ID)!;
    expect(localRow.seatCount).toBe(2);
    expect(localRow.rigCount).toBe(2);
    // topLine 按最差优先且确定。
    const aRow = fleet.hosts.find((h) => h.hostId === "vps-a")!;
    expect(aRow.topLine).toBe("● summary qi-a1");
  });
});

describe("fleet-compose 纯度固定项——无时钟、无随机（arch/C5）", () => {
  it("fleet composer 源码不含 Date.now/new Date()/Math.random（只做 union，不派生时间状态）", () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/domain/review/fleet-compose.ts"),
      "utf-8",
    );
    expect(src).not.toMatch(/Date\.now\s*\(/);
    expect(src).not.toMatch(/new Date\s*\(/);
    expect(src).not.toMatch(/Math\.random\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// fan-out shell（镜像已发布 attention-aggregator 的纪律）。
// ---------------------------------------------------------------------------

const REGISTRY: HostRegistry = {
  hosts: [
    { id: "vps-a", transport: "http", url: "http://vps-a:7433", bearer_env: "A" },
    { id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "B" },
    { id: "ssh-1", transport: "ssh", target: "x.local" },
  ],
};

function composedRigResponse(items: NeedsYouItem[]): Response {
  const body: ComposedRigAgents = {
    scope: "rig",
    needsYou: { items, provenance: "composed from the rig read root" },
    agents: { scope: "rig", rows: [], provenance: "seats", coordinationHealth: null },
    settled: [],
    settledProvenance: "today's closed handoffs",
    composedAt: NOW,
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function localComposed(items: NeedsYouItem[]): ComposedRigAgents {
  return {
    scope: "rig",
    needsYou: { items, provenance: "composed from the rig read root" },
    agents: { scope: "rig", rows: [], provenance: "seats", coordinationHealth: null },
    settled: [],
    settledProvenance: "today's closed handoffs",
    composedAt: NOW,
  };
}

function fanoutDeps(overrides: Partial<FleetComposeDeps> = {}): FleetComposeDeps {
  return {
    composeLocalRig: () => localComposed([item({ identity: "qi-local-1" })]),
    loadRegistry: () => ({ ok: true, registry: REGISTRY }),
    registryExists: () => true,
    nowIso: NOW,
    env: { A: "ta", B: "tb" },
    ...overrides,
  };
}

describe("composeFleet——fan-out shell（D-1/D-7 + 逐 host 真实性）", () => {
  it("local 在进程内加入（零 self-transport），每个已注册 host 都扇出到 /api/review/rig", async () => {
    const urls: string[] = [];
    const fleet = await composeFleet(
      fanoutDeps({
        fetchImpl: (async (url: string | URL | Request) => {
          urls.push(String(url));
          return composedRigResponse([item({ identity: String(url).includes("vps-a") ? "qi-a1" : "qi-b1" })]);
        }) as typeof fetch,
      }),
    );
    expect(urls.some((u) => u.includes("vps-a") && u.endsWith("/api/review/rig"))).toBe(true);
    expect(urls.some((u) => u.includes("vps-b") && u.endsWith("/api/review/rig"))).toBe(true);
    // Local 与两个 http host 都有贡献；ssh host 只形成 status 行。
    expect(fleet.needsYou.items.map((r) => r.fleetKey).sort()).toEqual(["local|qi-local-1", "vps-a|qi-a1", "vps-b|qi-b1"]);
    expect(fleet.hosts.map((h) => [h.hostId, h.status.status])).toEqual([
      [LOCAL_HOST_ID, "ok"],
      ["vps-a", "ok"],
      ["vps-b", "ok"],
      ["ssh-1", "unsupported-transport"],
    ]);
    // v1 fan-out 的每一行都携带 rig-root provenance。
    for (const r of fleet.needsYou.items) expect(r.seenFrom).toEqual(["rig"]);
  });

  it("一个不可达 host 降级为结构化 status，其余仍可组合（绝不全成或全败）", async () => {
    const fleet = await composeFleet(
      fanoutDeps({
        fetchImpl: (async (url: string | URL | Request) => {
          if (String(url).includes("vps-a")) throw new Error("ECONNREFUSED");
          return composedRigResponse([item({ identity: "qi-b1" })]);
        }) as typeof fetch,
      }),
    );
    const aRow = fleet.hosts.find((h) => h.hostId === "vps-a")!;
    expect(aRow.status).toEqual({ hostId: "vps-a", status: "unreachable", error: "ECONNREFUSED", failedStep: "remote-daemon-unreachable" });
    expect("needsYouCount" in aRow).toBe(false);
    expect(fleet.needsYou.items.map((r) => r.fleetKey).sort()).toEqual(["local|qi-local-1", "vps-b|qi-b1"]);
    expect(fleet.rollup.unreachableCount).toBe(2); // vps-a down + ssh-1 unsupported
  });

  it("带格式错误组合 payload 的 200 响应真实降级（绝不静默生成空 ok 数据）", async () => {
    const fleet = await composeFleet(
      fanoutDeps({
        fetchImpl: (async (url: string | URL | Request) =>
          String(url).includes("vps-a")
            ? new Response(JSON.stringify({ nonsense: true }), { status: 200 })
            : composedRigResponse([])) as typeof fetch,
      }),
    );
    const aRow = fleet.hosts.find((h) => h.hostId === "vps-a")!;
    expect(aRow.status.status).toBe("unreachable");
    expect(aRow.status.error).toContain("格式错误");
  });

  it("HTTP 401/403 产生 auth-failed（操作员修复方式不同于 unreachable）", async () => {
    const fleet = await composeFleet(
      fanoutDeps({
        fetchImpl: (async (url: string | URL | Request) =>
          String(url).includes("vps-a")
            ? new Response("forbidden", { status: 403 })
            : composedRigResponse([])) as typeof fetch,
      }),
    );
    expect(fleet.hosts.find((h) => h.hostId === "vps-a")!.status.status).toBe("auth-failed");
  });

  it("没有 registry 文件时得到干净的仅本地 fleet（单 host 操作员；不读取 registry）", async () => {
    const fleet = await composeFleet(
      fanoutDeps({
        registryExists: () => false,
        loadRegistry: () => {
          throw new Error("registry must not be read when absent");
        },
      }),
    );
    expect(fleet.hosts).toHaveLength(1);
    expect(fleet.hosts[0]!.hostId).toBe(LOCAL_HOST_ID);
    expect("registryError" in fleet).toBe(false);
  });

  it("存在但加载失败的 registry 会被真实呈现（绝不静默变为仅本地 fleet）", async () => {
    const fleet = await composeFleet(
      fanoutDeps({
        loadRegistry: () => ({ ok: false, error: "failed to parse host registry YAML" }),
      }),
    );
    expect(fleet.registryError).toContain("failed to parse");
    expect(fleet.hosts).toHaveLength(1);
  });

  it("在普通五秒调用方 deadline 内预留响应时间", () => {
    expect(FLEET_READ_TIMEOUT_MS).toBe(5_000 - 1_000);
  });
});

describe("composeFleet——一个 elapsed budget，包含本地工作和 worker wave", () => {
  afterEach(() => vi.useRealTimers());

  function registry(count: number): HostRegistry {
    return { hosts: Array.from({ length: count }, (_, i) => ({ id: `h${i}`, transport: "http" as const, url: `http://h${i}.invalid` })) };
  }

  function timedDeps(localMs = 0, count = 9) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const started = performance.now();
    const starts: number[] = [];
    const aborts: number[] = [];
    const deps = fanoutDeps({
      timeoutMs: 100,
      loadRegistry: () => ({ ok: true, registry: registry(count) }),
      composeLocalRig: () => {
        vi.advanceTimersByTime(localMs);
        return localComposed([item({ identity: "qi-kept-local" })]);
      },
      fetchImpl: ((_url, init) => new Promise<Response>((_resolve, reject) => {
        starts.push(performance.now() - started);
        init!.signal!.addEventListener("abort", () => {
          aborts.push(performance.now() - started);
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      })) as typeof fetch,
    });
    return { deps, starts, aborts, started };
  }

  it.each([0, 60])("aborts the pending first wave and never grants later waves a fresh budget (local %ims)", async (localMs) => {
    const { deps, starts, aborts, started } = timedDeps(localMs);
    const pending = composeFleet(deps);
    await vi.runAllTimersAsync();
    const fleet = await pending;
    expect(performance.now() - started).toBeLessThanOrEqual(100);
    expect(starts).toEqual(Array(4).fill(localMs));
    expect(aborts).toEqual(Array(4).fill(100));
    expect(fleet.hosts.map(h => h.hostId)).toEqual(["local", ...registry(9).hosts.map(h => h.id)]);
    expect(fleet.needsYou.items.map(i => i.fleetKey)).toEqual(["local|qi-kept-local"]);
    expect(fleet.rollup).toMatchObject({ needsYouCount: 1, hostCount: 10, unreachableCount: 9 });
    for (const h of fleet.hosts.slice(1)) {
      expect(h.status.status).toBe("unreachable");
      expect(h.status.error).toContain("预算已耗尽");
      expect(h).not.toHaveProperty("seatCount");
    }
    for (const h of fleet.hosts.slice(5)) expect(h.status.error).toContain("未尝试");
  });

  it.each([100, 150])("local work consuming %ims leaves no further remote wait or request", async (localMs) => {
    const { deps, starts, started } = timedDeps(localMs);
    const pending = composeFleet(deps);
    await vi.runAllTimersAsync();
    const fleet = await pending;
    expect(performance.now() - started).toBe(localMs); // no claim of preempting synchronous work
    expect(starts).toEqual([]);
    expect(fleet.needsYou.items[0]!.fleetKey).toBe("local|qi-kept-local");
    expect(fleet.hosts.slice(1).every(h => h.status.error?.includes("未尝试"))).toBe(true);
  });

  it("保留多个 wave 的及时结果及其原始 host 顺序", async () => {
    const { deps } = timedDeps(10);
    deps.fetchImpl = ((url) => new Promise<Response>(resolve => {
      setTimeout(() => resolve(composedRigResponse([item({ identity: new URL(String(url)).hostname })])), 20);
    })) as typeof fetch;
    const pending = composeFleet(deps);
    await vi.runAllTimersAsync();
    const fleet = await pending;
    expect(fleet.hosts.map(h => h.hostId)).toEqual(["local", ...registry(9).hosts.map(h => h.id)]);
    expect(fleet.hosts.every(h => h.status.status === "ok")).toBe(true);
    expect(fleet.needsYou.items.map(i => i.fleetKey).sort()).toEqual([
      "local|qi-kept-local", ...registry(9).hosts.map(h => `${h.id}|${h.id}.invalid`),
    ].sort());
    expect(fleet.rollup).toMatchObject({ needsYouCount: 10, hostCount: 10, unreachableCount: 0 });
  });

  it("同级项耗尽 budget 时，仍保留已完成 remote 与本地数据", async () => {
    const { deps, aborts } = timedDeps(0, 2);
    const stalled = deps.fetchImpl!;
    deps.fetchImpl = ((url, init) => String(url).includes("h0.")
      ? Promise.resolve(composedRigResponse([item({ identity: "qi-timely" })]))
      : stalled(url, init)) as typeof fetch;
    const pending = composeFleet(deps);
    await vi.runAllTimersAsync();
    const fleet = await pending;
    expect(fleet.needsYou.items.map(i => i.fleetKey).sort()).toEqual(["h0|qi-timely", "local|qi-kept-local"]);
    expect(fleet.hosts.map(h => h.status.status)).toEqual(["ok", "ok", "unreachable"]);
    expect(aborts).toEqual([100]);
  });

  it("body 阻塞共享剩余 budget，中止其 transport，并点明已接收 header", async () => {
    const { deps, started } = timedDeps(60, 1);
    let signal: AbortSignal;
    deps.fetchImpl = (async (_url, init) => {
      signal = init!.signal!;
      return new Response(new ReadableStream(), { status: 200 });
    }) as typeof fetch;
    const pending = composeFleet(deps);
    await vi.runAllTimersAsync();
    const fleet = await pending;
    expect(performance.now() - started).toBe(100);
    expect(signal!.aborted).toBe(true);
    expect(fleet.hosts[1]!.status).toMatchObject({ status: "unreachable" });
    expect(fleet.hosts[1]!.status.error).toMatch(/预算已耗尽.*response header.*HTTP 200.*body/);
    expect(fleet.needsYou.items[0]!.fleetKey).toBe("local|qi-kept-local");
  });
});
