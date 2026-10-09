import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import {
  CLAUDE_ACTIVITY_RUNG_INVENTORY,
  CODEX_ACTIVITY_RUNG_INVENTORY,
  TMUX_GENERIC_RUNG_INVENTORY,
  runtimeRungInventory,
} from "../src/domain/activity-taxonomy.js";
import { readClaudeSelfReportEvidence, type ClaudeSelfReportRead } from "../src/adapters/claude-code-adapter.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";

// OPR.0.5.5.19 A5——各 harness 的 rung inventory、Claude self-report rung（r3）及生产接线
//（sweep 自动声明、查询 self-report、静默降级）。CONTRACT 层（ladder rank、fall、admission）
// 已在 A3 中携带其监控 RED；此处固定 adapter 声明以及构建在其上的 reader/接线。

describe("S19 A5——各 harness 的 rung inventory（单一数据源）", () => {
  it("claude 配置全部四个 rung，覆盖完整生命周期且具权威性（常设 rung r1-r4）", () => {
    const rungs = new Map(CLAUDE_ACTIVITY_RUNG_INVENTORY.rungs.map((r) => [r.rung, r]));
    for (const rung of ["self-report", "lifecycle-hooks", "needs-input-chrome", "window-sampling"] as const) {
      expect(rungs.get(rung), rung).toBeDefined();
      expect(rungs.get(rung)!.lifecycleCoverage).toBe("full");
      expect(rungs.get(rung)!.initialTrust).toBe("authoritative");
    }
  });

  it("codex：hook 以 TRIAL 进入（AM-2），sampling 具权威性，且没有 self-report rung（无 pid.json 对应物，已实机验证）", () => {
    const rungs = new Map(CODEX_ACTIVITY_RUNG_INVENTORY.rungs.map((r) => [r.rung, r]));
    expect(rungs.get("lifecycle-hooks")!.initialTrust).toBe("trial");
    expect(rungs.get("window-sampling")!.initialTrust).toBe("authoritative");
    expect(rungs.has("self-report")).toBe(false); // rung 缺失时真实呈现，绝不伪造。
  });

  it("runtime 解析：claude/codex 映射到各自 inventory，其他类型使用通用下限", () => {
    expect(runtimeRungInventory("claude-code")).toBe(CLAUDE_ACTIVITY_RUNG_INVENTORY);
    expect(runtimeRungInventory("codex")).toBe(CODEX_ACTIVITY_RUNG_INVENTORY);
    expect(runtimeRungInventory("pi")).toBe(TMUX_GENERIC_RUNG_INVENTORY);
    expect(runtimeRungInventory(null)).toBe(TMUX_GENERIC_RUNG_INVENTORY);
  });
});

