import { afterEach, describe, expect, it } from "vitest";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { createViewState } from "../src/state.js";
import { describeState } from "../src/socket-server.js";
import { demoSnapshot } from "../src/demo-data.js";
import { columnIndex, strWidth } from "../src/text-width.js";

function factory() {
  const snap = demoSnapshot();
  const driver = snap.hosts[0]!.rigs[0]!.pods[0]!.agents[0]!;
  driver.model = "fable-5.1";
  snap.blocked[0]!.tags = ["mission:release-0.5.9", "slice:OPR.0.5.9.11"];
  snap.blocked = snap.blocked.filter((row) => row.destinationSession !== "dev50-qa@openrig-build");
  snap.pending = snap.pending.filter((row) => row.destinationSession !== "dev50-qa@openrig-build");
  const view = createViewState({ instanceId: "production-composed", getSnapshot: () => snap });
  view.dispatch({ type: "drill", resource: "rig", name: "openrig-build" });
  return { snap, view };
}

afterEach(() => {
  delete process.env["OPENRIG_REDUCED_MOTION"];
});

describe("founder 批准的 G2/L2 生产组合", () => {
  it.each([
    [160, 32],
    [120, 30],
    [84, 24],
  ])("keeps the balanced Explorer at %i columns", (cols, expected) => {
    const { snap, view } = factory();
    const screen = renderScreen(view.get(), snap, { cols, rows: cols === 84 ? 28 : 42 });
    expect(screen.explorerWidth).toBe(expected);
    expect(screen.lines[1]![columnIndex(screen.lines[1]!, expected)]).toBe("╋");
    expect(screen.lines.slice(2, -3).some((line) => line[columnIndex(line, expected)] === "┃")).toBe(true);
  });

  it.each([160, 120])("keeps every approved factory fact separately scannable at %i columns", (cols) => {
    const { snap, view } = factory();
    const body = renderScreen(view.get(), snap, { cols, rows: 42, nowMs: 0 }).lines.join("\n");
    const header = body.split("\n").find((line) => /席位\s+席位\s+运行时\s+模型/.test(line));
    expect(header).toMatch(/上下文\s+状态\s+队列\s+工作\s+现在\s+动作/);
    expect(body).toContain("fable-5");
    expect(body).toMatch(/\sS11\s/);
    expect(body).toMatch(/已阻塞 · [^ ]/);
    expect(body).not.toMatch(/工作组\s+席位\s+席位/);
  });

  it("84 列下延后 MODEL、NOW、ACTIONS 并说明去向", () => {
    const { snap, view } = factory();
    const body = renderScreen(view.get(), snap, { cols: 84, rows: 28 }).lines.join("\n");
    const header = body.split("\n").find((line) => /席位\s+席位\s+运行时/.test(line))!;
    expect(header).toMatch(/上下文\s+状态\s+队列\s+工作/);
    expect(header).not.toMatch(/模型|现在|动作/);
    expect(body).toContain("模型/当前/动作 在钻取时");
    expect(body.split("\n").every((line) => strWidth(line) <= 84)).toBe(true);
  });

  it("NOW 仅从 typed 队列行派生，并以 2fps 动画可见工作标记", () => {
    const { snap, view } = factory();
    const at0 = renderScreen(view.get(), snap, { cols: 160, rows: 42, nowMs: 0 });
    const at500 = renderScreen(view.get(), snap, { cols: 160, rows: 42, nowMs: 500 });
    const driver0 = at0.lines.find((line) => line.includes("┃ dev50") && line.includes("driver"));
    const driver500 = at500.lines.find((line) => line.includes("┃ dev50") && line.includes("driver"));
    const noRow = at0.lines.find((line) => line.includes("┃") && /\? qa\s/.test(line));
    expect(driver0).not.toBe(driver500);
    expect(at0.motionActive).toBe(true);
    expect(noRow).toMatch(/\s—\s+—\s+运行 ▸/);

    process.env["OPENRIG_REDUCED_MOTION"] = "1";
    const reduced0 = renderScreen(view.get(), snap, { cols: 160, rows: 42, nowMs: 0 });
    const reduced500 = renderScreen(view.get(), snap, { cols: 160, rows: 42, nowMs: 500 });
    expect(reduced0.lines.find((line) => line.includes("┃ dev50") && line.includes("driver"))).toBe(
      reduced500.lines.find((line) => line.includes("┃ dev50") && line.includes("driver")),
    );
  });

  it("把 terminal 原生 select/copy 模式做成已注册、可见的视图状态", () => {
    expect(parseCommand("select-text")).toEqual({ type: "copy-mode" });
    const { snap, view } = factory();
    expect(view.dispatch(parseCommand("select-text")).copyMode).toBe(true);
    const screen = renderScreen(view.get(), snap, { cols: 120, rows: 34 });
    expect(screen.lines.join("\n")).toContain("拖动选择/复制");
    expect(view.dispatch(parseCommand("select-text")).copyMode).toBe(false);
  });

  it("把当前语义地址暴露为结构化 socket 状态", () => {
    const { view } = factory();
    view.dispatch({ type: "drill", resource: "agent", name: "dev50.driver" });
    const address = describeState(view.get()).address;
    expect(address).toMatchObject({
      instance: "production-composed",
      section: "topology",
      host: "vm-host",
      rig: "openrig-build",
      pod: "dev50",
      agent: "dev50.driver",
    });
    expect(address.path).toContain("agent:dev50.driver");
  });

  it.each([
    ["resource drill", "rig openrig-build", {
      instance: "production-composed",
      section: "topology",
      host: "vm-host",
      rig: "openrig-build",
      path: "instance:production-composed/section:topology/host:vm-host/rig:openrig-build",
    }],
    ["cross navigation", "spec-of dev50.driver", {
      instance: "production-composed",
      section: "specs",
      spec: "driver-agent",
      path: "instance:production-composed/section:specs/spec:driver-agent",
    }],
  ])("drops stale scope coordinates when %s leaves SCOPES", (_label, command, expected) => {
    const { view } = factory();
    view.dispatch({ type: "scopes-open", mission: "release-0.5.9", slice: "11-production-tui-composed-system" });
    view.dispatch(parseCommand(command));

    expect(describeState(view.get()).address).toEqual(expected);
  });
});
