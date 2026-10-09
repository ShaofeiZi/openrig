import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryQuery } from "../src/domain/history-query.js";

// searchSeat 是直接读取路径，因为 generation 标记需要位置信息；这里绝不调用 exec，
// 由会抛错的 stub 证明。
const throwExec = async () => {
  throw new Error("searchSeat must not shell out to rg/grep");
};

describe("HistoryQuery.searchSeat——席位作用域、跨 generation、真实降级", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rigask-seat-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeSeatLog(rig: string, seat: string, content: string): void {
    const dir = join(root, rig);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${seat}.log`), content, "utf-8");
  }

  it("返回横跨同一席位两个 generation 的命中，并标明 generation", async () => {
    const rig = "my-rig";
    const seat = "dev-planner@my-rig";
    writeSeatLog(
      rig,
      seat,
      [
        "gen1 discussed the deployment strategy",
        "unrelated chatter",
        "--- SESSION BOUNDARY: handover at 2026-08-06T00:00:00.000Z ---",
        "gen2 revisited the deployment plan",
      ].join("\n") + "\n",
    );
    // 不得搜索同一工作组目录中的其他席位（作用域约束）。
    writeSeatLog(rig, "review-r1@my-rig", "deployment noise in another seat\n");

    const hq = new HistoryQuery({ transcriptsRoot: root, exec: throwExec });
    const res = await hq.searchSeat(rig, seat, "deployment");

    expect(res.seat).toBe(seat);
    expect(res.generations).toBe(2);
    const gens = res.hits.map((h) => h.generation).sort();
    expect(gens).toContain(1); // boundary 前的命中。
    expect(gens).toContain(2); // boundary 后的命中；这正是跨 generation 的目的。
    // 作用域保证：不得泄漏其他席位日志的命中。
    expect(res.hits.some((h) => h.text.includes("another seat"))).toBe(false);
    expect(res.insufficient).toBe(false);
    expect(res.degraded).toBeUndefined();
  });

  it("真实降级为 boundary_only，绝不以静默零命中暗示席位从未发言", async () => {
    const rig = "my-rig";
    const seat = "dev-guard@my-rig";
    writeSeatLog(rig, seat, "--- SESSION BOUNDARY: launch at 2026-08-06T00:00:00.000Z ---\n\n");

    const hq = new HistoryQuery({ transcriptsRoot: root, exec: throwExec });
    const res = await hq.searchSeat(rig, seat, "deployment");

    expect(res.degraded).toBeDefined();
    expect(res.degraded?.reason).toBe("boundary_only");
    expect(res.degraded?.message).toContain("会话边界");
    expect(res.hits.length).toBe(0);
    expect(res.insufficient).toBe(true);
  });

  it("席位没有 transcript 文件时真实降级为 capture_missing", async () => {
    const hq = new HistoryQuery({ transcriptsRoot: root, exec: throwExec });
    const res = await hq.searchSeat("my-rig", "ghost@my-rig", "deployment");

    expect(res.degraded?.reason).toBe("capture_missing");
    expect(res.hits.length).toBe(0);
    expect(res.insufficient).toBe(true);
  });
});
