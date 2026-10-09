import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// WAVE O 修复 R1——B1（R2 裁决 508e383d）：生产交接构造必须接收守护进程唯一的
// SeatActivityService。服务级交换契约已固定（seat-handover-service.test.ts）；此测试
// 固定 R2 效果探针捕获的真实路由接缝：routes/seat.ts 构造服务时未传入 oracle，导致
// 真实托管交接在没有 declareOccupantSwap 的情况下提交，继任者可能继承退任者的证据与
// 已提升层级权限。

const constructed: Array<Record<string, unknown>> = [];
const handover = vi.fn(async () => ({ ok: true, seat: "x" }));

vi.mock("../src/domain/seat-handover-service.js", () => ({
  SeatHandoverService: class {
    constructor(deps: Record<string, unknown>) {
      constructed.push(deps);
    }
    handover = handover;
  },
}));

import { seatRoutes } from "../src/routes/seat.js";

function makeApp(sentinelOracle: object) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("rigRepo" as never, { db: {} } as never);
    c.set("sessionRegistry" as never, {} as never);
    c.set("discoveryRepo" as never, {} as never);
    c.set("eventBus" as never, {} as never);
    c.set("tmuxAdapter" as never, {} as never);
    c.set("seatActivityService" as never, sentinelOracle as never);
    await next();
  });
  app.route("/api/seat", seatRoutes);
  return app;
}

describe("Wave-O B1——生产交接构造注入唯一活动 oracle", () => {
  beforeEach(() => {
    constructed.length = 0;
    handover.mockClear();
  });

  it("POST /api/seat/handover/:seatRef 构造服务时，将上下文 seatActivityService 作为 activityOracle 传入", async () => {
    const sentinel = { declareOccupantSwap: vi.fn() };
    const app = makeApp(sentinel);
    const res = await app.request("/api/seat/handover/dev-impl%40seat-rig", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "context-wall", source: "fresh" }),
    });
    expect(res.status).toBe(200);
    expect(constructed).toHaveLength(1);
    // 保留 R2 判别器：候选实现在这里捕获了 `undefined`。
    expect(constructed[0]!.activityOracle).toBe(sentinel);
  });
});