describe("S19 A5——readClaudeSelfReportEvidence：pid.json rung 与未文档化内部机制纪律", () => {
  const SEAT = "node-sr-1";
  const NAME = "dev50-qa@v-openrig-build";
  const record = (over: Record<string, unknown>) => JSON.stringify({
    pid: 123, name: NAME, status: "busy", statusUpdatedAt: 1_787_787_000_000, ...over,
  });
  const readOf = (files: Record<string, string>, throwOnList = false): ClaudeSelfReportRead => ({
    listFiles: () => { if (throwOnList) throw new Error("ENOENT"); return Object.keys(files); },
    readFile: (p) => { const f = p.split("/").pop()!; if (f in files) return files[f]!; throw new Error("ENOENT"); },
  });
  const input = (read: ClaudeSelfReportRead) => ({ sessionsDir: "/cfg/sessions", sessionName: NAME, seatNodeId: SEAT, read });

  it("busy 转为 working，并由 statusUpdatedAt 自身计时（证据携带自身时钟）", () => {
    const ev = readClaudeSelfReportEvidence(input(readOf({ "123.json": record({}) })))!;
    expect(ev.rung).toBe("self-report");
    expect(ev.activity).toBe("working");
    expect(ev.observedAt).toBe(new Date(1_787_787_000_000).toISOString());
    expect(ev.seq).toBe(1_787_787_000_000);
  });

  it("idle 和 shell 都转为 idle-at-prompt（轮次结束；后台 shell 不算工作轮次）", () => {
    expect(readClaudeSelfReportEvidence(input(readOf({ "1.json": record({ status: "idle" }) })))!.activity).toBe("idle-at-prompt");
    expect(readClaudeSelfReportEvidence(input(readOf({ "1.json": record({ status: "shell" }) })))!.activity).toBe("idle-at-prompt");
  });

  it("waiting 转为 needs-input count+reason（Claude 对话状态，不进入 activity 枚举）", () => {
    const ev = readClaudeSelfReportEvidence(input(readOf({ "1.json": record({ status: "waiting" }) })))!;
    expect(ev.activity).toBeUndefined();
    expect(ev.needsInput!.count).toBe(1);
  });

  it("按席位 canonical NAME 解析；其他席位文件不匹配；最新记录胜出", () => {
    const ev = readClaudeSelfReportEvidence(input(readOf({
      "1.json": record({ name: "someone-else@rig", status: "busy" }),
      "2.json": record({ status: "idle", statusUpdatedAt: 1_787_787_000_000 }),
      "3.json": record({ status: "busy", statusUpdatedAt: 1_787_787_999_000 }),
    })))!;
    expect(ev.activity).toBe("working"); // 3.json 比 2.json 新；1.json 属于其他席位。
  });

  it("目录不可读、文件格式错误、未知状态、结构错误时都返回 null，绝不抛错（沿 ladder 降级）", () => {
    expect(readClaudeSelfReportEvidence(input(readOf({}, true)))).toBeNull();
    expect(readClaudeSelfReportEvidence(input(readOf({ "1.json": "{not json" })))).toBeNull();
    expect(readClaudeSelfReportEvidence(input(readOf({ "1.json": record({ status: "levitating" }) })))).toBeNull();
    expect(readClaudeSelfReportEvidence(input(readOf({ "1.json": record({ statusUpdatedAt: "yesterday" }) })))).toBeNull();
  });
});

describe("S19 A5——生产接线：sweep 自动声明、查询 self-report 并静默降级", () => {
  const SEAT = "node-sw-1";
  const NAME = "dev50-qa@v-openrig-build";

  function harness(opts: { runtime: string; selfReport?: "busy" | "null" }) {
    const clock = { now: 5_000_000 };
    const svc = new SeatActivityService({
      tmux: { readPaneLastActivity: async () => clock.now / 1000 - 10 }, // 静默超过 3 秒窗口，sampling 判为 idle。
      defaultWindowSeconds: 3,
      now: () => new Date(clock.now),
      selfReportReader: (sessionName, seatNodeId) =>
        opts.selfReport === "busy"
          ? { seatNodeId, sessionName, rung: "self-report", sourceId: "claude:pid-json", seq: clock.now, observedAt: new Date(clock.now).toISOString(), activity: "working" }
          : null,
    });
    const db = { prepare: () => ({ all: () => [{ session_name: NAME, node_id: SEAT, runtime: opts.runtime }] }) } as unknown as Database.Database;
    return { svc, db, clock };
  }

  it("claude 席位自动声明，self-report rung 在与 sampling 冲突时作出裁决", async () => {
    const { svc, db } = harness({ runtime: "claude-code", selfReport: "busy" });
    await svc.pollAllRunningTmuxSeats(db);
    expect(svc.hasRungInventory(SEAT)).toBe(true);
    const s = svc.getSeatState(SEAT)!;
    expect(s.activity).toBe("working");
    expect(s.decidedBy).toBe("self-report"); // pid.json 高于 sampling（r3 高于 r1）。
  });

  it("reader 返回 null（文件不可读）时静默降级到 sampling，无错误并真实报告 idle", async () => {
    const { svc, db } = harness({ runtime: "claude-code", selfReport: "null" });
    await svc.pollAllRunningTmuxSeats(db);
    const s = svc.getSeatState(SEAT)!;
    expect(s.activity).toBe("idle-at-prompt");
    expect(s.decidedBy).toBe("window-sampling");
  });

  it("codex 席位不查询 self-report（inventory 中无该 rung），并显示真实 rung 集合", async () => {
    const { svc, db } = harness({ runtime: "codex", selfReport: "busy" });
    await svc.pollAllRunningTmuxSeats(db);
    const s = svc.getSeatState(SEAT)!;
    expect(s.decidedBy).toBe("window-sampling");
    expect(s.rungs.some((r) => r.rung === "self-report")).toBe(false); // 缺失，而非猜测。
    expect(s.rungs.find((r) => r.rung === "lifecycle-hooks")!.trust).toBe("trial");
  });
});
