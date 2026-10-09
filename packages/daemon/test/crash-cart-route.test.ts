// B1——crash-cart conductor 路由（异步 on-commit 结构）。路由在后台启动 fleet restore，并立即以
// fleet-attempt handle（202）响应；随着 rig 完成，客户端轮询 status endpoint 获取 rollup。以下测试
// 驱动真实路由：POST 返回 202 + id，随后 GET status 直至完成，并断言已发布 restore 组合出的
// kernel-first 顺序。（Conductor 逻辑在 crash-cart-conductor.test.ts 中进行单元测试。）
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { crashCartRoutes, __resetFleetAttempts } from "../src/routes/crash-cart.js";

beforeEach(() => __resetFleetAttempts());

function appWith(deps: { rigRepo: unknown; snapshotRepo: unknown; restoreOrchestrator: unknown; runtimeAdapters?: unknown; sessionRegistry?: unknown; tmuxAdapter?: unknown; claimService?: unknown }) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("rigRepo" as never, deps.rigRepo as never);
    c.set("snapshotRepo" as never, deps.snapshotRepo as never);
    c.set("restoreOrchestrator" as never, deps.restoreOrchestrator as never);
    if (deps.runtimeAdapters !== undefined) c.set("runtimeAdapters" as never, deps.runtimeAdapters as never);
    if (deps.sessionRegistry !== undefined) c.set("sessionRegistry" as never, deps.sessionRegistry as never);
    if (deps.tmuxAdapter !== undefined) c.set("tmuxAdapter" as never, deps.tmuxAdapter as never);
    if (deps.claimService !== undefined) c.set("claimService" as never, deps.claimService as never);
    await next();
  });
  app.route("/api/crash-cart", crashCartRoutes);
  return app;
}

type StatusBody = {
  done: boolean;
  cancelled: boolean;
  rollup: { sequence: Array<{ rigId: string; outcome: string }>; counts: Record<string, number>; attention_required: unknown[] };
  verdict: string;
};

// 启动异步动作并返回 fleet-attempt id（断言 on-commit 202）。
async function kickFleet(app: Hono): Promise<string> {
  const res = await app.request("/api/crash-cart/restore-fleet", { method: "POST" });
  expect(res.status).toBe(202);
  const body = (await res.json()) as { fleetAttemptId: string; status: string };
  expect(body.status).toBe("started");
  expect(body.fleetAttemptId).toMatch(/^fleet-/);
  return body.fleetAttemptId;
}

async function getStatus(app: Hono, id: string): Promise<StatusBody> {
  const res = await app.request(`/api/crash-cart/restore-fleet/${id}`, { method: "GET" });
  expect(res.status).toBe(200);
  return (await res.json()) as StatusBody;
}

