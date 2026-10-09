import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { readMissionReadiness, readSliceReadiness, recordJudgment } from "../../daemon/src/domain/proof/judgments.js";
import { executionContentLines, type ExecutionViewSnap } from "../src/execution/execution-model.js";
import { demoSnapshot } from "../src/demo-data.js";
import { createViewState } from "../src/state.js";
import { renderScreen } from "../src/render.js";

it.each([[140, 42], [80, 24]])("native judgments drive outcomes, queue drives work, and first-screen boxes survive at %ix%i", (cols, rows) => {
  const root = mkdtempSync(join(tmpdir(), "ux-outcomes-"));
  const missions = join(root, "missions"), mission = join(missions, "trial");
  const write = (file: string, value: unknown) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, typeof value === "string" ? value : YAML.stringify(value)); };
  write(join(root, "project.yaml"), { kind: "project", metadata: { id: "trial" }, proofPolicy: { judges: ["judge@fixture"] }, missions: { root: "missions" } });
  write(join(mission, "mission.yaml"), { kind: "mission", metadata: { name: "trial", status: "active" }, composition: { slices: ["one", "two"].map((id, i) => ({ ref: `slices/${id}/slice.yaml`, order: i, active: true })) } });
  for (const id of ["one", "two"]) {
    write(join(mission, "slices", id, "slice.yaml"), { kind: "slice", metadata: { id }, execution: { depends_on: id === "two" ? ["one"] : [] } });
    write(join(mission, "slices", id, "SPEC.md"), `---\nid: ${id}\nstatus: done\n---\n# ${id}\n\n## Proof contract\n- [x] Verify ${id}.\n`);
    write(join(mission, "slices", id, "proof/evidence.md"), "Measured fixture evidence\n");
  }
  const original = readFileSync(join(mission, "mission.yaml"), "utf8");
  const snap = demoSnapshot();
  const template = snap.scopes![0]!.slices[0]!;
  snap.scopes = [{ mission: "trial", slices: ["one", "two"].map(id => ({ ...template, id, dirName: id, displayName: `Useful outcome ${id}`, status: "active", proof: { total: 1, paired: 1 } })) }];
  const execution: ExecutionViewSnap = { view: "execution", mission: "trial", sources: {}, q1_lanes: [], q2_sequencing: ["one", "two"].map(id => ({ slice_id: id, dir: id, depends_on: id === "two" ? ["one"] : [], work_rows: [], planned_owners: [{ component: "build.minimal-gap", owner: "planned@fixture", source: "slice.yaml#sdlc" }] })), q3_care: ["one", "two"].map(id => ({ slice_id: id, build_wave: "correction" })), q4_ladder: ["one", "two"].map(id => ({ slice_id: id, dir: id, folded: { value: true } })), q5_park: [], planning_guidance: [{ label: "Integration decision", text: "LONG PROCESS PROSE ".repeat(30), source: "mission.yaml" }] };
  const view = createViewState({ instanceId: "outcomes", getSnapshot: () => snap });
  view.dispatch({ type: "jump", section: "scopes" }); view.dispatch({ type: "scopes-mission-open", mission: "trial" });
  const body = () => {
    execution.readiness = readMissionReadiness(mission); snap.execution = execution;
    return executionContentLines(execution, snap.scopes, [], null, cols - 32).map(line => line.text).join("\n");
  };
  const judge = (id: string, verdict: "accept" | "withdraw") => {
    const item = readSliceReadiness(join(mission, "slices", id)).items[0]!;
    recordJudgment(missions, { scope: `trial/slices/${id}`, item: item.id, verdict, reason: "Fixture judgment", evidence: ["proof/evidence.md"], expectedRevision: item.revision, expectedPrevious: item.judgment?.id ?? null }, "judge@fixture", "transport:v1");
  };
  try {
    execution.q2_sequencing[0]!.next_up = true;
    expect(body()).toContain("结果开放"); expect(body()).toContain("计划: planned");
    expect(body()).toContain("下一个    one · 准备开始");
    expect(body()).not.toContain("trial · 结果完成"); // checked evidence + folded code do not accept an outcome
    execution.q1_lanes = [{ slice: "one", seat: "actual@fixture", qitem_id: "q1", activity: { activity: "working" } }];
    execution.q2_sequencing[0]!.work_rows = [{ qitem_id: "q1", seat: "actual@fixture", state: "in-progress", summary: "Build readable mission overview" }];
    expect(body()).toContain("归属: actual"); expect(body()).toContain("工作中");
    execution.q1_lanes[0]!.activity = { activity: "idle-at-prompt" };
    expect(body()).toContain("已分派"); expect(body()).not.toContain("1 工作中");
    execution.q2_sequencing[0]!.blocked_on_rows = [{ qitem_id: "q1", blocked_on: "review@fixture" }];
    expect(body()).toContain("已阻塞"); expect(body()).toContain("等待 review@fixture");
    execution.q1_lanes = []; execution.q2_sequencing[0]!.work_rows = []; execution.q2_sequencing[0]!.blocked_on_rows = [];
    expect(body()).not.toContain("trial · 结果完成"); // handoff alone is not outcome acceptance
    judge("one", "accept"); judge("two", "accept");
    expect(body()).toContain("trial · 结果完成"); expect(body()).toContain("active · 独立于结果");
    expect(body()).toContain("下一个    结果已完成；发布决策独立");
    expect(body()).toContain("进度      2/2 结果完成");
    judge("one", "withdraw"); expect(body()).toContain("结果开放"); expect(body()).toContain("已重开");
    execution.q2_sequencing[0]!.work_rows = [{ qitem_id: "reopened", seat: "actual@fixture", state: "in-progress", summary: "Correct reopened outcome" }];
    expect(body()).toContain("现在      one · actual · 已分派");
    expect(body()).toContain("下一个    等待当前工作；结果仍开放");
    expect(body()).toContain("进度      1/2 结果完成");
    expect(body()).toContain("结果开放");
    execution.q2_sequencing[0]!.blocked_on_rows = [{ qitem_id: "reopened", blocked_on: "review@fixture" }];
    expect(body()).toContain("现在      one · actual · 已阻塞");
    expect(body()).toContain("等待 review@fixture");
    expect(body()).toContain("下一个    等待当前工作；结果仍开放");
    execution.q2_sequencing[0]!.blocked_on_rows = [];
    const screen = renderScreen(view.get(), snap, { cols, rows });
    const text = screen.lines.join("\n");
    expect(text).toContain("┌"); expect(text).toContain("└"); expect(text).toContain("之后:");
    const prose = text.indexOf("LONG PROCESS PROSE");
    if (prose >= 0) expect(text.indexOf("└")).toBeLessThan(prose);
    expect(screen.contentTargets.some(t => t.action.type === "execution-open" && t.action.key === "slice:one")).toBe(true);
    expect(readFileSync(join(mission, "mission.yaml"), "utf8")).toBe(original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each(["empty", "unknown-assigned", "unknown-unassigned"])("does not infer complete outcomes from %s data", kind => {
  const empty = kind === "empty", assigned = kind === "unknown-assigned";
  const execution: ExecutionViewSnap = {
    view: "execution", mission: "trial", sources: {}, q1_lanes: [], q5_park: [],
    q2_sequencing: empty ? [] : [{ slice_id: "one", next_up: "INDETERMINATE", work_rows: assigned ? [{ seat: "actual@fixture", state: "in-progress" }] : [] }],
    q4_ladder: empty ? [] : [{ slice_id: "one" }],
  };
  const text = executionContentLines(execution, undefined, [], null, 120).map(line => line.text).join("\n");
  expect(text).toContain("结果开放");
  expect(text).toContain(`进度      0/${empty ? 0 : 1} 结果完成`);
  expect(text).toContain("生命周期  未知 · 独立于结果");
  expect(text).toContain(assigned ? "现在      one · actual · 已分派" : "现在      此读取中无开放切片工作");
  expect(text).toContain(empty ? "下一个    下一项资格未知" : assigned ? "下一个    等待当前工作；结果仍开放" : "下一个    one · 依赖资格未知");
  if (!empty) expect(text).toContain("1 证明未知");
});
