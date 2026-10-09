// 5b82324b——STRUCTURAL activity 缓存。证明结构分类（抓住动词 allowlist 漏掉的
// "Drizzling" 动名词），外加守卫要求的两条安全轴：
//   MF1——过期正向判定绝不逃过采集中断：null/throw 采集 INVALIDATE 前一行，
//         读 REFUSE 新鲜窗口之外的观测。
//   MF2——sweep 是 SINGLE-FLIGHT，持有到 settle：跨多个 tick 的 in-flight 采集在持有期
//         绝不超过一个 sweep（N seats），release 后恢复。

import { describe, it, expect } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";

function mkTmux(content: string | null, counter?: { captures: number }) {
  return {
    capturePaneContent: async () => {
      if (counter) counter.captures++;
      return content;
    },
  } as never;
}

describe("SeatStructuralActivityService——分类", () => {
  it("把工作中 spinner pane（含 'Drizzling' 动名词）分类为 agent_active 并缓存", async () => {
    const svc = new SeatStructuralActivityService(mkTmux("some output\n⠋ Drizzling… (esc to interrupt)"));
    expect((await svc.pollSeat("dev@rig"))?.state).toBe("agent_active"); // 结构标记，不是动词 allowlist
    expect(svc.getStructuralActivity("dev@rig")?.state).toBe("agent_active");
    expect(svc.getStructuralActivity("dev@rig")?.observedAt).toBeTruthy();
  });

  it("把空 idle prompt 分类为 agent_idle", async () => {
    const svc = new SeatStructuralActivityService(mkTmux("output above\n❯ "));
    expect((await svc.pollSeat("dev@rig"))?.state).toBe("agent_idle");
  });

  it("getStructuralActivity 不采集（读缓存，绝不重新采集）", async () => {
    const counter = { captures: 0 };
    const svc = new SeatStructuralActivityService(mkTmux("⠹ Working… esc to interrupt", counter));
    await svc.pollSeat("dev@rig");
    svc.getStructuralActivity("dev@rig");
    svc.getStructuralActivity("dev@rig");
    expect(counter.captures).toBe(1); // 读不采集——无 per-request 风暴
  });
});

describe("SeatStructuralActivityService——MF1：过期正向绝不逃过采集中断", () => {
  it("正向判定后 null 采集 INVALIDATE 该行（无 false-live）", async () => {
    let content: string | null = "⠋ Working… esc to interrupt";
    const svc = new SeatStructuralActivityService({ capturePaneContent: async () => content } as never);
    await svc.pollSeat("s@rig");
    expect(svc.getStructuralActivity("s@rig")?.state).toBe("agent_active");
    content = null; // 采集不可用
    await svc.pollSeat("s@rig");
    expect(svc.getStructuralActivity("s@rig")).toBeNull(); // 已失效，不是过期正向
  });

  it("正向判定后 THROW 采集失效该行", async () => {
    let mode = "ok";
    const svc = new SeatStructuralActivityService({
      capturePaneContent: async () => {
        if (mode === "throw") throw new Error("tmux gone");
        return "⠋ Working… esc to interrupt";
      },
    } as never);
    await svc.pollSeat("s@rig");
    expect(svc.getStructuralActivity("s@rig")?.state).toBe("agent_active");
    mode = "throw";
    await svc.pollSeat("s@rig");
    expect(svc.getStructuralActivity("s@rig")).toBeNull();
  });

  it("读 REFUSE + 逐出新鲜窗口外的观测（poller 无进展）", async () => {
    let t = Date.parse("2026-08-10T20:00:00.000Z");
    const svc = new SeatStructuralActivityService(
      { capturePaneContent: async () => "⠋ Working… esc to interrupt" } as never,
      () => new Date(t),
      20,
      5000, // staleAfterMs
    );
    await svc.pollSeat("s@rig");
    expect(svc.getStructuralActivity("s@rig")?.state).toBe("agent_active"); // 新鲜
    t += 5000; // 推进过窗口；未发生新采集
    expect(svc.getStructuralActivity("s@rig")).toBeNull(); // 拒绝 + 逐出
  });
});

describe("SeatStructuralActivityService——MF2：single-flight，持有到 settle", () => {
  function dbWith2RunningSeats() {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const reg = new SessionRegistry(db);
    const rig = rigRepo.createRig("r");
    for (const m of ["a", "b"]) {
      const node = rigRepo.addNode(rig.id, `dev.${m}`, { runtime: "claude-code" });
      const sess = reg.registerSession(node.id, `${m}@r`);
      reg.updateStatus(sess.id, "running");
      reg.updateBinding(node.id, { tmuxSession: `${m}@r`, attachmentType: "tmux" });
    }
    return db;
  }

  it("持有采集期间跨多 tick 的 in-flight 采集绝不超过一个 sweep（N）；release 后恢复", async () => {
    const db = dbWith2RunningSeats();
    const releasers: Array<() => void> = [];
    let started = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const tmux = {
      capturePaneContent: async () => {
        started++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((res) => releasers.push(res));
        inFlight--;
        return "❯ ";
      },
    } as never;
    const svc = new SeatStructuralActivityService(tmux);

    // 在 2 个采集被持有期间发 3 个 sweep。只有第一个启动采集；后两个
    // 撞上 single-flight 守卫并 no-op。
    const s1 = svc.pollAllRunningTmuxSeats(db);
    await new Promise((r) => setTimeout(r, 2)); // 让第一个 sweep 的采集启动
    const s2 = svc.pollAllRunningTmuxSeats(db);
    const s3 = svc.pollAllRunningTmuxSeats(db);
    await new Promise((r) => setTimeout(r, 2));
    expect(started).toBe(2); // 一个 sweep 的量
    expect(maxInFlight).toBe(2); // 绝不 4 或 6——无重叠 whole-fleet sweep

    // 释放被持有的采集 → 第一个 sweep settle；被跳过的 sweep 早已 resolve。
    releasers.splice(0).forEach((fn) => fn());
    await Promise.all([s1, s2, s3]);

    // 后续 tick 现在恢复（single-flight 在 settle 后释放）。
    const s4 = svc.pollAllRunningTmuxSeats(db);
    await new Promise((r) => setTimeout(r, 2));
    expect(started).toBe(4); // 恢复：又 2 个采集
    expect(maxInFlight).toBe(2); // 仍 bounded 到一个 sweep
    releasers.splice(0).forEach((fn) => fn());
    await s4;
    db.close();
  });
});