// 轮询 status endpoint，直到后台 fleet restore 报告完成。
async function pollUntilDone(app: Hono, id: string): Promise<StatusBody> {
  for (let i = 0; i < 200; i++) {
    const body = await getStatus(app, id);
    if (body.done) return body;
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("fleet restore 始终未报告完成");
}

describe("POST /api/crash-cart/restore-fleet——异步 conductor 批处理动作", () => {
  it("以 kernel-first 顺序恢复每个 rig，轮询得到的 rollup 携带该顺序", async () => {
    const restored: string[] = [];
    const app = appWith({
      rigRepo: { listRigs: () => [
        { id: "r-alpha", name: "alpha" },
        { id: "r-kernel", name: "kernel" },
      ] },
      snapshotRepo: { findLatestRestoreUsable: (rigId: string) => ({ id: `snap-${rigId}` }) },
      restoreOrchestrator: {
        restore: vi.fn(async (snapshotId: string) => {
          restored.push(snapshotId);
          return { ok: true, result: { rigResult: "fully_restored" } };
        }),
      },
    });

    const id = await kickFleet(app);
    const body = await pollUntilDone(app, id);

    // 先恢复 kernel，再恢复 alpha。
    expect(restored).toEqual(["snap-r-kernel", "snap-r-alpha"]);
    expect(body.rollup.sequence.map((r) => r.rigId)).toEqual(["r-kernel", "r-alpha"]);
    expect(body.rollup.sequence.every((r) => r.outcome === "fully_restored")).toBe(true);
    expect(body.rollup.counts.fully_restored).toBe(2);
    expect(body.verdict).toBe("all_fully_restored");
  });

  it("无可用 snapshot 的 rig 为 not_attempted，fleet 仍继续", async () => {
    const app = appWith({
      rigRepo: { listRigs: () => [
        { id: "r-kernel", name: "kernel" },
        { id: "r-beta", name: "beta" },
      ] },
      // beta 没有可用 snapshot。
      snapshotRepo: { findLatestRestoreUsable: (rigId: string) => (rigId === "r-beta" ? null : { id: `snap-${rigId}` }) },
      restoreOrchestrator: { restore: async () => ({ ok: true, result: { rigResult: "fully_restored" } }) },
    });
    const id = await kickFleet(app);
    const body = await pollUntilDone(app, id);
    expect(body.rollup.sequence.find((r) => r.rigId === "r-kernel")!.outcome).toBe("fully_restored");
    expect(body.rollup.sequence.find((r) => r.rigId === "r-beta")!.outcome).toBe("not_attempted");
    expect(body.rollup.counts).toEqual({ fully_restored: 1, partially_restored: 0, failed: 0, not_attempted: 1 });
  });

  // r1 ROOT 判别项——路由必须 ON-COMMIT 响应，而非阻塞到 fleet 完成。真实 fleet restore 每个席位
  // 需要数秒；阻塞式 c.json 会超过客户端超时并丢弃 rollup。此处 restore 被 gate 保持打开：POST
  // 必须在 restore 仍 pending 时返回 202，status 显示未完成，证明响应未等待整个 fleet。
  it("on-commit 响应——POST 在缓慢 restore 仍进行时返回", async () => {
    let releaseRestore!: () => void;
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let restoreEntered = false;
    const app = appWith({
      rigRepo: { listRigs: () => [{ id: "r-kernel", name: "kernel" }] },
      snapshotRepo: { findLatestRestoreUsable: () => ({ id: "snap-k" }) },
      restoreOrchestrator: {
        restore: async () => {
          restoreEntered = true;
          await restoreGate; // block until the test releases — stands in for a slow seat restore
          return { ok: true, result: { rigResult: "fully_restored" } };
        },
      },
    });

    const id = await kickFleet(app); // 202 returned even though restore has NOT completed
    // 让后台 microtask 进入 restore，再观察其仍 pending。
    await new Promise((r) => setTimeout(r, 0));
    const mid = await getStatus(app, id);
    expect(restoreEntered).toBe(true);
    expect(mid.done).toBe(false); // the fleet is STILL running; the route did not block on it

    releaseRestore(); // now let the slow restore finish
    const done = await pollUntilDone(app, id);
    expect(done.rollup.counts.fully_restored).toBe(1);
    expect(done.verdict).toBe("all_fully_restored");
  });

  // R2-H1——路由层判别项：路由必须把 app 的 runtimeAdapters + fsOps 传入 restore()，否则已发布
  // orchestrator 会把感知 pod 的 resume 关闭失败为 awaiting-decision（席位无法回到自己的 pane）。
  // 在后台稳定后断言。
  it("R2-H1：把 app 的 runtimeAdapters + fsOps 传给 restore()", async () => {
    let receivedOpts: { adapters?: unknown; fsOps?: { exists?: unknown } } | undefined;
    const adapters = { codex: { runtime: "codex" } };
    const app = appWith({
      rigRepo: { listRigs: () => [{ id: "r-kernel", name: "kernel" }] },
      snapshotRepo: { findLatestRestoreUsable: () => ({ id: "snap-k" }) },
      runtimeAdapters: adapters,
      restoreOrchestrator: {
        restore: async (_id: string, opts: unknown) => {
          receivedOpts = opts as typeof receivedOpts;
          return { ok: true, result: { rigResult: "fully_restored" } };
        },
      },
    });
    const id = await kickFleet(app);
    await pollUntilDone(app, id);
    expect(receivedOpts?.adapters).toBe(adapters); // the app's adapters reach restore
    expect(typeof receivedOpts?.fsOps?.exists).toBe("function");
  });

  // H3——通过真实路由取消：在下一个 rig 前停止。kernel rig 仍在执行（被 gate）时取消，后续 rig
  // 为 not_attempted，status 反映 cancelled。
  it("H3：通过路由在 fleet 中途取消，后续 rig 为 not_attempted", async () => {
    const attempted: string[] = [];
    let releaseKernel!: () => void;
    const kernelGate = new Promise<void>((resolve) => {
      releaseKernel = resolve;
    });
    const app = appWith({
      rigRepo: { listRigs: () => [
        { id: "r-kernel", name: "kernel" },
        { id: "r-beta", name: "beta" },
      ] },
      snapshotRepo: { findLatestRestoreUsable: (rigId: string) => ({ id: `snap-${rigId}` }) },
      restoreOrchestrator: {
        restore: async (snapshotId: string) => {
          attempted.push(snapshotId);
          if (snapshotId === "snap-r-kernel") await kernelGate; // hold kernel in flight
          return { ok: true, result: { rigResult: "fully_restored" } };
        },
      },
    });

    const id = await kickFleet(app);
    await new Promise((r) => setTimeout(r, 0)); // kernel restore is now in flight
    // 在 kernel 仍恢复时取消。
    const cancelRes = await app.request(`/api/crash-cart/restore-fleet/${id}/cancel`, { method: "POST" });
    expect(cancelRes.status).toBe(200);
    expect((await cancelRes.json()) as { cancelled: boolean }).toEqual(expect.objectContaining({ cancelled: true }));

    releaseKernel(); // kernel (in-flight) completes; beta must NOT start
    const body = await pollUntilDone(app, id);
    expect(attempted).toEqual(["snap-r-kernel"]); // beta never restored
    expect(body.cancelled).toBe(true);
    expect(body.rollup.sequence.find((r) => r.rigId === "r-kernel")!.outcome).toBe("fully_restored");
    expect(body.rollup.sequence.find((r) => r.rigId === "r-beta")!.outcome).toBe("not_attempted");
  });

  // R6 / ARCH-RULING Q2——fleet verdict 在读取时从当前计数派生，绝不是 attempt 上的存储字段。
  // status verdict 必须等于其返回 rollup 计数的函数。
  it("从返回计数派生 verdict（而非存储第二份事实）", async () => {
    const app = appWith({
      rigRepo: { listRigs: () => [
        { id: "r-kernel", name: "kernel" },
        { id: "r-beta", name: "beta" },
      ] },
      snapshotRepo: { findLatestRestoreUsable: (rigId: string) => (rigId === "r-beta" ? null : { id: `snap-${rigId}` }) },
      restoreOrchestrator: { restore: async () => ({ ok: true, result: { rigResult: "fully_restored" } }) },
    });
    const id = await kickFleet(app);
    const body = await pollUntilDone(app, id);
    // 1 个 fully_restored + 1 个 not_attempted = mixed，且它恰好是 GET 返回计数的函数。
    const c = body.rollup.counts;
    const total = c.fully_restored + c.partially_restored + c.failed + c.not_attempted;
    const expected =
      total === 0 || c.not_attempted === total
        ? "none_attempted"
        : c.fully_restored === total
          ? "all_fully_restored"
          : c.failed === total
            ? "all_failed"
            : "mixed";
    expect(body.verdict).toBe(expected);
    expect(body.verdict).toBe("mixed");
  });

  // 修正案 2（stamped，72757e81）——路由形式的 ROUND-10 DOOR。仅后台服务崩溃：DB 显示 running，
  // pane 仍存活，restore() 会返回 409。通过真实路由时，rig 必须被接管（协调存活 session，并对其余
  // 执行 resume 验证），让刻意设计为不可恢复的席位进入 triage 且携带精确 --fresh 需求，并且绝不
  // 调用 restore()。这正是 round-10 fleet 读为 3-failed/8-not_attempted 的组合。
  it("修正案 2 入口：存活 pane 经已发布 reconcile + subset verify 被接管；不调用 restore；triage 携带精确 --fresh 需求", async () => {
    const reconciled: string[] = [];
    const subsetTargets: string[][] = [];
    let restoreCalled = false;
    const app = appWith({
      rigRepo: {
        listRigs: () => [{ id: "r-kernel", name: "kernel" }],
        getRig: () => ({
          rig: { name: "kernel" },
          nodes: [
            { id: "n1", logicalId: "dev.planner" },
            { id: "n2", logicalId: "dev.qa" },
          ],
        }),
      },
      snapshotRepo: { findLatestRestoreUsable: () => ({ id: "snap-k" }) },
      sessionRegistry: {
        getSessionsForRig: () => [
          { id: "s1", nodeId: "n1", sessionName: "dev-planner@kernel", status: "running" },
          { id: "s2", nodeId: "n2", sessionName: "dev-qa@kernel", status: "running" },
        ],
      },
      // dev.planner 的 pane 存活；dev.qa 的 pane 随崩溃死亡。
      tmuxAdapter: { hasSession: async (name: string) => name === "dev-planner@kernel" },
      claimService: {
        reconcileSession: async ({ sessionName }: { sessionName: string }) => {
          reconciled.push(sessionName);
          return { ok: true, result: { sessionName } };
        },
      },
      restoreOrchestrator: {
        restore: async () => { restoreCalled = true; return { ok: false, code: "rig_not_stopped" }; },
        launchNodeSubset: async (_rigId: string, ids: string[]) => {
          subsetTargets.push(ids);
          return {
            ok: true,
            launched: [{
              nodeId: "n2", logicalId: "dev.qa", status: "awaiting-decision",
              error: "Original session not resumable. Use --fresh dev.qa to fresh-prime, or skip.",
            }],
          };
        },
      },
    });

    const id = await kickFleet(app);
    const body = await pollUntilDone(app, id);

    expect(restoreCalled).toBe(false); // the 409 path is never entered on a live-panes rig
    expect(reconciled).toEqual(["dev-planner@kernel"]); // the surviving session is ADOPTED
    expect(subsetTargets).toEqual([["dev.qa"]]); // only the dead seat is resume-verified
    const kernel = body.rollup.sequence.find((r) => r.rigId === "r-kernel")!;
    expect(kernel.outcome).toBe("partially_restored");
    expect(body.rollup.attention_required).toEqual([
      { rigId: "r-kernel", seat: "dev.qa", need: "Original session not resumable. Use --fresh dev.qa to fresh-prime, or skip." },
    ]);
    expect(body.verdict).toBe("mixed"); // f(counts): a lone partially_restored rig derives mixed
  });

  it("未知 fleet-attempt id 的 status/cancel 返回 404", async () => {
    const app = appWith({
      rigRepo: { listRigs: () => [] },
      snapshotRepo: { findLatestRestoreUsable: () => null },
      restoreOrchestrator: { restore: async () => ({ ok: true }) },
    });
    expect((await app.request("/api/crash-cart/restore-fleet/nope", { method: "GET" })).status).toBe(404);
    expect((await app.request("/api/crash-cart/restore-fleet/nope/cancel", { method: "POST" })).status).toBe(404);
  });
});
