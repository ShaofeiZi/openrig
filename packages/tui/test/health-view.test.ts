import { afterEach, describe, expect, it } from "vitest";
import { demoSnapshot } from "../src/demo-data.js";
import { parseCommand } from "../src/grammar.js";
import { healthDetailLines, healthListLines, healthSummaryLine } from "../src/health/health-model.js";
import { resolveEscapeAction } from "../src/input.js";
import { renderScreen } from "../src/render.js";
import { createViewState } from "../src/state.js";
import { stylizeLines } from "../src/stylize.js";
import { createStyle, stripAnsi } from "../src/theme.js";
import type { FleetSnapshot } from "../src/types.js";
import { dropW, strWidth } from "../src/text-width.js";

function record(input: {
  id: string;
  seatId: string;
  severity?: "info" | "warning" | "critical";
  status?: "active" | "cleared" | "indeterminate";
  freshness?: "fresh" | "stale" | "unavailable" | "contradictory";
  summary: string;
}) {
  return {
    schema: "openrig.health/v0alpha1",
    id: input.id,
    detector: "context.pressure",
    category: "context",
    scope: { type: "seat", rigId: "openrig-build", seatId: input.seatId },
    severity: input.severity ?? "warning",
    confidence: "high",
    status: input.status ?? "active",
    startedAt: "2026-09-05T11:30:00.000Z",
    lastObservedAt: "2026-09-05T11:59:00.000Z",
    window: { source: "context-usage", startedAt: "2026-09-04T12:00:00.000Z", endedAt: "2026-09-05T12:00:00.000Z", limit: 3, retentionSeconds: 86400 },
    freshness: { state: input.freshness ?? "fresh", evaluatedAt: "2026-09-05T12:00:00.000Z", newestSourceAt: "2026-09-05T11:59:00.000Z", maxAgeSeconds: 600, ageSeconds: 60 },
    summary: input.summary,
    evidence: [{ type: "context-usage", sourceOrder: 0, observedAt: "2026-09-05T11:59:00.000Z", nodeId: input.seatId, sessionId: "session-1", usedPercentage: 96, available: true, fresh: true }],
    threshold: "fresh context utilization >= 95% (critical at >= 99%)",
    explanation: "The latest source sample reports sustained context pressure.",
    suggestedInspection: "Inspect the seat's context source, recency, and continuity state.",
    indeterminateReason: input.status === "indeterminate" ? "source freshness is unavailable" : null,
  };
}

function healthSnapshot(): FleetSnapshot {
  const snap = demoSnapshot();
  const agents = snap.hosts[0]!.rigs[0]!.pods.flatMap((pod) => pod.agents);
  Object.assign(agents.find((agent) => agent.name === "dev50.guard")!, { nodeId: "node-guard" });
  Object.assign(agents.find((agent) => agent.name === "dev50.driver")!, { nodeId: "node-driver" });
  Object.assign(snap, {
    health: {
      availability: "loaded",
      evaluatedAt: "2026-09-05T12:00:00.000Z",
      total: 2,
      truncated: false,
      records: [
        record({ id: "health-critical", seatId: "node-guard", severity: "critical", summary: "Guard context pressure needs continuity action." }),
        record({ id: "health-warning", seatId: "node-driver", summary: "Driver context pressure is rising." }),
      ],
    },
  });
  return snap;
}

function open(snap: FleetSnapshot, command: string) {
  const view = createViewState({ instanceId: "health-test", getSnapshot: () => snap });
  view.dispatch(parseCommand(command));
  return view;
}

afterEach(() => {
  delete process.env["OPENRIG_REDUCED_MOTION"];
});

