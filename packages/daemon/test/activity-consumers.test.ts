import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { attachTerminalActivityAndWork } from "../src/domain/node-inventory.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import type Database from "better-sqlite3";
import type { NodeInventoryEntry } from "../src/domain/types.js";

// OPR.0.5.5.19 A8 — 消费者基于分类体系渲染：丰富层提供经裁决的状态，display 已通过
// 唯一桥接预先派生；ps/TUI 消费所提供的值（grep 守卫追踪）——任何界面都不重新裁决。

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SEAT = "node-c1";
const SESSION = "dev50-qa@v-openrig-build";

function entryFor(session: string | null): NodeInventoryEntry {
  return {
    rigId: "r1", rigName: "rig", logicalId: "dev50.qa", podId: null, role: null,
    canonicalSessionName: session, nodeKind: "agent", runtime: "claude-code",
    sessionStatus: "running", startupStatus: "ready", restoreOutcome: null,
    oriented: null, lifecycleState: "running",
  } as unknown as NodeInventoryEntry;
}

function fakeDb(): Database.Database {
  return { prepare: () => ({ all: () => [] }) } as unknown as Database.Database;
}

describe("S19 A8——丰富层提供经裁决的分类状态", () => {
  it("activityState 携带 activity、桥接派生的 display、needs-input 和 decidedBy", () => {
    const clock = { now: 6_000_000 };
    const svc = new SeatActivityService({
      tmux: { readPaneLastActivity: async () => null },
      defaultWindowSeconds: 3,
      now: () => new Date(clock.now),
    });
    svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, {
      adapterId: "claude-code-adapter", runtime: "claude-code",
      rungs: [
        { rung: "lifecycle-hooks", lifecycleCoverage: "full", initialTrust: "authoritative" },
        { rung: "needs-input-chrome", lifecycleCoverage: "full", initialTrust: "authoritative" },
      ],
    });
    svc.reportEvidence({
      seatNodeId: SEAT, sessionName: SESSION, rung: "lifecycle-hooks", sourceId: "claude-code:hooks",
      seq: 1, observedAt: new Date(clock.now).toISOString(), activity: "working",
    });
    svc.reportEvidence({
      seatNodeId: SEAT, sessionName: SESSION, rung: "needs-input-chrome", sourceId: "tmux:chrome",
      seq: 2, observedAt: new Date(clock.now).toISOString(), needsInput: { count: 1, reason: "权限提示" },
    });
    const [enriched] = attachTerminalActivityAndWork([entryFor(SESSION)], { db: fakeDb(), seatActivity: svc });
    const tax = enriched!.activityState!;
    expect(tax.activity).toBe("working");
    expect(tax.display).toBe("needs-input"); // 唯一桥接：count>0 时渲染为 needs-input
    expect(tax.needsInput).toEqual({ count: 1, reason: "权限提示" });
    expect(tax.decidedBy).toBe("lifecycle-hooks");
  });

  it("seat 没有 oracle 状态时 activityState 为 null（如实呈现），绝不伪造", () => {
    const svc = new SeatActivityService({
      tmux: { readPaneLastActivity: async () => null },
      defaultWindowSeconds: 3,
    });
    const [enriched] = attachTerminalActivityAndWork([entryFor(SESSION)], { db: fakeDb(), seatActivity: svc });
    expect(enriched!.activityState).toBeNull();
  });

  it("完全没有服务时 activityState 保持 undefined（保留分类体系前的丰富结构，无需集中迁移）", () => {
    const [enriched] = attachTerminalActivityAndWork([entryFor(SESSION)], { db: fakeDb() });
    expect(enriched!.activityState).toBeUndefined();
    expect(enriched!.terminalActive).toBeUndefined(); // 旧字段的行为与此前完全一致
  });
});

describe("S19 A8——消费追踪：界面读取已提供的状态（不重新裁决）", () => {
  it("cli ps 渲染 activityState（分类体系优先，并注明旧版回退）", () => {
    const src = readFileSync(join(repoRoot, "packages", "cli", "src", "commands", "ps.ts"), "utf8");
    expect(src).toContain("activityState");
    expect(src).toMatch(/遗留回退/);
  });

  it("tui hydrate 优先使用已提供的 display，而非内联混合逻辑（后者仅作为回退保留）", () => {
    const src = readFileSync(join(repoRoot, "packages", "tui", "src", "hydrate.ts"), "utf8");
    expect(src).toContain("activityState");
    expect(src.indexOf("activityState?.display")).toBeGreaterThan(-1);
  });
});
