// 5b82324b——公开路径回归（HIGH-3）：默认 /api/rigs/:id/nodes 路由（`zrig ps` 调用的路径）
// 必须读取 structural cache，让没有 hook 的存活席位呈现真实 ACTIVITY，而不是 unknown；同时不得
// 为每次请求执行 tmux capture（healthz-wedge 不变量）。

import { describe, it, expect } from "vitest";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";

describe("5b——默认节点路由从 structural cache 读取 ACTIVITY（公开路径）", () => {
  it("无 hook 席位 + 缓存的 structural agent_active → 默认路由返回 ACTIVITY running，且不逐请求 capture", async () => {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const reg = new SessionRegistry(db);
    const rig = rigRepo.createRig("r");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });
    const sess = reg.registerSession(node.id, "dev-impl@r");
    reg.updateStatus(sess.id, "running");
    reg.updateBinding(node.id, { tmuxSession: "dev-impl@r", attachmentType: "tmux" });

    // 在 structural service 后接入可计数的 tmux capture；预先写入一次后台观测。
    let captures = 0;
    const structural = new SeatStructuralActivityService({
      capturePaneContent: async () => { captures++; return "⠋ Working… esc to interrupt"; },
    } as never);
    await structural.pollSeat("dev-impl@r"); // 后台路径只 capture 一次。
    const backgroundCaptures = captures; // 1
    expect(structural.getStructuralActivity("dev-impl@r")?.state).toBe("agent_active");

    // 未记录 runtime hook，说明该席位没有 hook；store 返回 null，fold 转而查询注入的
    // structural cache。
    const { app } = createTestApp(db, { seatStructuralActivityService: structural });

    const res = await app.request(`/api/rigs/${rig.id}/nodes`); // 默认不带 ?full，即 zrig ps 路径。
    expect(res.status).toBe(200);
    const nodes = (await res.json()) as Array<{ canonicalSessionName?: string; agentActivity?: { state: string; evidenceSource: string } }>;
    const seat = nodes.find((n) => n.canonicalSessionName === "dev-impl@r");
    expect(seat?.agentActivity?.state).toBe("running"); // 5b 之前为 unknown/no_runtime_hook。
    expect(seat?.agentActivity?.evidenceSource).toBe("pane_heuristic");
    // 零请求 capture 不变量：默认路由只读 cache，请求期间不执行 capture。
    expect(captures).toBe(backgroundCaptures);
    db.close();
  });
});