describe("fleet/system 健康 TUI", () => {
  it.each([129, 89, 58])("makes active severity, type counts, and indeterminate totals self-defining at content width %i", (width) => {
    const snap = healthSnapshot();
    snap.health!.records.push(record({
      id: "health-indeterminate",
      seatId: "node-driver",
      status: "indeterminate",
      summary: "Driver telemetry is contradictory.",
    }));
    const text = healthSummaryLine(
      snap,
      { kind: "rig", rigId: "openrig-build", rigName: "openrig-build", local: true },
      width,
    ).text;

    expect(text).toContain("活跃");
    expect(text).toMatch(/严重\s+1\s+警告\s+1/);
    expect(text).toMatch(/未知\s+1/);
    expect(text).toMatch(/按类型\s+context\s+2/i);
    expect(strWidth(text)).toBeLessThanOrEqual(width);
  });

  it.each([[160, 42], [120, 34], [84, 28]])("keeps a compact scoped TABLE signal and reachable HEALTH tab at %ix%i", (cols, rows) => {
    const snap = healthSnapshot();
    const view = open(snap, "host vm-host");
    const table = renderScreen(view.get(), snap, { cols, rows, colorMode: "none", nowMs: 0 });
    const text = table.lines.join("\n");
    expect(text).toContain("健康");
    expect(text).toMatch(/严重\s*1/);
    expect(text).toMatch(/警告\s*1/);
    expect(text).toMatch(/context\s*2/i);
    expect(table.contentTargets.some((target) => target.action.type === "tab" && target.action.tab === "health")).toBe(true);
    table.lines.forEach((line) => expect(strWidth(stripAnsi(line))).toBeLessThanOrEqual(cols));

    view.dispatch(parseCommand("tab health"));
    const health = renderScreen(view.get(), snap, { cols, rows, colorMode: "none", nowMs: 0 });
    expect(view.get().viewTab).toBe("health");
    expect(health.lines.join("\n")).toContain("Guard context pressure");
    expect(health.contentTargets.some((target) => target.action.type === "health-open" && target.action.findingId === "health-critical")).toBe(true);
    const header = health.lines.find((line) => line.includes("级别") && line.includes("信号")) ?? "";
    expect(header).toContain("范围");
    expect(header).toContain("年龄");
    if (cols >= 160) {
      expect(header).toContain("置信");
      expect(header).toContain("证据");
    } else {
      expect(header).not.toContain("置信");
      expect(header).not.toContain("证据");
    }
  });

  it("从 instance、rig、seat 路径复用同一 finding 记录，并打开 typed 证据详情", () => {
    const snap = healthSnapshot();
    for (const command of ["host vm-host", "rig openrig-build", "agent dev50.guard"]) {
      const view = open(snap, command);
      if (command !== "agent dev50.guard") view.dispatch(parseCommand("tab health"));
      let screen = renderScreen(view.get(), snap, { cols: 160, rows: 80, colorMode: "none" });
      const target = screen.contentTargets.find((candidate) => candidate.action.type === "health-open" && candidate.action.findingId === "health-critical");
      expect(target, command).toBeDefined();
      view.dispatch(target!.action);
      screen = renderScreen(view.get(), snap, { cols: 160, rows: 80, colorMode: "none" });
      const detail = screen.lines.join("\n");
      expect(detail).toContain("说明");
      expect(detail).toMatch(/发现 ID:\s+health-critical/i);
      expect(detail).toContain("fresh context utilization >= 95% (critical at >= 99%)");
      expect(detail).toContain("context-usage");
      expect(detail).toContain("node-guard");
      expect(resolveEscapeAction({ type: "key", key: "escape" }, view.get())).toEqual({ type: "health-close" });
    }
  });

  it("把无关 seat finding 排除在 agent 详情外", () => {
    const snap = healthSnapshot();
    const text = renderScreen(open(snap, "agent dev50.guard").get(), snap, { cols: 160, rows: 90, colorMode: "none" }).lines.join("\n");
    expect(text).toContain("Guard context pressure needs continuity action.");
    expect(text).not.toContain("Driver context pressure is rising.");
  });

  it("不把本地 canonical 记录投射到远程 instance 或不可 join 的 seat", () => {
    const snap = healthSnapshot();
    const remote = open(snap, "host remote-host");
    remote.dispatch(parseCommand("tab health"));
    expect(renderScreen(remote.get(), snap, { cols: 120, rows: 40, colorMode: "none" }).lines.join("\n")).toMatch(
      /不可用.*远程实例/i,
    );

    const guard = snap.hosts[0]!.rigs[0]!.pods.flatMap((pod) => pod.agents).find((agent) => agent.name === "dev50.guard")!;
    delete guard.nodeId;
    expect(renderScreen(open(snap, "agent dev50.guard").get(), snap, { cols: 160, rows: 80, colorMode: "none" }).lines.join("\n")).toMatch(
      /不可用.*稳定席位标识/i,
    );
  });

  it("把 empty、unavailable、stale、indeterminate 渲染为不同的非健康状态", () => {
    const cases = [
      [{ availability: "loaded", evaluatedAt: "2026-09-05T12:00:00.000Z", total: 0, truncated: false, records: [] }, /空.*非健康验证/i],
      [{ availability: "unavailable", evaluatedAt: null, total: 0, truncated: false, records: [] }, /不可用/i],
      [{ availability: "loaded", evaluatedAt: "2026-09-05T12:00:00.000Z", total: 1, truncated: false, records: [record({ id: "stale", seatId: "node-guard", freshness: "stale", summary: "Stale source." })] }, /过期/i],
      [{ availability: "loaded", evaluatedAt: "2026-09-05T12:00:00.000Z", total: 1, truncated: false, records: [record({ id: "indeterminate", seatId: "node-guard", status: "indeterminate", summary: "Unknown source." })] }, /未知/i],
    ] as const;
    for (const [health, expected] of cases) {
      const snap = healthSnapshot();
      Object.assign(snap, { health });
      const view = open(snap, "rig openrig-build");
      view.dispatch(parseCommand("tab health"));
      expect(renderScreen(view.get(), snap, { cols: 120, rows: 50, colorMode: "none" }).lines.join("\n")).toMatch(expected);
    }
  });

  it.each([[80, 24], [140, 42]])("keeps the complete empty-health explanation readable at %ix%i", (cols, rows) => {
    const snap = healthSnapshot();
    snap.health = { availability: "loaded", evaluatedAt: null, total: 0, truncated: false, records: [] };
    for (const command of ["host vm-host", "rig openrig-build"]) {
      const view = open(snap, command);
      view.dispatch(parseCommand("tab health"));
      const screen = renderScreen(view.get(), snap, { cols, rows, colorMode: "none" });
      const content = screen.lines.slice(2, -3).map(line => dropW(line, screen.explorerWidth + 1)).join(" " ).replace(/\s+/g, " " );
      expect(content).toContain("未服务发现；非健康验证");
      expect(screen.lines.every(line => strWidth(line) <= cols)).toBe(true);
      stylizeLines(screen, createStyle("truecolor")).forEach((line, index) => expect(stripAnsi(line)).toBe(screen.lines[index]));
    }
  });

  it.each([129, 89, 58])("retains severity beside stale and indeterminate truth at content width %i", (width) => {
    const snap = healthSnapshot();
    snap.health!.records = [
      record({ id: "stale-critical", seatId: "node-guard", severity: "critical", freshness: "stale", summary: "Stale signal." }),
      record({ id: "unknown-warning", seatId: "node-driver", severity: "warning", status: "indeterminate", freshness: "contradictory", summary: "Unknown signal." }),
    ];
    const lines = healthListLines(snap, { kind: "rig", rigId: "openrig-build", rigName: "openrig-build", local: true }, width);
    const findingLine = (findingId: string) => {
      return lines.find((line) => line.action?.type === "health-open" && line.action.findingId === findingId)?.text ?? "";
    };
    const stale = findingLine("stale-critical");
    const unknown = findingLine("unknown-warning");
    expect(stale).toContain("严重");
    expect(stale).toContain("过期");
    expect(unknown).toContain("警告");
    expect(unknown).toContain("未知");
  });

  it("彩色下保持纯几何，reduced motion 下完全冻结", () => {
    const snap = healthSnapshot();
    const view = open(snap, "rig openrig-build");
    view.dispatch(parseCommand("tab health"));
    const plain = renderScreen(view.get(), snap, { cols: 120, rows: 34, colorMode: "none", nowMs: 0 });
    const styled = stylizeLines(plain, createStyle("truecolor"));
    styled.forEach((line, index) => expect(stripAnsi(line)).toBe(plain.lines[index]));
    process.env["OPENRIG_REDUCED_MOTION"] = "1";
    expect(renderScreen(view.get(), snap, { cols: 120, rows: 34, nowMs: 0 }).lines).toEqual(
      renderScreen(view.get(), snap, { cols: 120, rows: 34, nowMs: 800 }).lines,
    );
  });
});

 it.each([58, 89, 129])("renders posture source and phase without removing operational findings at width %i", (width) => {
  const snap = healthSnapshot(), finding = snap.health!.records[0]!;
  finding.operatingPosture = { posture: "human-led", source: "product-default", context: { rigId: "openrig-build", phase: { value: "planning", source: "mission.yaml" }, sources: ["mission.yaml"] }, binding: null, reason: "Process-only interruptions are quiet; operational health remains visible.", grantsAuthority: false };
  const lines = healthDetailLines(snap, finding.id, width);
  const text = lines.map(l => l.text).join("\n");
  expect(text).toContain("human-led"); expect(text).toContain("product-default"); expect(text).toContain("planning");
  expect(text).toContain("context.pressure"); expect(snap.health!.records).toHaveLength(2);
  expect(lines.every(l => strWidth(stripAnsi(l.text)) <= width)).toBe(true);
});
